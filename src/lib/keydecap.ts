// The browser-side key decapsulation for attended verification. This is a faithful port of the engine's
// openCapsule (engine/src/crypto/capsule.ts) for the single case attended verification needs: recover a
// run's 32-byte master from its master-capsule wraps using the operator's break-glass identity, in the
// operator's browser, so the private key NEVER leaves it. The engine then verifies the run from that single-
// archive master (openRunWithMaster), which re-checks the key commitment, so a wrong master fails closed.
//
// It also derives the live-possession challenge proof (a port of engine/src/attest/challenge.ts's browser
// side): decapsulate the engine's challenge ciphertext with the identity, then HKDF a proof over the nonce.
//
// PARITY: this must reproduce the engine's bytes EXACTLY. validate-keydecap.ts pins a fixed
// {identity, capsule, keyCommitment} -> known master vector authored from the engine's master-capsule
// conformance vector, so a drift in either port (or a one-sided @noble bump) fails a gate on this side.
// It uses only primitives the console already bundles (@noble ml-kem + x25519) plus Web Crypto (HKDF,
// AES-256-GCM, SHA-384); no new dependency.

import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { ab, concat, b64urlDecode } from "../bytes.ts";

// Format constants, copied verbatim from engine/src/format/version.ts. A divergence here is an
// interop break, caught by the parity vector.
const INFO_CAPSULE_DEM = "downpipe/0.1.0 capsule-dem";
const INFO_PAYLOAD = "downpipe/0.1.0 payload";
const HYBRID_KEM_LABEL = "downpipe/0.1.0 hybrid-kem";
const CHALLENGE_LABEL = "downpipe/0.1.0 attest-challenge";
const STREAM_NONCE_SIZE = 16;
const TAG_SIZE = 16;
const CHUNK_SIZE = 65536; // 64 KiB of plaintext per AES-256-GCM chunk, matching engine/src/format/version.ts
const ML_KEM_CT_LEN = 1568;
const IDENTITY_LABEL = "downpipe-identity-v1";

// HybridRecipientPrivate is the parsed break-glass identity: the 32-byte X25519 scalar and the 64-byte
// ML-KEM seed (the same shape the engine's parseIdentity produces).
export interface HybridRecipientPrivate {
  x25519Scalar: Uint8Array;
  mlkemSeed: Uint8Array;
}

// CapsuleWrap mirrors the master-capsule wrap the engine serves: the recipient fingerprint, the hybrid KEM
// ciphertext (base64url) and the STREAM-sealed master (base64url).
export interface CapsuleWrap {
  fingerprint: string;
  kemCiphertext: string;
  sealed: string;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function sha384Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-384", ab(data)));
}

function hex(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}

// hkdfSha384 mirrors engine/src/crypto/primitives.ts (extract + expand over SHA-384) via Web Crypto.
async function hkdfSha384(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-384", salt: ab(salt), info: ab(info) }, key, n * 8);
  return new Uint8Array(bits);
}

// aesGcmOpen mirrors engine/src/crypto/primitives.ts: decrypt ciphertext||tag under AES-256-GCM.
async function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ab(key), "AES-GCM", false, ["decrypt"]);
  const params: AesGcmParams = { name: "AES-GCM", iv: ab(nonce), tagLength: 128 };
  if (aad.length > 0) params.additionalData = ab(aad);
  return new Uint8Array(await crypto.subtle.decrypt(params, k, ab(sealed)));
}

// x25519SharedSecret mirrors engine/src/crypto/x25519.ts, including the SPEC 4.1 contributory abort (reject
// an all-zero shared secret), so the console accepts/rejects exactly what the engine does.
function x25519SharedSecret(scalar: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  const ss = x25519.getSharedSecret(scalar, peerPublic);
  let zero = 0;
  for (const b of ss) zero |= b;
  if (zero === 0) throw new Error("x25519 produced an all-zero shared secret (non-contributory point)");
  return ss;
}

// hybridKEMCombine mirrors engine/src/crypto/combiner.ts: HKDF-SHA-384 over ssM||ssX with info = label ||
// 0x00 || ctX || pkX.
function hybridKEMCombine(ssM: Uint8Array, ssX: Uint8Array, ctX: Uint8Array, pkX: Uint8Array): Promise<Uint8Array> {
  const info = concat(utf8(HYBRID_KEM_LABEL), new Uint8Array([0x00]), ctX, pkX);
  return hkdfSha384(concat(ssM, ssX), new Uint8Array(0), info, 32);
}

// decapsulateHybrid mirrors engine/src/crypto/kem.ts: recover the 32-byte hybrid shared secret from a
// 1600-byte hybrid ciphertext (ct_M(1568) || ct_X(32)) using the held identity.
export async function decapsulateHybrid(priv: HybridRecipientPrivate, cipherText: Uint8Array): Promise<Uint8Array> {
  if (cipherText.length !== ML_KEM_CT_LEN + 32) throw new Error(`hybrid ciphertext is ${cipherText.length} bytes, want ${ML_KEM_CT_LEN + 32}`);
  const ctM = cipherText.subarray(0, ML_KEM_CT_LEN);
  const ctX = cipherText.subarray(ML_KEM_CT_LEN);
  const decapKey = ml_kem1024.keygen(priv.mlkemSeed).secretKey;
  const ssM = ml_kem1024.decapsulate(ctM, decapKey);
  const ssX = x25519SharedSecret(priv.x25519Scalar, ctX);
  const ourPub = x25519.getPublicKey(priv.x25519Scalar);
  return hybridKEMCombine(ssM, ssX, ctX, ourPub);
}

// chunkNonce mirrors engine/src/crypto/stream.ts: 3 reserved zero bytes, an 8-byte big-endian counter, and a
// 1-byte last-chunk flag. For a 32-byte master the capsule is a single last chunk (counter 0, last true).
function chunkNonce(counter: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  // counter fits in 32 bits for the single-chunk master; write it big-endian into bytes 3..10 (bytes 3..6
  // stay zero, the low 32 bits go in bytes 7..10).
  n[7] = (counter >>> 24) & 0xff;
  n[8] = (counter >>> 16) & 0xff;
  n[9] = (counter >>> 8) & 0xff;
  n[10] = counter & 0xff;
  n[11] = last ? 1 : 0;
  return n;
}

// openMasterStream mirrors engine/src/crypto/stream.ts openStream for the SINGLE-CHUNK case a 32-byte master
// seals to: read the 16-byte payload nonce, derive the payload key, and AES-256-GCM open the one chunk with
// the run key commitment as AAD. It rejects anything but exactly one chunk (a master is never multi-chunk).
async function openMasterStream(fileKey: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < STREAM_NONCE_SIZE) throw new Error("stream shorter than the payload nonce");
  const nonce = sealed.subarray(0, STREAM_NONCE_SIZE);
  const body = sealed.subarray(STREAM_NONCE_SIZE);
  if (body.length <= TAG_SIZE) throw new Error("stream chunk shorter than the tag");
  // A 32-byte master is one chunk; a body longer than one 64 KiB chunk + tag would be a malformed master.
  if (body.length > 65536 + TAG_SIZE) throw new Error("master capsule chunk is unexpectedly large");
  const pk = await hkdfSha384(fileKey, nonce, utf8(INFO_PAYLOAD), 32);
  return aesGcmOpen(pk, chunkNonce(0, true), body, aad);
}

// identityFingerprint mirrors engine/src/crypto/capsule.ts: dpr1: + hex SHA-384 of x25519pub(32) ||
// ml-kem ek(1568), so the matching capsule wrap can be selected.
export async function identityFingerprint(priv: HybridRecipientPrivate): Promise<string> {
  const x = x25519.getPublicKey(priv.x25519Scalar);
  const ek = ml_kem1024.keygen(priv.mlkemSeed).publicKey;
  return `dpr1:${hex(await sha384Bytes(concat(x, ek)))}`;
}

// openCapsuleWithAAD is the shared capsule-open implementation: recover the 32-byte sealed content (a run
// master, or a sealed control-plane export's content key) from the wraps using the held identity,
// with the AAD supplied directly as bytes. It selects the wrap addressed to the identity, decapsulates the
// hybrid KEM, derives the DEM key and STREAM-opens the sealed content with `aad` bound in.
export async function openCapsuleWithAAD(wraps: CapsuleWrap[], priv: HybridRecipientPrivate, aad: Uint8Array): Promise<Uint8Array> {
  const want = await identityFingerprint(priv);
  for (const w of wraps) {
    if (w.fingerprint !== want) continue;
    const ss = await decapsulateHybrid(priv, b64urlDecode(w.kemCiphertext));
    const wrapKey = await hkdfSha384(ss, new Uint8Array(0), utf8(INFO_CAPSULE_DEM), 32);
    const opened = await openMasterStream(wrapKey, b64urlDecode(w.sealed), aad);
    if (opened.length !== 32) throw new Error(`recovered capsule content is ${opened.length} bytes, want 32`);
    return opened;
  }
  throw new Error(`no capsule wrap matches the held recipient ${want}`);
}

// openCapsule mirrors engine/src/crypto/capsule.ts: recover the 32-byte run master from the wraps using the
// held identity, with the AAD taken from the run's hex key commitment (the master-capsule case). A thin
// wrapper over openCapsuleWithAAD, kept for its existing callers (attend.ts, break-glass.ts) and the
// validate-keydecap.ts parity vector, which both address the AAD as hex.
export async function openCapsule(wraps: CapsuleWrap[], priv: HybridRecipientPrivate, keyCommitmentHex: string): Promise<Uint8Array> {
  return openCapsuleWithAAD(wraps, priv, hexDecode(keyCommitmentHex));
}

// openStream mirrors engine/src/crypto/stream.ts openStream (the GENERAL, multi-chunk case): reads the
// 16-byte payload nonce, derives the per-file payload key, then AES-256-GCM opens EVERY 64 KiB chunk in
// order, each bound to `aad`, and concatenates the recovered plaintext. Unlike openMasterStream (a fixed
// single 32-byte chunk -- the master-capsule case, capped well under one chunk), this handles a body of any
// length: a sealed control-plane export body, which is routinely bigger than 64 KiB. A chunk that fails
// to authenticate throws (a wrong content key, nonce, aad, or any tampering) before any byte of it is used.
export async function openStream(fileKey: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < STREAM_NONCE_SIZE) throw new Error("stream shorter than the payload nonce");
  const nonce = sealed.subarray(0, STREAM_NONCE_SIZE);
  const body = sealed.subarray(STREAM_NONCE_SIZE);
  const pk = await hkdfSha384(fileKey, nonce, utf8(INFO_PAYLOAD), 32);
  const stride = CHUNK_SIZE + TAG_SIZE;
  const slices: Uint8Array[] = [];
  for (let off = 0; off < body.length; off += stride) slices.push(body.subarray(off, Math.min(off + stride, body.length)));
  if (slices.length === 0) throw new Error("stream has no chunks");
  const out: Uint8Array[] = [];
  for (let i = 0; i < slices.length; i++) {
    const last = i === slices.length - 1;
    if (slices[i]!.length < TAG_SIZE) throw new Error(`chunk ${i} shorter than the tag`);
    out.push(await aesGcmOpen(pk, chunkNonce(i, last), slices[i]!, aad));
  }
  return concat(...out);
}

// deriveAttestProof mirrors engine/src/attest/challenge.ts's browser side: decapsulate the engine's challenge
// ciphertext with the identity to recover the same shared secret, then HKDF the proof over the nonce. Only a
// holder of the break-glass private can produce this, which is what proves live key possession.
export async function deriveAttestProof(priv: HybridRecipientPrivate, ciphertextB64: string, nonceB64: string): Promise<Uint8Array> {
  const ss = await decapsulateHybrid(priv, b64urlDecode(ciphertextB64));
  return hkdfSha384(ss, b64urlDecode(nonceB64), utf8(CHALLENGE_LABEL), 32);
}

// parseIdentityFile parses an identity.key file ("downpipe-identity-v1 <base64url>") into the hybrid private
// parts (x25519 scalar(32) || ML-KEM seed(64) = 96 bytes), matching the engine's parseIdentity + the Go
// offline tool's labelled key-file format. The file is read in the browser (FileReader) and NEVER uploaded.
export function parseIdentityFile(text: string): HybridRecipientPrivate {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== IDENTITY_LABEL) throw new Error(`not a ${IDENTITY_LABEL} file`);
  const bytes = b64urlDecode(parts[1]!);
  if (bytes.length !== 96) throw new Error(`identity is ${bytes.length} bytes, want 96`);
  return { x25519Scalar: bytes.subarray(0, 32), mlkemSeed: bytes.subarray(32, 96) };
}

// hexDecode parses a hex string into bytes (the engine sends the key commitment as hex).
function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}
