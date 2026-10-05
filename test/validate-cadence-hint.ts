// The schedule pickers state when a run starts, and do not promise a run is never late.
//
//   node test/validate-cadence-hint.ts
//
// The create wizard (wiz-cadence) and the bulk import (import-cadence) both said "a run can come early,
// never late". That is false by up to one scheduler tick: the cadence path subtracts up to a tenth of the
// cadence as jitter, so a run can fall due early, and the due run then normally starts at the next
// 15-minute tick, which can be up to fifteen minutes after the due time. A tick that runs low on budget
// carries its remaining due runs to the next tick, so "starts at the next tick" is not absolute either.
// Both hints link to backing-up/overview#the-fifteen-minute-floor, which sets out that band. Both now say
// the cadence is a ceiling on the due time and that a run normally starts at the next 15-minute tick. Each
// hint stays a plain string literal in its own field() call.
//
// Part 1 renders the real import drawer and reads the hint as an operator sees it. Part 2 covers the wizard,
// whose schedule step renders only after a source is picked and the destination read settles: it scans every
// console source file for the false sentence, so a copy of it in either picker, or anywhere else, fails.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { installDomShim, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
installDomShim();

const { openImport } = await import("../src/screens/sources-downpipes/editor-import.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  console.log("(1) the bulk import drawer, rendered");
  {
    openImport({} as never, null, new Set(), () => {});
    const t = textOf(document.body as never);
    ok("(1a) the drawer rendered its schedule field", t.includes("Every imported downpipe shares this cadence."));
    ok("(1b) the hint says a run normally starts at the next 15-minute tick", t.includes("it normally starts at the next 15-minute tick"));
    ok("(1c) the hint says the cadence is a ceiling on the due time", t.includes("It is a ceiling on the due time"));
    ok("(1d) the hint no longer says a run is never late", !t.includes("never late"));
    ok("(1e) the hint does not say a run always starts at the next tick", !t.includes("and it starts at the next 15-minute tick"));
  }

  console.log("\n(2) no console source file promises a run is never late");
  {
    const root = new URL("..", import.meta.url).pathname;
    const src = files(join(root, "src"));
    ok("(2a) the scan reads the console source (more than 100 files)", src.length > 100);
    const offenders = src.filter((p) => /never late/.test(readFileSync(p, "utf8"))).map((p) => relative(root, p));
    ok(`(2b) no file carries "never late"${offenders.length > 0 ? ` (found in ${offenders.join(", ")})` : ""}`, offenders.length === 0);
    const wizard = readFileSync(join(root, "src/screens/sources-downpipes/editor-wizard.ts"), "utf8");
    ok("(2c) the wizard's schedule hint says a run normally starts at the next 15-minute tick", wizard.includes('hint: "How often this downpipe runs. It is a ceiling on the due time: a run can come early, and it normally starts at the next 15-minute tick."'));
    const offendersAbs = src.filter((p) => /and it starts at the next 15-minute tick/.test(readFileSync(p, "utf8"))).map((p) => relative(root, p));
    ok(`(2d) no file says a run always starts at the next tick${offendersAbs.length > 0 ? ` (found in ${offendersAbs.join(", ")})` : ""}`, offendersAbs.length === 0);
  }

  console.log(`\n${failures === 0 ? "CADENCE-HINT OK: both schedule pickers say a run normally starts at the next 15-minute tick" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
