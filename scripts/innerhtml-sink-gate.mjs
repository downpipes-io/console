// XSS innerHTML-sink gate (npm run lint:xss, chained into npm run lint).
//
// The console's XSS guarantee (design-system.md): no field, server or user value ever reaches
// an HTML sink; every value renders through createTextNode / typed element creation (the h() builder), and
// the ONLY innerHTML sites are trusted, compile-time, in-repo SVG constants. That invariant was held only by
// convention and code review; a future edit assigning a server value to `.innerHTML` would pass every other
// gate. This gate makes it enforceable.
//
// Two rules:
//   1. The dangerous HTML sinks (insertAdjacentHTML, outerHTML, document.write, dangerouslySetInnerHTML,
//      setHTML, createContextualFragment, new Function, eval) are NEVER allowed anywhere in src.
//   2. `.innerHTML =` assignments are allowed ONLY in the files listed in ALLOWED_INNERHTML, each of which
//      writes an in-repo SVG/markup constant (verified by the audit). A new innerHTML write elsewhere fails
//      here, forcing a review that either routes it through createTextNode/h() or adds a justified entry.
//
// A stale exemption (an allowlisted file that no longer writes innerHTML) also fails: remove it.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

// path (POSIX, relative to repo root) -> rationale. Each writes a trusted in-repo SVG/markup constant.
const ALLOWED_INNERHTML = {
  "src/lib/dom.ts": "svgIcon writes an in-repo ICON_* path constant (the one shared SVG sink; 344 call sites, all constants)",
  "src/shell/brand.ts": "writes the BRAND_MARK in-repo SVG constant",
  "src/screens/canary-figure.ts": "writes the CANARY_SVG in-repo constant",
  "src/screens/idp-connections/provider-logos.ts": "writes an in-repo MARKS/FALLBACK_MARK constant selected by a closed key",
  "src/screens/integrations/marks.ts": "writes an in-repo CATALOGUE MARKS constant; the monogram fallback uses textContent",
  "src/components/dialog.ts": "writes a fixed close-icon SVG string literal",
};

// Dangerous sinks that are never permitted. Each entry: [regex, label].
const BLOCKED = /** @type {[RegExp, string][]} */ ([
  [/\.insertAdjacentHTML\s*\(/, "insertAdjacentHTML"],
  [/\.outerHTML\s*=/, "outerHTML assignment"],
  [/document\.write(ln)?\s*\(/, "document.write"],
  [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
  [/\.setHTML\s*\(/, "setHTML"],
  [/createContextualFragment\s*\(/, "createContextualFragment"],
  [/\bnew\s+Function\s*\(/, "new Function"],
  [/[^.\w]eval\s*\(/, "eval"],
]);

const INNERHTML_ASSIGN = /\.innerHTML\s*=/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Strip line comments so a mention of innerHTML in a comment is not treated as a sink. Block comments are
// rare in these files and a false negative there is caught by the audit; the common case is a // comment.
function codeOf(line) {
  const i = line.indexOf("//");
  return i === -1 ? line : line.slice(0, i);
}

// A floor on how much of src was actually read. The PASS line below counts sinks it FOUND, so an empty
// walk prints the same reassuring sentence as a clean one. The stale-exemption loop underneath is a
// partial backstop, and only a partial one: it speaks for the six allowlisted files, so a walk that lost
// everything else would still fail there for the right reason, but a walk that lost only the
// unallowlisted files (a narrowed extension test, a moved subtree) would pass while checking nothing new
// code could ever be caught by. The floor is 200, comfortably below the real file count, so ordinary
// deletion does not trip it and a collapse cannot pass.
const walked = walk(SRC);
if (walked.length < 200) {
  console.error(`XSS innerHTML-sink gate FAILED:\n  walked ${walked.length} file(s) under src, expected at least 200. The gate is not reading the console's source, so it cannot say where the HTML sinks are.`);
  process.exit(1);
}

const failures = [];
const seenInnerHtmlFiles = new Set();

for (const file of walked) {
  const rel = relative(ROOT, file).split("\\").join("/");
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, idx) => {
    const line = codeOf(raw);
    for (const [re, label] of BLOCKED) {
      if (re.test(line)) failures.push(`${rel}:${idx + 1}  BLOCKED sink (${label}): never permitted in the console`);
    }
    if (INNERHTML_ASSIGN.test(line)) {
      seenInnerHtmlFiles.add(rel);
      if (!(rel in ALLOWED_INNERHTML)) {
        failures.push(`${rel}:${idx + 1}  innerHTML write outside the trusted-constant allowlist. Render via createTextNode / h(); if this is a compile-time in-repo constant, add an ALLOWED_INNERHTML entry with a rationale.`);
      }
    }
  });
}

// Stale-exemption check: an allowlisted file that no longer writes innerHTML must be removed from the list.
for (const rel of Object.keys(ALLOWED_INNERHTML)) {
  if (!seenInnerHtmlFiles.has(rel)) {
    failures.push(`${rel}  stale ALLOWED_INNERHTML exemption: the file no longer writes innerHTML. Remove it from the allowlist.`);
  }
}

if (failures.length > 0) {
  console.error(`XSS innerHTML-sink gate FAILED:\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`XSS innerHTML-sink gate PASS (${walked.length} files read, ${seenInnerHtmlFiles.size} trusted-constant sinks, 0 blocked sinks).`);
