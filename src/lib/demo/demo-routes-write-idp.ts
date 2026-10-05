// The faked engine's native external-IdP SSO write handler (see demo-routes-write.ts for the rest of the
// write handlers). Split out on its own so a preset create's shape-handling does not grow the main write
// module past its line budget.

import type { IdpPresetCreate, IdpSamlProposal, Oauth2ConnectionView, OidcConnectionView, SamlConnectionView } from "../api/types.ts";
import { ORG_OWNER_EMAIL } from "./demo-seed.ts";
import { benignWrite, demoIso, json, readBody, world } from "./demo-world.ts";

// writeAddIdpConnection models POST /admin/idp/connections for both create shapes the engine accepts: the
// SAML / advanced path, wrapped as { proposal } (there is no SAML preset); and the OIDC/OAuth2 preset path,
// sent flat ({ presetId, vars, id, clientId, ... }, no wrapper, see api/client-idp.ts createIdpConnection).
// Either way it stores the submitted proposal's OWN enabled value, so the list the tour reloads afterwards
// shows the new connection exactly as it was created (switched off, until an admin selects Enable there).
export function writeAddIdpConnection(init?: RequestInit): Response {
  const body = readBody<{ proposal?: IdpSamlProposal; presetId?: string; id?: string; clientId?: string }>(init);
  const p = body.proposal;
  if (p?.kind === "saml") {
    const conn: SamlConnectionView = {
      id: p.id,
      label: p.label,
      kind: "saml",
      enabled: p.enabled,
      presetId: p.presetId,
      createdBy: ORG_OWNER_EMAIL,
      createdAt: demoIso(0),
      idpEntityId: p.idpEntityId,
      idpSsoUrl: p.idpSsoUrl,
      idpSigningCerts: p.idpSigningCerts,
      spEntityId: p.spEntityId,
      nameIdFormat: p.nameIdFormat,
      wantAssertionsSigned: true,
      allowIdpInitiated: p.allowIdpInitiated,
      clockSkewSec: p.clockSkewSec,
      emailVerifiedPolicy: p.emailVerifiedPolicy,
      ...(p.emailAttr ? { emailAttr: p.emailAttr } : {}),
      ...(p.groupsAttr ? { groupsAttr: p.groupsAttr } : {}),
    };
    const existing = world.idpConnections.findIndex((c) => c.id === conn.id);
    if (existing >= 0) world.idpConnections[existing] = conn;
    else world.idpConnections.unshift(conn);
    return json({ ok: true, conn });
  }
  if (typeof body.presetId === "string" && typeof body.id === "string" && typeof body.clientId === "string") {
    return writeAddPresetIdpConnection(body as unknown as IdpPresetCreate);
  }
  return benignWrite("/admin/idp/connections");
}

// writeAddPresetIdpConnection stores an OIDC/OAuth2 preset create (see writeAddIdpConnection above) as a
// redacted connection view, so the list the tour reloads afterwards shows it switched off. It keys on the
// payload's own `kind` (presetForm's buildPayload always fills it, ../../screens/idp-connections/forms.ts),
// falling back to the seeded catalogue for an older caller. The demo has no template engine of its own, so
// a var the preset names for its issuer/endpoint URLs (generic-oidc's `issuer`, generic-oauth2's
// `authorizeUrl`/`tokenUrl`) is read straight through; any other preset gets a plainly-synthetic placeholder
// built from its id, since the demo never calls the real provider.
function writeAddPresetIdpConnection(p: IdpPresetCreate): Response {
  const kind = p.kind ?? world.idpPresets.find((preset) => preset.id === p.presetId)?.kind ?? "oidc";
  const secretRef = { mode: p.secretMode ?? "do-plaintext" } as const;
  const base = {
    id: p.id,
    label: p.label ?? p.presetId,
    enabled: p.enabled ?? false,
    presetId: p.presetId,
    createdBy: ORG_OWNER_EMAIL,
    createdAt: demoIso(0),
  };
  const conn: OidcConnectionView | Oauth2ConnectionView =
    kind === "oauth2"
      ? {
          ...base,
          kind: "oauth2",
          authorizeUrl: p.vars.authorizeUrl || `https://${p.presetId}.example/oauth/authorize`,
          tokenUrl: p.vars.tokenUrl || `https://${p.presetId}.example/oauth/token`,
          clientId: p.clientId,
          secretRef,
          scopes: ["read:user"],
          subjectPrefix: p.presetId,
          pkce: p.secretMode === "pkce-public" ? "supported" : "none",
        }
      : {
          ...base,
          kind: "oidc",
          issuer: p.vars.issuer || `https://${p.presetId}.example`,
          clientId: p.clientId,
          secretRef,
          scopes: ["openid", "email", "profile"],
          pkce: p.secretMode === "pkce-public" ? "required" : "supported",
          clientAuth: p.clientAuth ?? (p.secretMode === "pkce-public" ? "pkce_public" : "client_secret_post"),
        };
  const existing = world.idpConnections.findIndex((c) => c.id === conn.id);
  if (existing >= 0) world.idpConnections[existing] = conn;
  else world.idpConnections.unshift(conn);
  return json({ ok: true, conn });
}
