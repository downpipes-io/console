// Coverage for src/lib/demo/demo-routes-write-idp.ts: the faked engine's POST /admin/idp/connections.
// It drives the REAL writeAddIdpConnection against the seeded demo world for each create shape the engine
// accepts: a SAML proposal, an OIDC preset and an OAuth2 preset, with and without the optional fields, a
// preset whose kind comes from the seeded catalogue, and a body that matches neither shape. Each case reads
// the response and the stored connection back, so an assertion fails if the handler stores a different
// shape from the one the tour list shows.
//
// Run with: node test/cov/lib-demo-idp-write.ts

import { installDomShim } from "../dom-shim.ts";

import { verdictReached } from "../lib/verdict-guard.ts"; // ARMS the completion guard
installDomShim();

const { writeAddIdpConnection } = await import("../../src/lib/demo/demo-routes-write-idp.ts");
const worldMod = await import("../../src/lib/demo/demo-world.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

type Conn = Record<string, unknown> & { id: string; kind: string };
async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = writeAddIdpConnection({ method: "POST", body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
function stored(id: string): Conn | undefined {
  return (worldMod.world.idpConnections as unknown as Conn[]).find((c) => c.id === id);
}

worldMod.resetWorld();

// ---- 1. A SAML proposal is stored as sent, switched off, at the head of the list -------------------
{
  const proposal = {
    kind: "saml",
    id: "cov-saml",
    label: "Coverage SAML",
    enabled: false,
    presetId: "generic-saml",
    idpEntityId: "https://idp.example/entity",
    idpSsoUrl: "https://idp.example/sso",
    idpSigningCerts: ["-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----"],
    spEntityId: "https://sp.example/entity",
    nameIdFormat: "persistent",
    allowIdpInitiated: false,
    clockSkewSec: 60,
    emailVerifiedPolicy: "require",
  };
  const r = await post({ proposal });
  const c = stored("cov-saml");
  ok("SAML create answers 200 with ok true", r.status === 200 && r.json.ok === true);
  ok("SAML create stores a saml connection", c?.kind === "saml");
  ok("SAML create keeps the submitted enabled value (off)", c?.enabled === false);
  ok("SAML create puts the new connection first", (worldMod.world.idpConnections as unknown as Conn[])[0]?.id === "cov-saml");
  ok("SAML create always wants signed assertions", c?.wantAssertionsSigned === true);
  ok("SAML create without optional attributes stores neither", c !== undefined && !("emailAttr" in c) && !("groupsAttr" in c));

  // The same id again, now with the optional attributes: the handler replaces the entry in place.
  const before = worldMod.world.idpConnections.length;
  await post({ proposal: { ...proposal, label: "Coverage SAML 2", emailAttr: "mail", groupsAttr: "groups" } });
  const c2 = stored("cov-saml");
  ok("a second SAML create with the same id replaces, not appends", worldMod.world.idpConnections.length === before);
  ok("the replacement carries the new label", c2?.label === "Coverage SAML 2");
  ok("the replacement stores emailAttr and groupsAttr", c2?.emailAttr === "mail" && c2?.groupsAttr === "groups");
}

// ---- 2. An OIDC preset with PKCE and an issuer var -------------------------------------------------
{
  const r = await post({ kind: "oidc", presetId: "generic-oidc", id: "cov-oidc", clientId: "cid", vars: { issuer: "https://login.example" }, secretMode: "pkce-public" });
  const c = stored("cov-oidc");
  ok("OIDC preset create answers ok", r.json.ok === true);
  ok("OIDC preset stores an oidc connection", c?.kind === "oidc");
  ok("OIDC preset reads the issuer var straight through", c?.issuer === "https://login.example");
  ok("OIDC preset with pkce-public requires PKCE", c?.pkce === "required");
  ok("OIDC preset with pkce-public uses public client auth", c?.clientAuth === "pkce_public");
  ok("OIDC preset with no label falls back to the preset id", c?.label === "generic-oidc");
  ok("OIDC preset with no enabled value is stored switched off", c?.enabled === false);
}

// ---- 3. An OIDC preset with no issuer var, a client secret and an explicit client auth -------------
{
  await post({ kind: "oidc", presetId: "acme", id: "cov-oidc-2", clientId: "cid", vars: {}, label: "Acme", enabled: true, clientAuth: "client_secret_basic" });
  const c = stored("cov-oidc-2");
  ok("OIDC preset with no issuer var gets the synthetic placeholder", c?.issuer === "https://acme.example");
  ok("OIDC preset with a secret supports PKCE", c?.pkce === "supported");
  ok("OIDC preset keeps an explicit client auth", c?.clientAuth === "client_secret_basic");
  ok("OIDC preset keeps a submitted label and enabled value", c?.label === "Acme" && c?.enabled === true);

  // The same id again replaces the entry in place.
  const before = worldMod.world.idpConnections.length;
  await post({ kind: "oidc", presetId: "acme", id: "cov-oidc-2", clientId: "cid2", vars: {} });
  ok("a second preset create with the same id replaces, not appends", worldMod.world.idpConnections.length === before);
  ok("the replaced preset connection carries the new client id", stored("cov-oidc-2")?.clientId === "cid2");
  ok("a preset create with a secret and no client auth uses client_secret_post", stored("cov-oidc-2")?.clientAuth === "client_secret_post");
}

// ---- 4. An OAuth2 preset, with and without its URL vars ---------------------------------------------
{
  await post({ kind: "oauth2", presetId: "gh", id: "cov-oauth2", clientId: "cid", vars: {} });
  const c = stored("cov-oauth2");
  ok("OAuth2 preset stores an oauth2 connection", c?.kind === "oauth2");
  ok("OAuth2 preset with no URL vars gets synthetic placeholders", c?.authorizeUrl === "https://gh.example/oauth/authorize" && c?.tokenUrl === "https://gh.example/oauth/token");
  ok("OAuth2 preset with a secret has no PKCE", c?.pkce === "none");
  ok("OAuth2 preset uses the preset id as its subject prefix", c?.subjectPrefix === "gh");

  await post({ kind: "oauth2", presetId: "gh", id: "cov-oauth2-b", clientId: "cid", secretMode: "pkce-public", vars: { authorizeUrl: "https://a.example/auth", tokenUrl: "https://a.example/token" } });
  const b = stored("cov-oauth2-b");
  ok("OAuth2 preset reads its URL vars straight through", b?.authorizeUrl === "https://a.example/auth" && b?.tokenUrl === "https://a.example/token");
  ok("OAuth2 preset with pkce-public supports PKCE", b?.pkce === "supported");
}

// ---- 5. A preset create with no kind takes it from the seeded catalogue, else oidc ------------------
{
  const presets = worldMod.world.idpPresets as unknown as { id: string; kind: string }[];
  const seeded = presets.find((p) => p.kind === "oauth2") ?? presets[0];
  ok("the seeded world carries at least one IdP preset", seeded !== undefined);
  if (seeded) {
    await post({ presetId: seeded.id, id: "cov-catalogue", clientId: "cid", vars: {} });
    ok("a preset create with no kind takes the catalogue preset's kind", stored("cov-catalogue")?.kind === seeded.kind);
  }
  await post({ presetId: "not-in-catalogue", id: "cov-unknown", clientId: "cid", vars: {} });
  ok("a preset create with no kind and no catalogue entry is stored as oidc", stored("cov-unknown")?.kind === "oidc");
}

// ---- 6. A body that matches neither create shape is a benign write ----------------------------------
{
  const before = worldMod.world.idpConnections.length;
  const r = await post({ presetId: "generic-oidc" });
  ok("a body with neither shape answers 200", r.status === 200);
  ok("a body with neither shape stores nothing", worldMod.world.idpConnections.length === before);
}

worldMod.resetWorld();

verdictReached(failures);

if (failures > 0) {
  console.log(`\nDEMO-IDP-WRITE COVERAGE: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nDEMO-IDP-WRITE COVERAGE PASS");
