// Restore the proof surface (one shared region for every "prove this
// run restores" verb): the blind restore test (the engine decrypts every in-scope record
// to a discard sink, checks each plaintext hash, returns counts + a restoreDigest, never a
// byte of plaintext), the drill (restores one sample record into a verification path and
// records dated drill evidence), and the keyless attestation (signature / completeness /
// anti-rollback, no key, no data) for the break-glass-only posture. Nothing here writes
// live data and nothing is licence-gated. Moved verbatim out of restore-flow.ts for size;
// no-custody is never weakened. House rules: Australian English, no em dashes, precise
// claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { canCap, capGateReason, refuseWithReason } from "../common.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError, inlineOutcome } from "../../components/error-view.ts";
import { badge } from "../../components/status.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { copyButton } from "../../components/code-block.ts";
import { groupNumber, humanBytes } from "../../lib/format.ts";
import {
  ICON_PLAY, ICON_SHIELD_CHECK, ICON_LOCK,
} from "../../lib/icons.ts";
import type {
  EngineClient, RunHistoryEntry, DrillResult,
  BlindRestoreTest, KeylessAttestationResult,
} from "../../api.ts";
import { BREAK_GLASS_PREFIX, drillEvidenceMissedNote, lastProvenLine, MAX_DISPLAY_ROWS, writeDrillEvidence } from "./shared.ts";
import { provenTitle } from "../../lib/protection-statement.ts";

// After this delay a long-running proof shows a reassurance note so it never reads as a
// hang. Tuned against observed proof latency; adjust here if the P95 shifts.
const SLOW_NOTE_THRESHOLD_MS = 10_000;

// Number of leading characters of the restore digest shown in the UI; the remainder is
// elided with an ellipsis. Display-only; the full digest is never truncated for comparison.
const DIGEST_DISPLAY_CHARS = 28;

// ---- prove this run restores (one proof surface) -----------------------------

// renderProofCard is the SINGLE proof surface for a run (it replaces the separate
// "Recoverability" drill card and "Restorability assurance" card, which competed with
// five differently named read-only verbs). One shared result region, one slow-note, no
// toast echo (the verdict paints in view). The PRIMARY verb is the blind restore test:
// the engine decrypts every in-scope record to a discard sink, checks each plaintext
// hash, and returns counts + a restoreDigest, never a byte of plaintext. The drill
// folds in as the secondary verb: it is NOT read-only-alike (it restores one sample
// record into a verification path and records dated drill evidence), which is why it
// gates on drill.run (Operator, Restore operator, Approver, Owner) while the blind verify
// needs only restore.verify (held from the Viewer floor up).
// The keyless attestation (signature/completeness/anti-rollback, no key, no data)
// surfaces ONLY when a proof reports the break-glass-only posture, where it is that
// posture's strongest in-account claim; in keyed postures the blind verify subsumes it.
// Nothing here writes live data and nothing is licence-gated (the recovery path is
// always open). No-custody is never weakened: only counts, a hash over hashes,
// redaction-safe source names of FAILED records (never a value) and dated provenance.
// Rendered as a disclosure BODY (the collapsedSection summary carries the heading).
export function renderProofCard(engine: EngineClient, run: RunHistoryEntry, downpipeId: string): HTMLElement {
  const card = h("div", { class: "stack-sm" });
  card.appendChild(proofIntro());

  // The dated last-proven line host plus its best-effort recency refresh (see buildProvenHost).
  const { host: provenHost, refreshProven } = buildProvenHost(engine, downpipeId);
  card.appendChild(provenHost);
  refreshProven();

  // The SHARED result region: one polite live region every proof verdict paints into.
  const result = h("div", { class: "restore-verify__result", "aria-live": "polite", style: "margin-top:var(--space-3)" });
  result.appendChild(h("p", { class: "field__hint" }, "No proof run yet in this session."));

  const canVerify = canCap("restore.verify") && run.runId !== "";
  const noRunReason = run.runId ? capGateReason("restore.verify") : "This run has no id to verify.";
  // The drill button gates on drill.run, the capability the engine enforces on POST /admin/drill
  // (engine router-pipelines.ts gate(caller, "drill.run"), held by Operator, Restore operator, Approver
  // and Owner). Gating by that capability, not the operator role rank, matters because a
  // restore-operator holds drill.run (a recovery rehearsal is part of the recovery role) yet sits off the
  // rank ladder, so the old canDo("operator") check disabled the drill for the recovery-only role the
  // engine accepts.
  const canDrill = canCap("drill.run") && run.runId !== "";
  const noDrillReason = run.runId ? capGateReason("drill.run") : "This run has no id to drill.";

  const verifyBtn = h(
    "button",
    { "data-dp": "restore-flow.button.verify",
      class: "btn btn--secondary btn--sm",
      type: "button",
      // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the blind
      // restore drill). No behaviour; no effect on the genuine console.
      dataset: { tourId: "restore-verify" },
    },
    svgIcon(ICON_SHIELD_CHECK, { size: 14 }),
    "Verify restorability",
  ) as HTMLButtonElement;

  const drillBtn = h(
    "button",
    { "data-dp": "restore-flow.button.drill",
      class: "btn btn--ghost btn--sm",
      type: "button",
      dataset: { tourId: "restore-drill" },
    },
    svgIcon(ICON_PLAY, { size: 14 }),
    "Drill this run",
  ) as HTMLButtonElement;

  // The refusal and the busy latch are now two different things, and keeping them apart is the
  // point. A refused button is refuseWithReason'd once below: focusable, announced, with its reason
  // in text, and no handler attached. The busy latch is a transient `disabled` on a button that IS
  // live, which is the one use of `disabled` this migration keeps, because there is no reason to
  // read there and the state lasts one request.
  //
  // setBusy therefore touches only the live buttons. The `busy || !canVerify` form it replaced would
  // have re-applied `disabled` to a refused sibling on the first request of the other button, which
  // would have silently undone the migration for the caller who holds one capability but not both.
  const setBusy = (busy: boolean): void => {
    if (canVerify) verifyBtn.disabled = busy;
    if (canDrill) drillBtn.disabled = busy;
  };

  // The shared past-~10s reassurance note, so a long-running proof never reads as a hang.
  const slowNote = (msg: string): number =>
    window.setTimeout(() => {
      result.replaceChildren(proofRunning(msg));
    }, SLOW_NOTE_THRESHOLD_MS);

  // paintBreakGlass: the one place the break-glass-only posture lands, for BOTH keyed
  // proofs, and the ONLY place the keyless attestation is offered (it is this posture's
  // guided next step; elsewhere the blind verify is the stronger claim).
  const paintBreakGlass = (reason: string): void =>
    paintBreakGlassPosture({ engine, run, result, setBusy, refreshProven, reason });

  if (canVerify) {
    wireVerifyButton({ engine, run, verifyBtn, result, setBusy, slowNote, refreshProven, paintBreakGlass });
  } else {
    refuseWithReason(verifyBtn, noRunReason);
  }

  if (canDrill) {
    wireDrillButton({ engine, run, drillBtn, result, setBusy, slowNote, paintBreakGlass });
  } else {
    refuseWithReason(drillBtn, noDrillReason);
  }

  card.appendChild(h("div", { class: "restore-verify__actions", style: "display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-1)" }, verifyBtn, drillBtn));
  card.appendChild(result);
  appendFloorHints(card);
  return card;
}

// proofIntro builds the two standing header lines: the "prove before you write back" lead with the
// "no data exposed" trust badge, and the ONE standing no-data line (the badge above and this line
// carry the fact; the verdicts do not restate it). Static, no state.
function proofIntro(): HTMLElement {
  const intro = h("div", { class: "stack-sm" });
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (verify without
  // decrypting). No behaviour; no effect on the genuine console.
  const noDataBadge = badge("trust", "no data exposed");
  noDataBadge.dataset.tourId = "restore-no-data";
  intro.appendChild(
    h(
      "div",
      { style: "display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap" },
      h("span", { class: "field__hint", style: "margin:0" }, "Prove this run can be recovered before you write anything back."),
      noDataBadge,
    ),
  );
  intro.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
      h("span", { style: "flex:none;margin-top:1px;color:var(--trust)" }, svgIcon(ICON_LOCK, { size: 14 })),
      h("span", "Records are decrypted only to verify their hashes, then discarded. No record contents are returned, logged or displayed."),
    ),
  );
  return intro;
}

// proofRunning is the IMMEDIATE in-progress status (a standalone spinner + message) painted into the
// shared result region the moment a proof verb is clicked, so a multi-second verify / drill / attestation
// reads as RUNNING from t=0 rather than an inert disabled button (owner: "it was not evident it was
// running, and it took a while before I saw a result"). The .ob-spinner is reduced-motion gated in
// tokens.css, and the message is replaced by the verdict (or the break-glass posture) when the call lands.
function proofRunning(msg: string): HTMLElement {
  return h(
    "p",
    { class: "field__hint", style: "display:flex;align-items:center;gap:var(--space-2);margin:0" },
    h("span", { class: "ob-spinner", "aria-hidden": "true" }),
    h("span", msg),
  );
}

// buildProvenHost builds the dated last-proven line host and its best-effort recency refresh (the
// strongest claim, stated honestly). refreshProven reads the downpipe's lastRestoreProven* recency,
// says "never proven yet" until the first pass, and degrades silently if the downpipe state cannot be
// fetched (this card's actions are unaffected). The caller paints the initial line by calling it. The
// line carries provenTitle as its title attribute: lastProvenLine stays a plain date sentence, and a
// mouse user hovering it sees the precise absolute/relative instant (protection-statement.ts).
function buildProvenHost(engine: EngineClient, downpipeId: string): { host: HTMLElement; refreshProven: () => void } {
  const host = h("div", { class: "restore-verify__proven", style: "margin-top:var(--space-2)" });
  host.appendChild(h("p", { class: "field__hint" }, lastProvenLine(undefined)));
  const refreshProven = (): void => {
    void engine
      .listDownpipes()
      .then((list) => {
        const state = list.find((d) => d.config.id === downpipeId);
        const title = state ? provenTitle(state) : "";
        host.replaceChildren(h("p", { class: "field__hint", ...(title ? { title } : {}) }, lastProvenLine(state)));
      })
      .catch(() => {
        // Read-only context: leave the neutral "recency unavailable" line; never block the actions.
      });
  };
  return { host, refreshProven };
}

// paintBreakGlassPosture paints the break-glass-only posture into the shared result region and offers
// the keyless attestation (the ONLY place it is offered; elsewhere the blind verify is the stronger
// claim). Factored verbatim out of renderProofCard, taking its shared state as parameters.
function paintBreakGlassPosture(args: {
  engine: EngineClient;
  run: RunHistoryEntry;
  result: HTMLElement;
  setBusy: (busy: boolean) => void;
  refreshProven: () => void;
  reason: string;
}): void {
  const { engine, run, result, setBusy, refreshProven, reason } = args;
  const block = h("div", { class: "stack-sm" });
  block.appendChild(
    inlineOutcome({
      heading: "Break-glass-only posture",
      reason,
      reassurance: "This posture keeps no in-account read-back key, so a keyed proof cannot run here. Run the keyless integrity attestation below (it needs no key and no data), or prove full recoverability with attended verification: supply your break-glass key in your browser and the engine verifies a sample of each run against the keys you recover. Nothing is written and no record is returned.",
    }),
  );
  // Attended verification is this posture's in-platform proof path (the no-CLI replacement for the old
  // offline-rehearsal dead-end): it needs the break-glass key, supplied in the browser, so it leads here.
  const attendBtn = h(
    "button",
    { "data-dp": "restore-flow.button.attend", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/restore/attend") } },
    svgIcon(ICON_SHIELD_CHECK, { size: 14 }),
    "Attended verification",
  ) as HTMLButtonElement;
  const attestBtn = h(
    "button",
    { "data-dp": "restore-flow.button.attest", class: "btn btn--ghost btn--sm", type: "button" },
    svgIcon(ICON_LOCK, { size: 14 }),
    "Integrity attestation (keyless)",
  ) as HTMLButtonElement;
  attestBtn.addEventListener("click", async () => {
    attestBtn.dataset.busy = "true";
    attestBtn.disabled = true;
    setBusy(true);
    result.replaceChildren(proofRunning("Running the keyless integrity attestation. Checking the run's signature, completeness and anti-rollback; no key and no data are touched."));
    try {
      const res = await engine.attestRestore(run.runId);
      renderAttestationResult(result, res);
      if (res.ok) refreshProven();
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the result panel is holding a synchronous "Running the keyless
        // integrity attestation" line that only this handler ever replaces, so leaving here without
        // painting strands it for the life of the screen.
        result.replaceChildren(inlineOutcome({
          heading: "Your session ended before the attestation finished",
          reason: "The engine did not accept this request, so nothing was attested.",
          reassurance: "Nothing was written and no key was used. Sign in again and re-run the attestation.",
        }));
        return goSignedOut();
      }
      result.replaceChildren(blockError(err, () => attestBtn.click(), { origin: location.origin }));
    } finally {
      // attestBtn is re-enabled HERE and only here: setBusy() drives the verify and drill buttons, not
      // this one, so before this the attestation control stayed dead after its first press on every
      // path, success included.
      attestBtn.disabled = false;
      attestBtn.dataset.busy = "false";
      setBusy(false);
    }
  });
  block.appendChild(h("div", { style: "margin-top:var(--space-2);display:flex;gap:var(--space-2);flex-wrap:wrap" }, attendBtn, attestBtn));
  result.replaceChildren(block);
}

// wireVerifyButton attaches the blind restore test click handler (the PRIMARY verb). Factored verbatim
// out of renderProofCard, taking its shared state as parameters.
function wireVerifyButton(args: {
  engine: EngineClient;
  run: RunHistoryEntry;
  verifyBtn: HTMLButtonElement;
  result: HTMLElement;
  setBusy: (busy: boolean) => void;
  slowNote: (msg: string) => number;
  refreshProven: () => void;
  paintBreakGlass: (reason: string) => void;
}): void {
  const { engine, run, verifyBtn, result, setBusy, slowNote, refreshProven, paintBreakGlass } = args;
  verifyBtn.addEventListener("click", async () => {
    verifyBtn.dataset.busy = "true";
    setBusy(true);
    // Paint the spinner immediately so the verify reads as running from the click, not only after the
    // slow-note threshold (the disabled button alone was not evident enough).
    result.replaceChildren(proofRunning("Verifying restorability. The engine is decrypting and hash-checking every record into a discard sink; nothing is written or shown."));
    const slow = slowNote("Still verifying restorability. A large run takes a moment; every record is hash-checked into a discard sink. Nothing is written or shown.");
    try {
      const res = await engine.verifyRestore({ runId: run.runId });
      window.clearTimeout(slow);
      if (!res.ok && (res.reason ?? "").startsWith(BREAK_GLASS_PREFIX)) {
        paintBreakGlass(res.reason ?? "");
      } else {
        renderBlindTestResult(result, res);
        // On a clean pass the engine stamps the downpipe's "last proven" record; refresh
        // the line so the operator sees the new date without a reload. Best-effort.
        if (res.ok) refreshProven();
      }
    } catch (err) {
      window.clearTimeout(slow);
      if (isUnauthorised(err)) return goSignedOut();
      result.replaceChildren(restorabilityErrorBlock(err, () => verifyBtn.click()));
    } finally {
      verifyBtn.dataset.busy = "false";
      setBusy(false);
    }
  });
}

// wireDrillButton attaches the drill click handler (the secondary verb; it restores one sample record
// into a verification path). Factored verbatim out of renderProofCard, taking its shared state as
// parameters.
function wireDrillButton(args: {
  engine: EngineClient;
  run: RunHistoryEntry;
  drillBtn: HTMLButtonElement;
  result: HTMLElement;
  setBusy: (busy: boolean) => void;
  slowNote: (msg: string) => number;
  paintBreakGlass: (reason: string) => void;
}): void {
  const { engine, run, drillBtn, result, setBusy, slowNote, paintBreakGlass } = args;
  drillBtn.addEventListener("click", async () => {
    drillBtn.dataset.busy = "true";
    setBusy(true);
    result.replaceChildren(proofRunning("Drilling this run. The engine is restoring a sample record into a verification path."));
    const slow = slowNote("Still drilling this run. Restoring a sample record into a verification path; this can take a moment.");
    try {
      const res = await engine.drill(run.runId);
      window.clearTimeout(slow);
      if (!res.ok && (res.reason ?? "").startsWith(BREAK_GLASS_PREFIX)) {
        paintBreakGlass(res.reason ?? "");
      } else {
        renderDrillResult(result, res);
        // Record dated drill evidence for the on-call / auditor personas. The verdict is never
        // disturbed by an evidence-write fault, but the fault is no longer swallowed: an auditor
        // reading the recoverability report cannot distinguish "never drilled" from "drilled,
        // evidence write refused", so the console says which one this was.
        if (res.ok) void writeDrillEvidence(engine, run.runId, () => result.appendChild(drillEvidenceMissedNote()));
      }
    } catch (err) {
      window.clearTimeout(slow);
      if (isUnauthorised(err)) return goSignedOut();
      result.replaceChildren(blockError(err, () => drillBtn.click(), { origin: location.origin }));
    } finally {
      drillBtn.dataset.busy = "false";
      setBusy(false);
    }
  });
}

// appendFloorHints appends the visible floor hints (never hover-only): the two verbs gate at DIFFERENT
// floors because the drill writes a sample record, so the asymmetry is named in plain text.
function appendFloorHints(card: HTMLElement): void {
  if (!canCap("restore.verify")) {
    card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Proving restorability needs permission to verify restorability, held from the Viewer role up. It is read-only: it never writes data and never reveals a record."));
  } else if (!canCap("drill.run")) {
    card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, `Verifying restorability needs only ${capabilityPhrase("restore.verify")} (held from the Viewer role up). A drill also restores one sample record into a verification path, so running one needs ${capabilityPhrase("drill.run")}.`));
  }
}

// renderDrillResult paints the drill verdict (the break-glass branch is handled by the
// caller's shared paintBreakGlass). The verdict surface is in view, so no toast echoes it.
function renderDrillResult(host: HTMLElement, res: DrillResult): void {
  if (res.ok) {
    host.replaceChildren(
      verdictSurface({
        tone: "ok",
        title: "Restorable",
        body: `Drill verified ${groupNumber(res.recordsVerified)} records${res.sampleRestored ? "; a sample record was restored and plaintext-hash-checked" : ""}. Latest for downpipe: ${res.isLatest === false ? "no, an older run" : "yes"}.`,
      }),
    );
    return;
  }
  // Any other coarse reason is a real restorability problem, surfaced loudly.
  host.replaceChildren(
    verdictSurface({
      tone: "danger",
      title: "Drill failed",
      body: `${res.reason ?? "The drill did not complete."} This is a real restorability problem; investigate before relying on this run.`,
      assertive: true,
    }),
  );
}

// renderBlindTestResult paints the BLIND restore test verdict. A clean pass reads "N of N records
// restorable, 0 failures" with the redaction-safe restoreDigest (a hash over per-record hashes,
// never a value); the standing no-data line above the actions carries the no-data fact, so the
// verdict does not restate it and no toast echoes it. The break-glass branch is the caller's shared
// paintBreakGlass. Any other failure is a real restorability problem, surfaced loudly; the
// per-record failures list the FAILED record source names (the customer's own keys,
// redaction-safe) and a coarse reason, never a value.
function renderBlindTestResult(host: HTMLElement, res: BlindRestoreTest): void {
  if (res.ok) {
    const recs = groupNumber(res.recordsVerified);
    const body = h("div", { style: "display:grid;gap:var(--space-2)" });
    body.appendChild(
      h("p", { style: "margin:0;color:var(--text)" }, `${recs} of ${recs} records restorable, 0 failures. Every in-scope record decrypted and its plaintext hash verified; ${humanBytes(res.bytesVerified)} were read and discarded, not written.`),
    );
    // The restoreDigest: a redaction-safe hash over per-record hashes that lets a repeat test prove
    // the SAME data restores. Shown truncated with copy, like the plan hash. Absent when null.
    if (res.restoreDigest) {
      body.appendChild(
        h(
          "p",
          { class: "field__hint mono", style: "margin:0", title: res.restoreDigest },
          `Restore digest ${res.restoreDigest.slice(0, DIGEST_DISPLAY_CHARS)}…`,
          copyButton("Copy restore digest", () => res.restoreDigest ?? ""),
        ),
      );
    }
    host.replaceChildren(
      verdictSurface({
        tone: "ok",
        title: "Restorable",
        body,
      }),
    );
    return;
  }

  // A real restorability problem (a tampered or unrecoverable archive). Surface it loudly; list the
  // per-record failures by their redaction-safe source NAME and coarse reason (never a value).
  const detail = h("div", { style: "display:grid;gap:var(--space-2)" });
  const lead = res.failures.length > 0
    ? `${groupNumber(res.recordsVerified)} records verified; ${res.failures.length} could not be recovered. This run is not fully restorable; investigate before relying on it.`
    : `${res.reason ?? "The restorability test did not complete."} This is a real restorability problem; investigate before relying on this run.`;
  detail.appendChild(h("p", { style: "margin:0;color:var(--text)" }, lead));
  if (res.failures.length > 0) {
    const details = h("details", { class: "disclosure" }, h("summary", `${res.failures.length} unrecoverable records`));
    const list = h("ul", { class: "skipped-list disclosure__body" });
    for (const f of res.failures.slice(0, MAX_DISPLAY_ROWS)) {
      list.appendChild(h("li", h("span", { class: "mono" }, f.name), " ", h("span", { class: "field__hint" }, f.reason)));
    }
    details.appendChild(list);
    detail.appendChild(details);
    detail.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "The names above are the records' own source keys, never their contents; no value is shown."));
  }
  host.replaceChildren(
    verdictSurface({
      tone: "danger",
      title: "Not fully restorable",
      body: detail,
      assertive: true,
    }),
  );
}

// renderAttestationResult paints the KEYLESS integrity attestation verdict: the three checks
// (signature, completeness, anti-rollback) it proved without any key or data. A clean attestation
// reads ok with the three checks listed; a failure names the first failing check coarsely. It is the
// strongest claim available in the break-glass-only posture (it decrypts nothing), so it never shows
// a value either. The verdict is in view, so no toast echoes it.
function renderAttestationResult(host: HTMLElement, res: KeylessAttestationResult): void {
  const checks = h("ul", { style: "list-style:none;padding:0;margin:var(--space-2) 0 0;display:grid;gap:var(--space-1)" });
  // A CHECK THAT DID NOT RUN IS NOT A CHECK THAT FAILED, and the engine states which is which.
  //
  // `attestKeyless` (engine/src/format/keyless.ts) evaluates the three flags IN ORDER and short-circuits:
  // completeness (step 2) and anti-rollback (step 3) both parse the root manifest's BODY, so neither may
  // run until the root SIGNATURE has authenticated that body. Every early return therefore hard-codes
  // `complete: false, notRolledBack: false` before either check has executed -- `:146` (invalid runId),
  // `:159` (root signature did not verify) and `:166` (root manifest or signature missing, or a
  // cold storage class) -- and the file says so in its own words at `:149-152`: "the later checks are
  // NOT evaluated (a manifest we cannot trust must not have its body parsed as authoritative), so they
  // report false too". The invariant is exact across all five returns: `signatureValid === false` implies
  // the other two are placeholders and carry NO evidence. The only other false-completeness return,
  // `:182` (a structurally invalid but correctly SIGNED run), carries `signatureValid: true`, so its
  // false IS genuine and must still read failed; `:293` is the normal path where all three are real.
  //
  // Painting those placeholders as "failed" turned a mistyped run id into three security assertions about
  // checks that never happened: that the archive's signature is invalid, that a shard is MISSING, and that
  // the archive has been ROLLED BACK, inside an assertive danger surface. Anti-rollback is a tamper
  // indicator, so a false alarm on it is its own harm: it sends an operator to a data-loss incident when
  // the truth is a typo. Where the product cannot tell, it must say so; a could-not-check outranks a pass,
  // and here it must also outrank a FAILURE.
  //
  // "Signature valid" itself still reads failed when it is false, because that check DID run and that is
  // the one thing the engine actually established.
  const laterChecksRan = res.signatureValid;
  checks.appendChild(attestCheckRow("Signature valid", res.signatureValid ? "pass" : "fail"));
  checks.appendChild(attestCheckRow("Complete (no missing shard)", !laterChecksRan ? "not-checked" : res.complete ? "pass" : "fail"));
  checks.appendChild(attestCheckRow("Not rolled back", !laterChecksRan ? "not-checked" : res.notRolledBack ? "pass" : "fail"));

  if (res.ok) {
    const body = h("div", { style: "display:grid;gap:var(--space-1)" });
    body.appendChild(h("p", { style: "margin:0;color:var(--text)" }, "The run's signature, completeness and anti-rollback all verified, with no decryption key and no record data touched."));
    body.appendChild(checks);
    host.replaceChildren(verdictSurface({ tone: "ok", title: "Integrity attested (keyless)", body }));
    return;
  }

  const body = h("div", { style: "display:grid;gap:var(--space-1)" });
  body.appendChild(h("p", { style: "margin:0;color:var(--text)" }, res.reason ?? "The keyless attestation did not pass. Investigate before relying on this run."));
  body.appendChild(checks);
  // The title is announced on its own by an assertive live region, so the qualification has to be in the
  // body as a sentence and not only in the hollow dots above: an operator who hears "Integrity attestation
  // failed" and reads no further must not carry away that a shard is missing and the archive was rolled
  // back. Painted only where it is true, so a genuine completeness or anti-rollback shortfall (which
  // arrives with signatureValid TRUE) keeps the unqualified failure it has earned.
  if (!laterChecksRan) {
    body.appendChild(
      h(
        "p",
        { style: "margin:0;color:var(--text-muted)" },
        "Only the signature check ran. Completeness and anti-rollback both read the root manifest's contents, so neither could be evaluated once the signature did not pass, and nothing here says a shard is missing or that this run was rolled back.",
      ),
    );
  }
  host.replaceChildren(verdictSurface({ tone: "danger", title: "Integrity attestation failed", body, assertive: true }));
}

// AttestCheckState is the THREE states a keyless attestation check can be in, not two. "not-checked" is
// the state the engine's short-circuit actually leaves the later two checks in whenever the root signature
// did not pass (see renderAttestationResult above), and it was previously indistinguishable from "fail".
type AttestCheckState = "pass" | "fail" | "not-checked";

// attestCheckRow is one line in the keyless attestation verdict (hue + shape + label, never colour alone),
// reused for each of the three checks. The shape carries the state as well as the hue: ok is a filled
// circle, fail a square, and not-checked the HOLLOW neutral dot (tokens.css `.dot--neutral`), which is the
// same marker this console already uses everywhere else for "we have nothing to report here", so a reader
// who cannot see colour still reads three distinct states rather than two.
function attestCheckRow(label: string, state: AttestCheckState): HTMLElement {
  const dot = state === "pass" ? "ok" : state === "fail" ? "danger" : "neutral";
  const text = state === "pass" ? label : state === "fail" ? `${label}: failed` : `${label}: not checked`;
  return h(
    "li",
    { style: "display:flex;gap:var(--space-2);align-items:center" },
    h("span", { class: `dot dot--${dot}`, "aria-hidden": "true", style: "flex:none" }),
    h("span", text),
  );
}

// restorabilityErrorBlock classifies a verify/attest transport fault. The engine answers 200 with
// ok:false for an in-flow failure (handled above), so a non-2xx here is an auth/transport fault or a
// per-caller rate limit (these are mutating POSTs the engine rate-limits like the dry-run); either
// way an inline block error with Retry is the honest surface, and no operator input is lost.
function restorabilityErrorBlock(err: unknown, retry: () => void): HTMLElement {
  return blockError(err, retry, { origin: location.origin });
}
