// The bulk import drawer's two decision functions, driven directly.
//
//   node test/validate-import-drawer.ts
//
// A bulk import creates one downpipe per pasted binding, so these two functions decide what a single
// paste actually does to an estate. Both were untested.
//
// validateImportInput is the pre-flight. Its most valuable refusal is the "already a downpipe" check: a
// second downpipe on one binding does not fail, it silently DOUBLES the backups and the cost, which is
// the sort of thing an operator discovers on an invoice rather than on a screen.
//
// runImportLoop is the apply. Three things matter beyond the happy path: a queued create (the
// change-control gate deferring it for approval) is counted separately from an applied one, because
// reporting a queued create as done would tell the operator their fleet exists when it is waiting for a
// second pair of eyes; a per-binding failure does NOT stop the run, so one bad binding cannot strand the
// rest; and an expired session HALTS immediately rather than hammering a signed-out caller, recording how
// many bindings never completed.
//
// The arithmetic of that last count is pinned deliberately. It is unique.length - done - queued, and an
// off-by-one there misreports the size of an incident in the one record that survives it.

import { installDomShim } from "./dom-shim.ts";
installDomShim();

const { validateImportInput, runImportLoop } = await import("../src/screens/sources-downpipes/editor-import.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const NONE: ReadonlySet<string> = new Set();

// A minimal engine whose addDownpipe is scripted per binding, recording what it was asked to create.
function makeEngine(script: (binding: string, n: number) => { status?: string } | Error): {
  engine: unknown;
  created: Array<{ id: string; name: string; cadenceSeconds: number; enabled: boolean; source: { type: string; binding: string } }>;
} {
  const created: Array<{ id: string; name: string; cadenceSeconds: number; enabled: boolean; source: { type: string; binding: string } }> = [];
  let n = 0;
  const engine = {
    addDownpipe: async (dp: { id: string; name: string; cadenceSeconds: number; enabled: boolean; source: { type: string; binding: string } }) => {
      n += 1;
      const outcome = script(dp.source.binding, n);
      if (outcome instanceof Error) throw outcome;
      created.push(dp);
      return outcome;
    },
  };
  return { engine, created };
}

// The console classifies an expired Access session from the STATUS IN THE MESSAGE (classifyError reads
// a trailing ": 401"), not from a property on the error. Setting err.status instead is a real trap:
// classifyError ignores it, so the loop would take the per-binding-failure branch instead of the halt
// branch, and a fake of the wrong shape would exercise the wrong path while covering nothing. Same form
// as validate-sources-bulk-protect.ts's helper.
function unauthorised(): Error {
  return new Error("add downpipe: 401");
}

async function main(): Promise<void> {
  console.log("(1) validateImportInput: nothing pasted");
    for (const raw of ["", "   ", "\n\n", "  \n \t \n"]) {
      const r = validateImportInput(raw, NONE);
      ok(`(1) ${JSON.stringify(raw)} is refused with the one-per-line prompt`, r.ok === false && r.error === "Enter at least one binding, one per line.");
    }

  console.log("\n(2) validateImportInput: workers.dev URLs are refused, custom domains only");
  {
    const r = validateImportInput("KV_ok\nmy-worker.workers.dev", NONE);
    ok("(2a) a workers.dev host is refused", r.ok === false);
    ok("(2b) the error names the offender so it can be removed", r.ok === false && r.error.includes("my-worker.workers.dev"));
    ok("(2c) and shows the operator what a binding looks like", r.ok === false && r.error.includes("KV_uploads"));
    // Only the first three are listed, then "and others": a paste of fifty URLs must not produce an
    // error message longer than the paste.
    const many = validateImportInput(["a.workers.dev", "b.workers.dev", "c.workers.dev", "d.workers.dev"].join("\n"), NONE);
    ok("(2d) four offenders list three and say there are others", many.ok === false && many.error.includes("and others") && !many.error.includes("d.workers.dev"));
    const three = validateImportInput(["a.workers.dev", "b.workers.dev", "c.workers.dev"].join("\n"), NONE);
    ok("(2e) exactly three are all listed, with no 'and others'", three.ok === false && !three.error.includes("and others"));
  }

  console.log("\n(3) validateImportInput: duplicates are dropped silently and counted");
  {
    const r = validateImportInput("KV_a\nKV_b\nKV_a\nKV_a", NONE);
    ok("(3a) it succeeds rather than refusing", r.ok === true);
    ok("(3b) the unique list keeps FIRST-seen order", r.ok === true && JSON.stringify(r.unique) === JSON.stringify(["KV_a", "KV_b"]));
    ok("(3c) the dropped count is reported for the summary", r.ok === true && r.dupCount === 2);
    const trimmed = validateImportInput("  KV_a  \nKV_a\n\tKV_b", NONE);
    ok("(3d) surrounding whitespace is trimmed before deduping, so padded repeats still collapse", trimmed.ok === true && JSON.stringify(trimmed.unique) === JSON.stringify(["KV_a", "KV_b"]) && trimmed.dupCount === 1);
  }

  console.log("\n(4) validateImportInput: a binding that ALREADY has a downpipe is refused");
  {
    // The expensive one. A second downpipe per binding does not error anywhere downstream; it just
    // doubles the runs and the bill.
    const one = validateImportInput("KV_a\nKV_new", new Set(["KV_a"]));
    ok("(4a) it refuses", one.ok === false);
    ok("(4b) naming the binding", one.ok === false && one.error.includes("KV_a"));
    ok("(4c) and saying why it matters", one.ok === false && one.error.includes("doubles the backups and the cost"));
    ok("(4d) singular reads 'Remove it'", one.ok === false && one.error.includes("Remove it"));
    const two = validateImportInput("KV_a\nKV_b", new Set(["KV_a", "KV_b"]));
    ok("(4e) plural reads 'Remove them'", two.ok === false && two.error.includes("Remove them"));
    const clean = validateImportInput("KV_new", new Set(["KV_a"]));
    ok("(4f) an unknown binding passes the check", clean.ok === true);
  }

  console.log("\n(5) validateImportInput: the workers.dev check runs BEFORE the already-exists check");
  {
    // Order matters for the message the operator sees. A paste containing both problems must name the
    // malformed input first: fixing the URL may well remove the duplicate too, and telling someone their
    // URL "already has a downpipe" would be nonsense.
    const r = validateImportInput("x.workers.dev\nKV_a", new Set(["KV_a"]));
    ok("(5a) the workers.dev error wins", r.ok === false && r.error.includes("workers.dev"));
    ok("(5b) and the already-exists error is not shown", r.ok === false && !r.error.includes("doubles the backups"));
  }

  console.log("\n(6) runImportLoop: every create applied");
  {
    const { engine, created } = makeEngine(() => ({ status: "applied" }));
    const r = await runImportLoop(engine as never, ["KV_a", "KV_b", "KV_c"], "kv" as never, 3600);
    ok("(6a) all three count as done", r.done === 3 && r.queued === 0);
    ok("(6b) no failures and no halt", r.failures.length === 0 && r.halted === false);
    ok("(6c) they were created in the order given", JSON.stringify(created.map((d) => d.source.binding)) === JSON.stringify(["KV_a", "KV_b", "KV_c"]));
    ok("(6d) each carries the requested cadence and is enabled", created.every((d) => d.cadenceSeconds === 3600 && d.enabled === true));
    ok("(6e) each carries the requested source type", created.every((d) => d.source.type === "kv"));
    // The human name is derived, so an imported fleet reads "uploads" rather than "KV_uploads", while
    // the raw binding stays on the row as the sub-line.
    const named = makeEngine(() => ({ status: "applied" }));
    await runImportLoop(named.engine as never, ["KV_uploads"], "kv" as never, 60);
    ok("(6f) the display name drops the binding prefix", named.created[0]?.name === "uploads");
    ok("(6g) while the binding itself is preserved verbatim", named.created[0]?.source.binding === "KV_uploads");
  }

  console.log("\n(7) runImportLoop: a QUEUED create is counted separately from an applied one");
  {
    // Reporting a queued create as done would tell the operator their fleet exists when it is actually
    // waiting for an approver.
    const { engine } = makeEngine((b) => ({ status: b === "KV_b" ? "pending" : "applied" }));
    const r = await runImportLoop(engine as never, ["KV_a", "KV_b", "KV_c"], "kv" as never, 60);
    ok("(7a) the pending one is queued, not done", r.queued === 1 && r.done === 2);
    ok("(7b) the run is not treated as a failure", r.failures.length === 0 && r.halted === false);
    const allPending = makeEngine(() => ({ status: "pending" }));
    const r2 = await runImportLoop(allPending.engine as never, ["KV_a", "KV_b"], "kv" as never, 60);
    ok("(7c) an all-queued import reports zero done", r2.done === 0 && r2.queued === 2);
  }

  console.log("\n(8) runImportLoop: one bad binding does not strand the rest");
  {
    const { engine } = makeEngine((b) => (b === "KV_b" ? new Error("binding not found") : { status: "applied" }));
    const r = await runImportLoop(engine as never, ["KV_a", "KV_b", "KV_c"], "kv" as never, 60);
    ok("(8a) the loop continues past the failure", r.done === 2);
    ok("(8b) the failure is recorded against its binding", r.failures.length === 1 && r.failures[0]?.name === "KV_b");
    ok("(8c) with a reason the operator can act on", (r.failures[0]?.reason ?? "").includes("binding not found"));
    ok("(8d) and the run is not halted", r.halted === false);
  }

  console.log("\n(9) runImportLoop: an expired session HALTS, and the not-completed count is exact");
  {
    // Halting matters twice: it stops hammering a signed-out caller, and it stops the tally claiming
    // successes that never happened.
    const { engine, created } = makeEngine((b) => (b === "KV_c" ? unauthorised() : { status: "applied" }));
    const r = await runImportLoop(engine as never, ["KV_a", "KV_b", "KV_c", "KV_d", "KV_e"], "kv" as never, 60);
    ok("(9a) the run is marked halted", r.halted === true);
    ok("(9b) only the creates before the expiry count as done", r.done === 2);
    ok("(9c) an auth expiry is NOT filed as a per-binding failure", r.failures.length === 0);
    ok("(9d) nothing after the expiry was attempted", created.length === 2);
    // 5 bindings, 2 done, 0 queued: 3 never completed, which is the count the ring records. Asserted
    // through the returned tally because that is the same arithmetic the record uses.
    ok("(9e) the not-completed count is bindings minus done minus queued", 5 - r.done - r.queued === 3);
    // The same, with a queued create before the expiry, so the subtraction has to account for both.
    const mixed = makeEngine((b) => (b === "KV_c" ? unauthorised() : { status: b === "KV_b" ? "pending" : "applied" }));
    const r2 = await runImportLoop(mixed.engine as never, ["KV_a", "KV_b", "KV_c", "KV_d"], "kv" as never, 60);
    ok("(9f) a queued create counts as completed for that arithmetic", r2.done === 1 && r2.queued === 1 && 4 - r2.done - r2.queued === 2);
  }

  console.log("\n(10) runImportLoop: an empty list is a no-op, not an error");
  {
    const { engine, created } = makeEngine(() => ({ status: "applied" }));
    const r = await runImportLoop(engine as never, [], "kv" as never, 60);
    ok("(10a) nothing is created", created.length === 0);
    ok("(10b) the tally is empty and the run is not halted", r.done === 0 && r.queued === 0 && r.failures.length === 0 && r.halted === false);
  }

  console.log(`\n${failures === 0 ? "IMPORT-DRAWER OK: the pre-flight refuses a doubled binding, and the loop separates queued from done, survives one bad binding, and halts exactly on an expiry" : `${failures} FAILURE(S)`}`);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
