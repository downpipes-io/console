// Validate a set of AVAILABILITY diagnostics. Each of these is a case where the console is UP and
// something in it is dead, and the pack afterwards holds nothing that says so: an applied console update that
// is not the build being served, an identity report that never resolved (so an Owner sees a console with every
// control greyed out), a bring-up step that failed silently, a restore Apply that will never arm however many
// approvers sign, an engine wire value the console quietly coerced, and a screen frozen on skeleton rows.
//
// THE RULE THE SUITE DEFENDS: a gap is not closed until its evidence is IN THE BUNDLE, and the evidence
// answers the question it asks. So every assertion below drives the REAL fault site (never a
// re-implementation), asserts the row that lands in the console-diagnostics ring, and then asserts the row is
// SPECIFIC ENOUGH to tell the state apart from the states it must be told apart from. A recorder with no
// caller, a caller whose row never reaches the payload, and a row that coalesces with an unrelated fault are
// all the same failure.
//
// THE DISCRIMINATION ASSERTIONS ARE THE POINT. The ring coalesces by a tuple key, so a field that separates two
// outcomes and is left OUT of that key separates nothing: the two rows become one and the first one written
// wins the class. Every new field is therefore asserted BY ITS EFFECT: two states that must be distinct are
// driven, and the payload must carry TWO rows.
//
// AND: no-custody is structural. A sentinel customer value is planted at every place a fault site could reach
// it (an error message, an error NAME, a malformed URL, a malformed id), and no part of it may appear anywhere
// in the JSON the console would send.
//
// Coverage, by gap:
//   G153  the post-apply console build check, and the rollback it offers, reach the pack with a class that
//         says WHICH way the check failed (wrong build served / not JSON / unreachable / no version stamp)
//   G155  a caller-identity read that FAILED is told apart from a genuinely low role
//   G197  a swallowed lazy-chunk preload, and a navigation bridge that was never installed
//   G198  a restore Apply that will not arm says WHY, and a plan genuinely awaiting its approver says nothing
//   G216  an engine wire value the console could not use is recorded by field class and anomaly, never valued
//   G217  an uncaught fault carries its error class and the channel it arrived on
//
// Run with `node test/validate-support-availability-gaps.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { errorClassForError, httpClassForThrown, packPayload, recordConsoleBuildCheck, reset as resetRing, setActiveScreen, snapshot } from "../src/lib/client-diag/ring.ts";
import { noteUnhandledRejection, noteWindowError } from "../src/lib/client-diag/window-faults.ts";
import { readServedConsoleVersion, pollForServedVersionRead, type ServedVersionRead } from "../src/lib/console-version.ts";
import { preloadOwnLazyChunks } from "../src/lib/preload-chunks.ts";
import { navigate, navBridgeInstalled } from "../src/lib/nav.ts";
import { gateBlockClassFor, makeGateBlockReporter } from "../src/screens/restore-flow/shared.ts";
import { flatten, incompleteCount } from "../src/screens/runs/helpers.ts";
import { toDateInputValue } from "../src/screens/credentials/helpers.ts";
import { creationOptionsFromBegin } from "../src/screens/passkey/ceremony.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import type { RestoreApproval } from "../src/api.ts";
import type { RunHistoryEntry } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, actual: unknown, expected: unknown): void {
  ok(`${label} (got ${JSON.stringify(actual)})`, actual === expected);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

// rowsOf returns the ring's current rows, which is exactly what packPayload() hands the engine.
function rowsOf(): ClientDiagnosticRecord[] {
  return snapshot().records;
}
function rowsOfKind(kind: string): ClientDiagnosticRecord[] {
  return rowsOf().filter((r) => r.kind === kind);
}

// SENTINEL is the customer value planted wherever a fault site could reach one. It must never appear in the
// payload: a record has no free-string field it could occupy, and this asserts that structurally.
const SENTINEL = "acme-corp-secret-99";

// ============================================================================================
section("1. G153 -- the console build check: WHICH way it failed, not just 'not confirmed'");
// ============================================================================================
//
// The engine cannot probe a console behind Access, so its update record says the console component applied and
// nothing contradicts it. The browser is the only witness. The old reader collapsed four different failures to
// one null, so the check could only ever say "not confirmed", and the pack said nothing at all.

const fakeFetch = (r: { ok?: boolean; body?: unknown; jsonThrows?: boolean; throws?: boolean }) => (): Promise<Response> => {
  if (r.throws === true) return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.resolve({
    ok: r.ok !== false,
    json: () => (r.jsonThrows === true ? Promise.reject(new SyntaxError("Unexpected token <")) : Promise.resolve(r.body)),
  } as unknown as Response);
};

eq("a served version reads ok", (await readServedConsoleVersion(fakeFetch({ body: { version: "0.2.0" } }))).readClass, "ok");
eq("a fetch that throws is unreachable", (await readServedConsoleVersion(fakeFetch({ throws: true }))).readClass, "unreachable");
eq("a non-2xx is unreachable", (await readServedConsoleVersion(fakeFetch({ ok: false }))).readClass, "unreachable");
eq("a body that will not parse is non-json (an Access page reads exactly like this)", (await readServedConsoleVersion(fakeFetch({ jsonThrows: true }))).readClass, "non-json");
eq("valid JSON with no version is unstamped (the update verdict is then blind)", (await readServedConsoleVersion(fakeFetch({ body: { builtAt: "x" } }))).readClass, "unstamped");
eq("an empty version is unstamped", (await readServedConsoleVersion(fakeFetch({ body: { version: "  " } }))).readClass, "unstamped");

// The four failures are FOUR classes, not one. That is the whole gap: before this they were all null.
const readClasses = new Set([
  (await readServedConsoleVersion(fakeFetch({ throws: true }))).readClass,
  (await readServedConsoleVersion(fakeFetch({ jsonThrows: true }))).readClass,
  (await readServedConsoleVersion(fakeFetch({ body: {} }))).readClass,
]);
eq("the three failure modes are three distinct classes, not one null", readClasses.size, 3);

// The bounded poll keeps the class of the state it gave up in.
const served = (list: Array<ServedVersionRead>) => {
  let i = 0;
  return (): Promise<ServedVersionRead> => Promise.resolve(list[Math.min(i++, list.length - 1)]!);
};
const confirmedPoll = await pollForServedVersionRead("0.2.0", served([{ version: "0.2.0", readClass: "ok" }]), 3, 0);
ok("an origin serving the expected build confirms", confirmedPoll.confirmed);
const stalePoll = await pollForServedVersionRead("0.2.0", served([{ version: "0.1.0", readClass: "ok" }]), 3, 0);
ok("an origin still serving the OLD build never confirms", !stalePoll.confirmed);
eq("and the class it gives up in says the origin ANSWERED (so the caller records wrong-version)", stalePoll.readClass, "ok");
const deadPoll = await pollForServedVersionRead("0.2.0", served([{ version: null, readClass: "non-json" }]), 3, 0);
eq("an origin answering a non-JSON page gives up in non-json, NOT in 'wrong version'", deadPoll.readClass, "non-json");

// The rows the recorder lands, and the discrimination test: a stale CDN and an Access page in front of
// /__build.json are DIFFERENT tickets, and they must not be one row.
resetRing();
recordConsoleBuildCheck("wrong-version");
recordConsoleBuildCheck("non-json");
recordConsoleBuildCheck("wrong-version"); // a repeat coalesces onto its own row, not onto the other one
const checks = rowsOfKind("console-build-check");
eq("a wrong-version check and a non-json check are TWO rows, not one", checks.length, 2);
eq("and the repeat coalesced onto its own class (count 2), never onto the other", checks.find((r) => r.buildCheckClass === "wrong-version")?.count, 2);
eq("the row rides on the updates screen", checks[0]?.screen, "updates");
ok("every build-check row carries its class (a row that will not say how it failed is not evidence)", checks.every((r) => typeof r.buildCheckClass === "string"));

// ============================================================================================
section("2. G155 -- an identity report that FAILED, told apart from a genuinely low role");
// ============================================================================================
//
// Every capability gate in the console reads `caller()?.role ?? "viewer"`. When the identity read fails, an
// actual Owner sees a console with every control greyed out and "owner only" beside it. The two states were
// identical in the tab and absent from the pack.

// The mapper that classifies the caught error: a refusal is separated from an unreachable engine, which is a
// different remedy. An engine error carries its status in the thrown message (the engine client's idiom).
eq("a 500 from the identity read classifies as 5xx", httpClassForThrown(new Error("whoami: 500")), "5xx");
eq("a 404 (an engine that does not serve the route) classifies as 4xx", httpClassForThrown(new Error("whoami: 404")), "4xx");
eq("a fetch that threw (engine unreachable) classifies as network", httpClassForThrown(new TypeError("Failed to fetch")), "network");
const aborted = Object.assign(new Error("cancelled"), { name: "AbortError" });
eq("a navigation-cancelled read is aborted (and the caller records nothing: it is not a fault)", httpClassForThrown(aborted), "aborted");

// The value-free guarantee at this site: the thrown message is the engine's, and it never travels.
eq("the classifier returns an enum member even when the error text carries a customer value", httpClassForThrown(new Error(`whoami ${SENTINEL}: 500`)), "5xx");

// ============================================================================================
section("3. G197 -- the two silent bring-up failures");
// ============================================================================================

resetRing();
const allLoaded = await preloadOwnLazyChunks([() => Promise.resolve(1)]);
ok("a preload that succeeds records NOTHING (noise discipline: the happy path is silent)", allLoaded && rowsOfKind("boot-fault").length === 0);

resetRing();
const failed = await preloadOwnLazyChunks([() => Promise.reject(new TypeError(`Failed to fetch ${SENTINEL}`))]);
ok("a preload that fails still returns false (the update is never blocked by the protection)", !failed);
const preloadRows = rowsOfKind("boot-fault");
eq("and it lands ONE boot-fault row", preloadRows.length, 1);
eq("whose class names the step that failed", preloadRows[0]?.bootClass, "chunk-preload-failed");
eq("on the boot sentinel screen (there is no route to attribute a bring-up fault to)", preloadRows[0]?.screen, "boot");

// The navigation bridge. In this process app.ts never ran, so the bridge holds its no-op defaults: exactly the
// state a partially loaded console is in, where every click returns cleanly and does nothing.
ok("the nav bridge is NOT installed in this process (the fault state under test)", !navBridgeInstalled());
resetRing();
navigate("/downpipes");
navigate("/restore"); // a page of dead clicks coalesces to one row with a count, never one row per click
const navRows = rowsOfKind("boot-fault").filter((r) => r.bootClass === "nav-bridge-uninstalled");
eq("a navigation through an uninstalled bridge lands a boot-fault row", navRows.length, 1);
eq("and repeats coalesce into its count (a page of dead clicks is one row)", navRows[0]?.count, 2);
ok("the route it was asked to navigate to is nowhere in the record", !JSON.stringify(rowsOf()).includes("downpipes"));

// The discrimination test for G197: a failed preload and a dead bridge must not be one row.
eq("a failed preload and an uninstalled bridge are TWO boot-fault rows", new Set(rowsOfKind("boot-fault").map((r) => r.bootClass)).size, 1);
resetRing();
await preloadOwnLazyChunks([() => Promise.reject(new Error("x"))]);
navigate("/keys");
eq("driven together, they are two distinct rows (bootClass is in the coalescing tuple)", rowsOfKind("boot-fault").length, 2);

// ============================================================================================
section("4. G198 -- why Apply did not arm");
// ============================================================================================

// These fixtures build by spreading overrides over defaults, so passing `undefined` for a key is how a
// case REMOVES a default rather than a redundant way of omitting it. Partial<T> cannot express that under
// exactOptionalPropertyTypes, which reads an optional property as "absent or a value" and refuses an
// explicit undefined. Overrides<T> permits it on the keys that are ALREADY optional and only those:
// across the board it would also let a case blank a REQUIRED field and build an invalid fixture. strip
// drops the blanked keys on the way out, so what comes back is a genuine value rather than one carrying
// an explicit undefined on an optional key.
type Overrides<T> = { [K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K] };
function strip<T extends object>(o: { [K in keyof T]?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// expiresAt IS RELATIVE TO NOW, AND IT HAS TO BE. It was the wall-clock literal "",
// which was in the future on the day this file was written and is not any more, and that
// turned five assertions here red without a line of this file changing: a later fix made a lapsed approval a
// precondition of gateBlockClassFor (correctly, and in lockstep with findUsableApproval, which is that
// function's whole contract), so every fixture below became a lapsed record and the classes they assert
// stopped being reachable. A fixture pinned to an absolute instant is a test that expires, and it fails
// long after the commit that would have explained it. The lapsed case is not lost by this: it is asserted
// deliberately below, from a deadline in the past by construction rather than by the calendar catching up.
const HOUR_MS = 60 * 60 * 1000;
const LIVE_EXPIRY = new Date(Date.now() + 24 * HOUR_MS).toISOString();
const LAPSED_EXPIRY = new Date(Date.now() - HOUR_MS).toISOString();
const approval = (over: Overrides<RestoreApproval>): RestoreApproval => strip({
  planHash: "hash-a",
  runId: "run-1",
  isLatest: true,
  plannedWrites: 3,
  bytes: 10,
  redirectBinding: null,
  requestedBy: "maker@example.com",
  requestedAt: "2026-07-01T00:00:00Z",
  reason: "restore",
  status: "approved",
  approvedBy: "checker@example.com",
  expiresAt: LIVE_EXPIRY,
  ...over,
});

eq(
  "the client could not compute the plan hash: Apply can NEVER arm, and that is its own class",
  gateBlockClassFor([], null, "maker@example.com", "run-1"),
  "plan-hash-failed",
);
eq(
  "no attributable caller (the bare-token path): its own class, not 'no approval yet'",
  gateBlockClassFor([], "hash-a", null, "run-1"),
  "no-caller-identity",
);
eq(
  "THE TICKET: the approver signed, and the approval binds a DIFFERENT hash than this console computed",
  gateBlockClassFor([approval({ planHash: "hash-b" })], "hash-a", "maker@example.com", "run-1"),
  "plan-hash-mismatch",
);
eq(
  "the only approval is the caller's own (maker == checker): the gate is right, and the operator cannot see why",
  gateBlockClassFor([approval({ approvedBy: "maker@example.com" })], "hash-a", "maker@example.com", "run-1"),
  "self-approval",
);
eq(
  "NOISE DISCIPLINE: a plan genuinely awaiting its second approver records NOTHING",
  gateBlockClassFor([approval({ status: "requested", approvedBy: undefined })], "hash-a", "maker@example.com", "run-1"),
  null,
);
eq(
  "and an armed gate (a usable approval from a distinct approver) records NOTHING",
  gateBlockClassFor([approval({})], "hash-a", "maker@example.com", "run-1"),
  null,
);
eq(
  "an empty listing is the awaiting state too, not a fault",
  gateBlockClassFor([], "hash-a", "maker@example.com", "run-1"),
  null,
);
// THE LAPSE, asserted from a deadline that is past by construction. This function is findUsableApproval's
// diagnostic twin and applies the same four preconditions in the same order, so a lapsed approval must be
// excluded here exactly as it is there. It records NOTHING in this closed vocabulary on purpose: the
// vocabulary is admitted member for member by the engine, so a console-only member would be dropped whole
// on arrival and read as silence in the pack, and the lapse is carried as its own sentence on the screen
// instead. The arm is here so that reading null does not silently come to mean "armed" for this case.
eq(
  "a LAPSED approval from a distinct approver is excluded, and records no class of its own",
  gateBlockClassFor([approval({ expiresAt: LAPSED_EXPIRY })], "hash-a", "maker@example.com", "run-1"),
  null,
);
eq(
  "and a lapsed SELF-approval is not reported as self-approval either, because it was already excluded",
  gateBlockClassFor([approval({ approvedBy: "maker@example.com", expiresAt: LAPSED_EXPIRY })], "hash-a", "maker@example.com", "run-1"),
  null,
);
// THE BOUNDARY THE LAPSE TEST DELIBERATELY REFUSES TO CROSS, and it is the one direction the two
// assertions above cannot show, because both are satisfied by a lapse test that is too eager as
// readily as by one that is right. An expiresAt that does not PARSE is not a lapse. The engine's own
// effectiveStatus guards its expiry comparison with Number.isFinite and records beside
// approvalTimestampUnparseable why: a corrupt timestamp must not fail the restore machine closed on a
// healthy approval. approvalHasLapsed mirrors that, and gateBlockClassFor is findUsableApproval's
// diagnostic twin, so reading NaN as expired here would make the twins disagree in the one case the
// engine leaves alone -- the lookup would still arm while this said the gate was blocked, or the
// reverse. Asserted through the class rather than through the helper because the helper is not
// exported: a self-approval is the only class that survives the exclusion, so it is the one that shows
// the record was NOT excluded.
eq(
  "an UNPARSEABLE expiresAt is not a lapse, so a self-approval carrying one is still reported as self-approval",
  gateBlockClassFor([approval({ approvedBy: "maker@example.com", expiresAt: "not-a-timestamp" })], "hash-a", "maker@example.com", "run-1"),
  "self-approval",
);

// The latch: the approval poll re-enters the gate every few seconds, so a count that grew with the polling
// would read as a severity it is not.
resetRing();
setActiveScreen("/restore");
const note = makeGateBlockReporter();
for (let i = 0; i < 20; i++) note([approval({ approvedBy: "maker@example.com" })], "hash-a", "maker@example.com", "run-1");
const gateRows = rowsOfKind("restore-gate-blocked");
eq("twenty polls of one blocked plan land ONE row", gateRows.length, 1);
eq("with a count of one (the count means blocked PLANS, never polls)", gateRows[0]?.count, 1);
eq("and the class the operator cannot see for themselves", gateRows[0]?.gateBlockClass, "self-approval");
note([approval({ planHash: "hash-b", runId: "run-2" })], "hash-a", "maker@example.com", "run-2");
eq("a SECOND plan blocked a different way is a second row (gateBlockClass is in the tuple)", rowsOfKind("restore-gate-blocked").length, 2);
// The planted values, not a loose substring: the CLASS NAMES legitimately contain "hash" and "plan", and an
// assertion that failed on its own vocabulary would be worthless.
const gateJson = JSON.stringify(rowsOf());
ok("no approver email rode along", !gateJson.includes("example.com"));
ok("no plan hash rode along", !gateJson.includes("hash-a") && !gateJson.includes("hash-b"));
ok("no run id rode along", !gateJson.includes("run-1") && !gateJson.includes("run-2"));

// ============================================================================================
section("5. G216 -- engine wire values the console silently coerced");
// ============================================================================================

const run = (over: Partial<RunHistoryEntry>): RunHistoryEntry => ({
  index: 1,
  status: "ok",
  startedAt: "2026-07-01T00:00:00Z",
  ...over,
}) as RunHistoryEntry;

resetRing();
setActiveScreen("/runs");
eq("an ABSENT recordsIncomplete reads 0 and records NOTHING (an older run legitimately carries none)", incompleteCount(run({})), 0);
eq("noise discipline holds: no row for the legitimate absence", rowsOfKind("wire-anomaly").length, 0);

eq("a non-numeric recordsIncomplete still reads 0 (the coercion is right)", incompleteCount(run({ recordsIncomplete: SENTINEL as unknown as number })), 0);
eq("but it is now RECORDED, as its own field class and anomaly", rowsOfKind("wire-anomaly")[0]?.fieldClass, "count");
eq("...", rowsOfKind("wire-anomaly")[0]?.anomaly, "non-finite");

incompleteCount(run({ recordsIncomplete: -5 }));
const wireRows = rowsOfKind("wire-anomaly");
eq("a NEGATIVE count is a second row, not the same row (the anomaly is in the tuple)", wireRows.length, 2);
ok("and the two anomalies are distinct", new Set(wireRows.map((r) => r.anomaly)).size === 2);

resetRing();
// NOTE the fixture: Date.parse is lenient enough to read a date out of most strings (it finds a year in the
// sentinel), so the unparseable value here is one that genuinely yields NaN, which is the case the guard is for.
flatten({ dp1: [run({ startedAt: "zzz-not-a-date" })] }, new Map());
eq("an unparseable run timestamp is recorded once, where the run enters the screen", rowsOfKind("wire-anomaly").length, 1);
eq("as a timestamp anomaly", rowsOfKind("wire-anomaly")[0]?.fieldClass, "timestamp");

resetRing();
eq("an unparseable stored expiry yields an empty date input (never a fabricated date)", toDateInputValue("zzz-not-a-date"), "");
eq("and it is recorded", rowsOfKind("wire-anomaly")[0]?.fieldClass, "timestamp");

resetRing();
let threw = false;
try {
  creationOptionsFromBegin({
    rp: { id: "downpipes.io", name: "Downpipes" },
    user: { id: "!!!!not-base64url!!!!", name: SENTINEL, displayName: SENTINEL },
    challenge: "abcd",
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  } as unknown as Parameters<typeof creationOptionsFromBegin>[0]);
} catch {
  threw = true;
}
ok("a corrupt base64url id still throws (the ceremony must not proceed on corrupt bytes)", threw);
eq("and the throw is now attributable: a b64url-id wire anomaly, not 'the engine is unreachable'", rowsOfKind("wire-anomaly")[0]?.fieldClass, "b64url-id");

// THE DISCRIMINATION TEST for G216: the six field classes are six rows, not one bucket.
resetRing();
setActiveScreen("/runs");
incompleteCount(run({ recordsIncomplete: Number.NaN }));
flatten({ dp1: [run({ startedAt: "nope" })] }, new Map());
toDateInputValue("nope");
eq("distinct field classes are distinct rows", new Set(rowsOfKind("wire-anomaly").map((r) => r.fieldClass)).size, 2);

// ============================================================================================
section("6. G217 -- an uncaught fault says WHAT class, and on WHICH channel");
// ============================================================================================

eq("a TypeError is named by its class", errorClassForError(new TypeError("x")), "TypeError");
eq("a RangeError (the malformed-instant crash) is named by its class", errorClassForError(new RangeError("Invalid time value")), "RangeError");
eq("a plain Error is named", errorClassForError(new Error("x")), "Error");
const hostile = Object.assign(new Error("x"), { name: `${SENTINEL}Error` });
eq("an error whose NAME carries a customer value maps to other (text SELECTS a member, it never passes through)", errorClassForError(hostile), "other");
eq("a non-object throw maps to other", errorClassForError("just a string"), "other");

resetRing();
setActiveScreen("/security");
// The frozen-skeleton ticket: a render throw inside a .then with no .catch. It arrives here and nowhere else.
noteUnhandledRejection(new TypeError(`Cannot read properties of undefined (reading '${SENTINEL}')`));
noteWindowError(new TypeError("x"));
const unhandled = rowsOfKind("unhandled");
eq("a rejection and a window error on the SAME screen with the SAME error class are TWO rows", unhandled.length, 2);
ok("because the channel is in the coalescing tuple", new Set(unhandled.map((r) => r.faultSource)).size === 2);
ok("the frozen-skeleton row is the unhandled-rejection one", unhandled.some((r) => r.faultSource === "unhandled-rejection" && r.errorClass === "TypeError" && r.screen === "security"));

resetRing();
setActiveScreen("/security");
noteUnhandledRejection(new TypeError("x"));
noteUnhandledRejection(new RangeError("x"));
eq("two DIFFERENT error classes on one screen are two rows (errorClass is in the tuple)", rowsOfKind("unhandled").length, 2);

// ============================================================================================
section("7. no-custody: nothing that was planted can be found in what the console would send");
// ============================================================================================
//
// Everything above ran with the SENTINEL planted in an error message, an error NAME, a malformed timestamp, a
// malformed b64url id and a run label. The payload is rebuilt here from a fresh drive of every new emit site.

resetRing();
setActiveScreen("/runs");
incompleteCount(run({ recordsIncomplete: SENTINEL as unknown as number }));
flatten({ [SENTINEL]: [run({ startedAt: `zzz${SENTINEL}` })] }, new Map([[SENTINEL, SENTINEL]]));
toDateInputValue(`zzz${SENTINEL}`);
noteUnhandledRejection(Object.assign(new TypeError(SENTINEL), { name: `${SENTINEL}Error` }));
noteWindowError(new Error(SENTINEL));
await preloadOwnLazyChunks([() => Promise.reject(new Error(SENTINEL))]);
navigate(`/downpipes/${SENTINEL}`);
recordConsoleBuildCheck("unstamped");
makeGateBlockReporter()([approval({ planHash: SENTINEL })], "hash-a", `${SENTINEL}@example.com`, SENTINEL);

const payload = packPayload();
const serialised = JSON.stringify({ clientDiagnostics: payload });
ok("the drive did produce rows (the assertion below is not vacuous)", payload.records.length > 0);
ok("the sentinel appears NOWHERE in the payload the console would POST", !serialised.includes(SENTINEL));
ok("negative control: the sentinel is detectable when it IS present", JSON.stringify({ leak: SENTINEL }).includes(SENTINEL));
ok("no record carries a message/url/stack/email key", !/"(message|url|stack|email|name|reason)"/.test(serialised));

console.log(`\n${failures === 0 ? "AVAILABILITY GAPS PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
