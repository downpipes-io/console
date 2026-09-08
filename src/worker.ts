// The console Worker serves the static SPA from the ASSETS binding, with a single-page
// fallback to index.html for client-routed paths. It holds no state and proxies nothing
// to the vendor; the SPA calls the in-account engine admin API directly from the browser.
//
// HARDENING: every served response carries a strict Content-Security-Policy
// plus the supporting security headers, so the restore-capable admin console cannot be framed,
// cannot load third-party code, and confines its network calls to the in-account engine over
// https. This matters because the break-glass private key is generated in THIS browser and never
// leaves it (Appendix A): a strict script-src is what stops injected script from exfiltrating it.
//
// The recovery sheet popup was previously opened via window.open('','_blank') + document.write,
// which shares the parent browsing context and therefore inherits this CSP, requiring
// 'unsafe-hashes' to allow the print button's onclick handler. It is now opened as a blob: URL
// via <a target=_blank rel=noopener> (see onboarding-ceremony.ts
// openRecoverySheet and keys.ts). A blob: URL navigated to in a NEW top-level browsing context
// is served with no HTTP headers of its own, so the console's header-delivered CSP does not
// propagate to it. The blob document runs with a null origin and no inherited policy, so the
// print button's addEventListener script (recovery-sheet.ts:128) requires no CSP exemption here
// and 'unsafe-hashes' is removed, making script-src tighter.

import { type LogFields, log } from "./log.ts";
// ENGINE_BINDING_ABSENT (G152) is the frozen code this worker answers with when an engine-surface path arrives and
// the ENGINE service binding is not bound, and the SAME constant the browser half admits by equality. Imported
// rather than re-declared: two mirrored string literals are a drift waiting to happen, and this one is the only
// thing that tells a console deployed without its binding apart from an engine that is genuinely down. lib/errors
// is import-free and DOM-free, so the worker bundle takes nothing else with it.
import { ENGINE_BINDING_ABSENT, ENGINE_BINDING_ABSENT_HEADER, CONSOLE_ORIGIN_FAULT, CONSOLE_ORIGIN_FAULT_HEADER } from "./lib/errors.ts";

// Minimal binding type so this DOM-typed project does not need to pull in the full
// Worker type set just for the assets fetcher.
interface AssetFetcher {
  fetch(req: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
  // ENVIRONMENT, when bound, names the deploy environment for structured logs (see log.ts).
  // It is optional: when unbound the log helper records env "unknown" and nothing else changes.
  ENVIRONMENT?: string;
  // ENGINE, when bound, is the worker-to-worker SERVICE BINDING to the in-account
  // engine, and selects the DEFAULT single-hostname topology: the console proxies the
  // engine surface same-origin (/admin/*, /support/* and GET /metrics), the engine needs NO
  // public hostname at all (cron and Durable Objects run without one), the browser's calls
  // never leave this origin, and connect-src collapses to 'self'. The proxy forwards
  // the request VERBATIM (method, path, query, headers including Authorization and
  // cf-access-jwt-assertion, body); the engine's own auth remains the sole authority,
  // so this adds reachability hiding on top of, never instead of, authentication.
  ENGINE?: EngineService;
  // TOUR_ANALYTICS, when bound, is the Workers Analytics Engine dataset for the public, no-login product
  // tour's self-hosted funnel events. ONLY the tour deploy (wrangler.public-demo.toml) binds it; the genuine
  // console and the engine-proxied console never do. The tour's browser half POSTs small, PII-free events to
  // the same-origin /tour/event route below, which records them through this binding. Optional: with no
  // binding (every non-tour deploy) /tour/event is a harmless 204 no-op, so the real console is unaffected.
  TOUR_ANALYTICS?: AnalyticsEngineDataset;
}

// EngineService is the service-binding fetcher (worker-to-worker, never the network).
interface EngineService {
  fetch(req: Request): Promise<Response>;
}

// AnalyticsEngineDataset is the minimal shape of a Workers Analytics Engine binding (a single fire-and-forget
// writeDataPoint sink), declared locally so this DOM-typed project does not pull in the full Worker type set.
interface AnalyticsEngineDataset {
  writeDataPoint(event: { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

// CSP_SCRIPT_THEME_HASH is the sha256 of the SINGLE sanctioned inline pre-paint theme script in
// public/index.html. It is allowed by hash, NOT by 'unsafe-inline', so no
// other inline script can run. If that inline script's bytes change, regenerate this hash with:
//   node -e 'const f=require("fs"),c=require("crypto");const m=f.readFileSync("public/index.html","utf8").match(/<script>([\s\S]*?)<\/script>/);console.log("sha256-"+c.createHash("sha256").update(m[1],"utf8").digest("base64"))'
//
// The recovery sheet's print button previously required a second hash here ('unsafe-hashes' +
// the sha256 of 'window.print()'). That is no longer needed: the recovery sheet is now opened
// via <a target=_blank rel=noopener href="blob:..."> into a new top-level browsing context.
// Header-delivered CSPs do not propagate to new top-level blob: navigations, so the blob
// document receives no policy from this header and its addEventListener script runs without
// any CSP exemption on the console side.
// DRIFT GUARD LESSON: this hash previously went stale when the inline script grew
// (the a11y pre-paint block) without being regenerated, so production silently BLOCKED the
// pre-paint script for every visitor (no theme/a11y attributes before first paint, a CSP
// violation in every console). A build-time check now pins this constant to the real bytes.
// TOUR_EVENT_NAMES / TOUR_VALUE_RE are the /tour/event sink's redaction boundary (G337 / G338). The route is a
// public, unauthenticated POST, so the sink must decide for itself what may enter the owner's Analytics Engine
// dataset rather than trusting the poster. The names mirror the browser half's closed set
// (lib/demo/tour/analytics.ts); they are duplicated here deliberately, because the Worker bundle is built
// separately from the SPA bundle and importing across that seam would pull the whole tour subtree into the
// Worker. The shape gate admits a route pattern, a chapter id, an anchor id and a closed kind, and admits
// nothing that is a sentence, a URL, an email or markup.
const TOUR_EVENT_NAMES: ReadonlySet<string> = new Set([
  "tour_started",
  "persona_chosen",
  "step_reached",
  "drop_step",
  "cta_clicked",
  "demo_drift",
  "tour_degraded",
]);
// TOUR_SEGMENT_RE is the shape of ONE segment of a tour value: a lower-case product word, optionally led by a
// colon (the ":id" placeholder normaliseAdminPattern substitutes for anything it does not recognise). The colon
// is LEADING ONLY, which is what makes a URL scheme unrepresentable: "https:" carries its colon at the end and
// fails, so "https://host/path" cannot pass however its segments are split.
const TOUR_SEGMENT_RE = /^:?[a-z0-9._-]{1,32}$/;
const TOUR_MAX_SEGMENTS = 8;
const TOUR_MAX_VALUE_LEN = 64;

// tourValueOk gates a blob by SHAPE. The old gate was a single character-class regex, /^[a-z0-9:/._-]{0,64}$/,
// under a comment claiming it "cannot admit a sentence, a URL with a scheme, an email or an HTML fragment". The
// claim was false: "https://evil.example/x" is composed entirely of characters in that class and passed clean.
// The sink is the owner's own Analytics Engine and there is no customer pack behind the tour, so nothing leaked;
// the COMMENT was the defect, and a gate whose stated guarantee is not its actual guarantee is worse than an
// honest one. This checks the value's STRUCTURE instead: every slash-separated segment must be a product word,
// so a scheme, an "@", a space, a "<" and a query string are all unrepresentable rather than merely unlikely.
const tourValueOk = (v: string): boolean => {
  if (v === "" || v.length > TOUR_MAX_VALUE_LEN) return v === "";
  const segments = v.split("/");
  if (segments.length > TOUR_MAX_SEGMENTS) return false;
  // A leading slash yields an empty first segment ("/admin/rto"), and a bare "/" (the Overview chapter route)
  // yields two: an empty segment is admitted only as that structural artefact, never as content.
  return segments.every((seg, i) => (seg === "" ? i === 0 || i === segments.length - 1 : TOUR_SEGMENT_RE.test(seg)));
};

const CSP_SCRIPT_THEME_HASH = "sha256-wi8HDXLduJpgrdvnlXCdBnf/URqEupR9bXzfDTzwfm4=";

// buildCsp assembles the Content-Security-Policy string. It takes no environment: there is one
// topology (the ENGINE service binding keeps every browser call same-origin), so the policy is
// fixed. If per-env CSP logic is ever reintroduced, re-add the parameter at that point.
// Each directive is listed explicitly so every choice is auditable.
//
//  - default-src 'self'            everything defaults to same-origin (no third-party anything).
//  - script-src                    same-origin bundle (/app.js) plus the sanctioned inline
//                                  theme-script hash; NO 'unsafe-inline' and NO 'unsafe-hashes',
//                                  so injected script cannot run (the control that protects the
//                                  in-browser break-glass key). The recovery sheet is opened as a
//                                  blob: URL, which gives it its own opaque origin independent of
//                                  this policy, so the print button's addEventListener script in the
//                                  sheet requires no CSP exemption on the console side.
//  - style-src 'self'              tokens.css loads same-origin and is the ONLY stylesheet. The
//                                  bundle applies all dynamic styling through the CSSOM (the h()
//                                  builder uses node.style.setProperty per property, and the screens
//                                  use node.style.x = directly), which CSP does NOT gate, so no
//                                  inline style ATTRIBUTE is ever written and no 'unsafe-inline' is
//                                  needed. No <style> element is injected (the overview rules live in
//                                  tokens.css; the recovery sheet is a separate blob document with its
//                                  own opaque origin). The policy now carries no unsafe-* anywhere.
//  - connect-src 'self'            every browser call stays on this origin: the worker proxies the
//                                  engine surface (/admin/*, /support/*, GET /metrics) over the
//                                  ENGINE service binding, so the tightest achievable policy is
//                                  also the only one.
//  - img-src 'self' data:          same-origin plus inline data: images; no third-party images.
//  - font-src 'self'               no web fonts/CDN (the system font stack is used).
//  - frame-ancestors 'none'        the console cannot be embedded/clickjacked.
//  - base-uri 'none'               no <base> element is honoured (the shell uses absolute asset URLs), so an
//                                  injected <base> cannot repoint relative URLs off-origin.
//  - form-action 'self'            forms cannot post off-origin.
//  - object-src 'none'             no plugins/embeds.
//
// NATIVE EXTERNAL-IdP SSO (OIDC / OAuth2 / SAML) NEEDS NO CSP CHANGE. The "Sign in with X" buttons on the
// sign-in screen do a TOP-LEVEL window.location navigation to the engine's own start URL
// (/admin/oidc/start/<id> or /admin/saml/start/<id>, same-origin via the engine proxy), and the engine
// 302s the browser onward to the IdP. A full-document navigation is governed by NEITHER connect-src (that
// gates fetch/XHR/WebSocket, not the document's own location) NOR form-action (no off-origin <form> post
// is made, the console never posts to the IdP; the IdP's SAML ACS POST lands on the ENGINE, a different
// origin with its own headers). The privileged code<->token exchange is entirely server-side in the
// engine, so the console never opens a cross-origin connection and connect-src 'self' / form-action 'self'
// stay exactly as tight as before. The redirect_uri / ACS the IdP calls back to is the engine's host, not
// this console origin, so frame-ancestors and the rest are unaffected too.
export function buildCsp(): string {
  // One topology: the ENGINE service binding keeps every browser call same-origin, so
  // connect-src is exactly 'self', the tightest policy the console can carry. (There is no
  // split topology and no engine hostname to pin.)
  const connectSrc = "'self'";

  return [
    "default-src 'self'",
    // The hash source MUST be single-quoted ('sha256-...'): CSP keyword/hash/nonce sources are
    // quoted, and a BARE sha256-... token fails to parse as a source and is IGNORED by the
    // browser ("contains an invalid source ... It will be ignored"). This exact omission
    // shipped on day one and silently blocked the sanctioned inline pre-paint script under
    // EVERY hash value until an owner walkthrough pasted the console warning;
    // validate-csp-hash.ts now pins the quoted form.
    `script-src 'self' '${CSP_SCRIPT_THEME_HASH}'`,
    "style-src 'self'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    // CSP violation reporting (ASVS V3.4.7): report-uri is the broadly-supported sink; report-to names the
    // endpoint group declared by the Reporting-Endpoints response header (the modern replacement). Both point
    // at the same-origin 204 /csp-report route, so a blocked injection is observable rather than silent.
    "report-uri /csp-report",
    "report-to csp-endpoint",
  ].join("; ");
}

// withSecurityHeaders returns a copy of the response with the security headers applied. The body and
// status are preserved; the asset's own content-type and cache headers are kept, and the security
// headers are layered on top (overwriting any that ASSETS might set). A new Response is built because
// an ASSETS response's headers can be immutable.
//
// The supporting security headers applied are:
//  - Content-Security-Policy       per-tenant, built by buildCsp (see above).
//  - X-Content-Type-Options: nosniff   never MIME-sniff a response into executable script.
//  - Referrer-Policy: no-referrer      never leak the console URL/path to any navigated target.
//  - X-Frame-Options: DENY             legacy clickjacking guard (frame-ancestors is the modern one).
//  - Strict-Transport-Security         two-year HSTS with includeSubDomains; tells browsers to
//                                      reject plain-HTTP connections to this origin going forward.
//  - Permissions-Policy                deny the powerful features the console never uses.
// cacheControlFor decides how long the browser may reuse a static asset WITHOUT asking the origin. It is
// the load-bearing half of making a console update land WITHOUT a hard refresh: the SPA SHELL keeps a
// STABLE filename across builds (index.html served at every client-routed path, app.js, tokens.css), so if
// it were cached it would serve the OLD build until the browser's heuristic cache expired -- the exact
// "needs a hard refresh" wart. `no-cache` lets the browser reuse a stored copy only AFTER revalidating with
// the origin, so a deployed update is picked up on the very next (ordinary) load or the flow's auto-reload.
// Content-hashed bundles (esbuild --splitting emits chunk-<hash>.js / demo-fetch-<hash>.js; the hash changes
// every build, so a new build references new names) are safe to cache forever. __build.json is the version
// probe the update flow polls; it must never be cached.
export function cacheControlFor(pathname: string): string {
  if (/-[A-Z0-9]{6,}\.js$/.test(pathname)) return "public, max-age=31536000, immutable";
  if (pathname === "/__build.json") return "no-store";
  return "no-cache";
}

// withSecurityHeaders returns a copy of the response with the security headers applied. For an ASSET
// response the caller passes its pathname, and the cache-control is set per cacheControlFor(pathname);
// for a dynamic response (engine-topology.json, the 500) the pathname is omitted and the response keeps
// its own cache-control (those set no-store themselves). The body and status are preserved; a new Response
// is built because an ASSETS response's headers can be immutable.
function withSecurityHeaders(res: Response, pathname?: string): Response {
  const headers = new Headers(res.headers);
  if (pathname !== undefined) headers.set("cache-control", cacheControlFor(pathname));
  headers.set("content-security-policy", buildCsp());
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  // HSTS with preload (ASVS V3.7.4): the directive is the code-side prerequisite for the browser preload
  // list (the hstspreload.org submission is a per-deployment operator step).
  headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  // Cross-origin isolation for the restore-capable console (ASVS V3.4.8 / V3.5.8). COOP severs the opener
  // relationship so a popup cannot reach back into this window; CORP same-origin stops another site embedding
  // these authenticated responses as a subresource. Set ONLY on the console's own SPA responses (this
  // function): the proxied engine surface returns via env.ENGINE.fetch WITHOUT this wrapper, so the engine
  // API is unaffected (a CORP same-origin on JSON served through the proxy would break the proxied topology).
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  // Declares the report-to "csp-endpoint" group the CSP names, pointing at the same-origin /csp-report sink.
  headers.set("reporting-endpoints", 'csp-endpoint="/csp-report"');
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// isEngineSurface matches the engine's served prefixes and nothing else: the SPA's own
// client-routed paths (/runs, /keys, /settings, ...) never collide with these.
//
// /metrics (the Prometheus text-exposition scrape endpoint, monitoring integrations,
// PLAN.md) is the REACHABILITY path for the metrics scrape credential Settings mints
// (src/screens/settings/support.ts): without this, a scraper pointed at this origin's /metrics on
// the DEFAULT single-hostname topology would fall through to the SPA (a 404/the shell) and never
// reach the engine, defeating the zero-setup scrape story the whole feature is built on. It is
// matched GET-ONLY: the engine itself serves no other verb there (handleMetricsRoute 404s
// anything else), and a narrower method match keeps this proxy from blindly forwarding an
// unexpected verb to a bearer-gated, non-/admin route that carries none of the CSRF/step-up
// protections the admin surface has.
export function isEngineSurface(pathname: string, method: string): boolean {
  if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/support/")) return true;
  return pathname === "/metrics" && method === "GET";
}

// The vendor's public, unauthenticated machine host for the claim-code exchange. Deliberately not
// admin.downpipes.io, which sits behind Cloudflare Access and would redirect a customer's first-ever
// activation into a login page.
export const CONTROL_PLANE_ORIGIN = "https://control.downpipes.io";

// The one same-origin route the console may use to reach the control plane, and the only path behind
// it. This is NOT a general proxy and must never become one.
//
// Why it exists. Licence claim-code activation was DEAD in the shipped console. The SPA
// fetched https://control.downpipes.io/licence/claim directly from the browser while buildCsp() sets
// connect-src to exactly 'self', so Chromium blocked the request before it reached the network and
// every activation attempt landed in the catch. The in-repo tests could not see it because
// validate-licence.ts replaces globalThis.fetch, so the policy was never in the path. Routing the
// exchange through this origin makes the call same-origin, which is what the CSP has always required.
//
// Kept deliberately narrow, because a Worker that forwards arbitrary paths to an arbitrary host is an
// SSRF engine: exactly one path, exactly one method, one fixed upstream origin, no wildcards. Nothing
// from the incoming request is reflected into the upstream URL.
const CONTROL_PLANE_PROXY_PREFIX = "/control-plane";
const CLAIM_PROXY_PATH = `${CONTROL_PLANE_PROXY_PREFIX}/licence/claim`;
const CLAIM_UPSTREAM_PATH = "/licence/claim";

export function isControlPlaneSurface(pathname: string, method: string): boolean {
  return pathname === CLAIM_PROXY_PATH && method === "POST";
}

/**
 * Forwards the claim-code exchange to the control plane. The upstream URL is BUILT FROM CONSTANTS,
 * never from the request, so no part of the caller's input can redirect it. Only the JSON body and
 * the content-type cross; cookies, the Authorization header and every other header are dropped,
 * because this route is unauthenticated by design and the control plane must not receive an
 * ambient console credential.
 */
export async function proxyControlPlane(req: Request): Promise<Response> {
  const upstream = `${CONTROL_PLANE_ORIGIN}${CLAIM_UPSTREAM_PATH}`;
  const body = await req.text();
  const res = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "manual",
  });
  // The control plane answers one byte-identical 404 for every refusal class, on purpose, so the
  // status and body pass through unchanged: narrowing or re-describing them here would leak the
  // distinction it works to hide.
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Last-resort handler (ASVS V16.5.4): a throw from the assets fetcher or the ENGINE service binding must
    // not escape unhandled. The whole dispatch runs inside this try; the catch returns a generic 500 carrying
    // the same hardened security headers, and logs a coarse fixed line (no raw message/stack).
    try {
      const pathname = new URL(req.url).pathname;
      // The topology declaration: the SPA reads this at boot and, when proxied, adopts
      // its own origin as the engine URL automatically (overriding any remembered split
      // hostname), so an operator is never asked for an engine address that is, by
      // construction, this one. Same-origin, tiny, never cached.
      if (pathname === "/engine-topology.json") {
        return withSecurityHeaders(
          new Response(JSON.stringify({ proxied: env.ENGINE !== undefined }), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          }),
        );
      }
      // CSP violation report sink (ASVS V3.4.7): browsers POST blocked-resource reports to the report-uri /
      // report-to endpoint named in the CSP. Accept and discard with a 204 (no body, no store); same-origin and
      // tiny, never proxied to the engine. (A deployment can wire this to a collector; the route exists so the
      // policy's reporting directives resolve to a real same-origin endpoint.)
      if (pathname === "/csp-report" && req.method === "POST") {
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      // Public-tour funnel sink (design/self-guided-tour/DESIGN.md). The tour's browser half beacons small,
      // PII-free funnel events (tour_started / persona_chosen / step_reached / drop_step / cta_clicked) to
      // this same-origin route, deliberately kept OFF /admin/* so the faked-engine fetch shim never swallows
      // it. It sits ABOVE the assets fetch so the SPA fallback cannot pre-empt the POST. With TOUR_ANALYTICS
      // bound (only the tour deploy) the event is recorded via writeDataPoint; without it (every other deploy)
      // this is a harmless 204, so the genuine console is byte-for-byte unaffected. Best-effort: a malformed
      // body or a sink fault is swallowed and still answered 204 (analytics must never break a beacon).
      if (pathname === "/tour/event" && req.method === "POST") {
        if (env.TOUR_ANALYTICS !== undefined) {
          try {
            const e = (await req.json()) as { name?: unknown; persona?: unknown; route?: unknown; detail?: unknown; stepIndex?: unknown; anchor?: unknown; src?: unknown };
            // The event NAME is checked against the closed set before anything is written, and an unknown name
            // drops the whole datapoint. This route is a PUBLIC, unauthenticated POST: until now it copied every
            // string in the body verbatim into the owner's Analytics Engine dataset, so anyone could write
            // anything into it. The tour's own emitter has always sent closed values; the SINK had no opinion,
            // and a sink with no opinion is not a redaction boundary. It has one now.
            if (!TOUR_EVENT_NAMES.has(String(e.name))) {
              return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
            }
            // Every blob is SHAPE-GATED, not clamped: a value that is not the product shape is dropped whole
            // rather than truncated into the dataset (a clamp bounds the length of a leak, not its content).
            // The shape admits the tour's own vocabulary (a route pattern, a chapter id, a closed kind, an
            // anchor id) segment by segment: see tourValueOk, which structurally cannot admit a URL with a
            // scheme, an email, a query string, a sentence or an HTML fragment.
            const tourValue = (v: unknown): string => (typeof v === "string" && tourValueOk(v) ? v : "");
            // Blob order is POSITIONAL and append-only: Analytics Engine names columns blob1..blobN by
            // position, so inserting a blob would silently re-label every historical row. src (the campaign
            // label the emitter attaches to tour_started and cta_clicked) is therefore blob5, appended after
            // the original four, and any future field appends after it. An absent or off-shape src drops to
            // the same empty string every other absent blob writes.
            env.TOUR_ANALYTICS.writeDataPoint({
              indexes: [String(e.name)],
              blobs: [tourValue(e.persona), tourValue(e.route), tourValue(e.detail), tourValue(e.anchor), tourValue(e.src)],
              doubles: [typeof e.stepIndex === "number" && Number.isFinite(e.stepIndex) ? Math.max(-1, Math.min(999, Math.trunc(e.stepIndex))) : -1],
            });
          } catch {
            // best-effort: a malformed beacon or a sink fault is dropped, never surfaced
          }
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      // Proxied topology: hand the engine surface to the service binding VERBATIM and
      // return its response untouched (the engine sets its own headers; layering the
      // console's CSP onto API JSON would be noise). Everything else is the SPA.
      // Same-origin claim-code exchange, above the assets fetch so the SPA fallback cannot pre-empt
      // the POST. See isControlPlaneSurface for why this route exists and why it stays this narrow.
      if (isControlPlaneSurface(pathname, req.method)) {
        return withSecurityHeaders(await proxyControlPlane(req));
      }
      if (isEngineSurface(pathname, req.method)) {
        // AWAITED, and that is load-bearing. `return env.ENGINE.fetch(req)` returns the PROMISE, so a rejection
        // from the service binding (the engine worker deleted, throwing, or over its resource limits) escapes
        // the last-resort try/catch above entirely and the runtime answers a bare 500. That made the handler's
        // own ASVS V16.5.4 claim ("a throw from ... the ENGINE service binding must not escape unhandled")
        // FALSE: the one throw it names by name was the one it could not catch.
        if (env.ENGINE !== undefined) return await env.ENGINE.fetch(req);
        // A MISSING ENGINE SERVICE BINDING USED TO MASQUERADE AS A HEALTHY ENGINE, and this line is the
        // whole fault. With no ENGINE binding an engine-surface request FELL THROUGH to the assets fetcher, and
        // the SPA fallback below then answered /admin/status, /support and /metrics alike with index.html at
        // HTTP 200. The consequences ran in three directions and none of them named the cause:
        //
        //   the console       every screen showed "engine unreachable" or a JSON parse error, because it was
        //                     parsing an HTML shell as engine data. The classifier called that `html-not-engine`,
        //                     which is the WRONG ENGINE URL diagnosis: it sends the operator to correct an
        //                     address that is perfectly correct.
        //   the scraper       a Prometheus scrape of /metrics received HTML with a 200, so the customer's own
        //                     monitoring reported everything as fine while nothing was being backed up.
        //   the pack          the engine never received a single request, so its own status booleans and every
        //                     section read green. The pack showed a healthy engine and an idle one at once.
        //
        // This is a CONFIGURATION fault in the CONSOLE'S deploy (a redeploy that dropped the service binding),
        // and the remedy is to restore the binding and redeploy the console. It has nothing whatever to do with
        // the engine's health, so the console must not answer for the engine here: it answers for ITSELF, with a
        // 503 (the surface exists and its dependency is absent) and a machine-readable code the console's own
        // transport recognises BY EQUALITY and maps to its own transport class. No path, no query and no header
        // is echoed: the body is a frozen product constant.
        //
        // The SAME frozen token rides in a header as well as in the body, and the header is not a convenience. The
        // browser's recording seam for engine calls (engine-fetch.ts) sees the Response before anything has read
        // its body, and a body can be read only once, so with the status alone it recorded this as an engine 5xx:
        // an engine fault, fabricated, for a request the engine never received. The header lets that seam tell the
        // console's own refusal from the engine's, without consuming the body failResponse still needs.
        return new Response(JSON.stringify({ error: ENGINE_BINDING_ABSENT }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            [ENGINE_BINDING_ABSENT_HEADER]: ENGINE_BINDING_ABSENT,
          },
        });
      }
      const res = await env.ASSETS.fetch(req);
      // Single-page-app fallback. A client-routed navigation (a refresh of, or a deep link to,
      // /canary, /downpipes, /restore/:id, ...) has no matching static asset, and Cloudflare Assets
      // answers it with a 404 OR a 307 redirect to "/". Either way the navigation must receive the
      // SPA shell AT THE REQUESTED URL: passing the redirect through is exactly what reset the client
      // router to Overview on every deep-link refresh, and a bare 404 is a dead end. We re-fetch the
      // shell via the ROOT path "/", which Assets serves as index.html with a 200. (A direct
      // "/index.html" fetch is itself canonicalised by html_handling to a 307 -> "/", so it can never
      // return the shell bytes - that subtlety is why the earlier 404->"/index.html" fallback failed.)
      // index.html references its assets absolutely, so the shell boots correctly at any path depth.
      // A request that IS an asset (a path ending in a file extension) keeps its real status, so a
      // genuinely missing file still 404s and is never masked by the shell.
      const isAssetPath = /\.[^/]+$/.test(pathname); // ends in a file extension
      const assetMissing = res.status === 404 || (res.status >= 300 && res.status < 400);
      if (assetMissing && !isAssetPath && pathname !== "/") {
        const rootUrl = new URL(req.url);
        rootUrl.pathname = "/";
        rootUrl.search = "";
        // The SPA shell (index.html) served for a client-routed path: it keeps a stable name, so no-cache.
        return withSecurityHeaders(await env.ASSETS.fetch(new Request(rootUrl, req)), "/");
      }
      return withSecurityHeaders(res, pathname);
    } catch {
      // Coarse, fixed line only: no raw message/stack/header/body, matching the prior
      // behaviour. The path is derived defensively because the URL parse can itself be the
      // throwing step; a bad URL falls back to an omitted path rather than re-throwing here.
      const fields: LogFields = { method: req.method, status: 500, error_code: "unhandled" };
      try {
        fields.path = new URL(req.url).pathname;
      } catch {
        // leave path omitted when the URL itself is the throwing step
      }
      log("error", "request.unhandled", fields, env);
      // MARKED AS THE CONSOLE'S OWN. This 500 is manufactured HERE: the engine never received the request (the
      // dispatch threw, or the ENGINE service binding rejected). Without the marker the browser's recording seam
      // sees a bare 5xx and files it as an ENGINE refusal, and the pack then tells a support engineer the engine
      // is up and refusing, with the evidence in its logs. There is no such evidence, because there was no such
      // request. See CONSOLE_ORIGIN_FAULT_HEADER in lib/errors.ts.
      return withSecurityHeaders(
        new Response("internal error", { status: 500, headers: { [CONSOLE_ORIGIN_FAULT_HEADER]: CONSOLE_ORIGIN_FAULT } }),
      );
    }
  },
};
