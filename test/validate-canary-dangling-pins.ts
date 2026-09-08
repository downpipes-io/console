// The canary destination picker when a PINNED destination no longer exists.
//
//   node test/validate-canary-dangling-pins.ts
//
// The engine refuses an unknown pin at save time, so a pin can only go dangling LATER, when the
// destination it named is deleted. The engine then drops it from the flight silently, which is right (it
// must still fly somewhere), and reports it in the view's danglingPins (added in the same change as this
// file).
//
// Why the console half matters: the picker's checkbox list is built from allDestinations, so a dangling
// pin renders NO row. Before this, an operator who had deliberately pinned a cold-archive bucket could
// have that destination deleted, lose the canary's proof of it, and see nothing at all: the pin was in
// config.destinationIds, absent from the list, and unmentioned. The aggregate went on reading healthy for
// the destinations that remained.
//
// There is a second, quieter consequence the note also guards. The per-destination change handler
// recomputes the pinned set from allDestinations, so the next tick of any checkbox PERMANENTLY drops the
// dangling id. That is defensible (it is gone), but it should not happen while the operator is unaware.

import { installDomShim, qsa, textOf } from "./dom-shim.ts";
installDomShim();

const { renderSettings } = await import("../src/screens/canary-sections.ts");
const store = await import("../src/lib/store.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const dest = (id: string, label: string, isDefault = false) => ({ id, label, isDefault });

function view(opts: { pinned: string[] | null; all: Array<{ id: string; label: string; isDefault?: boolean }>; dangling?: string[] }): unknown {
  const all = opts.all.map((d) => dest(d.id, d.label, d.isDefault ?? false));
  // Narrowed on the value rather than through the boolean: `flying` records the same fact, but the
  // compiler cannot carry a narrowing across it, so the filter below was reaching into a possible null.
  const pinned = opts.pinned;
  const flying = pinned === null;
  const effective = pinned === null ? all.map((d) => d.id) : pinned.filter((id) => all.some((d) => d.id === id));
  return {
    config: { enabled: true, destinationIds: opts.pinned, intervalSeconds: 3600 },
    status: "alive",
    lastRunAt: null,
    nextRunAt: null,
    inFlight: false,
    runSeq: 1,
    dests: effective.map((id) => ({ destinationId: id, label: all.find((d) => d.id === id)?.label ?? id, isDefault: false, status: "alive", lastRunAt: null, deadSince: null, lastCheck: null })),
    history: [],
    allDestinations: all,
    destinationCount: all.length,
    flyingToAll: flying,
    ...(opts.dangling === undefined ? {} : { danglingPins: opts.dangling }),
  };
}

// render drives the REAL settings section as an OWNER (the picker is owner-gated, so a viewer would see
// disabled controls and prove nothing) and returns its text plus the checkbox ids, because what must be
// asserted is both what is said and what is offered.
function render(v: unknown): { text: string; boxIds: string[] } {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true } as never);
  store.connect("https://engine.test");
  const engine = store.getEngine() as unknown;
  const el = renderSettings(engine as never, v as never, () => {});
  markConnected(el as unknown as never);
  const boxIds = (qsa(el, "input") as unknown as Array<{ id: string }>).map((i) => i.id);
  return { text: textOf(el as unknown as never), boxIds };
}

async function main(): Promise<void> {
  console.log("(1) one dangling pin is NAMED, and the note says proof was lost rather than blaming config");
  {
    const { text, boxIds } = render(view({ pinned: ["keep", "gone"], all: [{ id: "keep", label: "Keep R2" }], dangling: ["gone"] }));
    ok("(1a) the missing pin is named", text.includes("gone"));
    ok("(1b) the note says the canary is no longer proving it", text.includes("not proving it any more"));
    ok("(1c) it reassures that the rest still fly", text.includes("still flies to the destinations below"));
    ok("(1d) it offers the two ways out", text.includes("Re-create the destination") && text.includes("tick a replacement"));
    // The picker cannot render a row for a destination that does not exist, which is exactly why the note
    // is needed. Asserted so the note's purpose cannot be mistaken for redundancy with the list.
    ok("(1e) the dangling pin has NO checkbox in the list", !boxIds.includes("canary-d-gone"));
    ok("(1f) while the surviving pin does", boxIds.includes("canary-d-keep"));
  }

  console.log("\n(2) singular and plural read correctly, because a count in the wrong number reads as a bug");
  {
    const one = render(view({ pinned: ["a", "x"], all: [{ id: "a", label: "A" }], dangling: ["x"] }));
    ok("(2a) one reads 'destination no longer exists'", one.text.includes("1 pinned destination no longer exists"));
    const two = render(view({ pinned: ["a", "x", "y"], all: [{ id: "a", label: "A" }], dangling: ["x", "y"] }));
    ok("(2b) two read 'destinations no longer exist'", two.text.includes("2 pinned destinations no longer exist"));
    ok("(2c) and both are named", two.text.includes("x, y"));
    ok("(2d) the plural note uses 'them'", two.text.includes("not proving them any more"));
  }

  console.log("\n(3) no note when there is nothing to warn about");
  {
    const healthy = render(view({ pinned: ["a", "b"], all: [{ id: "a", label: "A" }, { id: "b", label: "B" }], dangling: [] }));
    ok("(3a) a healthy pinned canary shows no dangling note", !healthy.text.includes("no longer exist"));
    const flying = render(view({ pinned: null, all: [{ id: "a", label: "A" }], dangling: [] }));
    ok("(3b) flying to all shows no dangling note", !flying.text.includes("no longer exist"));
  }

  console.log("\n(4) an OLDER ENGINE that does not send the field must not break the picker");
  {
    // danglingPins is optional for exactly this reason. An engine predating the field sends nothing, and
    // absent must behave as empty rather than throwing or rendering "undefined".
    const legacy = render(view({ pinned: ["a"], all: [{ id: "a", label: "A" }] }));
    ok("(4a) the picker still renders", legacy.boxIds.includes("canary-d-a"));
    ok("(4b) with no dangling note", !legacy.text.includes("no longer exist"));
    ok("(4c) and no leaked undefined", !legacy.text.includes("undefined"));
  }

  console.log("\n(5) every pin dangling: the note still names them, and the fly-to-all toggle is honest");
  {
    // The engine falls back to the default destination here, so the operator IS still getting a flight,
    // just not the one they asked for. That is the most misleading state of all, so it must be named.
    const { text } = render(view({ pinned: ["x", "y"], all: [{ id: "c", label: "C is new" }], dangling: ["x", "y"] }));
    ok("(5a) both dangling pins are named", text.includes("x, y"));
    ok("(5b) the note appears even though no pin survives", text.includes("no longer exist"));
    ok("(5c) the surviving collection is still offered", text.includes("C is new"));
  }

  console.log(`\n${failures === 0 ? "CANARY-DANGLING-PINS OK: a pinned destination that was deleted is named on screen, instead of silently ceasing to be proven" : `${failures} FAILURE(S)`}`);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
