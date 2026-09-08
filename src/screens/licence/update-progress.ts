// The calm in-place progress region for the orchestrated apply flow: ONE line that REPLACES itself as each
// stage completes (never a growing list on the happy path),
// plus a collapsed "Details" disclosure carrying the full step-by-step log for support (step checklists,
// per-component rows, the verbose recorded-outcome prose) -- present but invisible by default, exactly the
// s2 contract: "todays essay" moves behind Details, never in front of the operator. Uses the repo's existing
// disclosure idiom unchanged (<details class="disclosure"><summary>...<div class="disclosure__body">, the
// same shape update-ramp.ts / update-components-advanced.ts already use), so it matches every other
// collapsed section on this screen. House rules: Australian English, no em dashes.

import { h } from "../../lib/dom.ts";

// ProgressRegion is the small DOM handle the orchestrated flow drives: setStage for each of the s2 progress
// strings (with the optional "this can take a minute" subline), setTerminal for the flow's one terminal or
// stall sentence, and detail() to push the old verbose log into the collapsed disclosure rather than the
// visible line.
export interface ProgressRegion {
  // root is what the caller mounts (out.replaceChildren(region.root)): the visible line + subline, then the
  // collapsed Details disclosure below them.
  root: HTMLElement;
  // setStage replaces the visible line with the next s2 stage string; an optional calm subline renders
  // beneath it in the muted hint voice only while supplied, and is cleared on the next call without one.
  setStage(text: string, subline?: string): void;
  // setTerminal replaces the visible line with one of the s2 terminal/stall sentences (the caller supplies
  // the exact string; this never composes copy itself) and clears any subline.
  setTerminal(text: string): void;
  // detail appends a node into the collapsed Details body (the full log), never into the visible line.
  detail(node: Node): void;
  // append mounts a node into the VISIBLE area, after the stage line and before Details -- for content that
  // must stay visible AND interactive even though it is not the stage/terminal sentence itself (the
  // post-apply console-build-check's own banner: a real Reload button, or a real Roll back console button;
  // neither is "jargon", both are the control the operator needs next).
  append(node: Node): void;
}

// buildProgressRegion mounts a fresh progress line + Details disclosure. Called once per live flow (the
// orchestrated flow replaces env.out's children with region.root at the start and never again, only mutating
// the region's own nodes thereafter, which is what makes the flow read as ONE interactive object rather than
// a sequence of re-renders).
export function buildProgressRegion(): ProgressRegion {
  const line = h("p", { style: "color:var(--text)" });
  const subline = h("p", { class: "field__hint", style: "margin-top:var(--space-1)" });
  subline.hidden = true;
  const extra = h("div");
  const detailsBody = h("div", { class: "disclosure__body" });
  const details = h(
    "details",
    { class: "disclosure", style: "margin-top:var(--space-3)" },
    h("summary", "Details"),
    detailsBody,
  ) as HTMLDetailsElement;
  const root = h("div", line, subline, extra, details);

  return {
    root,
    setStage(text, sub) {
      line.textContent = text;
      if (sub) {
        subline.textContent = sub;
        subline.hidden = false;
      } else {
        subline.hidden = true;
        subline.textContent = "";
      }
    },
    setTerminal(text) {
      line.textContent = text;
      subline.hidden = true;
      subline.textContent = "";
    },
    detail(node) {
      detailsBody.appendChild(node);
    },
    append(node) {
      extra.appendChild(node);
    },
  };
}
