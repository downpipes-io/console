// Validates the ONE setup model the shell reads (src/lib/setup-state.ts setupViewOf over lib/setup-flow's step
// model): the gate, the fail-open rules, and the real-engine first runs the model must get right. These are
// the pieces the shell strip, the rail lock, the redirect, Overview and the palette all key off, so a
// regression here mis-locks the whole console; the one thing the gate must never do is lock a working
// console (fail-open is the contract).
//
// The real-engine cases, each from an engine fact rather than a stored wizard position:
//   (a) a fresh engine;
//   (b) an engine whose keys already exist (deploy.sh makes them and writes ./recovery-kit before the console
//       first loads): Keys reads done with the posture the keys set, and nothing re-keys it;
//   (c) SRC_* bindings from wrangler or IaC and a destination the deployment set: those steps read done, and
//       First backup plans the bound sources;
//   (d) a caller who is not an Owner: the Owner steps are marked, so the shell words a hand-off;
//   (e) a setup-state (or downpipe list) read that fails: no gate, ever.
// Plus an estate set up long ago, or outside this browser: its own integrity record completes setup. And an
// install that finished setup under the rule the console used before this setup page (keys, a destination, the
// account connected, a downpipe), whatever its runs did: the shell never locks it again, while the setup page
// keeps its own step statuses and only a verified seal says "protected". Once the shell reads complete, it stays
// complete for the page's life. And a Run now that did not start every downpipe: the draft names each one and
// why, the first backup waits on it, and "Run it again" starts only it.

import { installDomShim } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { setupAllows, setupLockReason, setupViewOf, noteRouteForLanding, takeFirstLanding, setLastSetupView, setupIncomplete } = await import("../src/lib/setup-state.ts");
const { computeSteps, effectivePosture, firstRunDone, firstRunSealed } = await import("../src/lib/setup-flow/steps.ts");
const { runStageOf } = await import("../src/lib/setup-flow/actions-apply.ts");
const { defaultDraft, emptyFacts, setupModel, pickedResources, SetupModel } = await import("../src/lib/setup-flow/model.ts");
const { resumeQ } = await import("../src/screens/setup/b/flow.ts");
// The palette's two setup commands, read from the screen descriptor itself: "Continue setup" while a numbered
// step is unfinished, and "Check engine wiring" (the engine's own report) once it is not (review F4).
const { setupScreen } = await import("../src/screens/setup/index.ts");
const paletteOffers = (id: string): boolean => {
  const a = (setupScreen.actions ?? []).find((x) => x.id === id);
  return a !== undefined && (a.when === undefined || a.when({ engine: { connected: true }, caller: null } as never));
};
const { acknowledgePosture, applyWithDeployToken, generateKeys, planDownpipes } = await import("../src/lib/setup-flow/index.ts");
const { connect, getEngine, setCaller, setCeremony } = await import("../src/lib/store.ts");
const { runKeyCeremony } = await import("../src/keygen.ts");
type SetupState = import("../src/api.ts").SetupState;
type SetupFacts = import("../src/lib/setup-flow/types.ts").SetupFacts;
type SetupDraft = import("../src/lib/setup-flow/types.ts").SetupDraft;
type SetupSnapshot = import("../src/lib/setup-flow/types.ts").SetupSnapshot;
type DownpipeState = import("../src/api.ts").DownpipeState;

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

function setupState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    keysReady: false,
    signerConfigured: false,
    breakGlassConfigured: false,
    emailConfigured: false,
    discoveryTokenPresent: false,
    accountsSelected: false,
    destination: { configured: false, verified: false, kind: null, source: null },
    boundSourceCount: 0,
    downpipeCount: 0,
    anyRunCompleted: false,
    ready: false,
    ...overrides,
  };
}

// facts builds a shell-scope read: setup-state and the downpipe list answered (discovery not read yet).
function facts(s: Partial<SetupState> = {}, more: Partial<SetupFacts> = {}): SetupFacts {
  const st = setupState(s);
  return { ...emptyFacts(), setup: st, keysReady: st.keysReady, tokenPresent: st.discoveryTokenPresent, readAt: 1, readsAt: { "setup-state": 1, downpipes: 1 }, ...more };
}

function snap(f: SetupFacts, d: Partial<SetupDraft> = {}, ceremonyHeld = false): SetupSnapshot {
  const draft = { ...defaultDraft(), ...d };
  const runtime = { ceremonyHeld };
  const { steps, current } = computeSteps(f, draft, runtime);
  // completeSeen false: each snapshot here is the first read of a page (the latch is checked through the model).
  return { facts: f, draft, runtime, steps, current, protectedNow: firstRunSealed(f, draft), completeSeen: false, loading: false };
}

const dp = (id: string, extra: Partial<DownpipeState> = {}): DownpipeState => ({ config: { id, name: id, cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: "SRC_KV_A", include: [], exclude: [] } }, nextRunAt: 0, lastRunId: null, inFlight: false, ...extra }) as DownpipeState;
const DEST_CONSOLE = { configured: true, verified: true, kind: "r2" as const, source: "console" as const, bucket: "archive" };
const DEST_DEPLOY = { configured: true, verified: false, kind: "r2" as const, source: "deploy" as const };

console.log("-- (a) a fresh engine: seven numbered steps, Connect first --");
{
  const v = setupViewOf(snap(facts()))!;
  ok("a fresh engine yields a view (the facts were read)", v !== null);
  ok("seven numbered steps, Connect to Finish, in order", v.steps.map((s) => s.id).join(",") === "connect,destination,protect,keys,apply,backup,finish");
  ok("nothing done -> step 1 (Connect) is current", v.currentIndex === 0 && v.current.id === "connect" && v.stepNumber === 1);
  ok("a fresh engine is not complete", !v.complete);
  ok("the current step's own screen is allowed (the token lives on Sources)", setupAllows("/sources", v));
  ok("a later step's screen is locked", !setupAllows("/destinations", v) && !setupAllows("/downpipes", v));
  ok("a non-setup screen is locked", !setupAllows("/runs", v) && !setupAllows("/restore", v) && !setupAllows("/notifications", v));
  ok("the setup surface is always allowed", setupAllows("/setup", v) && setupAllows("/setup/:step", v) && setupAllows("/setup/:step/:sub", v));
  ok("Overview, Settings, Keys, the auth routes and the palette landing are always allowed", ["/", "/settings", "/keys", "/keys/rotate", "/keys/custody", "/keys/recovery", "/passkey", "/register", "/signed-out", "/command-palette"].every((p) => setupAllows(p, v)));
  ok("Licence, Costs and Security centre are always allowed (no downpipe dependency)", ["/licence", "/costs", "/security", "/security/owner-actions"].every((p) => setupAllows(p, v)));
  ok("the retired deck's route is no longer a special case", !setupAllows("/onboarding/:step", v));
  ok("the lock reason names the current step and its number", setupLockReason(v) === "Available after setup. Step 1 of 7, Connect, comes first.");
}

console.log("-- progress moves the current step, and each step unlocks its own screen --");
{
  const withToken = facts({ discoveryTokenPresent: true });
  ok("a token (discovery not read yet) completes Connect: the engine refuses a token that sees no account", setupViewOf(snap(withToken))!.current.id === "destination");
  const noAccounts = facts({ discoveryTokenPresent: true }, { discoveryReadAt: 5, readsAt: { "setup-state": 1, downpipes: 1, discovery: 5 }, accounts: [] });
  ok("a token that discovery shows sees NO account does not complete Connect", setupViewOf(snap(noAccounts))!.current.id === "connect");
  const dest = facts({ discoveryTokenPresent: true, destination: DEST_CONSOLE });
  const v = setupViewOf(snap(dest))!;
  ok("a destination moves on to Protect", v.current.id === "protect");
  ok("Destinations unlocks once its step is reached", setupAllows("/destinations", v));
  const picked = setupViewOf(snap(dest, { picks: ["kv:acct:1"] }))!;
  ok("a pick moves on to Keys", picked.current.id === "keys");
}

console.log("-- (b) keys already on the engine (deploy.sh): Keys is done, the posture is theirs, nothing re-keys --");
{
  // Discovery has answered: the one pick is a KV namespace the engine has not bound yet.
  const groups = [{ kind: "kv" as const, label: "KV namespaces", resources: [{ key: "kv:acct:1", kind: "kv" as const, name: "ledger", binding: "SRC_KV_LEDGER", bound: false, accountId: "acct", accountName: "Acct", id: "ns1" }] }];
  const f = facts({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE }, { enginePosture: "operational", groups, accounts: [{ id: "acct", name: "Acct", isEngineAccount: true }], discoveryReadAt: 2, readsAt: { "setup-state": 1, downpipes: 1, discovery: 2 } });
  const s = snap(f, { picks: ["kv:acct:1"] });
  ok("Keys reads done without a ceremony in this tab", s.steps.find((x) => x.id === "keys")?.status === "done");
  ok("the posture is the one the engine's keys set (operational, deploy.sh's default)", effectivePosture(s.facts, s.draft) === "operational");
  ok("an engine holding only the offline pair reads offline", effectivePosture({ ...f, enginePosture: "break-glass-only" }, s.draft) === "break-glass-only");
  // The engine runs with the keys it holds, so its report wins over a draft (review B1: a draft said operational
  // while offline-only keys were installed, and the receipt and the restore-test cadence followed the draft).
  ok("the engine's keys win over a posture confirmed here", effectivePosture(f, { ...s.draft, posture: "break-glass-only" }) === "operational");
  ok("with the engine's posture not read yet, the posture confirmed here stands", effectivePosture({ ...f, enginePosture: null }, { ...s.draft, posture: "break-glass-only" }) === "break-glass-only");
  ok("with no keys on the engine the engine's report is ignored", effectivePosture({ ...f, keysReady: false }, s.draft) === null);
  ok("the setup moves straight on past Keys, to Apply (the pick still needs its binding)", setupViewOf(s)!.current.id === "apply");
}

console.log("-- (c) IaC: an env destination and SRC_* bindings read done by fact --");
{
  const f = facts({ keysReady: true, destination: DEST_DEPLOY, boundSourceCount: 2, discoveryTokenPresent: false });
  const v = setupViewOf(snap(f))!;
  ok("a deployment destination satisfies Destination", v.steps.find((s) => s.id === "destination")?.done === true);
  ok("bound sources satisfy Protect", v.steps.find((s) => s.id === "protect")?.done === true);
  ok("with no token, Connect is still the first open step", v.current.id === "connect");
  const withToken = facts({ keysReady: true, destination: DEST_DEPLOY, boundSourceCount: 2, discoveryTokenPresent: true });
  ok("with a token too, the IaC engine lands on Apply (keys in, nothing to attach)", setupViewOf(snap(withToken))!.current.id === "backup");
}

console.log("-- (d) a caller who is not an Owner: the Owner steps are marked for the hand-off --");
{
  const v = setupViewOf(snap(facts()))!;
  ok("Connect, Destination, Keys and Apply are Owner steps", ["connect", "destination", "keys", "apply"].every((id) => v.steps.find((s) => s.id === id)?.ownerOnly === true));
  ok("First backup is not an Owner step (an Operator can create and run downpipes)", v.steps.find((s) => s.id === "backup")?.ownerOnly === false);
}

console.log("-- (e) fail-open: an unread or failed read never gates --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  ok("facts never read: no gate", setupViewOf(snap(emptyFacts())) === null);
  ok("setup-state read failed: no gate", setupViewOf(snap(facts({}, { failedReads: ["setup-state"] }))) === null);
  ok("the downpipe list read failed: no gate (First backup would read undone on no evidence)", setupViewOf(snap(facts({}, { failedReads: ["downpipes"] }))) === null);
  ok("the downpipe list never read: no gate", setupViewOf(snap(facts({}, { readsAt: { "setup-state": 1 } }))) === null);
  ok("a discovery read that failed does NOT close the gate (Connect falls back to the token fact)", setupViewOf(snap(facts({ discoveryTokenPresent: true }, { failedReads: ["discovery"] })))?.current.id === "destination");
}

console.log("-- an established estate: its own integrity record completes setup, whoever set it up --");
{
  const sealed = facts({ keysReady: true, destination: DEST_DEPLOY, boundSourceCount: 0, downpipeCount: 1, anyRunCompleted: true }, { downpipes: [dp("dp-1", { lastRunId: "r1", lastIntegrityVerifiedAt: "2026-09-01T00:00:00Z", lastIntegrityVerifiedOk: true })] });
  const v = setupViewOf(snap(sealed))!;
  ok("no token, no bindings, but a sealed downpipe: every step before Finish reads done", v.complete);
  ok("complete -> every route allowed", ["/runs", "/restore", "/reports", "/downpipes", "/notifications", "/map"].every((p) => setupAllows(p, v)));
  const neverSealed = facts({ keysReady: true, destination: DEST_DEPLOY, downpipeCount: 1 }, { downpipes: [dp("dp-1")] });
  const ns = snap(neverSealed);
  ok("downpipes that never sealed a run: the setup page's own First backup is current (Connect and Protect read done by the downpipe)", ns.current === "backup");
  ok("...but the shell does not gate: keys, a destination and a downpipe are the facts setup was done by before", setupViewOf(ns)?.complete === true);
  // This setup's own run is the precise signal once it has one: another downpipe's record does not stand in.
  const ownRun = snap(sealed, { createdDownpipeIds: ["dp-2"], firstRun: { downpipeId: "dp-2", runId: "r9" } });
  ok("with a run of its own, this setup waits for THAT run's seal", !ownRun.protectedNow);
  const ownSealed = snap({ ...sealed, runs: { "dp-2": [{ runId: "r9", status: "ok", sealVerification: { status: "verified" } } as never] } }, { createdDownpipeIds: ["dp-2"], firstRun: { downpipeId: "dp-2", runId: "r9" } });
  ok("...and reads sealed once the engine verifies it", ownSealed.protectedNow);
  // VERIFY_AT_SEAL switched off: the engine completes the run with no verdict, and that absence is final (the
  // verdict is attached at completion). First backup is done, so setup never locks a console whose operator
  // chose that setting, but nothing says "protected" or "verified".
  const own = { createdDownpipeIds: ["dp-2"], firstRun: { downpipeId: "dp-2", runId: "r9" } };
  const okNoVerdict = { ...sealed, downpipes: [dp("dp-2", { lastRunId: "r9" })], runs: { "dp-2": [{ runId: "r9", status: "ok" } as never] } };
  const unv = snap(okNoVerdict, own);
  ok("an ok run with no seal verdict completes First backup (firstRunDone)", firstRunDone(unv.facts, unv.draft) && setupViewOf(unv)?.complete === true);
  ok("...but is not protected (no verified seal)", !unv.protectedNow);
  ok("...and the run view reads it as sealed, not verified", runStageOf({ runId: "r9", status: "ok" } as never) === "unverified");
  const suspect = { ...okNoVerdict, runs: { "dp-2": [{ runId: "r9", status: "ok", sealVerification: { status: "suspect" } } as never] } };
  ok("a suspect seal leaves the setup page's First backup open", !firstRunDone(suspect, { ...defaultDraft(), ...own }) && snap(suspect, own).current === "backup" && !snap(suspect, own).protectedNow);
  ok("...and the run view reads it as failed", runStageOf({ runId: "r9", status: "ok", sealVerification: { status: "suspect" } } as never) === "failed");
}

console.log("-- an install that finished setup before this setup page: the shell never locks it again --");
{
  // The facts the console counted as "set up" before (the retired deriveSetup): keys on the engine, a
  // destination, the account connected or sources bound, at least one downpipe. After an upgrade such an
  // install may have no downpipe with the engine's integrity stamp. Each shape of that below must read complete
  // for the shell: the gate (setupAllows, the redirect), the rail locks, the first-load landing and the strip all
  // read view.complete, and the palette reads setupIncomplete().
  const base: Partial<SetupState> = { keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, boundSourceCount: 1, downpipeCount: 1 };
  const everyScreen = ["/downpipes", "/downpipes/:id", "/runs", "/runs/:downpipeId/:index", "/restore", "/reports", "/notifications", "/map"];
  const cases: Array<{ name: string; f: SetupFacts; sealed: boolean }> = [
    { name: "downpipes with no runs", f: facts(base, { downpipes: [dp("dp-1"), dp("dp-2")] }), sealed: false },
    { name: "failed runs only", f: facts(base, { downpipes: [dp("dp-1", { lastRunId: "r1" })] }), sealed: false },
    { name: "runs ok with no seal verdict (verify-at-seal off)", f: facts({ ...base, anyRunCompleted: true }, { downpipes: [dp("dp-1", { lastRunId: "r2" })] }), sealed: false },
    { name: "a downpipe with the engine's integrity stamp", f: facts({ ...base, anyRunCompleted: true }, { downpipes: [dp("dp-1", { lastRunId: "r2", lastIntegrityVerifiedAt: "2026-09-01T00:00:00Z", lastIntegrityVerifiedOk: true })] }), sealed: true },
  ];
  for (const c of cases) {
    const s = snap(c.f);
    const v = setupViewOf(s)!;
    ok(`${c.name}: the shell reads setup complete (no gate, no rail lock, no first-load landing, no step strip)`, v.complete);
    ok(`${c.name}: Downpipes, Runs and every later screen are reachable`, everyScreen.every((p) => setupAllows(p, v)));
    setLastSetupView(v);
    ok(`${c.name}: the palette does not offer Continue setup`, !setupIncomplete() && !paletteOffers("setup.continue"));
    ok(`${c.name}: the palette offers Check engine wiring, which opens the engine's own report`, paletteOffers("setup.check-wiring") && setupScreen.actions?.find((x) => x.id === "setup.check-wiring")?.target === "/setup/finish/check");
    setLastSetupView(null);
    if (c.sealed) {
      ok(`${c.name}: the setup page counts First backup done and says protected (the engine's own record)`, s.steps.find((x) => x.id === "backup")?.status === "done" && s.protectedNow);
      ok(`${c.name}: the strip may say the first backup is sealed`, v.firstBackupDone);
    } else {
      ok(`${c.name}: the setup page keeps First backup open, and it is not protected`, s.steps.find((x) => x.id === "backup")?.status !== "done" && !s.protectedNow);
      ok(`${c.name}: the strip does not claim a sealed first backup`, !v.firstBackupDone);
      ok(`${c.name}: /setup opened by hand shows the steps before it done`, ["welcome", "connect", "destination", "protect", "keys", "apply"].every((id) => s.steps.find((x) => x.id === id)?.status === "done"));
      ok(`${c.name}: and offers the first backup run (it resumes on First backup, which nothing forces)`, resumeQ(s, new Set()) === "backup");
    }
  }
}

console.log("-- a fresh engine and a first run in progress: the gate holds until a downpipe exists --");
{
  const fresh = setupViewOf(snap(facts()))!;
  ok("fresh: not complete, so the first load of / lands on /setup and the rail locks", !fresh.complete);
  ok("fresh: Downpipes and Runs are locked", !setupAllows("/downpipes", fresh) && !setupAllows("/runs", fresh));
  setLastSetupView(fresh);
  ok("fresh: the palette offers Continue setup", setupIncomplete() && paletteOffers("setup.continue"));
  ok("fresh: and not Check engine wiring, which setup reads at Apply", !paletteOffers("setup.check-wiring"));
  setLastSetupView(null);
  // Mid first run, before Create and run now: keys installed, destination saved, sources attached, no downpipe.
  const mid = { keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, boundSourceCount: 1, downpipeCount: 0 };
  const before = setupViewOf(snap(facts(mid)))!;
  ok("mid first run, no downpipe yet: not complete, First backup is step 6", !before.complete && before.current.id === "backup" && before.stepNumber === 6);
  ok("...Downpipes and Runs are reachable (First backup's own screens)", setupAllows("/downpipes", before) && setupAllows("/downpipes/:id", before) && setupAllows("/runs", before) && setupAllows("/runs/:downpipeId/:index", before));
  ok("...while Restore waits", !setupAllows("/restore", before));
  ok("...and a locked item names First backup", setupLockReason(before) === "Available after setup. Step 6 of 7, First backup, comes first.");
  // Mid first run, the run in flight: this setup created the downpipe and started its run.
  const own = { createdDownpipeIds: ["dp-new"], firstRun: { downpipeId: "dp-new", runId: "r1" } };
  const inFlight = facts({ ...mid, downpipeCount: 1 }, { downpipes: [dp("dp-new", { lastRunId: "r1", inFlight: true })], runs: { "dp-new": [{ runId: "r1", status: "in-flight" } as never] } });
  const running = snap(inFlight, own);
  ok("mid first run, the run in flight: the shell counts setup complete (a downpipe exists), as it did before", setupViewOf(running)?.complete === true);
  ok("...while the setup page stays on the run: First backup open, not protected", running.current === "backup" && !running.protectedNow && resumeQ(running, new Set()) === "run");
}

console.log("-- once complete, the shell never locks again in that page's life --");
{
  // A model of its own (a page load of its own), over a stub engine that first answers an install set up under
  // the old rule and then loses its downpipes (deleted, or a redeploy that dropped them).
  const complete = { "/admin/setup-state": setupState({ keysReady: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, downpipeCount: 1 }), "/admin/downpipes": [dp("dp-1")] };
  const emptied = { "/admin/setup-state": setupState({ keysReady: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, downpipeCount: 0 }), "/admin/downpipes": [] };
  connect("https://engine.example.com");
  const page = new SetupModel(getEngine);
  const rec = engineWith(complete);
  await page.refresh("shell");
  ok("the first read is complete", setupViewOf(page.get())?.complete === true);
  rec.restore();
  const rec2 = engineWith(emptied);
  await page.refresh("shell");
  const later = setupViewOf(page.get())!;
  ok("a later read with no downpipe still reads complete: nothing locks", later.complete && setupAllows("/downpipes", later) && setupAllows("/runs", later));
  ok("...while the setup page's own steps follow the facts (with no downpipe and nothing picked, it asks what to protect)", page.get().current === "protect");
  // CONTROL: a new page load that reads only the emptied engine is gated.
  const other = new SetupModel(getEngine);
  await other.refresh("shell");
  ok("CONTROL: a new page that reads only the emptied engine is not complete", setupViewOf(other.get())?.complete === false);
  rec2.restore();
}

console.log("-- the first-run landing is one-shot, and spent by any first route other than / --");
{
  // A new Owner registers the first passkey on /register or /passkey, then lands on "/" (live proof finding 4):
  // those routes must not spend the landing.
  noteRouteForLanding("/register");
  noteRouteForLanding("/passkey");
  noteRouteForLanding("/");
  ok("a first route of /, after the sign-in routes of the same page load, keeps the landing", takeFirstLanding());
  ok("and it is taken once", !takeFirstLanding());
  // CONTROL, on a fresh copy of the module (a new page load): any other first route spends it.
  const fresh = (await import(new URL("../src/lib/setup-state.ts?landing-control", import.meta.url).href)) as typeof import("../src/lib/setup-state.ts");
  fresh.noteRouteForLanding("/downpipes");
  fresh.noteRouteForLanding("/");
  ok("CONTROL: a first route that is not / or a sign-in route spends the landing", !fresh.takeFirstLanding());
}

// ---- actions against a stub engine ------------------------------------------------------------------------

// engineWith answers the admin reads the model makes; POSTs are recorded. An attach binds what it names, so
// discovery reads it bound afterwards, as the engine's does once the new binding is live.
interface Posted { path: string; body: Record<string, unknown> }
function engineWith(routes: Record<string, unknown>): { posted: Posted[]; restore: () => void } {
  const posted: Posted[] = [];
  const real = globalThis.fetch;
  const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posted.push({ path: u.pathname, body });
      if (u.pathname === "/admin/sources/attach") {
        const disc = routes["/admin/sources/discover"] as { bound: Record<string, string[]> } | undefined;
        const add = (body.sources as Array<{ type: string; binding: string }> | undefined) ?? [];
        for (const a of add) disc?.bound[a.type]?.push(a.binding);
        return json({ attached: add.map((a) => a.binding), detached: [] });
      }
      return json({ ok: true });
    }
    return json(routes[u.pathname] ?? {});
  }) as typeof fetch;
  return { posted, restore: () => { globalThis.fetch = real; } };
}
const OWNER = { method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false } as never;
const KEYED_STATUS = { engineVersion: "test", signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: true, private: true } };

console.log("-- (b) in action: the setup never makes or installs keys over keys the engine holds --");
{
  setCaller(OWNER);
  connect("https://engine.example.com");
  const m = setupModel();
  // The model's facts are STALE: its last read said no keys. The engine now holds them (deploy.sh ran).
  m.reset();
  const rec = engineWith({ "/admin/setup-state": setupState({ keysReady: true, signerConfigured: true, breakGlassConfigured: true }) });
  m.update({ posture: "break-glass-only", postureAcknowledged: true, custody: "password-manager" });
  const r = await generateKeys();
  ok("generateKeys asks the engine afresh and refuses: it already holds keys", !r.ok && r.error.kind === "refused" && /already holds keys/.test(r.error.message));
  ok("no ceremony intent was recorded and no key was made", !rec.posted.some((p) => p.path === "/admin/audit/intent"));
  rec.restore();
  // A failed precheck read also makes no keys: an unknown answer is not "no keys".
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("failed to fetch"); }) as typeof fetch;
  const r2 = await generateKeys();
  ok("a precheck that cannot read the engine refuses rather than guessing", !r2.ok && /Could not confirm/.test(r2.error.message));
  globalThis.fetch = real;

  // With keys on the engine, Apply attaches and never POSTs /admin/keys/install.
  const rec2 = engineWith({
    "/admin/setup-state": setupState({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE }),
    "/admin/sources/discover": { tokenPresent: true, engineAccountId: "acct-1", accounts: [{ accountId: "acct-1", accountName: "Test", kv: [{ id: "ns1", title: "ns1", name: "ledger" }], r2: [], d1: [], secrets: [], zones: [] }], bound: { kv: [], r2: [], d1: [], secrets: [] } },
    "/admin/status": KEYED_STATUS,
    "/admin/downpipes": [],
  });
  m.reset();
  await m.refresh();
  const s = m.get();
  ok("after a full read the engine's posture is known (operational)", s.facts.enginePosture === "operational");
  const ack = await acknowledgePosture("break-glass-only");
  ok("a posture cannot be confirmed over keys the engine holds", !ack.ok && /already holds keys/.test(ack.error.message));
  const key = s.facts.groups.flatMap((g) => g.resources).find((x) => x.kind === "kv")?.key;
  m.update({ picks: key ? [key] : [] });
  setCeremony(await runKeyCeremony({ operational: false }));
  const stages: string[] = [];
  const a = await applyWithDeployToken("cfat-one-shot", (stage, state) => stages.push(`${stage}:${state}`));
  ok("Apply completes", a.ok);
  ok("the key install is skipped, never sent", !rec2.posted.some((p) => p.path === "/admin/keys/install") && stages.includes("install-keys:skipped"));
  ok("the picked binding is attached with the same token", rec2.posted.some((p) => p.path === "/admin/sources/attach"));
  setCeremony(null);
  rec2.restore();
}

console.log("-- (b2) in action: an operational key retired but still bound reads break-glass-only, not operational --");
{
  setCaller(OWNER);
  connect("https://engine.example.com");
  const m = setupModel();
  m.reset();
  const rec3 = engineWith({
    "/admin/setup-state": setupState({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE }),
    "/admin/sources/discover": { tokenPresent: true, engineAccountId: "acct-1", accounts: [{ accountId: "acct-1", accountName: "Test", kv: [], r2: [], d1: [], secrets: [], zones: [] }], bound: { kv: [], r2: [], d1: [], secrets: [] } },
    "/admin/status": { ...KEYED_STATUS, operationalRetired: true },
    "/admin/downpipes": [],
  });
  await m.refresh();
  const s = m.get();
  ok("an operational pair left bound beside the retired marker reads break-glass-only, not operational", s.facts.enginePosture === "break-glass-only");
  m.reset();
  rec3.restore();
}

console.log("-- (c) in action: bound sources become the picks, and First backup plans them --");
{
  const rec = engineWith({
    "/admin/setup-state": setupState({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_DEPLOY, boundSourceCount: 2 }),
    "/admin/sources/discover": { tokenPresent: true, engineAccountId: "acct-1", accounts: [{ accountId: "acct-1", accountName: "Test", kv: [], r2: [], d1: [], secrets: [], zones: [] }], bound: { kv: ["SRC_KV_LEDGER"], r2: [], d1: ["SRC_D1_ORDERS"], secrets: [] } },
    "/admin/status": KEYED_STATUS,
    "/admin/downpipes": [],
  });
  const m = setupModel();
  m.reset();
  await m.refresh();
  const s = m.get();
  const picked = pickedResources(s).map((r) => r.binding).sort();
  ok("the engine's SRC_* bindings are adopted as the picks, once", picked.join(",") === "SRC_D1_ORDERS,SRC_KV_LEDGER" && s.draft.boundSeeded);
  ok("Protect and Apply read done by fact; First backup is current", s.current === "backup");
  const plan = planDownpipes();
  ok("First backup plans one downpipe per bound source, under the engine's posture", plan.ok && plan.data.length === 2);
  m.update({ picks: [] });
  await m.refresh();
  ok("an untick sticks: a later read does not adopt them again", m.get().draft.picks.length === 0);
  m.reset();
  rec.restore();
}

console.log("-- a first backup where one of two downpipes sealed and one failed (customer-path F3) --");
{
  // Estate A of the 27 September customer-path test: setup created a D1 and an R2 downpipe and ran both; the R2
  // run sealed and verified, the D1 run failed. The shell must stay unlocked (keys, a destination, the account
  // and a downpipe), but setup's First backup is not done, nothing says "protected", and the shell says the first
  // backup is not finished.
  const base: Partial<SetupState> = { keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, boundSourceCount: 2, downpipeCount: 2 };
  const STAMP = { lastIntegrityVerifiedAt: "2026-09-27T06:20:07Z", lastIntegrityVerifiedOk: true };
  const VERIFIED = { status: "verified" };
  const ids = { createdDownpipeIds: ["dp-d1", "dp-r2"], firstRun: { downpipeId: "dp-d1", runId: "d1-1" }, startedRuns: [{ downpipeId: "dp-d1", runId: "d1-1" }, { downpipeId: "dp-r2", runId: "r2-1" }] };
  const partial = facts(base, {
    downpipes: [dp("dp-d1"), dp("dp-r2", { lastRunId: "r2-1", ...STAMP })],
    runs: { "dp-d1": [{ runId: "d1-1", status: "failed", error: "run failed" } as never], "dp-r2": [{ runId: "r2-1", status: "ok", sealVerification: VERIFIED } as never] },
  });
  const s = snap(partial, ids);
  const v = setupViewOf(s)!;
  ok("partial first run: First backup is not done", !firstRunDone(s.facts, s.draft) && s.steps.find((x) => x.id === "backup")?.status !== "done");
  ok("partial first run: nothing may say protected", !s.protectedNow);
  ok("partial first run: setup resumes on the run, where Run it again is", s.current === "backup" && resumeQ(s, new Set()) === "run");
  ok("partial first run: the shell stays unlocked (never re-locked into setup)", v.complete && ["/downpipes", "/runs", "/restore", "/map"].every((p) => setupAllows(p, v)));
  ok("partial first run: the shell says the first backup is not finished, 1 of 2 sealed", v.firstBackupOpen?.sealed === 1 && v.firstBackupOpen?.total === 2 && !v.firstBackupDone);

  const both = facts(base, {
    downpipes: [dp("dp-d1", { lastRunId: "d1-2", ...STAMP }), dp("dp-r2", { lastRunId: "r2-1", ...STAMP })],
    runs: { "dp-d1": [{ runId: "d1-2", status: "ok", sealVerification: VERIFIED } as never, { runId: "d1-1", status: "failed" } as never], "dp-r2": [{ runId: "r2-1", status: "ok", sealVerification: VERIFIED } as never] },
  });
  const sb = snap(both, ids);
  ok("CONTROL, both sealed (the D1 on its second run): First backup done and protected, nothing open", firstRunDone(sb.facts, sb.draft) && sb.protectedNow && (setupViewOf(sb)?.firstBackupOpen ?? null) === null);

  // A downpipe that fails LATER, after a first backup that fully sealed, is normal operations, not setup.
  const later = facts(base, {
    downpipes: [dp("dp-d1", { lastRunId: "d1-1", ...STAMP }), dp("dp-r2", { lastRunId: "r2-1", ...STAMP })],
    runs: { "dp-d1": [{ runId: "d1-2", status: "failed" } as never, { runId: "d1-1", status: "ok", sealVerification: VERIFIED } as never], "dp-r2": [{ runId: "r2-1", status: "ok", sealVerification: VERIFIED } as never] },
  });
  const sl = snap(later, ids);
  ok("CONTROL, a later failure after a first backup that fully sealed: First backup stays done, nothing is open", firstRunDone(sl.facts, sl.draft) && sl.protectedNow && (setupViewOf(sl)?.firstBackupOpen ?? null) === null);
  const rolled = facts(base, {
    downpipes: [dp("dp-d1", { lastRunId: "d1-1", ...STAMP }), dp("dp-r2", { lastRunId: "r2-1", ...STAMP })],
    runs: { "dp-d1": [{ runId: "d1-9", status: "failed" } as never, { runId: "d1-8", status: "failed" } as never], "dp-r2": [{ runId: "r2-1", status: "ok", sealVerification: VERIFIED } as never] },
  });
  ok("CONTROL, the sealed run has left a ring of later failures: the engine's integrity record for that downpipe stands in", firstRunDone(rolled, { ...defaultDraft(), ...ids }));

  const deleted = facts(base, { downpipes: [dp("dp-r2", { lastRunId: "r2-1", ...STAMP })], runs: { "dp-r2": [{ runId: "r2-1", status: "ok", sealVerification: VERIFIED } as never] } });
  ok("a created downpipe the engine no longer lists (deleted) does not hold the first backup open", firstRunDone(deleted, { ...defaultDraft(), ...ids }) && (setupViewOf(snap(deleted, ids))?.firstBackupOpen ?? null) === null);

  // A tab that holds no setup draft (another browser) cannot tell setup's downpipes from later ones: it keeps the
  // estate's own record, and says nothing is open. This is the documented limit, and it never locks.
  const elsewhere = setupViewOf(snap(partial))!;
  ok("CONTROL, a tab with no setup draft: unlocked, and no first-backup claim either way", elsewhere.complete && (elsewhere.firstBackupOpen ?? null) === null);
}

console.log("-- Apply is not done before Protect, even with keys on the engine (customer-path F11) --");
{
  // A terminal-keyed engine (deploy.sh made the keys) before Connect: the plan column showed Apply ticked, "Keys
  // and 0 bindings live". Apply attaches what Protect picked, so it is not done while nothing is picked.
  const keyed = facts({ keysReady: true, signerConfigured: true, breakGlassConfigured: true });
  const k = snap(keyed);
  ok("keys on the engine, nothing picked: Keys is done", k.steps.find((x) => x.id === "keys")?.status === "done");
  ok("keys on the engine, nothing picked: Apply is not done", k.steps.find((x) => x.id === "apply")?.status !== "done");
  ok("...and the shell's view does not count it", setupViewOf(k)?.steps.find((x) => x.id === "apply")?.done === false);
  const groups = [{ kind: "kv" as const, label: "KV namespaces", resources: [{ key: "kv:acct:1", kind: "kv" as const, name: "ledger", binding: "SRC_KV_LEDGER", bound: true, accountId: "acct", accountName: "Acct", id: "ns1" }] }];
  const picked = facts({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, boundSourceCount: 1 }, { groups });
  ok("CONTROL, the pick picked and its binding live: Apply is done", snap(picked, { picks: ["kv:acct:1"] }).steps.find((x) => x.id === "apply")?.status === "done");
}

console.log("-- a new tab resumes a first backup that is not finished (the draft's first-backup copy) --");
{
  const KEY = "downpipes.setup.first-backup";
  const { clearSessionData } = await import("../src/lib/store.ts");
  const store = (globalThis as unknown as { localStorage: Storage }).localStorage;
  const session = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
  const base = setupState({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, boundSourceCount: 2, downpipeCount: 2 });
  // The engine's own wire shapes: GET /admin/downpipes carries the nested integrity record (the client flattens
  // it), and GET /admin/history?id= answers { entries }.
  const WIRE_STAMP = { integrityVerified: { at: Date.parse("2026-09-27T06:20:07Z"), how: "run" } } as unknown as Partial<DownpipeState>;
  const history = (entries: unknown[]): Response => new Response(JSON.stringify({ entries }), { status: 200, headers: { "content-type": "application/json" } });
  const partialEngine = {
    "/admin/setup-state": base,
    "/admin/downpipes": [dp("dp-d1"), dp("dp-r2", { lastRunId: "r2-1", ...WIRE_STAMP })],
  };
  store.removeItem(KEY);
  session.clear();
  connect("https://engine.example.com");
  // A tab that was already open before setup ran its first backup (an Overview tab): its draft is empty.
  const early = new SetupModel(getEngine);
  // The tab that ran setup: it created both downpipes and ran them. The history route answers per downpipe.
  const rec = engineWith(partialEngine);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/admin/history") {
      const id = u.searchParams.get("id");
      return history(id === "dp-d1" ? [{ runId: "d1-1", index: 1, status: "failed", error: "run failed" }] : [{ runId: "r2-1", index: 1, status: "ok", sealVerification: { status: "verified" } }]);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const tabA = new SetupModel(getEngine);
  tabA.update({ started: true, bucket: "archive", schedule: "weekly", createdDownpipeIds: ["dp-d1", "dp-r2"], firstRun: { downpipeId: "dp-d1", runId: "d1-1" }, startedRuns: [{ downpipeId: "dp-d1", runId: "d1-1" }, { downpipeId: "dp-r2", runId: "r2-1" }] });
  await tabA.refresh("shell");
  const copyRaw = store.getItem(KEY);
  const copy = copyRaw === null ? null : (JSON.parse(copyRaw) as { createdDownpipeIds?: string[] });
  ok("the tab that ran setup keeps a copy of its draft while the first backup is not finished", copy?.createdDownpipeIds?.join(",") === "dp-d1,dp-r2");
  ok("the tab that ran setup reads the first backup open, 1 of 2 sealed", setupViewOf(tabA.get())?.firstBackupOpen?.sealed === 1);
  // A new tab: its own session storage is empty, the browser's localStorage is shared.
  session.clear();
  const tabB = new SetupModel(getEngine);
  ok("a new tab takes up the copy: the same setup, with its answers", tabB.get().draft.createdDownpipeIds.join(",") === "dp-d1,dp-r2" && tabB.get().draft.schedule === "weekly" && tabB.get().draft.bucket === "archive");
  await tabB.refresh("shell");
  const vb = setupViewOf(tabB.get())!;
  ok("the new tab: unlocked, First backup not done, and the first backup reads not finished", vb.complete && !vb.firstBackupDone && vb.firstBackupOpen?.sealed === 1 && vb.firstBackupOpen?.total === 2);
  ok("the new tab: setup resumes on the run", resumeQ(tabB.get(), new Set()) === "run" && !tabB.get().protectedNow);
  await early.refresh("shell");
  ok("a tab that was open before, with an empty draft, takes the copy up at its next read", early.get().draft.createdDownpipeIds.length === 2 && setupViewOf(early.get())?.firstBackupOpen?.total === 2);
  const own = new SetupModel(getEngine);
  own.clearSession();
  own.update({ started: true, bucket: "other" });
  await own.refresh("shell");
  ok("CONTROL, a tab with setup work of its own keeps its own draft", own.get().draft.bucket === "other" && own.get().draft.createdDownpipeIds.length === 0);

  // Both downpipes seal (the D1 on a second run): the first backup is done, and the copy goes.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/admin/downpipes") return new Response(JSON.stringify([dp("dp-d1", { lastRunId: "d1-2", ...WIRE_STAMP }), dp("dp-r2", { lastRunId: "r2-1", ...WIRE_STAMP })]), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/admin/history") {
      const id = u.searchParams.get("id");
      return history(id === "dp-d1" ? [{ runId: "d1-2", index: 2, status: "ok", sealVerification: { status: "verified" } }, { runId: "d1-1", index: 1, status: "failed" }] : [{ runId: "r2-1", index: 1, status: "ok", sealVerification: { status: "verified" } }]);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await tabB.refresh("shell");
  ok("once every downpipe has sealed: First backup done, nothing open, and the copy is removed", tabB.get().steps.find((x) => x.id === "backup")?.status === "done" && setupViewOf(tabB.get())?.firstBackupOpen === null && store.getItem(KEY) === null);
  session.clear();
  const tabC = new SetupModel(getEngine);
  ok("CONTROL, a tab opened after that finds no copy, so a finished setup is not resumed", tabC.get().draft.createdDownpipeIds.length === 0);

  // Sign-out takes the copy with the rest of the session.
  store.setItem(KEY, JSON.stringify({ ...defaultDraft(), createdDownpipeIds: ["dp-d1"] }));
  clearSessionData();
  ok("sign-out removes the copy (store.ts clearSessionData)", store.getItem(KEY) === null);
  globalThis.fetch = realFetch;
  rec.restore();
  session.clear();
}

console.log("-- a first backup where a later trigger did not start a run (a refusal, or a run the engine skipped) --");
{
  // Setup created two downpipes. Run now starts the first, and the engine refuses the second (a 500) or skips it
  // (an answer with no run id, as when a run of it is still in flight). The draft must name the second and why,
  // and the first backup must wait on it until "Run it again" starts it and it seals. The run is read through
  // SetupModel over a stub engine; the page's run view over the demo engine is validate-setup-surface.ts.
  const sf = await import("../src/lib/setup-flow/index.ts");
  const steps = (await import("../src/lib/setup-flow/steps.ts")) as Record<string, unknown>;
  const outstanding = steps.firstBackupOutstanding as ((f: SetupFacts, d: SetupDraft) => string[]) | undefined;
  const SKIP_TEXT = "The engine skipped the run. It may already be running.";
  const base = setupState({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, discoveryTokenPresent: true, destination: DEST_CONSOLE, boundSourceCount: 2, downpipeCount: 2 });
  const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  const triggered: string[] = [];
  // How the engine answers the trigger of dp-b, and the run ring each downpipe reads back.
  let answerB: "run" | "refuse" | "skip" | "401" = "run";
  const rings: Record<string, unknown[]> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/admin/trigger") {
      const id = String((JSON.parse(String(init?.body ?? "{}")) as { id?: unknown }).id);
      triggered.push(id);
      if (id === "dp-b" && answerB === "refuse") return json({ error: "internal" }, 500);
      if (id === "dp-b" && answerB === "skip") return json({ skipped: "a previous run is still in flight (coalesced)" });
      if (id === "dp-b" && answerB === "401") return json({ error: "unauthorised" }, 401);
      return json({ runId: `${id}-r${triggered.length}`, index: triggered.length });
    }
    if (u.pathname === "/admin/setup-state") return json(base);
    if (u.pathname === "/admin/downpipes") return json([dp("dp-a"), dp("dp-b")]);
    if (u.pathname === "/admin/history") return json({ entries: rings[u.searchParams.get("id") ?? ""] ?? [] });
    return json({});
  }) as typeof fetch;
  setCaller(OWNER);
  connect("https://engine.example.com");
  const m = setupModel();
  const sealedRun = (runId: string): unknown => ({ runId, index: 1, status: "ok", sealVerification: { status: "verified" } });
  const start = async (answer: typeof answerB): Promise<Awaited<ReturnType<typeof sf.runNow>>> => {
    m.reset();
    for (const k of Object.keys(rings)) delete rings[k];
    triggered.length = 0;
    answerB = answer;
    m.update({ started: true, createdDownpipeIds: ["dp-a", "dp-b"] });
    return sf.runNow();
  };

  for (const answer of ["refuse", "skip"] as const) {
    const tag = answer === "refuse" ? "second trigger refused (500)" : "second trigger answered with no run id";
    const r = await start(answer);
    const d = m.get().draft;
    const missed = (d as Partial<SetupDraft>).notStarted ?? [];
    ok(`${tag}: CONTROL, Run now still starts the first downpipe's run`, r.ok && r.data.length === 1 && r.data[0]?.downpipeId === "dp-a" && d.startedRuns.map((x) => x.downpipeId).join(",") === "dp-a");
    ok(`${tag}: the draft records the downpipe that did not start, next to startedRuns`, missed.length === 1 && missed[0]?.downpipeId === "dp-b");
    ok(
      `${tag}: with the engine's reason`,
      answer === "skip" ? missed[0]?.reason === SKIP_TEXT : (missed[0]?.reason ?? "") !== "" && missed[0]?.reason !== SKIP_TEXT,
    );
    // The first downpipe's run seals and verifies; the second has no run.
    rings["dp-a"] = [sealedRun(d.startedRuns[0]?.runId ?? "")];
    await m.refresh("shell");
    const s = m.get();
    ok(`${tag}: CONTROL, the first run sealed and the model does not count First backup done`, !sf.firstRunDone(s.facts, s.draft) && !s.protectedNow && s.current === "backup");
    ok(`${tag}: CONTROL, the strip's count agrees, 1 of 2 sealed`, setupViewOf(s)?.firstBackupOpen?.sealed === 1 && setupViewOf(s)?.firstBackupOpen?.total === 2);
    ok(`${tag}: the first backup waits on the downpipe that did not start`, outstanding?.(s.facts, s.draft).join(",") === "dp-b");
    ok(`${tag}: CONTROL, setup resumes on the run view`, resumeQ(s, new Set()) === "run");
    // Run it again: only the downpipe that did not start is started again, and the sealed run stands.
    answerB = "run";
    triggered.length = 0;
    const again = await sf.runNow(outstanding?.(s.facts, s.draft) ?? [], { again: true } as never);
    const d2 = m.get().draft;
    ok(`${tag}: Run it again triggers only that downpipe`, again.ok && triggered.join(",") === "dp-b");
    ok(`${tag}: and the record of the sealed downpipe stands beside the new run`, d2.startedRuns.map((x) => x.downpipeId).sort().join(",") === "dp-a,dp-b" && ((d2 as Partial<SetupDraft>).notStarted ?? []).length === 0);
    rings["dp-b"] = [sealedRun(d2.startedRuns.find((x) => x.downpipeId === "dp-b")?.runId ?? "")];
    await m.refresh("shell");
    const done = m.get();
    ok(`${tag}: once it seals, First backup is done and protected, and nothing is open`, sf.firstRunDone(done.facts, done.draft) && done.protectedNow && (setupViewOf(done)?.firstBackupOpen ?? null) === null && outstanding?.(done.facts, done.draft).length === 0);
  }

  // A 401 still ends the loop at once, and records nothing.
  const expired = await start("401");
  ok("CONTROL, a 401 on the second trigger returns unauthorised at once, and records no run", !expired.ok && expired.error.kind === "unauthorised" && m.get().draft.firstRun === null && m.get().draft.startedRuns.length === 0);
  // Nothing started: the first reason, and nothing recorded (the question shows it and offers Run now again).
  m.reset();
  triggered.length = 0;
  answerB = "refuse";
  m.update({ started: true, createdDownpipeIds: ["dp-b"] });
  const none = await sf.runNow();
  ok("CONTROL, no run started: refused with the engine's reason, and no first run recorded", !none.ok && none.error.kind === "refused" && none.error.message !== "" && m.get().draft.firstRun === null);

  // With no downpipe of its own, setup runs the estate's downpipes (docs review point 3). The run view watches
  // every run it started, so the model must judge every one of them, and a downpipe it did not start.
  const estate = facts(base, {
    downpipes: [dp("dp-a"), dp("dp-b")],
    runs: { "dp-a": [sealedRun("a1") as never], "dp-b": [{ runId: "b1", status: "failed", error: "run failed" } as never] },
  });
  const both = { firstRun: { downpipeId: "dp-a", runId: "a1" }, startedRuns: [{ downpipeId: "dp-a", runId: "a1" }, { downpipeId: "dp-b", runId: "b1" }] };
  const se = snap(estate, both);
  ok("estate run, the first run sealed and the second failed: First backup is not done", !firstRunDone(se.facts, se.draft) && !se.protectedNow && resumeQ(se, new Set()) === "run");
  ok("estate run: the first backup waits on the downpipe whose run failed", outstanding?.(se.facts, se.draft).join(",") === "dp-b");
  const skipped = snap(estate, { firstRun: { downpipeId: "dp-a", runId: "a1" }, startedRuns: [{ downpipeId: "dp-a", runId: "a1" }], notStarted: [{ downpipeId: "dp-b", reason: SKIP_TEXT }] } as Partial<SetupDraft>);
  ok("estate run, the second not started: First backup is not done", !firstRunDone(skipped.facts, skipped.draft));
  const estateSealed = facts(base, { downpipes: [dp("dp-a"), dp("dp-b")], runs: { "dp-a": [sealedRun("a1") as never], "dp-b": [sealedRun("b1") as never] } });
  ok("CONTROL, estate run with both sealed: First backup done and protected", firstRunDone(estateSealed, { ...defaultDraft(), ...both }) && snap(estateSealed, both).protectedNow);

  globalThis.fetch = realFetch;
  m.reset();
}

verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nSETUP-STATE VECTORS PASS");
