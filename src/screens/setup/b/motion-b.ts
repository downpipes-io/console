// Focus Flow motion. A question change is a route change. The shell runs other route changes inside a
// document view transition, but Chromium sends every pointer event to the root element while one runs, so a
// click made during the change is lost (contract requirement 21: never block input). The setup page therefore
// owns its motion (data-motion-owner on its root; shell/app-shell.ts setMain swaps it at once) and animates
// elements with the Web Animations API, so the new question is live and clickable from its first frame:
//
//   - the outgoing head and answer: a clone, inert and hidden from assistive technology, fixed where they
//     were, shifts 12 px and fades in --dur-1, then is removed;
//   - the incoming head rises and fades in --dur-2, the answer and the action row follow one stagger later
//     (DOM order, two groups); the plan column stays put;
//   - the plan's current-line marker and the progress fill slide from where they were (FLIP, translate or
//     scale on a non-text element only);
//   - "the answer travels": a one-line copy of the chosen tile's title moves into its plan line (translate
//     only, never stretched) while the line's value fades in;
//   - at Finish, the plan column travels from the right into the stage and becomes the receipt.
//
// Every entry point checks motionOK() and feature-detects element.animate, so reduced motion (and the Node DOM
// shim) gets the same end state with no motion at all.

import { durationMs, easing, motionOK } from "../../../lib/motion.ts";
import type { LineId } from "./types.ts";

type Anim = Element & { animate: Element["animate"] };
const canAnimate = (el: Element | null): el is Anim => el !== null && typeof (el as { animate?: unknown }).animate === "function";

interface Pending {
  back: boolean;
  eyebrow: string;
  marker: DOMRect | null;
  fill: number | null;
  flight: { rect: DOMRect; text: string; line: LineId } | null;
  plan: DOMRect | null;
}

let pending: Pending | null = null;
let launched: Pending["flight"] = null;
let flightLine: LineId | null = null;
let flightTarget: HTMLElement | null = null;

function place(el: HTMLElement, r: DOMRect): void {
  el.style.setProperty("position", "fixed");
  el.style.setProperty("left", `${r.left}px`);
  el.style.setProperty("top", `${r.top}px`);
  el.style.setProperty("width", `${r.width}px`);
  el.style.setProperty("margin", "0");
}

// leave fades out a copy of the outgoing parts, so the old question never blanks before it moves.
function leave(parts: HTMLElement[], back: boolean): void {
  if (parts.length === 0 || typeof document === "undefined") return;
  const overlay = document.createElement("div");
  overlay.className = "fb-leaving";
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  const clones: HTMLElement[] = [];
  for (const el of parts) {
    const r = el.getBoundingClientRect();
    const c = el.cloneNode(true) as HTMLElement;
    for (const n of [c, ...Array.from(c.querySelectorAll<HTMLElement>("[id],[name]"))]) {
      n.removeAttribute("id");
      n.removeAttribute("name");
    }
    // The eyebrow stays put on the live page (it changes only between steps), so the copy leaves it out.
    for (const e of Array.from(c.querySelectorAll<HTMLElement>(".fb-eyebrow"))) e.style.setProperty("visibility", "hidden");
    place(c, r);
    overlay.appendChild(c);
    clones.push(c);
  }
  document.body.appendChild(overlay);
  const d = durationMs("--dur-1");
  const dy = back ? 12 : -12;
  const done: Array<Promise<unknown>> = [];
  for (const c of clones) {
    if (!canAnimate(c)) continue;
    try {
      // Opacity drops early (--ease-emph) so the old and new headlines are barely ever both legible; the
      // shift takes the exit curve.
      done.push(c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d, easing: easing("--ease-emph"), fill: "forwards" }).finished);
      c.animate([{ transform: "none" }, { transform: `translateY(${dy}px)` }], { duration: d, easing: easing("--ease-exit"), fill: "forwards" });
    } catch {
      // No animation: the copy is removed below.
    }
  }
  const remove = (): void => overlay.remove();
  void Promise.allSettled(done).then(remove);
  setTimeout(remove, d + 200);
}

// beginChange runs just before a question change: it copies the outgoing question and notes where the
// moving pieces are now.
export function beginChange(root: HTMLElement, opts: { back: boolean; toReceipt: boolean }): void {
  pending = null;
  if (!motionOK() || typeof root.getBoundingClientRect !== "function") return;
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  const parts = [q<HTMLElement>(".fb-stage .fb-head"), q<HTMLElement>(".fb-stage .fb-answer")].filter((x): x is HTMLElement => x !== null);
  const planBody = q<HTMLElement>(".fb-plan .fb-plan__body");
  if (opts.toReceipt && planBody) parts.push(planBody);
  leave(parts, opts.back);
  const fillEl = q<HTMLElement>(".fb-progress__fill");
  const fill = fillEl ? Number(fillEl.style.getPropertyValue("--fb-fill")) : null;
  pending = {
    back: opts.back,
    eyebrow: q<HTMLElement>(".fb-eyebrow")?.textContent ?? "",
    marker: q<HTMLElement>(".fb-marker")?.getBoundingClientRect() ?? null,
    fill: fill !== null && Number.isFinite(fill) ? fill : null,
    flight: launched,
    plan: opts.toReceipt && planBody ? planBody.getBoundingClientRect() : null,
  };
  launched = null;
}

// launchFlight records the chosen answer before the navigation that commits it.
export function launchFlight(el: HTMLElement | null, line: LineId): void {
  launched = null;
  flightLine = null;
  if (el === null || !motionOK() || typeof el.getBoundingClientRect !== "function") return;
  launched = { rect: el.getBoundingClientRect(), text: (el.textContent ?? "").trim(), line };
  flightLine = line;
}

// takeFlight returns the plan line the pending answer lands on, once (the new page's plan asks for it).
export function takeFlight(): LineId | null {
  const l = flightLine;
  flightLine = null;
  return l;
}

// landFlight names the plan value the answer lands on.
export function landFlight(el: HTMLElement | null): void {
  flightTarget = el;
}

function arrive(el: Element | null, delay: number, dy: number, dur: "--dur-1" | "--dur-2"): void {
  if (!canAnimate(el)) return;
  try {
    el.animate([{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: "none" }], { duration: durationMs(dur), delay, easing: easing("--ease-emph"), fill: "backwards" });
  } catch {
    // No animation: the element is already in its end state.
  }
}

// finishChange runs once the new question is mounted: the incoming groups arrive in DOM order, and the
// marker, the progress fill and the travelling answer move from where they were.
export function finishChange(root: HTMLElement): void {
  const p = pending;
  pending = null;
  const target = flightTarget;
  flightTarget = null;
  if (p === null || !motionOK()) return;
  const stagger = Math.round(durationMs("--dur-1") / 3);
  const dy = p.back ? -12 : 12;
  // The head arrives without its eyebrow, which only cross-fades, and only when the step changed.
  for (const el of Array.from(root.querySelectorAll(".fb-stage .fb-head > :not(.fb-eyebrow)"))) arrive(el, stagger, dy, "--dur-2");
  const eyebrow = root.querySelector(".fb-stage .fb-eyebrow");
  if (eyebrow && eyebrow.textContent !== p.eyebrow) arrive(eyebrow, 0, 0, "--dur-1");
  arrive(root.querySelector(".fb-stage .fb-answer"), stagger * 2, dy, "--dur-2");
  arrive(root.querySelector(".fb-actions__row"), stagger * 2, 0, "--dur-1");
  const dur2 = durationMs("--dur-2");
  const marker = root.querySelector<HTMLElement>(".fb-marker");
  if (p.marker && canAnimate(marker)) {
    const now = marker.getBoundingClientRect();
    const d = p.marker.top - now.top;
    if (d !== 0 && Math.abs(d) < 600) marker.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: dur2, easing: easing("--ease-emph") });
  }
  const fill = root.querySelector<HTMLElement>(".fb-progress__fill");
  const to = fill ? Number(fill.style.getPropertyValue("--fb-fill")) : NaN;
  if (p.fill !== null && canAnimate(fill) && Number.isFinite(to) && to !== p.fill) {
    fill.animate([{ transform: `scaleX(${p.fill})` }, { transform: `scaleX(${to})` }], { duration: dur2, easing: easing("--ease-emph") });
  }
  if (p.plan) {
    // The plan travels from its column into the stage and becomes the receipt.
    const receipt = root.querySelector<HTMLElement>(".fb-receipt-plan");
    if (canAnimate(receipt)) {
      const now = receipt.getBoundingClientRect();
      receipt.animate([{ opacity: 0, transform: `translate(${p.plan.left - now.left}px, ${p.plan.top - now.top}px)` }, { opacity: 1, transform: "none" }], { duration: durationMs("--dur-3"), easing: easing("--ease-emph"), fill: "backwards" });
    }
  }
  if (p.flight && target && typeof document !== "undefined") fly(p.flight, target);
}

// A travel longer than this cross-fades in place instead: the plan line's value fades in and nothing crosses
// the page. Measured in review: a provider change swept 991 px in 280 ms, the largest movement in the flow.
const MAX_FLIGHT_PX = 400;

// fly moves a one-line copy of the chosen answer into its plan line. Translate only: the text is never
// stretched between two shapes. The line's own value fades in as the copy arrives.
function fly(f: NonNullable<Pending["flight"]>, target: HTMLElement): void {
  const to = target.getBoundingClientRect();
  if (Math.hypot(to.left - f.rect.left, to.top - f.rect.top) > MAX_FLIGHT_PX) {
    if (canAnimate(target)) {
      try {
        target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: durationMs("--dur-2"), easing: easing("--ease-emph") });
      } catch {
        // No animation: the value is already shown.
      }
    }
    return;
  }
  const copy = document.createElement("span");
  copy.className = "fb-flight";
  copy.setAttribute("aria-hidden", "true");
  copy.textContent = f.text;
  copy.style.setProperty("position", "fixed");
  copy.style.setProperty("left", `${f.rect.left}px`);
  copy.style.setProperty("top", `${f.rect.top}px`);
  document.body.appendChild(copy);
  const d = durationMs("--dur-3");
  const remove = (): void => copy.remove();
  setTimeout(remove, d + 200);
  if (!canAnimate(copy) || !canAnimate(target)) {
    remove();
    return;
  }
  try {
    copy.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translate(${to.left - f.rect.left}px, ${to.top - f.rect.top}px)`, opacity: 1, offset: 0.7 },
        { transform: `translate(${to.left - f.rect.left}px, ${to.top - f.rect.top}px)`, opacity: 0 },
      ],
      { duration: d, easing: easing("--ease-emph"), fill: "forwards" },
    ).finished.then(remove, remove);
    target.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: d, easing: easing("--ease-emph") });
  } catch {
    remove();
  }
}
