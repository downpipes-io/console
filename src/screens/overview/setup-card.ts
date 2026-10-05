// Overview's not-set-up state. While a numbered setup step is unfinished, Overview shows this card and nothing
// else: the seven steps of the one setup model (lib/setup-state.ts setupViewOf), each with its state, and one
// action, into the setup surface, which resumes at the first unfinished question. A caller who is not an
// Owner, looking at a step only an Owner can do, reads an honest hand-off instead of a dead Continue.

import type { Caller } from "../../api.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_ALERT } from "../../lib/icons.ts";
import { setupModel } from "../../lib/setup-flow/model.ts";
import { clearRevokeReminder, readRevokeReminder, revokeSentence } from "../../lib/setup-flow/revoke-reminder.ts";
import { SETUP_ENTRY_ROUTE, type SetupView } from "../../lib/setup-state.ts";

// revokeReminderBanner is the deploy-token reminder outside setup: a token pasted at setup's Apply can edit the
// engine's Worker, the engine kept none of them, and the user may have left setup ("Remind me at the end", then
// "Leave setup") or closed its tab. It reads the record kept outside the tab (lib/setup-flow/revoke-reminder.ts)
// and this tab's setup draft, whichever names more tokens (the demo keeps only the draft). It stays on Overview,
// before and after setup is complete, until the user ticks that they revoked each one. The tick is the
// attestation, as in setup; nothing else clears it.
export function revokeReminderBanner(): HTMLElement | null {
  const stored = readRevokeReminder();
  const d = setupModel().get().draft;
  const pending = d.deployTokenUsed && !d.deployTokenRevoked ? Math.max(1, d.deployTokenUses) : 0;
  const tokens = Math.max(stored?.tokens ?? 0, pending);
  if (tokens === 0) return null;
  const r = { tokens };
  const box = h("input", { id: "overview-revoke-tick", type: "checkbox" }) as HTMLInputElement;
  const el = h(
    "div",
    { class: "banner banner--warn", role: "status" },
    h("span", { class: "banner__icon", "aria-hidden": "true" }, svgIcon(ICON_ALERT, { size: 16 })),
    h(
      "div",
      { class: "banner__msg banner__stack" },
      h("p", revokeSentence(r.tokens), " ", h("a", { href: "https://dash.cloudflare.com/profile/api-tokens", target: "_blank", rel: "noreferrer noopener" }, "Open API Tokens")),
      h("div", { class: "checkbox-row" }, box, h("label", { for: "overview-revoke-tick" }, r.tokens > 1 ? "I revoked each of them." : "I revoked it.")),
    ),
  );
  box.addEventListener("change", () => {
    if (!box.checked) return;
    clearRevokeReminder();
    if (setupModel().get().draft.deployTokenUsed) setupModel().update({ deployTokenRevoked: true });
    el.className = "banner banner--info";
    el.replaceChildren(h("span", { class: "banner__msg", role: "status" }, r.tokens > 1 ? "You confirmed you revoked each deploy token." : "You confirmed you revoked the deploy token."));
  });
  return el;
}

// setupSubtitle is Overview's header line while setup is unfinished. Once the keys are in place the setup reads
// as progress, not as nothing configured.
export function setupSubtitle(view: SetupView): string {
  const keysDone = view.steps.find((s) => s.id === "keys")?.done === true;
  return keysDone ? "Your keys are in place. A few steps remain before your first backup is sealed." : "Backups are not running yet. Setup gets you there.";
}

export function setupProgressCard(view: SetupView, who: Caller | null, navigate: (to: string) => void): HTMLElement {
  const needsOwner = !view.complete && view.current.ownerOnly && who !== null && who.role !== "owner";
  const done = view.steps.filter((s) => s.done).length;
  const items = view.steps.map((st, i) => {
    const isCurrent = i === view.currentIndex && !view.complete;
    const marker = st.done
      ? h("span", { class: "setup-check__mark setup-check__mark--done", "aria-hidden": "true" }, "✓")
      : h("span", { class: `setup-check__mark${isCurrent ? " setup-check__mark--current" : ""}`, "aria-hidden": "true" }, String(i + 1));
    return h(
      "li",
      { class: "setup-check__item", ...(isCurrent ? { "aria-current": "step" } : {}) },
      marker,
      h("span", { class: isCurrent ? "setup-check__label setup-check__label--current" : "setup-check__label" }, st.label, st.done ? h("span", { class: "visually-hidden" }, " (done)") : null),
    );
  });
  const desc = view.complete
    ? "Every step is done. Your first backup is sealed."
    : needsOwner
      ? `Next is step ${view.stepNumber}, ${view.current.label}. An Owner does this step. You can follow the setup as it happens.`
      : `${done} of ${view.steps.length} steps done. Next is ${view.current.label}. Setup continues where you stopped.`;
  // Named, so its hook derives from the name (overview.button.continue) and never takes a #n slot from the
  // coverage grid's overview.button.navigate#2, which the harness pins.
  const continueBtn = h(
    "button",
    { "data-dp": "overview.button.continue", class: "btn btn--primary", type: "button", on: { click: () => navigate(view.complete ? "/downpipes" : SETUP_ENTRY_ROUTE) } },
    view.complete ? "Open Downpipes" : needsOwner ? "View setup" : "Continue setup",
  );
  return h(
    "section",
    { class: "card", "aria-label": "Setup" },
    h("h2", { class: "card__title" }, view.complete ? "Setup is complete" : "Set up your first backup"),
    h("p", { class: "card__desc" }, desc),
    h("ol", { class: "setup-check" }, ...items),
    h("div", { style: "margin-top:var(--space-4)" }, continueBtn),
  );
}
