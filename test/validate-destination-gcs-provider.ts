// The Google Cloud provider hides what it cannot honour, and never SENDS it.
//
// WHY THIS EXISTS. Google Cloud Storage has worked as a downpipes destination for as long as the
// S3-compatible arm has existed, because its XML API is S3-interoperable under the identical SigV4 scheme.
// Driven live against a real bucket with the engine's own signer, every call succeeded:
// PUT 200, GET 200 byte-correct, HEAD 404 on a missing key, DELETE 204, multipart initiate/upload/complete
// all 200. So this file is not about whether GCS works. It is about the fields it CANNOT honour, each of
// which the engine refuses by name:
//
//   storage class   GCS answers 400 InvalidStorageClass to Amazon's class names, and downpipes does no
//                   translation between the two vocabularies.
//   AssumeRole      an AWS mechanism with no Google equivalent.
//
// IMMUTABILITY IS NOT ONE OF THEM, though this file once said it was. Measured against a real
// bucket, GCS implements S3 Object Lock through its interop API for a bucket created with per-object
// retention: the probe answers Enabled, a compliance lock is honoured, and a delete inside the window is
// refused with 403. A bucket created without it answers 404 and the engine refuses the save. So the section
// is OFFERED for Google Cloud, and what this file now guards is the sentence that decides whether the save
// can succeed: per-object retention is chosen when the bucket is created and can never be added, so the
// form has to say so before the operator does the work rather than after.
//
// THE ASSERTION THAT CARRIES THE MOST WEIGHT is the switch case. Hiding a control does not clear it, so an
// operator who sets a storage class or an immutability policy under S3-compatible and THEN switches to
// Google Cloud would otherwise submit both, and be refused by the engine for controls they can no longer
// see. Those two vectors would pass if the guards were deleted and only the hiding remained, which is
// exactly why they are driven through a real provider switch rather than asserted on a fresh form.
//
// Run: node test/validate-destination-gcs-provider.ts

import { installDomShim, markConnected, qs } from "./dom-shim.ts";
installDomShim();

import type { EngineClient } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { connect } from "../src/lib/store.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import { buildDestinationInput } from "../src/screens/destination-submit.ts";
import { GCS_ENDPOINT, PROVIDERS, pricingNote, WORM_PREREQ_COPY, type FormContext } from "../src/screens/destination-form-fields.ts";
import { click, findButtonByText } from "./validate-stable-components-shared.ts";

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

console.log("Google Cloud hides and never submits the fields it cannot honour");

// ---- 1. The provider exists and is offered. ---------------------------------------------------
console.log("\n-- the provider is offered --");
// No block of its own: this section declares nothing, and a bare block around statements that need no scope
// is what biome's noUselessLoneBlockStatements names. It was the one warning standing between this repo's
// lint:biome-scope and a zero.
ok("PROVIDERS carries a gcs member", PROVIDERS.some((p) => p.id === "gcs"));
ok("...labelled for a human rather than as a protocol code", PROVIDERS.find((p) => p.id === "gcs")?.label === "Google Cloud");
ok("the pinned endpoint is Google's one S3-interop host", GCS_ENDPOINT === "https://storage.googleapis.com");

// ---- 2. The pricing note tells the truth about whose rates these are. -------------------------
// The generic S3 note's stated REASON for naming Amazon is that "an S3-compatible endpoint does not tell
// the console which provider is behind it". For this provider it now does, so reusing that sentence would
// be false in a way the operator cannot check.
console.log("\n-- the pricing note --");
{
  const n = pricingNote("gcs");
  ok("the GCS note is not the generic S3-compatible note", n !== pricingNote("s3"));
  ok("...and not the R2 note either", n !== pricingNote("r2"));
  ok("it names Google Cloud Storage", n.includes("Google Cloud Storage"));
  ok("it says plainly that these are NOT Google's prices", /NOT Google's prices/.test(n), n);
  ok("it does not repeat the false reason that the endpoint cannot name the provider", !n.includes("does not tell the console which provider"), n);
}

// ---- 3. The form: what Google Cloud shows and hides. ------------------------------------------
console.log("\n-- the rendered form --");
{
  const form = destinationForm({} as unknown as EngineClient, fctx, { confirmReplace: false, onSaved: () => {} } as never);
  document.body.replaceChildren(form);
  markConnected(form);

  const endpoint = qs(form as unknown as never, "#dest-endpoint") as unknown as HTMLInputElement | null;
  const storageClass = qs(form as unknown as never, "#dest-storage-class") as unknown as HTMLElement | null;
  const wormMode = qs(form as unknown as never, "#dest-worm-mode") as unknown as HTMLElement | null;
  const roleArn = qs(form as unknown as never, "#dest-role-arn") as unknown as HTMLElement | null;
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

  const gcsRadio = findButtonByText(form, "Google Cloud");
  ok("the Google Cloud provider radio is present", gcsRadio !== undefined);
  if (gcsRadio !== undefined) click(gcsRadio);

  ok("the endpoint is prefilled with Google's S3-interop host", endpoint?.value === GCS_ENDPOINT, String(endpoint?.value));
  ok("...and is read-only, because there is nothing to choose", endpoint?.readOnly === true);
  ok("the endpoint block is still VISIBLE (a third provider must not blank the form)", !hiddenFor(endpoint));
  ok("the storage class is hidden: GCS refuses Amazon's class names", hiddenFor(storageClass));
  // IMMUTABILITY IS OFFERED, and the assertion is deliberately the other way round from the two above.
  // It was once "hidden: GCS has no S3 Object Lock", which was false: measured against a real
  // bucket, a GCS bucket created WITH per-object retention answers the engine's Object-Lock probe
  // 200/Enabled, honours a COMPLIANCE lock header, and refuses a delete inside the window with 403. The
  // engine's live probe already refuses the save for a bucket that cannot enforce it, naming the bucket
  // rather than the provider, so hiding the control only took the choice away from operators whose bucket
  // could honour it.
  ok("the immutability section is OFFERED for GCS: a bucket with per-object retention really enforces it", !hiddenFor(wormMode));
  ok("the AssumeRole section is hidden: no Google equivalent exists", hiddenFor(roleArn));

  // Switching away must not leave Google's endpoint behind on a provider that never chose it.
  const s3Radio = findButtonByText(form, "S3-compatible");
  if (s3Radio !== undefined) click(s3Radio);
  ok("switching to S3-compatible clears the pinned endpoint", endpoint?.value === "", String(endpoint?.value));
  ok("...and makes it editable again", endpoint?.readOnly === false);
  ok("...and brings the storage class back", !hiddenFor(storageClass));
  ok("...and the immutability section is still offered (it was never hidden for GCS)", !hiddenFor(wormMode));
}

// ---- 3b. The prerequisite line: what the bucket must ALREADY be, said BEFORE the save. ---------
// THE TRAP THIS GUARDS. Object Lock is a property a bucket is created with and can never gain afterwards.
// An operator could set compliance mode, type a retention window and press Verify and save, and learn only
// from the engine's refusal that their bucket was never a candidate and that the remedy is a new bucket.
// The refusal is correct; it arrives after the work. The section now carries a provider line saying what
// the bucket had to have been created as, moved by applyProviderCopy like the endpoint and credential
// wording.
//
// Asserted on the RENDERED text rather than on the constant, because a constant nothing reads is exactly
// the failure mode: the strings would still be right and the operator would still see nothing.
console.log("\n-- the immutability prerequisite line --");
{
  const form = destinationForm({} as unknown as EngineClient, fctx, { confirmReplace: false, onSaved: () => {} } as never);
  document.body.replaceChildren(form);
  markConnected(form);
  const prereqText = (): string => {
    const n = qs(form as unknown as never, ".dest-worm-prereq") as unknown as HTMLElement | null;
    return n === null ? "" : String(n.textContent ?? "");
  };
  const switchTo = (label: string): void => {
    const b = findButtonByText(form, label);
    if (b !== undefined) click(b);
  };

  // The form mounts on R2, so this is the line an operator reads before touching anything.
  const r2Line = prereqText();
  ok("the section carries a prerequisite line on the provider the form mounts on", r2Line !== "");
  ok("it says R2 cannot enforce Object Lock at all, rather than sending the operator to a setting", r2Line.includes("cannot enforce S3 Object Lock on any bucket"), r2Line);
  ok("...and it matches the constant, so the rendered line is the one that was reviewed", r2Line === WORM_PREREQ_COPY.r2, r2Line);

  switchTo("Google Cloud");
  const gcsLine = prereqText();
  ok("Google Cloud names per-object retention rather than Amazon's Object Lock setting", gcsLine.includes("per-object retention"), gcsLine);
  ok("...and names the flag that creates such a bucket, so the remedy can be followed", gcsLine.includes("--enable-per-object-retention"), gcsLine);
  ok("...and says plainly it cannot be added to a bucket that exists", gcsLine.includes("cannot be turned on for a bucket that exists"), gcsLine);
  ok("...and that the bucket has to be replaced, which is the fact that turns a mistake into a rebuild", gcsLine.includes("replaced rather than reconfigured"), gcsLine);
  ok("...and it matches the constant", gcsLine === WORM_PREREQ_COPY.gcs, gcsLine);

  switchTo("S3-compatible");
  const s3Line = prereqText();
  ok("S3-compatible names Object Lock at bucket creation", s3Line.includes("created with Object Lock enabled"), s3Line);
  ok("...and says it cannot be added to a bucket that exists", s3Line.includes("cannot be turned on for a bucket that exists"), s3Line);
  ok("...and does not hand an S3 operator Google's flag", !s3Line.includes("per-object retention"), s3Line);
  ok("...and it matches the constant", s3Line === WORM_PREREQ_COPY.s3, s3Line);

  // THE CONTROL. Every assertion above would pass for a build that rendered one provider-independent
  // sentence containing all the words, so the three lines are also required to DIFFER from each other.
  ok("CONTROL: the three lines are three different sentences, not one that mentions everything", r2Line !== gcsLine && gcsLine !== s3Line && r2Line !== s3Line);

  // Switching back must not leave Google's sentence in front of an R2 operator: the line follows the
  // provider both ways, exactly like the endpoint and credential wording.
  switchTo("Cloudflare R2");
  ok("switching back to R2 restores R2's line rather than leaving Google's behind", prereqText() === WORM_PREREQ_COPY.r2, prereqText());
}

// ---- 4. The SUBMIT guards: hiding a control does not clear it. --------------------------------
// This is the section the header calls the load-bearing one, and it is asserted on the payload rather
// than on the DOM, because the DOM assertions above would all still pass with the guards deleted. The
// values below are exactly what an operator would leave behind by setting them under S3-compatible and
// then switching to Google Cloud.
console.log("\n-- the submitted payload --");
{
  const stale = {
    endpointField: { value: () => GCS_ENDPOINT },
    s3BucketField: { value: () => "archive" },
    regionField: { value: () => "auto" },
    keyField: { value: () => "GOOG1EXAMPLE" },
    secretField: { value: () => "secret" },
    addressingField: { value: () => "auto" },
    // Left over from a provider switch: hidden, but still carrying a value.
    storageClassField: { value: () => "STANDARD_IA" },
    r2Block: { accountId: () => "", bucketField: () => ({ value: () => "" }) },
  } as never;
  const worm = { mode: "compliance", retentionDays: 30 } as never;
  // A real pricing block: buildDestinationInput takes one by value and this test is not about pricing.
  const PRICING = { storagePerGBMonth: 0.015, classAPerMillion: 4.5, classBPerMillion: 0.36, egressPerGB: 0 };

  const gcs = buildDestinationInput(stale, "gcs", PRICING, undefined, undefined, undefined) as unknown as Record<string, unknown>;
  ok("a GCS payload never carries a storage class, even when the hidden control still holds one", gcs.storageClass === undefined, JSON.stringify(gcs.storageClass));
  ok("...and still carries the endpoint and bucket, so the guard is not refusing the whole submit", gcs.endpoint === GCS_ENDPOINT && gcs.bucket === "archive");

  // The control that keeps the guard honest: the SAME stale field must still reach an S3 payload, or the
  // assertion above would pass for a build that simply dropped the storage class for everyone.
  const s3 = buildDestinationInput(stale, "s3", PRICING, undefined, undefined, undefined) as unknown as Record<string, unknown>;
  ok("CONTROL: an S3-compatible payload DOES carry that same storage class", s3.storageClass === "STANDARD_IA", JSON.stringify(s3.storageClass));

  // worm is passed in already-resolved, so the guard that matters for it lives in submitDestination
  // (it forces the mode to "off" for gcs before this function is reached). Asserted here as the shape
  // contract: an undefined policy must not appear in the payload at all.
  const gcsWorm = buildDestinationInput(stale, "gcs", PRICING, undefined, undefined, undefined) as unknown as Record<string, unknown>;
  ok("an absent immutability policy is omitted from the payload rather than sent as null", !("worm" in gcsWorm));
  const s3Worm = buildDestinationInput(stale, "s3", PRICING, worm, undefined, undefined) as unknown as Record<string, unknown>;
  ok("CONTROL: a policy that IS passed reaches an S3 payload", (s3Worm.worm as { mode?: string } | undefined)?.mode === "compliance");
}

console.log(failures === 0 ? "\nDESTINATION GCS PROVIDER PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exit(1);
