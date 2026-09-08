// The write flows of the credential lifecycle registry: the add/edit modal (collection-time fields, the
// honest per-IdP date hint that never fabricates a date, the No-expiry checkbox, no field for the secret),
// the honest cleanup-attestation modal (the operator's WORD that they deleted a spent token in Cloudflare,
// never a Cloudflare-side check), and the remove confirmation. The engine re-validates the capability and the
// shape; a refusal is shown inline. Moved verbatim from the credentials coordinator for size; it imports the
// shared leaf (./helpers.ts) only, so it never imports the list section (which would form a cycle).
//
// House rules: no-custody (no secret is ever collected); honest copy ("deleted (attested)", never
// "verified"); Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { disabledWithReason, field, validateForm, type Field } from "../../components/field.ts";
import { openModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { isPendingResult } from "../../api.ts";
import type { EngineClient, ExpiryStatus, ExpiryKind, ExpiryLifecycleClass, ExpiryItemInput } from "../../api.ts";
import {
  KIND_OPTIONS,
  LIFECYCLE_OPTIONS,
  CF_API_TOKENS_URL,
  makeReadOnly,
  toDateInputValue,
  isValidDateInput,
  toRfc3339EndOfDay,
  errText,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// The add / edit modal (openItemForm). Collection-time fields at readable measure (the
// modal stacks fields): Label, Kind, Lifecycle (select), Purpose, a No-expiry CHECKBOX
// (built directly with h(), field() has no checkbox kind), the Expiry date (disabled +
// cleared while No-expiry is checked), and the optional Note. The per-IdP date hint is
// HONEST (it never fabricates a date). The engine re-validates the capability and the
// shape; a refusal is shown inline. No secret is collected.
// ---------------------------------------------------------------------------

// ItemFormParts is the built field set plus the no-expiry wiring the body and the submit handler share.
interface ItemFormParts {
  labelField: Field;
  lifecycleField: Field;
  kindField: Field;
  purposeField: Field;
  dateField: Field;
  noteField: Field;
  idpHint: HTMLElement;
  noExpiryRow: HTMLElement;
  // noExpiry reports the checkbox state; syncNoExpiryAllowed applies the kind gate (a certificate or
  // licence may not be no-expiry) and then the date field's enabled state; validated is the field set
  // validateForm runs (the date is excluded for an observed item).
  noExpiry: () => boolean;
  syncNoExpiryAllowed: () => void;
  validated: Field[];
}

export function openItemForm(engine: EngineClient, existing: ExpiryStatus | null, reload: () => void): void {
  const editing = existing !== null;
  const parts = buildItemFields(existing);
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const body = buildItemBody(parts, existing, editing, formError);
  // Apply the kind gate and the date field's initial enabled/disabled state (an edit may open on a
  // certificate, or with No-expiry already ticked).
  parts.syncNoExpiryAllowed();

  openModal({
    title: editing ? "Edit tracked item" : "Track a credential or key expiry",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: editing ? "Save changes" : "Track item",
        variant: "primary",
        busyLabel: "Saving",
        onClick: () => submitItem(engine, parts, existing, formError, reload),
      },
    ],
  });
}

// buildItemFields builds every collection-time field plus the No-expiry checkbox wiring. No secret is
// ever collected. An observed item's label/kind/date are the engine's own, shown read-only with the
// reason so an edit does not fight the next observation.
function buildItemFields(existing: ExpiryStatus | null): ItemFormParts {
  const observed = existing?.source === "observed";
  const editing = existing !== null;

  const labelField = field({
    id: "expiry-label",
    label: "Label",
    required: true,
    ...(existing ? { value: existing.label } : {}),
    hint: "A redaction-safe name you recognise, for example \"S3 destination access key\" or \"TLS certificate for the archive endpoint\". Never include the secret itself.",
    placeholder: "e.g. S3 destination access key",
    doc: { href: "https://docs.downpipes.io/identity-access/credential-lifecycle-registry", anchor: "what-the-registry-is" },
    validate: (v) => (v.trim().length >= 2 ? null : "Give a short, recognisable label."),
  });
  // An observed item's label is the engine's own (it re-derives it); show it read-only
  // with the reason rather than letting an edit fight the next observation.
  if (observed) makeReadOnly(labelField, "Auto-observed, the engine sets this label.");

  // The Lifecycle select. Defaults: Ephemeral when the kind is "token" (a one-shot attach
  // token), Functional otherwise. The hint explains the consequence (ephemeral shows in
  // "needs cleanup" once spent).
  const defaultLifecycle: ExpiryLifecycleClass =
    existing?.lifecycleClass ?? (existing?.kind === "token" ? "ephemeral" : "functional");
  const lifecycleField = field({
    id: "expiry-lifecycle",
    label: "Lifecycle",
    kind: "select",
    options: LIFECYCLE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    value: defaultLifecycle,
    hint: "Functional is a standing credential the platform keeps using. Ephemeral is a one-shot token you delete after use, it appears under \"needs cleanup\" once spent.",
    doc: { href: "https://docs.downpipes.io/identity-access/credential-lifecycle-registry", anchor: "what-the-registry-is" },
  });

  const kindField = field({
    id: "expiry-kind",
    label: "Kind",
    kind: "select",
    options: KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    value: existing ? existing.kind : "credential",
    hint: "What sort of dated item this is. A token defaults to the ephemeral lifecycle.",
    doc: { href: "https://docs.downpipes.io/identity-access/credential-lifecycle-registry", anchor: "what-the-registry-is" },
  });
  if (observed) makeReadOnly(kindField, "Auto-observed, the engine sets the kind.");
  // When the operator picks "token" and has not chosen a lifecycle yet, nudge the select
  // to Ephemeral (a one-shot attach token); they can override.
  kindField.control.addEventListener("change", () => {
    if (kindField.value() === "token" && lifecycleField.control instanceof HTMLSelectElement) {
      lifecycleField.control.value = "ephemeral";
    }
  });

  const purposeField = field({
    id: "expiry-purpose",
    label: "Purpose (optional)",
    ...(existing?.purpose ? { value: existing.purpose } : {}),
    hint: "What this credential is for, in a few words, e.g. \"attach the prod R2 bucket\" or \"sign the archive endpoint\". Shown on the row and the detail; never a secret.",
    placeholder: "e.g. attach the prod R2 bucket",
    doc: { href: "https://docs.downpipes.io/identity-access/credential-lifecycle-registry", anchor: "what-the-registry-is" },
  });

  const dateField = field({
    id: "expiry-date",
    label: "Expiry date",
    type: "date",
    ...(existing?.expiresAt ? { value: toDateInputValue(existing.expiresAt) } : {}),
    placeholder: "2027-01-31",
    hint: "The date this item stops being valid (YYYY-MM-DD). The engine counts the days remaining and alerts at the 60, 30, 14, 7 and 1 day transitions.",
    doc: { href: "https://docs.downpipes.io/identity-access/credential-lifecycle-registry", anchor: "tiered-proactive-alerts" },
    validate: (v) => {
      // No-expiry checked: the date is optional (and cleared/disabled), so skip the rule.
      if (noExpiry()) return null;
      if (v.trim() === "") return "Choose the expiry date, or tick \"No expiry / rotate on policy\".";
      return isValidDateInput(v) ? null : "Enter a valid date (YYYY-MM-DD).";
    },
  });
  if (observed) makeReadOnly(dateField, "Auto-observed from the credential, the engine tracks the date.");

  // The per-IdP honest date hint: it NEVER fabricates a date. It states the vendor's
  // default behaviour and tells the operator to enter the date they actually chose, or to
  // pick No-expiry when the credential does not expire by default. A standing line below
  // the date field; calm copy, no tint.
  const idpHint = h("p", { class: "field__hint measure", style: "margin-top:var(--space-1)" },
    "If this is an IdP client secret: Entra defaults to ~6 months (24-month cap), enter the date you chose in Entra. Okta, Google, Auth0, GitLab, Keycloak and GitHub OAuth secrets do not expire by default, choose \"No expiry\" unless you rotate on a policy. SAML signing certificates are auto-observed from the certificate.",
  );

  // The "No expiry / rotate on policy" CHECKBOX. field() has NO checkbox kind, so build
  // it directly with h(). Checking it sets noExpiry:true on the input and DISABLES +
  // CLEARS the date field (a no-expiry credential has no date to track).
  const noExpiryBox = h("input", { type: "checkbox", id: "expiry-noexpiry", style: "margin-top:var(--space-1);flex:none" }) as HTMLInputElement;
  // Pre-check it when editing a no-expiry item (state "no-expiry" or simply no date).
  if (existing && existing.state === "no-expiry") noExpiryBox.checked = true;
  const noExpiry = (): boolean => noExpiryBox.checked;
  const syncDateEnabled = (): void => {
    const off = noExpiry();
    // Disabled-with-reason, not the native `disabled` attribute: a keyboard/screen-reader
    // user tabbing the form still lands on the date field and hears why it is refused, rather
    // than it silently vanishing from the tab order with only the sighted checkbox state to
    // explain it.
    dateField.setDisabled(off ? "No expiry is ticked, so there is no date to set." : null);
    if (off) {
      (dateField.control as HTMLInputElement).value = "";
      dateField.clearError();
    }
  };
  noExpiryBox.addEventListener("change", syncDateEnabled);
  // The reason slot for the kind gate below. Given an id and started hidden, exactly as
  // disabledWithReason requires, so aria-describedby has something to point at.
  const noExpiryReason = h("p", { class: "field__hint", id: "expiry-noexpiry-reason", style: "display:block", hidden: true });
  noExpiryReason.hidden = true; // property, not just the attribute (see field.ts's own SHIM NOTE)
  // The .checkbox-row idiom the other screens use (notifications/roles-builder): a bare
  // checkbox input + a label, aligned at the top. The label's `for` ties it to the box.
  const noExpiryRow = h(
    "div",
    { class: "field checkbox-row" },
    noExpiryBox,
    h(
      "label",
      { for: "expiry-noexpiry" },
      h("span", { style: "display:block" }, "No expiry / rotate on policy"),
      h("span", { class: "field__hint", style: "display:block" }, "Tick this for a credential that does not expire by default (you rotate it on your own schedule). The date field is then disabled."),
      noExpiryReason,
    ),
  );

  // KIND GATE. The engine refuses a certificate or a licence that carries no expiry date
  // (engine/src/admin/expiry.ts:394-395, "expiresAt is required for a certificate or licence"), and this
  // checkbox was offered ungated for all five kinds, so picking Certificate and ticking No expiry built a
  // request the engine answered 400 and the operator lost the form's work at submit. Refuse the
  // COMBINATION at entry instead: with Certificate or Licence chosen the box is announced as disabled with
  // the reason, cannot be ticked by mouse or keyboard, and the date field goes back to being required.
  const setNoExpiryDisabled = disabledWithReason(noExpiryBox, noExpiryReason);
  const syncNoExpiryAllowed = (): void => {
    const k = kindField.value();
    const refused = k === "certificate" || k === "licence";
    if (refused && noExpiryBox.checked) noExpiryBox.checked = false; // switching kind must not leave a state the engine refuses
    setNoExpiryDisabled(refused ? `A ${k === "certificate" ? "certificate" : "licence"} always carries an expiry date, so "No expiry" does not apply to it. Enter the date it stops being valid.` : null);
    syncDateEnabled();
  };
  kindField.control.addEventListener("change", syncNoExpiryAllowed);

  // The note is optional redaction-safe context. The list (GET /admin/expiry) returns the
  // computed status, which carries no note, so an edit cannot pre-fill the existing note;
  // the hint says so honestly, and a blank note is OMITTED from the upsert (so the engine
  // keeps the stored note rather than the form clearing it).
  const noteField = field({
    id: "expiry-note",
    label: "Note (optional)",
    kind: "textarea",
    hint: editing
      ? "Optional redaction-safe context. Leave blank to keep any existing note unchanged; type to add or replace it."
      : "Optional redaction-safe context, for example the rotation owner or the renewal runbook link.",
    placeholder: "e.g. rotate via the cloud console; owner is the platform team.",
    doc: { href: "https://docs.downpipes.io/identity-access/credential-lifecycle-registry", anchor: "no-custody-by-construction" },
  });

  // The validated field set excludes the date field for an OBSERVED item (it is read-only)
  // and when No-expiry is checked the date rule self-skips (see its validate above).
  const validated: Field[] = observed
    ? [labelField, lifecycleField, kindField, purposeField, noteField]
    : [labelField, lifecycleField, kindField, purposeField, dateField, noteField];

  return { labelField, lifecycleField, kindField, purposeField, dateField, noteField, idpHint, noExpiryRow, noExpiry, syncNoExpiryAllowed, validated };
}

// buildItemBody assembles the modal form from the built fields in their display order.
function buildItemBody(parts: ItemFormParts, existing: ExpiryStatus | null, editing: boolean, formError: HTMLElement): HTMLElement {
  return h(
    "form",
    { class: "form-stack", style: "display:grid;gap:var(--space-4)", "aria-label": editing ? `Edit ${existing!.label}` : "Track a new item", on: { submit: (ev: Event) => ev.preventDefault() } },
    parts.labelField.el,
    parts.lifecycleField.el,
    parts.kindField.el,
    parts.purposeField.el,
    parts.noExpiryRow,
    parts.dateField.el,
    parts.idpHint,
    parts.noteField.el,
    formError,
  );
}

// submitItem validates the form and upserts the item. No secret is collected: the input carries only
// redaction-safe context. A blank purpose/note is OMITTED so the engine keeps the stored value rather
// than the form clearing it; the noExpiry flag signals the deliberate no-date choice. A pending result
// is the change-control queue; a 401 hands off to signed-out; any other refusal is shown inline.
async function submitItem(
  engine: EngineClient,
  parts: ItemFormParts,
  existing: ExpiryStatus | null,
  formError: HTMLElement,
  reload: () => void,
): Promise<boolean> {
  const editing = existing !== null;
  formError.hidden = true;
  if (!validateForm(parts.validated)) return false;
  const input: ExpiryItemInput = {
    label: parts.labelField.value(),
    kind: parts.kindField.value() as ExpiryKind,
    lifecycleClass: parts.lifecycleField.value() as ExpiryLifecycleClass,
    source: "manual",
  };
  if (parts.noExpiry()) input.noExpiry = true;
  else input.expiresAt = toRfc3339EndOfDay(parts.dateField.value());
  // The engine REQUIRES a caller-supplied id (it is the `expiry:<id>` storage key, and the value the upsert
  // is keyed by); it never assigns one. A create mints a fresh UUID (matches the engine's
  // /^[A-Za-z0-9._-]{1,128}$/ id pattern); an edit reuses the existing id so the upsert targets the same row.
  input.id = editing && existing ? existing.id : crypto.randomUUID();
  const purpose = parts.purposeField.value();
  if (purpose !== "") input.purpose = purpose;
  const note = parts.noteField.value();
  if (note !== "") input.note = note;
  try {
    const res = await engine.upsertExpiryItem(input);
    if (res.status === "pending") surfacePendingChange("tracked item");
    else toast({ message: editing ? `Updated "${input.label}"` : `Tracking "${input.label}"` });
    reload();
    return true;
  } catch (err) {
    if (isUnauthorised(err)) {
      goSignedOut();
      return true;
    }
    formError.textContent = `The engine refused the save (${errText(err)}).`;
    formError.hidden = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// The cleanup attestation modal (honest). The operator confirms they deleted the spent
// token IN Cloudflare; the engine flips cleanupState to "attested-deleted". It is the
// operator's WORD, not a Cloudflare-side check, the copy and the resulting badge say so
// ("deleted (attested)", neutral, NEVER green / "verified"). PRIMARY button (NOT
// type-to-confirm). A secondary link opens the CF API Tokens dashboard.
// ---------------------------------------------------------------------------

export function openCleanupAttest(engine: EngineClient, row: ExpiryStatus, reload: () => void): void {
  const body = h("div", { style: "display:grid;gap:var(--space-3)" });
  body.appendChild(
    h(
      "p",
      { style: "color:var(--text)" },
      "Downpipes never held this token and cannot check Cloudflare for you. Confirm only after you have deleted the token in the Cloudflare dashboard. This marks the entry deleted by your attestation; it does not verify deletion.",
    ),
  );
  if (row.tokenRef && row.tokenRef.trim() !== "") {
    body.appendChild(h("p", { class: "field__hint" }, "Token id: ", h("span", { class: "mono" }, row.tokenRef)));
  }
  body.appendChild(
    h(
      "p",
      { class: "field__hint" },
      h(
        "a",
        { class: "linklike", href: CF_API_TOKENS_URL, target: "_blank", rel: "noopener noreferrer", style: "display:inline-flex;align-items:center;gap:var(--space-1)" },
        "Open Cloudflare API Tokens",
        svgIcon(ICON_EXTERNAL, { size: 12 }),
      ),
    ),
  );

  openModal({
    title: "Confirm you deleted the token",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "I have deleted it in Cloudflare",
        variant: "primary",
        busyLabel: "Recording",
        onClick: async () => {
          try {
            await engine.cleanupAttestExpiry(row.id);
            toast({ message: `Recorded: "${row.label}" marked deleted (your attestation).` });
            reload();
            return true;
          } catch (err) {
            if (isUnauthorised(err)) {
              goSignedOut();
              return true;
            }
            toast({ message: `Could not record the attestation (${errText(err)}).`, tone: "warn" });
            return false;
          }
        },
      },
    ],
  });
}

// removeItem confirms then deletes a tracked item. The confirm is a non-destructive
// idiom (removing a tracker entry does not touch the underlying credential), so it uses
// the primary confirm, not the danger type-to-confirm. The awaited delete runs INSIDE
// the confirm modal's busy onClick (the role-save pattern), so the busyLabel covers the
// network call and a double fire is impossible.
export function removeItem(engine: EngineClient, row: ExpiryStatus, reload: () => void): void {
  openModal({
    title: "Remove tracked item",
    body: h("p", { style: "color:var(--text)" }, `Stop tracking "${row.label}"? This removes the reminder only; it does not change or revoke the underlying credential.`),
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Remove",
        variant: "primary",
        busyLabel: "Removing",
        onClick: async () => {
          try {
            const res = await engine.deleteExpiryItem(row.id);
            if (isPendingResult(res)) {
              // expiry-item-delete is change-control gated, so a 202 means the removal was QUEUED for a second
              // approver and the item is STILL tracked. Surface the queued state honestly (never "Removed") and
              // leave the row in place; the deleteNotifyChannel/deleteNotifyRule siblings do the same.
              surfacePendingChange("item removal");
              return true;
            }
            toast({ message: `Removed "${row.label}"` });
            reload();
            return true;
          } catch (err) {
            if (isUnauthorised(err)) {
              goSignedOut();
              return true;
            }
            toast({ message: `Could not remove the item (${errText(err)}).`, tone: "warn" });
            return false;
          }
        },
      },
    ],
  });
}
