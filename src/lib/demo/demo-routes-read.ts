// The faked engine's GET route table, split out of the faked engine (see demo-seed.ts for the file layout).
//
// House rules: Australian English, precise claims (tamper-evident, post-quantum hybrid).

import type { ChainVerdict, ReportKind, RtoReport } from "../api/types.ts";
import { DAY, HOUR, MIN, ORG_OWNER_EMAIL } from "./demo-seed.ts";
import {
  auditPage,
  benignGet,
  demoEpoch,
  demoIso,
  demoProviderForEndpoint,
  json,
  notImplemented,
  pathAndMethod,
  runsAtResolve,
  settleDueRuns,
  toEngineDownpipeWire,
  world,
} from "./demo-world.ts";
import { routeWrite } from "./demo-routes-write.ts";
import { noteDemoDrift } from "./demo-drift.ts";

// ---------------------------------------------------------------------------------------------------
// The route table. route(path, init) => Response maps each /admin/* path + method to a handler over the
// world. It is intentionally a small explicit table, not a router framework, so the faked surface is
// auditable at a glance and a path the demo does not yet model fails LOUD (a 501 the console surfaces as an
// honest tile error) rather than silently fabricating a shape.
// ---------------------------------------------------------------------------------------------------

// knownDownpipe says whether the seeded world holds a downpipe with this id AT ALL. It is the guard that
// keeps the unknown-id drift signal off the tour's own happy path: a downpipe the visitor CREATED during the
// tour legitimately has no seeded run ring and no seeded RTO estimate, and recording drift for it would fire on
// a working demo. Drift is the id belonging to NO downpipe, which is the state that makes a screen render a
// stand-in for something the visitor clicked.
function knownDownpipe(id: string): boolean {
  return world.downpipes.some((d) => d.config.id === id);
}

// deriveSetupStateView computes GET /admin/setup-state's facts from the WORLD, the way the real engine
// derives them from observation, instead of serving the seed-time snapshot. This is what lets the guided
// first run be TAUGHT over the demo: on the training-start variant the collections begin empty, and each
// step's fact flips exactly when the learner's own write lands it (a verified destination appears in
// world.destinations, the discovery token flips sourceDiscovery.tokenPresent, an attach grows bound, a
// created downpipe grows world.downpipes, a settled run puts an ok entry in a ring). The stored flags the
// world cannot observe (keysReady and its signer/break-glass/email siblings) stay on world.setupState,
// flipped by the matching key writes. On the pristine default seed every derived fact agrees with the old
// static snapshot except boundSourceCount, which now honestly counts the four seeded BINDINGS rather than
// echoing the downpipe count; its only consumer (lib/setup-state.ts deriveSetup) reads it solely as
// greater-than-zero, so the guided view is unchanged.
function deriveSetupStateView(): import("../api/types.ts").SetupState {
  const s = world.setupState;
  const bound = world.sourceDiscovery.bound;
  const boundSourceCount = bound.kv.length + bound.r2.length + bound.d1.length + bound.secrets.length;
  const first = world.destinations.destinations.find((d) => d.id === world.destinations.defaultId) ?? world.destinations.destinations[0];
  const destination: import("../api/types.ts").SetupState["destination"] =
    first === undefined
      ? { configured: false, verified: false, kind: null, source: null }
      : {
          configured: true,
          verified: first.verifiedAt !== undefined && first.verifiedAt !== null,
          // FOUR-WAY, mirroring the engine (demoProviderForEndpoint in demo-world.ts). It read
          // `includes("r2.cloudflarestorage.com") ? "r2": "s3"` until, so a learner who saved a
          // Google Cloud or Azure destination in the training course was told it was S3 by every screen
          // that reads this fact.
          kind: demoProviderForEndpoint(first.endpointHost),
          source: "console",
          ...(first.bucket !== undefined ? { bucket: first.bucket } : {}),
          ...(first.endpointHost !== undefined ? { endpointHost: first.endpointHost } : {}),
        };
  const downpipeCount = world.downpipes.length;
  const anyRunCompleted = Object.values(world.historyByDownpipe).some((ring) => ring.some((e) => e.status === "ok"));
  const discoveryTokenPresent = world.sourceDiscovery.tokenPresent;
  return {
    ownerExists: s.ownerExists ?? true,
    keysReady: s.keysReady,
    signerConfigured: s.signerConfigured,
    breakGlassConfigured: s.breakGlassConfigured,
    emailConfigured: s.emailConfigured,
    discoveryTokenPresent,
    accountsSelected: discoveryTokenPresent && (world.sourceDiscovery.accounts?.length ?? 0) > 0,
    destination,
    boundSourceCount,
    downpipeCount,
    anyRunCompleted,
    ready: s.keysReady && destination.configured && discoveryTokenPresent && downpipeCount > 0,
  };
}

// deriveDestinationDefault computes GET /admin/destination, the SINGULAR redaction-safe view of the
// default destination, from world.destinations, the way the engine derives it from the stored collection
// rather than holding a second copy of it. The demo did hold a second copy, and the add-a-destination write
// never moved it: a training learner who verified and saved their first destination still met "No
// destination yet" in the New downpipe wizard, because the wizard asks THIS route and not the collection.
// One fact, so every write that moves the collection or its default moves this view with it. The seeded
// singleton is still the fallback for a world with nothing stored, because it is what carries the
// deploy-time posture (envConfigured/envKind) that a console-set destination has no opinion about.
function deriveDestinationDefault(): import("../api/types.ts").DestinationStatus {
  const first = world.destinations.destinations.find((d) => d.id === world.destinations.defaultId) ?? world.destinations.destinations[0];
  if (first === undefined) return { ...world.destinationDefault, present: false };
  // The singular view is the default's status without the collection's identity fields (the type's own
  // note: "The singular GET /destination view omits them").
  const { id: _id, label: _label, isDefault: _isDefault, ...singular } = first;
  return singular;
}

// route is the faked engine entry point demo-fetch delegates every /admin/* request to. Reads and the
// simple writes return a Response SYNCHRONOUSLY (the seeded world is already in memory, so a scripted tour
// action produces the same result every time and the demo can never flake on a slow or failing network
// call); the four restore dual-control writes return a Promise<Response> because they await the plan hash
// (SHA-384) to mint an approval whose binding matches the restore screen's. The fetch shim wraps the result
// in Promise.resolve, which flattens either return transparently, so the caller always sees a normal fetch.
export function route(path: string, init?: RequestInit): Response | Promise<Response> {
  const { pathname, query, method } = pathAndMethod(path, init);

  // GET reads first (every read the Overview's tiles + the boot + the proof-of-moat screens issue). Each
  // returns the relevant slice of the world in the exact wire shape the matching client method parses.
  if (method === "GET") {
    switch (pathname) {
      // health is the one UNAUTHENTICATED read; the console routes it through parseJson like the rest.
      case "/admin/health":
        return json({ ok: true, service: world.status.service });
      // whoami answers the no-login boot with the seeded owner identity, so the app lands on Overview as a
      // verified owner with no sign-in and no onboarding redirect.
      case "/admin/whoami":
        return json(world.whoami);
      case "/admin/status":
        return json(world.status);
      case "/admin/setup-state":
        return json(deriveSetupStateView());
      case "/admin/licence":
        return json(world.licence);
      case "/admin/updates":
        return json(world.updates);
      case "/admin/downpipes":
        // Serve the engine's RAW wire shape, NOT the internally-held flat shape: listDownpipes() flattens
        // it back through mapEngineDownpipeState, so the seed's restore/integrity recency survives the round
        // trip instead of being silently dropped to "never proven" for every pipe.
        return json(world.downpipes.map(toEngineDownpipeWire));
      case "/admin/drill-evidence":
        return json(world.drillEvidence);
      // ---- the destinations + replication reads (the Destinations screen + the topology map) ----
      // GET /admin/destination is the singular redaction-safe DEFAULT view; GET /admin/destinations is the
      // full collection plus the default id; GET /admin/replication is the per-downpipe per-destination
      // proven-holds + reachability state.
      case "/admin/destination":
        return json(deriveDestinationDefault());
      case "/admin/destinations":
        return json(world.destinations);
      case "/admin/replication":
        return json({ byDownpipe: world.replicationByDownpipe });
      // ---- the native-SSO reads (the Access + identity screen + the pre-auth sign-in) ----
      case "/admin/idp/connections":
        return json({ ok: true, connections: world.idpConnections });
      case "/admin/idp/presets":
        return json({ ok: true, presets: world.idpPresets });
      case "/admin/oidc/providers":
        return json({ ok: true, providers: world.idpProviders });
      // ---- the assurance reads (Security centre + Credentials + Reports) ----
      case "/admin/posture":
        return json(world.posture);
      case "/admin/coverage":
        return json(world.coverage);
      case "/admin/expiry":
        return json(world.expiry);
      case "/admin/config/approval-policy":
        return json(world.configApprovalPolicy);
      // The estate-wide attended-verification interval. Unmodelled it would 501, and the attended screen
      // treats a failed read as "could not ask your engine", so a public tour would show an error on a
      // control that works.
      case "/admin/config/attended-cadence":
        return json({ attendedCadenceDays: world.attendedCadenceDays });
      // /admin/rto is the fleet roll-up plus per-downpipe estimates; an ?id= narrows the per-downpipe list
      // to that one downpipe (still with the fleet roll-up so the console can show "this pipe vs the fleet").
      case "/admin/rto": {
        const id = query.get("id");
        if (id !== null && id !== "") {
          const one = world.rto.downpipes.find((d) => d.id === id);
          // An id the seeded world does not hold gets a FABRICATED empty per-downpipe list, so the screen
          // renders as though the downpipe simply has no estimate. The drift is the ID BEING UNKNOWN, not the
          // list being empty: a downpipe the visitor created during the tour legitimately has no seeded RTO
          // estimate yet, and firing on that would be a wolf cry on the tour's own happy path.
          if (!one && !knownDownpipe(id)) noteDemoDrift("unknown-id-fallback", pathname);
          const result: RtoReport = { fleet: world.rto.fleet, downpipes: one ? [one] : [] };
          return json(result);
        }
        return json(world.rto);
      }
      // ---- the restore dual-control inbox (the restore-flow + the owner needs-attention tile) ----
      case "/admin/restore/approvals":
        return json(world.approvals);
      // The retention-prune approvals inbox. isPruneApprovalList (src/lib/api/types/retention-prune.ts)
      // refuses anything that is not a real array, so the benignGet object fallback error-carded this
      // screen on the public tour, which is exactly the outcome demo-world.ts's own header forbids for an
      // unmodelled screen load. An empty array is the honest answer: the seeded world raises no prune
      // requests, so the inbox renders its own empty state.
      case "/admin/retention-prune/approvals":
        return json([]);
      // The legacy singular owner-action inbox path the Overview historically read; kept answering an empty
      // owner-action list (the dual-control restore inbox is /admin/restore/approvals above).
      case "/admin/approvals":
        return json(world.approvals);
      // /admin/history with an id returns one downpipe's ring (envelope { entries }); without an id it
      // returns every ring keyed by id ({ byDownpipe }). The Overview fleet roll-up uses the no-id form.
      case "/admin/history": {
        const id = query.get("id");
        if (id !== null) {
          // Same rule. An UNKNOWN downpipe id is answered with a fabricated empty ring, which reads on the
          // screen as "this downpipe has never run". A downpipe the visitor just created has an empty ring
          // honestly, so only an id the world holds NO downpipe for is drift.
          if (world.historyByDownpipe[id] === undefined && !knownDownpipe(id)) noteDemoDrift("unknown-id-fallback", pathname);
          settleDueRuns(id);
          return json({ entries: world.historyByDownpipe[id] ?? [] });
        }
        settleDueRuns();
        return json({ byDownpipe: world.historyByDownpipe });
      }
      // /admin/audit returns a newest-first page plus the chain head, honouring the screen's server-side
      // filters (actor/action/outcome/before/limit). The Overview asks for limit=1 (the "last audited" stamp).
      case "/admin/audit":
        return json(auditPage(query));
      // /admin/audit/verify is the tamper-evidence proof: the seeded chain links cleanly (each entry's
      // prevHash is the prior entry's hash), so the verdict is intact through the whole chain.
      case "/admin/audit/verify": {
        const verdict: ChainVerdict = { intact: true, checkedThrough: world.audit[0]?.seq ?? 0 };
        return json(verdict);
      }
      // ---- the remaining governance / proof-of-moat screen-load reads, so every nav item renders ----
      // populated. Each returns the seeded slice in the exact wire shape its screen's client method parses.
      // The canary liveness view (the Canary card). config:null on the wire means "fly to all destinations".
      case "/admin/canary":
        return json(world.canary);
      // The config change-control inbox (the change-requests screen). The trailing-slash and approve/reject
      // are POSTs handled below; this is the list read.
      case "/admin/config/changes":
        return json(world.configChanges);
      // The signed config version history (the timeline + the chain-intact badge).
      case "/admin/config/history":
        return json(world.configHistory);
      // One full config version by id (?id=N), or { found: false } for an unknown/aged-out id. The demo
      // models the header set; a known id returns a minimal full version (the snapshot is rendered loosely).
      case "/admin/config/version": {
        const id = Number(query.get("id") ?? "");
        const header = world.configHistory.versions.find((v) => v.id === id);
        if (!header) return json({ found: false });
        return json({
          found: true,
          version: {
            ...header,
            digest: `edhmac384:demo-config-digest-${header.id}`,
            snapshot: { downpipes: [], roles: [], groupRoles: [], customRoles: [], notifyChannels: [], notifyRules: [], webhook: { configured: true, host: "alerts.northwind.example" }, riskAccepts: [], expiryItems: [] },
          },
        });
      }
      // The plain-English diff between two versions (?from=A&to=B), or { found: false } when either is
      // unknown. The demo returns a small representative change list so the diff view renders.
      case "/admin/config/diff": {
        const from = Number(query.get("from") ?? "");
        const to = Number(query.get("to") ?? "");
        const known = (n: number): boolean => world.configHistory.versions.some((v) => v.id === n);
        if (!known(from) || !known(to)) return json({ found: false });
        return json({
          found: true,
          from,
          to,
          changes: [
            { kind: "added", area: "notify-rule", text: "notify rule added: payments store, deliver backup-failure to on-call PagerDuty" },
            { kind: "changed", area: "downpipe", text: "downpipe artifacts: retention changed to keep 45 runs" },
          ],
        });
      }
      // The RBAC role tables (the Access + identity screen): built-in roles, IdP group->role mappings, the
      // custom-role catalogue.
      case "/admin/roles":
        return json(world.roles);
      case "/admin/group-roles":
        return json(world.groupRoles);
      case "/admin/custom-roles":
        return json(world.customRoles);
      // The sign-in factor union (the "Sign-in factors (who can still sign in)" disclosure on /access/roles).
      // isSignInFactorListing refuses anything without {scope, factors[], groupRoleMappings}, so benignGet's
      // object fallback error-carded this disclosure on the public tour, which demo-world.ts's own header
      // forbids for an unmodelled screen load. It is the same defect the retention-prune inbox above already
      // has recorded against it.
      //
      // THE ROWS ARE DERIVED FROM THE SEEDED WORLD, not fabricated: one per role grant, so the disclosure
      // shows the same people the roles table above does. Each carries `passkey` because the seed gives this
      // org enrolled credentials, and `recovery` present-and-parseable, which is the posture a healthy demo
      // org is in. `unconsumedCodes` is a real number rather than null: null means the record could not be
      // PARSED, and claiming an unreadable record here would put an alarm on the tour that nothing caused.
      case "/admin/signin-factors": {
        const email = query.get("email");
        const grants = email !== null && email !== "" ? world.roles.filter((r) => r.email === email) : world.roles;
        const factors = grants.map((r, i) => ({
          email: r.email,
          hasRoleEntry: true,
          signIn: "can-sign-in" as const,
          paths: ["passkey", "recovery-code"] as const,
          passkey: {
            credentials: 1,
            credentialIds: [world.passkeyCredentials[i % Math.max(1, world.passkeyCredentials.length)]?.credentialId ?? `demo-cred-${i + 1}`],
            lastAssertedAt: r.grantedAt,
          },
          recovery: { present: true, parseable: true, unconsumedCodes: 8, keyContinuity: "live" as const, generatedAt: r.grantedAt },
          // `invites` is NOT optional and the panel indexes it directly: omitting it threw
          // "Cannot read properties of undefined (reading 'live')" and error-carded the disclosure with a
          // message about the engine being unreachable, which is a worse lie than the one it replaced. Zero
          // live invites is the honest demo posture: every seeded member has already enrolled.
          invites: { live: 0, expired: 0, soonestExpiresAt: null },
        }));
        // `witnessSince` is the listing-level provenance field the type declares, and NOTHING ON THE PANEL
        // READS IT TODAY: it appears only in src/lib/api/types/signin-factors.ts, here, and a test fixture,
        // with zero hits under src/screens/ against a positive control (groupRoleMappings, which has five).
        // It is populated anyway because the route answers the declared shape rather than the subset one
        // screen happens to consume. null means "no witness window recorded", which is the honest value for
        // a fabricated world and does not claim a continuity this demo cannot have observed.
        return json({
          scope: email !== null && email !== "" ? "email" : "account",
          factors,
          witnessSince: null,
          groupRoleMappings: world.groupRoles.length,
        });
      }
      // The notifications config (the Notifications screen): channels, routing rules, the delivery history.
      case "/admin/notify/channels":
        return json(world.notifyChannels);
      case "/admin/notify/rules":
        return json(world.notifyRules);
      case "/admin/notify/history":
        return json(world.notifyHistory);
      // The dual-control owner-action inbox (the Overview needs-attention tile + the owner-actions screen).
      case "/admin/owner-actions":
        return json(world.ownerActions);
      // The enrolled-passkey inventory (the Sessions + passkeys screen). Both the legacy /admin/passkey and
      // the current /admin/passkey/credentials return the same redacted summary list.
      case "/admin/passkey":
      case "/admin/passkey/credentials":
        return json({ credentials: world.passkeyCredentials });
      // The sessions list (the Sessions + passkeys screen): the no-login demo has one live owner session.
      case "/admin/sessions":
        return json({ sessions: [{ id: "sess-owner-demo", current: true, createdAt: demoIso(-2 * HOUR), lastSeenAt: demoIso(-1 * MIN), method: "access", email: ORG_OWNER_EMAIL, userAgent: "Demo browser", ip: null }] });
      // The keyless key-vintage inventory (the Keys screen's Rotate tab): which keys the archives are wrapped
      // to, and how many runs are stranded to a key the engine no longer holds. Public fingerprints and
      // counts only, never a key half. Modelled rather than left to benignGet, whose empty shape would make
      // the panel error out mid-tour on the one screen whose whole point is that it can answer.
      case "/admin/keys/vintages":
        return json({ inventory: world.keyVintages });
      // The supportability status (the Support screen): seal + signer presence + the per-scope grant views.
      case "/admin/support":
        return json(world.support);
      // The SIEM audit-log push destination (the Settings "Audit log push (SIEM)" disclosure): the
      // redaction-safe view (endpoint/format/header NAME, enabled, cursor, trail), never the secret.
      case "/admin/push":
        return json(world.push);
      // The OTLP metrics push destination (the Integrations "Datadog metrics" tile / Settings "Metrics push"):
      // the demo ships none, so the redaction-safe view is a clean "not configured".
      case "/admin/otlp-push":
        return json({ present: false, trail: [] });
      // The preflight entitlement / prerequisite report (the readiness surface).
      case "/admin/preflight":
        return json(world.preflight);
      // The safe-apply update lifecycle record (the Updates screen): nothing mid-flight, a clean last apply.
      case "/admin/update/status":
        return json(world.updateStatusRecord);
      // The source-discovery catalogue (the add-source wizard) + its presence-only status. The discovery
      // view offers EVERY source type (bound + account resources, zones for cf-config, all capability flags
      // true) so the Sources "add a source" set matches the Downpipes "new downpipe" set exactly.
      case "/admin/sources/discover":
        return json(world.sourceDiscovery);
      case "/admin/sources/discovery-status":
        return json({ present: true, setAt: demoEpoch(-30 * DAY), setBy: ORG_OWNER_EMAIL, accountsSeen: [{ id: "demo-acct-northwind", name: "Northwind Trading Co" }], selected: ["demo-acct-northwind"], engineAccountId: "demo-acct-northwind" });
      // The legacy discovery-accounts read (the account chooser): the verified account list. (The POST that
      // sets the selection is handled in routeWrite.)
      case "/admin/sources/discovery-accounts":
        return json({ present: true, setAt: demoEpoch(-30 * DAY), setBy: ORG_OWNER_EMAIL, accountsSeen: [{ id: "demo-acct-northwind", name: "Northwind Trading Co" }], selected: ["demo-acct-northwind"], engineAccountId: "demo-acct-northwind" });
      // The onboarding estate-size estimate (the Costs screen): sized from analytics, counts + bytes only.
      case "/admin/cost/estate-size":
        return json(world.estateSize);
      // A point-in-time recovery target (?downpipe=&at=<rfc3339>): the latest successful run at-or-before T.
      // The demo resolves it from the downpipe's own ring head so the point-in-time restore picker renders.
      case "/admin/runs/at":
        return json(runsAtResolve(query));
      // The signed audit export (the audit screen's export): the demo returns the same page shape the live
      // export streams (the export is the audit page; a ?format=pdf variant degrades via the report path).
      case "/admin/audit/export":
        return json(auditPage(query));
      default:
        return routeReportsOrUnknown(method, pathname, query);
    }
  }

  // POST writes (phase 1c): the demonstrated mutations the proof-of-moat scripts perform. Each mutates the
  // module-scoped world IN PLACE and returns the SAME applied / queued / pending shape the matching console
  // client method parses (client-transport.ts), so the UI reflects the change immediately; a page reload
  // (a fresh module evaluation) or resetWorld() returns the pristine world. An unmodelled POST degrades to a
  // benign applied/ok result (routeWrite's default), never an engine error, so a click never fails loud. The
  // four restore dual-control writes await the plan hash, so they return a Promise<Response>; the rest are
  // synchronous (the fetch shim's Promise.resolve flattens either).
  if (method === "POST") return routeWrite(pathname, init);

  // A non-GET / non-POST method (PUT / DELETE) is not a screen load and the console never issues one to
  // /admin/*; it is the honest 501 so a genuinely wrong verb is still surfaced (the GET + POST paths above
  // are what every screen and click use, and both degrade gracefully).
  // A PUT/DELETE the faked table does not model at all. It is an honest 501 AND a drift signal: a console
  // screen now issues a verb the tour cannot answer, so that screen's demonstration is broken.
  return notImplemented(method, pathname, "wrong-verb");
}

// routeReportsOrUnknown handles the GET report routes, which are keyed by a path SEGMENT (/admin/reports/:kind)
// or a query (the evidence pack), so they cannot sit in the exact-match switch. /admin/reports/:kind returns
// the signed report for the kind; /admin/reports/evidence-pack?framework=<id> returns the per-framework
// signed pack. The reports + evidence-pack screens read this JSON on paint (the signed metadata). A
// ?format=pdf variant would return rendered application/pdf bytes from the real engine; the faked tour does
// NOT model PDF rendering yet, so it must NOT serve the JSON Report mislabelled as a PDF (that would hand a
// .pdf download whose bytes are JSON and toast a false success). Instead the PDF variant degrades HONESTLY
// to the 501 the console's getReportPDF/getEvidencePackPDF route through failResponse, so the download
// button restores and the screen shows an honest "could not download" warn rather than a wrong-content
// file. Anything else is the honest 501.
function routeReportsOrUnknown(method: string, pathname: string, query: URLSearchParams): Response {
  // The PDF render path is not modelled in the tour; answer it with the honest 501 (never the JSON Report
  // dressed as a PDF). This is checked before the JSON dispatch so both the :kind and evidence-pack PDF
  // variants degrade the same honest way; the JSON reads (no format=pdf) are untouched.
  if (query.get("format") === "pdf") return notImplemented(method, pathname, "pdf-unmodelled");
  // The evidence pack is a query-parameterised report, matched before the generic :kind so the literal
  // "evidence-pack" segment routes to the per-framework pack rather than a kind lookup.
  if (pathname === "/admin/reports/evidence-pack") {
    const framework = query.get("framework") ?? "all";
    const pack = world.evidencePacks[framework] ?? world.evidencePacks.all;
    // An unseeded framework is served the ALL pack. The visitor clicked SOC 2 and downloaded something
    // else, with no sign that a substitution happened. The framework name itself never rides: the drift event
    // carries the normalised route pattern, and the query string is dropped whole.
    if (world.evidencePacks[framework] === undefined) noteDemoDrift("unknown-id-fallback", pathname);
    if (pack) return json(pack);
    return notImplemented(method, pathname);
  }
  const reportMatch = /^\/admin\/reports\/([a-z-]+)$/.exec(pathname);
  if (reportMatch) {
    const kind = reportMatch[1] as ReportKind;
    const report = world.reports[kind];
    if (report) return json(report);
    return notImplemented(method, pathname);
  }
  // /admin/saml/metadata/:connId returns the SP metadata XML (a string the IdP screen fetches for the SAML
  // connection's "view metadata" affordance). The demo returns a well-formed, redaction-safe metadata
  // document for the connection so the link renders rather than erroring; the bytes are illustrative.
  const samlMeta = /^\/admin\/saml\/metadata\/(.+)$/.exec(pathname);
  if (samlMeta) {
    const connId = decodeURIComponent(samlMeta[1] ?? "");
    const xml = `<?xml version="1.0"?>\n<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://tour.downpipes.io/admin/saml/metadata/${connId}">\n  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n    <NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress</NameIDFormat>\n    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://tour.downpipes.io/admin/saml/acs/${connId}" index="0"/>\n  </SPSSODescriptor>\n</EntityDescriptor>`;
    return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
  }
  // Any other unmodelled GET is a SCREEN LOAD the explorable tour must not fail on: degrade to a benign
  // empty-but-valid 200 (never the honest 501, which would surface "the engine returned an error"). The
  // deliberate non-2xx cases (the PDF render path, an unknown report kind above) are handled before here.
  return benignGet(pathname);
}
