// Pure, DOM-free serialisers and parsers for the offline break-glass custody file artefacts.
// These were inlined in
// src/components/custody-step.ts, which made them impossible to unit-test in isolation. They are factored here so the round-trip can be asserted directly: a share file
// parses back to the exact bytes that combine() to the wrapping key; the envelope file
// decrypts; and the (PUBLIC) credentialId rides with the ciphertext so a future restore can
// re-derive a security-key wrapping key.
//
// NO-CUSTODY: these functions only FORMAT bytes the component already holds in memory into
// the labelled text artefacts the operator downloads, and PARSE those same artefacts back.
// Nothing here transmits, logs or persists anything; the component offers the returned
// strings as downloads only. The plaintext (the identity.key bytes), the wrapping key and
// the share bodies are secrets the operator keeps offline; the IV, the credentialId and the
// wrapping-key checksum are PUBLIC metadata that travel with the ciphertext to make recovery
// possible. This split (secret body vs public metadata) is exactly what the validator
// asserts: only public metadata may flow to the recovery-sheet path, never a secret byte.

import { b64urlEncode, b64urlDecode } from "../bytes.ts";
import { WRAPPING_KEY_CHECKSUM_BYTES } from "./shamir.ts";

// CustodyKeyInput is the EXACT slice of a ceremony the custody flow reads: only the
// break-glass identity bytes. A full CeremonyResult structurally satisfies it (so a real
// ceremony passes unchanged), and a caller holding only a parsed identity.key can build this
// shape directly without an unsound cast. The custody flow never reads recipientPublicB64,
// fingerprint, signer or operational, so requiring them would be a false contract.
export interface CustodyKeyInput {
  breakGlass: { identityB64: string };
}

// ---- file format version labels (first line of each artefact) ---------------------
//
// Each artefact starts with a stable version label so a parser can reject a file of the
// wrong kind and a future format can be detected. These match the strings the component
// shipped before the refactor, so already-downloaded files keep parsing.
export const ENVELOPE_FILE_MAGIC = "downpipe-wrapped-identity-v1";
export const WRAPPING_KEY_FILE_MAGIC = "downpipe-wrapping-key-v1";
export const SHARE_FILE_MAGIC = "downpipe-shamir-share-v1";

// identityPlaintext returns the exact bytes of the break-glass identity.key file (the
// labelled file the offline CLI reads), so the ciphertext decrypts back to a usable file.
// This reads the in-memory identityB64 the operator generated locally; it never touches the
// network. It is the ONE place the custody flow turns the in-memory break-glass private into
// the bytes that flow into in-browser AES, then out only as a download.
export function identityPlaintext(result: CustodyKeyInput): Uint8Array {
  const fileText = `downpipe-identity-v1 ${result.breakGlass.identityB64}\n`;
  return new TextEncoder().encode(fileText);
}

// EnvelopeFileFields is what serialiseEnvelopeFile packs and parseEnvelopeFile returns: the
// PUBLIC IV, the ciphertext (the encrypted identity.key; opaque without the wrapping key),
// and an OPTIONAL PUBLIC credentialId. The credentialId is present only when the wrapping
// key was derived from a security key (PRF), so a later restore knows which enrolled
// credential to assert against to re-derive the wrapping key. The credentialId is NOT a
// secret (it is the public handle WebAuthn returns at enrolment); shipping it with the
// ciphertext is what makes the YubiKey path recoverable at all.
export interface EnvelopeFileFields {
  iv: Uint8Array;
  ciphertext: Uint8Array;
  // exactOptionalPropertyTypes: present only for the security-key path.
  credentialId?: Uint8Array;
}

// serialiseEnvelopeFile packs the IV and ciphertext (and, for the security-key path, the
// PUBLIC credentialId) into a single self-contained text file (labelled base64url bodies)
// so the operator stores one ciphertext artefact. The IV and credentialId are not secret;
// they are stored so decryption needs only this file plus the wrapping key (random,
// Shamir-recombined, or re-derived from the named security key). No wrapping key is in here.
export function serialiseEnvelopeFile(fields: EnvelopeFileFields): string {
  let out =
    `${ENVELOPE_FILE_MAGIC}\n` +
    `iv ${b64urlEncode(fields.iv)}\n` +
    `ciphertext ${b64urlEncode(fields.ciphertext)}\n`;
  if (fields.credentialId !== undefined) {
    // PUBLIC: the security-key credential handle to assert against on restore. The comment
    // states plainly that it is not a secret, so an operator reading the file is not alarmed.
    out +=
      "# credential-id is the PUBLIC handle of the security key that derived the wrapping key.\n" +
      "# It is NOT a secret; it lets a future restore re-derive the key from the registered key.\n" +
      `credential-id ${b64urlEncode(fields.credentialId)}\n`;
  }
  return out;
}

// parseEnvelopeFile parses a serialiseEnvelopeFile artefact back to its fields. It is strict
// about the magic line and the required iv/ciphertext fields, and tolerant of comment lines
// (starting with '#') and blank lines so a hand-annotated file still parses. It throws a
// precise error on a malformed file rather than returning partial data. credentialId is
// returned only when the optional line is present.
export function parseEnvelopeFile(text: string): EnvelopeFileFields {
  const fields = parseLabelledLines(text, ENVELOPE_FILE_MAGIC);
  const ivStr = fields.get("iv");
  const ctStr = fields.get("ciphertext");
  if (ivStr === undefined) throw new Error("parseEnvelopeFile: missing 'iv' line");
  if (ctStr === undefined) throw new Error("parseEnvelopeFile: missing 'ciphertext' line");
  const out: EnvelopeFileFields = {
    iv: b64urlDecode(ivStr),
    ciphertext: b64urlDecode(ctStr),
  };
  const credStr = fields.get("credential-id");
  if (credStr !== undefined) out.credentialId = b64urlDecode(credStr);
  return out;
}

// wrappingKeyFile labels the random wrapping key for offline storage (Tier 1/2 with no
// security key). It is a SECRET to keep OFFLINE and APART from the ciphertext; the file says
// so. It is only ever offered as a download.
export function wrappingKeyFile(wrappingKey: Uint8Array): string {
  return (
    `${WRAPPING_KEY_FILE_MAGIC}\n` +
    "KEEP OFFLINE AND APART FROM THE CIPHERTEXT. Anyone with both can decrypt the key file.\n" +
    `key ${b64urlEncode(wrappingKey)}\n`
  );
}

// parseWrappingKeyFile parses a wrappingKeyFile artefact back to the raw wrapping-key bytes.
// Strict on the magic and the 'key' line; tolerant of the warning/comment lines.
export function parseWrappingKeyFile(text: string): Uint8Array {
  const fields = parseLabelledLines(text, WRAPPING_KEY_FILE_MAGIC);
  const keyStr = fields.get("key");
  if (keyStr === undefined) throw new Error("parseWrappingKeyFile: missing 'key' line");
  return b64urlDecode(keyStr);
}

// ShareFileFields is what serialiseShareFile packs and parseShareFile returns: the share
// index and the M-of-N parameters (PUBLIC), the PUBLIC wrapping-key checksum (so recovery
// can verify the recombined key BEFORE trusting it; see src/lib/shamir.ts verifyWrappingKey),
// and the share body bytes (the SECRET this custodian holds).
export interface ShareFileFields {
  index: number;
  n: number;
  threshold: number;
  // The PUBLIC short checksum of the wrapping key (shamir.wrappingKeyChecksum). Lets the
  // operator detect a wrong/mis-transcribed share set at recovery with a clear message.
  checksum: Uint8Array;
  // The SECRET share body (shamir share bytes: 1 index byte + 32 payload bytes).
  share: Uint8Array;
}

// serialiseShareFile labels one custodian's Shamir share for download: the index and the
// M-of-N parameters in the header (so a custodian knows what they hold), the PUBLIC
// wrapping-key checksum (for recovery-time verification), and the share bytes as base64url.
// The only secret is the share body; the header carries public parameters and a one-way
// checksum that reveals nothing usable about the key.
export function serialiseShareFile(fields: ShareFileFields): string {
  return (
    `${SHARE_FILE_MAGIC}\n` +
    `# Custodian ${fields.index} of ${fields.n}. Any ${fields.threshold} of the ${fields.n} shares reconstruct the wrapping key.\n` +
    "# One share alone reveals nothing. Keep it apart from the ciphertext and the other shares.\n" +
    `index ${fields.index}\n` +
    `n ${fields.n}\n` +
    `threshold ${fields.threshold}\n` +
    "# checksum is a PUBLIC one-way check of the wrapping key, to detect a wrong share at recovery.\n" +
    `checksum ${b64urlEncode(fields.checksum)}\n` +
    `share ${b64urlEncode(fields.share)}\n`
  );
}

// parseShareFile parses a serialiseShareFile artefact back to its fields. Strict on the
// magic and on the required lines; tolerant of comment/blank lines. It validates that the
// numeric fields are integers and that the checksum length matches the module's checksum
// size, throwing a precise error otherwise.
export function parseShareFile(text: string): ShareFileFields {
  const fields = parseLabelledLines(text, SHARE_FILE_MAGIC);
  const index = parseIntField(fields, "index");
  const n = parseIntField(fields, "n");
  const threshold = parseIntField(fields, "threshold");
  const checksumStr = fields.get("checksum");
  const shareStr = fields.get("share");
  if (checksumStr === undefined) throw new Error("parseShareFile: missing 'checksum' line");
  if (shareStr === undefined) throw new Error("parseShareFile: missing 'share' line");
  const checksum = b64urlDecode(checksumStr);
  if (checksum.length !== WRAPPING_KEY_CHECKSUM_BYTES) {
    throw new Error(`parseShareFile: checksum must be ${WRAPPING_KEY_CHECKSUM_BYTES} bytes, got ${checksum.length}`);
  }
  return { index, n, threshold, checksum, share: b64urlDecode(shareStr) };
}

// ---- shared parsing helpers -------------------------------------------------------

// NO-CUSTODY, and the reason these messages look sparse.
//
// Everything below is fed a file the operator CHOSE, and the whole point of the flow is that the file they choose
// may be the wrong one. The wrong one is routinely a SECRET: a bare wrapping key is 43 base64url characters on a
// single line, an emailed share body is one token, an identity.key is one label and a private key. So a parser
// that quotes the input back to explain the failure quotes a key. These messages therefore name only the KIND of
// file that was expected (one of three module constants) and the KIND of fault. They never carry a line, a
// fragment of a line, an offset, a length or a label read out of the file.
//
// A clamp is not a redaction. Quoting the first 40 characters of a 43-character wrapping key is a leak of about
// 30 of its 32 bytes, and it does not become safe by being short.
//
// The upstream cost is real and accepted: an operator holding a genuinely malformed file gets "this is not a
// downpipe-shamir-share-v1 file" rather than the offending line. That is the correct trade. The file is in their
// hands and they can look at it; the error message is the one artefact that can escape the browser, into a
// screenshot, a support ticket or a pasted terminal buffer.

// ARTEFACT_LABELS is the CLOSED set of label names each artefact kind legally carries. It exists so a duplicate
// label can be NAMED in an error without echoing file content: a label matched against this set is one of our own
// constants, not a string from the file. Anything else is reported only as unrecognised.
const ARTEFACT_LABELS: Record<string, readonly string[]> = {
  [ENVELOPE_FILE_MAGIC]: ["iv", "ciphertext", "credential-id"],
  [WRAPPING_KEY_FILE_MAGIC]: ["key"],
  [SHARE_FILE_MAGIC]: ["index", "n", "threshold", "checksum", "share"],
};

// parseLabelledLines splits a labelled text artefact into a key -> value map. The first
// non-empty line must equal `magic` (else it is a file of the wrong kind). Each subsequent
// non-comment, non-blank line is "label value"; labels are unique (a repeat throws, so a
// tampered file with two 'key' lines cannot smuggle one past the parser). Comment lines
// start with '#'; blank lines are skipped. Free-text lines with no space (e.g. the
// wrapping-key warning banner) are tolerated and ignored, since the warning line carries no
// "label value" pair.
//
// Parsing behaviour is unchanged by the message rework above: the same files parse, and the same files are
// rejected. Only what the rejection SAYS changed. The offline reader in the downpipe CLI is pinned to these
// semantics, so the accept/reject boundary must not move.
function parseLabelledLines(text: string, magic: string): Map<string, string> {
  const lines = text.split("\n");
  const out = new Map<string, string>();
  const known = ARTEFACT_LABELS[magic] ?? [];
  let sawMagic = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    if (line.startsWith("#")) continue;
    if (!sawMagic) {
      // The header line did not match. `line` here is the first meaningful line of a file of the WRONG KIND,
      // which is exactly when it is most likely to be a bare key or a bare share body. It is not echoed, clamped
      // or hinted at. The file kind we wanted is the whole message.
      if (line !== magic) throw new Error(`parse: this is not a ${magic} file`);
      sawMagic = true;
      continue;
    }
    const sp = line.indexOf(" ");
    if (sp === -1) {
      // A free-text line (e.g. the wrapping-key "KEEP OFFLINE..." banner). Ignore it; it is
      // not a label/value pair and carries no parseable field.
      continue;
    }
    const label = line.slice(0, sp);
    const value = line.slice(sp + 1).trim();
    if (out.has(label)) {
      // A label is file content. It is named only when it is one of THIS artefact's own labels, in which case the
      // string in the message is the constant from ARTEFACT_LABELS and not the bytes from the file.
      throw new Error(
        known.includes(label)
          ? `parse: duplicate '${label}' line in a ${magic} file`
          : `parse: duplicate unrecognised label in a ${magic} file`,
      );
    }
    out.set(label, value);
  }
  if (!sawMagic) throw new Error(`parse: missing the ${magic} header`);
  return out;
}

// parseIntField pulls a required non-negative integer field from the parsed map. `label` is a caller-supplied
// constant, so naming it is safe; the VALUE is file content and is never echoed, not even when it fails the
// integer test. A non-integer value in an 'index' line is still a line out of the operator's file.
function parseIntField(fields: Map<string, string>, label: string): number {
  const raw = fields.get(label);
  if (raw === undefined) throw new Error(`parse: missing '${label}' line`);
  if (!/^\d+$/.test(raw)) throw new Error(`parse: '${label}' must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`parse: '${label}' is out of range`);
  return value;
}
