// The 200 { deleted: false } branch of POST /admin/downpipes/delete, on both screens that render it
// (the downpipes detail drawer and the map drawer). The engine answers this when the record it was
// asked to remove is not there under that id, so the honest reading is "not found", not "nothing was
// deleted" with no reason and no next step. This drives the REAL screen functions against a fake
// engine answering deleted:false, and grades the rendered toast: it must say the record was not
// found, and it must tell the operator to check the refreshed view, not only report that a refresh
// happened.
//
//   node test/validate-delete-not-found-copy.ts

import { flushAsync, installDomShim } from "./dom-shim.ts";

installDomShim();

import type { Downpipe, EngineClient, MutationResult } from "../src/api.ts";
import type { FlowRecord } from "../src/components/topology.ts";
import { buildMapDrawer } from "../src/screens/map/drawer.ts";
import { deleteDownpipe as screenDeleteDownpipe } from "../src/screens/sources-downpipes/detail-actions.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const DP: Downpipe = {
  id: "dp-1",
  name: "General ledger",
  cadenceSeconds: 86400,
  enabled: true,
  source: { type: "r2", binding: "SRC_R2", include: [], exclude: [] },
};

// toast.ts holds its live region as a module singleton that this file never tears down between
// sub-tests (it is the one stable region a real page would also reuse), so both lookups below read
// the LAST matching node, which is always the one the current block just produced.
function lastMatch<T extends { textContent: string | null }>(nodes: T[]): T | undefined {
  return nodes[nodes.length - 1];
}
function lastToastText(): string {
  return lastMatch([...document.querySelectorAll(".toast__msg")])?.textContent ?? "";
}
// Once a confirm modal opens over the drawer's own "Delete downpipe" action button, both carry the
// same label and the modal (mounted last) sits last in document order, so the last match is the one
// to click, on both the first click (the drawer button) and the second (the modal's confirm button).
function clickLastButtonNamed(text: string): void {
  const btn = lastMatch([...document.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(text)));
  (btn as unknown as { click: () => void } | undefined)?.click();
}

async function main(): Promise<void> {
  console.log("-- PR-01: the downpipes detail drawer's deleted:false toast --");
  {
    const engine = {
      deleteDownpipe: async (): Promise<MutationResult<{ deleted: boolean }>> => ({ status: "applied", value: { deleted: false } }),
    } as unknown as EngineClient;
    const del = screenDeleteDownpipe(engine, DP, () => {}, () => {});
    await flushAsync();
    clickLastButtonNamed("Delete downpipe");
    await del;
    await flushAsync();
    const msg = lastToastText();
    ok("the toast names the downpipe", msg.includes("General ledger"));
    ok("the toast says the record was not found (the reason, not just a report of a refresh)", /not found/i.test(msg));
    ok("the toast tells the operator what to do next (check the refreshed list)", /\bcheck\b/i.test(msg));
    ok("the old copy's bare report-only sentence is gone", !/The engine reported nothing was deleted/i.test(msg));
  }

  console.log("\n-- PR-03: the map drawer's deleted:false toast, the SAME engine branch --");
  {
    const engine = {
      deleteDownpipe: async (): Promise<MutationResult<{ deleted: boolean }>> => ({ status: "applied", value: { deleted: false } }),
      listHistory: () => Promise.resolve([]),
      rosterHygiene: () => Promise.resolve({ ghosts: [], neverRan: [], ghostCount: 0 }),
    } as unknown as EngineClient;
    const flow: FlowRecord = {
      id: "dp-1",
      source: { name: "KV_uploads", kind: "kv" },
      destination: { name: "R2_archive", kind: "r2" },
      status: "healthy",
      enabled: true,
      running: false,
    };
    const lastData = {
      downpipes: { ok: true, value: [{ config: { ...DP }, nextRunAt: null, lastRunId: null, inFlight: false }] },
    } as unknown as Parameters<typeof buildMapDrawer>[1]["lastData"];
    const deps = { engine, lastData, onClose: () => {}, refresh: () => {}, canDelete: true, canReconcile: true };
    buildMapDrawer(flow, deps);
    await flushAsync();
    clickLastButtonNamed("Delete downpipe");
    await flushAsync();
    clickLastButtonNamed("Delete downpipe");
    await flushAsync();
    const msg = lastToastText();
    ok("the map toast names the downpipe", msg.includes("General ledger"));
    ok("the map toast says the record was not found", /not found/i.test(msg));
    ok("the map toast tells the operator to check the refreshed map", /\bcheck\b/i.test(msg) && /map/i.test(msg));
    ok("the old report-only sentence is gone", !/The engine reported nothing was deleted/i.test(msg));
  }

  console.log(`\n${checks - failures}/${checks} ok`);
  console.log(`VERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=${import.meta.filename}`);
  verdictReached(failures, checks);
  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("BOTH DELETED:FALSE TOASTS NAME WHY AND WHAT TO DO NEXT");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
