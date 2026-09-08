// The per-vendor SETUP BODY: what a tile opens. It does NOT reinvent the config plumbing; it REUSES the proven
// config surfaces the Settings and Notifications screens already ship, framed with the vendor's own method line
// and (where honest) the auto-parse note. One dispatcher over the SetupKind:
//
//   push          the vendor's recommended format + sink, then the real SIEM-push panel (renderPushDestination)
//   metrics-push  the auto-parse note, then the real OTLP-push panel (renderOtlpPushDestination)
//   pull          the audit-feed URL to copy, then the real pull-credential panel (renderPullCredentials)
//   metrics       the /metrics URL to copy, then the same pull-credential panel (the metrics scope)
//   notify        the channels of this kind, and an Add/Edit that opens the real channel form pre-set to it
//
// The write paths (push / OTLP / support) are hard OWNER-ONLY server-side (there is no narrower capability), so
// a non-owner sees the same panel with the honest owner gate instead of the form, exactly as Settings does. The
// notify path is the notify.config capability. The coordinator computes `canManage` per kind and passes it here.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { copyToClipboard } from "../../lib/file-delivery.ts";
import { ICON_PLUS, ICON_INFO } from "../../lib/icons.ts";
import { banner } from "../../components/feedback.ts";
import type { EngineClient, NotifyChannel } from "../../api.ts";
import { docsUrl, type Vendor, vendorSlug } from "./catalogue.ts";
import { pushFormatLabel, pushSinkLabel } from "../settings/push-model.ts";
import { renderPushDestination } from "../settings/push.ts";
import { renderOtlpPushDestination } from "../settings/otlp-push.ts";
import { renderPullCredentials } from "../settings/support.ts";
import { openChannelForm } from "../notifications/channels.ts";
import { openRuleForm } from "../notifications/rules.ts";
import { navigate } from "../../lib/nav.ts";
import { notifyChannelsFor, rulesForVendor, inertRoutesText, noLiveRouteText, pushOwnedBy, type ConfigSnapshot } from "./state.ts";
import type { ManageGate } from "./grid.ts";
import { blindGateRemedy } from "../../lib/identity-remedy.ts";
import { capGateReason, refuseWithReason } from "../common.ts";

// methodLine is the one honest sentence naming how this destination connects (never a marketing claim).
function methodLine(v: Vendor): HTMLElement {
  return h("p", { class: "field__hint measure", style: "margin:0" }, v.method);
}

// autoNote is the teal callout shown only where the destination genuinely auto-parses.
function autoNote(v: Vendor): HTMLElement {
  return h(
    "div",
    { class: "integration-note integration-note--auto", role: "note" },
    h("b", {}, "Auto-parses. "),
    `${v.name} reads our format natively, so there is nothing to map.`,
  );
}

// ownerGate mirrors the engine's owner-only rule as UX (the same gate Settings shows).
function ownerGate(what: string): HTMLElement {
  return banner({ tone: "info", message: `Configuring ${what} is owner only (it sets where your audit trail or metrics egress). You can see its current state above.` });
}

// unresolvedGate is the sentence for the state this panel used to render AS ownerGate: no identity report has
// arrived, so whether this reader may configure the destination is NOT YET KNOWN. Printing the owner-only
// refusal here told an actual owner they were not the owner, and offered them the one remedy that is useless
// to an owner, which is to ask an owner. The remedy comes from blindGateRemedy so this screen and every other
// gated screen say the same thing about the same state.
function unresolvedGate(what: string): HTMLElement {
  return banner({ tone: "info", message: `Whether you can configure ${what} is not known yet. ${blindGateRemedy()} You can see its current state above.` });
}

// setupGate picks between the two refusal sentences for the owner-only setup kinds.
function setupGate(gate: ManageGate, what: string): HTMLElement {
  return gate === "unresolved" ? unresolvedGate(what) : ownerGate(what);
}

// copyUrl is a small labelled, copyable URL row (the audit-feed / metrics endpoint a pull vendor points at).
//
// The copy goes through the guarded clipboard primitive. It used to be a bare
// `navigator.clipboard?.writeText(url).then(...)`, which failed silently in two ways at once: on a browser
// with no clipboard the optional chain short-circuited and the button simply never changed, and a REJECTED
// write (a permissions policy, a document without focus) had no rejection handler at all. Either way the
// operator believed they had copied an endpoint they had not, pasted a stale value into the vendor, and the
// feed they configured pointed nowhere. The refusal is now said out loud and recorded in the pack.
function copyUrl(label: string, url: string): HTMLElement {
  const btn = h("button", { "data-dp": "integrations.button.copy-url", class: "btn btn--ghost btn--sm", type: "button" }, "Copy") as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    btn.textContent = (await copyToClipboard(url, "integrations-copy")) ? "Copied" : "Copy refused";
  });
  return h(
    "div",
    { class: "field" },
    h("label", { class: "field__label" }, label),
    h("div", { class: "integration-urlrow" }, h("code", { class: "integration-url" }, url), btn),
  );
}

// notifyBody lists the existing channels of this vendor's kind and opens the real channel form (pre-set to the
// kind) to add or edit one. Reuses openChannelForm verbatim, so create/edit/test/delete and the config-change
// dual-control all behave exactly as on the Notifications screen.
function notifyBody(engine: EngineClient, v: Vendor, gate: ManageGate, snap: ConfigSnapshot, reload: () => void): HTMLElement {
  const canManage = gate === "allowed";
  const wrap = h("div", { class: "stack-sm", style: "display:grid;gap:var(--space-3)" }, methodLine(v));
  if (v.auto) wrap.appendChild(autoNote(v));
  const existing = notifyChannelsFor(v, snap.channels);

  if (existing.length > 0) {
    const list = h("div", { style: "display:grid;gap:var(--space-2)" });
    for (const ch of existing) {
      const edit = h("button", { "data-dp": "integrations.button.edit", class: "btn btn--secondary btn--sm", type: "button" }, "Manage") as HTMLButtonElement;
      if (canManage) edit.addEventListener("click", () => openChannelForm(engine, ch, reload, v.channelKind));
      // The else branch attaches nothing, which is what makes it safe to keep the control
      // focusable so its reason is reachable without a mouse.
      else refuseWithReason(edit, capGateReason("notify.config"));
      list.appendChild(
        h("div", { class: "integration-chrow" },
          h("span", {}, h("b", {}, ch.name), ch.enabled ? "" : " (off)"),
          edit),
      );
    }
    wrap.appendChild(list);
    // The connect->route loop: a channel with no alert rule is inert, so show what routes here and let the
    // owner choose it without leaving the panel.
    wrap.appendChild(routingSection(engine, v, existing, canManage, snap, reload));
  }

  if (canManage) {
    const add = h("button", { "data-dp": "integrations.button.add", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), existing.length ? `Add another ${v.name} channel` : `Add ${v.name}`) as HTMLButtonElement;
    add.addEventListener("click", () => openChannelForm(engine, null, reload, v.channelKind));
    wrap.appendChild(h("div", {}, add));
  } else {
    wrap.appendChild(h("p", { class: "field__hint measure" }, gate === "unresolved"
      ? `Whether you can add a notification channel is not known yet. ${blindGateRemedy()}`
      : "Adding a notification channel needs the notifications capability. An owner can grant it on the Roles and access tab."));
  }
  return wrap;
}

// routingSection closes the connect->route loop: a channel with no alert rule delivers nothing, so it shows what
// (if anything) routes to this vendor's channels, and lets the owner set it up in place. "Choose what alerts X"
// opens the real rule form (openRuleForm) pre-targeting this vendor's channels (the form pre-checks the sole
// channel), so connecting and routing are one flow rather than two screens; "Manage alert rules" goes to the
// Notifications rules tab for the full picture. The rule write is the same notify.config capability as the
// channel write, so canManage gates both.
//
// The count is of LIVE routes only. A rule that names this vendor's channels but is turned off, or is scoped
// to a downpipe the operator has deleted, delivers nothing, and counting it here printed a routing claim for a
// channel that reaches nobody while suppressing both the warning and the "Choose what alerts X" action. Those
// rules are named in their own line instead, with their ids, so the operator can go and repair the row.
function routingSection(engine: EngineClient, v: Vendor, channels: NotifyChannel[], canManage: boolean, snap: ConfigSnapshot, reload: () => void): HTMLElement {
  const routes = rulesForVendor(v, snap);
  const box = h("div", { style: "display:grid;gap:var(--space-2)" });
  if (routes.live.length === 0) {
    box.appendChild(banner({ tone: "warn", message: noLiveRouteText(v, routes) }));
  } else {
    box.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, `${routes.live.length} alert rule${routes.live.length === 1 ? "" : "s"} route events to ${v.name}.`));
  }
  const dead = inertRoutesText(v, routes, snap.downpipes);
  if (dead !== null) box.appendChild(banner({ tone: "warn", message: dead }));
  const actions = h("div", { style: "display:flex;gap:var(--space-4);align-items:center;flex-wrap:wrap" });
  if (canManage && routes.live.length === 0) {
    const set = h("button", { "data-dp": "integrations.button.set", class: "btn btn--primary btn--sm", type: "button" }, `Choose what alerts ${v.name}`) as HTMLButtonElement;
    set.addEventListener("click", () => openRuleForm(engine, null, channels, snap.downpipes, reload));
    actions.appendChild(set);
  }
  const manage = h("button", { "data-dp": "integrations.button.manage", class: "linklike", type: "button" }, "Manage alert rules") as HTMLButtonElement;
  manage.addEventListener("click", () => navigate("/notifications/rules"));
  actions.appendChild(manage);
  box.appendChild(actions);
  return box;
}

// renderSetupBody dispatches on the vendor's SetupKind, returning the panel body the coordinator mounts under
// the panel header. The origin is read once for the pull/metrics URLs.
export function renderSetupBody(engine: EngineClient, v: Vendor, gate: ManageGate, snap: ConfigSnapshot, reload: () => void): HTMLElement {
  const body = h("div", { style: "display:grid;gap:var(--space-4)" });
  // One gate, two sentences: the form is offered ONLY on "allowed" (unchanged), and a refusal that has not
  // been established is said as such rather than as a role denial.
  const canManage = gate === "allowed";

  switch (v.kind) {
    case "push": {
      body.appendChild(methodLine(v));
      if (v.auto) body.appendChild(autoNote(v));
      else if (v.pushFormat && v.pushSink) {
        body.appendChild(h("p", { class: "field__hint measure", style: "margin:0" },
          `Recommended for ${v.name}: ${pushFormatLabel(v.pushFormat)} over ${pushSinkLabel(v.pushSink).toLowerCase()}. Set it below.`));
      }
      // Lock the wire format + sink to this vendor's, so the push form is Splunk's (its endpoint + token), not
      // a generic picker you could set to another SIEM's wire. The lock also carries the vendor's IDENTITY tag
      // (stored with the config, so the console reads which vendor a live push is rather than guessing from the
      // wire) and this vendor's own credential scheme, label and example, which is what makes the secret field's
      // rule Splunk's on Splunk's tile and a plain bearer token's on CrowdStrike's.
      const lock = v.pushFormat && v.pushSink
        ? {
            format: v.pushFormat,
            sink: v.pushSink,
            vendor: vendorSlug(v),
            ...(v.credLabel !== undefined ? { credLabel: v.credLabel } : {}),
            ...(v.credScheme !== undefined ? { credScheme: v.credScheme } : {}),
            ...(v.credExample !== undefined ? { credExample: v.credExample } : {}),
          }
        : undefined;
      // isOwn tells the panel whether the live push belongs to THIS vendor, so a tile that is not the active one
      // shows a clean "set up" state rather than another vendor's active config (the push is one destination).
      body.appendChild(canManage ? renderPushDestination(engine, lock, (view) => pushOwnedBy(v, view), v.name) : setupGate(gate, "the SIEM audit-log push"));
      return body;
    }
    case "metrics-push": {
      body.appendChild(methodLine(v));
      body.appendChild(autoNote(v));
      body.appendChild(canManage ? renderOtlpPushDestination(engine) : setupGate(gate, "the OTLP metrics push"));
      return body;
    }
    case "pull": {
      body.appendChild(methodLine(v));
      body.appendChild(copyUrl("Audit feed URL", auditFeedUrl(engine)));
      body.appendChild(canManage ? renderPullCredentials(engine, "audit-feed", docsUrl(v)) : setupGate(gate, "the pull credentials"));
      return body;
    }
    case "metrics": {
      body.appendChild(methodLine(v));
      body.appendChild(copyUrl("Metrics endpoint", metricsUrl(engine)));
      body.appendChild(canManage ? renderPullCredentials(engine, "metrics", docsUrl(v)) : setupGate(gate, "the metrics credentials"));
      return body;
    }
    case "notify":
      return notifyBody(engine, v, gate, snap, reload);
    default:
      return h("div", { class: "field__hint" }, svgIcon(ICON_INFO, { size: 16 }), " No setup for this destination.");
  }
}

// metricsUrl / auditFeedUrl derive the two pull endpoints. metricsEndpointUrl() is a client helper; the audit
// feed has no builder yet (a known asymmetry), so it is composed from the same engine origin.
function metricsUrl(engine: EngineClient): string {
  const withUrl = engine as unknown as { metricsEndpointUrl?: () => string };
  return typeof withUrl.metricsEndpointUrl === "function" ? withUrl.metricsEndpointUrl() : `${originOf(engine)}/metrics`;
}
function auditFeedUrl(engine: EngineClient): string {
  return `${originOf(engine)}/support/audit-feed`;
}
function originOf(engine: EngineClient): string {
  const withOrigin = engine as unknown as { origin?: string; baseUrl?: string };
  return (withOrigin.origin ?? withOrigin.baseUrl ?? "").replace(/\/+$/, "");
}
