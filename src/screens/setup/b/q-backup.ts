// Focus Flow questions for step 6, First backup: the downpipes to create (the picks, in the user's names,
// renamable), the schedule, retention and restore tests (posture-aware: under an offline key only nothing
// says a scheduled restore test or automatic pruning runs), then Create and run now. The run view shows one
// log line per stage the engine reports, and moves to Finish only once every downpipe has sealed (firstRunDone).

import { h } from "../../../lib/dom.ts";
import { ICON_INFO } from "../../../lib/icons.ts";
import { enter } from "../../../lib/motion.ts";
import {
  createDownpipes, defaultRestoreTest, effectivePosture, firstBackupOutstanding, firstRunDone, pickedResources, planDownpipes, type RestoreTestId, type RunProgress, type RunStage,
  restoreTestChoices, runNow, SCHEDULES, type ScheduleId, setUpByEstateFacts, setupModel, watchRun,
} from "../../../lib/setup-flow/index.ts";
import { line, message, textButton, tileGroup, uid } from "./kit.ts";
import { revokePin } from "./q-apply.ts";
import { retentionLabel, retentionSheet } from "./retention.ts";
import type { QCtx, QView } from "./types.ts";

// The one pointer the contract allows: every option the downpipe editor keeps after setup, named, and where
// it is (inventory ADVANCED_EDITOR_POINTER lists the same items).
const EDITOR_POINTER = "Prefixes, cron, timezone, maintenance windows, ID overrides, capture mode and extra destinations are in each downpipe's editor.";

// Consequence lines for the schedule tiles (inventory SCHEDULES, with the cadence itself as the title). Under
// an offline key only nothing prunes in the engine, so Hourly says every run is kept.
function scheduleLine(id: ScheduleId, offline: boolean): string {
  if (id === "hourly") return offline ? "24 runs a day, all kept." : "24 runs a day. Higher read costs.";
  if (id === "weekly") return "Up to a week at risk.";
  return SCHEDULES.find((x) => x.id === id)?.consequence ?? "";
}

const KIND_LABEL: Record<string, string> = { kv: "KV", r2: "R2", d1: "D1", secrets: "Secrets", "cf-config": "Configuration", workers: "Workers", stream: "Stream", images: "Images" };

export function backup(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  const d = s.draft;
  // The posture the engine will run with: the one confirmed here, or the one keys already on the engine set.
  const posture = effectivePosture(s.facts, d);
  const offline = posture !== "operational";
  const alert = message("error");
  // Downpipes the engine already has that this setup did not make (made on the Downpipes screen, or by an
  // earlier setup in another browser): the first backup runs them rather than creating more.
  const existing = d.createdDownpipeIds.length === 0 ? s.facts.downpipes : [];
  const created = (d.createdDownpipeIds.length > 0 && d.createdDownpipeIds.some((id) => s.facts.downpipes.some((x) => x.config.id === id))) || existing.length > 0;
  const picks = pickedResources(s);
  // A console set up before this setup page (its estate facts hold) is not gated by the shell, so this run is
  // offered and never required: the top bar's "Leave setup" skips it.
  const optional = existing.length > 0 && setUpByEstateFacts(s.facts);

  // One row per downpipe to create: what it backs up (the user's resource, with the SRC_* binding as muted
  // description text), then its name. A row that maps to one pick is renamable (draft.names); the secrets
  // bundle and the configuration rows keep the names the shared assembler gives them. The visible column
  // header "Downpipe name" labels every name field, with the resource it backs up.
  const plan = planDownpipes();
  const hdrName = uid("dph");
  const rows = h("ul", { class: "fb-dprows" }, h("li", { class: "fb-dprow fb-dprow--head", "aria-hidden": "true" }, h("span"), h("span", { id: hdrName }, "Name")));
  if (existing.length > 0) {
    for (const x of existing) {
      const kind = KIND_LABEL[x.config.source.type] ?? x.config.source.type;
      rows.appendChild(h("li", { class: "fb-dprow" }, h("span", { class: "fb-dprow__what" }, kind), h("span", { class: "fb-dprow__name" }, x.config.name)));
    }
  } else if (plan.ok) {
    for (const item of plan.data) {
      const res = picks.find((r) => ((d.names[r.key] ?? "").trim() || r.name) === item.label);
      const kind = KIND_LABEL[item.dp.source.type] ?? item.dp.source.type;
      const id = uid("dp");
      const whatId = `${id}-w`;
      const bindId = `${id}-b`;
      // The binding id names the type already (SRC_D1_...); a row without one says its type.
      const what = h("span", { class: "fb-dprow__what" }, h("span", { id: whatId }, res?.binding ? res.name : `${kind} ${res?.name ?? item.label}`), res?.binding ? h("span", { class: "fb-dprow__binding", id: bindId }, res.binding) : null);
      const nameEl: HTMLElement = res && !created
        ? (() => {
            const input = h("input", { class: "input fb-input", id, value: item.label, maxlength: "256", autocomplete: "off", spellcheck: "false", "aria-labelledby": `${hdrName} ${whatId}`, ...(res.binding ? { "aria-describedby": bindId } : {}) }) as HTMLInputElement;
            input.value = item.label;
            input.addEventListener("change", () => m.update({ names: { ...m.get().draft.names, [res.key]: input.value.trim() } }));
            return input;
          })()
        : h("span", { class: "fb-dprow__name", id }, item.label);
      rows.appendChild(h("li", { class: "fb-dprow" }, what, nameEl));
    }
  } else rows.appendChild(h("li", { class: "fb-msg fb-msg--error" }, plan.error.message));

  const schedule = tileGroup<ScheduleId>({
    name: "schedule",
    legend: "Schedule",
    choices: SCHEDULES.map((x) => ({ id: x.id, label: x.label, lines: [scheduleLine(x.id, offline)] })),
    selected: d.schedule,
    columns: 4,
    onChange: (id) => m.update({ schedule: id }),
  });
  const retLabel = retentionLabel(d, posture);
  const retentionLine = h(
    "p",
    { class: "fb-row fb-row--muted" },
    offline ? `Retention: ${retLabel}. You delete old runs with the offline reader.` : `Retention: ${retLabel}.`,
    created ? null : textButton("Change", () => retentionSheet(c), { "aria-label": "Change retention" }),
  );
  const restore = offline
    ? h("p", { class: "fb-row fb-row--muted" }, "Restore tests: attended, with your key.")
    : tileGroup<RestoreTestId>({
        name: "restore",
        legend: "Restore tests",
        choices: restoreTestChoices(posture).map((x) => ({ id: x.id, label: x.label, lines: [x.consequence] })),
        selected: d.restoreTest ?? defaultRestoreTest(posture),
        columns: 3,
        numberKeys: false,
        onChange: (id) => m.update({ restoreTest: id }),
      }).el;

  return {
    title: created ? "Run your first backup" : "Start your first backup",
    lede: [
      created ? "Your downpipes exist. Run them now." : "Each pick becomes a downpipe, a scheduled backup.",
      ...(optional ? ["This console is already set up, so this run is optional. To skip it, choose Leave setup."] : []),
    ],
    body: [revokePin(() => c.rerender()), rows, created ? null : schedule.el, created ? null : retentionLine, created ? null : restore, line(ICON_INFO, EDITOR_POINTER, "fb-line--muted"), alert.el].filter((n): n is HTMLElement => n !== null),
    primary: {
      label: created ? "Run now" : "Create and run now",
      busyLabel: created ? "Starting" : "Creating",
      run: async () => {
        alert.set(null);
        c.setBusy(true);
        if (m.get().draft.restoreTest === null) m.update({ restoreTest: defaultRestoreTest(posture) });
        if (!created) {
          const made = await createDownpipes();
          if (!made.ok) {
            c.setBusy(false);
            return alert.set(made.error.message);
          }
        }
        const runs = await runNow(existing.length > 0 ? existing.map((x) => x.config.id) : undefined);
        c.setBusy(false);
        if (!runs.ok) return alert.set(runs.error.message);
        c.go("run");
      },
    },
  };
}

// ---- Run --------------------------------------------------------------------------------------------------------

const STAGE_TEXT: Record<RunStage, string> = {
  starting: "starting",
  reading: "reading your data",
  sealing: "sealing the archive",
  sealed: "sealed and verified",
  unverified: "sealed, seal not verified",
  failed: "did not finish",
};
// The line for a downpipe the last Run now did not start (runNow records it with the engine's reason).
const NOT_STARTED = "did not start";

// UNVERIFIED_NOTE is what the run view says when a run ends ok with no verify-at-seal verdict. The engine
// attaches that verdict when the run completes, so its absence is final: this engine has verify-at-seal
// switched off by its VERIFY_AT_SEAL setting (engine env.d.ts; the posture report says the same).
const UNVERIFIED_NOTE = "Your engine has verify-at-seal switched off (its VERIFY_AT_SEAL setting), so it did not read this backup back to check it. A restore test proves that the backup restores.";

export function run(c: QCtx): QView {
  const s = c.s;
  const d = s.draft;
  // Every run the last Run now started (runNow records them in the draft, so a reload or a new tab watches the
  // same runs). A run already over reports its ending at the first read.
  const watch = d.startedRuns.length > 0 ? d.startedRuns : d.firstRun !== null ? [d.firstRun] : [];
  // The downpipes it did not start. They count in every stage line and in the pipe, so no line reads as the
  // whole backup while one of them has no run.
  const missed = d.notStarted;
  const total = watch.length + missed.length;
  const nameOf = (id: string): string => s.facts.downpipes.find((x) => x.config.id === id)?.config.name ?? id;
  const names = watch.map((w) => nameOf(w.downpipeId));
  const sched = SCHEDULES.find((x) => x.id === d.schedule)?.label.toLowerCase() ?? "daily";
  const t0 = Date.now();
  const elapsed = h("span", { class: "fb-run__elapsed" }, "0.0 s");
  const pipe = h("div", { class: "fb-pipe fb-pipe--running", role: "progressbar", "aria-label": "First backup", "aria-valuetext": "Starting" }, h("div", { class: "fb-pipe__fill" }));
  let sealed = false;
  let unverified = false;
  const note = message("info");
  const log = h("ol", { class: "fb-log", "aria-live": "polite" });
  const alert = message("error");
  const stops: Array<() => void> = [];
  let ended = 0;
  let failed = false;
  const ticker = setInterval(() => { elapsed.textContent = `${((Date.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  const stagesDone = new Map<string, number>();
  // The pipe fills by stage. Either ok ending ("sealed" or "unverified") fills it.
  const order: RunStage[] = ["starting", "reading", "sealing", "sealed"];
  const stageIndex = (st: RunStage): number => (st === "unverified" ? order.length - 1 : Math.max(0, order.indexOf(st)));
  // ONE CLOCK ON THIS VIEW. The header and every log line read the time since this view began watching, and
  // the header stops at the instant of the last log line, so the two can never show different figures for
  // the same moment. The engine's own run time (RunHistoryEntry.durationMs) starts when the engine begins the
  // run, not when this view begins to watch, so it is a different quantity: the receipt quotes it, labelled as
  // the engine's.
  let lastLineMs = 0;
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

  // One log line per real stage, added when the first downpipe reports it; its count rises as the others
  // reach it, and its time moves to the latest arrival, so with two downpipes the line of the final event shows
  // the same time as the header (one clock). A failure gets its own line, with the downpipe's name and the
  // engine's reason. A line takes its stage's tone (the seal's is the success tone) only once every downpipe
  // has reached it, so a seal of one of two never reads as the whole backup sealed.
  const stageLines = new Map<RunStage, { li: HTMLElement; t: HTMLElement; text: HTMLElement; seen: Set<string> }>();
  const addLine = (name: string, p: RunProgress, id: string, verb: string = STAGE_TEXT.failed): void => {
    const nowMs = Date.now() - t0;
    const at = secs(nowMs);
    // A repeated report of a stage this downpipe already reached changes no line, so it moves no clock.
    if (p.stage !== "failed" && stageLines.get(p.stage)?.seen.has(id) === true) return;
    lastLineMs = nowMs;
    if (p.stage === "failed") {
      const li = h("li", { class: "fb-log__line fb-log__line--failed" }, h("span", { class: "fb-log__t" }, at), h("span", `${name}: ${verb}${p.message ? `. ${p.message}` : ""}`));
      log.appendChild(li);
      enter(li, { from: "fade", duration: "--dur-1" });
      return;
    }
    // The count shows only while some downpipes have not reached the stage yet.
    const count = (n: number): string => (n < total ? `, ${n} of ${total}` : "");
    const cap = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
    const tone = (n: number): string => `fb-log__line${n >= total ? ` fb-log__line--${p.stage}` : ""}`;
    const line = stageLines.get(p.stage);
    if (line) {
      line.t.textContent = at;
      line.seen.add(id);
      line.text.textContent = `${cap(STAGE_TEXT[p.stage])}${count(line.seen.size)}`;
      line.li.className = tone(line.seen.size);
      return;
    }
    const text = h("span", `${cap(STAGE_TEXT[p.stage])}${count(1)}`);
    const t = h("span", { class: "fb-log__t" }, at);
    const li = h("li", { class: tone(1) }, t, text);
    stageLines.set(p.stage, { li, t, text, seen: new Set([id]) });
    log.appendChild(li);
    enter(li, { from: "fade", duration: "--dur-1" });
  };
  // On a run that did not finish, the seal lines name the downpipes that did seal, as the failure line names the
  // one that did not, so each line says which downpipe it is about.
  const nameSealed = (): void => {
    for (const st of ["sealed", "unverified"] as const) {
      const line = stageLines.get(st);
      if (line) line.text.textContent = `${[...line.seen].map(nameOf).join(" and ")}: ${STAGE_TEXT[st]}`;
    }
  };
  const paintPipe = (): void => {
    const share = total === 0 ? 0 : [...stagesDone.values()].reduce((a, b) => a + b, 0) / (total * (order.length - 1));
    pipe.style.setProperty("--fb-pipe", String(Math.max(0.04, Math.min(1, share))));
  };

  const h1 = (): HTMLElement | null => document.querySelector<HTMLElement>(".fb-h1");
  // The ending is the step model's: sealed only when every downpipe of the first backup has a sealed run that
  // is not suspect (firstRunDone, the rule the strip and Finish read), and verified only when protectedNow.
  const finishAll = (): void => {
    clearInterval(ticker);
    elapsed.textContent = secs(lastLineMs);
    pipe.classList.remove("fb-pipe--running");
    const now = setupModel().get();
    failed = !firstRunDone(now.facts, now.draft);
    unverified = !failed && !now.protectedNow;
    if (failed) {
      nameSealed();
      pipe.classList.add("fb-pipe--failed");
      const el = h1();
      if (el) {
        el.textContent = "Your first backup did not finish";
        el.focus();
      }
      c.setPrimaryLabel("Run it again");
      c.setBusy(false);
      c.refresh();
      return;
    }
    pipe.classList.add("fb-pipe--sealed");
    pipe.setAttribute("aria-valuetext", unverified ? "Sealed, seal not verified" : "Sealed and verified");
    const el = h1();
    if (el) {
      el.textContent = unverified ? "Your first backup is sealed" : "Your first backup is sealed and verified";
      el.focus();
    }
    if (unverified) note.set(UNVERIFIED_NOTE);
    // The receipt opens when the user asks for it: no timer moves the page under the pointer.
    sealed = true;
    c.setPrimaryLabel("See your receipt");
    c.setBusy(false);
    c.refresh();
  };

  const begin = (): void => {
    ended = 0;
    failed = false;
    unverified = false;
    for (const n of missed) addLine(nameOf(n.downpipeId), { stage: "failed", entry: null, message: n.reason }, n.downpipeId, NOT_STARTED);
    for (const w of watch) {
      const name = nameOf(w.downpipeId);
      stagesDone.set(w.downpipeId, 0);
      const handle = watchRun(w.downpipeId, w.runId, (p) => {
        addLine(name, p, w.downpipeId);
        stagesDone.set(w.downpipeId, Math.max(stagesDone.get(w.downpipeId) ?? 0, stageIndex(p.stage)));
        pipe.setAttribute("aria-valuetext", `${name}: ${STAGE_TEXT[p.stage]}`);
        paintPipe();
      });
      stops.push(handle.stop);
      void handle.done.then((end) => {
        ended += 1;
        if (end.stage !== "sealed" && end.stage !== "unverified") {
          failed = true;
          if (end.stage !== "failed") addLine(name, { ...end, stage: "failed", message: "The engine did not report the end of the run in time. The Runs screen shows its outcome." }, w.downpipeId);
        }
        if (ended === watch.length) finishAll();
      });
    }
    paintPipe();
    if (watch.length === 0) finishAll();
  };

  const view: QView = {
    title: "Your first backup is running",
    lede: [`${names.length === 1 ? "One downpipe runs" : `${names.length} downpipes run`} now. After this, they run ${sched}.`],
    body: [
      revokePin(),
      h("div", { class: "fb-run__head" }, h("span", `${names.join(" and ")} to ${d.bucket || "your bucket"}`), elapsed),
      pipe,
      log,
      note.el,
      alert.el,
    ].filter((n): n is HTMLElement => n !== null),
    primary: {
      label: "Running",
      busyLabel: "Running",
      reason: () => (ended < watch.length && !failed ? "Waiting for the seal." : null),
      run: async () => {
        if (sealed) return c.go("finish");
        if (!failed) return;
        c.setBusy(true);
        // The downpipes the first backup waits on (those that did not start or did not seal) run again; the
        // runs of the others stand. runNow records the new runs in the draft, and the view watches them all.
        const now = setupModel().get();
        const again = firstBackupOutstanding(now.facts, now.draft);
        const r = await runNow(again.length > 0 ? again : undefined, { again: again.length > 0 });
        if (!r.ok) {
          c.setBusy(false);
          return alert.set(r.error.message);
        }
        c.rerender();
      },
    },
    dispose: () => {
      clearInterval(ticker);
      for (const s2 of stops) s2();
    },
  };
  if (total === 0) {
    view.title = "No run has started yet";
    view.lede = ["Start the first backup from its question."];
    view.body = [];
    view.primary = { label: "Go to the first backup", run: () => c.go("backup") };
    delete view.dispose;
    clearInterval(ticker);
    return view;
  }
  // Start watching once the view is on screen.
  queueMicrotask(() => {
    c.setBusy(true);
    begin();
  });
  return view;
}
