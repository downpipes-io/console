// Reading one file's write posture out of its own text. Pure, and separate from the gate that applies it.
//
// FS-WRITES: none outside this repo
//
// WHY IT IS ITS OWN FILE. outside-write-gate.mjs is an entry script: it scans the tree and calls
// process.exit at the end. Importing it to reach the parser runs the whole gate and exits the importing
// process, so a caller that does that reports a clean run having executed none of its own checks. That is
// the same failure the gate exists to catch, in the instrument rather than in the subject: a green report
// over nothing observed. A pure module cannot do it, because there is nothing in here to run.

import { blankComments } from "./source-text.mjs";

// The write entry points, matched against source with comments blanked so naming one in prose is not a
// declaration trigger.
//
// TWO CLASSES, AND THE REASON THEY ARE NOT ONE LIST. A regex matching only the *Sync names misses the
// promise API entirely: the observer patches node:fs/promises as well, so a script written as
//     import { writeFile } from "node:fs/promises";
//     await writeFile(siblingPath, s);
// calls a write, declares nothing, and the gate stays green. A guard that only recognises one shape of
// write is a list with a gap in it, so the promise API is covered here too.
//
// It cannot be covered by adding those names to the same regex. "open", "rm", "cp", "link" and "write" are
// ordinary English and ordinary local identifiers, and a bare match on them would fire on prose-free code
// that has nothing to do with the filesystem. So the names split by whether the name alone is evidence:
//   UNAMBIGUOUS  exists only as an fs entry point, so a bare call is enough
//   BOUND        counts only when the file imports it FROM node:fs or node:fs/promises, which also picks
//                up `import { writeFile as wf }` and `fsp.writeFile(...)` that a name-only match misses
const UNAMBIGUOUS = [
  "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "truncateSync",
  "createWriteStream", "mkdtempSync", "copyFileSync", "cpSync", "renameSync", "symlinkSync", "linkSync",
  "openSync", "writeSync", "ftruncateSync", "fchmodSync", "futimesSync",
];
const BOUND = [
  "writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "truncate", "open", "copyFile", "cp",
  "rename", "symlink", "link", "mkdtemp", "write", "chmod", "utimes",
];
const WRITE_NAMES = new Set([...UNAMBIGUOUS, ...BOUND]);
const UNAMBIGUOUS_CALL = new RegExp(String.raw`\b(${UNAMBIGUOUS.join("|")})\s*\(`);
const FS_SPECIFIER = /^(node:)?fs(\/promises)?$/;
const IMPORT_FROM = /import\s+([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
const REQUIRE_OF = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;

/** Local names this file has bound to an fs write entry point, and to an fs module as a whole. */
function fsBindings(body) {
  const named = new Set();
  const namespaces = new Set();
  const take = (clause) => {
    const brace = clause.indexOf("{");
    const head = (brace === -1 ? clause : clause.slice(0, brace)).replace(/,\s*$/, "").trim();
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(head);
    if (ns !== null) namespaces.add(ns[1]);
    else if (/^[A-Za-z_$][\w$]*$/.test(head)) namespaces.add(head);
    if (brace === -1) return;
    for (const part of clause.slice(brace + 1, clause.lastIndexOf("}")).split(",")) {
      const t = part.trim();
      if (t.length === 0) continue;
      const as = /^([A-Za-z_$][\w$]*)\s*(?::|\bas\b)\s*([A-Za-z_$][\w$]*)$/.exec(t);
      const original = as === null ? t : as[1];
      const local = as === null ? t : as[2];
      if (WRITE_NAMES.has(original)) named.add(local);
    }
  };
  for (const m of body.matchAll(IMPORT_FROM)) if (FS_SPECIFIER.test(m[2])) take(m[1]);
  for (const m of body.matchAll(REQUIRE_OF)) if (FS_SPECIFIER.test(m[2])) take(m[1]);
  return { named, namespaces };
}

/** True when this source calls a filesystem write entry point. Comments are already blanked. */
function callsWrite(body) {
  if (UNAMBIGUOUS_CALL.test(body)) return true;
  const { named, namespaces } = fsBindings(body);
  for (const n of named) if (new RegExp(String.raw`\b${n}\s*\(`).test(body)) return true;
  // fsp.writeFile(...) and fs.promises.writeFile(...): the member name is ambiguous on its own, the
  // namespace it hangs off is not.
  for (const ns of namespaces) {
    const member = new RegExp(String.raw`\b${ns}\s*\.\s*(?:promises\s*\.\s*)?(${[...WRITE_NAMES].join("|")})\s*\(`);
    if (member.test(body)) return true;
  }
  return false;
}

const DECL = /^[ \t]*\/\/[ \t]*FS-WRITES:[ \t]*(.+?)[ \t]*$/gm;
// A path reachable only under an extra flag, declared for the caller and NOT driven by --deep. It exists
// for one real case: functional-census.mjs --seed also writes action-catalogue.jsonl, and --seed refuses
// without the harness journey corpus, so driving it here would turn a checkout without harness into a red
// gate over a script that is fine. The reason is recorded beside the path, which is where a caller looks.
const DECL_ALSO = /^[ \t]*\/\/[ \t]*FS-WRITES-ALSO:[ \t]*(.+?)[ \t]*$/gm;
const RUN_ARGS = /^[ \t]*\/\/[ \t]*FS-WRITES-RUN:[ \t]*(.+?)[ \t]*$/m;
const NONE = "none outside this repo";

/**
 * The two facts this gate needs about one file, derived from its text alone.
 *
 * Exported and pure so --self-test can drive it over synthetic sources rather than over files on disk. A
 * self-test that has to write a probe file into the tree it is grading would be the very thing this gate
 * exists to stop.
 */
export function readDeclaration(source) {
  const body = blankComments(source);
  const writes = callsWrite(body);
  const declared = [];
  let none = false;
  for (const m of source.matchAll(DECL)) {
    if (m[1] === NONE) none = true;
    else declared.push(m[1]);
  }
  const alsoDeclared = [...source.matchAll(DECL_ALSO)].map((m) => m[1]);
  const hasDecl = none || declared.length > 0;
  return { writes, hasDecl, none, declared, alsoDeclared, runArgs: (RUN_ARGS.exec(source)?.[1] ?? "").trim() };
}

/** The posture line a file uses when nothing it writes leaves this checkout. */
export const NONE_POSTURE = NONE;
