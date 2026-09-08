// Validates the replication roll-up (src/components/replication.ts): the pure helpers that turn the
// engine's per-destination state into the honest 3-2-1 signals the map shows: "N of M copies", the amber
// "partial" lane to a destination that is behind, "failed" to one that is down, and the destination-node
// "down" badge. Every value must derive from PROVEN engine outcomes (holdsRunId, lastOk), never inflate.
// Pure functions, no DOM, no network. Run: node test/validate-replication.ts.

import { summariseReplication, destinationLaneStatus, downDestinationIds, destDownReasonLabel, distinctDownReasonLabels } from "../src/components/replication.ts";
import type { DestReplState } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function st(holdsRunId: string | null, lastOk: boolean): DestReplState {
  return { holdsRunId, holdsIndex: holdsRunId ? 1 : -1, lastOk, lastAttemptAt: 0 };
}

function main(): void {
  console.log("-- summariseReplication: copies / partial / down from proven state --");
  {
    ok("a single-destination downpipe has no redundancy concept",
      summariseReplication(["a"], { a: st("r4", true) }, "r4").redundancy === "single");

    const full = summariseReplication(["a", "b", "c"], { a: st("r4", true), b: st("r4", true), c: st("r4", true) }, "r4");
    ok("all destinations hold the latest run -> full (3 of 3)", full.redundancy === "full" && full.copies === 3 && full.downIds.length === 0);

    const down = summariseReplication(["a", "b", "c"], { a: st("r4", true), b: st("r4", true), c: st("r3", false) }, "r4");
    ok("one destination down -> partial (2 of 3), the run IS safe elsewhere", down.redundancy === "partial" && down.copies === 2);
    ok("the down destination is named", down.downIds.length === 1 && down.downIds[0] === "c");

    const behind = summariseReplication(["a", "b", "c"], { a: st("r4", true), b: st("r3", true), c: st("r3", true) }, "r4");
    ok("reachable-but-behind destinations are pending, not down (1 of 3, 2 pending)", behind.redundancy === "partial" && behind.copies === 1 && behind.pendingIds.length === 2 && behind.downIds.length === 0);

    const none = summariseReplication(["a", "b"], { a: st("r1", false), b: st("r1", false) }, "r4");
    ok("no destination holds the latest -> none", none.redundancy === "none" && none.copies === 0);

    const pending = summariseReplication(["a", "b"], {}, null);
    ok("a fan-out downpipe with no run yet -> pending (not a shortfall)", pending.redundancy === "pending" && pending.copies === 0);

    // A destination can hold the latest run AND be unreachable on its last attempt: it counts
    // toward copies (the run IS there) yet is still named in downIds (it cannot be reached now).
    const holdsButDown = summariseReplication(["a", "b"], { a: st("r4", true), b: st("r4", false) }, "r4");
    ok("both destinations hold the latest -> full even though one is down", holdsButDown.redundancy === "full" && holdsButDown.copies === 2);
    ok("the down-but-caught-up destination is still named in downIds", holdsButDown.downIds.length === 1 && holdsButDown.downIds[0] === "b");

    // A down destination carries its engine REASON, so a surface can say WHY (a credential to rotate
    // vs a retention lock vs a throttling store) instead of a flat "unreachable" that sends triage to the
    // wrong side. summariseReplication threads the per-destination reason into downReasons; the label map
    // turns each closed class into an operator label; distinctDownReasonLabels is what the drawer shows.
    const wr = (holdsRunId: string | null, lastOk: boolean, reason?: string): DestReplState => ({ holdsRunId, holdsIndex: holdsRunId ? 1 : -1, lastOk, lastAttemptAt: 0, ...(reason !== undefined ? { reason } : {}) });
    const withReasons = summariseReplication(["a", "b", "c"], { a: st("r4", true), b: wr("r3", false, "auth"), c: wr("r3", false, "worm-refused") }, "r4");
    ok("A down destination carries its engine reason in downReasons", withReasons.downReasons.b === "auth" && withReasons.downReasons.c === "worm-refused");
    ok("A reachable destination is absent from downReasons", !("a" in withReasons.downReasons));
    ok("A down destination the engine gave no reason for is absent from downReasons (never a guess)", holdsButDown.downReasons.b === undefined);
    ok("Auth -> credential rejected", destDownReasonLabel("auth") === "credential rejected");
    ok("Worm-refused -> retention lock refused the write", destDownReasonLabel("worm-refused") === "retention lock refused the write");
    ok("Throttled -> the store is rate-limiting", destDownReasonLabel("throttled") === "the store is rate-limiting");
    ok("Timeout -> the request timed out", destDownReasonLabel("timeout") === "the request timed out");
    ok("Tls -> TLS or certificate failure", destDownReasonLabel("tls") === "TLS or certificate failure");
    ok("Network -> network failure", destDownReasonLabel("network") === "network failure");
    ok("'other' maps to null (the bare 'down' already says it, never a guessed cause)", destDownReasonLabel("other") === null);
    ok("An absent or unrecognised reason maps to null", destDownReasonLabel(undefined) === null && destDownReasonLabel("some-newer-engine-class") === null);
    const labels = distinctDownReasonLabels(withReasons);
    ok("DistinctDownReasonLabels names the two actionable reasons, order-stable", labels.length === 2 && labels[0] === "credential rejected" && labels[1] === "retention lock refused the write");
    ok("An all-generic down set yields no reason labels (drawer shows just 'N down')", distinctDownReasonLabels(summariseReplication(["a", "b"], { a: st("r4", true), b: wr("r3", false, "other") }, "r4")).length === 0);
  }

  console.log("-- destinationLaneStatus: per-edge status under failover --");
  {
    const repl: Record<string, DestReplState> = { a: st("r4", true), b: st("r3", true), c: st("r3", false) };
    ok("a captured run on a destination that holds the latest -> healthy lane",
      destinationLaneStatus("healthy", "a", repl, "r4") === "healthy");
    ok("a reachable-but-behind destination -> partial (amber) lane",
      destinationLaneStatus("healthy", "b", repl, "r4") === "partial");
    ok("an unreachable destination -> failed (red) lane",
      destinationLaneStatus("healthy", "c", repl, "r4") === "failed");
    ok("a stale downpipe keeps stale on a caught-up destination",
      destinationLaneStatus("stale", "a", repl, "r4") === "stale");
    ok("a FAILED downpipe (capture failed) reads failed on every lane (data not safe anywhere)",
      destinationLaneStatus("failed", "a", repl, "r4") === "failed");
    ok("a disabled downpipe stays disabled on every lane",
      destinationLaneStatus("disabled", "b", repl, "r4") === "disabled");
    ok("no successful run yet -> no redundancy overlay (keeps the downpipe status)",
      destinationLaneStatus("healthy", "b", repl, null) === "healthy");
    ok("a down destination reads failed even before any run (unreachable is unreachable)",
      destinationLaneStatus("healthy", "c", repl, null) === "failed");

    // "d" is CONFIGURED on this downpipe and the engine has never reported a replication row for it. That row
    // absence, on its own, is BOTH of these downpipes:
    //   DARK   this destination has held no copy across five successful backups. Escalate.
    //   NEW    an operator added this destination minutes ago and the next backup has not run yet. Nothing is
    //          wrong, and nothing is owed until a backup completes.
    // Painting them the same lane is wrong either way round: reading DARK as "partial" tells operators to wait
    // for a copy nobody is making; reading NEW as "no-copy" puts the second-worst status in the fleet on a
    // healthy configuration.
    //
    // The ANCHOR is the discriminator: sealedRuns (the downpipe's monotone count of successful runs) minus the
    // destination's anchor (that count when it entered the fan-out) = how many backups have succeeded and
    // still produced no copy. Under two: catching up.
    const DARK = { sealedRuns: 5, anchors: { d: 0 } }; // 5 successful backups since d joined, d holds none
    const NEW = { sealedRuns: 5, anchors: { d: 5 } }; // d joined at the current count: no backup owed yet

    ok("DARK (5 successful backups since it joined, no copy) -> no-copy lane",
      destinationLaneStatus("healthy", "d", repl, "r4", DARK) === "no-copy");
    ok("NEW (added minutes ago to a running downpipe) -> partial (catching up), NOT no-copy",
      destinationLaneStatus("healthy", "d", repl, "r4", NEW) === "partial");
    ok("the two states do not paint the same lane",
      destinationLaneStatus("healthy", "d", repl, "r4", DARK) !== destinationLaneStatus("healthy", "d", repl, "r4", NEW));
    ok("No-copy and partial are DIFFERENT lanes on the same downpipe (the original gap)",
      destinationLaneStatus("healthy", "d", repl, "r4", DARK) !== destinationLaneStatus("healthy", "b", repl, "r4", DARK));
    ok("No-copy is NOT red: the run succeeded and the data is safe on the destinations that did report",
      destinationLaneStatus("healthy", "d", repl, "r4", DARK) !== "failed");
    ok("ONE successful backup since it joined is not yet a fault (the bar is two, as it is for the bot)",
      destinationLaneStatus("healthy", "d", repl, "r4", { sealedRuns: 5, anchors: { d: 4 } }) === "partial");
    ok("The SECOND successful backup is the bar: at exactly two, the silence is a fault",
      destinationLaneStatus("healthy", "d", repl, "r4", { sealedRuns: 5, anchors: { d: 3 } }) === "no-copy");
    ok("An UNANCHORED destination (a legacy record) keeps the milder lane, never a guessed fault",
      destinationLaneStatus("healthy", "d", repl, "r4", { sealedRuns: 90, anchors: { other: 0 } }) === "partial");
    ok("NO anchor at all (an engine that does not send one) keeps the milder lane",
      destinationLaneStatus("healthy", "d", repl, "r4") === "partial" && destinationLaneStatus("healthy", "d", repl, "r4", {}) === "partial");
    ok("A nonsense anchor on the wire (negative / NaN) is not trusted into a fault",
      destinationLaneStatus("healthy", "d", repl, "r4", { sealedRuns: 5, anchors: { d: -1 } }) === "partial"
      && destinationLaneStatus("healthy", "d", repl, "r4", { sealedRuns: Number.NaN, anchors: { d: 0 } }) === "partial");
    ok("Before any successful run there is no overlay, so a brand-new fan-out never reads no-copy",
      destinationLaneStatus("healthy", "d", repl, null, DARK) === "healthy");
    ok("A capture-level fault still wins on the lane (never greener than the run)",
      destinationLaneStatus("failed", "d", repl, "r4", DARK) === "failed" && destinationLaneStatus("disabled", "d", repl, "r4", DARK) === "disabled");
    ok("An entirely absent replication map reads no-copy when the anchor proves the silence",
      destinationLaneStatus("healthy", "d", undefined, "r4", DARK) === "no-copy");
    ok("An entirely absent replication map on a NEW destination is still just catching up",
      destinationLaneStatus("healthy", "d", undefined, "r4", NEW) === "partial");
  }

  console.log("-- summariseReplication: the anchor gates the drawer's 'never reported' count too --");
  {
    const repl: Record<string, DestReplState> = { a: st("r4", true) };
    const DARK = { sealedRuns: 5, anchors: { a: 0, d: 0 } };
    const NEW = { sealedRuns: 5, anchors: { a: 0, d: 5 } };

    const dark = summariseReplication(["a", "d"], repl, "r4", DARK);
    ok("DARK: the silent destination is counted as never-reported (the drawer says so, and should)",
      dark.neverReportedIds.length === 1 && dark.neverReportedIds[0] === "d" && dark.pendingIds.length === 0);

    const fresh = summariseReplication(["a", "d"], repl, "r4", NEW);
    ok("NEW: the just-added destination is counted as CATCHING UP, not never-reported (the drawer must not cry wolf either)",
      fresh.neverReportedIds.length === 0 && fresh.pendingIds.length === 1 && fresh.pendingIds[0] === "d");
    ok("NEW: the copies count is unchanged (it is still 1 of 2: the anchor changes the WORDS, never the maths)",
      fresh.copies === 1 && fresh.intended === 2 && fresh.redundancy === "partial");

    const legacy = summariseReplication(["a", "d"], repl, "r4");
    ok("NO ANCHOR: an unanchored silent destination is catching up, never a guessed fault (the map and drawer agree)",
      legacy.neverReportedIds.length === 0 && legacy.pendingIds.length === 1);
    ok("THE DRAWER AND THE MAP AGREE ON THE SAME DOWNPIPE: both derive from the one anchor",
      (summariseReplication(["a", "d"], repl, "r4", NEW).neverReportedIds.length > 0) === (destinationLaneStatus("healthy", "d", repl, "r4", NEW) === "no-copy")
      && (summariseReplication(["a", "d"], repl, "r4", DARK).neverReportedIds.length > 0) === (destinationLaneStatus("healthy", "d", repl, "r4", DARK) === "no-copy"));
  }

  console.log("-- downDestinationIds: aggregate the map's destination-down badge set --");
  {
    const byDp = {
      dp1: { a: st("r4", true), b: st("r3", false) }, // b down in dp1
      dp2: { a: st("r4", true), c: st("r4", true) }, // all up in dp2
      dp3: { c: st("r2", false) }, // c down in dp3
    };
    const down = downDestinationIds(byDp);
    ok("a destination down in ANY downpipe is in the set (b)", down.has("b"));
    ok("a destination down in another downpipe is in the set (c)", down.has("c"));
    ok("a destination up everywhere is NOT in the set (a)", !down.has("a"));
    ok("exactly the two down destinations are flagged", down.size === 2);
  }

    if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nREPLICATION ROLL-UP VECTORS PASS");
}

main();
