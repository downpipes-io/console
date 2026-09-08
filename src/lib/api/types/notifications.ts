// Notifications mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// Notifications, mirrored byte-for-byte from the engine's notify
// types so the two sides cannot drift. A channel/rule/history entry carries the customer's own
// config and a redaction-safe outcome detail only; never a secret, key or value.

// ChannelKind is the delivery transport for a notification channel. "jsm" is Jira Service
// Management / Opsgenie (one alias-keyed Alert API client covers both); "servicenow" is ServiceNow
// Event Management's em_event table API.
export type ChannelKind = "email" | "webhook" | "slack" | "pagerduty" | "teams" | "jsm" | "servicenow";

// NotifyChannel is one configured delivery channel. For webhook|slack|teams|jsm|servicenow, url is
// the destination (https, no userinfo, not workers.dev); pagerduty carries routingKey (Events API
// v2 routing key); email|teams may instead carry toAddresses (validated addresses). jsm and
// servicenow ADDITIONALLY carry a bearer/basic credential: apiKeyPresent reports (read-only)
// whether one is currently sealed, NEVER the credential itself (the engine's
// redactChannelSecretForRead strips it from every read); servicenow also carries username, its
// non-secret HTTP Basic account name, always echoed. id is a ULID (storage key
// notify-channel:${id}); createdAt is RFC-3339. The optional fields are present only when they carry
// a value (exactOptionalPropertyTypes), matching the engine's per-kind shape.
export interface NotifyChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  url?: string;
  routingKey?: string;
  toAddresses?: string[];
  // username is servicenow's HTTP Basic auth account name (non-secret; always echoed on read).
  username?: string;
  // apiKeyPresent is jsm/servicenow only: whether a bearer/basic credential is currently sealed for
  // this channel. The credential itself is write-only and never returned by a read.
  apiKeyPresent?: boolean;
  enabled: boolean;
  createdAt: string;
}

// NotifyChannelInput is the POST /admin/notify/channels body: a channel WITHOUT the server-assigned
// id/createdAt for a create, or WITH an existing id to update. The engine assigns the ULID and
// createdAt on create and validates the per-kind shape; a malformed channel is a 400 { error }.
// The optional id is included only to address an existing channel for update. apiKey is the
// jsm (GenieKey token) or servicenow (Basic-auth password) WRITE-ONLY credential: it rides only
// when the operator typed one; an omitted/blank value on an edit means "keep the currently sealed
// credential" (KEEP-SECRET), honoured by the engine ONLY when the channel's kind and url are
// unchanged from the stored record (a repoint must resupply it, closing a credential-exfiltration
// path). username is servicenow's Basic-auth account name (non-secret; always resupplied, like url).
export interface NotifyChannelInput {
  id?: string;
  kind: ChannelKind;
  name: string;
  url?: string;
  routingKey?: string;
  toAddresses?: string[];
  username?: string;
  apiKey?: string;
  enabled: boolean;
}

// NotifyEvent is the closed set of events a rule can select, mirroring the engine's OWN literal values
// verbatim (engine/src/notify/types.ts's NOTIFY_EVENT_NAMES, the engine's single source of truth) in the
// engine's own order: this used to be a 12-member subset, so a
// customer could not build a rule individually targeting any of the 11 missing events (several
// security-relevant: dual-control-disabled, recovery-code-abuse, sign-in-new-context, canary-dead). An
// "all events" rule still received them at whatever minSeverity it set (events:"all" on the wire is not
// enumerated), so the gap was in PER-EVENT targeting only, not blanket delivery -- but a targeted rule
// like "route dual-control-disabled to the security team's PagerDuty, everything else to Slack" simply
// could not be built. Severity is fixed per event (the engine's severityOf, notify-routing.ts) and mirrored
// in NOTIFY_EVENTS (screens/notifications/shared.ts) alongside each event's label: backup-failure,
// restore-test-fail, recovery-code-abuse, canary-dead, update-rollback-needed = critical; backup-stale,
// source-detached, backup-volume-regression, credential-expiry, recovery-code-used, dual-control-disabled,
// update-available, auth-credential-change, dest-change, sign-in-new-context, replication-degraded,
// run-at-risk-eviction, posture-regression(default) = warning; backup-success, restore-test-pass,
// restore-applied, role-change, canary-recovered = info.
//
// replication-degraded fires when the proven contiguous-copy count fell below the configured copy
// count (warning). run-at-risk-eviction fires when a run is about to age out of the run ring while a
// replica still lacks it (warning; the engine may carry it at critical when copies would drop to one,
// and the history panel renders the wire severity each delivery actually carried).
export type NotifyEvent =
  | "backup-success" | "backup-failure" | "backup-stale"
  | "backup-volume-regression" | "source-detached"
  | "restore-test-pass" | "restore-test-fail" | "restore-applied"
  | "credential-expiry" | "posture-regression" | "role-change" | "auth-credential-change" | "dest-change"
  | "sign-in-new-context" | "recovery-code-used" | "recovery-code-abuse"
  | "canary-dead" | "canary-recovered" | "dual-control-disabled"
  | "update-available" | "update-rollback-needed"
  | "replication-degraded" | "run-at-risk-eviction";

// Severity is the deliver-at-or-above threshold a rule sets and an event carries.
export type Severity = "info" | "warning" | "critical";

// NotifyScope is a rule's scope: global, or pinned to one downpipe (a per-downpipe rule overrides
// the global default for the same event class). A discriminated union so the console renders the
// two cleanly.
export type NotifyScope = { kind: "global" } | { kind: "downpipe"; downpipeId: string };

// NotifyRule routes events to channels. minSeverity delivers events at or above it; events selects
// which events (a closed list, or "all"); channelIds names the delivery channels; digest batches
// success-class events (default off). id is the storage key notify-rule:${id}. digest is optional
// and present only when set (exactOptionalPropertyTypes).
export interface NotifyRule {
  id: string;
  scope: NotifyScope;
  minSeverity: Severity;
  events: NotifyEvent[] | "all";
  channelIds: string[];
  digest?: "off" | "daily" | "weekly";
  enabled: boolean;
}

// NotifyRuleInput is the POST /admin/notify/rules body: a rule WITHOUT the server-assigned id for a
// create, or WITH an existing id to update. The engine assigns/validates the id and rejects a rule
// that names an unknown channel or selects nothing with a 400 { error }.
export interface NotifyRuleInput {
  id?: string;
  scope: NotifyScope;
  minSeverity: Severity;
  events: NotifyEvent[] | "all";
  channelIds: string[];
  digest?: "off" | "daily" | "weekly";
  enabled: boolean;
}

// NotifyHistoryEntry is one row of the capped delivery-history ring (cap 1000; storage key
// notify-history:${padded(seq)}). detail is a redaction-safe one-liner (downpipe name + state,
// never a secret); the console escapes it on render. downpipeId is null for a global event.
export interface NotifyHistoryEntry {
  seq: number;
  ts: string;
  event: NotifyEvent;
  severity: Severity;
  downpipeId: string | null;
  channelId: string;
  channelKind: ChannelKind;
  delivered: boolean;
  detail: string;
  // A manual channel test-send (POST /notify/test): the engine records it on the ring flagged
  // test:true so a verification leaves a durable trace; it is never a routed engine event.
  test?: true;
}
