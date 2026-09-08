// Validate the design system's colour contrast BY COMPUTATION.
// Run with: node test/validate-contrast.ts
//
// A comment claiming a contrast ratio can drift from the maths; a computed gate cannot. This validator:
//
//   1. Parses public/tokens.css: the raw ramps + light semantics (the two top-level
//      `:root {` blocks), the prefers-color-scheme dark block, and the
//      `[data-theme="dark"]` override block.
//   2. Asserts the TWO DARK BLOCKS RESOLVE IDENTICALLY for every token (the
//      System-dark and forced-dark paths must render the same console).
//   3. Asserts every var(--x) reference anywhere in the stylesheet resolves to a
//      defined token (catches an undefined token silently falling back).
//   4. Computes WCAG 2.x contrast (relative luminance) for every composed
//      (foreground, background) pair the components actually use, in BOTH themes:
//      >=4.5:1 for text pairs, >=3:1 for UI/graphic pairs.
//
// Threshold notes: --text-subtle is exempt BY RULE (it is decorative-only; any
// text usage is a code-review flag, see tokens.css). Pairs slated for later waves
// (sort-caret effective opacity, --border-strong control boundaries) are listed at
// the end as TODOs and asserted once those waves land.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "public", "tokens.css"), "utf8");

let failures = 0;

// An arbitrary cycle guard for var() resolution. The CSS spec defines no maximum substitution
// depth (browsers use a much higher internal limit); this only catches a self-referential token
// loop in our own stylesheet. Raise it if tokens.css ever legitimately chains deeper.
const MAX_VAR_CHAIN_DEPTH = 16;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// 1. Parse the three token scopes out of tokens.css.
// ---------------------------------------------------------------------------

// Extract the body of the block opened by the FIRST occurrence of `selector {`
// at the given search position; returns [body, indexAfterBlock].
function blockBody(source: string, selector: string, from = 0): [string, number] {
  const at = source.indexOf(selector, from);
  if (at === -1) throw new Error(`selector not found: ${selector}`);
  const open = source.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return [source.slice(open + 1, i - 1), i];
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

function declsOf(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /--([a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi;
  const clean = stripComments(body);
  for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
    map.set(`--${m[1]!}`, m[2]!.trim());
  }
  return map;
}

// Structural integrity gate: confirm every selector the parse depends on is present BEFORE
// parsing, so a renamed or removed selector in tokens.css surfaces as a counted test failure
// rather than an uncaught Error that aborts the run with a stack trace. The exact selectors
// the blockBody calls below search for.
const REQUIRED_SELECTORS = ["\n:root {", ':root:not([data-theme="light"]) {', '\n:root[data-theme="dark"] {'];
let cssStructureSound = true;
for (const sel of REQUIRED_SELECTORS) {
  const present = css.includes(sel);
  ok(`tokens.css contains selector ${JSON.stringify(sel)}`, present);
  if (!present) cssStructureSound = false;
}
if (!cssStructureSound) {
  console.log(`\nvalidate-contrast: ${failures} FAILURE(S) (tokens.css structure changed; cannot run contrast checks)`);
  // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
  // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
  // The exit code is unchanged.
  // failures is at least 1 here by construction: cssStructureSound only goes false through an ok() that
  // has already counted, so this declares the real tally rather than a placeholder.
  if (failures > 0) process.exitCode = 1;
  process.exit(1);
}

// The two top-level `:root {` blocks (raw ramps, then light semantics). The print
// palette uses a combined selector inside @media print, so it cannot match here.
const [rampsBody, afterRamps] = blockBody(css, "\n:root {", 0);
const [lightBody] = blockBody(css, "\n:root {", afterRamps);
// The dark token blocks. The select-chevron rules use longer selectors
// (`... .select {`), so these exact selectors hit only the token blocks.
const [darkMqBody] = blockBody(css, ':root:not([data-theme="light"]) {');
const [darkAttrBody] = blockBody(css, '\n:root[data-theme="dark"] {');

const ramps = declsOf(rampsBody);
const lightSem = declsOf(lightBody);
const darkMqSem = declsOf(darkMqBody);
const darkAttrSem = declsOf(darkAttrBody);

function merged(...maps: Array<Map<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
}

const light = merged(ramps, lightSem);
const darkMq = merged(ramps, lightSem, darkMqSem);
const darkAttr = merged(ramps, lightSem, darkAttrSem);

// Resolve a token through var() chains to a literal value.
function resolve(map: Map<string, string>, name: string, depth = 0): string {
  if (depth > MAX_VAR_CHAIN_DEPTH) throw new Error(`var() chain too deep at ${name}`);
  const raw = map.get(name);
  if (raw === undefined) throw new Error(`undefined token: ${name}`);
  const m = raw.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (m) return resolve(map, m[1]!, depth + 1);
  return raw;
}

// ---------------------------------------------------------------------------
// 2. The two dark blocks must resolve identically (System-dark vs forced-dark).
// ---------------------------------------------------------------------------
console.log("\n-- dark theme: the two entry paths agree --");

const darkKeys = new Set([...darkMqSem.keys(), ...darkAttrSem.keys()]);
let darkDiffs = 0;
// Multi-line values (the shadow stacks) differ only in continuation indentation
// between the two blocks; collapse whitespace so the comparison is semantic.
const norm = (v: string): string => v.replace(/\s+/g, " ");
for (const key of darkKeys) {
  const a = norm(resolve(darkMq, key));
  const b = norm(resolve(darkAttr, key));
  if (a !== b) {
    ok(`${key}: media-query dark (${a}) == data-theme dark (${b})`, false);
    darkDiffs++;
  }
}
ok(`all ${darkKeys.size} dark overrides identical across both blocks`, darkDiffs === 0);

// ---------------------------------------------------------------------------
// 3. Every var(--x) reference in the stylesheet resolves to a defined token.
// ---------------------------------------------------------------------------
console.log("\n-- token references: every var(--x) is defined --");

const refRe = /var\(\s*(--[a-z0-9-]+)/gi;
const undefinedRefs = new Set<string>();
const cssNoComments = stripComments(css);
// Definitions may live in SCOPED blocks too (the aurora skin's [data-aurora]
// tokens, the print palette): a reference is defined if ANY rule declares it,
// not only the four base theme blocks the contrast maps are built from.
const allDefined = new Set<string>();
const defRe = /(--[a-z0-9-]+)\s*:/gi;
for (let d = defRe.exec(cssNoComments); d !== null; d = defRe.exec(cssNoComments)) allDefined.add(d[1]!);
for (let r = refRe.exec(cssNoComments); r !== null; r = refRe.exec(cssNoComments)) {
  const name = r[1]!;
  if (!allDefined.has(name)) undefinedRefs.add(name);
}
ok(
  `no undefined token references${undefinedRefs.size ? ` (found: ${[...undefinedRefs].join(", ")})` : ""}`,
  undefinedRefs.size === 0,
);

// ---------------------------------------------------------------------------
// 4. Computed WCAG contrast for the composed pairs.
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function luminance(rgb: [number, number, number]): number {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function ratio(fgHex: string, bgHex: string): number {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  if (!fg || !bg) throw new Error(`non-hex colour in pair: ${fgHex} on ${bgHex}`);
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

interface Pair {
  fg: string;
  bg: string;
  min: number; // 4.5 text, 3 UI/graphic
  why: string;
}

// The composed pairs the components actually create. Keep this list in step with
// tokens.css; a new fg-on-bg composition lands here in the same change.
const PAIRS: Pair[] = [
  // Body text on every surface (1.4.3).
  ...["--bg", "--bg-subtle", "--surface", "--surface-raised", "--surface-inset"].flatMap((bg) => [
    { fg: "--text", bg, min: 4.5, why: "primary text" },
    { fg: "--text-muted", bg, min: 4.5, why: "secondary text" },
  ]),
  // Placeholder renders only inside inputs (background: --surface).
  { fg: "--placeholder", bg: "--surface", min: 4.5, why: "input placeholder" },
  // Links.
  { fg: "--text-link", bg: "--bg", min: 4.5, why: "link on canvas" },
  { fg: "--text-link", bg: "--surface", min: 4.5, why: "link on card" },
  // Solid fills (4.5 text on fill).
  { fg: "--accent-fg", bg: "--accent", min: 4.5, why: "primary button label" },
  { fg: "--accent-fg", bg: "--accent-hover", min: 4.5, why: "primary button hover label" },
  { fg: "--accent-fg", bg: "--accent-active", min: 4.5, why: "primary button active label" },
  { fg: "--danger-solid-fg", bg: "--danger", min: 4.5, why: "danger button label" },
  // The done-step tick is a GLYPH on the solid ok fill (1.4.11).
  { fg: "--ok-solid-fg", bg: "--ok", min: 3, why: "done-step tick on solid ok" },
  // Badge/banner text on its tint (1.4.3).
  { fg: "--ok-fg", bg: "--ok-bg", min: 4.5, why: "ok badge" },
  { fg: "--warn-fg", bg: "--warn-bg", min: 4.5, why: "warn badge" },
  { fg: "--danger-fg", bg: "--danger-bg", min: 4.5, why: "danger badge" },
  { fg: "--info-fg", bg: "--info-bg", min: 4.5, why: "info badge" },
  { fg: "--trust-fg", bg: "--trust-bg", min: 4.5, why: "trust chip" },
  { fg: "--neutral-fg", bg: "--neutral-bg", min: 4.5, why: "neutral badge" },
  { fg: "--accent-subtle-fg", bg: "--accent-subtle-bg", min: 4.5, why: "accent badge / active nav" },
  // Status foregrounds also appear on the plain card surface (verdict titles).
  { fg: "--ok-fg", bg: "--surface", min: 4.5, why: "ok text on card" },
  { fg: "--warn-fg", bg: "--surface", min: 4.5, why: "warn text on card" },
  { fg: "--danger-fg", bg: "--surface", min: 4.5, why: "danger text on card" },
  { fg: "--info-fg", bg: "--surface", min: 4.5, why: "info text on card" },
  { fg: "--trust-fg", bg: "--surface", min: 4.5, why: "trust text on card" },
  // The Cloudflare-coverage hero's summary counts (§22) render on the page canvas, not a card.
  { fg: "--ok-fg", bg: "--bg", min: 4.5, why: "coverage summary protected count on canvas" },
  { fg: "--warn-fg", bg: "--bg", min: 4.5, why: "coverage summary added count on canvas" },
  // Selection.
  { fg: "--selection-fg", bg: "--selection-bg", min: 4.5, why: "text selection" },
  // Focus ring against the surfaces it borders (1.4.11).
  { fg: "--ring", bg: "--bg", min: 3, why: "focus ring on canvas" },
  { fg: "--ring", bg: "--surface", min: 3, why: "focus ring on card" },
  { fg: "--ring", bg: "--bg-subtle", min: 3, why: "focus ring on subtle bg" },
  { fg: "--ring", bg: "--surface-raised", min: 3, why: "focus ring on overlay" },
  // Control boundaries (1.4.11).
  { fg: "--control-border", bg: "--surface", min: 3, why: "input boundary" },
  { fg: "--control-border", bg: "--bg", min: 3, why: "input boundary on canvas" },
  // The command palette's active-row bar (the bar IS the indicator).
  { fg: "--accent", bg: "--surface-raised", min: 3, why: "palette active-row bar" },
  // Status dots as graphical objects (1.4.11), on card and subtle backgrounds.
  ...["--ok", "--warn", "--danger", "--info", "--trust", "--neutral"].flatMap((dot) => [
    { fg: dot, bg: "--surface", min: 3, why: `${dot.slice(2)} dot on card` },
    { fg: dot, bg: "--bg-subtle", min: 3, why: `${dot.slice(2)} dot on subtle bg` },
  ]),
];

// TODO (asserted as each is landed):
//  - Wave 1.6: --control-border replaces --border-strong on .btn--secondary /
//    segmented controls; then assert the secondary-button boundary here.
//  - Wave 4.5: sort-caret resting tone (effective opacity), trust-chip border on
//    its tint, bulkbar border, dark danger focus shadow.

function runPairs(themeName: string, map: Map<string, string>): void {
  console.log(`\n-- computed contrast: ${themeName} --`);
  for (const p of PAIRS) {
    let got: number;
    try {
      got = ratio(resolve(map, p.fg), resolve(map, p.bg));
    } catch (err) {
      ok(`${p.fg} on ${p.bg} (${p.why}): ${(err as Error).message}`, false);
      continue;
    }
    ok(`${p.fg} on ${p.bg} >= ${p.min} (${p.why}): ${got.toFixed(2)}`, got >= p.min);
  }
}

runPairs("light", light);
runPairs("dark", darkAttr);

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nvalidate-contrast: all checks passed" : `\nvalidate-contrast: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
