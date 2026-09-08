// The OPT-IN gradual percentage ramp control for the safe-apply update section. Moved verbatim from update.ts
// for size; token custody, copy and control flow are unchanged. House rules:
// Australian English, no em dashes, precise claims.

import type { EngineClient } from "../../api.ts";
import { field, validateForm } from "../../components/field.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import {
  queuedForSecondOwnerLine,
  rampOutcomeLine,
  renderUpdateSteps,
  updateRefusalText,
} from "./shared.ts";

// rampSection is the OPT-IN gradual percentage ramp (POST /admin/update/ramp), the advanced alternative to the
// atomic "Update now". It is collapsed by default (§7a: clearly secondary to the one-click apply) and carries
// the HONEST caveat that a ramp serves REAL production traffic, it is not an isolated sandbox (isolated previews
// would need *.workers.dev, which is banned). It collects the SAME one-shot deploy token (held only in the local
// for the call) and a percentage (1-99), ramps the new version to that fraction of live traffic, canary-gates it,
// and on a healthy ramp leaves the new version live to that % awaiting a promote-to-100% via the normal apply (a
// reload surfaces that as a pending verification). A migration/breaking ramp under dual control returns the 202
// owner-action queue, surfaced as "queued for a second owner's approval". Owner+compat gated by the caller.
export function rampSection(engine: EngineClient, out: HTMLElement, reload: () => void, restoreFocus: () => void): HTMLElement {
  const details = h("details", { class: "disclosure", style: "margin-top:var(--space-4)" }) as HTMLDetailsElement;
  details.appendChild(h("summary", "Advanced: roll out gradually (a percentage ramp)"));
  const inner = h("div", { class: "disclosure__body" });

  inner.appendChild(
    h(
      "p",
      { class: "field__hint" },
      // The old copy promised the ramp "auto-rolls-back if the canary does not pass", and since the ramp
      // became two-phase that is not what happens: starting the ramp CANNOT canary the slice it
      // is creating, so nothing is auto-verified and nothing auto-reverts. The check is a second, deliberate
      // step, and it is the operator who keeps or rolls back. Promising an automatic safety net that does not
      // run is the worst possible thing to be wrong about on this control.
      "Instead of switching all traffic at once, you can ramp a percentage of LIVE traffic onto the new version, check it, and promote it to 100% later (with the normal Update now). Important: a ramp serves REAL production traffic, it is not an isolated test sandbox, so the percentage you choose is the share of real requests that runs the new version. It is still brick-safe (the release is verified before anything is deployed), but the ramp is a TWO-STEP action: starting it cannot check the slice it just created, so the new version serves traffic UNVERIFIED until you finish the check from the verification panel that appears here. That check keeps it or rolls it back in one click. Most updates do not need this; the normal one-click apply is the recommended path.",
    ),
  );

  const pctField = field({
    id: "update-ramp-pct",
    label: "Percentage of live traffic (1-99)",
    type: "number",
    placeholder: "e.g. 10",
    hint: "A whole number between 1 and 99. 100% is the normal atomic apply (use Update now for that).",
    doc: { href: "https://docs.downpipes.io/operations/update-channel-trust-and-rollback", anchor: "the-opt-in-gradual-ramp-serves-real-traffic" },
    autocomplete: "off",
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 99 ? null : "Enter a whole number between 1 and 99.";
    },
  });
  inner.appendChild(pctField.el);

  const rampTokenField = field({
    id: "update-ramp-token",
    label: "One-shot deploy token",
    type: "password",
    placeholder: "Paste your Cloudflare API token",
    hint: "The same Cloudflare API token (\"Edit Cloudflare Workers\"). If your engine binds a Secrets Store secret as a backup source, add Secrets Store edit to the token as well: the template predates Secrets Store, and the upload-version step refuses without it. Used once to deploy and verify the ramp, then discarded; never stored or sent to the vendor.",
    doc: { href: "https://docs.downpipes.io/operations/update-channel-applying", anchor: "what-the-operator-does" },
    autocomplete: "off",
    validate: (v) => (v.length >= 1 ? null : "Paste the deploy token to start the ramp."),
  });
  inner.appendChild(rampTokenField.el);

  const rampBtn = h("button", { "data-busy-label": "Ramping\u2026", "data-dp": "licence.button.ramp", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" }, "Start gradual ramp") as HTMLButtonElement;

  async function startRamp(): Promise<void> {
    if (!validateForm([pctField, rampTokenField])) return;
    const percentage = Number(pctField.value());
    // One-shot token, held ONLY for this ramp call.
    const token = rampTokenField.value();
    rampBtn.disabled = true;
    rampBtn.textContent = "Ramping…";
    const heading = h("p", { style: "color:var(--text)" }, `Verifying and ramping the new version to ${percentage}% of live traffic…`);
    out.replaceChildren(heading);
    try {
      const res = await engine.rampUpdate({ token, percentage });
      if (res.status === "queued") {
        heading.textContent = queuedForSecondOwnerLine("ramp");
        return;
      }
      const ramp = res.value;
      heading.textContent = rampOutcomeLine(ramp);
      out.appendChild(renderUpdateSteps(ramp.steps));
      // THE RELOAD IS THE WHOLE POINT, and it never fired. The engine's success outcome is "ramp-pending",
      // never "ramped" (phase 1 cannot canary the slice it is still creating), so this branch and the
      // "rolled-back" one below it were both DEAD: a successful ramp fell through, no toast, NO RELOAD -- and
      // the reload is what re-renders the Updates section so the PENDING CARD appears. That card, which
      // recognises a ramp from the recorded percentage, is the only surface that can settle a ramp. The
      // operator was left on a screen that said "The ramp finished." while a live traffic split sat unverified
      // and the control to finish it was not on the page.
      //
      // The toast does not self-dismiss (durationMs: 0): the ramp is serving real customer traffic unverified,
      // and the operator has to act to finish it, so this is not a message to let slide away.
      if (ramp.outcome === "ramp-pending") {
        toast({ message: `${ramp.toVersion ?? ramp.recommendedVersion} is serving ${ramp.percentage ?? percentage}% of live traffic and is not verified yet. Finish the check below to keep it, or roll back.`, tone: "info", durationMs: 0 });
        reload();
        restoreFocus();
      }
      // refused / no-update: the inline line carries the reason; the engine is unchanged, no toast.
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      out.replaceChildren(h("p", { class: "field__error", role: "alert" }, updateRefusalText(err)));
    } finally {
      rampBtn.disabled = false;
      rampBtn.textContent = "Start gradual ramp";
    }
  }

  rampBtn.addEventListener("click", () => void startRamp());
  inner.appendChild(rampBtn);
  details.appendChild(inner);
  return details;
}
