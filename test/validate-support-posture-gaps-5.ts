// Validates a set of console-side support-pack states where a recorder existing, a real caller existing and the
// projection working is not enough: the state each case exists to separate must still produce no row, or the
// same row as its opposite, unless the classifier is driven through the product's own entry point.
//
// SO EVERY TEST HERE DRIVES A REAL ENTRY POINT. The pattern this file exists to avoid is the self-certifying
// test: calling the recorder by hand with a literal class and asserting the ring gives it back. That proves the
// RING can carry the class, not that the PRODUCT can put it there. Below:
//
//   g238 drives EngineClient.verifyDestination over the engine's REAL response union (a stubbed fetch), not
//        destProbeOutcome with a hand-made shape ({ok:false, deleteProbe}) the engine cannot emit.
//   g240 drives readPricing through submitDestination's REAL field handles, with a number input in the state a
//        browser actually leaves it in when it eats the operator's text (value "", validity.badInput true); see
//        the contract note above g240() for the full rate-refusal behaviour this asserts.
//   g243 drives the REAL refusal classifiers over the ENGINE'S OWN refusal sentences.
//   g250 drives featureOutcomeForError over the transport's REAL throws (the Access marker, the HTML marker).
//   g254 drives recordServedBundleSkew over the REAL served-version reader.
//   g261 drives providerKey/providerLogo with an unknown preset id, the path a render-site-only guard would miss.
//
// Run with `node test/validate-support-posture-gaps-5.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import {
  cfDiscoveryBlackout,
  cfRediscoverRefusalClass,
  cfRediscoverThrowClass,
  destProbeOutcome,
  featureOutcomeForError,
  recordCatalogueDegraded,
  recordConsoleSkew,
  reset as resetRing,
  setActiveScreen,
  skewClassFor,
  snapshot,
} from "../src/lib/client-diag/ring.ts";
import { recordServedBundleSkew } from "../src/lib/console-version.ts";
import { providerKey, providerLogo } from "../src/screens/idp-connections/provider-logos.ts";
import { EngineClient } from "../src/lib/api/client.ts";
import { ENGINE_BINDING_ABSENT } from "../src/lib/errors.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { listRoles } from "../src/lib/api/client-rbac.ts";
import { rediscoverCfConfig } from "../src/lib/api/client-sources.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
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

const rows = (): ClientDiagnosticRecord[] => snapshot().records;
const rowsOf = (kind: string): ClientDiagnosticRecord[] => rows().filter((r) => r.kind === kind);

const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input instanceof Request ? input.url : input), init))) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------
// The WORM/retention destination. THE ENGINE REPORTS IT ON THE ok:TRUE ARM.
// ---------------------------------------------------------------------------------------------------------
async function g238(): Promise<void> {
  console.log("\n-- a bucket that refuses DELETES is not a healthy bucket --");
  setActiveScreen("/destinations");

  // The engine's REAL responses. probeDestination catches the delete throw and returns ok:TRUE with
  // deleteProbe:"denied" -- a refused cleanup delete does NOT fail the probe. deleteProbe exists ONLY on the
  // ok:true arm; the failure arm carries a reason and no deleteProbe at all. Both are copied from the engine.
  const HEALTHY = { ok: true, deleteProbe: "ok", objectLock: "not-enforced", ms: 42, source: "console" };
  const WORM = { ok: true, deleteProbe: "denied", objectLock: "enforced", ms: 51, source: "console" };
  const engine = new EngineClient("https://engine.example");

  const drive = async (body: unknown): Promise<void> => {
    stubFetch(() => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    await engine.verifyDestination("d1");
  };

  // The healthy destination, through the REAL client.
  resetRing();
  await drive(HEALTHY);
  const healthyRow = rowsOf("probe-outcome")[0];
  eq("a healthy verify records ok", healthyRow?.probeOutcome, "ok");

  // The WORM bucket. Writes accepted, deletes refused: the destination works and its retention cannot be
  // managed, and a classifier that reads only the top-level ok flag would record this as `ok`, coalescing it
  // with a genuinely healthy bucket.
  resetRing();
  await drive(WORM);
  const wormRow = rowsOf("probe-outcome")[0];
  eq("the WORM bucket records dest-delete-denied", wormRow?.probeOutcome, "dest-delete-denied");

  // THE DISCRIMINATION TEST: drive BOTH into ONE ring and count the rows. probeSurface + probeOutcome are the
  // tuple key, so if the classifier reported both as "ok" they would coalesce into a single row with count 2.
  resetRing();
  await drive(HEALTHY);
  await drive(WORM);
  eq("a healthy bucket and a WORM bucket are TWO rows in one ring, not one coalesced count", rowsOf("probe-outcome").length, 2);
  ok(
    "and the two rows carry DIFFERENT outcomes",
    new Set(rowsOf("probe-outcome").map((r) => r.probeOutcome)).size === 2,
  );

  // The mis-regioned bucket: a real, common fault whose remedy (set the region) is unlike every other dest
  // member's, so it needs its own class rather than landing in dest-other with every unclassified fault. The
  // reason is the engine's.
  eq(
    "a mis-regioned bucket is its own class, not dest-other",
    destProbeOutcome({ ok: false, reason: "the destination redirected the request, which usually means the region is wrong for this bucket." }),
    "dest-region-mismatch",
  );

  // REDACTION: the engine's reason names the customer's bucket. Not one byte of it may reach the ring.
  resetRing();
  await drive({ ok: false, reason: 'the destination denied the write to bucket "acme-health-backups" (HTTP 403)' });
  ok("REDACTION: the bucket name in the engine's reason never reaches the ring", !JSON.stringify(snapshot()).includes("acme-health-backups"));
  eq("...and the auth failure is still classified", rowsOf("probe-outcome")[0]?.probeOutcome, "dest-auth");

  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------------------------------------
// The contracted rate the number input ate. THE CONSOLE NOW REFUSES IT INSTEAD OF SUBSTITUTING IT.
//
// THE RISK THIS SECTION GUARDS AGAINST: a number control that ate the operator's text (value "", validity.badInput
// true) reports the same empty box a browser leaves for "not filled in yet". A save driven through without a
// submit-time check on that signal would let `storagePerGBMonth: 0.015` -- Cloudflare's list price -- be stored
// under `source: "operator"`, which positively asserts it was their own contracted rate, an operator having typed
// "$0.0123" into the storage rate and having the save land while `storageField.validate()` says the value is bad.
// The console instead runs its own rule at submit and refuses, so STATE A (A SAVE LANDING ON AN UNREAD RATE) IS
// UNREACHABLE BY CONSTRUCTION. The five states where nothing is saved -- a cancelled replace, a queued
// dual-control save, an engine refusal, a form refusal, an empty box -- write no row either, and that
// discrimination is asserted alongside the refusal. The contract this section asserts is:
//
//   1. A rate the control could not read never reaches a save. Nothing is sent, nothing is stored, and the
//      operator is told -- at the rate AND at the Save button, because the pricing block is a collapsed
//      <details> and an error painted inside a closed one is a save that does nothing for no visible reason.
//   2. The refusal is EVIDENCE. That is the half that could have been lost: the browser threw the operator's
//      text away, so the raw value is "" and recordFormRefused's emptiness rule would have dropped the row.
//      It now reads validity.badInput, which is the one signal that separates "the operator has not filled
//      this in yet" from "the control ate what they typed". The ticket moves from "cost estimates ignore the
//      contracted rate I entered", weeks later, to "the form will not take my rate", at the form, and there is
//      a row for it either way.
//   3. The empty box still saves. It is the ordinary "use the vendor's published rate" choice, it is the
//      commonest state of this form, and refusing it would block every destination saved without custom rates.
//   4. No save carries a coerced rate, asserted against readPricing's OWN list rather than against the rule
//      that refuses, so the two cannot drift apart in silence: a submit gate looser than the field it guards
//      is exactly how a coerced rate would reach a save unnoticed.
//
// AND `silently-coerced` NOW HAS NO PRODUCER IN THE CONSOLE. It is a member of CLIENT_DIAG_REJECT_OUTCOMES,
// which client-diag-parity-gate.mjs holds byte-identical to the engine's copy, so removing it is a coordinated
// console+engine change and not this pass's to make. It is asserted DEAD here instead, so that a future caller
// writing a row whose vocabulary says "the save succeeded and the estate runs on a value they did not choose"
// has to come through this assertion and say why that is true again.
// ---------------------------------------------------------------------------------------------------------
async function g240(): Promise<void> {
  console.log("\n-- a contracted rate the browser ate, refused at the form instead of substituted --");
  setActiveScreen("/destinations");

  // THE REAL SUBMIT, END TO END. readPricing alone is not the fault path: it runs BEFORE every abort in
  // submitDestination (a refusal at the form, a cancelled confirm, a queued dual-control save, the engine's own
  // refusal), and in every one of those the estate keeps the pricing it already had. Driving readPricing on its
  // own cannot see that, and would file a maximal-severity commercial-drift row for an operator who simply
  // pressed Cancel.
  const { buildPricingBlock } = await import("../src/screens/destination-form-fields.ts");
  const { submitDestination } = await import("../src/screens/destination-submit.ts");
  const { h } = await import("../src/lib/dom.ts");
  const { qs, flushAsync } = await import("./dom-shim.ts");
  const { SN, findButtonByText, click } = await import("./validate-stable-components-shared.ts");

  // A number input whose content is not a valid floating-point number reports value "" and validity.badInput
  // true. That is the browser state after an operator types "$0.015", "0,015" or "1,234.5" -- every example the
  // coercion is about -- and it is INDISTINGUISHABLE, from .value alone, from an empty box. The dom-shim's
  // inputs do not model ValidityState, so the state is set on the real control the real builder made.
  const ate = (f: unknown): void => {
    const c = (f as { control: HTMLInputElement }).control;
    c.value = "";
    (c as unknown as { validity: { badInput: boolean } }).validity = { badInput: true };
  };

  // Every field submitDestination reads apart from the REAL pricing block, which is the block under test.
  const stub = (value: string): unknown => ({
    el: h("div"),
    control: h("input"),
    value: () => value,
    badInput: () => false,
    setError: () => undefined,
    clearError: () => undefined,
    validate: () => true,
    focus: () => undefined,
  });

  type Result = { status: string; value?: unknown; queued?: unknown };
  const APPLIED: Result = { status: "result", value: { destinations: [] } };
  const QUEUED: Result = { status: "queued", queued: { id: "oa-1", status: "pending" } };

  // buildCtx wires the REAL pricing controls into a REAL SubmitContext. `over` sets the worm fields so the
  // form-refusal state can be driven; `result` is what the engine answers (or a throw).
  const buildCtx = (over: { wormMode?: string; wormDays?: string; confirmReplace?: boolean }, result: Result | "throw") => {
    const pricingState = { edited: false };
    const pb = buildPricingBlock({} as never, pricingState);
    const calls: unknown[] = [];
    const engine = {
      async addDestination(input: unknown): Promise<Result> {
        calls.push(input);
        if (result === "throw") throw new Error("verify destination: the bucket refused the write (HTTP 403)");
        return result;
      },
    };
    const ctx = {
      engine,
      fctx: { engineAccountId: "acct123", engineR2Buckets: new Set(), sourceR2Buckets: new Set() },
      opts: { confirmReplace: over.confirmReplace === true, editId: over.confirmReplace === true ? "d1" : undefined, onSaved: () => undefined },
      getProvider: () => "r2",
      pricingState,
      labelField: stub("Primary"),
      // The R2 field group, held whole (SubmitContext.r2Block). This fixture is the DEFAULT state:
      // discovery named the engine account and the other-account override is clear, so there is no
      // Account ID to validate and the endpoint derives from the discovered account.
      r2Block: {
        block: h("div"),
        bucketField: () => stub("my-bucket"),
        accountIdField: () => null,
        accountId: () => "acct123",
        circNote: h("div"),
      },
      endpointField: stub("https://s3.example.com"),
      s3BucketField: stub("my-bucket"),
      regionField: stub("us-east-1"),
      addressingField: stub("auto"),
      storageClassField: stub(""),
      keyField: stub("AKIAEXAMPLE"),
      secretField: stub("secretvalue"),
      storageField: pb.storageField,
      classAField: pb.classAField,
      classBField: pb.classBField,
      egressField: pb.egressField,
      currencyField: pb.currencyField,
      pricingSection: pb.section,
      wormModeField: stub(over.wormMode ?? "off"),
      wormDaysField: stub(over.wormDays ?? ""),
      roleArnField: stub(""),
      externalIdField: stub(""),
      durationField: stub(""),
      formError: h("p"),
      saveBtn: h("button"),
    } as unknown as Parameters<typeof submitDestination>[0];
    return { ctx, pb, calls, formError: ctx.formError as HTMLElement };
  };

  // saidToTheOperator reads the two surfaces the customer actually sees: the inline slot beside Save, and the
  // toast. It is read off the REAL document the real toast() writes into, and NOISE B below is its positive
  // control (a save that lands must produce the toast), because a matcher that finds nothing on every state
  // would report the fix working while asserting nothing at all.
  const clearToasts = (): void => {
    for (const r of [...document.body.querySelectorAll(".toast-region")]) r.textContent = "";
  };
  const saidToTheOperator = (formError: HTMLElement): { inline: string; toast: boolean } => ({
    inline: formError.hidden ? "" : (formError.textContent ?? ""),
    toast: (document.body.textContent ?? "").includes("Destination verified and saved"),
  });
  const fieldErrorOn = (f: unknown): string => ((f as { el: HTMLElement }).el.textContent ?? "").match(/must be a number that is not negative\..*/)?.[0] ?? "";

  // answerModal clicks the named button on whatever confirmModal the submit put up.
  const answerModal = async (label: string): Promise<void> => {
    await flushAsync();
    const surface = qs(SN(document.body) as never, ".dialog--modal");
    if (surface) {
      const btn = findButtonByText(surface, label);
      if (btn) click(btn);
    }
    await flushAsync();
  };

  // Declared `?: string | undefined` rather than `?: string`, because the map below reads these off a
  // record where they may genuinely be absent and hands over an explicit undefined, which
  // exactOptionalPropertyTypes treats as different from an omitted key. Both mean the same thing here:
  // the row carried no such field.
  const coercedRows = (): Array<{ formField?: string | undefined; rejectOutcome?: string | undefined }> =>
    rowsOf("form-rejected").map((r) => ({ formField: r.formField as string | undefined, rejectOutcome: r.rejectOutcome as string | undefined }));

  // STATE A: the operator TYPED a contracted rate and the control ate it. THE SAVE IS REFUSED. This is the
  // headline, and it is asserted on the two things a customer can actually observe: what was stored, and what
  // the screen said.
  resetRing();
  {
    const { ctx, pb, calls, formError } = buildCtx({}, APPLIED);
    clearToasts();
    ate(pb.storageField);
    await submitDestination(ctx);
    await flushAsync();
    eq("STATE A: NOTHING IS STORED (the vendor preset under source:operator never gets a chance to stand in for it)", calls.length, 0);
    eq(
      "STATE A: the operator is told AT THE RATE, in the console's own words",
      fieldErrorOn(pb.storageField),
      "must be a number that is not negative. Type the rate as a plain number, with no currency symbol or thousands separator, for example 0.015.",
    );
    const said = saidToTheOperator(formError);
    ok(
      "STATE A: ...and BESIDE SAVE, because the pricing block is collapsed and an error inside a closed disclosure is invisible",
      said.inline.startsWith("A storage-pricing rate could not be read, so nothing was saved."),
    );
    ok(
      "STATE A: ...naming the one-keystroke way through, so an optional cost estimate cannot strand a setup",
      said.inline.includes("clear the box to use the vendor's published rate"),
    );
    ok("STATE A: and the customer is NOT told 'Destination verified and saved'", !said.toast);

    // THE EVIDENCE HALF, and it is the half easily lost. The browser throws the typed text away, so the raw
    // value is "" and an emptiness rule inside recordFormRefused that looked only at the raw value would drop
    // the row.
    eq("STATE A: the refusal IS recorded, on the catalogue's OWN control id", coercedRows()[0]?.formField, "dest-price-storage");
    eq("STATE A: ...as `rejected` -- the operator SAW it, which is what that outcome means", coercedRows()[0]?.rejectOutcome, "rejected");
    eq("STATE A: one refused rate is one row", coercedRows().length, 1);
    ok(
      "STATE A: and NO silently-coerced row anywhere -- the state it asserts (the save landed on a rate they did not choose) cannot happen",
      !rowsOf("form-rejected").some((r) => r.rejectOutcome === "silently-coerced"),
    );
  }

  // STATE A': THE EATEN RATE NEVER REACHES THE CONSEQUENCE PROMPTS EITHER. The refusal is placed above the
  // compliance and replace-credentials confirms deliberately: asking an operator to accept an irreversible
  // consequence, and only then telling them the form will not take their rate, is a worse form than the one
  // being fixed. Driven on the replace path, which is the one that puts a modal up.
  resetRing();
  {
    const { ctx, pb, calls } = buildCtx({ confirmReplace: true }, APPLIED);
    ate(pb.storageField);
    const p = submitDestination(ctx);
    await flushAsync();
    ok("STATE A': no consequence modal is raised over a form that is going to refuse anyway", qs(SN(document.body) as never, ".dialog--modal") === null);
    // Answered anyway, so a tree that DID raise one settles instead of deadlocking the run: an unsettled await
    // here would take the whole file down before the tally and every assertion after it would be incapable of
    // failing, which is the one way a red is worse than useless.
    await answerModal("Cancel");
    await p;
    eq("STATE A': and nothing is sent", calls.length, 0);
  }

  // STATE E: A READABLE rate, and the operator CANCELS the replace-credentials confirm. Nothing is sent, the
  // saved destination keeps the pricing it already had, and the estate is fine. Driving this with an EATEN rate
  // instead would be indistinguishable from STATE A (support told the customer's cost estimates were running on
  // a rate they did not choose, sent to a destination whose stored pricing had never been touched); the eaten-rate
  // leg belongs to STATE A' above, where the form refuses it. What this state guards is that a cancel produces
  // no evidence of a save.
  resetRing();
  {
    const { ctx, calls } = buildCtx({ confirmReplace: true }, APPLIED);
    const p = submitDestination(ctx);
    await answerModal("Cancel");
    await p;
    eq("STATE E: a cancelled replace sends NOTHING", calls.length, 0);
    eq("STATE E (NOISE): and records NOTHING", coercedRows().length, 0);
  }

  // STATE G: dual control. The engine VERIFIED the destination and QUEUED the save for a second owner; it stored
  // nothing. Driven with a READABLE rate, because the assertion is about the dual-control path reaching the
  // engine and a fixture that cannot get past the form asserts nothing about it.
  resetRing();
  {
    const { ctx, calls } = buildCtx({}, QUEUED);
    await submitDestination(ctx);
    eq("STATE G: the queued save reached the engine", calls.length, 1);
    eq("STATE G (NOISE): a QUEUED save stores nothing, so it records nothing", coercedRows().length, 0);
  }

  // STATE F: the engine REFUSED the save. Nothing stored, and the console files no form-refusal for a refusal
  // that was not the console's.
  resetRing();
  {
    const { ctx } = buildCtx({}, "throw");
    await submitDestination(ctx);
    eq("STATE F (NOISE): an engine refusal is not a form refusal, so it records nothing", coercedRows().length, 0);
  }

  // STATE C: the console itself blocked the save (a WORM mode with a retention THE OPERATOR TYPED and the rule
  // refuses). The operator sees the error and will fix the rate on the next attempt. The form refusal is recorded,
  // because it IS what happened; the coercion is not, because nothing was saved.
  //
  // AND IT IS DRIVEN WITH A TYPED VALUE, NOT AN EMPTY BOX. wormDays: "" is the required-and-empty state, the
  // commonest event in the console, and a refusal row for it would wrongly claim the console had examined a
  // retention the operator never typed. Without a value typed in the box, that state would coalesce onto the
  // same tuple key as the real refusal below, burying the ticket this member exists for inside a count of
  // half-filled forms.
  resetRing();
  {
    const { ctx, calls } = buildCtx({ wormMode: "governance", wormDays: "0.5" }, APPLIED);
    await submitDestination(ctx);
    eq("STATE C: the form blocked the save", calls.length, 0);
    eq("STATE C: the WORM refusal is recorded (it is what happened)", coercedRows()[0]?.formField, "dest-worm-days");
    ok("STATE C (NOISE): and no rate refusal rides along with it", !coercedRows().some((r) => r.formField === "dest-price-storage"));
  }

  // STATE C'': BOTH a rate the control ate AND a retention the rule refuses. The operator is answered in PAGE
  // ORDER -- pricing sits above immutability in the form -- so the rate is the one they are sent to, and it is
  // the only refusal recorded.
  resetRing();
  {
    const { ctx, pb, calls } = buildCtx({ wormMode: "governance", wormDays: "0.5" }, APPLIED);
    ate(pb.storageField);
    await submitDestination(ctx);
    eq("STATE C'': the form blocked the save", calls.length, 0);
    eq("STATE C'': the operator is answered about the RATE first, which is the control higher up the form", coercedRows()[0]?.formField, "dest-price-storage");
    eq("STATE C'': and exactly one refusal is recorded, not one per rule the form holds", coercedRows().length, 1);
  }

  // STATE C': THE SAME BLOCK, WITH THE RETENTION BOX STILL EMPTY. The operator picked a mode and hit
  // Save before typing a number: Number("") is 0, which fails `days <= 0`, so the form refuses them exactly as
  // above and they see the message either way. NOTHING is recorded: no value was examined, so there is no refusal
  // to claim, and the real refusal in STATE C is no longer buried under a count of these.
  resetRing();
  {
    const { ctx, calls } = buildCtx({ wormMode: "governance", wormDays: "" }, APPLIED);
    await submitDestination(ctx);
    eq("STATE C' : the form blocks the save just the same (the operator is not let through)", calls.length, 0);
    eq("STATE C' (NOISE): an EMPTY retention box records NOTHING, so it cannot bury the real refusal", coercedRows().length, 0);
  }

  // STATE B: THE OVER-FIX GUARD, and it is the most important assertion in this section. The operator LEFT THE
  // BOX EMPTY and saved. That is the ordinary "use the vendor's published rate" choice, it is the commonest
  // state of this form, and a rate rule that refused it would block every destination saved without custom
  // rates -- turning a silent commercial defect into a loud setup blocker.
  //
  // It is also the POSITIVE CONTROL for every "the customer was not told it saved" assertion above: the toast
  // matcher has to find the toast somewhere, or a broken matcher would report the fix working while asserting
  // nothing at all.
  resetRing();
  {
    const { ctx, calls, formError } = buildCtx({}, APPLIED);
    clearToasts();
    await submitDestination(ctx);
    await flushAsync();
    eq("STATE B: an empty rate box still SAVES", calls.length, 1);
    eq(
      "STATE B: ...storing the vendor preset, which is what an empty box has always meant",
      (calls[0] as { pricing: { storagePerGBMonth: number } }).pricing.storagePerGBMonth,
      0.015,
    );
    const said = saidToTheOperator(formError);
    ok("STATE B (POSITIVE CONTROL): and the customer IS told it saved, so the matcher above can see a toast", said.toast);
    eq("STATE B: no refusal is painted beside Save", said.inline, "");
    eq("STATE B (NOISE): and an empty box the operator left empty records NOTHING", coercedRows().length, 0);
  }

  // STATE B': THE EMPTINESS RULE IS INTACT, asserted at the rate control itself. The rate rule now RUNS at
  // submit on every save, so the empty box goes through recordFormRefused on the ordinary path -- and is still
  // dropped, because the control reports no conversion failure. That is the whole width of the change to the
  // rule: `empty` became `empty and the control did not report badInput`, and this is the negative half of it.
  resetRing();
  {
    const { ctx } = buildCtx({}, APPLIED);
    await submitDestination(ctx);
    ok("STATE B': an untouched empty rate box writes no row even though its rule now runs at submit", coercedRows().length === 0);
  }

  // THE INVARIANT: readPricing's `coerced` list is the reader's OWN answer to "would this save carry a rate the
  // operator did not choose", stated independently of the field rule that refuses. Held against every state that
  // reaches the engine: if the two ever disagree, a silent substitution is possible and the refusal is not
  // exhaustive. A test that drove only the refusing rule could not see that gap.
  resetRing();
  {
    const { readPricing } = await import("../src/screens/destination-submit.ts");
    const landed: unknown[] = [];
    for (const rate of ["", "0", "0.015", "1234.5678"]) {
      const { ctx, pb, calls } = buildCtx({}, APPLIED);
      (pb.storageField as unknown as { control: HTMLInputElement }).control.value = rate;
      await submitDestination(ctx);
      if (calls.length === 1) landed.push(readPricing(ctx as never, "r2").coerced);
    }
    eq("INVARIANT: four readable rates all save (the guard refuses nothing it should not)", landed.length, 4);
    ok("INVARIANT: and not one save that landed carries a coerced rate", landed.every((c) => (c as unknown[]).length === 0));
  }

  // THE DISCRIMINATION TEST: a refused save and a landed save are different evidence, on the same form, from
  // the same operator. Without the refusal, state A and state B would be the same outcome (a save, a toast),
  // and only a diagnostic row nobody reads until a ticket is already weeks old would separate them.
  resetRing();
  {
    const { ctx: refused, pb, calls: refusedCalls } = buildCtx({}, APPLIED);
    ate(pb.storageField);
    await submitDestination(refused);
    const { ctx: saved, calls: savedCalls } = buildCtx({}, APPLIED);
    await submitDestination(saved);
    ok("an eaten rate and an empty box END DIFFERENTLY, not in the same save", refusedCalls.length === 0 && savedCalls.length === 1);
    eq("...and one row is written for the pair, on the refusal", coercedRows().length, 1);
  }

  // Every refused rate is its own row (the tuple key carries the field id), and a negative rate is refused too:
  // it is the other value a substitution rule could otherwise swap in, and the one the operator CAN still see
  // in the box.
  resetRing();
  {
    const { ctx, pb, calls } = buildCtx({}, APPLIED);
    ate(pb.storageField);
    (pb.egressField as unknown as { control: HTMLInputElement }).control.value = "-1";
    await submitDestination(ctx);
    eq("nothing is stored when two rates are unreadable", calls.length, 0);
    eq("two refused rates on one save are TWO rows", coercedRows().length, 2);
    ok("...naming both controls", new Set(coercedRows().map((r) => r.formField)).size === 2);
    ok("...and the third and fourth rates, which read cleanly, are not swept in", !coercedRows().some((r) => r.formField === "dest-price-classa" || r.formField === "dest-price-classb"));
  }

  // REDACTION: the rate is the customer's commercial data. It is never readable here even in principle when the
  // control ate it, and a negative rate that IS readable must not travel either.
  resetRing();
  {
    const { ctx, pb, calls } = buildCtx({}, APPLIED);
    (pb.classAField as unknown as { control: HTMLInputElement }).control.value = "-0.0157";
    await submitDestination(ctx);
    eq("a negative rate is refused on its OWN field", coercedRows()[0]?.formField, "dest-price-classa");
    eq("...and nothing is stored", calls.length, 0);
    ok("REDACTION: the typed rate never reaches the ring", !JSON.stringify(snapshot()).includes("0.0157"));
  }

  // AND THE OUTCOME MEMBER IS PINNED DEAD AT THE SOURCE, rather than left implied by the drives above.
  // recordFormCoerced is the only writer of `silently-coerced` and the destination form was its only caller;
  // nothing else in the console would notice it going quiet, because dead-vocab-gate.mjs models
  // CLIENT_DIAG_FORM_FIELDS and not the reject outcomes (the four dest-price-* control ids keep their producer
  // either way, the field() validate funnel, so that gate is green on both trees and says nothing about this).
  //
  // The member cannot simply be deleted from a console-only change: CLIENT_DIAG_REJECT_OUTCOMES is held
  // byte-identical to the engine's copy by client-diag-parity-gate.mjs, and the engine's receiver validates
  // against its own set. Removing it is a coordinated console+engine change. Until then it is asserted dead
  // here, so a caller who brings it back has to come through this assertion and say why the claim is true
  // again: that a save LANDED and the estate is running on a value the operator did not choose.
  {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (p.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const files = walk(srcRoot);
    // The lookbehind drops the DECLARATION in ring.ts, which stays: the recorder is not the claim, the call is.
    const callers = files.filter((f) => /(?<!function\s)recordFormCoerced\s*\(/.test(readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "")));
    // The positive control, because a walk that found no files would pass this the same way a clean tree does.
    ok("CONTROL: the source walk really reads the console (recordFormRefused has callers)", files.length > 100 && files.some((f) => /recordFormRefused\s*\(/.test(readFileSync(f, "utf8"))));
    eq("nothing in the console writes a silently-coerced row any more", callers.length, 0);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Why the Cloudflare rediscover failed, and the token that succeeds while seeing nothing.
// ---------------------------------------------------------------------------------------------------------
async function g243(): Promise<void> {
  console.log("\n-- a Cloudflare discovery that fails, and one that succeeds blindly --");
  setActiveScreen("/downpipes");

  // The ENGINE'S OWN refusal sentences, copied verbatim from router-discovery.ts. The classifier reads them to
  // SELECT a member; the sentence never travels.
  eq(
    "the discovery token was CLEARED (paste a token)",
    cfRediscoverRefusalClass("no discovery token set; set the read-only discovery token first"),
    "cf-rediscover-no-token",
  );
  eq(
    "the account fell OUT OF SCOPE (only the owner can fix it)",
    cfRediscoverRefusalClass("this downpipe's account is no longer in the discovery scope; ask the owner to re-select it under Sources"),
    "cf-rediscover-out-of-scope",
  );
  eq("the residual refusal is counted, never dropped", cfRediscoverRefusalClass("unknown downpipe"), "cf-rediscover-failed");

  // THE THROWN HALF IS DRIVEN THROUGH THE REAL TRANSPORT, NOT HAND-WRITTEN: hand-building `new Error("rediscover:
  // 429")` or `new TypeError("Failed to fetch")` would assert the classifier against an error the test composed
  // rather than the one client-transport.ts actually composes. Everything below is the error the console
  // actually catches, produced by the real rediscoverCfConfig over the real Transport against the real bytes the
  // wire carries.
  const thrown = async (r: () => Response | Promise<Response> | never): Promise<unknown> => {
    stubFetch(() => r());
    try {
      await rediscoverCfConfig(new Transport("http://engine.test"), "dp1");
      throw new Error("expected a throw");
    } catch (e) {
      return e;
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const html = (body: string, status: number): Response => new Response(body, { status, headers: { "content-type": "text/html" } });
  const json = (status: number): Response => new Response(JSON.stringify({ error: "no" }), { status, headers: { "content-type": "application/json" } });
  const engineForbidden = (): Response => new Response(JSON.stringify({ error: "forbidden", required: "downpipes:write" }), { status: 403, headers: { "content-type": "application/json" } });

  eq("a 429 is a RATE LIMIT (retry; nothing is broken)", cfRediscoverThrowClass(await thrown(() => json(429))), "cf-rediscover-rate-limited");
  // A 403 is read by the SHAPE OF ITS REFUSAL BODY, the same principle applied to the sibling classifier below.
  // The engine's own refusal (`forbidden` + a named capability, or the DO's funnel, which names none) is the
  // caller's role. A 403 in nobody's refusal vocabulary -- this `{error:"no"}`, a WAF block page, a static host --
  // establishes only that something refused, and not that any engine did.
  eq("the ENGINE'S OWN 403 is the engine refusing the caller's role", cfRediscoverThrowClass(await thrown(() => engineForbidden())), "cf-rediscover-denied");
  eq("a 403 that did not speak the engine's refusal vocabulary is refused-at-edge", cfRediscoverThrowClass(await thrown(() => json(403))), "cf-rediscover-refused-at-edge");
  eq(
    "a dead network is the TRANSPORT (no token is at fault)",
    cfRediscoverThrowClass(await thrown(() => { throw new TypeError("Failed to fetch"); })),
    "cf-rediscover-transport",
  );

  // THE TWO STATELESS THROWS THAT USED TO BE THE SAME ROW AS A DEAD NETWORK. Both come back with NO status, so a
  // classifier keyed on errorStatus() alone put all three in one count, under a member whose own note says "the
  // call never got an answer: the engine or the network dropped it". For the Access lapse the engine is fine and
  // the operator left a tab open overnight; for the wrong address something IS answering.
  eq(
    "a LAPSED CLOUDFLARE ACCESS SESSION records NOTHING (the ordinary overnight tab, not a fault)",
    cfRediscoverThrowClass(await thrown(() => html("<html>Cloudflare Access login</html>", 302))),
    null,
  );
  eq(
    "a WEB PAGE answering at the engine's address is its own class (the remedy is the ADDRESS)",
    cfRediscoverThrowClass(await thrown(() => html("<!doctype html><html>SPA shell</html>", 404))),
    "cf-rediscover-not-an-engine",
  );

  ok(
    "THE DISCRIMINATION TEST -- a cleared token, an out-of-scope account, a rate limit, a dead transport and a web page at the address are FIVE classes",
    new Set([
      cfRediscoverRefusalClass("no discovery token set; set the read-only discovery token first"),
      cfRediscoverRefusalClass("this downpipe's account is no longer in the discovery scope; ask the owner to re-select it under Sources"),
      cfRediscoverThrowClass(await thrown(() => json(429))),
      cfRediscoverThrowClass(await thrown(() => { throw new TypeError("Failed to fetch"); })),
      cfRediscoverThrowClass(await thrown(() => html("<!doctype html><html>x</html>", 404))),
    ]).size === 5,
  );

  // ...and they do not coalesce in the RING, which is the thing the tuple key governs. Five classes recorded on
  // ONE screen must be five rows, or the key discriminates nothing.
  resetRing();
  for (const e of [
    await thrown(() => json(429)),
    await thrown(() => json(403)),
    await thrown(() => { throw new TypeError("Failed to fetch"); }),
    await thrown(() => html("<!doctype html><html>x</html>", 404)),
    await thrown(() => html("<html>Cloudflare Access login</html>", 302)),
  ]) {
    const c = cfRediscoverThrowClass(e);
    if (c !== null) recordCatalogueDegraded(c);
  }
  recordCatalogueDegraded(cfRediscoverRefusalClass("no discovery token set; set the read-only discovery token first"));
  eq("five distinct refusals on one screen are FIVE rows in the ring (the Access lapse wrote none)", rowsOf("catalogue-degraded").length, 5);

  // THE HEADLINE STATE: a rediscover that RETURNED OK and read not one surface. probeCfConfig does not throw on
  // a scope 403 -- it files the surface as unavailable -- so an expired/rescoped token produces a SUCCESSFUL
  // rediscover that discovered nothing, and "cf-config backups capture nothing new" had no evidence anywhere.
  ok(
    "an ok rediscover that could read NOTHING (present 0, empty 0, all unavailable) is a blind token",
    cfDiscoveryBlackout({ present: [], empty: [], unavailable: new Array(214).fill("s") }),
  );
  // NOISE: a healthy token over an account with nothing configured fills `empty`, not `unavailable`.
  ok(
    "NOISE: a healthy token on an unconfigured account (surfaces EMPTY) is NOT a blackout",
    !cfDiscoveryBlackout({ present: [], empty: new Array(214).fill("s"), unavailable: [] }),
  );
  ok("NOISE: and a normal, partly-used account is not a blackout either", !cfDiscoveryBlackout({ present: ["dns"], empty: ["waf"], unavailable: ["x"] }));

  // THE WITHHELD-OFFER HALF, DRIVEN THROUGH THE REAL WIZARD (appendSourceSections), not through its classifier.
  // The wizard renders the source sections on every open, unconditionally, for every customer. A catalogue-empty
  // branch with no tokenPresent gate would write the SAME row for two different states -- the one whose
  // vocabulary says "this engine predates the cf-config feature, update the engine", and the DEFAULT state of
  // every install that backs up only bound sources, because account discovery is OPT-IN. Without the gate, a
  // bound-source-only customer opening the wizard three times would file three counts against a current engine.
  const { appendSourceSections } = await import("../src/screens/sources-downpipes/editor-wizard-source-sections.ts");
  const { h } = await import("../src/lib/dom.ts");
  const builders = {
    multiGroup: () => null,
    cfPresetControl: () => h("div"),
    cfAccountRow: () => h("div"),
    cfZoneGroup: () => h("div"),
    selectWorkers: () => h("div"),
    selectStream: () => h("div"),
    selectImages: () => h("div"),
    selectArtifacts: () => h("div"),
  };
  const openWizard = (found: unknown): void => {
    appendSourceSections(h("div"), found as never, builders as never);
  };
  const BOUND = { kv: [], r2: [], d1: [], secrets: [] };

  // a token IS stored, the engine walked the token path and returned no catalogue. This is the engine that
  // predates the feature, and it is the only state the member's remedy fits.
  resetRing();
  openWizard({ bound: BOUND, tokenPresent: true, addedSources: ["cf-config"], accounts: [], cfConfigSurfaces: [] });
  eq("an OLD engine (token present, no catalogue) records cf-catalogue-empty", rowsOf("catalogue-degraded")[0]?.catalogueClass, "cf-catalogue-empty");

  // the exact bytes a current engine returns when no discovery token has been set (router-discovery.ts): the
  // early return, with no capability fields at all. Nothing is wrong, and the screen already tells the operator.
  resetRing();
  openWizard({ bound: BOUND, tokenPresent: false });
  eq("NOISE: NO discovery token records NOTHING, not 'update the engine'", rowsOf("catalogue-degraded").length, 0);

  // A bound-source-only customer opening the wizard three times: still nothing.
  resetRing();
  openWizard({ bound: BOUND, tokenPresent: false });
  openWizard({ bound: BOUND, tokenPresent: false });
  openWizard({ bound: BOUND, tokenPresent: false });
  eq("NOISE: three wizard opens on a token-less engine still record NOTHING", rowsOf("catalogue-degraded").length, 0);

  // AND THE COALESCING: without the tokenPresent gate, the two states are IDENTICAL on every tuple-key field
  // and would merge into one count. Driven into one ring they are one row here, and it belongs to the old
  // engine alone.
  resetRing();
  openWizard({ bound: BOUND, tokenPresent: true, addedSources: ["cf-config"], accounts: [], cfConfigSurfaces: [] });
  openWizard({ bound: BOUND, tokenPresent: false });
  eq("the old engine and the token-less engine are ONE row, not one coalesced count of two", rowsOf("catalogue-degraded").length, 1);
  eq("...and it is the old engine's", rowsOf("catalogue-degraded")[0]?.count, 1);
}

// ---------------------------------------------------------------------------------------------------------
// The Access-fenced console. A LAPSED SESSION IS NOT A 401 AND IS NOT AN UNREACHABLE ENGINE.
// ---------------------------------------------------------------------------------------------------------
async function g250(): Promise<void> {
  console.log("\n-- broken, unbuilt, re-authenticate, and wrong-address are four answers --");
  setActiveScreen("/access/security");

  // EVERY ERROR BELOW IS THE ONE THE REAL TRANSPORT THROWS, off the real bytes. Hand-writing
  // `new Error("list roles: " + HTML_BODY_MARKER)` would assert the classifier against an error the test
  // composed rather than the transport, and the transport only ever folds HTML_BODY_MARKER in on the SUCCESS
  // path (parseJson) -- so the commonest wrong-address shape of all, a static host or a proxy answering a 404
  // with an HTML page, reaches a hand-written classifier as a bare 404, byte-identical to a REAL engine
  // declining a route it does not serve.
  const thrown = async (r: () => Response | Promise<Response> | never): Promise<unknown> => {
    stubFetch(() => r());
    try {
      await listRoles(new Transport("http://engine.test"));
      throw new Error("expected a throw");
    } catch (e) {
      return e;
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const html = (body: string, status: number): Response => new Response(body, { status, headers: { "content-type": "text/html" } });
  const jsonAt = (status: number): Response => new Response(JSON.stringify({ error: "no" }), { status, headers: { "content-type": "application/json" } });

  eq(
    "a LAPSED ACCESS SESSION records NOTHING (the ordinary overnight state, not 'the engine is unreachable')",
    featureOutcomeForError(await thrown(() => html("<html>Cloudflare Access</html>", 302))),
    null,
  );
  eq(
    "an SPA shell answering 200 HTML is not-an-engine",
    featureOutcomeForError(await thrown(() => html("<!doctype html><html>shell</html>", 200))),
    "not-an-engine",
  );

  // THE 404 COLLISION, WHICH IS THE ONE THAT MATTERS. A web host 404ing an HTML page and a real engine declining
  // an unbuilt route are opposite tickets with opposite remedies, and a classifier keyed on status alone would
  // read them as the SAME ROW. The engine's unmatched route answers the PLAIN TEXT "not found" (router.ts), on
  // which detectHtmlBody is false, so no legitimate engine 404 can be reclassified: this cannot cry wolf.
  const webHost404 = featureOutcomeForError(await thrown(() => html("<!doctype html><html>404 Not Found</html>", 404)));
  const realEngine404 = featureOutcomeForError(await thrown(() => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })));
  eq("a WEB HOST 404ing an HTML page is not-an-engine (the pending-the-engine tile would be a lie)", webHost404, "not-an-engine");
  eq("a REAL engine's unbuilt route is route-absent (and the tile is CORRECT, and only here)", realEngine404, "route-absent");
  ok("THE 404 COLLISION IS BROKEN: the two are not the same verdict", webHost404 !== realEngine404);

  // A CRASHED WORKER still reads as a broken engine. Cloudflare's own 1101 page is HTML on a 5xx, and calling it
  // "nothing is deployed here" would send support to correct an address that is correct.
  eq(
    "NOISE: a crashed Worker's HTML 5xx page is still server-error, not a wrong address",
    featureOutcomeForError(await thrown(() => html("<!doctype html><html>Worker threw exception</html>", 500))),
    "server-error",
  );
  eq(
    "NOISE: Cloudflare's HTML rate-limit page is still rate-limited (wait), not a wrong address",
    featureOutcomeForError(await thrown(() => html("<!doctype html><html>rate limited</html>", 429))),
    "rate-limited",
  );

  // THE PERIMETER'S OWN STATUSES, AND THEY ARE WHERE THIS CLASS CRIES WOLF IF IT IS LET NEAR THEM. detectHtmlBody
  // is "an HTML page answered", nothing more: it cannot tell a static host's 404 page from the customer's own edge
  // block page. Cloudflare's firewall block (error 1020) is HTML on a 403, and a rate-limit rule whose action is
  // Block answers 403, not 429. In both, the engine is deployed at exactly that address and is healthy, and
  // not-an-engine would send support to correct an address that is correct.
  // They are not `not-an-engine` (the address is NOT established as wrong), and they are not `forbidden` either
  // (the engine is not established as having refused anything). They are the honest member for "something
  // refused, and it did not speak the engine's refusal vocabulary".
  eq(
    "NOISE: a WAF block page (HTML 403) in front of a HEALTHY engine is not a wrong address",
    featureOutcomeForError(await thrown(() => html("<!doctype html><html>error 1020 access denied</html>", 403))),
    "refused-not-by-engine",
  );
  eq(
    "NOISE: a rate-limit rule with a Block action (HTML 403) is likewise not a wrong address",
    featureOutcomeForError(await thrown(() => html("<!doctype html><html>you have been blocked</html>", 403))),
    "refused-not-by-engine",
  );
  eq(
    "NOISE: an HTML 401 (a proxy or Access challenge with no Access marker) still records NOTHING",
    featureOutcomeForError(await thrown(() => html("<!doctype html><html><script src=\"https://acme.cloudflareaccess.com/x.js\"></script></html>", 401))),
    null,
  );
  ok(
    "a PERIMETER block and a wrong ADDRESS are different verdicts (they were the same row)",
    featureOutcomeForError(await thrown(() => html("<!doctype html><html>error 1020</html>", 403)))
      !== featureOutcomeForError(await thrown(() => html("<!doctype html><html>404 Not Found</html>", 404))),
  );

  eq("a genuinely unreachable engine is still network", featureOutcomeForError(await thrown(() => { throw new TypeError("Failed to fetch"); })), "network");
  eq("a 500 is server-error (the engine is BROKEN and the customer was told it was unbuilt)", featureOutcomeForError(await thrown(() => jsonAt(500))), "server-error");
  // The ENGINE'S OWN 403 (its capability gate names the capability it wanted) is forbidden: a role, not a defect.
  // A 403 whose body is in nobody's refusal vocabulary is refused-not-by-engine, which claims nothing about the
  // role and nothing about the address.
  eq("the engine's own 403 is forbidden (a role, not a defect)", featureOutcomeForError(await thrown(() => new Response(JSON.stringify({ error: "forbidden", required: "roles:read" }), { status: 403, headers: { "content-type": "application/json" } }))), "forbidden");
  eq("a 403 in nobody's refusal vocabulary is refused-not-by-engine", featureOutcomeForError(await thrown(() => jsonAt(403))), "refused-not-by-engine");
  eq("a 401 still records nothing", featureOutcomeForError(await thrown(() => jsonAt(401))), null);

  // THE CONSOLE'S OWN WORKER, with no ENGINE service binding. No request reached any engine, so `network` (whose
  // note asserts the engine is unreachable) would send support to read logs for a request that was never sent.
  eq(
    "a console with no ENGINE binding is its own verdict, not an unreachable engine",
    featureOutcomeForError(await thrown(() => new Response(JSON.stringify({ error: ENGINE_BINDING_ABSENT }), { status: 503, headers: { "content-type": "application/json" } }))),
    "engine-binding-absent",
  );

  ok(
    "THE DISCRIMINATION TEST -- unreachable, wrong-address, unbuilt, broken and no-engine-binding are FIVE verdicts",
    new Set([
      featureOutcomeForError(await thrown(() => { throw new TypeError("Failed to fetch"); })),
      webHost404,
      realEngine404,
      featureOutcomeForError(await thrown(() => jsonAt(500))),
      featureOutcomeForError(await thrown(() => new Response(JSON.stringify({ error: ENGINE_BINDING_ABSENT }), { status: 503, headers: { "content-type": "application/json" } }))),
    ]).size === 5,
  );
}

// ---------------------------------------------------------------------------------------------------------
// The stale tab. THE ONE VERSION COMPARISON THE BROWSER CAN MAKE HONESTLY.
// ---------------------------------------------------------------------------------------------------------
async function g254(): Promise<void> {
  console.log("\n-- is this tab running the bundle its own origin serves? --");
  setActiveScreen("/updates");

  // Driven through the REAL recorder over the REAL served-version reader's classified result.
  const drive = async (running: string | null, served: { version: string | null; readClass: "ok" | "unreachable" | "non-json" | "unstamped" }): Promise<string | undefined> => {
    resetRing();
    await recordServedBundleSkew(recordConsoleSkew, async () => served, running);
    return rowsOf("console-skew")[0]?.skewClass;
  };

  eq("the tab runs exactly what the origin serves", await drive("0.1.10", { version: "0.1.10", readClass: "ok" }), "served-matches-running");
  eq("THE STALE TAB -- the origin has the new bundle and this browser is still running the old one", await drive("0.1.10", { version: "0.1.11", readClass: "ok" }), "served-newer-than-running");
  eq("the origin is serving an OLDER bundle than this tab loaded (a rolled-back asset deploy)", await drive("0.1.11", { version: "0.1.10", readClass: "ok" }), "served-older-than-running");
  eq("an Access page answering the console's OWN origin is not a stale asset", await drive("0.1.10", { version: null, readClass: "non-json" }), "origin-not-json");
  eq("the descriptor did not answer at all", await drive("0.1.10", { version: null, readClass: "unreachable" }), "origin-unreachable");
  eq("this bundle carries no stamp, which blinds every check above it", await drive(null, { version: "0.1.10", readClass: "ok" }), "running-unstamped");

  // A LEXICAL compare says 0.10.0 < 0.9.0, which would call a newer tab stale and send support to purge a CDN
  // that is serving exactly the right thing.
  eq("0.10.0 is AHEAD of 0.9.0 (a lexical compare gets this backwards)", skewClassFor("0.10.0", "0.9.0", "ok"), "served-older-than-running");
  // Both stamped, unequal, not comparable as dotted integers: the direction is NOT knowable and is not guessed.
  eq("a hash-stamped pair DIFFERS and its direction is not invented", skewClassFor("0.1.10-abc", "0.1.10-def", "ok"), "served-version-differs");

  // THE NOISE TEST, AND IT IS THE REASON THIS AXIS EXISTS. Comparing console-version against ENGINE-version
  // compares two independently incremented numbers from two separate repos: on a matched pair (console 0.1.10,
  // engine 0.1.9) that comparison reads "console-ahead" -- a fabricated fault in EVERY pack from EVERY healthy
  // customer. The origin serves what the origin serves, so a healthy console is `matched` here.
  eq("NOISE: a healthy console records the MATCHED row, not a fabricated skew", await drive("0.1.10", { version: "0.1.10", readClass: "ok" }), "served-matches-running");

  // REDACTION: the class rides, the version string does not.
  resetRing();
  await recordServedBundleSkew(recordConsoleSkew, async () => ({ version: "9.9.9", readClass: "ok" }), "1.2.3");
  const text = JSON.stringify(snapshot().records);
  ok("REDACTION: no version string reaches the ring through the class", !text.includes("9.9.9") && !text.includes("1.2.3"));
}

// ---------------------------------------------------------------------------------------------------------
// The generic globe. RECORDED AT THE RESOLUTION SITE, WHERE THE UNKNOWN PRESET STILL EXISTS.
// ---------------------------------------------------------------------------------------------------------
function g261(): void {
  console.log("\n-- a provider tile that turned into a generic globe --");
  setActiveScreen("/access/idp");

  // THE REAL PATH. An engine preset id this console build cannot resolve falls through keyFromId to null and
  // renders the neutral globe. A recorder placed at the RENDER site behind `MARKS[key] === undefined` would sit
  // behind a condition tsc proves unsatisfiable (MARKS is total over ProviderKey), and would exclude null --
  // which IS the drift case. Driving the real resolver is the only way to see that.
  for (const presetId of ["onelogin", "pingfederate", "authentik", "workos", "duo"]) {
    resetRing();
    const key = providerKey({ kind: "oidc", presetId });
    providerLogo(key); // the neutral globe, exactly as the grid renders it
    const skew = rowsOf("contract-skew");
    ok(`an unknown preset (${presetId}) records the drift`, skew.length === 1 && skew[0]?.contractClass === "unknown-enum-member" && skew[0]?.fieldFamily === "idp-preset");
  }

  // NOISE. A raw SAML connection does NOT resolve to null (kind "saml" returns "saml"), and neither does any
  // recognised vendor id. Those are legitimate states and must record nothing at all.
  for (const known of [{ kind: "saml" }, { kind: "oidc", presetId: "entra-oidc" }, { kind: "oauth2", presetId: "github-oauth2" }, { kind: "oidc", presetId: "okta" }]) {
    resetRing();
    providerLogo(providerKey(known as { kind?: string; presetId?: string }));
    eq(`NOISE: a recognised connection (${known.presetId ?? known.kind}) records nothing`, rowsOf("contract-skew").length, 0);
  }
  // A connection that names NO preset is the genuine no-preset case: nothing was asserted, so nothing is unknown.
  resetRing();
  providerLogo(providerKey({ kind: "oidc", presetId: "" }));
  eq("NOISE: a connection with no preset id at all records nothing", rowsOf("contract-skew").length, 0);

  // REDACTION: the unknown id could be operator-named. Only the two closed enums ride.
  resetRing();
  providerLogo(providerKey({ kind: "oidc", presetId: "acme-health-internal-idp" }));
  ok("REDACTION: the unrecognised preset id never reaches the ring", !JSON.stringify(snapshot()).includes("acme-health"));
  eq("...and the drift is still recorded", rowsOf("contract-skew").length, 1);
}

async function main(): Promise<void> {
  await g238();
  await g240();
  await g243();
  await g250();
  await g254();
  g261();
  console.log(failures === 0 ? "\nsupport posture gaps (console): all checks passed" : `\nsupport posture gaps (console): ${failures} FAILED`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

await main();
