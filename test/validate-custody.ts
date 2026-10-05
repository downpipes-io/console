// Validate the pure logic of the offline break-glass custody experience
// (ENTERPRISE-UX-BLUEPRINT section 7.3): the scheme model, the M-of-N parameter rules, the
// per-custodian share labelling, the QR chunking arithmetic, and the single most important
// no-custody invariant: the recovery-sheet custody content (text + HTML) carries NO secret.
//
// Run with `node test/validate-custody.ts` after `npm install`.
//
// The custody component (src/components/custody-step.ts) is DOM-heavy and not imported here;
// its load-bearing logic lives in src/lib/custody.ts (pure) and is exercised directly,
// matching the existing validator convention (validate-credentials / validate-security-centre).
//
// Coverage:
//   scheme model:
//     - SCHEME_OPTIONS has the three tiers; schemeOption/schemeLabel resolve them
//     - schemeLabel("undecided") is the honest "not yet chosen"; an unknown id is echoed
//   M-of-N parameter rules (mirror src/lib/shamir.ts bounds, plus the UI cap):
//     - 2 of 3, 3 of 5, n==threshold all valid
//     - threshold < 2 rejected; threshold > n rejected; n < MIN_SHARES rejected; n > MAX rejected
//     - non-integer rejected
//   share labelling:
//     - n labels, distinct slug-safe filenames, 1-based indices, threshold + n in the note
//   QR chunking:
//     - small payload -> 1 code; empty -> 1 (empty) code
//     - a ~4.3 KB base64 payload -> 2 codes at the 2953-byte cap (and 3 at a robust level)
//     - the ranges tile the payload exactly: contiguous, non-overlapping, covering [0,len)
//   recovery-sheet NO-SECRET invariant (the no-custody crux):
//     - custodyMetadataLines / splitReadme contain the scheme, counts and custodian names
//       but NONE of: the identity bytes, the signer private, a real wrapping key, any share
//     - recoverySheet (text) and recoverySheetHTML (HTML) with a split custody block likewise
//       carry no secret, even when a real envelope + Shamir split is performed alongside
//     - custodian display names with HTML metacharacters are escaped in the HTML rendering

import {
  SCHEME_OPTIONS,
  schemeOption,
  schemeLabel,
  validateSplitParams,
  shareLabels,
  planQrChunks,
  QR_MAX_BYTES,
  custodyMetadataLines,
  makeSplitSignoffs,
  splitReadme,
  CIPHERTEXT_FILENAME,
  yubikeyAppliesTo,
  MIN_SHARES,
  MAX_SHARES,
  type CustodyMetadata,
} from "../src/lib/custody.ts";
import { recoverySheet, recoverySheetHTML, type SheetParams } from "../src/recovery-sheet.ts";
import type { CeremonyResult } from "../src/keygen.ts";
import { encrypt } from "../src/lib/envelope.ts";
import { split as shamirSplit } from "../src/lib/shamir.ts";
import { b64urlEncode } from "../src/bytes.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// scheme model
// ---------------------------------------------------------------------------
console.log("\n-- custody: scheme model --");
ok("SCHEME_OPTIONS lists the three tiers", SCHEME_OPTIONS.length === 3);
ok("ids are the three expected tiers", SCHEME_OPTIONS.map((o) => o.id).join(",") === "password-manager,encrypted-usb-paper,mofn-split");
ok("schemeOption resolves a known id", schemeOption("mofn-split")?.label === "M-of-N custodian split");
ok("schemeOption('undecided') is undefined", schemeOption("undecided") === undefined);
ok("schemeLabel('undecided') is honest", schemeLabel("undecided") === "not yet chosen");
ok("schemeLabel resolves a known id", schemeLabel("password-manager") === "Corporate password manager");
ok("yubikey layers on Tier 1/2 only", yubikeyAppliesTo("password-manager") && yubikeyAppliesTo("encrypted-usb-paper") && !yubikeyAppliesTo("mofn-split") && !yubikeyAppliesTo("undecided"));

// ---------------------------------------------------------------------------
// M-of-N parameter rules
// ---------------------------------------------------------------------------
console.log("\n-- custody: M-of-N parameter rules --");
ok("2 of 3 valid", validateSplitParams(3, 2).ok);
ok("3 of 5 valid", validateSplitParams(5, 3).ok);
ok("n == threshold valid (3 of 3)", validateSplitParams(3, 3).ok);
ok("MIN_SHARES of MIN_SHARES valid", validateSplitParams(MIN_SHARES, MIN_SHARES).ok);
ok("MAX_SHARES valid", validateSplitParams(MAX_SHARES, 2).ok);
ok("threshold < 2 rejected (1 of 3)", !validateSplitParams(3, 1).ok);
ok("threshold > n rejected (4 of 3)", !validateSplitParams(3, 4).ok);
ok("n below MIN rejected", !validateSplitParams(1, 1).ok);
ok("n above MAX rejected", !validateSplitParams(MAX_SHARES + 1, 2).ok);
ok("non-integer n rejected", !validateSplitParams(3.5, 2).ok);
ok("non-integer threshold rejected", !validateSplitParams(5, 2.5).ok);
// A rejected result carries a reason; an accepted one does not (exactOptionalPropertyTypes).
ok("rejected result carries a reason", typeof validateSplitParams(3, 4).reason === "string");
ok("accepted result has no reason", validateSplitParams(3, 2).reason === undefined);

// ---------------------------------------------------------------------------
// share labelling
// ---------------------------------------------------------------------------
console.log("\n-- custody: per-custodian share labelling --");
{
  const labels = shareLabels(5, 3);
  ok("one label per share", labels.length === 5);
  ok("indices are 1-based and ordered", labels.map((l) => l.index).join(",") === "1,2,3,4,5");
  const names = new Set(labels.map((l) => l.filename));
  ok("filenames are distinct", names.size === 5);
  ok("filenames are slug-safe", labels.every((l) => /^downpipe-share-\d+-of-\d+\.txt$/.test(l.filename)));
  ok("title names the custodian, n and threshold", labels[0]!.title === "Custodian 1 of 5 (any 3 reconstruct)");
  ok("note states the threshold and total", labels[2]!.note.includes("any 3 of them") && labels[2]!.note.includes("custodian 3"));
  // Defensive: n < 1 yields an empty list, never throws.
  ok("shareLabels(0,2) is empty", shareLabels(0, 2).length === 0);
}

// ---------------------------------------------------------------------------
// QR chunking
// ---------------------------------------------------------------------------
console.log("\n-- custody: QR chunking (1 code maxes ~2953 bytes) --");
ok("QR_MAX_BYTES is the documented cap", QR_MAX_BYTES === 2953);
{
  // A small payload fits one code.
  const small = planQrChunks(200);
  ok("200-byte payload -> 1 code", small.total === 1 && small.ranges.length === 1);
  ok("the single range covers the whole payload", small.ranges[0]!.start === 0 && small.ranges[0]!.end === 200);

  // An empty payload still yields a single (empty) code so the UI renders something.
  const empty = planQrChunks(0);
  ok("empty payload -> 1 (empty) code", empty.total === 1 && empty.ranges[0]!.start === 0 && empty.ranges[0]!.end === 0);

  // The blueprint figure: ~4.3 KB base64 of the ~3.2 KB key. base64 of 3200 bytes is
  // ceil(3200/3)*4 = 4268 chars (no-pad ~ 4267); the worst-case 4.3 KB is ~4404.
  const base64Bytes = 4404; // ~4.3 KB base64 (worst case from the blueprint)
  const plan = planQrChunks(base64Bytes, QR_MAX_BYTES);
  ok("~4.3 KB base64 -> 2 codes at the 2953-byte cap", plan.total === 2);
  // At a robust error-correction level the per-code budget is lower (~1852 bytes for
  // alphanumeric, less for byte mode); the blueprint says "about three". Confirm a robust
  // budget yields 3 codes.
  const robust = planQrChunks(base64Bytes, 1500);
  ok("~4.3 KB base64 -> 3 codes at a robust per-code budget", robust.total === 3);

  // The ranges must TILE the payload exactly: contiguous, non-overlapping, covering [0,len).
  let contiguous = true;
  let covered = 0;
  let prevEnd = 0;
  for (const r of plan.ranges) {
    if (r.start !== prevEnd) contiguous = false;
    covered += r.end - r.start;
    prevEnd = r.end;
  }
  ok("ranges are contiguous (no gap, no overlap)", contiguous);
  ok("ranges cover exactly the payload length", covered === base64Bytes && prevEnd === base64Bytes);
  ok("each range is labelled with its 1-based index", plan.ranges.every((r, i) => r.label === `Code ${i + 1} of ${plan.total}`));
}

// ---------------------------------------------------------------------------
// recovery-sheet NO-SECRET invariant (the no-custody crux)
// ---------------------------------------------------------------------------
console.log("\n-- custody: recovery-sheet content carries NO secret --");

// A realistic ceremony fixture. The identityB64 and signer.privateB64 are the SECRETS that
// must never appear in any recovery-sheet output. We use distinctive sentinel strings so a
// leak is unambiguous.
const SECRET_IDENTITY = "SENTINEL_BREAKGLASS_PRIVATE_IDENTITY_B64_must_never_appear";
const SECRET_SIGNER_PRIV = "SENTINEL_SIGNER_PRIVATE_B64_must_never_appear";
const ceremony: CeremonyResult = {
  breakGlass: { identityB64: SECRET_IDENTITY, recipientPublicB64: "BREAK_PUBLIC", fingerprint: "dpr1:aabbcc" },
  operational: null,
  signer: { privateB64: SECRET_SIGNER_PRIV, publicB64: "SIGNER_PUBLIC", fingerprint: "edmldsa1:112233" },
  configRecipient: { identityB64: "SENTINEL_CONFIG_PRIVATE_must_never_appear", recipientPublicB64: "CONFIG_PUBLIC", fingerprint: "dpr1:c0ffee" },
  configWrapKeyB64: "SENTINEL_CONFIG_WRAP_KEY_must_never_appear",
};

// Build a real split alongside, so we can assert that the actual ciphertext, wrapping key
// and share bytes (the things the component downloads) never bleed into the sheet metadata.
async function main(): Promise<void> {
  const plaintext = new TextEncoder().encode(`downpipe-identity-v1 ${SECRET_IDENTITY}\n`);
  const env = await encrypt(plaintext);
  const shares = shamirSplit(env.wrappingKey, 5, 3);
  const wrappingKeyB64 = b64urlEncode(env.wrappingKey);
  const ciphertextB64 = b64urlEncode(env.ciphertext);
  const shareB64s = shares.map((s) => b64urlEncode(s));

  // The set of strings that are SECRETS and must never appear in sheet output.
  const secretsThatMustNotAppear = [
    SECRET_IDENTITY,
    SECRET_SIGNER_PRIV,
    wrappingKeyB64,
    ciphertextB64,
    ...shareB64s,
  ];

  // Custody metadata with real custodian names (public; an auditor wants these recorded).
  const signoffs = makeSplitSignoffs(5).map((s, i) => ({ ...s, holder: `Custodian ${i + 1} Name`, signedOn: "2026-06-09" }));
  const splitMeta: CustodyMetadata = { scheme: "mofn-split", n: 5, threshold: 3, signoffs };

  // 1. custodyMetadataLines: records scheme/counts/holders, no secret.
  const metaLines = custodyMetadataLines(splitMeta).join("\n");
  ok("custodyMetadataLines records the scheme label", metaLines.includes("M-of-N custodian split"));
  ok("custodyMetadataLines records the 3 of 5 split", metaLines.includes("3 of 5"));
  ok("custodyMetadataLines records a custodian holder name", metaLines.includes("Custodian 1 Name"));
  for (const secret of secretsThatMustNotAppear) {
    ok(`custodyMetadataLines does not leak a secret (${secret.slice(0, 16)}...)`, !metaLines.includes(secret));
  }
  // "undecided" yields no lines (so the sheet omits the section honestly).
  ok("custodyMetadataLines('undecided') is empty", custodyMetadataLines({ scheme: "undecided", signoffs: [] }).length === 0);

  // 2. splitReadme: instructions only, no secret.
  const readme = splitReadme(5, 3);
  ok("splitReadme names the threshold and total", readme.includes("any 3 of the 5"));
  ok("splitReadme lists the per-custodian share filenames", readme.includes("downpipe-share-1-of-5.txt") && readme.includes("downpipe-share-5-of-5.txt"));
  for (const secret of secretsThatMustNotAppear) {
    ok(`splitReadme does not leak a secret (${secret.slice(0, 16)}...)`, !readme.includes(secret));
  }
  await readmeAloneRecovers(readme);

  // 3. recoverySheet (text) with the split custody block: records the scheme + sign-off,
  //    leaks no secret.
  const params: SheetParams = {
    downpipeAccount: "acme-production",
    createdAt: "2026-06-09T00:00:00Z",
    posture: "break-glass-only",
    custody: splitMeta,
  };
  const textSheet = recoverySheet(ceremony, params);
  ok("text recovery sheet includes the custody scheme", textSheet.includes("M-of-N custodian split"));
  ok("text recovery sheet includes the custodian sign-off", textSheet.includes("Custodian 1 Name") && textSheet.includes("2026-06-09"));
  ok("text recovery sheet still includes the public fingerprints", textSheet.includes("dpr1:aabbcc"));
  for (const secret of secretsThatMustNotAppear) {
    ok(`text recovery sheet does not leak a secret (${secret.slice(0, 16)}...)`, !textSheet.includes(secret));
  }

  // 4. recoverySheetHTML with the split custody block: same, plus escaping.
  const htmlSheet = recoverySheetHTML(ceremony, params);
  ok("HTML recovery sheet includes the custody scheme", htmlSheet.includes("M-of-N custodian split"));
  ok("HTML recovery sheet includes a custodian holder name", htmlSheet.includes("Custodian 1 Name"));
  for (const secret of secretsThatMustNotAppear) {
    ok(`HTML recovery sheet does not leak a secret (${secret.slice(0, 16)}...)`, !htmlSheet.includes(secret));
  }

  // 4b. Custodian display name escaping: an operator-entered hostile holder name must be
  // escaped in the HTML rendering (it is interpolated into a table cell).
  const hostileHolder = '<img src=x onerror=alert(1)>&"';
  const hostileMeta: CustodyMetadata = {
    scheme: "mofn-split",
    n: 2,
    threshold: 2,
    signoffs: [
      { shareIndex: 1, holder: hostileHolder, signedOn: "2026-06-09" },
      { shareIndex: 2, holder: "Plain Holder" },
    ],
  };
  const hostileHtml = recoverySheetHTML(ceremony, { ...params, custody: hostileMeta });
  ok("hostile custodian name is not present verbatim in HTML", !hostileHtml.includes(hostileHolder));
  ok("hostile custodian name is HTML-escaped (&lt; / &amp; / &quot;)", hostileHtml.includes("&lt;img") && hostileHtml.includes("&amp;") && hostileHtml.includes("&quot;"));

  // 5. Tier 1/2 custody block: single-holder sign-off, no split, no secret.
  const tier1Meta: CustodyMetadata = { scheme: "password-manager", signoffs: [{ shareIndex: 1, holder: "Vault Owner", signedOn: "2026-06-09" }] };
  const tier1Sheet = recoverySheet(ceremony, { ...params, custody: tier1Meta });
  ok("Tier 1 sheet records the password-manager scheme", tier1Sheet.includes("Corporate password manager"));
  ok("Tier 1 sheet records the single holder", tier1Sheet.includes("Vault Owner"));
  for (const secret of secretsThatMustNotAppear) {
    ok(`Tier 1 sheet does not leak a secret (${secret.slice(0, 16)}...)`, !tier1Sheet.includes(secret));
  }

  // 6. A sheet with NO custody metadata omits the section entirely (back-compat).
  const plainSheet = recoverySheet(ceremony, { downpipeAccount: "x", createdAt: "y", posture: "break-glass-only" });
  ok("a sheet without custody omits the custody section", !plainSheet.includes("Break-glass custody scheme"));
  // And an explicit "undecided" likewise omits it.
  const undecidedSheet = recoverySheet(ceremony, { downpipeAccount: "x", createdAt: "y", posture: "break-glass-only", custody: { scheme: "undecided", signoffs: [] } });
  ok("a sheet with an undecided scheme omits the custody section", !undecidedSheet.includes("Break-glass custody scheme"));

  console.log(failures === 0 ? "\nCUSTODY VALIDATORS PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

// readmeAloneRecovers is the off-console fallback, driven. RECOVER-SPLIT.txt step 2 offers "a compatible
// Shamir-over-GF(256) tool" as the fallback to the console. A readme that did not say what the tool had to
// read would leave that fallback needing the console source. This recovers a real ceremony's output using
// ONLY numbers and names read out of the readme text, with its own GF(2^8) arithmetic, SHA-256 and AES-GCM
// rather than the console's. If the readme drops or misstates a fact, a lookup below finds nothing or the
// recovered bytes differ.
//
// The file syntax comes from the readme too. The version lines, the comment prefix, the separator and every
// label are read out of the readme text, and the files are split by a parser built from those facts alone.
// Base64url is decoded with Node's own decoder, not the console's. A test that parsed the files with the
// console's syntax would pass whether or not the readme states it.
async function readmeAloneRecovers(readme: string): Promise<void> {
  const num = (re: RegExp): number => {
    const m = readme.match(re);
    return m ? Number.parseInt(m[1]!, m[1]!.startsWith("0x") ? 16 : 10) : Number.NaN;
  };
  const poly = num(/polynomial (0x[0-9a-f]+)/);
  const shareLen = num(/of\s+(\d+) bytes: 1 index byte/);
  const sumLen = num(/first (\d+) bytes of\s+SHA-256/);
  const ivLen = num(/(\d+)-byte IV/);
  const tagLen = num(/last (\d+) bytes are the GCM tag/);
  const label = readme.match(/"(downpipes:[^"]+)"/)?.[1];
  ok("readme states the field polynomial, the share length, the checksum length and label, and the IV and tag lengths",
    [poly, shareLen, sumLen, ivLen, tagLen].every(Number.isFinite) && label !== undefined);
  ok("readme states the x values run from 1 to N", readme.includes("x values:    1 to 5."));

  // The line syntax, as the readme states it.
  const versions = readme.match(/version line: (\S+) in a\s+share file, (\S+) in (\S+)\. Each/);
  const sepWords = readme.match(/data line is its label, (.+?), then the value/)?.[1];
  const commentPrefix = readme.match(/Lines that start\s+with (\S) are comments/)?.[1];
  const shareLabel = readme.match(/the '([\w-]+)' line is base64url \(RFC 4648/)?.[1];
  const sumLabel = readme.match(/the '([\w-]+)' line is base64url of the first/)?.[1];
  const ivLabel = readme.match(/has an '([\w-]+)' line \(base64url of the/)?.[1];
  const ctLabel = readme.match(/and a\s+'([\w-]+)' line \(base64url; the last/)?.[1];
  ok("readme states each file's version line, the comment prefix and the separator",
    versions !== null && commentPrefix !== undefined && sepWords === "one space");
  ok("readme names the share, checksum, iv and ciphertext labels",
    [shareLabel, sumLabel, ivLabel, ctLabel].every((l) => l !== undefined));
  const sep = sepWords === "one space" ? " " : "\u0000";
  const [, shareVersion = "", envVersion = "", envName = ""] = versions ?? [];

  const { split, wrappingKeyChecksum } = await import("../src/lib/shamir.ts");
  const { serialiseShareFile, serialiseEnvelopeFile, identityPlaintext } = await import("../src/lib/custody-files.ts");
  const { createHash, webcrypto } = await import("node:crypto");

  // A real ceremony's artefacts, as the operator downloads them.
  const plaintext = identityPlaintext({ breakGlass: { identityB64: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo" } });
  const env = await encrypt(plaintext);
  const shares = split(env.wrappingKey, 5, 3);
  const checksum = wrappingKeyChecksum(env.wrappingKey);
  const files = shares.map((share, i) => serialiseShareFile({ index: i + 1, n: 5, threshold: 3, checksum, share }));
  const envFile = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
  ok("the readme names the ciphertext file the ceremony writes", envName === CIPHERTEXT_FILENAME);

  // A parser built only from the readme's syntax: skip blank lines and comments, check the version line,
  // then split each data line at the first separator. A line the readme's syntax does not cover fails.
  const fieldsOf = (text: string, version: string): Map<string, string> | null => {
    const lines = text.split("\n").filter((l) => l.trim() !== "" && !(commentPrefix !== undefined && l.startsWith(commentPrefix)));
    if (lines[0] !== version) return null;
    const out = new Map<string, string>();
    for (const l of lines.slice(1)) {
      const at = l.indexOf(sep);
      if (at <= 0) return null;
      out.set(l.slice(0, at), l.slice(at + sep.length));
    }
    return out;
  };
  const shareFields = files.map((f) => fieldsOf(f, shareVersion));
  const envFields = fieldsOf(envFile, envVersion);
  ok("every share file parses with the readme's syntax", shareFields.every((f) => f !== null));
  ok("the ciphertext file parses with the readme's syntax", envFields !== null);
  const b64 = (v: string | undefined): Uint8Array => new Uint8Array(Buffer.from(v ?? "", "base64url"));

  // GF(2^8) over the polynomial the readme names, written here rather than imported.
  const mul = (a: number, b: number): number => {
    let r = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) r ^= a;
      b >>= 1;
      a <<= 1;
      if (a & 0x100) a ^= poly;
    }
    return r & 0xff;
  };
  const inv = (a: number): number => {
    let r = 1;
    for (let i = 0; i < 254; i++) r = mul(r, a);
    return r;
  };
  // Custodians 2, 4 and 5: any three of five, read from the 'share' line only.
  const picked = [1, 3, 4].map((i) => b64(shareFields[i]?.get(shareLabel ?? "")));
  ok("each share is the length the readme states", picked.every((p) => p.length === shareLen));
  const key = new Uint8Array(shareLen - 1);
  for (let b = 0; b < key.length; b++) {
    let acc = 0;
    for (const pj of picked) {
      let w = 1;
      for (const pm of picked) if (pm !== pj) w = mul(w, mul(pm[0]!, inv(pm[0]! ^ pj[0]!)));
      acc ^= mul(pj[1 + b]!, w);
    }
    key[b] = acc;
  }
  ok("the readme's share format recombines the wrapping key", Buffer.from(key).equals(Buffer.from(env.wrappingKey)));

  const digest = createHash("sha256").update(Buffer.from(label ?? "", "ascii")).update(key).digest().subarray(0, sumLen);
  ok("the readme's checksum recipe matches the 'checksum' line", digest.equals(Buffer.from(b64(shareFields[0]?.get(sumLabel ?? "")))));

  const iv = b64(envFields?.get(ivLabel ?? ""));
  ok("the 'iv' line is the length the readme states", iv.length === ivLen);
  const aes = await webcrypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const out = new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv), tagLength: tagLen * 8 }, aes, new Uint8Array(b64(envFields?.get(ctLabel ?? "")))));
  ok("the readme's decrypt recipe returns the identity.key text", Buffer.from(out).equals(Buffer.from(plaintext)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
