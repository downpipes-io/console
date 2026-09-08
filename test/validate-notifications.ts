// Validate the pure, no-custody-critical logic of the Notifications screen
// (src/screens/notifications.ts), section 2 + section 9.
// Run with: node test/validate-notifications.ts
//
// The screen is DOM-heavy, but its load-bearing logic is extracted into pure functions
// that take plain values (not DOM fields), so they are unit-testable without a DOM, the
// same seam pattern the data-table / modal validators use. None of the imported modules
// execute DOM at import time, so importing the screen in Node succeeds.
//
// Coverage:
//   buildChannelInputFrom (the per-kind discriminated-field construction; NO-CUSTODY):
//     - a webhook/slack/teams-connector channel carries url and NOTHING else
//     - a pagerduty channel carries routingKey and NOTHING else
//     - an email channel carries toAddresses (parsed) and NOTHING else
//     - a teams channel in email mode carries toAddresses, not url
//     - exactly ONE discriminated field is ever present (never two)
//     - id is present only when editing (exactOptionalPropertyTypes parity)
//   buildRuleInputFrom (the rule selection rules + wire shape):
//     - rejects an empty channel selection
//     - rejects an empty event selection when mode is "selected"
//     - "all" events mode yields events:"all" with no event checklist
//     - digest is present only when not "off"
//     - a per-downpipe scope carries the downpipeId; global carries none
//     - id present only when editing
//   validateUrl (mirror of the engine's channel-url rule):
//     - rejects non-https, embedded credentials, and workers.dev hosts; accepts a clean https URL
//   validateAddresses / parseAddresses:
//     - parses a comma list; rejects an empty or malformed list
//   the severity mapping (NOTIFY_EVENTS) matches the contract's fixed mapping
//   severityRank orders info < warning < critical

import {
  buildChannelInputFrom,
  buildRuleInputFrom,
  validateUrl,
  validateAddresses,
  parseAddresses,
  severityRank,
  eventLabel,
  NOTIFY_EVENTS,
  CHANNEL_KINDS,
  type RuleFormValues,
} from "../src/screens/notifications.ts";
import type { ChannelKind, DownpipeState, NotifyChannel, NotifyChannelInput, NotifyEvent, NotifyRule, NotifyScope, Severity } from "../src/api.ts";
import { ruleDeliversNowhere } from "../src/screens/notifications/rules.ts";
import { downpipeScopeIsMissing } from "../src/screens/notifications/shared.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { engineRoots } from "./engine-path.ts";

const HERE = new URL(".", import.meta.url).pathname;

// ---------------------------------------------------------------------------------------------------
// THE OTHER SIDE, read at run time.
//
// This block replaces `ok("NOTIFY_EVENTS covers all 23 events", NOTIFY_EVENTS.length === 23)`, which was
// the console's own list counted against a literal. It could only ever fail if the CONSOLE changed, never
// if the engine did, which is the opposite of what a coverage claim about the engine's vocabulary means.
// The audit-mirror count in this same directory demonstrated where that ends: its literal had already
// been raised from 83 to 86 by the fix that first caught it, went stale again inside a day, and passed
// green while a real cross-repo gate was red on the same vocabulary at the same moment.
//
// scripts/mirror-drift-gate.mjs does read the engine for this vocabulary, so this file was covered in
// practice. That is an argument for the gate, not for a check here that states a number it cannot verify:
// a reader of this file has no way to know the coverage claim is load-bearing somewhere else, and the
// line reads exactly like the audit-mirror one that was not.
// ---------------------------------------------------------------------------------------------------
const ENGINE_NOTIFY_TYPES = "src/notify/types.ts";

function readEngineNotifyEvents(): string[] | null {
  const p = engineRoots(HERE).map((r) => resolve(r, ENGINE_NOTIFY_TYPES)).find((f) => existsSync(f));
  if (p === undefined) return null;
  const src = readFileSync(p, "utf8");
  const start = src.indexOf("export const NOTIFY_EVENT_NAMES = [");
  const end = start === -1 ? -1 : src.indexOf("]", start);
  if (start === -1 || end === -1) {
    console.log(`  FAIL the engine's NOTIFY_EVENT_NAMES anchor has moved, so the coverage claim is comparing nothing (${p})`);
    // The verdict is DECLARED before the exit: without it the completion guard prints on top of this
    // deliberate finding, and the canonical VERDICT line a log reader greps for never appears at all.
    // The exit code is unchanged.
    process.exitCode = 1;
    process.exit(1);
  }
  return [...src.slice(start, end).matchAll(/^\s*"([a-z0-9-]+)",/gm)].map((m) => m[1] as string);
}

const engineEvents = readEngineNotifyEvents();
if (engineEvents === null) {
  // CANNOT CHECK rather than SKIP, one greppable line, matching validate-audit-mirror.ts. The exit code
  // stays 0 on a console-only clone, which legitimately has no engine; the line is what tells a reader of a
  // green log that the NOTIFY_EVENT_NAMES comparison answered nothing rather than answered yes.
  //
  // THE REQUIRE ARM BELOW HAD NEVER FIRED. Until this file joined validate:workspace:chain no job ran it
  // with REQUIRE_ENGINE set, so it was unreachable everywhere, and it exited 1, which reads as a defect in
  // the console rather than as a comparison that did not happen. Exit 2 is the could-not-check.
  console.log("CANNOT CHECK validate-notifications: no engine checkout reachable, so the NOTIFY_EVENT_NAMES comparison did not run");
  if (process.env.REQUIRE_ENGINE === "1") {
    console.error("validate-notifications: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable.\n" +
        "  The event coverage claim is graded against the engine's own NOTIFY_EVENT_NAMES, so with no engine\n" +
        "  this file cannot answer its question and will not report that it did.\n" +
        "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.",); process.exit(2);
  }
}

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq<T>(label: string, got: T, want: T): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// keysOf returns the channel input's discriminated keys present (url/routingKey/toAddresses).
function discriminatedKeys(input: NotifyChannelInput): string[] {
  // Spread into a record rather than cast to one. NotifyChannelInput is a discriminated union, so the
  // direct conversion is refused, and spreading keeps the test exactly as it was: a key present but
  // undefined still does not count, which `k in input` would have got wrong.
  const rec: Record<string, unknown> = { ...input };
  return ["url", "routingKey", "toAddresses"].filter((k) => rec[k] !== undefined);
}

// ---------------------------------------------------------------------------
// buildChannelInputFrom: exactly one discriminated field per kind (no-custody).
// ---------------------------------------------------------------------------
console.log("\n-- buildChannelInputFrom: per-kind discriminated field --");

{
  const webhook = buildChannelInputFrom(null, "SRE webhook", "webhook", "connector", "https://hooks.example.com/x", true);
  eq("webhook carries url", webhook.url, "https://hooks.example.com/x");
  eq("webhook discriminated keys = [url]", discriminatedKeys(webhook), ["url"]);
  ok("webhook has no routingKey", webhook.routingKey === undefined);
  ok("webhook has no toAddresses", webhook.toAddresses === undefined);
  ok("create has no id", webhook.id === undefined);
  eq("webhook kind/name/enabled", [webhook.kind, webhook.name, webhook.enabled], ["webhook", "SRE webhook", true]);
}

{
  const slack = buildChannelInputFrom(null, "Slack", "slack", "connector", "https://hooks.slack.com/y", true);
  eq("slack discriminated keys = [url]", discriminatedKeys(slack), ["url"]);
}

{
  const pd = buildChannelInputFrom(null, "On-call", "pagerduty", "connector", "ROUTINGKEY123", true);
  eq("pagerduty carries routingKey", pd.routingKey, "ROUTINGKEY123");
  eq("pagerduty discriminated keys = [routingKey]", discriminatedKeys(pd), ["routingKey"]);
  ok("pagerduty has no url", pd.url === undefined);
}

{
  const email = buildChannelInputFrom(null, "Inbox", "email", "connector", "a@example.com, b@example.com", true);
  eq("email carries parsed toAddresses", email.toAddresses, ["a@example.com", "b@example.com"]);
  eq("email discriminated keys = [toAddresses]", discriminatedKeys(email), ["toAddresses"]);
  ok("email has no url", email.url === undefined);
}

{
  const teamsConnector = buildChannelInputFrom(null, "Teams", "teams", "connector", "https://outlook.office.com/webhook/z", true);
  eq("teams connector carries url", discriminatedKeys(teamsConnector), ["url"]);
  const teamsEmail = buildChannelInputFrom(null, "Teams email", "teams", "email", "channel@example.com", true);
  eq("teams email-mode carries toAddresses, not url", discriminatedKeys(teamsEmail), ["toAddresses"]);
}

{
  // Editing: id present; still exactly one discriminated field.
  const edited = buildChannelInputFrom("ch_123", "Edited", "webhook", "connector", "https://h.example.com/e", false);
  eq("edit carries id", edited.id, "ch_123");
  eq("edit still one discriminated key", discriminatedKeys(edited), ["url"]);
  eq("edit enabled=false respected", edited.enabled, false);
}

// Exhaustive: every kind yields exactly one discriminated field (never two, the no-custody
// invariant that a channel cannot smuggle a second destination). jsm/servicenow also carry url as
// their discriminated field (their apiKey/username are ADDITIONAL, checked separately below).
console.log("\n-- buildChannelInputFrom: never two discriminated fields --");
for (const kind of ["webhook", "slack", "teams", "pagerduty", "email", "jsm", "servicenow"] as const) {
  const v = kind === "pagerduty" ? "key" : kind === "email" ? "x@example.com" : "https://x.example.com/h";
  const input = buildChannelInputFrom(null, kind, kind, "connector", v, true);
  ok(`${kind}: exactly one discriminated field`, discriminatedKeys(input).length === 1);
}

// ---------------------------------------------------------------------------
// buildChannelInputFrom: jsm/servicenow (monitoring integrations, PLAN.md). Both carry
// url as their PRIMARY (discriminated) field, exactly like webhook/slack; apiKey/username are
// ADDITIONAL, orthogonal parameters. apiKey is WRITE-ONLY (KEEP-SECRET on edit: blank/omitted never
// rides on the wire); servicenow's username is NOT a secret and is always carried when supplied.
// ---------------------------------------------------------------------------
console.log("\n-- buildChannelInputFrom: jsm/servicenow credential fields --");

{
  const jsm = buildChannelInputFrom(null, "On-call (JSM)", "jsm", "connector", "https://api.opsgenie.com/v2/alerts", true, "genie-token-abc");
  eq("jsm carries url", jsm.url, "https://api.opsgenie.com/v2/alerts");
  eq("jsm carries the typed apiKey", jsm.apiKey, "genie-token-abc");
  ok("jsm has no routingKey", jsm.routingKey === undefined);
  ok("jsm has no toAddresses", jsm.toAddresses === undefined);
  ok("jsm has no username (jsm-only, not a servicenow channel)", jsm.username === undefined);
}
{
  // KEEP-SECRET: an omitted/blank apiKey on an edit never rides on the wire (the engine splices in
  // the prior sealed value, but ONLY when the url/kind are unchanged; the console never guesses).
  const jsmEdit = buildChannelInputFrom("ch_1", "On-call (JSM)", "jsm", "connector", "https://api.opsgenie.com/v2/alerts", true, "");
  ok("jsm edit with a blank apiKey OMITS it from the wire (keep-secret)", jsmEdit.apiKey === undefined);
  const jsmEditWhitespace = buildChannelInputFrom("ch_1", "On-call (JSM)", "jsm", "connector", "https://api.opsgenie.com/v2/alerts", true, "   ");
  ok("jsm edit with a whitespace-only apiKey ALSO omits it (never stored as a literal blank/whitespace secret)", jsmEditWhitespace.apiKey === undefined);
  const jsmEditUndefined = buildChannelInputFrom("ch_1", "On-call (JSM)", "jsm", "connector", "https://api.opsgenie.com/v2/alerts", true);
  ok("jsm edit with apiKey entirely omitted (no argument) also keeps the secret", jsmEditUndefined.apiKey === undefined);
}
{
  const sn = buildChannelInputFrom(null, "ServiceNow", "servicenow", "connector", "https://acme.service-now.com/api/now/table/em_event", true, "basic-pass-xyz", "downpipes-integration");
  eq("servicenow carries url", sn.url, "https://acme.service-now.com/api/now/table/em_event");
  eq("servicenow carries the typed username (trimmed)", sn.username, "downpipes-integration");
  eq("servicenow carries the typed apiKey", sn.apiKey, "basic-pass-xyz");
  ok("servicenow has no routingKey", sn.routingKey === undefined);
  ok("servicenow has no toAddresses", sn.toAddresses === undefined);
}
{
  // A username change alone (apiKey blank) keeps the password: username is NOT part of the
  // keep-secret decision, it is always resupplied like url.
  const snUserOnly = buildChannelInputFrom("ch_2", "ServiceNow", "servicenow", "connector", "https://acme.service-now.com/api/now/table/em_event", true, "", "renamed-integration-account");
  ok("servicenow edit with a blank apiKey omits it (keep-secret)", snUserOnly.apiKey === undefined);
  eq("servicenow edit still carries the (possibly changed) username", snUserOnly.username, "renamed-integration-account");
}
{
  // username is trimmed even when apiKey rides too.
  const sn = buildChannelInputFrom(null, "ServiceNow", "servicenow", "connector", "https://acme.service-now.com/api/now/table/em_event", true, "pw", "  spaced-out  ");
  eq("servicenow trims the username", sn.username, "spaced-out");
}

// CHANNEL_KINDS: jsm and servicenow are offered in the kind selector, each with a distinct,
// non-empty label (mirroring push-model.ts's "every format has a DISTINCT label" discipline).
console.log("\n-- CHANNEL_KINDS: jsm/servicenow are offered, each with a distinct label --");
{
  const jsmDef = CHANNEL_KINDS.find((k) => k.kind === "jsm");
  const snDef = CHANNEL_KINDS.find((k) => k.kind === "servicenow");
  ok("jsm is offered in the kind selector", jsmDef !== undefined);
  ok("servicenow is offered in the kind selector", snDef !== undefined);
  ok("jsm has a non-empty label", (jsmDef?.label.length ?? 0) > 0);
  ok("servicenow has a non-empty label", (snDef?.label.length ?? 0) > 0);
  eq("every CHANNEL_KINDS entry has a DISTINCT label", new Set(CHANNEL_KINDS.map((k) => k.label)).size, CHANNEL_KINDS.length);
  const allKinds: ChannelKind[] = ["email", "webhook", "slack", "pagerduty", "teams", "jsm", "servicenow"];
  eq(
    "CHANNEL_KINDS covers exactly the closed ChannelKind set",
    CHANNEL_KINDS.map((k) => k.kind).sort(),
    [...allKinds].sort(),
  );
}

// ---------------------------------------------------------------------------
// buildRuleInputFrom: selection rules + wire shape.
// ---------------------------------------------------------------------------
console.log("\n-- buildRuleInputFrom: selection rules --");

function ruleValues(over: Partial<RuleFormValues>): RuleFormValues {
  return {
    existingId: null,
    scopeKind: "global",
    downpipeId: "",
    minSeverity: "warning",
    eventsMode: "all",
    selectedEvents: [],
    channelIds: ["ch1"],
    digest: "off",
    enabled: true,
    ...over,
  };
}

{
  const r = buildRuleInputFrom(ruleValues({ channelIds: [] }));
  ok("empty channel selection -> error", "error" in r);
}

{
  const r = buildRuleInputFrom(ruleValues({ eventsMode: "selected", selectedEvents: [] }));
  ok("empty event selection (selected mode) -> error", "error" in r);
}

{
  const r = buildRuleInputFrom(ruleValues({ eventsMode: "all" }));
  ok("all-events mode -> input", "input" in r);
  if ("input" in r) eq("all-events yields events:'all'", r.input.events, "all");
}

{
  const r = buildRuleInputFrom(ruleValues({ eventsMode: "selected", selectedEvents: ["backup-failure", "backup-stale"] as NotifyEvent[] }));
  ok("selected events -> input", "input" in r);
  if ("input" in r) eq("selected events carried through", r.input.events, ["backup-failure", "backup-stale"]);
}

{
  const off = buildRuleInputFrom(ruleValues({ digest: "off" }));
  ok("digest 'off' -> input", "input" in off);
  if ("input" in off) ok("digest 'off' is OMITTED from the wire (exactOptional)", off.input.digest === undefined);
  const daily = buildRuleInputFrom(ruleValues({ digest: "daily" }));
  if ("input" in daily) eq("digest 'daily' is present", daily.input.digest, "daily");
}

{
  const global = buildRuleInputFrom(ruleValues({ scopeKind: "global" }));
  if ("input" in global) eq("global scope shape", global.input.scope, { kind: "global" });
  const dp = buildRuleInputFrom(ruleValues({ scopeKind: "downpipe", downpipeId: "dp_99" }));
  if ("input" in dp) eq("downpipe scope carries id", dp.input.scope, { kind: "downpipe", downpipeId: "dp_99" });
}

{
  const create = buildRuleInputFrom(ruleValues({}));
  if ("input" in create) ok("create rule has no id", create.input.id === undefined);
  const edit = buildRuleInputFrom(ruleValues({ existingId: "rule_1" }));
  if ("input" in edit) eq("edit rule carries id", edit.input.id, "rule_1");
}

// ---------------------------------------------------------------------------
// validateUrl: the engine's channel-url rule mirror (no-custody / house rule).
// ---------------------------------------------------------------------------
console.log("\n-- validateUrl --");

ok("clean https URL passes", validateUrl("https://hooks.example.com/abc") === null);
ok("http URL rejected", validateUrl("http://hooks.example.com/abc") !== null);
ok("URL with embedded credentials rejected", validateUrl("https://user:pass@hooks.example.com/abc") !== null);
ok("workers.dev host rejected", validateUrl("https://thing.workers.dev/abc") !== null);
ok("bare workers.dev rejected", validateUrl("https://workers.dev/abc") !== null);
ok("garbage URL rejected", validateUrl("not a url") !== null);
ok("empty URL rejected", validateUrl("") !== null);
// Negative control: a custom-domain https URL with a path is fine.
ok("custom-domain https with path passes", validateUrl("https://alerts.acme.example/v1/hook?token=x") === null);

// ---------------------------------------------------------------------------
// validateAddresses / parseAddresses.
// ---------------------------------------------------------------------------
console.log("\n-- validateAddresses / parseAddresses --");

eq("parseAddresses splits + trims", parseAddresses(" a@x.com ,b@y.com,  "), ["a@x.com", "b@y.com"]);
eq("parseAddresses empty -> []", parseAddresses("   "), []);
ok("one valid address passes", validateAddresses("a@example.com") === null);
ok("empty address list rejected", validateAddresses("") !== null);
ok("malformed address rejected", validateAddresses("a@example.com, notanemail") !== null);
// Mirror the engine's isCustomDomainAddress so the form rejects what the engine would refuse on submit.
ok("bare-domain address rejected (no dot)", validateAddresses("a@b") !== null);
ok("workers.dev address rejected", validateAddresses("ops@team.workers.dev") !== null);
ok("address with a space rejected", validateAddresses("ops @example.com") !== null);
ok("two valid custom-domain addresses pass", validateAddresses("ops@example.com, sales@example.com") === null);

// ---------------------------------------------------------------------------
// The fixed severity mapping (contract section 2.1) + severityRank.
// ---------------------------------------------------------------------------
console.log("\n-- severity mapping (contract) --");

// Mirrors the engine's severityOf (notify-routing.ts) exactly.
const EXPECTED_SEVERITY: Record<NotifyEvent, Severity> = {
  "backup-failure": "critical",
  "restore-test-fail": "critical",
  "posture-regression": "critical",
  "recovery-code-abuse": "critical",
  "canary-dead": "critical",
  "update-rollback-needed": "critical",
  "backup-stale": "warning",
  "backup-volume-regression": "warning",
  "source-detached": "warning",
  "credential-expiry": "warning",
  "dest-change": "warning",
  "sign-in-new-context": "warning",
  "recovery-code-used": "warning",
  "dual-control-disabled": "warning",
  "update-available": "warning",
  "auth-credential-change": "warning",
  "backup-success": "info",
  "restore-test-pass": "info",
  "restore-applied": "info",
  "role-change": "info",
  "canary-recovered": "info",
  // The two replication events (engine L1a/L1b). Both carry a base severity of warning; the engine may
  // deliver run-at-risk-eviction at critical when copies would drop to one, and the history panel renders
  // the wire severity each delivery carried (severityBadge(e.severity)), not the catalogue's base.
  "replication-degraded": "warning",
  "run-at-risk-eviction": "warning",
};
for (const def of NOTIFY_EVENTS) {
  eq(`severity of ${def.event}`, def.severity, EXPECTED_SEVERITY[def.event]);
}
// Every NotifyEvent the ENGINE can emit is represented exactly once, compared member by member against
// the engine's own NOTIFY_EVENT_NAMES rather than against a count. Both directions, because a console
// entry for an event the engine cannot emit is a rule picker offering something that will never fire.
ok("NOTIFY_EVENTS has unique events", new Set(NOTIFY_EVENTS.map((e) => e.event)).size === NOTIFY_EVENTS.length);
if (engineEvents !== null) {
  const consoleSet = new Set(NOTIFY_EVENTS.map((e) => e.event as string));
  const engineSet = new Set(engineEvents);
  const missing = engineEvents.filter((e) => !consoleSet.has(e));
  const extra = [...consoleSet].filter((e) => !engineSet.has(e));
  ok(`NOTIFY_EVENTS covers every event the engine emits (engine ${engineSet.size}, console ${consoleSet.size})`, missing.length === 0);
  if (missing.length > 0) console.log(`       missing from the console catalogue: ${missing.join(", ")}`);
  ok("NOTIFY_EVENTS claims no event the engine cannot emit", extra.length === 0);
  if (extra.length > 0) console.log(`       in the console but not in the engine: ${extra.join(", ")}`);
  // A vocabulary read that silently yields nothing reads exactly like a passing comparison.
  ok("the engine's NOTIFY_EVENT_NAMES parsed to a plausible list", engineSet.size >= 15);
}

console.log("\n-- severityRank + eventLabel --");
ok("severityRank: critical > warning > info", severityRank("critical") > severityRank("warning") && severityRank("warning") > severityRank("info"));
ok("eventLabel maps a known event to a human label", eventLabel("backup-failure") === "Backup failure");
ok("eventLabel falls back for an unknown event", typeof eventLabel("made-up-event" as NotifyEvent) === "string");

// ---------------------------------------------------------------------------
// Finding 4 (L1d): the two NEW replication events (engine L1a/L1b) surface end to end in
// the Notifications screen. The history panel renders the wire severity (severityBadge(
// e.severity)) and the event label (eventLabel(e.event)); the rule form draws its event
// picker from NOTIFY_EVENTS. So these assertions prove both events are in the catalogue at
// warning severity, resolve to a clean (not auto-spaced) label, and can be selected in a rule.
// ---------------------------------------------------------------------------
console.log("\n-- Finding 4: replication events render end to end --");

for (const ev of ["replication-degraded", "run-at-risk-eviction"] as const) {
  const def = NOTIFY_EVENTS.find((e) => e.event === ev);
  ok(`${ev} is in NOTIFY_EVENTS (rule picker offers it)`, def !== undefined);
  if (def) eq(`${ev} base severity is warning`, def.severity, "warning");
  // The history label cell uses eventLabel; a catalogue entry yields a curated label, not the
  // dash-stripped fallback (which would be the lower-case "replication degraded").
  const label = eventLabel(ev);
  ok(`${ev} resolves to a curated label`, label === def?.label && label !== ev.replace(/-/g, " "));
}
eq("replication-degraded label", eventLabel("replication-degraded"), "Replication degraded");
eq("run-at-risk-eviction label", eventLabel("run-at-risk-eviction"), "Run at risk of eviction");

// run-at-risk-eviction carries base severity 'warning' in the catalogue, but the engine elevates the
// wire severity to 'critical' when copies would drop to one. The history panel renders that wire value
// via severityBadge(e.severity), whose tone branch keys off severityRank ordering. severityBadge builds
// an HTMLElement, so it cannot run in this DOM-less node harness; the pure ranking it depends on is
// covered here: 'critical' must outrank the catalogue base 'warning' for the elevated badge to read as
// danger rather than warn.
ok(
  "run-at-risk-eviction elevated to critical outranks its catalogue base 'warning'",
  severityRank("critical") > severityRank("warning"),
);

// A rule can select the two new events (the rule form's buildRuleInputFrom carries them through
// to the wire), proving the operator-facing routing path accepts them.
{
  const r = buildRuleInputFrom(ruleValues({ eventsMode: "selected", selectedEvents: ["replication-degraded", "run-at-risk-eviction"] as NotifyEvent[] }));
  ok("a rule can select the two replication events", "input" in r);
  if ("input" in r) eq("the replication events are carried to the wire", r.input.events, ["replication-degraded", "run-at-risk-eviction"]);
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ruleDeliversNowhere: an enabled rule that can reach NO channel.
//
// This is the state a channel deletion leaves behind. Deleting a channel removes the channel and does NOT
// prune it from the rules that named it, and at delivery an id with no channel behind it is silently dropped.
// So a rule can arrive here without anyone editing it: still enabled, still matching its events, delivering to
// nobody, and reading "on" in the table. That is the same shape as the canary's dangling destination pins, and
// the fix is the same: say so at the grain of the thing that has stopped working.
// ---------------------------------------------------------------------------
{
  const ch = (id: string, enabled: boolean): NotifyChannel => ({ id, name: id, kind: "webhook", enabled }) as NotifyChannel;
  const rule = (channelIds: string[], enabled = true): NotifyRule =>
    ({ id: "r1", scope: { kind: "global" }, minSeverity: "info", events: "all", channelIds, enabled }) as unknown as NotifyRule;

  const live = ch("live", true);
  const off = ch("off", false);

  // The defect being surfaced: the channel is gone entirely.
  ok("a rule whose only channel was DELETED delivers nowhere", ruleDeliversNowhere(rule(["gone"]), [live]));
  // And the adjacent case: the channel exists but is switched off.
  ok("a rule whose only channel is DISABLED delivers nowhere", ruleDeliversNowhere(rule(["off"]), [off]));
  ok("a rule whose channels are ALL missing or disabled delivers nowhere", ruleDeliversNowhere(rule(["gone", "off"]), [off]));

  // The positive controls, so the flag cannot be true for everything.
  ok("one reachable channel is enough, so it does NOT deliver nowhere", ruleDeliversNowhere(rule(["gone", "live"]), [live, off]) === false);
  ok("a fully healthy rule does NOT deliver nowhere", ruleDeliversNowhere(rule(["live"]), [live]) === false);

  // A DISABLED rule is already reported as off, so flagging it here would be a second, noisier statement of
  // the same fact.
  ok("a disabled rule is not flagged (it already reads off)", ruleDeliversNowhere(rule(["gone"], false), [live]) === false);

  // A rule naming NO channels is an empty configuration the Channels cell shows directly as "none". It is not
  // delivery that decayed underneath the operator, so it is deliberately excluded.
  ok("a rule with no channels at all is not flagged (the cell says none)", ruleDeliversNowhere(rule([]), [live]) === false);

  // Reachability is per-id, not a count: two ids where only the DISABLED one exists must still flag.
  ok("a present-but-disabled channel does not count as reachable", ruleDeliversNowhere(rule(["off", "gone"]), [off, ch("other", true)]));
}

// ---------------------------------------------------------------------------
// downpipeScopeIsMissing: a rule scoped to a DELETED downpipe.
//
// removeDownpipe deletes the downpipe, its history, its replication state, its due key and its alert cooldown,
// and does NOT prune the notify rules scoped to it. So such a rule survives, matches nothing and delivers
// nothing, while rendering as an ordinary downpipe-scoped rule. The rule FORM already said "(no longer
// exists)" for the same id; the table was the one place that did not.
// ---------------------------------------------------------------------------
{
  const dp = (id: string): DownpipeState => ({ config: { id, name: id } }) as unknown as DownpipeState;
  const dpScope = (id: string): NotifyScope => ({ kind: "downpipe", downpipeId: id }) as NotifyScope;

  ok("a rule scoped to a DELETED downpipe is missing", downpipeScopeIsMissing(dpScope("dp-gone"), [dp("dp-live")]));
  ok("a rule scoped to a LIVE downpipe is not", downpipeScopeIsMissing(dpScope("dp-live"), [dp("dp-live")]) === false);
  // With a NON-EMPTY list, so the empty-list guard cannot be what makes this pass. Passing [] here left the
  // assertion satisfied by the wrong guard, and a mutation that dropped the kind check went undetected.
  ok("a GLOBAL rule is never missing, even against a populated list", downpipeScopeIsMissing({ kind: "global" } as NotifyScope, [dp("dp-live")]) === false);
  // The default matters: no list means unknown, not broken.
  ok("an EMPTY downpipe list means unknown, not gone", downpipeScopeIsMissing(dpScope("dp-gone"), []) === false);
  ok("the id is matched exactly, not by prefix", downpipeScopeIsMissing(dpScope("dp"), [dp("dp-live")]));
}

console.log(failures === 0 ? "\nVALIDATE-NOTIFICATIONS VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
