// Validate src/lib/custody-files.ts: the pure secret-handling serialisers factored out of
// src/components/custody-step.ts, the wrapping-key integrity checksum, and the security-key
// credential-id-rides-with-the-ciphertext behaviour. Run with `node test/validate-custody-files.ts`.
//
// These compose the verified primitives (envelope.ts, shamir.ts, webauthn-prf.ts) the way the
// component does:
//
// Coverage:
//   identityPlaintext:
//     - produces the labelled identity.key bytes; encrypt -> serialise -> parse -> decrypt
//       recovers EXACTLY those bytes (the file the offline CLI reads)
//   serialiseEnvelopeFile / parseEnvelopeFile:
//     - round-trips iv + ciphertext; the parsed ciphertext decrypts under the wrapping key
//     - the OPTIONAL credential id rides with the ciphertext and parses back byte-for-byte
//       (a future restore can re-derive the security-key wrapping key)
//     - a file WITHOUT a credential id parses with credentialId undefined (random-key path)
//     - rejects a wrong-magic file and a file missing iv/ciphertext
//   wrappingKeyFile / parseWrappingKeyFile:
//     - round-trips the random wrapping key (the offline Tier 1/2 secret)
//   serialiseShareFile / parseShareFile + shamir combine + the checksum:
//     - each share file parses back to the EXACT share bytes; any threshold of the parsed
//       shares combine() to the wrapping key, and the ciphertext decrypts under it
//     - the PUBLIC checksum stored in every share verifies the correctly-combined key, and
//       a single bad/mis-transcribed share is DETECTED (verifyWrappingKey false), giving the
//       "one of your shares is incorrect" outcome before the (authoritative) decrypt
//     - rejects a wrong-magic file and a checksum of the wrong length
//   NO-SECRET-to-the-recovery-sheet invariant (the no-custody crux for these serialisers):
//     - the recovery-sheet path (custodyMetadataLines / recoverySheet / recoverySheetHTML)
//       carries the PUBLIC credential id but NONE of: the identity bytes, the wrapping key,
//       the ciphertext, or any share body, even when a real envelope+split is performed and
//       the security-key metadata is set

import {
  identityPlaintext,
  serialiseEnvelopeFile,
  parseEnvelopeFile,
  wrappingKeyFile,
  parseWrappingKeyFile,
  serialiseShareFile,
  parseShareFile,
  ENVELOPE_FILE_MAGIC,
  SHARE_FILE_MAGIC,
} from "../src/lib/custody-files.ts";
import { encrypt, decrypt } from "../src/lib/envelope.ts";
import { split, combine, wrappingKeyChecksum, verifyWrappingKey, WRAPPING_KEY_CHECKSUM_BYTES } from "../src/lib/shamir.ts";
import { custodyMetadataLines, type CustodyMetadata } from "../src/lib/custody.ts";
import { recoverySheet, recoverySheetHTML, type SheetParams } from "../src/recovery-sheet.ts";
import type { CeremonyResult } from "../src/keygen.ts";
import { b64urlEncode, b64urlDecode } from "../src/bytes.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
async function rejects(label: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  ok(label, threw);
}
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function rnd(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Sentinel secrets so a leak into the recovery-sheet path is unambiguous.
const SECRET_IDENTITY = "SENTINEL_BREAKGLASS_PRIVATE_IDENTITY_B64_files_must_never_appear";
const SECRET_SIGNER_PRIV = "SENTINEL_SIGNER_PRIVATE_B64_files_must_never_appear";
const ceremony: CeremonyResult = {
  breakGlass: { identityB64: SECRET_IDENTITY, recipientPublicB64: "BREAK_PUBLIC", fingerprint: "dpr1:aabbcc" },
  operational: null,
  signer: { privateB64: SECRET_SIGNER_PRIV, publicB64: "SIGNER_PUBLIC", fingerprint: "edmldsa1:112233" },
};

// ---- identityPlaintext --------------------------------------------------------------
function checkIdentityPlaintext(): void {
  console.log("\n-- custody-files: identityPlaintext is the labelled identity.key --");
  {
    const pt = identityPlaintext(ceremony);
    const text = new TextDecoder().decode(pt);
    ok("identityPlaintext is the labelled identity.key line", text === `downpipe-identity-v1 ${SECRET_IDENTITY}\n`);
  }
}

// ---- envelope file round-trip (random-key path) -------------------------------------
async function checkEnvelopeRoundTrip(): Promise<void> {
  console.log("\n-- custody-files: envelope file round-trips and decrypts --");
  {
    const plaintext = identityPlaintext(ceremony);
    const env = await encrypt(plaintext);
    const file = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
    ok("envelope file starts with the magic", file.startsWith(`${ENVELOPE_FILE_MAGIC}\n`));
    const parsed = parseEnvelopeFile(file);
    ok("parsed iv equals the original", bytesEq(parsed.iv, env.iv));
    ok("parsed ciphertext equals the original", bytesEq(parsed.ciphertext, env.ciphertext));
    ok("no credential id on the random-key path", parsed.credentialId === undefined);
    const back = await decrypt(parsed.ciphertext, parsed.iv, env.wrappingKey);
    ok("parsed ciphertext decrypts back to the identity.key bytes", bytesEq(back, plaintext));
  }
}

// ---- doTier12Encrypt orchestration path (custody-step-panels.ts) -------------------
// The Tier 1/2 encrypt action is DOM-heavy and not imported here, but its load-bearing
// sequence is exactly identityPlaintext -> encrypt -> {ciphertext file, wrapping-key file}
// offered as two SEPARATE downloads. Assert that data path directly: the two artefacts the
// action produces recover the original identity bytes when (and only when) recombined, and
// neither artefact decrypts on its own. This is the assertable seam for the orchestration.
async function checkTier12Orchestration(): Promise<void> {
  console.log("\n-- custody-files: the Tier 1/2 encrypt orchestration recovers from its two files --");
  {
    const plaintext = identityPlaintext(ceremony);
    const env = await encrypt(plaintext);
    // The two downloads doTier12Encrypt offers, kept deliberately apart.
    const ciphertextFile = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
    const wkFile = wrappingKeyFile(env.wrappingKey);
    // Recovery: parse both files and decrypt. Only the pair recovers the identity bytes.
    const parsedCt = parseEnvelopeFile(ciphertextFile);
    const parsedWk = parseWrappingKeyFile(wkFile);
    const recovered = await decrypt(parsedCt.ciphertext, parsedCt.iv, parsedWk);
    ok("the ciphertext file and wrapping-key file together recover the identity bytes", bytesEq(recovered, plaintext));
    // The ciphertext file carries no usable key: decrypting with a wrong (fresh) key fails.
    await rejects("the ciphertext file alone does not decrypt with a wrong wrapping key", () => decrypt(parsedCt.ciphertext, parsedCt.iv, rnd(32)));
  }
}

// ---- envelope file with a credential id (PRF path) ------------------------------
async function checkCredentialId(): Promise<void> {
  console.log("\n-- custody-files: credential id rides with the ciphertext --");
  {
    const plaintext = identityPlaintext(ceremony);
    const env = await encrypt(plaintext);
    // A stand-in for the WebAuthn raw credential id (public handle), an arbitrary-length blob.
    const credentialId = rnd(20);
    const file = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext, credentialId });
    const parsed = parseEnvelopeFile(file);
    ok("the credential id is present after a round-trip", parsed.credentialId !== undefined);
    ok("the credential id parses back byte-for-byte", parsed.credentialId !== undefined && bytesEq(parsed.credentialId, credentialId));
    ok("iv and ciphertext still round-trip alongside the credential id", bytesEq(parsed.iv, env.iv) && bytesEq(parsed.ciphertext, env.ciphertext));
    ok("ciphertext still decrypts with the credential id present", bytesEq(await decrypt(parsed.ciphertext, parsed.iv, env.wrappingKey), plaintext));
    // The file states plainly that the credential id is public, not a secret.
    ok("envelope file labels the credential id as PUBLIC / not a secret", /PUBLIC/.test(file) && /NOT a secret/i.test(file));
  }
}

// ---- envelope file: malformed inputs are rejected ----------------------------------
async function checkEnvelopeMalformed(): Promise<void> {
  console.log("\n-- custody-files: envelope file rejects malformed input --");
  {
    const env = await encrypt(rnd(64));
    const good = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
    await rejects("rejects a wrong-magic file", () => parseEnvelopeFile(good.replace(ENVELOPE_FILE_MAGIC, "downpipe-something-else-v1")));
    await rejects("rejects a file missing the iv line", () => parseEnvelopeFile(good.split("\n").filter((l) => !l.startsWith("iv ")).join("\n")));
    await rejects("rejects a file missing the ciphertext line", () => parseEnvelopeFile(good.split("\n").filter((l) => !l.startsWith("ciphertext ")).join("\n")));
    await rejects("rejects empty text", () => parseEnvelopeFile(""));
  }
}

// ---- wrapping-key file round-trip --------------------------------------------------
async function checkWrappingKeyRoundTrip(): Promise<void> {
  console.log("\n-- custody-files: wrapping-key file round-trips --");
  {
    const key = rnd(32);
    const file = wrappingKeyFile(key);
    ok("wrapping-key file carries the OFFLINE / APART warning", /KEEP OFFLINE AND APART/.test(file));
    ok("parsed wrapping key equals the original", bytesEq(parseWrappingKeyFile(file), key));
    // It must round-trip even though it has a free-text warning banner line (no "label value").
    await rejects("wrapping-key parse rejects a wrong-magic file", () => parseWrappingKeyFile(file.replace("downpipe-wrapping-key-v1", "nope-v1")));
  }
}

// ---- share files + combine + checksum -------------------------------------
async function checkShareRoundTrip(): Promise<void> {
  console.log("\n-- custody-files: share files round-trip, combine, and verify --");
  {
    const plaintext = identityPlaintext(ceremony);
    const env = await encrypt(plaintext);
    const n = 5;
    const threshold = 3;
    const shares = split(env.wrappingKey, n, threshold);
    const checksum = wrappingKeyChecksum(env.wrappingKey);
    ok("checksum is the documented length", checksum.length === WRAPPING_KEY_CHECKSUM_BYTES);

    // Serialise every share to its file, then parse them all back.
    const files = shares.map((share, i) => serialiseShareFile({ index: i + 1, n, threshold, checksum, share }));
    ok("each share file starts with the magic", files.every((f) => f.startsWith(`${SHARE_FILE_MAGIC}\n`)));
    const parsed = files.map((f) => parseShareFile(f));

    // The parsed share bodies equal the originals exactly.
    let bodiesEqual = true;
    for (let i = 0; i < n; i++) if (!bytesEq(parsed[i]!.share, shares[i]!)) bodiesEqual = false;
    ok("each parsed share body equals the original share bytes", bodiesEqual);
    ok("parsed share files carry the index / n / threshold", parsed.every((p, i) => p.index === i + 1 && p.n === n && p.threshold === threshold));
    ok("parsed share files carry the matching checksum", parsed.every((p) => bytesEq(p.checksum, checksum)));

    // Any threshold-sized subset of the PARSED shares combines to the wrapping key, verifies
    // against the parsed checksum, and decrypts the ciphertext.
    const subset = [parsed[0]!, parsed[2]!, parsed[4]!];
    const recombined = combine(subset.map((p) => p.share));
    ok("a threshold subset of parsed shares combines to the wrapping key", bytesEq(recombined, env.wrappingKey));
    ok("the recombined key verifies against the parsed checksum", verifyWrappingKey(recombined, subset[0]!.checksum));
    ok("the recombined key decrypts the ciphertext", bytesEq(await decrypt(env.ciphertext, env.iv, recombined), plaintext));

    // R4 crux: a single BAD/mis-transcribed share yields a wrong key that the checksum
    // DETECTS (so the operator gets a clear "one of your shares is incorrect" outcome before
    // the authoritative decrypt is even attempted).
    const badShare = Uint8Array.from(shares[2]!);
    badShare[1] = badShare[1]! ^ 0xff; // flip a payload byte: a transcription error
    const withBad = combine([shares[0]!, badShare, shares[4]!]);
    ok("a bad share produces a WRONG key (combine is integrity-blind)", !bytesEq(withBad, env.wrappingKey));
    ok("the checksum DETECTS the bad share (verifyWrappingKey is false)", !verifyWrappingKey(withBad, checksum));
    // And the authoritative check (the authenticated GCM decrypt) also rejects it.
    await rejects("the wrong key also fails the authenticated decrypt (authoritative)", () => decrypt(env.ciphertext, env.iv, withBad));

    // A below-threshold combine is likewise detected by the checksum.
    const tooFew = combine([parsed[0]!.share, parsed[2]!.share]);
    ok("a below-threshold combine is detected by the checksum", !verifyWrappingKey(tooFew, checksum));
  }
}

// ---- share file: malformed inputs rejected -----------------------------------------
async function checkShareMalformed(): Promise<void> {
  console.log("\n-- custody-files: share file rejects malformed input --");
  {
    const env = await encrypt(rnd(64));
    const shares = split(env.wrappingKey, 3, 2);
    const checksum = wrappingKeyChecksum(env.wrappingKey);
    const good = serialiseShareFile({ index: 1, n: 3, threshold: 2, checksum, share: shares[0]! });
    await rejects("share parse rejects a wrong-magic file", () => parseShareFile(good.replace(SHARE_FILE_MAGIC, "nope-v1")));
    await rejects("share parse rejects a missing share line", () => parseShareFile(good.split("\n").filter((l) => !l.startsWith("share ")).join("\n")));
    // A checksum of the wrong length must be rejected (a truncated transcription).
    const shortChecksum = serialiseShareFile({ index: 1, n: 3, threshold: 2, checksum: checksum.subarray(0, 2), share: shares[0]! });
    await rejects("share parse rejects a wrong-length checksum", () => parseShareFile(shortChecksum));
  }
}

// ---- NO-SECRET to the recovery-sheet path (the no-custody crux) ---------------------
async function checkNoSecretToSheet(): Promise<void> {
  console.log("\n-- custody-files: only PUBLIC metadata reaches the recovery sheet --");
  {
    const plaintext = identityPlaintext(ceremony);
    const env = await encrypt(plaintext);
    const shares = split(env.wrappingKey, 5, 3);
    const credentialId = rnd(20);

    // Everything the component DOWNLOADS (and which must never reach the sheet):
    const secretsThatMustNotAppear = [
      SECRET_IDENTITY,
      SECRET_SIGNER_PRIV,
      b64urlEncode(env.wrappingKey),
      b64urlEncode(env.ciphertext),
      ...shares.map((s) => b64urlEncode(s)),
      // The full serialised artefacts, too: no whole share/key/ciphertext file may bleed in.
      wrappingKeyFile(env.wrappingKey),
      serialiseShareFile({ index: 1, n: 5, threshold: 3, checksum: wrappingKeyChecksum(env.wrappingKey), share: shares[0]! }),
    ];

    // A Tier 1/2 metadata with the security-key credential id (the R1 public handle). The
    // credential id is the ONLY new thing on the sheet, and it is PUBLIC.
    const credentialIdB64 = b64urlEncode(credentialId);
    const tier1Meta: CustodyMetadata = {
      scheme: "encrypted-usb-paper",
      signoffs: [{ shareIndex: 1, holder: "Vault Owner", signedOn: "2026-06-09" }],
      securityKeyCredentialIdB64: credentialIdB64,
    };

    const metaLines = custodyMetadataLines(tier1Meta).join("\n");
    ok("custodyMetadataLines records the PUBLIC credential id", metaLines.includes(credentialIdB64));
    for (const secret of secretsThatMustNotAppear) {
      ok(`custodyMetadataLines does not leak a secret (${secret.slice(0, 12)}...)`, !metaLines.includes(secret));
    }

    const params: SheetParams = {
      downpipeAccount: "acme-production",
      createdAt: "2026-06-09T00:00:00Z",
      posture: "break-glass-only",
      custody: tier1Meta,
    };
    const textSheet = recoverySheet(ceremony, params);
    ok("text recovery sheet records the PUBLIC credential id", textSheet.includes(credentialIdB64));
    for (const secret of secretsThatMustNotAppear) {
      ok(`text recovery sheet does not leak a secret (${secret.slice(0, 12)}...)`, !textSheet.includes(secret));
    }

    const htmlSheet = recoverySheetHTML(ceremony, params);
    ok("HTML recovery sheet records the PUBLIC credential id", htmlSheet.includes(credentialIdB64));
    for (const secret of secretsThatMustNotAppear) {
      ok(`HTML recovery sheet does not leak a secret (${secret.slice(0, 12)}...)`, !htmlSheet.includes(secret));
    }

    // Sanity: the credential id we asserted is present really is the bytes we made (so the
    // "present" assertions above are meaningful, not matching an empty string).
    ok("the asserted credential id decodes back to the original bytes", bytesEq(b64urlDecode(credentialIdB64), credentialId));
  }
}

// ---- NO-SECRET in a PARSE ERROR (the landmine this file exists to keep disarmed) ----
//
// Every parser here is fed a file the operator CHOSE, so the file it rejects is, by definition, the file they got
// wrong. That file is routinely a secret: a bare wrapping key is one line of 43 base64url characters, an emailed
// share body is one token, an identity.key is a label and a private key. A parser that quotes the rejected input
// back at the operator quotes a key, and the quote is what escapes: into a rendered error, a screenshot, a
// support ticket.
//
// This check feeds each parser the WRONG SECRET FILE and asserts the thrown message carries nothing of it. A
// clamp does not pass this test, which is the point: quoting the first 40 characters of a 43-character wrapping
// key leaks about 30 of its 32 bytes and is not made safe by being short.
async function checkNoSecretInParseErrors(): Promise<void> {
  console.log("\n-- custody-files: a parse error never echoes the file it rejected --");
  const env = await encrypt(identityPlaintext(ceremony));
  const shares = split(env.wrappingKey, 3, 2);
  const wrappingKeyB64 = b64urlEncode(env.wrappingKey);
  const shareB64 = b64urlEncode(shares[0]!);

  // The wrong-file-for-the-parser cases an operator actually hits, each one a SECRET.
  const bareWrappingKey = `${wrappingKeyB64}\n`; // what the emailed/transcribed key looks like: no magic at all
  const bareShare = `${shareB64}\n`; // what an emailed custodian holds: the bare body, no magic
  const identityKeyFile = `downpipe-identity-v1 ${SECRET_IDENTITY}\n`; // the plaintext key file itself

  // Any fragment of a secret is a leak, so we hunt for substrings, not equality. 8 characters of base64url is 6
  // bytes of key: far past the point where quoting is defensible.
  const secrets = [wrappingKeyB64, shareB64, SECRET_IDENTITY];
  function leaks(msg: string): string | null {
    for (const secret of secrets) {
      for (let n = secret.length; n >= 8; n--) {
        const frag = secret.slice(0, n);
        if (msg.includes(frag)) return frag;
      }
    }
    return null;
  }

  const cases: Array<{ label: string; run: () => unknown }> = [
    { label: "parseWrappingKeyFile fed a BARE wrapping key", run: () => parseWrappingKeyFile(bareWrappingKey) },
    { label: "parseShareFile fed a BARE share body", run: () => parseShareFile(bareShare) },
    { label: "parseEnvelopeFile fed a BARE wrapping key", run: () => parseEnvelopeFile(bareWrappingKey) },
    { label: "parseWrappingKeyFile fed an identity.key", run: () => parseWrappingKeyFile(identityKeyFile) },
    { label: "parseEnvelopeFile fed an identity.key", run: () => parseEnvelopeFile(identityKeyFile) },
    { label: "parseShareFile fed an identity.key", run: () => parseShareFile(identityKeyFile) },
  ];

  for (const c of cases) {
    let msg: string | null = null;
    try {
      c.run();
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    ok(`${c.label} is rejected`, msg !== null);
    if (msg === null) continue;
    const leaked = leaks(msg);
    ok(`${c.label}: the error carries no fragment of the file`, leaked === null);
    if (leaked !== null) console.log(`       leaked fragment: ${leaked.length} chars`);
  }

  // The decoder underneath is held to the same bar: it sees every pasted key, share and recovery code, and its
  // throw must not carry the character, the offset or the length of the material it refused.
  {
    let msg = "";
    try {
      b64urlDecode(`${wrappingKeyB64.slice(0, 20)}=+${wrappingKeyB64.slice(22)}`);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    ok("b64urlDecode's throw carries no fragment of the material", leaks(msg) === null);
    // No number may ride: an offset is a position inside the secret and a length is a fingerprint of it. The
    // "base64url" in the prose is the one legal digit run, so it is removed before the check.
    ok("b64urlDecode's throw carries no offset or length", !/\d/.test(msg.replaceAll("base64url", "").replaceAll("base64", "")));
  }
}

async function main(): Promise<void> {
  checkIdentityPlaintext();
  await checkEnvelopeRoundTrip();
  await checkTier12Orchestration();
  await checkCredentialId();
  await checkEnvelopeMalformed();
  await checkWrappingKeyRoundTrip();
  await checkShareRoundTrip();
  await checkShareMalformed();
  await checkNoSecretToSheet();
  await checkNoSecretInParseErrors();

  console.log(failures === 0 ? "\nCUSTODY-FILES VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
