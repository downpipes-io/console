// The heavier onboarding step renderers: the in-console key install (the primary no-CLI
// affordance), the deeply-collapsed wrangler fallback, the bounded engine-readiness poll, and
// the team / role-grant step. These are the section render flows the card deck (./carousel.ts)
// mounts; they were moved here verbatim from the onboarding coordinator for size. They import
// only the shared leaf (./shared.ts) and never a sibling deck module, so no cycle forms.
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, StatusReport } from "../../api.ts";
import { codeBlock, keyField } from "../../components/code-block.ts";
import { stepUpAwareText } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { type StatusTone, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import type { CeremonyResult } from "../../keygen.ts";
import { isNavigationCancelled, recordOnboardingStep } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isStepUpRequired } from "../../lib/errors.ts";
import { ICON_REFRESH } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { clearSensitiveState, getEngine } from "../../lib/store.ts";
import { collapsedSection } from "../common.ts";
import { attachTokenHelp } from "../sources.ts";

// The readiness poll re-checks the engine status on this interval while waiting for the keys.
const POLL_INTERVAL_MS = 3000;
// finishSetup races acknowledgeSetup against this cap so the wizard never hangs if the
// acknowledge call is slow; the Overview self-heal covers the case where it timed out.
const ACKNOWLEDGE_TIMEOUT_MS = 3000;

// ============================================================================
// Step 4: Configure the engine (instruct out of band, then verify by polling)
// ============================================================================

// renderInstallKeys is the PRIMARY no-CLI install affordance: a scoped-token input (the SAME
// "Edit Cloudflare Workers" token the source-attach flow collects, with the same help modal) and an
// Install button that POSTs the in-memory ceremony material to POST /admin/keys/install. The token
// and the private values are sent ONCE over the authenticated same-origin channel and never
// persisted client-side. On success the engine has written its own secrets; the caller's status
// poll confirms them, and onInstalled() drops the in-memory key material (the keys are now on the
// engine and the files are saved offline). Returns the element + an onInstalled hook the poll calls.
export function renderInstallKeys(engine: EngineClient, result: CeremonyResult): { el: HTMLElement; onInstalled: () => void } {
  const wrap = h("div", { class: "ob-install" });
  wrap.appendChild(h("h3", { class: "page-header__title", style: "font-size:var(--text-md)" }, "Install your keys to the engine"));
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Paste a one-shot Cloudflare token; the engine uses it to write its own secrets (the signer private, the break-glass public",
      result.operational ? ", and the operational pair" : "",
      "), then you revoke it. Nothing here is a manual command.",
    ),
  );

  // The honest note about the operational private (a decryption-capable key placed in the engine
  // under the two-recipient posture, where one has been added), stated at the moment it is about to be installed.
  if (result.operational) {
    wrap.appendChild(
      h(
        "p",
        { class: "field__hint" },
        // The mechanism named here was wrong: "re-key from the Keys screen's strict break-glass-only option"
        // sends the customer to a full key ceremony for something posture-switch.ts does with no keygen at all
        // (POST /admin/keys/break-glass-only, break-glass key untouched). It also understated the part that
        // actually matters at this moment, which is that switching later does NOT retrieve archives already
        // sealed while the operational key was present. That is the fact worth stating while the key is being
        // installed, because it is the only part of this decision that cannot be taken back.
        "The operational private can decrypt your archives and will live in your engine, that is what makes unattended restore proof possible, but it also means a compromise of your Cloudflare account could read your archives. You can remove it later from the ",
        h("button", { "data-dp": "onboarding.button.navigate-keys#2", class: "linklike", type: "button", on: { click: () => navigate("/keys") } }, "Keys screen"),
        "'s break-glass-only switch, with no re-key, but archives sealed while it was present stay readable by it.",
      ),
    );
  }

  const tokenInput = h("input", { "data-dp": "onboarding.password.token", class: "input", type: "password", autocomplete: "off", "aria-label": "One-shot Cloudflare deploy token", placeholder: "paste a deploy token (used once, never stored)" }) as HTMLInputElement;
  const installBtn = h("button", { "data-busy-label": "Installing", "data-dp": "onboarding.button.install", class: "btn btn--primary", type: "button" }, "Install keys to the engine") as HTMLButtonElement;
  const installErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const installInfo = h("p", { class: "field__hint", role: "status", "aria-live": "polite", hidden: true });

  const ctl: InstallControls = { tokenInput, installBtn, installErr, installInfo };
  const markInstalled = makeMarkInstalled(ctl);

  installBtn.addEventListener("click", () => void installKeysHandler(engine, result, ctl, markInstalled));

  wrap.appendChild(h("div", { class: "ob-install__row", style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, tokenInput, installBtn));
  // THE PASSKEY SHEET THIS BUTTON OPENS, ANNOUNCED BEFORE IT OPENS. POST /admin/keys/install is a
  // STEPUP_SUBS member and installKeys goes through gatedFetch, so on a cookie-borne session (a passkey or
  // an IdP sign-in) pressing Install runs a step-up ceremony and the browser puts up its own credential
  // sheet. Every OTHER gated write in the console announces this, enforced by scripts/stepup-announce-gate.mjs,
  // but that gate judges the copy of a CONFIRMATION, and this call site has no confirmation at all: a gated
  // write with no modal is in neither the numerator nor the denominator, so onboarding sat in the gate's
  // blind spot. A first-run customer therefore met an unannounced browser sheet at the single most
  // safety-critical moment in the wizard, under a line reading "Installing your keys to the engine".
  // The wording matches the standardised sentence used at the other 29 sites, including the dismissal
  // half, because "nothing was installed" is the fact a customer needs before they cancel a sheet they
  // were not expecting.
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is installed and you can start again from this step.",
    ),
  );
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      h("button", { "data-dp": "onboarding.button.attach-token-help", class: "linklike", type: "button", on: { click: () => attachTokenHelp(null) } }, "How do I create the token?"),
      " Use the “Edit Cloudflare Workers” template, scoped to the engine's own account. It is used once for this install, never stored.",
    ),
  );
  wrap.appendChild(installErr);
  wrap.appendChild(installInfo);

  // onInstalled lets the status poll converge the UI to the installed state even if the operator
  // arrived with the keys already present (a deploy-provisioned engine) or the install completed
  // out of band: it is idempotent (markInstalled guards) and drops the material if still held.
  return { el: wrap, onInstalled: () => markInstalled() };
}

// InstallControls is the small bundle of DOM the install flow reads and mutates, so the handler and
// the markInstalled helper can be lifted out of renderInstallKeys without a long parameter list.
interface InstallControls {
  tokenInput: HTMLInputElement;
  installBtn: HTMLButtonElement;
  installErr: HTMLElement;
  installInfo: HTMLElement;
}

// makeMarkInstalled returns the idempotent "the engine now holds the keys" finaliser: it drops the
// in-memory key material (CON-L8: the reference is dropped; the browser reclaims the bytes by garbage
// collection at an indeterminate later time, never scrubbed on demand) and converges the controls to
// the installed state. Guarded so the status poll and the install success path can both call it.
function makeMarkInstalled(ctl: InstallControls): () => void {
  let installed = false;
  return (): void => {
    if (installed) return;
    installed = true;
    clearSensitiveState();
    ctl.tokenInput.value = "";
    ctl.tokenInput.disabled = true;
    ctl.installBtn.disabled = true;
    ctl.installBtn.textContent = "Keys installed";
    ctl.installInfo.hidden = false;
    ctl.installInfo.textContent = "Keys installed. The in-memory key material has been dropped (the browser reclaims it). Revoke the token now on the Cloudflare API Tokens page.";
  };
}

// WizardFault is what a failed engine call in the wizard can honestly be said to be. Every member is a fact the
// code established, and no member asserts one it did not.
export type WizardFault = "transport-error" | "engine-not-ok" | "unauthorised" | "engine-binding-absent" | "console-origin-fault";

// engineFaultOutcome is the TOTAL, PURE classifier for ANY failed engine call in the wizard. Total is not a
// boast here, it is the property that was missing and the whole of the defect: it used to decide on "is there a
// trailing numeric status in the message", over a transport that throws MARKER strings with no number for two of
// its states. So both markers fell out of the `null` side into "the call never reached the engine", and the two
// members that carry that meaning (`transport-error`, and the poll's unreachable legs beneath it) assert, in their
// own definitions and in the support bot's rendering of them, that THE ENGINE DID NOT ANSWER. In both of those
// states the engine is up and healthy:
//
//   Cloudflare ACCESS served its login page   the operator's session lapsed. Access answers an authenticated call
//                                             with HTML, not a 401, and that is what it actually does. The console
//                                             ALREADY KNEW: failResponse shape-gates the body, recognises the
//                                             Access page and throws the dedicated marker; classifyError names the
//                                             kind `access-redirect`; and the console's own FAULT_BY_ERROR_KIND
//                                             maps that kind to the faultClass `auth`. The wizard threw the fact
//                                             away and filed it as transport, so the pack told support to "fix the
//                                             engine's reachability first" for a customer who needed to sign in.
//                                             That is verbatim the ticket the gap was raised on.
//   the console has NO ENGINE binding         the console worker's own 503. The engine never received the request
//                                             and cannot be at fault for it; the remedy is the CONSOLE's wrangler
//                                             configuration and a CONSOLE redeploy.
//
// So it classifies through classifyError, the console's own closed error taxonomy, and the switch is EXHAUSTIVE by
// type: a new ErrorKind fails to compile until it is placed here, which is the only way a total function stays
// total. Nothing but the `.kind` discriminant is read: not the message, not the stack, not the engine's refusal
// prose, which stays on the screen where the operator needs it and where no pack can see it.
//
// null means DO NOT RECORD, and it is not a fourth fault: a route change or an unmount aborts every fetch in
// flight, which is the console working as designed. It used to come out of here as `engine-not-ok` (an AbortError
// carries no status, and the old branch treated "not network and not timeout" as "the engine answered and
// refused"), so navigating away from the wizard fabricated a refusal by an engine that had never been asked. The
// ring makes the same exclusion at every other emit.
//
// It is exported because the wizard's OTHER swallowed reads (the resumed-configure key pre-check, the completion
// readiness read) must classify by the same rule; a per-site guess is how the first false rows got written.
export function engineFaultOutcome(err: unknown): WizardFault | null {
  if (isNavigationCancelled(err)) return null;
  const kind = classifyError(err).kind;
  switch (kind) {
    // The lapsed session, in the two shapes it arrives in. One state, one remedy, one row (vocab.ts states the
    // collapse): a clean 401, and the Access login page that IS the 401 for a fenced engine.
    case "unauthorised":
    case "access-redirect":
      return "unauthorised";
    // The console's own worker, answering for an engine it has no binding to. Not the engine's fault, and not a
    // reachability question about the engine at all.
    case "engine-binding-absent":
      return "engine-binding-absent";
    // G250: THE CONSOLE'S OWN WORKER MANUFACTURED THE 500, so no request reached the engine. This is a SIBLING
    // PRODUCER of the same fabricated engine fault the feature probe wrote: the wizard classifies by kind, the
    // kind used to be `server` (the bare 500), and `engine-not-ok` says in as many words that the engine answered
    // and refused, so the pack sent support to the engine's logs and the poll's own narration told the operator
    // the engine had errored. It is not `engine-binding-absent` either: the binding is there, and the remedy is
    // the engine's deployment (deleted, throwing on boot, over its limits) or the console's dispatch.
    case "console-origin-fault":
      return "console-origin-fault";
    // THE ENGINE ANSWERED AND REFUSED. It is reachable, it saw the call, and it recorded the refusal on its own
    // side, so the two halves can be joined and the remedy is its logs. A role denial, a rate limit and a 5xx all
    // agree on the fact that decides the remedy, which is that the engine is up.
    // B29: a step-up identity-verification gap. It is NOT defensive, and the comment here said it was:
    // onboarding performs two step-up-gated WRITES, installKeys (POST /admin/keys/install, gatedFetch, and
    // /keys/install is a STEPUP_SUBS member) forty lines below this, and the team step's role grant
    // (team.ts, POST /admin/roles). On a cookie-borne session either can reach this classifier. The engine
    // answered and the call needs a fresh identity check (a re-verify), an engine-answered state, NEVER a
    // lapsed session (so never "unauthorised").
    case "stepup-required":
    case "forbidden":
    case "restore-unapproved":
    case "rate-limited":
    case "server":
      return "engine-not-ok";
    // A 2xx whose body could not be read: the engine answered and the
    // request completed, so this joins the row above rather than the "nothing arrived" row below. It is not a
    // refusal, but the same fact decides the remedy -- the engine is up and reachable, and its own state or
    // logs are what can explain a malformed or unexpected body, not a reachability check.
    case "answer-unreadable":
      return "engine-not-ok";
    // NOTHING FROM THE ENGINE ARRIVED, and the console did not establish why. The fetch threw or timed out
    // (`network`), or some other server answered with a web page (`html-body`: a wrong engine URL, an undeployed
    // engine, a proxy). `console-origin` cannot be produced by classifyError at all (it is an explicit decision a
    // screen makes after probing health, never an inference), but it is a member of the taxonomy and the switch is
    // exhaustive: the engine's answer was made and then discarded by the browser, so the console received nothing.
    case "network":
    case "html-body":
    case "console-origin":
      return "transport-error";
    // `console-fault` (lib/errors.ts): a throw with no engine status that does not read as a fetch failure
    // either, which is usually the console's own code throwing on an answer it already had.
    //
    // IT SITS HERE UNDER PROTEST AND THE PROTEST IS THE POINT, because `transport-error` asserts that nothing
    // from the engine arrived and this kind does not establish that. It is not moved, and no member is
    // invented for it, for a reason outside this file: the wizard's outcomes are mirrored in a CLOSED
    // vocabulary that the engine carries its own copy of (lib/client-diag/vocab.ts
    // CLIENT_DIAG_ONBOARDING_OUTCOMES and engine/src/admin/client-diag-vocab.ts), so a new member is a
    // cross-repo mirrored change in a repo this pass does not hold. Until then this kind lands exactly where
    // it landed before it had a name, so the wizard's rows are unchanged by this repair rather than quietly
    // reclassified, and the gap is written down where the next reader of this switch will find it.
    case "console-fault":
      return "transport-error";
  }
}

// installKeysHandler POSTs the in-memory ceremony material to POST /admin/keys/install with the
// one-shot token, then on success drops the material immediately (markInstalled; the status poll
// confirms the secrets read present and enables Continue). On failure it surfaces the engine's
// coarse, value-free reason at the field. A secret set this way is available without a redeploy, so
// the poll typically flips within a few seconds.
async function installKeysHandler(
  engine: EngineClient,
  result: CeremonyResult,
  ctl: InstallControls,
  markInstalled: () => void,
): Promise<void> {
  const token = ctl.tokenInput.value.trim();
  if (token === "") { ctl.installErr.textContent = "Paste the deploy token first."; ctl.installErr.hidden = false; return; }
  ctl.installErr.hidden = true;
  ctl.installBtn.disabled = true;
  ctl.installBtn.textContent = "Installing";
  ctl.installInfo.hidden = false;
  ctl.installInfo.textContent = "Installing your keys to the engine. Nothing is stored except the engine's own secrets.";
  try {
    await engine.installKeys({
      token,
      signerPrivate: result.signer.privateB64,
      breakGlassPublic: result.breakGlass.recipientPublicB64,
      ...(result.operational ? { operationalPublic: result.operational.recipientPublicB64, operationalPrivate: result.operational.identityB64 } : {}),
    });
    markInstalled();
    toast({ message: "Keys installed to the engine, verified. Revoke the token now." });
  } catch (e) {
    const fault = engineFaultOutcome(e);
    if (fault === "unauthorised") {
      // G125: the operator's session lapsing mid-ceremony, which is a different fault from an install the engine
      // never received, and it is recorded before the redirect takes the tab away. It arrives as a clean 401 or as
      // the Cloudflare Access login page, and the classifier now names both: the login-page shape used to be filed
      // as a transport fault, so the same lapsed session sent the operator to the sign-in screen from one branch
      // and told support the engine was down from the other.
      recordOnboardingStep("install", "unauthorised");
      // PAINT FIRST, THEN LEAVE: the install did not happen, so the ceremony step must not be left
      // reading "Installing" over a reassurance line about keys that were never sent.
      ctl.installBtn.disabled = false;
      ctl.installBtn.textContent = "Install keys to the engine";
      ctl.installInfo.textContent = "Your session ended before the install finished. Nothing was installed; sign in again and retry.";
      return goSignedOut();
    }
    // G125: THE INSTALL ACTION'S OWN FAILURE, WHICH WAS RECORDED ON NEITHER SIDE. This catch used to write
    // errMsgConfigure(e) to the DOM and nothing else. An install POST that never REACHED the engine (transport,
    // DNS, a CORS block, an engine that is down) is invisible to the engine by construction -- its own
    // recordKeyCeremonyFailure fires only for requests it actually received -- so the console was the only witness
    // and it kept the fact in a field hint. This is precisely the console-only fault class the gap exists to
    // capture, and the `install` obStep had NO caller on the real install path at all.
    //
    // The CLASS is recorded, never the message: engineFaultOutcome reads the closed error taxonomy's discriminant,
    // and errMsgConfigure's prose (which can carry the engine's own text) stays on the screen where the operator
    // needs it and where no pack can see it. A null class is a navigation or an unmount cancelling the POST, which
    // is not a fault and is not recorded.
    if (fault !== null) recordOnboardingStep("install", fault);
    // Restore the button state FIRST so the operator can retry even if message formatting throws
    // (a pathological err value, or a detached node), then surface the reason.
    ctl.installInfo.hidden = true;
    ctl.installBtn.disabled = false;
    ctl.installBtn.textContent = "Install keys to the engine";
    try {
      ctl.installErr.textContent = errMsgConfigure(e);
      ctl.installErr.hidden = false;
    } catch {
      ctl.installErr.textContent = "Could not install the keys. Check the deploy token and try again.";
      ctl.installErr.hidden = false;
    }
  }
}

// renderManualFallback is the DEEPLY-COLLAPSED out-of-band path: replace the engine's key secrets
// yourself with wrangler (your own Cloudflare login, no token). It is never the primary path, the
// in-console install above is, and exists only for an operator who prefers IaC. When the in-memory
// ceremony result is present the exact values are bound so a copy-paste is correct; otherwise only
// the commands show (the ceremony populates the values).
export function renderManualFallback(result: CeremonyResult | null): HTMLElement {
  const inner = h("div", { class: "stack-sm" });
  inner.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin:0" },
      "wrangler uses your own Cloudflare login, so this needs no token. Run from the engine directory. The engine reads a Secrets Store binding the same way, if you prefer that.",
    ),
  );
  inner.appendChild(codeBlock("npx wrangler secret put SIGNER_PRIVATE", { label: "1. The signer private (the one private value the engine holds)" }));
  if (result) inner.appendChild(keyField({ label: "SIGNER_PRIVATE value", value: result.signer.privateB64 }));
  inner.appendChild(codeBlock("npx wrangler secret put BREAK_GLASS_PUBLIC", { label: "2. The break-glass public (safe to show)" }));
  if (result) inner.appendChild(keyField({ label: "BREAK_GLASS_PUBLIC value", value: result.breakGlass.recipientPublicB64 }));
  if (result?.operational) {
    inner.appendChild(codeBlock("npx wrangler secret put OPERATIONAL_PUBLIC", { label: "3. The operational public" }));
    inner.appendChild(keyField({ label: "OPERATIONAL_PUBLIC value", value: result.operational.recipientPublicB64 }));
    inner.appendChild(codeBlock("npx wrangler secret put OPERATIONAL_PRIVATE", { label: "4. The operational private (can decrypt archives; in your engine by default)" }));
    inner.appendChild(keyField({ label: "OPERATIONAL_PRIVATE value", value: result.operational.identityB64 }));
  }
  return collapsedSection("Advanced: replace keys manually, out of band (wrangler)", inner);
}

// errMsgConfigure surfaces an engine client error's message coarsely. The engine's reasons are
// value-free (no token, no key), so showing the message verbatim is safe; it never contains a secret.
function errMsgConfigure(err: unknown): string {
  // A cancelled step-up ceremony throws the internal marker ("<verb>: stepup-required: 401"), which is not
  // an engine reason at all: the engine never judged this request and nothing was written. Give that one
  // state the reviewed advice and leave every other message exactly as it was.
  if (isStepUpRequired(err)) return stepUpAwareText(err);
  return err instanceof Error ? err.message : "The install did not complete; try again.";
}

// renderReadinessPoll builds the readiness checklist card and starts the bounded poll. It
// returns the card and an onReady registrar (so the advance row can enable Continue when
// the engine first reports ready). Poll mechanics preserve the existing discipline: a 3s
// loop capped at ~40 attempts (~2 min), stopped on ready / leaving the view (the node is
// removed) / the cap; a manual Check resets the budget. A polite live region narrates.
//
// Re-entrancy guard (CON-L6): the manual Check restarts the loop, but a prior scheduled
// tick chain may still be in flight (it is only torn down on ready/cap/disconnect). Each
// run of the loop carries an `epoch`; a fresh start (Check) bumps the epoch, and any tick
// from an earlier epoch bails the moment it observes it is stale -- both before doing work
// and again after its awaited status() resolves. That makes exactly one tick loop live at
// a time, so clicking Check mid-poll cannot fan out into concurrent GET /admin/status
// loops sharing the same attempt budget.
export function renderReadinessPoll(engine: EngineClient): { card: HTMLElement; onReady: (cb: () => void) => void } {
  const parts = buildReadinessCard();
  const onReady = startPollLoop(engine, parts);
  return { card: parts.card, onReady };
}

// ReadinessCardParts is the card DOM plus the handful of elements the poll loop reads and mutates
// (the live narration line, the checklist host, the manual Check button). buildReadinessCard owns the
// composition; startPollLoop owns the epoch/attempt machinery, so neither exceeds the size budget.
interface ReadinessCardParts {
  card: HTMLElement;
  liveLine: HTMLElement;
  lineText: HTMLElement;
  checklist: HTMLElement;
  recheck: HTMLButtonElement;
}

// buildReadinessCard creates the readiness card: the header with the polite live-region narration
// line, the checklist host (seeded with a skeleton), and the manual Check button. It builds DOM only;
// it starts no poll.
function buildReadinessCard(): ReadinessCardParts {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  const liveLine = h(
    "span",
    { class: "status", style: "display:inline-flex;align-items:center;gap:var(--space-2)", role: "status", "aria-live": "polite" },
    h("span", { class: "dot dot--info", "aria-hidden": "true" }),
    h("span", { class: "ob-poll__line" }, "Waiting for the engine"),
  );
  const lineText = liveLine.querySelector(".ob-poll__line") as HTMLElement;
  card.appendChild(h("div", { class: "card__header" }, h("h2", { class: "card__title" }, "Engine readiness"), liveLine));

  const checklist = h("div", { class: "readiness-list" });
  card.appendChild(checklist);
  checklist.appendChild(skeletonRows(4));

  const recheck = h("button", { "data-dp": "onboarding.button.recheck", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Check engine") as HTMLButtonElement;
  card.appendChild(
    h(
      "div",
      { style: "display:flex;align-items:center;gap:var(--space-3);margin-top:var(--space-4);flex-wrap:wrap" },
      recheck,
      h("span", { class: "field__hint" }, "Auto-checking every few seconds. Presence means the value is set; the Licence and Updates screens report whether it works."),
    ),
  );
  return { card, liveLine, lineText, checklist, recheck };
}

// startPollLoop owns the bounded readiness poll: a 3s loop capped at ~40 attempts (~2 min), stopped
// on ready / leaving the view (the node is removed) / the cap; a manual Check resets the budget.
//
// Re-entrancy guard (CON-L6): the manual Check restarts the loop, but a prior scheduled tick chain
// may still be in flight (it is only torn down on ready/cap/disconnect). Each run of the loop carries
// an `epoch`; a fresh start (Check) bumps the epoch, and any tick from an earlier epoch bails the
// moment it observes it is stale, both before doing work and again after its awaited status()
// resolves. That makes exactly one tick loop live at a time, so clicking Check mid-poll cannot fan
// out into concurrent GET /admin/status loops sharing the same attempt budget. It returns the onReady
// registrar so the advance row can enable Continue when the engine first reports ready.
function startPollLoop(engine: EngineClient, parts: ReadinessCardParts): (cb: () => void) => void {
  const { card, liveLine, lineText, checklist, recheck } = parts;
  const MAX = 40;
  let attempts = 0;
  let stopped = false;
  let firedReady = false;
  let readyCb: (() => void) | null = null;
  // The active poll generation. Each (re)start increments it; a tick whose captured epoch
  // no longer matches is a superseded loop and returns without rendering or rescheduling.
  let epoch = 0;
  // Whether the card has EVER been in the DOM. start() runs synchronously (below) before
  // renderConfigure appends the card and the router mounts the screen, so on the very first
  // tick card.isConnected is false. We must NOT treat that pre-mount state as a stop (the
  // old code did, which killed the auto-poll until the operator clicked "Check engine").
  // Only a detachment AFTER first mount (navigate-away) stops the loop.
  let everConnected = false;
  // G125: THE FACTS THE EXHAUSTION BRANCH USED TO THROW AWAY. The catch leg below swallows a thrown tick and
  // FALLS THROUGH to the same exhaustion branch as a tick that succeeded and reported the keys absent, so FOUR
  // different states produced the byte-identical, coalescing row {onboarding-step, boot, readiness-poll,
  // poll-exhausted}: (1) the engine answered forty times with the signer present and break-glass ABSENT (the
  // half-keyed engine, which router-keys.ts documents as a real reachable state); (2) it answered forty times with
  // BOTH absent (the install never took); (3) it was NEVER ONCE READ (every tick threw; the engine was already
  // gone when the card mounted); (4) it ANSWERED, AND THEN WENT QUIET (the ordinary shape of an engine that
  // disappears mid-wizard: installing the key secrets is itself a redeploy). Each has a different remedy.
  //
  // THESE ARE PER-RUN, AND THE RUN IS WHAT start() RESETS. They were declared here and never cleared, which made
  // them STICKY ACROSS RUNS -- and the exhaustion message tells the operator, in as many words, to press the very
  // button that re-enters this closure ("Install your keys above, then Check engine to resume"). So run 1 would
  // exhaust with the keys absent, the operator would install and the engine would go away (a secret set is a
  // redeploy), and run 2 -- every tick of which threw -- would see everRead still TRUE from run 1, skip the
  // unread leg, and re-emit run 1's poll-exhausted rows off run 1's STALE lastRead. Those rows coalesce by tuple
  // key into the originals, so the pack claimed the engine had answered eighty times and kept reporting both keys
  // absent. It had answered forty times and then died, and support was sent to re-run the key ceremony when the
  // remedy was an unreachable engine. Resetting them in start() is the fix; they are reset there, not here.
  let everRead = false;
  let lastRead: StatusReport | null = null;
  // HOW THE MOST RECENT TICK ENDED, CLASSIFIED, and null when it read the engine cleanly. This used to be a bare
  // `lastTickThrew` boolean, and that boolean is the whole of what this gap was refuted for on its fourth review.
  //
  // everRead alone cannot separate "the engine answered and then went away" from "it kept saying the keys are
  // absent": it is a whole-loop flag, so ONE successful early tick pins the loop into the poll-exhausted leg with
  // a lastRead that is minutes stale. That was the third defect and the boolean fixed it. But the boolean records
  // only THAT the tick failed, and this is the ONE swallowed engine read in the wizard that then classified
  // nothing: an engine ANSWERING 500 ON EVERY TICK and an engine that was never reachable at all both set it, so
  // both wrote `readiness-unread` -- a member whose own definition, and the bot's rendering of it ("fix the
  // engine's reachability first"), assert a reachability the console had never tested. The engine was answering,
  // its logs held forty refusals, and the pack sent support away from them.
  //
  // So the class is kept, not the boolean, and engineFaultOutcome is the classifier: the SAME total, pure mapper
  // every other failed engine call in the wizard goes through, reading a numeric status or a frozen error name
  // and never a message. `engine-not-ok` means the engine ANSWERED AND REFUSED (it is reachable, and it recorded
  // the refusal itself); `transport-error` means the call never reached it (no engine-side record of it can
  // exist). That is the axis the four exhaustion endings split on.
  //
  // It carries the console's OWN configuration fault too (`engine-binding-absent`), and it must: without it, a
  // console deployed with no ENGINE service binding polls forty times, gets its own worker's 503 forty times, and
  // files the wait under a member that says the ENGINE could not be reached. The engine is untouched and healthy,
  // and the console is the thing to redeploy.
  let lastTickFault: Exclude<WizardFault, "unauthorised"> | null = null;

  const renderStatus = (s: StatusReport) => {
    const items: HTMLElement[] = [];
    items.push(presenceItem("Signer private present", s.signerConfigured, "signerConfigured"));
    items.push(presenceItem("Break-glass public present", s.breakGlassConfigured, "breakGlassConfigured"));
    // The destination is NOT part of this step (owner: it belongs on the Destinations screen);
    // onboarding completes on the keys alone, so it is no longer listed or polled here.
    checklist.replaceChildren(...items);
    // KEYS are this step's job; the destination has its own later step (the
    // Destinations screen), so Continue must never hostage on it, that was a
    // deadlock when the guided setup locked /destinations until after keys.
    const keysDone = s.signerConfigured && s.breakGlassConfigured;
    if (keysDone) {
      lineText.textContent = "Keys installed. Your engine is configured.";
      (liveLine.querySelector(".dot") as HTMLElement).className = "dot dot--ok";
      if (!firedReady) {
        firedReady = true;
        readyCb?.();
      }
    } else {
      lineText.textContent = "Waiting for the engine";
    }
  };

  const tick = async (myEpoch: number) => {
    // A superseded loop (a newer Check has started) bails silently; so does a stopped or
    // DETACHED-after-mount poll. The pre-mount first tick (card not yet connected) proceeds.
    if (card.isConnected) everConnected = true;
    if (myEpoch !== epoch || stopped || (everConnected && !card.isConnected)) {
      if (myEpoch === epoch) stopped = true;
      return;
    }
    attempts++;
    try {
      const s = await engine.status();
      everRead = true;
      lastRead = s;
      lastTickFault = null;
      // The await yielded; while suspended a newer Check may have superseded this loop, or
      // the view may have gone. Re-check before touching the DOM or the shared budget so a
      // stale loop never renders or reschedules on top of the live one.
      if (card.isConnected) everConnected = true;
      if (myEpoch !== epoch || stopped || (everConnected && !card.isConnected)) return;
      renderStatus(s);
      if (s.signerConfigured && s.breakGlassConfigured) {
        stopped = true;
        // G125: the poll SUCCEEDED. Recorded once (the loop stops here), so a pack whose readiness poll has no
        // `ok` and no `poll-exhausted` says the operator walked away mid-wait, which is its own answer.
        recordOnboardingStep("readiness-poll", "ok");
        return;
      }
    } catch (err) {
      if (myEpoch !== epoch) return;
      // G125: THE POLL'S 401 RECORDED NOTHING. A session that lapses during the two-minute wait tears the wizard
      // down to the sign-in screen with the keys possibly already installed, and the ring was left empty, so the
      // pack of an operator who was thrown out mid-setup was byte-identical to the pack of one who wandered off.
      // The row is written BEFORE the redirect takes the tab away, and it is the same `unauthorised` member the
      // connect and install steps already record: the obStep is what tells the three apart. It covers the Access
      // login page as well as the clean 401, which is the shape a fenced engine's lapsed session ACTUALLY takes,
      // and which used to be recorded as an unreachable engine while that engine sat there answering health.
      const fault = engineFaultOutcome(err);
      if (fault === "unauthorised") {
        stopped = true;
        recordOnboardingStep("readiness-poll", "unauthorised");
        goSignedOut();
        return;
      }
      // A navigation or an unmount cancelled the tick. That is the console working as designed, so it is not a
      // fault, it is not recorded, and it must not overwrite the class of the last tick that genuinely failed.
      if (fault === null) return;
      // A single failed tick is NOT recorded. The poll is a retry loop by design, it says so on screen, and a
      // row per tick would put up to forty rows of noise in the ring for a wait that then succeeded. What is
      // recorded is the ENDING, below: a poll that ran out of attempts. What the tick DOES leave behind is the
      // one fact the ending cannot reconstruct, and it is a CLASS and not a boolean: HOW the most recent read
      // failed. An engine that answered and refused is reachable, one whose answer never arrived may not be, and
      // a console with no ENGINE binding never asked it anything; the exhaustion rows below assert exactly one of
      // those, and each of them is a different remedy.
      lastTickFault = fault;
      // The narration says which, too. "Could not reach the engine" in front of an engine that is answering 500s
      // is the same false claim on screen that the pack used to carry, and it is the sentence the operator quotes
      // to support. It is also the sentence that sends a customer to go and look at an engine that is fine when
      // the thing with no binding is the console they are reading it on.
      if (fault === "engine-binding-absent") lineText.textContent = "This console has no engine binding, so nothing reached the engine. Restore the ENGINE binding in the console's configuration and redeploy the console.";
      else if (fault === "console-origin-fault") lineText.textContent = "The proxied call failed inside this console, so nothing reached the engine. Check that the engine Worker is deployed and healthy; retrying...";
      else if (fault === "engine-not-ok") lineText.textContent = "The engine answered with an error; retrying...";
      else lineText.textContent = "Could not reach the engine; retrying...";
    }
    if (attempts < MAX && !stopped && myEpoch === epoch) window.setTimeout(() => void tick(myEpoch), POLL_INTERVAL_MS);
    else if (!stopped && myEpoch === epoch) {
      // G125: THE POLL RAN OUT. Forty attempts over about two minutes and the wizard sat on "Waiting". This is a
      // pure client-side timer: the engine has no idea anyone waited, so there is no engine-side record of it and
      // never could be. The exhaustion is recorded; the individual ticks are not (forty rows for one wait is noise).
      //
      // WHICH exhaustion is the whole point, and there are FIVE endings, not three. They are the product of TWO
      // questions, and the second one is the one the poll never used to ask:
      //
      //   did the poll EVER read the engine?          everRead
      //   how did its FINAL tick end?                 lastTickFault: refused / unreachable / it read cleanly
      //
      //   readiness-unread   never read, final tick UNREACHABLE. The engine was already gone when the card
      //                      mounted. The keys may well be installed and nobody could see it. Fix reachability.
      //   readiness-refused  never read, final tick REFUSED. THE ENGINE IS UP AND TURNING THE READ AWAY, forty
      //                      times, and every one of those refusals is in its own logs. This state used to be
      //                      recorded as readiness-unread -- whose meaning, and whose rendering in the support
      //                      bot, is "the engine was unreachable, fix that first" -- so the pack told support to
      //                      go and chase a network fault that did not exist while the 500s sat in the customer's
      //                      logs. A row must not assert something the code never tested.
      //   poll-went-quiet    read at least once, final tick UNREACHABLE. The engine went away DURING the wait,
      //                      which is the ordinary shape of the fault (installing the key secrets sets Worker
      //                      secrets, and that is a redeploy).
      //   poll-refused       read at least once, final tick REFUSED. The engine answered, then started refusing:
      //                      it is up, and this is its own logs' problem, not a reachability one. It used to
      //                      write poll-went-quiet, which says in as many words that the engine "is not reachable
      //                      now". Same false claim, same wrong remedy.
      //   poll-exhausted     the engine ANSWERED, INCLUDING ON THE LAST TICK, and kept saying a key was not
      //                      there. One row per STILL-ABSENT key says WHICH: a lone break-glass row is a
      //                      half-keyed engine (the ceremony wrote the signer and then failed), a signer row AND
      //                      a break-glass row is an install that never took at all.
      //   engine-binding-absent  the poll never asked the engine ANYTHING. This console's deploy has no ENGINE
      //                      service binding, so its own worker answered the status read with a 503 and the engine
      //                      is untouched and healthy. It answers to neither of the two questions above, which is
      //                      why it is tested before them: it is a fault in the console, and the console is what
      //                      gets redeployed.
      //
      // The ORDER of the tests is load-bearing. The failed-final-tick legs must be tried BEFORE the absent-key
      // legs, because a stale lastRead is still sitting there from before the engine died or started refusing,
      // and the absent-key legs would happily read it and assert, on no evidence, that the engine was still
      // saying the keys were absent when it had in fact stopped saying anything of the kind. Neither of the
      // failed-final-tick legs therefore carries an obSecret: the console does not know what the engine held at
      // the end, and a guess dressed as a discriminator is worse than the silence it replaces.
      if (lastTickFault === "engine-binding-absent") {
        // THE CONSOLE, NOT THE ENGINE. This leg is tested FIRST and it does not consult everRead, because everRead
        // is a question about the engine and this fault is not about the engine at all: the console's own worker
        // answered every one of those ticks and the engine received none of them. Whether an earlier tick got
        // through (the binding was there and a console redeploy dropped it) or none ever did changes nothing a
        // support engineer would do differently, and it is the SAME row deliberately: restore the ENGINE binding in
        // the console's configuration and redeploy the console. Neither of the two legs below may be allowed to
        // claim this, because both of them assert something about an engine that is up and healthy and has heard
        // nothing from this console since the binding went.
        recordOnboardingStep("readiness-poll", "engine-binding-absent");
      } else if (lastTickFault === "console-origin-fault") {
        // G250: THE CONSOLE ANSWERED FOR THE ENGINE, and the engine never saw a single tick. Tested here, beside
        // the bindingless leg and for the same reason: everRead is a question about the engine, and this fault is
        // not about the engine's answer at all. It must not fall through to the two legs below, because both of
        // them assert a fact about a request that reached an engine: `readiness-refused`/`poll-refused` claim the
        // engine was up and turning the read away (its logs hold the refusals; they hold nothing), and
        // `readiness-unread`/`poll-went-quiet` claim the engine was unreachable, which sends support to chase a
        // network fault when the console's own worker faulted on the proxied call.
        recordOnboardingStep("readiness-poll", "console-origin-fault");
      } else if (lastTickFault !== null) {
        const refused = lastTickFault === "engine-not-ok";
        if (!everRead) recordOnboardingStep("readiness-poll", refused ? "readiness-refused" : "readiness-unread");
        else recordOnboardingStep("readiness-poll", refused ? "poll-refused" : "poll-went-quiet");
      } else if (lastRead !== null) {
        if (!lastRead.signerConfigured) recordOnboardingStep("readiness-poll", "poll-exhausted", "signer");
        if (!lastRead.breakGlassConfigured) recordOnboardingStep("readiness-poll", "poll-exhausted", "break-glass");
        // The operational key is OPTIONAL (the ceremony may not have produced one), so it is recorded only when the
        // engine holds a PARTIAL pair: a public with no private, or a private with no public, is a half-written
        // operational slot and a real fault. A cleanly absent pair is a legitimate configuration and records nothing.
        const op = lastRead.operationalConfigured;
        if (op.public !== op.private) recordOnboardingStep("readiness-poll", "poll-exhausted", "operational");
      }
      lineText.textContent = "Still not detected. Install your keys above (paste the token, Install), then Check engine to resume.";
    }
  };

  const start = () => {
    // Bump the generation so any in-flight tick chain from a prior start is abandoned, then
    // begin a single fresh loop with a clean attempt budget.
    attempts = 0;
    stopped = false;
    // G125: A RUN'S EVIDENCE IS THE RUN'S. These three were reset by nothing, and "Check engine" re-enters this
    // same closure, so run 2 inherited run 1's answers. The exhaustion branch would then read a lastRead taken
    // minutes ago from an engine that has since gone, skip the leg that says "we never got an answer", and re-emit
    // run 1's rows -- which coalesce into run 1's rows by tuple key and merely bump a count, so the pack asserts
    // the engine answered twice as many times as it ever did. The observation window is one run of the poll; these
    // are the observations, and they are cleared with the budget.
    everRead = false;
    lastRead = null;
    lastTickFault = null;
    epoch++;
    void tick(epoch);
  };

  recheck.addEventListener("click", start);
  start();

  return (cb) => (readyCb = cb);
}

function presenceItem(label: string, present: boolean, fieldName: string): HTMLElement {
  // Presence is not validity (status.ts): this reports the env var is
  // SET / the binding is bound, never that the value parses or verifies. The hint carries
  // .readiness-item__hint (tokens.css): a flexible column in the row's baseline flex, so a
  // wrapped hint stays in the text column instead of returning under the status dot.
  return h(
    "div",
    { class: "readiness-item" },
    statusWithLabel(present ? "ok" : "neutral", `${label}: ${present ? "present" : "not yet"}`),
    h("span", { class: "field__hint readiness-item__hint" }, fieldName),
  );
}

// ============================================================================
// Step 6: Readiness / first-run hardening checklist
// ============================================================================

export async function finishSetup(): Promise<void> {
  // Finishing lands the operator on Overview (the wizard-to-shell transition, panel 10).
  // The shell chrome returns automatically (app.ts afterEach: "/" is not full-bleed).
  // Acknowledge setup so the guided checklist reflects the installed keys (clears the demo
  // first-run marker). The engine server-enforces this (it only clears when it observes the
  // keys present). CRITICAL: AWAIT it before navigating, a fire-and-forget call raced the
  // Overview setup-state read, so Overview saw keysReady still false and showed the old
  // "not set up" framing. Bounded by a timeout so a slow request never traps the operator;
  // acknowledgeSetup never throws (resolves {ok:false} on failure) and the Overview self-heal
  // (fetchSetupHealed) covers the timeout case.
  const engine = getEngine();
  if (engine) {
    // G125: WAS THE COMPLETION EVER ACKNOWLEDGED? The wizard finishes and navigates either way, which is the
    // right call (an operator must never be trapped on the last card by a slow request), and it means the two
    // endings look identical to the operator and identical in the engine's own state. An ack that did not land
    // leaves the engine still believing setup is incomplete, so Overview greets a fully configured customer
    // with the "nothing is configured" framing, and the customer's report is exactly that. The ack timing out
    // and the ack being refused are the same non-event on the engine, and neither is recorded anywhere today.
    //
    // The race is resolved to a discriminated value rather than discarded: the timeout leg answers null, so a
    // slow ack is told apart from an ack that answered ok:false. Both are ack-failed for the operator, and both
    // now leave a row.
    const acked = await Promise.race([
      engine.acknowledgeSetup(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ACKNOWLEDGE_TIMEOUT_MS)),
    ]);
    // acked is the engine's { ok } on the ack leg, and null on the timeout leg. Both non-ok endings collapse to
    // ack-failed: the operator's outcome is the same (they finished and the engine did not record it).
    recordOnboardingStep("finish", acked?.ok ? "ok" : "ack-failed");
  }
  toast({ message: "Setup complete. Welcome to your console." });
  navigate("/");
}

export function checkItem(tone: StatusTone, label: string, note: string): HTMLElement {
  // The note carries .readiness-item__hint (tokens.css): a flexible column in the row's
  // baseline flex, so a wrapped note stays in the text column instead of returning to the
  // container's left edge under the status dot.
  return h(
    "div",
    { class: "readiness-item" },
    statusWithLabel(tone, label),
    h("span", { class: "field__hint readiness-item__hint" }, note),
  );
}
