// One answer to "where is the offline reader", for every check in this repo that reads that sibling.
//
// WHY THIS EXISTS. Two checks here make claims ABOUT the Go reader in `downpipe/`: validate-keygen.ts
// pins the four key-file labels the reader parses, and validate-offline-recovery-panel.ts asserts the
// flags, the listing command and the printed field a customer is told to type mid-incident. Both were
// written with the reader's facts COPIED into the console as literals, and neither opened the reader at
// all. That is the second-opinion class: a check that claims to validate the console against another
// repo but derives its expectation from a local artefact, so it cannot fail when the other side moves.
//
// It is the same fault test/engine-root.ts exists to fix, one sibling over. So the resolution follows
// that file deliberately, including returning null rather than throwing.
//
// THE OVERRIDE NAME IS NOT NEW. `DOWNPIPES_DOWNPIPE` is already the estate's name for this: docs uses it
// in check-cli-commands.mjs, check-exit-codes.mjs, check-capability-matrix.mjs and check-push-formats.mjs,
// where its own comments call it the convention alongside DOWNPIPES_ENGINE. Inventing a second name for
// one idea is the drift this codebase keeps paying for, and engine-path.ts already says so about the two
// engine names it is stuck honouring. One name here, taken from the callers that already had it.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verdictCannotCheck } from "./lib/verdict-guard.ts";

const HERE = new URL(".", import.meta.url).pathname;

/**
 * Every place the reader might be, best first. Internal: the only caller is downpipeRoot below.
 *
 * AN EXPLICIT OVERRIDE IS THE ONLY CANDIDATE, and that is the whole point of it. The first version of
 * this file listed the override and then fell through to the siblings, which meant a caller who pointed
 * DOWNPIPES_DOWNPIPE at a path that did not exist got the sibling working tree instead, silently. It was
 * caught the way it should be: REQUIRE_DOWNPIPE=1 with a deliberately bogus override was expected to
 * fail and PASSED, because the resolver had quietly found the real sibling behind it. That is the
 * "ignored override lands back on the default" fault test/engine-path.ts documents, rebuilt one sibling
 * over. A caller who names a root has more information than any guess here, including when they are
 * wrong: a missing override must be loud, not helpfully corrected.
 */
function downpipeCandidates(): string[] {
  const override = process.env.DOWNPIPES_DOWNPIPE;
  if (override !== undefined && override !== "") return [override];
  return [resolve(HERE, "../../downpipe"), resolve(HERE, "../../../downpipe")];
}

/**
 * The reader root, or null when no candidate exists.
 *
 * Null rather than a throw, for the reason engine-root.ts gives: a console-only clone has no reader and
 * must still run its own tests, and deciding whether that is fatal belongs to the caller. Callers in the
 * cross-repo chain should say so themselves, which is what requireDownpipeRoot below is for.
 */
export function downpipeRoot(): string | null {
  for (const c of downpipeCandidates()) {
    if (existsSync(resolve(c, "cmd/downpipe"))) return c;
  }
  return null;
}

/**
 * The reader root, or a REFUSAL at exit 2, when REQUIRE_DOWNPIPE=1.
 *
 * The distinction is the one test/engine-path.ts had to learn twice: on a single-repo clone a missing
 * sibling is a fact of the checkout and skipping is right, but in the job whose whole purpose is the
 * cross-repo comparison, skipping is a pass that proved nothing. REQUIRE_DOWNPIPE=1 turns the skip into a
 * failure there. Set it on the PROCESS, not as a prefix on the first command of an `&&` chain: a POSIX
 * assignment prefix binds to one simple command, which is how five engine parity blocks went on skipping
 * in the one job built to run them.
 *
 * AND THE FAILURE IS A REFUSAL, NOT A FINDING. This used to `throw`, which is exit 1 plus a
 * stack, and exit 1 in this repository means the repository is wrong. An absent reader checkout is not a
 * disagreement between the console and the reader, it is the absence of the thing the comparison needs, so
 * nothing was compared. Same fact, same exit code as test/engine-path.ts: 2, could not check.
 */
export function requireDownpipeRoot(who: string): string | null {
  const root = downpipeRoot();
  if (root !== null) return root;
  if (process.env.REQUIRE_DOWNPIPE === "1") {
    verdictCannotCheck(
      `REFUSED, REQUIRE_DOWNPIPE=1 and no downpipe (offline reader) checkout was found for ${who}.\n` +
        `  Tried: ${downpipeCandidates().join(", ")}.\n` +
        "  This is the cross-repo chain, so a missing sibling is a configuration fault to fix rather than a\n" +
        "  reason to stop checking. Nothing was compared here, so this is a check that could not run and not\n" +
        "  a divergence that was found.\n" +
        "  Point it at one with DOWNPIPES_DOWNPIPE=/path/to/downpipe, or check the reader out beside this repo.",
    );
  }
  return null;
}

/**
 * Read one Go source file from the reader, by repo-relative path such as "cmd/downpipe/keys.go".
 *
 * Throws when the file is missing, and that is on purpose even though downpipeRoot returns null: once a
 * root HAS resolved, a named file that is not there is a real change in the other repo (a rename, a
 * split), which is exactly the divergence these checks exist to notice. Swallowing it would turn a moved
 * file into a silent pass, which is the fault one level up from the one this module addresses.
 */
export function readDownpipeSource(root: string, rel: string): string {
  const p = resolve(root, rel);
  if (!existsSync(p)) {
    throw new Error(
      `downpipe reader is at ${root} but ${rel} is not there. The reader has moved or renamed that file; ` +
        "update the check to follow it rather than dropping the assertion.",
    );
  }
  return readFileSync(p, "utf8");
}
