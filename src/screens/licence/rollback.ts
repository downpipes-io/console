// The standalone one-click rollback control, the first-class revert affordance. It renders in two ways:
// urgent (the hourly canary found a live-but-unverified bad version, the engine FOLD 1 rollbackNeeded) leads
// with a danger banner naming the bad version and shows prominently above the apply control; otherwise it is
// the calm standing "Roll back to the previous version" offer, available independent of any in-flight apply.
// Both POST /admin/update/rollback (the SAFE recovery direction the engine never gates behind a second owner)
// and both collect the one-shot deploy token (held only in the local for the call, never stored). Moved
// verbatim from the licence coordinator for size; copy, markup and token custody are unchanged. House rules:
// Australian English, no em dashes, precise claims.

import type { EngineClient } from "../../api.ts";
import { banner } from "../../components/feedback.ts";
import { field, validateForm } from "../../components/field.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { canCap, capGateReason, refuseWithReason } from "../common.ts";
import {
  ROLLBACK_CARD_HEADING_ID,
  renderUpdateSteps,
  standaloneRollbackOutcomeLine,
  UPDATE_MANAGE_CAP,
  updateRefusalText,
} from "./shared.ts";
import { confirmEngineRollback } from "./update-rollback-confirm.ts";

// RollbackControlMode discriminates the two ways the standalone rollback renders:
//   urgent:true, the hourly canary found a live-but-unverified bad version (engine FOLD 1 rollbackNeeded):
//                  a danger banner + a prominent rollback, shown ABOVE the apply control. `info` carries the
//                  detected version + canary verdict so the banner names exactly what is wrong.
//   urgent:false, the calm standing offer: "Roll back to the previous version", available independent of any
//                  in-flight apply (when a known-good target plausibly exists; see standaloneRollbackOffered).
// Both POST /admin/update/rollback (the SAFE recovery direction the engine never gates behind a second owner);
// both collect the one-shot deploy token (so the engine can re-deploy the prior version), held only locally.
//
// The urgent variant carries WHICH incident, because there are two and they are not the same fact. The
// canary case is a version that is live and looks unhealthy; the rollback-failed case is a version the
// engine has ALREADY REJECTED and tried and failed to revert. Rendering the second under the first's
// sentence would tell the operator a canary is worried when the engine has already decided.
export type RollbackUrgentInfo =
  | { cause: "canary"; recommendedVersion: string; toVersion: string; canaryVerdict: string; at: number }
  | { cause: "rollback-failed"; onVersion: string | null; target: string | null; reason: string | null };

export type RollbackControlMode = { urgent: true; info: RollbackUrgentInfo } | { urgent: false };

// rollbackControl is the owner-gated standalone rollback (POST /admin/update/rollback): a first-class
// "Roll back to the previous version" that reverts to the recorded known-good version, INDEPENDENT of an
// in-flight apply. It is the SAFE recovery direction, so the engine needs no second owner, only the one-shot
// deploy token (collected here, held only in the local for the call, never stored). When urgent (the hourly
// canary flagged the live version unhealthy) it leads with a danger banner naming the bad version and renders
// prominently; otherwise it is the calm standing offer. The engine is the authority on whether a target exists
// (it may answer "no-target"); this control surfaces the outcome honestly via standaloneRollbackOutcomeLine.
export function rollbackControl(engine: EngineClient, mode: RollbackControlMode, reload: () => void): HTMLElement {
  const canManage = canCap(UPDATE_MANAGE_CAP);

  const card = h("div", { class: "card measure", style: "margin-top:var(--space-4)" });
  for (const el of renderRollbackIntro(mode)) card.appendChild(el);

  if (!canManage) {
    card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, `Rolling back the engine is owner only. ${capGateReason(UPDATE_MANAGE_CAP)}`));
  }

  // The one-shot token field, collected exactly like the apply flow (the rollback re-deploys the prior version,
  // which needs the deploy token). Held only in the local `token` for the call; never stored.
  //
  // Deliberately NO Secrets Store caveat here, unlike update-pending-body.ts/update-available-body.ts/
  // update-ramp.ts/update-components-advanced.ts: a rollback never calls the engine's uploadVersion (which
  // re-sends the whole binding set and is what needs the extra scope). It only calls deployVersion against
  // an ALREADY-uploaded version id (engine/src/admin/cf-deploy.ts), a plain POST .../deployments carrying no
  // binding metadata at all, so the template's Workers Scripts: Edit is genuinely enough even when the
  // engine binds a Secrets Store secret elsewhere.
  const tokenField = field({
    id: mode.urgent ? "update-rollback-token-urgent" : "update-rollback-token",
    label: "One-shot deploy token",
    type: "password",
    placeholder: "Paste your Cloudflare API token",
    hint: "A Cloudflare API token with the \"Edit Cloudflare Workers\" permission, needed to re-deploy the previous version. Used once and discarded; never stored, never logged, never sent to the vendor.",
    doc: { href: "https://docs.downpipes.io/operations/update-channel-trust-and-rollback", anchor: "the-standalone-rollback" },
    autocomplete: "off",
    validate: (v) => (v.length >= 1 ? null : "Paste the deploy token to roll back."),
  });
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, tokenField.el));

  const out = h("div", { role: "status", "aria-live": "polite", style: "margin-top:var(--space-3)" });

  const restoreFocus = (): void => {
    const anchor = document.getElementById(ROLLBACK_CARD_HEADING_ID);
    if (anchor instanceof HTMLElement) anchor.focus();
  };

  const rollbackBtn = h(
    "button",
    { "data-busy-label": "Rolling back\u2026", "data-dp": "licence.button.rollback", class: mode.urgent ? "btn btn--primary btn--sm" : "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" },
    "Roll back to the previous version",
  ) as HTMLButtonElement;

  async function rollback(): Promise<void> {
    if (!validateForm([tokenField])) return;
    const token = tokenField.value();
    rollbackBtn.disabled = true;
    rollbackBtn.textContent = "Rolling back…";
    const heading = h("p", { style: "color:var(--text)" }, "Rolling back to the previous version and verifying it…");
    out.replaceChildren(heading);
    try {
      const res = await engine.rollbackUpdate(token);
      heading.textContent = standaloneRollbackOutcomeLine(res);
      out.appendChild(renderUpdateSteps(res.steps));
      if (res.outcome === "reverted" || res.outcome === "reverted-unverified") {
        toast({ message: `Rolled back to ${res.toVersion}.`, tone: "info" });
        reload();
        restoreFocus();
      }
      // already / no-target / failed: the inline line states the reason; nothing changed, so no toast/reload.
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      out.replaceChildren(h("p", { class: "field__error", role: "alert" }, updateRefusalText(err)));
    } finally {
      rollbackBtn.disabled = !canManage;
      rollbackBtn.textContent = "Roll back to the previous version";
    }
  }

  // The confirm gate (the openDemoResetModal idiom): with a token already pasted, one click must
  // never fire the re-deploy. Validate first (so an empty token is caught inline, not behind a
  // modal), then a danger-variant confirm (focus lands on Cancel); nothing is sent until confirmed.
  // This control is ALWAYS an ENGINE rollback (the legacy route, no components), so it goes through the
  // paired-rollback pre-flight: confirmEngineRollback reads the rollback plan first (best-effort,
  // never a blocker) and adds a line when the engine reports the target would strand the live
  // console past its floor.
  async function confirmThenRollback(): Promise<void> {
    if (!validateForm([tokenField])) return;
    const ok = await confirmEngineRollback(engine, {
      title: "Roll back the engine",
      body: "Roll back to the previous engine version? This re-deploys the prior engine code; your data and recovery are unaffected.",
    });
    if (ok) await rollback();
  }

  if (canManage) rollbackBtn.addEventListener("click", () => void confirmThenRollback());
  else refuseWithReason(rollbackBtn, capGateReason(UPDATE_MANAGE_CAP));
  card.appendChild(rollbackBtn);
  card.appendChild(out);
  return card;
}

// renderRollbackIntro builds the card header (heading + status badge) and the mode-specific lead: a
// danger banner naming the bad version + canary verdict when urgent (the hourly canary flagged the
// live version unhealthy and the engine holds no deploy credential to auto-revert), or the calm
// standing-offer prose otherwise. Both reassure that data and recovery are never affected.
function renderRollbackIntro(mode: RollbackControlMode): HTMLElement[] {
  const header = h(
    "div",
    { class: "card__header" },
    // The calm heading is the short "Roll back" so it never shares an accessible name with the
    // "Roll back to the previous version" button below (two controls, one name reads as one).
    h("h3", { class: "card__title", id: ROLLBACK_CARD_HEADING_ID, tabindex: "-1" }, mode.urgent ? "Roll back the engine" : "Roll back"),
    mode.urgent ? badge("danger", "Action needed", { dot: true }) : badge("default", "Available"),
  );
  const lead = mode.urgent
    ? banner({
        tone: "danger",
        message:
          mode.info.cause === "rollback-failed"
            ? `${mode.info.onVersion ? `The live version ${mode.info.onVersion} did not pass its check` : "The live version did not pass its check"} and the automatic rollback did not complete, so your engine is STILL RUNNING it.${mode.info.reason ? ` The engine recorded: ${mode.info.reason}.` : ""} Roll back${mode.info.target ? ` to ${mode.info.target}` : ""} in one click here. Your data and recovery are not affected, archives are immutable and restore is out-of-band; this only reverts the engine code.`
            : `The hourly canary found the live version ${mode.info.toVersion} unhealthy (${mode.info.canaryVerdict}). The engine does not silently auto-deploy a rollback, so roll back to the previous version in one click here. Your data and recovery are not affected, archives are immutable and restore is out-of-band; this only reverts the engine code.`,
      })
    : h(
        "p",
        { style: "color:var(--text)" },
        "Roll back the engine to the previous version it was on before the last update. This is the safe recovery direction (the same revert the canary takes automatically), so it does not need a second owner. Your data and recovery are never affected, archives are immutable and restore is out-of-band; this only reverts the engine code.",
      );
  return [header, lead];
}
