// A RELOAD OF /restore/:runId MUST SEND ONE DRY-RUN, NOT TWO.
//
// Measured in a browser against the real boot with a replayed engine and whoami held back (0, 400 and
// 1200 ms): every reload sent two identical read-only dry-runs, the second straight after whoami landed.
// The first paint runs before whoami, so the flow mounts and starts its automatic dry-run with no caller;
// when the caller lands, app.ts re-renders the screen in place so the plan's role gates are drawn for the
// real caller, and that second mount asked the engine again. The second mount now shares the first
// mount's answer, under narrow conditions, and still draws the plan for the resolved caller.
//
// WHAT THIS PINS, each able to fail on its own:
//   1. ONE READ ACROSS THE IDENTITY RE-RENDER. A mount with no caller, then a second mount with the caller
//      resolved while the first is still on screen, sends one dry-run, and the second mount paints the plan.
//   2. THE SAME CALLER ASKS AGAIN. Two mounts with the caller already resolved (a later visit to the same
//      run) each send their own dry-run, so an old plan is never shown for a new visit.
//   3. THE BUTTON ASKS AGAIN. Pressing "Build the restore plan" on the second mount sends a fresh dry-run.
//   4. A MOUNT THAT HAS LEFT DOES NOT SHARE. If the first mount is no longer on screen, the next one asks.
//
// Run: node test/validate-restore-deeplink-one-dry-run.ts

import { flushAsync, installDomShim, qs } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

import type { Caller, EngineClient, RestorePlan, RestoreRequest } from "../src/api.ts";
import { setCaller } from "../src/lib/store.ts";
import { renderRestoreFlow } from "../src/screens/restore-flow/flow.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const RUN_ID = "01J8Z3K9QW7B2RONEDRYRUN";
const OWNER: Caller = { method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };

function planFor(req: RestoreRequest): RestorePlan {
  return {
    ok: true,
    runId: req.runId,
    mode: "dry-run",
    recordsVerified: 2,
    isLatest: true,
    plannedWrites: 2,
    bytes: 512,
    sample: [
      { name: "session:42", sourceType: "kv", binding: "SRC_KV_uploads", plaintextSize: 128 },
      { name: "cart:7", sourceType: "kv", binding: "SRC_KV_uploads", plaintextSize: 96 },
    ],
    skipped: [],
  } as unknown as RestorePlan;
}

let dryRuns = 0;
const engine = {
  restore: async (req: RestoreRequest) => {
    if (req.confirm !== true) dryRuns++;
    return planFor(req);
  },
  listApprovals: async () => [],
  getRunHistory: async () => [],
} as unknown as EngineClient;

const body = document.body as unknown as { replaceChildren: (...n: unknown[]) => void };

// mount renders the flow for /restore/:runId and puts it on screen in place of whatever was there, the same
// bare swap the identity re-render makes. The new flow is rendered BEFORE the swap, as renderScreen does.
function mount(): HTMLElement {
  const flow = renderRestoreFlow(engine, RUN_ID);
  body.replaceChildren(flow);
  return flow;
}

function planPainted(root: HTMLElement): boolean {
  return qs(root as unknown as never, ".restore-plan__heading") !== null;
}

async function main(): Promise<void> {
  console.log("\n-- 1. one read across the identity re-render --");
  dryRuns = 0;
  setCaller(null);
  const first = mount();
  await flushAsync(20);
  ok("the first mount, with no caller yet, sends its dry-run", dryRuns === 1);
  ok("and paints the plan", planPainted(first));
  setCaller(OWNER);
  const second = mount();
  await flushAsync(20);
  ok("the re-render with the caller resolved sends no second dry-run", dryRuns === 1);
  ok("and the re-rendered flow paints the plan", planPainted(second));

  console.log("\n-- 2. the same caller asks again --");
  dryRuns = 0;
  mount();
  await flushAsync(20);
  mount();
  await flushAsync(20);
  ok("two mounts with the caller already resolved send two dry-runs", dryRuns === 2);

  console.log("\n-- 3. the button asks again --");
  dryRuns = 0;
  setCaller(null);
  mount();
  await flushAsync(20);
  setCaller(OWNER);
  const shared = mount();
  await flushAsync(20);
  const btn = qs(shared as unknown as never, '[data-dp="restore-flow.button.dry-run"]') as unknown as { click: () => void } | null;
  if (btn === null) throw new Error("the dry-run button did not render");
  const beforeClick = dryRuns;
  btn.click();
  await flushAsync(20);
  ok("pressing Build the restore plan sends a fresh dry-run", dryRuns === beforeClick + 1);

  console.log("\n-- 4. a mount that has left does not share --");
  dryRuns = 0;
  setCaller(null);
  mount();
  await flushAsync(20);
  body.replaceChildren();
  setCaller(OWNER);
  mount();
  await flushAsync(20);
  ok("with the first mount gone, the next mount sends its own dry-run", dryRuns === 2);

  console.log(failures === 0 ? "\nPASS validate-restore-deeplink-one-dry-run" : `\nFAIL validate-restore-deeplink-one-dry-run (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
