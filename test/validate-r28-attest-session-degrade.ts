// the same unguarded-response crash shape fixed on the recovery-codes panel, on the
// attest-session routes /restore/attend drives. POST /admin/attest/session/create (and its /prove,
// /capsules, /verify siblings) had NO case in the demo world's write table, so a click fell through to
// benignWrite's generic { ok:true, deleted:true, applied:true, status:"result", value:{ok:true} } -- a
// shape with no `runs` field. restore-flow/attend.ts's start() then read `session.runs.length` UNGUARDED
// on the cast CreateAttestSessionResult, throwing TypeError: Cannot read properties of undefined (reading
// 'length') -- confirmed against the DEPLOYED tour bundle (tour.downpipes.io/app.js + chunk-VYJW5XI5.js):
// the minified `r.runs.length===0` call site and the demo-fetch chunk's route table (whose
// default-write fallback literal `ok:!0,deleted:!0,applied:!0,status:"result",val...` matches benignWrite
// byte-for-byte, and carries no case for any `attest/session/*` path) both carry the exact shape this
// source tree does.
//
// This proves the fix at every layer it touches:
//   1. attend.ts itself (start() AND resumeSession()) validates the engine's response BEFORE trusting its
//      shape, degrading to an honest, actionable outcome from ANY caller -- not only the demo world's
// benignWrite fallback, the same reason hardened recoveryCodesPanel rather than only the one
//      call site that happened to crash on it first.
//   2. the API client (client-attest.ts, createAttestSession + attestStatus) validates the SAME shape at
//      the wire boundary, so a malformed 200 throws a plain Error there too, reusing the runner's existing
//      blockError retry UI rather than ever returning a session it cannot honour.
//   3. the demo route table now models POST /admin/attest/session/create and its /prove, /capsules,
//      /verify siblings for real, so the tour pins the estate's ACTUAL runs instead of falling through to
//      benignWrite, while staying honest about the one thing a no-custody demo cannot fake: it holds no
//      real recovery keypair to check a live-possession proof against, so a run's key still, correctly,
//      cannot be recovered from a demo capsule.
//
// Run with: node test/validate-r28-attest-session-degrade.ts

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";
installDomShim();

// Now it is safe to import the modules under test (they touch document at load).
const { route } = await import("../src/lib/demo/demo-routes-read.ts");
const { resetWorld } = await import("../src/lib/demo/demo-world.ts");
const { renderAttendRunner } = await import("../src/screens/restore-flow/attend.ts");
const { isCreateAttestSessionResult, isAttestSessionRecord } = await import("../src/lib/api/types.ts");
const { createAttestSession, attestStatus } = await import("../src/lib/api/client-attest.ts");
const { Transport } = await import("../src/lib/api/client-transport.ts");
const store = await import("../src/lib/store.ts");

import type { Caller, CreateAttestSessionResult, AttestSessionRecord, AttestCapsulesResult } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}


// The exact benignWrite shape (src/lib/demo/demo-world.ts) an unmodelled write route answers with -- what
// the demo used to return for every attest/session/* path before this fix, and what any OTHER unmodelled
// route (a real engine on an older version, a stub in a test) can still answer today.
const BENIGN_WRITE_SHAPE = { ok: true, deleted: true, applied: true, status: "result", value: { ok: true } };
// The equivalent benignGet shape (a GET route the demo has not modelled): present:false, no `session`.
const BENIGN_GET_SHAPE = { ok: true, present: false, found: false, items: [] as unknown[] };

// A minimal FileReader/File shim so the identity.key file input works under the DOM shim, matching the
// established pattern in test/validate-attend-from-shares.ts and test/validate-break-glass-restore.ts.
class ShimFile {
  _text: string;
  name: string;
  type = "text/plain";
  constructor(text: string, name: string) {
    this._text = text;
    this.name = name;
  }
}
class ShimFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  readAsText(file: ShimFile): void {
    this.result = file._text;
    setTimeout(() => this.onload?.(), 0);
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.FileReader = ShimFileReader;
g.File = ShimFile;
if (g.MutationObserver === undefined) {
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

function supplyFile(root: ShimNode, id: string, text: string): void {
  const el = qs(root, `#${id}`);
  if (el === null) throw new Error(`no control #${id} on the attend screen`);
  (el as unknown as { files: unknown }).files = [new ShimFile(text, "identity.key")];
  el.dispatchEvent({ type: "change", target: el, currentTarget: el, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} });
}

function startButton(root: ShimNode): ShimNode {
  const b = qs(root, `[data-dp="restore-flow.button.start"]`);
  if (b === null) throw new Error("the attended-verification Start button is not on the screen");
  return b;
}

async function renderRunner(): Promise<ShimNode> {
  const owner: Caller = { method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(owner);
  store.connect("https://engine.test");
  const engine = store.getEngine();
  if (!engine) throw new Error("no engine in store");
  const root = renderAttendRunner(engine) as unknown as ShimNode;
  await flushAsync();
  return root;
}

// =====================================================================================
// SECTION 1: the demo route table models the four attest-session routes for real.
// =====================================================================================
async function testDemoRouteModelsAttestSession(): Promise<void> {
  console.log("\n-- demo route table: the attest-session routes return USABLE shapes, not benignWrite --");
  resetWorld(Date.UTC(2026, 6, 30, 0, 0, 0));

  const createRes = await route("/admin/attest/session/create", { method: "POST", body: JSON.stringify({}) });
  ok("create: status 200", createRes.status === 200);
  const created = (await createRes.json()) as CreateAttestSessionResult;
  ok("the body is a USABLE CreateAttestSessionResult (the reported gap was the benign\n" +
    "       {ok:true,...} fallback, which carries no `runs` field at all)", isCreateAttestSessionResult(created));
  ok("pins at least one real, seeded run (not an empty/fabricated estate)", created.runs.length > 0);
  ok("every pinned run carries a real downpipe id and run id from the seed", created.runs.every((r) => r.downpipeId !== "" && r.runId !== ""));
  ok("the estimate is derived from the pinned runs, not zero", created.estimate.runs === created.runs.length && created.estimate.records >= 0);
  ok("the challenge carries both fields the browser's deriveAttestProof reads", typeof created.challenge.ciphertextB64 === "string" && created.challenge.ciphertextB64.length > 0 && typeof created.challenge.nonceB64 === "string" && created.challenge.nonceB64.length > 0);

  const proveRes = await route("/admin/attest/session/prove", { method: "POST", body: JSON.stringify({ sessionId: created.sessionId, proofB64: "anything" }) });
  ok("prove: status 200 (an unconditional, honest handshake ack -- the demo holds no keypair to check a real proof against)", proveRes.status === 200);

  const capsulesRes = await route("/admin/attest/session/capsules", { method: "POST", body: JSON.stringify({ sessionId: created.sessionId, runIds: created.runs.map((r) => r.runId) }) });
  ok("capsules: status 200", capsulesRes.status === 200);
  const capsules = (await capsulesRes.json()) as AttestCapsulesResult;
  ok("one capsule wrap per pinned run (a real shape, not the benign fallback)", capsules.capsules.length === created.runs.length);
  ok("every capsule carries a fingerprint that can never match a real identity -- the honest ceiling of a\n" +
    "       demo with no real recovery keypair, not a shortcut", capsules.capsules.every((c) => c.masterCapsule.length > 0 && c.masterCapsule[0]!.fingerprint.startsWith("dpr1:")));

  const verifyRes = await route("/admin/attest/session/verify", { method: "POST", body: JSON.stringify({ sessionId: created.sessionId, batch: [] }) });
  ok("verify: status 200 with a real AttestVerifyResult shape (results/progress present)", verifyRes.status === 200);
  const verified = (await verifyRes.json()) as { results: unknown[]; progress: unknown };
  ok("verify shape carries results + progress", Array.isArray(verified.results) && typeof verified.progress === "object");
}

// =====================================================================================
// SECTION 2: the type guards -- the exact predicate the fix checks, proven against the exact
// malformed shape the deployed tour served.
// =====================================================================================
function testGuardsRejectTheBenignShape(): void {
  console.log("\n-- isCreateAttestSessionResult / isAttestSessionRecord: the benignWrite/benignGet shapes fail --");
  ok("isCreateAttestSessionResult(benignWrite shape) is false (no `runs` field)", !isCreateAttestSessionResult(BENIGN_WRITE_SHAPE));
  ok("isCreateAttestSessionResult(a real result) is true", isCreateAttestSessionResult({ sessionId: "s1", challenge: { ciphertextB64: "a", nonceB64: "b" }, runs: [], sampleRate: 100, estimate: { runs: 0, records: 0 } }));
  ok("isAttestSessionRecord(undefined) is false (benignGet has no `session` field at all)", !isAttestSessionRecord((BENIGN_GET_SHAPE as { session?: unknown }).session));
  ok("isAttestSessionRecord(a real record) is true", isAttestSessionRecord({ sessionId: "s1" } satisfies AttestSessionRecord));

  console.log("\n-- the exact reproduction: session.runs.length on the benignWrite shape throws (was: the live crash) --");
  let threw: unknown = null;
  try {
    const session = BENIGN_WRITE_SHAPE as unknown as CreateAttestSessionResult;
    // This is EXACTLY what attend.ts's start() did before the fix: cast, then read `.runs.length`
    // unguarded. Left in to prove the underlying gap is real, not merely asserted.
    void session.runs.length;
  } catch (err) {
    threw = err;
  }
  ok("confirmed: reading .runs.length on the unmodelled-route shape throws TypeError (the live symptom)", threw instanceof TypeError);
}

// =====================================================================================
// SECTION 3: restore-flow/attend.ts's start() degrades honestly from ANY caller, driven through the REAL
// Start button -- the exact reproduction end-to-end, against a stub engine answering the malformed
// shape directly (bypassing client-attest.ts entirely, so this proves the SCREEN does not trust its
// caller, the same reason the recovery-codes panel did not trust its caller).
// =====================================================================================
async function testStartDegradesHonestly(): Promise<void> {
  console.log("\n-- restore-flow/attend.ts start(): a malformed engine response degrades to an honest\n" +
    "   outcome, never an unhandled rejection or session.runs.length throwing, end-to-end --");

  const root = await renderRunner();
  const owner: Caller = { method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(owner);
  const engine = store.getEngine();
  if (!engine) throw new Error("no engine in store");

  // Stub createAttestSession to answer the EXACT benignWrite shape, asserted through the engine client's
  // OWN return type so a real TS caller could not have produced this by construction -- exactly how a
  // JSON-boundary response bypasses the type system in practice.
  (engine as unknown as { createAttestSession: () => Promise<unknown> }).createAttestSession = async () => BENIGN_WRITE_SHAPE;

  const km = await (await import("../src/keygen.ts")).runKeyCeremony({ operational: false });
  const identityText = (await import("../src/keygen.ts")).identityFile(km.breakGlass);
  supplyFile(root, "attend-identity", identityText);
  await flushAsync();
  ok("the identity.key was read and Start is enabled", startButton(root).disabled === false);

  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown): void => { unhandled = reason; };
  process.on("unhandledRejection", onUnhandled);
  try {
    (startButton(root) as unknown as HTMLButtonElement).click();
    await flushAsync();
    await flushAsync();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  ok("no unhandled rejection from Start (was: TypeError from session.runs.length)", unhandled === null);
  const bodyText = textOf(root);
  ok("an HONEST, ACTIONABLE outcome renders (a person can act on it)", bodyText.includes("Could not start attended verification"));
  ok("it does NOT claim a session actually started", !bodyText.includes("Pinning your runs"));
}

// =====================================================================================
// SECTION 4: resumeSession() -- the same shape, one hop further out (GET /admin/attest/session/status's
// `session` field absent entirely). Not named in the row's own description, but the identical defect: a
// route the engine has not modelled degrades to a 200 with no `session` field, and `record.runs` was read
// unguarded on a `record` that was itself undefined.
// =====================================================================================
async function testResumeDegradesHonestly(): Promise<void> {
  console.log("\n-- restore-flow/attend.ts resumeSession(): the same shape on the STATUS read (the\n" +
    "   same gap one hop further out) degrades honestly instead of throwing on `record.runs` --");

  // Persist a resume marker BEFORE rendering, so the runner offers the resume banner on mount.
  (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem(
    "downpipes.attend.session", JSON.stringify({ sessionId: "attest-stale-session", sampleRate: 100 }),
  );

  const root = await renderRunner();
  const owner: Caller = { method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(owner);
  const engine = store.getEngine();
  if (!engine) throw new Error("no engine in store");

  // Stub attestStatus to answer the benignGet shape: NO `session` field at all, which is what
  // `(await engine.attestStatus(id)).session` reads as `undefined` on an unmodelled route.
  (engine as unknown as { attestStatus: () => Promise<unknown> }).attestStatus = async () => BENIGN_GET_SHAPE;

  ok("the resume banner is offered", qsa(root, "input").some((el) => (el as unknown as { getAttribute: (n: string) => string | null }).getAttribute("data-dp") === "restore-flow.file.resume-banner"));

  const km = await (await import("../src/keygen.ts")).runKeyCeremony({ operational: false });
  const identityText = (await import("../src/keygen.ts")).identityFile(km.breakGlass);

  // The resume banner's OWN file input (data-dp="restore-flow.file.resume-banner"), not the setup form's
  // #attend-identity (both exist simultaneously; the banner is inserted above the fresh form). Supplying
  // it calls onResume(identity) directly, which drives resumeSession(sessionId) -- no separate button.
  const resumeInput = qs(root, '[data-dp="restore-flow.file.resume-banner"]');
  if (!resumeInput) throw new Error("resume banner file input not found");
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown): void => { unhandled = reason; };
  process.on("unhandledRejection", onUnhandled);
  try {
    (resumeInput as unknown as { files: unknown }).files = [new ShimFile(identityText, "identity.key")];
    resumeInput.dispatchEvent({ type: "change", target: resumeInput, currentTarget: resumeInput, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} });
    await flushAsync();
    await flushAsync();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  ok("no unhandled rejection from resuming (was: TypeError from record.runs on an undefined record)", unhandled === null);
  const bodyText = textOf(root);
  ok("an HONEST, ACTIONABLE 'could not resume' outcome renders", bodyText.includes("Could not resume"));

  (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.removeItem("downpipes.attend.session");
}

// =====================================================================================
// SECTION 5: client-attest.ts's OWN wire-boundary guards (layer 2), driven through the REAL
// createAttestSession/attestStatus functions and the REAL Transport class with a stubbed global fetch.
// Sections 3 and 4 above prove the SCREEN degrades honestly, but they stub `engine.createAttestSession` /
// `engine.attestStatus` wholesale, which bypasses client-attest.ts entirely -- so the two guard lines this
// row actually added there (`if (!isCreateAttestSessionResult(result)) throw ...` and
// `if (!isAttestSessionRecord(body.session)) throw ...`) were never executed by ANY existing test, which is
// exactly why adding them dropped the file's own covered fraction. This section exercises them directly, at
// the same wire boundary a real engine response arrives at, in both directions: a well-formed body passes
// through untouched, and the exact malformed body the deployed tour served throws the guard's own message.
// =====================================================================================
async function testClientAttestOwnWireBoundaryGuards(): Promise<void> {
  console.log("\n-- client-attest.ts: createAttestSession/attestStatus validate the SAME shape client-attest.ts\n" +
    "   itself now guards, through the REAL Transport with a stubbed fetch --");

  const t = new Transport("https://engine.example.com");
  const realFetch = globalThis.fetch;
  const respond = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  const VALID_CREATE: CreateAttestSessionResult = {
    sessionId: "sess-1",
    challenge: { ciphertextB64: "a", nonceB64: "b" },
    runs: [{ downpipeId: "dp1", runId: "r1", name: "n", recordCount: 1 }],
    sampleRate: 100,
    estimate: { runs: 1, records: 1 },
  };

  try {
    // (a) createAttestSession: a well-formed 200 passes straight through unchanged.
    globalThis.fetch = respond(VALID_CREATE);
    const created = await createAttestSession(t, {});
    ok("createAttestSession: a well-formed response passes through unchanged", created.sessionId === "sess-1" && created.runs.length === 1);

    // (b) createAttestSession: the EXACT benignWrite shape the deployed tour served (no `runs` field) is
    // rejected AT client-attest.ts, not only at the demo table or the screen.
    globalThis.fetch = respond(BENIGN_WRITE_SHAPE);
    let createThrew: unknown = null;
    try {
      await createAttestSession(t, {});
    } catch (err) {
      createThrew = err;
    }
    ok("createAttestSession: the benignWrite 200 throws AT THE WIRE BOUNDARY", createThrew instanceof Error);
    ok("createAttestSession: the thrown message names the guard's own reason", createThrew instanceof Error && createThrew.message.includes("did not include the pinned runs"));

    // (c) createAttestSession: sessionId present but empty -- the guard's OTHER clause (sessionId !== ""),
    // exercised at this boundary as well as the `runs` clause above.
    globalThis.fetch = respond({ ...VALID_CREATE, sessionId: "" });
    let emptyIdThrew: unknown = null;
    try {
      await createAttestSession(t, {});
    } catch (err) {
      emptyIdThrew = err;
    }
    ok("createAttestSession: an empty sessionId is rejected too", emptyIdThrew instanceof Error && emptyIdThrew.message.includes("did not include the pinned runs"));

    // (d) attestStatus: a well-formed session passes straight through unchanged.
    globalThis.fetch = respond({ session: { sessionId: "sess-1" } });
    const status = await attestStatus(t, "sess-1");
    ok("attestStatus: a well-formed session passes through unchanged", status.session.sessionId === "sess-1");

    // (e) attestStatus: the EXACT benignGet shape (no `session` field at all) is rejected AT client-attest.ts.
    globalThis.fetch = respond(BENIGN_GET_SHAPE);
    let statusThrew: unknown = null;
    try {
      await attestStatus(t, "sess-1");
    } catch (err) {
      statusThrew = err;
    }
    ok("attestStatus: a session-less 200 throws AT THE WIRE BOUNDARY", statusThrew instanceof Error);
    ok("attestStatus: the thrown message names the guard's own reason", statusThrew instanceof Error && statusThrew.message.includes("did not include the session"));

    // (f) attestStatus: `session` present but its sessionId is empty.
    globalThis.fetch = respond({ session: { sessionId: "" } });
    let emptySessionThrew: unknown = null;
    try {
      await attestStatus(t, "sess-1");
    } catch (err) {
      emptySessionThrew = err;
    }
    ok("attestStatus: an empty sessionId inside `session` is rejected too", emptySessionThrew instanceof Error && emptySessionThrew.message.includes("did not include the session"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// =====================================================================================
// SECTION 6: isCreateAttestSessionResult / isAttestSessionRecord -- every branch the predicate itself takes,
// not only the two shapes (benignWrite / a full real result) section 2 above already covers. Each is a real
// way a malformed engine response (or a demo/stub standing in for it) could arrive, and the guard must
// reject all of them, not merely the one shape that happened to crash first.
// =====================================================================================
function testPredicateBranchesDirectly(): void {
  console.log("\n-- isCreateAttestSessionResult / isAttestSessionRecord: every branch the predicate itself takes --");

  ok("isCreateAttestSessionResult(null) is false (not an object)", !isCreateAttestSessionResult(null));
  ok("isCreateAttestSessionResult(undefined) is false (not an object)", !isCreateAttestSessionResult(undefined));
  ok("isCreateAttestSessionResult(a bare string) is false (not an object)", !isCreateAttestSessionResult("session"));
  ok("isCreateAttestSessionResult({}) is false (no sessionId)", !isCreateAttestSessionResult({}));
  ok("isCreateAttestSessionResult(sessionId of the wrong type) is false", !isCreateAttestSessionResult({ sessionId: 42, runs: [] }));
  ok("isCreateAttestSessionResult(an empty sessionId) is false", !isCreateAttestSessionResult({ sessionId: "", runs: [] }));
  ok("isCreateAttestSessionResult(a valid sessionId, runs missing) is false", !isCreateAttestSessionResult({ sessionId: "s1" }));
  ok("isCreateAttestSessionResult(a valid sessionId, runs not an array) is false", !isCreateAttestSessionResult({ sessionId: "s1", runs: "not-an-array" }));
  ok("isCreateAttestSessionResult(the accepting shape) is true", isCreateAttestSessionResult({ sessionId: "s1", runs: [] }));

  ok("isAttestSessionRecord(null) is false (not an object)", !isAttestSessionRecord(null));
  ok("isAttestSessionRecord(undefined) is false (not an object)", !isAttestSessionRecord(undefined));
  ok("isAttestSessionRecord(a bare number) is false (not an object)", !isAttestSessionRecord(7));
  ok("isAttestSessionRecord({}) is false (no sessionId)", !isAttestSessionRecord({}));
  ok("isAttestSessionRecord(sessionId of the wrong type) is false", !isAttestSessionRecord({ sessionId: 42 }));
  ok("isAttestSessionRecord(an empty sessionId) is false", !isAttestSessionRecord({ sessionId: "" }));
  ok("isAttestSessionRecord(the accepting shape) is true", isAttestSessionRecord({ sessionId: "s1" }));
}

async function main(): Promise<void> {
  await testDemoRouteModelsAttestSession();
  testGuardsRejectTheBenignShape();
  await testStartDegradesHonestly();
  await testResumeDegradesHonestly();
  await testClientAttestOwnWireBoundaryGuards();
  testPredicateBranchesDirectly();

  console.log(failures === 0 ? "\nR-28 ATTEST-SESSION-DEGRADE VALIDATION PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-R28-ATTEST-SESSION-DEGRADE THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
