// The console mirror of the engine's config change-control gate (the opt-in four-eyes / dual-control
// policy over config mutations). This module is PURE (no DOM): it maps each deferrable config-change
// KIND to a human label and the WRITE capability an approver must hold, and it normalises a change's
// plain-English diff to lines for rendering. It is the config-mutation analogue of the restore
// dual-control model, and like that model it is UX only: the ENGINE is always the enforcement point
// (it gates approve on the change's write capability AND maker != checker); these maps only let the
// console show/hide an Approve button and a label so the affordance is never a dead end.
//
// No-custody: nothing here touches a value or a key; a change carries an id, a coarse kind, a
// redaction-safe diff, a proposer email and a timestamp only.

import type { Caller, ConfigChange, ConfigChangeKind, PendingChangeLine } from "../api.ts";
import { can, type Capability, type Role } from "./identity.ts";

// ConfigChangeKindMeta is the per-kind UX metadata: a human label for the inbox card heading, and the
// WRITE capability an approver must hold to approve a change of that kind. The capability is the SAME
// capability the engine gates the approve on (it mirrors SCREEN_WRITE_CAPABILITY / the mutation route's
// own gate), so the console can best-effort hide Approve from a caller who could not approve anyway. The
// engine remains authoritative; this is the client mirror.
export interface ConfigChangeKindMeta {
  label: string;
  // The write capability an approver must hold (the engine enforces this; the console mirrors it to
  // avoid offering a dead Approve button). Every deferrable mutation maps to a real write capability.
  approveCapability: Capability;
}

// CONFIG_CHANGE_KIND maps each closed kind to its label + approve capability, keyed on the engine's OWN
// dash-form literal (the console used to invent its
// own 12-member dot-form union -- "downpipe.save", "notify.webhook" and so on -- that matched nothing the
// wire ever sent, so this map never hit and every pending change fell through changeKindLabel's raw-string
// fallback). Values are taken from the engine's own CHANGE_WRITE_CAPABILITY (admin/change-control.ts),
// which is the map the router's approve gate and the propose-time proposer re-check both read, so this is
// a literal transcription, not a re-derivation: a downpipe upsert/delete needs downpipe.write/
// downpipe.delete, a role change needs roles.write, a group-role or custom-role change needs access.policy
// (NOT roles.write -- the console's old group-role.set entry had this wrong, a second drift beyond the
// naming mismatch), a notify channel/rule set or delete needs notify.config, an expiry item set or delete
// needs expiry.config, a posture accept/unaccept needs posture.riskaccept, a coverage-inventory write needs
// access.policy and a cf-config capture-mode set needs downpipe.write. All 18 engine kinds are covered,
// including the two the console never had at all (coverage-inventory, cf-config-mode-set), and the old
// "notify.webhook" invented kind is gone (the engine has no such kind; a webhook channel is a
// notify-channel-set like any other channel kind).
export const CONFIG_CHANGE_KIND: Record<ConfigChangeKind, ConfigChangeKindMeta> = {
  "downpipe-upsert": { label: "Save a downpipe", approveCapability: "downpipe.write" },
  "downpipe-delete": { label: "Delete a downpipe", approveCapability: "downpipe.delete" },
  "role-set": { label: "Set a member's role", approveCapability: "roles.write" },
  "role-delete": { label: "Remove a member", approveCapability: "roles.write" },
  "group-role-set": { label: "Map an identity-provider group to a role", approveCapability: "access.policy" },
  "group-role-delete": { label: "Remove an identity-provider group role mapping", approveCapability: "access.policy" },
  "custom-role-set": { label: "Save a custom role", approveCapability: "access.policy" },
  "custom-role-delete": { label: "Delete a custom role", approveCapability: "access.policy" },
  "notify-channel-set": { label: "Save a notification channel", approveCapability: "notify.config" },
  "notify-channel-delete": { label: "Delete a notification channel", approveCapability: "notify.config" },
  "notify-rule-set": { label: "Save a notification rule", approveCapability: "notify.config" },
  "notify-rule-delete": { label: "Delete a notification rule", approveCapability: "notify.config" },
  "posture-accept": { label: "Accept a posture risk", approveCapability: "posture.riskaccept" },
  "posture-unaccept": { label: "Withdraw acceptance of a posture risk", approveCapability: "posture.riskaccept" },
  "expiry-item-set": { label: "Save a tracked expiry item", approveCapability: "expiry.config" },
  "expiry-item-delete": { label: "Delete a tracked expiry item", approveCapability: "expiry.config" },
  "coverage-inventory": { label: "Set the coverage inventory", approveCapability: "access.policy" },
  "cf-config-mode-set": { label: "Set a Cloudflare-config downpipe's capture mode", approveCapability: "downpipe.write" },
};

// kindMeta looks up the metadata for a change kind, returning undefined for an unknown kind from a newer
// engine. The cast is needed because CONFIG_CHANGE_KIND is a closed record, while kind arrives as a raw
// string off the wire.
function kindMeta(kind: string): ConfigChangeKindMeta | undefined {
  return (CONFIG_CHANGE_KIND as Record<string, ConfigChangeKindMeta | undefined>)[kind];
}

// changeKindLabel returns the human label for a change's kind, falling back to the raw kind string for an
// unknown kind from a newer engine (so a change is never dropped or shown blank; it lists with its id +
// diff and a best-effort label). Never throws.
export function changeKindLabel(kind: string): string {
  return kindMeta(kind)?.label ?? kind;
}

// changeApproveCapability returns the write capability an approver must hold for a change's kind, or null
// for an unknown kind (where the console cannot mirror the gate and defers entirely to the engine: it
// shows Approve enabled and lets the engine be the authority, never a false client-side block).
export function changeApproveCapability(kind: string): Capability | null {
  return kindMeta(kind)?.approveCapability ?? null;
}

// diffLines normalises a change's diff -- the engine's PendingChangeLine[] (api/types/config-changes.ts,
// mirroring engine admin/change-control.ts) -- to a clean array with blank/whitespace-only text lines
// dropped and each line's text right-trimmed, so the card never renders a blank row. kind/area pass
// through unchanged (the caller uses them for the added/removed/changed label). Defensive at the element
// level because diff arrives off the wire as parsed JSON asserted to this type, not runtime-checked: a
// non-array collapses to no lines, and an element without a string text is skipped, rather than throwing.
// This replaces a historical bug: an earlier version assumed each element was a bare STRING
// and called String.prototype.replace on it directly, which threw "x.replace is not a function" the
// moment a real engine's diff (always an array of { kind, area, text } objects) reached it, so the
// checker's config-approvals inbox crashed and rendered no card at all. Pure; the caller renders text as
// a text node (no markup).
export function diffLines(diff: PendingChangeLine[]): PendingChangeLine[] {
  if (!Array.isArray(diff)) return [];
  const out: PendingChangeLine[] = [];
  for (const line of diff) {
    if (line === null || typeof line !== "object" || typeof line.text !== "string") continue;
    const text = line.text.replace(/\s+$/, "");
    if (text.trim() === "") continue;
    out.push({ kind: line.kind, area: line.area, text });
  }
  return out;
}

// diffKindLabel maps an add/remove/change kind to a short text cue (no colour reliance for the meaning),
// mirroring the config-history screen's own diffKindLabel over the structurally identical ConfigDiffLine.
// Duplicated rather than imported (each screen module is self-owned; see config-changes.ts and
// config-history.ts's own header comments), and kept beside diffLines because both exist purely to render
// a PendingChangeLine / ConfigDiffLine.
export function diffKindLabel(kind: PendingChangeLine["kind"]): string {
  switch (kind) {
    case "added": return "added";
    case "removed": return "removed";
    case "changed": return "changed";
    default: return "change";
  }
}

// CONFIG_WRITE_CAPS is the set of write capabilities ANY of which lets a role approve SOME config change
// (it is the union of the per-kind approve capabilities above). A role holding none of these can never
// approve a deferred config change, so the nav uses it to decide whether to SURFACE the Change requests
// rail item for a caller (a pure viewer, who holds none, does not see it). It is a presentation hint
// only: the inbox stays reachable by deep link / the palette for every authenticated role, and the
// engine gates each approve on the specific change's capability. Kept as the union of CONFIG_CHANGE_KIND
// approve capabilities so it cannot drift from the per-kind map.
export const CONFIG_WRITE_CAPS: readonly Capability[] = [
  "downpipe.write", "downpipe.delete", "roles.write", "access.policy", "notify.config", "expiry.config", "posture.riskaccept",
];

// roleCanApproveConfigChange reports whether a built-in role holds ANY config write capability (so it
// could approve some deferred change). Pure over the role's ROLE_CAPABILITIES via can(). A viewer holds
// none and returns false. Used by callerCanApproveConfigChange + the nav surfacing.
export function roleCanApproveConfigChange(role: Role): boolean {
  return CONFIG_WRITE_CAPS.some((c) => can(role, c));
}

// callerCanApproveConfigChange is the live, caller-aware companion: a null caller (whoami pending) is not
// yet an approver (the rail item is added once the role resolves), and a custom-role caller is judged by
// its RESOLVED capability set (customCapabilities), not the viewer floor it pins, so a custom role that
// holds a config write capability surfaces the item. A built-in caller is judged by its role.
export function callerCanApproveConfigChange(caller: Caller | null): boolean {
  if (!caller) return false;
  if (caller.customCapabilities && caller.customCapabilities.length > 0) {
    const held = new Set<Capability>(caller.customCapabilities);
    return CONFIG_WRITE_CAPS.some((c) => held.has(c));
  }
  return roleCanApproveConfigChange(caller.role);
}

// isMine reports whether a change was proposed by the given caller email (the maker != checker mirror:
// the console hides Approve on a caller's OWN proposal). A null caller email (token break-glass, or
// whoami pending) is never "mine" (the bare-token proposer is not attributable to an email), so a
// token-path caller is not falsely shown as the proposer of an email-attributed change.
export function isMine(change: ConfigChange, callerEmail: string | null): boolean {
  return callerEmail !== null && change.proposedBy !== null && change.proposedBy === callerEmail;
}
