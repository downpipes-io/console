// Guided create wizard (flow.md J) for the Sources + downpipes screen, split out of ./editor.ts.
// See ./editor.ts for the barrel.

import { type Downpipe, type EngineClient, isOwnerActionQueuedResult, type StatusReport } from "../../api.ts";
import { openBulkSummary } from "../../components/bulk-summary.ts";
import { dialogSurface, openOverlay } from "../../components/dialog.ts";
import { blockError, SESSION_ENDED_ACTION } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { field } from "../../components/field.ts";
import { confirmModal, reserveBusyWidth } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { stepper } from "../../components/wizard.ts";
import { runBulkCreate } from "../../lib/bulk-create.ts";
import { cfSurfaceListThrowClass, recordCatalogueDegraded } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { clearDraft, loadDraft, saveDraft } from "../../lib/draft.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_ALERT, ICON_EXTERNAL } from "../../lib/icons.ts";
import { clearLeaveGuard, goSignedOut, navigate, registerLeaveGuard } from "../../lib/nav.ts";
import { surfacePendingChange, surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { isTokenSourceType } from "../../lib/token-source.ts";
import { slugId } from "../sources/shared.ts";
import { assembleBulkDownpipes, assembleCfConfigBulk, type CfConfigAccountTick, type CfConfigZoneTick, SECRETS_BUNDLE_NAME } from "./bulk-assemble.ts";
import type { EditorPrefill } from "./editor-types.ts";
import { openEditor } from "./editor-upsert.ts";
import { buildWizardSource } from "./editor-wizard-downpipe.ts";
import { destinationBlock as destinationBlockPanel } from "./editor-wizard-panels.ts";
import { buildSourceList, type WizardState } from "./editor-wizard-source-rows.ts";
import { errMsg, friendlyName } from "./helpers.ts";

// WIZARD_NAME_DRAFT holds the two typed step-3 fields so a reload or tab close does not
// discard the operator's half-typed downpipe name and chosen cadence, the same navigation design
// add-source.ts and restore-flow/flow.ts already apply via lib/draft.ts. Scoped to name + cadence
// only: neither carries a secret (the honesty rule in lib/draft.ts), and the source-step selection
// (which binding, which cf-config zones) has its own, separately guarded shape (Maps of live
// discovery results) that is not yet drafted here. Cleared on Cancel/close and on a successful
// create; left in place on a failed create so a retry is not typed twice.
const WIZARD_NAME_DRAFT = "create-downpipe-wizard-name";

interface WizardNameDraft {
  name?: string;
  cadenceSeconds?: string;
}

// ---- bulk create (import a list, flow.md J) ---------------------------------

// openCreateWizard is the guided "New downpipe" flow (the IA reorganisation, owner
// feedback: nothing hand-typed, one decision at a time, CALM-09 one step
// visible). Two steps when a destination exists: pick the source from what is
// ATTACHED (never a free-text binding), then name and schedule (which carries the
// one-line source + destination summary). Only an UNSET destination inserts the
// Destination step, as a warn-with-continue (the engine accepts the create;
// create-first-then-set-destination is a legitimate order). The full-power editor
// remains for editing and for the Secrets repeater, reachable from step 1.
export function openCreateWizard(
  engine: EngineClient,
  status: StatusReport | null,
  piped: ReadonlySet<string>,
  onSaved: () => void,
  onClose: () => void,
  prefill?: EditorPrefill,
): void {
  // A secrets-typed deep link goes straight to the advanced editor (it owns the secrets
  // repeater, where each secret can be named individually); the wizard's own source step
  // also offers attached secrets as a tickable group that bundles into one downpipe.
  if (prefill?.type === "secrets") {
    openEditor(engine, null, status, onSaved, onClose, prefill);
    return;
  }
  // A TOKEN-source hand-off from "Add a source" (cf-config / workers) carries the type + an optional
  // account/zone/prefix. We seed the wizard's chosen-* state from it so the matching source row
  // auto-selects when the source step renders (see prefillTokenRowId / the row auto-click below).
  const tokenPrefill = isTokenSourceType(prefill?.type ?? "") ? prefill : undefined;
  let step = 0; // 0 = source, 1 = destination (only when unset), 2 = name + schedule
  let nameTouched = false;

  // state holds the wizard's chosen-* selection that the source-step row apply() closures mutate
  // and read. It is a single object so the source-row module (./editor-wizard-source-rows.ts) and
  // this function share one reference (the move-only equivalent of the previous closed-over `let`s).
  //   chosenBinding holds the display label / name-seed key for the four remaining RADIO types
  //     (workers/stream/images/artifacts, which have no real binding), the actual binding otherwise.
  //   chosenInput is set ONLY when the picked source is not attached to the engine yet: it carries
  //     the attach wire shape so the wizard PROTECTS it inline (one token, used once, the engine
  //     verifies its own bindings all survive) as part of creating the downpipe, instead of bouncing
  //     the operator over to the Sources screen. A pick that is already attached leaves it null.
  //   workers / stream / images / artifacts are picked by ACCOUNT, each carrying its own
  //     chosen*AccountId (a scalar RADIO, one downpipe). cf-config is a tick-many CHECKBOX
  //     selection instead (chosenCfZones / chosenCfAccounts below): each ticked zone or account
  //     becomes its own downpipe, so an N-zone customer bulk-creates in one pass (the
  //     source-granularity audit's fix). All five are token-authenticated (the read-only discovery
  //     token), so none need an inline attach.
  const state: WizardState = {
    // A binding prefill (the add-source-success bridge) PRE-TICKS the matching checkbox in the
    // multi-selection below; only a workers/stream/images/artifacts hand-off seeds the radio
    // scalars. A cf-config hand-off seeds chosenCfZones/chosenCfAccounts once the source step
    // actually renders (it needs the resolved zone/account NAME off discoverSources(), unlike
    // these four whose display label is fixed) -- see editor-wizard-source-rows.ts.
    chosenBinding: tokenPrefill !== undefined && tokenPrefill.type !== "cf-config" ? prefill?.binding ?? null : null,
    chosenType:
      tokenPrefill?.type === "workers" || tokenPrefill?.type === "stream" || tokenPrefill?.type === "images" || tokenPrefill?.type === "artifacts"
        ? tokenPrefill.type
        : null,
    chosenInput: null,
    chosenAccountId: tokenPrefill !== undefined && tokenPrefill.type !== "cf-config" ? tokenPrefill.accountId ?? null : null,
    chosenWorkersAccountId: tokenPrefill?.type === "workers" ? tokenPrefill.accountId ?? null : null,
    chosenStreamAccountId: tokenPrefill?.type === "stream" ? tokenPrefill.accountId ?? null : null,
    chosenImagesAccountId: tokenPrefill?.type === "images" ? tokenPrefill.accountId ?? null : null,
    chosenArtifactsAccountId: tokenPrefill?.type === "artifacts" ? tokenPrefill.accountId ?? null : null,
    cfCatalogue: [],
    chosenMulti: new Map(
      prefill?.binding !== undefined && (prefill.type === "kv" || prefill.type === "r2" || prefill.type === "d1")
        ? [[prefill.binding, prefill.type]]
        : [],
    ),
    chosenSecretsMulti: new Set<string>(),
    cfScopePreset: null,
    chosenCfZones: new Map(),
    chosenCfAccounts: new Map(),
    cfMultiAccount: false,
  };
  // downpipeCount is how many downpipes the current selection creates: each ticked kv/r2/d1
  // binding is one, the ticked secrets bundle is one, each ticked cf-config zone/account is one,
  // a radio token pick is one. The checkbox families coexist (mutually exclusive only against the
  // radio, the row module enforces it), so this is a plain sum.
  const downpipeCount = (): number =>
    state.chosenBinding !== null
      ? 1
      : state.chosenMulti.size + (state.chosenSecretsMulti.size > 0 ? 1 : 0) + state.chosenCfZones.size + state.chosenCfAccounts.size;
  // One-shot: the token-source hand-off auto-selects its row the FIRST time the source step renders,
  // never again (so a Back to the source step does not yank the operator's later pick back).
  let tokenPrefillApplied = tokenPrefill === undefined;
  const tokenInput = h("input", { "data-dp": "sources-downpipes.password.token", type: "password", class: "input", autocomplete: "off", spellcheck: "false", placeholder: "Cloudflare API token (used once, never stored)" }) as HTMLInputElement;
  const attachErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const attachBlock = h(
    "div",
    { class: "stack-xs", hidden: true, style: "border-top:1px solid var(--border-subtle); padding-top:var(--space-3); margin-top:var(--space-2)" },
    h("p", { class: "field__hint", style: "margin:0" }, "This source isn't protected yet. Paste a Cloudflare API token (the \"Edit Cloudflare Workers\" template, scoped to this account) and the engine attaches it to itself as it creates this downpipe. The template predates D1 and Secrets Store: attaching a D1 or Secrets Store source needs that permission added to the token by hand. The token is used once and never stored."),
    h("a", { class: "field__doc linklike", href: "https://docs.downpipes.io/operations/cloudflare-token-scopes", target: "_blank", rel: "noreferrer noopener" }, "How to create this deploy token", svgIcon(ICON_EXTERNAL, { size: 13 })),
    tokenInput,
    attachErr,
  );

  // cf-config's per-surface picker was removed from the wizard (source-granularity audit,
  // ): the scope preset (account-only / zone-only / account-and-zone, rendered by
  // ./editor-wizard-source-rows.ts) is the wizard's one coarse, guided cf-config decision now,
  // consistent with how kv/r2/d1 also defer fine-grained includes/excludes to "Use the advanced
  // editor" rather than offering them inline here. Fine per-surface control remains available
  // there (./editor-cf-config-section.ts), unchanged.
  // Content capture (stream/images/artifacts only): an opt-in to also back up the resource BYTES, not
  // just the metadata inventory. chosenIncludeContent feeds the source-build; the panel is shown only when
  // a media source is selected. Off by default (bytes can multiply a run's size and cost, so it is a choice).
  let chosenIncludeContent = false;
  const contentToggle = h("input", { type: "checkbox", id: "wiz-include-content" }) as HTMLInputElement;
  contentToggle.addEventListener("change", () => { chosenIncludeContent = contentToggle.checked; });
  const contentPanel = h(
    "div",
    { class: "stack-xs", hidden: true, style: "border-top:1px solid var(--border-subtle); padding-top:var(--space-3); margin-top:var(--space-2)" },
    h("div", { class: "checkbox-row" }, contentToggle, h("label", { for: "wiz-include-content" }, "Also back up the file contents, not just the inventory")),
    h("p", { class: "field__hint", style: "margin:0" }, "Off captures the inventory and metadata only. On also captures the file bytes (size-gated), which increases the backup size, the run time and the storage cost. Restore stays reprovision either way."),
    h("a", { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/overview#what-each-type-captures", target: "_blank", rel: "noreferrer noopener" }, "What each source type captures", svgIcon(ICON_EXTERNAL, { size: 13 })),
  );
  // showContent toggles the panel and, when hiding, resets the opt-in (so a stale tick never rides along to
  // a non-media source). When showing it reflects the current chosenIncludeContent state.
  const showContent = (on: boolean): void => {
    contentPanel.hidden = !on;
    if (!on) { chosenIncludeContent = false; contentToggle.checked = false; } else { contentToggle.checked = chosenIncludeContent; }
  };

  // The destination is read ONCE at open. Configured (or unreadable: the fail-open
  // contract) skips the Destination step; the one-line summary rides on the name
  // step instead, so the destination stays visible without a stepless ceremony stop.
  let destStep: "configured" | "unset" | "unknown" = "unknown";
  let destLine = "Destination: unknown (could not reach the engine); manage in Destinations.";
  // The destination COLLECTION (multi-destination): when more than one exists, the name step shows a
  // PICKER so the operator chooses where THIS downpipe writes. chosenDestinationId is the pinned id;
  // undefined means "follow the default", the common case.
  let wizDestinations: Array<{ id?: string; label?: string; bucket?: string; isDefault?: boolean }> = [];
  // chosenDestinationIds is the ORDERED fan-out selection: the ticked ids in list order, the
  // first being the primary. Empty = follow the default (single copy). >=2 = a source written to two
  // places. Sent to the engine as destinationIds.
  let chosenDestinationIds: string[] = [];
  const destProbe = Promise.all([
    engine.getDestination(),
    engine.listDestinations().catch(() => ({ destinations: [], defaultId: null })),
  ])
    .then(([d, list]) => {
      wizDestinations = list.destinations;
      if (d.present) {
        destStep = "configured";
        destLine = `Destination: ${d.bucket ?? "your bucket"}${d.endpointHost ? ` at ${d.endpointHost}` : ""}; manage in Destinations.`;
      } else if (d.envConfigured) {
        destStep = "configured";
        // The DEPLOY-TIME destination is the case a first-time customer is most likely to meet,
        // and it is the one the wizard used to say least about: "configured at deploy" named
        // neither the provider nor why no bucket appears. The engine DOES report the kind here
        // (GET /admin/destination returns envKind alongside envConfigured), and it deliberately
        // never echoes DEST_BUCKET/DEST_ENDPOINT for an env destination (engine
        // src/admin/status.ts:166), so the honest line names the kind and says the bucket name is
        // not reported rather than leaving a customer to wonder where their data is going.
        destLine = d.envKind === "r2"
          ? "Destination: Cloudflare R2 in this account, set when the engine was deployed. The engine does not report a deploy-time bucket name, so Destinations shows it as not reported."
          : d.envKind === "s3"
            ? "Destination: an S3-compatible store, set when the engine was deployed. The engine does not report a deploy-time bucket name, so Destinations shows it as not reported."
            : d.envKind === "gcs"
              ? "Destination: Google Cloud Storage, set when the engine was deployed. The engine does not report a deploy-time bucket name, so Destinations shows it as not reported."
              : d.envKind === "azure"
                ? "Destination: Azure Blob Storage, set when the engine was deployed. The engine does not report a deploy-time container name, so Destinations shows it as not reported."
                : "Destination: set when the engine was deployed; the engine reports neither its kind nor its bucket name. Manage in Destinations.";
      } else {
        destStep = "unset";
        destLine = "Destination: not set yet; runs will fail until one is set in Destinations.";
      }
    })
    .catch(() => {
      /* destStep stays "unknown": fail open, claim nothing */
    });
  // destinationBlock is what the name step shows for "where this goes". With more than one destination
  // it is a MULTI-select: tick the destinations this source is copied to, the first ticked is the
  // primary, the rest are replicas. Ticking two or more keeps the source in more than one place.
  // Leaving all unticked uses the default (a single copy). With <=1 destination it is the summary line.
  // destinationBlock renders the name step's "where this goes" control; the body lives in
  // ./editor-wizard-panels.ts. The ordered tick selection is written back into chosenDestinationIds.
  const destinationBlock = (): HTMLElement =>
    destinationBlockPanel({ destinations: wizDestinations, destLine, setChosenDestinationIds: (ids) => { chosenDestinationIds = ids; } });

  const stepHost = h("div", { class: "stack-sm" });
  const stepRail = h("div");
  const nextBtn = h("button", { "data-busy-label": "Attaching", "data-dp": "sources-downpipes.button.next", class: "btn btn--primary", type: "button", disabled: true }, "Continue") as HTMLButtonElement;
  // RESERVED AT CONSTRUCTION, not at the transition. This button becomes "Attaching" or "Creating",
  // either of which is wider than its resting label, and a wider button pushes the Cancel beside it.
  // Reserving when the state CHANGES is too late: the reservation is itself a width change, so it moves
  // the neighbour at the exact moment the operator is watching. Reserving at the
  // transition can move Cancel 4.4px where doing nothing moves it 4.1px.
  queueMicrotask(() => {
    for (const label of ["Attaching", "Creating"]) reserveBusyWidth(nextBtn, label);
  });
  const backBtn = h("button", { "data-dp": "sources-downpipes.button.back", class: "btn btn--secondary", type: "button", hidden: true }, "Back") as HTMLButtonElement;
  const cancelBtn = h("button", { "data-dp": "sources-downpipes.button.cancel#3", class: "btn btn--ghost", type: "button" }, "Cancel") as HTMLButtonElement;
  const footer = h("div", { class: "dialog__actions" }, cancelBtn, backBtn, nextBtn);

  const body = h("div", { class: "form-stack" }, stepRail, stepHost);
  const { surface } = dialogSurface({ variant: "modal", title: "New downpipe", body, footer, onCloseClick: () => close() });
  const handle = openOverlay({ surface, variant: "modal", dismissable: false });

  // The dirty-form leave guard (the navigation design): once the operator has picked a
  // source or typed a name, a navigation AWAY (a rail click, the palette, a Back) prompts
  // "Discard?" instead of silently tearing the wizard down. The wizard's own dismissals
  // (Cancel, the X, a successful create) clear the guard first, so they never prompt.
  const isDirty = (): boolean => downpipeCount() > 0 || nameTouched;
  const guard = (to: string): boolean => {
    // Self-heal: if the wizard's DOM was already torn down (a forced redirect such as
    // a 401 bypasses the guard and closeAllOverlays removes the drawer), the guard is
    // an orphan -> clear it and allow, so it can never wedge a later navigation.
    if (!body.isConnected) { clearLeaveGuard(guard); return true; }
    if (!isDirty()) return true;
    void confirmModal({
      title: "Discard this new downpipe?",
      body: "You have started building a downpipe. Leaving now discards it.",
      confirmLabel: "Discard",
      variant: "danger",
    }).then((okd) => {
      if (okd) {
        clearLeaveGuard(guard);
        clearDraft(WIZARD_NAME_DRAFT);
        handle.close();
        navigate(to);
      }
    });
    return false;
  };
  // isDirty is already the pure, side-effect-free predicate the SPA guard above
  // consults; passing it through is what lets nav.ts's shared beforeunload listener catch a
  // real reload or tab close, which the SPA guard alone never sees.
  registerLeaveGuard(guard, isDirty);

  const close = (): void => {
    clearLeaveGuard(guard);
    clearDraft(WIZARD_NAME_DRAFT);
    handle.close();
    onClose();
  };
  cancelBtn.addEventListener("click", close);

  // persistNameDraft saves the name + cadence on every edit (the same navigation design
  // add-source.ts's persistForm follows): best-effort, and it never carries a secret because
  // neither field can hold one.
  const persistNameDraft = (): void => {
    saveDraft<WizardNameDraft>(WIZARD_NAME_DRAFT, { name: nameField.value(), cadenceSeconds: cadenceField.value() });
  };

  // Step 3 fields, created once so values survive Back/Continue.
  const nameField = field({ id: "wiz-name", label: "Name", required: true, value: "", hint: "A human label for this backup route (1 to 256 characters); the downpipe id is derived from it.", placeholder: "User uploads", autocomplete: "off", validate: (v) => (v.length <= 256 ? null : "Use at most 256 characters."), onInput: () => { nameTouched = true; persistNameDraft(); }, doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "what-a-downpipe-is" } });
  const cadenceField = field({
    id: "wiz-cadence",
    label: "Schedule",
    kind: "select",
    value: "86400",
    onInput: () => persistNameDraft(),
    options: [
      { value: "86400", label: "Daily (recommended)" },
      { value: "21600", label: "Every 6 hours" },
      { value: "3600", label: "Hourly" },
      { value: "604800", label: "Weekly" },
    ],
    hint: "How often this downpipe runs. The engine dispatches on a ~15-minute tick, so a cadence is a floor, not an exact firing time.",
    doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "the-fifteen-minute-floor" },
  });

  // Restore a name/cadence draft: survives Back/Continue already, and now also an
  // interrupted session that returns to "New downpipe" later, rather than retyping. Setting
  // .value directly fires no input event (mirrors add-source.ts's rehydrateDraft), so
  // nameTouched -- which drives both the leave guard and step 3's derived-name-from-source
  // fallback -- is set explicitly here to match what a typed name would have done.
  const nameDraft = loadDraft<WizardNameDraft>(WIZARD_NAME_DRAFT);
  if (nameDraft?.name) {
    nameField.control.value = nameDraft.name;
    nameTouched = true;
  }
  if (nameDraft?.cadenceSeconds) cadenceField.control.value = nameDraft.cadenceSeconds;

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });

  // The rail shows the Destination step only when it is real (unset = a decision to
  // make); done steps are revisitable via onJump (7a's wizard rule).
  const renderRail = (): void => {
    const steps = [
      { id: "source", label: "Source" },
      ...(destStep === "unset" ? [{ id: "destination", label: "Destination" }] : []),
      { id: "name", label: "Name and schedule" },
    ];
    stepRail.replaceChildren(
      stepper({
        steps,
        currentIndex: step === 0 ? 0 : step === 1 ? 1 : steps.length - 1,
        onJump: (s) => {
          step = s.id === "source" ? 0 : 1;
          renderStep();
        },
      }),
    );
  };

  // singleSelectionSeed is the name-seed source when the selection yields EXACTLY ONE downpipe:
  // the radio pick's display label, the one ticked binding, the secrets bundle's name, or the one
  // ticked cf-config zone/account's name. null when the batch creates several (names are then
  // derived per resource, not typed).
  const singleSelectionSeed = (): string | null => {
    if (state.chosenBinding !== null) return state.chosenBinding;
    if (state.chosenMulti.size + (state.chosenSecretsMulti.size > 0 ? 1 : 0) + state.chosenCfZones.size + state.chosenCfAccounts.size !== 1) return null;
    if (state.chosenMulti.size === 1) return [...state.chosenMulti.keys()][0]!;
    if (state.chosenSecretsMulti.size > 0) return SECRETS_BUNDLE_NAME;
    if (state.chosenCfZones.size === 1) return [...state.chosenCfZones.values()][0]!.zoneName;
    return [...state.chosenCfAccounts.values()][0]!;
  };

  // seedName derives the name from the picked source while the operator has not
  // typed one; picking a DIFFERENT source re-seeds it, so the name never quietly
  // describes the previous pick. A multi-selection has no single name to seed.
  const seedName = (): void => {
    const seed = singleSelectionSeed();
    if (seed === null) return;
    if (!nameTouched || nameField.value().trim() === "") {
      (nameField.control as HTMLInputElement).value = seed === SECRETS_BUNDLE_NAME ? SECRETS_BUNDLE_NAME : friendlyName(seed);
      nameTouched = false;
    }
  };

  const renderStep = (): void => {
    renderRail();
    backBtn.hidden = step === 0;
    if (step === 0) renderSourceStep();
    else if (step === 1) renderDestStep();
    else renderNameStep();
  };

  const renderSourceStep = (): void => {
    nextBtn.textContent = state.chosenInput === null ? "Continue" : "Protect and continue";
    nextBtn.disabled = downpipeCount() === 0;
    attachBlock.hidden = state.chosenInput === null;
    stepHost.replaceChildren(
      h("p", { class: "field__hint" }, "Pick what to back up."),
      skeletonRows(3),
    );
    void engine
      .discoverSources()
      .then((found) => {
        state.cfCatalogue = (found.cfConfigSurfaces ?? []).map((s) => ({ id: s.id, label: s.label, category: s.category, scope: s.scope, inBand: s.inBand === true }));
        // The source-step rows + the token-source hand-off auto-select live in the sibling module;
        // it renders into stepHost and mutates the shared `state`, sharing this function's DOM and
        // helpers via the context below (move-only, console-src-054-03).
        buildSourceList(
          {
            engine,
            status,
            piped,
            state,
            attachBlock,
            attachErr,
            contentPanel,
            nextBtn,
            stepHost,
            showContent,
            seedName,
            closeOverlay: () => handle.close(),
            onSaved,
            onClose,
            prefill,
            tokenPrefill,
            tokenPrefillApplied,
            setTokenPrefillApplied: (v) => { tokenPrefillApplied = v; },
          },
          found,
        );
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: stepHost is holding the skeleton this step seeded, and the repaint
          // below is on the other branch.
          stepHost.replaceChildren(h("p", { class: "field__hint" }, "Your session ended before the sources loaded. Sign in again and reopen this step."));
          return goSignedOut();
        }
        // G243, THE SIBLING READ. This is the SAME call the editor makes (GET /sources/discover), and when it
        // throws here the wizard shows a block error and the Cloudflare-configuration offer is withheld with it:
        // the operator cannot add a cf-config downpipe at all. The editor's twin now classifies its throw, so
        // this one does too, through the same classifier, which records NOTHING for a lapsed Access session (the
        // guard above already owns the 401). Without it the wizard is the one entry point where the whole
        // catalogue read can fail for a fortnight and the pack says nothing.
        const thrown = cfSurfaceListThrowClass(err);
        if (thrown !== null) recordCatalogueDegraded(thrown);
        stepHost.replaceChildren(blockError(err, () => renderSourceStep()));
      });
  };

  // Only the UNSET destination reaches this step, as a warn-with-continue: the
  // engine accepts the create (the probe above fails open for the same reason), and
  // create-first-then-set-destination is a legitimate setup order.
  const renderDestStep = (): void => {
    nextBtn.textContent = "Continue";
    nextBtn.disabled = false;
    stepHost.replaceChildren(
      h("p", { class: "field__hint" }, "Every downpipe writes to the one archive destination."),
      h(
        "div",
        { class: "dest-block dest-block--warn" },
        h(
          "div",
          { class: "dest-block__opt" },
          h("span", { class: "dest-block__ic" }, svgIcon(ICON_ALERT, { size: 18 })),
          h(
            "div",
            h("div", { class: "dest-block__title" }, "No destination yet"),
            h("div", { class: "dest-block__desc" }, "Backups have nowhere to land, so this downpipe's runs will fail until a destination is set (about two minutes, no terminal). You can create the downpipe now and set it after."),
          ),
        ),
      ),
      h("div", h("button", { "data-dp": "sources-downpipes.button.navigate-destinations#2", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => { handle.close(); navigate("/destinations"); } } }, "Set the destination")),
    );
  };

  // batchEntries flattens the checkbox selection into the shared assembly's input: each ticked
  // store binding plus every ticked secret (typed "secrets"; the assembly bundles those into one).
  const batchEntries = (): Array<[string, "kv" | "r2" | "d1" | "secrets"]> => [
    ...([...state.chosenMulti.entries()] as Array<[string, "kv" | "r2" | "d1" | "secrets"]>),
    ...[...state.chosenSecretsMulti].map((b): [string, "kv" | "r2" | "d1" | "secrets"] => [b, "secrets"]),
  ];

  // cfAccountLabel matches the account row's own label / assembleCfConfigBulk's downpipe name, so
  // the summary preview never disagrees with what actually gets created.
  const cfAccountLabel = (accountName: string): string => (state.cfMultiAccount ? `${accountName} configuration` : "Account-wide configuration");

  // selectionSummary is the name step's collapsed one-line source summary (7a's wizard rule): the
  // single pick's label, or the batch's counts plus a bounded preview of the derived names.
  const selectionSummary = (): HTMLElement[] => {
    if (state.chosenBinding !== null) {
      return [h("p", { class: "field__hint", style: "margin:0" }, "Source: ", h("span", { class: "mono" }, state.chosenBinding))];
    }
    const n = downpipeCount();
    const parts: string[] = [];
    const perType: Record<"kv" | "r2" | "d1", number> = { kv: 0, r2: 0, d1: 0 };
    for (const t of state.chosenMulti.values()) perType[t]++;
    if (perType.kv > 0) parts.push(`${perType.kv} KV namespace${perType.kv === 1 ? "" : "s"}`);
    if (perType.r2 > 0) parts.push(`${perType.r2} R2 bucket${perType.r2 === 1 ? "" : "s"}`);
    if (perType.d1 > 0) parts.push(`${perType.d1} D1 database${perType.d1 === 1 ? "" : "s"}`);
    if (state.chosenSecretsMulti.size > 0) parts.push(`1 Secrets downpipe bundling ${state.chosenSecretsMulti.size} secret${state.chosenSecretsMulti.size === 1 ? "" : "s"}`);
    if (state.chosenCfZones.size > 0) parts.push(`${state.chosenCfZones.size} Cloudflare zone configuration${state.chosenCfZones.size === 1 ? "" : "s"}`);
    if (state.chosenCfAccounts.size > 0) parts.push(`${state.chosenCfAccounts.size} Cloudflare account configuration${state.chosenCfAccounts.size === 1 ? "" : "s"}`);
    const head = h("p", { class: "field__hint", style: "margin:0" }, `Creating ${n} downpipe${n === 1 ? "" : "s"}: ${parts.join(", ")}.`);
    if (n <= 1) return [head];
    // The derived names, bounded (scroll past ten) so a thousand-source batch stays calm.
    const names = [
      ...[...state.chosenMulti.keys()].map((b) => friendlyName(b)),
      ...(state.chosenSecretsMulti.size > 0 ? [`${SECRETS_BUNDLE_NAME} (${state.chosenSecretsMulti.size} secrets)`] : []),
      ...[...state.chosenCfZones.values()].map((z) => friendlyName(z.zoneName)),
      ...[...state.chosenCfAccounts.values()].map((accountName) => cfAccountLabel(accountName)),
    ];
    const listEl = h(
      "div",
      { class: names.length > 10 ? "source-list source-list--scroll" : "source-list", role: "list", "aria-label": "Downpipes to create" },
      ...names.map((nm) => h("div", { role: "listitem", class: "mono", style: "color:var(--text-muted)" }, nm)),
    );
    return [head, listEl];
  };

  const renderNameStep = (): void => {
    const n = downpipeCount();
    nextBtn.textContent = n > 1 ? `Create ${n} downpipes` : "Create downpipe";
    nextBtn.disabled = false;
    seedName();
    stepHost.replaceChildren(
      // The collapsed one-line summaries of the earlier steps (7a's wizard rule):
      // the pick and the destination stay visible without a Back round trip.
      ...selectionSummary(),
      destinationBlock(),
      // The name is typed only when exactly ONE downpipe results; a batch derives each name from
      // its binding (the same derivation bulk protect uses), tunable later in the editor.
      ...(n > 1 ? [] : [nameField.el]),
      cadenceField.el,
      h("p", { class: "field__hint" }, state.chosenType === "workers"
        ? "Defaults you can tune later in the editor: every Worker in the account included, runs retained indefinitely. A weekly scheduled restore test is also configured. Restore is reprovision (you re-deploy), not a blind write."
        : n > 1
          ? "Every downpipe in this batch shares the schedule and destinations above; names come from each binding. Defaults you can tune later per downpipe: every key included, runs retained indefinitely, a weekly scheduled restore test."
          : "Defaults you can tune later in the editor: every key included, runs retained indefinitely. A weekly scheduled restore test is also configured."),
      formError,
    );
  };

  backBtn.addEventListener("click", () => {
    if (step === 0) return;
    step = step === 2 && destStep !== "unset" ? 0 : step - 1;
    renderStep();
  });

  // advanceFromSource leaves step 0: an unprotected pick is attached INLINE first (the engine adds
  // the binding to itself and verifies its own bindings all survive), then the wizard advances; an
  // already-attached pick just settles the destination read (started at open) so the step plan is
  // known. The body is the verbatim old step-0 arm of the Continue handler.
  const advanceFromSource = (): void => {
    if (downpipeCount() === 0) return;
    const advance = (): void => {
      step = destStep === "unset" ? 1 : 2;
      renderStep();
    };
    if (state.chosenInput !== null) {
      const token = tokenInput.value.trim();
      if (token === "") {
        attachErr.textContent = "Paste your Cloudflare API token to attach this source.";
        attachErr.hidden = false;
        return;
      }
      attachErr.hidden = true;
      nextBtn.disabled = true;
      nextBtn.textContent = "Attaching";
      // Dual control DEFERS the attach to a second owner (HTTP 202): the attach has NOT happened, so the
      // wizard must not advance and the chosen source must not be cleared.
      //
      // ONE continuation, not two linked by a flag. The queued decision used to be carried across a `.then`
      // boundary in a mutable `queuedOut`, which put the release for the advancing path in a different
      // closure from the busy-set: the step could only be shown to release the button by reading two links
      // of the chain together, and that is exactly the reading that hides a freeze.
      void engine
        .changeBindings(token, [state.chosenInput], [])
        .then(async (res) => {
          if (isOwnerActionQueuedResult(res)) {
            surfaceQueuedOwnerAction("Attaching this source");
            tokenInput.value = "";
            nextBtn.disabled = false;
            nextBtn.textContent = "Protect and continue";
            return;
          }
          tokenInput.value = "";
          state.chosenInput = null; // now attached; the engine redeploys and the binding is live before the first run
          attachBlock.hidden = true;
          await destProbe;
          advance();
        })
        .catch((e) => {
          if (isUnauthorised(e)) {
            // PAINT FIRST, THEN LEAVE: the source was not attached, so the step control comes back off
            // "Attaching" and the wizard stays where the operator left it.
            attachErr.textContent = SESSION_ENDED_ACTION;
            attachErr.hidden = false;
            nextBtn.disabled = false;
            nextBtn.textContent = "Protect and continue";
            return goSignedOut();
          }
          attachErr.textContent = errMsg(e);
          attachErr.hidden = false;
          nextBtn.disabled = false;
          nextBtn.textContent = "Protect and continue";
        });
      return;
    }
    // Settle the destination read (started at open) so the step plan is known. The
    // catch keeps the button recoverable even if destProbe is later changed to reject.
    nextBtn.disabled = true;
    void destProbe.then(() => advance()).catch(() => { nextBtn.disabled = false; });
  };

  // submitCreate is the final create step. A RADIO (token-source) pick posts the single wire
  // Downpipe exactly as before; a CHECKBOX selection assembles the batch through the shared
  // assembly (one downpipe per store binding; ticked secrets bundle into one) and creates it
  // through the shared many-at-once loop, with progress on the button and a per-item summary.
  const submitCreate = (): void => {
    const single = downpipeCount() === 1;
    const name = single ? nameField.value().trim() : "";
    if (single && name === "") {
      formError.textContent = "Give it a name.";
      formError.hidden = false;
      return;
    }
    formError.hidden = true;
    nextBtn.disabled = true;
    nextBtn.textContent = "Creating";
    const cadence = Number(cadenceField.value());
    const finishSingle = (res: { status: string }, createdName: string): void => {
      clearLeaveGuard(guard);
      clearDraft(WIZARD_NAME_DRAFT);
      handle.close();
      onSaved();
      if (res.status === "pending") surfacePendingChange("downpipe");
      else toast({ message: `${createdName} created. The first run lands on schedule, or trigger it now from the row.` });
      navigate("/downpipes");
    };
    const failInline = (err: unknown): void => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: nothing was created, so Create comes back off "Creating".
        formError.textContent = SESSION_ENDED_ACTION;
        formError.hidden = false;
        nextBtn.disabled = false;
        nextBtn.textContent = downpipeCount() > 1 ? `Create ${downpipeCount()} downpipes` : "Create downpipe";
        goSignedOut();
        return;
      }
      formError.textContent = errMsg(err);
      formError.hidden = false;
      nextBtn.disabled = false;
      const n = downpipeCount();
      nextBtn.textContent = n > 1 ? `Create ${n} downpipes` : "Create downpipe";
    };
    // The RADIO path (a Cloudflare-wide token source): the original single create, per-type wire
    // assembly in ./editor-wizard-downpipe.ts.
    if (state.chosenBinding !== null && state.chosenType !== null) {
      const dp: Downpipe = {
        id: slugId(name),
        name,
        cadenceSeconds: cadence,
        enabled: true,
        source: buildWizardSource(state, state.chosenType, chosenIncludeContent),
        ...(chosenDestinationIds.length > 0 ? { destinationIds: chosenDestinationIds } : {}),
      };
      void engine.addDownpipe(dp).then((res) => finishSingle(res, name)).catch(failInline);
      return;
    }
    // The CHECKBOX path: assemble the ticked bindings (secrets bundling into one downpipe) AND the
    // ticked cf-config zones/accounts (one downpipe per zone, surfaces per the scope preset, plus
    // one per ticked account) into a single batch, so a mixed tick (say, two KV namespaces and
    // three zones) creates every downpipe in one bulk-create pass.
    const cfZones: CfConfigZoneTick[] = [...state.chosenCfZones.entries()].map(([zoneId, meta]) => ({ zoneId, zoneName: meta.zoneName, accountId: meta.accountId }));
    const cfAccounts: CfConfigAccountTick[] = [...state.chosenCfAccounts.entries()].map(([accountId, accountName]) => ({ accountId, accountName, multiAccount: state.cfMultiAccount }));
    const prepared = [
      ...assembleBulkDownpipes(batchEntries(), cadence, chosenDestinationIds),
      ...assembleCfConfigBulk(
        cfZones,
        cfAccounts,
        state.cfScopePreset ?? "account-and-zone",
        state.cfCatalogue.filter((s) => s.scope === "zone").map((s) => s.id),
        cadence,
        chosenDestinationIds,
      ),
    ];
    // Nothing assembled. This is a should-not-happen (the step is only reachable with a selection), and it
    // returns with the button already disabled and reading "Creating" and NOTHING in flight to put it back,
    // so the wizard's one forward control is dead until the drawer is closed. A guard that cannot be
    // recovered from is worse than the state it guards against.
    // Nothing assembled. This is a should-not-happen (the step is only reachable with a selection), and it
    // returns with the button already disabled and reading "Creating" and NOTHING in flight to put it back,
    // so the wizard's one forward control is dead until the drawer is closed. A guard that cannot be
    // recovered from is worse than the state it guards against.
    if (prepared.length === 0) {
      formError.textContent = "That selection did not resolve to anything to create. Change the selection and try again.";
      formError.hidden = false;
      nextBtn.disabled = false;
      nextBtn.textContent = downpipeCount() > 1 ? `Create ${downpipeCount()} downpipes` : "Create downpipe";
      return;
    }
    if (prepared.length === 1) {
      // One resulting downpipe keeps the single-create feel: the typed name wins over the
      // derived one, and the response toast names it.
      const dp: Downpipe = { ...prepared[0]!.dp, id: slugId(name), name };
      void engine.addDownpipe(dp).then((res) => finishSingle(res, name)).catch(failInline);
      return;
    }
    void runBulkCreate(
      { bulk: (dps) => engine.bulkAddDownpipes(dps), single: (dp) => engine.addDownpipe(dp) },
      prepared.map((p) => ({ dp: p.dp, label: p.label })),
      (settled, total) => { nextBtn.textContent = `Creating ${settled} of ${total}`; },
    ).then((outcome) => {
      if (outcome.halted) {
        // PAINT FIRST, THEN LEAVE: the progress callback above leaves this button reading
        // "Creating 3 of 9", and a halted bulk create is exactly when it stops being updated.
        nextBtn.textContent = "Create";
        nextBtn.disabled = false;
        return goSignedOut();
      }
      clearLeaveGuard(guard);
      clearDraft(WIZARD_NAME_DRAFT);
      handle.close();
      onSaved();
      if (outcome.queued > 0 && outcome.failures.length === 0) {
        surfacePendingChange(outcome.queued === 1 ? "downpipe" : "set of downpipes");
      } else if (outcome.failures.length === 0) {
        toast({ message: `${outcome.done} downpipes created. First runs land on schedule, or trigger any now from its row.` });
      } else {
        const queuedNote = outcome.queued > 0 ? `, ${outcome.queued} queued for approval` : "";
        toast({ message: `${outcome.done} created${queuedNote}, ${outcome.failures.length} failed.`, tone: "warn" });
        openBulkSummary("create", "created", outcome.done, outcome.failures);
      }
      navigate("/downpipes");
    }).catch(failInline);
  };

  nextBtn.addEventListener("click", () => {
    if (step === 0) { advanceFromSource(); return; }
    if (step === 1) { step = 2; renderStep(); return; }
    submitCreate();
  });

  renderStep();
}
