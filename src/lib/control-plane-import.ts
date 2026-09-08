// The "recover an estate from a signed export" flow. A bootstrapped
// Owner on a FRESH engine pastes the signed control-plane export (JSON) they pulled from a surviving
// destination bucket, its detached signature, and their recovery-kit signer.pub; the engine re-imports the
// estate DEFINITION verified against that pub (TAMPER EVIDENCE, never an authority root). It GRANTS NO
// AUTHORITY -- roles / IdP / policy are re-established by hand from the checklist -- and a cross-account import
// lands its downpipes disabled for rebind. The parse is a pure, testable function; the orchestrator injects
// the callbacks. No secret is handled here: the export is no-custody and the signer.pub is a PUBLIC key.

import type { EngineClient, EstateImportResult } from "../api.ts";
import { recordRecoveryRefusal } from "./client-diag/ring.ts";
import { looksLikeControlPlaneExport } from "./control-plane-recovery.ts";
import { withRefusalCode, type RecoveryRefusalCode } from "./recovery-refusal-codes.ts";

// EstateImportInput is the validated payload ready to send: the parsed export artefact (an opaque object the
// console forwards verbatim, never re-serialised), its detached signature, and the recovery-kit signer.pub.
export interface EstateImportInput {
  exportArtefact: unknown;
  signature: string;
  signerPublic: string;
}

export type ParseEstateImportResult =
  | { ok: true; value: EstateImportInput }
  | { ok: false; error: string; code: RecoveryRefusalCode };

// parseEstateImportInput validates the recover-an-estate form: the export JSON must parse and look like a
// control-plane export, and the detached signature and the kit signer.pub must be present. It returns a
// friendly, specific error for each failure (operator-input mistakes, not a security boundary -- the engine
// verifies the signature against the pub and re-asserts no-custody). The export is returned as the opaque
// parsed value, never re-serialised, so the bytes the engine signed are preserved by forwarding `export: value`.
//
// Each rejection now also carries a STABLE REFUSAL CODE, stamped into the message the operator reads. These
// rejections happen entirely in the browser: they never reach the engine, so on a fresh or wiped engine
// mid-disaster the code in front of the operator is the only trace of them that exists anywhere, and it is
// the one thing they can read out to support verbatim (lib/recovery-refusal-codes.ts).
export function parseEstateImportInput(raw: { exportText: string; signatureText: string; signerPublicText: string }): ParseEstateImportResult {
  const exportText = raw.exportText.trim();
  const signature = raw.signatureText.trim();
  const signerPublic = raw.signerPublicText.trim();
  // These rejections are decided IN THE BROWSER and never reach the engine, so no engine-side record of
  // them can exist even in principle. The ring is the only witness there can be, and the code it carries is the
  // same frozen token the operator is reading on screen.
  const refuse = (message: string, code: RecoveryRefusalCode): ParseEstateImportResult => {
    recordRecoveryRefusal("estate-import", code);
    return { ok: false, error: withRefusalCode(message, code), code };
  };
  if (exportText === "") return refuse("Paste the signed control-plane export JSON (the …/_RECOVERY/CONTROL-PLANE/<version>-<time>.json file from your destination bucket).", "DP-R01");
  let exportArtefact: unknown;
  try {
    exportArtefact = JSON.parse(exportText);
  } catch {
    return refuse("The export is not valid JSON. Paste the whole .json file exactly as it is in the bucket.", "DP-R02");
  }
  if (!looksLikeControlPlaneExport(exportArtefact)) {
    return refuse("That JSON does not look like a control-plane export (expected a v:1 artefact with downpipes, destinations and a prior audit head).", "DP-R03");
  }
  if (signature === "") return refuse("Paste the detached signature (the matching …json.sig file from your destination bucket).", "DP-R04");
  if (signerPublic === "") return refuse("Paste your recovery kit's signer.pub (the downpipe-signer-public-v1 line) so the engine can verify the export against your own key.", "DP-R05");
  return { ok: true, value: { exportArtefact, signature, signerPublic } };
}

// runEstateImport relays a validated import to the engine. A refusal (a wrong signer.pub, a bad signature, a
// non-Owner 403, a non-fresh plane, or a no-custody refusal) surfaces through onError; success through onDone
// with the counts. The engine is the enforcement point; this is a friendly relay.
export async function runEstateImport(
  engine: EngineClient,
  input: EstateImportInput,
  hooks: { onError: (msg: string) => void; onDone: (result: EstateImportResult) => void },
): Promise<void> {
  try {
    const result = await engine.controlPlaneImport(input.exportArtefact, input.signature, input.signerPublic);
    hooks.onDone(result);
  } catch (err) {
    hooks.onError(err instanceof Error ? err.message : String(err));
  }
}
