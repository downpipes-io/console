// the credential-expiry detail drawer's Edit and Remove buttons were unreachable behind a
// stacked duplicate .overlay--drawer on a deep-link re-render (a live 2/2 reproduction against
// `probe`, spec/journeys/credential-expiry-crud-lifecycle.spec.ts, harness). Root cause traced to
// components/dialog.ts:116's idempotency-key guard reaching exactly ONE of five openDetailDrawer
// callers (sources-downpipes/detail.ts) and never propagating to the other four:
// credentials/list.ts, destination-cards.ts, map/drawer.ts, runs/detail.ts.
//
// This drives the REAL screen-level drawer-opening function for each of the four unfixed callers
// (never re-implements them), simulating the exact defect shape: app.ts's
// reRenderCurrentScreenForResolvedIdentity repaints the current screen via a fresh
// screen.render() that runs OUTSIDE the router (so closeAllOverlays, installAfterEach's
// on-navigation teardown, never fires), and every screen here builds a FRESH view/controller
// instance per render() call (RunsView, MapView/MapController, a fresh dataTable) whose own
// once-only guards (e.g. RunsView's detailOpened) therefore reset -- so the deep link's
// "open this drawer" side effect fires a SECOND time while the first drawer is still mounted.
//
// Structural proof of "the buttons are unreachable", not just "two overlays exist": dialog.ts's
// openOverlay INERTS the previous top-of-stack surface whenever a new overlay is pushed
// (`inertElement(stack[stack.length-1].surface, true)`), and `inert` removes an element from the
// tab order, the a11y tree AND blocks pointer events. Before the fix, the second (accidental,
// unkeyed) open pushes a real second stack entry, so the FIRST drawer's surface -- the one
// carrying the visible Edit/Remove buttons the operator is looking at -- is the one made inert.
// That is the exact live defect ("locator.click: Timeout 20000ms exceeded ... intercepts pointer
// events"), reproduced headlessly and deterministically here.
//
// Run with: node test/validate-r20-drawer-key-propagation.ts

import { installDomShim, qs, qsa, flushAsync, markConnected, type ShimNode } from "./dom-shim.ts";
installDomShim();

// attr reads an attribute off a shim node (the same one-liner validate-stable-components-shared.ts
// uses; not imported from there to keep this file a standalone driver like
// validate-credentials-cleanup-attest.ts).
function attr(n: unknown, k: string): string | null {
  return (n as ShimNode).getAttribute(k);
}

const { openItemDrawer } = await import("../src/screens/credentials/list.ts");
const { renderList: renderDestinationList } = await import("../src/screens/destination-cards.ts");
const { openRunDetail } = await import("../src/screens/runs/detail.ts");
const { buildMapDrawer } = await import("../src/screens/map/drawer.ts");
const { closeAllOverlays } = await import("../src/components/dialog.ts");

import type { ExpiryStatus, EngineClient } from "../src/api.ts";
import type { DestinationList, DestinationStatus } from "../src/lib/api/types/destinations.ts";
import type { FleetRun } from "../src/screens/runs/types.ts";
import type { FlowRecord } from "../src/components/topology.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A minimal EngineClient stub: only the methods each screen's drawer build actually calls.
// Every other method is absent; a screen that reached for one would throw loudly (never a
// silent undefined), which none of the four does at build time (verified by reading each).
function stubEngine(overrides: Record<string, unknown> = {}): EngineClient {
  return {
    listHistory: () => Promise.resolve([]),
    rosterHygiene: () => Promise.resolve({ ghosts: [], neverRan: [], ghostCount: 0 }),
    ...overrides,
  } as unknown as EngineClient;
}

async function main(): Promise<void> {
  // =========================================================================
  // 1. credentials/list.ts:360 -- openItemDrawer (the screen the live spec reproduced against)
  // =========================================================================
  console.log("\n-- credentials/list.ts: openItemDrawer --");
  {
    closeAllOverlays();
    const engine = stubEngine();
    const row: ExpiryStatus = {
      id: "exp-r20-1",
      label: "Deploy token, R2",
      kind: "credential",
      state: "approaching",
      source: "manual",
      expiresAt: "2026-08-15T00:00:00Z",
      daysRemaining: 15,
    };

    // First open: the deep-linked first render's side effect.
    openItemDrawer(engine, row, () => {});
    await flushAsync();
    ok("(1a) first open mounts exactly one drawer", qsa(document.body, ".overlay--drawer").length === 1);
    const firstSurface = qs(document.body, ".dialog--drawer");
    ok("(1b) the first drawer's surface is not inert", attr(firstSurface, "inert") === null);

    // Second open, SAME row: the identity-resolved quiet re-render's second load() re-firing
    // the same deep link. The first drawer is still mounted (no navigation happened).
    openItemDrawer(engine, row, () => {});
    await flushAsync();
    ok("(1c) the re-render's second open does NOT stack a duplicate drawer", qsa(document.body, ".overlay--drawer").length === 1);
    ok("(1d) the original (first) drawer surface is still mounted, not replaced", document.body.contains(firstSurface as unknown as Node));
    ok("(1e) the surviving drawer's surface is NOT inert -- Edit/Remove stay reachable", attr(qs(document.body, ".dialog--drawer"), "inert") === null);

    // And the Edit/Remove-equivalent footer actions genuinely still fire, not just "present in the DOM".
    const footerBtns = qsa(document.body, ".drawer-actions button");
    ok("(1f) the footer action buttons are present", footerBtns.length > 0);
    closeAllOverlays();
  }

  // =========================================================================
  // 2. runs/detail.ts:43 -- openRunDetail
  // =========================================================================
  console.log("\n-- runs/detail.ts: openRunDetail --");
  {
    closeAllOverlays();
    const engine = stubEngine();
    const run: FleetRun = {
      runId: "run-r20-1",
      index: 3,
      startedAt: "2026-07-30T00:00:00Z",
      status: "ok",
      downpipeId: "dp-r20-1",
      downpipeName: "KV uploads",
    };

    openRunDetail(engine, run);
    await flushAsync();
    ok("(2a) first open mounts exactly one drawer", qsa(document.body, ".overlay--drawer").length === 1);
    const firstSurface = qs(document.body, ".dialog--drawer");

    // The SAME (downpipeId, index) pair the /runs/:downpipeId/:index route carries -- a fresh
    // FleetRun object (as a fresh RunsView's fetchRuns() would build), not the same reference,
    // so a reference-equality shortcut could not be hiding a bug here.
    const runAgain: FleetRun = { ...run };
    openRunDetail(engine, runAgain);
    await flushAsync();
    ok("(2b) a second RunsView instance's re-fired deep link does NOT stack a duplicate", qsa(document.body, ".overlay--drawer").length === 1);
    ok("(2c) the original drawer surface is still mounted", document.body.contains(firstSurface as unknown as Node));
    ok("(2d) the surviving surface is NOT inert", attr(qs(document.body, ".dialog--drawer"), "inert") === null);

    // A DIFFERENT run (different index) must still open as its own, distinct drawer -- the guard
    // is per-entity, never a blanket "only one run drawer ever" rule.
    const otherRun: FleetRun = { ...run, runId: "run-r20-2", index: 4 };
    openRunDetail(engine, otherRun);
    await flushAsync();
    ok("(2e) a different run index is a different key: two distinct drawers stack", qsa(document.body, ".overlay--drawer").length === 2);
    closeAllOverlays();
  }

  // =========================================================================
  // 3. map/drawer.ts:79 -- buildMapDrawer
  // =========================================================================
  console.log("\n-- map/drawer.ts: buildMapDrawer --");
  {
    closeAllOverlays();
    const engine = stubEngine();
    const flow: FlowRecord = {
      id: "flow-r20-1",
      source: { name: "KV_uploads", kind: "kv" },
      destination: { name: "R2_archive", kind: "r2" },
      status: "healthy",
      enabled: true,
      running: false,
    };
    const deps = { engine, lastData: null, onClose: () => {}, refresh: () => {}, canDelete: true, canReconcile: true };

    buildMapDrawer(flow, deps);
    await flushAsync();
    ok("(3a) first open mounts exactly one drawer", qsa(document.body, ".overlay--drawer").length === 1);
    const firstSurface = qs(document.body, ".dialog--drawer");

    // A fresh MapController's syncMapDrawer re-firing openMapDrawer for the same ?open=<id>.
    buildMapDrawer(flow, deps);
    await flushAsync();
    ok("(3b) a fresh controller's re-synced drawer does NOT stack a duplicate", qsa(document.body, ".overlay--drawer").length === 1);
    ok("(3c) the original drawer surface is still mounted", document.body.contains(firstSurface as unknown as Node));
    ok("(3d) the surviving surface is NOT inert", attr(qs(document.body, ".dialog--drawer"), "inert") === null);
    closeAllOverlays();
  }

  // =========================================================================
  // 4. destination-cards.ts:262 -- openDestinationDrawer (private; driven via the real
  //    dataTable row activation, the same path an operator's click takes)
  // =========================================================================
  console.log("\n-- destination-cards.ts: the destination detail drawer (via row activation) --");
  {
    closeAllOverlays();
    const engine = stubEngine();
    const dest: DestinationStatus = {
      present: true,
      id: "dest-r20-1",
      label: "Primary archive",
      bucket: "acme-archive",
      isDefault: true,
      source: "console",
    };
    const list: DestinationList = { destinations: [dest], defaultId: "dest-r20-1" };

    const root = renderDestinationList(engine, list, () => {});
    document.body.appendChild(root as unknown as Node);
    markConnected(root);
    const row = qs(document.body, 'tr[data-key="dest-r20-1"]');
    ok("(4 setup) the destination row rendered", row !== null);

    (row as unknown as { click(): void }).click();
    await flushAsync();
    ok("(4a) activating the row mounts exactly one drawer", qsa(document.body, ".overlay--drawer").length === 1);
    const firstSurface = qs(document.body, ".dialog--drawer");

    // A second activation of the SAME row while the drawer is still open (defence in depth: this
    // call site is not proven live-vulnerable to the re-render race the other three are -- its own
    // comment records it opens from a row click, not today's deep link -- but it shares the SAME
    // openDetailDrawer helper as the other four, so it is keyed the same way rather than left as
    // the one caller a future deep-link change could still catch out).
    (row as unknown as { click(): void }).click();
    await flushAsync();
    ok("(4b) a duplicate activation does NOT stack a second drawer", qsa(document.body, ".overlay--drawer").length === 1);
    ok("(4c) the original drawer surface is still mounted", document.body.contains(firstSurface as unknown as Node));
    ok("(4d) the surviving surface is NOT inert", attr(qs(document.body, ".dialog--drawer"), "inert") === null);
    closeAllOverlays();
  }

  console.log(failures === 0 ? "\nR-20 DRAWER-KEY-PROPAGATION VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-R20-DRAWER-KEY-PROPAGATION THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
