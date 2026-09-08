// The ADVANCED per-component disclosure for the safe-apply update card (multi-component updates P5):
// apply ONE component alone, or roll ONE component back, instead of the combined release apply. It renders
// ONLY when the engine advertised components (UpdateStatus.components present); an old engine never sees
// it (the hard degradation rule). Collapsed by default, like the gradual-ramp disclosure beside it (§7a:
// clearly secondary to the one-click release apply). It collects the SAME one-shot deploy token (held only
// in the local for the call, never stored) and drives the SAME live flow as Update now, so a console-only
// apply still gets the chunk preload + the post-apply build check, and an engine-only apply still settles.
// House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { field, validateForm } from "../../components/field.ts";
import { confirmModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import {
  renderUpdateSteps,
  componentRows,
  componentLabel,
  standaloneRollbackOutcomeLine,
  consoleRollbackOutcomeLine,
  updateRefusalText,
  type UpdateBodyEnv,
} from "./shared.ts";
import { runLiveApplyFlow } from "./update-apply-flow.ts";
import { confirmEngineRollback } from "./update-rollback-confirm.ts";
import type { EngineClient, UpdateComponentId, UpdateStatus } from "../../api.ts";

// componentAdvancedSection builds the disclosure, or returns null when the engine sent no components map
// (the caller then appends nothing; nothing component-aware may render without it). Owner+compat gating is
// the caller's (it mounts this only when a live apply is offered, exactly like the ramp section).
export function componentAdvancedSection(engine: EngineClient, updates: UpdateStatus, env: UpdateBodyEnv, ownConsoleVersion: string | null): HTMLElement | null {
  const rows = componentRows(updates, ownConsoleVersion);
  if (rows.length === 0) return null;
  const { out, reload, restoreFocus } = env;

  const details = h("details", { class: "disclosure", style: "margin-top:var(--space-4)" }) as HTMLDetailsElement;
  details.appendChild(h("summary", "Advanced: update or roll back one component"));
  const inner = h("div", { class: "disclosure__body" });

  inner.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "The one-click Update now above applies the whole release in the safe order (the engine first, canary-checked, then the console). These per-component controls are for when you deliberately need one component alone, applying a single component, or rolling one back, and the engine still enforces every guard (verify-before-deploy, forward-only, compatibility) per component. Most updates do not need this.",
    ),
  );

  // The one-shot token field for whichever per-component action is pressed. Read into a LOCAL at click
  // time, passed to the one call, never stored (the same custody as every deploy-token field here).
  const tokenField = field({
    id: "update-component-token",
    label: "One-shot deploy token",
    type: "password",
    placeholder: "Paste your Cloudflare API token",
    hint: "The same Cloudflare API token (\"Edit Cloudflare Workers\"). If your engine binds a Secrets Store secret as a backup source, add Secrets Store edit to the token as well: the template predates Secrets Store, and the upload-version step refuses without it. Used once for the action you press, then discarded; never stored, logged, or sent to the vendor.",
    doc: { href: "https://docs.downpipes.io/operations/update-channel-applying", anchor: "what-the-operator-does" },
    autocomplete: "off",
    validate: (v) => (v.length >= 1 ? null : "Paste the deploy token to run a per-component action."),
  });
  inner.appendChild(tokenField.el);

  const actions = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;margin-top:var(--space-3)" });
  const buttons: HTMLButtonElement[] = [];
  const setBusy = (busy: boolean): void => {
    for (const b of buttons) b.disabled = busy;
  };

  // withToken validates the field, reads the token into a local and runs the action with the buttons
  // disabled for the duration (one in-flight per-component action at a time; they share the one region).
  const withToken = (run: (token: string) => Promise<void>): void => {
    if (!validateForm([tokenField])) return;
    const token = tokenField.value();
    setBusy(true);
    void run(token).finally(() => setBusy(false));
  };

  // Per-component APPLY, only for components the release actually updates (an up-to-date component would be
  // a guaranteed no-update; §7a says no dead affordance). The console's expected version rides along so a
  // console apply gets its post-apply build check.
  for (const row of rows) {
    if (row.state !== "update" || (row.id !== "engine" && row.id !== "console")) continue;
    const id = row.id as UpdateComponentId;
    const applyBtn = h("button", { "data-dp": "licence.button.apply", class: "btn btn--secondary btn--sm", type: "button" }, `Update ${row.label.toLowerCase()} only`) as HTMLButtonElement;
    applyBtn.addEventListener("click", () =>
      withToken(async (token) => {
        const expected = id === "console" ? (updates.components?.console?.recommendedVersion ?? null) : null;
        await runLiveApplyFlow({ engine, out, reload, restoreFocus }, token, [id], expected);
      }),
    );
    buttons.push(applyBtn);
    actions.appendChild(applyBtn);
  }

  // Per-component ROLLBACK for the two deployable components. The engine is the authority on whether a
  // recorded target exists (it answers no-target honestly), so both render whenever the map names the
  // component. A confirm gate mirrors the standalone rollback control: with a token pasted, one click must
  // never fire a re-deploy. The ENGINE rollback goes through the SAME paired-rollback pre-flight the
  // standalone control uses (design s6: confirmEngineRollback, best-effort, never a blocker); the CONSOLE
  // rollback is UNCHANGED (design s6: console rollback alone is always the safe direction, no plan read).
  for (const id of ["engine", "console"] as const) {
    if (updates.components?.[id] === undefined) continue;
    const label = componentLabel(id);
    const rbBtn = h("button", { "data-dp": "licence.button.component-advanced-section", class: "btn btn--ghost btn--sm", type: "button" }, `Roll back ${label.toLowerCase()}`) as HTMLButtonElement;
    rbBtn.addEventListener("click", () => {
      if (!validateForm([tokenField])) return;
      void (async () => {
        const confirmOpts = {
          title: `Roll back the ${label.toLowerCase()}`,
          body: `Roll the ${label.toLowerCase()} back to its previous version? This re-deploys the prior ${label.toLowerCase()} code; your data and recovery are unaffected.`,
        };
        const okToRun =
          id === "engine"
            ? await confirmEngineRollback(engine, { ...confirmOpts, components: ["engine"] })
            : await confirmModal({ ...confirmOpts, confirmLabel: "Roll back", variant: "danger" });
        if (!okToRun) return;
        withToken((token) => rollbackComponent(engine, out, token, id, reload, restoreFocus));
      })();
    });
    buttons.push(rbBtn);
    actions.appendChild(rbBtn);
  }

  inner.appendChild(actions);
  details.appendChild(inner);
  return details;
}

// rollbackComponent runs one per-component rollback and renders the outcome into the shared region. The
// engine line keeps the canary wording (standaloneRollbackOutcomeLine); the console line speaks reload
// instead (consoleRollbackOutcomeLine). An engine revert re-renders the section (the running version
// changed); a console revert leaves the outcome + reload note standing.
async function rollbackComponent(engine: EngineClient, out: HTMLElement, token: string, id: UpdateComponentId, reload: () => void, restoreFocus: () => void): Promise<void> {
  const heading = h("p", { style: "color:var(--text)" }, `Rolling the ${componentLabel(id).toLowerCase()} back to its previous version…`);
  out.replaceChildren(heading);
  try {
    const res = await engine.rollbackUpdate(token, [id]);
    heading.textContent = id === "console" ? consoleRollbackOutcomeLine(res) : standaloneRollbackOutcomeLine(res);
    out.appendChild(renderUpdateSteps(res.steps));
    if (id === "engine" && (res.outcome === "reverted" || res.outcome === "reverted-unverified")) {
      toast({ message: `Rolled back to ${res.toVersion}.`, tone: "info" });
      reload();
      restoreFocus();
    }
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    out.replaceChildren(h("p", { class: "field__error", role: "alert" }, updateRefusalText(err)));
  }
}
