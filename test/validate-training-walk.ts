// The training-walk contract: the Beginner script binds to the SHIPPING screens, its graders gate the way
// the walk promises, and the whole 30-minute sequence completes over the demo world in walk order.
//
// WHY THIS EXISTS. The training walk is a page-by-page course over the real console, which makes it a
// surface every console change can silently break: a renamed route, a dropped data-tour-id, a grader that
// no longer agrees with the write handler it watches, a task that can never complete. validate-tour.ts
// closes this class for the tour's two persona walks; this file closes it for the training walk, and adds
// the training-specific halves the tour does not have: the SEQUENCE matters (each chapter's screen must
// render correctly against the world as the PREVIOUS chapters left it, because the setup-first gating and
// the empty states are the curriculum), and every task must be provably completable by the learner action
// its instruction names, with its grader false before and true after.
//
// The real-browser half (the shipped bundle, real CSP, real clicks at four viewports) is the harness's
// training-walk journey; this file is the fast, per-push half that runs inside validate:chain.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const g = globalThis as unknown as Record<string, unknown>;
g.location = g.location ?? { origin: "https://console.test", search: "", hostname: "console.test", href: "https://console.test/" };
if (typeof (g as { MutationObserver?: unknown }).MutationObserver !== "function") {
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  };
}

const { isTrainingMode } = await import("../src/lib/demo/training-mode.ts");
const demoWorldModule = await import("../src/lib/demo/demo-world.ts");
const { applyDemoState, resetWorld } = demoWorldModule;
const { route } = await import("../src/lib/demo/demo-routes-read.ts");
const { installDemoFetch } = await import("../src/lib/demo/demo-fetch.ts");
const { onDemoRoute, notifyDemoRoute } = await import("../src/lib/demo/demo-route-signal.ts");
const { TRAINING_BEGINNER } = await import("../src/lib/demo/tour/scripts/training-beginner.ts");
const { createTourDirector } = await import("../src/lib/demo/tour/director.ts");
const { SCREENS } = await import("../src/lib/app-registry.ts");
const { overviewScreen } = await import("../src/screens/overview.ts");
const { routesOf } = await import("../src/screens/common.ts");
const { connect, setCaller, getEngine } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");
const { buildCallerFromWhoami } = await import("../src/lib/app-identity.ts");
const { flushAsync, keydown, dispatchDocKey } = await import("./dom-shim.ts");

type Screen = import("../src/screens/common.ts").Screen;
type ScreenContext = import("../src/screens/common.ts").ScreenContext;
type WhoAmI = import("../src/lib/api/types.ts").WhoAmI;
type NavBar = import("../src/lib/demo/tour/nav-bar.ts").NavBar;
type NavBarBeat = import("../src/lib/demo/tour/nav-bar.ts").NavBarBeat;
type Spotlight = import("../src/lib/demo/tour/spotlight.ts").Spotlight;
type InfoPoint = import("../src/lib/demo/tour/director.ts").InfoPoint;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

console.log("-- Training-walk contract guard (the Beginner course over the demo world) --");

// ---------------------------------------------------------------------------------------------------
// 1. The mode guard: training activates by its hostname or the dev-host flag, and NOWHERE else.
// ---------------------------------------------------------------------------------------------------
ok("training OFF by default (normal host, no flag)", isTrainingMode({ hostname: "console.example", search: "" } as Location) === false);
ok("training ON on the decided training hostname (training.downpipes.io)", isTrainingMode({ hostname: "training.downpipes.io", search: "" } as Location) === true);
ok("training ON with ?training= on a DEV host", isTrainingMode({ hostname: "localhost", search: "?training=1" } as Location) === true);
ok("training OFF with ?training= on the production console (the flag is dev-host-scoped)", isTrainingMode({ hostname: "console.downpipes.io", search: "?training=1" } as Location) === false);
ok("training OFF with ?training= on the tour host (the two public modes never cross)", isTrainingMode({ hostname: "tour.downpipes.io", search: "?training=1" } as Location) === false);

// ---------------------------------------------------------------------------------------------------
// 2. The training boot: a fresh account, the seeded owner, the setup gate engaged.
// ---------------------------------------------------------------------------------------------------
resetWorld(Date.now());
applyDemoState({ kind: "training-start" });
const who = JSON.parse(await (await route("/admin/whoami")).text()) as WhoAmI;
const caller = buildCallerFromWhoami(who);
setCaller(caller);
connect(location.origin);
const engine = getEngine();
ok("the training world boots connected as the seeded owner", engine !== null && caller.role === "owner");
{
  const setup = JSON.parse(await (await route("/admin/setup-state")).text()) as { keysReady: boolean; ready: boolean };
  ok("and the setup gate is engaged (keysReady false, not ready)", setup.keysReady === false && setup.ready === false);
}

// ---------------------------------------------------------------------------------------------------
// 3. The walk, in order: every chapter's screen binds, every anchor resolves against the world AS THE
//    PRIOR CHAPTERS LEFT IT, and every task's grader is false before its named learner action and true
//    after. The sequence is the curriculum, so this block never shuffles or dedupes.
// ---------------------------------------------------------------------------------------------------
{
  const savedFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const path = new URL(url, location.origin).pathname + new URL(url, location.origin).search;
    if (path.startsWith("/admin/")) {
      const effectiveInit = init ?? (input instanceof Request ? { method: input.method } : undefined);
      return Promise.resolve(route(path, effectiveInit));
    }
    return savedFetch(input, init);
  }) as typeof fetch;

  const allScreens: Screen[] = [overviewScreen, ...SCREENS];
  const matchRoute = (pattern: string, path: string): boolean => {
    const a = pattern.split("/");
    const b = path.split("/");
    return a.length === b.length && a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
  };
  const screenForRoute = (path: string): Screen | undefined => allScreens.find((s) => routesOf(s).some((rt) => matchRoute(rt, path.split("?")[0]!)));
  const renderRoute = (path: string): void => {
    document.getElementById("main")?.remove();
    const main = document.createElement("main");
    main.id = "main";
    document.body.appendChild(main);
    const screen = screenForRoute(path);
    if (!screen || engine === null) return;
    const base = path.split("?")[0]!;
    const pattern = routesOf(screen).find((rt) => matchRoute(rt, base)) ?? base;
    const params: Record<string, string> = {};
    const pa = pattern.split("/");
    const pb = base.split("/");
    pa.forEach((seg, i) => {
      if (seg.startsWith(":")) params[seg.slice(1)] = pb[i]!;
    });
    const query = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
    const ctx: ScreenContext = { pattern, params, query, path, engine, caller, navigate: (to: string) => renderRoute(to) };
    main.appendChild(screen.render(ctx));
  };
  installNav({ navigate: (to) => renderRoute(to), onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  // The learner actions, one per task, exactly what each task's instruction names, expressed as the same
  // /admin/* writes the screens issue. A task with no action here fails loudly below: an untestable task
  // is a course step nobody can prove completable.
  const post = (path: string, body: unknown): Promise<Response> => Promise.resolve(route(path, { method: "POST", body: JSON.stringify(body) }));
  const learnerActions: Record<string, () => Promise<void>> = {
    "Work through the setup cards and install your keys": async () => {
      await post("/admin/keys/install", { token: "training-one-shot", signerPrivate: "x", breakGlassPublic: "y" });
    },
    "Fill in the form and press Verify and save": async () => {
      await post("/admin/destinations", { label: "Training archive", config: { endpoint: "https://demoacct.r2.cloudflarestorage.com", bucket: "training-archive", region: "auto" } });
    },
    "Paste any token, press Verify and save, and see your account appear": async () => {
      await post("/admin/sources/discovery-token", { token: "any-training-placeholder" });
    },
    "Press Add a source and attach a binding": async () => {
      await post("/admin/sources/attach", { token: "training-one-shot", sources: [{ type: "kv", binding: "PAYMENTS_KV", namespaceId: "demo-kv-payments" }], remove: [] });
    },
    "Press New downpipe and create your first one": async () => {
      await post("/admin/downpipes", { id: "dp-payments-training", name: "Payments store", cadenceSeconds: 86_400, enabled: true, source: { type: "kv", binding: "PAYMENTS_KV", include: [], exclude: [] } });
    },
    "Open your downpipe, press Run now, and wait for it to finish": async () => {
      await post("/admin/trigger", { id: "dp-payments-training" });
      await route("/admin/history?id=dp-payments-training");
      await route("/admin/history?id=dp-payments-training");
    },
    "Open the downpipe, rerun it, and watch it settle clean": async () => {
      await post("/admin/trigger", { id: "dp-payments-training" });
      await route("/admin/history?id=dp-payments-training");
      await route("/admin/history?id=dp-payments-training");
    },
  };

  for (const [chapterIdx, chapter] of TRAINING_BEGINNER.entries()) {
    const label = `chapter ${chapterIdx + 1} (${chapter.title})`;
    // The time jump applies at the boundary, once, exactly as the director applies it.
    if (chapter.worldTransform) {
      chapter.worldTransform();
    }
    ok(`${label}: a shipping screen owns route ${chapter.route}`, screenForRoute(chapter.route) !== undefined);
    renderRoute(chapter.route);
    await flushAsync(8);
    if (chapter.preAction) {
      try {
        await chapter.preAction();
      } catch {
        // best-effort, exactly as the director treats it; a genuinely missing anchor fails below
      }
      await flushAsync(10);
    }
    // The onboarding deck is the one full-bleed screen with no page header; its own root is the
    // readiness signal there, exactly as the director's SCREEN_READY_SELECTOR accepts.
    ok(`${label}: the screen rendered its readiness signal`, document.querySelector(".page-header__title, .ob-page") !== null);
    const anchors = [...new Set(chapter.infoPoints.map((p) => p.anchor))];
    let unresolved = anchors;
    for (let r = 0; r < 6 && unresolved.length > 0; r++) {
      unresolved = anchors.filter((a) => document.querySelector(`[data-tour-id="${a}"]`) === null);
      if (unresolved.length > 0) await flushAsync(4);
    }
    ok(`${label}: every beat anchor resolves on the live screen${unresolved.length > 0 ? ` (missing: ${unresolved.join(", ")})` : ""}`, unresolved.length === 0);
    for (const beat of chapter.infoPoints) {
      if (beat.doc) {
        ok(`${label}: the doc link is a docs.downpipes.io URL (${beat.doc.href})`, beat.doc.href.startsWith("https://docs.downpipes.io/"));
      }
      if (!beat.task) continue;
      // A HANDS-ON step must point at something the learner can press. The spotlight puts a "Your task is
      // here" chip on the beat's anchor, and an anchor on prose leaves that chip pulsing over a line that
      // does nothing when clicked (measured on the fix-and-rerun step, whose anchor was the failure
      // verdict's title text). Checked on every task beat of the walk, not the one that was reported.
      type ShimEl = { tagName?: string; getAttribute?: (n: string) => string | null; querySelector?: (sel: string) => unknown; parentElement?: unknown };
      const anchorEl = document.querySelector(`[data-tour-id="${beat.anchor}"]`) as unknown as ShimEl | null;
      const CONTROLS = "button, a[href], input, select, textarea, [role=\"button\"]";
      const PRESSABLE = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"]);
      // Is it a control, does it contain one, or does it sit inside one? A table row wired for activation
      // is role=button and focusable, which is a real control even though it is a <tr>. (Walked by hand:
      // the shim carries no matches()/closest(), and this validator runs under it.)
      const inControl = (node: ShimEl | null): boolean => {
        for (let n = node, hops = 0; n !== null && n !== undefined && hops < 12; hops++) {
          const role = n.getAttribute?.("role") ?? "";
          if (PRESSABLE.has((n.tagName ?? "").toUpperCase()) || role === "button" || role === "link") return true;
          n = n.parentElement as ShimEl | null;
        }
        return false;
      };
      const interactive = anchorEl !== null && (inControl(anchorEl) || anchorEl.querySelector?.(CONTROLS) != null);
      ok(`${label}: the hands-on step's anchor "${beat.anchor}" is something the learner can press`, interactive);
      const action = learnerActions[beat.task.label];
      ok(`${label}: the task "${beat.task.label}" has a named learner action`, action !== undefined);
      if (action === undefined) continue;
      ok(`${label}: the grader is FALSE before the learner acts`, beat.task.done() === false);
      await action();
      await flushAsync(4);
      ok(`${label}: the grader is TRUE after the named action`, beat.task.done() === true);
    }
  }

  // The walk's end state is the standup the course promises: setup complete, a clean run at the head over
  // a recorded failure, a month of history behind it.
  const setup = JSON.parse(await (await route("/admin/setup-state")).text()) as { ready: boolean; anyRunCompleted: boolean };
  ok("the walk ends READY with a completed run", setup.ready === true && setup.anyRunCompleted === true);
  const ring = demoWorldModule.world.historyByDownpipe["dp-payments-training"] ?? [];
  ok("the ring holds the month of history plus the failure story (over 30 entries, one failed)", ring.length > 30 && ring.some((e) => e.status === "failed"));
  globalThis.fetch = savedFetch;
}

// ---------------------------------------------------------------------------------------------------
// 4. The director's task gate: Next cannot skip an unmet task, the nudge narrates why, and the grader
//    passing (signalled by a settled demo request) advances the walk on its own.
// ---------------------------------------------------------------------------------------------------
{
  let taskDone = false;
  const announced: string[] = [];
  const taskDoneModes: string[] = [];
  const nudged: string[] = [];
  let lastBeat: NavBarBeat | null = null;
  const navSpy: NavBar = {
    update() {},
    setControls() {},
    setPlaying() {},
    setInfoVisible() {},
    setSpeed() {},
    setBeat(b) {
      lastBeat = b;
    },
    handOverTask() {},
    markTaskDone(mode) {
      taskDoneModes.push(mode ?? "just-done");
    },
    nudgeTask(text: string) {
      nudged.push(text);
    },
    refreshBeatDefault() {},
    setGoal() {},
    setChapters() {},
    setCtas() {},
    setEarlyExit() {},
    setDwellActive() {},
    announce(msg: string) {
      announced.push(msg);
    },
    focusBar() {},
    root: document.createElement("div"),
    destroy() {},
  };
  const spotSpy = { target() {}, destroy() {} } as unknown as Spotlight;
  const gateScript = [
    {
      route: "/",
      title: "Gate check",
      infoPoints: [
        { anchor: "overview-fleet-health", title: "The task", body: "Prove the gate.", task: { label: "flip the flag", done: () => taskDone } },
        { anchor: "overview-fleet-health", title: "Past the gate", body: "You are through." },
      ] as InfoPoint[],
    },
  ];
  const director = createTourDirector(gateScript, {
    navigate: () => {},
    clearLeaveGuard: () => {},
    mountNav: () => navSpy,
    mountSpot: () => spotSpy,
    reseed: () => {},
    renderTimeoutMs: 30,
    renderPollMs: 5,
  });
  director.start();
  await flushAsync(12);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const beatBefore: NavBarBeat | null = lastBeat;
  ok("the task beat presents its instruction on the rail", beatBefore !== null && (beatBefore as NavBarBeat).task === "flip the flag");
  director.next();
  await flushAsync(4);
  ok("Next does NOT advance past an unmet task", lastBeat !== null && (lastBeat as NavBarBeat).title === "The task");
  ok("and the nudge narrates the instruction", announced.some((a) => a.includes("Finish this step first") && a.includes("flip the flag")));
  ok("and the refusal is put ON the card too, so a sighted learner is not left with a dead button", nudged.some((n) => n.includes("Finish this step first") && n.includes("flip the flag")));
  taskDone = true;
  notifyDemoRoute();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await flushAsync(6);
  ok("the grader passing advances the walk on its own (the demo-route signal)", lastBeat !== null && (lastBeat as NavBarBeat).title === "Past the gate");
  ok("the pass is reported to the rail as the learner's action landing NOW", taskDoneModes.includes("just-done"));

  // ---------------------------------------------------------------------------------------------------
  // 4b. BACK THROUGH A FINISHED TASK. A learner must be able to return to a stage they have completed and
  //     read it again. The grader still passes there, so re-arming it used to see the pass at once and
  //     throw the learner forward again: every completed step was a wall against going back. Walking back
  //     onto a passed task must present that beat, mark the card as already done, and STAY.
  // ---------------------------------------------------------------------------------------------------
  director.back();
  await flushAsync(6);
  ok("Back returns to the completed task beat", lastBeat !== null && (lastBeat as NavBarBeat).title === "The task");
  ok("and the card reads as already done, not as a fresh pass", taskDoneModes[taskDoneModes.length - 1] === "already-done");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await flushAsync(6);
  ok("and the walk STAYS there (a passing grader on arrival never auto-advances)", lastBeat !== null && (lastBeat as NavBarBeat).title === "The task");
  director.next();
  await flushAsync(4);
  ok("Next still goes forward from a completed task (the gate is open, not sticky)", lastBeat !== null && (lastBeat as NavBarBeat).title === "Past the gate");
  director.destroy();
}

// ---------------------------------------------------------------------------------------------------
// 4c. The course's own orientation contract: every chapter says what it is for, every hands-on chapter
//     tells the learner where its task sits, and the rail is told both. A stage with no goal is a stage a
//     learner walks blind, which is the report this section exists to keep closed.
// ---------------------------------------------------------------------------------------------------
{
  for (const [i, chapter] of TRAINING_BEGINNER.entries()) {
    const goal = chapter.goal ?? "";
    ok(`chapter ${i + 1} (${chapter.title}) states its goal`, goal.length > 20);
  }
  const taskChapters = TRAINING_BEGINNER.filter((c) => c.infoPoints.some((b) => b.task !== undefined));
  ok("seven of the eight chapters are hands-on (the wrap is the reader)", taskChapters.length === 7);

  // The rail's step line is DERIVED, so it is checked against the same beats the director reads: the
  // hands-on step of the chapter, 1-based, is what a learner is told to aim for.
  const beats: NavBarBeat[] = [];
  const navSpy = {
    update() {}, setControls() {}, setPlaying() {}, setInfoVisible() {}, setSpeed() {},
    setBeat(b: NavBarBeat | null) { if (b) beats.push(b); },
    markTaskDone() {}, handOverTask() {}, nudgeTask() {}, refreshBeatDefault() {}, setGoal() {}, setChapters() {}, setCtas() {}, setEarlyExit() {},
    setDwellActive() {}, announce() {}, focusBar() {}, root: document.createElement("div"), destroy() {},
  } as NavBar;
  const goals: string[] = [];
  const navSpyWithGoal: NavBar = { ...navSpy, setGoal(text: string | null) { goals.push(text ?? ""); } };
  const script = [
    {
      route: "/",
      title: "Three beats, task last",
      goal: "Prove the goal reaches the rail.",
      infoPoints: [
        { anchor: "overview-fleet-health", title: "One", body: "Read." },
        { anchor: "overview-fleet-health", title: "Two", body: "Read." },
        { anchor: "overview-fleet-health", title: "Three", body: "Do.", task: { label: "do it", done: () => false } },
      ] as InfoPoint[],
    },
  ];
  const director = createTourDirector(script, {
    navigate: () => {}, clearLeaveGuard: () => {}, mountNav: () => navSpyWithGoal,
    mountSpot: () => ({ target() {}, destroy() {} }) as unknown as Spotlight,
    reseed: () => {}, renderTimeoutMs: 30, renderPollMs: 5,
  });
  director.start();
  await flushAsync(12);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const first = beats[0];
  ok("the rail is told the chapter's goal", goals.includes("Prove the goal reaches the rail."));
  ok("the rail is told where the hands-on step is (step 3 of 3, from step 1)", first !== undefined && first.taskAtStep === 3 && first.index === 0 && first.count === 3);
  director.destroy();
}

// ---------------------------------------------------------------------------------------------------
// 5. The signal wiring: the installed demo fetch fires the route signal after a settled request, which
//    is the only thing that makes section 4's auto-advance real in production.
// ---------------------------------------------------------------------------------------------------
{
  const realFetch = installDemoFetch();
  let fired = 0;
  const dispose = onDemoRoute(() => {
    fired++;
  });
  await fetch("/admin/status");
  await flushAsync(2);
  ok("a settled /admin/* request notifies the route signal", fired > 0);
  dispose();
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------------------------------
// 6. The INTRODUCTION: the course opens by saying what it is, and the walk starts only when the learner
//    starts it. A course that begins mid-task teaches nothing in its first minute.
// ---------------------------------------------------------------------------------------------------
{
  const { mountTrainingIntro } = await import("../src/lib/demo/tour/training-intro.ts");
  let started = 0;
  const intro = mountTrainingIntro({ onStart: () => { started++; } });
  const mounted = document.getElementById("training-intro");
  ok("the intro card mounts as a labelled dialog", mounted !== null && mounted.getAttribute("role") === "dialog");
  const text = mounted?.textContent ?? "";
  ok("it says the console is a replica in the learner's browser", text.includes("inside your browser"));
  ok("it says the credentials are placeholders", text.includes("type anything"));
  // The two facts a learner needs before anything moves, now that the course plays itself: that it will move
  // on without being asked, and that it will STOP where the work is theirs. A learner told neither sits
  // waiting for a button on a course that is already waiting for them.
  ok("it says how many stages there are", text.includes("eight stages"));
  ok("it says the course plays itself and stops for the learner", text.includes("plays itself") && text.includes("It stops at every step you do yourself"));
  ok("it says Back keeps the learner's work", text.includes("Back returns to any stage"));
  ok("it offers exactly one action, and it is Start", (mounted?.querySelectorAll("button").length ?? 0) === 1);
  // A phone has no Escape key, so the sentence about one is left off a touch device. Under the shim there
  // is no matchMedia, which reads as a keyboard device, so the hint is expected here.
  ok("the keyboard hint is present on a keyboard device", text.includes("Escape starts it too"));
  ok("nothing has started while the card is up", started === 0);
  intro.start();
  ok("starting the card runs the walk", started === 1);
  ok("and the card is gone", document.getElementById("training-intro") === null);
  intro.start();
  ok("a second start is a no-op (one course per launch)", started === 1);

  // Escape starts the course as well, so a keyboard learner is never held by a card they cannot dismiss.
  let escStarted = 0;
  mountTrainingIntro({ onStart: () => { escStarted++; } });
  dispatchDocKey(keydown({ key: "a" }));
  ok("an unrelated key leaves the card up", escStarted === 0 && document.getElementById("training-intro") !== null);
  dispatchDocKey(keydown({ key: "Escape" }));
  ok("Escape starts the course", escStarted === 1 && document.getElementById("training-intro") === null);
  dispatchDocKey(keydown({ key: "Escape" }));
  ok("and the key layer is gone with the card (a later Escape starts nothing)", escStarted === 1);

  // A second mount over a live card never stacks two courses; it hands back the card that is up.
  const first = mountTrainingIntro({ onStart: () => {} });
  let secondStarted = 0;
  const second = mountTrainingIntro({ onStart: () => { secondStarted++; } });
  second.start();
  ok("a second mount returns the live card and starts nothing of its own", secondStarted === 0 && second.root === first.root);
  second.destroy();
  ok("and destroying it clears the card", document.getElementById("training-intro") === null);
}

// ---------------------------------------------------------------------------------------------------
// 7. NARRATION. The course speaks every step, the audio committed under public/narration was rendered
//    from the words the script carries NOW, and sound is ON unless the learner turned it off.
// ---------------------------------------------------------------------------------------------------
{
  const { createHash } = await import("node:crypto");
  const { readFileSync, existsSync, statSync } = await import("node:fs");
  const { announcementTextFor, narrationTextFor, narrationStepId } = await import("../src/lib/demo/tour/narration-text.ts");
  const { createNarrator } = await import("../src/lib/demo/tour/narration.ts");

  const manifestPath = "public/narration/manifest.json";
  ok("the narration manifest is committed", existsSync(manifestPath));
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { voice: string; steps: Array<{ id: string; file: string; sha256: string }> };
    ok("it is spoken by the chosen voice (Kokoro af_heart)", manifest.voice === "af_heart");
    const byId = new Map(manifest.steps.map((s) => [s.id, s]));
    let missing = 0;
    let stale = 0;
    let absent = 0;
    for (const [ci, chapter] of TRAINING_BEGINNER.entries()) {
      for (const [bi, beat] of chapter.infoPoints.entries()) {
        const id = narrationStepId(ci, bi);
        const row = byId.get(id);
        if (!row) { missing++; continue; }
        if (row.sha256 !== createHash("sha256").update(narrationTextFor(beat)).digest("hex")) stale++;
        const p = `public/narration/${row.file}`;
        if (!existsSync(p) || statSync(p).size < 2000) absent++;
      }
    }
    ok("every step of the walk has narration", missing === 0);
    ok("every step's audio was rendered from the words the script carries now", stale === 0);
    ok("and every named file is on disk with real audio in it", absent === 0);
  }

  // The spoken text is the rail's announcement WITHOUT the heading, which is what makes one hash cover both.
  const sample = TRAINING_BEGINNER[0]!.infoPoints[2]!;
  // The hand-over is SPOKEN, not merely drawn: the course stops talking at a hands-on step, and silence on
  // its own reads as a fault. The voice is what tells a learner their turn has come.
  const spoken = narrationTextFor(sample);
  ok("the spoken text hands over in words, and carries the task", spoken.includes("Now it is your turn.") && spoken.includes(sample.task?.label ?? "\u0000") && spoken.startsWith(sample.body));
  // NO STEP IS READ ITS OWN HEADING. A card heading is written to be seen above the paragraph it labels, and
  // spoken aloud it sounds like a page being read out. Checked over every beat of the walk, not one sample.
  let headingSpoken = 0;
  for (const chapter of TRAINING_BEGINNER) {
    for (const beat of chapter.infoPoints) {
      if (narrationTextFor(beat).startsWith(`${beat.title}.`)) headingSpoken++;
    }
  }
  ok("no step is read its own heading aloud", headingSpoken === 0);
  // The screen reader still gets it: a learner who cannot see the card needs the heading said, and the
  // announcement is composed FROM the spoken text so the two cannot drift over the words.
  const announced = announcementTextFor(sample);
  ok("but a screen reader is still told the heading, then the same words", announced === `${sample.title}. ${spoken}`);
  ok("and it says what ends the turn", spoken.includes("starts again by itself") && spoken.includes("press Next"));
  ok("the step id matches the manifest numbering (1-based chapter and beat)", narrationStepId(2, 1) === "3-2");

  // Sound is ON for a learner who has never chosen, and the choice is honoured when they do.
  const narrator = createNarrator(document);
  ok("sound is ON by default (a course a learner chose is meant to speak)", narrator.enabled() === true);
  narrator.setEnabled(false);
  ok("turning it off is honoured", narrator.enabled() === false);
  const second = createNarrator(document);
  ok("and remembered for the next narrator (the preference is stored)", second.enabled() === false);
  second.setEnabled(true);
  ok("turning it back on is honoured too", createNarrator(document).enabled() === true);
  narrator.destroy();
  second.destroy();
}

// ---------------------------------------------------------------------------------------------------
// 8. THE PLACEHOLDER CUE. Every credential field the course shows says, on the screen, that any value
//    works. A learner who thinks they need a real Cloudflare token stops at the first form.
// ---------------------------------------------------------------------------------------------------
{
  const { mountTrainingFieldCues } = await import("../src/lib/demo/tour/training-field-cue.ts");
  document.getElementById("main")?.remove();
  const main = document.createElement("main");
  main.id = "main";
  const wrap = document.createElement("div");
  wrap.className = "field";
  const input = document.createElement("input");
  input.setAttribute("type", "password");
  wrap.appendChild(input);
  main.appendChild(wrap);
  document.body.appendChild(main);

  const cues = mountTrainingFieldCues(document);
  const cueText = (): string => document.querySelector("[data-training-cue]")?.textContent ?? "";
  ok("a credential field gets a cue on the screen", cueText().length > 0);
  ok("and the cue says any value works, in plain words", cueText().includes("type anything") && cueText().includes("No real credential"));
  cues.refresh();
  ok("a second pass does not stack a second cue on the same field", document.querySelectorAll("[data-training-cue]").length === 1);
  cues.destroy();
  ok("destroy removes every cue (nothing is left on a screen the course no longer owns)", document.querySelectorAll("[data-training-cue]").length === 0);
  main.remove();
}

// ---------------------------------------------------------------------------------------------------
// 9. THE PACE IS THE VOICE, and the hand-over is where the course stops.
//
//    A narrated course paced by the READING dwell talks over itself: the dwell is 45ms a character capped
//    at 15 seconds, tuned for the eye, and the same words spoken run about twice as long. So the player
//    reports how long a step actually is and when it ends, and the walk holds for that. What that leaves
//    to check here is the contract between the two, and it is checked with a player whose events this
//    test fires: the step's length is reported, its end is reported, a superseded step's end is NOT, and a
//    step that will never be spoken says so, because a walk waiting on a voice that is not coming would
//    hold forever.
// ---------------------------------------------------------------------------------------------------
{
  const { createNarrator } = await import("../src/lib/demo/tour/narration.ts");
  const { makeEvent } = await import("./dom-shim-core.ts");
  const fire = (el: { dispatchEvent(ev: unknown): boolean }, type: string): void => {
    el.dispatchEvent(makeEvent({ type }));
  };

  // The shim's <audio> has no play() and no duration, which is the browser's "this will not be spoken"
  // case reached honestly rather than by a flag: the player's own catch reports it.
  {
    const silent = createNarrator(document);
    let blocked = 0;
    let ended = 0;
    silent.speak("1-1", { onBlocked: () => { blocked++; }, onEnded: () => { ended++; } });
    ok("a step the browser will not play reports BLOCKED, so the walk can pace itself", blocked === 1 && ended === 0);
    ok("and the player says so when asked", silent.blocked() === true);
    silent.destroy();
  }

  // With a player that behaves, the two pacing facts arrive: how long the step is, and that it has finished.
  {
    const narrator = createNarrator(document);
    // The LAST element, not the first: section 7 leaves orphan players behind (it asserts the remembered
    // preference by constructing throwaway narrators), and stubbing the wrong one tests nothing.
    const players = document.querySelectorAll('audio[data-training-narration]');
    const el = (players[players.length - 1] ?? null) as unknown as {
      play(): void;
      pause(): void;
      duration: number;
      currentTime: number;
      dispatchEvent(ev: unknown): boolean;
    } | null;
    ok("the player mounts one reusable audio element", el !== null);
    if (el !== null) {
      el.play = (): void => {};
      el.pause = (): void => {};
      el.duration = 20.6;
      const seen: string[] = [];
      narrator.speak("1-1", { onDuration: (ms) => seen.push(`duration:${ms}`), onEnded: () => seen.push("ended") });
      fire(el, "loadedmetadata");
      ok("the step's real length is reported in milliseconds", seen[0] === "duration:20600");
      fire(el, "ended");
      ok("and its end is reported once", seen[1] === "ended" && seen.length === 2);

      // A learner moving on mid-step: the step they left must not report an end, or the walk advances twice.
      const stale: string[] = [];
      narrator.speak("1-2", { onEnded: () => stale.push("stale") });
      narrator.speak("1-3", { onEnded: () => stale.push("current") });
      fire(el, "ended");
      ok("a superseded step reports nothing: only the step now playing can end", stale.length === 1 && stale[0] === "current");

      // stop() is a teardown, not an end. A walk that treated it as one would advance on Exit.
      const stopped: string[] = [];
      narrator.speak("2-1", { onEnded: () => stopped.push("ended") });
      narrator.stop();
      fire(el, "ended");
      ok("stopping the course is not an ending (nothing advances behind an Exit)", stopped.length === 0);

      // Muting is the same: no end is owed, and the walk falls back to the reading dwell.
      const muted: string[] = [];
      narrator.speak("2-2", { onEnded: () => muted.push("ended") });
      narrator.setEnabled(false);
      fire(el, "ended");
      ok("muting mid-step reports no ending either", muted.length === 0);

      // Turning the sound back ON hands the pace to the voice again, and it must be THIS step's hooks that
      // come back. Handing back a previous step's hooks would pace the walk by the wrong step's length.
      const back: string[] = [];
      narrator.setEnabled(true, "2-2");
      narrator.speak("2-2", { onEnded: () => back.push("ended") });
      narrator.setEnabled(false);
      narrator.setEnabled(true, "2-2");
      fire(el, "ended");
      ok("turning the sound back on restores the pace to the step now showing", back.length === 1);

      // A step whose FILE will not load is the same problem as a refused play: nothing will ever end, so
      // the walk has to be told, or it holds on that step until its guard expires.
      const broken: string[] = [];
      narrator.speak("9-9", { onBlocked: () => broken.push("blocked") });
      fire(el, "error");
      ok("audio that will not load reports BLOCKED rather than leaving the walk waiting", broken.length === 1);

      // The browser's autoplay policy refusing: play() rejects, and the walk is told the same way.
      const refused: string[] = [];
      el.play = (): Promise<void> => Promise.reject(new Error("NotAllowedError"));
      narrator.speak("1-1", { onBlocked: () => refused.push("blocked") });
      await new Promise((r) => setTimeout(r, 0));
      ok("a browser refusing to play reports BLOCKED, and the course carries on in text", refused.length === 1 && narrator.blocked() === true);

      // And a play the browser allows clears the refusal, so the rail stops explaining a silence that ended.
      el.play = (): Promise<void> => Promise.resolve();
      narrator.speak("1-2", {});
      await new Promise((r) => setTimeout(r, 0));
      ok("a play the browser allows clears the refusal", narrator.blocked() === false);
    }
    narrator.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------
// 10. THE TASK CARD'S THREE STATES. The card is the visible join between the console and the course, and
//     the middle state is the one this round added: the course has finished explaining and has STOPPED,
//     and the learner is now driving. Without it the words simply run out, which reads as a fault.
// ---------------------------------------------------------------------------------------------------
{
  const { buildCourseParts } = await import("../src/lib/demo/tour/nav-bar-course.ts");
  const parts = buildCourseParts({ eyebrow: "Beginner course" });
  const chip = (): string => (parts.taskCardEl.querySelector("[data-tour-task-chip]")?.textContent ?? "").trim();
  const hint = (): string => (parts.taskCardEl.querySelector("[data-tour-task-hint]")?.textContent ?? "").trim();

  parts.handOverTask();
  ok("handing over with no task card showing does nothing", parts.taskCardEl.style.getPropertyValue("display") === "none" && chip() === "YOUR TASK");

  parts.setTask("Fill in the form and press Verify and save");
  ok("a task beat paints the card in its waiting state", chip() === "YOUR TASK" && hint().includes("The course waits here"));

  parts.handOverTask();
  ok("the hand-over changes the chip to the learner's turn", chip() === "YOUR TURN");
  ok("and says what happens while they work, and what to do if nothing does", hint().includes("starts again by itself") && hint().includes("press Next"));

  parts.markTaskDone("just-done");
  ok("their work landing flips the same card to done", chip() === "DONE" && hint().includes("moves on in a moment"));

  // Entering the NEXT task beat must reset the card: a stale YOUR TURN on a step the course is still
  // explaining would tell the learner to act before it has said what to do.
  parts.setTask("Press Add source and attach a binding");
  ok("the next task beat resets the card to waiting", chip() === "YOUR TASK" && hint().includes("The course waits here"));
}

// ---------------------------------------------------------------------------------------------------
// 11. THE READING PACE, which a NARRATED walk does not offer at all (the voice is the pace there) and the
//     tour does. It moved out of the director when that file crossed its size ceiling, so it is checked
//     here on its own: the cycle order, that the choice is remembered, and that a stored value the option
//     list no longer has falls back rather than throwing.
// ---------------------------------------------------------------------------------------------------
{
  const { createReadingSpeed } = await import("../src/lib/demo/tour/reading-speed.ts");
  try { localStorage.removeItem("downpipes:tour:speed"); } catch { /* the shim's storage is always present */ }

  const speed = createReadingSpeed();
  ok("a visitor who has never chosen reads at 1x", speed.label() === "1×" && speed.mul() === 1);
  ok("the first tap is FASTER, and a faster pace is a SHORTER hold", speed.cycle() === "2×" && speed.mul() === 0.5);
  ok("the second is slower, and a slower pace is a longer hold", speed.cycle() === "0.5×" && speed.mul() === 2);
  ok("and the cycle returns to where it started", speed.cycle() === "1×");

  speed.cycle();
  ok("the choice is remembered for the next visit", createReadingSpeed().label() === "2×");

  try { localStorage.setItem("downpipes:tour:speed", "99"); } catch { /* as above */ }
  ok("a stored pace this build no longer offers falls back to 1x rather than throwing", createReadingSpeed().label() === "1×");
  try { localStorage.removeItem("downpipes:tour:speed"); } catch { /* as above */ }

  // A private window blocks storage entirely. The pace must still work there; it simply is not remembered,
  // and a tour that threw on boot because it could not read a preference would be a worse failure than that.
  {
    const { installBlockedStorage, restoreMemoryStorage } = await import("./dom-shim-document.ts");
    installBlockedStorage();
    const blocked = createReadingSpeed();
    ok("storage blocked: the pace still starts at 1x rather than throwing", blocked.label() === "1×");
    ok("and it still cycles, for this session at least", blocked.cycle() === "2×" && blocked.mul() === 0.5);
    restoreMemoryStorage();
  }
}

// ---------------------------------------------------------------------------------------------------
// 12. THE WALK, PACED BY A VOICE, driven under the shim so the whole contract is one readable sequence:
//     it moves with nothing pressed, it holds a step for as long as the voice runs, it STOPS at the
//     hands-on step and says so, the learner's own work is what starts it again, and with no voice at all
//     it falls back to the reading dwell rather than waiting for one.
//
//     The narrator here is a stand-in whose events this test fires, which is the only way to hold a real
//     duration against a real hold without waiting out twenty seconds of audio a build machine cannot hear.
//     spec/journeys/training-autoplay.spec.ts is the other half: it measures the same contract against the
//     audio that actually ships.
// ---------------------------------------------------------------------------------------------------
{
  const pMain = document.createElement("main");
  pMain.id = "main";
  const pHead = document.createElement("h1");
  pHead.className = "page-header__title";
  pHead.textContent = "Course";
  pMain.appendChild(pHead);
  document.body.appendChild(pMain);

  // The stand-in player: it records what it was asked to say and hands back the hooks, so this test can end
  // a step when it chooses to.
  let spoken: string[] = [];
  let hooks: { onDuration?: (ms: number) => void; onEnded?: () => void; onBlocked?: () => void } = {};
  let voiceOn = true;
  const narrator = {
    speak(stepId: string, h: typeof hooks = {}): void { spoken.push(stepId); hooks = h; },
    stop(): void {},
    enabled(): boolean { return voiceOn; },
    setEnabled(on: boolean): void { voiceOn = on; },
  };

  let taskDone = false;
  const script = [
    {
      route: "/",
      title: "Stage one",
      goal: "Learn the shape of it.",
      infoPoints: [
        { anchor: "overview-fleet-health", title: "The first thing", body: "A sentence the course says." },
        { anchor: "overview-fleet-health", title: "Your part", body: "And now you do something.", task: { label: "Do the thing on the console", done: (): boolean => taskDone } },
      ],
    },
    { route: "/", title: "Stage two", infoPoints: [{ anchor: "overview-fleet-health", title: "Afterwards", body: "What that bought you." }] },
  ];

  const dir = createTourDirector(script, {
    navigate: () => {},
    reseed: () => {},
    autoplay: true,
    autoStart: true,
    speedControl: false,
    narrator,
    // Fast enough to drive, slow enough that a step which advanced on the READING dwell instead of the voice
    // is visibly early: the voice below is told to run 400ms, the dwell would be 20.
    dwellMs: () => 20,
    stepGapMs: 5,
    settleMs: 5,
  });

  const railChip = (): string => (document.getElementById("tour-nav-bar")?.querySelector("[data-tour-task-chip]")?.textContent ?? "").trim();
  const railStep = (): string => document.getElementById("tour-nav-bar")?.querySelector("[data-tour-beat-title]")?.textContent ?? "";
  const speedCtl = (): unknown => document.getElementById("tour-nav-bar")?.querySelector('[data-tour-action="speed"]') ?? null;

  dir.start();
  await flushAsync(4);
  ok("a course starts PLAYING (the tour starts paused; a course teaches from the first step)", railStep() === "The first thing");
  ok("and it speaks that step", spoken[0] === "1-1");
  ok("a narrated walk offers no speed cycler, because the pace is the voice", speedCtl() === null);

  // THE PACE IS THE DURATION, and this is the assertion that says so rather than one a fallback could also
  // satisfy. The voice reports a 60ms step; the reading dwell is 20ms and would have moved at once, and the
  // guard a walk holds on while a step's length is UNKNOWN is 45 seconds and would never move. So a walk
  // that is still on step one at 200ms and has moved by 1.2s is being paced by the number it was told, and
  // by neither of the other two. No ending is fired here at all.
  hooks.onDuration?.(60);
  await new Promise((r) => setTimeout(r, 200));
  await flushAsync(3);
  ok("the walk holds the step for the breath after the voice, not for the reading dwell", railStep() === "The first thing");
  await new Promise((r) => setTimeout(r, 1000));
  await flushAsync(4);
  ok("and then it moves, on the length the voice reported, with nothing pressed", railStep() === "Your part");
  ok("and the next step is spoken in turn", spoken[1] === "1-2");

  // The hands-on step: the card is painted as a task from the moment the step opens, and the course keeps
  // TALKING. It only changes hands when the voice has finished.
  ok("a hands-on step opens as a task, not yet as the learner's turn", railChip() === "YOUR TASK");
  hooks.onEnded?.();
  await flushAsync(4);
  ok("when the voice finishes a hands-on step, the course hands over", railChip() === "YOUR TURN");
  await new Promise((r) => setTimeout(r, 120));
  await flushAsync(3);
  ok("and it stays there: a learner's turn is not on a timer", railStep() === "Your part" && railChip() === "YOUR TURN");

  // Their work landing is what starts it again. Nothing is pressed here either.
  taskDone = true;
  notifyDemoRoute();
  await flushAsync(3);
  ok("the work landing marks the card done before anything moves", railChip() === "DONE");
  // The acknowledgement pause is a fixed 900ms, the same beat a try-it click gets: the learner has to SEE
  // their work land in the course before the course moves off it.
  await new Promise((r) => setTimeout(r, 1100));
  await flushAsync(4);
  ok("and the course picks itself up into the next stage, with nothing pressed", railStep() === "Afterwards");

  dir.destroy();
  document.getElementById("tour-nav-bar")?.remove();
  document.getElementById("tour-spotlight")?.remove();

  // WITH NO VOICE AT ALL the walk must still move, on the reading dwell. A course that only knew how to wait
  // for audio would stop dead for a learner who turned the sound off.
  {
    voiceOn = false;
    spoken = [];
    taskDone = false;
    const silentDir = createTourDirector(script, {
      navigate: () => {},
      reseed: () => {},
      autoplay: true,
      autoStart: true,
      speedControl: false,
      narrator,
      dwellMs: () => 20,
      stepGapMs: 5,
      settleMs: 5,
    });
    silentDir.start();
    await flushAsync(4);
    ok("a muted course still starts on the first step", railStep() === "The first thing");
    await new Promise((r) => setTimeout(r, 120));
    await flushAsync(4);
    ok("and it still moves, on the reading dwell, without waiting for a voice", railStep() === "Your part");
    await new Promise((r) => setTimeout(r, 120));
    await flushAsync(3);
    ok("a muted course hands over at the hands-on step exactly as a speaking one does", railChip() === "YOUR TURN");
    silentDir.destroy();
    document.getElementById("tour-nav-bar")?.remove();
    document.getElementById("tour-spotlight")?.remove();
    voiceOn = true;
  }

  pMain.remove();
}

// ---------------------------------------------------------------------------------------------------
// 13. THE LAUNCHER'S OWN CONFIGURATION, which nothing under this shim had ever run.
//
//     startTrainingWalk is where the course decides what kind of walk it is, and every one of those
//     decisions is a product decision a learner meets in the first ten seconds: it PLAYS rather than waiting
//     to be driven, it offers no speed cycler because its pace is a voice, it names itself a course on the
//     rail, and it opens on an introduction rather than mid-task. Flipping any of them was a one-word edit
//     in a file no shim test executed, and only a real browser would have caught it.
// ---------------------------------------------------------------------------------------------------
{
  const lMain = document.createElement("main");
  lMain.id = "main";
  const lHead = document.createElement("h1");
  lHead.className = "page-header__title";
  lHead.textContent = "Overview";
  lMain.appendChild(lHead);
  document.body.appendChild(lMain);

  const { startTrainingWalk } = await import("../src/lib/demo/tour/training-walk.ts");
  const walk = startTrainingWalk();
  ok("the launcher returns a director handle", typeof walk.start === "function");
  ok("a second call returns the SAME walk rather than mounting a second rail", startTrainingWalk() === walk);

  await flushAsync(6);
  const intro = document.getElementById("training-intro");
  ok("the course opens on its INTRODUCTION, not mid-task", intro !== null);

  (intro?.querySelector("[data-training-intro-start]") as { click(): void } | null)?.click();
  await flushAsync(6);

  const lBar = (): HTMLElement | null => document.getElementById("tour-nav-bar") as HTMLElement | null;
  const ctl = (hook: string): Element | null => lBar()?.querySelector(`[data-tour-toggle="${hook}"]`) ?? null;
  ok("starting it clears the introduction and raises the rail", document.getElementById("training-intro") === null && lBar() !== null);
  ok("the rail names the course rather than a tour", (lBar()?.querySelector("[data-tour-eyebrow]")?.textContent ?? "") === "Beginner course");
  ok("and it counts STAGES, so a bare pair of numbers never stands alone", (lBar()?.querySelector("[data-tour-chapter-title]")?.parentElement?.textContent ?? "").includes("Stage 1 of 8"));

  // THE PACING DECISIONS, asserted where a one-word edit to the launcher would red them: the course is
  // PLAYING (so the control on offer is Pause, not Play), and no speed cycler is offered at all.
  const playToggle = ctl("play") as { getAttribute(n: string): string | null } | null;
  ok("the course starts PLAYING: the autoplay control reads as pressed", playToggle !== null && playToggle.getAttribute("aria-pressed") === "true");
  ok("its accessible name is the one that stops it, because it is already running", playToggle?.getAttribute("aria-label") === "Pause autoplay");
  ok("no reading-speed cycler is offered, because the pace here is the voice", lBar()?.querySelector('[data-tour-action="speed"]') === null);
  ok("the sound control is offered, and reads as on", (ctl("sound") as { getAttribute(n: string): string | null } | null)?.getAttribute("aria-pressed") === "true");
  ok("the way out is named in the course's own words", lBar()?.querySelector('[data-tour-action="exit"]')?.textContent?.includes("Leave") === true);

  walk.destroy();
  lMain.remove();
  document.getElementById("tour-nav-bar")?.remove();
  document.getElementById("tour-spotlight")?.remove();
}

console.log(`\n${failures === 0 ? "TRAINING-WALK PASS" : `TRAINING-WALK: ${failures} FAILED`}\n`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
