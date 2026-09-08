// The add/edit-rule modal's internals, factored out of rules.ts for size (the rule form
// is the largest piece). Three cohesive parts: building the form controls (scope, severity,
// the event checklist, the channel checklist, digest, enabled), wiring the inline
// severity-mismatch warning, and the save handler that runs the pure builder then upserts.
// openRuleForm in rules.ts orchestrates these; the public export stays there so importers
// and the validators do not move.
//
// House rules: disabled-with-reason, never hidden-then-403; honest copy; Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { stepUpAwareText } from "../../components/error-view.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised, isStepUpRequired } from "../../lib/errors.ts";
import { field, validateForm, type Field } from "../../components/field.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import type { EngineClient, DownpipeState, NotifyChannel, NotifyRule, Severity } from "../../api.ts";
import {
  NOTIFY_EVENTS,
  checkboxRow,
  severityRank,
  buildRuleInputFrom,
  errText,
} from "./shared.ts";

// One event row: its definition and the checkbox handle. The severity warning and the
// builder read these.
interface EventCheck {
  def: (typeof NOTIFY_EVENTS)[number];
  checkbox: { el: HTMLElement; checked: () => boolean };
}

// One channel row: the channel and the checkbox handle.
interface ChannelCheck {
  channel: NotifyChannel;
  checkbox: { el: HTMLElement; checked: () => boolean };
}

// The built controls. openRuleForm appends the hosts/fields to the form and reads the
// values on save; the severity warning and submit handler read the same handles.
export interface RuleFormControls {
  scopeKindField: Field;
  downpipeSelectField: Field;
  minSeverityField: Field;
  eventsModeField: Field;
  eventChecks: EventCheck[];
  channelChecks: ChannelCheck[];
  digestField: Field;
  enabledCheck: { el: HTMLElement; checked: () => boolean } | null;
  // Hosts that swap their content as scope/events mode changes.
  downpipeHost: HTMLElement;
  eventsChecklistHost: HTMLElement;
  channelChecklist: HTMLElement;
  refreshScope: () => void;
  refreshEventsMode: () => void;
}

// Build every control for the add/edit-rule form, wired so the downpipe picker and event
// checklist appear only when their mode selects them. Moved verbatim from openRuleForm.
export function buildRuleFormControls(existing: NotifyRule | null, channels: NotifyChannel[], downpipes: DownpipeState[]): RuleFormControls {
  const existingScope = existing && existing.scope.kind === "downpipe" ? existing.scope : null;
  const noDownpipes = downpipes.length === 0;

  const scopeKindField = field({
    id: "rule-scope-kind",
    label: "Scope",
    kind: "select",
    value: existing?.scope.kind ?? "global",
    hint: noDownpipes && !existingScope
      ? "A global rule is the default. Per-downpipe overrides become available once a downpipe exists."
      : "A global rule is the default; a per-downpipe rule overrides the global default for the same event class on that downpipe.",
    options: [
      { value: "global", label: "Global (all downpipes)" },
      { value: "downpipe", label: "A specific downpipe" },
    ],
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "rules-which-events-reach-which-channels" },
  });
  // With no downpipes there is nothing a per-downpipe rule could target, so the option is
  // disabled-with-reason (the hint above), never offered-then-useless. Editing a rule
  // already pinned to a (since-deleted) downpipe keeps the option live so it shows reality.
  if (noDownpipes && !existingScope) {
    for (const opt of Array.from((scopeKindField.control as HTMLSelectElement).options)) {
      if (opt.value === "downpipe") opt.disabled = true;
    }
  }

  // The downpipe picker (shown only for a per-downpipe scope), populated from the live
  // downpipe list loaded with the panel, never a hand-typed opaque id. A rule pinned to a
  // downpipe the list no longer carries keeps that id as an explicit option, so editing
  // shows reality instead of silently retargeting.
  const downpipeOptions = downpipes.map((d) => ({ value: d.config.id, label: `${d.config.name} (${d.config.id})` }));
  if (existingScope && !downpipeOptions.some((o) => o.value === existingScope.downpipeId)) {
    downpipeOptions.unshift({ value: existingScope.downpipeId, label: `${existingScope.downpipeId} (no longer exists)` });
  }
  const downpipeSelectField = field({
    id: "rule-downpipe",
    label: "Downpipe",
    kind: "select",
    value: existingScope?.downpipeId ?? (downpipeOptions[0]?.value ?? ""),
    hint: "Which downpipe this rule applies to.",
    options: downpipeOptions,
    validate: (v) => (scopeKindField.value() === "downpipe" && v.length === 0 ? "Choose a downpipe." : null),
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "rules-which-events-reach-which-channels" },
  });

  const minSeverityField = field({
    id: "rule-min-severity",
    label: "Minimum severity",
    kind: "select",
    value: existing?.minSeverity ?? "warning",
    hint: "Deliver events at or above this severity. Critical only delivers critical; info delivers everything selected.",
    options: [
      { value: "info", label: "Info (everything selected)" },
      { value: "warning", label: "Warning and above" },
      { value: "critical", label: "Critical only" },
    ],
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "rules-which-events-reach-which-channels" },
  });

  // The event selection: "all" or an explicit checklist. A toggle chooses the mode;
  // when "selected" is chosen, the checklist below is honoured.
  const eventsModeField = field({
    id: "rule-events-mode",
    label: "Events",
    kind: "select",
    value: existing && existing.events !== "all" ? "selected" : "all",
    hint: "Select every event, or pick specific ones. The minimum severity still applies.",
    options: [
      { value: "all", label: "All events (severity-filtered)" },
      { value: "selected", label: "Selected events only" },
    ],
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "rules-which-events-reach-which-channels" },
  });

  const eventChecks = NOTIFY_EVENTS.map((e) => {
    const initiallyChecked = existing && existing.events !== "all" ? existing.events.includes(e.event) : false;
    return { def: e, checkbox: checkboxRow(`rule-event-${e.event}`, `${e.label}`, e.severity, initiallyChecked) };
  });
  const eventsChecklist = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-2)" });
  eventsChecklist.appendChild(h("p", { class: "field__label" }, "Events to select"));
  // Group-level doc link (field audit G2): the event checklist is a raw checkbox group, so the one link
  // that explains what each event means and which actually fire lives on the group, not on any single box.
  eventsChecklist.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/alert-events", target: "_blank", rel: "noreferrer noopener" },
      "About alert events",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  for (const ec of eventChecks) eventsChecklist.appendChild(ec.checkbox.el);
  const eventsChecklistHost = h("div");
  const refreshEventsMode = (): void => {
    eventsChecklistHost.replaceChildren(eventsModeField.value() === "selected" ? eventsChecklist : h("span"));
  };
  eventsModeField.control.addEventListener("change", refreshEventsMode);

  // The channel selection: a checklist over the configured channels (at least one).
  const channelChecks = channels.map((c) => ({
    channel: c,
    checkbox: checkboxRow(`rule-channel-${c.id}`, c.name, c.kind, existing ? existing.channelIds.includes(c.id) : channels.length === 1),
  }));
  const channelChecklist = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-2)" });
  channelChecklist.appendChild(h("p", { class: "field__label" }, "Deliver to channels"));
  // Group-level doc link (field audit G2): the channel checklist is a raw checkbox group; the one link
  // explaining that a rule must deliver to at least one channel lives on the group, not on any single box.
  channelChecklist.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/notifications#rules-which-events-reach-which-channels", target: "_blank", rel: "noreferrer noopener" },
      "About delivery channels",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  for (const cc of channelChecks) channelChecklist.appendChild(cc.checkbox.el);

  const digestField = field({
    id: "rule-digest",
    label: "Digest (success-class events)",
    kind: "select",
    value: existing?.digest ?? "off",
    hint: "Batch success-class events into a digest instead of sending each one. Failure and stale alerts are never batched.",
    options: [
      { value: "off", label: "Off (send individually)" },
      { value: "daily", label: "Daily digest" },
      { value: "weekly", label: "Weekly digest" },
    ],
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "rules-which-events-reach-which-channels" },
  });

  // Enabled is shown only on edit (a new rule starts enabled; offering "Disabled" on
  // create is a state nobody starts in) and as a one-click checkbox, not a select.
  const enabledCheck = existing ? checkboxRow("rule-enabled", "Enabled", "a disabled rule delivers nothing until re-enabled", existing.enabled) : null;

  const downpipeHost = h("div");
  const refreshScope = (): void => {
    downpipeHost.replaceChildren(scopeKindField.value() === "downpipe" ? downpipeSelectField.el : h("span"));
  };
  scopeKindField.control.addEventListener("change", refreshScope);

  return {
    scopeKindField,
    downpipeSelectField,
    minSeverityField,
    eventsModeField,
    eventChecks,
    channelChecks,
    digestField,
    enabledCheck,
    downpipeHost,
    eventsChecklistHost,
    channelChecklist,
    refreshScope,
    refreshEventsMode,
  };
}

// Wire the inline severity-mismatch warning: a rule whose minimum severity exceeds EVERY
// selected event's fixed severity saves fine but can never deliver anything. Warn inline at
// edit time (a polite status, not a blocker: the engine accepts the rule), recomputed on
// every relevant change. The event->severity map is NOTIFY_EVENTS. Returns the warning
// element to place in the form. Moved verbatim from openRuleForm.
export function wireSeverityWarn(controls: RuleFormControls): HTMLElement {
  const { minSeverityField, eventsModeField, eventChecks } = controls;
  const severityWarn = h("p", { class: "field__hint", role: "status", hidden: true, style: "color:var(--warn-fg)" });
  const refreshSeverityWarn = (): void => {
    const min = severityRank(minSeverityField.value() as Severity);
    const selected = eventChecks.filter((ec) => ec.checkbox.checked()).map((ec) => ec.def);
    const inert = eventsModeField.value() === "selected" && selected.length > 0 && selected.every((d) => severityRank(d.severity) < min);
    severityWarn.hidden = !inert;
    severityWarn.textContent = inert
      ? "No selected event meets this minimum severity, so this rule can never deliver anything. Lower the minimum severity or select a higher-severity event."
      : "";
  };
  minSeverityField.control.addEventListener("change", refreshSeverityWarn);
  eventsModeField.control.addEventListener("change", refreshSeverityWarn);
  // checkboxRow wraps the input in a label; the change event bubbles to the row.
  for (const ec of eventChecks) ec.checkbox.el.addEventListener("change", refreshSeverityWarn);
  refreshSeverityWarn();
  return severityWarn;
}

// The Save handler: validate the downpipe picker when in per-downpipe scope, build the rule
// input via the pure builder (so the selection rules are unit-tested without a DOM), then
// upsert. A validation refusal or engine refusal is surfaced inline; input is never lost.
// Moved verbatim from openRuleForm's onClick.
export function submitRuleForm(
  engine: EngineClient,
  existing: NotifyRule | null,
  controls: RuleFormControls,
  formError: HTMLElement,
  reload: () => void,
): () => Promise<boolean> {
  const { scopeKindField, downpipeSelectField, minSeverityField, eventsModeField, eventChecks, channelChecks, digestField, enabledCheck } = controls;
  return async () => {
    formError.hidden = true;

    const fieldsToValidate: Field[] = [];
    if (scopeKindField.value() === "downpipe") fieldsToValidate.push(downpipeSelectField);
    if (!validateForm(fieldsToValidate)) return false;

    // Build the rule input via the pure builder (so the selection rules are unit-
    // tested without a DOM): at least one channel and, when not "all", at least one
    // event. A validation failure is surfaced inline; input is never lost.
    const channelIds = channelChecks.filter((cc) => cc.checkbox.checked()).map((cc) => cc.channel.id);
    const selectedEvents = eventChecks.filter((ec) => ec.checkbox.checked()).map((ec) => ec.def.event);
    const built = buildRuleInputFrom({
      existingId: existing ? existing.id : null,
      scopeKind: scopeKindField.value() === "downpipe" ? "downpipe" : "global",
      downpipeId: downpipeSelectField.value(),
      minSeverity: minSeverityField.value() as Severity,
      eventsMode: eventsModeField.value() === "all" ? "all" : "selected",
      selectedEvents,
      channelIds,
      digest: digestField.value() as "off" | "daily" | "weekly",
      enabled: enabledCheck ? enabledCheck.checked() : true,
    });
    if ("error" in built) {
      formError.textContent = built.error;
      formError.hidden = false;
      return false;
    }
    const input = built.input;

    try {
      const res = await engine.upsertNotifyRule(input);
      if (res.status === "pending") surfacePendingChange("notification rule");
      else toast({ message: existing ? "Rule updated" : "Rule added" });
      reload();
      return true;
    } catch (err) {
      if (isUnauthorised(err)) {
        goSignedOut();
        return true;
      }
      formError.textContent = isStepUpRequired(err) ? `The rule was not saved. ${stepUpAwareText(err)}` : `The engine refused the rule (${errText(err)}).`;
      formError.hidden = false;
      return false;
    }
  };
}
