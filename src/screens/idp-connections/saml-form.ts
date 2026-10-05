// The generic SAML 2.0 connection form of the external-identity-providers add-connection flow. SAML has many
// more fields than OIDC, so they all live here UNDER the SAML choice (the picker in ./forms.ts renders this
// only once "Generic SAML" is picked). Split into a fields builder, the email-trust policy picker and the
// form shell; the Add/Test wiring is shared with the preset form (./form-actions.ts) and the inline guidance
// lives in ./guide-panels.ts.

import { type Field, field, validateForm } from "../../components/field.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_PLUS } from "../../lib/icons.ts";
import { collapsedSection } from "../common.ts";

// THE ENGINE'S OWN LENGTH BOUNDS, mirrored so the console refuses what the engine would refuse.
//
// engine/src/admin/idpconn-validators.ts declares LABEL_MAX 128, REF_MAX 256 and CLAIM_NAME_MAX 128, applied
// to the SAML proposal at idpconn.ts:61 (label) and in validateSaml (idpEntityId, spEntityId, emailAttr,
// groupsAttr).
//
// The two optional attribute fields matter most here. boundedStr returns null when a value is over-long, and
// validateSaml then does `if (emailAttr) conn.emailAttr = ...`, so an over-long attribute name is SILENTLY
// DROPPED rather than refused: the connection would be created without it, and a blank email attribute means
// no email is read at all, so every SAML sign-in on that connection is refused. Enforcing CLAIM_NAME_MAX
// here refuses the value in the form instead of letting it vanish after submit.
//
// The three required fields (label, idpEntityId, spEntityId) enforce the matching bound so the console's
// inline error and the engine's own refusal agree, the same way the sibling `saml-id` field on this form
// enforces its 1..64 bound in its own validate.
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
  emailVerifiedAttrField: Field;
}

// samlFields builds and mounts the SAML form fields: identity, the IdP entity id / SSO URL / SP entity id /
// NameID format, the signing-cert PASTE box, the optional attribute overrides behind a quiet disclosure, and
// the email-trust policy picker (with a note that says which roles an emailed invite can receive).
function samlFields(engine: EngineClient, wrap: HTMLElement, taken?: TakenConnIds): SamlFieldHandles {
  // The "How to add a SAML provider" guide, with the LIVE ACS URL bound to the connection id below.
  const guidePanelHandle = samlGuidePanel(engine);
  wrap.appendChild(guidePanelHandle.el);

  const fields: Field[] = [];

  const labelField = field({ id: "saml-label", label: "Display name", value: "SAML", required: true, placeholder: "Okta", hint: "Shown on the sign-in button and in this list.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml" }, validate: (v) => (v.length === 0 ? "A display name is required." : v.length > LABEL_MAX ? `Use at most ${LABEL_MAX} characters.` : null) });
  const idField = field({ id: "saml-id", label: "Connection id", value: "saml", required: true, autocomplete: "off", placeholder: "okta-saml", hint: "Lowercase letters, numbers and hyphens; must start and end with a letter or number. The ACS URL above uses it.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml" }, onInput: (v) => guidePanelHandle.setConnId(v), validate: (v) => connIdError(v, taken) });
  fields.push(labelField, idField);
  wrap.appendChild(h("div", { class: "idp-form-grid" }, labelField.el, idField.el));

  const idpEntityField = field({ id: "saml-idp-entity", label: "IdP entity id", required: true, autocomplete: "off", placeholder: "https://idp.example.com/metadata", hint: "The Identity Provider's EntityID (issuer), exactly as your IdP publishes it.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "where-the-three-connection-values-come-from" }, validate: (v) => (v.length === 0 ? "The IdP entity id is required." : v.length > REF_MAX ? `Use at most ${REF_MAX} characters.` : null) });
  const idpSsoField = field({ id: "saml-idp-sso", label: "IdP SSO URL", type: "url", required: true, autocomplete: "off", placeholder: "https://idp.example.com/sso", hint: "The IdP's HTTP-Redirect SSO endpoint (https). The browser is sent here to sign in.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "where-the-three-connection-values-come-from" }, validate: (v) => (/^https:\/\/.+/.test(v) ? null : "Enter an https URL.") });
  fields.push(idpEntityField, idpSsoField);
  wrap.appendChild(h("div", { class: "idp-form-grid" }, idpEntityField.el, idpSsoField.el));

  const spEntityField = field({ id: "saml-sp-entity", label: "SP entity id", required: true, autocomplete: "off", placeholder: "https://your-console.example.com/saml", hint: "An identifier you choose, not fetched. Use a stable URL: it goes in the SP metadata, and every assertion must name it as the audience.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "where-the-three-connection-values-come-from" }, validate: (v) => (v.length === 0 ? "The SP entity id is required." : v.length > REF_MAX ? `Use at most ${REF_MAX} characters.` : null) });
  fields.push(spEntityField);

  const nameIdField = field({
    id: "saml-nameid",
    label: "NameID format",
    kind: "select",
    value: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    hint: "Identifies the user, pinned: the assertion's NameID Format must match this exactly or it is rejected. Transient is not accepted.",
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
    hint: "Paste the IdP's signing certificate(s) in PEM form. If your IdP rotates, paste several, one after another (up to eight).",
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "rotating-the-signing-certificate" },
    validate: (v) => (v.includes("BEGIN CERTIFICATE") ? null : "Paste at least one PEM certificate (it begins with -----BEGIN CERTIFICATE-----)."),
  });
  fields.push(certField);
  wrap.appendChild(certField.el);

  // Optional attribute overrides (email / groups) behind a quiet disclosure, most IdPs do not need them,
  // so they are not dumped eagerly.
  const emailAttrField = field({ id: "saml-email-attr", label: "Email attribute (optional)", autocomplete: "off", placeholder: "e.g. email or http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", hint: "Assertion attribute carrying the email. Blank: no email is read, and every SAML sign-in is refused.", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "email-binding-the-email-attribute-and-the-trust-policy" }, validate: (v) => (v.length > CLAIM_NAME_MAX ? `Use at most ${CLAIM_NAME_MAX} characters.` : null) });
  const groupsAttrField = field({ id: "saml-groups-attr", label: "Groups attribute (optional)", autocomplete: "off", placeholder: "e.g. groups or memberOf", hint: "The assertion attribute carrying group membership (for group-to-role mapping).", doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "the-groups-attribute-names-where-groups-live" }, validate: (v) => (v.length > CLAIM_NAME_MAX ? `Use at most ${CLAIM_NAME_MAX} characters.` : null) });
  wrap.appendChild(collapsedSection("Attribute mapping (optional)", h("div", { class: "idp-form-grid" }, emailAttrField.el, groupsAttrField.el)));

  const { policyField, emailVerifiedAttrField } = samlPolicyPicker(wrap);
  fields.push(emailVerifiedAttrField);

  return { fields, labelField, idField, idpEntityField, idpSsoField, spEntityField, nameIdField, certField, emailAttrField, groupsAttrField, policyField, emailVerifiedAttrField };
}

// samlPolicyPicker builds and mounts the email-trust policy picker (default trust-idp), the note that says
// which roles an emailed invite can receive under the chosen policy, and the Email verified attribute field
// that require-flag needs. A trust-idp connection binds an emailed invite only for Viewer, Operator, or a
// custom role with no people, access or approval permission; Owner, Access admin, Approver and Restore
// operator need a require-flag connection whose attribute reads "true" or "1" (engine
// scheduler-do-rbac.ts resolveBoundEntry/weakEmailMayBind, idpconn-validators.ts validateSaml). Returns both
// fields for the proposal.
function samlPolicyPicker(wrap: HTMLElement): { policyField: Field; emailVerifiedAttrField: Field } {
  const policyField = field({
    id: "saml-email-policy",
    label: "Email trust",
    kind: "select",
    value: "trust-idp",
    hint: "trust-idp uses the email the signed assertion carries. require-flag uses it only when the IdP marks it verified.",
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "email-binding-the-email-attribute-and-the-trust-policy" },
    options: [
      { value: "trust-idp", label: "trust-idp (recommended: trust the email the signed assertion carries)" },
      { value: "require-flag", label: "require-flag (trust the email only when the IdP marks it verified)" },
    ],
  });
  // The attribute field is part of the form's validation set, but it refuses an empty value only while
  // require-flag is chosen: under trust-idp the engine never reads it, so it is hidden and not sent.
  const emailVerifiedAttrField = field({
    id: "saml-email-verified-attr",
    label: "Email verified attribute",
    autocomplete: "off",
    placeholder: "e.g. email_verified",
    hint: 'The attribute your IdP sets to "true" or "1" for a verified email. Without it every sign-in is refused.',
    doc: { href: "https://docs.downpipes.io/identity-access/connect-saml", anchor: "email-binding-the-email-attribute-and-the-trust-policy" },
    validate: (v) => {
      if (policyField.value() !== "require-flag") return null;
      if (v.length === 0) return "require-flag needs the attribute your IdP uses to mark the email verified.";
      return v.length > CLAIM_NAME_MAX ? `Use at most ${CLAIM_NAME_MAX} characters.` : null;
    },
  });
  const policyNote = h("div", { id: "saml-email-policy-note", style: "margin-top:var(--space-2)" });
  const reflectPolicy = (): void => {
    const requireFlag = policyField.value() === "require-flag";
    emailVerifiedAttrField.el.hidden = !requireFlag;
    if (!requireFlag) emailVerifiedAttrField.clearError();
    policyNote.replaceChildren(
      h("p", { class: "note-quiet measure" },
        requireFlag
          ? 'An emailed invite binds any role, Owner included, when the attribute below reads "true" or "1". Without it every sign-in is refused. '
          : "An invite on this connection binds only a Viewer or Operator role, or a custom role with no people, access or approval permission. Access admin, Approver and Restore operator need a group mapping, a connection that verifies the email, a passkey or Cloudflare Access. Owner needs one of the last three, because a group cannot confer Owner. ",
        "This choice is recorded in the audit log.",
      ),
    );
  };
  (policyField.control as HTMLSelectElement).addEventListener("change", reflectPolicy);
  wrap.appendChild(policyField.el);
  wrap.appendChild(policyNote);
  wrap.appendChild(emailVerifiedAttrField.el);
  reflectPolicy();
  return { policyField, emailVerifiedAttrField };
}

// samlForm renders the generic SAML 2.0 connection form. SAML has many more fields than OIDC, so they all
// live here UNDER the SAML choice (progressive disclosure: this form only renders once "Generic SAML" is
// picked). It collects the IdP entity id / SSO URL / SP entity id / NameID format, a PASTE box for the IdP
// signing cert PEM(s), and an email-verified-policy picker (default trust-idp, with the Email verified attribute
// field require-flag needs). On submit it composes the { proposal } and POSTs it; validateSaml's reason is
// shown verbatim. After creation the card's SAML handoff (download SP metadata + ACS URL) is how the
// customer finishes at their IdP.
export function samlForm(engine: EngineClient, reload: () => void, taken?: TakenConnIds): HTMLElement {
  const wrap = h("section", { class: "card card--inset", style: "display:grid;gap:var(--space-5);max-width:48rem", "aria-label": "Add a SAML 2.0 provider" });
  wrap.appendChild(h("h3", { style: "font-size:var(--text-base);margin:0" }, "Add a SAML 2.0 provider"));

  const handles = samlFields(engine, wrap, taken);
  const { fields, labelField, idField, idpEntityField, idpSsoField, spEntityField, nameIdField, certField, emailAttrField, groupsAttrField, policyField, emailVerifiedAttrField } = handles;

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
    // The paste can lose part of itself: the operator pastes BOTH rollover certificates, an editor mangles one,
    // splitPems drops it without a word, and the submission is smaller than the paste. Neither the console nor
    // the engine would ever see the dropped block, so the only possible witness is here, at the moment it is
    // dropped. COUNTS ONLY: the certificate bodies never ride, and the accepted count is recorded beside the
    // dropped one, so "one of two was dropped" and "one of nine" are not the same evidence.
    const intended = pemBlocksIntended(certField.value());
    recordInputDropped("idp-cert-paste", certs.length, Math.max(0, intended - certs.length));
    if (certs.length === 0) {
      // The paste can carry a BEGIN CERTIFICATE line (so the field validator passes) while splitPems finds no
      // complete block in it. Refuse explicitly here instead of silently submitting no certificates.
      certField.refuse("Paste at least one PEM certificate.");
      certField.focus();
      return null;
    }
    const emailAttr = emailAttrField.value();
    const groupsAttr = groupsAttrField.value();
    const requireFlag = policyField.value() === "require-flag";
    const emailVerifiedAttr = emailVerifiedAttrField.value();
    return {
      id: idField.value(),
      kind: "saml",
      label: labelField.value(),
      presetId: "generic-saml",
      // A new SAML connection is created switched off. The admin downloads the SP metadata from the card,
      // hands it to the IdP, and turns the connection on from the list once that side is ready.
      enabled: false,
      idpEntityId: idpEntityField.value(),
      idpSsoUrl: idpSsoField.value(),
      idpSigningCerts: certs,
      spEntityId: spEntityField.value(),
      nameIdFormat: nameIdField.value(),
      wantAssertionsSigned: true,
      allowIdpInitiated: false,
      clockSkewSec: SAML_DEFAULT_CLOCK_SKEW_SEC,
      emailVerifiedPolicy: requireFlag ? "require-flag" : "trust-idp",
      ...(emailAttr !== "" ? { emailAttr } : {}),
      ...(groupsAttr !== "" ? { groupsAttr } : {}),
      ...(requireFlag && emailVerifiedAttr !== "" ? { emailVerifiedAttr } : {}),
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
    // The connection is created switched off, so the toast names that state and the two steps left: hand the
    // SP metadata to the IdP, then select Enable in the list (the list's own control label, list.ts) once
    // that side is ready. No sign-in button appears until then.
    successMessage: () => `${labelField.value()} added and switched off. Download its SP metadata from the card and give it to your IdP. Select Enable in the list once your IdP is ready.`,
    addErrorText: (err) => `Could not add the SAML connection (${errText(err)}).`,
    reload,
  });

  return wrap;
}
