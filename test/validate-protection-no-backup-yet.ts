// A downpipe is called backed up only after at least one of its runs has succeeded.
// Run with: node test/validate-protection-no-backup-yet.ts
//
// THE DEFECT THIS PINS. The protection statement built "<source> is backed up <cadence> to <destination>"
// for every enabled downpipe with a destination, whether or not any run had ever succeeded, and the
// downpipes table then labelled the row "Backed up, unproven". A downpipe that had never run and one whose
// every run failed both read as backed up, on the Overview lead, the downpipes subtitle and the coverage
// column.
//
// THE RULE. A successful run is read from lastRunId, the id of the downpipe's last SUCCESSFUL run: the
// engine advances it only on a successful completion and resets it to null when the source changes
// (protection-statement.ts, hasSuccessfulRun). With no successful run the statement says no backup has
// completed yet, in the "uncovered" tone, so every roll-up counts it as not covered and nothing hues it
// green. A downpipe that succeeded before and whose LATEST run failed keeps its lastRunId, so it still
// reads as backed up and the state column carries the failure.
//
// Fixtures are built in the engine's wire shape and driven through mapEngineDownpipeState, the mapping
// listDownpipes runs, so a mapping that dropped lastRunId would turn these reds. The table half renders the
// real buildTable under the DOM shim and reads the cells a person reads.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { qsa } from "./dom-shim.ts";
import { buildTable } from "../src/screens/sources-downpipes/table.ts";
import type { RunFacts } from "../src/screens/sources-downpipes/helpers.ts";
import { destinationFromStatus, fleetProtection, protectionStatement, type DestinationDescriptor } from "../src/lib/protection-statement.ts";
import { mapEngineDownpipeState } from "../src/api.ts";
import type { DownpipeState, EngineClient, EngineDownpipeState, RunHistoryEntry, StatusReport } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const NOW = Date.parse("2026-06-09T12:00:00Z");
const DAY = 86_400_000;
const DAILY = 86_400;
const R2_DEST: DestinationDescriptor = { name: "R2 dr-archive", configured: true };

// wire builds a downpipe in the engine's response shape and maps it the way listDownpipes does.
function wire(id: string, over: Partial<EngineDownpipeState> = {}, enabled = true): DownpipeState {
  const w: EngineDownpipeState = {
    config: { id, name: id, cadenceSeconds: DAILY, enabled, source: { type: "kv", binding: id, include: [], exclude: [] } },
    nextRunAt: NOW + DAY,
    lastRunId: "r1",
    inFlight: false,
    ...over,
  };
  return mapEngineDownpipeState(w);
}

// The five states this fix separates, as the engine records them.
const neverRun = wire("never", { lastRunId: null });
const firstRunInFlight = wire("inflight", { lastRunId: null, inFlight: true });
// Every run failed: the engine completes a failed run with an empty runId, which leaves lastRunId null and
// sealedRuns unmoved, so the downpipe record of a canary that fails every run looks like this.
const alwaysFailing = wire("failing", { lastRunId: null, sealedRuns: 0 });
// The source changed under a downpipe that had backed up its old source: lastRunId resets, but sealedRuns,
// the integrity stamp and the restore proof are all carried over, and none of them describes this source.
const sourceChanged = wire("moved", {
  lastRunId: null,
  sealedRuns: 12,
  integrityVerified: { at: NOW - DAY / 2, how: "run" },
  restoreProven: { at: NOW - 2 * DAY, by: "alice@example.com", method: "blind-test", runId: "old-source-run" },
});
// The legitimate "backed up, unproven" case the training course narrates: a run succeeded, nothing proven.
const backedUp = wire("backedup", { lastRunId: "run-backedup-0002" });
// Succeeded before, latest run failed: lastRunId still names the last success.
const regressed = wire("regressed", { lastRunId: "run-regressed-0006" });

console.log("\n-- the statement: no successful run is never 'backed up' --");
for (const [label, st] of [
  ["never run", neverRun],
  ["first run in flight", firstRunInFlight],
  ["every run failed", alwaysFailing],
  ["source changed, old stamps carried over", sourceChanged],
] as const) {
  const ps = protectionStatement(st, R2_DEST, NOW);
  ok(`${label}: the sentence never says "is backed up"`, !ps.sentence.includes("is backed up"));
  ok(`${label}: the sentence says no backup has completed yet`, ps.sentence === `${st.config.name} (KV) is configured for backup daily to R2 dr-archive, but no backup has completed yet.`);
  ok(`${label}: the tone is uncovered`, ps.tone === "uncovered");
  ok(`${label}: it is marked as the no-backup-yet state`, ps.noBackupYet === true);
  ok(`${label}: the not-covered line says it is not protected yet`, ps.notCovered.startsWith(`${st.config.name} (KV) is not protected yet: it has no backup to restore from until a run succeeds.`));
}
{
  const ps = protectionStatement(sourceChanged, R2_DEST, NOW);
  ok("source changed: the old source's integrity stamp is not stated", !ps.sentence.includes("integrity-checked"));
  ok("source changed: the old source's restore proof is not stated", !ps.sentence.includes("proven"));
}

console.log("\n-- the statement: a successful run keeps the existing read --");
{
  const ps = protectionStatement(backedUp, R2_DEST, NOW);
  ok("backed up: the sentence still opens with the backup clause", ps.sentence.startsWith("backedup (KV) is backed up daily to R2 dr-archive, "));
  ok("backed up, nothing proven: the tone is still unproven", ps.tone === "unproven");
  ok("backed up: not the no-backup-yet state", ps.noBackupYet === false);
  const pr = protectionStatement(regressed, R2_DEST, NOW);
  ok("latest run failed after an earlier success: still backed up", pr.sentence.startsWith("regressed (KV) is backed up daily"));
  ok("latest run failed after an earlier success: tone unchanged (unproven)", pr.tone === "unproven" && pr.noBackupYet === false);
}

console.log("\n-- the statement: the earlier uncovered reads still come first --");
{
  const paused = protectionStatement(wire("paused", { lastRunId: null }, false), R2_DEST, NOW);
  ok("paused and never run: the paused read wins", paused.sentence === "paused (KV) is NOT being backed up: this downpipe is paused." && paused.noBackupYet === false);
  const noDest = protectionStatement(neverRun, { name: null, configured: false }, NOW);
  ok("no destination and never run: the no-destination read wins", noDest.sentence.includes("has NO archive destination set") && noDest.noBackupYet === false);
  const unread = protectionStatement(neverRun, destinationFromStatus(null), NOW);
  ok("destination unreadable and never run: still no backup yet, never 'backed up'", unread.noBackupYet === true && unread.tone === "uncovered" && !unread.sentence.includes("is backed up"));
}

console.log("\n-- every roll-up counts it as not covered --");
{
  const fp = fleetProtection([neverRun, backedUp], R2_DEST, NOW);
  ok("fleet: the never-run downpipe is counted uncovered", fp.counts.uncovered === 1 && fp.counts.unproven === 1);
  ok("fleet: the worst tone is uncovered", fp.tone === "uncovered");
  ok("fleet: the summary does not call both backed up", fp.summary === "2 downpipes: 1 backed up but not proven, 1 not covered.");
  ok("fleet: the not-covered line leads with Not covered", fp.notCovered.startsWith("Not covered: 1 downpipe is not being backed up"));
  const failingOnly = fleetProtection([alwaysFailing], R2_DEST, NOW);
  ok("fleet of one always-failing downpipe: uncovered, never a proof gap", failingOnly.tone === "uncovered" && !failingOnly.notCovered.startsWith("Proof gap"));
}

console.log("\n-- the downpipes table: the coverage cell a person reads --");
{
  const run = (runId: string, status: RunHistoryEntry["status"], agoMs: number): RunHistoryEntry => ({ runId, index: 0, startedAt: new Date(Date.now() - agoMs).toISOString(), status });
  const latestRun = new Map<string, RunFacts>();
  latestRun.set("never", { latest: undefined, lastGood: undefined });
  latestRun.set("failing", { latest: run("run-failing-0003", "failed", 3_600_000), lastGood: undefined });
  latestRun.set("backedup", { latest: run("run-backedup-0002", "ok", 3_600_000), lastGood: run("run-backedup-0002", "ok", 3_600_000) });
  latestRun.set("regressed", { latest: run("run-regressed-0007", "failed", 3_600_000), lastGood: run("run-regressed-0006", "ok", 2 * DAY) });
  const status: StatusReport = {
    service: "downpipes", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true }, configKeysConfigured: { recipient: true, wrapKey: true }, destConfigured: true, destKind: "r2",
    updateChannelConfigured: false, licenceConfigured: false, downpipeCount: 4, ready: true,
  };
  const table = buildTable({} as unknown as EngineClient, [neverRun, alwaysFailing, backedUp, regressed], latestRun, new URLSearchParams("sort=coverage:asc"), false, () => {}, destinationFromStatus(status));
  const rows = qsa(table.el as never, "tbody tr").map((tr) => qsa(tr, "td").map((td) => (td as unknown as { textContent: string }).textContent));
  const row = (name: string): string[] => rows.find((r) => (r[0] ?? "").startsWith(name)) ?? [];
  const coverage = (name: string): string => row(name)[4] ?? "(row not found)";
  const label = (name: string): string => coverage(name).split(". ")[0] ?? "";
  ok("never run: the coverage cell reads No backup yet", label("never") === "No backup yet");
  ok("every run failed: the coverage cell reads No backup yet", label("failing") === "No backup yet");
  ok("never run: the cell never says Backed up", !coverage("never").includes("Backed up"));
  ok("every run failed: the cell never says Backed up", !coverage("failing").includes("Backed up"));
  ok("a successful run, nothing proven: the cell keeps Backed up, unproven exactly", label("backedup") === "Backed up, unproven");
  ok("latest run failed after an earlier success: the cell keeps Backed up, unproven", label("regressed") === "Backed up, unproven");
  ok("latest run failed after an earlier success: the state column carries the failure", (row("regressed")[3] ?? "").toLowerCase().includes("fail"));
  const dots = (name: string): string => {
    const tr = qsa(table.el as never, "tbody tr").find((t) => ((qsa(t, "td")[0] as unknown as { textContent: string } | undefined)?.textContent ?? "").startsWith(name));
    const cell = tr === undefined ? undefined : qsa(tr, "td")[4];
    return cell === undefined ? "" : qsa(cell, ".dot").map((d) => (d as unknown as { className: string }).className).join(" ");
  };
  ok("no backup yet: the dot is the danger hue, never ok", dots("never").includes("dot--danger") && !dots("never").includes("dot--ok"));
  ok("sorted worst-first, both no-backup rows sit above the backed-up rows", rows.slice(0, 2).every((r) => (r[4] ?? "").startsWith("No backup yet")));
}

console.log("\n-- the downpipes table: the coverage tooltip follows the recovery posture, not a bare drill --");
{
  const okRun: RunHistoryEntry = { runId: "run-backedup-0002", index: 0, startedAt: new Date(Date.now() - 3_600_000).toISOString(), status: "ok" };
  const latestRun = new Map<string, RunFacts>([["backedup", { latest: okRun, lastGood: okRun }]]);
  const tipFor = (posture: "operational" | "break-glass-only"): string => {
    const t = buildTable({} as unknown as EngineClient, [backedUp], latestRun, new URLSearchParams(), false, () => {}, R2_DEST, posture);
    const tr = qsa(t.el as never, "tbody tr")[0];
    const coverageTd = tr === undefined ? undefined : qsa(tr, "td")[4];
    const cell = coverageTd === undefined
      ? undefined
      : (qsa(coverageTd, ".dp-name")[0] as unknown as { getAttribute: (k: string) => string | null } | undefined);
    return cell?.getAttribute("title") ?? "";
  };
  const operationalTip = tipFor("operational");
  const breakGlassTip = tipFor("break-glass-only");
  ok("operational posture: the tip still points at the drill", operationalTip.includes("run Verify restore (drill)"));
  ok("operational posture: the tip never names an attended verification", !operationalTip.includes("attended verification"));
  ok("break-glass-only posture: the tip points at an attended verification instead of a drill", breakGlassTip.includes("run an attended verification"));
  ok(
    "break-glass-only posture: the tip never sends the operator at a drill the engine refuses",
    !breakGlassTip.includes("Verify restore (drill)") && !breakGlassTip.includes("start a restore drill"),
  );
}

console.log("");
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.log(`VALIDATE-PROTECTION-NO-BACKUP-YET: ${failures} FAILED`);
  process.exit(1);
}
console.log("VALIDATE-PROTECTION-NO-BACKUP-YET VECTORS PASS");
