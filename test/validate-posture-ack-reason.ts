// A posture acknowledgement that the engine did not record says why, and blames version skew only when
// the refusal IS skew.
//
//   node test/validate-posture-ack-reason.ts
//
// acknowledgePosture (src/lib/api/client-keys.ts) used to fold every failure into { ok: false }, and the
// Keys screen (src/screens/keys/posture.ts ackBody) read that as console/engine version skew: "update them
// and try again". A 429, a 403 role refusal and a lost connection all got that sentence, and updating fixes
// none of them. The engine's route (engine src/admin/router-keys.ts, POST /keys/posture-acknowledgement)
// answers { error } on every refusal, and exactly two of its refusals are skew: an unknown or stale
// statement version, and posted words that differ from its canonical text.
//
// Part 1 drives the real client over a stubbed fetch. Part 2 renders the real Keys posture tab over a
// scripted engine and clicks Record.

import { installDomShim, qs, qsa, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
installDomShim();

const { acknowledgePosture } = await import("../src/lib/api/client-keys.ts");
const { Transport } = await import("../src/lib/api/client-transport.ts");
const { renderPostureTab } = await import("../src/screens/keys/posture.ts");
const store = await import("../src/lib/store.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const realFetch = globalThis.fetch;
const INPUT = { posture: "operational" as const, statementVersion: "key-posture-ack/v1", acknowledgedText: "x", channel: "keys-rekey" as const };

async function ackWith(respond: () => Response | Promise<Response>): Promise<Awaited<ReturnType<typeof acknowledgePosture>>> {
  globalThis.fetch = (async () => respond()) as typeof fetch;
  try {
    return await acknowledgePosture(new Transport("https://engine.test"), INPUT);
  } finally {
    globalThis.fetch = realFetch;
  }
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// screenSays renders the posture tab over an engine whose status() reports the operational key and whose
// acknowledgePosture answers `result`, ticks the box, clicks Record, and returns the section's text.
async function screenSays(result: unknown): Promise<string> {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true } as never);
  const engine = new Proxy(
    {
      status: async () => ({ operationalConfigured: { public: true, private: true }, signerConfigured: true, breakGlassPublicConfigured: true }),
      acknowledgePosture: async () => result,
    } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : () => new Promise(() => {})) },
  );
  const el = renderPostureTab(engine as never);
  markConnected(el as unknown as never);
  await flush();
  const box = qs(el, "#posture-ack-understood") as unknown as { checked: boolean; click(): void } | null;
  if (!box) return "(no acknowledgement box rendered)";
  box.click();
  const btn = (qsa(el, "button") as unknown as Array<{ textContent: string; disabled: boolean; click(): void }>).find((b) => b.textContent === "Record this acknowledgement");
  if (!btn) return "(no Record button rendered)";
  btn.disabled = false;
  btn.click();
  await flush();
  return textOf(el as unknown as never);
}

const SKEW = "If your console and engine are on different versions";

async function main(): Promise<void> {
  console.log("(1) the client keeps the engine's reason, and marks only the statement refusals as skew");
  {
    const limited = await ackWith(() => json(429, { error: "rate limited" }));
    ok("(1a) a 429 carries the engine's text and the status", limited.ok === false && limited.reason === "rate limited (HTTP 429)");
    ok("(1b) a 429 is not a statement refusal", limited.statementRefused === false);
    const denied = await ackWith(() => json(403, { error: "forbidden", required: "keys.ceremony" }));
    ok("(1c) a 403 carries the engine's text and is not a statement refusal", denied.reason === "forbidden (HTTP 403)" && denied.statementRefused === false);
    const stale = await ackWith(() => json(400, { error: "unknown or stale acceptance statement version; reload the page and try again" }));
    ok("(1d) an unknown statement version IS a statement refusal", stale.statementRefused === true);
    const drift = await ackWith(() => json(400, { error: "the acknowledged text does not match the current statement; reload the page and try again" }));
    ok("(1e) drifted statement words ARE a statement refusal", drift.statementRefused === true);
    const badPosture = await ackWith(() => json(400, { error: "posture must be 'operational' or 'break-glass-only'" }));
    ok("(1f) another 400 is not a statement refusal", badPosture.statementRefused === false && badPosture.reason?.startsWith("posture must be") === true);
    const offline = await ackWith(() => Promise.reject(new TypeError("Failed to fetch")));
    ok("(1g) a transport fault says the engine could not be reached", offline.ok === false && offline.reason === "the console could not reach the engine" && offline.statementRefused !== true);
    const bare = await ackWith(() => new Response("", { status: 502 }));
    ok("(1h) a refusal with no body names the status", bare.reason === "HTTP 502, with no reason given");
    const good = await ackWith(() => json(200, { ok: true, statementVersion: "key-posture-ack/v1", statementSha384: "sha384:abc" }));
    ok("(1i) a recorded acknowledgement is ok and keeps its hash", good.ok === true && good.statementSha384 === "sha384:abc" && good.reason === undefined);
  }

  console.log("\n(2) the Keys screen shows the reason, and the skew advice only for skew");
  {
    const limited = await screenSays({ ok: false, reason: "rate limited (HTTP 429)", statementRefused: false });
    ok("(2a) a rate limit shows the engine's reason", limited.includes("The engine did not record it: rate limited (HTTP 429)."));
    ok("(2b) a rate limit does not tell the operator to update", !limited.includes(SKEW));
    const offline = await screenSays({ ok: false, reason: "the console could not reach the engine" });
    ok("(2c) a lost connection says so, without the skew advice", offline.includes("could not reach the engine") && !offline.includes(SKEW));
    const skew = await screenSays({ ok: false, reason: "unknown or stale acceptance statement version (HTTP 400)", statementRefused: true });
    ok("(2d) a statement refusal keeps the version-skew advice", skew.includes(SKEW));
    const recorded = await screenSays({ ok: true, statementSha384: "sha384:abc" });
    ok("(2e) a recorded acknowledgement reads as recorded", recorded.includes("Recorded in your audit log"));
  }

  console.log(`\n${failures === 0 ? "POSTURE-ACK-REASON OK: an unrecorded acknowledgement names its cause, and blames skew only for a refused statement" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
