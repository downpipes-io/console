// Validate that the Auto-refresh hint on Settings, Accessibility names every screen the preference governs.
//
// Run: node test/validate-auto-refresh-hint.ts
//
// THE DEFECT. The hint read "The Overview and Topology map refresh in place every 30 seconds", but the
// Security centre and the Downpipes list also poll and also stop when the preference is Paused. An operator
// who paused auto-refresh for motion sensitivity was told two screens would stop, when four did.
//
// THE POPULATION IS DERIVED, NOT LISTED. The screens that obey the preference are the source files that call
// getAutoRefresh() (lib/refresh-pref.ts's contract for a polling view). This file walks src for them and
// requires each to be named in the rendered hint, so a new polling screen that is not named turns this red.
// A caller this file cannot name is a red too, never a silent skip.
//
// THE CADENCE IS READ FROM EACH POLLER. Every `const <X>POLL_MS = <n>` in a polling file is a cadence the
// screen can run at. POLL_MS is the idle cadence, and the hint must state it. Any other *POLL_MS (the Downpipes
// list's INFLIGHT_POLL_MS, 4 seconds while a run is in progress) is a second cadence, and the hint must state it
// against that screen's name. A poller with no POLL_MS constant is a red, because this file cannot grade it.
//
// FS-WRITES: none outside this repo

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { installDomShim } from "./dom-shim.ts";

(globalThis as unknown as { location: unknown }).location = {
  origin: "https://control.downpipes.io",
  href: "https://control.downpipes.io/settings",
  pathname: "/settings",
  assign: () => {},
  replace: () => {},
};
installDomShim();

const { renderAccessibility } = await import("../src/screens/settings/appearance.ts");
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// The name each polling file's screen carries in the console's own navigation.
const SCREEN_NAME: Record<string, string> = {
  "src/screens/overview/view.ts": "Overview",
  "src/screens/map/controller.ts": "Topology map",
  "src/screens/security-centre.ts": "Security centre",
  "src/screens/sources-downpipes.ts": "Downpipes list",
};

const root = join(fileURLToPath(new URL("..", import.meta.url)));
function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
}
const files: string[] = [];
walk(join(root, "src"), files);
const pollers = files
  // refresh-pref.ts declares the preference and settings/appearance.ts is the control that sets it; neither polls.
  .filter((f) => !f.endsWith("lib/refresh-pref.ts") && !f.endsWith("settings/appearance.ts") && /\bgetAutoRefresh\(\)/.test(readFileSync(f, "utf8")))
  .map((f) => relative(root, f).split("\\").join("/"))
  .sort();

console.log("-- the population: files that call getAutoRefresh() --");
for (const f of pollers) console.log(`     ${f}`);
ok("at least the four known polling screens were found (the walk read src)", pollers.length >= 4);

const panel = renderAccessibility();
const text = panel.textContent ?? "";
ok("the Accessibility panel rendered its Auto-refresh row (not a blank render)", text.includes("Auto-refresh"));

console.log("\n-- every polling screen is named in the hint --");
for (const f of pollers) {
  const name = SCREEN_NAME[f];
  ok(`${f} has a screen name this test knows`, name !== undefined);
  if (name !== undefined) ok(`the hint names the ${name}`, text.includes(name));
}
ok("the hint states what Paused does", text.includes("Paused stops this"));

console.log("\n-- every cadence each poller runs at is stated in the hint --");
for (const f of pollers) {
  const name = SCREEN_NAME[f] ?? f;
  const src = readFileSync(join(root, f), "utf8");
  const consts = [...src.matchAll(/const\s+([A-Z_]*POLL_MS)\s*=\s*([\d_]+)\s*;/g)].map((m) => ({ id: m[1], ms: Number((m[2] ?? "").replace(/_/g, "")) }));
  ok(`${f} declares a POLL_MS cadence this test can read`, consts.some((c) => c.id === "POLL_MS"));
  for (const c of consts) {
    const secs = c.ms / 1000;
    const phrase = c.id === "POLL_MS" ? `every ${secs} seconds` : `${name} every ${secs} seconds`;
    ok(`${f} ${c.id} = ${c.ms} ms: the hint says "${phrase}"`, Number.isInteger(secs) && text.includes(phrase));
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-auto-refresh-hint: ${checks} checks, ${failures} failures`);
verdictReached(failures, checks);
if (failures > 0) process.exitCode = 1;
