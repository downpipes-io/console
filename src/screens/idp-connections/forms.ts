// The OIDC/OAuth2 add-connection FORM of the external-identity-providers screen (the form a provider tile
// opens when an owner adds it). The READ-ONLY "Test connection" result renderer lives in
// ./forms-test-result.ts and the inline "How to add <provider>" guidance in ./guide-panels.ts; the generic
// SAML 2.0 form lives in ./saml-form.ts. The console never builds a connection itself: it reads the engine's
// preset catalogue, renders the required values, and POSTs the proposal; the client secret is write-only. It
// imports the shared leaf (./shared.ts) only, so it never imports the list section (which would form a cycle).
//
// The provider PICKER that used to live here (a select of presets + a Generic SAML option) was replaced by
// the provider grid (./grid.ts); the coordinator now opens presetForm or samlForm directly from a tile, so
// this module exposes presetForm and no longer owns the catalogue fetch or the picker.
//
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, IdpPreset, IdpPresetCreate } from "../../api.ts";
import { disabledWithReason, type Field, field, validateForm } from "../../components/field.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL, ICON_INFO, ICON_PLUS } from "../../lib/icons.ts";
import { IDP_GUIDES } from "../idp-guides.ts";
import { wireFormActions } from "./form-actions.ts";
import { isWideVar, oidcGuidePanel } from "./guide-panels.ts";
import { connIdError, errText, type TakenConnIds } from "./shared.ts";

// ---------------------------------------------------------------------------
// OIDC/OAuth2 preset form (split into guide -> fields -> submit-wiring helpers)
// ---------------------------------------------------------------------------

// presetGuidePanel mounts the inline "How to add X" guide (idp-guides.ts), with the LIVE callback URL bound to
// the connection id. When no guide exists for a preset (a newer engine preset), it falls back to the
// engine-supplied notes so the form still helps. Returns setGuideConnId, called from the connection-id field.
function presetGuidePanel(engine: EngineClient, preset: IdpPreset, wrap: HTMLElement): (id: string) => void {
  const guide = IDP_GUIDES[preset.id];
  let setGuideConnId: (id: string) => void = () => {};
  if (guide) {
    const panel = oidcGuidePanel(engine, preset, guide);
    setGuideConnId = panel.setConnId;
    wrap.appendChild(panel.el);
  } else if (preset.notes.length > 0) {
    const notes = h("ul", { style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2)" });
    for (const note of preset.notes) {
      notes.appendChild(h("li", { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" }, h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_INFO, { size: 15 })), h("span", note)));
    }
    wrap.appendChild(notes);
    if (preset.docsUrl) wrap.appendChild(h("a", { class: "linklike", href: preset.docsUrl, target: "_blank", rel: "noreferrer noopener", style: "display:inline-flex;gap:var(--space-1);align-items:center" }, `${preset.vendor} setup docs`, svgIcon(ICON_EXTERNAL, { size: 13 })));
  }
  return setGuideConnId;
}

// The handles presetFields returns so the submit-wiring can read every value the operator entered.
interface PresetFieldHandles {
  fields: Field[];
  labelField: Field;
  idField: Field;
  clientIdField: Field;
  secretField: Field;
  varFields: Map<string, Field>;
  publicClientBox: HTMLInputElement;
}

// presetFields builds and mounts the form fields: identity (display name + connection id), the preset's
// requiredVars, and the credentials (client id + write-only secret, with the public-client/PKCE toggle).
// Every field group shares one two-column grid (.idp-form-grid) so the columns line up row to row.
function presetFields(preset: IdpPreset, wrap: HTMLElement, setGuideConnId: (id: string) => void, taken?: TakenConnIds): PresetFieldHandles {
  const fields: Field[] = [];

  // Identity: the display name + the connection id. The connection id is the per-connection callback-path
  // slug, so typing it updates the guide's live callback URL.
  const labelField = field({ id: "idp-label", label: "Display name", value: preset.label, placeholder: "Okta", hint: "Shown on the sign-in button and in this list.", required: true, doc: { href: "https://docs.downpipes.io/identity-access/connect-oidc-oauth2" }, validate: (v) => (v.length >= 1 ? null : "A display name is required.") });
  // The connection id is validated by connIdError (./shared.ts), which both add forms now share: it mirrors
  // the engine's CONN_ID_PATTERN (1 to 64 chars, lowercase alphanumerics with internal hyphens only, not
  // starting or ending with a hyphen) AND refuses an id this engine already holds, which the engine refuses
  // at submit. The two forms carried byte-identical copies of the shape half and neither had the other half.
  const idField = field({ id: "idp-id", label: "Connection id", value: preset.id, hint: "A short slug: lowercase letters, numbers and internal hyphens, starting and ending with a letter or number. Use a distinct id if you run two of the same provider.", placeholder: "okta-prod", required: true, autocomplete: "off", doc: { href: "https://docs.downpipes.io/identity-access/connect-oidc-oauth2" }, onInput: (v) => setGuideConnId(v), validate: (v) => connIdError(v, taken) });
  fields.push(labelField, idField);
  wrap.appendChild(h("div", { class: "idp-form-grid" }, labelField.el, idField.el));

  // The preset's required values (the tenant id, the Okta domain, the realm...), in the SAME two-column grid
  // so they line up with the row above. A URL value spans the full width; a short scalar stays half-width.
  const varFields = new Map<string, Field>();
  if (preset.requiredVars.length > 0) {
    const varsGrid = h("div", { class: "idp-form-grid" });
    for (const v of preset.requiredVars) {
      // A var carrying an explicit empty-string default is OPTIONAL (the engine's own signal): today the
      // Auth0 roles-claim namespace and the Generic OIDC groups/roles claim, both labelled "(optional)"
      // and both left blank for a sign-in-only connection. The engine treats a blank claim as additive,
      // so requiring it here blocked exactly the sign-in-only setup the guidance told the operator to do.
      // Every other var (no default, or a meaningful one) stays required.
      const optional = v.default === "";
      const f = field({
        id: `idp-var-${v.key}`,
        label: v.label,
        ...(v.default !== undefined ? { value: v.default } : {}),
        ...(v.example !== undefined ? { placeholder: v.example } : {}),
        ...(optional ? {} : { required: true }),
        autocomplete: "off",
        doc: { href: "https://docs.downpipes.io/identity-access/connect-oidc-oauth2" },
        ...(optional ? {} : { validate: (val: string) => (val.length >= 1 ? null : `${v.label} is required.`) }),
      });
      if (isWideVar(v)) f.el.classList.add("idp-span");
      varFields.set(v.key, f);
      fields.push(f);
      varsGrid.appendChild(f.el);
    }
    wrap.appendChild(varsGrid);
  }

  // Credentials: the client id + the write-only secret, paired in the same grid so they align. The
  // public-client checkbox (full width, above) flips to the pkce-public mode and hides the secret field;
  // some IdPs want a public client with no shared secret. The secret is password-typed, posted on create and
  // NEVER read back. It is validated conditionally on submit (not in `fields`), so a public client never
  // errors for an empty secret.
  const clientIdField = field({ id: "idp-client-id", label: "Client id", required: true, autocomplete: "off", placeholder: "0oa1b2c3d4EXAMPLE", hint: "The application (client) id your IdP issued for downpipes.", doc: { href: "https://docs.downpipes.io/identity-access/connect-oidc-oauth2" }, validate: (v) => (v.length >= 1 ? null : "The client id is required.") });
  fields.push(clientIdField);

  const secretField = field({ id: "idp-secret", label: "Client secret", type: "password", autocomplete: "off", hint: "Write-only: it is sent to your engine and never shown again. To change it later, remove and re-add the connection." });
  const secretSlot = h("div", secretField.el);

  const publicClientRow = h("label", { class: "checkbox-row" });
  const publicClientBox = h("input", { type: "checkbox", id: "idp-public-client" }) as HTMLInputElement;
  publicClientRow.appendChild(publicClientBox);
  const publicClientReason = h("span", { class: "field__hint", id: "idp-public-client-reason", style: "display:block", hidden: true });
  publicClientReason.hidden = true; // property, not just the attribute (see field.ts's own SHIM NOTE)
  publicClientRow.appendChild(h("span", "Public client (PKCE, no secret). ", h("span", { class: "field__hint" }, "Tick this only if your IdP registered downpipes as a public/SPA client with no client secret."), publicClientReason));
  publicClientBox.addEventListener("change", () => {
    secretSlot.hidden = publicClientBox.checked;
  });
  // PUBLIC CLIENT IS AN OIDC-ONLY CHOICE, and the tick was offered on every tile. On an OAuth2 tile the
  // engine cannot save it: the preset create path always attaches a secretRef, and validateOauth2 derives
  // pkce_public ONLY when secretRef is absent (engine/src/admin/idpconn-validators.ts:339), so a ticked
  // OAuth2 proposal reaches validateSecretRef as a CONFIDENTIAL client holding a pkce-public ref and is
  // refused with "a confidential client secretRef.mode must be 'do-plaintext'"
  // (engine/src/admin/idpconn-validators.ts:105), a reason that never mentions public clients. There is no
  // value the console could post instead, so the combination is refused at entry rather than at submit.
  if (preset.kind === "oauth2") {
    disabledWithReason(publicClientBox, publicClientReason)(`${preset.label} is an OAuth2 connection, and your engine will not save one without a client secret. Public client applies to OIDC connections. Enter the client secret below.`);
  }

  // Group-level doc link (the field audit's G2): the public-client checkbox and the write-only client-secret
  // field below are one secret-mode decision, so the link explaining confidential versus public lives on the
  // group. It stays visible when ticking the box hides the secret field, so the guidance never disappears.
  const secretModeDoc = h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/identity-access/connect-oidc-oauth2", target: "_blank", rel: "noreferrer noopener" },
    "About secret modes (confidential or public)",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  );

  wrap.appendChild(h("div", { style: "display:grid;gap:var(--space-2)" }, publicClientRow, secretModeDoc));
  wrap.appendChild(h("div", { class: "idp-form-grid" }, clientIdField.el, secretSlot));

  return { fields, labelField, idField, clientIdField, secretField, varFields, publicClientBox };
}

// presetForm renders an OIDC/OAuth2 connection form FROM the preset: an inline "How to add X" guide (steps +
// the live callback URL to register), then the connection id + label, the preset's requiredVars, the client
// id and ONE write-only secret (or a "public client, no secret" checkbox for the PKCE-public path). Every
// field group shares one two-column grid (.idp-form-grid) so the columns line up row to row. On submit it
// POSTs {presetId, vars, id, clientId, secret?, secretMode?, clientAuth?}; an engine refusal is shown verbatim.
export function presetForm(engine: EngineClient, preset: IdpPreset, reload: () => void, taken?: TakenConnIds): HTMLElement {
  const wrap = h("section", { class: "card card--inset", style: "display:grid;gap:var(--space-5);max-width:48rem", "aria-label": `Add ${preset.label}` });
  wrap.appendChild(h("h3", { style: "font-size:var(--text-base);margin:0" }, `Add ${preset.label}`));

  const setGuideConnId = presetGuidePanel(engine, preset, wrap);
  const handles = presetFields(preset, wrap, setGuideConnId, taken);
  const { fields, labelField, idField, clientIdField, secretField, varFields, publicClientBox } = handles;

  // Submit.
  const submitError = h("p", { class: "field__error", role: "alert", hidden: true });
  wrap.appendChild(submitError);
  const submitBtn = h("button", { "data-dp": "idp-connections.button.submit#1", class: "btn btn--primary", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), `Add ${preset.label}`) as HTMLButtonElement;
  const testBtn = h("button", { "data-busy-label": "Testing...", "data-dp": "idp-connections.button.test#1", class: "btn btn--secondary", type: "button" }, "Test connection") as HTMLButtonElement;
  const testResult = h("div");
  wrap.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" }, submitBtn, testBtn));
  wrap.appendChild(testResult);

  // buildPayload validates the form (showing inline field errors) and returns the proposal, or null when the
  // form is invalid. Shared by Add and Test so both act on exactly the values the operator entered.
  const buildPayload = (): IdpPresetCreate | null => {
    submitError.hidden = true;
    const isPublic = publicClientBox.checked;
    if (!validateForm(fields)) return null;
    if (!isPublic && secretField.value() === "") {
      // A cross-field console rule (secret required unless the public-client box is ticked), and it fires on an
      // empty box, so it is setError and not refuse. It is the required-and-empty state under another
      // name: no value was examined, so a form-rejected row would assert an inspection that never happened.
      // The operator is looking straight at the message and the remedy is in it.
      secretField.setError("A client secret is required for a confidential client. Tick 'Public client' if your IdP issued no secret.");
      secretField.focus();
      return null;
    }
    const vars: Record<string, string> = {};
    for (const [key, f] of varFields) vars[key] = f.value();
    return {
      presetId: preset.id,
      // Every proposal this form builds is stamped with the preset's own kind ("oidc" or "oauth2"). The
      // engine's CREATE route ignores it (it derives kind from presetId itself), but this SAME payload is
      // also what Test connection sends verbatim, and the engine's read-only probe dispatches on
      // proposal.kind with no presetId lookup at all (engine/src/admin/idp-test.ts). Without this, every
      // OIDC/OAuth2 preset's Test connection failed with "Unknown connection kind (none supplied)"; only
      // the SAML form set kind, so only its test ever ran a real check.
      kind: preset.kind,
      vars,
      id: idField.value(),
      label: labelField.value(),
      clientId: clientIdField.value(),
      ...(isPublic
        ? { secretMode: "pkce-public" as const, clientAuth: "pkce_public" as const }
        : { secret: secretField.value(), secretMode: "do-plaintext" as const }),
    };
  };

  wireFormActions({
    engine,
    submitBtn,
    testBtn,
    testResult,
    submitError,
    addLabel: `Add ${preset.label}`,
    build: buildPayload,
    queuedLabel: () => `Adding ${labelField.value()}`,
    // The connection is created already enabled (there is no separate activation step), so the toast must say
    // so rather than imply one remains; wording matches the enable-toggle's own accurate copy (list.ts).
    successMessage: () => `${labelField.value()} added and enabled. The sign-in button appears for everyone now. Disable it below if you are not ready to go live.`,
    addErrorText: (err) => `Could not add the connection (${errText(err)}).`,
    reload,
  });

  return wrap;
}
