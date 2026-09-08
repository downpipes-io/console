// Validates the estate-import helper (src/lib/control-plane-import.ts): the pure parse (parseEstateImportInput)
// and the injected-relay orchestrator (runEstateImport) -- success and an engine refusal -- with no DOM and no
// network. Run: node test/validate-control-plane-import.ts

import { parseEstateImportInput, runEstateImport } from "../src/lib/control-plane-import.ts";
import type { EngineClient, EstateImportResult } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(`${label} (=${JSON.stringify(expected)})`, actual === expected);
}

const VALID_EXPORT = {
  v: 1,
  exportedAt: "2026-07-05T00:00:00.000Z",
  configContentHash: "sha384:x",
  downpipes: [],
  destinations: [],
  roles: [],
  priorAuditHead: { headSeq: 0, headHash: "sha384:0" },
};
const VALID_EXPORT_TEXT = JSON.stringify(VALID_EXPORT);

console.log("estate-import: parseEstateImportInput (pure)");
{
  const good = parseEstateImportInput({ exportText: `  ${VALID_EXPORT_TEXT}  `, signatureText: "  the-sig  ", signerPublicText: "  downpipe-signer-public-v1 AAAA  " });
  ok("parse: a well-formed trio is accepted", good.ok === true);
  if (good.ok) {
    eq(good.value.signature, "the-sig", "signature is trimmed");
    eq(good.value.signerPublic, "downpipe-signer-public-v1 AAAA", "signer.pub is trimmed");
    ok("parse: export is the parsed object (not the raw string)", typeof good.value.exportArtefact === "object" && (good.value.exportArtefact as { v: number }).v === 1);
  }
  ok("parse: an empty export is rejected", parseEstateImportInput({ exportText: "  ", signatureText: "s", signerPublicText: "p" }).ok === false);
  ok("parse: non-JSON is rejected", parseEstateImportInput({ exportText: "{bad", signatureText: "s", signerPublicText: "p" }).ok === false);
  ok("parse: JSON that is not a control-plane export is rejected", parseEstateImportInput({ exportText: '{"v":2}', signatureText: "s", signerPublicText: "p" }).ok === false);
  ok("parse: an empty signature is rejected", parseEstateImportInput({ exportText: VALID_EXPORT_TEXT, signatureText: "  ", signerPublicText: "p" }).ok === false);
  ok("parse: an empty signer.pub is rejected", parseEstateImportInput({ exportText: VALID_EXPORT_TEXT, signatureText: "s", signerPublicText: "  " }).ok === false);
}

console.log("estate-import: runEstateImport (injected relay)");
{
  const result: EstateImportResult = { ok: true, downpipes: 2, destinations: 1, downpipesDisabled: true, authorityImported: false, bridgedFrom: { headSeq: 5, headHash: "sha384:h" } };
  const engineOk = { controlPlaneImport: async () => result } as unknown as EngineClient;
  const done: EstateImportResult[] = [];
  let errored = "";
  await runEstateImport(engineOk, { exportArtefact: VALID_EXPORT, signature: "s", signerPublic: "p" }, { onError: (m) => { errored = m; }, onDone: (r) => done.push(r) });
  ok("run: success fires onDone with the counts", done.length === 1 && done[0]!.downpipes === 2 && done[0]!.downpipesDisabled === true && done[0]!.authorityImported === false);
  eq(errored, "", "run: success does not fire onError");

  const engineErr = { controlPlaneImport: async () => { throw new Error("the import was refused: wrong signer.pub"); } } as unknown as EngineClient;
  const done2: EstateImportResult[] = [];
  let errored2 = "";
  await runEstateImport(engineErr, { exportArtefact: VALID_EXPORT, signature: "s", signerPublic: "p" }, { onError: (m) => { errored2 = m; }, onDone: (r) => done2.push(r) });
  ok("run: an engine refusal fires onError with the message, not onDone", /wrong signer\.pub|refused/.test(errored2) && done2.length === 0);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-control-plane-import (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
