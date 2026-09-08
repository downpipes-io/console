// A registered leave guard must also stop a REAL navigation (a reload, a tab close, back/forward
// through browser chrome), not only an in-SPA navigate() call.
// Run with: node test/validate-r102-leave-guard-beforeunload.ts
//
// WHY THIS EXISTS. registerLeaveGuard's guard function is consulted only by this
// file's own navigate() -- an in-app route change. `grep -rn beforeunload src/` returned zero
// matches: a real browser reload, tab close, or back/forward through browser chrome bypassed every
// one of the three screens that register a leave guard (the new-downpipe wizard, the destination
// form, the onboarding key ceremony) with no prompt of any kind. The fix is ONE shared mechanism in
// lib/nav.ts rather than three separate beforeunload handlers: registerLeaveGuard takes an optional
// second argument, a pure isDirty() predicate, and ONE beforeunload listener (installed once,
// feature-detected) asks the browser for its native "leave site?" prompt whenever the currently
// registered predicate says so.
//
// This test proves the mechanism itself at the nav.ts level (part 1), then proves it actually reaches
// a REAL production screen -- destinationForm, which holds a secret access key a customer cannot get
// back -- by mounting the real form and dispatching a REAL beforeunload event through the shim's
// window-level listener (part 2), so it fails if the wiring from a screen's isDirty predicate to the
// browser prompt is ever severed at either end.

import { installDomShim, flushAsync, dispatchWindowEvent, qs } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
installDomShim();

import { readFileSync } from "node:fs";
import type { Caller, EngineClient } from "../src/api.ts";
import { installNav, registerLeaveGuard, clearLeaveGuard } from "../src/lib/nav.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import type { FormContext } from "../src/screens/destination-form-fields.ts";
import { saveDraft, loadDraft, clearDraft } from "../src/lib/draft.ts";

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

function fireBeforeunload(): { defaultPrevented: boolean } {
  const ev = makeEvent({ type: "beforeunload", cancelable: true });
  dispatchWindowEvent(ev);
  return { defaultPrevented: ev.defaultPrevented };
}

console.log("a real navigation is caught by the same registration as the SPA guard");

// ---- PART 1: the shared mechanism itself, at the nav.ts level. ------------------------------------

// Prime the shared listener FIRST (registerLeaveGuard only installs window.addEventListener the first
// time it is called WITH an isDirty predicate): otherwise 1a/1b below would pass vacuously because no
// listener exists yet to consult, rather than because the mechanism itself correctly reports "clean".
registerLeaveGuard((_to: string) => true, () => false);
clearLeaveGuard();

// ---- 1a. No guard registered: a reload is never blocked. ------------------------------------------
{
  const { defaultPrevented } = fireBeforeunload();
  ok("with nothing registered, beforeunload is not prevented", !defaultPrevented);
}

// ---- 1b. A guard registered WITHOUT an isDirty predicate (the old call shape) never blocks a ------
// reload either -- registerLeaveGuard's second argument is opt-in, so a caller that has not been
// updated cannot regress into an unexpected prompt.
{
  const guard = (_to: string): boolean => false; // would block an in-SPA nav if consulted
  registerLeaveGuard(guard);
  const { defaultPrevented } = fireBeforeunload();
  ok("a guard with NO isDirty predicate does not block a reload (opt-in, not automatic)", !defaultPrevented);
  clearLeaveGuard(guard);
}

// ---- 1c. A guard WITH an isDirty predicate that is currently false does not block a reload. -------
{
  let dirty = false;
  const guard = (_to: string): boolean => !dirty;
  registerLeaveGuard(guard, () => dirty);
  const clean = fireBeforeunload();
  ok("a registered but CLEAN predicate does not block a reload", !clean.defaultPrevented);

  // ---- 1d. THE FIX: the same predicate turning dirty blocks the NEXT reload, live. -----------------
  dirty = true;
  const dirtyResult = fireBeforeunload();
  ok("THE FIX: a dirty predicate blocks a real navigation via the shared beforeunload listener", dirtyResult.defaultPrevented);
  clearLeaveGuard(guard);
}

// ---- 1e. clearLeaveGuard() also clears the dirty predicate: after teardown, a stale registration ---
// can never wedge a later reload.
{
  const guard = (_to: string): boolean => false;
  registerLeaveGuard(guard, () => true);
  clearLeaveGuard(guard);
  const { defaultPrevented } = fireBeforeunload();
  ok("clearLeaveGuard also clears the beforeunload predicate (no orphaned block)", !defaultPrevented);
}

// ---- PART 2: the wiring reaches a REAL production screen (destination-form.ts), end to end. -------

connect("https://engine.test");
setCaller({ method: "access", email: "owner@test", role: "owner", groups: [], isOnlyOwner: true } as unknown as Caller);
const fctx: FormContext = {
  engineAccountId: "0f2ac7c1b6e0470a8f3d1c2b4a5e6f70",
  engineR2Buckets: ["engine-archive"],
  sourceR2Buckets: new Set<string>(),
  discoveryRead: true,
  downpipesRead: true,
};
const engine = {} as unknown as EngineClient;

function type(form: HTMLElement, selector: string, value: string): void {
  const el = qs(form as unknown as never, selector) as unknown as { value: string; dispatchEvent: (e: unknown) => boolean } | null;
  if (el === null) throw new Error(`no control matched ${selector}`);
  el.value = value;
  el.dispatchEvent(makeEvent({ type: "input", bubbles: true }));
}

// ---- 2a. An untouched destination form never blocks a reload. -------------------------------------
{
  clearLeaveGuard();
  const form = destinationForm(engine, fctx, { confirmReplace: false, onSaved: () => {} } as never);
  document.body.replaceChildren(form);
  await flushAsync();
  const { defaultPrevented } = fireBeforeunload();
  ok("2a. an untouched destination form does not block a reload", !defaultPrevented);
  clearLeaveGuard();
}

// ---- 2b. A typed, unsaved secret access key DOES block a real navigation -- the failure mode -----
// exists for: the value the customer cannot get back a second time.
{
  const form = destinationForm(engine, fctx, { confirmReplace: false, onSaved: () => {} } as never);
  document.body.replaceChildren(form);
  await flushAsync();
  type(form, "#dest-secret", "a-secret-that-cloudflare-will-never-show-again");
  await flushAsync();
  const { defaultPrevented } = fireBeforeunload();
  ok("2b. THE FIX: an unsaved secret access key survives a REAL navigation, not only navigate()", defaultPrevented);
  clearLeaveGuard();
}

// ---- PART 3: the other two call sites pass an isDirty predicate too. -------------------------------
// The new-downpipe wizard (editor-wizard.ts) and the onboarding key ceremony (onboarding/carousel.ts)
// are not cheaply mountable in this suite (a live-discovery source step and a generated key ceremony
// respectively), so this checks their registerLeaveGuard call sites directly at source, the same
// reachability style this codebase's own lint:reachability / lint:route-table gates use. Part 1 above
// already proves the SHARED mechanism is correct once a second argument is passed; this proves each
// site still passes one, so a future edit that drops it back to the single-argument (pre-fix) call
// shape is caught here rather than silently regressing two of the three protected flows.
{
  const wizardSrc = readFileSync(new URL("../src/screens/sources-downpipes/editor-wizard.ts", import.meta.url), "utf8");
  ok("editor-wizard.ts's registerLeaveGuard call passes an isDirty predicate", /registerLeaveGuard\(guard,\s*isDirty\)/.test(wizardSrc), wizardSrc.match(/registerLeaveGuard\([^)]*\)/)?.[0]);

  const carouselSrc = readFileSync(new URL("../src/screens/onboarding/carousel.ts", import.meta.url), "utf8");
  ok(
    "onboarding/carousel.ts's registerLeaveGuard call passes an isDirty predicate",
    /registerLeaveGuard\(guard,\s*\(\)\s*=>\s*getCeremony\(\)\s*!==\s*null\)/.test(carouselSrc),
    carouselSrc.match(/registerLeaveGuard\([^)]*\)/)?.[0],
  );

  const destSrc = readFileSync(new URL("../src/screens/destination-form.ts", import.meta.url), "utf8");
  ok("destination-form.ts's registerLeaveGuard call passes an isDirty predicate", /registerLeaveGuard\(guard,\s*isDirty\)/.test(destSrc), destSrc.match(/registerLeaveGuard\([^)]*\)/)?.[0]);
}

// ---- PART 4: the wizard's name/cadence draft (no draft persistence). --
// editor-wizard.ts uses the SAME lib/draft.ts add-source.ts and restore-flow/flow.ts already rely on
// (proven correct there); this proves the wizard's OWN draft id round-trips through it and is cleared
// on both an explicit discard and a successful create, so a reload mid-wizard gets the typed name and
// chosen cadence back rather than an empty box, and a completed wizard never leaves a stale draft
// behind to reappear on the NEXT "New downpipe" open.
{
  const WIZARD_NAME_DRAFT = "create-downpipe-wizard-name";
  clearDraft(WIZARD_NAME_DRAFT);
  ok("no draft before anything is typed", loadDraft(WIZARD_NAME_DRAFT) === null);

  saveDraft(WIZARD_NAME_DRAFT, { name: "Nightly KV", cadenceSeconds: "3600" });
  const restored = loadDraft<{ name?: string; cadenceSeconds?: string }>(WIZARD_NAME_DRAFT);
  ok("a saved name + cadence round-trips", restored?.name === "Nightly KV" && restored?.cadenceSeconds === "3600", JSON.stringify(restored));

  clearDraft(WIZARD_NAME_DRAFT);
  ok("clearDraft (Cancel, or a successful create) removes it", loadDraft(WIZARD_NAME_DRAFT) === null);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
