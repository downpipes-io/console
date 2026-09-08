// The customer whose licence has EXPIRED is the one customer who must see the expiry banner, and they
// were the only customer who could not.
//
// THE DEFECT. view.ts gated the whole renewal block on `tier === "enterprise"`, and the engine resolves an
// expired licence to tier "community": its fail-open path funnels all twelve reason codes through one
// community() helper (engine src/admin/licence.ts community(), called from checkExpiry's expiry branch).
// So on every real engine response for an expired licence the gate was false, the banner did not render,
// and the screen said "Community" with a neutral "Token stamped until <date>" row. The banner was
// reachable only by a fixture carrying tier "enterprise" together with a past notAfter, a combination the
// engine cannot emit: it reports a paid tier only on the path where the licence VERIFIED and has not
// lapsed.
//
// THE SIGNAL THE ENGINE ACTUALLY SENDS is reasonCode, a closed enum whose "expired" member is distinct
// from "unparseable-expiry" (a malformed date, a different fault with a different remedy). It rode on the
// wire unread: the console's own LicenceStatus mirror did not declare it.
//
// Everything below drives the REAL screen body, over payloads shaped the way the engine really answers.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import type { LicenceStatus, StatusReport, UpdateStatus } from "../src/api.ts";
import type { EngineClient } from "../src/api.ts";

let failures = 0;
function ok(what: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${what}`);
}

const { installDomShim, textOf } = await import("./dom-shim.ts");
installDomShim();
const { render } = await import("../src/screens/licence/view.ts");
const { licenceExpired } = await import("../src/lib/billing.ts");
const { licenceTileLabel } = await import("../src/screens/licence/shared.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const isoInDays = (d: number): string => new Date(Date.now() + d * DAY_MS).toISOString();

// EXACTLY what the engine emits for an expired licence: community() with the lapsed notAfter echoed and
// the source carried through, features[] dropped, accountClaimMatchesEngine absent (the expiry branch
// returns before the account claim is compared).
const expiredFromEngine = (days: number): LicenceStatus => ({
  tier: "community",
  valid: false,
  reason: "licence expired",
  reasonCode: "expired",
  // Half a day inside the boundary, so the FLOOR the day count takes cannot tip between -3 and -4 while
  // the test runs. A fixture sitting exactly on a day boundary is a flake, not a stricter assertion.
  notAfter: isoInDays(-(days - 0.5)),
  source: "console",
});

// And what it emits for a customer who simply never bought one. Same tier, same valid, different code and
// no notAfter at all. This pair is the whole point: before the fix the screen could not tell them apart.
const neverLicensed: LicenceStatus = { tier: "community", valid: false, reason: "no licence configured", reasonCode: "no-token" };

const upd: UpdateStatus = { configured: true, verified: true, currentVersion: "v1.0.0", updateAvailable: false };
const status: StatusReport = {
  service: "downpipe-engine", engineVersion: "v1.0.0", signerConfigured: true, breakGlassConfigured: true,
  operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2",
  updateChannelConfigured: true, licenceConfigured: true,
} as StatusReport;
const engineStub = {} as unknown as EngineClient; // render never calls the engine; handlers fire on click

const screenText = (licence: LicenceStatus): string =>
  textOf(render(engineStub, { licence, updates: upd, status, updateState: null }, () => {}) as never);

console.log("-- the predicate reads what the engine sends, not the tier --");
{
  // The eleven other reason codes the engine can return, all of which also report tier community and
  // valid false. Named here so the block carries a declaration and Biome reads it as a scope.
  const otherCauses = ["no-pin", "pin-invalid", "segments", "decode", "signature", "body-malformed", "not-canonical", "future-tier", "internal-error"] as const;
  ok("an expired licence is recognised though its tier reads community", licenceExpired(expiredFromEngine(3)));
  ok("NEGATIVE CONTROL: a customer who never bought a licence is not called expired", !licenceExpired(neverLicensed));
  // None of the other fail-open causes is an expiry, and calling one an expiry would send the customer to
  // buy a renewal for a token that is corrupt.
  for (const code of otherCauses) {
    ok(`NEGATIVE CONTROL: reasonCode ${code} is not read as an expiry`, !licenceExpired({ tier: "community", valid: false, reasonCode: code }));
  }
  // unparseable-expiry is the closest neighbour and the easiest to fold in by accident: the date is broken,
  // not passed. It has its own line on the card already, and its remedy is to re-activate, not to renew.
  ok("NEGATIVE CONTROL: an unparseable expiry is not an expiry", !licenceExpired({ tier: "community", valid: false, reasonCode: "unparseable-expiry" }));
  // A VALID licence is never expired whatever a skewed clock makes of its notAfter: the engine holds the
  // clock that decides, and it has said the licence verifies.
  ok("NEGATIVE CONTROL: a valid enterprise licence is not expired", !licenceExpired({ tier: "enterprise", valid: true, notAfter: isoInDays(30) }));

  // The second route, kept because a false negative here is the defect being fixed. The engine echoes
  // notAfter on only two paths, a licence that verified and the expiry branch, so an INVALID licence
  // carrying a past notAfter is expired whatever else is true of it.
  ok("an engine that sends no reasonCode is still caught by its own lapsed notAfter", licenceExpired({ tier: "community", valid: false, notAfter: isoInDays(-9) }));
}

console.log("\n-- and the banner now reaches the customer it was written for --");
{
  const text = screenText(expiredFromEngine(3));
  ok("the screen says the token has passed its validity date", /passed its validity date/i.test(text));
  ok("fail-open is stated, so nobody thinks their backups have stopped", /nothing is gated/i.test(text) && /backups and restores continue/i.test(text));
  ok("the remedy names the control on this same screen", /Activate licence below/i.test(text));
  ok("the lapsed date is stated with how long ago it was", /which passed 3 days ago/.test(text));

  // THE COPY NO LONGER NAMES A TIER IT CANNOT KNOW. features[] is dropped on expiry and the tier reads
  // community, so "Enterprise subscription" would have been a guess printed as a fact on a card whose
  // whole job is to state the licence posture accurately.
  ok("it does not claim the lapsed licence was Enterprise", !/Enterprise subscription token has passed/i.test(text));

  // The date used to appear twice: once in the sentence and once under a "Token stamped until" label that
  // reads as though nothing had happened.
  ok("the neutral stamped-until row is withheld, so the date is stated once", !/Token stamped until/i.test(text));

  // The summary tile, which is what a customer sees first.
  ok("the licence tile names the expiry rather than a generic invalid state", licenceTileLabel(expiredFromEngine(3)) === "Licence expired");
  ok("and the screen carries that label", /Licence expired/.test(text));
}

console.log("\n-- NEGATIVE CONTROLS on the screen itself --");
{
  const text = screenText(neverLicensed);
  ok("a customer who never bought a licence gets no expiry banner", !/passed its validity date/i.test(text));
  ok("and no lapsed-date sentence", !/which passed/i.test(text));
  ok("their tile still reads the generic invalid label", licenceTileLabel(neverLicensed) === "Licence not valid");

  const valid = screenText({ tier: "enterprise", valid: true, notAfter: isoInDays(200), features: ["restore-priority"] });
  ok("a valid enterprise licence gets no expiry banner", !/passed its validity date/i.test(valid));
  ok("and still gets its own valid-until line, so the fix removed nothing", /valid until/i.test(valid));

  const soon = screenText({ tier: "enterprise", valid: true, notAfter: isoInDays(5) });
  ok("a renews-soon enterprise licence still carries its re-pin instruction", /Activate licence below/i.test(soon));
  ok("and is not called expired", !/passed its validity date/i.test(soon));

  const community = screenText({ tier: "community", valid: true });
  ok("an ordinary valid Community engine says nothing about expiry", !/passed its validity date/i.test(community));
}

if (failures > 0) {
  console.error(`\nvalidate-licence-expiry-reachable: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nLICENCE EXPIRY BANNER IS REACHABLE");
