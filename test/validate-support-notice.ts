// The end-of-support notice in the Updates section (src/screens/licence/support-notice.ts).
//
// The rule: a release is supported until 90 days after its successor ships, and the console shows a notice
// from 30 days before that date and after it. The engine works the date out from the signed update channel
// and reports `supportedUntil` and `supportStatus` ("supported", "ending", "end-of-life") for the running
// version (engine src/admin/update-support.ts). The console shows no date of its own. It shows a notice
// for "ending" and "end-of-life", and nothing for "supported", or when the engine sends neither field.
//
// Two halves. The pure decision runs against a pinned clock. Then the REAL Licence and updates screen body
// is rendered over engine-shaped payloads, so the notice is proved to reach the screen and not only the helper.
// The pinned example: UNTIL is a successor's release time plus 90 days.
//
//   node test/validate-support-notice.ts

import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import type { LicenceStatus, StatusReport, UpdateStatus } from "../src/api.ts";
import type { EngineClient } from "../src/api.ts";

let failures = 0;
function ok(what: string, cond: boolean): void {
  console.log(cond ? `  ok   ${what}` : `  FAIL ${what}`);
  if (!cond) failures++;
}

const { installDomShim, textOf, qsa } = await import("./dom-shim.ts");
installDomShim();
const { render } = await import("../src/screens/licence/view.ts");
const { SUPPORT_NOTICE_DAYS, supportNotice, supportNoticeLine } = await import("../src/screens/licence/support-notice.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const UNTIL = "2027-01-03T00:00:00.000Z";
const UNTIL_MS = Date.parse(UNTIL);
const ENDING = UNTIL_MS - 30 * DAY_MS;
const SUPPORTED = UNTIL_MS - 31 * DAY_MS;
const AFTER = UNTIL_MS + DAY_MS;

console.log("-- the decision, on a pinned clock --");
{
  ok("the notice window is 30 days", SUPPORT_NOTICE_DAYS === 30);
  ok("supported: 31 days before supportedUntil gives no notice", supportNotice({ verified: true, supportedUntil: UNTIL, supportStatus: "supported" }, SUPPORTED) === null);
  const ending = supportNotice({ verified: true, supportedUntil: UNTIL, supportStatus: "ending" }, ENDING);
  ok("ending: 30 days before supportedUntil gives a notice with 30 days left", ending !== null && ending.past === false && ending.daysLeft === 30);
  const ended = supportNotice({ verified: true, supportedUntil: UNTIL, supportStatus: "end-of-life" }, AFTER);
  ok("end-of-life: the day after supportedUntil gives a past notice", ended !== null && ended.past === true);
  ok("the engine's status decides: end-of-life gives a past notice whatever this clock says", supportNotice({ verified: true, supportedUntil: UNTIL, supportStatus: "end-of-life" }, SUPPORTED)?.past === true);
  ok("the engine's status decides: supported gives no notice whatever this clock says", supportNotice({ verified: true, supportedUntil: UNTIL, supportStatus: "supported" }, AFTER) === null);
  ok("no status: the date alone gives no notice 31 days before", supportNotice({ verified: true, supportedUntil: UNTIL }, SUPPORTED) === null);
  ok("no status: the date alone gives a notice 30 days before", supportNotice({ verified: true, supportedUntil: UNTIL }, ENDING)?.past === false);
  ok("no status: the date alone gives a past notice the day after", supportNotice({ verified: true, supportedUntil: UNTIL }, AFTER)?.past === true);
  ok("neither field: no notice", supportNotice({ verified: true }, AFTER) === null);
  ok("supported with no date (the latest release): no notice", supportNotice({ verified: true, supportStatus: "supported" }, AFTER) === null);
  ok("a status without a date gives no notice (nothing to show)", supportNotice({ verified: true, supportStatus: "end-of-life" }, AFTER) === null);
  ok("an unverified status gives no notice, whatever it carries", supportNotice({ verified: false, supportedUntil: UNTIL, supportStatus: "end-of-life" }, AFTER) === null);
  ok("an unparseable date gives no notice", supportNotice({ verified: true, supportedUntil: "soon", supportStatus: "ending" }, ENDING) === null);
  ok("an unknown status falls back to the date", supportNotice({ verified: true, supportedUntil: UNTIL, supportStatus: "later" as never }, SUPPORTED) === null);
  const line = supportNoticeLine(ended!, "0.3.7");
  ok("the past line names the version and the date, and says backups keep running", line.includes("Engine 0.3.7 reached its end of support on 3 January 2027") && line.includes("Backups and restores keep running"));
  ok("the past line points to the latest release", line.includes("Update to the latest release."));
  const soon = supportNoticeLine(ending!, "0.3.7");
  ok("the ending line names the days left and the date", soon.includes("in 30 days") && soon.includes("3 January 2027"));
  ok("the ending line points to the latest release", soon.includes("Update to the latest release before then."));
}

console.log("\n-- the real screen body --");
{
  const licence: LicenceStatus = { tier: "community", valid: false, reason: "no licence configured", reasonCode: "no-token" };
  const status: StatusReport = {
    service: "downpipe-engine", engineVersion: "0.3.7", signerConfigured: true, breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2",
    updateChannelConfigured: true, licenceConfigured: true,
  } as StatusReport;
  const engineStub = {} as unknown as EngineClient;
  const live = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();
  const screen = (extra: Partial<UpdateStatus>) => {
    const updates: UpdateStatus = { configured: true, verified: true, currentVersion: "0.3.7", recommendedVersion: "0.3.8", updateAvailable: true, ...extra };
    const root = render(engineStub, { licence, updates, status, updateState: null }, () => {}) as never;
    const notices = qsa(root, ".banner").filter((b) => textOf(b).includes("end of support"));
    return { text: textOf(root), notices, cls: notices.map((b) => String((b as unknown as { className?: string }).className ?? "")) };
  };

  const past = screen({ supportedUntil: live(-3.5), supportStatus: "end-of-life" });
  ok("end-of-life: the screen shows one danger notice", past.notices.length === 1 && past.cls[0]!.includes("banner--danger"));
  ok("end-of-life: the notice says the engine reached its end of support", past.text.includes("Engine 0.3.7 reached its end of support"));
  const soon = screen({ supportedUntil: live(10.5), supportStatus: "ending" });
  ok("ending: the screen shows one warning notice", soon.notices.length === 1 && soon.cls[0]!.includes("banner--warn"));
  ok("ending: the notice gives the days left", soon.text.includes("in 11 days"));
  const engineSaysEnding = screen({ supportedUntil: live(45), supportStatus: "ending" });
  ok("the engine's status decides on the screen: ending shows a warning even 45 days out by this clock", engineSaysEnding.notices.length === 1);
  const supported = screen({ supportedUntil: live(45), supportStatus: "supported" });
  ok("supported: the screen shows no end-of-support notice", supported.notices.length === 0 && !supported.text.includes("end of support"));
  const latest = screen({ supportStatus: "supported" });
  ok("the latest release (supported, no date): the screen shows no end-of-support notice", latest.notices.length === 0 && !latest.text.includes("end of support"));
  const absent = screen({});
  ok("neither field: the screen shows no end-of-support notice", absent.notices.length === 0 && !absent.text.includes("end of support"));
  const unverified = screen({ verified: false, supportedUntil: live(-3), supportStatus: "end-of-life" });
  ok("unverified: the screen shows no end-of-support notice", unverified.notices.length === 0);
}

console.log(failures === 0 ? "\nSUPPORT NOTICE PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures);
if (failures > 0) process.exit(1);
