// The Azure Blob provider asks for what Azure actually issues, hides what it
// cannot honour, and never SENDS what it hid.
//
// WHY THIS EXISTS. Azure Blob Storage became a downpipes destination, with its own client and
// its own Shared Key signer in the engine (engine/src/dest/azure-blob.ts, azure-sharedkey.ts). It is the
// first destination that is NOT S3 on the wire: R2 and Google Cloud Storage both reach the engine's one
// S3 client because both speak the S3 XML API under SigV4, and Azure speaks neither. So the console's job
// for this provider is different in kind from the GCS one, in two ways:
//
//   THE CREDENTIAL PAIR CARRIES DIFFERENT THINGS. The engine reuses the stored pair rather than adding
//   fields, so an Azure destination keeps the storage ACCOUNT NAME in accessKeyId and one of that account's
//   ACCESS KEYS in secretAccessKey (engine/src/dest/factory.ts). Azure issues no "Access Key ID" at all, so
//   a form asking for one sends the operator looking for something that does not exist, and the nearest
//   things they would find in the portal (an application id, a SAS token, a connection string) are all the
//   wrong value. The account is also cross-checked against the endpoint host at build time.
//
//   THE ENDPOINT IS NOT FIXED. Google publishes one interop host for every bucket in the world, so the GCS
//   field is prefilled and read-only. Azure's blob endpoint carries the storage account as its first label,
//   so it is different for every operator: the field stays editable, and only its placeholder and hint
//   change.
//
// TWO fields are refused for an Azure endpoint by name (engine/src/dest/provider.ts AZURE_REFUSED_FIELDS):
//
//   storage class   Azure has access tiers (Hot, Cool, Cold, Archive), not Amazon's class names, and
//                   downpipes translates between neither vocabulary.
//   AssumeRole      an Amazon Web Services mechanism with no Azure equivalent.
//
// IMMUTABILITY WAS THE THIRD, AND THIS FILE ONCE ASSERTED THE REFUSAL AS CORRECT BEHAVIOUR.
// The argument was that Azure's two primitives (an immutability policy that is separately unlocked or
// locked, plus an independent legal hold) could not be mapped onto this form's one mode and one window, so
// any mapping would be a guess that might promise a guarantee the store would not keep. The two primitives
// are real; the conclusion was not. The mapping is exact, because the two vocabularies name the same two
// guarantees: governance means a privileged principal CAN lift the retention, which is an UNLOCKED Azure
// policy, and compliance means nobody can shorten or remove it, which is a LOCKED one. Nothing is guessed
// at, because the mode is a request header chosen per write rather than a container property that has to
// be inferred, and the legal hold, which genuinely has no counterpart here, is simply never set.
//
// So the section is OFFERED for Azure, the policy IS submitted, and an Azure container with version-level
// immutability enforces it. What decides the outcome is the engine's LIVE PROBE, which was there before
// the rule and reached the right answer on its own; a container without version-level immutability is
// refused by the probe's verdict, naming the container rather than the provider. This is the second
// refusal in this repository to fall to the same test in the same week, after the Google Cloud one, and
// the pair is the lesson: both were written from a belief about a provider rather than from a measurement.
//
// EVERY ABSENCE ASSERTION HERE CARRIES A CONTROL. A test that only checks a control is hidden, or a value
// is absent, passes just as well for a build that hid it from everyone or dropped it for every provider.
// So each one is preceded by the same measurement taken under S3-compatible, where the control must be
// present and the value must be sent.
//
// THE SUBMIT SECTION IS THE LOAD-BEARING ONE, and it is driven through the REAL submitDestination rather
// than asserted on the DOM, because hiding a control does not clear it: an operator who sets a storage
// class under S3-compatible and then switches to Azure would otherwise submit it and be refused by the
// engine for a control they can no longer see. The DOM assertions above would still pass for a build with
// the submit guards deleted.
//
// Run: node test/validate-destination-azure-provider.ts

import { installDomShim, flushAsync, markConnected, qs, qsa } from "./dom-shim.ts";
installDomShim();

import type { EngineClient } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { connect } from "../src/lib/store.ts";
import { h } from "../src/lib/dom.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import { buildDestinationInput, submitDestination } from "../src/screens/destination-submit.ts";
import { buildEntraBlock } from "../src/screens/destination-form-fields.ts";
import { buildReplaceOpts } from "../src/screens/destination-cards-actions.ts";
import {
  AZURE_CRED_COPY,
  AZURE_ENDPOINT_PLACEHOLDER,
  buildPricingBlock,
  GCS_ENDPOINT,
  PROVIDERS,
  pricingNote,
  S3_CRED_COPY,
  S3_ENDPOINT_COPY,
  WORM_PREREQ_COPY,
  type FormContext,
} from "../src/screens/destination-form-fields.ts";
import { destinationFromStatus } from "../src/lib/protection-statement.ts";
import { emptyMapData, mapDownpipesToFlows } from "../src/screens/map/data.ts";
import { destinationClarity, destinationSummary } from "../src/screens/sources-downpipes/helpers.ts";
import { destinationNote } from "../src/screens/map/panels.ts";
import { renderList as renderDestinationList } from "../src/screens/destination-cards.ts";
import { renderResidency } from "../src/screens/settings/sections.ts";
import { click, findButtonByText, SN } from "./validate-stable-components-shared.ts";

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
connect("https://engine.test");

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

const fctx: FormContext = {
  engineAccountId: "0f2ac7c1b6e0470a8f3d1c2b4a5e6f70",
  engineR2Buckets: ["engine-archive"],
  sourceR2Buckets: new Set<string>(),
  discoveryRead: true,
  downpipesRead: true,
};

console.log("Azure Blob asks for what Azure issues and never submits what it hid");

// ---- 1. The provider exists and is offered. ---------------------------------------------------
console.log("\n-- the provider is offered --");
// No block of its own: this section declares nothing, and a bare block around statements that need no
// scope is what biome's noUselessLoneBlockStatements names.
ok("PROVIDERS carries an azure member", PROVIDERS.some((p) => p.id === "azure"));
ok("...labelled for a human rather than as a protocol code", PROVIDERS.find((p) => p.id === "azure")?.label === "Azure Blob");
ok("the endpoint placeholder shows the account-scoped blob host", AZURE_ENDPOINT_PLACEHOLDER.endsWith(".blob.core.windows.net"), AZURE_ENDPOINT_PLACEHOLDER);
// It must show an ACCOUNT LABEL, because that label is the whole reason this endpoint cannot be pinned the
// way Google's is: a placeholder of "https://blob.core.windows.net" would show the wrong shape and an
// operator copying it would save an endpoint with no account in it.
ok("...with an example account label in front of it, which is the part the operator supplies", /^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net$/.test(AZURE_ENDPOINT_PLACEHOLDER), AZURE_ENDPOINT_PLACEHOLDER);

// ---- 2. The pricing note tells the truth about whose rates these are. -------------------------
// The generic S3 note's stated REASON for naming Amazon is that "an S3-compatible endpoint does not tell
// the console which provider is behind it". For this provider it does, so reusing that sentence would be
// false in a way the operator cannot check.
console.log("\n-- the pricing note --");
{
  const n = pricingNote("azure");
  ok("the Azure note is not the generic S3-compatible note", n !== pricingNote("s3"));
  ok("...and not the R2 note either", n !== pricingNote("r2"));
  ok("...and not the Google note either", n !== pricingNote("gcs"));
  ok("it names Azure Blob Storage", n.includes("Azure Blob Storage"));
  ok("it says plainly that these are NOT Microsoft's prices", /NOT Microsoft's prices/.test(n), n);
  ok("it does not repeat the false reason that the endpoint cannot name the provider", !n.includes("does not tell the console which provider"), n);
}

// ---- 3. The form: what Azure shows, hides and renames. ----------------------------------------
console.log("\n-- the rendered form --");
{
  const form = destinationForm({} as unknown as EngineClient, fctx, { confirmReplace: false, onSaved: () => {} } as never);
  document.body.replaceChildren(form);
  markConnected(form);

  const endpoint = qs(form as unknown as never, "#dest-endpoint") as unknown as HTMLInputElement | null;
  const storageClass = qs(form as unknown as never, "#dest-storage-class") as unknown as HTMLElement | null;
  const wormMode = qs(form as unknown as never, "#dest-worm-mode") as unknown as HTMLElement | null;
  const roleArn = qs(form as unknown as never, "#dest-role-arn") as unknown as HTMLElement | null;
  const region = qs(form as unknown as never, "#dest-region") as unknown as HTMLInputElement | null;
  const addressing = qs(form as unknown as never, "#dest-addressing") as unknown as HTMLElement | null;
  ok("the form renders the endpoint, storage class, immutability and role controls", endpoint !== null && storageClass !== null && wormMode !== null && roleArn !== null);

  // hiddenFor walks up to the container the form actually toggles, because a field's own element is not
  // always the node that carries `hidden`; asserting on the input alone would pass while the whole section
  // was still on screen.
  const hiddenFor = (el: HTMLElement | null): boolean => {
    let n: HTMLElement | null = el;
    while (n !== null) {
      if ((n as unknown as { hidden?: boolean }).hidden === true) return true;
      n = (n as unknown as { parentElement: HTMLElement | null }).parentElement;
    }
    return false;
  };
  // labelOf / hintOf read the two pieces of wording the provider switch rewrites. They are read off the
  // rendered field rather than off the constants, so a build that changed the constant and never applied
  // it fails here.
  const labelOf = (id: string): string => {
    const f = qs(form as unknown as never, `label[for="${id}"]`) as unknown as HTMLElement | null;
    return f?.textContent ?? "";
  };
  const hintOf = (id: string): string => {
    const f = qs(form as unknown as never, `#${id}-hint`) as unknown as HTMLElement | null;
    return f?.textContent ?? "";
  };

  // THE CONTROLS, MEASURED UNDER S3-COMPATIBLE FIRST. Every absence asserted below is only meaningful
  // against a build where the control is present under another provider, so the presence is measured here
  // rather than assumed from the render above (the form paints as R2, where two of the three are already
  // hidden for reasons that have nothing to do with Azure).
  const s3Radio = findButtonByText(form, "S3-compatible");
  ok("the S3-compatible provider radio is present", s3Radio !== undefined);
  if (s3Radio !== undefined) click(s3Radio);
  ok("CONTROL: under S3-compatible the storage class is visible", !hiddenFor(storageClass));
  ok("CONTROL: under S3-compatible the immutability section is visible", !hiddenFor(wormMode));
  ok("CONTROL: under S3-compatible the AssumeRole section is visible", !hiddenFor(roleArn));
  ok("CONTROL: under S3-compatible the Region is visible", !hiddenFor(region));
  ok("CONTROL: under S3-compatible the Addressing style is visible", !hiddenFor(addressing));
  ok("CONTROL: under S3-compatible the credential is called an Access Key ID", labelOf("dest-access-key") === S3_CRED_COPY.key.label, labelOf("dest-access-key"));
  ok("CONTROL: under S3-compatible the secret is called a Secret Access Key", labelOf("dest-secret") === S3_CRED_COPY.secret.label, labelOf("dest-secret"));
  ok("CONTROL: under S3-compatible the endpoint placeholder is the generic S3 one", endpoint?.placeholder === S3_ENDPOINT_COPY.placeholder, String(endpoint?.placeholder));

  const azureRadio = findButtonByText(form, "Azure Blob");
  ok("the Azure Blob provider radio is present", azureRadio !== undefined);
  if (azureRadio !== undefined) click(azureRadio);

  ok("the endpoint block is VISIBLE (a fourth provider must not blank the form)", !hiddenFor(endpoint));
  ok("the endpoint stays EDITABLE: the account is the operator's, not something the console can know", endpoint?.readOnly === false);
  ok("...and is left EMPTY rather than prefilled with the example, which would save somebody else's account", endpoint?.value === "", String(endpoint?.value));
  ok("...and its placeholder shows the account-scoped blob host", endpoint?.placeholder === AZURE_ENDPOINT_PLACEHOLDER, String(endpoint?.placeholder));
  ok("...and its hint names the blob endpoint rather than an S3-compatible one", hintOf("dest-endpoint").includes("blob.core.windows.net"), hintOf("dest-endpoint"));

  ok("the storage class is hidden: Azure has access tiers, not Amazon's class names", hiddenFor(storageClass));

  // REGION AND ADDRESSING, hidden because they are inert on this provider. Confirmed in the
  // engine rather than assumed: azure-blob, azure-sharedkey, azure-sas and azure-entra reference neither,
  // zero times between them, and factory.ts builds AzureBlobDestination without either.
  ok("the addressing style is hidden: Azure has one URL form, so there is nothing to choose", hiddenFor(addressing));
  // The Region hint is the sharpest reason this one had to go rather than sit there inert: it instructs
  // the operator that under STS AssumeRole the value must be the role's real AWS region, and Azure has no
  // AssumeRole at all, so the guidance beside the box cannot be followed on the provider showing it.
  ok("the region is hidden: it is implied by the account's own endpoint host, never a request parameter", hiddenFor(region));
  ok("...and the region box still HOLDS \"auto\", because hiding a control does not clear it and the save still sends a valid value", region?.value === "auto", String(region?.value));
  // IMMUTABILITY IS OFFERED, and the assertion is deliberately the other way round from the two beside it.
  // It read "hidden: Azure has no S3 Object Lock" until, and the hide it asserted held the
  // defect in place. Azure has no S3 Object Lock and does not need one: the engine reaches it with its own
  // client and maps this form's two modes onto Azure's own version-level immutability, governance to an
  // UNLOCKED policy (a privileged principal can lift it) and compliance to a LOCKED one (nobody can
  // shorten or remove it). The mode is a per-write request header, not a container property to infer, and
  // the legal hold that has no counterpart here is never set. A container without version-level
  // immutability is refused by the engine's live probe, which is the rule every other store is held to.
  ok("the immutability section is OFFERED for Azure: a container with version-level immutability enforces it", !hiddenFor(wormMode));
  ok("the AssumeRole section is hidden: no Azure equivalent exists", hiddenFor(roleArn));

  ok("the credential box asks for the storage account name, which is what Azure issues", labelOf("dest-access-key") === AZURE_CRED_COPY.key.label, labelOf("dest-access-key"));
  ok("...and its hint says the account must match the endpoint host", hintOf("dest-access-key").includes("match the endpoint host"), hintOf("dest-access-key"));
  ok("the secret box asks for a storage access key", labelOf("dest-secret") === AZURE_CRED_COPY.secret.label, labelOf("dest-secret"));
  ok("...and its hint says where in the portal to find it", hintOf("dest-secret").includes("Access keys"), hintOf("dest-secret"));

  // THE LABEL ITSELF IS LOAD-BEARING, and the way it went ungraded for so long is the
  // part worth keeping. The line above compares the RENDERED label to AZURE_CRED_COPY.secret.label, which
  // is the constant the render is built from. That pair moves together: rewriting the constant to
  // "Storage access key" and re-running left this validator at exit 0, because the render still matched its
  // own source. An equality against the thing under test grades the WIRING and cannot grade the WORDS. The
  // prerequisite block below already knew this and asserts substrings before it matches the constant; the
  // credential block did not.
  //
  // WHY THE WORDS MATTER HERE MORE THAN ANYWHERE ELSE ON THIS FORM. The engine takes THREE different Azure
  // credentials in this ONE box and tells them apart from the value's SHAPE, not from a second field:
  // engine/src/dest/factory.ts:412 runs looksLikeAzureSasToken (engine/src/dest/azure-sas.ts:60, a query
  // string carrying "sig") over the stored secret, and the Entra client secret is the third, named in the
  // block below. So an operator holding a SAS and reading a box labelled "Storage access key" has no way to
  // know it is accepted, and the capability is one the product HAS and the interface WITHHOLDS. That is the
  // defect P1.11 closed, and until now nothing would have noticed it reopening.
  const secretLabel = labelOf("dest-secret");
  ok("the secret box names the ACCOUNT KEY, one of the three the engine accepts", /access key/i.test(secretLabel), secretLabel);
  ok("...and the SAS TOKEN, which the engine reads off the value's shape rather than a second field", /SAS/.test(secretLabel), secretLabel);
  ok("...and the CLIENT SECRET of the Entra service principal, the third kind", /client secret/i.test(secretLabel), secretLabel);
  ok("...and its hint says the engine tells them apart from the value itself, so the operator need not choose", hintOf("dest-secret").includes("tells them apart from the value itself"), hintOf("dest-secret"));

  // THE IMMUTABILITY PREREQUISITE LINE. Offering the section is only half the job: what the container must
  // ALREADY be is the fact the operator cannot act on once a save is refused, so the form says it first.
  // Azure's line is the one that differs in kind from the other three. On R2, Amazon S3 and Google Cloud
  // the prerequisite is chosen when the bucket is created and can never be added, so the remedy is a new
  // bucket; on Azure, version-level immutability can be turned on for a container that already exists, so
  // the remedy is a setting. Handing an Azure operator "the bucket has to be replaced" would send them to
  // rebuild something they only had to configure. Read off the RENDERED node, because a constant nothing
  // reads is exactly the failure mode.
  const prereqText = (): string => {
    const n = qs(form as unknown as never, ".dest-worm-prereq") as unknown as HTMLElement | null;
    return n === null ? "" : String(n.textContent ?? "");
  };
  const azureLine = prereqText();
  ok("the immutability section carries a prerequisite line for Azure", azureLine !== "");
  ok("it names version-level immutability, which is what Azure calls the thing that must be on", azureLine.includes("version-level immutability"), azureLine);
  ok("...and says it can be turned on at any time, because on Azure it can", azureLine.includes("turn on in Azure at any time"), azureLine);
  ok("...and does NOT tell an Azure operator to replace a container they only have to configure", !azureLine.includes("replaced rather than reconfigured"), azureLine);
  ok("...and maps the two modes onto Azure's own words rather than Amazon's", azureLine.includes("unlocked policy") && azureLine.includes("locked one"), azureLine);
  ok("...and it matches the constant, so the rendered line is the one that was reviewed", azureLine === WORM_PREREQ_COPY.azure, azureLine);
  // THE CONTROL. Every assertion above would pass for a build that rendered one sentence for everybody, so
  // the S3-compatible line must differ AND must still carry the create-time prerequisite Azure does not.
  if (s3Radio !== undefined) click(s3Radio);
  const s3PrereqLine = prereqText();
  ok("CONTROL: S3-compatible gets a different sentence", s3PrereqLine !== azureLine, s3PrereqLine);
  ok("CONTROL: ...and it is the create-time one, so the Azure line is not simply the sentence everybody gets", s3PrereqLine.includes("cannot be turned on for a bucket that exists"), s3PrereqLine);
  if (azureRadio !== undefined) click(azureRadio);
  ok("switching back to Azure restores Azure's line rather than leaving the S3 one behind", prereqText() === WORM_PREREQ_COPY.azure, prereqText());

  // Switching back must restore every one of those, or the S3-compatible form would ask an S3 operator for
  // a storage account name.
  if (s3Radio !== undefined) click(s3Radio);
  ok("switching back to S3-compatible restores the Access Key ID label", labelOf("dest-access-key") === S3_CRED_COPY.key.label, labelOf("dest-access-key"));
  ok("...and the Secret Access Key label", labelOf("dest-secret") === S3_CRED_COPY.secret.label, labelOf("dest-secret"));
  ok("...and the generic S3 endpoint placeholder", endpoint?.placeholder === S3_ENDPOINT_COPY.placeholder, String(endpoint?.placeholder));
  ok("...and brings the storage class back", !hiddenFor(storageClass));
  ok("...and the immutability section is still offered (it is offered for every provider now)", !hiddenFor(wormMode));

  // Google's endpoint IS pinned and read-only. Switching from Google straight to Azure must not leave the
  // operator with Google's host in an Azure destination, which would be a save against somebody else's
  // cloud with an Azure account name in the credential.
  const gcsRadio = findButtonByText(form, "Google Cloud");
  if (gcsRadio !== undefined) click(gcsRadio);
  ok("CONTROL: Google pins its endpoint read-only", endpoint?.value === GCS_ENDPOINT && endpoint?.readOnly === true, `${String(endpoint?.value)} readOnly=${String(endpoint?.readOnly)}`);
  if (azureRadio !== undefined) click(azureRadio);
  ok("switching from Google to Azure clears Google's pinned endpoint", endpoint?.value === "", String(endpoint?.value));
  ok("...and makes it editable again", endpoint?.readOnly === false);
}

// ---- 4. The SUBMIT guards, on the payload. ----------------------------------------------------
// Asserted on what buildDestinationInput produces, because the DOM assertions above would all still pass
// with the guards deleted. The values below are exactly what an operator would leave behind by setting
// them under S3-compatible and then switching to Azure.
console.log("\n-- the submitted payload --");
{
  const stale = {
    endpointField: { value: () => "https://myaccount.blob.core.windows.net" },
    s3BucketField: { value: () => "archive" },
    regionField: { value: () => "auto" },
    keyField: { value: () => "myaccount" },
    secretField: { value: () => "YmFzZTY0c2VjcmV0" },
    addressingField: { value: () => "auto" },
    // Left over from a provider switch: hidden, but still carrying a value.
    storageClassField: { value: () => "STANDARD_IA" },
    r2Block: { accountId: () => "", bucketField: () => ({ value: () => "" }) },
  } as never;
  const worm = { mode: "compliance", retentionDays: 30 } as never;
  // A real pricing block: buildDestinationInput takes one by value and this test is not about pricing.
  const PRICING = { storagePerGBMonth: 0.015, classAPerMillion: 4.5, classBPerMillion: 0.36, egressPerGB: 0 };

  const az = buildDestinationInput(stale, "azure", PRICING, undefined, undefined, undefined) as unknown as Record<string, unknown>;
  ok("an Azure payload never carries a storage class, even when the hidden control still holds one", az.storageClass === undefined, JSON.stringify(az.storageClass));
  ok("...and still carries the endpoint and container, so the guard is not refusing the whole submit", az.endpoint === "https://myaccount.blob.core.windows.net" && az.bucket === "archive");
  // The credential pair is the SAME pair on the wire; only its meaning and its labels changed. If this
  // moved, the engine would build a Shared Key signature with nothing in it.
  ok("...and carries the storage account and its access key in the same credential fields", az.accessKeyId === "myaccount" && az.secretAccessKey === "YmFzZTY0c2VjcmV0");

  // The control that keeps the guard honest: the SAME stale field must still reach an S3 payload, or the
  // assertion above would pass for a build that simply dropped the storage class for everyone.
  const s3 = buildDestinationInput(stale, "s3", PRICING, undefined, undefined, undefined) as unknown as Record<string, unknown>;
  ok("CONTROL: an S3-compatible payload DOES carry that same storage class", s3.storageClass === "STANDARD_IA", JSON.stringify(s3.storageClass));

  ok("an absent immutability policy is omitted from the payload rather than sent as null", !("worm" in az));
  const s3Worm = buildDestinationInput(stale, "s3", PRICING, worm, undefined, undefined) as unknown as Record<string, unknown>;
  ok("CONTROL: a policy that IS passed reaches an S3 payload", (s3Worm.worm as { mode?: string } | undefined)?.mode === "compliance");
}

// ---- 5. The immutability policy REACHES the engine for Azure, driven through the REAL submit. --
// buildDestinationInput takes `worm` ALREADY RESOLVED, so whether an Azure destination carries a policy at
// all is decided one level up, in submitDestination, and section 4 cannot see it. This section drives the
// real function with a real pricing block and a stub engine, and reads what the engine was actually handed.
//
// IT USED TO ASSERT THE OPPOSITE, AND THAT ASSERTION HELD THE DEFECT IN PLACE. submitDestination forced the
// mode to "" for Azure, this section proved the forcing worked, and the pair read as a guard doing its job.
// The forcing was the defect: an Azure container with version-level immutability enforces a policy where
// governance is an unlocked policy and compliance a locked one, so the console was refusing to arm a
// guarantee the store would have kept, and no operator could tell, because the section was hidden as well.
// Both are gone, and this section now grades the fact that matters: the policy the operator set reaches the
// engine, which is the only party that can say whether this particular container enforces it.
//
// The compliance confirm is the visible half of the same change. Azure raises it now, exactly as
// S3-compatible does, because compliance really is irreversible on an Azure locked policy.
console.log("\n-- the immutability policy, through submitDestination --");
{
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

  // buildCtx wires REAL pricing controls and a stub engine that records what it was handed. `provider` is
  // the live selection; the worm fields carry the policy an operator left behind under S3-compatible.
  const buildCtx = (provider: string, entra?: { tenantId: string; clientId: string }) => {
    const pricingState = { edited: false };
    const pb = buildPricingBlock({} as never, pricingState);
    const sent: unknown[] = [];
    const ctx = {
      engine: {
        async addDestination(input: unknown): Promise<{ status: string; value: unknown }> {
          sent.push(input);
          return { status: "result", value: { destinations: [] } };
        },
      },
      fctx,
      opts: { confirmReplace: false, onSaved: () => undefined },
      getProvider: () => provider,
      pricingState,
      labelField: stub("Offsite archive"),
      r2Block: { block: h("div"), bucketField: () => stub(""), accountIdField: () => null, accountId: () => "", circNote: h("div") },
      endpointField: stub("https://myaccount.blob.core.windows.net"),
      s3BucketField: stub("archive"),
      regionField: stub("auto"),
      addressingField: stub("auto"),
      storageClassField: stub(""),
      keyField: stub("myaccount"),
      secretField: stub("YmFzZTY0c2VjcmV0"),
      storageField: pb.storageField,
      classAField: pb.classAField,
      classBField: pb.classBField,
      egressField: pb.egressField,
      currencyField: pb.currencyField,
      pricingSection: pb.section,
      // The stale policy: a compliance lock and a retention, set under S3-compatible and never cleared.
      wormModeField: stub("compliance"),
      wormDaysField: stub("30"),
      roleArnField: stub(""),
      externalIdField: stub(""),
      durationField: stub(""),
      entraTenantField: stub(entra?.tenantId ?? ""),
      entraClientField: stub(entra?.clientId ?? ""),
      formError: h("p"),
      saveBtn: h("button"),
    } as unknown as Parameters<typeof submitDestination>[0];
    return { ctx, sent };
  };

  // answerModalReadingText clicks the named button on whatever confirmModal the submit put up and hands
  // back the dialog's words, because both runs here raise one and both assert what it SAID as well as that
  // it appeared. It returns "" when no dialog is up, which is what makes it usable as its own control: a
  // build that stopped raising the confirm fails the text assertions rather than reading a stale dialog
  // from an earlier run.
  const answerModalReadingText = async (label: string): Promise<string> => {
    await flushAsync();
    const surface = qs(SN(document.body) as never, ".dialog--modal");
    const text = surface === null ? "" : String((surface as unknown as { textContent?: string }).textContent ?? "");
    if (surface) {
      const btn = findButtonByText(surface, label);
      if (btn) click(btn);
    }
    await flushAsync();
    return text;
  };

  // Started and THEN answered. Awaiting first would deadlock: the submit sits on the compliance confirm
  // until somebody answers it, so a run that awaited before clicking would die on an unsettled promise
  // instead of failing the assertion that names the defect.
  const azure = buildCtx("azure");
  const azurePending = submitDestination(azure.ctx);
  const azureConfirmText = await answerModalReadingText("Arm compliance lock");
  await azurePending;
  await flushAsync();
  const azSent = azure.sent[0] as Record<string, unknown> | undefined;
  ok("the Azure save reached the engine", azSent !== undefined);
  ok("a compliance lock IS sent for an Azure destination, so the store can enforce it", (azSent?.worm as { mode?: string } | undefined)?.mode === "compliance", JSON.stringify(azSent?.worm));
  ok("...with the retention the operator set, not a default", (azSent?.worm as { retentionDays?: number } | undefined)?.retentionDays === 30, JSON.stringify(azSent?.worm));
  ok("...and the rest of the destination still saves alongside it", azSent?.bucket === "archive");
  // The confirm is asserted for Azure too, because an Azure LOCKED policy is as irreversible as an S3
  // compliance lock: saving one without naming the consequence would be the worse half of arming it.
  ok("an Azure compliance lock raises the same irreversibility confirm", azureConfirmText.includes("Lock every archive object for 30 days"), azureConfirmText);
  ok("...and does not send an Azure operator looking for an AWS account root", !azureConfirmText.includes("account root"), azureConfirmText);

  // ---------------------------------------------------------------------------------------------------
  // AZ-10..15: THE MICROSOFT ENTRA SERVICE PRINCIPAL, which the console could not express until.
  //
  // The engine has taken three Azure credential kinds since Entra landed: a storage account key, a SAS
  // token, and a service principal. The console offered one. A capability reachable over the API and absent
  // from the only interface a customer has is not a supported capability, so these cells grade the form
  // against the engine's OWN rules (engine/src/dest/factory-validators.ts:237, :243, :249) rather than
  // against a looser shape invented here: a console that accepted a wider shape would let a save through
  // that the write boundary then refuses with a 400 the operator cannot act on from the form.
  // ---------------------------------------------------------------------------------------------------
  {
    const sentPrincipal = async (entra: { tenantId: string; clientId: string }) => {
      const c = buildCtx("azure", entra);
      const pending = submitDestination(c.ctx);
      await answerModalReadingText("Arm compliance lock");
      await pending;
      await flushAsync();
      return { sent: c.sent[0] as Record<string, unknown> | undefined, err: (c.ctx as { formError: HTMLElement }).formError.textContent ?? "" };
    };

    const good = await sentPrincipal({ tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" });
    ok("AZ-10 a complete service principal reaches the engine", good.sent !== undefined);
    ok(
      "AZ-10 ...as azureEntra, carrying both ids",
      JSON.stringify((good.sent?.azureEntra as Record<string, string> | undefined) ?? {}) === JSON.stringify({ tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" }),
      JSON.stringify(good.sent?.azureEntra),
    );
    ok("AZ-11 the client secret still rides in secretAccessKey, so there is one secret per destination", good.sent?.secretAccessKey === "YmFzZTY0c2VjcmV0");

    const domain = await sentPrincipal({ tenantId: "contoso.onmicrosoft.com", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" });
    ok("AZ-12 a tenant named by its verified DOMAIN is accepted, as the engine accepts it", (domain.sent?.azureEntra as { tenantId?: string } | undefined)?.tenantId === "contoso.onmicrosoft.com");

    const half = await sentPrincipal({ tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "" });
    // WHAT THIS ACTUALLY PROVES, confirmed directly rather than assumed. Removing the half-set guard
    // does NOT let a half-set principal through: an empty id fails the GUID and domain shapes below it
    // anyway. So the "refused" half of this cell is satisfied by a guard other than the one it is aimed
    // at, and only the MESSAGE half is load-bearing. The half-set guard exists to hand the operator "fill
    // both, or clear both" instead of "must be a GUID", which is the difference between a sentence they
    // can act on and one describing a box they deliberately left empty. Both assertions are kept and the
    // split is written down, rather than left for the next person to rediscover by mutating it.
    ok("AZ-13 a HALF-SET principal does not reach the engine (the shape guards would also stop it)", half.sent === undefined);
    ok("AZ-13 ...and the refusal names BOTH ids and the way out, which ONLY the half-set guard does", /Directory \(tenant\) ID and the Application \(client\) ID/.test(half.err) && /clear both/.test(half.err), half.err);

    const common = await sentPrincipal({ tenantId: "common", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" });
    ok("AZ-14 the multi-tenant alias \"common\" is refused BY NAME", common.sent === undefined);
    ok("AZ-14 ...with its own sentence, because it is the wrong tenant that looks deliberate", /has to name ONE directory/.test(common.err), common.err);

    const badGuid = await sentPrincipal({ tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "not-a-guid" });
    ok("AZ-15 a malformed application id is refused", badGuid.sent === undefined);
    ok("AZ-15 ...naming the shape rather than saying invalid", /GUID \(8-4-4-4-12 hex\)/.test(badGuid.err), badGuid.err);

    // CONTROL, and the one that keeps every cell above from being satisfied by a form that refuses
    // everything: an Azure destination with NO principal must still save, and must send no azureEntra at
    // all, so a destination stored before this block existed is byte-identical to one stored after it.
    const none = await sentPrincipal({ tenantId: "", clientId: "" });
    ok("AZ-16 CONTROL: no principal still saves", none.sent !== undefined);
    // AZ-17: THE EDIT FORM SHOWS A STORED PRINCIPAL, which is the whole reason buildEntraBlock takes opts.
    //
    // The engine REBUILDS the stored config from the submitted body, so whatever the form does not send is
    // not merely unchanged, it is GONE. A form that could not show an existing principal would therefore
    // delete it on any save: open an Azure destination to change its label, press save, and the next run
    // tries to use the client secret as a storage account key. assumeRole carries initialAuthRoleArn for
    // exactly this reason and these two ids are the same case.
    //
    // Driven through the real buildEntraBlock rather than the stub context above, because the stub is what
    // the SUBMIT cells need and it cannot see whether the FORM was seeded at all.
    {
      const seeded = buildEntraBlock({ confirmReplace: true, onSaved: () => undefined, initialAzureEntra: { tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" } } as never);
      ok("AZ-17 the edit form shows a stored directory id", seeded.tenantIdField.value() === "72f988bf-86f1-41af-91ab-2d7cd011db47", seeded.tenantIdField.value());
      ok("AZ-17 ...and the stored application id", seeded.clientIdField.value() === "d290f1ee-6c54-4b01-90e6-d701748f0851", seeded.clientIdField.value());
      // AZ-18: THE HOP FROM STATUS TO FORM OPTIONS, which is the link that actually carries the stored
      // principal into the edit form. Graded separately because deleting it survived every cell above:
      // they all drive buildEntraBlock directly and none of them exercises buildReplaceOpts.
      const opts = buildReplaceOpts({ id: "d1", label: "Offsite", azureEntra: { tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" } } as never, () => undefined);
      ok("AZ-18 a stored principal reaches the form's options", JSON.stringify(opts.initialAzureEntra ?? {}) === JSON.stringify({ tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", clientId: "d290f1ee-6c54-4b01-90e6-d701748f0851" }), JSON.stringify(opts.initialAzureEntra));
      ok("AZ-18 CONTROL: a destination with no principal carries no initialAzureEntra key at all", !("initialAzureEntra" in buildReplaceOpts({ id: "d2", label: "Plain" } as never, () => undefined)));

      const blank = buildEntraBlock({ confirmReplace: false, onSaved: () => undefined } as never);
      ok("AZ-17 CONTROL: with no stored principal both boxes are empty, not prefilled with a placeholder", blank.tenantIdField.value() === "" && blank.clientIdField.value() === "");
    }
    ok("AZ-16 CONTROL: ...and sends no azureEntra key at all", none.sent !== undefined && !("azureEntra" in none.sent));
  }


  // THE CONTROL. The identical fixture under S3-compatible must send the same policy, so neither assertion
  // above can pass for a build that simply sends immutability regardless of what the operator set: the
  // storage-class assertions in section 4 are the ones proving this fixture's provider is read at all.
  const s3 = buildCtx("s3");
  const pending = submitDestination(s3.ctx);
  // The confirm's own words are read on the way past, because this is the one run in the suite that raises
  // it. It used to say a compliance lock could not be removed by "your account root", which is Amazon's
  // name for the most privileged principal. The form now offers immutability for Google Cloud as well,
  // where no account root exists to look for, so the sentence names the property instead of one vendor's
  // word for it. The claim itself is unchanged: a compliance lock stands above every principal the store has.
  const confirmText = await answerModalReadingText("Arm compliance lock");
  ok("the compliance confirm names the retention the operator typed", confirmText.includes("Lock every archive object for 30 days"), confirmText);
  ok("it does not send a Google Cloud operator looking for an AWS account root", !confirmText.includes("account root"), confirmText);
  ok("...and still says the lock is above every principal, however privileged", confirmText.includes("cannot be shortened or removed by anyone, however privileged"), confirmText);
  ok("...and still names governance as the mode a privileged principal CAN override", confirmText.includes("lets a privileged principal override it"), confirmText);
  await pending;
  await flushAsync();
  const s3Sent = s3.sent[0] as Record<string, unknown> | undefined;
  ok("CONTROL: the same stale policy DOES reach an S3-compatible save", (s3Sent?.worm as { mode?: string } | undefined)?.mode === "compliance", JSON.stringify(s3Sent?.worm));
  ok("CONTROL: with the retention the operator set", (s3Sent?.worm as { retentionDays?: number } | undefined)?.retentionDays === 30);
}

// ---- 6. The display sites: a configured Azure destination is NAMED, never fallen through. ----
// The union widening does not make the compiler find these. Every one of them is a ternary chain or an
// if-chain that already had an else arm, which is exactly how a configured Google destination came to read
// "No destination kind set" in the residency panel before that provider was named. So each site is driven,
// and each carries the S3 measurement as its control.
console.log("\n-- the destKind display sites --");
{
  const statusFor = (destKind: string): never => ({ destKind, destConfigured: true, destBucket: "archive" }) as never;

  // 6a. The protection statement, which is the sentence that tells an operator where their data is.
  ok("the protection statement names Azure Blob Storage", destinationFromStatus(statusFor("azure"), "archive").name === "Azure Blob Storage archive");
  ok("...and reports it as configured", destinationFromStatus(statusFor("azure"), "archive").configured === true);
  ok("CONTROL: the same call under S3 still names an S3 archive", destinationFromStatus(statusFor("s3"), "archive").name === "S3 archive");
  ok("CONTROL: an unnamed but configured kind still falls back rather than claiming a vendor", destinationFromStatus(statusFor("something-else"), "archive").name === "your archive destination");

  // 6b. The residency panel in settings. This is the site that was silently wrong for Google, and the one
  // an operator reads when they are asking whether data leaves their Cloudflare account.
  const residencyText = async (destKind: string): Promise<string> => {
    const engine = { status: async () => statusFor(destKind) } as unknown as EngineClient;
    const card = renderResidency(engine);
    document.body.replaceChildren(card);
    markConnected(card);
    await flushAsync();
    return (card as unknown as { textContent: string | null }).textContent ?? "";
  };
  const azureResidency = await residencyText("azure");
  ok("the residency panel names Azure Blob Storage", azureResidency.includes("Azure Blob Storage"), azureResidency);
  ok("...and does NOT fall through to the no-destination arm", !azureResidency.includes("No destination kind set"), azureResidency);
  const s3Residency = await residencyText("s3");
  ok("CONTROL: the same panel under S3 still names S3", s3Residency.includes("S3 (verify the region"), s3Residency);
  const unsetResidency = await residencyText("");
  ok("CONTROL: with no kind at all it still says so, so the arm above is not simply unreachable", unsetResidency.includes("No destination kind set"), unsetResidency);

  // 6c. The topology map's destination note.
  const noteText = (destKind: string): string => {
    const data = { ...emptyMapData(), status: { ok: true, value: statusFor(destKind) } } as never;
    return (destinationNote([], data) as unknown as { textContent: string | null }).textContent ?? "";
  };
  ok("the map note names an Azure Blob Storage archive", noteText("azure").includes("Azure Blob Storage archive"), noteText("azure"));
  ok("...and says it is out of the Cloudflare account", noteText("azure").includes("out of your Cloudflare account"), noteText("azure"));
  ok("CONTROL: the same note under S3 still names an S3 archive", noteText("s3").includes("an S3 archive"), noteText("s3"));
  // The map note also decides whether to append "Choose it on Destinations", and it decides from a list of
  // kinds ORed with destConfigured. A coherent engine status never separates the two, so the clause for
  // this provider is graded on a status that does: destKind set with destConfigured false. That state is
  // not one the engine emits, and driving it is the only way to see which half of the OR answered.
  const noteFor = (destKind: string, destConfigured: boolean): string => {
    const data = { ...emptyMapData(), status: { ok: true, value: { destKind, destConfigured } as never } } as never;
    return (destinationNote([], data) as unknown as { textContent: string | null }).textContent ?? "";
  };
  ok("an azure kind alone counts as configured, with no prompt to choose a destination", !noteFor("azure", false).includes("Choose it on Destinations"), noteFor("azure", false));
  ok("CONTROL: no kind and not configured DOES prompt, so the absence above is not vacuous", noteFor("", false).includes("Choose it on Destinations"), noteFor("", false));

  // 6e. The map's destination NODE, which carries the name an operator reads on the topology itself. It is
  // reached through mapDownpipesToFlows rather than directly, because destinationFor is internal.
  const flowDest = (destKind: string): { name: string; kind: string } => {
    const data = {
      ...emptyMapData(),
      status: { ok: true, value: statusFor(destKind) },
      downpipes: { ok: true, value: [{ config: { id: "dp1", name: "One", source: { type: "kv", namespaceId: "ns1" }, cadenceSeconds: 3600, enabled: true }, inFlight: false }] },
    } as never;
    const flows = mapDownpipesToFlows(data, Date.now());
    const d = flows[0]?.destination;
    return { name: d?.name ?? "", kind: String(d?.kind ?? "") };
  };
  ok("the map's destination node is named an Azure Blob Storage archive", flowDest("azure").name === "Azure Blob Storage archive", flowDest("azure").name);
  ok("...and keeps the s3 NODE KIND, which is the map's glyph vocabulary and not a protocol claim", flowDest("azure").kind === "s3", flowDest("azure").kind);
  ok("CONTROL: the same node under S3 is still named S3 archive", flowDest("s3").name === "S3 archive", flowDest("s3").name);

  // 6f. The create/import form's destination block. Its kind test was the dangerous one: while it asked
  // `destKind === "s3"`, every other non-null kind fell PAST it to the in-account R2 block, so a form told
  // the operator their archive was in-account R2 over somebody else's cloud.
  const clarityText = (destKind: string | null): string =>
    (destinationClarity({ destKind, destConfigured: destKind !== null } as never) as unknown as { textContent: string | null }).textContent ?? "";
  ok("an azure destination reads as out of account", clarityText("azure").includes("Out of account"), clarityText("azure"));
  ok("...and is NOT described as in-account R2", !clarityText("azure").includes("In-account R2"), clarityText("azure"));
  ok("...and is named as Azure Blob Storage rather than as S3", clarityText("azure").includes("Azure Blob Storage"), clarityText("azure"));
  ok("CONTROL: an r2 destination still reads as the in-account block", clarityText("r2").includes("In-account R2"), clarityText("r2"));
  ok("CONTROL: an s3 destination still reads as an S3 destination", clarityText("s3").includes("S3 destination"), clarityText("s3"));
  ok("CONTROL: no destination at all still reads as not yet set", clarityText(null).includes("Destination not yet set"), clarityText(null));

  // 6g. The detail drawer's one-line destination summary, which fell to "Not set" for a working one.
  ok("the drawer summary names Azure Blob Storage", destinationSummary(statusFor("azure")).includes("Azure Blob Storage"), destinationSummary(statusFor("azure")));
  ok("...rather than reporting a configured destination as not set", !destinationSummary(statusFor("azure")).includes("Not set"), destinationSummary(statusFor("azure")));
  ok("CONTROL: an r2 destination still summarises as in-account R2", destinationSummary(statusFor("r2")) === "In-account R2");
  ok("CONTROL: an absent kind still summarises as not set", destinationSummary({ destConfigured: false } as never).includes("Not set"));

  // 6d. The provider badge on the destinations table, which is where providerKind is read. It mirrors the
  // engine's providerForEndpoint, INCLUDING the difference between the two host matches: Google's is a
  // whole-host match and Azure's is a suffix on the account label.
  // Read the BADGES rather than the row text: the row also carries the endpoint host, so a text match on
  // "S3" would find the host "s3.us-east-1.amazonaws.com" and pass for a build with no provider badge at
  // all.
  const badgesFor = (endpointHost: string): string[] => {
    const list = { destinations: [{ id: "d1", label: "Offsite", bucket: "archive", endpointHost, source: "console" }], defaultId: "d1" } as never;
    const el = renderDestinationList({ listHistory: async () => [] } as unknown as EngineClient, list, () => {});
    return qsa(SN(el) as never, ".badge").map((b) => (b as unknown as { textContent: string | null }).textContent ?? "");
  };
  ok("an Azure blob host is badged Azure", badgesFor("myaccount.blob.core.windows.net").includes("Azure"), badgesFor("myaccount.blob.core.windows.net").join("|"));
  ok("CONTROL: an ordinary S3 host is still badged S3", badgesFor("s3.us-east-1.amazonaws.com").includes("S3"), badgesFor("s3.us-east-1.amazonaws.com").join("|"));

  // EVERY AZURE CLOUD, NOT JUST THE COMMERCIAL ONE. The console once matched only `.blob.core.windows.net`,
  // while the engine has always routed all three suffixes in AZURE_STORAGE_SUFFIXES to
  // its Azure client and its Shared Key signer. So a US Government or China-cloud destination that the
  // engine was talking to as Azure wore an "S3" badge in the operator's own destination list, on the row
  // whose whole job is to say which vendor holds the archives. One vector per cloud, because a matcher
  // built from a list can admit two of three and still pass a single-vector test.
  ok("an Azure US Government blob host is badged Azure", badgesFor("myaccount.blob.core.usgovcloudapi.net").includes("Azure"), badgesFor("myaccount.blob.core.usgovcloudapi.net").join("|"));
  ok("an Azure China blob host is badged Azure", badgesFor("myaccount.blob.core.chinacloudapi.cn").includes("Azure"), badgesFor("myaccount.blob.core.chinacloudapi.cn").join("|"));

  // The look-alike control: the suffix must match at a LABEL boundary, or a domain anybody can register
  // would wear Microsoft's name in the operator's own destination list. One per cloud again, because the
  // pattern is built by joining the three suffixes and a mistake in the join would only show on one of
  // them.
  // THE ACCOUNT LABEL IS PART OF THE VECTOR, and it is what makes this grade the END ANCHOR rather than
  // the leading one. "blob.core.windows.net.evil.example" has no dot before "blob", so it is already
  // refused by the leading boundary and a matcher with no "$" would pass this test unchanged: a
  // build with the "$" deleted would survive exactly that vector. The account-prefixed form is the domain an
  // attacker would actually register, and it is the one only the end anchor refuses.
  const appended = badgesFor("myaccount.blob.core.windows.net.evil.example");
  ok("a host that merely CONTAINS the Azure host is not badged Azure", !appended.includes("Azure"), appended.join("|"));
  ok("...and is badged S3 instead, so the look-alike is still SHOWN rather than dropped", appended.includes("S3"), appended.join("|"));
  const appendedGov = badgesFor("myaccount.blob.core.usgovcloudapi.net.evil.example");
  ok("the same trailing-domain trick fails on the US Government suffix too", !appendedGov.includes("Azure"), appendedGov.join("|"));
  const appendedCn = badgesFor("myaccount.blob.core.chinacloudapi.cn.evil.example");
  ok("...and on the China-cloud suffix", !appendedCn.includes("Azure"), appendedCn.join("|"));
  // The bare form is kept as well, because it is what the LEADING boundary refuses and the two anchors
  // fail in different directions.
  const bare = badgesFor("blob.core.windows.net.evil.example");
  ok("a host with no account label in front of the Azure host is not badged Azure either", !bare.includes("Azure"), bare.join("|"));
  // The second look-alike is the one that grades the leading DOT. "notblob.core.windows.net" ends with the
  // Azure host as a string and is not an Azure account, so a suffix match written without the label
  // boundary would badge it Azure while this one is written correctly.
  const noBoundary = badgesFor("notblob.core.windows.net");
  ok("a host whose last label is not the account is not badged Azure either", !noBoundary.includes("Azure"), noBoundary.join("|"));
  const noBoundaryGov = badgesFor("notblob.core.usgovcloudapi.net");
  ok("...and the same on the US Government suffix", !noBoundaryGov.includes("Azure"), noBoundaryGov.join("|"));
  const noBoundaryCn = badgesFor("notblob.core.chinacloudapi.cn");
  ok("...and on the China-cloud suffix", !noBoundaryCn.includes("Azure"), noBoundaryCn.join("|"));
  // The DFS endpoint is Azure Data Lake Storage Gen2, which the engine refuses outright as a different
  // wire protocol. It is not a blob host, so it must not wear the Azure badge either: a badge saying the
  // archives are in Azure Blob Storage over an endpoint downpipes cannot write to would be the wrong
  // sentence twice.
  const dfs = badgesFor("myaccount.dfs.core.windows.net");
  ok("an ADLS Gen2 dfs host is not badged Azure: it is a different protocol the engine refuses", !dfs.includes("Azure"), dfs.join("|"));
  // A cloud that is NOT in the closed list must not be admitted, or the matcher would be a loose
  // "anything under core.*" rather than the three suffixes the engine names. Microsoft Cloud Germany
  // closed in 2021 and is deliberately absent from both lists.
  const germany = badgesFor("myaccount.blob.core.cloudapi.de");
  ok("a cloud outside the closed list is not badged Azure, so the matcher is the list and not a wildcard", !germany.includes("Azure"), germany.join("|"));
}

console.log(failures === 0 ? "\nDESTINATION AZURE PROVIDER PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
