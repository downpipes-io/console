// The key ceremony's file and record helpers, shared by the setup surface's actions (actions.ts) and the Keys
// screen's re-download: the audit intent marker taken before the ceremony runs, the recovery-sheet
// parameters, the printable sheet, the burst of ceremony downloads and the one-file download. Each is total:
// a browser that refuses a file or a tab says so, and nothing here throws past its caller.
//
// Moved here from the retired first-run deck (screens/onboarding/shared.ts) unchanged in behaviour.

import { toast } from "../../components/toast.ts";
import { identityFile, recipientFile, signerPublicFile, type CeremonyResult } from "../../keygen.ts";
import { recoverySheet, recoverySheetHTML, type SheetParams } from "../../recovery-sheet.ts";
import type { ClientDiagSurface } from "../client-diag/vocab.ts";
import type { CustodyMetadata } from "../custody.ts";
import { deliverFile, openHtmlTab } from "../file-delivery.ts";
import { getEngine, getEngineUrl } from "../store.ts";

// recordCeremonyIntent records the key-ceremony INTENT in the audit log, best-effort and
// Owner-gated server-side. It records ONLY that a ceremony was STARTED, never a value or a fingerprint.
//
// It is called at the ATTEMPT, before the ceremony runs, not after it succeeds, so a ceremony that throws
// (no WebCrypto, a hardened browser) still leaves an audit trail distinguishable from one where the operator
// never pressed the button: an intent event with no keys installed is a ceremony that did not complete, and
// no intent event at all is a ceremony nobody started. The word "intent" is exact for a marker taken at the
// attempt.
//
// A missing audit store (or a non-Owner caller) simply means no entry, an honest degrade and never a
// surfaced error. That POST goes through the one engine seam, so a failure to record the marker is itself
// carried into the pack as a closed-class engine-call fault.
export function recordCeremonyIntent(): void {
  const engine = getEngine();
  if (!engine) return;
  void engine.recordAuditIntent("key-ceremony-intent").catch(() => {
    // No-op: the audit store may not be present, or the caller may not be Owner.
    // The ceremony is complete regardless; the intent marker is additive.
  });
}

// sheetParams builds the recovery-sheet metadata (the account label, the creation time,
// and the active posture worded to match the ceremony). The break-glass-only posture is
// the stronger default (no operational private on the engine). The optional custody
// argument carries the chosen offline custody scheme + custodian sign-off (public metadata
// only; never a key or share value), included only once a scheme is chosen.
export function sheetParams(result: CeremonyResult, custody?: CustodyMetadata): SheetParams {
  const includeCustody = custody !== undefined && custody.scheme !== "undecided";
  return {
    downpipeAccount: hostLabel(),
    createdAt: new Date().toISOString(),
    posture: result.operational ? "two-recipient" : "break-glass-only",
    ...(includeCustody ? { custody } : {}),
  };
}

export function hostLabel(): string {
  const url = getEngineUrl();
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      // fall through to the console host
    }
  }
  return location.host;
}

// openRecoverySheetWith opens the self-contained, public-only recovery sheet in a new tab through the guarded
// blob-tab primitive (lib/file-delivery.ts). The sheet document has its own opaque origin, so it is
// independent of the console's Content-Security-Policy, and its print button uses addEventListener rather
// than an inline onclick, so no unsafe-hashes exemption is needed. The sheet carries only PUBLIC
// fingerprints; no private key material is placed into the HTML (see the NO-CUSTODY assertion in
// recoverySheetHTML).
//
// A browser that refuses the blob tab says so and reports a closed-class capability fault into the support
// pack, instead of leaving the operator looking at a tab that never opened.
export function openRecoverySheetWith(result: CeremonyResult, custody?: CustodyMetadata): boolean {
  const opened = openHtmlTab(recoverySheetHTML(result, sheetParams(result, custody)), "recovery-sheet");
  if (!opened) {
    toast({ tone: "warn", message: "Your browser would not open the recovery sheet. Download recovery-sheet.txt instead, or allow this site to open new tabs." });
  }
  return opened;
}

// downloadCeremonyFiles delivers the four (or five, with an operational key) ceremony files. identity.key is
// the break-glass private the operator keeps OFFLINE; it is never sent anywhere. Each is a local blob
// download, the visible evidence that the private key materialised locally rather than via an upload.
//
// The signer private is NOT a file here. It installs straight to the engine in the POST /admin/keys/install
// body, as the operational private does. A signer.key download left a forgery-capable signing key in the
// operator's Downloads folder, outside the account, and nothing in the console ever read it back.
//
// It returns the names of the files the browser REFUSED, and it keeps going after a refusal rather than
// abandoning the rest of the burst, because a refusal is a delivery failure and not a ceremony failure: the
// keys already exist regardless of whether the browser accepted the download. The caller names the files
// that did not arrive and offers them again, and each refusal is a closed-class capability fault in the
// pack. The names returned are product constants, and they are used only to word the on-screen message;
// nothing about a file's CONTENT is read, held or recorded.
//
// custody is OPTIONAL and additive: when the operator chose a custody scheme BEFORE generating (the unified
// setup surface asks in that order), the first recovery-sheet.txt records it, so there is no stale sheet to
// re-download. Absent, the sheet is byte-identical to before (sheetParams omits an undecided scheme).
export function downloadCeremonyFiles(result: CeremonyResult, custody?: CustodyMetadata): string[] {
  // Each file carries the SURFACE it belongs to. All but the last are the key ceremony itself, and losing any
  // of them (identity.key above all) is a recoverability failure. The last, the recovery sheet, holds only public
  // fingerprints, so a browser that refuses it costs the customer a printable record and not their backups.
  // Those are different tickets, so they are different rows.
  const files: Array<[string, string, ClientDiagSurface]> = [
    ["identity.key", identityFile(result.breakGlass), "key-ceremony"],
    ["recipient.pub", recipientFile(result.breakGlass), "key-ceremony"],
    ...(result.operational ? ([["operational.pub", recipientFile(result.operational), "key-ceremony"]] as Array<[string, string, ClientDiagSurface]>) : []),
    ["signer.pub", signerPublicFile(result.signer), "key-ceremony"],
    ["recovery-sheet.txt", recoverySheet(result, sheetParams(result, custody)), "recovery-sheet"],
  ];
  const refused: string[] = [];
  for (const [name, content, surface] of files) {
    // deliverFile is total (it never throws), so one refusal cannot abandon the files after it. The per-file
    // toast is skipped here: a burst of refusals is ONE fault to state, which the caller does.
    if (!deliverFile(name, content, "text/plain", surface)) refused.push(name);
  }
  return refused;
}

// downloadText delivers one file through the guarded primitive and returns whether the browser accepted it.
// On a refusal it says so, because a recovery file that never arrived is the failure the operator must not
// discover months later, when they need it.
export function downloadText(name: string, content: string, surface: ClientDiagSurface): boolean {
  const delivered = deliverFile(name, content, "text/plain", surface);
  if (!delivered) {
    toast({ tone: "warn", message: `Your browser did not save ${name}. Check its download settings, then try again.` });
  }
  return delivered;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
