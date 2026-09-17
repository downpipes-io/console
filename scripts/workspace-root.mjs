// One answer to "where is the workspace root", for the checks here that read or write a sibling repo
// (internal-docs, harness, docs) rather than the engine. test/engine-root.ts plays the same part for the
// engine; this is deliberately a separate file because the question is a different one: the engine is
// found by trying known LOCATIONS, while the workspace root is found by stepping OUT of whatever nesting
// this checkout sits in, and the two rule sets do not usefully merge.
//
// WHY IT IS ONE FILE. Keeping this logic once, rather than duplicated across functional-catalogue-gate.mjs,
// functional-census.mjs and non-form-handler-census.mjs, means a single edit cannot lose the same guard in
// three places at once: duplicated logic buys no redundancy against a shared mistake, only more places for
// one to hide. test/validate-r30-workspace-resolution.ts holds the test for this single copy.
//
// THE TWO RULES, and both are load-bearing.
//
// BOUNDED, NOT AN OPEN-ENDED CLIMB. An unbounded climb up ancestor directories looking for the marker can,
// from a detached scratch worktree made with `git worktree add /somewhere/else`, keep climbing until it
// happens to find *an* internal-docs directory, however unrelated, and report its numbers as this
// checkout's own: a worktree at a scratch path with no real siblings could climb several levels and land on
// a stray `internal-docs` directory left over from an unrelated checkout, silently grading this checkout
// against numbers that describe a different tree.
//
// NEVER INSIDE A .worktrees DIRECTORY. A candidate whose path carries a ".worktrees" segment is refused
// however it was derived, because that is where a stale copy of a sibling lingers from a previous worktree
// run, while the committed data lives at the true workspace root ABOVE any such segment. Dropping this
// refusal is not a theoretical risk: without it, taking the direct parent unconditionally would resolve a
// console worktree at <root>/console/.worktrees/<name> to a decoy internal-docs sitting beside it, grading
// the checkout against a tree that is not it. The refusal is the whole reason this resolver cannot simply
// take the parent and stop.
//
// THE CANDIDATES, best first, and nothing else. A checkout that fits none of them is correctly unresolved,
// which callers report rather than paper over.
//   0. DOWNPIPES_WORKSPACE, when set. EXCLUSIVE, the same idiom the engine-sibling checks use for
//      DOWNPIPES_ENGINE: an override that does not resolve is a wrong override, not a cue to fall through
//      to a guess. It is held to the .worktrees refusal too. An operator who aims this at their own
//      worktree has made the exact mistake the refusal exists to catch, and saying so beats reading a
//      neighbouring checkout's numbers as this one's.
//   1. The direct parent. Every primary checkout has this shape (<workspace-root>/console).
//   2. The directory that OWNS the last ".worktrees" segment. This is the <workspace-root>/.worktrees/<name>
//      layout, which this workspace uses for its console worktrees. Candidate 1 lands on the .worktrees
//      directory itself there and is refused, so without this candidate every worktree in that layout
//      resolves to nothing.
//   3. The parent of that owner. This is the <workspace-root>/console/.worktrees/<name> layout, the nested
//      worktree this repo creates on purpose.
// Candidates 2 and 3 are derived by locating the LAST ".worktrees" segment and stepping out to what owns
// it, not by climbing an unbounded number of parents hoping to land there.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * True when any segment of this path is literally ".worktrees". Exported because this refusal is easy to
 * lose if inlined, so it is named, tested and reusable instead.
 */
export function underWorktrees(p) {
  return String(p).split(/[\\/]/).includes(".worktrees");
}

/**
 * The candidate workspace roots for a checkout at startDir, best first, before any marker or refusal test.
 * Pure string work, no filesystem access, so the ordering can be asserted directly by a test.
 */
export function workspaceCandidates(startDir) {
  const out = [join(startDir, "..")];
  const segs = String(startDir).split(/[\\/]/);
  const wtIdx = segs.lastIndexOf(".worktrees");
  if (wtIdx > 0) {
    const owner = segs.slice(0, wtIdx).join("/") || "/";
    out.push(owner, dirname(owner));
  }
  return out;
}

/**
 * The workspace root that carries markerRelPath, or null when no candidate does.
 *
 * Null rather than a throw or a fallback guess: every caller has its own right answer to "and then what"
 * (a gate degrades to a printed skip in a console-only checkout, a census writer refuses to write), and a
 * fallback of join(startDir, "..") would let a wrong path through.
 */
export function findWorkspaceDir(startDir, markerRelPath) {
  const accept = (dir) => (!underWorktrees(dir) && existsSync(join(dir, markerRelPath)) ? dir : null);
  const override = process.env.DOWNPIPES_WORKSPACE;
  if (override !== undefined) return accept(override);
  for (const c of workspaceCandidates(startDir)) {
    const hit = accept(c);
    if (hit !== null) return hit;
  }
  return null;
}
