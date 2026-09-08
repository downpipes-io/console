// Pure display leaves for the audit log sub-view: the action grouping and label tables, the
// redaction-safe target renderer, and the small actor/outcome/method label helpers, plus the
// key-value detail line and the export download helper. Every server-supplied string reaches
// the DOM as a text node, and the target union is the closed, redaction-safe shape, so only
// safe fields can render. Split out of audit.ts to keep that file under the structural cap.

import { h } from "../../lib/dom.ts";
import { statusWithLabel, type StatusTone } from "../../components/status.ts";
import { titleCase } from "../../lib/format.ts";
import type { AuditEvent, AuditTarget, AuditAction, AuditActorMethod, AuditOutcome } from "../../api.ts";
import { ENGINE_STATE_FIELD_LABELS } from "./shared.ts";
import { recordContractSkew } from "../../lib/client-diag/ring.ts";

// The audit actions offered in the server-side filter, grouped for the select's optgroups so the internal
// event nouns do not land as one flat list. The URL parser shares the flattened list, so the two cannot drift.
//
// EVERY action the engine can write is offered. The filter is a server-side one (the engine's
// isAuditAction guard accepts any AUDIT_ACTIONS member and SILENTLY DROPS anything else), so an action absent
// from this list was simply unselectable: an operator whose backups stopped could not narrow 500 rows of
// routine traffic down to the engine-secret-absent event that says WHY. The completeness of AUDIT_ACTION_LABELS
// below is enforced by tsc; this list is checked against it by the access-security validator.
export const AUDIT_ACTION_GROUPS: Array<{ group: string; actions: AuditAction[] }> = [
  { group: "Restores", actions: ["restore-request", "restore-approve", "restore-reject", "restore-apply", "restore-verified"] },
  { group: "Downpipes and runs", actions: ["downpipe-create", "downpipe-delete", "downpipe-roster-reconcile", "run-trigger", "sources-attached", "sources-detached", "retention-prune", "retention-prune-request", "retention-prune-approve", "retention-prune-reject"] },
  { group: "Roles and access", actions: ["role-change", "group-role-change", "custom-role-change", "access-policy-change-intent", "posture-override-set", "posture-override-withdrawn"] },
  { group: "Identity and sign-in", actions: ["idp-connection-change", "idp-sign-in", "authn-failure", "recovery-codes-generated", "recovery-codes-staged", "recovery-code-used", "passkey-credential-revoke", "signin-factor-revoke", "session-terminate", "bootstrap-consumed", "break-glass-token-retired"] },
  { group: "Approvals and change control", actions: ["config-change-propose", "config-change-approve", "config-change-reject", "config-change-supersede", "config-policy-change", "owner-action-propose", "owner-action-approve", "owner-action-execute", "owner-action-reject", "change-recorded"] },
  { group: "Keys", actions: ["key-ceremony-intent", "keys-installed", "key-install-failed", "break-glass-rotated", "operational-added", "operational-removed", "key-removal-failed", "posture-acknowledged", "custody-share-emailed"] },
  { group: "Attested verification", actions: ["attest-session-started", "attest-session-proven", "attest-run-verified", "attest-session-aborted"] },
  { group: "Engine and destinations", actions: ["discovery-token-set", "discovery-token-cleared", "discovery-accounts-set", "discovery-sources-set", "engine-account-verified", "dest-config-set", "dest-config-cleared", "canary-config", "licence-activated", "licence-cleared", "expiry-cleanup-attested", "engine-secret-present", "engine-secret-absent", "engine-version-change"] },
  { group: "Engine updates", actions: ["update-promoted", "update-applied", "update-rolled-back", "update-refused"] },
  // Its own group rather than folded into "Engine and destinations": these rows only exist on a
  // a diagnostic-only estate, and the question they answer, "was a fault armed when this verdict was
  // banked", is one a reviewer narrows to deliberately rather than meets while reading routine traffic.
  { group: "Test faults (diagnostic estates only)", actions: ["test-fault-armed", "test-fault-disarmed", "test-fault-fired", "test-fault-control-plane-cleared"] },
  { group: "Control-plane recovery", actions: ["control-plane-exported", "control-plane-empty", "control-plane-reconciled", "control-plane-recovery-acknowledged", "control-plane-resumed"] },
  { group: "Support and egress", actions: ["support-credential-grant", "support-credential-revoke", "push-destination-set", "push-destination-cleared", "push-delivery-failure", "otlp-push-destination-set", "otlp-push-destination-cleared", "otlp-push-delivery-failure"] },
];

export const AUDIT_ACTION_OPTIONS: AuditAction[] = AUDIT_ACTION_GROUPS.flatMap((g) => g.actions);

// AUDIT_ACTION_LABELS gives every closed-union action a human label (the old hyphen-strip
// surfaced raw internal nouns like "dest config set"). A complete Record, so tsc refuses an
// unlabelled action; an action a NEWER engine writes still falls back to the hyphen-strip.
const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "restore-apply": "Restore applied (live write)",
  "restore-verified": "Restore receipt anchored",
  "restore-request": "Restore requested",
  "restore-approve": "Restore approved",
  "restore-reject": "Restore rejected",
  "retention-prune-request": "Retention prune requested",
  "retention-prune-approve": "Retention prune approved",
  "retention-prune-reject": "Retention prune rejected",
  "downpipe-create": "Downpipe created",
  "downpipe-delete": "Downpipe deleted",
  "downpipe-roster-reconcile": "Downpipe roster repaired",
  "run-trigger": "Run triggered manually",
  "sources-attached": "Sources attached",
  "sources-detached": "Sources detached",
  "idp-connection-change": "Identity provider changed",
  "idp-sign-in": "Signed in through identity provider",
  "authn-failure": "Sign-in attempt failed",
  "keys-installed": "Keys installed",
  "key-install-failed": "Key install FAILED",
  "break-glass-rotated": "Break-glass key rotated",
  "operational-added": "Operational key added",
  "operational-removed": "Operational keys removed",
  "key-removal-failed": "Key removal FAILED",
  "owner-action-propose": "Owner action proposed",
  "owner-action-approve": "Owner action approved",
  "owner-action-execute": "Owner action executed",
  "owner-action-reject": "Owner action rejected",
  "discovery-sources-set": "Source types chosen",
  "engine-account-verified": "Engine's own Cloudflare account identified",
  "licence-activated": "Licence activated",
  "licence-cleared": "Licence cleared",
  "update-promoted": "Engine update promoted (pending canary)",
  "update-applied": "Engine update kept",
  "update-rolled-back": "Engine update rolled back",
  "update-refused": "Engine update refused",
  "canary-config": "Canary backup reconfigured",
  "expiry-cleanup-attested": "Spent credential deletion attested",
  "control-plane-exported": "Control plane exported",
  "control-plane-empty": "Control plane found EMPTY",
  "control-plane-reconciled": "Control plane rebuilt from export",
  "control-plane-recovery-acknowledged": "Control plane recovery latch cleared without a rebuild",
  "control-plane-resumed": "Control plane auto-healed",
  "push-destination-set": "Audit push destination set",
  "push-destination-cleared": "Audit push destination cleared",
  "push-delivery-failure": "Audit push delivery failed",
  "otlp-push-destination-set": "Metrics push destination set",
  "otlp-push-destination-cleared": "Metrics push destination cleared",
  "otlp-push-delivery-failure": "Metrics push delivery failed",
  "posture-acknowledged": "Key posture acknowledged",
  "custody-share-emailed": "Custody share emailed",
  "attest-session-started": "Attested verification started",
  "attest-session-proven": "Attested verification proven",
  "attest-run-verified": "Run verified under attestation",
  "attest-session-aborted": "Attested verification aborted",
  "role-change": "Role granted or changed",
  "group-role-change": "Group mapping changed",
  "custom-role-change": "Custom role changed",
  "access-policy-change-intent": "Access policy change (intent)",
  "posture-override-set": "Security check override recorded",
  "posture-override-withdrawn": "Security check override withdrawn",
  "config-change-propose": "Config change proposed",
  "config-change-approve": "Config change approved",
  "config-change-reject": "Config change rejected",
  "config-change-supersede": "Config change superseded",
  "config-policy-change": "Approval requirement changed",
  "change-recorded": "Change recorded",
  "key-ceremony-intent": "Key ceremony (intent)",
  "bootstrap-consumed": "Bootstrap token consumed",
  "break-glass-token-retired": "Break-glass token retired",
  "recovery-codes-generated": "Recovery codes generated",
  "recovery-codes-staged": "Recovery codes staged, awaiting confirmation",
  "recovery-code-used": "Recovery code used",
  "session-terminate": "Sessions ended",
  "passkey-credential-revoke": "Passkey revoked",
  "signin-factor-revoke": "Sign-in revoked for a member",
  "support-credential-grant": "Support credential granted",
  "support-credential-revoke": "Support credential revoked",
  "discovery-token-set": "Discovery token set",
  "discovery-token-cleared": "Discovery token cleared",
  "discovery-accounts-set": "Discovery accounts chosen",
  "dest-config-set": "Archive destination set",
  "dest-config-cleared": "Archive destination cleared",
  "retention-prune": "Retention prune applied",
  "engine-secret-present": "Engine secret detected",
  // The secret-loss event. It is named LOUDLY because it is not an engine-state curiosity: a tracked secret
  // vanishing means the engine can no longer seal, no longer make an archive recoverable, or no longer write.
  // It is the row that answers "why did our backups stop, and when".
  "engine-secret-absent": "Engine secret MISSING (backups cannot run)",
  "engine-version-change": "Engine version changed",
  // The three fault events answer three different questions and the labels keep them apart. Armed says a
  // fault was LOADED and by whom; disarmed says it was cleared BEFORE firing, which is what makes a verdict
  // banked after it trustworthy; fired is the moment the hook actually changed engine behaviour, and it is
  // the one that puts every verdict in its window in doubt. A disarm that cleared nothing is never written,
  // so a disarmed row always means the fault really was still loaded.
  "test-fault-armed": "Test fault armed",
  "test-fault-disarmed": "Test fault cleared before it fired",
  "test-fault-fired": "Test fault FIRED (verdicts in its window are suspect)",
  "test-fault-control-plane-cleared": "Control-plane test fault cleared automatically",
};

export const AUDIT_OUTCOME_OPTIONS: AuditOutcome[] = ["success", "denied", "failed"];

export function kvLine(label: string, value: Node | string): HTMLElement {
  // A left-aligned label+value column (mirrors the shared .kv-row grid) so a long hash wraps
  // against the value column's left edge rather than being flung to a ragged right margin and
  // broken mid-string. The value's own mono/word-break treatment (set by the caller) is kept.
  const valueEl = h("span", { style: "text-align:left;overflow-wrap:anywhere;min-width:0" });
  if (typeof value === "string") valueEl.appendChild(document.createTextNode(value));
  else valueEl.appendChild(value);
  return h("div", { style: "display:grid;grid-template-columns:minmax(8rem,11rem) 1fr;gap:var(--space-2) var(--space-4);align-items:start" }, h("span", { class: "section-label" }, label), valueEl);
}

// describeTarget renders the closed, redaction-safe target union. The console can only
// ever render the safe fields the type allows (no key, value, secret or private
// fingerprint can appear). Every string is a text node (escaped by default).
export function describeTarget(t: AuditTarget): HTMLElement {
  switch (t.kind) {
    case "downpipe":
      return h("span", { class: "mono" }, t.name ? `${t.name} (${t.id})` : t.id);
    case "run":
      return h("span", { class: "mono" }, `run ${t.runId}`);
    case "prune-approval": {
      const parts = [`downpipe ${t.downpipeId}`, `${t.retainedRuns} retained`, `${t.supersededRuns} superseded`];
      const wrap = h("span", { class: "mono" }, parts.join(" "));
      if (t.approverEmail) wrap.appendChild(h("span", { class: "field__hint" }, ` approved by ${t.approverEmail}`));
      if (t.reasonClass) wrap.appendChild(h("span", { class: "field__hint" }, ` rejected: ${t.reasonClass}`));
      return wrap;
    }
    case "restore": {
      const parts = [`run ${t.runId}`];
      if (t.redirectBinding) parts.push(`→ ${t.redirectBinding}`);
      if (t.isLatest === false) parts.push("(non-latest)");
      const wrap = h("span", { class: "mono" }, parts.join(" "));
      if (t.approverEmail) wrap.appendChild(h("span", { class: "field__hint" }, ` approved by ${t.approverEmail}`));
      return wrap;
    }
    case "restore-receipt": {
      // The proof-of-correct-restore receipt. The receipt hash is the chain's commitment to the receipt's exact
      // content, so it is shown; the counts say what landed. A windowed apply that left records unrestored
      // (complete === false) and a failed verification are both called out, because "the restore succeeded" and
      // "the restore succeeded and every restored record re-hashed to its signed hash" are different claims.
      const parts = [`run ${t.runId}`, `${t.recordsRestored} records`];
      if (t.allVerified === false) parts.push("(NOT all verified)");
      if (t.complete === false) parts.push("(windowed: incomplete)");
      // Records the apply deliberately did not write, by the same rule as the two flags above: "restored
      // 98 records" and "restored 98 records, 2 still outstanding" are different claims, and this row is
      // where an auditor reads which one happened. Those records are in the archive and not in the
      // account, so a bare count that omits them reads as a complete restore.
      if (typeof t.recordsSkipped === "number" && t.recordsSkipped > 0) parts.push(`(${t.recordsSkipped} not written, still outstanding)`);
      const wrap = h("span", { class: "mono" }, parts.join(" "));
      wrap.appendChild(h("span", { class: "field__hint" }, ` receipt ${t.receiptSha384}`));
      return wrap;
    }
    case "role":
      return h("span", { class: "mono" }, `${t.email} → ${t.role}`);
    case "grouprole":
      return h("span", { class: "mono" }, `group ${t.group} → ${t.role}`);
    case "customrole": {
      const wrap = h("span", { class: "mono" }, t.capabilityCount > 0 ? `custom role ${t.name} (${t.capabilityCount} capabilities)` : `custom role ${t.name}`);
      // On a deletion, how many grants still named the role: the count of people floored to viewer at their
      // next request. It is the blast radius of the delete, and it is the only place an operator sees it.
      if (typeof t.affectedGrantCount === "number" && t.affectedGrantCount > 0) wrap.appendChild(h("span", { class: "field__hint" }, ` ${t.affectedGrantCount} grant(s) affected`));
      return wrap;
    }
    case "configchange": {
      const wrap = h("span", { class: "mono" }, `${t.changeKind} (${t.id})`);
      if (t.approverEmail) wrap.appendChild(h("span", { class: "field__hint" }, ` approved by ${t.approverEmail}`));
      return wrap;
    }
    case "owneraction": {
      const wrap = h("span", { class: "mono" }, `owner action ${t.actionKind} (${t.id})`);
      if (t.approverEmail) wrap.appendChild(h("span", { class: "field__hint" }, ` approved by ${t.approverEmail}`));
      return wrap;
    }
    case "change": {
      // A change-controlled action's change reference. An Emergency Change is rendered LOUDLY (it bypassed the
      // change-number requirement and needs retrospective-record validation); a normal change names its CR
      // number. The reason (emergency justification) is shown as a quiet hint. All fields are redaction-safe.
      if (t.emergency) {
        const wrap = h("span", { class: "mono" }, h("strong", { style: "color:var(--warn-fg)" }, "EMERGENCY CHANGE"), ` ${t.changeNumber ?? "(no change number)"} for ${t.actionKind}`);
        if (t.reason) wrap.appendChild(h("span", { class: "field__hint" }, ` ${t.reason}`));
        return wrap;
      }
      return h("span", { class: "mono" }, `change ${t.changeNumber ?? "(none)"} for ${t.actionKind}`);
    }
    case "key-ceremony": {
      // Field-less on the success rows (who and when is the whole evidence). On a FAILED ceremony the engine
      // names the step it died on and the closed cause, plus the bounded Cloudflare evidence: a 4xx with
      // Cloudflare's own numeric codes is a token-scope problem, a 5xx is a Cloudflare edge outage, and the
      // two lead to opposite remediations. A half-keyed engine is what this row is for.
      if (t.cause === undefined && t.step === undefined) return h("span", "key ceremony (intent)");
      const parts = ["key ceremony FAILED"];
      if (t.step) parts.push(`at ${t.step}`);
      if (t.cause) parts.push(`(${t.cause})`);
      const wrap = h("span", { class: "mono" }, parts.join(" "));
      const cf = [t.cfStatusClass, t.cfCodes && t.cfCodes.length > 0 ? `codes ${t.cfCodes.join(", ")}` : ""].filter((s) => !!s).join(" ");
      if (cf) wrap.appendChild(h("span", { class: "field__hint" }, ` Cloudflare ${cf}`));
      return wrap;
    }
    case "access-policy": {
      // Field-less on the intent rows. The optional fields are the ones an incident timeline turns on: WHICH
      // account policy moved and in WHICH direction (arming dual control and disarming it used to write
      // byte-identical events), which canary control was used, and whether the gated action ran via the bare
      // break-glass token, which is exempt from the dual-control auto-apply. Closed enums and a boolean.
      const parts: string[] = [];
      if (t.policyName) parts.push(`${t.policyName} ${t.newValue === true ? "ON" : t.newValue === false ? "OFF" : ""}`.trim());
      if (t.canaryOp) parts.push(`canary ${t.canaryOp}`);
      if (parts.length === 0 && t.gateBypass === undefined) return h("span", "Access policy change (intent)");
      const wrap = h("span", { class: "mono" }, parts.length > 0 ? parts.join(" ") : "Access policy change (intent)");
      if (t.gateBypass) wrap.appendChild(h("span", { class: "field__hint" }, " via break-glass token (dual control bypassed)"));
      return wrap;
    }
    case "posture-check":
      // The security-centre override target: the stable check id + the override kind. The owner's
      // reason deliberately never rides in the audit log (it lives on the record and in the reports).
      return h("span", { class: "mono" }, t.overrideKind !== null ? `${t.checkId} (${t.overrideKind})` : t.checkId);
    case "custody-share":
      // A Shamir share emailed to a custodian: the threshold and the total, counts only. Never a share value,
      // never a custodian address.
      return h("span", `custody share emailed (${t.m} of ${t.n})`);
    case "posture-ack":
      // The key-posture acknowledgement: the posture, the statement VERSION, the capture channel and the
      // resolved principal type. The statement hash rides in the raw target for verification; this summary
      // reads the safe labels only, never the acknowledged words.
      return h("span", `posture acknowledged (${t.posture}, ${t.statementVersion}, ${t.channel}, ${t.principalType})`);
    case "attest-session": {
      // An attended-verification session event: the opaque session id plus redaction-safe counts.
      const runs = t.runs !== undefined ? `, ${t.runs} run(s)` : "";
      const rate = t.sampleRate !== undefined ? `, ${t.sampleRate}% sample` : "";
      return h("span", h("span", { class: "mono" }, t.sessionId), `${runs}${rate}`);
    }
    case "dest-change": {
      // WHERE BACKUPS GO. The default-pointer move is rendered because clearing or removing the current
      // default silently PROMOTES the next remaining destination, which redirects every unassigned downpipe;
      // a FORCED removal names how many origin runs then held no other proven copy, and which downpipes lost
      // theirs. That is the data-loss magnitude of the change, and it belongs on the row.
      const parts = [`destination ${t.op}`];
      if (t.id) parts.push(t.id);
      if (t.fromDefaultId || t.toDefaultId) parts.push(`default ${t.fromDefaultId ?? "(none)"} → ${t.toDefaultId ?? "(none)"}`);
      if (t.rejectReason) parts.push(`refused: ${t.rejectReason}`);
      const wrap = h("span", { class: "mono" }, parts.join(" "));
      if (t.force) {
        const uncovered = typeof t.uncoveredOriginRunCount === "number" ? t.uncoveredOriginRunCount : 0;
        wrap.appendChild(h("span", { class: "field__hint" }, h("strong", { style: "color:var(--warn-fg)" }, " FORCED"), uncovered > 0 ? ` past the orphan guard: ${uncovered} run(s) left with no other proven copy` : " past the orphan guard"));
      }
      if (t.affectedDownpipeNames && t.affectedDownpipeNames.length > 0) wrap.appendChild(h("span", { class: "field__hint" }, ` affected: ${t.affectedDownpipeNames.join(", ")}`));
      return wrap;
    }
    case "supportcredential":
      return h("span", { class: "mono" }, t.clientId ? `support credential ${t.scope} (${t.clientId})` : `support credential ${t.scope}`);
    case "idpconnection":
      // The connection slug, its protocol and the operation (or a completed sign-in / a pre-save probe). The
      // WHO of a sign-in is the event's own actor columns; no secret, key, cert or assertion can ride here.
      return h("span", { class: "mono" }, `${t.op} ${t.connKind} connection ${t.connId}`);
    case "credential-cleanup":
      // The spent-credential registry item the operator attested they deleted in Cloudflare. tokenRef is the
      // PUBLIC Cloudflare token id descriptor when the engine captured one, never the token value.
      return h("span", { class: "mono" }, t.tokenRef ? `credential ${t.itemId} (${t.tokenRef})` : `credential ${t.itemId}`);
    case "push-destination": {
      // The audit/metrics egress destination. The endpoint and the auth header are unrepresentable here by
      // design; what rides is the op, a closed reject class, and the CONSECUTIVE failure count, which is the
      // one number that separates a blip from a destination that has been dark for weeks.
      const parts = [`push destination ${t.op}`];
      if (t.id) parts.push(t.id);
      if (t.rejectReason) parts.push(`refused: ${t.rejectReason}`);
      const wrap = h("span", { class: "mono" }, parts.join(" "));
      if (typeof t.failureCount === "number" && t.failureCount > 0) wrap.appendChild(h("span", { class: "field__hint" }, ` ${t.failureCount} consecutive failure(s)`));
      return wrap;
    }
    case "engine-state": {
      // Map internal field names to human-readable labels so the raw API field
      // names ("secret-present", "engineVersion") are never shown to users.
      // No label for this field means a NEWER engine is writing engine-state fields this console build
      // has no vocabulary for, so the operator is shown the raw internal name ("secret-present"). The FIELD
      // NAME itself never rides into the ring; the family says which forward-compat fallback fired, and it is
      // joined in the pack to consoleBuild + engine.version, which is what turns "unknown enum" into "deploy
      // console X".
      const label = ENGINE_STATE_FIELD_LABELS[t.field];
      if (label === undefined) recordContractSkew("unknown-enum-member", "audit-field-name");
      return h("span", { class: "mono" }, `${label ?? t.field}: ${t.detail}`);
    }
    case "test-fault": {
      // Mirrors the engine's own rendering (engine/src/admin/audit.ts:454), including that the armed instant
      // rides along on the two ops that carry it. mono, because faultKind and binding are internal engine
      // nouns rather than prose.
      const binding = t.binding ? ` on ${t.binding}` : "";
      const since = t.armedAt ? `, armed ${t.armedAt}` : "";
      return h("span", { class: "mono" }, `test fault ${t.op} ${t.faultKind}${binding}${since}`);
    }
    default: {
      // A NEWER engine can write a target kind this console build does not know. Render
      // the raw kind as a text node (no markup surface) rather than a blank cell, and
      // never throw in the detail modal.
      //
      // The console SAYS "newer engine?" on screen and has never been able to say it in the pack. This is
      // the loudest of the three skew fallbacks (a whole audit row the console cannot describe), and it is its
      // own family: an unknown TARGET is a different piece of engine vocabulary from an unknown METHOD or an
      // unlabelled FIELD, and folding them together would leave support unable to say WHAT the console is
      // behind on. The raw kind is rendered as a text node for the operator and NEVER recorded.
      const raw = (t as { kind?: unknown }).kind;
      recordContractSkew("unknown-enum-member", "audit-target");
      return h("span", { class: "mono field__hint" }, `unrecognised target (newer engine?): ${String(raw)}`);
    }
  }
}

export function outcomeStatus(outcome: AuditOutcome): HTMLElement {
  const tone: StatusTone = outcome === "success" ? "ok" : outcome === "denied" ? "warn" : "danger";
  return statusWithLabel(tone, titleCase(outcome));
}

// AUDIT_ACTOR_METHOD_LABELS labels EVERY member of the console's OWN closed AuditActorMethod union (a complete
// Record, so tsc refuses to let a member be added without a label). The completeness is the fix: the chain
// this replaced named access, passkey and token, and fell through to "engine-observed" for everything else, so a
// real oidc, saml or recovery actor was rendered in the Method column as THE ENGINE having done it. A human
// sign-in through the customer's IdP, and a break-glass recovery-code sign-in above all, were attributed on
// screen to the cron. Nothing was recorded, because nothing thought anything had gone wrong.
const AUDIT_ACTOR_METHOD_LABELS: Record<AuditActorMethod, string> = {
  access: "via Access",
  passkey: "via passkey",
  oidc: "via SSO (OIDC)",
  saml: "via SSO (SAML)",
  recovery: "via recovery code (break-glass)",
  token: "via shared token (break-glass)",
  engine: "engine-observed",
};

// actorMethodLabel is the ONE recorder of audit-method skew, and it is here rather than in actorIdentifier
// because it runs on EVERY rendered row (the table's Method line and the detail modal), while actorIdentifier
// runs only when the event carries no email. One recorder, one row per render.
//
// THE ROW NOW MEANS WHAT ITS VOCABULARY SAYS. A contract-skew row asserts that a NEWER ENGINE used a value this
// build does not know, and the old chain wrote it for `recovery` -- a member of this console's own union, which
// the engine has always been able to write and which a mistyped email on the public recovery form produces every
// time (scheduler-do-recovery.ts appends actorMethod "recovery" with a null actorEmail on the failed branch).
// Support was told to upgrade a console that is in lockstep with its engine, because somebody fat-fingered an
// email on the break-glass sign-in page. The test is now membership of the console's OWN union, which is the only
// state that can mean the engine is ahead of this build.
export function actorMethodLabel(method: AuditEvent["actorMethod"]): string {
  const label = AUDIT_ACTOR_METHOD_LABELS[method];
  if (label !== undefined) return label;
  recordContractSkew("unknown-enum-member", "audit-method");
  return "unrecognised method (newer engine?)";
}

// actorIdentifier is the short identifier shown for an audit actor when no email is recorded. The
// email is preferred (Access and passkey actors carry one); when it is absent the method names the
// actor, and it names EVERY method the console's own union holds, recovery included: the recovery
// route is public by design (it IS a sign-in path) and its FAILED attempts carry a null email, so
// this is the display an operator reads after a mistyped break-glass sign-in.
// A method this build does not know (a NEWER engine) reads "unknown method", never mislabelled as
// the token path. The SKEW ROW FOR IT IS WRITTEN BY actorMethodLabel, which runs on every rendered
// row: recording it here as well would file the same render twice.
export function actorIdentifier(e: AuditEvent): string {
  if (e.actorEmail) return e.actorEmail;
  const method = e.actorMethod;
  if (AUDIT_ACTOR_METHOD_LABELS[method] !== undefined) return method;
  return "unknown method";
}

export function actionLabel(action: AuditAction): string {
  // The fallback covers an action a NEWER engine writes that this build does not label yet.
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/-/g, " ");
}

export function downloadText(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
