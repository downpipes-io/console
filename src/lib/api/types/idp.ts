// Native external-IdP SSO mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// Native external-IdP SSO: presets, connections, providers
// These mirror the engine's idpconn.ts + oidc-presets.ts wire shapes BYTE-FOR-BYTE so the two sides
// cannot drift. The console NEVER builds an OIDC connection itself (the preset logic is the engine's
// single source of truth and the privileged build stays server-side, per the no-customer-CLI rule):
// it reads the preset catalogue, renders the operator's required values into a form, and POSTs
// { presetId, vars, clientId, secret? }. A raw { proposal } is sent only for the SAML / advanced path
// (there is no SAML oidc-preset, so the console composes that proposal structurally). The client
// SECRET is WRITE-ONLY: it is posted on create and never returned, a redacted connection carries
// only a { mode } secret descriptor, never a value (defence-in-depth: redactIdpConn strips it
// server-side too). No secret EVER transits back over any of these routes.

export type IdpKind = "oidc" | "oauth2" | "saml";

// SecretMode mirrors engine idpconn.ts: how a connection's client credential is held. "pkce-public"
// holds nothing (a public client, PKCE only); "do-plaintext" is the write-only DO-stored floor; the
// other two reference a non-secret binding/key id. The console only ever WRITES do-plaintext (a typed
// secret) or pkce-public (no secret); it surfaces whatever mode the engine reports back.
export type IdpSecretMode = "pkce-public" | "secrets-store" | "do-plaintext" | "private-key-jwt";

// SecretRef is the ONLY credential descriptor a redacted connection carries: a mode and an optional
// NON-secret reference (a binding name or key id). It NEVER carries a value (the redaction guarantee).
export interface IdpSecretRef {
  mode: IdpSecretMode;
  ref?: string;
}

// PresetVar is one operator-supplied value a preset needs (e.g. the Okta domain, the Entra tenant id).
// The console renders these as form fields: `label` is the field label, `example` the placeholder, and
// `default` (when present) is pre-filled. No var is ever a secret (a secret is the separate clientId +
// write-only secret); these are hostnames, tenant ids and realm names only.
export interface IdpPresetVar {
  key: string;
  label: string;
  example?: string;
  default?: string;
}

// IdpPreset is one entry in the add-connection catalogue (display-only; no secrets). `requiredVars` is
// what the operator must supply, `notes` the inline gotchas the form shows calmly, `buttonLabel` the
// "Sign in with X" text. kind is "oidc" | "oauth2" (SAML has no preset, it uses the generic proposal).
export interface IdpPreset {
  id: string;
  label: string;
  vendor: string;
  buttonLabel: string;
  kind: "oidc" | "oauth2";
  requiredVars: IdpPresetVar[];
  notes: string[];
  docsUrl?: string;
}

// IdpProvider is the PRE-AUTH display DTO for the sign-in buttons: an enabled connection with NO
// internal config (just enough to render "Sign in with <label>" and route to the start URL). It is the
// only IdP shape the unauthenticated sign-in screen ever sees.
export interface IdpProvider {
  id: string;
  label: string;
  kind: IdpKind;
  presetId: string;
}

// IdpConnection is a REDACTED stored connection (the owner's management list). The three kinds share
// the base fields; the kind-specific fields mirror the engine, but the secret is ALWAYS a { mode }
// descriptor with no value. The console reads these defensively (a newer engine field is ignored, a
// missing optional is absent); it renders id/label/kind/enabled/issuer-or-entity and the secret MODE.
export interface IdpConnectionBase {
  id: string;
  label: string;
  enabled: boolean;
  presetId: string;
  createdBy: string | null;
  createdAt: string;
}
export interface OidcConnectionView extends IdpConnectionBase {
  kind: "oidc";
  issuer: string;
  clientId: string;
  secretRef: IdpSecretRef;
  scopes: string[];
  pkce: "required" | "supported";
  clientAuth: "client_secret_post" | "client_secret_basic" | "pkce_public" | "private_key_jwt";
  groupsClaim?: string;
  rolesClaim?: string;
}
export interface Oauth2ConnectionView extends IdpConnectionBase {
  kind: "oauth2";
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  secretRef: IdpSecretRef;
  scopes: string[];
  subjectPrefix: string;
  pkce: "supported" | "none";
}
export interface SamlConnectionView extends IdpConnectionBase {
  kind: "saml";
  idpEntityId: string;
  idpSsoUrl: string;
  idpSigningCerts: string[]; // PUBLIC X.509 PEMs (safe to display); not a secret
  spEntityId: string;
  nameIdFormat: string;
  wantAssertionsSigned: true;
  allowIdpInitiated: boolean;
  clockSkewSec: number;
  emailVerifiedPolicy: "require-flag" | "trust-idp";
  emailAttr?: string;
  groupsAttr?: string;
}
export type IdpConnectionView = OidcConnectionView | Oauth2ConnectionView | SamlConnectionView;

// IdpTestCheck / IdpTestResult mirror the engine's POST /admin/idp/test response (engine src/admin/idp-test.ts):
// a READ-ONLY "test connection" probe that fetches the IdP's published metadata (OIDC discovery + JWKS) or
// parses the SAML config and certificates, returning per-check lines. status "fail" forces ok:false; "warn"
// is advisory. The probe stores nothing and starts no login.
export interface IdpTestCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}
export interface IdpTestResult {
  ok: boolean;
  checks: IdpTestCheck[];
}

// IdpPresetCreateBase is the shared shape of an OIDC/OAuth2-from-a-preset create: the engine builds the
// proposal from {presetId, vars} and the operator's {clientId, ...}. The console mirrors the engine's
// defaults: clientAuth "client_secret_post" unless the operator picks basic or the public client.
// `kind` mirrors the preset's own kind (IdpPreset.kind): the CREATE route ignores it (it derives kind
// server-side from presetId), but the TEST route (POST /admin/idp/test) reads proposal.kind directly with
// no presetId lookup at all, so a preset payload without it always failed the pre-save probe with "Unknown
// connection kind" (engine/src/admin/idp-test.ts) - the SAML proposal was the only one that ever set it.
// Optional (not every existing caller supplies it) but presetForm (./forms.ts) always fills it from the
// preset it renders, so a real Test click always carries it.
interface IdpPresetCreateBase {
  presetId: string;
  vars: Record<string, string>;
  id: string;
  label?: string;
  clientId: string;
  clientAuth?: "client_secret_post" | "client_secret_basic" | "pkce_public";
  kind?: "oidc" | "oauth2";
}

// IdpPresetCreate is a discriminated union on secretMode so the type enforces the secret/secretMode
// dependency the engine validates: a public (pkce) client OMITS the secret (secretMode "pkce-public");
// a confidential client carries the write-only client secret (do-plaintext). The flat shape would allow
// the contradictory secret + "pkce-public" or no-secret + "do-plaintext" combinations.
export type IdpPresetCreate =
  | (IdpPresetCreateBase & { secretMode: "pkce-public"; secret?: undefined })
  | (IdpPresetCreateBase & { secret: string; secretMode?: "do-plaintext" });

// IdpSamlProposal is the generic-SAML create shape (there is no SAML preset). The console composes it
// structurally from the SP/IdP form; the engine's validateSaml enforces the invariants (https idpSsoUrl,
// >=1 PEM signing cert, wantAssertionsSigned:true, non-transient NameID, explicit emailVerifiedPolicy)
// and returns { ok:false, reason } the form surfaces. There is no secret on a SAML connection (the
// signing certs are public).
export interface IdpSamlProposal {
  id: string;
  kind: "saml";
  label: string;
  presetId: string; // "generic-saml"
  enabled: true;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSigningCerts: string[];
  spEntityId: string;
  nameIdFormat: string;
  wantAssertionsSigned: true;
  allowIdpInitiated: boolean;
  clockSkewSec: number;
  emailVerifiedPolicy: "require-flag" | "trust-idp";
  emailAttr?: string;
  groupsAttr?: string;
}

// IdpCreateResult is the discriminated create outcome. The engine answers 200 with { ok:true, conn }
// (the redacted connection) on success, or { ok:false, reason } on a validation refusal the form shows
// verbatim (e.g. "provide the required value(s): host, realm"). A non-2xx is a transport/auth fault the
// method throws, exactly like the other writes.
export type IdpCreateResult =
  | { ok: true; conn: IdpConnectionView }
  | { ok: false; reason: string };
