// Every admin call in the API client reaches the engine through engineFetch, so a failed call leaves an
// attempt count and a closed-class engine-call row in the console-diagnostics ring.
//
// Ten calls used a raw fetch: the five attended-verification session calls after create (prove, capsules,
// verify, status, abort), the key-posture acknowledgement, and four retention-prune calls (candidate,
// request, reject, approvals). A 5xx or a lost connection on any of them wrote nothing to the ring, so a
// pack generated after "attended verification keeps failing" or "the prune request did nothing" showed a
// healthy console with no engine calls attempted.
//
// Each case drives the REAL client function through a real EngineClient against a stubbed global fetch,
// once with a 503 answer and once with a rejected fetch, and reads the ring the pack would carry.
//
// Run with `node test/validate-engine-fetch-seam-complete.ts`.

import { EngineClient } from "../src/api.ts";
import { reset, snapshot } from "../src/lib/client-diag/ring.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

type Call = (c: EngineClient) => Promise<unknown>;

const CALLS: Array<[string, Call]> = [
  ["proveAttestSession", (c) => c.proveAttestSession({ sessionId: "s1", proofB64: "AA" })],
  ["attestCapsules", (c) => c.attestCapsules({ sessionId: "s1", runIds: ["r1"] })],
  ["attestVerify", (c) => c.attestVerify({ sessionId: "s1", batch: [{ runId: "r1", masterB64: "AA" }] })],
  ["attestStatus", (c) => c.attestStatus("s1")],
  ["abortAttestSession", (c) => c.abortAttestSession("s1")],
  [
    "acknowledgePosture",
    (c) => c.acknowledgePosture({ posture: "operational", statementVersion: "v1", acknowledgedText: "t", channel: "onboarding" }),
  ],
  ["retentionPruneCandidate", (c) => c.retentionPruneCandidate("dp1")],
  ["retentionPruneRequest", (c) => c.retentionPruneRequest({ downpipeId: "dp1", reason: "r" })],
  ["retentionPruneReject", (c) => c.retentionPruneReject("ph1", "other")],
  ["retentionPruneApprovals", (c) => c.retentionPruneApprovals()],
];

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  let mode: "503" | "reject" = "503";
  let fetches = 0;
  (globalThis as { fetch: unknown }).fetch = (async () => {
    fetches++;
    if (mode === "reject") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new EngineClient("https://engine.example.com", "tok123");
    for (const m of ["503", "reject"] as const) {
      mode = m;
      console.log(`a ${m === "503" ? "503 answer" : "rejected fetch"} on each call`);
      for (const [name, call] of CALLS) {
        reset();
        fetches = 0;
        try {
          await call(client);
        } catch {
          // The call's own failure handling is not under test here; the ring is.
        }
        const snap = snapshot();
        const engineRows = snap.records.filter((r) => r.kind === "engine-call");
        const wantClass = m === "503" ? "5xx" : "network";
        ok(`${name}: the fetch ran once`, fetches === 1);
        ok(`${name}: the attempt is counted (engineAttempts=1)`, snap.engineAttempts === 1);
        ok(`${name}: one engine-call row with httpClass ${wantClass}`, engineRows.length === 1 && engineRows[0]?.httpClass === wantClass);
      }
    }

    // Negative control: a call that already went through the seam (createAttestSession uses gatedFetch)
    // records the attempt. If the ring reset or the stub were broken, this would fail too.
    reset();
    mode = "503";
    try {
      await client.retentionPruneApprove("ph1");
    } catch {
      // expected refusal
    }
    ok("control: a call already on the seam counts its attempt", snapshot().engineAttempts === 1);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-engine-fetch-seam-complete (${failures} failure(s))`);
  verdictReached(failures);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
