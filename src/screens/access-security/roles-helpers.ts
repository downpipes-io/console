// Leaf helpers shared by the roles members table and the group-to-role mapping table:
// the time-boxed expiry badge, the client-side cumulative rank used for sorting, and the
// role-choice encoding both grant pickers use to offer built-in and custom roles from one
// <select>. Extracted from roles.ts (console-src-025-02, console-src-025-M1).

import { h } from "../../lib/dom.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { capabilitiesOfCustomRole, isRole, type Capability, type CustomRole, type Role } from "../../lib/identity.ts";

export function expiryBadge(expiresAt: string): HTMLElement {
  // Distinguish a grant that has already lapsed from one that will lapse soon, the same
  // comparison the owner-count check uses. An expired grant reads error, an active one warns.
  const expired = Date.parse(expiresAt) < Date.now();
  return h(
    "span",
    { class: expired ? "badge badge--error" : "badge badge--warn", title: absoluteTime(expiresAt) },
    expired ? `expired ${relativeTime(expiresAt)}` : relativeTime(expiresAt),
  );
}

// ---- the role choice a grant picker submits ----------------------------------------------------
// A grant references EITHER one of the six built-in roles OR a named custom role, never both: the
// engine's setRole/setGroupRole pin the stored built-in role to the viewer floor whenever customRole
// is present, and resolve the authority from the custom role's capability set at request time. Both
// pickers therefore offer one <select> over both kinds, and the custom entries carry a prefix so the
// two value spaces cannot collide. CUSTOM_ROLE_NAME_PATTERN admits lowercase letters, digits and the
// hyphen only, so a custom-role name can never contain a colon and can never spell a built-in id.
const CUSTOM_ROLE_CHOICE_PREFIX = "custom:";

export type RoleChoice = { kind: "builtin"; role: Role } | { kind: "custom"; name: string };

export function customRoleChoiceValue(name: string): string {
  return `${CUSTOM_ROLE_CHOICE_PREFIX}${name}`;
}

// decodeRoleChoice reads a picker value back. It returns null rather than guessing on a value that
// names neither a known built-in nor a custom role: the selects are closed, so null is unreachable
// from the UI, and a silent fallback to the viewer floor would turn a value the console failed to
// understand into a demotion nobody asked for.
export function decodeRoleChoice(value: string): RoleChoice | null {
  if (value.startsWith(CUSTOM_ROLE_CHOICE_PREFIX)) {
    const name = value.slice(CUSTOM_ROLE_CHOICE_PREFIX.length);
    return name === "" ? null : { kind: "custom", name };
  }
  return isRole(value) ? { kind: "builtin", role: value } : null;
}

// customRoleOptionLabel names a custom role in a picker: its display label, the stored name the grant
// row and the audit entry will carry, and how much authority it confers. The count is the role's
// RESOLVED set (capabilitiesOfCustomRole re-applies the owner-reserved bar and drops any capability id
// this console build does not know), so it is what the holder will actually get here, not the raw list
// length an older or tampered record might claim.
export function customRoleOptionLabel(role: CustomRole): string {
  const n = capabilitiesOfCustomRole(role).size;
  return `${role.label} (custom role: ${role.name}, ${n} ${n === 1 ? "capability" : "capabilities"})`;
}

// partitionGrantableCustomRoles is the client mirror of the engine's requireGrantWithinAuthority: an
// assigner may only confer capabilities they hold themselves, so a custom role whose set is not a
// subset of the caller's own is refused server-side with a 400. Offering it would be a live control
// that fails server-side, which this screen does not do (see roles-matrix.ts:120), so the picker takes
// the grantable ones and the form names the withheld ones with the reason rather than dropping them
// silently. The engine re-checks either way; this only decides what is offered.
export function partitionGrantableCustomRoles(
  roles: readonly CustomRole[],
  callerCapabilities: ReadonlySet<Capability>,
): { grantable: CustomRole[]; withheld: CustomRole[] } {
  const grantable: CustomRole[] = [];
  const withheld: CustomRole[] = [];
  for (const role of roles) {
    const caps = capabilitiesOfCustomRole(role);
    let within = true;
    for (const cap of caps) {
      if (!callerCapabilities.has(cap)) {
        within = false;
        break;
      }
    }
    (within ? grantable : withheld).push(role);
  }
  return { grantable, withheld };
}
