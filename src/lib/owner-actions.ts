// The console mirror of the engine's HIGH-BLAST-RADIUS owner-action dual-control gate (the opt-in
// dual-control policy over the owner operations a single compromised or coerced owner could use to steal
// data or break the system: a destination repoint/add/remove/default, an IdP connection change, the
// discovery-token set, an engine self-deploy, ...). This module is PURE (no DOM): it maps each owner-action
// KIND to a human label, and it encodes the maker != checker mirror (the inbox hides Approve on a caller's
// OWN proposal) and the owner-only approve gate. It is the owner-action analogue of lib/config-changes.ts,
// and like that module it is UX only: the ENGINE is always the enforcement point (the approve/reject routes
// gate on keys.ceremony, the owner-exclusive capability, and the scheduler DO re-resolves OWNER + maker !=
// checker + single-use server-side). These maps only let the console show/hide an Approve button and a label
// so the affordance is never a dead end.
//
// No-custody: nothing here touches a value or a key; an owner action carries an id, a coarse kind, a
// redaction-safe summary, a proposer email and a timestamp only (the engine strips any live secret from the
// listing server-side).

import type { Caller, OwnerAction, OwnerActionKind } from "../api.ts";
import { can, type Role } from "./identity.ts";

// OWNER_ACTION_KIND maps each closed kind to a human label for the inbox card heading. It mirrors the
// engine's OwnerActionKind (engine src/admin/owner-action.ts). An UNKNOWN kind from a newer engine maps to
// undefined and the console falls back to the raw kind string (so an action is never dropped or shown blank;
// it lists with its id + summary and a best-effort label). The labels describe the EFFECT plainly, never the
// mechanism, so an approver reads what they are approving.
export const OWNER_ACTION_KIND: Record<OwnerActionKind, string> = {
  "dest-set": "Set the archive destination",
  "dest-put": "Add or edit an archive destination",
  "dest-remove": "Remove an archive destination",
  "dest-default": "Change the default archive destination",
  "update-apply": "Apply an engine update",
  "update-settle": "Keep a promoted engine update",
  "idp-conn-create": "Add an identity-provider connection",
  "idp-conn-delete": "Remove an identity-provider connection",
  "idp-conn-enabled": "Enable or disable an identity-provider connection",
  "idp-conn-cert": "Roll over an identity-provider SAML signing certificate",
  "break-glass-retire": "Retire the break-glass token",
  "discovery-token-set": "Set the account-browsing token",
  "discovery-accounts-set": "Change which accounts are browsed",
  "sources-attach": "Attach a source binding to the engine",
  "support-credential-mint": "Open a support-bundle pull credential",
  "push-dest-set": "Set the SIEM push destination",
  "otlp-push-dest-set": "Set the OTLP metrics push destination",
  "dual-control-disable": "Turn off dual control",
};

// ownerActionKindLabel returns the human label for an action's kind, falling back to the raw kind string for
// an unknown kind from a newer engine. Never throws.
export function ownerActionKindLabel(kind: string): string {
  return (OWNER_ACTION_KIND as Record<string, string | undefined>)[kind] ?? kind;
}

// isKnownOwnerActionKind reports whether this console build has a label for the kind. It is the
// PREDICATE behind the fallback above, split out so the inbox can RECORD the skew rather than only paper over
// it: an unknown kind means the engine is proposing an operation this console does not know the effect of, and
// it renders as a raw id in a heading that is asking an owner to authorise it. Pure; the unrecognised kind is
// tested by set membership and never returned.
export function isKnownOwnerActionKind(kind: string): boolean {
  return (OWNER_ACTION_KIND as Record<string, string | undefined>)[kind] !== undefined;
}

// callerCanApproveOwnerAction reports whether a caller could approve SOME owner action (so the rail item is
// surfaced for them). Every gated owner op is owner-class, and the engine gates the approve/reject routes on
// keys.ceremony (the owner-exclusive capability a custom role can NEVER hold, it is owner-reserved), so the
// mirror is exactly "the caller holds keys.ceremony". A null caller (whoami pending) cannot yet; the item is
// added once the role resolves. This is the owner-action analogue of callerCanApproveConfigChange. It is a
// PRESENTATION hint only: the inbox stays reachable by deep link / the palette for anyone the engine permits
// to read it (downpipe.read), and the engine enforces the owner-only approve.
export function callerCanApproveOwnerAction(caller: Caller | null): boolean {
  if (!caller) return false;
  return roleCanApproveOwnerAction(caller.role);
}

// roleCanApproveOwnerAction reports whether a built-in role holds keys.ceremony (so it could approve an owner
// action). Pure over can(). Only the owner built-in holds it; every other role returns false. A custom-role
// caller pins the viewer floor and a custom role can never hold the owner-reserved keys.ceremony, so judging
// by role is correct for them too (they return false), matching the engine's owner-only gate.
export function roleCanApproveOwnerAction(role: Role): boolean {
  return can(role, "keys.ceremony");
}

// isMineOwnerAction reports whether an owner action was proposed by the given caller (the maker != checker
// mirror: the console hides Approve on a caller's OWN proposal). It compares the STABLE SUBJECT first (the
// authority axis the engine compares, ASVS V10.3.3), falling back to the display email when a subject is not
// available on either side. A null caller subject AND a null caller email is never "mine" (a token break-glass
// or whoami pending), so a token-path caller is not falsely shown as the proposer of an email-attributed
// action. The engine is authoritative (it refuses a self-approval server-side); this only drives the button.
export function isMineOwnerAction(action: OwnerAction, callerSubject: string | null, callerEmail: string | null): boolean {
  // Subject axis (primary): the maker != checker axis the engine compares.
  if (callerSubject !== null && action.proposedBySubject !== null && action.proposedBySubject === callerSubject) {
    return true;
  }
  // Email floor (belt-and-suspenders): a same-display-email match is also "mine".
  return callerEmail !== null && action.proposedBy === callerEmail;
}
