// THE PALETTE'S "Drill latest run of every downpipe" MUST RUN THE DRILLS, NOT ONLY OPEN THE OVERVIEW.
//
// The command's title promises a fleet drill. defaultDispatch sent it to actionRoute ("/") and stopped there,
// so the operator landed on the Overview and nothing was drilled, while the Overview exposes the drill as a
// handle on its root (overview/mount.ts __overviewDrillFleet) and its view already reports progress for a
// palette-started drill (overview/view.ts setDrillProgress). The dispatch now navigates, waits for the
// Overview root that the navigation mounts, and calls that handle.
//
// WHAT THIS PINS, as properties that can each fail on their own:
//   1. THE DRILL RUNS. An Overview root that mounts after the navigation has its drill handle called once.
//   2. THE ROOT ON SCREEN IS USED. When the operator is already on the Overview and the navigation does not
//      re-render it, the root that was there is used after the wait.
//   2b. THE WAIT OUTLASTS THE SETUP CAP. On a slow engine the Overview mounts its dashboard only at the setup
//      fail-open cap (overview.ts SETUP_FAILOPEN_CAP_MS), so a root that appears after the cap still gets its
//      drill, and no "did not start" toast is shown first.
//   3. NO SILENT NO-OP. When no Overview root with the handle appears (setup is not finished, or a leave guard
//      kept the operator where they were), the operator is told the drill did not start.
//
// Run: node test/validate-palette-drill-fleet.ts

import { installDomShim, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const nav = await import("../src/lib/nav.ts");
const routing = await import("../src/screens/command-palette/routing.ts");
const { overviewScreen, SETUP_FAILOPEN_CAP_MS } = await import("../src/screens/overview.ts");

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const routes: string[] = [];
nav.installNav({ navigate: (to: string) => { routes.push(to); }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

const cmd = overviewScreen.actions?.find((a) => a.id === "overview.drill-fleet");
if (!cmd) throw new Error("the overview.drill-fleet command is not registered");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// overviewRoot builds a stand-in for the mounted Overview root: the marker attribute and the drill handle, the
// two things mountFullOverview puts on the real root.
function overviewRoot(onDrill: () => void): HTMLElement {
  const root = document.createElement("div") as HTMLElement & { __overviewDrillFleet?: () => void };
  root.setAttribute("data-overview-root", "");
  root.__overviewDrillFleet = onDrill;
  return root;
}

async function main(): Promise<void> {
  console.log("\n-- 1. the drill runs on the Overview the navigation mounts --");
  {
    routes.length = 0;
    let drills = 0;
    routing.defaultDispatch(cmd!);
    // The router renders the Overview in a later task, as a real navigation does.
    const root = overviewRoot(() => { drills++; });
    setTimeout(() => document.body.appendChild(root), 20);
    await sleep(400);
    ok("the dispatch navigated to the Overview", routes.includes("/"));
    ok("the Overview's drill handle was called", drills === 1);
    root.remove();
  }

  console.log("\n-- 2. the root already on screen is used when the navigation does not replace it --");
  {
    let drills = 0;
    const root = overviewRoot(() => { drills++; });
    document.body.appendChild(root);
    routing.defaultDispatch(cmd!);
    await sleep(1200);
    ok("the drill handle on the Overview already on screen was called once", drills === 1);
    root.remove();
  }

  console.log("\n-- 2b. a root that mounts after the setup fail-open cap still gets its drill --");
  {
    let drills = 0;
    ok("the wait is longer than the setup fail-open cap", routing.OVERVIEW_WAIT_STEPS * 50 > SETUP_FAILOPEN_CAP_MS);
    routing.defaultDispatch(cmd!);
    const root = overviewRoot(() => { drills++; });
    setTimeout(() => document.body.appendChild(root), SETUP_FAILOPEN_CAP_MS + 200);
    await sleep(SETUP_FAILOPEN_CAP_MS + 600);
    ok("the drill handle on the late Overview was called once", drills === 1);
    ok("no 'did not start' toast was shown before it mounted", !textOf(document.body as never).includes("The fleet drill did not start"));
    root.remove();
  }

  console.log("\n-- 3. no Overview root: the operator is told, not left with nothing --");
  {
    const runOnOverview = (routing as { runOnOverview?: (before: null, pick: (r: { __overviewDrillFleet?: () => void }) => (() => void) | undefined, steps?: number, stepMs?: number) => Promise<boolean> }).runOnOverview;
    ok("the wait is a named decision the validator can drive", typeof runOnOverview === "function");
    if (typeof runOnOverview === "function") {
      const started = await runOnOverview(null, (r) => r.__overviewDrillFleet, 3, 5);
      ok("it reports that nothing started", started === false);
      ok("a toast says the fleet drill did not start and where to start it", textOf(document.body as never).includes("The fleet drill did not start"));
    }
  }

  console.log(failures === 0 ? "\nPASS validate-palette-drill-fleet" : `\nFAIL validate-palette-drill-fleet (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
