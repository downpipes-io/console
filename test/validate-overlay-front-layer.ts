// Validates the z-index half of the tour-welcome-hides-the-confirm-dialog fix: a confirm raised FROM a
// --z-palette tour layer (the welcome card, the rail, the training intro) must render ABOVE that layer,
// and every other overlay must keep the plain ladder (below the tour chrome, below toasts). The DOM shim has
// no CSS engine, so this suite proves the halves the shim CAN prove:
//
//   1. the marked elements (persona-fork's welcome card, nav-bar, training intro -- the three the
//      owner named) really carry data-front-layer once mounted, under the REAL production code,
//   2. app-external-link.ts marks its confirm data-over-front-layer only when the link sits inside a front
//      layer, driven through the REAL click handler, and
//   3. tokens.css's own text: the lift keys on that mark (`.overlay[data-over-front-layer]`), never on "a
//      front layer is mounted", its calc(...) result stays BELOW --z-tooltip and the demo banner's z-index
//      (calc(--z-tooltip+1)), and the toast region moves up with a lifted overlay.
//
// scripts/tour-front-layer-stacking.mjs measures the painted order in a real browser (elementFromPoint).
//
// director.ts's resume pill and pricing-pill.ts carry the same marker (source-text checked below);
// they are not separately mounted here because neither is reachable without driving a full guided-tour
// exit/idle sequence, and both are secondary to the three surfaces the bug report named.
// Run with `node test/validate-overlay-front-layer.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { docClick, dispatchDocKey, flushAsync, installDomShim } from "./dom-shim.ts";
import { makeChecks } from "./validate-checks.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const check = makeChecks();

// ===========================================================================
// 1. The marked tour surfaces, mounted under the REAL production code
// ===========================================================================
console.log("-- data-front-layer on the real tour surfaces --");

const { mountPersonaFork } = await import("../src/lib/demo/tour/persona-fork.ts");
const { mountNavBar } = await import("../src/lib/demo/tour/nav-bar.ts");
const { mountTrainingIntro } = await import("../src/lib/demo/tour/training-intro.ts");

{
  const fork = mountPersonaFork();
  const card = document.getElementById("tour-persona-fork");
  check.ok("the tour welcome card is mounted", card !== null);
  check.eq("the tour welcome card carries data-front-layer", card?.getAttribute("data-front-layer") ?? null, "true");
  fork.destroy();
  check.ok("destroying the welcome removes it", document.getElementById("tour-persona-fork") === null);
}

{
  const bar = mountNavBar();
  const el = document.getElementById("tour-nav-bar");
  check.ok("the nav-bar is mounted", el !== null);
  check.eq("the nav-bar carries data-front-layer", el?.getAttribute("data-front-layer") ?? null, "true");
  bar.destroy();
  check.ok("destroying the nav-bar removes it", document.getElementById("tour-nav-bar") === null);
}

{
  const intro = mountTrainingIntro({ onStart: () => {} });
  const el = document.getElementById("training-intro");
  check.ok("the training intro is mounted", el !== null);
  check.eq("the training intro carries data-front-layer", el?.getAttribute("data-front-layer") ?? null, "true");
  intro.destroy();
  check.ok("destroying the training intro removes it", document.getElementById("training-intro") === null);
}

// A confirm/modal built through the shared overlay engine carries NONE of these markers itself -- only
// the tour chrome opts in. This is the negative control: without it, a typo that marked EVERY .overlay
// would pass the three checks above vacuously.
{
  const { dialogSurface, openOverlay } = await import("../src/components/dialog.ts");
  const { h } = await import("../src/lib/dom.ts");
  const { surface } = dialogSurface({ variant: "modal", title: "T", body: h("p", "b") });
  const handle = openOverlay({ surface, variant: "modal" });
  const overlayEl = document.querySelector(".overlay");
  check.ok("an ordinary overlay does NOT self-mark data-front-layer", overlayEl?.getAttribute("data-front-layer") === null);
  handle.close();
}

// ===========================================================================
// 2. app-external-link.ts -- the mark on a confirm raised from a front layer
// ===========================================================================
console.log("\n-- data-over-front-layer on the external-link confirm --");

{
  const { installExternalLinkInterstitial } = await import("../src/lib/app-external-link.ts");
  installExternalLinkInterstitial();

  const newestOverlay = (): Element | undefined => {
    const all = document.querySelectorAll(".overlay");
    return all[all.length - 1];
  };
  const clickLink = (href: string, inFrontLayer: boolean): { before: number; after: number; overlay: Element | undefined } => {
    const host = document.createElement("div");
    if (inFrontLayer) host.setAttribute("data-front-layer", "true");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.target = "_blank";
    const span = document.createElement("span");
    anchor.appendChild(span);
    host.appendChild(anchor);
    document.body.appendChild(host);
    const before = document.querySelectorAll(".overlay").length;
    dispatchDocKey(docClick({ target: span }));
    const after = document.querySelectorAll(".overlay").length;
    return { before, after, overlay: after > before ? newestOverlay() : undefined };
  };
  const stayHere = async (): Promise<void> => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Stay here"))?.click();
    await flushAsync();
  };

  const inside = clickLink("https://example.com/cookies", true);
  check.ok("a third-party link inside a front layer raises the confirm", inside.after === inside.before + 1);
  check.ok("that confirm's overlay carries data-over-front-layer", inside.overlay?.hasAttribute("data-over-front-layer") === true);
  await stayHere();

  // The negative control: the same link outside any front layer (every customer-console link) raises the
  // same confirm with NO mark, so it keeps the plain ladder, below toasts.
  const outside = clickLink("https://example.com/cookies", false);
  check.ok("a third-party link outside a front layer raises the confirm", outside.after === outside.before + 1);
  check.ok("that confirm's overlay carries NO data-over-front-layer", outside.overlay?.hasAttribute("data-over-front-layer") === false);
  await stayHere();

  // A first-party link inside a front layer (the welcome's real privacy link) raises nothing to mark.
  const firstParty = clickLink("https://downpipes.io/cookies?src=tour-welcome", true);
  check.ok("a first-party link inside a front layer raises no confirm", firstParty.after === firstParty.before);
}

// ===========================================================================
// 3. tokens.css -- the rule that actually lifts the overlay, and the ladder it depends on
// ===========================================================================
console.log("\n-- tokens.css (the z-ladder + the front-layer rule) --");

const css = readFileSync(fileURLToPath(new URL("../public/tokens.css", import.meta.url)), "utf8");

check.has(
  "tokens.css lifts only the marked overlay, one above --z-palette (tracks the token, not a fixed number)",
  css,
  ".overlay[data-over-front-layer] { z-index: calc(var(--z-palette) + 1); }",
);
check.has(
  "the toast region moves up with a lifted overlay, so modal < toast holds on both rungs",
  css,
  "body:has(> .overlay[data-over-front-layer]) .toast-region { z-index: calc(var(--z-palette) + 2); }",
);
// The form this replaced matched while ANY marked layer was mounted, hidden ones included (the pricing
// pill is always mounted on the tour), so every modal on the tour covered its toasts and the welcome card.
check.ok(
  "no rule lifts overlays merely because a front layer is mounted",
  !/:has\(\[data-front-layer\]\)[^{]*\.overlay/.test(css),
);
check.has(
  "the command palette's own precedent (.overlay:has(> .cmdp)) is still in place",
  css,
  ".overlay:has(> .cmdp)",
);

// The numeric invariant the comment claims: the bump must clear every tour widget's own z-index
// (--z-palette) but stay BELOW --z-tooltip and the demo banner (calc(--z-tooltip + 1)), so a lifted
// confirm can never outrank a genuine tooltip or hide the demo marker banner.ts insists on keeping on
// top. Re-derived from the ladder's own numbers rather than assumed, so a future renumbering of the
// ladder fails this test instead of silently breaking the invariant.
const zVar = (name: string): number => {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+)`));
  if (!m?.[1]) throw new Error(`tokens.css: --${name} not found`);
  return Number(m[1]);
};
const zPalette = zVar("z-palette");
const zTooltip = zVar("z-tooltip");
const bump = zPalette + 1;
const toastBump = zPalette + 2;
check.ok(`the front-layer bump (${bump}) clears every tour widget's own --z-palette (${zPalette})`, bump > zPalette);
check.ok(`the lifted toast (${toastBump}) clears the lifted overlay (${bump})`, toastBump > bump);
check.ok(`the lifted toast (${toastBump}) stays below --z-tooltip (${zTooltip})`, toastBump < zTooltip);
check.ok(`the front-layer bump (${bump}) stays below the demo banner's calc(--z-tooltip + 1) (${zTooltip + 1})`, bump < zTooltip + 1);

// ===========================================================================
// 4. The other two front-layer surfaces (director.ts's resume pill, pricing-pill.ts): source-text,
//    since neither is reachable without driving a full tour exit/idle sequence.
// ===========================================================================
console.log("\n-- data-front-layer on the resume + pricing pills (source-text) --");

const directorSrc = readFileSync(fileURLToPath(new URL("../src/lib/demo/tour/director.ts", import.meta.url)), "utf8");
const pricingPillSrc = readFileSync(fileURLToPath(new URL("../src/lib/demo/tour/pricing-pill.ts", import.meta.url)), "utf8");
check.has("director.ts's resume pill carries the marker", directorSrc, "dataset: { frontLayer: \"true\" }");
check.has("pricing-pill.ts's pill carries the marker", pricingPillSrc, "pill.dataset.frontLayer = \"true\";");

// ===========================================================================
// Summary
// ===========================================================================
console.log(check.failures === 0 ? "\nOVERLAY FRONT-LAYER VECTORS PASS" : `\n${check.failures} FAILURE(S)`);
verdictReached(check.failures);
if (check.failures > 0) process.exit(1);
