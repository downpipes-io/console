// Validate the CONSOLE half of the third expiry state a support pull
// credential can be in, and whether the operator ever sees it.
//
// Run: node test/validate-support-expiry-unreadable.ts
//
// THE CLASS. `Date.now() > Date.parse(grant.expiresAt)` is not a guard, because every comparison with
// NaN is false, so an unparseable stored expiry read as NOT EXPIRED at four engine readers at once. The
// engine closed that by DISTINGUISHING rather than flipping: grantExpiryState reports
// `readable` and `expired` apart, the unauthenticated pull/scrape gate fails CLOSED with its own outcome
// `credential-expiry-unreadable`, and every surface keeps its coarse boolean with `expiryUnreadable`
// beside it, present ONLY in the third state.
//
// The console then threw that distinction away: a correct decision discarded before anyone can read it. It rendered
// `grant.expired` alone, so a credential whose stored expiry cannot be read was announced as having
// "expired <the unparseable string>", with the value that does not parse printed as the lapse date.
//
// WHAT THIS FILE GRADES, and it grades the four answers APART rather than as one pass:
//   PRESENT   the third sentence is PRODUCED for an unreadable grant, and is REACHED through the real
//             production render path (renderPullCredentials -> scopeBlock -> statusWithLabel), not only
//             asserted of a pure return value. An assertion that a warning is ABSENT holds over a blank
//             screen too, so every third-state check here is a sentinel that must be reached.
//   ABSENT    a healthy grant and a plainly lapsed one do NOT gain it. The key is present only in the
//             third state, so `undefined` and a literal `false` must both read as an ordinary readable
//             expiry. This is the over-fix direction, and it only fails a bad build because live and
//             lapsed subjects are in the loop.
//   INVERTED  the third state never wears the ok tone and never claims the credential lapsed.
//   DISCARDED the unparseable value is never printed as a date, and the remedy is named.
//
// THE DOSES ARE MEASURED, NOT ASSUMED. `Date.parse` is LENIENT where the ISO grammar is not: "2026-08-"
// resolves to and "0" to 31 December 1999, so a TRUNCATED stored expiry never reaches the
// unreadable state at all, it silently becomes a different past date and fails closed. Two of the engine
// values chosen without checking them can be wrong. Every dose below therefore carries its own assertion
// about what Date.parse actually answers for it, so a dose that stops being unreadable is a red rather
// than a check that quietly grades the wrong state.
//
// NO SECOND MECHANISM. The console reads the engine's own vocabulary and renders it. It does not
// re-derive expiry from the raw string: that comparison is the NaN-blind check just removed from the
// engine, and a second derivation could disagree with the gate that refuses the pull.
//
// FS-WRITES: none outside this repo

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDomShim, flushAsync, markConnected } from "./dom-shim.ts";

(globalThis as unknown as { location: unknown }).location = {
  origin: "https://control.downpipes.io",
  href: "https://control.downpipes.io/settings",
  pathname: "/settings",
  assign: () => {},
  replace: () => {},
};
installDomShim();

const { supportGrantPresentation, renderPullCredentials } = await import("../src/screens/settings/support.ts");
const { vendorState } = await import("../src/screens/integrations/state.ts");
const { CATALOGUE } = await import("../src/screens/integrations/catalogue.ts");
import type { SupportGrantView, SupportStatus } from "../src/lib/api/types/support.ts";
import type { ConfigSnapshot } from "../src/screens/integrations/state.ts";
import type { EngineClient } from "../src/api.ts";

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// The doses, and the control that proves each one is the state it claims to be.
// ---------------------------------------------------------------------------
console.log("-- doses: what Date.parse ACTUALLY answers (lenient where ISO is not) --");

// Values measured to yield NaN, so the engine's Number.isFinite guard calls them UNREADABLE.
const UNREADABLE_VALUES = [
  "",
  "not-a-date",
  "2026-13-45T99:99:99Z",
  "2026-06-04T00:00:00.000Z ", // a well-formed stamp with one trailing byte: the half-flushed-write shape
  "Invalid Date",
  "NaN",
  "1e400",
];
// Values that LOOK malformed and are not: each resolves to a real, different, PAST instant, so the
// product fails closed on them and they never reach the third state. They are doses in the other
// direction and they hold the line against "malformed implies NaN".
const LENIENT_READABLE_VALUES = ["2026-08-", "0"];

for (const v of UNREADABLE_VALUES) {
  ok(`dose ${JSON.stringify(v)} really is unreadable (Date.parse is NaN)`, !Number.isFinite(Date.parse(v)));
}
for (const v of LENIENT_READABLE_VALUES) {
  ok(`dose ${JSON.stringify(v)} really is READABLE, so it fails closed rather than reaching the third state`, Number.isFinite(Date.parse(v)));
}

const GOOD_FUTURE = "2026-12-04T00:00:00.000Z";
const GOOD_PAST = "2026-06-04T00:00:00.000Z";

const grant = (over: Partial<SupportGrantView>): SupportGrantView => ({
  clientId: "dpc_abc",
  scope: "audit-feed",
  grantedAt: "2026-06-01T00:00:00.000Z",
  grantedBy: "owner@example.com",
  expiresAt: GOOD_FUTURE,
  expired: false,
  pulls: [],
  ...over,
});

// The wire payload the REPAIRED engine actually produces for an unreadable grant: redactGrant answers
// `expired: true` (the question every existing reader is asking, "is this credential still usable") and
// spreads `expiryUnreadable: true` in beside it.
const unreadableGrant = (expiresAt: string): SupportGrantView => grant({ expiresAt, expired: true, expiryUnreadable: true });

// ---------------------------------------------------------------------------
// PRESENT: the third sentence is produced, for every measured unreadable value.
// ---------------------------------------------------------------------------
console.log("\n-- PRESENT: the third state is said, and it is said as its own thing --");

for (const v of UNREADABLE_VALUES) {
  const p = supportGrantPresentation(unreadableGrant(v));
  const label = p.label;
  ok(`unreadable ${JSON.stringify(v)}: says the stored expiry cannot be read`, label.includes("cannot be read"));
  ok(`unreadable ${JSON.stringify(v)}: does NOT claim the credential expired`, !/expired/i.test(label));
  ok(`unreadable ${JSON.stringify(v)}: names the remedy (revoke and mint a replacement)`, /revoke/i.test(label) && /mint a replacement/i.test(label));
  // DISCARDED, the direction that made the coarse rendering actively misleading: the value that does not
  // parse must never be printed where a reader will take it for a date.
  ok(`unreadable ${JSON.stringify(v)}: never prints the unparseable value as a date`, v === "" || !label.includes(v));
  ok(`unreadable ${JSON.stringify(v)}: danger tone, never a green badge beside a refusal`, p.tone === "danger");
  ok(`unreadable ${JSON.stringify(v)}: still names who granted it`, (p.detail ?? "").includes("owner@example.com"));
  ok(`unreadable ${JSON.stringify(v)}: names the Credentials-screen disagreement`, (p.detail ?? "").includes("Credentials screen"));
  ok(`unreadable ${JSON.stringify(v)}: carries no secret`, !/secret|dps_/i.test([label, p.detail ?? "", p.pullLine ?? ""].join(" ")));
}

// ---------------------------------------------------------------------------
// ABSENT: the over-fix direction. Healthy and lapsed subjects are IN THE LOOP, which is the only
// reason a build that refuses a healthy grant can be seen at all.
// ---------------------------------------------------------------------------
console.log("\n-- ABSENT: a readable expiry never picks up the third state --");

{
  const p = supportGrantPresentation(grant({}));
  ok("healthy grant keeps the ok tone", p.tone === "ok");
  ok("healthy grant reads active and names its expiry", p.label.includes("active") && p.label.includes(GOOD_FUTURE));
  ok("healthy grant never says the expiry cannot be read", !p.label.includes("cannot be read"));
  ok("healthy grant detail carries no Credentials-screen note", !(p.detail ?? "").includes("Credentials screen"));
}
{
  const p = supportGrantPresentation(grant({ expired: true, expiresAt: GOOD_PAST }));
  ok("plainly lapsed grant stays danger", p.tone === "danger");
  ok("plainly lapsed grant still says expired, with its real date", p.label.includes("expired") && p.label.includes(GOOD_PAST));
  ok("plainly lapsed grant never says the expiry cannot be read", !p.label.includes("cannot be read"));
  ok("plainly lapsed grant is not sent to revoke-and-re-mint copy it does not need", !/mint a replacement/i.test(p.label));
}
{
  // The key is PRESENT ONLY in the third state, so an explicit false (which this engine never sends, and
  // a future one might) must read as an ordinary readable expiry rather than as a warning.
  const p = supportGrantPresentation(grant({ expiryUnreadable: false }));
  ok("expiryUnreadable:false is not a warning", p.tone === "ok" && !p.label.includes("cannot be read"));
  // ABSENT rather than undefined: exactOptionalPropertyTypes is on, so the honest way to model "the
  // engine did not send the key" is a payload that does not have it, which is also the wire truth.
  const absent = grant({});
  ok("the absent-key dose really has no such key", !("expiryUnreadable" in absent));
  const q = supportGrantPresentation(absent);
  ok("expiryUnreadable absent is not a warning", q.tone === "ok" && !q.label.includes("cannot be read"));
}
{
  // INVERTED, guarded at the tone rather than at the sentence: a payload carrying the third state beside
  // expired:false must not paint a green badge next to a refusal sentence. The engine cannot emit this
  // pair today; the tone is taken from either flag so that it could never read green if it did.
  const p = supportGrantPresentation(grant({ expiryUnreadable: true, expired: false }));
  ok("unreadable beside expired:false is still danger, never ok", p.tone === "danger");
  ok("unreadable beside expired:false still says the third thing", p.label.includes("cannot be read"));
}
{
  const p = supportGrantPresentation(null);
  ok("no grant is still a neutral fact, not a warning", p.tone === "neutral" && !p.label.includes("cannot be read"));
}

// ---------------------------------------------------------------------------
// The Integrations tile: deliberately COARSE, and asserted as coarse rather than left unstated.
// ---------------------------------------------------------------------------
console.log("\n-- the tile is coarse ON PURPOSE, and the panel below it is not --");

const snapWith = (support: SupportStatus | null): ConfigSnapshot => ({ push: null, otlp: null, support, channels: [], rules: [], downpipes: [] });
const status = (over: Partial<SupportStatus>): SupportStatus => ({ vendorSealConfigured: false, signerConfigured: false, diagnostics: null, auditFeed: null, metrics: null, ...over });
const pullVendor = CATALOGUE.find((v) => v.kind === "pull")!;
const metricsVendor = CATALOGUE.find((v) => v.kind === "metrics")!;

ok("a pull vendor and a metrics vendor were both found in the catalogue", pullVendor !== undefined && metricsVendor !== undefined);
ok("healthy audit-feed grant lights the pull tile", vendorState(pullVendor, snapWith(status({ auditFeed: grant({}) }))) === "live");
ok("unreadable audit-feed grant does NOT light the pull tile", vendorState(pullVendor, snapWith(status({ auditFeed: unreadableGrant("not-a-date") }))) === "configured");
ok("lapsed audit-feed grant reads the same as unreadable on the TILE (a tile carries no cause)", vendorState(pullVendor, snapWith(status({ auditFeed: grant({ expired: true }) }))) === "configured");
ok("healthy metrics grant lights the metrics tile", vendorState(metricsVendor, snapWith(status({ metrics: grant({ scope: "metrics" }) }))) === "live");
ok("unreadable metrics grant does NOT light the metrics tile", vendorState(metricsVendor, snapWith(status({ metrics: unreadableGrant("1e400") }))) === "configured");
ok("no grant at all leaves the pull tile available", vendorState(pullVendor, snapWith(null)) === "available");

// ---------------------------------------------------------------------------
// REACHED: the sentence on a real rendered panel, through the production path.
// ---------------------------------------------------------------------------
console.log("\n-- REACHED: the sentence arrives on the rendered panel, not only in a return value --");

async function renderPanelText(g: SupportGrantView | null): Promise<string> {
  const engine = {
    getSupport: async (): Promise<SupportStatus> => status({ auditFeed: g }),
    metricsEndpointUrl: () => "https://engine.example.com/metrics",
  } as unknown as EngineClient;
  const card = renderPullCredentials(engine, "audit-feed");
  markConnected(card);
  await flushAsync();
  return card.textContent ?? "";
}

{
  const text = await renderPanelText(unreadableGrant("2026-13-45T99:99:99Z"));
  // A non-empty panel is the known positive: an absence check over a blank render passes vacuously.
  ok("the unreadable panel actually rendered (not a blank screen)", text.length > 200 && text.includes("dpc_abc"));
  ok("the rendered panel says the stored expiry cannot be read", text.includes("cannot be read"));
  ok("the rendered panel names the remedy", /revoke it and mint a replacement/i.test(text));
  ok("the rendered panel does not print the unparseable value", !text.includes("2026-13-45T99:99:99Z"));
  ok("the rendered panel does not claim the credential expired", !/ expired /i.test(text));
}
{
  const text = await renderPanelText(grant({}));
  ok("the healthy panel actually rendered", text.length > 200 && text.includes("dpc_abc"));
  ok("the healthy panel never says the expiry cannot be read", !text.includes("cannot be read"));
  ok("the healthy panel reads active with its expiry", text.includes("active") && text.includes(GOOD_FUTURE));
}
{
  const text = await renderPanelText(grant({ expired: true, expiresAt: GOOD_PAST }));
  ok("the lapsed panel actually rendered", text.length > 200 && text.includes("dpc_abc"));
  ok("the lapsed panel still says expired with its real date", text.includes("expired") && text.includes(GOOD_PAST));
  ok("the lapsed panel never says the expiry cannot be read", !text.includes("cannot be read"));
}

// ---------------------------------------------------------------------------
// THE SERVED ARTEFACT. The browser is served public/*.js, not src/. A sentence that exists only in
// source reaches nobody, so the committed bundle is read directly and the sentence must be IN it.
// test/validate-bundle.ts is what keeps that bundle honest against source; this check is what keeps
// the SENTENCE honest against the bundle, and the two fail on different things.
// ---------------------------------------------------------------------------
console.log("\n-- the SERVED artefact carries the sentence --");

const publicDir = join(fileURLToPath(new URL("../public/", import.meta.url)));
const servedJs = readdirSync(publicDir).filter((f) => f.endsWith(".js"));
const servedText = servedJs.map((f) => readFileSync(join(publicDir, f), "utf8")).join("\n");
// A known positive first, so a bundle this check cannot read is a red rather than a silent zero.
ok("the served bundle was read at all", servedJs.length >= 2 && servedText.length > 100_000);
ok("the served bundle carries a sentence the console has shipped for months (instrument control)", servedText.includes("No active credential."));
ok("the served bundle carries the third-state sentence", servedText.includes("is refused because the expiry stored against it cannot be read"));
ok("the served bundle carries the remedy", servedText.includes("Revoke it and mint a replacement."));
ok("the served bundle carries the Credentials-screen disagreement note", servedText.includes("The Credentials screen still tracks this bearer"));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-support-expiry-unreadable: ${checks} checks, ${failures} failures`);
if (failures > 0) process.exitCode = 1;
