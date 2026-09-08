// A maximal-length downpipe config.name (the field is 1 to 256 chars, editor-upsert.ts:50 validate
// v.length <= 256) can drive the /downpipes Name cell wide enough to run the name past the viewport and
// shove the page-header primary controls ("Pause auto-refresh", "New downpipe") off-screen at common
// viewport widths.
//
// The console DOM shim has no layout engine, so the pixel-level in-bounds proof is a separate
// headless-Chromium geometry measurement. THIS suite is the durable, default-FAIL guard on the fix's
// MECHANISM, the thing the geometry depends on:
//   1. the Name cell renders through the capped .dp-name--cell contract (.dp-name__label value span),
//   2. the full name is preserved as a TEXT node and echoed into a title attribute (accessibility +
//      the /-filter still matches the whole name; the visual truncation is CSS-only, no data loss),
//   3. public/tokens.css carries the width cap (max-width + overflow:hidden + text-overflow:ellipsis +
//      white-space:nowrap) scoped to the wide layout, plus the overflow-wrap base for the card-stack,
//   4. a NORMAL name renders unchanged (same classes, same title, same text).
// Every check has a negative control so it cannot pass vacuously. Before the fix the classes, the title
// and the CSS rule are all absent, so every mechanism check FAILS.
//
// Run with: node test/validate-downpipe-name-overflow.ts

import { installDomShim } from "./dom-shim.ts";
installDomShim();

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { qsa } from "./dom-shim.ts";
import { buildTable } from "../src/screens/sources-downpipes/table.ts";
import { destinationFromStatus } from "../src/lib/protection-statement.ts";
import type { DownpipeState, EngineClient } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The name field's true upper bound (editor-upsert.ts:50, engine config-validate.ts:126-127 name 1..256).
const NAME_256 = "N".repeat(256);
// The exact length the visual probe seeded (MAXIMAL_NAME_LEN default in the geometry spec).
const NAME_180 = "M".repeat(180);
const NAME_NORMAL = "uploads-prod";

const engine = {} as unknown as EngineClient; // rendering the name cell never calls the API
const noop = (): void => {};

// A minimal enabled KV downpipe; fresh objects per row, the shape listDownpipes hands the screen.
function dp(id: string, name: string): DownpipeState {
  return {
    config: { id, name, cadenceSeconds: 86_400, enabled: true, source: { type: "kv", binding: `SRC_KV_${id}`, include: [], exclude: [] } },
    nextRunAt: Date.now() + 3_600_000,
    lastRunId: null,
    inFlight: false,
  };
}

// The rendered .dp-name--cell whose value-label carries `name` (rows sort by name, so find by content,
// never by index). Returns the label span (.dp-name__label) or null.
function labelFor(root: unknown, name: string): { textContent: string; getAttribute: (k: string) => string | null; classList: { contains: (c: string) => boolean } } | null {
  for (const cell of qsa(root as never, ".dp-name--cell")) {
    const label = qsa(cell, ".dp-name__label")[0] as unknown as
      | { textContent: string; getAttribute: (k: string) => string | null; classList: { contains: (c: string) => boolean } }
      | undefined;
    if (label && label.textContent === name) return label;
  }
  return null;
}

console.log("\n-- the /downpipes Name cell caps a maximal-length name --");

const table = buildTable(
  engine,
  [dp("normal-row", NAME_NORMAL), dp("long180-row", NAME_180), dp("long256-row", NAME_256)],
  new Map(),
  new URLSearchParams(),
  false,
  noop,
  destinationFromStatus(null),
);
const root = table.el;

// The cap wrapper is applied to every name cell (three rows rendered).
const cells = qsa(root as never, ".dp-name--cell");
ok("every name cell carries the .dp-name--cell cap wrapper (3 rows)", cells.length === 3);
// Negative control: the wrapper is the NAME cell only, never the coverage/state cells (which also use
// .dp-name). There are 3 rows x 3 .dp-name cells (name + state + coverage), so a naive `.dp-name` count
// is 9; only the 3 name cells are --cell. This would trip if the modifier leaked onto every .dp-name.
ok("the cap wrapper is scoped to the name cell, not every .dp-name (negative control)", qsa(root as never, ".dp-name").length > cells.length);

for (const [tag, name] of [["180-char", NAME_180], ["256-char (field max)", NAME_256]] as const) {
  const label = labelFor(root, name);
  ok(`${tag}: the name renders through the .dp-name__label value span`, (label?.classList.contains("dp-name__label") ?? false));
  ok(`${tag}: the FULL name is preserved as text (CSS truncates visually, no data loss)`, label !== null && label.textContent === name && label.textContent.length === name.length);
  ok(`${tag}: the full name rides a title attribute for hover + assistive tech`, label !== null && label.getAttribute("title") === name);
}

// A normal name is unchanged: same contract, name intact, title equals the name.
const normal = labelFor(root, NAME_NORMAL);
ok("normal name: renders through the same .dp-name__label contract", (normal?.classList.contains("dp-name__label") ?? false));
ok("normal name: text is the name verbatim (unchanged)", normal !== null && normal.textContent === NAME_NORMAL);
ok("normal name: title is the name verbatim", normal !== null && normal.getAttribute("title") === NAME_NORMAL);
// Negative control: the title is row-specific, not a hardcoded constant.
ok("titles are row-specific (negative control)", normal !== null && normal.getAttribute("title") !== NAME_180);

// XSS posture (the console's standing invariant): the name reaches the DOM as a text node through the
// h() builder, never markup. The label has no element descendants; the title was set via setAttribute.
const longLabelForXss = labelFor(root, NAME_256);
ok("XSS posture kept: the name label has no injected element children (text node only)", longLabelForXss !== null && qsa(longLabelForXss as never, "*").length === 0);

// The CSS width cap the geometry depends on (public/tokens.css). Read the source file, not a computed
// style (the shim has no CSSOM), and assert the exact cap contract exists.
const css = readFileSync(fileURLToPath(new URL("../public/tokens.css", import.meta.url)), "utf8");
ok("tokens.css styles the .dp-name--cell wrapper", css.includes(".dp-name--cell"));
// The wide-layout cap: single-line, capped, ellipsised (default-FAIL: this block only exists post-fix).
const wideCap = /\.dp-name--cell \.dp-name__label,\s*\.dp-name--cell \.dp-name__sub \{[^}]*?max-width:[^}]*?overflow: hidden;[^}]*?text-overflow: ellipsis;[^}]*?white-space: nowrap;[^}]*?\}/;
ok("tokens.css caps the name + binding: max-width + overflow:hidden + text-overflow:ellipsis + white-space:nowrap", wideCap.test(css));
// The cap is scoped to the wide table layout (>= 1024), the complement of the card-stack (<= 1023).
const capIdx = css.search(/\.dp-name--cell \.dp-name__label,\s*\.dp-name--cell \.dp-name__sub \{[^}]*?max-width/);
const mediaIdx = css.lastIndexOf("@media (min-width: 1024px)", capIdx);
ok("the ellipsis cap is scoped under @media (min-width: 1024px)", capIdx > 0 && mediaIdx > 0 && mediaIdx < capIdx);
// The card-stack / narrow base lets a long unbroken name WRAP rather than spill (overflow-wrap:anywhere).
ok("tokens.css lets the name wrap on the card-stack (overflow-wrap: anywhere base)", /\.dp-name--cell \.dp-name__label,\s*\.dp-name--cell \.dp-name__sub \{\s*overflow-wrap: anywhere;\s*\}/.test(css));
// Negative control: a cap that is NOT ellipsised would leave the row able to spill; assert the property
// value is present, not merely the property name.
ok("the cap uses a real ellipsis value (negative control)", /text-overflow:\s*ellipsis/.test(css) && !/text-overflow:\s*clip/.test(css));

console.log("");
if (failures > 0) {
  console.log(`VALIDATE-DOWNPIPE-NAME-OVERFLOW: ${failures} FAILED`);
  process.exit(1);
}
console.log("VALIDATE-DOWNPIPE-NAME-OVERFLOW VECTORS PASS");
