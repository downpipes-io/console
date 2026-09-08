// The instructional Access setup wizard for the enforcement sub-view (Owner-gated, no
// custody): the console configures nothing and captures no secret; the steps are performed
// in the Cloudflare dashboard, then the verifier confirms it took. Extracted verbatim from
// enforcement.ts (finding console-src-024-01). The hand-off button calls the verifier's own
// reverify directly rather than DOM-spelunking for a button.

import { recordFeatureProbe } from "../../lib/client-diag/ring.ts";
import { h, svgIcon, scrollToSafe } from "../../lib/dom.ts";
import { canDo, gateReason } from "../common.ts";
import { getEngineUrl } from "../../lib/store.ts";
import { codeBlock } from "../../components/code-block.ts";
import { field } from "../../components/field.ts";
import { ICON_EXTERNAL, ICON_SHIELD_CHECK, ICON_LOCK } from "../../lib/icons.ts";
import { accentBadge, noteLine } from "./shared.ts";
import { labelledCopy } from "./enforcement-leaf.ts";

export function renderSetupWizard(reverify: () => void): HTMLElement {
  // The wizard makes no privileged call; verification is the verifier's job, and the
  // hand-off below calls the verifier's reverify directly. The body is assembled from the
  // named section helpers below, appended in the same order they read on screen.
  const isOwner = canDo("owner");

  // The heading lives in the wrapping disclosure's summary (renderEnforcementPanel);
  // this body opens with the description and the Owner badge.
  const card = h("section", { "aria-labelledby": "access-wizard-heading" });

  card.appendChild(wizardHeader());
  if (!isOwner) card.appendChild(ownerGateNotice());
  card.appendChild(noSecretNote());
  card.appendChild(stepProtectHostnames());

  // Step 2 builds the AUD field; step 3 echoes its live value, so the field is shared
  // between the two steps and threaded through here rather than re-queried from the DOM.
  const audField = makeAudField();
  card.appendChild(stepSessionAndAud(audField));
  card.appendChild(stepEngineEnv(audField));
  card.appendChild(stepAttachPolicies());

  card.appendChild(verifyHandoff(reverify));
  card.appendChild(dashboardFootnote());

  return card;
}

function wizardHeader(): HTMLElement {
  const header = h("div", { class: "card__header" });
  const headText = h("div");
  headText.appendChild(h("p", { class: "card__desc" }, "These steps are performed in the Cloudflare dashboard, not here. The console shows exactly what to enter, then the verifier above confirms it took. No IdP, OAuth or Cloudflare secret is ever entered into this console."));
  header.appendChild(headText);
  header.appendChild(accentBadge("Owner only"));
  return header;
}

function ownerGateNotice(): HTMLElement {
  // Owner-gated entry point: render the gate honestly (the steps are read-only-visible
  // so a Viewer still understands the model; the actions stay Owner-only).
  return h(
    "div",
    { class: "card card--inset measure", style: "margin-top:var(--space-2)" },
    h("p", { style: "color:var(--text)" }, "The Access setup wizard is the governance entry point, so it is Owner only."),
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, gateReason("owner")),
  );
}

function noSecretNote(): HTMLElement {
  // The standing no-secret rule, restated where it matters (AS 1.2 step 5).
  return h(
    "div",
    { style: "margin-top:var(--space-4)" },
    noteLine(
      ICON_LOCK,
      "If a step asks for an IdP client secret, an OAuth secret, or a Cloudflare API token, enter it in Cloudflare, never here. The console links out; it does not capture.",
    ),
  );
}

function stepProtectHostnames(): HTMLElement {
  // No decorative step rail: the numbered wizardStep cards carry the sequence. (The old
  // rail was hardcoded to "step 1 current, verify blocked", which contradicted the live
  // verifier and the enabled hand-off button beneath it.)
  // Step 1: protect BOTH hostnames, read live so they are correct, not placeholders.
  const consoleHost = location.host;
  const engineHost = engineHostFromUrl(getEngineUrl());
  return wizardStep(
    "1",
    "Protect both hostnames",
    "Put a Cloudflare Access application in front of both your console and your engine. Protecting only the console leaves the engine admin API reachable directly.",
    [
      labelledCopy("Console hostname", consoleHost),
      labelledCopy("Engine hostname", engineHost ?? "engine.<your-domain>"),
    ],
  );
}

function makeAudField(): ReturnType<typeof field> {
  // The AUD tag is an identifier, not a secret, so capturing it for echo is within the
  // no-custody boundary.
  return field({
    id: "access-aud",
    label: "Application AUD tag",
    value: "",
    placeholder: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    hint: "The Application Audience (AUD) tag is a 64-character hex identifier, not a secret, so the console keeps it only to show the exact value to set on your engine.",
    doc: { href: "https://docs.downpipes.io/operations/identity-and-access", anchor: "cloudflare-access-is-optional-and-added-for-attributability" },
    autocomplete: "off",
  });
}

function stepSessionAndAud(audField: ReturnType<typeof field>): HTMLElement {
  // Step 2: recommend a short session and capture the AUD tag.
  const sessionField = field({
    id: "access-session",
    label: "Recommended session duration",
    kind: "select",
    value: "24h",
    hint: "Set this on the Access application in Cloudflare. A shorter session is stronger; 24 hours is a sensible balance for most teams, which is why it is the default here.",
    doc: { href: "https://docs.downpipes.io/operations/identity-and-access", anchor: "cloudflare-access-is-optional-and-added-for-attributability" },
    options: [
      { value: "24h", label: "24 hours (recommended)" },
      { value: "8h", label: "8 hours" },
      { value: "1h", label: "1 hour (strongest, more re-auth)" },
    ],
  });
  return wizardStep(
    "2",
    "Session duration and the AUD tag",
    "Set a short Access session for the application, then paste back the AUD tag you generate so the console can render the exact engine value.",
    [sessionField.el, audField.el],
  );
}

function stepEngineEnv(audField: ReturnType<typeof field>): HTMLElement {
  // Step 3: the engine env block. The AUD field, once filled, is echoed into the copy
  // block via textContent so it renders literally; nothing is ever submitted.
  const envPre = codeBlock(envCommands(audField.value()));
  const envHost = h("div", envPre);
  audField.control.addEventListener("input", () => {
    envHost.replaceChildren(codeBlock(envCommands(audField.value())));
  });
  return wizardStep(
    "3",
    "Set the engine env to match",
    "Set these on your engine as wrangler.toml vars, then redeploy. Until both are set, the engine cannot verify Access and falls back to the shared token.",
    [envHost],
  );
}

function stepAttachPolicies(): HTMLElement {
  // Step 4: the policies to attach in Cloudflare, each a link out, each explicitly an
  // Access policy the operator sets there, not a console setting.
  return wizardStep(
    "4",
    "Attach the policies in the Access application",
    "These are Access policies you set in Cloudflare, not console settings. Enforcement is proven by the verifier above.",
    [
      policyList([
        { title: "Require an identity provider (SSO)", desc: "Adding your IdP (Okta, Entra ID, Google Workspace, SAML or OIDC) is how SSO is enforced." },
        { title: "Require MFA", desc: "An Access policy condition. The console can later confirm a verified session exists, not which factor was used." },
        { title: "IP allowlist or device posture (optional, recommended)", desc: "Edge-enforced Access rules." },
      ]),
    ],
  );
}

function verifyHandoff(reverify: () => void): HTMLElement {
  // Hand off to verification: the wizard never declares success; the verdict does. The
  // hand-off scrolls to the verifier and re-runs the SAME probe the verifier owns (no
  // DOM-spelunking). It is ungated for every role: the probe is read-only and the verifier's
  // own Re-verify button is ungated, so gating the same action here was inconsistent.
  const button = h("button", { "data-dp": "access-security.button.reverify", class: "btn btn--primary", type: "button" }, svgIcon(ICON_SHIELD_CHECK, { size: 16 }), "Verify enforcement now") as HTMLButtonElement;
  button.addEventListener("click", () => {
    const verdict = document.querySelector('[aria-label="Access enforcement verdict"]');
    if (verdict) scrollToSafe(verdict, { behavior: "smooth", block: "start" });
    reverify();
  });
  return h("div", { style: "margin-top:var(--space-4);display:flex;justify-content:flex-end" }, button);
}

function dashboardFootnote(): HTMLElement {
  return h(
    "p",
    { class: "field__hint", style: "margin-top:var(--space-3);display:flex;gap:var(--space-2);align-items:flex-start" },
    h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_EXTERNAL, { size: 14 })),
    h("span", "Configure these in your Cloudflare Zero Trust dashboard. The console configures nothing on your behalf."),
  );
}

function wizardStep(num: string, title: string, desc: string, body: Node[]): HTMLElement {
  const sec = h("section", { class: "card card--inset", style: "margin-top:var(--space-4)" });
  const head = h("div", { style: "display:flex;gap:var(--space-3);align-items:baseline;margin-bottom:var(--space-2)" });
  head.appendChild(h("span", { class: "section-label" }, `Step ${num}`));
  head.appendChild(h("h3", { style: "font-size:var(--text-md)" }, title));
  sec.appendChild(head);
  sec.appendChild(h("p", { class: "field__hint measure", style: "margin-bottom:var(--space-3)" }, desc));
  // minmax(0,1fr), not the implicit auto track: a step body holds a code block whose <pre> is white-space:pre,
  // so its min-content is the longest line. An auto track floors at that, the wrapper div around the block is
  // a grid item at min-width:auto and cannot shrink below it, and the .code overflow-x:auto scroller never
  // engages because the pre is already as wide as its content. For example, a wrangler snippet can run
  // 457px past the card at 390 and give the whole document a horizontal scrollbar
  // (793px against a 390px viewport). Zeroing the track's floor lets the block scroll inside its own frame,
  // which is what §20's "tables + code scroll inside their frame, never widen the page" intends.
  const stack = h("div", { style: "display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-3)" });
  for (const node of body) stack.appendChild(node);
  sec.appendChild(stack);
  return sec;
}

function policyList(items: Array<{ title: string; desc: string }>): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-2)" });
  // A plain bulleted list (.idp-list, the shared calm-bullet class): these are reference items to
  // attach in Cloudflare, so hollow status dots here read as tickable radios, which they are not.
  const list = h("ul", { class: "idp-list", style: "gap:var(--space-2)" });
  for (const item of items) {
    const li = h("li");
    li.appendChild(h("b", { style: "display:block" }, item.title));
    li.appendChild(h("small", { style: "color:var(--text-muted)" }, item.desc));
    list.appendChild(li);
  }
  wrap.appendChild(list);
  // One link for one job: every policy is attached in the same Cloudflare Zero Trust dashboard,
  // so three identical per-row buttons collapse to a single link below the list.
  wrap.appendChild(
    h(
      "div",
      h(
        "a",
        { class: "btn btn--secondary btn--sm", href: "https://one.dash.cloudflare.com", target: "_blank", rel: "noopener noreferrer" },
        "Open Cloudflare Zero Trust",
        svgIcon(ICON_EXTERNAL, { size: 14 }),
      ),
    ),
  );
  return wrap;
}

function envCommands(aud: string): string {
  const audValue = aud ? aud : "<paste your AUD tag from step 2>";
  return `# In the engine wrangler.toml [vars] (identifiers, not key material), then redeploy:\n[vars]\nCF_ACCESS_TEAM_DOMAIN = "<your-team>.cloudflareaccess.com"\nCF_ACCESS_AUD         = "${audValue}"\n# (wrangler secret put also works; these are not secrets.)`;
}

function engineHostFromUrl(url: string | null): string | null {
  if (!url) return null; // no engine address stored yet: the ordinary pre-setup state, not a fault.
  try {
    return new URL(url).host;
  } catch {
    // The stored engine address WILL NOT PARSE, and the wizard silently shows no host, so the operator is
    // looking at a setup screen that is quietly not going to work and is given no reason. No engine client is
    // constructed from an unparseable address, so no call is ever attempted, and every other diagnostic in the
    // ring is silent BY CONSTRUCTION: the most broken console possible would otherwise produce the emptiest pack,
    // and support would read that emptiness as health. The URL itself is never recorded (it is a customer
    // hostname, and a malformed one can hold anything the operator pasted): only the class rides.
    recordFeatureProbe("engine-url", "engine-url-unparseable");
    return null;
  }
}
