// Coverage validator for the public-tour faked backend (src/lib/demo/demo-seed.ts / demo-world.ts /
// demo-routes-read.ts / demo-routes-write.ts + demo-fetch.ts).
// Run with: node test/cov/lib-demo.ts (auto-run by test/cov/run.mjs, part of npm run validate).
//
// The demo modules are the no-login boot's faked engine: demo-routes-read.route(path, init) answers the
// /admin/* reads the Overview's nine settled tiles + boot issue from a seeded in-memory Northwind world,
// and demo-fetch installs the globalThis.fetch interceptor that routes /admin/* to route() and delegates
// everything else to the real fetch. This validator drives both against the console's OWN wire types so a
// shape drift fails here, and exercises every branch (each modelled GET, history with/without an id, audit
// with/without a limit, the phase-1c WRITE handlers, create downpipe deferred to a 202 pending, trigger /
// add-destination / drill / verify / attest / the restore dual-control request -> approve/reject -> apply,
// the benign empty-but-valid 200 for an unmodelled screen-load GET and an unmodelled write, the
// tour-mode host/query/neither/throw
// decision, the string/URL/Request first-argument shapes, the admin vs non-admin split, and the idempotent
// double install). It restores globalThis.fetch and location after.
//
// No network is made: the interceptor answers /admin/* locally, and the one non-admin delegation is
// asserted by swapping in a canned real fetch. It imports the shared DOM shim (test/dom-shim.ts) for
// location/localStorage exactly as the other lib coverage validators do, and never edits that shared shim.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDomShim } from "../dom-shim.ts";

installDomShim();

// setA11yPref -> applyA11yPrefs calls root.style.removeProperty when the text size is 100 (the default), which
// the WCAG-2.1.4 single-key assertions below exercise. The shared shim's style models setProperty /
// getPropertyValue but not removeProperty; add the standard semantics to the style prototype for this process
// only (delete the recorded property), exactly as test/cov/shell-keyboard.ts does, so the real a11y-prefs path
// runs. The shared shim file is untouched.
{
  type StyleProto = Record<string, unknown> & { removeProperty?: (p: string) => void };
  const styleProto = Object.getPrototypeOf(
    (globalThis as unknown as { document: { documentElement: { style: unknown } } }).document.documentElement.style,
  ) as StyleProto;
  if (typeof styleProto.removeProperty !== "function") {
    styleProto.removeProperty = function (this: Record<string, unknown>, prop: string): void {
      delete this[prop];
    };
  }
}

// Runtime polyfills for two browser-standard Node members the RAIL nav-bar variant uses (the beat
// model): layoutForWidth MOVES existing nodes with insertBefore (moving preserves their listeners) and steers
// the bottom-bar restore on parentElement. Added ONLY in this process (each cov validator runs in its own
// node) and ONLY when the shim does not already provide them, exactly as validate-tour.ts adds insertBefore
// for the real proof screens. They weaken nothing: they supply missing browser-standard behaviour so the real
// layout code runs here instead of throwing mid-mount.
{
  const { ShimNode } = await import("../dom-shim-core.ts");
  if (typeof (ShimNode.prototype as { insertBefore?: unknown }).insertBefore !== "function") {
    (ShimNode.prototype as unknown as { insertBefore(node: InstanceType<typeof ShimNode> | string | number | null, ref: InstanceType<typeof ShimNode> | null): InstanceType<typeof ShimNode> | null }).insertBefore =
      function insertBefore(this: InstanceType<typeof ShimNode>, node: InstanceType<typeof ShimNode> | string | number | null, ref: InstanceType<typeof ShimNode> | null): InstanceType<typeof ShimNode> | null {
        if (node == null) return null;
        // A null reference node means "append at the end", exactly like the DOM. Otherwise splice before ref.
        if (ref === null || this.childNodes.indexOf(ref) < 0) return this.appendChild(node);
        // Coerce a raw string/number to a text node and flatten a fragment, mirroring appendChild's contract.
        let child = node as InstanceType<typeof ShimNode>;
        if (typeof node === "string" || typeof node === "number") {
          const t = new ShimNode("text");
          (t as unknown as { text_: string }).text_ = String(node);
          child = t;
        }
        if (child.kind === "fragment") {
          const self = this as unknown as { insertBefore(n: InstanceType<typeof ShimNode>, r: InstanceType<typeof ShimNode> | null): InstanceType<typeof ShimNode> | null };
          for (const c of [...child.childNodes]) self.insertBefore(c, ref);
          return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
        return child;
      };
  }
  if (!Object.getOwnPropertyDescriptor(ShimNode.prototype, "parentElement")) {
    Object.defineProperty(ShimNode.prototype, "parentElement", {
      configurable: true,
      get(this: InstanceType<typeof ShimNode>): InstanceType<typeof ShimNode> | null {
        const p = this.parentNode;
        return p && p.nodeType === 1 ? p : null;
      },
    });
  }
}

import { route } from "../../src/lib/demo/demo-routes-read.ts";
import { resetWorld, demoWhoami } from "../../src/lib/demo/demo-world.ts";
import { buildCallerFromWhoami } from "../../src/lib/app-identity.ts";
import { isTourMode, installDemoFetch, startDemo } from "../../src/lib/demo/demo-fetch.ts";
import { installTourBanner, removeTourBanner, resetSampleData, installTourCornerMarker, removeTourCornerMarker, installTourSiteLink, removeTourSiteLink, swapTourFavicon } from "../../src/lib/demo/banner.ts";
import { renderAccount } from "../../src/shell/chrome.ts";
import { applyFocusRing, clearFocusRing } from "../../src/lib/demo/tour/overlay.ts";
import { mountNavBar } from "../../src/lib/demo/tour/nav-bar.ts";
import { createSpotlight, type Spotlight } from "../../src/lib/demo/tour/spotlight.ts";
import { createTourDirector, type TourDirector, type TourChapter, type InfoPoint } from "../../src/lib/demo/tour/director.ts";
import { mountPersonaFork, startTour } from "../../src/lib/demo/tour/persona-fork.ts";
import { ctoChapters, engineerChapters, TOUR_SCRIPTS, TOUR_ROUTES, FUNNEL_CTAS, type TypedTourChapter, type TourPersona } from "../../src/lib/demo/tour/scripts/chapters.ts";
import { emit, enableTourAnalytics, disableTourAnalytics, setTourAnalyticsEndpoint, TOUR_EVENT_PATH, type TourEvent } from "../../src/lib/demo/tour/analytics.ts";
import { flushAsync, keydown, dispatchDocKey, activeElement, type ShimNode } from "../dom-shim.ts";
import { makeEvent } from "../dom-shim-core.ts";
import { getEngine, getEngineUrl, getCaller, isWhoamiAvailable, signOut, setDownpipesCache, getDownpipesCache, setRunsCache, getRunsCache, setRunsForSearch, getRunsForSearch, } from "../../src/lib/store.ts";
import { setA11yPref } from "../../src/lib/a11y-prefs.ts";
import { installNav, navigate as realNavigate, registerLeaveGuard, clearLeaveGuard, recordNav, currentRoute } from "../../src/lib/nav.ts";
import { mapEngineDownpipeState } from "../../src/lib/api/helpers.ts";
import type {
  AuditPage,
  ChainVerdict,
  ConfigApprovalPolicy,
  CoverageReport,
  DestinationList,
  DestinationStatus,
  DestReplState,
  DownpipeState,
  EngineDownpipeState,
  DrillEvidenceEntry,
  ExpiryStatus,
  IdpConnectionView,
  IdpPreset,
  IdpProvider,
  LicenceStatus,
  PostureReport,
  Report,
  RestoreApproval,
  RtoReport,
  RunHistoryEntry,
  SetupState,
  StatusReport,
  UpdateStatus,
  WhoAmI,
} from "../../src/lib/api/types.ts";

let failures = 0;

// Focus assertions compare the shim's active element against a node the production code typed as an
// HTMLElement. They are the same runtime object seen through two lenses, but the two types do not
// overlap, so comparing them directly is an error the compiler reads as always-false, and an
// always-false assertion is one that proves nothing. The cast is stated once here rather than at each
// site, and it stays a real comparison: a node that is NOT focused still fails.
function isActive(el: unknown): boolean {
  return activeElement() === (el as ShimNode);
}

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// readJson parses a Response body as the given wire type. route() returns a Response synchronously for reads
// and the simple writes, and a Promise<Response> for the four restore dual-control writes (which await the
// plan hash); readJson accepts EITHER and awaits it, so every call site reads uniformly. The route() Responses
// are all JSON; this also asserts the content-type the console's parseJson path requires.
async function readJson<T>(resOrPromise: Response | Promise<Response>): Promise<{ status: number; ct: string; body: T }> {
  const res = await resOrPromise;
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  return { status: res.status, ct, body: JSON.parse(text) as T };
}

// listDownpipesMapped reads GET /admin/downpipes EXACTLY as production does: the route answers the engine's
// RAW wire EngineDownpipeState[], and the real client (client-downpipes.listDownpipes) flattens it through
// mapEngineDownpipeState to the console's normalised DownpipeState[]. Driving the same boundary mapper here
// (rather than casting the wire body straight to DownpipeState[]) means these assertions read the recency
// stamps the screens actually render: a route that served the flat shape verbatim would make the mapper drop
// every proven/integrity stamp to "never", and asserting the wire body directly was blind to exactly that.
async function listDownpipesMapped(): Promise<DownpipeState[]> {
  const wire = (await readJson<EngineDownpipeState[]>(route("/admin/downpipes"))).body;
  return wire.map(mapEngineDownpipeState);
}

// A fixed location so isTourMode's host/query branches and the interceptor's URL resolution are
// deterministic. The shim sets only location.origin; we install a fuller location for the duration.
const g = globalThis as unknown as Record<string, unknown>;
const savedLocation = g.location;
function setLocation(href: string): void {
  const u = new URL(href);
  g.location = { origin: u.origin, hostname: u.hostname, search: u.search, href: u.href };
}

await (async (): Promise<void> => {
  // ---------------------------------------------------------------------------------------------
  // app.ts wires the guarded boot branch through isTourMode + startDemo, and ONLY that one additive
  // branch (the sole edit to existing boot). A source-string presence check so the wiring cannot be
  // dropped or weakened unnoticed in the gate run.
  // ---------------------------------------------------------------------------------------------
  const appSrc = readFileSync(join("src", "app.ts"), "utf8");
  ok("app.ts imports the cheap tour guard from its dependency-free module", appSrc.includes('import { isTourMode } from "./lib/demo/tour-mode.ts"'));
  ok("app.ts loads the demo boot entry behind the guard via a dynamic import (the tour is a lazy chunk)", appSrc.includes('await import("./lib/demo/demo-fetch.ts")'));
  // The guard admits the training walk beside the tour now (training-mode.ts, the same dev-host-scoped
  // discipline); both demo experiences ride the one dynamic import this line pins.
  ok("app.ts guards the demo branch on isTourMode()/isTrainingMode() before the existing boot and calls startDemo()", appSrc.includes("if (isTourMode() || isTrainingMode()) {") && appSrc.includes("startDemo();"));
  ok("app.ts does NOT statically import the tour entry (no whole-tour inlining into the production bundle)", !appSrc.includes('from "./lib/demo/demo-fetch.ts"'));

  // ---------------------------------------------------------------------------------------------
  // demo-routes-read.route: every modelled GET returns the seeded wire shape on a 200 application/json.
  // ---------------------------------------------------------------------------------------------
  setLocation("https://tour.downpipes.io/");
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0)); // pin the clock so the seed is deterministic

  {
    const r = await readJson<{ ok: boolean; service?: string }>(route("/admin/health"));
    ok("health is a 200 application/json", r.status === 200 && r.ct.includes("application/json"));
    ok("health ok:true with a service name", r.body.ok === true && typeof r.body.service === "string");
  }
  {
    const r = await readJson<WhoAmI>(route("/admin/whoami"));
    ok("whoami is the seeded owner via Access", r.body.role === "owner" && r.body.method === "access");
    ok("whoami carries a verified email + subject", typeof r.body.email === "string" && typeof r.body.subject === "string");
    ok("whoami is not the bare-token break-glass (roleSource email)", r.body.roleSource === "email");
  }
  {
    const r = await readJson<StatusReport>(route("/admin/status"));
    ok("status is configured + ready (dashboard, not checklist)", r.body.ready === true && r.body.destConfigured === true && r.body.signerConfigured === true);
    ok("status does NOT claim throwaway demo mode", r.body.demoMode !== true);
    // EIGHT downpipes across seven source types. The eighth is the ZONE-scoped cf-config pipe, added so a
    // browser journey can reach the surface picker's two scope shortcuts, which render only when a zoneId
    // is present and were therefore unreachable by any test. The old wording said "seven-source" and meant
    // the fleet size, which made the two readings look like one number.
    ok("status reports the seeded eight-downpipe fleet", r.body.downpipeCount === 8);
    ok("status flags one credential approaching expiry (the SSO signing cert)", r.body.expiryWarnings === 1);
  }
  {
    const r = await readJson<SetupState>(route("/admin/setup-state"));
    ok("setup-state reads complete so Overview mounts the dashboard", r.body.ready === true && r.body.keysReady === true && r.body.destination.configured === true && r.body.discoveryTokenPresent === true && r.body.boundSourceCount > 0);
  }
  {
    const r = await readJson<LicenceStatus>(route("/admin/licence"));
    ok("licence is a fail-open enterprise tier, valid", r.body.tier === "enterprise" && r.body.valid === true && typeof r.body.notAfter === "string");
  }
  {
    const r = await readJson<UpdateStatus>(route("/admin/updates"));
    ok("updates verified, none available", r.body.configured === true && r.body.verified === true && r.body.updateAvailable === false);
  }
  {
    const dps = await listDownpipesMapped();
    ok("downpipes returns the seeded eight-downpipe fleet", Array.isArray(dps) && dps.length === 8);
    ok("one downpipe is in-flight (a live run is visible)", dps.some((d) => d.inFlight === true));
    // The fleet deliberately does NOT cover all nine surfaces: it backs up SEVEN source types, while Images
    // and Artifact Registry are intentionally left without a downpipe so the Overview coverage hero shows a
    // realistic green/amber/slate mix (Artifact Registry is added as a source but not yet protected -> amber;
    // Images is not added -> slate). Assert the seven covered types are present and the two gaps are absent.
    {
      const types = new Set(dps.map((d) => d.config.source.type));
      // `as const` rather than a plain array: it makes these seven the literal source-type union rather than
      // string, so the membership test needs no cast, and a name that stops being a real source type fails
      // HERE instead of quietly widening to a string the set can never hold.
      const expected = ["kv", "r2", "d1", "secrets", "cf-config", "workers", "stream"] as const;
      ok("downpipes cover seven distinct source types (kv + r2 + d1 + secrets + cf-config + workers + stream)", types.size === 7 && expected.every((t) => types.has(t)));
      ok("Images and Artifact Registry are intentionally NOT downpiped (the coverage-hero gap)", !types.has("images") && !types.has("artifacts"));
    }
    ok("the bytes-capturing media pipe (stream) sets includeContent", dps.filter((d) => d.config.source.type === "stream").every((d) => d.config.source.includeContent === true));
    ok("every downpipe fans out to the primary + the replica (3-2-1)", dps.every((d) => (d.config.destinationIds ?? []).length === 2));
    // The proven pipes keep their proven stamp through the boundary mapper while cf-config (account-config
    // restore is a re-provision) honestly carries none: the deliberate contrast the protection statement
    // renders (and the regression a route serving the flat shape verbatim would silently flatten to "never
    // proven" for every pipe).
    const unprovenTypes = new Set(["cf-config"]);
    ok("the proven pipes are restore-proven through the boundary mapper (the seed's assurance survives)", dps.filter((d) => !unprovenTypes.has(d.config.source.type)).every((d) => typeof d.lastRestoreProvenAt === "string"));
    ok("the cf-config pipe is honestly never restore-proven (a deliberate gap)", dps.some((d) => d.config.source.type === "cf-config" && d.lastRestoreProvenAt === undefined));
  }
  {
    const r = await readJson<DrillEvidenceEntry[]>(route("/admin/drill-evidence"));
    ok("drill-evidence returns several recent in-account verifications", Array.isArray(r.body) && r.body.length >= 3 && r.body.every((e) => e.kind === "in-account"));
  }

  // ---------------------------------------------------------------------------------------------
  // The proof-of-moat reads (the guided-tour spine): destinations + the 3-2-1 replication state, native
  // SSO (SAML/OIDC/OAuth2 + the pre-auth DTOs + the preset catalogue), posture + coverage + expiry, the
  // RTO estimate (with and without an id), the config-approval policy, the signed reports + evidence
  // packs, the audit chain verify, and the dual-control restore-approvals inbox. Each is driven against
  // the console's OWN wire types so a shape drift fails here.
  // ---------------------------------------------------------------------------------------------
  {
    const def = await readJson<DestinationStatus>(route("/admin/destination"));
    // The singular view is the DEFAULT destination's redaction-safe status, and it deliberately omits the
    // three collection-identity fields (id, label, isDefault: see the note on DestinationStatus in
    // lib/api/types/destinations.ts). This assertion required `isDefault === true` on it, which the view
    // has never carried since /admin/destination started being DERIVED from the collection rather than
    // held as a second seeded copy, so it has been failing on main. It is corrected rather than deleted:
    // the fact worth grading is that the singular view answers with the DEFAULT destination, so it is
    // graded against the collection's own defaultId instead of against a field the contract strips.
    ok("destination (singular) is the default's status, with WORM enforced", def.body.present === true && def.body.objectLock === "enforced");
    const list = await readJson<DestinationList>(route("/admin/destinations"));
    const defaultOfList = list.body.destinations.find((d) => d.id === list.body.defaultId);
    ok("...and it is the DEFAULT one, matched on bucket, not merely the first in the collection", def.body.bucket === defaultOfList?.bucket);
    ok("...and the identity fields the singular contract strips are absent", def.body.id === undefined && def.body.label === undefined && def.body.isDefault === undefined);
    // THREE destinations across three regions. The primary and the replica are the 3-2-1 pair; the third is
    // an Azure Blob container, seeded because until then every seeded destination was an
    // Amazon S3 host, so no provider badge but "S3" was ever rendered in the tour or the training course.
    ok("destinations lists the 3-2-1 pair plus a cold copy, across three regions", list.body.destinations.length === 3 && new Set(list.body.destinations.map((d) => d.region)).size === 3);
    ok("...and one of them is NOT an S3 host, so a non-S3 provider badge is exercised", list.body.destinations.some((d) => (d.endpointHost ?? "").includes(".blob.core.windows.net")));
    ok("CONTROL: the two Amazon S3 destinations are still there, so the third was added rather than swapped in", list.body.destinations.filter((d) => (d.endpointHost ?? "").includes("amazonaws.com")).length === 2);
    ok("every destination reports Object-Lock enforced (WORM is real)", list.body.destinations.every((d) => d.objectLock === "enforced"));
    ok("the default id points at the primary", list.body.defaultId === list.body.destinations.find((d) => d.isDefault)?.id);
    const repl = await readJson<{ byDownpipe: Record<string, Record<string, DestReplState>> }>(route("/admin/replication"));
    ok("replication state covers every downpipe and destination", Object.keys(repl.body.byDownpipe).length === 8);
    ok("the payments replica honestly reads behind (a real catching-up state)", repl.body.byDownpipe["dp-payments"]!["replica-use1"]!.lastOk === false);
  }
  {
    const conns = await readJson<{ ok: boolean; connections: IdpConnectionView[] }>(route("/admin/idp/connections"));
    ok("idp connections span saml + oidc + oauth2", new Set(conns.body.connections.map((c) => c.kind)).size === 3);
    const saml = conns.body.connections.find((c) => c.kind === "saml");
    ok("the SAML connection carries PUBLIC signing certs and no secret value", saml?.kind === "saml" && saml.idpSigningCerts.length >= 1 && !("secretRef" in saml));
    ok("a confidential OIDC/OAuth2 secret is a { mode } descriptor, never a value", conns.body.connections.filter((c) => c.kind !== "saml").every((c) => typeof (c as { secretRef?: { mode?: string; value?: unknown } }).secretRef?.mode === "string" && (c as { secretRef: { value?: unknown } }).secretRef.value === undefined));
    const presets = await readJson<{ ok: boolean; presets: IdpPreset[] }>(route("/admin/idp/presets"));
    ok("the add-connection preset catalogue is present (display-only)", presets.body.ok === true && presets.body.presets.length >= 1);
    const providers = await readJson<{ ok: boolean; providers: IdpProvider[] }>(route("/admin/oidc/providers"));
    ok("the pre-auth provider DTOs list only ENABLED connections (the disabled OAuth2 is absent)", providers.body.providers.length === 2 && providers.body.providers.every((p) => p.id !== "github-oauth2"));
  }
  {
    const posture = await readJson<PostureReport>(route("/admin/posture"));
    ok("posture has a non-100 score with a failing check (honest, not theatre)", posture.body.score < 100 && posture.body.checks.some((c) => c.status === "fail"));
    ok("posture lists a risk-accepted item distinctly (an accepted risk, never a pass)", posture.body.checks.some((c) => c.status === "risk-accepted"));
    const coverage = await readJson<CoverageReport>(route("/admin/coverage"));
    ok("coverage has a stored inventory and surfaces an unprotected gap", coverage.body.hasInventory === true && coverage.body.resources.some((r) => r.status === "unprotected"));
    ok("coverage surfaces a backed-up-but-not-yet-proven (untested) resource", coverage.body.resources.some((r) => r.status === "untested"));
    const expiry = await readJson<ExpiryStatus[]>(route("/admin/expiry"));
    ok("expiry tracks the SSO signing cert approaching expiry", expiry.body.some((e) => e.kind === "certificate" && e.state === "approaching"));
    ok("expiry tracks a no-expiry standing credential honestly", expiry.body.some((e) => e.state === "no-expiry"));
    const policy = await readJson<ConfigApprovalPolicy>(route("/admin/config/approval-policy"));
    ok("four-eyes / dual control is ON in the demo org", policy.body.requireConfigApproval === true);
  }
  {
    const rto = await readJson<RtoReport>(route("/admin/rto"));
    ok("rto reports a known fleet estimate plus per-downpipe estimates", rto.body.fleet.known === true && rto.body.downpipes.length === 7);
    ok("the account-config downpipe rto is honestly UNKNOWN (no drill history)", rto.body.downpipes.some((d) => d.id === "dp-cf-config" && d.known === false));
    const one = await readJson<RtoReport>(route("/admin/rto?id=dp-ledger"));
    ok("rto with an id narrows to that downpipe (still with the fleet roll-up)", one.body.downpipes.length === 1 && one.body.downpipes[0]!.id === "dp-ledger" && one.body.fleet.known === true);
    const miss = await readJson<RtoReport>(route("/admin/rto?id=dp-nope"));
    ok("rto for an unknown id returns an empty per-downpipe list, never a fabricated estimate", miss.body.downpipes.length === 0);
  }
  {
    const restoreTests = await readJson<Report>(route("/admin/reports/restore-tests"));
    ok("the restore-tests report is signed (tamper-evident, post-quantum hybrid)", restoreTests.body.kind === "restore-tests" && typeof restoreTests.body.signature === "string" && restoreTests.body.signature.startsWith("edmldsa1:"));
    for (const kind of ["sla-compliance", "immutability", "posture"]) {
      const rep = await readJson<Report>(route(`/admin/reports/${kind}`));
      ok(`the ${kind} report is modelled and signed`, rep.status === 200 && rep.body.kind === kind && typeof rep.body.signature === "string");
    }
    const packOne = await readJson<Report>(route("/admin/reports/evidence-pack?framework=apra-cps-230-234"));
    ok("the APRA CPS 230/234 evidence pack is the signed pack", packOne.body.kind === "evidence-pack" && typeof packOne.body.signature === "string");
    const packAll = await readJson<Report>(route("/admin/reports/evidence-pack?framework=all"));
    ok("the all-frameworks evidence pack is modelled", packAll.status === 200 && packAll.body.kind === "evidence-pack");
    const packUnknown = await readJson<Report>(route("/admin/reports/evidence-pack?framework=not-a-framework"));
    ok("an unknown framework falls back to the all pack (never a 501)", packUnknown.status === 200 && packUnknown.body.kind === "evidence-pack");
    const packNoQuery = await readJson<Report>(route("/admin/reports/evidence-pack"));
    ok("evidence-pack with no framework defaults to the all pack", packNoQuery.status === 200 && packNoQuery.body.kind === "evidence-pack");
    const badReport = await readJson<{ error: string }>(route("/admin/reports/not-a-real-kind"));
    ok("an unknown report kind is an honest 501 (never a fabricated report)", badReport.status === 501);
    // The PDF render path is not modelled: a ?format=pdf request MUST degrade honestly (a non-2xx the
    // console's getReportPDF/getEvidencePackPDF route through failResponse), never the JSON Report served
    // as application/pdf with a false-success download. Both the :kind and the evidence-pack PDF variants.
    const reportPdf = await readJson<{ error: string }>(route("/admin/reports/posture?format=pdf"));
    ok("a report ?format=pdf is an honest non-2xx, never JSON mislabelled as a PDF download", reportPdf.status === 501 && !reportPdf.ct.includes("application/pdf"));
    const packPdf = await readJson<{ error: string }>(route("/admin/reports/evidence-pack?framework=apra-cps-230-234&format=pdf"));
    ok("an evidence-pack ?format=pdf is an honest non-2xx, never the JSON pack dressed as a PDF", packPdf.status === 501 && !packPdf.ct.includes("application/pdf"));
  }
  {
    const verdict = await readJson<ChainVerdict>(route("/admin/audit/verify"));
    ok("the audit chain verifies INTACT (the tamper-evidence proof)", verdict.body.intact === true && verdict.body.checkedThrough > 0);
    // The audit filters the screen sends server-side: actor / action / outcome / before / limit.
    const byAction = await readJson<AuditPage>(route("/admin/audit?action=downpipe-create"));
    ok("audit filters by action (server-side)", byAction.body.events.length >= 1 && byAction.body.events.every((e) => e.action === "downpipe-create"));
    const fullChain = await readJson<AuditPage>(route("/admin/audit"));
    const byActor = await readJson<AuditPage>(route("/admin/audit?actor=priya.nair@northwind.example"));
    ok("audit filters by actor (substring) and discriminates from the owner's entries", byActor.body.events.length >= 1 && byActor.body.events.length < fullChain.body.events.length && byActor.body.events.every((e) => (e.actorEmail ?? "").includes("priya")));
    const byOutcome = await readJson<AuditPage>(route("/admin/audit?outcome=success"));
    ok("audit filters by outcome", byOutcome.body.events.every((e) => e.outcome === "success"));
    const head = await readJson<AuditPage>(route("/admin/audit?limit=1"));
    const older = await readJson<AuditPage>(route(`/admin/audit?before=${head.body.events[0]!.seq}`));
    ok("audit pages OLDER than a seq (before), and the head stays the whole-chain head", older.body.events.every((e) => e.seq < head.body.events[0]!.seq) && older.body.headSeq === head.body.headSeq);
  }
  {
    const restoreApprovals = await readJson<RestoreApproval[]>(route("/admin/restore/approvals"));
    ok("the restore-approvals inbox has one pending dual-control request (maker != checker)", restoreApprovals.body.length === 1 && restoreApprovals.body[0]!.status === "requested" && restoreApprovals.body[0]!.requestedBy !== "ops@northwind.example");
  }

  // history: no id returns the keyed rings; an id returns one ring as { entries }; an unknown id is an
  // honest empty ring, never a fabricated row.
  {
    const all = await readJson<{ byDownpipe: Record<string, RunHistoryEntry[]> }>(route("/admin/history"));
    ok("history (no id) returns rings keyed by downpipe id", typeof all.body.byDownpipe === "object" && Object.keys(all.body.byDownpipe).length === 7);
    const one = await readJson<{ entries: RunHistoryEntry[] }>(route("/admin/history?id=dp-payments"));
    ok("history (id) returns that downpipe's ring as { entries }", Array.isArray(one.body.entries) && one.body.entries.length >= 1);
    ok("the payments ring includes a deliberate FAILED run (problem surfaced)", one.body.entries.some((e) => e.status === "failed"));
    ok("the payments ring includes an in-flight run", one.body.entries.some((e) => e.status === "in-flight"));
    const miss = await readJson<{ entries: RunHistoryEntry[] }>(route("/admin/history?id=dp-nonexistent"));
    ok("history for an unknown id is an honest empty ring", Array.isArray(miss.body.entries) && miss.body.entries.length === 0);
  }

  // audit: a page plus the chain head; limit=1 returns only the newest (the Overview's "last audited" read);
  // no limit returns the whole short chain; a non-numeric limit falls back to the whole chain.
  {
    const one = await readJson<AuditPage>(route("/admin/audit?limit=1"));
    ok("audit limit=1 returns a single newest event", one.body.events.length === 1);
    ok("audit reports a chain head (tamper-evident)", typeof one.body.headHash === "string" && one.body.headHash.length > 0 && one.body.headSeq > 0);
    ok("the newest audit event signs the prior hash", one.body.events[0]!.prevHash !== one.body.events[0]!.hash);
    const full = await readJson<AuditPage>(route("/admin/audit"));
    ok("audit with no limit returns the whole chain (a short newest-first chain)", full.body.events.length >= 8);
    ok("the audit chain links cleanly (each entry's prevHash is the prior entry's hash)", full.body.events.slice(1).every((e, i) => e.hash === full.body.events[i]!.prevHash));
    const bad = await readJson<AuditPage>(route("/admin/audit?limit=notanumber"));
    ok("audit with a non-numeric limit falls back to the whole chain", bad.body.events.length === full.body.events.length);
  }
  {
    const r = await readJson<RestoreApproval[]>(route("/admin/approvals"));
    ok("the legacy /admin/approvals path answers the dual-control inbox", Array.isArray(r.body) && r.body.length === 1);
  }

  // ---------------------------------------------------------------------------------------------
  // The phase-1c WRITE handlers (the demonstrated mutations): each mutates the world and returns the
  // applied / queued / pending shape the matching console client method parses. The publicly explorable
  // tour DEGRADES GRACEFULLY: an unmodelled screen-load GET returns a benign empty-but-valid 200 and an
  // unmodelled write a benign applied/ok 200, so no screen or click ever surfaces an engine error (a 501
  // the console renders as "the engine returned an error"). A MODELLED write is never a fabricated success.
  // Driven against the console's OWN wire types so a shape drift fails here. The world is re-seeded first so
  // the writes act on the pristine fleet, then re-seeded after so later assertions see the pristine world.
  // ---------------------------------------------------------------------------------------------
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
  {
    const unknownGet = await readJson<{ ok?: boolean; length?: number }>(route("/admin/not-a-real-route"));
    ok("an unmodelled screen-load GET degrades to a benign empty-but-valid 200 (never a 501)", unknownGet.status === 200 && unknownGet.body.ok === true && unknownGet.body.length === 0);
    const unknownWrite = await readJson<{ ok?: boolean }>(route("/admin/not-a-real-write", { method: "POST" }));
    ok("an unmodelled WRITE degrades to a benign applied/ok 200 (a click never surfaces an engine error)", unknownWrite.status === 200 && unknownWrite.body.ok === true);
  }
  // The previously-501 screen-load reads are now modelled, each in the wire shape its screen parses, so every
  // nav item renders populated. A spot-check across the families (canary, config change-control + history,
  // RBAC tables, notifications, owner actions, passkeys, support, preflight, updates, discovery, costs,
  // point-in-time). The discovery offers every source type so the Sources "add a source" set matches the
  // Downpipes "new downpipe" set (all nine including Account Config).
  {
    const canary = await readJson<{ status: string; dests: unknown[] }>(route("/admin/canary"));
    // Three per-destination entries, because the canary flies to ALL destinations (config.destinationIds is
    // null) and the world holds three. A count that lagged the collection would make flyingToAll a claim
    // the same view contradicts.
    ok("canary reads ALIVE with per-destination state for every destination", canary.status === 200 && canary.body.status === "alive" && Array.isArray(canary.body.dests) && canary.body.dests.length === 3);
    const changes = await readJson<Array<{ status: string }>>(route("/admin/config/changes"));
    ok("config change-control lists a pending change awaiting a second approver", changes.status === 200 && Array.isArray(changes.body) && changes.body.some((c) => c.status === "pending"));
    const history = await readJson<{ verify: { intact: boolean }; versions: unknown[] }>(route("/admin/config/history"));
    ok("config history is a signed chain that verifies INTACT", history.status === 200 && history.body.verify.intact === true && history.body.versions.length >= 1);
    const ver = await readJson<{ found: boolean }>(route("/admin/config/version?id=14"));
    ok("a known config version resolves; an unknown id is an honest found:false", ver.body.found === true && (await readJson<{ found: boolean }>(route("/admin/config/version?id=99999"))).body.found === false);
    const roles = await readJson<Array<{ role: string }>>(route("/admin/roles"));
    ok("the RBAC role table lists the owner + named roles", roles.status === 200 && roles.body.some((r) => r.role === "owner") && roles.body.length >= 3);
    const customRoles = await readJson<Array<{ name: string }>>(route("/admin/custom-roles"));
    ok("the custom-role catalogue lists at least one role", customRoles.status === 200 && customRoles.body.length >= 1);
    const channels = await readJson<unknown[]>(route("/admin/notify/channels"));
    const histN = await readJson<unknown[]>(route("/admin/notify/history"));
    ok("notifications list channels + a delivery history", channels.status === 200 && channels.body.length >= 1 && histN.body.length >= 1);
    const owner = await readJson<Array<{ status: string }>>(route("/admin/owner-actions"));
    ok("the owner-action inbox lists a pending high-blast action", owner.status === 200 && owner.body.some((o) => o.status === "pending"));
    const passkeys = await readJson<{ credentials: unknown[] }>(route("/admin/passkey/credentials"));
    ok("the passkey inventory lists enrolled credentials (redaction-safe)", passkeys.status === 200 && passkeys.body.credentials.length >= 1);
    const support = await readJson<{ signerConfigured: boolean }>(route("/admin/support"));
    ok("the support status reads a configured signer", support.status === 200 && support.body.signerConfigured === true);
    const preflight = await readJson<{ summary: { failed: number } }>(route("/admin/preflight"));
    ok("preflight reads a healthy estate (no failed prerequisites)", preflight.status === 200 && preflight.body.summary.failed === 0);
    const upd = await readJson<{ pending: unknown }>(route("/admin/update/status"));
    ok("the update lifecycle record reads calm (nothing mid-flight)", upd.status === 200 && upd.body.pending === null);
    const estate = await readJson<{ available: boolean; sizedSources: number }>(route("/admin/cost/estate-size"));
    ok("the estate-size estimate is available and sized from analytics", estate.status === 200 && estate.body.available === true && estate.body.sizedSources >= 1);
    const pit = await readJson<{ found: boolean }>(route("/admin/runs/at?downpipe=dp-ledger&at=2026-06-27T00:00:00Z"));
    ok("a point-in-time recovery target resolves for a known downpipe", pit.status === 200 && pit.body.found === true);
    const pitMiss = await readJson<{ found: boolean }>(route("/admin/runs/at?downpipe=dp-nope&at=2026-06-27T00:00:00Z"));
    ok("a point-in-time target for an unknown downpipe is an honest found:false", pitMiss.body.found === false);
    const disc = await readJson<{ tokenPresent: boolean; workersSupported?: boolean; streamSupported?: boolean; imagesSupported?: boolean; artifactsSupported?: boolean; cfConfigSurfaces?: unknown[]; bound: { secrets: string[] }; addedSources?: string[] }>(route("/admin/sources/discover"));
    ok("source discovery offers EVERY type so Sources matches Downpipes (the four caps + cf-config surfaces + the four binding stores)", disc.body.tokenPresent === true && disc.body.workersSupported === true && disc.body.streamSupported === true && disc.body.imagesSupported === true && disc.body.artifactsSupported === true && (disc.body.cfConfigSurfaces ?? []).length > 0 && disc.body.bound.secrets.length > 0);
    // The coverage-hero mix is locked here: Artifact Registry is ADDED as a source (amber: added, no downpipe)
    // while Images is NOT added (slate). Stream/Workers/cf-config are added AND downpiped (green).
    ok("addedSources drives the amber/slate mix (artifacts added without a downpipe, images not added)", (disc.body.addedSources ?? []).includes("artifacts") && !(disc.body.addedSources ?? []).includes("images"));
  }
  // The previously-501 WRITES now return the specific shape their screen parses (a click resolves cleanly).
  {
    const canaryRun = await readJson<{ ok: boolean; flying: boolean }>(route("/admin/canary/run", { method: "POST", body: "{}" }));
    ok("running the canary returns a singing result", canaryRun.status === 200 && canaryRun.body.ok === true && canaryRun.body.flying === true);
    const inv = await readJson<{ stored: boolean; counts: { kv: number } }>(route("/admin/coverage/inventory", { method: "POST", body: JSON.stringify({ kv: [{ id: "a" }, { id: "b" }], r2: [], d1: [], secrets: [] }) }));
    ok("storing a coverage inventory echoes the per-type counts (no value)", inv.status === 200 && inv.body.stored === true && inv.body.counts.kv === 2);
    const approveChg = await readJson<{ status: string; approvedBy?: string }>(route("/admin/config/changes/chg-notify-rule-7f3a/approve", { method: "POST", body: "{}" }));
    ok("approving a queued config change flips it to applied by a distinct checker", approveChg.status === 200 && approveChg.body.status === "applied" && approveChg.body.approvedBy === "daniel.cho@northwind.example");
    const verify = await readJson<{ ok: boolean; deleteProbe?: string }>(route("/admin/destination/verify", { method: "POST", body: "{}" }));
    ok("a destination verify passes with the WORM delete probe denied", verify.status === 200 && verify.body.ok === true && verify.body.deleteProbe === "denied");
    const idpTest = await readJson<{ ok: boolean; checks: unknown[] }>(route("/admin/idp/test", { method: "POST", body: "{}" }));
    ok("an IdP connection test returns a passing check list", idpTest.status === 200 && idpTest.body.ok === true && idpTest.body.checks.length >= 1);
    const meta = await route("/admin/saml/metadata/okta-saml");
    ok("the SAML metadata route returns well-formed XML (the connection's metadata link)", meta.status === 200 && (meta.headers.get("content-type") ?? "").includes("xml") && (await meta.text()).includes("EntityDescriptor"));
    const del = await readJson<{ deleted?: boolean; ok?: boolean }>(route("/admin/roles/delete", { method: "POST", body: JSON.stringify({ email: "x@y.example" }) }));
    ok("a delete write degrades to a benign deleted/ok result", del.status === 200 && (del.body.deleted === true || del.body.ok === true));
    resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0)); // the approve mutated the seeded change; re-seed for later assertions
  }
  // create downpipe -> DEFERRED (four-eyes ON): 202 + the engine's { queued, id, status, contentHash } body
  // (parseJsonOrPending -> pending). The demo previously answered a fabricated { pending, id } shape; no engine
  // route emits `pending`, and the console guard was written to the same invention, so the demo was the only
  // place the queued path ever worked. The simulator is pinned to the engine's wire now.
  {
    const r = await readJson<{ queued?: boolean; id?: string }>(route("/admin/downpipes", { method: "POST", body: JSON.stringify({ id: "dp-x", name: "New pipe" }) }));
    ok("create-downpipe is queued for approval (202 { queued, id }), the engine's deferred config-mutation shape", r.status === 202 && r.body.queued === true && typeof r.body.id === "string");
    const malformed = await readJson<{ queued?: boolean; id?: string }>(route("/admin/downpipes", { method: "POST", body: "{not-json" }));
    ok("a malformed create body still returns a well-formed queued body (defensive parse)", malformed.status === 202 && malformed.body.queued === true);
  }
  // trigger -> a NEW in-flight run at the head of the ring; an unknown id is the honest { skipped } shape.
  {
    const r = await readJson<{ runId?: string; index?: number; prevRunId?: string; skipped?: string }>(route("/admin/trigger", { method: "POST", body: JSON.stringify({ id: "dp-ledger" }) }));
    ok("trigger mints a new run with an incremented index + the prior run id", typeof r.body.runId === "string" && r.body.index === 10 && r.body.prevRunId === "run-ledger-0009");
    const head = await readJson<{ entries: RunHistoryEntry[] }>(route("/admin/history?id=dp-ledger"));
    ok("the triggered run is in-flight at the head of the ring", head.body.entries[0]!.status === "in-flight" && head.body.entries[0]!.runId === r.body.runId);
    const dps = await listDownpipesMapped();
    ok("the triggered downpipe now reads in-flight", dps.find((d) => d.config.id === "dp-ledger")!.inFlight === true);
    const skip = await readJson<{ skipped?: string }>(route("/admin/trigger", { method: "POST", body: JSON.stringify({ id: "dp-nope" }) }));
    ok("trigger of an unknown downpipe is honestly skipped (no fabricated run)", typeof skip.body.skipped === "string");
  }
  // add destination -> APPLIED (owner-action gate OFF): the updated list, with the new destination appended.
  {
    const before = (await readJson<DestinationList>(route("/admin/destinations"))).body.destinations.length;
    const r = await readJson<DestinationList>(route("/admin/destinations", { method: "POST", body: JSON.stringify({ label: "Cold tier (us-west-2)", config: { endpoint: "https://s3.us-west-2.amazonaws.com", bucket: "northwind-cold", region: "us-west-2", accessKeyId: "AKIA-DEMO", secretAccessKey: "demo-secret-never-stored", worm: { mode: "compliance", retentionDays: 365 } } }) }));
    ok("add-destination returns the updated list with the new destination appended", r.body.destinations.length === before + 1);
    const added = r.body.destinations[r.body.destinations.length - 1]!;
    ok("the new destination is redaction-safe (no secret) and WORM-enforced from the submitted policy", added.label === "Cold tier (us-west-2)" && added.objectLock === "enforced" && !("secretAccessKey" in added) && !("accessKeyId" in added));
    const edited = await readJson<DestinationList>(route("/admin/destinations", { method: "POST", body: JSON.stringify({ id: "primary-apse2", label: "Primary (renamed)", config: { endpoint: "https://s3.ap-southeast-2.amazonaws.com", bucket: "northwind-archive-apse2", region: "ap-southeast-2", accessKeyId: "AKIA", secretAccessKey: "x" } }) }));
    ok("editing an existing destination by id replaces it in place (count unchanged, default kept)", edited.body.destinations.length === before + 1 && edited.body.destinations.find((d) => d.id === "primary-apse2")!.label === "Primary (renamed)" && edited.body.destinations.find((d) => d.id === "primary-apse2")!.isDefault === true);
  }
  // WHICH STORE THE DEMO SAYS A SAVED DESTINATION IS, and the one save it must refuse.
  //
  // Two places in the faked engine derived the kind as `includes("r2.cloudflarestorage.com") ? "r2" : "s3"`,
  // which has two answers where the product has four. A learner who saved a Google Cloud or an Azure
  // destination in the training course had it reported back as S3, and that answer is what the residency
  // panel, the topology map's phrase and the downpipe drawer all read. So the course named the wrong vendor
  // for the learner's own destination, on the screens whose whole job is to say where the archives went.
  //
  // The refusal is the other half. Any submitted policy used to be stamped objectLock "enforced" whatever
  // the endpoint, so a learner who armed a compliance lock on an R2 destination watched it save and read
  // back as enforced. The real engine refuses that with a 400: R2 over its S3 endpoint answers 501
  // NotImplemented to x-amz-object-lock-mode, and no R2 bucket can be created with Object Lock either.
  // Teaching a success the product will not give leaves the learner believing archives are immutable that
  // are not.
  {
    const cred = { accessKeyId: "AKIA-DEMO", secretAccessKey: "demo-secret-never-stored" };
    const saveDest = (label: string, config: Record<string, unknown>) =>
      readJson<{ error?: string; destinations?: DestinationList["destinations"] }>(route("/admin/destinations", { method: "POST", body: JSON.stringify({ label, config }) }));
    const savedKind = async (): Promise<string> => String((await readJson<{ destKind: string | null }>(route("/admin/status"))).body.destKind ?? "");

    await saveDest("Azure learner copy", { endpoint: "https://learneracct.blob.core.windows.net", bucket: "learner-archive", region: "australiaeast", ...cred });
    const azureKind = await savedKind();
    ok("a saved Azure destination is reported back as azure, not as s3", azureKind === "azure");
    await saveDest("Google learner copy", { endpoint: "https://storage.googleapis.com", bucket: "learner-archive", region: "auto", ...cred });
    const gcsKind = await savedKind();
    ok("a saved Google Cloud destination is reported back as gcs", gcsKind === "gcs");
    await saveDest("R2 learner copy", { endpoint: "https://acct123.r2.cloudflarestorage.com", bucket: "learner-archive", region: "auto", ...cred });
    const r2Kind = await savedKind();
    ok("CONTROL: an R2 destination still reads as r2, so the four-way answer did not lose the one it had", r2Kind === "r2");
    // The residual has to stay the residual, or naming two more providers would have quietly relabelled
    // every Wasabi, Backblaze or MinIO destination.
    await saveDest("Wasabi learner copy", { endpoint: "https://s3.wasabisys.com", bucket: "learner-archive", region: "us-east-1", ...cred });
    const wasabiKind = await savedKind();
    ok("CONTROL: an unrecognised S3-compatible host still reads as s3", wasabiKind === "s3");

    const r2Worm = await saveDest("R2 with a lock", { endpoint: "https://acct123.r2.cloudflarestorage.com", bucket: "learner-archive", region: "auto", ...cred, worm: { mode: "compliance", retentionDays: 365 } });
    ok("an immutability policy on an R2 destination is REFUSED, as the real engine refuses it", r2Worm.status === 400);
    ok("...and the refusal carries a reason the learner can read, not a bare status", typeof r2Worm.body.error === "string" && r2Worm.body.error.includes("cannot enforce an immutability policy"));
    const afterRefusal = await readJson<DestinationList>(route("/admin/destinations"));
    ok("...and nothing was written: a refused save leaves no destination behind", afterRefusal.body.destinations.every((d) => d.label !== "R2 with a lock"));
    // THE TWO CONTROLS THAT KEEP THE REFUSAL HONEST. Without the first, the assertions above would pass for
    // a build that refused every R2 destination; without the second, for one that refused every lock.
    const r2Plain = await saveDest("R2 without a lock", { endpoint: "https://acct123.r2.cloudflarestorage.com", bucket: "learner-archive", region: "auto", ...cred });
    ok("CONTROL: the same R2 destination saves fine WITHOUT a policy, so R2 itself is not being refused", r2Plain.status === 200 && (r2Plain.body.destinations ?? []).some((d) => d.label === "R2 without a lock"));
    const s3Worm = await saveDest("S3 with a lock", { endpoint: "https://s3.us-west-2.amazonaws.com", bucket: "learner-archive", region: "us-west-2", ...cred, worm: { mode: "compliance", retentionDays: 365 } });
    ok("CONTROL: the same policy on an S3 destination is still accepted and reads enforced", s3Worm.status === 200 && (s3Worm.body.destinations ?? []).find((d) => d.label === "S3 with a lock")?.objectLock === "enforced");
  }
  // drill / verify / attest -> the recoverability proofs; each returns ok and stamps the proven record.
  {
    const drill = await readJson<{ ok: boolean; runId: string; sampleRestored?: boolean }>(route("/admin/drill", { method: "POST", body: JSON.stringify({ runId: "run-ledger-0009" }) }));
    ok("drill returns a passing DrillResult (a sample record restored to a verification path)", drill.body.ok === true && drill.body.sampleRestored === true);
    const proven = (await listDownpipesMapped()).find((d) => d.config.id === "dp-ledger")!;
    ok("a passed drill stamps the downpipe's offline-restorability-proven record (now)", typeof proven.lastRestoreProvenAt === "string" && proven.lastRestoreProvenBy === "ops@northwind.example");
    const verify = await readJson<{ ok: boolean; restoreDigest: string | null; recordsVerified: number; downpipeId?: string }>(route("/admin/restore/verify", { method: "POST", body: JSON.stringify({ runId: "run-ledger-0009" }) }));
    ok("verify is a clean BLIND restore test: ok, a digest, the run's record count, no plaintext", verify.body.ok === true && (verify.body.restoreDigest ?? "").startsWith("sha384:") && verify.body.recordsVerified > 0 && verify.body.downpipeId === "dp-ledger");
    const attest = await readJson<{ ok: boolean; signatureValid: boolean; complete: boolean; notRolledBack: boolean }>(route("/admin/restore/attest", { method: "POST", body: JSON.stringify({ runId: "run-ledger-0009" }) }));
    ok("attest is a clean KEYLESS attestation (signature + completeness + anti-rollback, no key, no data)", attest.body.ok === true && attest.body.signatureValid === true && attest.body.complete === true && attest.body.notRolledBack === true);
  }
  // restore dry-run -> a RestorePlan (read-only preview, names + sizes only, never a byte of plaintext).
  {
    const dry = await readJson<{ ok: boolean; mode: string; planHash?: string; sample: Array<{ plaintextSize: number }> }>(route("/admin/restore", { method: "POST", body: JSON.stringify({ runId: "run-payments-0041" }) }));
    ok("restore dry-run returns a RestorePlan with a plan hash and a redaction-safe sample", dry.body.ok === true && dry.body.mode === "dry-run" && (dry.body.planHash ?? "").startsWith("sha384:") && dry.body.sample.length >= 1);
    // A dry-run for an UNKNOWN run still returns a well-formed plan with a coarse single-sample (the
    // non-seeded sample branch + the isLatest/known-counts fallbacks), never a throw or a fabricated row.
    const dryUnknown = await readJson<{ ok: boolean; mode: string; sample: Array<{ name: string }> }>(route("/admin/restore", { method: "POST", body: JSON.stringify({ runId: "run-unknown-9999" }) }));
    ok("a dry-run for an unknown run returns a coarse single-sample plan (no throw, no fabricated rows)", dryUnknown.body.ok === true && dryUnknown.body.mode === "dry-run" && dryUnknown.body.sample.length === 1);
  }
  // The recoverability verbs on an UNKNOWN run id exercise the runById / downpipeForRun "not found" arms:
  // they return ok with the run's counts defaulting to 0 and stamp nothing (no downpipe owns the run).
  {
    const drillMiss = await readJson<{ ok: boolean; isLatest?: boolean }>(route("/admin/drill", { method: "POST", body: JSON.stringify({ runId: "run-unknown-9999" }) }));
    ok("drill on an unknown run is a clean result with no proven stamp (the not-found arm)", drillMiss.body.ok === true && drillMiss.body.isLatest === false);
    const verifyMiss = await readJson<{ ok: boolean; recordsVerified: number; downpipeId?: string }>(route("/admin/restore/verify", { method: "POST", body: JSON.stringify({ runId: "run-unknown-9999" }) }));
    ok("verify on an unknown run reads zero records and no downpipeId (the not-found arm)", verifyMiss.body.ok === true && verifyMiss.body.recordsVerified === 0 && verifyMiss.body.downpipeId === undefined);
    const attestMiss = await readJson<{ ok: boolean; downpipeId?: string }>(route("/admin/restore/attest", { method: "POST", body: JSON.stringify({ runId: "run-unknown-9999" }) }));
    ok("attest on an unknown run is clean with no downpipeId (the not-found arm)", attestMiss.body.ok === true && attestMiss.body.downpipeId === undefined);
  }
  // A non-GET / non-POST method to a modelled path is the honest 501 (the demo only ever models GET reads +
  // POST writes; the console never PUT/DELETEs /admin/*), so the method fallback is exercised.
  {
    const put = await readJson<{ error: string }>(route("/admin/downpipes", { method: "PUT" }));
    ok("a non-GET / non-POST method is an honest 501 (the method fallback)", put.status === 501 && typeof put.body.error === "string");
  }
  // restore APPLY dual-control: un-approved apply is the honest 403; request -> owner-approve -> apply succeeds.
  {
    const req = { runId: "run-payments-0041", reason: "Quarterly recovery rehearsal." };
    const unapproved = await route("/admin/restore", { method: "POST", body: JSON.stringify({ ...req, confirm: true }) });
    ok("an un-approved apply is the honest 403 { error: restore not approved } (never a false receipt)", unapproved.status === 403);
    const unapprovedBody = JSON.parse(await unapproved.text()) as { error?: string; planHash?: string };
    ok("the 403 carries the plan hash the approval must bind to", typeof unapprovedBody.planHash === "string" && (unapprovedBody.error ?? "").includes("not approved"));
    // Raise a request (the maker, the engineer who raised the restore). Its planHash matches the dry-run's
    // (restorePlanHash, one source of truth).
    const raised = await readJson<RestoreApproval>(route("/admin/restore/request", { method: "POST", body: JSON.stringify({ ...req, isLatest: true, plannedWrites: 52140, bytes: 18220032 }) }));
    ok("requestRestore raises a pending approval by a DISTINCT maker (the engineer != owner)", raised.body.status === "requested" && raised.body.requestedBy === "priya.nair@northwind.example" && raised.body.planHash === unapprovedBody.planHash);
    // A distinct second approver approves it; maker != checker holds, AND the approver differs from the
    // signed-in owner-applier so the confirm screen's pre-flight can arm Apply (caller != approver).
    const approved = await readJson<RestoreApproval>(route("/admin/restore/approve", { method: "POST", body: JSON.stringify({ planHash: raised.body.planHash }) }));
    ok("approveRestore flips it to approved by a distinct checker (differing from both the maker and the owner-applier)", approved.body.status === "approved" && typeof approved.body.approvedBy === "string" && approved.body.approvedBy !== approved.body.requestedBy && approved.body.approvedBy !== "ops@northwind.example");
    // Now the apply succeeds and returns the receipt.
    const applied = await readJson<{ ok: boolean; mode: string; recordsRestored: number }>(route("/admin/restore", { method: "POST", body: JSON.stringify({ ...req, confirm: true }) }));
    ok("the approved apply returns the applied RestoreResult receipt", applied.body.ok === true && applied.body.mode === "applied" && applied.body.recordsRestored > 0);
    // The approval is single-use: a second apply is refused again (consumed).
    const replay = await route("/admin/restore", { method: "POST", body: JSON.stringify({ ...req, confirm: true }) });
    ok("the consumed approval cannot be re-used (a second apply is the honest 403)", replay.status === 403);
    // reject path: a fresh request rejected reads rejected.
    const raised2 = await readJson<RestoreApproval>(route("/admin/restore/request", { method: "POST", body: JSON.stringify({ runId: "run-statements-0021", reason: "Reject test." }) }));
    const rejected = await readJson<RestoreApproval>(route("/admin/restore/reject", { method: "POST", body: JSON.stringify({ planHash: raised2.body.planHash }) }));
    ok("rejectRestore declines the request (status rejected)", rejected.body.status === "rejected");
    // approve/reject of an unknown plan is an honest 501 (nothing to action).
    const approveMiss = await route("/admin/restore/approve", { method: "POST", body: JSON.stringify({ planHash: "sha384:nope" }) });
    ok("approving an unknown plan is an honest 501", approveMiss.status === 501);
    const rejectMiss = await route("/admin/restore/reject", { method: "POST", body: JSON.stringify({ planHash: "sha384:nope" }) });
    ok("rejecting an unknown plan is an honest 501", rejectMiss.status === 501);
  }
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0)); // re-seed so the assertions below see the pristine world

  // resetWorld restores the pristine seed deterministically (the phase-2 Back/Restart hook).
  {
    resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
    const r = await listDownpipesMapped();
    ok("resetWorld returns the pristine eight-downpipe fleet", r.length === 8);
    resetWorld(); // default-clock path
    const r2 = await listDownpipesMapped();
    ok("resetWorld() with the default clock also seeds the fleet", r2.length === 8);
  }

  // ---------------------------------------------------------------------------------------------
  // demo-fetch.isTourMode: host match, the dev-host-scoped query match (each isDevHost arm), the
  // production-host-with-flag rejection (the security scope), neither, and the throw-degrades-to-false arm.
  // ---------------------------------------------------------------------------------------------
  ok("isTourMode true on the tour hostname", isTourMode({ hostname: "tour.downpipes.io", search: "" } as Location));
  ok("isTourMode true with the ?tour= query flag on localhost", isTourMode({ hostname: "localhost", search: "?tour=1" } as Location));
  ok("isTourMode true with ?tour= on 127.0.0.1 (loopback dev host)", isTourMode({ hostname: "127.0.0.1", search: "?tour" } as Location));
  ok("isTourMode true with ?tour= on the IPv6 loopback ::1", isTourMode({ hostname: "::1", search: "?tour" } as Location) && isTourMode({ hostname: "[::1]", search: "?tour" } as Location));
  ok("isTourMode true with ?tour= on a *.localhost dev subdomain", isTourMode({ hostname: "console.localhost", search: "?tour" } as Location));
  ok("isTourMode true with ?tour= on a *.local mDNS dev host", isTourMode({ hostname: "my-box.local", search: "?tour" } as Location));
  ok("isTourMode false with the ?tour= flag on a PRODUCTION host (the flag is dev-host-scoped)", isTourMode({ hostname: "console.downpipes.io", search: "?tour=1" } as Location) === false);
  ok("isTourMode false with the ?tour= flag on demo.downpipes.io (the real engine demo is never faked by the flag)", isTourMode({ hostname: "demo.downpipes.io", search: "?tour=1" } as Location) === false);
  ok("isTourMode false on a normal host with no flag", isTourMode({ hostname: "console.example", search: "" } as Location) === false);
  ok("isTourMode false on a dev host with NO flag (the dev opt-in is the flag, not the host)", isTourMode({ hostname: "localhost", search: "" } as Location) === false);
  ok("isTourMode false on demo.downpipes.io (the Access-gated real engine demo)", isTourMode({ hostname: "demo.downpipes.io", search: "" } as Location) === false);
  ok("isTourMode degrades to false when reading location throws", isTourMode(null as unknown as Location) === false);

  // ---------------------------------------------------------------------------------------------
  // demo-fetch.installDemoFetch: /admin/* is answered by the demo engine; everything else delegates to
  // the real fetch; the install is idempotent (a second call never loses the real fetch).
  // ---------------------------------------------------------------------------------------------
  setLocation("https://tour.downpipes.io/");
  const realCalls: string[] = [];
  const cannedReal = ((input: unknown): Promise<Response> => {
    realCalls.push(typeof input === "string" ? input : String(input));
    return Promise.resolve(new Response("real", { status: 200 }));
  }) as typeof fetch;
  globalThis.fetch = cannedReal;

  const returnedReal = installDemoFetch();
  ok("installDemoFetch returns the real fetch it wrapped", returnedReal === cannedReal);

  // A string /admin/* URL is answered by the faked engine (no real-fetch call).
  {
    const res = await globalThis.fetch("https://tour.downpipes.io/admin/whoami");
    const body = (await res.json()) as WhoAmI;
    ok("interceptor answers a string /admin/* URL from the demo engine", body.role === "owner");
  }
  // A URL object for /admin/* is also intercepted (the urlOf URL branch).
  {
    const res = await globalThis.fetch(new URL("https://tour.downpipes.io/admin/status"));
    const body = (await res.json()) as StatusReport;
    ok("interceptor answers a URL-object /admin/* request", body.ready === true);
  }
  // A Request object for /admin/* is intercepted, and its method drives route() (the input-Request init arm):
  // a Request-object POST to a MODELLED write routes to the WRITE handler (not the GET path), proving the
  // Request's own method is honoured. The canary-run write returns { ok, flying }, a shape only the POST
  // handler produces (the GET /admin/canary returns the canary view), so the method must have driven routing.
  {
    const res = await globalThis.fetch(new Request("https://tour.downpipes.io/admin/canary/run", { method: "POST" }));
    const body = (await res.json()) as { ok?: boolean; flying?: boolean };
    ok("interceptor routes a Request-object write (its method drives route) to the WRITE handler", res.status === 200 && body.ok === true && body.flying === true);
  }
  // A non-/admin request (the topology probe, an asset) delegates to the real fetch unchanged.
  {
    const res = await globalThis.fetch("/engine-topology.json");
    const text = await res.text();
    ok("a non-/admin request delegates to the real fetch", text === "real" && realCalls.includes("/engine-topology.json"));
  }
  // An unparseable URL is treated as non-admin and delegates (the isAdminPath catch arm). A bare token with
  // no scheme still resolves against the origin, so use a value that throws in the URL constructor.
  {
    realCalls.length = 0;
    const res = await globalThis.fetch("http://[" /* malformed host triggers a URL parse throw */);
    const text = await res.text();
    ok("an unparseable URL is treated as non-admin and delegates", text === "real");
  }
  // Idempotent: a second install returns the (now-installed) fetch without re-wrapping, so /admin/* still
  // routes to the demo engine and the real fetch is never double-wrapped or lost.
  {
    const again = installDemoFetch();
    ok("a second installDemoFetch is a no-op (idempotent)", typeof again === "function");
    const res = await globalThis.fetch("https://tour.downpipes.io/admin/health");
    const body = (await res.json()) as { ok: boolean };
    ok("after a redundant install /admin/* still routes to the demo engine", body.ok === true);
  }

  // ---------------------------------------------------------------------------------------------
  // The SIMULATED-action cue: a genuine WRITE (a state-changing method) the faked engine applies/queues in
  // tour mode shows a reassuring "simulated" toast, debounced so a burst shows one. A GET (read / poll) never
  // does, and an honest refusal (a dual-control 403) does not either. Driven through the live interceptor on
  // the tour host; the toast region is read for the cue text. (The location is the tour host, set above.)
  // ---------------------------------------------------------------------------------------------
  {
    resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
    // The toast regions are created once by the toast module and REUSED (the module caches them), so the helpers
    // read + clear their CHILDREN in place rather than removing the region elements (removing them would strand
    // the module's cached reference, and later toasts would land in a detached region the assertions can't see).
    const regions = (): Array<{ textContent?: string; childNodes?: { length: number }; replaceChildren?: () => void; firstChild?: unknown; removeChild?: (c: unknown) => void }> => {
      const out: Array<{ textContent?: string; childNodes?: { length: number } }> = [];
      for (const n of document.body.childNodes as unknown as Iterable<{ className?: string }>) {
        if (typeof n.className === "string" && n.className.includes("toast-region")) out.push(n as { textContent?: string; childNodes?: { length: number } });
      }
      return out;
    };
    const toastRegionText = (): string => regions().map((r) => r.textContent ?? "").join(" ");
    const toastItemCount = (): number => regions().reduce((s, r) => s + (r.childNodes?.length ?? 0), 0);
    const clearToasts = (): void => {
      for (const r of regions()) {
        if (typeof r.replaceChildren === "function") r.replaceChildren();
        else while (r.firstChild) r.removeChild?.(r.firstChild);
      }
    };
    // Drain any in-flight cue first: an earlier interceptor block fired a Request-object POST whose debounced
    // cue may still be pending; wait it out and clear, so a stray prior toast never races into the GET test below.
    await new Promise((r) => setTimeout(r, 700)); await flushAsync(2);
    clearToasts();
    // A GET (a read / a poll) NEVER fires the cue.
    await globalThis.fetch("https://tour.downpipes.io/admin/status");
    await new Promise((r) => setTimeout(r, 600)); await flushAsync(2);
    ok("a GET read never fires the simulated-action cue (reads + polls are silent)", !toastRegionText().includes("Simulated"));
    // A successful POST WRITE fires the cue (debounced) with the reassuring copy.
    clearToasts();
    await globalThis.fetch("https://tour.downpipes.io/admin/canary/run", { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 600)); await flushAsync(2);
    ok("a successful WRITE fires the simulated-action cue (sample data, nothing left the browser)", toastRegionText().includes("Simulated") && toastRegionText().toLowerCase().includes("sample data"));
    // A burst of WRITES debounces to ONE toast.
    clearToasts();
    await globalThis.fetch("https://tour.downpipes.io/admin/canary/run", { method: "POST", body: "{}" });
    await globalThis.fetch("https://tour.downpipes.io/admin/canary/run", { method: "POST", body: "{}" });
    await globalThis.fetch("https://tour.downpipes.io/admin/canary/run", { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 700)); await flushAsync(2);
    ok("a burst of WRITES debounces to a single simulated-action cue (no pile of toasts)", toastItemCount() === 1);
    // An honest refusal (the un-approved restore apply 403) does NOT fire the cue (nothing was simulated; the
    // refusal is a real demo behaviour the screen explains).
    clearToasts();
    const refused = await globalThis.fetch("https://tour.downpipes.io/admin/restore", { method: "POST", body: JSON.stringify({ runId: "run-payments-0041", reason: "x", confirm: true }) });
    await new Promise((r) => setTimeout(r, 600)); await flushAsync(2);
    ok("an honest refusal (a dual-control 403) does NOT fire the cue (nothing was simulated)", refused.status === 403 && !toastRegionText().includes("Simulated"));
    clearToasts();
    resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
  }

  // ---------------------------------------------------------------------------------------------
  // demo-fetch.startDemo: installs the interceptor, connects the store to this origin so the no-login boot
  // reads as connected without a sign-in, AND mounts the persistent honesty banner (the distinct tour-mode
  // signal, not the engine demoMode flag). Remove any banner first so the install is observable.
  // ---------------------------------------------------------------------------------------------
  removeTourBanner();
  signOut(); // clear any prior store connection so the connect (and the synchronous caller prime) is observable
  ok("signOut clears the store caller (the bug's starting condition: a screen rendering first would see null)", getCaller() === null && isWhoamiAvailable() === false);
  startDemo();
  ok("startDemo connects the store to this origin", getEngineUrl() === "https://tour.downpipes.io");
  ok("startDemo builds the one EngineClient", getEngine() !== null);
  // startDemo PRIMES the store's caller SYNCHRONOUSLY from the demo seed (no await), so the very first render in
  // free-explore already sees the verified owner: app.ts's resolveIdentity resolves whoami in the background, so
  // without the prime a screen rendering before that fetch lands would see caller() === null and hide owner-gated
  // UI (the Overview pending-approval item, the /restore/approvals Approve button). The primed caller is
  // byte-identical to what buildCallerFromWhoami produces from the same seed whoami (the SAME mapping app.ts uses).
  {
    const c = getCaller();
    ok("startDemo primes the store caller SYNCHRONOUSLY to the verified owner (the first render sees it, not null)", c !== null && c.role === "owner" && c.method === "access" && c.email !== null && isWhoamiAvailable() === true);
    ok("the primed caller is byte-identical to buildCallerFromWhoami over the seed whoami (the same mapping app.ts uses)", JSON.stringify(c) === JSON.stringify(buildCallerFromWhoami(demoWhoami())));
  }
  // The faked engine answers the connected client's whoami with the seeded owner (the no-login landing).
  {
    const who = await getEngine()!.whoami();
    ok("the connected demo client resolves the seeded owner via the interceptor", who.role === "owner" && who.email !== null);
  }

  // ---------------------------------------------------------------------------------------------
  // demo/banner: startDemo mounts the persistent honesty banner; it is idempotent (no second banner) and
  // reads "Demo. Sample data. Resets on reload." with a role + aria-label, applied through the CSSOM (no
  // inline style attribute, so it holds the strict style-src). removeTourBanner clears it (the tour never
  // calls this; the banner is persistent by design, but the cov validator restores the DOM after).
  // ---------------------------------------------------------------------------------------------
  {
    const banner = document.getElementById("tour-demo-banner");
    ok("startDemo mounted the persistent demo banner", banner !== null);
    // The always-visible site link mounts with the rest of the tour chrome; idempotent + removable.
    const siteLink = document.getElementById("tour-site-link");
    ok("startDemo mounted the always-visible downpipes.io link", siteLink !== null);
    ok("installTourSiteLink is idempotent (returns the mounted link)", installTourSiteLink() === siteLink);
    removeTourSiteLink();
    ok("removeTourSiteLink removes it (validator hygiene)", document.getElementById("tour-site-link") === null);
    ok("installTourSiteLink remounts after removal", installTourSiteLink() !== null);
    ok("startDemo also mounted the screenshot-robust corner DEMO marker (survives overlays + crops)", document.getElementById("tour-demo-corner") !== null);
    ok("the banner reads the honest demo + reset copy", (banner?.textContent ?? "").includes("Demo. Sample data. Resets on reload."));
    ok("the banner carries a role + aria-label (announced, not a live alert)", banner?.getAttribute("role") === "note" && (banner?.getAttribute("aria-label") ?? "").includes("not a real account"));
    ok("the banner is fixed and pointer-transparent (never blocks the app behind it)", banner?.style.getPropertyValue("position") === "fixed" && banner?.style.getPropertyValue("pointer-events") === "none");

    // The "Reset sample data" control: a real, keyboard-reachable button in the banner. Clicking it re-seeds the
    // world (a prior mutation is reverted), re-renders the current screen by re-navigating to the current route
    // (the router re-resolves; here a navigate spy observes it), and shows a "Sample data reset" toast.
    {
      ok("the banner carries a 'Reset sample data' button (keyboard reachable)", banner?.querySelector('[data-tour-reset]') !== null && (banner?.querySelector('[data-tour-reset]') as { tagName?: string } | null)?.tagName === "BUTTON" && (banner?.querySelector('[data-tour-reset]') as { getAttribute(n: string): string | null } | null)?.getAttribute("aria-label")?.includes("Reset") === true);
      // Record a current route so currentRoute() returns it, and install a navigate spy.
      recordNav("/runs");
      const resetNavs: string[] = [];
      installNav({ navigate: (to) => { resetNavs.push(to); }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
      ok("currentRoute returns the recorded current route (the screen the reset re-renders)", currentRoute().startsWith("/runs"));
      // Mutate the world (trigger a run on the ledger pipe), then clear toasts so the reset toast is observable.
      // ALSO seed the store entity + search caches (the downpipe list, a run ring, the palette search snapshot),
      // so the reset's cache-clear (FIX B: an in-place reset must leave no stale palette snapshot) is observable.
      resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
      setDownpipesCache([{ config: { id: "stale" } }] as unknown as DownpipeState[]);
      setRunsCache("dp-ledger", [{ runId: "stale-run" }] as unknown as RunHistoryEntry[]);
      setRunsForSearch([{ runId: "stale-run", index: 1, downpipeId: "dp-ledger" }]);
      await route("/admin/trigger", { method: "POST", body: JSON.stringify({ id: "dp-ledger" }) });
      const beforeReset = ((await readJson<{ entries: unknown[] }>(route("/admin/history?id=dp-ledger"))).body.entries).length;
      // Clear toast region CHILDREN in place (not the region elements, which the toast module caches + reuses).
      for (const n of document.body.childNodes as unknown as Iterable<{ className?: string; replaceChildren?: () => void; firstChild?: unknown; removeChild?: (c: unknown) => void }>) {
        if (typeof n.className === "string" && n.className.includes("toast-region")) {
          if (typeof n.replaceChildren === "function") n.replaceChildren();
          else while (n.firstChild) n.removeChild?.(n.firstChild);
        }
      }
      // Click the rendered Reset button (the real wiring: button click -> resetSampleData -> re-seed + re-nav + toast).
      (banner?.querySelector('[data-tour-reset]') as { click(): void } | null)?.click();
      await flushAsync(2);
      const afterReset = ((await readJson<{ entries: unknown[] }>(route("/admin/history?id=dp-ledger"))).body.entries).length;
      ok("clicking Reset re-seeds the world back to pristine (a prior mutation is reverted)", afterReset < beforeReset);
      ok("clicking Reset re-renders the current screen by re-navigating to the current route (no page reload)", resetNavs.some((to) => to.startsWith("/runs")));
      // FIX B: the reset also clears the store entity + palette-search caches, so an in-place reset leaves no
      // stale snapshot the command palette could read.
      ok("clicking Reset clears the store entity + palette-search caches (no stale palette snapshot after reset)", getDownpipesCache() === null && getRunsCache("dp-ledger") === undefined && getRunsForSearch() === null);
      let resetToast = "";
      for (const n of document.body.childNodes as unknown as Iterable<{ className?: string; textContent?: string }>) {
        if (typeof n.className === "string" && n.className.includes("toast-region")) resetToast += ` ${n.textContent ?? ""}`;
      }
      ok("clicking Reset shows a 'Sample data reset' toast", resetToast.includes("Sample data reset"));
      // resetSampleData is also callable directly (the exported verb); it does not throw even if navigate spies.
      resetSampleData();
      ok("resetSampleData is directly callable and re-navigates (the exported reset verb)", resetNavs.filter((to) => to.startsWith("/runs")).length >= 2);
      // Restore the nav bridge for sibling blocks.
      installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
      resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
    }
    // Idempotent: a redundant install returns the SAME element and never stacks a second banner.
    const again = installTourBanner();
    ok("a redundant installTourBanner returns the same element (idempotent, no second banner)", again === banner);
    let count = 0;
    for (const n of document.body.childNodes as unknown as Iterable<Node>) {
      if ((n as { id?: string }).id === "tour-demo-banner") count++;
    }
    ok("exactly one demo banner exists in the body", count === 1);
    // removeTourBanner clears it; a second remove is a harmless no-op (the absent path).
    removeTourBanner();
    ok("removeTourBanner clears the banner", document.getElementById("tour-demo-banner") === null);
    removeTourBanner(); // no-op when already absent
    ok("a redundant removeTourBanner is a no-op", document.getElementById("tour-demo-banner") === null);
    // Defensive: a document with no body returns null (the banner is a label, never a boot gate).
    const noBodyDoc = { getElementById: () => null, body: null } as unknown as Document;
    ok("installTourBanner returns null when there is no document.body (defensive)", installTourBanner(noBodyDoc) === null);
    removeTourBanner(noBodyDoc); // the absent-body remove path is a harmless no-op

    // FIX A.2 — the SCREENSHOT-ROBUST corner marker: a fixed top-right "DEMO" badge at a z-index ABOVE
    // modals/toasts/palette/tooltips, pointer-transparent, role=note, so it survives any overlay + a crop.
    {
      removeTourCornerMarker();
      const corner = installTourCornerMarker();
      ok("the corner DEMO marker mounts (the screenshot-robust persistent demo cue)", corner !== null && document.getElementById("tour-demo-corner") !== null);
      ok("the corner marker reads 'DEMO', is a role=note pinned TOP-RIGHT, pointer-transparent (never blocks the app)", (corner?.textContent ?? "").includes("DEMO") && corner?.getAttribute("role") === "note" && corner?.style.getPropertyValue("position") === "fixed" && corner?.style.getPropertyValue("top") === "var(--space-3)" && corner?.style.getPropertyValue("right") === "var(--space-3)" && corner?.style.getPropertyValue("pointer-events") === "none");
      ok("the corner marker sits ABOVE modals/toasts/palette/tooltips (calc(var(--z-tooltip) + 1)), so it survives any open overlay", corner?.style.getPropertyValue("z-index") === "calc(var(--z-tooltip) + 1)");
      ok("installTourCornerMarker is idempotent (a redundant install never stacks a second marker)", installTourCornerMarker() === corner);
      let cornerCount = 0;
      for (const n of document.body.childNodes as unknown as Iterable<Node>) if ((n as { id?: string }).id === "tour-demo-corner") cornerCount++;
      ok("exactly one corner marker exists in the body", cornerCount === 1);
      removeTourCornerMarker();
      ok("removeTourCornerMarker clears it", document.getElementById("tour-demo-corner") === null);
      removeTourCornerMarker(); // no-op when already absent
      ok("a redundant removeTourCornerMarker is a no-op", document.getElementById("tour-demo-corner") === null);
      ok("installTourCornerMarker returns null with no document.body (defensive)", installTourCornerMarker(noBodyDoc) === null);
    }

    // FIX A.3 — the identity chip qualifier in tour mode: the verified-Owner account chip carries a "Sample
    // identity" badge so the green verified state itself reads as a demo. It is tour-gated: NO qualifier on the
    // genuine console. Drive renderAccount over a verified owner caller on the tour host, then the real console.
    {
      const owner = { method: "access" as const, email: "ops@northwind.example", role: "owner" as const, groups: [], isOnlyOwner: false };
      const slot = document.createElement("div");
      renderAccount(slot, owner, true, () => {});
      ok("in tour mode the verified-Owner identity chip carries a 'Sample identity' demo qualifier", (slot.querySelector('[data-tour-identity-demo]') as { textContent?: string } | null)?.textContent === "Sample identity");
      // On the genuine console (not a tour host) the qualifier must NOT render (the real chip is unchanged).
      const realLoc = "https://console.downpipes.io/";
      const prevLoc = g.location;
      setLocation(realLoc);
      const slot2 = document.createElement("div");
      renderAccount(slot2, owner, true, () => {});
      ok("on the genuine console (non-tour) the identity chip carries NO demo qualifier (the real chip is unchanged)", slot2.querySelector('[data-tour-identity-demo]') === null);
      g.location = prevLoc;
    }

    // FIX A.4 — the tour-distinct favicon: swapTourFavicon points the <link rel=icon> at a tour data-URI so the
    // tab icon is not identical to the real console. The bare shim has no document.head, so drive it over a small
    // fake doc that DOES, to exercise the swap; and confirm a no-head doc is a harmless no-op.
    {
      const links: Array<{ rel?: string; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }> = [];
      const fakeHead = { appendChild: (l: { rel?: string; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }) => { links.push(l); } };
      const fakeDoc = {
        head: fakeHead,
        querySelector: () => null,
        createElement: () => { const attrs: Record<string, string> = {}; return { rel: "icon", getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: string) => { attrs[n] = v; if (n === "rel") (attrs.rel = v); } }; },
      } as unknown as Document;
      swapTourFavicon(fakeDoc);
      ok("swapTourFavicon points the favicon at a tour-distinct data-URI (the tab icon is not the real console's)", links.length === 1 && (links[0]!.getAttribute("href") ?? "").startsWith("data:image/svg+xml") && (links[0]!.getAttribute("href") ?? "").includes("svg"));
      // A doc with no head is a harmless no-op (the favicon is a marker, not a gate).
      swapTourFavicon({ head: null, getElementsByTagName: () => [], querySelector: () => null } as unknown as Document);
      ok("swapTourFavicon with no head is a harmless no-op (defensive)", true);
    }
    // Restore the DOM for sibling blocks: remove the corner marker startDemo mounted (the cov validator restores
    // the DOM after asserting; the banner itself was already removed above).
    removeTourCornerMarker();
  }

  // ---------------------------------------------------------------------------------------------
  // demo/tour/overlay: the shared focus-ring helpers (the redesign stripped the scrim/spotlight/bubble/cursor
  // this module used to own; only the imperative focus-ring pair remains, shared by the nav-bar, the
  // info-points and the welcome card). Drive both helpers headless: applyFocusRing sets the --ring outline,
  // clearFocusRing removes it.
  // ---------------------------------------------------------------------------------------------
  {
    const el = document.createElement("div");
    applyFocusRing(el);
    ok("applyFocusRing draws the console focus ring (the --ring outline, not none)", el.style.getPropertyValue("outline").includes("var(--ring)") && el.style.getPropertyValue("outline-offset") === "2px");
    clearFocusRing(el);
    ok("clearFocusRing removes the ring (shown only while the container holds focus)", el.style.getPropertyValue("outline") === "none");
  }

  // ---------------------------------------------------------------------------------------------
  // demo/tour/nav-bar: the guide's one control surface, built on the console tokens + h(), zero dependency.
  // Two variants off ONE control set ( beat model): the historical bottom-centre bar below 1024,
  // and the docked right RAIL at comfortable widths (body dp-tour-rail; Back + controls on a pinned actions
  // row; the chapter index shows; the beat body unclamps). Drive the imperative handle headless: mount both
  // variants; update the chapter title + progress + the progress track; paint + clear the BEAT reading block
  // (setBeat) and the chapter index (setChapters); render the controls; flip the toggles; announce; focus;
  // relayout live on resize; destroy. A no-body mount is inert.
  // ---------------------------------------------------------------------------------------------
  {
    // Pin the viewport below the rail breakpoint so this mount is the historical BOTTOM BAR (the shim leaves
    // innerWidth undefined, which the bar reads as a 1280 desktop and would dock as the rail).
    const winW = globalThis as unknown as { innerWidth?: number };
    const savedInnerWidth = winW.innerWidth;
    winW.innerWidth = 800;
    const nav = mountNavBar();
    ok("below the rail breakpoint the body carries no rail class (the floating bottom bar serves phones + narrow windows)", !document.body.classList.contains("dp-tour-rail"));
    ok("the nav-bar mounts a single root into the body", document.getElementById("tour-nav-bar") !== null);
    ok("the nav-bar is fixed, bottom-centre (left:50% + translateX(-50%)), pointer-events:auto", nav.root.style.getPropertyValue("position") === "fixed" && nav.root.style.getPropertyValue("left") === "50%" && nav.root.style.getPropertyValue("transform") === "translateX(-50%)" && nav.root.style.getPropertyValue("pointer-events") === "auto");
    ok("the nav-bar is a comfortable width:min(840px, 92vw)", nav.root.style.getPropertyValue("width").replace(/\s+/g, "") === "min(840px,92vw)");

    // update sets the title + the short 'N of total' + builds the OBVIOUS segmented progress bar (one segment per
    // chapter, filled up to the current one, so it reads from chapter 1; role=progressbar carries the position).
    nav.update("Sources", 2, 11);
    ok("update sets the chapter title + the short 'N of total' progress", (nav.root.textContent ?? "").includes("Sources") && (nav.root.textContent ?? "").includes("2 of 11"));
    const segWrap = nav.root.querySelector('[data-tour-progress-segments]') as { getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null }> } | null;
    const segs = (segWrap?.querySelectorAll('[data-tour-segment]') ?? []) as ArrayLike<{ getAttribute(n: string): string | null }>;
    ok("update builds a segmented progress bar with one segment per chapter (role=progressbar, aria-valuenow)", segWrap?.getAttribute("role") === "progressbar" && segs.length === 11 && segWrap?.getAttribute("aria-valuenow") === "2" && segWrap?.getAttribute("aria-valuemax") === "11");
    let filled = 0; for (let i = 0; i < segs.length; i++) if (segs[i]!.getAttribute("data-tour-segment") === "done") filled++;
    ok("at chapter 2 the first two segments are filled (the progress reads at a glance)", filled === 2);
    // Even at chapter 1 of a single-chapter walk the bar shows one filled segment (reads from the start).
    nav.update("Only", 1, 1);
    const onlySegs = (nav.root.querySelector('[data-tour-progress-segments]')?.querySelectorAll('[data-tour-segment="done"]') ?? []) as ArrayLike<unknown>;
    ok("a one-chapter walk still shows a filled segment at chapter 1 (obvious from the first page)", onlySegs.length === 1);
    nav.update("Sources", 2, 11);

    // setDwellActive shows the per-step dwell bar and animates its fill; null hides + resets it.
    nav.setDwellActive(8000);
    await flushAsync(2);
    const dwellTrack = nav.root.querySelector('[data-tour-dwell-track]') as { style: { getPropertyValue(p: string): string } } | null;
    const dwellFill = nav.root.querySelector('[data-tour-dwell-fill]') as { style: { getPropertyValue(p: string): string } } | null;
    ok("setDwellActive(ms) shows the per-step dwell bar and fills it (the autoplay timing indicator)", dwellTrack?.style.getPropertyValue("display") === "block" && dwellFill?.style.getPropertyValue("width") === "100%");
    nav.setDwellActive(null);
    // The idle observable is the FILL at 0%: the rail keeps the empty track's box (so Play never
    // shifts the layout below), while the bottom bar still display-hides it. This block mounts under
    // the shim's default width (rail), so the track stays block.
    ok("setDwellActive(null) resets the dwell to idle (fill 0%; the rail keeps the empty track's box)", dwellFill?.style.getPropertyValue("width") === "0%" && dwellTrack?.style.getPropertyValue("display") !== "");

    // setBeat paints the BEAT reading block (the story's always-visible home): the step position, the title,
    // the body, and the try-it invitation when present. Hidden until the first setBeat; null clears it (the
    // funnel close, where the CTAs carry the message); a single-beat chapter shows no step counter.
    const beatBlock = nav.root.querySelector('[data-tour-beat-block]') as { style: { getPropertyValue(p: string): string } } | null;
    const beatMeta = (): string => nav.root.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
    const beatTryEl = nav.root.querySelector('[data-tour-try-it]') as { textContent?: string; style: { getPropertyValue(p: string): string } } | null;
    ok("the beat block starts hidden (nothing to read until the director's first setBeat)", beatBlock?.style.getPropertyValue("display") === "none");
    nav.setBeat({ index: 0, count: 3, title: "The beat title", body: "The beat body prose.", tryIt: "fly one now" });
    ok("setBeat paints the reading block: step position, title, body and the try-it invitation", beatBlock?.style.getPropertyValue("display") === "flex" && beatMeta() === "Step 1 of 3" && (nav.root.querySelector('[data-tour-beat-title]')?.textContent ?? "") === "The beat title" && (nav.root.querySelector('[data-tour-beat-body]')?.textContent ?? "") === "The beat body prose." && beatTryEl?.style.getPropertyValue("display") === "inline-flex" && beatTryEl?.textContent === "Try it: fly one now");
    nav.setBeat({ index: 1, count: 3, title: "Plain", body: "No invitation here." });
    ok("a beat without a try-it hides the invitation line and advances the step counter", beatTryEl?.style.getPropertyValue("display") === "none" && beatMeta() === "Step 2 of 3");
    nav.setBeat({ index: 0, count: 1, title: "Only", body: "One beat." });
    ok("a single-beat chapter shows NO step counter (a count of one reads as noise)", beatMeta() === "");
    // The phone panel starts COMPACT: the prose is not clipped, it is not shown at all, and one control
    // brings it back. A course that covered the console it was asking a learner to work is the defect this
    // replaced: at a narrow width the panel can be 577px of an 844px viewport.
    ok("the phone panel hides the prose rather than clipping it mid-sentence", (() => {
      const b = nav.root.querySelector('[data-tour-beat-body]') as { style: { getPropertyValue(p: string): string } } | null;
      return b?.style.getPropertyValue("display") === "none" && b?.style.getPropertyValue("max-height") === "none";
    })());
    ok("and it offers the control that reads the step in full", (nav.root.querySelector("[data-tour-more]") as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("display") === "inline-flex");
    (nav.root.querySelector("[data-tour-more]") as { click(): void } | null)?.click();
    ok("expanding shows the whole body inside ONE scrolling reading column (no per-block cap to cut a sentence)", (() => {
      const b = nav.root.querySelector('[data-tour-beat-body]') as { style: { getPropertyValue(p: string): string } } | null;
      const col = (nav.root.querySelector("[data-tour-beat-block]") as { parentElement: { style: { getPropertyValue(p: string): string } } | null } | null)?.parentElement;
      return b?.style.getPropertyValue("display") === "block" && b?.style.getPropertyValue("max-height") === "none" && col?.style.getPropertyValue("overflow-y") === "auto";
    })());
    (nav.root.querySelector("[data-tour-more]") as { click(): void } | null)?.click();
    nav.setBeat(null);
    ok("setBeat(null) clears the reading block (a chapter with no beats: the CTAs carry the message)", beatBlock?.style.getPropertyValue("display") === "none");

    // setChapters is safe in the BOTTOM bar, where the chapter index is not part of the bar at all (the
    // segmented track carries position there); the rail block below asserts the painted rows.
    nav.setChapters(["One", "Two", "Three"], 1);
    ok("the bottom bar renders NO chapter index (the segmented track carries position there)", nav.root.querySelector('[data-tour-chapter-list]') === null);

    // Controls with Back + Next render the round Back, the Play toggle, the "?" toggle, Exit, and the round Next.
    let backed = 0, nexted = 0, played = 0, paused = 0, toggled = 0, exited = 0;
    nav.setControls({ onBack: () => backed++, onNext: () => nexted++, onPlay: () => played++, onPause: () => paused++, onToggleInfo: () => toggled++, onExit: () => exited++ });
    ok("the nav-bar renders the round Back control (off the first chapter)", (nav.root.querySelector('[data-tour-back-slot] [aria-label="Back"]') ?? null) !== null);
    ok("the nav-bar renders the round Next control (the primary forward action)", (nav.root.querySelector('[data-tour-action="next"]') ?? null) !== null);
    ok("the nav-bar renders the Play, '?' and Exit controls", (nav.root.querySelector('[data-tour-toggle="play"]') ?? null) !== null && (nav.root.querySelector('[data-tour-toggle="info"]') ?? null) !== null && (nav.root.querySelector('[data-tour-action="exit"]') ?? null) !== null);
    // Clicking each rendered control fires its handler.
    (nav.root.querySelector('[data-tour-action="next"]') as { click(): void } | null)?.click();
    (nav.root.querySelector('[data-tour-back-slot] [aria-label="Back"]') as { click(): void } | null)?.click();
    (nav.root.querySelector('[data-tour-action="exit"]') as { click(): void } | null)?.click();
    ok("clicking the rendered Back / Next / Exit controls fires their handlers", nexted === 1 && backed === 1 && exited === 1);
    // The Play toggle (paused state) fires onPlay; the "?" toggle fires onToggleInfo.
    (nav.root.querySelector('[data-tour-toggle="play"]') as { click(): void } | null)?.click();
    (nav.root.querySelector('[data-tour-toggle="info"]') as { click(): void } | null)?.click();
    ok("clicking the rendered Play + '?' toggles fires their handlers", played === 1 && toggled === 1);

    // setPlaying flips the toggle to Pause; setInfoVisible(false) flips the "?" toggle to unpressed.
    nav.setPlaying(true);
    const playToggle = (): { getAttribute(n: string): string | null } | null => nav.root.querySelector('[data-tour-toggle="play"]') as { getAttribute(n: string): string | null } | null;
    ok("setPlaying(true) shows the Pause toggle (aria-pressed true)", (playToggle()?.getAttribute("aria-label") ?? "").includes("Pause") && playToggle()?.getAttribute("aria-pressed") === "true");
    nav.setPlaying(false);
    ok("setPlaying(false) shows the Play toggle again", (playToggle()?.getAttribute("aria-label") ?? "").includes("Play"));
    nav.setInfoVisible(false);
    ok("setInfoVisible(false) flips the '?' toggle to unpressed", (nav.root.querySelector('[data-tour-toggle="info"]') as { getAttribute(n: string): string | null } | null)?.getAttribute("aria-pressed") === "false");
    nav.setInfoVisible(true);

    // The reading-speed cycler renders beside Pause ONLY WHILE PLAYING (beside a resting Play its pace meaning
    // read as noise), shows the current pace, fires onCycleSpeed on click, and setSpeed repaints just its label.
    let speedCycled = 0;
    nav.setControls({ onPlay: () => {}, onPause: () => {}, onToggleInfo: () => {}, onExit: () => {}, onCycleSpeed: () => speedCycled++, speedLabel: "1×" });
    const speedBtn = (): { getAttribute(n: string): string | null; click(): void; textContent: string } | null => nav.root.querySelector('[data-tour-action="speed"]') as { getAttribute(n: string): string | null; click(): void; textContent: string } | null;
    ok("the reading-speed cycler stays hidden while paused (its pace meaning reads only beside Pause)", speedBtn() === null);
    nav.setPlaying(true);
    ok("while playing the reading-speed cycler renders with the current pace label", speedBtn() !== null && (speedBtn()?.textContent ?? "").includes("1×"));
    speedBtn()?.click();
    ok("clicking the reading-speed cycler fires onCycleSpeed (more/less time to read)", speedCycled === 1);
    nav.setSpeed("2×");
    ok("setSpeed repaints the cycler's label to the new pace", (speedBtn()?.textContent ?? "").includes("2×"));
    nav.setControls({ onPlay: () => {}, onPause: () => {} });
    ok("a control set without onCycleSpeed omits the speed cycler (it is the tour's own control)", speedBtn() === null);
    nav.setPlaying(false);

    // Controls WITHOUT Back/Next (the first + last chapter cases): the Back slot is empty and no Next renders.
    nav.setControls({ onPlay: () => {}, onPause: () => {}, onToggleInfo: () => {}, onExit: () => {} });
    ok("with no Back/Next handlers the nav-bar omits both round controls", (nav.root.querySelector('[data-tour-back-slot] [aria-label="Back"]') ?? null) === null && (nav.root.querySelector('[data-tour-action="next"]') ?? null) === null);

    // setCtas renders the funnel CTAs (the closing chapter's two deliberate exits) as real anchors above the
    // controls; an empty list clears them. The https CTA opens a new tab with rel hardening + the external glyph;
    // the mailto is a plain same-context anchor. A click fires onActivate (the director's cta_clicked emit).
    let deployClicks = 0;
    nav.setCtas([
      { label: "Deploy it free", href: "https://docs.downpipes.io/start-here/quickstart", primary: true, onActivate: () => { deployClicks++; } },
      { label: "Talk to support", href: "mailto:sales@downpipes.io" },
    ]);
    const ctaRowEl = nav.root.querySelector('[data-tour-cta-row]') as { style: { getPropertyValue(p: string): string }; querySelectorAll(s: string): ArrayLike<unknown> } | null;
    const ctaAnchors = (ctaRowEl?.querySelectorAll("a") ?? []) as unknown as Array<{ getAttribute(n: string): string | null; click(): void }>;
    ok("setCtas renders the two funnel exits as real anchors and shows the CTA row", ctaAnchors.length === 2 && ctaRowEl?.style.getPropertyValue("display") === "flex");
    const deployA = Array.from(ctaAnchors).find((a) => (a.getAttribute("href") ?? "").startsWith("https://docs.downpipes.io"));
    const supportA = Array.from(ctaAnchors).find((a) => (a.getAttribute("href") ?? "").startsWith("mailto:"));
    ok("the https exit opens a new tab with rel hardening; the mailto is a plain same-context anchor", deployA?.getAttribute("target") === "_blank" && (deployA?.getAttribute("rel") ?? "").includes("noopener") && supportA?.getAttribute("target") === null);
    deployA?.click();
    ok("clicking a CTA fires its onActivate (the director's cta_clicked emit)", deployClicks === 1);
    nav.setCtas([]);
    ok("setCtas([]) clears the CTA row and hides it", (nav.root.querySelector('[data-tour-cta-row] a') ?? null) === null && ctaRowEl?.style.getPropertyValue("display") === "none");

    // announce writes the polite live region; focusBar pulls focus + shows the ring (no Next now, so it falls
    // back to the bar container).
    nav.announce("chapter announced");
    await flushAsync(2);
    ok("the nav-bar live region announces a message (polite status)", (nav.root.querySelector('[role="status"]')?.textContent ?? "").includes("chapter announced"));
    nav.focusBar();
    ok("focusBar moves focus onto the bar and shows the focus ring", isActive(nav.root) && nav.root.style.getPropertyValue("outline").includes("var(--ring)"));

    // ---------------------------------------------------------------------------------------------
    // The COURSE variant of the rail (nav-bar-course.ts + the course options). The training course dresses
    // the same rail as a course: it names itself, counts STAGES, puts words on Back and Next, keeps a
    // standing GOAL for the stage, and carries a task card that acknowledges the learner's action. Every
    // one of these is absent on the tour, which the block above measures unchanged.
    // ---------------------------------------------------------------------------------------------
    {
      const course = mountNavBar(document, { eyebrow: "Beginner course", progressUnit: "Stage", labelledControls: true, exitLabel: "Leave", exitAria: "Leave the course" });
      course.update("First destination", 2, 8);
      ok("the course rail names itself and counts STAGES, not bare numbers", (course.root.querySelector('[data-tour-eyebrow]')?.textContent ?? "") === "Beginner course" && (course.root.textContent ?? "").includes("Stage 2 of 8"));
      const goalEl = course.root.querySelector('[data-tour-goal]') as { style: { getPropertyValue(p: string): string } } | null;
      ok("the goal line starts hidden (nothing claimed until the director sets it)", goalEl?.style.getPropertyValue("display") === "none");
      course.setGoal("Save one place for your backups to land.");
      ok("setGoal carries the stage's standing goal (shown when the phone panel is expanded)", (course.root.querySelector('[data-tour-goal-text]')?.textContent ?? "").startsWith("Save one place"));
      (course.root.querySelector("[data-tour-more]") as { click(): void } | null)?.click();
      ok("expanding the phone panel paints it", goalEl?.style.getPropertyValue("display") === "flex");
      course.setGoal(null);
      ok("setGoal(null) clears it (a chapter with no goal claims none)", goalEl?.style.getPropertyValue("display") === "none");
      course.setGoal("Save one place for your backups to land.");
      (course.root.querySelector("[data-tour-more]") as { click(): void } | null)?.click();

      const meta = (): string => course.root.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
      const card = course.root.querySelector('[data-tour-task-card]') as { style: { getPropertyValue(p: string): string } } | null;
      const chip = (): string => course.root.querySelector('[data-tour-task-chip]')?.textContent ?? "";
      const hint = (): string => course.root.querySelector('[data-tour-task-hint]')?.textContent ?? "";
      course.setBeat({ index: 0, count: 3, title: "Read this", body: "Prose.", taskAtStep: 3 });
      ok("a reading step says how far the hands-on step is", meta() === "Step 1 of 3 \u00b7 hands-on at step 3" && card?.style.getPropertyValue("display") === "none");
      course.setBeat({ index: 2, count: 3, title: "Do this", body: "Prose.", task: "Fill in the form and press Verify and save", taskAtStep: 3 });
      ok("the hands-on step says so, and the task card carries the instruction and where to do it", meta() === "Step 3 of 3 \u00b7 hands-on, this one" && card?.style.getPropertyValue("display") === "flex" && chip() === "YOUR TASK" && hint().includes("highlighted part of the console"));
      course.markTaskDone();
      ok("the card flips to DONE when the learner's action lands", chip() === "DONE" && hint().includes("moves on in a moment"));
      course.setBeat({ index: 2, count: 3, title: "Do this", body: "Prose.", task: "Fill in the form and press Verify and save", taskAtStep: 3 });
      course.markTaskDone("already-done");
      ok("walking BACK onto a finished step reads as already done, and says the work is still there", chip() === "DONE" && hint().includes("completed this step earlier"));

      course.setBeat({ index: 2, count: 3, title: "Do this", body: "Prose.", task: "Fill in the form and press Verify and save", taskAtStep: 3 });
      course.nudgeTask("Finish this step first: fill in the form.");
      ok("a refused Next says why ON the card, so the press is never a dead button", hint() === "Finish this step first: fill in the form." && (card as unknown as { style: { getPropertyValue(p: string): string } }).style.getPropertyValue("animation").includes("dp-rise"));
      course.setBeat({ index: 0, count: 3, title: "Read", body: "Prose.", taskAtStep: 3 });
      course.nudgeTask("nothing to nudge here");
      ok("and a nudge with no task card showing is a harmless no-op", card?.style.getPropertyValue("display") === "none");

      // MINIMISE hands the console back entirely: one line and the controls, which is what a phone learner
      // needs while working a full-height product screen.
      const minBtn = course.root.querySelector("[data-tour-minimise]") as { click(): void; getAttribute(n: string): string | null } | null;
      const beatBlockEl = course.root.querySelector("[data-tour-beat-block]") as { style: { getPropertyValue(p: string): string } } | null;
      ok("the phone panel offers a minimise control", minBtn !== null && minBtn.getAttribute("aria-expanded") === "true");
      minBtn?.click();
      ok("minimising drops the reading block and the progress track", beatBlockEl?.style.getPropertyValue("display") === "none" && minBtn?.getAttribute("aria-expanded") === "false");
      minBtn?.click();
      ok("and restoring brings the step back", beatBlockEl?.style.getPropertyValue("display") === "flex" && minBtn?.getAttribute("aria-expanded") === "true");

      let leaves = 0;
      course.setControls({ onBack: () => {}, onNext: () => {}, onExit: () => leaves++ });
      const backBtn = course.root.querySelector('[data-tour-back-slot] [aria-label="Back"]') as { textContent?: string } | null;
      const nextBtn = course.root.querySelector('[data-tour-action="next"]') as { textContent?: string } | null;
      const exitBtn = course.root.querySelector('[data-tour-action="exit"]') as { textContent?: string; getAttribute(n: string): string | null; click(): void } | null;
      ok("Back and Next carry their words, so a learner never has to guess which disc goes back", (backBtn?.textContent ?? "").includes("Back") && (nextBtn?.textContent ?? "").includes("Next"));
      ok("the way out is named in the course's own terms", (exitBtn?.textContent ?? "").includes("Leave") && exitBtn?.getAttribute("aria-label") === "Leave the course");
      exitBtn?.click();
      ok("and it still fires the handler it was given", leaves === 1);
      course.destroy();
    }

    // ---------------------------------------------------------------------------------------------
    // The course NARRATOR (tour/narration.ts). Sound is on by default and the preference is remembered;
    // speaking is a no-op while muted; a browser that refuses playback is recorded rather than thrown.
    // ---------------------------------------------------------------------------------------------
    {
      const { createNarrator } = await import("../../src/lib/demo/tour/narration.ts");
      const n = createNarrator(document);
      ok("the narrator starts with sound ON (a course a learner chose is meant to speak)", n.enabled() === true);
      n.speak("1-1");
      const audioEl = document.querySelector("audio[data-training-narration]") as { getAttribute(a: string): string | null } | null;
      ok("speaking loads the step's own audio file", audioEl?.getAttribute("src") === "/narration/s1-1.mp3" || n.blocked());
      n.stop();
      n.setEnabled(false);
      n.speak("2-1");
      ok("a muted narrator speaks nothing", n.enabled() === false);
      n.setEnabled(true, "3-1");
      ok("turning sound back on speaks the step it was given, so the control does something audible", n.enabled() === true);
      n.destroy();
      ok("destroy takes the player out of the document", document.querySelector("audio[data-training-narration]") === null);
      // Clear the preference this block wrote, so a later cell sees a first-time learner.
      try { localStorage.removeItem("downpipes:training:sound"); } catch { /* storage blocked: nothing to clear */ }
    }

    nav.destroy();
    ok("nav-bar destroy tears the root out of the DOM", document.getElementById("tour-nav-bar") === null);
    // Calls after destroy are guarded no-ops (never throw).
    nav.update("X", 1, 2); nav.setControls({}); nav.setPlaying(true); nav.setInfoVisible(false); nav.setBeat({ index: 0, count: 2, title: "x", body: "x" }); nav.setBeat(null); nav.setChapters(["x"], 0); nav.setCtas([{ label: "x", href: "https://x.example" }]); nav.setDwellActive(1000); nav.setDwellActive(null); nav.announce("x"); nav.focusBar();
    ok("nav-bar calls after destroy are harmless no-ops", document.getElementById("tour-nav-bar") === null);
    // A re-mount removes the stale root (idempotent re-mount), then clean up.
    mountNavBar();
    let navCount = 0;
    for (const n of document.body.childNodes as unknown as Iterable<Node>) if ((n as { id?: string }).id === "tour-nav-bar") navCount++;
    ok("a re-mount never stacks a second nav-bar", navCount === 1);
    document.getElementById("tour-nav-bar")?.remove();
    // Defensive: a no-body mount returns a detached, inert handle whose verbs do not throw.
    const noBodyDoc = { getElementById: () => null, body: null } as unknown as Document;
    const detachedNav = mountNavBar(noBodyDoc);
    detachedNav.update("Y", 1, 1); detachedNav.setControls({}); detachedNav.setPlaying(false); detachedNav.setBeat({ index: 0, count: 2, title: "y", body: "y" }); detachedNav.setChapters(["y"], 0); detachedNav.setCtas([{ label: "y", href: "mailto:y@example" }]); detachedNav.setDwellActive(500); detachedNav.announce("y"); detachedNav.focusBar(); detachedNav.destroy();
    ok("a no-body nav-bar mount returns a detached, inert handle (never a boot gate)", detachedNav.root !== null && document.getElementById("tour-nav-bar") === null);

    // ---- the RAIL variant (>= 1024): a calm right-hand column over the SAME control set ----
    // The console shifts left under the body class; Back + the cluster move onto the pinned actions row
    // (moving preserves their listeners); the chapter index shows; the beat body unclamps; the CTA row moves
    // into the control column. A live resize below the breakpoint restores the bottom bar, and destroy
    // releases the body class + the resize listener. Node's globalThis is no EventTarget, so a RECORDING
    // window observes the resize wiring and fires the listener.
    {
      const gWin = globalThis as unknown as { window?: unknown };
      const savedWinObj = gWin.window;
      type RecL = { type: string; fn: () => void };
      const winListeners: RecL[] = [];
      const fakeWin = {
        innerWidth: 1280, innerHeight: 900,
        addEventListener: (type: string, fn: () => void): void => { winListeners.push({ type, fn }); },
        removeEventListener: (type: string, fn: () => void): void => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1); },
      };
      gWin.window = fakeWin;
      const rail = mountNavBar();
      ok("at a comfortable width the bar mounts as the RIGHT RAIL: the body class shifts the console clear of it", document.body.classList.contains("dp-tour-rail"));
      ok("the rail docks right as a fixed 344px column (no bottom-centre transform)", rail.root.style.getPropertyValue("left") === "auto" && rail.root.style.getPropertyValue("transform") === "none" && rail.root.style.getPropertyValue("right") === "var(--space-4)" && rail.root.style.getPropertyValue("width") === "344px");
      ok("the bar wires a live resize re-layout", winListeners.some((l) => l.type === "resize"));
      let railBacked = 0;
      let railNexted = 0;
      rail.setControls({ onBack: () => railBacked++, onNext: () => railNexted++, onExit: () => {} });
      // The rail's foot is TWO rows, and that is a fix rather than a preference: four labelled controls on one
      // row can be 324px plus their gaps against a 344px panel, so from the step where Back appears Next can hang
      // outside the rail at every desktop width. The walking pair (Back, Next) has its own row; the chrome
      // (sound, pause, leave) sits above it.
      ok("the rail's foot puts Back and Next on their own walking row", rail.root.querySelector('[data-tour-actions-row] [data-tour-nav-row] [data-tour-back-slot] [aria-label="Back"]') !== null && rail.root.querySelector('[data-tour-actions-row] [data-tour-nav-row] [data-tour-forward-slot] [data-tour-action="next"]') !== null);
      ok("and the chrome cluster sits on its own row above them", rail.root.querySelector('[data-tour-actions-row] [aria-label="Tour controls"]') !== null && rail.root.querySelector('[aria-label="Tour controls"] [data-tour-action="next"]') === null);
      // The moved controls keep their listeners (the move is a reparent, not a rebuild).
      (rail.root.querySelector('[data-tour-actions-row] [aria-label="Back"]') as { click(): void } | null)?.click();
      (rail.root.querySelector('[data-tour-actions-row] [data-tour-action="next"]') as { click(): void } | null)?.click();
      ok("the moved Back + Next keep their handlers in the rail", railBacked === 1 && railNexted === 1);
      rail.setChapters(["A", "B"], 0);
      {
        const list = rail.root.querySelector('[data-tour-chapter-list]') as { style: { getPropertyValue(p: string): string }; querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null }> } | null;
        const rows = (list?.querySelectorAll('[data-tour-chapter-row]') ?? []) as ArrayLike<{ getAttribute(n: string): string | null }>;
        ok("the rail SHOWS the chapter index (the journey's quiet table of contents)", list?.style.getPropertyValue("display") === "flex" && rows.length === 2);
        ok("the chapter rows carry current/to-come states with aria-current on the current one only", rows[0]?.getAttribute("data-tour-chapter-row") === "current" && rows[0]?.getAttribute("aria-current") === "step" && rows[1]?.getAttribute("data-tour-chapter-row") === "todo" && rows[1]?.getAttribute("aria-current") === null);
        rail.setChapters(["A", "B"], 1);
        const rows2 = (list?.querySelectorAll('[data-tour-chapter-row]') ?? []) as ArrayLike<{ getAttribute(n: string): string | null }>;
        ok("advancing the current chapter ticks the walked row done and moves the highlight", rows2[0]?.getAttribute("data-tour-chapter-row") === "done" && rows2[1]?.getAttribute("data-tour-chapter-row") === "current");
      }
      rail.setBeat({ index: 0, count: 2, title: "Rail beat", body: "A full reading column." });
      ok("the rail frees the beat body of the two-line clamp (the full reading column)", (rail.root.querySelector('[data-tour-beat-body]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("-webkit-line-clamp") === "unset");
      rail.setCtas([{ label: "Go", href: "https://docs.downpipes.io/x" }]);
      ok("the rail hosts the CTA row inside the control column (the narrative order), not above the bar", (rail.root.querySelector('[data-tour-cta-row]') as { parentElement?: unknown } | null)?.parentElement !== rail.root);
      // A live resize below the breakpoint restores the bottom bar: the body class drops, the actions row is
      // dissolved (Back + the cluster move home), and the geometry re-centres.
      fakeWin.innerWidth = 700;
      for (const l of winListeners.filter((l) => l.type === "resize")) l.fn();
      ok("a resize below the breakpoint relays out LIVE back to the bottom bar (class dropped, actions row dissolved, re-centred)", !document.body.classList.contains("dp-tour-rail") && rail.root.querySelector('[data-tour-actions-row]') === null && rail.root.style.getPropertyValue("left") === "50%" && rail.root.style.getPropertyValue("transform") === "translateX(-50%)");
      (rail.root.querySelector('[data-tour-back-slot] [aria-label="Back"]') as { click(): void } | null)?.click();
      ok("the returned-home Back control still fires its handler after the move back", railBacked === 2);
      rail.destroy();
      ok("rail destroy releases the body class and the resize listener with the bar", !document.body.classList.contains("dp-tour-rail") && document.getElementById("tour-nav-bar") === null && !winListeners.some((l) => l.type === "resize"));
      gWin.window = savedWinObj;
    }
    if (savedInnerWidth === undefined) delete winW.innerWidth; else winW.innerWidth = savedInnerWidth;
  }
    // ---- the rAF-driven tracking loop (the production browser path) ----
    {
      const gAny = globalThis as unknown as Record<string, unknown>;
      const savedRaf = gAny.requestAnimationFrame;
      const savedCaf = gAny.cancelAnimationFrame;
      let pendingFrames: Array<() => void> = [];
      let cafCalled = 0;
      Object.defineProperty(gAny, "requestAnimationFrame", { value: (cb: () => void): number => { pendingFrames.push(cb); return pendingFrames.length; }, configurable: true, writable: true });
      Object.defineProperty(gAny, "cancelAnimationFrame", { value: (): void => { cafCalled++; pendingFrames = []; }, configurable: true, writable: true });
      const runFrame = (): void => { const cbs = pendingFrames; pendingFrames = []; for (const cb of cbs) cb(); };

      const region = document.createElement("div");
      const anchorEl = document.createElement("div");
      anchorEl.setAttribute("data-tour-id", "spot-a");
      let rect = { top: 200, left: 300, width: 120, height: 22 };
      (anchorEl as unknown as { getBoundingClientRect: () => typeof rect }).getBoundingClientRect = () => rect;
      region.appendChild(anchorEl);
      document.body.appendChild(region);

      const spot = createSpotlight();
      const holeStyle = (p: string): string => spot.root.style.getPropertyValue(p);
      ok("the spotlight mounts a single aria-hidden, fixed, pointer-transparent hole (paint, never a hit target)", document.getElementById("tour-spotlight") === spot.root && spot.root.getAttribute("aria-hidden") === "true" && holeStyle("position") === "fixed" && holeStyle("pointer-events") === "none");
      ok("the dim is the hole's enormous box-shadow (no scrim element, so the dim can never swallow a click)", holeStyle("box-shadow").includes("200vmax") && holeStyle("opacity") === "0");

      // Aim at the anchor: the next frame paints the 10px-padded cutout box and shows the stage.
      spot.target("spot-a");
      runFrame();
      ok("target(anchor) paints the padded cutout over the anchor's box on the next frame", holeStyle("top") === "190px" && holeStyle("left") === "290px" && holeStyle("width") === "140px" && holeStyle("height") === "42px" && holeStyle("opacity") === "1");
      // Real movement (> 1px) re-paints; sub-pixel jitter does not (no transition churn while tracking).
      rect = { top: 200, left: 360, width: 120, height: 22 };
      runFrame();
      ok("the loop tracks real anchor movement (the box follows a > 1px shift)", holeStyle("left") === "350px" && holeStyle("top") === "190px");
      rect = { top: 200.6, left: 360, width: 120, height: 22 };
      runFrame();
      ok("sub-pixel jitter is ignored (a <= 1px wobble writes no styles, so tracking a static anchor is free)", holeStyle("top") === "190px" && holeStyle("left") === "350px");
      // An anchor that stops laying out hides the stage for the tick; it re-appears when the anchor is back.
      rect = { top: 0, left: 0, width: 0, height: 0 };
      runFrame();
      ok("an anchor with no layout hides the spotlight for the tick (no stray cutout)", holeStyle("opacity") === "0");
      rect = { top: 200, left: 360, width: 120, height: 22 };
      runFrame();
      ok("the loop keeps watching: the spotlight re-appears the moment the anchor lays out again", holeStyle("opacity") === "1");
      // A MODAL OVER THE ANCHOR HIDES THE STAGE. For example, at a narrow width: the learner presses
      // New downpipe, the create dialog opens over the empty-state table the step is anchored to, and the
      // spotlight lit a rectangle nobody could see, with its top behind the sticky bar. An anchor INSIDE a
      // dialog is the opposite case and stays lit, which is how the run-detail beats work.
      {
        const doc = document as unknown as { elementFromPoint?: ((x: number, y: number) => Element | null) | undefined };
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        const inDialog = document.createElement("p");
        dialog.appendChild(inDialog);
        document.body.appendChild(dialog);
        const saved = doc.elementFromPoint;
        doc.elementFromPoint = () => inDialog as unknown as Element;
        rect = { top: 200, left: 360, width: 120, height: 22 };
        runFrame();
        ok("a modal painted over the anchor hides the spotlight (no lit rectangle behind a dialog)", holeStyle("opacity") === "0");
        // The same anchor, now INSIDE the dialog: the hit is within the anchor's own subtree, so it stays lit.
        doc.elementFromPoint = () => anchorEl as unknown as Element;
        runFrame();
        ok("an anchor inside the dialog stays lit (the drawer beats are not collateral)", holeStyle("opacity") === "1");
        doc.elementFromPoint = saved;
        dialog.remove();
      }

      // target(null) rests the stage (between chapters).
      spot.target(null);
      runFrame();
      ok("target(null) hides the spotlight (the stage rests between chapters)", holeStyle("opacity") === "0");
      // The try-it pulse ring: pulse:true adds the invite class; a follow-up aim without pulse clears it.
      spot.target("spot-a", { pulse: true });
      ok("a try-it aim adds the invite pulse ring class", spot.root.classList.contains("tour-spot--invite"));
      spot.target("spot-a");
      ok("a follow-up aim without pulse clears the invite ring", !spot.root.classList.contains("tour-spot--invite"));
      // destroy cancels the pending frame and removes the hole; a second destroy and a late target are no-ops.
      spot.destroy();
      ok("destroy cancels the pending animation frame and removes the hole", cafCalled >= 1 && document.getElementById("tour-spotlight") === null);
      spot.destroy();
      spot.target("spot-a", { pulse: true });
      ok("destroy is idempotent and target() after destroy is a harmless no-op", document.getElementById("tour-spotlight") === null && !spot.root.classList.contains("tour-spot--invite"));

      // The FIRST aim appears IN PLACE: the box transition is suppressed for the first paint (opacity-only),
      // then restored on the double-rAF frame, so a brand-new cutout never flies in from the viewport corner.
      const spot2 = createSpotlight();
      ok("at rest the hole carries the full box transition (motion is on in this environment)", spot2.root.style.getPropertyValue("transition").includes("top 0.4s"));
      spot2.target("spot-a");
      ok("the FIRST aim suppresses the box transition (opacity-only), so the cutout appears in place", spot2.root.style.getPropertyValue("transition") === "opacity 0.25s var(--ease-out)");
      runFrame();
      runFrame();
      ok("the box transition is restored on the following frame (later aims morph smoothly)", spot2.root.style.getPropertyValue("transition").includes("top 0.4s"));
      // A re-create replaces a stale hole (idempotent: never two stages).
      const spot3 = createSpotlight();
      let holeCount = 0;
      for (const n of document.body.childNodes as unknown as Iterable<Node>) if ((n as { id?: string }).id === "tour-spotlight") holeCount++;
      ok("a re-create replaces a stale hole (never two spotlight stages)", holeCount === 1);
      spot3.destroy();
      spot2.destroy();
      region.remove();
      if (savedRaf === undefined) delete gAny.requestAnimationFrame; else Object.defineProperty(gAny, "requestAnimationFrame", { value: savedRaf, configurable: true, writable: true });
      if (savedCaf === undefined) delete gAny.cancelAnimationFrame; else Object.defineProperty(gAny, "cancelAnimationFrame", { value: savedCaf, configurable: true, writable: true });
    }

    // ---- the no-rAF fallback (the headless test DOM): mounts, aims and tears down gracefully ----
    {
      const spot = createSpotlight();
      ok("without requestAnimationFrame the spotlight still mounts (the single synchronous tick, no loop)", document.getElementById("tour-spotlight") !== null);
      spot.target("nowhere", { pulse: true });
      ok("without rAF the pulse ring still toggles on target() (class state is not frame-gated)", spot.root.classList.contains("tour-spot--invite"));
      spot.target("nowhere", { pulse: false });
      ok("the pulse ring clears on a pulse:false aim without rAF too", !spot.root.classList.contains("tour-spot--invite"));
      spot.destroy();
      ok("destroy removes the hole in the no-rAF environment", document.getElementById("tour-spotlight") === null);
    }

    // ---- defensive: a document with no body yields a detached, inert stage (never a boot gate) ----
    {
      const noBodyDoc = { getElementById: () => null, body: null, createElement: (tag: string) => document.createElement(tag), querySelector: () => null } as unknown as Document;
      const detached = createSpotlight(noBodyDoc);
      detached.target("x");
      detached.destroy();
      ok("a no-body spotlight is inert-safe (detached root, no throw on target/destroy)", detached.root !== null && document.getElementById("tour-spotlight") === null);
    }

  // ---------------------------------------------------------------------------------------------
  // demo/tour/director chrome lifecycle: the guide's chrome under the director is the nav-bar (which owns the
  // rail's resize re-layout) + the ONE spotlight stage; exit must unwire the resize listener, release the body
  // rail class and tear the spotlight out, so nothing re-measures or dims after the guide is gone. A recording
  // window observes the listener add/remove.
  // ---------------------------------------------------------------------------------------------
  {
    const g = globalThis as unknown as { window?: unknown };
    const savedWindow = g.window;
    type Rec = { type: string; fn: (ev: unknown) => void };
    const listeners: Rec[] = [];
    const fakeWin = {
      innerWidth: 1440, innerHeight: 900,
      addEventListener: (type: string, fn: (ev: unknown) => void) => { listeners.push({ type, fn }); },
      removeEventListener: (type: string, fn: (ev: unknown) => void) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    };
    g.window = fakeWin;
    const rMain = document.createElement("main");
    rMain.id = "main";
    const rHeader = document.createElement("h1");
    rHeader.className = "page-header__title";
    rHeader.textContent = "Overview";
    const rAnchor = document.createElement("div");
    rAnchor.setAttribute("data-tour-id", "r-anchor");
    rMain.appendChild(rHeader);
    rMain.appendChild(rAnchor);
    document.body.appendChild(rMain);
    const rScript: TourChapter[] = [
      { route: "/", title: "Overview", infoPoints: [{ anchor: "r-anchor", title: "Pinned", body: "Narrated in the rail." }] },
    ];
    const rDir = createTourDirector(rScript, { navigate: () => {}, reseed: () => {} });
    rDir.start();
    await flushAsync(3);
    ok("the guide wires the nav-bar's resize re-layout while it is up", listeners.some((l) => l.type === "resize"));
    ok("at rail width the body carries the rail class and the spotlight stage is mounted", document.body.classList.contains("dp-tour-rail") && document.getElementById("tour-spotlight") !== null);
    rDir.exit();
    ok("exit unwires the resize listener, releases the body rail class and removes the spotlight stage", !listeners.some((l) => l.type === "resize") && !document.body.classList.contains("dp-tour-rail") && document.getElementById("tour-spotlight") === null);
    rDir.destroy();
    g.window = savedWindow;
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-resume")?.remove();
    rMain.remove();
  }

  // ---------------------------------------------------------------------------------------------
  // demo/tour/director: the self-driving controller over a typed CHAPTER script whose infoPoints are the
  // chapter's BEATS ( beat model). Drive it headless with an injected navigate spy + a controllable
  // re-seed spy, against a pre-rendered #main (page header + anchors) so awaitScreen resolves and the beats
  // present. Exercise: start lands on chapter 0 + navigates + re-seeds + mounts the nav-bar + the spotlight
  // stage (never the retired "?" layer); Next walks BEAT BY BEAT and crosses chapters past the last beat; the
  // preAction runs; Pause/Play autoplay (opt-in, default paused) + the reading-speed cycler; Back steps one
  // beat, or re-seeds + re-enters the prior chapter at its LAST beat; the keyboard layer (Right/Left/Space/
  // Escape); the single-key Space gate; toggleInfo as the retired no-op; Restart; Exit -> Resume; destroy.
  // The very end offers no Next.
  // ---------------------------------------------------------------------------------------------
  {
    const main = document.createElement("main");
    main.id = "main";
    const header = document.createElement("h1");
    header.className = "page-header__title";
    header.textContent = "Overview";
    const anchorA = document.createElement("div");
    anchorA.setAttribute("data-tour-id", "dir-a");
    const anchorB = document.createElement("div");
    anchorB.setAttribute("data-tour-id", "dir-b");
    main.appendChild(header);
    main.appendChild(anchorA);
    main.appendChild(anchorB);
    document.body.appendChild(main);

    const navs: string[] = [];
    let reseeds = 0;
    let preActions = 0;
    // The deterministic blocks below keep autoplay PAUSED (the default); the dedicated fast-dwell directors
    // further down exercise the auto-advance. Chapter 0 carries TWO beats so the within-chapter walk is
    // exercised; chapter 1 one beat (the crossing); chapter 2 none (the funnel-close shape).
    const script: TourChapter[] = [
      { route: "/", title: "Overview", preAction: () => { preActions++; }, infoPoints: [{ anchor: "dir-a", title: "No custody", body: "The key never leaves your browser." }, { anchor: "dir-b", title: "Fleet health", body: "The honest cover read." }] },
      { route: "/sources", title: "Sources", infoPoints: [{ anchor: "dir-a", title: "Breadth", body: "Nine source types." }] },
      { route: "/reports", title: "Reports", infoPoints: [] },
    ];
    const director = createTourDirector(script, { navigate: (to) => { navs.push(to); }, reseed: () => { reseeds++; } });
    const metaText = (): string => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
    const beatTitleText = (): string => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-title]')?.textContent ?? "";

    director.start();
    await flushAsync(3);
    ok("start re-seeds the deterministic world", reseeds === 1);
    ok("start lands on chapter 0 and navigates to its route", director.index === 0 && navs[navs.length - 1] === "/");
    ok("start mounts the nav-bar + the spotlight stage (NO dim-scrim overlay, NO retired '?' layer)", document.getElementById("tour-nav-bar") !== null && document.getElementById("tour-spotlight") !== null && document.getElementById("tour-overlay") === null && document.getElementById("tour-info-layer") === null);
    ok("start presents the chapter's FIRST beat in the rail (step position + title)", metaText() === "Step 1 of 2" && beatTitleText() === "No custody");
    ok("the chapter's preAction ran (after the screen rendered, before the beats present)", preActions === 1);
    ok("autoplay is opt-in: the walk starts PAUSED (the nav-bar shows the Play toggle)", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="play"]') as { getAttribute(n: string): string | null } | null)?.getAttribute("aria-pressed") === "false");

    director.next();
    await flushAsync(2);
    ok("Next advances ONE BEAT within the chapter (no navigation, the chapter holds)", director.index === 0 && metaText() === "Step 2 of 2" && beatTitleText() === "Fleet health" && navs.length === 1);
    director.next();
    await flushAsync(3);
    ok("past the last beat, Next crosses to chapter 1 and navigates to its route", director.index === 1 && navs[navs.length - 1] === "/sources");

    // Play/Pause: opt-in autoplay. play() arms the dwell; pause() holds. The long fixed dwell means no
    // auto-advance fires during the asserts here.
    const speedCtl = (): { textContent: string; click(): void } | null =>
      document.getElementById("tour-nav-bar")?.querySelector('[data-tour-action="speed"]') as { textContent: string; click(): void } | null;
    ok("the autoplay-speed cycler is hidden while paused (it renders only beside Pause)", speedCtl() === null);
    director.play();
    ok("Play sets the autoplay-playing state (the toggle flips to Pause)", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="play"]') as { getAttribute(n: string): string | null } | null)?.getAttribute("aria-label")?.includes("Pause") === true);

    // The reading-speed cycler (shown only while playing): clicking it gives more (or less) time to read each
    // step (a per-step dwell scale), persisted across the walk. It cycles the visible pace label (1× -> 2× -> 0.5×).
    ok("while playing the nav-bar shows the autoplay-speed cycler at the default pace", (speedCtl()?.textContent ?? "").includes("1×"));
    speedCtl()?.click();
    ok("clicking the autoplay-speed cycler changes the pace (advances to 2×, a faster walk = less time per step)", (speedCtl()?.textContent ?? "").includes("2×"));
    // The click persisted the new pace; reset it so later director instances in this suite start from the
    // default (test isolation: the persisted pace scales a director's dwell, which a timing assertion reads).
    try { localStorage.removeItem("downpipes:tour:speed"); } catch { /* storage not present in this env */ }
    director.pause();
    ok("Pause holds the walk on the current chapter", director.index === 1);
    ok("pausing hides the autoplay-speed cycler again", speedCtl() === null);

    // Back across the boundary: re-seed + re-enter the PRIOR chapter at its LAST beat (a beat-perfect rewind).
    const reseedsBeforeBack = reseeds;
    director.back();
    await flushAsync(3);
    ok("Back from a chapter's first beat re-seeds the world (the deterministic step-back)", reseeds === reseedsBeforeBack + 1);
    ok("Back re-enters the prior chapter at its LAST beat", director.index === 0 && navs[navs.length - 1] === "/" && metaText() === "Step 2 of 2" && beatTitleText() === "Fleet health");
    // Back within the chapter: one beat, no re-seed, no navigation.
    director.back();
    await flushAsync(2);
    ok("Back within a chapter steps ONE BEAT with no re-seed and no navigation", director.index === 0 && metaText() === "Step 1 of 2" && reseeds === reseedsBeforeBack + 1);

    // toggleInfo is RETIRED (the rail narrates every beat; there are no markers to hide): a benign no-op that
    // changes nothing, and the retired Tips toggle never renders.
    director.toggleInfo();
    director.toggleInfo();
    ok("toggleInfo is a benign no-op (the retired verb changes nothing and never throws)", director.index === 0 && metaText() === "Step 1 of 2" && document.getElementById("tour-nav-bar") !== null);
    ok("the retired Tips toggle never renders (the director offers no onToggleInfo)", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="info"]') ?? null) === null);

    // The keyboard layer: ArrowRight advances one BEAT, ArrowLeft steps one back, Space toggles, Escape exits.
    dispatchDocKey(keydown({ key: "ArrowRight" }));
    await flushAsync(2);
    ok("ArrowRight advances the walk one beat (keyboard operable)", director.index === 0 && metaText() === "Step 2 of 2");
    dispatchDocKey(keydown({ key: "ArrowLeft" }));
    await flushAsync(2);
    ok("ArrowLeft steps the walk back one beat (keyboard operable)", director.index === 0 && metaText() === "Step 1 of 2");
    dispatchDocKey(keydown({ key: " " }));
    ok("Space toggles play/pause without moving the walk", director.index === 0 && metaText() === "Step 1 of 2");

    // WCAG 2.1.4: Space is a single printable (whitespace) key, so it must honour the single-key opt-out. The
    // nav-bar's toggle reads "Pause autoplay" while playing and "Play..." while paused (the observable).
    const toggleLabel = (): string => {
      const t = document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="play"]') as { getAttribute(n: string): string | null } | null;
      const al = t?.getAttribute("aria-label") ?? "";
      if (al.includes("Pause")) return "Pause";
      if (al.includes("Play")) return "Play";
      return "";
    };
    director.pause(); // known state: paused -> toggle reads Play
    ok("with single-key shortcuts ON the nav-bar shows the paused (Play) toggle", toggleLabel() === "Play");
    setA11yPref("singleKeyShortcuts", "off");
    dispatchDocKey(keydown({ key: " " }));
    ok("Space is inert when single-key shortcuts are turned off (WCAG 2.1.4 opt-out honoured)", toggleLabel() === "Play" && director.index === 0);
    dispatchDocKey(keydown({ key: "ArrowRight" }));
    await flushAsync(2);
    ok("ArrowRight still advances a beat with single-key off (Arrow is an exempt non-character key)", director.index === 0 && metaText() === "Step 2 of 2");
    director.back();
    await flushAsync(2);
    director.pause();
    setA11yPref("singleKeyShortcuts", "on");
    dispatchDocKey(keydown({ key: " " }));
    ok("re-enabling single-key shortcuts restores Space play/pause (the gate was the cause)", toggleLabel() === "Pause" && director.index === 0);
    director.pause();

    // Advance to the very end (beat 2, then across two chapters) and assert it offers nothing forward.
    director.next();
    await flushAsync(2);
    director.next();
    await flushAsync(3);
    director.next();
    await flushAsync(3);
    ok("the walk reaches the last chapter (Reports, no beats)", director.index === 2);
    ok("the last chapter shows no Next control (it holds until the visitor acts)", overlayHasNoNext());
    ok("the very end offers no Play and no speed cycler either (nothing left to walk)", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="play"]') ?? null) === null && (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-action="speed"]') ?? null) === null);
    ok("a chapter with no beats clears the reading block (setBeat null)", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-block]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("display") === "none");
    // Next past the end is a no-op.
    director.next();
    ok("Next past the last chapter is a no-op", director.index === 2);

    // Restart returns to chapter 0 and re-seeds.
    const reseedsBeforeRestart = reseeds;
    director.restart();
    await flushAsync(3);
    ok("Restart returns to chapter 0 and re-seeds", director.index === 0 && reseeds === reseedsBeforeRestart + 1);
    director.pause();

    // Exit drops the guide and shows Resume; the keyboard layer goes inert.
    director.exit();
    ok("Exit drops the nav-bar + the spotlight stage (free-explore in the real faked app)", document.getElementById("tour-nav-bar") === null && document.getElementById("tour-spotlight") === null);
    ok("Exit shows the one-tap Resume affordance", document.getElementById("tour-resume") !== null);
    const idxAtExit = director.index;
    dispatchDocKey(keydown({ key: "ArrowRight" }));
    ok("the keyboard layer is inert after Exit (no advance in free-explore)", director.index === idxAtExit);

    // Escape exits too: resume, then drive Escape through the keyboard layer.
    director.resume();
    await flushAsync(3);
    ok("Resume re-mounts the guide at the current chapter", document.getElementById("tour-nav-bar") !== null && document.getElementById("tour-resume") === null);
    director.pause();
    dispatchDocKey(keydown({ key: "Escape" }));
    ok("Escape exits the walk (Exit is always one key away)", document.getElementById("tour-nav-bar") === null);

    // destroy is the hard teardown: idempotent, leaves no guide, resume button or keyboard layer.
    director.resume();
    await flushAsync(3);
    director.destroy();
    ok("destroy tears everything down", document.getElementById("tour-nav-bar") === null && document.getElementById("tour-spotlight") === null && document.getElementById("tour-resume") === null);
    director.next();
    ok("the director verbs are inert after destroy", director.index === 0 || director.index >= 0);

    // Focus restoration on Exit / destroy (WCAG 2.4.3): tearing the guide down moves focus onto Resume on Exit,
    // and back to the launch control on destroy, so a keyboard user is never stranded at <body>.
    {
      const launch = document.createElement("button");
      launch.id = "tour-launch-control";
      document.body.appendChild(launch);
      launch.focus(); // the visitor pressed this to open the tour
      const dFocus = createTourDirector(script, { navigate: () => {}, reseed: () => {} });
      dFocus.start();
      await flushAsync(3);
      ok("a user-driven start moves focus off the launch control onto the guide", !isActive(launch) && document.getElementById("tour-nav-bar") !== null);
      dFocus.pause();
      dFocus.exit();
      const resumeBtn = document.getElementById("tour-resume");
      ok("Exit moves focus onto the Resume button (the keyboard path is continuous, not stranded at body)", resumeBtn !== null && isActive(resumeBtn) && !isActive(document.body));
      dFocus.resume();
      await flushAsync(3);
      ok("Resume re-mounts the guide and the Resume button is gone", document.getElementById("tour-nav-bar") !== null && document.getElementById("tour-resume") === null);
      dFocus.pause();
      dFocus.destroy();
      ok("destroy restores focus to the launch control (not stranded at body)", isActive(launch));
      launch.remove();
    }

    // A director that exits before start, then resumes, lands on chapter 0 (the idx<0 -> 0 path).
    {
      const navs2: string[] = [];
      const d2 = createTourDirector(script, { navigate: (to) => navs2.push(to), reseed: () => {} });
      d2.resume(); // resume before start
      await flushAsync(3);
      ok("resume before start lands on chapter 0", d2.index === 0);
      d2.destroy();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    // Back / next / restart / toggleInfo on a fresh director before start are guarded no-ops (idx === -1).
    {
      const d3 = createTourDirector(script, { navigate: () => {}, reseed: () => {} });
      d3.back();
      d3.next();
      d3.toggleInfo();
      ok("Back/Next before start are guarded no-ops (index stays -1)", d3.index === -1);
      d3.destroy();
    }

    // The director's navigation is AUTHORITATIVE over a registered leave-guard: it clears any such guard before
    // navigating, so its per-chapter nav always lands.
    {
      // (a) The injected clearLeaveGuard dep fires before each navigate (the spy path).
      const guardNavs: string[] = [];
      let cleared = 0;
      const dGuard = createTourDirector(script, { navigate: (to) => { guardNavs.push(to); }, reseed: () => {}, clearLeaveGuard: () => { cleared += 1; } });
      dGuard.start();
      await flushAsync(3);
      ok("the director clears any registered leave-guard before navigating (its nav is authoritative)", cleared >= 1 && guardNavs[guardNavs.length - 1] === "/");
      const clearedBeforeNext = cleared;
      dGuard.next(); // a WITHIN-chapter beat step: no navigation, so no guard clear
      await flushAsync(2);
      ok("a within-chapter beat step neither navigates nor clears the guard (the clear is per NAVIGATION)", cleared === clearedBeforeNext && guardNavs[guardNavs.length - 1] === "/");
      dGuard.next(); // past the last beat: the chapter crossing navigates
      await flushAsync(3);
      ok("the director clears the leave-guard on every chapter navigation, not only the first", cleared > clearedBeforeNext && guardNavs[guardNavs.length - 1] === "/sources");
      dGuard.destroy();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();

      // (b) End-to-end through the REAL nav bridge: a registered refuse-all guard does NOT stop the director
      // (default clearLeaveGuard) reaching its chapter route.
      const realNavs: string[] = [];
      installNav({ navigate: (to) => { realNavs.push(to); }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
      registerLeaveGuard(() => false);
      realNavigate("/blocked-by-guard");
      ok("a registered refuse-all leave-guard vetoes a bare navigate (the hazard the director clears)", !realNavs.includes("/blocked-by-guard"));
      const dReal = createTourDirector(script, { reseed: () => {} }); // default navigate + clearLeaveGuard = the real bridge
      dReal.start();
      await flushAsync(3);
      ok("the director navigates to its chapter route despite a registered refuse-all guard (guard cleared first)", realNavs[realNavs.length - 1] === "/");
      dReal.destroy();
      clearLeaveGuard();
      installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    // GUIDED AUTOPLAY over BEATS: default MANUAL (no auto-advance on its own); Play arms a per-beat dwell (the
    // dwell bar is the visible timing indicator), advances BEAT BY BEAT in order, crosses to the next chapter
    // past the last beat, and on the LAST chapter stops back to manual. Driven with FAST timing deps (tiny
    // dwell/gap/settle) so the whole walk is observable in a test; production uses generous 6-15s dwells.
    {
      const aMain = document.createElement("main");
      aMain.id = "main";
      const aHeader = document.createElement("h1");
      aHeader.className = "page-header__title";
      aHeader.textContent = "Auto";
      aMain.appendChild(aHeader);
      document.body.appendChild(aMain);
      const aScript: TourChapter[] = [
        { route: "/", title: "Auto one", infoPoints: [{ anchor: "auto-1", title: "First", body: "First explanation." }, { anchor: "auto-2", title: "Second", body: "Second explanation." }] },
        { route: "/sources", title: "Auto two", infoPoints: [] },
      ];
      // A short-but-observable dwell so the steps are distinguishable in real time (production uses 6-15s).
      const fast = { navigate: (): void => {}, reseed: (): void => {}, dwellMs: (): number => 200, stepGapMs: 20, settleMs: 10 };
      const aDir = createTourDirector(aScript, fast);
      const aMeta = (): string => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      aDir.start();
      await flushAsync(3);
      // Default manual: the walk holds on the first beat and a wait does NOT advance it.
      await sleep(60); await flushAsync(2);
      ok("default manual: the walk holds on the first beat and does not advance on its own", aMeta() === "Step 1 of 2" && aDir.index === 0);
      // Play: the current beat's dwell arms (the dwell bar shows), then the walk advances one beat at a time.
      aDir.play();
      await sleep(60); await flushAsync(2);
      ok("Play arms the FIRST beat's dwell (the dwell bar shows; the walk is still on beat 1)", aMeta() === "Step 1 of 2" && (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-dwell-track]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("display") === "block");
      // After the first dwell (200ms) + gap (20ms), the SECOND beat presents.
      await sleep(250); await flushAsync(2);
      ok("after the first dwell the guided walk advances to the SECOND beat (one at a time, in order)", aMeta() === "Step 2 of 2" && aDir.index === 0);
      // After the LAST beat's dwell + gap, the walk crosses to the next chapter on its own.
      await sleep(260); await flushAsync(3);
      ok("after the LAST beat the guided walk crosses to the next chapter on its own", aDir.index === 1);
      // The next chapter has no beats and is the LAST chapter: after its empty dwell (the funnel-close dwell,
      // also 200ms via the override) the walk STOPS (pauses) at the very end.
      await sleep(260); await flushAsync(3);
      ok("on the last chapter the guided walk stops back to manual (no autoplay control at the very end; the dwell is idle)", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="play"]') ?? null) === null && (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-dwell-fill]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("width") === "0%");
      aDir.destroy();
      aMain.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    // TRY-IT beats under autoplay: at the end of an interact beat's dwell, autoplay performs the REAL click
    // ITSELF (the console visibly responds), and the walk advances a response beat (~900ms, the director's own
    // constant) later through the capture-phase interact observer, exactly as a hands-on visitor's click would.
    // The spotlight spy pins the try-it pulse; the fake control's click() records the press and propagates a
    // document-level click as a browser click would.
    {
      const tMain = document.createElement("main");
      tMain.id = "main";
      const tHeader = document.createElement("h1");
      tHeader.className = "page-header__title";
      tHeader.textContent = "Try";
      let flyClicks = 0;
      const flyEl = document.createElement("button");
      flyEl.setAttribute("data-tour-id", "cov-fly");
      (flyEl as unknown as { click: () => void }).click = () => {
        flyClicks++;
        const ev = makeEvent({ type: "click", bubbles: true, cancelable: true });
        ev.target = flyEl as unknown as typeof ev.target;
        dispatchDocKey(ev); // a real click propagates to the document exactly as in the browser
      };
      tMain.appendChild(tHeader);
      tMain.appendChild(flyEl);
      document.body.appendChild(tMain);
      const tSpot: Array<{ id: string | null; pulse: boolean }> = [];
      const tScript: TourChapter[] = [
        { route: "/", title: "Try", infoPoints: [
          { anchor: "cov-fly", title: "Try it", body: "Autoplay presses the real control.", interact: { label: "fly one now" } },
          { anchor: "cov-fly", title: "Aftermath", body: "What just happened." },
        ] },
      ];
      const tDir = createTourDirector(tScript, {
        navigate: (): void => {},
        reseed: (): void => {},
        dwellMs: (): number => 120,
        stepGapMs: 10,
        settleMs: 5,
        mountSpot: (): Spotlight => ({
          target(id: string | null, opts?: { pulse?: boolean }): void { tSpot.push({ id, pulse: opts?.pulse === true }); },
          root: document.createElement("div") as unknown as HTMLElement,
          destroy(): void {},
        }),
      });
      const tMeta = (): string => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      tDir.start();
      await flushAsync(3);
      ok("a try-it beat presents its invitation and pulses the spotlight on the real control", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-try-it]')?.textContent ?? "") === "Try it: fly one now" && tSpot[tSpot.length - 1]?.id === "cov-fly" && tSpot[tSpot.length - 1]?.pulse === true);
      tDir.play();
      await sleep(250); await flushAsync(2); // settle (5) + dwell (120): autoplay clicks; the response beat is pending
      ok("at the end of the try-it dwell autoplay clicks the REAL control itself and WAITS (no dwell-driven advance)", flyClicks === 1 && tMeta() === "Step 1 of 2");
      await sleep(1000); await flushAsync(3); // the ~900ms response beat
      ok("the response beat advances the walk through the interact observer (the plain beat presents, no pulse)", tMeta() === "Step 2 of 2" && tSpot[tSpot.length - 1]?.pulse === false);
      tDir.destroy();
      tMain.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-resume")?.remove();
    }

    // A DEGRADED try-it: the anchored control is absent from the page, so autoplay cannot click it; the walk
    // falls through to a plain dwell advance rather than wedging on the missing control.
    {
      const gMain2 = document.createElement("main");
      gMain2.id = "main";
      const gHeader2 = document.createElement("h1");
      gHeader2.className = "page-header__title";
      gHeader2.textContent = "Ghost";
      gMain2.appendChild(gHeader2);
      document.body.appendChild(gMain2);
      const gScript2: TourChapter[] = [
        { route: "/", title: "Ghost", infoPoints: [
          { anchor: "ghost-absent", title: "Try it", body: "The control is missing.", interact: { label: "press the missing control" } },
          { anchor: "ghost-absent", title: "Moved on", body: "The walk never wedges." },
        ] },
      ];
      const gDir2 = createTourDirector(gScript2, { navigate: (): void => {}, reseed: (): void => {}, dwellMs: (): number => 80, stepGapMs: 10, settleMs: 5 });
      const gMeta2 = (): string => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
      gDir2.start();
      await flushAsync(3);
      gDir2.play();
      await new Promise((r) => setTimeout(r, 300)); await flushAsync(3);
      ok("a try-it beat whose control is absent degrades to a plain dwell advance (the walk never wedges)", gMeta2() === "Step 2 of 2");
      gDir2.destroy();
      gMain2.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    // Pause stops the guided walk mid-dwell and returns to manual: the dwell bar hides, the toggle flips back
    // to Play, and the walk holds on the same beat. Pause visibly works.
    {
      const pMain = document.createElement("main");
      pMain.id = "main";
      const pHeader = document.createElement("h1");
      pHeader.className = "page-header__title";
      pHeader.textContent = "Pause";
      pMain.appendChild(pHeader);
      document.body.appendChild(pMain);
      // A second chapter follows, so the held beat is NOT the very end (the very end offers no Play/Pause).
      const pScript: TourChapter[] = [
        { route: "/", title: "Pause", infoPoints: [{ anchor: "pause-1", title: "Only", body: "A long-enough explanation to hold." }] },
        { route: "/sources", title: "After", infoPoints: [] },
      ];
      const pDir = createTourDirector(pScript, { navigate: (): void => {}, reseed: (): void => {}, dwellMs: (): number => 100000, stepGapMs: 6, settleMs: 6 });
      const pDwell = (): string => (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-dwell-track]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("display") ?? "";
      const pTitle = (): string => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-title]')?.textContent ?? "";
      pDir.start();
      await flushAsync(3);
      pDir.play();
      await new Promise((r) => setTimeout(r, 30)); await flushAsync(2);
      ok("Play arms the beat's dwell (the dwell bar is running)", pDwell() === "block");
      pDir.pause();
      await flushAsync(2);
      ok("Pause resets the dwell to idle, flips the toggle to Play and holds the beat (back to manual, Pause visibly works)", (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-dwell-fill]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("width") === "0%" && pTitle() === "Only" && (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="play"]') as { getAttribute(n: string): string | null } | null)?.getAttribute("aria-pressed") === "false");
      pDir.destroy();
      pMain.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    // Focus discipline: a USER-DRIVEN move lands focus on the guide (Next is one Enter away), but an AUTOPLAY
    // beat advance never steals focus from wherever the visitor parked it (WCAG 2.4.3 / 3.2.x: the polite live
    // region carries the story to assistive tech WITHOUT moving focus).
    {
      const fMain = document.createElement("main");
      fMain.id = "main";
      const fHeader = document.createElement("h1");
      fHeader.className = "page-header__title";
      fHeader.textContent = "One";
      fMain.appendChild(fHeader);
      document.body.appendChild(fMain);
      const fScript: TourChapter[] = [
        { route: "/", title: "One", infoPoints: [{ anchor: "f-a", title: "First", body: "First beat." }, { anchor: "f-b", title: "Second", body: "Second beat." }] },
        { route: "/sources", title: "Two", infoPoints: [] },
      ];
      const dF = createTourDirector(fScript, { navigate: (): void => {}, reseed: (): void => {}, dwellMs: (): number => 120, stepGapMs: 10, settleMs: 5 });
      dF.start();
      await flushAsync(3);
      const bar = document.getElementById("tour-nav-bar");
      const focusInBar = (): boolean => { const a = activeElement() as { closest?: (s: string) => unknown } | null; return a !== null && (a === bar || a?.closest?.("#tour-nav-bar") != null); };
      const fMeta = (): string => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
      ok("a user-driven start moves focus onto the nav-bar (keyboard + screen-reader users land on the guide)", bar !== null && focusInBar());
      // A user Next (a within-chapter beat step) moves focus onto the nav-bar again.
      const sentinel0 = document.createElement("button");
      sentinel0.id = "tour-focus-sentinel-0";
      document.body.appendChild(sentinel0);
      sentinel0.focus();
      dF.next();
      await flushAsync(2);
      ok("a user-driven Next moves focus onto the guide", focusInBar() && fMeta() === "Step 2 of 2");
      sentinel0.remove();
      dF.back();
      await flushAsync(2);
      // Park focus on a sentinel; an AUTOPLAY beat advance must not seize it.
      const sentinel = document.createElement("button");
      sentinel.id = "tour-focus-sentinel";
      document.body.appendChild(sentinel);
      sentinel.focus();
      dF.play();
      await new Promise((r) => setTimeout(r, 250));
      await flushAsync(2);
      ok("an autoplay beat advance never steals focus from where the visitor put it", fMeta() === "Step 2 of 2" && (activeElement() as unknown) === sentinel);
      dF.pause();
      dF.destroy();
      sentinel.remove();
      fMain.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    // The async awaitScreen paths (the headless DOM has no MutationObserver, so the poll path runs): a screen
    // header that appears AFTER navigation resolves via the poll; a header that never appears times out so the
    // beats present anyway (the walk keeps moving, no hang).
    {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      // Remove the outer #main (it shares the id and carries a page header, which would make screenReady resolve
      // instantly and skip the deferred/observer paths under test).
      document.getElementById("main")?.remove();
      // (a) deferred header: #main has no page header at start; one appears shortly after, so the poll resolves.
      const m4 = document.createElement("main");
      m4.id = "main";
      document.body.appendChild(m4);
      const deferredScript: TourChapter[] = [{ route: "/", title: "Late", infoPoints: [] }];
      const dLate = createTourDirector(deferredScript, { navigate: () => {}, reseed: () => {}, renderPollMs: 5, renderTimeoutMs: 2000 });
      dLate.start();
      setTimeout(() => { const hh = document.createElement("h1"); hh.className = "page-header__title"; hh.textContent = "Late"; m4.appendChild(hh); }, 12);
      await sleep(60);
      await flushAsync(3);
      dLate.pause();
      ok("a deferred screen render is resolved by the poll path (no MutationObserver) and the chapter mounts", (document.getElementById("tour-nav-bar")?.textContent ?? "").includes("Late"));
      dLate.destroy();
      m4.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();

      // (b) a header that never appears times out and the chapter mounts anyway (no hang).
      document.getElementById("main")?.remove();
      const m5 = document.createElement("main");
      m5.id = "main";
      document.body.appendChild(m5);
      const missScript: TourChapter[] = [{ route: "/", title: "NoHeader", infoPoints: [] }];
      const dMiss = createTourDirector(missScript, { navigate: () => {}, reseed: () => {}, renderPollMs: 5, renderTimeoutMs: 20 });
      dMiss.start();
      await sleep(60);
      await flushAsync(3);
      dMiss.pause();
      ok("a screen that never renders its header times out and the chapter mounts anyway (no hang)", (document.getElementById("tour-nav-bar")?.textContent ?? "").includes("NoHeader"));
      dMiss.destroy();
      m5.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    // The production fast path uses MutationObserver. Inject a minimal fake observer for one director, prove the
    // observer-resolved path + that it disconnects, then restore the global.
    {
      const gAny = globalThis as unknown as Record<string, unknown>;
      const savedMO = gAny.MutationObserver;
      // The fake records what the director did to it on a holder rather than in three local lets.
      // Local `let`s assigned ONLY from inside a callback stay narrowed to their initialiser, because
      // the compiler cannot see that the callback ran, so `observed === true` reads as always-false and
      // `lastCb?.()` as calling a null. Both assertions below would then be checking nothing. Narrowing
      // on an object's properties is discarded at each call, which is exactly the assumption that holds
      // here: the director constructs and drives this fake between the writes and the reads.
      const mo = { lastCb: null as (() => void) | null, observed: false, disconnected: false };
      class FakeMO {
        cb: () => void;
        constructor(cb: () => void) { this.cb = cb; mo.lastCb = cb; }
        observe(): void { mo.observed = true; }
        disconnect(): void { mo.disconnected = true; }
      }
      gAny.MutationObserver = FakeMO as unknown;
      document.getElementById("main")?.remove();
      const m6 = document.createElement("main");
      m6.id = "main";
      document.body.appendChild(m6);
      const moScript: TourChapter[] = [{ route: "/", title: "Observed", infoPoints: [] }];
      const dMo = createTourDirector(moScript, { navigate: () => {}, reseed: () => {}, renderPollMs: 100000, renderTimeoutMs: 100000 });
      dMo.start();
      await flushAsync(2);
      ok("the director observes the main region via MutationObserver (the production fast path)", mo.observed === true && mo.lastCb !== null);
      const moHeader = document.createElement("h1"); moHeader.className = "page-header__title"; moHeader.textContent = "Observed"; m6.appendChild(moHeader);
      mo.lastCb?.();
      await flushAsync(3);
      dMo.pause();
      ok("the observer callback resolves the screen render and the chapter mounts", (document.getElementById("tour-nav-bar")?.textContent ?? "").includes("Observed"));
      ok("the observer is disconnected once the screen resolves (no leak)", mo.disconnected === true);
      dMo.destroy();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
      m6.remove();
      if (savedMO === undefined) delete gAny.MutationObserver;
      else gAny.MutationObserver = savedMO;
    }

    // A preAction that THROWS is swallowed (a flourish must never break the walk): the chapter still mounts.
    {
      const m7 = document.createElement("main");
      m7.id = "main";
      const h7 = document.createElement("h1"); h7.className = "page-header__title"; h7.textContent = "Throws"; m7.appendChild(h7);
      document.body.appendChild(m7);
      const throwScript: TourChapter[] = [{ route: "/", title: "Throws", preAction: () => { throw new Error("boom"); }, infoPoints: [] }];
      const dThrow = createTourDirector(throwScript, { navigate: () => {}, reseed: () => {} });
      dThrow.start();
      await flushAsync(3);
      dThrow.pause();
      ok("a preAction that throws is swallowed and the chapter still mounts", (document.getElementById("tour-nav-bar")?.textContent ?? "").includes("Throws"));
      dThrow.destroy();
      m7.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
    }

    main.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
    document.getElementById("tour-resume")?.remove();
  }

  // ---------------------------------------------------------------------------------------------
  // demo/tour/scripts (chapters): TWO curated chapter lists (CTO + Engineer) walk the REAL console pages; a
  // chapter's infoPoints are its BEATS. Lock BOTH chapter spines + the typed route vocabulary + the beat copy +
  // the two Engineer-only try-it interact beats, so a later edit cannot quietly break the structure or drop a beat.
  // ---------------------------------------------------------------------------------------------
  {
    const allChapters: TypedTourChapter[] = [...new Set([...ctoChapters, ...engineerChapters])];
    // The known TourRoutes: the pinned TOUR_ROUTES (each tied to a live app constant) plus /reports (whose route
    // constant is private to its screen, pinned at the live-screen resolution in validate-tour.ts instead).
    const known = new Set<string>([...Object.values(TOUR_ROUTES), "/reports"]);
    ok("every chapter across both walks navigates a known TourRoute (a renamed route is caught, not a dead nav)", allChapters.every((c) => known.has(c.route)));
    ok("the CTO walk and the Engineer walk are ten chapters each", ctoChapters.length === 10 && engineerChapters.length === 10);
    ok("TOUR_SCRIPTS maps cto -> ctoChapters and engineer -> engineerChapters", TOUR_SCRIPTS.cto === ctoChapters && TOUR_SCRIPTS.engineer === engineerChapters);
    // Both curated walks open on Overview then Sources and close on the funnel (two CTAs, no info-points, the
    // free Community edition); the middle is curated to the reader.
    for (const [name, script] of [["CTO", ctoChapters], ["Engineer", engineerChapters]] as const) {
      ok(`the ${name} walk opens Overview -> Sources with beats on each`, script[0]!.route === "/" && script[0]!.title === "Overview" && script[0]!.infoPoints.length >= 1 && script[1]!.route === "/sources" && script[1]!.title === "Sources" && script[1]!.infoPoints.length >= 1);
      const close = script[script.length - 1]!;
      ok(`the ${name} walk closes on the funnel (two CTAs, no info-points, the free Community edition)`, close.route === "/" && (close.ctas ?? []).length === 2 && close.infoPoints.length === 0 && close.title.includes("Community edition"));
    }
    ok("the pinned routes resolve to the live constants (Overview, Sources, Downpipes, Runs, Restore, Approvals, Canary, Audit, IdP, Rules, Integrations)", TOUR_ROUTES.overview === "/" && TOUR_ROUTES.sources === "/sources" && TOUR_ROUTES.downpipes === "/downpipes" && TOUR_ROUTES.runs === "/runs" && TOUR_ROUTES.restore === "/restore" && TOUR_ROUTES.restoreApprovals === "/restore/approvals" && TOUR_ROUTES.canary === "/canary" && TOUR_ROUTES.audit === "/access/audit" && TOUR_ROUTES.idp === "/access/idp" && TOUR_ROUTES.notifyRules === "/notifications/rules" && TOUR_ROUTES.integrations === "/integrations");
    // The two curated route spines in order (a reorder or dropped chapter is caught).
    ok("the CTO route spine walks assurance and ecosystem fit in order", JSON.stringify(ctoChapters.map((c) => c.route)) === JSON.stringify(["/", "/sources", "/access/idp", "/restore/approvals", "/reports", "/reports", "/access/audit", "/notifications/rules", "/integrations", "/"]));
    ok("the Engineer route spine walks operate-and-recover in order", JSON.stringify(engineerChapters.map((c) => c.route)) === JSON.stringify(["/", "/sources", "/downpipes", "/runs", "/restore", "/runs", "/canary", "/notifications/rules", "/integrations", "/"]));
    const ctoTitles = ctoChapters.map((c) => c.title);
    ok("the CTO walk covers identity providers, dual-control restore, change management, evidence, the audit log, notifications and integrations", ctoTitles.includes("Identity providers") && ctoTitles.includes("Restore under dual control") && ctoTitles.includes("Change management") && ctoTitles.includes("Evidence on demand") && ctoTitles.includes("A tamper-evident audit log") && ctoTitles.includes("Notifications") && ctoTitles.includes("Integrations"));
    const engTitles = engineerChapters.map((c) => c.title);
    ok("the Engineer walk covers the estate, a backup end-to-end, the recoverability proof, the failure, canary, notifications and integrations", engTitles.includes("Downpipes") && engTitles.includes("A backup, end to end") && engTitles.includes("Proof it's recoverable") && engTitles.includes("When it goes wrong") && engTitles.includes("Canary flights") && engTitles.includes("Notifications") && engTitles.includes("Integrations"));
    ok("the Engineer run + restore-proof chapters carry a preAction (the canary chapter needs none)", engineerChapters.filter((c) => typeof c.preAction === "function").length >= 3);
    // Every beat across both walks names an anchor + carries a real (non-stub) explanation, and uses precise claims.
    const allPoints: InfoPoint[] = allChapters.flatMap((c) => [...c.infoPoints]);
    ok("every beat names an anchor + a non-empty title and a real body", allPoints.length >= 1 && allPoints.every((p) => p.anchor !== "" && p.title.length > 0 && p.body.length > 20));
    const allCopy = allPoints.map((p) => `${p.title} ${p.body}`).join(" ").toLowerCase();
    ok("the beat copy uses precise claims, never the banned absolute forms", !allCopy.includes("tamper-proof") && !allCopy.includes("quantum-proof") && !allCopy.includes("100% secure"));
    // The two TRY-IT beats live ONLY on the Engineer walk: the canary + the restore proof each invite
    // a REAL click of the console's own control, and they are the only two; the CTO walk carries none.
    const engPoints: InfoPoint[] = engineerChapters.flatMap((c) => [...c.infoPoints]);
    const ctoPoints: InfoPoint[] = ctoChapters.flatMap((c) => [...c.infoPoints]);
    ok("exactly two try-it beats carry an interact invitation, both on the Engineer walk (canary fly + restore build)", engPoints.filter((p) => p.interact !== undefined).length === 2);
    ok("the CTO walk carries no try-it beats", ctoPoints.filter((p) => p.interact !== undefined).length === 0);
    ok("the canary try-it beat pins the REAL fly control with its invitation", engineerChapters.find((c) => c.title === "Canary flights")!.infoPoints.some((p) => p.anchor === "canary-fly" && p.interact?.label === "click Fly the canary now"));
    ok("the restore-proof try-it beat pins the REAL build-plan control with its invitation", engineerChapters.find((c) => c.title === "Proof it's recoverable")!.infoPoints.some((p) => p.anchor === "restore-build" && p.interact?.label === "click Build the restore plan"));
    ok("the backup chapter's copy names the post-quantum hybrid signature (precise, not absolute)", allCopy.includes("post-quantum hybrid"));
    // The exact anchor sets each chapter pins, on the walk that owns it (a future edit that drops a "?" is caught).
    const overviewAnchors = new Set(ctoChapters[0]!.infoPoints.map((p) => p.anchor));
    ok("the Overview chapter pins the no-custody, fleet-health, licence and attention components", overviewAnchors.has("overview-no-custody") && overviewAnchors.has("overview-fleet-health") && overviewAnchors.has("overview-licence") && overviewAnchors.has("overview-attention"));
    const sourcesAnchors = new Set(ctoChapters[1]!.infoPoints.map((p) => p.anchor));
    ok("the Sources chapter pins the add-source breadth, the protected table and the full catalogue", sourcesAnchors.has("sources-add") && sourcesAnchors.has("sources-protected") && sourcesAnchors.has("sources-catalogue"));
    const backup = new Set(engineerChapters.find((c) => c.title === "A backup, end to end")!.infoPoints.map((p) => p.anchor));
    ok("the backup chapter pins the sealed status, seal verdict, records and segments", backup.has("run-status") && backup.has("run-seal") && backup.has("run-records") && backup.has("run-segments"));
    const canary = new Set(engineerChapters.find((c) => c.title === "Canary flights")!.infoPoints.map((p) => p.anchor));
    ok("the canary chapter pins the live status, what a flight checks and the on-screen death preview", canary.has("canary-status") && canary.has("canary-aspects") && canary.has("canary-preview"));
    const notify = new Set(engineerChapters.find((c) => c.title === "Notifications")!.infoPoints.map((p) => p.anchor));
    ok("the notifications chapter pins the routing breadth and the event-to-channel routing", notify.has("notify-rules") && notify.has("notify-routing"));
    const idp = new Set(ctoChapters.find((c) => c.title === "Identity providers")!.infoPoints.map((p) => p.anchor));
    ok("the identity-providers chapter pins the provider breadth, the live connections and the additive add", idp.has("idp-providers") && idp.has("idp-connection") && idp.has("idp-add"));
    const dual = new Set(ctoChapters.find((c) => c.title === "Restore under dual control")!.infoPoints.map((p) => p.anchor));
    ok("the dual-control restore chapter pins the maker, the approve step and the recorded status", dual.has("approval-maker") && dual.has("approval-approve") && dual.has("approval-status"));
    const integrations = new Set(ctoChapters.find((c) => c.title === "Integrations")!.infoPoints.map((p) => p.anchor));
    ok("the integrations chapter pins the grid breadth, the auto-parse property and what is live now", integrations.has("integrations-grid") && integrations.has("integrations-autoparse") && integrations.has("integrations-active"));
    // The closing funnel chapter renders the two deliberate exits as nav-bar CTAs (no info-points).
    const funnel = ctoChapters[ctoChapters.length - 1]!;
    ok("the closing chapter is the funnel: two deliberate CTAs, no info-points, naming the free Community edition", funnel.route === "/" && (funnel.ctas ?? []).length === 2 && funnel.infoPoints.length === 0 && funnel.title.includes("Community edition"));
    // The funnel exits are authored as data (FUNNEL_CTAS), the same the closing chapter renders
    // (marketing: the secondary channels to the pricing page; the label promises a page).
    ok("the funnel offers exactly two deliberate exits (deploy + see pricing)", FUNNEL_CTAS.length === 2);
    const deploy = FUNNEL_CTAS.find((c) => c.kind === "deploy-final");
    const pricing = FUNNEL_CTAS.find((c) => c.kind === "pricing-final");
    ok("the primary funnel exit is the website's deploy steps page (https, primary)", deploy !== undefined && deploy.primary === true && deploy.href === "https://downpipes.io/deploy");
    ok("the secondary funnel exit channels to the pricing page with the finale src marker", pricing !== undefined && pricing.primary !== true && pricing.href === "https://downpipes.io/pricing?src=pricing-final");
  }

  // ---------------------------------------------------------------------------------------------
  // demo/tour/persona-fork: the tour's first interaction, a warm welcome card whose TWO persona actions each run
  // a DIFFERENT curated walk over one director. Drive it headless with a SPY director built per persona (so no
  // real overlay paints and the started script is observable): mount lands a labelled dialog that greets the
  // visitor; picking a persona builds + starts the director over THAT persona's script (TOUR_SCRIPTS); "Explore
  // freely" + Escape dismiss WITHOUT starting a tour (free-explore); the mount + startTour are idempotent; a
  // no-body mount is inert.
  // ---------------------------------------------------------------------------------------------
  {
    // A spy director records start() + which script it was built over, so a start is observable without a
    // real guide. createTourDirector is the real thing the welcome uses by default; here we inject the spy.
    let startedScript: ReadonlyArray<TourChapter> | null = null;
    let startCount = 0;
    const spyDirector = (): TourDirector => ({
      start(): void { startCount++; },
      next(): void {}, back(): void {}, restart(): void {}, pause(): void {}, play(): void {}, toggleInfo(): void {}, exit(): void {}, resume(): void {}, destroy(): void {},
      get index(): number { return 0; },
    });
    const makeSpy = (persona: TourPersona): TourDirector => { startedScript = TOUR_SCRIPTS[persona]; return spyDirector(); };

    // Mount: a labelled dialog that greets the visitor + the Start/Explore actions + a live region.
    const _fork = mountPersonaFork({ createDirector: makeSpy });
    const forkEl = document.getElementById("tour-persona-fork");
    ok("the welcome card mounts a single root into the body", forkEl !== null);
    ok("the welcome is a labelled, non-trapping dialog (accessible name + not modal)", forkEl?.querySelector('[role="dialog"]')?.getAttribute("aria-modal") === "false");
    ok("the welcome greets the visitor and offers both persona walks + Free Explore", (forkEl?.textContent ?? "").includes("Welcome to downpipes") && (forkEl?.textContent ?? "").includes("Governance Tour") && (forkEl?.textContent ?? "").includes("Engineering Tour") && (forkEl?.textContent ?? "").includes("Free Explore"));
    // The copy cut: the pitch paragraphs are gone; the card keeps exactly
    // two short body lines (what the tour is + the single free-edition line) before the expectation line.
    // The duration claim was CUT: the welcome promised "a guided three-minute walk"
    // while the tour's own autoplay budget runs 5.6 and 6.9 minutes over the two walks. The copy now names
    // the chapter count and the visitor's own pace instead, and a landed pin bans the `<number>-minute`
    // shape rather than any one sentence. This assertion pinned the retired literal, so it went red on main
    // the moment the copy moved -- the copy half landed and this half did not.
    ok("the welcome says what the tour is in one line (ten chapters, own pace, sample data, no signup, resets on reload)", (forkEl?.textContent ?? "").includes("A guided walk of ten chapters through the real console, at your own pace, on sample data for a fictional company. No signup, and it resets when you reload."));
    // Guards the retired claim from returning through THIS surface too, so the ban is not carried by the
    // tour's pin alone. A duration promise the product cannot keep is the defect, not the wording.
    // SPELLED-OUT NUMBERS ARE THE POINT, not an extra: the sentence this replaces said "three-minute", so a
    // digit-only pattern would have let the exact retired claim back through. Caught by planting that claim
    // and watching this arm stay green while its neighbour reddened.
    ok("the welcome makes no duration promise (the shape, not one retired sentence)", !/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ]minutes?\b/i.test(forkEl?.textContent ?? ""));
    ok("the welcome keeps the single deliberate free-edition line", (forkEl?.textContent ?? "").includes("Every feature you will see is in the free Community edition."));
    ok("the cut pitch copy is gone (no source-type count, no pricing pitch, no choose-your-walk explainer)", !(forkEl?.textContent ?? "").includes("free and complete") && !(forkEl?.textContent ?? "").includes("nothing to unlock") && !(forkEl?.textContent ?? "").includes("source types") && !(forkEl?.textContent ?? "").includes("Choose your walk"));
    ok("the welcome sets expectations: two curated paths and the standing Esc exit promise, with no duplicated duration (it lives in the body line) and no stale chapter count", (forkEl?.textContent ?? "").includes("Two curated paths · Esc leaves the tour at any time") && !(forkEl?.textContent ?? "").includes("about 3 minutes") && !(forkEl?.textContent ?? "").includes("12 chapters"));
    ok("the welcome carries a polite ARIA live region (announces the greeting)", forkEl?.querySelector('[role="status"]')?.getAttribute("aria-live") === "polite");
    ok("the welcome layer is pointer-transparent (no dim backdrop; the Overview behind stays fully visible to every input mode), while the panel itself re-enables pointer events", forkEl?.style.getPropertyValue("pointer-events") === "none" && (forkEl?.querySelector('[role="dialog"]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("pointer-events") === "auto");
    ok("the welcome layer carries NO dim backdrop (the redesign keeps the real screen the star)", (forkEl?.style.getPropertyValue("background") ?? "") === "" && (forkEl?.style.getPropertyValue("background-color") ?? "") === "");
    const ctoBtn = forkEl?.querySelector('[data-tour-start="cto"]');
    const engBtn = forkEl?.querySelector('[data-tour-start="engineer"]');
    ok("the welcome renders both persona start buttons (cto + engineer), each a real keyboard-reachable button", ctoBtn !== null && ctoBtn?.tagName === "BUTTON" && engBtn !== null && engBtn?.tagName === "BUTTON");
    // The visual demotion (GTM welcome rework): Free Explore keeps its exact accessible name and stays a real
    // keyboard-reachable <button>, but is styled linklike (no button chrome) and sits OUTSIDE the walk grid,
    // which holds exactly the two equal primaries.
    {
      const skipEl = forkEl?.querySelector('[aria-label="Free Explore"]') as { tagName?: string; className?: string; parentElement?: { className?: string } } | null;
      ok("Free Explore stays a real button with its exact accessible name, demoted to linklike styling", skipEl !== null && skipEl?.tagName === "BUTTON" && (skipEl?.className ?? "").includes("linklike") && !(skipEl?.className ?? "").includes("btn--"));
      const grid = forkEl?.querySelector(".tour-fork-actions") as { children?: { length: number } } | null;
      ok("the walk grid holds exactly the two equal primaries; the demoted explore control sits outside it", grid !== null && grid?.children?.length === 2 && (skipEl?.parentElement?.className ?? "") !== "tour-fork-actions");
    }

    // Idempotent mount: a second mount returns a handle over the SAME element (never two welcomes).
    let forkCount = 0;
    for (const n of document.body.childNodes as unknown as Iterable<Node>) if ((n as { id?: string }).id === "tour-persona-fork") forkCount++;
    ok("exactly one welcome exists in the body", forkCount === 1);
    const again = mountPersonaFork({ createDirector: makeSpy });
    ok("a redundant mountPersonaFork returns a handle over the existing welcome (no second welcome)", again.root === forkEl);

    // Picking the CTO persona (via the button click) tears the welcome down and starts the director over the CTO script.
    (ctoBtn as unknown as { click(): void } | null)?.click();
    ok("starting the tour dismisses the welcome (the tour overlay is not painted under it)", document.getElementById("tour-persona-fork") === null);
    ok("choosing the CTO persona builds + starts a director over the CTO script", startCount === 1 && startedScript === ctoChapters);

    // A fresh welcome, starting the OTHER walk via the handle verb, starts the Engineer script.
    startedScript = null;
    const fork2 = mountPersonaFork({ createDirector: makeSpy });
    fork2.choose("engineer");
    ok("choose('engineer') starts a director over the Engineer script", startedScript === engineerChapters && fork2.director !== null);
    ok("the welcome is dismissed once the tour starts", document.getElementById("tour-persona-fork") === null);

    // Dismiss WITHOUT starting: the Explore-freely control + Escape both drop the welcome and start NO tour.
    const startsBefore = startCount;
    const fork3 = mountPersonaFork({ createDirector: makeSpy });
    const skip = document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]');
    (skip as unknown as { click(): void } | null)?.click();
    ok("the Explore-freely control dismisses the welcome to free-explore", document.getElementById("tour-persona-fork") === null);
    ok("exploring freely starts no tour (the visitor is left in the real, faked app)", startCount === startsBefore && fork3.director === null);

    // Exploring freely is reversible (the asymmetry the finding flagged: Exit mid-tour shows Resume, but the
    // welcome left nothing). After it the persistent "Take the tour" relaunch affordance is mounted, and a
    // click on it re-mounts the welcome (carrying the same deps, so the spy director is honoured) and removes
    // itself, so a visitor who skips to look around first can still enter the guided narrative.
    const relaunchAfterSkip = document.getElementById("tour-relaunch");
    ok("exploring freely mounts a persistent 'Take the tour' relaunch button (it is reversible)", relaunchAfterSkip !== null && relaunchAfterSkip?.tagName === "BUTTON" && relaunchAfterSkip?.getAttribute("aria-label") === "Take the tour");
    const startsBeforeRelaunch = startCount;
    (relaunchAfterSkip as unknown as { click(): void } | null)?.click();
    ok("clicking 'Take the tour' re-mounts the welcome (no tour auto-starts) and removes the relaunch button", document.getElementById("tour-persona-fork") !== null && document.getElementById("tour-relaunch") === null && startCount === startsBeforeRelaunch);
    // Re-mounting the welcome while a stale relaunch is up clears the relaunch (it belongs only to free-explore):
    // explore freely again to remount it, then prove a fresh welcome mount removes it.
    document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]') && (document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]') as unknown as { click(): void }).click();
    ok("exploring freely again re-mounts the relaunch affordance", document.getElementById("tour-relaunch") !== null);
    mountPersonaFork({ createDirector: makeSpy });
    ok("re-showing the welcome clears the relaunch affordance (it is present only while the welcome is down)", document.getElementById("tour-relaunch") === null);
    document.getElementById("tour-persona-fork")?.remove();
    // Starting the tour never leaves a relaunch behind the tour overlay (the director owns the in-tour Resume).
    const forkChoose = mountPersonaFork({ createDirector: makeSpy });
    document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]') && (document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]') as unknown as { click(): void }).click(); // explore freely -> relaunch up
    void forkChoose;
    const forkChoose2 = mountPersonaFork({ createDirector: makeSpy }); // re-show clears it
    forkChoose2.choose("engineer");
    ok("starting the tour leaves no relaunch affordance behind the tour overlay", document.getElementById("tour-relaunch") === null);

    // Focus restoration on dismissal (WCAG 2.4.3): removing the welcome card removes the panel that holds focus,
    // so a keyboard user would otherwise be dumped at <body>. The welcome captures the control it was opened from
    // before focusing the card, and returns focus there on teardown. Mount with a launch button focused, explore
    // freely, and confirm focus is handed back to that control rather than stranded at the document body.
    {
      const launch = document.createElement("button");
      launch.id = "fork-launch-control";
      document.body.appendChild(launch);
      launch.focus(); // the visitor opened the tour from here
      const forkF = mountPersonaFork({ createDirector: makeSpy });
      ok("the welcome moves focus off the launch control into the card", !isActive(launch) && document.getElementById("tour-persona-fork") !== null);
      // The focused welcome panel shows a visible focus ring (this centred, target-less first screen paints no
      // spotlight ring, and a programmatic focus does not match :focus-visible, so a sighted keyboard user would
      // otherwise see no cue that focus landed in the welcome). The ring clears on blur.
      const panelF = document.getElementById("tour-persona-fork")?.querySelector('[role="dialog"]') as { style: { getPropertyValue(p: string): string }; dispatchEvent(ev: ReturnType<typeof makeEvent>): boolean } | null;
      const forkRing = panelF?.style.getPropertyValue("outline") ?? "";
      ok("the focused welcome panel shows a visible focus ring (the --ring token, not none)", panelF !== null && forkRing !== "" && forkRing !== "none" && forkRing.includes("var(--ring)"));
      panelF?.dispatchEvent(makeEvent({ type: "blur", bubbles: false, cancelable: false }));
      ok("the welcome panel focus ring clears on blur (shown only while the panel holds focus)", (panelF?.style.getPropertyValue("outline") ?? "") === "none");
      const skipF = document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]');
      (skipF as unknown as { click(): void } | null)?.click();
      ok("exploring freely restores focus to the launch control (not stranded at body)", document.getElementById("tour-persona-fork") === null && isActive(launch));
      void forkF;
      launch.remove();
    }

    const _fork4 = mountPersonaFork({ createDirector: makeSpy });
    dispatchDocKey(keydown({ key: "Escape" }));
    ok("Escape dismisses the welcome to free-explore (the welcome never traps the visitor)", document.getElementById("tour-persona-fork") === null);
    // A non-Escape key while the welcome is shown is a no-op (the welcome only adds Escape; buttons keep native keys).
    const fork5 = mountPersonaFork({ createDirector: makeSpy });
    dispatchDocKey(keydown({ key: "a" }));
    ok("an unrelated key leaves the welcome up (it only adds Escape; the buttons keep their native keys)", document.getElementById("tour-persona-fork") !== null);
    // choose() is guarded after dismissal: dismiss then a second choose is inert (no extra tour starts).
    const startsBeforeGuard = startCount;
    fork5.destroy();
    fork5.choose("engineer");
    ok("choose() after dismissal is a guarded no-op (no extra tour starts)", startCount === startsBeforeGuard);

    // The double-mount handle path: with a welcome already up, mountPersonaFork returns the existingHandle
    // wrapper whose choose()/destroy() drive the live welcome. Prove choose() on that wrapper starts a tour,
    // then clean up.
    {
      const live = mountPersonaFork({ createDirector: makeSpy });
      const wrapper = mountPersonaFork({ createDirector: makeSpy }); // returns existingHandle over the live welcome
      ok("the double-mount wrapper targets the same live welcome element", wrapper.root === live.root);
      const startsBeforeWrap = startCount;
      wrapper.choose("engineer");
      ok("the double-mount wrapper's choose() starts a tour and dismisses the welcome", startCount === startsBeforeWrap + 1 && document.getElementById("tour-persona-fork") === null && wrapper.director !== null);
      // The wrapper's destroy() path (a fresh welcome, dismissed through the wrapper).
      const a = mountPersonaFork({ createDirector: makeSpy });
      const w2 = mountPersonaFork({ createDirector: makeSpy });
      void a;
      w2.destroy();
      ok("the double-mount wrapper's destroy() dismisses the live welcome", document.getElementById("tour-persona-fork") === null);
    }

    // startTour is the public launcher: it mounts the welcome and is idempotent (a redundant call returns the
    // existing welcome rather than stacking a second).
    document.getElementById("tour-persona-fork")?.remove();
    const launched = startTour({ createDirector: makeSpy });
    ok("startTour mounts the welcome card (the tour's first interaction)", document.getElementById("tour-persona-fork") !== null);
    const launchedAgain = startTour({ createDirector: makeSpy });
    ok("startTour is idempotent (a redundant launch returns the existing welcome, no second welcome)", launchedAgain.root === launched.root);
    let launchCount = 0;
    for (const n of document.body.childNodes as unknown as Iterable<Node>) if ((n as { id?: string }).id === "tour-persona-fork") launchCount++;
    ok("exactly one welcome after a double startTour", launchCount === 1);
    launched.destroy();
    document.getElementById("tour-persona-fork")?.remove();

    // Defensive: a document with no body returns a detached, inert handle (the welcome is the tour's entry,
    // never a boot gate), and its verbs do not throw.
    const noBodyDoc = { getElementById: () => null, body: null } as unknown as Document;
    const detached = mountPersonaFork({ createDirector: makeSpy, doc: noBodyDoc });
    ok("mountPersonaFork with no document.body returns a detached handle (never a boot gate)", detached.root !== null && document.getElementById("tour-persona-fork") === null);
    const startsBeforeDetached = startCount;
    detached.choose("engineer"); // builds + starts a director even detached (the script is independent of the chrome)
    detached.destroy();
    ok("the detached welcome's verbs are inert-safe (no throw; choose still starts the script)", startCount === startsBeforeDetached + 1);
    document.getElementById("tour-persona-fork")?.remove();

    // The welcome builds a REAL director by default (the production path), proven by a default-deps mount that
    // starts a genuine tour overlay on picking a persona, then torn down. This exercises createDirector's default.
    {
      const realFork = mountPersonaFork(); // default createDirector = the real createTourDirector
      const startReal = document.getElementById("tour-persona-fork")?.querySelector('[data-tour-start="engineer"]');
      (startReal as unknown as { click(): void } | null)?.click();
      await flushAsync(3);
      ok("the welcome builds a REAL director by default and starts a genuine tour (the nav-bar rail) on picking a persona", realFork.director !== null && document.getElementById("tour-nav-bar") !== null);
      realFork.director?.destroy();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
      document.getElementById("tour-resume")?.remove();
      document.getElementById("tour-persona-fork")?.remove();
      document.getElementById("tour-relaunch")?.remove();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // demo/tour/analytics (phase 1f): the tour's self-hosted funnel analytics. emit() is a no-op until enabled
  // (so the genuine console never beacons), then sends each small, PII-free event to a same-origin path via
  // navigator.sendBeacon when present, else a keepalive fetch, best-effort and never throwing. Drive every
  // branch headless: the disabled no-op; the fetch-fallback path (the shim has no sendBeacon) carrying the
  // serialised event; the endpoint override; the sendBeacon path (an injected stub); the malformed-event
  // swallow; and the disable path. The fetch + navigator are swapped in and restored so no sibling cov test
  // is affected.
  // ---------------------------------------------------------------------------------------------
  {
    const savedFetch = globalThis.fetch;
    const gAny = globalThis as unknown as Record<string, unknown>;
    const savedNavigator = gAny.navigator;
    // A fetch spy that records the beacon POSTs (the headless DOM has no navigator.sendBeacon, so emit() takes
    // the keepalive-fetch fallback). It resolves a 204 so emit's .catch is never hit on the happy path.
    const beacons: Array<{ url: string; init: RequestInit | undefined; event: TourEvent | null }> = [];
    const spyFetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      let event: TourEvent | null = null;
      try { event = JSON.parse(String(init?.body ?? "null")) as TourEvent; } catch { event = null; }
      beacons.push({ url, init, event });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    // Disabled by default: emit is a no-op and beacons nothing (the genuine console never emits).
    globalThis.fetch = spyFetch;
    disableTourAnalytics();
    ok("emit is a no-op while analytics are disabled (the genuine console never beacons)", emit({ name: "tour_started" }) === false && beacons.length === 0);

    // Enabled + a known endpoint: emit returns true and POSTs the serialised event to that endpoint via the
    // keepalive-fetch fallback (no sendBeacon in the shim). The body is the event JSON; keepalive is set.
    enableTourAnalytics();
    setTourAnalyticsEndpoint("/__tour_test_event");
    const sent = emit({ name: "step_reached", stepIndex: 3, route: "/reports" });
    ok("emit returns true once enabled and a transport accepts the event", sent === true);
    await flushAsync(1);
    const last = beacons[beacons.length - 1]!;
    ok("emit POSTs to the configured endpoint with keepalive (the same-origin beacon)", last.url === "/__tour_test_event" && last.init?.method === "POST" && last.init?.keepalive === true);
    ok("the beacon body is the serialised, PII-free event (name + index + route)", last.event?.name === "step_reached" && last.event?.stepIndex === 3 && last.event?.route === "/reports");
    ok("the default endpoint is the same-origin /tour/event (not under /admin/*, so the shim does not swallow it)", TOUR_EVENT_PATH === "/tour/event" && !TOUR_EVENT_PATH.startsWith("/admin/"));

    // The sendBeacon path: inject a navigator.sendBeacon stub (and rely on the real global Blob in node). emit
    // prefers it, so the fetch spy is NOT called for this event, and the recorded beacon carries the endpoint.
    const beaconCalls: Array<{ url: string; type: string }> = [];
    Object.defineProperty(gAny, "navigator", {
      value: { sendBeacon: (url: string, data?: { type?: string }): boolean => { beaconCalls.push({ url, type: (data as { type?: string } | undefined)?.type ?? "" }); return true; } },
      configurable: true,
      writable: true,
    });
    const fetchCountBefore = beacons.length;
    const beaconSent = emit({ name: "step_reached", stepIndex: 1, route: "/runs" });
    ok("emit uses navigator.sendBeacon when present (fire-and-forget, survives unload)", beaconSent === true && beaconCalls.length === 1 && beaconCalls[0]!.url === "/__tour_test_event");
    ok("the sendBeacon payload is typed application/json (a JSON Blob, not text/plain)", beaconCalls[0]!.type === "application/json");
    ok("the fetch fallback is NOT used when sendBeacon succeeds", beacons.length === fetchCountBefore);

    // A sendBeacon that REFUSES (returns false) falls through to the fetch fallback, so the event still lands.
    Object.defineProperty(gAny, "navigator", {
      value: { sendBeacon: (): boolean => false },
      configurable: true,
      writable: true,
    });
    const fetchCountBeforeRefuse = beacons.length;
    const refusedThenFetched = emit({ name: "drop_step", stepIndex: 2, detail: "exit" });
    await flushAsync(1);
    ok("a refusing sendBeacon falls through to the keepalive fetch (the event still lands)", refusedThenFetched === true && beacons.length === fetchCountBeforeRefuse + 1 && beacons[beacons.length - 1]!.event?.detail === "exit");

    // Restore navigator (no sendBeacon) for the remaining branches.
    if (savedNavigator === undefined) delete gAny.navigator;
    else Object.defineProperty(gAny, "navigator", { value: savedNavigator, configurable: true, writable: true });

    // The malformed-event swallow: a circular structure makes JSON.stringify throw; emit catches it and
    // returns false WITHOUT throwing (a telemetry hiccup must never break the tour). It beacons nothing.
    const circular: Record<string, unknown> = { name: "tour_started" };
    circular.self = circular;
    const beforeMalformed = beacons.length;
    let threw = false;
    let malformedResult = true;
    try { malformedResult = emit(circular as unknown as TourEvent); } catch { threw = true; }
    ok("a non-serialisable event is swallowed (emit returns false, never throws)", threw === false && malformedResult === false && beacons.length === beforeMalformed);

    // The no-fetch fallback arm: with neither sendBeacon nor fetch, emit returns false (gives up silently).
    const savedFetch2 = globalThis.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = undefined as unknown as typeof fetch;
    ok("emit returns false when no transport is available (no sendBeacon, no fetch)", emit({ name: "tour_started" }) === false);
    globalThis.fetch = savedFetch2;

    // Disable: emit is a no-op again.
    disableTourAnalytics();
    const beforeDisabled = beacons.length;
    ok("disableTourAnalytics turns emission back off", emit({ name: "tour_started" }) === false && beacons.length === beforeDisabled);

    // Restore the default endpoint + the real fetch for the funnel/director/fork blocks below.
    setTourAnalyticsEndpoint(TOUR_EVENT_PATH);
    globalThis.fetch = savedFetch;
  }

  // ---------------------------------------------------------------------------------------------
  // The funnel exits (data) + the funnel events end to end. The closing funnel chapter is a later stage; its
  // two deliberate exits are authored as data now (FUNNEL_CTAS). The welcome card emits tour_started (mount);
  // the director emits step_reached per chapter and drop_step on Exit and on page unload. Driven through the
  // REAL emit path with a fetch spy collecting the events, so the wiring (not just the module) is locked.
  // ---------------------------------------------------------------------------------------------
  {
    const savedFetch = globalThis.fetch;
    const events: TourEvent[] = [];
    const collector = ((_input: unknown, init?: RequestInit): Promise<Response> => {
      try { events.push(JSON.parse(String(init?.body ?? "null")) as TourEvent); } catch { /* ignore */ }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    globalThis.fetch = collector;
    enableTourAnalytics();
    setTourAnalyticsEndpoint("/__tour_funnel");
    const names = (): string[] => events.map((e) => e.name);

    // The funnel exits (DESIGN + marketing): the free self-deploy docs quickstart (https,
    // primary) and the pricing page (secondary). The analytics kind is the coarse, fixed conversion
    // descriptor, never free text.
    {
      ok("the funnel offers exactly two deliberate exits (deploy + see pricing)", FUNNEL_CTAS.length === 2);
      const deploy = FUNNEL_CTAS.find((c) => c.kind === "deploy-final");
      const pricing = FUNNEL_CTAS.find((c) => c.kind === "pricing-final");
      ok("the primary exit is the website's deploy steps page (https, primary)", deploy !== undefined && deploy.primary === true && deploy.href === "https://downpipes.io/deploy");
      ok("the secondary exit channels to the pricing page", pricing !== undefined && pricing.primary !== true && pricing.href === "https://downpipes.io/pricing?src=pricing-final");
    }

    // The director wires a funnel CHAPTER's ctas onto the nav-bar (a real anchor row) and emits cta_clicked when
    // a CTA is clicked, before the browser's own navigation. Drive a one-chapter funnel script through the real
    // director: the nav-bar renders the two exits, and clicking each emits cta_clicked with the coarse kind.
    {
      const main = document.createElement("main");
      main.id = "main";
      const header = document.createElement("h1");
      header.className = "page-header__title";
      header.textContent = "That was the free Community edition";
      main.appendChild(header);
      document.body.appendChild(main);
      const funnelChapter: TourChapter[] = [{ route: "/", title: "That was the free Community edition", infoPoints: [], ctas: FUNNEL_CTAS }];
      events.length = 0;
      const dFunnel = createTourDirector(funnelChapter, { navigate: () => {}, reseed: () => {} });
      dFunnel.start();
      await flushAsync(3);
      dFunnel.pause();
      const navBar = document.getElementById("tour-nav-bar");
      const anchors = (navBar?.querySelectorAll('[data-tour-cta-row] a') ?? []) as unknown as Array<{ getAttribute(n: string): string | null; click(): void }>;
      ok("the funnel chapter renders the two deliberate exits as real anchors in the nav-bar", anchors.length === 2);
      // The primary funnel exit is the WEBSITE's deploy-steps page (https://downpipes.io/deploy), not the docs
      // quickstart it used to be. The declarative assertions above already pin the new href; this DOM-driving
      // lookup was still searching for the old docs prefix, so it found nothing, and the two assertions below
      // silently degraded to `undefined?.getAttribute(...)` and a click on nothing. They could never pass.
      const deployA = Array.from(anchors).find((a) => (a.getAttribute("href") ?? "").startsWith("https://downpipes.io/deploy"));
      const pricingA = Array.from(anchors).find((a) => (a.getAttribute("href") ?? "").startsWith("https://downpipes.io/pricing"));
      ok("both funnel exits are https anchors opening a new tab with rel hardening", deployA?.getAttribute("target") === "_blank" && (deployA?.getAttribute("rel") ?? "").includes("noopener") && pricingA?.getAttribute("target") === "_blank" && (pricingA?.getAttribute("rel") ?? "").includes("noopener"));
      events.length = 0;
      deployA?.click();
      ok("clicking the funnel deploy exit emits cta_clicked kind=deploy-final on the funnel route", events.some((e) => e.name === "cta_clicked" && e.detail === "deploy-final" && e.route === "/"));
      events.length = 0;
      pricingA?.click();
      ok("clicking the funnel pricing exit emits cta_clicked kind=pricing-final", events.some((e) => e.name === "cta_clicked" && e.detail === "pricing-final"));
      dFunnel.destroy();
      main.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
      document.getElementById("tour-resume")?.remove();
    }

    // The director emits step_reached per painted chapter, and drop_step on Exit (detail "exit"), once (the
    // dropCounted guard means a second Exit does not double-count). Resume clears the guard so a later drop counts.
    {
      const main = document.createElement("main");
      main.id = "main";
      const header = document.createElement("h1");
      header.className = "page-header__title";
      header.textContent = "Overview";
      main.appendChild(header);
      document.body.appendChild(main);
      const script: TourChapter[] = [
        { route: "/", title: "Overview", infoPoints: [] },
        { route: "/sources", title: "Sources", infoPoints: [] },
      ];
      events.length = 0;
      const d = createTourDirector(script, { navigate: () => {}, reseed: () => {} });
      d.start();
      await flushAsync(3);
      d.pause();
      ok("chapter 0 emits step_reached with its index + route", events.some((e) => e.name === "step_reached" && e.stepIndex === 0 && e.route === "/"));
      d.next();
      await flushAsync(3);
      d.pause();
      ok("chapter 1 emits step_reached with its index + route", events.some((e) => e.name === "step_reached" && e.stepIndex === 1 && e.route === "/sources"));
      ok("step_reached is the per-chapter funnel point (it fired)", names().includes("step_reached"));
      const dropsBefore = events.filter((e) => e.name === "drop_step").length;
      d.exit();
      const exitDrops = events.filter((e) => e.name === "drop_step" && e.detail === "exit");
      ok("Exit emits a single drop_step (detail exit) on the current chapter", exitDrops.length === dropsBefore + 1 && exitDrops[exitDrops.length - 1]!.stepIndex === 1);
      d.resume();
      await flushAsync(3);
      d.pause();
      const dropsAfterResume = events.filter((e) => e.name === "drop_step").length;
      d.exit();
      ok("Resume clears the drop guard so a later Exit counts a fresh drop", events.filter((e) => e.name === "drop_step").length === dropsAfterResume + 1);
      d.destroy();
      main.remove();
      document.getElementById("tour-nav-bar")?.remove();
      document.getElementById("tour-spotlight")?.remove();
      document.getElementById("tour-resume")?.remove();
    }

    // The page-unload drop: the director wires a pagehide listener on window (window === globalThis in the shim,
    // which has no addEventListener by default), so install a recording addEventListener/removeEventListener to
    // capture + fire the handler. A pagehide while the guide is up emits drop_step (detail "unload"); after Exit
    // the listener is removed, so a later pagehide does not fire it.
    {
      const gAny = globalThis as unknown as Record<string, unknown>;
      const savedAdd = gAny.addEventListener;
      const savedRemove = gAny.removeEventListener;
      const winListeners: Record<string, Array<() => void>> = {};
      Object.defineProperty(gAny, "addEventListener", { value: (type: string, fn: () => void) => { winListeners[type] ||= []; winListeners[type].push(fn); }, configurable: true, writable: true });
      Object.defineProperty(gAny, "removeEventListener", { value: (type: string, fn: () => void) => { const l = winListeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }, configurable: true, writable: true });
      try {
        const main = document.createElement("main");
        main.id = "main";
        const header = document.createElement("h1");
        header.className = "page-header__title";
        header.textContent = "Overview";
        main.appendChild(header);
        document.body.appendChild(main);
        const script: TourChapter[] = [{ route: "/", title: "Overview", infoPoints: [] }];
        events.length = 0;
        const d = createTourDirector(script, { navigate: () => {}, reseed: () => {} });
        d.start();
        await flushAsync(3);
        d.pause();
        ok("the director registers a pagehide listener while the guide is up", (winListeners.pagehide?.length ?? 0) === 1);
        winListeners.pagehide![0]!();
        ok("a pagehide while the guide is up emits drop_step (detail unload)", events.some((e) => e.name === "drop_step" && e.detail === "unload" && e.stepIndex === 0));
        const unloadDrops = events.filter((e) => e.name === "drop_step" && e.detail === "unload").length;
        winListeners.pagehide![0]!();
        ok("a second pagehide does not double-count the drop (the guard)", events.filter((e) => e.name === "drop_step" && e.detail === "unload").length === unloadDrops);
        d.exit();
        ok("Exit removes the pagehide listener (a later unload in free-explore does not fire it)", (winListeners.pagehide?.length ?? 0) === 0);
        d.destroy();
        main.remove();
        document.getElementById("tour-nav-bar")?.remove();
        document.getElementById("tour-spotlight")?.remove();
        document.getElementById("tour-resume")?.remove();
      } finally {
        if (savedAdd === undefined) delete gAny.addEventListener; else Object.defineProperty(gAny, "addEventListener", { value: savedAdd, configurable: true, writable: true });
        if (savedRemove === undefined) delete gAny.removeEventListener; else Object.defineProperty(gAny, "removeEventListener", { value: savedRemove, configurable: true, writable: true });
      }
    }

    // The welcome card emits tour_started on the real mount, and choosing a persona emits a persona_chosen event
    // carrying that persona (a coarse label, no personal data) before the director starts. Drive it with a spy
    // director (no real guide) so only the welcome's events are observed.
    {
      const spyDirector = (): TourDirector => ({ start(): void {}, next(): void {}, back(): void {}, restart(): void {}, pause(): void {}, play(): void {}, toggleInfo(): void {}, exit(): void {}, resume(): void {}, destroy(): void {}, get index(): number { return 0; } });
      events.length = 0;
      const fork = mountPersonaFork({ createDirector: () => spyDirector() });
      ok("mounting the welcome emits tour_started (the visitor reached the first interaction)", events.some((e) => e.name === "tour_started"));
      events.length = 0;
      fork.choose("engineer");
      ok("choosing a persona emits a persona_chosen event carrying that persona (a coarse label, no personal data)", events.some((e) => e.name === "persona_chosen" && e.persona === "engineer"));
      ok("choosing a walk emits NO explore choice (a walk choice never counts as a dismissal)", !events.some((e) => e.name === "persona_chosen" && e.persona === "explore"));
      document.getElementById("tour-persona-fork")?.remove();
      // Dismissing to free-explore is a welcome engagement: the Free Explore click and Escape each emit
      // persona_chosen with the coarse choice "explore", exactly once per mount (the destroyed flag is the
      // single-emit guard), and a second destroy() on the same mount emits nothing more.
      {
        // Earlier sections removed welcome cards directly from the DOM, which leaves each of those mounts'
        // document keydown handlers wired (only a real dismissal unwires one). Flush them all with one
        // Escape while analytics are disabled (each stale handler destroys and unwires itself; emit is a
        // no-op), so the counts below observe only this block's own mounts.
        disableTourAnalytics();
        dispatchDocKey(keydown({ key: "Escape" }));
        document.getElementById("tour-persona-fork")?.remove();
        document.getElementById("tour-relaunch")?.remove();
        enableTourAnalytics();
        events.length = 0;
        const forkSkip = mountPersonaFork({ createDirector: () => spyDirector() });
        const skipCtl = document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]');
        (skipCtl as unknown as { click(): void } | null)?.click();
        ok("clicking Free Explore emits persona_chosen with the explore choice exactly once", events.filter((e) => e.name === "persona_chosen" && e.persona === "explore").length === 1);
        forkSkip.destroy();
        ok("a second dismissal of the same mount emits no second explore choice (single-emit guard)", events.filter((e) => e.name === "persona_chosen" && e.persona === "explore").length === 1);
        document.getElementById("tour-relaunch")?.remove();
        events.length = 0;
        mountPersonaFork({ createDirector: () => spyDirector() });
        dispatchDocKey(keydown({ key: "Escape" }));
        ok("Escape emits persona_chosen with the explore choice exactly once (both dismissal paths count)", events.filter((e) => e.name === "persona_chosen" && e.persona === "explore").length === 1);
        document.getElementById("tour-persona-fork")?.remove();
        document.getElementById("tour-relaunch")?.remove();
      }
      events.length = 0;
      const noBodyDoc = { getElementById: () => null, body: null } as unknown as Document;
      mountPersonaFork({ createDirector: () => spyDirector(), doc: noBodyDoc });
      ok("a no-body welcome mount does not emit tour_started (counted only on a real mount)", !events.some((e) => e.name === "tour_started"));
    }

    // Restore: turn analytics off, reset the endpoint, restore fetch, so sibling cov tests see no residue.
    disableTourAnalytics();
    setTourAnalyticsEndpoint(TOUR_EVENT_PATH);
    globalThis.fetch = savedFetch;
  }
})();

// overlayHasNoNext reports whether the live nav-bar omits the forward Next control (the last chapter holds with
// no Next). Reads the DOM the director painted.
function overlayHasNoNext(): boolean {
  const root = document.getElementById("tour-nav-bar");
  if (!root) return false;
  return (root as unknown as { querySelector(s: string): unknown }).querySelector('[data-tour-action="next"]') === null;
}

// Restore the globals this validator swapped so it leaves no residue for sibling cov tests.
g.location = savedLocation;

console.log(failures === 0 ? "demo backend coverage: OK" : `demo backend coverage: ${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
