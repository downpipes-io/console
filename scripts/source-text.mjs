// Comment blanking for the console's source-text gates.
//
// WHY THIS EXISTS. A gate that identifies a code construct by matching the RAW file text will match the same
// shape wherever it appears, and prose is where it appears most. Two shapes of that class are possible in
// this repo, both satisfiable by a comment rather than by code:
//
//   scripts/key-material-wipe-gate.mjs  replacing the only `master.fill(0);` in restore-flow/attend.ts with
//     `// master.fill(0);` would leave the gate printing KEY-MATERIAL-WIPE PASS and exiting 0. That gate now
//     parses with TypeScript instead, which is the better answer where an AST is affordable.
//   scripts/sibling-read-gate.mjs  a file hardcoding `../../engine` could be exempted by the single line
//     `// we should really use the shared engine-root resolver here one day`: exit 1 without that comment,
//     exit 0 with it, the offending path unchanged.
//
// COMMENTS ONLY, DELIBERATELY. Several console gates read things that legitimately live INSIDE string
// literals: an import specifier, a hardcoded sibling path, a CSP origin, a doc URL. Blanking strings as well
// would blind those gates to the very thing they police, so this blanks comments and leaves strings intact.
// A gate that must also ignore string contents should parse (scripts/field-census.mjs and
// scripts/hook-lib.mjs both take that route with the typescript devDependency already present).
//
// BLANKED, NOT REMOVED. Every comment byte becomes a space and every newline is kept, so the result has the
// same length and the same line breaks as the original: an offset or a line number taken from the blanked
// text still points at the same place in the file.
//
// QUOTE AND TEMPLATE AWARE, because a `//` inside a URL string and a `/*` inside a regex literal are not
// comments. Ported from the harness's scripts/lib/spec-scan.mjs, which has carried this rule since a plain
// grep counted prose as code there.
//
import { isEntryModule } from "./entry-module.mjs";

/** Every comment byte replaced by a space, newlines and offsets preserved. Pure. */
export function blankComments(src) {
  const out = [...src];
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        // A single- or double-quoted string cannot span a newline; a template can.
        if (quote !== "`" && src[i] === "\n") break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    i++;
  }
  return out.join("");
}

export function selfTest() {
  let held = 0;
  let broke = 0;
  const expect = (label, got, want) => {
    if (got === want) {
      held++;
      console.log(`PASS  ${label}`);
      return;
    }
    broke++;
    console.log(`FAIL  ${label}  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`);
  };

  expect("a line comment is gone", blankComments('a();\n// engine-root\n').includes("engine-root"), false);
  expect("a block comment is gone", blankComments("a();\n/* engine-root */\n").includes("engine-root"), false);
  expect("a trailing comment is gone", blankComments('a(); // engine-root\n').includes("engine-root"), false);
  expect("but the code beside it survives", blankComments('a(); // engine-root\n').includes("a();"), true);
  expect("a string survives, because gates read paths out of strings", blankComments('const p = "../../engine";\n').includes("../../engine"), true);
  expect("a // inside a string is not a comment", blankComments('const u = "https://x/y"; keep();\n').includes("keep();"), true);
  expect("a /* inside a string is not a comment", blankComments('const r = "/*"; keep();\n').includes("keep();"), true);
  expect("a template literal survives", blankComments("const t = `a // b`; keep();\n").includes("a // b"), true);
  expect("length is preserved", blankComments("a(); // x\n").length, "a(); // x\n".length);
  expect("line count is preserved across a multi-line comment", blankComments("a();\n/* x\ny */\nb();\n").split("\n").length, 5);
  expect("an unterminated block comment eats the rest", blankComments("a();\n/* x\n").includes("x"), false);

  console.log(`\nsource-text self-test: ${held} of ${held + broke} assertions held.`);
  return broke === 0 ? 0 : 1;
}

// ENTRY-ONLY, and that qualifier is the whole point of this line. Gating on
// `process.argv.includes("--self-test")` fires whenever the flag appears in argv at all, including when
// this module is merely IMPORTED by a gate the operator ran with --self-test: because it runs at import
// time and calls process.exit, the importing gate would die here before its own self-test block executes,
// and the process would exit 0 on THIS module's assertions alone, so the log would read like a pass.
//
// Gating on "am I the entry module" instead removes that trap for every importer, present and future,
// including sibling-read-gate.mjs and custody-claim-parity-gate.mjs, which are one added flag away from
// it: run this file directly and its self-test runs; import it and it stays a library, whatever flags the
// entry script was given.
//
// THE TEST ITSELF NEEDS A REALPATH, and not for tidiness. Comparing import.meta.url against
// pathToFileURL(process.argv[1]) directly is not enough, because Node resolves import.meta.url through
// symlinks while argv[1] keeps whatever the operator typed: run through a symlink, this file would print
// nothing and exit 0 where a direct invocation prints eleven assertions. scripts/entry-module.mjs holds the
// rule, its realpath, and a gate that keeps every argv-driven exit in this repo asking it.
if (isEntryModule(import.meta.url) && process.argv.includes("--self-test")) process.exit(selfTest());
