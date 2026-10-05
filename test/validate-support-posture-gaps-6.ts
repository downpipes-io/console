// CONSOLE-side coverage for four support-diagnostics defects that share one shape: the recorder exists, a real
// caller exists, the projection works, the gates are green -- and the state the check exists to separate still
// produces no row, the same row as its opposite, or a row on a state where nothing is wrong.
//
// SO EVERY TEST HERE DRIVES A REAL ENTRY POINT. The pattern this file guards against is the self-certifying
// test: calling the recorder by hand with a literal class and asserting the ring gives it back. That proves the
// RING can carry the class, not that the PRODUCT can put it there.
//
//   THE SCREEN-CONTROL VALIDATOR FUNNEL is driven by blurring the real cron and timezone controls of the real
//        schedule section, and clicking Add on the real SAML and IdP-preset forms. It never calls the recorder
//        by hand. The cron is a headline state and must be on the validate funnel.
//   THE RECOVERABILITY VERBS are driven over a faked route table with a GHOST run id through all four verbs, and
//        the drift rows are compared against the same verbs over a LEGITIMATE run.
//   THE CHAPTER DIRECTOR is run over a chapter whose anchor is absent, one whose anchor is present but has no
//        box, and one whose anchor is present, visible and simply cannot be framed. The third must be SILENT.
//   THE RENDERER CLASSIFIER is driven over the reading a HIDDEN DOCUMENT actually produces.
//
// Run with `node test/validate-support-posture-gaps-6.ts`.

import { installDomShim } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";

installDomShim();

import { reset as resetRing, setActiveScreen, snapshot } from "../src/lib/client-diag/ring.ts";
import { buildScheduleSection } from "../src/screens/sources-downpipes/editor-schedule.ts";
import { samlForm } from "../src/screens/idp-connections/saml-form.ts";
import { presetForm } from "../src/screens/idp-connections/forms.ts";
import { mountRecoveryForm, type FlowHandles } from "../src/screens/passkey/flows.ts";
import { sessionsAndPasskeysSection } from "../src/screens/access-security/sessions-passkeys.ts";
import { buildRuleFormControls, submitRuleForm } from "../src/screens/notifications/rule-form.ts";
import { addSourceScreen } from "../src/screens/add-source.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import type { FormContext } from "../src/screens/destination-form-fields.ts";
import { renderCustodyStep } from "../src/components/custody-step.ts";
import { h as domH } from "../src/lib/dom.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import type { Caller } from "../src/api.ts";
import { classifyRenderer, probeCssAnimations, watchVisibility } from "../src/screens/map/renderer-diag.ts";
import { CLIENT_DIAG_FORM_FIELDS } from "../src/lib/client-diag/vocab.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import type { EngineClient, IdpPreset } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  const pass = got === want;
  console.log(pass ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!pass) failures++;
}

// FLOW_HANDLES is the sign-in screen's own handle bag: the recovery form is mounted with exactly what the screen
// passes it, so the real submit handler runs its real guards.
const FLOW_HANDLES: FlowHandles = {
  setStatus: () => {},
  setBusy: () => {},
  onSuccess: async () => {},
};

const rowsOf = (kind: string): ClientDiagnosticRecord[] => snapshot().records.filter((r) => r.kind === kind);
const refusedFields = (): string[] => rowsOf("form-rejected").map((r) => String(r.formField));

// setField writes into a REAL control the way an operator does and lets the field's own listeners run: type,
// then leave. The blur is the event field() validates on, so this drives the production funnel end to end.
function typeAndLeave(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`control ${id} is not in the DOM`);
  el.value = value;
  (el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(makeEvent({ type: "input" }));
  (el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(makeEvent({ type: "blur" }));
}

function setValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`control ${id} is not in the DOM`);
  el.value = value;
}

function clickByText(root: HTMLElement, text: string): void {
  const btns = [...root.querySelectorAll("button")] as HTMLButtonElement[];
  const btn = btns.find((b) => (b.textContent ?? "").includes(text));
  if (!btn) throw new Error(`no button matching ${text}`);
  btn.click();
}

// A stub engine: these forms only touch it on a SUCCESSFUL submit, and every case below is refused before then.
const engineStub = {
  idpRedirectUri: (connId: string) => `https://console.example.com/idp/callback/${connId}`,
  samlAcsUrl: (connId: string) => `https://console.example.com/saml/acs/${connId}`,
  addIdpConnection: async () => ({}),
  testIdpConnection: async () => ({}),
  // The sessions section lists the caller's live sessions and passkeys on mount; the recovery form and the rule
  // form touch the engine only on a SUCCESSFUL submit, and every case below is refused before then.
  listSessions: async () => ({ sessions: [] }),
  terminateSession: async () => ({ ok: true }),
  listPasskeyCredentials: async () => ({ credentials: [] }),
  terminateUserSessions: async () => ({}),
} as unknown as EngineClient;

// ---------------------------------------------------------------------------------------------------------
// the console-wide validator funnel, including the cron control.
// ---------------------------------------------------------------------------------------------------------
async function g335(): Promise<void> {
  console.log("\n-- the form will not accept my cron / bucket name / certificate --");
  setActiveScreen("/downpipes");

  // THE HEADLINE STATE, and the one that produced NOTHING. The cron control had no `validate` at all: its
  // refusal was hand-rolled into a bespoke error node by the live preview, so field()'s validate() never ran and
  // "the form will not accept my cron" -- the ticket verbatim -- was indistinguishable from no refusal at all.
  resetRing();
  const sched = buildScheduleSection(undefined);
  document.body.appendChild(sched.el);

  typeAndLeave("dp-sched-cron", "0 2 * *"); // four fields, not five
  eq("a malformed CRON, blurred on the REAL control, is a row", rowsOf("form-rejected").length, 1);
  eq("...and it names the cron control, not the screen", String(rowsOf("form-rejected")[0]?.formField), "dp-sched-cron");
  eq("...as a refusal the operator SAW, not a silent coercion", String(rowsOf("form-rejected")[0]?.rejectOutcome), "rejected");

  // The timezone: the second control whose refusal is written with a direct setError() from the preview.
  typeAndLeave("dp-sched-tz", "Mars/Olympus_Mons");
  ok("an unknown IANA ZONE is its OWN row (a different edit from a bad cron)", refusedFields().includes("dp-sched-tz"));
  eq("the cron and the zone do not coalesce into one row", rowsOf("form-rejected").length, 2);

  // NOISE, both directions. A VALID cron and a valid zone record nothing, and an EMPTY cron is a documented,
  // legitimate state (the downpipe keeps its interval cadence), so it must not be a refusal either.
  resetRing();
  typeAndLeave("dp-sched-cron", "0 2 * * *");
  typeAndLeave("dp-sched-tz", "Australia/Sydney");
  eq("NOISE: a VALID cron and a VALID zone record nothing", rowsOf("form-rejected").length, 0);
  typeAndLeave("dp-sched-cron", "");
  eq("NOISE: an EMPTY cron is the documented interval-cadence state, not a refusal", rowsOf("form-rejected").length, 0);

  // The bucket-name override on the DOWNPIPE EDITOR: this is where a downpipe's bucket override is actually
  // edited, distinct from add-source and the destination form. dp-bucket carries a producer, and the vocabulary
  // carries the member.
  ok("dp-bucket is in the vocabulary (the downpipe editor's bucket override)", (CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("dp-bucket"));

  // THE SAML CERTIFICATE, through the REAL form. The paste carries a BEGIN CERTIFICATE line (so the field's own
  // validator passes) and splitPems finds no complete block in it: a console refusal, outside the validate
  // funnel, that must not go unrecorded. It is driven by CLICKING ADD, not by calling the recorder.
  resetRing();
  setActiveScreen("/access/idp");
  const saml = samlForm(engineStub, () => {});
  document.body.appendChild(saml);
  setValue("saml-label", "Okta");
  setValue("saml-id", "okta-saml");
  setValue("saml-idp-entity", "https://idp.example.com/metadata");
  setValue("saml-idp-sso", "https://idp.example.com/sso");
  setValue("saml-sp-entity", "https://console.example.com/saml");
  setValue("saml-certs", "-----BEGIN CERTIFICATE-----\nMANGLED-BY-AN-EMAIL-CLIENT\n");
  clickByText(saml, "Add SAML provider");
  ok("a MANGLED certificate paste, refused on submit by the real form, is a row", refusedFields().includes("saml-certs"));

  // THE IdP CLIENT SECRET IS A NO-ROW STATE. The cross-field rule (a secret is required unless the public-client
  // box is ticked) fires on an EMPTY box, so it records NOTHING and idp-secret is not a member of the vocabulary.
  // This is the refuse() arm of the very rule the funnel enforces: `rejected` asserts the console refused THE
  // VALUE THE OPERATOR TYPED, and on an empty secret box no value was examined. The emptiness rule is enforced in
  // refuse() as well, so the exempted state cannot come back in through the other arm, and the operator is
  // looking straight at the message either way.
  resetRing();
  const preset: IdpPreset = {
    id: "okta",
    label: "Okta",
    vendor: "Okta",
    buttonLabel: "Sign in with Okta",
    kind: "oidc",
    requiredVars: [{ key: "domain", label: "Okta domain", example: "acme.okta.com" }],
    notes: [],
  } as IdpPreset;
  const pform = presetForm(engineStub, preset, () => {});
  document.body.appendChild(pform);
  setValue("idp-label", "Okta");
  setValue("idp-id", "okta-prod");
  setValue("idp-client-id", "0oa1b2c3d4");
  setValue("idp-var-domain", "acme.okta.com");
  setValue("idp-secret", ""); // a confidential client with no secret
  clickByText(pform, "Add Okta");
  eq("a confidential client with NO SECRET records NOTHING (nothing was examined)", rowsOf("form-rejected").length, 0);
  ok(
    "idp-secret is not in the vocabulary (its only rule fires on an empty box: no producer, no member)",
    !(CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("idp-secret"),
  );

  // A CONNECTION ID that is non-empty and malformed goes through the ordinary funnel, distinct from the
  // required-and-empty branch: idp-id's validator can only be reached by a value that IS typed.
  resetRing();
  typeAndLeave("idp-id", "-okta"); // the engine's CONN_ID_PATTERN forbids a leading hyphen
  ok("a malformed connection id is a row on the id control", refusedFields().includes("idp-id"));

  // REDACTION. Not one typed value may appear anywhere in the payload: these controls hold certificates,
  // client ids, bucket names and IANA zones, and the row carries the catalogued control id and nothing else.
  const payload = JSON.stringify(snapshot());
  ok(
    "REDACTION: no typed value (certificate, client id, connection id, zone, cron) is anywhere in the payload",
    payload.indexOf("BEGIN CERTIFICATE") === -1 &&
      payload.indexOf("MANGLED") === -1 &&
      payload.indexOf("0oa1b2c3d4") === -1 &&
      payload.indexOf("acme.okta.com") === -1 &&
      payload.indexOf("Olympus") === -1 &&
      payload.indexOf("0 2 * *") === -1,
  );

  // ---- THE THREE EMPTINESS-ONLY CONTROLS, DRIVEN THROUGH THEIR REAL ENTRY POINTS ---------------------------
  //
  // A dead-vocab gate that only matches the SPELLING of an emptiness test, rather than its meaning, can leave
  // these three sitting in the vocabulary with no real producer. Every reachable state of all three is driven
  // below through the real form and the real button, and every one of them must produce NO ROW: they have no
  // producer, so they have no member.
  //
  // pk-recovery-code is the sharpest: "I cannot sign in with my recovery code" is a 02:00 ticket, and a
  // vocabulary member here would promise support a row that no code path can write.
  resetRing();
  setActiveScreen("/signin");
  const recoverySlot = domH("div");
  document.body.appendChild(recoverySlot);
  mountRecoveryForm(recoverySlot, engineStub, FLOW_HANDLES, () => {}, "ops@acme.example");
  clickByText(recoverySlot, "Sign in with a recovery code"); // the code box is EMPTY: the operator IS stuck
  eq("an EMPTY recovery code records nothing (the funnel does not record an empty value)", rowsOf("form-rejected").length, 0);
  typeAndLeave("pk-recovery-code", "ABCD-EFGH-1234"); // and ANY non-empty code passes: the ENGINE is the authority
  clickByText(recoverySlot, "Sign in with a recovery code");
  eq("and a TYPED recovery code is never refused in the browser either (no producer, either way)", rowsOf("form-rejected").length, 0);
  ok(
    "so pk-recovery-code is NOT in the vocabulary (a member no code path could write is worse than a blank)",
    !(CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("pk-recovery-code"),
  );
  document.body.replaceChildren();

  // terminate-user-email: the validator is `v.trim() === ""` and nothing else, and readValue() TRIMS, so even a
  // spaces-only box arrives as "". A MALFORMED email is not refused at all: the engine is the authority.
  resetRing();
  setActiveScreen("/security");
  // The member-sessions lever is capability-gated (roles.write), so the caller is an owner: the real screen shows
  // the control to nobody else, and a test that drove it with no caller would be driving a control that is not on
  // the page.
  setCaller({ method: "passkey", email: "o@acme.example", role: "owner", groups: [], isOnlyOwner: true } as unknown as Caller);
  const sessions = sessionsAndPasskeysSection(engineStub);
  document.body.appendChild(sessions);
  clickByText(sessions, "Sign out this member"); // the email box is EMPTY
  eq("an EMPTY member email records nothing", rowsOf("form-rejected").length, 0);
  typeAndLeave("terminate-user-email", "   "); // the one string where v.trim() === "" yet v !== ""
  eq("and a spaces-only value is the same empty box (readValue trims before it validates)", rowsOf("form-rejected").length, 0);
  typeAndLeave("terminate-user-email", "not-an-email"); // no shape check exists: it is not refused at all
  eq("a MALFORMED member email is not refused in the browser, so it records nothing", rowsOf("form-rejected").length, 0);
  ok(
    "so terminate-user-email is NOT in the vocabulary",
    !(CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("terminate-user-email"),
  );
  document.body.replaceChildren();

  // rule-downpipe: a CROSS-FIELD emptiness test (`scope === "downpipe" && v.length === 0`), which is still an
  // emptiness test. Driven through the real notification rule form with a per-downpipe scope and no downpipe to
  // choose (the one reachable refusal: every downpipe was deleted).
  resetRing();
  setActiveScreen("/notifications");
  const ruleControls = buildRuleFormControls(null, [], []);
  const ruleErr = domH("p");
  const ruleWrap = domH("div", ruleControls.scopeKindField.el, ruleControls.downpipeSelectField.el, ruleErr);
  document.body.appendChild(ruleWrap);
  ruleControls.scopeKindField.control.value = "downpipe";
  const saved = await submitRuleForm(engineStub, null, ruleControls, ruleErr, () => {})();
  eq("a per-downpipe rule with NO downpipe to choose is refused (the operator is stuck)", saved, false);
  eq("and it records NOTHING: the validator examined no value, it found an empty box", rowsOf("form-rejected").length, 0);
  ok(
    "so rule-downpipe is NOT in the vocabulary (a cross-field emptiness test is still an emptiness test)",
    !(CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("rule-downpipe"),
  );
  document.body.replaceChildren();

  // DEAD VOCABULARY, refused on purpose. idp-var-*, saml-idp-entity and saml-sp-entity are `required: true` with
  // a validator that only rejects the empty string, so field()'s required branch returns before the validator
  // runs and their ONLY possible refusal is the one the funnel deliberately does not record. A member for them
  // would read like coverage and could never be produced.
  ok(
    "the three controls whose only refusal is required-and-empty are NOT in the vocabulary (no producer, no member)",
    !(CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("idp-var") &&
      !(CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("saml-idp-entity") &&
      !(CLIENT_DIAG_FORM_FIELDS as readonly string[]).includes("saml-sp-entity"),
  );

  document.body.replaceChildren();

  // ---- THREE DIRECT CALL SITES THAT THE EMPTINESS RULE MUST ALSO REACH ------------
  //
  // The rule ("a `rejected` row asserts the console refused THE VALUE THE OPERATOR TYPED, so there has to have
  // been one") is structural on two of the three recording arms: field()'s validate funnel and its refuse()
  // guard. A DIRECT recordFormRejected call site left on the honour system could record the EMPTY BOX as a
  // refusal -- byte-identically to the real refusal each member exists for, coalescing onto the same tuple key
  // and burying the ticket inside a count of half-filled forms. The recorder's rule (recordFormRefused takes the
  // raw value and cannot write a row without one) is what these three arms drive through the real screens and
  // the real buttons.

  // ARM 1: THE SETUP SCREEN, the console's most-trafficked form. validateHexId/validateResourceName/
  // validateDatabaseId all return "The ... is required." for "", so pressing Attach on an untouched KV form must
  // not write binding/rejected or namespaceId/rejected for values nobody typed.
  resetRing();
  setActiveScreen("/sources/add");
  setCaller({ method: "access", email: "o@acme.example", role: "owner", groups: [], isOnlyOwner: true } as unknown as Caller);
  connect("https://engine.test"); // the screen's own requireEngine gate: it renders nothing without a client
  const attach = addSourceScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/sources/add" } as never);
  document.body.appendChild(attach);

  clickByText(attach, "Attach this source"); // a FRESH KV form: NOTHING has been typed
  eq("Attach on an UNTOUCHED setup form is an operator part-way through it, and records NOTHING", rowsOf("form-rejected").length, 0);

  // THE REAL REFUSAL, the one the member exists for: a UUID in the KV namespace-id box, which the hex-only regex
  // turns away ("the attach form says my id is invalid but the catalogue accepted it").
  setValue("as-binding", "MY_KV");
  setValue("as-kv-ns", "0f2ac7c1-b6e0-470a-8f3d-2c9b1e6a4d5f");
  clickByText(attach, "Attach this source");
  eq("a UUID the hex-only rule refuses IS a row", rowsOf("form-rejected").length, 1);
  eq("...on the namespace-id control (the validator field key, which is the catalogued member here)", String(rowsOf("form-rejected")[0]?.formField), "namespaceId");

  // THE HALF-FILLED FORM: the binding is typed, the id box is empty. This must not be byte-identical to the row
  // above and coalesce into its count.
  resetRing();
  setValue("as-binding", "MY_KV");
  setValue("as-kv-ns", "");
  clickByText(attach, "Attach this source");
  eq("NOISE: a half-filled form (the id box still empty) records NOTHING, so it cannot bury the row above", rowsOf("form-rejected").length, 0);
  document.body.replaceChildren();

  // ARM 2: THE DESTINATION FORM. Number("".trim()) is 0, which fails `days <= 0`, so choosing an immutability
  // mode and pressing Save before typing a retention must not write dest-worm-days/rejected -- the same row as
  // the real refusal ("our day-count rule is tighter than Object-Lock's").
  resetRing();
  setActiveScreen("/destinations");
  const fctx: FormContext = { engineAccountId: "acct-1", engineR2Buckets: ["archive"], sourceR2Buckets: new Set<string>(), discoveryRead: true, downpipesRead: true };
  const destForm = destinationForm(engineStub, fctx, { confirmReplace: false, onSaved: () => {} });
  document.body.appendChild(destForm);
  setValue("dest-r2-bucket", "archive");
  setValue("dest-access-key", "AKIAEXAMPLE");
  setValue("dest-secret", "s3cr3t-example");
  setValue("dest-worm-mode", "governance");
  setValue("dest-worm-days", ""); // the mode is chosen; the operator has not typed a retention yet
  clickByText(destForm, "Verify and save");
  eq("NOISE: Save with an immutability mode and an EMPTY retention box records NOTHING", rowsOf("form-rejected").length, 0);

  setValue("dest-worm-days", "0.5"); // a value the operator DID type, and the rule refuses it
  clickByText(destForm, "Verify and save");
  eq("a retention the day-count rule refuses IS a row", rowsOf("form-rejected").length, 1);
  eq("...on the retention control, as a refusal the operator saw", String(rowsOf("form-rejected")[0]?.formField), "dest-worm-days");
  document.body.replaceChildren();

  // ARM 3: THE CUSTODY SPLIT PICKERS, on BLUR, through the REAL custody step and the REAL scheme radio (the split
  // panel does not exist until an operator picks the M-of-N tier). Number("") is 0, so clearing the share-count
  // box and tabbing away must not run the ceremony's rule over a pair nobody chose and write custody-split-n/
  // rejected: that would be indistinguishable from the operator who really did ask for a 1-of-1 split, which is
  // the row the member is for.
  resetRing();
  setActiveScreen("/onboarding");
  // downloadText answers true: it is whether the browser ACCEPTED the delivery, and a stub returning
  // undefined reads as a refusal, which puts the panel into its did-not-deliver branch for a reason
  // that has nothing to do with the ring member under test here.
  const custody = renderCustodyStep({ result: { breakGlass: { identityB64: "AAAA" } }, onChange: () => {}, downloadText: () => true });
  document.body.appendChild(custody);
  const splitRadio = document.getElementById("custody-scheme-mofn-split") as HTMLInputElement;
  splitRadio.checked = true;
  (splitRadio as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(makeEvent({ type: "change" }));
  typeAndLeave("custody-split-n", ""); // the box is cleared and the operator tabs away
  eq("NOISE: an EMPTY share-count box on blur records NOTHING (Number(\"\") is 0, and 0 is not a choice)", rowsOf("form-rejected").length, 0);
  typeAndLeave("custody-split-n", "1"); // a pair the operator DID choose, and the ceremony refuses it
  ok("a 1-share split the ceremony refuses IS a row", refusedFields().includes("custody-split-n"));

  // REDACTION over all three arms: not one typed value rides. These boxes hold namespace ids, bucket names,
  // destination keys and secrets.
  const arms = JSON.stringify(snapshot());
  ok(
    "REDACTION: no namespace id, bucket name, access key or secret from any of the three arms is in the payload",
    arms.indexOf("0f2ac7c1") === -1 && arms.indexOf("MY_KV") === -1 && arms.indexOf("archive") === -1 && arms.indexOf("AKIAEXAMPLE") === -1 && arms.indexOf("s3cr3t") === -1,
  );

  document.body.replaceChildren();
  setCaller(null);
}

// ---------------------------------------------------------------------------------------------------------
// the renderer: a backgrounded tab must not manufacture a rendering fault.
// ---------------------------------------------------------------------------------------------------------
async function g345(): Promise<void> {
  console.log("\n-- a hidden tab is not a frozen map --");

  // TWO STATES THAT MUST NOT COALESCE. In a hidden document the browser SUSPENDS requestAnimationFrame while
  // the freeze guard's setTimeout keeps running, so probeRaf resolves "frozen" on a browser with nothing wrong
  // with it. Both states below feed classifyRenderer the identical rAF reading; only the visibility tells them
  // apart, which is why the visibility is a fact the classifier is given.
  const hiddenTabButHealthy = classifyRenderer({ mode: "canvas2d", animation: "animated", raf: "frozen", cssAnim: "advancing", everHidden: true });
  const extensionFrozeTheLoop = classifyRenderer({ mode: "canvas2d", animation: "animated", raf: "frozen", cssAnim: "advancing", everHidden: false });
  eq("a healthy map that mounted in a BACKGROUND TAB is unobserved, not a fault", hiddenTabButHealthy, "unobserved");
  eq("an extension that froze the loop in a VISIBLE tab is still raf-frozen", extensionFrozeTheLoop, "raf-frozen");
  ok("DISCRIMINATION: the two do not produce the same cause, so they cannot coalesce", hiddenTabButHealthy !== extensionFrozeTheLoop);

  // The facts that do NOT need an observer keep outranking it: a browser that refused a 2d context refused it
  // whether anyone was looking or not, and reduced motion is read off the operator's own stated preference.
  eq(
    "a REFUSED CANVAS is canvas-blocked even in a hidden tab (the fallback is what they will see)",
    classifyRenderer({ mode: "svg-fallback", animation: "static-frame", raf: "frozen", cssAnim: "frozen", everHidden: true }),
    "canvas-blocked",
  );
  eq(
    "reduced motion is the operator's own setting, and is reportable hidden or not",
    classifyRenderer({ mode: "canvas2d", animation: "static-frame", raf: "frozen", cssAnim: "frozen", everHidden: true }),
    "reduced-motion",
  );

  // watchVisibility spans the WHOLE probe window, because a tab hidden HALFWAY THROUGH gives the same false
  // frozen reading as one hidden at the start. Driven over a document that goes hidden mid-probe.
  let state: DocumentVisibilityState = "visible";
  const listeners: Array<() => void> = [];
  const fakeDoc = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_n: string, fn: () => void) => listeners.push(fn),
    removeEventListener: () => {},
  } as unknown as Document;
  const watch = watchVisibility(fakeDoc);
  ok("a document visible at the start of the probe is not yet hidden", !watch.everHidden());
  state = "hidden";
  for (const fn of listeners) fn(); // the visibilitychange the browser fires
  state = "visible"; // and the operator comes straight back
  ok("a tab hidden MIDWAY through the probe is remembered (a before/after sample alone would miss it)", watch.everHidden());
  watch.stop();

  // probeCssAnimations must not sample getAnimations()[0] as an arbitrary animation. A FINISHED animation with a
  // fill mode stays in that list with its currentTime pinned at the end -- the console ships one -- so sampling
  // it could report a healthy page as css-anim-frozen. Only a RUNNING animation can advance, so only a running
  // one is evidence.
  const finishedWithFill = { playState: "finished", currentTime: 220 };
  const docWithOnlyAFinishedAnimation = { getAnimations: () => [finishedWithFill] } as unknown as Document;
  eq(
    "NOISE: a FINISHED fill-mode animation is not a frozen one (the console ships one on every restore step)",
    await probeCssAnimations(docWithOnlyAFinishedAnimation),
    "none",
  );
  const running = { playState: "running", currentTime: 0 };
  const docWithAFrozenRunningAnimation = { getAnimations: () => [running] } as unknown as Document;
  eq("a RUNNING animation that does not advance IS frozen", await probeCssAnimations(docWithAFrozenRunningAnimation), "frozen");
}

async function main(): Promise<void> {
  await g335();
  await g345();
  console.log(failures === 0 ? "\nCONSOLE POSTURE CHECKS: PASS" : `\nCONSOLE POSTURE CHECKS: ${failures} FAILED`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

await main();
