// The supportability tools of the Settings screen, one disclosure each so each opens to exactly one job:
// the signed support bundle download (with the honest vendor-seal/signature state), the email-delivery test
// (which names the fix when a send fails), and the time-boxed pull credentials (Owner-gated mint/revoke per
// scope, with the once-only reveal). The ONE secret that ever appears here is a freshly minted credential the
// engine returns exactly once: shown once behind a conceal/reveal field, copyable without revealing, never
// persisted by the console. The pure presentation helpers are exercised by validate-support.ts in Node.
// Moved verbatim from the settings coordinator for size; behaviour, copy and markup are unchanged.
//
// House style: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { canDo, gateReason } from "../common.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { confirmModal } from "../../components/modal.ts";
import { requireChange } from "../../components/require-change.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { keyField, codeBlock } from "../../components/code-block.ts";
import { toast } from "../../components/toast.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { packPayload, reset as resetClientDiagnostics } from "../../lib/client-diag/ring.ts";
import { statusWithLabel, type StatusTone } from "../../components/status.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { isOwnerActionQueuedResult } from "../../api.ts";
import type { EngineClient } from "../../api.ts";
import type { IngestScope, MintedSupportCredential, SupportGrantView, SupportStatus } from "../../api.ts";

// The engine retains the most recent pulls per grant (older entries roll over); this must match the
// engine's retention cap (scheduler-do.ts slice(-50)). At the cap the console says "most recent N",
// never a total it cannot know.
const PULL_TRAIL_MAX = 50;

// vendorSealPresentation maps the GET /admin/support flags to the honest line: the seal state
// (vendor key configured or not) and the SIGNATURE state (a pre-ceremony engine serves the
// bundle UNSIGNED, so "signed by your engine" is claimed only once signerConfigured is true).
// None of the four states is an error; each is stated plainly. Exported (pure) for the
// validator.
export function vendorSealPresentation(configured: boolean, signerConfigured: boolean): { tone: StatusTone; label: string } {
  if (configured) {
    return signerConfigured
      ? { tone: "ok", label: "Bundle is sealed to the vendor support key and signed by your engine." }
      : { tone: "info", label: "Bundle is sealed to the vendor support key; it is unsigned until the key ceremony has run." };
  }
  return signerConfigured
    ? { tone: "info", label: "No vendor sealing key configured: the bundle is signed by your engine but not sealed, so treat the file like any diagnostic attachment." }
    : { tone: "info", label: "No vendor sealing key configured, and the bundle is unsigned until the key ceremony has run: treat the file like any diagnostic attachment." };
}

// supportGrantPresentation maps one scope's redacted grant view to its honest rendering: no
// grant is a neutral fact, an active grant is ok with its expiry, an EXPIRED grant is danger
// (the credential no longer works; the engine refuses it server-side). The pull line surfaces
// the customer-visible usage trail (count + most recent). Pure and DOM-free; exported for the
// validator. It can never carry a secret: SupportGrantView has none by construction.
//
// THREE STATES, NEVER TWO. The engine's redactGrant now separates "expired"
// from "the stored expiry cannot be read", and sends the second as `expiryUnreadable` beside the coarse
// boolean rather than instead of it. Reading `expired` alone was coarse rather than inverted, and coarse
// is still wrong HERE for three reasons an operator pays for:
//   1. It states a falsehood. The credential did not lapse. Its stored expiresAt is a value that does not
//      parse (a corrupted write, a half-flushed storage page, a hand-edited record).
//   2. It prints that unparseable value as the lapse DATE, so the operator reads garbage as a timestamp
//      and reaches for the clock, the timezone or the engine build instead of the record.
//   3. The remedy differs in what it tells you to expect. An expired bearer is the ordinary end of a TTL
//      and every other surface agrees with it. An unreadable one leaves the Credentials screen counting
//      the SAME bearer down from the good expiry captured at mint (scheduler-do-routing.ts auto-observes
//      it as `ingest-<scope>`), so the operator sees two surfaces disagree and raises a ticket about the
//      console rather than re-minting, which is the one action that actually clears it.
// The tone is taken from EITHER flag, not from `expired` alone, so a wire payload that ever carried
// `expiryUnreadable: true` beside `expired: false` cannot paint a green badge next to a refusal sentence.
// The strict `=== true` is load-bearing in the other direction: the key is PRESENT ONLY in the third
// state, so absent (and a literal false) must read as an ordinary readable expiry, never as a warning.
// The console never re-parses expiresAt to decide this: that comparison is the NaN-blind check the engine
// has just removed, and a second derivation here could disagree with the gate that refuses the pull.
export function supportGrantPresentation(grant: SupportGrantView | null): {
  tone: StatusTone;
  label: string;
  detail: string | null;
  pullLine: string | null;
} {
  if (grant === null) {
    return { tone: "neutral", label: "No active credential.", detail: null, pullLine: null };
  }
  const expiryUnreadable = grant.expiryUnreadable === true;
  const tone: StatusTone = expiryUnreadable || grant.expired ? "danger" : "ok";
  const label = expiryUnreadable
    ? `Credential ${grant.clientId} is refused because the expiry stored against it cannot be read. It has not lapsed, so there is no date for when pulls stopped. Revoke it and mint a replacement.`
    : grant.expired
      ? `Credential ${grant.clientId} expired ${grant.expiresAt}; pulls are refused.`
      : `Credential ${grant.clientId} active; expires ${grant.expiresAt}.`;
  const granted = grant.grantedBy === null
    ? `Granted ${grant.grantedAt} (bare-token path; not attributable to a person).`
    : `Granted ${grant.grantedAt} by ${grant.grantedBy}.`;
  // Name the cross-surface disagreement before the operator finds it and misreads it as a console fault.
  const detail = expiryUnreadable
    ? `${granted} The Credentials screen still tracks this bearer against the expiry recorded when it was minted, so the two will disagree until you re-mint.`
    : granted;
  const n = grant.pulls.length;
  // At the cap the line says "most recent PULL_TRAIL_MAX", never a total it cannot know (NC-4).
  const pullLine =
    n === 0
      ? "Never pulled."
      : n >= PULL_TRAIL_MAX
        ? `Most recent ${PULL_TRAIL_MAX} pulls retained (older entries roll over); last ${latestPullAt(grant.pulls) ?? "unknown"}.`
        : `${n} ${n === 1 ? "pull" : "pulls"} recorded; last ${latestPullAt(grant.pulls) ?? "unknown"}.`;
  return { tone, label, detail, pullLine };
}

// latestPullAt returns the most recent recorded pull timestamp, robust to ordering (the engine
// appends, but we do not depend on that). Null for an empty trail. Exported for the validator.
export function latestPullAt(pulls: { at: string }[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const p of pulls) {
    const ms = Date.parse(p.at);
    if (Number.isFinite(ms) && ms >= bestMs) {
      bestMs = ms;
      best = p.at;
    }
  }
  return best ?? (pulls.length > 0 ? pulls[pulls.length - 1]!.at : null);
}

// supportBundleFileName builds the download name for the support bundle from an ISO date
// (date part only). Pure; exported for the validator.
export function supportBundleFileName(nowIso: string): string {
  const datePart = nowIso.slice(0, 10);
  return `downpipe-support-bundle-${datePart}.json`;
}

// SCOPE_COPY is the per-scope human framing: what the credential is FOR, who presents it, and
// the engine's TTL defaults (engine/src/admin/support.ts INGEST_TTL_CAPS_SECONDS). The diagnostics
// framing is deliberately last-resort: the default support flow is the bundle download above,
// attached to the ticket by the customer; the remote pull exists for when that download or its
// upload is not working, never as the first step (owner direction).
const SCOPE_COPY: Record<IngestScope, { title: string; what: string; ttl: string }> = {
  diagnostics: {
    title: "Vendor diagnostics pull",
    what: "The last-resort path for a live ticket: lets vendor support pull the same signed bundle from GET /support/diagnostics remotely, without a console seat or any standing access. Mint it only when downloading the bundle above and attaching it to your ticket is not working and support asks for a remote pull. Short-lived by design.",
    ttl: "Defaults to 72 hours; capped at 7 days.",
  },
  "audit-feed": {
    title: "SIEM audit feed",
    what: "For your SIEM collector polling GET /support/audit-feed: the hash-chained audit events, cursored by sequence number for checkpointing. Long-lived by design.",
    ttl: "Defaults to 90 days; capped at 365 days.",
  },
  metrics: {
    title: "Metrics scrape (Prometheus)",
    what: "For a Prometheus, Grafana, or Datadog/New Relic/Dynatrace/Elastic/Splunk Observability agent, or Grafana Cloud's agentless scraper: mint a read-only token, then point the scraper at the endpoint below with it as a bearer. Long-lived by design.",
    ttl: "Defaults to 365 days; capped at 400 days.",
  },
};

// metricsEndpointNote is the one-line "point your scraper here" instruction shown beside the
// endpoint URL, regardless of whether a credential has been minted yet (the URL itself is static;
// the credential is what turns it into a working scrape target). Exported (pure) for the validator.
export function metricsEndpointNote(): string {
  return "Point your Prometheus, Grafana or Datadog/New Relic/Dynatrace/Elastic/Splunk Observability agent scraper at this endpoint, presenting a minted credential as its bearer token.";
}

// accessPerimeterNote is the mint-time warning for an Access-fronted deployment: the engine
// reported (SupportStatus.accessPerimeter) that Cloudflare Access fronts this hostname, and the
// /support/* pulls ride the SAME hostname as the console, so Access turns the puller away at the
// edge (a redirect to the team login page, before the engine ever sees the request) no matter how
// valid the minted credential is. The fix is named per scope because the puller differs. Pure and
// DOM-free; exported for the validator.
export function accessPerimeterNote(scope: IngestScope): string {
  if (scope === "audit-feed") {
    return "Cloudflare Access fronts this console, and it will turn away your SIEM collector's polls of GET /support/audit-feed at the edge, whatever credential they carry. Give the collector an Access service token to send as extra headers (a path-scoped Access application with a Service Auth policy), or add a narrow Bypass for that path; this credential still gates the feed either way.";
  }
  if (scope === "metrics") {
    return "Cloudflare Access fronts this console, and it will turn away your Prometheus/Grafana/agent scraper's requests to GET /metrics at the edge, whatever credential it carries. Give the scraper an Access service token to send as extra headers (a path-scoped Access application with a Service Auth policy), or add a narrow Bypass for that path; this credential still gates the scrape either way.";
  }
  return "Cloudflare Access fronts this console, and it will turn away vendor support's pull of GET /support/diagnostics at the edge, whatever credential support carries. Hand support an Access service token alongside this credential (a path-scoped Access application with a Service Auth policy), or add a narrow Bypass for that path for the life of the ticket; this credential still gates the bundle either way.";
}

// renderSupportBundle: the signed support bundle download (any role) plus the honest
// vendor-seal/signature state. The details (what the bundle contains, the seal state)
// live at the point of action; the intro is one sentence.
export function renderSupportBundle(engine: EngineClient): HTMLElement {
  const card = h("div");
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Support needs no inbound vendor access: any signed-in role downloads the redaction-safe diagnostics bundle here and attaches it to the ticket; it never contains a key, a secret value, or your data. No ticket yet? Email support@downpipes.io describing the problem, wait for the ticket reference, then attach the bundle to your reply on it.",
    ),
  );

  // The seal/signature state, read on first open. A failed read never blocks the
  // download (the bundle endpoint is independent); it is named, not hidden.
  const sealLine = h("div", { style: "margin-top:var(--space-3)" });
  sealLine.appendChild(skeletonRows(1));
  card.appendChild(sealLine);
  void engine
    .getSupport()
    .then((status: SupportStatus) => {
      if (!card.isConnected) return;
      const seal = vendorSealPresentation(status.vendorSealConfigured, status.signerConfigured);
      sealLine.replaceChildren(statusWithLabel(seal.tone, seal.label));
    })
    .catch((err) => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the seal line is a skeleton and this read is issued once, so nothing
        // else was ever going to replace it. No reload to offer: it is built with the card.
        if (card.isConnected) sealLine.replaceChildren(sessionEnded());
        return goSignedOut();
      }
      if (!card.isConnected) return;
      sealLine.replaceChildren(h("p", { class: "field__hint" }, "Could not read the bundle's seal state; the download below still works."));
    });

  const downloadBtn = h(
    "button",
    { "data-dp": "settings.button.download", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" },
    "Download support bundle",
  ) as HTMLButtonElement;
  const downloadErr = h("div", { style: "margin-top:var(--space-2)" });
  downloadBtn.addEventListener("click", () => {
    downloadBtn.disabled = true;
    downloadErr.replaceChildren();
    // The console's own bounded ring of coarse, closed-class error records rides ALONG with this one
    // build (Wave C, invariant I1: request-scoped). It is read HERE, at the deliberate Generate action,
    // and nowhere else: the console never sends it in the background, and a bundle the vendor pulls with a
    // bearer credential structurally cannot carry one. The engine re-validates every field by set
    // membership and folds the result inside the seal and the signature. The ring is cleared once the
    // bundle is in hand, so the same evidence is not counted again into the NEXT pack.
    void engine
      .getSupportBundle(packPayload())
      .then((text) => {
        // THE RING IS CLEARED ONLY ONCE THE PACK IS IN THE CUSTOMER'S HANDS, and the order used to be the
        // other way round. Clearing first meant a browser that refused the blob write destroyed the very
        // evidence the pack exists to carry: the pack was gone, the ring was empty, and the retry below
        // rebuilt a pack with no console error classes in it at all, while the line under this button went
        // on promising the customer that the bundle includes them. A pack that quietly stops carrying its
        // evidence is worse than a download that plainly failed.
        const delivered = downloadJsonText(supportBundleFileName(new Date().toISOString()), text);
        if (!delivered) {
          downloadErr.replaceChildren(
            verdictSurface({
              tone: "danger",
              title: "This browser refused to write the file",
              body: "The bundle was built and nothing was lost: the console error classes it carries are still held for the next attempt. Try again, or use a browser window without a download policy.",
              assertive: true,
            }),
          );
          downloadBtn.disabled = false;
          return;
        }
        resetClientDiagnostics();
        toast({ message: "Support bundle downloaded." });
        downloadBtn.disabled = false;
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: no bundle was produced, so the control comes back.
          downloadBtn.disabled = false;
          return goSignedOut();
        }
        downloadErr.replaceChildren(blockError(err, () => downloadBtn.click()));
        downloadBtn.disabled = false;
      });
  });
  card.appendChild(downloadBtn);
  // The one-line inline disclosure (owner decision Q1: a plain disclosure, never a checkbox). The section
  // is a normal always-included part of the bundle, exactly like every other section, and the real control
  // is that the whole pack is generated only when the customer asks for it and shared only if they choose
  // to. Saying what is in it is honest; gating it behind a tick would imply these coarse enums are riskier
  // than the operator labels the pack already carries, which would undercut the closed-class guarantee that
  // is the actual protection.
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      "The bundle includes coarse, value-free console error classes from this browser session (which screen, and the kind of failure), so support can see errors the console showed you. It carries no URL, no message text, and no value.",
    ),
  );
  card.appendChild(downloadErr);
  return card;
}

// renderEmailDelivery: the email-delivery test (owner feedback: a missing
// Email Service set-up was a silent no-op, the bootstrap link "sent" and nothing
// arrived). The verdict carries the fix when one is needed; the intro does not
// pre-teach the dashboard path before the test has even run.
export function renderEmailDelivery(engine: EngineClient): HTMLElement {
  const card = h("div");
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "The engine emails alerts, invites and the first-run set-up link. This sends a test message to your own signed-in address and reports exactly what the platform said; a failed send names the fix.",
    ),
  );
  const emailTestBtn = h("button", { "data-dp": "settings.button.email-test", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" }, "Send a test email") as HTMLButtonElement;
  const emailTestOut = h("div", { style: "margin-top:var(--space-2)", role: "status", "aria-live": "polite" });
  emailTestBtn.addEventListener("click", () => {
    emailTestBtn.disabled = true;
    emailTestOut.replaceChildren(skeletonRows(1));
    void engine
      .testEmailDelivery()
      .then((res) => {
        emailTestOut.replaceChildren(statusWithLabel(res.ok ? "ok" : "warn", emailTestVerdict(res)));
        emailTestBtn.disabled = false;
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the output host is a skeleton and the button is off, and no test was sent.
          emailTestOut.replaceChildren(sessionEnded());
          emailTestBtn.disabled = false;
          return goSignedOut();
        }
        emailTestOut.replaceChildren(blockError(err, () => emailTestBtn.click()));
        emailTestBtn.disabled = false;
      });
  });
  card.appendChild(emailTestBtn);
  card.appendChild(emailTestOut);
  return card;
}

// renderPullCredentials: grant state per scope + Owner-gated mint/revoke. The intro is
// one sentence; the once-only reveal, the re-mint-replaces rule and the 50-pull rollover
// are each stated at their point of action (the reveal, the button + confirm, the pull
// line). The freshly minted secret renders ONCE into a host that survives the
// grant-state refresh, behind the standard conceal/reveal keyField.
export function renderPullCredentials(engine: EngineClient, onlyScope?: IngestScope, docsHref?: string): HTMLElement {
  const card = h("div");
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "An Owner can mint a time-boxed credential per scope; each grants exactly its read-only feed (no admin route, no restore, no configuration, no customer data) and the engine stores only the secret's hash.",
    ),
  );

  // grantsHost is rebuilt on every refresh; the revealHosts are mounted as STABLE
  // SIBLINGS of it on the card (never inside it), so no refresh path can detach a
  // just-minted one-time secret: even when the follow-up read fails and grantsHost is
  // replaced by an error block, the reveal stays on screen until navigation.
  const grantsHost = h("div", { style: "margin-top:var(--space-3)" });
  const revealHosts: Record<IngestScope, HTMLElement> = {
    diagnostics: h("div"),
    "audit-feed": h("div"),
    metrics: h("div"),
  };
  card.appendChild(grantsHost);
  card.appendChild(revealHosts.diagnostics);
  card.appendChild(revealHosts["audit-feed"]);
  card.appendChild(revealHosts.metrics);

  const refresh = () => {
    grantsHost.replaceChildren(skeletonRows(2));
    void engine
      .getSupport()
      .then((status: SupportStatus) => {
        if (!card.isConnected) return;
        // accessPerimeter is strict-true only: an older engine omits the field, and an unknown
        // perimeter must render as no note, never as a warning the engine did not report.
        const accessPerimeter = status.accessPerimeter === true;
        // metrics is OPTIONAL on SupportStatus (a newer field; an engine that predates the
        // monitoring build omits it), so an absent scope reads as "no active credential", never as
        // a broken or missing scope.
        // onlyScope (set from an Integrations vendor tile) narrows this to the ONE scope that vendor reads, so a
        // Prometheus/Sentinel tile shows just its own credential, not all three generic scopes.
        const blocks: Array<{ scope: IngestScope; grant: SupportGrantView | null; revealHost: HTMLElement }> = [
          { scope: "diagnostics", grant: status.diagnostics, revealHost: revealHosts.diagnostics },
          { scope: "audit-feed", grant: status.auditFeed, revealHost: revealHosts["audit-feed"] },
          { scope: "metrics", grant: status.metrics ?? null, revealHost: revealHosts.metrics },
        ];
        const shown = onlyScope ? blocks.filter((b) => b.scope === onlyScope) : blocks;
        grantsHost.replaceChildren(...shown.map((b) => scopeBlock({ engine, scope: b.scope, grant: b.grant, accessPerimeter, revealHost: b.revealHost, refresh, docsHref })));
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the grants host is a skeleton until this replaces it.
          if (card.isConnected) grantsHost.replaceChildren(sessionEnded(() => refresh()));
          return goSignedOut();
        }
        if (!card.isConnected) return;
        grantsHost.replaceChildren(blockError(err, () => refresh()));
      });
  };
  refresh();

  return card;
}

// emailTestVerdict maps the engine's honest send outcome (including the Email Service error code)
// to the one sentence that names the fix. Exported (pure) for the validator.
export function emailTestVerdict(res: { ok: boolean; reason?: string; code?: string }): string {
  if (res.ok) return "Sent. Check the inbox of your signed-in address; if nothing arrives, check its spam folder, then the sending domain's onboarding state.";
  if (res.code === "E_SENDER_DOMAIN_NOT_AVAILABLE" || res.code === "E_SENDER_NOT_VERIFIED") {
    return "The platform refused the sender: the sending domain is not onboarded for Email Sending. In the Cloudflare dashboard open Compute, then Email Service, then Email Sending, and onboard the domain EMAIL_FROM uses (DNS records are added automatically).";
  }
  if (res.reason === "email-not-configured") {
    return "No send_email binding is bound: add the [[send_email]] binding (name = \"EMAIL\") to the engine's wrangler config and redeploy.";
  }
  if (res.reason === "email-from-not-configured" || res.reason === "email-from-invalid") {
    return "EMAIL_FROM is unset or not a custom-domain address: set it in the engine's wrangler config (an address on your onboarded sending domain) and redeploy.";
  }
  if (res.reason === "email-test-needs-identity") {
    return "You are signed in with the bare admin token, which has no email address. Sign in with a passkey or Cloudflare Access, then test again.";
  }
  return `The send failed${res.code ? ` (${res.code})` : ""}. Email Service may not be enabled on this Cloudflare account: open Compute, then Email Service in the dashboard and complete set-up, then test again.`;
}

// scopeBlock renders one scope's grant state + the Owner-gated mint/revoke controls. The
// engine enforces the Owner gate server-side; this mirror only decides what to offer, exactly
// as the alert-webhook card mirrors its gate (disabled-with-reason copy, never a hidden 403).
interface ScopeBlockOpts {
  engine: EngineClient;
  scope: IngestScope;
  grant: SupportGrantView | null;
  accessPerimeter: boolean;
  revealHost: HTMLElement;
  refresh: () => void;
  // Set from an Integrations vendor tile: a link to THAT vendor's setup guide. When present, the generic
  // Access-perimeter paragraph is replaced by a one-liner + this link, because the exact remedy (a service
  // token vs a path exemption) is vendor-specific and lives, correctly, in the vendor's own doc.
  docsHref?: string | undefined;
}

function scopeBlock({ engine, scope, grant, accessPerimeter, revealHost, refresh, docsHref }: ScopeBlockOpts): HTMLElement {
  const copy = SCOPE_COPY[scope];
  const block = h("div", { class: "card card--inset", style: "margin-top:var(--space-3)" });
  block.appendChild(h("div", { style: "font-weight:var(--weight-medium)" }, copy.title));
  block.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, copy.what));
  // The scrape endpoint URL is static (derived from the engine origin, not a permission-gated
  // action), so it is shown to EVERY role, before the Owner-only mint controls below: a non-owner
  // can still read it off to hand to whoever runs the scraper, or to prepare a scrape config ahead
  // of an owner minting the credential.
  if (scope === "metrics") {
    block.appendChild(h("div", { style: "margin-top:var(--space-2)" }, codeBlock(engine.metricsEndpointUrl(), { label: "Metrics endpoint URL", copyLabel: "Copy metrics endpoint URL" })));
    block.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, metricsEndpointNote()));
  }
  // The Access-perimeter warning sits BEFORE the mint button so the operator learns the wall exists
  // before handing a credential to a collector that can never reach the route.
  if (accessPerimeter) {
    if (docsHref) {
      // Point to the vendor's own guide rather than half-explain a per-vendor thing inline: whether it is a
      // service token or a path exemption depends on the tool, and the guide states the right one for it.
      const link = h("a", { href: docsHref, target: "_blank", rel: "noopener noreferrer", class: "linklike" }, "the setup guide");
      block.appendChild(
        h("p", { class: "field__hint", style: "margin-top:var(--space-2);color:var(--warn-fg)" },
          "Behind Cloudflare Access, an unattended pull is turned away at the edge whatever credential it carries. The exact fix for this destination, a service token or a path exemption, is on ",
          link, "."),
      );
    } else {
      block.appendChild(h("div", { style: "margin-top:var(--space-2)" }, statusWithLabel("warn", accessPerimeterNote(scope))));
    }
  }

  const p = supportGrantPresentation(grant);
  const state = h("div", { style: "margin-top:var(--space-2);display:flex;flex-direction:column;gap:2px" });
  state.appendChild(statusWithLabel(p.tone, p.label));
  if (p.detail !== null) state.appendChild(h("span", { class: "field__hint" }, p.detail));
  if (p.pullLine !== null) state.appendChild(h("span", { class: "field__hint" }, p.pullLine));
  block.appendChild(state);

  // The one-time reveal host for this scope is NOT mounted here: it lives as a stable
  // sibling of grantsHost on the card (renderSupport), so the refresh that follows a
  // mint can never detach a just-minted secret. This block only fills/clears it.

  const errorHost = h("div", { style: "margin-top:var(--space-2)" });

  if (!canDo("owner")) {
    block.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-3)" },
        gateReason("owner"),
        " Minting and revoking pull credentials requires the Owner role; the engine enforces this server-side.",
      ),
    );
    block.appendChild(errorHost);
    return block;
  }

  const mintBtn = h(
    "button",
    { "data-dp": "settings.button.mint", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" },
    grant === null ? "Mint credential" : "Re-mint (replaces the current credential)",
  ) as HTMLButtonElement;
  const revokeBtn = grant !== null
    ? (h("button", { "data-dp": "settings.button.revoke", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3);margin-left:var(--space-2)" }, "Revoke") as HTMLButtonElement)
    : null;

  const ctx: ScopeControls = { engine, scope, copy, grant, revealHost, errorHost, refresh, mintBtn, revokeBtn };
  mintBtn.addEventListener("click", () => void mintCredential(ctx));
  if (revokeBtn) revokeBtn.addEventListener("click", () => void revokeCredential(ctx, revokeBtn));

  const btnRow = h("div", {}, mintBtn);
  if (revokeBtn) btnRow.appendChild(revokeBtn);
  block.appendChild(btnRow);
  block.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, copy.ttl));
  block.appendChild(errorHost);
  return block;
}

// ScopeControls bundles the state the mint/revoke listeners share, so each listener takes it as an
// explicit parameter instead of closing over the loose locals of scopeBlock.
interface ScopeControls {
  readonly engine: EngineClient;
  readonly scope: IngestScope;
  readonly copy: { title: string };
  readonly grant: SupportGrantView | null;
  readonly revealHost: HTMLElement;
  readonly errorHost: HTMLElement;
  readonly refresh: () => void;
  readonly mintBtn: HTMLButtonElement;
  readonly revokeBtn: HTMLButtonElement | null;
}

// mintCredential handles the mint button: re-minting over an EXISTING credential replaces it, so it
// confirms before the old secret is killed (a fresh mint with no current credential needs no confirm),
// then mints and reveals the fresh secret ONCE in place.
async function mintCredential(c: ScopeControls): Promise<void> {
  const { engine, scope, copy, grant, revealHost, errorHost, refresh, mintBtn, revokeBtn } = c;
  if (grant !== null) {
    const ok = await confirmModal({
      title: "Re-mint this credential?",
      body: "Re-minting replaces the current credential; the old secret stops working immediately. A collector or support engineer still using it loses access until you hand over the new one. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is re-minted and the current credential still works.",
      confirmLabel: "Re-mint",
    });
    if (!ok) return;
  }
  // Change management (owner opt-in): minting a support credential opens a vendor-readable pull surface, a
  // change-controlled action. Collect a change reference when the policy requires one (a no-op otherwise).
  const cr = await requireChange(engine, "Mint a support credential", "credential-mint");
  if (!cr.proceed) return;
  mintBtn.disabled = true;
  if (revokeBtn) revokeBtn.disabled = true;
  errorHost.replaceChildren();
  void engine
    .mintSupportCredential(scope, undefined, cr.change ?? undefined)
    .then((res) => {
      // Dual control armed: support-credential-mint is an owner action, so a 202 means the engine QUEUED the
      // mint for a SECOND owner and generated NO secret (it is router-executed on approval). Say so honestly
      // and re-enable the buttons; NEVER reveal the queued body, whose credential fields are all undefined and
      // which the reveal would frame "Copy this credential now". The reveal appears only on the applied result.
      if (isOwnerActionQueuedResult(res)) {
        surfaceQueuedOwnerAction(`Minting the ${copy.title} credential`);
        mintBtn.disabled = false;
        if (revokeBtn) revokeBtn.disabled = false;
        refresh();
        return;
      }
      // No toast: the warn reveal appears in place and its title carries the
      // once-only fact, so a third simultaneous warning adds nothing.
      revealHost.replaceChildren(oneTimeCredentialReveal(res.value, copy.title));
      refresh();
    })
    .catch((err) => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: no credential was minted, so both controls come back and the error host
        // says why. Without the sentence the operator returns from re-auth to a scope block that looks
        // untouched, with no way to tell a mint that never ran from one that did.
        errorHost.replaceChildren(sessionEnded());
        mintBtn.disabled = false;
        if (revokeBtn) revokeBtn.disabled = false;
        return goSignedOut();
      }
      errorHost.replaceChildren(blockError(err, () => mintBtn.click()));
      mintBtn.disabled = false;
      if (revokeBtn) revokeBtn.disabled = false;
    });
}

// revokeCredential handles the revoke button: confirm (revoking is immediate), revoke, then clear any
// lingering one-time reveal for this scope so a dead secret is not left on screen.
async function revokeCredential(c: ScopeControls, revokeBtn: HTMLButtonElement): Promise<void> {
  const { engine, scope, revealHost, errorHost, refresh, mintBtn } = c;
  const ok = await confirmModal({
    title: "Revoke this credential?",
    body: "Revoking is immediate; a SIEM collector (or support engineer) using it stops working as soon as you confirm. Re-mint to issue a replacement.",
    confirmLabel: "Revoke",
    variant: "danger",
  });
  if (!ok) return;
  mintBtn.disabled = true;
  revokeBtn.disabled = true;
  errorHost.replaceChildren();
  void engine
    .revokeSupportCredential(scope)
    .then(() => {
      revealHost.replaceChildren();
      toast({ message: "Credential revoked." });
      refresh();
    })
    .catch((err) => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: nothing was revoked, so both controls come back and the error host says
        // why. The credential is still live, which is the fact the operator most needs on this path.
        errorHost.replaceChildren(sessionEnded());
        mintBtn.disabled = false;
        revokeBtn.disabled = false;
        return goSignedOut();
      }
      errorHost.replaceChildren(blockError(err, () => revokeBtn.click()));
      mintBtn.disabled = false;
      revokeBtn.disabled = false;
    });
}

// oneTimeCredentialReveal renders the freshly minted credential ONCE: a plain warning that it
// will not be shown again, the single-bearer form behind the standard conceal/reveal keyField
// (copy works without revealing), the non-secret clientId, and the expiry. The console never
// stores any of it; navigating away discards it, exactly as the warning says. scopeTitle names
// the scope (the reveal lives outside the scope block, so it must carry its own context).
function oneTimeCredentialReveal(minted: MintedSupportCredential, scopeTitle: string): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-3)" });
  wrap.appendChild(
    verdictSurface({
      tone: "warn",
      title: "Copy this credential now: it will not be shown again",
      // The title carries the once-only fact; the body explains why and the rotation path.
      body: "The engine stores only a hash of the secret. Paste the bearer into your collector or hand it to support; to rotate it later, revoke and re-mint.",
    }),
  );
  wrap.appendChild(keyField({ label: `${scopeTitle}: bearer credential (shown once)`, value: minted.bearer }));
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      `Client id ${minted.clientId} (not secret); expires ${minted.expiresAt}. Present it as: Authorization: Bearer <credential>.`,
    ),
  );
  return wrap;
}

// downloadJsonText saves a JSON text document via a blob: URL anchor.
//
// TOTAL: it never throws, and it returns whether the browser accepted the delivery. That matters more here
// than anywhere else in the console. The Blob constructor can throw under memory pressure and a hardened
// browser can decline the anchor click, and this file was the ONE download path that let those throws out:
// every recovery artefact goes through lib/file-delivery.ts deliverFile, which was written for exactly this
// failure and is total. Here the throw landed in the promise chain's catch and was painted as a failure to
// BUILD the bundle, which is a different ticket from a browser that would not write the file.
//
// It does NOT record a capability-fault row, and that is a scope decision rather than an oversight.
// deliverFile records one, keyed by a ClientDiagSurface, and that vocabulary is a closed union mirrored in
// engine/src/admin/client-diag-vocab.ts and enforced there by set membership. A console that starts sending
// a surface an older engine does not know has the row dropped on arrival, so widening it is a paired
// console-and-engine change and not this one. The ordering fix below is what actually protects the evidence.
export function downloadJsonText(name: string, content: string): boolean {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const a = h("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  } finally {
    if (url !== null) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // A host without revokeObjectURL is not a fault worth recording: the file either arrived or the
        // caller has already been told it did not.
      }
    }
  }
}
