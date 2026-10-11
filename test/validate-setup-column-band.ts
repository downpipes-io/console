// Validate the SETUP QUESTION COLUMN BAND: between 768 and 1023px the setup surface must drop to its
// one-column layout, the same arrangement it already uses below 768px and in the 1024-1519px rail band, so
// the surface is one column, without a break, from 768px to 1519px.
// Run with: node test/validate-setup-column-band.ts
//
// THE DEFECT THIS GUARDS
// ----------------------
// .fb-body keeps its 440px plan column fixed at every width from 768px up (public/tokens.css). Its own
// base rule collapses to one column only below 768px or, when the tour rail is showing, between 1024 and
// 1519px; outside those two bands the question column is whatever is left: viewport minus the plan
// column, the row gap and the page's side padding, which is 152px wide at 768px. The widest tile grid the
// setup surface has (the 3-column custody tiles) needs the question column to be at least 977px wide
// before every tile and heading clears its own row, so a relieving band has to run the whole way from
// 768px to the rail band's own floor at 1024px: a band that stops short of 1023px leaves a second, narrower
// gap where the question column is still squeezed and nothing relieves it.
//
// WHY A CSS-TEXT GUARD, AND WHAT IT IS NOT
// ----------------------------------------
// This repo has no layout engine (no browser, no Playwright), so the PIXEL proof lives in the harness:
// spec/visual/route-set-containment.spec.ts measures every setup route in a true browser at every width
// the console's own stylesheet declares and asserts no child paints past its own parent. This file is the
// durable, CI-run guard on the MECHANISM that proof depends on, the same division of labour
// test/validate-shell-reflow.ts already documents for the shell's content column.
//
// Every check carries a NEGATIVE CONTROL, so none of it can pass vacuously: the rules it looks for must be
// present with the right bounds, and the defective form (no relief across the whole 768-1023 band) must be
// absent.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "public", "tokens.css");
const raw = readFileSync(cssPath, "utf8");

// Comments are stripped before any rule is inspected, for the same reason validate-shell-reflow.ts strips
// them: this file's own rationale names the numbers the rules must carry, and a scanner reading comments
// would match its own explanation rather than the rule.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

/**
 * The @media block that encloses a given marker text, found by brace depth rather than a lazy regex: the
 * stylesheet repeats `@media (max-width: 767px)` a dozen times for a dozen unrelated components, so the
 * first textual match is not the setup surface's own block. Returns the block's body (excluding the
 * `@media (...) {` line and the closing `}`), or null if the marker is not found or is not inside an
 * @media rule.
 */
function mediaBlockContaining(text: string, marker: string): string | null {
  const markerAt = text.indexOf(marker);
  if (markerAt < 0) return null;
  const atMedia = text.lastIndexOf("@media", markerAt);
  if (atMedia < 0) return null;
  const openBrace = text.indexOf("{", atMedia);
  if (openBrace < 0 || openBrace > markerAt) return null;
  let depth = 1;
  let i = openBrace + 1;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  if (depth !== 0) return null;
  const closeBrace = i - 1;
  if (markerAt > closeBrace) return null; // the marker sat past this block's own close: not inside it
  return text.slice(openBrace + 1, closeBrace);
}

/**
 * The `min-width` or `max-width` number, in px, off the @media header that encloses a given marker text.
 * Read off the stylesheet rather than hard-coded, so this file's own gap check moves with the rail band's
 * floor instead of pinning a second copy of a number that could drift from it.
 */
function mediaBoundContaining(text: string, marker: string, bound: "min-width" | "max-width"): number | null {
  const markerAt = text.indexOf(marker);
  if (markerAt < 0) return null;
  const atMedia = text.lastIndexOf("@media", markerAt);
  if (atMedia < 0) return null;
  const openBrace = text.indexOf("{", atMedia);
  if (openBrace < 0 || openBrace > markerAt) return null;
  const header = text.slice(atMedia, openBrace);
  const m = new RegExp(`${bound}:\\s*(\\d+)px`).exec(header);
  return m ? Number(m[1]) : null;
}

console.log("\n-- the setup surface's two columns never squeeze the question column below a usable width --");

// Negative control on the parser itself: the fixed-width plan column this whole band exists to relieve
// must still be there, unconditionally, or the band would be relieving a rule that no longer applies.
ok(
  "the base .fb-body rule still fixes a 440px plan column at every width",
  /\.fb-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*440px/.test(css),
);

// The three bands that collapse .fb-body to one column, by ascending width: below 768, the new 768-1023
// relief, and the 1024-1519 rail band. Each is matched on its own so a missing one is named, not folded
// into a single count.
const narrowBand = mediaBlockContaining(css, ".fb-top { height: 48px");
ok("the below-768px band exists (the anchor this fix's band sits beside)", narrowBand !== null);
ok(
  "it collapses .fb-body to one column",
  /\.fb-body,\s*\.fb-body--noplan\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(narrowBand ?? ""),
);

// Anchored on this exact indented line, not the @media header text or the bare selector: the stylesheet
// already has an unrelated `@media (min-width: 768px) and (max-width: 1023px)` block elsewhere (a
// different component's own docked band), so matching on the header alone finds that one instead of this
// band's; and the bare selector `.fb-planbtn { display: inline-flex; }` is itself a SUBSTRING of the rail
// band's `body.dp-tour-rail .fb-planbtn { display: inline-flex; }`, so indexOf would find that one first.
const SQUEEZE_MARKER = "\n  .fb-planbtn { display: inline-flex; }";
const squeezeBand = mediaBlockContaining(css, SQUEEZE_MARKER);
ok("the squeeze band exists (anchored on its own .fb-planbtn rule)", squeezeBand !== null);
const squeezeUpperWidth = mediaBoundContaining(css, SQUEEZE_MARKER, "max-width");
ok("that band's upper bound is 1023px", squeezeUpperWidth === 1023);
const squeezeBody = squeezeBand ?? "";
ok(".fb-body collapses to one column in that band", /\.fb-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;?\s*\}/.test(squeezeBody));
ok(".fb-plan is hidden in that band, matching the below-768px and rail bands", /\.fb-plan\s*\{[^}]*display:\s*none/.test(squeezeBody));
ok(".fb-planbtn takes its place in that band", /\.fb-planbtn\s*\{[^}]*display:\s*inline-flex/.test(squeezeBody));
ok(
  "the finish page still hides the plan button in that band, matching every other band",
  /\.fb-page--finish\s+\.fb-planbtn\s*\{[^}]*display:\s*none/.test(squeezeBody),
);

const railBand = mediaBlockContaining(css, "body.dp-tour-rail .fb-body");
ok("the 1024-1519px rail band still exists (the anchor the new band sits beside)", railBand !== null);
ok(
  "it still collapses .fb-body to one column while the rail shows",
  /body\.dp-tour-rail\s+\.fb-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(railBand ?? ""),
);

const railMinWidth = mediaBoundContaining(css, "body.dp-tour-rail .fb-body", "min-width");
ok("the rail band's own min-width is read off the stylesheet", railMinWidth !== null);
ok(
  "the squeeze band's upper bound meets the rail band's floor with no gap between them",
  squeezeUpperWidth !== null && railMinWidth !== null && squeezeUpperWidth + 1 === railMinWidth,
);

console.log("\n-- negative controls: the defective form is absent --");

// The defect this guards: no relief between 768 and 1023px, so the base 440px rule is the only one that
// ever applies there and the question column is left at viewport minus 616px, 152px wide at 768px.
ok(
  "the squeeze band is not itself scoped to the tour rail only (it must relieve the general case)",
  squeezeBody !== "" && !/dp-tour-rail/.test(squeezeBody),
);
ok(
  "the squeeze band does not merely repeat the rail's 1024 floor (it starts at 768, where the plan column first binds)",
  squeezeBand !== null,
);
// A band ending at 976px relieves the wide part of the gap and leaves a second, narrower one right beside
// the rail band's own floor. Naming that number here means it fails on this line, not only on the equality
// check above.
ok("the squeeze band's upper bound is not the narrower 976px", squeezeUpperWidth !== 976);
// And prove the comment-stripping works: this file's own rationale names 977 in prose, so a scanner reading
// comments would see it. The stripped text must not carry that number into the rule it is describing.
ok("the raw file's comments name the band's measured edge in prose", /977px/.test(raw));

console.log(failures === 0 ? "\nvalidate-setup-column-band: all checks passed" : `\nvalidate-setup-column-band: ${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
