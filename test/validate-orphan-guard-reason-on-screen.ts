// validate-orphan-guard-reason-on-screen.ts -- BOUNDARIES AND ACCUMULATION.
//
// THE CONSOLE HALF of the campaign's FIFTH product defect (engine 150e9e72). The engine's
// only-proven-copy refusal now names the at-risk run count, the downpipes, and the step that actually
// clears the guard on this estate. This file settles whether any of that reaches the operator, and it
// REFINES an earlier validator's rule rather than repeating it.
//
// That earlier validator measured, correctly, that `failResponse` reads a non-2xx body, tests it against shape gates
// over tokens the console itself defines, and throws `<verb>: <status>` with the body DISCARDED, so an
// engine reason never travels on that path. The rule it drew was:
//
//   an engine-only honesty fix reaches the API and the support pack; it reaches the SCREEN only if the
//   console mirrors the guard client-side in its own words.
//
// THAT RULE IS TRUE OF `parseJson`, AND IT IS NOT TRUE OF EVERY ROUTE. `parseJsonOrOwnerAction` -- the
// parser every owner mutation uses, destination removal included -- folds the reason in FIRST, as
// `<verb>: <reason>: <status>`, and reaches failResponse only when there is no reason to fold. So on
// this route the transport DOES carry the engine's sentence, and the honesty fix CAN reach the screen.
// Measured here against the real Transport rather than inferred, which is how the measurement below
// came to refute this author's own prediction about which statuses are gated out.
//
// AND IT STILL DID NOT REACH IT, for a different reason, which is the finding this file pins.
// `destination-cards-actions.ts` consumed the reason as a CLASSIFIER only -- `includes("only proven
// copy")` -- and then escalated to a force-remove dialogue whose copy is console-authored. So the
// specific sentence was swallowed and replaced by a general one at the exact moment the operator is
// deciding whether to destroy the last copy of a backup, and that general one repeated both of the
// remedies the engine fix exists to correct.
//
// CONTROLS: a dose-response over statuses (which ones carry a reason and which do not), negative
// controls that must classify differently, a positive control on the fixture, and the sibling-defect
// check an earlier pass taught -- the classifier must still recognise the engine's NEW sentence, or the
// fix would have killed the force escalation on the only action that can clear the guard.
//
// SIBLING-SUPPLY: the engine mirror below degrades to a printed SKIP, distinct from every other check in
// this file, when the engine sibling has no src/sched/dest-removal-text.ts; every other assertion here
// runs against the console's own source and the hand-quoted engine sentence, with or without one.

import { readFileSync } from "node:fs";
import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { qs, flushAsync, textOf } from "./dom-shim.ts";
import { SN, click, findButtonByText, fireKeydown } from "./validate-stable-components-shared.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { engineRefusalText, orphanRunCount, removeDestination } from "../src/screens/destination-cards-actions.ts";
import type { ConfigApprovalPolicy, DestinationList, DestinationStatus, EngineClient, OwnerActionResult } from "../src/api.ts";
import { importFromEngine } from "./engine-path.ts";
import { verdictReached } from "./lib/verdict-guard.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  if (!cond) failures++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
}

console.log("validate-orphan-guard-reason-on-screen");

// The engine's real sentence at 150e9e72, quoted so the fixture cannot drift from what it sends.
const ENGINE_REASON =
  "destination is the only proven copy of 10 backed-up run(s) (Nightly KV). Replication cannot copy them as things stand: the replicate pass only runs for a downpipe configured with two or more destinations, and that downpipe writes to one. Add a second destination to it so the pass has somewhere to mirror to, wait for it to catch up, then remove this one, or remove with force to drop those copies.";
// The PRE-FIX sentence, quoted from 43b78012, put through the same questions below.
const PRE_FIX_REASON =
  'destination is the only proven copy of 10 backed-up run(s) (Nightly KV). Wait for replication to copy them to another destination (the map shows "N of M copies"), reassign those downpipes, or remove with force to drop those copies.';

// POSITIVE CONTROL on the fixture: a pass below cannot come from an empty body.
ok("the fixture really carries the engine's sentence", ENGINE_REASON.includes("Add a second destination") && ENGINE_REASON.includes("10 backed-up run"));

// ================================================================================================
// 1. DOES THE TRANSPORT CARRY IT? Driven against the real parseJsonOrOwnerAction, over statuses.
// ================================================================================================
console.log("\n-- dose-response over statuses: which ones carry an engine reason through --");
const t = new Transport("https://engine.example.invalid");

async function thrownFor(status: number, body: unknown): Promise<string> {
  const r = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    await t.parseJsonOrOwnerAction(r, "remove destination");
    return "(resolved)";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

{
  const m400 = await thrownFor(400, { error: ENGINE_REASON });
  ok("a 400 carries the engine's reason through parseJsonOrOwnerAction", m400.includes("Add a second destination") && m400.includes("10 backed-up run"));
  ok("...wrapped as `<verb>: <reason>: <status>`", m400.startsWith("remove destination: ") && /: 400$/.test(m400));
  const m422 = await thrownFor(422, { error: ENGINE_REASON });
  ok("a 422 carries it too (the fold is not 400-specific)", m422.includes("Add a second destination"));

  // NEGATIVE CONTROL THAT MUST CLASSIFY DIFFERENTLY. A step-up 401 keeps its own marker: readErrorReason
  // answers null for `stepUpRequired: true` specifically, so the ceremony runs instead of a sentence
  // being shown. Without this the result below would be a claim about nothing.
  const stepUp = await thrownFor(401, { error: ENGINE_REASON, stepUpRequired: true });
  ok("a step-up 401 does NOT carry the reason (the ceremony marker wins)", !stepUp.includes("Add a second destination"));

  // A MEASURED DIVERGENCE BETWEEN THE THREE SIBLING PARSERS, pinned rather than fixed, and it refutes
  // what this file's author predicted before running it. `parseJsonOrPending` and `parseJsonOrReason`
  // both gate the reason fold behind `status !== 401 && !== 403 && !== 429 && < 500`, and
  // `parseJsonOrReason`'s own comment gives the purpose: "so a role denial still reads 'Not permitted',
  // never a 400 sentence". `parseJsonOrOwnerAction` carries NO such gate: every non-ok status whose body
  // holds an `error` string folds it in. So on an owner mutation a 403 shows the engine's sentence where
  // its siblings would show the closed forbidden class.
  //
  // It is recorded as an open question, not answered: which behaviour is right here is a refusal-surface
  // judgement, and changing it would move every owner mutation at once. Pinned so that a later change to
  // EITHER side shows up as a failure rather than as silence.
  for (const [status, label] of [
    [403, "403 (forbidden class)"],
    [429, "429 (rate limited)"],
    [500, "500 (server fault)"],
  ] as Array<[number, string]>) {
    const m = await thrownFor(status, { error: ENGINE_REASON });
    ok(`${label} DOES carry the reason on an owner mutation, unlike its two sibling parsers`, m.includes("Add a second destination"));
  }

  // And the shape of a body with NO reason at all: the envelope must not manufacture one.
  const bare = await thrownFor(400, { nothing: true });
  ok("a 400 with no `error` field falls back to the bare verb+status", bare === "remove destination: 400");

  // The divergence is asserted against the SIBLING SOURCE too, so it is a measurement of two files
  // rather than a belief about one. If a later pass adds the gate here, this fails and the note above
  // is re-opened rather than left standing as a stale claim.
  const tsrc = readFileSync(new URL("../src/lib/api/client-transport.ts", import.meta.url), "utf8");
  const ownerBody = tsrc.slice(tsrc.indexOf("async parseJsonOrOwnerAction"), tsrc.indexOf("async parseJsonOrOwnerAction") + 2600);
  ok("parseJsonOrOwnerAction's non-ok arm really has no status gate on the reason fold", ownerBody.includes("const reason = await this.readErrorReason(r);") && !ownerBody.includes("r.status !== 403"));
  ok("...while a sibling parser demonstrably does have one", /r\.status !== 401 && r\.status !== 403 && r\.status !== 429 && r\.status < 500/.test(tsrc));
}

// ================================================================================================
// 2. engineRefusalText: peeling the envelope back off, and refusing to invent one.
// ================================================================================================
console.log("\n-- engineRefusalText: unwrap the envelope, or answer null --");
{
  const wrapped = new Error(`remove destination: ${ENGINE_REASON.replace(/[:\s]*\d{3}\s*$/, "")}: 400`);
  // The empty string stands in for "answered null", so each assertion below is a claim about the
  // recovered TEXT rather than a claim that fails silently when nothing was recovered at all. The
  // first check is what distinguishes the two.
  const out = engineRefusalText(wrapped) ?? "";
  ok("the engine's sentence is recovered from the transport envelope", out.includes("Add a second destination"));
  ok("the verb prefix is gone", out !== "" && !out.startsWith("remove destination"));
  ok("the trailing status is gone", out !== "" && !/\b400$/.test(out));

  // NEGATIVE CONTROLS: nothing to show must answer null rather than a bare envelope. A dialogue that
  // rendered "remove destination: 400" would read as an engine fault rather than the deliberate
  // refusal it is escalating from.
  ok("a bare verb+status answers null", engineRefusalText(new Error("remove destination: 400")) === null);
  ok("an empty message answers null", engineRefusalText(new Error("")) === null);
  ok("a non-Error answers something or null, never throws", (() => { try { engineRefusalText(undefined); return true; } catch { return false; } })());

  // A pathological length is still returned whole: the dialogue gives the refusal its own bounded,
  // scrolling box (see section 3) rather than the function cutting the sentence short.
  const huge = engineRefusalText(new Error(`remove destination: ${"x".repeat(5000)}: 400`));
  ok("a pathologically long reason is returned whole, with no cut", huge !== null && huge.length === 5000);
}

// ================================================================================================
// 3. THE SCREEN. What the force-remove dialogue actually puts in front of the operator.
// ================================================================================================
console.log("\n-- the force-remove dialogue's own copy, read from the source --");
{
  const src = readFileSync(new URL("../src/screens/destination-cards-actions.ts", import.meta.url), "utf8");

  // The classifier must still recognise the engine's NEW sentence. This is the sibling-defect check:
  // the engine fix rewrote the message, and if the phrase the console keys on had moved with it, the
  // force escalation -- the ONLY route that clears a stuck guard from the console -- would silently
  // become a dead-end toast on the most destructive action in the product.
  ok("the classifier's phrase survives in the engine's NEW sentence", ENGINE_REASON.toLowerCase().includes("only proven copy"));
  ok("...and in the pre-fix one, so the console works against both engines during a staged deploy", PRE_FIX_REASON.toLowerCase().includes("only proven copy"));

  // The engine's reason is now PASSED to the dialogue, not merely tested.
  ok("the refusal is handed to offerForceRemove rather than only classified", /offerForceRemove\(engine, st, cr\.change \?\? undefined, done, failPlain, err\)/.test(src));
  ok(
    "the dialogue renders it through the typed h() builder as text, never as markup, in its own bounded scroll region",
    /h\(\s*"p",\s*\{ class: "field__hint field__hint--scroll", tabindex: "0", role: "region", "aria-label": "[^"]+" \},\s*`The engine refused with: \$\{engineRefusalText\(refusal\)\}`,?\s*\)/.test(src),
  );

  // The console's own generic advice no longer promises a wait that may not be able to end.
  ok("the generic copy no longer opens with an unconditional 'Prefer waiting for replication'", !/Prefer waiting for replication to copy those runs/.test(src));
  ok("it names the precondition the replicate pass actually has", /two or more destinations/.test(src));
  ok("it points at the engine's own step first", /Prefer the step the engine names above/.test(src));

  // AND THE HALVES THAT WERE ALWAYS RIGHT ARE UNCHANGED. A fix that quietly softened the data-loss
  // warning, or dropped the passkey ceremony note, would be a worse dialogue than the one it replaced.
  ok("the impact sentence still says the copies are DROPPED and it cannot be undone", /Force-removing it DROPS those copies/.test(src) && /This cannot be undone\./.test(src));
  ok("force is still gated behind type-to-confirm on the destination name", /matchLabel: "destination name"/.test(src));
  ok("the step-up ceremony note is still there", /You may be asked to confirm with your own passkey before this runs/.test(src));
  // The in-use refusal must stay OUT of the force escalation: force does not clear it, and offering
  // force there would put a destructive control in front of a refusal a reassignment fixes for nothing.
  const classifier = src.slice(src.indexOf("function isOrphanGuardError"), src.indexOf("function isOrphanGuardError") + 200);
  ok("the escalation classifier keys on the orphan phrase only", classifier.includes('"only proven copy"') && !classifier.includes("in use by"));
  ok("...and it is the sole gate on the escalation", (src.match(/offerForceRemove\(/g) ?? []).length === 2 && /isOrphanGuardError\(err\)\) \{\n\s+\/\//.test(src));
}

// ================================================================================================
// 4. THE LOSS LINE. Engine 0.3.7 adds a `notice` to a successful force-remove and reworks the refusal
// text; the dialogue must name the loss BEFORE the passkey step, in the engine's own count, never a
// console-computed one. Driven for real, over the DOM shim, so the ordering and the parsed count are
// measurements of the rendered dialogue.
// ================================================================================================
console.log("\n-- the force-remove dialogue's loss line: the engine's own count, before the passkey step --");

// The exact sentence src/sched/dest-removal-text.ts's destOrphanRefusal returns for a RemovalRisk of
// { count: 6, names: ["Nightly KV"], unreplicable: 0, olderOutsideHistory: 0 }, quoted verbatim (computed
// from that file's own function, not hand-typed), so a later rewording breaks this test instead of
// silently hiding the count.
const ORPHAN_SENTENCE_WITH_COUNT =
  "destination is the only proven copy of 6 backed-up run(s) (Nightly KV). Replication copies them to another destination of their downpipes at each 15-minute cron tick, oldest first, and this count falls as it does. Or remove it with force: downpipes then cannot restore those 6 run(s).";
// A refusal that still classifies as the orphan guard (it carries the phrase the classifier keys on) but
// whose count is not the guard's usual digit shape, standing in for an engine sentence this pattern was
// never written against.
const ORPHAN_SENTENCE_WITHOUT_COUNT =
  "destination is the only proven copy of several backed-up runs across two downpipes. Or remove it with force to drop those copies.";

ok("orphanRunCount reads 6 straight off the verbatim engine sentence", orphanRunCount(new Error(`remove destination: ${ORPHAN_SENTENCE_WITH_COUNT}: 400`)) === 6);
ok("orphanRunCount answers null rather than inventing a number from an unparseable sentence", orphanRunCount(new Error(`remove destination: ${ORPHAN_SENTENCE_WITHOUT_COUNT}: 400`)) === null);

// openForceDialog drives the REAL removeDestination through its "Remove" confirm and into the
// orphan-guard refusal `reason` throws, which opens the force-remove dialogue this section reads.
// `onForce` answers the SECOND engine.removeDestination call the dialogue makes once Force-remove is
// clicked (never exercised by the cases below, which close the dialogue with Cancel or Enter instead).
async function openForceDialog(reason: string): Promise<{ st: DestinationStatus; forceCalls: () => number }> {
  const st: DestinationStatus = { present: true, id: "d1", label: "orphan-dest-1", isDefault: false };
  let forceCalls = 0;
  const engine = {
    async getConfigApprovalPolicy(): Promise<ConfigApprovalPolicy> {
      return { requireChangeNumber: false } as ConfigApprovalPolicy;
    },
    async removeDestination(_id: string, _change?: unknown, force?: boolean): Promise<OwnerActionResult<DestinationList>> {
      if (force !== true) throw new Error(`remove destination: ${reason}: 400`);
      forceCalls++;
      return { status: "result", value: { destinations: [], defaultId: null } };
    },
  } as unknown as EngineClient;

  removeDestination(engine, st, 2, () => undefined);
  await flushAsync();
  click(findButtonByText(qs(SN(document.body), ".dialog--modal"), "Remove"));
  await flushAsync();
  await flushAsync(); // requireChange resolves, the plain remove call rejects, fail() opens the force dialogue
  return { st, forceCalls: () => forceCalls };
}

{
  const { forceCalls } = await openForceDialog(ORPHAN_SENTENCE_WITH_COUNT);
  const surface = qs(SN(document.body), ".dialog--modal");
  ok("the force-remove dialogue opened", surface !== null);
  if (surface === null) {
    ok("the loss line names the engine's count", false);
  } else {
    const full = textOf(surface);
    const idxLoss = full.indexOf("Downpipes then cannot restore those 6 run(s).");
    const idxMatch = full.indexOf("orphan-dest-1");
    const idxPasskey = full.indexOf("You may be asked to confirm with your own passkey before this runs");
    ok("the loss line names the engine's count", idxLoss !== -1);
    ok("the type-to-confirm field is present", idxMatch !== -1);
    ok("the passkey step is still named", idxPasskey !== -1);
    ok("the order is loss, then type-to-confirm, then the passkey step", idxLoss !== -1 && idxMatch !== -1 && idxPasskey !== -1 && idxLoss < idxMatch && idxMatch < idxPasskey);
    ok("the engine's full sentence is still shown too", full.includes(ORPHAN_SENTENCE_WITH_COUNT));

    // Enter must not submit this dialogue: there is no keydown handler on the type-to-confirm field, so
    // firing one is a no-op, and the force call must not have run.
    const input = qs(surface, "input");
    if (input !== null) fireKeydown(input, "Enter");
    await flushAsync();
    ok("Enter on the type-to-confirm field does not submit it", qs(SN(document.body), ".dialog--modal") !== null && forceCalls() === 0);

    click(findButtonByText(qs(SN(document.body), ".dialog--modal"), "Cancel"));
    await flushAsync();
    ok("Cancel closes the dialogue", qs(SN(document.body), ".dialog--modal") === null);
  }
}

{
  const { forceCalls } = await openForceDialog(ORPHAN_SENTENCE_WITHOUT_COUNT);
  const surface = qs(SN(document.body), ".dialog--modal");
  ok("the second dialogue opened too", surface !== null);
  if (surface !== null) {
    const full = textOf(surface);
    ok("a refusal without a parseable count still shows the engine's sentence", full.includes(ORPHAN_SENTENCE_WITHOUT_COUNT));
    ok("...and does not invent a run count", !/Downpipes then cannot restore those \d+ run\(s\)\./.test(full));
    ok("the force call never ran (Cancel is what closes this case)", forceCalls() === 0);
    click(findButtonByText(qs(SN(document.body), ".dialog--modal"), "Cancel"));
    await flushAsync();
  }
}

// ================================================================================================
// 5. THE WHOLE REFUSAL, UNCUT. A destination-removal refusal can carry several of destOrphanRefusal's
// optional clauses at once (the replication wait, the unreplicable-runs clause, the older-runs-outside-
// history clause), plus up to five downpipe names, which is how it reaches four figures. LONG_REFUSAL is
// destOrphanRefusal({ count: 12, names: ["src-d1", "src-r2"], unreplicable: 2, olderOutsideHistory: 4 }),
// built from engine src/sched/dest-removal-text.ts at fb1cfcba and pasted here verbatim (1,177 characters).
// SHORT_REFUSAL is the same function's single-clause output for a small, single-name risk (567 characters,
// the under-600 control the fixed cap used to let through unmarked).
// ================================================================================================
console.log("\n-- the whole refusal reaches the screen uncut, however long the engine's sentence runs --");

const LONG_REFUSAL =
  "destination is the only proven copy of 12 backed-up run(s) (src-d1, src-r2). Replication copies 10 of them to another destination of their downpipes at each 15-minute tick, oldest first within each downpipe. This count falls as replication copies runs. It can stay the same for several ticks while replication copies shared data, and the wait can take hours. If replication cannot copy a run (for example, no destination holds it), that run stays in this count until it leaves the downpipe's newest 50 runs. 2 of them belong to downpipes with fewer than two destinations, which replication does not copy, so waiting does not clear them. To keep them, give each of those downpipes this destination and one other, wait for replication to copy the runs (this can take hours), then take this destination off them and remove it. Or remove it with force: downpipes then cannot restore those 12 run(s). 4 older run(s) of the downpipes that sealed runs here are no longer in the run history, which keeps the newest 50 runs of each downpipe. Replication does not copy those, so downpipes cannot restore any of them held only here once this destination is removed, with or without force.";
const SHORT_REFUSAL =
  "destination is the only proven copy of 6 backed-up run(s) (Nightly KV). Replication copies them to another destination of their downpipes at each 15-minute tick, oldest first within each downpipe. This count falls as replication copies runs. It can stay the same for several ticks while replication copies shared data, and the wait can take hours. If replication cannot copy a run (for example, no destination holds it), that run stays in this count until it leaves the downpipe's newest 50 runs. Or remove it with force: downpipes then cannot restore those 6 run(s).";

// POSITIVE CONTROLS on the fixtures themselves: the lengths this whole section depends on.
ok("LONG_REFUSAL is really the 1,177-character variant", LONG_REFUSAL.length === 1177);
ok("SHORT_REFUSAL is really under the old 600-character cap", SHORT_REFUSAL.length === 567 && SHORT_REFUSAL.length < 600);
ok("LONG_REFUSAL carries its closing sentence (the old cap would have cut it)", LONG_REFUSAL.endsWith("with or without force."));

// ================================================================================================
// 5a. THE FIXTURES AGAINST THE ENGINE. LONG_REFUSAL and SHORT_REFUSAL above are pasted text, not a live
// call, so a later change to src/sched/dest-removal-text.ts can leave the paste behind it. The fixtures
// must equal that file's own destOrphanRefusal output for the same two RemovalRisk values, byte for byte,
// and this check proves it. Absent the engine sibling, it prints the same kind of SKIP the section 6
// mirror uses: every other check in this file still runs against the pasted text alone.
// ================================================================================================
console.log("\n-- the fixtures against the engine: LONG_REFUSAL and SHORT_REFUSAL must equal destOrphanRefusal's own output --");
{
  interface RemovalRisk { count: number; names: string[]; unreplicable: number; olderOutsideHistory: number }
  const here = new URL(".", import.meta.url).pathname;
  const mod = await importFromEngine<{ destOrphanRefusal: (r: RemovalRisk) => string }>(here, "src/sched/dest-removal-text.ts");
  if (mod === null) {
    console.log("  SKIP  src/sched/dest-removal-text.ts is not on the engine sibling (pre-0.3.7 engine main).");
    console.log("        LONG_REFUSAL and SHORT_REFUSAL are checked above against the pasted engine sentence only.");
  } else {
    const longFromEngine = mod.destOrphanRefusal({ count: 12, names: ["src-d1", "src-r2"], unreplicable: 2, olderOutsideHistory: 4 });
    const shortFromEngine = mod.destOrphanRefusal({ count: 6, names: ["Nightly KV"], unreplicable: 0, olderOutsideHistory: 0 });
    ok("LONG_REFUSAL equals src/sched/dest-removal-text.ts's own destOrphanRefusal output, byte for byte", LONG_REFUSAL === longFromEngine);
    ok("SHORT_REFUSAL equals src/sched/dest-removal-text.ts's own destOrphanRefusal output, byte for byte", SHORT_REFUSAL === shortFromEngine);
  }
}

{
  const longErr = new Error(`remove destination: ${LONG_REFUSAL}: 400`);
  const shortErr = new Error(`remove destination: ${SHORT_REFUSAL}: 400`);

  ok("engineRefusalText returns the long refusal whole", engineRefusalText(longErr) === LONG_REFUSAL);
  ok("...with no ellipsis anywhere in it", !(engineRefusalText(longErr) ?? "").includes("…"));
  ok("engineRefusalText leaves the short control unchanged", engineRefusalText(shortErr) === SHORT_REFUSAL);
  ok("orphanRunCount reads 12 off the long variant", orphanRunCount(longErr) === 12);
  ok("orphanRunCount reads 6 off the short control, unchanged", orphanRunCount(shortErr) === 6);
}

{
  const { forceCalls } = await openForceDialog(LONG_REFUSAL);
  const surface = qs(SN(document.body), ".dialog--modal");
  ok("the force-remove dialogue opened for the long refusal", surface !== null);
  if (surface !== null) {
    const full = textOf(surface);
    ok("the dialogue's rendered text contains the whole 1,177-character refusal", full.includes(LONG_REFUSAL));
    ok("the loss line (the engine's own count) is still present", full.includes("Downpipes then cannot restore those 12 run(s)."));
    const idxLoss = full.indexOf("Downpipes then cannot restore those 12 run(s).");
    const idxRefusal = full.indexOf(LONG_REFUSAL);
    const idxMatch = full.indexOf("orphan-dest-1");
    const idxPasskey = full.indexOf("You may be asked to confirm with your own passkey before this runs");
    ok("the type-to-confirm field is still present", idxMatch !== -1);
    ok("the passkey ceremony note is still present", idxPasskey !== -1);
    ok(
      "the order holds: loss line, then the full refusal, then type-to-confirm, then the passkey step",
      idxLoss !== -1 && idxRefusal !== -1 && idxMatch !== -1 && idxPasskey !== -1 && idxLoss < idxRefusal && idxRefusal < idxMatch && idxMatch < idxPasskey,
    );

    const scrollRegion = qs(surface, ".field__hint--scroll");
    ok("the refusal renders inside its own bounded, scrollable region", scrollRegion !== null);
    ok("...reachable by keyboard (tabindex 0)", scrollRegion?.getAttribute("tabindex") === "0");

    ok("the force call never ran (Cancel is what closes this case)", forceCalls() === 0);
    click(findButtonByText(qs(SN(document.body), ".dialog--modal"), "Cancel"));
    await flushAsync();
  }
}

// ================================================================================================
// 6. THE ENGINE MIRROR. When the engine sibling carries src/sched/dest-removal-text.ts (the file lands in
// engine 0.3.7, unmerged at the time of writing), build the sentence from ITS OWN destOrphanRefusal rather
// than the hand-quoted fixture above, and check the parser still finds the count. Absent, this half prints
// a clear skip: the fixture check above is not a substitute, only a floor.
// ================================================================================================
console.log("\n-- the engine mirror: the parser against src/sched/dest-removal-text.ts's own destOrphanRefusal --");
{
  interface RemovalRisk { count: number; names: string[]; unreplicable: number; olderOutsideHistory: number }
  const here = new URL(".", import.meta.url).pathname;
  const mod = await importFromEngine<{ destOrphanRefusal: (r: RemovalRisk) => string }>(here, "src/sched/dest-removal-text.ts");
  if (mod === null) {
    console.log("  SKIP  src/sched/dest-removal-text.ts is not on the engine sibling (pre-0.3.7 engine main).");
    console.log("        The count parser is still checked above against the hand-quoted engine sentence.");
  } else {
    const sentence = mod.destOrphanRefusal({ count: 6, names: ["Nightly KV"], unreplicable: 0, olderOutsideHistory: 0 });
    ok("the parser finds the count from the engine's own destOrphanRefusal output", orphanRunCount(new Error(`remove destination: ${sentence}: 400`)) === 6);
  }
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
console.log(failures === 0 ? "VALIDATE-ORPHAN-GUARD-REASON-ON-SCREEN VECTORS PASS" : `${failures} FAILURE(S)`);
verdictReached(failures);
if (failures > 0) process.exit(1);
