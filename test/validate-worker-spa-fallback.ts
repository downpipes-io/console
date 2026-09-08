// The console Worker's single-page-app fallback, driven through the REAL default export.
//
//   node test/validate-worker-spa-fallback.ts
//
// Why this file exists. A client-routed navigation (a refresh of, or a deep link to, /canary,
// /downpipes, /restore/:id) has no matching static asset, and Cloudflare Assets answers it with EITHER
// a 404 OR a 307 redirect to "/". Both must end with the SPA shell served AT THE REQUESTED URL.
//
// Both halves of that have already broken in production once. Passing the 307 through reset the client
// router to Overview on every deep-link refresh, and a bare 404 is a dead end. The fix in worker.ts
// re-fetches the shell via the ROOT path, and its comment records a further subtlety: fetching
// "/index.html" directly cannot work, because html_handling canonicalises that to its own 307 back to
// "/", so an earlier 404-to-index.html fallback could never return the shell bytes.
//
// None of it was tested. Before this file, exactly one test stubbed ASSETS and it always answered 200,
// so every branch below was unexercised, on the path that decides whether the console loads at all.
//
// The ASSETS stub records what it was asked for, because the interesting assertions are about the
// SECOND fetch: that a re-fetch happened, that it asked for exactly "/", and that the query string was
// dropped rather than carried into the shell request.

import consoleWorker from "../src/worker.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const SHELL = "<!doctype html><html><body>console shell</body></html>";

interface AssetCall {
  url: string;
  method: string;
}

// makeEnv builds an env whose ASSETS answers the FIRST request with `first` and any later request with
// the shell at 200, which is what Cloudflare Assets does for "/" (index.html). Every call is recorded.
function makeEnv(first: { status: number; location?: string; body?: string }): { env: unknown; calls: AssetCall[] } {
  const calls: AssetCall[] = [];
  const env = {
    ASSETS: {
      fetch: async (req: Request): Promise<Response> => {
        calls.push({ url: req.url, method: req.method });
        if (calls.length === 1) {
          const headers: Record<string, string> = {};
          if (first.location !== undefined) headers.location = first.location;
          return new Response(first.body ?? "", { status: first.status, headers });
        }
        return new Response(SHELL, { status: 200, headers: { "content-type": "text/html" } });
      },
    },
  };
  return { env, calls };
}

async function get(path: string, first: { status: number; location?: string; body?: string }): Promise<{ res: Response; body: string; calls: AssetCall[] }> {
  const { env, calls } = makeEnv(first);
  const fetchFn = (consoleWorker as unknown as { fetch: (req: Request, env: unknown) => Promise<Response> }).fetch;
  const res = await fetchFn(new Request(`https://console.example${path}`, { method: "GET" }), env);
  const body = await res.text();
  return { res, body, calls };
}

async function main(): Promise<void> {
  console.log("(1) a client-routed path that Assets 404s gets the shell, at the requested URL");
  {
    const { res, body, calls } = await get("/canary", { status: 404, body: "not found" });
    ok("(1a) the navigation gets 200, not the 404", res.status === 200);
    ok("(1b) it gets the shell bytes", body.includes("console shell"));
    ok("(1c) Assets was asked twice: the path, then the root", calls.length === 2);
    ok("(1d) the second fetch asked for exactly the root path", calls[1] !== undefined && new URL(calls[1].url).pathname === "/");
    ok("(1e) there is no Location header, so no redirect reaches the browser", res.headers.get("location") === null);
  }

  console.log("\n(2) the 307 case: the redirect must NOT be passed through");
  {
    // This is the branch that reset the router to Overview on every deep-link refresh. A fix that only
    // handled 404 would leave it broken, so it is asserted separately rather than folded in with (1).
    const { res, body, calls } = await get("/restore/run-123", { status: 307, location: "/" });
    ok("(2a) the 307 becomes a 200", res.status === 200);
    ok("(2b) the browser gets the shell, not a redirect", body.includes("console shell") && res.headers.get("location") === null);
    ok("(2c) the root was re-fetched", calls.length === 2 && new URL(calls[1]?.url ?? "").pathname === "/");
  }

  console.log("\n(3) every 3xx is treated as 'no such asset', not just 307");
    for (const status of [301, 302, 308]) {
      const { res } = await get("/downpipes", { status, location: "/" });
      ok(`(3) Assets ${status} on a client-routed path still yields the shell at 200`, res.status === 200);
    }

  console.log("\n(4) a real asset keeps its real status: the shell must never mask a missing file");
  {
    // The guard is a file-extension test. If it were dropped, a missing /app.js would answer 200 with
    // HTML, and the browser would try to execute the shell as JavaScript: a blank console with a
    // syntax error, far harder to diagnose than a clean 404.
    const { res, body, calls } = await get("/app.js", { status: 404, body: "not found" });
    ok("(4a) a missing /app.js keeps its 404", res.status === 404);
    ok("(4b) it is NOT given the shell", !body.includes("console shell"));
    ok("(4c) Assets was asked once, with no root re-fetch", calls.length === 1);
    const css = await get("/styles/app.css", { status: 404, body: "" });
    ok("(4d) a missing stylesheet keeps its 404 too", css.res.status === 404 && css.calls.length === 1);
    const map = await get("/chunk-ABC123.js.map", { status: 404, body: "" });
    ok("(4e) a missing source map keeps its 404", map.res.status === 404);
  }

  console.log("\n(5) the root itself is never re-fetched, so a broken deploy cannot loop");
  {
    // pathname === "/" is excluded from the fallback deliberately. Without that, an Assets deployment
    // missing index.html would have the Worker re-fetch "/" for the 404 on "/", and answer whatever the
    // second call gave: at best a confusing 200, at worst a loop. It must pass the failure through.
    const { res, calls } = await get("/", { status: 404, body: "no index" });
    ok("(5a) a 404 on the root is passed through, not re-fetched", res.status === 404);
    ok("(5b) Assets was asked exactly once", calls.length === 1);
  }

  console.log("\n(6) the query string is dropped from the shell re-fetch");
  {
    // The shell is one static file; carrying ?tab=x into the Assets request can only produce a cache
    // key that varies per deep link for identical bytes. The client router reads the query from
    // location, which is unaffected: the BROWSER still sees the original URL.
    const { res, calls } = await get("/sources?tab=bindings&q=acme", { status: 404, body: "" });
    ok("(6a) the navigation still gets the shell", res.status === 200);
    const second = new URL(calls[1]?.url ?? "https://x.invalid");
    ok("(6b) the re-fetch carries no query string", second.search === "");
    ok("(6c) and asks for the root", second.pathname === "/");
  }

  console.log("\n(7) the fallback response still carries the console's security headers");
  {
    // withSecurityHeaders wraps BOTH the ordinary and the fallback response. A fallback that skipped it
    // would serve the shell, the one HTML document in the product, with no CSP at all.
    const { res } = await get("/canary", { status: 404, body: "" });
    const csp = res.headers.get("content-security-policy");
    ok("(7a) the shell carries a CSP", csp !== null && csp.length > 0);
    ok("(7b) the CSP still pins connect-src to 'self'", (csp ?? "").includes("connect-src 'self'"));
    ok("(7c) HSTS is present", (res.headers.get("strict-transport-security") ?? "").includes("max-age="));
    ok("(7d) frame-ancestors is denied", (csp ?? "").includes("frame-ancestors 'none'"));
  }

  console.log("\n(8) a 200 asset is passed through untouched");
  {
    const { res, body, calls } = await get("/logo.svg", { status: 200, body: "<svg/>" });
    ok("(8a) a present asset keeps its 200 and its bytes", res.status === 200 && body === "<svg/>");
    ok("(8b) no re-fetch happened", calls.length === 1);
  }

  console.log(`\n${failures === 0 ? "SPA-FALLBACK OK: 404 and every 3xx yield the shell at the requested URL, assets keep their status, the root never loops" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
