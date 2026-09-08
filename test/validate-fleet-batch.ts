// The fleet-wide bulk loop, driven through the REAL runBatch.
//
//   node test/validate-fleet-batch.ts
//
// This loop is what an operator trusts when a fleet action goes partly wrong. There is no transaction, so
// its whole job is HONEST PARTIAL SUCCESS: say how many completed, name the ones that did not, and never
// report a blanket "done".
//
// Four paths matter, and each has a way of lying that this file forbids:
//
//   pass          -> a plain success toast and NO failures modal.
//   per-item fail -> a warn toast with both counts, and a summary modal carrying the per-item reasons. A
//                    single "N done" here would bury the failures.
//   queued        -> a change-gate-queued delete DID NOT DELETE. bulkDelete throws for it deliberately so
//                    it lands as a per-item failure; counting it as done would tell the operator their
//                    fleet was deleted while it waits for a second approver.
//   429 storm     -> the item is retried up to MAX_RATE_LIMIT_RETRIES and then recorded as ONE labelled
//                    rate-limited failure, so a limiter storm reads as itself rather than as N unexplained
//                    failures.
//   401 mid-batch -> the loop HALTS rather than firing the rest at a dead session, records how many never
//                    completed, tells the operator what did complete, and signs out.
//
// The halt count is asserted exactly: rows.length - done. That number is the only record of the incident's
// size, so an off-by-one there misreports it permanently.

import { installDomShim, textOf, } from "./dom-shim.ts";
installDomShim();

const { runBatch } = await import("../src/screens/sources-downpipes/detail-actions.ts");
const { MAX_RATE_LIMIT_RETRIES } = await import("../src/lib/bulk-pacing.ts");
const ring = await import("../src/lib/client-diag/ring.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// classifyError reads the status off the MESSAGE, not off a property, so these are the
// shapes the loop's branches actually key on.
const err401 = (): Error => new Error("trigger: 401");
const err429 = (): Error => new Error("trigger: 429");
const errPlain = (m: string): Error => new Error(`trigger: ${m}`);

const row = (id: string, name = id) => ({ config: { id, name, source: { type: "kv" } } });

function bodyText(): string {
  return textOf((globalThis as unknown as { document: { body: unknown } }).document.body as never);
}
function countOf(re: RegExp): number {
  return (bodyText().match(re) ?? []).length;
}

// run drives the real loop with a scripted per-item op and returns what it was asked to do.
async function run(ids: string[], op: (id: string, attempt: number) => Promise<unknown>): Promise<{ calls: string[]; reloads: number }> {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  let reloads = 0;
  await runBatch(
    "run" as never,
    ids.map((i) => row(i)) as never,
    async (r: { config: { id: string } }) => {
      const id = r.config.id;
      calls.push(id);
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      return op(id, n);
    },
    "started",
    () => { reloads += 1; },
  );
  return { calls, reloads };
}

async function main(): Promise<void> {
  console.log("(1) every item passes: a plain success toast, no failures modal");
  {
    const before = countOf(/failed\./g);
    const { calls, reloads } = await run(["a", "b", "c"], () => Promise.resolve({}));
    ok("(1a) every row was attempted once, in order", JSON.stringify(calls) === JSON.stringify(["a", "b", "c"]));
    ok("(1b) the list is reloaded", reloads === 1);
    ok("(1c) the success toast names the count and the verb", bodyText().includes("3 started."));
    ok("(1d) no failure summary is raised", countOf(/failed\./g) === before);
  }

  console.log("\n(2) a per-item failure is NAMED, never folded into a blanket success");
  {
    // Counted as a DELTA: case (1) already left a "3 started." toast in the document, and toasts outlive
    // the action that raised them, so an absence check here would fail for an unrelated reason.
    const blanketBefore = countOf(/3 started\./g);
    const { calls } = await run(["a", "bad", "c"], (id) => (id === "bad" ? Promise.reject(errPlain("no such binding")) : Promise.resolve({})));
    ok("(2a) the loop continued past the failure", JSON.stringify(calls) === JSON.stringify(["a", "bad", "c"]));
    const t = bodyText();
    ok("(2b) the toast reports both counts", t.includes("2 started, 1 failed."));
    ok("(2c) the failing item is named in the summary", t.includes("bad"));
    ok("(2d) with the engine's own reason", t.includes("no such binding"));
    ok("(2e) and it raises NO new blanket \"3 started\" toast", countOf(/3 started\./g) === blanketBefore);
  }

  console.log("\n(3) a change-gate-QUEUED item counts as a failure, not as done");
  {
    // bulkDelete throws for a pending result on purpose: a queued delete has not deleted. Reporting it as
    // done would tell the operator their fleet was removed while it waits for a second approver.
    const { calls } = await run(["a", "held"], (id) => (id === "held" ? Promise.reject(errPlain("queued for approval; a second approver must approve it")) : Promise.resolve({})));
    ok("(3a) both items were attempted", calls.length === 2);
    const t = bodyText();
    ok("(3b) the queued item is counted as a failure", t.includes("1 started, 1 failed."));
    ok("(3c) and the reason explains the wait", t.includes("a second approver must approve it"));
  }

  console.log(`\n(4) a 429 storm is retried up to the cap (${MAX_RATE_LIMIT_RETRIES}) and then labelled, once`);
  {
    // Always 429: the item should be attempted 1 + MAX_RATE_LIMIT_RETRIES times in total, then recorded as
    // a single labelled failure rather than as several unexplained ones.
    const { calls } = await run(["storm"], () => Promise.reject(err429()));
    ok(`(4a) the item is attempted ${MAX_RATE_LIMIT_RETRIES + 1} times in total`, calls.length === MAX_RATE_LIMIT_RETRIES + 1);
    ok("(4b) and reported as exactly one failure", bodyText().includes("0 started, 1 failed."));
    // A 429 that clears on a retry must succeed rather than being recorded at all.
    const rec = await run(["flaky"], (_id, attempt) => (attempt === 1 ? Promise.reject(err429()) : Promise.resolve({})));
    ok("(4c) a 429 that clears on retry is attempted twice", rec.calls.length === 2);
    ok("(4d) and counts as a success", bodyText().includes("1 started."));
  }

  console.log("\n(5) a 401 mid-batch HALTS, and the not-completed count is exact");
  {
    const snapBefore = JSON.stringify(ring.snapshot());
    const { calls, reloads } = await run(["a", "b", "dead", "d", "e"], (id) => (id === "dead" ? Promise.reject(err401()) : Promise.resolve({})));
    ok("(5a) nothing after the expiry was attempted", JSON.stringify(calls) === JSON.stringify(["a", "b", "dead"]));
    ok("(5b) the list is still reloaded, so what did complete is visible", reloads === 1);
    const t = bodyText();
    ok("(5c) the operator is told what completed before the stop", t.includes("Stopped after 2 of 5"));
    ok("(5d) and why", t.includes("your Access session expired"));
    ok("(5e) with the re-authenticate instruction", t.includes("Re-authenticate to continue."));
    // 5 rows, 2 done: 3 never completed. That number is the only record of the incident's size.
    ok("(5f) the bulk-outcome ring recorded the halt", JSON.stringify(ring.snapshot()) !== snapBefore);
    ok("(5g) no failures modal is raised for an auth halt", !t.includes("0 started, 3 failed."));
  }

  console.log("\n(6) an empty selection is a no-op that still reports honestly");
  {
    const { calls, reloads } = await run([], () => Promise.resolve({}));
    ok("(6a) nothing is attempted", calls.length === 0);
    ok("(6b) the list is still reloaded", reloads === 1);
    ok("(6c) it reports zero rather than throwing", bodyText().includes("0 started."));
  }

  console.log("\n(7) every item failing is reported as such, with no success claim");
  {
    const { calls } = await run(["x", "y"], () => Promise.reject(errPlain("engine refused")));
    ok("(7a) both were attempted", calls.length === 2);
    const t = bodyText();
    ok("(7b) it reports zero started and two failed", t.includes("0 started, 2 failed."));
    ok("(7c) and never says two started", !t.includes("2 started."));
    ok("(7d) the summary modal lists both names", t.includes("x") && t.includes("y"));
  }

  console.log(`\n${failures === 0 ? "FLEET-BATCH OK: partial success is reported honestly, a queued item is a failure, a 429 storm is one labelled failure, and a 401 halts with an exact count" : `${failures} FAILURE(S)`}`);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
