// Native external-IdP SSO domain functions for the EngineClient: OIDC / OAuth2 / SAML connection
// management plus the pure start-URL builders. Free functions over the shared Transport (or pure, for the
// builders).
//
// Two audiences, two gates:
//   - idpProviders() is the PRE-AUTH sign-in read (GET /admin/oidc/providers): the engine answers it WITHOUT
//     a session and returns only ENABLED connections as a display DTO (id/label/kind/presetId). It carries
//     no bearer and rides credentials:"include" harmlessly.
//   - the rest (presets, connections list/create/delete/enable, SAML metadata) are OWNER management, gated
//     SERVER-SIDE on keys.ceremony. The console mirrors that gate as UX only; the engine enforces. The client
//     SECRET is WRITE-ONLY everywhere: posted on create, never read back.
// No secret transits on any read: a redacted connection's secret is a { mode } descriptor with no value, and
// the providers DTO carries none at all.

import { idpProbeOutcome, probeCallOutcome, recordProbeOutcome } from "../client-diag/ring.ts";
import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ChangeRef } from "../change-ref.ts";
import type {
  IdpConnectionView,
  IdpCreateResult,
  IdpKind,
  IdpPreset,
  IdpPresetCreate,
  IdpProvider,
  IdpSamlProposal,
  IdpTestResult,
  OwnerActionResult,
} from "./types.ts";

// idpProviders is the unauthenticated sign-in read. It NEVER sends the bearer (it is the sign-in, like
// the passkey login/begin), and a DO hiccup yields { ok:true, providers:[] } engine-side (an empty
// list, never a 500), so the sign-in screen degrades to passkey + token with no error noise.
export async function idpProviders(t: Transport): Promise<{ ok: boolean; providers: IdpProvider[] }> {
  const r = await engineFetch(`${t.base}/admin/oidc/providers`, { headers: { "content-type": "application/json" }, credentials: "include" });
  return t.parseJson<{ ok: boolean; providers: IdpProvider[] }>(r, "idp providers");
}

// idpPresets returns the display-only add-connection catalogue (keys.ceremony-gated). No secrets; the
// engine owns the preset templates AND builds the proposal from them, so the console never constructs a
// connection itself, it renders requiredVars as a form and POSTs {presetId, vars, ...}.
export async function idpPresets(t: Transport): Promise<{ ok: boolean; presets: IdpPreset[] }> {
  const r = await engineFetch(`${t.base}/admin/idp/presets`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<{ ok: boolean; presets: IdpPreset[] }>(r, "idp presets");
}

// idpConnections lists every stored connection REDACTED for the owner's management UI (keys.ceremony).
// A secretRef can only ever surface as { mode, ref? }; the value is never returned.
export async function idpConnections(t: Transport): Promise<{ ok: boolean; connections: IdpConnectionView[] }> {
  const r = await engineFetch(`${t.base}/admin/idp/connections`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<{ ok: boolean; connections: IdpConnectionView[] }>(r, "idp connections");
}

// createIdpConnection creates a connection. Two shapes (the engine accepts both at POST
// /admin/idp/connections):
//   (a) OIDC/OAuth2 FROM A PRESET, pass an IdpPresetCreate; the body is sent flat ({presetId, vars,
//       id, label?, clientId, secret?, secretMode?, clientAuth?}) and the engine builds + validates +
//       stores from the preset. The WRITE-ONLY client secret rides in `secret`; the engine writes it
//       to its own idpsecret:<id> entry and never returns it (a redacted conn carries only {mode}).
//   (b) SAML / advanced, pass an IdpSamlProposal; it is wrapped as { proposal } (the engine's generic
//       path) and validated by validateSaml. No secret (the signing certs are public).
// Either way the engine answers 200 with { ok:true, conn } or { ok:false, reason } (a validation refusal the
// form shows verbatim). Creating a connection is a high-blast owner mutation (it changes which external
// identities can sign in), so when dual control is ON the engine queues it for a SECOND owner (HTTP 202):
// the result is a discriminated OwnerActionResult, { status:"result", value: IdpCreateResult } on the normal/
// gate-off path (where value still carries the {ok,...} validation outcome), or { status:"queued", queued }
// when queued, so the caller surfaces "queued for a second owner" rather than a false "added". A non-2xx
// that is not the 202 is a transport/auth fault that throws.
export async function createIdpConnection(t: Transport, input: IdpPresetCreate | IdpSamlProposal, change?: ChangeRef): Promise<OwnerActionResult<IdpCreateResult>> {
  // Discriminate on the SAML proposal's kind: a preset create has no `kind` field, a SAML proposal does.
  const body: unknown = "kind" in input && input.kind === "saml" ? { proposal: input } : input;
  // Sensitive owner mutation (it changes which external identities can sign in): routed through
  // gatedFetch so an engine 401 { stepUpRequired } runs the step-up ceremony and retries once. The
  // OPTIONAL change reference (change management) rides as the X-Downpipes-Change header when supplied.
  const r = await t.gatedFetch("/admin/idp/connections", { method: "POST", headers: t.headers(change), credentials: "include", body: JSON.stringify(body) }, { adminOp: "idp-connection-upsert" });
  return t.parseJsonOrOwnerAction<IdpCreateResult>(r, "create idp connection");
}

// testIdpConnection runs the engine's READ-ONLY pre-save probe (POST /admin/idp/test) over a proposed
// connection config: OIDC discovery + JWKS reachability, or SAML metadata/cert validity. It stores nothing
// and starts no login. The engine always returns { ok, checks } as a 200, so the console renders the
// per-check lines and never branches on HTTP status. keys.ceremony server-side.
export async function testIdpConnection(t: Transport, proposal: IdpPresetCreate | IdpSamlProposal): Promise<IdpTestResult> {
  // The IdP probe is the product's deepest vendor diagnostic (OIDC discovery, JWKS reachability, SAML
  // metadata and certificate validity), so its outcome is recorded here rather than kept nowhere. The engine
  // answers 200 on every outcome (the checks carry the verdict), so the fail class must come from the check
  // STATUSES, not the status code. The check `detail` lines carry the certificate subject and the discovery
  // URL and are never read.
  try {
    const r = await engineFetch(`${t.base}/admin/idp/test`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ proposal }) });
    const res = await t.parseJson<IdpTestResult>(r, "test idp connection");
    recordProbeOutcome("idp-test", idpProbeOutcome(res));
    return res;
  } catch (e) {
    recordProbeOutcome("idp-test", probeCallOutcome(e));
    throw e;
  }
}

// testSavedIdpConnection runs the SAME read-only probe over a connection that is ALREADY STORED
// (POST /admin/idp/test-saved), so an operator can re-verify a connection after an IdP-side change
// without retyping it. The engine loads the stored record REDACTED (a secretRef never carries a
// value, and the probe needs no secret) and always answers 200 { ok, checks }; an unknown id is a
// failed check, so every outcome renders through the one test-result surface. keys.ceremony server-side.
export async function testSavedIdpConnection(t: Transport, connId: string): Promise<IdpTestResult> {
  // The IdP probe is the product's deepest vendor diagnostic, so its outcome is recorded here. The engine
  // answers 200 on every outcome (the checks carry the verdict), so the fail class must come from the check
  // STATUSES, not the status code.
  try {
    const r = await engineFetch(`${t.base}/admin/idp/test-saved`, { method: "POST", headers: t.headers(), credentials: "include", body: JSON.stringify({ connId }) });
    const res = await t.parseJson<IdpTestResult>(r, "test saved idp connection");
    recordProbeOutcome("idp-test", idpProbeOutcome(res));
    return res;
  } catch (e) {
    recordProbeOutcome("idp-test", probeCallOutcome(e));
    throw e;
  }
}

// deleteIdpConnection removes a connection (and, engine-side, its paired write-only secret) and bumps
// the idp epoch so the connection's live sessions die. keys.ceremony server-side. It is a high-blast owner
// mutation (it changes who can sign in), so when dual control is ON the engine queues it for a SECOND owner
// (HTTP 202): the result is a discriminated OwnerActionResult so the caller surfaces "queued for a second
// owner" rather than a false "removed". The gate-off path returns { status:"result", value } unchanged.
export async function deleteIdpConnection(t: Transport, connId: string, change?: ChangeRef): Promise<OwnerActionResult<{ ok: boolean; reason?: string }>> {
  // Sensitive owner mutation: routed through gatedFetch so an engine 401 { stepUpRequired } runs the
  // step-up ceremony and retries once. The OPTIONAL change reference rides as X-Downpipes-Change.
  const r = await t.gatedFetch("/admin/idp/connections/delete", { method: "POST", headers: t.headers(change), credentials: "include", body: JSON.stringify({ connId }) }, { adminOp: "idp-connection-delete" });
  return t.parseJsonOrOwnerAction<{ ok: boolean; reason?: string }>(r, "delete idp connection");
}

// setIdpConnectionEnabled flips a connection's enabled flag (disabling it also bumps the idp epoch so
// its live sessions die, engine-side). A disabled connection stops appearing in idpProviders (no
// sign-in button) immediately. keys.ceremony server-side. It is a high-blast owner mutation (it changes
// who can sign in), so when dual control is ON the engine queues it for a SECOND owner (HTTP 202): the
// result is a discriminated OwnerActionResult so the caller surfaces "queued for a second owner" rather
// than a false "enabled / disabled". The gate-off path returns { status:"result", value } unchanged.
export async function setIdpConnectionEnabled(t: Transport, connId: string, enabled: boolean, change?: ChangeRef): Promise<OwnerActionResult<{ ok: boolean; reason?: string }>> {
  // Sensitive owner mutation: routed through gatedFetch so an engine 401 { stepUpRequired } runs the
  // step-up ceremony and retries once. The OPTIONAL change reference rides as X-Downpipes-Change.
  const r = await t.gatedFetch("/admin/idp/connections/enabled", { method: "POST", headers: t.headers(change), credentials: "include", body: JSON.stringify({ connId, enabled }) }, { adminOp: "idp-connection-toggle" });
  return t.parseJsonOrOwnerAction<{ ok: boolean; reason?: string }>(r, "set idp connection enabled");
}

// rolloverIdpSigningCerts is the ZERO-DOWNTIME SAML signing-certificate rollover (engine POST
// /admin/idp/connections/cert, owner action `idp-conn-cert`). Until this existed the console had no caller for
// that route at all, so the only portal path through a rollover was remove-and-re-add, which ends every session
// signed in through the connection and, under dual control, queues TWICE with a broken-login window between the
// two approvals. The engine edits the pinned cert array in place instead and does NOT bump the idpEpoch, so
// nobody is signed out.
//
// Two mutually exclusive modes, the two halves of a rollover:
//   - "append" sends { addCerts }: the new IdP cert is merged onto the pinned set, so an assertion signed by
//     EITHER the old or the new key verifies through the overlap. This is the step taken BEFORE the IdP cuts over.
//   - "replace" sends { certs }: the full new set replaces the old one, pruning the retired cert AFTER the IdP
//     has finished cutting over. Sending the wrong one at the wrong time is what breaks sign-in, which is why
//     the screen makes the operator pick rather than inferring it.
// The engine runs either result through the create path's own validateSamlCerts (1..8 de-duped PEMs, each
// <=8192 chars), so a rollover can never store a set the create form would have refused, and a refusal is a
// clean { ok:false, reason } with no partial write.
//
// A signing cert is the SAML trust root, so this is the same account-takeover blast class as creating or
// enabling a connection: when dual control is ON the engine answers 202 { ownerActionQueued, id, status } and
// applies NOTHING until a second owner approves. It is therefore read through parseJsonOrOwnerAction, never
// parseJson: parseJson throws only on a non-2xx, so a 202 read through it would parse the QUEUE RECEIPT as the
// applied record, `ok` would be absent and read as false, and the operator would be told the rollover failed
// for a change that is about to take effect. The gate-off path returns { status:"result", value } unchanged.
export async function rolloverIdpSigningCerts(
  t: Transport,
  connId: string,
  mode: "append" | "replace",
  certs: string[],
  change?: ChangeRef,
): Promise<OwnerActionResult<{ ok: boolean; reason?: string }>> {
  const body = mode === "replace" ? { connId, certs } : { connId, addCerts: certs };
  // Sensitive owner mutation: routed through gatedFetch so an engine 401 { stepUpRequired } runs the
  // step-up ceremony and retries once. The OPTIONAL change reference rides as X-Downpipes-Change.
  // adminOp names the ROLLOVER rather than the connection upsert it used to ride on. This is safe to be
  // precise about only because the engine admits the member: it checks adminOp by set membership and fails
  // the whole record CLOSED on one it does not hold (engine/src/admin/client-diag-receive.ts:220), and this
  // is the call every rollover makes, not an edge path. Never move a member here ahead of the engine.
  const r = await t.gatedFetch("/admin/idp/connections/cert", { method: "POST", headers: t.headers(change), credentials: "include", body: JSON.stringify(body) }, { adminOp: "idp-connection-cert-rollover" });
  return t.parseJsonOrOwnerAction<{ ok: boolean; reason?: string }>(r, "roll over idp signing certificate");
}

// samlMetadata fetches the SP EntityDescriptor XML (application/samlmetadata+xml) the customer uploads
// or hands to their IdP. It is PUBLIC metadata (no secret), returned as RAW text the screen offers as a
// download. A non-2xx (e.g. the connection is not SAML / not found) throws the named verb + status.
export async function samlMetadata(t: Transport, connId: string): Promise<string> {
  const r = await engineFetch(`${t.base}/admin/saml/metadata/${encodeURIComponent(connId)}`, { headers: t.headers(), credentials: "include" });
  if (!r.ok) return t.failResponse(r, "saml metadata");
  return r.text();
}

// oidcStartPath / samlStartPath build the RELATIVE start path the sign-in buttons navigate the
// TOP-LEVEL window to (a window.location nav, NOT a fetch, this is the only IdP flow the browser
// drives directly; everything else is server-side). The console deliberately returns a PATH the screen
// prefixes with the engine origin: the connId is URL-encoded, and an optional relative-only returnTo is
// threaded as ?returnTo= so a successful sign-in lands the operator back where they were. These are
// PURE string builders (no network), so the validator pins their exact form. oidcStartPath serves the
// oidc + oauth2 kinds; samlStartPath serves saml.
export function oidcStartPath(connId: string, returnTo?: string): string {
  const base = `/admin/oidc/start/${encodeURIComponent(connId)}`;
  return returnTo?.startsWith("/") && !returnTo.startsWith("//") ? `${base}?returnTo=${encodeURIComponent(returnTo)}` : base;
}
export function samlStartPath(connId: string, returnTo?: string): string {
  const base = `/admin/saml/start/${encodeURIComponent(connId)}`;
  return returnTo?.startsWith("/") && !returnTo.startsWith("//") ? `${base}?returnTo=${encodeURIComponent(returnTo)}` : base;
}

// idpStartUrlFor resolves the ABSOLUTE start URL for a provider button: the engine origin + the
// kind-appropriate start path. It needs t.base so the sign-in screen can navigate window.location straight
// to it. saml -> samlStartPath; oidc/oauth2 -> oidcStartPath.
export function idpStartUrlFor(t: Transport, provider: { id: string; kind: IdpKind }, returnTo?: string): string {
  const path = provider.kind === "saml" ? samlStartPath(provider.id, returnTo) : oidcStartPath(provider.id, returnTo);
  return `${t.base}${path}`;
}

// samlMetadataUrl is the absolute GET URL for the SP metadata (so a screen can show/copy it or open it
// directly). The download path goes through samlMetadata() (which carries the session); this is the
// human-facing address.
export function samlMetadataUrl(t: Transport, connId: string): string {
  return `${t.base}/admin/saml/metadata/${encodeURIComponent(connId)}`;
}

// consoleOrigin returns the origin the engine derives its CONSOLE_ORIGIN-bound URLs from: the console's
// OWN origin. In the supported same-origin topology (console serves /admin/* same-origin, t.base defaults
// to location.origin) this equals t.base, so the value is unchanged. When EngineClient is pointed at a
// DIFFERENT engine URL (the connect(url, token) path), t.base is the engine origin while the engine still
// registers/validates CONSOLE_ORIGIN; reading the console's own origin keeps the displayed registration
// value matching what the engine expects. Falls back to t.base outside a DOM (the validator).
function consoleOrigin(t: Transport): string {
  return typeof window !== "undefined" && window.location?.origin ? window.location.origin : t.base;
}

// idpRedirectUri is the absolute OIDC/OAuth2 callback the customer registers at their IdP (its "redirect
// URI" / "callback URL" field): the console origin + /admin/oidc/callback/<connId>. It is the SAME value
// the engine echoes into the token exchange (the router builds it from CONSOLE_ORIGIN), so it MUST match
// byte-for-byte. The add-connection form shows it live, embedding the connection id the operator types.
export function idpRedirectUri(t: Transport, connId: string): string {
  return `${consoleOrigin(t)}/admin/oidc/callback/${encodeURIComponent(connId)}`;
}

// samlAcsUrl is the absolute Assertion Consumer Service URL the customer points their SAML IdP at (where
// the signed assertion is POSTed): the console origin + /admin/saml/acs/<connId>. Mirrors the engine's
// CONSOLE_ORIGIN-derived acsUrl. Shown live in the SAML form and on the connection card after creation.
export function samlAcsUrl(t: Transport, connId: string): string {
  return `${consoleOrigin(t)}/admin/saml/acs/${encodeURIComponent(connId)}`;
}
