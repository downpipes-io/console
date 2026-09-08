// TC-sessions-passkeys: the three new engine admin surfaces wired into the console:
//   1. SESSION MANAGEMENT  (ASVS V7.4.5 / V7.5.2): terminate-others / terminate-user / terminate-all
//   2. PASSKEY CREDENTIALS (ASVS V6.5.6): list + revoke (with the sole-Owner-last-passkey refusal)
//   3. RETENTION           (ASVS V14.2.7): the per-downpipe { keepRuns?, keepDays?, enforce? } policy
//      that ROUND-TRIPS through POST /admin/downpipes
//
// Run with: node test/validate-sessions-passkeys.ts
//
// Like validate-api.ts / validate-config-changes.ts, this drives the REAL EngineClient methods over a
// captured global fetch (it never re-implements the client), and exercises the REAL pure helpers in the
// two screens (validateRetention / retentionSummary in sources-downpipes.ts; canTerminateUserSessions /
// canTerminateAllSessions in access-security.ts). None of the imported modules execute DOM at import
// time, so importing the screens under plain node succeeds; the one section that DOES need a DOM (the
// sign-out regression below) installs the shared dom-shim first, like validate-destinations.ts.
//
// Coverage:
//   api.ts methods (REAL client, captured fetch):
//     - terminateOtherSessions  -> POST /admin/sessions/terminate-others, no body, { ok } parsed
//     - terminateUserSessions   -> POST /admin/sessions/terminate-user, body { email }, { ok } parsed
//     - terminateAllSessions    -> POST /admin/sessions/terminate-all, no body, { ok } parsed
//     - listPasskeyCredentials  -> GET  /admin/passkey/credentials (own) and ?email= (admin), parsed
//     - deletePasskeyCredential -> POST /admin/passkey/credentials/delete, body { credentialId }
//     - deletePasskeyCredential surfaces the engine's sole-Owner last-passkey REFUSAL honestly
//       (the 4xx { error } reason is folded into the thrown message, not a generic failure)
//     - deletePasskeyCredential retries a step-up 401 via gatedFetch, like every other STEPUP_SUBS
//       route (ASVS V7.5.1): gatedFetch must not be bypassed, misreading the 401 as a sign-out)
//     - every session/passkey body is no-custody (an email or a credential id at most; never a key)
//   retention round-trip (REAL addDownpipe, captured fetch):
//     - a downpipe with retention { keepRuns, keepDays, enforce } POSTs the retention VERBATIM
//     - a downpipe WITHOUT retention POSTs no retention field (keep-everything default preserved)
//   retention pure helpers (sources-downpipes.ts):
//     - validateRetention mirrors the engine bounds (>=1 limit; integer ranges; boolean enforce)
//     - retentionSummary is HONEST about the deletion gate (enforced vs report-only vs keep-all)
//   session gating helpers (access-security.ts), the can()-gating of the admin actions:
//     - canTerminateUserSessions == can(role, "roles.write") (owner AND access-admin; not the rest)
//     - canTerminateAllSessions  == owner only
//   AuditAction mirror: the three new actions are present in the union (used by the audit filter)
//   Sign-out regression (REAL render over the dom-shim, ASVS V7.4.5): the "Sign out everyone" break-glass
//   success handler (sessions-passkeys.ts allSessionsAction) calls the REAL signOut() -- which clears
//   the caller, engine client and entity/search caches -- not goSignedOut(), which only re-routes and
//   would otherwise leave the just-ended operator's identity and cached fleet data resident in the tab

import {
  EngineClient,
  RETENTION_MAX_KEEP_RUNS,
  RETENTION_MAX_KEEP_DAYS,
  type Downpipe,
  type RetentionPolicy,
  type AuditAction,
  type Caller,
} from "../src/api.ts";
import { can, type Role } from "../src/lib/identity.ts";
import { csrfEcho } from "../src/lib/api/client-session.ts";
import { validateRetention, retentionSummary } from "../src/screens/sources-downpipes.ts";
import { canTerminateUserSessions, canTerminateAllSessions } from "../src/screens/access-security.ts";
import { coseAlgLabel, sessionsAndPasskeysSection } from "../src/screens/access-security/sessions-passkeys.ts";
import { AUDIT_ACTION_OPTIONS } from "../src/screens/access-security/audit-display.ts";
import { setCaller } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { installDomShim, qs, qsa, flushAsync, textOf } from "./dom-shim.ts";
import { findButtonByText, click } from "./validate-stable-components-shared.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// captureFetch installs a global fetch that records the request (path/method/body) and answers a single
// canned Response, so a REAL EngineClient method exercises the real parse path. Returns the capture +
// a restore function. status drives ok; body is the JSON the route returns.
interface Captured { path: string; method: string; body: unknown }
function captureFetch(status: number, body: unknown): { cap: Captured; restore: () => void } {
  const cap: Captured = { path: "", method: "GET", body: undefined };
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    cap.path = String(input);
    cap.method = init?.method ?? "GET";
    cap.body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(body); },
      async json() { return body; },
      clone() { return this; },
    };
  };
  return { cap, restore: () => { g.fetch = prev; } };
}

// scriptFetch installs a global fetch that answers a scripted TWO-CALL sequence: `first` for the initial
// request, `second` for the step-up retry (if gatedFetch runs one). Unlike captureFetch (one canned
// response), this is needed for the step-up regression below: it records each call's headers so the
// retry's x-downpipes-stepup header can be asserted, matching validate-stepup-dest-idp.ts's helper of
// the same name for the sibling destination/IdP/session-termination mutations.
interface StepUpCall { headers: Record<string, string> }
function scriptFetch(first: { status: number; body: unknown }, second?: { status: number; body: unknown }): { calls: StepUpCall[]; restore: () => void } {
  const calls: StepUpCall[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = async (_input: unknown, init?: { headers?: unknown }) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v;
    else if (h && typeof h === "object") for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    calls.push({ headers });
    const which = calls.length === 1 ? first : (second ?? first);
    return {
      ok: which.status >= 200 && which.status < 300,
      status: which.status,
      async text() { return JSON.stringify(which.body); },
      async json() { return which.body; },
      clone() { return this; },
    };
  };
  return { calls, restore: () => { g.fetch = prev; } };
}

async function main(): Promise<void> {
  const engine = new EngineClient("https://engine.test");


  // ------------------------------------------------------------------------
  console.log("\n-- CSRF ECHO: the double-submit header the terminate-* calls attach --");
  // ------------------------------------------------------------------------
  {
    // csrfEcho parses the engine-issued readable cookie and returns the exact header entry the
    // engine's csrfBlock compares in constant time. Driven via the injectable cookie string so the
    // vectors are deterministic in Node (in the browser it reads document.cookie; absent -> {}).
    const hit = csrfEcho("theme=dark; __Host-downpipes_csrf=tok_abc123; other=1");
    ok("csrfEcho finds the token among other cookies", hit["x-downpipes-csrf"] === "tok_abc123");
    ok("csrfEcho emits exactly one header entry", Object.keys(hit).length === 1);
    ok("csrfEcho ignores unrelated cookies", Object.keys(csrfEcho("session=abc; theme=dark")).length === 0);
    ok("csrfEcho on an empty token value emits nothing", Object.keys(csrfEcho("__Host-downpipes_csrf=")).length === 0);
    ok("csrfEcho on an empty cookie header emits nothing", Object.keys(csrfEcho("")).length === 0);
    // In this Node harness there is no document, so the zero-arg form is a no-op: the three
    // terminate-* wire captures above therefore carried NO x-downpipes-csrf header, which is also
    // the correct bearer-session behaviour (the engine exempts non-cookie-borne methods).
    ok("csrfEcho with no source (Node harness / bearer session) emits nothing", Object.keys(csrfEcho()).length === 0);
  }
  // ------------------------------------------------------------------------
  console.log("\n-- SESSION MANAGEMENT (V7.4.5 / V7.5.2): terminate-* wire contracts --");
  // ------------------------------------------------------------------------
  {
    // terminate-others: POST, no body, { ok } parsed.
    const { cap, restore } = captureFetch(200, { ok: true });
    const res = await engine.terminateOtherSessions().finally(restore);
    ok("terminateOtherSessions POSTs to /admin/sessions/terminate-others", cap.path.endsWith("/admin/sessions/terminate-others"));
    eq("terminateOtherSessions uses POST", cap.method, "POST");
    ok("terminateOtherSessions sends no body (no-custody)", cap.body === undefined);
    eq("terminateOtherSessions parses { ok }", res.ok, true);
  }
  {
    // terminate-user: POST, body is EXACTLY { email }, { ok } parsed.
    const { cap, restore } = captureFetch(200, { ok: true });
    const res = await engine.terminateUserSessions("Person@Example.com").finally(restore);
    ok("terminateUserSessions POSTs to /admin/sessions/terminate-user", cap.path.endsWith("/admin/sessions/terminate-user"));
    eq("terminateUserSessions uses POST", cap.method, "POST");
    eq("terminateUserSessions body carries the email", (cap.body as { email?: string } | undefined)?.email, "Person@Example.com");
    const keys = cap.body && typeof cap.body === "object" ? Object.keys(cap.body as object) : [];
    ok("terminateUserSessions body has exactly one field (email only, no-custody)", keys.length === 1 && keys[0] === "email");
    eq("terminateUserSessions parses { ok }", res.ok, true);
  }
  {
    // terminate-all: POST, no body, { ok } parsed.
    const { cap, restore } = captureFetch(200, { ok: true });
    const res = await engine.terminateAllSessions().finally(restore);
    ok("terminateAllSessions POSTs to /admin/sessions/terminate-all", cap.path.endsWith("/admin/sessions/terminate-all"));
    eq("terminateAllSessions uses POST", cap.method, "POST");
    ok("terminateAllSessions sends no body (no-custody)", cap.body === undefined);
    eq("terminateAllSessions parses { ok }", res.ok, true);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- PASSKEY CREDENTIALS (V6.5.6): list + revoke wire contracts --");
  // ------------------------------------------------------------------------
  {
    // list (own): GET /admin/passkey/credentials with NO email param; the redacted view is parsed.
    const sample = { credentials: [{ credentialId: "AAAAbbbbCCCCddddEEEE", createdAt: "2026-01-02T03:04:05Z", aaguid: "ZZZZ", transports: ["internal", "hybrid"], alg: -7 }] };
    const { cap, restore } = captureFetch(200, sample);
    const res = await engine.listPasskeyCredentials().finally(restore);
    ok("listPasskeyCredentials (own) GETs /admin/passkey/credentials with no email", cap.path.endsWith("/admin/passkey/credentials"));
    eq("listPasskeyCredentials uses GET", cap.method, "GET");
    eq("listPasskeyCredentials parses the redacted credential row", res.credentials[0]?.credentialId, "AAAAbbbbCCCCddddEEEE");
    eq("listPasskeyCredentials parses the COSE alg id", res.credentials[0]?.alg, -7);
    // No-custody: the row carries only public/redaction-safe fields; never a private/public key value.
    const rowKeys = res.credentials[0] ? Object.keys(res.credentials[0]) : [];
    ok("a credential row carries no key material (no-custody)", !rowKeys.includes("publicKey") && !rowKeys.includes("privateKey") && !rowKeys.includes("key") && !rowKeys.includes("coseKey"));
  }
  {
    // list (admin, by email): the email is carried as a query param, URL-encoded.
    const { cap, restore } = captureFetch(200, { credentials: [] });
    await engine.listPasskeyCredentials("other@example.com").finally(restore);
    ok("listPasskeyCredentials (admin) carries ?email=", cap.path.includes("email=other%40example.com"));
  }
  {
    // revoke: POST, body EXACTLY { credentialId }, { deleted } parsed.
    const { cap, restore } = captureFetch(200, { deleted: true });
    const res = await engine.deletePasskeyCredential("cred-123").finally(restore);
    ok("deletePasskeyCredential POSTs to /admin/passkey/credentials/delete", cap.path.endsWith("/admin/passkey/credentials/delete"));
    eq("deletePasskeyCredential uses POST", cap.method, "POST");
    eq("deletePasskeyCredential body carries the credentialId", (cap.body as { credentialId?: string } | undefined)?.credentialId, "cred-123");
    const keys = cap.body && typeof cap.body === "object" ? Object.keys(cap.body as object) : [];
    ok("deletePasskeyCredential body has exactly one field (credentialId only)", keys.length === 1 && keys[0] === "credentialId");
    eq("deletePasskeyCredential parses { deleted }", res.deleted, true);
  }
  {
    // The sole-Owner-last-passkey REFUSAL: a 4xx { error } must surface the engine's OWN reason in the
    // thrown message (honest), NOT a bare "<verb>: <status>". This is the V6.5.6 last-Owner guard UX.
    const refusal = "cannot revoke the last passkey of the sole Owner; enrol another key or appoint a second Owner first";
    const { restore } = captureFetch(400, { error: refusal });
    let threw: unknown;
    try {
      await engine.deletePasskeyCredential("cred-owner-last");
    } catch (e) {
      threw = e;
    } finally {
      restore();
    }
    const msg = threw instanceof Error ? threw.message : String(threw);
    ok("deletePasskeyCredential threw on the last-Owner refusal", threw !== undefined);
    ok("the thrown message carries the engine's honest refusal reason", msg.includes(refusal));
  }
  {
    // deletePasskeyCredential (V7.5.1) must route through gatedFetch like every other STEPUP_SUBS route: a
    // stale-but-valid session's step-up 401 must trigger the WebAuthn ceremony via gatedFetch, never fall
    // through to classifyError as a generic "unauthorised" that bounces the operator to sign-in instead of
    // completing the ceremony -- which would revoke nothing on the click that matters most (a
    // suspected-compromised device's key). Here a wired ceremony must complete the retry and the credential
    // must actually be revoked on the first call.
    const engine = new EngineClient("https://engine.test");
    let ceremonyRuns = 0;
    engine.onStepUpRequired = async () => { ceremonyRuns++; return "stepuptoken-deadbeef"; };
    const { calls, restore } = scriptFetch({ status: 401, body: { stepUpRequired: true } }, { status: 200, body: { deleted: true } });
    const res = await engine.deletePasskeyCredential("cred-stale-session").finally(restore);
    eq("deletePasskeyCredential: the step-up ceremony ran exactly once", ceremonyRuns, 1);
    eq("deletePasskeyCredential: two requests were made (original + step-up retry)", calls.length, 2);
    ok("deletePasskeyCredential: the first request carried no step-up header", calls[0]?.headers["x-downpipes-stepup"] === undefined);
    eq("deletePasskeyCredential: the retry carried the single-use step-up token", calls[1]?.headers["x-downpipes-stepup"], "stepuptoken-deadbeef");
    eq("deletePasskeyCredential: the retried revoke parses { deleted: true } (NOT a sign-out)", res.deleted, true);
  }
  {
    // With no ceremony wired, a step-up 401 must still surface (not loop/retry) -- gatedFetch's documented
    // no-handler behaviour, unchanged by this fix.
    const engine = new EngineClient("https://engine.test");
    const { calls, restore } = scriptFetch({ status: 401, body: { stepUpRequired: true } });
    let threw: unknown;
    try {
      await engine.deletePasskeyCredential("cred-no-ceremony");
    } catch (e) {
      threw = e;
    } finally {
      restore();
    }
    ok("deletePasskeyCredential: no ceremony wired -> a step-up 401 does not retry (one request)", calls.length === 1);
    ok("deletePasskeyCredential: no ceremony wired -> the 401 still surfaces to the caller", threw !== undefined);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- RETENTION (V14.2.7): the config round-trips through addDownpipe --");
  // ------------------------------------------------------------------------
  const baseDownpipe: Downpipe = {
    id: "dp-test",
    name: "Test",
    cadenceSeconds: 86400,
    enabled: true,
    source: { type: "kv", binding: "KV_x", include: [], exclude: [] },
  };
  {
    // A downpipe WITH a retention policy POSTs the policy VERBATIM (the engine validates it server-side).
    const retention: RetentionPolicy = { keepRuns: 10, keepDays: 30, enforce: true };
    const { cap, restore } = captureFetch(200, { config: { ...baseDownpipe, retention }, nextRunAt: 0, lastRunId: null, inFlight: false });
    await engine.addDownpipe({ ...baseDownpipe, retention }).finally(restore);
    ok("addDownpipe POSTs to /admin/downpipes", cap.path.endsWith("/admin/downpipes"));
    eq("addDownpipe round-trips the retention policy verbatim", (cap.body as { retention?: RetentionPolicy } | undefined)?.retention, retention);
  }
  {
    // A downpipe WITHOUT retention sends NO retention field (keep-everything default unchanged).
    const { cap, restore } = captureFetch(200, { config: baseDownpipe, nextRunAt: 0, lastRunId: null, inFlight: false });
    await engine.addDownpipe(baseDownpipe).finally(restore);
    ok("addDownpipe without retention sends no retention field", (cap.body as { retention?: unknown } | undefined)?.retention === undefined);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- RETENTION pure helpers: validateRetention mirrors the engine bounds --");
    eq("validateRetention(undefined) is valid (keep-everything default)", validateRetention(undefined), null);
    ok("validateRetention rejects an empty policy (needs at least one limit)", validateRetention({}) !== null);
    eq("validateRetention accepts keepRuns alone", validateRetention({ keepRuns: 10 }), null);
    eq("validateRetention accepts keepDays alone", validateRetention({ keepDays: 30 }), null);
    eq("validateRetention accepts both + enforce", validateRetention({ keepRuns: 10, keepDays: 30, enforce: true }), null);
    ok("validateRetention rejects keepRuns 0 (below 1)", validateRetention({ keepRuns: 0 }) !== null);
    ok("validateRetention rejects a non-integer keepRuns", validateRetention({ keepRuns: 1.5 }) !== null);
    ok("validateRetention rejects keepRuns above the backstop", validateRetention({ keepRuns: RETENTION_MAX_KEEP_RUNS + 1 }) !== null);
    eq("validateRetention accepts keepRuns at the backstop", validateRetention({ keepRuns: RETENTION_MAX_KEEP_RUNS }), null);
    ok("validateRetention rejects keepDays 0 (below 1)", validateRetention({ keepDays: 0 }) !== null);
    ok("validateRetention rejects keepDays above the backstop", validateRetention({ keepDays: RETENTION_MAX_KEEP_DAYS + 1 }) !== null);
    eq("validateRetention accepts keepDays at the backstop", validateRetention({ keepDays: RETENTION_MAX_KEEP_DAYS }), null);
    // A NaN entry (a non-integer field the editor passes through) is rejected, not silently accepted.
    ok("validateRetention rejects NaN keepRuns (a non-integer field)", validateRetention({ keepRuns: NaN }) !== null);

  // ------------------------------------------------------------------------
  console.log("\n-- RETENTION pure helpers: retentionSummary is honest about the gate --");
  // ------------------------------------------------------------------------
  {
    eq("retentionSummary(undefined) says keep everything", retentionSummary(undefined), "Keeps every run; no automatic deletion.");
    eq("retentionSummary({}) (no limits) says keep everything", retentionSummary({}), "Keeps every run; no automatic deletion.");
    // Enforced: must say deletion is ENFORCED (the destructive truth).
    const enforced = retentionSummary({ keepRuns: 10, enforce: true });
    ok("enforced summary names the run window", enforced.includes("10 most recent runs"));
    ok("enforced summary says deletion is enforced", /deletion enforced/i.test(enforced));
    ok("enforced summary is not mislabelled report-only", !/report-only/i.test(enforced));
    // Report-only (enforce absent / false): must say report-only, NEVER claim deletion.
    const report = retentionSummary({ keepRuns: 10 });
    ok("report-only summary says report-only", /report-only/i.test(report));
    ok("report-only summary does NOT claim deletion is enforced", !/deletion enforced/i.test(report));
    const reportFalse = retentionSummary({ keepDays: 30, enforce: false });
    ok("enforce:false is treated as report-only (honest)", /report-only/i.test(reportFalse));
    // Both limits joined by "or" (the union the engine keeps).
    const both = retentionSummary({ keepRuns: 10, keepDays: 30 });
    ok("both-limits summary joins the window with 'or'", both.includes("10 most recent runs or runs from the last 30 days"));
    // Singular grammar.
    ok("retentionSummary uses singular 'run' for keepRuns:1", retentionSummary({ keepRuns: 1 }).includes("1 most recent run;") || retentionSummary({ keepRuns: 1 }).includes("most recent run;"));
    ok("retentionSummary uses singular 'day' for keepDays:1", retentionSummary({ keepDays: 1 }).includes("last 1 day"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- SESSION gating: the can()-gating of the admin session actions --");
  // ------------------------------------------------------------------------
  {
    // canTerminateUserSessions MUST equal can(role, "roles.write") for every role, so the console gate is
    // the engine gate (owner AND access-admin hold roles.write; the rest do not).
    const roles: Role[] = ["viewer", "operator", "approver", "owner", "restore-operator", "access-admin"];
    for (const r of roles) {
      eq(`canTerminateUserSessions(${r}) == can(${r}, roles.write)`, canTerminateUserSessions(r), can(r, "roles.write"));
    }
    ok("terminate-user allowed for owner", canTerminateUserSessions("owner") === true);
    ok("terminate-user allowed for access-admin", canTerminateUserSessions("access-admin") === true);
    ok("terminate-user DENIED for operator", canTerminateUserSessions("operator") === false);
    ok("terminate-user DENIED for approver", canTerminateUserSessions("approver") === false);
    ok("terminate-user DENIED for viewer", canTerminateUserSessions("viewer") === false);
    ok("terminate-user DENIED for restore-operator", canTerminateUserSessions("restore-operator") === false);

    // canTerminateAllSessions is OWNER ONLY (the engine additionally requires callerRole === owner).
    for (const r of roles) {
      eq(`canTerminateAllSessions(${r}) is owner-only`, canTerminateAllSessions(r), r === "owner");
    }
    ok("terminate-all allowed ONLY for owner", canTerminateAllSessions("owner") === true && canTerminateAllSessions("access-admin") === false);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- sign-out regression (V7.4.5): 'Sign out everyone' success calls the REAL signOut() --");
  // ------------------------------------------------------------------------
  {
    // Drives the REAL sessionsAndPasskeysSection render + the REAL confirmModal over the shared dom-shim
    // (same approach as validate-destinations.ts), so this exercises the actual click handler, not a
    // reimplementation of it. installDomShim is idempotent, so calling it here (after the plain-node
    // sections above have already run) is safe.
    installDomShim();
    setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true } as Caller);

    let signOutCalls = 0;
    let onUnauthorisedCalls = 0;
    installNav({
      navigate: () => undefined,
      onUnauthorised: () => { onUnauthorisedCalls++; },
      refreshIdentity: async () => undefined,
      onAuthenticated: async () => undefined,
      signOut: () => { signOutCalls++; },
    });

    let terminateAllCalls = 0;
    const fakeEngine = {
      // passkeysCard's mount-time load() calls this; an empty list keeps that path a no-op.
      async listPasskeyCredentials() { return { credentials: [] }; },
      async terminateAllSessions() { terminateAllCalls++; return { ok: true }; },
    } as unknown as EngineClient;

    const section = sessionsAndPasskeysSection(fakeEngine);
    const signOutEveryoneBtn = findButtonByText(section, "Sign out everyone");
    ok("the 'Sign out everyone' break-glass button renders for an owner caller", signOutEveryoneBtn !== undefined);
    // terminate-all rotates the session signing key, which is ALSO the recovery-code HMAC key (engine
    // recovery.ts reuses the same in-DO secret), so it invalidates every member's recovery codes. The warning
    // beside the button must disclose that consequence, not only the session sign-out.
    ok("the break-glass warning states recovery codes are invalidated", textOf(section).toLowerCase().includes("recovery cod"));
    if (signOutEveryoneBtn) click(signOutEveryoneBtn);
    await flushAsync();

    // confirmModal's danger confirm is itself labelled "Sign out everyone"; scoped to the modal surface
    // so the lookup cannot re-match the card's own trigger button already clicked above.
    const surface = qs(document.body, ".dialog--modal");
    ok("the break-glass confirm modal opened", surface !== null);
    ok("the confirm modal states recovery codes are invalidated (not only the session sign-out)", surface !== null && textOf(surface).toLowerCase().includes("recovery cod"));
    const confirmBtn = surface ? findButtonByText(surface, "Sign out everyone") : undefined;
    ok("the confirm modal has a 'Sign out everyone' confirm action", confirmBtn !== undefined);
    if (confirmBtn) click(confirmBtn);
    await flushAsync();

    eq("terminateAllSessions was actually called", terminateAllCalls, 1);
    // The load-bearing assertions: the success path must take the REAL sign-out (clearing caller/engine/
    // caches), never the bare 401-reroute idiom, which would leave the ex-operator's identity and cached
    // fleet data resident in the tab.
    eq("the success path calls the REAL signOut(), not goSignedOut()", signOutCalls, 1);
    eq("the success path never calls onUnauthorised (that idiom is for a LAPSED session, not this one)", onUnauthorisedCalls, 0);
    // The success toast must state recovery codes are now invalid and must be regenerated, so the
    // operator does not discover it only when a code fails at the next break-glass sign-in.
    const bodyText = textOf(document.body).toLowerCase();
    ok("the success toast states recovery codes are invalid and must be regenerated", bodyText.includes("recovery cod") && bodyText.includes("regenerate"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the admin danger block is BUILT collapsed, and refused (not merely hidden) for a viewer --");
  // ------------------------------------------------------------------------
  {
    // The admin danger block must not merely LOOK collapsed while a viewer can still reach a hidden control:
    // the shell swaps the main region inside a View Transition update callback the browser runs
    // asynchronously (shell/app-shell.ts setMain), so a check that runs too early can read the screen it
    // just left. This asserts what the screen BUILDS, graded straight off the constructed DOM, independent
    // of any browser or navigation timing.
    //
    // TWO CLAIMS, and they are not the same claim:
    //   1. COLLAPSED. sessionsAndPasskeysSection wraps the admin levers in collapsedSection(..., { tone:
    //      "danger" }) with no `open`, so the rarely-used destructive surface presents demoted (7a) rather
    //      than standing expanded at full width. It is a calm-density choice, and it is NOT a gate.
    //   2. REFUSED, NOT HIDDEN. The gate is that a caller without the capability gets no control CONSTRUCTED
    //      at all: memberSessionsAction returns after its reason when roles.write is absent, allSessionsAction
    //      returns after its reason when the caller is not Owner. So even a block forced open by a devtools
    //      toggle hands a viewer nothing to click. Asserted here per role, because "collapsed" alone would
    //      pass just as well over a block that quietly held a live danger button behind a disclosure arrow.
    // The engine agrees independently and is the enforcement: terminate-user re-resolves roles.write in the DO
    // plus the owner-escalation guard, terminate-all is Owner-only, and both are in STEPUP_SUBS.
    installDomShim();
    const listEngine = { async listPasskeyCredentials() { return { credentials: [] }; } } as unknown as EngineClient;
    const SUMMARY = "Admin: sign out members";

    // Non-vacuity for the whole block: the capability ladder must actually differ by role, otherwise every
    // "absent" below would pass over a section that rendered nothing at all.
    const built: Record<string, { emailField: boolean; memberBtn: boolean; allBtn: boolean }> = {};
    for (const role of ["viewer", "access-admin", "owner"] as const) {
      setCaller({ method: "access", email: `${role}@example.com`, role, groups: [], isOnlyOwner: role === "owner" } as Caller);
      const section = sessionsAndPasskeysSection(listEngine);
      const blocks = qsa(section, "details.disclosure").filter((d) => textOf(qs(d, "summary") ?? d).includes(SUMMARY));
      eq(`${role}: the section builds exactly one "${SUMMARY}" disclosure`, blocks.length, 1);
      const block = blocks[0];
      if (!block) continue;
      ok(`${role}: it carries the danger tone (a rarely-used destructive block)`, (block.getAttribute("class") ?? "").split(/\s+/).includes("disclosure--danger"));
      // THE COLLAPSED-STATE ASSERTION. `open` is an attribute the constructor either sets or does not; collapsedSection
      // emits it only for { open: true }, so its absence is the whole claim. Read as an attribute rather than
      // a property because the shim builds elements, not a live <details>.
      ok(`${role}: it is built COLLAPSED (no open attribute), not standing expanded`, !block.hasAttribute("open"));
      built[role] = {
        emailField: qs(block, "#terminate-user-email") !== null,
        memberBtn: qs(block, '[data-dp="access-security.button.member-sessions-action"]') !== null,
        allBtn: qs(block, '[data-dp="access-security.button.all-sessions-action"]') !== null,
      };
      // The levers live INSIDE the disclosure, never beside it, so opening the block is the only way to reach
      // them and the counts above are the counts for the whole section.
      eq(`${role}: no admin lever is built outside the disclosure`, [qs(section, "#terminate-user-email") !== null, qs(section, '[data-dp="access-security.button.member-sessions-action"]') !== null, qs(section, '[data-dp="access-security.button.all-sessions-action"]') !== null], [built[role]?.emailField, built[role]?.memberBtn, built[role]?.allBtn]);
      const txt = textOf(block);
      if (role === "viewer") {
        ok("viewer: the member lever is REFUSED with a reason, not silently missing", txt.includes("Requires permission to manage roles"));
        ok("viewer: the terminate-all lever is REFUSED with a reason", txt.includes("Requires the Owner role"));
      }
    }
    // A viewer gets NOTHING live inside the block: not a disabled control, no control.
    eq("viewer: no live member email field, member button or danger button is built", built.viewer, { emailField: false, memberBtn: false, allBtn: false });
    // NON-VACUITY: the same render DOES build the member lever for an access-admin and both levers for an
    // Owner, so the viewer's three falses are the capability gate and not an empty section.
    eq("access-admin: the member lever IS built (roles.write held), the danger button is not", built["access-admin"], { emailField: true, memberBtn: true, allBtn: false });
    eq("owner: both levers are built", built.owner, { emailField: true, memberBtn: true, allBtn: true });
  }

  // ------------------------------------------------------------------------
  console.log("\n-- AuditAction mirror: the three new actions are in the union --");
  // ------------------------------------------------------------------------
  {
    // The TypeScript annotation below is the compile-time guard (tsc rejects any string that is not a
    // member of the AuditAction union). The runtime check verifies the same three actions are present in
    // the screen's runtime option list, so removing one from the audit screen is caught by the runner too.
    const actions: AuditAction[] = ["session-terminate", "passkey-credential-revoke", "retention-prune"];
    for (const a of actions) {
      ok(`AUDIT_ACTION_OPTIONS lists ${a}`, AUDIT_ACTION_OPTIONS.includes(a));
    }
  }

  // ------------------------------------------------------------------------
  console.log("\n-- coseAlgLabel: COSE algorithm id to label (V6.5.6 passkey inventory) --");
    eq("ES256 (-7)", coseAlgLabel(-7), "ES256");
    eq("Ed25519 (-8)", coseAlgLabel(-8), "Ed25519");
    eq("ES384 (-35)", coseAlgLabel(-35), "ES384");
    eq("ES512 (-36)", coseAlgLabel(-36), "ES512");
    eq("RS256 (-257)", coseAlgLabel(-257), "RS256");
    // An unknown alg shows the raw number rather than guessing a label.
    eq("unknown alg shows the raw id", coseAlgLabel(-99), "COSE alg -99");

  // ------------------------------------------------------------------------
  console.log(failures === 0 ? "\nAll session/passkey/retention checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-SESSIONS-PASSKEYS THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
