// The server-side filter machinery for the audit log sub-view (console-access-2 +
// console-access-4): seed the AuditFilters from the route query, the debounced filter-bar
// control row that mutates them and reflects them to the URL, and the small predicate and
// reset helpers shared with the event renderer. Split out of audit.ts to keep that file
// under the structural cap. The filters are the SERVER-SIDE query the engine applies; this
// row never filters client-side.

import { h, svgIcon } from "../../lib/dom.ts";
import { field } from "../../components/field.ts";
import { titleCase } from "../../lib/format.ts";
import { ICON_CLOSE, ICON_EXTERNAL } from "../../lib/icons.ts";
import type { AuditAction, AuditOutcome, AuditFilters } from "../../api.ts";
import { ROUTE_AUDIT, AUDIT_PAGE_LIMIT } from "./shared.ts";
import { AUDIT_ACTION_GROUPS, AUDIT_ACTION_OPTIONS, AUDIT_OUTCOME_OPTIONS, actionLabel } from "./audit-display.ts";

// auditFilterBar is the SERVER-SIDE filter control row (console-access-4). A change to any
// control mutates the shared AuditFilters, reflects them to the URL (console-access-2),
// and re-fetches via load() so a search reaches the whole log, not just the loaded page.
// The free-text actor input is debounced so each keystroke does not fire a request.
export function auditFilterBar(filters: AuditFilters, load: () => void): HTMLElement {
  // align-items:START, not end. Every field here carries a one-line label and a
  // control of the same height, so top-aligning lines the five controls up exactly. END-aligning did
  // not: it lines up the field BOXES, and the Actor field is the only one of the five carrying a hint,
  // so bottom-aligning boxes of unequal height lifted its control by exactly the hint's height. The
  // it can be visibly out of line, by 26.6px at 1440 and 132.4px at 1280, on the
  // live product. Whatever sits BELOW a control may differ between
  // members; what must line up is the control itself.
  // TWO ROWS, NOT ONE GRID. The Clear action used to be a sixth item in the same
  // auto-fit grid as the five filter fields, so wherever that grid wrapped it landed BESIDE a control
  // instead of below the bar: it can be 28.14px out of line with the To field
  // at 870px. An action is not a field and does not belong in a track sized for one. The fields keep the
  // grid; the actions get their own row underneath it.
  const wrap = h("div", { class: "card card--inset", role: "search", "aria-label": "Filter the audit log" });
  const bar = h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--space-3);align-items:start" });
  wrap.appendChild(bar);

  // apply re-fetches AND reflects the current filters to the URL in one place, so the two
  // never drift; called by every control below (the text input via a debounce).
  const apply = (): void => {
    reflectAuditFiltersInUrl(filters);
    load();
  };

  // Actor: a debounced free-text input that drives the engine's `actor` param, so a search
  // for a person reaches beyond the first page (console-access-4). Debounced at 300ms.
  let actorTimer: number | undefined;
  const actorField = field({
    id: "audit-filter-actor",
    label: "Actor",
    value: filters.actor ?? "",
    placeholder: "ops@acme.example",
    // One short line. The row is top-aligned (see the bar above), so this hint no longer moves the Actor
    // control relative to its neighbours whatever length it is; it is kept short because a paragraph
    // here still makes the whole card taller than it needs to be. The doc link right below answers the
    // rest (exact-match scope, the no-email engine/shared-token cases).
    hint: "Exact email match, case-insensitive.",
    doc: { href: "https://docs.downpipes.io/assurance-audit/audit-log", anchor: "reading-the-trail" },
    autocomplete: "off",
    onInput: (v) => {
      const next = v.trim();
      if (next) filters.actor = next;
      else delete filters.actor;
      window.clearTimeout(actorTimer);
      actorTimer = window.setTimeout(apply, 300);
    },
  });
  bar.appendChild(actorField.el);

  // Action: the closed union as a GROUPED select ("any" clears it). Built directly because
  // the shared field() has no optgroup support; it mirrors the field markup so the label and
  // styling match the neighbouring controls.
  const actionSelect = h("select", { class: "select", id: "audit-filter-action" }) as HTMLSelectElement;
  actionSelect.appendChild(h("option", { value: "" }, "Any action"));
  for (const g of AUDIT_ACTION_GROUPS) {
    const og = h("optgroup", { label: g.group });
    for (const a of g.actions) og.appendChild(h("option", { value: a }, actionLabel(a)));
    actionSelect.appendChild(og);
  }
  actionSelect.value = filters.action ?? "";
  actionSelect.addEventListener("change", () => {
    const v = actionSelect.value;
    if (v) filters.action = v as AuditAction;
    else delete filters.action;
    apply();
  });
  // The action select is the one filter without a field() doc link (it is built raw for optgroup support),
  // so add the group-level link explicitly, to the section that lists the action families you can filter by.
  const actionDoc = h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/assurance-audit/audit-log#the-actions-you-can-filter-by", target: "_blank", rel: "noreferrer noopener" },
    "What the actions mean",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  );
  bar.appendChild(h("div", { class: "field" }, h("label", { class: "field__label", for: "audit-filter-action" }, "Action"), actionSelect, actionDoc));

  // Outcome: success / denied / failed; "any" clears it.
  const outcomeField = field({
    id: "audit-filter-outcome",
    label: "Outcome",
    kind: "select",
    value: filters.outcome ?? "",
    options: [{ value: "", label: "Any outcome" }, ...AUDIT_OUTCOME_OPTIONS.map((o) => ({ value: o, label: titleCase(o) }))],
    doc: { href: "https://docs.downpipes.io/assurance-audit/audit-log" },
  });
  outcomeField.control.addEventListener("change", () => {
    const v = outcomeField.value();
    if (v) filters.outcome = v as AuditOutcome;
    else delete filters.outcome;
    apply();
  });
  bar.appendChild(outcomeField.el);

  // From / to: a date range the engine applies server-side.
  const fromField = field({
    id: "audit-filter-from",
    label: "From",
    type: "date",
    value: filters.from ?? "",
    doc: { href: "https://docs.downpipes.io/assurance-audit/audit-log" },
  });
  fromField.control.addEventListener("change", () => {
    const v = fromField.value();
    if (v) filters.from = v;
    else delete filters.from;
    apply();
  });
  bar.appendChild(fromField.el);

  const toField = field({
    id: "audit-filter-to",
    label: "To",
    type: "date",
    value: filters.to ?? "",
    doc: { href: "https://docs.downpipes.io/assurance-audit/audit-log" },
  });
  toField.control.addEventListener("change", () => {
    const v = toField.value();
    if (v) filters.to = v;
    else delete filters.to;
    apply();
  });
  bar.appendChild(toField.el);

  // The downpipe filter has no input of its own (it arrives as a ?downpipe= deep link
  // from a downpipe surface). When it is active, surface it as a named chip with a clear
  // control, so the narrowed query is never invisible.
  const dpChipHost = h("div", { style: "display:flex;align-items:end" });
  const renderDpChip = (): void => {
    if (!filters.downpipe) {
      dpChipHost.replaceChildren();
      dpChipHost.hidden = true;
      return;
    }
    dpChipHost.hidden = false;
    const clearDp = h(
      "button",
      { "data-dp": "access-security.button.clear-dp", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Clear the downpipe filter ${filters.downpipe}` },
      svgIcon(ICON_CLOSE, { size: 14 }),
    ) as HTMLButtonElement;
    clearDp.addEventListener("click", () => {
      delete filters.downpipe;
      renderDpChip();
      apply();
    });
    dpChipHost.replaceChildren(
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, "Downpipe"),
        h(
          "div",
          { style: "display:flex;align-items:center;gap:var(--space-2)" },
          h("span", { class: "badge badge--accent mono" }, filters.downpipe),
          clearDp,
        ),
      ),
    );
  };
  renderDpChip();
  bar.appendChild(dpChipHost);

  // Clear: reset every filter, the inputs, the URL, and re-fetch the full trail.
  const clearBtn = h("button", { "data-dp": "access-security.button.clear", class: "btn btn--ghost btn--sm", type: "button" }, svgIcon(ICON_CLOSE, { size: 14 }), "Clear filters") as HTMLButtonElement;
  clearBtn.addEventListener("click", () => {
    clearAuditFilters(filters);
    (actorField.control as HTMLInputElement).value = "";
    actionSelect.value = "";
    (outcomeField.control as HTMLSelectElement).value = "";
    (fromField.control as HTMLInputElement).value = "";
    (toField.control as HTMLInputElement).value = "";
    window.clearTimeout(actorTimer);
    renderDpChip();
    apply();
  });
  wrap.appendChild(h("div", { style: "display:flex;align-items:center;gap:var(--space-2);margin-top:var(--space-3)" }, clearBtn));

  return wrap;
}

// ISO_DATE is the YYYY-MM-DD shape the date filter params must match before they are
// forwarded to the engine (console-src-023-05).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// auditFiltersFromQuery seeds the server-side filters from the route query so a filtered
// audit view is deep-linkable (console-access-2). limit is fixed at the page default; the
// before cursor is not a user filter and is omitted.
export function auditFiltersFromQuery(query: URLSearchParams): AuditFilters {
  const f: AuditFilters = { limit: AUDIT_PAGE_LIMIT };
  const actor = query.get("actor");
  if (actor) f.actor = actor;
  const action = query.get("action");
  if (action && (AUDIT_ACTION_OPTIONS as string[]).includes(action)) f.action = action as AuditAction;
  const downpipe = query.get("downpipe");
  if (downpipe) f.downpipe = downpipe;
  const outcome = query.get("outcome");
  if (outcome && (AUDIT_OUTCOME_OPTIONS as string[]).includes(outcome)) f.outcome = outcome as AuditOutcome;
  // from/to are validated for ISO date shape (YYYY-MM-DD) before use, consistent with the
  // allowlist checks above. The engine remains the authority; this only keeps a manipulated
  // URL from forwarding a malformed date and producing a confusing UI error state.
  const from = query.get("from");
  if (from && ISO_DATE.test(from)) f.from = from;
  const to = query.get("to");
  if (to && ISO_DATE.test(to)) f.to = to;
  return f;
}

// reflectAuditFiltersInUrl writes the active filters to the query string via replaceState
// (console-access-2), so the filtered view is shareable and survives a refresh without
// adding a history entry. The route base stays /access/audit.
export function reflectAuditFiltersInUrl(filters: AuditFilters): void {
  const qs = new URLSearchParams();
  if (filters.actor) qs.set("actor", filters.actor);
  if (filters.action) qs.set("action", filters.action);
  if (filters.downpipe) qs.set("downpipe", filters.downpipe);
  if (filters.outcome) qs.set("outcome", filters.outcome);
  if (filters.from) qs.set("from", filters.from);
  if (filters.to) qs.set("to", filters.to);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    history.replaceState({}, "", `${ROUTE_AUDIT}${suffix}`);
  } catch {
    // replaceState can throw in a sandbox/file:// context; the in-memory filters still
    // drive the load(), so the view is correct even if the URL cannot be updated.
  }
}

export function hasActiveAuditFilter(f: AuditFilters): boolean {
  return Boolean(f.actor || f.action || f.downpipe || f.outcome || f.from || f.to);
}

export function clearAuditFilters(f: AuditFilters): void {
  delete f.actor;
  delete f.action;
  delete f.downpipe;
  delete f.outcome;
  delete f.from;
  delete f.to;
}
