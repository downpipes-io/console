// Shamir Secret Sharing over GF(2^8), for the offline break-glass custody experience
// (ENTERPRISE-UX-BLUEPRINT section 7.3, Tier 3). It splits a 32-byte (256-bit) AES
// WRAPPING key M-of-N among custodians; it is NEVER used on the 96-byte break-glass
// identity itself (x25519 scalar(32) || ML-KEM seed(64), src/keygen.ts:17, parsed by
// the engine's crypto/keys.ts parseIdentity as exactly 96 bytes) (SLIP-0039 and most
// Shamir tooling target 128-512-bit secrets, and a 96-byte secret would produce
// unusable shares). The envelope (src/envelope.ts) AES-256-GCM encrypts the
// identity.key with the wrapping key; only this small wrapping key is split.
//
// NO-CUSTODY: every byte here is produced in the operator's browser from
// crypto.getRandomValues and is only ever offered as a download. No share, coefficient,
// secret or wrapping key is transmitted, logged or POSTed anywhere.
//
// The field is GF(2^8) with the AES reduction polynomial x^8 + x^4 + x^3 + x + 1
// (0x11b), the same field AES uses, so the arithmetic is well-understood and testable.
// We use Lagrange interpolation at x = 0 to recover the secret: each secret byte is the
// constant term f(0) of a degree (threshold-1) polynomial whose other coefficients are
// uniformly random, so any (threshold-1) shares leak nothing about the secret.

import { randomBytes } from "../bytes.ts";
import { sha256 } from "@noble/hashes/sha2.js";

// SECRET_BYTES is the wrapping-key length this module is built for: 32 bytes = 256 bits.
export const SECRET_BYTES = 32;

// A share is a 1-byte non-zero index (the x-coordinate, distinct per share) followed by
// SECRET_BYTES payload bytes (the y-coordinates, one per secret byte). 33 bytes total for
// a 32-byte secret.
export const SHARE_BYTES = 1 + SECRET_BYTES;

// ---- GF(2^8) arithmetic with the AES polynomial 0x11b -----------------------------
//
// Addition and subtraction in GF(2^8) are both XOR. Multiplication is carry-less
// (Russian-peasant) multiplication reduced modulo 0x11b. We precompute exp/log tables
// over the generator 0x03 (a primitive element of this field) so multiply, inverse and
// division are constant-table lookups, which is both fast and easy to reason about.

const GF_EXP = new Uint8Array(512); // antilog: GF_EXP[i] = 0x03^i (period 255, doubled so a+b<510 never wraps)
const GF_LOG = new Uint8Array(256); // log base 0x03; GF_LOG[0] is unused (log of 0 is undefined)

(function buildTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // Multiply x by the generator 0x03 = (x * 2) XOR x, reducing by 0x11b on overflow.
    const next = x ^ gfXtime(x);
    x = next & 0xff;
  }
  // Double the exp table so we can add two logs (each < 255) without a modulo.
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

// gfXtime multiplies a field element by x (i.e. by 0x02), reducing modulo 0x11b.
function gfXtime(a: number): number {
  const shifted = a << 1;
  // If bit 8 set after the shift, the result overflowed GF(2^8); reduce by XOR 0x11b.
  return (shifted ^ (shifted & 0x100 ? 0x11b : 0)) & 0xff;
}

// gfMul multiplies two field elements via the log/exp tables. 0 times anything is 0.
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

// gfInv returns the multiplicative inverse of a non-zero field element.
function gfInv(a: number): number {
  if (a === 0) throw new Error("gfInv: 0 has no multiplicative inverse in GF(2^8)");
  // a^-1 = 0x03^(255 - log(a)).
  return GF_EXP[255 - GF_LOG[a]!]!;
}

// gfDiv divides a by b (b must be non-zero).
function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("gfDiv: division by zero in GF(2^8)");
  if (a === 0) return 0;
  return gfMul(a, gfInv(b));
}

// ---- polynomial evaluation --------------------------------------------------------

// gfEval evaluates a polynomial (given low-degree-first coefficients in GF(2^8)) at x,
// using Horner's method. coeffs[0] is the constant term (the secret byte).
function gfEval(coeffs: Uint8Array, x: number): number {
  let acc = 0;
  // Horner: walk from the highest-degree coefficient down so each step is acc*x + c.
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = gfMul(acc, x) ^ coeffs[i]!;
  }
  return acc;
}

// ---- public API -------------------------------------------------------------------

// split divides a SECRET_BYTES-long secret into n shares such that any `threshold` of
// them recover the secret and any fewer reveal nothing. Each returned share is
// SHARE_BYTES long: a distinct non-zero index byte followed by SECRET_BYTES y-bytes.
//
// Constraints (all enforced):
//   - secret.length must equal SECRET_BYTES (32);
//   - 2 <= threshold <= n <= 255 (indices are non-zero bytes 1..255, and a threshold of
//     1 would mean any single share is the secret, which Shamir does not permit here).
export function split(secret: Uint8Array, n: number, threshold: number): Uint8Array[] {
  if (secret.length !== SECRET_BYTES) {
    throw new Error(`split: secret must be ${SECRET_BYTES} bytes, got ${secret.length}`);
  }
  if (!Number.isInteger(n) || !Number.isInteger(threshold)) {
    throw new Error("split: n and threshold must be integers");
  }
  if (threshold < 2) throw new Error("split: threshold must be at least 2");
  if (n < threshold) throw new Error("split: n must be >= threshold");
  if (n > 255) throw new Error("split: n must be <= 255 (one non-zero index byte per share)");

  // The x-coordinates are 1..n (never 0; f(0) is the secret). Distinct and non-zero.
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = i + 1;

  const shares: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Uint8Array(SHARE_BYTES);
    s[0] = indices[i]!;
    shares.push(s);
  }

  // For each byte of the secret, build an independent degree-(threshold-1) polynomial:
  // constant term = the secret byte, the other (threshold-1) coefficients uniformly
  // random. Evaluate it at every share's index to fill that byte's slot.
  const coeffs = new Uint8Array(threshold);
  for (let b = 0; b < SECRET_BYTES; b++) {
    coeffs[0] = secret[b]!;
    // Fresh cryptographic randomness for the high coefficients of THIS byte's polynomial.
    const rnd = randomBytes(threshold - 1);
    for (let c = 1; c < threshold; c++) coeffs[c] = rnd[c - 1]!;
    for (let i = 0; i < n; i++) {
      shares[i]![1 + b] = gfEval(coeffs, indices[i]!);
    }
  }

  return shares;
}

// combine recovers the secret from a set of shares using Lagrange interpolation at x = 0.
// It needs at least `threshold` distinct valid shares; with fewer than the original
// threshold it returns a wrong value (it cannot know the threshold and does not pretend
// to), which is exactly the Shamir security property the validator asserts.
//
// It enforces structural validity strictly: every share is SHARE_BYTES long, every index
// is a non-zero byte, and indices are distinct (a repeated x makes interpolation singular).
//
// IMPORTANT (integrity): combine is threshold-unaware and has NO error detection of its
// own. A single bad or mis-transcribed share, or fewer than the original threshold of
// shares, silently yields a WRONG secret. Callers MUST verify the reconstructed wrapping
// key before trusting it: either against the public checksum this module emits
// (wrappingKeyChecksum / verifyWrappingKey, for an early, clear "one of your shares is
// incorrect" outcome) or, authoritatively, by attempting the authenticated AES-256-GCM
// envelope decrypt (src/envelope.ts decrypt throws on a wrong key). Never use a combine()
// result without one of those checks.
export function combine(shares: Uint8Array[]): Uint8Array {
  if (shares.length < 2) {
    throw new Error("combine: need at least 2 shares");
  }
  const xs = new Uint8Array(shares.length);
  for (let i = 0; i < shares.length; i++) {
    const sh = shares[i]!;
    if (sh.length !== SHARE_BYTES) {
      throw new Error(`combine: share ${i} must be ${SHARE_BYTES} bytes, got ${sh.length}`);
    }
    const x = sh[0]!;
    if (x === 0) throw new Error(`combine: share ${i} has a zero index (indices must be 1..255)`);
    xs[i] = x;
  }
  // Reject duplicate x-coordinates: two points at the same x cannot lie on one polynomial
  // and would make a Lagrange basis term divide by zero.
  const seen = new Set<number>();
  for (const x of xs) {
    if (seen.has(x)) throw new Error(`combine: duplicate share index ${x}`);
    seen.add(x);
  }

  const out = new Uint8Array(SECRET_BYTES);
  // Precompute the Lagrange basis weights L_i(0) for each share i. For interpolation at
  // x = 0: L_i(0) = product over j != i of (x_j) / (x_j XOR x_i) (subtraction is XOR).
  // These weights depend only on the x-coordinates, so they are shared across all bytes.
  const weights = new Uint8Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    let num = 1; // product of x_j
    let den = 1; // product of (x_j - x_i) = (x_j XOR x_i)
    for (let j = 0; j < xs.length; j++) {
      if (j === i) continue;
      num = gfMul(num, xs[j]!);
      den = gfMul(den, xs[i]! ^ xs[j]!);
    }
    weights[i] = gfDiv(num, den);
  }

  // Each secret byte is the sum over shares of y_i * L_i(0).
  for (let b = 0; b < SECRET_BYTES; b++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      acc ^= gfMul(shares[i]![1 + b]!, weights[i]!);
    }
    out[b] = acc;
  }

  return out;
}

// ---- wrapping-key integrity checksum ----------------------------------------------
//
// combine() (above) has no error detection: a bad or mis-transcribed share, or too few
// shares, yields a wrong key with no signal. To give recovery a clear, EARLY "one of your
// shares is incorrect" outcome (before the operator hunts for the right ciphertext or runs
// the CLI), we emit a short, PUBLIC checksum of the wrapping key alongside the shares and
// the recovery readme. On recovery the operator recombines, recomputes the checksum and
// compares: a mismatch means a wrong/short share set, full stop.
//
// This checksum is PUBLIC by construction and reveals nothing usable about the 256-bit key:
// it is a truncated SHA-256 of a domain label concatenated with the key (one-way,
// preimage-resistant, truncated to 32 bits). It is NOT the authoritative check; the
// authenticated AES-256-GCM envelope decrypt is. It is a fast, offline transcription check
// so a custodian who typed a share wrong learns so immediately rather than after a failed
// decrypt with an opaque error.

// CHECKSUM_DOMAIN binds the checksum to its purpose so the same key bytes used elsewhere
// cannot collide with this digest. It is a fixed label, not a secret.
const CHECKSUM_DOMAIN = new TextEncoder().encode("downpipes:break-glass:wrapping-key-checksum:v1");

// WRAPPING_KEY_CHECKSUM_BYTES is how many leading digest bytes the checksum keeps. 4 bytes
// (32 bits) gives a ~1-in-4.3-billion chance that a wrong share set passes the early check
// and still has to be caught by the authenticated decrypt; that is ample for a human
// transcription check while keeping the printed/QR'd checksum short.
export const WRAPPING_KEY_CHECKSUM_BYTES = 4;

// wrappingKeyChecksum returns the short integrity checksum for a SECRET_BYTES wrapping key.
// PUBLIC: safe to print in the share files and the recovery readme. Throws on a wrong-length
// key so a caller cannot accidentally checksum the wrong bytes.
export function wrappingKeyChecksum(wrappingKey: Uint8Array): Uint8Array {
  if (wrappingKey.length !== SECRET_BYTES) {
    throw new Error(`wrappingKeyChecksum: key must be ${SECRET_BYTES} bytes, got ${wrappingKey.length}`);
  }
  const input = new Uint8Array(CHECKSUM_DOMAIN.length + wrappingKey.length);
  input.set(CHECKSUM_DOMAIN, 0);
  input.set(wrappingKey, CHECKSUM_DOMAIN.length);
  return sha256(input).slice(0, WRAPPING_KEY_CHECKSUM_BYTES);
}

// verifyWrappingKey returns true iff the checksum of `wrappingKey` matches `expected`. It is
// the recovery-side gate: combine() the shares, then verifyWrappingKey(combined, expected)
// to decide whether to trust the result or tell the operator a share is wrong. Constant
// comparison is unnecessary here (both inputs are public), but the compare is total: any
// length or byte mismatch returns false rather than throwing, so a malformed `expected`
// (e.g. a truncated transcription) is simply reported as "does not verify".
export function verifyWrappingKey(wrappingKey: Uint8Array, expected: Uint8Array): boolean {
  if (wrappingKey.length !== SECRET_BYTES) return false;
  if (expected.length !== WRAPPING_KEY_CHECKSUM_BYTES) return false;
  const got = wrappingKeyChecksum(wrappingKey);
  let diff = 0;
  for (let i = 0; i < WRAPPING_KEY_CHECKSUM_BYTES; i++) diff |= got[i]! ^ expected[i]!;
  return diff === 0;
}

// Test-only helpers exposed so the validator can exercise the field arithmetic directly
// (GF axioms) without re-implementing it. Not part of the custody flow.
export const __testing = { gfMul, gfInv, gfDiv, gfEval, GF_EXP, GF_LOG };
