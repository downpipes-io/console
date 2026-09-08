// The "download your control-plane export" helper. The operator fetches a fresh signed export (built now
// against live state, the same no-custody artefact the engine fans to the destination buckets) and saves it
// -- the JSON plus its detached signature -- to keep alongside the recovery kit, so the kit's config
// inventory does not depend on later bucket access. The FILE-BUILDING is a pure function (exportDownloadFiles)
// and the orchestrator injects `save` (the browser download trigger) plus the callbacks, so the whole flow is
// unit-testable without a DOM or network. No secret is ever surfaced here: the engine's export is no-custody
// (secrets ride wrapped or as a reestablish marker, never plaintext), and the console never re-serialises the
// export's secret material -- it only pretty-prints what the engine returned.

import type { EngineClient } from "../api.ts";
import { recordRecoveryRefusal } from "./client-diag/ring.ts";
import { withRefusalCode } from "./recovery-refusal-codes.ts";

export interface DownloadFile {
  name: string;
  content: string;
  type: string;
}

// exportDownloadFiles turns the engine's { export, signature } answer into the two files the operator saves:
// the pretty-printed export JSON and its detached signature. Pure: no DOM, no network. The names are stable
// so a re-download overwrites the previous copy rather than accreting numbered duplicates.
export function exportDownloadFiles(payload: { export: unknown; signature: string }): DownloadFile[] {
  return [
    { name: "downpipes-control-plane-export.json", content: `${JSON.stringify(payload.export, null, 2)}\n`, type: "application/json" },
    { name: "downpipes-control-plane-export.json.sig", content: payload.signature, type: "text/plain" },
  ];
}

// runExportDownload fetches the current signed export and saves each file via the injected `save`. A missing
// or malformed answer, a non-owner 403, an Access redirect or a missing-signer 500 all surface through
// onError; success through onDone. `save` is injected so the pipeline is testable without a DOM.
export async function runExportDownload(
  engine: EngineClient,
  hooks: { save: (f: DownloadFile) => void; onError: (msg: string) => void; onDone: () => void },
): Promise<void> {
  try {
    const payload = await engine.controlPlaneExportDownload();
    if (payload.export === undefined || payload.export === null || typeof payload.signature !== "string" || payload.signature.length === 0) {
      // A 200 that carries no signed export is a MALFORMED ANSWER, not an empty estate: the engine's
      // signer is missing or its answer lost a field. The stable code says which failure this is, so a
      // customer whose only remaining artefact is this screen can quote it (lib/recovery-refusal-codes.ts).
      // A 200 with no signed export is its own refusal class, and it is the one the engine will not be
      // recording, because from its side the request succeeded.
      recordRecoveryRefusal("export-download", "DP-R14");
      hooks.onError(withRefusalCode("the engine answered, but returned no signed export. Its signer may not be installed.", "DP-R14"));
      return;
    }
    for (const f of exportDownloadFiles(payload)) hooks.save(f);
    hooks.onDone();
  } catch (err) {
    hooks.onError(err instanceof Error ? err.message : String(err));
  }
}

// saveFile is the thin DOM trigger (a Blob + a transient <a download> click), kept out of the testable core.
export function saveFile(f: DownloadFile): void {
  const url = URL.createObjectURL(new Blob([f.content], { type: f.type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
