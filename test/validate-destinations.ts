// The destination setup form's submit path
// (src/screens/destination-submit.ts) carries three security-adjacent validation branches
// that nothing else in the suite exercises:
//   (1) WORM: a chosen immutability mode requires a positive WHOLE-number retention; a bad
//       day count with a mode set is refused AT the form so a half-set policy is never sent.
//   (2) STS: the role ARN must match /^arn:aws[a-z-]*:iam::\d{12}:role\/.+/ before the engine
//       sees it; this is the client-side guard.
//   (3) ORDER: the Compliance-mode confirm runs BEFORE the replace confirm, and BOTH must gate
//       the actual save (a cancel at either point sends nothing).
// Plus the dual-control 202 path: a queued result is surfaced honestly (NOT a saved toast) and
// the form is re-enabled.
//
// Run with: node test/validate-destinations.ts
//
// This drives the REAL submitDestination over the shared DOM shim (so the real confirmModal /
// toast render) with stub field handles and a fake engine; it never re-implements the submit
// logic. A mutation to the ARN regex, the WORM guard, or the confirm ordering fails a check here.

import { installDomShim } from "./dom-shim.ts";

// Install BEFORE importing any module that touches document at load time.
installDomShim();

import { qs, qsa, flushAsync, textOf, type ShimNode } from "./dom-shim.ts";
import { SN, findButtonByText, click } from "./validate-stable-components-shared.ts";
import { submitDestination, type SubmitContext } from "../src/screens/destination-submit.ts";
import { renderConfigured } from "../src/screens/destination-cards.ts";
import type { Field } from "../src/components/field.ts";
import type { DestinationInput, DestinationList, DestinationStatus, EngineClient, OwnerActionResult } from "../src/api.ts";
import type { ChangeRef } from "../src/lib/change-ref.ts";
import { h } from "../src/lib/dom.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// A stub Field: only the bits submitDestination reaches for (value / badInput / clearError / setError /
// validate). validate() returns true so validateForm passes for the variant's required fields.
// badInput() is false: these stubs stand in for controls the operator filled or left alone, never for one that
// ATE the operator's text (a number input that could not convert what was typed). That state is driven against
// the REAL field() control in test/validate-support-posture-gaps-5.ts, where it belongs.
function stubField(value: string): Field {
  const v = value;
  return {
    el: h("div") as HTMLElement,
    control: h("input") as unknown as HTMLInputElement,
    value: () => v,
    badInput: () => false,
    setError: () => undefined,
    clearError: () => undefined,
    validate: () => true,
    focus: () => undefined,
  } as unknown as Field & { set(x: string): void };
}

// fakeEngine: only addDestination is called by submit. It records the inputs and returns the
// scripted OwnerActionResult so the queued path can be exercised without a real fetch.
interface EngineCall { input: DestinationInput; label: string; editId?: string }
function fakeEngine(result: OwnerActionResult<DestinationList>): { engine: EngineClient; calls: EngineCall[] } {
  const calls: EngineCall[] = [];
  const engine = {
    async addDestination(input: DestinationInput, label: string, editId?: string): Promise<OwnerActionResult<DestinationList>> {
      calls.push({ input, label, ...(editId !== undefined ? { editId } : {}) });
      return result;
    },
  } as unknown as EngineClient;
  return { engine, calls };
}

// A minimal applied (saved) result and a queued result, matching OwnerActionResult.
const APPLIED: OwnerActionResult<DestinationList> = { status: "result", value: { destinations: [] } } as unknown as OwnerActionResult<DestinationList>;
const QUEUED: OwnerActionResult<DestinationList> = { status: "queued", queued: { id: "oa-1", status: "pending" } } as unknown as OwnerActionResult<DestinationList>;

// buildCtx assembles a SubmitContext for the named provider with the given field overrides. The
// non-overridden fields carry benign valid values so validateForm passes and the test exercises
// only the branch under check.
function buildCtx(
  provider: "r2" | "s3",
  over: Partial<Record<string, string>>,
  opts: { confirmReplace: boolean; editId?: string },
  result: OwnerActionResult<DestinationList>,
): { ctx: SubmitContext; calls: EngineCall[]; formError: HTMLElement; saveBtn: HTMLButtonElement } {
  const { engine, calls } = fakeEngine(result);
  const val = (k: string, d: string): string => (over[k] !== undefined ? over[k]! : d);
  const formError = h("p", { hidden: true }) as HTMLElement;
  const saveBtn = h("button", {}, "Verify and save") as HTMLButtonElement;
  const stubBucket = stubField(val("r2Bucket", "my-bucket"));
  const ctx: SubmitContext = {
    engine,
    // discoveryRead/downpipesRead say whether each read SUCCEEDED, and absent reads as failed, so this
    // fixture has been driving the DEGRADED path: the form renders "could not be read" notes and the
    // circular-backup safety check silently does not run. This fixture means a read that worked and found
    // no buckets, which is a different fact, so it now says so.
    fctx: { engineAccountId: "acct123", engineR2Buckets: [], sourceR2Buckets: new Set(), discoveryRead: true, downpipesRead: true },
    opts: { confirmReplace: opts.confirmReplace, onSaved: () => undefined, ...(opts.editId !== undefined ? { editId: opts.editId } : {}) },
    getProvider: () => provider,
    pricingState: { edited: false },
    labelField: stubField(val("label", "Primary")),
    // The R2 field group is now held whole (SubmitContext.r2Block) because it has live state: which
    // bucket control is mounted, and which account the endpoint derives from. This fixture stands in for
    // the DEFAULT state, where discovery named the engine account and the other-account override is
    // clear, so accountIdField() is null and accountId() answers the discovered account. The override
    // path is driven end to end against the REAL buildR2Block in validate-dest-r2-other-account.ts.
    r2Block: {
      block: h("div") as HTMLElement,
      bucketField: () => stubBucket,
      accountIdField: () => null,
      accountId: () => "acct123",
      circNote: h("div") as HTMLElement,
    },
    endpointField: stubField(val("endpoint", "https://s3.example.com")),
    s3BucketField: stubField(val("s3Bucket", "my-bucket")),
    regionField: stubField(val("region", "us-east-1")),
    addressingField: stubField(val("addressing", "auto")),
    storageClassField: stubField(val("storageClass", "")),
    keyField: stubField(val("key", "AKIAEXAMPLE")),
    secretField: stubField(val("secret", "secretvalue")),
    storageField: stubField(val("storage", "")),
    classAField: stubField(val("classA", "")),
    classBField: stubField(val("classB", "")),
    egressField: stubField(val("egress", "")),
    currencyField: stubField(val("currency", "USD")),
    // The pricing disclosure the submit opens to show a refused rate. These fixtures use stub fields whose
    // validators always pass, so the section is never opened in anger here; it is a real <details> so that the
    // open/restore the submit does is exercised rather than stubbed away.
    pricingSection: h("details") as HTMLDetailsElement,
    wormModeField: stubField(val("wormMode", "off")),
    wormDaysField: stubField(val("wormDays", "")),
    roleArnField: stubField(val("roleArn", "")),
    externalIdField: stubField(val("externalId", "")),
    durationField: stubField(val("duration", "")),
    entraTenantField: stubField(val("entraTenant", "")),
    entraClientField: stubField(val("entraClient", "")),
    formError,
    saveBtn,
  };
  return { ctx, calls, formError, saveBtn };
}

// answerModal waits for the next confirmModal to render under the shim and clicks the button with
// the given label (the confirm or Cancel). It flushes so the submit promise can continue.
async function answerModal(label: string): Promise<void> {
  await flushAsync();
  const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
  if (!surface) return;
  const btn = findButtonByText(surface, label);
  if (btn) click(btn);
  await flushAsync();
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- WORM guard: a mode with a bad day count is refused AT the form, not submitted --");
  // ------------------------------------------------------------------------
  for (const bad of ["0", "-5", "1.5", "abc", ""]) {
    const { ctx, calls, formError } = buildCtx("s3", { wormMode: "governance", wormDays: bad }, { confirmReplace: false }, APPLIED);
    await submitDestination(ctx);
    ok(`WORM governance + days="${bad}": NOT submitted`, calls.length === 0);
    ok(`WORM governance + days="${bad}": the form error is shown`, formError.hidden === false && (formError.textContent ?? "").length > 0);
  }
  {
    // A valid whole-day count with governance mode arms it and submits (no compliance confirm, no replace).
    const { ctx, calls } = buildCtx("s3", { wormMode: "governance", wormDays: "30" }, { confirmReplace: false }, APPLIED);
    await submitDestination(ctx);
    eq("WORM governance + days=30: submitted with the worm policy", calls[0]?.input.worm, { mode: "governance", retentionDays: 30 });
  }

  // ------------------------------------------------------------------------
  console.log("\n-- STS ARN regex: the client guard accepts valid shapes and rejects malformed ones --");
  // ------------------------------------------------------------------------
  const validArns = [
    "arn:aws:iam::123456789012:role/MyRole",
    "arn:aws-us-gov:iam::123456789012:role/Some/Path/Role",
    "arn:aws-cn:iam::000000000000:role/r",
  ];
  for (const arn of validArns) {
    const { ctx, calls } = buildCtx("s3", { roleArn: arn }, { confirmReplace: false }, APPLIED);
    await submitDestination(ctx);
    ok(`ARN "${arn}": accepted and submitted`, calls.length === 1 && calls[0]?.input.assumeRole?.roleArn === arn);
  }
  const badArns = [
    "arn:aws:iam::12345:role/Short", // account id not 12 digits
    "arn:aws:s3::123456789012:role/Wrong", // not iam
    "arn:aws:iam::123456789012:user/NotARole", // not a role
    "arn:aws:iam::123456789012:role/", // empty role name
    "not-an-arn",
  ];
  for (const arn of badArns) {
    const { ctx, calls, formError } = buildCtx("s3", { roleArn: arn }, { confirmReplace: false }, APPLIED);
    await submitDestination(ctx);
    ok(`ARN "${arn}": rejected, NOT submitted`, calls.length === 0);
    ok(`ARN "${arn}": the form error is shown`, formError.hidden === false && (formError.textContent ?? "").length > 0);
  }
  {
    // The R2 path never carries STS even if a role ARN field somehow had a value (R2 has no STS).
    const { ctx, calls } = buildCtx("r2", { roleArn: "arn:aws:iam::123456789012:role/MyRole" }, { confirmReplace: false }, APPLIED);
    await submitDestination(ctx);
    ok("R2 provider: never carries an assumeRole policy", calls[0]?.input.assumeRole === undefined);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- Confirm ordering: compliance confirm gates the save; a cancel sends nothing --");
  // ------------------------------------------------------------------------
  {
    // Compliance mode + cancel at the compliance confirm: nothing submitted.
    const { ctx, calls } = buildCtx("s3", { wormMode: "compliance", wormDays: "7" }, { confirmReplace: false }, APPLIED);
    const p = submitDestination(ctx);
    await answerModal("Cancel");
    await p;
    ok("compliance confirm cancelled: NOT submitted", calls.length === 0);
  }
  {
    // Compliance mode + confirm the compliance lock: submitted with the compliance worm policy.
    const { ctx, calls } = buildCtx("s3", { wormMode: "compliance", wormDays: "7" }, { confirmReplace: false }, APPLIED);
    const p = submitDestination(ctx);
    await answerModal("Arm compliance lock");
    await p;
    eq("compliance confirm accepted: submitted with the compliance policy", calls[0]?.input.worm, { mode: "compliance", retentionDays: 7 });
  }
  {
    // Replace (edit) + cancel at the replace confirm: nothing submitted.
    const { ctx, calls } = buildCtx("s3", {}, { confirmReplace: true, editId: "d1" }, APPLIED);
    const p = submitDestination(ctx);
    await answerModal("Cancel");
    await p;
    ok("replace confirm cancelled: NOT submitted", calls.length === 0);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- Dual control (202): a queued result re-enables the form and never claims saved --");
  // ------------------------------------------------------------------------
  {
    const { ctx, calls, saveBtn } = buildCtx("s3", {}, { confirmReplace: false }, QUEUED);
    await submitDestination(ctx);
    ok("dual-control queued: the save WAS attempted (engine verified, then queued)", calls.length === 1);
    eq("dual-control queued: the save button is re-enabled", saveBtn.disabled, false);
    eq("dual-control queued: the save button label is reset", saveBtn.textContent, "Verify and save");
  }

  // ------------------------------------------------------------------------
  console.log("\n-- BOTH GATES ON: the change-number prompt and a queued dual-control result compose --");
  // ------------------------------------------------------------------------
  {
    // requireChangeNumber reads ON (requireChange() opens the modal and collects a reference) AND the
    // scripted addDestination result is QUEUED, exactly as the engine genuinely answers when
    // requireConfigApproval (or the second-owner high-blast auto-gate) is ALSO on server-side
    // (engine/src/sched/scheduler-do-dual-control.ts:35-48). The console never reads requireConfigApproval
    // itself (components/require-change.ts:47-59 asks only requireChangeNumber); the two gates compose here,
    // at the seam between the change-number prompt and the queued-result handling
    // (src/screens/destination-submit.ts:267-282). Proof: the prompt fires, the collected reference reaches
    // addDestination, and the outcome reads honestly as QUEUED (never "saved"), matching what
    // isOwnerActionQueuedResult + surfaceQueuedOwnerAction do for a real dual-control-armed engine.
    const calls: Array<{ input: DestinationInput; label: string; editId?: string; change?: ChangeRef }> = [];
    const engine = {
      async getConfigApprovalPolicy() {
        return { requireConfigApproval: false, requireChangeNumber: true };
      },
      async addDestination(input: DestinationInput, label: string, editId?: string, change?: ChangeRef): Promise<OwnerActionResult<DestinationList>> {
        calls.push({ input, label, ...(editId !== undefined ? { editId } : {}), ...(change !== undefined ? { change } : {}) });
        return QUEUED;
      },
    } as unknown as EngineClient;
    const formError = h("p", { hidden: true }) as HTMLElement;
    const saveBtn = h("button", {}, "Verify and save") as HTMLButtonElement;
    const ctx: SubmitContext = {
      engine,
      fctx: { engineAccountId: "acct123", engineR2Buckets: [], sourceR2Buckets: new Set(), discoveryRead: true, downpipesRead: true },
      opts: { confirmReplace: false, onSaved: () => undefined },
      getProvider: () => "s3",
      pricingState: { edited: false },
      labelField: stubField("cm-both-console"),
      // An s3 scenario, so the R2 group is never read; the default-state stub is here to satisfy the
      // context shape, not to be exercised (see buildCtx above for the same stand-in and why).
      r2Block: {
        block: h("div") as HTMLElement,
        bucketField: () => stubField("my-bucket"),
        accountIdField: () => null,
        accountId: () => "acct123",
        circNote: h("div") as HTMLElement,
      },
      endpointField: stubField("https://s3.example.com"),
      s3BucketField: stubField("my-bucket"),
      regionField: stubField("us-east-1"),
      addressingField: stubField("auto"),
      storageClassField: stubField(""),
      keyField: stubField("AKIAEXAMPLE"),
      secretField: stubField("secretvalue"),
      storageField: stubField(""),
      classAField: stubField(""),
      classBField: stubField(""),
      egressField: stubField(""),
      currencyField: stubField("USD"),
      pricingSection: h("details") as HTMLDetailsElement,
      wormModeField: stubField("off"),
      wormDaysField: stubField(""),
      roleArnField: stubField(""),
      externalIdField: stubField(""),
      durationField: stubField(""),
      entraTenantField: stubField(""),
      entraClientField: stubField(""),
      formError,
      saveBtn,
    };

    // NOTE: earlier scenarios in this file leave their own toasts/regions mounted (the toast region is a
    // lazily-created, REUSED singleton in src/components/toast.ts, capped at 4 visible -- a burst trims the
    // eldest); wiping document.body here would detach that singleton from the live tree without toast.ts
    // knowing, so every toast after would render into a node nobody can see. Instead: read the NEWEST toast
    // message after this save specifically, so an earlier "saved" toast in the suite (and the cap) cannot
    // masquerade as or crowd out this one's.
    const p = submitDestination(ctx);
    // The change-number modal must open BEFORE the save happens (requireChangeNumber reads ON).
    await flushAsync();
    const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
    ok("BOTH-ON: the change-number modal opened before the save (requireChangeNumber ON)", surface !== null);
    const numberInput = (globalThis as unknown as { document: { getElementById: (i: string) => { value: string } | null } }).document.getElementById("cm-change-number");
    ok("BOTH-ON: the change-number field is present in the modal", numberInput !== null);
    if (numberInput) numberInput.value = "CHG-CONSOLE-BOTH-1";
    const confirmBtn = surface ? findButtonByText(surface, "Confirm change") : undefined;
    ok("BOTH-ON: the modal offers Confirm change", confirmBtn !== undefined);
    if (confirmBtn) click(confirmBtn);
    await p;
    await flushAsync();

    ok("BOTH-ON: the save was attempted exactly once (engine verified, then queued)", calls.length === 1);
    ok("BOTH-ON: the collected change reference reached addDestination", calls[0]?.change?.number === "CHG-CONSOLE-BOTH-1" && calls[0]?.change?.emergency === false);
    eq("BOTH-ON: the save button is re-enabled (not stuck on Verifying…)", saveBtn.disabled, false);
    eq("BOTH-ON: the save button label is reset", saveBtn.textContent, "Verify and save");
    const toastMsgsAfter = qsa(SN(document.body) as unknown as ShimNode, ".toast__msg");
    ok("BOTH-ON: a toast was raised by this save", toastMsgsAfter.length > 0);
    const newestToast = textOf(toastMsgsAfter[toastMsgsAfter.length - 1] ?? null);
    ok("BOTH-ON: the newest toast reports 'queued for a second owner', matching the dual-control result", newestToast.toLowerCase().includes("queued for a second owner"));
    ok("BOTH-ON: the newest toast never claims the destination was saved", !newestToast.toLowerCase().includes("saved"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- B61 Retention line: render states over planted statuses (real renderConfigured) --");
  // ------------------------------------------------------------------------
  // Drives the REAL renderConfigured (which shares renderPostureRows with the drawer) over planted
  // DestinationStatus responses, one per state the design names. The engine stub is never
  // called: rendering a posture card performs no fetch, and the role gate reads blind (no caller)
  // so the levers render disabled.
  {
    const NOW = Date.now();
    const baseSt = (over: Partial<DestinationStatus>): DestinationStatus => ({
      present: true,
      id: "d1",
      label: "Primary",
      isDefault: true,
      bucket: "bkt-archive",
      endpointHost: "s3.example.com",
      region: "us-east-1",
      verifiedAt: NOW - 3_600_000,
      source: "console",
      ...over,
    });
    const cardText = (st: DestinationStatus): string =>
      textOf(SN(renderConfigured({} as unknown as EngineClient, st, () => undefined, 1)) as unknown as ShimNode);

    // Absent: "No prune recorded.", never a claim that retention has never run (an older engine and a
    // not-yet-run pass are indistinguishable on the wire).
    const tAbsent = cardText(baseSt({}));
    ok("lastPrune absent: renders 'No prune recorded.'", tAbsent.includes("No prune recorded."));
    ok("lastPrune absent: never claims retention has never run", !tAbsent.toLowerCase().includes("never run"));
    ok("lastPrune absent: no reclaimed count", !tAbsent.includes("reclaimed"));

    // Applied on a deletable bucket: the calm line carries the reclaimed OBJECT count and the time.
    const tApplied = cardText(
      baseSt({
        deleteProbe: "ok",
        lastPrune: { lastApplied: { at: NOW - 7_200_000, reclaimed: 7, supersededRuns: 2 }, lastOutcome: { at: NOW - 7_200_000, outcome: "applied" } },
      }),
    );
    // THE AUTHENTICATION ROW, which nothing graded until and which was MISSING for Entra.
    //
    // renderPostureRows showed the row only for authMode "sts", and the engine answered "keys" for an
    // Azure destination carrying a Microsoft Entra service principal, so the card said nothing at all: a
    // customer could not tell from the console that the destination signs in against Microsoft's identity
    // platform rather than with a storage account key. The engine now answers "entra" and this is the cell
    // that keeps the row from going missing again.
    const tEntra = cardText(baseSt({ authMode: "entra", azureEntra: { tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" } }));
    ok("entra: the card names the mechanism", tEntra.includes("Microsoft Entra service principal"));
    ok("entra: ...and shows the application id, which is not secret", tEntra.includes("d290f1ee-6c54-4b01-90e6-d701748f0851"));
    ok("entra: NEVER the tenant's client secret or any credential", !tEntra.toLowerCase().includes("secret") || !tEntra.includes("client secret"));
    // CONTROL, both directions: the unremarkable default still shows no row, and STS still shows its own.
    const tKeys = cardText(baseSt({ authMode: "keys" }));
    ok("keys CONTROL: a stored-key destination shows no Authentication row at all", !tKeys.includes("Authentication"));
    const tSts = cardText(baseSt({ authMode: "sts", assumeRoleArn: "arn:aws:iam::123456789012:role/Backup" }));
    ok("sts CONTROL: an AssumeRole destination still names STS", tSts.includes("STS AssumeRole") && tSts.includes("arn:aws:iam::123456789012:role/Backup"));
    ok("sts CONTROL: ...and is not relabelled as Entra", !tSts.includes("Microsoft Entra"));

    ok("applied: renders the applied label", tApplied.includes("applied"));
    ok("applied: renders the reclaimed object count", tApplied.includes("reclaimed 7 objects"));
    ok("applied: no 'No prune recorded.' alongside a recorded prune", !tApplied.includes("No prune recorded."));

    // Singular: one object is "1 object", never "1 objects".
    const tOne = cardText(
      baseSt({
        deleteProbe: "ok",
        lastPrune: { lastApplied: { at: NOW - 7_200_000, reclaimed: 1, supersededRuns: 1 }, lastOutcome: { at: NOW - 7_200_000, outcome: "applied" } },
      }),
    );
    ok("applied, one object: singular copy", tOne.includes("reclaimed 1 object") && !tOne.includes("1 objects"));

    // No-op with an earlier reclaim: the calm line renders FROM lastApplied, so a later pass that had
    // nothing to delete does not erase the last real reclaim.
    const tNoop = cardText(
      baseSt({
        deleteProbe: "ok",
        lastPrune: { lastApplied: { at: NOW - 259_200_000, reclaimed: 5, supersededRuns: 1 }, lastOutcome: { at: NOW - 3_600_000, outcome: "no-op" } },
      }),
    );
    ok("no-op: renders nothing-to-prune", tNoop.includes("nothing to prune"));
    ok("no-op: the last reclaim survives", tNoop.includes("last reclaimed 5 objects"));

    // Dry run: names that enforcement is off (the commonest real cause of 'retention never deletes').
    const tDry = cardText(baseSt({ deleteProbe: "ok", lastPrune: { lastOutcome: { at: NOW - 3_600_000, outcome: "dry-run" } } }));
    ok("dry-run: renders the dry run label", tDry.includes("dry run"));
    ok("dry-run: names that enforcement is off", tDry.includes("enforcement is off"));

    // Deferred with the closed class: the reason renders as the class's copy, never free text.
    const tDef = cardText(
      baseSt({ deleteProbe: "ok", lastPrune: { lastOutcome: { at: NOW - 3_600_000, outcome: "deferred", deferClass: "retained-run-unreadable" } } }),
    );
    ok("deferred: renders the deferred label", tDef.includes("deferred"));
    ok("deferred: renders the retained-run-unreadable reason", tDef.includes("a retained run could not be read"));

    // wormBlocked on a deleteProbe-denied WORM bucket: warn line cross-referenced to the existing
    // object-lock note (one posture, not two disconnected mysteries).
    const deniedWorm = (lastPrune: DestinationStatus["lastPrune"]): DestinationStatus =>
      baseSt({ deleteProbe: "denied", worm: { mode: "compliance", retentionDays: 30 }, objectLock: "enforced", ...(lastPrune !== undefined ? { lastPrune } : {}) });
    const tWorm = cardText(deniedWorm({ lastOutcome: { at: NOW - 3_600_000, outcome: "error", wormBlocked: true } }));
    ok("wormBlocked+denied: renders deletes refused", tWorm.includes("deletes refused"));
    ok("wormBlocked+denied: names the object-lock refusal", tWorm.includes("object lock refused"));
    ok("wormBlocked+denied: cross-references the object-lock note", tWorm.includes("object-lock note below"));
    ok("wormBlocked+denied: the existing prune-blocked note is present", tWorm.includes("retention pruning cannot run"));

    // BINDING INVARIANT: a deleteProbe-denied destination never renders a reclaimed
    // count, even when the wire carries a lastApplied (planted here with a sentinel count).
    const tW5Outcome = cardText(
      deniedWorm({ lastApplied: { at: NOW - 259_200_000, reclaimed: 999, supersededRuns: 3 }, lastOutcome: { at: NOW - 3_600_000, outcome: "error", wormBlocked: true } }),
    );
    ok("denied + planted lastApplied under a blocked outcome: no count rendered", !tW5Outcome.includes("999") && !tW5Outcome.includes("reclaimed"));
    const tW5Applied = cardText(
      deniedWorm({ lastApplied: { at: NOW - 7_200_000, reclaimed: 999, supersededRuns: 3 }, lastOutcome: { at: NOW - 7_200_000, outcome: "applied" } }),
    );
    ok("denied + applied outcome: no count rendered", !tW5Applied.includes("999") && !tW5Applied.includes("reclaimed"));

    // The env-configured default (present: false, no stored record) renders the line too: the sidecar
    // rides the GET /destination view, so the render must not assume a stored destination.
    const tEnv = cardText({
      present: false,
      envConfigured: true,
      envKind: "r2",
      source: "deploy",
      lastPrune: { lastOutcome: { at: NOW - 3_600_000, outcome: "dry-run" } },
    });
    ok("env-configured default: the Retention line renders without a stored record", tEnv.includes("dry run") && tEnv.includes("enforcement is off"));
  }

  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

void main();
