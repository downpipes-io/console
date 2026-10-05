// The canary cadence picker offers only intervals the canary can fly, and names the one it really flies.
//
//   node test/validate-canary-cadence.ts
//
// The canary flies only from the engine's 15-minute cron tick, so an "Every 5 minutes" preset would fly
// every 15. Scheduled flights are not "always further apart than this setting" either: from engine 0.3.7
// the next flight counts from the tick that flew the last one. This drives the
// REAL settings section as an owner and grades what is offered and what is said.

import { installDomShim, qsa, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
installDomShim();

const { renderSettings } = await import("../src/screens/canary-sections.ts");
const store = await import("../src/lib/store.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function view(intervalSeconds: number): unknown {
  const all = [{ id: "a", label: "A", isDefault: true }];
  return {
    config: { enabled: true, destinationIds: null, intervalSeconds },
    status: "alive",
    lastRunAt: null,
    nextRunAt: null,
    inFlight: false,
    runSeq: 1,
    dests: [{ destinationId: "a", label: "A", isDefault: true, status: "alive", lastRunAt: null, deadSince: null, lastCheck: null }],
    history: [],
    allDestinations: all,
    destinationCount: all.length,
    flyingToAll: true,
    danglingPins: [],
  };
}

// render returns the cadence select's options (value and label) and the whole section's text.
function render(v: unknown): { options: Array<{ value: string; label: string }>; text: string } {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true } as never);
  store.connect("https://engine.test");
  const engine = store.getEngine() as unknown;
  const el = renderSettings(engine as never, v as never, () => {});
  markConnected(el as unknown as never);
  const select = (qsa(el, "select") as unknown as Array<{ id: string }>).find((s) => s.id === "canary-cadence");
  const options = select ? (qsa(select as never, "option") as unknown as Array<{ value: string }>).map((o) => ({ value: o.value, label: textOf(o as never) })) : [];
  return { options, text: textOf(el as unknown as never) };
}

async function main(): Promise<void> {
  console.log("(1) the presets start at the cron tick");
  {
    const { options, text } = render(view(3600));
    ok("(1a) the cadence select renders with options", options.length > 0);
    ok("(1b) no 5-minute preset is offered", !options.some((o) => o.value === "300") && !options.some((o) => o.label.includes("Every 5 minutes")));
    ok("(1c) the 15-minute preset is the shortest offered", options[0]?.value === "900" && options.every((o) => Number(o.value) >= 900));
    ok("(1d) the 60-minute default is still offered", options.some((o) => o.value === "3600" && o.label.includes("default")));
    ok("(1e) the hint no longer says flights are always further apart than the setting", !text.includes("always further apart"));
    ok("(1f) the hint says a flight starts on the tick nearest to the end of the interval", text.includes("starts on the engine's 15-minute cron tick that is nearest to the end of the interval"));
  }

  console.log("\n(2) an interval under the tick, set before this change or through the API, is kept and named honestly");
  {
    const { options } = render(view(300));
    const current = options[0];
    ok("(2a) the stored 300 s is kept as the leading (current) option", current?.value === "300" && current.label.includes("(current)"));
    ok("(2b) its label says it flies every 15 minutes", current?.label.startsWith("Every 15 minutes (set to 5 minutes)") === true);
  }

  console.log("\n(3) an interval over the tick that is not a multiple of it is named by the tick it flies on");
  {
    // From engine 0.3.7 a flight may start up to half a tick (450 s) early, so 1200 s is due 750 s after
    // the last flight's tick: the next tick flies it, and the canary flies every 15 minutes.
    const { options } = render(view(1200));
    ok("(3a) a stored 1200 s says it flies every 15 minutes", options[0]?.value === "1200" && options[0].label.startsWith("Every 15 minutes (set to 20 minutes)"));
    // The negative control: a multiple of the tick flies at its own setting, so nothing is appended.
    const multiple = render(view(2700)).options[0];
    ok("(3b) a stored 2700 s, a multiple of the tick, is named as set", multiple?.value === "2700" && multiple.label === "Every 45 minutes (current)");
  }

  console.log(`\n${failures === 0 ? "CANARY-CADENCE OK: the picker offers only intervals the canary can fly, and names the one it flies" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
