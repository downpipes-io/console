// identity-gate.ts -- the witness for a capability gate computed before the identity report arrived.
//
// THE STATE recordIdentityUnresolved CANNOT SEE. That recorder fires only when engine.whoami() THROWS. The
// commoner fault, and the one the ticket actually describes, involves no throw at all:
//
//   app.ts router.start() paints the first screen
//   app.ts void resolveIdentity()          <- still in flight
//   the screen's gates run synchronously:  caller()?.role ?? "viewer"   <- computed from the DEFAULT
//   whoami returns, setCaller(owner)       <- and NOTHING re-renders the screen
//
// So an actual Owner who deep-links to /security on boot sees every control greyed "owner only", the whoami read
// SUCCEEDED, and the pack carried no row at all -- byte-identical to the pack of a genuine viewer. "Your role is
// viewer" and "we never asked before we gated you" were the same evidence, which is precisely the confusion the
// gap exists to end.
//
// WHAT THE ROW SAYS, AND WHAT IT DELIBERATELY DOES NOT. It says: the gates on THIS SCREEN were computed while the
// identity was unresolved. It says NOTHING about the role that eventually came back. That restraint is not
// squeamishness, it is the no-custody rule: the caller's role is a customer value, and a row emitted only when
// the role turned out to be high would leak a bit of it into the pack by its mere existence. So the row fires on
// the RACE, which is a defect regardless of who won it, and a screen whose gates were computed AFTER the identity
// landed produces no row.
//
// NOISE. This is not a cry-wolf signal. A gate computed from a default rather than from the report is WRONG on
// the render it governs, whoever the operator is: the affordances shown are not the affordances the engine would
// allow. It is a defect, not a legitimate state, so recording it is honest.

import { recordIdentityStaleGate } from "./ring.ts";
import { currentScreen } from "./classify.ts";
import type { ClientDiagScreen } from "./vocab.ts";

// The screens whose gates ran blind, held until the identity lands. A Set, so an operator bouncing between two
// gated screens before whoami returns yields one row per SCREEN and not one per render.
const blindScreens = new Set<ClientDiagScreen>();
// identityLanded latches at the first successful identity resolve. After it, a gate is being computed from a real
// report and there is nothing to witness, so noteGateComputedBlind() becomes a no-op for the rest of the session.
let identityLanded = false;

// noteGateComputedBlind is called by a capability gate AT THE MOMENT IT FALLS BACK TO THE DEFAULT, i.e. from the
// null-caller branch of EVERY gate helper: the console's two primary gates, canDo and canCap in
// screens/common.ts, the palette's requireCap in shell/registry.ts, and the four screen-local predicates
// (security-centre, credentials, notifications, the role builder). It is the one place in the console that knows
// both halves of the fact: a gate is being decided, and there is no identity to decide it from.
//
// THE PRIMARY GATES WERE MISSING FROM THAT LIST UNTIL, and this comment asserted the palette was in it
// when it was not. canDo and canCap decide almost every gate in the console, they
// failed closed on a null caller in silence, and the four screen-local predicates above are hand-copied duplicates
// of canCap that exist BECAUSE the original did not witness. So no identity-stale-gate row could name the restore
// screen, or overview, or sources, or downpipes, and currentScreenGatedBlind() below could not see a blind gate on
// any of them either. scripts/identity-gate-witness-gate.mjs now DERIVES the required set from source, so a new
// fail-closed gate cannot be added silently and this list cannot drift into a claim again.
//
// It does not RECORD here. A gate that runs blind and is then followed by an identity that never arrives at all is
// already recorded, as identity-unresolved, by the throw; recording both would double-count one fault. The row is
// emitted only when the identity LANDS afterwards, which is the moment the race is proven.
export function noteGateComputedBlind(): void {
  if (identityLanded) return;
  blindScreens.add(currentScreen());
}

// noteIdentityLanded is called by app.ts when whoami RESOLVES (successfully). Every screen that gated itself blind
// before this moment now has a proven race: it rendered its controls from the `viewer` default and the report that
// would have corrected it arrived too late, with nothing re-rendering the screen. One row per screen, once.
export function noteIdentityLanded(): void {
  if (identityLanded) return;
  identityLanded = true;
  for (const screen of blindScreens) recordIdentityStaleGate(screen);
  blindScreens.clear();
}

// currentScreenGatedBlind reports whether the CURRENT screen has a gate that ran blind and is still held
// (identity has not landed yet, so blindScreens has not been cleared). It is the seam app.ts reads, AT
// identity-land and BEFORE noteIdentityLanded() clears the witness, to decide whether the on-screen screen
// needs a re-render even when the resolved caller's render key is UNCHANGED from the paint. That is the
// case reRenderCurrentScreenForResolvedIdentity's key guard alone misses: a same-identity re-resolve (a
// bfcache pageshow, or a screen's refreshIdentity) during which a LATE ASYNC gate computed blind - the
// resolved caller equals the first-paint caller, so identityKey is unchanged and the re-render is skipped,
// leaving the blind gate stuck. A witness read, never a mutation; noteGateComputedBlind stays the only writer.
export function currentScreenGatedBlind(): boolean {
  return blindScreens.has(currentScreen());
}

// resetIdentityGateWitness is the validator's seam (the module holds session state, and a validator drives several
// independent scenarios in one process). Not called by production code.
export function resetIdentityGateWitness(): void {
  blindScreens.clear();
  identityLanded = false;
}
