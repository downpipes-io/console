// Notifications panel 2, RULES (global + per-downpipe): which events reach which channels. A global rule is the
// default; a per-downpipe rule overrides the global default for the same event class on that downpipe. The
// rules table (showing channel names, muting disabled channels), the per-row edit/delete, and the add/edit-rule
// modal (scope, minimum severity, the event selection, the channel checklist, an optional digest, and the
// inline severity-mismatch warning). The rule input is built via the pure buildRuleInputFrom so the selection
// rules are unit-tested without a DOM. Moved verbatim from the notifications coordinator for size; it imports
// the shared leaf (./shared.ts) only, so it never imports another panel module (which would form a cycle).
//
// House rules: disabled-with-reason, never hidden-then-403; honest copy; Australian English, no em dashes.

import { h } from "../../lib/dom.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError, sessionEnded, stepUpAwareText } from "../../components/error-view.ts";
import { skeletonRows, emptyState, banner } from "../../components/feedback.ts";
import { dataTable } from "../../components/data-table.ts";
import { openModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { badge, statusWithLabel } from "../../components/status.ts";
import { ICON_PLUS } from "../../lib/icons.ts";
import { isPendingResult } from "../../api.ts";
import type { EngineClient, DownpipeState, NotifyChannel, NotifyRule } from "../../api.ts";
import {
  ROUTE_CHANNELS,
  callerCanCap,
  primaryButton,
  readOnlyNote,
  scopeBadge,
  scopeText,
  severityRank,
  severityBadge,
  eventsText,
  eventsCell,
} from "./shared.ts";
import { buildRuleFormControls, wireSeverityWarn, submitRuleForm } from "./rule-form.ts";

export function renderRulesPanel(engine: EngineClient): HTMLElement {
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-5)", "aria-labelledby": "rules-h" });
  wrap.appendChild(
    h(
      "div",
      { style: "display:grid;gap:var(--space-1)" },
      h("h2", { id: "rules-h", style: "font-size:var(--text-lg)" }, h("span", { dataset: { tourId: "notify-rules" } }, "Rules")),
      h("p", { class: "field__hint measure" }, "Which events reach which channels. A global rule is the default; a per-downpipe rule overrides the global default for the same event class on that downpipe. A rule delivers events at or above its minimum severity."),
    ),
  );

  // Rules reference channels by id and a per-downpipe scope references a downpipe; load
  // all three so a rule can show channel names and the add/edit form can offer real
  // pickers (never a hand-typed opaque id). A rule that names an unknown channel is
  // shown honestly as "unknown channel" rather than a blank.
  const region = h("div", { class: "async-region" });
  wrap.appendChild(region);

  const load = (): void => {
    region.replaceChildren(skeletonRows(4));
    void Promise.all([engine.listNotifyRules(), engine.listNotifyChannels(), engine.listDownpipes()])
      .then(([rules, channels, downpipes]) => region.replaceChildren(renderRulesTable(engine, rules, channels, downpipes, load)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the rules table is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        region.replaceChildren(blockError(err, load, { origin: location.origin }));
      });
  };
  load();

  return wrap;
}

function renderRulesTable(engine: EngineClient, rules: NotifyRule[], channels: NotifyChannel[], downpipes: DownpipeState[], reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  const writeGate = callerCanCap("notify.config");
  const channelName = (id: string): string => channels.find((c) => c.id === id)?.name ?? "unknown channel";

  const noChannels = channels.length === 0;
  const addBtn = primaryButton("Add rule", ICON_PLUS, writeGate && !noChannels, () => openRuleForm(engine, null, channels, downpipes, reload));
  if (writeGate && noChannels) addBtn.title = "Add a channel first; a rule must deliver to at least one channel.";

  const toolbar = h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap" });
  toolbar.appendChild(h("h3", { style: "font-size:var(--text-md)" }, h("span", { dataset: { tourId: "notify-routing" } }, "Routing rules")));
  toolbar.appendChild(addBtn);
  wrap.appendChild(toolbar);
  if (!writeGate) wrap.appendChild(readOnlyNote());

  if (noChannels) {
    wrap.appendChild(
      banner({
        tone: "info",
        message: "Add a channel before adding a rule; a rule must deliver to at least one channel.",
        action: { label: "Go to Channels", onClick: () => navigate(ROUTE_CHANNELS) },
      }),
    );
  }

  if (rules.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "No rules yet",
        body: "The engine creates a default global rule (failure and stale alerts) with your first channel; add rules to widen coverage or to override per downpipe.",
        ...(writeGate && !noChannels ? { action: { label: "Add a rule", onClick: () => openRuleForm(engine, null, channels, downpipes, reload) } } : {}),
      }),
    );
    return wrap;
  }

  const handle = dataTable<NotifyRule>({
    label: "Notification rules",
    rows: rules,
    rowKey: (r) => r.id,
    filter: { placeholder: "Filter rules", resultLabel: "rules", getText: (r) => `${scopeText(r.scope)} ${r.minSeverity} ${eventsText(r.events)} ${r.channelIds.map(channelName).join(" ")}` },
    initialSort: { key: "scope", dir: "asc" },
    columns: [
      { key: "scope", header: "Scope", sortable: true, sortValue: (r) => scopeText(r.scope), render: (r) => scopeBadge(r.scope, downpipes) },
      { key: "severity", header: "Min severity", sortable: true, sortValue: (r) => severityRank(r.minSeverity), render: (r) => severityBadge(r.minSeverity) },
      { key: "events", header: "Events", render: (r) => eventsCell(r.events) },
      {
        key: "channels",
        header: "Channels",
        render: (r) => {
          const cell = h("span");
          if (r.channelIds.length === 0) return h("span", { class: "field__hint" }, "none");
          r.channelIds.forEach((id, i) => {
            if (i > 0) cell.appendChild(document.createTextNode(", "));
            const ch = channels.find((c) => c.id === id);
            // A disabled channel delivers nothing: mute it and say so, so a rule that
            // routes only to disabled channels does not read as live delivery.
            if (!ch) cell.appendChild(h("span", { class: "field__hint" }, "unknown channel"));
            else if (!ch.enabled) cell.appendChild(h("span", { class: "field__hint" }, `${ch.name} (disabled)`));
            else cell.appendChild(h("span", { class: "mono" }, ch.name));
          });
          return cell;
        },
      },
      { key: "digest", header: "Digest", render: (r) => (r.digest && r.digest !== "off" ? badge("info", r.digest) : h("span", { class: "field__hint" }, "off")) },
      {
        key: "enabled",
        header: "Enabled",
        render: (r) => {
          if (!r.enabled) return statusWithLabel("neutral", "off");
          // An enabled rule with no REACHABLE channel delivers nothing, and reading "on" for it is the
          // overclaim this column exists to avoid: the rule matches, fires, and reaches nobody. Deleting a
          // channel does not prune it from the rules that named it (the engine removes the channel only), so
          // a rule can arrive in this state without anyone editing it. The Channels cell above already says
          // WHICH ids are unknown or disabled; this says what that means for the rule as a whole.
          return ruleDeliversNowhere(r, channels) ? statusWithLabel("warn", "delivers nowhere") : statusWithLabel("ok", "on");
        },
      },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        width: "1px",
        render: (r) => ruleRowActions(engine, r, channels, downpipes, writeGate, reload),
      },
    ],
  });
  wrap.appendChild(handle.el);

  return wrap;
}

// ruleDeliversNowhere reports whether an ENABLED rule can currently reach no channel at all: every id it
// names is either missing (the channel was deleted, and deleting a channel does not update the rules that
// referenced it) or present but disabled. Such a rule still matches its events and still runs; it simply
// delivers to nobody, and nothing else on this screen says so at the rule's own grain.
//
// A rule naming NO channels is deliberately NOT included: that is an empty configuration the operator can see
// directly in the Channels cell ("none"), not a rule whose delivery decayed underneath it. Pure over the two
// lists, so it is unit-tested directly.
export function ruleDeliversNowhere(rule: NotifyRule, channels: NotifyChannel[]): boolean {
  if (!rule.enabled || rule.channelIds.length === 0) return false;
  return !rule.channelIds.some((id) => channels.find((c) => c.id === id)?.enabled === true);
}

function ruleRowActions(engine: EngineClient, rule: NotifyRule, channels: NotifyChannel[], downpipes: DownpipeState[], writeGate: boolean, reload: () => void): HTMLElement {
  const wrap = h("div", { style: "display:flex;gap:var(--space-1);justify-content:flex-end" });
  // Read only: no row affordance; the one visible gate statement is the toolbar note.
  if (!writeGate) return wrap;

  const editBtn = h("button", { "data-dp": "notifications.button.edit#2", class: "btn btn--ghost btn--sm", type: "button" }, "Edit") as HTMLButtonElement;
  editBtn.addEventListener("click", () => openRuleForm(engine, rule, channels, downpipes, reload));
  wrap.appendChild(editBtn);

  const deleteBtn = h("button", { "data-dp": "notifications.button.delete#2", class: "btn btn--ghost btn--sm", type: "button" }, "Delete") as HTMLButtonElement;
  // The awaited delete runs INSIDE the confirm modal's busy onClick (the role-save
  // pattern), so the busyLabel covers the network call and a double fire is impossible.
  deleteBtn.addEventListener("click", () => {
    openModal({
      title: "Delete rule",
      body: h(
        "div",
        { style: "display:grid;gap:var(--space-3)" },
        h("p", { style: "color:var(--text)" }, `Delete this ${scopeText(rule.scope)} rule? Events it selected will no longer be delivered by it (another matching rule may still deliver them).`),
        h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is deleted and you can start again from this row."),
      ),
      actions: [
        { label: "Cancel", variant: "secondary", onClick: () => {} },
        {
          label: "Delete rule",
          variant: "danger",
          busyLabel: "Deleting",
          onClick: async () => {
            try {
              const res = await engine.deleteNotifyRule(rule.id);
              if (isPendingResult(res)) {
                // notify-rule-delete is change-control gated, so a 202 means the deletion was QUEUED for a
                // second approver and the rule STILL routes. Surface the queued state honestly (never
                // "Rule deleted") and leave the row in place; the deleteNotifyChannel sibling does the same.
                surfacePendingChange("rule deletion");
                return true;
              }
              toast({ message: "Rule deleted" });
              reload();
              return true;
            } catch (err) {
              if (isUnauthorised(err)) {
                goSignedOut();
                return true;
              }
              toast({ message: `Could not delete the rule. ${stepUpAwareText(err)}`, tone: "warn" });
              return false;
            }
          },
        },
      ],
    });
  });
  wrap.appendChild(deleteBtn);
  return wrap;
}

// openRuleForm is the add/edit-rule modal (notify.config). Scope (global or a specific
// downpipe), minimum severity, the event selection (all, or a checklist), the channel
// selection (a checklist over the configured channels), and an optional digest. The
// engine validates (unknown channel, empty selection) and a refusal is shown inline.
// The controls, the severity warning, and the save handler are built by ./rule-form.ts
// (factored out for size); this orchestrates them and assembles the modal.
export function openRuleForm(engine: EngineClient, existing: NotifyRule | null, channels: NotifyChannel[], downpipes: DownpipeState[], reload: () => void): void {
  const c = buildRuleFormControls(existing, channels, downpipes);
  c.refreshScope();
  c.refreshEventsMode();

  const severityWarn = wireSeverityWarn(c);

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const body = h(
    "form",
    { class: "form-stack", style: "display:grid;gap:var(--space-4)", "aria-label": existing ? "Edit rule" : "Add a rule", on: { submit: (ev: Event) => ev.preventDefault() } },
    c.scopeKindField.el,
    c.downpipeHost,
    c.minSeverityField.el,
    c.eventsModeField.el,
    c.eventsChecklistHost,
    severityWarn,
    c.channelChecklist,
    c.digestField.el,
    c.enabledCheck ? c.enabledCheck.el : false,
    // THE CEREMONY, named before the button rather than discovered after it. A rule decides which events are
    // ever noticed, so the engine treats saving one as a detection-config change and demands a fresh identity
    // check; the prompt opens on Save, after the form is filled in.
    h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey when you save. If you dismiss that prompt, or it fails, nothing is saved and your selections stay in this form."),
    formError,
  );

  openModal({
    title: existing ? "Edit rule" : "Add a rule",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Save rule",
        variant: "primary",
        busyLabel: "Saving",
        onClick: submitRuleForm(engine, existing, c, formError, reload),
      },
    ],
  });
}
