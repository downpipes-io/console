// Attach a source (the day-2 UX gap): a guided flow so an operator adds a new Cloudflare store
// binding WITHOUT any terminal. It is the MANUAL companion to the Sources catalogue
// (sources.ts): the catalogue lists what your discovery token can see and attaches a pick in one
// click; this screen is for a store the catalogue cannot enumerate, so you type the ids yourself.
// Either way the engine adds the binding TO ITSELF through its safety harness (read its real
// bindings, prove the change drops none of its own, write, verify), using a short-lived scoped
// deploy token you paste here and then revoke. No customer is ever sent to a terminal: the
// wrangler path survives only as a collapsed, no-token fallback for an operator who prefers their
// own login. Once the binding is live the operator configures a downpipe pointing at it via the
// EXISTING add-downpipe editor (this screen leads into /downpipes/new with the binding prefilled;
// it never duplicates that editor).
//
// The journey, one coherent path:
//   1. Choose a source to back up. The FOUR BINDING stores (KV namespace / R2 bucket / D1 database /
//      Secrets Store secret) take the binding-attach path below. The FIVE TOKEN sources (Cloudflare
//      configuration / Workers scripts / Stream / Images / Artifacts) are offered only when the engine
//      advertises each one (the same
//      GET /admin/sources/discover signal the create-downpipe wizard gates on): they carry no binding
//      and no standalone source object, so picking one HANDS OFF into the create-downpipe wizard with
//      the source pre-selected (lib/token-source.ts builds the /downpipes/new?type=... query the
//      wizard's prefill reads), where the account/zone + selector + destination + schedule are set.
//   2. (Binding stores) Enter the identifiers Cloudflare needs (ids + a chosen binding name). The
//      binding name is validated as a JS/wrangler identifier that does not collide with a reserved
//      engine binding (lib/add-source.ts, the engine's RESERVED_BINDINGS mirror).
//   3. (Binding stores) Paste a one-shot, scoped deploy token and press Attach. The engine adds the
//      binding to itself and verifies its own bindings all survived; the token is used once, never
//      stored. A Secrets Store source is referenced by store id + secret name + binding ONLY; no
//      secret VALUE is ever asked for or rendered. Once the binding is live, configure the downpipe
//      (lead into the existing /downpipes/new editor with the binding + store type prefilled).
//
// Gate: reaching the screen and configuring a downpipe is downpipe.write (operator and up); the
// ATTACH itself is Owner-only (the deploy-grade gate the engine enforces on POST
// /admin/sources/attach), exactly as the Sources catalogue gates its attach. A caller without
// downpipe.write sees the explanation but no controls; an operator who is not an Owner sees the
// steps and can configure a downpipe, but the Attach button is disabled (an Owner attaches). The
// engine is always the enforcement point; this client gate only shows or enables controls.
// Strict-CSP safe: every node via the h() builder, content via textContent (the code-block sets
// textContent so the stanza renders literally), no innerHTML on server/operator data, no inline
// handlers.
//
// House: Australian English, no em dashes, precise claims.

import { recordContractSkew } from "../lib/client-diag/ring.ts";
import { formFieldFor, recordFormRefused } from "../lib/client-diag/ring.ts";
import { h, svgIcon } from "../lib/dom.ts";
import { pageHeader, requireEngine, canCap, capGateReason, canDo, type Screen } from "./common.ts";
import { capabilityPhrase } from "./capability-copy.ts";
import { navigate, goSignedOut } from "../lib/nav.ts";
import { saveDraft, loadDraft, clearDraft } from "../lib/draft.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { toast } from "../components/toast.ts";
import { surfaceQueuedOwnerAction } from "../lib/pending-change-toast.ts";
import type { Field } from "../components/field.ts";
import { codeBlock } from "../components/code-block.ts";
import { verdictSurface } from "../components/verdict.ts";
import { ICON_LOCK, ICON_CHECK, ICON_INFO, ICON_EXTERNAL } from "../lib/icons.ts";
import { attachTokenHelp } from "./sources.ts";
import { isOwnerActionQueuedResult, type EngineClient } from "../api.ts";
import {
  STORE_TYPES,
  validateSourceInput,
  draftBlock,
  type StoreType,
  type SourceInput,
} from "../lib/add-source.ts";
import {
  TOKEN_SOURCE_TYPES,
  tokenSourceOffered,
  tokenSourceLabel,
  tokenSourceSummary,
  tokenSourceCreatePath,
  tokenSourceSkewFamilies,
  type TokenSourceType,
} from "../lib/token-source.ts";
import { errMsg, tokenSourceIcon, storeSummary } from "./add-source-glyphs.ts";
import { buildSourceFields, collectInput, fieldFor } from "./add-source-fields.ts";
import { renderAttachSuccess } from "./add-source-success.ts";
import { buildAttachPanel } from "./add-source-attach-panel.ts";
import { buildSourcePicker } from "./add-source-picker.ts";

export const addSourceScreen: Screen = {
  // A new, deep-linkable route that sits alongside the downpipes routes. It is full-chrome
  // (not full-bleed): app.ts FULL_BLEED does not list it, so the shell rail/header stay.
  route: ["/sources/advanced", "/sources/add"],
  title: "Attach a source manually",
  measure: "prose",
  // No palette action here: the "Add a source" entry point is the Downpipes toolbar + the
  // rail item; a separate palette command would just duplicate "Create downpipe". The screen
  // is reachable by deep link and by the toolbar button wired in sources-downpipes.ts.
  actions: [],
  render() {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    // The client gate MIRRORS the engine's downpipe.write authority (the same capability that
    // lets a caller create or edit a downpipe). A caller without it sees the explanation but
    // cannot reach the attach or configure controls; the engine is the enforcement point.
    const canWrite = canCap("downpipe.write");

    root.appendChild(
      pageHeader(
        "Attach a source manually",
        // The advanced path: type the ids yourself when the Sources catalogue cannot see a store.
        // The engine attaches it for you from here; no terminal.
        "The advanced path: type the ids yourself when the Sources catalogue cannot see a store. The engine attaches it for you, no terminal.",
        undefined,
        // The referrer-aware crumb: this child page always offers a labelled return to Sources
        // (Sources restores its selection on return; its ticks are reflected to the URL).
        { label: "Sources", to: "/sources" },
      ),
    );

    if (!canWrite) {
      root.appendChild(
        verdictSurface({
          tone: "info",
          glyph: ICON_LOCK,
          title: `Attaching a source needs ${capabilityPhrase("downpipe.write")}`,
          body: capGateReason("downpipe.write"),
        }),
      );
      return root;
    }

    root.appendChild(renderGuide(engine));
    return root;
  },
};

// ADD_SOURCE_DRAFT holds the in-progress identifiers so a navigation hop or browser-back does not
// discard them (the navigation design). It carries the store type and the typed ids/names ONLY,
// never a secret value (add-source collects the Secrets Store id and the secret NAME, never the
// value, which stays in Cloudflare), so the draft is honest. Cleared when the operator bridges to
// configure the downpipe (or once a successful attach lands).
const ADD_SOURCE_DRAFT = "add-source-form";

interface AddSourceDraft {
  type?: StoreType;
  binding?: string;
  kvNs?: string;
  r2Bucket?: string;
  d1Name?: string;
  d1Id?: string;
  secStore?: string;
  secName?: string;
}

// renderGuide builds the guided body: choose a store type, enter the identifiers, attach the
// binding in-portal (the engine adds it to itself), then bridge into the existing add-downpipe
// editor. State is render-scoped (rebuilt each render()). The only engine call is the attach
// (engine.changeBindings); the downpipe schedule is written later through the existing editor.
function renderGuide(engine: EngineClient): HTMLElement {
  const wrap = h("div");

  // --- Step 1: choose a source to back up (a segmented radiogroup, status by selected-state +
  // label). The FOUR binding stores (kv/r2/d1/secrets) are rendered synchronously and unchanged;
  // the five TOKEN sources (cf-config, workers, stream, images, artifacts) are appended only when the engine advertises each
  // (the discovery fetch below), each routing the operator into the create-downpipe wizard instead
  // of asking for a binding (they carry none). `selected` is the unified pick: a StoreType (binding
  // flow) or a TokenSourceType (hand-off). currentType holds the binding store for the existing
  // binding logic and is untouched while a token source is selected. ---
  let currentType: StoreType = "kv";
  let selectedToken: TokenSourceType | null = null;
  // The engine's record of which token sources are ADDED (undefined on an older engine that does not
  // gate, or before discovery resolves). The token hand-off below records the add before continuing, so
  // the create wizard, which now offers only added types, shows the picked source. Captured here (set in
  // offerTokenSources) so the hand-off panel reads it without a second discovery round-trip.
  let currentAddedSources: string[] | undefined;
  const typeButtons = new Map<StoreType, HTMLButtonElement>();
  // The token-source buttons, keyed by type; populated only when discovery advertises them. The
  // roving-tabindex order is the four stores followed by whichever token buttons were appended.
  const tokenButtons = new Map<TokenSourceType, HTMLButtonElement>();
  // checkedButton returns the currently-checked button (a store, or a token row) so the picker's
  // roving-tabindex handler steps from the live selection.
  const checkedButton = (): HTMLButtonElement =>
    selectedToken !== null ? tokenButtons.get(selectedToken)! : typeButtons.get(currentType)!;
  // The picker (add-source-picker.ts) builds the four store radio buttons + the arrow-key handler;
  // a store click runs setType then persistForm exactly as before. typeHint is updated by setType /
  // selectTokenSource below.
  const { typeSeg, typeHint } = buildSourcePicker(typeButtons, tokenButtons, currentType, checkedButton, (t) => { setType(t); persistForm(); });

  // discoveryNote carries the HONEST outcome of the source-catalogue read that decides which token
  // sources the picker offers (offerTokenSources below). Hidden while the read succeeds; a failed read
  // says so, with a retry, rather than leaving a silently shortened picker.
  const discoveryNote = h("div", { class: "stack-sm", role: "status", hidden: "" });

  wrap.appendChild(h("h2", { class: "page-header__title", style: "font-size:var(--text-md)" }, "1. Choose the source to back up"));
  wrap.appendChild(h(
    "div",
    { class: "field" },
    h("span", { class: "field__label", id: "store-type-label" }, "Source"),
    typeSeg,
    typeHint,
    discoveryNote,
    // Group-level doc link (audit G2): the source-type radios are one control, so the link that explains
    // what each source type captures lives on the group rather than on any single button.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/overview#the-eight-source-types", target: "_blank", rel: "noreferrer noopener" },
      "About the source types",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  ));

  // --- The identifiers Cloudflare needs (one set of fields per type). Each field is built once
  // (add-source-fields.ts); setType toggles which blocks are visible. The binding name is shared
  // across all types. Destructure the built struct so the rest of the closure reads unchanged. ---
  const fields = buildSourceFields();
  const { bindingField, kvNsField, r2BucketField, d1NameField, d1IdField, secStoreField, secNameField } = fields;
  const { kvBlock, r2Block, d1Block, secBlock, idsField } = fields;

  // Steps 2 and 3 (identifiers + the in-portal attach) are parented under one bindingSteps element
  // (add-source-attach-panel.ts) so a token-source pick can hide them as a unit; tokenHost holds the
  // hand-off panel (built on demand for the picked token type). ownerGate decides whether the attach
  // controls are live. The panel builds the DOM only; the handlers below are wired here.
  const ownerGate = canDo("owner");
  const panel = buildAttachPanel(idsField, ownerGate);
  const { bindingSteps, formError, tokenInput, attachLabel, attachBtn, tokenHelpLink, attachErr, resultHost, cliCodeHost } = panel;
  const tokenHost = h("div", { hidden: true });
  let busy = false;

  tokenHelpLink.addEventListener("click", () => attachTokenHelp(null));

  // refreshCli regenerates the no-token fallback stanza from the CURRENT identifiers, through the
  // SAME rules Attach runs (draftBlock), so the block offered for copying is never built ungated.
  function refreshCli(): void {
    cliCodeHost.replaceChildren(codeBlock(draftBlock(collectInput(fields, currentType)), { copyLabel: "Copy the stanza and deploy command" }));
  }

  wrap.appendChild(bindingSteps);
  wrap.appendChild(tokenHost);

  // setType toggles the visible identifier block + the per-type hint, and resets the attach
  // panel (a different store type would attach a different binding).
  function setType(t: StoreType): void {
    currentType = t;
    selectedToken = null;
    for (const [type, btn] of typeButtons) {
      const sel = type === t;
      btn.setAttribute("aria-checked", sel ? "true" : "false");
      btn.tabIndex = sel ? 0 : -1;
    }
    // A binding store is selected: clear any token row's checked state and restore the binding flow
    // (steps 2 and 3), hiding the token hand-off panel. This makes the binding path byte-identical
    // whether or not a token source was previously selected.
    for (const btn of tokenButtons.values()) { btn.setAttribute("aria-checked", "false"); btn.tabIndex = -1; }
    bindingSteps.hidden = false;
    tokenHost.hidden = true;
    tokenHost.replaceChildren();
    kvBlock.hidden = t !== "kv";
    r2Block.hidden = t !== "r2";
    d1Block.hidden = t !== "d1";
    secBlock.hidden = t !== "secrets";
    typeHint.textContent = storeSummary(t);
    formError.hidden = true;
    bindingField.clearError();
    attachErr.hidden = true;
    resultHost.replaceChildren();
    refreshCli();
  }

  // selectTokenSource handles picking a TOKEN source (cf-config / workers). It carries no binding and
  // no standalone source object, so there is nothing to attach here: the operator continues into the
  // create-downpipe wizard, where the account/zone (and, for cf-config, the per-surface selection),
  // destination and schedule are chosen. So this HIDES the binding steps and shows an honest hand-off
  // panel with a Continue button that navigates to the create route with this source pre-selected via
  // the query bridge (lib/token-source.ts -> sources-downpipes.ts prefillFromQuery). No engine call is
  // made from this screen for a token source; the wizard does the discovery and the create.
  function selectTokenSource(t: TokenSourceType): void {
    selectedToken = t;
    for (const btn of typeButtons.values()) { btn.setAttribute("aria-checked", "false"); btn.tabIndex = -1; }
    for (const [type, btn] of tokenButtons) {
      const sel = type === t;
      btn.setAttribute("aria-checked", sel ? "true" : "false");
      btn.tabIndex = sel ? 0 : -1;
    }
    typeHint.textContent = tokenSourceSummary(t);
    // Clear any half-typed binding state so a later return to a binding store starts clean and nothing
    // on screen describes a binding while a token source is selected.
    formError.hidden = true;
    bindingField.clearError();
    attachErr.hidden = true;
    resultHost.replaceChildren();
    bindingSteps.hidden = true;
    renderTokenHandoff(t);
    tokenHost.hidden = false;
  }

  // renderTokenHandoff fills tokenHost with the hand-off panel for a picked token source. The Continue
  // button routes to the create-downpipe wizard with this token source pre-selected (type only, the
  // wizard collects the account/zone + selector + destination + schedule). The draft is cleared on the
  // hop, matching the binding flow's bridge.
  function renderTokenHandoff(t: TokenSourceType): void {
    const to = tokenSourceCreatePath({ type: t });
    const continueBtn = h(
      "button",
      { "data-dp": "add-source.button.continue", class: "btn btn--primary", type: "button" },
      svgIcon(ICON_CHECK, { size: 14 }),
      `Continue to set up the ${tokenSourceLabel(t)} downpipe`,
    ) as HTMLButtonElement;
    continueBtn.addEventListener("click", () => {
      // The create wizard now offers only token sources that were ADDED on the Sources screen, so record
      // this add (idempotent SET semantics) before handing off, or the wizard would not show the picked
      // source. An older engine returns addedSources === undefined (or it is already added): pass straight
      // through to the (legacy ungated, or already-showing) wizard. Owner-gated server-side; a refused add
      // is surfaced rather than landing on a wizard that cannot show the source.
      // `addedSources === undefined` is the LEGACY BRANCH: this engine does not gate the wizard on the
      // added-source roster at all, so the console skips the record and hands straight through. The behaviour is
      // right and it is a compatibility path being taken silently, which is exactly the mixed-version state that
      // makes "the wizard does not show the source I just added" unreadable. Recorded only for the ABSENT
      // roster; an already-added source taking the same branch is the ordinary, correct case and is not drift.
      if (currentAddedSources === undefined) recordContractSkew("legacy-path-taken", "added-sources");
      if (currentAddedSources === undefined || currentAddedSources.includes(t)) {
        clearDraft(ADD_SOURCE_DRAFT);
        navigate(to);
        return;
      }
      continueBtn.disabled = true;
      void engine
        .setEnabledSources([...new Set([...currentAddedSources, t])])
        .then(() => { clearDraft(ADD_SOURCE_DRAFT); navigate(to); })
        .catch((e) => {
          // PAINT FIRST, THEN LEAVE: the release below sits on the OTHER branch, so a lapsed session
          // used to leave Continue dead with nothing said.
          if (isUnauthorised(e)) {
            continueBtn.disabled = false;
            return goSignedOut();
          }
          continueBtn.disabled = false;
          toast({ message: `Could not add ${tokenSourceLabel(t)} as a source. ${errMsg(e)} An Owner adds Cloudflare-wide sources.`, tone: "warn" });
        });
    });
    tokenHost.replaceChildren(
      h("h2", { class: "page-header__title", style: "font-size:var(--text-md);margin-top:var(--space-5)" }, "2. Continue on the downpipe"),
      verdictSurface({
        tone: "info",
        glyph: ICON_INFO,
        title: t === "cf-config"
          ? "Cloudflare configuration is configured on the downpipe itself"
          : "Workers are configured on the downpipe itself",
        body: t === "cf-config"
          ? "This source is read with your read-only discovery token, so there is no binding to attach and nothing to deploy here. Continue to the new-downpipe step to choose the account or zone, pick which configuration surfaces to back up, and set the destination and schedule."
          : "This source is read with your read-only discovery token, so there is no binding to attach and nothing to deploy here. Continue to the new-downpipe step to choose the account, and set the destination and schedule. Restore is reprovision: you re-deploy the script, not a blind in-console write.",
      }),
      h("div", { class: "ob-actions", style: "margin-top:var(--space-3)" }, continueBtn),
    );
  }

  // appendTokenButton adds one token-source radio button to the picker (after the four stores) and
  // wires its pick. Called only for a token source the engine advertises.
  function appendTokenButton(t: TokenSourceType): void {
    if (tokenButtons.has(t)) return;
    const btn = h(
      "button",
      { "data-dp": "add-source.radio.select-token-source", class: "type-seg__btn", type: "button", role: "radio", "aria-checked": "false", tabindex: "-1" },
      svgIcon(tokenSourceIcon(t), { size: 14 }),
      tokenSourceLabel(t),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => selectTokenSource(t));
    tokenButtons.set(t, btn);
    typeSeg.appendChild(btn);
  }

  // getValidatedInput re-collects and validates the CURRENT fields at call time (never a stale
  // capture), marks each bad field (and focuses the first), and returns the input or null.
  // collectInput and fieldFor are pure reads over the field struct (add-source-fields.ts).
  function getValidatedInput(): SourceInput | null {
    formError.hidden = true;
    for (const f of fields.all) f.clearError();
    const input = collectInput(fields, currentType);
    const errors = validateSourceInput(input);
    // The console's OWN validator turned the operator away, so NO request is made and the engine sees
    // NOTHING. A customer blocked at setup for a week ("the attach form says my id is invalid but the catalogue
    // accepted it") produces zero remote evidence today, and a console validator that has drifted TIGHTER than
    // the field catalogue is undetectable in the field. The catalogue control id rides; the TYPED VALUE (a
    // namespace id, a bucket name, a store id) never does. A field id the closed vocabulary does not know is
    // dropped rather than coerced into a neighbouring row.
    //
    // AND AN EMPTY BOX IS NOT A REFUSAL. This loop recorded one, and it recorded it on the
    // console's most-trafficked setup screen: validateHexId / validateResourceName / validateDatabaseId each
    // return "The ... is required." for "", so pressing Attach on a fresh KV form -- an operator who has not
    // typed anything yet -- wrote binding/rejected and namespaceId/rejected, and those rows coalesce on the same
    // tuple key as the refusal the member exists for (a UUID the hex-only regex turns away). The real ticket was
    // buried inside a count of half-filled forms. The rule is the RECORDER'S now: recordFormRefused takes the
    // control's CURRENT raw value and writes nothing when it is empty. The value is read only for that test; the
    // typed value (a namespace id, a bucket name, a store id) never leaves the browser. A field with no control
    // to read (an error on a key fieldFor does not map) records NOTHING rather than asserting a value existed.
    for (const e of errors) {
      const ff = formFieldFor(e.field);
      const control = fieldFor(fields, e.field);
      if (ff !== null && control !== null) recordFormRefused(ff, control.value());
    }
    if (errors.length === 0) return input;
    let focused = false;
    for (const e of errors) {
      const f = fieldFor(fields, e.field);
      if (f) {
        f.setError(e.reason);
        if (!focused) { f.focus(); focused = true; }
      }
    }
    if (!focused) {
      formError.textContent = errors[0]!.reason;
      formError.hidden = false;
    }
    return null;
  }

  // wireAttach binds the Owner-only Attach click: validate the current ids, require a pasted token,
  // call the engine once (changeBindings), then on success render the attach-success bridge and clear
  // the draft, or on failure surface the error (signing out on an unauthorised reply).
  function wireAttach(): void {
    attachBtn.addEventListener("click", () => {
      if (busy) return;
      const input = getValidatedInput();
      if (!input) return; // field errors already marked + focused
      const value = tokenInput.value.trim();
      if (value === "") {
        attachErr.textContent = "Paste the deploy token first.";
        attachErr.hidden = false;
        tokenInput.focus();
        return;
      }
      attachErr.hidden = true;
      busy = true;
      attachBtn.disabled = true;
      attachLabel.textContent = "Attaching";
      void engine
        .changeBindings(value, [input], [])
        .then((res) => {
          busy = false;
          attachBtn.disabled = false;
          attachLabel.textContent = "Attach this source";
          if (isOwnerActionQueuedResult(res)) {
            // Dual control DEFERRED the attach to a second owner (HTTP 202): NOTHING is attached, so do not
            // render success or tell the operator to revoke the token (still needed to complete it after
            // approval). Surface the queued state and leave the form so they can retry once approved.
            tokenInput.value = "";
            surfaceQueuedOwnerAction("Attaching this source");
            return;
          }
          tokenInput.value = "";
          toast({ message: "Source attached, verified safe. Revoke the token now." });
          resultHost.replaceChildren(renderAttachSuccess(input, ADD_SOURCE_DRAFT));
          clearDraft(ADD_SOURCE_DRAFT);
          // Land a keyboard user on the next action (the configure button).
          queueMicrotask(() => {
            const next = resultHost.querySelector("button.btn--primary");
            if (next instanceof HTMLElement) next.focus();
          });
        })
        .catch((e) => {
          busy = false;
          attachBtn.disabled = false;
          attachLabel.textContent = "Attach this source";
          if (isUnauthorised(e)) return goSignedOut();
          attachErr.textContent = errMsg(e);
          attachErr.hidden = false;
        });
    });
  }

  if (ownerGate) wireAttach();

  wireFormPersistence();

  // Initialise the visible block + hint (and the fallback stanza) for the default type.
  setType(currentType);
  rehydrateDraft();
  offerTokenSources();

  return wrap;

  // persistForm saves the in-progress identifiers on every edit (the navigation design). Only names
  // and ids; never a secret value. Editing also clears a stale attach result/error and re-syncs the
  // fallback stanza, so nothing on screen describes a binding other than what is typed now.
  function persistForm(): void {
    saveDraft<AddSourceDraft>(ADD_SOURCE_DRAFT, {
      type: currentType,
      binding: bindingField.value(),
      kvNs: kvNsField.value(),
      r2Bucket: r2BucketField.value(),
      d1Name: d1NameField.value(),
      d1Id: d1IdField.value(),
      secStore: secStoreField.value(),
      secName: secNameField.value(),
    });
    attachErr.hidden = true;
    resultHost.replaceChildren();
    refreshCli();
  }

  // wireFormPersistence attaches persistForm to every identifier control so a navigation hop or
  // browser-back keeps the typed ids.
  function wireFormPersistence(): void {
    for (const f of [bindingField, kvNsField, r2BucketField, d1NameField, d1IdField, secStoreField, secNameField]) {
      f.control.addEventListener("input", persistForm);
    }
  }

  // rehydrateDraft restores any in-progress draft AFTER the default setType, so the restored type and
  // values win. Setting .value directly fires no input event, so this does not re-persist a
  // half-applied state; refresh the fallback stanza once at the end to reflect the restored ids.
  function rehydrateDraft(): void {
    const draft = loadDraft<AddSourceDraft>(ADD_SOURCE_DRAFT);
    if (!draft) return;
    if (draft.type && (STORE_TYPES as readonly string[]).includes(draft.type)) setType(draft.type);
    const setVal = (f: Field, v: string | undefined): void => {
      if (v) (f.control as HTMLInputElement).value = v;
    };
    setVal(bindingField, draft.binding);
    setVal(kvNsField, draft.kvNs);
    setVal(r2BucketField, draft.r2Bucket);
    setVal(d1NameField, draft.d1Name);
    setVal(d1IdField, draft.d1Id);
    setVal(secStoreField, draft.secStore);
    setVal(secNameField, draft.secName);
    refreshCli();
  }

  // offerTokenSources adds the TOKEN sources (cf-config, workers, stream, images, artifacts) when the
  // deployed engine advertises each, read off the SAME GET /admin/sources/discover response the
  // create-downpipe wizard gates on (so the two surfaces agree on what is supported). It is purely
  // additive: the four binding buttons are already on screen. cf-config is offered when the engine
  // returns a non-empty surface catalogue; workers/stream/images/artifacts via their *Supported flags.
  //
  // A REJECTED discovery is no longer silent. It used to fail soft into an empty catch, so the picker
  // simply showed four source types and the operator asked support "where did Cloudflare configuration
  // go?": a failed read and an engine that genuinely supports nothing more looked identical. The read
  // outcome is now stated, with a retry, so the screen never implies a catalogue it did not read.
  function offerTokenSources(): void {
    discoveryNote.replaceChildren();
    discoveryNote.hidden = true;
    void engine
      .discoverSources()
      .then((found) => {
        currentAddedSources = found.addedSources;
        const offered = tokenSourceOffered(found);
        // The discovery read SUCCEEDED, the account HAS a discovery token, and the engine did not advertise
        // a capability the console knows how to use. That token source then vanishes from Add a source and the
        // picker silently degrades to what is left. It is the compatibility branch of an OLDER engine (the
        // console asked for a capability the engine does not advertise), which is why it is `legacy-path-taken`
        // and not a fault: it is version skew, and after an engine ROLLBACK it is the reason a customer's Workers
        // source "disappeared".
        //
        // ONE ROW PER MISSING CAPABILITY, which is the whole point. The four flags landed on four different dates,
        // so every engine build in between advertises a strict SUBSET, and a subset is not zero: the all-or-nothing
        // predicate this replaces recorded NOTHING for an engine that offered cf-config but not Workers, which is
        // exactly what a rollback lands on and exactly the ticket. fieldFamily is in the ring's tuple key, so the
        // SET of rows is the evidence: cf-config-only is three rows, none-at-all is four, and a healthy engine is
        // silence. The predicate is pure and exported (token-source.ts), so the validator drives the REAL decision
        // rather than the recorder.
        //
        // The no-token state records nothing, and neither does a failed read: account discovery is OPT-IN, so
        // tokenPresent false is the healthy DEFAULT, and the engine already records it itself as a no-token
        // discovery observation while the screen says so to the operator. Firing there would have called a
        // current, correctly-configured engine "version skew" on every mount, with the opposite remedy.
        for (const family of tokenSourceSkewFamilies(found)) recordContractSkew("legacy-path-taken", family);
        for (const t of TOKEN_SOURCE_TYPES) if (offered[t]) appendTokenButton(t);
      })
      .catch((err: unknown) => {
        if (isUnauthorised(err)) return goSignedOut();
        const retry = h("button", { "data-dp": "add-source.button.retry", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-2)" }, "Retry the read") as HTMLButtonElement;
        retry.addEventListener("click", () => offerTokenSources());
        discoveryNote.replaceChildren(
          h(
            "p",
            { class: "field__hint", style: "margin:0" },
            "The engine's source catalogue could not be read, so the token-based sources (Cloudflare configuration, Workers, Stream, Images) are not listed here. The four binding stores above are unaffected. This is a failed read, not an empty account.",
          ),
          retry,
        );
        discoveryNote.hidden = false;
      });
  }
}
