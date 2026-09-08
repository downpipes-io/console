// The onboarding carousel CHASSIS: the static DOM scaffolding for the rotating card deck (the slim
// top bar, the chapter progress rail, the perspective stage with side chevrons, and the per-card
// shells). These are pure builders factored out of renderCarousel for size; each takes the live
// callbacks it needs (chapter jumps) and returns the elements plus the handles the navigation
// closures drive. No behaviour lives here; the logic is moved verbatim from carousel.ts. House
// rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { brandMark } from "../../shell/brand.ts";
import { ICON_LOCK, ICON_CHECK, ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT } from "../../lib/icons.ts";
import { themeControl } from "./shared.ts";
import type { CardDef } from "./shared.ts";

/** Minimum horizontal pointer travel, in pixels, before a drag counts as a deck swipe. */
const SWIPE_THRESHOLD_PX = 60;

/** The slim top bar: brand, the per-card trust line, an explicit way out, and the live theme control. */
export function buildTopBar(initialCustody: string): { bar: HTMLElement; custodyText: HTMLElement } {
  const custodyText = h("span", { class: "ob-top__custody-text" }, initialCustody);
  const exit = h("button", { "data-dp": "onboarding.button.exit", class: "linklike", type: "button", style: "margin-left:var(--space-3)" }, "Back to the console");
  exit.addEventListener("click", () => navigate("/"));
  const bar = h(
    "div",
    { class: "ob-top" },
    brandMark({ size: 22 }),
    h("p", { class: "ob-top__custody" }, svgIcon(ICON_LOCK, { size: 15 }), custodyText),
    exit,
    themeControl(),
  );
  return { bar, custodyText };
}

/** The chapter progress rail (the clickable chapter dots plus the fill track). */
export function buildChapterRail(
  chapters: readonly string[],
  chapterStart: number[],
  go: (i: number) => void,
): { rail: HTMLElement; chapterBtns: HTMLButtonElement[]; fill: HTMLElement } {
  const chaptersOl = h("ol", { class: "cx-chapters" });
  const chapterBtns: HTMLButtonElement[] = [];
  chapters.forEach((name, k) => {
    const btn = h(
      "button",
      { "data-dp": "onboarding.button.go", class: "cx-chapter", type: "button" },
      h("span", { class: "cx-chapter__dot" }, svgIcon(ICON_CHECK, { size: 10 })),
      h("span", { class: "cx-chapter__label" }, name),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => go(chapterStart[k]!));
    chapterBtns.push(btn);
    chaptersOl.appendChild(h("li", {}, btn));
  });
  const fill = h("div", { class: "cx-fill" });
  const rail = h("div", { class: "cx-rail" }, chaptersOl, h("div", { class: "cx-track" }, fill));
  return { rail, chapterBtns, fill };
}

/** The deck stage and its previous/next chevrons, wrapped for layout. */
export function buildStage(): { stage: HTMLElement; stageWrap: HTMLElement; prevBtn: HTMLButtonElement; nextBtn: HTMLButtonElement } {
  const stage = h("main", { class: "cx-stage", id: "ob-main", tabindex: "-1", "aria-live": "polite" });
  const prevBtn = h("button", { "data-dp": "onboarding.button.prev", class: "cx-arrow cx-arrow--prev", type: "button", "aria-label": "Previous" }, svgIcon(ICON_CHEVRON_LEFT, { size: 20 })) as HTMLButtonElement;
  const nextBtn = h("button", { "data-dp": "onboarding.button.next", class: "cx-arrow cx-arrow--next", type: "button", "aria-label": "Next" }, svgIcon(ICON_CHEVRON_RIGHT, { size: 20 })) as HTMLButtonElement;
  const stageWrap = h("div", { class: "cx-stage-wrap" }, prevBtn, stage, nextBtn);
  return { stage, stageWrap, prevBtn, nextBtn };
}

/** The card shells (one per card; content mounts lazily on first enter). */
export function buildCardShells(cards: readonly CardDef[], stage: HTMLElement): HTMLElement[] {
  return cards.map((card) => {
    const el = h("article", { class: `cx-card${card.id === "welcome" || card.id === "done" ? " cx-card--hero" : ""}`, tabindex: "-1" });
    el.dataset.pos = "hidden";
    el.appendChild(h("div", { class: "cx-card__in" }));
    stage.appendChild(el);
    return el;
  });
}

/** The presentational half of a layout pass: the card stack positions, the progress fill, the
 *  chapter rail state, and the custody line for the current card. The caller still drives the
 *  lazy mount, the nav buttons, and focus, which read closure state. Moved verbatim.
 *
 *  chapterDone reports whether a chapter's GATED cards actually passed (the deck's real gate
 *  state, the same data that blocks Next). A tick is position AND proof: a chapter behind the
 *  current card whose gate is still unmet (a deep link past it, say) must never read as done. */
export function applyLayout(
  cards: readonly CardDef[],
  current: number,
  refs: { els: HTMLElement[]; fill: HTMLElement; chapterBtns: HTMLButtonElement[]; chapterStart: number[]; custodyText: HTMLElement },
  chapterDone: (k: number) => boolean,
): void {
  refs.els.forEach((el, i) => {
    const d = i - current;
    el.dataset.pos = d < 0 ? "-1" : d > 3 ? "hidden" : String(d);
    const front = d === 0;
    el.setAttribute("aria-hidden", front ? "false" : "true");
    // The training walk's anchor follows the card the learner is actually on. The deck as a whole carries
    // data-tour-id="onboarding-deck", which is the right subject for a rail beside a desktop screen and the
    // wrong one on a phone: it is very nearly the whole viewport, so the course dimmed everything and lit
    // everything, and a learner reported not knowing what was being pointed at. Exactly one card carries
    // this at a time, so the spotlight's querySelector cannot resolve a hidden one. Inert on the genuine
    // console, like every other data-tour-id.
    if (front) el.dataset.tourId = "onboarding-card";
    else if (el.dataset.tourId !== undefined) delete el.dataset.tourId;
  });

  refs.fill.style.width = `${((current + 1) / cards.length) * 100}%`;

  const ch = cards[current]!.chapter;
  refs.chapterBtns.forEach((b, k) => {
    // Assign className wholesale (not classList.toggle) so the non-browser validator shim,
    // whose classList lacks toggle, renders the screen without throwing.
    b.className = k === ch ? "cx-chapter cx-chapter--on" : k < ch && chapterDone(k) ? "cx-chapter cx-chapter--done" : "cx-chapter";
    b.disabled = refs.chapterStart[k]! > current && k !== ch;
  });

  refs.custodyText.textContent = cards[current]!.custody;
}

/** Wire keyboard arrows (ignored while typing in a field) and pointer swipe across the stage to the
 *  next/prev moves. Both pointer listeners live on the stage element (pointer capture keeps the
 *  pointerup on the stage even when the release lands outside its bounds), so they are removed with
 *  the element on SPA navigation rather than leaking onto window. The window guard keeps the
 *  non-browser validator shim rendering the screen without throwing. */
export function wireInput(
  page: HTMLElement,
  stage: HTMLElement,
  moves: { next: () => void; prev: () => void },
): void {
  page.addEventListener("keydown", (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (ev.key === "ArrowRight") { ev.preventDefault(); moves.next(); }
    if (ev.key === "ArrowLeft") { ev.preventDefault(); moves.prev(); }
  });

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    let sx: number | null = null;
    stage.addEventListener("pointerdown", (ev: PointerEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest("input,select,button,label,a,details")) return;
      sx = ev.clientX;
      // Capture the pointer so the matching pointerup fires on the stage even if the release
      // lands outside it. This keeps the listener scoped to the element (cleaned up when the
      // stage is removed) instead of leaking a window listener on every navigation.
      if (typeof stage.setPointerCapture === "function") {
        try { stage.setPointerCapture(ev.pointerId); } catch { /* capture is best-effort */ }
      }
    });
    stage.addEventListener("pointerup", (ev: PointerEvent) => {
      if (sx === null) return;
      const dx = ev.clientX - sx;
      sx = null;
      if (Math.abs(dx) > SWIPE_THRESHOLD_PX) { if (dx < 0) moves.next(); else moves.prev(); }
    });
  }
}
