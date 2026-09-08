// Restore receipt (the trust-closing step). The applied-result classifier plus the
// receipt card and its copyable summary. Moved verbatim out of confirm.ts for size: no outcome
// classification, no attribution wording and no plan-hash handling is changed. House rules:
// Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { buildSkippedGroups } from "./skip-groups.ts";
import { cfSkipEntries, cfSkipIsBenign, cfSkipLine } from "./cf-skip-copy.ts";
import { deliverFile } from "../../lib/file-delivery.ts";
import { navigate } from "../../lib/nav.ts";
import { inlineOutcome } from "../../components/error-view.ts";
import { copyButton } from "../../components/code-block.ts";
import { groupNumber, humanBytes } from "../../lib/format.ts";
import { ICON_RESTORE, ICON_CHECK, ICON_ALERT, ICON_LOCK, ICON_SHIELD_CHECK } from "../../lib/icons.ts";
import { MAX_DISPLAY_ROWS } from "./shared.ts";
import { drawStrokeOnce } from "./effects.ts";
import type { RestoreResult } from "../../api.ts";

// E6: the applied results whose success tick has already drawn, keyed by OBJECT IDENTITY rather
// than a value (a genuinely new apply always produces a fresh RestoreResult object, so identity
// is an exact "have we shown this apply event before" test with no risk of two distinct applies
// coincidentally sharing a value-based key). A WeakSet never leaks: once nothing else references a
// result, its entry disappears with it.
const drawnReceiptResults = new WeakSet<RestoreResult>();

// renderReceipt is the trust-closing step.
//  - The "Applied by" actor is the real verified caller (who, by the role gate, is an
//    Approver or Owner). On the token fallback (no attributable identity, email null) the
//    receipt says so EXPLICITLY rather than omitting the applier, so the highest-consequence
//    action is never silently unattributed.
//  - "Approved by <checker>" is shown NOW (not "when the audit store is live"), carried
//    from the usable approval that armed the apply, so the maker != checker pair is visible
//    on the durable receipt.
//  - A partial apply (failures[]) is never dressed up as success AND offers "Retry the
//    failed subset", which re-enters the flow scoped to the failed record names.
// approverEmail is the distinct checker's email (null only if it was somehow absent).
// onRetrySubset re-enters the flow for the failed names.
// restoreOutcome classifies an applied RestoreResult into ONE of three distinct outcomes the receipt and
// the copyable summary both render, so a deliberate windowed apply is never conflated with a failure:
//   - "failed":   ok:false OR one or more per-record failures (the apply could not write some records).
//   - "windowed": a deliberate maxRecords cap left records BEYOND the window unwritten (complete:false)
//     with NO failures. This is an INTENTIONAL partial, not a fault. complete is OPTIONAL on the wire (an
//     engine build that does not emit it leaves it absent), and an absent flag is read as a complete apply
//     (the prior behaviour), so only an explicit complete:false yields "windowed".
//   - "clean":    the whole in-scope plan applied with no failures.
// remaining is the count of records beyond the window, 0 unless windowed. It PREFERS the engine's
// authoritative outOfWindow when present (the two agree for a pure maxRecords window but diverge when
// records are skipped for non-window reasons); only when outOfWindow is absent (an older engine) does it
// fall back to the derived (verified minus written), clamped >= 0.
// This is a PURE classifier (no DOM, no I/O) so it can be unit-tested directly.
//   - "skipped":  every record that COULD be written was written, but some were deliberately not (a secrets
//     record has no runtime write path, an incompleteness marker is a sentinel rather than real bytes).
//     Those records are in the archive and are NOT in the account, so the apply is not a clean full
//     restore. The dry-run plan already groups them by what the operator should do; classifying them here
//     is what stops that disappearing from the narrative at the exact moment it became real. It ranks
//     below "failed" and "windowed": a failure and an intentional cap are both larger facts about the run.
//   - "reduced":  every record wrote, and some arrived missing something the archive held (a dropped TTL,
//     a filtered D1 index, media that did not re-upload). It ranks BELOW "skipped" deliberately: a skipped
//     record is not in the account at all, which is a larger fact than a record that is there but lossy.
export type RestoreOutcomeKind = "failed" | "windowed" | "skipped" | "reduced" | "clean";
export interface RestoreOutcome { kind: RestoreOutcomeKind; partial: boolean; title: string; headline: string; remaining: number; skippedCount: number; shortfalls: string[] }

// fidelityShortfalls names what a restore did NOT fully carry across, in the operator's words rather than
// the wire's. Empty on a full-fidelity restore.
//
// Every one of these exists in the engine because it was once silent, and the engine's own comments say
// so: d1SchemaObjectsFiltered so "an app that breaks after a complete subset restore has an answer",
// metadataFieldsDropped because dropped TTLs were "SILENT behind a receipt claiming full fidelity". The
// console had never declared the fields, so the evidence arrived and was discarded, and this screen went
// on showing a success tick over a restore that quietly lost things.
// metadataShedPhrase turns ONE member of the engine's METADATA_SHED_FIELDS (engine/src/dest/restore-fault.ts)
// into the sentence an operator reads. It exists because a single sentence for every member was wrong about
// the most ordinary one.
//
// The engine keeps `kv-expiration` and `kv-expiration-lapsed` as separate members, and its own comment says
// why: an UNUSABLE expiration is a defect signal (something wrote a value the format does not allow), while a
// LAPSED one is the expected consequence of restoring a backup older than the namespace's TTLs. This screen
// collapsed the two back into "which could not be reproduced", which is the defect wording, and printed the
// raw wire key on top of it. So on the case a customer meets whenever they restore an old archive, the
// receipt named a cause that had not happened and spoke in the transport's words.
//
// An unrecognised member falls through to the field name with NO cause attached. The console cannot know why
// a field it has never heard of was shed, and guessing is exactly what produced the defect above.
// `validate-metadata-shed-vocabulary.ts` reads the engine's closed set and refuses a member with no arm here,
// so the fall-through is a safety net rather than the working path.
function metadataShedPhrase(field: string, n: number): string {
  switch (field) {
    case "kv-expiration":
      return `${n} KV key(s) restored with no expiry, because the archived expiration was not a usable value and could not be reproduced`;
    case "kv-expiration-lapsed":
      return `${n} KV key(s) restored with no expiry, because the archived expiration had already passed by the time the restore ran. Set a TTL on them again if you still want one`;
    case "r2-cache-expiry":
      return `${n} object(s) restored with no edge cache-expiry, because the archived value did not parse as a date and could not be reproduced`;
    default:
      return `${n} record(s) lost their ${field}`;
  }
}

export function fidelityShortfalls(res: RestoreResult): string[] {
  const out: string[] = [];
  const media = Object.values(res.mediaFaults ?? {}).reduce((a, b) => a + b, 0);
  if (media > 0) out.push(`${media} media file(s) did not re-upload`);
  const conflicts = res.mediaConflictDigests?.length ?? 0;
  if (conflicts > 0) out.push(`${conflicts} media id(s) already held different live bytes, so nothing was overwritten`);
  if (res.d1Fault !== undefined) out.push(`a D1 restore fault (${res.d1Fault.d1ErrorClass}) stopped part of the database restoring`);
  const schema = res.d1SchemaObjectsFiltered ?? 0;
  if (schema > 0) out.push(`${schema} D1 index(es), trigger(s) or view(s) were dropped by the table subset you chose`);
  const shed = Object.entries(res.metadataFieldsDropped ?? {}).filter(([, n]) => n > 0);
  for (const [field, n] of shed) out.push(metadataShedPhrase(field, n));
  return out;
}

export function restoreOutcome(res: RestoreResult): RestoreOutcome {
  const failed = !res.ok || res.failures.length > 0;
  const windowed = !failed && res.complete === false;
  const skippedCount = res.skipped?.length ?? 0;
  const skipped = !failed && !windowed && skippedCount > 0;
  // A restore that lost fidelity is NOT clean, even when every record wrote and nothing was windowed.
  // Calling it clean is the same over-claim the engine added these fields to stop, one layer up.
  const shortfalls = fidelityShortfalls(res);
  const reduced = !failed && !windowed && !skipped && shortfalls.length > 0;
  const kind: RestoreOutcomeKind = failed ? "failed" : windowed ? "windowed" : skipped ? "skipped" : reduced ? "reduced" : "clean";
  const remaining = windowed
    ? Math.max(0, res.outOfWindow ?? res.recordsVerified - res.recordsRestored)
    : 0;
  return {
    kind,
    partial: failed || windowed || skipped || reduced,
    title: failed ? "Restore applied with failures" : windowed ? "Restore applied (windowed)" : skipped ? "Restore applied, with records outstanding" : reduced ? "Restore applied, with reduced fidelity" : "Restore applied",
    headline: failed ? "applied with failures" : windowed ? "applied (windowed)" : skipped ? "applied, with records outstanding" : reduced ? "applied, with reduced fidelity" : "applied",
    remaining,
    skippedCount,
    shortfalls,
  };
}

export function renderReceipt(
  res: RestoreResult,
  actorEmail: string | null,
  planHash: string | null,
  approverEmail: string | null,
  onRetrySubset: (failedNames: string[]) => void,
): HTMLElement {
  const outcome = restoreOutcome(res);
  const windowed = outcome.kind === "windowed";
  const card = h("div", { class: `card restore-receipt restore-receipt--${outcome.partial ? "partial" : "clean"}`, role: "status" });

  const headIcon = svgIcon(outcome.partial ? ICON_ALERT : ICON_CHECK, { size: 22 });
  if (!outcome.partial) {
    // E6: on the FIRST mount of a clean applied receipt, the success tick draws once via
    // stroke-dashoffset, keyed to this exact result object so it never replays on a revisit or
    // re-render of the same apply event. A partial/failed outcome keeps its alert icon static (no
    // colour flash, no draw ceremony beyond the --ok family this is reserved for).
    const seenBefore = drawnReceiptResults.has(res);
    drawnReceiptResults.add(res);
    drawStrokeOnce(headIcon, seenBefore, 400);
  }
  const head = h(
    "div",
    { class: "restore-receipt__head" },
    headIcon,
    h("h3", { class: "restore-receipt__title" }, outcome.title),
  );
  card.appendChild(head);

  // FIDELITY SHORTFALLS, immediately under the head and above the payoff figures. Position is the point:
  // "3,000 records restored" reads as unqualified success, and anything qualifying it has to arrive before
  // the operator has already formed that impression, not in a disclosure below it.
  //
  // Each line names WHAT was lost rather than counting faults, because a count cannot be acted on. These
  // render for every outcome, including a failed one: a restore can both fail records and lose fidelity on
  // the ones it wrote, and the two are different problems with different remedies.
  if (outcome.shortfalls.length > 0) {
    const note = h("div", { class: "impact impact--warn", role: "note" });
    note.appendChild(h("div", { class: "impact__head" }, svgIcon(ICON_ALERT, { size: 18 }), h("span", "Some data did not carry across in full")));
    const list = h("ul", { class: "skipped-list" });
    for (const line of outcome.shortfalls) list.appendChild(h("li", line));
    note.appendChild(list);
    note.appendChild(h("p", { class: "field__hint" }, "These records were written, but not exactly as captured. The support pack carries the detail."));
    card.appendChild(note);
  }

  // Records + bytes as the HEADLINE figures (the payoff numbers), reached before the narrative
  // prose below (which still carries the windowed/failure nuance the raw figures cannot). Shown for
  // every outcome, including a partial or failed apply: "how much DID land" is exactly as load-
  // bearing on a shortfall as on a clean pass.
  card.appendChild(
    h(
      "div",
      { class: "restore-receipt__headline" },
      h(
        "span",
        { class: "restore-receipt__figure" },
        h("span", { class: "restore-receipt__figure-value tnum" }, groupNumber(res.recordsRestored)),
        h("span", { class: "restore-receipt__figure-label" }, "records restored"),
      ),
      h(
        "span",
        { class: "restore-receipt__figure" },
        h("span", { class: "restore-receipt__figure-value tnum" }, humanBytes(res.bytesRestored)),
        h("span", { class: "restore-receipt__figure-label" }, "written"),
      ),
    ),
  );

  // cf-config surfaces re-applied to the live account (idempotent surfaces only, shown only when an edit
  // token was supplied). A surface that failed to write is also listed in the per-record failures below.
  if (res.configApplied && res.configApplied.length > 0) {
    const n = res.configApplied.length;
    const details = h("details", { class: "disclosure", open: true }, h("summary", `Cloudflare config applied (${n} surface${n === 1 ? "" : "s"})`));
    const list = h("ul", { class: "skipped-list disclosure__body" });
    for (const c of res.configApplied) {
      const row = h("li", h("span", { class: "mono" }, c.surface), " ", h("span", { class: "field__hint" }, `${c.applied} applied${c.skipped > 0 ? `, ${c.skipped} skipped` : ""}`));
      // WHY IT SKIPPED, per class. The bare integer above cannot tell a plan limit from a token that lacks
      // the edit scope, and those need different things done about them. The class and its count are all
      // that is rendered: Cloudflare's own message was in the live restore response and is recorded nowhere.
      //
      // Every class present is listed, including `other` and including one this console does not recognise,
      // because the engine's safety property is deliberately independent of the classifier (a refusal it
      // cannot classify still fails the apply) and a screen that dropped what it could not name would break
      // that. The benign class sorts last and is worded as benign, so a customer whose plan simply does not
      // carry the surface is not sent to widen a token.
      for (const [cls, n] of cfSkipEntries(c.skipReasonCounts)) {
        row.appendChild(
          h("p", { class: cfSkipIsBenign(cls) ? "field__hint" : "field__error", style: "margin-top:var(--space-1)" },
            `${groupNumber(n)} ${n === 1 ? "item" : "items"}: ${cfSkipLine(cls)}`),
        );
      }
      list.appendChild(row);
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  // Media files re-uploaded to the live account (shown only when a media edit token was supplied). This
  // IS the old->new id map: an image kept its original id, a video was re-uploaded as a NEW id (Stream
  // transcodes every upload), so a video row states the new id plainly for updating references. A file
  // that failed to upload is recorded in the per-record failures below, not here (mediaRestored lists
  // only what actually landed).
  // The skipped records themselves, grouped by what to DO about them, using the SAME grouping the dry-run
  // plan showed. Reused rather than reimplemented: a second grouping here would drift, and an operator
  // being told different things about the same record before and after they apply is the failure mode.
  if (res.skipped && res.skipped.length > 0) {
    for (const group of buildSkippedGroups(res.skipped)) card.appendChild(group);
  }

  if (res.mediaRestored && res.mediaRestored.length > 0) {
    const n = res.mediaRestored.length;
    const remapped = res.mediaRestored.filter((m) => m.remapped).length;
    const details = h(
      "details",
      { class: "disclosure", open: true },
      h("summary", `Media re-uploaded (${n} file${n === 1 ? "" : "s"}${remapped > 0 ? `, ${remapped} remapped to a new id` : ""})`),
    );
    const list = h("ul", { class: "skipped-list disclosure__body" });
    for (const m of res.mediaRestored) {
      list.appendChild(
        h(
          "li",
          h("span", { class: "mono" }, m.name),
          " ",
          m.remapped
            ? h("span", { class: "field__hint" }, "-> new id ", h("span", { class: "mono" }, m.restoredId), " (update any reference to the old id)")
            : h("span", { class: "field__hint" }, "restored to its original id"),
        ),
      );
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  if (windowed) {
    // An intentional windowed apply: the records WITHIN the window were written cleanly; the records
    // BEYOND the window were deliberately not applied (the maxRecords cap), so state both halves plainly.
    // remaining is the derived count beyond the window; if it is not positive (an engine that set
    // complete:false without a derivable remainder) we say so generically.
    const remaining = outcome.remaining;
    card.appendChild(
      h("p", { class: "restore-receipt__line" }, `Restored ${groupNumber(res.recordsRestored)} of ${groupNumber(res.recordsVerified)} verified records, ${humanBytes(res.bytesRestored)} written.`),
    );
    card.appendChild(
      h(
        "p",
        { class: "restore-receipt__line field__hint" },
        remaining > 0
          ? `Partial: ${groupNumber(remaining)} record${remaining === 1 ? "" : "s"} beyond the window were not applied (an intentional cap, not a failure). Apply them with a fresh windowed restore.`
          : "Partial: records beyond the window were not applied (an intentional cap, not a failure). Apply them with a fresh windowed restore.",
      ),
    );
  } else if (res.ok && res.failures.length === 0) {
    card.appendChild(
      h("p", { class: "restore-receipt__line" }, `Restored ${groupNumber(res.recordsRestored)} of ${groupNumber(res.recordsVerified)} verified records, ${humanBytes(res.bytesRestored)} written.`),
    );
    if (outcome.kind === "skipped") {
      // The bare "N of M" above is true and is not an explanation. Without this an operator's last view of
      // the run is a clean verdict and an unexplained shortfall, having been shown the reasons in the dry
      // run and then not again once the apply made them real. These are not failures, and saying so is part
      // of the point: they are records that need an action somewhere else.
      card.appendChild(
        h(
          "p",
          { class: "restore-receipt__line field__hint" },
          `${groupNumber(outcome.skippedCount)} record${outcome.skippedCount === 1 ? " was" : "s were"} deliberately not written and ${outcome.skippedCount === 1 ? "is" : "are"} still outstanding. ${outcome.skippedCount === 1 ? "It is" : "They are"} in the archive and not in your account, so ${outcome.skippedCount === 1 ? "it needs" : "they need"} the action below.`,
        ),
      );
    }
  } else if (res.failures.length > 0) {
    // The honest partial: state the split plainly.
    card.appendChild(
      h("p", { class: "restore-receipt__line" }, `${groupNumber(res.recordsRestored)} of ${groupNumber(res.recordsVerified)} records written; ${res.failures.length} could not be written.`),
    );
    const details = h("details", { class: "disclosure", open: true }, h("summary", `${res.failures.length} per-record failures`));
    const list = h("ul", { class: "skipped-list disclosure__body" });
    for (const f of res.failures.slice(0, MAX_DISPLAY_ROWS)) {
      list.appendChild(h("li", h("span", { class: "mono" }, f.name), " ", h("span", { class: "field__hint" }, f.reason)));
    }
    details.appendChild(list);
    card.appendChild(details);
  } else {
    // ok:false with no per-record failures: a top-level reason, no writes.
    card.appendChild(inlineOutcome({ heading: "Restore did not complete", reason: res.reason ?? "The apply failed.", reassurance: "Nothing was written." }));
  }

  // The maker/checker identity pair, prominent (its own block, normal text weight), not one
  // muted caption. The applier is the real caller, or, on the token fallback (email null), an
  // explicit non-attributable statement (never an omission). The distinct approver (the
  // checker) is shown NOW, so the receipt carries the maker != checker pair on the durable record.
  const identity = h("div", { class: "restore-receipt__identity" });
  const appliedRow = h("p", { class: "restore-receipt__identity-row" }, svgIcon(ICON_LOCK, { size: 15 }));
  appliedRow.appendChild(
    document.createTextNode(
      actorEmail ? `Applied by ${actorEmail}` : "Applied via the shared admin token (no attributable identity)",
    ),
  );
  identity.appendChild(appliedRow);
  if (approverEmail) {
    const approvedRow = h(
      "p",
      { class: "restore-receipt__identity-row" },
      svgIcon(ICON_SHIELD_CHECK, { size: 15 }),
      document.createTextNode(`Approved by ${approverEmail}, a distinct approver`),
    );
    identity.appendChild(approvedRow);
  }
  identity.appendChild(h("p", { class: "restore-receipt__identity-note field__hint" }, "Recorded as an audit event with these identities."));
  card.appendChild(identity);

  // Receipt actions: Copy summary + (on a partial) Retry the failed subset + View run.
  const summary = receiptSummary(res, actorEmail, approverEmail, planHash);
  const actions = h("div", { class: "restore-receipt__actions" }, copyButton("Copy summary", () => summary));

  // A partial apply offers a real subset retry, scoped to the failed record NAMES the
  // result carries. The names are usable as include selectors, so this rebuilds a genuine
  // scoped restore rather than promising a capability it cannot deliver.
  const failedNames = res.failures.map((f) => f.name).filter((n) => n !== "");
  if (failedNames.length > 0) {
    actions.appendChild(
      h(
        "button",
        { "data-dp": "restore-flow.button.retry-subset", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => onRetrySubset(failedNames) } },
        svgIcon(ICON_RESTORE, { size: 14 }),
        `Retry the failed subset (${groupNumber(failedNames.length)})`,
      ),
    );
  }
  // A failure entry with NO record name cannot become an include selector, so the retry subset covers
  // FEWER records than failed. That shrink was silent: the button read "Retry the failed subset (14)"
  // beside "17 could not be written" and nothing explained the three. Say it, with the count.
  const nameless = namelessFailureCount(res.failures);
  if (nameless > 0) {
    card.appendChild(
      h(
        "p",
        { class: "field__hint", role: "status" },
        failedNames.length > 0
          ? `${groupNumber(nameless)} of the ${groupNumber(res.failures.length)} failed records came back without a record name, so "Retry the failed subset" covers only the ${groupNumber(failedNames.length)} that are named. Re-run the full restore, or quote this run to support, to cover the rest.`
          : `None of the ${groupNumber(res.failures.length)} failed records came back with a record name, so there is no subset to retry by name. Re-run the full restore, or quote this run to support.`,
      ),
    );
  }

  // THE SIGNED RESTORE RECEIPT, offered as a DOWNLOAD rather than rendered.
  //
  // The engine attests that each restored record's LANDED bytes hash to the signed manifest hash, anchors
  // that into its tamper-evident audit chain, and signs it (Ed25519 + ML-DSA-87) when the signer is
  // reachable. The console was declaring the field and showing none of it, so the attestation was computed
  // and discarded.
  //
  // A download, for three reasons. It is names, hashes and counts, so rendering it inline would bury the
  // outcome under data nobody can act on. Its value is as a PORTABLE artefact months later, for an auditor
  // or an insurer, and a rendered panel cannot be handed to either. And putting it only in the support pack
  // would mean raising a ticket to obtain your own restore attestation, which inverts the custody story.
  //
  // Absent on a dry-run and on an early integrity abort, so the button only appears when there is one.
  if (res.receipt !== undefined && res.receipt !== null) {
    actions.appendChild(
      h(
        "button",
        {
          "data-dp": "restore-flow.button.deliver-file",
          class: "btn btn--secondary btn--sm",
          type: "button",
          on: {
            click: () => {
              deliverFile(`downpipes-restore-receipt-${res.runId}.json`, `${JSON.stringify(res.receipt, null, 2)}\n`, "application/json", "restore-receipt");
            },
          },
        },
        "Download receipt",
      ),
    );
  }

  actions.appendChild(
    h("button", { "data-dp": "restore-flow.button.navigate#3", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate(`/restore/${encodeURIComponent(res.runId)}`) } }, "View run"),
  );
  card.appendChild(actions);
  // One precise line about what that file is. It deliberately does NOT claim a particular tool verifies it:
  // the offline reader emits and checks its OWN receipts, and whether it validates the ENGINE's shape was
  // not confirmed, so saying so would be an overclaim on exactly the evidence a customer would rely on.
  if (res.receipt !== undefined && res.receipt !== null) {
    card.appendChild(
      h(
        "p",
        { class: "restore-receipt__line field__hint" },
        "The receipt records each restored record's name and hash and states that the bytes that landed match the signed backup. It is anchored in the audit log and signed when the signing key is reachable. Keep it as evidence of this restore.",
      ),
    );
  }
  return card;
}

// failuresByReason groups the per-record failures by the engine's coarse reason, newest tally first, so a
// receipt (and the summary the customer pastes into a ticket) states WHY 17 records failed, not merely
// that 17 did. A bare "Failures: 17" forced support to ask the customer to reconstruct the breakdown from
// a screen they had already left. The reasons are the engine's coarse classes, never a record VALUE, and a
// failure entry with no reason is counted under an explicit unstated bucket rather than dropped.
export function failuresByReason(failures: ReadonlyArray<{ name: string; reason: string }>): Array<{ reason: string; count: number }> {
  const tally = new Map<string, number>();
  for (const f of failures) {
    const reason = f.reason !== "" ? f.reason : "reason not stated by the engine";
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  return [...tally].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

// namelessFailureCount is the number of failure entries the engine returned with NO record name. They
// matter twice over: they cannot be retried by name (so the "retry the failed subset" button silently
// covered fewer records than failed), and their presence is itself a defect signal in the apply result.
export function namelessFailureCount(failures: ReadonlyArray<{ name: string }>): number {
  return failures.filter((f) => f.name === "").length;
}

function receiptSummary(res: RestoreResult, actorEmail: string | null, approverEmail: string | null, planHash: string | null): string {
  // Mirror the on-screen three-way outcome (failed / windowed / clean) in the copyable summary.
  const outcome = restoreOutcome(res);
  const lines = [
    `Restore ${outcome.headline}`,
    `Run: ${res.runId}`,
    `Records restored: ${groupNumber(res.recordsRestored)} of ${groupNumber(res.recordsVerified)} verified`,
    `Bytes written: ${humanBytes(res.bytesRestored)}`,
    `Latest run: ${res.isLatest ? "yes" : "no"}`,
  ];
  if (outcome.kind === "windowed") {
    lines.push(outcome.remaining > 0 ? `Beyond the window (not applied): ${groupNumber(outcome.remaining)}` : "Records beyond the window were not applied (intentional cap)");
  }
  if (res.failures.length > 0) {
    lines.push(`Failures: ${res.failures.length}`);
    // The class breakdown, not a bare count: this is the line support reads first.
    for (const { reason, count } of failuresByReason(res.failures)) lines.push(`  ${count} x ${reason}`);
    const nameless = namelessFailureCount(res.failures);
    if (nameless > 0) lines.push(`  (${nameless} of these carry no record name, so they cannot be retried by name)`);
  }
  if (res.reason !== undefined && res.reason !== "") lines.push(`Reason: ${res.reason}`);
  lines.push(`Applied by: ${actorEmail ?? "shared admin token (no attributable identity)"}`);
  if (approverEmail) lines.push(`Approved by: ${approverEmail}`);
  if (planHash) lines.push(`Plan hash: ${planHash}`);
  return lines.join("\n");
}
