import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { b64urlEncode, concat, randomBytes, sha384Hex } from "./bytes.ts";
import { recordMaterialRejected } from "./lib/client-diag/ring.ts";

// The key ceremony, run in the operator's browser. It generates the hybrid recipient
// identities, the signer and the two configuration keys, in the exact byte formats the
// engine and the Go offline tool consume. CRITICAL no-custody rule: the break-glass PRIVATE identity is produced
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

// configRecipient and configWrapKeyB64 are the configuration keys, made in BOTH postures, as the
// terminal ceremony makes them (engine/scripts/generate-keys.ts). configRecipient opens only this
// engine's own sealed configuration export, so auto-heal can rebuild the configuration after a
// Durable Object wipe; it cannot read an archive. configWrapKeyB64 is CONFIG_WRAP_KEY, the
// AES-256 key that wraps console-stored credentials at rest. Both install straight to the engine;
// neither is ever offered as a download.
export interface CeremonyResult {
  breakGlass: KeyMaterial;
  operational: KeyMaterial | null;
  signer: SignerMaterial;
  configRecipient: KeyMaterial;
  configWrapKeyB64: string; // base64url of 32 random bytes (AES-256), the engine's CONFIG_WRAP_KEY
}

// ConfigKeys is the configuration-key half of a ceremony on its own: what the Keys screen's targeted
// add generates for an engine keyed without them (runConfigKeysCeremony below).
export interface ConfigKeys {
  configRecipient: KeyMaterial;
  configWrapKeyB64: string;
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
// A rejection here is recorded as a distinct event: an operator who never completed the ceremony and one
// whose stored result was silently rejected would otherwise see the same screen and produce the same
// support pack, with no way to tell which happened. The record says which, and carries not one field of
// the material with it.
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
    && isSignerMaterial(c.signer)
    && isKeyMaterial(c.configRecipient)
    && typeof c.configWrapKeyB64 === "string";
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

// makeConfigKeys generates the configuration recovery recipient (the SAME makeRecipient bytes, so the
// engine's loaders read it as any other recipient) and the 32-byte configuration wrap key.
async function makeConfigKeys(): Promise<ConfigKeys> {
  return { configRecipient: await makeRecipient(), configWrapKeyB64: b64urlEncode(randomBytes(32)) };
}

// runKeyCeremony generates a break-glass recipient (always), an optional operational
// recipient, the signer, and the two configuration keys (always, in both postures).
export async function runKeyCeremony(opts: { operational: boolean }): Promise<CeremonyResult> {
  return {
    breakGlass: await makeRecipient(),
    operational: opts.operational ? await makeRecipient() : null,
    signer: await makeSigner(),
    ...(await makeConfigKeys()),
  };
}

// runConfigKeysCeremony generates ONLY the two configuration keys, entirely in the browser: the state-aware
// "add configuration keys" step for an engine the console keyed before its ceremony made them
// (posture.ts's renderAddConfigKeysEntry). It never touches the signer, the break-glass pair or the
// operational pair: none is generated here, so the caller has nothing to send for any of them.
export async function runConfigKeysCeremony(): Promise<ConfigKeys> {
  return makeConfigKeys();
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
// There is deliberately no signer-private file writer. The signer private installs straight to
// the engine in the POST /admin/keys/install body, the way the operational private does, so the
// ceremony leaves no forgery-capable copy of it on the operator's machine. The terminal path
// matches: generate-keys.ts stages SIGNER_PRIVATE and deploy.sh deletes the staging folder.
export function identityFile(km: KeyMaterial): string {
  return `downpipe-identity-v1 ${km.identityB64}\n`;
}
export function recipientFile(km: KeyMaterial): string {
  return `downpipe-recipient-v1 ${km.recipientPublicB64}\n`;
}
export function signerPublicFile(sm: SignerMaterial): string {
  return `downpipe-signer-public-v1 ${sm.publicB64}\n`;
}
