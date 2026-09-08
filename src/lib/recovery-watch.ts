// INFRA-1 recovery WATCH: the standing poll behind the control-plane recovery banner.
//
// THE DEFECT THIS EXISTS TO KILL (G-P0-096, recorded, reproduced). The recovery latch
// is a STANDING condition that the engine raises OUT OF BAND: the */15 cron health pass detects amnesia (the
// control plane is empty but the destination bucket still holds the account-global _RECOVERY/RUNLOG marker)
// and latches recoveryRequired, at a moment no console tab is party to. The console, however, read the latch
// EXACTLY ONCE, from inside the boot-time identity resolve, and never again for the life of the page. So a
// tab that booted while the plane was healthy kept the answer it took then: the banner host present and
// EMPTY (the healthy read's own clear), no danger banner, no notice of any kind, and the operator sitting on
// an Overview headed "Your console is set up" while scheduled backups had stopped. That is the exact false
// all-clear the banner exists to prevent, produced by the banner's own plumbing.
//
// It is worse than a stale render, because nothing in the tab could ever correct it: the console re-read the
// status only on a whole-page load, and neither an in-app navigation nor a same-URL revisit is one. The
// operator's console was, in the state it is most important, permanently and silently wrong.
//
// So the check is a WATCH, not a sample:
//   - it runs at boot, INDEPENDENT of identity (a whoami that faults for any reason -- a lapsed session, a
//     5xx, an older engine that does not serve the route -- must not be able to suppress the one banner that
//     says backups have stopped; it used to, because the call sat after the whoami await in the same try),
//   - it re-polls on a bounded interval for the life of the page, so a latch raised while the tab is open is
//     surfaced within one interval rather than never,
//   - it re-polls when the tab regains FOCUS (coalesced), the natural "what happened while I was away?"
//     moment the console already uses for the setup and credential reads,
//   - it re-polls the instant the console's AUTHORITY CHANGES (see the leg below),
//   - a hidden tab does not poll: the focus leg covers the return, and a backgrounded tab has no operator
//     to tell.
//
// THE AUTHORITY LEG, and why the three above were not enough. This read is not identity-independent in the
// way the boot leg is identity-independent: the check may RUN without identity, but GET
// /admin/control-plane/status answers 401 to a caller with no credential, and 401 is mapped below to the
// deliberately SILENT class. Now consider the only state this whole feature exists for. A SchedulerDO wipe
// destroys the ROLE TABLE, so the operator arriving at a wiped plane is signed out BY THE WIPE: the console
// boots, the one status read 401s, the banner stays silent, and the operator is shown the sign-in screen and
// nothing else. They then sign in -- and a passkey sign-in is an SPA handoff (app.ts buildNavBridge
// onAuthenticated: navigate plus re-resolve identity), never a page load, so NOTHING re-armed the watch. The
// interval leg is next due up to two minutes later and the focus leg is floored at thirty seconds from the
// boot read, so the console that has just learned who the operator is does not re-ask the one question whose
// answer is "your backups have stopped". The status read can be taken once at
// t+0.1s (401) and not again for the whole window; the danger banner can then appear 116 seconds after the read
// becomes possible, on a plane the console's own same-origin read reports recoveryRequired=true throughout.
// A forty-second look at that console sees a healthy-looking Overview, which is precisely the live DETECT the
// bug register carries.
//
// So the watch subscribes to the CHANGE OF AUTHORITY itself, at lib/caller-state.ts's setCaller, which is the
// single leaf every identity resolve in the console passes through (the boot resolve, the sign-in handoff, a
// screen's refreshIdentity(), the bfcache pageshow re-resolve, sign-out). Wiring it there rather than at the
// sign-in call site is deliberate: a future entry point that resolves identity gets the re-read for free, and
// the one that does not exist yet is the one that would otherwise reopen this gap. The leg is NOT floored --
// authority changes are operator actions, not a poll, and a floor is exactly what swallowed the moment that
// matters. It is an ADDITION: the boot leg still runs before and independently of identity, so a whoami that
// never resolves still cannot suppress the banner.
//
// Fail-open and never alarmist: the banner is raised ONLY on a CONFIRMED recoveryRequired=true read. The
// latch in components/recovery-banner.ts owns what a failed / route-absent / not-permitted read may do (in
// short: never lower a raised banner, never claim an all-clear). No customer value is read here; the status
// carries three booleans and a redaction-safe reason.

import type { EngineClient } from "../api.ts";
import { updateRecoveryBanner } from "../components/recovery-banner.ts";
import { onCallerChanged } from "./caller-state.ts";
import { recordReadDegraded } from "./client-diag/ring.ts";
import { classifyError } from "./errors.ts";

// RECOVERY_POLL_MS is how often an open tab re-reads the latch. The engine's own amnesia detection runs on a
// */15 cron, so the latch can only appear on that boundary; two minutes bounds the operator's ignorance well
// inside it while costing one small authenticated GET per tab per two minutes. It is deliberately NOT tied to
// the cron period: the console must not assume the engine's schedule.
export const RECOVERY_POLL_MS = 120_000;

// RECOVERY_FOCUS_FLOOR_MS coalesces the focus-driven re-check so an operator flicking between windows cannot
// drive a read per flick. Short, because a return to the tab is exactly when a fresh answer is worth having.
export const RECOVERY_FOCUS_FLOOR_MS = 30_000;

// RecoveryWatchDeps are the collaborators, injected so the validator drives the REAL watch with no network,
// no timers and no DOM chrome:
//   engine        the CURRENT engine client (read at call time, never captured: the store re-points it), or
//                 null when the console is not connected, in which case there is nothing to read.
//   onReconciled  what to do after a successful break-glass reconcile OR a successful auto-heal CONFIRM
//                 (both restore authority, so both re-resolve identity the same way; neither result
//                 shape is read here, only the fact that one of them succeeded).
//   now/setTimer/onFocus/isHidden  the clock, the timer and the focus/visibility seams.
//   onAuthorityChange             the "the resolved caller changed" seam, defaulting to the real
//                                 caller-state subscription. Injected so the validator drives the leg
//                                 without a whole identity resolve.
export interface RecoveryWatchDeps {
  engine: () => EngineClient | null;
  onReconciled: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
  onFocus?: (fn: () => void) => void;
  isHidden?: () => boolean;
  onAuthorityChange?: (fn: () => void) => () => void;
}

// checkControlPlaneRecoveryOnce is ONE read of the latch, wired to the banner. It is fail-open: a read fault
// leaves the banner exactly as the latch stands (never an alarm on an unknown state, never an all-clear over
// a confirmed one). The three non-ok outcomes are told apart because they are different facts:
//
//   route-absent  404/501: an engine that does not serve the status route at all (an older build). It answers
//                 this way on EVERY poll of a correctly-working console, so a notice would cry wolf. Silent.
//   not-permitted 401/403/step-up: this CALLER may not read the latch (a lapsed session, an Access session
//                 that ended, a role the engine refuses). The console learned nothing about the plane, and
//                 the operator is about to be sent to sign in; a standing notice there would be noise on the
//                 ordinary signed-out path, which the watch now reaches because it no longer hides behind a
//                 successful whoami. Silent, and NOT recorded (it fires on the healthy signed-out path).
//   failed        anything else (5xx, network, malformed): the recovery state is genuinely UNKNOWN, which is
//                 a different fact from "recovery is not required" and is stated as such.
export async function checkControlPlaneRecoveryOnce(deps: RecoveryWatchDeps): Promise<void> {
  const engine = deps.engine();
  if (!engine) return;
  try {
    const status = await engine.controlPlaneStatus();
    updateRecoveryBanner(status, {
      reconcile: (input) => engine.controlPlaneRestore(input.token, input.exportArtefact, input.signature),
      // The auto-heal CONFIRM (needs only the ADMIN_TOKEN; no export travels on this call, and no
      // signature check runs here -- the artefact was already verified when the auto-heal staged it).
      applyStaged: (adminToken) => engine.controlPlaneApplyStaged(adminToken),
      // The SEALED reconcile, for the sub-case neither of the two above can serve. The bucket holds
      // only a `.sealed.json` (sealing is on by default whenever a break-glass recipient is configured) and
      // this engine has no CONFIG_RECIPIENT_PRIVATE, so auto-heal could not stage it and no plaintext pair
      // was ever written. The browser opens it with the operator's own key and the engine re-verifies the
      // wrapper, the signature and the recovered export against its own pinned signer before touching the DO.
      restoreSealed: (sealed, sealedSignature, exportArtefact, adminToken) => engine.controlPlaneRestoreSealed(adminToken, sealed, sealedSignature, exportArtefact),
      // Defect 23: the ACKNOWLEDGE-ONLY latch clear, the one exit an ESTABLISHED account has and the route
      // this wiring never had. It takes no token and no artefact: it rides the operator's own session, which
      // is available precisely because the role table it needs is non-empty. The banner offers it only when
      // the engine's own status says the plane came back, so it is never the answer to a genuine wipe.
      acknowledge: () => engine.controlPlaneAcknowledgeRecovery(),
      onReconciled: () => {
        deps.onReconciled();
        // Re-read at once so the latch's clearing is reflected without waiting out the interval.
        void checkControlPlaneRecoveryOnce(deps);
      },
      onApplied: () => {
        deps.onReconciled();
        void checkControlPlaneRecoveryOnce(deps);
      },
      // The acknowledge restores no authority, so unlike the two above it does NOT re-resolve identity: the
      // caller's role never changed, and calling onReconciled here would fire an identity refresh that says
      // nothing new. It re-reads the STATUS, which is the one thing that did change, so the banner comes down
      // on this tick rather than up to two minutes later on the interval leg.
      onAcknowledged: () => {
        void checkControlPlaneRecoveryOnce(deps);
      },
    });
  } catch (err) {
    const kind = classifyError(err);
    const routeAbsent = kind.kind === "server" && (kind.status === 404 || kind.status === 501);
    const notPermitted = kind.kind === "unauthorised" || kind.kind === "forbidden" || kind.kind === "stepup-required";
    updateRecoveryBanner(
      null,
      { reconcile: () => Promise.reject(new Error("unavailable")) },
      routeAbsent || notPermitted ? "route-absent" : "failed",
    );
    // Of every swallowed read in the console this is the expensive one. A latched recoveryRequired
    // means the scheduler control plane has been LOST and scheduled backups have silently stopped, and this
    // read is the only thing that can say so. A read that will not answer and an engine that needs recovery
    // must not look the same in the pack. The two SILENT classes are deliberately not recorded: they fire on
    // every poll of a correctly-working build (an older engine) or on the ordinary signed-out path (a caller
    // who may not read it), and a signal that fires on the healthy path stops being worth reading.
    if (!routeAbsent && !notPermitted) recordReadDegraded("control-plane-status", err);
  }
}

// lastCheckAt is the focus-coalesce window, module state so the floor holds across every focus event in a
// page. The interval leg does not consult it: a scheduled poll is the guarantee, and it must not be starved
// by an operator who happens to keep focusing the tab.
let lastCheckAt = 0;

// unsubscribeAuthority holds the authority-leg subscription so a second startRecoveryWatch in the same
// process replaces it rather than stacking a second listener on the same page. The app starts the watch
// exactly once, so this is a no-op there; it matters in a validator, where several cases start the watch in
// one process and a stacked listener would make one authority change drive N reads.
let unsubscribeAuthority: (() => void) | null = null;

// _resetRecoveryWatch clears the coalesce window and the authority subscription between validator cases
// (module state would otherwise leak from one case into the next in a single process). The app never calls
// it: a fresh page load re-initialises the module.
export function _resetRecoveryWatch(): void {
  lastCheckAt = 0;
  unsubscribeAuthority?.();
  unsubscribeAuthority = null;
}

// startRecoveryWatch runs the check now and keeps running it: an interval for the life of the page, a
// coalesced re-check whenever the tab regains focus, and an immediate re-check whenever the console's
// resolved authority changes. It is called ONCE, from boot, and the FIRST read is deliberately given no
// identity, caller or role: whether the control plane needs recovery is not a fact about who is looking, and
// the banner must not be suppressed by an unrelated read that failed.
export function startRecoveryWatch(deps: RecoveryWatchDeps): void {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => { window.setInterval(fn, ms); });
  const onFocus = deps.onFocus ?? ((fn) => { window.addEventListener("focus", fn); });
  const isHidden = deps.isHidden ?? (() => document.visibilityState === "hidden");
  const onAuthorityChange = deps.onAuthorityChange ?? onCallerChanged;

  const run = (): void => {
    lastCheckAt = now();
    void checkControlPlaneRecoveryOnce(deps);
  };

  run();
  setTimer(() => {
    // A backgrounded tab has no operator to tell, and the focus leg covers the return.
    if (isHidden()) return;
    run();
  }, RECOVERY_POLL_MS);
  onFocus(() => {
    if (now() - lastCheckAt < RECOVERY_FOCUS_FLOOR_MS) return;
    run();
  });
  // THE AUTHORITY LEG (see the header). Unfloored and unconditional: the caller changing is an operator
  // action, not a poll, it is the moment a 401 on this read can become an answer, and on a wiped plane it is
  // the FIRST moment the read can succeed at all. A hidden-tab guard would be wrong here too: the identity
  // that just resolved is the operator's own, whatever the visibility state says.
  unsubscribeAuthority?.();
  unsubscribeAuthority = onAuthorityChange(() => {
    run();
  });
}
