// Notifications (build contract section 2 + section 9 console surfaces): the channels
// CRUD, the routing rules (global + per-downpipe), the delivery history, and a
// redaction-safe test-send. This is the customer's own alerting config and outcome
// history in their own account; the vendor never reads it.
//
// House rules carried through:
//   - No-custody: a channel carries the customer's own url / pagerduty routing key /
//     email addresses (their config), never a key or value; the history detail is a
//     redaction-safe one-liner. Every server-supplied string enters the DOM via
//     textContent / typed element creation (dom.ts).
//   - Capability gating: every WRITE affordance is gated with can(caller.role,
//     "notify.config"), the CLIENT MIRROR of the engine's server-side gate. A gated
//     control is shown disabled-with-reason, never hidden-then-403. Reads are any role.
//   - Two-channel error model: a thrown 401 routes to signed-out; a transport/5xx on a
//     load is a block error with Retry; a malformed channel/rule is the engine's 400
//     { error } surfaced INLINE; a confirmational success is a toast.
//   - Fail-open is the ENGINE's invariant; the console only reports { ok } from a test
//     send and never blocks on delivery.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, render), the
// accessible sub-view tablist, and re-exports the symbols external callers (the notifications validator)
// depend on. The channels panel + add/edit-channel form lives in ./notifications/channels.ts; the rules
// panel + add/edit-rule form in ./notifications/rules.ts; the delivery-history panel in
// ./notifications/history.ts; the shared catalogues, pure input builders/validators and small presenters in
// ./notifications/shared.ts. The file was split for size while keeping the public surface byte-identical.
//
// CSP / CSSOM: styles are applied via h() + node.style.setProperty (the dom.ts builder),
// never setAttribute("style"); escapeHTML / textContent on every server string.

import { h } from "../lib/dom.ts";
import {
  pageHeader,
  requireEngine,
  type Screen,
  type ScreenContext,
} from "./common.ts";
import { navigate, requestPostNavigationFocus } from "../lib/nav.ts";
import type { EngineClient } from "../api.ts";
import { ROUTE_CHANNELS, ROUTE_RULES, ROUTE_HISTORY, type NotifyTab } from "./notifications/shared.ts";
import { renderChannelsPanel } from "./notifications/channels.ts";
import { renderRulesPanel } from "./notifications/rules.ts";
import { renderHistoryPanel } from "./notifications/history.ts";

// Re-exports: the notifications validator (test/validate-notifications.ts) imports the severity rank, the
// event-label resolver, the NotifyEvent catalogue and the RuleFormValues type BY NAME from this module, and
// the api validator pins the pure input builders / channel-url validators; the split keeps every one of those
// imports working unchanged. They live in the ./notifications/shared.ts leaf (all pure + DOM-free); re-exporting
// them here keeps the public import surface of screens/notifications.ts byte-identical.
export {
  severityRank,
  eventLabel,
  NOTIFY_EVENTS,
  CHANNEL_KINDS,
  buildChannelInputFrom,
  buildRuleInputFrom,
  validateUrl,
  validateAddresses,
  parseAddresses,
  type RuleFormValues,
} from "./notifications/shared.ts";

// The screen descriptor. It owns the three deep-linkable
// sub-views behind an accessible tablist. measure:"wide" because channels, rules
// and history are dense tables. The palette commands live in shell/registry.ts
// (per the task), so this descriptor contributes no duplicate actions.

export const notificationsScreen: Screen = {
  route: [ROUTE_CHANNELS, ROUTE_RULES, ROUTE_HISTORY],
  title: "Notifications",
  measure: "wide",
  actions: [],
  render(ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    const tab = tabFor(ctx.pattern || ctx.path);

    root.appendChild(
      pageHeader(
        "Notifications",
        "Where alerts go and which events reach them. Failure and stale alerts are on by default once you add a channel; success events are available via a digest. This is your own configuration in your own account; the vendor never reads it and never sends on your behalf.",
      ),
    );

    root.appendChild(areaTabs(tab));

    const panel = h("div", {
      class: "area-panel",
      id: `notify-panel-${tab}`,
      role: "tabpanel",
      "aria-labelledby": `notify-tab-${tab}`,
      tabindex: "0",
      style: "margin-top:var(--space-5)",
    });
    panel.appendChild(renderTab(tab, engine));
    root.appendChild(panel);

    if (pendingTabKeyboardFocus) {
      pendingTabKeyboardFocus = false;
      // Declared to the shell rather than scheduled here, for the reason the Keys tablist carries in full:
      // a queueMicrotask restore runs before the shell has mounted this root under a view transition, and
      // the shell's own post-navigation focus move to <main> overwrites it when it does land. See
      // lib/nav.ts requestPostNavigationFocus.
      requestPostNavigationFocus(() => root.querySelector<HTMLButtonElement>(`#notify-tab-${tab}`));
    }

    return root;
  },
};

function tabFor(pattern: string): NotifyTab {
  switch (pattern) {
    case ROUTE_RULES: return "rules";
    case ROUTE_HISTORY: return "history";
    default: return "channels";
  }
}

function renderTab(tab: NotifyTab, engine: EngineClient): HTMLElement {
  switch (tab) {
    case "rules": return renderRulesPanel(engine);
    case "history": return renderHistoryPanel(engine);
    case "channels": return renderChannelsPanel(engine);
  }
}

// The accessible sub-view tablist (the same generic underline-tab treatment the
// access-security area uses: roving tabindex, arrow keys, Home/End; activating a
// tab navigates to its route so the view is deep-linkable).

let pendingTabKeyboardFocus = false;

function areaTabs(active: NotifyTab): HTMLElement {
  const defs: Array<{ id: NotifyTab; label: string; route: string }> = [
    { id: "channels", label: "Channels", route: ROUTE_CHANNELS },
    { id: "rules", label: "Rules", route: ROUTE_RULES },
    { id: "history", label: "History", route: ROUTE_HISTORY },
  ];

  const list = h("div", { class: "drawer-tablist", role: "tablist", "aria-label": "Notification sections", style: "margin-top:var(--space-5)" });

  defs.forEach((def) => {
    const selected = def.id === active;
    const btn = h(
      "button",
      {
        class: "drawer-tab",
        type: "button",
        role: "tab",
        id: `notify-tab-${def.id}`,
        "aria-controls": `notify-panel-${def.id}`,
        "aria-selected": selected ? "true" : "false",
        tabindex: selected ? "0" : "-1",
      },
      def.label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      if (!selected) navigate(def.route);
    });
    list.appendChild(btn);
  });

  list.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "Home" && ev.key !== "End") return;
    const idx = defs.findIndex((d) => d.id === active);
    let next = idx;
    if (ev.key === "ArrowRight") next = (idx + 1) % defs.length;
    else if (ev.key === "ArrowLeft") next = (idx - 1 + defs.length) % defs.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = defs.length - 1;
    ev.preventDefault();
    pendingTabKeyboardFocus = true;
    // next is bounded by modular arithmetic on defs.length, so the index is always valid.
    navigate(defs[next]!.route);
  });

  return list;
}
