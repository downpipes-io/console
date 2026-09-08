// An established account in recovery must be offered an exit its own engine will
// ACCEPT. Run with: node test/validate-latch-exit.ts
//
// THE DEFECT. The recovery latch has three exits and
// they are guarded as EXACT COMPLEMENTS:
//
//   POST /control-plane/restore       (reconcile)     reconcileControlPlane refuses unless the plane IS empty
//                                                     AND the role table IS empty
//   POST /control-plane/apply-staged  (confirm)       applyControlPlaneAuthoritySlice refuses unless the latch
//                                                     is set, an export is staged, and the role table IS empty
//   POST /control-plane/acknowledge-recovery          acknowledgeControlPlaneRecovery refuses unless the latch
//                                                     is set and the role table is NOT empty
//
// All three live in engine/src/sched/scheduler-do-control-plane.ts. They are cited BY METHOD and by the
// condition each refuses, not by line: this file cannot import the engine, so a line number here is a copy
// that rots silently on the next engine edit, and three figures were carried wrong into a brief on the day
// this defect was filed for exactly that reason.
//
// The console called the first two and never the third: enumerating the control-plane routes named anywhere
// in console/src returned nine, and no acknowledge. The last-Owner guard (requireNotLastOwner) makes a
// non-empty role table the norm, so on EVERY ESTABLISHED ACCOUNT both offered routes had to refuse, and the
// engine's own 409 then said "run the manual control-plane reconcile instead" -- naming the sibling route
// that refuses them too. A live estate with two role rows was answered exactly that.
//
// WHAT THIS FILE PINS, and why it is one property rather than a list of screens. The invariant is:
//
//   FOR EVERY reachable (roleTableEmpty, configEmpty) state, if the banner offers an action at all, the
//   engine guard behind that action MUST be able to pass in that state; and if it offers none, the copy MUST
//   name the route that does open the way.
//
// That is the property whose violation IS the defect, so a future change that re-offers a break-glass route
// to an estate with surviving authority reddens here rather than reaching a customer. The engine guards are
// MODELLED below rather than imported, because the console cannot import the engine. The model is three
// one-line predicates so it can be checked against those three methods by eye, and the guards themselves are
// the engine's own to cover.
//
// PROVEN BY MUTATION rather than by reading: re-planting the pre-repair action selection (confirm-if-staged,
// else reconcile, with no exit discriminant) reddens the complement property and the three render cases,
// while a semantically neutral edit to the same function leaves every case green.

import { flushAsync, installDomShim } from "./dom-shim.ts";

installDomShim();

import { EngineClient } from "../src/api.ts";
import {
  _resetRecoveryLatch,
  _testRunAcknowledge,
  ACKNOWLEDGE_LABEL,
  ACKNOWLEDGE_UNWIRED,
  updateRecoveryBanner,
} from "../src/components/recovery-banner.ts";
import type { ControlPlaneStagedSummary, ControlPlaneStatus } from "../src/lib/api/types/control-plane.ts";
import {
  RECOVERY_AWAIT_CONFIG_BODY,
  RECOVERY_BANNER_BODY,
  RECOVERY_GRANT_ROLE_BODY,
  RECOVERY_RECOVERED_TITLE,
  type RecoveryExit,
  recoveryBannerModel,
} from "../src/lib/control-plane-recovery.ts";
import { capabilityPhrase } from "../src/screens/capability-copy.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const HOST_ID = "cp-recovery-banner-host";
function hostEl(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}
function bannerText(): string {
  return hostEl()?.textContent ?? "";
}
function actionLabel(): string | null {
  const btn = hostEl()?.querySelector(".banner__action");
  return btn ? (btn.textContent ?? null) : null;
}
function freshHost(): void {
  _resetRecoveryLatch();
  hostEl()?.remove();
}

const STAGED: ControlPlaneStagedSummary = {
  sourceKey: "_RECOVERY/CONTROL-PLANE/7-2026-08-01.sealed.json",
  version: 7,
  stagedAt: "2026-08-01T00:00:00.000Z",
  downpipes: 5,
  resumeApplied: true,
};

// statusFor builds the engine's own status body for a state. roleTableEmpty is left ABSENT (not false) for
// the unknown rows, which is what an engine predating the field answers.
function statusFor(roleTableEmpty: boolean | null, configEmpty: boolean | null, staged: boolean): ControlPlaneStatus {
  return {
    recoveryRequired: true,
    reason: "the control plane is empty but the destination bucket still holds backups",
    ...(configEmpty === null ? {} : { configEmpty }),
    ...(roleTableEmpty === null ? {} : { roleTableEmpty }),
    ...(staged ? { staged: STAGED } : {}),
  } as ControlPlaneStatus;
}

// ---- THE ENGINE'S GUARDS, MODELLED FROM SOURCE -------------------------------------------------------------
// One entry per BUTTON LABEL an operator can actually be shown. Each returns whether the engine would let that
// call through in this state. Read these against the engine methods before changing them: a wrong model here
// would make this whole test agree with a broken console.
//
// KEYED ON THE LABEL, NOT ON model.exit, AND THAT IS LOAD-BEARING. Keying on the exit asks "is the guard for
// the route the model INTENDED passable", which stays true when the render then draws a different button, so
// the first draft of this file PASSED the planted defect on the two organic-resume states, which are the
// states the defect is about. The operator presses a label, so the label is what has to be checked.
const GUARD_CAN_PASS: Readonly<Record<string, (roleTableEmpty: boolean | null, configEmpty: boolean | null, staged: boolean) => boolean>> = {
  // reconcileControlPlane: refuses a non-empty plane, then a non-empty role table.
  "Recover the control plane": (roleTableEmpty, configEmpty) => configEmpty !== false && roleTableEmpty !== false,
  // applyControlPlaneAuthoritySlice: needs the latch set, a staged export, and an empty role table.
  "Confirm and restore access": (roleTableEmpty, _configEmpty, staged) => staged && roleTableEmpty !== false,
  // acknowledgeControlPlaneRecovery: needs the latch set and a NON-empty role table.
  [ACKNOWLEDGE_LABEL]: (roleTableEmpty) => roleTableEmpty !== true,
};
// The two exits that deliberately offer NO action. Each must instead NAME the way out in its own copy.
const NO_ACTION_EXITS = new Set<RecoveryExit>(["await-config", "grant-role-first"]);

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  try {
    // ---- 1. THE COMPLEMENT PROPERTY over every reachable state -------------------------------------------
    // This is the case that reddens when the defect is re-planted. It drives the REAL banner render, reads
    // the button an operator would actually see, and asks the engine's own guard whether that button could
    // have worked.
    console.log("\n-- every action the banner offers is one the engine guard can pass --");
    const states: Array<{ roleTableEmpty: boolean | null; configEmpty: boolean | null; staged: boolean }> = [];
    for (const roleTableEmpty of [true, false, null] as Array<boolean | null>) {
      for (const configEmpty of [true, false, null] as Array<boolean | null>) {
        for (const staged of [true, false]) states.push({ roleTableEmpty, configEmpty, staged });
      }
    }
    for (const s of states) {
      const name = `roleTableEmpty=${String(s.roleTableEmpty)} configEmpty=${String(s.configEmpty)} staged=${String(s.staged)}`;
      freshHost();
      const status = statusFor(s.roleTableEmpty, s.configEmpty, s.staged);
      const model = recoveryBannerModel(status);
      updateRecoveryBanner(status, {
        reconcile: () => Promise.reject(new Error("not called")),
        applyStaged: () => Promise.reject(new Error("not called")),
        acknowledge: () => Promise.resolve({ ok: true, acknowledged: true }),
      }, "ok");
      await flushAsync();
      const label = actionLabel();
      if (label !== null) {
        const canPass = GUARD_CAN_PASS[label];
        ok(
          `${name}: offers "${label}" (exit ${model.exit}) and THAT route's guard can pass`,
          canPass?.(s.roleTableEmpty, s.configEmpty, s.staged) === true,
        );
      } else {
        // No action offered. That is only honest if the copy names the route that IS open.
        ok(
          `${name}: offers no action (exit ${model.exit}) and names the acknowledge in its copy`,
          NO_ACTION_EXITS.has(model.exit) && /[Aa]cknowledge/.test(bannerText()),
        );
      }
    }

    // ---- 2. THE ORGANIC-RESUME CASE, which is what defect 23 was ------------------------------------------
    // An established account (role table not empty) whose plane came back. Before this repair the banner
    // offered "Recover the control plane" here, and that route refuses a non-empty role table.
    console.log("\n-- the organic-resume case: the plane is back and authority survived --");
    freshHost();
    const resumed = statusFor(false, false, false);
    updateRecoveryBanner(resumed, {
      reconcile: () => Promise.reject(new Error("not called")),
      applyStaged: () => Promise.reject(new Error("not called")),
      acknowledge: () => Promise.resolve({ ok: true, acknowledged: true }),
    }, "ok");
    await flushAsync();
    ok("the model resolves the acknowledge exit", recoveryBannerModel(resumed).exit === "acknowledge");
    ok(`the banner offers "${ACKNOWLEDGE_LABEL}"`, actionLabel() === ACKNOWLEDGE_LABEL);
    ok("it does NOT offer the break-glass rebuild that must refuse this estate", actionLabel() !== "Recover the control plane");
    ok("it stops asserting that scheduled backups have stopped", !bannerText().includes("scheduled backups have stopped"));
    ok("it says the configuration is back", bannerText().includes("configuration is back"));
    ok("and it retitles rather than re-tones the same claim", bannerText().includes(RECOVERY_RECOVERED_TITLE));
    ok("it is toned as a standing warning, not a disaster", (hostEl()?.querySelectorAll(".banner--warn").length ?? 0) === 1);
    ok("the engine's own reason still rides on the banner", bannerText().includes("destination bucket still holds backups"));

    // A caller that never wired the acknowledge must SAY so rather than render a dead button or a bare wall.
    freshHost();
    updateRecoveryBanner(resumed, { reconcile: () => Promise.reject(new Error("not called")) }, "ok");
    await flushAsync();
    ok("an unwired console renders no dead button", actionLabel() === null);
    ok("and explains why, naming what does still work", bannerText().includes(ACKNOWLEDGE_UNWIRED));

    // ---- 3. THE TWO NO-ACTION STATES name a path rather than a wall --------------------------------------
    console.log("\n-- the two states with no console action name the path that is open --");
    freshHost();
    const awaitConfig = statusFor(false, true, true);
    updateRecoveryBanner(awaitConfig, {
      reconcile: () => Promise.reject(new Error("not called")),
      applyStaged: () => Promise.reject(new Error("not called")),
      acknowledge: () => Promise.resolve({ ok: true, acknowledged: true }),
    }, "ok");
    await flushAsync();
    ok("authority survived over an empty plane resolves await-config", recoveryBannerModel(awaitConfig).exit === "await-config");
    ok("it offers no button, because every rebuild route refuses surviving authority", actionLabel() === null);
    ok("it names the health pass and the acknowledge", bannerText().includes(RECOVERY_AWAIT_CONFIG_BODY));
    ok("it does NOT offer the staged confirm, which refuses a non-empty role table", actionLabel() !== "Confirm and restore access");

    freshHost();
    const grantFirst = statusFor(true, false, false);
    updateRecoveryBanner(grantFirst, {
      reconcile: () => Promise.reject(new Error("not called")),
      acknowledge: () => Promise.resolve({ ok: true, acknowledged: true }),
    }, "ok");
    await flushAsync();
    ok("an empty role table over a live plane resolves grant-role-first", recoveryBannerModel(grantFirst).exit === "grant-role-first");
    ok("it offers no button: reconcile refuses a live plane, acknowledge an empty table", actionLabel() === null);
    ok("it names the break-glass role grant as the way out", bannerText().includes(RECOVERY_GRANT_ROLE_BODY));

    // ---- 4. THE GENUINE WIPE IS UNCHANGED, which is the restraint half ------------------------------------
    // Nothing here widens a guard or takes an exit away from the estate it was built for.
    console.log("\n-- a genuinely wiped plane keeps exactly the behaviour it had --");
    freshHost();
    const wiped = statusFor(true, true, false);
    updateRecoveryBanner(wiped, { reconcile: () => Promise.reject(new Error("not called")), acknowledge: () => Promise.resolve({ ok: true }) }, "ok");
    await flushAsync();
    ok("a wiped plane with nothing staged still offers the manual reconcile", actionLabel() === "Recover the control plane");
    ok("and keeps the original standing copy verbatim", bannerText().includes(RECOVERY_BANNER_BODY));
    ok("and is still toned danger", (hostEl()?.querySelectorAll(".banner--danger").length ?? 0) === 1);

    freshHost();
    const wipedStaged = statusFor(true, true, true);
    updateRecoveryBanner(wipedStaged, {
      reconcile: () => Promise.reject(new Error("not called")),
      applyStaged: () => Promise.resolve({ ok: true, roles: 3, bridgedFrom: { headSeq: 1, headHash: "h" } }),
    }, "ok");
    await flushAsync();
    ok("a wiped plane with a staged export still offers the break-glass confirm", actionLabel() === "Confirm and restore access");

    // An engine that predates roleTableEmpty must degrade, never assert the wrong half.
    freshHost();
    const legacyEmpty = statusFor(null, true, false);
    ok("an engine with no roleTableEmpty over an empty plane is unchanged (reconcile)", recoveryBannerModel(legacyEmpty).exit === "reconcile");
    const legacyBack = statusFor(null, false, false);
    ok("an engine with no roleTableEmpty over a plane that came back offers the acknowledge", recoveryBannerModel(legacyBack).exit === "acknowledge");

    // ---- 5. THE CALL ITSELF: no token, no artefact, and one route --------------------------------------
    console.log("\n-- controlPlaneAcknowledgeRecovery (fetch-stubbed) --");
    let seenUrl = "";
    let seenMethod = "";
    let seenAuth: string | null = "unset";
    let nextResponse: () => Response = () => new Response(JSON.stringify({ ok: true, acknowledged: true }), { status: 200 });
    (globalThis as { fetch: unknown }).fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = String(init?.method ?? "GET");
      const hdrs = new Headers((init?.headers ?? {}) as HeadersInit);
      seenAuth = hdrs.get("authorization");
      return nextResponse();
    }) as typeof fetch;
    const engine = new EngineClient("https://console.test");
    const acked = await engine.controlPlaneAcknowledgeRecovery();
    ok("it POSTs to /admin/control-plane/acknowledge-recovery", seenUrl.endsWith("/admin/control-plane/acknowledge-recovery") && seenMethod === "POST");
    ok("it sends NO Authorization header: this route refuses the break-glass token by design", seenAuth === null);
    ok("it returns the acknowledged result", acked.acknowledged === true);

    // The two engine refusal classes reach their own codes rather than coalescing into DP-R12.
    nextResponse = () => new Response(JSON.stringify({ error: "the role table is empty", refusalClass: "ack-role-table-empty" }), { status: 400 });
    let msg = "";
    try { await engine.controlPlaneAcknowledgeRecovery(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    ok("an empty role table reaches DP-R31, not the verification code DP-R12", msg.includes("DP-R31"));
    nextResponse = () => new Response(JSON.stringify({ error: "no recovery in effect", refusalClass: "ack-no-latch" }), { status: 400 });
    msg = "";
    try { await engine.controlPlaneAcknowledgeRecovery(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    ok("a latch already cleared reaches DP-R32", msg.includes("DP-R32"));
    nextResponse = () => new Response("forbidden", { status: 403 });
    msg = "";
    try { await engine.controlPlaneAcknowledgeRecovery(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    ok("a 403 reaches DP-R33, not DP-R11 (which says 'not an Owner', wrong in both directions here)", msg.includes("DP-R33"));
    // the sentence must carry the capability PHRASE, never the raw id, and the role by its display
    // label. Pinned here because the raw-id version passed this assertion and failed capability-copy-gate.
    ok("and the 403 message names the capability, in the phrase a customer can read", msg.includes(capabilityPhrase("access.policy")));
    ok("and it carries no raw capability id and no raw built-in role id", !msg.includes("access.policy") && !msg.includes("access-admin"));

    // ---- 6. THE SUBMIT PIPELINE -------------------------------------------------------------------------
    console.log("\n-- the acknowledge submit pipeline --");
    let notified = "";
    let acknowledgedCallbacks = 0;
    let calls = 0;
    let formError = "";
    const closed = await _testRunAcknowledge(
      {
        reconcile: () => Promise.reject(new Error("not called")),
        acknowledge: () => { calls++; return Promise.resolve({ ok: true, acknowledged: true }); },
        notify: (m) => { notified = m; },
        onAcknowledged: () => { acknowledgedCallbacks++; },
      },
      (m) => { formError = m; },
    );
    ok("a successful acknowledge closes the modal", closed === true);
    ok("it calls the route exactly once", calls === 1);
    ok("it notifies, and the copy claims no restore", notified.includes("Nothing else changed") && !notified.includes("role(s) restored"));
    ok("onAcknowledged fires", acknowledgedCallbacks === 1);
    ok("no form error on the happy path", formError === "");

    const keptOpen = await _testRunAcknowledge(
      { reconcile: () => Promise.reject(new Error("x")), acknowledge: () => Promise.reject(new Error("the role table is empty (DP-R31)")) },
      (m) => { formError = m; },
    );
    ok("an engine refusal keeps the modal open", keptOpen === false);
    ok("and the engine's refusal is what the operator reads", formError.includes("DP-R31"));

    formError = "";
    const unwired = await _testRunAcknowledge({ reconcile: () => Promise.reject(new Error("x")) }, (m) => { formError = m; });
    ok("a missing collaborator keeps the modal open, never throws", unwired === false);
    ok("and says so honestly", formError === ACKNOWLEDGE_UNWIRED);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    _resetRecoveryLatch();
  }

  console.log(failures === 0 ? "\nLATCH-EXIT VECTORS PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-LATCH-EXIT THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
