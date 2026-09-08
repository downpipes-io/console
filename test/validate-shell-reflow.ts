// Validate the SHELL REFLOW contract: the app shell's content column must never be floored by the
// min-content of the chrome that sits in it.
// Run with: node test/validate-shell-reflow.ts
//
// THE DEFECT THIS GUARDS
// ----------------------
// Every chrome'd screen at 375px overflowed horizontally by exactly 35px: scrollWidth 410 against
// clientWidth 375, one identical number across every screen, which is the signature of shell CHROME
// rather than a per-screen bug.
//
// A bare `1fr` grid track is `minmax(auto, 1fr)`, and that `auto` floor is the largest automatic minimum
// size among the track's items. `.main` had opted out of it with min-width:0; the context bar and the setup
// strip never did. So the BAR's min-content became the content column's floor, and the bar's widest
// unshrinkable item is the engine identity chip, whose `.engine-chip__host` is nowrap mono text: on an
// estate whose host is 46 characters that chip's min-content is 386px, and the bar's is 386 + 12 + 12 =
// 410px. Every chrome'd screen therefore laid its main region out 410px wide inside a 375px viewport.
//
// The fix is minmax(0, 1fr) on every .shell column template, so the column is the space available and the
// bar's own wrap plus the chip's ellipsis (both already written) do the shrinking.
//
// The second contract is the restore stepper in the 768-1023 docked band, where the rail is back in the
// grid at 240px and the flow column is narrower than it is at 640 with no rail, while the >=641 rule pins
// the stepper flex-wrap:nowrap with nowrap labels and a 605px min-content, producing 109px of overflow
// at 768 on /restore.
//
// WHY A CSS-TEXT GUARD, AND WHAT IT IS NOT
// ----------------------------------------
// This repo has no layout engine (no browser, no Playwright), so the pixel proof lives in a true-viewport
// visual check elsewhere. This file is the durable, CI-run guard on the MECHANISM that proof depends on,
// the same division of labour test/validate-downpipe-name-overflow.ts already documents for the
// /downpipes name cell.
//
// Every check carries a NEGATIVE CONTROL, so none of it can pass vacuously: the anchor text it keys off
// must be present in tokens.css, and the defective form (a bare `1fr` column on .shell, a nowrap stepper
// with no docked-band relief) must be absent.
//
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "public", "tokens.css");
const raw = readFileSync(cssPath, "utf8");

// Comments are stripped before any rule is inspected. tokens.css is heavily commented, and this very
// file's rationale is written INTO those comments, so a scanner that read them would match its own
// explanation and pass while the rules said the opposite.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

/** Every `grid-template-columns` declaration that belongs to a `.shell` selector, comments stripped. */
function shellColumnDeclarations(): { selector: string; value: string }[] {
  const out: { selector: string; value: string }[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null = ruleRe.exec(css);
  while (m !== null) {
    const selector = (m[1] ?? "").trim().replace(/\s+/g, " ");
    const body = m[2] ?? "";
    if (/(^|[\s,])\.shell\b/.test(selector)) {
      const decl = /grid-template-columns\s*:\s*([^;]+);/.exec(body);
      if (decl) out.push({ selector, value: (decl[1] ?? "").trim().replace(/\s+/g, " ") });
    }
    m = ruleRe.exec(css);
  }
  return out;
}

console.log("\n-- the shell's content column is never floored by its chrome --");

const shellCols = shellColumnDeclarations();
// Negative control on the parser itself: if this ever reads 0, every check below would pass on an empty
// list and prove nothing. Four templates ship today (wide, collapsed rail, chrome-off, compact).
ok(`tokens.css declares .shell grid-template-columns (found ${shellCols.length})`, shellCols.length >= 4);

for (const { selector, value } of shellCols) {
  ok(
    `${selector} sizes its content column minmax(0, 1fr), never a bare 1fr: ${JSON.stringify(value)}`,
    /minmax\(\s*0\s*,\s*1fr\s*\)/.test(value) && !/(^|[\s,])1fr(\s|$|,)/.test(value),
  );
}

// The item-level opt-out .main already carried, kept because it documents the same intent at the item
// level and is the reason .main was never the screen that overflowed.
ok(".main still carries min-width: 0", /\.main\s*\{[^}]*min-width:\s*0/.test(css));

console.log("\n-- the restore stepper wraps in the 768-1023 docked band --");

// The >=641 rule that pins the stepper nowrap must still exist (the anchor), and it must be relieved in
// the band where the rail is docked at 240px. Without the anchor check, a deleted rule would read as a
// pass.
ok(
  "the >=641 stepper rule still pins flex-wrap: nowrap (the anchor this band relieves)",
  /@media\s*\(\s*min-width:\s*641px\s*\)\s*\{[\s\S]*?\.restore-steps\s*\{[^}]*flex-wrap:\s*nowrap/.test(css),
);

const dockedBand = /@media\s*\(\s*min-width:\s*768px\s*\)\s*and\s*\(\s*max-width:\s*1023px\s*\)\s*\{([\s\S]*?)\n\}/.exec(css);
ok("a 768-1023 docked-band block exists", dockedBand !== null);
const bandBody = dockedBand?.[1] ?? "";
ok(".restore-steps wraps in that band", /\.restore-steps\s*\{[^}]*flex-wrap:\s*wrap/.test(bandBody));
ok(".restore-step__sep is dropped in that band (no dangling connector at a wrapped row's edge)", /\.restore-step__sep\s*\{[^}]*display:\s*none/.test(bandBody));

console.log("\n-- negative controls: the defective forms are absent --");

ok(
  "no .shell rule sizes a column with a bare 1fr",
  shellCols.every(({ value }) => !/(^|[\s,])1fr(\s|$|,)/.test(value)),
);
ok(
  "the docked-band block does not itself re-pin the stepper nowrap",
  bandBody !== "" && !/flex-wrap:\s*nowrap/.test(bandBody),
);
// And prove the comment-stripping works: the word "1fr" DOES appear in tokens.css comments (this fix's own
// rationale names it), so a scanner reading comments would see it. The stripped text must not.
ok("the raw file mentions a bare 1fr in prose, and the stripped text does not carry it into a .shell column", /1fr/.test(raw));

console.log(failures === 0 ? "\nvalidate-shell-reflow: all checks passed" : `\nvalidate-shell-reflow: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
