// The attended RUNLOG floor reset: the one way past an env destination the scheduler cannot see a redeploy
// repoint (DEST_R2 or DEST_* pointed at another bucket). The RUNLOG writers verify before they write, so
// they refuse the new bucket against the floor confirmed under the old one (absent-above-floor for an empty
// bucket, below-floor for one holding an older RUNLOG), and no run can land there. It is never automatic: an
// Owner reads the evidence the engine gives (the bucket, the floor, the RUNLOG this bucket holds now), then
// confirms a reset by typing the destination's name, with step-up. The action is offered only when the
// engine's own canReset says a reset would help; otherwise its refusal is shown in plain words.
//
// GET engine.getRunlogFloor promotes and signs nothing. POST engine.resetRunlogFloor rides the console's
// existing step-up (gatedFetch) path and refuses a floor or digest that no longer matches what was shown, so
// a destination that changed between the read and the decision is never acted on blind. It never signs
// anything: it only moves the floor down to the highest index the bucket's RUNLOG holds now (or 0 when it
// holds none).

import type { EngineClient, RunlogFloorView } from "../../api.ts";
import { typeToConfirm } from "../../components/confirm.ts";
import { engineAnswered, errorDetail } from "../../components/error-view.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import type { PickerOption } from "./runlog-shared.ts";
import { fpRow } from "./shared.ts";

// renderRunlogFloorSection builds the floor-reset subsection, sharing the caller's destination picker
// (destSelect, selectedDest) so the Owner names one destination once for every action in the section.
export function renderRunlogFloorSection(engine: EngineClient, destSelect: HTMLSelectElement, selectedDest: () => PickerOption): HTMLElement {
  const sub = h("div", { style: "margin-top:var(--space-5)" });
  sub.appendChild(h("h4", { class: "drawer-section__title", style: "font-size:var(--text-sm)" }, "Anti-rollback floor"));
  sub.appendChild(
    h("p", { class: "field__hint" },
      "Check this destination's confirmed floor against the RUNLOG its bucket holds now, and reset it when a redeploy repointed the bucket. This never runs on its own: you review the evidence first.",
    ),
  );

  const checkBtn = h("button", { "data-dp": "keys.button.check#1", class: "btn btn--secondary btn--sm", type: "button" }, "Check the floor") as HTMLButtonElement;
  const resultEl = h("div", { "data-dp": "keys.runlog.floor.result", style: "margin-top:var(--space-3)" });
  sub.appendChild(checkBtn);
  sub.appendChild(resultEl);

  const doCheck = async (): Promise<void> => {
    resultEl.replaceChildren(h("p", { class: "field__hint" }, "Checking."));
    try {
      const view = await engine.getRunlogFloor(destSelect.value);
      renderResult(view);
    } catch (err) {
      if (isUnauthorised(err)) {
        resultEl.replaceChildren(h("p", { class: "field__hint" }, "Your session ended before the check finished. Sign in again."));
        return goSignedOut();
      }
      resultEl.replaceChildren(
        h("p", { class: "field__error" }, engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to check this destination's floor."),
      );
    }
  };

  const doReset = async (view: RunlogFloorView): Promise<void> => {
    const dest = selectedDest();
    const confirmed = await typeToConfirm({
      title: "Reset this destination's anti-rollback floor",
      impactSentence: "This moves the floor down to match the RUNLOG this destination's bucket holds now. It signs nothing. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes.",
      extra: [
        fpRow("bucket", view.bucket),
        h("p", { style: "margin:0", class: "field__hint" }, `Floor ${view.floor ?? "none recorded"} moves to ${view.resetTo ?? 0}.`),
      ],
      matchValue: dest.matchName,
      matchLabel: "destination name",
      confirmLabel: "Reset floor",
      busyLabel: "Resetting",
    });
    if (!confirmed) return;
    try {
      const res = await engine.resetRunlogFloor({ destinationId: destSelect.value, expectFloor: view.floor, digest: view.runlogPresent ? (view.digest ?? "") : "absent" });
      toast({ message: `Floor reset from ${res.oldFloor ?? "none recorded"} to ${res.newFloor}. Every alert channel was notified; check the audit log and the alert for this destination.`, tone: "warn" });
      await doCheck();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: engineAnswered(err) ? errorDetail(err) : "Could not reset this destination's floor.", tone: "warn" });
    }
  };

  function renderResult(view: RunlogFloorView): void {
    resultEl.replaceChildren();
    resultEl.appendChild(fpRow("bucket", view.bucket));
    resultEl.appendChild(h("p", { class: "field__hint" }, `Confirmed floor: ${view.floor ?? "none recorded"}.`));
    resultEl.appendChild(
      h("p", { class: "field__hint" },
        view.runlogPresent
          ? `This bucket's RUNLOG highest index is ${view.maxIndex ?? 0}.`
          : "This bucket holds no RUNLOG.",
      ),
    );
    if (view.note) resultEl.appendChild(h("p", { class: "field__hint" }, view.note));
    if (view.refusal) resultEl.appendChild(h("p", { class: "field__hint" }, view.refusal));
    if (!view.refusal && !view.note) resultEl.appendChild(h("p", { class: "field__hint" }, "The writers do not refuse this destination on its floor."));
    if (view.canReset) {
      const resetBtn = h("button", { "data-dp": "keys.button.reset", class: "btn btn--danger btn--sm", type: "button" }, "Reset floor") as HTMLButtonElement;
      resetBtn.addEventListener("click", () => void doReset(view));
      resultEl.appendChild(resetBtn);
    }
  }

  checkBtn.addEventListener("click", () => void doCheck());
  return sub;
}
