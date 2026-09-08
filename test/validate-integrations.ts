// Validates the Integrations screen (screens/integrations/*): the catalogue integrity, the mark resolver, the
// pure tile-state deriver, the grid render, and the per-vendor setup-panel dispatch. Uses the DOM shim so the
// real h()-built production DOM renders under plain Node, exactly like test/validate-idp.ts.
//
// Run: node test/validate-integrations.ts

import { activeElement, flushAsync, installDomShim, markConnected } from "./dom-shim.ts";

// A recording location, set BEFORE the shim, in case any imported module reads it on load.
(globalThis as unknown as { location: unknown }).location = {
  origin: "https://control.downpipes.io",
  href: "https://control.downpipes.io/integrations",
  pathname: "/integrations",
  assign: () => {},
  replace: () => {},
};
installDomShim();

const { CATALOGUE, vendorsByCategory, vendorSlug, docsUrl } = await import("../src/screens/integrations/catalogue.ts");
const { vendorState, pushOwnedBy, rulesForVendor, routeIsInert, inertRouteReason, inertRoutesText, noLiveRouteText } = await import("../src/screens/integrations/state.ts");
const { renderIntegrationGrid, connectedSummary, tileId } = await import("../src/screens/integrations/grid.ts");
const { integrationMark, hasBrandMark } = await import("../src/screens/integrations/marks.ts");
const { renderSetupBody } = await import("../src/screens/integrations/panels.ts");
// The push panel's mutating controls are Owner-gated through canDo(), which reads the resolved caller. The
// DEF1/DEF2 block below drives the REAL form, so it needs a real Owner caller rather than a stub of the gate.
const { setCaller } = await import("../src/lib/caller-state.ts");
// The focus-return block drives the WHOLE Integrations screen (the coordinator that owns open/close and therefore
// owns focus), not a helper of it, so it needs the screen descriptor and a store the screen's requireEngine()
// can resolve. A helper-level test could not have seen the defect: the close path is the coordinator's.
const { integrationsScreen } = await import("../src/screens/integrations.ts");
const store = await import("../src/lib/store.ts");
import type { ConfigSnapshot } from "../src/screens/integrations/state.ts";
import type { Vendor } from "../src/screens/integrations/catalogue.ts";
import type { IngestScope } from "../src/lib/api/types/support.ts";
import type { IntegrationTile, TileGroup } from "../src/screens/integrations/grid.ts";

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}
const find = (v: string) => CATALOGUE.find((x) => x.name === v && x.kind !== "metrics" && x.kind !== "metrics-push") ?? CATALOGUE.find((x) => x.name === v)!;
const findIn = (v: string, cat: string) => CATALOGUE.find((x) => x.name === v && x.category === cat)!;
const EMPTY: ConfigSnapshot = { push: null, otlp: null, support: null, channels: [], rules: [], downpipes: [] };
// The scope is a parameter because it is a real IngestScope, not a placeholder: it names WHICH grant
// this is. It read "x", which is not one of the three, and the cast on each fixture was hiding that.
const grant = (scope: IngestScope, expired: boolean) => ({ clientId: "c", scope, grantedAt: "", grantedBy: "", expiresAt: "", expired, pulls: [] });
const slackCh = { id: "s1", kind: "slack", name: "SRE", enabled: true, createdAt: "" };
const slackRule = { id: "r1", scope: { kind: "global" }, minSeverity: "info", events: "all", channelIds: ["s1"], enabled: true };
// A rule pinned to a downpipe that has been DELETED, and one that is simply turned off: both name the Slack
// channel and neither delivers anything. dpAlive is the live downpipe list the coordinator loads beside them.
const deadScopeRule = { id: "r2", scope: { kind: "downpipe", downpipeId: "dp-gone" }, minSeverity: "info", events: "all", channelIds: ["s1"], enabled: true };
const disabledRule = { id: "r3", scope: { kind: "global" }, minSeverity: "info", events: "all", channelIds: ["s1"], enabled: false };
const liveScopeRule = { id: "r4", scope: { kind: "downpipe", downpipeId: "dp-live" }, minSeverity: "info", events: "all", channelIds: ["s1"], enabled: true };
const dpAlive = [{ config: { id: "dp-live" } }] as unknown as ConfigSnapshot["downpipes"];

const stubEngine = {
  origin: "https://control.downpipes.io",
  metricsEndpointUrl: () => "https://control.downpipes.io/metrics",
  getPush: async () => ({ present: false }),
  getOtlpPush: async () => ({ present: false }),
  getSupport: async () => ({ vendorSealConfigured: true, signerConfigured: true, diagnostics: null, auditFeed: null, metrics: null }),
  listNotifyChannels: async () => [],
  listNotifyRules: async () => [],
  listDownpipes: async () => [],
} as unknown as Parameters<typeof renderSetupBody>[0];

async function main(): Promise<void> {
  console.log("-- catalogue integrity --");
  ok("40 destinations (39 named + the Custom endpoint escape hatch)", CATALOGUE.length === 40);
  const byCat = vendorsByCategory();
  ok("four categories in order", byCat.map((g) => g.category).join(" | ") === "SIEM | Metrics and observability | Incident and on-call | Chat and generic");
  ok("22 SIEM (incl. Custom), 7 metrics, 7 incident, 4 chat", byCat.map((g) => g.vendors.length).join(",") === "22,7,7,4");
  ok("only Splunk + Datadog auto-parse in SIEM (the honest set)", byCat[0]!.vendors.filter((v) => v.auto).map((v) => v.name).sort().join(",") === "Datadog,Splunk");
  ok("every tile id is unique across categories", new Set(CATALOGUE.map(tileId)).size === CATALOGUE.length);
  ok("every NAMED push vendor names a format + sink (Custom deliberately does not)", CATALOGUE.filter((v) => v.kind === "push" && !v.custom).every((v) => Boolean(v.pushFormat && v.pushSink)));
  ok("exactly one Custom escape hatch (a push tile with no fixed format -> the generic form)", CATALOGUE.filter((v) => v.custom).length === 1 && CATALOGUE.find((v) => v.custom)?.kind === "push" && !CATALOGUE.find((v) => v.custom)?.pushFormat);
  ok("every notify vendor names a channel kind", CATALOGUE.filter((v) => v.kind === "notify").every((v) => Boolean(v.channelKind)));
  // vendorSlug is the vendor's STABLE MACHINE IDENTITY: the docs page path, and the opaque tag the push config
  // stores so the console knows which vendor a live push is. Two vendors colliding on one slug would make that
  // tag ambiguous again, which is the whole defect it replaces.
  const pushSlugs = CATALOGUE.filter((v) => v.kind === "push").map(vendorSlug);
  ok("every push vendor's slug is unique (the stored destination-identity tag is unambiguous)", new Set(pushSlugs).size === pushSlugs.length);
  ok("every push vendor's slug is a bounded lowercase slug the engine will store", pushSlugs.every((sl) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sl) && sl.length <= 64));
  // pushSlugs above is deliberately scoped to kind==="push"
  // (the opaque destination-identity tag really is a push-only concept), but docsUrl() names a page for
  // EVERY catalogue entry regardless of kind, so a docs-link collision across kinds was invisible to it. The
  // real case: the Datadog SIEM push tile and the Datadog OTLP metrics-push tile share the display name
  // "Datadog" and, before Vendor.docSlug existed, the same name-derived slug, so the metrics tile's "view
  // docs" link opened the SIEM push guide instead of its own /integrations/datadog-metrics page. A push-only
  // scan can never see that pair (metrics-push is a different kind), which is why this has to walk the whole
  // catalogue rather than filter it the way pushSlugs does.
  const docPath = (v: Vendor) => new URL(docsUrl(v)).pathname.replace(/^\/integrations\//, "");
  const docSlugs = CATALOGUE.map(docPath);
  ok("every catalogue entry's docs-link slug is unique across ALL kinds, not just push", new Set(docSlugs).size === docSlugs.length);
  // Both ways: the widened check above must be ABLE to fail, not just pass by construction. Reintroduce the
  // exact collision it was blind to (drop the Datadog metrics-push docSlug override back to the shared
  // name-derived slug) and confirm this SAME uniqueness test refuses it.
  const regressedDocSlugs = CATALOGUE.map((v) => (v.name === "Datadog" && v.kind === "metrics-push" ? vendorSlug(v) : docPath(v)));
  ok("negative control: reintroducing the Datadog push/metrics-push slug collision makes this check fail", new Set(regressedDocSlugs).size !== regressedDocSlugs.length);
  // The pair the whole DEF2 fix exists for: two NAMED vendors on one wire, with different credential shapes.
  const splunkV = find("Splunk");
  const falconV = find("CrowdStrike Falcon Next-Gen SIEM");
  ok("Splunk and CrowdStrike Falcon really do share one wire (splunk-hec over http)", splunkV.pushFormat === falconV.pushFormat && (splunkV.pushSink ?? "http") === (falconV.pushSink ?? "http"));
  ok("and they do NOT share a credential scheme: Splunk requires one, Falcon takes a bare bearer token", splunkV.credScheme === "Splunk " && falconV.credScheme === undefined);

  console.log("-- marks resolve (a real svg for every tile, never blank) --");
  ok("every vendor renders an <svg> mark", CATALOGUE.every((v) => integrationMark(v.mark, v.name).tagName.toLowerCase() === "svg"));
  const vectorised = ["arcsight", "sumologic", "securonix", "rapid7", "exabeam", "panther", "devo", "logpoint", "cribl", "logrhythm"];
  ok("the ten vectorised niche vendors carry real brand marks (no monogram vendor remains)", vectorised.every((k) => hasBrandMark(k)));
  ok("an unknown vendor key still falls back to a safe two-letter mark (never blank)", integrationMark("no-such-vendor", "Some Vendor").tagName.toLowerCase() === "svg");
  ok("Splunk + Datadog + PagerDuty have real brand marks", hasBrandMark("splunk") && hasBrandMark("datadog") && hasBrandMark("pagerduty"));

  console.log("-- vendorState (pure) --");
  ok("empty config => every tile available", CATALOGUE.every((v) => vendorState(v, EMPTY) === "available"));
  const splunkPush: ConfigSnapshot = { ...EMPTY, push: { present: true, enabled: true, format: "splunk-hec", sink: "http" } as ConfigSnapshot["push"] };
  ok("push=splunk-hec enabled => Splunk live, QRadar available", vendorState(find("Splunk"), splunkPush) === "live" && vendorState(find("QRadar"), splunkPush) === "available");
  const cefOff: ConfigSnapshot = { ...EMPTY, push: { present: true, enabled: false, format: "cef", sink: "syslog-tls" } as ConfigSnapshot["push"] };
  ok("push=cef disabled => QRadar + ArcSight configured (shared wire co-light), Splunk available", vendorState(find("QRadar"), cefOff) === "configured" && vendorState(find("ArcSight"), cefOff) === "configured" && vendorState(find("Splunk"), cefOff) === "available");
  const slackLive: ConfigSnapshot = { ...EMPTY, channels: [{ id: "1", kind: "slack", name: "SRE", enabled: true, createdAt: "" }] as ConfigSnapshot["channels"] };
  ok("a live Slack channel => Slack live, Teams available", vendorState(find("Slack"), slackLive) === "live" && vendorState(find("Microsoft Teams"), slackLive) === "available");
  const pdOff: ConfigSnapshot = { ...EMPTY, channels: [{ id: "2", kind: "pagerduty", name: "P", enabled: false, createdAt: "" }] as ConfigSnapshot["channels"] };
  ok("a disabled PagerDuty channel => configured", vendorState(find("PagerDuty"), pdOff) === "configured");
  ok("Opsgenie shares the jsm kind with JSM", find("Opsgenie").channelKind === "jsm" && find("Jira Service Management").channelKind === "jsm");
  // The two configured flags are required on SupportStatus and were absent behind the cast, so anything
  // reading them off these fixtures read undefined. False keeps the behaviour these cases already
  // had, and neither is what vendorState is being asked about here.
  const metricsLive: ConfigSnapshot = { ...EMPTY, support: { vendorSealConfigured: false, signerConfigured: false, diagnostics: null, auditFeed: null, metrics: grant("metrics", false) } };
  ok("a live metrics grant => Prometheus live", vendorState(findIn("Prometheus", "Metrics and observability"), metricsLive) === "live");
  const feedExpired: ConfigSnapshot = { ...EMPTY, support: { vendorSealConfigured: false, signerConfigured: false, diagnostics: null, auditFeed: grant("audit-feed", true), metrics: null } };
  ok("an expired audit-feed grant => Sentinel configured (exists, refused)", vendorState(find("Microsoft Sentinel"), feedExpired) === "configured");
  const otlpLive: ConfigSnapshot = { ...EMPTY, otlp: { present: true, enabled: true } as ConfigSnapshot["otlp"] };
  ok("otlp enabled => Datadog metrics live", vendorState(findIn("Datadog", "Metrics and observability"), otlpLive) === "live");
  const customVendor = CATALOGUE.find((v) => v.custom)!;
  const leefPush: ConfigSnapshot = { ...EMPTY, push: { present: true, enabled: true, format: "leef", sink: "syslog-tls" } as ConfigSnapshot["push"] };
  ok("Custom tile is live for a push NO named vendor claims (leef/syslog)", vendorState(customVendor, leefPush) === "live");
  ok("Custom tile is available when a named vendor claims the push (splunk-hec)", vendorState(customVendor, splunkPush) === "available");
  // pushOwnedBy is what stops a non-active SIEM tile from rendering another vendor's active config as its own.
  const splunkView = { present: true, format: "splunk-hec", sink: "http" } as NonNullable<ConfigSnapshot["push"]>;
  ok("pushOwnedBy: Splunk owns a splunk-hec push, QRadar does NOT", pushOwnedBy(find("Splunk"), splunkView) === true && pushOwnedBy(find("QRadar"), splunkView) === false);
  ok("pushOwnedBy: nobody owns a not-present push", pushOwnedBy(find("Splunk"), { present: false } as NonNullable<ConfigSnapshot["push"]>) === false);
  const leefView = { present: true, format: "leef", sink: "syslog-tls" } as NonNullable<ConfigSnapshot["push"]>;
  ok("pushOwnedBy: Custom owns a push no named vendor claims (leef), not one Splunk claims", pushOwnedBy(customVendor, leefView) === true && pushOwnedBy(customVendor, splunkView) === false);

  console.log("-- ONE push lights ONE tile, because identity is the stored vendor tag and not the wire --");
  // THE DEFECT. Splunk and CrowdStrike Falcon Next-Gen SIEM both take splunk-hec over http, and tile identity
  // was `format === v.pushFormat && sink === v.pushSink`. So a single live Splunk push rendered BOTH tiles
  // Active and BOTH panels claimed the same config as their own. The config now records WHICH vendor it is.
  const taggedSplunk = { present: true, enabled: true, format: "splunk-hec", sink: "http", vendor: "splunk" } as NonNullable<ConfigSnapshot["push"]>;
  ok("pushOwnedBy: a TAGGED Splunk push is owned by Splunk", pushOwnedBy(splunkV, taggedSplunk) === true);
  ok("pushOwnedBy: the same tagged push is NOT owned by CrowdStrike Falcon (the co-light is gone)", pushOwnedBy(falconV, taggedSplunk) === false);
  const taggedFalcon = { present: true, enabled: true, format: "splunk-hec", sink: "http", vendor: vendorSlug(falconV) } as NonNullable<ConfigSnapshot["push"]>;
  ok("pushOwnedBy: and the reverse holds, a tagged Falcon push is Falcon's alone", pushOwnedBy(falconV, taggedFalcon) === true && pushOwnedBy(splunkV, taggedFalcon) === false);
  const taggedSnap: ConfigSnapshot = { ...EMPTY, push: taggedSplunk };
  ok("vendorState agrees with pushOwnedBy: Splunk live, Falcon available (they used to BOTH read live)", vendorState(splunkV, taggedSnap) === "live" && vendorState(falconV, taggedSnap) === "available");
  // The UNTAGGED fallback, stated as behaviour rather than left to be discovered: a destination stored before
  // the tag existed keeps the wire match, so an existing config keeps its tile rather than going dark. It is
  // the one place the old ambiguity survives, and it clears the moment the operator uses Replace.
  ok("an UNTAGGED push still falls back to the wire match, so an existing destination keeps its tile", pushOwnedBy(splunkV, splunkView) === true && pushOwnedBy(falconV, splunkView) === true);
  // A tag naming a vendor no longer in the catalogue (a renamed vendor) is claimed by NOBODY named, so the
  // Custom tile takes it: honest, and recoverable with one Replace, never a silent claim by the wrong vendor.
  const staleTag = { present: true, enabled: true, format: "splunk-hec", sink: "http", vendor: "splunk-renamed-away" } as NonNullable<ConfigSnapshot["push"]>;
  ok("a tag no catalogue vendor answers to is claimed by no named vendor, and the Custom tile takes it", pushOwnedBy(splunkV, staleTag) === false && pushOwnedBy(falconV, staleTag) === false && pushOwnedBy(customVendor, staleTag) === true);

  console.log("-- grid render --");
  const groups: TileGroup[] = byCat.map((g) => ({ category: g.category, tiles: g.vendors.map((v): IntegrationTile => ({ id: tileId(v), vendor: v, state: vendorState(v, splunkPush) })) }));
  const grid = renderIntegrationGrid(groups, () => "allowed", () => {}, null);
  ok("grid renders 40 tiles", grid.querySelectorAll(".idp-tile").length === 40);
  ok("grid shows the Auto-parses tag on the auto vendors", grid.querySelectorAll(".integration-autotag").length === CATALOGUE.filter((v) => v.auto).length);
  // PINNED TO THE TILE, not to the grid. This assertion used to read `grid.textContent.includes("Active")`
  // over the whole 40-tile grid, so it passed if ANY tile was Active, including if the Splunk tile had gone
  // blank, and it could never have caught the co-light it was named for. tileState() is read per tile.
  const tileLabel = (name: string): string => {
    const el = [...grid.querySelectorAll(".idp-tile")].find((t) => (t.getAttribute("aria-label") ?? "").startsWith(`${name},`));
    return el?.getAttribute("aria-label") ?? "";
  };
  ok("the SPLUNK tile itself reads active under the splunk push", /^Splunk, SIEM, active,/.test(tileLabel("Splunk")));
  const summary = connectedSummary(groups.flatMap((g) => g.tiles));
  ok("connected summary lists the live Splunk", summary !== null && (summary.textContent ?? "").includes("Splunk"));

  console.log("-- no two tiles announce themselves identically --");
  // THE DEFECT. The tile's accessible name was `${name}, ${state}, ${action}`, and a vendor name recurs across
  // categories, so Datadog's SIEM logs push and its OTLP metrics push both announced "Datadog, available, add":
  // two different controls opening two different setup panels, indistinguishable to anyone listing the controls
  // by voice or braille. 39 distinct labels over 40 tiles. tileId() already carried the category for exactly
  // this reason (grid.ts, "a vendor name can recur across categories"); the label did not.
  //
  // Asserted on the RENDERED grid rather than on a formatting helper, because the label is only a label once it
  // is on the button, and it is composed inline in tileButton.
  const emptyGroups: TileGroup[] = byCat.map((g) => ({ category: g.category, tiles: g.vendors.map((v): IntegrationTile => ({ id: tileId(v), vendor: v, state: vendorState(v, EMPTY) })) }));
  const emptyGrid = renderIntegrationGrid(emptyGroups, () => "allowed", () => {}, null);
  const emptyTiles = [...emptyGrid.querySelectorAll(".idp-tile")];
  const emptyLabels = emptyTiles.map((t) => t.getAttribute("aria-label") ?? "");
  // Guard against a vacuous pass: 40 tiles must actually have been read, and every one must carry a label.
  // Anti-vacuity, sized off the catalogue rather than off the literal 40. The count is pinned ONCE, at the
  // top of this file, which is that cell's whole job; repeating it here would make a new vendor break three
  // accessibility cells that have nothing to say about how many destinations we ship. What this asserts is
  // the invariant instead: every catalogue vendor got exactly one tile, and every tile got a name.
  ok(`all ${CATALOGUE.length} tiles were read and every one carries an accessible name`, emptyTiles.length === CATALOGUE.length && emptyLabels.every((l) => l.length > 0));
  const dupLabels = emptyLabels.filter((l, i) => emptyLabels.indexOf(l) !== i);
  ok(`every tile's accessible name is unique on the unconfigured screen (duplicates: ${dupLabels.join(" / ") || "none"})`, new Set(emptyLabels).size === emptyLabels.length);
  // The pair named rather than left to the count: both Datadogs are "available,
  // add" here, so state and action cannot be what tells them apart. Only the category can.
  const datadogLabels = emptyLabels.filter((l) => l.startsWith("Datadog,"));
  ok("The catalogue really does carry two Datadog tiles (the case the count is about)", datadogLabels.length === 2);
  ok("And the two Datadog tiles announce different names, each naming its category", datadogLabels.length === 2 && datadogLabels[0] !== datadogLabels[1] && datadogLabels.some((l) => l.includes("SIEM")) && datadogLabels.some((l) => l.includes("Metrics and observability")));
  // The name is still FIRST, so alphabetical control listing and "find the Datadog tile" both still work: the
  // category disambiguates, it does not bury the vendor.
  const emptyFlat = emptyGroups.flatMap((g) => g.tiles);
  ok("The vendor name still leads every label", emptyFlat.length === emptyLabels.length && emptyFlat.every((t, i) => emptyLabels[i]!.startsWith(`${t.vendor.name},`)));
  // Uniqueness must hold when the states DIVERGE too, not only on the uniform empty screen. A live SIEM push
  // makes one Datadog "active, manage" and leaves the other "available, add", which is the easy case; the hard
  // case is the one above, and both are pinned so a future label change cannot pass on the easy one alone.
  const splitGroups: TileGroup[] = byCat.map((g) => ({ category: g.category, tiles: g.vendors.map((v): IntegrationTile => ({ id: tileId(v), vendor: v, state: vendorState(v, splunkPush) })) }));
  const splitLabels = [...renderIntegrationGrid(splitGroups, () => "allowed", () => {}, null).querySelectorAll(".idp-tile")].map((t) => t.getAttribute("aria-label") ?? "");
  ok("Uniqueness also holds with a live push in play", new Set(splitLabels).size === splitLabels.length && splitLabels.length === CATALOGUE.length);

  console.log("-- the grid gates PER VENDOR, not one flag for all tiles --");
  // The grid's canManage is a per-vendor predicate: an operator (holds notify.config, not owner) can set up
  // a notify tile but NOT an owner-only SIEM push/pull tile. A single grid-wide `true` printed every tile as
  // "Add" and aria "add" even on owner-only tiles the setup panel then refuses (B36). Model the operator gate
  // (notify manageable, everything else owner-only) and assert the corner chip + aria tell the truth per tile.
  const opGrid = renderIntegrationGrid(groups, (v) => (v.kind === "notify" ? "allowed" : "refused"), () => {}, null);
  const tileAria = (name: string): string => {
    const el = [...opGrid.querySelectorAll(".idp-tile")].find((t) => (t.getAttribute("aria-label") ?? "").startsWith(`${name},`));
    return el?.getAttribute("aria-label") ?? "";
  };
  // Slack is a notify tile the operator CAN manage: "Add".
  const slackAria = tileAria("Slack");
  ok("An operator's notify tile (Slack) reads add-able", slackAria.includes("available") && slackAria.endsWith("add"));
  // QRadar is an owner-only SIEM push tile the operator CANNOT set up: "owner only", never "add".
  const qradarAria = tileAria("QRadar");
  ok("An operator's owner-only SIEM tile (QRadar) reads owner only, not add", qradarAria.endsWith("owner only") && !qradarAria.endsWith(", add"));
  // The corner chip mirrors it: the owner-only tile carries the "Owner" chip, not "Add".
  const qradarTile = [...opGrid.querySelectorAll(".idp-tile")].find((t) => (t.getAttribute("aria-label") ?? "").startsWith("QRadar,"));
  ok("The owner-only tile shows the Owner corner chip", (qradarTile?.textContent ?? "").includes("Owner"));
  // Negative control: with the all-true predicate, the SAME owner-only tile reads add-able (the old behaviour),
  // proving the per-vendor predicate is what changed the render, not the tile's own state.
  const qradarAllTrue = [...grid.querySelectorAll(".idp-tile")].find((t) => (t.getAttribute("aria-label") ?? "").startsWith("QRadar,"));
  ok("An all-true grid still prints the owner-only tile as add-able", (qradarAllTrue?.getAttribute("aria-label") ?? "").endsWith("add"));

  console.log("-- REFUSAL HONESTY: an UNREAD role is not a role refusal --");
  // THE DEFECT. canDo/canCap fail closed on an unresolved caller, which is right for a gate and wrong for a
  // SENTENCE. app.ts paints the screen and resolves the identity in parallel, so on every fresh load of
  // /integrations the gate ran with caller() null and the grid printed that default as the settled fact
  // "Owner" on all 40 tiles at once, with the accessible action "owner only", to an operator who is in fact
  // the owner: every available tile read "Owner" while whoami was in flight, and read "Add" once it landed.
  //
  // The population is asserted, not an absence: "no tile reads Owner" is also true of a grid that rendered
  // no tiles at all, and the grid is built from an async fan-out, so every cell below counts the tiles it
  // read and pins that count to the catalogue.
  const pendingGrid = renderIntegrationGrid(emptyGroups, () => "unresolved", () => {}, null);
  const pendingTiles = [...pendingGrid.querySelectorAll(".idp-tile")];
  const pendingChips = pendingTiles.map((t) => (t.querySelector(".integration-chip")?.textContent ?? "").trim());
  ok(`REFUSAL-HONESTY: all ${CATALOGUE.length} tiles rendered under an unresolved gate (the population, not an absence)`, pendingTiles.length === CATALOGUE.length);
  ok("REFUSAL-HONESTY: every available tile reads Checking while the identity is unread", pendingTiles.length === CATALOGUE.length && pendingChips.every((c) => c === "Checking"));
  ok("REFUSAL-HONESTY: not one tile asserts the Owner refusal from an unread role", pendingChips.length === CATALOGUE.length && !pendingChips.includes("Owner"));
  const pendingAria = pendingTiles.map((t) => t.getAttribute("aria-label") ?? "");
  ok("REFUSAL-HONESTY: the accessible action says the gate is being checked, never owner only", pendingAria.length === CATALOGUE.length && pendingAria.every((l) => l.endsWith("checking your permissions")));
  // The chip carries the remedy, so the state is not merely vague: it names what to do about it.
  const pendingTitles = pendingTiles.map((t) => t.querySelector(".integration-chip")?.getAttribute("title") ?? "");
  ok("REFUSAL-HONESTY: the pending chip names the reason and its remedy", pendingTitles.length === CATALOGUE.length && pendingTitles.every((t) => t.includes("has not reported your role") && t.includes("Reload this page")));
  // DISCRIMINATOR. The honest ROLE refusal is unchanged: a resolved caller who really cannot set the tile up
  // still reads "Owner" and "owner only", so the cells above pin the new state rather than deleting the old.
  const refusedGrid = renderIntegrationGrid(emptyGroups, () => "refused", () => {}, null);
  const refusedTiles = [...refusedGrid.querySelectorAll(".idp-tile")];
  const refusedChips = refusedTiles.map((t) => (t.querySelector(".integration-chip")?.textContent ?? "").trim());
  ok("REFUSAL-HONESTY discriminator: a RESOLVED refusal still reads Owner on every tile", refusedTiles.length === CATALOGUE.length && refusedChips.every((c) => c === "Owner"));
  ok("REFUSAL-HONESTY discriminator: and its accessible action still says owner only", refusedTiles.length === CATALOGUE.length && refusedTiles.every((t) => (t.getAttribute("aria-label") ?? "").endsWith("owner only")));
  // The PANEL a tile opens says the same thing the chip does, on all four owner-only setup kinds and on the
  // notify kind, so the two surfaces of one gate cannot drift.
  const pendingPush = renderSetupBody(stubEngine, find("Splunk"), "unresolved", EMPTY, () => {});
  ok("REFUSAL-HONESTY: the push panel says the gate is unread, not that the reader is not the owner", (pendingPush.textContent ?? "").includes("is not known yet") && !(pendingPush.textContent ?? "").includes("is owner only"));
  ok("REFUSAL-HONESTY: and it carries the same remedy the chip does", (pendingPush.textContent ?? "").includes("has not reported your role") && (pendingPush.textContent ?? "").includes("Reload this page"));
  const pendingPull = renderSetupBody(stubEngine, find("Microsoft Sentinel"), "unresolved", EMPTY, () => {});
  ok("REFUSAL-HONESTY: the pull panel says the gate is unread too", (pendingPull.textContent ?? "").includes("is not known yet") && !(pendingPull.textContent ?? "").includes("is owner only"));
  const pendingNotify = renderSetupBody(stubEngine, find("Slack"), "unresolved", EMPTY, () => {});
  ok("REFUSAL-HONESTY: the notify panel says the gate is unread, not that the capability is missing", (pendingNotify.textContent ?? "").includes("is not known yet") && !(pendingNotify.textContent ?? "").includes("needs the notifications capability"));
  // DISCRIMINATOR for the panels: a resolved refusal still states the role gate and its own remedy.
  const refusedPushPanel = renderSetupBody(stubEngine, find("Splunk"), "refused", EMPTY, () => {});
  ok("REFUSAL-HONESTY discriminator: a resolved push refusal still reads owner only", (refusedPushPanel.textContent ?? "").includes("is owner only") && !(refusedPushPanel.textContent ?? "").includes("is not known yet"));
  const refusedNotifyPanel = renderSetupBody(stubEngine, find("Slack"), "refused", EMPTY, () => {});
  ok("REFUSAL-HONESTY discriminator: a resolved notify refusal still names the capability and who grants it", (refusedNotifyPanel.textContent ?? "").includes("needs the notifications capability") && !(refusedNotifyPanel.textContent ?? "").includes("is not known yet"));
  // AND THE GATE ITSELF IS UNCHANGED: nothing above enables a control. An unresolved gate offers no form on
  // any of the five setup kinds, exactly as a refused one does.
  const pendingOffersNoForm = [pendingPush, pendingPull, pendingNotify].every((b) => ![...b.querySelectorAll("button")].some((btn) => /^Set up|^Add /.test((btn.textContent ?? "").trim())));
  ok("REFUSAL-HONESTY: an unresolved gate still offers no setup control (the gate is unchanged, only its wording)", pendingOffersNoForm);

  console.log("-- setup panel dispatch --");
  const pushBody = renderSetupBody(stubEngine, find("Splunk"), "refused", EMPTY, () => {});
  ok("a push vendor (non-owner) shows the owner gate", (pushBody.textContent ?? "").includes("owner only"));
  ok("a push vendor shows its method line", (pushBody.textContent ?? "").includes("HTTP Event Collector"));
  const pullBody = renderSetupBody(stubEngine, find("Microsoft Sentinel"), "refused", EMPTY, () => {});
  ok("a pull vendor shows the audit-feed URL", (pullBody.textContent ?? "").includes("/support/audit-feed"));
  const metricsBody = renderSetupBody(stubEngine, findIn("Prometheus", "Metrics and observability"), "refused", EMPTY, () => {});
  ok("a metrics vendor shows the /metrics endpoint", (metricsBody.textContent ?? "").includes("/metrics"));
  const notifyBody = renderSetupBody(stubEngine, find("Slack"), "allowed", EMPTY, () => {});
  ok("a notify vendor (with the capability) offers an Add button", (notifyBody.textContent ?? "").includes("Add Slack"));
  const slackNoRule: ConfigSnapshot = { ...EMPTY, channels: [slackCh] as ConfigSnapshot["channels"] };
  const bodyNoRule = renderSetupBody(stubEngine, find("Slack"), "allowed", slackNoRule, () => {});
  ok("a connected chat channel with NO rule warns nothing reaches it + offers to route", (bodyNoRule.textContent ?? "").includes("no alert rule sends events") && (bodyNoRule.textContent ?? "").includes("Choose what alerts Slack"));
  const slackRuled: ConfigSnapshot = { ...EMPTY, channels: [slackCh] as ConfigSnapshot["channels"], rules: [slackRule] as ConfigSnapshot["rules"] };
  const bodyRuled = renderSetupBody(stubEngine, find("Slack"), "allowed", slackRuled, () => {});
  ok("a connected chat channel WITH a routing rule shows the route count", (bodyRuled.textContent ?? "").includes("alert rule") && (bodyRuled.textContent ?? "").includes("route"));
  const autoBody = renderSetupBody(stubEngine, find("Datadog"), "refused", EMPTY, () => {});
  ok("an auto-parse vendor shows the Auto-parses note", (autoBody.textContent ?? "").includes("Auto-parses"));

  console.log("-- the credential rule on the form is the VENDOR's, and it is enforced --");
  // The push form is only reachable from a vendor tile, and it is owner-gated, so it is driven here with
  // canManage true. The form renders on click of "Set up <vendor>", so the panel is asked for its own body and
  // the button is pressed, exactly as an operator would.
  setCaller({ role: "owner", email: "owner@example.com", method: "access", subject: "s" } as never);
  const openPushFormFor = async (vendorName: string): Promise<HTMLElement> => {
    const body = renderSetupBody(stubEngine, find(vendorName), "allowed", EMPTY, () => {});
    // The panel paints its controls only when its card is CONNECTED (it refuses to write into a subtree the
    // operator has already navigated away from), so the body has to be in the document for the real form to
    // render. A detached render would paint nothing and every assertion below would be vacuous.
    document.body.appendChild(body as never);
    // The panel reads the current push view before it paints its controls, so the promise chain has to settle
    // before the "Set up <vendor>" button exists. A macrotask tick is the honest wait; a microtask is not
    // enough, and a test that skipped this would find no button and assert nothing.
    await new Promise((r) => setTimeout(r, 0));
    const setUp = [...body.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("Set up"));
    ok(`${vendorName}: the owner-gated "Set up" control is present (the form is reachable)`, setUp !== undefined);
    (setUp as HTMLButtonElement | undefined)?.click();
    await new Promise((r) => setTimeout(r, 0));
    return body;
  };
  const splunkForm = await openPushFormFor("Splunk");
  const splunkText = splunkForm.textContent ?? "";
  ok("the Splunk form states the HEC token's scheme where the token is pasted", splunkText.includes('paste it as "Splunk <token>"') && splunkText.includes("The bare token alone is not enough"));
  const falconForm = await openPushFormFor("CrowdStrike Falcon Next-Gen SIEM");
  const falconText = falconForm.textContent ?? "";
  // THE DEFECT: this note was toggled on `format === "splunk-hec"`, which Falcon shares, so the CrowdStrike
  // form told the operator to prefix a Falcon bearer token with the word Splunk. The assertion is on the
  // INSTRUCTION, not on the string "Splunk" anywhere in the panel: the endpoint field's hint legitimately names
  // a Splunk HEC collector as one example of an HTTP intake, and refusing that would be refusing the wrong
  // thing. What must not appear is a rule telling this operator to prefix their token.
  ok("the CrowdStrike Falcon form carries NO paste-it-as-Splunk instruction", !falconText.includes("paste it as") && !falconText.includes("The bare token alone is not enough"));
  ok("and the Falcon form does name its own credential (a bearer token)", falconText.toLowerCase().includes("bearer token"));
  // The enforcement, at the field, on blur: a bare HEC token is REFUSED on the Splunk form. This is the whole
  // of DEF1: before this, the field carried `required: true` and nothing else.
  const secretOf = (form: HTMLElement): HTMLInputElement | null => form.querySelector("#push-secret") as HTMLInputElement | null;
  // The shim's dispatchEvent takes a plain event-shaped object (its Event has read-only accessors), the same
  // shape test/validate-field-bounds.ts fireBlur uses, so the blur path field() listens for really runs.
  const blurAndReadError = (form: HTMLElement, typed: string): string => {
    const input = secretOf(form);
    if (!input) return "NO SECRET FIELD";
    input.value = typed;
    input.dispatchEvent({ type: "blur", target: input, currentTarget: input, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as never);
    const slot = form.querySelector("#push-secret-error");
    if (!slot) return "NO ERROR SLOT";
    return (slot as HTMLElement).hidden === true ? "" : ((slot.textContent ?? "").trim());
  };
  ok("the Splunk form HAS a push-secret control to check", secretOf(splunkForm) !== null);
  const bareErr = blurAndReadError(splunkForm, "12345678-abcd-1234-abcd-1234567890ab");
  ok("a BARE token on the Splunk form is refused at the field, naming the scheme and the remedy", bareErr.includes("must carry its scheme") && bareErr.includes("Splunk") && bareErr.includes("for example"));
  ok("and the refusal quotes no pattern, status code or function name (the message bar)", !/[\\^$*]|\b\d{3}\b|\(\)/.test(bareErr));
  const schemedErr = blurAndReadError(splunkForm, "Splunk 12345678-abcd-1234-abcd-1234567890ab");
  ok("a correctly-schemed HEC token is accepted (the rule discriminates, it does not just refuse)", schemedErr === "");
  // The same bare token is FINE on Falcon, whose credential has no scheme. A format-keyed rule would have
  // refused the correct Falcon credential.
  const falconBare = blurAndReadError(falconForm, "12345678-abcd-1234-abcd-1234567890ab");
  ok("the same bare token is ACCEPTED on the CrowdStrike Falcon form (its credential carries no scheme)", falconBare === "");

  console.log("-- a rule that survives its downpipe reaches nobody, and this panel must say so --");
  // The dangling-reference class: deleting a downpipe leaves the
  // notify rules scoped to it in place, matching nothing forever. Notifications says so at the rule's grain;
  // this is the OTHER surface reading the same rules, and it is the one that decides whether the "nothing
  // reaches this channel" warning is shown at all.
  const slack = find("Slack");
  ok("routeIsInert: a rule scoped to a DELETED downpipe is inert", routeIsInert(deadScopeRule as never, dpAlive) === true);
  ok("routeIsInert: a turned-off rule is inert", routeIsInert(disabledRule as never, dpAlive) === true);
  ok("routeIsInert: an enabled global rule is NOT inert", routeIsInert(slackRule as never, dpAlive) === false);
  ok("routeIsInert: a rule scoped to a LIVE downpipe is NOT inert", routeIsInert(liveScopeRule as never, dpAlive) === false);
  // The other direction, and the one that turns a transient fault into a screen full of false alarms: the
  // coordinator's downpipe read is best-effort and defaults to [], so an EMPTY list is "not known", never
  // "every downpipe is gone". Without this, a single failed listDownpipes would declare every per-downpipe
  // rule dead on every vendor panel at once.
  ok("an EMPTY downpipe list means NOT KNOWN, so a downpipe-scoped rule is not called dead", routeIsInert(deadScopeRule as never, [] as ConfigSnapshot["downpipes"]) === false);

  const snapDead: ConfigSnapshot = { ...EMPTY, channels: [slackCh] as ConfigSnapshot["channels"], rules: [deadScopeRule] as ConfigSnapshot["rules"], downpipes: dpAlive };
  const splitDead = rulesForVendor(slack, snapDead);
  ok("rulesForVendor splits the dead-scoped rule out of the live count", splitDead.live.length === 0 && splitDead.inert.length === 1);
  const snapMixed: ConfigSnapshot = { ...EMPTY, channels: [slackCh] as ConfigSnapshot["channels"], rules: [slackRule, deadScopeRule, disabledRule] as ConfigSnapshot["rules"], downpipes: dpAlive };
  const splitMixed = rulesForVendor(slack, snapMixed);
  ok("rulesForVendor keeps the one live rule live and both broken ones inert", splitMixed.live.length === 1 && splitMixed.inert.length === 2);

  // Keep the dead id visible: a marker that replaces the stored id with "unknown" is worse than the bug,
  // because the operator needs the id to find the row.
  const deadReason = inertRouteReason(deadScopeRule as never, dpAlive);
  ok("inertRouteReason names the rule id AND the dead downpipe id", deadReason.includes("r2") && deadReason.includes("dp-gone") && deadReason.includes("no longer exists"));
  ok("inertRouteReason distinguishes a turned-off rule from a dead scope", inertRouteReason(disabledRule as never, dpAlive) === "r3 is turned off");
  ok("inertRoutesText is null when every rule can still fire", inertRoutesText(slack, rulesForVendor(slack, { ...EMPTY, channels: [slackCh] as ConfigSnapshot["channels"], rules: [slackRule] as ConfigSnapshot["rules"], downpipes: dpAlive }), dpAlive) === null);
  const mixedText = inertRoutesText(slack, splitMixed, dpAlive) ?? "";
  ok("inertRoutesText names every dead rule and points at the rules tab", mixedText.includes("r2") && mixedText.includes("dp-gone") && mixedText.includes("r3") && mixedText.includes("Notifications rules tab"));
  // The headline must not say "no alert rule sends events to it YET" when a rule exists and has broken: that
  // wording sends the operator to add a second rule beside the one already there.
  ok("noLiveRouteText says nothing-reaches-it when rules exist but have stopped", noLiveRouteText(slack, splitDead).includes("stopped delivering") && !noLiveRouteText(slack, splitDead).includes("yet"));
  ok("noLiveRouteText keeps the original never-configured wording when there is genuinely no rule", noLiveRouteText(slack, rulesForVendor(slack, { ...EMPTY, channels: [slackCh] as ConfigSnapshot["channels"] })).includes("no alert rule sends events to it yet"));

  // The render, which is what the operator actually sees.
  const deadBody = renderSetupBody(stubEngine, slack, "allowed", snapDead, () => {});
  const deadText = deadBody.textContent ?? "";
  ok("a channel whose ONLY rule is dead-scoped does NOT claim a route", !deadText.includes("route events to Slack"));
  ok("a channel whose ONLY rule is dead-scoped keeps the fix-it action", deadText.includes("Choose what alerts Slack"));
  ok("the dead route is named on the panel, with its downpipe id", deadText.includes("dp-gone") && deadText.includes("no longer exists"));
  // Negative control: the SAME rule against a downpipe that still exists renders as an ordinary live route,
  // proving it is the missing downpipe that changed the render and not the rule's shape.
  const aliveSnap: ConfigSnapshot = { ...snapDead, downpipes: [{ config: { id: "dp-gone" } }] as unknown as ConfigSnapshot["downpipes"] };
  const aliveText = renderSetupBody(stubEngine, slack, "allowed", aliveSnap, () => {}).textContent ?? "";
  ok("negative control: the same rule with its downpipe PRESENT reads as a live route", aliveText.includes("1 alert rule route") && !aliveText.includes("no longer exists"));
  // A live rule beside a dead one: the count is of the live rule only, and the dead one is still named.
  const mixedText2 = renderSetupBody(stubEngine, slack, "allowed", snapMixed, () => {}).textContent ?? "";
  ok("a live rule beside two broken ones counts one route and still names both broken rules", mixedText2.includes("1 alert rule route") && mixedText2.includes("dp-gone") && mixedText2.includes("r3"));

  console.log("-- closing a detail panel returns focus to the tile it was opened from --");
  // THE DEFECT. The screen managed focus in ONE direction: openTile -> renderDetail focused the panel's
  // tabindex="-1" section, and closeDetail focused nothing at all. A keyboard or screen-reader operator who
  // opened Splunk and pressed "All integrations" was dropped on <body> and had to traverse the whole page to
  // get back to the tile they were on. Because the open half exists, the missing half is an omission.
  //
  // The trap the fix has to clear, and the reason this cell drives the REAL screen rather than calling a
  // helper: closeDetail calls loadAll(), which with no selection replaces the grid with skeleton tiles
  // synchronously and rebuilds the tiles only once six reads settle. Focusing the tile inside closeDetail
  // focuses a node that is detached moments later, and the browser (and this shim, dom-shim-core.ts) then
  // drops activeElement back to <body>. So the assertion is taken AFTER the settle, on the rebuilt tile.
  setCaller({ role: "owner", email: "owner@example.com", method: "access", subject: "s" } as never);
  store.connect("https://engine.test");
  const liveEngine = store.getEngine() as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(stubEngine as unknown as Record<string, unknown>)) {
    if (typeof v === "function") liveEngine[k] = v;
  }
  const screenRoot = integrationsScreen.render({} as never);
  document.body.appendChild(screenRoot as never);
  markConnected(screenRoot as unknown as never);
  await flushAsync();
  const tileNamed = (id: string): HTMLElement | undefined =>
    [...screenRoot.querySelectorAll(".idp-tile")].find((t) => t.getAttribute("data-tile") === id) as HTMLElement | undefined;
  const OPENED = "SIEM::Splunk";
  const openedTile = tileNamed(OPENED);
  // Refuse the EMPTY and the ERROR renders by name. An unwired engine paints a banner into the same region
  // and no tiles at all, and every assertion below would then be about nothing.
  ok("The screen painted its real tile grid (not the skeleton, the session-ended view or the not-wired banner)", screenRoot.querySelectorAll(".idp-tile").length === CATALOGUE.length && screenRoot.querySelectorAll(".skeleton").length === 0);
  ok(`the ${OPENED} tile is present and carries its id`, openedTile !== undefined);
  openedTile?.click();
  const detailPanelEl = screenRoot.querySelector(".idp-detail") as HTMLElement | null;
  ok("Opening a tile paints its detail panel", detailPanelEl !== null);
  // The OTHER half of the pair, asserted so this cell also fails if someone "fixes" the close by deleting the
  // open half's focus move. Focus must be IN the panel after opening.
  ok("Opening moves focus into the detail panel (the half that already existed)", activeElement() === (detailPanelEl as unknown));
  const backBtn = [...screenRoot.querySelectorAll("button")].find((b) => b.getAttribute("data-dp") === "integrations.button.back") as HTMLElement | undefined;
  ok("The panel offers the back control the operator presses", backBtn !== undefined);
  backBtn?.click();
  await flushAsync();
  // Re-query: the close re-rendered the grid, so the tile the operator returns to is a NEW node.
  const reborn = tileNamed(OPENED);
  const landedOn = activeElement() as unknown as { getAttribute?: (k: string) => string | null; tagName?: string } | null;
  ok("The grid came back after the close (the tile exists to return to)", reborn !== undefined);
  // The observed symptom, refused by name: focus can land on <body> instead of the tile.
  ok(`focus is NOT dropped to <body> on close (landed on ${landedOn?.tagName ?? "null"})`, landedOn !== null && landedOn.tagName !== "BODY");
  ok("Focus is returned to the very tile the panel was opened from", landedOn !== null && (landedOn as unknown) === (reborn as unknown));
  // And it is a node still in the document, not a detached one: focusing a torn-down tile reads as a pass on
  // identity while the operator's next keystroke goes to <body>.
  ok("And that tile is attached to the document", reborn !== undefined && document.body.contains(reborn as never));
  ok("The detail panel is gone and the select hint is back", screenRoot.querySelector(".idp-detail") === null && (screenRoot.textContent ?? "").includes("Select a destination above to connect it."));

  console.log(failures === 0 ? "\nINTEGRATIONS SCREEN PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
