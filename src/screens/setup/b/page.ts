// Focus Flow (concept B): the page. One question at a time on the left, in large calm type, answered with
// one click or the keyboard; "Your backup plan" on the right, every decision one line, filling in as
// answers commit. Each question owns its URL, so Back, Forward and reload keep the position.
//
// The page drives the foundation's headless model (lib/setup-flow/) and nothing else: it reads get(),
// subscribes, and the question modules call the model's actions. Step status is the model's; this file
// decides only which question shows and how.
//
// Layout contract: the stage is a grid of three rows (head, answer, actions) filling the viewport under the
// top bar, so the primary action sits at one anchored position on every question at 1440x900. Below 768 px
// the plan leaves the page for a sheet, and the primary and the Plan button sit in a fixed dock.

import { h } from "../../../lib/dom.ts";
import { caller, navigate, requestPostNavigationFocus } from "../../../lib/nav.ts";
import { noteGateComputedBlind } from "../../../lib/client-diag/identity-gate.ts";
// OWNER_STEPS (lib/setup-flow/steps.ts): a caller who is not an Owner sees an honest hand-off on these
// questions instead of controls that the engine would refuse. The shell strip reads the same set.
import { guardUnbankedKeys, OWNER_STEPS, parseSetupParams, type SetupSnapshot, setupModel } from "../../../lib/setup-flow/index.ts";
import { probeEngine } from "../../../lib/setup-flow/engine-probe.ts";
import { ICON_INFO } from "../../../lib/icons.ts";
import { toast } from "../../../components/toast.ts";
import type { ScreenContext } from "../../common.ts";
import { progressLine, themeControl, topBar } from "./chrome.ts";
import { firstOfStep, loadAnswers, orderOf, Q_ROUTE, qFromParams, qHref, qPath, resumeQ, STANDALONE_QS, STEP_NAME, STEP_NUMBER, saveAnswer, setupDoneElsewhere, stepDone, stepShare } from "./flow.ts";
import { enterSubmits, kbd, line, openSheet } from "./kit.ts";
import { getLiveInstall, onLiveInstall } from "./live.ts";
import { beginChange, finishChange, landFlight, launchFlight, takeFlight } from "./motion-b.ts";
import { type LineState, planGroups, renderPlainPlan, renderPlan } from "./plan.ts";
import { QUESTIONS } from "./questions.ts";
import type { LineId, QCtx, QId, QView } from "./types.ts";

// The plan's line states at the previous paint, so a line that just became decided can mark itself fresh.
let lastStates = new Map<LineId, LineState>();

// renderGen marks the newest render; an older render's async work stops when a newer one exists. (The
// shell mounts a page a task or more after render returns, so connection is not the test.)
let renderGen = 0;

function doneCount(s: SetupSnapshot): number {
  const main = ["connect", "destination", "protect", "keys", "apply", "backup"] as const;
  return main.filter((id) => stepDone(s, id)).length + (s.protectedNow ? 1 : 0);
}

export function renderFocusFlow(ctx: ScreenContext): HTMLElement {
  const gen = ++renderGen;
  const stale = (): boolean => gen !== renderGen;
  const model = setupModel();
  const { step, sub } = parseSetupParams(ctx.params);
  const urlQ = qFromParams(step, sub);
  const ret = ctx.query.get("return");
  // data-motion-owner: the shell swaps this page at once, and motion-b.ts animates the change (input stays live).
  const root = h("div", { class: "fb-page", "data-step": step ?? "", "data-q": urlQ ?? "", "data-motion-owner": "" });
  guardUnbankedKeys(root);
  // A toast (a queued owner action, the demo's simulated-write cue) never covers the control that has focus:
  // on a narrow screen it sits above the dock, so a control it would cover scrolls up clear of it.
  root.addEventListener("focusin", (e) => {
    const t = e.target;
    const region = document.querySelector<HTMLElement>(".toast-region");
    if (!(t instanceof HTMLElement) || region === null || region.querySelector(".toast") === null) return;
    const a = t.getBoundingClientRect();
    const b = region.getBoundingClientRect();
    const overlaps = a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
    if (overlaps && getComputedStyle(t).position !== "fixed") window.scrollBy({ top: a.bottom - b.top + 12 });
  });

  const progressHost = h("div", { class: "fb-progress-host" });
  // data-tour-id: the training walk's first chapter anchors its beats on the stage (training-beginner.ts).
  const stageHost = h("div", { class: "fb-stage-host", "data-tour-id": "setup-stage" });
  const plan = h("aside", { class: "fb-plan", "aria-labelledby": "fb-plan-title" });
  const body = h("div", { class: "fb-body" }, stageHost, plan);
  root.append(progressHost, topBar(), body);

  let view: QView | null = null;
  let q: QId | null = null;
  let h1: HTMLElement | null = null;
  let primaryBtn: HTMLButtonElement | null = null;
  // The primary's label, beside its busy spinner (the spinner is the shared .btn__spinner, which the
  // reduced-motion rules freeze into a static ring).
  let primaryLabel: HTMLElement | null = null;
  let reasonEl: HTMLElement | null = null;
  let busy = false;
  let flightLine: LineId | null = takeFlight();
  // The tab title names the question. The shell titles the route before it mounts the page, so the page sets
  // its own title again once mounted (the focus hook below runs after the shell's swap).
  let docTitle = "";
  const applyTitle = (): void => {
    if (docTitle === "" || stale()) return;
    const demo = document.title.startsWith("(Demo) ") ? "(Demo) " : "";
    document.title = `${demo}${docTitle}`;
  };

  // ---- the plan column and the progress line ----------------------------------------------------------------

  let planKey = "";
  // Set when the page leaves for Overview (resolve, a console set up elsewhere): nothing of the draft is drawn.
  let leaving = false;
  const paintPlan = (s: SetupSnapshot, force = false): void => {
    if (leaving) return;
    const ans = loadAnswers();
    const share = q !== null && !stepDone(s, Q_ROUTE[q].step) ? stepShare(q, s.draft.provider) : 0;
    // A question that stands on its own on a console set up elsewhere (STANDALONE_QS) is not a step of this
    // tab's setup, so it shows no progress through one.
    if (setupDoneElsewhere(s, ans)) progressHost.replaceChildren();
    else progressHost.replaceChildren(progressLine(doneCount(s), share));
    if (view?.receipt) {
      // Finish: the plan has become the receipt on the stage.
      if (force) plan.replaceChildren();
      planKey = "";
      return;
    }
    if (q === "welcome") {
      // Welcome: the whole road in plain words; the detailed lines start at the first question.
      if (force || planKey !== "plain") plan.replaceChildren(renderPlainPlan());
      planKey = "plain";
      return;
    }
    const groups = planGroups(s, ans, getLiveInstall());
    const qd = q !== null ? QUESTIONS[q] : null;
    const current = q === null ? null : Q_ROUTE[q].step;
    const mode = "folded";
    const key = JSON.stringify([groups, current, qd?.line ?? null, mode, q]);
    if (!force && key === planKey) return;
    planKey = key;
    const fresh = new Set<LineId>();
    const states = new Map<LineId, LineState>();
    for (const g of groups) for (const l of g.lines) {
      states.set(l.id, l.state);
      if (l.state === "set" && lastStates.has(l.id) && lastStates.get(l.id) !== "set") fresh.add(l.id);
    }
    lastStates = states;
    const r = renderPlan(groups, {
      mode,
      current,
      currentLine: qd?.line ?? null,
      currentQ: q,
      flightLine,
      fresh,
      // First backup shows retention and restore tests on the stage; the plan does not repeat them there.
      ...(q === "backup" ? { hide: new Set<LineId>(["schedule", "retention", "restore"]) } : {}),
      onChange: (target) => change(target),
    });
    plan.replaceChildren(r.el);
    if (flightLine !== null) {
      landFlight(r.flightTarget);
      flightLine = null;
    }
  };

  // ---- navigation ---------------------------------------------------------------------------------------------

  const go = (id: QId, opts: { replace?: boolean; back?: boolean; ret?: string | null } = {}): void => {
    if (root.isConnected) beginChange(root, { back: opts.back === true, toReceipt: id === "finish" && view?.receipt !== true && view?.hidePlan !== true });
    navigate(qHref(id, opts.ret ?? null), opts.replace === true ? { replace: true } : undefined);
  };
  const here = (): string => (q !== null ? qPath(q) : "/setup");
  const change = (target: QId): void => {
    const back = q !== null && orderOf(target) < orderOf(q);
    go(target, { back, ret: here() });
  };
  const next = (): void => {
    const s = model.get();
    const resume = resumeQ(s);
    if (ret !== null) {
      // Back to where the Change started, unless the change reopened an earlier question.
      const target = qFromParams(parseSetupParams({ step: ret.split("/")[2] ?? "", ...(ret.split("/")[3] ? { sub: ret.split("/")[3]! } : {}) }).step, ret.split("/")[3] ?? null);
      if (target !== null && orderOf(resume) >= orderOf(target)) {
        go(target);
        return;
      }
    }
    go(resume);
  };

  // ---- the stage ----------------------------------------------------------------------------------------------

  const refreshActions = (): void => {
    if (!view?.primary || !primaryBtn || !reasonEl) return;
    // While busy the reason line says what is happening (role=status, so it is announced); otherwise why the
    // primary cannot run yet, if it cannot.
    const why = busy ? busySentence(view.primary) : view.primary.reason?.() ?? null;
    if (busy) reasonEl.setAttribute("role", "status");
    if (reasonEl.textContent !== (why ?? "")) reasonEl.textContent = why ?? "";
    reasonEl.hidden = why === null;
    if (why !== null || busy) primaryBtn.setAttribute("aria-disabled", "true");
    else primaryBtn.removeAttribute("aria-disabled");
  };

  const setBusy = (on: boolean): void => {
    busy = on;
    if (!view?.primary || !primaryBtn || !primaryLabel) return;
    primaryLabel.textContent = on ? view.primary.busyLabel ?? view.primary.label : primaryBtn.dataset.label ?? view.primary.label;
    if (on) {
      primaryBtn.setAttribute("aria-busy", "true");
      primaryBtn.dataset.busy = "true";
    } else {
      primaryBtn.removeAttribute("aria-busy");
      delete primaryBtn.dataset.busy;
    }
    refreshActions();
  };

  const runPrimary = async (): Promise<void> => {
    if (!view?.primary || busy) return;
    const why = view.primary.reason?.() ?? null;
    if (why !== null) {
      // The disabled primary announces its reason; it stays focusable.
      reasonEl?.setAttribute("role", "status");
      if (reasonEl) {
        reasonEl.textContent = "";
        reasonEl.textContent = why;
        reasonEl.hidden = false;
      }
      return;
    }
    await view.primary.run();
  };

  const planButton = (): HTMLButtonElement => {
    const b = h("button", { "data-dp": "setup.button.add-fb-sheet-plan", class: "btn btn--secondary fb-planbtn", type: "button", "aria-haspopup": "dialog" }, "Plan") as HTMLButtonElement;
    b.addEventListener("click", () => {
      const s = model.get();
      const r = q === "welcome"
        ? { el: renderPlainPlan(false) }
        : renderPlan(planGroups(s, loadAnswers(), getLiveInstall()), { mode: "full", current: q !== null ? Q_ROUTE[q].step : null, currentLine: q !== null ? QUESTIONS[q].line : null, currentQ: q, flightLine: null, fresh: new Set(), title: false, onChange: (t) => { sheet.close(); change(t); } });
      const sheet = openSheet({ title: "Your backup plan", body: [r.el, h("div", { class: "fb-sheet__theme" }, themeControl())], opener: b });
      sheet.el.classList.add("fb-sheet--plan");
    });
    return b;
  };

  const mount = (id: QId, s: SetupSnapshot): void => {
    view?.dispose?.();
    q = id;
    root.dataset.q = id;
    busy = false;
    const def = QUESTIONS[id];
    const c: QCtx = {
      s,
      q: id,
      ret,
      next,
      go: (t, o) => go(t, o ?? {}),
      answer: (a) => saveAnswer(a),
      flight: (el, line) => launchFlight(el, line),
      refresh: refreshActions,
      setPrimaryLabel: (label) => {
        if (primaryBtn && primaryLabel) {
          primaryBtn.dataset.label = label;
          if (!busy) primaryLabel.textContent = label;
        }
      },
      setBusy,
      rerender: () => {
        const hadFocus = document.activeElement;
        mount(id, model.get());
        paintPlan(model.get(), true);
        const a = document.activeElement;
        if (hadFocus !== null && (a === null || a === document.body || !a.isConnected)) h1?.focus();
      },
    };
    const locked = s.steps.find((x) => x.id === def.step);
    const who = caller();
    // An identity not resolved yet renders the question (the actions refuse a non-owner on their own), and
    // is WITNESSED, so the page re-renders into the hand-off once whoami lands for a caller who is not an
    // Owner (app.ts forceForBlindGate).
    if (who === null && OWNER_STEPS.has(def.step)) noteGateComputedBlind();
    view = who !== null && who.role !== "owner" && OWNER_STEPS.has(def.step)
      ? handoffView(s)
      : locked?.status === "locked" && !["run", "finish", "hardening", "check", "team", "approval"].includes(id) ? lockedView(locked.reason ?? "", s) : def.render(c);
    const n = STEP_NUMBER[def.step];
    const eyebrow = view.eyebrow ?? (n !== undefined ? `${STEP_NAME[def.step]}, ${n} of 7` : STEP_NAME[def.step]);
    h1 = h("h1", { class: "fb-h1", tabindex: "-1" }, view.title);
    // The eyebrow names the step and its place, and is the progress model's current step for assistive
    // technology on every view and at every width (the plan column is not always rendered). Its own
    // transition group keeps it still when only the question changes.
    const onPath = n !== undefined || id === "welcome";
    const head = h(
      "div",
      { class: "fb-head" },
      h("p", { class: "fb-eyebrow", ...(onPath ? { "aria-current": "step" } : {}) }, eyebrow),
      h1,
      view.lede ? h("p", { class: "fb-lede" }, ...view.lede) : null,
    );
    const answer = h("div", { class: "fb-answer" }, ...view.body);
    reasonEl = h("p", { class: "fb-reason", id: `fb-reason-${gen}`, hidden: true });
    primaryBtn = null;
    primaryLabel = null;
    const actionKids: Node[] = [];
    if (view.primary) {
      primaryLabel = h("span", { class: "fb-primary__label" }, view.primary.label);
      primaryBtn = h("button", { "data-dp": "setup.button.mount", class: "btn btn--primary btn--lg fb-primary", type: "submit", "aria-describedby": reasonEl.id, ...(view.primary.busyLabel ? { "data-busy-label": view.primary.busyLabel } : {}) }, h("span", { class: "btn__spinner", "aria-hidden": "true" }), primaryLabel) as HTMLButtonElement;
      primaryBtn.dataset.label = view.primary.label;
      // The second click of a double-click lands on the next question's primary at the same anchored spot;
      // it is dropped, so one double-click never answers two questions.
      primaryBtn.addEventListener("click", (e) => {
        if (e.detail > 1) e.preventDefault();
      });
      actionKids.push(primaryBtn, kbd("Enter"));
    }
    // Plan comes last in the DOM, so Tab meets it after the primary and the secondaries, as it is drawn.
    actionKids.push(...(view.secondary ?? []), reasonEl, ...(view.receipt ? [] : [planButton()]));
    const actions = h("div", { class: "fb-actions" }, h("div", { class: "fb-actions__row" }, ...actionKids));
    const wide = view.hidePlan === true || view.receipt === true;
    const form = h("form", { class: `fb-stage${wide ? " fb-stage--wide" : ""}`, novalidate: true, "aria-labelledby": "fb-h1" }, head, answer, actions) as HTMLFormElement;
    h1.id = "fb-h1";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void runPrimary();
    });
    enterSubmits(form, { fromHeading: view.enterFromHeading !== false });
    stageHost.replaceChildren(form);
    body.classList.toggle("fb-body--noplan", wide);
    root.classList.toggle("fb-page--finish", view.receipt === true);
    const stepPart = n !== undefined ? `${STEP_NAME[def.step]} ${n} of 7, ` : "";
    docTitle = `${view.title}, ${stepPart}downpipes setup`;
    applyTitle();
    refreshActions();
  };

  // handoffView: a caller who is not an Owner, on a step only an Owner can do. It says where setup is and who
  // does it, and offers the console; the plan beside it still shows what is done.
  function handoffView(s: SetupSnapshot): QView {
    const at = s.steps.find((x) => x.id === s.current);
    const n = STEP_NUMBER[s.current];
    return {
      eyebrow: "Set up downpipes",
      title: "An Owner sets up downpipes",
      lede: [n !== undefined ? `Setup is at step ${n} of 7, ${at?.label ?? STEP_NAME[s.current]}. Only an Owner of this engine can do it.` : "Setup has not started. Only an Owner of this engine can start it."],
      body: [line(ICON_INFO, "Ask an Owner to finish setup. When setup is done, every screen opens for you.")],
      primary: { label: "Open the console", run: () => navigate("/") },
    };
  }

  // arrivalFocus is where focus lands on a new question: the view's first field, or the heading. On a short
  // window (under 600 px tall, 200% zoom on a laptop) it is always the heading: the browser centres a focused
  // field, and at 720x450 that scrolled the question's heading out of view on Connect and Apply. The field is
  // then the next Tab.
  function arrivalFocus(): HTMLElement | null {
    const short = typeof window !== "undefined" && typeof window.innerHeight === "number" && window.innerHeight > 0 && window.innerHeight < 600;
    const field = short ? null : view?.focus?.() ?? null;
    return field ?? h1;
  }

  // busySentence is the busy primary's status line: the view's own sentence, else its busy label as one.
  function busySentence(p: NonNullable<QView["primary"]>): string {
    return p.busyText ?? `${p.busyLabel ?? p.label}. Keep this page open.`;
  }

  function lockedView(reason: string, s: SetupSnapshot): QView {
    const target = resumeQ(s);
    return {
      title: "This step is not open yet",
      lede: [reason],
      body: [],
      primary: { label: "Go to the open question", run: () => go(target) },
    };
  }

  const resolve = (): void => {
    const s = model.get();
    // A console the shell counts set up, in a tab that did not run setup: its draft holds none of the answers,
    // so every plan and receipt line would be false. Overview has the estate as it is; the team invite and the
    // engine's own check read the engine, so they stay (setupDoneElsewhere, STANDALONE_QS).
    if (setupDoneElsewhere(s) && (urlQ === null || !STANDALONE_QS.has(urlQ))) {
      leaving = true;
      progressHost.replaceChildren();
      plan.replaceChildren();
      stageHost.replaceChildren();
      queueMicrotask(() => {
        if (stale()) return;
        navigate("/", { replace: true });
        toast({ message: "Setup is already done on this engine. Each setting is on its own screen." });
      });
      return;
    }
    if (urlQ === null) {
      const target = step === null ? resumeQ(s) : firstOfStep(s, step);
      queueMicrotask(() => { if (!stale()) go(target, { replace: true }); });
      return;
    }
    mount(urlQ, s);
    paintPlan(s, true);
  };

  const unsubscribe = model.subscribe((s) => {
    if (stale()) {
      unsubscribe();
      return;
    }
    paintPlan(s);
    view?.onSnapshot?.(s);
  });
  const offLive = onLiveInstall(() => {
    if (stale()) offLive();
    else paintPlan(model.get());
  });

  // The engine check (Welcome's first line): on a console with no engine client it also connects to this
  // origin, so it runs before the first read.
  void probeEngine();
  // A FULL read, not any read: the shell's and Overview's reads (setup-read.ts) set readAt too, but they list
  // no resources, so a setup entered through "/" in a new tab would otherwise show Protect with nothing to pick.
  if (model.get().facts.fullReadAt === 0) {
    const loading = h("h1", { class: "fb-h1", tabindex: "-1" }, "Reading your engine");
    // The action bar is there from the first frame, its primary busy at the anchored position, so the page does
    // not grow a bar when the engine answers (craft review m5).
    const waiting = h(
      "div",
      { class: "fb-actions" },
      h(
        "div",
        { class: "fb-actions__row" },
        h("button", { "data-dp": "setup.button.focus-flow", class: "btn btn--primary btn--lg fb-primary", type: "button", "aria-disabled": "true", "aria-busy": "true", "data-busy": "true" }, h("span", { class: "btn__spinner", "aria-hidden": "true" }), h("span", { class: "fb-primary__label" }, urlQ === null || urlQ === "welcome" ? "Start" : "Continue")),
        h("p", { class: "fb-reason", role: "status" }, "Reading your engine."),
      ),
    );
    stageHost.replaceChildren(h("div", { class: "fb-stage" }, h("div", { class: "fb-head" }, h("p", { class: "fb-eyebrow" }, "Set up downpipes"), loading), waiting));
    void model.refresh().finally(() => {
      if (stale()) return;
      resolve();
      const a = document.activeElement;
      if (root.isConnected && (a === null || a === document.body || a === loading)) arrivalFocus()?.focus();
    });
  } else {
    resolve();
    if (Date.now() - model.get().facts.fullReadAt > 5000) void model.refresh();
  }
  paintPlan(model.get());
  requestPostNavigationFocus(() => {
    applyTitle();
    finishChange(root);
    // The tour's welcome card can be open over setup (tour mode). It is the visitor's first choice and holds
    // focus: keep it there. The card hands focus to this page's heading when it closes (persona-fork.ts).
    const active = document.activeElement as HTMLElement | null;
    if (active !== null && active.closest?.("#tour-persona-fork") != null) return active;
    return arrivalFocus();
  });
  return root;
}
