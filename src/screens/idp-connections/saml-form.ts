// The generic SAML 2.0 connection form of the external-identity-providers add-connection flow. SAML has many
// more fields than OIDC, so they all live here UNDER the SAML choice (the picker in ./forms.ts renders this
// only once "Generic SAML" is picked). Split into a fields builder, the email-trust policy picker and the
// form shell; the Add/Test wiring is shared with the preset form (./form-actions.ts) and the inline guidance
// lives in ./guide-panels.ts. Moved verbatim from ./forms.ts for size; behaviour, copy and markup are
// unchanged.
//
// House rules: Australian English, no em dashes, precise claims.

import { type Field, field, validateForm } from "../../components/field.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_ALERT, ICON_PLUS } from "../../lib/icons.ts";
import { collapsedSection } from "../common.ts";

// THE ENGINE'S OWN LENGTH BOUNDS, mirrored so the console refuses what the engine would refuse.
//
// engine/src/admin/idpconn-validators.ts declares LABEL_MAX 128, REF_MAX 256 and CLAIM_NAME_MAX 128, applied
// to the SAML proposal at idpconn.ts:61 (label) and in validateSaml (idpEntityId, spEntityId, emailAttr,
// groupsAttr). Until five fields on this form enforced no upper bound at all: the three required
// ones validated only `v.length >= 1`, and the two optional attribute fields had no validate whatsoever.
//
// The two attribute fields were the ones that mattered, and they failed WORSE than a late error. boundedStr
// returns null when a value is over-long, and validateSaml then does `if (emailAttr) conn.emailAttr = ...`,
// so an over-long attribute name is SILENTLY DROPPED rather than refused: the connection is created without
// it, and a blank email attribute means no email is read at all, so sign-in becomes subject-only and no
// invite auto-binds by email. The operator typed a value, the form accepted it, and the behaviour they
// configured quietly did not happen.
//
// The three required fields diverged less badly (the engine returns an explicit reason, so the operator sees
// a submit-time error rather than an inline one) but they diverged all the same.
//
// The sibling `saml-id` on this very form has always enforced its 1..64 bound in its own validate, so
// this was an inconsistency within one file rather than a missing capability.
const LABEL_MAX = 128;
const REF_MAX = 256;
const CLAIM_NAME_MAX = 128;

import type { EngineClient, IdpSamlProposal } from "../../api.ts";
import { recordInputDropped } from "../../lib/client-diag/ring.ts";
import { wireFormActions } from "./form-actions.ts";
import { samlGuidePanel } from "./guide-panels.ts";
import { connIdError, errText, pemBlocksIntended, splitPems, type TakenConnIds } from "./shared.ts";

// The default SAML assertion clock-skew tolerance sent with a new connection proposal: 2 minutes, a
// conservative default well below the engine's 10-minute (CLOCK_SKEW_MAX) ceiling.
const SAML_DEFAULT_CLOCK_SKEW_SEC = 120;

// The handles samlFields returns so the submit-wiring can compose the proposal from what the operator entered.
interface SamlFieldHandles {
  fields: Field[];
  labelField: Field;
  idField: Field;
  idpEntityField: Field;
  idpSsoField: Field;
  spEntityField: Field;
  nameIdField: Field;
  certField: Field;
  emailAttrField: Field;
  groupsAttrField: Field;
  policyField: Field;
}

// samlFields builds and mounts the SAML form fields: identity, the IdP entity id / SSO URL / SP entity id /
// NameID format, the signing-cert PASTE box, the optional attribute overrides behind a quiet disclosure, and
// the email-trust policy picker (with a clear WARNING rendered when trust-idp is chosen).
function samlFields(engine: EngineClient, wrap: HTMLElement, taken?: TakenConnIds): SamlFieldHandles {
  // The "How to add a SAML provider" guide, with the LIVE ACS URL bound to the connection id below.
  const guidePanelHandle = samlGuidePanel(engine);
  wrap.appendChild(guidePanelHandle.el);

  const fields: Field[] = [];

  const labelField = field({ id: "saml-label", label: "Display name", value: "SAML", required: true, placeholder: "Okta", hint: "Shown on the sign-in button and in this list.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml" }, validate: (v) => (v.length === 0 ? "A display name is required." : v.length > LABEL_MAX ? `Use at most ${LABEL_MAX} characters.` : null) });
  const idField = field({ id: "saml-id", label: "Connection id", value: "saml", required: true, autocomplete: "off", placeholder: "okta-saml", hint: "A short slug: lowercase letters, numbers and internal hyphens, starting and ending with a letter or number. The ACS URL above uses it.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml" }, onInput: (v) => guidePanelHandle.setConnId(v), validate: (v) => connIdError(v, taken) });
  fields.push(labelField, idField);
  wrap.appendChild(h("div", { class: "idp-form-grid" }, labelField.el, idField.el));

  const idpEntityField = field({ id: "saml-idp-entity", label: "IdP entity id", required: true, autocomplete: "off", placeholder: "https://idp.example.com/metadata", hint: "The Identity Provider's EntityID (issuer), exactly as your IdP publishes it.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "where-the-three-connection-values-come-from" }, validate: (v) => (v.length === 0 ? "The IdP entity id is required." : v.length > REF_MAX ? `Use at most ${REF_MAX} characters.` : null) });
  const idpSsoField = field({ id: "saml-idp-sso", label: "IdP SSO URL", type: "url", required: true, autocomplete: "off", placeholder: "https://idp.example.com/sso", hint: "The IdP's HTTP-Redirect SSO endpoint (https). The browser is sent here to sign in.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "where-the-three-connection-values-come-from" }, validate: (v) => (/^https:\/\/.+/.test(v) ? null : "Enter an https URL.") });
  fields.push(idpEntityField, idpSsoField);
  wrap.appendChild(h("div", { class: "idp-form-grid" }, idpEntityField.el, idpSsoField.el));

  const spEntityField = field({ id: "saml-sp-entity", label: "SP entity id", required: true, autocomplete: "off", placeholder: "https://your-console.example.com/saml", hint: "An identifier you choose for downpipes (not fetched from anywhere). Use a stable URL; it goes in the SP metadata, and every assertion must name it as an audience. Set the same value at your IdP.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "where-the-three-connection-values-come-from" }, validate: (v) => (v.length === 0 ? "The SP entity id is required." : v.length > REF_MAX ? `Use at most ${REF_MAX} characters.` : null) });
  fields.push(spEntityField);

  const nameIdField = field({
    id: "saml-nameid",
    label: "NameID format",
    kind: "select",
    value: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    hint: "How the IdP identifies the user, pinned: the assertion's NameID Format must match this exactly or it is rejected. Transient is not accepted (a fresh per-login pseudonym is not stable enough to key access).",
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "which-nameid-format-to-choose" },
    options: [
      { value: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", label: "emailAddress" },
      { value: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", label: "persistent" },
      { value: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified", label: "unspecified" },
    ],
  });
  wrap.appendChild(h("div", { class: "idp-form-grid" }, spEntityField.el, nameIdField.el));

  // The signing cert PASTE box: one or more PEM certificates (the public X.509 certs the IdP signs
  // assertions with). Multiple certs (overlapping rollover) are pasted one after another; they are split
  // on the PEM boundary at submit.
  const certField = field({
    id: "saml-certs",
    label: "IdP signing certificate(s) (PEM)",
    kind: "textarea",
    required: true,
    placeholder: "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
    hint: "Paste the IdP's public signing certificate(s) in PEM form. Paste several (one after another, up to eight) if your IdP rotates certificates: pinning the next one ahead of a rotation is the calmest path, and a connection that is already live can be rolled over from its card without signing anyone out.",
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "rotating-the-signing-certificate" },
    validate: (v) => (v.includes("BEGIN CERTIFICATE") ? null : "Paste at least one PEM certificate (it begins with -----BEGIN CERTIFICATE-----)."),
  });
  fields.push(certField);
  wrap.appendChild(certField.el);

  // Optional attribute overrides (email / groups) behind a quiet disclosure, most IdPs do not need them,
  // so they are not dumped eagerly.
  const emailAttrField = field({ id: "saml-email-attr", label: "Email attribute (optional)", autocomplete: "off", placeholder: "e.g. email or http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", hint: "The assertion attribute carrying the email. Leave it blank and no email is read at all (it does NOT fall back to the NameID), so sign-in is subject-only and no invite auto-binds by email.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "email-binding-the-email-attribute-and-the-trust-policy" }, validate: (v) => (v.length > CLAIM_NAME_MAX ? `Use at most ${CLAIM_NAME_MAX} characters.` : null) });
  const groupsAttrField = field({ id: "saml-groups-attr", label: "Groups attribute (optional)", autocomplete: "off", placeholder: "e.g. groups or memberOf", hint: "The assertion attribute carrying group membership (for group-to-role mapping).", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "the-groups-attribute-names-where-groups-live" }, validate: (v) => (v.length > CLAIM_NAME_MAX ? `Use at most ${CLAIM_NAME_MAX} characters.` : null) });
  wrap.appendChild(collapsedSection("Attribute mapping (optional)", h("div", { class: "idp-form-grid" }, emailAttrField.el, groupsAttrField.el)));

  const policyField = samlPolicyPicker(wrap);

  return { fields, labelField, idField, idpEntityField, idpSsoField, spEntityField, nameIdField, certField, emailAttrField, groupsAttrField, policyField };
}

// samlPolicyPicker builds and mounts the email-trust policy picker (default require-flag) plus its WARNING.
// A clear WARNING renders when trust-idp is chosen: it trusts any well-formed email the assertion carries, so
// an IdP that does not assert a verified-email flag still binds, an explicit, audited owner choice. Returns
// the policy field so the proposal can read its value.
function samlPolicyPicker(wrap: HTMLElement): Field {
  const policyField = field({
    id: "saml-email-policy",
    label: "Email trust",
    kind: "select",
    value: "require-flag",
    hint: "How an email from the assertion is trusted for binding to an invited person. The default require-flag never trusts an email from a console-built connection (there is no field for the verified-flag it checks), so sign-in stays subject-only.",
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "email-binding-the-email-attribute-and-the-trust-policy" },
    options: [
      { value: "require-flag", label: "require-flag (only trust an email the IdP marks verified), recommended" },
      { value: "trust-idp", label: "trust-idp (trust any well-formed email the assertion carries)" },
    ],
  });
  const policyWarn = h("div", { hidden: true, style: "margin-top:var(--space-2)" });
  const reflectPolicy = (): void => {
    if (policyField.value() === "trust-idp") {
      policyWarn.hidden = false;
      policyWarn.replaceChildren(
        h("div", { class: "note-quiet measure", style: "border-left:3px solid var(--warn-fg);padding-left:var(--space-3)" },
          h("span", { style: "display:flex;gap:var(--space-2);align-items:flex-start" },
            h("span", { style: "flex:none;margin-top:1px;color:var(--warn-fg)" }, svgIcon(ICON_ALERT, { size: 16 })),
            h("span", h("b", "trust-idp trusts any email the assertion carries."), " Choose this only if your IdP does not assert a verified-email flag and you trust it to send correct addresses. An untrusted email otherwise resolves to a subject-only sign-in (never a wrong bind). This choice is recorded in the audit log."),
          ),
        ),
      );
    } else {
      policyWarn.hidden = true;
      policyWarn.replaceChildren();
    }
  };
  (policyField.control as HTMLSelectElement).addEventListener("change", reflectPolicy);
  wrap.appendChild(policyField.el);
  wrap.appendChild(policyWarn);
  return policyField;
}

// samlForm renders the generic SAML 2.0 connection form. SAML has many more fields than OIDC, so they all
// live here UNDER the SAML choice (progressive disclosure: this form only renders once "Generic SAML" is
// picked). It collects the IdP entity id / SSO URL / SP entity id / NameID format, a PASTE box for the IdP
// signing cert PEM(s), and an email-verified-policy picker (default require-flag; a clear WARNING when
// trust-idp is chosen). On submit it composes the { proposal } and POSTs it; validateSaml's reason is
// shown verbatim. After creation the card's SAML handoff (download SP metadata + ACS URL) is how the
// customer finishes at their IdP.
export function samlForm(engine: EngineClient, reload: () => void, taken?: TakenConnIds): HTMLElement {
  const wrap = h("section", { class: "card card--inset", style: "display:grid;gap:var(--space-5);max-width:48rem", "aria-label": "Add a SAML 2.0 provider" });
  wrap.appendChild(h("h3", { style: "font-size:var(--text-base);margin:0" }, "Add a SAML 2.0 provider"));

  const handles = samlFields(engine, wrap, taken);
  const { fields, labelField, idField, idpEntityField, idpSsoField, spEntityField, nameIdField, certField, emailAttrField, groupsAttrField, policyField } = handles;

  const submitError = h("p", { class: "field__error", role: "alert", hidden: true });
  wrap.appendChild(submitError);
  const submitBtn = h("button", { "data-dp": "idp-connections.button.submit#2", class: "btn btn--primary", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Add SAML provider") as HTMLButtonElement;
  const testBtn = h("button", { "data-busy-label": "Testing...", "data-dp": "idp-connections.button.test#2", class: "btn btn--secondary", type: "button" }, "Test connection") as HTMLButtonElement;
  const testResult = h("div");
  wrap.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" }, submitBtn, testBtn));
  wrap.appendChild(testResult);

  // buildProposal validates the form (showing inline field errors) and composes the { proposal }, or null
  // when the form is invalid. Shared by Add and Test so both act on exactly the values the operator entered.
  const buildProposal = (): IdpSamlProposal | null => {
    submitError.hidden = true;
    if (!validateForm(fields)) return null;
    const certs = splitPems(certField.value());
    // The paste lost part of itself. The operator pasted BOTH rollover certificates, an editor mangled one,
    // splitPems dropped it without a word, and the submission is smaller than the paste. Neither the console nor
    // the engine ever saw the dropped block, so the only possible witness is here, at the moment it is dropped.
    // COUNTS ONLY: the certificate bodies never ride, and the accepted count is recorded beside the dropped one
    // so "one of two was dropped" and "one of nine" are not the same evidence.
    const intended = pemBlocksIntended(certField.value());
    recordInputDropped("idp-cert-paste", certs.length, Math.max(0, intended - certs.length));
    if (certs.length === 0) {
      // The paste carried a BEGIN CERTIFICATE line (so the field validator passed) and splitPems found no
      // complete block in it. A console refusal the operator is stuck behind, and it recorded nothing.
      certField.refuse("Paste at least one PEM certificate.");
      certField.focus();
      return null;
    }
    const emailAttr = emailAttrField.value();
    const groupsAttr = groupsAttrField.value();
    return {
      id: idField.value(),
      kind: "saml",
      label: labelField.value(),
      presetId: "generic-saml",
      enabled: true,
      idpEntityId: idpEntityField.value(),
      idpSsoUrl: idpSsoField.value(),
      idpSigningCerts: certs,
      spEntityId: spEntityField.value(),
      nameIdFormat: nameIdField.value(),
      wantAssertionsSigned: true,
      allowIdpInitiated: false,
      clockSkewSec: SAML_DEFAULT_CLOCK_SKEW_SEC,
      emailVerifiedPolicy: policyField.value() === "trust-idp" ? "trust-idp" : "require-flag",
      ...(emailAttr !== "" ? { emailAttr } : {}),
      ...(groupsAttr !== "" ? { groupsAttr } : {}),
    };
  };

  wireFormActions({
    engine,
    submitBtn,
    testBtn,
    testResult,
    submitError,
    addLabel: "Add SAML provider",
    build: buildProposal,
    queuedLabel: () => `Adding ${labelField.value()}`,
    // The connection is created already enabled (there is no separate activation step), so the toast must say
    // so rather than imply one remains; wording matches the enable-toggle's own accurate copy (list.ts).
    successMessage: () => `${labelField.value()} added and enabled. Download its SP metadata from the card and give it to your IdP. The sign-in button appears for everyone now. Disable it below if you are not ready to go live.`,
    addErrorText: (err) => `Could not add the SAML connection (${errText(err)}).`,
    reload,
  });

  return wrap;
}
