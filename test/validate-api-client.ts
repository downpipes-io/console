// validate-api: the preflight + support + native-IdP EngineClient methods (fetch-stubbed).
//
// These drive the REAL EngineClient against a recording fetch stub, asserting the exact
// route, verb, auth header, credentials mode and body shape each method emits, and that
// responses pass through VERBATIM (the client never re-derives a verdict and never drops
// the one-time secret fields). No network is touched.

import {
  EngineClient,
  isOwnerActionAppliedResult,
} from "../src/api.ts";

import type { Harness } from "./validate-api-shared.ts";

export async function runClient(h: Harness): Promise<void> {
  const ok = h.ok.bind(h);
  const eq = h.eq.bind(h);

  console.log("\n-- preflight + support client methods (fetch-stubbed) --");

  interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    credentials: string | undefined;
  }
  const calls: RecordedCall[] = [];
  const last = (): RecordedCall => {
    const c = calls[calls.length - 1];
    if (!c) throw new Error("no recorded fetch call");
    return c;
  };
  let nextResponse: () => Response = () => new Response("{}", { status: 200 });
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string },
  ) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? init.body : null,
      credentials: init?.credentials,
    });
    return nextResponse();
  }) as typeof fetch;

  try {
    const client = new EngineClient("https://engine.example.com", "tok123");

    // ---- preflight: GET /admin/preflight, report passed through verbatim ----
    const report = {
      generatedAt: "2026-06-10T00:00:00.000Z",
      engineVersion: "1.2.3",
      summary: { required: 5, requiredVerified: 4, failed: 1 },
      items: [
        { id: "destination", name: "Archive destination", requires: "an R2 bucket binding (R2 subscription)", required: true, status: "failed", evidence: "the destination probe failed (boom)", remediation: "check the bucket exists" },
        { id: "signer", name: "Run signer key", requires: "the key ceremony", required: true, status: "verified", evidence: "the signer key parses (64-byte seed form)" },
      ],
    };
    nextResponse = () => new Response(JSON.stringify(report), { status: 200 });
    const gotReport = await client.preflight();
    eq(last().url, "https://engine.example.com/admin/preflight", "preflight hits GET /admin/preflight");
    eq(last().method, "GET", "preflight is a GET");
    eq(last().headers.authorization, "Bearer tok123", "preflight carries the bearer in the authorization header");
    eq(last().credentials, "include", "preflight sends credentials:include (the Access cookie)");
    eq(JSON.stringify(gotReport), JSON.stringify(report), "preflight report passes through VERBATIM (statuses never re-derived)");
    ok("preflight: a failed item stays failed on the client side", gotReport.items[0]!.status === "failed");

    // preflight non-2xx throws the named verb + status (never a fabricated report).
    nextResponse = () => new Response("nope", { status: 500 });
    let threw = "";
    try {
      await client.preflight();
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    eq(threw, "preflight: 500", "preflight non-2xx throws verb + status");

    // ---- getSupport: GET /admin/support, grant views + null pass through ----
    const support = {
      vendorSealConfigured: true,
      accessPerimeter: true,
      diagnostics: {
        clientId: "dpc_abc",
        scope: "diagnostics",
        grantedAt: "2026-06-01T00:00:00.000Z",
        grantedBy: "owner@example.com",
        expiresAt: "2026-06-04T00:00:00.000Z",
        expired: false,
        pulls: [{ at: "2026-06-02T00:00:00.000Z" }],
      },
      auditFeed: null,
    };
    nextResponse = () => new Response(JSON.stringify(support), { status: 200 });
    const gotSupport = await client.getSupport();
    eq(last().url, "https://engine.example.com/admin/support", "getSupport hits GET /admin/support");
    eq(last().method, "GET", "getSupport is a GET");
    ok("getSupport: the accessPerimeter flag passes through", gotSupport.accessPerimeter === true);
    ok("getSupport: a null grant stays null (no fabricated grant)", gotSupport.auditFeed === null);
    eq(gotSupport.diagnostics?.clientId, "dpc_abc", "getSupport passes the grant view through");
    eq(gotSupport.diagnostics?.pulls.length, 1, "getSupport passes the pull trail through");
    ok("getSupport grant view carries NO secret field", !("secret" in (gotSupport.diagnostics as object)) && !("secretSha384" in (gotSupport.diagnostics as object)));

    // ---- mintSupportCredential: POST /admin/support/credentials --------------
    const minted = {
      scope: "diagnostics",
      clientId: "dpc_abc",
      secret: "dps_secret",
      bearer: "dpc_abc.dps_secret",
      expiresAt: "2026-06-13T00:00:00.000Z",
      note: "the secret is shown once and stored only as a hash; revoke and re-mint to rotate",
    };
    nextResponse = () => new Response(JSON.stringify(minted), { status: 200 });
    const gotMint = await client.mintSupportCredential("diagnostics");
    eq(last().url, "https://engine.example.com/admin/support/credentials", "mint hits POST /admin/support/credentials");
    eq(last().method, "POST", "mint is a POST");
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      eq(body.scope, "diagnostics", "mint body carries the scope");
      ok("mint body omits ttlSeconds when not supplied (engine default applies)", !("ttlSeconds" in body));
    }
    // mintSupportCredential is an OWNER-ACTION the dual-control gate may defer: a 200 resolves to an
    // applied OwnerActionResult { status:"result", value } (the byte-unchanged success path), NOT a bare body.
    ok("mint 200 resolves to an APPLIED owner-action result (status=result)", gotMint.status === "result");
    const mintedApplied = gotMint.status === "result" ? gotMint.value : null;
    eq(mintedApplied?.secret, "dps_secret", "mint passes the ONE-TIME secret through untouched");
    eq(mintedApplied?.bearer, "dpc_abc.dps_secret", "mint passes the single-bearer form through");

    // mint with an explicit ttl carries it; scope audit-feed reaches the wire.
    nextResponse = () => new Response(JSON.stringify({ ...minted, scope: "audit-feed" }), { status: 200 });
    await client.mintSupportCredential("audit-feed", 3600);
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      eq(body.scope, "audit-feed", "mint body carries the audit-feed scope");
      eq(body.ttlSeconds, 3600, "mint body carries the supplied ttlSeconds");
    }

    // With org dual control armed the engine QUEUES the mint (202 ownerActionQueued) and generates NO
    // secret. The client must resolve that to a queued result the screen surfaces as "queued for a second
    // owner", never an applied credential (whose fields would be undefined) the reveal would frame "copy now".
    nextResponse = () => new Response(JSON.stringify({ ownerActionQueued: true, id: "oa_mint_1", status: "pending" }), { status: 202 });
    const queuedMint = await client.mintSupportCredential("diagnostics");
    ok("mint 202 resolves to a QUEUED owner-action result, never an applied secret", queuedMint.status === "queued");
    ok("the queued mint exposes NO credential value (nothing to reveal)", !("value" in queuedMint));
    eq(queuedMint.status === "queued" ? queuedMint.queued.id : "", "oa_mint_1", "the queued mint carries the owner-action id for the inbox link");

    // mint denied (the engine's Owner gate) throws verb + status; nothing is invented.
    nextResponse = () => new Response(JSON.stringify({ error: "forbidden", required: "owner" }), { status: 403 });
    threw = "";
    try {
      await client.mintSupportCredential("diagnostics");
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    // mintSupportCredential is an OWNER-ACTION route (parseJsonOrOwnerAction), so a non-2xx folds the
    // engine's plain { error } reason in the "<verb>: <reason>: <status>" form exactly as setDestination /
    // setLicence do, NOT parseJson's capability-class shape. The trailing status is still the last token so
    // extractStatus and classifyError are unchanged, and no byte beyond the coarse reason rides.
    eq(threw, "mint support credential: forbidden: 403", "mint 403 (the owner gate) throws verb + the engine reason + status");

    // ---- revokeSupportCredential: POST /admin/support/credentials/delete -----
    nextResponse = () => new Response(JSON.stringify({ ok: true, scope: "audit-feed" }), { status: 200 });
    const gotRevoke = await client.revokeSupportCredential("audit-feed");
    eq(last().url, "https://engine.example.com/admin/support/credentials/delete", "revoke hits POST /admin/support/credentials/delete");
    eq(last().method, "POST", "revoke is a POST");
    eq(JSON.parse(last().body ?? "{}").scope, "audit-feed", "revoke body carries the scope");
    ok("revoke returns the engine's ok", gotRevoke.ok === true);

    // ---- getSupportBundle: GET /admin/support/bundle, raw text verbatim ------
    const bundleText = '{"kind":"downpipe-support-bundle-sealed","v":1,"ciphertext":"abc"}';
    nextResponse = () => new Response(bundleText, { status: 200 });
    const gotBundle = await client.getSupportBundle();
    eq(last().url, "https://engine.example.com/admin/support/bundle", "bundle hits GET /admin/support/bundle");
    eq(gotBundle, bundleText, "bundle returns the RAW text verbatim (saved as a file unchanged)");

    // bundle non-2xx throws the named verb + status.
    nextResponse = () => new Response("unavailable", { status: 503 });
    threw = "";
    try {
      await client.getSupportBundle();
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    eq(threw, "support bundle: 503", "bundle non-2xx throws verb + status");

    // ---- push destination client methods (fetch-stubbed) ---------------------
    // getPush: GET /admin/push, the redacted view (never a secret field) passes through verbatim.
    const pushView = {
      present: true,
      endpoint: "https://http-intake.logs.example.com/api/v2/logs",
      format: "datadog",
      authHeaderName: "DD-API-KEY",
      enabled: true,
      setBy: "owner@example.com",
      setAt: "2026-07-01T00:00:00.000Z",
      lastPushedSeq: 100,
      headSeq: 104,
      trail: [{ at: "2026-07-02T00:00:00.000Z", ok: true, httpStatus: 202, count: 4, fromSeq: 100, toSeq: 104 }],
    };
    nextResponse = () => new Response(JSON.stringify(pushView), { status: 200 });
    const gotPush = await client.getPush();
    eq(last().url, "https://engine.example.com/admin/push", "getPush hits GET /admin/push");
    eq(last().method, "GET", "getPush is a GET");
    eq(gotPush.endpoint, pushView.endpoint, "getPush passes the endpoint through");
    ok("getPush view carries NO secret field", !("authHeaderValue" in (gotPush as object)) && !("secret" in (gotPush as object)));

    // setPush: POST /admin/push, gated + owner-action aware. A 200 resolves to an applied result carrying
    // the updated view; the body carries the submitted input verbatim (including the WRITE-ONLY secret,
    // sent on this call only).
    nextResponse = () => new Response(JSON.stringify({ ...pushView, enabled: false }), { status: 200 });
    const setRes = await client.setPush({ endpoint: pushView.endpoint, format: "datadog", authHeaderName: "DD-API-KEY", authHeaderValue: "dd-secret", enabled: false });
    eq(last().url, "https://engine.example.com/admin/push", "setPush hits POST /admin/push");
    eq(last().method, "POST", "setPush is a POST");
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      eq(body.authHeaderValue, "dd-secret", "setPush body carries the WRITE-ONLY secret (sent on set only)");
      eq(body.enabled, false, "setPush body carries the enabled flag");
    }
    ok("setPush (200) resolves to an applied result, not queued", isOwnerActionAppliedResult(setRes));
    ok(
      "setPush applied result carries the updated view and no secret",
      isOwnerActionAppliedResult(setRes) && setRes.value.enabled === false && !("authHeaderValue" in (setRes.value as object)),
    );

    // setPush omits authHeaderValue entirely when the caller does not supply one (the enable/disable
    // toggle path: the sealed secret is left untouched server-side).
    nextResponse = () => new Response(JSON.stringify(pushView), { status: 200 });
    await client.setPush({ endpoint: pushView.endpoint, format: "datadog", authHeaderName: "DD-API-KEY", enabled: true });
    ok("setPush omits authHeaderValue when not supplied", !("authHeaderValue" in (JSON.parse(last().body ?? "{}") as object)));

    // clearPush: POST /admin/push/delete, no dual control (closing an egress is the safe direction).
    nextResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const gotClear = await client.clearPush();
    eq(last().url, "https://engine.example.com/admin/push/delete", "clearPush hits POST /admin/push/delete");
    eq(last().method, "POST", "clearPush is a POST");
    ok("clearPush returns the engine's ok", gotClear.ok === true);

    // testPush: POST /admin/push/test, the honest synthetic-send outcome passes through verbatim.
    nextResponse = () => new Response(JSON.stringify({ ok: false, httpStatus: 401, reason: "unauthorized" }), { status: 200 });
    const gotTest = await client.testPush();
    eq(last().url, "https://engine.example.com/admin/push/test", "testPush hits POST /admin/push/test");
    eq(last().method, "POST", "testPush is a POST");
    ok("testPush passes the honest failure outcome through verbatim", gotTest.ok === false && gotTest.httpStatus === 401 && gotTest.reason === "unauthorized");

    // ---- installKeys: POST /admin/keys/install (the no-customer-CLI key install) --------------
    // The console hands the engine the in-browser ceremony material + a one-shot scoped token; the
    // engine writes its OWN secrets. Assert the exact route/verb/auth/credentials, the body shape
    // (token + the private values + optional operational), and that the engine's redaction-safe
    // response (signerPublic + presence booleans) passes through verbatim. The engine NEVER echoes
    // the token or a private value, so the response carries only the public + booleans.
    nextResponse = () => new Response(JSON.stringify({ ok: true, signerPublic: "PUB_b64url", configured: { signer: true, breakGlass: true, operational: true } }), { status: 200 });
    const gotInstall = await client.installKeys({ token: "cfat-tok", signerPrivate: "SIGNER_PRIV_b64", breakGlassPublic: "BG_PUB_b64", operationalPublic: "OP_PUB_b64", operationalPrivate: "OP_PRIV_b64" });
    eq(last().url, "https://engine.example.com/admin/keys/install", "installKeys hits POST /admin/keys/install");
    eq(last().method, "POST", "installKeys is a POST");
    eq(last().headers.authorization, "Bearer tok123", "installKeys carries the bearer");
    eq(last().credentials, "include", "installKeys sends credentials:include");
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      eq(body.token, "cfat-tok", "installKeys body carries the one-shot token");
      eq(body.signerPrivate, "SIGNER_PRIV_b64", "installKeys body carries the signer private");
      eq(body.breakGlassPublic, "BG_PUB_b64", "installKeys body carries the break-glass public");
      eq(body.operationalPublic, "OP_PUB_b64", "installKeys body carries the operational public when supplied");
      eq(body.operationalPrivate, "OP_PRIV_b64", "installKeys body carries the operational private when supplied");
    }
    eq(gotInstall.signerPublic, "PUB_b64url", "installKeys passes the PUBLIC signerPublic through verbatim");
    ok("installKeys passes the presence booleans through", gotInstall.configured.signer === true && gotInstall.configured.operational === true);

    // Without an operational pair, the optional fields are OMITTED from the body (not sent empty).
    nextResponse = () => new Response(JSON.stringify({ ok: true, signerPublic: "PUB2", configured: { signer: true, breakGlass: true, operational: false } }), { status: 200 });
    await client.installKeys({ token: "cfat-tok", signerPrivate: "S2", breakGlassPublic: "BG2" });
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      ok("installKeys omits operationalPublic when absent", !("operationalPublic" in body));
      ok("installKeys omits operationalPrivate when absent", !("operationalPrivate" in body));
    }

    // A refusal (a bad key, or a token missing the Workers-edit scope) surfaces the engine's coarse,
    // value-free reason via readErrorReason (verb: reason: status), never a fabricated success.
    nextResponse = () => new Response(JSON.stringify({ error: "the signer private did not parse (expected base64url ed25519 seed(32) || ML-DSA-87 seed(32) = 64 bytes); nothing was set" }), { status: 400 });
    threw = "";
    try {
      await client.installKeys({ token: "cfat-tok", signerPrivate: "bad", breakGlassPublic: "BG" });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    ok("installKeys refusal surfaces the engine's coarse reason (verb + reason + status)", /^install keys: the signer private did not parse/.test(threw) && /: 400$/.test(threw));

    // ---- passkey ceremonies: the bearer rides on REGISTER (bootstrap proof), never on LOGIN ----
    // The engine authorises every enrolment by PROOF and the first-Owner bootstrap on an empty role
    // table accepts ONLY a valid ADMIN_TOKEN bearer, so the two register methods send this.headers()
    // (the in-memory bearer when the operator connected with one). The login ceremonies ARE the
    // sign-in: they stay bearer-free even when a token is in memory. This is the console half of the
    // first-Owner bootstrap; without the bearer an empty engine refuses register with reason:forbidden.
    nextResponse = () => new Response(JSON.stringify({ ok: false, reason: "forbidden" }), { status: 200 });
    await client.passkeyRegisterBegin("first@example.com");
    eq(last().url, "https://engine.example.com/admin/auth/register/begin", "register/begin hits POST /admin/auth/register/begin");
    eq(last().method, "POST", "register/begin is a POST");
    eq(last().headers.authorization, "Bearer tok123", "register/begin carries the connected bearer (the first-Owner bootstrap proof)");
    eq(last().credentials, "include", "register/begin still sends credentials:include (a live session outranks the bearer engine-side)");
    eq(JSON.parse(last().body ?? "{}").email, "first@example.com", "register/begin body carries the email");

    const wireAttestation = {
      id: "Y3JlZA", rawId: "Y3JlZA", type: "public-key",
      response: { clientDataJSON: "Y2Q", attestationObject: "YW8" },
    } as unknown as Parameters<EngineClient["passkeyRegisterFinish"]>[1];
    nextResponse = () => new Response(JSON.stringify({ ok: true, email: "first@example.com", bootstrapped: true, role: "owner" }), { status: 200 });
    await client.passkeyRegisterFinish("first@example.com", wireAttestation);
    eq(last().url, "https://engine.example.com/admin/auth/register/finish", "register/finish hits POST /admin/auth/register/finish");
    eq(last().headers.authorization, "Bearer tok123", "register/finish carries the connected bearer too (begin and finish are both proof-gated)");

    nextResponse = () => new Response(JSON.stringify({ ok: false, reason: "challenge" }), { status: 200 });
    await client.passkeyLoginBegin("first@example.com");
    eq(last().url, "https://engine.example.com/admin/auth/login/begin", "login/begin hits POST /admin/auth/login/begin");
    ok("login/begin carries NO bearer (the sign-in is unauthenticated by necessity)", last().headers.authorization === undefined);

    const wireAssertion = {
      id: "Y3JlZA", rawId: "Y3JlZA", type: "public-key",
      response: { clientDataJSON: "Y2Q", authenticatorData: "YWQ", signature: "c2ln" },
    } as unknown as Parameters<EngineClient["passkeyLoginFinish"]>[1];
    nextResponse = () => new Response(JSON.stringify({ ok: false, reason: "unknown_credential" }), { status: 200 });
    await client.passkeyLoginFinish("ch1", wireAssertion);
    eq(last().url, "https://engine.example.com/admin/auth/login/finish", "login/finish hits POST /admin/auth/login/finish");
    ok("login/finish carries NO bearer (the sign-in is unauthenticated by necessity)", last().headers.authorization === undefined);

    const tokenless = new EngineClient("https://engine.example.com");
    nextResponse = () => new Response(JSON.stringify({ ok: false, reason: "forbidden" }), { status: 200 });
    await tokenless.passkeyRegisterBegin("first@example.com");
    ok("register/begin carries NO bearer when none is connected (an empty engine then refuses the bootstrap honestly)", last().headers.authorization === undefined);

    // ---- Native external-IdP SSO client methods --------------------------------------------------
    // These drive the REAL IdP methods against the recording fetch, pinning the exact route, verb, auth
    // header, body shape and the WRITE-ONLY secret discipline (a redacted connection NEVER carries a
    // value), plus the pure start-URL builders the sign-in buttons navigate to.
    console.log("\n-- native external-IdP SSO client methods (fetch-stubbed) --");

    // idpProviders: the PRE-AUTH sign-in read. NO bearer (it is the sign-in), credentials:include, and
    // the providers list passes through verbatim (the screen renders one button each).
    const providersBody = { ok: true, providers: [{ id: "entra", label: "Microsoft Entra", kind: "oidc", presetId: "entra" }, { id: "corp-saml", label: "Corp SAML", kind: "saml", presetId: "generic-saml" }] };
    nextResponse = () => new Response(JSON.stringify(providersBody), { status: 200 });
    const gotProviders = await client.idpProviders();
    eq(last().url, "https://engine.example.com/admin/oidc/providers", "idpProviders hits GET /admin/oidc/providers");
    eq(last().method, "GET", "idpProviders is a GET");
    ok("idpProviders carries NO bearer (the sign-in is unauthenticated by necessity)", last().headers.authorization === undefined);
    eq(last().credentials, "include", "idpProviders sends credentials:include");
    eq(gotProviders.providers.length, 2, "idpProviders passes the enabled providers through verbatim");
    eq(gotProviders.providers[1]!.kind, "saml", "idpProviders preserves the saml kind");

    // idpPresets: OWNER management read (keys.ceremony). Carries the bearer; the catalogue passes through.
    const presetsBody = { ok: true, presets: [{ id: "okta", label: "Okta", vendor: "Okta", buttonLabel: "Sign in with Okta", kind: "oidc", requiredVars: [{ key: "oktaDomain", label: "Okta domain", example: "your-org.okta.com" }], notes: ["Enable group claims"], docsUrl: "https://example.test" }] };
    nextResponse = () => new Response(JSON.stringify(presetsBody), { status: 200 });
    const gotPresets = await client.idpPresets();
    eq(last().url, "https://engine.example.com/admin/idp/presets", "idpPresets hits GET /admin/idp/presets");
    eq(last().headers.authorization, "Bearer tok123", "idpPresets carries the owner bearer (keys.ceremony management read)");
    eq(gotPresets.presets[0]!.requiredVars[0]!.key, "oktaDomain", "idpPresets passes requiredVars through verbatim");

    // idpConnections: the redacted management list. A connection's secret is a { mode } descriptor with
    // no value — assert no `value`/secret string ever appears on the wire shape.
    const connsBody = { ok: true, connections: [{ id: "entra", label: "Microsoft Entra", enabled: true, presetId: "entra", createdBy: "owner@example.com", createdAt: "2026-06-14T00:00:00.000Z", kind: "oidc", issuer: "https://login.microsoftonline.com/x/v2.0", clientId: "abc", secretRef: { mode: "do-plaintext" }, scopes: ["openid"], pkce: "required", clientAuth: "client_secret_post" }] };
    nextResponse = () => new Response(JSON.stringify(connsBody), { status: 200 });
    const gotConns = await client.idpConnections();
    eq(last().url, "https://engine.example.com/admin/idp/connections", "idpConnections hits GET /admin/idp/connections");
    eq(last().headers.authorization, "Bearer tok123", "idpConnections carries the owner bearer");
    const c0 = gotConns.connections[0]!;
    ok("idpConnections: a redacted connection carries the secret MODE, never a value", c0.kind === "oidc" && c0.secretRef.mode === "do-plaintext" && !("value" in (c0.secretRef as object)) && !("secret" in (c0 as object)));

    // createIdpConnection (preset path): the flat {presetId, vars, id, clientId, secret, secretMode}
    // body. The WRITE-ONLY secret rides in the request body and is NEVER returned (the redacted conn
    // carries only {mode}). A normal 200 resolves to an OwnerActionResult { status:"result", value }
    // where value is the engine's { ok:true, conn } (the gate-off path; a 202 would instead be a "queued"
    // owner action surfaced for a second owner, exercised in validate-owner-actions.ts).
    nextResponse = () => new Response(JSON.stringify({ ok: true, conn: connsBody.connections[0] }), { status: 200 });
    const createRes = await client.createIdpConnection({ presetId: "okta", vars: { oktaDomain: "x.okta.com" }, id: "okta", label: "Okta", clientId: "cid", secret: "shh-secret", secretMode: "do-plaintext" });
    eq(last().url, "https://engine.example.com/admin/idp/connections", "createIdpConnection (preset) hits POST /admin/idp/connections");
    eq(last().method, "POST", "createIdpConnection is a POST");
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      eq(body.presetId, "okta", "create (preset) body carries presetId");
      eq((body.vars as Record<string, string>).oktaDomain, "x.okta.com", "create (preset) body carries vars");
      eq(body.clientId, "cid", "create (preset) body carries clientId");
      eq(body.secret, "shh-secret", "create (preset) body carries the WRITE-ONLY secret (sent on create only)");
      ok("create (preset) body is sent FLAT (no { proposal } wrapper for the preset path)", !("proposal" in body));
    }
    ok("createIdpConnection (200) resolves to an applied result, not queued", isOwnerActionAppliedResult(createRes));
    ok("createIdpConnection returns { ok:true, conn } and the conn carries no secret value", isOwnerActionAppliedResult(createRes) && createRes.value.ok === true && createRes.value.conn.kind === "oidc" && !("secret" in (createRes.value.conn as object)));

    // createIdpConnection (public client): no secret, secretMode pkce-public, clientAuth pkce_public.
    nextResponse = () => new Response(JSON.stringify({ ok: true, conn: connsBody.connections[0] }), { status: 200 });
    await client.createIdpConnection({ presetId: "okta", vars: {}, id: "okta2", clientId: "cid2", secretMode: "pkce-public", clientAuth: "pkce_public" });
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      eq(body.secretMode, "pkce-public", "create (public client) body carries secretMode pkce-public");
      ok("create (public client) body carries NO secret", !("secret" in body));
    }

    // createIdpConnection (SAML): wrapped as { proposal }. No secret. The validateSaml refusal reason
    // passes through as { ok:false, reason }.
    nextResponse = () => new Response(JSON.stringify({ ok: false, reason: "provide the required value(s): host, realm" }), { status: 200 });
    const samlRes = await client.createIdpConnection({ id: "corp", kind: "saml", label: "Corp", presetId: "generic-saml", enabled: true, idpEntityId: "https://idp", idpSsoUrl: "https://idp/sso", idpSigningCerts: ["-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----"], spEntityId: "https://sp", nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", wantAssertionsSigned: true, allowIdpInitiated: false, clockSkewSec: 120, emailVerifiedPolicy: "require-flag" });
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      ok("create (SAML) body is wrapped as { proposal } (the engine's generic path)", "proposal" in body && typeof body.proposal === "object");
      const proposal = body.proposal as Record<string, unknown>;
      eq(proposal.kind, "saml", "create (SAML) proposal carries kind:saml");
      ok("create (SAML) carries the PUBLIC signing certs (not a secret)", Array.isArray(proposal.idpSigningCerts));
      ok("create (SAML) body carries NO secret anywhere", !("secret" in body) && !("secret" in proposal));
    }
    ok("createIdpConnection surfaces a validation refusal reason verbatim", isOwnerActionAppliedResult(samlRes) && samlRes.value.ok === false && samlRes.value.reason.includes("required value"));

    // setIdpConnectionEnabled + deleteIdpConnection: POST-to-toggle / POST-to-delete with { connId, ... }.
    nextResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await client.setIdpConnectionEnabled("entra", false);
    eq(last().url, "https://engine.example.com/admin/idp/connections/enabled", "setIdpConnectionEnabled hits POST /admin/idp/connections/enabled");
    {
      const body = JSON.parse(last().body ?? "{}") as Record<string, unknown>;
      eq(body.connId, "entra", "enabled body carries connId");
      eq(body.enabled, false, "enabled body carries the new enabled flag");
    }
    nextResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await client.deleteIdpConnection("entra");
    eq(last().url, "https://engine.example.com/admin/idp/connections/delete", "deleteIdpConnection hits POST /admin/idp/connections/delete");
    eq(JSON.parse(last().body ?? "{}").connId, "entra", "delete body carries connId");

    // samlMetadata: GET the SP metadata as RAW text (offered as a file unchanged). connId is URL-encoded.
    const metaXml = '<?xml version="1.0"?><EntityDescriptor/>';
    nextResponse = () => new Response(metaXml, { status: 200 });
    const gotMeta = await client.samlMetadata("corp saml");
    eq(last().url, "https://engine.example.com/admin/saml/metadata/corp%20saml", "samlMetadata hits GET /admin/saml/metadata/<encoded connId>");
    eq(gotMeta, metaXml, "samlMetadata returns the RAW XML verbatim (saved as a file unchanged)");
    // samlMetadata non-2xx throws verb + status.
    nextResponse = () => new Response("nope", { status: 404 });
    let metaThrew = "";
    try { await client.samlMetadata("corp"); } catch (e) { metaThrew = e instanceof Error ? e.message : String(e); }
    eq(metaThrew, "saml metadata: 404", "samlMetadata non-2xx throws verb + status");

    // The PURE start-URL builders (no network): the sign-in buttons navigate the TOP-LEVEL window here.
    eq(EngineClient.oidcStartPath("entra"), "/admin/oidc/start/entra", "oidcStartPath builds the oidc start path");
    eq(EngineClient.samlStartPath("corp"), "/admin/saml/start/corp", "samlStartPath builds the saml start path");
    eq(EngineClient.oidcStartPath("a b"), "/admin/oidc/start/a%20b", "oidcStartPath URL-encodes the connId");
    eq(EngineClient.oidcStartPath("entra", "/runs"), "/admin/oidc/start/entra?returnTo=%2Fruns", "oidcStartPath threads a relative returnTo, encoded");
    eq(EngineClient.oidcStartPath("entra", "//evil.example"), "/admin/oidc/start/entra", "oidcStartPath DROPS a protocol-relative returnTo (open-redirect guard)");
    eq(EngineClient.oidcStartPath("entra", "https://evil"), "/admin/oidc/start/entra", "oidcStartPath DROPS an absolute returnTo");
    eq(client.idpStartUrlFor({ id: "entra", kind: "oidc" }), "https://engine.example.com/admin/oidc/start/entra", "idpStartUrlFor (oidc) is the absolute engine start URL");
    eq(client.idpStartUrlFor({ id: "corp", kind: "saml" }, "/access"), "https://engine.example.com/admin/saml/start/corp?returnTo=%2Faccess", "idpStartUrlFor (saml) routes to the saml start with returnTo");
    eq(client.samlMetadataUrl("corp"), "https://engine.example.com/admin/saml/metadata/corp", "samlMetadataUrl is the absolute SP-metadata URL");
    eq(client.metricsEndpointUrl(), "https://engine.example.com/metrics", "metricsEndpointUrl is the absolute Prometheus scrape endpoint (a non-/admin route)");
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}
