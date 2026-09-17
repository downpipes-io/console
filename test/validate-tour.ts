// Contract guard for the public self-guided tour's faked backend and no-login boot.
// Run with: node test/validate-tour.ts (wired into npm run validate).
//
// THE PROPERTIES THIS LOCKS (so a later change cannot silently regress the tour):
//   1. The demo flag is OFF by default: isTourMode is false on a normal host with no query flag, so the
//      genuine console is byte-for-byte unaffected. It is ON only on the decided tour hostname or with the
//      ?tour= query flag, and is OFF on demo.downpipes.io (the Access-gated real engine demo, out of scope).
//   2. The no-login boot lands as the seeded owner: the faked whoami resolves a verified owner via Access,
//      and buildCallerFromWhoami (the real boot path) turns it into an owner Caller, so the app lands on
//      Overview with no sign-in and no onboarding redirect.
//   3. The faked engine answers EVERY /admin/* read the Overview's nine settled tiles + boot issue, each in
//      the console's own wire shape, so no tile degrades to an engine-unreachable error in the tour.
//   4. The honesty posture holds: status does NOT claim the throwaway demo-engine mode (demoMode). The
//      publicly explorable tour degrades GRACEFULLY: an unmodelled screen-load GET returns a benign
//      empty-but-valid 200 and an unmodelled write a benign applied/ok 200, so no screen ever surfaces an
//      engine error. The DELIBERATE non-2xx cases the console expects (a PDF render, an unknown report kind,
//      a wrong HTTP verb) still degrade honestly, since those are not screen loads.
//   5. app.ts wires the guarded branch through isTourMode + startDemo (the one and only edit to existing
//      boot), asserted by a source-string presence check so the wiring cannot be dropped unnoticed.
//   6. The tour director + the beat chrome (the BEAT model) drive a typed CHAPTER script whose
//      infoPoints are the chapter's BEATS: navigate the router per chapter, mount the nav-bar rail + the one
//      spotlight stage (tokenised, zero-dependency), walk the beats with Next/Back (Back re-enters the prior
//      chapter at its LAST beat over a re-seeded deterministic world), narrate each beat through the rail's
//      reading block AND the polite live region (the actual title + body, so assistive tech hears the story),
//      spotlight each beat's anchor (pulsing a try-it beat, which advances only on a REAL click of the
//      console's own control; autoplay performs that click itself), hold on the funnel ending with no
//      Next/Play, and Exit -> Resume drop then restore the guide (free-explore). toggleInfo is retired to a
//      benign no-op; no Tips toggle ever renders.
//   7. The two curated scripts + the welcome card: the CTO and Engineer tour scripts
//      each open with the Overview/no-custody opening and end with the funnel close, their curated middles
//      walking the assurance spine and the operate-then-prove spine respectively; every step navigates a pinned
//      TourRoute (a renamed route is caught, not a dead nav). The welcome card is the tour's first interaction: a
//      labelled, non-trapping dialog that greets the visitor, whose two persona actions each start a director
//      over that persona's script, and whose Escape/"Free Explore" drops it to free-explore without starting a tour.
//   8. The funnel ending + the analytics events: the closing step presents the two deliberate
//      exits (the website's deploy steps + the pricing page) as real anchors in the bubble,
//      the docs link opening a new tab with rel hardening; and the tour emits its small, PII-free funnel
//      events (tour started, per-step reached, drop step, ending CTA clicked) to a SAME-ORIGIN beacon (not
//      under /admin/*, so the faked-engine shim does not swallow it), best-effort and only when enabled, with
//      no third-party tracker. emit() is a no-op while disabled (the genuine console never beacons).
//   9. The script-to-screen binding: connected as the seeded owner, the demo
//      lands on Overview, and EVERY step of the shipping tour script is driven against the REAL screen
//      its route binds to (resolved through the same app-registry SCREENS list the router uses), so a targeted
//      step's ".page-header__title" actually RESOLVES on the live screen. A renamed route (no owning screen),
//      a renamed page-header class, or a header suppressed on a proof route fails here, rather than silently
//      degrading the spotlight to a centred bubble at runtime with no test failing.
//
// No network, no DOM beyond the shared shim: the interceptor answers /admin/* in-memory. It imports the
// shared DOM shim exactly as the other suites do and never edits it (it only adds a missing browser-standard
// Node.insertBefore on the shim node AT RUNTIME, in this process, so the real proof screens render fully).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChecks } from "./validate-checks.ts";
import { installDomShim, flushAsync, keydown, dispatchDocKey, } from "./dom-shim.ts";
import { makeEvent, ShimNode } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

// Runtime polyfill for Node.insertBefore on the shim node, added ONLY in this process (each validate-*.ts
// runs in its own node, so this never leaks to another suite) and ONLY when the shim does not already
// provide it. The screen-render smoke check below mounts REAL proof screens, and a couple of them
// (idp-connections.ts, sources.ts) place an add-flow disclosure ABOVE a list region with root.insertBefore,
// a standard DOM call the shim's ShimNode does not implement. This adds it additively in terms of the shim's
// existing childNodes array + the same reparenting + string/number/fragment coercion appendChild uses, so
// the real screens render end-to-end (header included) rather than throwing mid-render. It weakens nothing:
// it only supplies a missing browser-standard method so the binding can be genuinely exercised.
if (typeof (ShimNode.prototype as { insertBefore?: unknown }).insertBefore !== "function") {
  (ShimNode.prototype as unknown as { insertBefore(node: ShimNode | string | number | null, ref: ShimNode | null): ShimNode | null }).insertBefore =
    function insertBefore(this: ShimNode, node: ShimNode | string | number | null, ref: ShimNode | null): ShimNode | null {
      if (node == null) return null;
      // A null reference node means "append at the end", exactly like the DOM. Otherwise splice before ref.
      if (ref === null || this.childNodes.indexOf(ref) < 0) return this.appendChild(node);
      // Coerce a raw string/number to a text node and flatten a fragment, mirroring appendChild's contract.
      let child = node as ShimNode;
      if (typeof node === "string" || typeof node === "number") {
        const t = new ShimNode("text");
        (t as unknown as { text_: string }).text_ = String(node);
        child = t;
      }
      if (child.kind === "fragment") {
        // Calls itself by name rather than through `this`: the prototype does not carry insertBefore until
        // the assignment below completes, so the compiler cannot see it on `this`, and a named function
        // expression is in scope inside its own body. Same call at runtime.
        for (const c of [...child.childNodes]) insertBefore.call(this, c, ref);
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
      return child;
    };
}

// Keep the Checks object so `checks.failures` reads the LIVE getter at the end: destructuring `failures`
// would capture the count as 0 at this point and never update, neutering the exit code (the suite would
// report OK even on a real failure). Only the reporter methods are safe to destructure.
const checks = makeChecks();
const { ok, has } = checks;

const { isTourMode, installDemoFetch } = await import("../src/lib/demo/demo-fetch.ts");
const { route } = await import("../src/lib/demo/demo-routes-read.ts");
const { resetWorld, demoWhoami } = await import("../src/lib/demo/demo-world.ts");
const { installTourBanner, removeTourBanner, resetSampleData, installTourCornerMarker, removeTourCornerMarker, installTourSiteLink, removeTourSiteLink } = await import("../src/lib/demo/banner.ts");
const { renderAccount } = await import("../src/shell/chrome.ts");
const { mountNavBar } = await import("../src/lib/demo/tour/nav-bar.ts");
const { createSpotlight } = await import("../src/lib/demo/tour/spotlight.ts");
const { createTourDirector } = await import("../src/lib/demo/tour/director.ts");
const { mountPersonaFork } = await import("../src/lib/demo/tour/persona-fork.ts");
const { ctoChapters, engineerChapters, TOUR_SCRIPTS, TOUR_ROUTES, FUNNEL_CTAS } = await import("../src/lib/demo/tour/scripts/chapters.ts");
const { emit, enableTourAnalytics, disableTourAnalytics, setTourAnalyticsEndpoint, readTourAttribution, TOUR_EVENT_PATH } = await import("../src/lib/demo/tour/analytics.ts");
type TourEvent = import("../src/lib/demo/tour/analytics.ts").TourEvent;
type TourPersona = import("../src/lib/demo/tour/scripts/chapters.ts").TourPersona;
type TourChapter = import("../src/lib/demo/tour/director.ts").TourChapter;
type InfoPoint = import("../src/lib/demo/tour/director.ts").InfoPoint;
type TourDirector = import("../src/lib/demo/tour/director.ts").TourDirector;
type Spotlight = import("../src/lib/demo/tour/spotlight.ts").Spotlight;
const { buildCallerFromWhoami } = await import("../src/lib/app-identity.ts");
const { hasRole } = await import("../src/lib/identity.ts");
const { mapEngineDownpipeState } = await import("../src/lib/api/helpers.ts");
const { protectionStatement, destinationFromStatus } = await import("../src/lib/protection-statement.ts");
// The REAL screen list the app wires (app-registry.ts SCREENS + the separately route-bound Overview), and
// the descriptor's own route normaliser, so the script-to-screen smoke check below resolves a step's route
// to the SAME screen the production router would, and a script route that no screen owns is caught here.
const { SCREENS } = await import("../src/lib/app-registry.ts");
const { overviewScreen } = await import("../src/screens/overview.ts");
const { routesOf } = await import("../src/screens/common.ts");
const { connect, setCaller, getEngine } = await import("../src/lib/store.ts");
const { installNav, recordNav, currentRoute } = await import("../src/lib/nav.ts");
type Screen = import("../src/screens/common.ts").Screen;
type ScreenContext = import("../src/screens/common.ts").ScreenContext;
type WhoAmI = import("../src/lib/api/types.ts").WhoAmI;
type StatusReport = import("../src/lib/api/types.ts").StatusReport;
type EngineDownpipeState = import("../src/lib/api/types.ts").EngineDownpipeState;

console.log("-- Self-guided tour contract guard (faked backend + no-login boot) --");

// 1. The demo flag is off by default; on by hostname (production) or by the ?tour= flag on a DEV host only;
//    off on the real engine demo host; and crucially OFF on the production console even WITH the ?tour= flag
//    (the query trigger is scoped to dev hosts, so a crafted ?tour= link cannot fake the real console).
ok("tour OFF by default (normal host, no flag) -> genuine console untouched", isTourMode({ hostname: "console.example", search: "" } as Location) === false);
ok("tour ON on the decided tour hostname (tour.downpipes.io)", isTourMode({ hostname: "tour.downpipes.io", search: "" } as Location) === true);
ok("tour ON with the ?tour= query flag on a DEV host (localhost, the local/dev opt-in)", isTourMode({ hostname: "localhost", search: "?tour=1" } as Location) === true);
ok("tour ON with the ?tour= query flag on a *.local dev host", isTourMode({ hostname: "my-box.local", search: "?tour" } as Location) === true);
ok("tour OFF with the ?tour= query flag on the PRODUCTION console (the flag is dev-host-scoped, no faking the real origin)", isTourMode({ hostname: "console.downpipes.io", search: "?tour=1" } as Location) === false);
ok("tour OFF with ?tour=0 / ?tour=false on production (presence-on-prod is still ignored, not parsed-as-truthy)", isTourMode({ hostname: "console.downpipes.io", search: "?tour=0" } as Location) === false && isTourMode({ hostname: "console.downpipes.io", search: "?tour=false" } as Location) === false);
ok("tour OFF on demo.downpipes.io (Access-gated real engine demo, out of scope)", isTourMode({ hostname: "demo.downpipes.io", search: "" } as Location) === false);
ok("tour OFF on demo.downpipes.io EVEN WITH ?tour= (the Access-gated real engine demo is never faked by the flag)", isTourMode({ hostname: "demo.downpipes.io", search: "?tour=1" } as Location) === false);

// 2. The no-login boot resolves the seeded owner through the REAL boot identity path.
resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
const who = JSON.parse(await (await route("/admin/whoami")).text()) as WhoAmI;
ok("faked whoami is a verified owner via Cloudflare Access", who.role === "owner" && who.method === "access" && who.email !== null);
const caller = buildCallerFromWhoami(who);
ok("buildCallerFromWhoami (the real boot path) yields an owner Caller", caller.role === "owner" && caller.email === who.email);
// The demo-seam caller PRIME (demo-fetch.startDemo): the synchronous accessor demoWhoami() returns the SAME
// seed whoami the /admin/whoami route serves, so the caller startDemo() seats synchronously at boot (before
// app.ts's background resolveIdentity lands) is byte-identical to the one the async path later builds. This is
// what makes FREE-EXPLORE owner-gated UI present from the first paint (the Overview pending-approval item, the
// /restore/approvals Approve button), matching the guided tour. Locks the contract that the prime reads the same
// owner the route does, and that hasRole(owner, approver) holds so an Owner can approve in free-explore.
{
  const seedWho = demoWhoami();
  ok("demoWhoami() returns the SAME seed whoami the /admin/whoami route serves (the synchronous prime source)", JSON.stringify(seedWho) === JSON.stringify(who));
  const primed = buildCallerFromWhoami(seedWho);
  ok("the demo-seam prime seats a verified OWNER caller (so free-explore owner-gated UI shows from the first render)", primed.role === "owner" && primed.method === "access" && primed.email !== null);
  ok("an Owner caller satisfies the approver gate, so the Overview pending-approval item + the Approve button render in free-explore", hasRole(primed.role, "approver"));
}

// 3. Every Overview read + boot read AND every proof-of-moat screen read is answered in the wire shape (a
//    200 the console parses, not a 501), so no tile degrades to an engine-unreachable error in the tour.
//    The proof-of-moat reads are the guided-tour spine: destinations + replication (3-2-1 + WORM), native
//    SSO (SAML/OIDC), the tamper-evident audit chain + its verify, posture + coverage + expiry, the RTO
//    and the signed reports + evidence packs, and the dual-control restore-approvals inbox.
const reads: Array<[string, string]> = [
  ["GET", "/admin/health"],
  ["GET", "/admin/whoami"],
  ["GET", "/admin/status"],
  ["GET", "/admin/setup-state"],
  ["GET", "/admin/licence"],
  ["GET", "/admin/updates"],
  ["GET", "/admin/downpipes"],
  ["GET", "/admin/drill-evidence"],
  ["GET", "/admin/history"],
  ["GET", "/admin/history?id=dp-payments"],
  ["GET", "/admin/audit"],
  ["GET", "/admin/audit/verify"],
  ["GET", "/admin/approvals"],
  // Destinations + the 3-2-1 replication state (the recovery spine).
  ["GET", "/admin/destination"],
  ["GET", "/admin/destinations"],
  ["GET", "/admin/replication"],
  // Native external-IdP SSO (the assurance spine) + the pre-auth sign-in DTOs.
  ["GET", "/admin/idp/connections"],
  ["GET", "/admin/idp/presets"],
  ["GET", "/admin/oidc/providers"],
  // The assurance reads (Security centre + Credentials + Reports).
  ["GET", "/admin/posture"],
  ["GET", "/admin/coverage"],
  ["GET", "/admin/expiry"],
  ["GET", "/admin/config/approval-policy"],
  ["GET", "/admin/rto"],
  ["GET", "/admin/rto?id=dp-ledger"],
  ["GET", "/admin/reports/restore-tests"],
  ["GET", "/admin/reports/sla-compliance"],
  ["GET", "/admin/reports/immutability"],
  ["GET", "/admin/reports/posture"],
  ["GET", "/admin/reports/evidence-pack?framework=apra-cps-230-234"],
  ["GET", "/admin/reports/evidence-pack?framework=all"],
  // The dual-control restore-approvals inbox (the restore-flow + the owner needs-attention tile).
  ["GET", "/admin/restore/approvals"],
  // The remaining governance / proof-of-moat screen-load reads that previously hit the 501 fallback, now
  // modelled so EVERY nav item renders populated and nothing surfaces "the engine returned an error".
  ["GET", "/admin/canary"],
  ["GET", "/admin/config/changes"],
  ["GET", "/admin/config/history"],
  ["GET", "/admin/config/version?id=14"],
  ["GET", "/admin/config/diff?from=10&to=14"],
  ["GET", "/admin/cost/estate-size"],
  ["GET", "/admin/roles"],
  ["GET", "/admin/group-roles"],
  ["GET", "/admin/custom-roles"],
  ["GET", "/admin/notify/channels"],
  ["GET", "/admin/notify/rules"],
  ["GET", "/admin/notify/history"],
  ["GET", "/admin/owner-actions"],
  ["GET", "/admin/passkey/credentials"],
  ["GET", "/admin/sessions"],
  ["GET", "/admin/preflight"],
  ["GET", "/admin/support"],
  ["GET", "/admin/update/status"],
  ["GET", "/admin/sources/discover"],
  ["GET", "/admin/sources/discovery-status"],
  ["GET", "/admin/runs/at?downpipe=dp-ledger&at=2026-06-27T00:00:00Z"],
];
for (const [method, path] of reads) {
  const res = await route(path, { method });
  ok(`${method} ${path} is modelled (200 application/json, not an engine-unreachable tile)`, res.status === 200 && (res.headers.get("content-type") ?? "").includes("application/json"));
}

// 3c. The source-discovery catalogue the add-source flow reads must offer EVERY source type, so the Sources
//     "add a source" set matches the Downpipes "new downpipe" set exactly (all nine, including Account
//     Config). This mirrors lib/token-source.ts availableTokenSourceTypes (cf-config offered on a non-empty
//     cfConfigSurfaces; workers/stream/images/artifacts on their literal-true capability flag) plus the four
//     binding stores (kv/r2/d1/secrets), so a later seed edit cannot silently drop a type from one catalogue.
{
  type SourceDiscovery = import("../src/lib/api/types.ts").SourceDiscovery;
  const disc = JSON.parse(await (await route("/admin/sources/discover")).text()) as SourceDiscovery;
  ok("discovery has the customer read-only token present (the account tier is enabled)", disc.tokenPresent === true);
  ok("discovery offers all four account-scoped media/config capabilities (workers + stream + images + artifacts)", disc.workersSupported === true && disc.streamSupported === true && disc.imagesSupported === true && disc.artifactsSupported === true);
  ok("discovery offers a non-empty cf-config surface catalogue (Account Config is addable)", (disc.cfConfigSurfaces ?? []).length > 0);
  ok("discovery lists at least one zone for per-zone cf-config (DNS/WAF/zone settings addable)", (disc.accounts?.[0]?.zones ?? []).length > 0);
  ok("discovery surfaces the four binding stores (kv + r2 + d1 + secrets) as bound or account-discovered", disc.bound.kv.length > 0 && disc.bound.r2.length > 0 && disc.bound.d1.length > 0 && disc.bound.secrets.length > 0 && (disc.accounts?.[0]?.secrets ?? []).length > 0);
}

// 3a. GET /admin/downpipes must answer in the engine's RAW wire shape, because the ONLY consumer,
//     listDownpipes(), flattens the response through mapEngineDownpipeState (it reads the engine's NESTED
//     restoreProven / integrityVerified objects + an EPOCH-MS lastRestoreTestAt). A flat-fixture response is
//     a 200 application/json that 3 above is blind to, yet the mapper would drop EVERY recency stamp, so
//     every pipe would silently render "never proven" / "never integrity-checked" on Overview and Restore.
//     Drive the response through the REAL boundary mapper (the production path) and the REAL
//     protectionStatement, asserting the proven data pipes read PROVEN + integrity-checked while the
//     not-yet-proven cf-config pipe honestly reads "never proven", so the deliberate assurance contrast
//     cannot regress unseen (the precise "both suites green while production renders 'never'" failure mode
//     the mapper's own comments warn about). No value or key transits; recency stamps + a coarse prover label.
{
  const wire = JSON.parse(await (await route("/admin/downpipes")).text()) as EngineDownpipeState[];
  const mapped = wire.map(mapEngineDownpipeState);
  const byId = new Map(mapped.map((d) => [d.config.id, d]));
  const ledger = byId.get("dp-ledger");
  const payments = byId.get("dp-payments");
  const statements = byId.get("dp-statements");
  const cfConfig = byId.get("dp-cf-config");
  ok("GET /admin/downpipes round-trips the seed recency through the REAL mapEngineDownpipeState (the three data pipes keep their proven + integrity stamps, not dropped to 'never')",
    ledger?.lastRestoreProvenAt !== undefined && ledger.lastRestoreProvenBy === "ops@northwind.example" && ledger.lastIntegrityVerifiedAt !== undefined && ledger.lastRestoreTestAt !== undefined &&
    payments?.lastRestoreProvenAt !== undefined && payments.lastIntegrityVerifiedAt !== undefined &&
    statements?.lastRestoreProvenAt !== undefined && statements.lastIntegrityVerifiedAt !== undefined);
  ok("the cf-config pipe alone honestly carries NO restore-proven stamp through the mapper (the deliberate 'never proven' contrast, not all-proven theatre)",
    cfConfig !== undefined && cfConfig.lastRestoreProvenAt === undefined && cfConfig.lastRestoreProvenBy === undefined);

  // The rendered protection statement is the ultimate consumer: drive it (the production string builder) to
  // assert the narrative READS proven for a data pipe and "never proven" for cf-config, at the seed clock so
  // the overdue maths is deterministic. This is the sentence Overview's lead line + the Restore screen show.
  const status = JSON.parse(await (await route("/admin/status")).text()) as StatusReport;
  const dest = destinationFromStatus(status);
  const nowMs = Date.UTC(2026, 5, 27, 0, 0, 0);
  const ledgerSentence = ledger ? protectionStatement(ledger, dest, nowMs).sentence : "";
  const cfSentence = cfConfig ? protectionStatement(cfConfig, dest, nowMs).sentence : "";
  ok("a data pipe's rendered protection statement reads restorability PROVEN (the proof-of-moat narrative survives the boundary), not 'never proven'",
    ledgerSentence.includes("offline restorability last proven") && !ledgerSentence.includes("never proven") && ledgerSentence.includes("integrity-checked"));
  ok("the cf-config pipe's rendered protection statement reads 'offline restorability never proven' (the honest imperfection is preserved)",
    cfSentence.includes("offline restorability never proven"));
}

// 3b. The deliberate imperfections are the point (DESIGN): the evaluator's wow is "it catches problems", so an
//     all-green world would read as theatre. Lock the failed run, the in-flight run, the expiring SSO cert,
//     the unprotected resource (the coverage gap), and the one failing posture check, so a later seed edit
//     cannot quietly sand the story smooth.
{
  type RunHistoryEntry = import("../src/lib/api/types.ts").RunHistoryEntry;
  type ExpiryStatus = import("../src/lib/api/types.ts").ExpiryStatus;
  type CoverageReport = import("../src/lib/api/types.ts").CoverageReport;
  type PostureReport = import("../src/lib/api/types.ts").PostureReport;
  type DestinationList = import("../src/lib/api/types.ts").DestinationList;
  type IdpConnectionView = import("../src/lib/api/types.ts").IdpConnectionView;

  const payments = JSON.parse(await (await route("/admin/history?id=dp-payments")).text()) as { entries: RunHistoryEntry[] };
  ok("the seed surfaces a FAILED run (a problem is shown, not all-green theatre)", payments.entries.some((e) => e.status === "failed"));
  ok("the seed surfaces an in-flight run (the live state is visible)", payments.entries.some((e) => e.status === "in-flight"));

  const expiry = JSON.parse(await (await route("/admin/expiry")).text()) as ExpiryStatus[];
  ok("the SSO signing cert expiry is tracked and approaching (the live cert-expiry alert)", expiry.some((e) => e.kind === "certificate" && e.state === "approaching" && (e.daysRemaining ?? 0) > 0));

  const coverage = JSON.parse(await (await route("/admin/coverage")).text()) as CoverageReport;
  ok("coverage has a stored inventory (a real gap view, not honest-unknown)", coverage.hasInventory === true);
  ok("coverage surfaces an UNPROTECTED resource (the gap-detection wow)", coverage.resources.some((r) => r.status === "unprotected"));

  const posture = JSON.parse(await (await route("/admin/posture")).text()) as PostureReport;
  ok("posture has at least one FAILING check (the score is not a fabricated 100)", posture.checks.some((c) => c.status === "fail") && posture.score < 100);

  const dests = JSON.parse(await (await route("/admin/destinations")).text()) as DestinationList;
  // THREE destinations, and the third one's whole reason for being there is that it is NOT S3. The primary
  // and the replica are the 3-2-1 pair in two regions; the Azure cold copy means the tour and the training
  // course render a provider badge other than "S3", provider-dependent copy, and an immutability
  // prerequisite belonging to a store other than Amazon's, so a learner never finishes the course having
  // seen only Amazon.
  ok("three destinations across three regions (the 3-2-1 pair plus a cold copy)", dests.destinations.length === 3 && new Set(dests.destinations.map((d) => d.region)).size === 3);
  ok("...and one of them is NOT an S3 host, so a provider badge other than S3 is rendered", dests.destinations.some((d) => (d.endpointHost ?? "").includes(".blob.core.windows.net")));
  ok("CONTROL: the 3-2-1 pair is still there, so the third was added rather than swapped in", dests.destinations.filter((d) => (d.endpointHost ?? "").includes("amazonaws.com")).length === 2);
  ok("both destinations enforce Object-Lock (WORM is real, not merely configured)", dests.destinations.every((d) => d.objectLock === "enforced"));

  const idp = JSON.parse(await (await route("/admin/idp/connections")).text()) as { connections: IdpConnectionView[] };
  const saml = idp.connections.find((c) => c.kind === "saml");
  ok("a SAML connection exists with PUBLIC signing certs and NO secret value (redaction)", saml !== undefined && saml.kind === "saml" && saml.idpSigningCerts.length >= 1);
  ok("an OIDC connection's secret is a { mode } descriptor, never a value (redaction)", idp.connections.some((c) => c.kind === "oidc" && typeof (c as { secretRef: { mode: string } }).secretRef.mode === "string" && !("value" in (c as { secretRef: object }).secretRef)));
}

// 4. Honesty + graceful degradation: no throwaway-demo claim; the publicly explorable tour NEVER surfaces an
//    engine error on a screen, so an unmodelled screen-load GET degrades to a benign empty-but-valid 200
//    (not a 501 the console would render as "the engine returned an error"). A MODELLED write returns the
//    applied/queued/pending shape the console parses; an UNMODELLED write degrades to a benign
//    applied/ok 200. The deliberate non-2xx cases (a PDF render, an unknown report kind, a wrong verb) still
//    degrade honestly below, because those are not screen loads.
const status = JSON.parse(await (await route("/admin/status")).text()) as { demoMode?: boolean; ready: boolean };
ok("status is ready (dashboard mounts) but does NOT claim throwaway demoMode", status.ready === true && status.demoMode !== true);
{
  const unknownGet = await route("/admin/no-such-screen-load");
  const unknownBody = JSON.parse(await unknownGet.text()) as { ok?: boolean };
  ok("an unmodelled screen-load GET degrades to a benign 200 (never a 501 that surfaces an engine error)", unknownGet.status === 200 && (unknownGet.headers.get("content-type") ?? "").includes("application/json") && unknownBody.ok === true);
}
// The PDF render path is not modelled in the tour. A ?format=pdf request (what the console's getReportPDF /
// getEvidencePackPDF send) MUST degrade HONESTLY to a non-2xx the api layer routes through failResponse, so
// the screen restores the download button and warns; it must NEVER return the JSON Report/pack as a 200
// dressed as application/pdf (a wrong-content download reported as a success). Both PDF variants.
{
  const reportPdf = await route("/admin/reports/posture?format=pdf");
  ok("a report ?format=pdf degrades honestly (non-2xx, not JSON labelled application/pdf)", reportPdf.status === 501 && !(reportPdf.headers.get("content-type") ?? "").includes("application/pdf"));
  const packPdf = await route("/admin/reports/evidence-pack?framework=apra-cps-230-234&format=pdf");
  ok("an evidence-pack ?format=pdf degrades honestly (non-2xx, not the JSON pack labelled application/pdf)", packPdf.status === 501 && !(packPdf.headers.get("content-type") ?? "").includes("application/pdf"));
}
// The demo org runs four-eyes ON, so a config mutation (create downpipe) is DEFERRED: HTTP 202 + the
// { queued: true, id, status, contentHash } body the console reads as "queued for approval", never a
// fabricated "saved".
//
// The demo used to answer `{ pending: true, id }`, which NO ENGINE ROUTE EMITS. Because the console's own
// guard was written to that same invention, the demo was the ONLY place the queued-for-approval path ever
// worked: the tour showed the pending toast while a real engine's 202 degraded silently to "applied". A
// simulator that answers a body the real thing never sends does not de-risk the real path, it hides it. This
// assertion is now pinned to the engine's wire (src/sched/scheduler-do.ts).
{
  const created = await route("/admin/downpipes", { method: "POST", body: JSON.stringify({ id: "dp-x", name: "New pipe" }) });
  const body = JSON.parse(await created.text()) as { queued?: boolean; id?: string };
  ok("a create-downpipe write is queued for approval (202 queued), the engine's real write shape", created.status === 202 && body.queued === true && typeof body.id === "string");
}
{
  const unknownWrite = await route("/admin/some-unmodelled-write", { method: "POST", body: "{}" });
  const wb = JSON.parse(await unknownWrite.text()) as { ok?: boolean };
  ok("an UNMODELLED write degrades to a benign applied/ok 200 (a click never surfaces an engine error)", unknownWrite.status === 200 && wb.ok === true);
}

// 4b. The proof-of-moat WRITE spine: the demonstrated mutations the guided tour narrates
//     reflect in the UI and return the shapes the console parses. Re-seed first so the writes act on the
//     pristine fleet. trigger mints a live run; the recoverability verbs (drill / blind verify) pass and
//     prove offline restorability; the restore APPLY is GATED on a real dual-control approval (un-approved
//     apply is the honest 403; request -> a DISTINCT owner approves -> apply returns the receipt). No write
//     persists across a reload (the world is module-scoped; resetWorld re-seeds), and no plaintext transits.
{
  type RunHistoryEntry = import("../src/lib/api/types.ts").RunHistoryEntry;
  type RestoreApproval = import("../src/lib/api/types.ts").RestoreApproval;
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));

  const trig = JSON.parse(await (await route("/admin/trigger", { method: "POST", body: JSON.stringify({ id: "dp-ledger" }) })).text()) as { runId?: string; index?: number };
  const ledger = JSON.parse(await (await route("/admin/history?id=dp-ledger")).text()) as { entries: RunHistoryEntry[] };
  ok("trigger mints a NEW in-flight run at the head of the ring (a live run appears)", typeof trig.runId === "string" && ledger.entries[0]!.runId === trig.runId && ledger.entries[0]!.status === "in-flight");

  const verify = JSON.parse(await (await route("/admin/restore/verify", { method: "POST", body: JSON.stringify({ runId: "run-ledger-0009" }) })).text()) as { ok: boolean; restoreDigest: string | null };
  ok("the BLIND restore test passes WITHOUT exposing plaintext (a digest over hashes, no record value)", verify.ok === true && (verify.restoreDigest ?? "").startsWith("sha384:"));

  // The dual-control restore: un-approved apply is the honest 403; request -> distinct-approver-approve ->
  // apply receipt. The checker MUST differ from both the maker (the engine's maker != checker) and the
  // signed-in owner (so the confirm screen's pre-flight, which arms Apply only when the approver differs from
  // the LIVE caller, can light Apply for the owner driving the apply; seeding the owner as the approver left
  // Apply permanently gated in free-explore).
  const applyReq = { runId: "run-payments-0041", reason: "Recovery rehearsal." };
  const unapproved = await route("/admin/restore", { method: "POST", body: JSON.stringify({ ...applyReq, confirm: true }) });
  ok("an un-approved restore apply is the honest 403, never a false receipt", unapproved.status === 403);
  const raised = JSON.parse(await (await route("/admin/restore/request", { method: "POST", body: JSON.stringify(applyReq) })).text()) as RestoreApproval;
  ok("requestRestore raises a pending approval by a DISTINCT maker (maker != checker)", raised.status === "requested" && raised.requestedBy !== "ops@northwind.example");
  const approved = JSON.parse(await (await route("/admin/restore/approve", { method: "POST", body: JSON.stringify({ planHash: raised.planHash }) })).text()) as RestoreApproval;
  ok("a distinct checker approves it, differing from BOTH the maker and the signed-in owner-applier (so the confirm screen can arm Apply)", approved.status === "approved" && typeof approved.approvedBy === "string" && approved.approvedBy !== approved.requestedBy && approved.approvedBy !== "ops@northwind.example");
  const applied = JSON.parse(await (await route("/admin/restore", { method: "POST", body: JSON.stringify({ ...applyReq, confirm: true }) })).text()) as { ok: boolean; mode: string };
  ok("the approved apply returns the applied RestoreResult receipt", applied.ok === true && applied.mode === "applied");

  // The confirm-screen pre-flight (restore-flow/confirm.ts findUsableApproval) arms Apply ONLY when the
  // approver email differs from the LIVE caller email (approvedBy !== callerEmail; the UX stand-in for the
  // engine's maker != checker). Reproduce that exact comparison against the demo's actual signed-in caller
  // so a regression that re-points the demo approver back at the owner-applier (re-gating Apply permanently
  // in free-explore, the headline dual-control moment) is caught here. raised2 is a fresh request whose
  // approval is not yet consumed (the apply above consumed the first), so the record is a usable approval.
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
  const raised2 = JSON.parse(await (await route("/admin/restore/request", { method: "POST", body: JSON.stringify(applyReq) })).text()) as RestoreApproval;
  const approved2 = JSON.parse(await (await route("/admin/restore/approve", { method: "POST", body: JSON.stringify({ planHash: raised2.planHash }) })).text()) as RestoreApproval;
  const confirmGateArms = approved2.status === "approved" && !!approved2.approvedBy && approved2.approvedBy !== caller.email;
  ok("the confirm screen can ARM Apply for the signed-in owner: the seeded approver differs from the live caller (the free-explore dual-control apply is drivable)", confirmGateArms);

  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0)); // re-seed so a re-run sees the pristine world
}

// 4c. The persistent honesty banner + the throwaway-control suppression (DESIGN: the demo is LABELLED at all
//     times and never mistaken for a real account, and the throwaway engine's "Reset demo" control must not
//     appear because there is no reset endpoint, reset is a page reload). The banner reads the honest copy
//     and carries a role + aria-label; it is fixed and pointer-transparent so it never blocks the app. The
//     Reset-demo control renders ONLY when status.demoMode === true (settings.ts), and the demo status sets
//     demoMode !== true, so the control stays suppressed with NO change to the settings screen.
{
  removeTourBanner();
  const banner = installTourBanner();
  ok("the persistent demo banner mounts and reads the honest demo + reset copy", banner !== null && (banner?.textContent ?? "").includes("Demo. Sample data. Resets on reload."));
  ok("the banner is fixed + pointer-transparent (never blocks the app) with a role + aria-label", banner?.style.getPropertyValue("position") === "fixed" && banner?.style.getPropertyValue("pointer-events") === "none" && banner?.getAttribute("role") === "note");
  ok("the banner install is idempotent (a redundant install never stacks a second banner)", installTourBanner() === banner);

  // The "Reset sample data" control: a real keyboard-reachable button in the banner that re-seeds the world and
  // re-renders the current screen (re-navigating to the current route), NOT a page reload. Drive the real wiring:
  // record a current route + a navigate spy, mutate the world, click Reset, and confirm the re-seed + re-nav.
  const resetBtn = banner?.querySelector('[data-tour-reset]') as { tagName?: string; getAttribute(n: string): string | null; click(): void } | null;
  ok("the banner carries a 'Reset sample data' button (a real, keyboard-reachable control)", resetBtn !== null && resetBtn?.tagName === "BUTTON" && (resetBtn?.getAttribute("aria-label") ?? "").includes("Reset"));
  {
    resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
    recordNav("/runs");
    const resetNavs: string[] = [];
    installNav({ navigate: (to) => { resetNavs.push(to); }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
    ok("currentRoute returns the recorded current route (the screen the reset re-renders in place)", currentRoute().startsWith("/runs"));
    // Mutate the world (an extra ledger run), then click Reset and confirm it reverts + re-navigates.
    await route("/admin/trigger", { method: "POST", body: JSON.stringify({ id: "dp-ledger" }) });
    const before = (JSON.parse(await (await route("/admin/history?id=dp-ledger")).text()) as { entries: unknown[] }).entries.length;
    resetBtn?.click();
    const after = (JSON.parse(await (await route("/admin/history?id=dp-ledger")).text()) as { entries: unknown[] }).entries.length;
    ok("clicking Reset re-seeds the world back to pristine (the prior mutation is reverted, no page reload)", after < before);
    ok("clicking Reset re-renders the current screen by re-navigating to the current route", resetNavs.some((to) => to.startsWith("/runs")));
    void resetSampleData; // the exported verb the button calls (covered directly in the cov suite)
    installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
    resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
  }
  removeTourBanner();

  const statusForSuppression = JSON.parse(await (await route("/admin/status")).text()) as StatusReport;
  ok("the demo status keeps demoMode unset, so the throwaway engine's 'Reset demo' control stays suppressed", statusForSuppression.demoMode !== true);
}

// 4c-bis. The SIMULATED-action cue: a genuine WRITE the faked engine applies/queues in tour mode shows a
//     reassuring, debounced toast; a read (GET) never does, and an honest refusal (a dual-control 403) does not
//     either. Driven through the live interceptor on the tour host (isTourMode true), reading the toast region.
{
  // The cue is gated on isTourMode(location), so this block runs on the tour host; the original location is
  // restored after so later blocks see the default. The shim's location has no hostname by default.
  const gLoc = globalThis as unknown as Record<string, unknown>;
  const savedLoc = gLoc.location;
  gLoc.location = { origin: "https://tour.downpipes.io", hostname: "tour.downpipes.io", search: "", href: "https://tour.downpipes.io/", pathname: "/" };
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
  const savedFetchCue = globalThis.fetch;
  installDemoFetch();
  const toastText = (): string => {
    let t = "";
    for (const n of document.body.childNodes as unknown as Iterable<{ className?: string; textContent?: string }>) {
      if (typeof n.className === "string" && n.className.includes("toast-region")) t += ` ${n.textContent ?? ""}`;
    }
    return t;
  };
  const clearToasts = (): void => {
    for (const n of document.body.childNodes as unknown as Iterable<{ className?: string; replaceChildren?: () => void; firstChild?: unknown; removeChild?: (c: unknown) => void }>) {
      if (typeof n.className === "string" && n.className.includes("toast-region")) {
        if (typeof n.replaceChildren === "function") n.replaceChildren();
        else while (n.firstChild) n.removeChild?.(n.firstChild);
      }
    }
  };
  // Drain any in-flight cue, then a GET must stay silent.
  await new Promise((r) => setTimeout(r, 700)); clearToasts();
  await globalThis.fetch("https://tour.downpipes.io/admin/status");
  await new Promise((r) => setTimeout(r, 600));
  ok("the simulated-action cue never fires for a GET read (reads + polls are silent)", !toastText().includes("Simulated"));
  // A successful WRITE shows the reassuring cue.
  clearToasts();
  await globalThis.fetch("https://tour.downpipes.io/admin/canary/run", { method: "POST", body: "{}" });
  await new Promise((r) => setTimeout(r, 600));
  ok("a successful WRITE shows the simulated-action cue (sample data, nothing left the browser)", toastText().includes("Simulated") && toastText().toLowerCase().includes("sample data"));
  // An honest dual-control refusal (403) does NOT claim a simulated write.
  clearToasts();
  const refused = await globalThis.fetch("https://tour.downpipes.io/admin/restore", { method: "POST", body: JSON.stringify({ runId: "run-payments-0041", reason: "x", confirm: true }) });
  await new Promise((r) => setTimeout(r, 600));
  ok("an honest refusal (a dual-control 403) does NOT fire the simulated-action cue", refused.status === 403 && !toastText().includes("Simulated"));
  clearToasts();
  globalThis.fetch = savedFetchCue;
  gLoc.location = savedLoc;
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
}

// 4c-ter. Impersonation hardening (looks-real): the tour is UNMISTAKABLY a demo even in a cropped screenshot or
//     with a modal open. (A.1) the tab title carries "(Demo) " in tour mode; (A.2) a screenshot-robust corner
//     marker is pinned ABOVE every overlay; (A.3) the verified-Owner identity chip carries a "Sample identity"
//     qualifier in tour mode (and NOT on the genuine console). All strictly behind isTourMode.
{
  const gLoc = globalThis as unknown as Record<string, unknown>;
  const savedLoc = gLoc.location;
  gLoc.location = { origin: "https://tour.downpipes.io", hostname: "tour.downpipes.io", search: "", href: "https://tour.downpipes.io/", pathname: "/" };

  // A.1 the title prefix: the exact expression the shell's setTitle uses (isTourMode -> "(Demo) " prefix).
  ok("in tour mode the tab title is prefixed with '(Demo) ' (never identical to the real console, even in a crop)", (isTourMode() ? `(Demo) Overview - downpipes console` : `Overview - downpipes console`).startsWith("(Demo) "));

  // A.2 the screenshot-robust corner marker: fixed top-right, ABOVE modals/toasts/palette/tooltips, pointer-
  // transparent, role=note, "DEMO" text, so it survives any open overlay and most crops.
  removeTourCornerMarker();
  const corner = installTourCornerMarker();
  ok("a screenshot-robust corner DEMO marker is pinned top-right, pointer-transparent, role=note", corner !== null && (corner?.textContent ?? "").includes("DEMO") && corner?.getAttribute("role") === "note" && corner?.style.getPropertyValue("position") === "fixed" && corner?.style.getPropertyValue("top") === "var(--space-3)" && corner?.style.getPropertyValue("right") === "var(--space-3)" && corner?.style.getPropertyValue("pointer-events") === "none");
  ok("the corner marker sits ABOVE modals/toasts/palette/tooltips, so it survives any open overlay (impersonation hardening)", corner?.style.getPropertyValue("z-index") === "calc(var(--z-tooltip) + 1)");
  removeTourCornerMarker();

  // A.3 the ALWAYS-VISIBLE way back to the marketing site: a real anchor pinned directly below the DEMO
  // marker at the same above-everything z-index (the bidirectional-funnel counterpart of the site's own
  // Live-tour header button). It must be interactive (pointer-events auto, unlike the marker), open in a
  // new tab so the visitor's place in the tour is never lost, and carry the counted ?src= convention.
  removeTourSiteLink();
  const siteLink = installTourSiteLink();
  ok("an always-visible downpipes.io link is pinned below the DEMO marker (fixed, top-right, interactive)", siteLink !== null && siteLink?.tagName === "A" && (siteLink?.textContent ?? "").includes("downpipes.io") && siteLink?.style.getPropertyValue("position") === "fixed" && siteLink?.style.getPropertyValue("right") === "var(--space-3)" && siteLink?.style.getPropertyValue("pointer-events") === "auto");
  ok("the site link survives any open overlay (same above-everything layer as the DEMO marker)", siteLink?.style.getPropertyValue("z-index") === "calc(var(--z-tooltip) + 1)");
  ok("the site link opens the marketing site in a new tab with the counted src tag", (siteLink?.getAttribute("href") ?? "").startsWith("https://downpipes.io/?src=tour-chrome") && siteLink?.getAttribute("target") === "_blank" && (siteLink?.getAttribute("rel") ?? "").includes("noopener"));
  ok("the site link install is idempotent (a second call returns the existing link)", installTourSiteLink() === siteLink);
  removeTourSiteLink();

  // A.3 the identity chip qualifier: the verified-Owner account chip carries "Sample identity" in tour mode; NOT
  // on the genuine console (the real chip is unchanged). renderAccount over a verified owner caller.
  const owner = { method: "access" as const, email: who.email, role: "owner" as const, groups: who.groups, isOnlyOwner: false };
  const slot = document.createElement("div");
  renderAccount(slot, owner, true, () => {});
  ok("in tour mode the verified-Owner identity chip carries a 'Sample identity' demo qualifier (the green verified state reads as a demo)", (slot.querySelector('[data-tour-identity-demo]') as { textContent?: string } | null)?.textContent === "Sample identity");
  gLoc.location = { origin: "https://console.downpipes.io", hostname: "console.downpipes.io", search: "" };
  const realSlot = document.createElement("div");
  renderAccount(realSlot, owner, true, () => {});
  ok("on the genuine console (non-tour) the identity chip carries NO demo qualifier (the real chip's behaviour is unchanged)", realSlot.querySelector('[data-tour-identity-demo]') === null);

  gLoc.location = savedLoc;
}

// installDemoFetch returns the real fetch (the restore handle) and is the single fetch-swap seam.
{
  const saved = globalThis.fetch;
  const returned = installDemoFetch();
  ok("installDemoFetch returns the real fetch as a restore handle", returned === saved);
  globalThis.fetch = saved;
}

// 4d. The tour director + the beat chrome (the BEAT model): the self-driving controller over a
//     typed CHAPTER script whose infoPoints are the chapter's BEATS, walked in order. The rail
//     (tour/nav-bar.ts) narrates the current beat (step position, title, body, try-it invitation) while the
//     ONE spotlight stage (tour/spotlight.ts) dims the console around the beat's anchor; the old "?" marker
//     layer is retired (tour/info-point.ts is gone) and must never mount. Lock the load-bearing behaviour:
//     the director navigates the SPA router per chapter, presents each beat through setBeat + setChapters +
//     the spotlight, advances ONE BEAT on Next (crossing chapters past the last beat), re-enters the PRIOR
//     chapter at its LAST beat on Back (over a re-seeded world), offers only the controls that do something
//     at the current position (never a Tips toggle), narrates through the polite live region, holds on the
//     finale with no Next/Play, and Exit -> Resume drops then restores the guide (free-explore). Driven
//     headless with an injected navigate + reseed + a SPY spotlight (deps.mountSpot) against a pre-rendered
//     #main carrying the page header + the beats' anchors.
{
  // The chapter screens the director walks render their page header (the readiness signal awaitScreen waits
  // for) and the components the beats anchor to (the data-tour-id anchors). Stand up a #main with a page
  // header + two anchors so awaitScreen resolves synchronously and the spotlight has real targets to aim at.
  const main = document.createElement("main");
  main.id = "main";
  const headerEl = document.createElement("h1");
  headerEl.className = "page-header__title";
  headerEl.textContent = "Overview";
  const anchorA = document.createElement("div");
  anchorA.setAttribute("data-tour-id", "overview-no-custody");
  const anchorB = document.createElement("div");
  anchorB.setAttribute("data-tour-id", "overview-fleet-health");
  main.appendChild(headerEl);
  main.appendChild(anchorA);
  main.appendChild(anchorB);
  document.body.appendChild(main);

  const navs: string[] = [];
  let reseeds = 0;
  // The spotlight SPY: records every aim (anchor id + pulse) and every mount/teardown the director drives, so
  // the beat-to-spotlight sync is observable without a real stage.
  const spotCalls: Array<{ id: string | null; pulse: boolean }> = [];
  let spotMounts = 0;
  let spotDestroys = 0;
  const mountSpotSpy = (): Spotlight => {
    spotMounts++;
    return {
      target(id: string | null, opts?: { pulse?: boolean }): void { spotCalls.push({ id, pulse: opts?.pulse === true }); },
      root: document.createElement("div") as unknown as HTMLElement,
      destroy(): void { spotDestroys++; },
    };
  };
  const lastSpot = (): { id: string | null; pulse: boolean } | undefined => spotCalls[spotCalls.length - 1];
  // A three-chapter script: the FIRST with two beats (within-chapter Next/Back is exercised), the second with
  // one (a chapter crossing is exercised), and a last chapter with NO beats + a CTA (the funnel-close shape),
  // so the "holds with no Next at the very end" property is exercised.
  const script: TourChapter[] = [
    { route: "/", title: "Overview", infoPoints: [{ anchor: "overview-no-custody", title: "No custody", body: "The key never leaves your browser." }, { anchor: "overview-fleet-health", title: "Fleet health", body: "The honest cover read." }] },
    { route: "/sources", title: "Sources", infoPoints: [{ anchor: "overview-no-custody", title: "Sources breadth", body: "Nine source types." }] },
    { route: "/reports", title: "Reports", infoPoints: [], ctas: [{ label: "Read the docs", href: "https://docs.downpipes.io/start-here", kind: "deploy", primary: true }] },
  ];
  const director = createTourDirector(script, { navigate: (to) => navs.push(to), reseed: () => { reseeds++; }, mountSpot: mountSpotSpy });

  // Small readers over the rail's beat block (the story's always-visible home).
  const bar = (): HTMLElement | null => document.getElementById("tour-nav-bar") as HTMLElement | null;
  const beatBlockDisplay = (): string => (bar()?.querySelector('[data-tour-beat-block]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("display") ?? "";
  const beatMeta = (): string => bar()?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
  const beatTitle = (): string => bar()?.querySelector('[data-tour-beat-title]')?.textContent ?? "";
  const beatBody = (): string => bar()?.querySelector('[data-tour-beat-body]')?.textContent ?? "";
  const tryIt = (): { text: string; display: string } => {
    const el = bar()?.querySelector('[data-tour-try-it]') as { textContent?: string; style: { getPropertyValue(p: string): string } } | null;
    return { text: el?.textContent ?? "", display: el?.style.getPropertyValue("display") ?? "" };
  };
  const liveText = (): string => bar()?.querySelector('[role="status"]')?.textContent ?? "";

  director.start();
  await flushAsync(3);
  ok("the director re-seeds the deterministic world on start", reseeds === 1);
  ok("the director navigates the SPA router to the chapter route and lands on chapter 0", director.index === 0 && navs[navs.length - 1] === "/");

  // NO scrim, NO step bubble, and NO retired "?" marker layer: the beat model narrates in the rail and points
  // with the one spotlight stage. A regression that re-introduces any of the old chrome is caught here.
  ok("the director creates NO dim-scrim overlay and NO step bubble (the real page stays fully visible)", document.getElementById("tour-overlay") === null && document.querySelector('[data-tour-ring]') === null && document.querySelector('[data-tour-cursor]') === null);
  ok("the retired '?' info-point layer never mounts (the rail narrates every beat instead)", document.getElementById("tour-info-layer") === null && document.querySelector('[data-tour-info-marker]') === null);

  // The nav-bar mounts as the RIGHT RAIL at desktop width (>= 1024, the shim default): the body class shifts
  // the console clear of the docked column, the bar docks right at 344px, and it stays pointer-interactive.
  const navBar = bar();
  ok("the director mounts the nav-bar", navBar !== null);
  {
    const styled = navBar as { style: { getPropertyValue(p: string): string } } | null;
    ok("at desktop width the bar is the docked right RAIL (body dp-tour-rail; fixed; right-docked; 344px; pointer-events:auto)", document.body.classList.contains("dp-tour-rail") && styled?.style.getPropertyValue("position") === "fixed" && styled?.style.getPropertyValue("left") === "auto" && styled?.style.getPropertyValue("transform") === "none" && styled?.style.getPropertyValue("right") === "var(--space-4)" && styled?.style.getPropertyValue("width") === "344px" && styled?.style.getPropertyValue("pointer-events") === "auto");
  }
  ok("the nav-bar shows the chapter title + the short 'N of total' progress", (navBar?.textContent ?? "").includes("Overview") && (navBar?.textContent ?? "").includes("1 of 3"));
  ok("the nav-bar carries a polite ARIA live region announcing each beat", navBar?.querySelector('[role="status"]')?.getAttribute("aria-live") === "polite");
  // The OBVIOUS segmented progress bar: one segment per chapter (role=progressbar), with exactly the reached
  // ones filled, so the position reads even at chapter 1 (the first segment is filled).
  {
    const segWrap = navBar?.querySelector('[data-tour-progress-segments]') as { getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<unknown> } | null;
    const segs = (segWrap?.querySelectorAll('[data-tour-segment]') ?? []) as ArrayLike<{ getAttribute(n: string): string | null }>;
    ok("the nav-bar renders a segmented progress bar with one segment per chapter (role=progressbar)", segWrap?.getAttribute("role") === "progressbar" && segs.length === 3 && segWrap?.getAttribute("aria-valuenow") === "1" && segWrap?.getAttribute("aria-valuemax") === "3");
    let filled = 0;
    for (let i = 0; i < segs.length; i++) if (segs[i]!.getAttribute("data-tour-segment") === "done") filled++;
    ok("at chapter 1 exactly the first segment is filled (the progress reads from the start)", filled === 1);
  }
  // The rail's chapter index (the quiet table of contents): one row per chapter, the current one highlighted.
  {
    const list = navBar?.querySelector('[data-tour-chapter-list]') as { style: { getPropertyValue(p: string): string }; querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null }> } | null;
    const rows = (list?.querySelectorAll('[data-tour-chapter-row]') ?? []) as ArrayLike<{ getAttribute(n: string): string | null }>;
    ok("the rail shows the chapter index with one row per chapter", list?.style.getPropertyValue("display") === "flex" && rows.length === 3);
    ok("the current chapter row is highlighted (aria-current=step) and the rest read to-come", rows[0]?.getAttribute("data-tour-chapter-row") === "current" && rows[0]?.getAttribute("aria-current") === "step" && rows[1]?.getAttribute("data-tour-chapter-row") === "todo" && rows[2]?.getAttribute("data-tour-chapter-row") === "todo");
  }

  // The BEAT narration: the rail's reading block carries the first beat's step position, title and body, the
  // spotlight is aimed at its anchor (no pulse on a plain beat), and the live region announces the ACTUAL
  // narration, so assistive tech hears the story rather than a hint to go hunting.
  ok("the rail narrates the FIRST beat: step position, title and body", beatBlockDisplay() === "flex" && beatMeta() === "Step 1 of 2" && beatTitle() === "No custody" && beatBody().includes("never leaves your browser"));
  ok("a plain beat shows no try-it invitation", tryIt().display === "none");
  ok("the spotlight is aimed at the first beat's anchor, without the try-it pulse", lastSpot()?.id === "overview-no-custody" && lastSpot()?.pulse === false);
  ok("the polite live region announces the beat's ACTUAL narration (title + body)", liveText().includes("No custody. The key never leaves your browser."));

  // Controls per position: on the very first beat there is nowhere back to go, so no Back; Next is the primary
  // forward action; autoplay is opt-in (Play, default paused); Exit is always offered; and there is NO Tips
  // toggle anywhere (the marker toggle is retired with the markers).
  {
    const playToggle = navBar?.querySelector('[data-tour-toggle="play"]') as { getAttribute(n: string): string | null } | null;
    ok("autoplay is opt-in: the nav-bar starts on the Play toggle (default paused)", playToggle !== null && playToggle?.getAttribute("aria-pressed") === "false");
    ok("the first beat offers no Back (nowhere back to go), Next + Exit are offered", navBar?.querySelector('[data-tour-back-slot] [aria-label="Back"]') === null && navBar?.querySelector('[data-tour-action="next"]') !== null && navBar?.querySelector('[data-tour-action="exit"]') !== null);
    ok("no Tips toggle is offered anywhere (the rail always narrates; toggleInfo is retired)", navBar?.querySelector('[data-tour-toggle="info"]') === null);
  }

  // Keyboard: ArrowRight advances ONE BEAT within the chapter (no navigation; the chapter holds).
  dispatchDocKey(keydown({ key: "ArrowRight" }));
  await flushAsync(3);
  ok("ArrowRight advances ONE BEAT within the chapter (no navigation, the chapter holds)", director.index === 0 && beatMeta() === "Step 2 of 2" && beatTitle() === "Fleet health" && navs.length === 1);
  ok("the spotlight morphs to the new beat's anchor", lastSpot()?.id === "overview-fleet-health");
  ok("Back is offered from the second beat of the first chapter (there is now somewhere back to go)", bar()?.querySelector('[data-tour-back-slot] [aria-label="Back"]') !== null);

  // Past the last beat, Next crosses into the next chapter and navigates.
  dispatchDocKey(keydown({ key: "ArrowRight" }));
  await flushAsync(3);
  ok("past the last beat, Next crosses into the next chapter and navigates", director.index === 1 && navs[navs.length - 1] === "/sources");
  ok("the nav-bar updates to the new chapter title + progress and enters at its first beat", (bar()?.textContent ?? "").includes("Sources") && (bar()?.textContent ?? "").includes("2 of 3") && beatTitle() === "Sources breadth");
  ok("a single-beat chapter shows NO step counter (a count of one reads as noise)", beatMeta() === "");
  {
    const segs = (bar()?.querySelector('[data-tour-progress-segments]')?.querySelectorAll('[data-tour-segment="done"]') ?? []) as ArrayLike<unknown>;
    ok("the segmented progress bar advances (two segments filled at chapter 2)", segs.length === 2);
    const rows = (bar()?.querySelectorAll('[data-tour-chapter-row]') ?? []) as ArrayLike<{ getAttribute(n: string): string | null }>;
    ok("the chapter index ticks the walked chapter done and highlights the new one", rows[0]?.getAttribute("data-tour-chapter-row") === "done" && rows[1]?.getAttribute("data-tour-chapter-row") === "current");
  }

  // Back across a chapter boundary re-seeds the deterministic world and re-enters the PRIOR chapter at its
  // LAST beat, so the walk reverses beat-perfectly rather than restarting the chapter.
  const reseedsBeforeBack = reseeds;
  dispatchDocKey(keydown({ key: "ArrowLeft" }));
  await flushAsync(3);
  ok("Back from a chapter's first beat re-seeds the world and re-enters the PRIOR chapter at its LAST beat", director.index === 0 && reseeds === reseedsBeforeBack + 1 && navs[navs.length - 1] === "/" && beatMeta() === "Step 2 of 2" && beatTitle() === "Fleet health");
  // Back within a chapter steps ONE BEAT, with no re-seed and no navigation (a cheap, exact rewind).
  director.back();
  await flushAsync(2);
  ok("Back within a chapter steps ONE BEAT with no re-seed and no navigation", director.index === 0 && beatMeta() === "Step 1 of 2" && reseeds === reseedsBeforeBack + 1 && navs[navs.length - 1] === "/");
  // From the very first beat there is nowhere back to go.
  director.back();
  await flushAsync(2);
  ok("Back from the very first beat is a no-op (nowhere back to go)", director.index === 0 && beatMeta() === "Step 1 of 2" && reseeds === reseedsBeforeBack + 1);

  // toggleInfo is RETIRED by the beat model: the verb stays on the interface as a benign no-op so an old deep
  // integration cannot throw, and it must change nothing.
  {
    const titleBefore = beatTitle();
    director.toggleInfo();
    director.toggleInfo();
    await flushAsync(1);
    ok("toggleInfo() is a benign no-op (the retired verb changes nothing and never throws)", director.index === 0 && beatTitle() === titleBefore && bar() !== null && bar()?.querySelector('[data-tour-toggle="info"]') === null);
  }

  // Walk to the finale: a chapter with NO beats (the funnel close). The reading area clears (setBeat null),
  // the spotlight rests (target null), the CTAs carry the message, and the very end offers nothing forward.
  director.next();
  await flushAsync(2);
  director.next();
  await flushAsync(3);
  director.next();
  await flushAsync(3);
  ok("the walk reaches the finale", director.index === 2);
  ok("a chapter with no beats clears the reading area and rests the spotlight (setBeat(null) + target(null))", beatBlockDisplay() === "none" && lastSpot()?.id === null);
  ok("the finale renders its CTA as a real anchor in the rail", bar()?.querySelector('[data-tour-cta-row] a[href="https://docs.downpipes.io/start-here"]') !== null);
  ok("the finale announces the chapter itself (there is no beat narration to carry)", liveText().includes("Reports. Chapter 3 of 3."));
  ok("the very end offers no Next, no Play and no speed cycler (nothing left to walk), while Back and Exit stay", bar()?.querySelector('[data-tour-action="next"]') === null && bar()?.querySelector('[data-tour-toggle="play"]') === null && bar()?.querySelector('[data-tour-action="speed"]') === null && bar()?.querySelector('[data-tour-back-slot] [aria-label="Back"]') !== null && bar()?.querySelector('[data-tour-action="exit"]') !== null);
  director.next();
  ok("Next past the very end is a no-op", director.index === 2);

  // Escape exits to free-explore: the rail AND the spotlight stage tear down (the body rail class drops with
  // them), and the one-tap Resume affordance appears.
  dispatchDocKey(keydown({ key: "Escape" }));
  ok("Escape exits to free-explore (drops the rail + spotlight, releases the body class, shows Resume)", document.getElementById("tour-nav-bar") === null && spotDestroys === 1 && !document.body.classList.contains("dp-tour-rail") && document.getElementById("tour-resume") !== null);
  director.resume();
  await flushAsync(3);
  ok("Resume brings the guide back at the chapter the visitor left, on a FRESH spotlight stage", document.getElementById("tour-nav-bar") !== null && spotMounts === 2 && director.index === 2 && document.getElementById("tour-resume") === null);

  director.destroy();
  main.remove();
  document.getElementById("tour-nav-bar")?.remove();
  document.getElementById("tour-resume")?.remove();

  // The nav-bar control bar is the tour's PRIMARY interaction surface, so lock that a real click on a RENDERED
  // control fires the matching director verb (rendered button -> handler -> director closure -> verb, the path a
  // visitor drives). Driven on the MIDDLE chapter so every offered control renders (Back off the very first
  // beat, Next before the very end, Play/Exit always; the retired Tips toggle NEVER renders). The bar
  // re-renders on each state change, so it is re-queried after every click.
  {
    const cMain = document.createElement("main");
    cMain.id = "main";
    const cHeader = document.createElement("h1");
    cHeader.className = "page-header__title";
    cHeader.textContent = "Chapter";
    cMain.appendChild(cHeader);
    document.body.appendChild(cMain);
    const cNavs: string[] = [];
    let cReseeds = 0;
    // One beat per chapter, so every Next/Back here crosses a chapter boundary (the beat-wise crossing is the
    // primary walk block's job; this block is about the rendered controls firing the verbs).
    const cScript: TourChapter[] = [
      { route: "/", title: "One", infoPoints: [{ anchor: "c-one", title: "One", body: "The first chapter's explanation." }] },
      { route: "/sources", title: "Two", infoPoints: [{ anchor: "c-two", title: "Two", body: "The middle chapter's explanation." }] },
      { route: "/reports", title: "Three", infoPoints: [{ anchor: "c-three", title: "Three", body: "The last chapter's explanation." }] },
    ];
    const cDir = createTourDirector(cScript, { navigate: (to: string) => cNavs.push(to), reseed: () => { cReseeds++; } });
    const ctrl = (label: string): { click(): void; getAttribute(n: string): string | null } | null =>
      (document.getElementById("tour-nav-bar")?.querySelector(`[aria-label="${label}"]`) as { click(): void; getAttribute(n: string): string | null } | null) ?? null;
    cDir.start();
    await flushAsync(3);
    cDir.next(); // advance to the middle chapter, where Back AND Next both render
    await flushAsync(3);
    ok("the rendered nav-bar exposes the offered controls on a middle chapter (Back, Next, Play, Exit; NO Tips)", cDir.index === 1 && ctrl("Back") !== null && ctrl("Next") !== null && ctrl("Play the tour automatically") !== null && (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="info"]') ?? null) === null && ctrl("Exit the tour and explore freely") !== null);

    // The autoplay toggle: clicking Play fires play() (the toggle flips to Pause + announces). announce() defers
    // the textContent set by a task, so flush before reading the live region.
    const cLive = (): string => (document.getElementById("tour-nav-bar")?.querySelector('[role="status"]')?.textContent ?? "");
    const speedCtl = (): Element | null => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-action="speed"]') ?? null;
    ok("the autoplay-speed cycler is hidden while paused (its pace meaning reads only beside Pause)", speedCtl() === null);
    ctrl("Play the tour automatically")?.click();
    await flushAsync(3);
    ok("clicking the rendered Play control fires play (the toggle flips to Pause)", ctrl("Pause autoplay") !== null && ctrl("Play the tour automatically") === null);
    ok("starting guided autoplay announces it through the polite live region", cLive().includes("Guided tour playing"));
    ok("the autoplay-speed cycler renders only while playing (present beside Pause)", speedCtl() !== null);
    ctrl("Pause autoplay")?.click();
    await flushAsync(3);
    ok("clicking the rendered Pause control fires pause (the toggle flips back to Play)", ctrl("Play the tour automatically") !== null && ctrl("Pause autoplay") === null);
    ok("pausing autoplay announces the return to manual through the polite live region", cLive().includes("Tour paused"));
    ok("pausing hides the autoplay-speed cycler again", speedCtl() === null);

    // Click the rendered Next: advance to the last chapter and navigate there.
    const navsBeforeNext = cNavs.length;
    ctrl("Next")?.click();
    await flushAsync(3);
    ok("clicking the rendered Next control fires next (advances a chapter and navigates)", cDir.index === 2 && cNavs.length > navsBeforeNext && cNavs[cNavs.length - 1] === "/reports");

    // Click the rendered Back (still present on the last chapter): re-seed and step back.
    const reseedsBeforeBack2 = cReseeds;
    ctrl("Back")?.click();
    await flushAsync(3);
    ok("clicking the rendered Back control fires back (re-seeds and steps back)", cDir.index === 1 && cReseeds === reseedsBeforeBack2 + 1);

    // Click the rendered Exit: drop the guide to free-explore and show the Resume button.
    ctrl("Exit the tour and explore freely")?.click();
    ok("clicking the rendered Exit control fires exit (drops the guide, shows Resume)", document.getElementById("tour-nav-bar") === null && document.getElementById("tour-resume") !== null);

    // Click the actual Resume button (not the resume() verb): its handler fires resume() -> the guide returns.
    (document.getElementById("tour-resume") as { click(): void } | null)?.click();
    await flushAsync(3);
    ok("clicking the rendered Resume button fires resume (the guide returns and Resume is removed)", document.getElementById("tour-nav-bar") !== null && document.getElementById("tour-resume") === null);

    cDir.destroy();
    cMain.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
    document.getElementById("tour-resume")?.remove();
  }

  // The nav-bar + the spotlight stage are independently constructable (the director is one consumer); a bare
  // mount + destroy is clean.
  const soloNav = mountNavBar();
  ok("the nav-bar is independently mountable and tears down cleanly", document.getElementById("tour-nav-bar") !== null);
  soloNav.destroy();
  ok("the nav-bar destroy removes its root", document.getElementById("tour-nav-bar") === null);
  const soloSpot = createSpotlight();
  ok("the spotlight stage is independently mountable and tears down cleanly", document.getElementById("tour-spotlight") !== null);
  soloSpot.destroy();
  ok("the spotlight destroy removes its root", document.getElementById("tour-spotlight") === null);

  // The REAL spotlight stage under the default director wiring (no injected mountSpot): one #tour-spotlight
  // "hole" whose enormous box-shadow paints the dim, tracking the beat's anchor on a rAF loop and torn down
  // with the guide. Driven with a fake rAF (the shim has none) + a measurable anchor rect so the padded box
  // maths are observable, and an anchor that stops laying out hides the stage rather than pointing at nothing.
  {
    const gAny = globalThis as unknown as Record<string, unknown>;
    const savedRaf = gAny.requestAnimationFrame;
    const savedCaf = gAny.cancelAnimationFrame;
    let pendingFrames: Array<() => void> = [];
    Object.defineProperty(gAny, "requestAnimationFrame", { value: (cb: () => void): number => { pendingFrames.push(cb); return pendingFrames.length; }, configurable: true, writable: true });
    Object.defineProperty(gAny, "cancelAnimationFrame", { value: (): void => { pendingFrames = []; }, configurable: true, writable: true });
    const runFrame = (): void => { const cbs = pendingFrames; pendingFrames = []; for (const cb of cbs) cb(); };

    const sMain = document.createElement("main");
    sMain.id = "main";
    const sHeader = document.createElement("h1");
    sHeader.className = "page-header__title";
    sHeader.textContent = "Spot";
    const sAnchor = document.createElement("div");
    sAnchor.setAttribute("data-tour-id", "spot-real");
    let sRect = { top: 200, left: 300, width: 120, height: 22, right: 420, bottom: 222 };
    (sAnchor as unknown as { getBoundingClientRect: () => typeof sRect }).getBoundingClientRect = () => sRect;
    sMain.appendChild(sHeader);
    sMain.appendChild(sAnchor);
    document.body.appendChild(sMain);
    const dSpot = createTourDirector([{ route: "/", title: "Spot", infoPoints: [{ anchor: "spot-real", title: "Real", body: "The stage follows this component." }] }], { navigate: () => {}, reseed: () => {} });
    dSpot.start();
    await flushAsync(3);
    const hole = document.getElementById("tour-spotlight") as { getAttribute(n: string): string | null; style: { getPropertyValue(p: string): string } } | null;
    ok("the default director mounts the real spotlight stage: aria-hidden, fixed, pointer-transparent (paint, never a hit target)", hole !== null && hole?.getAttribute("aria-hidden") === "true" && hole?.style.getPropertyValue("position") === "fixed" && hole?.style.getPropertyValue("pointer-events") === "none");
    runFrame();
    ok("the spotlight cuts out the beat's anchor with breathing room (the 10px-padded box paints and shows)", hole?.style.getPropertyValue("top") === "190px" && hole?.style.getPropertyValue("left") === "290px" && hole?.style.getPropertyValue("width") === "140px" && hole?.style.getPropertyValue("height") === "42px" && hole?.style.getPropertyValue("opacity") === "1");
    // The anchor vanishes (a section re-renders mid-walk): the stage hides for the tick rather than pointing at
    // nothing, and re-appears the moment the anchor lays out again (the loop keeps watching).
    sRect = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
    runFrame();
    ok("an anchor that stops laying out hides the spotlight for the tick (no stray cutout)", hole?.style.getPropertyValue("opacity") === "0");
    sRect = { top: 200, left: 300, width: 120, height: 22, right: 420, bottom: 222 };
    runFrame();
    ok("the spotlight re-appears the moment the anchor lays out again", hole?.style.getPropertyValue("opacity") === "1");
    dSpot.exit();
    ok("Exit tears the spotlight stage out with the guide", document.getElementById("tour-spotlight") === null);
    dSpot.destroy();
    sMain.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-resume")?.remove();
    if (savedRaf === undefined) delete gAny.requestAnimationFrame; else Object.defineProperty(gAny, "requestAnimationFrame", { value: savedRaf, configurable: true, writable: true });
    if (savedCaf === undefined) delete gAny.cancelAnimationFrame; else Object.defineProperty(gAny, "cancelAnimationFrame", { value: savedCaf, configurable: true, writable: true });
  }

  // DEFAULT MANUAL: a fresh tour does NOT auto-advance on its own. With autoplay never started, the chapter
  // never changes by itself even after a generous wait, and no dwell bar is shown. The visitor drives.
  {
    const mMain = document.createElement("main");
    mMain.id = "main";
    const mHeader = document.createElement("h1");
    mHeader.className = "page-header__title";
    mHeader.textContent = "One";
    mMain.appendChild(mHeader);
    document.body.appendChild(mMain);
    const mScript: TourChapter[] = [
      { route: "/", title: "One", infoPoints: [] },
      { route: "/sources", title: "Two", infoPoints: [] },
    ];
    const mDir = createTourDirector(mScript, { navigate: () => {}, reseed: () => {} });
    mDir.start();
    await flushAsync(3);
    ok("a fresh tour starts on chapter 0 and the autoplay toggle reads Play (manual by default)", mDir.index === 0 && (document.getElementById("tour-nav-bar")?.querySelector('[data-tour-toggle="play"]') as { getAttribute(n: string): string | null } | null)?.getAttribute("aria-pressed") === "false");
    // Wait out a long real-time beat: a default-manual tour must NOT auto-advance.
    await new Promise((r) => setTimeout(r, 200));
    await flushAsync(3);
    ok("a default-manual tour does NOT auto-advance by itself (it stays on chapter 0)", mDir.index === 0);
    // Idle observable: the FILL sits at 0% (variant-agnostic). The rail keeps the empty track's box
    // visible so autoplay starting never shifts the layout; the bottom bar still display-hides it.
    const dwellFillIdle = document.getElementById("tour-nav-bar")?.querySelector('[data-tour-dwell-fill]') as { style: { getPropertyValue(p: string): string } } | null;
    ok("the per-step dwell bar is idle while manual (fill at 0%, no autoplay timing running)", (dwellFillIdle?.style.getPropertyValue("width") ?? "0%") === "0%");
    mDir.destroy();
    mMain.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
  }

  // GUIDED AUTOPLAY over BEATS: Play arms a per-beat dwell (the dwell bar is the visible timing indicator),
  // advances beat by beat, crosses chapters past the last beat, performs a try-it beat's REAL click ITSELF at
  // the end of its dwell (the console visibly responds, then the interact observer advances the walk), and
  // stops back to manual at the very end. Pause mid-dwell returns to manual at once. Driven with FAST injected
  // timing (production dwells are 6-15s); the ~900ms try-it response beat is the director's own constant.
  {
    const gMain = document.createElement("main");
    gMain.id = "main";
    const gHeader = document.createElement("h1");
    gHeader.className = "page-header__title";
    gHeader.textContent = "Guided";
    // The try-it beat's REAL control: a button whose click() RECORDS the press and then propagates a
    // document-level click exactly as a browser click would, so the director's capture-phase observer sees it.
    let flyClicks = 0;
    const flyEl = document.createElement("button");
    flyEl.setAttribute("data-tour-id", "guided-fly");
    (flyEl as unknown as { click: () => void }).click = () => {
      flyClicks++;
      const ev = makeEvent({ type: "click", bubbles: true, cancelable: true });
      ev.target = flyEl as unknown as typeof ev.target;
      dispatchDocKey(ev);
    };
    gMain.appendChild(gHeader);
    gMain.appendChild(flyEl);
    document.body.appendChild(gMain);
    const gScript: TourChapter[] = [
      { route: "/", title: "Guided", infoPoints: [
        { anchor: "guided-a", title: "First beat", body: "The first explanation the guided walk narrates." },
        { anchor: "guided-fly", title: "Try it", body: "Autoplay presses the real control for you.", interact: { label: "fly one now" } },
      ] },
      { route: "/sources", title: "Close", infoPoints: [] },
    ];
    const gDir = createTourDirector(gScript, { navigate: () => {}, reseed: () => {}, dwellMs: (): number => 250, stepGapMs: 30, settleMs: 10 });
    const gBar = (): HTMLElement | null => document.getElementById("tour-nav-bar") as HTMLElement | null;
    const gMeta = (): string => gBar()?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
    const gTry = (): string => (gBar()?.querySelector('[data-tour-try-it]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("display") ?? "";
    const gDwell = (): string => (gBar()?.querySelector('[data-tour-dwell-track]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("display") ?? "";
    // Idle-ness reads from the FILL (0% = no autoplay timing), variant-agnostic: the rail keeps the
    // empty track's box so Play never shifts the layout; only the bottom bar display-hides it.
    const gFill = (): string => (gBar()?.querySelector('[data-tour-dwell-fill]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("width") ?? "";
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    gDir.start();
    await flushAsync(3);
    await sleep(120);
    await flushAsync(2);
    ok("default manual: the walk holds on the first beat with the dwell idle (nothing advances on its own)", gDir.index === 0 && gMeta() === "Step 1 of 2" && gFill() === "0%");
    gDir.play();
    await sleep(80);
    await flushAsync(2);
    ok("Play arms the current beat's dwell: the dwell bar appears (the visible timing indicator)", gDwell() === "block");
    // Pause mid-dwell returns to manual at once: the dwell bar hides and the walk holds.
    gDir.pause();
    await flushAsync(2);
    ok("Pause mid-dwell returns to manual (the dwell resets to idle, the walk holds on the same beat)", gFill() === "0%" && gMeta() === "Step 1 of 2");
    // Play again: the walk advances beat by beat on its own.
    gDir.play();
    await sleep(400); // past the first dwell (250) + gap (30): the try-it beat presents
    await flushAsync(2);
    ok("after the dwell the guided walk advances ONE BEAT on its own (the try-it beat presents its invitation)", gDir.index === 0 && gMeta() === "Step 2 of 2" && gTry() === "inline-flex");
    await sleep(320); // past the try-it beat's dwell: autoplay performs the REAL click itself
    await flushAsync(2);
    ok("at the end of a try-it beat's dwell autoplay clicks the REAL control itself (the walk waits for the response)", flyClicks === 1 && gDir.index === 0);
    await sleep(1050); // the ~900ms response beat: the interact observer advances the walk
    await flushAsync(4);
    ok("the try-it click advances the walk across the chapter boundary (the observer drives it, not a second dwell)", gDir.index === 1);
    // The finale has no beats: after its empty dwell the guided walk STOPS back to manual at the very end.
    await sleep(450);
    await flushAsync(3);
    ok("on the last chapter the guided walk stops back to manual (no Play control remains at the very end; the dwell is idle)", (gBar()?.querySelector('[data-tour-toggle="play"]') ?? null) === null && gFill() === "0%");
    gDir.destroy();
    gMain.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
  }

  // TRY-IT beats, the MANUAL path: a beat with `interact` arms a capture-phase observer on the beat's REAL
  // control (the spotlight pulses the invitation); the walk advances only after the visitor GENUINELY clicks
  // it, a response beat (~900ms) later, so the console visibly reacts first. A click anywhere else never
  // counts. The document-level click is driven through the shim's document dispatcher exactly as the keyboard
  // layer's keys are.
  {
    const tMain = document.createElement("main");
    tMain.id = "main";
    const tHeader = document.createElement("h1");
    tHeader.className = "page-header__title";
    tHeader.textContent = "Try";
    const tAnchor = document.createElement("button");
    tAnchor.setAttribute("data-tour-id", "try-a");
    tMain.appendChild(tHeader);
    tMain.appendChild(tAnchor);
    document.body.appendChild(tMain);
    const tSpotCalls: Array<{ id: string | null; pulse: boolean }> = [];
    const tScript: TourChapter[] = [
      { route: "/", title: "Try", infoPoints: [
        { anchor: "try-a", title: "Try it", body: "Press the real control.", interact: { label: "press the control" } },
        { anchor: "try-a", title: "Aftermath", body: "What just happened." },
      ] },
    ];
    const tDir = createTourDirector(tScript, {
      navigate: () => {},
      reseed: () => {},
      mountSpot: (): Spotlight => ({
        target(id: string | null, opts?: { pulse?: boolean }): void { tSpotCalls.push({ id, pulse: opts?.pulse === true }); },
        root: document.createElement("div") as unknown as HTMLElement,
        destroy(): void {},
      }),
    });
    const tBar = (): HTMLElement | null => document.getElementById("tour-nav-bar") as HTMLElement | null;
    const tMeta = (): string => tBar()?.querySelector('[data-tour-beat-meta]')?.textContent ?? "";
    const tTry = (): { text: string; display: string } => {
      const el = tBar()?.querySelector('[data-tour-try-it]') as { textContent?: string; style: { getPropertyValue(p: string): string } } | null;
      return { text: el?.textContent ?? "", display: el?.style.getPropertyValue("display") ?? "" };
    };
    tDir.start();
    await flushAsync(3);
    ok("a try-it beat shows the invitation in the rail and pulses the spotlight on the real control", tTry().text === "Try it: press the control" && tTry().display === "inline-flex" && tSpotCalls[tSpotCalls.length - 1]?.id === "try-a" && tSpotCalls[tSpotCalls.length - 1]?.pulse === true);
    // A click ANYWHERE ELSE is not the invited interaction: the observer ignores it.
    const missEv = makeEvent({ type: "click", bubbles: true, cancelable: true });
    missEv.target = tHeader as unknown as typeof missEv.target;
    dispatchDocKey(missEv);
    await flushAsync(2);
    ok("a click elsewhere on the page does not count as the try-it interaction", tMeta() === "Step 1 of 2");
    // The REAL click: the walk does NOT advance at the instant of the click (the console responds first),
    // then advances after the ~900ms response beat.
    const hitEv = makeEvent({ type: "click", bubbles: true, cancelable: true });
    hitEv.target = tAnchor as unknown as typeof hitEv.target;
    dispatchDocKey(hitEv);
    await flushAsync(2);
    ok("the walk does not advance at the instant of the real click (the console's own response shows first)", tMeta() === "Step 1 of 2");
    await new Promise((r) => setTimeout(r, 1050));
    await flushAsync(3);
    ok("after the response beat the REAL click advances the walk to the next beat", tMeta() === "Step 2 of 2" && tBar()?.querySelector('[data-tour-beat-title]')?.textContent === "Aftermath");
    tDir.destroy();
    tMain.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-resume")?.remove();
  }

  // The floating honesty pill and the guide's nav-bar both dock bottom-centre, so the director HIDES the pill
  // (display only, never removed) while the guide is mounted; the top-right DEMO corner pill keeps the honesty
  // label the whole time; Exit restores the pill for free-explore.
  {
    const bMain = document.createElement("main");
    bMain.id = "main";
    const bHeader = document.createElement("h1");
    bHeader.className = "page-header__title";
    bHeader.textContent = "One";
    bMain.appendChild(bHeader);
    document.body.appendChild(bMain);
    removeTourBanner();
    const pill = installTourBanner();
    const bDir = createTourDirector([{ route: "/", title: "One", infoPoints: [] }], { navigate: () => {}, reseed: () => {} });
    bDir.start();
    await flushAsync(3);
    ok("the guided walk hides the floating demo pill while its nav-bar holds the bottom band (display-toggled, not removed)", pill !== null && pill?.style.getPropertyValue("display") === "none" && document.getElementById("tour-demo-banner") !== null);
    bDir.exit();
    ok("Exit restores the floating demo pill for free-explore", pill?.style.getPropertyValue("display") === "flex");
    bDir.destroy();
    removeTourBanner();
    bMain.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
    document.getElementById("tour-resume")?.remove();
  }
}

// 4e. The two curated CHAPTER scripts + the welcome card. The CTO script (ten
//     chapters: assurance, governance and ecosystem fit) and the Engineer script (ten chapters: operate,
//     recover and wire into your tooling) each walk the REAL console pages; both bookend Overview/no-custody and
//     the funnel, and TOUR_SCRIPTS maps each persona to its walk. The welcome card is the tour's first
//     interaction (a warm greeting whose two persona actions each run a DIFFERENT curated walk over one
//     director). Lock BOTH chapter spines + the welcome's per-persona start/dismiss behaviour, with a SPY
//     director (now built per persona) so no real guide paints and the started script is observable. The welcome
//     is a labelled, non-trapping dialog; Escape / "Free Explore" drop it to free-explore.
{
  // Every chapter navigates a known TourRoute (a renamed route is a build error, not a dead nav). The set is the
  // pinned TOUR_ROUTES (each tied to a live app constant) plus the one route whose constant is private to its
  // screen (reports.ts does not export ROUTE_REPORTS, so /reports is typed in the union but pinned at the
  // 4e-bis live-screen resolution instead, where a renamed route fails loudly).
  const known = new Set<string>([...Object.values(TOUR_ROUTES), "/reports"]);
  ok("every CTO chapter navigates a known TourRoute (a renamed route is caught, not a dead nav)", ctoChapters.every((c) => known.has(c.route)));
  ok("every Engineer chapter navigates a known TourRoute (a renamed route is caught, not a dead nav)", engineerChapters.every((c) => known.has(c.route)));
  ok("the CTO walk and the Engineer walk are ten chapters each", ctoChapters.length === 10 && engineerChapters.length === 10);
  ok("TOUR_SCRIPTS maps cto -> ctoChapters and engineer -> engineerChapters (the launcher reads it per persona)", TOUR_SCRIPTS.cto === ctoChapters && TOUR_SCRIPTS.engineer === engineerChapters);
  // Both curated walks open on Overview then Sources (the shared opening) and close on the funnel (two CTAs, no
  // info-points, naming the free Community edition); the middle is curated to the reader.
  for (const [name, script] of [["CTO", ctoChapters], ["Engineer", engineerChapters]] as const) {
    ok(`the ${name} walk opens Overview -> Sources with beats on each`, script[0]!.route === "/" && script[0]!.title === "Overview" && script[0]!.infoPoints.length >= 1 && script[1]!.route === "/sources" && script[1]!.title === "Sources" && script[1]!.infoPoints.length >= 1);
    const close = script[script.length - 1]!;
    ok(`the ${name} walk closes on the funnel (two CTAs, no info-points, the free Community edition)`, close.route === "/" && (close.ctas ?? []).length === 2 && close.infoPoints.length === 0 && close.title.includes("Community edition"));
  }
  // Every beat across BOTH walks carries a real anchor + a non-empty title + body (a useful explanation, never a
  // stub), and the copy uses precise claims, never the banned absolute forms. The deduped union is the corpus.
  const allChapters = [...new Set([...ctoChapters, ...engineerChapters])];
  const allPoints: InfoPoint[] = allChapters.flatMap((c) => [...c.infoPoints]);
  ok("every beat names an anchor + carries a non-empty title and body (a real explanation)", allPoints.length >= 1 && allPoints.every((p) => p.anchor !== "" && p.title.length > 0 && p.body.length > 20));
  const allCopy = allPoints.map((p) => `${p.title} ${p.body}`).join(" ").toLowerCase();
  ok("the beat copy uses precise claims, never the banned absolute forms", !allCopy.includes("tamper-proof") && !allCopy.includes("quantum-proof") && !allCopy.includes("100% secure"));
  // The TRY-IT beats live ONLY on the Engineer walk: exactly two, on the canary + the restore proof,
  // each inviting a REAL click of the console's own control (the faked engine makes both safe and reversible); the
  // CTO walk carries none. Pin the anchors + the invitation labels so a renamed hook or a dropped invitation is
  // caught at the data level.
  {
    const engPoints: InfoPoint[] = engineerChapters.flatMap((c) => [...c.infoPoints]);
    const ctoPoints: InfoPoint[] = ctoChapters.flatMap((c) => [...c.infoPoints]);
    ok("exactly two try-it beats carry an interact invitation, both on the Engineer walk (canary fly + restore build)", engPoints.filter((p) => p.interact !== undefined).length === 2);
    ok("the CTO walk carries no try-it beats (its chapters are read, not driven)", ctoPoints.filter((p) => p.interact !== undefined).length === 0);
    ok("the canary try-it beat pins the REAL fly control with its invitation", engineerChapters.find((c) => c.title === "Canary flights")!.infoPoints.some((p) => p.anchor === "canary-fly" && p.interact?.label === "click Fly the canary now"));
    ok("the restore-proof try-it beat pins the REAL build-plan control with its invitation", engineerChapters.find((c) => c.title === "Proof it's recoverable")!.infoPoints.some((p) => p.anchor === "restore-build" && p.interact?.label === "click Build the restore plan"));
  }
  // The shared Overview chapter pins the four components it annotates (no-custody, fleet health, licence,
  // attention); the shared Sources chapter pins its three (add/breadth, protected, catalogue). Both walks share
  // these opening chapters by reference, so pinning them once covers both; a future edit that drops a "?" is caught.
  {
    const overviewAnchors = new Set(ctoChapters[0]!.infoPoints.map((p) => p.anchor));
    ok("the Overview chapter pins the no-custody, fleet-health, licence and attention components", overviewAnchors.has("overview-no-custody") && overviewAnchors.has("overview-fleet-health") && overviewAnchors.has("overview-licence") && overviewAnchors.has("overview-attention"));
    const sourcesAnchors = new Set(ctoChapters[1]!.infoPoints.map((p) => p.anchor));
    ok("the Sources chapter pins the add-source breadth, the protected table and the full catalogue", sourcesAnchors.has("sources-add") && sourcesAnchors.has("sources-protected") && sourcesAnchors.has("sources-catalogue"));
  }

  // The two curated route spines, each pinned in order so a reorder or a dropped chapter is caught. The CTO walk
  // leads with assurance and ecosystem fit (SSO, dual control, change management, evidence, audit, notifications,
  // integrations); the Engineer walk leads with operate-and-recover (the estate, a backup end-to-end, the proof,
  // the failure, the canary, notifications, integrations). Both bookend Overview -> Sources ... -> integrations
  // -> funnel.
  ok("the CTO route spine walks assurance and ecosystem fit in order", JSON.stringify(ctoChapters.map((c) => c.route)) === JSON.stringify(["/", "/sources", "/access/idp", "/restore/approvals", "/reports", "/reports", "/access/audit", "/notifications/rules", "/integrations", "/"]));
  ok("the Engineer route spine walks operate-and-recover in order", JSON.stringify(engineerChapters.map((c) => c.route)) === JSON.stringify(["/", "/sources", "/downpipes", "/runs", "/restore", "/runs", "/canary", "/notifications/rules", "/integrations", "/"]));
  // The chapters each walk must include, by title. The CTO walk carries SSO, the dual-control restore, change
  // management, evidence, the audit log, notifications and integrations; the Engineer walk carries the estate,
  // a backup end-to-end, the recoverability proof, the failure, canary, notifications and integrations.
  const ctoTitles = ctoChapters.map((c) => c.title);
  ok("the CTO walk covers identity providers, dual-control restore, change management, evidence, the audit log, notifications and integrations", ctoTitles.includes("Identity providers") && ctoTitles.includes("Restore under dual control") && ctoTitles.includes("Change management") && ctoTitles.includes("Evidence on demand") && ctoTitles.includes("A tamper-evident audit log") && ctoTitles.includes("Notifications") && ctoTitles.includes("Integrations"));
  const engTitles = engineerChapters.map((c) => c.title);
  ok("the Engineer walk covers the estate, a backup end-to-end, the recoverability proof, the failure, canary, notifications and integrations", engTitles.includes("Downpipes") && engTitles.includes("A backup, end to end") && engTitles.includes("Proof it's recoverable") && engTitles.includes("When it goes wrong") && engTitles.includes("Canary flights") && engTitles.includes("Notifications") && engTitles.includes("Integrations"));
  // The chapters that need a drawer / disclosure / deep-link carry a preAction. On the Engineer walk that is the
  // two run chapters, the restore proof and the canary (four); the CTO walk's chapters land on whole pages and
  // carry none.
  ok("the Engineer run + restore-proof chapters carry a preAction, and the canary chapter needs none (its beats anchor on the always-present hero controls)", engineerChapters.filter((c) => typeof c.preAction === "function").length >= 3 && typeof engineerChapters.find((c) => c.title === "A backup, end to end")!.preAction === "function" && engineerChapters.find((c) => c.title === "Canary flights")!.preAction === undefined);
  ok("the CTO walk's chapters land on whole pages and carry no preAction", ctoChapters.every((c) => c.preAction === undefined));
  // The per-chapter anchor sets, each pinned on the walk that owns the chapter so a future edit that drops a "?"
  // (or renames a screen anchor) is caught at the data level too (the live-screen resolution is 4e-bis). Engineer:
  // the backup run-detail, the failure and the canary; CTO: identity providers, the dual-control restore and
  // evidence; shared: notifications and the integrations grid (on both walks).
  {
    const backup = new Set(engineerChapters.find((c) => c.title === "A backup, end to end")!.infoPoints.map((p) => p.anchor));
    ok("the backup chapter pins the sealed status, the seal verdict, the records and the segments", backup.has("run-status") && backup.has("run-seal") && backup.has("run-records") && backup.has("run-segments"));
    const failure = new Set(engineerChapters.find((c) => c.title === "When it goes wrong")!.infoPoints.map((p) => p.anchor));
    ok("the failure chapter pins the failed status and the recoverable reason", failure.has("run-status") && failure.has("run-failure"));
    const canary = new Set(engineerChapters.find((c) => c.title === "Canary flights")!.infoPoints.map((p) => p.anchor));
    ok("the canary chapter pins the live status, what a flight checks, and the on-screen death preview", canary.has("canary-status") && canary.has("canary-aspects") && canary.has("canary-preview"));
    const notify = new Set(engineerChapters.find((c) => c.title === "Notifications")!.infoPoints.map((p) => p.anchor));
    ok("the notifications chapter pins the routing breadth and the event-to-channel routing", notify.has("notify-rules") && notify.has("notify-routing"));
    const idp = new Set(ctoChapters.find((c) => c.title === "Identity providers")!.infoPoints.map((p) => p.anchor));
    ok("the identity-providers chapter pins the provider breadth, the live connections and the additive add", idp.has("idp-providers") && idp.has("idp-connection") && idp.has("idp-add"));
    const dual = new Set(ctoChapters.find((c) => c.title === "Restore under dual control")!.infoPoints.map((p) => p.anchor));
    ok("the dual-control restore chapter pins the maker, the approve step and the recorded status", dual.has("approval-maker") && dual.has("approval-approve") && dual.has("approval-status"));
    const evidence = new Set(ctoChapters.find((c) => c.title === "Evidence on demand")!.infoPoints.map((p) => p.anchor));
    ok("the evidence chapter pins the signed evidence pack and the download", evidence.has("evidence-pack") && evidence.has("evidence-download"));
    const integrations = new Set(ctoChapters.find((c) => c.title === "Integrations")!.infoPoints.map((p) => p.anchor));
    ok("the integrations chapter pins the grid breadth, the auto-parse property and what is live now", integrations.has("integrations-grid") && integrations.has("integrations-autoparse") && integrations.has("integrations-active"));
  }

  // The welcome card: a warm greeting whose TWO persona actions ("Governance Tour" / "Engineering Tour") each run a
  // DIFFERENT curated walk over one director. A spy director records which persona's script was started (the
  // factory now takes the persona), so the fork-to-script wiring is observable without painting a real guide.
  let startedScript: ReadonlyArray<TourChapter> | null = null;
  let starts = 0;
  const makeSpy = (persona: TourPersona): TourDirector => {
    startedScript = TOUR_SCRIPTS[persona];
    return { start(): void { starts++; }, next(): void {}, back(): void {}, restart(): void {}, pause(): void {}, play(): void {}, toggleInfo(): void {}, exit(): void {}, resume(): void {}, destroy(): void {}, get index(): number { return 0; } };
  };

  const fork = mountPersonaFork({ createDirector: makeSpy });
  const forkEl = document.getElementById("tour-persona-fork");
  ok("the welcome is the tour's first interaction: a labelled, non-trapping dialog that greets the visitor and offers both persona walks + Free Explore", forkEl !== null && forkEl?.querySelector('[role="dialog"]')?.getAttribute("aria-modal") === "false" && (forkEl?.textContent ?? "").includes("Welcome to downpipes") && (forkEl?.textContent ?? "").includes("Governance Tour") && (forkEl?.textContent ?? "").includes("Engineering Tour") && (forkEl?.textContent ?? "").includes("Free Explore"));
  // The expectation line names two curated paths + the standing Esc exit. The length lives in the body line
  // ("ten chapters"), so the line does not repeat it; the old single-script "12 chapters" count is GONE
  // (there are two walks now, of different lengths), so assert its absence too.
  ok("the welcome sets expectations: two curated paths and the standing Esc exit promise (no duplicated duration, no stale chapter count)", (forkEl?.textContent ?? "").includes("Two curated paths · Esc leaves the tour at any time") && !(forkEl?.textContent ?? "").includes("about 3 minutes") && !(forkEl?.textContent ?? "").includes("12 chapters"));
  // The copy cut: two short body lines only, the pitch paragraphs gone.
  //
  // A minute-count promise is banned by SHAPE, not merely by string. director.ts already holds the
  // product's OWN judgement of how long a beat needs to be read: dwellForBody scales the hold to the prose
  // by MS_PER_CHAR, clamped between MIN_DWELL_MS and MAX_DWELL_MS, plus STEP_GAP_MS between steps. Summed
  // over the shipped scripts that is 5.6 minutes for the governance walk and 6.9 for the engineering one at
  // 1x, so any round duration in the welcome card would understate what the tour itself budgets for a
  // visitor by more than half. A chapter count is a measure the visitor can check against the progress bar
  // in front of them; a minute count is one only the source can answer, and the two answer differently. The
  // NEGATIVE assertion is the load-bearing half: a round duration is exactly the kind of copy that returns,
  // so the ban targets the SHAPE (any N-minute claim) rather than one literal string.
  ok("the welcome's body is the two short lines (what the tour is + the free-edition promise), with the pitch copy cut and NO minute-count promise the walk does not keep", (forkEl?.textContent ?? "").includes("A guided walk of ten chapters through the real console, at your own pace, on sample data for a fictional company. No signup, and it resets when you reload.") && !/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)[- ]minute\b/i.test(forkEl?.textContent ?? "") && (forkEl?.textContent ?? "").includes("Every feature you will see is in the free Community edition.") && !(forkEl?.textContent ?? "").includes("source types") && !(forkEl?.textContent ?? "").includes("free and complete") && !(forkEl?.textContent ?? "").includes("Choose your walk"));
  // The welcome carries NO dim backdrop (the redesign keeps the real screen the star), but stays pointer-through
  // with its own panel interactive, so the Overview behind shows AND the card is usable.
  ok("the welcome layer is pointer-transparent (the console behind shows through), and the panel re-enables its own pointer events", forkEl?.style.getPropertyValue("pointer-events") === "none" && (forkEl?.querySelector('[role="dialog"]') as { style: { getPropertyValue(p: string): string } } | null)?.style.getPropertyValue("pointer-events") === "auto");
  // The welcome card is responsive: width:min(600px, 94vw) so it never spills past a phone's viewport edge, and
  // a dvh-based max-height so the mobile browser chrome never clips it. (600px, not 480px, so the three welcome
  // actions sit comfortably 3-up on a wide card.)
  {
    const styledPanel = forkEl?.querySelector('[role="dialog"]') as { style: { getPropertyValue(p: string): string } } | null;
    const panelWidth = styledPanel?.style.getPropertyValue("width") ?? "";
    const panelMaxH = styledPanel?.style.getPropertyValue("max-height") ?? "";
    ok("the welcome card is responsive: width:min(600px, 94vw) so it never overflows a narrow viewport", panelWidth.replace(/\s+/g, "") === "min(600px,94vw)");
    ok("the welcome card height is dvh-based so the mobile browser chrome never clips it", panelMaxH.includes("dvh"));
  }
  void fork;
  // Both persona buttons exist (found by their stable data attribute, not label text), and clicking each starts a
  // director over THAT persona's curated script: the CTO button over ctoChapters, the engineer button over
  // engineerChapters. Each choice tears its own welcome down, so a fresh welcome is mounted for the second click.
  const ctoBtn = forkEl?.querySelector('[data-tour-start="cto"]');
  const engBtn = forkEl?.querySelector('[data-tour-start="engineer"]');
  ok("the welcome renders both persona start buttons (data-tour-start cto + engineer), each a real keyboard-reachable button", ctoBtn !== null && ctoBtn?.tagName === "BUTTON" && engBtn !== null && engBtn?.tagName === "BUTTON");
  // The visual demotion: Free Explore keeps its exact visible label and accessible name and stays a real
  // <button> in the tab order, but is styled linklike (no button chrome) OUTSIDE the two-primary walk grid.
  {
    const skipCtl = forkEl?.querySelector('[aria-label="Free Explore"]') as { tagName?: string; className?: string } | null;
    const walkGrid = forkEl?.querySelector(".tour-fork-actions") as { children?: { length: number }; querySelector(s: string): unknown } | null;
    ok("Free Explore is a real button demoted to linklike styling, and the walk grid holds exactly the two equal primaries", skipCtl !== null && skipCtl?.tagName === "BUTTON" && (skipCtl?.className ?? "").includes("linklike") && !(skipCtl?.className ?? "").includes("btn--") && walkGrid !== null && walkGrid?.children?.length === 2 && walkGrid?.querySelector('[aria-label="Free Explore"]') === null);
  }
  (ctoBtn as unknown as { click(): void } | null)?.click();
  ok("pressing 'Governance Tour' starts a director over the CTO script and dismisses the welcome", starts === 1 && startedScript === ctoChapters && document.getElementById("tour-persona-fork") === null);

  startedScript = null;
  const forkEng = mountPersonaFork({ createDirector: makeSpy });
  const engBtn2 = document.getElementById("tour-persona-fork")?.querySelector('[data-tour-start="engineer"]');
  (engBtn2 as unknown as { click(): void } | null)?.click();
  ok("pressing 'Engineering Tour' starts a director over the Engineer script and dismisses the welcome", starts === 2 && startedScript === engineerChapters && document.getElementById("tour-persona-fork") === null);
  void forkEng;

  startedScript = null;
  const fork2 = mountPersonaFork({ createDirector: makeSpy });
  fork2.choose("engineer");
  ok("the public choose('engineer') verb starts a director over the Engineer script", startedScript === engineerChapters && fork2.director !== null);

  const startsBefore = starts;
  const fork3 = mountPersonaFork({ createDirector: makeSpy });
  dispatchDocKey(keydown({ key: "Escape" }));
  ok("Escape drops the welcome to free-explore and starts NO tour", document.getElementById("tour-persona-fork") === null && starts === startsBefore && fork3.director === null);

  // Exploring freely is reversible: dismissing leaves a persistent "Take the tour" relaunch control, and
  // clicking it re-mounts the welcome so the visitor can enter the guided narrative after looking around first.
  const relaunch = document.getElementById("tour-relaunch");
  ok("exploring freely leaves a persistent 'Take the tour' relaunch affordance (it is reversible)", relaunch !== null && relaunch?.tagName === "BUTTON" && relaunch?.getAttribute("aria-label") === "Take the tour");
  (relaunch as unknown as { click(): void } | null)?.click();
  ok("clicking the relaunch control re-mounts the welcome (the guided narrative is reachable again) and removes itself", document.getElementById("tour-persona-fork") !== null && document.getElementById("tour-relaunch") === null);
  document.getElementById("tour-persona-fork")?.remove();
  document.getElementById("tour-relaunch")?.remove();

  // The explore instrumentation: dismissing the welcome to free-explore is
  // itself a welcome engagement, so BOTH dismissal paths (the Free Explore click and Escape) emit
  // persona_chosen with the coarse choice "explore", exactly once per mount (the destroyed flag is the
  // single-emit guard), and a walk choice never emits it (choose() bypasses destroy() entirely). Driven
  // through the REAL emit path with a fetch spy; analytics and the fetch are restored after.
  {
    const savedFetchFork = globalThis.fetch;
    const forkEvents: TourEvent[] = [];
    globalThis.fetch = ((_in: unknown, init?: RequestInit): Promise<Response> => {
      try { const ev = JSON.parse(String(init?.body ?? "null")); if (ev !== null && typeof ev === "object") forkEvents.push(ev as TourEvent); } catch { /* ignore */ }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    // The assertions above removed the re-mounted welcome's DOM node directly, which leaves that mount's
    // document keydown handler wired (only a real dismissal unwires it). Flush it with one Escape while
    // analytics are still disabled (emit is a no-op, so nothing is counted), so the counts below observe
    // only this block's own mounts.
    dispatchDocKey(keydown({ key: "Escape" }));
    document.getElementById("tour-relaunch")?.remove();
    enableTourAnalytics();
    setTourAnalyticsEndpoint("/__tour_fork_validate");
    const exploreCount = (): number => forkEvents.filter((e) => e.name === "persona_chosen" && e.persona === "explore").length;

    mountPersonaFork({ createDirector: makeSpy });
    const skipCtl2 = document.getElementById("tour-persona-fork")?.querySelector('[aria-label="Free Explore"]');
    (skipCtl2 as unknown as { click(): void } | null)?.click();
    ok("clicking Free Explore emits persona_chosen with the explore choice exactly once", exploreCount() === 1);
    document.getElementById("tour-relaunch")?.remove();

    const forkEsc = mountPersonaFork({ createDirector: makeSpy });
    dispatchDocKey(keydown({ key: "Escape" }));
    ok("Escape emits persona_chosen with the explore choice exactly once more (both dismissal paths count as engagement)", exploreCount() === 2);
    forkEsc.destroy();
    ok("a second destroy of the same mount emits no further explore choice (single-emit guard)", exploreCount() === 2);
    document.getElementById("tour-relaunch")?.remove();

    const forkWalk = mountPersonaFork({ createDirector: makeSpy });
    forkWalk.choose("cto");
    ok("choosing a walk emits its own persona and NO explore choice", forkEvents.some((e) => e.name === "persona_chosen" && e.persona === "cto") && exploreCount() === 2);
    document.getElementById("tour-relaunch")?.remove();

    disableTourAnalytics();
    setTourAnalyticsEndpoint(TOUR_EVENT_PATH);
    globalThis.fetch = savedFetchFork;
  }

  // The default real director: picking a persona with no injected createDirector paints the nav-bar rail
  // (not a dim overlay) and the welcome is gone.
  {
    const sMain = document.createElement("main");
    sMain.id = "main";
    const sHeader = document.createElement("h1");
    sHeader.className = "page-header__title";
    sHeader.textContent = "Overview";
    sMain.appendChild(sHeader);
    document.body.appendChild(sMain);
    const liveFork = mountPersonaFork();
    liveFork.choose("engineer");
    await flushAsync(3);
    ok("starting the tour with the default real director paints the nav-bar guide (the welcome is gone)", liveFork.director !== null && document.getElementById("tour-nav-bar") !== null && document.getElementById("tour-persona-fork") === null);
    ok("the default real director creates NO dim-scrim overlay and NO retired info-point layer (the page stays fully visible)", document.getElementById("tour-overlay") === null && document.getElementById("tour-info-layer") === null);
    liveFork.director?.destroy();
    document.getElementById("tour-persona-fork")?.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
    document.getElementById("tour-resume")?.remove();
    document.getElementById("tour-relaunch")?.remove();
    sMain.remove();
  }
}

// 4e-bis. The REAL chapter script resolves against the REAL screens (the drift guard). Section 4e proves the
//     chapters have the right SHAPE and pin a TourRoute, but it does not drive the SHIPPING chapters against the
//     SHIPPING screens, so the chapter-to-screen binding was untested: a beat's anchor is only a string until it
//     resolves on the live screen. If a screen dropped a data-tour-id the chapter pins (including the two
//     try-it beats' REAL controls), or renamed the page-header the director waits for, the spotlight would
//     silently never find its subject (an absent anchor hides the stage) and NO test would fail. This block
//     closes that gap: it connects the demo engine as the seeded owner and, for EVERY chapter, renders the
//     EXACT production screen the chapter's route binds to (resolved through the real app-registry SCREENS
//     list, so a renamed route is caught here), asserts the page header renders (the director's readiness
//     signal), and asserts EVERY beat's anchor resolves on that live screen. No new screen DOM beyond the
//     shared shim: each screen renders into #main, is read, then torn down.
{
  // Route /admin/* to the faked engine for the duration of this block (installDemoFetch is module-idempotent, so
  // a prior section's install-then-restore leaves the real fetch in place). Saved + restored so no sibling test
  // is affected.
  const savedFetchBis = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const path = new URL(url, location.origin).pathname + new URL(url, location.origin).search;
    if (path.startsWith("/admin/")) {
      const effectiveInit = init ?? (input instanceof Request ? { method: input.method } : undefined);
      return Promise.resolve(route(path, effectiveInit));
    }
    return savedFetchBis(input, init);
  }) as typeof fetch;
  // The canary screen constructs a real MutationObserver (a rain-preference watcher); the shim has none, so
  // provide a no-op stand-in for the duration of this block, restored after.
  const gMO = globalThis as unknown as Record<string, unknown>;
  const savedMO = gMO.MutationObserver;
  if (typeof savedMO !== "function") {
    gMO.MutationObserver = class { observe(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } } as unknown;
  }
  // THIS BLOCK SEEDS AT THE WALL CLOCK, unlike every other resetWorld in this file, and the difference is
  // deliberate. Those pin because they assert exact seeded values (a request URL carrying
  // at=, seeded run instants); this block asserts something else entirely, that every
  // beat anchor resolves ON THE LIVE SCREEN, and the live screens read the REAL Date.now(). A world pinned
  // six weeks in the past is therefore a world no visitor ever sees: production seeds at the wall clock
  // (demo/banner.ts calls resetWorld() with no argument, and demo-world.ts defaults to Date.now()).
  //
  // It began to matter when the restore-approval card started reading expiresAt: the seeded approval is
  // iso(23 * HOUR) from the world's own clock, so against a pinned 27 June it is six weeks EXPIRED, the card
  // correctly withdrew Approve, and the "approval-approve" beat anchor stopped resolving. Nothing was wrong
  // with the chapter or the screen. Pinning the world's clock while the screen reads another one is the same
  // fixture fault as a frozen expiresAt literal, and re-pinning the date forward would only defer it.
  resetWorld(Date.now());
  setCaller(caller);
  connect(location.origin);
  const engine = getEngine();
  ok("the demo boots connected as the seeded owner (requireEngine resolves a live client, no onboarding redirect)", engine !== null && caller.role === "owner");

  // The router harness: the chapter routes resolve to the production screen the app router would pick, from the
  // SAME descriptor list (app-registry SCREENS + the separately route-bound Overview). matchRoute also matches
  // the parameterised deep-link routes a chapter's preAction navigates to (e.g. /runs/dp-ledger/9 -> the runs
  // screen's /runs/:downpipeId/:index), so the run-detail drawer the preAction opens renders against the real
  // screen. A route no screen owns returns undefined and the assertion below fails loudly.
  const allScreens: Screen[] = [overviewScreen, ...SCREENS];
  const matchRoute = (pattern: string, path: string): boolean => {
    const a = pattern.split("/");
    const b = path.split("/");
    return a.length === b.length && a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
  };
  const screenForRoute = (path: string): Screen | undefined => allScreens.find((s) => routesOf(s).some((rt) => matchRoute(rt, path.split("?")[0]!)));

  // renderRoute renders the screen owning `path` into a FRESH #main with the production ScreenContext (resolving
  // any :params from the matched pattern), replacing any prior #main. It is wired as the nav bridge's navigate
  // below, so a chapter's preAction calling navigate(deep-link) re-renders the right screen (the run-detail
  // chapters deep-link to a run, which auto-opens the drawer).
  const renderRoute = (path: string): void => {
    document.getElementById("main")?.remove();
    const main = document.createElement("main");
    main.id = "main";
    document.body.appendChild(main);
    const screen = screenForRoute(path);
    if (!screen) return;
    const base = path.split("?")[0]!;
    const pattern = routesOf(screen).find((rt) => matchRoute(rt, base)) ?? base;
    const params: Record<string, string> = {};
    const pa = pattern.split("/");
    const pb = base.split("/");
    pa.forEach((seg, i) => { if (seg.startsWith(":")) params[seg.slice(1)] = pb[i]!; });
    const query = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
    const ctx: ScreenContext = { pattern, params, query, path, engine, caller, navigate: (to: string) => renderRoute(to) };
    main.appendChild(screen.render(ctx));
  };
  // Wire the nav bridge so a preAction's navigate() renders the target screen (the real director navigates
  // through this same bridge). A no-op for the other bridge hooks.
  installNav({ navigate: (to) => renderRoute(to), onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  // resolveChapter renders a chapter exactly as the director does: navigate to its route, await the screen, run
  // its preAction (which may open a drawer / disclosure / deep-link), and then resolve every info-point anchor
  // the way the info-point layer does (document.querySelector by data-tour-id), with a retry window because a
  // drawer/disclosure a preAction opens mounts a beat later (the info-point layer's own pending-retry handles
  // this in production; here the retry window stands in for the rAF loop). Returns whether a screen owns the
  // route, whether the page header rendered, and which anchors stayed unresolved.
  const resolveChapter = async (chapter: { route: string; preAction?: () => void | Promise<void>; infoPoints: ReadonlyArray<{ anchor: string }> }): Promise<{ found: boolean; rendered: boolean; unresolved: string[] }> => {
    if (!screenForRoute(chapter.route)) return { found: false, rendered: false, unresolved: chapter.infoPoints.map((p) => p.anchor) };
    renderRoute(chapter.route);
    await flushAsync(8);
    if (chapter.preAction) {
      try { await chapter.preAction(); } catch { /* a flourish never breaks the walk; the assertion below catches a genuinely missing anchor */ }
      await flushAsync(10);
    }
    const rendered = document.querySelector(".page-header__title") !== null;
    const anchors = chapter.infoPoints.map((p) => p.anchor);
    // Retry the anchor resolution across a few rounds: a deep-link drawer / async section settles over a handful
    // of microtask+macrotask ticks, the same lateness the info-point retry loop absorbs in production.
    let unresolved = anchors;
    for (let r = 0; r < 6 && unresolved.length > 0; r++) {
      unresolved = anchors.filter((a) => document.querySelector(`[data-tour-id="${a}"]`) === null);
      if (unresolved.length > 0) await flushAsync(4);
    }
    return { found: true, rendered, unresolved };
  };

  // The corpus this smoke check drives is the DEDUPED UNION of both curated walks: every unique chapter across
  // the CTO and Engineer scripts (shared chapters, defined once and reused by reference, appear once), so the
  // NEW identity-providers, notifications and integrations screens are driven against real screens too.
  const allTourChapters = [...new Set([...ctoChapters, ...engineerChapters])];

  // The literal clause first: the demo lands on Overview as the seeded owner, and the FIRST chapter's screen
  // renders + every one of its "?" anchors resolves.
  {
    const first = allTourChapters[0]!;
    ok("the first chapter is the Overview landing (lands on Overview as the seeded owner)", first.route === "/");
    const res = await resolveChapter(first);
    ok("the first chapter resolves against the REAL Overview screen (boots, lands on Overview, the seeded-owner landing renders)", res.found && res.rendered);
    ok(`every Overview beat anchor resolves on the live screen (unresolved: ${res.unresolved.join(", ") || "none"})`, res.unresolved.length === 0);
  }

  // The full binding: EVERY chapter binds to the REAL screen its route owns, renders its landing, and resolves
  // EVERY one of its info-point anchors on that live screen (driving its preAction, so a drawer/disclosure/
  // deep-link the chapter opens is rendered too). A chapter whose route no screen owns, or whose "?" anchor a
  // screen dropped, or whose preAction fails to surface the anchor, fails HERE rather than silently showing
  // fewer markers at runtime with no test failing.
  for (let i = 0; i < allTourChapters.length; i++) {
    const chapter = allTourChapters[i]!;
    const res = await resolveChapter(chapter);
    ok(`chapter ${i + 1} (${chapter.route}) "${chapter.title}" binds to a real screen that owns the route and renders its landing`, res.found && res.rendered);
    ok(`chapter ${i + 1} (${chapter.route}) "${chapter.title}" resolves every beat anchor on the live screen (unresolved: ${res.unresolved.join(", ") || "none"})`, res.unresolved.length === 0);
  }

  // Re-seed so a re-run sees the pristine world (the connection + caller are module-scoped, harmless to leave),
  // restore the fetch + MutationObserver this block swapped, and leave the nav bridge guard-free for later blocks.
  resetWorld(Date.UTC(2026, 5, 27, 0, 0, 0));
  installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
  if (typeof savedMO !== "function") delete gMO.MutationObserver; else gMO.MutationObserver = savedMO;
  globalThis.fetch = savedFetchBis;
}

// 4f. The funnel exits (data) + the funnel analytics events. The closing funnel chapter is a later stage, but
//     its two deliberate exits are authored as data now (FUNNEL_CTAS) and must stay true; and the tour emits
//     its PII-free funnel events to a same-origin beacon, best-effort and only when enabled. Driven through the
//     REAL emit path with a fetch spy collecting the events; the fetch is restored after.
{
  // The funnel exits: the website's deploy-steps page (https, primary; the actual deploy-into-your-own-
  // Cloudflare steps with the prerequisites, incl. the Workers Paid plan, NOT the post-deploy docs
  // quickstart) and the pricing page (secondary; the label promises a page, and the ?src names the path for
  // server-side counting on downpipes.io).
  ok("the funnel offers exactly two deliberate exits (deploy + see pricing)", FUNNEL_CTAS.length === 2);
  const deployCta = FUNNEL_CTAS.find((c) => c.kind === "deploy-final");
  const pricingCta = FUNNEL_CTAS.find((c) => c.kind === "pricing-final");
  ok("the primary exit is the website's deploy steps page (https)", deployCta?.primary === true && (deployCta?.href ?? "") === "https://downpipes.io/deploy");
  ok("the secondary exit channels to the pricing page with the finale src marker", pricingCta !== undefined && pricingCta.primary !== true && (pricingCta.href ?? "") === "https://downpipes.io/pricing?src=pricing-final");

  // The same-origin beacon path: not under /admin/*, so the faked-engine shim does not swallow it. emit is a
  // no-op disabled; enabled it POSTs the event JSON.
  const savedFetch = globalThis.fetch;
  const events: TourEvent[] = [];
  globalThis.fetch = ((_in: unknown, init?: RequestInit): Promise<Response> => {
    // Collect ONLY real beacon objects: a fetch with no body (a leaked async from another validator firing
    // through this global spy in the full-suite run, or a non-beacon request) parses to null and must not be
    // pushed, else a later events.some((e) => e.name ...) dereferences null and crashes the whole suite.
    try { const ev = JSON.parse(String(init?.body ?? "null")); if (ev !== null && typeof ev === "object") events.push(ev as TourEvent); } catch { /* ignore */ }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  ok("the analytics endpoint is same-origin and NOT under /admin/* (the shim must not swallow it)", TOUR_EVENT_PATH === "/tour/event" && !TOUR_EVENT_PATH.startsWith("/admin/"));

  disableTourAnalytics();
  ok("emit is a no-op while disabled (the genuine console never beacons)", emit({ name: "tour_started" }) === false && events.length === 0);
  enableTourAnalytics();
  setTourAnalyticsEndpoint("/__tour_validate");
  emit({ name: "step_reached", stepIndex: 2, route: "/sources" });
  ok("an enabled emit beacons the PII-free event to the same-origin sink", events.some((e) => e.name === "step_reached" && e.stepIndex === 2 && e.route === "/sources"));

  // The ?src= campaign attribution (GTM funnel instrumentation): readTourAttribution admits a label-shaped
  // value off the entry URL and emit() attaches it to tour_started and cta_clicked ONLY, as the payload's
  // `src` field (the worker writes it as blob5, appended after the original four blobs, never inserted).
  // An off-shape value (uppercase, a scheme, free text) is dropped whole, so no src field rides at all.
  events.length = 0;
  readTourAttribution({ search: "?src=202608-launch" } as Location);
  emit({ name: "tour_started" });
  emit({ name: "cta_clicked", detail: "deploy-final", route: "/" });
  emit({ name: "step_reached", stepIndex: 3, route: "/runs" });
  ok("tour_started carries the admitted ?src= campaign label", events.some((e) => e.name === "tour_started" && e.src === "202608-launch"));
  ok("cta_clicked carries the admitted ?src= campaign label", events.some((e) => e.name === "cta_clicked" && e.detail === "deploy-final" && e.src === "202608-launch"));
  ok("step_reached does NOT carry src (attribution rides the start and the CTA only)", events.some((e) => e.name === "step_reached" && e.stepIndex === 3 && !("src" in e)));

  events.length = 0;
  readTourAttribution({ search: "?src=https%3A%2F%2Fevil.example%2Fx" } as Location);
  emit({ name: "tour_started" });
  ok("an off-shape ?src= (a URL with a scheme) is dropped whole: no src field is emitted", events.some((e) => e.name === "tour_started" && !("src" in e)));

  events.length = 0;
  readTourAttribution({ search: `?src=${"a".repeat(33)}` } as Location);
  emit({ name: "tour_started" });
  ok("an oversized ?src= (33 characters) is dropped whole, never truncated", events.some((e) => e.name === "tour_started" && !("src" in e)));

  // Clear the stored attribution so later blocks (and a full-suite run) see the no-src default.
  readTourAttribution({ search: "" } as Location);
  events.length = 0;
  emit({ name: "tour_started" });
  ok("with no ?src= on the entry URL, tour_started carries no src field", events.some((e) => e.name === "tour_started" && !("src" in e)));

  // The director emits step_reached per chapter and drop_step on Exit: drive a two-chapter walk, advance, exit.
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
    ok("the first chapter emits step_reached with its index + route", events.some((e) => e.name === "step_reached" && e.stepIndex === 0 && e.route === "/"));
    d.exit();
    ok("Exit emits a single drop_step (detail exit) on the current chapter", events.some((e) => e.name === "drop_step" && e.detail === "exit" && e.stepIndex === 0));
    d.destroy();
    main.remove();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
    document.getElementById("tour-resume")?.remove();
  }

  disableTourAnalytics();
  setTourAnalyticsEndpoint(TOUR_EVENT_PATH);
  globalThis.fetch = savedFetch;
}

// 5. app.ts wires the guarded branch through isTourMode + startDemo, and ONLY that (the additive boot hook).
//    isTourMode is imported statically from the cheap, dependency-free guard module; startDemo is loaded
//    behind the guard with a dynamic import so the tour is a lazy chunk kept out of the default bundle the
//    genuine console ships. Both halves are pinned so the wiring cannot be dropped, and so a regression back
//    to a static import of the tour entry (which would re-bake the whole tour into the production bundle) is
//    caught here.
const appSrc = readFileSync(join("src", "app.ts"), "utf8");
has("app.ts imports the cheap tour guard from its dependency-free module", appSrc, 'import { isTourMode } from "./lib/demo/tour-mode.ts"');
has("app.ts loads the demo boot entry behind the guard via a DYNAMIC import (the tour stays a lazy chunk)", appSrc, 'await import("./lib/demo/demo-fetch.ts")');
// The guard now admits the training walk beside the tour (training-mode.ts, the same dev-host-scoped
// discipline): both are demo experiences over the same faked backend, and both stay out of the default
// bundle behind the one dynamic import this line guards.
has("app.ts guards the demo branch on isTourMode()/isTrainingMode() and starts the demo", appSrc, "if (isTourMode() || isTrainingMode()) {");
has("app.ts calls startDemo() inside the guard", appSrc, "startDemo();");
// The tour entry must NOT be statically imported in app.ts: a static `from "./lib/demo/demo-fetch.ts"` would
// make esbuild walk the whole tour subtree into the default bundle, the exact regression the dynamic import
// fixes. Assert the static form is absent (the dynamic `import(...)` form asserted above is the only reach).
ok("app.ts does NOT statically import the tour entry (no whole-tour inlining into the production bundle)", !appSrc.includes('from "./lib/demo/demo-fetch.ts"'));

// ---- 9. DEMO-vs-CONSOLE DRIFT and TOUR DEGRADATION are no longer silent -----------------------------------
//
// THE DISCRIMINATION TEST. The tour's faked route table is a second implementation of the console's API
// surface and it rots: an unmodelled GET renders a BLANK screen, an unmodelled POST fabricates a SUCCESS (a
// delete that "succeeded" and changed nothing, a drill or attestation that "passed" for a run that does not
// exist), an unknown id substitutes a DIFFERENT object. Those are four different repairs, and the funnel could
// not tell any of them from a healthy session. Each state below must produce a DIFFERENT event.
async function section9(): Promise<void> {
  const savedFetch = globalThis.fetch;
  const events: TourEvent[] = [];
  globalThis.fetch = ((_in: unknown, init?: RequestInit): Promise<Response> => {
    try { const ev = JSON.parse(String(init?.body ?? "null")); if (ev !== null && typeof ev === "object") events.push(ev as TourEvent); } catch { /* ignore */ }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  enableTourAnalytics();
  setTourAnalyticsEndpoint("/__tour_validate");

  const { normaliseAdminPattern, DEMO_DRIFT_KINDS, TOUR_DEGRADE_STAGES, noteTourDegraded } = await import("../src/lib/demo/demo-drift.ts");

  // NO-CUSTODY FIRST. The route pattern is the only non-enum field these events carry, and it is gated by SET
  // MEMBERSHIP against the frozen product word list, not by a length clamp. A segment that is not a product
  // word becomes ":id" and is discarded, so no id, no query and nothing a visitor typed can ride.
  ok("a product route survives as itself", normaliseAdminPattern("/admin/downpipes") === "/admin/downpipes");
  ok("a run id in the path is replaced by :id", normaliseAdminPattern("/admin/history/01JAVXK9Q4RM5T7B2N6H8YZ3PC") === "/admin/history/:id");
  ok(
    "an EMAIL, a BUCKET and a TOKEN in a path are all replaced, whatever their length",
    normaliseAdminPattern("/admin/roles/priya@acme.example") === "/admin/roles/:id" &&
      normaliseAdminPattern("/admin/destinations/acme-prod-backups") === "/admin/destinations/:id" &&
      normaliseAdminPattern("/admin/keys/sk-live-4a91f") === "/admin/keys/:id",
  );
  ok("a query string is dropped whole (it can carry a downpipe id or a framework)", normaliseAdminPattern("/admin/rto") === "/admin/rto");

  // THE STATES THE GAP NAMES, driven through the REAL route table.
  events.length = 0;
  resetWorld();
  await route("/admin/there-is-no-such-screen", { method: "GET" }); // 1. a screen that renders BLANK
  await route("/admin/there-is-no-such-write", { method: "POST", body: "{}" }); // 2. a write that FABRICATES success
  await route("/admin/reports/soc2?format=pdf", { method: "GET" }); // 3. a download that cannot download
  await route("/admin/downpipes", { method: "DELETE" }); // 4. a verb the table cannot answer
  const drifts = events.filter((e) => e.name === "demo_drift");
  ok("an unmodelled GET is recorded", drifts.some((e) => e.detail === "unmodelled-get"));
  ok("an unmodelled POST is recorded, and is NOT the same event as the GET", drifts.some((e) => e.detail === "unmodelled-post"));
  ok("an unmodelled PDF render is its own kind (a dead download, not a blank screen)", drifts.some((e) => e.detail === "pdf-unmodelled"));
  ok("a verb the table does not model is its own kind", drifts.some((e) => e.detail === "wrong-verb"));
  ok(
    "the four states produce FOUR DIFFERENT rows (they used to produce a benign 200 and nothing else)",
    new Set(drifts.map((e) => e.detail)).size === 4,
  );
  ok("and each names the ROUTE it happened on, so the drift can be enumerated rather than hunted", drifts.every((e) => typeof e.route === "string" && e.route.startsWith("/admin")));
  ok("every drift kind is a member of the closed vocabulary", drifts.every((e) => (DEMO_DRIFT_KINDS as readonly string[]).includes(String(e.detail))));

  // A body the faked engine cannot parse: it applies its DEFAULTS and answers success, so the visitor's choice
  // was silently discarded. The body itself is the one thing on this path a visitor could have typed into, and
  // it must never ride.
  events.length = 0;
  await route("/admin/downpipes", { method: "POST", body: '{"name":"acme-prod-backups", BROKEN' });
  const parseFail = events.filter((e) => e.name === "demo_drift" && e.detail === "body-parse-failed");
  ok("an unparseable write body is its own kind (the visitor's choice was silently replaced by defaults)", parseFail.length >= 1);
  ok("and NOTHING of the body rides", JSON.stringify(events).indexOf("acme-prod-backups") === -1);

  // ---- A RECOVERABILITY PROOF FOR A RUN THAT DOES NOT EXIST -----------------------------------------------
  //
  // The gap's loudest state, and the one the first cut answered with SILENCE. The tour's four recoverability
  // verbs each look a run up and never check what they found, so a GHOST run id gets a passing drill, a clean
  // blind restore test, a valid attestation and a restore plan borrowed from the seeded run. A fabricated
  // success anywhere is bad; a fabricated proof that a prospect's data is restorable is what the tour exists
  // NOT to do. Driven through the REAL route table, LEGIT against GHOST, so the two must not produce the same
  // rows -- which is precisely what they did before (both produced none).
  events.length = 0;
  resetWorld();
  const legitRunId = String(JSON.parse(await (await route("/admin/history")).text()).byDownpipe[Object.keys(JSON.parse(await (await route("/admin/history")).text()).byDownpipe)[0]!][0].runId);
  await route("/admin/drill", { method: "POST", body: JSON.stringify({ runId: legitRunId }) });
  await route("/admin/restore/verify", { method: "POST", body: JSON.stringify({ runId: legitRunId }) });
  await route("/admin/restore/attest", { method: "POST", body: JSON.stringify({ runId: legitRunId }) });
  await route("/admin/restore", { method: "POST", body: JSON.stringify({ runId: legitRunId }) });
  const legitDrift = events.filter((e) => e.name === "demo_drift");
  ok("a proof over a run that EXISTS records no drift (the tour working is not an event)", legitDrift.length === 0);

  events.length = 0;
  const ghostBody = JSON.stringify({ runId: "run-ghost-0001" });
  const drillGhost = JSON.parse(await (await route("/admin/drill", { method: "POST", body: ghostBody })).text());
  const verifyGhost = JSON.parse(await (await route("/admin/restore/verify", { method: "POST", body: ghostBody })).text());
  const attestGhost = JSON.parse(await (await route("/admin/restore/attest", { method: "POST", body: ghostBody })).text());
  await route("/admin/restore", { method: "POST", body: ghostBody });
  const ghostDrift = events.filter((e) => e.name === "demo_drift" && e.detail === "proof-for-unknown-run");
  ok(
    "the faked engine STILL answers the ghost with a pass (the tour must never fail loud at a prospect)",
    drillGhost.ok === true && verifyGhost.ok === true && attestGhost.signatureValid === true,
  );
  ok("...but a drill, a blind test, an attestation and a restore plan over a GHOST run are FOUR drift rows", ghostDrift.length === 4);
  ok(
    "...and each names the proof verb it fabricated, so the drift can be repaired rather than hunted",
    new Set(ghostDrift.map((e) => e.route)).size === 4 &&
      ghostDrift.some((e) => e.route === "/admin/drill") &&
      ghostDrift.some((e) => e.route === "/admin/restore/verify") &&
      ghostDrift.some((e) => e.route === "/admin/restore/attest") &&
      ghostDrift.some((e) => e.route === "/admin/restore"),
  );
  ok("a genuine proof and a FABRICATED one no longer carry the same (empty) evidence", legitDrift.length !== ghostDrift.length);
  ok("and the ghost run id itself never rides (the route pattern is a product word list, not an echo)", JSON.stringify(events).indexOf("run-ghost") === -1);

  // The READ-side substitutions the gap lists: an unseeded framework silently serves the ALL pack, and an
  // unknown downpipe id gets a fabricated empty ring. Both make a screen render a stand-in for what was clicked.
  events.length = 0;
  await route("/admin/reports/evidence-pack?framework=iso-42001");
  await route("/admin/history?id=no-such-downpipe");
  const sub = events.filter((e) => e.name === "demo_drift" && e.detail === "unknown-id-fallback");
  ok("an unseeded evidence-pack framework and an unknown downpipe id are recorded as substitutions", sub.length === 2);

  // NOISE: a downpipe the VISITOR created during the tour legitimately has no seeded run ring. Firing drift on
  // the tour's own happy path would be the wolf cry, so the guard is the id being unknown, not the ring empty.
  events.length = 0;
  const known = Object.keys(JSON.parse(await (await route("/admin/history")).text()).byDownpipe)[0]!;
  await route(`/admin/history?id=${known}`);
  ok("a KNOWN downpipe with a ring is never drift", events.filter((e) => e.name === "demo_drift").length === 0);
  // "WHATEVER ITS RING HOLDS" NEEDS THE EMPTY RING, and until now nothing drove it. The guard is
  // `world.historyByDownpipe[id] === undefined && !knownDownpipe(id)`, a conjunction whose FIRST arm the
  // id above satisfies, so it short-circuits and knownDownpipe is never evaluated. The line above
  // therefore proved nothing about the clause the comment is about, and would still pass with
  // `&& !knownDownpipe(id)` deleted from the source. dp-cf-config-zone is seeded as a downpipe with no
  // ring, which is exactly the visitor-created shape this rule exists for, so it is driven directly.
  events.length = 0;
  const knownNoRing = "dp-cf-config-zone";
  const rings = JSON.parse(await (await route("/admin/history")).text()).byDownpipe as Record<string, unknown>;
  ok("the empty-ring fixture really has no seeded ring, or the case below is not the case it claims", rings[knownNoRing] === undefined);
  await route(`/admin/history?id=${knownNoRing}`);
  ok("a KNOWN downpipe with an EMPTY ring is never drift (the visitor-created shape)", events.filter((e) => e.name === "demo_drift").length === 0);
  // The discrimination. Both lines above assert an EMPTY filter over an events list, which is what an
  // events list that has stopped recording anything at all also looks like. So the same read, on an id the
  // world holds no downpipe for, must record drift.
  events.length = 0;
  await route("/admin/history?id=dp-not-in-this-world");
  ok("while an id the world holds no downpipe for IS drift, so the two empty checks above are not merely a silent recorder", events.filter((e) => e.name === "demo_drift" && e.detail === "unknown-id-fallback").length === 1);

  // ---- The honesty-chrome CASCADE, and the anchor that was three states in one row --------------------------
  //
  // The five chrome installs used to sit under ONE try, so the first failure dropped every later one and the
  // tour could run with no DEMO labelling at all. Each stage must be its own event, and a failing install must
  // not take the others down with it. installChrome is the real caller and its component id is a closed union.
  events.length = 0;
  noteTourDegraded("chrome-install-failed", "tour-banner");
  noteTourDegraded("chrome-install-failed", "tour-corner-marker");
  noteTourDegraded("welcome-mount-failed");
  const degraded = events.filter((e) => e.name === "tour_degraded");
  ok(
    "a failed banner and a failed corner marker are TWO events naming TWO components (the cascade is visible)",
    degraded.filter((e) => e.detail === "chrome-install-failed").length === 2 &&
      degraded.some((e) => e.route === "tour-banner") &&
      degraded.some((e) => e.route === "tour-corner-marker"),
  );
  ok("a welcome that never mounted is its own stage", degraded.some((e) => e.detail === "welcome-mount-failed"));
  ok("every stage is a member of the closed vocabulary", degraded.every((e) => (TOUR_DEGRADE_STAGES as readonly string[]).includes(String(e.detail))));

  // THE ANCHOR, DRIVEN THROUGH THE REAL DIRECTOR. beatIntoView's retry closure used to be shared by the "no
  // element" branch and the "found it, but scrolling did not frame it" branch, so THREE states exhausted into
  // one anchor-missing row: a renamed data-tour-id (restore the hook), a drawer that never opened (fix the
  // reveal), and an anchor that is present, visible and simply cannot be seated in the band on a short screen
  // against the tour's own fixed bottom bar -- which is NOT A FAULT and fired on every session of that chapter.
  //
  // Nothing below calls noteTourDegraded. Three chapters, three real anchors in a real document, one director.
  events.length = 0;
  const mkAnchor = (id: string, rect: { top: number; bottom: number; width: number; height: number } | null): void => {
    const el = document.createElement("div");
    el.setAttribute("data-tour-id", id);
    if (rect !== null) (el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect;
    document.body.appendChild(el);
  };
  // Present, and COLLAPSED: in the DOM with no box at all (the drawer the preAction was to open never opened).
  mkAnchor("g338-boxless", { top: 0, bottom: 0, width: 0, height: 0 });
  // Present, VISIBLE, and UNFRAMABLE: a real box low on a short page with no scroll room. Nothing is wrong.
  mkAnchor("g338-unframable", { top: 700, bottom: 780, width: 200, height: 80 });
  // ...and "g338-absent" is deliberately never created.

  const anchorScript: TourChapter[] = [
    { route: "/sources", title: "Absent", infoPoints: [{ anchor: "g338-absent", title: "A", body: "The hook was renamed." }] },
    { route: "/restore", title: "Boxless", infoPoints: [{ anchor: "g338-boxless", title: "B", body: "The reveal never ran." }] },
    { route: "/reports", title: "Unframable", infoPoints: [{ anchor: "g338-unframable", title: "C", body: "Nothing is wrong here." }] },
  ];
  const anchorDir = createTourDirector(anchorScript, {
    navigate: () => {},
    reseed: () => {},
    renderTimeoutMs: 5,
    renderPollMs: 2,
    beatFrameMs: 1,
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
  };
  anchorDir.start();
  await settle();
  anchorDir.next();
  await settle();
  anchorDir.next();
  await settle();
  anchorDir.destroy();

  const anchorRows = events.filter((e) => e.name === "tour_degraded" && String(e.detail).startsWith("anchor-"));
  ok(
    "an ABSENT data-tour-id is anchor-missing, and names the chapter and the anchor (restore the hook)",
    anchorRows.some((e) => e.detail === "anchor-missing" && e.route === "/sources" && e.anchor === "g338-absent"),
  );
  ok(
    "an anchor that is PRESENT with no box is anchor-not-visible, NOT anchor-missing (fix the reveal)",
    anchorRows.some((e) => e.detail === "anchor-not-visible" && e.route === "/restore" && e.anchor === "g338-boxless"),
  );
  ok(
    "the renamed hook and the broken reveal are no longer the same row",
    new Set(anchorRows.map((e) => e.detail)).size === 2,
  );
  ok(
    "an anchor that is present, VISIBLE and merely unframable records NOTHING (there is nothing to repair)",
    !anchorRows.some((e) => e.anchor === "g338-unframable"),
  );

  // THE REDACTION GATE. The chapter route and the anchor id are admitted ONLY by set membership against the
  // vocabulary of the script the director registered (or the closed chrome-component union). A caller reaching
  // for an exception message, or a value read off the page, emits the stage and NOTHING ELSE.
  events.length = 0;
  noteTourDegraded("anchor-missing", "TypeError: cannot read property of undefined", "priya@acme.example");
  const gated = events.filter((e) => e.name === "tour_degraded");
  ok(
    "a chapter and an anchor that are not in the running script are DROPPED WHOLE, not clamped",
    gated.length === 1 && gated[0]?.detail === "anchor-missing" && gated[0]?.route === undefined && gated[0]?.anchor === undefined,
  );
  ok("nothing of the free text or the email survives anywhere", JSON.stringify(events).indexOf("TypeError") === -1 && JSON.stringify(events).indexOf("acme.example") === -1);

  // The SPLIT CATCH itself: startDemo must install each chrome component under its own guard. A source-shape
  // assertion, because the cascade is a control-flow property and the one-try form is exactly what regressed.
  const demoSrc = readFileSync(join("src", "lib", "demo", "demo-fetch.ts"), "utf8");
  ok("startDemo installs each honesty-chrome component under its OWN guard (installChrome), not one shared try", demoSrc.includes('installChrome("tour-banner"') && demoSrc.includes('installChrome("tour-pricing-pill"'));

  disableTourAnalytics();
  setTourAnalyticsEndpoint(TOUR_EVENT_PATH);
  globalThis.fetch = savedFetch;
}
await section9();


console.log(checks.failures === 0 ? "tour contract: OK" : `tour contract: ${checks.failures} FAILED`);
verdictReached(checks.failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(checks.failures === 0 ? 0 : 1);
