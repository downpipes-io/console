// The destination form must not lose an unsaved secret access key to an
// ordinary navigation. Run with: node test/validate-destination-form-leave-guard.ts
//
// WHY THIS EXISTS. The key ceremony and the new-downpipe wizard both register a leave guard; the
// destination form did not, and it is the one that holds a value the customer cannot get back. A secret
// access key is shown once, when it is minted, by R2 and by S3 alike. A rail click, the command palette or
// the setup strip's own Continue tore the form down with no prompt, and re-typing was not an option: the
// customer had to go and mint a new key pair.
//
// It is the FIRST-RUN form as well, reached from a setup strip whose entire job is to move people between
// screens, so the navigation that destroyed the work was the one the product suggested.
//
// This renders the REAL destinationForm and drives the REAL navigate(), so it fails if the guard is removed,
// if it stops being registered, or if navigate stops consulting it.

import { flushAsync, installDomShim, markConnected, qs } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";

installDomShim();

import type { Caller, EngineClient } from "../src/api.ts";
import { installNav, navigate, clearLeaveGuard } from "../src/lib/nav.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import type { FormContext } from "../src/screens/destination-form-fields.ts";

let navigated: string[] = [];
installNav({ navigate: (to: string) => { navigated.push(to); }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

connect("https://engine.test");

const fctx: FormContext = {
  engineAccountId: "0f2ac7c1b6e0470a8f3d1c2b4a5e6f70",
  engineR2Buckets: ["engine-archive"],
  sourceR2Buckets: new Set<string>(),
  discoveryRead: true,
  downpipesRead: true,
};

const engine = {} as unknown as EngineClient;

/** Mounts the real form and returns it, connected, the way the destinations screen mounts it. */
function mount(opts: Record<string, unknown> = {}): HTMLElement {
  const form = destinationForm(engine, fctx, { confirmReplace: false, onSaved: () => {}, ...opts } as never);
  document.body.replaceChildren(form);
  markConnected(form);
  return form as unknown as HTMLElement;
}

/** Types into a field the way a keystroke does (value set AND the input event fired). */
function type(form: HTMLElement, selector: string, value: string): void {
  const el = qs(form as unknown as never, selector) as unknown as { value: string; dispatchEvent: (e: unknown) => boolean } | null;
  if (el === null) throw new Error(`no control matched ${selector}`);
  el.value = value;
  el.dispatchEvent(makeEvent({ type: "input", bubbles: true }));
}

console.log("an unsaved secret access key survives a navigation");

// ---- 1. An untouched form must NOT prompt. ---------------------------------------------------------------
// Asserted first and deliberately: a guard that prompts on every visit trains people to dismiss the one
// prompt that matters, and it is the failure mode a naive "is anything filled in" predicate produces on the
// replace flow, where the name and the endpoint are prefilled.
{
  setCaller({ method: "access", email: "owner@test", role: "owner", groups: [], isOnlyOwner: true } as unknown as Caller);
  navigated = [];
  const untouched = mount();
  ok("the form mounted", untouched.isConnected);
  navigate("/sources");
  ok("an untouched form does not stand in the way", navigated.length === 1 && navigated[0] === "/sources");
  clearLeaveGuard();
}

// ---- 2. A typed secret DOES stop the navigation. ---------------------------------------------------------
{
  navigated = [];
  const form = mount();
  type(form, "#dest-secret", "a-secret-that-cloudflare-will-never-show-again");
  navigate("/sources");
  await flushAsync();
  ok("a typed secret access key stops the navigation", navigated.length === 0, `navigated: ${JSON.stringify(navigated)}`);
  const modalText = (document.body as unknown as { textContent?: string }).textContent ?? "";
  ok("and the operator is asked, not silently blocked", /Discard this destination\?/.test(modalText));
  ok("and the prompt says why re-typing is not an option", /shown only once/.test(modalText), modalText.slice(0, 400));
  clearLeaveGuard();
}

// ---- 3. A prefilled REPLACE form is not dirty on arrival. -------------------------------------------------
// The replace flow seeds the name from the destination being replaced. Comparing against a snapshot rather
// than against emptiness is what keeps this quiet, and this case fails if that regresses.
{
  navigated = [];
  const prefilled = mount({ initialLabel: "Primary archive" });
  ok("the replace form mounted", prefilled.isConnected);
  navigate("/downpipes");
  ok("a prefilled replace form is not treated as typed-in work", navigated.length === 1 && navigated[0] === "/downpipes");
  clearLeaveGuard();
}

// ---- 4. A viewer is never asked. --------------------------------------------------------------------------
// The save control is disabled-with-reason for anyone below Owner, so a viewer's typing can never become a
// destination and a prompt about losing it would be a question with no useful answer.
{
  setCaller({ method: "access", email: "viewer@test", role: "viewer", groups: [], isOnlyOwner: false } as unknown as Caller);
  navigated = [];
  const form = mount();
  type(form, "#dest-secret", "typed-by-someone-who-cannot-save");
  navigate("/sources");
  await flushAsync();
  ok("a caller who cannot save is not asked to confirm a discard", navigated.length === 1 && navigated[0] === "/sources");
  clearLeaveGuard();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
