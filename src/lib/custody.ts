// Pure, DOM-free logic for the offline break-glass custody experience.
// This is the load-bearing core the validator
// exercises: the tiered scheme model, the M-of-N parameter rules, the per-custodian
// share labelling, the QR chunking arithmetic (one QR maxes ~2953 bytes), and the
// construction of the recovery-sheet custody metadata and custodian sign-off lines.
//
// NO-CUSTODY, restated for this module: nothing here ever touches a key, a share value,
// a wrapping key or a ciphertext byte. It deals only in PUBLIC metadata: scheme ids,
// labels, counts, thresholds, custodian display names, dates and structural notes. The
// actual crypto (src/envelope.ts, src/shamir.ts, src/webauthn-prf.ts) runs in the
// component and only ever offers downloads; this module never sees the bytes. The
// recovery-sheet content built here therefore cannot carry a secret by construction, and
// the validator asserts exactly that.

// CustodyScheme is the tier the operator chose for the break-glass private. The four
// tiers mirror the tiered menu; "undecided" is the honest default before a
// choice is made, so the recovery sheet never claims a scheme that was not selected.
export type CustodyScheme =
  | "undecided"
  | "password-manager" // Tier 1: corporate vault (1Password / KeePassXC / Bitwarden attachment)
  | "encrypted-usb-paper" // Tier 2: hardware-encrypted USB + a printed/QR paper companion
  | "mofn-split"; // Tier 3: envelope-encrypt, Shamir-split the 256-bit wrapping key M-of-N

// SchemeOption is the static description of one tier for the menu. It carries only copy,
// never behaviour, so it is safe to render and trivial to test.
export interface SchemeOption {
  id: Exclude<CustodyScheme, "undecided">;
  label: string;
  summary: string; // one calm line describing the tier
  detail: string; // the concrete, copy-ready guidance
  assurance: "standard" | "cold" | "highest";
}

// SCHEME_OPTIONS is the ordered tiered menu (default-to-strong is conveyed by ordering and
// copy, not by hiding the simpler options). Tier 1 leads because it fits most teams; the
// split is last because it is the highest-assurance, highest-ceremony option.
export const SCHEME_OPTIONS: readonly SchemeOption[] = [
  {
    id: "password-manager",
    label: "Corporate password manager",
    summary: "Store the key file in your team's vault. Fits most teams.",
    detail:
      "1Password holds the file as a Document or note; KeePassXC is effectively unbounded. " +
      "Bitwarden caps a Secure Note at 10,000 characters, so use a file attachment there. " +
      "The key file may be stored as-is, or pre-encrypted first (defence in depth, since the vault also encrypts). " +
      "LastPass is not recommended for a high-value key.",
    assurance: "standard",
  },
  {
    id: "encrypted-usb-paper",
    label: "Encrypted USB plus a paper companion",
    summary: "Cold storage on a hardware-encrypted drive, with a printed or QR backup.",
    detail:
      "Hold the key file on a hardware-encrypted USB with a PIN keypad (for example Apricorn Aegis or an IronKey). " +
      "Add a printed companion, because unpowered flash can lose its charge in one to five years and paper is the decade-scale backup. " +
      "One QR code holds at most 2,953 bytes, so a larger key file needs two to three codes, or you can simply print the text.",
    assurance: "cold",
  },
  {
    id: "mofn-split",
    label: "M-of-N custodian split",
    summary: "Split custody across several holders, so no single person can recover alone.",
    detail:
      "The key file is not split directly. The console encrypts it in your browser with a fresh random 256-bit wrapping key, " +
      "splits only that wrapping key into N shares (any M of which reconstruct it), and offers the ciphertext and each share as separate downloads. " +
      "Give one share to each custodian and store the small ciphertext per Tier 1 or Tier 2. Recovery needs any M custodians plus the ciphertext.",
    assurance: "highest",
  },
] as const;

// schemeOption looks up a tier description by id. Returns undefined for "undecided" or an
// unknown id, so callers render the menu rather than a phantom selection.
export function schemeOption(id: CustodyScheme): SchemeOption | undefined {
  return SCHEME_OPTIONS.find((o) => o.id === id);
}

// schemeLabel is the short human label for a scheme, including the honest "undecided"
// wording the recovery sheet uses before a tier is chosen.
export function schemeLabel(id: CustodyScheme): string {
  if (id === "undecided") return "not yet chosen";
  return schemeOption(id)?.label ?? id;
}

// ---- M-of-N parameter rules -------------------------------------------------------
//
// The operator picks N (number of shares) and the threshold M. These bounds match
// src/shamir.ts exactly (2 <= threshold <= n <= 255), restated here as a pure validator so
// the UI can disable the action with a precise reason BEFORE any crypto runs. We cap N at a
// sane operational maximum (16) for the UI; shamir itself allows up to 255, but more than a
// handful of custodians is an operational anti-pattern, not a crypto limit.

export const MIN_SHARES = 2;
export const MAX_SHARES = 16;
// MIN_THRESHOLD is the smallest reconstruction threshold M. A threshold of 1 would let
// any single share recover the whole secret, so the minimum is 2.
export const MIN_THRESHOLD = 2;

export interface SplitParamsResult {
  ok: boolean;
  reason?: string; // present only when !ok (exactOptionalPropertyTypes)
  // refusedField names WHICH picker the ceremony refused, as the catalogued control id, and it is
  // present only when !ok. "The split button stays disabled" is one of the two commonest console tickets there
  // is no evidence for, and the answer down the phone is not "the parameters are invalid": it is "the threshold
  // you chose is larger than the share count" or "two shares is the floor". The share count and the threshold
  // THEMSELVES never ride into the diagnostics ring: they are the customer's own custody design and a
  // fingerprint of it. The field id is enough to say which edit fixes it.
  refusedField?: "custody-split-n" | "custody-split-threshold";
}

// validateSplitParams checks a chosen (n, threshold) pair and returns ok plus, only when
// invalid, a precise human reason. It never throws. threshold must be at least 2 (a
// threshold of 1 would make any single share the whole secret), at most n, and n must be
// within the UI bounds.
export function validateSplitParams(n: number, threshold: number): SplitParamsResult {
  if (!Number.isInteger(n)) {
    return { ok: false, reason: "Choose whole numbers for the share count and threshold.", refusedField: "custody-split-n" };
  }
  if (!Number.isInteger(threshold)) {
    return { ok: false, reason: "Choose whole numbers for the share count and threshold.", refusedField: "custody-split-threshold" };
  }
  if (n < MIN_SHARES) {
    return { ok: false, reason: `Use at least ${MIN_SHARES} shares; a single share would be the whole key.`, refusedField: "custody-split-n" };
  }
  if (n > MAX_SHARES) {
    return { ok: false, reason: `Use at most ${MAX_SHARES} shares.`, refusedField: "custody-split-n" };
  }
  if (threshold < MIN_THRESHOLD) {
    return { ok: false, reason: "The threshold must be at least 2, so no single share can recover alone.", refusedField: "custody-split-threshold" };
  }
  if (threshold > n) {
    return { ok: false, reason: "The threshold cannot exceed the number of shares.", refusedField: "custody-split-threshold" };
  }
  return { ok: true };
}

// ---- per-custodian share labelling ------------------------------------------------
//
// Each Shamir share is offered as a separate download with a clear, per-custodian label so
// the operator cannot mix them up. The label and filename carry ONLY the share index and
// the M-of-N parameters, never any share bytes. The filename is slug-safe.

export interface ShareLabel {
  index: number; // 1-based custodian/share number
  title: string; // human title, e.g. "Custodian 1 of 5 (any 3 reconstruct)"
  filename: string; // download filename, e.g. "downpipe-share-1-of-5.txt"
  note: string; // the per-custodian instruction line
}

// shareLabels builds the labels for all n shares of an M-of-N split. It is pure and
// deterministic. n and threshold are assumed already validated by validateSplitParams; it
// still guards defensively against a zero/negative n by returning an empty list.
export function shareLabels(n: number, threshold: number): ShareLabel[] {
  if (!Number.isInteger(n) || n < 1) return [];
  const out: ShareLabel[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      index: i,
      title: `Custodian ${i} of ${n} (any ${threshold} reconstruct)`,
      filename: `downpipe-share-${i}-of-${n}.txt`,
      note:
        `Give this single share to custodian ${i}. ` +
        `It is one of ${n} shares; any ${threshold} of them together reconstruct the wrapping key. ` +
        `One share alone reveals nothing. Keep it apart from the ciphertext and from the other shares.`,
    });
  }
  return out;
}

// ciphertextFilename / wrappedReadmeFilename are the fixed download names for the M-of-N
// envelope outputs (the small ciphertext that the shares unlock). Kept here so the
// component and the validator agree on the names.
export const CIPHERTEXT_FILENAME = "identity.key.enc";
export const SPLIT_README_FILENAME = "RECOVER-SPLIT.txt";

// ---- QR chunking ------------------------------------------------------------------
//
// A single QR code holds at most ~2,953 bytes (version 40, the lowest error-correction
// level). The Tier 2 paper companion may print the key file (or its ciphertext) as one or
// more QR codes. This pure helper computes how many codes a payload of a given byte length
// needs, and the byte ranges per code, so the component can render an honest "N codes"
// count and label each one. We chunk on raw bytes; the caller decides whether to QR the
// plaintext key file or the pre-encrypted ciphertext.

// QR_MAX_BYTES is the conservative single-QR capacity used for the count.
export const QR_MAX_BYTES = 2953;

export interface QrChunkPlan {
  total: number; // number of QR codes needed (>= 1 for any non-empty payload)
  ranges: Array<{ index: number; start: number; end: number; label: string }>; // 1-based codes
}

// planQrChunks returns the chunking plan for a payload of `byteLength` bytes at a chosen
// per-code capacity (default QR_MAX_BYTES). An empty payload yields a single empty code so
// the UI still has something to render with an honest label. It never throws.
export function planQrChunks(byteLength: number, perCode: number = QR_MAX_BYTES): QrChunkPlan {
  const cap = Number.isInteger(perCode) && perCode > 0 ? perCode : QR_MAX_BYTES;
  const len = Number.isInteger(byteLength) && byteLength > 0 ? byteLength : 0;
  const total = len === 0 ? 1 : Math.ceil(len / cap);
  const ranges: QrChunkPlan["ranges"] = [];
  for (let i = 0; i < total; i++) {
    const start = i * cap;
    const end = Math.min(start + cap, len);
    ranges.push({
      index: i + 1,
      start,
      end,
      label: `Code ${i + 1} of ${total}`,
    });
  }
  return { total, ranges };
}

// ---- recovery-sheet custody metadata ----------------------------------------------
//
// The recovery sheet records the chosen scheme and the custodian sign-off lines (who holds
// which share, signed and dated). This is PUBLIC metadata only. Custodian names are
// operator-entered display strings (e.g. "Alex Chen, Security"); they are not secret, and
// the recovery-sheet renderers escape them. A sign-off line never contains a share value.

// CustodianSignoff is one line of the sign-off table: which share, who holds it, and a
// space (or value) for the date it was handed over and signed. The `holder` and `signedOn`
// are operator-entered display strings; `signedOn` is optional (blank line to fill in by
// hand on the printed sheet).
export interface CustodianSignoff {
  shareIndex: number; // 1-based; which Shamir share this custodian holds
  holder: string; // display name / role of the custodian (NOT a secret)
  signedOn?: string; // date handed over and signed; optional (blank to fill in on paper)
}

// CustodyMetadata is the block the recovery sheet renders. For a non-split scheme the
// signoffs list is empty (there is one holder, the vault or the USB); for a split it
// carries one line per custodian. `n`/`threshold` are present only for the split scheme.
//
// securityKeyCredentialIdB64 is PUBLIC metadata recorded ONLY when a security key (YubiKey
// PRF) was layered over a Tier 1/2 encryption: it is the base64url credential handle the
// device returned at enrolment, so a future restore knows which registered key to assert
// against to re-derive the wrapping key. It is NOT a secret (it is also written, with the
// same plain note, into the ciphertext file); without it the security-key path is
// unrecoverable. It is never present for the split scheme (which Shamir-splits the key
// instead) or when no security key was used.
export interface CustodyMetadata {
  scheme: CustodyScheme;
  n?: number; // present only for mofn-split
  threshold?: number; // present only for mofn-split
  signoffs: CustodianSignoff[]; // empty unless mofn-split
  securityKeyCredentialIdB64?: string; // PUBLIC; present only when a security key was layered
}

// custodyMetadataLines renders the CustodyMetadata as plain text lines for the text
// recovery sheet. It returns an empty array for an "undecided" scheme so the sheet simply
// omits the section rather than printing a misleading placeholder. The lines contain only
// scheme labels, counts, custodian display names and dates: no key, no share, no
// ciphertext. This is the function the no-secret validator drives hardest.
export function custodyMetadataLines(meta: CustodyMetadata): string[] {
  if (meta.scheme === "undecided") return [];
  const lines: string[] = [];
  lines.push("Break-glass custody scheme:");
  lines.push(`  Scheme:          ${schemeLabel(meta.scheme)}`);
  if (meta.scheme === "mofn-split" && meta.n !== undefined && meta.threshold !== undefined) {
    lines.push(...mofnSplitMetaLines(meta, meta.n, meta.threshold));
  } else {
    lines.push(...singleHolderMetaLines(meta));
  }
  lines.push("");
  lines.push("  This console generated every key and share in your browser. Nothing was transmitted.");
  return lines;
}

// mofnSplitMetaLines renders the m-of-n split branch: the threshold line plus the per-share
// custodian sign-off table (a blank ruled table sized to N when no custodians are recorded).
function mofnSplitMetaLines(meta: CustodyMetadata, n: number, threshold: number): string[] {
  const lines: string[] = [];
  lines.push(`  Split:           ${threshold} of ${n} (any ${threshold} of ${n} shares reconstruct the wrapping key)`);
  lines.push("  The encrypted key file (ciphertext) is stored separately; it carries no usable key on its own.");
  lines.push("");
  lines.push("  Custodian sign-off (who holds which share; sign and date on transfer):");
  if (meta.signoffs.length === 0) {
    // No custodians recorded yet: print a blank ruled table sized to N so the printed
    // sheet can be filled in by hand. Still no secret.
    for (let i = 1; i <= n; i++) {
      lines.push(`    Share ${i} of ${n}:  holder: ____________________   signed/dated: ____________`);
    }
  } else {
    for (const s of meta.signoffs) {
      const holder = s.holder.trim() === "" ? "____________________" : s.holder;
      const signed = s.signedOn && s.signedOn.trim() !== "" ? s.signedOn : "____________";
      lines.push(`    Share ${s.shareIndex} of ${n}:  holder: ${holder}   signed/dated: ${signed}`);
    }
  }
  return lines;
}

// singleHolderMetaLines renders the Tier 1 / Tier 2 single-location branch: where the key is
// stored, an optional security-key credential handle, and a sign-off line.
function singleHolderMetaLines(meta: CustodyMetadata): string[] {
  const lines: string[] = [];
  const where =
    meta.scheme === "password-manager" ? "the corporate password manager" : "the hardware-encrypted USB and paper companion";
  lines.push(`  Stored in:       ${where}`);
  // If a security key (YubiKey PRF) was layered, record the PUBLIC credential handle so a
  // future restore knows which registered key to assert against. Not a secret.
  if (meta.securityKeyCredentialIdB64 && meta.securityKeyCredentialIdB64.trim() !== "") {
    lines.push("  A security key (YubiKey) derives the wrapping key. To decrypt later you need");
    lines.push("  the ciphertext AND a registered security key (enrol at least two).");
    lines.push(`  Security-key credential id (PUBLIC, not a secret): ${meta.securityKeyCredentialIdB64}`);
  }
  if (meta.signoffs.length > 0) {
    lines.push("  Custodian sign-off (who holds it; sign and date):");
    for (const s of meta.signoffs) {
      const holder = s.holder.trim() === "" ? "____________________" : s.holder;
      const signed = s.signedOn && s.signedOn.trim() !== "" ? s.signedOn : "____________";
      lines.push(`    holder: ${holder}   signed/dated: ${signed}`);
    }
  } else {
    lines.push("  Held by:         ____________________   signed/dated: ____________");
  }
  return lines;
}

// makeSplitSignoffs builds an initial sign-off list for an N-share split, one blank line
// per share, so the operator can fill holders in the UI. Pure and deterministic.
export function makeSplitSignoffs(n: number): CustodianSignoff[] {
  if (!Number.isInteger(n) || n < 1) return [];
  const out: CustodianSignoff[] = [];
  for (let i = 1; i <= n; i++) out.push({ shareIndex: i, holder: "" });
  return out;
}

// splitReadme is the plain-text RECOVER-SPLIT.txt that ships alongside the ciphertext and
// shares so a future operator understands how to reconstruct, WITHOUT any secret in it. It
// names the scheme, the threshold, and the offline recovery procedure. It deliberately
// contains no share, no wrapping key and no ciphertext.
export function splitReadme(n: number, threshold: number): string {
  const lines: string[] = [];
  lines.push("downpipe break-glass: M-of-N custody (recovery instructions)");
  lines.push("===========================================================");
  lines.push("");
  lines.push(`This break-glass key file was encrypted in the operator's browser with a random`);
  lines.push(`256-bit wrapping key. That wrapping key was split into ${n} shares using Shamir secret`);
  lines.push(`sharing; any ${threshold} of the ${n} shares reconstruct it. One share alone reveals nothing.`);
  lines.push("");
  lines.push("Files in this set (each was offered as a separate download):");
  lines.push(`  ${CIPHERTEXT_FILENAME}              the encrypted break-glass key file (no usable key on its own)`);
  for (let i = 1; i <= n; i++) {
    lines.push(`  downpipe-share-${i}-of-${n}.txt   custodian ${i}'s share (one of ${n}; keep apart)`);
  }
  lines.push("");
  lines.push("To recover:");
  lines.push(`  1. Gather any ${threshold} of the ${n} custodians and their shares.`);
  lines.push("  2. Reconstruct the wrapping key from the shares (the console's recovery flow, or a");
  lines.push("     compatible Shamir-over-GF(256) tool using the same share format).");
  lines.push("  3. Verify the reconstructed key BEFORE trusting it. Shamir cannot tell a correct");
  lines.push("     share from a mis-transcribed one, so a single wrong share silently yields a");
  lines.push("     wrong key. Each share file carries a short PUBLIC 'checksum' of the wrapping");
  lines.push("     key: recompute it from the reconstructed key and compare. If it does not");
  lines.push("     match, one of your shares is incorrect; re-check each share's text. The");
  lines.push("     authenticated decrypt in the next step is the final, authoritative check.");
  lines.push(`  4. Decrypt ${CIPHERTEXT_FILENAME} with the reconstructed wrapping key (AES-256-GCM) to`);
  lines.push("     obtain identity.key. A wrong key makes the authenticated decrypt fail rather");
  lines.push("     than return a corrupt file.");
  lines.push("  5. Use identity.key with the downpipe CLI to restore (see the recovery sheet).");
  lines.push("");
  lines.push("No key, share or wrapping key is written in this file. The vendor never held any of them.");
  lines.push("");
  return lines.join("\n");
}

// ---- YubiKey layering rules -------------------------------------------------------

// yubikeyAppliesTo reports whether the optional YubiKey PRF layer can sit on top of a
// chosen scheme. It layers on Tier 1 / Tier 2 (it derives the wrapping key that encrypts
// the file before it goes into the vault or onto the USB). For the M-of-N split the
// wrapping key is the thing being Shamir-split, so a PRF-derived key would defeat the
// split; the honest answer is that the layer does not apply there.
export function yubikeyAppliesTo(scheme: CustodyScheme): boolean {
  return scheme === "password-manager" || scheme === "encrypted-usb-paper";
}
