// The training-world contract: the demo-layer semantics the guided training walk stands on.
//
// WHY THIS EXISTS. The training walk (the tour chassis's task-gated sibling) teaches the REAL guided
// first run over the demo world, which only works if the world behaves like a fresh account and then
// moves as the learner acts: the setup gate must engage on the training-start variant, each setup fact
// must flip exactly when the learner's own write lands it, a triggered run must settle deterministically,
// a queued change must land in the inbox it tells the visitor to open, and the time jumps must produce a
// coherent month of history. Each of those is a seam that used to be absent or dishonest (a token any
// value verifies, a run that stays in-flight forever, an approval that flipped a DIFFERENT change than
// the one acted on), so each is pinned here at the world level, where a regression is a named FAIL
// rather than a training chapter that silently stops advancing.
//
// The screen-level halves live where they always have: validate-tour.ts drives the scripted walks over
// the real screens, and the harness's training-walk journey drives the shipped bundle in a real browser.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDomShim } from "./dom-shim.ts";
import { engineRoot } from "./engine-root.ts";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const g = globalThis as unknown as Record<string, unknown>;
g.location = g.location ?? { origin: "https://console.test", search: "" };

const { buildSeed } = await import("../src/lib/demo/demo-seed.ts");
const { applyDemoState, applyDemoStateVariant, resetWorld, world } = await import("../src/lib/demo/demo-world.ts").then(async (m) => ({
  ...m,
  applyDemoStateVariant: (await import("../src/lib/demo/demo-state.ts")).applyDemoStateVariant,
}));
const { advanceWorldDays, injectRunFailure } = await import("../src/lib/demo/demo-state.ts");
const { route } = await import("../src/lib/demo/demo-routes-read.ts");
const demoWorldModule = await import("../src/lib/demo/demo-world.ts");
const { PREVIOUS_ENGINE_VERSION, SUPPORTED_ENGINE_VERSION } = await import("../src/lib/engine-release.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The live world reference: demo-world exports `let world`, so reads must go through the module's live
// binding, not a destructured snapshot taken before resetWorld replaced the object.
function liveWorld(): typeof world {
  return demoWorldModule.world;
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await Promise.resolve(route(path));
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function post(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await Promise.resolve(route(path, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

type SetupFacts = {
  keysReady: boolean;
  discoveryTokenPresent: boolean;
  accountsSelected: boolean;
  destination: { configured: boolean; verified: boolean; kind: string | null; bucket?: string };
  boundSourceCount: number;
  downpipeCount?: number;
  anyRunCompleted?: boolean;
  ready: boolean;
};
async function setupFacts(): Promise<SetupFacts> {
  return (await get("/admin/setup-state")).body as unknown as SetupFacts;
}

// ---------------------------------------------------------------------------------------------------
console.log("pristine seed: the derived setup-state agrees with the old static snapshot");
// ---------------------------------------------------------------------------------------------------
resetWorld();
{
  const s = await setupFacts();
  ok("keysReady true", s.keysReady === true);
  ok("destination configured + verified", s.destination.configured === true && s.destination.verified === true);
  ok("destination kind s3 (the seeded AWS endpoint)", s.destination.kind === "s3");
  ok("destination bucket is the seeded archive bucket", s.destination.bucket === "northwind-archive-apse2");
  ok("discovery token present, accounts selected", s.discoveryTokenPresent === true && s.accountsSelected === true);
  ok("downpipeCount is the fleet size", s.downpipeCount === liveWorld().downpipes.length && (s.downpipeCount ?? 0) > 0);
  // boundSourceCount now honestly counts the four seeded BINDINGS (kv/r2/d1/secrets) rather than echoing
  // the downpipe count; its only consumer reads it as greater-than-zero (lib/setup-state.ts deriveSetup).
  ok("boundSourceCount counts the seeded bindings", s.boundSourceCount === 4);
  ok("anyRunCompleted true, ready true", s.anyRunCompleted === true && s.ready === true);
}

// ---------------------------------------------------------------------------------------------------
console.log("training-start: a fresh account, gate engaged, dual control off; empty keeps its posture");
// ---------------------------------------------------------------------------------------------------
resetWorld();
applyDemoState({ kind: "training-start" });
{
  const s = await setupFacts();
  ok("keysReady false (step 1 engages)", s.keysReady === false);
  ok("no destination, no token, nothing bound", s.destination.configured === false && s.discoveryTokenPresent === false && s.boundSourceCount === 0);
  ok("no downpipes, no completed run, not ready", s.downpipeCount === 0 && s.anyRunCompleted === false && s.ready === false);
  ok("dual control reads OFF (a fresh account's default)", liveWorld().configApprovalPolicy.requireConfigApproval === false);
  const empty = applyDemoStateVariant(buildSeed(Date.now()), { kind: "empty" });
  ok("the empty variant KEEPS the seeded governance posture (its baselines depend on it)", empty.configApprovalPolicy.requireConfigApproval === true);
  ok("the empty variant also keeps keysReady (setup stays dissolved for the matrices)", empty.setupState.keysReady === true);
}

// ---------------------------------------------------------------------------------------------------
console.log("the five-step walk: each fact flips exactly when the learner's write lands");
// ---------------------------------------------------------------------------------------------------
{
  // Step 1, keys. Acknowledge refuses while no keys are observed (the self-heal must not dissolve the
  // gate), then the install flips the stored facts and acknowledge agrees.
  const premature = await post("/admin/setup/acknowledge");
  ok("acknowledge refuses before keys exist (ok:false, the engine's server-enforced no-op)", premature.body.ok === false);
  const install = await post("/admin/keys/install", { token: "training-one-shot", signerPrivate: "x", breakGlassPublic: "y" });
  ok("keys/install answers the engine's result shape", install.body.ok === true && (install.body.configured as { signer: boolean }).signer === true);
  ok("keysReady derives true after install", (await setupFacts()).keysReady === true);
  const acknowledged = await post("/admin/setup/acknowledge");
  ok("acknowledge now agrees (ok:true)", acknowledged.body.ok === true);

  // Step 2, destination.
  const dest = await post("/admin/destinations", { label: "Training archive", config: { endpoint: "https://demoacct.r2.cloudflarestorage.com", bucket: "training-archive", region: "auto" } });
  ok("the destination write applies (list returned)", dest.status === 200);
  const afterDest = await setupFacts();
  ok("destination derives configured + verified, kind r2", afterDest.destination.configured === true && afterDest.destination.verified === true && afterDest.destination.kind === "r2");
  // THE SINGULAR VIEW MOVES WITH THE WRITE. GET /admin/destination is what the New downpipe wizard asks
  // (editor-wizard.ts's destProbe), and it used to serve a second, seeded copy that the add-a-destination
  // write never touched: a learner who had just verified and saved their destination met "No destination
  // yet" in the wizard, on the very next step of the course.
  const singular = await get("/admin/destination");
  const singularValue = singular.body as unknown as { present: boolean; bucket?: string };
  ok("GET /admin/destination reports the destination the learner just saved", singularValue.present === true && singularValue.bucket === "training-archive");

  // Step 3, connect: the sentinels first, then the happy path.
  const refused = await post("/admin/sources/discovery-token", { token: "training-bad-token" });
  ok("the bad-token sentinel is refused with a coarse reason", refused.status === 400 && typeof refused.body.error === "string");
  ok("a refused token stores nothing", liveWorld().sourceDiscovery.tokenPresent === false);
  const zeroScopes = await post("/admin/sources/discovery-token", { token: "training-empty-scopes" });
  const zeroValue = zeroScopes.body as unknown as { present: boolean; accountsSeen: unknown[] };
  ok("the zero-scopes sentinel verifies with NO accounts seen (the warn path)", zeroValue.present === true && zeroValue.accountsSeen.length === 0);
  const connected = await post("/admin/sources/discovery-token", { token: "any-training-placeholder" });
  const connectedValue = connected.body as unknown as { present: boolean; accountsSeen: unknown[] };
  ok("a placeholder token verifies and sees the demo account", connectedValue.present === true && connectedValue.accountsSeen.length === 1);
  // The RAW wire shape is load-bearing: parseJsonOrOwnerAction wraps the 2xx body itself, so a demo
  // handler that pre-wraps ({status:"result",value:...}) double-wraps and every screen reads
  // value.<field> as undefined. Measured live on the attach panel before this assertion existed.
  ok("the wire body is the RAW DiscoveryStatus, never a pre-wrapped envelope", !("value" in connected.body) && !("status" in connected.body));
  const afterToken = await setupFacts();
  ok("discoveryTokenPresent + accountsSelected derive true", afterToken.discoveryTokenPresent === true && afterToken.accountsSelected === true);

  // Step 4, sources: the attach lands in the bound tier.
  const attach = await post("/admin/sources/attach", { token: "training-one-shot", sources: [{ type: "kv", binding: "PAYMENTS_KV", namespaceId: "demo-kv-payments" }], remove: [] });
  const attachValue = attach.body as unknown as { attached: string[]; detached: string[] };
  ok("the attach echoes what landed", attachValue.attached.length === 1 && attachValue.attached[0] === "PAYMENTS_KV");
  ok("boundSourceCount derives 1", (await setupFacts()).boundSourceCount === 1);

  // Step 5, downpipe: dual control is off, so the write APPLIES and answers the created state.
  const created = await post("/admin/downpipes", { id: "dp-train", name: "Training pipe", cadenceSeconds: 86_400, enabled: true, source: { type: "kv", binding: "PAYMENTS_KV", include: [], exclude: [] } });
  const createdConfig = created.body.config as { id: string } | undefined;
  ok("the gate-off create applies inline (the DownpipeState, not a 202)", created.status === 200 && createdConfig?.id === "dp-train");
  ok("the world holds the new downpipe with an empty ring", liveWorld().downpipes.some((d) => d.config.id === "dp-train") && Array.isArray(liveWorld().historyByDownpipe["dp-train"]));
  const afterCreate = await setupFacts();
  ok("downpipeCount derives 1; ready derives true", afterCreate.downpipeCount === 1 && afterCreate.ready === true);
  ok("anyRunCompleted still false (nothing has run)", afterCreate.anyRunCompleted === false);
}

// ---------------------------------------------------------------------------------------------------
console.log("trigger and settle: honestly in-flight for a fixed number of reads, then ok");
// ---------------------------------------------------------------------------------------------------
{
  const triggered = await post("/admin/trigger", { id: "dp-train" });
  const runId = triggered.body.runId as string;
  ok("the trigger mints a run id", typeof runId === "string" && runId.startsWith("run-train"));
  const firstRead = await get("/admin/history?id=dp-train");
  const firstHead = (firstRead.body.entries as Array<{ status: string }>)[0];
  ok("the first history read still shows in-flight (the learner sees Running)", firstHead?.status === "in-flight");
  const secondRead = await get("/admin/history?id=dp-train");
  const secondHead = (secondRead.body.entries as Array<{ status: string; recordCount?: number; destinationId?: string }>)[0];
  ok("the second history read settles it ok", secondHead?.status === "ok");
  ok("the settled run carries honest counts and its destination", typeof secondHead?.recordCount === "number" && typeof secondHead?.destinationId === "string");
  ok("the downpipe's in-flight flag cleared", liveWorld().downpipes.find((d) => d.config.id === "dp-train")?.inFlight === false);
  const after = await setupFacts();
  ok("anyRunCompleted derives true after the settle", after.anyRunCompleted === true);
}

// ---------------------------------------------------------------------------------------------------
console.log("trigger and settle on a LIST read: the downpipes screen reads the list straight after Run now");
// ---------------------------------------------------------------------------------------------------
{
  // The downpipes screen reads no history for a row while the list says it is in flight, and reads it once the
  // row leaves flight. So a demo run must settle on the list poll alone, or a demo Run now stays Running.
  const triggered = await post("/admin/trigger", { id: "dp-train" });
  const runId = triggered.body.runId as string;
  ok("a second trigger mints a run id", typeof runId === "string" && runId.startsWith("run-train"));
  const inFlightNow = (await get("/admin/downpipes")).body as unknown as Array<{ config?: { id: string }; id?: string; inFlight?: boolean }>;
  const rowOf = (rows: typeof inFlightNow) => rows.find((r) => (r.config?.id ?? r.id) === "dp-train");
  ok("the first list read shows it settled, with no history read in between", rowOf(inFlightNow)?.inFlight === false);
  const head = ((await get("/admin/history?id=dp-train")).body.entries as Array<{ runId: string; status: string }>)[0];
  ok("the one history read after it left flight shows the new run ok at the top", head?.runId === runId && head?.status === "ok");
}

// ---------------------------------------------------------------------------------------------------
console.log("the rerun task stays done when a later Run now puts a new in-flight run on top");
// ---------------------------------------------------------------------------------------------------
{
  const { rerunSucceeded } = await import("../src/lib/demo/tour/scripts/training-beginner.ts");
  ok("a failed run with nothing newer is not done", rerunSucceeded([{ status: "failed" }, { status: "ok" }]) === false);
  ok("an ok run above the failed one is done", rerunSucceeded([{ status: "ok" }, { status: "failed" }, { status: "ok" }]) === true);
  ok("a new in-flight run on top of that ok run keeps the step done", rerunSucceeded([{ status: "in-flight" }, { status: "ok" }, { status: "failed" }]) === true);
  ok("an in-flight rerun alone is not done yet", rerunSucceeded([{ status: "in-flight" }, { status: "failed" }]) === false);
  ok("a ring with no failed run is not this task", rerunSucceeded([{ status: "ok" }]) === false);
}

// ---------------------------------------------------------------------------------------------------
console.log("a second Run now while a run is in flight is the engine's coalesced skip, not a stacked run");
// ---------------------------------------------------------------------------------------------------
{
  const first = await post("/admin/trigger", { id: "dp-train" });
  const runId = first.body.runId as string;
  ok("the first press mints a run", typeof runId === "string" && runId.startsWith("run-train"));
  const second = await post("/admin/trigger", { id: "dp-train" });
  ok("a second press while it is in flight answers the engine's coalesced skip", second.body.skipped === "a previous run is still in flight (coalesced)" && second.body.runId === undefined);
  const ringNow = liveWorld().historyByDownpipe["dp-train"] ?? [];
  ok("no second in-flight run is stacked on top", ringNow[0]?.runId === runId && ringNow.filter((e) => e.status === "in-flight").length === 1);
  await get("/admin/downpipes");
  const head = ((await get("/admin/history?id=dp-train")).body.entries as Array<{ runId: string; status: string }>)[0];
  ok("after the list read the pressed run settles ok at the top", head?.runId === runId && head?.status === "ok");
  const third = await post("/admin/trigger", { id: "dp-train" });
  ok("once it has settled, Run now starts a new run again", typeof third.body.runId === "string" && third.body.runId !== runId);
  await get("/admin/downpipes");
  await get("/admin/downpipes");
}

// ---------------------------------------------------------------------------------------------------
console.log("dual control ON: the queued change lands in the inbox it points the visitor at");
// ---------------------------------------------------------------------------------------------------
{
  liveWorld().configApprovalPolicy = { requireConfigApproval: true, requireChangeNumber: false };
  const inboxBefore = liveWorld().configChanges.length;
  const queued = await post("/admin/downpipes", { id: "dp-gated", name: "Gated pipe", cadenceSeconds: 86_400, enabled: true, source: { type: "kv", include: [], exclude: [] } });
  const queuedId = queued.body.id as string;
  ok("the gated create defers (202 queued)", queued.status === 202 && queued.body.queued === true);
  ok("the queued change LANDS in world.configChanges", liveWorld().configChanges.length === inboxBefore + 1 && liveWorld().configChanges[0]?.id === queuedId);
  ok("and the world did not apply it", liveWorld().downpipes.every((d) => d.config.id !== "dp-gated"));
  const approved = await post(`/admin/config/changes/${queuedId}/approve`);
  ok("approving THAT id flips THAT change to applied", approved.body.id === queuedId && approved.body.status === "applied");
  const unknown = await post("/admin/config/changes/chg-does-not-exist/approve");
  ok("an unknown id is answered honestly (404), never a silent flip of the seeded change", unknown.status === 404 && typeof unknown.body.error === "string");
}

// ---------------------------------------------------------------------------------------------------
console.log("time jumps: a coherent month of history, and a failure that reads as a story");
// ---------------------------------------------------------------------------------------------------
{
  const ringBefore = liveWorld().historyByDownpipe["dp-train"]?.length ?? 0;
  demoWorldModule.applyWorldTransform((w) => advanceWorldDays(w, 30));
  const ring = liveWorld().historyByDownpipe["dp-train"] ?? [];
  ok("advance(30) grows the ring by thirty runs", ring.length === ringBefore + 30);
  ok("the head is ok and the downpipe's lastRunId follows it", ring[0]?.status === "ok" && liveWorld().downpipes.find((d) => d.config.id === "dp-train")?.lastRunId === ring[0]?.runId);
  const indexes = ring.map((e) => e.index);
  ok("indexes are strictly descending from the head (renumbered by position)", indexes.every((n, i) => i === 0 || n === (indexes[i - 1] ?? 0) - 1));
  ok("runIds are re-minted from the renumbered index", ring.every((e) => e.runId === `run-train-${String(e.index).padStart(4, "0")}`));

  const notifyBefore = liveWorld().notifyHistory.length;
  demoWorldModule.applyWorldTransform((w) => injectRunFailure(w, "dp-train"));
  const failedHead = (liveWorld().historyByDownpipe["dp-train"] ?? [])[0];
  ok("the injected failure sits at the head with a real coarse error", failedHead?.status === "failed" && typeof failedHead?.error === "string" && failedHead.error.includes("AccessDenied"));
  ok("no notify entry was fabricated (the fresh account has no channel to have delivered it)", liveWorld().notifyHistory.length === notifyBefore);
  liveWorld().notifyChannels.push({ id: "chan-training", kind: "email", name: "Training email", enabled: true, createdAt: new Date().toISOString() });
  demoWorldModule.applyWorldTransform((w) => injectRunFailure(w, "dp-train"));
  const notifyHead = liveWorld().notifyHistory[0];
  ok("with a channel present the failure carries its critical notification", notifyHead?.event === "backup-failure" && notifyHead?.channelId === "chan-training");
}

// ---------------------------------------------------------------------------------------------------
console.log("the learner's own destination is reported back as the store it actually is");
// ---------------------------------------------------------------------------------------------------
// WHY THIS IS HERE. GET /admin/setup-state derived the kind as
// `includes("r2.cloudflarestorage.com") ? "r2" : "s3"`, which has two answers where the product has four.
// The R2 case above was therefore graded and the other three were not, and the block above passes just as
// well for the two-answer derivation. A learner who saved a Google Cloud or an Azure destination in the
// course had it reported back as S3, and this fact is what the residency panel, the topology map's phrase
// and the downpipe drawer all read: the course named the wrong vendor for the learner's own archive, on
// the screens whose whole job is to say where it went.
//
// The variant is re-applied for each vector, because the FIRST destination saved into an empty collection
// is the one that becomes the default, and this route reads the default.
{
  const savedKind = async (endpoint: string, bucket: string): Promise<string | null> => {
    resetWorld(Date.UTC(2026, 6, 1, 0, 0, 0));
    applyDemoState({ kind: "training-start" });
    const w = await post("/admin/destinations", { label: "Training archive", config: { endpoint, bucket, region: "auto" } });
    if (w.status !== 200) return `HTTP ${String(w.status)}`;
    const st = (await get("/admin/setup-state")).body as unknown as SetupFacts;
    return st.destination.kind;
  };
  ok("an Azure Blob endpoint reads as azure", (await savedKind("https://learneracct.blob.core.windows.net", "training-archive")) === "azure");
  ok("a Google Cloud interop endpoint reads as gcs", (await savedKind("https://storage.googleapis.com", "training-archive")) === "gcs");
  ok("CONTROL: an R2 endpoint still reads as r2, so the four-way answer did not lose the one it had", (await savedKind("https://demoacct.r2.cloudflarestorage.com", "training-archive")) === "r2");
  ok("CONTROL: an unrecognised S3-compatible host still reads as s3, so the residual is still the residual", (await savedKind("https://s3.wasabisys.com", "training-archive")) === "s3");
}

// ---------------------------------------------------------------------------------------------------
console.log("engine version: every demo engine version field names the one release this console supports");
// ---------------------------------------------------------------------------------------------------
resetWorld();
{
  const status = (await get("/admin/status")).body as unknown as { engineVersion: string };
  ok("status.engineVersion is the supported release", status.engineVersion === SUPPORTED_ENGINE_VERSION);

  const updates = (await get("/admin/updates")).body as unknown as { currentVersion: string; recommendedVersion: string };
  ok("updates.currentVersion is the supported release", updates.currentVersion === SUPPORTED_ENGINE_VERSION);
  ok("updates.recommendedVersion is the supported release", updates.recommendedVersion === SUPPORTED_ENGINE_VERSION);

  const preflight = (await get("/admin/preflight")).body as unknown as { engineVersion: string };
  ok("preflight.engineVersion is the supported release", preflight.engineVersion === SUPPORTED_ENGINE_VERSION);

  const updateStatus = (await get("/admin/update/status")).body as unknown as { last: { recommendedVersion: string; toVersion: string; fromVersion: string } | null };
  ok("update/status last.recommendedVersion is the supported release", updateStatus.last?.recommendedVersion === SUPPORTED_ENGINE_VERSION);
  ok("update/status last.toVersion is the supported release", updateStatus.last?.toVersion === SUPPORTED_ENGINE_VERSION);
  ok("update/status last.fromVersion names the last release actually shipped (a real upgrade, not a no-op)", updateStatus.last?.fromVersion === PREVIOUS_ENGINE_VERSION);

  const apply = (await post("/admin/update/apply")).body as unknown as { value: { recommendedVersion: string } };
  ok("update/apply reports the supported release as the recommended one", apply.value.recommendedVersion === SUPPORTED_ENGINE_VERSION);
  const settle = (await post("/admin/update/settle")).body as unknown as { recommendedVersion: string; fromVersion: string; toVersion: string };
  ok("update/settle names the supported release as recommended, from and to", settle.recommendedVersion === SUPPORTED_ENGINE_VERSION && settle.fromVersion === SUPPORTED_ENGINE_VERSION && settle.toVersion === SUPPORTED_ENGINE_VERSION);
  const rollback = (await post("/admin/update/rollback")).body as unknown as { toVersion: string };
  ok("update/rollback names the supported release", rollback.toVersion === SUPPORTED_ENGINE_VERSION);
  const ramp = (await post("/admin/update/ramp")).body as unknown as { value: { recommendedVersion: string } };
  ok("update/ramp reports the supported release as the recommended one", ramp.value.recommendedVersion === SUPPORTED_ENGINE_VERSION);

  // PREVIOUS_ENGINE_VERSION must be an earlier release than SUPPORTED_ENGINE_VERSION, compared numerically
  // part by part (never as strings: "0.3.10" < "0.3.9" would otherwise read true), or the seeded "last
  // update" record reads as a downgrade rather than the upgrade it is meant to show.
  const numericParts = (v: string): number[] => v.split(".").map((p) => Number.parseInt(p, 10));
  const isLower = (a: string, b: string): boolean => {
    const [pa, pb] = [numericParts(a), numericParts(b)];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const [na, nb] = [pa[i] ?? 0, pb[i] ?? 0];
      if (na !== nb) return na < nb;
    }
    return false;
  };
  ok("PREVIOUS_ENGINE_VERSION is numerically lower than SUPPORTED_ENGINE_VERSION", isLower(PREVIOUS_ENGINE_VERSION, SUPPORTED_ENGINE_VERSION));
}

// SIBLING-SUPPLY: when the engine sibling is present, the constant this console ships must equal the
// engine's own package.json version, so "the release this console supports" is never a guess. A missing
// sibling is a property of the checkout (a console-only clone has no engine to compare against) and prints a
// SKIP rather than a fail. Under REQUIRE_ENGINE=1 (npm run validate:workspace) the comparison is mandatory,
// so a missing engine is CANNOT CHECK, exit 2.
{
  const root = engineRoot();
  if (root === null) {
    if (process.env.REQUIRE_ENGINE === "1") {
      verdictCannotCheck(
        "validate-training-world: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable.\n" +
          "  SUPPORTED_ENGINE_VERSION and PREVIOUS_ENGINE_VERSION are graded against the engine's own package.json\n" +
          "  and CHANGELOG.md, so with no engine neither comparison ran.\n" +
          "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.",
      );
    }
    console.log("  SKIP  no sibling engine checkout (set DOWNPIPES_ENGINE to compare SUPPORTED_ENGINE_VERSION against it)");
  } else {
    const enginePkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string };
    ok(`SUPPORTED_ENGINE_VERSION matches the engine's own package.json version (${enginePkg.version ?? "unset"})`, enginePkg.version === SUPPORTED_ENGINE_VERSION);

    // PREVIOUS_ENGINE_VERSION must name a release the engine actually shipped, not a guess: its own
    // CHANGELOG.md carries a heading for every released version, in the form "## [<version>] - <date>".
    const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
    ok(`the engine's CHANGELOG.md has a release heading for PREVIOUS_ENGINE_VERSION (${PREVIOUS_ENGINE_VERSION})`, changelog.includes(`## [${PREVIOUS_ENGINE_VERSION}]`));
  }
}

console.log(`\n${failures === 0 ? "TRAINING-WORLD PASS" : `TRAINING-WORLD: ${failures} FAILED`}\n`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
