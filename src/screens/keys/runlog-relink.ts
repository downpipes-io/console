// The attended RUNLOG relink: the one way past one downpipe's chain anomaly in a destination RUNLOG that
// otherwise verifies under the engine's current signer (an older engine, or a control-plane loss). The append
// refuses to relink an anomalous chain itself, because the relink would hide the anomaly, so that downpipe's
// seals stop with no way out. It is never automatic: an Owner reads the evidence the engine gives (whether
// the RUNLOG verifies, the anomaly kind and its disagreeing indices, whether relinking clears it), then
// confirms a relink by typing the downpipe's name, with step-up. The action is offered only when the
// engine's own canRelink says a relink would help; otherwise its refusal is shown in plain words.
//
// GET engine.getRunlogChain promotes and signs nothing. POST engine.relinkRunlog rides the console's
// existing step-up (gatedFetch) path and refuses a digest or anomaly kind that no longer matches what was
// shown, so a chain that changed between the read and the decision is never acted on blind. It never
// re-signs bytes that do not already verify, and it acts on one downpipe's chain only, once.

import type { EngineClient, RunlogChainView } from "../../api.ts";
import { typeToConfirm } from "../../components/confirm.ts";
import { engineAnswered, errorDetail } from "../../components/error-view.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { buildPicker, loadDownpipeOptions, type PickerOption } from "./runlog-shared.ts";
import { fpRow } from "./shared.ts";

const CHOOSE_DOWNPIPE: PickerOption = { value: "", label: "Choose a downpipe", matchName: "" };

// renderRunlogRelinkSection builds the relink subsection, sharing the caller's destination picker
// (destSelect, selectedDest) and adding its own downpipe picker: the relink route names both.
export function renderRunlogRelinkSection(engine: EngineClient, destSelect: HTMLSelectElement, _selectedDest: () => PickerOption): HTMLElement {
  const sub = h("div", { style: "margin-top:var(--space-5)" });
  sub.appendChild(h("h4", { class: "drawer-section__title", style: "font-size:var(--text-sm)" }, "Chain anomaly"));
  sub.appendChild(
    h("p", { class: "field__hint" },
      "Check one downpipe's chain in this destination's RUNLOG, and acknowledge and relink it once when an anomaly is stopping its backups. This never runs on its own: you review the evidence first.",
    ),
  );

  const { select: downpipeSelect, selected: selectedDownpipe } = buildPicker(
    h("select", { "data-dp": "keys.select.runlog-relink-section", class: "select" }) as HTMLSelectElement,
    // CHOOSE_DOWNPIPE stays in the list even once the real downpipes load: unlike the destination picker,
    // there is no good default downpipe, so the Owner always makes an explicit choice.
    () => loadDownpipeOptions(engine).then((opts) => [CHOOSE_DOWNPIPE, ...opts]),
    CHOOSE_DOWNPIPE,
  );
  sub.appendChild(
    h("div", { class: "field" },
      h("span", { class: "field__label" }, "Downpipe"),
      downpipeSelect,
    ),
  );

  const checkBtn = h("button", { "data-dp": "keys.button.check#2", class: "btn btn--secondary btn--sm", type: "button" }, "Check this downpipe's chain") as HTMLButtonElement;
  const resultEl = h("div", { "data-dp": "keys.runlog.chain.result", style: "margin-top:var(--space-3)" });
  sub.appendChild(checkBtn);
  sub.appendChild(resultEl);

  const doCheck = async (): Promise<void> => {
    if (downpipeSelect.value === "") {
      resultEl.replaceChildren(h("p", { class: "field__hint" }, "Choose a downpipe first."));
      return;
    }
    resultEl.replaceChildren(h("p", { class: "field__hint" }, "Checking."));
    try {
      const view = await engine.getRunlogChain({ destinationId: destSelect.value, downpipeId: downpipeSelect.value });
      renderResult(view);
    } catch (err) {
      if (isUnauthorised(err)) {
        resultEl.replaceChildren(h("p", { class: "field__hint" }, "Your session ended before the check finished. Sign in again."));
        return goSignedOut();
      }
      resultEl.replaceChildren(
        h("p", { class: "field__error" }, engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to check this downpipe's chain."),
      );
    }
  };

  const doRelink = async (view: RunlogChainView): Promise<void> => {
    if (!view.digest || !view.anomaly) return;
    const dp = selectedDownpipe();
    const anomaly = view.anomaly;
    const confirmed = await typeToConfirm({
      title: "Acknowledge and relink this downpipe's chain",
      impactSentence: `This accepts the chain's history as it stands and relinks it once. It never re-signs bytes that do not already verify. Anomaly: ${anomaly.reason}. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes.`,
      extra: [
        fpRow("digest (SHA-384)", view.digest),
        h("p", { style: "margin:0", class: "field__hint" }, `${anomaly.kind}${anomaly.indexA !== undefined && anomaly.indexB !== undefined ? ` (index ${anomaly.indexA} and index ${anomaly.indexB})` : ""}.`),
      ],
      matchValue: dp.matchName,
      matchLabel: "downpipe name",
      confirmLabel: "Acknowledge and relink",
      busyLabel: "Relinking",
    });
    if (!confirmed) return;
    try {
      await engine.relinkRunlog({ destinationId: destSelect.value, downpipeId: downpipeSelect.value, digest: view.digest, anomalyKind: anomaly.kind });
      toast({ message: "Relinked. Every alert channel was notified; check the audit log and the alert for this downpipe.", tone: "warn" });
      await doCheck();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: engineAnswered(err) ? errorDetail(err) : "Could not relink this chain.", tone: "warn" });
    }
  };

  function renderResult(view: RunlogChainView): void {
    resultEl.replaceChildren();
    if (!view.present) {
      resultEl.appendChild(h("p", { class: "field__hint" }, "There is no RUNLOG at this destination yet."));
      return;
    }
    resultEl.appendChild(h("p", { class: "field__hint" }, view.verifies ? "The RUNLOG verifies under the current signer." : "The RUNLOG does not verify under the current signer."));
    if (view.digest) resultEl.appendChild(fpRow("RUNLOG digest (SHA-384)", view.digest));
    if (view.chainEntries !== undefined) resultEl.appendChild(h("p", { class: "field__hint" }, `This downpipe has ${view.chainEntries} entr${view.chainEntries === 1 ? "y" : "ies"} in the RUNLOG.`));
    if (view.anomaly) {
      resultEl.appendChild(h("p", { class: "field__hint" }, `Anomaly: ${view.anomaly.kind}. ${view.anomaly.reason}`));
      resultEl.appendChild(h("p", { class: "field__hint" }, view.relinkClears ? "Relinking this chain clears the anomaly." : "Relinking this chain does not clear the anomaly."));
    } else {
      resultEl.appendChild(h("p", { class: "field__hint" }, "This downpipe's chain has no anomaly."));
    }
    if (view.refusal) resultEl.appendChild(h("p", { class: "field__hint" }, view.refusal));
    if (view.canRelink) {
      const relinkBtn = h("button", { "data-dp": "keys.button.relink", class: "btn btn--danger btn--sm", type: "button" }, "Acknowledge and relink") as HTMLButtonElement;
      relinkBtn.addEventListener("click", () => void doRelink(view));
      resultEl.appendChild(relinkBtn);
    }
  }

  checkBtn.addEventListener("click", () => void doCheck());
  return sub;
}
