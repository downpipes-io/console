// The console's file pickers refuse an oversized file BEFORE a FileReader is constructed.
//
// WHY THIS EXISTS. Every file picker in the console (identity.key, share files, identity.key.enc) reads the
// selected file whole with FileReader.readAsText and only then hands the text to a parser. The parsers bound
// what they accept (96 decoded bytes for an identity, the labelled lines of a share or envelope), but nothing
// bounded what was READ, so the documented maximum for those pickers was a figure with no control behind it.
// src/lib/file-size-guard.ts is that control, and this proves the property the file-handling policy states:
// a file above CONSOLE_FILE_MAX_BYTES is refused with no FileReader ever created, and a file at the ceiling
// is read.
//
// The FileReader here is a spy, not a shim of the browser's: the assertion is about whether it was
// constructed at all, which is the whole claim.
//
// Run with `node test/validate-file-size-guard.ts`.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let constructed = 0;
let readCalls = 0;
class SpyFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  constructor() {
    constructed++;
  }
  readAsText(file: { _text?: string }): void {
    readCalls++;
    this.result = file._text ?? "";
    setTimeout(() => this.onload?.(), 0);
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = SpyFileReader;

const { CONSOLE_FILE_MAX_BYTES, oversizedFileReason, readTextFileBounded } = await import("../src/lib/file-size-guard.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function fileOf(size: number, text = "downpipe-identity-v1 AAAA"): File {
  return { size, name: "identity.key", type: "text/plain", _text: text } as unknown as File;
}

console.log("\n-- the console file-size guard --\n");

ok("the ceiling is 64 KiB, the figure the file-handling policy documents", CONSOLE_FILE_MAX_BYTES === 65536);

// ---- the pure predicate --------------------------------------------------------------------------------
ok("a file at the ceiling is not refused", oversizedFileReason({ size: CONSOLE_FILE_MAX_BYTES }) === null);
ok("a file one byte over the ceiling is refused", oversizedFileReason({ size: CONSOLE_FILE_MAX_BYTES + 1 }) !== null);
const reason = oversizedFileReason({ size: CONSOLE_FILE_MAX_BYTES + 1 }) ?? "";
ok("the refusal names the byte count and the ceiling", reason.includes(`${CONSOLE_FILE_MAX_BYTES + 1} bytes`) && reason.includes(`${CONSOLE_FILE_MAX_BYTES}-byte limit`));
ok("the refusal says the file was not read", reason.includes("was not read"));
ok("a File-like value with no measurable size is let through to the parser rather than refused", oversizedFileReason({}) === null);

// ---- the read path: refused BEFORE a FileReader exists -------------------------------------------------
constructed = 0;
readCalls = 0;
let rejected: unknown = null;
try {
  await readTextFileBounded(fileOf(CONSOLE_FILE_MAX_BYTES + 1));
} catch (e) {
  rejected = e;
}
ok("an oversized file rejects", rejected instanceof Error);
ok("and no FileReader was constructed for it", constructed === 0);
ok("and readAsText was never called", readCalls === 0);
ok("the rejection carries the refusal reason", rejected instanceof Error && rejected.message.includes("was not read"));

// ---- the read path: a file at the ceiling is read ------------------------------------------------------
constructed = 0;
readCalls = 0;
const text = await readTextFileBounded(fileOf(CONSOLE_FILE_MAX_BYTES, "downpipe-identity-v1 QUJD"));
ok("a file at the ceiling is read through one FileReader", constructed === 1 && readCalls === 1);
ok("and its text comes back verbatim", text === "downpipe-identity-v1 QUJD");

// ---- the read path: a browser read failure is reported, not swallowed ----------------------------------
class FailingFileReader extends SpyFileReader {
  override readAsText(): void {
    setTimeout(() => this.onerror?.(), 0);
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = FailingFileReader;
let readFailure: unknown = null;
try {
  await readTextFileBounded(fileOf(10));
} catch (e) {
  readFailure = e;
}
ok("a read the browser fails rejects with the read failure", readFailure instanceof Error && readFailure.message === "could not read that file");

console.log(`\n${failures === 0 ? "FILE-SIZE-GUARD PASS" : `FILE-SIZE-GUARD: ${failures} FAILED`}\n`);
verdictReached(failures);
process.exit(failures === 0 ? 0 : 1);
