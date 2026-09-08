// A failed SECTION read must leave a way back.
//
//   node test/validate-error-recovery.ts
//
// The vocabulary this file enforces is HANDLED versus UNHELPFUL. An expected error is not a bug: an
// engine that will not answer a read is a real thing that happens, and a screen saying so is the product
// working. It becomes a QUALITY DEFECT when the saying-so is a dead end. The checkable bar:
//
//   a human sentence, not a raw code or a bare status
//   a NAMED remedy
//   contained to its region rather than replacing the screen
//   recoverable
//   not carried by colour alone
//
// Seven controls failed the middle two. Each loaded once, and on a throw painted a single sentence with
// nothing to press. Five of them also interpolated errText(err), which is the engine client's own
// "<verb>: <status>" throw, so the operator was handed `(get approval policy: 500)`: an internal verb
// name where a remedy belongs. Because every one of these controls is BUILT ONCE at screen render, there
// was no second load to reach: the only way back was reloading the tab.
//
// WHAT THIS FILE ASSERTS, AND WHY IT IS NOT THE ASSERTION THAT ALREADY SHIPPED A BUG HERE. A check that
// only refuses the EMPTY state passes on an error banner, and that exact shape has shipped before
// (a capture cell that refused only the empty state). So no assertion below is "something rendered". Each
// case pins THREE things:
//
//   1. the retry CONTROL exists, by its own data-dp, so a decorative sentence cannot satisfy it;
//   2. the OLD rendering is gone, by refusing the engine client's throw text verbatim in the visible
//      copy, so restoring the raw interpolation fails this file even if a button were left behind;
//   3. pressing it RE-RUNS THE READ AND THE REGION RECOVERS, so a button wired to nothing fails too.
//
// (3) is the one that matters most. A remedy that does not remedy is worse than no button, because it
// costs the operator a click and their belief in the control.

import { installDomShim, qs, qsa, textOf, flushAsync, markConnected } from "./dom-shim.ts";
installDomShim();

const store = await import("../src/lib/store.ts");
const { configApprovalControl, recoveryAccessControl } = await import("../src/screens/security-centre/access.ts");
const { changeNumberControl } = await import("../src/screens/security-centre/change-management.ts");
const { signInContextControl } = await import("../src/screens/security-centre/signin-context.ts");
const { renderPostureSwitch } = await import("../src/screens/keys/posture-switch.ts");
const { renderResidency } = await import("../src/screens/settings/sections.ts");
const { rtoPanel } = await import("../src/screens/reports-rto.ts");
const { POLICY_READ_FAILED } = await import("../src/screens/security-centre/shared.ts");
const { buildMapDrawer } = await import("../src/screens/map/drawer.ts");
const { openDetail } = await import("../src/screens/sources-downpipes/detail.ts");
const { renderSplit } = await import("../src/components/custody-step-panels.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// The retry control's own stable hook. Reading the BUTTON rather than the word "Try again" is deliberate:
// the visible label is copy and may be reworded, the hook is the stable contract.
const RETRY = '[data-dp="components-error-view.button.reload"]';

// The engine client throws Error("<verb>: <status>") on a non-2xx (client-transport.ts). Reproducing that
// exact shape is what makes assertion (2) load-bearing: it is the very string the old code spliced into
// the sentence, so a regression that brings the interpolation back puts THIS text on screen.
const thrown = (verb: string, status: number): Error => new Error(`${verb}: ${status}`);

// owner() seats a verified Owner. Every control under test gates on the caller's role, and a null caller
// falls back to the fail-closed "viewer", which hides the very controls whose failure branch is the
// subject here.
function owner(): void {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false } as never);
  store.connect("https://engine.test");
}

// stubbed installs a scripted engine method and returns the engine, counting calls so a retry that never
// re-reads is caught rather than assumed.
function stubbed(method: string, script: Array<unknown | Error>): { engine: never; calls: () => number } {
  owner();
  const engine = store.getEngine() as unknown as Record<string, unknown>;
  let i = 0;
  engine[method] = () => {
    const next = script[Math.min(i, script.length - 1)];
    i++;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { engine: engine as never, calls: () => i };
}

// A StatusReport complete enough for the two panels that read one. Only the fields these panels touch
// need to be real; the rest ride as undefined, which is what an older engine sends anyway.
const STATUS_OK = {
  operationalConfigured: { private: true, public: true },
  signerConfigured: true,
  breakGlassConfigured: true,
  recoveryCodesRemaining: 7,
  destKind: "r2",
} as unknown;

// press finds the retry control inside a rendered region and clicks it.
function press(el: HTMLElement): boolean {
  const btn = qs(el as unknown as never, RETRY);
  if (!btn) return false;
  (btn as unknown as { click: () => void }).click();
  return true;
}

// ---------------------------------------------------------------------------------------------------
// checkRecovery is the whole bar, applied once per control.
//
//   region      the rendered element
//   calls       how many times the read has been issued so far
//   rawThrow    the exact engine-client throw text the OLD code would have shown
//   recovered   a predicate over the region's text that is true ONLY of the loaded state
// ---------------------------------------------------------------------------------------------------
async function checkRecovery(opts: {
  name: string;
  region: HTMLElement;
  calls: () => number;
  rawThrow: string;
  recovered: (text: string) => boolean;
}): Promise<void> {
  const { name, region, calls, rawThrow, recovered } = opts;
  const failedText = textOf(region as unknown as never);

  // (1) a named remedy exists, as a control, not as prose about one.
  ok(`${name}: the failed read offers a retry control`, qs(region as unknown as never, RETRY) !== null);

  // (2) the old rendering is gone. The engine client's throw is an internal verb plus a status; it is not
  //     a remedy and it is not a sentence, and it must not be what the operator reads.
  ok(`${name}: the engine client's raw throw ("${rawThrow}") is NOT on screen`, !failedText.includes(rawThrow));
  ok(`${name}: and the region says something, so this is not passing on an empty node`, failedText.trim().length > 20);

  // (3) the remedy remedies. Read the call count first so a button wired to nothing is caught even if the
  //     region happened to repaint for some other reason.
  const before = calls();
  ok(`${name}: the retry control is reachable and clickable`, press(region));
  await flushAsync();
  ok(`${name}: pressing it RE-ISSUES the read (${before} -> ${calls()})`, calls() > before);
  const afterText = textOf(region as unknown as never);
  ok(`${name}: and the region recovers to its loaded state`, recovered(afterText));
  ok(`${name}: with the retry control gone once it succeeded`, qs(region as unknown as never, RETRY) === null);
}

async function main(): Promise<void> {
  console.log("-- P4.2: a failed section read leaves a way back --\n");

  // ---- (1) the three approval-policy switches -----------------------------------------------------
  // All three read getConfigApprovalPolicy, so ONE engine fault reaches all three at once. That is why
  // they share POLICY_READ_FAILED rather than each inventing wording, and why the old dead end was three
  // dead controls on one screen from a single 500.
  const policy = { requireConfigApproval: true, requireChangeNumber: true, notifyNewSignInContext: true };

  console.log("(1) dual control (four-eyes) switch");
  {
    const { engine, calls } = stubbed("getConfigApprovalPolicy", [thrown("get approval policy", 500), policy]);
    const el = configApprovalControl(engine);
    markConnected(el as unknown as never);
    await flushAsync();
    await checkRecovery({
      name: "(1) dual control",
      region: el,
      calls,
      rawThrow: "get approval policy: 500",
      recovered: (t) => t.includes("Four-eyes is ON: config changes need a second approver."),
    });
    ok("(1) dual control: the shared sentence explains WHY the switch is disabled", textOf(el as unknown as never).length > 0);
  }

  console.log("\n(2) change-number switch");
  {
    const { engine, calls } = stubbed("getConfigApprovalPolicy", [thrown("get approval policy", 500), policy]);
    const el = changeNumberControl(engine);
    markConnected(el as unknown as never);
    await flushAsync();
    await checkRecovery({
      name: "(2) change number",
      region: el,
      calls,
      rawThrow: "get approval policy: 500",
      recovered: (t) => t.includes("ask for a change number"),
    });
  }

  console.log("\n(3) new-location sign-in notification switch");
  {
    const { engine, calls } = stubbed("getConfigApprovalPolicy", [thrown("get approval policy", 500), policy]);
    const el = signInContextControl(engine);
    markConnected(el as unknown as never);
    await flushAsync();
    await checkRecovery({
      name: "(3) sign-in context",
      region: el,
      calls,
      rawThrow: "get approval policy: 500",
      recovered: (t) => t.includes("unusual sign-in location") || t.includes("do not check for a new location"),
    });
  }

  console.log("\n(4) the shared sentence is ONE string, not three drifting copies");
  {
    // Three controls, one fault, one wording. Asserted by rendering all three against the same throw and
    // requiring the same sentence, because the alternative (three hand-written near-duplicates) is how
    // copy drifts into three different accounts of one engine fault.
    const texts: string[] = [];
    for (const build of [configApprovalControl, changeNumberControl, signInContextControl]) {
      const { engine } = stubbed("getConfigApprovalPolicy", [thrown("get approval policy", 503)]);
      const el = build(engine);
      markConnected(el as unknown as never);
      await flushAsync();
      texts.push(textOf(el as unknown as never));
    }
    ok("(4a) all three carry the shared POLICY_READ_FAILED sentence", texts.every((t) => t.includes(POLICY_READ_FAILED)));
    ok("(4b) and it names what the state MEANS, not just that it failed", POLICY_READ_FAILED.includes("stays disabled") && POLICY_READ_FAILED.includes("Nothing has changed"));
    ok("(4c) and it carries no HTTP status or engine verb", !/\b[45]\d\d\b/.test(POLICY_READ_FAILED) && !POLICY_READ_FAILED.includes(":"));
  }

  // ---- (5) the recovery-code panel ----------------------------------------------------------------
  // This one is the worst of the seven by consequence: behind the failed read sit the operator's own
  // remaining single-use recovery codes, the Regenerate control and the Owner-only break-glass retire.
  // All of it was replaced by one sentence carrying "status: 500".
  console.log("\n(5) recovery codes and break-glass panel");
  {
    const { engine, calls } = stubbed("status", [thrown("status", 500), STATUS_OK]);
    const el = recoveryAccessControl(engine);
    markConnected(el as unknown as never);
    await flushAsync();
    await checkRecovery({
      name: "(5) recovery codes",
      region: el,
      calls,
      rawThrow: "status: 500",
      recovered: (t) => t.includes("Your recovery codes"),
    });
    // The panel's whole point is the count and the Regenerate; prove the recovery restored THEM, not
    // merely some text. A predicate satisfied by any repaint is the vacuous-assertion shape this file
    // exists to avoid.
    ok("(5) recovery codes: the remaining count is back", textOf(el as unknown as never).includes("7"));
  }

  // ---- (6) the strict break-glass-only custody switch ----------------------------------------------
  console.log("\n(6) strict break-glass-only custody switch (Keys)");
  {
    const { engine, calls } = stubbed("status", [thrown("status", 502), STATUS_OK]);
    const el = renderPostureSwitch(engine);
    markConnected(el as unknown as never);
    await flushAsync();
    await checkRecovery({
      name: "(6) posture switch",
      region: el,
      calls,
      rawThrow: "status: 502",
      recovered: (t) => t.includes("break-glass-only removes that key") || t.includes("already break-glass-only"),
    });
    // The heading is OUTSIDE the replaced body, so it stays through the failure. That is the "contained
    // to its region" clause, and it is worth pinning: a degrade that took the card title with it would
    // leave an unlabelled box.
    ok("(6) posture switch: the card heading survived the failure", textOf(el as unknown as never).includes("Strict break-glass-only custody"));
  }

  // ---- (7) the residency panel (Settings) ----------------------------------------------------------
  console.log("\n(7) residency panel (Settings)");
  {
    const { engine, calls } = stubbed("status", [thrown("status", 500), STATUS_OK]);
    const el = renderResidency(engine);
    markConnected(el as unknown as never);
    await flushAsync();
    await checkRecovery({
      name: "(7) residency",
      region: el,
      calls,
      rawThrow: "status: 500",
      recovered: (t) => t.includes("In-account R2"),
    });
  }

  // ---- (8) the recovery-time (RTO) panel -----------------------------------------------------------
  console.log("\n(8) recovery-time estimate panel (Reports)");
  {
    const rep = { fleet: { known: false }, downpipes: [] };
    const { engine, calls } = stubbed("rto", [thrown("rto", 500), rep]);
    const el = rtoPanel(engine);
    markConnected(el as unknown as never);
    await flushAsync();
    await checkRecovery({
      name: "(8) rto",
      region: el,
      calls,
      rawThrow: "rto: 500",
      recovered: (t) => t.includes("Across the fleet"),
    });
  }

  // ---- (9) the retry control itself ----------------------------------------------------------------
  // inlineRetry is the shared primitive. Pinning its own shape here means a change that quietly drops the
  // button, or turns the state into a tint with no words, fails ONE test rather than seven flakily.
  console.log("\n(9) the shared inlineRetry primitive");
  {
    const { inlineRetry } = await import("../src/components/error-view.ts");
    let ran = 0;
    const el = inlineRetry({ message: "A sentence a person can read.", onReload: () => { ran++; } });
    ok("(9a) it renders the message as text", textOf(el as unknown as never).includes("A sentence a person can read."));
    ok("(9b) it carries the retry control", qs(el as unknown as never, RETRY) !== null);
    ok("(9c) the control is a real button, not a styled span", qsa(el as unknown as never, "button").length === 1);
    press(el);
    ok("(9d) pressing it calls onReload exactly once", ran === 1);
    // role="status" (polite), NOT role="alert". A subordinate region degrading must not interrupt, and
    // three of these can be on one screen at once from a single engine fault.
    ok("(9e) it announces politely (role=status), so three at once do not interrupt", (el as unknown as { getAttribute: (n: string) => string | null }).getAttribute("role") === "status");
    // The state is in the sentence. A reader who cannot see the tint still learns what happened.
    ok("(9f) the state is carried by words, not by a tone class", !/\b(card--warn|card--danger|banner--danger)\b/.test(String((el as unknown as { className?: string }).className ?? "")));
  }

  // ---- (10) the map drawer: two lazily-loaded sections in one overlay ------------------------------
  // These two are the reason the primitive is a COMPACT one. Both sections can fail from the same engine
  // fault, in the same drawer, at the same time, and two full alert cards inside one overlay is exactly
  // the density the calm budget rules out.
  //
  // The roster note is the sharper defect of the two. It is the WHY behind a standing "Unknown" edge, and
  // its failure branch was `.catch(() => host.remove())`: the body vanished and the section HEADING stayed,
  // so the drawer asked "Why is this unknown?" and then showed a blank. A question with a deleted answer
  // is not a calm degrade, it is a screen that looks broken.
  console.log("\n(10) the map drawer (recent runs + the unknown-edge explanation)");
  {
    owner();
    const engine = store.getEngine() as unknown as Record<string, unknown>;
    let hist = 0;
    let roster = 0;
    engine.listHistory = () => { hist++; return hist === 1 ? Promise.reject(thrown("list history", 500)) : Promise.resolve([]); };
    engine.rosterHygiene = () => { roster++; return Promise.reject(thrown("roster hygiene", 500)); };
    const flow = { id: "dp:abc", status: "unknown", source: { name: "src", kind: "kv" }, destination: { name: "dest", kind: "r2" }, enabled: true, running: false } as never;
    buildMapDrawer(flow, { engine: engine as never, lastData: null, onClose: () => {}, refresh: () => {}, canDelete: true, canReconcile: true } as never);
    await flushAsync();
    const body = document.body as unknown as HTMLElement;
    const text = textOf(body as unknown as never);

    ok("(10a) both failed sections offer a retry control", qsa(body as unknown as never, RETRY).length === 2);
    ok("(10b) the run-history failure says what is missing and what is not", text.includes("no runs are listed") && text.includes("The rest of this drawer is unaffected"));
    // The old rendering deleted the answer and kept the question. Pin the pair: the heading must still be
    // there AND something must now be under it.
    ok("(10c) the unknown-edge section still asks its question", text.includes("Why is this unknown?"));
    ok("(10d) and now ANSWERS it, rather than leaving the heading over a blank", text.includes("why this route reads as unknown could not be worked out"));
    // The counter was recorded but never read, so a drawer that stopped issuing the roster read at all would
    // have reached (10c)/(10d) on a stale render. Assert the read was attempted, as (10e) does for history.
    ok(`(10d2) and the roster read was actually attempted (${roster} call(s))`, roster > 0);

    // The remedy remedies: press the run-history retry and the section repaints to its loaded state.
    const before = hist;
    const buttons = qsa(body as unknown as never, RETRY);
    (buttons[0] as unknown as { click: () => void }).click();
    await flushAsync();
    ok(`(10e) pressing the run-history retry re-issues the read (${before} -> ${hist})`, hist > before);
    ok("(10f) and that section recovers", textOf(body as unknown as never).includes("No runs yet."));
    ok("(10g) while the OTHER failed section is untouched, so one retry does not reset the drawer", qsa(body as unknown as never, RETRY).length === 1);
    document.body.replaceChildren();
  }

  // ---- (11) the downpipe detail drawer's run history -----------------------------------------------
  // One read feeds three things here (the run strip, the freshness banner and the throughput summary), so
  // its failure quietly took all three off the drawer with a five-word sentence and no way back.
  console.log("\n(11) the downpipe detail drawer (run history)");
  {
    owner();
    const engine = store.getEngine() as unknown as Record<string, unknown>;
    let hist = 0;
    engine.listHistory = () => { hist++; return hist === 1 ? Promise.reject(thrown("list history", 500)) : Promise.resolve([]); };
    engine.listDestinations = () => Promise.resolve({ destinations: [] });
    const state = {
      config: { id: "abc", name: "nightly", cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } },
      nextRunAt: 0,
      lastRunId: "",
      inFlight: false,
    } as never;
    openDetail(engine as never, state, { latestRun: new Map(), status: null, reload: () => {} });
    await flushAsync();
    const body = document.body as unknown as HTMLElement;
    ok("(11a) the failed run-history read offers a retry control", qs(body as unknown as never, RETRY) !== null);
    ok("(11b) and names all three things it took with it", textOf(body as unknown as never).includes("no runs, freshness or throughput are shown"));
    const before = hist;
    press(body);
    await flushAsync();
    ok(`(11c) pressing it re-issues the read (${before} -> ${hist})`, hist > before);
    ok("(11d) and the section recovers", qs(body as unknown as never, RETRY) === null);
    document.body.replaceChildren();
  }

  // ---- (12) the custody share send: a busy state must own its own rejection ------------------------
  // This is the calibration bug's shape, in the M-of-N custody ceremony. `sendShare` is a HOST-INJECTED
  // prop, and the await had no rejection path: a throw left the button disabled reading "Sending" and the
  // spinner line up, for good. The consequence is worse than a frozen panel, because the operator's
  // reasonable reading of a stuck "Sending" is that it is still going, so a custodian who never received
  // a share is believed to hold one, and an M-of-N scheme is quietly short a share.
  //
  // It was not reachable on main: all three injectors route to sendCustodyShare, which catches everything
  // by contract. But NOTHING AT THIS SEAM ENFORCED THAT, and this test now does, by injecting the
  // rejecting sender the type has always permitted.
  console.log("\n(12) the custody share send (a rejecting sender must not freeze the button)");
  {
    const ctx = {
      state: { scheme: "split", splitN: 3, splitThreshold: 2, signoffs: [] },
      result: { breakGlass: { identityB64: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") } },
      downloadText: () => true,
      emitMeta: () => {},
      // The rejection the panel used to have no path for.
      sendShare: () => Promise.reject(thrown("send share", 500)),
    } as never;
    const el = renderSplit(ctx);
    (qs(el as unknown as never, '[data-dp="components-custody-step-panels.button.split"]') as unknown as { click: () => void }).click();
    for (let i = 0; i < 8; i++) await flushAsync();
    const emailBtns = qsa(el as unknown as never, '[data-dp="components-custody-step-panels.button.email"]');
    ok("(12a) the split produced a per-share Email action", emailBtns.length === 3);
    (emailBtns[0] as unknown as { click: () => void }).click();
    for (let i = 0; i < 4; i++) await flushAsync();
    const inputs = qsa(el as unknown as never, "input");
    const emailInput = inputs.find((i) => {
      const el2 = i as unknown as { type?: string; id?: string };
      return el2.type === "email" || String(el2.id ?? "").includes("email");
    });
    ok("(12b) the send form carries an email field", emailInput !== undefined);
    (emailInput as unknown as { value: string }).value = "custodian@example.com";
    const send = qsa(el as unknown as never, '[data-dp="components-custody-step-panels.button.send"]')[0] as unknown as {
      disabled: boolean;
      textContent: string;
      click: () => void;
    };
    send.click();
    for (let i = 0; i < 8; i++) await flushAsync();

    // The two halves of the old freeze, pinned separately: the CONTROL and the STATUS LINE.
    ok("(12c) the send button is enabled again after the rejection", send.disabled === false);
    ok("(12d) and is no longer stuck on its busy label", send.textContent !== "Sending");
    const text = textOf(el as unknown as never);
    ok("(12e) the spinner line is gone", !text.includes("Sending the share through your engine"));
    ok("(12f) and the operator is told the share was NOT delivered", text.includes("treat this share as NOT delivered"));
    ok("(12g) with a named remedy that does not depend on the engine", text.includes("download it and hand it over yourself"));
    ok("(12h) and no engine-client throw text on screen", !text.includes("send share: 500"));
  }

  console.log(failures === 0 ? "\nERROR-RECOVERY BAR PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

await main();
