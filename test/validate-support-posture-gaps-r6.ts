// CONSOLE-side coverage for four support-diagnostics defects, each with the same shape: a fix that lands on
// one producer of a shared classification while a sibling producer of the same value keeps the old behaviour.
// So each test below drives every producer of the value it checks, through the real entry point, over the
// bytes a real server sends.
//
//   THE FAILING CATALOGUE READ (GET /sources/discover) is driven on BOTH of its entry points: the editor's
//        re-read (buildCfConfigSection, which editor-upsert calls on every cf-config open) and the wizard's
//        source step. They share one bare `.catch()` that wrote ONE row for seven states, two of which are
//        not faults.
//   THE 403 FAMILY and THE EDGE 5xx are driven across the two corners where the classification used to
//        invert: a 403 that the engine itself refused, a 403 from a WAF or a foreign host at the engine's
//        address, and Cloudflare's own HTML error page in front of a console worker that never ran.
//   THE AUDIT RENDERER is driven over a recovery actor with a null email -- what a mistyped email on the
//        public recovery form produces -- and asserts the console does not file it as "a newer engine".
//   THE SCREEN CONTROLS are driven with real browser events (per-character `input`, then `blur`) and assert
//        the count matches what happened: the operator who succeeds records ONE refusal, not nine.
//
// Run with `node test/validate-support-posture-gaps-r6.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import {
  cfRediscoverThrowClass,
  cfSurfaceListThrowClass,
  featureOutcomeForError,
  reset as resetRing,
  setActiveScreen,
  snapshot,
} from "../src/lib/client-diag/ring.ts";
import { EngineClient } from "../src/lib/api/client.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { listRoles } from "../src/lib/api/client-rbac.ts";
import { setProxiedTopology } from "../src/lib/api/topology.ts";
import { adoptProxiedTopology } from "../src/lib/store.ts";
import { buildCfConfigSection } from "../src/screens/sources-downpipes/editor-cf-config-section.ts";
import { openCreateWizard } from "../src/screens/sources-downpipes/editor-wizard.ts";
import { buildScheduleSection } from "../src/screens/sources-downpipes/editor-schedule.ts";
import { actorIdentifier, actorMethodLabel } from "../src/screens/access-security/audit-display.ts";
import { renderAuditEvents } from "../src/screens/access-security/audit-events.ts";
import { samlForm } from "../src/screens/idp-connections/saml-form.ts";
import { CONSOLE_ORIGIN_FAULT, CONSOLE_ORIGIN_FAULT_HEADER } from "../src/lib/errors.ts";
import type { AuditEvent, AuditPage } from "../src/api.ts";
import type { ClientDiagnosticRecord } from "../src/lib/client-diag/vocab.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq<T>(label: string, got: T, want: T): void {
  const pass = got === want;
  console.log(pass ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!pass) failures++;
}

const rows = (): ClientDiagnosticRecord[] => snapshot().records;
const rowsOf = (kind: string): ClientDiagnosticRecord[] => rows().filter((r) => r.kind === kind);

const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input instanceof Request ? input.url : input), init))) as unknown as typeof fetch;
}
function stubRejectingFetch(): void {
  globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
}

// THE BYTES REAL SERVERS SEND. Every response below is what one of the systems in front of, or at, the engine's
// address actually answers. None of them is a shape invented for this test.
const ACCESS_LOGIN = (): Response =>
  // Cloudflare Access does NOT answer a lapsed session with a 401: it serves its login page. This console is
  // Access-fenced, so this is the ordinary overnight tab.
  new Response("<!doctype html><html><head><title>Sign in</title></head><body>Cloudflare Access</body></html>", { status: 302, headers: { "content-type": "text/html" } });
const HTML_404 = (): Response =>
  // A static host, an SPA shell or a proxy at the engine's address: nothing is deployed there.
  new Response("<!doctype html><html><body>Not found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
const CONSOLE_OWN_500 = (): Response =>
  // The console worker's own last-resort handler (worker.ts): its dispatch threw, or the bound ENGINE binding's
  // fetch rejected. The engine received nothing.
  new Response("internal error", { status: 500, headers: { [CONSOLE_ORIGIN_FAULT_HEADER]: CONSOLE_ORIGIN_FAULT } });
const EDGE_HTML_500 = (): Response =>
  // Cloudflare's OWN error page (1101/1102/1027) in front of a console worker that never ran: over its limits,
  // script gone, an edge fault. No header of ours can be on it, because our code did not run.
  new Response("<!doctype html><html><body>Worker threw an exception (Error 1101)</body></html>", { status: 500, headers: { "content-type": "text/html" } });
const ENGINE_500 = (): Response =>
  new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
const ENGINE_403_CAPABILITY = (): Response =>
  // The engine's capability gate: it names the capability it wanted.
  new Response(JSON.stringify({ error: "forbidden", required: "downpipes:write" }), { status: 403, headers: { "content-type": "application/json" } });
const ENGINE_403_AUTHZ = (): Response =>
  // The DO's anti-enumeration AuthError funnel: it names nothing, deliberately.
  new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
const EDGE_403_HTML = (): Response =>
  // The customer's own WAF (Cloudflare error 1020) in front of a healthy engine, AND, byte for byte, a static
  // host or bucket refusing at an address where NO ENGINE IS DEPLOYED. The console cannot tell those apart and
  // must not pretend to.
  new Response("<!doctype html><html><body>Access denied (Error 1020)</body></html>", { status: 403, headers: { "content-type": "text/html" } });
const ENGINE_429 = (): Response =>
  new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json" } });
const ENGINE_401 = (): Response =>
  new Response(JSON.stringify({ error: "unauthorised" }), { status: 401, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------------------------------------
// THE FAILING CATALOGUE READ. One bare `.catch()`, one member, seven states, on BOTH of its entry points.
// ---------------------------------------------------------------------------------------------------------
async function g243(): Promise<void> {
  console.log("\n-- the surface list did not load: WHY, and (twice) whether anything is wrong at all --");
  setActiveScreen("/downpipes");

  const existing = {
    id: "dp-cf",
    name: "cf",
    enabled: true,
    cadenceSeconds: 86400,
    source: { type: "cf-config", accountId: "acct", include: ["dns"], cfConfigMode: "manual" },
  };

  // THE REAL EDITOR ENTRY POINT: editor-upsert.ts calls buildCfConfigSection on every cf-config editor open, and
  // the section re-reads the catalogue with the REAL EngineClient over the REAL transport.
  const openEditor = async (r: (() => Response) | null): Promise<void> => {
    if (r === null) stubRejectingFetch();
    else stubFetch(() => r());
    const engine = new EngineClient("https://engine.example");
    buildCfConfigSection(engine, existing as never, undefined, true);
    await new Promise((res) => setTimeout(res, 0));
    globalThis.fetch = realFetch;
  };

  const openWith = async (r: (() => Response) | null): Promise<ClientDiagnosticRecord[]> => {
    resetRing();
    await openEditor(r);
    return rowsOf("catalogue-degraded");
  };

  // THE TWO STATES THAT MUST WRITE NO ROW AT ALL, and the lapsed session is the commonest editor open in the console.
  eq("(NOISE): a LAPSED ACCESS SESSION (the overnight tab) records NOTHING", (await openWith(ACCESS_LOGIN)).length, 0);
  eq("(NOISE): a 401 records NOTHING (the operator is signed out, the catalogue is not broken)", (await openWith(ENGINE_401)).length, 0);

  // FIVE STATES, FIVE REMEDIES, FIVE ROWS, where the classifier used to collapse them into one row,
  // cf-surface-list-unreadable, with one count over all of them and over the two above.
  eq("a web page at the engine's address is not-an-engine (fix the ADDRESS)", (await openWith(HTML_404))[0]?.catalogueClass, "cf-surface-list-not-an-engine");
  eq("the ENGINE'S OWN 403 is denied (fix the ROLE; the engine answered, so its address is fine)", (await openWith(ENGINE_403_CAPABILITY))[0]?.catalogueClass, "cf-surface-list-denied");
  eq("a 403 that did NOT speak the engine's refusal vocabulary is refused-at-edge (an edge rule, or no engine there at all)", (await openWith(EDGE_403_HTML))[0]?.catalogueClass, "cf-surface-list-refused-at-edge");
  eq("a 429 is rate-limited (nothing is wrong: retry, and never rotate the token)", (await openWith(ENGINE_429))[0]?.catalogueClass, "cf-surface-list-rate-limited");
  eq("a dropped call is transport", (await openWith(null))[0]?.catalogueClass, "cf-surface-list-transport");

  // the console's own 500 goes to the RESIDUAL and never to transport or to the engine: no request reached
  // any engine, and the feature-probe and transport rows in the same ring name the console-side fault.
  eq("the CONSOLE'S OWN 500 is the residual (nothing established anything about the engine)", (await openWith(CONSOLE_OWN_500))[0]?.catalogueClass, "cf-surface-list-unreadable");

  // THE COALESCING TO GUARD AGAINST: four of the states into ONE ring, which would happen if they were
  // byte-identical on every tuple-key field (kind, screen, catalogueClass) and merged into a single count of 4.
  resetRing();
  await openEditor(ACCESS_LOGIN);
  await openEditor(HTML_404);
  await openEditor(EDGE_403_HTML);
  await openEditor(ENGINE_429);
  eq("three faults and one healthy overnight tab are THREE rows, not one count of four", rowsOf("catalogue-degraded").length, 3);
  ok("...and no row was written for the lapsed session", rowsOf("catalogue-degraded").every((r) => r.catalogueClass !== "cf-surface-list-unreadable"));

  // (NOISE): the read SUCCEEDS. Nothing at all, however often the editor opens.
  resetRing();
  const good = (): Response =>
    new Response(JSON.stringify({ bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: true, accounts: [{ accountId: "a", accountName: "A", zones: [] }], cfConfigSurfaces: [{ id: "dns", label: "DNS", category: "zone", scope: "zone" }] }), { status: 200, headers: { "content-type": "application/json" } });
  await openEditor(good);
  await openEditor(good);
  eq("(NOISE): two opens against a healthy engine record NOTHING", rowsOf("catalogue-degraded").length, 0);

  // ---- THE SIBLING ENTRY POINT: THE WIZARD'S SOURCE STEP, which makes the SAME call. When it throws, the
  // Cloudflare-configuration offer is withheld entirely (the operator cannot even add the source), and it
  // recorded nothing at all.
  const openWizard = async (r: () => Response): Promise<void> => {
    stubFetch(() => r());
    const engine = new EngineClient("https://engine.example");
    openCreateWizard(engine, null, new Set<string>(), () => {}, () => {});
    await new Promise((res) => setTimeout(res, 0));
    globalThis.fetch = realFetch;
  };

  resetRing();
  await openWizard(HTML_404);
  eq("(THE SIBLING): the WIZARD's failing catalogue read records the same classified row", rowsOf("catalogue-degraded")[0]?.catalogueClass, "cf-surface-list-not-an-engine");

  resetRing();
  await openWizard(ACCESS_LOGIN);
  eq("(THE SIBLING, NOISE): a lapsed Access session in the WIZARD records NOTHING either", rowsOf("catalogue-degraded").length, 0);

  // The classifier itself, over the same throws, is the twin of the rediscover one and returns null for exactly
  // the two states that must write no row.
  eq("the classifier returns null for a lapsed Access session", cfSurfaceListThrowClass(new Error("discover: access-redirect")), null);
}

// ---------------------------------------------------------------------------------------------------------
// THE 403 FAMILY (the discriminator sits in the throw), AND THE EDGE 5xx.
// ---------------------------------------------------------------------------------------------------------
async function g250(): Promise<void> {
  console.log("\n-- who refused the call: the engine, the customer's edge, or nothing that is there --");
  setActiveScreen("/access/security");

  const thrown = async (r: (() => Response) | null): Promise<unknown> => {
    if (r === null) stubRejectingFetch();
    else stubFetch(() => r());
    try {
      await listRoles(new Transport("https://engine.example"));
      throw new Error("expected a throw");
    } catch (e) {
      return e;
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  // THE 403 FAMILY. Four refusals answer 403 to the same call, and a classifier that ignores the discriminator
  // in the throw would tell support the remedy is "a permission or an edge rule, NEVER the engine's address" --
  // wrong in the one case where the address IS the fault.
  const capabilityErr = await thrown(ENGINE_403_CAPABILITY);
  const authzErr = await thrown(ENGINE_403_AUTHZ);
  const edgeErr = await thrown(EDGE_403_HTML);
  eq("the engine's CAPABILITY refusal is forbidden (the engine answered: the remedy is a role)", featureOutcomeForError(capabilityErr), "forbidden");
  eq("the engine's AUTHZ funnel is forbidden too (it also answered)", featureOutcomeForError(authzErr), "forbidden");
  eq("a refusal that did not speak the engine's vocabulary is refused-not-by-engine", featureOutcomeForError(edgeErr), "refused-not-by-engine");
  ok("the engine's own 403 and an edge/foreign-host 403 are NOT the same verdict", featureOutcomeForError(capabilityErr) !== featureOutcomeForError(edgeErr));

  // ...and they do not coalesce in the ring: the tuple key separates them, so the count is not one number over
  // two opposite remedies.
  resetRing();
  const ring = await import("../src/lib/client-diag/ring.ts");
  for (const e of [capabilityErr, edgeErr]) {
    const outcome = featureOutcomeForError(e);
    if (outcome !== null) ring.recordFeatureProbe("roles-table", outcome);
  }
  eq("an engine role denial and an edge refusal on the same table are TWO rows", rowsOf("feature-probe").length, 2);

  // THE SAME SPLIT ON THE SIBLING CLASSIFIER (the cf rediscover), where cf-rediscover-denied must not say "the
  // engine refused this caller's role" for a WAF block page or for a static host with no engine behind it.
  eq("(sibling): the engine's own 403 on the rediscover is still cf-rediscover-denied", cfRediscoverThrowClass(capabilityErr), "cf-rediscover-denied");
  eq("(sibling): an edge 403 on the rediscover is cf-rediscover-refused-at-edge", cfRediscoverThrowClass(edgeErr), "cf-rediscover-refused-at-edge");

  // THE EDGE 5xx. THE REAL TOPOLOGY DECLARATION, adopted the way the app adopts it at boot (app.ts calls
  // adoptProxiedTopology, which reads /engine-topology.json off the serving worker).
  setProxiedTopology(false);
  stubFetch(() => new Response(JSON.stringify({ proxied: true }), { status: 200, headers: { "content-type": "application/json" } }));
  const adopted = await adoptProxiedTopology();
  globalThis.fetch = realFetch;
  ok("the console adopted the PROXIED topology from the serving worker's own declaration", adopted);

  resetRing();
  const edge500Err = await thrown(EDGE_HTML_500);
  eq("(edge 5xx): Cloudflare's HTML error page in front of the CONSOLE is console-origin-fault, not server-error", featureOutcomeForError(edge500Err), "console-origin-fault");
  const call = rowsOf("engine-call")[0];
  eq("(edge 5xx): ...and the engine-call row agrees: network/transport, no request reached the engine", `${call?.httpClass}/${call?.faultClass}`, "network/transport");

  resetRing();
  const engine500Err = await thrown(ENGINE_500);
  eq("(NOISE): a 5xx THE ENGINE answered is still server-error (only here is the remedy the engine's logs)", featureOutcomeForError(engine500Err), "server-error");
  const call2 = rowsOf("engine-call")[0];
  eq("(NOISE): ...and its engine-call row is 5xx/server", `${call2?.httpClass}/${call2?.faultClass}`, "5xx/server");

  // THE SPLIT TOPOLOGY. There the same page is most often Cloudflare's 1101 in front of a REAL, BROKEN engine, so
  // the console does not make the claim: the reading reverts to the one it can defend.
  setProxiedTopology(false);
  const split500Err = await thrown(EDGE_HTML_500);
  eq("(split topology): the same page is read as an engine 5xx, because there it can be one", featureOutcomeForError(split500Err), "server-error");
  setProxiedTopology(false);

  // REDACTION: not a byte of any body rides. The throw carries the frozen product token or the bare status, and
  // the 403 carries only the closed forbidden-class member.
  const msg = String((edgeErr as Error).message);
  ok("REDACTION: the 403 throw carries the closed class only, never the block page", msg.includes("forbidden-class=not-engine-body") && !msg.toLowerCase().includes("access denied"));
  ok("REDACTION: the edge 5xx throw carries the frozen token only, never the error page", String((edge500Err as Error).message).includes(CONSOLE_ORIGIN_FAULT) && !String((edge500Err as Error).message).includes("1101"));
}

// ---------------------------------------------------------------------------------------------------------
// a CURRENT engine and a CURRENT console must not emit "a newer engine has added an auth path".
// ---------------------------------------------------------------------------------------------------------
function g289(): void {
  console.log("\n-- a mistyped email on the recovery form is not a newer engine --");
  setActiveScreen("/access/security");

  const event = (actorMethod: string, actorEmail: string | null): AuditEvent =>
    ({
      id: `e-${actorMethod}`,
      ts: "2026-07-13T02:00:00.000Z",
      action: "recovery-code-used",
      outcome: "failed",
      actorEmail,
      actorMethod,
      sourceIp: null,
      target: { kind: "downpipe", id: "dp", name: "dp" },
    }) as unknown as AuditEvent;

  const page = (e: AuditEvent): AuditPage => ({ events: [e], nextCursor: null }) as unknown as AuditPage;
  const render = (e: AuditEvent): ClientDiagnosticRecord[] => {
    resetRing();
    renderAuditEvents(new EngineClient("https://engine.example"), page(e), {} as never, () => {});
    return rowsOf("contract-skew");
  };

  // THE PRODUCER (engine scheduler-do-recovery.ts, the failed branch of the PUBLIC /admin/auth/recovery route):
  // a mistyped email writes an audit event with actorMethod "recovery" and actorEmail null. Any scanner spraying
  // that endpoint writes one too. The route is unauthenticated by design: it IS a sign-in path.
  eq("a recovery actor with no email records NOTHING (never 'a NEWER engine has added an auth path')", render(event("recovery", null)).length, 0);
  eq("an oidc actor records nothing", render(event("oidc", null)).length, 0);
  eq("a saml actor records nothing", render(event("saml", null)).length, 0);

  // ...and the SIBLING SITE: the Method column must not render all three as the ENGINE having done it, which would
  // attribute a human sign-in through the customer's IdP on screen to the cron.
  eq("(the sibling): a recovery sign-in is LABELLED as one, not as engine-observed", actorMethodLabel("recovery"), "via recovery code (break-glass)");
  eq("(the sibling): an oidc sign-in is labelled as one", actorMethodLabel("oidc"), "via SSO (OIDC)");
  eq("(the sibling): a saml sign-in is labelled as one", actorMethodLabel("saml"), "via SSO (SAML)");
  eq("(the sibling): an engine-initiated event is still engine-observed", actorMethodLabel("engine"), "engine-observed");
  eq("the actor identifier names the method rather than 'unknown method'", actorIdentifier(event("recovery", null)), "recovery");

  // THE ONE STATE THE ROW ACTUALLY MEANS: an auth method OUTSIDE the console's own closed union. Only a newer
  // engine can send one, and that is what the vocabulary says the row is.
  const skew = render(event("mtls-device", null));
  eq("an auth method outside the console's OWN union still records contract-skew", skew[0]?.fieldFamily, "audit-method");
  eq("...as unknown-enum-member", skew[0]?.contractClass, "unknown-enum-member");
  eq("...exactly once per render (one recorder, not two)", skew[0]?.count, 1);
  ok("REDACTION: the row carries no method string, no email and no value", skew[0] !== undefined && !JSON.stringify(skew[0]).includes("mtls-device"));
}

// ---------------------------------------------------------------------------------------------------------
// the count must track the fault. Real controls, real per-character `input`, real `blur`.
// ---------------------------------------------------------------------------------------------------------
function fire(control: HTMLElement, kind: string): void {
  const ev = { type: kind, target: null, currentTarget: null, defaultPrevented: false, bubbles: false, preventDefault(): void {}, stopPropagation(): void {} };
  (control as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(ev);
}
function type(control: HTMLElement, value: string): void {
  // What a browser fires: one `input` event per character, on the control's own value.
  (control as HTMLInputElement).value = "";
  for (const ch of value) {
    (control as HTMLInputElement).value += ch;
    fire(control, "input");
  }
}
function paste(control: HTMLElement, value: string): void {
  (control as HTMLInputElement).value = value;
  fire(control, "input");
}
function blur(control: HTMLElement): void {
  fire(control, "blur");
}

function g335(): void {
  console.log("\n-- the operator who SUCCEEDED must not look more stuck than the one who is --");
  setActiveScreen("/access/idp");

  // THE REAL SAML CONNECT FORM, mounted by the real screen module, and the real IdP SSO URL control inside it.
  // Nothing here is a fixture: the validator is the one saml-form.ts gives that field.
  const form = samlForm(new EngineClient("https://engine.example"), () => {});
  const sso = form.querySelector("#saml-idp-sso") as HTMLElement | null;
  ok("the real SAML form mounted its SSO URL control", sso !== null);
  if (sso === null) return;

  // THE OPERATOR SUCCEEDS. Pastes the URL without its scheme, sees the refusal on blur, clears the box, types
  // the correct one CHARACTER BY CHARACTER. Every prefix of "https://idp..." is invalid, so every keystroke could
  // write another refusal row, on a connection that SAVED.
  resetRing();
  paste(sso, "idp.acme-health.example/app/sso/saml");
  blur(sso);
  type(sso, "https://idp.acme-health.example/app/sso/saml");
  blur(sso);
  const w = rowsOf("form-rejected");
  eq("the operator who fixed the URL and saved records ONE refusal, not nine", w[0]?.count, 1);
  eq("...the one they actually SAW and stopped on", w[0]?.formField, "saml-idp-sso");
  eq("...and the corrected value leaves the box clean (the final blur adds nothing)", rowsOf("form-rejected").length, 1);

  // THE OPERATOR IS GENUINELY STUCK. Pastes three URLs the console will not take, gives up, rings support.
  resetRing();
  for (const bad of ["http://idp.acme-health.example/sso", "idp.acme-health.example", "ldap://idp.acme-health.example"]) {
    paste(sso, bad);
    blur(sso);
  }
  const s = rowsOf("form-rejected");
  eq("the operator who is STUCK records three refusals, one per value they left in the box", s[0]?.count, 3);

  // NO INVERSION: the stuck operator must out-count the one who succeeded, which is the whole of the
  // ticket's "how often" clause.
  ok("stuck (3) reads as MORE evidence than succeeded (1), never as a fraction of it", (s[0]?.count ?? 0) > (w[0]?.count ?? 0));

  // THE SAME FUNNEL, A SECOND REAL SCREEN CONTROL: the downpipe editor's cron box, built by the real
  // buildScheduleSection. It is field.ts, not one screen.
  setActiveScreen("/downpipes");
  resetRing();
  const sched = buildScheduleSection(undefined);
  const cron = (sched.el.querySelector("#dp-sched-cron") ?? sched.el.querySelector("[id='dp-sched-cron']")) as HTMLElement | null;
  ok("the real schedule section built its cron control", cron !== null);
  if (cron !== null) {
    paste(cron, "0 2 * *");
    blur(cron);
    type(cron, "0 2 * * *");
    blur(cron);
    const c = rowsOf("form-rejected");
    eq("(second control): backspacing and retyping a VALID cron records ONE refusal, not seven", c[0]?.count, 1);
    eq("(second control): ...on the cron field", c[0]?.formField, "dp-sched-cron");
  }

  // NOISE: a value that is right first time records nothing at all, however many keystrokes it took.
  setActiveScreen("/access/idp");
  resetRing();
  const clean = samlForm(new EngineClient("https://engine.example"), () => {}).querySelector("#saml-idp-sso") as HTMLElement;
  type(clean, "https://idp.acme-health.example/app/sso/saml");
  blur(clean);
  eq("(NOISE): a URL typed correctly first time records NOTHING", rowsOf("form-rejected").length, 0);
}

async function main(): Promise<void> {
  await g243();
  await g250();
  g289();
  g335();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

void main();
