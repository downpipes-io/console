// Drives the real client-retention-prune.ts functions via a real EngineClient against a fetch-stubbed
// transport, the same pattern test/validate-api-client.ts uses: no network, no DOM, the production
// request/response code runs exactly as it does from the panel.
//
// Covers: candidate's POST shape and its two response classes (ok / a plain engine refusal); apply's
// previewOnly forwarding, the special "not-approved" 403 that carries a REAL PruneApplyResult body
// (must be handed back as data, not thrown as a generic failure) alongside an ORDINARY capability-refusal
// 403 (which must still throw); request/approve/reject's exact path, method and body; and approvals'
// GET + malformed-shape rejection.
//
// Run with `node test/validate-retention-prune-client.ts`.

import { EngineClient } from "../src/api.ts";
import type { PruneApplyResult, PruneApproval, PruneCandidateResult } from "../src/lib/api/types.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(`${label} (=${JSON.stringify(expected)})`, actual === expected);
}
function eqDeep(actual: unknown, expected: unknown, label: string): void {
  ok(`${label} (=${JSON.stringify(expected)})`, JSON.stringify(actual) === JSON.stringify(expected));
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

async function main(): Promise<void> {
  const calls: RecordedCall[] = [];
  const last = (): RecordedCall => {
    const c = calls[calls.length - 1];
    if (!c) throw new Error("no recorded fetch call");
    return c;
  };
  let nextResponse: () => Response = () => new Response("{}", { status: 200 });
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string },
  ) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? init.body : null,
    });
    return nextResponse();
  }) as typeof fetch;

  try {
    const client = new EngineClient("https://engine.example.com", "tok123");

    console.log("retentionPruneCandidate: POST shape, ok response, and a plain engine refusal");
    {
      const candidateResult: PruneCandidateResult = {
        downpipeId: "dp1",
        policy: { keepRuns: 5, enforce: true },
        retainedRunIds: ["run-a"],
        supersededRunIds: ["run-b", "run-c"],
        capsules: [{ runId: "run-b", masterCapsule: [], keyCommitment: "km1", recordCount: 3 }],
      };
      nextResponse = () => new Response(JSON.stringify(candidateResult), { status: 200 });
      const got = await client.retentionPruneCandidate("dp1");
      eq(last().url, "https://engine.example.com/admin/retention-prune/candidate", "candidate hits POST /admin/retention-prune/candidate");
      eq(last().method, "POST", "candidate is a POST");
      eq(last().body, JSON.stringify({ downpipeId: "dp1" }), "candidate's body carries only the downpipe id");
      eq(JSON.stringify(got), JSON.stringify(candidateResult), "candidate's result passes through verbatim");

      nextResponse = () => new Response(JSON.stringify({ error: "no retention policy on this downpipe" }), { status: 400 });
      let threw = "";
      try {
        await client.retentionPruneCandidate("dp-no-policy");
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      ok("candidate: an engine refusal throws, carrying the engine's reason", /no retention policy/.test(threw));
    }

    console.log("retentionPruneApply: previewOnly forwarding, the not-approved 403 (data, not a throw), and an ordinary 403 (still a throw)");
    {
      const applyResult: PruneApplyResult = { downpipeId: "dp1", mode: "preview", retainedRuns: 1, supersededRuns: 2, runTreeObjects: 4, orphanSegs: 1 };
      nextResponse = () => new Response(JSON.stringify(applyResult), { status: 200 });
      const got = await client.retentionPruneApply({ downpipeId: "dp1", batch: [{ runId: "run-b", masterB64: "bWFzdGVy" }], previewOnly: true });
      const body = JSON.parse(last().body ?? "{}") as { previewOnly?: boolean };
      eq(last().url, "https://engine.example.com/admin/retention-prune/apply", "apply hits POST /admin/retention-prune/apply");
      eq(body.previewOnly, true, "apply forwards previewOnly:true when set");
      eq(got.mode, "preview", "apply's ok result passes through");

      const gotNoPreview = await client.retentionPruneApply({ downpipeId: "dp1", batch: [] });
      const body2 = JSON.parse(last().body ?? "{}") as { previewOnly?: boolean };
      ok("apply omits previewOnly from the body when not set (never sends previewOnly:undefined)", !("previewOnly" in body2));
      void gotNoPreview;

      const notApproved: PruneApplyResult = { downpipeId: "dp1", mode: "not-approved", retainedRuns: 1, supersededRuns: 2, planHash: "sha384:abc" };
      nextResponse = () => new Response(JSON.stringify(notApproved), { status: 403 });
      const gotNotApproved = await client.retentionPruneApply({ downpipeId: "dp1", batch: [] });
      eq(gotNotApproved.mode, "not-approved", "a 403 carrying a real not-approved PruneApplyResult is handed back as DATA, not thrown");
      eq(gotNotApproved.planHash, "sha384:abc", "the not-approved result's planHash survives, so the screen can raise a request against it");

      // An ordinary capability-refusal 403 carries the engine's plain {error} shape, not a PruneApplyResult
      // (no "mode" field), so the not-approved admission's own isPruneApplyResult(maybe) check fails and it
      // falls through to the normal failResponse throw -- which, for 403, is deliberately the bare "<verb>:
      // 403" (403 keeps its own failResponse marker rather than the reason-fold; see parseJsonOrReason's
      // own comment). This is what proves the two 403 shapes are told apart on structure, not by chance.
      nextResponse = () => new Response(JSON.stringify({ error: "the caller does not hold restore.apply" }), { status: 403 });
      let threwOrdinary = "";
      try {
        await client.retentionPruneApply({ downpipeId: "dp1", batch: [] });
      } catch (e) {
        threwOrdinary = e instanceof Error ? e.message : String(e);
      }
      ok("an ORDINARY capability-refusal 403 (no mode field) still throws (not swallowed as a not-approved result)", /403/.test(threwOrdinary));
    }

    console.log("retentionPruneRequest / retentionPruneApprove / retentionPruneReject: path, method, body");
    {
      const approval: PruneApproval = {
        planHash: "sha384:abc",
        downpipeId: "dp1",
        retainedRuns: 1,
        supersededRuns: 2,
        requestedBy: "op@x.example",
        requestedAt: "2026-08-03T00:00:00.000Z",
        reason: "Clearing superseded runs past the retention window",
        status: "requested",
        expiresAt: "2026-08-10T00:00:00.000Z",
      };
      nextResponse = () => new Response(JSON.stringify(approval), { status: 200 });
      const gotReq = await client.retentionPruneRequest({ downpipeId: "dp1", reason: approval.reason });
      eq(last().url, "https://engine.example.com/admin/retention-prune/request", "request hits POST /admin/retention-prune/request");
      eqDeep(JSON.parse(last().body ?? "{}"), { downpipeId: "dp1", reason: approval.reason }, "request's body carries downpipeId + reason verbatim");
      eq(gotReq.status, "requested", "request's result passes through");

      const approved: PruneApproval = { ...approval, status: "approved", approvedBy: "owner@x.example", approvedAt: "2026-08-03T01:00:00.000Z" };
      nextResponse = () => new Response(JSON.stringify(approved), { status: 200 });
      const gotApprove = await client.retentionPruneApprove("sha384:abc");
      eq(last().url, "https://engine.example.com/admin/retention-prune/approve", "approve hits POST /admin/retention-prune/approve");
      eqDeep(JSON.parse(last().body ?? "{}"), { planHash: "sha384:abc" }, "approve's body carries only the planHash");
      eq(gotApprove.status, "approved", "approve's result passes through");

      const rejected: PruneApproval = { ...approval, status: "rejected", rejectReason: "policy" };
      nextResponse = () => new Response(JSON.stringify(rejected), { status: 200 });
      const gotReject = await client.retentionPruneReject("sha384:abc", "policy");
      eq(last().url, "https://engine.example.com/admin/retention-prune/reject", "reject hits POST /admin/retention-prune/reject");
      eqDeep(JSON.parse(last().body ?? "{}"), { planHash: "sha384:abc", rejectReason: "policy" }, "reject's body carries the planHash and the closed-vocabulary reason");
      eq(gotReject.rejectReason, "policy", "reject's result passes through, including the reason");
    }

    console.log("retentionPruneApprovals: GET, list parsed, and a malformed shape refused");
    {
      const list: PruneApproval[] = [
        { planHash: "sha384:a", downpipeId: "dp1", retainedRuns: 1, supersededRuns: 1, requestedBy: "op@x.example", requestedAt: "2026-08-03T00:00:00.000Z", reason: "r1", status: "requested", expiresAt: "2026-08-10T00:00:00.000Z" },
      ];
      nextResponse = () => new Response(JSON.stringify(list), { status: 200 });
      const gotList = await client.retentionPruneApprovals();
      eq(last().url, "https://engine.example.com/admin/retention-prune/approvals", "approvals hits GET /admin/retention-prune/approvals");
      eq(last().method, "GET", "approvals is a GET");
      eq(gotList.length, 1, "approvals' list passes through");

      nextResponse = () => new Response(JSON.stringify({ notAList: true }), { status: 200 });
      let threwShape = "";
      try {
        await client.retentionPruneApprovals();
      } catch (e) {
        threwShape = e instanceof Error ? e.message : String(e);
      }
      ok("approvals: a 200 whose body is not a list of approval records is refused, not indexed blindly", threwShape.length > 0);
    }
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-retention-prune-client (${failures} failure(s))`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
