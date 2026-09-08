// The downpipe drawer's enable switch used to post back THE WHOLE CONFIGURATION THIS SCREEN LOADED, so an
// operator who flipped one switch reverted a colleague's edit to a field they never touched, and both were
// told they succeeded.
//
// WHAT THIS DRIVES. The REAL toggleEnabled from src/screens/sources-downpipes/detail-actions.ts against a
// fake EngineClient that reproduces the interleave: the screen holds a configuration at cadence 86400, and
// by the time the switch is clicked the engine holds 3600 because a second operator changed it. The
// grading is THE SENTENCE THE OPERATOR READS, taken out of the rendered toast, and THE BODY THE ENGINE
// WOULD RECEIVE, taken off the fake client.
//
// WHY IT REFUSES RATHER THAN REFRESHING. Re-reading and writing anyway would narrow the window from the
// lifetime of an open drawer to one round trip and would still overwrite silently, which is the shape this
// workspace records as a repair that looks done. So the earned behaviour is a refusal that NAMES the field
// that moved, which is what the engine's own change-control path says when an approved change finds its
// base moved.
//
// Run with: node test/validate-interleave-stale-toggle.ts
import { installDomShim, flushAsync } from "./dom-shim.ts";
installDomShim();

import type { Downpipe, DownpipeState, EngineClient } from "../src/api.ts";
import { changedApartFromEnabled, toggleEnabled } from "../src/screens/sources-downpipes/detail-actions.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const BASE: Downpipe = {
  id: "dp-1",
  name: "nightly",
  cadenceSeconds: 86400,
  enabled: false,
  source: { type: "r2", binding: "SRC_R2", include: [], exclude: [] },
};

function stateOf(cfg: Downpipe): DownpipeState {
  return { config: cfg, nextRunAt: null, lastRunId: null, inFlight: false } as unknown as DownpipeState;
}

// A fake client whose LIST answers the live record and whose ADD records what it was handed.
function fakeEngine(live: Downpipe | null): { engine: EngineClient; sent: Downpipe[] } {
  const sent: Downpipe[] = [];
  const engine = {
    listDownpipes: async (): Promise<DownpipeState[]> => (live === null ? [] : [stateOf(live)]),
    addDownpipe: async (dp: Downpipe) => {
      sent.push(dp);
      return { status: "applied" as const, value: stateOf(dp) };
    },
  } as unknown as EngineClient;
  return { engine, sent };
}

function toastText(): string {
  return [...document.querySelectorAll(".toast__msg")].map((n) => n.textContent ?? "").join(" | ");
}
function clearToasts(): void {
  for (const n of [...document.querySelectorAll(".toast")]) n.remove();
}

// ---- the pure comparison ----------------------------------------------------------------------------
ok("an unchanged config moves nothing", changedApartFromEnabled(BASE, { ...BASE }).length === 0);
ok("enabled itself is NOT counted as a move", changedApartFromEnabled(BASE, { ...BASE, enabled: true }).length === 0);
ok("a cadence change is named", changedApartFromEnabled(BASE, { ...BASE, cadenceSeconds: 3600 }).join() === "cadenceSeconds");
ok(
  "a nested schedule change is named, so a by-value field is not skipped",
  changedApartFromEnabled(BASE, { ...BASE, schedule: { cron: "0 2 * * *" } }).join() === "schedule",
);
ok(
  "a destination list reordered by the other operator is named",
  changedApartFromEnabled({ ...BASE, destinationIds: ["a", "b"] }, { ...BASE, destinationIds: ["b", "a"] }).join() === "destinationIds",
);
ok(
  "a key present on ONE side only counts as a move rather than being skipped",
  changedApartFromEnabled(BASE, { ...BASE, retention: { keepRuns: 7 } }).join() === "retention",
);
ok(
  "two moves are both named, in a stable order",
  changedApartFromEnabled(BASE, { ...BASE, cadenceSeconds: 3600, name: "renamed" }).join(",") === "cadenceSeconds,name",
);

// ---- THE ARM: the interleave, driven -----------------------------------------------------------------
{
  clearToasts();
  // The screen loaded 86400. A second operator has since set 3600.
  const { engine, sent } = fakeEngine({ ...BASE, cadenceSeconds: 3600 });
  let reloaded = 0;
  await toggleEnabled(engine, stateOf(BASE), () => { reloaded++; }, () => {});
  await flushAsync();
  const said = toastText();
  ok("the flip is REFUSED and nothing is written", sent.length === 0);
  ok("the operator is told the downpipe changed", said.includes("changed since this screen loaded"));
  ok("the operator is told WHICH field moved", said.includes("cadenceSeconds"));
  ok("it does not claim the switch was flipped", !said.includes("Enabled nightly") && !said.includes("Disabled nightly"));
  ok("the screen is reloaded so the stale copy does not linger", reloaded === 1);
}

// ---- CONTROL 1: nothing moved, so the switch flips and only enabled changes --------------------------
{
  clearToasts();
  const { engine, sent } = fakeEngine({ ...BASE });
  await toggleEnabled(engine, stateOf(BASE), () => {}, () => {});
  await flushAsync();
  ok("with nothing moved the write happens", sent.length === 1);
  ok("enabled is flipped", sent[0]?.enabled === true);
  ok("every other field is taken from the LIVE record", sent[0]?.cadenceSeconds === 86400);
  ok("the operator is told the switch was flipped", toastText().includes("Enabled nightly"));
}

// ---- CONTROL 2: the object was deleted under the drawer ----------------------------------------------
{
  clearToasts();
  const { engine, sent } = fakeEngine(null);
  await toggleEnabled(engine, stateOf(BASE), () => {}, () => {});
  await flushAsync();
  ok("a deleted downpipe is NOT recreated by a switch", sent.length === 0);
  ok("the operator is told it was deleted", toastText().includes("was deleted while this screen was open"));
}

console.log(`\nvalidate-interleave-stale-toggle: ${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
