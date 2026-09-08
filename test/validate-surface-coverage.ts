// Validate the Cloudflare-coverage hero's pure status function (screens/overview/surface-coverage).
// Run with: node test/validate-surface-coverage.ts
//
// surfaceCoverage(downpipes, discovery) is the one place the red/amber/green logic for the nine
// Cloudflare surfaces lives. It is pure and DOM-free, so this validator round-trips every branch:
// covered (a downpipe backs it up), added (a bound binding or an added token source), unadded (not
// added), unavailable (a token surface the engine does not advertise), and unknown (the downpipe list
// or discovery could not be read). It RUNS the production function; it never re-implements it.
//
// House rules: Australian English, no em dashes, precise claims, no AI attribution.

import { installDomShim } from "./dom-shim.ts";
import { surfaceCoverage, discoveryFailureClass, discoveryFailureNote, type SurfaceCoverage, type SurfaceType, type SurfaceState } from "../src/screens/overview.ts";
import type { Settled } from "../src/screens/overview.ts";
import type { DownpipeState, SourceDiscovery } from "../src/api.ts";

// surface-coverage.ts imports the DOM helpers (for its renderer), so install the shim before importing
// chains touch the DOM. The pure function under test does not use the DOM.
installDomShim();

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  ok(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);
}

// dp builds a minimal DownpipeState whose single source is the given surface type.
function dp(type: SurfaceType): DownpipeState {
  return {
    config: { id: `dp-${type}`, name: type, cadenceSeconds: 3600, enabled: true, source: { type, include: [], exclude: [] } },
    nextRunAt: 0,
    lastRunId: null,
    inFlight: false,
  };
}

// disc builds a settled SourceDiscovery with empty bound lists, overlaid with the given fields.
function disc(overrides: Partial<SourceDiscovery>): Settled<SourceDiscovery> {
  return { ok: true, value: { bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: true, ...overrides } };
}

const find = (cov: SurfaceCoverage[], t: SurfaceType): SurfaceCoverage => {
  const c = cov.find((x) => x.type === t);
  if (!c) throw new Error(`surface ${t} missing from coverage`);
  return c;
};
const stateOf = (cov: SurfaceCoverage[], t: SurfaceType): SurfaceState => find(cov, t).state;

// ---------------------------------------------------------------------------
console.log("-- shape: the nine surfaces, in the advert's order --");
// ---------------------------------------------------------------------------
{
  const cov = surfaceCoverage([], disc({}));
  eq("returns exactly nine surfaces", cov.length, 9);
  const order = cov.map((c) => c.type).join(",");
  eq("the order mirrors the advert grid", order, "kv,r2,d1,secrets,workers,stream,images,artifacts,cf-config");
}

// ---------------------------------------------------------------------------
console.log("\n-- covered (green): a downpipe backs the surface up --");
// ---------------------------------------------------------------------------
{
  // r2 has a downpipe; with empty discovery it would otherwise be unadded, but coverage wins.
  const cov = surfaceCoverage([dp("r2")], disc({}));
  eq("a surface with a downpipe is covered", stateOf(cov, "r2"), "covered");
  eq("covered carries the downpipe count", find(cov, "r2").downpipeCount, 1);
  // Two downpipes on the same surface count as two.
  const cov2 = surfaceCoverage([dp("kv"), dp("kv")], disc({ bound: { kv: ["KV_A"], r2: [], d1: [], secrets: [] } }));
  eq("two downpipes on one surface count as two", find(cov2, "kv").downpipeCount, 2);
  eq("coverage wins over an added binding (kv is covered, not added)", stateOf(cov2, "kv"), "covered");
}

// ---------------------------------------------------------------------------
console.log("\n-- binding sources: added when a binding exists, else not added --");
// ---------------------------------------------------------------------------
{
  const cov = surfaceCoverage([], disc({ bound: { kv: ["KV_MAIN"], r2: [], d1: [], secrets: [] } }));
  eq("a bound binding with no downpipe is added", stateOf(cov, "kv"), "added");
  eq("a binding with no binding present is not added", stateOf(cov, "r2"), "unadded");
  eq("d1 with no binding is not added", stateOf(cov, "d1"), "unadded");
  eq("secrets with no binding is not added", stateOf(cov, "secrets"), "unadded");
}

// ---------------------------------------------------------------------------
console.log("\n-- token sources (modern engine that gates adds via addedSources) --");
// ---------------------------------------------------------------------------
{
  const cov = surfaceCoverage(
    [],
    disc({
      workersSupported: true,
      streamSupported: true,
      imagesSupported: true,
      artifactsSupported: true,
      cfConfigSurfaces: [{ id: "z", label: "Zone settings", category: "zone", scope: "zone", restoreTier: "api" }],
      addedSources: ["workers", "cf-config"],
    }),
  );
  eq("an added token source is added", stateOf(cov, "workers"), "added");
  eq("cf-config in addedSources is added", stateOf(cov, "cf-config"), "added");
  eq("an offered but not-added token source is not added", stateOf(cov, "stream"), "unadded");
  eq("images offered but not added is not added", stateOf(cov, "images"), "unadded");
}

// ---------------------------------------------------------------------------
console.log("\n-- token sources the engine does not advertise are unavailable --");
// ---------------------------------------------------------------------------
{
  // Only Workers is supported; stream/images/artifacts/cf-config are not advertised by this engine.
  const cov = surfaceCoverage([], disc({ workersSupported: true, addedSources: ["workers"] }));
  eq("workers (supported + added) is added", stateOf(cov, "workers"), "added");
  eq("an unadvertised token surface is unavailable, not 'not added'", stateOf(cov, "stream"), "unavailable");
  eq("cf-config with no surface catalogue is unavailable", stateOf(cov, "cf-config"), "unavailable");
}

// ---------------------------------------------------------------------------
console.log("\n-- legacy engine (addedSources absent = ungated 'all supported available') --");
// ---------------------------------------------------------------------------
{
  // No addedSources field: the legacy ungated wizard. An OFFERED token surface reads "added" (available
  // to protect), never a false "not added"; an unoffered one is still unavailable.
  const cov = surfaceCoverage(
    [],
    disc({ workersSupported: true, streamSupported: true, cfConfigSurfaces: [{ id: "z", label: "Z", category: "zone", scope: "zone", restoreTier: "api" }] }),
  );
  eq("legacy + offered workers reads added", stateOf(cov, "workers"), "added");
  eq("legacy + offered cf-config reads added", stateOf(cov, "cf-config"), "added");
  eq("legacy + unoffered images is unavailable", stateOf(cov, "images"), "unavailable");
}

// ---------------------------------------------------------------------------
console.log("\n-- honest unknown: discovery failed, or the downpipe list could not be read --");
// ---------------------------------------------------------------------------
{
  const failed: Settled<SourceDiscovery> = { ok: false, error: new Error("discover: 500") };
  // Discovery failed but a downpipe still proves coverage: covered wins.
  const cov = surfaceCoverage([dp("kv")], failed);
  eq("a covered surface stays covered even when discovery failed", stateOf(cov, "kv"), "covered");
  // A non-covered surface cannot be classified added vs not, so it is an honest unknown, never a false red.
  eq("a non-covered surface with failed discovery is unknown", stateOf(cov, "r2"), "unknown");

  // The downpipe list itself unreadable: every surface is unknown (never assert 'not covered' off nothing).
  const allUnknown = surfaceCoverage(null, disc({ bound: { kv: ["KV"], r2: [], d1: [], secrets: [] } }));
  eq("a null downpipe list makes every surface unknown", allUnknown.filter((c) => c.state === "unknown").length, 9);

  // A partial discovery (ok:true but value undefined) is treated as no-discovery, not a throw.
  const partial = { ok: true, value: undefined } as unknown as Settled<SourceDiscovery>;
  const covPartial = surfaceCoverage([], partial);
  eq("a partial (undefined-value) discovery degrades non-covered surfaces to unknown", stateOf(covPartial, "kv"), "unknown");
}

// ---------------------------------------------------------------------------
console.log("\n-- a realistic mixed account renders a believable spread --");
// ---------------------------------------------------------------------------
{
  const cov = surfaceCoverage(
    [dp("kv"), dp("r2"), dp("cf-config")],
    disc({
      bound: { kv: ["KV_MAIN"], r2: ["bucket"], d1: [], secrets: ["store/SECRET"] },
      workersSupported: true,
      streamSupported: true,
      imagesSupported: true,
      artifactsSupported: true,
      cfConfigSurfaces: [{ id: "z", label: "Z", category: "zone", scope: "zone", restoreTier: "api" }],
      addedSources: ["workers", "cf-config"],
    }),
  );
  eq("kv covered", stateOf(cov, "kv"), "covered");
  eq("r2 covered", stateOf(cov, "r2"), "covered");
  eq("cf-config covered (downpipe beats added)", stateOf(cov, "cf-config"), "covered");
  eq("secrets added (bound, no downpipe)", stateOf(cov, "secrets"), "added");
  eq("workers added (token added, no downpipe)", stateOf(cov, "workers"), "added");
  eq("d1 not added", stateOf(cov, "d1"), "unadded");
  eq("stream not added (offered, not added)", stateOf(cov, "stream"), "unadded");
  // Artifact Registry is held behind the ARTIFACTS_GA closed-beta gate (lib/token-source.ts), so even
  // though the engine advertises artifactsSupported it is never offered and reads "unavailable" (not on
  // this engine), never a false "not added" that would invite an add the console cannot fulfil.
  eq("artifacts unavailable (ARTIFACTS_GA beta gate)", stateOf(cov, "artifacts"), "unavailable");
  const covered = cov.filter((c) => c.state === "covered").length;
  const added = cov.filter((c) => c.state === "added").length;
  const unadded = cov.filter((c) => c.state === "unadded").length;
  eq("three protected", covered, 3);
  eq("two added", added, 2);
  eq("three not added (d1, stream, images; artifacts beta-gated to unavailable)", unadded, 3);
}

// ---------------------------------------------------------------------------
// A FAILED source-discovery read must say so, and say why: rendering nine mute "Coverage unknown" tiles
// looks the same as a benign unreadable account and gives the operator nothing to act on. Instead the
// failure is classified through the console's OWN closed error taxonomy (never the message text, so no
// engine or Cloudflare API string reaches the copy), and renders one honest sentence naming the control
// that fixes it. A SUCCESSFUL read yields null: no note, no cry of wolf.
// ---------------------------------------------------------------------------
{
  console.log("\na failed discovery read is classified and named");
  const failed = (err: unknown): Settled<SourceDiscovery> => ({ ok: false, error: err });

  eq("a 5xx from the discovery route is an engine fault", discoveryFailureClass(failed(new Error("discover sources: 502"))), "engine");
  eq("a 401 is an auth fault", discoveryFailureClass(failed(new Error("discover sources: 401"))), "auth");
  eq("a 403 is an auth fault", discoveryFailureClass(failed(new Error("discover sources: 403"))), "auth");
  eq("a 429 is rate-limited", discoveryFailureClass(failed(new Error("discover sources: 429"))), "rate-limited");
  eq("a fetch throw with no status is unreachable", discoveryFailureClass(failed(new TypeError("Failed to fetch"))), "unreachable");

  // The NOISE FILTER, and the negative control: a discovery read that SUCCEEDED, or one that was never
  // attempted, is not a fault and must produce no class and no note at all.
  ok("a successful discovery read is not a fault", discoveryFailureClass(disc({})) === null);
  ok("an absent discovery read is not a fault", discoveryFailureClass(null) === null);
  ok("a successful discovery read renders no note", discoveryFailureNote(disc({})) === null);

  // The engine-fault sentence is the one an operator can ACT on, so it must name the discovery token.
  const note = discoveryFailureNote(failed(new Error("discover sources: 502")));
  ok("the engine-fault note names the discovery token", (note?.includes("discovery token") ?? false));
  ok("the engine-fault note never blames the operator's session", note !== null && !note.toLowerCase().includes("sign in again"));
  // No note may carry the raw thrown text (the error message is engine-derived; only the class travels).
  const notes = ["engine", "auth", "rate-limited", "unreachable"].map((_c, i) =>
    discoveryFailureNote(failed(new Error(["discover sources: 502", "discover sources: 401", "discover sources: 429", "boom"][i] ?? ""))),
  );
  ok("no note echoes the thrown message", notes.every((n) => n !== null && !n.includes("discover sources") && !n.includes("boom")));
}

// ---------------------------------------------------------------------------
// NO DISCOVERY TOKEN: the DEFAULT state, and the one this file never covered.
//
// Every disc() above defaults tokenPresent:true, so the opt-in default had no case at all, and the screen
// shipped telling a healthy current estate that four surfaces its engine supports were "not on this engine".
// Confirmed live against an estate verified on the checkout's build by estate-build-drift: the
// Overview summary chip read "9 surfaces · 2 protected · 1 added · 1 not added · 5 not on this engine".
console.log("\n-- no discovery token is its own state, not engine skew --");
{
  const cov = surfaceCoverage([], disc({ tokenPresent: false }));
  for (const t of ["cf-config", "workers", "stream", "images", "artifacts"] as const) {
    eq(`${t} with no token reads notoken, not unavailable`, stateOf(cov, t), "notoken");
  }
  // The four binding sources are reachable through the engine's own wrangler bindings and need no token, so
  // a missing token must not touch them.
  for (const t of ["kv", "r2", "d1", "secrets"] as const) {
    eq(`${t} is unaffected by a missing discovery token`, stateOf(cov, t), "unadded");
  }
  ok("no surface is left claiming the engine lacks it", cov.every((c) => c.state !== "unavailable"));
}
{
  // tokenPresent ABSENT is a different fact from tokenPresent FALSE: an engine predating the account tier
  // really does not have these, so that one keeps saying so. This is the distinction lib/token-source.ts
  // draws, and folding the two together in either direction loses a real diagnosis.
  // Cast through unknown deliberately: SourceDiscovery DECLARES tokenPresent, so a response omitting it does
  // not typecheck, and that is the point. The wire is a bare JSON cast, so the declared field is a promise
  // about a current engine rather than a fact about this one, and an engine predating the account tier really
  // does send this shape.
  const cov = surfaceCoverage([], { ok: true, value: { bound: { kv: [], r2: [], d1: [], secrets: [] } } } as unknown as Settled<SourceDiscovery>);
  eq("workers on an engine older than the account tier is still unavailable", stateOf(cov, "workers"), "unavailable");
}
{
  // A stored token restores the engine-capability reading, so the fix cannot mask real skew.
  const cov = surfaceCoverage([], disc({ tokenPresent: true, workersSupported: true, streamSupported: true, imagesSupported: true, cfConfigSurfaces: [{ id: "z", label: "Z", category: "zone", scope: "zone", restoreTier: "api" }], addedSources: [] }));
  eq("with a token, an advertised surface is read normally", stateOf(cov, "workers"), "unadded");
  eq("with a token, artifacts stays unavailable behind the beta gate", stateOf(cov, "artifacts"), "unavailable");
}

// ---------------------------------------------------------------------------
// THE SUMMARY CHIP, which is the at-a-glance line and was the half that lied by arithmetic.
//
// Three faults, all in one sentence a customer reads above the fold. Unknown was named only when EVERY
// surface was unknown, so a mix rendered the unread ones as "0 added · 0 not added" and "0 not added" reads
// as no gaps. "protected" was the chip's word for a surface that merely has a downpipe, which is coverage
// and not health, and which the tiles below never say. And "9 surfaces" was a literal beside a grid derived
// from SURFACES, the same shape as the "about 195 surfaces" string this tree already corrected once.
console.log("\n-- the summary chip counts what it says it counts --");
{
  const { buildSurfaceCoverageGrid } = await import("../src/screens/overview/surface-coverage.ts");
  const { textOf } = await import("./dom-shim.ts");
  const overview = (downpipes: Settled<DownpipeState[]>, discovery: Settled<SourceDiscovery>): unknown => ({ downpipes, discovery });

  // A DOWNPIPE-LIST read that failed while discovery succeeded: the mixed case.
  const mixed = textOf(buildSurfaceCoverageGrid(overview({ ok: false, error: new Error("list downpipes: 500") } as never, disc({ tokenPresent: false })) as never));
  ok("the unread surfaces are counted rather than folded into the zeros", /could not be read/.test(mixed));

  // The healthy read, which is where the two wording faults live.
  const { qs } = await import("./dom-shim.ts");
  const healthySection = buildSurfaceCoverageGrid(overview({ ok: true, value: [] } as never, disc({ tokenPresent: true })) as never);
  const healthy = textOf(healthySection);
  ok("the chip no longer calls a merely-configured surface protected", !/\bprotected\b/.test(healthy));
  ok("it says what the tiles say", /in a downpipe/.test(healthy));
  // COUNTED, not merely present: the total in the chip must equal the tiles actually rendered beside it,
  // which is what a literal cannot promise. Asserting the string "9 surfaces" would pass with the literal
  // fully restored, so the tile count is the comparison.
  const gridEl = qs(healthySection as never, ".ov-coverage-grid") as unknown as { childNodes: unknown[] } | null;
  const tiles = gridEl === null ? -1 : gridEl.childNodes.length;
  const stated = Number(/(\d+) surface/.exec(healthy)?.[1] ?? "-2");
  console.log(`         chip says ${stated}, grid renders ${tiles}`);
  ok("the surface total in the chip equals the tiles rendered", stated === tiles && tiles > 0);
}

// ---------------------------------------------------------------------------
// OFF THE WIRE, NOT OFF A HAND-WRITTEN ERROR. Every discovery-failure assertion above constructs the
// thrown value itself, as `new Error("discover sources: 429")`. The transport does not produce that
// message for a 429 that carries a Retry-After, and a 429 from the engine's rate limiter or from
// Cloudflare's own edge always carries one: client-transport.ts folds it in as
// "<verb>: retry-after=<n>: <status>". So the ONE assertion guarding the never-cry-wolf note has never
// seen the shape the product actually emits, and any fault between the Response and the class (the
// marker fold, the trailing-status convention extractStatus keys on, the order of the branches in
// classifyError) is invisible to it. That is a control matching a scheme the code does not use.
//
// This section closes it from the other end: a REAL Response, through the REAL Transport and the REAL
// discoverSources, settled exactly as fetchOverviewData settles it, rendered by the REAL grid builder,
// and read back as the note's ACTUAL TEXT out of the DOM. Asserting "a note rendered", or counting the
// hints, would hold over a blank hero as well as a working one, so each leg names its own sentence.
console.log("\n-- the failure note off a real wire response, not a hand-written Error --");
{
  const { buildSurfaceCoverageGrid } = await import("../src/screens/overview/surface-coverage.ts");
  const { qs } = await import("./dom-shim.ts");
  const { Transport } = await import("../src/lib/api/client-transport.ts");
  const { discoverSources } = await import("../src/lib/api/client-sources.ts");

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  // The legs, each named by the distinctive slice of the sentence it must render. "throws" is the wire
  // answer; a null answer means fetch itself rejected (the unreachable class).
  const legs: Array<{ name: string; answer: () => Response; slice: string | null }> = [
    { name: "a healthy 200", answer: () => json(200, { bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: true }), slice: null },
    // THE LEG THIS SECTION EXISTS FOR: a 429 as the wire really sends it, Retry-After and all.
    { name: "a 429 carrying Retry-After", answer: () => json(429, { error: "rate limited" }, { "retry-after": "30" }), slice: "rate-limited the account read" },
    { name: "a 429 with no Retry-After", answer: () => json(429, { error: "rate limited" }), slice: "rate-limited the account read" },
    { name: "a 401", answer: () => json(401, { error: "unauthorised" }), slice: "could not read source discovery" },
    { name: "a 500", answer: () => json(500, { error: "server error" }), slice: "under-scoped discovery token" },
    { name: "a 200 whose body is truncated", answer: () => new Response('{"bound":{"r2":["x"', { status: 200, headers: { "content-type": "application/json" } }), slice: "Cloudflare account read failed" },
  ];

  // settle is fetchOverviewData's settle (screens/overview/fetch.ts), which is the step that decides
  // whether a thrown 429 ever becomes a failed read at all.
  const settle = async <T>(p: Promise<T>): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const realFetch = globalThis.fetch;
  let rendered = 0;
  try {
    for (const leg of legs) {
      globalThis.fetch = (async () => leg.answer()) as typeof globalThis.fetch;
      const settled = await settle(discoverSources(new Transport("https://engine.invalid")));
      const section = buildSurfaceCoverageGrid({ downpipes: { ok: true, value: [] }, discovery: settled } as never);
      const hint = qs(section as never, "p.field__hint") as unknown as { textContent: string } | null;
      const note = hint === null ? null : (hint.textContent ?? "").trim();
      console.log(`         ${leg.name} -> ${JSON.stringify(note)}`);
      rendered++;
      if (leg.slice === null) {
        ok(`${leg.name} renders no failure note`, note === null || note === "");
        ok(`${leg.name} settles as a successful read`, settled.ok);
        continue;
      }
      // The note's OWN sentence, not merely that some note appeared: a mis-classified fault renders a
      // sibling class's copy, which "a note rendered" would happily accept.
      ok(`${leg.name} renders the sentence for its class`, note?.includes(leg.slice) === true);
      ok(`${leg.name} settles as a FAILED read`, !settled.ok);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  // A sweep that visited nothing must FAIL rather than pass silently.
  ok(`every wire leg was driven (${rendered} of ${legs.length})`, rendered === legs.length && rendered > 0);
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\nvalidate-surface-coverage: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nvalidate-surface-coverage: all checks passed");
