// Focus Flow retention: the one-level sheet behind First backup's "Retention ... Change". It offers the three
// presets and the downpipe editor's own fields (runs to keep, days to keep, enforce deletion), so no retention
// option waits for the editor. Posture-aware: under an offline key only, every pruning option shows as
// unavailable with the foundation's reason, and "Keep every run" is the one choice.

import { RETENTION_MAX_KEEP_DAYS, RETENTION_MAX_KEEP_RUNS } from "../../../lib/api/types/downpipes.ts";
import { h } from "../../../lib/dom.ts";
import { CUSTOM_RETENTION_UNAVAILABLE, type CustomRetention, customRetentionLabel, effectivePosture, retentionChoices, type SetupDraft, setupModel } from "../../../lib/setup-flow/index.ts";
import { canCap, capGateReason } from "../../common.ts";
import { RETENTION_ARM_REASON } from "../../sources-downpipes/helpers.ts";
import { checkRow, field, openSheet, tileGroup } from "./kit.ts";
import type { QCtx } from "./types.ts";

// retentionLabel is the current retention in lower case for the First backup line, under the posture the
// engine will run with (lib/setup-flow/steps.ts effectivePosture).
export function retentionLabel(d: SetupDraft, posture: SetupDraft["posture"]): string {
  if (d.retentionCustom !== null) return customRetentionLabel(d.retentionCustom).toLowerCase();
  return (retentionChoices(posture).find((x) => x.id === d.retention)?.label ?? "Keep every run").toLowerCase();
}

const whole = (v: string, max: number): number | null | "bad" => {
  const t = v.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return "bad";
  const n = Number(t);
  return n >= 1 && n <= max ? n : "bad";
};

export function retentionSheet(c: QCtx): void {
  const m = setupModel();
  const d = m.get().draft;
  const posture = effectivePosture(m.get().facts, d);
  const offline = posture !== "operational";
  const cur = d.retentionCustom;
  const runs = field({ id: "setup-keep-runs", label: "Runs to keep", placeholder: "30", validate: (v) => (whole(v, RETENTION_MAX_KEEP_RUNS) === "bad" ? `Type a whole number from 1 to ${RETENTION_MAX_KEEP_RUNS}.` : null), doc: { href: "https://docs.downpipes.io/backing-up/retention-and-pruning", anchor: "the-three-knobs" }, type: "number", inputmode: "numeric", value: cur?.keepRuns !== undefined ? String(cur.keepRuns) : "30", hint: `1 to ${RETENTION_MAX_KEEP_RUNS.toLocaleString("en-AU")}.` });
  const days = field({ id: "setup-keep-days", label: "Days to keep", placeholder: "90", validate: (v) => (whole(v, RETENTION_MAX_KEEP_DAYS) === "bad" ? `Type a whole number from 1 to ${RETENTION_MAX_KEEP_DAYS}.` : null), doc: { href: "https://docs.downpipes.io/backing-up/retention-and-pruning", anchor: "the-three-knobs" }, type: "number", inputmode: "numeric", value: cur?.keepDays !== undefined ? String(cur.keepDays) : "", hint: `1 to ${RETENTION_MAX_KEEP_DAYS.toLocaleString("en-AU")}. A run is kept when it meets either limit.` });
  // The two dated presets arm enforce:true, which needs restore.apply beyond downpipe.write (the
  // downpipe editor's own Enforce checkbox gates the same way). The operator's own limit here arms the
  // exact same edit, so it needs the same gate: a caller without restore.apply cannot tick it, and the
  // checkbox never starts checked for them even if a draft from before they lost the permission held it.
  const canArm = canCap("restore.apply");
  let enforce = canArm ? (cur?.enforce ?? false) : false;
  const enforceRow = checkRow({ label: "Delete runs outside these limits", secondary: "Off: the engine only reports what it would delete.", checked: enforce, onChange: (v) => { enforce = v; commitCustom(); }, ...(canArm ? {} : { disabledReason: RETENTION_ARM_REASON }) });

  // commitCustom stores the fields while "Your own limits" is chosen, and only when they are valid; an
  // invalid field keeps the last valid policy and says why beside the field.
  const commitCustom = (): void => {
    if (tiles.value() !== "custom") return;
    days.setError(null);
    if (runs.check() !== null || days.check() !== null) return;
    const r = whole(runs.input.value, RETENTION_MAX_KEEP_RUNS);
    const dd = whole(days.input.value, RETENTION_MAX_KEEP_DAYS);
    if (r === "bad" || dd === "bad") return;
    if (r === null && dd === null) {
      runs.setError("Set runs to keep, days to keep, or both.");
      return;
    }
    const next: CustomRetention = { ...(r !== null ? { keepRuns: r } : {}), ...(dd !== null ? { keepDays: dd } : {}), enforce };
    m.update({ retentionCustom: next });
  };
  runs.input.addEventListener("input", commitCustom);
  days.input.addEventListener("input", commitCustom);

  // The two dated presets arm enforce:true, which needs restore.apply beyond downpipe.write (the
  // downpipe editor's own Enforce checkbox gates the same way): a caller without it sees the preset as
  // unavailable here, in the picker, rather than choosing it and being refused at Create.
  const presets = retentionChoices(posture, canArm ? undefined : capGateReason("restore.apply")).map((x) => ({ id: x.id as string, label: x.label, lines: [x.consequence], ...(x.unavailable !== undefined ? { unavailable: x.unavailable } : {}) }));
  const custom = {
    id: "custom",
    label: "Your own limits",
    lines: ["Runs or days to keep, as in the downpipe editor."],
    ...(offline ? { unavailable: CUSTOM_RETENTION_UNAVAILABLE } : { extra: () => h("div", { class: "fb-extra" }, runs.el, days.el, enforceRow.el) }),
  };
  const tiles = tileGroup<string>({
    name: "retention",
    legend: "Retention",
    choices: [...presets, custom],
    selected: d.retentionCustom !== null && !offline ? "custom" : d.retention,
    numberKeys: false,
    onChange: (id) => {
      if (id === "custom") commitCustom();
      else m.update({ retention: id as SetupDraft["retention"], retentionCustom: null });
    },
  });
  openSheet({ title: "How long to keep runs", body: [tiles.el], opener: document.activeElement as HTMLElement | null, onClose: () => c.rerender() });
}
