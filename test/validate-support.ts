// Validate the pure, honesty-critical presentation logic of the two new panels:
// the supportability panel (src/screens/settings.ts) and the platform preflight
// checklist (src/screens/onboarding-ceremony.ts).
// Run with: node test/validate-support.ts
//
// Both screens are DOM-heavy, but their load-bearing decisions are extracted into pure
// functions that take plain values, the same seam pattern the notifications validator
// uses; none of the imported modules execute DOM at import time, so importing the
// screens under plain node succeeds.
//
// Coverage:
//   preflightItemPresentation (NO FABRICATED GREEN):
//     - only "verified" maps to the ok tone; configured is info (present-but-unproven);
//       unconfigured is a neutral to-do; failed is danger
//     - an UNKNOWN status from a newer engine degrades to neutral, never to a pass
//   preflightVerdict (the headline honesty rules):
//     - any failure => danger, regardless of how many passes sit beside it
//     - ok REQUIRES every required item verified AND zero failures
//     - the in-between (configured/unconfigured remainder) is the cautious warn
//   orderPreflightItems:
//     - failed items list FIRST (prominence), engine order preserved within groups,
//       input never mutated
//   supportGrantPresentation / latestPullAt:
//     - null grant is a neutral fact; active is ok; EXPIRED is danger. The THIRD state, a stored expiry
//       that cannot be read (`expiryUnreadable`), is graded next door in
//       test/validate-support-expiry-unreadable.ts rather than here, and the split is deliberate: this
//       file owns the healthy and lapsed renderings, so it is the CONTROL that arm's mutation driver
//       runs beside, and a control that also grades the class under test proves nothing about it.
//     - the bare-token grantedBy (null) is named honestly, never shown as a person
//     - the pull line carries count + most recent pull, robust to ordering
//     - the view can never carry a secret (no secret-bearing key in the output)
//   vendorSealPresentation:
//     - configured => sealed + signed (ok); not configured => signed only (info),
//       and the copy never claims sealing when the key is absent
//   supportBundleFileName:
//     - derives the dated .json name from an ISO timestamp
//   accessPerimeterNote (the Access-fronted mint warning):
//     - each scope's note names its exact /support route and the puller it concerns
//     - both notes name the two workable patterns (service token via Service Auth, narrow Bypass)
//       and reassure that the minted credential still gates the route

import {
  preflightItemPresentation,
  preflightVerdict,
  orderPreflightItems,
} from "../src/screens/onboarding-ceremony.ts";
import {
  vendorSealPresentation,
  supportGrantPresentation,
  latestPullAt,
  supportBundleFileName,
  emailTestVerdict,
  accessPerimeterNote,
  metricsEndpointNote,
  downloadJsonText,
} from "../src/screens/settings.ts";
import type { PreflightItem, PreflightStatus, SupportGrantView } from "../src/api.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq<T>(label: string, got: T, want: T): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// preflightItemPresentation: the closed, conservative status -> tone mapping.
// ---------------------------------------------------------------------------
console.log("\n-- preflightItemPresentation: no fabricated green --");

eq("verified -> ok tone", preflightItemPresentation("verified").tone, "ok");
eq("verified word", preflightItemPresentation("verified").word, "verified");
eq("configured -> info (present-but-unproven, never green)", preflightItemPresentation("configured").tone, "info");
ok("configured word says unproven", preflightItemPresentation("configured").word.includes("unproven"));
eq("unconfigured -> neutral to-do", preflightItemPresentation("unconfigured").tone, "neutral");
eq("failed -> danger", preflightItemPresentation("failed").tone, "danger");
eq("failed word", preflightItemPresentation("failed").word, "failed");
// A status this build does not know (a newer engine) must degrade to neutral, never a pass.
const unknownStatus = "shiny-new" as PreflightStatus;
eq("unknown status degrades to neutral (never ok)", preflightItemPresentation(unknownStatus).tone, "neutral");
ok("ONLY verified maps to the ok tone", (["configured", "unconfigured", "failed"] as PreflightStatus[]).every((s) => preflightItemPresentation(s).tone !== "ok"));

// ---------------------------------------------------------------------------
// preflightVerdict: the headline honesty rules over the engine's own summary.
// ---------------------------------------------------------------------------
console.log("\n-- preflightVerdict: honest headline --");

eq("all required verified, no failures -> ok", preflightVerdict({ required: 5, requiredVerified: 5, failed: 0 }).tone, "ok");
eq("a single failure -> danger even with every required verified", preflightVerdict({ required: 5, requiredVerified: 5, failed: 1 }).tone, "danger");
eq("failures dominate the partial state too", preflightVerdict({ required: 5, requiredVerified: 2, failed: 2 }).tone, "danger");
eq("partially verified without failures -> warn (never ok)", preflightVerdict({ required: 5, requiredVerified: 4, failed: 0 }).tone, "warn");
eq("nothing verified without failures -> warn", preflightVerdict({ required: 5, requiredVerified: 0, failed: 0 }).tone, "warn");
ok("danger title counts the failures", preflightVerdict({ required: 5, requiredVerified: 5, failed: 2 }).title.includes("2"));
ok("singular failure reads 'check', plural reads 'checks'", preflightVerdict({ required: 1, requiredVerified: 1, failed: 1 }).title.includes("check failed") && preflightVerdict({ required: 1, requiredVerified: 1, failed: 2 }).title.includes("checks failed"));
ok("warn title states the verified fraction", preflightVerdict({ required: 5, requiredVerified: 3, failed: 0 }).title.includes("3 of 5"));

// ---------------------------------------------------------------------------
// orderPreflightItems: failed items first, stable within groups, no mutation.
// ---------------------------------------------------------------------------
console.log("\n-- orderPreflightItems: failures listed first --");

const item = (id: string, status: PreflightItem["status"]): PreflightItem => ({
  id,
  name: id,
  requires: "x",
  required: true,
  status,
  evidence: "e",
});
const mixed = [item("a", "verified"), item("b", "failed"), item("c", "configured"), item("d", "failed"), item("e", "unconfigured")];
const mixedBefore = JSON.stringify(mixed);
const ordered = orderPreflightItems(mixed);
eq("failed items come first, engine order preserved within groups", ordered.map((i) => i.id), ["b", "d", "a", "c", "e"]);
ok("input list is not mutated", JSON.stringify(mixed) === mixedBefore);
eq("no failures leaves the engine order untouched", orderPreflightItems([item("a", "verified"), item("b", "configured")]).map((i) => i.id), ["a", "b"]);
eq("empty list stays empty", orderPreflightItems([]).length, 0);

// ---------------------------------------------------------------------------
// supportGrantPresentation: null / active / expired, the honest grant states.
// ---------------------------------------------------------------------------
console.log("\n-- supportGrantPresentation: grant states --");

const grant = (over: Partial<SupportGrantView>): SupportGrantView => ({
  clientId: "dpc_abc",
  scope: "diagnostics",
  grantedAt: "2026-06-01T00:00:00.000Z",
  grantedBy: "owner@example.com",
  expiresAt: "2026-06-04T00:00:00.000Z",
  expired: false,
  pulls: [],
  ...over,
});

{
  const p = supportGrantPresentation(null);
  eq("no grant -> neutral tone", p.tone, "neutral");
  eq("no grant label", p.label, "No active credential.");
  ok("no grant has no detail/pull lines", p.detail === null && p.pullLine === null);
}

{
  const p = supportGrantPresentation(grant({}));
  eq("active grant -> ok tone", p.tone, "ok");
  ok("active label names the clientId and the expiry", p.label.includes("dpc_abc") && p.label.includes("2026-06-04"));
  ok("active detail names who granted it", (p.detail ?? "").includes("owner@example.com"));
  eq("no pulls reads 'Never pulled.'", p.pullLine, "Never pulled.");
}

{
  const p = supportGrantPresentation(grant({ expired: true }));
  eq("EXPIRED grant -> danger tone", p.tone, "danger");
  ok("expired label says expired and that pulls are refused", p.label.includes("expired") && p.label.includes("refused"));
}

{
  // The bare-token grant path (grantedBy null) is named honestly, never as a person.
  const p = supportGrantPresentation(grant({ grantedBy: null }));
  ok("bare-token grantedBy is named honestly", (p.detail ?? "").includes("bare-token") && (p.detail ?? "").includes("not attributable"));
}

{
  // Pull trail: count + the MOST RECENT pull, robust to ordering.
  const p = supportGrantPresentation(grant({ pulls: [{ at: "2026-06-03T00:00:00.000Z" }, { at: "2026-06-02T00:00:00.000Z" }] }));
  ok("pull line carries the count", (p.pullLine ?? "").startsWith("2 pulls"));
  ok("pull line carries the most recent pull (order-independent)", (p.pullLine ?? "").includes("2026-06-03"));
  // Ascending input (oldest first): the presentation must still surface the newest pull, not the
  // first element, so this directly exercises the 'robust to ordering' claim for supportGrantPresentation.
  const asc = supportGrantPresentation(grant({ pulls: [{ at: "2026-06-02T00:00:00.000Z" }, { at: "2026-06-03T00:00:00.000Z" }] }));
  ok("pull line picks the most recent pull from ascending input", (asc.pullLine ?? "").includes("2026-06-03"));
  const single = supportGrantPresentation(grant({ pulls: [{ at: "2026-06-02T00:00:00.000Z" }] }));
  ok("a single pull reads singular", (single.pullLine ?? "").startsWith("1 pull "));
}

{
  // The presentation can never smuggle a secret: every output field is a string/tone
  // derived from the redacted view, and the view itself carries no secret-bearing key.
  const p = supportGrantPresentation(grant({}));
  const joined = [p.label, p.detail ?? "", p.pullLine ?? ""].join(" ");
  ok("presentation output never mentions a secret", !/secret|dps_/i.test(joined));
}

// latestPullAt directly: robust to ordering and junk timestamps.
eq("latestPullAt of empty trail is null", latestPullAt([]), null);
eq("latestPullAt picks the max regardless of order", latestPullAt([{ at: "2026-06-03T00:00:00.000Z" }, { at: "2026-06-01T00:00:00.000Z" }, { at: "2026-06-02T00:00:00.000Z" }]), "2026-06-03T00:00:00.000Z");
eq("latestPullAt falls back to the last entry when nothing parses", latestPullAt([{ at: "junk-1" }, { at: "junk-2" }]), "junk-2");

// ---------------------------------------------------------------------------
// vendorSealPresentation: sealed-and-signed vs signed-only, stated plainly.
// ---------------------------------------------------------------------------
console.log("\n-- vendorSealPresentation --");

{
  const sealed = vendorSealPresentation(true, true);
  eq("vendor seal configured + signer -> ok tone", sealed.tone, "ok");
  ok("configured copy says sealed AND signed", sealed.label.includes("sealed") && sealed.label.includes("signed"));
  const unsealed = vendorSealPresentation(false, true);
  eq("no vendor seal -> info tone (a fact, not a fault)", unsealed.tone, "info");
  ok("unsealed copy says signed but NOT sealed", unsealed.label.includes("signed") && unsealed.label.includes("not sealed"));
  ok("unsealed copy never claims sealing", !unsealed.label.includes("sealed to"));
  // A PRE-CEREMONY engine serves the bundle unsigned; the copy must never claim a
  // signature that does not exist yet, in either seal state.
  const preCeremonySealed = vendorSealPresentation(true, false);
  eq("pre-ceremony + sealed -> info tone", preCeremonySealed.tone, "info");
  ok("pre-ceremony sealed copy says unsigned until the ceremony", preCeremonySealed.label.includes("unsigned until the key ceremony"));
  ok("pre-ceremony sealed copy never claims 'signed by your engine'", !preCeremonySealed.label.includes("signed by your engine"));
  const preCeremonyUnsealed = vendorSealPresentation(false, false);
  eq("pre-ceremony + unsealed -> info tone", preCeremonyUnsealed.tone, "info");
  ok("pre-ceremony unsealed copy says unsigned until the ceremony", preCeremonyUnsealed.label.includes("unsigned until the key ceremony"));
  ok("pre-ceremony unsealed copy never claims 'signed by your engine'", !preCeremonyUnsealed.label.includes("signed by your engine"));
}

// ---------------------------------------------------------------------------
// supportBundleFileName: the dated download name.
// ---------------------------------------------------------------------------
console.log("\n-- supportBundleFileName --");

eq("file name derives the date part from the ISO stamp", supportBundleFileName("2026-06-10T03:04:05.000Z"), "downpipe-support-bundle-2026-06-10.json");
ok("file name ends in .json", supportBundleFileName(new Date().toISOString()).endsWith(".json"));

// ---------------------------------------------------------------------------
// emailTestVerdict: each failure mode names its specific Cloudflare fix.
// ---------------------------------------------------------------------------
console.log("\n-- emailTestVerdict: one sentence names the fix per outcome --");

ok("ok -> sent, points at inbox/spam", emailTestVerdict({ ok: true }).startsWith("Sent."));
ok("sender-domain-not-available code -> onboard the sending domain", emailTestVerdict({ ok: false, code: "E_SENDER_DOMAIN_NOT_AVAILABLE" }).includes("onboard the domain"));
ok("sender-not-verified code -> same onboarding fix", emailTestVerdict({ ok: false, code: "E_SENDER_NOT_VERIFIED" }).includes("onboard the domain"));
ok("email-not-configured reason -> add the send_email binding", emailTestVerdict({ ok: false, reason: "email-not-configured" }).includes("send_email binding"));
ok("email-from-not-configured reason -> set EMAIL_FROM", emailTestVerdict({ ok: false, reason: "email-from-not-configured" }).includes("EMAIL_FROM is unset"));
ok("email-from-invalid reason -> set EMAIL_FROM", emailTestVerdict({ ok: false, reason: "email-from-invalid" }).includes("EMAIL_FROM is unset"));
ok("needs-identity reason -> sign in with a passkey or Access", emailTestVerdict({ ok: false, reason: "email-test-needs-identity" }).includes("passkey or Cloudflare Access"));
ok("fallback default -> Email Service set-up, no code shown when absent", emailTestVerdict({ ok: false }).includes("Email Service may not be enabled") && !emailTestVerdict({ ok: false }).includes("("));
ok("fallback default folds in the code when present", emailTestVerdict({ ok: false, code: "E_WHATEVER" }).includes("(E_WHATEVER)"));

// ---------------------------------------------------------------------------
// accessPerimeterNote: the Access-fronted mint warning. Each scope names its own route and
// puller (the collector for the feed, vendor support for diagnostics), offers the two workable
// patterns by name, and reassures that the engine's credential still gates the route: the note
// must never read as "Access replaces the credential" or vice versa.
// ---------------------------------------------------------------------------
console.log("\n-- accessPerimeterNote: the Access-fronted mint warning --");

{
  const feed = accessPerimeterNote("audit-feed");
  ok("feed note names Cloudflare Access", feed.includes("Cloudflare Access"));
  ok("feed note names the exact feed route", feed.includes("GET /support/audit-feed"));
  ok("feed note concerns the customer's collector, not vendor support", feed.includes("SIEM collector") && !feed.includes("vendor support"));
  ok("feed note offers a service token via a Service Auth policy", feed.includes("service token") && feed.includes("Service Auth"));
  ok("feed note offers the narrow Bypass alternative", feed.includes("Bypass"));
  ok("feed note says the credential still gates the feed", feed.includes("credential still gates"));
  const diag = accessPerimeterNote("diagnostics");
  ok("diagnostics note names Cloudflare Access", diag.includes("Cloudflare Access"));
  ok("diagnostics note names the exact diagnostics route", diag.includes("GET /support/diagnostics"));
  ok("diagnostics note concerns vendor support's pull", diag.includes("vendor support"));
  ok("diagnostics note offers a service token via a Service Auth policy", diag.includes("service token") && diag.includes("Service Auth"));
  ok("diagnostics note scopes the Bypass to the life of the ticket", diag.includes("Bypass") && diag.includes("life of the ticket"));
  ok("diagnostics note says the credential still gates the bundle", diag.includes("credential still gates"));
  ok("the notes are scope-specific, not one shared sentence", feed !== diag);
  // metrics (monitoring integrations, PLAN.md): the third scope's note follows the same
  // shape (names Access, names the exact route, offers both workable patterns, reassures the
  // credential still gates the surface) and must not collide with the other two.
  const metrics = accessPerimeterNote("metrics");
  ok("metrics note names Cloudflare Access", metrics.includes("Cloudflare Access"));
  ok("metrics note names the exact scrape route", metrics.includes("GET /metrics"));
  ok("metrics note concerns a scraper, not vendor support or a SIEM collector", metrics.includes("scraper") && !metrics.includes("vendor support"));
  ok("metrics note offers a service token via a Service Auth policy", metrics.includes("service token") && metrics.includes("Service Auth"));
  ok("metrics note offers the narrow Bypass alternative", metrics.includes("Bypass"));
  ok("metrics note says the credential still gates the scrape", metrics.includes("credential still gates"));
  ok("the metrics note is distinct from both other scopes", metrics !== feed && metrics !== diag);
}

// ---------------------------------------------------------------------------
// metricsEndpointNote: the one-line "point your scraper here" instruction shown beside the
// Prometheus scrape endpoint URL (monitoring integrations, PLAN.md).
// ---------------------------------------------------------------------------
console.log("\n-- metricsEndpointNote --");

{
  const note = metricsEndpointNote();
  ok("names Prometheus", note.includes("Prometheus"));
  ok("names Grafana", note.includes("Grafana"));
  ok("names at least one more OTLP-metrics-capable agent (Datadog/New Relic/Dynatrace/Elastic/Splunk Observability)", /Datadog|New Relic|Dynatrace|Elastic|Splunk Observability/.test(note));
  ok("says to present the credential as a bearer token", note.toLowerCase().includes("bearer"));
  ok("is a single sentence (one line), matching the one-line note the design calls for", (note.match(/\./g) ?? []).length === 1);
}

// ---------------------------------------------------------------------------
// downloadJsonText: the support pack's delivery to disk.
//
// THE PACK IS THE ONE ARTEFACT WHOSE DELIVERY FAILING DESTROYS EVIDENCE. The console's bounded ring of
// coarse error classes is read into the pack and then CLEARED, and until it was cleared BEFORE
// the file was written, through a delivery that could throw. A browser that declined the blob write left
// the customer with no pack and an emptied ring, and the retry rebuilt a pack carrying no console error
// classes at all, while the line under the button went on telling them the bundle includes them.
//
// The fix is that this returns a boolean and never throws, and the caller clears the ring only on true.
// Driven here rather than asserted about: the two browser calls it depends on are stubbed, one accepting
// and one refusing, and the real function runs against both.
// ---------------------------------------------------------------------------
console.log("\n-- downloadJsonText (support pack delivery) --");

{
  const g = globalThis as unknown as Record<string, unknown>;
  const savedDocument = g.document;
  const savedUrl = g.URL;
  const savedBlob = g.Blob;
  const savedNode = g.Node;
  // lib/dom.ts isAttrs distinguishes an attrs object from a child by `instanceof Node`, so a `Node`
  // global is part of the minimum a delivery needs. Its absence made the first version of the happy-path
  // case here fail against a function that was working, which is the instrument being wrong before the
  // product is.
  g.Node = class {};

  /** The minimum a delivery needs: an anchor to click and a body to hang it off. */
  function installDelivery(opts: { objectUrlThrows?: boolean; blobThrows?: boolean }): { clicks: number; appended: number; revoked: number } {
    const seen = { clicks: 0, appended: 0, revoked: 0 };
    const anchor = {
      click: () => { seen.clicks++; },
      remove: () => {},
      setAttribute: () => {},
      appendChild: () => {},
      style: {},
    };
    g.document = {
      body: { appendChild: () => { seen.appended++; } },
      createElement: () => anchor,
      createTextNode: (t: string) => ({ nodeType: 3, textContent: String(t) }),
      createDocumentFragment: () => ({ appendChild: () => {} }),
    };
    g.Blob = class { constructor() { if (opts.blobThrows) throw new Error("blob refused"); } };
    g.URL = {
      createObjectURL: () => { if (opts.objectUrlThrows) throw new Error("createObjectURL refused"); return "blob:stub"; },
      revokeObjectURL: () => { seen.revoked++; },
    };
    return seen;
  }

  {
    const seen = installDelivery({});
    const delivered = downloadJsonText("downpipe-support-bundle-2026-08-11.json", "{}");
    ok("a browser that accepts the write reports the pack delivered", delivered === true);
    ok("the accepted delivery actually clicked the anchor", seen.clicks === 1);
    ok("the accepted delivery released the object URL", seen.revoked === 1);
  }

  {
    // The failure that motivates this: URL.createObjectURL declining. Before this threw straight
    // out of the promise chain, after the ring had already been cleared.
    const seen = installDelivery({ objectUrlThrows: true });
    let threw = false;
    let delivered: boolean | null = null;
    try {
      delivered = downloadJsonText("downpipe-support-bundle-2026-08-11.json", "{}");
    } catch {
      threw = true;
    }
    ok("a refused object URL does not throw out of the click handler", threw === false);
    ok("a refused object URL reports the pack NOT delivered", delivered === false);
    ok("a refused object URL never clicked anything", seen.clicks === 0);
  }

  {
    // The other half of the same refusal: the Blob constructor throwing under memory pressure.
    const seen = installDelivery({ blobThrows: true });
    let threw = false;
    let delivered: boolean | null = null;
    try {
      delivered = downloadJsonText("downpipe-support-bundle-2026-08-11.json", "{}");
    } catch {
      threw = true;
    }
    ok("a refused Blob does not throw out of the click handler", threw === false);
    ok("a refused Blob reports the pack NOT delivered", delivered === false);
    ok("a refused Blob never clicked anything", seen.clicks === 0);
  }

  {
    // NON-VACUITY. Every assertion above would also hold of a function that did nothing at all, so the
    // happy path is re-driven once more and its side effects counted. A delivery that clicks nothing is
    // not a delivery.
    const seen = installDelivery({});
    downloadJsonText("downpipe-support-bundle-2026-08-11.json", "{}");
    ok("the stub is capable of recording a click, so the zero above means refused and not inert", seen.clicks === 1 && seen.appended === 1);
  }

  if (savedDocument === undefined) delete g.document; else g.document = savedDocument;
  g.URL = savedUrl;
  if (savedBlob === undefined) delete g.Blob; else g.Blob = savedBlob;
  if (savedNode === undefined) delete g.Node; else g.Node = savedNode;
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nALL SUPPORT/PREFLIGHT VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
