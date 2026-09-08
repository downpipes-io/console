// Validate src/lib/shamir.ts: GF(2^8) field axioms and Shamir Secret Sharing over a
// 32-byte (256-bit) wrapping key. Run with `node test/validate-shamir.ts`.
//
// Coverage:
//   GF(2^8) field arithmetic (AES polynomial 0x11b):
//     - exp/log tables are consistent inverses; the full multiplicative group is covered
//     - multiply is commutative; 1 is the identity; 0 annihilates
//     - every non-zero element has an inverse with a * a^-1 == 1
//     - distributivity over XOR addition holds for a sample
//     - a known AES vector: 0x57 * 0x83 == 0xc1
//   Shamir split/combine:
//     - round-trip: EVERY threshold-sized subset of n shares recovers the secret
//       (exhaustive over all C(n,k) subsets), for several (n, threshold) including n=8
//     - a larger-than-threshold subset also recovers
//     - fewer than threshold shares do NOT recover the secret
//     - corrupting a single payload byte in one in-threshold share yields a wrong secret
//     - all 256 byte values appear correctly through a split/combine cycle
//     - share shape: 1 index byte (non-zero, distinct) + 32 payload bytes
//     - input validation rejects bad secret length, threshold < 2, n < threshold, n > 255
//     - combine rejects duplicate indices, zero index and wrong-length shares
//     - the random high coefficients actually vary the shares (probabilistic non-triviality)

import { sha256 } from "@noble/hashes/sha2.js";
import {
  split,
  combine,
  SECRET_BYTES,
  SHARE_BYTES,
  wrappingKeyChecksum,
  verifyWrappingKey,
  WRAPPING_KEY_CHECKSUM_BYTES,
  __testing,
} from "../src/lib/shamir.ts";

const { gfMul, gfInv, gfDiv, GF_EXP, GF_LOG } = __testing;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function throws(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(label, threw);
}
// throwsMsg asserts that fn throws AND that the message contains `needle`. This pins the
// SPECIFIC guard that fired (not just that something downstream threw), so a mutant that
// blanks a message, or that disables one guard and lets a different one throw, is caught.
function throwsMsg(label: string, needle: string, fn: () => unknown): void {
  let msg: string | null = null;
  try {
    fn();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(label, msg?.includes(needle) ?? false);
}
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function randomSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

// Enumerate all k-sized subsets of indices [0, n).
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const idx: number[] = [];
  function rec(start: number): void {
    if (idx.length === k) {
      out.push(idx.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      idx.push(i);
      rec(i + 1);
      idx.pop();
    }
  }
  rec(0);
  return out;
}

// ---- GF(2^8) field axioms ---------------------------------------------------------
console.log("\n-- GF(2^8) field arithmetic (AES poly 0x11b) --");

// The exp table over generator 0x03 must cycle through all 255 non-zero elements exactly
// once before repeating, i.e. 0x03 is primitive. Check log/exp are mutual inverses.
{
  const seen = new Set<number>();
  let consistent = true;
  for (let i = 0; i < 255; i++) {
    const v = GF_EXP[i]!;
    seen.add(v);
    if (GF_LOG[v]! !== i) consistent = false;
  }
  ok("exp table covers all 255 non-zero elements (0x03 is primitive)", seen.size === 255 && !seen.has(0));
  ok("log is the inverse of exp over the multiplicative group", consistent);
}

ok("multiplicative identity: a*1 == a (all a)", (() => {
  for (let a = 0; a < 256; a++) if (gfMul(a, 1) !== a) return false;
  return true;
})());

ok("zero annihilates: a*0 == 0 (all a)", (() => {
  for (let a = 0; a < 256; a++) if (gfMul(a, 0) !== 0 || gfMul(0, a) !== 0) return false;
  return true;
})());

ok("multiplication is commutative (sampled)", (() => {
  for (let a = 0; a < 256; a += 7) for (let b = 0; b < 256; b += 5) if (gfMul(a, b) !== gfMul(b, a)) return false;
  return true;
})());

ok("every non-zero element has an inverse: a * a^-1 == 1", (() => {
  for (let a = 1; a < 256; a++) if (gfMul(a, gfInv(a)) !== 1) return false;
  return true;
})());

ok("division is the inverse of multiplication: (a*b)/b == a (b != 0)", (() => {
  for (let a = 0; a < 256; a += 3) for (let b = 1; b < 256; b += 3) if (gfDiv(gfMul(a, b), b) !== a) return false;
  return true;
})());

ok("distributivity: a*(b XOR c) == (a*b) XOR (a*c) (sampled)", (() => {
  for (let a = 0; a < 256; a += 11) for (let b = 0; b < 256; b += 13) for (let c = 0; c < 256; c += 17) {
    if (gfMul(a, b ^ c) !== (gfMul(a, b) ^ gfMul(a, c))) return false;
  }
  return true;
})());

// Classic AES GF(2^8) vector: 0x57 * 0x83 = 0xc1.
ok("AES vector 0x57 * 0x83 == 0xc1", gfMul(0x57, 0x83) === 0xc1);
ok("gfInv(0) throws", (() => {
  try {
    gfInv(0);
    return false;
  } catch {
    return true;
  }
})());

// The zero-input guards are pinned to their own messages. Without the message text (or with
// the guard removed so a DIFFERENT operation throws) these read the wrong needle and fail:
//   gfInv(0) must report its own "no multiplicative inverse" message, not a downstream one;
//   gfDiv(x, 0) must report its own "division by zero" message. If gfDiv's b===0 guard were
//   dropped it would instead reach gfInv(0) and throw the inverse message, which this rejects.
throwsMsg("gfInv(0) throws its own no-inverse message", "multiplicative inverse", () => gfInv(0));
throwsMsg("gfDiv(x, 0) throws its own division-by-zero message", "division by zero", () => gfDiv(5, 0));

// ---- Shamir round-trip: exhaustive subset recovery --------------------------------
console.log("\n-- Shamir: exhaustive threshold-of-n recovery --");

// Several (n, threshold) shapes, including n up to 8. For each, split a random secret and
// confirm EVERY threshold-sized subset recovers it.
const shapes: Array<[number, number]> = [
  [2, 2],
  [3, 2],
  [5, 3],
  [6, 4],
  [8, 3],
  [8, 5],
  [8, 8],
];
for (const [n, t] of shapes) {
  const secret = randomSecret();
  const shares = split(secret, n, t);
  let allSubsetsOk = true;
  let subsetCount = 0;
  for (const subset of combinations(n, t)) {
    subsetCount++;
    const picked = subset.map((i) => shares[i]!);
    if (!bytesEq(combine(picked), secret)) {
      allSubsetsOk = false;
      break;
    }
  }
  ok(`n=${n} t=${t}: all ${subsetCount} threshold-sized subsets recover the secret`, allSubsetsOk);
}

// A subset LARGER than threshold also recovers (over-determined system is consistent).
{
  const secret = randomSecret();
  const shares = split(secret, 8, 4);
  // Use 6 of the 8 shares (more than the 4 threshold).
  const six = [shares[0]!, shares[2]!, shares[3]!, shares[5]!, shares[6]!, shares[7]!];
  ok("n=8 t=4: a 6-share (>threshold) subset still recovers", bytesEq(combine(six), secret));
}

// ---- Shamir security: fewer than threshold does not recover -----------------------
console.log("\n-- Shamir: below-threshold and corruption do NOT recover --");

// With fewer than the original threshold, combine cannot reproduce the secret. (combine
// interpolates over the points it is given as if they fully determined the polynomial; a
// short set lands on a different constant term.) We assert it does NOT equal the secret.
{
  const secret = randomSecret();
  const shares = split(secret, 6, 4);
  // 3 shares < threshold 4.
  const three = [shares[0]!, shares[1]!, shares[2]!];
  ok("n=6 t=4: 3 shares (below threshold) do NOT recover the secret", !bytesEq(combine(three), secret));
  // 2 shares, even further below.
  const two = [shares[4]!, shares[5]!];
  ok("n=6 t=4: 2 shares (below threshold) do NOT recover the secret", !bytesEq(combine(two), secret));
}

// Corrupting one payload byte in one of the in-threshold shares yields a wrong secret
// (Shamir has no error-correction; a tampered share poisons the result, which is the
// honest behaviour: the operator must supply correct shares).
{
  const secret = randomSecret();
  const shares = split(secret, 5, 3);
  const picked = [shares[0]!, shares[1]!, shares[2]!];
  const corrupted = picked.map((s) => Uint8Array.from(s));
  corrupted[1]![1] = corrupted[1]![1]! ^ 0xff; // flip a payload byte in the second share
  ok("a corrupted in-threshold share yields a WRONG secret", !bytesEq(combine(corrupted), secret));
  // Sanity: the un-corrupted set still recovers, proving the corruption is what broke it.
  ok("the same set un-corrupted recovers (control)", bytesEq(combine(picked), secret));
}

// ---- all 256 byte values survive a split/combine cycle ----------------------------
console.log("\n-- Shamir: all 256 byte values round-trip --");

// Build secrets that, across several splits, cover every byte value 0..255 in every
// position, then confirm each recovers. We tile 0..255 across 32-byte secrets (8 secrets
// cover all 256 values), and recover each with a fresh threshold subset.
{
  let allValuesOk = true;
  const valuesSeen = new Set<number>();
  for (let block = 0; block < 8; block++) {
    const secret = new Uint8Array(SECRET_BYTES);
    for (let i = 0; i < SECRET_BYTES; i++) {
      const v = (block * SECRET_BYTES + i) & 0xff;
      secret[i] = v;
      valuesSeen.add(v);
    }
    const shares = split(secret, 5, 3);
    const recovered = combine([shares[0]!, shares[2]!, shares[4]!]);
    if (!bytesEq(recovered, secret)) {
      allValuesOk = false;
      break;
    }
  }
  ok("all 256 byte values appear across the test secrets", valuesSeen.size === 256);
  ok("every byte value 0..255 round-trips through split/combine", allValuesOk);
}

// Edge secrets: all-zeros and all-0xff.
{
  const zeros = new Uint8Array(SECRET_BYTES); // all 0x00
  const ones = new Uint8Array(SECRET_BYTES).fill(0xff);
  const zShares = split(zeros, 4, 2);
  const oShares = split(ones, 4, 2);
  ok("all-zero secret round-trips", bytesEq(combine([zShares[0]!, zShares[3]!]), zeros));
  ok("all-0xff secret round-trips", bytesEq(combine([oShares[1]!, oShares[2]!]), ones));
}

// ---- share shape --------------------------------------------------------------------
console.log("\n-- Shamir: share shape and index discipline --");
{
  const shares = split(randomSecret(), 8, 4);
  ok("share count equals n", shares.length === 8);
  let shapeOk = true;
  const indices = new Set<number>();
  for (const s of shares) {
    if (s.length !== SHARE_BYTES) shapeOk = false;
    if (s[0]! === 0) shapeOk = false; // index must be non-zero
    indices.add(s[0]!);
  }
  ok(`each share is ${SHARE_BYTES} bytes (1 index + ${SECRET_BYTES} payload)`, shapeOk);
  ok("indices are distinct and non-zero", indices.size === 8 && !indices.has(0));
  ok("SHARE_BYTES == 1 + SECRET_BYTES", SHARE_BYTES === 1 + SECRET_BYTES && SECRET_BYTES === 32);
}

// Randomness non-triviality: two independent splits of the SAME secret produce different
// share payloads (the high coefficients are fresh random each call). Probabilistic but the
// collision probability is ~2^-248 per byte position.
{
  const secret = randomSecret();
  const a = split(secret, 5, 3);
  const b = split(secret, 5, 3);
  // Compare the payload of the share at the same index across the two splits.
  ok("independent splits of the same secret differ (random coefficients)", !bytesEq(a[0]!, b[0]!));
}

// ---- input validation ---------------------------------------------------------------
console.log("\n-- Shamir: input validation --");
throws("split rejects wrong secret length (31 bytes)", () => split(new Uint8Array(31), 5, 3));
throws("split rejects wrong secret length (33 bytes)", () => split(new Uint8Array(33), 5, 3));
throws("split rejects threshold < 2", () => split(randomSecret(), 5, 1));
throws("split rejects n < threshold", () => split(randomSecret(), 3, 4));
throws("split rejects n > 255", () => split(randomSecret(), 256, 2));
throws("split rejects non-integer n", () => split(randomSecret(), 5.5, 3));

// Each split guard is pinned to its own message, so blanking any of these strings is caught.
throwsMsg("split secret-length message names the byte count", `${SECRET_BYTES} bytes`, () => split(new Uint8Array(31), 5, 3));
throwsMsg("split integer message names integers", "must be integers", () => split(randomSecret(), 5.5, 3));
throwsMsg("split threshold message names the floor of 2", "at least 2", () => split(randomSecret(), 5, 1));
throwsMsg("split n<threshold message names the relation", ">= threshold", () => split(randomSecret(), 3, 4));
throwsMsg("split n>255 message names the ceiling", "<= 255", () => split(randomSecret(), 256, 2));

// Boundary: n == 255 is the LARGEST legal share count (indices 1..255). The original accepts
// it; a mutant that turns `n > 255` into `n >= 255` would reject 255, so a successful split at
// exactly 255 shares (each with a distinct non-zero index) kills that off-by-one.
{
  const shares255 = split(randomSecret(), 255, 2);
  const idxs = new Set<number>();
  for (const s of shares255) idxs.add(s[0]!);
  ok("split accepts n == 255 (the largest legal share count)", shares255.length === 255);
  ok("the 255 shares carry 255 distinct non-zero indices", idxs.size === 255 && !idxs.has(0));
}

throws("combine rejects fewer than 2 shares", () => combine([new Uint8Array(SHARE_BYTES).fill(1)]));
throwsMsg("combine too-few message names the floor of 2", "at least 2 shares", () => combine([new Uint8Array(SHARE_BYTES).fill(1)]));
throws("combine rejects wrong-length share", () => {
  const good = split(randomSecret(), 3, 2);
  combine([good[0]!, new Uint8Array(SHARE_BYTES - 1)]);
});
// A wrong-length share with a DISTINCT, NON-ZERO index isolates the length guard: if the guard
// were removed, combine would not throw here (it would interpolate to a wrong secret instead of
// throwing a zero-index/duplicate error), so the length-guard message must be the one that fires.
throwsMsg("combine length guard fires on an over-long, distinct-index share", `${SHARE_BYTES} bytes`, () => {
  const good = split(randomSecret(), 3, 2);
  const tooLong = new Uint8Array(SHARE_BYTES + 1);
  tooLong[0] = 200; // distinct from indices 1..3, non-zero, so only the length guard can fire
  combine([good[0]!, tooLong]);
});
throws("combine rejects a zero index", () => {
  const good = split(randomSecret(), 3, 2);
  const bad = Uint8Array.from(good[1]!);
  bad[0] = 0;
  combine([good[0]!, bad]);
});
throwsMsg("combine zero-index message names the index rule", "zero index", () => {
  const good = split(randomSecret(), 3, 2);
  const bad = Uint8Array.from(good[1]!);
  bad[0] = 0;
  combine([good[0]!, bad]);
});
throws("combine rejects duplicate indices", () => {
  const good = split(randomSecret(), 3, 2);
  const dup = Uint8Array.from(good[0]!); // same index byte as good[0]
  combine([good[0]!, dup]);
});
// The duplicate-index check must throw its OWN message. If the explicit `xs[i] === xs[j]` guard
// were disabled, two equal indices would still throw later via a divide-by-zero in the Lagrange
// denominator (gfDiv on x_i XOR x_j == 0), so pinning "duplicate share index" distinguishes the
// intended guard from that accidental downstream throw. Three shares with one duplicated index
// exercise the inner j-loop beyond its first step as well.
throwsMsg("combine duplicate-index guard fires with its own message", "duplicate share index", () => {
  const good = split(randomSecret(), 4, 3);
  const dup = Uint8Array.from(good[0]!);
  combine([good[0]!, good[1]!, dup]);
});

// ---- wrapping-key integrity checksum -------------------------------------------------
console.log("\n-- Shamir: wrapping-key integrity checksum --");
{
  // combine() is integrity-blind: a bad/short share set yields a wrong key with no signal.
  // The short PUBLIC checksum gives an EARLY, clear "one of your shares is incorrect"
  // outcome before the (authoritative) authenticated decrypt.
  const key = randomSecret();
  const checksum = wrappingKeyChecksum(key);
  // The length is pinned to the literal first. "checksum is the documented length" below reads the
  // checksum's length and compares it to the constant the checksum was cut to, so both sides move
  // together and it cannot fail: at WRAPPING_KEY_CHECKSUM_BYTES = 1 the share checksum falls from
  // 32 bits of collision resistance to 8, one wrong share in 256 verifies as correct, and every
  // assertion in this block still passes. Four bytes is the documented figure, so say four.
  ok("WRAPPING_KEY_CHECKSUM_BYTES is 4 (32 bits of the digest, the documented figure)", WRAPPING_KEY_CHECKSUM_BYTES === 4);
  ok("checksum is the documented length", checksum.length === WRAPPING_KEY_CHECKSUM_BYTES);
  ok("checksum is deterministic for the same key", bytesEq(wrappingKeyChecksum(key), wrappingKeyChecksum(Uint8Array.from(key))));
  ok("verifyWrappingKey accepts the matching key", verifyWrappingKey(key, checksum));

  // A different key (even one bit) does not verify against the checksum.
  const flipped = Uint8Array.from(key);
  flipped[0] = flipped[0]! ^ 0x01;
  ok("a one-bit-different key does not verify", !verifyWrappingKey(flipped, checksum));
  ok("a different key derives a different checksum (overwhelmingly)", !bytesEq(wrappingKeyChecksum(flipped), checksum));

  // The recovery path: split, then a correct threshold subset recombines AND verifies; a
  // single corrupted share recombines to a wrong key that the checksum DETECTS.
  const shares = split(key, 5, 3);
  const good = combine([shares[0]!, shares[2]!, shares[4]!]);
  ok("a correct threshold combine verifies against the checksum", bytesEq(good, key) && verifyWrappingKey(good, checksum));
  const corrupted = shares.map((s) => Uint8Array.from(s));
  corrupted[2]![1] = corrupted[2]![1]! ^ 0xff; // a mis-transcribed share
  const bad = combine([corrupted[0]!, corrupted[2]!, corrupted[4]!]);
  ok("a bad share recombines to a wrong key", !bytesEq(bad, key));
  ok("the checksum detects the bad share (verify is false)", !verifyWrappingKey(bad, checksum));
  // A below-threshold combine is also caught.
  ok("a below-threshold combine fails the checksum", !verifyWrappingKey(combine([shares[0]!, shares[2]!]), checksum));

  // Robustness of the verify boundary: a wrong-length key or wrong-length checksum returns
  // false rather than throwing (a truncated transcription must read as "does not verify").
  ok("verify returns false for a wrong-length key", !verifyWrappingKey(new Uint8Array(SECRET_BYTES - 1), checksum));
  ok("verify returns false for a wrong-length checksum", !verifyWrappingKey(key, checksum.subarray(0, WRAPPING_KEY_CHECKSUM_BYTES - 1)));
  // The expected-length guard must reject an OVER-LONG checksum whose first bytes happen to
  // match. Without that guard the byte loop would compare only the first WRAPPING_KEY_CHECKSUM_BYTES
  // and wrongly verify, so this padded-but-prefix-matching value must read as "does not verify".
  {
    const padded = new Uint8Array(WRAPPING_KEY_CHECKSUM_BYTES + 1);
    padded.set(checksum, 0);
    padded[WRAPPING_KEY_CHECKSUM_BYTES] = 0xab; // trailing junk beyond the real checksum
    ok("verify returns false for an over-long checksum with a matching prefix", !verifyWrappingKey(key, padded));
  }
  // wrappingKeyChecksum guards its input length, with its own byte-count message.
  throws("wrappingKeyChecksum rejects a wrong-length key", () => wrappingKeyChecksum(new Uint8Array(31)));
  throwsMsg("wrappingKeyChecksum length message names the byte count", `${SECRET_BYTES} bytes`, () => wrappingKeyChecksum(new Uint8Array(31)));

  // The checksum DOMAIN is actually bound in: recompute the digest independently with the exact
  // domain label and the key, and confirm it matches. A mutant that blanks the domain label
  // would produce sha256(key) instead of sha256(domain || key), so this reference diverges.
  {
    const domain = new TextEncoder().encode("downpipes:break-glass:wrapping-key-checksum:v1");
    const input = new Uint8Array(domain.length + key.length);
    input.set(domain, 0);
    input.set(key, domain.length);
    const reference = sha256(input).slice(0, WRAPPING_KEY_CHECKSUM_BYTES);
    ok("checksum matches an independent SHA-256(domain || key) reference (domain is bound)", bytesEq(checksum, reference));
    // And the domain genuinely changes the digest: the no-domain variant must differ.
    const noDomain = sha256(key).slice(0, WRAPPING_KEY_CHECKSUM_BYTES);
    ok("dropping the domain label would change the checksum", !bytesEq(checksum, noDomain));
  }
}

// ---- Summary ------------------------------------------------------------------------
console.log(failures === 0 ? "\nSHAMIR VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
