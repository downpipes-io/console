// identity-remedy.ts -- what to DO when /admin/whoami did not resolve, held in a leaf that imports nothing.
//
// THE DEAD END THIS CLOSES. When the identity read fails with anything other than a 401, the console does
// not route to signed-out: it degrades, and it stays degraded for the session. Every capability gate then
// reads the caller as null and falls back to the fail-closed `viewer`, so a genuine Owner sees a console
// where nothing is enabled and every refusal ends "(the engine has not yet reported your role)". That
// sentence names the fault and stops. It is the same shape as an authorisation refusal that names no
// remedy, except worse: the customer is not even being refused for a reason they can argue with.
//
// AND THE COMMONEST REMEDY IS ITSELF REFUSED BY THE FAULT. A whoami 404 means the engine predates the
// route, so the fix is an engine update, and applying an engine update is capability-gated, so its control
// is disabled with "Applying an engine update is owner only" printed at a real Owner. The one action that
// clears the fault is refused by the fault.
//
// WHAT IS NOT CHANGED. The fail-closed gate stays exactly as it is. Un-refusing a control because identity
// is missing would invert the whole design (see lib/client-diag/identity-gate.ts, which argues it at
// length), and a console that enables Owner controls for an unidentified caller is a worse defect than a
// console that refuses an Owner. Nothing here reads or changes a gate; it adds the sentence after it.
//
// WHERE THE ANSWER COMES FROM. The console ALREADY computes this distinction and already had it in hand at
// the moment it degraded: app.ts classifies the throw through faultClassForError, which separates
// not-found (the route is absent, so the engine is old) from auth (the read was refused, so access is
// wrong) from transport (the engine could not be reached). It put both in the support pack and nowhere
// else. This module is the same fact, put where the customer is standing.

// IdentityFault is the console's own narrow reading of why the identity read did not resolve. It mirrors
// the members of the diagnostics faultClass that lead to DIFFERENT customer actions, and folds the rest
// into "other": conflict and rate-limited are not distinguishable remedies for a customer looking at a
// greyed control, and neither is a thrown value with no status at all.
export type IdentityFault = "auth" | "not-found" | "server" | "transport" | "other";

// The live fault, or null when the identity read has not failed. Null covers two states that share one
// remedy, so they share one sentence: the report has not come back yet (the race), and the report resolved
// fine and this control is genuinely refused, in which case nothing here is rendered at all.
let identityFault: IdentityFault | null = null;

export function setIdentityFault(fault: IdentityFault | null): void {
  identityFault = fault;
}

// There is deliberately no getIdentityFault(). One was written beside the setter as a matching pair and
// had no caller anywhere in the repo, which knip caught: the only reader of identityFault is
// blindGateRemedy below, in this module. An accessor that exists because its sibling exists widens the
// module's surface without widening what it can do.

// identityFaultFrom maps the diagnostics faultClass, which is what app.ts already has at the degrade, onto
// the narrower set above. Total over the seven members, so a new one cannot be added without a decision
// here; the compiler enforces it through the Record.
const FAULT_FROM_CLASS: Readonly<Record<"auth" | "not-found" | "conflict" | "rate-limited" | "server" | "transport" | "other", IdentityFault>> = {
  auth: "auth",
  "not-found": "not-found",
  server: "server",
  transport: "transport",
  // A 409 or a 429 on the identity read leaves the customer in exactly the state a transient fault does,
  // and neither has an action of its own that a person looking at a disabled button could take.
  conflict: "other",
  "rate-limited": "other",
  other: "other",
};

export function identityFaultFrom(faultClass: keyof typeof FAULT_FROM_CLASS): IdentityFault {
  return FAULT_FROM_CLASS[faultClass];
}

// IDENTITY_REMEDY is one sentence per fault, and each one names something the customer can actually do.
//
// The not-found sentence is the one that has to be honest about a limit rather than reassuring. Its remedy
// is an engine update, that update is gated on the capability the console cannot resolve, and the gate is
// correctly not being lifted. Telling the customer to apply an update they cannot reach would be a second
// dead end wearing the clothes of an instruction, so it says where the fix lives and points at the one
// control that is reachable from the fail-closed floor: the support pack. That is checked rather than
// assumed. The console's download control carries no client gate at all, and the engine gates GET/POST
// /support/bundle on posture.read, which is in the VIEWER capability set, so the pack is reachable by the
// least-privileged caller the console can fall back to.
//
// AND THE PLACE IS NOW NAMED CORRECTLY, WHICH IT WAS NOT. Three of these five sentences said "from the
// Support screen". There is no Support screen: the route-table gate binds 53 patterns and none of them is
// /support, there is no Support item on the rail, and the pack lives on SETTINGS, in a disclosure titled
// "Support bundle" (screens/settings.ts). So the one sentence a customer reads when the console cannot
// read their role, in the state where every control on every screen is refused and this is the whole of
// the advice, sent them looking for a screen that does not exist. The reachability claim beside it stays
// true and is now checkable on both axes: /settings is in setup-state.ts ALWAYS_ALLOWED, so it is reachable
// mid-setup as well as from the viewer floor, which is where a first-hour customer meeting this actually
// stands. The remedy's own validator asserted the WORDS "support pack" and "every signed-in role can
// reach" and never that the named destination exists, so it passed throughout.
const IDENTITY_REMEDY: Readonly<Record<IdentityFault, string>> = {
  "not-found": "Your engine did not answer the identity route at all, which means it is older than this console. An engine update adds the route, and the update control is gated on the same role this console could not read, so it cannot be lifted from here: the engine has to be redeployed or updated from your Cloudflare account. Generate a support pack from Settings, under Support bundle, which every signed-in role can reach, and it carries the evidence.",
  auth: "Your engine refused the identity read, so this is an access problem rather than a role problem. Check that your Cloudflare Access policy covers the account you signed in with, then reload this page.",
  transport: "The console could not reach your engine to read your role. Check the engine worker is deployed and its route is answering, then reload this page.",
  server: "Your engine answered the identity read with a fault of its own, so this is the engine's state rather than your access. Reload this page, and if it persists, generate a support pack from Settings, under Support bundle, which every signed-in role can reach.",
  other: "Reload this page to read your role again. If the controls stay refused after a reload, generate a support pack from Settings, under Support bundle, which every signed-in role can reach.",
};

// identityUnresolvedRemedy is the sentence to put after a refusal that was computed with no identity. The
// null case is the RACE, where whoami has not answered yet and nothing failed, so a reload is genuinely the
// whole answer and naming a fault would be a fabrication.
export function identityUnresolvedRemedy(): string {
  return IDENTITY_REMEDY[identityFault ?? "other"];
}

// blindGateRemedy is GRANT_REMEDY's counterpart for the OTHER refusal, the one where the console does not
// know who is asking. The two are deliberately different sentences because they are different situations
// and they send the customer to different places: a role refusal is settled by an Owner on the Access
// screen, and a blind gate is not a role decision at all, so telling a real Owner to ask an Owner would
// send them to themselves.
//
// It states the fact plainly (the role was not read, so nothing here can be enabled) and then names what
// to do about the SPECIFIC failure, which this module derives from the classification app.ts
// already made when it degraded. The gate itself is untouched: this is the sentence after the refusal,
// never a reason to lift it.
export function blindGateRemedy(): string {
  return `The engine has not reported your role, so this cannot be enabled. ${identityUnresolvedRemedy()}`;
}
