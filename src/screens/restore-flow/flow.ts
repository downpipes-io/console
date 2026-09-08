// Restore the restore flow (the right column): pick the run and choose
// the blast radius (original bindings vs a redirect, the key control), the optional
// advanced scope (one record, prefixes, a record cap), the optional Cloudflare-config
// restore, and the dry-run trigger that re-arms the gate on every change. A prefilled or
// programmatic re-entry kicks off the dry-run so the operator lands on the review. Moved
// verbatim out of restore-flow.ts for size: no confirmation / dual-control wording and no
// plan-hash handling is changed. House rules: Australian English, no em dashes, precise
// claims.
//
// Once a dry-run plan builds successfully, the pick-run
// form COLLAPSES into a one-line summary ("Restoring run-x to original bindings") with a
// "Change" button; the plan review shows expanded below. "Change" re-expands the form (and
// re-arms the gate); if a live, unconsumed approval currently arms Apply, a confirm asks
// first, since re-expanding is the path that voids it. Nothing is ever REMOVED (only its
// display toggled via the CSSOM), so a tour anchor inside the form survives collapsed.

import type { EngineClient, RestoreRequest } from "../../api.ts";
import { blockError, inlineOutcome } from "../../components/error-view.ts";
import { banner } from "../../components/feedback.ts";
import { type Field, field, validateForm } from "../../components/field.ts";
import { wholeNumberAtLeast } from "../../components/field-bounds.ts";
import { confirmModal } from "../../components/modal.ts";
import { HEX_ID_PATTERN } from "../../lib/add-source.ts";
import { recordIntentDropped } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { loadDraft, saveDraft } from "../../lib/draft.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_ALERT, ICON_DOWNPIPES, ICON_EXTERNAL, ICON_RESTORE } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { checkboxRow } from "../notifications/shared.ts";
import { openDateBrowser } from "./date-picker.ts";
import { mountDryRunSweep } from "./dryrun-sweep.ts";
import { renderPlan } from "./plan.ts";
import { openRunPicker } from "./run-picker.ts";
import {
  type FlowPrefill, loadingPlan, RESTORE_STEP_COUNT,type RestoreJourneyInfo, restoreStepper, splitPrefixes, 
} from "./shared.ts";

// ---- the restore flow (right column) ----------------------------------------

// How long a dry-run can run before the loading note adds the "this can take a moment for
// large runs" reassurance. A UX threshold, named so the choice is explicit.
const DRY_RUN_SLOW_HINT_MS = 10_000;

export function renderRestoreFlow(
  engine: EngineClient,
  prefillRun: string | undefined,
  prefill?: FlowPrefill,
  // onJourney is a best-effort side channel for the context rail's live journey summary
  // (journey.ts): fired at the same points paintStepper repaints the stepper, plus whenever a fresh
  // plan hash is computed. Absent on the runless landing (workspace.ts has no context column there).
  onJourney?: (info: RestoreJourneyInfo) => void,
): HTMLElement {
  const wrap = h("div", { class: "stack" });

  // reenter rebuilds this flow column in place, scoped by a prefill. It
  // transplants a freshly built flow's children into this wrap, so the whole pick ->
  // review -> request -> approve -> apply flow re-runs for the subset from a clean state
  // (a fresh dry-run yields a new plan hash, which correctly lacks any prior approval).
  const reenter = (next: FlowPrefill) => {
    const fresh = renderRestoreFlow(engine, next.runId ?? prefillRun, next, onJourney);
    wrap.replaceChildren(...Array.from(fresh.childNodes));
  };

  const runId0 = prefill?.runId ?? prefillRun ?? "";

  // 1. Pick the run + scope.
  const runField = field({
    id: "rs-run",
    label: "Run id",
    required: true,
    value: runId0,
    placeholder: "run_01J8Z3K9QW7B2R",
    hint: "The run whose verified records you want to restore.",
    doc: { href: "https://docs.downpipes.io/reference/api/restore-and-recovery" },
  });
  // A cold entry to /restore has no run id in memory: open a restore-scoped picker OVER this
  // screen listing the recent runs, each row deep-linking to /restore/:runId (which auto-builds the
  // plan). It never dead-ends into the full Runs activity, so the restore framing is never lost and
  // returning is always a click away.
  //
  // On a COLD entry the picker is the lead affordance, not a quiet link. The screen used to open on a
  // required "Run id" field with the picker as a linklike underneath, which asks a customer arriving
  // mid-incident for the one thing they are least likely to have to hand. It was recoverable, so this
  // is a demotion of the question rather than a rescue: with a run already in hand (the /restore/:runId
  // entry, or a re-enter for a subset) the field is the answer and the picker goes back to being the
  // quiet way to change your mind.
  const browseRunsBtn = h(
    "button",
    { "data-dp": "restore-flow.button.browse-runs", class: runId0 === "" ? "btn btn--secondary" : "linklike", type: "button", style: "justify-self:start;align-self:start", on: { click: () => openRunPicker(engine, (chosen) => chooseRun(chosen)) } },
    runId0 === "" ? "Choose from recent runs" : "Browse runs to pick one",
  );
  // The calendar (point-in-time discovery): a second, honest way to arrive at the same run id, over
  // the same recent-run history ring the picker above already reads. It deep-links to /restore/:runId
  // exactly like the picker's own rows, so nothing downstream of the run id changes.
  const browseByDateBtn = h(
    "button",
    { "data-dp": "restore-flow.button.browse-by-date", class: runId0 === "" ? "btn btn--secondary" : "linklike", type: "button", style: "justify-self:start;align-self:start", on: { click: () => openDateBrowser(engine, (chosen) => chooseRun(chosen)) } },
    "Browse by date",
  );
  const includeField = field({ id: "rs-include", label: "Include prefixes (optional)", value: (prefill?.include ?? []).join(", "), placeholder: "session:, cart:", hint: "Comma-separated key prefixes (a literal startsWith, not a glob; no slash is added). Empty means all records; exclude wins over include.", doc: { href: "https://docs.downpipes.io/sources/selectors-and-scope" } });
  const excludeField = field({ id: "rs-exclude", label: "Exclude prefixes (optional)", value: (prefill?.exclude ?? []).join(", "), placeholder: "session:debug-", hint: "Comma-separated key prefixes removed from the set. Exclude wins over include.", doc: { href: "https://docs.downpipes.io/sources/selectors-and-scope" } });
  const maxField = field({ id: "rs-max", label: "Max records (optional)", type: "number", value: prefill?.maxRecords !== undefined ? String(prefill.maxRecords) : "", placeholder: "100", hint: "Caps the dry-run preview and a partial apply.", validate: wholeNumberAtLeast({ noun: "The record cap", min: 1, remedy: "Type how many records to cap the restore at, or leave it blank to plan the whole run." }), doc: { href: "https://docs.downpipes.io/recovery/granular-and-targeted-restores", anchor: "the-maxrecords-cap" } });
  // Restore one record (GRANULAR single-record restore): the EXACT source name of a single record to
  // restore. When set, the plan and the apply are scoped to precisely that one record (an exact name,
  // not a prefix) and the include/exclude prefixes are ignored. Empty means the whole run / the
  // prefixes above (the default). Each plan row also offers a "Restore just this" button that fills
  // this in for you; this field is the type-it-yourself path. The same dry-run -> approval -> apply
  // safety applies; it only ever narrows to one record.
  const recordNameField = field({ id: "rs-record", label: "Restore one record (optional)", value: prefill?.recordName ?? "", placeholder: "user:42", hint: "The exact record name to restore on its own (an exact match, not a prefix). Empty restores the whole run (or the prefixes above).", doc: { href: "https://docs.downpipes.io/recovery/granular-and-targeted-restores", anchor: "single-record-restore-by-exact-name" } });

  // Cloudflare config restore (optional): re-apply an idempotent Cloudflare-config surface (DNS, page rules,
  // rulesets, firewall) to the live account in-console. The token is an edit-scoped Cloudflare API token,
  // used once for this restore and never stored; the account (and zone for zone-scoped surfaces) name where
  // the snapshot belongs. Empty leaves cf-config records out of band exactly as before.
  const cfTokenField = field({ id: "rs-cf-token", label: "Cloudflare edit token (optional)", type: "password", value: "", hint: "A scoped Cloudflare API token with edit access to the config you are restoring. Used once for this restore, never stored or logged.", doc: { href: "https://docs.downpipes.io/operations/cloudflare-config-backup-restore" } });
  // Optional-hex validator for the Cloudflare ids below: empty stays valid (the whole context is
  // optional), anything typed must be a hex id. Same HEX_ID_PATTERN the add-source path enforces,
  // so the restore path can no longer accept an id shape the source path would have refused.
  const optionalHexId = (label: string) => (v: string): string | null =>
    v === "" || HEX_ID_PATTERN.test(v)
      ? null
      : `The ${label} must be hexadecimal (0-9, a-f) only, 8 to 64 characters. Paste the id exactly as Cloudflare shows it.`;
  const cfAccountField = field({ id: "rs-cf-account", label: "Cloudflare account id", value: "", placeholder: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", hint: "The 32-character account id the config was backed up from (dash.cloudflare.com, the Account ID in the right column).", validate: optionalHexId("account id"), doc: { href: "https://docs.downpipes.io/operations/cloudflare-config-backup-restore" } });
  const cfZoneField = field({ id: "rs-cf-zone", label: "Cloudflare zone id (zone surfaces)", value: "", placeholder: "f1e2d3c4b5a6978869504132a1b2c3d4", hint: "The 32-character zone id, required for zone-scoped surfaces (DNS, page rules); leave empty for account-only config.", validate: optionalHexId("zone id"), doc: { href: "https://docs.downpipes.io/operations/cloudflare-config-backup-restore" } });

  // Media restore (optional): re-upload captured Stream video / Images files to the live account. The
  // token is an edit-scoped Cloudflare API token, used once for this restore and never stored; the
  // account is the one the media was backed up from (Stream/Images are account-scoped, no zone). Empty
  // leaves media records out of band exactly as before (the existing docs-admitted API-only path).
  // Mirrors cfTokenField/cfAccountField above; see mediaRestore on RestoreRequest (api.ts) for the
  // engine contract (images keep their id; a video is re-uploaded as a new id). Seeded from a per-item
  // media reenter (plan.ts's mediaPlanned row "Restore just this"), an in-memory-only handoff (shared.ts
  // FlowPrefill.mediaRestore) so narrowing to one media record does not silently drop the token/account
  // the operator already typed.
  const mediaTokenField = field({ id: "rs-media-token", label: "Media edit token (optional)", type: "password", value: prefill?.mediaRestore?.token ?? "", hint: "A scoped Cloudflare API token with edit access to Stream and Images. Used once for this restore, never stored or logged.", doc: { href: "https://docs.downpipes.io/recovery/granular-and-targeted-restores" } });
  // LABELLED "(media)", not "Cloudflare account id". This field and
  // cfAccountField above both carried the byte-identical label "Cloudflare account id" and both are
  // visible on /restore at once, so nothing on screen told an operator which account each one meant,
  // and a locator by accessible name resolved two. That is the same shape as the re-key ceremony's two
  // deploy-token fields. The qualifier follows this screen's own convention, as in the sibling
  // "Cloudflare zone id (zone surfaces)" and "Media edit token (optional)".
  const mediaAccountField = field({ id: "rs-media-account", label: "Cloudflare account id (media)", value: prefill?.mediaRestore?.accountId ?? "", placeholder: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", hint: "The 32-character account the media (Stream and Images) was backed up from.", validate: optionalHexId("account id"), doc: { href: "https://docs.downpipes.io/recovery/granular-and-targeted-restores" } });
  // D1 table-subset restore (advanced): restore only chosen tables of ONE D1 database, into a fresh
  // database. database + tables compile to req.d1Tables; createOnly makes it a minimal extract.
  const d1DbField = field({ id: "rs-d1-db", label: "D1 database (optional)", value: "", placeholder: "app_db", hint: "The D1 database to restore a subset of. Leave empty to restore normally (the whole run, or the prefixes above).", doc: { href: "https://docs.downpipes.io/recovery/granular-and-targeted-restores", anchor: "d1-table-subset-restore" } });
  const d1TablesField = field({ id: "rs-d1-tables", label: "D1 tables", value: "", placeholder: "users, orders", hint: "Comma-separated table names to restore (matched case-insensitively to the backup). Restored into a FRESH database.", doc: { href: "https://docs.downpipes.io/recovery/granular-and-targeted-restores", anchor: "d1-table-subset-restore" } });
  const d1CreateOnly = checkboxRow("rs-d1-createonly", "Create only these tables (minimal extract)", "Otherwise the fresh database keeps the full schema and only these tables hold rows.", false);

  // The tedious-to-retype SCOPE (include/exclude/max) survives a navigation hop, keyed by run id,
  // WHEN THE RUN ID IS KNOWN AT MOUNT TIME. That qualifier is the whole of it, and leaving it off is
  // what this comment used to do. runId0 is prefill?.runId ?? prefillRun ?? "", so on the runless
  // /restore landing SCOPE_DRAFT is null for the entire life of that mount: nothing below reads a
  // draft and, because the persistScope wiring is inside the same guard, nothing WRITES one either.
  // A scope typed on the landing is held in the fields and nowhere else.
  //
  // This mattered because it was cited as a reason the navigation below was safe. The claim there was
  // that the draft carried include/exclude/max/record across the re-mount, so only the token-bearing
  // contexts needed suppressing. On the one path that navigation fires from, the draft does not exist,
  // and a capped, prefixed restore planned and applied UNCAPPED over every record. See
  // remountRebuildsRequest at the foot of this file for the guard that replaced it.
  //
  // Run id rides the URL; the reason-for-change (which can carry sensitive context) stays in memory.
  // Only seeded when this is NOT an explicit re-entry (a prefill is itself the intended scope and wins).
  //
  // THE BLAST-RADIUS TARGET IS DELIBERATELY NOT PERSISTED, and that is a sound intention rather than
  // the defect it was once read as. A redirect must be re-chosen on every entry and never restored
  // from a stale draft, because it is the highest-consequence control on this screen. The defect was
  // never the reset. It was that the navigation below re-mounted mid-flow and then BUILT AND ARMED a
  // plan against the calm default, silently, moments after the operator chose a redirect, instead of
  // either keeping their choice or refusing and asking for it again. Resetting a choice on a fresh
  // entry and discarding one already made are different acts, and only the second is a fault. The
  // guard below removes the second and leaves the first exactly as it was.
  const SCOPE_DRAFT = runId0 !== "" ? `restore-scope:${runId0}` : null;
  interface ScopeDraft { include?: string; exclude?: string; max?: string; record?: string; d1db?: string; d1tables?: string; d1createonly?: boolean }
  if (SCOPE_DRAFT && prefill === undefined) {
    const d = loadDraft<ScopeDraft>(SCOPE_DRAFT);
    if (d) {
      // FieldControl is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; every member has a
      // string .value setter, so assign through it directly rather than asserting one concrete element
      // type.
      if (typeof d.include === "string" && d.include !== "") includeField.control.value = d.include;
      if (typeof d.exclude === "string" && d.exclude !== "") excludeField.control.value = d.exclude;
      if (typeof d.max === "string" && d.max !== "") maxField.control.value = d.max;
      if (typeof d.record === "string" && d.record !== "") recordNameField.control.value = d.record;
      if (typeof d.d1db === "string" && d.d1db !== "") d1DbField.control.value = d.d1db;
      if (typeof d.d1tables === "string" && d.d1tables !== "") d1TablesField.control.value = d.d1tables;
      if (d.d1createonly === true) { const b = d1CreateOnly.el.querySelector("input") as HTMLInputElement | null; if (b) b.checked = true; }
    }
  }
  if (SCOPE_DRAFT) {
    const persistScope = (): void => saveDraft<ScopeDraft>(SCOPE_DRAFT, { include: includeField.value(), exclude: excludeField.value(), max: maxField.value(), record: recordNameField.value(), d1db: d1DbField.value(), d1tables: d1TablesField.value(), d1createonly: d1CreateOnly.checked() });
    for (const f of [includeField, excludeField, maxField, recordNameField, d1DbField, d1TablesField]) f.control.addEventListener("input", persistScope);
    d1CreateOnly.el.querySelector("input")?.addEventListener("change", persistScope);
  }

  // The target choice: the key blast-radius control, two visually distinct options,
  // not a quiet text field. Original bindings is the
  // calm default; a redirect is the caution affordance and triggers type-to-confirm.
  const target = targetChoice(prefill?.targetBinding);

  const planHost = h("div", { class: "restore-plan-host", "aria-live": "polite" });

  // data-tour-id is an inert hook the public tour's try-it beat spotlights (the visitor genuinely
  // builds the read-only dry-run plan from the guided walk). This button lives inside `form`,
  // which collapses (display:none) once a plan builds, but is NEVER removed, so the anchor still
  // resolves in the DOM (validate-tour.ts stays green) even while visually collapsed.
  const dryRunBtn = h("button", { "data-busy-label": "Verifying the run", "data-dp": "restore-flow.button.dry-run", class: "btn btn--primary", type: "button", dataset: { tourId: "restore-build" } }, svgIcon(ICON_RESTORE, { size: 16 }), "Build the restore plan") as HTMLButtonElement;

  const form = h(
    "form",
    { class: "card form-stack", "aria-label": "Build a restore plan", on: { submit: (ev: Event) => ev.preventDefault() } },
    h("h2", { class: "card__title" }, "Pick the run and choose the blast radius"),
    // COLD ENTRY leads with the two ways of FINDING a run and says the run id is not needed, then
    // offers the field for the operator who already has one. With a run in hand the original order
    // stands: the field carries the answer and the browse row stays underneath it.
    ...(runId0 === ""
      ? [
          h("p", { class: "field__hint", style: "margin:0" }, "You do not need the run id. Pick the run from the recent runs, or find it by the date you want to go back to."),
          h("div", { class: "restore-flow__browse-row" }, browseRunsBtn, browseByDateBtn),
          h("p", { class: "field__hint", style: "margin:var(--space-2) 0 0" }, "Already have the run id? Type it here instead."),
          runField.el,
        ]
      : [runField.el, h("div", { class: "restore-flow__browse-row" }, browseRunsBtn, browseByDateBtn)]),
    target.el,
    // The summary labels carry the shared h2.disclosure__heading (the collapsedSection
    // pattern) so they hold the heading weight and stay in the document outline.
    h(
      "details",
      { class: "disclosure" },
      h("summary", h("h2", { class: "disclosure__heading" }, "Advanced: one record, prefixes and a record cap")),
      h(
        "div",
        { class: "disclosure__body" },
        // The record-scoping fields carry one small sub-heading and lay two-up on wide viewports
        // (collapsing to one column on narrow). The single-record override spans the full width as its
        // own distinct mode; the include/exclude prefixes pair up and the record cap follows. Field
        // ids, labels, hints and the input re-arm wiring above are unchanged; only the grouping moves.
        h("h3", { class: "restore-subhead" }, "Scope the records"),
        h(
          "div",
          { class: "restore-field-grid" },
          h("div", { class: "restore-field-grid__span" }, recordNameField.el),
          includeField.el,
          excludeField.el,
          maxField.el,
        ),
      ),
    ),
    h(
      "details",
      { class: "disclosure" },
      h("summary", h("h2", { class: "disclosure__heading" }, "Cloudflare config restore (optional)")),
      h(
        "div",
        { class: "disclosure__body" },
        h("p", { class: "field__hint" }, "Re-apply a Cloudflare config backup (idempotent surfaces: DNS, page rules, rulesets, firewall) to the live account. The dry-run shows the diff and an apply needs the same dual-control approval as any restore. Other config (Access ordering, certificate keys) stays out of band for deliberate re-provisioning."),
        // The Cloudflare credential fields carry one small sub-heading and lay two-up on wide
        // viewports. The edit token is a secret, so it spans the full width; the account and zone ids
        // pair up beneath it. Field ids, labels, hints and the re-arm wiring above are unchanged.
        h("h3", { class: "restore-subhead" }, "Cloudflare account"),
        h(
          "div",
          { class: "restore-field-grid" },
          h("div", { class: "restore-field-grid__span" }, cfTokenField.el),
          cfAccountField.el,
          cfZoneField.el,
        ),
      ),
    ),
    h(
      "details",
      { class: "disclosure" },
      h("summary", h("h2", { class: "disclosure__heading" }, "Media restore (optional)")),
      h(
        "div",
        { class: "disclosure__body" },
        h("p", { class: "field__hint" }, "Re-upload captured Stream video and Images files to the live account. The dry-run shows which files would upload; an apply needs the same dual-control approval as any restore. An image re-uploads to its original id; a video re-uploads as a NEW id (Stream transcodes every upload), reported on the receipt as an id map. Metadata-only records and Artifact Registry blobs (a git push, not a REST upload) always stay out of band."),
        h("h3", { class: "restore-subhead" }, "Cloudflare account"),
        h(
          "div",
          { class: "restore-field-grid" },
          h("div", { class: "restore-field-grid__span" }, mediaTokenField.el),
          mediaAccountField.el,
        ),
      ),
    ),
    h(
      "details",
      { class: "disclosure" },
      h("summary", h("h2", { class: "disclosure__heading" }, "D1 table-subset restore (optional)")),
      h(
        "div",
        { class: "disclosure__body" },
        h("p", { class: "field__hint" }, "Restore only chosen tables of one D1 database, into a FRESH database (never in place). The header re-creates the full schema and only the chosen tables hold rows, unless you tick 'create only'. Selecting a child table without its foreign-key parent is flagged in the dry-run. It supersedes the prefixes above for that database."),
        h("h3", { class: "restore-subhead" }, "D1 tables"),
        h(
          "div",
          { class: "restore-field-grid" },
          d1DbField.el,
          d1TablesField.el,
          h("div", { class: "restore-field-grid__span" }, d1CreateOnly.el),
        ),
      ),
    ),
    h("div", { class: "restore-flow__build" }, dryRunBtn),
  );

  // The collapsed one-line summary ("Restoring run-x to original bindings" / "..., redirected
  // to BINDING") + its "Change" button, built once alongside `form` and toggled with it (never both
  // visible). Hidden until the first successful build. A labelled region, not bare prose (FOCUS
  // MANAGEMENT / heading-semantics acceptance criterion).
  const pickSummaryText = h("span", { class: "restore-pick-summary__text" });
  const changeBtn = h("button", { "data-dp": "restore-flow.button.change", class: "btn btn--secondary btn--sm", type: "button" }, "Change") as HTMLButtonElement;
  const pickSummary = h(
    "section",
    { class: "restore-pick-summary", "aria-label": "Selected run and target" },
    pickSummaryText,
    changeBtn,
  );
  pickSummary.style.setProperty("display", "none");

  const stepperHost = h("div");
  let currentStep = 1;
  // lastPlanHash mirrors the hash renderPlan computes (via the onPlanHash callback passed into it
  // below), purely so paintStepper can hand the journey summary an up-to-date value at every step
  // change without plan.ts needing to know about the journey at all.
  let lastPlanHash: string | null = null;
  // The flow stepper (wireframe "Restore progress"): pick -> review -> approval ->
  // confirm -> apply -> receipt. It advances as the operator moves through the flow; it
  // is indicative (the real gate is the plan + the role), with aria-current on the
  // active step. "Approval" becomes current when a request is raised (the dominant real
  // wait) and "Confirm" when a usable approval arms the gate.
  const paintStepper = (step: number) => {
    // E1 (shared.ts restoreStepper): hand the stepper the step this paint is advancing FROM,
    // captured before currentStep is overwritten, so it can fill the one connector just crossed.
    // The guard that turns this into a one-shot, forward-only animation lives entirely in
    // restoreStepper; this is the only change needed at the call site.
    const prevStep = currentStep;
    currentStep = step;
    stepperHost.replaceChildren(restoreStepper(step, prevStep));
    // A write is in flight (step 5): disable Change so it cannot race a live apply call into
    // voiding the very approval that call is consuming (the void-warning protects against
    // discarding a live approval; this protects against doing so WHILE it is being consumed).
    changeBtn.disabled = step === 5;
    // Apply succeeded. The pick summary's "Change" affordance no
    // longer has anything useful to offer (confirm.ts has already collapsed the plan/confirm
    // content above the receipt), so retire it too, per the same "collapse everything above the
    // payoff" instruction.
    if (step > RESTORE_STEP_COUNT) pickSummary.style.setProperty("display", "none");
    onJourney?.({ step, planHash: lastPlanHash });
  };
  paintStepper(1);
  wrap.appendChild(stepperHost);

  // A re-entry note: an honest line explaining the flow was re-scoped.
  if (prefill?.note) {
    wrap.appendChild(banner({ tone: "info", message: prefill.note }));
  }

  wrap.appendChild(form);
  wrap.appendChild(pickSummary);
  wrap.appendChild(planHost);

  const buildRequest = (confirm: boolean): RestoreRequest => {
    const req: RestoreRequest = { runId: runField.value() };
    if (confirm) req.confirm = true;
    const binding = target.binding();
    if (binding !== "") req.target = { binding };
    // A REDIRECT with an empty binding. The operator picked the loud, dangerous option and left the box
    // blank, so no target rides, and the engine plans and applies against the LIVE ORIGINAL bindings, which is
    // the exact opposite of what was asked for and the highest blast radius this screen has. The engine cannot
    // see the mistake (it receives a well-formed request for the default target and is right about it), so this
    // row is the only witness there could be. The binding NAME is never recorded: the class is the whole row.
    if (target.redirectChosen() && binding === "") recordIntentDropped("redirect-binding-empty");
    // cf-config restore context (orthogonal to the data-record scope below): when an edit token + account
    // are given, idempotent Cloudflare-config surfaces re-apply. Set before the recordName early-return so
    // it applies on both the single-record and whole-run paths. The token is sent for this request only.
    const cfToken = cfTokenField.value().trim();
    const cfAccount = cfAccountField.value().trim();
    if (cfToken !== "" && cfAccount !== "") {
      const cfZone = cfZoneField.value().trim();
      req.cfConfig = { token: cfToken, accountId: cfAccount, ...(cfZone !== "" ? { zoneId: cfZone } : {}) };
    } else if (cfToken !== "" || cfAccount !== "") {
      // HALF A PAIR. One of the two was typed and the other left blank, so the whole cf-config section is
      // dropped out of the request and the restore silently proceeds WITHOUT re-applying any Cloudflare
      // configuration. The operator pasted an edit token and believes their DNS and WAF are coming back. The
      // engine sees a request with no cfConfig on it, which is a perfectly ordinary data-only restore, so there
      // is nothing for it to record. Neither the token nor the account id has a field on this row.
      recordIntentDropped("cf-pair-partial");
    }
    // Media restore context (orthogonal to the data-record scope below, like cfConfig above): when an
    // edit token + account are given, captured Stream video / Images files re-upload on apply. Set
    // before the recordName early-return so it applies on both the single-record and whole-run paths
    // (a named record that happens to be a media record still re-uploads; a named data record simply
    // never reads this context). The token is sent for this request only, never stored.
    const mediaToken = mediaTokenField.value().trim();
    const mediaAccount = mediaAccountField.value().trim();
    if (mediaToken !== "" && mediaAccount !== "") {
      req.mediaRestore = { token: mediaToken, accountId: mediaAccount };
    } else if (mediaToken !== "" || mediaAccount !== "") {
      // Half a pair, exactly as above, and the same silence. The captured Stream videos and Images are
      // simply not re-uploaded, and the run reports success.
      recordIntentDropped("media-pair-partial");
    }
    // A single-record restore is the more specific intent: when a record name is given it scopes the
    // plan + apply to EXACTLY that one record and the engine ignores the prefixes, so the console sends
    // recordName ALONE (not include/exclude) to match that contract and keep the plan hash honest. A
    // record cap is meaningless for a single record, so it is dropped too. Trimmed so trailing spaces
    // typed into the field cannot produce a name that never matches.
    const recordName = recordNameField.value().trim();
    if (recordName !== "") {
      req.recordName = recordName;
      return req;
    }
    // D1 table-subset restore: when a D1 database + at least one table are given, scope the restore to
    // those tables of that database into a fresh database (the engine ignores the prefixes, like
    // recordName), optionally creating ONLY those tables. Sent ALONE to match the engine's d1Allow
    // contract and keep the plan hash honest. recordName above is the more specific intent and wins.
    // Requires an engine that supports d1Tables (it binds into the plan hash): ship the console and engine
    // d1-subset features together, like cf-config/recordName. Against a d1-unaware engine a table-subset
    // request would plan the whole run and its approval hash would never match (a stuck gate, but fail-safe).
    const d1Db = d1DbField.value().trim();
    const d1Tabs = splitPrefixes(d1TablesField.value());
    if (d1Db !== "" && d1Tabs.length > 0) {
      req.d1Tables = { database: d1Db, tables: d1Tabs, ...(d1CreateOnly.checked() ? { createOnly: true } : {}) };
      return req;
    }
    if (d1Db !== "" || d1Tabs.length > 0) {
      // A D1 subset with only one half given. The d1Tables scope is dropped, so the request falls through
      // to the prefix path below and the WHOLE RUN is planned: the operator asked for a few tables and got
      // every record in the backup. The engine's plan is correct for the request it was sent, so the over-broad
      // plan looks exactly like a deliberate full restore. The database and table names never enter the row.
      recordIntentDropped("d1-subset-partial");
    }
    const include = splitPrefixes(includeField.value());
    if (include.length) req.include = include;
    const exclude = splitPrefixes(excludeField.value());
    if (exclude.length) req.exclude = exclude;
    const max = Number(maxField.value());
    if (Number.isFinite(max) && max > 0) req.maxRecords = Math.round(max);
    else if (maxField.value().trim() !== "") {
      // A Max records the operator typed and the builder could not use (it did not parse, or it was zero
      // or negative). The cap is dropped and the run is planned UNCAPPED: this is the "I set Max records to 100
      // and the plan showed 40,000 writes" report, verbatim. The engine received no maxRecords and planned the
      // whole run faithfully. Recorded only when something was actually TYPED: an empty box is the ordinary
      // "no cap" choice and is not a fault.
      recordIntentDropped("max-records-invalid");
    }
    return req;
  };

  // Re-arm on ANY input change: re-hide the plan and reset the stepper, with the visible
  // "Plan changed" line, so a stale plan/confirm can never leak onto a different request.
  const rearm = () => {
    if (currentStep > 1 && planHost.childElementCount > 0) {
      lastPlanHash = null;
      paintStepper(1);
      planHost.replaceChildren(
        banner({ tone: "info", message: "Plan changed. Build the plan again and review before you confirm." }),
      );
    }
  };
  // Every bound field re-arms the gate on change, INCLUDING the Cloudflare-config and media-restore
  // fields: their accountId (+ zoneId for cf-config) bind into the plan hash exactly like
  // include/exclude/maxRecords (helpers.ts restorePlanHash), so editing them must invalidate a stale
  // plan/approval the same way. The token itself does not bind into the hash, but is included too
  // (conservative: re-verifying a plan the operator did not strictly need to is a minor friction cost,
  // never a safety regression, and a corrected token is exactly the kind of change that should prompt a
  // fresh look at the plan).
  for (const f of [runField, includeField, excludeField, maxField, recordNameField, cfTokenField, cfAccountField, cfZoneField, mediaTokenField, mediaAccountField, d1DbField, d1TablesField]) {
    f.control.addEventListener("input", rearm);
  }
  // The createOnly checkbox binds into the plan hash too, so a change must re-arm a stale plan/approval.
  d1CreateOnly.el.querySelector("input")?.addEventListener("change", rearm);
  target.onChange(rearm);

  // chooseRun is what the run picker and the date browser call once the operator settles on a run. Both
  // used to deep-link to /restore/:runId unconditionally, which re-mounts this whole flow from empty
  // fields and, because the re-mount's prefillRun branch fires its own dry-run, PAINTS a plan built from
  // the run id alone: with include/exclude/max typed, a redirect chosen and a Cloudflare edit token
  // pasted, the only request that would reach the engine was {"runId":"..."} and every field came back
  // empty. A capped, redirected restore could plan and arm UNCAPPED over the LIVE ORIGINAL bindings,
  // moments after the operator chose otherwise, and the redirect's type-to-confirm would never fire
  // because the plan the screen then held was not a redirect.
  //
  // The rule is the same navigation rule (remountRebuildsRequest at the foot of this file) applied at
  // the other end: hop to the bookmarkable URL only when a fresh mount there would rebuild this exact
  // request. For anything but a bare run id it cannot, so the run id is set IN PLACE instead. The
  // break-glass panel's picker has always done this (it passes an onPick so the operator's already-supplied
  // key is not discarded by a re-render); this is the standard flow catching up with it.
  //
  // In place means the run id lands in the field and NOTHING is planned: the operator still builds the plan
  // themselves, from the form in front of them. Resetting a choice on a fresh entry and discarding one
  // already made are different acts, and only the second is a fault.
  //
  // The stored draft is the other half of the same question and it points the opposite way, exactly as it
  // does at that navigation. This landing never WRITES the per-run scope draft, but an earlier visit to
  // /restore/:runId for the CHOSEN run may have, and the re-mount would read it back and ADD a scope the
  // operator did not type here: a landing with nothing typed, picking a run whose draft held
  // include ["session:"], could re-mount into {"runId":"...","include":["session:"]}. Narrower is the less
  // destructive direction, but it is still a plan the operator did not build.
  function chooseRun(chosen: string): void {
    runField.control.value = chosen;
    rearm();
    const chosenDraft = loadDraft<ScopeDraft>(`restore-scope:${chosen}`);
    if (remountRebuildsRequest(buildRequest(false)) && chosenDraft === null) {
      navigate(`/restore/${encodeURIComponent(chosen)}`);
      return;
    }
    // Guard focus() so a non-browser host (the validate-* DOM shim) does not throw.
    if (typeof dryRunBtn.focus === "function") dryRunBtn.focus();
  }

  // Collapse the pick form into the one-line summary once a plan builds successfully (runId +
  // the chosen target only, matching the acceptance-criterion example). expandPickForm is the
  // inverse: shown by "Change" (below), it ALWAYS re-arms (there is no scenario where re-expanding
  // should leave a stale plan/confirm block visible beside an editable form) and moves focus to the
  // first field (FOCUS MANAGEMENT).
  const collapsePickForm = (runId: string, binding: string): void => {
    // Text nodes (not bare strings): replaceChildren wraps strings into text nodes in a real
    // browser, but the validate-* DOM shim does not, so build the nodes explicitly.
    const parts: Node[] = [document.createTextNode("Restoring "), h("span", { class: "mono" }, runId)];
    if (binding !== "") parts.push(document.createTextNode(", redirected to "), h("span", { class: "mono" }, binding));
    else parts.push(document.createTextNode(" to original bindings"));
    pickSummaryText.replaceChildren(...parts);
    form.style.setProperty("display", "none");
    pickSummary.style.setProperty("display", "");
  };
  const expandPickForm = (): void => {
    pickSummary.style.setProperty("display", "none");
    form.style.setProperty("display", "");
    rearm();
    if (typeof runField.focus === "function") runField.focus();
  };

  // "Change": if a live, unconsumed approval currently arms Apply, changing the plan
  // will void it (a fresh plan needs a fresh request), so ask first; otherwise there is nothing to
  // lose and the form re-expands directly. `.restore-confirm__armed` is confirm.ts's own DOM marker
  // for the armed state (the same class its poll loop already checks), read here rather than
  // threading a duplicate live-approval callback through plan.ts/confirm.ts for a fact the DOM
  // already states unambiguously.
  changeBtn.addEventListener("click", () => {
    const liveApproval = planHost.querySelector(".restore-confirm__armed") !== null;
    if (!liveApproval) {
      expandPickForm();
      return;
    }
    void confirmModal({
      title: "Change the restore plan",
      body: "Changing the plan will void the current approval and need a fresh request. Continue?",
      confirmLabel: "Change the plan",
      cancelLabel: "Keep this plan",
    }).then((proceed) => {
      if (proceed) expandPickForm();
    });
  });

  const runDryRun = async () => {
    const fields: Field[] = [runField, cfAccountField, cfZoneField, mediaAccountField];
    if (!validateForm(fields)) return;
    // A guard: a REDIRECT with an empty binding would plan against the LIVE ORIGINAL bindings (the exact
    // opposite of the redirect the operator chose, and the highest blast radius this screen has). Block it at
    // the field rather than silently planning the dangerous default. buildRequest's recordIntentDropped stays
    // as a belt-and-braces witness for any path that still reaches it.
    if (target.redirectChosen() && target.binding() === "") {
      target.setBindingError("Enter the binding to redirect to, or choose “Restore to original bindings”.");
      return;
    }
    target.setBindingError(null);
    // A Max records value the operator TYPED that cannot cap (it does not parse to a finite
    // number, or it is zero or negative) is dropped by buildRequest and the run planned UNCAPPED -- a silent
    // over-restore that writes far more records than the operator asked to ("I set Max records to 100 and the
    // plan showed 40,000 writes"). Block it at the field, matching the pairing guards below, rather than planning
    // the whole run behind their back. The accept condition mirrors buildRequest EXACTLY (Number.isFinite && > 0),
    // so a value the builder would use is never blocked here (no client-looser divergence). refuse() shows the
    // inline error AND records the console's own refusal (the parsed-value rule runs only at submit, outside the
    // validate() funnel); buildRequest's recordIntentDropped("max-records-invalid") stays as the witness.
    maxField.clearError();
    const maxTyped = maxField.value();
    if (maxTyped !== "") {
      const maxVal = Number(maxTyped);
      // THE GUARD WAS LOOSER THAN THE FIELD'S OWN RULE, AND THE GAP WAS A SILENT ROUNDING. The field carries
      // wholeNumberAtLeast({min:1}) and says so, but this gate only asked for finite-and-above-zero, so 2.7
      // passed it and buildRequest's Math.round turned the cap into 3. The operator saw the field's "whole
      // number" error, pressed Dry run, and got a plan capped at a number they never typed. Requiring the
      // whole number here makes the gate agree with the field, and the builder's Math.round can then only
      // ever see a value that is already whole.
      if (!Number.isInteger(maxVal) || maxVal <= 0) {
        maxField.refuse(`Max records must be a whole number of 1 or more (you entered “${maxTyped}”), or clear the field to restore every record.`);
        maxField.focus();
        return;
      }
    } else if (maxField.badInput()) {
      // The browser blanked an entry it could not read as a number (a comma, a separator, a stripped
      // symbol), so value() reads empty and buildRequest silently drops the cap. badInput is the one surviving
      // signal that the operator DID type a cap; block it rather than planning the whole run uncapped.
      maxField.refuse("Max records must be a plain whole number with no commas, spaces, or symbols, or clear the field to restore every record.");
      maxField.focus();
      return;
    }
    // Pairing guards: each optional context only reaches the request when its parts are complete
    // (buildRequest forms req.cfConfig/req.mediaRestore from token AND account, and req.d1Tables
    // from database AND tables). A half-filled context would otherwise be DROPPED without a word,
    // and a half-filled D1 subset falls back to a whole-run restore. Surface the missing half at
    // the field instead of planning something the operator did not mean.
    const cfMissing = pairingError(
      [cfTokenField.value(), cfAccountField.value(), cfZoneField.value()],
      [
        [cfTokenField, "The Cloudflare config restore needs this edit token too, or clear the other Cloudflare config fields."],
        [cfAccountField, "The Cloudflare config restore needs the account id too, or clear the token."],
      ],
    );
    const mediaMissing = pairingError(
      [mediaTokenField.value(), mediaAccountField.value()],
      [
        [mediaTokenField, "The media restore needs this edit token too, or clear the account id."],
        [mediaAccountField, "The media restore needs the account id too, or clear the token."],
      ],
    );
    const d1Missing = pairingError(
      [d1DbField.value(), d1TablesField.value()],
      [
        [d1DbField, "The table-subset restore needs the D1 database these tables belong to, or clear the tables field."],
        [d1TablesField, "The table-subset restore needs at least one table. Without it the database field is ignored and the WHOLE run plans."],
      ],
    );
    if (cfMissing || mediaMissing || d1Missing) return;
    // Each fresh dry-run RE-ARMS the gate (flow.md Stage 6): any prior plan/apply
    // affordance is cleared and rebuilt from the new plan; the dual-control approval keys
    // on the plan hash, so a changed plan automatically lacks a matching approval.
    lastPlanHash = null;
    paintStepper(2);
    const skeleton = loadingPlan();
    planHost.replaceChildren(skeleton);
    // E3 (dry-run verification sweep): bound to THIS request only. mountDryRunSweep only starts
    // drawing if the request is still unresolved after its own delay, and the sweep.stop() call in
    // `finally` below always tears it down the moment this request settles, so it can never
    // outlive the skeleton it draws over.
    const sweep = mountDryRunSweep(skeleton);
    dryRunBtn.dataset.busy = "true";
    dryRunBtn.textContent = "Verifying the run";
    dryRunBtn.disabled = true;
    const slow = window.setTimeout(() => {
      const note = planHost.querySelector(".restore-plan__loadnote");
      if (note) note.textContent = "Verifying the run. This can take a moment for large runs.";
    }, DRY_RUN_SLOW_HINT_MS);
    try {
      // The request is held rather than passed inline because the R2b navigation below has to ask what
      // was in it. See carriesOneTimeContext: the navigation re-mounts the flow, and a re-mount can only
      // rebuild what was persisted, so what the request carried decides whether it may happen at all.
      // CHANGE UNRECORDED: buildRequest(false) omits confirm, so this is the read-only dry-run leg of the
      // multiplexed POST /restore. The engine writes nothing and records no config mutation, so demanding a
      // change number here would interrupt the operator for a read.
      const req = buildRequest(false);
      const res = await engine.restore(req);
      window.clearTimeout(slow);
      if (res.mode !== "dry-run") {
        planHost.replaceChildren(inlineOutcome({ heading: "Unexpected response", reason: "The engine did not return a dry-run plan." }));
        return;
      }
      // (shareable mid-restore session): a typed run id on the runless landing that resolves to
      // a real, buildable plan (res.ok) earns its own bookmarkable URL. Re-entering at
      // /restore/:runId re-runs this SAME dry-run automatically (the prefillRun branch at the
      // bottom of this function), a second harmless read, rather than carrying this closure's
      // in-memory state across the navigation (a materially bigger, riskier change for a
      // highest-consequence flow). Skipped when already on /restore/:runId (prefillRun set) or mid a
      // scoped reenter (prefill set), so this can only ever fire once per run and can never loop. A
      // rejected plan (res.ok false: an unrecognised run, break-glass posture, or a plan the engine
      // could not build) does NOT navigate, since the operator still needs the expanded form to
      // correct the input.
      //
      // AND skipped unless a fresh mount would rebuild THIS EXACT REQUEST (remountRebuildsRequest
      // below). The second read is only harmless while that holds, and on this landing it holds for
      // the run id alone: everything else the operator typed is dropped, and the plan the DROPPED
      // request earns is the one that paints.
      //
      // The stored draft is the other half of the same question, and it points the opposite way. This
      // landing never WRITES the per-run scope draft, but an earlier visit to /restore/:runId for this
      // same run may have, and the re-mount would read it back and ADD a scope the operator did not
      // type here: a landing request of {"runId":"..."} could re-mount into
      // {"runId":"...","include":["session:"]}, and the narrowed plan would be the one that paints. Narrower
      // is the less destructive direction and the re-mounted fields do show it, but it is still a plan
      // the operator did not build, so the same rule applies rather than an exception to it.
      const remountDraft = loadDraft<ScopeDraft>(`restore-scope:${req.runId}`);
      if (!prefillRun && !prefill && res.ok && remountRebuildsRequest(req) && remountDraft === null) {
        navigate(`/restore/${encodeURIComponent(res.runId)}`, { replace: true });
        return;
      }
      planHost.replaceChildren(
        await renderPlan(engine, res, buildRequest, paintStepper, reenter, (hash) => {
          lastPlanHash = hash;
          onJourney?.({ step: currentStep, planHash: hash });
        }),
      );
      if (res.ok) {
        collapsePickForm(res.runId, target.binding());
        // FOCUS MANAGEMENT (WCAG 2.4.3): move focus to the plan review heading now that the pick
        // form has collapsed out of view (restore-plan__heading carries tabindex="-1", plan.ts).
        // Guard focus() so a non-browser host (the validate-* DOM shim) does not throw.
        const planHeading = planHost.querySelector<HTMLElement>(".restore-plan__heading");
        if (planHeading && typeof planHeading.focus === "function") planHeading.focus();
      }
    } catch (err) {
      window.clearTimeout(slow);
      if (isUnauthorised(err)) return goSignedOut();
      // Transport/auth fault (channel two): an inline block error with Retry; the whole
      // request (run id, target, prefixes) is preserved in the form (flow.md Stage states).
      planHost.replaceChildren(blockError(err, () => void runDryRun(), { origin: location.origin }));
    } finally {
      window.clearTimeout(slow);
      sweep.stop();
      dryRunBtn.dataset.busy = "false";
      dryRunBtn.textContent = "Build the restore plan";
      dryRunBtn.disabled = false;
    }
  };

  dryRunBtn.addEventListener("click", () => void runDryRun());

  // A prefilled run (a "restore from this run" deep link) or a programmatic re-entry
  // kicks off the dry-run so the operator lands on the review panel, the
  // low-error primary path.
  if (prefillRun || prefill) queueMicrotask(() => void runDryRun());

  return wrap;
}

// pairingError enforces an all-or-nothing optional field group at plan-build time: if ANY member
// of the group carries a value, every required member must too. Clears then sets the inline error
// on the first missing required field, focuses it, and reports whether the group blocks the
// dry-run. Values arrive already trimmed by field().value(). Runs per plan-build click (not per
// keystroke), matching the design system's validate-on-submit rule for cross-field constraints.
function pairingError(values: string[], required: Array<[Field, string]>): boolean {
  for (const [f] of required) f.clearError();
  if (!values.some((v) => v !== "")) return false;
  for (const [f, message] of required) {
    if (f.value() === "") {
      f.setError(message);
      f.focus();
      return true;
    }
  }
  return false;
}

// remountRebuildsRequest answers the only question the R2b navigation is entitled to ask: would a fresh
// mount of this flow at /restore/:runId build the SAME request this one just sent? If not, the navigation
// silently swaps the operator's plan for a different one, because the re-mount's own dry-run is the one
// that paints.
//
// On the runless landing the answer is the run id and nothing else, and that is not an opinion:
//
//   THE TOKENS       cfConfig and mediaRestore are edit-scoped Cloudflare API tokens. draft.ts's honesty
//                    rule is explicit that a secret never enters a draft (there is no secure browser
//                    store, and the module deliberately offers no "secure" mode), so neither can survive
//                    a navigation and neither can ride a URL.
//   THE TARGET       the blast-radius choice is deliberately never persisted, so the re-mount resets it to
//                    the calm original-bindings default.
//   THE SCOPE        SCOPE_DRAFT above is null whenever the flow mounts WITHOUT a run id, which is exactly
//                    the state this navigation fires from, so the runless landing never writes the per-run
//                    scope draft and there is nothing for the re-mount to read back.
//
// Concretely, for each context this re-mount would drop:
//   cfConfig  a request with cfConfig set could earn a many-surface diff; the re-mount's bare {"runId":"..."}
//             would instead paint "This plan writes nothing, so there is nothing to apply".
//   target    a request with a redirect target set plans and arms against that binding; the re-mount's bare
//             request would instead write every record back over the LIVE ORIGINAL bindings, and the
//             redirect's type-to-confirm would never fire, because the plan the screen then holds is not a
//             redirect.
//   scope     a request with include/exclude/maxRecords set plans a capped, prefixed restore; the re-mount's
//             bare request would instead plan and apply UNCAPPED over every record.
//
// Suppressing the navigation is the honest answer rather than a workaround: the URL cannot carry any of
// this either, so the "shareable mid-restore session" such a restore would earn is not shareable, and a
// recipient opening the link would land on precisely the wrong plan. A restore carrying anything the
// address bar cannot hold is a session, not a bookmark. Every restore that really is just a run id still
// earns its URL, unchanged.
//
// Stated as a structural check rather than a list of known fields, because the list was the bug: it named
// the two tokens, warned that a third context would have to be added by hand, and two more already existed
// and were never added. A field added to buildRequest and forgotten here now costs a URL the operator does
// not get, which they can see, instead of a plan they did not ask for, which they cannot.
function remountRebuildsRequest(req: RestoreRequest): boolean {
  return Object.keys(req).every((key) => key === "runId");
}

// ---- the target choice (two distinct blast-radius options) ------------------

interface TargetChoice {
  el: HTMLElement;
  // The selected redirect binding ("" for the original-bindings default).
  binding(): string;
  // Whether the operator picked the REDIRECT option, independently of whether they filled the binding in
  // binding() collapses the two: it answers "" both for the calm original-bindings default and for a
  // redirect whose binding box is empty, and those are opposite intents. A redirect with an empty binding
  // sends no target at all, so an approved apply writes every record back over the LIVE ORIGINAL bindings,
  // which is the single most dangerous thing this screen can do and the operator asked for the opposite.
  redirectChosen(): boolean;
  // Show (a message) or clear (null) a validation error on the redirect binding input. The dry-run guard
  // calls this to BLOCK a redirect with an empty binding at the field, instead of silently planning
  // against the original bindings, which is the exact opposite of what the operator chose.
  setBindingError(msg: string | null): void;
  // Subscribe to a change of selection or the binding input (drives re-arm).
  onChange(fn: () => void): void;
}

function targetChoice(prefillBinding?: string): TargetChoice {
  // Math.random here only avoids a DOM element-id collision between two target-choice radio
  // groups on the same page. It derives no token, nonce or challenge, so the weak randomness
  // is fine; all security material goes through randomBytes (crypto.getRandomValues).
  const name = `rs-target-${Math.random().toString(36).slice(2, 8)}`;
  const listeners: Array<() => void> = [];
  const fire = () => { for (const fn of listeners) fn(); };

  // A prefilled redirect binding (F4 retry-subset of a redirected restore) starts the
  // redirect option selected with the binding restored, so the subset retries to the same
  // redirect target rather than silently reverting to original bindings.
  const startRedirect = prefillBinding !== undefined && prefillBinding !== "";

  const originalRadio = h("input", { "data-dp": "restore-flow.radio.original-radio", type: "radio", name, value: "original", ...(startRedirect ? {} : { checked: true }) }) as HTMLInputElement;
  const redirectRadio = h("input", { "data-dp": "restore-flow.radio.redirect-radio", type: "radio", name, value: "redirect", ...(startRedirect ? { checked: true } : {}) }) as HTMLInputElement;

  const bindingInput = h("input", { "data-dp": "restore-flow.text.binding",
    class: "input",
    type: "text",
    placeholder: "KV_RESTORE_STAGING",
    autocomplete: "off",
    spellcheck: "false",
    ...(startRedirect ? { value: prefillBinding } : { disabled: true }),
    "aria-label": "Redirect target binding name",
  }) as HTMLInputElement;

  const original = h(
    "label",
    { class: "target-opt" },
    originalRadio,
    h("span", { class: "target-opt__top" }, svgIcon(ICON_DOWNPIPES, { size: 18 }), "Restore to original bindings"),
    h("span", { class: "target-opt__desc" }, "Each record returns to the source binding recovered from its manifest. Lower blast radius. The calm default."),
  );
  // G229 error: shown when a redirect is chosen with an empty binding, so the dry-run guard can block the
  // dangerous plan-against-original-bindings at the field rather than letting it proceed silently.
  const bindingError = h("span", {
    role: "alert",
    style: "display:none;color:var(--tone-danger-fg,#b3261e);font-size:var(--text-sm,0.85rem);margin-top:var(--space-1,4px)",
  });
  const redirect = h(
    "label",
    { class: "target-opt target-opt--danger" },
    redirectRadio,
    h("span", { class: "target-opt__top" }, svgIcon(ICON_ALERT, { size: 18 }), "Redirect the whole run to one binding"),
    h("span", { class: "target-opt__desc" }, "Every record is written to one binding. Broader and more dangerous; this triggers type-to-confirm."),
    h("div", { class: "target-opt__binding" }, bindingInput),
    bindingError,
  );

  const showBindingError = (msg: string | null): void => {
    if (msg) {
      bindingError.textContent = msg;
      bindingError.style.display = "";
      bindingInput.setAttribute("aria-invalid", "true");
    } else {
      bindingError.textContent = "";
      bindingError.style.display = "none";
      bindingInput.removeAttribute("aria-invalid");
    }
  };
  const sync = () => {
    bindingInput.disabled = !redirectRadio.checked;
    if (!redirectRadio.checked) bindingInput.value = "";
    showBindingError(null); // switching option clears a stale empty-binding error
    fire();
  };
  originalRadio.addEventListener("change", sync);
  redirectRadio.addEventListener("change", sync);
  bindingInput.addEventListener("input", () => {
    showBindingError(null); // typing a binding clears the empty-binding error
    fire();
  });

  const el = h(
    "div",
    { class: "field" },
    h("span", { class: "field__label", id: `${name}-label` }, "Target"),
    h("div", { class: "target-grid", role: "radiogroup", "aria-labelledby": `${name}-label` }, original, redirect),
    // Group-level doc link: the two radios and the redirect binding input are one blast-radius
    // control, so the link that explains a redirect lives on the group rather than on any single input.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/recovery/granular-and-targeted-restores#redirecting-a-restore-to-one-binding", target: "_blank", rel: "noreferrer noopener" },
      "About redirecting a restore",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );

  return {
    el,
    binding: () => (redirectRadio.checked ? bindingInput.value.trim() : ""),
    redirectChosen: () => redirectRadio.checked,
    setBindingError: showBindingError,
    onChange: (fn) => listeners.push(fn),
  };
}
