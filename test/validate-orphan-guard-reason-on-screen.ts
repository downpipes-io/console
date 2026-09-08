// validate-orphan-guard-reason-on-screen.ts -- BOUNDARIES AND ACCUMULATION.
//
// The engine's only-proven-copy refusal now names the at-risk run count, the downpipes, and the step that
// actually clears the guard on this estate. This file settles whether any of that reaches the operator, and
// it REFINES an earlier validator's rule rather than repeating it.
//
// That earlier validator established, correctly, that `failResponse` reads a non-2xx body, tests it against shape gates
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
// Checked here against the real Transport rather than inferred.
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

import { readFileSync } from "node:fs";
import { Transport } from "../src/lib/api/client-transport.ts";
import { engineRefusalText } from "../src/screens/destination-cards-actions.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  if (!cond) failures++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
}

console.log("validate-orphan-guard-reason-on-screen");

// The engine's real sentence, quoted so the fixture cannot drift from what it sends.
const ENGINE_REASON =
  "destination is the only proven copy of 10 backed-up run(s) (Nightly KV). Replication cannot copy them as things stand: the replicate pass only runs for a downpipe configured with two or more destinations, and that downpipe writes to one. Add a second destination to it so the pass has somewhere to mirror to, wait for it to catch up, then remove this one, or remove with force to drop those copies.";
// The PRE-FIX sentence is put through the same questions below.
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

  // A DIVERGENCE BETWEEN THE THREE SIBLING PARSERS, pinned rather than fixed. `parseJsonOrPending` and
  // `parseJsonOrReason`
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

  // A pathological length is capped, so the ceremony copy underneath cannot be displaced.
  const huge = engineRefusalText(new Error(`remove destination: ${"x".repeat(5000)}: 400`));
  ok("a pathologically long reason is capped rather than rendered whole", huge !== null && huge.length <= 601);
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
  ok("the dialogue renders it through the typed h() builder as text, never as markup", /h\("p", \{ class: "field__hint" \}, `The engine refused with: \$\{engineRefusalText\(refusal\)\}`\)/.test(src));

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

console.log(`\n${checks} checks, ${failures} failure(s)`);
console.log(failures === 0 ? "VALIDATE-ORPHAN-GUARD-REASON-ON-SCREEN VECTORS PASS" : `${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
