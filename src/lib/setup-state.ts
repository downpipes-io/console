// The shell's view of setup: the gate, the setup strip, the rail locks, Overview's not-set-up state and the
// palette all read ONE setup model, the headless first-run model in lib/setup-flow/ that the setup surface
// (/setup) also drives. Nothing here derives a step of its own. setupViewOf turns the model's snapshot into
// the few fields the shell needs; setupAllows and setupLockReason are the gate.
//
// The steps come from ENGINE FACTS (GET /admin/setup-state, the downpipe list, discovery), never from a stored
// wizard position, so an engine set up outside the console (keys from deploy.sh, an env destination, SRC_*
// bindings from wrangler) skips those steps, an interrupted setup resumes at the first unfinished step, and
// the gate dissolves the moment the facts say done.
//
// While a numbered step is unfinished the shell shows the setup strip, locks the rail items that are not yet
// meaningful, and sends a blocked deep link to /setup, which resumes at the first unfinished question.
// FAIL-OPEN is the safety rule everywhere: no gate until the setup facts and the downpipe list have both been
// read, and none on a refresh where either read failed. A transient hiccup must never lock a working console.
//
// NEVER LOCK A CONSOLE THAT WAS PAST SETUP. The shell counts setup complete when every numbered step before
// Finish is done, OR when the facts the console used before this setup page existed hold (keys on the engine,
// a destination, the account connected, at least one downpipe; setup-flow/steps.ts setUpByEstateFacts). An
// install that finished setup under that rule, whose downpipes carry no integrity stamp yet (not run, failed
// runs, verify-at-seal off), is not sent back to /setup after an upgrade. Once complete, the model keeps it
// complete for the page's life (SetupSnapshot.completeSeen). The setup page keeps its own step statuses, and
// only a verified first seal says "protected".
//
// This module imports only the model's pure parts (steps.ts, types.ts), so the shell can import it without
// pulling in the actions and the screens they call.

import { recordStorageBlocked } from "./client-diag/ring.ts";
import { firstBackupProgress, MAIN_STEPS, OWNER_STEPS, shellComplete, shellFactsRead } from "./setup-flow/steps.ts";
import type { SetupSnapshot, SetupStepId, StepView } from "./setup-flow/types.ts";

// SETUP_ENTRY_ROUTE is where every Continue, the gate's redirect and every old entry point goes. /setup resumes
// at the first unfinished question itself (screens/setup/b/flow.ts resumeQ).
export const SETUP_ENTRY_ROUTE = "/setup";

export interface SetupStepSummary {
  id: SetupStepId;
  label: string;
  done: boolean;
  // Needs an Owner (the strip and Overview word a non-owner's view of it as a hand-off).
  ownerOnly: boolean;
}

export interface SetupView {
  // The seven numbered steps, Connect to Finish, in order (Welcome carries no number).
  steps: SetupStepSummary[];
  // The shell counts setup complete: every numbered step before Finish is done, or the estate facts hold, or it
  // was complete earlier in this page's life (setup-flow/steps.ts shellComplete). Nothing gates once true.
  complete: boolean;
  // The step model's First backup is done: a first backup is sealed. A console complete by its estate facts
  // alone may have none, and the strip then does not say one is.
  firstBackupDone: boolean;
  // The shell counts setup complete, but the first backup this tab's setup started is not finished: of the
  // downpipes it created, `sealed` of `total` have sealed a run. null otherwise, including in a tab that holds
  // no setup draft (setup-flow/model.ts keeps the draft for a new tab while this is open). Nothing gates on it:
  // the strip says so and offers setup, which resumes on the run.
  firstBackupOpen: { sealed: number; total: number } | null;
  // The first unfinished numbered step (Finish when complete).
  current: SetupStepSummary;
  currentIndex: number;
  // 1-based, for "step N of 7" copy.
  stepNumber: number;
}

// setupViewOf is the shell's view of a model snapshot, or null when the shell must not gate (fail open): the
// setup facts or the downpipe list have not been read yet, or the last read of either failed.
export function setupViewOf(s: SetupSnapshot): SetupView | null {
  const f = s.facts;
  if (!shellFactsRead(f)) return null;
  const byId = new Map<SetupStepId, StepView>(s.steps.map((st) => [st.id, st]));
  const steps: SetupStepSummary[] = MAIN_STEPS.filter((d) => d.id !== "welcome").map((d) => ({
    id: d.id,
    label: d.label,
    done: byId.get(d.id)?.status === "done",
    ownerOnly: OWNER_STEPS.has(d.id),
  }));
  // Finish is never "done" in the model (it is where the flow ends), so the model's completeness is every step
  // before it; the estate facts and the page's latch can also complete it (see the header).
  const firstOpen = steps.findIndex((st) => st.id !== "finish" && !st.done);
  const complete = s.completeSeen || shellComplete(f, s.steps);
  const currentIndex = complete || firstOpen === -1 ? steps.length - 1 : firstOpen;
  const firstBackupDone = steps.find((st) => st.id === "backup")?.done === true;
  const progress = complete && !firstBackupDone ? firstBackupProgress(f, s.draft) : null;
  const firstBackupOpen = progress !== null && progress.sealed < progress.total ? progress : null;
  return { steps, complete, firstBackupDone, firstBackupOpen, current: steps[currentIndex]!, currentIndex, stepNumber: currentIndex + 1 };
}

// ---- the shell's current view -----------------------------------------------------------------------------

// The view the gate, the strip and the palette last saw (lib/app-refresh.ts sets it after each shell read).
let lastView: SetupView | null = null;

export function setLastSetupView(view: SetupView | null): void {
  lastView = view;
}

export function lastSetupView(): SetupView | null {
  return lastView;
}

// setupIncomplete: the shell has read the facts and a numbered step is unfinished. False when unknown.
export function setupIncomplete(): boolean {
  return lastView !== null && !lastView.complete;
}

// ---- the first load -----------------------------------------------------------------------------------------

// The first load of "/" while setup is unfinished goes to /setup, once per page load, so a new console opens on
// its first run and "Leave setup" (which opens "/") still reaches Overview afterwards.
let firstLandingTaken = false;

export function takeFirstLanding(): boolean {
  if (firstLandingTaken) return false;
  firstLandingTaken = true;
  return true;
}

// noteRouteForLanding: any route other than "/" resolving first means this page load did not open on "/", so
// the landing is spent (app.ts afterEach calls it on every route). The sign-in routes do not spend it: a new
// Owner's first passkey is registered on them and then lands on "/", and that first "/" is the first run.
const LANDING_NEUTRAL = new Set<string>(["/passkey", "/register", "/signed-out"]);
export function noteRouteForLanding(pattern: string): void {
  if (pattern !== "/" && !LANDING_NEUTRAL.has(pattern)) firstLandingTaken = true;
}

// ---- route gating -------------------------------------------------------------------------------------------

// The routes that stay reachable regardless of setup state: the entry, auth and identity surfaces, the setup
// surface itself, the "System" rail group (Settings, Licence and updates, Costs: none of them depend on a
// downpipe existing), Security centre, Keys and the palette landing.
const ALWAYS_ALLOWED = new Set<string>([
  "/",
  "/settings",
  // Licence and updates: self-update and rollback are a system/account-level concern
  // (whether the ENGINE is current), not a "protect my data" one, so it carries no
  // dependency on a downpipe existing -- the same reasoning that already exempts
  // Settings and Keys. Without this exemption, an estate with zero downpipes could
  // never reach it, deep link or rail click, for the estate's entire life.
  "/licence",
  // Costs: a browser-local planning calculator (costs.ts's own header: "the operator
  // uses before or alongside provisioning"), the same "System" rail group as Settings
  // and Licence (shell/nav.ts). It transmits nothing and needs no downpipe to exist.
  "/costs",
  // Security centre and its owner-approvals route: dual control, credential rotation and the
  // owner-approval inbox are an account-security concern, not a "protect my data" one. Without
  // this, an operator following the deploy runbook's "after the deploy" step to retire the
  // one-time bootstrap admin token cannot reach Security centre until the whole first run is
  // finished, leaving that token live for the estate's entire setup.
  "/security",
  "/security/owner-actions",
  // All four Keys routes: the screen's sections are routes (screens/keys/shared.ts), and this set is
  // matched by exact PATTERN, so listing only "/keys" would bounce an operator mid-setup off the Custody
  // or Offline-recovery section, which is the opposite of what "Keys stays reachable regardless of setup
  // state" means. Keys is also where an engine that already holds keys replaces them.
  "/keys",
  "/keys/rotate",
  "/keys/custody",
  "/keys/recovery",
  // The setup surface: it is where every step happens, so it is never gated.
  "/setup",
  "/setup/:step",
  "/setup/:step/:sub",
  "/passkey",
  "/register",
  "/signed-out",
  "/command-palette",
  "*",
]);

// STEP_PATTERNS maps each numbered step to the route PATTERNS of the ordinary screen that owns the same
// thing after setup, so reaching a step unlocks that whole screen (sub-routes included).
const STEP_PATTERNS: Record<SetupStepId, string[]> = {
  welcome: [],
  // The token lives on Sources after setup (replace, remove, choose accounts).
  connect: ["/sources", "/sources/advanced", "/sources/add"],
  destination: ["/destinations"],
  protect: ["/sources", "/sources/advanced", "/sources/add"],
  keys: ["/keys", "/keys/rotate", "/keys/custody", "/keys/recovery"],
  apply: ["/sources", "/sources/advanced", "/sources/add"],
  // The first backup: its downpipes, and the runs they make (a failed first run is read there).
  backup: ["/downpipes", "/downpipes/new", "/downpipes/:id", "/downpipes/:id/edit", "/runs", "/runs/:downpipeId/:index"],
  finish: [],
  team: [],
  approval: [],
};

// setupAllows decides whether a route pattern is reachable in the current setup state: always-allowed chrome,
// plus every step's screen up to AND INCLUDING the current step. Everything else waits.
export function setupAllows(pattern: string, view: SetupView): boolean {
  if (view.complete) return true;
  if (ALWAYS_ALLOWED.has(pattern)) return true;
  for (let i = 0; i <= view.currentIndex; i++) {
    const step = view.steps[i]!;
    if (STEP_PATTERNS[step.id].includes(pattern)) return true;
  }
  return false;
}

// setupLockReason is the inline reason a locked rail item carries (the same disabled-with-reason discipline
// every gated control uses; never a dead click).
export function setupLockReason(view: SetupView): string {
  return `Available after setup. Step ${view.stepNumber} of ${view.steps.length}, ${view.current.label}, comes first.`;
}

// ---- the completion celebration flag -------------------------------------------

const CELEBRATED_KEY = "dp-setup-celebrated";

export function setupCelebrated(): boolean {
  try {
    return localStorage.getItem(CELEBRATED_KEY) === "1";
  } catch (err) {
    // Storage unavailable, so never nag: the setup strip then behaves as though the operator had already
    // seen the celebration, the honest choice, and recording it here is what keeps this failure visible.
    recordStorageBlocked("local", "read", "setup-state", err);
    return true;
  }
}

export function markSetupCelebrated(): void {
  try {
    localStorage.setItem(CELEBRATED_KEY, "1");
  } catch (err) {
    // Best-effort; the strip simply shows once more next boot.
    recordStorageBlocked("local", "write", "setup-state", err);
  }
}
