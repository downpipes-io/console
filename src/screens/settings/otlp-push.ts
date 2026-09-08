// The outbound OTLP/HTTP metrics push panel: a Settings disclosure adjacent to the metrics scrape
// scope (settings/support.ts renderPullCredentials) and the SIEM audit-log push panel
// (settings/push.ts), so the console's three ways to get monitoring/observability data out sit
// together. Unlike a Prometheus scrape (a PULL target the
// collector reaches in), this engine dials OUT to a customer OTLP/HTTP collector on the cron tick,
// zero-agent. OTLP-JSON is confirmed for Datadog only: Dynatrace, Elastic and Splunk Observability
// accept OTLP as protobuf only and reject JSON outright, so their collector should read the metrics
// scrape endpoint instead. New Relic's OTLP-JSON support is unconfirmed in its own docs and is not
// claimed here.
//
// The auth secret is a WRITE-ONLY field (the destinations idiom, destination-form-fields.ts
// buildCredBlock, mirrored exactly by the SIEM push panel's own secretField): it always starts
// BLANK, is never prefilled with the stored secret, and the engine never returns it. Owner-gated
// (disabled-with-reason, never hidden), change-management aware, dual-control aware (a set/replace
// can be queued for a second owner; a clear cannot be, closing an egress is the safe direction).
// There is no test-send (unlike the SIEM push): the engine exposes no /admin/otlp-push/test route.
//
// This module is the DOM half; the pure, node-testable model + presentation logic lives in
// ./otlp-push-model.ts (split along the max-lines seam), mirroring settings/push.ts + push-model.ts.
// test/validate-otlp-push.ts drives the model through settings.ts's re-exports.
//
// House style: Australian English, no em dashes, precise claims (this is a snapshot push, not a
// guaranteed delivery).

import type { EngineClient, OtlpPushDestinationView } from "../../api.ts";
import { isOwnerActionQueuedResult } from "../../api.ts";
import { blockError, SESSION_ENDED_ACTION, sessionEnded, stepUpAwareText } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { type Field, field, validateForm } from "../../components/field.ts";
import { HTTP_HEADER_NAME_PATTERN, matchingPattern, pushAuthSecret } from "../../components/field-bounds.ts";
import { confirmModal } from "../../components/modal.ts";
import { requireChange } from "../../components/require-change.ts";
import { statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isStepUpRequired, isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { canDo, gateReason } from "../common.ts";
import { checkboxRow } from "../notifications/shared.ts";
import {
  buildOtlpPushSubmission,
  buildOtlpToggleSubmission,
  OTLP_TOGGLE_UNRECONSTRUCTABLE,
  type OtlpPushFormFields,
  otlpPushDetailLine,
  otlpPushDialsOutNote,
  otlpPushStatePresentation,
  otlpTrailLines,
  otlpTrailSummary,
  validateOtlpPushEndpoint,
} from "./otlp-push-model.ts";

// ---------------------------------------------------------------------------------------------------
// renderOtlpPushDestination: the disclosure body. The read is any authenticated role (mirrors
// getPush/getDestination/getSupport); the mutating controls are Owner-gated as disabled-with-reason.
// ---------------------------------------------------------------------------------------------------

export function renderOtlpPushDestination(engine: EngineClient): HTMLElement {
  const card = h("div");
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Pushes the canonical backup-health metric snapshot (last-success timestamp, success flag, recent attempt/success/failure counts, duration, size, per-destination health) to your OTLP/HTTP collector on the scheduler tick, no agent required. Confirmed for Datadog's OTLP-JSON intake. Dynatrace, Elastic and Splunk Observability accept OTLP as protobuf only and reject JSON: point their collector at the Prometheus /metrics scrape endpoint instead. Every enabled tick sends the current snapshot fresh; a missed tick is a gap in your own time series, never a backlog.",
    ),
  );
  card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, otlpPushDialsOutNote()));

  const stateHost = h("div", { style: "margin-top:var(--space-3)" });
  const formHost = h("div", { style: "margin-top:var(--space-3)" });
  card.appendChild(stateHost);
  card.appendChild(formHost);

  const refresh = (): void => {
    stateHost.replaceChildren(skeletonRows(2));
    formHost.replaceChildren();
    void engine
      .getOtlpPush()
      .then((view: OtlpPushDestinationView) => {
        if (!card.isConnected) return;
        stateHost.replaceChildren(renderOtlpPushState({ engine, view, refresh, formHost }));
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the state host is a skeleton until this replaces it. The liveness
          // check stays BELOW the paint, because a detached card needs no paint and this one may not be.
          if (card.isConnected) stateHost.replaceChildren(sessionEnded(refresh));
          return goSignedOut();
        }
        if (!card.isConnected) return;
        stateHost.replaceChildren(blockError(err, refresh));
      });
  };
  refresh();

  return card;
}

interface OtlpPushStateCtx {
  engine: EngineClient;
  view: OtlpPushDestinationView;
  refresh: () => void;
  formHost: HTMLElement;
}

// renderOtlpPushState renders the current redaction-safe view (state, header name, who/when, trail)
// plus the owner-gated controls. The engine enforces the Owner gate server-side; this mirror only
// decides what to offer (disabled-with-reason, never hidden).
function renderOtlpPushState(ctx: OtlpPushStateCtx): HTMLElement {
  const { engine, view, refresh, formHost } = ctx;
  const wrap = h("div");

  const state = otlpPushStatePresentation(view);
  wrap.appendChild(statusWithLabel(state.tone, state.label));

  if (view.present) {
    const detail = otlpPushDetailLine(view);
    const who = view.setBy != null ? ` Set by ${view.setBy}${view.setAt ? ` on ${view.setAt}` : ""}.` : "";
    wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, `${detail}${who}`));

    wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, otlpTrailSummary(view.trail)));
    const lines = otlpTrailLines(view.trail);
    if (lines.length > 0) {
      const list = h("div", { style: "margin-top:var(--space-1);display:flex;flex-direction:column;gap:2px" });
      for (const line of lines) list.appendChild(statusWithLabel(line.tone, line.text));
      wrap.appendChild(list);
    }
  }

  const controlsHost = h("div", { style: "margin-top:var(--space-3)" });
  wrap.appendChild(controlsHost);

  if (!canDo("owner")) {
    controlsHost.appendChild(
      h(
        "p",
        { class: "field__hint" },
        gateReason("owner"),
        " Configuring, enabling, replacing or clearing the OTLP push destination requires the Owner role; the engine enforces this server-side.",
      ),
    );
    return wrap;
  }

  const errorHost = h("div", { style: "margin-top:var(--space-2)" });
  const btnRow = h("div", { style: "display:flex;flex-wrap:wrap;gap:var(--space-2)" });

  if (!view.present) {
    const configureBtn = h("button", { "data-dp": "settings.button.configure#1", class: "btn btn--secondary btn--sm", type: "button" }, "Configure") as HTMLButtonElement;
    configureBtn.addEventListener("click", () => openOtlpPushForm({ engine, mode: "configure", refresh, formHost }));
    btnRow.appendChild(configureBtn);
  } else {
    const replaceBtn = h("button", { "data-dp": "settings.button.replace#1", class: "btn btn--secondary btn--sm", type: "button" }, "Replace") as HTMLButtonElement;
    replaceBtn.addEventListener("click", () => openOtlpPushForm({ engine, mode: "replace", current: view, refresh, formHost }));
    btnRow.appendChild(replaceBtn);

    const toggleBtn = h("button", { "data-dp": "settings.button.otlp-push-state", class: "btn btn--secondary btn--sm", type: "button" }, view.enabled ? "Disable" : "Enable") as HTMLButtonElement;
    toggleBtn.addEventListener("click", () => void toggleEnabled({ engine, view, refresh, btn: toggleBtn, errorHost }));
    btnRow.appendChild(toggleBtn);

    const clearBtn = h("button", { "data-dp": "settings.button.clear#1", class: "btn btn--secondary btn--sm", type: "button" }, "Clear") as HTMLButtonElement;
    clearBtn.addEventListener("click", () => void clearOtlpPushDestination({ engine, refresh, btn: clearBtn, errorHost }));
    btnRow.appendChild(clearBtn);
  }

  controlsHost.appendChild(btnRow);
  controlsHost.appendChild(errorHost);
  return wrap;
}

// toggleEnabled flips enabled without touching the sealed secret (buildOtlpToggleSubmission omits
// the secret, so the engine keeps the sealed one). Confirmed either direction, change-management
// aware, dual-control aware.
async function toggleEnabled(opts: { engine: EngineClient; view: OtlpPushDestinationView; refresh: () => void; btn: HTMLButtonElement; errorHost: HTMLElement }): Promise<void> {
  const { engine, view, refresh, btn, errorHost } = opts;
  const enabling = view.enabled !== true;
  const input = buildOtlpToggleSubmission(view, enabling);
  if (!input) {
    // The redacted view carries no endpoint, so a set cannot be reconstructed from it. Say so before
    // the confirm (never confirm an action that cannot happen), rather than submitting a fabricated
    // empty endpoint that would refuse or, worse, overwrite the stored one.
    errorHost.replaceChildren(h("p", { class: "field__error" }, OTLP_TOGGLE_UNRECONSTRUCTABLE));
    return;
  }
  const ok = await confirmModal({
    title: enabling ? "Enable the OTLP metrics push?" : "Disable this OTLP push destination?",
    body: enabling
      ? "The engine starts pushing the metric snapshot to this destination on the next scheduler tick. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes and you can start again."
      : "The engine stops pushing immediately. The configuration, sealed secret and delivery trail are kept, so re-enabling later needs no reconfiguration. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes and you can start again.",
    confirmLabel: enabling ? "Enable" : "Disable",
  });
  if (!ok) return;
  const cr = await requireChange(engine, enabling ? "Enable the OTLP metrics push destination" : "Disable the OTLP metrics push destination", "otlp-toggle");
  if (!cr.proceed) return;
  btn.disabled = true;
  errorHost.replaceChildren();
  try {
    const res = await engine.setOtlpPush(input, cr.change ?? undefined);
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction(enabling ? "Enabling the OTLP push destination" : "Disabling the OTLP push destination");
      btn.disabled = false;
      return;
    }
    toast({ message: enabling ? "OTLP push destination enabled." : "OTLP push destination disabled." });
    refresh();
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the toggle did not apply, so the control comes back.
      btn.disabled = false;
      return goSignedOut();
    }
    errorHost.replaceChildren(blockError(err, () => btn.click()));
    btn.disabled = false;
  }
}

// clearOtlpPushDestination confirms (danger: deletes the config, the sealed secret and the trail),
// then requireChange, then clears. No dual control server-side (closing an egress is the safe
// direction), but change management still applies.
async function clearOtlpPushDestination(opts: { engine: EngineClient; refresh: () => void; btn: HTMLButtonElement; errorHost: HTMLElement }): Promise<void> {
  const { engine, refresh, btn, errorHost } = opts;
  const ok = await confirmModal({
    title: "Clear the OTLP push destination?",
    body: "This deletes the configuration, the sealed secret and the delivery trail. The engine stops pushing immediately; reconfiguring later needs the destination and a fresh secret. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is cleared and the destination still works.",
    confirmLabel: "Clear",
    variant: "danger",
  });
  if (!ok) return;
  const cr = await requireChange(engine, "Clear the OTLP metrics push destination", "otlp-clear");
  if (!cr.proceed) return;
  btn.disabled = true;
  errorHost.replaceChildren();
  try {
    await engine.clearOtlpPush(cr.change ?? undefined);
    toast({ message: "OTLP push destination cleared." });
    refresh();
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: nothing was cleared, so Clear must be pressable again.
      btn.disabled = false;
      return goSignedOut();
    }
    errorHost.replaceChildren(blockError(err, () => btn.click()));
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------------
// The configure/replace form: endpoint URL + auth header name + write-only auth secret + enabled.
// Unlike the SIEM push form there is no sink or format selector (OTLP push is always one shape).
// ---------------------------------------------------------------------------------------------------

interface OtlpPushFormOpts {
  engine: EngineClient;
  mode: "configure" | "replace";
  current?: OtlpPushDestinationView;
  refresh: () => void;
  formHost: HTMLElement;
}

function openOtlpPushForm(opts: OtlpPushFormOpts): void {
  const { engine, mode, current, refresh, formHost } = opts;

  const endpointField = field({
    id: "otlp-push-endpoint",
    label: "Endpoint URL",
    required: true,
    autocomplete: "off",
    placeholder: "https://otlp.datadoghq.com/v1/metrics",
    value: current?.endpoint ?? "",
    hint: "Your OTLP-JSON collector's metrics ingest endpoint. https only, screened like a webhook (no embedded credentials, not a workers.dev host, and a private or cloud-metadata address refused by default). Confirmed for Datadog; Dynatrace, Elastic and Splunk Observability accept OTLP as protobuf only and reject JSON, so point their collector at the Prometheus /metrics scrape endpoint instead.",
    validate: validateOtlpPushEndpoint,
    doc: { href: "https://docs.downpipes.io/day-2/otlp-metrics-push", anchor: "setting-up-the-destination" },
  });
  endpointField.control.classList.add("mono");
  const endpointSiteNote = h(
    "p",
    { class: "field__hint" },
    "Datadog's OTLP intake is per site: the placeholder above is the US1 host. On eu, us3, us5 or ap1, use otlp.<site-host> instead, for example otlp.datadoghq.eu.",
  );

  const headerNameField = field({
    id: "otlp-push-header-name",
    label: "Auth header name",
    placeholder: "DD-API-KEY",
    value: current?.authHeaderName ?? "Authorization",
    autocomplete: "off",
    hint: 'The HTTP header the engine sends the secret in, for example "Authorization" or "DD-API-KEY". Blank defaults to Authorization.',
    // BLANK IS VALID and must stay so: the engine substitutes "Authorization" for an empty name
    // (router-push.ts / router-otlp-push.ts), so refusing blank here would refuse a documented,
    // working input. Only a TYPED name is checked, against the engine's own character set and
    // length, so the console cannot accept a name the engine would answer with a 400.
    validate: matchingPattern({
      pattern: HTTP_HEADER_NAME_PATTERN,
      rule: "The auth header name must be 100 characters or fewer, using only the characters an HTTP header name allows (no spaces, colons or quotes).",
      remedy: "Type a header name such as DD-API-KEY, or leave it blank to send Authorization.",
    }),
    doc: { href: "https://docs.downpipes.io/day-2/otlp-metrics-push", anchor: "setting-up-the-destination" },
  });
  headerNameField.control.classList.add("mono");

  // The write-only secret field: the destinations idiom (destination-form-fields.ts buildCredBlock).
  // It ALWAYS starts blank, even when replacing: the engine never returns the stored secret.
  const secretField = field({
    id: "otlp-push-secret",
    label: "Auth secret",
    type: "password",
    required: true, validate: pushAuthSecret({ noun: "auth secret" }),
    autocomplete: "off",
    placeholder: mode === "replace" ? "paste the new secret" : "paste the header's secret value",
    hint: "Sent once over the authenticated channel, then sealed by your engine. Never re-displayed; leaving this page clears it from the console.",
    doc: { href: "https://docs.downpipes.io/day-2/otlp-metrics-push", anchor: "setting-up-the-destination" },
  });

  const enabledRow = checkboxRow("otlp-push-enabled", "Enabled", "Pushes to this destination on the scheduler tick once saved.", current?.enabled ?? true);

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const saveBtn = h("button", { "data-busy-label": "Saving", "data-dp": "settings.button.save#1", class: "btn btn--primary", type: "button" }, mode === "replace" ? "Replace" : "Configure") as HTMLButtonElement;
  const cancelBtn = h("button", { "data-dp": "settings.button.cancel#1", class: "btn btn--secondary", type: "button" }, "Cancel") as HTMLButtonElement;

  const formEl = h(
    "form",
    { class: "form-stack", "aria-label": "Configure the OTLP push destination", on: { submit: (ev: Event) => ev.preventDefault() } },
    endpointField.el,
    endpointSiteNote,
    headerNameField.el,
    secretField.el,
    enabledRow.el,
    h("div", { class: "dialog__actions", style: "align-items:center" }, formError, cancelBtn, saveBtn),
  );

  cancelBtn.addEventListener("click", () => formHost.replaceChildren());

  saveBtn.addEventListener("click", () =>
    void submitOtlpPushForm({
      engine,
      mode,
      endpointField,
      headerNameField,
      secretField,
      enabled: () => enabledRow.checked(),
      formError,
      saveBtn,
      refresh,
      formHost,
    }),
  );

  formHost.replaceChildren(formEl);
  endpointField.focus();
}

interface OtlpPushFormSubmitCtx {
  engine: EngineClient;
  mode: "configure" | "replace";
  endpointField: Field;
  headerNameField: Field;
  secretField: Field;
  enabled: () => boolean;
  formError: HTMLElement;
  saveBtn: HTMLButtonElement;
  refresh: () => void;
  formHost: HTMLElement;
}

// submitOtlpPushForm validates, names the replace consequence before the save (a fresh configure has
// no old secret to kill, so it saves straight away, mirroring the SIEM push form's split), then
// change management, then the save itself. The write-only secret is required on BOTH configure and
// replace (the SIEM push panel's long-standing "a replace re-supplies the secret" convention; the
// engine's keep-secret path is used only by the lightweight enable/disable toggle above).
async function submitOtlpPushForm(ctx: OtlpPushFormSubmitCtx): Promise<void> {
  const { engine, mode, formError, saveBtn, refresh, formHost } = ctx;
  formError.hidden = true;
  // headerNameField was NOT in this list, so its matchingPattern rule was blur-only: the value was read raw
  // at submit and posted. A header name the field had already marked bad drew a late engine 400 instead of
  // the field's own message, and a whitespace-only one was normalised to the empty string by the model and
  // then silently substituted with "Authorization" (engine/src/admin/router-otlp-push.ts:47-48), so telemetry
  // went out under a header the operator did not choose and nothing said so.
  if (!validateForm([ctx.endpointField, ctx.headerNameField, ctx.secretField])) return;

  if (mode === "replace") {
    const ok = await confirmModal({
      title: "Replace the OTLP push destination?",
      body: "Replacing sets a new secret; the old one stops working immediately. Metrics already pushed are unaffected. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is replaced and the current secret still works.",
      confirmLabel: "Replace",
    });
    if (!ok) return;
  }

  const cr = await requireChange(engine, mode === "replace" ? "Replace the OTLP metrics push destination" : "Configure the OTLP metrics push destination", "otlp-upsert");
  if (!cr.proceed) return;

  const fields: OtlpPushFormFields = {
    endpoint: ctx.endpointField.value(),
    authHeaderName: ctx.headerNameField.value(),
    authHeaderValue: ctx.secretField.value(),
  };
  const input = buildOtlpPushSubmission(fields, ctx.enabled());

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving";
  try {
    const res = await engine.setOtlpPush(input, cr.change ?? undefined);
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction(mode === "replace" ? "Replacing the OTLP push destination" : "Configuring the OTLP push destination");
      formHost.replaceChildren();
      refresh();
      return;
    }
    toast({ message: mode === "replace" ? "OTLP push destination replaced." : "OTLP push destination configured." });
    formHost.replaceChildren();
    refresh();
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the destination was NOT saved, so Save goes back to being pressable
      // instead of sitting on "Saving" over a form the operator will return to after re-auth.
      formError.textContent = SESSION_ENDED_ACTION;
      formError.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = mode === "replace" ? "Replace" : "Configure";
      return goSignedOut();
    }
    formError.textContent = errMsg(err);
    formError.hidden = false;
    saveBtn.disabled = false;
    saveBtn.textContent = mode === "replace" ? "Replace" : "Configure";
  }
}

function errMsg(err: unknown): string {
  // A cancelled step-up ceremony throws the internal marker ("<verb>: stepup-required: 401"), which is not
  // an engine reason at all: the engine never judged this request and nothing was written. Give that one
  // state the reviewed advice and leave every other message exactly as it was.
  if (isStepUpRequired(err)) return stepUpAwareText(err);
  return err instanceof Error ? err.message : String(err);
}
