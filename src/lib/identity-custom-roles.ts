// ---- Composable custom roles (the console mirror of the engine's custom-role model) -----------
// A custom role is an account-defined, NAMED bundle of capabilities the operator composes for their
// own org (e.g. "kv-restorer", "compliance-reader"). It sits ALONGSIDE the six built-ins, never
// replacing them, and is only ever REACHED by an explicit per-email grant or an IdP-group mapping
// that references its NAME. This console module mirrors the engine's src/admin/identity.ts custom-role
// types and guardrails byte-for-byte so the role builder composes a payload the engine will accept,
// and the "what this role will see" preview reflects exactly the authority the engine enforces. The
// engine is ALWAYS the enforcement point; this mirror is UX only and never a control.

import {
  type Capability,
  isCapability,
  isRole,
  type Role,
  ROLE_CAPABILITIES,
} from "./identity-model.ts";

// OWNER_RESERVED_CAPABILITIES are the capabilities that may NEVER be placed into a custom role: the
// key ceremony and accepting a posture risk. They are the owner's alone (only the owner built-in holds
// them), so the builder must hide/disable them and the validator must reject them, mirroring the
// engine's OWNER_RESERVED_CAPABILITIES bar.
export const OWNER_RESERVED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "keys.ceremony",
  "posture.riskaccept",
]);

// Presentation is the cosmetic mode the console renders a custom-role holder's UI in: "technical" is
// the full operator console; "shiny" is the simplified, reassurance-first surface. It is a
// presentation hint ONLY and carries NO authority (the capability set is the sole authority); the
// console reads it to pick a skin, the engine never gates on it.
export type Presentation = "technical" | "shiny";

// SurfaceMode is the per-screen visibility a custom role declares: "hidden" (not shown), "read" (shown
// read-only), or "edit" (shown with its write affordances). It is a CONSOLE hint, not the authority
// boundary: the engine still gates every write on the capability set, so a surface saying "edit"
// without the matching write capability is incoherent and is rejected at create time (see
// validateCustomRole / SCREEN_WRITE_CAPABILITY); a surface MORE restrictive than the capabilities
// (e.g. "read" while the role holds the write cap) is allowed (the console simply hides an affordance
// the engine would have permitted, which is safe).
export type SurfaceMode = "hidden" | "read" | "edit";

// SCREEN_WRITE_CAPABILITY maps each console SCREEN a surface can address to the write Capability an
// "edit" mode on that screen implies. It is the consistency contract behind the edit-requires-write-cap
// guardrail: declaring a screen editable is a promise the role can actually perform that screen's
// writes, so the validator requires the matching capability to be in the role's own set. A screen with
// no write side (a pure read/report screen) maps to null: "edit" is meaningless there and is rejected.
// Mirrored byte-for-byte from the engine's SCREEN_WRITE_CAPABILITY so the two sides cannot drift.
export const SCREEN_WRITE_CAPABILITY: Record<string, Capability | null> = {
  downpipes: "downpipe.write",
  restore: "restore.apply",
  approvals: "restore.approve",
  people: "roles.write",
  access: "access.policy",
  notify: "notify.config",
  expiry: "expiry.config",
  audit: null, // the audit trail is append-only by the engine; there is no console write side
  reports: null, // reports are read-only projections
  posture: null, // posture risk-accept is an owner-reserved cap and cannot be in a custom role
};

// isScreen guards a client-supplied screen name against the known SCREEN_WRITE_CAPABILITY keys.
export function isScreen(v: unknown): v is keyof typeof SCREEN_WRITE_CAPABILITY {
  return typeof v === "string" && Object.hasOwn(SCREEN_WRITE_CAPABILITY, v);
}

// CUSTOM_ROLE_NAME_PATTERN bounds a custom-role NAME so it is a safe storage-key fragment and is
// visually distinct from a built-in role: 1 to 64 chars of lowercase letters, digits and hyphen, not
// starting or ending with a hyphen. A name equal to a built-in is rejected separately. Mirrors the
// engine's pattern exactly.
export const CUSTOM_ROLE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// CustomRole is the stored record (engine DO key `customrole:<name>`), mirrored read-only for the
// console. name is the canonical lowercased key; label is the human display name; capabilities is the
// role's authority set; surface is the per-screen console visibility; presentation is the cosmetic
// skin; landing is the screen the console opens on; createdBy is the verified creator email (null for
// the bare-token break-glass); createdAt is RFC-3339 millis. It carries NO secret and NO key material.
export interface CustomRole {
  name: string;
  label: string;
  capabilities: Capability[];
  surface: Record<string, SurfaceMode>;
  presentation: Presentation;
  landing: string;
  createdBy: string | null;
  createdAt: string;
}

// CustomRoleProposal is the composed payload the role builder POSTs (every field is the operator's own
// input; the engine re-validates and stamps createdBy/createdAt). It mirrors the engine's
// CustomRoleProposal shape so validateCustomRole can run identically on both sides.
export interface CustomRoleProposal {
  name?: unknown;
  label?: unknown;
  capabilities?: unknown;
  surface?: unknown;
  presentation?: unknown;
  landing?: unknown;
}

// validateCustomRole is the PURE guardrail the role builder runs BEFORE it POSTs, mirroring the
// engine's validateCustomRole byte-for-byte so the console previews the exact accept/reject verdict the
// engine will return (and never offers a payload the engine would 400). Given a proposal and the
// CREATOR's own effective capability set, it returns either a fully-formed CustomRole (minus the
// server-stamped createdBy/createdAt) or a precise reason string. The guardrails, in order:
//   1. name: a valid lowercased key that does NOT collide with a built-in role (no shadowing);
//   2. label: a bounded display string;
//   3. capabilities: a non-empty list of KNOWN capabilities, deduped;
//   4. OWNER-RESERVED bar: none of keys.ceremony / posture.riskaccept may appear (owner-only);
//   5. NO PRIVILEGE ESCALATION: every capability MUST be one the creator themselves holds;
//   6. surface: known screens mapped to known modes; EDIT-REQUIRES-WRITE-CAP: a screen set to "edit"
//      requires the screen's write capability to be in the role's OWN set (and the screen must have a
//      write side at all);
//   7. presentation technical|shiny; landing a known screen the surface does not HIDE.
// It NEVER throws (the engine maps a non-ok result to a 400).
export function validateCustomRole(
  proposal: CustomRoleProposal,
  creatorCapabilities: ReadonlySet<Capability>,
): { ok: true; role: Omit<CustomRole, "createdBy" | "createdAt"> } | { ok: false; reason: string } {
  // Each step is a small named sub-validator returning the normalised value or a reason; the
  // checks run in the SAME order and emit the SAME reasons as the original single body.
  const nameR = validateName(proposal);
  if (!nameR.ok) return nameR;
  const labelR = validateLabel(proposal);
  if (!labelR.ok) return labelR;
  const capsR = validateCapabilities(proposal, creatorCapabilities);
  if (!capsR.ok) return capsR;
  const surfaceR = validateSurface(proposal, capsR.seen);
  if (!surfaceR.ok) return surfaceR;
  const presR = validatePresentation(proposal, surfaceR.surface);
  if (!presR.ok) return presR;
  return {
    ok: true,
    role: {
      name: nameR.name,
      label: labelR.label,
      capabilities: capsR.caps,
      surface: surfaceR.surface,
      presentation: presR.presentation,
      landing: presR.landing,
    },
  };
}

type Fail = { ok: false; reason: string };

// 1. name: a string matching the custom-role pattern that does not collide with a built-in role.
function validateName(proposal: CustomRoleProposal): { ok: true; name: string } | Fail {
  if (typeof proposal.name !== "string") return { ok: false, reason: "name must be a string" };
  const name = proposal.name.trim().toLowerCase();
  if (!CUSTOM_ROLE_NAME_PATTERN.test(name)) {
    return { ok: false, reason: "name must be 1 to 64 chars of lowercase letters, digits and hyphen (not leading/trailing hyphen)" };
  }
  if (isRole(name)) {
    return { ok: false, reason: "name must not collide with a built-in role (viewer/operator/restore-operator/approver/access-admin/owner)" };
  }
  return { ok: true, name };
}

// 2. label: a 1 to 128 character string (trimmed).
function validateLabel(proposal: CustomRoleProposal): { ok: true; label: string } | Fail {
  if (typeof proposal.label !== "string" || proposal.label.trim().length < 1 || proposal.label.length > 128) {
    return { ok: false, reason: "label must be 1 to 128 characters" };
  }
  return { ok: true, label: proposal.label.trim() };
}

// 3/4/5. capabilities: a non-empty array of known capabilities, none owner-reserved, every one
// held by the creator (no privilege escalation). Returns the de-duplicated list and the seen set
// (the surface check reuses it for the edit-requires-write-cap rule).
function validateCapabilities(
  proposal: CustomRoleProposal,
  creatorCapabilities: ReadonlySet<Capability>,
): { ok: true; caps: Capability[]; seen: Set<Capability> } | Fail {
  if (!Array.isArray(proposal.capabilities) || proposal.capabilities.length === 0) {
    return { ok: false, reason: "capabilities must be a non-empty array" };
  }
  const caps: Capability[] = [];
  const seen = new Set<Capability>();
  for (const c of proposal.capabilities) {
    if (!isCapability(c)) return { ok: false, reason: `unknown capability: ${typeof c === "string" ? c : "<non-string>"}` };
    // 4. owner-reserved bar
    if (OWNER_RESERVED_CAPABILITIES.has(c)) {
      return { ok: false, reason: `${c} is owner-reserved and cannot be placed in a custom role` };
    }
    // 5. no privilege escalation: the creator must hold every capability they grant
    if (!creatorCapabilities.has(c)) {
      return { ok: false, reason: `cannot grant ${c}: the creator does not hold it` };
    }
    if (!seen.has(c)) {
      seen.add(c);
      caps.push(c);
    }
  }
  return { ok: true, caps, seen };
}

// 6. surface (optional; defaults to an empty map = the console shows nothing special): known
// screens mapped to known modes, with EDIT-REQUIRES-WRITE-CAP enforced against the role's set.
function validateSurface(
  proposal: CustomRoleProposal,
  seen: Set<Capability>,
): { ok: true; surface: Record<string, SurfaceMode> } | Fail {
  const surface: Record<string, SurfaceMode> = {};
  if (proposal.surface === undefined) return { ok: true, surface };
  if (typeof proposal.surface !== "object" || proposal.surface === null || Array.isArray(proposal.surface)) {
    return { ok: false, reason: "surface must be an object mapping screen to hidden/read/edit" };
  }
  for (const [screen, modeRaw] of Object.entries(proposal.surface as Record<string, unknown>)) {
    if (!isScreen(screen)) return { ok: false, reason: `unknown surface screen: ${screen}` };
    if (modeRaw !== "hidden" && modeRaw !== "read" && modeRaw !== "edit") {
      return { ok: false, reason: `surface mode for ${screen} must be hidden/read/edit` };
    }
    // EDIT-REQUIRES-WRITE-CAP: an editable screen must be backed by the role actually holding that
    // screen's write capability, and the screen must have a write side at all.
    if (modeRaw === "edit") {
      const writeCap = SCREEN_WRITE_CAPABILITY[screen];
      if (writeCap === null || writeCap === undefined) {
        return { ok: false, reason: `screen ${screen} has no write surface and cannot be set to edit` };
      }
      if (!seen.has(writeCap)) {
        return { ok: false, reason: `screen ${screen} is set to edit but the role lacks ${writeCap}` };
      }
    }
    surface[screen] = modeRaw;
  }
  return { ok: true, surface };
}

// 7. presentation + landing: a known presentation skin and a known landing screen the surface
// does not hide.
function validatePresentation(
  proposal: CustomRoleProposal,
  surface: Record<string, SurfaceMode>,
): { ok: true; presentation: "technical" | "shiny"; landing: string } | Fail {
  // presentation is typed unknown on the proposal. Narrow to a string first (for symmetry with the
  // name / label / landing checks), defaulting an absent value to "technical"; any non-string or
  // unknown string value is then rejected by the membership check below.
  const presentation = proposal.presentation === undefined || proposal.presentation === null ? "technical" : proposal.presentation;
  if (presentation !== "technical" && presentation !== "shiny") {
    return { ok: false, reason: "presentation must be technical or shiny" };
  }
  if (typeof proposal.landing !== "string" || !isScreen(proposal.landing)) {
    return { ok: false, reason: "landing must be a known screen" };
  }
  const landing = proposal.landing;
  // You cannot land a user on a screen you hid from them (a hidden landing would render nothing).
  if (surface[landing] === "hidden") {
    return { ok: false, reason: `landing screen ${landing} is hidden in the surface` };
  }
  return { ok: true, presentation, landing };
}

// capabilitiesOfCustomRole materialises a custom role's capability list into a ReadonlySet for the same
// has()-based gating the built-in ROLE_CAPABILITIES sets use, re-applying the owner-reserved bar
// defensively at READ time (even a tampered record could never confer an owner-reserved cap). Mirrors
// the engine's capabilitiesOfCustomRole.
export function capabilitiesOfCustomRole(role: CustomRole): ReadonlySet<Capability> {
  const out = new Set<Capability>();
  for (const c of role.capabilities) {
    if (isCapability(c) && !OWNER_RESERVED_CAPABILITIES.has(c)) out.add(c);
  }
  return out;
}

// unknownCapabilityCount counts the capability ids in a custom role that THIS CONSOLE BUILD does not know.
// It is the PREDICATE behind the silent strip above, split out so the console can RECORD the skew
// rather than only survive it, and kept pure so the strip itself stays a pure function: the caller (app.ts, at
// identity resolution) does the recording.
//
// The strip is correct and stays. What was wrong is that it was SILENT: a custom-role holder whose engine names
// a capability this console has never heard of loses the buttons that capability gates, and reports it as a
// console defect. The count is all that travels. The unrecognised id NEVER does, and on this field that is not a
// formality: a corrupt or tampered custom-role record is the one input here an attacker chooses, and it could
// carry anything at all.
//
// It deliberately does not count an OWNER-RESERVED capability that is present: that is the defensive bar doing
// its job on a record that should never have carried one, it is not version skew, and folding the two together
// would make a tamper signal indistinguishable from an ordinary engine upgrade.
export function unknownCapabilityCount(role: CustomRole): number {
  let n = 0;
  for (const c of role.capabilities) if (!isCapability(c)) n++;
  return n;
}

// ---- caller effective-authority resolution (built-in OR custom role) --------------------------
// A caller is EITHER on one of the six built-in roles OR on a named custom role. These three helpers
// resolve, from whichever source applies, the caller's EFFECTIVE capability set, per-screen surface and
// presentation, so a screen gates an affordance and renders its skin with the SAME inputs the engine
// resolved server-side. A CustomRole argument wins; absent it, the built-in Role is the basis.

// callerEffectiveCapabilities returns the caller's capability set: the custom role's resolved set when
// a custom role applies, else the built-in role's ROLE_CAPABILITIES set. This is the single primitive a
// new affordance gates on (its has() is the client mirror of the engine's callerCan()).
export function callerEffectiveCapabilities(role: Role, customRole?: CustomRole | null): ReadonlySet<Capability> {
  if (customRole) return capabilitiesOfCustomRole(customRole);
  return ROLE_CAPABILITIES[role];
}

// callerCan is the gate the console reads for a caller on EITHER source: it answers "does this caller
// hold this capability" over the resolved effective set, mirroring the engine's callerCan().
export function callerCan(role: Role, capability: Capability, customRole?: CustomRole | null): boolean {
  return callerEffectiveCapabilities(role, customRole).has(capability);
}

// BUILTIN_SURFACE is the per-screen surface the console renders for each of the six built-in roles,
// DERIVED from ROLE_CAPABILITIES so it cannot drift from the authority: a screen is "edit" when the
// role holds the screen's write capability, "read" when the role holds any read it implies, and
// "hidden" otherwise. It exists so the six built-ins can be shown as EDITABLE PRESETS in the role
// builder (a starting point the operator tweaks) and so resolveSurface has a basis for a built-in
// caller. A screen with no write side is at most "read" for any role.
function deriveBuiltinSurface(role: Role): Record<string, SurfaceMode> {
  const caps = ROLE_CAPABILITIES[role];
  const surface: Record<string, SurfaceMode> = {};
  for (const screen of Object.keys(SCREEN_WRITE_CAPABILITY)) {
    const writeCap = SCREEN_WRITE_CAPABILITY[screen];
    if (writeCap !== null && writeCap !== undefined && caps.has(writeCap)) {
      surface[screen] = "edit";
    } else {
      // Every authenticated role holds the read floor, so a known screen the role cannot edit is shown
      // read-only rather than hidden; the built-ins never HIDE a screen (that is a custom-role nicety).
      surface[screen] = "read";
    }
  }
  return surface;
}

// resolveSurface returns the per-screen surface for a caller: the custom role's own surface map when a
// custom role applies, else the surface derived from the built-in role's capabilities. The mode for an
// unmapped screen defaults to "read" (a known screen a custom role did not mention is shown read-only,
// never silently hidden), matching how the console renders a screen the caller can at least read.
export function resolveSurface(role: Role, customRole?: CustomRole | null): Record<string, SurfaceMode> {
  if (customRole) {
    const out: Record<string, SurfaceMode> = {};
    for (const screen of Object.keys(SCREEN_WRITE_CAPABILITY)) {
      const declared = customRole.surface[screen];
      out[screen] = declared ?? "read";
    }
    return out;
  }
  return deriveBuiltinSurface(role);
}

// surfaceMode is the single-screen read of resolveSurface (a convenience for a screen asking only about
// itself). It returns "hidden"/"read"/"edit" for the caller on either authority source.
export function surfaceMode(role: Role, screen: string, customRole?: CustomRole | null): SurfaceMode {
  return resolveSurface(role, customRole)[screen] ?? "read";
}

// resolvePresentation returns the cosmetic skin a caller's console renders in: the custom role's
// declared presentation when a custom role applies, else "technical" (every built-in role gets the full
// technical console; "shiny" is a custom-role-only nicety). Presentation carries NO authority.
export function resolvePresentation(_role: Role, customRole?: CustomRole | null): Presentation {
  return customRole ? customRole.presentation : "technical";
}

// builtinPreset materialises a built-in role as an EDITABLE CustomRole-shaped preset for the role
// builder: the role's full capability set MINUS the owner-reserved caps (which can never be in a custom
// role), its derived surface, the technical skin, and a sensible landing. createdBy/createdAt are null/
// empty placeholders (a preset is not a stored record). It lets the builder show the six built-ins as
// starting points the operator can clone and tweak without re-deriving the mapping by hand.
export function builtinPreset(role: Role): Omit<CustomRole, "createdBy" | "createdAt"> {
  const caps = [...ROLE_CAPABILITIES[role]].filter((c) => !OWNER_RESERVED_CAPABILITIES.has(c));
  const surface = deriveBuiltinSurface(role);
  // Always the downpipes screen: deriveBuiltinSurface covers every SCREEN_WRITE_CAPABILITY key,
  // and downpipes is always among them, so surface.downpipes is always present.
  const landing = "downpipes";
  return { name: role, label: titleCaseRole(role), capabilities: caps, surface, presentation: "technical", landing };
}

// titleCaseRole renders a built-in role id as a display label (e.g. "restore-operator" ->
// "Restore-operator"), used by builtinPreset's label and the builder's preset names.
export function titleCaseRole(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
