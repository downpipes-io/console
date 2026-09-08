// validate-audit-capacity-screen.ts
//
// WHAT THE OPERATOR SEES WHEN THE AUDIT CHAIN HAS ALREADY ROLLED OVER.
//
// The engine's retention rollover is honest and was already driven: engine test/validate-audit-cap-boundary.ts
// crosses AUDIT_CAP with real appends and proves the drop is declared in storage, that a rollover-aware verify
// reports the retained chain intact, and that a tamper inside the window is still detected. None of that is
// re-litigated here. This file asks the question that suite does not: DOES THE FACT REACH THE SCREEN?
//
// It did not, on both surfaces at once:
//
//   1. GET /admin/audit/verify has always carried rolledOver, rolledOverCount and earliestSeq. ChainVerdict
//      declared none of them and no render code read them, so at 12,345 appends the screen said "Chain intact
//      through entry 12345" over a chain that begins at entry 2,346, with nothing said about the 2,345 entries
//      destroyed to get there. The engine's own note beside those fields says they exist "so the console can
//      show 'chain begins at entry N, M earlier entries rolled over'".
//
//   2. The capacity card reads GET /admin/status, whose only capacity signal is a boolean derived from a count
//      that SATURATES at the cap. auditNearCap is true identically at 9,000 appends, where nothing has been
//      lost, and at 12,345, where 2,345 entries have. The card's copy is future tense and ends "Export now to
//      retain the full history", which past the cap names a remedy that no longer exists: the full history is
//      already partly destroyed and no export can retrieve it.
//
// The instrument is the REAL engine durable object over a faithful storage double, driven past the cap with
// real appends, and the REAL console renderers. Nothing here re-implements either side.
//
// Cross-repo: it degrades to a visible skip without an engine checkout, and REFUSES under REQUIRE_ENGINE=1,
// which is the workspace chain's own convention.
import { installDomShim, textOf } from "./dom-shim.ts";

installDomShim();

import type { ChainVerdict } from "../src/api.ts";
import { nearCapView } from "../src/screens/access-security/audit.ts";
import { renderChainVerdict } from "../src/screens/access-security/audit-events.ts";
import { importFromEngine } from "./engine-path.ts";

const HERE = new URL(".", import.meta.url).pathname;

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  if (!cond) failures++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
}

console.log("validate-audit-capacity-screen");

// ---- PART 1: the pure view decisions, which need no engine ---------------------------------------
console.log("\nPART 1: nearCapView, and the state it could not express");
ok("a failed read is an unknown", nearCapView("failed", undefined) === "unknown-read-failed");
ok("an engine that reports no capacity is an unknown", nearCapView("ok", undefined) === "unknown-not-reported");
ok("an engine that answered and said not near cap is the only silent path", nearCapView("ok", false) === "none");
ok("near cap with nothing rolled off is the approaching warning", nearCapView("ok", true, 0) === "warn");
ok("near cap with entries already rolled off is a DIFFERENT state", nearCapView("ok", true, 1) === "rolling");
ok("and it stays that state far past the edge", nearCapView("ok", true, 2345) === "rolling");
// The property that was violated: the two states must never collapse onto one verdict.
ok("approaching and rolling never classify the same", nearCapView("ok", true, 0) !== nearCapView("ok", true, 2345));
// NEGATIVE CONTROLS, each of which must classify differently from "rolling".
ok("an absent rolled-over count on an older engine stays the approaching warning", nearCapView("ok", true) === "warn");
ok("a rolled-over count cannot manufacture a warning the engine did not give", nearCapView("ok", false, 500) === "none");
ok("nor override a failed read", nearCapView("failed", true, 500) === "unknown-read-failed");
ok("nor override an unreported capacity", nearCapView("ok", undefined, 500) === "unknown-not-reported");

console.log("\nPART 2: renderChainVerdict on a rolled-over chain");
const clean: ChainVerdict = { intact: true, checkedThrough: 500, rolledOver: false, rolledOverCount: 0, earliestSeq: 1 };
const rolled: ChainVerdict = { intact: true, checkedThrough: 12345, rolledOver: true, rolledOverCount: 2345, earliestSeq: 2346 };
const cleanText = textOf(renderChainVerdict(clean));
const rolledText = textOf(renderChainVerdict(rolled));
ok("a chain that has never rolled reads intact and says nothing about a rollover", cleanText.includes("intact") && !cleanText.includes("rolled over"));
ok("a rolled-over chain still reads intact, because it IS intact", rolledText.includes("intact"));
ok("and it is never called a break", !rolledText.toLowerCase().includes("break"));
ok("it names how many entries have gone", rolledText.includes("2345"));
ok("it names the entry the retained chain begins at", rolledText.includes("2346"));
ok("it says an export carries the retained chain rather than the full history", rolledText.includes("not the full history"));
ok("the two verdicts no longer render the same sentence", cleanText !== rolledText);
// POSITION CONTROL: vary what should not matter. The entry number moves; the rollover statement does not.
const elsewhere: ChainVerdict = { ...rolled, checkedThrough: 99999 };
ok("the rollover statement does not move with the head entry number", textOf(renderChainVerdict(elsewhere)).includes("2345 earlier entries have rolled over"));
// NEGATIVE CONTROL: a deleted TAIL is a different fault and must keep out-ranking a rollover.
const truncated: ChainVerdict = { ...rolled, headTruncated: true, headTruncatedAt: 12345 };
ok("a deleted tail still out-ranks the rollover notice", textOf(renderChainVerdict(truncated)).includes("are missing"));
// THE FLAG IS THE FACT; THE COUNT IS ONLY HOW MUCH. rolledOver:true is the engine's statement that
// entries are gone; the count is only how many. A rollover record whose count has been lost still
// reports rolledOver:true with rolledOverCount:0, and the engine books `rollover-record-lost` for
// exactly that state, so the screen must still say the chain's beginning has been destroyed even when
// it cannot say how much of it.
const countless = textOf(renderChainVerdict({ intact: true, checkedThrough: 10, rolledOver: true, rolledOverCount: 0, earliestSeq: 4 }));
ok("a rolledOver flag with NO usable count still says the beginning is gone", countless.includes("rolled over"));
ok("and it does not invent a number it was not given", !countless.includes("0 earlier"));
ok("and it names the entry the retained chain begins at, which is the half a lost count does not take away", countless.includes("begins at entry 4"));
ok("and it is still not a break", !countless.toLowerCase().includes("break"));
// NEGATIVE CONTROL: the flag is what triggers it, so a FALSE flag stays silent whatever the count says.
ok("a false rolledOver flag stays silent even with a count present", !textOf(renderChainVerdict({ intact: true, checkedThrough: 10, rolledOver: false, rolledOverCount: 7, earliestSeq: 1 })).includes("rolled over"));

// ---- PART 3: driven against the REAL engine ------------------------------------------------------
type AuditDO = {
  appendAudit(d: unknown): Promise<unknown>;
  verifyAudit(): Promise<ChainVerdict & { auditNearCap: boolean; rolledOverCount: number }>;
  auditCountAndNearCap(): Promise<{ auditCount: number; auditNearCap: boolean; auditRolledOverCount: number }>;
};

class FaithfulStorage {
  readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T>(opts?: { prefix?: string; limit?: number; startAfter?: string; start?: string; reverse?: boolean }): Promise<Map<string, T>> {
    const prefix = opts?.prefix ?? "";
    let keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (opts?.startAfter !== undefined) keys = keys.filter((k) => k > opts.startAfter!);
    if (opts?.start !== undefined) keys = keys.filter((k) => k >= opts.start!);
    if (opts?.reverse === true) keys = keys.reverse();
    if (opts?.limit !== undefined) keys = keys.slice(0, opts.limit);
    const out = new Map<string, T>();
    for (const k of keys) out.set(k, this.map.get(k) as T);
    return out;
  }
  async setAlarm(_t: number): Promise<void> {
    /* no-op */
  }
}

const auditMod = await importFromEngine<{ AUDIT_CAP: number; AUDIT_NEAR_CAP_FRACTION: number }>(HERE, "src/admin/audit.ts");
const schedMod = await importFromEngine<{ SchedulerDO: new (state: unknown) => unknown }>(HERE, "src/sched/scheduler-do.ts");
if (auditMod === null || schedMod === null) {
  console.log("\nPART 3 SKIPPED: no engine checkout reachable, so the driven half could not run.");
  console.log(`\nvalidate-audit-capacity-screen: ${checks} check(s), ${failures} failure(s), driven half skipped`);
  console.error("the pure half passed; the engine-driven half needs an engine checkout (set DOWNPIPES_ENGINE)"); process.exit(2);
} else {
  const { AUDIT_CAP, AUDIT_NEAR_CAP_FRACTION } = auditMod;
  const NEAR = Math.floor(AUDIT_CAP * AUDIT_NEAR_CAP_FRACTION);
  const storage = new FaithfulStorage();
  const dobj = new schedMod.SchedulerDO({ storage } as unknown) as AuditDO;
  const draft = (i: number): unknown => ({
    actorEmail: null,
    actorMethod: "engine",
    sourceIp: null,
    action: "engine-version-change",
    outcome: "success",
    target: { kind: "engine-state", field: "engineVersion", detail: `0.0.${i}` },
  });

  const TOP = AUDIT_CAP + 300;
  const DOSES = [NEAR, AUDIT_CAP, TOP];
  const seen = new Map<number, { verdict: ChainVerdict; nearCap: boolean; rolled: number; screen: string; view: string }>();
  const realLog = console.log;
  console.log = (...a: unknown[]): void => {
    const f = a[0];
    if (typeof f === "string" && f.startsWith('{"source":"downpipe-audit"')) return;
    realLog(...(a as []));
  };
  const t0 = Date.now();
  for (let i = 1; i <= TOP; i++) {
    await dobj.appendAudit(draft(i));
    if (DOSES.includes(i)) {
      const v = await dobj.verifyAudit();
      const c = await dobj.auditCountAndNearCap();
      seen.set(i, {
        verdict: v,
        nearCap: c.auditNearCap,
        rolled: c.auditRolledOverCount,
        screen: textOf(renderChainVerdict(v)),
        view: nearCapView("ok", c.auditNearCap, c.auditRolledOverCount),
      });
    }
  }
  console.log = realLog;
  console.log(`\nPART 3: driven against the real engine durable object (${TOP} appends in ${Date.now() - t0}ms)`);
  for (const dose of DOSES) {
    const s = seen.get(dose)!;
    console.log(`  after ${dose}: engine rolledOverCount=${s.rolled} nearCap=${s.nearCap} -> card "${s.view}"`);
  }

  const atNear = seen.get(NEAR)!;
  const atCap = seen.get(AUDIT_CAP)!;
  const atTop = seen.get(TOP)!;

ok("the engine reports nothing lost at the near-cap threshold", atNear.rolled === 0);
ok("and nothing lost at exactly the cap", atCap.rolled === 0);
ok("and 300 lost past it", atTop.rolled === 300);
ok("the near-cap boolean is identical in all three, which is why the card needed the count", atNear.nearCap && atCap.nearCap && atTop.nearCap);
ok("the card warns without claiming a loss while nothing is lost", atNear.view === "warn" && atCap.view === "warn");
ok("and switches state once entries are actually being destroyed", atTop.view === "rolling");
ok("the chain verdict stays intact across the rollover", atNear.verdict.intact && atTop.verdict.intact);
ok("the screen said nothing about a rollover before the edge", !atCap.screen.includes("rolled over"));
ok("and names the loss past it, in the sentence rather than in the head entry number", atTop.screen.includes("300 earlier entries have rolled over"));
ok("and names the entry the retained chain now begins at", atTop.screen.includes(`begins at entry ${TOP - AUDIT_CAP + 1}`));
ok("the two screens differ", atCap.screen !== atTop.screen);

  console.log(`\nvalidate-audit-capacity-screen: ${checks} check(s), ${failures} failure(s)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}
