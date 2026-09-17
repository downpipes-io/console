// verdict-guard: the shared completion guard for the console's validator entry points.
//
// THE CLASS IT CLOSES. A validator that reaches exit 0 without ever reaching its own verdict line, so the
// RUN is structurally incapable of reporting a failure however much it checked. The distinction between
// the run and the assertions matters and this header used to blur it, saying every assertion in the run
// was incapable of failing while describing, in the next sentence, a run that printed 109 of them. Those
// 109 could each have failed; what could not happen was any of them turning into a red. It was measured
// in the sibling engine repo on test/validate-destsim-selftest.ts: a stall fault parked an accepted raw
// socket behind an unref()'d timer, so net.Server.close()'s completion callback never fired, the promise
// wrapping it never settled, Node found nothing ref'd holding the event loop open, drained it, and exited
// 0. The run printed 109 assertion lines, its verdict line never printed, and nothing noticed, because the
// only thing anyone checks is the exit code and the exit code was 0.
//
// WHY THE CONSOLE IS EXPOSED TO IT TOO, measured on this tree rather than assumed. 188 validator entry
// points are derived from package.json and .github/workflows, and 55 of them end in a floating tail,
// 54 on `main().catch(...)` and one on `finish().catch(...)`. That tail catches a REJECTION. It cannot
// catch a promise that never settles: there is nothing to reject, main()'s promise stays pending, the
// loop drains, and the process leaves with code 0 having printed however many assertions it got
// through. The same 55 files are where an early `return` skips the tally without any tail noticing.
//
// THAT 55 IS A COUNT OVER THE FILES THAT IMPORT THIS MODULE, WHICH IS NOT THE TREE. Counted by AST over
// all 840 tracked source files: 67 module-level floating catch tails, 63 in importers (8
// the guard's own fixtures, 55 real) and FOUR in files importing no guard at all, which put them outside
// the exemption argument entirely. All four are armed now. The lesson is about the denominator: a
// population measured over the enrolled set can only ever report the enrolled set as complete.
//
// AND THE RUNNER COULD NOT SEE IT EITHER. test/cov/run.mjs spawns each of the 25 coverage validators and
// counts `r.status !== 0` as a failure, which means a child that drains silently is counted as a PASS.
// A runner that reads only the child's exit code inherits the child's blind spot, so the guard has to
// live in the child. It did not until: all 25 children imported no guard, and none was
// derived by the gate because none is invoked directly by package.json or a workflow. DRIVEN before the
// repair, one injected false assertion plus one never-settling await in a child: the child printed
// `FAIL`, 46 bytes in total, and exited 0, and the runner printed `VERDICT: PASS failures=0 checks=25`
// and exited 0. Note what `checks=25` counts, which is FILES SPAWNED rather than checks run, so the
// runner's own verdict looked complete over a child that had run one assertion of hundreds. After
// arming, the same mutant leaves the child at exit 1 and the runner at exit 1. The gate now derives the
// children of a glob spawner so a file dropped into that directory tomorrow is enrolled or is a finding.
//
// WHY ONE HOOK IS ENOUGH. Assigning process.exitCode inside an "exit" listener is honoured by Node, and
// it overrides an explicit process.exit(0) that has already been requested (measured on Node 22.23.1,
// the version CI runs). So a single "exit" listener catches every way the tally can be skipped:
//   - the event loop drained while an await was outstanding (the measured case);
//   - an await on something that never resolves;
//   - a rejection swallowed by an empty .catch(), leaving the tally unreached;
//   - an early return before the tally;
//   - a process.exit(0) before the tally;
//   - a file that only exports its work and never invokes it, so nothing runs at all.
// In all of them the guard was armed and verdictReached() was never called, so the guard fires.
//
// THE SAME HOOK CARRIES A SECOND JOB, and it did not always. A run that DOES call verdictReached() but has
// its verdict REFUSED (zero checks, no assertion-shaped line, or a positive failure count) was left to a
// bare `process.exitCode = 1`, and a caller ending `process.exit(failures === 0 ? 0 : 1)` overwrote it with
// an explicit 0. See `refused` below for the measurement. Both jobs now run from the one listener.
//
// ENROLMENT IS NOT OPTIONAL. scripts/verdict-guard-gate.mjs derives the set of entry points that must be
// enrolled from package.json and the CI workflows rather than from a list kept by hand, and an unenrolled
// entry point is a gate finding. Do not add a bypass; a guard some validators opt into is the same defect
// wearing a helmet.
//
// USAGE, two lines:
//   import { verdictReached } from "./lib/verdict-guard.ts";   // importing this ARMS the guard
//   ...
//   console.log(failures === 0 ? "\nEXAMPLE PASS" : `\n${failures} FAILURE(S)`);
//   verdictReached(failures);                                  // declare the verdict you just printed
//   if (failures > 0) process.exit(1);

/** declared is set by verdictReached(). The exit listener reads it and nothing else writes it. */
let declared = false;
/**
 * refused is set wherever this guard decides the run must not report green. It exists because setting
 * process.exitCode is NOT sufficient on its own (R-50).
 *
 * THE HOLE IT CLOSES, measured rather than reasoned about. The usage this file documents ends
 * `if (failures > 0) process.exit(1);`, which leaves an exitCode the guard set alone. 54 of the 157
 * enrolled entry points on console origin/main 4b74ce8 instead end `process.exit(failures === 0 ? 0 : 1);`,
 * and on a clean run that passes an EXPLICIT 0, which overwrites process.exitCode. Reproduced on two
 * files identical but for that tail, both declaring a verdict over zero checks: the
 * `if (failures > 0)` shape exits 1, the explicit-zero shape prints the guard's "Forcing exit 1" refusal
 * on stderr and exits 0. The refusal was being printed into a green build.
 *
 * The repair is here rather than in 54 files, for the reason scripts/workspace-root.mjs is one file
 * (row R-30): a correction applied by hand in 54 places is 54 chances to omit it, and the 55th entry
 * point written next week would not have it at all. The exit listener re-applies the refusal after the
 * caller's exit code has been chosen, which is the only point downstream of every route out.
 */
let refused = false;
/** bytes the process has written since arming, reported in the guard's message. */
let bytesWritten = 0;
/** assertion-shaped lines seen on either stream, which is the nothing-to-check floor. */
let assertionLines = 0;

/** entryName is only for the message. process.argv[1] is the script node was pointed at. */
const entryName = process.argv[1] ?? "(unknown entry)";

// THE FLOOR IS A COUNT OF ASSERTION LINES, NOT A BYTE COUNT. Bytes were the first attempt and they are too
// weak: two validators here are SILENT on a pass and print their FAIL lines only on failure, so on bytes
// alone a run that asserted a thousand things and a run that asserted none looked identical. What is
// counted instead is lines that LOOK like assertions, on stdout AND stderr, because this repo writes FAIL
// to stderr in several validators and counting one stream would miss them.
//
// The pattern is ANCHORED AT LINE START and deliberately OVER-inclusive. Anchored, because the string
// "not ok" appears inside PASSING assertion labels in this repo and an unanchored count would score those
// twice. Over-inclusive, because the count is only ever compared against ZERO: an extra match can never
// turn a real run red, while a missed one can. Where a validator legitimately prints no assertion lines at
// all it passes its own `checks` count to verdictReached, which is stronger than any output heuristic.
const ASSERTION_LINE = /^\s*(?:ok\b|OK\b|FAIL\b|PASS\b|pass\b|not ok\b|[-*]\s|\u2713|\u2717|\u00d7|\[\s*(?:ok|fail)\s*\]|\d+\s*\/\s*\d+\s)/im;

/** countAssertions carries the trailing partial line between chunks, so a split write is not miscounted. */
let carry = "";
function countAssertions(text: string): void {
  const lines = (carry + text).split("\n");
  carry = lines.pop() ?? "";
  for (const l of lines) if (ASSERTION_LINE.test(l)) assertionLines++;
}

// The wrappers are deliberately thin and pass every argument and the return value straight through, so they
// cannot change what a validator prints or how it back-pressures.
type WriteArgs = Parameters<typeof process.stdout.write>;
function instrument(stream: NodeJS.WriteStream): void {
  const real = stream.write.bind(stream);
  stream.write = ((...args: WriteArgs): boolean => {
    const chunk = args[0];
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
    bytesWritten += typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk?.byteLength ?? 0);
    countAssertions(text);
    return real(...args);
  }) as typeof stream.write;
}
instrument(process.stdout);
instrument(process.stderr);

process.on("exit", (code: number): void => {
  // The refusal branch comes FIRST and is independent of `declared`, because these runs DID declare a
  // verdict: the guard rejected the verdict they declared. Assigning process.exitCode inside an "exit"
  // listener is honoured by Node even when process.exit(0) was called explicitly, which is the same
  // mechanism the undeclared branch below already relies on, so one hook covers both.
  if (refused) {
    if (code === 0) {
      process.stderr.write(
        `\nVERDICT GUARD: ${entryName} exited 0 after this guard had refused the run.\n` +
          `  The refusal above set process.exitCode = 1 and an explicit process.exit(0) overwrote it, which is\n` +
          `  how a printed refusal reaches a green build. Re-applying exit 1.\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (declared) return;
  // WHAT THIS BLOCK MAY CLAIM DEPENDS ON HOW FAR THE RUN GOT, and it did not used to. The second line
  // read, unconditionally, "The tally was never reached, so every assertion in this run was incapable of
  // failing." The first half is true by construction, because the guard only fires when verdictReached
  // was never called. The SECOND HALF IS TRUE ONLY WHEN NO ASSERTION RAN, and it was printed three lines
  // above "It printed N assertion-shaped line(s) ... before stopping", so on every run that stopped after
  // an assertion the guard contradicted itself inside one block.
  //
  // MEASURED on four validators that end in the floating main.catch tail:
  // validate-info-tip, validate-identity, validate-integrations and validate-owner-floor. Each was
  // baselined at exit 0 first, then driven with one injected throw placed so it lands after the third
  // assertion. All four printed both sentences in the same block, over 610, 244, 775 and 962 bytes, each
  // having printed exactly 3 assertion-shaped lines. The exit code was 1 in every case, so none of them
  // was silently green: what was wrong was the claim.
  //
  // THAT IS WHY THE SENTENCE IS NARROWED RATHER THAN THE FIFTY-FIVE TAILS FIXED. The false half is
  // printed HERE, once, and a tail that declared a verdict from its catch handler would have to invent a
  // failure count it does not have. Fifty-five edits that change no exit code would leave this line able
  // to overclaim for every validator not yet converted, including any written tomorrow. A guard whose
  // whole job is to catch a run saying more than it checked cannot itself say more than it knows.
  //
  // THE POPULATION IS 55, NOT THE 42 THE COMMIT THAT NARROWED THIS SENTENCE NAMED, and the difference is
  // an instrument fault worth recording because it will catch the next sweep too. 13 of the 55 tails exit
  // through `(globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1)` rather
  // than a bare `process.exit(1)`, because the DOM-shim validators cannot name `process` directly. A
  // matcher that requires the callee's object to be the identifier `process` scores all 13 as having no
  // exit at all: 42 + 13 = 55. scripts/verdict-guard-gate.mjs already knows the shim form, in its EXITER
  // pattern; the sweep that produced the 42 did not. Nothing about the argument above changes, only its
  // scope: all 55 handlers normalise to one body, log the error and exit 1, with no declarer in any of
  // them and no indirection through a callback or a hooks object anywhere in the set.
  //
  // The strong sentence is kept where it is true. The guard knows two facts, how many assertion-shaped
  // lines it saw and what the exit code is, and the claim turns on exactly those.
  const ranNothing = assertionLines === 0;
  process.stderr.write(
    `\nVERDICT GUARD: ${entryName} reached process exit with code ${code} without declaring a verdict.\n` +
      (ranNothing
        ? `  The tally was never reached, so every assertion in this run was incapable of failing.\n`
        : `  The tally was never reached, so what this run checked was never totalled and no verdict was\n  declared for it. The assertions below it did run: this is a missing verdict, not an empty run.\n`) +
      `  Causes seen in this codebase: an await on a promise that never settles (a close() whose callback\n` +
      `  never fires), an early return before the tally, a process.exit(0) before the tally, a rejection\n` +
      `  swallowed by an empty catch, or an entry point that only exports its work. A floating\n` +
      `  main().catch(...) tail catches none of them: a promise that never settles never rejects.\n` +
      `  ${ranNothing ? `It printed no assertion-shaped line at all (${bytesWritten} byte(s) written), so it ran no checks.\n` : `It printed ${assertionLines} assertion-shaped line(s) and ${bytesWritten} bytes before stopping.\n`}` +
      (code === 0
        ? "  Forcing exit 1: a silent exit 0 here is a false green.\n"
        : "  Leaving the non-zero exit code as it stands, so what is missing is the canonical VERDICT line\n  rather than the red itself.\n"),
  );
  if (code === 0) process.exitCode = 1;
});

/**
 * verdictReached declares that the entry point printed its verdict, and is the only thing that disarms
 * the guard. Call it AFTER printing the verdict and BEFORE any exit.
 *
 * @param failures how many assertions failed. A positive count sets process.exitCode = 1 even if the
 *   caller forgets its own process.exit(1), because "printed N FAILURE(S) and exited 0" is the same
 *   false green by a shorter route.
 * @param checks how many assertions ran, where the entry point tracks it. Zero is a failure: a validator
 *   that checked nothing is not a validator that passed.
 */
export function verdictReached(failures: number, checks?: number): void {
  declared = true;
  if (checks !== undefined && checks <= 0) {
    process.stderr.write(
      `\nVERDICT GUARD: ${entryName} declared a verdict after running ${checks} checks.\n` +
        `  Nothing was checked, so there was nothing to pass. Forcing exit 1.\n`,
    );
    refused = true;
    process.exitCode = 1;
    return;
  }
  if (checks === undefined && assertionLines === 0) {
    process.stderr.write(
      `\nVERDICT GUARD: ${entryName} declared a verdict having printed no assertion-shaped line on either stream.\n` +
        `  It wrote ${bytesWritten} byte(s), none of which looked like an assertion, so there is no evidence it\n` +
        `  checked anything. A validator that is deliberately quiet on a pass must pass its own check count as\n` +
        `  verdictReached(failures, checks), which is a real count rather than a guess from its output.\n` +
        `  Forcing exit 1.\n`,
    );
    refused = true;
    process.exitCode = 1;
    return;
  }
  // One canonical line, printed by the guard rather than by each validator, so the LOG-READING half of a
  // verification has a fixed anchor too. Reading the exit code is only half the check: a verification
  // grep of `(^|[^a-zA-Z])FAIL` matches nothing under BSD grep on macOS while plain `grep FAIL` found 41
  // lines on the same failing log, and in this repo the string "not ok" appears inside PASSING assertion
  // labels while a section header beginning "FAIL-SOFT" fooled another scan. Grep this line with a FIXED
  // string, never a regex: `grep -F "VERDICT: FAIL"`.
  process.stdout.write(`VERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures}${checks === undefined ? "" : ` checks=${checks}`} entry=${entryName}\n`);
  if (failures > 0) {
    // Covered by `refused` for the same reason as the two branches above: a caller that ends
    // `process.exit(failures === 0 ? 0 : 1)` gets this right by itself, but one that ends a literal
    // `process.exit(0)` would print "VERDICT: FAIL" and exit 0. Both are guarded at one point.
    refused = true;
    process.exitCode = 1;
  }
}

/**
 * verdictSkipped declares that the entry point could not run its checks, and why. A skip is a real
 * verdict and must be declared like any other, because "exits 0 having checked nothing" is the same false
 * green whether the cause is a hang or a missing precondition.
 *
 * It does NOT force a non-zero exit. Some preconditions here are deliberately opt-in (a sibling engine
 * checkout for the cross-repo drift gates, a built bundle, a live account) and those probes must not turn
 * an ordinary run red. What it does is make the skip DECLARED and greppable on one uniform line, so the
 * question "did CI actually run this, or did it skip?" has an answer in the log rather than an inference
 * from a silent exit 0.
 *
 * Pass require: true where the caller has decided the precondition is mandatory in this environment (the
 * REQUIRE_ENGINE convention npm run validate:workspace already uses); the skip then exits 1.
 */
export function verdictSkipped(reason: string, opts?: { require?: boolean }): void {
  declared = true;
  process.stdout.write(`\nVERDICT SKIPPED: ${entryName}: ${reason}\n`);
  if (opts?.require === true) {
    process.stderr.write(`  the precondition was declared mandatory here, so the skip is a failure.\n`);
    refused = true;
    process.exitCode = 1;
  }
}

/**
 * verdictCannotCheck declares that a MANDATORY precondition is missing, so the entry point did not answer
 * its question, and leaves at exit 2.
 *
 * WHY A THIRD VERDICT RATHER THAN A SECOND ARGUMENT TO verdictSkipped. Exit 1 says "this repository is
 * wrong". Exit 2 says "I could not check". Four validators here already made that distinction by hand, at
 * ten sites between them, printing "VERDICT: CANNOT CHECK" and calling process.exit(2) directly
 * (validate-restore-reason-vocabulary, validate-metadata-shed-vocabulary, validate-preset-rate-provenance,
 * validate-recovery-point-is-worst-case), and it is the same distinction the reader repository's `make lint`
 * draws. Doing it by hand had a cost that is easy to miss: none of those ten DECLARED the verdict, so the
 * exit listener fired its "reached process exit without declaring a verdict" message on top of a refusal
 * that was perfectly deliberate, telling the reader the tally was never reached when it was never meant to
 * be, and adding "it printed no assertion-shaped line at all, so it ran no checks" beneath a refusal that
 * had just explained itself on stderr. Measured on validate-restore-reason-vocabulary.ts with no engine
 * reachable: exit 2, correct, with the undeclared-verdict complaint printed above it. All ten sites call
 * this now, and the hand-written entry= basename becomes process.argv[1], the same anchor every other
 * verdict line in this repository carries.
 *
 * The reason is OPTIONAL for those ten, because each already prints its own explanation on stderr
 * immediately above the call. Passing one is the right default everywhere else.
 *
 * It does NOT set `refused`, because `refused` exists to re-apply exit 1 over a caller's explicit 0 and
 * would overwrite the 2 with a 1, collapsing exactly the distinction this function is for.
 *
 * Callers that can still run useful console-only assertions must NOT use this on the ordinary path. Use it
 * only where the caller has decided the precondition is mandatory in this environment, which in this
 * repository means REQUIRE_ENGINE=1 or REQUIRE_DOWNPIPE=1, the flags npm run validate:workspace and
 * npm run validate:reader set on the process.
 */
export function verdictCannotCheck(reason?: string): never {
  declared = true;
  if (reason !== undefined) process.stderr.write(`\n${reason}\n`);
  process.stderr.write(`VERDICT: CANNOT CHECK failures=0 checks=0 entry=${entryName}\n`);
  process.exit(2);
}
