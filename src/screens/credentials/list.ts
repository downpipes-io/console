// The list + detail surfaces of the credential lifecycle registry: the calm at-a-glance band (the "Needs
// attention" tier and the four-tile summary band are MUTUALLY EXCLUSIVE, never both, calm §7a), the shared
// dataTable (filter + facets + sort, most urgent first), and the deep-linkable detail drawer (status, kind,
// lifecycle, source, expiry, purpose, permissions, used-for, and the spent-token cleanup block). Edit / Remove
// and the cleanup attestation live in the drawer footer, gated by expiry.config (disabled-with-reason for a
// reader). Moved verbatim from the credentials coordinator for size; it imports the shared leaf (./helpers.ts)
// and the write flows (./forms.ts) one way, so it never forms a cycle.
//
// House rules: status by hue + shape + label, never colour alone (an expired item never reads green, a
// no-expiry item reads NEUTRAL); honest copy; Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { emptyState, postureStrip } from "../../components/feedback.ts";
import { dataTable } from "../../components/data-table.ts";
import { badge, statusWithLabel, type StatusTone } from "../../components/status.ts";
import { statTile, statGrid } from "../../components/stat-tiles.ts";
import { openDetailDrawer, drawerSection, kvRow } from "../../components/detail-drawer.ts";
import { absoluteTime, titleCase, relativeTime } from "../../lib/format.ts";
import { ICON_PLUS, ICON_TRASH, ICON_REFRESH, ICON_EXTERNAL } from "../../lib/icons.ts";
import type { EngineClient, ExpiryStatus } from "../../api.ts";
import {
  ROUTE_CREDENTIALS,
  CF_API_TOKENS_URL,
  expiryStateTone,
  expiryStateLabel,
  stateOrder,
  remainingSortValue,
  expirySummary,
  soonestRow,
  daysPhrase,
  soonestTileValue,
  lifecycleLabel,
  needsAttention,
  isPendingCleanup,
  lifecycleChip,
  usageLinkLabel,
  usageLinkSurfaceLabel,
  usageContextLink,
  callerCanCap,
  gateReason,
  readOnlyNote,
} from "./helpers.ts";
import { openItemForm, openCleanupAttest, removeItem } from "./forms.ts";
import { refuseWithReason } from "../common.ts";

// Above this many attention rows the list becomes a scroll region rather than growing the page.
const ATTENTION_SCROLL_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// The list render. Calm §7a: ONE at-a-glance band. The "Needs attention" tier and the
// four-tile summary band are MUTUALLY EXCLUSIVE, when N>0 the tier + ONE quiet posture
// strip lead (never the four tiles too); when N==0 the four tiles lead (no tier). Then
// the shared dataTable (filter + facets + sort), most urgent first.
// ---------------------------------------------------------------------------

export function renderList(engine: EngineClient, rows: ExpiryStatus[], reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-5)" });
  const writeGate = callerCanCap("expiry.config");

  // The hoisted "needs attention" set: spent ephemeral tokens awaiting cleanup, plus
  // expired functional items that something depends on (a usage link). A merely-
  // approaching item is NOT hoisted (it lives in the table + the approaching alert).
  const attention = rows.filter(needsAttention);

  // The at-a-glance band, chosen by the attention count (never both, calm §7a):
  //   - attention > 0: the tier leads + ONE quiet posture line (NOT the four tiles).
  //   - attention == 0: the four-tile summary band leads (no tier).
  // Both gate on rows.length so an empty list leads with the teaching empty state.
  if (rows.length > 0) {
    if (attention.length > 0) {
      wrap.appendChild(attentionTier(engine, attention, writeGate ? "edit" : "readonly", reload));
      wrap.appendChild(posturePlace(rows));
    } else {
      wrap.appendChild(summaryBand(rows));
    }
  }

  const section = buildHeader(engine, rows, writeGate, reload);

  if (rows.length === 0) {
    section.appendChild(emptyTracked(engine, writeGate, reload));
    wrap.appendChild(section);
    return wrap;
  }

  section.appendChild(buildItemsTable(rows));
  wrap.appendChild(section);
  return wrap;
}

// buildHeader builds the labelled list section with its head row: the count lead, the gated Add
// control, and a refresh; a read-only note is appended for a caller without expiry.config.
function buildHeader(engine: EngineClient, rows: ExpiryStatus[], writeGate: boolean, reload: () => void): HTMLElement {
  const head = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  lead.appendChild(h("h2", { id: "expiry-h", style: "font-size:var(--text-lg)" }, "Tracked items"));
  lead.appendChild(h("p", { class: "field__hint measure" }, `${rows.length} ${rows.length === 1 ? "item" : "items"}. Approaching means 30 days or fewer remaining; the engine alerts at the 60, 30, 14, 7 and 1 day transitions. Activate a row for its detail and actions.`));
  head.appendChild(lead);

  const controls = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  const addBtn = (writeGate
    ? h("button", { "data-dp": "credentials.button.add#1", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Track an item")
    : h("button", { "data-dp": "credentials.button.add#2", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Track an item")) as HTMLButtonElement;
  if (writeGate) addBtn.addEventListener("click", () => openItemForm(engine, null, reload));
  else refuseWithReason(addBtn, gateReason());
  controls.appendChild(addBtn);
  const refreshBtn = h("button", { "data-dp": "credentials.button.refresh", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Refresh") as HTMLButtonElement;
  refreshBtn.addEventListener("click", reload);
  controls.appendChild(refreshBtn);
  head.appendChild(controls);

  const section = h("section", { class: "stack", style: "display:grid;gap:var(--space-4)", "aria-labelledby": "expiry-h" }, head);
  if (!writeGate) section.appendChild(readOnlyNote());
  return section;
}

// emptyTracked is the teaching empty state when nothing is tracked yet; the add action is offered
// only to a caller that can write.
function emptyTracked(engine: EngineClient, writeGate: boolean, reload: () => void): HTMLElement {
  return emptyState({
    title: "Nothing tracked yet",
    ...(writeGate
      ? {
          body: "Add the first item your recovery depends on; the engine watches the date from then on. Auto-observed credentials (a destination access key, a SAML signing certificate) appear here on their own.",
          action: { label: "Track the first item", onClick: () => openItemForm(engine, null, reload), variant: "primary" as const },
        }
      : {}),
  });
}

// buildItemsTable is the shared dataTable (the sibling list screens' idiom). The row is COMPACT:
// Status · Item · Lifecycle · Kind · Remaining (the per-row Actions column is gone, Edit / Remove
// live in the drawer footer, a calm trade-off). onRowActivate opens the detail drawer via the
// deep-link route so a refresh restores it. Facets cap at THREE (calm): expired, approaching, needs
// cleanup; "no expiry" is filter-TEXT only, not a permanent chip. The initial sort is days-remaining
// ascending = the urgency order (expired leads, then approaching, then healthy, then no-expiry last).
function buildItemsTable(rows: ExpiryStatus[]): HTMLElement {
  const handle = dataTable<ExpiryStatus>({
    label: "Tracked credential lifecycle items",
    rows,
    rowKey: (r) => r.id,
    onRowActivate: (r) => navigate(`${ROUTE_CREDENTIALS}/${encodeURIComponent(r.id)}${location.search}`),
    filter: {
      placeholder: "Filter by label, kind, lifecycle or purpose",
      resultLabel: "items",
      getText: (r) => `${r.label} ${r.kind} ${lifecycleLabel(r.lifecycleClass)} ${r.purpose ?? ""} ${expiryStateLabel(r.state)}`,
    },
    facets: [
      // State is one dimension (a credential is exactly one of expired/approaching): selecting both shows
      // expired-or-approaching, never AND to empty. Needs-cleanup is orthogonal, so it keeps narrowing.
      { id: "expired", group: "state", label: "expired", tone: "danger", predicate: (r) => r.state === "expired" },
      { id: "approaching", group: "state", label: "approaching", tone: "warn", predicate: (r) => r.state === "approaching" },
      { id: "needs-cleanup", label: "needs cleanup", tone: "warn", predicate: (r) => isPendingCleanup(r) },
    ],
    initialSort: { key: "remaining", dir: "asc" },
    columns: [
      { key: "state", header: "Status", sortable: true, sortValue: (r) => stateOrder(r.state), render: (r) => statusWithLabel(expiryStateTone(r.state), expiryStateLabel(r.state)) },
      { key: "label", header: "Item", sortable: true, sortValue: (r) => r.label, render: (r) => h("b", r.label) },
      { key: "lifecycle", header: "Lifecycle", sortable: true, sortValue: (r) => lifecycleLabel(r.lifecycleClass), render: (r) => lifecycleChip(r.lifecycleClass) },
      { key: "kind", header: "Kind", sortable: true, sortValue: (r) => r.kind, render: (r) => badge("default", titleCase(r.kind)) },
      {
        key: "remaining",
        header: "Remaining",
        sortable: true,
        sortValue: (r) => remainingSortValue(r),
        render: (r) => h("span", { class: "field__hint", ...(r.expiresAt ? { title: absoluteTime(r.expiresAt) } : {}) }, daysPhrase(r)),
      },
    ],
  });
  return handle.el;
}

// ---------------------------------------------------------------------------
// The "Needs attention" tier (shape copied from sources.ts driftTier/driftRow): a plain
// <section> (NOT a tinted banner, calm §7a), an h3 with the (N) count, a one-line
// intro, then a warn/danger badge + a subline + a single action button per row.
// ---------------------------------------------------------------------------

// WriteMode replaces the old boolean flag on the attention renderers (calm §6: no boolean
// parameters): "edit" enables the write action, "readonly" disables it with the gate reason.
type WriteMode = "edit" | "readonly";

function attentionTier(engine: EngineClient, items: ExpiryStatus[], mode: WriteMode, reload: () => void): HTMLElement {
  const sec = h("section");
  sec.appendChild(h("h3", { class: "section-title" }, `Needs attention (${items.length})`));
  sec.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:0" },
      items.length === 1
        ? "One item needs you: either a spent one-shot token to delete in Cloudflare, or an expired credential something depends on. Clear it to keep your protection honest."
        : "These items need you: a spent one-shot token to delete in Cloudflare, or an expired credential something depends on. Clear each to keep your protection honest.",
    ),
  );
  const list = h("div", { class: items.length > ATTENTION_SCROLL_THRESHOLD ? "source-list source-list--scroll" : "stack-sm" });
  for (const it of items) {
    list.appendChild(isPendingCleanup(it) ? renderPendingCleanupRow(engine, it, mode, reload) : renderExpiredFunctionalRow(it));
  }
  sec.appendChild(list);
  return sec;
}

// attentionRowFrame wraps one hoisted row in the shared two-column grid: the label + subline on
// the left (main), the badge + action(s) on the right.
function attentionRowFrame(main: HTMLElement, badgeEl: HTMLElement, action: HTMLElement, secondary: HTMLElement | null): HTMLElement {
  const right = h("div", { style: "display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;justify-content:flex-end" }, badgeEl, action);
  if (secondary) right.appendChild(secondary);
  return h(
    "div",
    { style: "display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--space-2) var(--space-3);padding:var(--space-2) 0;border-bottom:1px solid var(--border-subtle)" },
    main,
    right,
  );
}

// renderPendingCleanupRow is the hoisted row for a spent EPHEMERAL token awaiting cleanup
// (cleanupState "pending"): a warn "pending cleanup" badge; a subline naming when it was used to
// attach what + the tokenRef in mono (or the honest "user-owned, id not captured" line when
// absent); the action "I have deleted it" -> the cleanup attestation modal, plus a secondary
// deep-link to the Cloudflare API Tokens dashboard.
// Exported for the validator (RG15): the read-only gate here is what stands between a viewer and an
// attestation record, and the guarantee is that no listener is attached at all, not merely that the
// button renders disabled.
export function renderPendingCleanupRow(engine: EngineClient, row: ExpiryStatus, mode: WriteMode, reload: () => void): HTMLElement {
  const main = h("span", { style: "min-width:0" });
  main.appendChild(h("span", { class: "mono", style: "overflow-wrap:anywhere" }, row.label));

  // The subline: "Spent attach token, used <relative> to attach <purpose>; delete it in
  // Cloudflare" + the tokenRef in mono (or the honest user-owned line). Every server string
  // (purpose, tokenRef) is a text node.
  const sub = h("span", { class: "field__hint", style: "display:block" });
  const usedWhen = row.usedAt ? relativeTime(row.usedAt) : "earlier";
  const attachWhat = row.purpose && row.purpose.trim() !== "" ? row.purpose : "a resource";
  sub.appendChild(h("span", `Spent attach token, used ${usedWhen} to attach `));
  sub.appendChild(h("span", attachWhat));
  sub.appendChild(h("span", "; delete it in Cloudflare."));
  if (row.tokenRef && row.tokenRef.trim() !== "") {
    sub.appendChild(h("span", { style: "display:block" }, "Token id: ", h("span", { class: "mono" }, row.tokenRef)));
  } else {
    sub.appendChild(
      h("span", { style: "display:block" }, "(User-owned token; Downpipes could not capture its id, find it by creation time / permissions in Cloudflare.)"),
    );
  }
  main.appendChild(sub);

  const writeGate = mode === "edit";
  const del = (writeGate
    ? h("button", { "data-dp": "credentials.button.del#1", class: "btn btn--secondary btn--sm", type: "button" }, "I have deleted it")
    : h("button", { "data-dp": "credentials.button.del#2", class: "btn btn--secondary btn--sm", type: "button" }, "I have deleted it")) as HTMLButtonElement;
  if (writeGate) del.addEventListener("click", () => openCleanupAttest(engine, row, reload));
  else refuseWithReason(del, gateReason());
  // The secondary deep-link to the CF dashboard (a constant URL, safe as an href).
  const secondary = h(
    "a",
    { class: "linklike", href: CF_API_TOKENS_URL, target: "_blank", rel: "noopener noreferrer", style: "display:inline-flex;align-items:center;gap:var(--space-1)" },
    "Open Cloudflare API Tokens",
    svgIcon(ICON_EXTERNAL, { size: 12 }),
  );
  return attentionRowFrame(main, badge("warn", "pending cleanup"), del, secondary);
}

// renderExpiredFunctionalRow is the hoisted row for an EXPIRED FUNCTIONAL item with a usage link: a
// danger badge + the days phrase; a "Used by: ..." subline from the usage link; a context link to
// that surface (built from the CLOSED usageLink.kind, never the raw refId).
function renderExpiredFunctionalRow(row: ExpiryStatus): HTMLElement {
  const main = h("span", { style: "min-width:0" });
  main.appendChild(h("span", { class: "mono", style: "overflow-wrap:anywhere" }, row.label));
  const sub = h("span", { class: "field__hint", style: "display:block" });
  sub.appendChild(h("span", `${daysPhrase(row)}, used by `));
  sub.appendChild(h("span", usageLinkLabel(row.usageLink)));
  sub.appendChild(h("span", `; rotate or renew, then update it here.`));
  main.appendChild(sub);
  const action = usageContextLink(row.usageLink, `Open ${usageLinkSurfaceLabel(row.usageLink)}`);
  return attentionRowFrame(main, badge("danger", "expired"), action, null);
}

// posturePlace is the SINGLE quiet posture line that pairs with the tier (replacing the
// four-tile band, calm §7a, never both). A few dot + phrase items: expired / approaching
// / needs cleanup, each honest (no green for a problem state). The neutral "all clear"
// items keep the read truthful when a category is empty.
function posturePlace(rows: ExpiryStatus[]): HTMLElement {
  const s = expirySummary(rows);
  const cleanup = rows.filter(isPendingCleanup).length;
  const items: Array<{ tone: StatusTone; label: string }> = [
    s.expired > 0 ? { tone: "danger", label: `${s.expired} expired` } : { tone: "neutral", label: "none expired" },
    s.approaching > 0 ? { tone: "warn", label: `${s.approaching} approaching` } : { tone: "neutral", label: "none approaching" },
    cleanup > 0 ? { tone: "warn", label: `${cleanup} to clean up` } : { tone: "neutral", label: "no cleanup pending" },
  ];
  return postureStrip(items, { label: "Credential posture" });
}

// summaryBand is the top-of-screen read WHEN NOTHING NEEDS ATTENTION: the total tracked,
// the count expired, the count approaching, and the soonest deadline. Honest tones: an
// expired item reads danger, an approaching one warn; an all-healthy list reads ok. Never
// a stale green. (When something needs attention, posturePlace replaces this, never both.)
function summaryBand(rows: ExpiryStatus[]): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "expiry-summary-h", style: "display:grid;gap:var(--space-4)" });
  card.appendChild(h("div", { class: "card__header" }, h("h2", { class: "card__title", id: "expiry-summary-h" }, "Expiry summary")));

  const s = expirySummary(rows);
  const soonest = soonestRow(rows);

  card.appendChild(
    statGrid(
      statTile({
        label: "Tracked",
        value: String(s.total),
        secondary: s.total === 0 ? "Nothing tracked yet." : "Credentials, keys, licences, certificates and tokens.",
      }),
      statTile({
        label: "Expired",
        value: String(s.expired),
        status: s.expired > 0 ? { tone: "danger", label: "action needed" } : { tone: "ok", label: "none" },
        secondary: s.expired > 0 ? "Past the recorded date; rotate or renew now." : "No item has passed its date.",
      }),
      statTile({
        label: "Approaching",
        value: String(s.approaching),
        status: s.approaching > 0 ? { tone: "warn", label: "30 days or fewer" } : { tone: "ok", label: "clear" },
        secondary: s.approaching > 0 ? "Plan the rotation before the deadline." : "No item is within 30 days.",
      }),
      statTile({
        label: "Soonest deadline",
        value: soonest ? soonestTileValue(soonest) : "-",
        status: soonest ? { tone: expiryStateTone(soonest.state), label: expiryStateLabel(soonest.state) } : { tone: "neutral", label: "none" },
        secondary: soonest ? soonest.label : "No items tracked.",
        ...(soonest?.expiresAt ? { title: absoluteTime(soonest.expiresAt) } : {}),
      }),
    ),
  );
  return card;
}

// ---------------------------------------------------------------------------
// The detail drawer (deep-linkable via the /credentials/:id route). Shows status + days,
// kind, lifecycle, source, expiry, purpose, permission summary, used-for, and, for a
// spent ephemeral row, the token id + used-at + the cleanup action in the footer.
// Edit / Remove live in the footer (gated by expiry.config, disabled-with-reason for a
// reader). Every server string is added via textContent (kvRow / h()); a used-for link
// is built from the CLOSED usageLink.kind, never the raw refId.
// ---------------------------------------------------------------------------

type DrawerActions = NonNullable<Parameters<typeof openDetailDrawer>[0]["actions"]>;

export function openItemDrawer(engine: EngineClient, row: ExpiryStatus, reload: () => void): void {
  const writeGate = callerCanCap("expiry.config");
  const observed = row.source === "observed";
  const pending = isPendingCleanup(row);

  const body = h("div");
  body.appendChild(drawerSection("Lifecycle", ...buildDetailRows(row, observed)));
  if (pending) body.appendChild(buildCleanupBlock(row));

  const badges: Node[] = [
    badge(expiryStateTone(row.state), expiryStateLabel(row.state)),
    lifecycleChip(row.lifecycleClass),
  ];
  if (observed) badges.push(badge("info", "auto-observed"));

  // No meta line: the bare mono kind token floated under the title with no label, and the
  // kind is stated as a labelled row in the body instead.
  const handle = openDetailDrawer({
    title: row.label,
    badges,
    body,
    // Keyed by the credential's id: this drawer is opened from the deep-linkable
    // /credentials/:id route (onRowActivate -> navigate below), so a screen re-render that
    // re-fires that deep link's openItemDrawer side effect (app.ts's identity-resolved quiet
    // re-render, which runs a fresh load() outside the router, so closeAllOverlays never
    // fires for it) hits openOverlay's idempotency guard instead of stacking a second drawer
    // over the first (the same fix sources-downpipes/detail.ts already carries).
    key: `credentials-detail:${row.id}`,
    // Return to the list WITH the query string the row carried in, so the operator's
    // filter / facets / sort survive the open-and-close round trip.
    onClose: () => navigate(`${ROUTE_CREDENTIALS}${location.search}`),
    actions: buildFooterActions(engine, row, writeGate, pending, reload, () => handle.close()),
  });
}

// buildDetailRows is the Lifecycle section: the facts the header does NOT already carry. The
// header chips state the status and the lifecycle class (and auto-observed), so the rows hold
// kind, source, the expiry date with its remaining-days read, and (when present) purpose,
// permission summary and the used-for link. Every server string is added via textContent
// (kvRow / h()); the used-for link is built from the CLOSED usageLink.kind, never the raw refId.
function buildDetailRows(row: ExpiryStatus, observed: boolean): HTMLElement[] {
  // Expiry: the absolute date plus the relative days read (the header chip carries only the
  // state word). A no-expiry item reads the honest "not set" line, never a fabricated date.
  const expiryRow = kvRow(
    "Expiry",
    row.expiresAt
      ? h(
          "span",
          { style: "display:inline-flex;align-items:baseline;gap:var(--space-2);flex-wrap:wrap" },
          absoluteTime(row.expiresAt),
          h("span", { class: "field__hint" }, daysPhrase(row)),
        )
      : "Not set, this credential does not expire by default; rotate on policy.",
  );

  const detailRows: HTMLElement[] = [
    kvRow("Kind", badge("default", titleCase(row.kind))),
    kvRow("Source", observed ? `Auto-observed ${row.observedAt ? relativeTime(row.observedAt) : ""}`.trim() : "Tracked by hand"),
    expiryRow,
  ];

  if (row.purpose && row.purpose.trim() !== "") detailRows.push(kvRow("Purpose", row.purpose));
  if (row.permissionSummary && row.permissionSummary.trim() !== "") {
    detailRows.push(kvRow("Permissions", h("span", { class: "field__hint" }, row.permissionSummary)));
  }
  if (row.usageLink) {
    detailRows.push(kvRow("Used for", usageContextLink(row.usageLink, usageLinkLabel(row.usageLink))));
  }
  return detailRows;
}

// buildCleanupBlock is the section for a spent ephemeral row: the token id + used-at + the honest
// "Downpipes never held this token" note. The ACTION is in the footer.
function buildCleanupBlock(row: ExpiryStatus): HTMLElement {
  const cleanupRows: HTMLElement[] = [];
  if (row.tokenRef && row.tokenRef.trim() !== "") cleanupRows.push(kvRow("Token id", h("span", { class: "mono" }, row.tokenRef)));
  else cleanupRows.push(kvRow("Token id", h("span", { class: "field__hint" }, "Not captured (user-owned token); find it by creation time / permissions in Cloudflare.")));
  if (row.usedAt) cleanupRows.push(kvRow("Used", `${relativeTime(row.usedAt)} (${absoluteTime(row.usedAt)})`));
  cleanupRows.push(
    kvRow(
      "Cleanup",
      h(
        "span",
        { class: "field__hint" },
        "Downpipes never held this token and cannot check Cloudflare for you. Delete it in the Cloudflare dashboard, then attest below.",
      ),
    ),
  );
  return drawerSection("Spent token, clean up", ...cleanupRows);
}

// buildFooterActions builds the drawer footer: the cleanup attestation (when pending) first, then
// Edit / Remove. All gated by expiry.config, disabled-with-reason for a reader (never
// hidden-then-403). close dismisses the drawer before the chosen flow opens.
function buildFooterActions(engine: EngineClient, row: ExpiryStatus, writeGate: boolean, pending: boolean, reload: () => void, close: () => void): DrawerActions {
  const reason = gateReason();
  const actions: DrawerActions = [];
  if (pending) {
    actions.push({
      label: "I have deleted it",
      ...(writeGate ? {} : { disabled: true, disabledReason: reason }),
      onClick: () => { close(); openCleanupAttest(engine, row, reload); },
    });
  }
  actions.push({
    label: "Edit",
    ...(writeGate ? {} : { disabled: true, disabledReason: reason }),
    onClick: () => { close(); openItemForm(engine, row, reload); },
  });
  actions.push({
    label: "Remove",
    variant: "danger",
    icon: svgIcon(ICON_TRASH, { size: 14 }),
    ...(writeGate ? {} : { disabled: true, disabledReason: reason }),
    onClick: () => { close(); void removeItem(engine, row, reload); },
  });
  return actions;
}
