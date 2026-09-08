// The attended-verification cadence control, now that it is ESTATE STATE rather than a browser preference.
//
// WHY THIS EXISTS. Moving the interval from localStorage to the engine turned a
// two-line preference into a control that reads over the network, writes over the network, gates on the
// caller's role, and has three distinct ways to be wrong. None of that had a test. A screen that talks to
// the engine and reports its refusals is exactly the kind that looks fine until the day it does not.
//
// FOUR BEHAVIOURS, and three of them are failure paths, because the happy path is the one a person notices.
//
//   1. A non-owner sees the interval and cannot change it. Writing is owner-only server-side, so a select
//      that let them pick and then met a 403 would be a worse experience than one that says why up front.
//
//   2. A failed READ leaves the control at "Not stated" and SAYS SO. Showing a default that is not what the
//      estate holds would be a quiet lie about a compliance setting, and the operator would have no way to
//      tell the difference between "no cadence" and "we could not ask".
//
//   3. An interval the engine holds but this closed list does not offer is reported as exactly that. It can
//      happen through the API or a newer console. Snapping the control to a neighbouring option would
//      misreport what the estate actually holds.
//
//   4. An engine REFUSAL on write reaches the operator inline. The engine bounds the interval, so a rejected
//      value must not look like it was saved.
//
// The reminder toggle beside it stays local, and that separation is asserted too: it must not reach the
// engine, because whether to show a nudge on this screen is genuinely a per-browser preference.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { flushAsync, installDomShim, qs, type ShimNode, textOf } from "./dom-shim.ts";

installDomShim();

const g = globalThis as unknown as Record<string, unknown>;
g.location = g.location ?? { origin: "https://console.test" };
if (g.MutationObserver === undefined) {
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

const { connect, setCaller } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");
const { renderAttendRunner } = await import("../src/screens/restore-flow/attend.ts");

type Caller = import("../src/api.ts").Caller;
type Role = "owner" | "operator";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

interface Harness {
  root: ShimNode;
  select: ShimNode;
  writes: number[];
}

/** Render the runner with a stubbed cadence read/write and return the control plus a write recorder. */
async function mount(role: Role, read: () => Promise<{ attendedCadenceDays: number }>, write?: (d: number) => Promise<{ attendedCadenceDays: number }>): Promise<Harness> {
  setCaller({ method: "access", email: `${role}@test`, role, groups: [], isOnlyOwner: false } as Caller);
  const engine = connect("https://engine.test");
  const writes: number[] = [];
  engine.getAttendedCadence = read;
  engine.setAttendedCadence = async (d: number) => {
    writes.push(d);
    if (write) return write(d);
    return { attendedCadenceDays: d };
  };
  // The runner reaches the engine for its own setup reads; those are not what this file is about, so they
  // resolve to empty rather than being asserted.
  engine.listDownpipes = async () => [];
  const root = renderAttendRunner(engine) as unknown as ShimNode;
  await flushAsync();
  const select = qs(root, "#attend-cadence");
  if (select === null) throw new Error("the attended-verification screen has no #attend-cadence control");
  return { root, select, writes };
}

function fire(node: ShimNode, type: string): void {
  node.dispatchEvent({ type, target: node, currentTarget: node, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} });
}

console.log("\n-- the attended-verification cadence setting --\n");

// ---- 1. the owner gate -----------------------------------------------------------------------------------
// 91 rather than 90: the console offers Quarterly as 91 days, and picking a value that is NOT one of the
// five would exercise the off-list branch instead of the plain read. That is asserted separately below.
const asOperator = await mount("operator", async () => ({ attendedCadenceDays: 91 }));
ok("a non-owner sees the interval the estate holds", asOperator.select.value === "91");
// Disabled-with-reason, not the native `disabled` attribute: the control stays reachable
// in the tab order and announces why, via aria-disabled + aria-describedby, rather than a plain
// native disable that would drop it from the tab order silently.
ok("and the control is DISABLED for them, rather than letting them pick and meet a 403", asOperator.select.getAttribute("aria-disabled") === "true");
ok("the reason is stated, not left to be discovered", textOf(asOperator.root).includes("Only an Owner can change it"));
asOperator.select.value = "30";
fire(asOperator.select, "change");
await flushAsync();
ok("and nothing is written on their behalf", asOperator.writes.length === 0);

const asOwner = await mount("owner", async () => ({ attendedCadenceDays: 91 }));
ok("an owner gets an enabled control", asOwner.select.disabled !== true);
asOwner.select.value = "182";
fire(asOwner.select, "change");
await flushAsync();
ok("and choosing an interval writes it to the engine", asOwner.writes.length === 1 && asOwner.writes[0] === 182);

// ---- 2. a failed read is honest --------------------------------------------------------------------------
const readFails = await mount("owner", async () => {
  throw new Error("engine unreachable");
});
ok("a failed read leaves the control at Not stated", readFails.select.value === "0");
ok(
  "and says the value could not be read, rather than showing a default as if it were the estate's",
  textOf(readFails.root).includes("Could not read the current interval"),
);

// ---- 3. an interval this list does not offer -------------------------------------------------------------
const offList = await mount("owner", async () => ({ attendedCadenceDays: 45 }));
ok("an interval the engine holds but this list does not offer is NOT snapped to a neighbour", offList.select.value !== "30" && offList.select.value !== "91");
ok("and the operator is told what the estate actually holds", textOf(offList.root).includes("45-day interval"));

// ---- 3b. a response with no interval in it ----------------------------------------------------------------
// Not hypothetical. The demo's own benignGet answers an unmodelled route with a healthy-looking
// { ok: true, present: false, ... } that carries no interval. Without a shape guard the control would
// render "a undefined-day interval" to a visitor on the public tour. A response with no number is an
// unreadable answer, not an exotic interval.
const noField = await mount("owner", async () => ({ ok: true, present: false } as unknown as { attendedCadenceDays: number }));
ok("a response with no interval in it leaves the control at Not stated", noField.select.value === "0");
ok("and is reported as an unreadable answer, never as an interval", textOf(noField.root).includes("did not return an interval"));
ok("and never renders the word undefined at the operator", !textOf(noField.root).includes("undefined"));

// ---- 4. an engine refusal reaches the operator ------------------------------------------------------------
const refuses = await mount("owner", async () => ({ attendedCadenceDays: 0 }), async () => {
  throw new Error("attendedCadenceDays must be 0 (no cadence) or between 1 and 3650");
});
refuses.select.value = "365";
fire(refuses.select, "change");
await flushAsync();
ok("an engine refusal on write is surfaced inline, so a rejected value never looks saved", textOf(refuses.root).includes("did not accept that interval"));

// ---- the toggle stays local --------------------------------------------------------------------------------
const toggle = qs(asOwner.root, "#attend-reminders");
ok("the reminder toggle is still on the screen", toggle !== null);
const before = asOwner.writes.length;
if (toggle !== null) {
  toggle.checked = true;
  fire(toggle, "change");
  await flushAsync();
}
ok("and toggling it does NOT reach the engine (it is a per-browser preference)", asOwner.writes.length === before);

console.log(`\n${failures === 0 ? "ATTEND-CADENCE-SETTING PASS" : `ATTEND-CADENCE-SETTING: ${failures} FAILED`}\n`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
