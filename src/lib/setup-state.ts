// The guided first-run's brain (the setup-first IA, owner feedback:
// "you need to do specific things in order, and they need to be done right").
//
// Five steps, derived from GET /admin/setup-state FACTS, never from a stored
// wizard position, so an IaC deployment (env destination, wrangler-bound
// sources) skips steps automatically, an interrupted setup resumes at the first
// incomplete step, and the gate dissolves the moment the facts say done:
//
//   1. keys, the ceremony (signer + break-glass present)
//   2. destination, where backups land, verified (nothing can run without it, so it comes first)
//   3. connect, the read-only account token (or sources already bound)
//   4. sources, at least one source attached to the engine
//   5. downpipe, the first backup route exists
//
// Because setupAllows() unlocks rail items only up to the current step, putting destination second
// means /sources (and every later screen) stays LOCKED until a destination is configured: before
// then only Overview, Destinations, Keys and Settings are reachable, exactly the setup-first order.
// Once the destination is verified, Sources unlocks, then Downpipes.
//
// While any step is incomplete the shell shows the setup strip, locks the rail
// items that are not yet meaningful, and redirects blocked deep links to the
// current step's home. FAIL-OPEN is the safety rule everywhere: a setup-state
// read failure, an old engine without the endpoint, or an absent count NEVER
// engages the gate (a transient hiccup must not lock a working console).

import type { EngineClient, SetupState } from "../api.ts";
import { recordReadDegraded, recordStorageBlocked } from "./client-diag/ring.ts";
import { h } from "./dom.ts";

export type SetupStepId = "keys" | "connect" | "destination" | "sources" | "downpipe";

export interface SetupStepView {
  id: SetupStepId;
  // The short label the strip and the checklist show.
  label: string;
  // The one-line explanation the checklist shows under the label.
  hint: string;
  // The concrete navigation target the step opens (the strip's Continue and the redirect target),
  // not a router pattern. Gating in setupAllows matches against STEP_PATTERNS, which holds the
  // router-registered patterns; the two differ by design (e.g. the keys step navigates to
  // /onboarding/connect while gating is checked against the /onboarding/:step pattern).
  route: string;
  done: boolean;
  // Steps an Owner must do (so a non-owner sees honest hand-off copy).
  ownerOnly: boolean;
}

export interface SetupView {
  steps: SetupStepView[];
  complete: boolean;
  // The first incomplete step (or the last step when complete, for display).
  current: SetupStepView;
  currentIndex: number;
  stepNumber: number; // 1-based, for "step N of 5" copy
  anyRunCompleted: boolean;
}

// deriveSetup is pure: facts in, steps out. Absent DO-sourced facts read as DONE
// (fail-open): a hiccup that hides downpipeCount must not re-lock a console that
// was past setup a second ago.
export function deriveSetup(s: SetupState): SetupView {
  // The first backup route existing PROVES a source was picked (a downpipe is created FROM a source), so
  // "Create your first downpipe" (step 5) being done IMPLIES "Pick what to protect" (step 4) is done. Fold
  // that into sourcesDone so the checklist stays MONOTONIC and can never show step 4 incomplete while step 5
  // is ticked. This also makes step 4 robust to a source BINDING that was dropped AFTER the downpipe was
  // created: an engine redeploy that does not preserve console-attached bindings drops them (boundSourceCount
  // falls to 0) while the downpipe, which lives in the Durable Object, survives. The binding-is-missing
  // concern is a runtime-health signal surfaced elsewhere; the setup checklist must not re-gate a user who is
  // already past setup. Absent count = fail-open done (a transient hiccup must not re-lock a working console).
  const downpipeDone = s.downpipeCount === undefined ? true : s.downpipeCount > 0;
  const sourcesDone = s.boundSourceCount > 0 || downpipeDone;
  const steps: SetupStepView[] = [
    {
      id: "keys",
      label: "Create your keys",
      hint: "Generate your keys in the browser, the setup wizard walks you through it and installs them to your engine with one click. No terminal.",
      route: "/onboarding/connect",
      done: s.keysReady,
      ownerOnly: true,
    },
    {
      id: "destination",
      label: "Choose where backups go",
      hint: "Your bucket, verified writable before it is saved. Nothing can run without it, so this comes first.",
      route: "/destinations",
      done: s.destination.configured,
      ownerOnly: true,
    },
    {
      id: "connect",
      label: "Connect your account",
      hint: "Paste one read-only API token so everything you own is browsable. No CLI, no redeploy.",
      route: "/sources",
      done: s.discoveryTokenPresent || sourcesDone,
      ownerOnly: true,
    },
    {
      id: "sources",
      label: "Pick what to protect",
      // The hint used to end "Attaching them is one copy-paste deploy (the screen detects when it lands)",
      // which is the path the product moved off. The mainline is now the no-terminal attach on the same
      // screen: tick, paste a one-shot token, press Attach now (screens/sources/account.ts buildAttachPanel).
      // Deploying it yourself still exists and is still supported, one disclosure down, for a self-hoster who
      // would rather not hand over a token. This line sits on the Overview hero, so it is one of the first
      // sentences a new customer reads, and it was telling them the product needs a terminal that it does not.
      hint: "Tick the namespaces, buckets and databases that matter, then attach them on the same screen with a one-shot token. No terminal.",
      route: "/sources",
      done: sourcesDone,
      ownerOnly: false,
    },
    {
      id: "downpipe",
      label: "Create your first downpipe",
      hint: "Source, destination, schedule. Then the first backup runs.",
      route: "/downpipes",
      done: downpipeDone,
      ownerOnly: false,
    },
  ];
  const firstIncomplete = steps.findIndex((st) => !st.done);
  const complete = firstIncomplete === -1;
  const currentIndex = complete ? steps.length - 1 : firstIncomplete;
  return {
    steps,
    complete,
    current: steps[currentIndex]!,
    currentIndex,
    stepNumber: currentIndex + 1,
    anyRunCompleted: s.anyRunCompleted === true,
  };
}

// fetchSetup reads the consolidated facts and derives the view. null = unknown
// (engine unreachable, endpoint absent on an older engine, or any error): the
// caller treats unknown as "no gating" (fail-open).
export async function fetchSetup(engine: EngineClient): Promise<SetupView | null> {
  try {
    const s = await engine.getSetupState();
    return deriveSetup(s);
  } catch (err) {
    // This fail-open is correct and its SILENCE is the bug. "Unknown" means no gating, so a
    // consolidated-facts read that is quietly 5xx-ing leaves the guided-setup strip absent and lets the
    // Overview say nothing is configured on an engine that is fully configured. The operator's report is that
    // the console has forgotten their setup; the pack, as it stands, shows a healthy engine.
    //
    // The row names the READ, not the screen: this fires from wherever the operator happens to be, so an
    // engine-call row on the Overview cannot say whether the setup facts or the credentials count was the one
    // that went quiet. It carries the read's class and its HTTP class, and nothing else.
    recordReadDegraded("setup-state", err);
    return null;
  }
}

// fetchSetupHealed is fetchSetup plus a one-shot self-heal for the demo "stuck first-run marker":
// after a demo reset the signer/break-glass worker secrets survive but a marker pins keysReady false,
// and the only things that clear it are a key install or an explicit acknowledge. If the wizard's
// acknowledge raced (or the operator left before it landed), Overview would keep reading keys as
// not-done and show the "not set up" framing forever. So when the keys step reads NOT done, we ask the
// engine to acknowledge (server-enforced: it clears ONLY when it actually observes the keys present,
// so a genuinely keyless engine is an ok:false no-op) and, if it cleared anything, refetch the now
// healthy view. Best-effort: any failure falls back to the original view (fail-open, never blocks).
export async function fetchSetupHealed(engine: EngineClient): Promise<SetupView | null> {
  const view = await fetchSetup(engine);
  if (view === null || view.complete) return view;
  const keysStep = view.steps.find((s) => s.id === "keys");
  if (keysStep && !keysStep.done) {
    try {
      const ack = await engine.acknowledgeSetup();
      if (ack.ok) return await fetchSetup(engine);
    } catch {
      // best-effort: keep the original view
    }
  }
  return view;
}

// ---- route gating -------------------------------------------------------------

// The routes that stay reachable regardless of setup state: the entry/auth/identity
// surfaces, the "System" rail group (Settings, Licence and updates, Costs -- none of
// them depend on a downpipe existing), Keys and the onboarding wizard (step 1's
// home), and the palette landing.
const ALWAYS_ALLOWED = new Set<string>([
  "/",
  "/settings",
  // Licence and updates: self-update and rollback are a system/account-level concern
  // (whether the ENGINE is current), not a "protect my data" one, so it carries no
  // dependency on a downpipe existing -- the same reasoning that already exempts
  // Settings and Keys. Was missing (CONSOLE-ZERO-DOWNPIPE-SETUP-GATE-LOCKS-LICENCE,
  // ): an estate with zero downpipes could never reach it, deep link or
  // rail click, for the estate's entire life.
  "/licence",
  // Costs: a browser-local planning calculator (costs.ts's own header: "the operator
  // uses before or alongside provisioning"), the same "System" rail group as Settings
  // and Licence (shell/nav.ts). It transmits nothing and needs no downpipe to exist,
  // so it was gated by the same unnoticed omission as Licence and is fixed alongside it.
  "/costs",
  // Security centre and its owner-approvals route: dual control, credential rotation and the
  // owner-approval inbox are an account-security concern, not a "protect my data" one -- the same
  // reasoning that already exempts Licence and Costs carries no dependency on a downpipe
  // existing. Without this, an operator following the deploy runbook's "after the deploy" step to
  // retire the one-time bootstrap admin token cannot reach Security centre until the whole quickstart
  // (destination, discovery token, sources, first downpipe) is finished, leaving that token live for
  // the estate's entire onboarding.
  "/security",
  "/security/owner-actions",
  // All four Keys routes: the screen's sections are routes now (screens/keys/shared.ts), and this set is
  // matched by exact PATTERN, so listing only "/keys" would bounce an operator mid-setup off the Custody
  // or Offline-recovery section back to their current step, which is the opposite of what "Keys stays
  // reachable regardless of setup state" means.
  "/keys",
  "/keys/rotate",
  "/keys/custody",
  "/keys/recovery",
  "/onboarding/:step",
  "/passkey",
  "/register",
  "/signed-out",
  "/command-palette",
  "*",
]);

// stepRouteOwners maps each step to the route PATTERNS its home screen owns, so
// reaching a step unlocks its whole screen (sub-routes included).
const STEP_PATTERNS: Record<SetupStepId, string[]> = {
  keys: ["/onboarding/:step", "/keys", "/keys/rotate", "/keys/custody", "/keys/recovery"],
  connect: ["/sources", "/sources/advanced", "/sources/add"],
  destination: ["/destinations"],
  sources: ["/sources", "/sources/advanced", "/sources/add"],
  downpipe: ["/downpipes", "/downpipes/new", "/downpipes/:id", "/downpipes/:id/edit"],
};

// setupAllows decides whether a route pattern is reachable in the current setup
// state: always-allowed chrome, plus every step home up to AND INCLUDING the
// current step. Everything else waits (an intentional forcing function).
export function setupAllows(pattern: string, view: SetupView): boolean {
  if (view.complete) return true;
  if (ALWAYS_ALLOWED.has(pattern)) return true;
  for (let i = 0; i <= view.currentIndex; i++) {
    const step = view.steps[i]!;
    if (STEP_PATTERNS[step.id].includes(pattern)) return true;
  }
  return false;
}

// setupLockReason is the inline reason a locked rail item carries (the same
// disabled-with-reason discipline every gated control uses; never a dead click).
export function setupLockReason(view: SetupView): string {
  return `Available after setup, step ${view.stepNumber} of ${view.steps.length} (${view.current.label.toLowerCase()}) comes first`;
}

// ---- the completion celebration flag -------------------------------------------

const CELEBRATED_KEY = "dp-setup-celebrated";

export function setupCelebrated(): boolean {
  try {
    return localStorage.getItem(CELEBRATED_KEY) === "1";
  } catch (err) {
    // Storage unavailable, so never nag. The setup strip then behaves as though the operator had already
    // seen the celebration, which is the honest choice and is invisible without this row.
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

// ---- the Overview checklist card ------------------------------------------------

// setupChecklistCard renders the five steps with live states and ONE action (the
// current step), for the Overview pre-setup hero. The list is informative; the
// single button keeps the screen to one decision.
export function setupChecklistCard(view: SetupView, navigate: (to: string) => void): HTMLElement {
  const items = view.steps.map((st, i) => {
    const isCurrent = i === view.currentIndex && !view.complete;
    const marker = st.done
      ? h("span", { class: "setup-check__mark setup-check__mark--done", "aria-hidden": "true" }, "✓")
      : h("span", { class: `setup-check__mark${isCurrent ? " setup-check__mark--current" : ""}`, "aria-hidden": "true" }, String(i + 1));
    return h(
      "li",
      { class: "setup-check__item" },
      marker,
      h(
        "div",
        h("span", { class: isCurrent ? "setup-check__label setup-check__label--current" : "setup-check__label" }, st.label, st.done ? h("span", { class: "visually-hidden" }, " (done)") : null),
        isCurrent ? h("span", { class: "field__hint", style: "display:block" }, st.hint) : null,
      ),
    );
  });
  const doneCount = view.steps.filter((s) => s.done).length;
  // Once the core setup is done (the keys ceremony is complete), reframe the card so finishing the
  // wizard reads as PROGRESS, not starting over: the heading celebrates the console being set up and
  // the remaining steps are framed as connecting backups, rather than "Set up your backups / 0 of N".
  const keysDone = view.steps.find((s) => s.id === "keys")?.done === true;
  const remaining = view.steps.length - doneCount;
  const heading = view.complete ? "Your backups are set up" : keysDone ? "Your console is set up" : "Set up your backups";
  const desc = view.complete
    ? "Every step is done."
    : keysDone
      ? `Your keys are in place. Now connect your backups: ${remaining} ${remaining === 1 ? "step" : "steps"} to your first backup.`
      : `${doneCount} of ${view.steps.length} steps done. Each one unlocks the next; the whole path takes about ten minutes.`;
  const ariaLabel = keysDone && !view.complete ? "Connect your backups" : "Set up your backups";
  return h(
    "section",
    { class: "card", "aria-label": ariaLabel },
    h("h2", { class: "card__title" }, heading),
    h("p", { class: "card__desc" }, desc),
    h("ol", { class: "setup-check" }, ...items),
    h(
      "div",
      { style: "margin-top:var(--space-4)" },
      h(
        "button",
        { "data-dp": "lib-setup-state.button.navigate", class: "btn btn--primary", type: "button", on: { click: () => navigate(view.current.route) } },
        view.complete ? "Open Downpipes" : `Continue: ${view.current.label}`,
      ),
    ),
  );
}
