// Validates the "download your control-plane export" helper (src/lib/control-plane-export-download.ts): the
// pure file-building (exportDownloadFiles) and the injected-save orchestrator (runExportDownload) -- success,
// a malformed answer, and an engine error -- with no DOM and no network. Run: node test/validate-control-plane-export-download.ts

import { exportDownloadFiles, runExportDownload, type DownloadFile } from "../src/lib/control-plane-export-download.ts";
import type { EngineClient } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(`${label} (=${JSON.stringify(expected)})`, actual === expected);
}

// A stub engine whose controlPlaneExportDownload returns a canned answer or throws.
const engineReturning = (payload: unknown): EngineClient => ({ controlPlaneExportDownload: async () => payload }) as unknown as EngineClient;
const engineThrowing = (msg: string): EngineClient => ({ controlPlaneExportDownload: async () => { throw new Error(msg); } }) as unknown as EngineClient;

console.log("export-download: exportDownloadFiles (pure)");
{
  const files = exportDownloadFiles({ export: { v: 1, downpipes: [{ id: "dp1" }] }, signature: "the-detached-sig" });
  eq(files.length, 2, "two files (json + sig)");
  eq(files[0]!.name, "downpipes-control-plane-export.json", "json file name is stable");
  eq(files[1]!.name, "downpipes-control-plane-export.json.sig", "sig file name is stable");
  eq(files[0]!.type, "application/json", "json mime");
  eq(files[1]!.content, "the-detached-sig", "sig file carries the detached signature verbatim");
  ok("json content is pretty-printed and parses back to the export", (() => {
    try {
      const parsed = JSON.parse(files[0]!.content) as { v?: number; downpipes?: Array<{ id: string }> };
      return parsed.v === 1 && parsed.downpipes?.[0]?.id === "dp1" && files[0]!.content.includes("\n  ");
    } catch {
      return false;
    }
  })());
}

console.log("export-download: runExportDownload (success)");
{
  const saved: DownloadFile[] = [];
  let done = false;
  let errored = "";
  await runExportDownload(engineReturning({ export: { v: 1 }, signature: "sig-xyz" }), {
    save: (f) => saved.push(f),
    onError: (m) => { errored = m; },
    onDone: () => { done = true; },
  });
  eq(saved.length, 2, "success saves both files");
  ok("success calls onDone", done);
  eq(errored, "", "success does not call onError");
}

console.log("export-download: runExportDownload (malformed answer -> onError, nothing saved)");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  for (const bad of [{ export: { v: 1 }, signature: "" }, { export: null, signature: "sig" }, { export: undefined, signature: "sig" }]) {
    const saved: DownloadFile[] = [];
    let errored = "";
    let done = false;
    await runExportDownload(engineReturning(bad), { save: (f) => saved.push(f), onError: (m) => { errored = m; }, onDone: () => { done = true; } });
    ok(`a malformed answer (${JSON.stringify(bad)}) surfaces onError and saves nothing`, errored.length > 0 && saved.length === 0 && !done);
  }
}

console.log("export-download: runExportDownload (engine error -> onError with the message)");
{
  const saved: DownloadFile[] = [];
  let errored = "";
  await runExportDownload(engineThrowing("forbidden: access.policy required"), { save: (f) => saved.push(f), onError: (m) => { errored = m; }, onDone: () => {} });
  ok("an engine error surfaces its message and saves nothing", /forbidden|access\.policy/.test(errored) && saved.length === 0);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-control-plane-export-download (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
