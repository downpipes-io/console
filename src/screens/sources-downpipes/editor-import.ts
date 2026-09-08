// Bulk list-import drawer for the Sources + downpipes screen, split out of ./editor.ts.
// See ./editor.ts for the barrel.

import type { Downpipe, EngineClient, StatusReport } from "../../api.ts";
import { dialogSurface, openOverlay } from "../../components/dialog.ts";
import { field } from "../../components/field.ts";
import { firstFailingLine } from "../../components/field-bounds.ts";
import { toast } from "../../components/toast.ts";
import { BINDING_NAME_PATTERN } from "../../lib/add-source.ts";
import { recordBulkOutcome } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { slugId } from "../sources/shared.ts";
import { openBulkSummary } from "./detail.ts";
import { destinationClarity, errMsg, friendlyName, isWorkersDevHost, sourceIcon } from "./helpers.ts";

type ImportType = "kv" | "r2" | "d1";

// buildTypeRadioGroup builds the shared source-type radiogroup (roving-tabindex, arrow-key navigable) and
// returns the field element plus a getter for the currently selected type. The selection lives inside this
// helper; openImport reads it through getType() at submit time.
function buildTypeRadioGroup(): { field: HTMLElement; getType: () => ImportType } {
  let importType: ImportType = "kv";
  const typeSeg = h("div", { class: "type-seg", role: "radiogroup", "aria-label": "Source type for all imported downpipes" });
  const typeButtons = new Map<ImportType, HTMLButtonElement>();
  const importTypeOptions: Array<{ type: ImportType; label: string }> = [
    { type: "kv", label: "KV" },
    { type: "r2", label: "R2" },
    { type: "d1", label: "D1" },
  ];
  const setImportType = (t: ImportType): void => {
    importType = t;
    for (const [type, b] of typeButtons) {
      const sel = type === t;
      b.setAttribute("aria-checked", sel ? "true" : "false");
      b.tabIndex = sel ? 0 : -1;
    }
  };
  for (const opt of importTypeOptions) {
    const checked = opt.type === importType;
    const btn = h(
      "button",
      { "data-dp": "sources-downpipes.radio.set-import-type", class: "type-seg__btn", type: "button", role: "radio", "aria-checked": checked ? "true" : "false", tabindex: checked ? "0" : "-1" },
      svgIcon(sourceIcon(opt.type), { size: 14 }),
      opt.label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => setImportType(opt.type));
    typeButtons.set(opt.type, btn);
    typeSeg.appendChild(btn);
  }
  // Roving-tabindex arrow-key handler for the import source-type radiogroup.
  typeSeg.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
    const order = importTypeOptions.map((o) => o.type);
    const idx = order.indexOf(importType);
    let next = idx;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (idx + 1) % order.length;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (idx - 1 + order.length) % order.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = order.length - 1;
    ev.preventDefault();
    setImportType(order[next]!);
    typeButtons.get(order[next]!)!.focus();
  });
  const typeField = h(
    "div",
    { class: "field" },
    h("span", { class: "field__label" }, "Source type (shared)"),
    typeSeg,
    // Group-level doc link (audit G2): the segmented radios are one control, so the link explaining
    // what each source type captures lives on the group rather than on any single button.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/overview#the-eight-source-types", target: "_blank", rel: "noreferrer noopener" },
      "About the source types",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  return { field: typeField, getType: () => importType };
}

// validateImportInput turns the pasted textarea into the deduped binding list, or an error string to show.
// It enforces: at least one binding, no workers.dev hosts (custom-domains-only), and no binding that already
// has a downpipe (a second downpipe per binding doubles the backups and the cost). On success it returns the
// unique bindings and the count of duplicate lines dropped.
// Exported for the validator (RG9). Both this and runImportLoop below decide what a bulk import actually
// creates, so they are worth driving directly rather than only through the drawer's DOM.
export function validateImportInput(raw: string, known: ReadonlySet<string>): { ok: true; unique: string[]; dupCount: number } | { ok: false; error: string } {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return { ok: false, error: "Enter at least one binding, one per line." };
  // Reject workers.dev hosts in the import list up front, per the
  // custom-domains-only rule. An operator pasting a URL instead of a binding name gets a clear error.
  const workersDev = lines.filter(isWorkersDevHost);
  if (workersDev.length > 0) {
    return { ok: false, error: `Enter binding names (e.g. KV_uploads), not workers.dev URLs. Remove: ${workersDev.slice(0, 3).join(", ")}${workersDev.length > 3 ? " and others" : ""}.` };
  }
  // Duplicates are mechanical: dedupe silently and note the drop in the summary.
  const unique = [...new Set(lines)];
  const dupCount = lines.length - unique.length;
  // Pre-flight against the loaded downpipe list: a binding that already has a downpipe would silently gain
  // a SECOND route (double backups, double cost), which the wizard's source step hard-disables likewise.
  const already = unique.filter((b) => known.has(b));
  if (already.length > 0) {
    return { ok: false, error: `Already a downpipe: ${already.join(", ")}. Remove ${already.length === 1 ? "it" : "them"}; a second downpipe per binding doubles the backups and the cost.` };
  }
  return { ok: true, unique, dupCount };
}

// ImportLoopResult is the running tally of runImportLoop: applied creates, creates queued for approval (when
// the change-control gate is on), per-binding failures, and whether the loop halted on an expired session.
export interface ImportLoopResult {
  done: number;
  queued: number;
  failures: Array<{ name: string; reason: string }>;
  halted: boolean;
}

// runImportLoop creates one downpipe per binding in order, classifying each result as applied / queued /
// failed and halting on an Access-session expiry (so a signed-out caller is not hammered).
// Exported for the validator (RG9), as above.
export async function runImportLoop(engine: EngineClient, unique: string[], importType: ImportType, cadence: number): Promise<ImportLoopResult> {
  const failures: Array<{ name: string; reason: string }> = [];
  let done = 0;
  let queued = 0; // changes the gate deferred for approval (counted distinctly from applied creates)
  let halted = false;
  for (const binding of unique) {
    const dp: Downpipe = {
      id: slugId(binding),
      // The shared human-name derivation (wizard + Sources bulk protect use the same), so an imported
      // fleet reads "uploads", never "KV_uploads"; the raw binding stays visible as the table's sub-line.
      name: friendlyName(binding),
      cadenceSeconds: cadence,
      enabled: true,
      source: { type: importType, binding, include: [], exclude: [] },
    };
    try {
      const res = await engine.addDownpipe(dp);
      if (res.status === "pending") queued++;
      else done++;
    } catch (err) {
      if (isUnauthorised(err)) {
        // A session expiry cut the import short. Counts only: how many of the
        // bindings never completed, and the class of the ending. The binding NAMES are operator labels and
        // never enter the ring.
        halted = true;
        recordBulkOutcome("create", "auth", unique.length - done - queued);
        break;
      }
      failures.push({ name: binding, reason: errMsg(err) });
    }
  }
  return { done, queued, failures, halted };
}

export function openImport(engine: EngineClient, status: StatusReport | null, known: ReadonlySet<string>, onDone: () => void): void {
  const typeGroup = buildTypeRadioGroup();
  const typeField = typeGroup.field;

  const listField = field({
    id: "import-list",
    label: "Bindings, one per line",
    kind: "textarea",
    hint: "One source binding name per line. Each starts with a letter or underscore (never a leading digit), then letters, digits or underscores, 1 to 64 characters. Empty and duplicate lines are dropped; a binding that already has a downpipe is refused.",
    placeholder: "KV_uploads\nKV_sessions\nKV_flags",
    // The shape of each line is checked at the field, and the OFFENDING LINE is named: a paste of
    // forty bindings with one typo used to be refused as a whole at submit, leaving the operator to
    // re-read their own list. The checks that need the loaded downpipe list (a binding that already
    // has a downpipe) stay at submit in validateImportInput, where that list is in hand.
    required: true,
    validate: firstFailingLine({
      lineRule: (line) => BINDING_NAME_PATTERN.test(line),
      describe: "a source binding name: 1 to 64 characters starting with a letter or underscore, then letters, digits or underscores.",
      remedy: "Correct that line, for example KV_uploads.",
    }),
    doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" },
  });
  listField.control.classList.add("import-list");

  const cadenceField = field({
    id: "import-cadence",
    label: "Schedule (shared)",
    kind: "select",
    value: "86400",
    options: [
      { value: "86400", label: "Daily (recommended)" },
      { value: "21600", label: "Every 6 hours" },
      { value: "3600", label: "Hourly" },
      { value: "604800", label: "Weekly" },
    ],
    hint: "Every imported downpipe shares this cadence. The engine dispatches on a ~15-minute tick, so a cadence is a floor, not an exact firing time.",
    doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "the-fifteen-minute-floor" },
  });

  const destField = h("div", { class: "field" }, h("span", { class: "field__label" }, "Destination"), destinationClarity(status));
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });

  const body = h("form", { class: "form-stack", "aria-label": "Import a list of downpipes", on: { submit: (ev: Event) => ev.preventDefault() } }, typeField, listField.el, cadenceField.el, destField, formError);

  const importBtn = h("button", { "data-busy-label": "Importing", "data-dp": "sources-downpipes.button.import", class: "btn btn--primary", type: "button" }, "Import") as HTMLButtonElement;
  const cancelBtn = h("button", { "data-dp": "sources-downpipes.button.cancel#1", class: "btn btn--secondary", type: "button" }, "Cancel") as HTMLButtonElement;
  const footer = h("div", { class: "dialog__actions" }, cancelBtn, importBtn);

  const { surface } = dialogSurface({ variant: "drawer", title: "Import a list of downpipes", body, footer, onCloseClick: () => handle.close() });
  // dismissable:false: a backdrop click or Esc must not silently discard a pasted list.
  // The explicit Cancel and the header X still close it.
  const handle = openOverlay({ surface, variant: "drawer", dismissable: false });
  cancelBtn.addEventListener("click", () => handle.close());

  importBtn.addEventListener("click", async () => {
    formError.hidden = true;
    // The box's firstFailingLine rule was blur-only, and this handler read listField.control.value (the raw
    // DOM value, bypassing the field's own trim) and never called validate(). validateImportInput re-checks
    // emptiness, workers.dev hosts and already-known bindings, but NOT the per-line binding pattern, and the
    // engine's binding check permits a LEADING DIGIT the console's does not. So a list pasted and submitted
    // without ever leaving the box created downpipes on binding names the field would have named line by
    // line. Running the field's own rule first means the operator gets the line number, not a row of engine
    // 400s.
    if (!listField.validate()) return;
    const parsed = validateImportInput(listField.value(), known);
    if (!parsed.ok) {
      formError.textContent = parsed.error;
      formError.hidden = false;
      return;
    }
    const { unique, dupCount } = parsed;
    const cadence = Number(cadenceField.value());

    importBtn.dataset.busy = "true";
    importBtn.textContent = "Importing";
    importBtn.disabled = true;
    cancelBtn.disabled = true;

    const { done, queued, failures, halted } = await runImportLoop(engine, unique, typeGroup.getType(), cadence);

    handle.close();
    onDone();

    if (halted) {
      toast({ message: `Stopped after ${done + queued} of ${unique.length} (your Access session expired).`, tone: "warn" });
      return goSignedOut();
    }
    // When the change-control gate is on, the creates were queued for approval rather than applied;
    // report that distinctly with a link to the inbox, so the operator is not told they were "created".
    const dupNote = dupCount > 0 ? ` (${dupCount} duplicate line${dupCount === 1 ? "" : "s"} ignored.)` : "";
    if (queued > 0 && failures.length === 0) {
      surfacePendingChange(queued === 1 ? "downpipe" : "set of downpipes");
    } else if (failures.length === 0) {
      toast({ message: `${done} downpipe${done === 1 ? "" : "s"} created.${dupNote}` });
    } else {
      const queuedNote = queued > 0 ? `, ${queued} queued for approval` : "";
      toast({ message: `${done} created${queuedNote}, ${failures.length} failed.`, tone: "warn" });
      openBulkSummary("create", "created", done, failures);
    }
  });
}
