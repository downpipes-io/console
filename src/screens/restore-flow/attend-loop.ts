// Attended-verification runner: the progress panel, the completion summary and the small pure helpers,
// split out of attend.ts so the coordinator stays under the size budget. Attended verification is the
// offline-key-only posture's IN-PLATFORM proof path (the client drives the loop). This module owns only the
// PRESENTATION of the loop's progress + result; the crypto orchestration (recover each run's master in the
// browser, hand only that single-run master to the engine, forget it) lives in the coordinator. No value and
// no key ever enters a row here: a row carries a downpipe name, a run id, a phase and counts only. House
// rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { badge } from "../../components/status.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { groupNumber } from "../../lib/format.ts";
import { ICON_SHIELD_CHECK } from "../../lib/icons.ts";
import { navigate } from "../../lib/nav.ts";
import type { AttestProgress, AttestSessionRun } from "../../api.ts";

// BATCH_SIZE is how many runs the loop processes per round trip (fetch capsules, recover masters locally,
// verify). Ten keeps each request modest and lets the progress panel advance in visible increments on a
// large fleet, while amortising the per-request overhead. Exported so the coordinator and a test agree.
export const BATCH_SIZE = 10;

// AttendPhase is one run's coarse state in the progress panel. "verifying" is the CONSOLE's transient state
// while a batch is in flight (the engine only ever persists pending / verified / failed / skipped); "failed"
// covers both a local key-recovery failure (the selected identity.key could not open this run) and an engine
// verify failure (a sampled record did not decrypt-and-verify). "skipped" is a run the engine resolved
// without ever running the verify itself (AttestRunState mirror, api/types/attest.ts): the live loop never
// sets it (a fresh session's runs all come from a batch verify, which only ever answers verified/failed),
// but a RESUMED session can read one back from the engine's status, and it must render as its own state
// rather than vanishing from the panel or reading as still-pending.
export type AttendPhase = "pending" | "verifying" | "verified" | "failed" | "skipped";

// AttendRunDetail carries the optional counts + reason a row shows once a run resolves. recordsVerified /
// recordsTotal are the sampled-verified subset out of the run's total (honest about how much was exercised);
// reason is a coarse, redaction-safe cause on a failure (never a value).
export interface AttendRunDetail {
  recordsVerified?: number;
  recordsTotal?: number;
  failures?: number;
  reason?: string;
}

// AttendProgressPanel is the built panel plus the imperative handles the coordinator drives: setPhase repaints
// one run's row, and setTally repaints the header counts from the engine's own progress figure.
export interface AttendProgressPanel {
  el: HTMLElement;
  setPhase(runId: string, phase: AttendPhase, detail?: AttendRunDetail): void;
  setTally(progress: AttestProgress): void;
}

// phaseChip maps a phase to the console's hue + shape + label chip (never colour alone): pending neutral,
// verifying info, verified ok, failed danger, skipped warn (resolved WITHOUT a pass/fail verdict, which is
// worth a second look, unlike an ordinary still-pending row).
function phaseChip(phase: AttendPhase): HTMLElement {
  switch (phase) {
    case "pending": return badge("neutral", "Pending", { dot: true });
    case "verifying": return badge("info", "Verifying", { dot: true });
    case "verified": return badge("ok", "Verified", { dot: true });
    case "failed": return badge("danger", "Failed", { dot: true });
    case "skipped": return badge("warn", "Skipped", { dot: true });
  }
}

// detailLine builds the per-run second line: the sampled-verified count out of the run's total when known,
// then a coarse failure reason when present. Counts only; no value.
function detailLine(phase: AttendPhase, detail: AttendRunDetail | undefined): string {
  if (phase === "skipped") return "The engine resolved this run without verifying it; it was not proven restorable this session.";
  if (!detail) return phase === "pending" ? "Waiting to verify." : phase === "verifying" ? "Recovering the run key in your browser and verifying a sample." : "";
  const parts: string[] = [];
  if (typeof detail.recordsVerified === "number" && typeof detail.recordsTotal === "number") {
    parts.push(`${groupNumber(detail.recordsVerified)} of ${groupNumber(detail.recordsTotal)} records verified`);
  }
  if (typeof detail.failures === "number" && detail.failures > 0) parts.push(`${groupNumber(detail.failures)} could not be recovered`);
  if (detail.reason) parts.push(detail.reason);
  return parts.join("; ");
}

// buildProgressPanel builds the per-run progress panel from the session's pinned runs, each a row with the
// downpipe name, the run id (mono) and a phase chip + detail line, plus a header tally the coordinator
// updates from the engine's progress figure. The rows start "pending"; the coordinator advances them.
export function buildProgressPanel(runs: AttestSessionRun[]): AttendProgressPanel {
  const tally = h("p", { class: "field__hint", style: "margin:0", "aria-live": "polite" }, `0 verified, 0 failed of ${groupNumber(runs.length)} runs.`);
  const list = h("ul", { class: "attend-runs", role: "list", style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2)" });

  // One row per run, keyed by runId, with handles to repaint the chip + detail in place.
  const rowHandles = new Map<string, { chipHost: HTMLElement; detailEl: HTMLElement }>();
  for (const run of runs) {
    const chipHost = h("span", phaseChip("pending"));
    const detailEl = h("span", { class: "field__hint", style: "margin:0" }, detailLine("pending", undefined));
    const row = h(
      "li",
      { class: "attend-run", style: "display:grid;gap:2px;padding:var(--space-2);border:1px solid var(--border);border-radius:var(--radius-sm)" },
      h(
        "div",
        { style: "display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap" },
        h("span", { style: "display:grid;gap:2px" }, h("span", run.name), h("span", { class: "mono field__hint" }, run.runId)),
        chipHost,
      ),
      detailEl,
    );
    rowHandles.set(run.runId, { chipHost, detailEl });
    list.appendChild(row);
  }

  const el = h(
    "div",
    { style: "display:grid;gap:var(--space-3)" },
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap" }, h("h3", { style: "margin:0;font-size:var(--text-md)" }, "Verification progress"), tally),
    list,
  );

  return {
    el,
    setPhase(runId, phase, detail) {
      const handle = rowHandles.get(runId);
      if (!handle) return;
      handle.chipHost.replaceChildren(phaseChip(phase));
      handle.detailEl.textContent = detailLine(phase, detail);
    },
    setTally(progress) {
      tally.textContent = `${groupNumber(progress.verified)} verified, ${groupNumber(progress.failed)} failed of ${groupNumber(progress.total)} runs${progress.pending > 0 ? `, ${groupNumber(progress.pending)} pending` : ""}.`;
    },
  };
}

// renderAttendSummary builds the completion verdict once every pinned run has resolved. A clean pass reads
// ok and states, honestly, the sample rate it recorded (so a sub-100 sample never reads as a full proof);
// any failure reads danger and names how many runs could not be fully recovered. It links to where the
// recovery proof now shows (the downpipes screen's restorability read), so the operator can see the stamp
// the pass recorded. Counts only; no value, no key.
export function renderAttendSummary(progress: AttestProgress, sampleRate: number): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-3)" });
  const clean = progress.failed === 0 && progress.verified > 0;
  const sampleWord = sampleRate >= 100 ? "a full (100% sample)" : `a ${sampleRate}% record-sample`;
  const body = h("div", { style: "display:grid;gap:var(--space-2)" });
  if (clean) {
    body.appendChild(
      h("p", { style: "margin:0;color:var(--text)" }, `${groupNumber(progress.verified)} of ${groupNumber(progress.total)} runs verified with ${sampleWord} attended verification. Every sampled record was decrypted and its hash checked in your engine, then discarded; nothing was written and no record was returned.`),
    );
    if (sampleRate < 100) {
      body.appendChild(
        h("p", { class: "field__hint", style: "margin:0" }, "Because this was a partial sample, recoverability is evidenced for the sampled records only. Run a 100% attended verification to record a full proof."),
      );
    }
  } else {
    body.appendChild(
      h("p", { style: "margin:0;color:var(--text)" }, `${groupNumber(progress.verified)} of ${groupNumber(progress.total)} runs verified; ${groupNumber(progress.failed)} could not be fully recovered. Investigate the failed runs before relying on them; a failed attended verification is a real recoverability problem.`),
    );
  }
  wrap.appendChild(verdictSurface({ tone: clean ? "ok" : "danger", title: clean ? "Attended verification complete" : "Attended verification found a problem", body, assertive: !clean }));

  wrap.appendChild(
    h(
      "div",
      { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center" },
      h("button", { "data-dp": "restore-flow.button.navigate-downpipes#1", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/downpipes") } }, svgIcon(ICON_SHIELD_CHECK, { size: 14 }), "See it on your downpipes"),
      h("p", { class: "field__hint", style: "margin:0" }, "The result is recorded as this downpipe's restorability proof; your identity.key was read here and never uploaded, and each run key was forgotten after its run."),
    ),
  );
  return wrap;
}

// chunk splits an array into fixed-size batches (the last batch may be shorter). Pure; the loop uses it to
// pace the per-batch round trips.
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
