// Validate that worker.ts ships the ASVS-required response security headers and CSP directives, pinned
// against drift: a reordering, downgrade or removal fails here. This text-pins the source (the same
// approach as validate-csp-hash.ts) rather than importing the Worker module, so it needs no CF runtime.
//
// Guards ASVS 5.0 V3.4.3 (base-uri 'none'), V3.4.7 (CSP reporting), V3.4.8 (COOP),
// V3.5.8 (CORP), V3.7.4 (HSTS preload). The checks isolate the buildCsp directive array and the
// withSecurityHeaders body, so a token that appears only in a comment elsewhere cannot satisfy a check.
//
// ALSO guards V3.1.1 (browser-requirements documentation): the docs/reference/browser-requirements.mdx
// page states what a browser must support and what the console does when a feature is missing, and this
// file pins that page and engine/docs/REVIEW-PACK.md against that exact drift: a stale
// `ALLOWED_ENGINE_ORIGIN` step left behind when buildCsp went to a hardcoded 'self'. The docs
// and engine checks are CROSS-REPO: they read a sibling checkout the same way test/engine-path.ts does
// for every other cross-repo gate here, and print an explicit skip note (not a failure) when the sibling
// is not beside this repo, which is the ordinary case for a single-repo console clone. Point them at a
// specific checkout with DOWNPIPES_DOCS=/path/to/docs and DOWNPIPES_ENGINE=/path/to/engine.
//
// Run: node test/validate-security-headers.ts
//
// SIBLING-SUPPLY: the docs pin below degrades to a printed skip, not a failure, when no docs checkout
// is beside this repo (the ordinary case for a single-repo console clone); it runs in no chain that
// supplies the docs sibling, so it is declared here rather than silently reading as a pass either way.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engineRoots } from "./engine-path.ts";
import { findWorkspaceDir } from "../scripts/workspace-root.mjs";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import { PASSKEY_UNSUPPORTED_MESSAGE } from "../src/screens/passkey.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");

// Isolate the two security-relevant function bodies.
const csp = worker.match(/export function buildCsp[\s\S]*?\]\.join\("; "\)/)?.[0] ?? "";
const headersFn = worker.match(/function withSecurityHeaders[\s\S]*?\n}/)?.[0] ?? "";

ok("buildCsp body located", csp.length > 0);
ok("withSecurityHeaders body located", headersFn.length > 0);

// CSP directives (V3.4.3 base-uri 'none'; V3.4.7 reporting; tight policy preserved).
ok("CSP base-uri is 'none' (V3.4.3 L2)", csp.includes(`"base-uri 'none'"`));
ok("CSP no longer carries base-uri 'self'", !csp.includes(`"base-uri 'self'"`));
ok("CSP keeps object-src 'none'", csp.includes(`"object-src 'none'"`));
ok("CSP keeps frame-ancestors 'none'", csp.includes(`"frame-ancestors 'none'"`));
ok("CSP connect-src stays 'self'", worker.includes(`const connectSrc = "'self'";`));
ok("CSP declares report-uri /csp-report (V3.4.7)", csp.includes(`"report-uri /csp-report"`));
ok("CSP declares report-to csp-endpoint (V3.4.7)", csp.includes(`"report-to csp-endpoint"`));

// Response headers (V3.4.8 COOP; V3.5.8 CORP; V3.7.4 HSTS preload; reporting endpoint group).
ok("COOP same-origin is set (V3.4.8)", headersFn.includes(`headers.set("cross-origin-opener-policy", "same-origin")`));
ok("CORP same-origin is set (V3.5.8)", headersFn.includes(`headers.set("cross-origin-resource-policy", "same-origin")`));
ok("HSTS carries the preload directive (V3.7.4)", /strict-transport-security[\s\S]*?preload/.test(headersFn));
ok("Reporting-Endpoints declares csp-endpoint -> /csp-report", headersFn.includes("reporting-endpoints") && headersFn.includes(`/csp-report`));

// The same-origin report sink the CSP names must exist as a real 204 route.
ok("a POST /csp-report 204 sink route exists", /pathname === "\/csp-report"[\s\S]*?status: 204/.test(worker));

// DOC-VS-CODE PIN (ASVS V3.1.1): SECURITY.md must describe the connect-src the code actually ships, so the
// doc cannot silently drift from buildCsp again (that exact drift: the doc claimed an
// `<ALLOWED_ENGINE_ORIGIN>` branch + an `https:` fallback that buildCsp never had). The code hardcodes
// connect-src 'self'; assert the doc says the same and carries neither stale claim.
const securityMd = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
ok("worker.ts connect-src is hardcoded 'self'", worker.includes(`const connectSrc = "'self'";`));
ok("SECURITY.md states connect-src 'self' (matches buildCsp)", /connect-src\s+'self'/.test(securityMd));
ok("SECURITY.md no longer claims a connect-src <ALLOWED_ENGINE_ORIGIN> placeholder value", !securityMd.includes("<ALLOWED_ENGINE_ORIGIN>"));
ok("SECURITY.md no longer claims a connect-src 'self' https: fallback", !/connect-src[^.]*https:/.test(securityMd));

// docsRoots resolves the docs sibling through the shared workspace resolver (scripts/workspace-root.mjs),
// which refuses a stray checkout under a .worktrees segment and honours DOWNPIPES_WORKSPACE; DOWNPIPES_DOCS
// is read first because a caller who names the docs checkout directly has more information than any walk.
const HERE = new URL(".", import.meta.url).pathname;
const DOCS_MARKER = join("docs", "src", "content", "docs");
function docsRoots(fromDir: string): string[] {
  const override = process.env.DOWNPIPES_DOCS;
  if (override !== undefined && override !== "") return [override];
  const workspace = findWorkspaceDir(fromDir, DOCS_MARKER);
  return workspace === null ? [] : [join(workspace, "docs")];
}
function firstExisting(roots: string[], rel: string): string | null {
  for (const root of roots) {
    const p = `${root}/${rel}`;
    if (existsSync(p)) return p;
  }
  return null;
}

// DOC-VS-CODE PIN (ASVS V3.1.1): the browser-requirements docs page must state the same connect-src,
// HSTS and passkey-unsupported facts the code ships, so it cannot silently drift the way REVIEW-PACK.md
// did. CROSS-REPO: skips with a note (not a failure) when no docs checkout is beside this repo.
console.log("\n-- doc-vs-code pin: reference/browser-requirements.mdx (V3.1.1) --");
const docsMdxPath = firstExisting(docsRoots(HERE), "src/content/docs/reference/browser-requirements.mdx");
if (docsMdxPath === null) {
  console.log(
    "  note no docs checkout found beside this repo (tried DOWNPIPES_DOCS, then ../docs from the workspace\n" +
      "       root); skipping the browser-requirements doc-vs-code pin. Set DOWNPIPES_DOCS=/path/to/docs, or\n" +
      "       run with the docs worktree beside this repo, to exercise this block.",
  );
} else {
  console.log(`  docs read from ${docsMdxPath}`);
  const mdx = readFileSync(docsMdxPath, "utf8");
  ok("browser-requirements.mdx states connect-src 'self'", mdx.includes("connect-src 'self'"));
  ok("browser-requirements.mdx carries no <ALLOWED_ENGINE_ORIGIN> placeholder", !mdx.includes("<ALLOWED_ENGINE_ORIGIN>"));
  ok("browser-requirements.mdx carries no connect-src 'self' https: fallback", !/connect-src[^.]*https:/.test(mdx));
  ok("browser-requirements.mdx states the HSTS max-age (matches worker.ts)", mdx.includes("max-age=63072000"));
  ok("browser-requirements.mdx states the preload directive (matches worker.ts)", mdx.includes("preload"));
  ok(
    "browser-requirements.mdx quotes the exact passkey-unsupported banner (one source with passkey.ts)",
    mdx.includes(PASSKEY_UNSUPPORTED_MESSAGE),
  );
}

// DOC-VS-CODE PIN (ASVS V3.1.1): engine/docs/REVIEW-PACK.md must not carry the stale ALLOWED_ENGINE_ORIGIN
// step the assessment found. CROSS-REPO: skips with a note (not a failure) when no engine checkout is
// beside this repo.
console.log("\n-- doc-vs-code pin: engine/docs/REVIEW-PACK.md carries no stale ALLOWED_ENGINE_ORIGIN claim (V3.1.1) --");
const reviewPackPath = firstExisting(engineRoots(HERE), "docs/REVIEW-PACK.md");
if (reviewPackPath === null) {
  console.log(
    "  note no engine checkout found beside this repo; skipping the REVIEW-PACK.md staleness check.\n" +
      "       Set DOWNPIPES_ENGINE=/path/to/engine, or run with the engine worktree beside this repo, to\n" +
      "       exercise this block.",
  );
} else {
  console.log(`  engine read from ${reviewPackPath}`);
  const reviewPack = readFileSync(reviewPackPath, "utf8");
  ok("engine/docs/REVIEW-PACK.md no longer claims an ALLOWED_ENGINE_ORIGIN step", !reviewPack.includes("ALLOWED_ENGINE_ORIGIN"));
}

console.log(failures === 0 ? "\nSECURITY HEADERS PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
