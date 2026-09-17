// Where the ENGINE checkout is, for the console tests that cross-check against it.
//
// WHY THIS IS ONE FUNCTION AND NOT THREE COPIES
// ---------------------------------------------
// Three console validators import engine source to prove the console mirrors it: the plan-hash parity in
// validate-api-pure.ts and validate-plan-hash.ts, and the role-capability parity in validate-identity.ts.
// Each resolved the engine itself, with the same relative hop, and all three were wrong in the same way.
//
// `../../engine` is the workspace engine when the console is the PRIMARY checkout. From a worktree, which
// is how the console is checked out for most of this work, it is console/.worktrees/engine. That is not a
// missing path, which would at least be loud: in this workspace it is a real engine checkout parked there
// on an unrelated branch. So the parity blocks ran, and passed, against whichever engine happened to be
// sitting in that slot.
//
// Passing a parity check against an arbitrary engine is close to not running it, and these are not
// decorative checks. The plan hash is the value a dual-control approval is BOUND to: if the console and the
// engine compute it differently, an approved plan and an applied plan can differ.
//
// The rule: an explicit ENGINE_WORKTREE override wins; from a worktree the engine beside the WORKSPACE root
// is tried FIRST and the relative sibling only as a fallback; from the primary checkout the two are the
// same directory anyway. Ordering it the other way would keep the bug, because the stale sibling wins
// whenever it exists.
//
// Callers still SKIP with a visible note when nothing resolves, because a console-only clone has no engine
// and must still run its own tests. What they no longer do is quietly check the wrong one.

import { verdictCannotCheck } from "./lib/verdict-guard.ts";

// engineRoots returns the candidate engine roots, best first, for a caller in this repo's test directory.
//
// TWO override names, and that is deliberate rather than sloppy. DOWNPIPES_ENGINE is the workspace-wide
// escape hatch the cross-repo gates use (the client-diag and audit-mirror drift gates, the website's
// surfaces generator, the resync tool). ENGINE_WORKTREE is what these three console parity tests were
// already documented to accept. Honouring only one would silently ignore an override someone set in good
// faith, and an ignored override lands back on the default, which is the failure this file exists to fix.
// DOWNPIPES_ENGINE wins when both are set, because it is the convention with more callers.
export function engineRoots(fromDir: string): string[] {
  const override = process.env.DOWNPIPES_ENGINE ?? process.env.ENGINE_WORKTREE;
  if (override !== undefined && override !== "") return [override];
  const at = fromDir.indexOf("/.worktrees/");
  if (at === -1) return [`${fromDir}../../engine`];
  return [`${fromDir.slice(0, at)}/../engine`, `${fromDir}../../engine`];
}

// importFromEngine tries each candidate root in turn and returns the first module that loads, or null when
// no engine checkout is reachable. `rel` is a repo-relative path such as "src/admin/approvals.ts".
//
// REQUIRE_ENGINE=1 turns "no engine" from a skip into a REFUSAL, exit 2. That flag is set by
// `npm run validate:workspace`, the cross-repo chain CI runs with the engine actually checked out. The
// distinction matters: on a single-repo clone a missing engine is a fact of the checkout and skipping is
// right, but in the job whose entire purpose is the cross-repo comparison, skipping is the failure mode
// this repo already names elsewhere ("a gate that quietly opts out when it cannot check reads as a pass").
//
// HOW IT WAS SET, AND WHY THAT DID NOT WORK, because the shape is easy to write again. The chain was one
// long `&&` line beginning `REQUIRE_ENGINE=1 node scripts/client-diag-parity-gate.mjs && ...`. A shell env
// prefix binds to a SINGLE command, so the flag reached the first gate and nothing after it. The first
// gate does not read REQUIRE_ENGINE at all, and every file that does read it (validate-identity.ts,
// validate-plan-hash.ts, validate-api-pure.ts, validate-cf-surface-split-parity.ts,
// validate-visible-surface-counts.ts) sat after the first `&&`. Measured: engine absent,
// validate-identity.ts prints its skip note and exits 0. So this throw had never fired anywhere.
//
// The chain is now `REQUIRE_ENGINE=1 npm run validate:workspace:chain`, one assignment on the process
// that spawns every command, so the flag reaches all of them. If the chain is ever inlined back onto one
// line, put the assignment in front of each command that needs it or it silently stops applying.
//
// The name follows the engine's existing convention, REQUIRE_<THING>=1, as in REQUIRE_CF_OPENAPI. That
// guard exists for the identical reason and its comment even names the failure ("section2-never-runs-in-
// ci"). The engine had already solved this and named it; the console had drifted from it, and inventing a
// second name for one idea is the drift this codebase keeps paying for.
//
// Without it these parity blocks skipped in CI and nobody would have known: the plan-hash parity, which
// pins the value a dual-control approval is BOUND to, has never actually run there.
//
// AND FOR A WHILE IT STILL DID NOT, because of how the flag was written. The script read
// `REQUIRE_ENGINE=1 node scripts/client-diag-parity-gate.mjs && node test/validate-plan-hash.ts && ...`,
// and a POSIX assignment prefix binds to ONE simple command: `sh -c 'FOO=1 true && printenv FOO'` prints
// nothing. So the flag reached only the first script in the chain, which is a .mjs gate that fails on a
// missing engine anyway and never consults this module. Every file that does consult it sat on the far
// side of an `&&` with the variable unset, so all five parity blocks went on skipping in the one job built
// to run them. The chain now exports the variable instead, which is the difference between a flag that is
// set and a flag that is set FOR THE THING IT GUARDS.
//
// The lesson generalises past this file: a guard is not in force because a script mentions it, and the
// cheap proof is to run the guarded thing in a checkout that cannot satisfy it and watch it fail.
//
// AND IT MUST FAIL AS A REFUSAL, NOT AS A FINDING. The require arm used to `throw`, and a
// throw out of an async function reached the entry point's floating `main().catch` tail or nothing at all,
// which is exit 1 with a stack trace. Exit 1 in this repository means "this repository is wrong", and it
// licenses a reader to take the violations printed above it as the complete set. A missing engine is not a
// divergence between the console and the engine. It is the absence of the second half of the comparison, so
// nothing was compared and nothing can be concluded. That is exit 2.
//
// MEASURED, at console 9933448b, from a console worktree with no engine at any candidate path, each exit
// read off its own process: with REQUIRE_ENGINE=1 validate-identity.ts, validate-plan-hash.ts and
// validate-api.ts all exited 1 through this throw, and each printed the completion guard's "reached process
// exit ... without declaring a verdict" complaint on top of a refusal that was perfectly deliberate. On the
// identical input scripts/stepup-call-site-gate.mjs exited 2, and so did test/validate-audit-mirror.ts and
// test/validate-notifications.ts, which had already been converted one call site at a time. This is the
// shared root the per-call-site conversions kept working around: the comment in
// test/validate-cf-surface-contract.ts names this exact throw, and adds a pre-check at its own call site
// rather than fixing it here.
//
// verdictCannotCheck rather than a bare process.exit(2), because it also DECLARES the verdict, which is what
// stops the completion guard printing its complaint over the top. It is imported at the top of this module
// on purpose: every entry point that imports this file already arms the guard itself (checked at 9933448b
// over all fourteen importers; the one that does not, validate-api-pure.ts, is reached only through
// validate-api.ts, which does), and the four scripts/*.mjs gates that name this file name it in prose and
// never import it, so nothing that did not already carry the guard picks it up here.
export async function importFromEngine<T>(fromDir: string, rel: string): Promise<T | null> {
  for (const root of engineRoots(fromDir)) {
    try {
      return (await import(new URL(`${root}/${rel}`, "file://").pathname)) as T;
    } catch {
      // Not this root: try the next.
    }
  }
  if (process.env.REQUIRE_ENGINE === "1") {
    verdictCannotCheck(
      `REFUSED, REQUIRE_ENGINE=1 and no engine checkout supplied ${rel}.\n` +
        `  Tried: ${engineRoots(fromDir).join(", ")}.\n` +
        "  This is the cross-repo chain, so a missing engine is a configuration fault to fix rather than a\n" +
        "  reason to stop checking. Nothing was compared here, so this is a check that could not run and not\n" +
        "  a divergence that was found.\n" +
        "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.",
    );
  }
  return null;
}
