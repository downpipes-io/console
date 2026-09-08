// Validate that worker.ts ships the ASVS-required response security headers and CSP directives, pinned
// against drift: a reordering, downgrade or removal fails here. This text-pins the source (the same
// approach as validate-csp-hash.ts) rather than importing the Worker module, so it needs no CF runtime.
//
// Guards ASVS 5.0: V3.4.3 (base-uri 'none'), V3.4.7 (CSP reporting), V3.4.8 (COOP), V3.5.8 (CORP),
// V3.7.4 (HSTS preload). The checks isolate the buildCsp directive array and the withSecurityHeaders body,
// so a token that appears only in a comment elsewhere cannot satisfy a check.
//
// Run: node test/validate-security-headers.ts

import { readFileSync } from "node:fs";

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
// doc cannot silently drift from buildCsp again (the doc must not claim an `<ALLOWED_ENGINE_ORIGIN>`
// branch or an `https:` fallback that buildCsp never had). The code hardcodes connect-src 'self'; assert
// the doc says the same and carries neither stale claim.
const securityMd = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
ok("worker.ts connect-src is hardcoded 'self'", worker.includes(`const connectSrc = "'self'";`));
ok("SECURITY.md states connect-src 'self' (matches buildCsp)", /connect-src\s+'self'/.test(securityMd));
ok("SECURITY.md no longer claims a connect-src <ALLOWED_ENGINE_ORIGIN> placeholder value", !securityMd.includes("<ALLOWED_ENGINE_ORIGIN>"));
ok("SECURITY.md no longer claims a connect-src 'self' https: fallback", !/connect-src[^.]*https:/.test(securityMd));

console.log(failures === 0 ? "\nSECURITY HEADERS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
