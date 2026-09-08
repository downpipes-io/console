// Validates that worker.ts's CSP_SCRIPT_THEME_HASH matches the ACTUAL bytes of the single
// sanctioned inline pre-paint script in public/index.html. If the script grows without
// regenerating the hash, the strict CSP silently BLOCKS the pre-paint script for every visitor:
// no theme or a11y attributes before first paint, and a CSP violation in every browser console.
// The hash and the script live in different files, so only a cross-file check can pin them
// together. Run with `node test/validate-csp-hash.ts`.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");

// Exactly ONE inline script (the sanctioned pre-paint script); a second would run un-hashed
// (blocked in production) or demand a policy widening this repo does not allow.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
ok("index.html carries exactly ONE inline script (the sanctioned pre-paint script)", scripts.length === 1);

const inline = scripts[0]?.[1] ?? "";
const actual = `sha256-${createHash("sha256").update(inline, "utf8").digest("base64")}`;

const m = worker.match(/const CSP_SCRIPT_THEME_HASH = "([^"]+)";/);
ok("worker.ts declares CSP_SCRIPT_THEME_HASH", m !== null);
const pinned = m?.[1] ?? "";
ok(
  `the pinned CSP hash matches the inline script's real bytes (${actual})`,
  pinned === actual,
);

// THE SYNTAX, not just the value: a CSP hash source must be SINGLE-QUOTED in the policy
// ('sha256-...'); a bare sha256-... token fails to parse as a source-expression and the
// browser IGNORES it ("contains an invalid source ... It will be ignored"), silently
// blocking the inline script under every hash value regardless of whether the value is correct.
// Assert the policy template interpolates the constant inside single quotes.
// The placeholder is the VALUE UNDER TEST: this assertion is about the worker template's
// un-interpolated source, so the literal here must stay a plain string and must not become a
// template literal. Named once so the suppression is stated once rather than at each use.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the un-interpolated placeholder is what is being asserted
const QUOTED_HASH_PLACEHOLDER = "'${CSP_SCRIPT_THEME_HASH}'";
ok(`the policy emits the hash SINGLE-QUOTED (${QUOTED_HASH_PLACEHOLDER})`, worker.includes(QUOTED_HASH_PLACEHOLDER));
ok(
  "no policy line emits the hash bare (unquoted interpolation)",
  !/script-src[^,\n]*[^']\$\{CSP_SCRIPT_THEME_HASH\}/.test(worker),
);
if (pinned !== actual) {
  console.log(`       pinned:  ${pinned}`);
  console.log(`       actual:  ${actual}`);
  console.log("       regenerate: node -e 'const f=require(\"fs\"),c=require(\"crypto\");const m=f.readFileSync(\"public/index.html\",\"utf8\").match(/<script>([\\s\\S]*?)<\\/script>/);console.log(\"sha256-\"+c.createHash(\"sha256\").update(m[1],\"utf8\").digest(\"base64\"))'");
}

// The external scripts the page loads must all be same-origin ('self' covers them); an
// injected third-party tag (e.g. an analytics beacon) is BLOCKED by design, never allowed in.
const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((x) => x[1]!);
ok("every external script tag is same-origin (root-relative)", srcs.every((s) => s.startsWith("/")));

console.log(failures === 0 ? "\nCSP HASH GUARD PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
