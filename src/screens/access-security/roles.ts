// Roles and access sub-view of the Access and security area: the in-app RBAC table (D3
// grant/revoke), the last-Owner guard mirror (F3, enforced server-side), the dual-control
// posture read, the permission matrix and "what can I do", the custom-role entry point, and
// the optional group-to-role mapping panel. The table mirrors the engine; the engine is the
// boundary. Shared note/badge leaves come from ./shared.ts.
//
// This file is the panel orchestrator plus the static custom-role entry and the dual-control
// read. The cohesive groups (the members table and its grant/remove ceremony, the static
// model cards, and the optional group mapping panel) live in sibling modules:
// roles-members.ts, roles-matrix.ts and roles-groups.ts (split out for console-src-025-02 /
// console-src-025-M1; the shared leaf helpers are in roles-helpers.ts).

import { featureOutcomeForError, recordFeatureProbe } from "../../lib/client-diag/ring.ts";
import type { ClientDiagFeatureClass } from "../../lib/client-diag/vocab.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import {
  canCap,
  capGateReason,
  pendingEngineNote,
  lazyDisclosure,
  collapsedSection,
  refuseWithReason,
} from "../common.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { statusWithLabel, type StatusTone } from "../../components/status.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { ICON_EXTERNAL, ICON_INFO, ICON_PLUS } from "../../lib/icons.ts";
import type { EngineClient, CustomRole } from "../../api.ts";
import { noteLine, errText } from "./shared.ts";
import { renderRolesTable } from "./roles-members.ts";
import { permissionMatrix, myPermissions } from "./roles-matrix.ts";
import { groupRoleMappingPanel } from "./roles-groups.ts";
import { renderSignInFactorsPanel } from "./signin-factors.ts";

export function renderRolesPanel(engine: EngineClient): HTMLElement {
  // A11Y-05: the roles tabpanel gets a section-level h2 below the screen h1, so the
  // heading hierarchy does not jump from h1 to the h3 cards inside. A short lead states
  // the model before the honesty panel and the table.
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-5)", "aria-labelledby": "roles-h" });
  // The honesty facts live in this one lead hint (the old standing prose card restated them in
  // a box): the engine is the boundary, the table is the mirror, and the bootstrap-Owner rule.
  wrap.appendChild(
    h(
      "div",
      { style: "display:grid;gap:var(--space-1)" },
      h("h2", { id: "roles-h", style: "font-size:var(--text-lg)" }, "Roles and access"),
      h("p", { class: "field__hint measure" }, "Who can do what, keyed by verified email, however the person signs in (Cloudflare Access, a native identity provider, a passkey, or the shared-token fallback). Roles are cumulative and least-privilege by default; the engine enforces them per route (this table is the mirror, never the boundary). The first operator to configure this engine is the bootstrap Owner."),
    ),
  );

  const region = h("div", { class: "async-region" });
  wrap.appendChild(region);

  const load = (): void => {
    region.replaceChildren(skeletonRows(4));
    void Promise.all([
      engine.listRoles(),
      // Rule b: the members table raises the Owner floor to two while dual control is armed, so it needs the
      // live gate state. Read best-effort so a policy-read failure (an older engine, a 404) never degrades the
      // table; it falls back to the one-Owner floor and the engine still enforces the real floor server-side.
      engine.getConfigApprovalPolicy().then((p) => p.requireConfigApproval).catch(() => false),
      // The custom-role catalogue, read the same best-effort way, so its absence never degrades the members
      // table. It decides two things there: whether a custom-role grant names a role that still exists (the
      // badge, which needs only the names) and which custom roles the grant picker can offer (which needs the
      // whole record: the label, and the capability set the no-escalation mirror checks against).
      engine.listCustomRoles().catch((): CustomRole[] => []),
    ])
      .then(([rows, dualControlOn, customRoles]) => region.replaceChildren(renderRolesTable(engine, rows, load, { dualControlOn, customRoles })))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the members table is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        // The pending-vs-broken conflation, now resolved. This tile used to say the feature is not
        // built yet whether the engine answered a 404 (in which case it is TRUE) or a 500 (in which case the
        // engine is broken and the customer has been told a comforting falsehood, often for weeks). recordFeature
        // classes it for the pack; the RENDER now tells them apart too: a genuine 404/501 keeps the D3-pending
        // note, a real fault (500/network) reads as the honest block error with Retry.
        recordFeature("roles-table", err);
        const cls = classifyError(err);
        const notWired = cls.kind === "server" && (cls.status === 404 || cls.status === 501);
        if (!notWired) {
          region.replaceChildren(blockError(err, load, { origin: location.origin }));
          return;
        }
        // D3 pending: present the role model the engine implements, never a fake grid.
        region.replaceChildren(
          pendingEngineNote({
            what: "The members table could not load. The role model below is what the engine enforces once role storage is live: Viewer, Operator, Approver, Owner, cumulative, keyed by verified email (however the person signed in), with a guard that always retains at least one Owner.",
            dependsOn: "D3 server-side role storage and enforcement (GET and POST /admin/roles)",
            interim: `The engine returned: ${errText(err)}. The Enterprise badge is not claimed until D3 is live.`,
          }),
        );
      });
  };
  load();

  // The permission matrix + "what can I do", shown regardless of the table state (they
  // describe the model, not live data).
  // auto-fit + minmax collapses the two cards to one column on narrow viewports (reflow
  // to 320px, WCAG 2.2 1.4.10) without a media query, keeping the screen self-contained.
  wrap.appendChild(h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:var(--space-5)", class: "roles-grid" }, permissionMatrix(), myPermissions()));

  // Demoted sections (the members table and the matrix pair are the eager
  // read; everything else collapses). The custom-role entry is static, so collapsedSection keeps
  // it find-in-page-able; the dual-control read and the group mapping fetch, so lazyDisclosure
  // defers each fetch until asked for.
  // Sign-in factors sits FIRST among the demoted sections, and directly under the roster it does not
  // duplicate. The roster answers "who has a role"; this answers "who can still authenticate", and the gap
  // between the two is the whole reason it exists (an email whose role row was deleted keeps its passkey
  // credentials, its recovery codes and any unexpired invite). It fetches, so lazyDisclosure defers the read
  // until an operator asks for it.
  wrap.appendChild(lazyDisclosure("Sign-in factors (who can still sign in)", () => renderSignInFactorsPanel(engine)));
  wrap.appendChild(collapsedSection("Custom roles", customRoleBuilderEntry()));
  wrap.appendChild(lazyDisclosure("Dual-control posture", () => dualControlCard(engine)));
  wrap.appendChild(lazyDisclosure("Group to role mapping (optional)", () => groupRoleMappingPanel(engine)));

  return wrap;
}

// customRoleBuilderEntry is the access.policy-gated entry point to the custom role builder. The card is
// shown to every authenticated role so the capability model is discoverable, but the action button is
// enabled only for a caller who holds access.policy (Owner / access-admin); others see the honest gate.
// The engine re-enforces the capability on every custom-role write.
function customRoleBuilderEntry(): HTMLElement {
  const canBuild = canCap("access.policy");
  // The wrapping disclosure's summary carries the "Custom roles" heading; no inner header.
  const card = h("section", { class: "card" });

  card.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin-bottom:var(--space-3)" },
      "The six built-in roles cover most teams. When you need a narrower, named bundle (for example a recovery-only operator restricted to one source, or a read-only compliance seat), compose a custom role: pick the capabilities, decide what each screen shows, choose the presentation and the landing screen, and preview exactly what the holder will see. A custom role can only hold capabilities you yourself hold, can never hold the owner-reserved capabilities, and is enforced by the engine like any built-in.",
    ),
  );

  const builderBtn = h(
    "button",
    { "data-dp": "access-security.button.builder",
      class: "btn btn--primary btn--sm",
      type: "button",
    },
    svgIcon(ICON_PLUS, { size: 14 }),
    "Open the custom role builder",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  );
  if (canBuild) builderBtn.addEventListener("click", () => navigate("/access/roles/builder"));
  else refuseWithReason(builderBtn, capGateReason("access.policy"));
  card.appendChild(h("div", builderBtn));

  if (!canBuild) {
    card.appendChild(
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, `Composing custom roles needs ${capabilityPhrase("access.policy")} (Owner or Access admin). You can still read the role catalogue here.`),
    );
  }
  return card;
}

// dualControlCard reads the live dual-control posture: the maker/approver split the engine
// enforces on restore-apply, plus the counts of BOTH dual-control queues (restores awaiting a
// second sign-off, D2, and config changes awaiting a second approver). It is the governance
// read, not the inboxes themselves (linked below). It degrades honestly: a 404/501 from a
// build without D2 shows the pending-engine note rather than faking a zero, and the config
// count is simply omitted on a build without the change gate. No-custody: the records carry
// names, counts and a reason only, never a key or a value.
// Exported for the validator (RG17): this card is the governance read for the mechanic that gates a
// restore writing to live data, and its four degradation branches are worth driving directly.
export function dualControlCard(engine: EngineClient): HTMLElement {
  // The wrapping disclosure's summary carries the "Dual-control posture" heading; no inner header.
  const card = h("section", { class: "card" });

  card.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin-bottom:var(--space-3)" },
      "A restore that writes to live data requires a second authorised identity to approve, bound to the exact plan hash, with the maker barred from being the checker. When the config approval requirement is on, config changes queue for a second approver the same way. The engine enforces both server-side; the approver is recorded on the audit entry.",
    ),
  );

  const region = h("div", { class: "async-region" });
  card.appendChild(region);

  const loadDualControl = (): void => {
  region.replaceChildren(skeletonRows(1));

  void Promise.all([
    engine.listApprovals(),
    // The config-change queue is the OTHER half of dual control; counted best-effort (a build
    // without the gate 404s) so its absence never degrades the restore-approvals read.
    // This catch maps EVERY failure of the config-approvals read to "the feature is absent" (null), so a
    // broken engine and an engine that never built the route are one and the same to every reader downstream. The
    // fail-open is kept (it must never degrade the restore-approvals read beside it); what changes is that the
    // verdict is now recorded, so the pack can say which it actually was.
    engine.listConfigChanges().then((cs) => cs.filter((c) => c.status === "pending").length).catch((err) => { recordFeature("config-approvals", err); return null; }),
  ])
    .then(([approvals, configPending]) => {
      const pending = approvals.filter((a) => a.status === "requested").length;
      region.replaceChildren(buildPostureGrid(pending, configPending));
    })
    .catch((err) => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the posture grid is a skeleton until this replaces it.
        region.replaceChildren(sessionEnded(loadDualControl));
        return goSignedOut();
      }
      recordFeature("restore-approvals", err); // pending-vs-broken, as the members table above.
      const cls = classifyError(err);
      const notWired = cls.kind === "server" && (cls.status === 404 || cls.status === 501);
      if (!notWired) {
        region.replaceChildren(blockError(err, loadDualControl, { origin: location.origin }));
        return;
      }
      region.replaceChildren(
        pendingEngineNote({
          what: "The pending-approval count could not load. Dual-control is the model the engine enforces once restore approvals are live: applying a restore needs a separate approver bound to the plan hash, maker not the checker.",
          dependsOn: "D2 restore approvals (GET /admin/restore/approvals)",
          interim: `The engine returned: ${errText(err)}. The maker/checker split is design-complete; the live count appears once the engine backs it.`,
        }),
      );
    });
  };
  loadDualControl();

  card.appendChild(buildDualControlLinks(canCap("restore.request")));

  card.appendChild(
    noteLine(
      ICON_INFO,
      "Approving and applying are separate, authorised steps; both are recorded. The approval binds to the plan hash, so a changed request needs a fresh approval. Dual-control protects live data; it is not a substitute for the offline break-glass recovery path.",
    ),
  );
  return card;
}

// buildPostureGrid renders the three dual-control posture tiles (restores awaiting approval, the
// optional config-change queue, and the server-enforced maker-not-checker rule) once the counts
// have loaded. configPending is null on a build without the config change gate, which omits that tile.
function buildPostureGrid(pending: number, configPending: number | null): HTMLElement {
  const grid = h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--space-4)" });
  grid.appendChild(
    postureStat(
      "Restores awaiting approval",
      String(pending),
      pending > 0 ? { tone: "warn", label: "needs a checker" } : { tone: "ok", label: "clear" },
      pending > 0 ? "Restores requested and waiting for a second authorised sign-off." : "No restore is currently waiting for a second sign-off.",
    ),
  );
  if (configPending !== null) {
    grid.appendChild(
      postureStat(
        "Config changes awaiting approval",
        String(configPending),
        configPending > 0 ? { tone: "warn", label: "needs a checker" } : { tone: "ok", label: "clear" },
        configPending > 0 ? "Config changes queued for a second authorised approver." : "No config change is currently waiting for a second approver.",
      ),
    );
  }
  grid.appendChild(
    postureStat(
      "Maker is not the checker",
      "Enforced",
      { tone: "trust", label: "server-side" },
      "The engine refuses a self-approval; the approver must differ from the requester.",
    ),
  );
  return grid;
}

// buildDualControlLinks renders the cross-links out to the two dual-control inboxes (restore
// approvals and config change requests), plus a start-a-restore shortcut when the caller can act
// as an operator (opGate).
function buildDualControlLinks(opGate: boolean): HTMLElement {
  const linkRow = h("div", { style: "margin-top:var(--space-4);display:flex;gap:var(--space-2);flex-wrap:wrap" });
  linkRow.appendChild(
    h(
      "button",
      { "data-dp": "access-security.button.navigate-restore-approvals", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/restore/approvals") } },
      "Open approvals inbox",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  linkRow.appendChild(
    h(
      "button",
      { "data-dp": "access-security.button.navigate-config-changes", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/config/changes") } },
      "Open config approvals",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  if (opGate) {
    linkRow.appendChild(
      h(
        "button",
        { "data-dp": "access-security.button.navigate-restore", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/restore") } },
        "Start a restore (raises a request)",
      ),
    );
  }
  return linkRow;
}

// postureStat is a compact labelled posture metric (label, value, a hue+shape+text status,
// and a muted detail) for the dual-control read. It mirrors the stat-tile vocabulary
// without the full tile chrome, since these sit inside an existing card.
function postureStat(label: string, value: string, status: { tone: StatusTone; label: string }, detail: string): HTMLElement {
  return h(
    "div",
    { style: "display:grid;gap:var(--space-1)" },
    h("span", { class: "section-label" }, label),
    h(
      "span",
      { style: "display:flex;gap:var(--space-2);align-items:baseline;flex-wrap:wrap" },
      h("span", { class: "tnum", style: "font-size:var(--text-lg);font-weight:var(--weight-semibold)" }, value),
      statusWithLabel(status.tone, status.label),
    ),
    h("span", { class: "field__hint" }, detail),
  );
}

// recordFeature is the feature-skew emit helper: it classifies a thrown engine read into the console's own verdict and
// records it, or records NOTHING when the verdict is null. Null is the 401 case, and it is deliberate: a lapsed
// session is the ordinary state of a console left open overnight, and a fault row for every one of them would
// bury the real faults in noise. A signal that cries wolf devalues every true one.
function recordFeature(featureClass: ClientDiagFeatureClass, err: unknown): void {
  const outcome = featureOutcomeForError(err);
  if (outcome !== null) recordFeatureProbe(featureClass, outcome);
}
