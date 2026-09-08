// Validate src/bytes.ts: b64urlDecode strict-mode rejection and round-trip correctness.
// Run with `node test/validate-bytes.ts`.
//
// Coverage:
//   b64urlDecode strict rejection:
//     - standard base64 '+' character (must throw)
//     - standard base64 '/' character (must throw)
//     - padding '=' character (must throw)
//     - whitespace (space, newline -- must throw, no silent trim)
//     - non-ASCII unicode character (must throw)
//     - non-canonical length (1 mod 4, must throw)
//   b64urlDecode valid decoding:
//     - empty string -> empty Uint8Array
//     - single-byte values (2-char encoding)
//     - two-byte values (3-char encoding)
//     - three-byte values (4-char encoding)
//     - all base64url alphabet characters are accepted ('-', '_')
//   b64urlEncode / b64urlDecode round-trip:
//     - all-zeros, all-ones, random-ish byte sequences
//     - lengths 0 through 5 (covers all mod-3 remainders)

import { b64urlEncode, b64urlDecode } from "../src/bytes.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// throwsWhich asserts WHICH refusal, not merely that one happened. It REPLACES a `throws` helper that set
// a flag on any exception; nothing in this file asserts a bare throw any more, so the weaker helper is
// gone rather than left available to be reached for. b64urlDecode has four guards and they
// are ordered: the 1-mod-4 length check runs before a single character is inspected, so a fixture whose
// length is 1 mod 4 is refused for its length no matter what characters it holds. `throws` alone cannot
// tell the two apart, and four fixtures in this file were sitting under section headers naming a guard
// they never reached (see the padding and whitespace sections below). The needle is the fault-class clause
// of the message; bytes.ts deliberately puts nothing else in there, so pinning it pins the branch.
function throwsWhich(label: string, fn: () => unknown, faultClause: string): void {
  let msg: string | null = null;
  try { fn(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  if (msg === null) { ok(`${label} [did not throw at all]`, false); return; }
  ok(`${label} [refused for: ${faultClause}]`, msg.includes(faultClause));
}

// The four fault clauses b64urlDecode can raise, spelled once so a drifting message fails loudly here
// rather than quietly turning every throwsWhich below into a check that nothing matches.
const FAULT_LENGTH = "is not a whole number of encoded bytes";
const FAULT_PADDING = "carries standard-base64 padding";
const FAULT_ALPHABET = "contains a character outside the base64url alphabet";
const FAULT_NON_ASCII = "contains a non-ASCII character";

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- strict rejection: standard base64 '+' and '/' -----------------------
// Go RawURLEncoding rejects '+' and '/' (those are the standard base64 chars,
// not the URL-safe variants '-' and '_').
console.log("\n-- b64urlDecode: reject non-url-safe base64 characters --");
throwsWhich("'+' is rejected (standard base64, not url-safe)", () => b64urlDecode("AB+D"), FAULT_ALPHABET);
throwsWhich("'/' is rejected (standard base64, not url-safe)", () => b64urlDecode("AB/D"), FAULT_ALPHABET);

// ---- strict rejection: padding '=' ----------------------------------------
console.log("\n-- b64urlDecode: reject padding --");
throwsWhich("'=' padding is rejected (single trailing pad)", () => b64urlDecode("YQ=="), FAULT_PADDING);
throwsWhich("'=' padding is rejected (double trailing pad)", () => b64urlDecode("YWI="), FAULT_PADDING);
// A lone '=' is length 1, which is 1 mod 4, so the length guard refuses it BEFORE the padding guard is
// reached. That is correct behaviour and worth keeping as a case, but it does not prove anything about
// padding, and until the class was pinned this line sat under this header claiming that it did. The two
// lines above are what prove the padding guard, because both are length 4 and reach it.
throwsWhich("bare '=' is refused on length before padding is ever considered", () => b64urlDecode("="), FAULT_LENGTH);
// An '=' that is NOT trailing and DOES reach the guard, so the padding branch is proven for an interior
// pad as well as a trailing one.
throwsWhich("an interior '=' is rejected as padding, not as an unknown character", () => b64urlDecode("YQ=Q"), FAULT_PADDING);

// ---- strict rejection: whitespace -----------------------------------------
// The old lenient implementation silently trimmed leading/trailing whitespace.
// The strict implementation must reject it.
//
// EVERY FIXTURE HERE IS LENGTH 4, and three of them were not. "YQ YQ", "YQ\nYQ" and "YQ\tYQ" are length 5,
// which is 1 mod 4, so all three were refused by the length guard and never reached the alphabet guard this
// section is about. They were duplicates of the length section below wearing this section's label, and
// newline and tab were therefore not proven as CHARACTERS anywhere in the suite: had someone taught the LUT
// to tolerate whitespace, these three would have stayed green while "YQ\nY" decoded silently on the
// break-glass paste path. The space cases at length 3 did reach the guard and are pinned rather than moved.
console.log("\n-- b64urlDecode: reject whitespace --");
throwsWhich("leading space is rejected", () => b64urlDecode(" YQ"), FAULT_ALPHABET);
throwsWhich("trailing space is rejected", () => b64urlDecode("YQ "), FAULT_ALPHABET);
throwsWhich("embedded space is rejected as a character, at a length the alphabet guard reaches", () => b64urlDecode("YQ Q"), FAULT_ALPHABET);
throwsWhich("newline is rejected as a character, at a length the alphabet guard reaches", () => b64urlDecode("YQ\nQ"), FAULT_ALPHABET);
throwsWhich("tab is rejected as a character, at a length the alphabet guard reaches", () => b64urlDecode("YQ\tQ"), FAULT_ALPHABET);
// The 1-mod-4 forms are kept, because a pasted share really can arrive that way, but they are now labelled
// with the guard that actually refuses them instead of the one above them.
throwsWhich("a 5-character embedded-space paste is refused on length", () => b64urlDecode("YQ YQ"), FAULT_LENGTH);
throwsWhich("a 5-character embedded-newline paste is refused on length", () => b64urlDecode("YQ\nYQ"), FAULT_LENGTH);
throwsWhich("a 5-character embedded-tab paste is refused on length", () => b64urlDecode("YQ\tYQ"), FAULT_LENGTH);

// ---- strict rejection: non-ASCII ------------------------------------------
console.log("\n-- b64urlDecode: reject non-ASCII --");
throwsWhich("non-ASCII Unicode character is rejected", () => b64urlDecode("YQé"), FAULT_NON_ASCII);
throwsWhich("emoji is rejected", () => b64urlDecode("YQ😀"), FAULT_NON_ASCII);
// A smart quote is what an email client does to a share in transit, and it is the case the source comment
// names. Length 4, so it reaches the non-ASCII guard rather than the length guard.
throwsWhich("a smart quote is rejected as non-ASCII, not as an unknown ASCII character", () => b64urlDecode("YQ“Q"), FAULT_NON_ASCII);

// ---- strict rejection: non-canonical length (1 mod 4) ---------------------
// A string whose length is 1 mod 4 cannot be the output of any valid
// base64url-no-pad encoding (0 mod 4 -> n bytes, 2 mod 4 -> n+1 bytes,
// 3 mod 4 -> n+2 bytes; 1 mod 4 is impossible).
console.log("\n-- b64urlDecode: reject non-canonical length (1 mod 4) --");
throwsWhich("length 1 is rejected (1 mod 4)", () => b64urlDecode("Y"), FAULT_LENGTH);
throwsWhich("length 5 is rejected (5 mod 4 = 1)", () => b64urlDecode("YWJjY"), FAULT_LENGTH);
throwsWhich("length 9 is rejected (9 mod 4 = 1)", () => b64urlDecode("YWJjYWJjY"), FAULT_LENGTH);

// ---- valid decoding: empty string -----------------------------------------
console.log("\n-- b64urlDecode: valid inputs --");
const empty = b64urlDecode("");
ok("empty string decodes to zero-length Uint8Array", empty.length === 0);

// ---- valid decoding: single byte (2-char encoding) -------------------------
// 0x00 -> "AA"; 0xFF -> "_w" (url-safe); 0x41 = 'A' -> "QQ"
const zeroBytes = b64urlDecode("AA");
ok("'AA' decodes to [0x00]", zeroBytes.length === 1 && zeroBytes[0] === 0x00);

const ffByte = b64urlDecode("_w");
ok("'_w' decodes to [0xFF] (uses '_' url-safe char)", ffByte.length === 1 && ffByte[0] === 0xff);

// ---- valid decoding: two bytes (3-char encoding) ---------------------------
// [0x00, 0x00] -> "AAA"; [0xFF, 0xFF] -> "__8"
const twoZero = b64urlDecode("AAA");
ok("'AAA' decodes to [0x00, 0x00]", twoZero.length === 2 && twoZero[0] === 0x00 && twoZero[1] === 0x00);

const twoFF = b64urlDecode("__8");
ok("'__8' decodes to [0xFF, 0xFF] (uses '_' url-safe char)", twoFF.length === 2 && twoFF[0] === 0xff && twoFF[1] === 0xff);

// ---- valid decoding: three bytes (4-char encoding) -------------------------
// [0xFB, 0xFF, 0xFF] encodes to "-___" in base64url (uses '-' and '_')
const threeMinus = b64urlDecode("-___");
ok("'-___' decodes to [0xFB, 0xFF, 0xFF] (uses '-' and '_' url-safe chars)", threeMinus.length === 3 && threeMinus[0] === 0xfb && threeMinus[1] === 0xff && threeMinus[2] === 0xff);

// ---- round-trip: lengths 0-5 (covers all mod-3 remainders) ----------------
console.log("\n-- b64urlDecode: encode->decode round-trips --");

for (let len = 0; len <= 5; len++) {
  const data = new Uint8Array(len);
  for (let i = 0; i < len; i++) data[i] = (i * 73 + 17) & 0xff;
  const encoded = b64urlEncode(data);
  const decoded = b64urlDecode(encoded);
  ok(`round-trip: length ${len} (all mod-3 remainders covered)`, bytesEq(decoded, data));
  // Encoded output must not contain '=', '+', '/', or whitespace.
  ok(`round-trip length ${len}: encoded contains no forbidden chars`, !/[=+/\s]/.test(encoded));
}

// ---- round-trip: known Go-compatible vectors --------------------------------
// These match what Go base64.RawURLEncoding.EncodeToString produces.
console.log("\n-- b64urlDecode: Go RawURLEncoding compatibility vectors --");

// [0x00] -> "AA"
ok("Go vector [0x00] -> 'AA'", b64urlEncode(new Uint8Array([0x00])) === "AA");
ok("Go vector 'AA' -> [0x00]", b64urlDecode("AA")[0] === 0x00 && b64urlDecode("AA").length === 1);

// [0x00, 0x00, 0x00] -> "AAAA"
ok("Go vector [0,0,0] -> 'AAAA'", b64urlEncode(new Uint8Array([0, 0, 0])) === "AAAA");
ok("Go vector 'AAAA' -> [0,0,0]", bytesEq(b64urlDecode("AAAA"), new Uint8Array([0, 0, 0])));

// [0xFB, 0xFF, 0xFF] -> "-___" (url-safe chars at both special positions)
ok("Go vector [0xFB,0xFF,0xFF] -> '-___'", b64urlEncode(new Uint8Array([0xfb, 0xff, 0xff])) === "-___");
ok("Go vector '-___' -> [0xFB,0xFF,0xFF]", bytesEq(b64urlDecode("-___"), new Uint8Array([0xfb, 0xff, 0xff])));

// [0xFB, 0xFF, 0xFB] encodes to "-__-" -- exercises both '-' (index 62) and '_' (index 63)
// in a 4-char block, confirming the url-safe alphabet positions are handled correctly.
const vecData = new Uint8Array([0xfb, 0xff, 0xfb]);
const vecEncoded = b64urlEncode(vecData);
ok("encoding [0xFB,0xFF,0xFB] uses url-safe chars (contains '-' and '_')", vecEncoded.includes("-") && vecEncoded.includes("_"));
ok("Go vector [0xFB,0xFF,0xFB] round-trips cleanly", bytesEq(b64urlDecode(vecEncoded), vecData));

// ---- Summary ----------------------------------------------------------------
console.log(failures === 0 ? "\nBYTES VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
