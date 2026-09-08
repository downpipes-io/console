// Shared leaf for the credential lifecycle registry: the route + closed-list constants, the pure
// (DOM-free) tone/ordering/summary/phrase logic that must never read a stale green and must surface the
// most urgent item first (exercised by validate-credentials.ts in Node), and the small non-pure helpers
// (the lifecycle chip, the usage-link presenters with their allowlisted-path navigation, the date
// conversions, the gate reason and the read-only note). These are the building blocks both the list section
// and the add/edit forms reach for, so they live in this leaf and no section module imports another section
// module (which would form a cycle). Moved verbatim from the credentials coordinator for size; behaviour,
// copy and markup are unchanged.
//
// House rules: no-custody / redaction-by-construction (an item is a label + kind + class + an optional date
// only); status by hue + shape + label, never colour alone; honest copy; Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { caller, navigate } from "../../lib/nav.ts";
import { blindGateRemedy } from "../../lib/identity-remedy.ts";
import type { Field } from "../../components/field.ts";
import { badge, type StatusTone } from "../../components/status.ts";
import { titleCase } from "../../lib/format.ts";
import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import { noteGateComputedBlind } from "../../lib/client-diag/identity-gate.ts";
import type { Capability } from "../../lib/identity.ts";
import { callerCan } from "../../lib/identity-custom-roles.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import type { ExpiryStatus, ExpiryKind, ExpiryLifecycleClass, UsageLink } from "../../api.ts";

// The route is a PAIR: the list "/credentials" and the deep-linkable detail "/credentials/:id".
export const ROUTE_CREDENTIALS = "/credentials";

// The kinds an item may be (mirrors ExpiryKind), with their human labels for the select
// and the row chips. A closed list so a typo cannot reach the engine. "token" is the
// ephemeral Cloudflare/portal attach-token class (defaults the lifecycle to ephemeral).
export const KIND_OPTIONS: Array<{ value: ExpiryKind; label: string }> = [
  { value: "credential", label: "Credential" },
  { value: "key", label: "Key" },
  { value: "licence", label: "Licence" },
  { value: "certificate", label: "Certificate" },
  { value: "token", label: "Token" },
];

// The lifecycle classes for the collection-time select. ephemeral = a one-shot token to
// DELETE after use (it shows in "needs cleanup" once spent); functional = a standing
// credential the platform keeps using.
export const LIFECYCLE_OPTIONS: Array<{ value: ExpiryLifecycleClass; label: string }> = [
  { value: "functional", label: "Functional (standing credential)" },
  { value: "ephemeral", label: "Ephemeral (one-shot, delete after use)" },
];

// The Cloudflare API Tokens dashboard, where a spent attach token is deleted. A constant
// in-repo URL (never server-supplied), safe as an href.
export const CF_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

// ===========================================================================
// Pure helpers (exported for the validator: the load-bearing tone/ordering/summary
// logic that must never read a stale green and must surface the most urgent item first).
// ===========================================================================

// expiryStateTone maps a state to a status tone. An EXPIRED item is never the ok tone (no
// stale green); approaching is warn; ok is ok; NO-EXPIRY is NEUTRAL (never ok/green, a
// credential that does not expire is a distinct honest state, not "healthy").
export function expiryStateTone(state: ExpiryStatus["state"]): StatusTone {
  switch (state) {
    case "expired": return "danger";
    case "approaching": return "warn";
    case "ok": return "ok";
    case "no-expiry": return "neutral";
  }
}

// expiryStateLabel is the short human label for a state.
export function expiryStateLabel(state: ExpiryStatus["state"]): string {
  switch (state) {
    case "expired": return "expired";
    case "approaching": return "approaching";
    case "ok": return "healthy";
    case "no-expiry": return "no expiry";
  }
}

// stateOrder ranks states for display: expired first, approaching next, ok, then no-expiry
// LAST (a no-expiry item is never urgent, so it sinks below the healthy dated items).
export function stateOrder(state: ExpiryStatus["state"]): number {
  switch (state) {
    case "expired": return 0;
    case "approaching": return 1;
    case "ok": return 2;
    case "no-expiry": return 3;
  }
}

// remainingSortValue is the numeric used by the Remaining column's sort and the soonest-
// deadline pick: the days-remaining, with an ABSENT daysRemaining (a no-expiry item)
// treated as +Infinity so it sorts AFTER every dated item. Guards the optional field
// before any arithmetic. Exported for the validator.
export function remainingSortValue(row: ExpiryStatus): number {
  if (row.state === "no-expiry" || row.daysRemaining === undefined) return Number.POSITIVE_INFINITY;
  return row.daysRemaining;
}

// compareExpiry orders items for display: by state (expired first), then by days-remaining
// ascending (the soonest deadline leads within a group, a no-expiry item's +Infinity sorts
// last), then by label for stability. The days read is guarded (an absent daysRemaining is
// +Infinity) BEFORE any arithmetic. Exported so the validator asserts "most urgent first".
export function compareExpiry(a: ExpiryStatus, b: ExpiryStatus): number {
  const st = stateOrder(a.state) - stateOrder(b.state);
  if (st !== 0) return st;
  const da = remainingSortValue(a);
  const db = remainingSortValue(b);
  if (da !== db) return da - db;
  return a.label.localeCompare(b.label);
}

// expirySummary counts the list by state for the summary band. no-expiry is its own count
// (it is NOT folded into ok, they are distinct honest states). Exported for the validator.
export function expirySummary(rows: ExpiryStatus[]): { total: number; expired: number; approaching: number; ok: number; noExpiry: number } {
  let expired = 0;
  let approaching = 0;
  let okCount = 0;
  let noExpiry = 0;
  for (const r of rows) {
    if (r.state === "expired") expired++;
    else if (r.state === "approaching") approaching++;
    else if (r.state === "no-expiry") noExpiry++;
    else okCount++;
  }
  return { total: rows.length, expired, approaching, ok: okCount, noExpiry };
}

// soonestRow returns the row with the fewest days remaining (the soonest deadline), or
// null for an empty list. A no-expiry item's +Infinity means it is never the soonest
// unless it is the ONLY item. Guards the optional days field via remainingSortValue.
export function soonestRow(rows: ExpiryStatus[]): ExpiryStatus | null {
  if (rows.length === 0) return null;
  return rows.reduce((min, r) => (remainingSortValue(r) < remainingSortValue(min) ? r : min), rows[0]!);
}

// daysPhrase is the days-remaining read for a row. Branches on the state BEFORE any
// arithmetic: a NO-EXPIRY (or absent-days) row reads "no expiry"; an expired item reads
// "expired Nd ago"; an active item reads "Nd remaining". Exported for the validator.
export function daysPhrase(row: ExpiryStatus): string {
  if (row.state === "no-expiry" || row.daysRemaining === undefined) return "no expiry";
  if (row.state === "expired") {
    const overdue = Math.max(0, -row.daysRemaining);
    return overdue === 0 ? "expired today" : `expired ${overdue}d ago`;
  }
  if (row.daysRemaining === 0) return "expires today";
  if (row.daysRemaining === 1) return "1d remaining";
  return `${row.daysRemaining}d remaining`;
}

// soonestTileValue is the COMPACT value for the "Soonest deadline" stat tile, which already
// carries the state badge beside it, so the value reads as a bare count. It must never emit
// a negative `${n}d`: an expired item reads "overdue"; a NO-EXPIRY / absent-days row reads
// "none" (no deadline to count to); a same-day deadline reads "today"; otherwise the days
// remaining. Guards the optional days field BEFORE arithmetic. Exported for the validator.
export function soonestTileValue(row: ExpiryStatus): string {
  if (row.state === "no-expiry" || row.daysRemaining === undefined) return "none";
  if (row.state === "expired") return "overdue";
  if (row.daysRemaining <= 0) return "today";
  return `${row.daysRemaining}d`;
}

// lifecycleLabel is the short human label for the lifecycle class (and the filter text /
// sort value). An ABSENT class reads "unset" (an older engine row that predates the field).
// Exported for the validator (the chip ordering / label).
export function lifecycleLabel(cls: ExpiryLifecycleClass | undefined): string {
  if (cls === "ephemeral") return "ephemeral";
  if (cls === "functional") return "functional";
  return "unset";
}

// ---- small non-pure helpers (DOM / predicates) ------------------------------

// needsAttention is the predicate that HOISTS a row into the "Needs attention" tier:
//   (a) a spent EPHEMERAL row awaiting cleanup (cleanupState "pending"), OR
//   (b) an EXPIRED item that something depends on (a usage link).
// A merely-approaching item is NOT hoisted (it lives in the table + the posture line).
export function needsAttention(row: ExpiryStatus): boolean {
  return isPendingCleanup(row) || (row.state === "expired" && row.usageLink !== undefined);
}

// isPendingCleanup: an ephemeral item whose cleanupState is "pending" (a spent one-shot
// token to delete). The lifecycle guard keeps a functional item out even if the engine
// ever set the field.
export function isPendingCleanup(row: ExpiryStatus): boolean {
  return row.lifecycleClass === "ephemeral" && row.cleanupState === "pending";
}

// lifecycleChip is the compact Lifecycle column chip: colour + shape + label, via badge().
// Ephemeral reads warn (it is a thing to clean up), Functional reads neutral (a standing
// credential, NOT ok/green, which is reserved for an affirmative health read), an unset
// class reads a plain default badge. Hue + shape + label, never colour alone.
export function lifecycleChip(cls: ExpiryLifecycleClass | undefined): HTMLElement {
  if (cls === "ephemeral") return badge("warn", "Ephemeral");
  if (cls === "functional") return badge("neutral", "Functional");
  return badge("default", "Unset");
}

// usageLinkLabel is the human "used by" label for a usage link, built from the CLOSED kind
// + the refId as TEXT (the refId is a stable entity id, never a secret, but it is still
// added as text content, never an attribute). An absent link reads "-".
export function usageLinkLabel(link: UsageLink | undefined): string {
  if (!link) return "-";
  const surface = usageLinkSurfaceLabel(link);
  return `${surface}: ${link.refId}`;
}

// usageLinkSurfaceLabel names the SURFACE a usage link points at, from the closed kind
// (never the refId). Used for the link text and the "Open <surface>" affordance.
export function usageLinkSurfaceLabel(link: UsageLink | undefined): string {
  if (!link) return "the resource";
  switch (link.kind) {
    case "destination": return "destination";
    case "idpConnection": return "identity provider";
    case "sourceBinding": return "source";
  }
}

// usageLinkPath maps the CLOSED usageLink.kind to an ALLOWLISTED in-app path. The refId is
// NEVER interpolated into the path/href, only the kind selects a fixed route, so a server-
// supplied refId can never reach an href. (destination -> /destinations; idpConnection ->
// /access/idp; sourceBinding -> /sources.)
function usageLinkPath(link: UsageLink): string {
  switch (link.kind) {
    case "destination": return "/destinations";
    case "idpConnection": return "/access/idp";
    case "sourceBinding": return "/sources";
  }
}

// usageContextLink builds the in-app navigation affordance for a usage link: a linklike
// button that navigates to the allowlisted path (NOT an <a href> with an interpolated id).
// The label is text. When there is no link it returns a quiet hyphen placeholder ("-").
export function usageContextLink(link: UsageLink | undefined, label: string): HTMLElement {
  if (!link) return h("span", { class: "field__hint" }, "-");
  const to = usageLinkPath(link);
  const btn = h("button", { "data-dp": "credentials.button.navigate", class: "linklike", type: "button", style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, label, svgIcon(ICON_EXTERNAL, { size: 12 })) as HTMLButtonElement;
  btn.addEventListener("click", () => navigate(to));
  return btn;
}

// makeReadOnly disables a field's control and surfaces the reason as a hint tied to the
// control via aria-describedby (an observed item's label / kind / date are the engine's;
// an edit may change purpose / note but not these). Keeps the value visible, never hidden,
// via aria-disabled rather than the native `disabled` attribute: the control stays
// in the tab order and the reason reaches a screen reader, rather than both silently
// dropping out together; the previous disabled+aria-readonly combination had no
// defined accessibility meaning).
export function makeReadOnly(f: Field, reason: string): void {
  f.setDisabled(reason);
}

// ---- date helpers -----------------------------------------------------------

// toDateInputValue extracts the YYYY-MM-DD a date input wants from an RFC-3339 instant.
// Uses the UTC date so the value matches what was stored (we store end-of-day UTC).
export function toDateInputValue(rfc3339: string): string {
  const ms = Date.parse(rfc3339);
  if (!Number.isFinite(ms)) {
    // The stored expiry instant did not parse, so the edit form opens with an EMPTY date field. The
    // operator sees a credential with no expiry where one was set, and a save from that form writes the empty
    // value back. The empty string stays (a fabricated date would be worse), and the class is recorded so an
    // engine serialisation regression in the expiry registry is visible in the pack rather than showing up as a
    // customer who "cleared" a date they never touched. The instant itself never travels.
    recordWireAnomaly("timestamp", "unparseable");
    return "";
  }
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// isValidDateInput checks a YYYY-MM-DD string parses to a real calendar date. Date.parse
// silently rolls over an out-of-range day ("" becomes), so a finite
// parse is not enough: we round-trip the parsed UTC components back to YYYY-MM-DD and require
// it to equal the input. An overflowed date reformats to a different day and is rejected.
export function isValidDateInput(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const back = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return back === v;
}

// toRfc3339EndOfDay turns a YYYY-MM-DD into an RFC-3339 instant at 23:59:59 UTC, so a
// "valid through DATE" reads as valid for the whole of that day. The engine treats it as
// the expiry instant; the days-remaining computation is the engine's.
export function toRfc3339EndOfDay(v: string): string {
  return `${v}T23:59:59Z`;
}

// ---- small UI helpers -------------------------------------------------------

// callerCanCap gates the expiry.config write over the caller's EFFECTIVE capability set, so a custom
// role holding expiry.config is not floored to the "viewer" the engine pins on its built-in role field.
// Same blind-witness discipline as callerRole: a null caller (whoami pending) notes the blind gate and
// fails closed to no-capability, never shown a write control enabled before its role lands.
export function callerCanCap(capability: Capability): boolean {
  const c = caller();
  if (!c) {
    noteGateComputedBlind();
    return false;
  }
  return callerCan(c.role, capability, c.customRole ?? null);
}

export function gateReason(): string {
  const c = caller();
  if (!c) return `Requires the Operator role or higher. ${blindGateRemedy()}`;
  return `Tracking, editing, removing or attesting cleanup of an item needs the Operator, Approver or Owner role; your role (${titleCase(c.role)}) cannot. The engine enforces this server-side.`;
}

// readOnlyNote is the ONE visible read-only statement for a gated view: a quiet line
// beside the toolbar (CALM-04), replacing the per-row "Read only" hints and the bottom
// gate card. The disabled Track button keeps its title reason.
export function readOnlyNote(): HTMLElement {
  return h("p", { class: "note-quiet" }, `Read only: ${gateReason()}`);
}

// errText now lives in lib/errors.ts; re-exported here so the credentials screens keep their local import.
export { errText } from "../../lib/errors.ts";
