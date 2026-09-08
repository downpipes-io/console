// The right-hand half of the custom role builder: the live "what this role will see" preview (the verdict
// banner from the same pure validateCustomRole the engine runs, the per-screen visibility list, the granted
// capabilities and the composed payload), the Save action (with the overwrite-confirm danger path), the
// existing-catalogue list with its delete control, and the honest access.policy gate card. Moved verbatim from
// the roles-builder coordinator for size; it imports the shared leaf (./shared.ts) only, so it never imports the
// form section (which would form a cycle).
//
// House style: Australian English, no em dashes, precise claims; the engine is the enforcement point.

import { h, svgIcon } from "../../lib/dom.ts";
import { recordRoleDeleteImpact } from "../../lib/client-diag/ring.ts";
import { isPendingResult } from "../../lib/api/types/config-changes.ts";
import { capGateReason } from "../common.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { navigate } from "../../lib/nav.ts";
import { isUnauthorised, isStepUpRequired } from "../../lib/errors.ts";
import { stepUpAwareText } from "../../components/error-view.ts";
import { codeBlock } from "../../components/code-block.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { clearDraft } from "../../lib/draft.ts";
import { emptyState, banner } from "../../components/feedback.ts";
import { confirmModal } from "../../components/modal.ts";
import {
  ALL_CAPABILITIES,
  type Capability,
  type SurfaceMode,
  type CustomRole,
} from "../../lib/identity.ts";
import { ICON_PLUS, ICON_TRASH, ICON_SHIELD_CHECK, ICON_EYE, ICON_LOCK, ICON_CHECK } from "../../lib/icons.ts";
import type { EngineClient } from "../../api.ts";
import {
  SURFACE_SCREENS,
  ROLE_DRAFT,
  screenLabel,
  composeProposal,
  previewRole,
  errText,
  type BuilderState,
} from "./shared.ts";

// accessGateCard is the honest access.policy gate for a caller who is neither Owner nor access-admin.
// It states the required capability plainly and does not pretend the builder is unavailable for any
// other reason.
export function accessGateCard(): HTMLElement {
  const card = h("div", { class: "card card--inset measure", style: "margin-top:var(--space-5)" });
  card.appendChild(h("p", { style: "color:var(--text)" }, `The custom role builder defines who may hold which authority, so it is restricted to callers with ${capabilityPhrase("access.policy")}.`));
  card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, capGateReason("access.policy")));
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      "An Owner or an Access admin can compose custom roles. You can still read the role catalogue on the Roles and access tab.",
    ),
  );
  const back = h("button", { "data-dp": "roles-builder.button.back", class: "btn btn--secondary btn--sm", type: "button" }, "Back to Roles and access") as HTMLButtonElement;
  back.addEventListener("click", () => navigate("/access/roles"));
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, back));
  return card;
}

// ---- the live preview -----------------------------------------------------

export function renderPreview(state: BuilderState, creatorCaps: ReadonlySet<Capability>): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-4)" });
  const verdict = previewRole(state, creatorCaps);

  // The verdict banner: a green "this role is valid" or a precise reason the engine would reject.
  if (verdict.ok) {
    wrap.appendChild(
      h(
        "div",
        { class: "verdict", role: "status", style: "display:flex;gap:var(--space-2);align-items:center;color:var(--ok-fg)" },
        svgIcon(ICON_CHECK, { size: 18 }),
        h("b", "This role is valid and will be accepted."),
      ),
    );
  } else {
    wrap.appendChild(
      banner({ tone: "warn", message: h("span", h("b", "Not yet valid: "), verdict.reason) }),
    );
  }

  // The presentation + landing summary.
  const summary = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center" });
  summary.appendChild(badge(state.presentation === "shiny" ? "trust" : "info", `${state.presentation} skin`));
  summary.appendChild(badge("default", `lands on ${screenLabel(state.landing)}`));
  summary.appendChild(badge("default", `${state.capabilities.size} capabilities`));
  wrap.appendChild(summary);

  // The per-screen visibility preview: what a holder would see, screen by screen.
  const visHead = h("h3", { class: "section-label", style: "margin:0" }, "Screens this role sees");
  wrap.appendChild(visHead);
  const visList = h("ul", { style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-1)" });
  for (const screen of SURFACE_SCREENS) {
    const mode = state.surface.get(screen.id) ?? "read";
    const li = h("li", { style: "display:flex;gap:var(--space-2);align-items:center;justify-content:space-between" });
    const left = h("span", { style: "display:flex;gap:var(--space-2);align-items:center" });
    left.appendChild(modeIcon(mode));
    left.appendChild(h("span", screen.label));
    if (state.landing === screen.id && mode !== "hidden") left.appendChild(badge("info", "landing"));
    li.appendChild(left);
    li.appendChild(modeBadge(mode));
    visList.appendChild(li);
  }
  wrap.appendChild(visList);

  // The capability summary: the granted capabilities as chips (escaped via text nodes).
  const capHead = h("h3", { class: "section-label", style: "margin:var(--space-2) 0 0" }, "Capabilities granted");
  wrap.appendChild(capHead);
  if (state.capabilities.size === 0) {
    wrap.appendChild(h("p", { class: "field__hint" }, "No capabilities selected yet. A custom role must grant at least one."));
  } else {
    const chips = h("div", { style: "display:flex;gap:var(--space-1);flex-wrap:wrap" });
    for (const cap of ALL_CAPABILITIES.filter((c) => state.capabilities.has(c))) {
      chips.appendChild(h("span", { class: "mono", style: "font-size:var(--text-sm);padding:2px 8px;border:1px solid var(--border);border-radius:var(--radius-sm)" }, cap));
    }
    wrap.appendChild(chips);
  }

  // The composed payload (the exact JSON the engine receives), shown as a copyable code block via
  // textContent so it renders literally. Only shown when valid, so an operator copies a good payload.
  if (verdict.ok) {
    wrap.appendChild(h("h3", { class: "section-label", style: "margin:var(--space-2) 0 0" }, "Payload (POST /admin/custom-roles)"));
    wrap.appendChild(codeBlock(JSON.stringify(composeProposal(state), null, 2), { copyLabel: "Copy payload" }));
  }

  return wrap;
}

function modeIcon(mode: SurfaceMode): HTMLElement {
  if (mode === "hidden") return h("span", { style: "color:var(--text-muted);flex:none", "aria-hidden": "true" }, svgIcon(ICON_LOCK, { size: 14 }));
  if (mode === "edit") return h("span", { style: "color:var(--trust);flex:none", "aria-hidden": "true" }, svgIcon(ICON_SHIELD_CHECK, { size: 14 }));
  return h("span", { style: "color:var(--text-muted);flex:none", "aria-hidden": "true" }, svgIcon(ICON_EYE, { size: 14 }));
}

function modeBadge(mode: SurfaceMode): HTMLElement {
  if (mode === "hidden") return badge("default", "hidden");
  if (mode === "edit") return badge("trust", "editable");
  return badge("info", "read-only");
}

// ---- the Save action ------------------------------------------------------

export function saveRow(
  engine: EngineClient,
  state: BuilderState,
  creatorCaps: ReadonlySet<Capability>,
  existingNames: Set<string>,
  reload: () => void,
): HTMLElement {
  const row = h("div", { style: "display:flex;gap:var(--space-2);justify-content:flex-end;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:var(--space-4)" });
  const saveBtn = h("button", { "data-dp": "roles-builder.button.save", class: "btn btn--primary", type: "button" }, svgIcon(ICON_PLUS, { size: 16 }), "Save custom role") as HTMLButtonElement;
  saveBtn.addEventListener("click", () => {
    const verdict = previewRole(state, creatorCaps);
    if (!verdict.ok) {
      toast({ message: `Cannot save: ${verdict.reason}`, tone: "warn" });
      return;
    }
    const proposal = composeProposal(state);
    const doSave = async (): Promise<void> => {
      // Disable before the await so a double-click cannot submit the create twice (every sibling save
      // disables before its await, e.g. the downpipe editor's submit). Set here rather than in the click
      // handler so it covers both the fresh-create direct call and the overwrite-confirmed call, and never
      // disables the button while the overwrite confirm is still open. reload() re-renders on success, so the
      // button is only re-enabled on the error path.
      saveBtn.disabled = true;
      try {
        const res = await engine.createCustomRole(proposal);
        // The change-control gate may have queued this save for a second approver (202 -> pending): say so
        // with a link to the inbox, NOT a false "saved". The catalogue reloads either way.
        if (res.status === "pending") surfacePendingChange("custom role");
        else toast({ message: `Saved custom role "${res.value.label}".`, tone: "success" });
        clearDraft(ROLE_DRAFT);
        reload();
      } catch (err) {
        saveBtn.disabled = false;
        if (isUnauthorised(err)) return navigate("/signed-out");
        // The engine's 400 { error } carries the precise rejection reason; surface it inline. stepUpAwareText
        // keeps that reason and splits out the one state where "the engine rejected the role" is untrue: a
        // cancelled step-up, where the engine never judged the role at all and the draft is still valid.
        toast({ message: isStepUpRequired(err) ? `The role was not saved. ${stepUpAwareText(err)}` : `The engine rejected the role: ${errText(err)}`, tone: "warn" });
      }
    };
    // A fresh create saves directly: the live preview verdict already gates the button, the act
    // is reversible (Delete sits in the catalogue below), and the confirm only restated the
    // preview. Only the overwrite path carries the danger confirm.
    const overwrite = existingNames.has(state.name);
    if (!overwrite) {
      void doSave();
      return;
    }
    void confirmModal({
      title: "Overwrite custom role",
      body: `A custom role named "${state.name}" already exists. Saving will overwrite it with the composed capabilities and surface. Holders keep the role name but get the new authority on their next request. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is saved and your draft is still here.`,
      confirmLabel: "Overwrite role",
      variant: "danger",
    }).then((confirmed) => {
      if (confirmed) void doSave();
    });
  });
  row.appendChild(h("span", { class: "field__hint", style: "margin-right:auto" }, "Saving records a redaction-safe custom-role-change in the audit log."));
  row.appendChild(saveBtn);
  return row;
}

// ---- the existing-catalogue list ------------------------------------------

export function catalogueCard(engine: EngineClient, roles: CustomRole[], reload: () => void): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "builder-catalogue-h" });
  const head = h("div", { class: "card__header" });
  head.appendChild(h("h2", { id: "builder-catalogue-h", class: "card__title", style: "font-size:var(--text-lg)" }, "Existing custom roles"));
  head.appendChild(badge("default", String(roles.length)));
  card.appendChild(head);

  if (roles.length === 0) {
    card.appendChild(
      emptyState({
        title: "No custom roles yet",
        body: "Compose one above. Custom roles sit alongside the six built-ins and are reached only by an explicit grant or a group mapping that names them.",
      }),
    );
    return card;
  }

  const list = h("ul", { style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2)" });
  for (const role of roles) {
    list.appendChild(catalogueRow(engine, role, reload));
  }
  card.appendChild(list);
  return card;
}

// countGrantsReferencing counts the member and group grants that still name this custom role. Both
// tables confer the role, and a group grant can carry a whole team, so counting only the member table would
// under-report the blast radius of the delete. Returns null when either read failed: a count that is WRONG is
// worse evidence than no count, and a delete must never be blocked by a diagnostic.
async function countGrantsReferencing(engine: EngineClient, name: string): Promise<number | null> {
  try {
    const [members, groups] = await Promise.all([engine.listRoles(), engine.listGroupRoles()]);
    const m = Array.isArray(members) ? members.filter((r) => r.customRole === name).length : 0;
    const g = Array.isArray(groups) ? groups.filter((r) => r.customRole === name).length : 0;
    return m + g;
  } catch {
    return null;
  }
}

function catalogueRow(engine: EngineClient, role: CustomRole, reload: () => void): HTMLElement {
  const li = h("li", { class: "card card--inset", style: "display:grid;grid-template-columns:1fr auto;gap:var(--space-3);align-items:center;padding:var(--space-3)" });
  const meta = h("div");
  const titleRow = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  titleRow.appendChild(h("b", role.label));
  titleRow.appendChild(h("span", { class: "mono", style: "color:var(--text-muted)" }, role.name));
  titleRow.appendChild(badge(role.presentation === "shiny" ? "trust" : "info", role.presentation));
  meta.appendChild(titleRow);
  meta.appendChild(
    h(
      "small",
      { style: "color:var(--text-muted);display:block;margin-top:var(--space-1)" },
      `${role.capabilities.length} capabilities; lands on ${screenLabel(role.landing)}${role.createdBy ? `; created by ${role.createdBy}` : ""}`,
    ),
  );
  li.appendChild(meta);

  const del = h("button", { "data-dp": "roles-builder.button.del", class: "btn btn--ghost btn--sm", type: "button" }, svgIcon(ICON_TRASH, { size: 14 }), "Delete") as HTMLButtonElement;
  del.setAttribute("aria-label", `Delete the custom role ${role.label}`);
  del.addEventListener("click", () => {
    void confirmModal({
      title: "Delete custom role",
      body: `Delete the custom role "${role.label}"? Any member or group still assigned to it drops to the least-privilege viewer floor on their next request (the engine never fails open). This does not delete the members; it removes the role. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is deleted and you can start again from this row.`,
      confirmLabel: "Delete role",
      variant: "danger",
    }).then(async (confirmed) => {
      if (!confirmed) return;
      // Count the grants that STILL reference this role, BEFORE it goes. Every one of them silently drops
      // to the viewer floor server-side on its holder's next request, and the pack has never carried the
      // consequence: the custom-role-change delete event rides, and "Bob lost access to restores after we tidied
      // up old roles" cannot be linked to it. The count is taken here because after the delete the linkage is
      // gone: the role is not in the catalogue and the grants read as ordinary viewers.
      //
      // The read is best-effort and must never block the delete the operator asked for: a failed count records
      // nothing rather than refusing the operation, and the delete proceeds either way.
      const affected = await countGrantsReferencing(engine, role.name);
      try {
        const res = await engine.deleteCustomRole(role.name);
        // WHETHER IT ACTUALLY HAPPENED. custom-role-delete is change-control gated: with the gate armed the
        // engine answers 202 { queued: true, id, status, contentHash } and writes nothing, so the role still
        // exists and NOBODY is floored. Recording the count without the fate asserted a four-person downgrade
        // for a proposal an approver may reject, and sent a support engineer chasing an access loss that had
        // another cause.
        //
        // This is also the site that proves the guard fix. The fate is decided by isPendingResult, and until
        // the guard was taught the engine's REAL 202 body it was false for every 202 the engine has ever sent:
        // a queued delete recorded `applied` and COALESCED into the applied row, summing its count into it.
        // `queued-for-approval` had no producer in any build. Both states are now their own row.
        //
        // Counts ONLY, either way. The affected members' emails and subjects are what the redaction note
        // forbids, and there is no field on the record for one. The ZERO case is recorded too: a tidy-up that
        // broke nobody and one that downgraded four people must not both be an absence in the pack.
        if (affected !== null) recordRoleDeleteImpact(affected, isPendingResult(res) ? "queued-for-approval" : "applied");
        if (isPendingResult(res)) {
          // The queued delete used to toast "Deleted custom role" and reload a catalogue that still held the
          // role. The operator was told a lie about their own account, on the screen that told it. Same helper
          // and same copy as the queued SAVE a few lines up, so the two cannot drift.
          surfacePendingChange("custom role deletion");
        } else {
          toast({ message: `Deleted custom role "${role.label}".`, tone: "success" });
        }
        reload();
      } catch (err) {
        if (isUnauthorised(err)) return navigate("/signed-out");
        toast({ message: `Could not delete the role. ${stepUpAwareText(err)}`, tone: "warn" });
      }
    });
  });
  li.appendChild(del);
  return li;
}
