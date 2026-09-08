// The destination form's submit path, split out of destinations.ts so the screen file
// stays a thin wiring layer (guardrail: function size). submitDestination validates the
// visible variant, assembles the DestinationInput, names the irreversible/replace
// consequences before the save, and POSTs it. Behaviour is identical to the previous
// inline submit(): this module MOVES the logic verbatim, it does not rewrite it.
//
// No-custody invariants kept: the secret access key is read once at submit and never
// echoed back; a refusal surfaces verbatim AT the form and keeps every value in place.

import { recordFormRefused } from "../lib/client-diag/ring.ts";
import { refusalText } from "../components/error-view.ts";
import type { ClientDiagFormField } from "../lib/client-diag/vocab.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { validateForm } from "../components/field.ts";
import { confirmModal } from "../components/modal.ts";
import { requireChange } from "../components/require-change.ts";
import { toast } from "../components/toast.ts";
import { surfaceQueuedOwnerAction } from "../lib/pending-change-toast.ts";
import { isOwnerActionQueuedResult } from "../api.ts";
import type { DestinationInput, DestinationPricing, EngineClient, StorageClass, WormStatus } from "../api.ts";
import { providerPricing, r2Endpoint, type DestinationFormOpts, type FieldHandle, type FormContext, type Provider, type R2Block } from "./destination-form-fields.ts";

// MIRRORS engine/src/dest/factory-validators.ts:237, :243 and :249. Duplicated with the citation because
// there is no way to import a regex across the two repos, and a console that drifted from these would
// either refuse a principal the engine accepts or accept one it refuses.
const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_TENANT_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const ENTRA_MULTI_TENANT_ALIASES: ReadonlySet<string> = new Set(["common", "organizations", "consumers"]);

// SubmitContext is the form state submitDestination reads: the engine, the form context,
// the option bag, every field handle, the live provider getter, the pricing-edited flag,
// and the error slot + save button it drives.
export interface SubmitContext {
  engine: EngineClient;
  fctx: FormContext;
  opts: DestinationFormOpts;
  getProvider: () => Provider;
  pricingState: { edited: boolean };
  labelField: FieldHandle;
  // The R2 field group, held WHOLE rather than as two handles snapshotted at build time. The block has
  // two live states (the account the endpoint derives from, and which bucket control is mounted), so a
  // value captured once here could not follow them: that is precisely how the endpoint came to be the
  // engine account's no matter what the operator asked for.
  r2Block: R2Block;
  endpointField: FieldHandle;
  s3BucketField: FieldHandle;
  regionField: FieldHandle;
  addressingField: FieldHandle;
  storageClassField: FieldHandle;
  keyField: FieldHandle;
  secretField: FieldHandle;
  storageField: FieldHandle;
  classAField: FieldHandle;
  classBField: FieldHandle;
  egressField: FieldHandle;
  currencyField: FieldHandle;
  // The pricing disclosure itself, held so a refused rate can be SHOWN. The four rate controls live inside a
  // collapsed <details>, and validateForm's focus lands nowhere inside a closed one: an error painted there
  // would be a save that does nothing with no visible reason, which is a worse form than the one being fixed.
  pricingSection: HTMLDetailsElement;
  wormModeField: FieldHandle;
  wormDaysField: FieldHandle;
  roleArnField: FieldHandle;
  externalIdField: FieldHandle;
  durationField: FieldHandle;
  entraTenantField: FieldHandle;
  entraClientField: FieldHandle;
  formError: HTMLElement;
  saveBtn: HTMLButtonElement;
}

// readPricing reads the storage pricing from the (prefilled, possibly edited) rate fields. EXPORTED so the
// validator can drive the REAL coercion path over REAL field handles, rather than calling the recorder by hand
// with a literal class (which proves the ring can carry the class, never that this form can produce it).
// Always returned so every destination carries rates the cost screen can use; a blank field
// falls back to the provider preset. The source flag records whether the operator edited it.
//
// IT RETURNS THE COERCED FIELDS AND IT RECORDS NOTHING. The list is the reader's OWN answer to "would this save
// carry a rate the operator did not choose", stated independently of the field rule that now refuses at submit,
// so the suite can hold the two against each other. If they ever disagree -- a value the field waves through
// that this reader still swaps -- the silent substitution is back, and a test that drove only one of them could
// not see it. That is the shape of fault this console has shipped before: a submit gate looser than the field.
//
// It is EMPTY on every save that lands, and that is now a property of the product rather than a hope: the four
// rate controls carry nonNegativeRate, submitDestination runs it before anything is built or sent, and the field
// rule refuses a strict superset of what this reader swaps (it also refuses "1e3" and "0x10", which Number()
// would take). Nothing downstream may treat a non-empty list as an ordinary state.
export function readPricing(ctx: SubmitContext, provider: Provider): { pricing: DestinationPricing; coerced: ClientDiagFormField[] } {
  const pp = providerPricing(provider);
  // THE SILENT COERCION THIS READER USED TO PERFORM UNANSWERED. A rate that does not parse (a typed
  // currency symbol, a thousands separator, a comma decimal) was quietly replaced with the vendor PRESET, the
  // save succeeded, and every cost estimate the customer was shown from then on was computed against a rate they
  // did not choose. They saw no error, so they did not report a rejection: they reported "cost estimates ignore
  // the contracted rate I entered", weeks later. The engine could not help, because it was sent the preset and
  // stored it faithfully -- AND it was sent `source: "operator"` alongside, so the stored record positively
  // asserted the preset was the customer's own contracted rate. Only the browser ever knew.
  //
  // The remedy is not a better record of it. submitDestination now runs the console's own rule on these four
  // controls before anything is built or sent, so the substitution cannot reach a save at all; what survives
  // here is the fallback for the box the operator deliberately LEFT EMPTY, which is the ordinary
  // "use the vendor's published rate" choice and always was. The typed value is customer commercial data and is
  // never recorded; the catalogue field id is.
  //
  // THE COERCION USED TO BE UNRECORDABLE, AND THE REASON IS THE HTML SPEC. The rate controls are
  // <input type="number">, and the value-sanitisation algorithm makes .value return the EMPTY STRING for any
  // content that is not a valid floating-point number. So EVERY example named above -- "$0.015", "0,015",
  // "1,234.5" -- reached this reader as "" and took the empty-box path, one line below, which returns the preset
  // in silence because an empty box IS the ordinary "use the preset" choice. The two states the gap exists to
  // separate ("I typed my contracted rate and the estimates ignore it" versus "I left it blank") produced the
  // same evidence: none. Number(t) on a NON-empty value from a number input is always a finite float, so the
  // !Number.isFinite branch could not fire either, and the only reachable coercion was a negative rate.
  //
  // validity.badInput is the one signal that survives the sanitisation: it is the control saying it could not
  // convert what the operator typed. The value itself is gone by then, which is precisely why this row can carry
  // a catalogue field id and a count and no customer commercial data whatsoever.
  const coerced: ClientDiagFormField[] = [];
  const num = (f: FieldHandle, fallback: number, field: ClientDiagFormField): number => {
    const t = f.value();
    if (t === "") {
      if (f.badInput()) coerced.push(field);
      return fallback; // an empty box the operator LEFT empty is the ordinary "use the preset" choice, not a coercion.
    }
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0) return n;
    coerced.push(field); // a negative rate: the other reachable coercion.
    return fallback;
  };
  const pricing: DestinationPricing = {
    storagePerGBMonth: num(ctx.storageField, pp.storagePerGBMonth, "dest-price-storage"),
    classAPerMillion: num(ctx.classAField, pp.classAPerMillion, "dest-price-classa"),
    classBPerMillion: num(ctx.classBField, pp.classBPerMillion, "dest-price-classb"),
    egressPerGB: num(ctx.egressField, pp.egressPerGB, "dest-price-egress"),
    currency: ctx.currencyField.value().trim() || "USD",
    source: ctx.pricingState.edited ? "operator" : "preset",
  };
  return { pricing, coerced };
}

// buildDestinationInput assembles the DestinationInput from the validated fields and the
// already-parsed pricing / worm / assumeRole policies. Pure value construction: the R2 path
// derives the endpoint from the account id and fixes the region to auto; the S3 path carries
// the explicit endpoint/region plus the optional addressing and storage-class overrides only
// when set (so an auto destination stays byte-identical).
export function buildDestinationInput(
  ctx: SubmitContext,
  provider: Provider,
  pricing: DestinationPricing,
  worm: WormStatus | undefined,
  assumeRole: { roleArn: string; externalId?: string; durationSeconds?: number } | undefined,
  azureEntra: { tenantId: string; clientId: string } | undefined,
): DestinationInput {
  return provider === "r2"
    ? {
        // The R2 block answers which account this destination is for: the typed Account ID when the
        // operator asked for a different one (or discovery could never name the engine account), else the
        // discovered engine account. It is asked LIVE, at submit, so a mid-form change is honoured; the
        // old code read `fctx.engineAccountId ?? accountIdField.value()`, which could only ever answer the
        // engine account once discovery had named it.
        endpoint: r2Endpoint(ctx.r2Block.accountId()),
        bucket: ctx.r2Block.bucketField().value(),
        region: "auto",
        accessKeyId: ctx.keyField.value(),
        secretAccessKey: ctx.secretField.value(),
        pricing,
        ...(worm ? { worm } : {}),
      }
    : {
        endpoint: ctx.endpointField.value(),
        bucket: ctx.s3BucketField.value(),
        region: ctx.regionField.value() === "" ? "auto" : ctx.regionField.value(),
        accessKeyId: ctx.keyField.value(),
        secretAccessKey: ctx.secretField.value(),
        pricing,
        ...(worm ? { worm } : {}),
        ...(assumeRole ? { assumeRole } : {}),
        // azureEntra rides the same "only when set" rule as assumeRole: an Azure destination
        // authenticating with an account key or a SAS sends no principal at all and stays byte-identical
        // to one saved before this block existed. Clearing both boxes clears a stored principal, which is
        // how an operator moves a destination back off Entra without deleting it.
        ...(azureEntra ? { azureEntra } : {}),
        // Send addressing only when it is NOT the default "auto", so an auto destination is
        // byte-identical and changing back to auto clears any stored override.
        // NEVER for Azure Blob, which has one URL form and no addressing to choose; the engine refuses
        // this field for an Azure endpoint by name. Guarded here for the same reason the storage class is
        // below: the control is hidden for Azure, and hiding a control does not CLEAR it, so a value left
        // behind by a provider SWITCH would otherwise be submitted and refused for a field the operator
        // can no longer see.
        ...(provider !== "azure" && (ctx.addressingField.value() === "path" || ctx.addressingField.value() === "vhost") ? { addressing: ctx.addressingField.value() as "path" | "vhost" } : {}),
        // storage class only when chosen (not "Bucket default"); the engine rejects unsupported tiers.
        // NEVER for Google Cloud Storage, which does not accept Amazon's class names at all (it answers
        // 400 InvalidStorageClass), and never for Azure Blob Storage, which has access tiers rather than
        // storage classes and no translation between them. The engine refuses this field for both by name.
        // The field is already hidden for each, and this guard is what stops a value left behind by a
        // provider SWITCH from being submitted anyway: hiding a control does not clear it, and the operator
        // would then be refused for a field they cannot see.
        ...(provider !== "gcs" && provider !== "azure" && ctx.storageClassField.value() !== "" ? { storageClass: ctx.storageClassField.value() as StorageClass } : {}),
      };
}

// submitDestination validates the visible variant, assembles the DestinationInput (with
// the pricing, immutability and STS policies, each refused at the form when half-set so
// the engine never sees an invalid one), names the irreversible/replace consequences
// before the save, and POSTs it. A refusal surfaces verbatim AT the form and keeps every
// value in place; a queued result says so honestly (nothing stored until a second owner
// approves). Behaviour is identical to the previous inline submit().
export async function submitDestination(ctx: SubmitContext): Promise<void> {
  const { engine, opts, formError, saveBtn } = ctx;
  const provider = ctx.getProvider();
  formError.hidden = true;
  const fields =
    provider === "r2"
      ? [ctx.r2Block.bucketField(), ...(ctx.r2Block.accountIdField() ? [ctx.r2Block.accountIdField()!] : []), ctx.keyField, ctx.secretField]
      : [ctx.endpointField, ctx.s3BucketField, ctx.regionField, ctx.keyField, ctx.secretField];
  if (!validateForm(fields)) return;

  // RUN THE CONSOLE'S OWN RULE ON THE RATES, WHICH NO SUBMIT PATH RAN. The four rate controls have carried
  // nonNegativeRate since they were built, and nothing ever called it: the rules only ran on blur, and a blur is
  // not a save. So an operator who typed "$0.0123" was told "Destination verified and saved" over a stored
  // storagePerGBMonth of 0.015 -- Cloudflare's list price -- labelled `source: "operator"`.
  //
  // The refusal is not a cost to the customer's setup, which is the objection worth answering: this block is
  // optional, backups never read it, and CLEARING the box is the documented way to take the vendor's published
  // rate. So the escape hatch is one keystroke and the message names it. What refusing buys is that the rate the
  // operator typed is treated as something they meant, rather than discarded in silence.
  //
  // The section is OPENED FIRST because validateForm focuses the first invalid control and a focus into a closed
  // <details> lands nowhere; it is put back when the rates are fine, so an ordinary save never expands a section
  // the operator had collapsed.
  const pricingWasOpen = ctx.pricingSection.open;
  ctx.pricingSection.open = true;
  if (!validateForm([ctx.storageField, ctx.classAField, ctx.classBField, ctx.egressField])) {
    formError.textContent = "A storage-pricing rate could not be read, so nothing was saved. Type it as a plain number with no currency symbol or thousands separator, for example 0.015, or clear the box to use the vendor's published rate.";
    formError.hidden = false;
    return;
  }
  ctx.pricingSection.open = pricingWasOpen;

  const { pricing } = readPricing(ctx, provider);

  // Immutability policy: "off" omits it; a mode plus a positive whole-day count arms it. An invalid day
  // count with a mode chosen is refused at the form (the engine would reject it too) so a half-set policy
  // is never sent.
  //
  // NO PROVIDER IS EXCLUDED HERE, AND TWO WERE. Google Cloud Storage was excluded until on the
  // belief that it has no S3 Object Lock, and Azure Blob Storage until the same day on the belief that its
  // unlocked-or-locked policy plus legal hold could not be mapped onto one mode and one window.
  // Measurement refuted both: a GCS bucket created with per-object retention answers the engine's
  // Object-Lock probe Enabled and honours a compliance lock, and an Azure container with version-level
  // immutability enforces a policy where governance maps to unlocked and compliance to locked. Both are
  // now offered on the form and submitted like any other provider.
  //
  // The policy is sent for R2 as well, and it is the ENGINE that refuses it: R2 over its S3
  // endpoint answers 501 NotImplemented to x-amz-object-lock-mode, so the probe reads a definite cannot
  // and the save is refused rather than accepted into a destination that could never hold a lock. The form
  // says so before the operator gets there (WORM_PREREQ_COPY in destination-form-fields.ts). What it does
  // not do is second-guess the probe, which is the only authority on what a bucket actually enforces, and
  // which was right about both providers above while the rules written on top of it were wrong.
  const wormMode = ctx.wormModeField.value();
  let worm: WormStatus | undefined;
  if (wormMode === "governance" || wormMode === "compliance") {
    const wormDaysRaw = ctx.wormDaysField.value().trim();
    const days = Number(wormDaysRaw);
    if (!Number.isInteger(days) || days <= 0) {
      // "I am blocked configuring WORM" is a real, recurring ticket, and the block happens HERE, in the
      // browser, so the engine never hears of it. A customer who cannot arm immutability believes their archive
      // is immutable and it is not: this is a posture refusal, not a cosmetic one.
      //
      // THE EMPTY BOX TOOK THIS BRANCH AND WROTE THE SAME ROW. Number("") is 0, which fails `days <=
      // 0`, so an operator who picked a mode and pressed Save before typing a number was recorded as a refusal
      // over a value that never existed -- byte-identical to the refusal this member is for ("our day-count rule
      // is tighter than Object-Lock's"). The raw value now goes to the recorder, which writes nothing when it is
      // empty; the operator still sees the message, and the form still refuses to send a half-set policy.
      recordFormRefused("dest-worm-days", wormDaysRaw);
      formError.textContent = "Immutability is on, so enter a retention of a whole number of days greater than zero (or set the mode to Off).";
      formError.hidden = false;
      return;
    }
    worm = { mode: wormMode, retentionDays: days };
  }

  // STS AssumeRole (AWS S3 only): a role ARN turns the keys above into the assume-role principal. The ARN
  // shape and the optional duration are validated at the form so a half-set policy is never sent; the R2
  // path never carries it (R2 has no STS, and its region is "auto", not a valid STS region).
  let assumeRole: { roleArn: string; externalId?: string; durationSeconds?: number } | undefined;
  if (provider === "s3") {
    const roleArn = ctx.roleArnField.value().trim();
    if (roleArn !== "") {
      if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(roleArn)) {
        // "I am blocked configuring STS". The ARN pattern is enforced HERE and nowhere the engine can see,
        // so a customer whose ARN this regex refuses (a partition or a path the pattern does not admit) is stuck
        // at the form with no remote trace. The ARN itself is an account identifier and is never recorded.
        recordFormRefused("dest-role-arn", roleArn); // non-empty by the branch above; the recorder re-checks anyway
        formError.textContent = "The role ARN looks wrong. It should look like arn:aws:iam::123456789012:role/YourRole, or leave it blank to use the keys directly.";
        formError.hidden = false;
        return;
      }
      const externalId = ctx.externalIdField.value().trim();
      const durRaw = ctx.durationField.value().trim();
      const dur = durRaw === "" ? undefined : Number(durRaw);
      if (dur !== undefined && (!Number.isInteger(dur) || dur < 900 || dur > 43200)) {
        recordFormRefused("dest-sts-duration", durRaw); // As above: refused in the browser, invisible to the engine.
        formError.textContent = "The STS session duration must be a whole number of seconds between 900 and 43200, or leave it blank for the default.";
        formError.hidden = false;
        return;
      }
      // Under STS AssumeRole the region must be the role's real AWS region; the field pre-fills "auto"
      // (the R2/keyless default), which is not a valid STS region, so mirror the engine's VALID_STS_REGION
      // (sts.ts) here and refuse it inline rather than drawing a late engine 400 the customer cannot diagnose.
      const stsRegion = ctx.regionField.value().trim();
      if (!/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(stsRegion)) {
        // (No recordFormRefused row: "dest-region" is not in the shared client-diag vocabulary the engine's
        // support-pack ingest recognises, and adding it there is an engine change. The inline refusal below is
        // the fix; the pack telemetry for this specific refusal is blocked on the engine-side vocab change.)
        formError.textContent = "Under STS AssumeRole the region must be the role's real AWS region, for example us-east-1, not auto.";
        formError.hidden = false;
        return;
      }
      assumeRole = { roleArn, ...(externalId !== "" ? { externalId } : {}), ...(dur !== undefined ? { durationSeconds: dur } : {}) };
    }
  }

  // THE MICROSOFT ENTRA SERVICE PRINCIPAL, Azure Blob only, optional, and BOTH IDS OR NEITHER.
  //
  // The engine refuses a half-set principal rather than dropping it, on the reasoning it records at
  // router-destinations.ts:78-83: a dropped one stores a destination that answers 200, reports itself
  // verified, and then tries to use the client secret as a storage account key on every write. The form
  // mirrors the refusal so the operator is told at the point they can fix it, and the engine still refuses
  // independently, because a browser check is a convenience and never the boundary.
  //
  // The shapes are the engine's own (factory-validators.ts:237, :243, :249), copied with their citation
  // rather than loosened: a console that accepted a wider shape would let a save through that the write
  // boundary then rejects with a 400 the operator cannot act on from here.
  let azureEntra: { tenantId: string; clientId: string } | undefined;
  if (provider === "azure") {
    const tenantId = ctx.entraTenantField.value().trim();
    const clientId = ctx.entraClientField.value().trim();
    if (tenantId !== "" || clientId !== "") {
      if (tenantId === "" || clientId === "") {
        formError.textContent =
          "A Microsoft Entra service principal needs both the Directory (tenant) ID and the Application (client) ID. Fill both, or clear both to authenticate with the storage account key or a SAS token instead.";
        formError.hidden = false;
        return;
      }
      if (ENTRA_MULTI_TENANT_ALIASES.has(tenantId.toLowerCase())) {
        formError.textContent = `A destination has to name ONE directory, so the tenant cannot be "${tenantId}": a service principal signs in to a specific tenant. Use the Directory (tenant) ID from the app registration's overview page.`;
        formError.hidden = false;
        return;
      }
      if (!ENTRA_GUID.test(tenantId) && !ENTRA_TENANT_DOMAIN.test(tenantId)) {
        formError.textContent = "The Directory (tenant) ID must be a GUID (8-4-4-4-12 hex) or a verified domain such as contoso.onmicrosoft.com. Copy it from the app registration's overview page.";
        formError.hidden = false;
        return;
      }
      if (!ENTRA_GUID.test(clientId)) {
        formError.textContent = "The Application (client) ID must be a GUID (8-4-4-4-12 hex). Copy it from the app registration's overview page.";
        formError.hidden = false;
        return;
      }
      azureEntra = { tenantId, clientId };
    }
  }

  const input = buildDestinationInput(ctx, provider, pricing, worm, assumeRole, azureEntra);

  // Compliance mode is irreversible: once written, an object is undeletable until its window passes, by
  // anyone, however privileged. Name that consequence before the save, distinct from governance.
  //
  // "your account root" is what this used to say, and it is Amazon's word for the most privileged principal
  // there. This form now offers immutability for Google Cloud and Azure Blob Storage too, where the
  // equivalent principal is a project owner, an organisation administrator or a subscription owner and no
  // "account root" exists to look for, so the sentence names the property rather than one vendor's name for
  // it. The property is the same either way: a compliance lock is above every principal the store has.
  if (worm?.mode === "compliance") {
    const okc = await confirmModal({
      title: `Lock every archive object for ${worm.retentionDays} days?`,
      body: "Compliance mode cannot be shortened or removed by anyone, however privileged, until each object's window passes. A wrong retention cannot be undone. Governance mode gives the same immutability but lets a privileged principal override it. You may be asked to confirm with your own passkey before the destination is saved. If you dismiss that prompt, or it fails, nothing is saved and you can start again.",
      confirmLabel: "Arm compliance lock",
    });
    if (!okc) return;
  }

  // Editing an existing destination names its consequence BEFORE the save; a dismiss keeps the
  // form untouched. A brand-new add has nothing to replace, so it saves straight away.
  if (opts.confirmReplace) {
    const okd = await confirmModal({
      title: "Replace this destination's credentials?",
      body: "Runs so far stay in the current bucket; restoring them later needs that bucket reachable. New runs to this destination write with the new credentials from the next tick. You may be asked to confirm with your own passkey before the destination is saved. If you dismiss that prompt, or it fails, nothing is saved and you can start again.",
      confirmLabel: "Replace credentials",
    });
    if (!okd) return;
  }

  // Change management (owner opt-in): adding or editing a destination repoints where backups land, a
  // change-controlled action. Collect a change reference when the policy requires one (a no-op otherwise),
  // after the consequence confirmations above; a cancel keeps the form untouched.
  const cr = await requireChange(engine, opts.editId ? "Update this destination" : "Add a destination", "destination-upsert");
  if (!cr.proceed) return;

  saveBtn.disabled = true;
  saveBtn.textContent = "Verifying";
  try {
    const res = await engine.addDestination(input, ctx.labelField.value().trim(), opts.editId, cr.change ?? undefined);
    // Dual control armed: the engine verified the destination but QUEUED the save for a second owner
    // instead of applying it. Say so honestly (NOT "saved / updated"): nothing is stored until the
    // second owner approves. Reset the button so the form is usable again.
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction(opts.editId ? "Updating this destination" : "Saving this destination");
      saveBtn.disabled = false;
      saveBtn.textContent = "Verify and save";
      return;
    }
    // NOTHING IS RECORDED HERE, BECAUSE THERE IS NOTHING LEFT TO RECORD. `coerced` is empty on every save
    // that reaches this line: the rate rule ran at the top of this function and refused the save outright, so a
    // rate the number input ate can no longer be persisted as the vendor preset. The row that used to be written
    // here said the save SUCCEEDED and the estate was now running on a rate the operator did not choose, and
    // that state no longer exists.
    //
    // The evidence did not go with it, which was the risk in fixing this. The refusal is recorded instead, by
    // the field() funnel, as `rejected` on the same catalogue control id -- and it only survives because
    // recordFormRefused now reads validity.badInput: on a control the browser emptied, the raw value is "" and
    // the emptiness rule would otherwise have dropped the one refusal it was never meant to drop. The ticket
    // moves from "cost estimates ignore the contracted rate I entered", found weeks later, to "the form will not
    // take my rate", found at the form, with a row for it either way.
    //
    // The assertion is kept, not assumed: `coerced` is still computed and the suite drives every state that
    // reaches a save and holds it empty, because it is the reader's own answer and it is stated independently of
    // the rule above.
    toast({ message: opts.editId ? "Destination verified and updated." : "Destination verified and saved. Backups now have a home." });
    opts.onSaved();
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: nothing was saved, so the form must not be left reading "Verifying".
      saveBtn.disabled = false;
      saveBtn.textContent = "Verify and save";
      return goSignedOut();
    }
    // The engine's refusal is specific and actionable (which probe failed, the
    // platform's status); surface it verbatim and keep every value in place.
    formError.textContent = errMsg(err);
    formError.hidden = false;
    saveBtn.disabled = false;
    saveBtn.textContent = "Verify and save";
  }
}

// errMsg is the FIRST refusal a new customer ever reads: the destination is step 2 of setup and
// nothing can run until it saves, so a wrong access key or a bucket that does not exist is a
// first-hour certainty rather than an edge case.
//
// It used to return err.message, which is the transport's throw and not a sentence. Driven against
// the real submit path, an engine refusal reached the form as
//   "add destination: the store rejected the credentials (SignatureDoesNotMatch)...: 400"
// with the wire verb on the front and the status glued past the full stop, and a refusal the engine
// did not explain reached it as "add destination: 400", which names nothing to change. A 403 the
// transport had already classified as not-an-engine-refusal reached it as the raw internal token
// "forbidden-class=not-engine-body: 403".
//
// refusalText is the console's own reviewed rule for exactly this (components/error-view.ts): the
// engine's sentence when the engine gave one, the reviewed sentence for the classified kind when it
// did not. It subsumes the step-up case this function used to special-case, because a cancelled
// step-up is not a reason-bearing kind.
function errMsg(err: unknown): string {
  return refusalText(err);
}
