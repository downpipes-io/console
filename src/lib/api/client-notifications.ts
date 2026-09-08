// Notifications domain functions for the EngineClient: channels, rules, history, test. Free functions
// over the shared Transport.
//
// The notification surface is the customer's own config and outcome history in their own account; no vendor
// read. Reads (channels/rules/history) are any authenticated role; the writes (POST channels/rules, their
// deletes, and test-send) are gated by the notify.config capability SERVER-SIDE (the engine is the control;
// the console mirrors the gate with can(role, "notify.config")). The engine validates a channel per kind
// (https url, no userinfo, not workers.dev; a pagerduty routing key; validated email addresses); a bad
// channel comes back as a 400 { error } the console surfaces inline. No secret transits: a channel carries
// the customer's own url / routing key / addresses (their config), never a key or value.

import { probeCallOutcome, recordProbeOutcome } from "../client-diag/ring.ts";
import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type {
  MutationResult,
  NotifyChannel,
  NotifyChannelInput,
  NotifyHistoryEntry,
  NotifyRule,
  NotifyRuleInput,
} from "./types.ts";

// listNotifyChannels returns every configured channel (any authenticated role).
export async function listNotifyChannels(t: Transport): Promise<NotifyChannel[]> {
  const r = await engineFetch(`${t.base}/admin/notify/channels`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<NotifyChannel[]>(r, "list notify channels");
}

// upsertNotifyChannel creates or updates a channel. The engine validates per kind and assigns the
// id/createdAt; a 400 { error } on a malformed channel is surfaced inline. Gated by notify.config.
export async function upsertNotifyChannel(t: Transport, channel: NotifyChannelInput): Promise<MutationResult<NotifyChannel>> {
  // STEP-UP GATED: routed through gatedFetch so an engine 401 { stepUpRequired } runs the re-auth
  // ceremony and retries once. These four govern the AVAILABILITY OF EVIDENCE: silencing an account by
  // deleting or narrowing the rule that carries a critical alert is a stale-ambient-cookie action with no
  // visible effect and no undo, which is why the engine gates BOTH directions, set as well as delete.
  const r = await t.gatedFetch("/admin/notify/channels", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(channel) }, { adminOp: "notify-channel-upsert" });
  return t.parseJsonOrPending<NotifyChannel>(r, "save notify channel");
}

// deleteNotifyChannel removes a channel by id (POST-to-delete, consistent with the other deletes). It is
// change-control gated server-side (notify-channel-delete), so when four-eyes is armed the engine QUEUES the
// deletion and answers 202 having deleted NOTHING. Read through parseJsonOrPending (the sibling
// deleteRole/deleteGroupRole/deleteCustomRole pattern) so that 202 resolves to a MutationResult
// { status: "pending" } the screen surfaces honestly, never a plain-parsed body the caller reads as "deleted".
export async function deleteNotifyChannel(t: Transport, id: string): Promise<MutationResult<{ deleted: boolean }>> {
  // STEP-UP GATED (STEPUP_SUBS): routed through
  // gatedFetch so an engine 401 { stepUpRequired } runs the re-auth ceremony and retries once. On plain
  // engineFetch that 401 reached the SCREEN instead, so the save failed closed with a visible error and no
  // ceremony ever ran. These four govern the AVAILABILITY OF EVIDENCE: silencing an account by deleting or
  // narrowing the rule that carries a critical alert is a stale-ambient-cookie action with no visible
  // effect and no undo, which is why the engine gates BOTH directions, set as well as delete.
  const r = await t.gatedFetch("/admin/notify/channels/delete", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ id }) }, { adminOp: "notify-channel-delete" });
  return t.parseJsonOrPending<{ deleted: boolean }>(r, "delete notify channel");
}

// listNotifyRules returns every routing rule, global and per-downpipe (any authenticated role).
export async function listNotifyRules(t: Transport): Promise<NotifyRule[]> {
  const r = await engineFetch(`${t.base}/admin/notify/rules`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<NotifyRule[]>(r, "list notify rules");
}

// upsertNotifyRule creates or updates a routing rule. The engine assigns/validates the id; a bad
// rule (unknown channel, empty selection) is a 400 { error }. Gated by notify.config.
export async function upsertNotifyRule(t: Transport, rule: NotifyRuleInput): Promise<MutationResult<NotifyRule>> {
  // STEP-UP GATED (STEPUP_SUBS): routed through
  // gatedFetch so an engine 401 { stepUpRequired } runs the re-auth ceremony and retries once. On plain
  // engineFetch that 401 reached the SCREEN instead, so the save failed closed with a visible error and no
  // ceremony ever ran. These four govern the AVAILABILITY OF EVIDENCE: silencing an account by deleting or
  // narrowing the rule that carries a critical alert is a stale-ambient-cookie action with no visible
  // effect and no undo, which is why the engine gates BOTH directions, set as well as delete.
  const r = await t.gatedFetch("/admin/notify/rules", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify(rule) }, { adminOp: "notify-rule-upsert" });
  return t.parseJsonOrPending<NotifyRule>(r, "save notify rule");
}

// deleteNotifyRule removes a rule by id. Change-control gated server-side (notify-rule-delete), so a queued
// 202 deletes nothing: read through parseJsonOrPending so the caller surfaces the pending state honestly
// rather than reading the 202 as a false "deleted" (the deleteNotifyChannel sibling).
export async function deleteNotifyRule(t: Transport, id: string): Promise<MutationResult<{ deleted: boolean }>> {
  // STEP-UP GATED (STEPUP_SUBS): routed through
  // gatedFetch so an engine 401 { stepUpRequired } runs the re-auth ceremony and retries once. On plain
  // engineFetch that 401 reached the SCREEN instead, so the save failed closed with a visible error and no
  // ceremony ever ran. These four govern the AVAILABILITY OF EVIDENCE: silencing an account by deleting or
  // narrowing the rule that carries a critical alert is a stale-ambient-cookie action with no visible
  // effect and no undo, which is why the engine gates BOTH directions, set as well as delete.
  const r = await t.gatedFetch("/admin/notify/rules/delete", { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ id }) }, { adminOp: "notify-rule-delete" });
  return t.parseJsonOrPending<{ deleted: boolean }>(r, "delete notify rule");
}

// listNotifyHistory returns the capped delivery-history ring, newest-first (any authenticated
// role). Each entry is a redaction-safe one-liner (downpipe name + state, never a secret); the
// console escapes the detail on render.
export async function listNotifyHistory(t: Transport): Promise<NotifyHistoryEntry[]> {
  const r = await engineFetch(`${t.base}/admin/notify/history`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<NotifyHistoryEntry[]>(r, "notify history");
}

// testNotifyChannel sends a redaction-safe test notification to one channel so the operator can
// confirm delivery. Fail-open delivery is the engine's concern; this just reports { ok }. Gated by
// notify.config (a test send is a write-class action). The body carries only the channel id.
export async function testNotifyChannel(t: Transport, channelId: string): Promise<{ ok: boolean }> {
  // The engine answers { ok } and nothing else here, so the row is honest about how little it can say: a
  // delivery that failed, or a probe that never ran. That is still strictly more than the pack carried before,
  // which was nothing at all, and it is enough to tell an operator whose channel test has never once passed from
  // one whose test passes and whose real alerts are being dropped downstream (which the notify history answers).
  // The channel id is never recorded: it is the operator's own label for a webhook.
  try {
    const r = await engineFetch(`${t.base}/admin/notify/test`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ channelId }) });
    const res = await t.parseJson<{ ok: boolean }>(r, "test notify channel");
    recordProbeOutcome("notify-test", res.ok ? "ok" : "notify-delivery-failed");
    return res;
  } catch (e) {
    recordProbeOutcome("notify-test", probeCallOutcome(e));
    throw e;
  }
}
