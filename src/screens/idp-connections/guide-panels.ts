// The inline "How to add <provider>" guidance (content authored in ../idp-guides.ts) for the add-connection
// flow: the small layout leaves (numbered steps, bullet lists, labelled sub-blocks, the copyable redirect/ACS
// callout, the wide-field heuristic) and the two composed guide panels (OIDC/OAuth2 and generic SAML 2.0).
// Each panel returns its element plus a setConnId(id) the form calls from the connection-id field so the LIVE
// callback/ACS URL stays in sync with what the engine will register. Split from ./forms.ts for size;
// behaviour, copy and markup are unchanged.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { copyButton } from "../../components/code-block.ts";
import { ICON_EXTERNAL, ICON_INFO } from "../../lib/icons.ts";
import type { EngineClient, IdpPreset, IdpPresetVar } from "../../api.ts";
import { SAML_GUIDE, type IdpGuide } from "../idp-guides.ts";

// numberedSteps renders the ordered "how to" steps as numbered chips (.idp-steps in tokens.css).
export function numberedSteps(steps: string[]): HTMLElement {
  const ol = h("ol", { class: "idp-steps" });
  for (const s of steps) ol.appendChild(h("li", s));
  return ol;
}

// bulletList renders a calm dotted list (.idp-list) for a guide's sub-points (groups how-to, gotchas).
export function bulletList(items: string[]): HTMLElement {
  const ul = h("ul", { class: "idp-list" });
  for (const it of items) ul.appendChild(h("li", it));
  return ul;
}

// guideSection is a labelled sub-block inside a guide (a quiet heading over its body).
export function guideSection(heading: string, body: HTMLElement): HTMLElement {
  return h("div", { class: "idp-guide__section" }, h("p", { class: "idp-guide__sub" }, heading), body);
}

// redirectCallout is the dashed, copyable highlight carrying the LIVE redirect/ACS URL the customer pastes
// into their IdP. `label` names the provider's own field; `valueEl` is updated as the connection id is typed;
// `copy` returns the current URL for the copy button.
export function redirectCallout(label: string, valueEl: HTMLElement, copy: () => string): HTMLElement {
  return h(
    "div",
    { class: "idp-redirect" },
    h("span", { class: "idp-redirect__label" }, label),
    h("div", { class: "idp-redirect__row" }, valueEl, copyButton("Copy URL", copy)),
  );
}

// isWideVar: a required var whose value is a URL takes the full grid width (a long issuer / endpoint reads
// badly squeezed into half); a short scalar (tenant id, domain, realm, host) stays half-width so the columns
// line up cleanly.
export function isWideVar(v: IdpPresetVar): boolean {
  return (typeof v.example === "string" && /^https?:\/\//.test(v.example)) || /\burl\b/i.test(v.label);
}

// oidcGuidePanel builds the inline "How to add <provider>" guide for an OIDC/OAuth2 preset: the numbered
// steps, the LIVE callback-URL callout (the value follows the connection id, so it is always exactly what the
// engine will register), the groups/roles how-to, the gotchas, and the official docs link. It returns the
// element plus a setConnId(id) the form calls from the connection-id field so the shown URL stays in sync.
export function oidcGuidePanel(engine: EngineClient, preset: IdpPreset, guide: IdpGuide): { el: HTMLElement; setConnId: (id: string) => void } {
  const valueEl = h("span", { class: "idp-redirect__value mono" });
  let connId = preset.id;
  const setConnId = (id: string): void => {
    connId = (id ?? "").trim() || preset.id;
    const u = engine.idpRedirectUri(connId);
    valueEl.textContent = u;
    valueEl.title = u;
  };
  const el = h(
    "div",
    { class: "idp-guide" },
    h("p", { class: "idp-guide__title" }, svgIcon(ICON_INFO, { size: 15 }), `How to add ${preset.label}`),
    numberedSteps(guide.steps),
    redirectCallout(`In ${preset.vendor}, paste this into "${guide.redirectFieldName}":`, valueEl, () => engine.idpRedirectUri(connId)),
    guide.groups ? guideSection(guide.groups.heading, bulletList(guide.groups.items)) : false,
    guide.gotchas && guide.gotchas.length > 0 ? guideSection("Watch out for", bulletList(guide.gotchas)) : false,
    guide.docsUrl
      ? h("a", { class: "linklike", href: guide.docsUrl, target: "_blank", rel: "noreferrer noopener", style: "display:inline-flex;gap:var(--space-1);align-items:center" }, `${preset.vendor} setup docs`, svgIcon(ICON_EXTERNAL, { size: 13 }))
      : false,
  );
  setConnId(preset.id);
  return { el, setConnId };
}

// samlGuidePanel builds the inline "How to add a SAML 2.0 provider" guide: the steps, the LIVE ACS-URL
// callout (the value the customer points their IdP at, following the connection id), and the gotchas.
// Returns the element plus setConnId(id) the form calls from the connection-id field so the ACS URL stays
// in sync with what the engine will serve.
export function samlGuidePanel(engine: EngineClient): { el: HTMLElement; setConnId: (id: string) => void } {
  const valueEl = h("span", { class: "idp-redirect__value mono" });
  let connId = "saml";
  const setConnId = (id: string): void => {
    connId = (id ?? "").trim() || "saml";
    const u = engine.samlAcsUrl(connId);
    valueEl.textContent = u;
    valueEl.title = u;
  };
  const el = h(
    "div",
    { class: "idp-guide" },
    h("p", { class: "idp-guide__title" }, svgIcon(ICON_INFO, { size: 15 }), "How to add a SAML 2.0 provider"),
    numberedSteps(SAML_GUIDE.steps),
    redirectCallout(`Set your IdP's "${SAML_GUIDE.acsFieldName}" to:`, valueEl, () => engine.samlAcsUrl(connId)),
    SAML_GUIDE.gotchas && SAML_GUIDE.gotchas.length > 0 ? guideSection("Watch out for", bulletList(SAML_GUIDE.gotchas)) : false,
  );
  setConnId("saml");
  return { el, setConnId };
}
