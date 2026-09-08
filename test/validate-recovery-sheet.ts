// Validate the invariants of src/recovery-sheet.ts that are required for correct
// break-glass recovery and no-custody HTML safety.
//
// Run with `node test/validate-recovery-sheet.ts` after `npm install`.
// Prints one line per check; exits non-zero on any failure.
//
// The printed restore command must include --apply in both the plaintext rendering (recoverySheet) and
// the HTML rendering (recoverySheetHTML). Without --apply the command is a dry run and writes nothing, so
// an operator following the sheet verbatim would silently fail to recover their data.
//
// A record name containing HTML metacharacters (<, >, &, ") must be escaped in the HTML rendering. The
// no-custody + HTML-escape guarantee documented in the recoverySheetHTML comment is verified here so a
// careless edit cannot reopen an injection path.
//
// The CeremonyResult fixture below uses static strings -- no crypto is required.

import { recoverySheet, recoverySheetHTML } from "../src/recovery-sheet.ts";
import type { CeremonyResult } from "../src/keygen.ts";
import type { SheetParams } from "../src/recovery-sheet.ts";
import { makeChecks } from "./validate-checks.ts";

const checks = makeChecks();
const { ok } = checks;

// ---------------------------------------------------------------------------
// Minimal CeremonyResult fixture (fingerprints only; no private key bytes).
// ---------------------------------------------------------------------------
const ceremony: CeremonyResult = {
  breakGlass: {
    identityB64: "BREAK_IDENTITY",
    recipientPublicB64: "BREAK_PUBLIC",
    fingerprint: "dpr1:aabbcc",
  },
  operational: {
    identityB64: "OP_IDENTITY",
    recipientPublicB64: "OP_PUBLIC",
    fingerprint: "dpr1:ddeeff",
  },
  signer: {
    privateB64: "SIGNER_PRIVATE",
    publicB64: "SIGNER_PUBLIC",
    fingerprint: "edmldsa1:112233",
  },
};

const params: SheetParams = {
  downpipeAccount: "acme-production",
  createdAt: "2026-01-01T00:00:00Z",
  posture: "two-recipient",
};

// ---------------------------------------------------------------------------
// CON-H1: --apply present in both renderings.
// ---------------------------------------------------------------------------
console.log("\n-- --apply flag in restore command --");

// The COMMAND line, not any prose that mentions the command. A later change added a warning sentence
// reading "downpipe verify and downpipe restore both refuse to start without --signer" ABOVE the
// command, and the old find() took the first line containing "downpipe restore", so it graded the
// prose and reported the sheet broken while the sheet was correct. The command is identified by the
// flags it must carry (--archive and --run), which prose does not. Both renderings are then asserted
// to hold EXACTLY ONE such line, so the next prose addition cannot shadow the command either way.
const isRestoreCommand = (l: string): boolean =>
  l.includes("downpipe restore") && l.includes("--archive") && l.includes("--run");

const textSheet = recoverySheet(ceremony, params);
ok("plaintext rendering contains --apply", textSheet.includes("--apply"));
const textRestoreLines = textSheet.split("\n").filter(isRestoreCommand);
ok("plaintext sheet prints exactly one restore command", textRestoreLines.length === 1);
ok(
  "plaintext restore line contains --apply",
  textRestoreLines[0]?.includes("--apply") ?? false,
);

const htmlSheet = recoverySheetHTML(ceremony, params);
// The HTML rendering uses &lt; and &gt; for the placeholders, so search for the
// literal restore command text, not for < > angle brackets.
ok("HTML rendering contains --apply", htmlSheet.includes("--apply"));

// THE PRINTED PAGE MARGIN MUST BE OURS, NOT THE BROWSER'S. This sheet is handed to window.print() and
// exists as no artefact anywhere, so nothing in the PDF work that graded the website's 27 documents and
// the engine's reports could reach it. Until it declared NO @page rule at all and its print
// block zeroed the body margin, so every millimetre came from whatever the browser defaulted to:
// rendered through headless Chrome the sheet has a 30.5pt top margin, about 10.5mm, on a 612x792
// US Letter sheet the browser picked for an Australian product. With `@page { margin: 16mm }` the same
// render measures 47.8pt. The assertion is on the EMITTED HTML rather than on a rendered page because
// that string is the artefact this module actually ships, and a test that needs a browser is a test
// that gets skipped.
//
// `size` is deliberately NOT asserted and deliberately NOT set: a recovery sheet is printed once by a
// customer on whatever paper is in their tray, and forcing a size is how it comes out scaled or clipped.
const pageRule = /@page\s*\{([^}]*)\}/.exec(htmlSheet);
// TWO RULES THAT COST A CUSTOMER A FILENAME, both found by rasterising the sheet and reading it, and
// neither visible to any measurement of the page. `word-break: break-all` on code breaks a word at the
// line end ALWAYS, whether it needed to or not, and this sheet is almost entirely filenames: it split
// "downpipe" as "downpi|pe", "signer.pub" as "sign|er.pub" and "identity.key" as "id|entity.key", which
// are the exact strings someone in a recovery is scanning for. And the two .warn boxes, the only
// stop-and-read content here, were splitting across the page break with no border at either end.
ok("code wrapping never breaks a word that would have fitted", !htmlSheet.includes("word-break: break-all"));
ok("the stop-and-read warning boxes are kept whole across a page break", /\.warn\s*\{[^}]*break-inside:\s*avoid/.test(htmlSheet));
ok("HTML rendering declares an @page rule", pageRule !== null);
const pageMargin = pageRule === null ? null : /margin:\s*([0-9.]+)\s*(mm|cm|in|pt)/.exec(pageRule[1] ?? "");
ok("the @page rule declares a margin", pageMargin !== null);
ok(
  "the declared page margin is not zero, so it is a chosen margin and not an inherited one",
  pageMargin !== null && Number(pageMargin[1]) > 0,
);
// The command lives inside a <pre> block; confirm --apply appears on that line. The old predicate
// was "downpipe restore" OR "--apply", which any line carrying --apply satisfied, so the assertion
// beneath it could pass without a restore command being present at all. Same isRestoreCommand as
// the plaintext half, and the same exactly-one count.
const htmlRestoreLines = htmlSheet.split("\n").filter(isRestoreCommand);
ok("HTML sheet prints exactly one restore command", htmlRestoreLines.length === 1);
ok(
  "HTML restore command line contains --apply",
  htmlRestoreLines[0]?.includes("--apply") ?? false,
);

// ---------------------------------------------------------------------------
// CON-H3: HTML metacharacter escaping in the HTML rendering.
// ---------------------------------------------------------------------------
console.log("\n-- HTML-escape of metacharacters in HTML rendering --");

// Build a ceremony and params where the account label contains all four
// HTML metacharacter classes the spec requires: < > & "
const hostileLabel = '<script>alert("xss")&boom</script>';
const hostileParams: SheetParams = {
  downpipeAccount: hostileLabel,
  createdAt: "2026-01-01T00:00:00Z",
  posture: "break-glass-only",
};

const hostileHtml = recoverySheetHTML(ceremony, hostileParams);

// No raw < or > may appear EXCEPT in the surrounding HTML tags themselves.
// We extract just the text content of the Account/label table cell and verify
// it contains only escaped forms.
//
// The cell is rendered as:
//   <tr><th>Account/label</th><td>${escapeHTML(p.downpipeAccount)}</td></tr>
// Extract from that line.
const accountRow = hostileHtml
  .split("\n")
  .find((l) => l.includes("Account/label"));
ok("account row is present in hostile HTML", accountRow !== undefined);
if (accountRow !== undefined) {
  // The raw characters must not appear literally in the cell value.
  // We look at the content between </th><td> and </td></tr>.
  const cellMatch = accountRow.match(/<\/th><td>(.*?)<\/td>/);
  ok("account cell content is extractable", cellMatch !== null);
  if (cellMatch !== null) {
    const cell = cellMatch[1] ?? "";
    ok("raw < is not in escaped cell", !cell.includes("<"));
    ok("raw > is not in escaped cell", !cell.includes(">"));
    ok("raw & is replaced by &amp;", cell.includes("&amp;"));
    ok('raw " is replaced by &quot;', cell.includes("&quot;"));
    // The original hostile string should not appear verbatim.
    ok(
      "hostile label does not appear verbatim in cell",
      !cell.includes(hostileLabel),
    );
  }
}

// Also verify that the hostile label does not appear verbatim anywhere in the
// rendered HTML (belt-and-braces: covers any future interpolation site).
ok(
  "hostile label does not appear verbatim anywhere in the HTML document",
  !hostileHtml.includes(hostileLabel),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  checks.failures === 0
    ? "\nRECOVERY SHEET VALIDATORS PASS"
    : `\n${checks.failures} FAILURE(S)`,
);
if (checks.failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (checks.failures > 0) process.exit(1);
