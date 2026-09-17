// A preload that watches where a script writes, and stops it landing outside this checkout.
//
// FS-WRITES: none outside this repo
//
// Loaded with `node --import ./scripts/fs-write-observer.mjs <script>`. It patches every write entry point
// in node:fs and node:fs/promises. A write whose resolved absolute path sits inside the console checkout
// is passed through untouched. A write that lands anywhere else is RECORDED and REDIRECTED into a shadow
// tree, so the script under observation carries on and reveals every path it would have touched rather
// than dying on the first one.
//
// WHY REDIRECT RATHER THAN REFUSE. A refusal answers "does this script write outside" and nothing more.
// The question that matters is "outside WHERE, and how many", and a throw on the first write hides the
// second: redirection is what lets a script's whole outside-write population be enumerated in one run
// without dirtying a repository someone else is using at the time. It is also what makes the deep half of
// outside-write-gate.mjs safe to run anywhere, including on a developer's primary checkout with live
// siblings beside it.
//
// WHY THE PATCH REACHES ESM IMPORTS. Mutating the CommonJS `fs` exports object does not by itself change
// what `import { writeFileSync } from "node:fs"` is already bound to. module.syncBuiltinESMExports() is
// the supported way to push those mutations into the builtin's ESM namespace, and it is called at the end
// of this file for exactly that reason. Without it this observer would silently see nothing in a repo
// whose scripts are all ESM, which is the worst failure available to an instrument: a clean report over
// no observation at all. test/validate-outside-writes.ts drives all three import styles against it.
//
// Environment, all required:
//   FS_OBSERVER_REPO     absolute path to the checkout that counts as "inside"
//   FS_OBSERVER_SHADOW   absolute path of a directory to redirect outside writes into
//   FS_OBSERVER_LOG      absolute path of a JSONL file, one record per distinct (kind, path)
//   FS_OBSERVER_LABEL    a string stamped on every record, so one log can hold several runs
//   FS_OBSERVER_NEUTRAL  optional, colon-separated. Directories that do not count as "outside" however
//                        far from the checkout they sit. Defaults to the OS temp directories, because a
//                        script writing a scratch file has not touched anybody's work. Set it EMPTY to
//                        make temp count, which is how test/validate-outside-writes.ts builds a fake
//                        sibling it can safely prove the observer catches. NEUTRAL NEVER APPLIES INSIDE A
//                        REPOSITORY, for the reason set out beside NEUTRAL below.

import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsp = require("node:fs/promises");

/**
 * One required setting, refused rather than defaulted.
 * @param {string} name
 * @returns {string}
 */
function need(name) {
  const v = process.env[name];
  if (v !== undefined && v.length > 0) return v;
  console.error(`[fs-write-observer] FATAL: ${name} must be set, along with the other two.`);
  console.error("[fs-write-observer] Refusing to load, because an observer that observes nothing reads exactly like a clean run.");
  process.exit(2);
}

const REPO = need("FS_OBSERVER_REPO");
const SHADOW = need("FS_OBSERVER_SHADOW");
const LOG = need("FS_OBSERVER_LOG");
const LABEL = process.env.FS_OBSERVER_LABEL ?? "unlabelled";

// Captured before the patch. That is necessary and, on its own, NOT SUFFICIENT: holding a reference to the
// original appendFileSync does not make a call to it unpatched, because node's appendFileSync is
// implemented by delegating to writeFileSync, and the delegation reaches the patched export. Without the
// exemption below, the observer's own log would be guarded, found to be outside the checkout, and
// redirected into the shadow, so the log the caller then reads is empty and an instrument that reports
// nothing observed is indistinguishable from a clean run. The two paths below are exempted in outside()
// for that reason.
const realAppend = fs.appendFileSync.bind(fs);
const realMkdir = fs.mkdirSync.bind(fs);
realMkdir(SHADOW, { recursive: true });
const OWN = [resolve(LOG), resolve(SHADOW)];

const seen = new Set();
// THE SEPARATOR IS AN ESCAPE SEQUENCE, not a raw byte, and that distinction matters. It is a composite map
// key: kind and path are joined into a single Set member so the pair dedupes as a pair rather than either
// half alone, and the joiner must be a character neither half can contain, which is NUL. Written as a raw
// NUL byte, it would make this file INVISIBLE to the tools that read this repo rather than merely ugly:
// git grep -I and ugrep both classify a file holding a raw NUL as binary and skip it whole at exit 1, with
// no count, no "binary file matches" line and no error, so a scan built on either would grade this file as
// though it were not there (docs/scripts/cited-symbol-gate.mjs is one such scan, and any symbol declared
// only here would be unreachable to it). Writing it as the escape sequence is the same code unit to the
// parser and an ordinary text file to everything that reads it.
function record(kind, path, redirected) {
  const key = `${kind}\0${path}`;
  if (seen.has(key)) return;
  seen.add(key);
  realAppend(LOG, `${JSON.stringify({ label: LABEL, kind, path, redirected })}\n`);
}

function asPath(p) {
  if (typeof p === "string") return p;
  if (p instanceof URL) return p.pathname;
  if (Buffer.isBuffer(p)) return p.toString();
  return null; // a numeric fd: already-open, and the open itself was seen
}

// Temp directories are not "outside" in any sense a caller cares about. They belong to nobody, no repo
// tracks them, and a script that writes one has not touched another agent's work.
//
// THE NEUTRAL LIST STAYS, AND IT IS NOT A CONVENIENCE. Redirection is only sound for a write node performs
// in this process. A script that hands a temp path to a NON-NODE child, to git, to tar or to esbuild, has
// the child write the real path while the parent reads the shadow, so redirecting genuine scratch would
// corrupt the script under observation rather than protect anybody. outside-write-gate.mjs intends to grow
// its deep half to files that run a full esbuild build, which writes tmpdir as a matter of course, so the
// exemption stays even where no current writer strictly needs it: the reason to keep it is the contract
// this file makes, not today's population of callers.
//
// TEMP-NESS ALONE IS NOT SAFE, AND THIS MATTERS ELSEWHERE IN THE WORKSPACE. Temp-ness describes where a
// path SITS. The harm this observer exists to prevent is that somebody's tracked work changed, which is a
// question of who OWNS the path, and the two come apart whenever a scratch working copy is built under a
// temp prefix (for example a bed at <tmp>/bed holding a real internal-docs checkout, or a symlink to the
// primary one) rather than in a directory nobody tracks. A write into a tracked checkout that happens to
// sit under a temp prefix must still be recorded and redirected: treating the prefix alone as neutral would
// let a write inside a real, tracked sibling pass through unrecorded and unredirected, which is strictly
// worse than not observing at all, because it denies the mutation happened.
//
// SO THE DISCRIMINATOR IS THE REPOSITORY, NOT THE PREFIX. A path that resolves inside a repository is never
// a scratch file, because a repository is exactly the thing whose contents somebody tracks. `.git` is
// reachable from every shape a bed takes, a worktree, a clone and a symlink to a live checkout alike, since
// existsSync resolves through the link. The rule is also monotone in the safe direction: it can only move a
// path from neutral to outside, never the reverse, so no write that is recorded today stops being recorded.
//
// WHAT IT STILL DOES NOT COVER, said rather than left to be found. A checkout that is not a repository, a
// bed populated by `git archive | tar -x`, is indistinguishable from scratch to this rule and stays neutral
// under a temp prefix. outside-write-gate.mjs closes that from the other end by refusing to drive its deep
// half until a canary proves the observer intercepts a write to the sibling it is about to risk. And a
// separate checkout nested INSIDE the declared repo, a `console/.worktrees/<name>` holding another
// checkout's own branch, is inside by the REPO test above and is not reached by this rule at all.
const NEUTRAL =
  process.env.FS_OBSERVER_NEUTRAL === undefined
    ? [tmpdir(), "/tmp", "/private/tmp", "/var/folders"]
    : process.env.FS_OBSERVER_NEUTRAL.split(":").filter(Boolean);
const under = (abs, dir) => abs === dir || abs.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

// The repository a directory belongs to, or null. Lexical ancestors of a path that need not exist yet, so a
// write to a file that has never been created still answers. Memoised per directory, and the whole chain
// walked is memoised with the answer, because guard() asks this on every intercepted call.
const repoOfDir = new Map();
function repoRootOf(startDir) {
  const chain = [];
  let dir = startDir;
  for (;;) {
    const cached = repoOfDir.get(dir);
    if (cached !== undefined) {
      for (const d of chain) repoOfDir.set(d, cached);
      return cached;
    }
    chain.push(dir);
    let here = null;
    try {
      if (fs.existsSync(join(dir, ".git"))) here = dir;
    } catch {
      here = null; // an unreadable ancestor is not evidence of a repository
    }
    if (here !== null) {
      for (const d of chain) repoOfDir.set(d, here);
      return here;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      for (const d of chain) repoOfDir.set(d, null);
      return null;
    }
    dir = parent;
  }
}

// Realpaths, so a bed reaching the declared checkout through a symlink is recognised as that checkout
// rather than as a stranger. Both operands exist by the time this is asked, so realpathSync can answer.
const realOf = new Map();
function realpathish(p) {
  const hit = realOf.get(p);
  if (hit !== undefined) return hit;
  let r = p;
  try {
    r = fs.realpathSync(p);
  } catch {
    r = p;
  }
  realOf.set(p, r);
  return r;
}
const isDeclaredRepo = (root) => root === REPO || realpathish(root) === realpathish(REPO);

function outside(abs) {
  // The observer's own log and shadow, first and unconditionally. They are outside the checkout by
  // construction, and guarding them turns the instrument off.
  if (OWN.some((d) => under(abs, d))) return false;
  if (under(abs, REPO)) return false;
  // Inside SOME repository, and not the one this run declared. Outside, wherever it sits, neutral or not.
  const repo = repoRootOf(dirname(abs));
  if (repo !== null) return !isDeclaredRepo(repo);
  return !NEUTRAL.some((d) => under(abs, d));
}

function guard(kind, p) {
  const s = asPath(p);
  if (s === null) return p;
  const abs = isAbsolute(s) ? resolve(s) : resolve(process.cwd(), s);
  if (!outside(abs)) return p;
  record(kind, abs, true);
  const shadowed = join(SHADOW, abs.replace(/^\/+/, ""));
  try {
    realMkdir(shadowed.replace(/\/[^/]*$/, ""), { recursive: true });
  } catch {
    // The redirect target could not be prepared. The record is already written, which is the part that
    // matters; letting the original call proceed to the shadow path and fail is better than throwing here
    // and losing the rest of the run's paths.
  }
  return shadowed;
}

// Entry points whose FIRST argument is the thing written.
//
// THIS LIST AND THE STATIC DETECTOR'S MUST NOT DISAGREE. scripts/outside-write-decl.mjs names the fs entry
// points it considers writes; this file must patch every one of them, or a declared outside-writer using an
// unpatched entry point would touch a sibling under --deep with the observer reporting nothing, which is a
// gate believing itself closed. Six entry points are FD-based (writeSync, write, ftruncateSync, fchmodSync,
// futimesSync, and open's read modes) and are correctly out of scope for the reason asPath already gives: a
// numeric fd is already-open and the open itself was seen. mkdtemp and mkdtempSync take a PATH PREFIX and
// create a directory at it, so they belong here and are included, even though every current caller passes a
// tmpdir() prefix, which outside() treats as neutral anyway.
const TARGET_FIRST = [
  "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "truncateSync",
  "createWriteStream", "openSync", "chmodSync", "utimesSync", "mkdtempSync",
  "writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "truncate", "open", "chmod", "utimes", "mkdtemp",
];
// Entry points whose SECOND argument is the destination (source first).
const TARGET_SECOND = [
  "copyFileSync", "cpSync", "renameSync", "symlinkSync", "linkSync",
  "copyFile", "cp", "rename", "symlink", "link",
];

function patch(mod, name, argIndex, prefix) {
  const orig = mod[name];
  if (typeof orig !== "function") return;
  mod[name] = function patched(...args) {
    // open/openSync are read entry points too. Only a flag carrying w, a or + can write.
    if ((name === "openSync" || name === "open") && typeof args[1] === "string" && !/[wa+]/.test(args[1])) {
      return orig.apply(this, args);
    }
    if (args.length > argIndex) args[argIndex] = guard(prefix + name, args[argIndex]);
    return orig.apply(this, args);
  };
}

for (const n of TARGET_FIRST) {
  patch(fs, n, 0, "");
  patch(fsp, n, 0, "promises.");
}
for (const n of TARGET_SECOND) {
  patch(fs, n, 1, "");
  patch(fsp, n, 1, "promises.");
}

syncBuiltinESMExports();
