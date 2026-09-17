// Validate the console's availability-fault discrimination: the engine's own faults must not be mistaken for
// transport or binding faults, and vice versa.
//
// THE DEFECT THIS FILE GUARDS AGAINST IS NOT A MISSING DISCRIMINATOR: it is a member whose NAME asserts a fact,
// at a site that never established that fact. The classifier must be total, and covering the obvious cases is
// not enough:
//
//   engineFaultOutcome's own header calls it "the TOTAL, PURE classifier for ANY failed engine call in the
//   wizard", and a classifier that decides on `errorStatus(err) !== null` -- a TRAILING NUMERIC status -- is not
//   total. The real transport throws MARKER strings, with no number, for two states:
//
//     "status: access-redirect"        Cloudflare Access served its login page: the operator's session lapsed
//     "status: engine-binding-absent"  the console worker has no ENGINE binding: the call never left the console
//
//   Both would otherwise fall out of the null side into `transport-error`, and from the poll into
//   `readiness-unread` and `poll-went-quiet` -- three members whose meaning, and whose rendering in the support
//   bot ("Fix the engine's reachability first"), ASSERT THAT THE ENGINE DID NOT ANSWER. IN BOTH STATES THE
//   ENGINE IS UP AND HEALTHY. The console must not throw that fact away: failResponse recognises the Access
//   page and throws a dedicated marker, classifyError names the kind, and the console's own FAULT_BY_ERROR_KIND
//   maps it to the faultClass `auth`.
//
// AND THE SEAM: noteEngineResponse must not classify on the numeric status alone, or the console worker's OWN
// 503 gets recorded as {engine-call, 5xx, server} -- a fabricated ENGINE fault, for a request the engine never
// received, feeding the bot's console-engine-calls-failing ratio and pointing the reader at engine logs that
// hold no trace.
//
// TEST DISCIPLINE: hand-writing thrown errors as `new Error("status: 500")` proves nothing here. Not one error
// below is hand-written. Every one is generated through the REAL throw path -- Transport.failResponse over a
// real Response -- and the binding-absent Response is produced by THE REAL CONSOLE WORKER (src/worker.ts
// default.fetch, env.ENGINE undefined), so the marker throws are the ones the product actually produces rather
// than a convenient fiction that takes a different branch.
//
// Run with `node test/validate-availability-r5-discrimination.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { packPayload, reset as resetRing, setActiveScreen } from "../src/lib/client-diag/ring.ts";
import { engineFaultOutcome, renderReadinessPoll } from "../src/screens/onboarding/steps.ts";
import { classifyError } from "../src/lib/errors.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { engineFetch } from "../src/lib/api/engine-fetch.ts";
import consoleWorker from "../src/worker.ts";
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

function rows(kind: string): ClientDiagnosticRecord[] {
  return (packPayload()?.records ?? []).filter((r) => r.kind === kind);
}
// The ring's OWN coalescing key. Two states that produce the same tuple are not two rows: they are one row with a
// bumped count, and a support engineer holding the pack cannot tell them apart.
function tuple(r: ClientDiagnosticRecord): string {
  return `${r.kind}|${r.screen}|${r.obStep ?? ""}|${r.obOutcome ?? ""}|${r.obSecret ?? ""}|${r.transportClass ?? ""}|${r.httpClass ?? ""}|${r.faultClass ?? ""}|${r.adminOp ?? ""}|${r.writeOutcome ?? ""}`;
}
function resetAll(): void {
  resetRing();
  setActiveScreen("/onboarding");
}

// ---------------------------------------------------------------------------------------------------------
// THE REAL THROW PATH. Nothing below constructs an Error by hand.
// ---------------------------------------------------------------------------------------------------------
const transport = new Transport("https://console.example");

// realThrow drives the ONE non-2xx throw site the console has (Transport.failResponse) over a real Response, and
// hands back what it threw. This is the error the product produces, marker strings and all.
async function realThrow(r: Response): Promise<unknown> {
  try {
    await transport.failResponse(r, "engine status");
    throw new Error("failResponse did not throw");
  } catch (e) {
    return e;
  }
}

// bindingAbsentResponse is not a fixture: it is THE REAL CONSOLE WORKER answering an engine-surface path with no
// ENGINE service binding bound. Its status, its body and its header are whatever src/worker.ts actually sends.
async function bindingAbsentResponse(path: string, method = "GET"): Promise<Response> {
  const env = {
    ASSETS: { fetch: async (): Promise<Response> => new Response("<!doctype html><html><body>console</body></html>", { status: 200, headers: { "content-type": "text/html" } }) },
  };
  const fetchFn = (consoleWorker as unknown as { fetch: (req: Request, env: unknown) => Promise<Response> }).fetch;
  return fetchFn(new Request(`https://console.example${path}`, { method }), env);
}

// The Access login page. Cloudflare Access intercepts an AUTHENTICATED call whose session has lapsed and answers
// with its own HTML, not with clean 401 JSON, which is the whole footgun: the body decides the classification, and
// the status can be anything. Driven at 403 deliberately -- the harshest case, because a fix that only looked at
// the status would land this on `engine-not-ok` ("the engine answered and refused") instead.
const ACCESS_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body><div id="cf-access">Cloudflare Access</div></body></html>';

section("the REAL transport's five throws, and the kinds the console already knew");
const thrownServer = await realThrow(new Response("upstream failure", { status: 500 }));
const thrownForbidden = await realThrow(new Response(JSON.stringify({ error: "role denied" }), { status: 403 }));
const thrown401 = await realThrow(new Response(JSON.stringify({ error: "unauthorised" }), { status: 401 }));
const thrownAccess403 = await realThrow(new Response(ACCESS_PAGE, { status: 403, headers: { "content-type": "text/html" } }));
const thrownAccess401 = await realThrow(new Response(ACCESS_PAGE, { status: 401, headers: { "content-type": "text/html" } }));
const thrownBinding = await realThrow(await bindingAbsentResponse("/admin/status"));
// A wrong engine URL answers 200 with a web page, so this throw comes from the OTHER real site: parseJson, whose
// body will not parse. Driving it through failResponse would have been the convenient fiction (a non-2xx HTML body
// keeps its status and is an ANSWER), and it is the fiction this test exists to refuse.
const thrownHtml = await (async (): Promise<unknown> => {
  try {
    await transport.parseJson(new Response("<!doctype html><html><body>some website</body></html>", { status: 200, headers: { "content-type": "text/html" } }), "engine status");
    throw new Error("parseJson did not throw");
  } catch (e) {
    return e;
  }
})();
// The fetch itself failing has no Response at all, so it never reaches failResponse: it is the rejection the
// browser hands the transport, and it is the ONE error here that is not built from a Response.
const thrownNetwork = Object.assign(new TypeError("Failed to fetch"), { name: "TypeError" });
const thrownAbort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

eq("a 500 through the real path is kind `server`", classifyError(thrownServer).kind, "server");
eq("a 403 through the real path is kind `forbidden`", classifyError(thrownForbidden).kind, "forbidden");
eq("a 401 through the real path is kind `unauthorised`", classifyError(thrown401).kind, "unauthorised");
eq("THE ACCESS LOGIN PAGE is kind `access-redirect`, and carries NO trailing status", classifyError(thrownAccess403).kind, "access-redirect");
eq("THE REAL WORKER'S 503 with no ENGINE binding is kind `engine-binding-absent`", classifyError(thrownBinding).kind, "engine-binding-absent");
ok("neither marker throw carries a trailing numeric status (this is why the old classifier missed them)", /access-redirect$/.test(String((thrownAccess403 as Error).message)) && /engine-binding-absent$/.test(String((thrownBinding as Error).message)));

section("engineFaultOutcome is TOTAL, and no member asserts a fact the code did not establish");
eq("an engine that ANSWERED 500 is engine-not-ok, never transport", engineFaultOutcome(thrownServer), "engine-not-ok");
eq("an engine that ANSWERED 403 is engine-not-ok", engineFaultOutcome(thrownForbidden), "engine-not-ok");
eq("a clean 401 is the lapsed session", engineFaultOutcome(thrown401), "unauthorised");
eq("THE ACCESS LOGIN PAGE IS THE SAME LAPSED SESSION, not an unreachable engine (403-shaped)", engineFaultOutcome(thrownAccess403), "unauthorised");
eq("and 401-shaped", engineFaultOutcome(thrownAccess401), "unauthorised");
eq("THE CONSOLE'S OWN MISSING BINDING IS ITS OWN OUTCOME, not an unreachable engine", engineFaultOutcome(thrownBinding), "engine-binding-absent");
eq("a fetch that threw is transport-error", engineFaultOutcome(thrownNetwork), "transport-error");
eq("a web page where engine JSON was expected is transport-error (the engine never saw it)", engineFaultOutcome(thrownHtml), "transport-error");
eq("NOISE: a navigation or an unmount cancelling the call is NOT a fault, and is not recorded", engineFaultOutcome(thrownAbort), null);

// ---------------------------------------------------------------------------------------------------------
// THE POLL, DRIVEN. The loop is real (same ticks, same 40-tick budget, same catch, same exhaustion branch); only
// the 3s delay is collapsed. Every thrown value in the scripts is one of the REAL throws produced above.
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
type Tick = StatusReport | unknown;
function engineThat(script: Tick[]): EngineClient {
  let n = 0;
  return {
    status: async (): Promise<StatusReport> => {
      const step = script[Math.min(n, script.length - 1)];
      n++;
      if (step instanceof Error) throw step;
      return step as StatusReport;
    },
  } as unknown as EngineClient;
}

const poll: Record<string, ClientDiagnosticRecord[]> = {};
async function drive(name: string, script: Tick[]): Promise<void> {
  resetAll();
  renderReadinessPoll(engineThat(script));
  await settle();
  poll[name] = rows("onboarding-step");
}

collapseTimers();

section("the poll's states, each driven through the real loop over the real throws");

const KEYS_ABSENT = status(false, false);

// The three states that COLLAPSED into readiness-unread, whose meaning is "the engine was not answering at all".
await drive("C-unreachable-every-tick", [thrownNetwork]);
await drive("A-access-page-every-tick", [thrownAccess403]);
await drive("B-no-engine-binding-every-tick", [thrownBinding]);
// The two that collapsed into poll-went-quiet, whose meaning is "the engine is not reachable now".
await drive("Q-answered-then-vanished", [KEYS_ABSENT, thrownNetwork]);
await drive("A2-answered-then-access-page", [KEYS_ABSENT, thrownAccess403]);
await drive("B2-answered-then-binding-dropped", [KEYS_ABSENT, thrownBinding]);
// The engine ANSWERING AND REFUSING, on both legs.
await drive("H-refused-500-every-tick", [thrownServer]);
await drive("H2-refused-403-every-tick", [thrownForbidden]);
await drive("R-answered-then-refusing", [KEYS_ABSENT, thrownServer]);
// The lapsed session as a clean 401, and the engine answering with a key absent, and the poll succeeding.
await drive("U-401-every-tick", [thrown401]);
await drive("E-keys-absent-throughout", [KEYS_ABSENT]);
await drive("K-keys-landed", [status(true, true)]);

restoreTimers();

eq("(C) unreachable every tick -> readiness-unread", poll["C-unreachable-every-tick"]?.[0]?.obOutcome, "readiness-unread");
eq("(A) THE ACCESS LOGIN PAGE every tick -> unauthorised, not readiness-unread (which the bot reads out as 'fix the engine's reachability first'), though THE ENGINE IS UP", poll["A-access-page-every-tick"]?.[0]?.obOutcome, "unauthorised");
eq("(B) NO ENGINE BINDING every tick -> engine-binding-absent, not readiness-unread, though THE ENGINE IS UP and received nothing", poll["B-no-engine-binding-every-tick"]?.[0]?.obOutcome, "engine-binding-absent");
eq("(Q) answered then vanished -> poll-went-quiet", poll["Q-answered-then-vanished"]?.[0]?.obOutcome, "poll-went-quiet");
eq("(A2) answered then the ACCESS LOGIN PAGE -> unauthorised, not poll-went-quiet ('the engine is not reachable now')", poll["A2-answered-then-access-page"]?.[0]?.obOutcome, "unauthorised");
eq("(B2) answered then the BINDING DROPPED (a console redeploy) -> engine-binding-absent, not poll-went-quiet", poll["B2-answered-then-binding-dropped"]?.[0]?.obOutcome, "engine-binding-absent");
eq("(H) answered 500 every tick -> readiness-refused", poll["H-refused-500-every-tick"]?.[0]?.obOutcome, "readiness-refused");
eq("(H2) answered 403 every tick -> readiness-refused (a declared collapse: the engine is up and its logs hold both)", poll["H2-refused-403-every-tick"]?.[0]?.obOutcome, "readiness-refused");
eq("(R) answered then refusing -> poll-refused", poll["R-answered-then-refusing"]?.[0]?.obOutcome, "poll-refused");
eq("(U) 401 every tick -> unauthorised", poll["U-401-every-tick"]?.[0]?.obOutcome, "unauthorised");
eq("(E) the engine ANSWERED and kept saying the keys are absent -> poll-exhausted, one row per absent key", poll["E-keys-absent-throughout"]?.map((r) => `${r.obOutcome}:${r.obSecret}`), ["poll-exhausted:signer", "poll-exhausted:break-glass"]);
eq("(K) the keys landed -> ok", poll["K-keys-landed"]?.[0]?.obOutcome, "ok");

section("THE DISCRIMINATION BAR -- every state that is a different remedy is a different row");
{
  // A and U are ONE state (a lapsed session) told in two body shapes, and they collapse on purpose: same fact, same
  // remedy, and the shape of the body Access chose to send is not something a support engineer can act on. Every
  // other pair below is a different remedy and must be a different row.
  const distinct = ["C-unreachable-every-tick", "A-access-page-every-tick", "B-no-engine-binding-every-tick", "Q-answered-then-vanished", "H-refused-500-every-tick", "R-answered-then-refusing", "E-keys-absent-throughout", "K-keys-landed"];
  const seen = new Map<string, string>();
  for (const name of distinct) {
    const t = (poll[name] ?? []).map(tuple).join(" + ");
    const clash = seen.get(t);
    ok(`${name} is its own row${clash ? ` (COLLIDES WITH ${clash})` : ""}`, clash === undefined);
    seen.set(t, name);
  }
  ok(
    "(C) unreachable and (A) the Access login page are NO LONGER THE SAME ROW -- one is an engine to revive, the other is a sign-in",
    tuple(poll["C-unreachable-every-tick"]![0]!) !== tuple(poll["A-access-page-every-tick"]![0]!),
  );
  ok(
    "(C) unreachable and (B) no engine binding are NO LONGER THE SAME ROW -- one is an engine to revive, the other is a CONSOLE to redeploy",
    tuple(poll["C-unreachable-every-tick"]![0]!) !== tuple(poll["B-no-engine-binding-every-tick"]![0]!),
  );
  ok(
    "(Q) went quiet and (A2) the Access login page are NO LONGER THE SAME ROW",
    tuple(poll["Q-answered-then-vanished"]![0]!) !== tuple(poll["A2-answered-then-access-page"]![0]!),
  );
  ok(
    "(A) and (A2) are the SAME row, and that is the declared collapse: one lapsed session, one remedy",
    tuple(poll["A-access-page-every-tick"]![0]!) === tuple(poll["A2-answered-then-access-page"]![0]!),
  );
  ok(
    "(B) and (B2) are the SAME row, and that is declared too: the binding is absent either way, and the console is redeployed either way",
    tuple(poll["B-no-engine-binding-every-tick"]![0]!) === tuple(poll["B2-answered-then-binding-dropped"]![0]!),
  );
}

// ---------------------------------------------------------------------------------------------------------
// THE SEAM. The console's own 503 must not be counted as an engine fault.
// ---------------------------------------------------------------------------------------------------------
section("the console worker's OWN 503 is not an engine 5xx");
const realFetch = globalThis.fetch;
function fetchReturning(make: () => Promise<Response>): void {
  (globalThis as { fetch: unknown }).fetch = (async () => make()) as unknown as typeof fetch;
}

{
  resetAll();
  fetchReturning(() => bindingAbsentResponse("/admin/downpipes", "POST"));
  await engineFetch("https://console.example/admin/downpipes", { method: "POST" }, { adminOp: "source-attach" });
  const calls = rows("engine-call");
  const writes = rows("admin-write");
  eq("ONE engine-call row", calls.length, 1);
  eq("its httpClass is NOT 5xx: the engine sent no status, because the engine never saw the request", calls[0]?.httpClass, "network");
  eq("its faultClass is `transport`, NOT `server`: a `server` row points the reader at engine logs that hold no trace of it", calls[0]?.faultClass, "transport");
  eq("the privileged write is `unreachable` (the engine never saw it), NOT `server-error` (which says it did)", writes[0]?.writeOutcome, "unreachable");
  eq("and the write's op is preserved", writes[0]?.adminOp, "source-attach");
}
{
  // THE NOISE CONTROL, and it is the pair that matters: a GENUINE engine 5xx must still be recorded as one. The
  // gate is an equality test on a header this console's own worker sets; an engine's 503 does not carry it.
  resetAll();
  fetchReturning(async () => new Response(JSON.stringify({ error: "engine is restarting" }), { status: 503 }));
  await engineFetch("https://console.example/admin/downpipes", { method: "POST" }, { adminOp: "source-attach" });
  const calls = rows("engine-call");
  eq("a GENUINE engine 503 is still an engine fault: 5xx", calls[0]?.httpClass, "5xx");
  eq("and still `server`: the engine SAW this one, and its logs hold it", calls[0]?.faultClass, "server");
  eq("and the write is still server-error", rows("admin-write")[0]?.writeOutcome, "server-error");
}
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // A hostile or merely wrong server cannot claim the console's own class: the header is only readable at all
  // because this 503 is same-origin (a cross-origin engine's headers are hidden from the browser unless exposed),
  // and even so the gate is an equality test against a frozen product token on a 503 and nothing else.
  resetAll();
  fetchReturning(async () => new Response(JSON.stringify({ error: "engine-binding-absent" }), { status: 500, headers: { "x-downpipes-engine-binding": "engine-binding-absent" } }));
  await engineFetch("https://console.example/admin/downpipes", {}, {});
  eq("the header on a 500 (not a 503) does not admit: the status gate holds", rows("engine-call")[0]?.httpClass, "5xx");
  resetAll();
  fetchReturning(async () => new Response(JSON.stringify({ error: "engine-binding-absent" }), { status: 503, headers: { "x-downpipes-engine-binding": "engine-binding-absent-ish" } }));
  await engineFetch("https://console.example/admin/downpipes", {}, {});
  eq("a near-miss header value does not admit: the gate is EQUALITY, not a substring", rows("engine-call")[0]?.httpClass, "5xx");
}
{
  // The two seams must AGREE. If the recording seam called it an engine fault and the throw called it a binding
  // fault, the pack would carry the fabricated engine 5xx in one row and the truth in the other.
  resetAll();
  fetchReturning(() => bindingAbsentResponse("/admin/status"));
  const r = await engineFetch("https://console.example/admin/status", {}, {});
  const err = await realThrow(r);
  eq("the throw path and the recording seam reach the same conclusion", classifyError(err).kind, "engine-binding-absent");
  eq("and the seam recorded transport, not server", rows("engine-call")[0]?.faultClass, "transport");
}
(globalThis as { fetch: unknown }).fetch = realFetch;

section("REDACTION: only closed enums, counts and clamped ints ride");
{
  resetAll();
  fetchReturning(() => bindingAbsentResponse("/admin/downpipes/dp_customer_secret?token=abc123", "POST"));
  await engineFetch("https://console.example/admin/downpipes/dp_customer_secret?token=abc123", { method: "POST" }, { adminOp: "source-attach" });
  (globalThis as { fetch: unknown }).fetch = realFetch;
  const payload = JSON.stringify(packPayload());
  ok("no path, no query, no token, no customer id", !payload.includes("dp_customer") && !payload.includes("token=abc123") && !payload.includes("/admin/"));
  ok("no body text and no error prose", !payload.includes("engine is restarting") && !payload.includes("Cloudflare Access") && !payload.includes("doctype"));
}
{
  // The wizard's own rows, over the ACCESS PAGE and the WORKER'S 503: neither the HTML nor the worker's body may
  // leave a byte behind. The throw carries a frozen product token and nothing of the body, by construction.
  resetAll();
  collapseTimers();
  renderReadinessPoll(engineThat([thrownAccess403]));
  await settle();
  renderReadinessPoll(engineThat([thrownBinding]));
  await settle();
  restoreTimers();
  const payload = JSON.stringify(packPayload());
  ok("no Access page markup, no worker body, no engine prose in the onboarding rows", !payload.includes("Cloudflare Access") && !payload.includes("cf-access") && !payload.includes("doctype") && !payload.includes("Sign in"));
}

console.log(failures === 0 ? "\nALL PASS (availability-fault discrimination)" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
