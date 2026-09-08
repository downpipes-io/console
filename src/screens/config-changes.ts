// Config approvals (the DUAL-CONTROL config change-control inbox): the pending config mutations the engine's
// opt-in four-eyes / dual-control gate is holding for a SECOND approver. It is the config-mutation analogue of
// the restore dual-control approvals inbox (src/screens/restore-flow.ts renderApprovalsInbox), and it
// deliberately mirrors that screen's visual + interaction pattern: a polled list of cards, each showing
// the plain-English diff, who proposed it and when, with Approve / Reject actions, and the maker != checker
// rule made explicit on a caller's OWN proposal ("you proposed this, awaiting another approver").
//
// THE GATE (client MIRROR; the engine is the control). When the account requires config approval (the
// Owner toggle in the Security Centre), a config mutation (saving a downpipe, setting a role or custom
// role, a notify channel/rule/webhook, a posture risk-accept, an expiry item) is QUEUED here instead of
// applied. Approving applies it; the approver MUST hold the change's own WRITE capability AND differ from
// the proposer (maker != checker). Both are enforced SERVER-SIDE; this screen mirrors them so the Approve
// button is never a dead end: it is hidden on a caller's own proposal, and disabled-with-reason for a
// caller whose capability set does not hold the change's write capability.
//
// House rules: read gated on downpipe.read (the read floor; any authenticated role may see the queue),
// the approve/reject actions gated (best-effort) on the change's write capability. Every server-supplied
// string (the diff, the proposer email, the kind) enters the DOM as a TEXT NODE via the dom.ts h()
// builder; no innerHTML, no inline handlers, strict-CSP safe. No-custody: a change carries an id, a coarse
// kind, a redaction-safe diff, a proposer email and a timestamp only; never a value or a key.
//
// This module is SELF-OWNED: it exports one screen descriptor; app.ts wires it into SCREENS.

import { recordContractSkew } from "../lib/client-diag/ring.ts";
import { h, svgIcon } from "../lib/dom.ts";
import {
  pageHeader, requireEngine, canCap, capGateReason, defineScreen, collapsedSection, type Screen, type ScreenContext,
} from "./common.ts";
import { capabilityPhrase } from "./capability-copy.ts";
import { goSignedOut, caller, navigate } from "../lib/nav.ts";
import { isUnauthorised, classifyError, errText } from "../lib/errors.ts";
import { blockError, sessionEnded, stepUpAwareText } from "../components/error-view.ts";
import { skeletonRows, emptyState } from "../components/feedback.ts";
import { confirmModal } from "../components/modal.ts";
import { toast } from "../components/toast.ts";
import { badge, type StatusTone } from "../components/status.ts";
import { relativeTime } from "../lib/format.ts";
import { ICON_CHECK, ICON_CLOSE, ICON_ROLES } from "../lib/icons.ts";
import { callerCanApproveConfigChange, changeKindLabel, changeApproveCapability, diffLines, diffKindLabel, isMine } from "../lib/config-changes.ts";
import type { EngineClient, ConfigChange, ConfigChangeStatus, PendingChangeLine } from "../api.ts";

// The route the change-requests inbox owns (the config change-control surface).
export const ROUTE_CONFIG_CHANGES = "/config/changes";

export const configChangesScreen: Screen = defineScreen({
  route: ROUTE_CONFIG_CHANGES,
  title: "Config approvals",
  measure: "wide",
  // The screen-owned palette command: navigate to the config-approvals inbox (the DUAL-CONTROL config
  // change-control queue). Surfaced to roles that can APPROVE a config change (operator+ holds the most
  // common write caps; the inbox itself enforces the per-change capability). A pure viewer has nothing to
  // action here, so the gate is operator+.
  actions: [
    {
      id: "config-changes.open",
      title: "Review pending config approvals",
      group: "Actions",
      kind: "navigate",
      keywords: ["change", "changes", "approval", "approve", "four eyes", "dual control", "config", "pending", "second approver"],
      target: ROUTE_CONFIG_CHANGES,
      // callerCanApproveConfigChange is the one mirror of "holds ANY config write capability", derived
      // from CONFIG_WRITE_CAPS so it cannot drift from the per-kind approve map. It replaces a role-NAME
      // list that read the same way for the six built-ins but floored every NAMED custom role to the
      // "viewer" the engine pins on its role field, hiding the config-approvals inbox from a custom role
      // that genuinely holds notify.config or downpipe.write. It fails closed on a null caller.
      when: ({ caller: c }) => callerCanApproveConfigChange(c),
    },
  ],
  render(_ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;
    return renderChangeRequests(engine);
  },
});

// The poll cadence (ms): a newly queued change appears within this window without a manual reload.
const CONFIG_CHANGES_POLL_MS = 15_000;

// sigOf is the (id, status) signature of a fetched list, sorted+joined, so a poll can skip a repaint
// when nothing changed (an unconditional repaint would drop keyboard focus from an Approve/Reject
// button mid-interaction every poll tick).
function sigOf(changes: ConfigChange[]): string {
  return changes.map((c) => `${c.id}:${c.status}`).sort().join("|");
}

function renderChangeRequests(engine: EngineClient): HTMLElement {
  const root = h("div");
  root.appendChild(renderChangeRequestsHeader());

  const region = h("div", { class: "async-region" });
  root.appendChild(region);

  const me = caller()?.email ?? null;

  // The gate state resolves the empty inbox's ambiguity ("on, queue clear" vs "off, changes
  // apply immediately"). Best-effort: when the policy read fails the empty state keeps the
  // neutral copy rather than guessing a state the engine did not report.
  let gateOn: boolean | null = null;
  // The last painted signature, so the poll can skip an unchanged repaint.
  let renderedSig: string | null = null;

  const paint = (changes: ConfigChange[]): void => {
    renderedSig = sigOf(changes);
    region.replaceChildren(renderList(engine, changes, me, load, gateOn));
  };

  // Temporal coupling, made explicit: this policy fetch and the load() change-list fetch race.
  // The repaint below fires only when the change list has ALREADY rendered as empty by the time the
  // policy resolves (renderedSig === ""), so the now-known gate state can replace the empty copy. If
  // the policy resolves FIRST, renderedSig is still null and no repaint fires here; load()'s own paint
  // then reads the gateOn this closure already set. Either ordering ends with the correct gate state,
  // so do not reorder these two calls without preserving the renderedSig === "" guard. The catch keeps
  // the neutral empty copy when the policy read fails rather than guessing a gate state.
  void engine
    .getConfigApprovalPolicy()
    .then((p) => {
      gateOn = p.requireConfigApproval;
      // Repaint only when the empty state is already showing (its copy leads with the gate state).
      if (root.isConnected && renderedSig === "") paint([]);
    })
    .catch(() => { /* gate state unknown: the neutral empty copy stands */ });

  const load = (): void => {
    region.replaceChildren(skeletonRows(3));
    renderedSig = null;
    void engine
      .listConfigChanges()
      .then((changes) => paint(changes))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the change-request inbox is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(() => load()));
          return goSignedOut();
        }
        // Distinguish a not-yet-wired engine (404/501: the change-control routes are absent on this
        // build) from a genuine transport fault (5xx / network) where a Retry is appropriate, mirroring
        // the restore approvals inbox degrade.
        const kind = classifyError(err, { origin: location.origin });
        if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
          region.replaceChildren(
            emptyState({
              title: "Dual control is not available on this engine",
              body: "Dual control (four-eyes) queues a config change for a second approver before it applies; this engine build does not expose that gate yet, so nothing queues here. (This is separate from the change-number requirement in the Security centre, which records a change number against an action but adds no approver.)",
            }),
          );
        } else {
          region.replaceChildren(blockError(err, () => load(), { origin: location.origin }));
        }
      });
  };

  startConfigChangesPoll(root, engine, paint, () => renderedSig);
  load();
  return root;
}

// renderChangeRequestsHeader builds the page header plus the "where do I turn this on or off?" link
// row, kept out of renderChangeRequests so that function stays focused on the load/paint/poll wiring.
function renderChangeRequestsHeader(): HTMLElement {
  const wrap = h("div");
  wrap.appendChild(
    pageHeader(
      "Config approvals",
      "Config changes awaiting a second authorised approver under dual control (also called four-eyes). The approver must differ from whoever proposed the change (maker is not checker) and must hold that change's own permission. This is the approval queue; it is separate from the change-number requirement (change management), which records a change number against an action without adding an approver.",
      undefined,
      // Reached mid-task from a "queued for approval" toast or the Security centre's
      // gate toggle, so a referrer-aware crumb returns the approver to where they were,
      // the Security centre on a cold arrival.
      { label: "Security centre", to: "/security" },
    ),
  );
  // The "where do I turn this on or off?" line, as a real navigating link (not plain copy that
  // sent owners hunting). Deep-links straight to the Security Centre toggle (opens + scrolls to it).
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin-top:calc(-1 * var(--space-2))" },
      "Turn this requirement on or off in ",
      h("button", { "data-dp": "config-changes.button.navigate-security-open-dual-control", class: "linklike", type: "button", on: { click: () => navigate("/security?open=dual-control") } }, "Dual control (Security centre)"),
      ". See the full ",
      h("button", { "data-dp": "config-changes.button.navigate-config-history", class: "linklike", type: "button", on: { click: () => navigate("/config/history") } }, "config version history"),
      " for every change that has been applied.",
    ),
  );
  return wrap;
}

// startConfigChangesPoll runs the silent poll: re-fetch on the cadence so a newly queued change
// appears without a manual reload. It never blanks the list on a poll fault (only a successful fetch
// repaints); stops when detached; a sign-out on the poll hands off to goSignedOut. Mirrors the restore
// approvals inbox poll exactly. lastSig reads the live painted signature so an unchanged set is skipped.
function startConfigChangesPoll(
  root: HTMLElement,
  engine: EngineClient,
  paint: (changes: ConfigChange[]) => void,
  lastSig: () => string | null,
): void {
  const pollTick = window.setInterval(() => {
    if (!root.isConnected) { window.clearInterval(pollTick); return; }
    void engine.listConfigChanges().then((changes) => {
      if (!root.isConnected) return;
      // Skip the repaint when the (id, status) set is unchanged, so a steady poll never eats focus.
      if (sigOf(changes) === lastSig()) return;
      paint(changes);
    }).catch((err: unknown) => {
      if (isUnauthorised(err)) { window.clearInterval(pollTick); goSignedOut(); }
    });
  }, CONFIG_CHANGES_POLL_MS);
}

function renderList(engine: EngineClient, changes: ConfigChange[], me: string | null, reload: () => void, gateOn: boolean | null): HTMLElement {
  // Pending first (the actionable ones), then the rest newest-first, so the queue leads with what needs a
  // decision. A non-pending change (applied/rejected/superseded) is shown for context but carries no actions.
  const pending = changes.filter((c) => c.status === "pending");
  const others = changes.filter((c) => c.status !== "pending");
  if (changes.length === 0) {
    // Lead with the gate state: an empty queue means something different with dual control on
    // (queue clear) versus off (changes apply immediately). Unknown keeps the neutral copy.
    const body =
      gateOn === true
        ? "Dual-control approval is on and the queue is clear: nothing is waiting for a second approver."
        : gateOn === false
          ? "Dual-control approval is currently off, so config changes apply immediately and nothing queues here. Turn it on to require a second approver."
          : "When dual-control approval is on, a config change (saving a downpipe, a role, a notification rule, and so on) is queued here for a second approver instead of applying immediately. There is nothing waiting right now.";
    // When the gate is off, offer the real action: a button that deep-links to the Security Centre
    // toggle (opens + scrolls to it), instead of plain copy that left owners hunting for it.
    return emptyState({
      title: "No config approvals waiting",
      body,
      ...(gateOn === false
        ? { action: { label: "Turn on dual control", variant: "secondary" as const, onClick: () => navigate("/security?open=dual-control") } }
        : {}),
    });
  }
  const list = h("div", { class: "approval-list" });
  for (const c of pending) {
    list.appendChild(renderChangeCard(engine, c, me, reload));
  }
  if (pending.length === 0) {
    list.appendChild(h("p", { class: "field__hint" }, "Nothing is awaiting approval."));
  }
  // Decided history (applied/rejected/superseded) collapses so the pending cards are the whole
  // eager view; the context stays one click away rather than growing an unbounded scroll.
  if (others.length > 0) {
    const decided = h("div", { class: "approval-list" });
    for (const c of others) decided.appendChild(renderChangeCard(engine, c, me, reload));
    list.appendChild(collapsedSection(`Decided requests (${others.length})`, decided));
  }
  return list;
}

function renderChangeCard(engine: EngineClient, change: ConfigChange, me: string | null, reload: () => void): HTMLElement {
  const card = h("div", { class: "card approval-card" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h3", { class: "card__title" }, svgIcon(ICON_ROLES, { size: 16 }), changeKindLabel(change.kind)),
      changeStatusBadge(change.status),
    ),
  );

  // Who + when cues (the maker and the time), mirroring the restore approval cue row.
  const cues = h("div", { class: "approval-cues" });
  cue(cues, "Proposed by", change.proposedBy ?? "shared token (break-glass), no attributable email");
  cue(cues, "Proposed", relativeTime(change.proposedAt));
  card.appendChild(cues);

  // The plain-English diff the engine pre-rendered, line by line as text nodes (no markup).
  card.appendChild(renderDiff(change.diff));

  if (change.status === "pending") {
    card.appendChild(renderChangeActions(engine, change, me, reload));
  } else if (change.status === "applied") {
    card.appendChild(h("p", { class: "field__hint" }, change.approvedBy ? `Approved by ${change.approvedBy} and applied.` : "This change was approved and applied."));
  } else if (change.status === "rejected") {
    card.appendChild(h("p", { class: "field__hint" }, change.approvedBy ? `Rejected by ${change.approvedBy}. It was not applied.` : "This change was rejected. It was not applied."));
  } else if (change.status === "superseded") {
    card.appendChild(h("p", { class: "field__hint" }, "The configuration this change targeted moved on before a second owner approved it, so it was cleared without being applied. Propose it again if you still want it."));
  }
  return card;
}

// renderDiff renders the plain-English change description line by line, each tagged with its
// added/removed/changed cue (mirroring the config-history screen's renderDiffBlock over the structurally
// identical ConfigDiffLine). Each line's text is a TEXT NODE (never parsed as markup), so a diff that
// mentions a downpipe name / email / selector cannot inject anything. diff is the engine's
// PendingChangeLine[] (an array of { kind, area, text } objects, never a bare string); diffLines is the
// single normalising step so a malformed element degrades to being skipped rather than throwing.
function renderDiff(diff: PendingChangeLine[]): HTMLElement {
  const lines = diffLines(diff);
  const wrap = h("div", { class: "card card--inset", style: "margin-top:var(--space-3);display:grid;gap:var(--space-1)" });
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-bottom:var(--space-1)" }, "Proposed change"));
  if (lines.length === 0) {
    // An operator is being asked to APPROVE a change whose description the engine did not send. The screen
    // is honest about it; the pack carried nothing, so "we were asked to approve a change with no description"
    // could not be tied to the engine build that stopped sending one.
    recordContractSkew("empty-payload", "change-description");
    wrap.appendChild(h("p", { style: "color:var(--text)" }, "The engine did not provide a description for this change."));
    return wrap;
  }
  for (const line of lines) {
    const row = h("p", { class: "mono", style: "color:var(--text);white-space:pre-wrap;margin:0;display:flex;gap:var(--space-2);align-items:baseline" });
    row.appendChild(h("span", { class: "field__hint", style: "min-width:4.5em" }, diffKindLabel(line.kind)));
    row.appendChild(h("span", line.text));
    wrap.appendChild(row);
  }
  return wrap;
}

function renderChangeActions(engine: EngineClient, change: ConfigChange, me: string | null, reload: () => void): HTMLElement {
  const actions = h("div", { class: "approval-actions" });
  const mine = isMine(change, me);

  // Maker is not checker: a caller cannot approve their OWN proposal. Shown as the explicit awaiting-state
  // the brief calls for, NOT a dead disabled button. The proposer may still withdraw (reject) their own.
  // One hint line, not a banner: three own proposals must not stack three identical banners.
  if (mine) {
    actions.appendChild(
      h("p", { class: "field__hint" }, "You proposed this; awaiting a different approver (maker is not checker)."),
    );
    actions.appendChild(rejectButton(engine, change, reload, "Withdraw", "withdrawn"));
    return actions;
  }

  // Capability mirror (best-effort; the engine is authoritative): an approver must hold the change's own
  // WRITE capability. When the console knows the mapping and the caller lacks it, show Approve
  // disabled-with-reason rather than offering a button the engine would refuse. An unknown kind (newer
  // engine) maps to null, where the console cannot mirror the gate and shows Approve enabled, deferring
  // entirely to the engine.
  const approveCap = changeApproveCapability(change.kind);
  // An unknown change kind maps to null, the console cannot mirror the gate, and Approve renders ENABLED
  // and defers to the engine. That is the correct fail-open, and it produces the "Approve renders but always
  // fails" ticket: the operator presses a live-looking button and the engine refuses it every time. The console
  // knew it did not recognise the kind and said so to no one.
  if (approveCap === null) recordContractSkew("unknown-enum-member", "change-kind");
  const canApprove = approveCap === null ? true : canCap(approveCap);

  if (!canApprove && approveCap !== null) {
    actions.appendChild(h("p", { class: "field__hint" }, `Approving this change requires ${capabilityPhrase(approveCap)}. ${capGateReason(approveCap)}`));
    // Reject is gated on the same capability; without it, neither action is offered.
    return actions;
  }

  actions.appendChild(approveButton(engine, change, reload));
  actions.appendChild(rejectButton(engine, change, reload, "Reject", "rejected"));
  return actions;
}

function approveButton(engine: EngineClient, change: ConfigChange, reload: () => void): HTMLButtonElement {
  const btn = h("button", { "data-dp": "config-changes.button.approve-button", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_CHECK, { size: 14 }), "Approve") as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Approve change",
      body: `Approve "${changeKindLabel(change.kind)}"? You may be asked to confirm with your own passkey first. If you dismiss that prompt, or it fails, nothing is approved and you can start again. Once that check is done the change is applied, and recorded with both identities (the proposer and you).`,
      confirmLabel: "Approve",
      busyLabel: "Approving",
    });
    if (!ok) return;
    try {
      await engine.approveConfigChange(change.id);
      toast({ message: "Change approved and applied" });
      reload();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // The engine refuses a self-approval (maker == checker) or a missing capability; surface its reason.
      // Approve is STEP-UP gated (the engine gates the parsed "approve" action, router.ts:546), and a cancelled
      // ceremony is NOT an engine refusal: stepUpAwareText gives that state its own advice rather than printing
      // "approve config change: stepup-required: 401" at the operator.
      toast({ message: `Could not approve. ${stepUpAwareText(err)}`, tone: "warn" });
    }
  });
  return btn;
}

// past is the explicit past tense for the success toast ("withdrawn" / "rejected"); concatenating
// "ed" onto the label produced "withdrawed".
function rejectButton(engine: EngineClient, change: ConfigChange, reload: () => void, label: string, past: string): HTMLButtonElement {
  const btn = h("button", { "data-dp": "config-changes.button.reject-button", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_CLOSE, { size: 14 }), label) as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: `${label} change`,
      body: `${label} "${changeKindLabel(change.kind)}"? It will not be applied.`,
      confirmLabel: label,
      variant: "danger",
      busyLabel: `${label}ing`,
    });
    if (!ok) return;
    try {
      await engine.rejectConfigChange(change.id);
      toast({ message: `Change ${past}` });
      reload();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not ${label.toLowerCase()} (${errText(err)}).`, tone: "warn" });
    }
  });
  return btn;
}

// cue appends one label/value pair to a cue row (a definition-list-like inline pair), value as a text node.
function cue(host: HTMLElement, label: string, value: string): void {
  host.appendChild(
    h("div", { class: "approval-cue" },
      h("span", { class: "approval-cue__label field__hint" }, label),
      h("span", { class: "approval-cue__value" }, value),
    ),
  );
}

// changeStatusBadge maps a change status to a toned badge (pending = info, applied = ok, rejected =
// danger, superseded = neutral), mirroring the restore approval status badge. The keys are the engine's
// own status literals; an unrecognised status would otherwise index the map to undefined and throw.
function changeStatusBadge(status: ConfigChangeStatus): HTMLElement {
  const map: Record<ConfigChangeStatus, { tone: StatusTone; label: string }> = {
    pending: { tone: "info", label: "Awaiting approval" },
    applied: { tone: "ok", label: "Applied" },
    rejected: { tone: "danger", label: "Rejected" },
    superseded: { tone: "neutral", label: "Superseded" },
  };
  const m = map[status];
  return badge(m.tone, m.label);
}
