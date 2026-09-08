// An unresolved identity must leave the customer with something to DO, without lifting a single gate.
//
// THE DEAD END. A whoami failure that is not a 401 does not route to signed-out: app.ts degrades and the
// console stays degraded for the session. Every capability gate then reads the caller as null and falls
// back to the fail-closed `viewer`, so a genuine Owner sees a console where nothing is enabled and every
// refusal ends "(the engine has not yet reported your role)". That sentence names the fault and stops.
//
// AND THE COMMONEST REMEDY WAS REFUSED BY THE FAULT. A whoami 404 means the engine predates the route, so
// the fix is an engine update, and applying an engine update is capability-gated: licence/update.ts printed
// "Applying an engine update is owner only" at a real Owner, on the screen carrying the one action that
// clears the state.
//
// WHAT IS NOT DONE HERE. Nothing un-refuses. The fail-closed behaviour that identity-gate.ts defends at
// length is untouched, and the assertions below check that as hard as they check the new copy: canDo and
// canCap must still be false with no caller, or this file would be documenting a regression rather than a
// fix. The console ALREADY classified the failure (faultClassForError separates not-found from auth from
// transport) and put it in the support pack only. This puts the same fact where the customer is.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim, textOf, qsa } from "./dom-shim.ts";
installDomShim();

import { setIdentityFault, identityFaultFrom, identityUnresolvedRemedy, type IdentityFault } from "../src/lib/identity-remedy.ts";
import { canDo, canCap, gateReason, capGateReason } from "../src/screens/common.ts";

let failures = 0;
function ok(what: string, cond: boolean): void {
  console.log(cond ? `  ok   ${what}` : `  FAIL ${what}`);
  if (!cond) failures++;
}

// No caller is ever set in this file, so every gate below is evaluated in exactly the blind state the
// defect describes.

console.log("-- the gate is still shut, which is the precondition for everything else --");
{
  // The fault a customer is most likely to be in when they read any of this: an engine that predates the
  // identity route. Declared here so the block carries one and Biome reads it as a scope.
  const worstCase: IdentityFault = "not-found";
  setIdentityFault(worstCase);
  ok("canDo('owner') is still false with no identity", !canDo("owner"));
  ok("canDo('viewer') is still false with no identity, so nothing was loosened at the floor either", !canDo("viewer"));
  // keys.ceremony IS the update capability (licence/shared.ts UPDATE_MANAGE_CAP), which is exactly why
  // the update control is unreachable in this state.
  ok("canCap is still false with no identity", !canCap("keys.ceremony"));
  ok("and false for restore.apply too, so the floor was not loosened anywhere", !canCap("restore.apply"));
}

console.log("\n-- every refusal now carries a remedy instead of stopping at the fault --");
{
  setIdentityFault("not-found");
  const role = gateReason("owner");
  const cap = capGateReason("keys.ceremony");
  ok("the role refusal still names what is required", /Requires the Owner role/.test(role));
  ok("the capability refusal still names the permission in customer language", /Requires /.test(cap) && !/keys\.ceremony/.test(cap));
  ok("the role refusal says the role was not read", /has not reported your role/.test(role));
  ok("and carries the remedy for THIS failure", /older than this console/.test(role));
  ok("the capability refusal carries it too", /older than this console/.test(cap));

  // THE ONE THING A BLIND GATE MUST NOT SAY. The role-refusal remedy sends the customer to an Owner on the
  // Access screen, which is right when the console knows the caller is not an Owner and wrong when it does
  // not know who they are: it sends a real Owner to themselves.
  ok("it does not send an unidentified caller to ask an Owner", !/An Owner can change this on the Access screen/.test(role));
  ok("nor on the capability path", !/An Owner can change this on the Access screen/.test(cap));
}

console.log("\n-- each fault names its OWN remedy, which is the whole point of surfacing the class --");
{
  const lines = new Map<IdentityFault, string>();
  for (const f of ["auth", "not-found", "server", "transport", "other"] as const) {
    setIdentityFault(f);
    lines.set(f, identityUnresolvedRemedy());
  }
  ok("every fault produces a line", [...lines.values()].every((l) => l.length > 0));
  // Identical copy across two classes would pass every per-class check while giving back the single flat
  // sentence this fix removes.
  ok("no two faults share copy, which would re-collapse the distinction", new Set(lines.values()).size === lines.size);

  ok("not-found points at the engine's age, which is what a missing route means", /older than this console/.test(lines.get("not-found") ?? ""));
  ok("auth points at Cloudflare Access rather than at a role", /Cloudflare Access/.test(lines.get("auth") ?? ""));
  ok("auth says plainly that this is not a role problem", /rather than a role problem/.test(lines.get("auth") ?? ""));
  ok("transport points at reachability", /could not reach your engine/.test(lines.get("transport") ?? ""));
  ok("server points at the engine's own state", /engine's state rather than your access/.test(lines.get("server") ?? ""));
  ok("other, which is also the race, says reload", /Reload this page/.test(lines.get("other") ?? ""));

  // NEGATIVE CONTROL: the null state is the RACE, where nothing failed. It must not name a fault.
  setIdentityFault(null);
  const raced = identityUnresolvedRemedy();
  ok("NEGATIVE CONTROL: with no recorded fault the copy names no fault", !/older than this console/.test(raced) && !/Cloudflare Access/.test(raced));
  ok("NEGATIVE CONTROL: and says the one thing that is true of a race", /Reload this page/.test(raced));
}

console.log("\n-- the not-found remedy is honest that the portal cannot lift it --");
{
  setIdentityFault("not-found");
  const line = identityUnresolvedRemedy();
  // The finding, written into the product rather than only into a report. Telling a customer to apply an
  // update whose control is disabled by the very fault would be a second dead end wearing the clothes of an
  // instruction.
  ok("it says the update control is gated on the same unread role", /gated on the same role this console could not read/.test(line));
  ok("it says plainly that it cannot be lifted from here", /cannot be lifted from here/.test(line));
  ok("it names where the fix does live", /redeployed or updated from your Cloudflare account/.test(line));
  ok("and it names a control that is genuinely reachable in this state", /support pack/.test(line) && /every signed-in role can reach/.test(line));
  // No customer runs a terminal, so the remedy must not ask for one.
  ok("it asks for no terminal, no CLI and no wrangler command", !/(terminal|command line|wrangler|npx)/i.test(line));
}

console.log("\n-- the class really is derived from the throw, at the site that degrades --");
{
  const { readFileSync } = await import("node:fs");
  const { faultClassForError } = await import("../src/lib/client-diag/classify.ts");
  // A whoami 404 is the state the whole not-found remedy is written for: the engine does not serve the
  // route. The console client folds the status into the thrown message, which is the one thing
  // faultClassForError reads.
  ok("a 404 throw classifies as not-found", identityFaultFrom(faultClassForError(new Error("whoami: 404"))) === "not-found");
  ok("a 403 throw classifies as auth, a different remedy", identityFaultFrom(faultClassForError(new Error("whoami: 403"))) === "auth");
  ok("a 503 throw classifies as server", identityFaultFrom(faultClassForError(new Error("whoami: 503"))) === "server");
  ok("a 429 folds to other, because a customer looking at a greyed control has no action for it", identityFaultFrom(faultClassForError(new Error("whoami: 429"))) === "other");

  // A pure mapper nobody calls is the same as no mapper. app.ts is the one site that degrades, and this is
  // the line that carries the classification out of the support pack and onto the screen.
  const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  ok("app.ts records the fault at the degrade", /setIdentityFault\(identityFaultFrom\(faultClassForError\(err\)\)\);/.test(app));
  ok("and clears it when the identity resolves, so a recovered tab stops offering the remedy", /setWhoamiAvailable\(true\);[\s\S]{0,400}?setIdentityFault\(null\);/.test(app));
}

console.log("\n-- and the update screen stops asserting a role it could not read --");
{
  const { updateControl } = await import("../src/screens/licence/update.ts");
  const { installNav } = await import("../src/lib/nav.ts");
  installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
  setIdentityFault("not-found");

  const card = updateControl(
    {} as never,
    { configured: true, verified: true, currentVersion: "v1.0.0", updateAvailable: true, availableVersion: "v1.1.0" } as never,
    { kind: "available" } as never,
    () => {},
    true,
  );
  const text = textOf(card as never);
  ok("it no longer tells an unidentified caller that this is owner only", !/Applying an engine update is owner only/.test(text));
  ok("it says the console could not read their role", /could not read your role/.test(text));
  ok("and that it therefore cannot tell whether they may apply an update", /cannot tell whether you may apply an update/.test(text));
  ok("the remedy for the actual failure is on the card", /older than this console/.test(text));

  // THE GATE IS STILL SHUT, on the screen, not just in the predicate. This is the assertion that would
  // catch a fix that un-refused the control to make the dead end go away.
  // Refusedness is read as EITHER state, because the controls now express it with aria-disabled so they
  // stay in the tab order and their reason is text a keyboard or touch user can reach. Reading only
  // `disabled` here would report the gate as OPEN, which is the opposite of what this assertion is for.
  const buttons = qsa(card as never, "button") as unknown as Array<{ disabled?: boolean; getAttribute: (k: string) => string | null; listeners?: Record<string, unknown[]>; click: () => void }>;
  const refused = buttons.map((b) => b.disabled === true || b.getAttribute("disabled") !== null || b.getAttribute("aria-disabled") === "true");
  ok("every control on the card is still refused", refused.length > 0 && refused.every((d) => d));
  // And the stronger form of the same claim, which is what actually keeps the gate shut now that the
  // control is clickable again: no button on this card has a click handler at all. aria-disabled is an
  // announcement, not an enforcement, so unattachment is the property that has to hold.
  ok("and no control on the card has a click handler, so the gate is shut in the DOM and not only in the styling", buttons.every((b) => (b.listeners?.click?.length ?? 0) === 0));
}

console.log("\n-- the place the remedy names must EXIST, and be reachable from where the reader stands --");
{
  // THE ASSERTION THAT PASSED FOR THE WRONG REASON. This file already checked that the copy contains the
  // words "support pack" and "every signed-in role can reach". Both held while the sentence said "from the
  // Support screen", and there is no Support screen: no /support pattern, no rail item, and the pack lives
  // on Settings under a disclosure titled "Support bundle". A phrase test cannot tell a real destination
  // from an invented one, so this block tests the DESTINATION.
  const { ROUTES } = await import("../src/lib/app-registry.ts");
  const { deriveSetup, setupAllows } = await import("../src/lib/setup-state.ts");
  const { readFileSync: read } = await import("node:fs");

  const patterns = new Set(ROUTES);
  ok("NEGATIVE CONTROL: there is no /support route, which is what made the old sentence wrong", !patterns.has("/support"));
  ok("the screen the remedy names is a route this console actually binds", patterns.has("/settings"));

  // A first-hour reader is mid-setup, where the rail locks most screens, so "reachable" has to be checked
  // in THAT state and not only against the role floor the module's own note reasoned about.
  const fresh = deriveSetup({
    keysReady: false, signerConfigured: false, breakGlassConfigured: false, emailConfigured: false,
    discoveryTokenPresent: false, accountsSelected: false,
    destination: { configured: false, verified: false, kind: null, source: null },
    boundSourceCount: 0, downpipeCount: 0, anyRunCompleted: false, ready: false,
  });
  ok("and it is reachable on a brand-new account, before a single setup step is done", setupAllows("/settings", fresh));
  ok("NEGATIVE CONTROL: the setup gate really does lock screens at that point, so the check above means something", !setupAllows("/downpipes", fresh));

  // The section title the copy sends them to has to be the section title the screen renders.
  const settings = read(new URL("../src/screens/settings.ts", import.meta.url), "utf8");
  ok("the disclosure the copy names is the one Settings renders", settings.includes('lazyDisclosure("Support bundle"'));

  for (const f of ["not-found", "server", "other"] as const) {
    setIdentityFault(f);
    const line = identityUnresolvedRemedy();
    ok(`${f}: sends the customer to a screen that exists`, line.includes("from Settings, under Support bundle"));
    ok(`${f}: no longer names a screen this console does not have`, !/Support screen/.test(line));
  }
}

console.log("");
if (failures > 0) {
  console.error(`validate-identity-unresolved-remedy: ${failures} FAILED`);
  process.exit(1);
}
console.log("IDENTITY-UNRESOLVED REMEDIES REACH THE CUSTOMER");
