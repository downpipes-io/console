// The destination form must say WHOSE list prices it prefilled.
// Run with: node test/validate-destination-pricing-provenance.ts
//
// WHY THIS EXISTS. providerPricing maps the form's two providers to cost-model presets, and the second
// provider is labelled "S3-compatible", which is a protocol rather than a vendor. The endpoint does not
// say whether the bucket is at Amazon, at Backblaze, at Wasabi, or on a MinIO cluster, so the only preset
// the library has for the protocol is Amazon's. The form used to prefill Amazon's four rates and describe
// them as "the provider's indicative public pricing", which is a false statement about the operator's own
// destination whenever the destination is not Amazon S3. The rate term is most of what the cost estimate
// computes, so a customer comparing a cheaper destination read a number that was not about their
// destination at all. The costs screen has always labelled the same preset "Amazon S3 Standard", so the
// product carried one honest label and one false one for the same figures.
//
// The assertions below are about the REQUIREMENT, not the wording: the vendor the note names must be the
// vendor whose preset providerPricing actually returns, and the note must move with the prefill when the
// operator switches provider. It renders the REAL form and clicks the REAL radio.

import { installDomShim, markConnected, qs } from "./dom-shim.ts";

installDomShim();

import type { EngineClient } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { connect } from "../src/lib/store.ts";
import { PRESETS } from "../src/lib/cost-model.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import { pricingNote, providerPricing, type FormContext } from "../src/screens/destination-form-fields.ts";
import { SN, click, findButtonByText } from "./validate-stable-components-shared.ts";

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

console.log("the prefilled rates name the vendor they came from");

// ---- 1. The note names the vendor whose preset is actually applied. ----------------------------
// This is the requirement. It is asserted against providerPricing's own return value rather than
// against a copy of the rates, so it stays true if the presets are ever re-tuned, and it fails the
// moment the note names one vendor while the prefill comes from another.
console.log("\n-- the named vendor is the applied preset --");
{
  const s3Note = pricingNote("s3");
  const r2Note = pricingNote("r2");
  ok("S3-compatible prefills the Amazon S3 Standard preset", providerPricing("s3") === PRESETS["s3-standard"]);
  ok("and the note NAMES Amazon S3, so the operator can see whose prices these are", s3Note.includes("Amazon S3 Standard"), s3Note);
  ok("R2 prefills the Cloudflare R2 preset", providerPricing("r2") === PRESETS.r2);
  ok("and the note names Cloudflare R2", r2Note.includes("Cloudflare R2"), r2Note);
  ok("the R2 note does not name Amazon, whose preset it does not use", !r2Note.includes("Amazon"), r2Note);
}

// ---- 2. The note must not describe one vendor's prices as the operator's provider's. -----------
// The exact false statement this file exists to stop. "the provider's" over Amazon's numbers reads,
// to someone adding a Backblaze or Wasabi bucket, as a claim about their own bill.
console.log("\n-- the false statement is gone and stays gone --");
{
  const s3Note = pricingNote("s3");
  ok("the S3 note never calls Amazon's rates 'the provider's' pricing", !s3Note.includes("the provider's"), s3Note);
  ok("it says plainly that the endpoint does not identify the provider", s3Note.includes("does not tell the console which provider"), s3Note);
  ok("it tells the operator the rates are not theirs unless the destination IS Amazon S3", s3Note.includes("not Amazon S3"), s3Note);
  ok("it asks for their own rates before the estimate is read", s3Note.toLowerCase().includes("replace them with your own rates"), s3Note);
  // Cloudflare is a partner and the copy must not disparage anyone. The comparison is stated as a
  // fact about what other S3-compatible providers may charge, which is the honest direction even
  // though it makes destinations other than R2 look cheaper.
  ok("the comparison is stated without naming a competitor to disparage", !s3Note.includes("cheaper than") && !s3Note.includes("expensive"), s3Note);
}

// ---- 3. It reaches the DOM, and it MOVES when the prefill moves. -------------------------------
// A correct string that the form never renders, or renders once and leaves behind when the operator
// switches provider, is how the mislabelling survived in the first place.
console.log("\n-- the rendered note follows the provider --");
{
  const form = destinationForm({} as unknown as EngineClient, fctx, { confirmReplace: false, onSaved: () => {} } as never);
  document.body.replaceChildren(form);
  markConnected(form);

  // Addressed by its own class, not by ".note-quiet": the form renders another quiet note (the
  // archive-into-a-source warn) and a first-match selector reads that one instead.
  const noteEl = qs(form as unknown as never, ".dest-price-note");
  ok("the pricing block renders a note", noteEl !== null);
  const readNote = (): string => (noteEl === null ? "" : (SN(noteEl).textContent ?? ""));

  ok("the form mounts on R2 and shows the R2 note", readNote() === pricingNote("r2"), readNote());

  const s3Radio = findButtonByText(form, "S3-compatible");
  ok("the S3-compatible provider radio is present", s3Radio !== undefined);
  if (s3Radio !== undefined) click(s3Radio);
  ok("switching to S3-compatible switches the note to the Amazon wording", readNote() === pricingNote("s3"), readNote());
  ok("the rendered note names Amazon S3 once the S3 rates are in the boxes", readNote().includes("Amazon S3 Standard"), readNote());

  const r2Radio = findButtonByText(form, "Cloudflare R2");
  ok("the Cloudflare R2 provider radio is present", r2Radio !== undefined);
  if (r2Radio !== undefined) click(r2Radio);
  ok("switching back restores the R2 note, so the note is not one-way", readNote() === pricingNote("r2"), readNote());
}

console.log(failures === 0 ? "\nDESTINATION PRICING PROVENANCE PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
