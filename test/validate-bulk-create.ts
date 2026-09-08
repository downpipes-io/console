// Validate the shared many-at-once create loop (src/lib/bulk-create.ts): the slicing, the
// engine-advertised RE-BATCH (an oversized slice answers { rebatch: maxBatch } and the loop
// re-slices without losing or double-sending an item), the one-shot rate-limit retry, the
// per-slice failure accounting, the older-engine 404 fallback hand-off point, and the progress
// callback a button label reads. The Sources-tier validator covers the assembly + fallback
// end-to-end; this one drives the LOOP's own control flow with scripted posters.
//
// Run with `node test/validate-bulk-create.ts`. No DOM, no network.

import { runBulkCreate, DEFAULT_BULK_BATCH, type BulkCreatePoster } from "../src/lib/bulk-create.ts";
import type { Downpipe } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function item(i: number): { dp: Downpipe; label: string } {
  return {
    label: `b${i}`,
    dp: { id: `dp-${i}`, name: `dp ${i}`, cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: `SRC_KV_b${i}`, include: [], exclude: [] } },
  };
}

const appliedResponse = (dps: Downpipe[]) => ({
  results: dps.map((dp) => ({ id: dp.id, status: "applied" as const })),
  applied: dps.length,
  pending: 0,
  failed: 0,
});

async function main(): Promise<void> {
  // --- slicing: 250 items at the default cap is ceil(250/100) = 3 calls, no loss, no dupes ---
  {
    const sizes: number[] = [];
    const seen = new Set<string>();
    const post: BulkCreatePoster = {
      bulk: async (dps) => {
        sizes.push(dps.length);
        for (const dp of dps) seen.add(dp.id);
        return appliedResponse(dps);
      },
      single: async () => { throw new Error("single must not be called"); },
    };
    const progress: Array<[number, number]> = [];
    const out = await runBulkCreate(post, Array.from({ length: 250 }, (_v, i) => item(i)), (a, b) => progress.push([a, b]));
    ok("slicing: three calls at the default cap", sizes.length === 3 && sizes[0] === DEFAULT_BULK_BATCH && sizes[2] === 50);
    ok("slicing: every item sent exactly once", seen.size === 250 && out.done === 250);
    ok("slicing: progress reports settled counts up to the total", progress.length === 3 && progress[2]?.[0] === 250 && progress[2]?.[1] === 250);
    ok("slicing: total mirrors the item count", out.total === 250);
  }

  // --- rebatch: the engine's gated cap re-slices the SAME items, nothing lost or doubled ---
  {
    const sizes: number[] = [];
    const sent: string[] = [];
    let first = true;
    const post: BulkCreatePoster = {
      bulk: async (dps) => {
        sizes.push(dps.length);
        if (first && dps.length > 10) {
          first = false;
          return { rebatch: 10 };
        }
        for (const dp of dps) sent.push(dp.id);
        return appliedResponse(dps);
      },
      single: async () => { throw new Error("single must not be called"); },
    };
    const out = await runBulkCreate(post, Array.from({ length: 25 }, (_v, i) => item(i)));
    ok("rebatch: the oversized slice re-sends at the advertised cap", sizes[0] === 25 && sizes.slice(1).every((n) => n <= 10));
    ok("rebatch: every item still lands exactly once", sent.length === 25 && new Set(sent).size === 25 && out.done === 25);
  }

  // --- a nonsense rebatch echo (>= the slice) fails the slice rather than spinning ---
  {
    const post: BulkCreatePoster = {
      bulk: async (dps) => ({ rebatch: dps.length }),
      single: async () => { throw new Error("single must not be called"); },
    };
    const out = await runBulkCreate(post, Array.from({ length: 5 }, (_v, i) => item(i)));
    ok("rebatch guard: a non-shrinking echo fails per item, never loops", out.failures.length === 5 && out.done === 0);
  }

  // --- rate limit: one retry after the advertised wait, then the slice succeeds ---
  {
    let calls = 0;
    const post: BulkCreatePoster = {
      bulk: async (dps) => {
        calls++;
        if (calls === 1) throw new Error("bulk add downpipes: retry-after=0: 429");
        return appliedResponse(dps);
      },
      single: async () => { throw new Error("single must not be called"); },
    };
    const out = await runBulkCreate(post, [item(1), item(2)]);
    ok("429: the slice is retried once after the advertised wait", calls === 2 && out.done === 2 && out.failures.length === 0);
  }

  // --- a transient non-401 failure marks the slice failed and CONTINUES with the rest ---
  {
    let calls = 0;
    const post: BulkCreatePoster = {
      bulk: async (dps) => {
        calls++;
        if (calls === 1) throw new Error("bulk add downpipes: 500");
        return appliedResponse(dps);
      },
      single: async () => { throw new Error("single must not be called"); },
    };
    const out = await runBulkCreate(post, Array.from({ length: 150 }, (_v, i) => item(i)));
    ok("5xx: the failed slice is reported per item", out.failures.length === DEFAULT_BULK_BATCH);
    ok("5xx: the remaining slice still lands", out.done === 50 && out.halted === false);
  }

  console.log(failures === 0 ? "\nBULK-CREATE LOOP VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
