// The audit mirror (console half).
//
// THE ROW MEANS WHAT ITS VOCABULARY SAYS, OR IT IS WORSE THAN NOTHING. describeTarget files
// contract-skew{unknown-enum-member, ...} whose meaning is "a NEWER engine is writing vocabulary this console
// build does not know", and that row rides into the support pack. The engine's secret-VANISHED event (target
// field "secret-absent") can fall out of the console's label table, and any target kind the current engine
// writes can be missing from the console's union altogether. Either one files a false skew row against an
// engine and a console that are actually in lockstep.
//
// The secret-VANISHED event is the one that says a deploy dropped SIGNER_PRIVATE, the break-glass key or the
// destination binding: it is WHY the backups stopped and WHEN. A false skew row there sends support to upgrade
// a console that is already current, while the real cause goes unexplained.
//
// THE SIBLING SITE IS THE WHOLE POINT, so this suite drives EVERY member of EVERY audit vocabulary the engine
// can write, through the REAL renderer (renderAuditEvents over the dom shim) and the REAL diagnostics ring, and
// asserts ZERO rows on all of them. Then it drives a genuinely NEWER engine and asserts the row still fires,
// because a forward-compat signal that never fires is not a fix either. The member lists come from the
// console's own shipped tables, and the audit-mirror drift gate (scripts/audit-mirror-drift-gate.mjs, which
// runs first in `npm run validate`) is what holds them equal to the engine's, member for member, both ways.
//
// Run with `node test/validate-audit-mirror.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { reset as resetRing, snapshot } from "../src/lib/client-diag/ring.ts";
import { EngineClient } from "../src/lib/api/client.ts";
import { renderAuditEvents } from "../src/screens/access-security/audit-events.ts";
import { AUDIT_ACTION_OPTIONS, actionLabel, describeTarget } from "../src/screens/access-security/audit-display.ts";
import { ENGINE_STATE_FIELD_LABELS } from "../src/screens/access-security/shared.ts";
import type { AuditAction, AuditEvent, AuditPage, AuditTarget } from "../src/api.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { engineRoots } from "./engine-path.ts";

const HERE = new URL(".", import.meta.url).pathname;

// ---------------------------------------------------------------------------------------------------------
// THE OTHER SIDE, read at run time. Every expectation about "what the engine can write" below comes from
// here, rather than from count literals, which go stale silently while staying green.
// ---------------------------------------------------------------------------------------------------------
const ENGINE_TYPES = "src/admin/audit-types.ts";

/** The text between two anchors, or null when either anchor has moved. Null is reported, never silently ignored. */
function between(src: string, startAnchor: string, endAnchor: string): string | null {
  const a = src.indexOf(startAnchor);
  const b = a === -1 ? -1 : src.indexOf(endAnchor, a + startAnchor.length);
  return a === -1 || b === -1 ? null : src.slice(a + startAnchor.length, b);
}

function readEngineVocab(): { actions: string[]; targetKinds: string[] } | null {
  const root = engineRoots(HERE).map((r) => resolve(r, ENGINE_TYPES)).find((p) => existsSync(p));
  if (root === undefined) return null;
  const src = readFileSync(root, "utf8");
  const actionBlock = between(src, "export const AUDIT_ACTIONS = [", "] as const;");
  const targetBlock = between(src, "export type AuditTarget =", "\n\n");
  if (actionBlock === null || targetBlock === null) {
    console.log(`  FAIL the engine's audit-types.ts anchors have moved, so nothing below is comparing anything (${root})`);
    // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
    // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
    // The exit code is unchanged.
    process.exitCode = 1;
    process.exit(1);
  }
  return {
    // The `?? ""` is not defensive padding: a capture group that MATCHED is a string under
    // noUncheckedIndexedAccess too, and the compiler cannot know that, so the coalesce is what makes the
    // declared string[] honest rather than an assertion. An empty string can never be produced here (both
    // patterns require at least one character), so it adds no member the comparison could be fooled by.
    actions: [...actionBlock.matchAll(/^\s*"([a-z0-9-]+)",/gm)].map((m) => m[1] ?? ""),
    targetKinds: [...new Set([...targetBlock.matchAll(/kind: "([a-z-]+)"/g)].map((m) => m[1] ?? ""))],
  };
}

const vocab = readEngineVocab();
if (vocab === null) {
  // CANNOT CHECK, not SKIP, and the wording is the point rather than taste. A console-only clone has no
  // engine and must still run its own tests, so the exit code stays 0 here; what the line says is that the
  // engine-derived half of this file answered nothing, which a reader of a green log has no other way to
  // learn. "SKIP" and a pass share an exit code and, in a chain of a hundred validators, share a silence.
  //
  console.log("CANNOT CHECK validate-audit-mirror: no engine checkout reachable, so the engine-derived comparisons did not run");
  if (process.env.REQUIRE_ENGINE === "1") {
    console.error("validate-audit-mirror: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable.\n" +
        "  Every expectation about what the engine can write is read from the engine's own audit-types.ts,\n" +
        "  so with no engine this file cannot answer its question and will not report that it did.\n" +
        "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.",); process.exit(2);
  }
}
// PARSE-SANITY FLOORS, not coverage floors. A regex that has stopped matching returns an empty list, and an
// empty list makes every "is it missing" comparison below vacuously true. These numbers are far under the
// real counts on purpose: they catch a broken parse, they do not stand in for the comparison.
const engineActions: string[] = vocab?.actions ?? [];
const engineTargetKinds: string[] = vocab?.targetKinds ?? [];
if (vocab !== null && (engineActions.length < 50 || engineTargetKinds.length < 15)) {
  console.log(`  FAIL parsed only ${engineActions.length} engine actions and ${engineTargetKinds.length} target kinds; the engine's source shape changed and this file is no longer reading it`);
  // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
  // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
  // The exit code is unchanged.
  process.exitCode = 1;
  process.exit(1);
}

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, actual: unknown, expected: unknown): void {
  ok(`${label} (got ${JSON.stringify(actual)})`, actual === expected);
}

const event = (action: AuditAction, target: AuditTarget, actorMethod = "engine"): AuditEvent =>
  ({
    seq: 1,
    ts: "2026-07-13T02:00:00.000Z",
    action,
    outcome: "success",
    actorEmail: null,
    actorMethod,
    sourceIp: null,
    target,
    prevHash: "sha384:0",
    hash: "sha384:1",
  }) as unknown as AuditEvent;

const page = (e: AuditEvent): AuditPage => ({ events: [e], nextCursor: null }) as unknown as AuditPage;

// THE REAL RENDERER, over the real DOM shim, into the real ring. Not the classifier: the entry point the
// operator's browser actually runs when the audit table paints.
function render(e: AuditEvent): ClientDiagnosticRecord[] {
  resetRing();
  renderAuditEvents(new EngineClient("https://engine.example"), page(e), {} as never, () => {});
  return snapshot().records.filter((r) => r.kind === "contract-skew");
}

// ---------------------------------------------------------------------------------------------------------
// THE KILL: the secret-VANISHED event, exactly as the engine appends it (src/admin/audit-status.ts:78-85).
// ---------------------------------------------------------------------------------------------------------
function secretVanished(): void {
  console.log("\nthe secret that VANISHED (the engine's secret-absent event):");

  const vanished = event("engine-secret-absent", { kind: "engine-state", field: "secret-absent", detail: "signerConfigured" });
  eq("a CURRENT engine's secret-VANISHED event records NOTHING", render(vanished).length, 0);
  eq("its twin, the secret-APPEARED event, still records nothing", render(event("engine-secret-present", { kind: "engine-state", field: "secret-present", detail: "signerConfigured" })).length, 0);
  eq("an engine-version-change records nothing", render(event("engine-version-change", { kind: "engine-state", field: "engineVersion", detail: "0.1.10" })).length, 0);

  // The operator must be able to READ the row, and to FILTER to it: an event nobody can select in a trail of
  // 500 routine rows is not evidence anyone will find.
  ok('the field is labelled, and the label is not the raw internal name', ENGINE_STATE_FIELD_LABELS["secret-absent"] !== undefined && !ENGINE_STATE_FIELD_LABELS["secret-absent"]!.includes("secret-absent"));
  ok("the label says the secret is MISSING, not merely that some engine state changed", (ENGINE_STATE_FIELD_LABELS["secret-absent"] ?? "").toLowerCase().includes("missing"));
  ok("the ACTION is labelled, not a hyphen-strip of the raw name", actionLabel("engine-secret-absent") !== "engine secret absent");
  ok("the audit filter can SELECT the event that explains the outage", (AUDIT_ACTION_OPTIONS as string[]).includes("engine-secret-absent"));
  ok("the rendered target names the presence-boolean, and shows no raw enum member", describeTarget({ kind: "engine-state", field: "secret-absent", detail: "signerConfigured" }).textContent?.includes("signerConfigured") === true);
}

// ---------------------------------------------------------------------------------------------------------
// THE SIBLING SITE IS THE WHOLE POINT. Any target kind the engine writes but the console does not know
// falls to describeTarget's default arm, which renders "unrecognised target (newer engine?)" AND records
// the skew row -- on the engine's most ordinary events: every IdP sign-in, every applied restore's receipt,
// every archive-destination change, every dual-control owner action, every push destination mutation, every
// spent-credential attestation.
// ---------------------------------------------------------------------------------------------------------
function everyTarget(): void {
  console.log("\nevery target kind the CURRENT engine can write:");

  const targets: Array<[string, AuditTarget, AuditAction]> = [
    ["downpipe", { kind: "downpipe", id: "dp-1", name: "prod" }, "downpipe-create"],
    ["run", { kind: "run", runId: "01RUN" }, "run-trigger"],
    ["restore", { kind: "restore", runId: "01RUN", redirectBinding: null, planHash: "sha384:p", isLatest: true }, "restore-apply"],
    ["restore-receipt", { kind: "restore-receipt", runId: "01RUN", receiptSha384: "sha384:r", recordsRestored: 120, allVerified: true }, "restore-verified"],
    ["role", { kind: "role", email: "a@acme.example", role: "owner" }, "role-change"],
    ["grouprole", { kind: "grouprole", group: "eng", role: "operator" }, "group-role-change"],
    ["customrole", { kind: "customrole", name: "auditor", capabilityCount: 0, affectedGrantCount: 4 }, "custom-role-change"],
    ["configchange", { kind: "configchange", id: "01CC", changeKind: "role-set" }, "config-change-propose"],
    ["owneraction", { kind: "owneraction", id: "01OA", actionKind: "dest-remove", approverEmail: "b@acme.example" }, "owner-action-approve"],
    ["change", { kind: "change", actionKind: "dest-remove", emergency: true, changeNumber: "CR-9", reason: "site down" }, "change-recorded"],
    ["key-ceremony", { kind: "key-ceremony", step: "SIGNER_PRIVATE", cause: "cf-put", cfStatusClass: "4xx", cfCodes: [10000] }, "key-install-failed"],
    ["access-policy", { kind: "access-policy", policyName: "config-approval", newValue: false, gateBypass: "break-glass" }, "config-policy-change"],
    ["posture-check", { kind: "posture-check", checkId: "worm-enabled", overrideKind: "risk-accepted" }, "posture-override-set"],
    ["dest-change", { kind: "dest-change", op: "remove", id: "d2", fromDefaultId: "d2", toDefaultId: "d1", force: true, uncoveredOriginRunCount: 12, affectedDownpipeNames: ["prod-kv"] }, "dest-config-cleared"],
    ["supportcredential", { kind: "supportcredential", scope: "metrics", clientId: "cid-1" }, "support-credential-grant"],
    ["idpconnection", { kind: "idpconnection", connId: "okta-1", connKind: "saml", op: "signin" }, "idp-sign-in"],
    ["credential-cleanup", { kind: "credential-cleanup", itemId: "it-1", tokenRef: "tok-desc" }, "expiry-cleanup-attested"],
    ["push-destination", { kind: "push-destination", op: "delivery-failure", failureCount: 41 }, "push-delivery-failure"],
    ["engine-state", { kind: "engine-state", field: "secret-absent", detail: "destConfigured" }, "engine-secret-absent"],
    ["prune-approval", { kind: "prune-approval", downpipeId: "dp-1", planHash: "sha384:p", retainedRuns: 30, supersededRuns: 4 }, "retention-prune-approve"],
    ["custody-share", { kind: "custody-share", n: 3, m: 5 }, "custody-share-emailed"],
    ["posture-ack", { kind: "posture-ack", posture: "break-glass-only", statementVersion: "1", statementSha384: "sha384:s", channel: "onboarding", principalType: "owner-passkey" }, "posture-acknowledged"],
    ["attest-session", { kind: "attest-session", sessionId: "01AS", runs: 4, sampleRate: 0.25 }, "attest-session-proven"],
    ["test-fault", { kind: "test-fault", op: "fire", faultKind: "r2-put-503", binding: "DEST" }, "test-fault-fired"],
  ];

  for (const [name, target, action] of targets) {
    eq(`a CURRENT engine's "${name}" target records NOTHING`, render(event(action, target)).length, 0);
  }

  // THE COVERAGE CLAIM COMES FROM THE ENGINE. Counting the local array against its own length would agree
  // with itself no matter how many target kinds were missing from it, so the expectation is read from the
  // engine's own AuditTarget union instead, member for member.
  if (vocab !== null) {
    const driven = new Set(targets.map(([name]) => name));
    const missing = engineTargetKinds.filter((k) => !driven.has(k));
    ok(`every target kind the engine declares is DRIVEN here (${engineTargetKinds.length} read from the engine, ${driven.size} driven)${missing.length > 0 ? `, undriven: ${missing.join(", ")}` : ""}`, missing.length === 0);
  }

  // These are on the engine's most ordinary paths, so name them as such.
  ok("an IdP sign-in no longer files skew (it fired on EVERY native IdP sign-in)", render(event("idp-sign-in", { kind: "idpconnection", connId: "okta-1", connKind: "oidc", op: "signin" })).length === 0);
  ok("a forced destination removal no longer files skew (it fired on WHERE BACKUPS GO)", render(event("dest-config-cleared", { kind: "dest-change", op: "remove", id: "d2", force: true })).length === 0);
}

// ---------------------------------------------------------------------------------------------------------
// EVERY ACTION. An action the engine writes and the console cannot label reads as a raw internal noun, and an
// action absent from the filter cannot be selected at all.
// ---------------------------------------------------------------------------------------------------------
function everyAction(): void {
  console.log("\nevery action the CURRENT engine can write:");

  const unlabelled = (AUDIT_ACTION_OPTIONS as AuditAction[]).filter((a) => actionLabel(a) === a.replace(/-/g, " "));
  eq("no offered action falls back to the hyphen-strip", unlabelled.length, 0);
  // THE COUNT COMES FROM THE ENGINE, never from a literal. A count compared against the thing it was
  // derived from agrees with it however wrong both are, so a stale literal can stay green indefinitely.
  //
  // A second opinion is only a second opinion when it comes from the other side. So the expectation is READ
  // from the engine's own AUDIT_ACTIONS, member for member, and the set comparison below cannot be satisfied
  // by anything the console holds. scripts/audit-mirror-drift-gate.mjs makes the same comparison in the lint
  // chain; this one runs in `validate`, where a console-only checkout says so out loud rather than passing.
  if (vocab !== null) {
    const surplus = AUDIT_ACTION_OPTIONS.filter((a) => !engineActions.includes(a));
    const unoffered = engineActions.filter((a) => !(AUDIT_ACTION_OPTIONS as string[]).includes(a));
    ok(`the filter offers the engine's whole action set (${engineActions.length} read from the engine, ${AUDIT_ACTION_OPTIONS.length} offered)${unoffered.length > 0 ? `, unoffered: ${unoffered.join(", ")}` : ""}`, unoffered.length === 0);
    ok(`no offered action is one the engine cannot write${surplus.length > 0 ? ` (dead: ${surplus.join(", ")})` : ""}`, surplus.length === 0);
  }
  ok("no action is offered twice", new Set(AUDIT_ACTION_OPTIONS).size === AUDIT_ACTION_OPTIONS.length);

  // NOISE: an ordinary, healthy page of engine traffic records nothing at all.
  resetRing();
  const events = [
    event("downpipe-create", { kind: "downpipe", id: "dp-1", name: "prod" }, "access"),
    event("dest-config-set", { kind: "dest-change", op: "set", id: "d1" }, "access"),
    event("idp-sign-in", { kind: "idpconnection", connId: "okta-1", connKind: "oidc", op: "signin" }, "oidc"),
    event("retention-prune", { kind: "downpipe", id: "dp-1" }),
  ];
  renderAuditEvents(new EngineClient("https://engine.example"), { events, nextCursor: null } as unknown as AuditPage, {} as never, () => {});
  eq("NOISE: a healthy page of four ordinary events records nothing", snapshot().records.filter((r) => r.kind === "contract-skew").length, 0);
}

// ---------------------------------------------------------------------------------------------------------
// AND IT STILL FIRES ON THE ONE STATE IT MEANS. A forward-compat signal that never fires is not a fix.
// ---------------------------------------------------------------------------------------------------------
function newerEngine(): void {
  console.log("\na genuinely NEWER engine still records the skew:");

  const unknownField = render(event("engine-secret-absent", { kind: "engine-state", field: "quantum-attestation", detail: "x" } as unknown as AuditTarget));
  eq("an engine-state field this build does not know records contract-skew", unknownField[0]?.fieldFamily, "audit-field-name");
  eq("...as unknown-enum-member", unknownField[0]?.contractClass, "unknown-enum-member");

  const unknownTarget = render(event("downpipe-create", { kind: "quantum-ledger", id: "q" } as unknown as AuditTarget));
  eq("a target KIND this build does not know records contract-skew", unknownTarget[0]?.fieldFamily, "audit-target");
  eq("...and it is a DIFFERENT family from the unknown field, so support can say WHAT the console is behind on", unknownTarget[0]?.fieldFamily !== unknownField[0]?.fieldFamily, true);

  const unknownMethod = render(event("downpipe-create", { kind: "downpipe", id: "dp-1" }, "mtls-device"));
  eq("an actor method this build does not know still records contract-skew", unknownMethod[0]?.fieldFamily, "audit-method");

  // REDACTION: the unrecognised raw value is rendered for the operator and recorded NOWHERE. A new enum member
  // can be operator text (an IdP connection slug, a policy name), so the row carries the family, never the value.
  const text = JSON.stringify([...unknownField, ...unknownTarget, ...unknownMethod]);
  ok("REDACTION: no raw enum member, no detail and no id rides in any row", !text.includes("quantum-attestation") && !text.includes("quantum-ledger") && !text.includes("mtls-device"));
}

secretVanished();
everyTarget();
everyAction();
newerEngine();

console.log(failures === 0 ? "\nAUDIT MIRROR (CONSOLE) PASS" : `\nAUDIT MIRROR (CONSOLE): ${failures} FAILED`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
