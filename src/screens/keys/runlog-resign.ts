// The attended RUNLOG re-sign: the one way past a destination's backup RUNLOG whose signature does not
// verify under the engine's current signer (a deleted signature, a crash, or a signer re-key over a signer
// that would not load). It is never automatic. An Owner reads the evidence the engine gives (the object, the
// signer fingerprints, the digest, the highest index against the last good index), then confirms a re-sign
// by typing the destination's name, with step-up. A non-Owner sees that an Owner must act and nothing else,
// because the read itself is Owner-only server-side (keys.ceremony).
//
// This is the first of three sibling actions the "Destination RUNLOG signature" section offers
// (renderRunlogResignSection composes this one with the floor reset and the relink, runlog-floor.ts and
// runlog-relink.ts); the destination picker and its options come from runlog-shared.ts, shared across all
// three so a destination id is always one the console already lists.
//
// GET engine.getRunlogSignature promotes and signs nothing. POST engine.resignRunlog rides the console's
// existing step-up (gatedFetch) path and refuses a digest that no longer matches the stored bytes, so a
// RUNLOG that changed between the read and the decision is refused rather than re-signed blind.

import type { EngineClient, RunlogSignatureState, RunlogSignatureView } from "../../api.ts";
import { typeToConfirm } from "../../components/confirm.ts";
import { engineAnswered, errorDetail } from "../../components/error-view.ts";
import { type StatusTone, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { canCap, capGateReason } from "../common.ts";
import { renderRunlogFloorSection } from "./runlog-floor.ts";
import { renderRunlogRelinkSection } from "./runlog-relink.ts";
import { buildPicker, DEFAULT_DESTINATION_OPTION, loadDestinationOptions, type PickerOption } from "./runlog-shared.ts";
import { fpRow } from "./shared.ts";

// stateTone and stateLabel read RunlogSignatureView.state honestly: "verified" is the only state that
// needs no attention, "pending-verifies" is the engine's own interrupted write (no Owner decision needed),
// and the rest name a RUNLOG this section can help with or a destination with nothing yet.
function stateTone(state: RunlogSignatureState): StatusTone {
  if (state === "verified") return "ok";
  if (state === "pending-verifies") return "info";
  if (state === "absent") return "neutral";
  return "danger";
}

function stateLabel(state: RunlogSignatureState): string {
  switch (state) {
    case "verified": return "Verifies under the current signer";
    case "pending-verifies": return "An interrupted write; the next backup resumes it";
    case "sig-absent": return "No signature file";
    case "sig-invalid": return "Does not verify under the current signer";
    case "absent": return "No RUNLOG yet";
  }
}

function renderResignSubsection(engine: EngineClient, destSelect: HTMLSelectElement, selectedDest: () => PickerOption): HTMLElement {
  const sub = h("div");
  sub.appendChild(h("h4", { class: "drawer-section__title", style: "font-size:var(--text-sm)" }, "Signature"));
  sub.appendChild(
    h("p", { class: "field__hint" },
      "Check whether this destination's backup RUNLOG verifies under your engine's current signer, and re-sign it when it does not. This never runs on its own: you review the evidence first.",
    ),
  );

  const checkBtn = h("button", { "data-dp": "keys.button.check#3", class: "btn btn--secondary btn--sm", type: "button" }, "Check RUNLOG signature") as HTMLButtonElement;
  const resultEl = h("div", { "data-dp": "keys.runlog.result", style: "margin-top:var(--space-3)" });
  sub.appendChild(checkBtn);
  sub.appendChild(resultEl);

  const doCheck = async (): Promise<void> => {
    resultEl.replaceChildren(h("p", { class: "field__hint" }, "Checking."));
    try {
      const view = await engine.getRunlogSignature(destSelect.value);
      renderResult(view);
    } catch (err) {
      if (isUnauthorised(err)) {
        resultEl.replaceChildren(h("p", { class: "field__hint" }, "Your session ended before the check finished. Sign in again."));
        return goSignedOut();
      }
      resultEl.replaceChildren(
        h("p", { class: "field__error" }, engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to check this destination's RUNLOG."),
      );
    }
  };

  const doResign = async (view: RunlogSignatureView): Promise<void> => {
    if (!view.digest) return;
    const dest = selectedDest();
    const confirmed = await typeToConfirm({
      title: "Re-sign this destination's RUNLOG",
      impactSentence: "Only re-sign if you know why this signature is missing or wrong: a deleted file, a crash, or a signer re-key. Re-signing a changed file makes it look genuine. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes.",
      extra: [
        fpRow("digest (SHA-384)", view.digest),
        h("p", { style: "margin:0", class: "field__hint" }, `Highest index ${view.maxIndex ?? 0}, last good index ${view.lastGoodIndex ?? "none recorded"}.`),
      ],
      matchValue: dest.matchName,
      matchLabel: "destination name",
      confirmLabel: "Re-sign",
      busyLabel: "Re-signing",
    });
    if (!confirmed) return;
    try {
      const res = await engine.resignRunlog({ destinationId: destSelect.value, digest: view.digest });
      toast({
        message: res.outcome === "resumed"
          ? "Resumed the engine's own interrupted write. No decision was needed."
          : "Re-signed. Every alert channel was notified; check the audit log and the alert for this destination.",
        tone: res.outcome === "resumed" ? "info" : "warn",
      });
      await doCheck();
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: engineAnswered(err) ? errorDetail(err) : "Could not re-sign this RUNLOG.", tone: "warn" });
    }
  };

  function renderResult(view: RunlogSignatureView): void {
    resultEl.replaceChildren();
    if (!view.present) {
      resultEl.appendChild(h("p", { class: "field__hint" }, "There is no RUNLOG at this destination yet."));
      return;
    }
    resultEl.appendChild(h("p", {}, statusWithLabel(stateTone(view.state), stateLabel(view.state))));
    const fp = h("div", { class: "fingerprints" });
    fp.appendChild(fpRow("current signer", view.currentSigner));
    if (view.heldOldSigner) fp.appendChild(fpRow("held previous signer", view.heldOldSigner));
    if (view.digest) fp.appendChild(fpRow("RUNLOG digest (SHA-384)", view.digest));
    resultEl.appendChild(fp);
    if (view.maxIndex !== undefined) {
      resultEl.appendChild(
        h("p", { class: "field__hint" }, `Highest index ${view.maxIndex}, last good index ${view.lastGoodIndex ?? "none recorded"}.`),
      );
    }
    if (view.chainAnomaly) resultEl.appendChild(h("p", { class: "field__hint" }, `Chain anomaly: ${view.chainAnomaly}.`));
    if (view.handoverPending) resultEl.appendChild(h("p", { class: "field__hint" }, "A signer re-key hand-over is waiting on this destination."));
    if (view.refusal) resultEl.appendChild(h("p", { class: "field__hint" }, view.refusal));
    if (view.canResign) {
      const resignBtn = h("button", { "data-dp": "keys.button.resign", class: "btn btn--danger btn--sm", type: "button" }, "Re-sign this RUNLOG") as HTMLButtonElement;
      resignBtn.addEventListener("click", () => void doResign(view));
      resultEl.appendChild(resignBtn);
    }
  }

  checkBtn.addEventListener("click", () => void doCheck());
  return sub;
}

// renderRunlogResignSection builds the whole "Destination RUNLOG signature" section: the shared destination
// picker, then three subsections (signature re-sign, anti-rollback floor reset, chain relink), each with its
// own read-then-decide flow and its own typed confirmation. initialDestinationId pre-selects a destination
// the caller already knows is failing (for example a re-key hand-over's pending list), when the picker ends
// up offering it; otherwise the picker opens on "Default destination".
export function renderRunlogResignSection(engine: EngineClient, initialDestinationId?: string): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-5)" });
  wrap.appendChild(h("h3", { class: "drawer-section__title" }, "Destination RUNLOG signature"));
  wrap.appendChild(
    h("p", { class: "field__hint" },
      "Three Owner-only ways past a RUNLOG the engine refuses to write to on its own: re-sign a bad signature, reset a floor, or relink one chain anomaly. Each shows the evidence first; none runs on its own.",
    ),
  );

  if (!canCap("keys.ceremony")) {
    wrap.appendChild(
      h("p", { class: "field__hint" },
        `If your engine reports a destination RUNLOG that does not verify, an Owner must review it and decide. ${capGateReason("keys.ceremony")}`,
      ),
    );
    return wrap;
  }

  const { select: destSelect, selected: selectedDest } = buildPicker(
    h("select", { "data-dp": "keys.select.runlog-resign-section", class: "select" }) as HTMLSelectElement,
    () => loadDestinationOptions(engine),
    DEFAULT_DESTINATION_OPTION,
    initialDestinationId,
  );
  wrap.appendChild(
    h("div", { class: "field" },
      h("span", { class: "field__label" }, "Destination"),
      destSelect,
    ),
  );

  wrap.appendChild(renderResignSubsection(engine, destSelect, selectedDest));
  wrap.appendChild(renderRunlogFloorSection(engine, destSelect, selectedDest));
  wrap.appendChild(renderRunlogRelinkSection(engine, destSelect, selectedDest));

  return wrap;
}
