// "Open a sealed export": the browser-side unseal of the DEFAULT control-plane recovery artefact.
//
// THE GAP THIS CLOSES. `engine/src/cron/control-plane-pass.ts` seals the control-plane export BY DEFAULT
// whenever a break-glass recipient is configured (always true on a ready engine), so the artefact a customer
// actually finds in their bucket after total account loss is `.sealed.json`, not `.json`. Before this file,
// nothing in the console could open it: `control-plane-recovery.ts`'s `looksLikeControlPlaneExport` gates on
// five plaintext-only fields, so pasting the default artefact refused with DP-R03 and the only working path
// was the offline `downpipe unseal-export` CLI -- a terminal, against the standing rule that customers never
// run one.
//
// WHY THE BROWSER, NOT THE ENGINE. The sealed body is encrypted to the break-glass identity plus a dedicated
// CONFIG recipient, both env bindings on the ENGINE THAT SEALED IT. After total account loss that engine, and
// every key it held, is gone; a fresh engine's own CONFIG_RECIPIENT_PRIVATE was never a recipient of the old
// export (control-plane-pass.ts's own comment: "There is deliberately NO fallback... a fallback would quietly
// re-couple config recovery to the archive key"). The only party who can still open it is whoever holds the
// offline break-glass identity.key (or an M-of-N quorum of its Shamir shares) -- and the console already
// reads exactly that kind of key into the browser and decapsulates a hybrid capsule with it, on the
// neighbouring break-glass restore path (screens/restore-flow/break-glass.ts, keydecap.ts). This module is
// the same operation, aimed at a different capsule: the sealed control-plane export's, not a run's.
//
// NO-CUSTODY, restated for this path specifically. The private identity (however it was supplied: an
// uploaded identity.key, or a reassembled M-of-N quorum) is used ONLY for the two local AEAD opens below. It
// is NEVER a field on any request this module or its caller builds, and this module calls no engine method
// and imports no Transport/EngineClient: it CANNOT reach the network, which is the strongest signal available
// that the private material never leaves this browser. Only the RECOVERED PLAINTEXT (no-custody by the
// engine's own export builder, and re-checked here as defence in depth) and the ORIGINAL sealed artefact +
// its signature (both already public bucket contents, carrying no secret) ever cross to the caller, which
// hands them to estate-import-sealed.ts for the one engine call.
//
// VERIFY PRECEDES DECRYPT. The sealed wrapper's detached hybrid signature is checked against the operator-
// pasted signer.pub BEFORE either AEAD open runs, mirroring engine/src/admin/control-plane-seal.ts's own
// stated invariant for the identical artefact. A forged or altered sealed artefact is refused before this
// browser ever attempts to decrypt it, and the operator is never shown recovered content that has not been
// authenticated.
//
// FORMAT PARITY. The two domain-separated AADs and the bodyHash construction are copied verbatim from
// engine/src/admin/control-plane-seal.ts; canonicalJSON below is a byte-for-byte port of
// engine/src/format/canonjson.ts (needed to reproduce the exact bytes the engine signed / hashed).
// test/validate-sealed-export-unseal.ts pins a fixed {identity, sealed} -> known-plaintext vector authored
// from a real engine seal, so a drift in either port fails a gate on this side.
//
// BODYHASH TRADE-OFF, STATED PLAINLY. sealed.bodyHash rides in the artefact's
// PLAINTEXT header (not inside the encrypted body), so a bucket reader -- exactly who sealing exists to keep
// out -- who can guess the EXACT candidate plaintext (every field, byte-exact, in canonicalJSON's sorted-key
// form) can hash that guess and compare it to bodyHash for free, without ever holding a recipient private
// key: a confirmation oracle this field adds that did not exist before it. Accepted, not closed (closing it
// would remove the cross-check the browser-unseal import route needs): the export carries no secret by
// construction, and the guess space is the whole byte-exact serialised export, not one field, so this is a
// narrow, stated residual risk, never a zero-knowledge claim. Full accounting in the field's own doc comment,
// engine/src/admin/control-plane-seal.ts's SealedControlPlaneExport.bodyHash.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { b64urlDecode, sha384Hex } from "../bytes.ts";
import { recordRecoveryRefusal } from "./client-diag/ring.ts";
import type { ClientDiagRecoveryOp } from "./client-diag/vocab.ts";
import { looksLikeControlPlaneExport } from "./control-plane-recovery.ts";
import { type HybridRecipientPrivate, identityFingerprint, openCapsuleWithAAD, openStream } from "./keydecap.ts";
import { withRefusalCode, type RecoveryRefusalCode } from "./recovery-refusal-codes.ts";

// ---- format constants, copied verbatim from engine/src/admin/control-plane-seal.ts -----------------------
const SEALED_EXPORT_V = 1;
const EXPORT_CAPSULE_AAD = utf8("downpipes/control-plane-export/capsule/v1");
const EXPORT_BODY_AAD = utf8("downpipes/control-plane-export/body/v1");
const LABEL_SIGNER_PUBLIC = "downpipe-signer-public-v1";
const ED25519_PUB_LEN = 32;
const MLDSA87_PUB_LEN = 2592;
const ED25519_SIG_LEN = 64;
const MLDSA_SIG_LEN = 4627;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---- the sealed artefact shape, mirroring engine/src/admin/control-plane-seal.ts::SealedControlPlaneExport
export interface SealedRecipientDesc {
  role: string;
  fingerprint: string;
}
export interface SealedCapsuleWrapJSON {
  fingerprint: string;
  kemCiphertext: string;
  sealed: string;
}
export interface SealedControlPlaneExport {
  v: number;
  exportedAt: string;
  configVersion: number;
  engineAccountId: string | null;
  recipients: SealedRecipientDesc[];
  capsule: SealedCapsuleWrapJSON[];
  body: string;
  bodyHash?: string;
}

// looksLikeSealedControlPlaneExport is the client-side shape gate for the SEALED artefact, the counterpart of
// control-plane-recovery.ts's looksLikeControlPlaneExport for the plaintext one. It does not require v to
// equal SEALED_EXPORT_V (a version mismatch is reported as its own, distinctly-worded refusal, not folded
// into "does not look like a sealed export at all").
export function looksLikeSealedControlPlaneExport(v: unknown): v is SealedControlPlaneExport {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.exportedAt === "string" &&
    typeof o.configVersion === "number" &&
    Array.isArray(o.recipients) &&
    Array.isArray(o.capsule) &&
    (o.capsule as unknown[]).length > 0 &&
    typeof o.body === "string" &&
    (o.body as string).length > 0
  );
}

// canonicalJSON is a byte-for-byte port of engine/src/format/canonjson.ts: object keys sorted by UTF-16 code
// unit (JS's default string sort already matches), no insignificant whitespace, integers only, no HTML
// escaping. Needed to reproduce the EXACT bytes the engine signed (the sealed wrapper's detached signature)
// and hashed (bodyHash), so this port must stay byte-identical; the parity vector pins it.
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}
function canonString(s: string): string {
  if (hasLoneSurrogate(s)) throw new Error("string is not valid UTF-8 (lone surrogate); canonical JSON must not transcode it");
  return JSON.stringify(s);
}
function canon(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`non-integer number ${v} is not allowed in a signed object`);
    if (!Number.isSafeInteger(v)) throw new Error(`integer ${v} exceeds the 2^53-1 canonical ceiling`);
    return String(v);
  }
  if (typeof v === "string") return canonString(v);
  if (v instanceof Uint8Array) throw new Error("raw bytes must be base64url-encoded to a string before canonicalisation");
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${canonString(k)}:${canon(obj[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof v}`);
}
export function canonicalJSON(v: unknown): Uint8Array {
  return utf8(canon(v));
}

// ---- signer.pub parsing, mirroring engine/src/admin/router-identity.ts's own acceptance of either the
// labelled kit-file form or a raw b64url payload. ------------------------------------------------------------
export interface HybridVerifier {
  ed: Uint8Array;
  mldsa: Uint8Array;
}
export function parseSignerPublic(text: string): HybridVerifier {
  const trimmed = text.trim();
  let bytes: Uint8Array;
  if (/\s/.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 2 || parts[0] !== LABEL_SIGNER_PUBLIC) throw new Error(`not a ${LABEL_SIGNER_PUBLIC} file`);
    bytes = b64urlDecode(parts[1]!);
  } else {
    bytes = b64urlDecode(trimmed);
  }
  if (bytes.length !== ED25519_PUB_LEN + MLDSA87_PUB_LEN) throw new Error(`signer.pub is ${bytes.length} bytes, want ${ED25519_PUB_LEN + MLDSA87_PUB_LEN}`);
  return { ed: bytes.subarray(0, ED25519_PUB_LEN), mldsa: bytes.subarray(ED25519_PUB_LEN) };
}

// ---- the hybrid signature verify, mirroring engine/src/crypto/sign.ts::hybridVerifyDetailed EXACTLY (the
// same closed 5-member verdict, the same never-short-circuit-on-the-classical-half discrimination). ---
export type HybridVerifyVerdict = "ok" | "sig-decode" | "ed25519-mismatch" | "ed25519-only-mismatch" | "mldsa-mismatch" | "verifier-invalid";

export function verifySealedSignatureDetailed(sealed: SealedControlPlaneExport, sigB64: string, verifier: HybridVerifier): HybridVerifyVerdict {
  let signature: Uint8Array;
  try {
    signature = b64urlDecode(sigB64);
  } catch {
    return "sig-decode";
  }
  if (signature.length !== ED25519_SIG_LEN + MLDSA_SIG_LEN) return "sig-decode";
  const message = canonicalJSON(sealed);
  const edSig = signature.subarray(0, ED25519_SIG_LEN);
  const mSig = signature.subarray(ED25519_SIG_LEN);
  try {
    const edOK = ed25519.verify(edSig, message, verifier.ed);
    const mldsaOK = ml_dsa87.verify(mSig, message, verifier.mldsa);
    if (edOK && mldsaOK) return "ok";
    if (!edOK) return mldsaOK ? "ed25519-only-mismatch" : "ed25519-mismatch";
    return "mldsa-mismatch";
  } catch {
    // A THROW inside verification (an unimportable/wrong-length key on either half) is structural: the held
    // VERIFIER is corrupt, not the artefact. Matches hybridVerifyDetailed's own catch-all exactly.
    return "verifier-invalid";
  }
}

// verdictToCode maps the five-world verdict to the SAME frozen DP-R code the engine's own
// verifySealedControlPlaneSignatureDetailed / RECOVERY_CLASS_BY_VERDICT would answer for the identical
// verdict on this SAME artefact. Deliberately the identical codes (DP-R15/18/19/20/21): the meaning is
// unchanged by WHERE the check runs, only WHEN -- here, before any network round trip.
function verdictToCode(v: Exclude<HybridVerifyVerdict, "ok">): RecoveryRefusalCode {
  switch (v) {
    case "sig-decode":
      return "DP-R19";
    case "verifier-invalid":
      return "DP-R20";
    case "ed25519-mismatch":
      return "DP-R15";
    case "ed25519-only-mismatch":
      return "DP-R18";
    case "mldsa-mismatch":
      return "DP-R21";
  }
}
function verdictSentence(v: Exclude<HybridVerifyVerdict, "ok">): string {
  switch (v) {
    case "sig-decode":
      return "the sealed artefact's detached signature could not be read (it is not a well-formed signature blob), so it was never checked at all. This is a damaged .sealed.json.sig FILE, not evidence of tampering: take a fresh copy and try again.";
    case "verifier-invalid":
      return "the pasted signer.pub will not import at all: your recovery kit's key file is damaged. Take a fresh copy of the kit. The sealed artefact was never checked.";
    case "ed25519-mismatch":
      return "the sealed artefact's signature did not verify against that signer.pub. This is either the wrong recovery kit, or the artefact has been altered -- do not proceed with this artefact.";
    case "ed25519-only-mismatch":
      return "the post-quantum half of the signature verified these exact bytes and the classical half did not: the sealed artefact is INTACT and the Ed25519 half of your kit (the signer.pub, or wherever you copied the .sig from) is damaged, not tampering. Take a fresh copy of your recovery kit.";
    case "mldsa-mismatch":
      return "the classical half of the signature verified these exact bytes and the post-quantum half did not: the sealed artefact is INTACT (a partial signer rotation, or a rotted ML-DSA half of the kit key), not tampering.";
  }
}

// ---- the top-level orchestration: verify, then open capsule, then open body, then shape-check the result.

export interface UnsealSuccess {
  ok: true;
  exportArtefact: unknown; // the recovered plaintext ControlPlaneExport, opaque, forwarded verbatim
  sealed: SealedControlPlaneExport; // the ORIGINAL sealed artefact, forwarded verbatim for the engine's own re-verify
  sealedSignature: string;
  signerPublic: string;
}
export interface UnsealFailure {
  ok: false;
  error: string;
  code: RecoveryRefusalCode;
}
export type UnsealResult = UnsealSuccess | UnsealFailure;

// unsealControlPlaneExport runs the whole browser-side pipeline over an already-shape-checked sealed
// artefact: verify the detached signature (before anything is decrypted), open the capsule addressed to the
// held identity, open the body under the recovered content key, shape-check + no-custody-check the result,
// and (when the artefact carries one) cross-check the recovered plaintext's hash against the SIGNED bodyHash.
// Every rejection is refused with a STABLE code and recorded to the ring: these are browser-only decisions the
// engine can never see by construction.
//
// THE OP IS A PARAMETER, not a constant. This pipeline was written for the estate-import
// flow and hardcoded `op: "estate-import-sealed"`. The sealed control-plane reconcile runs the IDENTICAL
// browser-side unseal for a different disaster, and with the op baked in, every client-side refusal it ever
// records would be filed against the flow the operator was NOT using. A support pack would then say an
// estate import refused when no estate import happened. It defaults to "estate-import-sealed" so the
// existing caller is unchanged.
export async function unsealControlPlaneExport(
  sealed: SealedControlPlaneExport,
  sealedSignatureText: string,
  signerPublicText: string,
  identity: HybridRecipientPrivate,
  op: ClientDiagRecoveryOp = "estate-import-sealed",
): Promise<UnsealResult> {
  const refuse = (message: string, code: RecoveryRefusalCode): UnsealFailure => {
    recordRecoveryRefusal(op, code);
    return { ok: false, error: withRefusalCode(message, code), code };
  };

  if (sealed.v !== SEALED_EXPORT_V) {
    return refuse(`this sealed artefact is version ${sealed.v}; this console's browser-unseal understands version ${SEALED_EXPORT_V}. Update the console, or use the offline downpipe unseal-export command on an air-gapped machine.`, "DP-R22");
  }
  if (typeof sealed.bodyHash !== "string" || sealed.bodyHash.length === 0) {
    return refuse("this sealed artefact was written before body-hash pinning, so the recovered plaintext cannot be cross-checked against what was signed. Wait for the next scheduled export (or trigger one with a config change) and pull a fresh copy, or use the offline downpipe unseal-export command on an air-gapped machine in the meantime.", "DP-R23");
  }

  let verifier: HybridVerifier;
  try {
    verifier = parseSignerPublic(signerPublicText);
  } catch (e) {
    return refuse(`the supplied signer.pub is not a valid downpipe signer public key: ${e instanceof Error ? e.message : String(e)}`, "DP-R20");
  }
  const verdict = verifySealedSignatureDetailed(sealed, sealedSignatureText, verifier);
  if (verdict !== "ok") {
    return refuse(verdictSentence(verdict), verdictToCode(verdict));
  }

  const wraps = sealed.capsule;
  // Distinguish "wrong key" (no wrap is addressed to this identity at all -- DP-R24) from "right key, corrupt
  // capsule" (a wrap IS addressed to it, but the AEAD open of that wrap fails -- DP-R25) BEFORE attempting the
  // open, so the two states never collapse into one generic decrypt failure the way a bare catch would.
  const want = await identityFingerprint(identity);
  if (!wraps.some((w) => w.fingerprint === want)) {
    return refuse("your break-glass key (or reassembled quorum) does not match this sealed artefact: no capsule wrap is addressed to it. Check you selected the identity.key (or the shares) for THIS estate. Nothing was sent; your key stays in this browser.", "DP-R24");
  }
  let contentKey: Uint8Array;
  try {
    contentKey = await openCapsuleWithAAD(wraps, identity, EXPORT_CAPSULE_AAD);
  } catch {
    return refuse("your key matched this sealed artefact, but its capsule did not decrypt cleanly. This artefact may be corrupt or truncated: pull a fresh copy from your destination bucket and try again.", "DP-R25");
  }
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = await openStream(contentKey, b64urlDecode(sealed.body), EXPORT_BODY_AAD);
  } catch {
    return refuse("the sealed body did not decrypt cleanly, even though your key matched. This artefact may be corrupt or truncated: pull a fresh copy from your destination bucket and try again.", "DP-R26");
  } finally {
    contentKey.fill(0); // the content key's job ends here; best-effort zeroize before dropping it
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return refuse("the sealed body decrypted, but is not valid JSON. This artefact may be corrupt: pull a fresh copy from your destination bucket and try again.", "DP-R27");
  }
  if (!looksLikeControlPlaneExport(parsed)) {
    return refuse("the sealed body decrypted, but is not a control-plane export artefact. This artefact may be corrupt, or from an incompatible engine version.", "DP-R27");
  }

  const recoveredHash = `sha384:${await sha384Hex(bodyBytes)}`;
  if (recoveredHash !== sealed.bodyHash) {
    // Should never fire once the signature and both AEAD opens above already succeeded (AES-256-GCM already
    // guarantees the decrypted bytes are exactly what was sealed) -- refused rather than silently trusted, in
    // case this port ever drifts from the engine's own hashing.
    return refuse("the recovered plaintext's hash does not match the value the sealed artefact was signed over. This should not happen; please contact support and include this code.", "DP-R28");
  }

  return { ok: true, exportArtefact: parsed, sealed, sealedSignature: sealedSignatureText, signerPublic: signerPublicText };
}
