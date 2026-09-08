// The connections list (the one work surface of the external-identity-providers screen): the calm card per
// configured connection (label lead + kind/state badges + the issuer / IdP-entity-id identity anchor + the
// secret MODE, never a value), the SAML SP-metadata + ACS-URL handoff block, and the owner enable/disable and
// remove controls (the gate is mirrored, never the control: a non-owner sees them disabled-with-reason). Moved
// verbatim from the idp-connections coordinator for size; it imports the shared leaf (./shared.ts), so it never
// imports the forms section (which would form a cycle).
//
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, IdpConnectionView } from "../../api.ts";
import { isOwnerActionQueuedResult } from "../../api.ts";
import { copyButton } from "../../components/code-block.ts";
import { stepUpAwareText } from "../../components/error-view.ts";
import { emptyState } from "../../components/feedback.ts";
import { confirmModal } from "../../components/modal.ts";
import { requireChange } from "../../components/require-change.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { ICON_LICENCE, ICON_TRASH } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { capGateReason, collapsedSection, refuseWithReason } from "../common.ts";
import { certRolloverSection } from "./cert-rollover.ts";
import { renderIdpTestResult } from "./forms-test-result.ts";
import { downloadText, errText, kindBadge, kindLabel, MANAGE_CAP, secretModeNote } from "./shared.ts";

export function renderConnections(engine: EngineClient, conns: IdpConnectionView[], canManage: boolean, reload: () => void): HTMLElement {
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-4)", "aria-label": "Configured identity providers" });

  if (conns.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "No identity providers yet",
        body: canManage
          ? "Add your first connection below. Your team can keep signing in with passkeys meanwhile; an external IdP is purely additive."
          : "No external identity provider is configured. Adding one is owner only.",
      }),
    );
    return wrap;
  }

  // A calm card per connection (boxes are for elevated/interactive objects, a connection row carries
  // an enable toggle and a remove action, so a card is right). The label is the lead, with the
  // provider/kind and the state as quiet metadata; the secret MODE is shown so an owner can see at a
  // glance whether it is a confidential or a public (PKCE) client, but never a value.
  for (const conn of conns) {
    wrap.appendChild(connectionCard(engine, conn, canManage, reload));
  }
  return wrap;
}

function connectionCard(engine: EngineClient, conn: IdpConnectionView, canManage: boolean, reload: () => void): HTMLElement {
  const card = h("section", { class: "card", style: "display:grid;gap:var(--space-3)" });
  card.appendChild(connectionHeader(conn));
  card.appendChild(connectionMeta(conn));

  // SAML connections need the SP metadata + ACS URL handed to the IdP, so a SAML card carries that
  // affordance inline (collapsed). OIDC/OAuth2 need nothing extra here (the redirect URI is the engine's
  // own callback, configured at the IdP from the engine's docs).
  // SAML connections also carry the zero-downtime signing-certificate rollover (engine POST
  // /admin/idp/connections/cert). It sits on the card rather than in the add form because it edits a connection
  // that already exists: before it, the only portal path through a certificate rotation was remove-and-re-add,
  // which ends every session signed in through the connection. Collapsed, because it is a rotation-day action.
  if (conn.kind === "saml") {
    card.appendChild(collapsedSection("Give this to your IdP (SP metadata + ACS URL)", samlHandoff(engine, conn.id)));
    card.appendChild(collapsedSection("Roll over the signing certificate", certRolloverSection(engine, conn, canManage, reload)));
  }

  card.appendChild(connectionControls(engine, conn, canManage, reload));
  return card;
}

// Header row: label (text node, customer data) + the kind/state badges.
function connectionHeader(conn: IdpConnectionView): HTMLElement {
  const head = h("div", { style: "display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap" });
  head.appendChild(h("h3", { style: "font-size:var(--text-base);margin:0" }, conn.label));
  head.appendChild(kindBadge(conn.kind));
  head.appendChild(conn.enabled ? badge("ok", "Enabled", { dot: true }) : badge("neutral", "Disabled", { dot: true }));
  return head;
}

// The honest identity anchor: the issuer (OIDC) or the IdP entity id (SAML), plus the connection id.
// All text nodes. This is the "which provider is this, really" line an owner verifies against their IdP.
function connectionMeta(conn: IdpConnectionView): HTMLElement {
  const meta = h("div", { class: "field__hint", style: "display:grid;gap:var(--space-1)" });
  meta.appendChild(h("div", h("span", { style: "color:var(--text-muted)" }, "Connection id: "), h("span", { class: "mono" }, conn.id)));
  if (conn.kind === "oidc") {
    meta.appendChild(h("div", h("span", { style: "color:var(--text-muted)" }, "Issuer: "), h("span", { class: "mono" }, conn.issuer)));
    meta.appendChild(h("div", h("span", { style: "color:var(--text-muted)" }, "Client: "), h("span", { class: "mono" }, conn.clientId), "  ", secretModeNote(conn.secretRef.mode)));
  } else if (conn.kind === "oauth2") {
    meta.appendChild(h("div", h("span", { style: "color:var(--text-muted)" }, "Authorize URL: "), h("span", { class: "mono" }, conn.authorizeUrl)));
    meta.appendChild(h("div", h("span", { style: "color:var(--text-muted)" }, "Client: "), h("span", { class: "mono" }, conn.clientId), "  ", secretModeNote(conn.secretRef.mode)));
  } else {
    meta.appendChild(h("div", h("span", { style: "color:var(--text-muted)" }, "IdP entity id: "), h("span", { class: "mono" }, conn.idpEntityId)));
    meta.appendChild(h("div", h("span", { style: "color:var(--text-muted)" }, "Email trust: "), conn.emailVerifiedPolicy === "trust-idp" ? badge("warn", "trust-idp") : badge("ok", "require-flag")));
  }
  if (conn.createdBy) {
    meta.appendChild(h("div", { title: absoluteTime(conn.createdAt) }, h("span", { style: "color:var(--text-muted)" }, "Added "), relativeTime(conn.createdAt), h("span", { style: "color:var(--text-muted)" }, " by "), h("span", { class: "mono" }, conn.createdBy)));
  }
  return meta;
}

// The owner controls: a read-only re-verify test, an enable/disable toggle and a remove. Mirrored
// gate: a non-owner sees them disabled-with-reason rather than hidden, so the surface reads as governed.
function connectionControls(engine: EngineClient, conn: IdpConnectionView, canManage: boolean, reload: () => void): HTMLElement {
  const controls = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center" });
  const resultHost = h("div");
  controls.appendChild(testControl(engine, conn, canManage, resultHost));
  controls.appendChild(toggleControl(engine, conn, canManage, reload));
  controls.appendChild(removeControl(engine, conn, canManage, reload));
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-2)" }, controls);
  // The probe checks reachability and metadata over the stored config; it holds no secret, so a
  // rotated client secret still needs to be updated here (saving re-runs the full pre-save test).
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Test connection re-checks the provider's metadata over the stored config. It does not validate the stored secret; after a secret rotation, update the secret here.",
    ),
  );
  // THE CEREMONY, named before the buttons rather than discovered after them. Enabling or disabling a
  // connection changes who can sign in, so the engine demands a fresh identity check. Test is not gated,
  // which is why this names the two controls it applies to rather than the row as a whole.
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey when you enable or disable a connection. If you dismiss that prompt, or it fails, nothing is changed and the connection stays exactly as it is.",
    ),
  );
  wrap.appendChild(resultHost);
  return wrap;
}

// testControl runs the engine's read-only probe over the STORED connection (POST /admin/idp/test-saved)
// and renders the per-check result beside the controls, so a re-verification after an IdP-side change
// (a metadata move, a cert rollover) is one click rather than a retype. Nothing is stored or mutated.
function testControl(engine: EngineClient, conn: IdpConnectionView, canManage: boolean, resultHost: HTMLElement): HTMLButtonElement {
  const btn = h(
    "button",
    { "data-busy-label": "Testing...", "data-dp": "idp-connections.button.test-control",
      class: "btn btn--secondary btn--sm",
      type: "button",
    },
    "Test connection",
  ) as HTMLButtonElement;
  if (!canManage) refuseWithReason(btn, capGateReason(MANAGE_CAP));
  if (canManage) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Testing...";
      try {
        const res = await engine.testSavedIdpConnection(conn.id);
        resultHost.replaceChildren();
        renderIdpTestResult(resultHost, res);
      } catch (err) {
        if (isUnauthorised(err)) return goSignedOut();
        toast({ message: `Test failed to run: ${errText(err)}`, tone: "warn" });
      } finally {
        btn.disabled = false;
        btn.textContent = "Test connection";
      }
    });
  }
  return btn;
}

function toggleControl(engine: EngineClient, conn: IdpConnectionView, canManage: boolean, reload: () => void): HTMLButtonElement {
  const toggleBtn = h(
    "button",
    { "data-dp": "idp-connections.button.toggle-control",
      class: "btn btn--secondary btn--sm",
      type: "button",
    },
    conn.enabled ? "Disable" : "Enable",
  ) as HTMLButtonElement;
  if (!canManage) refuseWithReason(toggleBtn, capGateReason(MANAGE_CAP));
  if (canManage) {
    toggleBtn.addEventListener("click", async () => {
      // Change management (owner opt-in): enabling/disabling a connection changes who can sign in, a
      // change-controlled action. Collect a change reference when the policy requires one (a no-op otherwise).
      const cr = await requireChange(engine, conn.enabled ? `Disable the ${conn.label} connection` : `Enable the ${conn.label} connection`, "idp-connection-toggle");
      if (!cr.proceed) return;
      toggleBtn.disabled = true;
      try {
        const res = await engine.setIdpConnectionEnabled(conn.id, !conn.enabled, cr.change ?? undefined);
        // Dual control armed: the engine queued this for a second owner instead of applying it. Say so
        // honestly (NOT "enabled / disabled"), and re-enable the control so it is not stuck disabled.
        if (isOwnerActionQueuedResult(res)) {
          surfaceQueuedOwnerAction(conn.enabled ? `Disabling ${conn.label}` : `Enabling ${conn.label}`);
          toggleBtn.disabled = false;
          return;
        }
        if (!res.value.ok) {
          toast({ message: `Could not update ${conn.label}${res.value.reason ? `: ${res.value.reason}` : ""}.`, tone: "warn" });
          toggleBtn.disabled = false;
          return;
        }
        toast({ message: conn.enabled ? `${conn.label} disabled. Its sign-in button is removed and its live sessions end.` : `${conn.label} enabled. The sign-in button appears for everyone.` });
        reload();
      } catch (err) {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the toggle did not apply, so the control must not stay dead.
          toggleBtn.disabled = false;
          goSignedOut();
          return;
        }
        toast({ message: `Could not update ${conn.label}. ${stepUpAwareText(err)}`, tone: "warn" });
        toggleBtn.disabled = false;
      }
    });
  }
  return toggleBtn;
}

function removeControl(engine: EngineClient, conn: IdpConnectionView, canManage: boolean, reload: () => void): HTMLButtonElement {
  const removeBtn = h(
    "button",
    { "data-dp": "idp-connections.button.remove",
      class: "btn btn--ghost btn--sm",
      type: "button",
    },
    svgIcon(ICON_TRASH, { size: 14 }),
    "Remove",
  ) as HTMLButtonElement;
  if (!canManage) refuseWithReason(removeBtn, capGateReason(MANAGE_CAP));
  if (canManage) {
    removeBtn.addEventListener("click", async () => {
      const confirmed = await confirmModal({
        title: `Remove ${conn.label}?`,
        body: h(
          "div",
          { class: "stack-sm" },
          h("p", { style: "color:var(--text)" }, `This removes the ${kindLabel(conn.kind)} connection and ends any session signed in through it. People can still sign in with a passkey, the token, or another enabled provider. You can add it again later.`),
          conn.kind !== "saml" ? h("p", { class: "field__hint" }, "The stored client secret is deleted with the connection.") : false,
          h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again from this row."),
        ),
        confirmLabel: "Remove connection",
        variant: "danger",
        busyLabel: "Removing",
      });
      if (!confirmed) return;
      // Change management (owner opt-in): removing a connection changes who can sign in, a change-controlled
      // action. Collect a change reference after the removal is confirmed (a no-op when the policy is off).
      const cr = await requireChange(engine, `Remove the ${conn.label} connection`, "idp-connection-delete");
      if (!cr.proceed) return;
      try {
        const res = await engine.deleteIdpConnection(conn.id, cr.change ?? undefined);
        // Dual control armed: the engine queued the removal for a second owner. The connection is STILL
        // live until they approve, so say "queued" honestly, never "removed".
        if (isOwnerActionQueuedResult(res)) { surfaceQueuedOwnerAction(`Removing ${conn.label}`); return; }
        if (!res.value.ok) { toast({ message: `Could not remove ${conn.label}${res.value.reason ? `: ${res.value.reason}` : ""}.`, tone: "warn" }); return; }
        toast({ message: `${conn.label} removed.` });
        reload();
      } catch (err) {
        if (isUnauthorised(err)) { goSignedOut(); return; }
        toast({ message: `Could not remove ${conn.label}. ${stepUpAwareText(err)}`, tone: "warn" });
      }
    });
  }
  return removeBtn;
}

// samlHandoff is the SP metadata + ACS URL block on a SAML connection card: the customer downloads the SP
// EntityDescriptor and pastes the ACS URL into their IdP. The metadata download carries the session
// (engine.samlMetadata reads it as text); the ACS URL is a copyable derived value.
function samlHandoff(engine: EngineClient, connId: string): HTMLElement {
  const wrap = h("div", { class: "stack-sm", style: "display:grid;gap:var(--space-3)" });
  wrap.appendChild(
    h("p", { class: "field__hint measure" }, "Hand these to your SAML IdP so it knows where to send the signed assertion. The signing certificates inside the metadata are public; there is no secret here."),
  );

  // Download SP metadata. The fetch carries the session; on success a file is offered. A failure surfaces
  // inline (never a silent no-op).
  const dlError = h("p", { class: "field__error", role: "alert", hidden: true });
  const dlBtn = h("button", { "data-busy-label": "Preparing...", "data-dp": "idp-connections.button.saml-handoff", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_LICENCE, { size: 14 }), "Download SP metadata") as HTMLButtonElement;
  dlBtn.addEventListener("click", async () => {
    dlError.hidden = true;
    dlBtn.disabled = true;
    const prev = dlBtn.textContent;
    dlBtn.textContent = "Preparing...";
    try {
      const xml = await engine.samlMetadata(connId);
      downloadText(`sp-metadata-${connId}.xml`, xml, "application/samlmetadata+xml");
    } catch (err) {
      if (isUnauthorised(err)) { goSignedOut(); return; }
      dlError.textContent = `Could not fetch the SP metadata (${errText(err)}). The connection may no longer exist, or this engine build may not support SAML.`;
      dlError.hidden = false;
    } finally {
      dlBtn.disabled = false;
      dlBtn.textContent = prev;
    }
  });

  // The metadata URL (human-facing, copyable) so an IdP that fetches metadata by URL can be pointed at it.
  const metaUrl = engine.samlMetadataUrl(connId);
  const acsUrl = engine.samlAcsUrl(connId);

  wrap.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center" }, dlBtn, copyableUrl("SP metadata URL", metaUrl), copyableUrl("ACS (assertion consumer) URL", acsUrl)));
  wrap.appendChild(dlError);
  return wrap;
}

function copyableUrl(label: string, url: string): HTMLElement {
  return h(
    "span",
    { class: "field__hint", style: "display:inline-flex;gap:var(--space-1);align-items:center;max-width:100%" },
    h("span", { style: "color:var(--text-muted)" }, `${label}: `),
    h("span", { class: "mono", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: url }, url),
    copyButton(`Copy ${label}`, () => url),
  );
}
