// Validate two console availability gaps that share the same defect shape: A ROW THAT ASSERTS SOMETHING THE
// CODE NEVER TESTED. Not a missing discriminator, not a field outside the coalescing key. A member whose
// MEANING is a claim about the world, written at a site that never established the claim.
//
//   the readiness poll's catch was the ONE swallowed engine read in the wizard that classified nothing at
//         all: it set a `lastTickThrew` boolean and threw the class away. So an engine ANSWERING 500 ON EVERY TICK
//         was filed as `readiness-unread` -- a member whose own definition says the engine was unreachable, and
//         which this product's support bot renders to a support engineer as "the engine was already unreachable
//         when the readiness card mounted ... Fix the engine's reachability first". An engine that is reachable
//         with forty refusals sitting in its own logs would send the pack's reader away from them. The
//         same collapse applies on the quiet leg: an engine that STARTS refusing mid-poll wrote `poll-went-quiet`,
//         which says in as many words that the engine "is not reachable now". And a 401 on every tick recorded
//         NOTHING.
//
//   a console redeployed WITHOUT the ENGINE service binding serves the SPA's own index.html at HTTP 200 for
//         /admin, /support and /metrics. The console then classifies its own shell as `html-not-engine`, whose
//         remedy is "correct the engine URL" -- on a URL that is correct. The engine, which received nothing at
//         all, reads perfectly healthy in the same pack, and a Prometheus scraper reading HTML at 200 reports the
//         customer's backups as fine. A CONFIGURATION fault in the console, wearing an engine outage's clothes.
//
// THE BAR IS THE DISCRIMINATION TEST: holding ONLY the pack, could a support engineer tell these states apart?
// Every case below drives the REAL loop or the REAL transport (never the recorder), and asserts that each state
// produces a row that DIFFERS FROM EVERY OTHER, including under the ring's coalescing tuple key.
//
// Run with `node test/validate-availability-r4-discrimination.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { packPayload, reset as resetRing, setActiveScreen } from "../src/lib/client-diag/ring.ts";
import { renderReadinessPoll } from "../src/screens/onboarding/steps.ts";
import { blockError, transportClassFor } from "../src/components/error-view.ts";
import { classifyError, ENGINE_BINDING_ABSENT } from "../src/lib/errors.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { isEngineSurface } from "../src/worker.ts";
import type { EngineClient } from "../src/lib/api/client.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import type { StatusReport } from "../src/lib/api/types/status.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, JSON.stringify(actual) === JSON.stringify(expected));
}
function section(title: string): void {
  console.log(`\n-- ${title} --`);
}

// The ring as the ENGINE would receive it: the payload the console actually POSTs, never the recorder's own head.
function rows(kind: string): ClientDiagnosticRecord[] {
  return (packPayload()?.records ?? []).filter((r) => r.kind === kind);
}
// The ring's OWN coalescing key, over every field these two gaps put on a row. Two states that produce the same
// tuple are not two rows: they are one row with a bumped count, which is a failure mode a large share of
// availability gaps share.
function tuple(r: ClientDiagnosticRecord): string {
  return `${r.kind}|${r.screen}|${r.obStep ?? ""}|${r.obOutcome ?? ""}|${r.obSecret ?? ""}|${r.transportClass ?? ""}`;
}
function resetAll(): void {
  resetRing();
  setActiveScreen("/onboarding");
}

// ---------------------------------------------------------------------------------------------------------
// THE POLL HARNESS: the LOOP is real (the same ticks, the same budget, the same catch leg, the same
// exhaustion branch); only the 3s delay is collapsed, so a two-minute wait runs in milliseconds.
// ---------------------------------------------------------------------------------------------------------
type TimeoutFn = typeof setTimeout;
const realSetTimeout: TimeoutFn = globalThis.setTimeout;
function collapseTimers(): void {
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, _ms?: number) => realSetTimeout(fn, 0)) as unknown as TimeoutFn;
}
function restoreTimers(): void {
  (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 600; i++) await new Promise<void>((r) => realSetTimeout(r, 0));
}

function status(signer: boolean, breakGlass: boolean): StatusReport {
  return { signerConfigured: signer, breakGlassConfigured: breakGlass, operationalConfigured: { public: false, private: false } } as unknown as StatusReport;
}

// The engine client the poll calls. A script entry is a status, or a THROW SHAPED LIKE THE REAL ONE: the engine
// client throws `Error("<verb>: <status>")` on a non-2xx (client-transport.ts failResponse) and a TypeError with
// no status when the fetch itself fails. Those two shapes are exactly what engineFaultOutcome discriminates on, so
// driving them here drives the real classifier and not a stand-in for it.
type Tick = StatusReport | "unreachable" | "refused-500" | "refused-403" | "unauthorised-401";
function throwFor(t: Exclude<Tick, StatusReport>): Error {
  if (t === "unreachable") return new TypeError("Failed to fetch"); // no status: the fetch never got a response
  if (t === "refused-500") return new Error("status: 500");
  if (t === "refused-403") return new Error("status: 403");
  return new Error("status: 401");
}
function engineThat(script: Tick[]): { engine: EngineClient; calls: () => number } {
  let n = 0;
  const engine = {
    status: async (): Promise<StatusReport> => {
      const step = script[Math.min(n, script.length - 1)]!;
      n++;
      if (typeof step === "string") throw throwFor(step);
      return step;
    },
  } as unknown as EngineClient;
  return { engine, calls: () => n };
}

// The whole point, held in one place: EVERY state's row, so the tuples can be compared across states rather than
// only within one. A row that is unique inside its own case and identical to another case's is exactly the bug.
const poll: Record<string, ClientDiagnosticRecord[]> = {};

// ==============================================================================================
section("an engine that ANSWERED AND REFUSED must not be filed as UNREACHABLE");
// ==============================================================================================
//
// The four failed-poll states are a 2x2 over two questions, and the second one was never asked:
//
//                     | final tick could not REACH the engine | final tick was the engine REFUSING
//   never once read   | readiness-unread                      | readiness-refused   <- was readiness-unread
//   read at least once| poll-went-quiet                       | poll-refused        <- was poll-went-quiet
//
// Both left-column members ASSERT unreachability, in their own definitions and in the bot's rendering of them.
// Writing them for an answering engine is not vagueness, it is a false claim, and it is the claim that sends a
// support engineer to the network when the evidence is in the logs.

collapseTimers();

// (C) the engine was DEAD before the card mounted: every tick a transport failure.
resetAll();
{
  const { engine, calls } = engineThat(["unreachable"]);
  renderReadinessPoll(engine);
  await settle();
  poll.C = rows("onboarding-step");
  ok("(C) unreachable throughout: the poll really ran to its bound (40 attempts)", calls() === 40);
  eq("(C) unreachable throughout: ONE row", poll.C.length, 1);
  ok("(C) unreachable throughout: readiness-unread, naming no secret", poll.C[0]?.obOutcome === "readiness-unread" && poll.C[0]?.obSecret === undefined);
}

// (H) THE STATE THAT PROVES THE DISTINCTION. The engine ANSWERED 500 on every single tick. It is up. Its logs
// hold forty refusals. The row must not be byte-identical to (C) and coalesce into it.
resetAll();
{
  const { engine, calls } = engineThat(["refused-500"]);
  renderReadinessPoll(engine);
  await settle();
  poll.H = rows("onboarding-step");
  ok("(H) answered 500 on EVERY tick: the poll ran to its bound", calls() === 40);
  eq("(H) answered 500 on EVERY tick: ONE row", poll.H.length, 1);
  ok("(H) answered 500 on EVERY tick: readiness-REFUSED -- the engine is reachable and it refused", poll.H[0]?.obOutcome === "readiness-refused");
  ok("(H) it names no secret: the poll never learned one, and a guess would be a fabrication", poll.H[0]?.obSecret === undefined);
}

// (H2) the same shape with a 403 on the AUTHENTICATED status read while the engine is plainly up: a health-ok
// status read failing during the poll, which must not read as "unreachable" either.
resetAll();
{
  const { engine } = engineThat(["refused-403"]);
  renderReadinessPoll(engine);
  await settle();
  poll.H2 = rows("onboarding-step");
  ok("(H2) 403 on every tick: readiness-refused, not unreachable", poll.H2[0]?.obOutcome === "readiness-refused");
}

// (Q) the engine ANSWERED and then WENT AWAY: three good reads, then transport failures.
resetAll();
{
  const { engine } = engineThat([status(false, false), status(false, false), status(false, false), "unreachable"]);
  renderReadinessPoll(engine);
  await settle();
  poll.Q = rows("onboarding-step");
  eq("(Q) answered then vanished: ONE row", poll.Q.length, 1);
  ok("(Q) answered then vanished: poll-went-quiet, naming no secret", poll.Q[0]?.obOutcome === "poll-went-quiet" && poll.Q[0]?.obSecret === undefined);
}

// (R) THE OTHER HALF OF THE DISTINCTION. The engine ANSWERED and then started REFUSING: three good reads, then
// 500s. It is UP, so it must not write poll-went-quiet, byte-identical to (Q), whose meaning is "not reachable now".
resetAll();
{
  const { engine } = engineThat([status(false, false), status(false, false), status(false, false), "refused-500"]);
  renderReadinessPoll(engine);
  await settle();
  poll.R = rows("onboarding-step");
  eq("(R) answered then started refusing: ONE row", poll.R.length, 1);
  ok("(R) answered then started refusing: poll-REFUSED -- the engine is up, and its logs hold the refusals", poll.R[0]?.obOutcome === "poll-refused");
  ok("(R) it names no secret: the last successful read is stale and is not evidence of now", poll.R[0]?.obSecret === undefined);
}

// (U) A 401 ON EVERY TICK MUST NOT LEAVE THE RING EMPTY. The session lapses during the two-minute wait, the
// wizard is torn down to the sign-in screen with the keys possibly installed, and an empty ring would make the
// pack of an operator thrown out mid-setup identical to the pack of one who wandered off.
resetAll();
{
  const { engine, calls } = engineThat(["unauthorised-401"]);
  renderReadinessPoll(engine);
  await settle();
  poll.U = rows("onboarding-step");
  eq("(U) 401 on the poll: a row EXISTS (a silent lapse would hide the operator's session ending)", poll.U.length, 1);
  ok("(U) 401 on the poll: {readiness-poll, unauthorised}", poll.U[0]?.obStep === "readiness-poll" && poll.U[0]?.obOutcome === "unauthorised");
  ok("(U) 401 on the poll: the loop STOPS at once (it routes to sign-in; it does not spin 40 times)", calls() === 1);
}

// (E) the engine ANSWERED, INCLUDING ON THE LAST TICK, and kept reporting both keys absent. The install never
// took, and this is the ONLY one of the six that may name a secret, because it is the only one that read one.
resetAll();
{
  const { engine } = engineThat([status(false, false)]);
  renderReadinessPoll(engine);
  await settle();
  poll.E = rows("onboarding-step");
  eq("(E) answered throughout, both keys absent: TWO rows, one per absent key", poll.E.length, 2);
  ok("(E) they name the signer and the break-glass", poll.E.some((r) => r.obSecret === "signer") && poll.E.some((r) => r.obSecret === "break-glass"));
}

// (K) the good ending. NOISE DISCIPLINE: a healthy wait writes exactly one row and it says ok.
resetAll();
{
  const { engine, calls } = engineThat([status(false, false), status(true, true)]);
  renderReadinessPoll(engine);
  await settle();
  poll.K = rows("onboarding-step");
  eq("(K) the keys landed: ONE row", poll.K.length, 1);
  ok("(K) the keys landed: readiness-poll ok, and the loop stops", poll.K[0]?.obOutcome === "ok" && calls() === 2);
}

restoreTimers();

// ---- THE DISCRIMINATION TEST ITSELF ----------------------------------------------------------
section("every one of the seven poll states produces a DIFFERENT row");
{
  const states = ["C", "H", "H2", "Q", "R", "U", "E", "K"] as const;
  // H and H2 are deliberately THE SAME STATE (an engine refusing, 500 or 403): one remedy, one row. Every other
  // pair must differ. The tuple is the ring's own coalescing key, so "differ" here means "does not coalesce".
  const distinct = new Map<string, string>();
  let collisions = 0;
  for (const s of states) {
    if (s === "H2") continue; // the same state as H by design
    for (const r of poll[s] ?? []) {
      const t = tuple(r);
      const prior = distinct.get(t);
      if (prior !== undefined && prior !== s) {
        console.log(`  FAIL ${s} and ${prior} produce the SAME row: ${t}`);
        collisions++;
      }
      distinct.set(t, s);
    }
  }
  ok("no two poll states coalesce on the ring's tuple key", collisions === 0);
  // The two pairs the gap turns on, asserted by name so a future regression names itself.
  ok(
    "unreachable-throughout (C) and answered-500-throughout (H) are NOT the same row -- the exact refutation",
    tuple(poll.C![0]!) !== tuple(poll.H![0]!),
  );
  ok(
    "went-quiet (Q) and started-refusing (R) are NOT the same row -- the same collapse on the quiet leg",
    tuple(poll.Q![0]!) !== tuple(poll.R![0]!),
  );
  ok("H and H2 (500 and 403) ARE one row: one state, one remedy, no invented precision", tuple(poll.H![0]!) === tuple(poll.H2![0]!));
}

// ---- NO ROW MAY ASSERT WHAT THE CODE NEVER TESTED ----------------------------------------------
section("no failed-poll row carries an obSecret it did not read");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  for (const s of ["C", "H", "H2", "Q", "R", "U"] as const) {
    ok(`(${s}) carries no obSecret`, (poll[s] ?? []).every((r) => r.obSecret === undefined));
  }
  ok("(E) is the ONLY failed-poll state that names a secret, because it is the only one that read one", (poll.E ?? []).every((r) => r.obSecret !== undefined));
}

// ==============================================================================================
section("a missing ENGINE binding is a CONSOLE config fault, not an engine outage");
// ==============================================================================================
//
// Without the worker's own guard, /admin, /support and /metrics would fall through to the assets fetcher, which
// serves index.html at 200. Three observers, three false readings.

// The worker's route predicate is unchanged: these are the surfaces it forwards, and therefore the surfaces it
// must refuse honestly when it cannot.
ok("the engine surfaces are /admin, /support and GET /metrics", isEngineSurface("/admin/status", "GET") && isEngineSurface("/support/x", "GET") && isEngineSurface("/metrics", "GET"));
ok("a POST to /metrics is NOT an engine surface (unchanged)", !isEngineSurface("/metrics", "POST"));
ok("an SPA route is NOT an engine surface (it must still get the shell)", !isEngineSurface("/downpipes", "GET") && !isEngineSurface("/keys", "GET"));

// The transport's admission of the worker's 503. A SHAPE GATE: status 503 AND a JSON object AND `error` EQUAL to
// the frozen token. Anything else falls through to the ordinary status throw, so no other server's body can decide
// how this console classifies its own transport.
{
  const t = new Transport("https://engine.example", undefined);
  const res = (status: number, body: string): Response => new Response(body, { status, headers: { "content-type": "application/json" } });

  const thrown = async (r: Response): Promise<string> => {
    try {
      await t.parseJson(r, "status");
      return "<no throw>";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const real = await thrown(res(503, JSON.stringify({ error: ENGINE_BINDING_ABSENT })));
  ok("the console worker's 503 is admitted and folds the frozen token into the throw", real.includes(ENGINE_BINDING_ABSENT));
  eq("and it classifies as its own kind", classifyError(new Error(real)).kind, "engine-binding-absent");

  // The negative controls. Each of these is a body the console must NOT read as its own worker's refusal.
  const wrongStatus = await thrown(res(500, JSON.stringify({ error: ENGINE_BINDING_ABSENT })));
  ok("a 500 carrying the same word is NOT admitted (the status is part of the gate)", !wrongStatus.includes(ENGINE_BINDING_ABSENT));
  const wrongField = await thrown(res(503, JSON.stringify({ message: ENGINE_BINDING_ABSENT })));
  ok("a 503 with the token in the WRONG FIELD is not admitted", !wrongField.includes(ENGINE_BINDING_ABSENT));
  const substring = await thrown(res(503, JSON.stringify({ error: `the engine-binding-absent thing happened at s3://bucket/key` })));
  ok("a 503 whose error merely CONTAINS the token is not admitted (equality, not a substring search)", !substring.includes(ENGINE_BINDING_ABSENT));
  const notJson = await thrown(res(503, "<html>service unavailable</html>"));
  ok("a 503 of HTML is not admitted", !notJson.includes(ENGINE_BINDING_ABSENT));
  // AND THE LEAK CHECK: none of the refused bodies put a byte of themselves in the throw.
  ok("no refused body's content rides in the throw (no bucket, no key, no prose)", !substring.includes("s3://") && !substring.includes("bucket"));
}

// The row itself, and the state it must NOT be confused with. blockError is the seam every screen renders a
// channel-two error through, and the seam that records the transport row.
{
  const kind = classifyError(new Error("status: engine-binding-absent"));
  eq("transportClassFor maps it to its own class", transportClassFor(kind), "engine-binding-absent");
  eq("a generic web page is still html-not-engine", transportClassFor(classifyError(new Error("status: html-body-not-json"))), "html-not-engine");
}

section("the binding-absent row and the wrong-URL row are DIFFERENT rows");
{
  resetAll();
  blockError(new Error("status: engine-binding-absent"), () => {});
  const bindingRows = rows("transport-fault");
  eq("the missing binding records ONE transport-fault row", bindingRows.length, 1);
  eq("and it is engine-binding-absent", bindingRows[0]?.transportClass, "engine-binding-absent");

  resetAll();
  blockError(new Error("status: html-body-not-json"), () => {});
  const htmlRows = rows("transport-fault");
  eq("a wrong engine URL records ONE transport-fault row", htmlRows.length, 1);
  eq("and it is html-not-engine", htmlRows[0]?.transportClass, "html-not-engine");

  ok(
    "THE TWO ARE DIFFERENT ROWS -- 'your console lost its engine binding' and 'your engine URL is wrong' have opposite remedies and must never coalesce into one row",
    tuple(bindingRows[0]!) !== tuple(htmlRows[0]!),
  );

  // And a genuine engine 5xx: the engine ANSWERED. Not this class, and not the same row.
  resetAll();
  blockError(new Error("status: 500"), () => {});
  const serverRows = rows("transport-fault");
  eq("a genuine engine 5xx is still server-error", serverRows[0]?.transportClass, "server-error");
  ok("and it is a different row again", tuple(serverRows[0]!) !== tuple(bindingRows[0]!));
}

section("nothing about the request rides in the row");
{
  resetAll();
  // The path, the query and a customer value that could only come from a URL. None has a field to occupy.
  blockError(new Error("GET /admin/downpipes/dp_customer_secret?token=abc: engine-binding-absent"), () => {});
  const payload = JSON.stringify(packPayload());
  ok("no path, no query, no token, no customer id in the pack payload", !payload.includes("dp_customer") && !payload.includes("token=abc") && !payload.includes("/admin/"));
  ok("only the closed class rides", payload.includes("engine-binding-absent"));
}

console.log(failures === 0 ? "\nALL PASS (availability discrimination)" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
