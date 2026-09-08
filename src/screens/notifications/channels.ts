// Notifications panel 1, CHANNELS (per-kind CRUD): where a notification is delivered (a webhook, Slack, Teams,
// PagerDuty, or email), the configured-channels table with its filter and per-row test/edit/delete, and the
// add/edit-channel modal that shows ONLY the destination field the selected kind carries and validates it the
// way the engine does (https, no userinfo, not workers.dev; validated email addresses). A test send confirms
// delivery without sending real alert content; fail-open delivery is the engine's concern. Moved verbatim from
// the notifications coordinator for size; it imports the shared leaf (./shared.ts) only, so it never imports
// another panel module (which would form a cycle).
//
// House rules: no-custody (a channel carries the customer's own destination, never a key or value);
// disabled-with-reason, never hidden-then-403; Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised, isStepUpRequired } from "../../lib/errors.ts";
import { blockError, sessionEnded, errorDetail, stepUpAwareText } from "../../components/error-view.ts";
import { skeletonRows, emptyState } from "../../components/feedback.ts";
import { dataTable } from "../../components/data-table.ts";
import { field, validateForm } from "../../components/field.ts";
import { atMostChars } from "../../components/field-bounds.ts";
import { openModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { badge } from "../../components/status.ts";
import { relativeTime, absoluteTime } from "../../lib/format.ts";
import { ICON_PLUS, ICON_PLAY } from "../../lib/icons.ts";
import { isPendingResult } from "../../api.ts";
import type { EngineClient, NotifyChannel, ChannelKind } from "../../api.ts";
import {
  buildChannelInputFrom,
  CHANNEL_KINDS,
  callerCanCap,
  channelTargetDisplay,
  channelTargetText,
  checkboxRow,
  destinationFieldFor,
  errText,
  kindBadge,
  NOTIFY_API_KEY_MAX,
  NOTIFY_USERNAME_MAX,
  primaryButton,
  readOnlyNote,
  validateAddresses,
  validateUrl,
} from "./shared.ts";

export function renderChannelsPanel(engine: EngineClient): HTMLElement {
  // The tab above already reads "Channels", so the panel does not restate it as an h2 (the
  // stack read Channels three deep: tab, h2, "Configured channels"). The section takes a plain
  // aria-label and the table's "Configured channels" heading is the panel's one visible heading.
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-5)", "aria-label": "Channels" });
  wrap.appendChild(
    h("p", { class: "field__hint measure" }, "Where a notification is delivered: a webhook, Slack, Microsoft Teams, PagerDuty, or email. Add a channel, then a rule routes events to it. A test send confirms delivery without sending real alert content."),
  );

  const region = h("div", { class: "async-region" });
  wrap.appendChild(region);

  const load = (): void => {
    region.replaceChildren(skeletonRows(4));
    void engine
      .listNotifyChannels()
      .then((rows) => region.replaceChildren(renderChannelsTable(engine, rows, load)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the channels table is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        region.replaceChildren(blockError(err, load, { origin: location.origin }));
      });
  };
  load();

  return wrap;
}

function renderChannelsTable(engine: EngineClient, rows: NotifyChannel[], reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  const writeGate = callerCanCap("notify.config");

  const addBtn = primaryButton("Add a channel", ICON_PLUS, writeGate, () => openChannelForm(engine, null, reload));

  const toolbar = h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap" });
  toolbar.appendChild(h("h3", { style: "font-size:var(--text-md)" }, "Configured channels"));
  toolbar.appendChild(addBtn);
  wrap.appendChild(toolbar);
  if (!writeGate) wrap.appendChild(readOnlyNote());

  if (rows.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "No channels yet",
        body: "Add a channel so alerts have somewhere to go. When you add your first channel, a default rule turns on failure (critical) and stale (warning) alerts; success stays off, available via a digest.",
        ...(writeGate ? { action: { label: "Add a channel", onClick: () => openChannelForm(engine, null, reload) } } : {}),
      }),
    );
    return wrap;
  }

  const handle = dataTable<NotifyChannel>({
    label: "Notification channels",
    rows,
    rowKey: (c) => c.id,
    filter: { placeholder: "Filter channels by name or kind", resultLabel: "channels", getText: (c) => `${c.name} ${c.kind} ${channelTargetText(c)}` },
    initialSort: { key: "name", dir: "asc" },
    columns: [
      {
        key: "name",
        header: "Name",
        sortable: true,
        sortValue: (c) => c.name,
        render: (c) => {
          const cell = h("span", h("b", c.name));
          if (!c.enabled) cell.appendChild(h("span", { style: "margin-left:var(--space-2)" }, badge("default", "disabled")));
          return cell;
        },
      },
      { key: "kind", header: "Kind", sortable: true, sortValue: (c) => c.kind, render: (c) => kindBadge(c.kind) },
      { key: "target", header: "Destination", render: (c) => h("span", { class: "mono field__hint", style: "overflow-wrap:anywhere" }, channelTargetDisplay(c)) },
      { key: "created", header: "Added", sortable: true, sortValue: (c) => c.createdAt, render: (c) => h("span", { title: absoluteTime(c.createdAt) }, relativeTime(c.createdAt)) },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        width: "1px",
        render: (c) => channelRowActions(engine, c, writeGate, reload),
      },
    ],
  });
  wrap.appendChild(handle.el);

  return wrap;
}

function channelRowActions(engine: EngineClient, channel: NotifyChannel, writeGate: boolean, reload: () => void): HTMLElement {
  const wrap = h("div", { style: "display:flex;gap:var(--space-1);justify-content:flex-end" });
  // Read only: no row affordance; the one visible gate statement is the toolbar note.
  if (!writeGate) return wrap;

  // Test-send is a write-class action (gated by notify.config), so it sits with the
  // edit/delete controls. It sends a redaction-safe test only; the engine reports { ok }.
  const testBtn = h("button", { "data-dp": "notifications.button.test", class: "btn btn--ghost btn--sm", type: "button" }, svgIcon(ICON_PLAY, { size: 13 }), "Test") as HTMLButtonElement;
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    testBtn.dataset.busy = "true";
    try {
      const res = await engine.testNotifyChannel(channel.id);
      // Fail-open delivery is the engine's concern; report its honest { ok } either way. A
      // disabled channel still accepts a test, so a plain success would imply live alerts
      // flow to it; the caveat keeps the claim honest.
      const disabledNote = channel.enabled ? "" : " This channel is disabled, so real alerts will not reach it.";
      if (res.ok) toast({ message: `Test sent to ${channel.name}. Check the channel received it.${disabledNote}` });
      else toast({ message: `The engine could not deliver a test to ${channel.name}. Check the channel configuration.`, tone: "warn" });
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not send a test. ${errorDetail(err)}`, tone: "warn" });
    } finally {
      testBtn.disabled = false;
      testBtn.dataset.busy = "false";
    }
  });
  wrap.appendChild(testBtn);

  const editBtn = h("button", { "data-dp": "notifications.button.edit#1", class: "btn btn--ghost btn--sm", type: "button" }, "Edit") as HTMLButtonElement;
  editBtn.addEventListener("click", () => openChannelForm(engine, channel, reload));
  wrap.appendChild(editBtn);

  const deleteBtn = h("button", { "data-dp": "notifications.button.delete#1", class: "btn btn--ghost btn--sm", type: "button" }, "Delete") as HTMLButtonElement;
  // The awaited delete runs INSIDE the confirm modal's busy onClick (the role-save
  // pattern), so the busyLabel covers the network call and a double fire is impossible.
  deleteBtn.addEventListener("click", () => {
    openModal({
      title: "Delete channel",
      body: h(
        "div",
        { style: "display:grid;gap:var(--space-3)" },
        h("p", { style: "color:var(--text)" }, `Delete the channel "${channel.name}"? Any rule that delivers only to this channel will stop delivering. This does not delete the rules themselves.`),
        h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is deleted and you can start again from this row."),
      ),
      actions: [
        { label: "Cancel", variant: "secondary", onClick: () => {} },
        {
          label: "Delete channel",
          variant: "danger",
          busyLabel: "Deleting",
          onClick: async () => {
            try {
              const res = await engine.deleteNotifyChannel(channel.id);
              if (isPendingResult(res)) {
                // notify-channel-delete is change-control gated, so a 202 means the deletion was QUEUED for a
                // second approver and the channel STILL delivers. Surface the queued state honestly (never
                // "Deleted") and leave the row in place; the deleteRole/deleteGroupRole siblings do the same.
                surfacePendingChange("channel deletion");
                return true;
              }
              toast({ message: `Deleted ${channel.name}` });
              reload();
              return true;
            } catch (err) {
              if (isUnauthorised(err)) {
                goSignedOut();
                return true;
              }
              toast({ message: `Could not delete the channel. ${errorDetail(err)}`, tone: "warn" });
              return false;
            }
          },
        },
      ],
    });
  });
  wrap.appendChild(deleteBtn);
  return wrap;
}

// FieldHandle is the structural shape the field() / checkboxRow() factories return that this
// module relies on. It is kept local (not exported) so the helpers below can pass field sets
// around with a name; the concrete returns from field()/checkboxRow() are assignable to it.
type FieldHandle = ReturnType<typeof field>;

// ChannelFormFields groups the form's field handles. buildChannelFormFields constructs them
// from the existing channel (or null on add); the destination fields are mutually exclusive
// at render time and chosen by kind plus teams mode.
interface ChannelFormFields {
  nameField: FieldHandle;
  kindField: FieldHandle;
  teamsModeField: FieldHandle;
  urlField: FieldHandle;
  routingKeyField: FieldHandle;
  addressesField: FieldHandle;
  // jsm's write-only GenieKey token, and servicenow's non-secret Basic-auth username plus its
  // write-only password. Shown ALONGSIDE the url field above (destinationFieldFor already routes
  // jsm/servicenow to urlField as their primary destination), never in place of it.
  jsmApiKeyField: FieldHandle;
  servicenowUsernameField: FieldHandle;
  servicenowApiKeyField: FieldHandle;
  enabledCheck: ReturnType<typeof checkboxRow> | null;
}

// buildChannelFormFields constructs the field handles the channel form carries. Moved verbatim
// from openChannelForm; no field config changed.
function buildChannelFormFields(existing: NotifyChannel | null, lockedKind?: ChannelKind): ChannelFormFields {
  const nameField = field({
    id: "channel-name",
    label: "Channel name",
    required: true,
    value: existing?.name ?? "",
    hint: "A label you recognise, e.g. \"On-call PagerDuty\" or \"SRE Slack\".",
    placeholder: "On-call PagerDuty",
    validate: (v) => (v.length < 1 ? "Channel name is required." : v.length > 256 ? "The channel name is at most 256 characters." : null),
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "channels-where-an-alert-is-delivered" },
  });

  const kindField = field({
    id: "channel-kind",
    label: "Kind",
    kind: "select",
    value: existing?.kind ?? lockedKind ?? "webhook",
    hint: "The destination field below changes to match the kind.",
    options: CHANNEL_KINDS.map((k) => ({ value: k.kind, label: k.label })),
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "channels-where-an-alert-is-delivered" },
  });

  // Teams is special: it accepts EITHER a connector url OR an email address. The contract
  // models a teams channel as url (connector card) or, when toAddresses is set, an email
  // to the channel address. To keep the per-kind shape honest we surface a teams sub-mode
  // toggle; for every other kind the destination field is fixed.
  const teamsModeField = field({
    id: "channel-teams-mode",
    label: "Teams delivery",
    kind: "select",
    value: existing && existing.kind === "teams" && existing.toAddresses && existing.toAddresses.length > 0 ? "email" : "connector",
    hint: "A Teams incoming-webhook connector URL, or an email to a channel address.",
    options: [
      { value: "connector", label: "Connector webhook URL" },
      { value: "email", label: "Channel email address" },
    ],
    doc: { href: "https://docs.downpipes.io/integrations/microsoft-teams" },
  });

  // The destination fields (only one is shown at a time, chosen by kind + teams mode).
  const urlField = field({
    id: "channel-url",
    label: "HTTPS URL",
    required: true,
    value: existing?.url ?? "",
    placeholder: "https://hooks.slack.com/services/T…/B…/…",
    hint: "Must be https, carry no embedded credentials, and not be a workers.dev host. A private, loopback or link-local target is refused by default.",
    autocomplete: "off",
    validate: validateUrl,
    doc: { href: "https://docs.downpipes.io/day-2/notifications", anchor: "channels-where-an-alert-is-delivered" },
  });
  const routingKeyField = field({
    id: "channel-routing-key",
    label: "PagerDuty routing key",
    required: true,
    value: existing?.routingKey ?? "",
    placeholder: "R0123456789ABCDEF0123456789ABCD",
    hint: "The integration (routing) key from your PagerDuty service's Events API v2 integration.",
    autocomplete: "off",
    validate: (v) => (v.length < 1 ? "A routing key is required." : v.length > 256 ? "The routing key is at most 256 characters." : null),
    doc: { href: "https://docs.downpipes.io/integrations/pagerduty" },
  });
  const addressesField = field({
    id: "channel-addresses",
    label: "Email addresses",
    required: true,
    value: (existing?.toAddresses ?? []).join(", "),
    placeholder: "oncall@example.com, sre@example.com",
    hint: "One or more addresses, comma-separated (at most 50). Each needs a dotted custom domain, not a workers.dev address. Live email sending requires the engine's email binding to be configured.",
    autocomplete: "off",
    validate: validateAddresses,
    doc: { href: "https://docs.downpipes.io/integrations/email" },
  });

  // jsm's GenieKey token: WRITE-ONLY (destinations idiom, destination-form-fields.ts buildCredBlock),
  // so it always starts blank, even on edit (the engine's redactChannelSecretForRead never returns
  // it). Required on a fresh create (no prior credential to keep); optional on edit (KEEP-SECRET: an
  // omitted value keeps the sealed token, but ONLY if the URL above is unchanged, enforced server-side).
  // `required` is DYNAMIC here, so on the edit path it is literally false and the field carried no
  // rule at all: field.ts validates on blur only when one is present, so the 512-character bound the
  // engine enforces was unenforced on exactly the path a rotation takes. The validator covers both
  // paths; the create-only `required` is unchanged.
  const jsmApiKeyField = field({
    id: "channel-jsm-api-key",
    label: "GenieKey API token",
    type: "password",
    required: existing === null,
    validate: atMostChars({ noun: "The GenieKey API token", max: NOTIFY_API_KEY_MAX, remedy: "Paste the token exactly as Jira Service Management issued it, with no wrapping quotes." }),
    autocomplete: "off",
    placeholder: existing ? "leave blank to keep the current token" : "paste the GenieKey API token",
    hint: existing
      ? "Leave blank to keep the current token; it is kept only if the URL above is unchanged. Paste a new one to rotate it or when repointing the URL."
      : "Sent once over the authenticated channel, then sealed by your engine as \"Authorization: GenieKey <token>\". Never re-displayed.",
    doc: { href: "https://docs.downpipes.io/integrations/jira-service-management" },
  });

  // servicenow's Basic-auth username is NOT a secret, so it is always resupplied (like url), prefilled
  // on edit.
  //
  // THE 256-CHARACTER CEILING IS THE FIELD'S, not only the engine's. This field carried `required` and
  // no validator, so field.ts had no rule to run on blur and validateForm had none to run on Save: a
  // 257-character username was taken on both, and the refusal arrived from the engine as a generic
  // channel error. The bound the catalogue publishes for this field is now enforced where the operator
  // is, in the same idiom as the password field below.
  const servicenowUsernameField = field({
    id: "channel-servicenow-username",
    label: "Username",
    required: true,
    validate: atMostChars({ noun: "The username", max: NOTIFY_USERNAME_MAX, remedy: "Use the ServiceNow account name exactly as it is written in ServiceNow, for example svc_downpipes." }),
    value: existing?.username ?? "",
    autocomplete: "off",
    placeholder: "svc_downpipes",
    hint: "The ServiceNow Basic-auth account name. Not a secret; always resupplied, like the URL above.",
    doc: { href: "https://docs.downpipes.io/integrations/servicenow" },
  });

  // servicenow's Basic-auth password: the same write-only, KEEP-SECRET-on-edit treatment as jsm's token.
  const servicenowApiKeyField = field({
    id: "channel-servicenow-api-key",
    label: "Password",
    type: "password",
    required: existing === null,
    validate: atMostChars({ noun: "The password", max: NOTIFY_API_KEY_MAX, remedy: "Paste the ServiceNow account password exactly, with no wrapping quotes." }),
    autocomplete: "off",
    placeholder: existing ? "leave blank to keep the current password" : "paste the Basic-auth password",
    hint: existing
      ? "Leave blank to keep the current password; it is kept only if the URL above is unchanged. Paste a new one to rotate it or when repointing the URL."
      : "Sent as HTTP Basic auth alongside the username above, then sealed by your engine. Never re-displayed.",
    doc: { href: "https://docs.downpipes.io/integrations/servicenow" },
  });

  // Enabled is shown only on edit (a new channel starts enabled; offering "Disabled" on
  // create is a state nobody starts in) and as a one-click checkbox, not a select.
  const enabledCheck = existing ? checkboxRow("channel-enabled", "Enabled", "a disabled channel is kept but receives nothing until re-enabled", existing.enabled) : null;

  return { nameField, kindField, teamsModeField, urlField, routingKeyField, addressesField, jsmApiKeyField, servicenowUsernameField, servicenowApiKeyField, enabledCheck };
}

// wireDestinationHosts swaps the visible destination field (and the teams sub-mode toggle) as
// the kind / teams-mode changes, and primes the initial render. Moved verbatim from
// openChannelForm; the change wiring is unchanged. jsmGroup/servicenowGroup are the ADDITIONAL
// credential fields jsm/servicenow show alongside the (unchanged) url destination field, toggled
// here in the same refresh so a kind change never leaves a stale group visible.
function wireDestinationHosts(fields: ChannelFormFields, destHost: HTMLElement, teamsModeHost: HTMLElement, jsmGroup: HTMLElement, servicenowGroup: HTMLElement): void {
  const { kindField, teamsModeField, urlField, routingKeyField, addressesField } = fields;
  const refreshDest = (): void => {
    const kind = kindField.value() as ChannelKind;
    teamsModeHost.replaceChildren(kind === "teams" ? teamsModeField.el : h("span"));
    const fieldForKind = destinationFieldFor(kind, teamsModeField.value(), { urlField, routingKeyField, addressesField });
    destHost.replaceChildren(fieldForKind.el);
    jsmGroup.hidden = kind !== "jsm";
    servicenowGroup.hidden = kind !== "servicenow";
  };
  kindField.control.addEventListener("change", refreshDest);
  teamsModeField.control.addEventListener("change", refreshDest);
  refreshDest();
}

// extraFieldsForKind returns the ADDITIONAL fields to validate for jsm/servicenow (their url is
// already covered by destinationFieldFor's fallthrough); every other kind needs none. Mirrors
// push-model.ts's per-sink fieldsForSink split.
function extraFieldsForKind(kind: ChannelKind, fields: ChannelFormFields): FieldHandle[] {
  if (kind === "jsm") return [fields.jsmApiKeyField];
  if (kind === "servicenow") return [fields.servicenowUsernameField, fields.servicenowApiKeyField];
  return [];
}

// submitChannelForm validates the active destination field, upserts the channel, and reports
// the outcome (pending change, success toast, or the engine's inline refusal). Returns the
// modal onClick boolean (true closes the modal, false keeps it open with input intact). Moved
// verbatim from openChannelForm; the control flow and values are unchanged.
async function submitChannelForm(engine: EngineClient, existing: NotifyChannel | null, fields: ChannelFormFields, formError: HTMLElement, reload: () => void): Promise<boolean> {
  const { nameField, kindField, teamsModeField, urlField, routingKeyField, addressesField, enabledCheck } = fields;
  formError.hidden = true;
  const kind = kindField.value() as ChannelKind;
  const destField = destinationFieldFor(kind, teamsModeField.value(), { urlField, routingKeyField, addressesField });
  if (!validateForm([nameField, destField, ...extraFieldsForKind(kind, fields)])) return false;

  // jsm/servicenow carry an apiKey (write-only; blank on submit means keep the sealed credential) and,
  // for servicenow, a username (not a secret, always resupplied); every other kind carries neither.
  const apiKey = kind === "jsm" ? fields.jsmApiKeyField.value() : kind === "servicenow" ? fields.servicenowApiKeyField.value() : undefined;
  const username = kind === "servicenow" ? fields.servicenowUsernameField.value() : undefined;
  const input = buildChannelInputFrom(existing ? existing.id : null, nameField.value(), kind, teamsModeField.value(), destField.value(), enabledCheck ? enabledCheck.checked() : true, apiKey, username);
  try {
    const res = await engine.upsertNotifyChannel(input);
    if (res.status === "pending") surfacePendingChange("notification channel");
    else toast({ message: existing ? `Channel updated: ${input.name}` : `Channel added: ${input.name}` });
    reload();
    return true;
  } catch (err) {
    if (isUnauthorised(err)) {
      goSignedOut();
      return true;
    }
    // The engine validated and refused (bad url / address): show its reason inline.
    formError.textContent = isStepUpRequired(err) ? `The channel was not saved. ${stepUpAwareText(err)}` : `The engine refused the channel (${errText(err)}).`;
    formError.hidden = false;
    return false;
  }
}

// openChannelForm is the add/edit-channel modal (notify.config). It shows ONLY the field
// the selected kind carries (url / routing key / addresses) and validates it client-side
// the same way the engine does (https, no userinfo, not workers.dev; validated email
// addresses); a malformed channel the engine rejects comes back as a 400 { error } shown
// inline. Input is never lost on a refusal.
export function openChannelForm(engine: EngineClient, existing: NotifyChannel | null, reload: () => void, lockedKind?: ChannelKind): void {
  const fields = buildChannelFormFields(existing, lockedKind);
  // When opened from an Integrations vendor tile, the kind is LOCKED to that vendor: hide the kind selector so
  // the form is that vendor's, not a generic channel form you could switch to another product. The kind value
  // is already fixed to lockedKind above, so submit reads it unchanged; only the picker is removed.
  if (lockedKind) fields.kindField.el.hidden = true;

  // The destination host swaps the visible field as the kind / teams-mode changes. jsmGroup and
  // servicenowGroup are the ADDITIONAL credential fields shown alongside it for those two kinds only
  // (both start hidden; wireDestinationHosts corrects the visibility for the initial kind immediately,
  // including on edit, before the modal ever paints).
  const destHost = h("div");
  const teamsModeHost = h("div");
  const jsmGroup = h("div", { class: "stack-sm", hidden: true }, fields.jsmApiKeyField.el);
  const servicenowGroup = h("div", { class: "stack-sm", hidden: true }, fields.servicenowUsernameField.el, fields.servicenowApiKeyField.el);
  wireDestinationHosts(fields, destHost, teamsModeHost, jsmGroup, servicenowGroup);

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const body = h(
    "form",
    { class: "form-stack", style: "display:grid;gap:var(--space-4)", "aria-label": existing ? `Edit channel ${existing.name}` : "Add a channel", on: { submit: (ev: Event) => ev.preventDefault() } },
    fields.nameField.el,
    fields.kindField.el,
    teamsModeHost,
    destHost,
    jsmGroup,
    servicenowGroup,
    fields.enabledCheck ? fields.enabledCheck.el : false,
    // THE CEREMONY, named before the button rather than discovered after it. A channel decides where an
    // alert is delivered, so the engine treats saving one as a detection-config change and demands a fresh
    // identity check; the prompt opens on Save, after the form is filled in.
    h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey when you save. If you dismiss that prompt, or it fails, nothing is saved and what you have typed stays in this form."),
    formError,
  );

  openModal({
    title: existing ? `Edit channel: ${existing.name}` : "Add a channel",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Save channel",
        variant: "primary",
        busyLabel: "Saving",
        onClick: () => submitChannelForm(engine, existing, fields, formError, reload),
      },
    ],
  });
}
