// Create / edit upsert editor for the Sources + downpipes screen (flow.md D), split out of
// ./editor.ts. The big cohesive sections (secrets repeater, cf-config surfaces,
// retention, destination picker) and the submit-path SourceSpec assembly were further split into
// sibling section modules. See ./editor.ts for the barrel.

import type { Downpipe, EngineClient, SourceSpec, StatusReport } from "../../api.ts";
import { dialogSurface, openOverlay } from "../../components/dialog.ts";
import { engineReason, errorDetail } from "../../components/error-view.ts";
import { field, validateForm } from "../../components/field.ts";
import { infoTip } from "../../components/info-tip.ts";
import { toast } from "../../components/toast.ts";
import { HEX_ID_PATTERN, RESOURCE_NAME_PATTERN, UUID_OR_HEX_ID_PATTERN, validateBindingName } from "../../lib/add-source.ts";
import { recordHandoffDropped } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, forbiddenClass, isUnauthorised } from "../../lib/errors.ts";
import { cadenceLabel, titleCase } from "../../lib/format.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { validateSchedule } from "../../lib/schedule.ts";
import { capGateReason } from "../common.ts";
import { slugId } from "../sources/shared.ts";
import { buildCfConfigSection } from "./editor-cf-config-section.ts";
import { buildDestinationSection } from "./editor-destination-section.ts";
import { buildRetentionSection } from "./editor-retention-section.ts";
import { buildScheduleSection } from "./editor-schedule.ts";
import { buildSchedulePresets } from "./editor-schedule-presets.ts";
import { buildSecretsSection } from "./editor-secrets-section.ts";
import { buildSourceSpec } from "./editor-source-spec.ts";
import type { EditorPrefill } from "./editor-types.ts";
import {
  isWorkersDevHost,
  type SourceType,
  sourceIcon,
  splitPrefixes,
  WORKERS_RESTORE_NOTE,
} from "./helpers.ts";

export function openEditor(
  engine: EngineClient,
  existing: Downpipe | null,
  status: StatusReport | null,
  onSaved: () => void,
  onClose: () => void,
  prefill?: EditorPrefill,
  // existingRev is the CONFIG REVISION the screen read `existing` at (DownpipeState.configRev), stated back
  // on the save as the engine's ifMatchRev precondition. It rides as its own argument rather than on
  // `existing` because `existing` is the customer's CONFIGURATION and this is a statement about the request.
  //
  // THIS IS THE EDITOR, so it is the path where the defect actually bit: the drawer's switch and the row
  // toggle each move one boolean, and this moves the name, the cadence, the source filter, the destination
  // list, the retention policy and the schedule at once, whole-object. Two operators who opened this drawer
  // on the same downpipe were BOTH told they had saved, and the one who saved first lost everything they
  // changed with nothing said. Absent (a create, or an engine older than the precondition) states nothing.
  existingRev?: number,
): void {
  const editing = existing !== null;

  // --- primary fields ---
  const nameField = field({ id: "dp-name", label: "Name", required: true, value: existing?.name ?? "", hint: "A human label for this backup route (1 to 256 characters); the downpipe id is derived from it.", placeholder: "User uploads", autocomplete: "off", validate: (v) => (v.length <= 256 ? null : "Use at most 256 characters."), doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "what-a-downpipe-is" } });

  // Source type: a segmented radiogroup (the wireframe's type-seg). Drives which
  // binding fields show, and whether the KV cost projection applies. A fresh editor honours
  // the add-source prefill (the store type the operator just wired); editing keeps the
  // existing type.
  let currentType: SourceType = existing?.source.type ?? prefill?.type ?? "kv";
  const typeSeg = h("div", { class: "type-seg", role: "radiogroup", "aria-label": "Source type" });
  const typeButtons = new Map<SourceType, HTMLButtonElement>();
  const typeHint = h("p", { class: "field__hint" });
  const typeOptions: Array<{ type: SourceType; label: string }> = [
    { type: "kv", label: "KV" },
    { type: "r2", label: "R2" },
    { type: "secrets", label: "Secrets" },
    { type: "d1", label: "D1" },
  ];
  for (const opt of typeOptions) {
    const checked = opt.type === currentType;
    const btn = h(
      "button",
      { "data-dp": "sources-downpipes.radio.set-type", class: "type-seg__btn", type: "button", role: "radio", "aria-checked": checked ? "true" : "false", tabindex: checked ? "0" : "-1" },
      svgIcon(sourceIcon(opt.type), { size: 14 }),
      opt.label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => setType(opt.type));
    typeButtons.set(opt.type, btn);
    typeSeg.appendChild(btn);
  }
  // Roving-tabindex arrow-key handler for the source-type radiogroup.
  typeSeg.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
    const order: SourceType[] = typeOptions.map((o) => o.type);
    const idx = order.indexOf(currentType);
    let next = idx;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (idx + 1) % order.length;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (idx - 1 + order.length) % order.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = order.length - 1;
    ev.preventDefault();
    setType(order[next]!);
    typeButtons.get(order[next]!)!.focus();
  });
  const typeField = h(
    "div",
    { class: "field" },
    h("span", { class: "field__label", id: "srctype-label" }, "Source type"),
    typeSeg,
    typeHint,
    // Group-level doc link (audit G2): the segmented radios are one control, so the link explaining
    // what each source type captures lives on the group rather than on any single button.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/overview#the-eight-source-types", target: "_blank", rel: "noreferrer noopener" },
      "About the source types",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );

  // A downpipe's source type is FIXED once created, editing it into a different store would silently
  // repoint the backup. So when editing we show the type READ-ONLY instead of the interactive segmented
  // control (the operator changes schedule / retention / destinations / surfaces, never the type).
  const typeWord = (t: SourceType): string =>
    t === "kv" ? "KV namespace" : t === "r2" ? "R2 bucket" : t === "d1" ? "D1 database" : t === "secrets" ? "Secrets Store" : t === "workers" ? "Workers scripts" : t === "stream" ? "Cloudflare Stream" : t === "images" ? "Cloudflare Images" : t === "artifacts" ? "Cloudflare Artifact Registry" : "Cloudflare configuration";
  const typeReadonly = h(
    "div",
    { class: "field" },
    h("span", { class: "field__label" }, "Source type"),
    h("div", { style: "padding:var(--space-1) 0; font-weight:600" }, typeWord(currentType)),
    h("p", { class: "field__hint", style: "margin:0" }, "Fixed for this backup. To back up a different source, create a new downpipe."),
  );

  // ── Cloudflare configuration (cf-config) source controls ──────────────────────────────────────
  const isCfConfig = currentType === "cf-config";
  const cf = buildCfConfigSection(engine, existing, prefill, isCfConfig);

  // ── Media content capture (stream / images / artifacts) ───────────────────────────────────────
  // These sources always capture the metadata inventory; includeContent opts INTO also capturing the
  // resource BYTES (video/image/repo blobs), size-gated. Off by default (bytes can multiply a run's size
  // and cost). The block shows only for the three media types (setType keeps it in sync on a type change).
  const isMedia = (t: SourceType): boolean => t === "stream" || t === "images" || t === "artifacts";
  let includeContent = existing?.source.includeContent ?? false;
  const contentCheckbox = h("input", { type: "checkbox", id: "dp-include-content", ...(includeContent ? { checked: true } : {}) }) as HTMLInputElement;
  contentCheckbox.addEventListener("change", () => { includeContent = contentCheckbox.checked; });
  const contentBlock = h(
    "div",
    { class: "field", hidden: !isMedia(currentType) },
    h("span", { class: "field__label" }, "File contents"),
    h("div", { class: "checkbox-row" }, contentCheckbox, h("label", { for: "dp-include-content" }, "Also back up the file contents, not just the inventory")),
    h("p", { class: "field__hint", style: "margin:0" }, "Off captures the inventory and metadata only. On also captures the file bytes (size-gated), which increases the backup size, the run time and the storage cost. Restore stays reprovision either way."),
    h("a", { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/overview#what-each-type-captures", target: "_blank", rel: "noreferrer noopener" }, "What each source type captures", svgIcon(ICON_EXTERNAL, { size: 13 })),
  );

  // ── Workers scripts source controls ───────────────────────────────────────────────────────────
  // The workers source, like cf-config, is authenticated by the read-only DISCOVERY token (not a
  // per-downpipe key, not a binding) and is account-scoped: it backs up Worker CODE, bindings
  // metadata and a version inventory for one account. The account identity is fixed for the
  // downpipe's life; it backs up every Worker in the account (the engine has no script-name filter).
  const isWorkers = currentType === "workers";
  const workersBlock = h(
    "div",
    { class: "field", hidden: !isWorkers },
    h("span", { class: "field__label" }, "Workers scripts to back up", infoTip(WORKERS_RESTORE_NOTE, { label: "About backing up and restoring Workers" })),
    h(
      "p",
      { class: "field__hint", style: "margin:0" },
      "Every Worker in this account: code, bindings metadata and a version inventory, read with your read-only discovery token, no per-downpipe key. Secret bindings are captured as a name-only reprovision checklist (no values). Restore is reprovision: you re-deploy the script, not a blind in-console write.",
    ),
  );

  // Binding (KV / R2 / D1). A fresh editor seeds the binding name from the add-source
  // prefill (the binding the operator just deployed), so they do not retype it; editing
  // keeps the existing binding.
  const bindingField = field({
    id: "dp-binding",
    label: "Source binding",
    value: existing?.source.binding ?? prefill?.binding ?? "",
    hint: "The engine binding name for this source, for example KV_uploads. Starts with a letter or underscore (never a leading digit), then letters, digits or underscores, 1 to 64 characters (no spaces, dots or dashes), case-sensitive. The engine refuses to back up its own reserved bindings.",
    placeholder: "KV_uploads",
    autocomplete: "off",
    doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" },
    // Enforce the engine's binding charset in the console too (the add-source flow already does; the editor
    // did not). Empty is allowed here because a by-id re-attach can carry the override ids without a binding.
    validate: (v) => (v === "" ? null : validateBindingName(v)),
  });
  bindingField.control.classList.add("mono");
  const bindingBlock = h("div", bindingField.el);

  // Secrets repeater (the previously-unreachable layer, G2): { name, binding } rows.
  const secrets = buildSecretsSection(existing, prefill, editing);

  // --- schedule picker + live cost (flow.md E) ---
  // The interval-preset picker, next-run preview and the live KV cost line are a self-contained
  // section that owns the cadence value; it reads the source type + record count back through
  // costInputs() to recompute the projection (the cost line only applies to KV).
  const presets = buildSchedulePresets(existing?.cadenceSeconds ?? 86400, () => ({ currentType, count: parseCount() }));

  // Advanced disclosure: include / exclude / approx record count (for the cost
  // projection only, never sent) / namespace or bucket override.
  const includeField = field({ id: "dp-include", label: "Include prefixes", value: (existing?.source.include ?? []).join(", "), hint: "Comma-separated key prefixes matched with startsWith (a literal prefix, not a glob; no wildcards, no slash is added). Empty means every key. Exclude wins over include.", placeholder: "uploads/, avatars/", doc: { href: "https://docs.downpipes.io/sources/selectors-and-scope", anchor: "the-one-matching-rule" } });
  const excludeField = field({ id: "dp-exclude", label: "Exclude prefixes", value: (existing?.source.exclude ?? []).join(", "), hint: "Comma-separated key prefixes removed from the set (a literal startsWith, not a glob). Exclude always wins over include.", placeholder: "uploads/tmp/", doc: { href: "https://docs.downpipes.io/sources/selectors-and-scope", anchor: "the-one-matching-rule" } });
  includeField.control.classList.add("mono");
  excludeField.control.classList.add("mono");
  const countField = field({
    id: "dp-count",
    label: "Approximate record count",
    type: "text",
    value: "",
    hint: "Used only to project the KV read cost above. Digits only (commas are ignored). Never sent to the engine.",
    placeholder: "3,000,000",
    onInput: () => presets.recalc(),
    doc: { href: "https://docs.downpipes.io/day-2/cost-prediction", anchor: "the-inline-read-amplification-guard" },
  });
  const nsField = field({ id: "dp-ns", label: "Namespace ID override", value: existing?.source.namespaceId ?? prefill?.namespaceId ?? "", hint: "Optional. The 32-character hex KV namespace id, only needed when you are not using the binding. Recording it lets a deploy-dropped binding be re-attached.", placeholder: "0f2ac7c1b6e0470a8f3d2c9b1e6a4d5f", doc: { href: "https://docs.downpipes.io/sources/binding-drift", anchor: "recording-an-identifier-override" }, validate: (v) => (v === "" || HEX_ID_PATTERN.test(v) ? null : "8 to 64 hexadecimal characters (0-9, a-f).") });
  const bucketField = field({ id: "dp-bucket", label: "Bucket name override", value: existing?.source.bucketName ?? prefill?.bucketName ?? "", hint: "Optional. The exact R2 bucket name, only needed when you are not using the binding. Recording it lets a deploy-dropped binding be re-attached.", placeholder: "app-uploads", doc: { href: "https://docs.downpipes.io/sources/binding-drift", anchor: "recording-an-identifier-override" }, validate: (v) => (v === "" || RESOURCE_NAME_PATTERN.test(v) ? null : "Starts with a letter or digit, then letters, digits, hyphens or underscores, up to 64 characters.") });
  // Database ID override (d1), the D1 sibling of the namespace/bucket overrides. Optional, but recording it
  // lets a roster re-attach rebuild this binding after a deploy dropped it (the engine otherwise reports the
  // d1 source as needing a re-save). Prefilled from the stored config when editing.
  const dbIdField = field({ id: "dp-dbid", label: "Database ID override", value: existing?.source.databaseId ?? prefill?.databaseId ?? "", hint: "Optional, only if not using the binding. The D1 database id (a UUID). Recording it lets a deploy-dropped binding be re-attached.", placeholder: "0f2ac7c1-b6e0-470a-8f3d-2c9b1e6a4d5f", doc: { href: "https://docs.downpipes.io/sources/binding-drift", anchor: "recording-an-identifier-override" }, validate: (v) => (v === "" || UUID_OR_HEX_ID_PATTERN.test(v) ? null : "A UUID, or 8 to 64 hexadecimal characters.") });
  nsField.control.classList.add("mono");
  bucketField.control.classList.add("mono");
  dbIdField.control.classList.add("mono");
  const nsBlock = h("div", nsField.el);
  const bucketBlock = h("div", bucketField.el);
  const dbIdBlock = h("div", dbIdField.el);

  // The scheduled restore-test cadence (build contract section 5). The select always
  // carries the stored value (a tuned cadence outside the presets gets its own
  // option), and submit always SENDS it: the engine re-defaults an omitted cadence
  // to weekly on every upsert, which silently reset tuned or opted-off drills
  // before this field existed (0 = off must be re-sent explicitly).
  const restoreTestOptions = [
    { value: "604800", label: "Weekly (recommended)" },
    { value: "86400", label: "Daily" },
    { value: "0", label: "Off (no scheduled test)" },
  ];
  const existingRestoreCadence = existing?.restoreTestCadenceSeconds;
  if (existingRestoreCadence !== undefined && !restoreTestOptions.some((o) => o.value === String(existingRestoreCadence))) {
    restoreTestOptions.unshift({ value: String(existingRestoreCadence), label: `${titleCase(cadenceLabel(existingRestoreCadence))} (current)` });
  }
  const restoreTestField = field({
    id: "dp-restore-test",
    label: "Restore test cadence",
    kind: "select",
    value: existingRestoreCadence !== undefined ? String(existingRestoreCadence) : "604800",
    options: restoreTestOptions,
    hint: "How often the engine drills the latest run to prove it restores. Off keeps backups running but stops the scheduled proof.",
    doc: { href: "https://docs.downpipes.io/recovery/prove-recoverability", anchor: "the-scheduled-restore-test" },
  });

  const advanced = h(
    "details",
    { class: "disclosure" },
    h("summary", "Advanced: prefixes, cost, restore test and overrides"),
    h("div", { class: "disclosure__body" }, includeField.el, excludeField.el, countField.el, restoreTestField.el, nsBlock, bucketBlock, dbIdBlock),
  );

  // --- retention policy (ASVS V14.2.7) ---
  const retentionSection = buildRetentionSection(existing);

  // --- Advanced schedule: cron / timezone / blackout windows (engine DownpipeConfig.schedule) ---
  // A collapsed-by-default disclosure (calm budget: the interval presets above stay the default
  // path). The operator opts in with a checkbox; ONLY then is a schedule object assembled and sent.
  // The whole section is built by a self-contained helper that captures its own DOM state and exposes
  // getDraft() (the raw UI capture) so the submit path and the validator can read the exact wire shape.
  const sched = buildScheduleSection(existing?.schedule);

  // --- destination clarity (flow.md D step 5) ---
  // The destination is ACCOUNT-WIDE (one archive for every downpipe), not per-downpipe, so the
  // edit form does not let you change it HERE; it states where backups go and links to the one
  // place it is managed. The picker chooses where THIS downpipe writes.
  const dest = buildDestinationSection(engine, existing, status, editing, () => handle.close());

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });

  // nsBlock and bucketBlock already live inside the advanced disclosure (above);
  // the form composes name, type, binding/secrets, schedule+cost, advanced, then
  // the destination clarity block and the inline form error.
  const formBody = h(
    "form",
    { class: "form-stack", "aria-label": editing ? "Edit downpipe" : "Create downpipe", on: { submit: (ev: Event) => ev.preventDefault() } },
    nameField.el,
    editing ? typeReadonly : typeField,
    bindingBlock,
    secrets.el,
    cf.el,
    workersBlock,
    contentBlock,
    presets.el,
    advanced,
    retentionSection.el,
    sched.el,
    dest.el,
    formError,
  );

  // --- behaviour wiring ---
  function setType(t: SourceType): void {
    currentType = t;
    for (const [type, btn] of typeButtons) {
      const sel = type === t;
      btn.setAttribute("aria-checked", sel ? "true" : "false");
      btn.tabIndex = sel ? 0 : -1;
    }
    const isSecrets = t === "secrets";
    const isCf = t === "cf-config";
    const isWk = t === "workers";
    // stream/images/artifacts capture an account-scoped inventory by source type, not a
    // named binding; the binding field is irrelevant and not read in the submit path, so
    // hide it for these the same way cf-config/workers/secrets do.
    bindingBlock.hidden = isSecrets || isCf || isWk || isMedia(t);
    secrets.el.hidden = !isSecrets;
    cf.el.hidden = !isCf;
    workersBlock.hidden = !isWk;
    contentBlock.hidden = !isMedia(t);
    // KV/R2 may use a namespace/bucket override respectively; D1/secrets/cf-config/workers none. Neither
    // cf-config nor workers has key prefixes or a record-count cost (they capture config surfaces / Worker
    // code + a version inventory, not keys/objects), so those controls hide for both.
    nsBlock.hidden = t !== "kv";
    bucketBlock.hidden = t !== "r2";
    // stream/images/artifacts capture a whole-account inventory by source type (like cf-config/workers),
    // not a key/object range: buildSourceSpec (editor-source-spec.ts) hardcodes include/exclude to []
    // for all three media types regardless of what is typed here. Without this guard the fields stayed
    // visible for media, so an operator could type a prefix, save, get no error and no effect -- a
    // silent-ignore-input bug (source-granularity audit finding 3). Hidden the same way cf-config/workers
    // are; a record-count cost projection is meaningless for media too (it has no per-run KV read cost).
    includeField.el.hidden = isCf || isWk || isMedia(t);
    excludeField.el.hidden = isCf || isWk || isMedia(t);
    countField.el.hidden = isCf || isWk || isMedia(t);
    typeHint.textContent =
      t === "kv"
        ? "Each run re-reads every key; the projection below sizes the cost."
        : t === "r2"
        ? "R2 objects are listed and copied to your archive. No KV-read cost applies."
        : t === "d1"
        ? "The D1 database is exported to your archive. No KV-read cost applies."
        : t === "cf-config"
        ? "Cloudflare configuration is read with your read-only discovery token. Choose which surfaces below."
        : t === "workers"
        ? "Worker code, bindings metadata and a version inventory, read with your read-only discovery token. Restore is reprovision (you re-deploy), not a blind write."
        : t === "stream"
        ? "Back up video inventory; content bytes optional."
        : t === "images"
        ? "Back up image inventory and variants; content bytes optional."
        : t === "artifacts"
        ? "Back up Artifact Registry namespace and repo inventory; content optional."
        : "Back up named secrets from your Secrets Store. Add one row per secret.";
    presets.recalc();
  }

  // The approximate record count (Advanced) feeds the KV cost projection only; it is never sent.
  function parseCount(): number {
    const n = parseInt(countField.value().replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }

  // Initialise visibility + the projection.
  setType(currentType);
  presets.recalc();

  // --- footer + submit ---
  const saveBtn = h("button", { "data-dp": "sources-downpipes.button.save", class: "btn btn--primary", type: "button" }, editing ? "Save changes" : "Create downpipe") as HTMLButtonElement;
  const cancelBtn = h("button", { "data-dp": "sources-downpipes.button.cancel#2", class: "btn btn--secondary", type: "button" }, "Cancel") as HTMLButtonElement;
  const footer = h("div", { class: "dialog__actions" }, cancelBtn, saveBtn);

  const { surface } = dialogSurface({
    variant: "modal",
    title: editing ? "Edit downpipe" : "Create downpipe",
    body: formBody,
    footer,
    onCloseClick: () => handle.close(),
  });
  // dismissable:false: a backdrop click or Esc must not silently discard a fully-typed
  // form. The explicit Cancel and the header X still close it. Centred modal (not a right-
  // side drawer) so the form reads as a solid panel in the middle of the page.
  const handle = openOverlay({ surface, variant: "modal", dismissable: false, onClose });

  // Focus the name on open (the overlay focuses the first focusable, the close X;
  // move it to the name field for a clean start).
  queueMicrotask(() => nameField.focus());

  cancelBtn.addEventListener("click", () => handle.close());

  // Cmd-Enter submits (flow.md D a11y note).
  formBody.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      void submit();
    }
  });
  saveBtn.addEventListener("click", () => void submit());

  // Validate every section and assemble the wire Downpipe, or surface an inline error next to the
  // offending field and return null (the caller must not save). It also returns the assembled
  // schedule so the save's error handler can route a late engine schedule rejection to the section.
  function assembleDownpipe(): { dp: Downpipe; schedule: Downpipe["schedule"] } | null {
    // THE SAVE USED TO VALIDATE THE NAME AND NOTHING ELSE. The three identifier overrides and both secret-row
    // boxes each carry their own pattern, and every one of them was blur-only: the value was read raw at
    // :439-441 and posted. The engine's own checks are LOOSER than all five (resId is
    // /^[A-Za-z0-9_-]{1,128}$/, engine/src/sched/config-validate.ts:365), so a namespace id with no hex in it,
    // a bucket name starting with a hyphen and a binding starting with a digit were all accepted and STORED
    // exactly as typed, under a field showing a red error. Driven: all three come back INTACT from the engine.
    // Only the override the current source type actually sends is validated, because the other two are
    // dropped by buildSourceSpec and refusing on a value that cannot leave the browser would block a save for
    // no reason.
    const activeOverride = currentType === "kv" ? [nsField] : currentType === "r2" ? [bucketField] : currentType === "d1" ? [dbIdField] : [];
    if (!validateForm([nameField, ...activeOverride, ...(currentType === "secrets" ? secrets.fields() : [])])) return null;

    // console-sources-2 elevation: reject workers.dev hosts up front before the engine
    // even sees the request. The console custom-domains-only rule means a binding that
    // looks like a workers.dev URL is almost certainly a misconfigured paste (the field
    // should hold a binding name like KV_uploads, not a URL). A clear inline error is
    // better than a late engine-side 400 with a cryptic message.
    const rawName = nameField.value().trim();
    if (isWorkersDevHost(rawName)) {
      // G335: a CONSOLE rule, not the engine's, so it records (refuse) rather than merely showing (setError).
      nameField.refuse("Names cannot be workers.dev URLs; use a plain label like User uploads.");
      nameField.focus();
      return null;
    }

    const include = splitPrefixes(includeField.value());
    const exclude = splitPrefixes(excludeField.value());

    // The account a token/media source backs up. When editing it is fixed on the existing downpipe;
    // on a CREATE reached from the "Add a source" / wizard hand-off it rides in on the prefill, so the
    // operator's earlier account/zone pick is not silently dropped here.
    const handoffAccountId = existing?.source.accountId ?? prefill?.accountId ?? null;
    // A token / media source the engine reads with the discovery token MUST name an account. Refuse a
    // save with none locally, with a clear inline reason, rather than letting the engine return a 400
    // the operator has no way to recover from in this editor.
    if (
      (currentType === "cf-config" || currentType === "workers" || currentType === "stream" || currentType === "images" || currentType === "artifacts") &&
      (currentType === "cf-config" ? cf.accountId : handoffAccountId) === null
    ) {
      // G310: the ADVANCED EDITOR refused the create locally, because an account-scoped source reached it with no
      // account. The console is right to refuse (an engine 400 the operator cannot recover from in this editor is
      // worse), and NO REQUEST IS MADE, which is the fact the class carries: there is nothing to find in any
      // engine log, so a support engineer must not be sent looking for one. The commonest way in is the designed
      // Add-a-source cf-config link (it names a type and no account) followed by the wizard's own "Use the
      // advanced editor" control, which is why this must not share a row with the wizard's accountless spec (that
      // one IS sent, and does leave a 400 behind).
      recordHandoffDropped("editor-refused-account-absent");
      formError.textContent = "This source needs a Cloudflare account. Start it from Add a source so the account is carried in, or pick it in the new-downpipe wizard.";
      formError.hidden = false;
      return null;
    }

    const built = buildSourceSpec({
      currentType,
      include,
      exclude,
      handoffAccountId,
      cfAccountId: cf.accountId,
      cfZoneId: cf.zoneId,
      cfMode: cf.getMode(),
      cfInclude: cf.getInclude(),
      includeContent,
      getSecrets: secrets.getSecrets,
      bindingValue: bindingField.value(),
      nsValue: nsField.value(),
      bucketValue: bucketField.value(),
      d1IdValue: dbIdField.value(),
    });
    if ("error" in built) {
      if (built.error === "secrets-empty") {
        formError.textContent = "Add at least one secret with a name and a binding.";
        formError.hidden = false;
        secrets.focusFirst();
      } else if (built.error === "binding-required") {
        // The binding box is EMPTY, so this is setError and not refuse (G335, R4): the console examined no value,
        // and a form-rejected row would say its validator turned the operator away from one. It is the
        // required-and-empty state, which the console records nowhere.
        bindingField.setError("A binding is required for this source type.");
        bindingField.focus();
      } else {
        bindingField.refuse("Enter a binding name (e.g. KV_uploads), not a workers.dev URL. Custom domains only.");
        bindingField.focus();
      }
      return null;
    }
    const source: SourceSpec = built.source;

    // Build the retention policy from the fields (the section owns the parse + validate + focus).
    const retentionResult = retentionSection.resolve();
    if (retentionResult.error) return null;
    const retentionPolicy = retentionResult.policy;

    // Assemble the optional cron / timezone / blackout schedule from the Advanced schedule section.
    // assembleSchedule returns undefined when the advanced path is OFF or carries nothing meaningful,
    // so a plain interval downpipe sends NO schedule object (back-compat: the cadenceSeconds path is
    // byte-unchanged). When a schedule IS produced, validate it against the engine's own rules
    // (validateSchedule mirrors validateConfig) so a malformed cron / unknown tz / bad window surfaces
    // as an inline reason here, the disclosure opened, rather than as a late 400.
    // G335: run the cron / timezone validators at submit, through the field funnel, so a malformed cron that the
    // operator never blurred out of is refused here (and recorded here) rather than reaching the engine.
    if (!sched.validateFields()) return null;
    const assembled = sched.assemble();
    if (assembled.error !== null) return null; // a half-filled window row; the row error is already shown
    const schedule = assembled.schedule;
    const scheduleErr = validateSchedule(schedule);
    if (scheduleErr !== null) {
      sched.showError(scheduleErr);
      return null;
    }

    const chosenEditDestIds = dest.getChosenIds();
    const dp: Downpipe = {
      id: existing?.id ?? slugId(rawName),
      name: rawName,
      cadenceSeconds: presets.getCadence(),
      enabled: existing?.enabled ?? true,
      source,
      // Always sent explicitly (0 = off): the engine re-defaults an OMITTED cadence
      // to weekly on every upsert, so omitting it here would silently reset a tuned
      // or opted-off restore-test cadence on any edit, even a rename.
      restoreTestCadenceSeconds: Number(restoreTestField.value()),
      ...(retentionPolicy !== undefined ? { retention: retentionPolicy } : {}),
      // The optional cron/timezone/blackout schedule. ABSENT (advanced off) = the cadenceSeconds path,
      // so the wire object is identical to a pre-schedule create/edit.
      ...(schedule !== undefined ? { schedule } : {}),
      // Pin the chosen destination; undefined = follow the default (so switching the picker to Default
      // clears any prior pin on the next upsert).
      ...(chosenEditDestIds.length > 0 ? { destinationIds: chosenEditDestIds } : {}),
    };
    return { dp, schedule };
  }

  async function submit(): Promise<void> {
    formError.hidden = true;
    const assembled = assembleDownpipe();
    if (assembled === null) return;
    const { dp, schedule } = assembled;

    saveBtn.dataset.busy = "true";
    saveBtn.textContent = editing ? "Saving" : "Creating";
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      // A CREATE states nothing rather than stating `null`. `null` is a falsifiable claim that no such
      // downpipe exists, and the id here is DERIVED FROM THE NAME (slugId), so two operators naming two
      // different sources the same thing would get an `already-exists` refusal that reads as a system fault
      // rather than the name clash it is. That is a separate defect with its own remedy (say the name is
      // taken, at the name field) and inventing a refusal for it here would be worse than the silence.
      const res = await engine.addDownpipe(dp, editing ? existingRev : undefined);
      handle.close();
      // The change-control gate may have QUEUED this save instead of applying it (a 202 -> pending
      // result): surface "queued for approval" with a link to the inbox, NOT a false "saved". onSaved()
      // still refreshes the list either way (a queued change leaves the existing config in place).
      if (res.status === "pending") surfacePendingChange("downpipe");
      else toast({ message: editing ? `Saved ${dp.name}` : `Downpipe ${dp.name} created` });
      onSaved();
    } catch (err) {
      saveBtn.dataset.busy = "false";
      saveBtn.textContent = editing ? "Save changes" : "Create downpipe";
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      if (isUnauthorised(err)) return goSignedOut();
      // A 403 is not a configuration problem, so it must not imply the configuration was at fault.
      // It is not automatically a ROLE denial either, which is what this branch used to assert:
      // driven, an OWNER creating their first downpipe against a 403 the transport had
      // already classified `not-engine-body` was told "your Owner role does not hold it. An Owner can
      // change this on the Access screen", while the same screen's New downpipe button was live. Only
      // the route gate's own refusal (forbiddenClass engine-capability) establishes that; the CSRF
      // check, the DO's authz funnel and an edge block page do not, and errorDetail now says what each
      // of them means. The capability sentence is added ONLY where it is true. A 400 from the DO is an
      // inline, expected outcome; the drawer stays open and populated, input never lost.
      const kind = classifyError(err);
      const roleDenial = kind.kind === "forbidden" && forbiddenClass(err) === "engine-capability";
      // The ENGINE'S OWN reason, or null when the throw carries none. Both branches below need the
      // null: "The engine refused the configuration (...)" is a wrapper, and wrapping the reviewed
      // sentence for a reasonless refusal nests one whole sentence inside another and gives the
      // customer two different instructions in one line ("Retry" inside "Adjust and try again").
      const reason = engineReason(err);
      // A schedule rejection (the engine's validateConfig message names "schedule" / "cron" /
      // "blackout" / "time zone") belongs AT the schedule section, with the disclosure opened, not in
      // the generic form error, so the operator sees the reason next to the fields that caused it.
      // Matched against the ENGINE'S words only: a reviewed console sentence is not a schedule verdict.
      if (kind.kind !== "forbidden" && schedule !== undefined && reason !== null && /schedule|cron|blackout|time zone|timezone/i.test(reason)) {
        sched.showError(reason);
        return;
      }
      formError.textContent = roleDenial
        ? `The engine refused this save at its role gate. ${capGateReason("downpipe.write")}`
        : reason === null
          ? errorDetail(err)
          : `The engine refused the configuration (${reason}). Adjust and try again.`;
      formError.hidden = false;
    }
  }
}
