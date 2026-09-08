// The stateless chrome leaves the map view controller composes: the loading skeleton, the
// "some flows read as unknown" partial note, the honest view-status line, and the local
// environment diagnostics gather. These are pure DOM/string producers (no view state, no
// `this`): they take their inputs as parameters and return an element or a string, so the
// view controller stays the lifecycle owner while these stay testable leaves. Moved verbatim
// from view.ts for size; behaviour is unchanged.
//
// No-custody is never weakened: the diagnostics gather reads LOCAL facts only (renderer, WebGL
// availability, motion preferences, whether rAF ticks and CSS animations advance) and returns
// a paste-able block; nothing is transmitted. House rules: Australian English, no em dashes,
// precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { ICON_INFO } from "../../lib/icons.ts";
import type { FlowRecord } from "../../components/topology.ts";
import { probeWebglInfo } from "./panels.ts";

// The rAF freeze-guard window: if no animation frame arrives within this span we report the
// renderer as frozen rather than waiting indefinitely.
const RAF_FREEZE_GUARD_MS = 1500;

// The CSS animation sampling window: how long we wait before re-reading currentTime to decide
// whether an animation is advancing.
const CSS_ANIM_SAMPLE_MS = 400;

// The live renderer facts the view-status line and the diagnostics gather read at render time
// (the live-flow handle mutates its own mode if it degrades to the SVG figure after an init
// failure). Mirrors the view's MapVisual reads without coupling to the whole handle.
export interface VisualStatus {
  mode: () => "canvas2d" | "svg-fallback";
  animation: () => "animated" | "static-frame";
}

// renderLoadingSkeleton builds a skeleton of the two columns (spec section 6: a skeleton of the
// two columns, never a blank canvas). Built from the same tokens as the map; the async-region
// bar handles the poll refetch. Two stacked skeleton groups read as the source column and the
// destination column; the table skeleton sits below.
export function renderLoadingSkeleton(): HTMLElement {
  const wrap = h("div", { class: "topo topo--loading", "aria-busy": "true" });
  const cols = h("div", {
    style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--space-6);align-items:start",
  });
  const sourceCol = h("div");
  sourceCol.appendChild(h("p", { class: "section-label", style: "margin-bottom:var(--space-2)" }, "Sources"));
  sourceCol.appendChild(skeletonRows(5));
  const destCol = h("div");
  destCol.appendChild(h("p", { class: "section-label", style: "margin-bottom:var(--space-2)" }, "Destination"));
  destCol.appendChild(skeletonRows(2));
  cols.appendChild(sourceCol);
  cols.appendChild(destCol);
  wrap.appendChild(cols);
  const tableWrap = h("div", { style: "margin-top:var(--space-6)" });
  tableWrap.appendChild(h("p", { class: "section-label", style: "margin-bottom:var(--space-2)" }, "Flows"));
  tableWrap.appendChild(skeletonRows(5));
  wrap.appendChild(tableWrap);
  return wrap;
}

// unknownNote (spec section 6): when SOME flows could not be resolved to a real status (history
// unavailable, or the whole status read failed), say so plainly so the "unknown" edges are
// explained rather than read as a fault. Returns null when there is nothing to say (no unknown
// flows). historyOk distinguishes "history could not be read" from "no readable run yet".
export function unknownNote(unknownCount: number, historyOk: boolean): HTMLElement | null {
  if (unknownCount <= 0) return null;
  if (!historyOk) {
    const note1 = h("p", { class: "field__hint", role: "note", style: "margin-top:var(--space-2)" });
    note1.appendChild(svgIcon(ICON_INFO, { size: 13 }));
    note1.appendChild(document.createTextNode(` Run history could not be read, so ${unknownCount} ${unknownCount === 1 ? "flow reads" : "flows read"} as unknown. The map shows their configuration; freshness will return when the engine is reachable.`));
    return note1;
  }
  const note2 = h("p", { class: "field__hint", role: "note", style: "margin-top:var(--space-2)" });
  note2.appendChild(svgIcon(ICON_INFO, { size: 13 }));
  note2.appendChild(document.createTextNode(` ${unknownCount} ${unknownCount === 1 ? "flow has" : "flows have"} no readable run yet, so ${unknownCount === 1 ? "it reads" : "they read"} as unknown rather than a stale green.`));
  return note2;
}

// viewStatusLine is the honest view-status line: which renderer is actually live and whether it
// is animating, stated in one quiet sentence so "the map looks dead" is diagnosable from a
// screenshot (a string of walkthrough findings came down to silently degraded state - static
// frame via a motion preference, the SVG fallback after a GL failure - that nothing on the
// screen admitted to). onCopyDiagnostics wires the escape hatch from guessing: one click
// captures the LOCAL environment facts as a paste-able block (read in this browser, copied to
// the operator's own clipboard; nothing is transmitted, no-custody).
export function viewStatusLine(visual: VisualStatus, onCopyDiagnostics: () => void): HTMLElement {
  const mode = visual.mode();
  const anim = visual.animation();
  let viewText: string;
  if (mode === "canvas2d") {
    viewText =
      anim === "animated"
        ? "View: live flow, animated."
        : "View: live flow, static frame (reduced motion; set Motion to Full in Settings to animate).";
  } else {
    // The actionable read for the fallback: WHY the live view is off and the one switch that
    // usually brings it back (the walkthrough finding: a browser with graphics acceleration off
    // showed a still diagram with nothing admitting why).
    viewText =
      "View: SVG topology. Canvas rendering is unavailable in this browser, so the full live view is off; in Chrome, check Settings, System, \"Use graphics acceleration\", and any extension that blocks canvas.";
  }
  return h(
    "p",
    { class: "field__hint", style: "margin-top:var(--space-2);display:flex;align-items:baseline;gap:var(--space-3);flex-wrap:wrap" },
    h("span", viewText),
    h(
      "button",
      { "data-dp": "map.button.copy-diagnostics", class: "linklike", type: "button", on: { click: onCopyDiagnostics } },
      "Copy view diagnostics",
    ),
  );
}

// filteredEmptyNote explains a filtered-to-nothing result: the component still renders its
// empty state + empty table, but this says it is the FILTER, not an empty account, with a Clear
// affordance (so data never seems to have vanished). onClearAll clears
// every filter.
export function filteredEmptyNote(onClearAll: () => void): HTMLElement {
  return h(
    "div",
    { class: "card card--inset", style: "margin-top:var(--space-2)" },
    h("p", "No flows match the current filter."),
    h(
      "button",
      { "data-dp": "map.button.clear-all#2", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)", on: { click: onClearAll } },
      "Clear filters",
    ),
  );
}

// emptyAccountCta is the onboarding link beneath the component's own empty-state copy (the
// component states what the map is; the screen owns the next action, since the component imports
// no router). Shown only when the account is genuinely empty (no downpipes at all). ONE CTA, the
// canonical Sources-first step (the same one the Downpipes empty state teaches): a downpipe's
// editor has nothing to bind until a source is attached. onChoose navigates to the Sources step.
export function emptyAccountCta(onChoose: () => void): HTMLElement {
  return h(
    "div",
    { style: "margin-top:var(--space-4)" },
    h(
      "button",
      { "data-dp": "map.button.choose", class: "btn btn--primary btn--sm", type: "button", on: { click: onChoose } },
      "Choose what to protect",
    ),
  );
}

// gatherDiagnostics collects the redaction-safe environment facts that decide what this map can
// show, samples real motion (two rAF ticks; CSS animation currentTime advance), and returns the
// paste-able block. Built after a day of remote guessing about a frozen map: one paste of this
// block names the culprit (no WebGL, an emulated/forced reduced-motion state, a frozen rAF, an
// extension freezing animations) without another round trip. Local reads only; the caller
// chooses where the text goes (clipboard or a prompt fallback).
export async function gatherDiagnostics(flows: FlowRecord[], visual: VisualStatus | null): Promise<string> {
  const lines: string[] = [];
  try {
    lines.push(`downpipes map diagnostics ${new Date().toISOString()}`);
    lines.push(`url: ${location.href}`);
    lines.push(`ua: ${navigator.userAgent}`);
    lines.push(`renderer: mode=${visual ? visual.mode() : "(no visual)"} animation=${visual ? visual.animation() : "-"}`);
    lines.push(`webgl: ${probeWebglInfo()}`);
    lines.push(`canvas2d: ${(() => { try { return document.createElement("canvas").getContext("2d") !== null ? "available" : "unavailable"; } catch { return "error"; } })()}`);
    lines.push(`prefers-reduced-motion: ${typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : "unknown"}`);
    lines.push(`data-motion attr: ${document.documentElement.getAttribute("data-motion") ?? "(unset: System)"}`);
    lines.push(`data-theme attr: ${document.documentElement.getAttribute("data-theme") ?? "(unset: System or pre-paint script blocked)"}`);
    const statusTally = new Map<string, number>();
    for (const f of flows) statusTally.set(f.status, (statusTally.get(f.status) ?? 0) + 1);
    lines.push(`flows: ${flows.length} (${[...statusTally.entries()].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}); running: ${flows.filter((f) => f.running).length}`);
    lines.push(`requestAnimationFrame: ${await probeRaf()}`);
    lines.push(await probeCssAnimations());
  } catch (err) {
    lines.push(`diagnostics error: ${String(err)}`);
  }
  return lines.join("\n");
}

// probeRaf reports whether requestAnimationFrame actually ticks, and how far apart two frames
// are (or that it is frozen if no frame arrives within the freeze-guard window).
async function probeRaf(): Promise<string> {
  return new Promise<string>((resolve) => {
    if (typeof requestAnimationFrame !== "function") return resolve("api unavailable");
    let settled = false;
    const guard = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(`frozen (no frame within ${RAF_FREEZE_GUARD_MS}ms)`);
      }
    }, RAF_FREEZE_GUARD_MS);
    requestAnimationFrame((t0) =>
      requestAnimationFrame((t1) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(guard);
        resolve(`ticking (${Math.max(0, Math.round(t1 - t0))}ms between frames)`);
      }),
    );
  });
}

// probeCssAnimations reports whether CSS animations exist on this page and whether the first one
// advances over the sampling window (a frozen animation names an extension or a forced
// reduced-motion state).
async function probeCssAnimations(): Promise<string> {
  if (typeof document.getAnimations !== "function") return "css animations: getAnimations api unavailable";
  const anims = document.getAnimations();
  const sample = anims[0];
  const before = sample ? Number(sample.currentTime ?? 0) : 0;
  await new Promise((r) => window.setTimeout(r, CSS_ANIM_SAMPLE_MS));
  const after = sample ? Number(sample.currentTime ?? 0) : 0;
  return `css animations: ${anims.length} on page${sample ? `; first ${after > before ? "ADVANCING" : "FROZEN"} (${Math.round(before)} -> ${Math.round(after)}ms)` : ""}`;
}
