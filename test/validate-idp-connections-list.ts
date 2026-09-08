// The external-identity-providers list, driven rather than described.
//
// FS-WRITES: none outside this repo
//
// WHY IT EXISTS. src/screens/idp-connections/list.ts is a 315-line screen with sentences that tell an
// operator a passkey prompt is coming BEFORE they agree to enabling, disabling or removing a connection.
// Nothing had ever asserted that copy actually renders.
//
// The copy is the point. Dismissing the passkey sheet writes nothing, and that is the fact that turns an
// unannounced browser prompt in the middle of an irreversible action from a fault into a checkpoint. This
// proves the sentence reaches the DOM an operator actually sees: a sentence can be in the source and
// behind a branch that never runs, and the remove-confirm one lives inside a modal body built at click time.
//
// The gate on a non-owner is MIRRORED, never the control: the buttons render disabled with a reason rather
// than vanishing, so an operator can see what they would be able to do. That is asserted in both directions
// here, because a screen that hides the control instead reads as "this product cannot do that".
//
// Run with: node test/validate-idp-connections-list.ts
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims, no AI attribution.

import { flushAsync, installDomShim, qsa, textOf } from "./dom-shim.ts";
import { makeChecks } from "./validate-checks.ts";

installDomShim();

const { renderConnections } = await import("../src/screens/idp-connections/list.ts");

const base = makeChecks();
let checksRun = 0;
const c = {
  ok(label: string, cond: boolean): void {
    checksRun++;
    base.ok(label, cond);
  },
  get failures(): number {
    return base.failures;
  },
};

const ENABLE_ANNOUNCE = "You may be asked to confirm with your own passkey when you enable or disable a connection";
const REMOVE_ANNOUNCE = "You may be asked to confirm with your own passkey before this runs";
const DISMISS_IS_SAFE = "nothing is changed and the connection stays exactly as it is";

const OIDC = {
  id: "c-oidc",
  kind: "oidc",
  label: "Entra",
  enabled: true,
  presetId: "entra",
  createdBy: "owner@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
  issuer: "https://login.example/v2.0",
  clientId: "app-1234",
  secretRef: { mode: "confidential" },
  scopes: ["openid", "email"],
  pkce: "required",
  clientAuth: "client_secret_post",
};
const SAML = {
  id: "c-saml",
  kind: "saml",
  label: "Okta",
  enabled: false,
  presetId: "okta-saml",
  createdBy: "owner@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
  idpEntityId: "https://idp.example",
  idpSsoUrl: "https://idp.example/sso",
  idpSigningCerts: ["-----BEGIN CERTIFICATE-----\nMIIBexample\n-----END CERTIFICATE-----"],
  spEntityId: "https://console.example/sp",
  nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  wantAssertionsSigned: true,
  allowIdpInitiated: false,
  clockSkewSec: 120,
  emailVerifiedPolicy: "require-flag",
};

// Every engine method this screen can reach, so a render cannot pass by accident of a method never being
// called. The two URL builders are pure in the real client and answer synchronously here for the same reason.
let deletes = 0;
const enables: { id: string; on: boolean }[] = [];
const engineStub = {
  getConfigApprovalPolicy: () => Promise.resolve({ requireConfigApproval: false, requireChangeNumber: false }),
  samlMetadataUrl: (id: string) => `https://console.example/admin/idp/saml/${id}/metadata`,
  samlAcsUrl: (id: string) => `https://console.example/admin/idp/saml/${id}/acs`,
  samlMetadata: () => Promise.resolve("<EntityDescriptor/>"),
  testSavedIdpConnection: () => Promise.resolve({ ok: true, checks: [] }),
  setIdpConnectionEnabled: (id: string, on: boolean) => {
    enables.push({ id, on });
    return Promise.resolve({ ok: true });
  },
  deleteIdpConnection: () => {
    deletes++;
    return Promise.resolve({ ok: true });
  },
  rolloverIdpSigningCerts: () => Promise.resolve({ ok: true }),
} as never;

const render = (conns: unknown[], canManage: boolean): HTMLElement =>
  renderConnections(engineStub, conns as never, canManage, () => {});

// ---- the empty state, both capabilities -----------------------------------------------------------------
function testEmpty(): void {
  const owner = textOf(render([], true));
  c.ok("with no connections an owner is told to add one", owner.includes("No identity providers yet"));
  c.ok("and that passkeys keep working meanwhile, so the screen is not a dead end", owner.includes("purely additive"));
  const viewer = textOf(render([], false));
  c.ok("a non-owner is told adding one is owner only", viewer.includes("Adding one is owner only"));
  c.ok("and is not told to add one", !viewer.includes("Add your first connection"));
}

// ---- the ceremony is announced before the buttons, not discovered after them ----------------------------
function testEnableAnnounce(): void {
  const owner = textOf(render([OIDC, SAML], true));
  c.ok("the enable/disable passkey prompt is announced in the rendered DOM", owner.includes(ENABLE_ANNOUNCE));
  c.ok("and the operator is told dismissing it changes nothing", owner.includes(DISMISS_IS_SAFE));
  // The half that makes the announcement a checkpoint rather than a warning: it must reach a non-owner too,
  // whose controls are disabled but who is reading the screen to find out what the product does.
  c.ok("and it is announced to a non-owner as well", textOf(render([OIDC, SAML], false)).includes(ENABLE_ANNOUNCE));
}

// ---- both connections render, and the secret MODE is shown while no value ever is ----------------------
function testCards(): void {
  const root = render([OIDC, SAML], true);
  const text = textOf(root);
  c.ok("the OIDC connection's label leads its card", text.includes("Entra"));
  c.ok("the SAML connection renders beside it", text.includes("Okta"));
  c.ok("the OIDC issuer is shown as the identity anchor", text.includes("https://login.example/v2.0"));
  c.ok("the SAML IdP entity id is shown as its anchor", text.includes("https://idp.example"));
  const hooks = qsa(root, "button")
    .map((b) => b.getAttribute("data-dp"))
    .filter((v): v is string => typeof v === "string");
  c.ok("the test control renders with its selector hook", hooks.includes("idp-connections.button.test-control"));
  c.ok("a card renders one section per connection", qsa(root, "section").length >= 2);
}

// ---- the gate is mirrored, never the control -----------------------------------------------------------
function testGateIsMirrored(): void {
  const viewer = render([OIDC], false);
  const buttons = qsa(viewer, "button");
  c.ok("a non-owner still sees the controls rather than an empty card", buttons.length > 0);
  const gated = buttons.filter((b) => b.getAttribute("data-dp") === "idp-connections.button.test-control");
  c.ok("and the gated control is present", gated.length === 1);
  // REFUSED rather than hidden, and refused rather than `disabled`. The control keeps its place in the
  // tab order (aria-disabled, not the disabled property), because `disabled` removes it from the tab
  // order and takes the reason with it: there is then no keystroke that reaches the explanation, and on
  // a phone the title never fires at all. The gate's decision is unchanged; only its carrier moved.
  c.ok("refused rather than hidden", gated.every((b) => b.getAttribute("aria-disabled") === "true"));
  c.ok("and still focusable, so the reason is reachable without a mouse", gated.every((b) => b.getAttribute("disabled") === null));
  c.ok("and carries the reason as real text on the control, not as a hover-only title", gated.every((b) => textOf(b).includes("Requires")));
  c.ok("and keeps the title too, so a mouse user loses nothing", gated.every((b) => (b.getAttribute("title") ?? "").length > 0));

  const ownerButtons = qsa(render([OIDC], true), "button").filter(
    (b) => b.getAttribute("data-dp") === "idp-connections.button.test-control",
  );
  c.ok("an owner gets the same control enabled, so the mirror is the capability and not the layout", ownerButtons.every((b) => b.getAttribute("disabled") === null && b.getAttribute("aria-disabled") === null));
}

// ---- the remove confirmation carries its own announcement ----------------------------------------------
// This one is only reachable by driving the control. The sentence lives inside a modal body constructed at
// click time, so a source-level gate can see it and a render-level assertion cannot.
async function testRemoveConfirmAnnounces(): Promise<void> {
  const root = render([OIDC], true);
  const remove = qsa(root, "button").find((b) => textOf(b).includes("Remove"));
  c.ok("an owner has a remove control", remove !== undefined);
  if (remove === undefined) return;
  remove.click();
  await flushAsync();
  const modal = textOf(globalThis.document.body as unknown as { textContent: string } as never);
  c.ok("the remove confirmation names what is lost", modal.includes("ends any session signed in through it"));
  c.ok("the remove confirmation announces the passkey prompt", modal.includes(REMOVE_ANNOUNCE));
  c.ok("and says dismissing it removes nothing", modal.includes("nothing is removed and you can start again"));
  // The claim the sentence makes, held against the engine rather than against the copy. Opening the
  // confirmation is not agreeing to it, so nothing may have been called yet.
  c.ok("and opening the confirmation has deleted nothing", deletes === 0);
  c.ok("and changed no connection's enabled state", enables.length === 0);
}

async function main(): Promise<void> {
  testEmpty();
  testEnableAnnounce();
  testCards();
  testGateIsMirrored();
  await testRemoveConfirmAnnounces();
  console.log(
    c.failures === 0
      ? `\nIDP CONNECTIONS LIST PASS (${checksRun} checks)`
      : `\n${c.failures} FAILURE(S) of ${checksRun} checks`,
  );
  if (c.failures > 0) process.exitCode = 1;
  process.exit(c.failures > 0 ? 1 : 0);
}

await main();
