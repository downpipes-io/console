// THE FIRST-HOUR REFUSAL VALIDATOR: what a brand-new customer reads when their first destination,
// or their first downpipe, is refused.
//
// Run with: node test/validate-first-hour-refusals.ts
//
// THE DEFECT IT CLOSES. Setup is Destinations, then Sources, then Downpipes, and each of those three screens ends
// in a save that the engine can refuse. All three rendered the TRANSPORT'S THROW into the one
// sentence the customer gets. The engine's own wording is good; the plumbing around it is not:
//
//   destination, wrong secret key   "add destination: the store rejected the credentials
//                                    (SignatureDoesNotMatch)...: 400"
//   destination, no reason given    "add destination: 400"
//   destination, a bare 403         "forbidden-class=not-engine-body: 403"
//   source token, wrong scopes      "...It needs Account Read and the per-product Read scopes.: 400"
//   first downpipe, name taken      "The engine refused the configuration (add downpipe: A downpipe
//                                    named 'User uploads' already exists.: 400). Adjust and try again."
//
// A wire verb on the front, a status glued past the full stop, and on a 403 a diagnostic class token
// this console defines for its OWN classifier, shown to a customer as though it were an explanation.
// The console already had the reviewed rule for this and it was applied to the licence and update
// verbs only, which a customer meets on day two hundred: THE CONSOLE'S OWN INTERNAL TOKENS MUST NEVER
// SURFACE; THE ENGINE'S OWN WORDS MAY. The rule is now components/error-view.ts refusalText /
// engineReason, and the destination form and the downpipe editor go through it.
//
// THE SOURCE-TOKEN SITE IS NOW CLOSED TOO, and the DRIVEN section at the foot of this
// file is what closes it. screens/sources/shared.ts errMsg and screens/sources-downpipes/helpers.ts
// errMsg both go through refusalText. Driven against the real token form before the change, the three
// shapes reached the field as "...Read scopes.: 400", "discovery token: 400" and the bare
// "forbidden-class=not-engine-body: 403".
//
// THE CALLERS THAT WRAP IT WERE CHANGED WITH IT, and that is not tidying. The no-reason branch returns
// a whole reviewed sentence carrying its own advice, so "Could not start a run (<that sentence>)" put
// a sentence inside a parenthesis inside a sentence and gave the customer two instructions in one
// line. Eleven toast and inline-error sites now read "<what failed>. <why>".
//
// WHY THIS TEST IS NOT VACUOUS, which is the part worth reading. Asserting "errMsg === refusalText"
// would pass with the rule itself broken, because both sides would move together. So:
//
//   1. Every assertion is against a LITERAL customer-visible string, never against another call of
//      the function under test.
//   2. The marker sweep is a NEGATIVE CONTROL over the closed set of tokens the transport can fold
//      (lib/errors.ts exports every one of them). For each token, a throw is built the way
//      client-transport.ts builds it and the rendered text must not contain the token. The set is
//      read FROM the module, so a marker added later is swept without anyone remembering to.
//   3. The negative control has a POSITIVE twin: the engine's own reason must survive intact. A
//      "no marker leaked" suite would also pass if the rule threw every message away and returned a
//      constant, which would be a worse product and a green run.

import { installDomShim, qs, qsa, flushAsync } from "./dom-shim.ts";

// Install BEFORE importing any screen module (they touch document at load time).
installDomShim();

import {
  ACCESS_REDIRECT_MARKER,
  CONSOLE_ORIGIN_FAULT,
  ENGINE_BINDING_ABSENT,
  FORBIDDEN_CLASS_MARKER,
  HTML_BODY_MARKER,
  RATE_LIMIT_MARKER,
  STEPUP_REQUIRED_MARKER,
} from "../src/lib/errors.ts";
import { engineReason, refusalText } from "../src/components/error-view.ts";
import { submitDestination, type SubmitContext } from "../src/screens/destination-submit.ts";
import { tokenEntry } from "../src/screens/sources/token-entry.ts";
import { runNow } from "../src/screens/sources-downpipes/detail-actions.ts";
import type { Field } from "../src/components/field.ts";
import type { DownpipeState, EngineClient } from "../src/api.ts";
import { h } from "../src/lib/dom.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  checks++;
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}\n    got=${JSON.stringify(got)}\n    want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// thrown builds the message the way client-transport.ts does: "<verb>: <reason>: <status>" when the
// engine explained itself, "<verb>: <status>" when it did not. Written here rather than imported so
// the test states the shape it is testing against.
const thrown = (verb: string, reason: string | null, status: number): Error =>
  new Error(reason === null ? `${verb}: ${status}` : `${verb}: ${reason}: ${status}`);

// ---------------------------------------------------------------------------------------------
console.log("-- the engine's own words survive, on all three first-hour screens --");
// ---------------------------------------------------------------------------------------------
{
  const DEST = "Destination refused: the store rejected the credentials (SignatureDoesNotMatch). Check the Access Key ID and Secret Access Key.";
  // The destination form renders refusalText directly (screens/destination-submit.ts errMsg).
  eq("destination, a wrong secret key", refusalText(thrown("add destination", DEST, 400)), DEST);

  const NOBUCKET = "Destination refused: bucket 'my-archive' was not found at that endpoint (NoSuchBucket).";
  eq("destination, a bucket that does not exist", refusalText(thrown("add destination", NOBUCKET, 400)), NOBUCKET);

  const TOKEN = "The token was rejected by Cloudflare (code 9109: Unauthorized to access requested resource). It needs Account Read and the per-product Read scopes.";
  // A REASON THAT ITSELF CONTAINS A COLON. The verb strip must take the verb and nothing else, so
  // "(code 9109: Unauthorized ...)" has to arrive whole; a greedy strip would eat half the sentence.
  eq("a reason carrying its own colon arrives whole", refusalText(thrown("discovery token", TOKEN, 400)), TOKEN);

  const TAKEN = "A downpipe named 'User uploads' already exists.";
  // The downpipe editor WRAPS the reason, so it reads engineReason and needs the reason alone.
  eq("first downpipe, the name is taken", engineReason(thrown("add downpipe", TAKEN, 400)), TAKEN);
}

// ---------------------------------------------------------------------------------------------
console.log("-- the transport's plumbing never reaches the customer --");
// ---------------------------------------------------------------------------------------------
{
  const out = refusalText(thrown("add destination", "the store rejected the credentials.", 400));
  ok("no wire verb on the front", !out.startsWith("add destination"));
  ok("no status glued past the full stop", !/:\s*\d{3}\s*$/.test(out));
}

// ---------------------------------------------------------------------------------------------
console.log("-- the marker sweep: a closed set, read from the module it is defined in --");
// ---------------------------------------------------------------------------------------------
{
  // Every token client-transport.ts can fold into a throw, in the two shapes it folds them:
  // bare ("<verb>: <token>") and parameterised with a trailing status ("<verb>: <token>=<v>: <s>").
  const MARKERS: Array<{ token: string; message: string }> = [
    { token: ENGINE_BINDING_ABSENT, message: `add destination: ${ENGINE_BINDING_ABSENT}` },
    { token: CONSOLE_ORIGIN_FAULT, message: `add destination: ${CONSOLE_ORIGIN_FAULT}` },
    { token: ACCESS_REDIRECT_MARKER, message: `add destination: ${ACCESS_REDIRECT_MARKER}` },
    { token: HTML_BODY_MARKER, message: `add destination: ${HTML_BODY_MARKER}` },
    { token: STEPUP_REQUIRED_MARKER, message: `add destination: ${STEPUP_REQUIRED_MARKER}: 401` },
    { token: RATE_LIMIT_MARKER, message: `add destination: ${RATE_LIMIT_MARKER}=12: 429` },
    { token: FORBIDDEN_CLASS_MARKER, message: `add destination: ${FORBIDDEN_CLASS_MARKER}=not-engine-body: 403` },
  ];
  for (const { token, message } of MARKERS) {
    const out = refusalText(new Error(message));
    ok(`"${token}" never reaches the customer`, !out.includes(token));
    // And the replacement is a real sentence, not an empty slot: a rule that returned "" would pass
    // the containment test above and leave the customer with a blank error line.
    ok(`"${token}" is replaced by a sentence`, out.trim().length > 20);
    // The wrapping caller (the downpipe editor) must be told there is no reason, or it nests a whole
    // reviewed sentence inside "The engine refused the configuration (...)".
    ok(`"${token}" is not offered to a wrapping caller as a reason`, engineReason(new Error(message)) === null);
  }
}

// ---------------------------------------------------------------------------------------------
console.log("-- a refusal the engine did NOT explain is answered, not shown as a status --");
// ---------------------------------------------------------------------------------------------
{
  // "<verb>: <status>" carries no reason at all, so engineReason must say so. The wrapper in the
  // downpipe editor depends on this null: it wraps a reason in "The engine refused the
  // configuration (...)" and must not wrap a whole reviewed sentence inside that parenthesis.
  const csrf403 = new Error(`add downpipe: ${FORBIDDEN_CLASS_MARKER}=engine-csrf: 403`);
  eq("a reasonless 400 has no engine reason", engineReason(thrown("add downpipe", null, 400)), null);
  eq("a reasonless 403 has no engine reason", engineReason(csrf403), null);
  ok("a reasonless 400 still renders advice", refusalText(thrown("add destination", null, 400)).length > 20);
  // The positive twin: a reason IS returned when there is one, so the null above is a discrimination
  // rather than a function that always answers null.
  eq("a reason-bearing 400 yields the reason", engineReason(thrown("add downpipe", "A downpipe named 'x' already exists.", 400)), "A downpipe named 'x' already exists.");
}

// ---------------------------------------------------------------------------------------------
console.log("-- a 403 is not an authority fact: the four readings --");
// ---------------------------------------------------------------------------------------------
//
// Driven on the first downpipe: a 403 the transport had ALREADY classified as `not-engine-body`
// reached an OWNER as "your Owner role does not hold it. An Owner can change this on the Access
// screen." The caller's role did hold it, the same screen had rendered the control live, and the
// remedy named a screen with nothing on it to change. Only `engine-capability` establishes anything
// about the caller; the other three are the perimeter, the edge, or somebody else's authority.
{
  const forbidden = (cls: string): Error => new Error(`add downpipe: ${FORBIDDEN_CLASS_MARKER}=${cls}: 403`);
  const ROLE_CLAIM = /your .* role|does not permit this action/i;

  const csrf = refusalText(forbidden("engine-csrf"));
  ok("csrf: does not claim anything about the caller's role", !ROLE_CLAIM.test(csrf));
  ok("csrf: names the engine setting that is actually wrong", csrf.includes("CONSOLE_ORIGIN"));
  ok("csrf: says nothing was changed", csrf.includes("Nothing was changed"));

  const edge = refusalText(forbidden("not-engine-body"));
  ok("edge block: does not claim anything about the caller's role", !ROLE_CLAIM.test(edge));
  ok("edge block: says the engine may not have seen it", /may never have seen/i.test(edge));

  const authz = refusalText(forbidden("engine-authz"));
  ok("authz funnel: does not claim the caller's role lacks it", !/your .* role/i.test(authz));

  // THE POSITIVE CONTROL, and the whole block is worthless without it: the ONE class that really is
  // about this caller must still say so. A fix that scrubbed the role sentence everywhere would pass
  // all six assertions above and would have removed a true and useful statement.
  const capability = refusalText(forbidden("engine-capability"));
  ok("the route gate's own refusal still reads as a role denial", ROLE_CLAIM.test(capability));
  // And an UNCLASSIFIED 403 keeps the original reading, so this is a discrimination and not a rewrite.
  ok("an unclassified 403 keeps the role reading", ROLE_CLAIM.test(refusalText(new Error("add downpipe: 403"))));
}

// ---------------------------------------------------------------------------------------------
console.log("-- DRIVEN: the real destination submit path, which is refusal number one --");
// ---------------------------------------------------------------------------------------------
//
// The section above pins the RULE. This one pins the CALL SITE, and it has to, because the rule
// being right is not what a customer reads: a later edit putting err.message back in
// screens/destination-submit.ts would leave every assertion above green. So the REAL
// submitDestination runs against an engine that refuses, and the assertion is the text that ends up
// in the form's own error slot.
{
  const REFUSAL = "Destination refused: the write probe was denied (AccessDenied). The credential needs PutObject on this bucket.";
  const stub = (value: string): Field =>
    ({ el: h("div"), control: h("input"), value: () => value, badInput: () => false, setError: () => undefined, clearError: () => undefined, validate: () => true, focus: () => undefined }) as unknown as Field;
  const formError = h("p", { hidden: true }) as HTMLElement;
  const saveBtn = h("button", {}, "Verify and save") as HTMLButtonElement;
  const engine = {
    // The transport's throw for an engine 400 that carried { error }: verb, reason, status.
    addDestination: () => Promise.reject(new Error(`add destination: ${REFUSAL}: 400`)),
    // requireChange reads this first; a policy that needs no change number keeps the path to the save.
    getConfigApprovalPolicy: () => Promise.resolve({ requireChangeNumber: false }),
  } as unknown as EngineClient;
  const ctx = {
    engine,
    fctx: { engineAccountId: "acct123", engineR2Buckets: [], sourceR2Buckets: new Set<string>(), discoveryRead: true, downpipesRead: true },
    opts: { confirmReplace: false, onSaved: () => undefined },
    getProvider: () => "r2" as const,
    pricingState: { edited: false },
    labelField: stub("Primary"),
    r2Block: { block: h("div") as HTMLElement, bucketField: () => stub("my-archive"), accountIdField: () => null, accountId: () => "acct123", circNote: h("div") as HTMLElement },
    endpointField: stub("https://s3.example.com"),
    s3BucketField: stub("my-archive"),
    regionField: stub("us-east-1"),
    addressingField: stub("auto"),
    storageClassField: stub(""),
    keyField: stub("AKIAEXAMPLE"),
    secretField: stub("secretvalue"),
    storageField: stub(""),
    classAField: stub(""),
    classBField: stub(""),
    egressField: stub(""),
    currencyField: stub("USD"),
    // The pricing disclosure the submit opens to show a refused rate. The four rate boxes above are
    // empty here, which is the ordinary "use the vendor's published rate" choice, so the rate rule passes and
    // this section is never opened in anger; it is real so the open/restore the submit does is exercised.
    pricingSection: h("details") as HTMLDetailsElement,
    wormModeField: stub("off"),
    wormDaysField: stub(""),
    roleArnField: stub(""),
    externalIdField: stub(""),
    durationField: stub(""),
    formError,
    saveBtn,
  } as unknown as SubmitContext;
  await submitDestination(ctx);
  eq("the form shows the engine's sentence and nothing else", formError.textContent, REFUSAL);
  ok("the form error is visible", formError.hidden === false);
  // Anti-vacuity: a submit that never reached the engine would also leave a blank slot, so the save
  // button being handed back is the evidence the refusal path (not an early return) ran.
  eq("the save button is usable again", saveBtn.textContent, "Verify and save");
}

// ---------------------------------------------------------------------------------------------
console.log("-- DRIVEN: the real source-token form, which is refusal number two --");
// ---------------------------------------------------------------------------------------------
//
// Setup step 2 is the read-only Cloudflare token, and NOTHING downstream can populate until it is
// accepted: no source catalogue, no destination bucket list, no first downpipe. So its refusal is a
// first-hour certainty. The REAL tokenEntry form runs against an engine that refuses.
//
// THE ASSERTION TRAP, asked before the assertions were written: what would have to be true for
// "the marker never appears" to pass with the SUBJECT ABSENT? A form that rendered no error line at
// all, or left it hidden, or left the button reading "Verifying" after an early return, passes every
// containment test trivially. That is exactly how this file's sibling validator passed for the wrong
// reason. So every shape below asserts the error line EXISTS, is VISIBLE, is a SENTENCE, and that the
// button came back off "Verifying" (the evidence the refusal path ran rather than an early return),
// and only then what the sentence says.
interface DrivenRefusal {
  text: string;
  visible: boolean;
  buttonLabel: string;
}
async function driveTokenRefusal(message: string): Promise<DrivenRefusal> {
  const engine = {
    setDiscoveryToken: () => Promise.reject(new Error(message)),
    // requireChange reads this first; a policy needing no change number keeps the path to the save.
    getConfigApprovalPolicy: () => Promise.resolve({ requireChangeNumber: false }),
  } as unknown as EngineClient;
  const form = tokenEntry(engine, true, "Verify and save", () => undefined);
  document.body.appendChild(form);
  (qs(form, "input") as unknown as HTMLInputElement).value = "a-read-only-token";
  const save = qsa(form, "button").find((b) => b.textContent === "Verify and save") as unknown as HTMLButtonElement;
  save.click();
  // The click chain is requireChange -> setDiscoveryToken -> catch; several microtask turns deep.
  for (let i = 0; i < 6; i++) await flushAsync();
  const line = qs(form, ".field__error");
  const out = { text: line?.textContent ?? "", visible: line !== null && line.hidden === false, buttonLabel: save.textContent ?? "" };
  form.remove();
  return out;
}
function pinDriven(shape: string, got: DrivenRefusal): void {
  ok(`${shape}: the refusal line is rendered and visible`, got.visible);
  ok(`${shape}: it is a sentence, not an empty slot`, got.text.trim().length > 20);
  eq(`${shape}: the button came back, so the refusal path ran`, got.buttonLabel, "Verify and save");
  ok(`${shape}: no wire verb on the front`, !got.text.startsWith("discovery token"));
  ok(`${shape}: no status glued past the full stop`, !/:\s*\d{3}\s*$/.test(got.text));
  ok(`${shape}: no classifier token`, !got.text.includes(FORBIDDEN_CLASS_MARKER));
}
{
  const SCOPES = "The token was rejected by Cloudflare (code 9109: Unauthorized to access requested resource). It needs Account Read and the per-product Read scopes.";
  const withReason = await driveTokenRefusal(`discovery token: ${SCOPES}: 400`);
  pinDriven("token, wrong scopes", withReason);
  eq("token, wrong scopes: the field shows Cloudflare's own sentence and nothing else", withReason.text, SCOPES);

  const noReason = await driveTokenRefusal("discovery token: 400");
  pinDriven("token, no reason given", noReason);
  eq(
    "token, no reason given: the field states what happened and what to do",
    noReason.text,
    "The request failed (discovery token: 400). Nothing was changed. Retry, and if it persists check the engine logs.",
  );

  const edge = await driveTokenRefusal(`discovery token: ${FORBIDDEN_CLASS_MARKER}=not-engine-body: 403`);
  pinDriven("token, an edge block 403", edge);
  ok("token, an edge block 403: names what really refused it", /firewall rule or a proxy/.test(edge.text));
  ok("token, an edge block 403: says the engine may not have seen it", /may never have seen/i.test(edge.text));
  ok("token, an edge block 403: says nothing was changed", edge.text.includes("Nothing was changed"));
}

// ---------------------------------------------------------------------------------------------
console.log("-- DRIVEN: a downpipe action toast, where the refusal is WRAPPED --");
// ---------------------------------------------------------------------------------------------
//
// The toasts are the day-two half, and they are the reason the shared rule needed its composition
// stated rather than only its transform. The no-reason branch of refusalText is a whole reviewed
// sentence carrying its own advice, so the old "Could not start a run (<why>)." would have nested a
// sentence inside a parenthesis inside a sentence: two full stops in one parenthesis and two
// instructions in one line. They now read "<what failed>. <why>".
async function driveRunNowToast(message: string): Promise<string> {
  for (const region of qsa(document.body, ".toast-region")) region.replaceChildren();
  const engine = { trigger: () => Promise.reject(new Error(message)) } as unknown as EngineClient;
  const state = { config: { id: "dp-1", name: "User uploads", source: { type: "r2" } } } as unknown as DownpipeState;
  await runNow(engine, state, { latest: undefined, reload: () => undefined, closeDrawer: () => undefined });
  for (let i = 0; i < 4; i++) await flushAsync();
  return qs(document.body, ".toast-region--assertive")?.textContent ?? "";
}
{
  const DISABLED = "The downpipe is disabled, so a run cannot be started.";
  const withReason = await driveRunNowToast(`trigger run: ${DISABLED}: 400`);
  // The subject first: a run that never reached the engine raises no toast at all, and an empty
  // string would satisfy every containment test below it.
  ok("toast, a reason given: the toast names the action that failed", withReason.startsWith("Could not start a run."));
  eq("toast, a reason given: the engine's own sentence follows it", withReason, `Could not start a run. ${DISABLED}`);

  const edge = await driveRunNowToast(`trigger run: ${FORBIDDEN_CLASS_MARKER}=not-engine-body: 403`);
  ok("toast, an edge block 403: the toast names the action that failed", edge.startsWith("Could not start a run."));
  ok("toast, an edge block 403: no classifier token", !edge.includes(FORBIDDEN_CLASS_MARKER));
  ok("toast, an edge block 403: names what really refused it", /firewall rule or a proxy/.test(edge));
  // The composition rule itself: no reviewed sentence opens inside a parenthesis, and the line does
  // not end on one. Both would be true of the wrapped form and are the reason it was changed.
  ok("toast, an edge block 403: no sentence nested in a parenthesis", !/\(\s*[A-Z]/.test(edge));
  ok("toast, an edge block 403: the line does not end inside a parenthesis", !edge.trimEnd().endsWith(")."));
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`} -- first-hour refusals (${checks} checks)`);
if (failures > 0) process.exitCode = 1;
