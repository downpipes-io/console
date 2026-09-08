// THE WORST-DAY REFUSAL VALIDATOR: what a customer who has just lost data reads when the restore
// itself is refused.
//
// Run with: node test/validate-worst-day-refusals.ts
//
// This is validate-first-hour-refusals.ts's counterpart at the other end of the journey. That one
// covers the three saves of setup; this one covers the apply. The state of mind is not the same and
// the cost of a wrong sentence is not the same: a customer here is frightened, in a hurry, probably
// not the person who set the product up, and a refusal they cannot act on is the product failing at
// its only real job.
//
// THE DEFECT IT CLOSES, driven against the real call path rather than read off the
// source. components/error-view.ts forbiddenCopy already tells the four different 403s apart, and it
// was built precisely so that "Your role does not permit this action" is said only when the engine's
// route gate actually named a capability the caller lacks. It reads the class that
// client-transport.ts failResponse folds into the throw.
//
// The restore path never reached it. lib/api/client-downpipes.ts restore() read the body for a
// dual-control reason FIRST and threw on any reason it found, so failResponse never ran, no class was
// ever folded, forbiddenClass() returned null, and forbiddenCopy fell to its default. Driven against
// the real apply before the change, all three refusals the engine itself makes rendered the same
// sentence:
//
//   403 { error: "forbidden", required: "restore.apply" }   -> "Your role does not permit this action."
//   403 { error: "csrf origin check failed" }               -> "Your role does not permit this action."
//   403 { error: "forbidden" }  (the DO authz funnel)       -> "Your role does not permit this action."
//
// The middle one is the worst of the three. A CSRF-origin fault refuses every cookie-borne save in
// the whole console and its remedy is an engine variable; the console holds a reviewed sentence that
// says in as many words that it is "not anything about your role or your permissions", and folding
// the reason made that sentence UNREACHABLE from a restore. The third is not always about the caller
// at all. Only the first establishes anything about who is asking.
//
// The fix is Transport.foldableReason: fold a reason when folding beats the closed class, and return
// null on a 401/403/429/5xx so failResponse's markers survive. It carves out exactly one 403, the
// dual-control "restore not approved", because that is the one refusal the shape gate cannot name
// (classifyForbiddenBody tests `error` against the engine's own frozen tokens and this is not among
// them, so it would return the honest residual `not-engine-body` and tell a customer a firewall
// refused their restore when a colleague simply has not signed it yet).
//
// THE SECOND DEFECT, and it is the one the first fix would have made worse. lib/bulk-pacing.ts
// bulkFailureReason returned errText, the raw throw, and restore-flow/batch.ts paints it into a row's
// danger banner. Before the fix a batch row read "restore: forbidden: 403"; after it, and with no
// second change, it would have read "restore: forbidden-class=engine-capability: 403", leaking a
// console-internal classifier token to a customer. bulkFailureReason now goes through refusalText,
// the same reviewed rule the first-hour work applied to the setup screens.
//
// WHY THIS TEST IS NOT VACUOUS. The trap the playbook names is an assertion that would pass with its
// subject absent, so:
//
//   1. Every assertion is against a LITERAL customer-visible string. Nothing is compared to another
//      call of the code under test, so a rule that broke on both sides would not stay green.
//   2. Each of the four 403 classes has a NEGATIVE control as well as a positive one: the class's own
//      sentence must appear AND the default role sentence must not. Reverting foldableReason to
//      readErrorReason collapses three of the four onto the default, which fails the negative half
//      even though a "some sentence rendered" assertion would still pass.
//   3. The dual-control carve-out is asserted in the same sweep, so a fix that closed the conflation
//      by dropping the fold entirely would fail here rather than shipping.
//   4. A POSITIVE twin for the negative controls: the engine's own 400 reason must survive verbatim.
//      A rule that discarded every message and returned a constant would satisfy every "no token
//      leaked" assertion and would be a worse product.
//   5. The render is asserted to have HAPPENED (a non-empty heading element), so a screen that threw
//      before painting cannot pass by producing no text that contains the forbidden words.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import { Transport } from "../src/lib/api/client-transport.ts";
import { restore, restoreCapsule } from "../src/lib/api/client-downpipes.ts";
import { attestVerify } from "../src/lib/api/client-attest.ts";
import { blockError } from "../src/components/error-view.ts";
import { bulkFailureReason } from "../src/lib/bulk-pacing.ts";
import { classifyError, FORBIDDEN_CLASS_MARKER, RESTORE_UNAPPROVED_REASON } from "../src/lib/errors.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// THE ROLE SENTENCE. Asserted as a literal, because it is the exact text the defect put in front of a
// customer whose role was fine. It is quoted here and nowhere else in this file.
const ROLE_SENTENCE = "Your role does not permit this action";

function stub(status: number, body: unknown, contentType = "application/json"): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
}

// caught drives a REAL client call against the stubbed fetch and returns what it threw.
async function caught(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (e) {
    return e;
  }
  return null;
}

// screenText renders the REAL block error the restore screens render and returns what a customer reads.
function screenText(err: unknown): string {
  const el = blockError(err, () => {}, { origin: "restore" });
  return textOf(el).replace(/\s+/g, " ").trim();
}

// headingRendered is assertion 5: the render actually produced a heading, so a "does not contain"
// assertion cannot pass by producing nothing at all.
function headingRendered(err: unknown): boolean {
  const el = blockError(err, () => {}, { origin: "restore" });
  const h3 = el.querySelector("h3");
  return h3 !== null && textOf(h3).trim().length > 0;
}

const RESTORE_REQ = { runId: "run-1", downpipeId: "dp-1", apply: true };

// The four 403 bodies the engine (and the edge in front of it) actually produce, each with the
// sentence that must appear and the sentence that must not.
const FORBIDDEN_CASES: Array<{
  label: string;
  body: unknown;
  contentType: string;
  mustSay: string;
  mustNotSayRoleSentence: boolean;
}> = [
  {
    label: "the capability gate names what it wanted",
    body: { error: "forbidden", required: "restore.apply", have: ["restore.verify"] },
    contentType: "application/json",
    // This is the ONE case where the role reading is established, so the role sentence is correct here.
    mustSay: ROLE_SENTENCE,
    mustNotSayRoleSentence: false,
  },
  {
    label: "a CSRF-origin fault is not about the caller's role",
    body: { error: "csrf origin check failed" },
    contentType: "application/json",
    mustSay: "not anything about your role or your permissions",
    mustNotSayRoleSentence: true,
  },
  {
    label: "the DO authz funnel names nothing, so neither does the console",
    body: { error: "forbidden" },
    contentType: "application/json",
    mustSay: "It is not always about you",
    mustNotSayRoleSentence: true,
  },
  {
    label: "a block page in front of the engine",
    body: "<html><body>error 1020 access denied</body></html>",
    contentType: "text/html",
    mustSay: "made by something between this browser and the engine",
    mustNotSayRoleSentence: true,
  },
];

console.log("\nRESTORE APPLY -- the four 403s are told apart (real restore() over a stubbed fetch)");
const t = new Transport("https://engine.example");

for (const c of FORBIDDEN_CASES) {
  stub(403, c.body, c.contentType);
  const err = await caught(() => restore(t, RESTORE_REQ as never));
  const text = screenText(err);
  ok(`${c.label}: says "${c.mustSay.slice(0, 44)}"`, text.includes(c.mustSay));
  if (c.mustNotSayRoleSentence) {
    // THE NEGATIVE CONTROL. This is the half that fails on a revert.
    ok(`${c.label}: does NOT assert a role denial`, !text.includes(ROLE_SENTENCE));
  }
  ok(`${c.label}: a heading was actually rendered`, headingRendered(err));
}

console.log("\nRESTORE APPLY -- the dual-control carve-out must not regress");
stub(403, { error: "restore not approved", planHash: "abc123" });
{
  const err = await caught(() => restore(t, RESTORE_REQ as never));
  ok("a dual-control 403 classifies as restore-unapproved", classifyError(err).kind === "restore-unapproved");
  const text = screenText(err);
  ok('a dual-control 403 reads "Awaiting approval"', text.includes("Awaiting approval"));
  ok("a dual-control 403 names the distinct approver", text.includes("the approver must differ from you"));
  // The carve-out must not be delivered by mislabelling it as an edge refusal.
  ok("a dual-control 403 is not read as a block page", !text.includes("made by something between this browser and the engine"));
}

console.log("\nRESTORE APPLY -- the positive twin: an engine reason on a 400 survives verbatim");
{
  const reason = "runId is not a run of this downpipe";
  stub(400, { error: reason });
  const err = await caught(() => restore(t, RESTORE_REQ as never));
  const text = screenText(err);
  ok("a 400 validation reason reaches the customer intact", text.includes(reason));
}

console.log("\nBREAK-GLASS CAPSULE FETCH -- the same four readings on the same path");
for (const c of FORBIDDEN_CASES) {
  stub(403, c.body, c.contentType);
  const err = await caught(() => restoreCapsule(t, "run-1"));
  const text = screenText(err);
  ok(`capsule, ${c.label}: says "${c.mustSay.slice(0, 36)}"`, text.includes(c.mustSay));
  if (c.mustNotSayRoleSentence) ok(`capsule, ${c.label}: does NOT assert a role denial`, !text.includes(ROLE_SENTENCE));
}

console.log("\nATTENDED VERIFICATION -- the same, on the route an attended restore ends at");
for (const c of FORBIDDEN_CASES) {
  stub(403, c.body, c.contentType);
  const err = await caught(() => attestVerify(t, { sessionId: "sess-1", batch: [{ runId: "run-1", masterB64: "AAAA" }] }));
  const text = screenText(err);
  ok(`attest, ${c.label}: says "${c.mustSay.slice(0, 36)}"`, text.includes(c.mustSay));
  if (c.mustNotSayRoleSentence) ok(`attest, ${c.label}: does NOT assert a role denial`, !text.includes(ROLE_SENTENCE));
}

console.log("\nBATCH QUEUE -- no console-internal token reaches a row's banner");
// The batch queue is the one place a per-item refusal is shown with no sentence around it, so it is
// the one place a raw throw is visible as-is. bulkFailureReason is what a row paints.
for (const c of FORBIDDEN_CASES) {
  stub(403, c.body, c.contentType);
  const err = await caught(() => restore(t, RESTORE_REQ as never));
  const row = bulkFailureReason(err);
  ok(`batch row, ${c.label}: no "${FORBIDDEN_CLASS_MARKER}=" token`, !row.includes(`${FORBIDDEN_CLASS_MARKER}=`));
  ok(`batch row, ${c.label}: no bare trailing HTTP status`, !/:\s*403\s*$/.test(row));
  ok(`batch row, ${c.label}: no wire verb prefix`, !row.startsWith("restore:"));
  ok(`batch row, ${c.label}: says something`, row.trim().length > 20);
}
// The positive twin for the batch row: the engine's own words must still get through.
{
  const reason = "runId is not a run of this downpipe";
  stub(400, { error: reason });
  const err = await caught(() => restore(t, RESTORE_REQ as never));
  ok("batch row keeps the engine's own 400 reason", bulkFailureReason(err).includes(reason));
}
// And the 429 branch bulkFailureReason exists for is untouched.
{
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } });
  const err = await caught(() => restore(t, RESTORE_REQ as never));
  ok("batch row still names a 429 as rate limiting, with the Retry-After", bulkFailureReason(err).includes("retry after 7s"));
}

console.log("\nTHE FOLD ITSELF -- foldableReason returns null exactly where failResponse must win");
{
  // Driven through the transport rather than asserted about it: the thrown message is the observable.
  stub(403, { error: "forbidden", required: "restore.apply" });
  const err = await caught(() => restore(t, RESTORE_REQ as never));
  ok("a 403 throw carries the folded class, not the bare reason", String((err as Error).message).includes(`${FORBIDDEN_CLASS_MARKER}=engine-capability`));

  stub(403, { error: "restore not approved", planHash: "abc123" });
  const err2 = await caught(() => restore(t, RESTORE_REQ as never));
  ok("the dual-control 403 keeps its reason instead", String((err2 as Error).message).includes(RESTORE_UNAPPROVED_REASON));
  ok("and does not also carry a class token", !String((err2 as Error).message).includes(`${FORBIDDEN_CLASS_MARKER}=`));

  stub(500, { error: "internal" });
  const err3 = await caught(() => restore(t, RESTORE_REQ as never));
  ok("a 5xx reason is not folded over the server reading", !String((err3 as Error).message).includes("internal"));
}

await flushAsync();

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failure(s) over ${checks} check(s)`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
