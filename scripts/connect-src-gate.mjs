// connect-src gate: every network call the SPA makes must be reachable under its own CSP.
//
// WHY THIS EXISTS. buildCsp() (src/worker.ts) sets connect-src to exactly 'self'. A control that
// fetches a foreign origin anyway is blocked by the browser before the network, and ships dead with
// nothing server-side to say why. Two concrete shapes of this:
//
//   licence claim-code activation   a fetch straight to https://control.downpipes.io, which is the
//                                   ONLY way a customer activates a licence
//   a release-record cross-check    a fetch straight to the channel host, whose one reachable error
//                                   line would blame that host for the console's own policy
//
// Neither shape is caught by a test, because the tests that cover those paths replace globalThis.fetch,
// so the policy is never in the path. A unit test cannot see a CSP. This gate closes that specific hole:
// it reads the connect-src the code actually ships and refuses any fetch target that cannot satisfy
// it, so a control shaped like either of these cannot be added unnoticed.
//
// WHAT IT CHECKS. Every fetch()/EventSource/WebSocket call site under src/, by its first argument:
//   PASS  a same-origin path: "/admin/status", `/admin/runs/${id}`, or a bare relative expression
//   FAIL  an absolute URL literal: "https://host/..."
//   FAIL  a target built from a base-like identifier (fooBase, fooOrigin, fooHost, fooEndpoint),
//         which is how the release-record cross-check reached off-origin without any literal to grep
//
// An entry in ALLOW must name the file and give the reason. There is deliberately no wildcard.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = join(ROOT, "src");
const ENFORCE = process.argv.includes("--enforce");

// file -> reason. A call site here is exempt; every entry is a decision on the record.
const ALLOW = new Map([
  [
    "src/worker.ts",
    "the SERVER side. connect-src is a browser policy and does not govern a fetch made by the Worker itself; the claim proxy deliberately holds the vendor origin here, which is the whole point of routing the browser through it",
  ],
  [
    "src/lib/api/client-idp.ts",
    "builds the console's OWN redirect URIs (oidc/callback, saml/acs) from consoleOrigin(), for the operator to paste into their IdP. Displayed, never fetched, and same-origin by construction anyway",
  ],
  [
    "src/screens/sources-downpipes/editor-wizard.ts",
    "endpointHost appears in the wizard's plain-English destination summary line. Display text, not a URL and not a fetch",
  ],
  [
    "src/lib/demo/demo-fetch.ts",
    "the demo data plane answers requests in-browser and issues no network call of its own; any URL here is a route key, never a fetch target",
  ],
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The connect-src the code actually ships, read from the source rather than assumed.
const worker = readFileSync(join(SRC, "worker.ts"), "utf8");
const m = /const connectSrc = "([^"]+)";/.exec(worker);
if (m === null) {
  console.error("[connect-src] FATAL: could not read connectSrc from src/worker.ts; the gate has nothing to check against.");
  process.exit(2);
}
const connectSrc = m[1];
const selfOnly = connectSrc.trim() === "'self'";

// Matches fooBase, FOO_BASE, fooOrigin, FOO_ORIGIN and so on. The all-caps form matters: a target
// built from a SCREAMING_CASE constant such as CONTROL_PLANE_BASE is exactly the shape a
// camelCase-only pattern would miss.
const BASE_IDENT = /\b[A-Za-z_$][A-Za-z0-9_$]*[_]?(Base|BASE|Origin|ORIGIN|Host|HOST|Endpoint|ENDPOINT)\b/;
const findings = [];

// The two numbers the verdict below actually rests on, counted rather than assumed. Zero findings is
// the same sentence whether the gate read every network call and cleared them, or read none at all,
// and only one of those is a pass. Both collapses are ordinary refactors, not sabotage: change the
// extension the walk accepts, or move src/, and walked goes to zero; route every browser call through
// one helper (which is a reasonable thing to do) and the fetch regex stops matching at the call sites
// it was written to read, because the only literal target left is inside the helper.
const walked = walk(SRC);
let callSites = 0;

for (const abs of walked) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  if (ALLOW.has(rel)) continue;
  const src = readFileSync(abs, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const call = /\b(fetch|EventSource|WebSocket)\s*\(\s*([^,)]*)/.exec(line);
    if (call === null) continue;
    callSites++;
    const target = call[2];
    if (target.includes("://")) {
      findings.push({ rel, line: i + 1, why: "absolute URL in the fetch target", text: trimmed.slice(0, 110) });
      continue;
    }
    const baseName = BASE_IDENT.exec(target);
    if (baseName !== null) {
      // Value-aware: a base constant assigned "" or a "/..." path in this same file is same-origin by
      // construction, which is exactly the shape same-origin routing through the Worker produces.
      const assigned = new RegExp(`(?:const|let|var)\\s+${baseName[0]}\\s*(?::[^=]+)?=\\s*(["'\`])([^"'\`]*)\\1`).exec(src);
      if (assigned !== null && (assigned[2] === "" || assigned[2].startsWith("/"))) {
        // same-origin; fall through to the remaining checks
      } else {
        findings.push({ rel, line: i + 1, why: "target built from a base/origin/host identifier, which can hold a foreign origin", text: trimmed.slice(0, 110) });
      }
    }
  }

  // Second pass, and the one that catches the harder shape. A fetch can be one indirection from the
  // origin decision: the release-record cross-check fetches a `url` PARAMETER, so its call site has no
  // literal and no base-like name to see. So flag URL CONSTRUCTION from a base/origin/host identifier
  // anywhere in the file, not only at a fetch. `t.base` and friends are deliberately not matched: the
  // suffix must be capitalised, so the engine's own base (the console's normal same-origin idiom under
  // the proxied topology) does not trip this.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!BASE_IDENT.test(line)) continue;
    const buildsUrl = /(Base|BASE|Origin|ORIGIN|Host|HOST|Endpoint|ENDPOINT)\s*\+|\$\{[^}]*(Base|BASE|Origin|ORIGIN|Host|HOST|Endpoint|ENDPOINT)[^}]*\}/.test(line);
    if (!buildsUrl) continue;
    // connect-src governs FETCHES, not navigations or text. An href is a navigation and is allowed to
    // leave the origin; a comparison or a display string is not a network call at all. Excluding these
    // keeps the gate on the one thing it is for, rather than making it noisy enough to be ignored.
    const isNavigationOrText = /\bhref\b|===|!==|\.startsWith\(|\.includes\(|getText|placeholder|textContent/.test(line);
    if (isNavigationOrText) continue;
    // Same value-awareness as the fetch-target pass: a base constant assigned "" or a "/..." path in
    // this file is same-origin by construction.
    const nameMatch = BASE_IDENT.exec(line);
    if (nameMatch !== null) {
      const assigned = new RegExp(`(?:const|let|var)\\s+${nameMatch[0]}\\s*(?::[^=]+)?=\\s*(["'\`])([^"'\`]*)\\1`).exec(src);
      if (assigned !== null && (assigned[2] === "" || assigned[2].startsWith("/"))) continue;
    }
    if (findings.some((f) => f.rel === rel && f.line === i + 1)) continue;
    findings.push({ rel, line: i + 1, why: "a URL is built from a base/origin/host identifier, which can hold a foreign origin", text: trimmed.slice(0, 110) });
  }

  // Third pass: a hardcoded absolute origin bound to a constant. This is worth catching on its own
  // rather than only where the constant is later used, since a hardcoded foreign-origin constant is
  // exactly how a control such as licence claim-code activation could bind a fetch target outside the
  // shipped policy. Documentation links are excluded: an href is a navigation, which connect-src does
  // not govern.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!/^\s*(const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(:[^=]+)?=\s*["'`]https?:\/\//.test(line)) continue;
    // Not network calls: XML/SVG namespace URIs are identifiers, and an href is a navigation, which
    // connect-src does not govern.
    if (/\bhref\b|docs\.downpipes\.io|www\.w3\.org/.test(line)) continue;
    const declared = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
    if (declared !== null && new RegExp(`\\b${declared[1]}\\b`).test(src.replace(line, "")) === false) continue;
    if (declared !== null && new RegExp(`href[^\\n]*\\b${declared[1]}\\b`).test(src)) continue;
    if (findings.some((f) => f.rel === rel && f.line === i + 1)) continue;
    findings.push({ rel, line: i + 1, why: "a foreign origin is hardcoded as a constant", text: trimmed.slice(0, 110) });
  }
}

// FLOORS, checked before the verdict is printed so an empty scan can never reach the OK line. The
// floors are set at 200 files and 4 call sites, low enough that neither a normal round of deletions nor
// a helper that absorbs a couple of call sites trips them, high enough that a collapse to nothing
// cannot be reported as a clean policy. Exit 2, matching the connectSrc FATAL above: this is the gate
// saying it could not check, which is a different fact from the gate saying it found no fault.
if (walked.length < 200) {
  console.error(`[connect-src] FATAL: walked ${walked.length} source files, expected at least 200. The walk is no longer reading the console's source, so nothing here is a verdict on the shipped policy.`);
  process.exit(2);
}
if (callSites < 4) {
  console.error(`[connect-src] FATAL: matched ${callSites} fetch/EventSource/WebSocket call site(s) outside ALLOW, expected at least 4.`);
  console.error("Either the calls now go through a helper the fetch pass cannot see, or the pattern has stopped matching the way this repo writes them. Teach the pattern the new shape before trusting this gate again.");
  process.exit(2);
}

console.log(`[connect-src] shipped connect-src is ${connectSrc}${selfOnly ? " (same-origin only)" : ""}; ${walked.length} files walked, ${callSites} call site(s) read, ${findings.length} off-origin fetch target(s), ${ALLOW.size} allowed`);
if (findings.length > 0) {
  console.log("\nFETCH TARGETS THAT CANNOT SATISFY THE SHIPPED connect-src:");
  for (const f of findings) console.log(`  ${f.rel}:${f.line}  ${f.why}\n    ${f.text}`);
  console.log("\nRoute it through a same-origin path on the console Worker (see isControlPlaneSurface in src/worker.ts),");
  console.log("or make it a navigation rather than a fetch, or add the file to ALLOW in this gate with a reason.");
}
if (ENFORCE && findings.length > 0) {
  console.error(`\n[connect-src] FAIL (enforce): ${findings.length} fetch target(s) the browser will block.`);
  process.exit(1);
}
console.log(findings.length === 0 ? "[connect-src] OK: every network call is reachable under the shipped policy." : "[connect-src] report mode: not failing the build.");
