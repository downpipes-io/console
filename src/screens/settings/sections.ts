// The standing sections of the Settings screen: the live engine-connection verdict (with the CONSOLE_ORIGIN
// diagnostic), the backup-configuration and dual-change-control hand-offs (one quiet line each, pointing
// at the owning screens; no duplicate management surface), the data-residency transparency, the controlled
// offboarding flow, and the demo-only "Reset demo to fresh" affordance (rendered only when the engine reports
// demoMode). None of the engine's secrets are written here. Moved verbatim from the settings coordinator for
// size; behaviour, copy and markup are unchanged.
//
// House style: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { navigate, signOut, goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { openModal } from "../../components/modal.ts";
import { field, validateForm } from "../../components/field.ts";
import { blockError, inlineRetry, sessionEnded } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { toast } from "../../components/toast.ts";
import { statusWithLabel, type StatusTone } from "../../components/status.ts";
import type { EngineClient, StatusReport } from "../../api.ts";
import { runExportDownload, saveFile } from "../../lib/control-plane-export-download.ts";
import { openEstateImportModal } from "../../components/estate-import-modal.ts";

// Lets the "Demo reset" toast render before the page reload navigates away.
const RESET_TOAST_RENDER_MS = 600;

// renderDemoSection renders the demo-only "Reset demo to fresh" affordance, but ONLY when the engine
// reports demoMode (a throwaway demo deployment). On a real engine it renders nothing, and the reset
// route 404s there anyway. demoMode is fetched async (status); a hiccup simply shows nothing.
export function renderDemoSection(engine: EngineClient): HTMLElement {
  const host = h("div");
  void engine
    .status()
    .then((s) => {
      if (s.demoMode !== true) return;
      const section = h("section", { class: "measure" });
      section.appendChild(h("h2", { class: "section-title" }, "Demo"));
      section.appendChild(
        h(
          "p",
          { class: "field__hint" },
          "This is a throwaway DEMO deployment. Reset wipes it back to a fresh first-run, identity, configuration, the credential registry, history, everything, so you can re-walk the product or test a new version. It never touches a production engine.",
        ),
      );
      const btn = h("button", { "data-dp": "settings.button.open-demo-reset-modal", class: "btn btn--danger btn--sm", type: "button" }, "Reset demo to fresh") as HTMLButtonElement;
      btn.addEventListener("click", () => openDemoResetModal(engine));
      section.appendChild(btn);
      host.appendChild(section);
    })
    .catch(() => {
      /* status hiccup: just don't show the demo control */
    });
  return host;
}

// openDemoResetModal prompts for the demo engine's ADMIN_TOKEN, then wipes the demo to first-run and
// reloads to the bootstrap screen. The token is the engine's reset credential (sent once, never stored).
function openDemoResetModal(engine: EngineClient): void {
  const tokenField = field({
    id: "demo-reset-token",
    label: "ADMIN_TOKEN",
    type: "password",
    required: true,
    autocomplete: "off",
    hint: "Paste the demo engine's ADMIN_TOKEN to authorise the reset. It is sent once and never stored.",
    validate: (v) => (v.trim().length > 0 ? null : "Paste the ADMIN_TOKEN."),
    doc: { href: "https://docs.downpipes.io/reference/api/admin-endpoints", anchor: "demo-only" },
  });
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const body = h(
    "form",
    { class: "form-stack", style: "display:grid;gap:var(--space-4)", "aria-label": "Reset the demo to fresh", on: { submit: (ev: Event) => ev.preventDefault() } },
    h("p", { style: "color:var(--text)" }, "This wipes the demo back to first-run and signs you out. The page reloads to the bootstrap screen, where you sign in with the ADMIN_TOKEN and register a fresh passkey. It cannot be undone (it is a demo)."),
    tokenField.el,
    formError,
  );
  openModal({
    title: "Reset demo to fresh",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Reset to fresh",
        variant: "danger",
        busyLabel: "Resetting",
        onClick: async () => {
          formError.hidden = true;
          if (!validateForm([tokenField])) return false;
          try {
            await engine.resetDemoFresh(tokenField.value());
            toast({ message: "Demo reset, reloading to first-run." });
            setTimeout(() => window.location.assign("/"), RESET_TOAST_RENDER_MS);
            return true;
          } catch (err) {
            formError.textContent = err instanceof Error ? err.message : String(err);
            formError.hidden = false;
            return false;
          }
        },
      },
    ],
  });
}

// renderBackupConfigPointers is the honest hand-off for the owner-level backup
// configurations people look for under Settings first: where backups go
// (Destinations), the account-discovery token (Sources), and stale/failure alert
// routing (Notifications, the single owning surface, where a channel plus a rule
// says where an alert goes). One quiet line each, no duplicate management surface,
// the owning screens stay the single levers.
export function renderBackupConfigPointers(engine: EngineClient): HTMLElement {
  const section = h("section", { class: "measure" });
  section.appendChild(h("h2", { class: "section-title" }, "Backup configuration"));
  section.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Where backups go lives in ",
      h("button", { "data-dp": "settings.button.navigate-destinations", class: "linklike", type: "button", on: { click: () => navigate("/destinations") } }, "Destinations"),
      "; the account-discovery token (who set it, which accounts, replace or remove) lives in ",
      h("button", { "data-dp": "settings.button.navigate-sources", class: "linklike", type: "button", on: { click: () => navigate("/sources") } }, "Sources"),
      "; stale and failure alert routing (Slack, PagerDuty, webhooks, email) lives in ",
      h("button", { "data-dp": "settings.button.navigate-notifications", class: "linklike", type: "button", on: { click: () => navigate("/notifications") } }, "Notifications"),
      ". All are Owner actions, audited.",
    ),
  );
  // Download the current signed control-plane export (Downpipes' own configuration) to keep with the recovery
  // kit, so the setup can be re-entered after a total loss even without bucket access. No plaintext secret.
  section.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Downpipes signs a copy of your own configuration (downpipes, destinations, roles and policy) to your destination buckets. Download a fresh copy to keep with your recovery kit; it carries no plaintext secret.",
    ),
  );
  const dlBtn = h("button", { "data-dp": "settings.button.backup-config-pointers", class: "btn btn--secondary btn--sm", type: "button" }, "Download config export") as HTMLButtonElement;
  dlBtn.addEventListener("click", () => {
    dlBtn.disabled = true;
    void runExportDownload(engine, {
      save: saveFile,
      onError: (msg) => {
        toast({ message: `Could not download the config export: ${msg}`, tone: "warn", durationMs: 0 });
        dlBtn.disabled = false;
      },
      onDone: () => {
        toast({ message: "Downloaded your signed control-plane export (JSON and signature). Keep both with your recovery kit." });
        dlBtn.disabled = false;
      },
    });
  });
  section.appendChild(dlBtn);
  // Recover a LOST estate onto this fresh engine from a signed export + the recovery-kit signer.pub. The
  // engine verifies against your own key and imports only the definition (no operator access). This is the
  // cross-environment recovery entry point; on a healthy estate you will not need it.
  const importBtn = h("button", { "data-dp": "settings.button.import", class: "btn btn--secondary btn--sm", type: "button" }, "Recover an estate from a signed export") as HTMLButtonElement;
  importBtn.addEventListener("click", () => openEstateImportModal(engine));
  section.appendChild(importBtn);
  return section;
}

// renderAccessControlPointers is the honest hand-off for the access controls owners look for under
// Settings: dual control (four-eyes) lives in the Security Centre, not here. Owners came here
// to find it, so this points straight at it with a deep link that opens and scrolls to the toggle,
// no duplicate management surface (the Security Centre stays the single lever, and the engine enforces
// Owner-only writes there regardless of who can see it).
export function renderAccessControlPointers(): HTMLElement {
  const section = h("section", { class: "measure" });
  section.appendChild(h("h2", { class: "section-title" }, "Dual control"));
  section.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Dual control (four-eyes) requires a config change to be approved by a second authorised person before it takes effect, the approver must differ from whoever proposed it and hold that change's own permission. Turn it on or off in the ",
      h("button", { "data-dp": "settings.button.navigate-security-open-dual-control", class: "linklike", type: "button", on: { click: () => navigate("/security?open=dual-control") } }, "Security centre"),
      ". It is an Owner setting, audited.",
    ),
  );
  return section;
}

export function renderConnection(engine: EngineClient): HTMLElement {
  // An unboxed section: heading + content on the canvas; a
  // card here was containment for nothing.
  const card = h("section", { class: "measure" });
  card.appendChild(h("h2", { class: "section-title" }, "Engine connection"));

  // One topology: the console serves the engine on this same address (the serving worker
  // proxies /admin/* over its service binding), so there is no engine address to enter,
  // correct, or copy. This section states that plainly and probes the engine live.
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Your engine is served on this same address. Every admin call stays on this origin; the console makes no vendor requests.",
    ),
  );

  const verdict = h("div", { class: "conn-verdict", style: "margin-top:var(--space-3)" });

  const probe = async (client: EngineClient) => {
    verdict.replaceChildren(skeletonRows(1));
    // Health first (it may be same-origin and simple). Then an authenticated call to
    // distinguish "engine reachable but CONSOLE_ORIGIN wrong" from "unreachable".
    let healthOk = false;
    try {
      const h1 = await client.health();
      healthOk = h1.ok;
    } catch {
      healthOk = false;
    }
    try {
      const status = await client.status();
      const readyNote = status.ready ? "ready" : "not yet ready (incomplete onboarding)";
      // The downpipe count is the connection-readiness fact this verdict owns; the
      // destination kind is stated in the Data and residency disclosure below.
      const dpNote = status.downpipeCount === 0
        ? "No downpipes configured."
        : `${status.downpipeCount} downpipe${status.downpipeCount === 1 ? "" : "s"} configured.`;
      verdict.replaceChildren(
        statusWithLabel("ok", `Connected. Engine ${status.engineVersion}, ${readyNote}.`),
        h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, dpNote),
      );
    } catch (err) {
      if (isUnauthorised(err)) {
        // 401 is a sign-in matter, not a connection fault: the engine is reachable.
        // Advice comes with the control to act on it (the real sign-out bridge).
        verdict.replaceChildren(
          statusWithLabel("warn", "Reachable, but your Access session is not valid for this engine."),
          h(
            "p",
            { class: "field__hint", style: "margin-top:var(--space-2)" },
            h("button", { "data-dp": "settings.button.sign-out#1", class: "linklike", type: "button", on: { click: () => signOut() } }, "Sign in again"),
            " via Cloudflare Access.",
          ),
        );
        return;
      }
      verdict.replaceChildren(blockError(err, () => void probe(client), { origin: location.origin, healthReachable: healthOk }));
    }
  };

  card.appendChild(verdict);

  // Probe the current connection on open so the verdict is live.
  void probe(engine);
  return card;
}

export function renderResidency(engine: EngineClient): HTMLElement {
  // Disclosure body (the heading lives in the summary); fetches on first open.
  const card = h("div");
  const host = h("div");
  card.appendChild(host);

  // The failure branch used to be "Could not read the destination kind." and nothing else. It named
  // no remedy and left nothing to press, so a single failed status read hid this panel's whole answer (where
  // the archives land, and whether that moves data out of the account) for the life of the screen.
  const load = (): void => {
    host.replaceChildren(skeletonRows(1));
    void engine
      .status()
      .then((status: StatusReport) => host.replaceChildren(residencyBody(status)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the residency answer is a skeleton until this replaces it.
          host.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        host.replaceChildren(
          inlineRetry({
            message: "The engine did not answer with its destination kind, so where your archives land is not shown here. Nothing about the destination has changed.",
            onReload: load,
          }),
        );
      });
  };
  load();
  return card;
}

function residencyBody(status: StatusReport): HTMLElement {
  const wrap = h("div");
  // A third provider was silently wrong here before it was named: a configured Google Cloud destination
  // fell to the else arm and the residency panel read "No destination kind set", telling an operator with
  // a working destination that they had none. The compiler could not see it, because the ternary chain
  // already had an else, and the same trap is why Azure is added here by hand rather than left to the
  // widened union to catch.
  const destTone: StatusTone = status.destKind === "r2" ? "ok" : status.destKind === "s3" || status.destKind === "gcs" || status.destKind === "azure" ? "info" : "neutral";
  const destLabel =
    status.destKind === "r2"
      ? "In-account R2 (recommended; no destination credentials on the wire)"
      : status.destKind === "s3"
        ? "S3 (verify the region and account; this can move data out of your account)"
        : status.destKind === "gcs"
          ? "Google Cloud Storage (verify the project and bucket; this moves data out of your Cloudflare account)"
          : status.destKind === "azure"
            ? "Azure Blob Storage (verify the storage account and container; this moves data out of your Cloudflare account)"
            : "No destination kind set";
  wrap.appendChild(h("div", { style: "margin-bottom:var(--space-3)" }, statusWithLabel(destTone, destLabel)));
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      // The no-vendor-requests fact lives in the eager connection section above;
      // restating it here was the same claim in different words on one screen.
      "Backups are written to your chosen in-account destination. Console-to-engine traffic is in-account, and nothing customer-identifying leaves your account.",
    ),
  );
  return wrap;
}

export function renderOffboarding(): HTMLElement {
  // Disclosure body (the heading lives in the summary).
  const card = h("div");
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Remove a departing member's in-app role on the Roles screen (the change is audited). The console cannot deprovision your IdP, so removing their Cloudflare Access or IdP access is a step you complete in your dashboard; the console guides it but cannot do it for you.",
    ),
  );
  const actions = h(
    "div",
    { class: "settings-actions" },
    h("button", { "data-dp": "settings.button.navigate-access-roles", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/access/roles") } }, "Manage roles"),
    // The REAL sign-out (the shell account-menu path via the nav bridge), not the 401
    // redirect, so the adjacent copy about clearing state is true and the session does
    // not survive the Back button.
    h("button", { "data-dp": "settings.button.sign-out#2", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => signOut() } }, "Sign out"),
  );
  card.appendChild(actions);
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Sign out clears in-memory session state in this browser and ends the engine passkey session if one exists; it does not end your Cloudflare Access session (that lives at the edge). Any downloaded key files remain on your disk and are yours to keep offline.",
    ),
  );
  return card;
}
