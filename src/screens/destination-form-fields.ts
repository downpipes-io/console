// The destination setup form's field-group builders, split out of destinations.ts so the
// screen file stays a thin wiring layer (guardrail: file size + function size). Each
// build* function returns one cohesive field group plus the handles the form's wiring
// reaches for; the form (destinationForm) composes them and owns only the cross-field
// state (the live provider, setProvider, the pricing-edited flag). Behaviour is unchanged:
// this module MOVES the builders verbatim, it does not rewrite any of them.
//
// No-custody invariants kept: the secret access key is a password input, sent once over
// the authenticated same-origin channel, never persisted client-side, never re-displayed;
// every server string enters the DOM via textContent / the typed h() builder.

import { recordReadDegraded } from "../lib/client-diag/ring.ts";
import { h } from "../lib/dom.ts";
import { collapsedSection } from "./common.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { noteQuiet } from "../components/feedback.ts";
import { field } from "../components/field.ts";
import { nonNegativeRate, wholeNumberAtLeast, wholeNumberBetween } from "../components/field-bounds.ts";
import { openModal } from "../components/modal.ts";
import type { DestinationPricing, EngineClient, WormStatus } from "../api.ts";
import { PRESETS, type Pricing } from "../lib/cost-model.ts";
import { goSignedOut } from "../lib/nav.ts";
// The shared labelled-checkbox row, imported from its one home rather than re-implemented here. The
// restore flow already reaches for it the same way (screens/restore-flow/flow.ts), so this is the house
// idiom for a checkbox with a label and a secondary explanation, not a new dependency direction.
import { checkboxRow } from "./notifications/shared.ts";
// Provider now lives in lib/api/types/destinations.ts (the union's own rationale is there): a screen
// pulls in the whole api.ts barrel, so defining it here and importing it back into that barrel's leaf
// type modules closed a madge cycle. Re-exported so this module's existing importers are unaffected.
import type { Provider } from "../lib/api/types/destinations.ts";
export type { Provider };

// The destination providers the form offers, in display order.
export const PROVIDERS: ReadonlyArray<{ id: Provider; label: string }> = [
  { id: "r2", label: "Cloudflare R2" },
  { id: "s3", label: "S3-compatible" },
  { id: "gcs", label: "Google Cloud" },
  { id: "azure", label: "Azure Blob" },
];

// GCS_ENDPOINT is Google Cloud Storage's one S3-interop endpoint. GCS does not use a per-bucket or
// per-region host for it, so the operator has nothing to choose and the field is prefilled and read-only
// rather than left as free text that can only be typed wrong.
export const GCS_ENDPOINT = "https://storage.googleapis.com";

// AZURE_ENDPOINT_PLACEHOLDER is the SHAPE of an Azure Blob endpoint, not a value to pin.
//
// This is the difference from GCS that matters to the form. Google publishes one interop host for every
// bucket in the world, so its field is prefilled and read-only. Azure's blob endpoint carries the storage
// ACCOUNT as its first label, so it is different for every operator and there is nothing the console can
// fill in for them: the field stays editable and the placeholder shows the shape instead.
export const AZURE_ENDPOINT_PLACEHOLDER = "https://mystorageaccount.blob.core.windows.net";

// r2Endpoint derives the S3-compatible endpoint for an R2 bucket from the account id
// (R2 is reached through its S3 endpoint; DestinationInput is always S3-shaped).
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

// endpointShapeError mirrors the engine's own SHAPE rules for a destination endpoint, so an endpoint the
// form accepts is not thrown away at submit. The old rule was startsWith("https://"), which is looser than
// the engine in two ways, both driven against engine main through the production handleAdmin:
//
//   - the literal "https://" (or any value with no host after the scheme) fails the engine's
//     /^https:\/\/[^\s]+$/ at engine/src/admin/router-destinations.ts:71 and comes back 400 "the destination
//     endpoint must be an https URL". The report of this defect blamed new URL(); it never gets that far;
//   - "https://[" and "https://%zz" DO pass that pattern and then throw inside new URL() at
//     engine/src/admin/router-destinations.ts:85, coming back 400 "must be a valid https URL".
//
// So both engine shape checks are mirrored, in the engine's order, and the parse uses the same new URL()
// the engine uses rather than a second pattern that would drift from it.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM. The engine also refuses an endpoint whose host classifies as
// internal, private, loopback or link-local (its SSRF guard, router-destinations.ts:89), and it then PROVES
// the destination reachable and writable with a live probe. Neither is mirrored: the console cannot resolve
// a host or reach the provider, so a rule here would be a guess, and the hint already says the endpoint is
// proven by a live probe at save rather than by a format check.
function endpointShapeError(v: string): string | null {
  if (!/^https:\/\/[^\s]+$/.test(v)) return "Endpoint must be an https URL with a host, for example https://s3.example.com.";
  try {
    new URL(v);
  } catch {
    return "That is not a URL your engine can parse. Check for a stray bracket or an unfinished % escape.";
  }
  return null;
}

// FormContext is the best-effort helper data the form improves with: the engine
// account id (derives the R2 endpoint), the engine account's R2 bucket names (a select
// instead of free text), and the bucket names already backed up as r2 sources (the
// archive-into-a-source warn). Every field degrades honestly when absent.
export interface FormContext {
  engineAccountId: string | null;
  engineR2Buckets: string[];
  sourceR2Buckets: Set<string>;
  // Whether each read actually SUCCEEDED, carried separately from its result. An empty bucket list and a
  // list that could not be read are different facts, and the form used to render them identically: the
  // operator saw the select replaced by a free-text account id and asked support why the bucket dropdown
  // had vanished. The form now states which one it is (buildR2Block below).
  discoveryRead: boolean;
  downpipesRead: boolean;
}

// loadFormContext resolves discovery + the downpipe list in parallel, tolerating failure of either (the
// form falls back to plain inputs / skips the warn rather than guessing) and RECORDING which of the two
// reads failed, so the fallback is stated rather than silently presented as the normal form. A 401 on
// either routes to signed-out and returns null.
export async function loadFormContext(engine: EngineClient): Promise<FormContext | null> {
  const [disc, pipes] = await Promise.allSettled([engine.discoverSources(), engine.listDownpipes()]);
  if (
    (disc.status === "rejected" && isUnauthorised(disc.reason)) ||
    (pipes.status === "rejected" && isUnauthorised(pipes.reason))
  ) {
    goSignedOut();
    return null;
  }

  let engineAccountId: string | null = null;
  let engineR2Buckets: string[] = [];
  if (disc.status === "fulfilled") {
    engineAccountId = disc.value.engineAccountId ?? null;
    const acct = (disc.value.accounts ?? []).find((a) => a.accountId === engineAccountId);
    if (acct) engineR2Buckets = acct.r2.map((b) => b.name);
  }

  const sourceR2Buckets = new Set<string>();
  if (pipes.status === "fulfilled") {
    for (const dp of pipes.value) {
      const src = dp.config.source;
      if (src.type === "r2" && typeof src.bucketName === "string" && src.bucketName !== "") {
        sourceR2Buckets.add(src.bucketName);
      }
    }
  }

  return {
    engineAccountId,
    engineR2Buckets,
    sourceR2Buckets,
    discoveryRead: disc.status === "fulfilled",
    downpipesRead: pipes.status === "fulfilled",
  };
}

// DestinationFormOpts is the shared option bag the form and its extracted builders take.
// confirmReplace runs the replace confirm BEFORE the save (the console-replace path names
// its consequence); onSaved re-renders the screen from the engine's fresh truth; the
// initial* fields prefill an edit/replace.
export interface DestinationFormOpts {
  confirmReplace: boolean;
  onSaved: () => void;
  editId?: string;
  initialLabel?: string;
  initialPricing?: DestinationPricing;
  initialWorm?: WormStatus;
  initialAuthRoleArn?: string;
  // The stored Entra principal, so the edit form can show it. Same reason as initialAuthRoleArn above.
  initialAzureEntra?: { tenantId: string; clientId: string };
  initialAddressing?: "auto" | "path" | "vhost";
  initialStorageClass?: string;
}

// providerPricing maps a provider to its indicative preset rates (the cost-model presets).
//
// THE SECOND BRANCH IS AMAZON'S PRICE LIST, NOT "the provider's". "S3-compatible" is a protocol,
// not a vendor: the endpoint alone does not say whether the bucket is at Amazon, at Backblaze, at
// Wasabi, or on a MinIO cluster in a rack. There is nothing to map from, so this returns the one
// preset the cost library has for the protocol, and the pricing block SAYS SO (pricingNote below).
// It used to say "the provider's indicative public pricing" over Amazon's numbers, which is a false
// statement about the operator's own destination whenever the destination is not Amazon S3, and the
// rate term is most of what the cost estimate computes. The costs screen labels the identical preset
// "Amazon S3 Standard" (screens/costs/pricing-section.ts), so the product held one honest label and
// one false one for the same fifteen numbers.
//
// Naming more vendors here would not fix it. No rate in PRESETS carries a source, a checked-on date,
// or a gate, and the non-Cloudflare storage market repriced twice in the two months to,
// so a longer preset list is more unwitnessed numbers going stale, not more accuracy. The honest
// move is to say whose price this is and to tell the operator to replace it.
export const providerPricing = (p: Provider): Pricing => (p === "r2" ? PRESETS.r2 : PRESETS["s3-standard"]);

// pricingNote is the prefill's provenance, in the words the operator reads. It is provider-aware
// because the prefill is: setProvider rewrites the four rate boxes when the operator switches, and
// a note that did not move with them is how the mislabelling survived. It describes the PREFILL
// rather than the boxes' current contents, so it stays true after the operator edits a rate and on
// the edit form, where the rates loaded are already the operator's own.
export function pricingNote(p: Provider): string {
  if (p === "r2") {
    return "Used only by the cost estimate, never by backups. The prefill is Cloudflare R2 list pricing; edit it to your contracted rates.";
  }
  // GCS gets its own sentence rather than the generic S3 one. The generic note's reason for naming Amazon
  // is that "an S3-compatible endpoint does not tell the console which provider is behind it", and for
  // this provider it now does. Saying otherwise here would be false in a way the operator cannot check.
  //
  // The rates are still Amazon's, and that is stated rather than fixed. No rate in PRESETS carries a
  // source or a checked-on date, and the non-Cloudflare storage market repriced twice in the two months
  // to, so adding an unwitnessed GCS preset would be a number that reads authoritative and
  // goes stale, which is worse than a named borrowing the operator is told to replace.
  if (p === "gcs") {
    return "Used only by the cost estimate, never by backups. The prefill is Amazon S3 Standard list pricing, borrowed because this console carries no Google Cloud Storage rates: these are NOT Google's prices. Google charges differently to store and to egress, so replace all four with your own rates from the Google Cloud price list before you read the cost estimate.";
  }
  // Azure gets its own sentence for the same reason Google does, and the borrowing is stated for the same
  // reason: no rate in PRESETS carries a source or a checked-on date, so an unwitnessed Azure preset would
  // be a number that reads authoritative and goes stale. Azure's own vocabulary differs further than
  // Google's does (it prices by access tier and bills operations in units of ten thousand rather than of a
  // million), which is another reason not to invent a mapping the console cannot check.
  if (p === "azure") {
    return "Used only by the cost estimate, never by backups. The prefill is Amazon S3 Standard list pricing, borrowed because this console carries no Azure Blob Storage rates: these are NOT Microsoft's prices. Azure prices by access tier and counts operations differently, so replace all four with your own rates from the Azure Blob Storage price list before you read the cost estimate.";
  }
  return "Used only by the cost estimate, never by backups. The prefill is Amazon S3 Standard list pricing, because an S3-compatible endpoint does not tell the console which provider is behind it. If your destination is not Amazon S3 then those rates are not yours, and another provider may charge less to store and nothing to egress. Replace them with your own rates before you read the cost estimate.";
}

// FieldHandle is the bit of a field() the form's wiring reaches for (value / clearError /
// the control element). field() returns more; this is the narrow slice the builders pass
// back so submit and setProvider can read and reset them.
export type FieldHandle = ReturnType<typeof field>;

// buildProviderSeg builds the two-option segmented radiogroup (the same control the
// source-type pickers use), R2 first as the default. getProvider/setProvider keep the
// roving-tabindex arrow handler reading the live selection without owning it.
export function buildProviderSeg(getProvider: () => Provider, setProvider: (p: Provider) => void): { seg: HTMLElement; segButtons: Map<Provider, HTMLButtonElement> } {
  const seg = h("div", { class: "type-seg", role: "radiogroup", "aria-label": "Provider", style: "grid-template-columns:repeat(2,1fr)" });
  const segButtons = new Map<Provider, HTMLButtonElement>();
  for (const p of PROVIDERS) {
    const checked = p.id === getProvider();
    const btn = h(
      "button",
      { "data-dp": "destination-form-fields.radio.set-provider", class: "type-seg__btn", type: "button", role: "radio", "aria-checked": checked ? "true" : "false", tabindex: checked ? "0" : "-1" },
      p.label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => setProvider(p.id));
    segButtons.set(p.id, btn);
    seg.appendChild(btn);
  }
  // Roving-tabindex arrow-key handler for the radiogroup (matching the source pickers).
  seg.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
    const order = PROVIDERS.map((p) => p.id);
    const idx = order.indexOf(getProvider());
    let next = idx;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (idx + 1) % order.length;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (idx - 1 + order.length) % order.length;
    else if (ev.key === "Home") next = 0;
    else next = order.length - 1;
    ev.preventDefault();
    setProvider(order[next]!);
    segButtons.get(order[next]!)!.focus();
  });
  return { seg, segButtons };
}

// R2Block is what buildR2Block hands back. The three accessors are FUNCTIONS rather than values because
// the block now has two live states (see buildR2Block): which bucket control is mounted, whether the
// Account ID is answerable, and which account the endpoint derives from all change while the form is open.
// Returning the handles by value is what made the previous shape wrong by construction: destination-submit
// captured `accountIdField` once, at build time, and there was no way for it to become non-null later.
export interface R2Block {
  block: HTMLElement;
  // The bucket control the operator is CURRENTLY using. The discovery select and the free-text input are
  // two field() instances that share the id dest-r2-bucket, and exactly one is mounted at any moment, so
  // the id stays unique in the document.
  bucketField: () => FieldHandle;
  // The Account ID field while it is answerable (discovery could not name the engine account, or the
  // operator has asked for a different one), else null. The form validates it only when it is non-null.
  accountIdField: () => FieldHandle | null;
  // The account id the endpoint derives from, given the live state above.
  accountId: () => string;
  circNote: HTMLElement;
}

// buildR2Block builds the R2 variant: bucket (a select when discovery lists the engine
// account's buckets, else free text), the account id, and the DERIVED endpoint stated
// plainly. Region is fixed to auto (no field). The circular-archive warn is wired off
// updateCircWarn (the live provider + bucket value).
//
// THE DEFAULT IS UNCHANGED, and deliberately so: when discovery names the engine account there is no
// Account ID to type, the bucket is chosen from that account's real buckets, and the block states the
// endpoint the writes go to. That simplification is worth keeping; typing a 32-character id you have
// already proved you own is a chore, not a safety feature.
//
// WHAT IS NEW is an explicit override, because the simplification had become a CEILING. `accountIdField`
// was null whenever discovery named the engine account, and buildDestinationInput derived the endpoint as
// `r2Endpoint(fctx.engineAccountId ?? accountId)`, so the engine's own account won whenever it was known.
// Once a cf-config discovery token is stored (exactly the state that makes discovery succeed) a destination
// could ONLY be written into the engine's own account: there was no field for another account's id, and an
// R2 API token minted in another account had nowhere to go. With the engine account discovered,
// filling in a bucket and account-B keys posted
// `{"endpoint":"https://<engine-account>.r2.cloudflarestorage.com","bucket":"offsite-archive",...}`, while
// the form stated "Writes go to <engine-account>.r2.cloudflarestorage.com" the whole time. That statement
// was true, which is why nothing looked wrong, and it was not what the operator had asked for.
//
// It matters because a second copy in the SAME Cloudflare account is not a second blast radius. The 3-2-1
// posture the product sells needs the second account reachable from the console, and it was not.
//
// Ticking the override reveals the Account ID and swaps the bucket SELECT back to free text, because the
// engine account's bucket list does not describe another account and offering it there would be a lie.
export function buildR2Block(fctx: FormContext, updateCircWarn: () => void): R2Block {
  const haveBucketList = fctx.engineR2Buckets.length > 0;
  // The discovery select exists only when discovery listed buckets. The free-text input is built
  // unconditionally: it is the default when there is no list, and the override's control when there is.
  const r2BucketSelect = haveBucketList
    ? field({
        id: "dest-r2-bucket",
        label: "Bucket",
        kind: "select",
        required: true,
        options: fctx.engineR2Buckets.map((n) => ({ value: n, label: n })),
        hint: "The engine account's R2 buckets, listed by discovery. Use a bucket separate from any you back up as a source.",
        doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" },
        onInput: () => updateCircWarn(),
      })
    : null;
  const r2BucketInput = field({
    id: "dest-r2-bucket",
    label: "Bucket",
    required: true,
    hint: "The R2 bucket name exactly as the dashboard shows it. Use a bucket separate from any you back up as a source.",
    doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "finding-the-ids-for-a-manual-attach" },
    placeholder: "backups-archive",
    autocomplete: "off",
    onInput: () => updateCircWarn(),
  });
  if (r2BucketSelect) r2BucketSelect.control.classList.add("mono");
  r2BucketInput.control.classList.add("mono");

  // The Account ID is built in every state, because the override can reveal it at any time. Whether the
  // form VALIDATES it is a separate question, answered by accountIdField() below: an unmounted field is
  // never in the list validateForm walks, so a required field nobody can see cannot block a save.
  const accountIdField = field({
    id: "dest-account-id",
    label: "Account ID",
    required: true,
    hint: "dash.cloudflare.com → R2 → the Account ID in the right column. The 32-character id becomes the endpoint host, <account-id>.r2.cloudflarestorage.com.",
    doc: { href: "https://docs.downpipes.io/day-2/data-residency", anchor: "the-honest-relabel-r2-reached-through-its-s3-endpoint" },
    placeholder: "0f2ac7c1b6e0470a…",
    autocomplete: "off",
  });
  accountIdField.control.classList.add("mono");

  // The override tick, offered only when there IS a discovered engine account to override. With no
  // discovered account the Account ID is already the only answer, so a tick would be a control with one
  // meaningful position.
  const otherAccount =
    fctx.engineAccountId !== null
      ? checkboxRow(
          "dest-r2-other-account",
          "This bucket is in a different Cloudflare account",
          "Reveals the Account ID, and takes the bucket name as typed rather than from the engine account's list.",
          false,
        )
      : null;
  const overrideOn = (): boolean => otherAccount?.checked() === true;
  // explicitAccount is true whenever the endpoint must come from the typed Account ID: either discovery
  // could not name an engine account, or the operator has said this bucket is in a different one.
  const explicitAccount = (): boolean => fctx.engineAccountId === null || overrideOn();

  const bucketSlot = h("div");
  const accountSlot = h("div");
  const endpointNote = h("p", { class: "field__hint dest-r2-endpoint-note" });

  // mountOnly puts `node` in `slot`, and does NOTHING AT ALL when it is already the only thing there.
  //
  // The doing-nothing half is the load-bearing half, not an optimisation. replaceChildren runs the DOM's
  // "replace all", which REMOVES the existing children before inserting the new ones, and it does that even
  // when the node handed to it is the node already mounted. Detaching an element removes focus from any
  // control inside it: document.activeElement drops to BODY and the caret leaves the form. paintState runs
  // on every keystroke in the Account ID (it restates the endpoint below the field), so an unconditional
  // replaceChildren meant the field was torn down and re-attached after the FIRST character.
  //
  // Without this guard, ticking the override, clicking
  // Account ID and typing a 32-character id can leave the field holding exactly one character, "9", with
  // document.activeElement back on BODY. Every later keystroke went to the body. That is worse than the
  // defect the override was added to fix, because a field that cannot be filled is not an escape from a
  // field that is not there.
  const mountOnly = (slot: HTMLElement, node: HTMLElement | null): void => {
    const want = node === null ? [] : [node];
    if (slot.childNodes.length === want.length && want.every((n, i) => slot.childNodes[i] === n)) return;
    slot.replaceChildren(...want);
  };

  // paintState mounts the controls the current state calls for and restates the endpoint. It is the single
  // place the two states are expressed, so the note can never disagree with the fields above it. It must
  // stay safe to call on every keystroke, which is what mountOnly above buys.
  const paintState = (): void => {
    // The free-text bucket is used under the override even when a list exists: the list is the ENGINE
    // account's buckets, and this bucket is somewhere else.
    mountOnly(bucketSlot, (r2BucketSelect && !overrideOn() ? r2BucketSelect : r2BucketInput).el);
    mountOnly(accountSlot, explicitAccount() ? accountIdField.el : null);
    const typed = accountIdField.value().trim();
    if (!explicitAccount() && fctx.engineAccountId !== null) {
      endpointNote.replaceChildren(
        document.createTextNode("Writes go to "),
        h("span", { class: "mono" }, r2Endpoint(fctx.engineAccountId)),
        document.createTextNode(" (derived from the engine account; the region is fixed to auto)."),
      );
    } else if (typed !== "") {
      // Under an override the note must name the account the writes ACTUALLY go to. Stating the engine
      // account here is what made the original defect invisible: the sentence was true and answered a
      // question the operator had not asked.
      endpointNote.replaceChildren(
        document.createTextNode("Writes go to "),
        h("span", { class: "mono" }, r2Endpoint(typed)),
        document.createTextNode(" (derived from the Account ID above; the region is fixed to auto)."),
      );
    } else {
      endpointNote.replaceChildren(document.createTextNode("The endpoint is derived from the Account ID; the region is fixed to auto."));
    }
  };
  otherAccount?.el.querySelector("input")?.addEventListener("change", () => {
    paintState();
    // The mounted bucket control changed, so the circular-archive warn is being read off a different value.
    updateCircWarn();
  });
  accountIdField.control.addEventListener("input", () => paintState());
  paintState();

  // The archive-into-a-source warn (advisory, never blocking): shown when the chosen
  // bucket is already an r2 backup SOURCE (from the downpipe list). When that data is
  // unavailable the warn is skipped rather than guessed.
  const circNote = h(
    "div",
    { class: "note-quiet", role: "status", hidden: true },
    h("span", { class: "dot dot--warn", "aria-hidden": "true", style: "flex:none;margin-top:var(--space-1)" }),
    h("p", "This bucket is also a backup source. Backing an archive into itself grows without bound; pick a separate bucket for the archive."),
  );

  // The two FAILED-READ statements. Neither blocks the form (both reads are advisory), but each names the
  // degrade so the operator is not left to infer it: a read that failed is not an account with no buckets,
  // and a safety check that could not run is not a safety check that passed.
  const readNotes: HTMLElement[] = [];
  // The destination form's two ADVISORY reads, recorded as read-degraded rows. Neither blocks the form,
  // and that is exactly the problem: a failed bucket listing leaves the operator TYPING a bucket name into a form
  // that would have offered it (and a typo there points the archive at a bucket that does not exist), and a failed
  // downpipes read silently disables the circular-backup safety check, so an archive written into its own source
  // can be configured with nothing to stop it. A safety check that could not run is not a safety check that passed.
  if (!fctx.discoveryRead) recordReadDegraded("dest-bucket-list", null);
  if (!fctx.downpipesRead) recordReadDegraded("dest-downpipes-list", null);
  if (!fctx.discoveryRead) {
    readNotes.push(
      h("p", { class: "field__hint", role: "status" }, "The engine's account and bucket list could not be read, so the bucket is typed here rather than chosen from a list. This is a failed read, not an empty account; the values you type are used as they are."),
    );
  }
  if (!fctx.downpipesRead) {
    readNotes.push(
      h("p", { class: "field__hint", role: "status" }, "Your downpipes could not be read, so this form cannot check whether the bucket you choose is also one of your backup sources. Confirm it is a separate bucket: backing an archive into its own source grows without bound."),
    );
  }

  const block = h("div", { class: "stack-sm" }, bucketSlot, otherAccount?.el, accountSlot, endpointNote, circNote, ...readNotes);
  return {
    block,
    bucketField: () => (r2BucketSelect && !overrideOn() ? r2BucketSelect : r2BucketInput),
    accountIdField: () => (explicitAccount() ? accountIdField : null),
    // The endpoint's account: the typed override when one is being asked for, else the discovered engine
    // account. Never a fallback FROM the typed id TO the engine account: an operator who ticked the
    // override and left the box empty is refused at the form (destination-submit validates the field this
    // returns), because silently writing into the one account they had just said they did not want is the
    // defect this override exists to remove, wearing a different hat.
    accountId: () => (explicitAccount() ? accountIdField.value().trim() : (fctx.engineAccountId ?? "")),
    circNote,
  };
}

// buildS3Block builds the S3-compatible variant: everything explicit (endpoint, bucket,
// region, addressing style, storage class).
export function buildS3Block(opts: DestinationFormOpts): { block: HTMLElement; endpointField: FieldHandle; s3BucketField: FieldHandle; regionField: FieldHandle; addressingField: FieldHandle; storageClassField: FieldHandle } {
  const endpointField = field({
    id: "dest-endpoint",
    label: S3_ENDPOINT_COPY.label,
    required: true,
    hint: S3_ENDPOINT_COPY.hint,
    doc: { href: "https://docs.downpipes.io/day-2/data-residency", anchor: "you-choose-the-destination-the-engine-reports-it" },
    placeholder: S3_ENDPOINT_COPY.placeholder,
    autocomplete: "off",
    validate: endpointShapeError,
  });
  endpointField.control.classList.add("mono");
  const s3BucketField = field({
    id: "dest-s3-bucket",
    label: "Bucket",
    required: true,
    hint: "The bucket name at the provider. It is proven writable by a live probe at save, not checked for format.",
    doc: { href: "https://docs.downpipes.io/day-2/data-residency", anchor: "you-choose-the-destination-the-engine-reports-it" },
    placeholder: "backups-archive",
    autocomplete: "off",
  });
  s3BucketField.control.classList.add("mono");
  const regionField = field({
    id: "dest-region",
    label: "Region",
    required: true,
    value: "auto",
    placeholder: "us-east-1",
    hint: "Leave as auto unless the provider needs a named region. Under STS AssumeRole it must be the role's real AWS region, never auto.",
    doc: { href: "https://docs.downpipes.io/day-2/data-residency", anchor: "you-choose-the-destination-the-engine-reports-it" },
    autocomplete: "off",
  });
  regionField.control.classList.add("mono");
  // addressing style: how the bucket is placed in the request URL. Auto (the default) picks virtual-hosted
  // for AWS S3 and path-style for everything else; some S3-compatible stores require one form.
  const addressingField = field({
    id: "dest-addressing",
    label: "Addressing style",
    kind: "select",
    value: opts.initialAddressing ?? "auto",
    options: [
      { value: "auto", label: "Auto (recommended)" },
      { value: "path", label: "Path-style (host/bucket/key)" },
      { value: "vhost", label: "Virtual-hosted (bucket.host/key)" },
    ],
    hint: "Auto uses virtual-hosted addressing for AWS S3 and path-style for other stores. Choose path or virtual-hosted only if your store requires one form.",
    doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "addressing-style-and-storage-class" },
  });
  // storage class: a cost lever for cold backups. Only the immediately-readable tiers are offered; the
  // archive tiers (Glacier, Deep Archive) are excluded because they need an async thaw that would break the
  // read-back the engine does at seal time and any restore.
  const storageClassField = field({
    id: "dest-storage-class",
    label: "Storage class",
    kind: "select",
    value: opts.initialStorageClass ?? "",
    options: [
      { value: "", label: "Bucket default" },
      { value: "STANDARD", label: "Standard" },
      { value: "STANDARD_IA", label: "Standard-IA (cheaper, infrequent access)" },
      { value: "INTELLIGENT_TIERING", label: "Intelligent-Tiering (auto, restore-safe)" },
      { value: "ONEZONE_IA", label: "One Zone-IA" },
    ],
    hint: "For an S3-compatible destination. Only Standard, Standard-IA, Intelligent-Tiering and One Zone-IA are accepted; the engine refuses any other tier. Intelligent-Tiering saves on cold backups with no restore-latency risk. Glacier and Deep Archive are not offered, because they need a thaw before the seal-time read-back and any restore.",
    doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "addressing-style-and-storage-class" },
  });
  const block = h("div", { class: "stack-sm" }, endpointField.el, s3BucketField.el, regionField.el, addressingField.el, storageClassField.el);
  return { block, endpointField, s3BucketField, regionField, addressingField, storageClassField };
}

// FieldCopy is the operator-facing wording of one control: what it is called, what the box explains, and
// what an example value looks like. It is a TYPE rather than three loose strings because the provider
// switch has to move all three together: a relabelled box still showing the old placeholder is the state
// that reads most convincingly wrong.
export interface FieldCopy {
  label: string;
  hint: string;
  placeholder: string;
}

// S3_CRED_COPY is the credential pair's wording for every provider that authenticates with an S3-style key
// pair: R2, S3-compatible and Google Cloud (whose HMAC interop keys are that same pair under a different
// name). It is a constant rather than an inline argument because it is also what the form switches BACK to.
export const S3_CRED_COPY: Readonly<{ key: FieldCopy; secret: FieldCopy }> = {
  key: {
    label: "Access Key ID",
    hint: "The Access Key ID half of your R2 or S3 API token, not the secret below.",
    placeholder: "AKIAIOSFODNN7EXAMPLE",
  },
  secret: {
    label: "Secret Access Key",
    hint: "Sent once over the authenticated channel, verified live, then held by your engine. Never re-displayed.",
    placeholder: "paste the secret access key",
  },
};

// AZURE_CRED_COPY is the credential pair's wording for Azure Blob Storage, and it is not cosmetic.
//
// The two boxes carry DIFFERENT THINGS for Azure. The engine reuses the stored credential pair rather than
// adding fields (engine/src/dest/factory.ts), so an Azure destination keeps the storage ACCOUNT NAME in
// accessKeyId and one of that account's ACCESS KEYS in secretAccessKey. That keeps the stored config shape
// and the envelope encryption of the secret byte-identical, and it means the form must say what it is
// actually asking for: Azure issues no "Access Key ID", so an operator asked for one would go looking in
// the portal for something that does not exist, and the nearest thing they would find (an application id,
// a SAS token, a connection string) is the wrong value.
//
// The account is also cross-checked against the endpoint host at build time, and a mismatch is refused with
// a message naming both, so the hint says the two must agree rather than letting a save fail on it.
export const AZURE_CRED_COPY: Readonly<{ key: FieldCopy; secret: FieldCopy }> = {
  key: {
    label: "Storage account name",
    hint: "The Azure storage account, which is also the first label of the endpoint above. Azure issues no separate key id: the account name is what signs the request, and it must match the endpoint host or the destination is refused.",
    placeholder: "mystorageaccount",
  },
  // THE SECRET BOX TAKES ANY OF THE THREE KINDS THE ENGINE ACCEPTS, and until it said so for
  // one of them. The engine has taken three since Entra landed, and it tells them apart from the value
  // itself rather than from a picker: looksLikeAzureSasToken (engine/src/dest/azure-sas.ts:60) reads a SAS
  // structurally, requiring both a parameter separator and a `sig` parameter, so an account key can never
  // be mistaken for one; and a filled Entra block makes the same box the client secret. An operator
  // holding a SAS and reading a box labelled "Storage access key" has no way to know it is accepted, which
  // is a capability the product has and the interface withholds.
  secret: {
    label: "Storage access key, SAS token or client secret",
    hint: "Any of the three: an access key for the storage account (portal → the storage account → Security + networking → Access keys), a SAS token including its sig parameter, or the client secret of the service principal named in the Entra block below. The engine tells them apart from the value itself. Sent once over the authenticated channel, verified live, then held by your engine. Never re-displayed.",
    placeholder: "an account key, a SAS beginning sv=..., or a client secret",
  },
};

// AZURE_ENDPOINT_COPY is the endpoint field's wording for Azure. The label is unchanged; only the shape and
// the account-must-match rule differ, and the second half of the hint is the S3 one verbatim, because the
// live probe at save is the same promise for every provider.
export const AZURE_ENDPOINT_COPY: FieldCopy = {
  label: "Endpoint",
  hint: "The storage account's BLOB endpoint, https://<account>.blob.core.windows.net. The account in this host must be the storage account name below. It is proven reachable and writable by a live probe at save, not by a format check.",
  placeholder: AZURE_ENDPOINT_PLACEHOLDER,
};

// S3_ENDPOINT_COPY is the endpoint field's wording for every other explicit provider, held here so the
// switch back out of Azure restores it from one place rather than from a second copy of the sentence.
export const S3_ENDPOINT_COPY: FieldCopy = {
  label: "Endpoint",
  hint: "The provider's S3-compatible endpoint, an https URL. It is proven reachable and writable by a live probe at save, not by a format check.",
  placeholder: "https://s3.example.com",
};

/**
 * WORM_PREREQ_COPY is the immutability section's provider line: what the operator's bucket must ALREADY be
 * for a policy set here to be enforceable, and whether that is still something they can change.
 *
 * It exists because the refusal arrived after the work. On three of the four providers Object Lock is a
 * property a bucket is CREATED with and can never gain afterwards, so an operator who chose compliance
 * mode, typed a retention window and pressed Verify and save learnt only from the engine's refusal that
 * their bucket was never a candidate, and that the remedy is a new bucket rather than a setting. Nothing on
 * the form said so beforehand, and the section's own note said "the bucket must have been created with
 * Object-Lock enabled" in Amazon's vocabulary for every provider, which is the wrong sentence for three of
 * the four. Azure is the fourth, and it is the one where the prerequisite CAN still be met on an existing
 * container, which is the difference the operator most needs told.
 *
 * A Record over Provider rather than a conditional, so a fifth provider cannot be added without answering
 * this question for it. Each string is read against the engine, not against the vendor's marketing:
 *
 *   r2     engine/src/dest/types.ts and engine/src/env.d.ts: R2 lists the Object-Lock configuration calls
 *          as unimplemented and CreateBucket rejects x-amz-bucket-object-lock-enabled, so no R2 bucket can
 *          be created with it. R2 over its S3 endpoint answers 501 NotImplemented to
 *          x-amz-object-lock-mode, which wormCannotBeEnforced reads as a definite cannot-enforce and turns
 *          into a refused save (engine/src/admin/router-destinations.ts). R2's own bucket lock is a
 *          different mechanism that neither this policy nor the probe reads.
 *   s3     S3 Object Lock proper: enabled at bucket creation, never afterwards.
 *   gcs    measured against a real bucket: Google Cloud Storage implements S3 Object Lock
 *          through its interop API, but only for a bucket created with per-object retention. Such a bucket
 *          answers the probe Enabled and honours a compliance lock; one without it answers 404 and the save
 *          is refused. Per-object retention cannot be turned on after the bucket exists.
 *   azure  Azure Blob Storage has no S3 Object Lock and never will, and it does not need one: the engine
 *          reaches it with its own client and maps this form's two modes onto Azure's own version-level
 *          immutability, where governance is an UNLOCKED policy (a privileged principal can lift it) and
 *          compliance is a LOCKED one (nobody can shorten or remove it). The prerequisite is therefore on
 *          the CONTAINER or the storage account rather than on a bucket-creation flag, and it is the one
 *          difference worth stating: unlike the other three, it can be turned on after the fact, so an
 *          operator whose container lacks it has something to go and do rather than a container to
 *          replace. Azure's independent legal hold has no counterpart on this form and is never set.
 */
export const WORM_PREREQ_COPY: Readonly<Record<Provider, string>> = {
  r2: "Cloudflare R2 cannot enforce S3 Object Lock on any bucket, at creation or afterwards, so the engine refuses an immutability policy on an R2 destination. R2's own bucket lock is a separate feature that this policy does not reach.",
  s3: "The bucket must already have been created with Object Lock enabled. It cannot be turned on for a bucket that exists, so a bucket without it has to be replaced rather than reconfigured.",
  gcs: "The bucket must already have been created with per-object retention (gcloud storage buckets create --enable-per-object-retention). It cannot be turned on for a bucket that exists, so a bucket without it has to be replaced rather than reconfigured.",
  azure: "The container or the storage account must already have version-level immutability enabled, which you can turn on in Azure at any time. Governance is stored as an unlocked policy a privileged principal can lift; compliance is stored as a locked one nobody can shorten or remove.",
};

// applyFieldCopy rewrites one already-built field's label, hint and placeholder in place.
//
// field() takes its wording at construction and hands back no setter for it, and adding one would widen a
// component every screen in the console uses for a need that exists on exactly one form. The label and hint
// are reached by the ids field() itself assigns, so this depends on field()'s published structure rather
// than on a position in the wrapper.
function applyFieldCopy(f: FieldHandle, id: string, copy: FieldCopy): void {
  const label = f.el.querySelector(".field__label");
  if (label) label.textContent = copy.label;
  const hint = f.el.querySelector(`#${id}-hint`);
  if (hint) hint.textContent = copy.hint;
  // Cast rather than narrowed: all three controls this is called on are text inputs, and the console's own
  // idiom for reaching an input-only property off a FieldControl is the same cast (destination-form.ts).
  (f.control as HTMLInputElement).placeholder = copy.placeholder;
}

/**
 * applyProviderCopy moves the wording whose MEANING changes with the provider: the endpoint, the credential
 * pair, and the immutability section's prerequisite line.
 *
 * It exists because Azure's credential pair is not an Access Key ID and a Secret Access Key. Hiding a
 * control the provider cannot honour (the storage class, AssumeRole) is the other half of the same job;
 * this is the half where the control is still needed and only its wording was wrong.
 *
 * The immutability line rides here rather than in a mechanism of its own, and the prerequisite it carries is
 * the one the operator cannot fix after the fact: a bucket gains Object Lock at creation or never.
 *
 * @param parts - the built fields, and the immutability note, whose wording is provider-dependent.
 * @param p - the live provider.
 */
export function applyProviderCopy(parts: { endpointField: FieldHandle; keyField: FieldHandle; secretField: FieldHandle; wormPrereq: HTMLElement }, p: Provider): void {
  applyFieldCopy(parts.endpointField, "dest-endpoint", p === "azure" ? AZURE_ENDPOINT_COPY : S3_ENDPOINT_COPY);
  const cred = p === "azure" ? AZURE_CRED_COPY : S3_CRED_COPY;
  applyFieldCopy(parts.keyField, "dest-access-key", cred.key);
  applyFieldCopy(parts.secretField, "dest-secret", cred.secret);
  parts.wormPrereq.textContent = WORM_PREREQ_COPY[p];
}

// buildCredBlock builds the credential pair (shared by both variants) plus the help row.
// The secret is a password input, sent once, never persisted client-side and never
// re-displayed. The help row's "How do I create R2 credentials?" opens the step-by-step
// modal (where in the dashboard, the exact token type, the one-bucket scope).
export function buildCredBlock(): { keyField: FieldHandle; secretField: FieldHandle; helpRow: HTMLElement } {
  const keyField = field({
    id: "dest-access-key",
    label: S3_CRED_COPY.key.label,
    required: true,
    autocomplete: "off",
    placeholder: S3_CRED_COPY.key.placeholder,
    hint: S3_CRED_COPY.key.hint,
    doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" },
  });
  keyField.control.classList.add("mono");
  const secretField = field({
    id: "dest-secret",
    label: S3_CRED_COPY.secret.label,
    type: "password",
    required: true,
    autocomplete: "off",
    placeholder: S3_CRED_COPY.secret.placeholder,
    hint: S3_CRED_COPY.secret.hint,
    doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" },
  });

  // credsHelp opens the step-by-step modal: where in the dashboard, the exact token
  // type, and the one-bucket scope, so nobody leaves the console to guess.
  const credsHelp = (): void => {
    const body = h(
      "div",
      { class: "stack-sm" },
      h("p", "Four steps, all in the Cloudflare dashboard:"),
      h(
        "ol",
        { class: "setup-steps" },
        h("li", { class: "setup-steps__item" }, "Open ", h("b", "R2 → Manage R2 API Tokens"), " (dash.cloudflare.com → R2 → Manage R2 API Tokens) and press ", h("b", "Create API Token"), "."),
        h("li", { class: "setup-steps__item" }, "Choose ", h("b", "Object Read & Write"), " and scope it to ", h("b", "one bucket"), ": the archive bucket only (least privilege)."),
        h("li", { class: "setup-steps__item" }, "Create it, then copy the ", h("b", "Access Key ID"), " and the ", h("b", "Secret Access Key"), "."),
        h("li", { class: "setup-steps__item" }, "Paste both here and press Verify and save."),
      ),
      h(
        "p",
        { class: "field__hint" },
        "The credential is verified live before it is stored (the engine writes and reads back a probe object; anything that fails is refused and nothing is kept). It is held in your engine, never the vendor; recorded in the audit trail (who set it and when, never the value); and removable or replaceable here any time.",
      ),
    );
    openModal({ title: "Create R2 credentials for the archive bucket", body });
  };
  const helpRow = h(
    "p",
    { class: "field__hint", style: "margin:0" },
    h("button", { "data-dp": "destination-form-fields.button.creds-help", class: "linklike", type: "button", on: { click: credsHelp } }, "How do I create R2 credentials?"),
    " Takes about a minute in the dashboard.",
  );
  return { keyField, secretField, helpRow };
}

// buildPricingBlock builds the optional storage-pricing section (for the cost ESTIMATE
// only, never used by backups). Prefilled from the provider's indicative list pricing so
// the cost screen needs no separate pricing step; the owner edits it to their contracted
// rates. pricingState.edited tracks whether the operator hand-edited the rates: a fresh
// add starts at the preset and follows the provider until edited; an existing
// destination's rates are the operator's. The mutable object lets setProvider read the
// live flag and the rate-field onInput set it.
export function buildPricingBlock(opts: DestinationFormOpts, pricingState: { edited: boolean }): { section: HTMLDetailsElement; note: HTMLElement; storageField: FieldHandle; classAField: FieldHandle; classBField: FieldHandle; egressField: FieldHandle; currencyField: FieldHandle } {
  const startPricing: Pricing = opts.initialPricing
    ? {
        storagePerGBMonth: opts.initialPricing.storagePerGBMonth,
        classAPerMillion: opts.initialPricing.classAPerMillion,
        classBPerMillion: opts.initialPricing.classBPerMillion,
        egressPerGB: opts.initialPricing.egressPerGB,
      }
    : { ...PRESETS.r2 };
  // Each rate validates at the field, AND THAT RULE IS NOW RUN AT SUBMIT. It was not: the
  // rule fired on blur and nowhere else, submitDestination's validateForm listed only the credential and
  // endpoint fields, and readPricing went on to swap an unreadable rate for the vendor preset in silence. An
  // operator who typed a contracted rate with a currency symbol in it got the preset back, was told the
  // destination was verified and saved, and read cost estimates of a rate they had not entered. The four
  // cost-screen rate boxes have refused this at the field since they were built; these four are the same value
  // on a different screen, and they now refuse it at the save too.
  const rateField = (id: string, label: string, value: number, hint: string) => {
    const f = field({ id, label, type: "number", value: String(value), hint, validate: nonNegativeRate({ noun: `The ${label.replace(/ \(.*$/, "").toLowerCase()} rate`, remedy: "Type the rate as a plain number, with no currency symbol or thousands separator, for example 0.015." }), doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "where-the-rates-come-from" }, onInput: () => { pricingState.edited = true; } });
    f.control.classList.add("mono");
    return f;
  };
  const storageField = rateField("dest-price-storage", "Storage ($/GB-month)", startPricing.storagePerGBMonth, "Per GB stored per month.");
  const classAField = rateField("dest-price-classa", "Writes ($/million)", startPricing.classAPerMillion, "Per million write (Class A) operations.");
  const classBField = rateField("dest-price-classb", "Reads ($/million)", startPricing.classBPerMillion, "Per million read (Class B) operations.");
  const egressField = rateField("dest-price-egress", "Egress ($/GB)", startPricing.egressPerGB, "Per GB downloaded out of the account. Zero for Cloudflare R2.");
  const currencyField = field({ id: "dest-price-currency", label: "Currency", value: opts.initialPricing?.currency ?? "USD", placeholder: "USD", hint: "A label for your rates, for example USD, EUR or AUD.", doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "where-the-rates-come-from" } });
  // The note starts on the R2 wording because the form mounts on R2 (destination-form.ts calls
  // setProvider("r2")), and setProvider rewrites it from pricingNote on every switch.
  const note = noteQuiet(pricingNote("r2"));
  // A second class purely so this note can be addressed apart from the form's other quiet notes
  // (the archive-into-a-source warn is also a .note-quiet). No styling hangs off it.
  note.classList.add("dest-price-note");
  const section = collapsedSection(
    "Storage pricing (for cost estimates)",
    h(
      "div",
      { class: "stack-sm" },
      note,
      h("div", { class: "dest-price-grid" }, storageField.el, classAField.el, classBField.el, egressField.el),
      currencyField.el,
    ),
  );
  return { section, note, storageField, classAField, classBField, egressField, currencyField };
}

// buildWormBlock builds the optional immutability (WORM / Object-Lock) section, default
// OFF. When set, the engine arms S3 Object-Lock on every write to this destination, so
// the store itself refuses to delete or overwrite an archive object until its retention
// window passes (ransomware resilience). The engine verifies the live capability at save
// and reports it back on the saved card (the badge is keyed on real enforcement, never on
// the policy alone), and refuses the save outright where the store answers that the bucket
// cannot enforce a lock.
//
// WHAT THE BUCKET MUST ALREADY BE is provider-dependent, and it is the fact the operator
// cannot act on once the save is refused, so it is stated on the form BEFORE the work
// rather than only in the refusal. That line is WORM_PREREQ_COPY, moved by
// applyProviderCopy on every provider switch; the note below carries only what is true of
// every provider.
export function buildWormBlock(opts: DestinationFormOpts): { section: HTMLElement; wormModeField: FieldHandle; wormDaysField: FieldHandle; wormPrereq: HTMLElement } {
  const wormModeField = field({
    id: "dest-worm-mode",
    label: "Mode",
    kind: "select",
    value: opts.initialWorm?.mode ?? "off",
    options: [
      { value: "off", label: "Off" },
      { value: "governance", label: "Governance (a privileged principal can override)" },
      { value: "compliance", label: "Compliance (undeletable for the window, by anyone)" },
    ],
    // The bucket prerequisite used to live here, in Amazon's vocabulary, for all four providers. It is
    // the provider line above now (WORM_PREREQ_COPY), so this hint carries only what holds everywhere.
    hint: "Arms S3 Object-Lock on every write, and the engine verifies live enforcement at save. A bucket the store says cannot enforce a lock is refused, never accepted quietly.",
    doc: { href: "https://docs.downpipes.io/assurance-audit/immutability-and-attestation", anchor: "the-three-honest-worm-states" },
  });
  const wormDaysField = field({
    id: "dest-worm-days",
    label: "Retention (days)",
    type: "number",
    value: opts.initialWorm ? String(opts.initialWorm.retentionDays) : "",
    placeholder: "30",
    hint: "How long each archive object stays locked, in days from when it is written. A whole number greater than zero.",
    // The submit path refuses a half-set policy at the FORM (destination-submit.ts), which is the
    // right place for the cross-field rule (a day count only matters once a mode is chosen) and the
    // wrong place for the day count's own shape: an operator who typed 0 was told nothing until they
    // pressed Save, under a hint promising "greater than zero". A typed value that is not a whole
    // number of days above zero is wrong under every mode, so it is refused here, at the field. A
    // BLANK box stays silent: blank with a mode chosen is still the form's case to make at submit.
    validate: wholeNumberAtLeast({
      noun: "The retention window",
      min: 1,
      unit: "days",
      remedy: "Type how many days each archive object stays locked, for example 30.",
    }),
    doc: { href: "https://docs.downpipes.io/assurance-audit/immutability-and-attestation", anchor: "the-three-honest-worm-states" },
  });
  wormDaysField.control.classList.add("mono");
  // The provider line is its own quiet note rather than a second paragraph inside the one above, because
  // .note-quiet is a flex ROW: two paragraphs in it sit side by side. Its text is empty until
  // applyProviderCopy runs, which destination-form.ts does through setProvider before the form is shown,
  // so an empty line is never rendered.
  const wormPrereq = noteQuiet("");
  wormPrereq.classList.add("dest-worm-prereq");
  const section = collapsedSection(
    "Immutability (WORM / Object-Lock)",
    h(
      "div",
      { class: "stack-sm" },
      noteQuiet(
        "Optional, off by default. When on, the store refuses to delete or overwrite an archive object until its retention window passes, and the engine reports what the bucket really enforces on the saved destination. Compliance mode cannot be shortened or removed by anyone, however privileged, until the window passes, so choose it deliberately.",
      ),
      wormPrereq,
      wormModeField.el,
      wormDaysField.el,
    ),
  );
  return { section, wormModeField, wormDaysField, wormPrereq };
}

// buildStsBlock builds the optional AWS STS AssumeRole section (S3 only). When a role ARN
// is given, the Access Key ID / Secret Access Key above become the assume-role PRINCIPAL
// (a long-lived key scoped to ONLY assume the role), and the engine mints short-lived
// credentials per run. This is strictly better than storing a long-lived write key, but
// it does NOT eliminate the stored key, so the copy stays honest. AWS S3 only (R2 has no
// STS); the section is ignored for an R2 destination.
// ENTRA_GUID and ENTRA_TENANT_DOMAIN MIRROR engine/src/dest/factory-validators.ts:237 and :243 rather than
// being invented here. The engine refuses a service principal whose ids do not match these, so a console
// that accepted a wider shape would let an operator save a destination the write boundary then rejects,
// and a console that accepted a narrower one would refuse a principal that works. Copied deliberately and
// with the citation, because there is no way to import a regex across the two repos.
const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_TENANT_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
// The three multi-tenant authority aliases the engine refuses BY NAME (factory-validators.ts:249). They get
// their own message because "common" is what an operator copies out of a sign-in tutorial, and it is the
// one wrong tenant id that looks deliberate rather than mistyped.
const ENTRA_MULTI_TENANT_ALIASES: ReadonlySet<string> = new Set(["common", "organizations", "consumers"]);

/**
 * buildEntraBlock builds the OPTIONAL Microsoft Entra service principal block for an Azure Blob
 * destination: the directory and the application, both of them public identifiers.
 *
 * WHY THERE IS NO THIRD SECRET BOX. A service principal is three values, and a stored destination carries
 * exactly one credential slot. The third value, the client secret, IS that slot: on an Entra destination
 * `secretAccessKey` holds the client secret exactly as it holds the storage account key on a Shared Key
 * one (engine/src/dest/factory-validators.ts:215-225). So the form asks for the two public ids here and
 * relabels the existing secret box, which keeps one secret per destination in the field every surface that
 * handles a destination secret already knows about.
 *
 * WHY THE BLOCK EXISTS AT ALL. The engine has taken three Azure credential kinds since it landed Entra,
 * and until this block the console could express ONE of them. A capability reachable over the API and
 * absent from the only interface a customer has is not a supported capability.
 */
export function buildEntraBlock(opts: DestinationFormOpts): { section: HTMLElement; tenantIdField: FieldHandle; clientIdField: FieldHandle } {
  const tenantIdField = field({
    id: "dest-entra-tenant",
    label: "Directory (tenant) ID",
    placeholder: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    value: opts.initialAzureEntra?.tenantId ?? "",
    hint: "The directory the service principal signs in to, from the app registration's overview page: a GUID, or a verified domain such as contoso.onmicrosoft.com. Leave the whole block blank to authenticate with the storage account key or a SAS instead.",
    doc: { href: "https://docs.downpipes.io/backing-up/destination-providers", anchor: "the-four-providers-axis-by-axis" },
    validate: (v) => {
      const t = v.trim();
      if (t === "") return null;
      if (ENTRA_MULTI_TENANT_ALIASES.has(t.toLowerCase())) {
        return `A destination has to name ONE directory, so the tenant cannot be "${t}": a service principal signs in to a specific tenant. Use the Directory (tenant) ID from the app registration's overview page.`;
      }
      if (!ENTRA_GUID.test(t) && !ENTRA_TENANT_DOMAIN.test(t)) {
        return "The Directory (tenant) ID must be a GUID (8-4-4-4-12 hex) or a verified domain such as contoso.onmicrosoft.com. Copy it from the app registration's overview page.";
      }
      return null;
    },
  });
  tenantIdField.control.classList.add("mono");
  const clientIdField = field({
    id: "dest-entra-client",
    label: "Application (client) ID",
    placeholder: "d290f1ee-6c54-4b01-90e6-d701748f0851",
    value: opts.initialAzureEntra?.clientId ?? "",
    hint: "The application the service principal is, from the same overview page: a GUID. Its client secret goes in the credential box above, which is relabelled once this block is filled in.",
    doc: { href: "https://docs.downpipes.io/backing-up/destination-providers", anchor: "the-four-providers-axis-by-axis" },
    validate: (v) => {
      const t = v.trim();
      if (t === "") return null;
      if (!ENTRA_GUID.test(t)) return "The Application (client) ID must be a GUID (8-4-4-4-12 hex). Copy it from the app registration's overview page.";
      return null;
    },
  });
  clientIdField.control.classList.add("mono");
  const section = collapsedSection(
    "Authentication: Microsoft Entra service principal (Azure Blob, optional)",
    h(
      "div",
      { class: "stack-sm" },
      noteQuiet(
        "Optional, Azure Blob only. Leave it blank and the credential box above is a storage account key or a SAS token, whichever you paste. Fill both ids and the engine signs nothing: it exchanges the client secret for a bearer token against the directory you name, and every request carries that token. The service principal needs the Storage Blob Data Contributor role on the container.",
      ),
      tenantIdField.el,
      clientIdField.el,
      noteQuiet("Both ids or neither. A half-filled principal is refused here and by the engine rather than dropped, because a dropped one stores a destination that reports itself verified and then tries to use the client secret as a storage account key on every write."),
    ),
  );
  return { section, tenantIdField, clientIdField };
}

export function buildStsBlock(opts: DestinationFormOpts): { section: HTMLElement; roleArnField: FieldHandle; externalIdField: FieldHandle; durationField: FieldHandle } {
  const roleArnField = field({
    id: "dest-role-arn",
    label: "Role ARN",
    placeholder: "arn:aws:iam::123456789012:role/Backup",
    hint: "Leave blank to authenticate with the keys directly. When set, the keys above assume this role. Format: arn:aws:iam::<12-digit account>:role/<name>.",
    doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" },
    value: opts.initialAuthRoleArn ?? "",
  });
  roleArnField.control.classList.add("mono");
  const externalIdField = field({ id: "dest-external-id", label: "External ID (optional)", placeholder: "d290f1ee-6c54-4b01-90e6-d701748f0851", hint: "Required only if the role's trust policy demands it (cross-account delegation). It must match the sts:ExternalId in the role's trust policy exactly.", doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" } });
  const durationField = field({ id: "dest-sts-duration", label: "Session duration (seconds, optional)", type: "number", placeholder: "3600", hint: "A whole number of seconds from 900 to 43200; default 3600. The engine re-mints per run, so a short duration is fine.", validate: wholeNumberBetween({ noun: "The session duration", min: 900, max: 43200, unit: "seconds", remedy: "Type a duration in that range, or leave it blank for the default of 3600." }), doc: { href: "https://docs.downpipes.io/backing-up/multiple-destinations", anchor: "creating-the-destination-credential" } });
  durationField.control.classList.add("mono");
  const section = collapsedSection(
    "Authentication: STS AssumeRole (AWS S3, optional)",
    h(
      "div",
      { class: "stack-sm" },
      noteQuiet(
        "Optional, AWS S3 only. With a role ARN, the engine assumes the role and uses short-lived credentials for every write, so security teams that forbid long-lived write keys are satisfied. A long-lived principal key is still stored (scoped to assume-role only), so this reduces, not removes, the stored secret. The region must be the role's real AWS region.",
      ),
      roleArnField.el,
      externalIdField.el,
      durationField.el,
      ...(opts.confirmReplace
        ? [noteQuiet("Replacing credentials does not carry over the External ID or session duration. Re-enter the External ID if the role's trust policy requires it; otherwise the engine uses its default duration.")]
        : []),
    ),
  );
  return { section, roleArnField, externalIdField, durationField };
}
