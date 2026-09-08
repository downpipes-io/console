// Validates the z-index half of the tour-welcome-hides-the-confirm-dialog fix: a confirm/modal opened
// while a --z-palette tour layer is mounted (the welcome card, the nav-bar, the training intro) must
// render ABOVE it, not sink beneath it (public/tokens.css's `body:has([data-front-layer]) .overlay`
// rule). The DOM shim has no CSS engine, so this suite proves the two halves the shim CAN prove:
//
//   1. the marked elements (persona-fork's welcome card, nav-bar, training intro) really carry
//      data-front-layer once mounted, under the REAL production code, and
//   2. tokens.css's own text: the rule exists, targets .overlay, is keyed off [data-front-layer], and
//      its calc(...) result stays BELOW --z-tooltip and the demo banner's z-index (calc(--z-tooltip+1))
//      -- so the bump never outranks a genuine tooltip or the demo banner, which must stay on top of
//      everything (src/lib/demo/banner.ts).
//
// director.ts's resume pill and pricing-pill.ts carry the same marker (source-text checked below);
// they are not separately mounted here because neither is reachable without driving a full guided-tour
// exit/idle sequence, and both are secondary to the three surfaces the bug report named.
// Run with `node test/validate-overlay-front-layer.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installDomShim } from "./dom-shim.ts";
import { makeChecks } from "./validate-checks.ts";

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
// 2. tokens.css -- the rule that actually lifts the overlay, and the ladder it depends on
// ===========================================================================
console.log("\n-- tokens.css (the z-ladder + the front-layer rule) --");

const css = readFileSync(fileURLToPath(new URL("../public/tokens.css", import.meta.url)), "utf8");

check.has("tokens.css targets .overlay when a front layer is mounted", css, "body:has([data-front-layer]) .overlay");
check.has(
  "the rule lifts the overlay to one above --z-palette (not a fixed number, so it tracks the token)",
  css,
  "z-index: calc(var(--z-palette) + 1)",
);
check.has(
  "the command palette's own precedent (.overlay:has(> .cmdp)) is still the one this rule follows",
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
check.ok(`the front-layer bump (${bump}) clears every tour widget's own --z-palette (${zPalette})`, bump > zPalette);
check.ok(`the front-layer bump (${bump}) stays below --z-tooltip (${zTooltip})`, bump < zTooltip);
check.ok(`the front-layer bump (${bump}) stays below the demo banner's calc(--z-tooltip + 1) (${zTooltip + 1})`, bump < zTooltip + 1);

// ===========================================================================
// 3. The other two front-layer surfaces (director.ts's resume pill, pricing-pill.ts): source-text,
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
if (check.failures > 0) process.exitCode = 1;
if (check.failures > 0) process.exit(1);
