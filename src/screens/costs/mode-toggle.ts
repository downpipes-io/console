// The cost calculator's mode toggle: a two-option WAI-ARIA radiogroup (Observed / Manual) with a
// roving tabindex and arrow/Home/End keyboard operation, plus the honest mode note below it.
// Observed is only selectable when a seed exists; otherwise it renders disabled-with-reason.
// Moved verbatim from view.ts for size; it reads host.mode/observedSeed/modeReason and routes a
// mode change through host.switchMode, exactly as the instance methods did. House rules:
// Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import type { Mode } from "./helpers.ts";

// CostModeToggleHost is the slice of the CostView the mode toggle reads and drives.
export interface CostModeToggleHost {
  readonly mode: Mode;
  readonly observedSeed: unknown | null;
  readonly modeReason: string;
  switchMode(mode: Mode): void;
}

export function buildModeToggle(host: CostModeToggleHost): HTMLElement {
  const card = h("div", { class: "card cost-mode" });
  const head = h("div", { class: "card__header" });
  head.appendChild(h("h2", { class: "card__title", style: "font-size:var(--text-md)" }, "Mode"));
  card.appendChild(head);

  // A two-option segmented control (the radiogroup idiom settings.ts uses for the
  // theme control), so it reads by shape + label and is keyboard operable. Observed is
  // only selectable when a seed exists; otherwise it renders disabled-with-reason.
  // WAI-ARIA radiogroup: roving tabindex (tabindex=0 on the checked radio, -1 on the
  // other) + keydown handler for ArrowLeft/Right/Up/Down and Home/End, mirroring
  // applyRovingGroup() in topology.ts. A click on either enabled button also switches.
  const group = h("div", { class: "cost-segmented", role: "radiogroup", "aria-label": "Calculator mode" });
  const observedSeedable = host.observedSeed !== null;

  const observedBtn = modeButton(host, "observed", "Observed", observedSeedable);
  const manualBtn = modeButton(host, "manual", "Manual", true);
  group.appendChild(observedBtn);
  group.appendChild(manualBtn);

  // Roving tabindex: the checked radio gets tabindex=0, the other gets -1 (even when
  // disabled, a disabled radio in a roving group is skipped, so setting -1 is correct).
  const radioButtons: HTMLButtonElement[] = [observedBtn, manualBtn];
  radioButtons.forEach((btn) => {
    const isActive = btn === (host.mode === "observed" ? observedBtn : manualBtn);
    btn.setAttribute("tabindex", isActive ? "0" : "-1");
  });

  // Keydown on the group: ArrowLeft/ArrowRight/ArrowUp/ArrowDown and Home/End move the
  // roving tab stop and, when the target is not disabled, switch the active mode.
  group.addEventListener("keydown", (ev: Event) => handleRovingKeydown(host, ev, radioButtons, observedBtn));

  card.appendChild(group);

  // The honest mode note: which mode is active and exactly why.
  const note = h("p", { class: "cost-mode__note field__hint", style: "margin-top:var(--space-3)" });
  note.id = "cost-mode-note";
  note.textContent = host.modeReason;
  card.appendChild(note);

  // Group-level doc link (audit G2): the two-option radiogroup is one control, so the link that
  // explains Observed versus Manual mode lives on the group rather than on either radio button.
  card.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/cost-prediction#manual-mode-and-observed-mode", target: "_blank", rel: "noreferrer noopener" },
      "About observed and manual mode",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  return card;
}

// handleRovingKeydown moves the roving tab stop on an arrow/Home/End key and switches the active
// mode to the newly focused enabled radio, mirroring applyRovingGroup() in topology.ts.
function handleRovingKeydown(host: CostModeToggleHost, ev: Event, radioButtons: HTMLButtonElement[], observedBtn: HTMLButtonElement): void {
  const ke = ev as KeyboardEvent;
  if (ke.key !== "ArrowLeft" && ke.key !== "ArrowRight" && ke.key !== "ArrowUp" && ke.key !== "ArrowDown" && ke.key !== "Home" && ke.key !== "End") return;
  const enabledBtns = radioButtons.filter((b) => !b.disabled);
  const active = document.activeElement as HTMLButtonElement | null;
  const idx = active ? enabledBtns.indexOf(active) : -1;
  if (idx < 0 && ke.key !== "Home" && ke.key !== "End") return;
  ke.preventDefault();
  let next = idx;
  if (ke.key === "ArrowRight" || ke.key === "ArrowDown") next = Math.min(enabledBtns.length - 1, idx + 1);
  else if (ke.key === "ArrowLeft" || ke.key === "ArrowUp") next = Math.max(0, idx - 1);
  else if (ke.key === "Home") next = 0;
  else if (ke.key === "End") next = enabledBtns.length - 1;
  if (next === idx) return;
  const target = enabledBtns[next];
  if (!target) return;
  radioButtons.forEach((b) => {
    b.setAttribute("tabindex", "-1");
  });
  target.setAttribute("tabindex", "0");
  target.focus();
  // Determine which mode this enabled button maps to and switch.
  const targetMode: Mode = target === observedBtn ? "observed" : "manual";
  host.switchMode(targetMode);
}

function modeButton(host: CostModeToggleHost, mode: Mode, label: string, enabled: boolean): HTMLButtonElement {
  const active = host.mode === mode;
  const btn = h(
    "button",
    { "data-dp": "costs.radio.mode-button",
      class: `cost-segmented__btn${active ? " cost-segmented__btn--active" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": active ? "true" : "false",
      // A disabled radio's WHY lives in the visible mode note below the group (the
      // single explanation, reachable by touch/keyboard/AT), not a hover-only title.
      ...(enabled ? {} : { disabled: true, "aria-describedby": "cost-mode-note" }),
    },
    label,
  ) as HTMLButtonElement;
  if (enabled) {
    btn.addEventListener("click", () => host.switchMode(mode));
  }
  return btn;
}
