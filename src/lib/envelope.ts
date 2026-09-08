// Envelope encryption for the offline break-glass custody experience
// (ENTERPRISE-UX-BLUEPRINT section 7.3, Tier 3). The break-glass private (identity.key,
// 96 bytes: x25519 scalar(32) || ML-KEM seed(64), src/keygen.ts:17) is too large to
// Shamir-split directly, so the custody pattern is: AES-256-GCM encrypt the key file
// with a fresh random 256-bit WRAPPING key,
// store the small ciphertext (Tier 1 vault / Tier 2 cold storage), and then either
// Shamir-split the wrapping key M-of-N (src/shamir.ts) or derive it from a security key
// (src/webauthn-prf.ts). Only the 32-byte wrapping key ever needs splitting.
//
// NO-CUSTODY: the wrapping key, the IV and the ciphertext are all produced in the
// operator's browser and only ever offered as a download. Nothing here is transmitted,
// logged or POSTed. There is no engine binding and no API for any of this material. The
// plaintext is the break-glass private, which never leaves the browser.
//
// AES-256-GCM is authenticated encryption: the 16-byte GCM tag is appended to the
// ciphertext by WebCrypto, so a wrong key or any tampering causes decrypt() to throw
// rather than return garbage. We use a fresh random 96-bit IV per encryption, which is
// the GCM-recommended IV size; uniqueness is guaranteed by crypto.getRandomValues and the
// fact that each wrapping key is single-use (one key file, one wrap).

import { ab, randomBytes } from "../bytes.ts";

// WRAPPING_KEY_BYTES is the AES-256 key length: 32 bytes = 256 bits.
export const WRAPPING_KEY_BYTES = 32;

// GCM_IV_BYTES is the 96-bit IV GCM is specified around. Using the recommended length
// keeps WebCrypto on its fast, well-analysed path and avoids the GHASH-based IV derivation
// that other lengths trigger.
export const GCM_IV_BYTES = 12;

// GCM_TAG_BYTES is the full 128-bit authentication tag (WebCrypto appends it to the
// ciphertext; we pin the full length explicitly for strength).
export const GCM_TAG_BYTES = 16;

export interface Envelope {
  ciphertext: Uint8Array; // AES-256-GCM(plaintext) with the 16-byte tag appended
  iv: Uint8Array; // the 96-bit IV used (store alongside the ciphertext; not secret)
  wrappingKey: Uint8Array; // the random 256-bit key (SPLIT or PRF-derive this; KEEP OFFLINE)
}

// importAesKey imports raw 32 bytes as a non-extractable AES-256-GCM key for one
// operation. Non-extractable means the live CryptoKey cannot be read back out, which is a
// small in-memory hardening; the caller still holds the raw wrappingKey bytes to offer as
// a download (that is the whole point of the custody flow).
async function importAesKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (raw.length !== WRAPPING_KEY_BYTES) {
    throw new Error(`AES key must be ${WRAPPING_KEY_BYTES} bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", ab(raw), { name: "AES-GCM" }, false, [usage]);
}

// encrypt wraps the given plaintext (the identity.key bytes) under a freshly generated
// random 256-bit wrapping key and a fresh 96-bit IV, returning the ciphertext, the IV and
// the wrapping key. The caller offers the ciphertext for Tier 1/2 storage and either
// Shamir-splits or PRF-derives the wrapping key; the wrapping key must be kept offline.
export async function encrypt(plaintext: Uint8Array): Promise<Envelope> {
  const wrappingKey = randomBytes(WRAPPING_KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const key = await importAesKey(wrappingKey, "encrypt");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv), tagLength: GCM_TAG_BYTES * 8 }, key, ab(plaintext)),
  );
  return { ciphertext: ct, iv, wrappingKey };
}

// encryptWith wraps the plaintext under a CALLER-SUPPLIED 256-bit wrapping key (for
// example one derived from a WebAuthn PRF secret via src/webauthn-prf.ts, or one already
// chosen so it can be Shamir-split). It still uses a fresh random IV. Returns the same
// Envelope shape, echoing back the supplied wrapping key for symmetry.
export async function encryptWith(plaintext: Uint8Array, wrappingKey: Uint8Array): Promise<Envelope> {
  if (wrappingKey.length !== WRAPPING_KEY_BYTES) {
    throw new Error(`wrappingKey must be ${WRAPPING_KEY_BYTES} bytes, got ${wrappingKey.length}`);
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const key = await importAesKey(wrappingKey, "encrypt");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv), tagLength: GCM_TAG_BYTES * 8 }, key, ab(plaintext)),
  );
  return { ciphertext: ct, iv, wrappingKey };
}

// decrypt reverses encrypt/encryptWith: given the ciphertext, the IV and the wrapping key
// it returns the original plaintext. Because GCM is authenticated, a wrong key, wrong IV
// or any tampering makes crypto.subtle.decrypt reject, so this throws rather than
// returning corrupt bytes. This is the round-trip proof the custody flow relies on (the
// console can verify that the wrapped file decrypts before the operator commits to it).
export async function decrypt(ciphertext: Uint8Array, iv: Uint8Array, wrappingKey: Uint8Array): Promise<Uint8Array> {
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`iv must be ${GCM_IV_BYTES} bytes, got ${iv.length}`);
  }
  const key = await importAesKey(wrappingKey, "decrypt");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(iv), tagLength: GCM_TAG_BYTES * 8 },
    key,
    ab(ciphertext),
  );
  return new Uint8Array(pt);
}
