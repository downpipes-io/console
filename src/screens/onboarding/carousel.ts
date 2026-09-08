// The onboarding CAROUSEL: the rotating card deck the owner approved, and the production
// realisation of the first-run flow. The whole flow renders as a single full-bleed deck of
// bite-size cards grouped into five chapters, rather than a side-railed single step. Forward
// movement is GATED on the action cards (prerequisites, connect, generate, install) so the
// operator cannot skip them. Every safety-critical operation (the in-browser key ceremony, the
// engine install, the no-custody guarantees) reuses the exact shared helpers and step renderers
// unchanged; only the chassis and navigation live here. Moved verbatim from the onboarding
// coordinator for size. House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { buildTopBar, buildChapterRail, buildStage, buildCardShells, applyLayout, wireInput } from "./chassis.ts";
import { toast } from "../../components/toast.ts";
import { navigate, registerLeaveGuard, clearLeaveGuard } from "../../lib/nav.ts";
import { getCeremony } from "../../lib/store.ts";
import { confirmModal } from "../../components/modal.ts";
import type { ScreenContext } from "../common.ts";
import {
  OB_CHAPTERS,
  STEP_TO_CARD,
  type CarouselNav,
} from "./shared.ts";
import { OB_CARDS } from "./carousel-cards.ts";

// The OB_CARDS deck data and per-card mount closures live in the sibling carousel-cards.ts module
// (split out for size). The chassis below mounts and navigates them.

// renderCarousel builds the full-bleed deck: the slim top bar, the chapter progress rail, the
// perspective stage of cards, and the side chevrons. Cards mount lazily on first enter so each
// reads live store state (the engine connection, the ceremony result) exactly when it is shown.
export function renderCarousel(ctx: ScreenContext): HTMLElement {
  const startId = STEP_TO_CARD[ctx.params.step ?? ""] ?? "welcome";
  let current = Math.max(0, OB_CARDS.findIndex((c) => c.id === startId));

  const passed = OB_CARDS.map((c) => !c.gate);
  const mounted = OB_CARDS.map(() => false);

  // The inert training-walk anchor (the tour's data-tour-id idiom, sources-downpipes/table.ts tagRow): the
  // walk's first chapter narrates beside the deck and pins its spotlight here. No behaviour on the genuine
  // console.
  const page = h("div", { class: "ob-page", dataset: { tourId: "onboarding-deck" } });
  page.appendChild(h("a", { class: "ob-skip", href: "#ob-main" }, "Skip to setup content"));

  // Top bar: brand, the per-card trust line, an explicit way out, and the live theme control.
  const { bar, custodyText } = buildTopBar(OB_CARDS[current]!.custody);
  page.appendChild(bar);

  // Chapter rail.
  const chapterStart = OB_CHAPTERS.map((_, k) => OB_CARDS.findIndex((c) => c.chapter === k));
  const { rail, chapterBtns, fill } = buildChapterRail(OB_CHAPTERS, chapterStart, (i) => go(i));
  page.appendChild(rail);

  // The deck stage + chevrons.
  const { stage, stageWrap, prevBtn, nextBtn } = buildStage();
  page.appendChild(stageWrap);

  page.appendChild(
    h("p", { class: "cx-hint" }, "Move with the arrows, swipe, the side buttons, or the action on each card."),
  );

  // The card shells (one per card; content mounts lazily on first enter).
  const els = buildCardShells(OB_CARDS, stage);

  function navFor(i: number): CarouselNav {
    return {
      advance: () => go(i + 1),
      back: () => go(i - 1),
      markPassed: () => { passed[i] = true; if (i === current) refreshNav(); },
    };
  }

  function mountIfNeeded(i: number): void {
    if (mounted[i]) return;
    mounted[i] = true;
    const inner = els[i]!.querySelector(".cx-card__in") as HTMLElement;
    OB_CARDS[i]!.mount(inner, navFor(i));
    // A card may declare itself the ok-toned hero (the done card) via heroTone on its def.
    // Use className concat (not classList.add) for non-browser-shim safety.
    if (OB_CARDS[i]!.heroTone === "ok") els[i]!.className += " cx-card--ok";
  }

  function isLocked(i: number): boolean {
    return OB_CARDS[i]!.gate === true && !passed[i];
  }

  // chapterGatesPassed: a chapter counts as genuinely done only when every GATED card in it has
  // passed (the same passed[] state that unlocks Next). The rail tick reads this, so a chapter
  // behind the current card whose gate is still unmet (a deep link with no engine, say) never
  // paints an unearned tick. A chapter with no gated cards passes vacuously (moving past it is
  // all "done" can mean there).
  function chapterGatesPassed(k: number): boolean {
    return OB_CARDS.every((c, i) => c.chapter !== k || c.gate !== true || passed[i] === true);
  }

  function refreshNav(): void {
    nextBtn.disabled = current === OB_CARDS.length - 1 || isLocked(current);
    prevBtn.disabled = current === 0;
    // Hide the prev arrow entirely on the first card (there is no card before it); a dimmed
    // disabled arrow read as a broken control.
    prevBtn.style.visibility = current === 0 ? "hidden" : "visible";
  }

  function layout(): void {
    applyLayout(OB_CARDS, current, { els, fill, chapterBtns, chapterStart, custodyText }, chapterGatesPassed);
    // Capture mount state BEFORE mountIfNeeded so a RE-show (the operator navigated back to an
    // already-mounted card) triggers its onShow re-sync, while a first mount does not double-run it.
    // onShow lets a stateful card (the key ceremony / install) rebuild from the live store, so a
    // generate or "replace my keys" round-trip never shows a stale spinner or stale key material (the
    // deck mounts each card only once and otherwise keeps its first-mount DOM forever).
    const wasMounted = mounted[current];
    mountIfNeeded(current);
    if (wasMounted) {
      const inner = els[current]!.querySelector(".cx-card__in") as HTMLElement;
      OB_CARDS[current]!.onShow?.(inner, navFor(current));
    }
    refreshNav();
    // focus() is absent in the non-browser validator shim; guard it.
    els[current]!.focus?.({ preventScroll: true });
  }

  function go(i: number): void {
    const target = Math.max(0, Math.min(OB_CARDS.length - 1, i));
    if (target === current) return;
    current = target;
    layout();
  }

  function nudge(): void {
    toast({ message: OB_CARDS[current]!.nudge ?? "Finish this step to continue." });
    nextBtn.classList.remove("cx-shake");
    void nextBtn.offsetWidth;
    nextBtn.classList.add("cx-shake");
  }

  function next(): void {
    if (isLocked(current)) {
      nudge();
      return;
    }
    go(current + 1);
  }
  function prev(): void { go(current - 1); }

  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);

  // Keyboard arrows and pointer swipe across the stage.
  wireInput(page, stage, { next, prev });

  // LEAVING WITH LIVE, UNINSTALLED KEY MATERIAL WAS A SILENT ONE-WAY DOOR, and this is the only place in
  // onboarding that can catch it. app.ts's afterEach drops the ceremony material the moment the route leaves
  // CEREMONY_PATTERNS (clearSensitiveState, lib/app-registry.ts), which is correct hygiene and is precisely
  // why the exit needs to ask first: between "Generate my keys" and a successful install, this tab holds the
  // ONLY copy of key material that matches the identity.key, signer.pub and recovery sheet the customer has
  // already downloaded. Walk away and those saved files match nothing: the engine never received the keys,
  // and returning to the wizard offers a plain "Generate my keys" that mints a FRESH, non-matching set.
  //
  // Nothing warned about that. The generate card's own replacement warning ("a brand-new set that will not
  // match the identity.key or recovery sheet you saved") is conditioned on the engine ALREADY holding keys,
  // so it does not render in exactly this case, which is the one where the mismatch is invisible until a
  // restore is attempted, possibly months later.
  //
  // getCeremony() is the exact test for the dangerous window: setCeremony fills it at generate and the
  // install path's markInstalled clears it through clearSensitiveState the instant the engine has the keys,
  // so the prompt appears only while material is genuinely held and unbanked.
  //
  // Destinations that PRESERVE the material are allowed through silently. CEREMONY_PATTERNS is exactly the
  // onboarding route plus the four Keys routes, so a navigation to either keeps the ceremony alive and a
  // prompt there would be a false alarm; the install step's own "Keys screen" links go to /keys.
  const guard = (to: string): boolean => {
    // Self-heal: an orphaned guard (the screen was torn down by a forced redirect such as a 401, which
    // bypasses the guard entirely) must never wedge a later navigation.
    if (!page.isConnected) { clearLeaveGuard(guard); return true; }
    if (getCeremony() === null) return true;
    if (to === "/keys" || to.startsWith("/keys/") || to.startsWith("/onboarding")) return true;
    void confirmModal({
      title: "Leave before installing your keys?",
      body: "Your keys were generated in this browser and are not on your engine yet. Leaving clears them from this tab, and the files you downloaded will not match the new set you would have to generate.",
      confirmLabel: "Leave anyway",
      variant: "danger",
    }).then((ok) => {
      if (ok) {
        clearLeaveGuard(guard);
        navigate(to);
      }
    });
    return false;
  };
  // a real navigation (reload, tab close) always leaves the SPA regardless of
  // destination, so the guard's /keys and /onboarding exceptions above (which only make
  // sense for an in-app route change) do not apply here; the dirty test for beforeunload is
  // just "is ceremony material genuinely held and unbanked", the same predicate the guard
  // itself opens with. Passing it lets nav.ts's shared beforeunload listener catch the case
  // the SPA guard alone cannot: unbanked keys lost to a reload instead of a rail click.
  registerLeaveGuard(guard, () => getCeremony() !== null);

  layout();
  return page;
}
