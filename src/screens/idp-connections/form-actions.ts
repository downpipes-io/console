// The Add and Test button wiring shared by the OIDC/OAuth2 preset form (./forms.ts) and the generic SAML 2.0
// form (./saml-form.ts). Both forms build a proposal and POST it the same way; the only differences are the
// button label, the success message and the error prefix, passed in as thunks. Split from ./forms.ts for
// size; behaviour, copy and markup are unchanged.
//
// House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { toast } from "../../components/toast.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { requireChange } from "../../components/require-change.ts";
import { isOwnerActionQueuedResult } from "../../api.ts";
import type { EngineClient, IdpPresetCreate, IdpSamlProposal } from "../../api.ts";
import { errText, capitalise } from "./shared.ts";
import { renderIdpTestResult } from "./forms-test-result.ts";

// The inputs wireFormActions needs to drive the Add and Test buttons of a connection form. `build` validates
// the form and returns the proposal (or null); the label / message thunks read the freshly entered values.
export interface FormActionWiring<P> {
  engine: EngineClient;
  submitBtn: HTMLButtonElement;
  testBtn: HTMLButtonElement;
  testResult: HTMLElement;
  submitError: HTMLElement;
  addLabel: string;
  build: () => P | null;
  queuedLabel: () => string;
  successMessage: () => string;
  addErrorText: (err: unknown) => string;
  reload: () => void;
}

// wireFormActions attaches the Add and Test click handlers shared by the preset and SAML forms: Add POSTs the
// proposal (honestly surfacing a dual-control queue, an engine refusal shown verbatim, then the success toast
// and reload), Test runs the READ-ONLY probe and renders its result. Both act on exactly what `build` returns.
export function wireFormActions<P extends IdpPresetCreate | IdpSamlProposal>(w: FormActionWiring<P>): void {
  const { engine, submitBtn, testBtn, testResult, submitError, addLabel, build, queuedLabel, successMessage, addErrorText, reload } = w;

  // THE CEREMONY, named before the button rather than discovered after it. Adding a connection changes who
  // can sign in, so the engine demands a fresh identity check and the browser opens a passkey prompt on Add.
  // Test is NOT gated (it is a read-only probe) and the sentence says Add for that reason. It is rendered
  // here rather than in each of the two forms that call this: both build their error slot immediately above
  // the button row, so anchoring to that slot puts one copy in the same place on both.
  submitError.insertAdjacentElement(
    "afterend",
    h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey when you press Add. If you dismiss that prompt, or it fails, no connection is added and what you have typed stays in this form."),
  );

  submitBtn.addEventListener("click", async () => {
    const payload = build();
    if (!payload) return;
    // Change management (owner opt-in): adding an identity-provider connection changes who can sign in, a
    // change-controlled action. Collect a change reference when the policy requires one (a no-op otherwise).
    const cr = await requireChange(engine, "Add an identity-provider connection", "idp-connection-upsert");
    if (!cr.proceed) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Adding";
    try {
      const res = await engine.createIdpConnection(payload, cr.change ?? undefined);
      // Dual control armed: the engine queued the new connection for a second owner instead of creating it.
      // Say so honestly (NOT "added"), and reset the button so the form is usable again.
      if (isOwnerActionQueuedResult(res)) {
        surfaceQueuedOwnerAction(queuedLabel());
        submitBtn.disabled = false;
        submitBtn.textContent = addLabel;
        return;
      }
      if (!res.value.ok) {
        submitError.textContent = capitalise(res.value.reason);
        submitError.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = addLabel;
        return;
      }
      toast({ message: successMessage() });
      reload();
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the connection was not added, so the form goes back to usable.
        submitBtn.disabled = false;
        submitBtn.textContent = addLabel;
        goSignedOut();
        return;
      }
      submitError.textContent = addErrorText(err);
      submitError.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = addLabel;
    }
  });

  testBtn.addEventListener("click", async () => {
    const payload = build();
    if (!payload) return;
    testBtn.disabled = true;
    testBtn.textContent = "Testing...";
    try {
      renderIdpTestResult(testResult, await engine.testIdpConnection(payload));
    } catch (err) {
      if (isUnauthorised(err)) { goSignedOut(); return; }
      testResult.replaceChildren(h("p", { class: "field__error", role: "alert" }, `Could not run the test (${errText(err)}).`));
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test connection";
    }
  });
}
