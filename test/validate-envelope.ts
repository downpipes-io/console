// Validate src/lib/envelope.ts: AES-256-GCM envelope encryption of the break-glass key.
// Run with `node test/validate-envelope.ts`.
//
// Coverage:
//   encrypt -> decrypt round-trip recovers the exact plaintext (incl. a 3.2 KB-sized blob
//     mimicking the real identity.key, an empty plaintext, and a 1-byte plaintext)
//   shapes: wrapping key is 32 bytes, IV is 12 bytes (96-bit), ciphertext = plaintext + 16
//     (the GCM tag), every value is fresh-random per call
//   wrong key fails: decrypting with a different 32-byte key throws (GCM auth)
//   wrong IV fails: decrypting with a different IV throws
//   tamper fails: flipping any ciphertext or tag byte makes decrypt throw
//   IV uniqueness: many encrypts of the same plaintext produce distinct IVs (and distinct
//     ciphertexts), so no IV reuse under GCM
//   encryptWith: a caller-supplied wrapping key round-trips and is echoed back unchanged;
//     it rejects a wrong-length key
//   interop with the custody chain: a wrapping key produced and Shamir-recombined still
//     decrypts (envelope + shamir compose), and a key derived from a (mock) PRF secret via
//     webauthn-prf.deriveWrappingKey works as the envelope key

import { encrypt, encryptWith, decrypt, WRAPPING_KEY_BYTES, GCM_IV_BYTES, GCM_TAG_BYTES } from "../src/lib/envelope.ts";
import { split, combine, SECRET_BYTES } from "../src/lib/shamir.ts";
import { deriveWrappingKey } from "../src/lib/webauthn-prf.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
async function rejects(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  ok(label, threw);
}
// rejectsMsg asserts the rejection carries a message containing `needle`, pinning WHICH guard
// fired. The length and IV guards each report a distinct byte count, so blanking a guard message
// (or removing a guard so a generic WebCrypto error surfaces instead) is caught here.
async function rejectsMsg(label: string, needle: string, fn: () => Promise<unknown>): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
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
function rnd(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
function toHex(a: Uint8Array): string {
  let s = "";
  for (const b of a) s += b.toString(16).padStart(2, "0");
  return s;
}

async function main(): Promise<void> {
  // A plaintext roughly the size of the real break-glass identity.key (X25519 32 +
  // ML-KEM-1024 decap ~3168 = ~3200 bytes). Use 3200 to mimic it.
  const identityLike = rnd(3200);

  // ---- the three sizes, stated as REQUIREMENTS and not as themselves --------------------
  // Every other assertion in this file reads a size off the envelope and compares it to the
  // constant the envelope was built from, so the two sides move together and none of them can
  // fail. Dropping WRAPPING_KEY_BYTES to 16 turns the break-glass envelope from AES-256 into
  // AES-128, dropping GCM_TAG_BYTES to 8 halves the authentication tag, and lengthening
  // GCM_IV_BYTES off the 96-bit value GCM is specified around forces the extra GHASH
  // derivation step. WebCrypto accepts all three, so the whole suite stays green on any of
  // them. These are the sizes the algorithm names require, so they are pinned to literals.
  //
  // A red exit code is not the same as a failed assertion.
  // At WRAPPING_KEY_BYTES = 16 this file did already exit non-zero, but no assertion failed: the
  // compose-with-shamir section further down threw "split: secret must be 32 bytes, got 16" and the
  // verdict guard reported that the tally was never reached. The run went red on a crash in an
  // unrelated section rather than on the key length, and only because this file happens to compose
  // with shamir at all. The other two sizes went fully green.
  console.log("\n-- envelope: the key, IV and tag sizes are the ones AES-256-GCM requires --");
  ok("WRAPPING_KEY_BYTES is 32 (AES-256, not AES-128's 16)", WRAPPING_KEY_BYTES === 32);
  ok("GCM_IV_BYTES is 12 (the 96-bit IV GCM is specified around)", GCM_IV_BYTES === 12);
  ok("GCM_TAG_BYTES is 16 (the full 128-bit tag, not a truncated one)", GCM_TAG_BYTES === 16);
  // The custody chain splits the wrapping key with shamir, which declares the SAME 32 a second time
  // as SECRET_BYTES. Nothing asserted that the two agree, so a divergence surfaced only as the throw
  // above. Named here, so a future change to either constant fails on the reason and not on a crash.
  ok("shamir's SECRET_BYTES is the SAME length as the envelope's wrapping key", SECRET_BYTES === WRAPPING_KEY_BYTES);

  // ---- round-trip --------------------------------------------------------------------
  console.log("\n-- envelope: encrypt -> decrypt round-trip --");
  {
    const env = await encrypt(identityLike);
    const back = await decrypt(env.ciphertext, env.iv, env.wrappingKey);
    ok("3.2 KB identity-like plaintext round-trips exactly", bytesEq(back, identityLike));
    ok("wrapping key is 32 bytes (256-bit)", env.wrappingKey.length === WRAPPING_KEY_BYTES);
    ok("IV is 12 bytes (96-bit)", env.iv.length === GCM_IV_BYTES);
    ok("ciphertext == plaintext length + 16-byte GCM tag", env.ciphertext.length === identityLike.length + GCM_TAG_BYTES);
  }
  {
    const empty = new Uint8Array(0);
    const env = await encrypt(empty);
    const back = await decrypt(env.ciphertext, env.iv, env.wrappingKey);
    ok("empty plaintext round-trips", back.length === 0);
    ok("empty plaintext ciphertext is just the 16-byte tag", env.ciphertext.length === GCM_TAG_BYTES);
  }
  {
    const one = Uint8Array.from([0x42]);
    const env = await encrypt(one);
    ok("1-byte plaintext round-trips", bytesEq(await decrypt(env.ciphertext, env.iv, env.wrappingKey), one));
  }

  // ---- wrong key / wrong IV fail (GCM authentication) --------------------------------
  console.log("\n-- envelope: wrong key and wrong IV are rejected --");
  {
    const env = await encrypt(identityLike);
    const wrongKey = rnd(WRAPPING_KEY_BYTES);
    await rejects("decrypt with a wrong 32-byte key throws", () => decrypt(env.ciphertext, env.iv, wrongKey));

    // A key that differs by a single bit must also fail.
    const offByOne = Uint8Array.from(env.wrappingKey);
    offByOne[0] = offByOne[0]! ^ 0x01;
    await rejects("decrypt with a one-bit-different key throws", () => decrypt(env.ciphertext, env.iv, offByOne));

    const wrongIv = rnd(GCM_IV_BYTES);
    await rejects("decrypt with a wrong IV throws", () => decrypt(env.ciphertext, wrongIv, env.wrappingKey));
  }

  // ---- length-guard messages (pin the specific guard, not a downstream crypto error) -------
  console.log("\n-- envelope: length guards report their own messages --");
  {
    const env = await encrypt(rnd(48));
    // decrypt routes a short wrapping key straight into importAesKey, whose own guard must fire
    // with the AES-key byte count. Removing that guard would instead surface a raw WebCrypto
    // "Invalid key length" DataError, which lacks this needle.
    await rejectsMsg("decrypt short key reports the AES-key byte count", `${WRAPPING_KEY_BYTES} bytes`, () => decrypt(env.ciphertext, env.iv, rnd(WRAPPING_KEY_BYTES - 1)));
    await rejectsMsg("decrypt short key message says \"AES key\"", "AES key", () => decrypt(env.ciphertext, env.iv, rnd(WRAPPING_KEY_BYTES - 1)));
    // The iv guard must fire on a wrong-length IV with its own "iv" message. Without the guard an
    // 11-byte IV reaches WebCrypto and throws an OperationError (auth failure) lacking this needle.
    await rejectsMsg("decrypt short IV reports the IV byte count", `${GCM_IV_BYTES} bytes`, () => decrypt(env.ciphertext, rnd(GCM_IV_BYTES - 1), env.wrappingKey));
    await rejectsMsg("decrypt short IV message says \"iv\"", "iv must be", () => decrypt(env.ciphertext, rnd(GCM_IV_BYTES - 1), env.wrappingKey));
    // A LONGER-than-12 IV is also rejected by the guard (not silently accepted by WebCrypto).
    await rejectsMsg("decrypt over-long IV is rejected by the guard", `${GCM_IV_BYTES} bytes`, () => decrypt(env.ciphertext, rnd(GCM_IV_BYTES + 1), env.wrappingKey));
  }

  // ---- tamper detection --------------------------------------------------------------
  console.log("\n-- envelope: tampering is detected --");
  {
    const env = await encrypt(rnd(64));
    // Flip a byte in the ciphertext body.
    const tamperedBody = Uint8Array.from(env.ciphertext);
    tamperedBody[0] = tamperedBody[0]! ^ 0x80;
    await rejects("flipping a ciphertext-body byte makes decrypt throw", () => decrypt(tamperedBody, env.iv, env.wrappingKey));
    // Flip a byte in the GCM tag (the last 16 bytes).
    const tamperedTag = Uint8Array.from(env.ciphertext);
    tamperedTag[tamperedTag.length - 1] = tamperedTag[tamperedTag.length - 1]! ^ 0x01;
    await rejects("flipping a GCM-tag byte makes decrypt throw", () => decrypt(tamperedTag, env.iv, env.wrappingKey));
    // Truncating the ciphertext (drops part of the tag) must fail.
    await rejects("truncated ciphertext fails", () => decrypt(env.ciphertext.subarray(0, env.ciphertext.length - 1), env.iv, env.wrappingKey));
  }

  // ---- IV uniqueness -----------------------------------------------------------------
  console.log("\n-- envelope: IV uniqueness (no GCM nonce reuse) --");
  {
    const N = 256;
    const pt = rnd(128);
    const ivs = new Set<string>();
    const cts = new Set<string>();
    let keysDistinct = true;
    const keys = new Set<string>();
    for (let i = 0; i < N; i++) {
      const env = await encrypt(pt);
      ivs.add(toHex(env.iv));
      cts.add(toHex(env.ciphertext));
      const kh = toHex(env.wrappingKey);
      if (keys.has(kh)) keysDistinct = false;
      keys.add(kh);
    }
    ok(`${N} encrypts of the same plaintext produced ${ivs.size} distinct IVs`, ivs.size === N);
    ok(`${N} encrypts of the same plaintext produced ${cts.size} distinct ciphertexts`, cts.size === N);
    ok(`${N} fresh wrapping keys are all distinct`, keysDistinct && keys.size === N);
  }

  // ---- encryptWith: caller-supplied wrapping key -------------------------------------
  console.log("\n-- envelope: encryptWith caller-supplied key --");
  {
    const key = rnd(WRAPPING_KEY_BYTES);
    const env = await encryptWith(identityLike, key);
    ok("encryptWith echoes the supplied wrapping key unchanged", bytesEq(env.wrappingKey, key));
    ok("encryptWith round-trips with the supplied key", bytesEq(await decrypt(env.ciphertext, env.iv, key), identityLike));
    // Two encryptWith calls with the same key still get distinct IVs.
    const env2 = await encryptWith(identityLike, key);
    ok("encryptWith uses a fresh IV each call", !bytesEq(env.iv, env2.iv));
    await rejects("encryptWith rejects a wrong-length key (31 bytes)", () => encryptWith(identityLike, rnd(31)));
    // encryptWith has its OWN length guard ahead of importAesKey; its message names "wrappingKey",
    // distinct from importAesKey's "AES key" message. Removing the encryptWith guard would let
    // importAesKey throw the "AES key" message instead, so this needle pins the right guard.
    await rejectsMsg("encryptWith length message says \"wrappingKey\"", "wrappingKey must be", () => encryptWith(identityLike, rnd(WRAPPING_KEY_BYTES - 1)));
    await rejectsMsg("encryptWith length message names the byte count", `${WRAPPING_KEY_BYTES} bytes`, () => encryptWith(identityLike, rnd(WRAPPING_KEY_BYTES + 1)));
  }

  // ---- compose with Shamir: split the wrapping key, recombine, decrypt ----------------
  console.log("\n-- envelope + shamir: split the wrapping key, recombine, decrypt --");
  {
    const env = await encrypt(identityLike);
    // Custodian split of the 32-byte wrapping key, 3-of-5.
    const shares = split(env.wrappingKey, 5, 3);
    const recombined = combine([shares[0]!, shares[2]!, shares[4]!]);
    ok("Shamir-recombined wrapping key equals the original", bytesEq(recombined, env.wrappingKey));
    ok("ciphertext decrypts under the recombined wrapping key", bytesEq(await decrypt(env.ciphertext, env.iv, recombined), identityLike));
    // A below-threshold recombination yields a key that does NOT decrypt.
    const tooFew = combine([shares[0]!, shares[2]!]);
    await rejects("a below-threshold recombined key does NOT decrypt", () => decrypt(env.ciphertext, env.iv, tooFew));
  }

  // ---- compose with webauthn-prf: derive the key from a (mock) PRF secret -------------
  console.log("\n-- envelope + webauthn-prf: PRF-derived wrapping key --");
  {
    // A 32-byte secret standing in for a security key's PRF output (the real one comes from
    // the device; here we feed a fixed vector to the pure HKDF derivation).
    const prfSecret = rnd(32);
    const wrappingKey = deriveWrappingKey(prfSecret);
    ok("deriveWrappingKey yields a 32-byte key", wrappingKey.length === WRAPPING_KEY_BYTES);
    const env = await encryptWith(identityLike, wrappingKey);
    // Re-deriving from the same PRF secret reproduces the key and decrypts.
    const rederived = deriveWrappingKey(prfSecret);
    ok("re-deriving from the same PRF secret reproduces the key", bytesEq(rederived, wrappingKey));
    ok("ciphertext decrypts under the re-derived PRF wrapping key", bytesEq(await decrypt(env.ciphertext, env.iv, rederived), identityLike));
    // A different PRF secret derives a different key that does NOT decrypt.
    const otherKey = deriveWrappingKey(rnd(32));
    await rejects("a key derived from a different PRF secret does NOT decrypt", () => decrypt(env.ciphertext, env.iv, otherKey));
  }

  console.log(failures === 0 ? "\nENVELOPE VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
