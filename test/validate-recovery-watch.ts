// Regression cover: THE CONSOLE MUST NOTICE A LATCH RAISED WHILE THE TAB IS OPEN.
//
// The defect this pins (recorded, reproduced live, and reproduced again here in real
// Chromium against the committed bundle): the engine raises recoveryRequired OUT OF BAND, from its */15 cron
// amnesia pass, at a moment no console tab is party to. The console read the latch EXACTLY ONCE, at boot,
// from inside the identity resolve, and never again for the life of the page. So a tab that booted while the
// plane was healthy kept that answer for as long as it stayed open: the banner host present and EMPTY (the
// healthy read's own clear), no danger banner, no notice at all, and the operator sitting on an Overview
// headed "Your console is set up" while scheduled backups had stopped. Neither an in-app navigation nor a
// same-URL revisit is a page load, so nothing in the tab could ever correct it.
//
// This drives the REAL lib/recovery-watch.ts (no copy of the boot wiring: copying it is exactly why the
// single-sample bug lived under a green suite) over the REAL EngineClient and the REAL updateRecoveryBanner,
// with the clock, the timer and the focus seam injected. It asserts:
//
//   1. a healthy plane is SILENT (a banner that always shows is not a fix),
//   2. a latch raised AFTER the first read raises the DANGER banner on the watch's next poll, named by its
//      exact title and its break-glass action, with NO reload,
//   3. the FOCUS leg does the same for an operator returning to the tab,
//   4. a confirmed healthy read afterwards takes the banner back down (no stuck banner),
//   5. the watch does not depend on identity: it raises the banner even when whoami is failing, which is the
//      state a wiped plane puts identity resolution in,
//   6. THE WIPED-PLANE SIGN-IN: a status read that 401s because the caller had no credential yet is re-taken
//      the instant the caller resolves, without a page load and without waiting out the poll interval.
//
// WHY 6 IS SEPARATE FROM 2 AND 3, and why the suite was green while the live cell said DETECT. Legs 2 and 3
// both start from a read that SUCCEEDED and only the plane changed underneath it. On the state this whole
// feature exists for, the first read does not succeed: a SchedulerDO wipe destroys the role table, so the
// operator is signed out BY THE WIPE, GET /admin/control-plane/status answers 401, and 401 is the SILENT
// class. The operator then signs in, which is an SPA handoff and never a page load, so nothing re-armed the
// watch. In real Chromium: one status read at t+0.1s (401), none for the
// next 45s while whoami re-resolved to owner at t+4.1s, and the
// danger banner 116 SECONDS after the read became possible, with the console's own same-origin read
// reporting recoveryRequired=true throughout. This case drives the REAL lib/caller-state.ts setCaller, the
// same function app.ts's resolveIdentity calls, so it fails if the wiring is removed at either end.
//
// Run with: node test/validate-recovery-watch.ts

import { installDomShim, flushAsync } from "./dom-shim.ts";
installDomShim();

import { EngineClient } from "../src/api.ts";
import { _resetRecoveryLatch } from "../src/components/recovery-banner.ts";
import { resetCallerState, setCaller } from "../src/lib/caller-state.ts";
import { RECOVERY_BANNER_TITLE } from "../src/lib/control-plane-recovery.ts";
import { RECOVERY_FOCUS_FLOOR_MS, RECOVERY_POLL_MS, _resetRecoveryWatch, startRecoveryWatch } from "../src/lib/recovery-watch.ts";
import type { Caller } from "../src/lib/api/types/who.ts";
import type { ControlPlaneStatus } from "../src/lib/api/types/control-plane.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const HOST_ID = "cp-recovery-banner-host";
const ACTION_LABEL = "Recover the control plane";

function host(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}
function dangerCount(): number {
  const h = host();
  return h ? h.querySelectorAll(".banner--danger").length : -1;
}
function hostText(): string {
  return host()?.textContent ?? "";
}
function childCount(): number {
  const h = host();
  return h ? h.childElementCount : -1;
}
// bannerRenders is the assertion the live cell makes: the DANGER banner is there AND it names the condition
// AND it carries the break-glass action. "Some element exists" is not the property.
function bannerRenders(): boolean {
  return dangerCount() === 1 && hostText().includes(RECOVERY_BANNER_TITLE) && hostText().includes(ACTION_LABEL);
}
function freshHost(): void {
  _resetRecoveryLatch();
  _resetRecoveryWatch();
  host()?.remove();
}

// The engine's GET /admin/control-plane/status bodies. The latched body is the real wiped-plane shape the
// live drive produced.
const LATCHED: ControlPlaneStatus = {
  recoveryRequired: true,
  reason: "the control plane is empty but the destination bucket still holds the account-global _RECOVERY/RUNLOG marker",
  configEmpty: true,
};
const HEALTHY: ControlPlaneStatus = { recoveryRequired: false, reason: null, configEmpty: false };

// The stubbed engine surface: `plane` is what the engine currently reports (flipped mid-test exactly as the
// cron latches it live), `whoamiFails` makes the identity read throw, and statusReads counts what the WATCH
// asked for (never what the test asked for), so "it polled again" is a measured fact.
let plane: ControlPlaneStatus = HEALTHY;
let whoamiFails = false;
let statusReads = 0;
// statusUnauthorised makes the status route answer 401, which is what a wiped plane answers a caller who has
// not signed in yet: the role table went with the DO, so there is nobody to be until they do.
let statusUnauthorised = false;

// The two callers the sign-in case resolves. OWNER is what whoami reports once the operator signs in;
// OWNER_AGAIN is a byte-identical re-resolve (a later refreshIdentity) built as a SEPARATE object, so the
// "same authority does not re-read" assertion tests a value comparison and not a reference one.
const OWNER: Caller = { method: "passkey", subject: "iss|sub-1", email: "owner@example.test", role: "owner", groups: [], isOnlyOwner: true };
const OWNER_AGAIN: Caller = { method: "passkey", subject: "iss|sub-1", email: "owner@example.test", role: "owner", groups: [], isOnlyOwner: true };

// A hand-driven clock + timer + focus seam, so a two-minute interval is exercised in milliseconds and the
// coalesce floor is a fact rather than a wait.
let clock = 1_000_000;
let intervalFn: (() => void) | null = null;
let intervalMs = 0;
let focusFn: (() => void) | null = null;
let hidden = false;

function makeDeps(): Parameters<typeof startRecoveryWatch>[0] {
  const engine = new EngineClient("https://console.test");
  return {
    engine: () => engine,
    onReconciled: () => {},
    now: () => clock,
    setTimer: (fn, ms) => {
      intervalFn = fn;
      intervalMs = ms;
    },
    onFocus: (fn) => {
      focusFn = fn;
    },
    isHidden: () => hidden,
  };
}

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/admin/whoami")) {
      return whoamiFails ? new Response("upstream error", { status: 500 }) : new Response(JSON.stringify({ role: "owner" }), { status: 200 });
    }
    if (url.includes("/admin/control-plane/status")) {
      statusReads++;
      if (statusUnauthorised) return new Response("unauthorised", { status: 401 });
      return new Response(JSON.stringify(plane), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // ---- 1. Boot on a HEALTHY plane: the watch runs, and says nothing. ----
    console.log("\n-- a healthy plane is silent (the discriminating control) --");
    freshHost();
    plane = HEALTHY;
    statusReads = 0;
    startRecoveryWatch(makeDeps());
    await flushAsync();
    ok("the watch read the status once at boot", statusReads === 1);
    ok("a healthy plane renders no danger banner", dangerCount() === 0);
    ok("a healthy plane renders nothing at all", childCount() === 0);
    ok("the watch armed a bounded re-poll", intervalFn !== null && intervalMs === RECOVERY_POLL_MS);
    // The line above proves the watch armed AN interval, not that it armed a sensible one: the arming
    // and the expectation read the same constant. Every later step then advances the fake clock by the
    // same constant, so the period cancels a second time. At RECOVERY_POLL_MS = 24 hours the watch
    // would still arm, still fire on the step below, and still pass, while an operator sat in front of
    // a latched plane for a day. Two minutes is the figure the comment on the constant argues for.
    ok("RECOVERY_POLL_MS is two minutes", RECOVERY_POLL_MS === 120_000);

    // ---- 2. THE DEFECT: the cron latches while the tab is open. No reload, no navigation, no new identity
    // resolve. The watch's next poll MUST raise the danger banner. Before the fix the console never asked
    // again, so this stayed the empty host of the healthy read: a false all-clear over stopped backups. ----
    console.log("\n-- a latch raised while the tab is open is surfaced by the next poll --");
    plane = LATCHED;
    clock += RECOVERY_POLL_MS;
    intervalFn?.();
    await flushAsync();
    ok("the watch re-read the status without a page load", statusReads === 2);
    ok(`the danger banner renders, named "${RECOVERY_BANNER_TITLE}", with its break-glass action`, bannerRenders());
    ok("the banner carries the engine's redaction-safe reason", hostText().includes("_RECOVERY/RUNLOG"));

    // ---- 3. A hidden tab does not poll (no operator to tell), and the FOCUS return does. ----
    console.log("\n-- a hidden tab stays quiet; the return to the tab re-reads --");
    freshHost();
    plane = HEALTHY;
    statusReads = 0;
    startRecoveryWatch(makeDeps());
    await flushAsync();
    hidden = true;
    clock += RECOVERY_POLL_MS;
    intervalFn?.();
    await flushAsync();
    ok("a backgrounded tab does not poll", statusReads === 1);
    hidden = false;
    plane = LATCHED;
    clock += RECOVERY_FOCUS_FLOOR_MS;
    focusFn?.();
    await flushAsync();
    ok("returning to the tab re-reads the latch", statusReads === 2);
    ok("and raises the danger banner on the focus leg", bannerRenders());

    // A second focus inside the floor must NOT drive another read (no read-per-flick).
    const before = statusReads;
    focusFn?.();
    await flushAsync();
    ok("a focus inside the coalesce floor does not re-read", statusReads === before);

    // ---- 4. A confirmed healthy read afterwards takes it down: no stuck banner. ----
    console.log("\n-- a confirmed healthy read takes the banner back down --");
    plane = HEALTHY;
    clock += RECOVERY_POLL_MS;
    intervalFn?.();
    await flushAsync();
    ok("the danger banner clears once the plane reports healthy again", dangerCount() === 0);
    ok("nothing is left in the host on a confirmed healthy plane", childCount() === 0);

    // ---- 5. IDENTITY INDEPENDENCE: the watch raises the banner while whoami is failing. A wiped plane is
    // exactly where identity resolution is under stress (the role table is empty), and the banner used to sit
    // behind a successful whoami in the same try, so an identity read that faulted took it with it. ----
    console.log("\n-- a failing whoami does not silence the banner --");
    freshHost();
    plane = LATCHED;
    whoamiFails = true;
    statusReads = 0;
    startRecoveryWatch(makeDeps());
    await flushAsync();
    ok("the watch read the status even though whoami is failing", statusReads === 1);
    ok("the danger banner renders with a failing whoami", bannerRenders());
    whoamiFails = false;

    // ---- 6. THE WIPED-PLANE SIGN-IN. The wipe took the role table, so the operator arrives signed out and
    // the status read is 401: the deliberately SILENT class (a standing notice on the ordinary signed-out
    // path would cry wolf). They then sign in, which is an SPA handoff, never a page load. The latch must be
    // re-read AT THAT MOMENT. Before the authority leg the console waited out the poll interval instead, and
    // an operator whose backups had stopped was shown a clean console for two minutes on the one flow this
    // banner exists for. ----
    console.log("\n-- a caller who signs in after the wipe is not made to wait out the poll interval --");
    freshHost();
    resetCallerState();
    plane = LATCHED;
    statusUnauthorised = true;
    statusReads = 0;
    startRecoveryWatch(makeDeps());
    await flushAsync();
    ok("the signed-out boot read the status once", statusReads === 1);
    ok("a 401 on the status read raises no banner (never a standing notice on the signed-out path)", dangerCount() === 0);
    ok("and leaves nothing in the host, which is the shape the live cell recorded", childCount() === 0);

    // The operator signs in. This is the REAL caller-state entry app.ts's resolveIdentity calls; no clock
    // advance, no focus event and no interval tick happen here, so ONLY the authority leg can drive a read.
    statusUnauthorised = false;
    setCaller(OWNER);
    await flushAsync();
    ok("the resolved caller re-read the latch with no page load, no focus and no interval tick", statusReads === 2);
    ok(`the danger banner renders on the sign-in, named "${RECOVERY_BANNER_TITLE}"`, bannerRenders());

    // A later refresh that resolves the SAME operator must not turn the leg into a per-refresh read.
    const afterSignIn = statusReads;
    setCaller(OWNER_AGAIN);
    await flushAsync();
    ok("a refresh resolving the same authority does not drive another read", statusReads === afterSignIn);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    statusUnauthorised = false;
    resetCallerState();
    _resetRecoveryLatch();
    _resetRecoveryWatch();
  }

  console.log(failures === 0 ? "\nRECOVERY-WATCH VECTORS PASS" : `\n${failures} FAILURE(S): the recovery danger banner "${RECOVERY_BANNER_TITLE}" did not stand up`);
  if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-RECOVERY-WATCH THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
