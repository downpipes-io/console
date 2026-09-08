// PAINT BEFORE LEAVE, PRESSED RATHER THAN PARSED.
//
//   node test/validate-paint-before-leave.ts
//
// scripts/paint-before-leave-gate.mjs reads control flow off the AST and answers "could this path leave a
// busy state behind". This file answers the different question the gate cannot: DOES IT. Each case builds a
// real control over the shared DOM shim, makes the engine answer 401, presses the thing an operator would
// press, and then looks at what is on screen.
//
// WHY BOTH. The gate is a static reader and it has been wrong in both directions during this very pass: it
// reported four regions that repaint on every path (a traversal that stepped over the outermost `.then` of a
// returned expression), and it is blind to at least one freeze that is real (keys/shared.ts's empty-token
// return, below, which it cannot see because it asks "does run() release anywhere" rather than "on this
// path"). A static gate and a behavioural one fail differently, which is the only reason to have two.
//
// THE ANTI-VACUITY RULE, and it is the whole design of this file. A check that only asserts "the region is
// not a skeleton afterwards" passes on a control that never went busy in the first place, and a check that
// only asserts "some text appeared" passes on an error banner. This exact shape has already shipped a capture
// cell that refused only the empty state, so every case here pins THREE things in order:
//
//   1. BUSY WAS ENTERED. Before the rejection is allowed to settle, the control is asserted to be IN the
//      busy state (a pending label, a disabled button, a seeded skeleton). A case that cannot show this
//      fails, because it is not testing the path it claims to.
//   2. BUSY IS GONE. Afterwards, the pending vocabulary is asserted ABSENT, using the gate's own two
//      participle rules rather than a hand-picked string, so a reworded label cannot quietly pass.
//   3. SOMETHING TOOK ITS PLACE, and the operator can act. A sentence, and where the flow has one, a
//      control (the retry, or the re-enabled button under its resting label).
//
// AND IT LEFT. goSignedOut() must STILL have been called: the rule is paint first THEN leave, not paint
// instead of leaving. The nav bridge is installed here with a recording handler so a fix that painted and
// then swallowed the departure fails just as loudly as one that left without painting.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim } from "./dom-shim.ts";

// Install BEFORE importing any module that touches document at load time.
installDomShim();

import { flushAsync, markConnected, qs, qsa, type ShimNode, textOf } from "./dom-shim.ts";
import { click, findButtonByText, SN } from "./validate-stable-components-shared.ts";

const store = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------------------------------
// The departure recorder. onUnauthorised is what goSignedOut() reaches; counting it is how "then leave"
// stays half of the contract rather than being quietly dropped by a fix that only paints.
// ---------------------------------------------------------------------------------------------------
let departures = 0;
installNav({
  navigate: () => { departures++; },
  onUnauthorised: () => { departures++; },
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  signOut: () => { departures++; },
});

// The engine client throws Error("<verb>: <status>") on a non-2xx (lib/api/client-transport.ts), and
// classifyError maps a 401 to "unauthorised". Reproducing that exact shape is what makes these cases the
// real 401 branch rather than a generic catch.
const un = (verb: string): Error => new Error(`${verb}: 401`);

// THE GATE'S OWN PENDING VOCABULARY, copied deliberately rather than approximated. Asserting the absence of
// one hand-picked string ("Saving…") would pass the moment someone reworded a label; asserting the absence
// of the CLASS is what keeps step 2 honest. Kept in sync with scripts/paint-before-leave-gate.mjs.
const TRAILING_PENDING = /\b\w+ing\b[^.…]*(…|\.\.\.)\s*$/i;
const LEADING_PENDING = /^\s*[A-Z]\w*ing\b/;
const isPending = (t: string): boolean => LEADING_PENDING.test(t.trim()) || TRAILING_PENDING.test(t.trim());

// A busy REGION shows the console's skeleton nodes. The shim keeps class names, so the seeded wait is
// observable without reaching into the renderer.
function hasSkeleton(el: HTMLElement): boolean {
  return qsa(el as unknown as ShimNode, ".skeleton").length > 0 || qsa(el as unknown as ShimNode, ".skeleton-row").length > 0;
}
const RETRY = '[data-dp="components-error-view.button.reload"]';

function owner(): void {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false } as never);
  store.connect("https://engine.test");
}

// stub installs scripted engine methods and counts the calls, so a control that never issued the read (and
// therefore never went busy) cannot pass by looking calm.
function stub(methods: Record<string, unknown[]>): { engine: never; calls: Record<string, number> } {
  owner();
  const engine = store.getEngine() as unknown as Record<string, unknown>;
  const calls: Record<string, number> = {};
  for (const [name, script] of Object.entries(methods)) {
    calls[name] = 0;
    engine[name] = () => {
      const next = script[Math.min(calls[name]!, script.length - 1)];
      calls[name]!++;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
  }
  return { engine: engine as never, calls };
}

// deferred hands back a promise that stays PENDING until it is rejected on purpose. The busy window of an
// action control is otherwise unobservable: a stub that rejects immediately has already settled by the time
// the first flush returns, and step 1 (busy was entered) would be untestable rather than merely unasserted.
function deferred<T>(): { promise: Promise<T>; fail: (e: Error) => void } {
  let fail!: (e: Error) => void;
  const promise = new Promise<T>((_res, rej) => { fail = rej; });
  // The rejection is deliberate and is handled by the code under test; nothing here must warn about it.
  promise.catch(() => {});
  return { promise, fail };
}

// ---------------------------------------------------------------------------------------------------
// checkRegion is the whole bar for a READ region: seeded with a skeleton, answered with a 401.
// ---------------------------------------------------------------------------------------------------
async function checkRegion(name: string, build: () => HTMLElement, opts?: { retry?: boolean }): Promise<void> {
  const before = departures;
  const region = build();
  markConnected(region as unknown as never);

  // (1) BUSY WAS ENTERED. Synchronously, before the rejection settles.
  ok(`${name}: the region is seeded with a wait before the read answers`, hasSkeleton(region) || isPending(textOf(region as unknown as never)));

  await flushAsync();
  await flushAsync();
  const after = textOf(region as unknown as never);

  // (2) BUSY IS GONE.
  ok(`${name}: the wait is GONE after the 401`, !hasSkeleton(region));
  ok(`${name}: and no pending label is left on screen`, !isPending(after));

  // (3) SOMETHING TOOK ITS PLACE, and it says something.
  ok(`${name}: the region says what happened (${after.trim().length} chars)`, after.trim().length > 20);
  ok(`${name}: naming the session rather than a bare code`, /session/i.test(after));
  if (opts?.retry !== false) {
    ok(`${name}: with a control to act on`, qs(region as unknown as ShimNode, RETRY) !== null);
  }

  // AND IT LEFT.
  ok(`${name}: goSignedOut() still ran (paint first, THEN leave)`, departures > before);
}

// answerModal drives the REAL confirmModal under the shim: it waits for the dialog to render and clicks the
// button carrying the given label. Nothing is stubbed, so the confirm ORDERING stays part of what is tested.
async function answerModal(label: string): Promise<boolean> {
  await flushAsync();
  const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
  if (!surface) return false;
  const btn = findButtonByText(surface, label);
  if (!btn) return false;
  click(btn);
  await flushAsync();
  return true;
}

function setField(root: HTMLElement, sel: string, value: string): boolean {
  const el = qs(root as unknown as ShimNode, sel) as unknown as { value: string; dispatchEvent: (e: unknown) => void } | null;
  if (!el) return false;
  el.value = value;
  return true;
}

async function main(): Promise<void> {
  console.log("-- paint before leave: pressed with a 401, and the repaint asserted --\n");

  // =================================================================================================
  console.log("1. SCREEN-LOAD REGIONS: a skeleton seeded, the read refused, the region replaced");
  // =================================================================================================
  {
    const { renderHistoryPanel } = await import("../src/screens/notifications/history.ts");
    const { engine } = stub({ listNotifyHistory: [un("list notify history")] });
    await checkRegion("notifications/history", () => renderHistoryPanel(engine));
  }
  {
    const { renderChannelsPanel } = await import("../src/screens/notifications/channels.ts");
    const { engine } = stub({ listNotifyChannels: [un("list notify channels")] });
    await checkRegion("notifications/channels", () => renderChannelsPanel(engine));
  }
  {
    const { renderResidency } = await import("../src/screens/settings/sections.ts");
    const { engine } = stub({ status: [un("engine status")] });
    await checkRegion("settings/residency", () => renderResidency(engine));
  }
  {
    const { rtoPanel } = await import("../src/screens/reports-rto.ts");
    const { engine } = stub({ rto: [un("rto")] });
    await checkRegion("reports/rto", () => rtoPanel(engine));
  }
  {
    const { recoveryAccessControl } = await import("../src/screens/security-centre/access.ts");
    const { engine } = stub({ status: [un("engine status")] });
    await checkRegion("security-centre/recovery-access", () => recoveryAccessControl(engine));
  }
  {
    const { renderKeyVintages } = await import("../src/screens/keys/vintages.ts");
    const { engine } = stub({ getKeyVintages: [un("get key vintages")] });
    await checkRegion("keys/vintages", () => renderKeyVintages(engine));
  }

  // =================================================================================================
  console.log("\n2. submitPushForm: the SIEM save button, driven through the real form");
  // =================================================================================================
  {
    const { renderPushDestination } = await import("../src/screens/settings/push.ts");
    const inFlight = deferred<never>();
    const { engine, calls } = stub({
      getPush: [{ present: false, trail: [] }],
      getConfigApprovalPolicy: [{ requireConfigApproval: false, requireChangeNumber: false }],
      setPush: [inFlight.promise],
    });
    const card = renderPushDestination(engine);
    markConnected(card as unknown as never);
    await flushAsync();

    const configure = qs(card as unknown as ShimNode, '[data-dp="settings.button.configure#2"]');
    ok("push: the Set up control is reachable", configure !== null);
    if (configure) {
      click(configure as unknown as never);
      await flushAsync();
      ok("push: the endpoint field is reachable", setField(card, "#push-endpoint", "https://siem.example.com/ingest"));
      ok("push: the secret field is reachable", setField(card, "#push-secret", "s3cr3t-value"));

      const save = qs(card as unknown as ShimNode, '[data-dp="settings.button.save#2"]') as unknown as { disabled: boolean; textContent: string } | null;
      ok("push: the Save control is reachable", save !== null);
      if (save) {
        const before = departures;
        click(save as unknown as never);
        // (1) BUSY WAS ENTERED. submitPushForm awaits validateForm and requireChange first, so let those
        //     settle; setPush is still PENDING here, which is the whole point of the deferred.
        await flushAsync();
        ok(`push: setPush was actually called (${calls.setPush})`, calls.setPush! > 0);
        ok("push: the Save control is disabled while the save is in flight", save.disabled === true);
        ok(`push: reading a pending label ("${save.textContent}")`, isPending(save.textContent ?? ""));
        // Now, and only now, the session lapses.
        inFlight.fail(un("set push"));
        await flushAsync();
        await flushAsync();
        // (2) + (3)
        ok("push: after the 401 the Save control is pressable again", save.disabled === false);
        ok(`push: and off the pending label (now "${save.textContent}")`, !isPending(save.textContent ?? ""));
        ok("push: the form says the session ended", /session/i.test(textOf(card as unknown as never)));
        ok("push: goSignedOut() still ran", departures > before);
      }
    }
  }

  // =================================================================================================
  console.log("\n3. submitOtlpPushForm: the OTLP save button, driven through the real form");
  // =================================================================================================
  {
    const { renderOtlpPushDestination } = await import("../src/screens/settings/otlp-push.ts");
    const inFlight = deferred<never>();
    const { engine, calls } = stub({
      getOtlpPush: [{ present: false, trail: [] }],
      getConfigApprovalPolicy: [{ requireConfigApproval: false, requireChangeNumber: false }],
      setOtlpPush: [inFlight.promise],
    });
    const card = renderOtlpPushDestination(engine);
    markConnected(card as unknown as never);
    await flushAsync();

    const configure = qs(card as unknown as ShimNode, '[data-dp="settings.button.configure#1"]');
    ok("otlp: the Set up control is reachable", configure !== null);
    if (configure) {
      click(configure as unknown as never);
      await flushAsync();
      ok("otlp: the endpoint field is reachable", setField(card, "#otlp-push-endpoint", "https://otlp.example.com/v1/metrics"));
      ok("otlp: the secret field is reachable", setField(card, "#otlp-push-secret", "otlp-s3cr3t"));

        const save = qs(card as unknown as ShimNode, '[data-dp="settings.button.save#1"]') as unknown as { disabled: boolean; textContent: string } | null;
      ok("otlp: the Save control is reachable", save !== null);
      if (save) {
        const before = departures;
        click(save as unknown as never);
        await flushAsync();
        ok(`otlp: setOtlpPush was actually called (${calls.setOtlpPush})`, calls.setOtlpPush! > 0);
        ok("otlp: the Save control is disabled while the save is in flight", save.disabled === true);
        ok(`otlp: reading a pending label ("${save.textContent}")`, isPending(save.textContent ?? ""));
        inFlight.fail(un("set otlp push"));
        await flushAsync();
        await flushAsync();
        ok("otlp: after the 401 the Save control is pressable again", save.disabled === false);
        ok(`otlp: and off the pending label (now "${save.textContent}")`, !isPending(save.textContent ?? ""));
        ok("otlp: the form says the session ended", /session/i.test(textOf(card as unknown as never)));
        ok("otlp: goSignedOut() still ran", departures > before);
      }
    }
  }

  // =================================================================================================
  console.log("\n3b. submitPushForm in REPLACE mode: through the real confirm modal, then a 401");
  // =================================================================================================
  // REPLACE is the guarded variant: submitPushForm awaits a confirmModal before it touches the engine. The
  // modal is DRIVEN, not stubbed, so the ordering stays part of the test (a save that fired before the
  // confirm, or a cancel that saved anyway, fails here). It matters for the freeze specifically because the
  // busy-set sits AFTER the confirm: a fix tested only on the unguarded path proves nothing about this one.
  {
    const { renderPushDestination } = await import("../src/screens/settings/push.ts");
    const inFlight = deferred<never>();
    const { engine, calls } = stub({
      getPush: [{ present: true, enabled: true, format: "json", sink: "https", endpoint: "https://old.example.com/in", authHeaderName: "authorization", trail: [] }],
      getConfigApprovalPolicy: [{ requireConfigApproval: false, requireChangeNumber: false }],
      setPush: [inFlight.promise],
    });
    const card = renderPushDestination(engine);
    markConnected(card as unknown as never);
    await flushAsync();

    const replace = qs(card as unknown as ShimNode, '[data-dp="settings.button.replace#2"]');
    ok("push/replace: the Replace control is reachable", replace !== null);
    if (replace) {
      click(replace as unknown as never);
      await flushAsync();
      ok("push/replace: the endpoint field is reachable", setField(card, "#push-endpoint", "https://new.example.com/in"));
      ok("push/replace: the secret field is reachable", setField(card, "#push-secret", "new-s3cr3t"));
      const save = qs(card as unknown as ShimNode, '[data-dp="settings.button.save#2"]') as unknown as { disabled: boolean; textContent: string } | null;
      ok("push/replace: the Save control is reachable", save !== null);
      if (save) {
        // A CANCEL must send nothing and must not leave the control busy.
        click(save as unknown as never);
        ok("push/replace: the confirm modal is presented", await answerModal("Cancel"));
        await flushAsync();
        ok("push/replace: cancelling sends nothing", calls.setPush === 0);
        ok("push/replace: and leaves the control pressable", save.disabled === false && !isPending(save.textContent ?? ""));

        // Now confirm, and let the session lapse mid-save.
        const before = departures;
        click(save as unknown as never);
        ok("push/replace: the confirm modal is presented again", await answerModal("Replace"));
        await flushAsync();
        ok(`push/replace: setPush was called after the confirm (${calls.setPush})`, calls.setPush! > 0);
        ok("push/replace: the Save control is disabled while the save is in flight", save.disabled === true);
        ok(`push/replace: reading a pending label ("${save.textContent}")`, isPending(save.textContent ?? ""));
        inFlight.fail(un("set push"));
        await flushAsync();
        await flushAsync();
        ok("push/replace: after the 401 the Save control is pressable again", save.disabled === false);
        ok(`push/replace: and off the pending label (now "${save.textContent}")`, !isPending(save.textContent ?? ""));
        ok("push/replace: goSignedOut() still ran", departures > before);
      }
    }
  }

  // =================================================================================================
  console.log("\n4. renderTokenApply: the ceremony apply control, including the freeze the GATE CANNOT SEE");
  // =================================================================================================
  // THE EMPTY-TOKEN PATH. The click handler disables the button before run() is reached, and run()'s
  // empty-field guard used to return without giving it back, so pressing Apply with the field blank killed
  // the one control on the step. The static gate cannot catch a regression here: it asks whether run()
  // releases the button ANYWHERE, and run() does, on its other three paths. This case is the only guard.
  {
    const { renderTokenApply } = await import("../src/screens/keys/shared.ts");
    owner();
    let applied = 0;
    const wrap = renderTokenApply({
      tokenPurpose: "run the fixture apply",
      applyLabel: "Apply the key",
      busyLabel: "Applying the key",
      doneLabel: "Applied",
      apply: async () => { applied++; },
    });
    markConnected(wrap as unknown as never);
    const btn = qs(wrap as unknown as ShimNode, '[data-dp="keys.button.apply"]') as unknown as { disabled: boolean; textContent: string } | null;
    ok("token-apply: the Apply control is reachable", btn !== null);
    if (btn) {
      click(btn as unknown as never);
      await flushAsync();
      await flushAsync();
      ok("token-apply/empty: the apply was NOT attempted", applied === 0);
      ok("token-apply/empty: the field error is shown", /paste the deploy token/i.test(textOf(wrap as unknown as never)));
      ok("token-apply/empty: and the control is pressable again, not dead", btn.disabled === false);
      ok(`token-apply/empty: under its resting label (now "${btn.textContent}")`, !isPending(btn.textContent ?? ""));
    }
  }
  // THE 401 PATH, with a token pasted.
  {
    const { renderTokenApply } = await import("../src/screens/keys/shared.ts");
    owner();
    const wrap = renderTokenApply({
      tokenPurpose: "run the fixture apply",
      applyLabel: "Apply the key",
      busyLabel: "Applying the key",
      doneLabel: "Applied",
      apply: () => Promise.reject(un("install keys")),
    });
    markConnected(wrap as unknown as never);
    const input = qs(wrap as unknown as ShimNode, '[data-dp="keys.password.token"]') as unknown as { value: string } | null;
    const btn = qs(wrap as unknown as ShimNode, '[data-dp="keys.button.apply"]') as unknown as { disabled: boolean; textContent: string } | null;
    if (input && btn) {
      input.value = "a-real-token";
      const before = departures;
      click(btn as unknown as never);
      ok("token-apply/401: the control goes busy on the way in", btn.disabled === true && isPending(btn.textContent ?? ""));
      await flushAsync();
      await flushAsync();
      ok("token-apply/401: after the 401 the control is pressable again", btn.disabled === false);
      ok(`token-apply/401: and off the busy label (now "${btn.textContent}")`, !isPending(btn.textContent ?? ""));
      ok("token-apply/401: goSignedOut() still ran", departures > before);
    } else {
      ok("token-apply/401: the token field and Apply control are reachable", false);
    }
  }

  // =================================================================================================
  console.log("\n5. The CONTROL CASE: a handler that paints correctly must stay green");
  // =================================================================================================
  // Without this, every assertion above could be satisfied by a file that is simply always unhappy. The
  // same read, answered SUCCESSFULLY, must leave the loaded state and must NOT report a session ending.
  {
    const { renderHistoryPanel } = await import("../src/screens/notifications/history.ts");
    const { engine } = stub({ listNotifyHistory: [[]] });
    const before = departures;
    const region = renderHistoryPanel(engine);
    markConnected(region as unknown as never);
    ok("control: the region is seeded with a wait", hasSkeleton(region));
    await flushAsync();
    await flushAsync();
    const text = textOf(region as unknown as never);
    ok("control: the wait is replaced on SUCCESS too", !hasSkeleton(region));
    ok("control: with the loaded state, not a session-ended sentence", !/your session ended/i.test(text));
    ok("control: and no retry control, because nothing failed", qs(region as unknown as ShimNode, RETRY) === null);
    ok("control: and NOTHING departed", departures === before);
  }
  {
    const { renderTokenApply } = await import("../src/screens/keys/shared.ts");
    owner();
    let applied = 0;
    const wrap = renderTokenApply({
      tokenPurpose: "run the fixture apply",
      applyLabel: "Apply the key",
      busyLabel: "Applying the key",
      doneLabel: "Applied",
      apply: async () => { applied++; },
    });
    markConnected(wrap as unknown as never);
    const input = qs(wrap as unknown as ShimNode, '[data-dp="keys.password.token"]') as unknown as { value: string } | null;
    const btn = qs(wrap as unknown as ShimNode, '[data-dp="keys.button.apply"]') as unknown as { disabled: boolean; textContent: string } | null;
    if (input && btn) {
      input.value = "a-real-token";
      const before = departures;
      click(btn as unknown as never);
      await flushAsync();
      await flushAsync();
      ok("control: the apply ran", applied === 1);
      ok(`control: the label settles on the DONE label (now "${btn.textContent}")`, !isPending(btn.textContent ?? ""));
      ok("control: and nothing departed", departures === before);
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL: ${failures} check(s) failed`}`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

await main();
