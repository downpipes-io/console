// destinationForm: the provider-switched setup form, split out of destinations.ts so the
// screen file stays a thin wiring layer (guardrail: file size). This is the thin wiring
// itself: the field groups (destination-form-fields.ts) and the submit path
// (destination-submit.ts) are extracted, and setProvider (the only piece that must see the
// whole form to toggle the visible variant) lives here. Behaviour is unchanged: the form
// is MOVED verbatim, not rewritten.
//
// No-custody invariants kept: the secret is read once at submit and never echoed back; a
// refusal keeps every value so one field can be fixed in place.

import { h, svgIcon } from "../lib/dom.ts";
import { canDo, gateReason, refuseWithReason } from "./common.ts";
import { field } from "../components/field.ts";
import { confirmModal } from "../components/modal.ts";
import { clearLeaveGuard, navigate, registerLeaveGuard } from "../lib/nav.ts";
import { ICON_EXTERNAL } from "../lib/icons.ts";
import type { EngineClient } from "../api.ts";
import {
  applyProviderCopy,
  buildCredBlock,
  buildPricingBlock,
  buildProviderSeg,
  buildR2Block,
  buildS3Block,
  buildEntraBlock,
  buildStsBlock,
  buildWormBlock,
  GCS_ENDPOINT,
  pricingNote,
  providerPricing,
  type DestinationFormOpts,
  type FormContext,
  type Provider,
} from "./destination-form-fields.ts";
import { submitDestination } from "./destination-submit.ts";

// destinationForm wires the provider-switched setup form from its field-group builders.
// The secret is read once at submit and never echoed back; a refusal keeps every value so
// one field can be fixed in place. This stays a thin wiring layer: the field groups and
// the submit are extracted above, and setProvider (the only piece that must see the whole
// form to toggle the visible variant) lives here.
export function destinationForm(engine: EngineClient, fctx: FormContext, opts: DestinationFormOpts): HTMLElement {
  const ownerGate = canDo("owner");
  const wrap = h("form", { class: "form-stack", "aria-label": "Archive destination", on: { submit: (ev: Event) => ev.preventDefault() } });

  // A human name tells destinations apart in the list and (next) in the downpipe picker. It is not a
  // credential; it defaults to the bucket name on the engine when left blank.
  const labelField = field({ id: "dest-label", label: "Name", placeholder: "e.g. Primary archive", hint: "A short name to tell your destinations apart. Defaults to the bucket name if left blank.", value: opts.initialLabel ?? "", doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations" } });
  wrap.appendChild(labelField.el);

  // The live provider selection plus the pricing-edited flag, the two pieces of form state
  // setProvider and submit share. pricingState is an object so the rate-field onInput (in
  // buildPricingBlock) and setProvider read and write the same flag.
  let provider: Provider = "r2";
  const pricingState = { edited: opts.initialPricing !== undefined };

  // The R2 variant needs updateCircWarn, which in turn reads the live provider + bucket
  // value, so the warn closure is declared here and the bucket field is wired to it.
  const updateCircWarn = (): void => {
    const name = provider === "r2" ? r2.bucketField().value() : "";
    r2.circNote.hidden = !(name !== "" && fctx.sourceR2Buckets.has(name));
  };

  // --- Provider: a two-option segmented radiogroup, R2 first as the default. ---
  const { seg, segButtons } = buildProviderSeg(() => provider, (p) => setProvider(p));
  // Group-level doc link: the R2 and S3 radios are one provider control, so the
  // link explaining the two destination kinds lives on the group rather than on any single radio.
  wrap.appendChild(
    h(
      "div",
      { class: "field" },
      h("span", { class: "field__label" }, "Provider"),
      seg,
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/data-residency#you-choose-the-destination-the-engine-reports-it", target: "_blank", rel: "noreferrer noopener" },
        "About R2 and S3 destinations",
        svgIcon(ICON_EXTERNAL, { size: 13 }),
      ),
    ),
  );

  const r2 = buildR2Block(fctx, updateCircWarn);
  const s3 = buildS3Block(opts);
  const cred = buildCredBlock();
  const pricing = buildPricingBlock(opts, pricingState);
  const worm = buildWormBlock(opts);
  const sts = buildStsBlock(opts);
  // The Entra block is Azure-only for the same reason the STS block is S3-only: each names a mechanism
  // the other store does not have. Shown for azure rather than for every provider, because an operator on
  // an R2 destination has no directory to name.
  const entra = buildEntraBlock(opts);

  // The inline error slot (channel one of the error model: the engine's refusal reason
  // verbatim, AT the form; never a toast, and no value is cleared).
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });

  // The one primary action, owner-gated as disabled-with-reason (the engine enforces
  // owner server-side regardless).
  const saveBtn = (ownerGate
    ? h("button", { "data-dp": "destination-form.button.save#1", class: "btn btn--primary", type: "button" }, "Verify and save")
    : h("button", { "data-dp": "destination-form.button.save#2", class: "btn btn--primary", type: "button" }, "Verify and save")) as HTMLButtonElement;
  if (!ownerGate) refuseWithReason(saveBtn, gateReason("owner"));

  // setProvider toggles the visible variant and clears stale errors; the credential
  // pair and the save action are shared. It must see the whole form, so it stays here.
  function setProvider(p: Provider): void {
    provider = p;
    for (const [id, btn] of segButtons) {
      const sel = id === p;
      btn.setAttribute("aria-checked", sel ? "true" : "false");
      btn.tabIndex = sel ? 0 : -1;
    }
    r2.block.hidden = p !== "r2";
    // GCS and Azure share the explicit block with S3-compatible. For GCS that is literal (it IS an
    // S3-compatible store, reached through Google's S3-interop endpoint); for Azure it is only the FORM
    // that is shared, because the operator answers the same questions even though the engine reaches it
    // with a different client and a different signature scheme. Written as "not R2" rather than "is S3"
    // deliberately, because the narrow form silently hid the whole endpoint block for any third provider
    // and left the operator with a form that had no fields in it. TypeScript cannot catch that: the
    // comparison still compiles.
    s3.block.hidden = p === "r2";
    cred.helpRow.hidden = p !== "r2";
    // The GCS endpoint is fixed: Google publishes exactly one S3-interop host and it is not per-bucket or
    // per-region, so there is nothing for the operator to choose and a free-text box can only be typed
    // wrong. Prefilled and made read-only rather than hidden, because the operator should still SEE where
    // their archives are going, and the submit reads this same field.
    //
    // AZURE DOES NOT GET THE SAME TREATMENT, and that is the difference between the two. An Azure blob
    // endpoint carries the storage account as its first label, so it is a different host for every
    // operator and there is nothing to pin: the field stays editable and only its wording changes
    // (applyProviderCopy below).
    const endpointCtl = s3.endpointField.control as HTMLInputElement;
    if (p === "gcs") {
      endpointCtl.value = GCS_ENDPOINT;
      endpointCtl.readOnly = true;
    } else {
      // Leaving the pinned value behind when switching away would hand another provider a Google endpoint
      // it never chose, so the value is cleared, but ONLY on the way out of the pinned provider: clearing
      // on every switch would throw away an endpoint the operator had typed. read-only is cleared
      // unconditionally, so the field's editable state is stated rather than inherited from the default.
      if (endpointCtl.readOnly) endpointCtl.value = "";
      endpointCtl.readOnly = false;
    }
    // STS AssumeRole is AWS S3 only, and the submit path already ignores it elsewhere, so hide the whole
    // section rather than showing an auth option that does nothing. R2 has no STS; Google Cloud and Azure
    // have no equivalent of it at all, and the engine refuses a role ARN on either endpoint by name.
    sts.section.hidden = p !== "s3";
    entra.section.hidden = p !== "azure";
    // The storage class is the one S3 field neither Google Cloud Storage nor Azure Blob Storage can
    // honour, and the engine refuses it for either endpoint by name (GCS_REFUSED_FIELDS and
    // AZURE_REFUSED_FIELDS in engine/src/dest/provider.ts). A field the save is guaranteed to reject is
    // worse than an absent one, so it is hidden here rather than left to fail at save: GCS answers 400
    // InvalidStorageClass to Amazon's class names, and Azure has access tiers (Hot, Cool, Cold, Archive)
    // rather than class names at all. downpipes translates between neither vocabulary.
    s3.storageClassField.el.hidden = p === "gcs" || p === "azure";
    // REGION AND ADDRESSING ARE INERT ON AZURE BLOB, confirmed rather than assumed: azure-blob.ts,
    // azure-sharedkey.ts, azure-sas.ts and azure-entra.ts reference neither, zero times between them, and
    // engine/src/dest/factory.ts builds AzureBlobDestination without either (only S3Destination is given
    // them). Azure has one URL form, https://<account>.blob.core.windows.net/<container>/<blob>, so there
    // is no addressing to choose; and the region is implied by the account's own endpoint host rather than
    // being a request parameter.
    //
    // They are HIDDEN rather than refused, and the two are not the same remedy. The engine refuses a
    // submitted `addressing` on an Azure endpoint (AZURE_REFUSED_FIELDS), which is safe because it is sent
    // only when an operator picks path or vhost. It does NOT refuse `region`, and must not: the field below
    // is declared holding "auto", this screen coerces an empty box to "auto" on submit and the router
    // coerces again, so region is never absent and a refusal keyed on presence would reject every Azure
    // save including the ones carrying nothing but the default.
    //
    // The Region hint is the sharpest reason to hide it rather than leave it inert: it tells the operator
    // that under STS AssumeRole the value must be the role's real AWS region, and Azure has no AssumeRole
    // at all, so the guidance beside the box cannot be followed on the provider it is being shown for.
    s3.regionField.el.hidden = p === "azure";
    s3.addressingField.el.hidden = p === "azure";
    // IMMUTABILITY IS OFFERED FOR ALL FOUR PROVIDERS, so there is no assignment here at all, and that
    // absence is the point rather than an omission.
    //
    // This control was hidden twice on a belief about a provider, and measurement refuted both. Google
    // Cloud was hidden until on the belief that it has no S3 Object Lock: a GCS bucket created
    // WITH per-object retention answers the engine's Object-Lock probe 200/Enabled, honours a COMPLIANCE
    // lock header, and then refuses a delete inside the window with 403. Azure was hidden until
    // on the belief that its two primitives (a policy that is separately unlocked or locked,
    // plus an independent legal hold) could not be mapped onto the one mode and one window this form
    // collects: the mapping is exact, because the two vocabularies name the same two guarantees, and the
    // mode is a request header chosen per write rather than a container property that has to be inferred.
    // Azure Blob Storage now enforces a version-level immutability policy on a container or account
    // configured for it, governance maps to unlocked and compliance to locked, and the legal hold is
    // simply never set.
    //
    // What decides the outcome is the ENGINE'S LIVE PROBE, which was here before either rule and reached
    // the right answer in both directions on its own: a store that answers that this bucket cannot
    // enforce a lock gets the save refused, naming the bucket rather than the provider. R2 is the case
    // that proves the control is not merely permissive: R2 over its S3 endpoint answers 501
    // NotImplemented to x-amz-object-lock-mode, wormCannotBeEnforced reads that as a definite cannot, and
    // the save is refused. So the control is offered everywhere and the store, not this switch, answers.
    // The endpoint and the credential pair keep their controls for Azure and change their WORDS: an Azure
    // destination stores the storage account name where an S3 one stores an Access Key ID, and one of the
    // account's access keys where an S3 one stores a secret. Asking an Azure operator for an "Access Key
    // ID" asks for something Azure does not issue.
    //
    // The immutability section's prerequisite line moves the same way, and it is the one the operator
    // cannot recover from: what a bucket must have been CREATED as differs by provider and can never be
    // added later, so the form says it here rather than leaving it to the engine's refusal after the work.
    applyProviderCopy({ endpointField: s3.endpointField, keyField: cred.keyField, secretField: cred.secretField, wormPrereq: worm.wormPrereq }, p);
    formError.hidden = true;
    for (const f of [r2.bucketField(), s3.endpointField, s3.s3BucketField, s3.regionField, cred.keyField, cred.secretField]) f.clearError();
    r2.accountIdField()?.clearError();
    updateCircWarn();
    // The prefill's provenance moves with the prefill. The rates that follow the provider are one
    // vendor's list prices, and the note under them names which vendor, so switching to
    // S3-compatible cannot leave Amazon's numbers described as "the provider's" pricing. Updated
    // outside the edited guard because the sentence is about where the prefill came from, which is
    // true whether or not the operator has since typed over it.
    pricing.note.textContent = pricingNote(p);
    // When the operator has not hand-edited the rates, follow the provider's preset so the cost
    // estimate starts from sensible numbers; once edited, their values stand (a JS value-set does not
    // fire the input event, so this never trips pricingState.edited).
    if (!pricingState.edited) {
      const pp = providerPricing(p);
      (pricing.storageField.control as HTMLInputElement).value = String(pp.storagePerGBMonth);
      (pricing.classAField.control as HTMLInputElement).value = String(pp.classAPerMillion);
      (pricing.classBField.control as HTMLInputElement).value = String(pp.classBPerMillion);
      (pricing.egressField.control as HTMLInputElement).value = String(pp.egressPerGB);
    }
  }

  if (ownerGate) {
    saveBtn.addEventListener("click", () =>
      void submitDestination({
        engine,
        fctx,
        opts,
        getProvider: () => provider,
        pricingState,
        labelField,
        r2Block: r2,
        endpointField: s3.endpointField,
        s3BucketField: s3.s3BucketField,
        regionField: s3.regionField,
        addressingField: s3.addressingField,
        storageClassField: s3.storageClassField,
        keyField: cred.keyField,
        secretField: cred.secretField,
        storageField: pricing.storageField,
        classAField: pricing.classAField,
        classBField: pricing.classBField,
        egressField: pricing.egressField,
        currencyField: pricing.currencyField,
        pricingSection: pricing.section,
        wormModeField: worm.wormModeField,
        wormDaysField: worm.wormDaysField,
        roleArnField: sts.roleArnField,
        externalIdField: sts.externalIdField,
        durationField: sts.durationField,
        entraTenantField: entra.tenantIdField,
        entraClientField: entra.clientIdField,
        formError,
        saveBtn,
      }),
    );
  }

  wrap.appendChild(r2.block);
  wrap.appendChild(s3.block);
  wrap.appendChild(cred.keyField.el);
  wrap.appendChild(cred.secretField.el);
  wrap.appendChild(cred.helpRow);
  wrap.appendChild(pricing.section);
  wrap.appendChild(worm.section);
  wrap.appendChild(sts.section);
  wrap.appendChild(entra.section);
  // The save row follows the dialog-actions pattern every modal uses (the primary
  // right-aligned), with the inline refusal reason beside it (channel one of the
  // error model: at the form, never a toast).
  wrap.appendChild(h("div", { class: "dialog__actions", style: "align-items:center" }, formError, saveBtn));
  setProvider("r2");

  // THE DIRTY-FORM LEAVE GUARD, and the reason it is here rather than nowhere.
  //
  // The key ceremony and the new-downpipe wizard both guard their work; this form did not, and it is the
  // one that holds a value the customer cannot get back. A secret access key is shown once, when it is
  // minted, by R2 and by S3 alike. Until now a rail click, the command palette, or the setup strip's own
  // Continue tore the form down with no prompt, and re-typing was not an option: the customer had to go and
  // mint a new key pair. This is also the FIRST-RUN form, reached from a setup strip whose whole job is to
  // move people between screens, so the navigation that destroys the work is the one the product suggests.
  //
  // Guarded only when the operator can actually save. A viewer's typing cannot become a destination, so
  // prompting them would be a question with no useful answer.
  //
  // Dirtiness is read off the identifying and credential fields only, never the pricing or WORM defaults,
  // which are pre-filled and would make every visit dirty. The guard self-heals on a torn-down form (the
  // same shape the wizard uses), so it can never wedge a later navigation, and a successful save replaces
  // the form, which disconnects `wrap` and releases it on the next navigation.
  if (ownerGate) {
    // Compared against a SNAPSHOT rather than against emptiness, because the replace flow prefills the
    // name and the S3 endpoint from the destination being replaced. Testing "is anything filled in" would
    // make that form dirty the moment it painted and prompt on every navigation away from it, which trains
    // people to dismiss the one prompt that matters.
    const readAll = (): string[] => [labelField.value(), r2.bucketField().value(), r2.accountIdField()?.value() ?? "", s3.endpointField.value(), s3.s3BucketField.value(), cred.keyField.value(), cred.secretField.value()].map((v) => v.trim());
    const initial = readAll();
    const isDirty = (): boolean => readAll().some((v, i) => v !== initial[i]);
    const guard = (to: string): boolean => {
      if (!wrap.isConnected) {
        clearLeaveGuard(guard);
        return true;
      }
      if (!isDirty()) return true;
      void confirmModal({
        title: "Discard this destination?",
        body: "You have filled in this destination and it has not been saved yet. Leaving now discards what you typed. A secret access key is shown only once, when it is created, so you would have to mint a new one.",
        confirmLabel: "Discard",
        variant: "danger",
      }).then((discard) => {
        if (discard) {
          clearLeaveGuard(guard);
          navigate(to);
        }
      });
      return false;
    };
    // isDirty is already the pure, side-effect-free predicate the SPA guard above
    // consults (the snapshot-compared secret/name fields); passing it through lets nav.ts's
    // shared beforeunload listener catch a real reload or tab close, which the SPA guard
    // alone never sees, so an un-recoverable secret access key survives it too.
    registerLeaveGuard(guard, isDirty);
  }

  return wrap;
}
