// The safe-apply update section: the read-only "what's in this update" release-metadata block, and the
// owner-gated interactive control (preview / update now / the opt-in gradual ramp, or the finish-a-pending
// verification affordance). It is the ONE boxed interactive object in the otherwise read-only Updates
// section. Every engine-supplied string is set as text (h() is textContent-first), so a channel line can
// never inject markup; the channel itself is signature-verified by the engine before any of it is surfaced.
// The one-shot deploy token is read from the paste field into a LOCAL const at click time and passed to
// applyUpdate then (on a promote) immediately to settleUpdate, the SAME value, held only in the call
// stack / closure; it is never persisted, copied to an attribute, or echoed by the engine. The metadata block
// and the two body builders live in sibling modules (split for size); copy, markup
// and token custody are unchanged. House rules: Australian English, no em dashes, precise claims, no AI
// attribution.

import { h } from "../../lib/dom.ts";
import { canCap, capGateReason } from "../common.ts";
import { caller } from "../../lib/nav.ts";
import { badge } from "../../components/status.ts";
import { consoleVersion } from "../../lib/console-version.ts";
import {
  UPDATE_MANAGE_CAP,
  UPDATE_CARD_HEADING_ID,
  componentRows,
  updateExplainerText,
  type UpdateControlState,
} from "./shared.ts";
import { availableUpdateBody } from "./update-available-body.ts";
import { pendingUpdateBody } from "./update-pending-body.ts";
import type { EngineClient, UpdateStatus } from "../../api.ts";

// renderReleaseMetadata is the read-only "what's in this update" block; re-exported here so importers of this
// module keep their existing import (the implementation lives in update-release-metadata.ts after the split).
export { renderReleaseMetadata } from "./update-release-metadata.ts";

// ---------------------------------------------------------------------------
// Safe-apply update, the interactive control (CSP-safe via h(); no .cssText)
// ---------------------------------------------------------------------------

// updateControl is the owner-gated safe-apply control: an honest explainer, then either the
// preview/update-now actions (an available update) or the verify-now/roll-back affordance (a promoted-but-
// not-settled update). It is the ONE boxed interactive object in the Updates section (§7a: boxes are for
// interactive objects); the read-only Updates facts above stay unboxed. Calm density holds: no ambient
// effects, no notice-stacking, a single inline error/progress region, and the engine's reason is shown
// verbatim there (never a tinted banner per line).
//
// TOKEN CUSTODY (the brick-safe contract): the one-shot deploy token is read from the paste field into a
// LOCAL `const` at click time and passed to applyUpdate then, if the apply promoted, IMMEDIATELY to
// settleUpdate, the SAME value, held only in this function's call stack / closure. It is NEVER written to
// storage, a data-* attribute, a module variable, or anywhere it could outlive the request pair; when the
// handler returns it is unreachable and collected. The engine likewise never stores or echoes it.
//
// destConfigured (design/updates/UPDATE-UX-015-DESIGN.md s4) is the caller's already-loaded
// StatusReport.destConfigured fact, threaded down to the available-update body so it can replace the apply
// control with the destination-gate line when false. Defaults true (every existing caller keeps offering the
// apply control, unchanged) so this is additive.
export function updateControl(engine: EngineClient, updates: UpdateStatus, state: UpdateControlState, reload: () => void, destConfigured = true): HTMLElement {
  const canManage = canCap(UPDATE_MANAGE_CAP);
  // Component awareness (multi-component updates): true ONLY when the engine advertised a components map
  // (componentRows is [] otherwise), so an old engine gets EXACTLY the single-engine heading and explainer.
  const componentAware = componentRows(updates, consoleVersion()).length > 0;

  // The boxed interactive object. A heading + the honest explainer, then a single progress/error region the
  // handlers drive (so progress and the engine's reason share one calm channel, never a stack of banners).
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-4)" });
  card.appendChild(
    h(
      "div",
      { class: "card__header" },
      h("h3", { class: "card__title", id: UPDATE_CARD_HEADING_ID, tabindex: "-1" }, componentAware ? "Apply update" : "Apply engine update"),
      state.kind === "pending" ? badge("warn", "Verification pending", { dot: true }) : badge("info", "Update available", { dot: true }),
    ),
  );

  // The honest explainer, stated once: brick-safe (verify-before-deploy), canary-gated with auto-rollback,
  // no CLI, and the absolute reassurance that data + recovery are never at risk. The component-aware wording
  // (updateExplainerText) additionally names the engine-first ordering and the console reload step; the
  // single-engine wording is the pre-multi-component copy, unchanged.
  card.appendChild(h("p", { style: "color:var(--text)" }, updateExplainerText(componentAware)));

  // The owner gate, mirrored as a calm standing note (not a tinted banner). The engine enforces
  // keys.ceremony regardless; this only decides whether the controls below are enabled.
  // THE ONE REFUSAL THAT MUST NOT ASSERT A ROLE IT DOES NOT KNOW. "Applying an engine update is owner
  // only" is a statement about the reader, and when the identity read has not resolved the console does
  // not know whether it is true: it is printing it at a genuine Owner, on the screen carrying the action
  // that most often clears the fault. Worse, an engine that predates /admin/whoami is one of the causes of
  // that state, and an engine update is its remedy, so this is the sentence a customer meets at the exact
  // moment it is least true and most in the way.
  //
  // The gate is NOT lifted. capGateReason still refuses, and it now carries what to do about the specific
  // failure (lib/identity-remedy.ts). Only the claim changes: from asserting the reader's role to saying
  // the role could not be read.
  if (!canManage) {
    card.appendChild(h("p", { class: "field__hint measure", style: "margin-top:var(--space-2)" },
      caller() === null
        ? `This console could not read your role, so it cannot tell whether you may apply an update. ${capGateReason(UPDATE_MANAGE_CAP)}`
        : `Applying an engine update is owner only. ${capGateReason(UPDATE_MANAGE_CAP)}`));
  }

  // The single progress/result region (the calm channel). renderUpdateSteps + the summary lines write here;
  // an engine refusal writes here too. role=status so a screen reader hears progress/outcome politely.
  const out = h("div", { role: "status", "aria-live": "polite", style: "margin-top:var(--space-3)" });

  // a11y: after a reload() the control's nodes are gone and focus falls to <body>; move it back to this
  // card's heading (re-render is synchronous) so a keyboard/AT operator lands on the control they acted on.
  const restoreFocus = (): void => {
    const anchor = document.getElementById(UPDATE_CARD_HEADING_ID);
    if (anchor instanceof HTMLElement) anchor.focus();
  };

  const env = { out, reload, restoreFocus, canManage, destConfigured };
  if (state.kind === "pending") {
    card.appendChild(pendingUpdateBody(engine, state, env));
  } else {
    card.appendChild(availableUpdateBody(engine, updates, env));
  }
  card.appendChild(out);
  return card;
}
