// Starter Workers-pool test. Runs inside a real workerd isolate
// and exercises the console Worker's fetch entrypoint plus its exported helpers. These
// routes need no bound ASSETS/ENGINE services, so the starter stays green without standing
// up an assets server; the assets-fallback and engine-proxy paths are the natural next
// coverage to port. The starter MUST pass.
import { describe, expect, it } from "vitest";
import worker, { buildCsp, isEngineSurface } from "../../src/worker.ts";

// A minimal Env covering only what these routes read. ENGINE/ASSETS are supplied per test
// where the path under test actually reaches them.
type WorkerEnv = Parameters<typeof worker.fetch>[1];

function makeEnv(over: Partial<WorkerEnv> = {}): WorkerEnv {
  return { ASSETS: { fetch: async () => new Response("unused", { status: 200 }) }, ...over } as WorkerEnv;
}

describe("console worker fetch entrypoint", () => {
  it("serves /engine-topology.json with proxied:false when ENGINE is unbound", async () => {
    const res = await worker.fetch(new Request("https://console.downpipes.io/engine-topology.json"), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ proxied: false });
    // Even the topology document carries the strict CSP.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("serves /engine-topology.json with proxied:true when ENGINE is bound", async () => {
    const env = makeEnv({ ENGINE: { fetch: async () => new Response("engine") } } as Partial<WorkerEnv>);
    const res = await worker.fetch(new Request("https://console.downpipes.io/engine-topology.json"), env);
    expect(await res.json()).toEqual({ proxied: true });
  });

  it("accepts a CSP violation report with a 204 and never proxies it", async () => {
    const res = await worker.fetch(
      new Request("https://console.downpipes.io/csp-report", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a 204 for a non-JSON report body without parsing or acting on it", async () => {
    const res = await worker.fetch(
      new Request("https://console.downpipes.io/csp-report", {
        method: "POST",
        body: "this is not json at all",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("discards an oversized report body without reading it unboundedly", async () => {
    // A large body must be accepted and discarded; the handler never reads the body, so the
    // size cannot drive work. The 204 returns whatever the body length.
    const big = "x".repeat(2_000_000);
    const res = await worker.fetch(
      new Request("https://console.downpipes.io/csp-report", { method: "POST", body: big }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not treat a GET to /csp-report as a report sink (only POST is the sink)", async () => {
    // A GET falls through to the SPA assets path rather than the 204 report sink, so the
    // report endpoint cannot be probed with a GET to confirm anything is stored.
    let assetSeen = false;
    const env = makeEnv({
      ASSETS: {
        fetch: async () => {
          assetSeen = true;
          return new Response("shell", { status: 200 });
        },
      },
    } as Partial<WorkerEnv>);
    const res = await worker.fetch(new Request("https://console.downpipes.io/csp-report"), env);
    expect(res.status).not.toBe(204);
    expect(assetSeen).toBe(true);
  });

  it("applies the full security-header set to SPA responses", async () => {
    const res = await worker.fetch(new Request("https://console.downpipes.io/runs"), makeEnv());
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=63072000");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("proxies the engine surface verbatim WITHOUT the console security wrapper", async () => {
    let seen: string | undefined;
    const env = makeEnv({
      ENGINE: {
        fetch: async (req: Request) => {
          seen = new URL(req.url).pathname;
          return new Response("engine-json", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    } as Partial<WorkerEnv>);
    const res = await worker.fetch(new Request("https://console.downpipes.io/admin/status"), env);
    expect(seen).toBe("/admin/status");
    expect(await res.text()).toBe("engine-json");
    // The proxied response is returned untouched: none of the console security headers
    // are layered on engine JSON (not just CSP).
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
  });

  it("proxies a GET /metrics scrape to the ENGINE binding (the metrics scrape reachability path, monitoring integrations)", async () => {
    let seen: string | undefined;
    let seenAuth: string | null = null;
    const env = makeEnv({
      ENGINE: {
        fetch: async (req: Request) => {
          seen = new URL(req.url).pathname;
          seenAuth = req.headers.get("authorization");
          return new Response("# HELP downpipe_backup_success ...\n", { status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
        },
      },
    } as Partial<WorkerEnv>);
    const res = await worker.fetch(new Request("https://console.downpipes.io/metrics", { headers: { authorization: "Bearer dpc_x.dps_y" } }), env);
    expect(seen).toBe("/metrics");
    expect(seenAuth).toBe("Bearer dpc_x.dps_y");
    expect(await res.text()).toContain("downpipe_backup_success");
    // Proxied untouched, exactly like /admin and /support: no console CSP layered on the scrape body.
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("does NOT proxy a POST /metrics (GET-only surface): it falls through to the SPA path instead", async () => {
    let engineCalled = false;
    const env = makeEnv({
      ENGINE: { fetch: async () => { engineCalled = true; return new Response("unexpected"); } },
      ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }) },
    } as Partial<WorkerEnv>);
    const res = await worker.fetch(new Request("https://console.downpipes.io/metrics", { method: "POST" }), env);
    expect(engineCalled).toBe(false);
    // Fell through to the SPA path, which DOES carry the console's own security headers.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("returns a hardened 500 when the assets fetcher throws", async () => {
    const env = makeEnv({
      ASSETS: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    } as Partial<WorkerEnv>);
    const res = await worker.fetch(new Request("https://console.downpipes.io/runs"), env);
    expect(res.status).toBe(500);
    // The catch path still carries the strict headers, and leaks no error detail.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toBe("internal error");
  });
});

describe("console worker helpers", () => {
  it("buildCsp pins connect-src to 'self' (single-origin topology)", () => {
    const csp = buildCsp();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-hashes");
  });

  it("isEngineSurface matches only the engine prefixes", () => {
    expect(isEngineSurface("/admin", "GET")).toBe(true);
    expect(isEngineSurface("/admin/status", "GET")).toBe(true);
    expect(isEngineSurface("/support/ticket", "GET")).toBe(true);
    expect(isEngineSurface("/runs", "GET")).toBe(false);
    expect(isEngineSurface("/keys", "GET")).toBe(false);
  });

  it("isEngineSurface matches GET /metrics only (the Prometheus scrape reachability path)", () => {
    expect(isEngineSurface("/metrics", "GET")).toBe(true);
    expect(isEngineSurface("/metrics", "POST")).toBe(false);
    expect(isEngineSurface("/metrics", "HEAD")).toBe(false);
    expect(isEngineSurface("/metrics/sub", "GET")).toBe(false);
    expect(isEngineSurface("/metrics-typo", "GET")).toBe(false);
  });
});
