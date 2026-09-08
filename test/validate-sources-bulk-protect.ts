// Validate the Sources screen's bulk-protect control flow (src/screens/sources/tiers.ts):
// the shared assembly + many-at-once create loop and the outcome -> operator-signal reporting
// that the "Attached, not yet protected" tier runs when the owner ticks several bindings and
// presses "Protect". Since the many-to-many create, the loop is ONE POST /admin/downpipes/bulk
// per slice (per-item results) with a per-item single-create FALLBACK against an older engine,
// and the assembly bundles ticked SECRETS into one Secrets downpipe while every store binding
// becomes its own; the destination fan-out rides on every downpipe in the batch.
//
// Coverage:
//   bulkCreateDownpipes (through the real assembly + loop):
//     (1) all succeed             -> done = N, queued = 0, no failures, not halted; ONE bulk call
//     (2) all queued (pending)    -> queued = N, done = 0
//     (3) partial failure         -> failures carry the per-binding name + engine reason
//     (4) a 401 from the bulk call-> halted true, nothing counted
//     (5) OLDER ENGINE (bulk 404) -> falls back to per-item addDownpipe, same outcome shape
//     (6) secrets bundling        -> ticked secrets are ONE wire downpipe of type "secrets"
//                                    (rows per binding), stores are one wire downpipe each
//     (7) destinationIds          -> the ordered fan-out rides on EVERY downpipe in the batch
//   reportBulkOutcome:
//     (1) all succeed            -> clearDraft true, signedOut false
//     (2) partial failure        -> clearDraft FALSE (the draft is preserved), signedOut false
//     (3) halted                 -> signedOut true, clearDraft false (nothing is cleared on a halt)
//
// Run with `node test/validate-sources-bulk-protect.ts`. No network: the engine client is a
// stub whose bulkAddDownpipes/addDownpipe are scripted per call. A DOM shim is installed first
// because reportBulkOutcome composes the real toast / bulk-summary surfaces (they touch document).

import { installDomShim } from "./dom-shim.ts";

installDomShim();

const { bulkCreateDownpipes, reportBulkOutcome } = await import("../src/screens/sources/tiers.ts");
import type { Downpipe, EngineClient } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A 401-shaped error: classifyError reads the status off the message, so "...: 401" maps to
// the unauthorised kind that isUnauthorised (and therefore the halt path) keys on.
function unauthorisedError(): Error {
  return new Error("bulk add downpipes: 401");
}

// makeEngine scripts the BULK endpoint by mapping each sent downpipe to a per-item status via
// `statusFor`, and records every batch it received (so the assembly + fan-out assertions read the
// real wire payload). A thrown script (401 / 404) rejects the whole call, exercising the halt and
// older-engine fallback paths. addDownpipe (the fallback + single path) is scripted separately.
function makeEngine(opts: {
  statusFor?: (dp: Downpipe) => "applied" | "pending" | "error";
  bulkThrows?: Error;
  singleScript?: Array<"ok" | "queued" | "fail" | "401">;
}): { engine: EngineClient; batches: Downpipe[][]; singleCalls: () => number } {
  const batches: Downpipe[][] = [];
  let si = 0;
  const engine = {
    bulkAddDownpipes: async (dps: Downpipe[]) => {
      if (opts.bulkThrows) throw opts.bulkThrows;
      batches.push(dps);
      const results = dps.map((dp) => {
        const status = (opts.statusFor ?? (() => "applied"))(dp);
        return status === "error" ? { id: dp.id, status, error: "boom" } : { id: dp.id, status };
      });
      return {
        results,
        applied: results.filter((r) => r.status === "applied").length,
        pending: results.filter((r) => r.status === "pending").length,
        failed: results.filter((r) => r.status === "error").length,
      };
    },
    addDownpipe: async () => {
      const step = (opts.singleScript ?? [])[si++];
      if (step === "401") throw unauthorisedError();
      if (step === "fail") throw new Error("boom");
      return { status: step === "queued" ? "pending" : "active" };
    },
  } as unknown as EngineClient;
  return { engine, batches, singleCalls: () => si };
}

async function main(): Promise<void> {
  // --- all succeed (immediate), one bulk call carries the whole batch ---
  {
    const { engine, batches } = makeEngine({});
    const out = await bulkCreateDownpipes(engine, [["A", "kv"], ["B", "r2"], ["C", "d1"]], 86400);
    ok("all succeed: done counts every item", out.done === 3);
    ok("all succeed: nothing queued", out.queued === 0);
    ok("all succeed: no failures", out.failures.length === 0);
    ok("all succeed: not halted", out.halted === false);
    ok("all succeed: ONE bulk call carried the whole batch", batches.length === 1 && batches[0]?.length === 3);
  }

  // --- all queued (pending) ---
  {
    const { engine } = makeEngine({ statusFor: () => "pending" });
    const out = await bulkCreateDownpipes(engine, [["A", "kv"], ["B", "kv"]], 86400);
    ok("all queued: queued counts every item", out.queued === 2);
    ok("all queued: none counted done", out.done === 0);
  }

  // --- partial failure: the per-item error names the binding + reason ---
  {
    const { engine } = makeEngine({ statusFor: (dp) => (dp.source.binding === "B" ? "error" : "applied") });
    const out = await bulkCreateDownpipes(engine, [["A", "kv"], ["B", "kv"], ["C", "kv"]], 86400);
    ok("partial: the two non-failing items count done", out.done === 2);
    ok("partial: one failure recorded", out.failures.length === 1);
    ok("partial: the failure names the binding", out.failures[0]?.name === "B");
    ok("partial: the failure carries the engine reason", out.failures[0]?.reason === "boom");
    ok("partial: not halted (an item error is not a session expiry)", out.halted === false);
  }

  // --- a 401 on the bulk call halts everything ---
  {
    const { engine } = makeEngine({ bulkThrows: unauthorisedError() });
    const out = await bulkCreateDownpipes(engine, [["A", "kv"], ["B", "kv"], ["C", "kv"]], 86400);
    ok("halt: halted flag set on the 401", out.halted === true);
    ok("halt: nothing counted done", out.done === 0 && out.failures.length === 0);
  }

  // --- OLDER ENGINE: the bulk route 404s -> per-item single-create fallback ---
  {
    const { engine, singleCalls } = makeEngine({ bulkThrows: new Error("bulk add downpipes: 404"), singleScript: ["ok", "fail", "queued"] });
    const out = await bulkCreateDownpipes(engine, [["A", "kv"], ["B", "kv"], ["C", "kv"]], 86400);
    ok("fallback: every item went through addDownpipe", singleCalls() === 3);
    ok("fallback: done/queued/failures aggregate identically", out.done === 1 && out.queued === 1 && out.failures.length === 1);
    ok("fallback: the failure names the binding", out.failures[0]?.name === "B");
  }

  // --- secrets bundling + per-store downpipes + the shared fan-out ---
  {
    const { engine, batches } = makeEngine({});
    const out = await bulkCreateDownpipes(
      engine,
      [["SRC_KV_app", "kv"], ["SRC_SEC_api_key", "secrets"], ["SRC_SEC_webhook_token", "secrets"]],
      3600,
      ["dest-b", "dest-a"],
    );
    const sent = batches[0] ?? [];
    ok("secrets: the batch is 2 downpipes (1 kv + 1 bundle), not 3", out.total === 2 && sent.length === 2);
    const bundle = sent.find((d) => d.source.type === "secrets");
    ok("secrets: the bundle carries one row per ticked secret binding", bundle?.source.secrets?.length === 2 && bundle.source.secrets.every((s) => s.binding.startsWith("SRC_SEC_")));
    ok("secrets: the bundle rows derive human names", bundle?.source.secrets?.[0]?.name === "api key");
    ok("fan-out: every downpipe in the batch pins the ordered destinations", sent.every((d) => JSON.stringify(d.destinationIds) === JSON.stringify(["dest-b", "dest-a"])));
    ok("kv: the store downpipe derives its name from the binding", sent.find((d) => d.source.type === "kv")?.name === "app");
  }

  // --- reportBulkOutcome: a clean run clears the draft, no sign-out ---
  {
    const r = reportBulkOutcome({ done: 2, queued: 0, failures: [], halted: false, total: 2 }, 2);
    ok("report clean: draft is cleared", r.clearDraft === true);
    ok("report clean: not signed out", r.signedOut === false);
  }

  // --- reportBulkOutcome: a partial failure PRESERVES the draft ---
  {
    const r = reportBulkOutcome({ done: 1, queued: 0, failures: [{ name: "B", reason: "boom" }], halted: false, total: 2 }, 2);
    ok("report partial: draft is preserved for retry", r.clearDraft === false);
    ok("report partial: not signed out", r.signedOut === false);
  }

  // --- reportBulkOutcome: a halt signs out and clears nothing ---
  {
    const r = reportBulkOutcome({ done: 0, queued: 0, failures: [], halted: true, total: 3 }, 3);
    ok("report halt: signed out", r.signedOut === true);
    ok("report halt: draft not cleared", r.clearDraft === false);
  }

  console.log(failures === 0 ? "\nSOURCES BULK-PROTECT VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
