// Shared leaf helpers for the Sources screen. The source-type glyphs, the human
// labels, the filterable/height-bounded/collapsible checkbox group, the one prominent
// source row, the bounded-poll constants, and the small string utilities every part of
// the screen reuses. Moved here verbatim from the screen module so the per-section
// render modules (the tiers, the add-source wizard, the account catalogue, the token
// forms) can share them without importing one another (which would form a cycle).
// Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { statusWithLabel } from "../../components/status.ts";
import { dataTable, type DataColumn } from "../../components/data-table.ts";
import { refusalText } from "../../components/error-view.ts";

// The source-type glyphs, duplicated as in-repo constants exactly like the
// Downpipes screen's (never server data, so svgIcon's innerHTML over them is safe).
export const ICON_KV = '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>';
export const ICON_R2 = '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>';
export const ICON_D1 = '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>';
export const ICON_SECRETS = '<circle cx="8" cy="8" r="4"/><path d="m11 11 8 8"/><path d="m16 16 3-3"/>';

export type PickType = "kv" | "r2" | "d1";

// ProtectType is a PickType plus Secrets Store: every BINDING-BACKED source kind the Sources tiers
// list, protect in bulk and re-attach. Secrets differ from the three stores in one way only, a
// selection of secrets bundles into ONE downpipe (named secrets read through their own bindings)
// rather than one downpipe per resource; the tier and wizard branch on that at create time.
export type ProtectType = PickType | "secrets";

export function pickIcon(type: ProtectType): string {
  return type === "kv" ? ICON_KV : type === "r2" ? ICON_R2 : type === "d1" ? ICON_D1 : ICON_SECRETS;
}

// A configured source whose backing binding the engine no longer exposes: the downpipe
// still points at it, but a deploy that did not carry the binding (or a deleted resource)
// has left it unbound, so the next run fails with "source binding error". Surfaced as an
// error row rather than silently dropped from the listing.
export interface MissingSource {
  binding: string;
  type: ProtectType;
  downpipes: string[];
}

// One filterable, height-bounded, collapsible checkbox group, so a product list of 100+
// items does not make the page a wall (owner feedback). A large group
// collapses to a one-line summary (count + how many are selected); expanding reveals a
// live filter box and a scroll area capped in height, and All/None act on the FILTERED
// visible set. onToggle keeps the caller's selection map in step; the summary's selected
// count tracks it live so a collapsed group still shows it has picks.
export interface SelListItem {
  value: string; // checkbox value / selection key
  label: string; // the mono display text (also what the filter matches)
  checked: boolean; // restored/initial state
  badge?: HTMLElement | null;
  // disabled renders the row visibly but non-selectable (e.g. a source already covered by a
  // downpipe in the create wizard); All/None skip it and its checked state never changes.
  disabled?: boolean;
}

const LIST_FILTER_AT = 8; // show a filter box above this many items
const LIST_SCROLL_AT = 10; // cap the list height (scroll within) above this many

// onToggle absent = a READ-ONLY list (the visibility-only non-engine accounts): the same
// filter / bounded scroll / collapse, but plain name rows with no checkboxes or All/None.
export function selectableSourceList(opts: {
  groupId: string;
  label: string;
  icon: string;
  items: SelListItem[];
  onToggle?: (value: string, checked: boolean) => void;
  // Force the group open. Default is CLOSED so a page of several groups is a tidy set
  // of one-line summaries on load (owner feedback: lists should not all be open). A
  // surface where the list IS the focus (the bulk-protect tier, the add-source wizard)
  // passes open:true.
  open?: boolean;
  // expose hands the caller a small control handle: clearAll unticks every enabled box WITHOUT
  // firing onToggle (the caller clears its own selection state alongside), used by the create
  // wizard's checkbox-vs-radio mutual exclusion.
  expose?: (handle: { clearAll: () => void }) => void;
}): HTMLElement {
  const { groupId, label, icon, items, onToggle } = opts;
  const interactive = onToggle !== undefined;
  const n = items.length;
  const rows: Array<{ box: HTMLInputElement | null; row: HTMLElement; match: string }> = [];

  const listEl = h("div", { class: n > LIST_SCROLL_AT ? "source-list source-list--scroll" : "source-list", role: interactive ? "group" : "list", "aria-label": `${label} bindings` });
  for (const item of items) {
    if (!interactive) {
      const row = h("div", { role: "listitem", class: "mono", style: "color:var(--text-muted)" }, item.label);
      rows.push({ box: null, row, match: item.label.toLowerCase() });
      listEl.appendChild(row);
      continue;
    }
    const id = `sel-${groupId}-${item.value.replace(/[^A-Za-z0-9]+/g, "-")}`;
    const box = h("input", { type: "checkbox", id, value: item.value, ...(item.disabled === true ? { disabled: true } : {}) }) as HTMLInputElement;
    // A direct property write, not h()'s attrs: checked is a live boolean the operator's own
    // click also flips (via box.checked below), so it is set the same way on both paths rather
    // than leaning on the content-attribute reflection h()'s checked:true would otherwise use.
    box.checked = item.checked;
    const row = h("div", { class: "checkbox-row" }, box, h("label", { for: id, class: "mono", ...(item.disabled === true ? { style: "color:var(--text-muted)" } : {}) }, item.label), item.badge ?? null);
    box.addEventListener("change", () => {
      onToggle!(item.value, box.checked);
      updateCounts();
    });
    rows.push({ box, row, match: item.label.toLowerCase() });
    listEl.appendChild(row);
  }

  const countLine = h("span", { class: "field__hint", style: "margin-left:auto" });
  const summarySel = h("span", { class: "field__hint" });
  const updateCounts = (): void => {
    const visible = rows.filter((r) => !r.row.hidden).length;
    const sel = rows.filter((r) => r.box?.checked).length;
    countLine.textContent = visible === n ? `${n} item${n === 1 ? "" : "s"}` : `showing ${visible} of ${n}`;
    summarySel.textContent = interactive && sel > 0 ? ` (${sel} selected)` : "";
  };

  const controls = buildListControls({ interactive, rows, countLine, updateCounts, onToggle });
  const filterHost = buildListFilter({ n, label, rows, updateCounts });

  if (opts.expose && interactive) {
    opts.expose({
      clearAll: () => {
        for (const r of rows) {
          if (r.box !== null && !r.box.disabled) r.box.checked = false;
        }
        updateCounts();
      },
    });
  }

  updateCounts();

  // EVERY product group renders with the same collapsible chrome (owner feedback: keep
  // R2, D1 and the rest consistent with namespaces), so the page is a tidy uniform set
  // of "<label> (N)" summaries. Groups start CLOSED so several do not all open at once
  // on load; a caller for whom the list is the focus passes open:true (the bulk-protect
  // tier, the add-source wizard). controls / filterHost / listEl each appear exactly once.
  return h(
    "details",
    { class: "disclosure source-list__details", ...(opts.open === true ? { open: true } : {}) },
    h(
      "summary",
      { class: "source-list__summary" },
      h("span", { style: "display:inline-flex;color:var(--text-muted);vertical-align:middle;margin-right:var(--space-1)", "aria-hidden": "true" }, svgIcon(icon, { size: 14 })),
      h("span", { class: "field__label" }, `${label} (${n})`),
      summarySel,
    ),
    h("div", { class: "disclosure__body stack-sm" }, filterHost, controls, listEl),
  );
}

// SelRow is the per-item row record selectableSourceList builds and shares with the control / filter
// helpers: the checkbox (null for a read-only list), its row element, and the lowercased filter-match text.
interface SelRow {
  box: HTMLInputElement | null;
  row: HTMLElement;
  match: string;
}

// buildListControls builds the All/None + count row. All/None act on the FILTERED visible rows only, so
// "All" never silently ticks bindings hidden by the current filter; a read-only list (no onToggle) gets the
// count line only, no All/None.
function buildListControls(opts: {
  interactive: boolean;
  rows: SelRow[];
  countLine: HTMLElement;
  updateCounts: () => void;
  onToggle: ((value: string, checked: boolean) => void) | undefined;
}): HTMLElement {
  const { interactive, rows, countLine, updateCounts, onToggle } = opts;
  if (!interactive) {
    return h("div", { style: "display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap" }, countLine);
  }
  const all = h("button", { "data-dp": "sources.button.all", class: "linklike", type: "button" }, "All");
  const none = h("button", { "data-dp": "sources.button.none", class: "linklike", type: "button" }, "None");
  const apply = (checked: boolean): void => {
    for (const r of rows) {
      if (r.row.hidden || r.box === null || r.box.disabled) continue;
      if (r.box.checked !== checked) {
        r.box.checked = checked;
        onToggle!(r.box.value, checked);
      }
    }
    updateCounts();
  };
  all.addEventListener("click", () => apply(true));
  none.addEventListener("click", () => apply(false));
  return h("div", { style: "display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap" }, all, none, countLine);
}

// buildListFilter builds the live filter box, but only when there are enough items to be worth it; below
// the threshold it returns an empty host. The filter narrows the visible rows live (the global [hidden]
// reset makes a hidden row genuinely vanish), then re-counts.
function buildListFilter(opts: { n: number; label: string; rows: SelRow[]; updateCounts: () => void }): HTMLElement {
  const { n, label, rows, updateCounts } = opts;
  const filterHost = h("div");
  if (n > LIST_FILTER_AT) {
    const filter = h("input", { "data-dp": "sources.search.filter", class: "input source-list__filter", type: "search", placeholder: `Filter ${n} ${label.toLowerCase()}…`, "aria-label": `Filter ${label}`, autocomplete: "off" }) as HTMLInputElement;
    filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) r.row.hidden = q !== "" && !r.match.includes(q);
      updateCounts();
    });
    filterHost.appendChild(filter);
  }
  return filterHost;
}

// errMsg is what a customer reads when the FIRST thing they are asked to do is refused: the
// read-only Cloudflare token on the connect-first card (token-entry.ts), the attach on the account
// catalogue and the manual add-source form, the re-attach on the drift tier. Nothing on this screen
// or any screen after it can populate until the token is accepted, so a refused token is a
// first-hour certainty rather than an edge case.
//
// refusalText is the console's own reviewed rule for exactly this (components/error-view.ts): the
// engine's sentence when the engine gave one, the reviewed sentence for the classified kind when it
// did not. THE CONSOLE'S OWN INTERNAL TOKENS MUST NEVER SURFACE; THE ENGINE'S OWN WORDS MAY. It is
// the same rule the destination form and the licence and update verbs go through, not a second copy
// of it, because a second nearly-identical helper is how this screen drifted from that one.
//
// The callers that WRAP this in their own line say "<what failed>. <why>" rather than
// "<what failed> (<why>)": the no-reason branch returns a whole reviewed sentence with its own
// advice, and a sentence nested in a parenthesis inside another sentence reads as two instructions
// in one line.
export function errMsg(err: unknown): string {
  return refusalText(err);
}

export function slugId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "downpipe";
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base}-${suffix}`;
}

// WAIT_POLL_MS / WAIT_POLL_MAX bound the wait-for-the-deploy poll (the same bounded
// discipline the onboarding configure step uses): after the operator generates the
// attach stanzas, the screen re-checks the bound list every few seconds until the
// chosen bindings appear, instead of leaving a manual Refresh as the only signal.
export const WAIT_POLL_MS = 5_000;
export const WAIT_POLL_MAX = 60; // five minutes of patience, then the manual path remains

// pickTypeLabel is the human noun for a source type (used by the prominent source rows
// and the add-source wizard's type picker).
export function pickTypeLabel(t: ProtectType): string {
  return t === "kv" ? "KV namespace" : t === "r2" ? "R2 bucket" : t === "d1" ? "D1 database" : "Secrets Store secret";
}

// sourceTypeBadge is the hue-coded type pill for a bound source (KV / R2 / D1 / Secrets), the glyph
// paired with the type word so the type reads by shape + label, never colour alone. Used by
// the Protected table and the drift table.
export function sourceTypeBadge(type: ProtectType): HTMLElement {
  return h("span", { class: `source-pill source-pill--${type}` }, svgIcon(pickIcon(type), { size: 13 }), type === "secrets" ? "Secrets" : type.toUpperCase());
}

// ProtectedSourceRow is one Protected-tier row: the binding, its type, and (when the
// caller has the coverage data) the downpipe(s) that cover it, so the table can link
// each binding straight to its downpipe instead of repeating a "Protected" label the
// section heading already carries.
export interface ProtectedSourceRow {
  name: string;
  type: ProtectType;
  coveredBy?: Array<{ id: string; name: string }>;
}

// protectedSourceTable renders the prominent "Protected" tier as a row table (matching the
// /downpipes layout): Binding · Type · Downpipe (the covering downpipe as a link, when the
// rows carry it; the column is dropped when no row does), each row activating Downpipes
// (where the downpipe that covers it lives). The binding and downpipe names are server
// strings, added via textContent. The table carries its own filter + sort, so a large
// covered fleet reads as an orderly table.
export function protectedSourceTable(protectedOnes: ProtectedSourceRow[]): HTMLElement {
  const columns: Array<DataColumn<ProtectedSourceRow>> = [
    {
      key: "binding",
      header: "Binding",
      sortable: true,
      sortValue: (b) => b.name,
      render: (b) => h("span", { class: "dp-name" }, h("span", { class: "linklike mono" }, b.name)),
    },
    {
      key: "type",
      header: "Type",
      sortable: true,
      sortValue: (b) => b.type,
      render: (b) => sourceTypeBadge(b.type),
    },
  ];
  // The covering-downpipe column only renders when the data is available on the rows
  // (a caller without it gets Binding + Type alone, never a column of blanks).
  if (protectedOnes.some((b) => (b.coveredBy ?? []).length > 0)) {
    columns.push({
      key: "downpipe",
      header: "Downpipe",
      sortable: true,
      sortValue: (b) => (b.coveredBy ?? []).map((c) => c.name).join(", "),
      render: (b) => {
        const covers = b.coveredBy ?? [];
        // A row the coverage data missed still reads honestly (it IS in this tier).
        if (covers.length === 0) return statusWithLabel("ok", "Protected");
        const cell = h("span", { style: "display:inline-flex;gap:var(--space-2);flex-wrap:wrap;align-items:baseline" });
        for (const c of covers) {
          cell.appendChild(
            h("button", { "data-dp": "sources.button.navigate", class: "linklike", type: "button", on: { click: () => navigate(`/downpipes/${encodeURIComponent(c.id)}`) } }, c.name),
          );
        }
        return cell;
      },
    });
  }
  return dataTable<ProtectedSourceRow>({
    label: "Protected sources",
    rows: protectedOnes,
    rowKey: (b) => `${b.type}:${b.name}`,
    onRowActivate: () => navigate("/downpipes"),
    columns,
    filter: { placeholder: "Filter by binding   ( / )", resultLabel: "sources", getText: (b) => `${b.name} ${b.type} ${pickTypeLabel(b.type)} ${(b.coveredBy ?? []).map((c) => c.name).join(" ")}` },
    initialSort: { key: "binding", dir: "asc" },
  }).el;
}

// PollHooks lets a section start/stop the screen-owned wait poll without owning the
// timer handle: the screen passes setWaitPoll (which replaces any running poll) and
// stopWaitPoll (cleared on navigation away and on each reload).
export interface PollHooks {
  setWaitPoll(id: number): void;
  stopWaitPoll(): void;
  // Late-binds the header's "+ Add a source" primary to the picker wizard once a token-present
  // catalogue render can supply the live discovery result (null again on each reload).
  setOpenAdd?(fn: (() => void) | null): void;
}
