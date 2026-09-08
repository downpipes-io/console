// Restore, runs and actions (IA screens 3 + 4): the COORDINATOR for the restore flow. It
// owns the screen descriptor and its render() (the route dispatch, the page header and the
// workspace mount); the render flows live in the sibling modules under ./restore-flow/
// (shared, recency, run-context, proof, flow, plan, confirm, approvals, workspace). The
// module is self-owned: the integrator wires it (app.ts SCREENS + the palette) in place of
// the ported restoreScreen, so it is deliberately NOT wired here.
//
// The apply-gate rationale (the client mirror of the engine's dual-control + role gate, the
// maker != checker rule, the planHash re-arm, and the no-custody and fail-open invariants)
// lives in design/02-areas/actions-runs-restore/ (wireframe.html + flow.md Flow C, J3). The
// engine is the control (engine/src/admin/router.ts POST /restore); this screen only mirrors
// it for the UI, so an apply is never enabled on role alone.
//
// House rules: Australian English, no em dashes, precise claims (post-quantum hybrid /
// tamper-evident).

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_ROLES } from "../lib/icons.ts";
import { callerCan } from "../lib/identity-custom-roles.ts";
import { navigate } from "../lib/nav.ts";
import { canCap, defineScreen, pageHeader, requireEngine, type ScreenContext } from "./common.ts";
import { renderApprovalsInbox } from "./restore-flow/approvals.ts";
import { renderAttendRunner } from "./restore-flow/attend.ts";
import { renderBatchQueue } from "./restore-flow/batch.ts";
import { renderBreakGlassRestore } from "./restore-flow/break-glass.ts";
import { renderBreakGlassPrune } from "./restore-flow/break-glass-prune.ts";
import { renderPruneApprovalsInbox } from "./restore-flow/prune-approvals.ts";
import { renderRecoverKey } from "./restore-flow/recover-key.ts";
import { renderWorkspace } from "./restore-flow/workspace.ts";

// The two restore routes an outside caller needs the literal for (the guided tour's chapter
// vocabulary; chapters.ts): the landing route and the dual-control approvals inbox. Exported so that
// caller references the same strings this descriptor uses, rather than a copy. The other six patterns
// this screen owns have no outside caller today, so they stay inline below, in their load-bearing order.
export const ROUTE_RESTORE = "/restore";
export const ROUTE_RESTORE_APPROVALS = "/restore/approvals";
export const ROUTE_RESTORE_PRUNE_APPROVALS = "/restore/prune-approvals";

export const restoreFlowScreen = defineScreen({
  // The restore route family (information-architecture.md 7). This screen is the
  // elevated owner of these routes; the integrator binds it in place of the ported
  // restoreScreen. The run-detail launch points (/runs/:downpipeId/:index) stay owned
  // by the runs screen, which deep-links here with the run id prefilled. "/restore/batch"
  // MUST stay listed before "/restore/:runId" (the router is first-match-wins, lib/router.ts
  // resolve()): both would otherwise-match "/restore/batch" against the wildcard param route
  // first (runId="batch"), exactly the reason "/restore/approvals" already precedes it. "/restore/attend"
  // (the attended-verification runner) and "/restore/recover-key" (the in-browser split-key reassembly
  // screen) are both fixed routes that MUST likewise precede "/restore/:runId" so neither is swallowed as
  // runId="attend" / runId="recover-key".
  // "/restore/break-glass" (the in-console break-glass restore panel, G-P0-008) and its
  // "/restore/break-glass/:runId" deep-link are fixed/param routes that MUST likewise precede
  // "/restore/:runId" so neither is swallowed as runId="break-glass". "/restore/break-glass-prune" and its
  // "/restore/break-glass-prune/:downpipeId" deep-link (the break-glass-only no-CLI prune) are the
  // same shape and MUST precede "/restore/:runId" for the same reason. "/restore/prune-approvals" (the
  // dual-control inbox, the sibling of "/restore/approvals" above) is a fixed route and MUST likewise
  // precede "/restore/:runId" so it is never swallowed as runId="prune-approvals".
  route: [
    ROUTE_RESTORE,
    ROUTE_RESTORE_APPROVALS,
    ROUTE_RESTORE_PRUNE_APPROVALS,
    "/restore/attend",
    "/restore/recover-key",
    "/restore/break-glass",
    "/restore/break-glass/:runId",
    "/restore/break-glass-prune",
    "/restore/break-glass-prune/:downpipeId",
    "/restore/batch",
    "/restore/:runId",
  ],
  title: "Restore and recovery",
  measure: "wide",
  // The screen-owned commands the command palette / registry surfaces. Gated by the
  // caller's role (the MIRROR of the engine's per-route minimum; never the control).
  actions: [
    {
      id: "restore.open",
      title: "Restore from a run",
      group: "Actions",
      kind: "navigate",
      keywords: ["restore", "recover", "recovery", "roll back", "dry-run"],
      target: "/restore",
      shortcut: "g s",
      when: ({ engine }) => engine.connected !== false,
    },
    {
      id: "restore.approvals",
      title: "Review pending restore approvals",
      group: "Actions",
      kind: "navigate",
      keywords: ["approve", "approval", "dual control", "pending", "restore"],
      target: "/restore/approvals",
      // The inbox audience is anyone who can sign a plan (restore.approve, the engine's gate at
      // router-restore.ts POST /restore/approve and /restore/reject) or raise one and watch their own
      // (restore.request, POST /restore/request). Gated by CAPABILITY, not by a role-NAME list: this
      // entry point carried the same defect R-DIV-1 named in restore-flow/confirm.ts, one layer up.
      // The old list was operator/approver/owner, which excluded restore-operator, the recovery-only
      // role that holds BOTH restore.request and restore.approve (identity-model.ts ROLE_CAPABILITIES),
      // so the dual-control inbox was unreachable from the palette for the one role disaster recovery
      // exists for, while the same screen's header button (canCap("restore.request"), below) offered it.
      // A named custom role pins role="viewer" and carries its real authority in its capability set, so
      // callerCan resolves the effective set rather than flooring it. A null caller fails closed.
      when: ({ caller: c }) => c !== null && (callerCan(c.role, "restore.approve", c.customRole ?? null) || callerCan(c.role, "restore.request", c.customRole ?? null)),
    },
    {
      id: "restore.prune-approvals",
      title: "Review pending prune approvals",
      group: "Actions",
      kind: "navigate",
      keywords: ["prune", "retention", "approve", "approval", "dual control", "pending", "break-glass"],
      target: ROUTE_RESTORE_PRUNE_APPROVALS,
      // Gated identically to restore.approvals above (mirrors restore's request/approve capabilities
      // rather than inventing its own; router-retention-prune.ts gates request on restore.request and
      // approve/reject on restore.approve, so the same two capabilities decide who has anything to do here).
      when: ({ caller: c }) => c !== null && (callerCan(c.role, "restore.approve", c.customRole ?? null) || callerCan(c.role, "restore.request", c.customRole ?? null)),
    },
  ],
  render(ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    if (ctx.pattern === "/restore/approvals") {
      return renderApprovalsInbox(engine);
    }

    if (ctx.pattern === ROUTE_RESTORE_PRUNE_APPROVALS) {
      return renderPruneApprovalsInbox(engine);
    }

    if (ctx.pattern === "/restore/batch") {
      return renderBatchQueue(engine, ctx.query);
    }

    if (ctx.pattern === "/restore/attend") {
      // The attended-verification runner (the offline-key-only in-platform proof path). It renders under
      // the standard page header with a crumb back to the restore home, so it reads as a child of Restore.
      const attendHeader = pageHeader(
        "Attended verification",
        "Prove your backups restorable in the offline-key-only posture: supply your break-glass key in your browser and the engine verifies a sample of each run against the keys you recover. Nothing is written and no record is returned.",
        undefined,
        { label: "Restore", to: "/restore" },
      );
      const attendRoot = h("div");
      attendRoot.appendChild(attendHeader);
      attendRoot.appendChild(renderAttendRunner(engine));
      return attendRoot;
    }

    if (ctx.pattern === "/restore/recover-key") {
      // The in-browser Shamir M-of-N reassembly screen: reconstruct-and-download only (no engine call of
      // any kind; see restore-flow/recover-key.ts's own header). It renders under the standard page header
      // with a crumb back to the restore home, mirroring the /restore/attend branch above exactly.
      const recoverHeader = pageHeader(
        "Reassemble your split key",
        "Reconstruct identity.key from a quorum of your Shamir shares plus the small encrypted key file, entirely in this browser. Nothing is uploaded.",
        undefined,
        { label: "Restore", to: "/restore" },
      );
      const recoverRoot = h("div");
      recoverRoot.appendChild(recoverHeader);
      recoverRoot.appendChild(renderRecoverKey());
      return recoverRoot;
    }

    if (ctx.pattern === "/restore/break-glass" || ctx.pattern === "/restore/break-glass/:runId") {
      // The in-console break-glass restore panel (G-P0-008): supply your break-glass key in this browser,
      // recover a run's key locally, and preview its restore. Renders under the standard page header with a
      // crumb back to the restore home, mirroring the /restore/attend and /restore/recover-key branches.
      const bgRun = ctx.pattern === "/restore/break-glass/:runId" ? ctx.params.runId : undefined;
      const bgHeader = pageHeader(
        "Break-glass restore",
        "Restore in the offline-key-only posture: supply your break-glass key in this browser to recover a run's key locally and preview its restore. Your key never leaves this browser; only the one run's recovered key is sent to your engine to open it.",
        undefined,
        { label: "Restore", to: "/restore" },
      );
      const bgRoot = h("div");
      bgRoot.appendChild(bgHeader);
      const panel = renderBreakGlassRestore(engine, bgRun);
      bgRoot.appendChild(panel.el);
      // Best-effort wipe of the panel's break-glass private + recovered master on navigation away (bgRoot
      // leaves the DOM), the same MutationObserver-on-disconnect teardown the recover-key screen uses. The
      // everConnected guard means a DOM mutation before this screen mounts never fires a premature teardown.
      let everConnected = false;
      const observer = new MutationObserver(() => {
        if (bgRoot.isConnected) { everConnected = true; return; }
        if (everConnected) { panel.teardown(); observer.disconnect(); }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      return bgRoot;
    }

    if (ctx.pattern === "/restore/break-glass-prune" || ctx.pattern === "/restore/break-glass-prune/:downpipeId") {
      // The in-console break-glass retention-prune panel: supply your break-glass key in this
      // browser, recover the candidate runs' keys locally, preview the plan, then apply. Renders under the
      // standard page header with a crumb back to the restore home, mirroring the break-glass restore branch.
      const bgpDownpipe = ctx.pattern === "/restore/break-glass-prune/:downpipeId" ? ctx.params.downpipeId : undefined;
      const bgpHeader = pageHeader(
        "Prune with your key",
        "Run a downpipe's retention prune in the offline-key-only posture: supply your break-glass key in this browser to recover the candidate runs' keys locally, preview the plan, then apply. Your key never leaves this browser; only the recovered per-run keys are sent to your engine.",
        undefined,
        { label: "Restore", to: "/restore" },
      );
      const bgpRoot = h("div");
      bgpRoot.appendChild(bgpHeader);
      const bgpPanel = renderBreakGlassPrune(engine, bgpDownpipe);
      bgpRoot.appendChild(bgpPanel.el);
      // Best-effort wipe of the panel's break-glass private + recovered masters on navigation away, the
      // same MutationObserver-on-disconnect teardown the break-glass restore branch above uses.
      let bgpEverConnected = false;
      const bgpObserver = new MutationObserver(() => {
        if (bgpRoot.isConnected) { bgpEverConnected = true; return; }
        if (bgpEverConnected) { bgpPanel.teardown(); bgpObserver.disconnect(); }
      });
      bgpObserver.observe(document.documentElement, { childList: true, subtree: true });
      return bgpRoot;
    }

    const prefillRun = ctx.pattern === "/restore/:runId" ? ctx.params.runId : undefined;

    const header = pageHeader(
      prefillRun ? `Restore run ${prefillRun}` : "Restore and recovery",
      "Write archived records from a sealed run back into the live account; the dry-run review is read-only, and only the gated apply changes your data.",
      // The inbox entry point mirrors the palette gate above, and now genuinely does: BOTH read the
      // same two capabilities. A caller who can neither sign a plan (restore.approve) nor raise one
      // (restore.request) has nothing to do in the inbox, so the header button hides for them, and a
      // caller who holds either reaches the inbox by whichever entry point they find first. The old
      // request-only gate hid this button from a role that can approve but not request (reachable via
      // a named custom role), which is precisely who the inbox is for.
      canCap("restore.approve") || canCap("restore.request")
        ? h("button", { "data-dp": "restore-flow.button.navigate-restore-approvals#1", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/restore/approvals") } }, svgIcon(ICON_ROLES, { size: 14 }), "Pending approvals")
        : undefined,
      // A run-prefilled restore is a child page (commonly arrived at from a run row
      // or a downpipe), so it carries a referrer-aware crumb back to where the
      // operator came from, falling back to the restore home.
      prefillRun ? { label: "Restore", to: "/restore" } : undefined,
    );
    root.appendChild(header);

    // The two-column workspace: run context on the left (the run detail, plus the
    // collapsed timeline and proof surface), the restore flow on the right. Without a
    // prefilled run there is no run context yet, so the flow renders full width with a
    // run picker and the fleet restore-test recency card.
    root.appendChild(renderWorkspace(engine, prefillRun));
    return root;
  },
});
