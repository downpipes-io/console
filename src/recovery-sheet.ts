import type { CeremonyResult } from "./keygen.ts";
import { escapeHTML } from "./escape.ts";
import { custodyMetadataLines, schemeLabel, type CustodyMetadata } from "./lib/custody.ts";

// The recovery sheet is the printed artefact from the key ceremony (SPEC 2, 9, 12.4). It
// records the fingerprints, the active posture, the out-of-band anti-rollback pin field,
// and the plain-language instruction that the break-glass private key is the only way to
// recover and must be kept offline. It deliberately does NOT contain any private key.
//
// WHAT THE SHEET IS NOT (corrected). The sheet carries FINGERPRINTS, not key material,
// so a customer holding only the printed sheet holds neither signer.pub nor recipient.pub. That
// matters because verify and restore both hard-require --signer and exit ExitUsage without it, and
// the signer public key is nowhere in the archive to fall back on. Until this change the sheet named
// exactly one file to keep (identity.key) and then twice told the reader to paste "this signer.pub"
// as though the sheet carried it, so a customer who followed it exactly could not restore. The sheet
// now states plainly that the kit is two files and that the sheet alone is not sufficient. It still
// carries no key material, which is deliberate and unchanged.
//
// It also records the chosen offline custody scheme and the custodian sign-off lines (who
// holds which share, signed and dated). That metadata is PUBLIC by construction: it is
// scheme labels, counts, thresholds, custodian display names and dates, never a key, a
// share value, a wrapping key or a ciphertext (see src/lib/custody.ts). The sign-off lines
// give an auditor a record of who holds what without ever exposing the material itself.

export interface SheetParams {
  downpipeAccount: string;
  createdAt: string;
  posture: "two-recipient" | "break-glass-only";
  // The chosen offline custody scheme + custodian sign-off (public metadata only). Optional
  // (exactOptionalPropertyTypes): present only once the operator chooses a scheme. When
  // absent or "undecided" the section is omitted rather than printed misleadingly.
  custody?: CustodyMetadata;
}

export function recoverySheet(c: CeremonyResult, p: SheetParams): string {
  const lines: string[] = [];
  lines.push("downpipe recovery sheet");
  lines.push("=======================");
  lines.push("");
  lines.push(`Account/label:   ${p.downpipeAccount}`);
  lines.push(`Created:         ${p.createdAt}`);
  lines.push(`Posture:         ${p.posture}`);
  lines.push("");
  lines.push("Fingerprints (public; safe to record here):");
  lines.push(`  break-glass:   ${c.breakGlass.fingerprint}`);
  if (c.operational) lines.push(`  operational:   ${c.operational.fingerprint}`);
  lines.push(`  signer:        ${c.signer.fingerprint}`);
  lines.push("");
  // The chosen offline custody scheme + custodian sign-off. Public metadata only; the
  // pure builder in lib/custody.ts cannot emit a key or share value. Omitted entirely when
  // no scheme has been chosen (custodyMetadataLines returns []).
  if (p.custody) {
    const custodyLines = custodyMetadataLines(p.custody);
    if (custodyLines.length > 0) {
      for (const l of custodyLines) lines.push(l);
      lines.push("");
    }
  }
  lines.push("Anti-rollback high-water mark (write the latest RUNLOG index here after each");
  lines.push("run you trust, and pass it to restore as --min-runlog-index):");
  lines.push("  min-runlog-index: ____________");
  lines.push("");
  lines.push("THE BREAK-GLASS PRIVATE KEY IS THE ONLY WAY TO RECOVER.");
  lines.push("Keep the downloaded identity.key file OFFLINE and safe. It was generated in");
  lines.push("your browser and was never sent to the engine or the vendor. If you lose it,");
  lines.push("the backups cannot be recovered. Consider splitting it across several offline");
  lines.push("holders.");
  lines.push("If you set a CONFIG_WRAP_KEY (to encrypt destination credentials at rest),");
  lines.push("keep a copy of it too, stored SEPARATELY from identity.key.");
  lines.push("");
  lines.push("THIS SHEET IS NOT ENOUGH ON ITS OWN. YOUR RECOVERY KIT IS TWO FILES.");
  lines.push("Keep signer.pub, the file the key ceremony downloaded, WITH this sheet.");
  lines.push("downpipe verify and downpipe restore both refuse to start without --signer,");
  lines.push("and signer.pub is not written into the archive and cannot be rebuilt from it,");
  lines.push("so an archive plus identity.key plus this sheet alone cannot be restored.");
  lines.push("signer.pub is a PUBLIC key: it decrypts nothing, so it is safe to store beside");
  lines.push("this sheet. The fingerprints above are how you confirm you hold the right");
  lines.push("files; they are not the files themselves.");
  lines.push("");
  lines.push("To recover your DATA with neither Cloudflare nor the vendor, using the");
  lines.push("destination bucket and both files from your kit:");
  lines.push("  downpipe restore --apply --archive <dir> --run <runId> \\");
  lines.push("      --identity identity.key --signer signer.pub --out <dir> \\");
  lines.push("      --min-runlog-index <value from the field above, if you filled it in>");
  lines.push("If you have not yet recorded a min-runlog-index above, drop that line and add");
  lines.push("--acknowledge-no-rollback-pin instead, to silence the warning for this first");
  lines.push("recovery. Rollback protection stays off either way until a pin exists.");
  lines.push("This sheet carries no run ID. To find one, from the archive alone:");
  lines.push("  downpipe keys --which --archive <dir>");
  lines.push("");
  lines.push("To recover your ENVIRONMENT (the downpipes, destinations and settings, not just");
  lines.push("the archived data) after losing your account: deploy a fresh engine, sign in as");
  lines.push('Owner, then Settings > Backup configuration > "Recover an estate from a signed');
  lines.push('export". Paste the signed export from _RECOVERY/CONTROL-PLANE/ in your bucket,');
  lines.push("its .sig, and the signer.pub file from your kit. The engine verifies the export");
  lines.push("against your signer key (fingerprint above) and imports the definition only.");
  lines.push("It grants NO operator access: re-grant roles and reconnect identity providers");
  lines.push("by hand.");
  lines.push("Downpipes from a different Cloudflare account arrive disabled until you re-point");
  lines.push("each source.");
  lines.push("");
  lines.push("If your export is SEALED (a .sealed.json file, the default), paste it into that");
  lines.push("same console form as-is, together with its .sig and that same signer.pub file.");
  lines.push("The console verifies the signature and opens the sealed export in your browser");
  lines.push("with identity.key (or a reassembled M-of-N quorum); your key is never uploaded,");
  lines.push("and only the recovered definition is sent on to the engine to import.");
  lines.push("");
  return lines.join("\n");
}

// recoverySheetHTML renders the same recovery sheet as a self-contained printable page.
// Inline styles are deliberate: the document is opened as a blob URL in a new tab and
// must print without the console's stylesheet. Like the text sheet it records only PUBLIC
// fingerprints and never a private key. Every interpolated value is escaped even though
// the fingerprints are generated locally, so a hostile account label pasted by the
// operator can never inject markup into the print window.
//
// The print button uses an addEventListener bound by a small inline <script> at the end
// of the body. The blob document has its own opaque origin and is not subject to the
// console's Content-Security-Policy, so no unsafe-hashes or special CSP exemption is
// required on the console side.
//
// NO-CUSTODY assertion: this function places only PUBLIC fingerprints and metadata into
// the HTML. The CeremonyResult fields used are:
//   c.breakGlass.fingerprint  -- public (the fingerprint of the public key)
//   c.operational.fingerprint -- public (same)
//   c.signer.fingerprint      -- public (same)
// The custody block (p.custody) is also public metadata only: scheme labels, the M-of-N
// counts, custodian display names and dates, built by lib/custody.ts which never touches a
// key or share value. Custodian names are operator-entered strings and are escaped.
// No private key bytes (breakGlass.identityB64, signer.privateB64, etc.) are referenced
// or interpolated anywhere in this function.
export function recoverySheetHTML(c: CeremonyResult, p: SheetParams): string {
  return [
    sheetHeadHTML(),
    "<body>",
    '<div class="printbtn"><button id="print-btn">Print this sheet</button></div>',
    "<h1>downpipe recovery sheet</h1>",
    sheetIdentityTableHTML(p),
    sheetFingerprintTableHTML(c),
    custodySectionHTML(p.custody),
    sheetAntiRollbackHTML(),
    sheetRecoveryHTML(),
    sheetEstateRecoveryHTML(),
    // The print button handler is attached via addEventListener so no inline event handler
    // attribute is needed. The blob document has its own opaque origin and is not bound by
    // the console CSP, so this script runs without any special CSP exemption.
    '<script>document.getElementById("print-btn").addEventListener("click", function() { window.print(); });</script>',
    "</body>",
    "</html>",
  ].join("\n");
}

// sheetHeadHTML is the doctype + head + inline styles. Inline styles are deliberate: the blob
// document prints without the console stylesheet.
function sheetHeadHTML(): string {
  return [
    "<!doctype html>",
    '<html lang="en-AU">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>downpipe recovery sheet</title>",
    "<style>",
    "  :root { color-scheme: light; }",
    "  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #111; background: #fff; margin: 2.5rem auto; max-width: 46rem; padding: 0 1.5rem; }",
    "  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }",
    "  h2 { font-size: 1.05rem; margin: 1.15rem 0 0.4rem; border-bottom: 1px solid #ccc; padding-bottom: 0.2rem; }",
    "  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }",
    "  th, td { text-align: left; padding: 0.35rem 0.6rem; border: 1px solid #ddd; vertical-align: top; }",
    "  th { width: 9rem; background: #f5f5f5; font-weight: 600; }",
    // overflow-wrap: anywhere, NOT word-break: break-all. break-all breaks a word at the line end
    // ALWAYS, whether or not it needed to, and this sheet is almost entirely filenames and commands:
    // rendered through headless Chrome it split "downpipe" as "downpi|pe", "signer.pub" as "sign|er.pub"
    // and "identity.key" as "id|entity.key". Those are the exact strings a customer in a recovery is
    // scanning the page for, and a filename broken across two lines is one they will not find. anywhere
    // keeps the reason break-all was here (a long base64 fingerprint must still be allowed to wrap
    // rather than run off the sheet) and gives up nothing else: it breaks only when the word cannot fit.
    "  code { overflow-wrap: anywhere; }",
    // break-inside: avoid, because these two boxes are the sheet's only STOP-AND-READ content and both
    // were splitting across the page break: the box ran off the foot of page 1 with no bottom border and
    // resumed at the head of page 2 with no top border, so the thing drawing the eye to it was missing at
    // both ends. A warning that is cut in half reads as a layout accident rather than as a warning.
    "  .warn { border: 2px solid #b00; background: #fff5f5; padding: 0.7rem 0.9rem; margin: 0.7rem 0; break-inside: avoid; }",
    "  .warn strong { color: #b00; }",
    "  pre { background: #f5f5f5; border: 1px solid #ddd; padding: 0.75rem; overflow-x: auto; white-space: pre-wrap; }",
    "  .pin { border: 1px dashed #888; padding: 0.6rem 0.8rem; margin: 0.5rem 0; }",
    "  .pin .field { display: inline-block; min-width: 14rem; border-bottom: 1px solid #111; height: 1.2rem; }",
    "  .printbtn { margin: 1rem 0; }",
    "  .printbtn button { font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; }",
    // THE PAGE MARGIN IS DECLARED HERE, and `size` deliberately is NOT. Before this rule the sheet
    // declared no @page at all and the print block zeroed the body margin, so every millimetre of the
    // printed margin was whatever the browser happened to default to: for example, headless Chrome sits at
    // 30.5pt top and 45.7pt left on a 612x792 sheet, i.e. US Letter chosen by the browser for an
    // Australian product, with a top margin of about 10.5mm that was neither chosen nor visible.
    // 16mm is ours and is the same on every browser. `size` is left alone ON PURPOSE so the customer's
    // own paper (A4 here, Letter elsewhere) is still respected: a recovery sheet is printed once, by a
    // customer, on whatever is in their tray, and forcing a size is how it comes out scaled or clipped.
    "  @page { margin: 16mm; }",
    "  @media print { .printbtn { display: none; } body { margin: 0; max-width: none; padding: 0; } }",
    "</style>",
    "</head>",
  ].join("\n");
}

// sheetIdentityTableHTML is the account/created/posture table (every value escaped).
function sheetIdentityTableHTML(p: SheetParams): string {
  return [
    "<table>",
    `<tr><th>Account/label</th><td>${escapeHTML(p.downpipeAccount)}</td></tr>`,
    `<tr><th>Created</th><td>${escapeHTML(p.createdAt)}</td></tr>`,
    `<tr><th>Posture</th><td>${escapeHTML(p.posture)}</td></tr>`,
    "</table>",
  ].join("\n");
}

// sheetFingerprintTableHTML is the public fingerprint table (the operational row is present only
// when a two-recipient posture has an operational key).
function sheetFingerprintTableHTML(c: CeremonyResult): string {
  const operationalRow = c.operational
    ? `<tr><th>operational</th><td><code>${escapeHTML(c.operational.fingerprint)}</code></td></tr>`
    : "";
  return [
    "<h2>Fingerprints (public; safe to record here)</h2>",
    "<table>",
    `<tr><th>break-glass</th><td><code>${escapeHTML(c.breakGlass.fingerprint)}</code></td></tr>`,
    operationalRow,
    `<tr><th>signer</th><td><code>${escapeHTML(c.signer.fingerprint)}</code></td></tr>`,
    "</table>",
  ].join("\n");
}

// sheetAntiRollbackHTML is the out-of-band high-water-mark pin field plus the keep-offline warning.
function sheetAntiRollbackHTML(): string {
  return [
    "<h2>Anti-rollback high-water mark</h2>",
    "<p>Write the latest RUNLOG index here after each run you trust, and pass it to restore as <code>--min-runlog-index</code>:</p>",
    '<div class="pin">min-runlog-index: <span class="field">&nbsp;</span></div>',
    '<div class="warn">',
    "<p><strong>THE BREAK-GLASS PRIVATE KEY IS THE ONLY WAY TO RECOVER.</strong></p>",
    "<p>Keep the downloaded <code>identity.key</code> file OFFLINE and safe. It was generated in your browser and was never sent to the engine or the vendor. If you lose it, the backups cannot be recovered. Consider splitting it across several offline holders.</p>",
    "<p>If you set a <code>CONFIG_WRAP_KEY</code> (to encrypt destination credentials at rest), keep a copy of it too, stored <strong>separately</strong> from <code>identity.key</code>.</p>",
    "</div>",
    '<div class="warn">',
    "<p><strong>THIS SHEET IS NOT ENOUGH ON ITS OWN. YOUR RECOVERY KIT IS TWO FILES.</strong></p>",
    "<p>Keep <code>signer.pub</code>, the file the key ceremony downloaded, <strong>with this sheet</strong>. <code>downpipe verify</code> and <code>downpipe restore</code> both refuse to start without <code>--signer</code>, and <code>signer.pub</code> is not written into the archive and cannot be rebuilt from it, so an archive plus <code>identity.key</code> plus this sheet alone cannot be restored.</p>",
    "<p><code>signer.pub</code> is a <strong>public</strong> key: it decrypts nothing, so it is safe to store beside this sheet. The fingerprints above are how you confirm you hold the right files; they are not the files themselves.</p>",
    "</div>",
  ].join("\n");
}

// sheetRecoveryHTML is the offline-recovery section, with the CLI commands kept verbatim from the
// text sheet so the printed page and the .txt say the same thing.
//
// PRECISION: this section does NOT claim a printed copy alone is sufficient. It is not. verify and
// restore both hard-require --signer (downpipe/cmd/downpipe/verify.go:32, restore.go:61, both ExitUsage
// without it), the sheet carries FINGERPRINTS rather than key material, and the signer public key is
// absent from the archive: the recovery bundle written to the bucket is FORMAT.md and RECOVER.md only
// (engine/src/format/bundle.ts), and the signed root manifest records signingKeyFingerprint, not the key
// (downpipe/internal/spec/manifest.go). The kit is identity.key plus signer.pub, and the sheet now says
// so in the warning block above. Printing the signer public key itself was considered and rejected: at
// ed25519(32) + ML-DSA-87(2592) = 2624 bytes it is 3,499 base64url characters, which is not something a
// person retypes correctly during an incident.
function sheetRecoveryHTML(): string {
  const restoreCommand =
    "downpipe restore --apply --archive &lt;dir&gt; --run &lt;runId&gt; \\\n" +
    "    --identity identity.key --signer signer.pub --out &lt;dir&gt; \\\n" +
    "    --min-runlog-index &lt;value from the field above, if you filled it in&gt;";
  return [
    "<h2>Offline data recovery</h2>",
    "<p>To recover your data with neither Cloudflare nor the vendor, using the destination bucket and both files from your kit:</p>",
    `<pre>${restoreCommand}</pre>`,
    "<p>If you have not yet recorded a <code>min-runlog-index</code> above, drop that last line and add <code>--acknowledge-no-rollback-pin</code> instead, to silence the warning for this first recovery. Rollback protection stays off either way until a pin exists.</p>",
    "<p>This sheet carries no run ID. To find one, from the archive alone (no identity, no signer):</p>",
    "<pre>downpipe keys --which --archive &lt;dir&gt;</pre>",
  ].join("\n");
}

// sheetEstateRecoveryHTML is the ENVIRONMENT-recovery section: how to rebuild the downpipes / destinations /
// settings (not just the data) on a fresh engine from the signed control-plane export verified against this
// signer.pub. Static, non-secret guidance; it grants no operator access, which the copy states plainly.
function sheetEstateRecoveryHTML(): string {
  return [
    "<h2>Environment recovery</h2>",
    "<p>To recover your Downpipes environment (the downpipes, destinations and settings, not just the archived data) after losing your account: deploy a fresh engine, sign in as Owner, then open <strong>Settings &rarr; Backup configuration &rarr; &ldquo;Recover an estate from a signed export&rdquo;</strong>. Paste the signed export from <code>_RECOVERY/CONTROL-PLANE/</code> in your bucket, its <code>.sig</code>, and the <code>signer.pub</code> file from your kit. The engine verifies the export against your signer key (the fingerprint above) and imports the definition only. It grants <strong>no operator access</strong>: re-grant roles and reconnect identity providers by hand. Downpipes imported from a different Cloudflare account arrive disabled until you re-point each source.</p>",
    "<p>If your export is <strong>sealed</strong> (a <code>.sealed.json</code> file, the default), paste it into that same console form as-is, together with its <code>.sig</code> and that same <code>signer.pub</code> file. The console verifies the signature and opens the sealed export in your browser with <code>identity.key</code> (or a reassembled M-of-N quorum); your key is never uploaded, and only the recovered definition is sent on to the engine to import.</p>",
  ].join("\n");
}

// custodySectionHTML renders the chosen custody scheme + custodian sign-off as an escaped
// HTML block for the printable sheet, or "" when no scheme is chosen (so the section is
// omitted rather than printed empty). PUBLIC metadata only: the scheme label, the M-of-N
// counts, the custodian display names (operator-entered, escaped) and the dates. It never
// interpolates a key, a share value, a wrapping key or a ciphertext; there is no field on
// CustodyMetadata that carries any of those. The blank holder/date cells use a printable
// underline so the sheet can be filled in by hand.
function custodySectionHTML(meta: CustodyMetadata | undefined): string {
  if (!meta || meta.scheme === "undecided") return "";
  const parts: string[] = [];
  parts.push("<h2>Break-glass custody scheme</h2>");
  parts.push("<table>");
  parts.push(`<tr><th>Scheme</th><td>${escapeHTML(schemeLabel(meta.scheme))}</td></tr>`);
  if (meta.scheme === "mofn-split" && meta.n !== undefined && meta.threshold !== undefined) {
    parts.push(...mofnSplitSignoffHTML(meta, meta.n, meta.threshold));
  } else {
    parts.push(...singleCustodianHTML(meta));
  }
  parts.push(
    "<p>This console generated every key and share in your browser. Nothing was transmitted to the engine or the vendor.</p>",
  );
  return parts.join("\n");
}

// signoffCell renders a holder/date cell: the escaped value, or a printable blank underline when
// the operator left it to be filled in by hand.
function signoffCell(value: string): string {
  return value.trim() === "" ? '<span class="field">&nbsp;</span>' : escapeHTML(value);
}

// mofnSplitSignoffHTML renders the M-of-N split summary and the per-share sign-off table (who
// holds which share). PUBLIC metadata only: counts, thresholds, custodian display names, dates.
function mofnSplitSignoffHTML(meta: CustodyMetadata, n: number, threshold: number): string[] {
  const parts: string[] = [];
  parts.push(
    `<tr><th>Split</th><td>${escapeHTML(`${threshold} of ${n}`)} (any ${escapeHTML(String(threshold))} of ${escapeHTML(String(n))} shares reconstruct the wrapping key)</td></tr>`,
  );
  parts.push("</table>");
  parts.push(
    "<p>The encrypted key file (ciphertext) is stored separately; on its own it carries no usable key. Each custodian holds exactly one share.</p>",
  );
  parts.push("<h2>Custodian sign-off</h2>");
  parts.push("<p>Who holds which share. Sign and date on transfer.</p>");
  parts.push("<table>");
  parts.push("<tr><th>Share</th><th>Holder</th><th>Signed / dated</th></tr>");
  const rows = meta.signoffs.length > 0
    ? meta.signoffs.map((s) => ({ share: `${s.shareIndex} of ${n}`, holder: s.holder, signed: s.signedOn ?? "" }))
    : Array.from({ length: n }, (_v, i) => ({ share: `${i + 1} of ${n}`, holder: "", signed: "" }));
  for (const r of rows) {
    parts.push(`<tr><td>${escapeHTML(r.share)}</td><td>${signoffCell(r.holder)}</td><td>${signoffCell(r.signed)}</td></tr>`);
  }
  parts.push("</table>");
  return parts;
}

// singleCustodianHTML renders the stored-in row (password manager or hardware USB), the optional
// public security-key credential handle, and the single-holder sign-off table.
function singleCustodianHTML(meta: CustodyMetadata): string[] {
  const parts: string[] = [];
  const where = meta.scheme === "password-manager"
    ? "the corporate password manager"
    : "the hardware-encrypted USB and paper companion";
  parts.push(`<tr><th>Stored in</th><td>${escapeHTML(where)}</td></tr>`);
  // If a security key (YubiKey PRF) was layered, record the PUBLIC credential handle so a
  // future restore knows which registered key to assert against. Escaped; it is a public
  // base64url handle, not a secret.
  if (meta.securityKeyCredentialIdB64 && meta.securityKeyCredentialIdB64.trim() !== "") {
    parts.push(
      `<tr><th>Security key</th><td>The wrapping key is derived on a registered security key. To decrypt later you need the ciphertext and a registered security key (enrol at least two). Credential id (PUBLIC, not a secret): <code>${escapeHTML(meta.securityKeyCredentialIdB64)}</code></td></tr>`,
    );
  }
  parts.push("</table>");
  parts.push("<h2>Custodian sign-off</h2>");
  parts.push("<p>Who holds it. Sign and date.</p>");
  parts.push("<table>");
  parts.push("<tr><th>Holder</th><th>Signed / dated</th></tr>");
  const rows = meta.signoffs.length > 0
    ? meta.signoffs.map((s) => ({ holder: s.holder, signed: s.signedOn ?? "" }))
    : [{ holder: "", signed: "" }];
  for (const r of rows) {
    parts.push(`<tr><td>${signoffCell(r.holder)}</td><td>${signoffCell(r.signed)}</td></tr>`);
  }
  parts.push("</table>");
  return parts;
}
