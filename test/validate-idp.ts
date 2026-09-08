// Validate the native external-IdP SSO console surface: the pure helpers in the IdP connections screen
// (src/screens/idp-connections.ts) and the sign-in providers wiring in the sign-in screen
// (src/screens/passkey.ts). The engine-contract client methods are pinned in validate-api.ts (the
// fetch-stubbed route/verb/body/secret assertions); THIS file pins the SCREEN logic that the no-customer-CLI
// and no-lockout product rules turn on. Run with `node test/validate-idp.ts`.
//
// Coverage:
//   PURE helpers (no browser):
//     splitPems: a single PEM, multiple PEMs (cert rollover), surrounding whitespace, and empty/no-PEM
//       input: a paste box of one or many certs becomes the exact string[] the SAML proposal needs.
//     capitalise: an engine reason ("provide the required value(s): host, realm") is shown leading-capped.
//     kindLabel: each IdP kind reads in human terms (OpenID Connect / OAuth 2.0 / SAML 2.0).
//     providerButtonLabel: "Sign in with <label>" for one enabled provider.
//   SIGN-IN providers wiring (real mountProviderButtons with a stub engine + a DOM shim), asserting the
//   NO-LOCKOUT / fail-open product rules:
//     populated providers -> one "Sign in with X" button per ENABLED provider is rendered into the slot,
//       and a click navigates the TOP-LEVEL window to the engine's start URL (oidc -> /admin/oidc/start,
//       saml -> /admin/saml/start), threading the relative returnTo.
//     EMPTY providers list -> the slot stays empty (passkey + token remain the only way in; no noise).
//     FAILED providers fetch (the engine has no IdP routes / a transport fault) -> the slot stays empty
//       (fail-open: never an error banner on the sign-in screen).
//   ADD-CONNECTION forms (real presetForm/samlForm driven through a stub engine): the success toast after a
//     create states the true, already-live state (the engine enables a new connection immediately, ASVS V10
//     ML-06) rather than implying a separate "enable" step remains.

// ---- install a DOM shim + a recording window.location BEFORE importing the screen modules ----------
// The screen modules import lib/dom.ts (document.createElement) at module load, so the globals must exist
// first. We reuse the shared shim (installDomShim) and add a RECORDING window.location so a provider-button
// click's top-level navigation is observable without a real browser.

import { installDomShim } from "./dom-shim.ts";

let lastAssigned: string | null = null;
let lastHref: string | null = null;
// Install a recording location BEFORE the shim (the shim only sets location when none exists), so the
// provider button's window.location.assign(url) is captured.
(globalThis as unknown as { location: unknown }).location = {
  origin: "https://console.test",
  assign: (url: string) => { lastAssigned = url; },
  set href(url: string) { lastHref = url; },
  get href() { return lastHref ?? ""; },
};
installDomShim();

const { idpConnectionsScreen, splitPems, capitalise, kindLabel } = await import("../src/screens/idp-connections.ts");
const { providerButtonLabel, mountProviderButtons } = await import("../src/screens/passkey.ts");
const { h } = await import("../src/lib/dom.ts");
const { IDP_GUIDES, SAML_GUIDE } = await import("../src/screens/idp-guides.ts");
const { providerKey, PROVIDER_META, providerLogo } = await import("../src/screens/idp-connections/provider-logos.ts");
const { buildProviderTiles, tileState } = await import("../src/screens/idp-connections/grid.ts");
const { presetForm } = await import("../src/screens/idp-connections/forms.ts");
const { samlForm } = await import("../src/screens/idp-connections/saml-form.ts");
import type { EngineClient, IdpKind, IdpPreset, IdpConnectionView } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: unknown, b: unknown, label: string): void {
  const cond = a === b;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures++;
}

// tick flushes the microtask + macrotask queue (setTimeout(0) only fires once every pending microtask,
// however deeply chained, has drained), so an awaited policy read followed by an awaited create call has
// fully settled before the test inspects the DOM. Same idiom as validate-change-management.ts's tick().
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// A tiny helper to count rendered <button> descendants and read their text (the shim element exposes
// textContent + a recursive child walk).
function buttonTexts(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: { tagName?: string; childNodes?: unknown[]; textContent?: string }): void => {
    if (n.tagName === "BUTTON" || n.tagName === "button") out.push((n.textContent ?? "").trim());
    for (const c of (n.childNodes ?? []) as Array<typeof n>) walk(c);
  };
  walk(node as { tagName?: string; childNodes?: unknown[]; textContent?: string });
  return out;
}

async function main(): Promise<void> {
  console.log("-- pure helpers (idp-connections.ts) --");

  // splitPems
  const onePem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
  eq(splitPems(onePem).length, 1, "splitPems: a single PEM yields one block");
  eq(splitPems(onePem)[0], onePem, "splitPems: the single block is the trimmed PEM");
  const twoPems = `${onePem}\n\n-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----`;
  eq(splitPems(twoPems).length, 2, "splitPems: two PEMs (cert rollover) yield two blocks");
  eq(splitPems(`  \n${onePem}\n  `).length, 1, "splitPems: surrounding whitespace is tolerated");
  eq(splitPems("not a cert").length, 0, "splitPems: non-PEM input yields no blocks");
  eq(splitPems("").length, 0, "splitPems: empty input yields no blocks");

  // capitalise
  eq(capitalise("provide the required value(s): host, realm"), "Provide the required value(s): host, realm", "capitalise: leading-caps an engine reason");
  eq(capitalise(""), "", "capitalise: empty string is unchanged");

  // kindLabel
  eq(kindLabel("oidc" as IdpKind), "OpenID Connect", "kindLabel: oidc reads as OpenID Connect");
  eq(kindLabel("oauth2" as IdpKind), "OAuth 2.0", "kindLabel: oauth2 reads as OAuth 2.0");
  eq(kindLabel("saml" as IdpKind), "SAML 2.0", "kindLabel: saml reads as SAML 2.0");

  // providerButtonLabel
  eq(providerButtonLabel({ label: "Microsoft Entra" }), "Sign in with Microsoft Entra", "providerButtonLabel: 'Sign in with <label>'");

  // ---- the screen descriptor wiring ----
  console.log("\n-- screen descriptor (idp-connections.ts) --");
  eq(idpConnectionsScreen.route, "/access/idp", "the IdP screen owns /access/idp");
  eq(idpConnectionsScreen.title, "Identity providers", "the IdP screen titles itself 'Identity providers'");
  ok("the IdP screen contributes a palette navigate action", idpConnectionsScreen.actions.some((a) => a.kind === "navigate" && a.target === "/access/idp"));

  // ---- provider grid (provider-logos.ts + grid.ts) ----
  console.log("\n-- provider grid (key normaliser, catalogue + marks) --");

  // providerKey folds every spelling of a provider onto ONE canonical key so a tile and the connection(s)
  // that configured it always line up; the vendor checks beat the generic protocol checks.
  eq(providerKey("entra-oidc"), "entra", "providerKey: a vendor-suffixed id folds onto the vendor (entra-oidc -> entra)");
  eq(providerKey("github-oauth2"), "github", "providerKey: github-oauth2 -> github (vendor beats the generic oauth)");
  eq(providerKey("generic-oidc"), "oidc", "providerKey: generic-oidc -> oidc");
  eq(providerKey("generic-oauth2"), "oauth", "providerKey: generic-oauth2 -> oauth");
  eq(providerKey("generic-saml"), "saml", "providerKey: generic-saml -> saml");
  eq(providerKey("auth0"), "auth0", "providerKey: auth0 -> auth0");
  eq(providerKey({ kind: "saml" }), "saml", "providerKey: a SAML connection keys on its kind");
  eq(providerKey({ kind: "oidc", presetId: "okta" }), "okta", "providerKey: an OIDC connection keys on its presetId");
  eq(providerKey("totally-unknown"), null, "providerKey: an unrecognised id -> null (the grid gives it a fallback mark)");

  // PROVIDER_META covers the ten engine providers + SAML, each with a label and a unique rank.
  const META_KEYS = ["entra", "okta", "google", "github", "auth0", "gitlab", "keycloak", "jumpcloud", "saml", "oidc", "oauth"] as const;
  ok("PROVIDER_META covers the ten providers + SAML (11), each labelled", META_KEYS.every((k) => PROVIDER_META[k] && PROVIDER_META[k].label.length > 0));
  ok("PROVIDER_META ranks are unique", new Set(META_KEYS.map((k) => PROVIDER_META[k].rank)).size === META_KEYS.length);

  // providerLogo returns an <svg> mark for every key and for an unknown key (the neutral fallback).
  ok("providerLogo returns an SVG mark for each provider", META_KEYS.every((k) => providerLogo(k).tagName.toLowerCase() === "svg"));
  ok("providerLogo returns the fallback SVG for an unknown key", providerLogo(null).tagName.toLowerCase() === "svg");

  // buildProviderTiles: from the catalogue + connections it yields a tile per provider PLUS the synthetic
  // SAML tile, ordered by rank, each in the right state. This mirrors the demo seed (an enabled Entra OIDC, an
  // enabled SAML, a disabled GitHub).
  const tPresets = [
    { id: "entra", label: "Microsoft Entra ID", vendor: "Microsoft", buttonLabel: "", kind: "oidc", requiredVars: [], notes: [] },
    { id: "okta", label: "Okta", vendor: "Okta", buttonLabel: "", kind: "oidc", requiredVars: [], notes: [] },
    { id: "github", label: "GitHub", vendor: "GitHub", buttonLabel: "", kind: "oauth2", requiredVars: [], notes: [] },
  ] as IdpPreset[];
  const tConns = [
    { kind: "oidc", presetId: "entra-oidc", enabled: true },
    { kind: "oauth2", presetId: "github-oauth2", enabled: false },
    { kind: "saml", presetId: "generic-saml", enabled: true },
  ] as unknown as IdpConnectionView[];
  const tiles = buildProviderTiles(tPresets, tConns);
  const tile = (id: string) => tiles.find((t) => t.id === id)!;
  eq(JSON.stringify(tiles.map((t) => t.id)), JSON.stringify(["entra", "okta", "saml", "github"]), "buildProviderTiles: tiles are popularity-ordered with SAML placed by rank");
  eq(tileState(tile("entra")), "live", "tile state: an enabled connection -> live");
  eq(tileState(tile("okta")), "available", "tile state: no connection -> available");
  eq(tileState(tile("github")), "configured", "tile state: a connection that is all-disabled -> configured");
  eq(tileState(tile("saml")), "live", "tile state: the enabled SAML connection -> live");
  ok("the SAML tile is the synthetic (preset-less) one", tile("saml").isSaml === true && tile("saml").preset === undefined);
  ok("a vendor tile carries its preset for the add form", tile("entra").isSaml === false && tile("entra").preset !== undefined);

  // ---- mountProviderButtons: the no-lockout / fail-open sign-in wiring ----
  console.log("\n-- mountProviderButtons (sign-in providers; fail-open / no-lockout) --");

  // A structural engine stub: mountProviderButtons only calls idpProviders() and idpStartUrlFor(). We
  // control the providers result per case and capture the start URL the button navigates to.
  const makeEngine = (providersResult: () => Promise<{ ok: boolean; providers: Array<{ id: string; label: string; kind: IdpKind; presetId: string }> }>): EngineClient =>
    ({
      idpProviders: providersResult,
      idpStartUrlFor: (p: { id: string; kind: IdpKind }, returnTo?: string) => {
        const path = p.kind === "saml" ? `/admin/saml/start/${p.id}` : `/admin/oidc/start/${p.id}`;
        return `https://engine.test${path}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;
      },
    }) as unknown as EngineClient;

  // Case 1: populated providers -> a button per provider, click navigates the top-level window.
  {
    lastAssigned = null;
    const slot = h("div");
    const engine = makeEngine(async () => ({ ok: true, providers: [
      { id: "entra", label: "Microsoft Entra", kind: "oidc", presetId: "entra" },
      { id: "corp", label: "Corp SAML", kind: "saml", presetId: "generic-saml" },
    ] }));
    mountProviderButtons(slot, engine, "/runs");
    await Promise.resolve(); await Promise.resolve(); // let the idpProviders microtask settle
    const texts = buttonTexts(slot);
    ok("populated: a 'Sign in with X' button renders per enabled provider", texts.includes("Sign in with Microsoft Entra") && texts.includes("Sign in with Corp SAML"));

    // Click the first provider button and assert the top-level navigation to the OIDC start URL.
    const firstBtn = findButton(slot, "Sign in with Microsoft Entra");
    ok("populated: the provider button is a real clickable element", firstBtn !== null);
    firstBtn?.click();
    eq(lastAssigned, "https://engine.test/admin/oidc/start/entra?returnTo=%2Fruns", "populated: clicking the OIDC button navigates the top-level window to the engine start URL with returnTo");

    // The SAML button routes to the SAML start path.
    lastAssigned = null;
    findButton(slot, "Sign in with Corp SAML")?.click();
    eq(lastAssigned, "https://engine.test/admin/saml/start/corp?returnTo=%2Fruns", "populated: clicking the SAML button navigates to the SAML start URL");
  }

  // Case 2: EMPTY providers list -> the slot stays empty (passkey + token remain the only way in).
  {
    const slot = h("div");
    const engine = makeEngine(async () => ({ ok: true, providers: [] }));
    mountProviderButtons(slot, engine, "/");
    await Promise.resolve(); await Promise.resolve();
    eq(buttonTexts(slot).length, 0, "empty list: NO provider buttons render (passkey + token stay the way in; no noise)");
  }

  // Case 3: FAILED providers fetch -> the slot stays empty (fail-open, never an error banner).
  {
    const slot = h("div");
    const engine = makeEngine(async () => { throw new Error("not found: 404"); });
    mountProviderButtons(slot, engine, "/");
    await Promise.resolve(); await Promise.resolve();
    eq(buttonTexts(slot).length, 0, "failed fetch: the slot stays empty (fail-open; no error noise on the sign-in screen)");
  }

  // ---- add-connection success toast: creation is IMMEDIATE, so the copy must say so (ASVS V10 ML-06) -----
  // Regression for a false toast: both add forms create the connection already enabled (there is no separate
  // activation step server-side), but used to tell the operator "Enable it to show the sign-in button." /
  // "...then enable it." Drives the REAL presetForm/samlForm (not a copy of the string) through a stub engine
  // and reads the rendered toast text, so a future copy edit that reintroduces the false "a step remains"
  // implication fails here rather than only being caught by eyeballing the diff.
  console.log("\n-- add-connection success toast (creation enables immediately; no separate step remains) --");

  // Reads the live toast-region text off document.body (the toast component's own DOM, independent of
  // whichever form's `wrap` is in scope), mirroring the toastText()/clearToasts() pattern validate-tour.ts
  // uses for the same reason: toast() never returns a handle the caller can inspect directly.
  const toastRegionText = (): string => {
    let t = "";
    for (const n of document.body.childNodes as unknown as Iterable<{ className?: string; textContent?: string }>) {
      if (typeof n.className === "string" && n.className.includes("toast-region")) t += ` ${n.textContent ?? ""}`;
    }
    return t.trim();
  };
  const clearToastRegions = (): void => {
    for (const n of document.body.childNodes as unknown as Iterable<{ className?: string; replaceChildren?: () => void }>) {
      if (typeof n.className === "string" && n.className.includes("toast-region")) n.replaceChildren?.();
    }
  };
  const setValue = (root: HTMLElement, sel: string, v: string): void => {
    (root.querySelector(sel) as unknown as { value: string }).value = v;
  };

  // OIDC/OAuth2 preset form. The preset id is deliberately outside IDP_GUIDES and carries no notes, so
  // presetGuidePanel mounts neither guide branch and never calls engine.idpRedirectUri; only the client id +
  // secret need filling in (the label/id fields keep their valid preset-derived defaults).
  {
    clearToastRegions();
    const preset: IdpPreset = { id: "test-preset", label: "Test Preset", vendor: "Test Vendor", buttonLabel: "", kind: "oidc", requiredVars: [], notes: [] };
    const engine = {
      getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }),
      createIdpConnection: async () => ({ status: "result", value: { ok: true, conn: {} } }),
    } as unknown as EngineClient;
    const wrap = presetForm(engine, preset, () => {});
    setValue(wrap, "#idp-client-id", "test-client-id");
    setValue(wrap, "#idp-secret", "test-secret");
    findButton(wrap, "Add Test Preset")?.click();
    await tick();
    eq(
      toastRegionText(),
      "Test Preset added and enabled. The sign-in button appears for everyone now. Disable it below if you are not ready to go live.",
      "preset add toast: states the connection is already enabled (not that an 'enable' step remains)",
    );
  }

  // Generic SAML 2.0 form. samlGuidePanel reads engine.samlAcsUrl once at construction (the live ACS-URL
  // callout), so the stub carries it even though this case never changes the connection id.
  {
    clearToastRegions();
    const engine = {
      samlAcsUrl: (connId: string) => `https://console.test/admin/saml/acs/${connId}`,
      getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }),
      createIdpConnection: async () => ({ status: "result", value: { ok: true, conn: {} } }),
    } as unknown as EngineClient;
    const wrap = samlForm(engine, () => {});
    setValue(wrap, "#saml-label", "Test SAML");
    setValue(wrap, "#saml-idp-entity", "https://idp.example.com/metadata");
    setValue(wrap, "#saml-idp-sso", "https://idp.example.com/sso");
    setValue(wrap, "#saml-sp-entity", "https://console.test/saml");
    setValue(wrap, "#saml-certs", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----");
    findButton(wrap, "Add SAML provider")?.click();
    await tick();
    eq(
      toastRegionText(),
      "Test SAML added and enabled. Download its SP metadata from the card and give it to your IdP. The sign-in button appears for everyone now. Disable it below if you are not ready to go live.",
      "SAML add toast: states the connection is already enabled (not that an 'enable' step remains)",
    );
  }
  clearToastRegions();

  // ---- Test connection payload carries kind (regression: engine/src/admin/idp-test.ts:110-121 dispatches
  // on proposal.kind with no presetId lookup at all, so a preset payload missing it always failed with
  // "Unknown connection kind (none supplied)"; only the SAML form ever set kind, so only SAML's test ever
  // ran a real check) ------------------------------------------------------------------------------------
  console.log("\n-- Test connection: every OIDC/OAuth2 preset's payload carries kind --");
  for (const kind of ["oidc", "oauth2"] as const) {
    let captured: unknown = null;
    const preset: IdpPreset = { id: `test-${kind}`, label: `Test ${kind}`, vendor: "Test Vendor", buttonLabel: "", kind, requiredVars: [], notes: [] };
    const engine = {
      getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }),
      testIdpConnection: async (payload: unknown) => {
        captured = payload;
        return { ok: true, checks: [] };
      },
    } as unknown as EngineClient;
    const wrap = presetForm(engine, preset, () => {});
    setValue(wrap, "#idp-client-id", "test-client-id");
    setValue(wrap, "#idp-secret", "test-secret");
    findButton(wrap, "Test connection")?.click();
    await tick();
    eq((captured as { kind?: string } | null)?.kind, kind, `Test connection payload for the "${kind}" preset carries kind:"${kind}" (was previously absent, dispatcher-only)`);
  }

  // ---- per-provider setup guides (idp-guides.ts): every preset has a well-formed "How to add X" guide ----
  console.log("\n-- per-provider setup guides (idp-guides.ts) --");
  // The 10 engine presets (oidc-presets.ts). A guide must exist for each so the form is never bare; a future
  // engine preset with no guide falls back to its engine notes (presetForm handles that), but the named ten
  // are pinned here so a guide can never silently go missing.
  const EXPECTED_GUIDE_IDS = ["entra", "okta", "google", "keycloak", "jumpcloud", "auth0", "gitlab", "generic-oidc", "github", "generic-oauth2"];
  for (const id of EXPECTED_GUIDE_IDS) {
    const g = IDP_GUIDES[id];
    ok(`guide "${id}" exists`, g !== undefined);
    if (!g) continue;
    ok(`guide "${id}": names its redirect field`, typeof g.redirectFieldName === "string" && g.redirectFieldName.length > 0);
    ok(`guide "${id}": has at least 4 ordered steps`, Array.isArray(g.steps) && g.steps.length >= 4);
    ok(`guide "${id}": every step is non-empty`, g.steps.every((s) => typeof s === "string" && s.trim().length > 0));
    ok(`guide "${id}": a step points at the callback URL shown in the form`, g.steps.some((s) => /callback url/i.test(s)));
    ok(`guide "${id}": no em dash (Australian-English copy convention)`, [...g.steps, ...(g.gotchas ?? []), ...(g.groups?.items ?? [])].every((s) => !s.includes("—")));
    if (g.groups) ok(`guide "${id}": groups section carries a heading + items`, g.groups.heading.length > 0 && g.groups.items.length > 0);
    if (g.docsUrl) ok(`guide "${id}": docs URL is https`, /^https:\/\//.test(g.docsUrl));
  }
  // Spot-checks pinning the validated research (each provider's OWN name for the redirect field, so the step
  // tells the operator exactly which box to paste into).
  eq(IDP_GUIDES.github?.redirectFieldName, "Authorization callback URL", "github: redirect field is GitHub's 'Authorization callback URL'");
  eq(IDP_GUIDES.okta?.redirectFieldName, "Sign-in redirect URIs", "okta: redirect field is Okta's 'Sign-in redirect URIs'");
  eq(IDP_GUIDES.auth0?.redirectFieldName, "Allowed Callback URLs", "auth0: redirect field is Auth0's 'Allowed Callback URLs'");
  eq(IDP_GUIDES.google?.redirectFieldName, "Authorized redirect URIs", "google: redirect field is Google's 'Authorized redirect URIs'");
  ok("entra: a step warns to copy the secret Value (not the Secret ID)", (IDP_GUIDES.entra?.steps ?? []).some((s) => /secret value/i.test(s)));
  ok("google: the guide is honest that Google sends no groups", /no groups|sign-in only|does not put group/i.test(JSON.stringify(IDP_GUIDES.google?.groups ?? {})));

  // The generic SAML guide (no preset; the form composes the proposal). Registered value is the ACS URL.
  ok("SAML guide names the ACS field", typeof SAML_GUIDE.acsFieldName === "string" && SAML_GUIDE.acsFieldName.length > 0);
  ok("SAML guide has at least 4 steps", SAML_GUIDE.steps.length >= 4);
  ok("SAML guide: a step points at the ACS URL shown in the form", SAML_GUIDE.steps.some((s) => /acs/i.test(s)));
  ok("SAML guide: no em dash", [...SAML_GUIDE.steps, ...(SAML_GUIDE.gotchas ?? [])].every((s) => !s.includes("—")));

  console.log(failures === 0 ? "\nNATIVE-IdP CONSOLE VECTORS PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures > 0 ? 1 : 0);
}

// findButton walks the shim tree for the first <button> whose trimmed text matches, returning it so the
// caller can drive its real click() (which the shim turns into a proper bubbling click event).
function findButton(node: unknown, text: string): { click: () => void } | null {
  let found: { click: () => void } | null = null;
  const walk = (n: { tagName?: string; childNodes?: unknown[]; textContent?: string; click?: () => void }): void => {
    if (found) return;
    if ((n.tagName === "BUTTON" || n.tagName === "button") && (n.textContent ?? "").trim() === text && typeof n.click === "function") {
      found = { click: n.click.bind(n) };
      return;
    }
    for (const c of (n.childNodes ?? []) as Array<typeof n>) walk(c);
  };
  walk(node as { tagName?: string; childNodes?: unknown[]; textContent?: string; click?: () => void });
  return found;
}

main().catch((err) => {
  console.error("\nVALIDATE-IDP THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
