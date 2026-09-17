// The client-side death PREVIEW: a pure illustration so an operator can watch the bird fly, fail and
// die without waiting for, or causing, a real one. None of this is ever sent to or from the engine.

import { h } from "../lib/dom.ts";
import type { CanaryView, CanaryAspectResult, CanaryCheck, CanaryDestView, CanaryFlight } from "../api.ts";
import { CANARY_COPY } from "./canary-copy.ts";

// simulatedDeadView fabricates a redaction-safe "dead" view for the client-side preview: the path
// works up to the byte check, then a few records diverge and the canary dies, which is exactly what a
// real death looks like. It is never sent to or from the engine; it only drives the illustration.
export function simulatedDeadView(view: CanaryView): CanaryView {
  const at = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
  const runSeq = view.runSeq + 1;
  const deadAspects: CanaryAspectResult[] = [
    { key: "write-probe", outcome: "pass", detail: "the destination accepted and returned a probe object" },
    { key: "delete-probe", outcome: "pass", detail: "the destination allowed the probe object to be deleted" },
    { key: "seal", outcome: "pass", detail: "sealed 7 records (1503 bytes) to the canary cell" },
    { key: "read-signature", outcome: "pass", detail: "the root and shard manifest signatures verified" },
    { key: "runlog-freshness", outcome: "pass", detail: "the RUNLOG entry verified fresh and chained" },
    { key: "decrypt-integrity", outcome: "fail", detail: "3 of 7 records diverged; 47 bytes strayed from the known corpus" },
    { key: "restore", outcome: "skip", detail: "not reached: the flight stopped at the integrity failure" },
    { key: "restore-verify", outcome: "skip", detail: "not reached: the flight stopped at the integrity failure" },
  ];
  // delete-probe records a note, not a pass, on an alive destination: an immutable (WORM) bucket
  // refuses the delete and the canary notes it rather than failing the flight, matching toneForAspect
  // and the real canary semantics. Every other aspect passes on an alive destination.
  const aliveAspects: CanaryAspectResult[] = CANARY_COPY.aspects.map((spec) => ({
    key: spec.key,
    outcome: spec.key === "delete-probe" ? "note" : "pass",
    detail: spec.key === "delete-probe" ? "the destination is immutable; the probe object could not be deleted, which is noted, not failed" : spec.proves,
  }));
  // Use the real destinations if any, else a single default, and kill the LAST one (so a multi-
  // destination canary shows a mixed result: most alive, one dead).
  const base: CanaryDestView[] = view.dests.length > 0 ? view.dests : [{ destinationId: null, label: "Default destination", isDefault: true, status: "pending", lastRunAt: null, deadSince: null, lastCheck: null }];
  const results: CanaryCheck[] = base.map((d, i) => {
    const dead = i === base.length - 1;
    return { at, ok: !dead, status: dead ? "dead" : "alive", durationMs: dead ? 1840 : 1200, destinationId: d.destinationId, runSeq, aspects: dead ? deadAspects : aliveAspects, byteDelta: dead ? 47 : 0, deadReason: dead ? "decrypt-integrity: 47 bytes strayed from the known data" : null };
  });
  const dests: CanaryDestView[] = base.map((d, i) => {
    const dead = i === base.length - 1;
    return { ...d, status: dead ? "dead" : "alive", lastRunAt: at, deadSince: dead ? at : null, lastCheck: results[i]! };
  });
  const flight: CanaryFlight = { at, runSeq, status: "dead", results };
  return { ...view, status: "dead", lastRunAt: at, runSeq, inFlight: false, dests, history: [...view.history, flight].slice(-48) };
}

// simBanner is the unmistakable "this is a demo" strip shown above a simulated preview, with the way out.
export function simBanner(exit: () => void): HTMLElement {
  const exitBtn = h("button", { "data-dp": "canary-sim.button.exit", class: "btn btn--secondary btn--sm", type: "button" }, "Exit preview");
  exitBtn.addEventListener("click", exit);
  return h(
    "section",
    { class: "card", style: "display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);background:var(--warn-bg, #fdf6e7);border-color:var(--warn-border, #f0d9a8)" },
    h("span", { style: "color:var(--warn-fg, #7a560a);font-size:var(--text-sm)" }, "Simulated preview: a demonstration only. It is not a real flight and does not affect the live canary."),
    exitBtn,
  );
}
