// The strict break-glass-only posture switch on the Posture tab of the Keys and break-glass screen (the
// in-console fulfilment of the onboarding "switch later on the Keys screen" promise). It lets an Owner tighten
// the engine to strict break-glass-only: the engine removes both operational secrets via a one-shot scoped
// token, so it can no longer self-decrypt archives. This is SAFE for recovery (every archive is wrapped to the
// break-glass recipient too, so the offline identity.key still recovers everything) and only removes the
// engine's ability to self-test-restore. It is irreversible without a re-key, so it is confirm-to-act. Moved
// verbatim from the keys coordinator for size; it imports the shared leaf (./shared.ts) only, so it never
// forms a cycle.
//
// House style: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { canDo, gateReason } from "../common.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { inlineRetry, SESSION_ENDED_ACTION, sessionEnded, errorDetail, engineAnswered } from "../../components/error-view.ts";
import { statusWithLabel } from "../../components/status.ts";
import type { EngineClient } from "../../api.ts";
import { renderTokenApply } from "./shared.ts";
import { isDiscardGuardRefusal, type DiscardGuardRefusal } from "../../lib/api/client-keys.ts";

// guardExplanation turns the engine's discard-guard refusal into the two things the owner needs: what
// exactly is at stake, and what the one sanctioned way forward is. The engine's own reason sentence is
// shown verbatim as the authority, and these lines add the counts as separate, scannable facts.
//
// The distinction between the two counts is load-bearing and must never be blurred. strandedRunCount is
// "we checked, and this many archives can be opened ONLY by the key you are about to delete".
// unknownRunCount is "we could not check these", which is not a smaller number of the same thing: it is
// an unknown, and an unknown is the more dangerous state because it may be worse than it looks.
function guardExplanation(g: DiscardGuardRefusal): HTMLElement[] {
  const lines: HTMLElement[] = [];
  if (g.strandedRunCount > 0) {
    const n = g.strandedRunCount;
    lines.push(
      h("li", {}, `${n} ${n === 1 ? "archive" : "archives"} can be opened only by the operational key you are removing. ${n === 1 ? "It is" : "They are"} sealed to a break-glass key that is not your current one, so removing this key leaves ${n === 1 ? "it" : "them"} recoverable only with the offline identity.key of that older vintage.`),
    );
  }
  if (g.unknownRunCount > 0) {
    const n = g.unknownRunCount;
    lines.push(
      h("li", {}, `${n} ${n === 1 ? "archive's" : "archives'"} recipient list could not be read back, so ${n === 1 ? "it" : "they"} could not be confirmed safe. This is not the same as safe: it is unchecked.`),
    );
  }
  if (!g.historyReadOk) {
    lines.push(h("li", {}, "The run history could not be read in full, so the engine could not work out which archives are affected at all."));
  }
  if (g.truncated) {
    lines.push(h("li", {}, "More archives exist than one inventory pass reads, so older ones were not checked."));
  }
  return lines;
}

export function renderPostureSwitch(engine: EngineClient): HTMLElement {
  const wrap = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  wrap.appendChild(h("h2", { class: "card__title" }, "Strict break-glass-only custody"));
  const body = h("div");
  wrap.appendChild(body);
  body.appendChild(skeletonRows(2));

  // Named, and re-runnable, because the catch at the bottom needs something to offer. It used to replace
  // this whole panel with a single sentence and no control, so an owner who hit one failed status read lost
  // the break-glass-only switch for the life of the screen.
  const load = (): void => {
    body.replaceChildren(skeletonRows(2));
    void engine.status().then((s) => {
      body.replaceChildren();
      if (!s.operationalConfigured.private) {
        // Already break-glass-only: nothing the engine holds can read an archive. State it plainly.
        body.appendChild(
          statusWithLabel("trust", "Your engine is already break-glass-only. It holds no key that can read your archives."),
        );
        return;
      }
      body.appendChild(
        h("p", { style: "color:var(--text)" }, "Right now your engine also holds an operational key that can read your archives, so it can test-restore on its own. Switching to break-glass-only removes that key, so only your offline identity.key can ever read your backups."),
      );
      body.appendChild(
        h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Recovery is unaffected: every archive is also wrapped to your break-glass key, so identity.key still recovers everything, including archives sealed while the operational key was present. Your engine loses only its unattended restore checks."),
      );
      body.appendChild(
        h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "This is one-way: returning to two-recipient means generating and installing a fresh operational key."),
      );
      // THE CEREMONY, named before the button rather than discovered after it. This screen states its own
      // rather than leaning on the shared apply control's line: the write behind it permanently deletes both
      // operational worker secrets, and it is reached by two different controls (the apply, and the second
      // confirmation the engine's discard guard raises), so an operator can arrive at the prompt on a path
      // where the apply control is no longer the thing they are looking at.
      body.appendChild(
        h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "You may be asked to confirm with your own passkey before the switch runs. If you dismiss that prompt, or it fails, nothing is removed and your engine keeps the operational key until you apply again."),
      );

      if (!canDo("owner")) {
        body.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-3)" }, gateReason("owner")));
        return;
      }

      const done = h("p", { class: "field__hint", role: "status", "aria-live": "polite", style: "margin-top:var(--space-2)" });
      const poll = async (): Promise<void> => {
        done.textContent = "Confirming the engine no longer holds the operational key.";
        try {
          const s2 = await engine.status();
          done.textContent = s2.operationalConfigured.private
            ? "Not reported removed yet; the engine can take a moment, then re-open this tab to confirm."
            : "Done. Your engine is now break-glass-only and holds no key that can read your archives.";
        } catch (err) {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: this line is the only report the owner gets that the operational
            // key really is gone, so it must not be left mid-sentence.
            done.textContent = "Your session ended before the confirmation finished. Sign in again and re-open this tab to confirm.";
            goSignedOut();
            return;
          }
          // AN ANSWER IS NOT AN UNREACHABLE ENGINE. This line is the owner's only report that the
          // operational key really is gone, so a 429 or a refused step-up must read as itself here rather
          // than as an outage the owner is then asked to go and investigate.
          done.textContent = engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to confirm.";
        }
      };
      // The discard-guard consumer. The engine refuses this switch with a 409 when removing the
      // operational key would strand an archive, or when it could not rule that out, and it waits for an
      // explicit confirmDiscardStranded. Before this, the console printed the refusal and re-enabled the
      // button, which dead-ended the owner: the engine's only sanctioned path forward had no control in the
      // UI, on exactly the action that stands between a key rotation and permanent loss of old archives.
      //
      // The second confirmation is deliberately a SEPARATE control that appears only after a refusal, not a
      // checkbox offered up front. Consenting to discard archives is a different decision from tightening
      // custody, taken with the counts in view, and it should be reachable only once the engine has said
      // what is at stake.
      const guardZone = h("div", { style: "margin-top:var(--space-3)" });
      guardZone.hidden = true;
      const runSwitch = async (token: string, confirmDiscard: boolean): Promise<void> => {
        try {
          await engine.setBreakGlassOnly(token, confirmDiscard);
          guardZone.hidden = true;
          guardZone.replaceChildren();
        } catch (err) {
          if (isDiscardGuardRefusal(err)) {
            renderGuardRefusal(err, token);
            // Re-thrown so renderTokenApply keeps its own contract: the apply did NOT succeed, so it must
            // not print "Removed". The message is short because the detail is in guardZone below it.
            throw new Error("The engine refused the switch to prevent silent data loss. See what is at stake below.");
          }
          throw err;
        }
      };
      const renderGuardRefusal = (g: DiscardGuardRefusal, token: string): void => {
        const lines = guardExplanation(g);
        const list = h("ul", { class: "field__hint", style: "margin:var(--space-2) 0 0 var(--space-4)" });
        for (const li of lines) list.appendChild(li);
        const confirmBtn = h("button", { "data-dp": "keys.button.confirm", type: "button", class: "btn btn--danger", style: "margin-top:var(--space-3)" }, "I hold the identity.key for every older vintage, remove the key anyway");
        const outcome = h("p", { class: "field__hint", role: "status", "aria-live": "polite", style: "margin-top:var(--space-2)" });
        confirmBtn.addEventListener("click", () => {
          confirmBtn.disabled = true;
          outcome.textContent = "Removing the operational key with your confirmation.";
          void runSwitch(token, true).then(
            () => { outcome.textContent = "Removed. Your engine is now break-glass-only."; void poll(); },
            (err: unknown) => {
              if (isUnauthorised(err)) {
                // PAINT FIRST, THEN LEAVE: the removal did not happen, so the confirmation control has to
                // be pressable again and its outcome line must not stay mid-sentence.
                confirmBtn.disabled = false;
                outcome.textContent = SESSION_ENDED_ACTION;
                goSignedOut();
                return;
              }
              confirmBtn.disabled = false;
              // errorDetail classifies through the same pipeline blockError uses, so a genuine transport
              // fault here reads as reviewed customer copy rather than the raw "<verb>: <status>" throw.
              outcome.textContent = errorDetail(err);
            },
          );
        });
        guardZone.replaceChildren(
          h("p", { class: "field__hint", style: "font-weight:600" }, "The engine refused this switch to prevent silent data loss"),
          h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, g.message),
          list,
          h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "If you have kept the offline identity.key for every older break-glass vintage, those archives stay recoverable and you can proceed. If you have not, proceeding makes them permanently unrecoverable."),
          confirmBtn,
          outcome,
        );
        guardZone.hidden = false;
      };

      body.appendChild(
        renderTokenApply({
          applyLabel: "Switch to break-glass-only",
      tokenPurpose: "remove the operational key",
          busyLabel: "Removing the operational key",
          doneLabel: "Removed",
          apply: (token) => runSwitch(token, false),
          onApplied: () => { void poll(); },
          confirm: {
            title: "Remove the operational key?",
            // "This cannot be undone without generating new keys" was an overstatement, false against the engine:
            // POST /keys/add-operational installs ONLY the operational
            // pair and never reads or writes SIGNER_PRIVATE or BREAK_GLASS_PUBLIC (engine/src/admin/router-keys.ts,
            // which calls itself "the minimal upgrade path for a break-glass-only engine"), and pickReturningOwnerCard
            // in ./posture.ts routes exactly the post-switch state (signer + break-glass present, operational
            // private absent) to renderAddOperationalEntry, on this same Posture tab. So the return route needs no
            // key generation and has a control already on this screen.
            //
            // Pricing the SAFE posture as the expensive one is the harm: it pushes a customer toward taking an
            // operational key they did not need, and THAT is the direction that cannot be taken back, because the
            // recipient set is baked into each archive at seal time and is never rewrapped. The last sentence
            // states that asymmetry instead of inventing a cost, and it is the one caveat the return route really
            // carries: a later operational key opens only what was sealed after it.
            body: "Your engine will no longer be able to read your archives or test-restore on its own. Recovery is unaffected: your offline identity.key still opens every archive. You can add an operational key again later from this screen with no re-key, and your break-glass key and identity.key stay the ones you already have. A later operational key opens only the runs sealed after it.",
            confirmLabel: "Remove the operational key",
            danger: true,
          },
        }),
      );
      body.appendChild(guardZone);
      body.appendChild(done);
    }).catch((err) => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the panel body is a skeleton until this replaces it.
        body.replaceChildren(sessionEnded(load));
        goSignedOut();
        return;
      }
      // This used to end the panel. "Could not read the engine posture just now." names no remedy and
      // left nothing to press, on the one control that tightens custody, so the only way back was reloading
      // the tab.
      body.replaceChildren(
        inlineRetry({
          message: "The engine did not answer with its key posture, so this switch is not shown. Your custody setting is unchanged: this is a failed read, not a change to it.",
          onReload: load,
        }),
      );
    });
  };
  load();

  return wrap;
}
