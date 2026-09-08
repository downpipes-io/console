// Enforcement sub-view of the Access and security area: it composes the three parts that
// make up the panel. The LIVE Cloudflare Zero Trust verifier (the F7 fix, reading the REAL
// whoami verdict, never a hardcoded green) lives in ./verifier.ts; the instructional Access
// setup wizard (the console configures nothing and captures no secret) lives in
// ./setup-wizard.ts; and the optional identity-provider setup guidance lives in
// ./idp-guidance.ts. The verdict leaves (deriveVerdict, reauthenticate) and the shared
// note/badge helpers live in ./shared.ts so this panel never imports a sibling panel. Split out of a single 760-line module (finding console-src-024-01); the
// public export (renderEnforcementPanel) is unchanged.

import { h } from "../../lib/dom.ts";
import type { EngineClient } from "../../api.ts";
import { renderVerifier } from "./verifier.ts";
import { renderSetupWizard } from "./setup-wizard.ts";
import { idpSetupGuidance } from "./idp-guidance.ts";

export function renderEnforcementPanel(engine: EngineClient): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-5)" });
  // The verifier owns the (re)verify action; the wizard's "Verify enforcement now"
  // hand-off calls the SAME reverify, so the two are wired directly rather than by
  // DOM-spelunking for a button.
  const verifier = renderVerifier(engine);
  wrap.appendChild(verifier.el);
  // The setup wizard is instructional content: it sits behind a collapsed
  // disclosure, the verifier verdict above is the eager
  // read. The content renders eagerly (static, no fetch) so focusWizard() can
  // open + focus it synchronously; the heading lives in the summary.
  wrap.appendChild(
    h(
      "details",
      { class: "disclosure", id: "access-wizard-disclosure" },
      h("summary", h("h2", { class: "disclosure__heading", id: "access-wizard-heading", tabindex: "-1" }, "Set up Cloudflare Access")),
      h("div", { class: "disclosure__body" }, renderSetupWizard(verifier.reverify)),
    ),
  );
  wrap.appendChild(idpSetupGuidance());
  return wrap;
}
