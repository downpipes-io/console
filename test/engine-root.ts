// One answer to "where is the engine", for every check in this repo that reads the sibling.
//
// WHY THIS EXISTS. Seven files here read the engine's source to hold a mirror or a constant honest.
// Six accepted an override and one did not, and they used TWO DIFFERENT variable names for it:
// DOWNPIPES_ENGINE in four, ENGINE_WORKTREE in two. So setting either one moved some of them and left the
// rest reading whatever the sibling working tree happened to hold.
//
// That is not theoretical. the engine's primary working tree sat 44 commits behind its own
// origin/main, and the console's RESERVED_BINDINGS mirror check failed against 38 names when committed
// engine main had 40. Nothing was wrong with either side. The check that failed was the one file with no
// override, so there was no way to point it anywhere better.
//
// RESOLUTION ORDER, and it is deliberate. An explicit override first, because a caller who says where the
// engine is has more information than any guess. Then the unified support worktrees, which ARE the engine
// that will ship while a build is in flight. Then the sibling checkout, then one level further out for a
// repo nested a directory deeper. First existing path wins.
//
// ENGINE_WORKTREE is still read, after DOWNPIPES_ENGINE, so nobody's existing invocation quietly stops
// working. Standardising on one name and silently dropping the other would reproduce the exact fault this
// file is here to remove.
//
// House style: Australian English, no em dashes, no rule-of-three.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

/** Every place the engine might be, best first. Internal: the only caller is engineRoot below. */
function engineCandidates(): string[] {
  return [
    process.env.DOWNPIPES_ENGINE,
    process.env.ENGINE_WORKTREE,
    resolve(HERE, "../../support-unified-engine"),
    resolve(HERE, "../../support-pack-engine"),
    resolve(HERE, "../../engine"),
    resolve(HERE, "../../../engine"),
  ].filter((p): p is string => typeof p === "string" && p !== "");
}

/**
 * The engine root, or null when no candidate exists.
 *
 * Returning null rather than throwing is on purpose: several callers are cross-repo checks that must
 * degrade to a skip in a single-repo checkout, and deciding that is theirs, not this file's. A caller that
 * needs the engine unconditionally should say so at its own call site.
 */
export function engineRoot(): string | null {
  for (const c of engineCandidates()) {
    if (existsSync(c)) return c;
  }
  return null;
}
