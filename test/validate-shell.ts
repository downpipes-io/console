// Validate the XSS-critical escapeHTML helper (src/escape.ts) and the CSP builder
// (src/worker.ts buildCsp). Run with `node test/validate-shell.ts`.
// Prints one line per check; exits non-zero on any failure.
//
// Coverage:
//   escapeHTML:
//     - escapes <, >, &, double-quote, and single-quote
//     - does NOT double-escape (an already-escaped entity passes through with the
//       ampersand further escaped, not double-munged)
//     - negative control: a benign alphanumeric string is returned unchanged
//     - negative control: an empty string is returned unchanged
//     - mixed payload: every special character in a single string is escaped
//     - only the listed five characters are altered; surrounding text is untouched
//   buildCsp:
//     - produced policy contains default-src 'self'
//     - script-src is present and carries a hash token (sha256- prefix)
//     - script-src does NOT contain 'unsafe-inline'
//     - script-src does NOT contain 'unsafe-eval'
//     - style-src contains 'self' and does NOT contain 'unsafe-inline'
//     - frame-ancestors is 'none'
//     - object-src is 'none'
//     - connect-src is exactly 'self' with and without the ENGINE binding (one topology,
//       nothing to pin and no https: fallback)
//     - the entire policy contains NO 'unsafe-inline' and NO 'unsafe-eval' tokens
//   proxied topology (isEngineSurface + worker.fetch):
//     - isEngineSurface routes admin/support prefixes to the engine, with no prefix bleed
//     - worker.fetch passes Authorization through to the engine for an engine surface
//     - engine responses are returned as-is (the console CSP is not applied to them)
//     - the /engine-topology.json route is declared

import { escapeHTML } from "../src/escape.ts";
import worker, { buildCsp, isEngineSurface } from "../src/worker.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// `got` admits null because most of what this file asserts is `headers.get()`, which returns null for an
// absent header. Comparing it directly is the behaviour we want: null never equals the wanted string, so
// a missing header fails, and it prints as `null` rather than as `""`, which would be a header that IS
// present and empty. Those are different faults and the message should not blur them.
function eq(label: string, got: string | null, want: string): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// escapeHTML
// ---------------------------------------------------------------------------
console.log("\n-- escapeHTML --");

// Each special character escaped individually.
eq("< is escaped to &lt;",  escapeHTML("<"),  "&lt;");
eq("> is escaped to &gt;",  escapeHTML(">"),  "&gt;");
eq("& is escaped to &amp;", escapeHTML("&"),  "&amp;");
eq('" is escaped to &quot;', escapeHTML('"'), "&quot;");
eq("' is escaped to &#39;", escapeHTML("'"),  "&#39;");

// Negative controls: benign strings must pass through unaltered.
eq("empty string is unchanged",         escapeHTML(""), "");
eq("alphanumeric is unchanged",          escapeHTML("hello world 123"), "hello world 123");
eq("spaces and punctuation (safe chars)", escapeHTML("foo bar: baz!"), "foo bar: baz!");

// Mixed payload: every special character appears; each must be individually escaped.
eq(
  "mixed payload: all five chars escaped",
  escapeHTML(`<script>alert("x's")</script>`),
  "&lt;script&gt;alert(&quot;x&#39;s&quot;)&lt;/script&gt;",
);

// Surrounding text is preserved; only special characters are touched.
eq(
  "surrounding text is untouched",
  escapeHTML("hello <world>"),
  "hello &lt;world&gt;",
);

// No double-escape: escapeHTML on already-escaped text must NOT collapse or double-munge
// the entities. The ampersand in "&lt;" is itself a special character and is escaped to
// "&amp;", producing "&amp;lt;" -- the function makes no attempt to detect pre-escaped text,
// which is the correct behaviour (caller responsibility).
eq(
  "already-escaped text: & in entity is itself escaped (no double-munge shortcut)",
  escapeHTML("&lt;"),
  "&amp;lt;",
);

// Negative control: a URL with a query string (& present) must escape only the &.
eq(
  "URL with & in query string",
  escapeHTML("https://example.com/path?a=1&b=2"),
  "https://example.com/path?a=1&amp;b=2",
);

// ---------------------------------------------------------------------------
// buildCsp
// ---------------------------------------------------------------------------
console.log("\n-- buildCsp --");

// buildCsp takes no environment: ONE topology means the CSP is fixed (connect-src exactly
// 'self'). Two calls confirm it is stable and identical on every invocation.
const policyBound = buildCsp();
const policyBare = buildCsp();

// -- default-src 'self' is always present.
ok("with binding: default-src 'self'",   policyBound.includes("default-src 'self'"));
ok("bare env: default-src 'self'", policyBare.includes("default-src 'self'"));

// -- script-src carries a hash token (sha256-) so CSP can allow the inline theme script
//    without resorting to 'unsafe-inline'.
ok(
  "with binding: script-src contains a sha256- hash token",
  /script-src[^;]*sha256-[A-Za-z0-9+/=]+/.test(policyBound),
);
ok(
  "bare env: script-src contains a sha256- hash token",
  /script-src[^;]*sha256-[A-Za-z0-9+/=]+/.test(policyBare),
);

// -- script-src must NOT contain 'unsafe-inline' (the whole point of the hash approach).
ok(
  "with binding: script-src does NOT contain 'unsafe-inline'",
  !extractDirective(policyBound, "script-src").includes("'unsafe-inline'"),
);
ok(
  "bare env: script-src does NOT contain 'unsafe-inline'",
  !extractDirective(policyBare, "script-src").includes("'unsafe-inline'"),
);

// -- script-src must NOT contain 'unsafe-eval'.
ok(
  "with binding: script-src does NOT contain 'unsafe-eval'",
  !extractDirective(policyBound, "script-src").includes("'unsafe-eval'"),
);
ok(
  "bare env: script-src does NOT contain 'unsafe-eval'",
  !extractDirective(policyBare, "script-src").includes("'unsafe-eval'"),
);

// -- style-src 'self' and no 'unsafe-inline'.
ok("with binding: style-src contains 'self'",   extractDirective(policyBound, "style-src").includes("'self'"));
ok("bare env: style-src contains 'self'", extractDirective(policyBare, "style-src").includes("'self'"));
ok(
  "with binding: style-src does NOT contain 'unsafe-inline'",
  !extractDirective(policyBound, "style-src").includes("'unsafe-inline'"),
);
ok(
  "bare env: style-src does NOT contain 'unsafe-inline'",
  !extractDirective(policyBare, "style-src").includes("'unsafe-inline'"),
);

// -- frame-ancestors 'none' (clickjack protection).
ok("with binding: frame-ancestors 'none'",   extractDirective(policyBound, "frame-ancestors").trim() === "frame-ancestors 'none'");
ok("bare env: frame-ancestors 'none'", extractDirective(policyBare, "frame-ancestors").trim() === "frame-ancestors 'none'");

// -- object-src 'none' (no plugins).
ok("with binding: object-src 'none'",   extractDirective(policyBound, "object-src").trim() === "object-src 'none'");
ok("bare env: object-src 'none'", extractDirective(policyBare, "object-src").trim() === "object-src 'none'");

// -- connect-src: exactly 'self' in BOTH envs. One topology: there is no engine origin
//    to pin and no 'self' https: fallback that would open arbitrary https destinations.
eq("with binding: connect-src is exactly 'self'", extractDirective(policyBound, "connect-src"), "connect-src 'self'");
eq("bare env: connect-src is exactly 'self'", extractDirective(policyBare, "connect-src"), "connect-src 'self'");

// -- Whole-policy safety: neither variant must contain 'unsafe-inline' or 'unsafe-eval'
//    anywhere (not just in script-src).
ok("with binding: entire policy has NO 'unsafe-inline'",   !policyBound.includes("'unsafe-inline'"));
ok("bare env: entire policy has NO 'unsafe-inline'", !policyBare.includes("'unsafe-inline'"));
ok("with binding: entire policy has NO 'unsafe-eval'",     !policyBound.includes("'unsafe-eval'"));
ok("bare env: entire policy has NO 'unsafe-eval'",   !policyBare.includes("'unsafe-eval'"));

// ---------------------------------------------------------------------------
// The proxied topology (ENGINE service binding): connect-src collapses to 'self'
// and the worker hands the engine surface to the binding verbatim.
// ---------------------------------------------------------------------------
console.log("\n-- proxied topology (ENGINE service binding) --");

const engineStub = {
  calls: [] as Request[],
  async fetch(req: Request): Promise<Response> {
    engineStub.calls.push(req);
    return new Response(JSON.stringify({ ok: true, path: new URL(req.url).pathname }), { status: 200, headers: { "content-type": "application/json", "x-engine": "1" } });
  },
};
const assetsStub = {
  async fetch(_req: Request): Promise<Response> {
    return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
  },
};
const proxiedEnv = { ASSETS: assetsStub, ENGINE: engineStub } as never;

const policyProxied = buildCsp();
eq("proxied: connect-src is exactly 'self' (every call stays same-origin)", extractDirective(policyProxied, "connect-src"), "connect-src 'self'");

ok("isEngineSurface: /admin", isEngineSurface("/admin", "GET"));
ok("isEngineSurface: /admin/status", isEngineSurface("/admin/status", "GET"));
ok("isEngineSurface: /support/audit-feed", isEngineSurface("/support/audit-feed", "GET"));
ok("isEngineSurface: NOT /administrator (no prefix bleed)", !isEngineSurface("/administrator", "GET"));
ok("isEngineSurface: NOT /runs (an SPA route)", !isEngineSurface("/runs", "GET"));
ok("isEngineSurface: NOT / (the SPA shell)", !isEngineSurface("/", "GET"));
// /admin and /support are matched regardless of method (the engine is the authority on which verbs
// its own routes accept); /metrics (the Prometheus scrape endpoint, monitoring integrations,
// PLAN.md) is matched GET-ONLY, since the engine serves no other verb there and a
// narrower match keeps this proxy from blindly forwarding an unexpected verb to a bearer-gated,
// non-/admin route. Without this the metrics scrape credential Settings mints would be reachable in
// no deployment topology at all on the default single-hostname setup: a scrape would fall through
// to the SPA and never reach the engine.
ok("isEngineSurface: GET /metrics IS an engine surface (the scrape reachability path)", isEngineSurface("/metrics", "GET"));
ok("isEngineSurface: POST /metrics is NOT an engine surface (GET-only)", !isEngineSurface("/metrics", "POST"));
ok("isEngineSurface: NOT /metrics-typo (no prefix bleed past the exact path)", !isEngineSurface("/metrics-typo", "GET"));
ok("isEngineSurface: NOT /metrics/sub (an exact match only, no sub-path)", !isEngineSurface("/metrics/sub", "GET"));

{
  const req = new Request("https://console.example/admin/status", { headers: { authorization: "Bearer t0k", "cf-access-jwt-assertion": "jwt" } });
  const res = await worker.fetch(req, proxiedEnv);
  ok("an /admin request reaches the ENGINE binding", engineStub.calls.length === 1);
  const fwd = engineStub.calls[0]!;
  eq("the proxied request keeps its path", new URL(fwd.url).pathname, "/admin/status");
  eq("Authorization passes through verbatim", fwd.headers.get("authorization"), "Bearer t0k");
  eq("the Access JWT header passes through verbatim", fwd.headers.get("cf-access-jwt-assertion"), "jwt");
  ok("the engine response returns untouched (its own headers, no console CSP layered on)", res.headers.get("x-engine") === "1" && res.headers.get("content-security-policy") === null);
}
{
  // The metrics scrape reachability path (monitoring integrations, PLAN.md): a GET
  // /metrics request, carrying the minted "metrics"-scope bearer, must reach the ENGINE binding on
  // the default single-hostname topology exactly like /admin and /support, or the whole zero-setup
  // scrape story is dead on arrival (the scraper would hit the SPA shell instead of the engine).
  engineStub.calls.length = 0;
  const req = new Request("https://console.example/metrics", { headers: { authorization: "Bearer dpc_x.dps_y" } });
  const res = await worker.fetch(req, proxiedEnv);
  ok("a GET /metrics request reaches the ENGINE binding", engineStub.calls.length === 1);
  const fwd = engineStub.calls[0]!;
  eq("the proxied request keeps its path", new URL(fwd.url).pathname, "/metrics");
  eq("the scrape credential's bearer passes through verbatim", fwd.headers.get("authorization"), "Bearer dpc_x.dps_y");
  ok("the engine response returns untouched (its own headers, no console CSP layered on)", res.headers.get("x-engine") === "1" && res.headers.get("content-security-policy") === null);
}
{
  // A non-GET /metrics must NOT reach the engine (GET-only surface): it falls through to the SPA
  // path like any unmatched route, never silently forwarded to a bearer-gated route on an
  // unexpected verb.
  engineStub.calls.length = 0;
  const res = await worker.fetch(new Request("https://console.example/metrics", { method: "POST" }), proxiedEnv);
  ok("a POST /metrics request does NOT reach the ENGINE binding", engineStub.calls.length === 0);
  ok("a POST /metrics falls through to the SPA path (console CSP applied)", res.headers.get("content-security-policy") !== null);
}
{
  // Asserts the engine call COUNT IS UNCHANGED (rather than a magic absolute number) so this check
  // stays correct regardless of how many engine-reaching tests ran earlier in this file.
  const callsBefore = engineStub.calls.length;
  const res = await worker.fetch(new Request("https://console.example/runs"), proxiedEnv);
  ok("an SPA route still serves assets with the console CSP", res.headers.get("content-security-policy") !== null && engineStub.calls.length === callsBefore);
}

// The topology declaration the SPA adopts at boot: proxied consoles say so, split
// consoles say not, both carry the security headers and are never cached.
{
  const res = await worker.fetch(new Request("https://console.example/engine-topology.json"), proxiedEnv);
  const body = (await res.json()) as { proxied?: boolean };
  ok("topology route declares proxied:true when ENGINE is bound", res.status === 200 && body.proxied === true);
  ok("topology route is JSON and never cached", (res.headers.get("content-type") ?? "").includes("application/json") && res.headers.get("cache-control") === "no-store");
  ok("topology route carries the security headers", res.headers.get("content-security-policy") !== null);
  const splitEnv = { ASSETS: assetsStub } as never;
  const res2 = await worker.fetch(new Request("https://console.example/engine-topology.json"), splitEnv);
  const body2 = (await res2.json()) as { proxied?: boolean };
  ok("topology route declares proxied:false without the binding", body2.proxied === false);
}

// CACHE-CONTROL per asset class (the no-hard-refresh fix): the STABLE-named SPA shell (index.html, app.js,
// tokens.css) must revalidate so a deployed console update lands on the next ordinary load / the flow's
// auto-reload; content-hashed bundles (chunk-<hash>.js, whose name changes every build) are safe to cache
// forever. This is what stopped "console updated but the page still shows the old one until a hard refresh".
{
  const shell = await worker.fetch(new Request("https://console.example/app.js"), proxiedEnv);
  eq("app.js (stable name) is served no-cache so a new build is picked up without a hard refresh", shell.headers.get("cache-control"), "no-cache");
  const spaRoot = await worker.fetch(new Request("https://console.example/"), proxiedEnv);
  eq("the SPA shell at / revalidates too (no-cache)", spaRoot.headers.get("cache-control"), "no-cache");
  const chunk = await worker.fetch(new Request("https://console.example/chunk-N7GP7C5W.js"), proxiedEnv);
  eq("a content-hashed chunk is immutable (its name changes per build, so cache forever)", chunk.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const buildJson = await worker.fetch(new Request("https://console.example/__build.json"), proxiedEnv);
  eq("__build.json (the update flow's version probe) is never cached", buildJson.headers.get("cache-control"), "no-store");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
// This MUST be the last executable statement in the file: every assertion above
// (including the proxied-topology and worker.fetch blocks) has already run, so a
// failure ANYWHERE yields a non-zero exit. An earlier gate would let later blocks
// fail silently with a zero exit.
console.log(failures === 0 ? "\nSHELL UNIT VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns an empty string if the directive is not present (which will cause the relevant
// assertion to fail, surfacing the gap clearly).
function extractDirective(policy: string, name: string): string {
  for (const part of policy.split(";")) {
    if (part.trim().startsWith(name)) return part.trim();
  }
  return "";
}
