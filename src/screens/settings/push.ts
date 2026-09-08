// The outbound audit-log push (SIEM) panel: a Settings disclosure adjacent to the pull credentials
// (settings/support.ts renderPullCredentials), so pull and push sit together as the two ways to get the
// audit trail out (design/siem-push/SIEM-PUSH-DESIGN.md + design/siem-top20/FORMATS-AND-TRANSPORT.md).
// Delivery rides one of three sinks (design/siem-top20): an HTTPS endpoint, an S3 bucket the SIEM reads, or a
// syslog-over-TLS listener. Every secret (the http auth header value, and the S3-drop secret access key) is a
// WRITE-ONLY field (the destinations idiom, destination-form-fields.ts buildCredBlock): it always starts
// BLANK, is never prefilled with the stored secret, and the engine never returns it. Owner-gated
// (disabled-with-reason, never hidden), change-management aware, dual-control aware (a set/replace can be
// queued for a second owner; a clear cannot be, closing an egress is the safe direction).
//
// This module is the DOM half; the pure, node-testable model + presentation logic lives in ./push-model.ts
// (split along the max-lines seam). test/validate-push.ts drives the model through settings.ts's re-exports.
//
// House style: Australian English, no em dashes, precise claims (this is at-least-once delivery, never
// "guaranteed").

import type { EngineClient, PushDestinationView, PushFormat, PushSink } from "../../api.ts";
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
import { canDo, gateReason, refuseWithReason } from "../common.ts";
import { checkboxRow } from "../notifications/shared.ts";
import {
  buildPushSubmission,
  buildToggleSubmission,
  canTogglePush,
  PUSH_FORMAT_OPTIONS,
  PUSH_SINK_OPTIONS,
  PUSH_TOGGLE_UNRECONSTRUCTABLE,
  type PushFormFields,
  pushDestinationDetailLine,
  pushDialsOutNote,
  pushLagPresentation,
  pushStatePresentation,
  pushTestOutcomeCopy,
  pushTrailLines,
  pushTrailSummary,
  validatePushEndpoint,
  validatePushFormatSink,
  validateSyslogHost,
  validateSyslogPort,
} from "./push-model.ts";

// DEFAULT_SYSLOG_PORT is the form's placeholder/default (RFC 5425 syslog-over-TLS); the model's parseSyslogPort
// applies the same fallback on the wire.
const DEFAULT_SYSLOG_PORT = 6514;

// ---------------------------------------------------------------------------------------------------
// renderPushDestination: the disclosure body. The read is any authenticated role (mirrors
// getDestination/getSupport); the mutating controls are Owner-gated as disabled-with-reason.
// ---------------------------------------------------------------------------------------------------

export function renderPushDestination(engine: EngineClient, lock?: PushLock, isOwn?: (view: PushDestinationView) => boolean, vendorName?: string): HTMLElement {
  const card = h("div");
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Pushes the same hash-chained audit events your SIEM can pull, over an HTTPS endpoint, an S3 drop or syslog over TLS, on the scheduler tick: at least once, never exactly once (a SIEM dedups on seq or hash). It carries operator identity (emails, source IPs, roles); no key, no secret value, no customer data.",
    ),
  );
  card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, pushDialsOutNote()));

  const stateHost = h("div", { style: "margin-top:var(--space-3)" });
  const formHost = h("div", { style: "margin-top:var(--space-3)" });
  card.appendChild(stateHost);
  card.appendChild(formHost);

  const refresh = (): void => {
    stateHost.replaceChildren(skeletonRows(2));
    formHost.replaceChildren();
    void engine
      .getPush()
      .then((view: PushDestinationView) => {
        if (!card.isConnected) return;
        stateHost.replaceChildren(renderPushState({ engine, view, refresh, formHost, lock, isOwn, vendorName }));
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

// PushLock is what an Integrations vendor tile fixes about the form: the wire (format + sink), the OPAQUE
// destination-identity tag stored with the config so the console never has to infer the vendor from the wire
// again, and the credential SCHEME + label + example this vendor's token must carry. The credential fields are
// the vendor's, not the format's: CrowdStrike Falcon Next-Gen SIEM shares splunk-hec over http with Splunk and
// takes a plain bearer token, so a format-keyed rule put Splunk's instruction on Falcon's form.
export interface PushLock {
  format: PushFormat;
  sink: PushSink;
  vendor?: string | undefined;
  credLabel?: string | undefined;
  credScheme?: string | undefined;
  credExample?: string | undefined;
}

interface PushStateCtx {
  engine: EngineClient;
  view: PushDestinationView;
  refresh: () => void;
  formHost: HTMLElement;
  lock?: PushLock | undefined;
  // isOwn: does the live push belong to THIS tile's vendor? vendorName: for the copy. Both set from an
  // Integrations vendor tile; absent on any other caller (which then behaves as the single-destination view).
  isOwn?: ((view: PushDestinationView) => boolean) | undefined;
  vendorName?: string | undefined;
}

// renderPushState renders the current redaction-safe view (state, format/sink, who/when, cursor lag, trail)
// plus the owner-gated controls. The engine enforces the Owner gate server-side; this mirror only decides
// what to offer (disabled-with-reason, never hidden).
function renderPushState(ctx: PushStateCtx): HTMLElement {
  const { engine, view, refresh, formHost, lock, isOwn, vendorName } = ctx;
  const wrap = h("div");

  // The push is a SINGLE destination, but each Integrations SIEM tile mounts this panel. `owned` is true only
  // when the live push actually belongs to THIS tile's vendor (isOwn reads the config's own destination-identity
  // tag, falling back to the wire only for a config stored before that tag existed), so a tile that is not the
  // active one never renders the active config as if it were its own.
  const owned = view.present && (isOwn ? isOwn(view) : true);
  const otherActive = view.present && !owned;

  if (owned) {
    const s = pushStatePresentation(view);
    wrap.appendChild(statusWithLabel(s.tone, s.label));
  } else {
    wrap.appendChild(statusWithLabel("neutral", vendorName ? `${vendorName} is not set up` : "Not set up"));
    if (otherActive) {
      wrap.appendChild(h("div", { style: "margin-top:var(--space-1)" },
        statusWithLabel("warn", `A different destination is currently active. The audit-log push delivers to a single destination, so setting up ${vendorName ?? "this one"} replaces it.`)));
    }
  }

  if (owned) {
    const detail = pushDestinationDetailLine(view);
    const who = view.setBy != null ? ` Set by ${view.setBy}${view.setAt ? ` on ${view.setAt}` : ""}.` : "";
    wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, `${detail}${who}`));

    const lag = pushLagPresentation(view);
    wrap.appendChild(h("div", { style: "margin-top:var(--space-2)" }, statusWithLabel(lag.tone, lag.label)));

    wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, pushTrailSummary(view.trail)));
    const lines = pushTrailLines(view.trail);
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
        " Configuring, enabling, replacing or clearing the push destination requires the Owner role; the engine enforces this server-side.",
      ),
    );
    return wrap;
  }

  const errorHost = h("div", { style: "margin-top:var(--space-2)" });
  const testHost = h("div", { style: "margin-top:var(--space-2)", role: "status", "aria-live": "polite" });
  const btnRow = h("div", { style: "display:flex;flex-wrap:wrap;gap:var(--space-2)" });

  if (!owned) {
    // Not the active vendor (or nothing configured): the only action is to set THIS vendor up. It is a fresh
    // "configure" with this vendor's locked format, which replaces the singleton if another destination is live.
    const configureBtn = h("button", { "data-dp": "settings.button.configure#2", class: "btn btn--secondary btn--sm", type: "button" }, `Set up ${vendorName ?? "this destination"}`) as HTMLButtonElement;
    configureBtn.addEventListener("click", () => openPushForm({ engine, mode: "configure", refresh, formHost, lock }));
    btnRow.appendChild(configureBtn);
  } else {
    const replaceBtn = h("button", { "data-dp": "settings.button.replace#2", class: "btn btn--secondary btn--sm", type: "button" }, "Replace") as HTMLButtonElement;
    replaceBtn.addEventListener("click", () => openPushForm({ engine, mode: "replace", current: view, refresh, formHost, lock }));
    btnRow.appendChild(replaceBtn);

    const toggleBtn = h("button", { "data-dp": "settings.button.push-state", class: "btn btn--secondary btn--sm", type: "button" }, view.enabled ? "Disable" : "Enable") as HTMLButtonElement;
    if (canTogglePush(view)) {
      toggleBtn.addEventListener("click", () => void toggleEnabled({ engine, view, refresh, btn: toggleBtn, errorHost }));
    } else {
      // The s3 sink cannot be toggled from the redacted view (it carries no access key id); Replace re-collects
      // it. Refused-with-reason, never hidden, and the reason is text rather than a hover string because the
      // operator most likely to hit this is on a phone chasing a delivery failure.
      refuseWithReason(toggleBtn, "Enabling or disabling an S3-drop destination re-collects the access key; use Replace.");
    }
    btnRow.appendChild(toggleBtn);

    const testBtn = h("button", { "data-dp": "settings.button.test", class: "btn btn--secondary btn--sm", type: "button" }, "Test send") as HTMLButtonElement;
    testBtn.addEventListener("click", () => void runTestSend({ engine, btn: testBtn, host: testHost }));
    btnRow.appendChild(testBtn);

    const clearBtn = h("button", { "data-dp": "settings.button.clear#2", class: "btn btn--secondary btn--sm", type: "button" }, "Clear") as HTMLButtonElement;
    clearBtn.addEventListener("click", () => void clearPushDestination({ engine, refresh, btn: clearBtn, errorHost }));
    btnRow.appendChild(clearBtn);
  }

  controlsHost.appendChild(btnRow);
  // THE CEREMONY, named before the button rather than discovered after it. Test send is the least
  // consequential control here and it is still gated, because the engine treats "make this destination
  // receive something" as part of the same egress-redirection threat as pointing it somewhere new. That is
  // exactly why it needs saying: a credential sheet on a button that changes nothing reads as a fault.
  controlsHost.appendChild(
    h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey on any of these, including Test send. If you dismiss that prompt, or it fails, nothing is sent and no configuration is changed."),
  );
  controlsHost.appendChild(testHost);
  controlsHost.appendChild(errorHost);
  return wrap;
}

// toggleEnabled flips enabled without touching the sealed secret (buildToggleSubmission omits every secret,
// so the engine keeps the sealed one). Confirmed either direction (design: "Enable/disable ... each
// confirmed"), change-management aware, dual-control aware. Offered only for the sinks canTogglePush allows.
async function toggleEnabled(opts: { engine: EngineClient; view: PushDestinationView; refresh: () => void; btn: HTMLButtonElement; errorHost: HTMLElement }): Promise<void> {
  const { engine, view, refresh, btn, errorHost } = opts;
  const enabling = view.enabled !== true;
  const input = buildToggleSubmission(view, enabling);
  if (!input) {
    // The view could not be reconstructed into a set (an s3 sink, or an http sink whose redacted view
    // carries no endpoint). The button used to return here in SILENCE, so the operator clicked Enable
    // and nothing at all happened, with no error, no toast and nothing in the pack. Say what is wrong
    // and name the one control that fixes it.
    errorHost.replaceChildren(h("p", { class: "field__error" }, PUSH_TOGGLE_UNRECONSTRUCTABLE));
    return;
  }
  const ok = await confirmModal({
    title: enabling ? "Enable push to this SIEM?" : "Disable this push destination?",
    body: enabling
      ? "The engine starts draining the audit log to this destination on the next scheduler tick. It carries operator identity (emails, source IPs, roles); no key, no secret value, no customer data. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes and you can start again."
      : "The engine stops draining to it immediately. The configuration, sealed secret and delivery trail are kept, so re-enabling later needs no reconfiguration. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing changes and you can start again.",
    confirmLabel: enabling ? "Enable" : "Disable",
  });
  if (!ok) return;
  const cr = await requireChange(engine, enabling ? "Enable the SIEM push destination" : "Disable the SIEM push destination", "push-toggle");
  if (!cr.proceed) return;
  btn.disabled = true;
  errorHost.replaceChildren();
  try {
    const res = await engine.setPush(input, cr.change ?? undefined);
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction(enabling ? "Enabling the push destination" : "Disabling the push destination");
      btn.disabled = false;
      return;
    }
    toast({ message: enabling ? "Push destination enabled." : "Push destination disabled." });
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

// runTestSend calls testPush and reports the honest outcome inline (no confirm: it is non-destructive and
// changes no configuration, mirroring testEmailDelivery / testNotifyChannel / testSavedIdpConnection).
async function runTestSend(opts: { engine: EngineClient; btn: HTMLButtonElement; host: HTMLElement }): Promise<void> {
  const { engine, btn, host } = opts;
  btn.disabled = true;
  host.replaceChildren(skeletonRows(1));
  try {
    const res = await engine.testPush();
    host.replaceChildren(statusWithLabel(res.ok ? "ok" : "danger", pushTestOutcomeCopy(res)));
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE: the finally below frees the button, but the result host is holding a
      // skeleton row this handler seeded and only this handler replaces.
      host.replaceChildren(statusWithLabel("neutral", "Your session ended before the test send finished. Sign in again and retry."));
      return goSignedOut();
    }
    host.replaceChildren(blockError(err, () => btn.click()));
  } finally {
    btn.disabled = false;
  }
}

// clearPushDestination confirms (danger: deletes the config, the sealed secret and the trail), then
// requireChange, then clears. No dual control server-side (closing an egress is the safe direction), but
// change management still applies (it is still a config-changing action the owner may want a CR for).
async function clearPushDestination(opts: { engine: EngineClient; refresh: () => void; btn: HTMLButtonElement; errorHost: HTMLElement }): Promise<void> {
  const { engine, refresh, btn, errorHost } = opts;
  const ok = await confirmModal({
    title: "Clear the push destination?",
    body: "This deletes the configuration, the sealed secret and the delivery trail. The engine stops draining immediately; reconfiguring later needs the destination and a fresh secret. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is cleared and the destination still works.",
    confirmLabel: "Clear",
    variant: "danger",
  });
  if (!ok) return;
  const cr = await requireChange(engine, "Clear the SIEM push destination", "push-clear");
  if (!cr.proceed) return;
  btn.disabled = true;
  errorHost.replaceChildren();
  try {
    await engine.clearPush(cr.change ?? undefined);
    toast({ message: "Push destination cleared." });
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
// The configure/replace form: a sibling of the destination form (destination-form.ts). A sink selector
// (HTTP endpoint / S3 bucket / Syslog over TLS) reveals exactly that sink's fields; the format select and
// the enabled checkbox are shared. Mounted into the stable formHost sibling so the state block above can
// rebuild freely without dropping an open form.
// ---------------------------------------------------------------------------------------------------

interface PushFormOpts {
  engine: EngineClient;
  mode: "configure" | "replace";
  current?: PushDestinationView;
  refresh: () => void;
  formHost: HTMLElement;
  // Set when opened from an Integrations vendor tile: the wire format + sink are FIXED to that vendor's, so the
  // form is that vendor's (its endpoint + credential), not a generic picker you could set to another SIEM's wire.
  // It also carries the vendor's identity tag and its credential scheme (see PushLock).
  lock?: PushLock | undefined;
}

function openPushForm(opts: PushFormOpts): void {
  const { engine, mode, current, refresh, formHost, lock } = opts;

  const sinkField = field({
    id: "push-sink",
    label: "Delivery",
    kind: "select",
    value: lock?.sink ?? current?.sink ?? "http",
    options: PUSH_SINK_OPTIONS,
    hint: "How the engine delivers each batch: dial out to an HTTPS endpoint, drop an NDJSON object into an S3 bucket your SIEM reads, or send CEF/LEEF over syslog (TLS).",
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "the-three-sinks" },
  });

  const formatField = field({
    id: "push-format",
    label: "Format",
    kind: "select",
    value: lock?.format ?? current?.format ?? "ndjson",
    options: PUSH_FORMAT_OPTIONS,
    hint: "Shapes each batch for your SIEM; pick the one your endpoint expects. NDJSON suits most generic HTTP intakes.",
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "which-format-for-which-siem" },
  });

  // Locked to a vendor: hide the format + delivery pickers. The values are fixed above, so the endpoint fields
  // (fieldsForSink) still key off the locked sink and submit reads the locked format/sink unchanged.
  if (lock) {
    sinkField.el.hidden = true;
    formatField.el.hidden = true;
  }

  // Warns live when the picked format/sink combination is one no SIEM can parse; submitPushForm below
  // enforces the same rule (validatePushFormatSink) as a hard block, this is the accompanying hint.
  const formatSinkNote = h(
    "p",
    { class: "field__hint", hidden: true },
    "CEF and LEEF require the syslog-tls sink: no SIEM auto-parses CEF or LEEF delivered over HTTP or dropped into a bucket. Switch Delivery to Syslog over TLS, or choose a different format.",
  );

  // --- http sink fields ---------------------------------------------------------------------------
  const endpointField = field({
    id: "push-endpoint",
    label: "Endpoint URL",
    required: true,
    autocomplete: "off",
    placeholder: "https://http-intake.logs.example.com/api/v2/logs",
    value: current?.endpoint ?? "",
    hint: "An https URL for your SIEM's HTTP intake, for example a Splunk HEC collector or a Datadog Logs endpoint. Its certificate must chain to a publicly trusted root on this exact host and port: a self-signed or expired one is refused before your credential is offered, which reads like an auth failure and is not. No embedded credentials and not a workers.dev host; the engine also refuses a private or cloud-metadata address by default.",
    validate: validatePushEndpoint,
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-push-destination" },
  });
  endpointField.control.classList.add("mono");

  const authInUrlRow = checkboxRow(
    "push-auth-in-url",
    "Carry the auth token in the URL",
    "For intakes that read the secret from the URL path or query (for example Devo), not a header.",
    current?.authInUrl ?? false,
  );
  const authInUrlNote = h(
    "p",
    { class: "field__hint", hidden: true },
    "The secret below is appended to the endpoint URL and no auth header is sent. The token never appears in the audit trail, the delivery trail, or this view.",
  );

  const headerNameField = field({
    id: "push-header-name",
    label: "Auth header name",
    placeholder: "Authorization",
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
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-push-destination" },
  });
  headerNameField.control.classList.add("mono");

  // The credential noun, scheme and worked example come from the VENDOR the form was opened on (the catalogue's
  // credLabel / credScheme / credExample), so the field's label, its hint, its note and its validator all read
  // one source and cannot state different rules. A generic form (no vendor scheme) keeps the plain wording.
  const credNoun = lock?.credLabel ?? "auth secret";
  const credScheme = lock?.credScheme;
  const schemeWord = credScheme?.trimEnd() ?? "";

  // The write-only http secret field: the destinations idiom (destination-form-fields.ts buildCredBlock). It
  // ALWAYS starts blank, even when replacing: the engine never returns the stored secret.
  //
  // IT VALIDATES. Until this field carried `required: true` and nothing else, while the note below
  // it told a Splunk operator the token had to be pasted as "Splunk <token>" and that the bare token alone was
  // not enough. So the console stated the rule and then accepted the value that breaks it, on a field that is
  // never re-displayed, against an endpoint whose only answer to a bare HEC token is a 401 that looks exactly
  // like a revoked one. pushAuthSecret enforces the vendor's scheme, plus the engine's own length and
  // control-character screen (push-secret-drift-gate.mjs differentially fuzzes it against the engine's
  // isValidPushHeaderValue, so the bound is derived rather than transcribed).
  const secretField = field({
    id: "push-secret",
    // The label stays the static "Auth secret" and the vendor's own noun rides in the hint, the placeholder
    // and every validator message instead. A label built per vendor would make this control's census entry
    // read "[dynamic]", which costs the field catalogue a real label for no gain the hint does not already
    // give: the hint is what the operator reads while the box is empty.
    label: "Auth secret",
    type: "password",
    required: true,
    autocomplete: "off",
    placeholder: credScheme !== undefined ? `${credScheme}<token>` : mode === "replace" ? "paste the new secret" : "paste the header's secret value",
    hint: credScheme !== undefined
      ? `Paste the ${credNoun} with its scheme: the word ${schemeWord}, a space, then the token. Sent once over the authenticated channel, then sealed by your engine. Never re-displayed; leaving this page clears it from the console.`
      : "Sent once over the authenticated channel, then sealed by your engine. Never re-displayed; leaving this page clears it from the console.",
    validate: pushAuthSecret({ noun: credNoun, ...(credScheme !== undefined ? { scheme: credScheme } : {}), ...(lock?.credExample !== undefined ? { example: lock.credExample } : {}) }),
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-push-destination" },
  });

  // The scheme note, shown right where the token is pasted and ONLY on a vendor whose credential genuinely
  // carries a scheme. It used to be toggled on `format === "splunk-hec"` alone, which put Splunk's instruction
  // on the CrowdStrike Falcon form: Falcon takes the same format and a plain bearer token, so the console told
  // that operator to prefix a Falcon token with the word Splunk. The text is built from the same credScheme the
  // validator enforces, so the instruction and the enforcement are one decision.
  const credSchemeNote = credScheme === undefined
    ? null
    : h(
        "p",
        { class: "field__hint" },
        `${credNoun}: paste it as "${credScheme}<token>", including the literal word "${schemeWord}" and a space. The bare token alone is not enough.`,
      );

  const httpGroup = h("div", { class: "stack-sm" }, endpointField.el, authInUrlRow.el, authInUrlNote, headerNameField.el, secretField.el, ...(credSchemeNote ? [credSchemeNote] : []));

  // --- s3 sink fields -----------------------------------------------------------------------------
  const s3EndpointField = field({
    id: "push-s3-endpoint",
    label: "S3 endpoint URL",
    required: true,
    autocomplete: "off",
    placeholder: "https://s3.ap-southeast-2.amazonaws.com",
    value: current?.s3?.endpoint ?? "",
    hint: "The S3-compatible endpoint your SIEM's bucket lives on, for example AWS S3 or Cloudflare R2. https only, and screened like the HTTP endpoint, so a private or cloud-metadata address is refused by default.",
    validate: validatePushEndpoint,
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-s3-sink" },
  });
  s3EndpointField.control.classList.add("mono");
  const s3BucketField = field({ id: "push-s3-bucket", label: "Bucket", required: true, autocomplete: "off", placeholder: "my-siem-audit-bucket", value: current?.s3?.bucket ?? "", hint: "The name of the existing bucket your SIEM reads. The engine writes into it, never creates it.", doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-s3-sink" } });
  s3BucketField.control.classList.add("mono");
  const s3RegionField = field({ id: "push-s3-region", label: "Region", required: true, autocomplete: "off", placeholder: "ap-southeast-2", value: current?.s3?.region ?? "", hint: 'The bucket\'s real region. Use "auto" for Cloudflare R2; Amazon S3 rejects "auto" and needs the bucket\'s actual region.', doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-s3-sink" } });
  s3RegionField.control.classList.add("mono");
  const s3PrefixField = field({
    id: "push-s3-prefix",
    label: "Key prefix (optional)",
    autocomplete: "off",
    placeholder: "downpipes-audit",
    value: current?.s3?.prefix ?? "",
    hint: "A folder path inside the bucket to keep the audit objects together, for example downpipes-audit/. Each batch lands under it as one NDJSON object named by timestamp and sequence range. Left blank, the engine writes under a downpipes-audit/ prefix, not at the bucket root.",
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-s3-sink" },
  });
  s3PrefixField.control.classList.add("mono");
  const s3KeyField = field({ id: "push-s3-key", label: "Access Key ID", required: true, autocomplete: "off", placeholder: "AKIAIOSFODNN7EXAMPLE", hint: "An S3-API access key for the bucket above (an R2 API token for R2, an IAM access key for AWS). The sink only writes, so the key needs just s3:PutObject on the bucket.", doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-s3-sink" } });
  s3KeyField.control.classList.add("mono");
  const s3SecretField = field({
    id: "push-s3-secret",
    label: "Secret Access Key",
    type: "password",
    required: true,
    autocomplete: "off",
    placeholder: "paste the secret access key",
    hint: "The secret paired with the Access Key ID above. Sent once over the authenticated channel, then sealed by your engine under a key distinct from your archive credential. Never re-displayed.",
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-s3-sink" },
  });
  const s3Note = h(
    "p",
    { class: "field__hint" },
    mode === "replace"
      ? "The S3 drop always writes NDJSON, one raw event per line (the format above is not used for this sink). Replacing re-collects the access key id and secret access key; the redacted view does not carry them."
      : "The S3 drop always writes NDJSON, one raw event per line (the format above is not used for this sink).",
  );
  const s3Group = h("div", { class: "stack-sm", hidden: true }, s3EndpointField.el, s3BucketField.el, s3RegionField.el, s3PrefixField.el, s3KeyField.el, s3SecretField.el, s3Note);

  // --- syslog-tls sink fields ---------------------------------------------------------------------
  const syslogHostField = field({
    id: "push-syslog-host",
    label: "Syslog host",
    required: true,
    autocomplete: "off",
    placeholder: "siem.example.com",
    value: current?.syslog?.host ?? "",
    hint: "Your SIEM's syslog-over-TLS listener, as a host name only with no scheme or path. A private or on-prem address is fine; this host is not egress-screened. Its TLS certificate is still checked against the public trust store, so an internal CA or a self-signed listener certificate fails the handshake and nothing is written.",
    validate: validateSyslogHost,
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-syslog-sink" },
  });
  syslogHostField.control.classList.add("mono");
  const syslogPortField = field({
    id: "push-syslog-port",
    label: "Port",
    type: "number",
    autocomplete: "off",
    placeholder: "6514",
    value: current?.syslog?.port !== undefined ? String(current.syslog.port) : String(DEFAULT_SYSLOG_PORT),
    hint: "A whole number from 1 to 65535. Defaults to 6514 (RFC 5425 syslog over TLS) when left blank.",
    validate: validateSyslogPort,
    doc: { href: "https://docs.downpipes.io/day-2/audit-log-push", anchor: "setting-up-the-syslog-sink" },
  });
  syslogPortField.control.classList.add("mono");
  const syslogNote = h(
    "p",
    { class: "field__hint" },
    "This sink delivers CEF or LEEF lines as RFC 5424 records over TLS, and carries no other format: a syslog record holds a CEF or LEEF line. Choose CEF or LEEF above. Reachability of the port from the engine cannot be checked here; use Test send to confirm.",
  );
  const syslogGroup = h("div", { class: "stack-sm", hidden: true }, syslogHostField.el, syslogPortField.el, syslogNote);

  const enabledRow = checkboxRow("push-enabled", "Enabled", "Drains to this destination on the scheduler tick once saved.", current?.enabled ?? true);

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const saveBtn = h("button", { "data-busy-label": "Saving", "data-dp": "settings.button.save#2", class: "btn btn--primary", type: "button" }, mode === "replace" ? "Replace" : "Configure") as HTMLButtonElement;
  const cancelBtn = h("button", { "data-dp": "settings.button.cancel#2", class: "btn btn--secondary", type: "button" }, "Cancel") as HTMLButtonElement;

  const formEl = h(
    "form",
    { class: "form-stack", "aria-label": "Configure the push destination", on: { submit: (ev: Event) => ev.preventDefault() } },
    sinkField.el,
    formatField.el,
    formatSinkNote,
    httpGroup,
    s3Group,
    syslogGroup,
    enabledRow.el,
    h("div", { class: "dialog__actions", style: "align-items:center" }, formError, cancelBtn, saveBtn),
  );

  // Show exactly the selected sink's fields; the format + enabled rows are shared. Re-run on every sink change.
  const syncSinkVisibility = (): void => {
    const sink = sinkField.value();
    httpGroup.hidden = sink !== "http";
    s3Group.hidden = sink !== "s3";
    syslogGroup.hidden = sink !== "syslog-tls";
  };
  sinkField.control.addEventListener("change", syncSinkVisibility);
  syncSinkVisibility();

  // Live warning for the cef/leef + non-syslog-tls combination submitPushForm blocks outright.
  const syncFormatSinkNote = (): void => {
    formatSinkNote.hidden = validatePushFormatSink(formatField.value() as PushFormat, sinkField.value() as PushSink) === null;
  };
  formatField.control.addEventListener("change", syncFormatSinkNote);
  sinkField.control.addEventListener("change", syncFormatSinkNote);
  syncFormatSinkNote();

  // When the token rides in the URL, the header name is irrelevant (no header is sent): hide it and explain.
  const syncAuthInUrl = (): void => {
    const on = authInUrlRow.checked();
    headerNameField.el.hidden = on;
    authInUrlNote.hidden = !on;
  };
  const authInUrlBox = authInUrlRow.el.querySelector("input");
  if (authInUrlBox) authInUrlBox.addEventListener("change", syncAuthInUrl);
  syncAuthInUrl();

  cancelBtn.addEventListener("click", () => formHost.replaceChildren());

  saveBtn.addEventListener("click", () =>
    void submitPushForm({
      engine,
      mode,
      sinkField,
      formatField,
      endpointField,
      authInUrl: () => authInUrlRow.checked(),
      headerNameField,
      secretField,
      s3EndpointField,
      s3BucketField,
      s3RegionField,
      s3PrefixField,
      s3KeyField,
      s3SecretField,
      syslogHostField,
      syslogPortField,
      vendor: lock?.vendor,
      enabled: () => enabledRow.checked(),
      formError,
      saveBtn,
      refresh,
      formHost,
    }),
  );

  formHost.replaceChildren(formEl);
  sinkField.focus();
}

interface PushFormSubmitCtx {
  engine: EngineClient;
  mode: "configure" | "replace";
  sinkField: Field;
  formatField: Field;
  endpointField: Field;
  authInUrl: () => boolean;
  headerNameField: Field;
  secretField: Field;
  s3EndpointField: Field;
  s3BucketField: Field;
  s3RegionField: Field;
  s3PrefixField: Field;
  s3KeyField: Field;
  s3SecretField: Field;
  syslogHostField: Field;
  syslogPortField: Field;
  // vendor is the OPAQUE destination-identity tag of the tile this form was opened from (the lock's), carried
  // into the submission so the engine records WHICH vendor the destination is rather than leaving the console to
  // infer it from format crossed with sink (which cannot separate Splunk from CrowdStrike Falcon).
  vendor?: string | undefined;
  enabled: () => boolean;
  formError: HTMLElement;
  saveBtn: HTMLButtonElement;
  refresh: () => void;
  formHost: HTMLElement;
}

// fieldsForSink returns exactly the fields to validate for the active sink; the inactive sinks' fields are
// hidden and must never block the submit (so they are never passed to validateForm). Each of these was built
// with `required: true`, so the standard validateForm enforces both emptiness and the field's own validator.
// The write-only secret is required on BOTH configure and replace (the console's long-standing "a replace
// re-supplies the secret" behaviour; the engine's keep-secret path is used only by the lightweight
// enable/disable toggle). syslog-tls carries no secret, and its port is optional (defaults to 6514), so only
// the host is required there.
function fieldsForSink(sink: string, ctx: PushFormSubmitCtx): Field[] {
  if (sink === "s3") return [ctx.s3EndpointField, ctx.s3BucketField, ctx.s3RegionField, ctx.s3KeyField, ctx.s3SecretField];
  if (sink === "syslog-tls") return [ctx.syslogHostField];
  return [ctx.endpointField, ctx.secretField];
}

// submitPushForm validates the active sink's fields, then the format/sink pairing (cef/leef MUST be
// syslog-tls: validatePushFormatSink is the same hard block syncFormatSinkNote hints at live), names
// the replace consequence before the save (a fresh configure has no old secret to kill, so it saves
// straight away, mirroring destination-submit.ts's confirmReplace split), then change management, then
// the save itself.
async function submitPushForm(ctx: PushFormSubmitCtx): Promise<void> {
  const { engine, mode, formError, saveBtn, refresh, formHost } = ctx;
  formError.hidden = true;
  const sink = ctx.sinkField.value();
  if (!validateForm(fieldsForSink(sink, ctx))) return;

  const format = ctx.formatField.value() as PushFormat;
  const formatSinkError = validatePushFormatSink(format, sink as PushSink);
  if (formatSinkError) {
    formError.textContent = formatSinkError;
    formError.hidden = false;
    return;
  }

  if (mode === "replace") {
    const ok = await confirmModal({
      title: "Replace the push destination?",
      body: "Replacing sets a new secret; the old one stops working immediately. Events already delivered are unaffected, and the cursor and delivery trail carry over. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is replaced and the current secret still works.",
      confirmLabel: "Replace",
    });
    if (!ok) return;
  }

  const cr = await requireChange(engine, mode === "replace" ? "Replace the SIEM push destination" : "Configure the SIEM push destination", "push-upsert");
  if (!cr.proceed) return;

  const fields: PushFormFields = {
    sink: sink as PushSink,
    format,
    vendor: ctx.vendor,
    endpoint: ctx.endpointField.value(),
    authInUrl: ctx.authInUrl(),
    authHeaderName: ctx.headerNameField.value(),
    authHeaderValue: ctx.secretField.value(),
    s3: {
      endpoint: ctx.s3EndpointField.value(),
      bucket: ctx.s3BucketField.value(),
      region: ctx.s3RegionField.value(),
      prefix: ctx.s3PrefixField.value(),
      accessKeyId: ctx.s3KeyField.value(),
      secretAccessKey: ctx.s3SecretField.value(),
    },
    syslog: { host: ctx.syslogHostField.value(), port: ctx.syslogPortField.value() },
  };
  const input = buildPushSubmission(fields, ctx.enabled());

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving";
  try {
    const res = await engine.setPush(input, cr.change ?? undefined);
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction(mode === "replace" ? "Replacing the push destination" : "Configuring the push destination");
      formHost.replaceChildren();
      refresh();
      return;
    }
    toast({ message: mode === "replace" ? "Push destination replaced." : "Push destination configured." });
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
