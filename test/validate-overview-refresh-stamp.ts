// Validate that Overview's paused refresh stamp uses the warning TEXT colour token, not the base
// warning token that fails contrast against the light-theme background.
//
// Run: node test/validate-overview-refresh-stamp.ts

import { installDomShim, flushAsync } from "./dom-shim.ts";

installDomShim();

import type { EngineClient } from "../src/api.ts";
import { OverviewView } from "../src/screens/overview/view.ts";
import { setAutoRefresh } from "../src/lib/refresh-pref.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// A minimal engine whose reads all resolve, so fetchOverviewData settles ok and buildOverview
// completes with no section fault (every section is independently fault-isolated; these shapes
// are the ones exercised elsewhere, in test/validate-optimistic-concurrency-base-stated.ts).
function fakeEngine(): EngineClient {
  return {
    health: async () => ({ ok: true, service: "downpipe engine" }),
    status: async () => ({
      ready: true,
      signerConfigured: true,
      breakGlassConfigured: true,
      destConfigured: true,
      operationalConfigured: { private: true },
      recoveryCodesRemaining: 8,
    }),
    licence: async () => ({ valid: true, tier: "business", notAfter: "2027-01-01T00:00:00Z" }),
    updates: async () => ({
      configured: true,
      verified: true,
      updateAvailable: false,
      currentVersion: "0.2.0",
      recommendedVersion: "0.2.0",
      versionSkew: "current",
    }),
    listAllHistory: async () => ({}),
    listDownpipes: async () => [],
    listDrillEvidence: async () => [],
    listAudit: async () => ({ events: [] }),
    listApprovals: async () => [],
    discoverSources: async () => ({ bindings: [], tokenSources: [] }),
  } as unknown as EngineClient;
}

async function main(): Promise<void> {
  setAutoRefresh("on");
  const updatedStamp = document.createElement("p");
  const view = new OverviewView(fakeEngine(), "technical", updatedStamp);
  document.body.appendChild(view.el);

  // start() fires the first load; it is the only path that sets lastLoadAt and paints the stamp.
  view.start();
  await flushAsync();

  ok("the stamp painted after the first load", (updatedStamp.textContent ?? "").startsWith("Updated"));
  ok("the unpaused stamp carries no inline colour", updatedStamp.style.color === "");

  // Pause: the operator's WCAG 2.2.2 preference. The change listener registered in start() calls
  // paintStamp() synchronously on the pref change, so no further load is needed to reach this branch.
  setAutoRefresh("paused");

  ok("the paused stamp names the pause", (updatedStamp.textContent ?? "").includes("(auto-refresh paused)"));
  ok("the paused stamp uses the warning TEXT colour, not the base warning token", updatedStamp.style.color === "var(--warn-fg)");

  // Resume: the inline colour clears again, proving it is state-driven rather than sticky.
  setAutoRefresh("on");
  ok("resuming clears the inline colour", updatedStamp.style.color === "");

  view.dispose();
  setAutoRefresh("on");

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-overview-refresh-stamp: ${checks} checks, ${failures} failures`);
  verdictReached(failures, checks);
  if (failures > 0) process.exit(1);
}

await main();
