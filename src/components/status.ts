// Status dots and badges. The rule the whole product obeys: status is conveyed by colour AND shape
// AND label, never colour alone (WCAG 1.4.1). The dot encodes state with hue + shape (filled circle
// ok, hollow neutral, triangle warn, square danger); a visually-hidden text label rides alongside
// for assistive tech. "unknown" is a first-class state (never a stale green) so an unreachable
// engine reads honestly.

import { h } from "../lib/dom.ts";
import { recordWireAnomaly } from "../lib/client-diag/ring.ts";

export type StatusTone = "ok" | "warn" | "danger" | "neutral" | "info" | "trust";

// statusDot builds a dot + an accessible label. The visible text label should sit
// next to it in the calling layout; this returns the dot with a visually-hidden
// label so the dot alone is still announced.
export function statusDot(tone: StatusTone, label: string): HTMLElement {
  const wrap = h("span", { class: "status", style: "display:inline-flex;align-items:center;gap:var(--space-2)" });
  wrap.appendChild(h("span", { class: `dot dot--${tone}`, "aria-hidden": "true" }));
  wrap.appendChild(h("span", { class: "visually-hidden" }, label));
  return wrap;
}

// statusWithLabel is the common form: a dot plus the VISIBLE text label (so the
// status reads by hue + shape + text in the UI, not only to a screen reader).
export function statusWithLabel(tone: StatusTone, label: string): HTMLElement {
  return h(
    "span",
    { class: "status", style: "display:inline-flex;align-items:center;gap:var(--space-2)" },
    h("span", { class: `dot dot--${tone}`, "aria-hidden": "true" }),
    h("span", label),
  );
}

// badge builds a pill badge (compact status). The label is real text; the optional
// leading dot is decorative.
export function badge(tone: StatusTone | "default", label: string, opts: { dot?: boolean } = {}): HTMLElement {
  const cls = tone === "default" ? "badge" : `badge badge--${tone}`;
  const el = h("span", { class: cls });
  if (opts.dot && tone !== "default") el.appendChild(h("span", { class: `dot dot--${tone}`, "aria-hidden": "true", style: "margin-right:var(--space-1)" }));
  el.appendChild(h("span", label));
  return el;
}

// runStatusTone maps a run status to a tone + label (used by the runs table and the
// downpipe drawer's run strip). in-flight is a real state, not a missing row.
export function runStatusTone(status: "in-flight" | "ok" | "failed" | "abandoned"): { tone: StatusTone; label: string } {
  if (status === "ok") return { tone: "ok", label: "ok" };
  if (status === "failed") return { tone: "danger", label: "failed" };
  // "abandoned": the engine gave up on a run that never completed. It is NOT a success and it is not still
  // running, so it must not wear either of those tones: it reads as its own warn state.
  if (status === "abandoned") return { tone: "warn", label: "abandoned" };
  if (status === "in-flight") return { tone: "info", label: "in-flight" };
  // ANY OTHER VALUE IS A STATUS THIS BUILD CANNOT READ, AND IT MUST NOT BORROW A REAL RUN'S WORDS.
  //
  // On the real function: a status string this build does not know, a row whose status was absent,
  // one that arrived null and one that arrived empty ALL returned {info, "in-flight"}, byte-identical to a
  // run that is genuinely still going. That is the answer beside every run in the RESTORE RUN PICKER
  // (restore-flow/run-picker.ts, run-context.ts, date-picker.ts), the downpipe drawer's run strip
  // (sources-downpipes/detail-cells.ts) and the map drawer's recent-run list (map/panels.ts), so an operator
  // choosing what to recover from is told a run is under way when the console cannot say anything about it.
  //
  // THE FALL-THROUGH IS EXACTLY THE DEFECT THIS FUNCTION WAS ADOPTED TO CURE. map/panels.ts:250 records why
  // its recent-run list stopped re-deriving the mapping "ok / failed / else": the else arm printed the
  // visible word "in-flight" for an ABANDONED run, "the worst of the abandoned regressions, because it is
  // wrong in the text rather than only in the hue". Routing every caller through this function fixed the
  // callers and left the else arm in place here, so the same wrong word survived at the seam they were
  // routed to. The wire union has grown once already for this reason ("abandoned" was added to
  // lib/api/types/status.ts after it bit), and the engine deploys separately from the console, so a status
  // this build has not heard of is a state to expect rather than a hypothetical.
  //
  // The honest answer is neutral (this product's could-not-tell hue, never a stale green and never a
  // borrowed real state) and the word "unknown", which is the same answer classifyFreshness already gives
  // the same wire field on the map. The anomaly is recorded on the SAME closed class that seam uses, so a
  // support pack says version skew rather than leaving the coarsening silent; the VALUE never rides, because
  // an unrecognised status is precisely the value not to be trusted.
  recordWireAnomaly("status-enum", status === undefined || status === null ? "missing" : "unknown-enum");
  return { tone: "neutral", label: "unknown" };
}
