// surfacePendingChange is the single, consistent way every config-mutation SCREEN reports that the
// change-control gate QUEUED a change instead of applying it (the engine answered the mutation with a
// 202 + pending body, surfaced by api.ts as a MutationResult { status: "pending" }). Routing it through
// one helper keeps the copy and the affordance identical across the high-traffic mutation screens
// (downpipes save, roles, custom roles, notify, posture, expiry, webhook): a toast that says the change
// is queued for a second approver, with a "View" action that opens the Config approvals inbox. It is
// NEVER a "saved" toast: a queued change has NOT taken effect, so the copy must not imply it has.
//
// It is a thin UI helper (toast + navigate), so it lives in lib next to the nav bridge rather than in a
// screen (no screen-to-screen coupling). No-custody: it carries only the coarse "queued" message and a
// route; never a value or a key.

import { toast } from "../components/toast.ts";
import { navigate } from "./nav.ts";
import { ROUTE_CONFIG_CHANGES } from "../screens/config-changes.ts";
import { ROUTE_OWNER_ACTIONS } from "../screens/owner-actions.ts";

// Queued-change toasts linger longer than a confirmation so the operator notices the queued
// state and the View action (a 7s window).
const PENDING_TOAST_DURATION_MS = 7000;

// surfacePendingChange shows the "queued for approval" toast with a View action. An optional noun
// ("downpipe", "role", "notification rule", ...) tailors the lead so the operator knows WHAT was queued;
// it defaults to the generic "change". The toast tone is "info" (it is not a success: nothing was
// applied), and it does NOT auto-dismiss as fast as a confirmation so the operator notices the queued
// state and the View action (a 7s window).
export function surfacePendingChange(noun = "change"): void {
  toast({
    message: `This ${noun} is queued for approval. A second approver must approve it before it takes effect.`,
    tone: "info",
    durationMs: PENDING_TOAST_DURATION_MS,
    action: { label: "View", onClick: () => navigate(ROUTE_CONFIG_CHANGES) },
  });
}

// surfaceQueuedOwnerAction is the owner-action analogue of surfacePendingChange: every HIGH-BLAST-RADIUS owner
// mutation SCREEN (the destination repoint/add/remove/default, the IdP connection create/delete/enable, the
// discovery-token set) reports through it that the owner-action dual-control gate QUEUED the action instead of
// applying it (the engine answered HTTP 202 + the OwnerActionQueued body, surfaced by api.ts as an
// OwnerActionResult { status: "queued" }). Routing it through one helper keeps the copy and the affordance
// identical: a toast that says the action is queued for a SECOND OWNER, with a "View" action that opens the
// owner-action approval inbox. It is NEVER a success toast: a queued action has NOT taken effect, so the copy
// must not imply the destination was removed / the connection added / the default set.
//
// `verb` is the past-tense thing that did NOT yet happen, framed as the queued intent ("Removing this
// destination", "Adding this connection", "Setting the default destination"); the lead reads "<verb> is
// queued for a second owner to approve." No-custody: it carries only the coarse "queued" message and a route;
// never a value or a key.
export function surfaceQueuedOwnerAction(verb: string): void {
  toast({
    message: `${verb} is queued for a second owner to approve. It does not take effect until they approve it.`,
    tone: "info",
    durationMs: PENDING_TOAST_DURATION_MS,
    action: { label: "View", onClick: () => navigate(ROUTE_OWNER_ACTIONS) },
  });
}
