// The canary screen names the destinations the engine's per-flight cap leaves out.
//
//   node test/validate-canary-uncovered-dests.ts
//
// The engine flies at most CANARY_MAX_DESTS (12, engine src/canary/types.ts) destinations per flight and cuts
// the rest of an ordered list, the same tail on every flight. It returns only the flown ones in the view's
// `dests`. Before this, the cut destinations had no row, no status and no mention on the canary screen, and
// the hero read "all 12" on an account holding 15, so a healthy aggregate read as proof of every destination.
// The engine comment beside the constant said "the console surfaces the cap"; no console code did.

import { installDomShim, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
installDomShim();

const { renderDestinations, renderStatusBlock } = await import("../src/screens/canary-sections.ts");
const store = await import("../src/lib/store.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const CAP = 12;

// view mirrors the engine's getCanaryView: `dests` is the resolved list cut to the cap, in list order, and
// `allDestinations` is the whole collection.
function view(opts: { total: number; pinned?: string[] | null }): unknown {
  const all = Array.from({ length: opts.total }, (_x, i) => ({ id: `d${i + 1}`, label: `Bucket ${i + 1}`, isDefault: i === 0 }));
  const pinned = opts.pinned ?? null;
  const wanted = pinned === null ? all.map((d) => d.id) : pinned.filter((id) => all.some((d) => d.id === id));
  const flown = wanted.slice(0, CAP);
  return {
    config: { enabled: true, destinationIds: pinned, intervalSeconds: 3600 },
    status: "alive",
    lastRunAt: null,
    nextRunAt: null,
    inFlight: false,
    runSeq: 3,
    dests: flown.map((id) => ({ destinationId: id, label: all.find((d) => d.id === id)?.label ?? id, isDefault: id === "d1", status: "alive", lastRunAt: null, deadSince: null, lastCheck: null })),
    history: [],
    allDestinations: all,
    destinationCount: all.length,
    flyingToAll: pinned === null,
    danglingPins: pinned === null ? [] : pinned.filter((id) => !all.some((d) => d.id === id)),
  };
}

function destText(v: unknown): string {
  const el = renderDestinations(v as never);
  markConnected(el as unknown as never);
  return textOf(el as unknown as never);
}

function heroText(v: unknown): string {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true } as never);
  store.connect("https://engine.test");
  const cb = { reload: () => {}, rerender: () => {}, simulate: () => {} };
  const el = renderStatusBlock(store.getEngine() as never, v as never, document.body as never, cb);
  markConnected(el as unknown as never);
  return textOf(el as unknown as never);
}

async function main(): Promise<void> {
  console.log("(1) flying to all of 15: the three past the cap are named");
  {
    const t = destText(view({ total: 15 }));
    ok("(1a) the note counts the destinations that are not flown", t.includes("The canary does not fly to 3 destinations"));
    ok("(1b) it names each of them, in list order", t.includes("Bucket 13, Bucket 14, Bucket 15"));
    ok("(1c) it states the per-flight maximum", t.includes("goes to 12 destinations at most"));
    ok("(1d) it says they have no canary result", t.includes("these destinations have no canary result"));
    ok("(1e) a flown destination is not named in the note", !t.includes("Bucket 12,") && !t.includes(": Bucket 1,"));
    const hero = heroText(view({ total: 15 }));
    ok("(1f) the hero counts the flown share of the total, not 'all 12'", hero.includes("12 of 15") && !hero.includes("all 12"));
  }

  console.log("\n(2) a pin longer than the cap: the pins past the twelfth are named");
  {
    const pins = Array.from({ length: 13 }, (_x, i) => `d${i + 1}`);
    const t = destText(view({ total: 20, pinned: pins }));
    ok("(2a) one pin is cut and the note uses the singular", t.includes("does not fly to 1 destination: Bucket 13.") && t.includes("this destination has no canary result"));
    ok("(2b) a destination that was never pinned is not named", !t.includes("Bucket 14"));
  }

  console.log("\n(3) no note when nothing is cut");
  {
    const t12 = destText(view({ total: 12 }));
    ok("(3a) exactly twelve destinations shows no note", !t12.includes("does not fly to"));
    ok("(3b) and the hero keeps 'all 12'", heroText(view({ total: 12 })).includes("all 12"));
    const pinned = destText(view({ total: 20, pinned: ["d2", "d5"] }));
    ok("(3c) a short pin over a large collection shows no note", !pinned.includes("does not fly to"));
    const dangling = destText(view({ total: 3, pinned: ["d1", "gone"] }));
    ok("(3d) a dangling pin is not reported as cut by the cap", !dangling.includes("does not fly to"));
  }

  console.log(`\n${failures === 0 ? "CANARY-UNCOVERED-DESTS OK: destinations past the per-flight cap are named on the canary screen" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
