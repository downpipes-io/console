// Shared leaf for the custom role builder: the route constant, the screen and capability catalogues, the
// BuilderState shape, and the pure (DOM-free) composition + guard logic the builder UI is a thin shell over.
// These are the building blocks the form section and the preview section both reach for, so they live in this
// leaf and no section module imports another section module (which would form a cycle): each section imports
// one way from here. The pure pieces (composeProposal / canSetScreenEdit / previewRole / nonHiddenScreens /
// demoteEditsLosingWriteCap and the state seeders) are exercised by the console validator in Node without a
// DOM. Moved verbatim from the roles-builder coordinator for size; behaviour is unchanged.
//
// House style: Australian English, no em dashes, precise claims; the engine is the enforcement point.

import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { caller } from "../../lib/nav.ts";
import { noteGateComputedBlind } from "../../lib/client-diag/identity-gate.ts";
import {
  ALL_CAPABILITIES,
  SCREEN_WRITE_CAPABILITY,
  callerEffectiveCapabilities,
  validateCustomRole,
  builtinPreset,
  titleCaseRole,
  type Capability,
  type SurfaceMode,
  type Presentation,
  type CustomRole,
  type CustomRoleProposal,
  type Role,
} from "../../lib/identity.ts";

export const ROUTE_BUILDER = "/access/roles/builder";

// The six built-in role ids, listed so the presets render in the contract's order.
export const BUILTIN_ROLES: Role[] = ["viewer", "operator", "restore-operator", "approver", "access-admin", "owner"];

// The console SCREENS a surface addresses, in the order the grid renders them, each with a short label
// and a one-line description so an operator composing a role understands what each screen exposes. The
// keys are the engine's SCREEN_WRITE_CAPABILITY keys (the shared contract); a screen with a write side
// can be set to "edit", a read-only screen tops out at "read".
export const SURFACE_SCREENS: Array<{ id: string; label: string; desc: string }> = [
  { id: "downpipes", label: "Downpipes", desc: "Backup routes: list, and (edit) create, edit, delete and trigger." },
  { id: "restore", label: "Restore", desc: "Recovery: dry-run and verify, and (edit) apply a restore over live data." },
  { id: "approvals", label: "Approvals", desc: "The dual-control inbox: review, and (edit) approve or reject a restore." },
  { id: "people", label: "People and roles", desc: "The role table: read, and (edit) grant or revoke roles." },
  { id: "access", label: "Access policy", desc: "Enforcement and group mappings: read, and (edit) change the access policy." },
  { id: "notify", label: "Notifications", desc: "Channels and rules: read, and (edit) configure alerting." },
  { id: "expiry", label: "Credentials and expiry", desc: "The expiry tracker: read, and (edit) add, edit or remove tracked items." },
  { id: "audit", label: "Audit log", desc: "The tamper-evident trail: read-only (the engine is the only writer)." },
  { id: "reports", label: "Reports", desc: "Signed reports: read-only projections." },
  { id: "posture", label: "Security posture", desc: "The posture score and checks: read-only (risk-accept is owner-reserved)." },
];

// screenLabel resolves a screen id to its human SURFACE_SCREENS label, falling back to the raw id for
// an unknown screen. It is the single resolver the preview, the landing picker and the catalogue row
// share, so those three surfaces can never drift on how a landing screen is named.
export function screenLabel(id: string): string {
  const def = SURFACE_SCREENS.find((s) => s.id === id);
  // A landing-screen id this console build does not know renders as the RAW ID in the role builder, so a
  // custom role can be shown as landing on a screen that this console cannot name or route to.
  if (def === undefined) recordContractSkew("unknown-enum-member", "surface-screen");
  return def ? def.label : id;
}

// CAPABILITY_LABELS teaches each capability at first contact: a short human label and a one-line
// description rendered beside the mono id in the matrix, mirroring how SURFACE_SCREENS teaches the
// screens grid. Typed as a complete Record over the closed Capability union so a new capability
// cannot ship untaught (tsc refuses an incomplete map).
export const CAPABILITY_LABELS: Record<Capability, { label: string; desc: string }> = {
  "downpipe.read": { label: "Read downpipes", desc: "See backup routes, their runs and their state." },
  "downpipe.write": { label: "Edit downpipes", desc: "Create and edit backup routes." },
  "downpipe.delete": { label: "Delete downpipes", desc: "Remove a backup route." },
  "run.trigger": { label: "Trigger runs", desc: "Start a backup run now." },
  "drill.run": { label: "Run drills", desc: "Run practice recoveries against a scratch target." },
  "restore.dryrun": { label: "Restore dry-run", desc: "Preview a restore; writes nothing." },
  "restore.verify": { label: "Verify restorability", desc: "Prove a backup can be restored." },
  "restore.request": { label: "Request restores", desc: "Raise a restore for a second approval." },
  "restore.apply": { label: "Apply restores", desc: "Write an approved restore over live data." },
  "restore.approve": { label: "Approve restores", desc: "Be the second sign-off on another's restore." },
  "roles.read": { label: "Read roles", desc: "See the member and role table." },
  "roles.write": { label: "Manage roles", desc: "Grant and revoke member roles." },
  "access.policy": { label: "Manage access policy", desc: "Group mappings, custom roles and the access posture." },
  "keys.ceremony": { label: "Key ceremony", desc: "Run the key ceremony (owner-reserved)." },
  "audit.read": { label: "Read the audit log", desc: "Read, filter and export the audit trail." },
  "notify.config": { label: "Configure notifications", desc: "Channels, rules and webhooks." },
  "expiry.config": { label: "Configure expiry tracking", desc: "Add, edit and remove tracked expiry items." },
  "scheduledtest.config": { label: "Configure scheduled tests", desc: "Schedule automatic restore tests." },
  "reports.read": { label: "Read reports", desc: "Read the signed report projections." },
  "posture.read": { label: "Read posture", desc: "See the security posture score and checks." },
  "posture.riskaccept": { label: "Accept posture risk", desc: "Accept a posture risk (owner-reserved)." },
};

// ---------------------------------------------------------------------------
// Pure composition logic (exported for the console validator; no DOM, no IO). The builder UI is a thin
// shell over these, so the test exercises the SAME composition + guard the screen renders.
// ---------------------------------------------------------------------------

// BuilderState is the in-memory shape the form edits: the name/label, the selected capability set, the
// per-screen surface map, the presentation and the landing screen. It is a plain object so composing a
// proposal and previewing a role are pure functions of it.
export interface BuilderState {
  name: string;
  label: string;
  capabilities: Set<Capability>;
  surface: Map<string, SurfaceMode>;
  presentation: Presentation;
  landing: string;
}

// emptyBuilderState is the resting state of a fresh builder: no name/label, an empty capability set, no
// surface declared (every screen defaults to read at resolution), the technical skin, and the audit
// landing (a universal read floor every role holds, so it is always a safe default landing).
export function emptyBuilderState(): BuilderState {
  return {
    name: "",
    label: "",
    capabilities: new Set<Capability>(),
    surface: new Map<string, SurfaceMode>(),
    presentation: "technical",
    landing: "audit",
  };
}

// stateFromPreset seeds a BuilderState from a built-in role's editable preset, so "start from Operator"
// clones the role's capabilities + derived surface as a tweakable starting point. The name is left
// blank (a custom role must NOT collide with the built-in name), so the operator names their own role.
export function stateFromPreset(role: Role): BuilderState {
  const preset = builtinPreset(role);
  return {
    name: "",
    label: `${titleCaseRole(role)} (custom)`,
    capabilities: new Set<Capability>(preset.capabilities),
    surface: new Map<string, SurfaceMode>(Object.entries(preset.surface)),
    presentation: preset.presentation,
    landing: preset.landing,
  };
}

// ROLE_DRAFT persists an in-progress composed role across a navigation hop / browser-
// back (the navigation design). The serialised form IS composeProposal's output (a
// plain CustomRoleProposal: capabilities as an array, surface as an object), so a
// half-built role survives leaving the builder. Non-sensitive (capability ids + screen
// modes); cleared on a successful save. The engine re-validates everything on save, so
// a tampered draft can at worst produce a preview the engine then rejects.
export const ROLE_DRAFT = "role-builder";

// CustomRoleProposal is deliberately all-unknown (the wire shape the engine validates),
// so both helpers narrow each field defensively rather than trust it.
export function draftHasContent(p: CustomRoleProposal): boolean {
  const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
  const surface = p.surface && typeof p.surface === "object" ? (p.surface as Record<string, unknown>) : {};
  return (
    (typeof p.name === "string" && p.name !== "") ||
    (typeof p.label === "string" && p.label !== "") ||
    caps.length > 0 ||
    Object.keys(surface).length > 0
  );
}

export function stateFromDraft(p: CustomRoleProposal): BuilderState {
  const surface = new Map<string, SurfaceMode>();
  const surfaceObj = p.surface && typeof p.surface === "object" ? (p.surface as Record<string, unknown>) : {};
  for (const [screen, mode] of Object.entries(surfaceObj)) {
    if (mode === "hidden" || mode === "read" || mode === "edit") surface.set(screen, mode);
  }
  const caps: unknown[] = Array.isArray(p.capabilities) ? p.capabilities : [];
  return {
    name: typeof p.name === "string" ? p.name : "",
    label: typeof p.label === "string" ? p.label : "",
    capabilities: new Set<Capability>(ALL_CAPABILITIES.filter((c) => caps.includes(c))),
    surface,
    presentation: p.presentation === "shiny" ? "shiny" : "technical",
    landing: typeof p.landing === "string" && p.landing !== "" ? p.landing : "audit",
  };
}

// composeProposal turns the builder state into the CustomRoleProposal payload the engine's POST
// /admin/custom-roles expects. The surface map is materialised to a plain object; the capability set to
// an array in the canonical ALL_CAPABILITIES order so the payload is stable regardless of click order.
export function composeProposal(state: BuilderState): CustomRoleProposal {
  const surface: Record<string, SurfaceMode> = {};
  for (const [screen, mode] of state.surface) surface[screen] = mode;
  return {
    name: state.name,
    label: state.label,
    capabilities: ALL_CAPABILITIES.filter((c) => state.capabilities.has(c)),
    surface,
    presentation: state.presentation,
    landing: state.landing,
  };
}

// canSetScreenEdit mirrors the engine's edit-requires-write-cap guard for ONE screen + a candidate
// capability set: a screen may be set to "edit" only when it has a write side AND that write capability
// is in the set. It is the single source the grid disables the "edit" option with and the validator
// asserts against, so the console can never offer an "edit" the engine would reject.
export function canSetScreenEdit(screen: string, capabilities: ReadonlySet<Capability>): boolean {
  const writeCap = SCREEN_WRITE_CAPABILITY[screen];
  if (writeCap === null || writeCap === undefined) return false; // no write side: edit is meaningless
  return capabilities.has(writeCap);
}

// previewRole runs the SAME pure validateCustomRole the engine runs, against the CREATOR's own
// effective capability set, so the live preview shows the exact accept/reject verdict (and, on accept,
// the composed CustomRole the engine will store). The creator's capabilities are passed in (resolved
// from the caller) so the no-privilege-escalation guard is mirrored faithfully.
export function previewRole(
  state: BuilderState,
  creatorCapabilities: ReadonlySet<Capability>,
): { ok: true; role: Omit<CustomRole, "createdBy" | "createdAt"> } | { ok: false; reason: string } {
  return validateCustomRole(composeProposal(state), creatorCapabilities);
}

// nonHiddenScreens lists the screens a holder of this role WOULD see (surface mode not "hidden"), for
// the live preview and the landing picker (you cannot land a user on a screen you hid). A screen with
// no declared mode is read (visible), so it is included.
export function nonHiddenScreens(state: BuilderState): string[] {
  return SURFACE_SCREENS.map((s) => s.id).filter((id) => state.surface.get(id) !== "hidden");
}

// demoteEditsLosingWriteCap walks the surface map and demotes any screen set to "edit" whose write
// capability is no longer in the set down to "read", keeping the state self-consistent after a
// capability is unticked. Pure mutation of the passed state.
export function demoteEditsLosingWriteCap(state: BuilderState): void {
  for (const [screen, mode] of state.surface) {
    if (mode === "edit" && !canSetScreenEdit(screen, state.capabilities)) {
      state.surface.set(screen, "read");
    }
  }
}

// creatorCapabilities resolves the current caller's own effective capability set (the basis for the
// no-escalation guard). It uses the same primitive the rest of the console gates on,
// callerEffectiveCapabilities, so a caller on a NAMED custom role resolves to that role's set and a caller
// on a built-in role resolves to ROLE_CAPABILITIES[role]. The builder is access.policy-gated, but that
// gate can be conferred by a custom role (whose role floor is then "viewer"), so reading only the built-in
// set would compute the creator's authority wrongly; this mirrors exactly what the engine recomputes for
// the caller. The bare-token break-glass already carries the owner built-in role.
export function creatorCapabilities(): ReadonlySet<Capability> {
  const c = caller();
  // An EMPTY capability set is this screen's version of the viewer fallback. A null caller does not mean the operator holds
  // nothing; it means the identity has not been resolved yet, and the no-escalation guard is about to be computed against an
  // authority of zero. The witness holds the screen and one row says so if the identity later lands.
  if (!c) {
    noteGateComputedBlind();
    return new Set<Capability>();
  }
  return callerEffectiveCapabilities(c.role, c.customRole ?? null);
}

// errText renders a thrown value as a short, redaction-safe message (no value, no key).
// It now lives in lib/errors.ts; re-exported here so the roles-builder screens keep their local import.
export { errText } from "../../lib/errors.ts";
