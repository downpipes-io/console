// Coverage validator for the in-memory app store (src/lib/store.ts).
// Run with: node test/cov/lib-store.ts (auto-run by test/cov/run.mjs, part of npm run validate).
//
// store.ts is the single module-scoped holder of the engine client, the resolved caller, the
// connection target and the entity / search caches. Its public surface is a set of plain
// getter / setter accessors plus four pieces of real logic the validate-*.ts suite only grazes:
//   - connect: builds an EngineClient, persists the URL, and wires onStepUpRequired (its localStorage
//     write has a best-effort catch arm that a blocked store must drive);
//   - restoreConnection: the early-return when already connected, the blocked-read fallback, the
//     no-remembered-URL default to this origin, the remembered-URL happy path, and the catch arm that
//     degrades a bad remembered URL to null rather than throwing on boot;
//   - the onStepUpRequired closure connect / restoreConnection install, across both the runner-wired
//     and runner-absent arms (set via setStepUpRunner);
//   - adoptProxiedTopology: the not-ok response, the non-JSON content-type, a missing content-type, a
//     proxied:false body, a proxied:true body that already points at this origin (no reconnect), a
//     proxied:true body that adopts this origin (a reconnect), and the fetch-throws fail-open arm.
// It also drives the remaining caller / whoami / cache / search-cache / ceremony accessors and the two
// clearers (clearSensitiveState and signOut) so every export is exercised against a meaningful outcome.
//
// The store holds module-scoped singleton state, so the sections run in a deliberate order and reset
// the shimmed localStorage and global fetch between them. It imports the shared DOM shim (test/dom-shim.ts)
// for localStorage / location exactly as the other lib coverage validators do, and never edits that
// shared shim. EngineClient is the real transport (no network is made: the store only constructs it and
// reads its onStepUpRequired hook), and a tiny canned fetch answers adoptProxiedTopology's one probe.

import { installDomShim, installBlockedStorage, restoreMemoryStorage } from "../dom-shim.ts";

installDomShim();

import {
  getEngine,
  getEngineUrl,
  setStepUpRunner,
  connect,
  restoreConnection,
  adoptProxiedTopology,
  getCaller,
  setCaller,
  isWhoamiAvailable,
  setWhoamiAvailable,
  getDownpipesCache,
  setDownpipesCache,
  getRunsCache,
  setRunsCache,
  getDestinationsForSearch,
  setDestinationsForSearch,
  getCredentialsForSearch,
  setCredentialsForSearch,
  getRunsForSearch,
  setRunsForSearch,
  setCeremony,
  getCeremony,
  clearSensitiveState,
  signOut,
} from "../../src/lib/store.ts";
import type { EngineClient, Caller, DownpipeState, RunHistoryEntry, DestinationStatus, ExpiryStatus } from "../../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const CONN_KEY = "dp-engine-url";

// stubTopology installs a fetch that answers adoptProxiedTopology's single /engine-topology.json probe
// with a canned Response, recording the probed URL. opts.throws models the SPA-shell / network-fault
// fail-open arm; a null contentType models a Response with no content-type header.
interface TopoOpts {
  ok: boolean;
  status?: number;
  contentType?: string | null;
  body?: unknown;
  throws?: boolean;
}
function stubTopology(opts: TopoOpts): { restore: () => void; urls: string[] } {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  const urls: string[] = [];
  g.fetch = async (url: string) => {
    urls.push(String(url));
    if (opts.throws) throw new Error("network down");
    return {
      ok: opts.ok,
      status: opts.status ?? (opts.ok ? 200 : 500),
      headers: {
        get(name: string): string | null {
          if (name.toLowerCase() !== "content-type") return null;
          return opts.contentType === undefined ? "application/json" : opts.contentType;
        },
      },
      async json(): Promise<unknown> {
        return opts.body ?? {};
      },
    };
  };
  return {
    restore() {
      g.fetch = prev;
    },
    urls,
  };
}

async function main(): Promise<void> {
  const HTTPS = "https://engine.test";
  const ORIGIN = location.origin; // the shim's https://console.test

  // ========================================================================
  console.log("\n-- a fresh store reads every accessor as its empty default --");
    // signOut from any prior import side effect normalises the singleton to the signed-out baseline.
    signOut();
    ok("getEngine is null before any connect", getEngine() === null);
    ok("getEngineUrl is null before any connect", getEngineUrl() === null);
    ok("getCaller is null before any resolve", getCaller() === null);
    ok("isWhoamiAvailable is false by default", isWhoamiAvailable() === false);
    ok("getDownpipesCache is null by default", getDownpipesCache() === null);
    ok("getRunsCache is undefined for an unseen downpipe", getRunsCache("dp-unseen") === undefined);
    ok("getDestinationsForSearch is null by default", getDestinationsForSearch() === null);
    ok("getCredentialsForSearch is null by default", getCredentialsForSearch() === null);
    ok("getRunsForSearch is null by default", getRunsForSearch() === null);
    ok("getCeremony is null by default", getCeremony() === null);

  // ========================================================================
  console.log("\n-- caller / whoami / cache / search-cache / ceremony accessors round-trip --");
  // ========================================================================
  {
    const caller = { id: "u-1", role: "owner" } as unknown as Caller;
    setCaller(caller);
    ok("setCaller then getCaller returns the set caller", getCaller() === caller);
    setCaller(null);
    ok("setCaller(null) clears the caller", getCaller() === null);

    setWhoamiAvailable(true);
    ok("setWhoamiAvailable(true) is observed", isWhoamiAvailable() === true);
    setWhoamiAvailable(false);
    ok("setWhoamiAvailable(false) is observed", isWhoamiAvailable() === false);

    const dps = [{ id: "dp-a" }] as unknown as DownpipeState[];
    setDownpipesCache(dps);
    ok("setDownpipesCache then getDownpipesCache returns the list", getDownpipesCache() === dps);
    setDownpipesCache(null);
    ok("setDownpipesCache(null) clears the cache", getDownpipesCache() === null);

    const runs = [{ runId: "r-1" }] as unknown as RunHistoryEntry[];
    setRunsCache("dp-a", runs);
    ok("setRunsCache then getRunsCache returns the runs for that downpipe", getRunsCache("dp-a") === runs);
    ok("getRunsCache stays undefined for a different downpipe", getRunsCache("dp-b") === undefined);

    const dests = [{ id: "d-1" }] as unknown as DestinationStatus[];
    setDestinationsForSearch(dests);
    ok("setDestinationsForSearch round-trips", getDestinationsForSearch() === dests);
    setDestinationsForSearch(null);
    ok("setDestinationsForSearch(null) clears it", getDestinationsForSearch() === null);

    const creds = [{ id: "c-1" }] as unknown as ExpiryStatus[];
    setCredentialsForSearch(creds);
    ok("setCredentialsForSearch round-trips", getCredentialsForSearch() === creds);
    setCredentialsForSearch(null);
    ok("setCredentialsForSearch(null) clears it", getCredentialsForSearch() === null);

    const runSearch = [{ runId: "r-1", index: 0, downpipeId: "dp-a" }];
    setRunsForSearch(runSearch);
    ok("setRunsForSearch round-trips", getRunsForSearch() === runSearch);
    setRunsForSearch(null);
    ok("setRunsForSearch(null) clears it", getRunsForSearch() === null);

    const material = { wrapped: "x" };
    setCeremony(material);
    ok("setCeremony then getCeremony returns the material reference", getCeremony() === material);
  }

  // ========================================================================
  console.log("\n-- clearSensitiveState zeros ceremony material and nothing else --");
  // ========================================================================
  {
    setCeremony({ wrapped: "secret" });
    const caller = { id: "u-2" } as unknown as Caller;
    setCaller(caller);
    setDownpipesCache([{ id: "dp-keep" }] as unknown as DownpipeState[]);
    clearSensitiveState();
    ok("clearSensitiveState nulls the ceremony material", getCeremony() === null);
    ok("clearSensitiveState leaves the caller untouched (it holds no key material)", getCaller() === caller);
    ok("clearSensitiveState leaves the downpipes cache untouched", getDownpipesCache() !== null);
    // It is a documented no-op when ceremony is already null, so a second call must not throw.
    let threw = false;
    try {
      clearSensitiveState();
    } catch {
      threw = true;
    }
    ok("clearSensitiveState is a safe no-op when ceremony is already null", threw === false && getCeremony() === null);
  }

  // ========================================================================
  console.log("\n-- connect: builds the client, persists the URL, wires the step-up hook --");
  // ========================================================================
  {
    signOut();
    restoreMemoryStorage();
    // No runner wired yet: the installed onStepUpRequired closure must take its runner-absent arm and
    // resolve null without throwing.
    const engine = connect(HTTPS, "bearer-token");
    ok("connect returns an EngineClient", engine !== null && typeof engine.health === "function");
    ok("connect sets getEngine to the returned client", getEngine() === engine);
    ok("connect records the engine URL", getEngineUrl() === HTTPS);
    ok("connect persists the URL under the connection key", localStorage.getItem(CONN_KEY) === HTTPS);
    ok("connect wired an onStepUpRequired hook", typeof engine.onStepUpRequired === "function");

    const noRunner = await engine.onStepUpRequired!();
    ok("onStepUpRequired resolves null when no step-up runner is wired", noRunner === null);

    // Wire a runner: the SAME closure now takes the runner-present arm and forwards the live engine.
    let runnerSawEngine: EngineClient | null = null;
    setStepUpRunner(async (e) => {
      runnerSawEngine = e;
      return "fresh-stepup-token";
    });
    const tok = await engine.onStepUpRequired!();
    ok("onStepUpRequired forwards to the wired runner", tok === "fresh-stepup-token");
    ok("the runner is handed the live engine client", runnerSawEngine === engine);
  }

  // ========================================================================
  console.log("\n-- connect: a blocked localStorage write is swallowed (best-effort persist) --");
  // ========================================================================
  {
    signOut();
    installBlockedStorage();
    let threw = false;
    let engine: EngineClient | null = null;
    try {
      engine = connect(HTTPS);
    } catch {
      threw = true;
    }
    ok("connect does not throw when the localStorage write is blocked", threw === false);
    ok("connect still wired the client despite the blocked persist", engine !== null && getEngine() === engine);
    ok("connect still recorded the in-memory engine URL", getEngineUrl() === HTTPS);
    restoreMemoryStorage();
  }

  // ========================================================================
  console.log("\n-- restoreConnection: returns the live client when already connected --");
  // ========================================================================
  {
    signOut();
    restoreMemoryStorage();
    const live = connect(HTTPS);
    const restored = restoreConnection();
    ok("restoreConnection short-circuits to the already-live engine", restored === live);
  }

  // ========================================================================
  console.log("\n-- restoreConnection: a remembered URL is re-pointed and the hook re-wired --");
  // ========================================================================
  {
    signOut();
    restoreMemoryStorage();
    localStorage.setItem(CONN_KEY, HTTPS);
    // Wire a runner first so the re-wired closure's runner-present arm forwards the restored engine.
    let restoreRunnerSaw: EngineClient | null = null;
    setStepUpRunner(async (e) => {
      restoreRunnerSaw = e;
      return "restore-stepup-token";
    });
    const restored = restoreConnection();
    ok("restoreConnection re-points at the remembered URL", restored !== null && getEngineUrl() === HTTPS);
    ok("restoreConnection sets getEngine to the restored client", getEngine() === restored);
    ok("restoreConnection re-wired an onStepUpRequired hook", typeof restored!.onStepUpRequired === "function");
    const withRunner = await restored!.onStepUpRequired!();
    ok("the re-wired hook forwards to the wired runner", withRunner === "restore-stepup-token");
    ok("the re-wired hook hands the runner the restored engine", restoreRunnerSaw === restored);
    // Now clear the runner so the SAME re-wired closure takes its runner-absent arm and resolves null.
    setStepUpRunner(undefined as unknown as (engine: EngineClient) => Promise<string | null>);
    const v = await restored!.onStepUpRequired!();
    ok("the re-wired hook resolves null when the runner is cleared", v === null);
  }

  // ========================================================================
  console.log("\n-- restoreConnection: no remembered URL defaults to this origin --");
  // ========================================================================
  {
    signOut();
    restoreMemoryStorage(); // empty store -> getItem returns null
    const restored = restoreConnection();
    ok("restoreConnection defaults to this origin when nothing is remembered", restored !== null && getEngineUrl() === ORIGIN);
  }

  // ========================================================================
  console.log("\n-- restoreConnection: a blocked read falls back to this origin --");
  // ========================================================================
  {
    signOut();
    installBlockedStorage(); // getItem throws -> the catch sets url = null -> default to origin
    const restored = restoreConnection();
    ok("restoreConnection degrades a blocked read to this origin (not a throw)", restored !== null && getEngineUrl() === ORIGIN);
    restoreMemoryStorage();
  }

  // ========================================================================
  console.log("\n-- restoreConnection: a bad remembered URL degrades to null on boot --");
  // ========================================================================
  {
    signOut();
    restoreMemoryStorage();
    // A non-https, non-localhost origin is rejected by the EngineClient origin guard, so the
    // construction throws and restoreConnection must return null rather than crashing the boot.
    localStorage.setItem(CONN_KEY, "http://stale.example.com");
    const restored = restoreConnection();
    ok("restoreConnection returns null for a remembered URL the client rejects", restored === null);
    ok("a rejected restore leaves the store not connected", getEngine() === null);
    restoreMemoryStorage();
  }

  // ========================================================================
  console.log("\n-- adoptProxiedTopology: every probe arm --");
  // ========================================================================
  {
    // not ok -> false, no reconnect.
    signOut();
    restoreMemoryStorage();
    connect(HTTPS);
    let s = stubTopology({ ok: false });
    ok("adoptProxiedTopology returns false on a non-ok probe", (await adoptProxiedTopology()) === false);
    ok("the probe hit the engine-topology route", s.urls.length === 1 && s.urls[0]!.includes("/engine-topology.json"));
    ok("a non-ok probe leaves the existing connection untouched", getEngineUrl() === HTTPS);
    s.restore();

    // ok but the content-type is not JSON (the SPA shell HTML fallback) -> false.
    s = stubTopology({ ok: true, contentType: "text/html" });
    ok("adoptProxiedTopology returns false when the probe is not JSON", (await adoptProxiedTopology()) === false);
    s.restore();

    // ok but no content-type header at all -> the `?? ""` arm, still not JSON -> false.
    s = stubTopology({ ok: true, contentType: null });
    ok("adoptProxiedTopology returns false when the probe has no content-type", (await adoptProxiedTopology()) === false);
    s.restore();

    // ok JSON but proxied is not true -> false.
    s = stubTopology({ ok: true, body: { proxied: false } });
    ok("adoptProxiedTopology returns false when proxied is not true", (await adoptProxiedTopology()) === false);
    s.restore();

    // ok JSON, proxied:true, but already pointed at this origin -> true, NO reconnect.
    signOut();
    restoreMemoryStorage();
    connect(ORIGIN); // engineUrl already === location.origin
    s = stubTopology({ ok: true, body: { proxied: true } });
    ok("adoptProxiedTopology returns true when proxied and already at this origin", (await adoptProxiedTopology()) === true);
    ok("no reconnect happens when the URL already is this origin", getEngineUrl() === ORIGIN);
    s.restore();

    // ok JSON, proxied:true, pointed elsewhere -> true AND reconnect to this origin.
    signOut();
    restoreMemoryStorage();
    connect(HTTPS); // engineUrl is the split-topology hostname, not this origin
    s = stubTopology({ ok: true, body: { proxied: true } });
    ok("adoptProxiedTopology returns true when proxied and pointed elsewhere", (await adoptProxiedTopology()) === true);
    ok("a proxied topology adopts this origin as the engine URL", getEngineUrl() === ORIGIN);
    s.restore();

    // the probe throws (network fault / shell fallback) -> fail-open false, connection untouched.
    signOut();
    restoreMemoryStorage();
    connect(HTTPS);
    s = stubTopology({ ok: true, throws: true });
    ok("adoptProxiedTopology fails open to false when the probe throws", (await adoptProxiedTopology()) === false);
    ok("a thrown probe leaves the existing connection untouched", getEngineUrl() === HTTPS);
    s.restore();
  }

  // ========================================================================
  console.log("\n-- signOut clears every in-memory field but keeps the remembered URL --");
    restoreMemoryStorage();
    connect(HTTPS);
    setCaller({ id: "u-9" } as unknown as Caller);
    setWhoamiAvailable(true);
    setDownpipesCache([{ id: "dp-x" }] as unknown as DownpipeState[]);
    setRunsCache("dp-x", [{ runId: "r-x" }] as unknown as RunHistoryEntry[]);
    setDestinationsForSearch([{ id: "d-x" }] as unknown as DestinationStatus[]);
    setCredentialsForSearch([{ id: "c-x" }] as unknown as ExpiryStatus[]);
    setRunsForSearch([{ runId: "r-x", index: 0, downpipeId: "dp-x" }]);
    setCeremony({ wrapped: "z" });

    signOut();
    ok("signOut clears the engine client", getEngine() === null);
    ok("signOut clears the caller", getCaller() === null);
    ok("signOut resets whoamiAvailable to false", isWhoamiAvailable() === false);
    ok("signOut clears the downpipes cache", getDownpipesCache() === null);
    ok("signOut clears the runs cache", getRunsCache("dp-x") === undefined);
    ok("signOut clears the destinations search cache", getDestinationsForSearch() === null);
    ok("signOut clears the credentials search cache", getCredentialsForSearch() === null);
    ok("signOut clears the runs search cache", getRunsForSearch() === null);
    ok("signOut clears the in-memory ceremony material", getCeremony() === null);
    ok("signOut keeps the remembered URL so re-auth returns to the same engine", localStorage.getItem(CONN_KEY) === HTTPS);

  if (failures > 0) process.exitCode = 1;

  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nSTORE COVERAGE VECTORS PASS");
}

void main();
