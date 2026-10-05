// "Your backup plan": every decision the setup makes, one line each, grouped by step, with its current
// value. It is the concept's progress model (one denominator: the seven steps). To stay inside the word
// caps it folds: the current step's group shows every line, every other group is one summary line. Welcome
// shows a plain version (one line per step, in everyday words); Finish turns the plan into the receipt
// (q-finish.ts).
//
// Line states never borrow the success tone for something the user did not do: a default keeps the solid
// hollow circle and the muted style, a decision still needed shows a dashed circle, a limit set by the
// provider shows the lock glyph, and only an answer the user gave or the engine confirmed gets the check.

import { h, svgIcon } from "../../../lib/dom.ts";
import { ICON_ALERT, ICON_CHECK, ICON_LOCK } from "../../../lib/icons.ts";
import {
  CUSTODY_SCHEMES, customRetentionLabel, effectivePosture,
  type PickKind, PROVIDERS_INFO, pickedResources, restoreTestChoices, retentionChoices, SCHEDULES, type SetupSnapshot, type SetupStepId, TOKEN_SCOPES,
} from "../../../lib/setup-flow/index.ts";
import { STEP_NAME, sharesMade, stepDone } from "./flow.ts";
import type { LineId, QId } from "./types.ts";

export type LineState = "unset" | "default" | "set" | "locked" | "fixed" | "warn" | "busy";

export interface PlanLine {
  id: LineId;
  label: string;
  value: string;
  state: LineState;
  change: QId | null;
}

export interface PlanGroup {
  step: SetupStepId;
  lines: PlanLine[];
  summary: string;
  summaryState: LineState;
  change: QId | null;
}

const KIND_SHORT: Record<PickKind, string> = { kv: "KV", r2: "R2", d1: "D1", secrets: "secret", "cf-config": "config", workers: "Workers", stream: "Stream", images: "Images" };

export function sourcesValue(s: SetupSnapshot): string {
  const counts = new Map<PickKind, number>();
  for (const r of pickedResources(s)) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${n} ${KIND_SHORT[k]}`).join(", ");
}

export function custodyShort(s: SetupSnapshot): string {
  const d = s.draft;
  if (d.custody === "mofn-split") return `Split, any ${d.splitThreshold} of ${d.splitShares}`;
  return CUSTODY_SCHEMES.find((c) => c.id === d.custody)?.label ?? "";
}

// accountName is the account the engine runs in (the one its bindings and keys belong to), else the first
// account the token sees.
export function accountName(s: SetupSnapshot): string {
  const f = s.facts;
  return f.accounts.find((a) => a.isEngineAccount)?.name ?? f.accounts[0]?.name ?? "Your account";
}

export function tokenValue(s: SetupSnapshot): string {
  const n = s.facts.groups.reduce((a, g) => a + g.resources.length, 0);
  const more = s.facts.accounts.length > 1 ? ` and ${s.facts.accounts.length - 1} more` : "";
  return `${accountName(s)}${more}, ${n} resources`;
}

// planGroups computes every line from the model snapshot and the concept's answer record.
export function planGroups(s: SetupSnapshot, ans: Set<QId>, liveInstall: string | null): PlanGroup[] {
  const d = s.draft;
  const f = s.facts;
  const done = (id: SetupStepId): boolean => stepDone(s, id);
  const tokenOk = done("connect");
  const destOk = done("destination");
  // A destination the deployment set (an env or binding destination, setup-state source "deploy") was not
  // answered here: its lines name the engine's facts and offer no Change, since setup cannot edit it.
  const deployDest = destOk && f.setup?.destination.source === "deploy" && d.bucket.trim() === "";
  const destBucket = d.bucket.trim() !== "" ? d.bucket : f.setup?.destination.bucket ?? (deployDest ? "Set by your deployment" : "");
  const applied = done("apply");
  const created = d.createdDownpipeIds.length > 0;
  const keysFixed = f.keysReady;
  const held = d.keysGenerated && s.runtime.ceremonyHeld;
  const provider = PROVIDERS_INFO.find((p) => p.id === (f.setup?.destination.source === "deploy" && d.bucket.trim() === "" ? f.setup.destination.kind ?? d.provider : d.provider));
  // The posture the engine will run with: confirmed here, or set by keys already on the engine.
  const eff = effectivePosture(f, d);
  const posture = eff === "operational" ? "Operational key" : eff === "break-glass-only" ? "Offline key only" : null;
  const sched = SCHEDULES.find((x) => x.id === d.schedule)?.label ?? "Daily";
  const ret = d.retentionCustom !== null ? customRetentionLabel(d.retentionCustom) : retentionChoices(eff).find((x) => x.id === d.retention)?.label ?? "Keep every run";
  const rtId = d.restoreTest ?? (eff === "operational" ? "weekly" : "off");
  const rt = eff === null ? "By posture" : eff === "operational" ? restoreTestChoices(eff).find((x) => x.id === rtId)?.label ?? "Weekly" : "Attended, with your key";
  const picks = pickedResources(s);
  const destChange = (q: QId): QId | null => (created || deployDest ? null : q);

  const scope = TOKEN_SCOPES.find((t) => t.id === d.tokenScope);
  const connect: PlanLine[] = [
    { id: "scope", label: "Token scope", value: scope?.label ?? "Read all resources", state: scope ? "set" : "default", change: created ? null : "connect" },
    { id: "token", label: "Read-only token", value: tokenOk ? tokenValue(s) : "Not set", state: tokenOk ? "set" : "unset", change: created ? null : "connect" },
  ];

  const lockLine: PlanLine =
    d.provider === "r2"
      ? { id: "lock", label: "Object lock", value: "Off, R2 cannot lock", state: "fixed", change: null }
      : { id: "lock", label: "Object lock", value: d.immutability === "off" ? "Off" : `${d.immutability === "compliance" ? "Compliance" : "Governance"}, ${d.immutabilityDays || "?"} days`, state: ans.has("lock") || destOk ? "set" : "default", change: destChange("lock") };
  const destination: PlanLine[] = [
    { id: "provider", label: "Provider", value: provider?.label ?? "Cloudflare R2", state: ans.has("provider") || destOk ? "set" : "default", change: destChange("provider") },
    { id: "bucket", label: "Bucket", value: destBucket !== "" ? destBucket : "Not set", state: destBucket !== "" ? "set" : "unset", change: destChange("bucket") },
    lockLine,
    { id: "accessKey", label: "Access key", value: deployDest ? "Set by your deployment" : destOk ? "Verified by a test write" : "Not set", state: destOk ? "set" : "unset", change: destChange("credentials") },
    { id: "prices", label: "Storage prices", value: d.pricing !== null ? "Your own rates" : "List prices", state: d.pricing !== null ? "set" : "default", change: destChange("pricing") },
  ];

  const protect: PlanLine[] = [
    { id: "sources", label: "Sources", value: picks.length > 0 ? sourcesValue(s) : tokenOk ? "Not set" : "After the token", state: picks.length > 0 ? "set" : tokenOk ? "unset" : "locked", change: applied || created ? null : "protect" },
  ];

  // Key files are only DOWNLOADED until the user says where they went: the neutral glyph, never the check.
  const refused = d.refusedFiles.length;
  // Keys this tab made but no longer holds, and never sent or installed: the user must make them again, so a
  // save confirmation from before the tab lost them does not carry over to the new files.
  const keysGone = d.keysGenerated && !held && !d.keysSent && !keysFixed;
  const filesValue = keysFixed ? "Public keys installed" : d.keysSent ? "Sent to your engine" : held ? (refused > 0 ? `${refused} not downloaded` : "Downloaded") : keysGone ? "Make them again" : "Not made";
  const split = d.custody === "mofn-split";
  const custodyValue = d.custody === null ? "Not set" : `${custodyShort(s)}${split && held ? (sharesMade() ? ", shares made" : ", shares not made") : ""}`;
  const offlineValue = keysGone ? "Not confirmed" : d.keysSaved || (keysFixed && d.keysGenerated) ? (d.possession === "match" ? "You confirmed, file checked" : "You confirmed") : keysFixed ? "Set in another tab or before this setup" : "Not confirmed";
  const keys: PlanLine[] = [
    { id: "posture", label: "Key posture", value: posture !== null ? (d.postureAcknowledged || keysFixed ? posture : `${posture}, not confirmed`) : "No default", state: d.postureAcknowledged || keysFixed ? "set" : "unset", change: keysFixed ? null : "posture" },
    { id: "custody", label: "Custody", value: custodyValue, state: d.custody === null ? "unset" : split && held && !sharesMade() ? "warn" : "set", change: keysFixed ? null : "custody" },
    { id: "files", label: "Key files", value: filesValue, state: keysFixed || d.keysSent ? "set" : held ? (refused > 0 ? "warn" : "default") : "unset", change: null },
    { id: "saved", label: "Key offline", value: offlineValue, state: !keysGone && (d.keysSaved || keysFixed) ? "set" : "unset", change: null },
  ];

  const applyLocked = s.steps.find((x) => x.id === "apply")?.status === "locked";
  const revoked: PlanLine =
    d.applyRoute === "self-deploy" && !d.deployTokenUsed
      ? { id: "revoked", label: "Token revoked", value: "No token used", state: applied ? "set" : "default", change: null }
      : d.deployTokenRevoked
        ? { id: "revoked", label: "Token revoked", value: "You confirmed", state: "set", change: null }
        : d.deployTokenUsed
          ? { id: "revoked", label: "Token revoked", value: "Not yet", state: "warn", change: "revoke" }
          : { id: "revoked", label: "Token revoked", value: "Not yet", state: "unset", change: null };
  const apply: PlanLine[] = [
    { id: "route", label: "Apply route", value: d.applyRoute === "self-deploy" ? "Own wrangler or CI" : "One deploy token", state: applied || d.deployTokenUsed || ans.has("apply") ? "set" : "default", change: applied ? null : "apply" },
    // Driven by the engine's facts: keys it holds (or accepted from this setup) read as installed even while the
    // attach is still to do, so this line never contradicts an alert that says the keys are in.
    { id: "installed", label: "Installed", value: liveInstall ?? (applied ? `Keys and ${picks.filter((r) => r.binding !== undefined).length} bindings live` : keysFixed || d.keysSent ? "Keys installed, picks not attached yet" : applyLocked ? "After keys" : "Not yet"), state: liveInstall !== null ? "busy" : applied ? "set" : applyLocked && !(keysFixed || d.keysSent) ? "locked" : "unset", change: null },
    revoked,
  ];

  const backup: PlanLine[] = [
    { id: "downpipes", label: "Downpipes", value: created ? `${d.createdDownpipeIds.length} created` : picks.length > 0 ? `${picks.length} from your picks` : "From your picks", state: created ? "set" : "default", change: null },
    { id: "schedule", label: "Schedule", value: sched, state: created ? "set" : "default", change: created ? null : "backup" },
    { id: "retention", label: "Retention", value: ret, state: created ? "set" : "default", change: created ? null : "backup" },
    { id: "restore", label: "Restore tests", value: rt, state: created ? "set" : eff === null ? "unset" : "default", change: created ? null : "backup" },
  ];

  const decisions = (n: number): string => `${n} decisions`;
  const g = (step: SetupStepId, lines: PlanLine[], summary: string, summaryState: LineState, change: QId | null): PlanGroup => ({ step, lines, summary, summaryState, change });
  const keysDone = keysFixed || done("keys");
  return [
    g("connect", connect, connect[1]!.value, connect[1]!.state, connect[1]!.change),
    g("destination", destination, destOk ? `${provider?.label ?? ""}, ${destBucket}` : decisions(destination.length), destOk ? "set" : "unset", destOk ? destChange("provider") : null),
    g("protect", protect, protect[0]!.value, protect[0]!.state, protect[0]!.change),
    g("keys", keys, keysDone ? `${posture ?? "Keys installed"}${d.custody !== null ? `, ${custodyShort(s)}` : ""}` : decisions(keys.length), keysDone ? "set" : "unset", keysFixed || !done("keys") ? null : "posture"),
    g("apply", apply, applied ? (revoked.state === "warn" ? "Revoke pending" : apply[1]!.value) : applyLocked ? (keysFixed || d.keysSent ? apply[1]!.value : "After keys") : decisions(2), applied ? (revoked.state === "warn" ? "warn" : "set") : applyLocked && !(keysFixed || d.keysSent) ? "locked" : "unset", null),
    g("backup", backup, created ? `${d.createdDownpipeIds.length} downpipes, ${sched}` : done("apply") ? decisions(backup.length) : "After Apply", created ? "set" : done("apply") ? "unset" : "locked", null),
  ];
}

function glyph(state: LineState): Node {
  if (state === "set") return svgIcon(ICON_CHECK, { size: 14 });
  if (state === "locked" || state === "fixed") return svgIcon(ICON_LOCK, { size: 13 });
  if (state === "warn") return svgIcon(ICON_ALERT, { size: 14 });
  return h("span", { class: `fb-dot fb-dot--${state}` });
}

export interface PlanRenderOpts {
  mode: "full" | "folded";
  current: SetupStepId | null;
  currentLine: LineId | null;
  // The question on screen: a line whose Change would reopen it gets none (no button reloads its own view).
  currentQ?: QId | null;
  // The line the committed answer flies into (motion only).
  flightLine: LineId | null;
  onChange: (q: QId) => void;
  // Line ids that just became decided (their glyph pops once).
  fresh: ReadonlySet<LineId>;
  // Lines the current question already shows on the stage (not repeated in the plan).
  hide?: ReadonlySet<LineId>;
  // False inside the phone sheet, whose own title already names the plan.
  title?: boolean;
}

function changeButton(label: string, onClick: () => void): HTMLElement {
  return h("button", { "data-dp": "setup.button.click#2", class: "fb-pl__change", type: "button", "aria-label": `Change ${label.toLowerCase()}`, on: { click: onClick } }, "Change");
}

// renderPlan builds the plan column body (header, groups). `flight` returns the element the committed answer
// lands on, so the caller can name it for the shell's view transition.
export function renderPlan(groups: PlanGroup[], o: PlanRenderOpts): { el: HTMLElement; flightTarget: HTMLElement | null } {
  let flightTarget: HTMLElement | null = null;
  const titleId = "fb-plan-title";
  const list = h("ol", { class: "fb-plan__groups" });
  for (const gr of groups) {
    const isCurrent = gr.step === o.current;
    const expanded = o.mode === "full" || isCurrent;
    // The current step is exposed once, on the stage eyebrow (always rendered); here it is visual only.
    const head = h("h3", { class: "fb-pg__name" }, STEP_NAME[gr.step]);
    const li = h("li", { class: `fb-pg${isCurrent ? " fb-pg--current" : ""}` }, head);
    if (expanded) {
      const ul = h("ul", { class: "fb-pg__lines" });
      for (const l of gr.lines) {
        if (o.hide?.has(l.id)) continue;
        const value = h("span", { class: "fb-pl__value" }, l.value);
        const here = isCurrent && o.currentLine === l.id;
        // Change on every line that has a question: a set answer, a default kept (Storage prices), or the
        // revoke still to confirm. Never on the line of the question on screen.
        const canChange = l.change !== null && !here && l.change !== o.currentQ && (l.state === "set" || l.state === "default" || l.state === "warn");
        const row = h(
          "li",
          { class: `fb-pl fb-pl--${l.state}${here ? " fb-pl--here" : ""}${o.fresh.has(l.id) ? " fb-pl--fresh" : ""}`, "data-line": l.id },
          here ? h("span", { class: "fb-marker", "aria-hidden": "true" }) : null,
          h("span", { class: "fb-pl__glyph", "aria-hidden": "true" }, glyph(l.state)),
          h("span", { class: "fb-pl__label" }, l.label),
          value,
          canChange ? changeButton(l.label, () => o.onChange(l.change!)) : null,
        );
        if (o.flightLine === l.id) flightTarget = value;
        ul.appendChild(row);
      }
      li.appendChild(ul);
    } else {
      const value = h("span", { class: "fb-pl__value" }, gr.summary);
      const row = h(
        "p",
        { class: `fb-pl fb-pl--summary fb-pl--${gr.summaryState}` },
        h("span", { class: "fb-pl__glyph", "aria-hidden": "true" }, glyph(gr.summaryState)),
        value,
        gr.change !== null && gr.change !== o.currentQ && gr.summaryState === "set" ? changeButton(STEP_NAME[gr.step], () => o.onChange(gr.change!)) : null,
      );
      if (o.flightLine !== null && gr.lines.some((l) => l.id === o.flightLine)) flightTarget = value;
      li.appendChild(row);
    }
    list.appendChild(li);
  }
  const el = h("div", { class: "fb-plan__body" }, o.title === false ? null : h("h2", { class: "fb-plan__title", id: titleId }, "Your backup plan"), list);
  return { el, flightTarget };
}

// renderPlainPlan is the Welcome plan: the whole road in everyday words, one line per step with what
// happens by default. The detailed lines take over from the first question on.
export function renderPlainPlan(title = true): HTMLElement {
  const rows: Array<[string, string]> = [
    ["Connect", "A read-only token"],
    ["Where backups go", "Cloudflare R2, by default"],
    ["What to protect", "You tick your resources"],
    ["Who can decrypt", "Your choice, no default"],
    ["Install", "One deploy token, used once"],
    ["First backup", "Daily, every run kept"],
  ];
  return h(
    "div",
    { class: "fb-plan__body fb-plan__body--plain" },
    title ? h("h2", { class: "fb-plan__title", id: "fb-plan-title" }, "Your backup plan") : null,
    h("p", { class: "fb-plan__legend" }, "Lines fill in as you answer."),
    h(
      "ol",
      { class: "fb-plain" },
      ...rows.map(([label, value]) => h("li", { class: "fb-pl fb-pl--default" }, h("span", { class: "fb-pl__glyph", "aria-hidden": "true" }, glyph("default")), h("span", { class: "fb-pl__label" }, label), h("span", { class: "fb-pl__value" }, value))),
    ),
  );
}
