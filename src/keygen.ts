import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { b64urlEncode, concat, randomBytes, sha384Hex } from "./bytes.ts";
import { recordMaterialRejected } from "./lib/client-diag/ring.ts";

// The key ceremony, run in the operator's browser. It generates the hybrid recipient
// identities and the signer, in the exact byte formats the engine and the Go offline
// tool consume. CRITICAL no-custody rule: the break-glass PRIVATE identity is produced
// here and is the operator's to keep offline; it is never sent to the vendor and never
// to the engine (the engine holds only the break-glass PUBLIC key, so it can wrap but
// never unwrap). The signer private and the recipient public keys go to the in-account
// engine; the signer private must be in the account to sign runs, which the recovery
// sheet states explicitly.

export interface KeyMaterial {
  identityB64: string; // x25519 scalar(32) || ML-KEM seed(64) = 96 bytes (KEEP OFFLINE for break-glass)
  recipientPublicB64: string; // x25519 pub(32) || ML-KEM ek(1568) = 1600 bytes
  fingerprint: string; // dpr1:...
}

export interface SignerMaterial {
  privateB64: string; // ed25519 seed(32) || ML-DSA-87 seed(32) (goes to the in-account engine)
  publicB64: string; // ed25519 pub(32) || ML-DSA-87 public(2592)
  fingerprint: string; // edmldsa1:...
}

export interface CeremonyResult {
  breakGlass: KeyMaterial;
  operational: KeyMaterial | null;
  signer: SignerMaterial;
}

function isKeyMaterial(v: unknown): v is KeyMaterial {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return typeof k.identityB64 === "string"
    && typeof k.recipientPublicB64 === "string"
    && typeof k.fingerprint === "string";
}

function isSignerMaterial(v: unknown): v is SignerMaterial {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.privateB64 === "string"
    && typeof s.publicB64 === "string"
    && typeof s.fingerprint === "string";
}

// isCeremonyResult guards a value read back from the store before it is treated as a
// ceremony result. The store returns unknown by design, so a stale or misshapen value
// (for example after a format change) is rejected here rather than failing downstream.
//
// A rejection here is the "the console forgot my key ceremony and is asking me to run it again" case,
// and it left no trace of any kind. The guard returned a bare false, the screen sent the operator back to the
// start of the ceremony, and nothing anywhere said that a ceremony result HAD been stored and was THROWN AWAY.
// An operator who never completed the ceremony and one whose stored result was silently rejected saw the same
// screen and produced the same pack. The row says which, and carries not one field of the material with it.
//
// The ABSENT case (v === null / undefined) is deliberately NOT recorded: no ceremony has run, which is the
// legitimate opening state of a fresh console, and a row there would fire on every first visit.
export function isCeremonyResult(v: unknown): v is CeremonyResult {
  if (v === null || v === undefined) return false;
  if (typeof v !== "object") {
    recordMaterialRejected("ceremony-shape");
    return false;
  }
  const c = v as Record<string, unknown>;
  const ok = isKeyMaterial(c.breakGlass)
    && (c.operational === null || isKeyMaterial(c.operational))
    && isSignerMaterial(c.signer);
  if (!ok) recordMaterialRejected("ceremony-shape");
  return ok;
}

async function makeRecipient(): Promise<KeyMaterial> {
  const xk = x25519.keygen();
  const mlkemSeed = randomBytes(64);
  const ek = ml_kem1024.keygen(mlkemSeed).publicKey;
  const identity = concat(xk.secretKey, mlkemSeed);
  const recipientPublic = concat(xk.publicKey, ek);
  return {
    identityB64: b64urlEncode(identity),
    recipientPublicB64: b64urlEncode(recipientPublic),
    fingerprint: `dpr1:${await sha384Hex(recipientPublic)}`,
  };
}

async function makeSigner(): Promise<SignerMaterial> {
  const edSeed = randomBytes(32);
  const edPub = ed25519.getPublicKey(edSeed);
  // Store the 32-byte ML-DSA SEED, not the expanded 4896-byte secret, so SIGNER_PRIVATE stays
  // small enough for a Cloudflare text binding (5.1 kB limit); the engine derives the key.
  const mldsaSeed = randomBytes(32);
  const mldsa = ml_dsa87.keygen(mldsaSeed);
  const priv = concat(edSeed, mldsaSeed);
  const pub = concat(edPub, mldsa.publicKey);
  return {
    privateB64: b64urlEncode(priv),
    publicB64: b64urlEncode(pub),
    fingerprint: `edmldsa1:${await sha384Hex(pub)}`,
  };
}

// runKeyCeremony generates a break-glass recipient (always), an optional operational
// recipient, and the signer.
export async function runKeyCeremony(opts: { operational: boolean }): Promise<CeremonyResult> {
  return {
    breakGlass: await makeRecipient(),
    operational: opts.operational ? await makeRecipient() : null,
    signer: await makeSigner(),
  };
}

// runOperationalOnlyCeremony generates ONLY an operational recipient pair, entirely in the browser: the
// state-aware "add an operational key" upgrade for an engine that already has a signer and a break-glass
// key (posture.ts's renderAddOperationalEntry). A thin wrapper over the SAME makeRecipient() the full
// ceremony uses (identical bytes, no new crypto), so the engine and the offline reader read it exactly as
// they would any other operational pair. It never touches the signer or the break-glass pair: neither is
// generated here, so the caller has nothing to (and cannot) send for either.
export async function runOperationalOnlyCeremony(): Promise<KeyMaterial> {
  return makeRecipient();
}

// The labelled key-file formats the Go offline CLI reads, so an operator can save the
// break-glass identity and the signer public key and use the downpipe binary directly.
export function identityFile(km: KeyMaterial): string {
  return `downpipe-identity-v1 ${km.identityB64}\n`;
}
export function recipientFile(km: KeyMaterial): string {
  return `downpipe-recipient-v1 ${km.recipientPublicB64}\n`;
}
export function signerPublicFile(sm: SignerMaterial): string {
  return `downpipe-signer-public-v1 ${sm.publicB64}\n`;
}
export function signerPrivateFile(sm: SignerMaterial): string {
  return `downpipe-signer-private-v1 ${sm.privateB64}\n`;
}
