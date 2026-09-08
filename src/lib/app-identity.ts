// The pure whoami -> Caller shaping, split out of the app entry (app.ts) so the identity
// resolver keeps to its orchestration. No DOM, no engine call, no state: it maps a verified
// WhoAmI mirror into the console's Caller shape, carrying the optional fields only when the
// engine sent them (exactOptionalPropertyTypes-clean).

import type { Caller, WhoAmI } from "../api.ts";

// buildCallerFromWhoami maps the engine's verified WhoAmI mirror into the console Caller shape.
// The optional fields are spread only when present so the result stays exactOptionalPropertyTypes
// -clean and an engine that has not yet deployed a field degrades honestly (the console simply
// does not carry it).
export function buildCallerFromWhoami(who: WhoAmI): Caller {
  return {
    method: who.method,
    email: who.email,
    role: who.role,
    groups: who.groups,
    isOnlyOwner: who.isOnlyOwner,
    // subject is the stable, immutable internal identity key (engine `iss|sub`), carried so any
    // engine-logic mirror keys on the same principal the engine authorises on, not the mutable
    // email (ASVS V10.3.3 / V10.5.2). Display stays on
    // email; the raw subject is never shown. Carried only when the engine sent it (an engine that
    // has not yet deployed the field omits it and the console degrades honestly), keeping the
    // optional property exactOptionalPropertyTypes-clean.
    ...(who.subject !== undefined ? { subject: who.subject } : {}),
    ...(who.identityProvider !== undefined ? { identityProvider: who.identityProvider } : {}),
    ...(who.sessionExpiresAt !== undefined ? { sessionExpiresAt: who.sessionExpiresAt } : {}),
    // Carry the resolved custom role + capability set when the caller is on a NAMED custom role,
    // so the shell can curate the rail, pick the skin and open the landing by the same inputs the
    // engine resolved. Absent for the six built-in roles (exactOptionalPropertyTypes).
    ...(who.customRole !== undefined ? { customRole: who.customRole } : {}),
    ...(who.capabilities !== undefined ? { customCapabilities: who.capabilities } : {}),
  };
}
