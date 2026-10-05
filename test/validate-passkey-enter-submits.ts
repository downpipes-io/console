// The admin-token field (screens/passkey/flows.ts renderAdminTokenBlock) and the /register email field
// (screens/passkey/sign-in-body.ts, screens/passkey.ts) sit outside any <form>, so pressing Enter in
// either does nothing: only a click on the button beside it runs anything. This pins the fix: each field
// now lives inside a <form> whose submit event (what a real browser fires on Enter in a single-field
// form) runs the SAME handler as the button, with preventDefault so the page never reloads, and a click
// on the button still runs the handler exactly once (no double submit from wrapping it).
// Run with: node test/validate-passkey-enter-submits.ts

import { installDomShim } from "./dom-shim.ts";

installDomShim();

// The screen's feature-detect needs navigator.credentials + PublicKeyCredential to consider passkeys
// supported; neither create() nor get() is ever called by the cases below (both submits here take the
// synchronous validation-failure / stubbed-fetch-rejection path), so the stub bodies are never reached.
function installMinimalWebAuthnGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  Object.defineProperty(g, "navigator", {
    configurable: true,
    writable: true,
    value: { credentials: { create: async () => null, get: async () => null } },
  });
  g.PublicKeyCredential = function PublicKeyCredential() {};
}
installMinimalWebAuthnGlobals();

import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean): void {
  checks += 1;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures += 1;
}

// stubRejectingFetch counts calls and answers every request with a refused (401) response, so
// renderAdminTokenBlock's click handler runs its catch branch without ever reaching the network for real.
function stubRejectingFetch(): { calls: () => number; restore: () => void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  let n = 0;
  g.fetch = async () => {
    n += 1;
    return {
      ok: false,
      status: 401,
      headers: { get: () => null },
      async text() { return "{}"; },
      async json() { return {}; },
      clone() { return this; },
    };
  };
  return { calls: () => n, restore: () => { g.fetch = prev; } };
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
}

async function testAdminTokenField(): Promise<void> {
  console.log("\n-- the admin-token field submits on Enter, once per press, click still once --");
  const { renderAdminTokenBlock } = await import("../src/screens/passkey/flows.ts");
  const block = renderAdminTokenBlock() as unknown as HTMLElement;
  const form = block.querySelector("form");
  const tokenInput = block.querySelector('[data-dp="passkey.password.token"]') as HTMLInputElement | null;
  const tokenBtn = block.querySelector('[data-dp="passkey.button.token"]') as HTMLButtonElement | null;
  ok("the field now sits inside a form", form !== null);
  ok("the token input renders with its id unchanged", tokenInput !== null);
  ok("the sign-in button renders with its id and label unchanged", tokenBtn !== null && tokenBtn.textContent === "Sign in with the admin token");
  if (!form || !tokenInput || !tokenBtn) return;

  tokenInput.value = "a-token-value";
  const { calls, restore } = stubRejectingFetch();

  // Enter in the field: a real browser fires the form's submit event. defaultPrevented must be true, so
  // the page never reloads. The shim's Event shape is narrower than the real DOM lib's, so the dispatch
  // goes through Event: the object the shim actually reads (type, target, defaultPrevented,
  // preventDefault, bubbles, stopPropagation) is unchanged at runtime.
  const submitEvent = makeEvent({ type: "submit", bubbles: true, cancelable: true });
  const notCancelled = form.dispatchEvent(submitEvent as unknown as Event);
  await flush();
  ok("submitting the form calls preventDefault (the page does not reload)", submitEvent.defaultPrevented === true && notCancelled === false);
  ok("submitting the form ran the sign-in attempt exactly once", calls() === 1);

  // A click on the button still runs the SAME attempt exactly once (no double submit from the click also
  // triggering the form, which type="button" never does).
  tokenBtn.click();
  await flush();
  ok("a click on the button (after the Enter submit) adds exactly one more attempt, not two", calls() === 2);

  restore();
}

async function testRegisterEmailField(): Promise<void> {
  console.log("\n-- the /register email field submits on Enter, once per press, click still once --");
  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
  store.connect("https://engine.test");
  const { passkeyScreen } = await import("../src/screens/passkey.ts");

  const root = passkeyScreen.render({
    pattern: "/register", params: {}, query: new URLSearchParams(), path: "/register",
  } as unknown as Parameters<typeof passkeyScreen.render>[0]) as unknown as HTMLElement;

  const emailInput = root.querySelector("#pk-email") as HTMLInputElement | null;
  const registerBtn = root.querySelector('[data-dp="passkey.button.register"]') as HTMLButtonElement | null;
  const form = emailInput ? (emailInput.closest ? emailInput.closest("form") : null) : null;
  ok("the /register email field renders with its id unchanged", emailInput !== null);
  ok("the set-up button renders with its id and label unchanged", registerBtn !== null && registerBtn.textContent === "Set up a passkey");
  ok("the email field now sits inside a form", form !== null);
  if (!emailInput || !registerBtn || !form) return;

  // The field is left blank, so the submit handler's own validation refuses it synchronously and focuses
  // the field, WITHOUT ever reaching the network or the WebAuthn ceremony -- an observable, deterministic
  // side effect that still proves the wiring: submit and click both run the one handler, and only once
  // each.
  let focusCalls = 0;
  const originalFocus = emailInput.focus.bind(emailInput);
  emailInput.focus = () => { focusCalls += 1; originalFocus(); };

  // See testAdminTokenField's comment: the cast to Event is a type-only widening, never a runtime change.
  const submitEvent = makeEvent({ type: "submit", bubbles: true, cancelable: true });
  const notCancelled = form.dispatchEvent(submitEvent as unknown as Event);
  ok("submitting the form calls preventDefault (the page does not reload)", submitEvent.defaultPrevented === true && notCancelled === false);
  ok("submitting the empty form focuses the field exactly once (the same refusal the button gives)", focusCalls === 1);

  registerBtn.click();
  ok("a click on the button (after the Enter submit) adds exactly one more focus, not two", focusCalls === 2);
}

async function main(): Promise<void> {
  await testAdminTokenField();
  await testRegisterEmailField();

  verdictReached(failures, checks);
  console.log(`validate-passkey-enter-submits: ${checks} checks, ${failures} failures`);
  if (failures > 0) {
    console.error(`validate-passkey-enter-submits: ${failures} FAILURES`);
    process.exitCode = 1;
  }
}

void main();
