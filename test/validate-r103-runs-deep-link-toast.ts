// A dangling deep link to a run must say why it fell back to the list, matching the toast
// sources-downpipes.ts already gives for the equivalent dangling-id fallback there.
// Run with: node test/validate-r103-runs-deep-link-toast.ts
//
// WHY THIS EXISTS. RunsView.maybeOpenDeepLink used to fall back to /runs with no
// toast, no live-region announcement, nothing -- the address bar just changed. sources-downpipes.ts
// hit the identical case (a deep link naming an id the list cannot resolve) and its own comment
// records that the silent version was already judged a defect there ("read as a dead end") and
// fixed with a toast. Runs was the one of the three list/deep-link surfaces that never got it.
//
// This renders the REAL RunsView against a fake engine and drives the REAL maybeOpenDeepLink via
// start(), so it fails if the toast is removed or the fallback stops firing it.

import { installDomShim, flushAsync, qsa, textOf, type ShimNode } from "./dom-shim.ts";
installDomShim();

import { installNav } from "../src/lib/nav.ts";
import { RunsView } from "../src/screens/runs/view.ts";
import type { EngineClient } from "../src/api.ts";
import type { AllHistory } from "../src/lib/api/client-downpipes.ts";

let navigated: Array<{ to: string; replace?: boolean }> = [];
installNav({
  navigate: (to: string, opts?: { replace?: boolean }) => { navigated.push({ to, ...(opts?.replace !== undefined ? { replace: opts.replace } : {}) }); },
  onUnauthorised: () => {},
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  signOut: () => {},
});

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

const HISTORY: AllHistory = {
  byDownpipe: {
    dp1: [{ runId: "r5", index: 5, startedAt: new Date().toISOString(), status: "ok" }],
  },
};

function fakeEngine(): EngineClient {
  return {
    listAllHistory: async () => HISTORY,
    listDownpipes: async () => [{ config: { id: "dp1", name: "Uploads" } }],
  } as unknown as EngineClient;
}

function newestToastText(): string {
  const msgs = qsa(document.body as unknown as ShimNode, ".toast__msg");
  return textOf(msgs[msgs.length - 1] ?? null);
}

console.log("a dangling run deep link explains its fallback");

// ---- 1. A run id in the URL that does not resolve says why. ------------------------------------
{
  navigated = [];
  const view = new RunsView(fakeEngine(), new URLSearchParams(), { detailDp: "dp1", detailIndex: "999" });
  view.start();
  await flushAsync();
  ok("the dangling deep link falls back to /runs", navigated.length === 1 && navigated[0]?.to === "/runs" && navigated[0]?.replace === true, JSON.stringify(navigated));
  const msg = newestToastText();
  ok("and a toast says the run no longer exists", /that run no longer exists/i.test(msg), msg);
  ok("matching sources-downpipes.ts's wording style for the sibling fallback", /showing the current list/i.test(msg), msg);
}

// ---- 2. NEGATIVE CONTROL: a deep link that DOES resolve opens the run, no fallback, no toast. --
{
  navigated = [];
  const beforeCount = qsa(document.body as unknown as ShimNode, ".toast__msg").length;
  const view = new RunsView(fakeEngine(), new URLSearchParams(), { detailDp: "dp1", detailIndex: "5" });
  view.start();
  await flushAsync();
  ok("NEGATIVE CONTROL: a resolvable deep link does not fall back to /runs", !navigated.some((n) => n.to === "/runs"));
  const afterCount = qsa(document.body as unknown as ShimNode, ".toast__msg").length;
  ok("NEGATIVE CONTROL: no new toast fires when the run resolves", afterCount === beforeCount);
}

// ---- 3. NEGATIVE CONTROL: no deep link at all -- an ordinary visit -- never toasts or navigates. --
{
  navigated = [];
  const beforeCount = qsa(document.body as unknown as ShimNode, ".toast__msg").length;
  const view = new RunsView(fakeEngine(), new URLSearchParams(), { detailDp: undefined, detailIndex: undefined });
  view.start();
  await flushAsync();
  ok("NEGATIVE CONTROL: an ordinary visit (no deep link) never navigates away", navigated.length === 0, JSON.stringify(navigated));
  const afterCount = qsa(document.body as unknown as ShimNode, ".toast__msg").length;
  ok("NEGATIVE CONTROL: and never toasts", afterCount === beforeCount);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
