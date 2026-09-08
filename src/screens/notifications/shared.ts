// Shared leaf for the Notifications screen: the three sub-view routes, the closed channel-kind and
// NotifyEvent catalogues, the pure (DOM-free) input builders (buildChannelInputFrom / buildRuleInputFrom) and
// validators (validateUrl / validateAddresses / parseAddresses) the validator pins, and the small presenters
// (the gate reason and read-only note, the checkbox row, the badges, the severity/event/scope helpers, the
// destination-display truncation). These are the building blocks the channels, rules and history panels reach
// for, so they live in this leaf and no panel module imports another panel module (which would form a cycle).
// Moved verbatim from the notifications coordinator for size; behaviour, copy and markup are unchanged.
//
// House rules: no-custody (a channel carries the customer's own url / routing key / addresses, never a key or
// value); textContent on every server string; Australian English, no em dashes.

import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { caller } from "../../lib/nav.ts";
import { blindGateRemedy } from "../../lib/identity-remedy.ts";
import { noteGateComputedBlind } from "../../lib/client-diag/identity-gate.ts";
import type { Field } from "../../components/field.ts";
import { badge, statusWithLabel, type StatusTone } from "../../components/status.ts";
import { titleCase } from "../../lib/format.ts";
import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import type { Capability } from "../../lib/identity.ts";
import { callerCan } from "../../lib/identity-custom-roles.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { refuseWithReason } from "../common.ts";
import type { ChannelKind, DownpipeState, NotifyChannel, NotifyChannelInput, NotifyEvent, NotifyRuleInput, NotifyScope, Severity } from "../../api.ts";

export const ROUTE_CHANNELS = "/notifications";
export const ROUTE_RULES = "/notifications/rules";
export const ROUTE_HISTORY = "/notifications/history";

export type NotifyTab = "channels" | "rules" | "history";

// NOTIFY_API_KEY_MAX bounds the plaintext credential a channel carries (jsm's GenieKey token,
// servicenow's Basic-auth password). It mirrors the engine's API_KEY_MAX
// (engine/src/notify-routing.ts:248), so the console cannot accept a credential the engine would
// refuse. Both boxes are write-only and start blank on edit, which is why the bound needs stating
// here at all: on the edit path the field's `required` is false, so without a validator the field
// carried no rule and the bound was unenforced in the browser.
export const NOTIFY_API_KEY_MAX = 512;

// NOTIFY_USERNAME_MAX bounds the servicenow Basic-auth username. It mirrors the engine's USERNAME_MAX
// (engine/src/notify-routing.ts:249), which validateServicenowKind enforces, so the console cannot
// accept a username the engine would refuse. Stated here for the same reason as the bound above: the
// field carried `required` and no validator, so the ceiling was unenforced in the browser on every
// path and a 257-character username reached the engine to be turned away there. Driven against the
// served bundle before the repair: 257 characters passed blur AND Save.
export const NOTIFY_USERNAME_MAX = 256;

// The channel kinds, labelled. This is the single per-kind source the form reads. Per-kind
// field routing is handled by destinationFieldFor() and the teams-mode toggle (plus, for jsm and
// servicenow, the credential fields channels.ts shows alongside the url field), not here.
export const CHANNEL_KINDS: ReadonlyArray<{ kind: ChannelKind; label: string }> = [
  { kind: "webhook", label: "Webhook (generic HTTPS POST)" },
  { kind: "slack", label: "Slack (incoming webhook)" },
  { kind: "teams", label: "Microsoft Teams (connector or email)" },
  { kind: "pagerduty", label: "PagerDuty (Events API v2)" },
  { kind: "jsm", label: "Jira Service Management / Opsgenie (Alert API)" },
  { kind: "servicenow", label: "ServiceNow Event Management" },
  { kind: "email", label: "Email" },
];

// jsm and servicenow both carry a url (their alert-create / em_event endpoint) as their PRIMARY
// destination field, exactly like webhook/slack, so the fallthrough below already routes them
// correctly; their ADDITIONAL credential fields (apiKey, and servicenow's username) are shown
// alongside this one by channels.ts, not chosen through this function.
export function destinationFieldFor(
  kind: ChannelKind,
  teamsMode: string,
  fields: { urlField: Field; routingKeyField: Field; addressesField: Field },
): Field {
  if (kind === "pagerduty") return fields.routingKeyField;
  if (kind === "email") return fields.addressesField;
  if (kind === "teams") return teamsMode === "email" ? fields.addressesField : fields.urlField;
  return fields.urlField; // webhook | slack | jsm | servicenow
}

// buildChannelInputFrom assembles the NotifyChannelInput with EXACTLY the destination field(s) the
// kind carries, included only when they have a value (exactOptionalPropertyTypes), so an absent
// field and an explicit-undefined field are the same on the wire (matching the engine's per-kind
// shape). It is the no-custody-critical core: a channel must carry the customer's own url / routing
// key / addresses and nothing foreign, never two destinations. Pure (takes the destination as a
// string, not a DOM field) so it is unit-testable without a DOM; it is the test seam by virtue of
// being pure and exported.
//
// jsm and servicenow are the two kinds that carry MORE than one field: both take destValue as their
// url (the same "one discriminated field" the webhook/slack path already uses); apiKey and username
// are ADDITIONAL, orthogonal parameters (trailing and optional, so every existing call site is
// unaffected). apiKey is the WRITE-ONLY bearer/basic credential: an empty/omitted value is the
// KEEP-SECRET signal (never sent on the wire, so the engine splices in the prior sealed value when
// the destination is unchanged); username (servicenow only) is NOT a secret and is always resupplied
// when present, mirroring url.
export function buildChannelInputFrom(
  existingId: string | null,
  name: string,
  kind: ChannelKind,
  teamsMode: string,
  destValue: string,
  enabled: boolean,
  apiKey?: string,
  username?: string,
): NotifyChannelInput {
  const base: NotifyChannelInput = {
    kind,
    name,
    enabled,
    ...(existingId !== null ? { id: existingId } : {}),
  };
  const usesAddresses = kind === "email" || (kind === "teams" && teamsMode === "email");
  const usesRoutingKey = kind === "pagerduty";
  const usesApiKey = kind === "jsm" || kind === "servicenow";
  if (usesAddresses) {
    return { ...base, toAddresses: parseAddresses(destValue) };
  }
  if (usesRoutingKey) {
    return { ...base, routingKey: destValue };
  }
  if (usesApiKey) {
    const trimmedKey = (apiKey ?? "").trim();
    return {
      ...base,
      url: destValue,
      ...(trimmedKey !== "" ? { apiKey: trimmedKey } : {}),
      ...(kind === "servicenow" ? { username: (username ?? "").trim() } : {}),
    };
  }
  return { ...base, url: destValue };
}

// RuleFormValues is the plain (DOM-free) shape the rule form collects; buildRuleInputFrom
// turns it into a NotifyRuleInput or a validation error, so the selection rules are unit-
// testable. Kept local to the screen (not a wire type).
export interface RuleFormValues {
  existingId: string | null;
  scopeKind: "global" | "downpipe";
  downpipeId: string;
  minSeverity: Severity;
  eventsMode: "all" | "selected";
  selectedEvents: NotifyEvent[];
  channelIds: string[];
  digest: "off" | "daily" | "weekly";
  enabled: boolean;
}

// buildRuleInputFrom validates and assembles a NotifyRuleInput from the plain form values,
// returning { input } on success or { error } with the inline message on a validation
// failure. The rules mirror the engine's: a rule must deliver to at least one channel, and
// when events is not "all" it must select at least one event. digest is included only when
// it is not the default "off" (exactOptionalPropertyTypes), and id only when editing, so
// the wire shape matches the engine's spread-when-present construction exactly. Pure, so it
// is exercised by the validator without a DOM.
export function buildRuleInputFrom(v: RuleFormValues): { input: NotifyRuleInput } | { error: string } {
  if (v.channelIds.length === 0) {
    return { error: "Select at least one channel to deliver to." };
  }
  let events: NotifyEvent[] | "all";
  if (v.eventsMode === "all") {
    events = "all";
  } else {
    if (v.selectedEvents.length === 0) {
      return { error: "Select at least one event, or choose \"All events\"." };
    }
    events = v.selectedEvents;
  }
  const scope: NotifyScope = v.scopeKind === "downpipe" ? { kind: "downpipe", downpipeId: v.downpipeId } : { kind: "global" };
  const input: NotifyRuleInput = {
    scope,
    minSeverity: v.minSeverity,
    events,
    channelIds: v.channelIds,
    enabled: v.enabled,
    ...(v.digest !== "off" ? { digest: v.digest } : {}),
    ...(v.existingId !== null ? { id: v.existingId } : {}),
  };
  return { input };
}

// The closed NotifyEvent set, labelled, with the fixed severity each carries (the engine's severityOf,
// notify-routing.ts), so the rule form and the events cell share one list. All 23 engine events are
// listed (CONSOLE-MIRROR-DRIFT-SWEEP): this used to hold 12, so a customer could not build a
// rule targeting any of the 11 missing events individually. See NotifyEvent (../../api/types/
// notifications.ts) for the full drift history and the per-event severity source.
export const NOTIFY_EVENTS: ReadonlyArray<{ event: NotifyEvent; label: string; severity: Severity }> = [
  { event: "backup-failure", label: "Backup failure", severity: "critical" },
  { event: "restore-test-fail", label: "Restore test failed", severity: "critical" },
  { event: "posture-regression", label: "Posture regression", severity: "critical" },
  { event: "recovery-code-abuse", label: "Recovery-code abuse (repeated break-glass failures)", severity: "critical" },
  { event: "canary-dead", label: "Canary backup failed", severity: "critical" },
  { event: "update-rollback-needed", label: "Update rollback needed", severity: "critical" },
  { event: "backup-stale", label: "Backup stale", severity: "warning" },
  { event: "backup-volume-regression", label: "Backup volume regression", severity: "warning" },
  { event: "source-detached", label: "Source detached", severity: "warning" },
  { event: "credential-expiry", label: "Credential or key expiry", severity: "warning" },
  { event: "dest-change", label: "Destination changed", severity: "warning" },
  { event: "sign-in-new-context", label: "Sign-in from a new context", severity: "warning" },
  { event: "recovery-code-used", label: "Recovery code used", severity: "warning" },
  { event: "dual-control-disabled", label: "Dual control disabled", severity: "warning" },
  { event: "update-available", label: "Update available", severity: "warning" },
  { event: "auth-credential-change", label: "Sign-in credential change", severity: "warning" },
  { event: "backup-success", label: "Backup success", severity: "info" },
  { event: "restore-test-pass", label: "Restore test passed", severity: "info" },
  { event: "restore-applied", label: "Restore applied", severity: "info" },
  { event: "role-change", label: "Role change", severity: "info" },
  { event: "canary-recovered", label: "Canary backup recovered", severity: "info" },
  // The base severity is warning; the engine may deliver run-at-risk-eviction at critical when the
  // copy count would drop to one, and the history panel renders the wire severity each delivery carried.
  { event: "replication-degraded", label: "Replication degraded", severity: "warning" },
  { event: "run-at-risk-eviction", label: "Run at risk of eviction", severity: "warning" },
];

// Shared small helpers

// callerCanCap answers the notify.config write gate over the caller's EFFECTIVE capability set, so a
// custom role holding notify.config is not floored to the "viewer" the engine pins on its built-in role
// field. It keeps callerRole's blind-witness discipline verbatim: a null caller (whoami pending) notes
// the blind gate and fails closed to no-capability, never shown a control enabled before its role lands.
export function callerCanCap(capability: Capability): boolean {
  const c = caller();
  if (!c) {
    noteGateComputedBlind();
    return false;
  }
  return callerCan(c.role, capability, c.customRole ?? null);
}

// primaryButton builds a primary action button that is refused-with-reason when the
// capability gate is not met (design-system: disabled-with-reason, not hidden-then-403).
// The refusal is delivered with refuseWithReason rather than `disabled`, so the control
// keeps its place in the tab order and its reason is text a keyboard or touch user can
// reach. The gate itself is unchanged: the handler is still attached only when allowed.
export function primaryButton(label: string, icon: string, allowed: boolean, onClick: () => void): HTMLButtonElement {
  const btn = (allowed
    ? h("button", { "data-dp": "notifications.button.primary-button#1", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(icon, { size: 14 }), label)
    : h("button", { "data-dp": "notifications.button.primary-button#2", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(icon, { size: 14 }), label)) as HTMLButtonElement;
  if (allowed) btn.addEventListener("click", onClick);
  else refuseWithReason(btn, gateReason());
  return btn;
}

// gateReason is the inline disabled-with-reason copy for a notify.config-gated control. Names the
// permission in customer language, not the raw "Notify config" capability label.
export function gateReason(): string {
  const c = caller();
  const phrase = capabilityPhrase("notify.config");
  if (!c) return `Requires ${phrase}. ${blindGateRemedy()}`;
  return `Requires ${phrase}; your role (${titleCase(c.role)}) does not have it. Operators, Approvers and Owners can configure notifications.`;
}

// readOnlyNote is the ONE visible read-only statement for a gated view: a quiet line
// beside the toolbar (CALM-04), replacing the per-row "Read only" hints and the bottom
// gate card that restated the same gate three ways. Disabled buttons keep their titles.
export function readOnlyNote(): HTMLElement {
  return h("p", { class: "note-quiet" }, `Read only: ${gateReason()}`);
}

// checkboxRow builds a labelled checkbox row (used by the rule form's event and channel
// checklists). It returns a handle exposing the checked state. The secondary text (a
// severity word or a channel kind) is rendered as a muted hint via a text node.
export function checkboxRow(id: string, label: string, secondary: string, checked: boolean): { el: HTMLElement; checked: () => boolean } {
  const box = h("input", { type: "checkbox", id, style: "margin-top:2px;flex:none" }) as HTMLInputElement;
  box.checked = checked;
  const row = h("label", { for: id, style: "display:flex;gap:var(--space-2);align-items:flex-start;font-size:var(--text-base);cursor:pointer" });
  row.appendChild(box);
  const textWrap = h("span");
  textWrap.appendChild(document.createTextNode(label));
  if (secondary) textWrap.appendChild(h("span", { class: "field__hint", style: "margin-left:var(--space-2)" }, secondary));
  row.appendChild(textWrap);
  return { el: row, checked: () => box.checked };
}

export function kindBadge(kind: ChannelKind): HTMLElement {
  return badge("default", kind);
}

// downpipeScopeIsMissing answers whether a per-downpipe rule points at a downpipe that is no longer in the
// list. Pure over the two values, so it is unit-tested directly: scopeBadge builds DOM and the notifications
// validator is deliberately DOM-free.
//
// An EMPTY list is "not known", NOT "nothing exists". Without that, a caller that has no downpipe list yet
// would have every per-downpipe rule declared broken, which is a worse lie than saying nothing.
export function downpipeScopeIsMissing(scope: NotifyScope, downpipes: readonly DownpipeState[]): boolean {
  if (scope.kind !== "downpipe" || downpipes.length === 0) return false;
  return !downpipes.some((d) => d.config.id === scope.downpipeId);
}

// scopeBadge renders a rule's scope. The `downpipes` list is what lets it say when a per-downpipe rule points
// at a downpipe that is GONE: deleting a downpipe removes the downpipe, its history and its replication state
// and does NOT prune the notify rules scoped to it, so such a rule survives, matches nothing and delivers
// nothing while reading as an ordinary downpipe-scoped rule. The rule FORM already says "(no longer exists)"
// for the same id (rule-form.ts's downpipe picker), so this makes the table agree with the form rather than
// leaving the truth visible in only one of the two places an operator looks.
export function scopeBadge(scope: NotifyScope, downpipes: readonly DownpipeState[] = []): HTMLElement {
  if (scope.kind === "global") return badge("info", "global");
  const gone = downpipeScopeIsMissing(scope, downpipes);
  return h(
    "span",
    badge("default", "downpipe"),
    h("span", { class: "mono field__hint nowrap", style: "margin-left:var(--space-2)" }, scope.downpipeId),
    gone ? h("span", { class: "field__hint nowrap", style: "margin-left:var(--space-1)" }, "(no longer exists)") : null,
  );
}

export function scopeText(scope: NotifyScope): string {
  return scope.kind === "global" ? "global" : `downpipe ${scope.downpipeId}`;
}

// SEVERITY_RANK orders the severities for sorting: critical sorts above warning above info.
// Naming the scale keeps the ordering contract explicit if a new level is added later.
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export function severityBadge(s: Severity): HTMLElement {
  const tone: StatusTone = s === "critical" ? "danger" : s === "warning" ? "warn" : "info";
  return statusWithLabel(tone, s);
}

export function eventLabel(event: NotifyEvent): string {
  const def = NOTIFY_EVENTS.find((e) => e.event === event);
  // An event id this console build does not know is rendered as its own id with the hyphens rubbed out,
  // which looks like a label and is not one. The rule the operator is reading is a rule for an event the console
  // cannot describe, and only the engine's version says why.
  if (def === undefined) recordContractSkew("unknown-enum-member", "notify-event");
  return def?.label ?? event.replace(/-/g, " ");
}

export function eventsText(events: NotifyEvent[] | "all"): string {
  return events === "all" ? "all events" : events.map(eventLabel).join(" ");
}

// MAX_EVENTS_SHOWN is how many events the table cell names before the "+N more" hint.
const MAX_EVENTS_SHOWN = 2;

export function eventsCell(events: NotifyEvent[] | "all"): HTMLElement {
  if (events === "all") return badge("info", "all events");
  if (events.length === 0) return h("span", { class: "field__hint" }, "none");
  // Show the first couple by name, then a "+N" so a long list stays compact; the full
  // list is available via the filter text and the edit form.
  const wrap = h("span", { style: "display:inline-flex;gap:var(--space-1);flex-wrap:wrap" });
  const shown = events.slice(0, MAX_EVENTS_SHOWN);
  for (const e of shown) wrap.appendChild(badge("default", eventLabel(e)));
  if (events.length > shown.length) wrap.appendChild(h("span", { class: "field__hint" }, `+${events.length - shown.length} more`));
  return wrap;
}

// channelTargetText is the channel's full destination (used for filter matching only).
export function channelTargetText(c: NotifyChannel): string {
  if (c.url) return c.url;
  if (c.routingKey) return c.routingKey;
  if (c.toAddresses && c.toAddresses.length > 0) return c.toAddresses.join(", ");
  return "-";
}

// Display-truncation thresholds for the destination cell. PATH_TAIL_THRESHOLD is the URL path
// length above which a tail glimpse is shown; PATH_TAIL_CHARS is how many tail characters that
// glimpse keeps. URL_TRUNCATE_KEEP and ROUTING_KEY_TRUNCATE_KEEP are the middle-truncation
// keep-lengths for an unparseable URL and a PagerDuty routing key respectively.
const PATH_TAIL_THRESHOLD = 12;
const PATH_TAIL_CHARS = 4;
const URL_TRUNCATE_KEEP = 20;
const ROUTING_KEY_TRUNCATE_KEEP = 8;

// channelTargetDisplay is the TABLE read of a destination. A webhook/Slack/Teams URL path
// and a PagerDuty routing key are bearer credentials, so the cell shows a recognisable,
// middle-truncated form only (the host stays legible); the full value remains in the edit
// form. Email addresses are not bearer values and render in full.
export function channelTargetDisplay(c: NotifyChannel): string {
  if (c.url) {
    try {
      const u = new URL(c.url);
      if (u.pathname.length <= 1) return u.origin;
      // A tail glimpse only when the path is long enough that four characters stay a
      // small fraction of it; a short path elides entirely (never shown in full).
      return u.pathname.length > PATH_TAIL_THRESHOLD ? `${u.origin}/…${u.pathname.slice(-PATH_TAIL_CHARS)}` : `${u.origin}/…`;
    } catch {
      // The stored channel URL will not parse as a URL. The console falls back to a truncated middle,
      // which reads as a perfectly ordinary elided endpoint, so a channel that CANNOT deliver (the engine will
      // not reach an unparseable URL either) presents exactly like a healthy one. The class is recorded; the URL
      // itself never travels, and that is not a technicality: an unparseable URL is precisely the value most
      // likely to be a customer string that ended up in the wrong field.
      recordWireAnomaly("stored-url", "unparseable");
      return truncateMiddle(c.url, URL_TRUNCATE_KEEP);
    }
  }
  if (c.routingKey) return truncateMiddle(c.routingKey, ROUTING_KEY_TRUNCATE_KEEP);
  if (c.toAddresses && c.toAddresses.length > 0) return c.toAddresses.join(", ");
  return "-";
}

// truncateMiddle keeps the head and tail of an opaque value so it stays recognisable
// without reproducing the whole bearer string.
function truncateMiddle(s: string, keep: number): string {
  if (s.length <= keep) return s;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

// validateUrl mirrors the engine's channel-url rule for inline feedback: https, no
// embedded credentials (userinfo), and not a workers.dev host. The engine re-validates
// server-side as the actual control; this is the early, friendly check. Exported so the
// validator asserts the no-custody-relevant rules (https, no userinfo, not workers.dev).
export function validateUrl(v: string): string | null {
  if (v.length === 0) return "A URL is required.";
  // The engine caps the url at 2048 characters (notify/types.ts); check it here so an over-long URL
  // fails at the field rather than as a save-time 400.
  if (v.length > 2048) return "The URL is too long (at most 2048 characters).";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Enter a valid URL.";
  }
  if (u.protocol !== "https:") return "The URL must use https.";
  if (u.username || u.password) return "The URL must not contain embedded credentials.";
  if (u.hostname === "workers.dev" || u.hostname.endsWith(".workers.dev")) return "Use a custom domain, not a workers.dev host.";
  return null;
}

// The address length and recipient bounds mirror the engine (engine/src/email.ts MAX_ADDRESS_LEN /
// MAX_RECIPIENTS). Kept in step so the console rejects what the engine would refuse on submit.
const MAX_ADDRESS_LEN = 320;
const MAX_RECIPIENTS = 50;

// addressReason mirrors the engine's isCustomDomainAddress (engine/src/email.ts): a per-address
// boundary sanity check (no whitespace; exactly one @ with a non-empty local part; a dotted custom
// domain; never workers.dev; within the length bound), so a value the form accepts is not then
// refused server-side. Returns a short reason, or null when the address is plausible.
function addressReason(a: string): string | null {
  if (a.length > MAX_ADDRESS_LEN) return "is too long";
  if (/\s/.test(a)) return "must not contain spaces";
  const at = a.indexOf("@");
  if (at <= 0 || at !== a.lastIndexOf("@") || at === a.length - 1) return "must be a single address@domain";
  const domain = a.slice(at + 1).toLowerCase();
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return "needs a dotted domain (for example ops@example.com)";
  if (domain === "workers.dev" || domain.endsWith(".workers.dev")) return "cannot be a workers.dev address; use a custom domain";
  return null;
}

// validateAddresses checks a comma-separated address list: at least one address, at most MAX_RECIPIENTS,
// and every entry plausible by addressReason. The engine re-validates each address as the actual control.
// Exported for the validator.
export function validateAddresses(v: string): string | null {
  const list = parseAddresses(v);
  if (list.length === 0) return "Enter at least one email address.";
  if (list.length > MAX_RECIPIENTS) return `Enter at most ${MAX_RECIPIENTS} email addresses.`;
  for (const a of list) {
    const reason = addressReason(a);
    if (reason) return `"${a}" ${reason}.`;
  }
  return null;
}

// parseAddresses splits a comma-separated address list into trimmed, non-empty entries.
// Exported so the validator confirms the parse (and that buildChannelInputFrom carries
// exactly that list, never the raw string).
export function parseAddresses(v: string): string[] {
  return v
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

// errText now lives in lib/errors.ts; re-exported here so the notifications screens keep their local import.
export { errText } from "../../lib/errors.ts";
