#!/usr/bin/env node
// CI CONCLUSION FRESHNESS GUARD: is a CI conclusion evidence about the tree you are asking about?
//
// WHY THIS EXISTS. A hook or gate can read the conclusion of a CI workflow and act on it, printing or
// staying quiet only when that conclusion is `failure`, without ever checking whether the run it read
// actually graded the commit the tree is on now. When a workflow stops running (GitHub Actions minutes
// exhausted, for one), the newest completed run can sit for days while the tree moves on without it,
// and a stale success reads exactly like a fresh one: the reader stays quiet, and its silence is
// indistinguishable from a green while whatever the workflow was watching drifts underneath it.
//
// Asking the question locally, against the actual tip rather than trusting a cached conclusion, closes
// that gap for one reader but not for every reader that treats a conclusion this way. The defect is not
// specific to one workflow: ANYTHING THAT READS A CI CONCLUSION WITHOUT COMPARING ITS SHA TO THE TIP IT
// IS ASKING ABOUT IS READING A TREE NOBODY HAS GRADED, for however long that workflow has been stalled.
//
// THE RULE THIS ENCODES. A conclusion is evidence about ONE TREE: the commit it ran against.
// Asked about any other commit it is not a weaker answer, it is NO ANSWER, and it must be
// reported as could-not-check rather than as a pass.
//
// AGE IS NOT THE TEST, AND GETTING THIS WRONG PRODUCES A FALSE REFUSAL. The obvious repair is to
// refuse anything older than some number of hours. That is wrong: a run can be many hours old and
// still have graded the current tip, simply because nothing has landed on the tree since. Its green
// is true, and an age threshold would refuse the one answer that was sound. So the test is whether
// the run's sha IS the tip being asked about, and age is carried as context for the reader rather
// than scored into the verdict. The self-test drives that exact case in both directions.
//
// WHAT IT DOES NOT DO. It does not ask GitHub anything. It is given a conclusion and two shas and
// it decides what they mean, which is what makes it testable offline and what lets the caller
// choose how to obtain them. It also does not decide whether a red should block: that is the
// caller's severity split, not this file's.

const USAGE = `ci-conclusion-freshness-guard.mjs
  --conclusion <s>   the run's conclusion (success, failure, cancelled, skipped, null, ...)
  --run-sha <sha>    the commit that run actually graded
  --tip-sha <sha>    the commit you are asking about
  --created-at <ts>  optional ISO8601, reported as context only
  --now <ts>         optional ISO8601, for deterministic testing
  --selftest         run the self-test and exit
Exit 0 current and green, 1 current and red, 2 could not check.`;

/** The three-way outcome. `current` is the only one that carries a verdict about the tip. */
export const CURRENT = "current";
export const STALE = "stale";
export const UNUSABLE = "unusable";

/**
 * decide - what a conclusion means about the tip.
 *
 * Every path returns a `state` and a `why`. There is deliberately no path that returns nothing:
 * an absent answer is a decision (UNUSABLE), because the failure this file exists to close is a
 * reader treating "no answer" as "no problem".
 */
export function decide({ conclusion, runSha, tipSha }) {
  if (typeof tipSha !== "string" || tipSha.length === 0) {
    return { state: UNUSABLE, green: false, why: "no tip sha was supplied, so there is no question to answer" };
  }
  if (typeof runSha !== "string" || runSha.length === 0) {
    return { state: UNUSABLE, green: false, why: "no completed run was found, so nothing has graded this tree" };
  }
  // Shas arrive abbreviated from some callers and full from others. Compare on the shorter
  // length, and refuse to compare at all below 7, where collisions stop being negligible.
  const n = Math.min(runSha.length, tipSha.length);
  if (n < 7) {
    return { state: UNUSABLE, green: false, why: `a sha of ${n} characters is too short to compare safely` };
  }
  if (runSha.slice(0, n).toLowerCase() !== tipSha.slice(0, n).toLowerCase()) {
    return {
      state: STALE,
      green: false,
      why: `the newest completed run graded ${runSha.slice(0, 8)}, which is not ${tipSha.slice(0, 8)}`,
    };
  }
  if (conclusion === "success") {
    return { state: CURRENT, green: true, why: `the run at ${runSha.slice(0, 8)} concluded success, and that IS this tree` };
  }
  if (conclusion === "failure" || conclusion === "timed_out") {
    return { state: CURRENT, green: false, why: `the run at ${runSha.slice(0, 8)} concluded ${conclusion}` };
  }
  // cancelled, skipped, action_required, neutral, null. A run that reached no verdict proves
  // nothing either way, and the sha matching does not make it evidence.
  return {
    state: UNUSABLE,
    green: false,
    why: `the run at ${runSha.slice(0, 8)} concluded ${String(conclusion)}, which is not a verdict about the code`,
  };
}

/** Hours between two ISO timestamps, or null when either is unreadable. */
export function ageHours(createdAt, now) {
  const a = Date.parse(createdAt ?? "");
  const b = Date.parse(now ?? "");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 3600000;
}

/** exitFor - could-not-check outranks a pass, so UNUSABLE and STALE both leave 2. */
export function exitFor(state, green) {
  if (state === CURRENT) return green ? 0 : 1;
  return 2;
}

const CASES = [
  // The defect this file was built for: a success that graded a commit main has moved past.
  { name: "a stale success is NOT a green", in: { conclusion: "success", runSha: "8c67355f", tipSha: "b5d03521" }, want: STALE, wantExit: 2 },
  // The green control beside it. Same conclusion, same age, sha matches, so the answer stands.
  { name: "a success AT the tip is a green", in: { conclusion: "success", runSha: "b5d03521", tipSha: "b5d03521" }, want: CURRENT, wantExit: 0 },
  // The false refusal an age threshold would produce, pinned so it cannot be reintroduced.
  // A run that is old but at the tip regardless has a green that is true.
  { name: "a 65-hour-old success at the tip is still a green", in: { conclusion: "success", runSha: "2c7cc5ac", tipSha: "2c7cc5ac" }, want: CURRENT, wantExit: 0 },
  { name: "a stale failure is not a red about this tree either", in: { conclusion: "failure", runSha: "8c67355f", tipSha: "b5d03521" }, want: STALE, wantExit: 2 },
  { name: "a failure at the tip is a real red", in: { conclusion: "failure", runSha: "b5d03521", tipSha: "b5d03521" }, want: CURRENT, wantExit: 1 },
  { name: "no run at all is could-not-check, never a pass", in: { conclusion: "success", runSha: "", tipSha: "b5d03521" }, want: UNUSABLE, wantExit: 2 },
  { name: "no tip to ask about is could-not-check", in: { conclusion: "success", runSha: "b5d03521", tipSha: "" }, want: UNUSABLE, wantExit: 2 },
  { name: "a cancelled run at the tip proves nothing", in: { conclusion: "cancelled", runSha: "b5d03521", tipSha: "b5d03521" }, want: UNUSABLE, wantExit: 2 },
  { name: "a skipped run at the tip proves nothing", in: { conclusion: "skipped", runSha: "b5d03521", tipSha: "b5d03521" }, want: UNUSABLE, wantExit: 2 },
  { name: "a null conclusion at the tip proves nothing", in: { conclusion: null, runSha: "b5d03521", tipSha: "b5d03521" }, want: UNUSABLE, wantExit: 2 },
  { name: "a timed_out run at the tip is a red", in: { conclusion: "timed_out", runSha: "b5d03521", tipSha: "b5d03521" }, want: CURRENT, wantExit: 1 },
  // Abbreviated against full, which is how the hook and gh actually pair up.
  { name: "an abbreviated sha matches its full form", in: { conclusion: "success", runSha: "b5d03521", tipSha: "b5d03521f46a811c5a74615bc20f07dc646dde7d" }, want: CURRENT, wantExit: 0 },
  { name: "a sha too short to compare is could-not-check, not a match", in: { conclusion: "success", runSha: "b5d03", tipSha: "b5d03521" }, want: UNUSABLE, wantExit: 2 },
  { name: "case differences do not make two shas disagree", in: { conclusion: "success", runSha: "B5D03521", tipSha: "b5d03521" }, want: CURRENT, wantExit: 0 },
];

function selfTest() {
  let bad = 0;
  for (const c of CASES) {
    const got = decide(c.in);
    const gotExit = exitFor(got.state, got.green);
    if (got.state !== c.want || gotExit !== c.wantExit) {
      console.error(`  FAIL ${c.name}: got ${got.state}/exit ${gotExit}, want ${c.want}/exit ${c.wantExit}`);
      bad++;
    }
  }
  // ANTI-VACUITY. A self-test that ran no case must fail rather than report a clean sweep, which
  // is the same rule this file applies to CI conclusions applied to this file's own evidence.
  const FLOOR = 14;
  if (CASES.length < FLOOR) {
    console.error(`[ci-conclusion-guard] FAIL: ${CASES.length} case(s) is below the floor of ${FLOOR}. A shrunken self-test is not a passing one.`);
    return 1;
  }
  if (bad > 0) {
    console.error(`[ci-conclusion-guard] FAIL: ${bad} of ${CASES.length} case(s) wrong.`);
    return 1;
  }
  // Both directions are asserted present, so the suite cannot pass by only ever refusing.
  const greens = CASES.filter((c) => c.wantExit === 0).length;
  const refusals = CASES.filter((c) => c.wantExit === 2).length;
  if (greens === 0 || refusals === 0) {
    console.error(`[ci-conclusion-guard] FAIL: the suite must contain both greens and refusals, got ${greens} and ${refusals}.`);
    return 1;
  }
  console.log(`[ci-conclusion-guard] PASS: ${CASES.length} cases, ${greens} green and ${refusals} could-not-check.`);
  return 0;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) process.exit(selfTest());
  if (process.argv.includes("--help")) { console.log(USAGE); process.exit(0); }

  const conclusion = arg("--conclusion") ?? null;
  const runSha = arg("--run-sha") ?? "";
  const tipSha = arg("--tip-sha") ?? "";
  const createdAt = arg("--created-at");
  const now = arg("--now") ?? new Date().toISOString();

  const v = decide({ conclusion, runSha, tipSha });
  const hrs = ageHours(createdAt, now);
  // A run cannot have completed in the future. When it reads that way the clock is wrong somewhere, and
  // saying so beats printing "-23h old", which the plant produced and which reads as a typo rather than as
  // the fault it is. The age is context either way, so this never changes the verdict.
  let age = "";
  if (hrs !== null && hrs < 0) age = ` Its timestamp is ${Math.abs(hrs).toFixed(0)}h in the FUTURE, so a clock is wrong.`;
  else if (hrs !== null) age = ` The run is ${hrs.toFixed(0)}h old.`;

  if (v.state === CURRENT && v.green) {
    console.log(`CI GREEN at ${tipSha.slice(0, 8)}: ${v.why}.${age}`);
  } else if (v.state === CURRENT) {
    console.log(`CI RED at ${tipSha.slice(0, 8)}: ${v.why}.${age}`);
  } else {
    console.log(`CI COULD NOT BE CHECKED for ${tipSha.slice(0, 8) || "an unnamed commit"}: ${v.why}.${age}`);
    console.log(`  This is NOT a clean result. Nothing here says this tree passed or failed.`);
  }
  process.exit(exitFor(v.state, v.green));
}
