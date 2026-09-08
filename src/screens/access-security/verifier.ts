// The LIVE Cloudflare Zero Trust verifier for the enforcement sub-view (the F7 fix, reading
// the REAL whoami verdict, never a hardcoded green) and the role-basis note shown beneath it.
// Extracted verbatim from enforcement.ts (finding console-src-024-01). The verdict leaves
// (deriveVerdict, reauthenticate) live in ./shared.ts so this module never imports a sibling
// panel; the METHOD-TO-VERDICT mapping itself is accessVerdictFromCaller (trust-chips.ts), the
// console's one read of it.

import { featureOutcomeForError, recordFeatureProbe } from "../../lib/client-diag/ring.ts";
import { h, svgIcon, scrollToSafe } from "../../lib/dom.ts";
import { refreshIdentity } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { accessVerdictPanel, type AccessVerdict } from "../../components/verdict.ts";
import { blockError } from "../../components/error-view.ts";
import {
  ICON_REFRESH,
  ICON_INFO,
  ICON_ALERT,
} from "../../lib/icons.ts";
import type { EngineClient, Role, RoleSource } from "../../api.ts";
import { accessVerdictFromCaller } from "../../components/trust-chips.ts";
import { noteLine, deriveVerdict, reauthenticate } from "./shared.ts";

// Bound the optimistic health probe so the tile never waits indefinitely; tight enough to give a
// quick verdict, loose enough to ride out a momentary edge hiccup.
const HEALTH_PROBE_TIMEOUT_MS = 8_000;

// renderVerifier shows the live verdict (the trust-closing step). It starts from what
// the shell already resolved at boot (whoami), and Re-verify re-probes. It distinguishes
// the four honest verdicts plus the pre-whoami session-present degrade and the
// CONSOLE_ORIGIN setup error, and NEVER a hardcoded green (F7). Returns its element plus
// the reverify callback, so the wizard's hand-off can trigger the same probe.
export function renderVerifier(engine: EngineClient): { el: HTMLElement; reverify: () => void } {
  const card = h("div", { class: "card", style: "display:grid;gap:var(--space-4)" });

  const head = h("div", { class: "card__header", style: "margin-bottom:0" });
  head.appendChild(h("h2", { class: "card__title" }, "Enforcement verifier"));
  card.appendChild(head);

  const verdictHost = h("div", { role: "region", "aria-label": "Access enforcement verdict" });
  card.appendChild(verdictHost);

  // The role-basis note sits below the verdict panel and is updated on each (re)verify.
  const roleBasisHost = h("div");

  const reverify = async (): Promise<void> => {
    // whoami is the honest probe: 200 method "access" -> verified; "token" -> fallback;
    // 401 -> unverified. A network failure with no response, when health is reachable,
    // is most often the CONSOLE_ORIGIN footgun (C2): surface it as a setup error, not
    // "engine down". We re-resolve identity so the shell chip stays in step.
    verdictHost.replaceChildren(verifyingTile());
    roleBasisHost.replaceChildren();
    try {
      const who = await engine.whoami();
      await refreshIdentity();
      // The FRESH whoami goes through the same one mapping the chip and the Overview use, so a re-verify
      // cannot reach a different verdict from the boot-resolved one for the same session, and an OIDC, SAML or
      // recovery session is never called the shared token by the button whose whole job is to state the posture.
      verdictHost.replaceChildren(panelFor(accessVerdictFromCaller(who, true), reverify));
      roleBasisHost.replaceChildren(roleBasisNote(who.roleSource, who.role, who.email, who.groups, who.identityProvider));
    } catch (err) {
      verdictHost.replaceChildren(verifierErrorTile(engine, err, reverify));
    }
  };

  // Initial paint from the boot-resolved caller (no extra round trip), honestly.
  // The role-basis note is populated only on a full re-verify (which reads roleSource
  // from whoami); the boot-time caller does not carry roleSource, so it is omitted here
  // rather than guessed. The hint says so, because a button's side effect must be
  // discoverable, not a surprise.
  verdictHost.replaceChildren(panelFor(deriveVerdict(), reverify));
  roleBasisHost.replaceChildren(
    h("p", { class: "field__hint" }, "Re-verify also shows the basis for your role (a direct grant, a group mapping, or the shared token)."),
  );

  // The role-basis host sits between the verdict and the notes (populated on re-verify).
  card.appendChild(roleBasisHost);

  // The honest no-anonymous-probe note (AS 1.3, storyboard panel 5): we do not stage a
  // fake anonymous request; the browser always carries the Access cookie. The factor-limit
  // caveat ("passed Access policy", never "used a second factor") is NOT restated here:
  // accessVerdictPanel always renders it per state (verdict.ts), so a standing copy of it
  // was pure duplication.
  card.appendChild(
    noteLine(
      ICON_INFO,
      "Your browser always carries your Access session, so the console cannot send an anonymous request from here to prove the edge blocks one. What it proves, and does, is that your engine reported this very request as Access-verified.",
    ),
  );

  return { el: card, reverify: () => void reverify() };
}

// panelFor renders the full verdict panel with the right actions: cautious states get a
// "Harden with Access" path into the wizard tab; unverified/unknown get re-authenticate.
function panelFor(verdict: AccessVerdict, reverify: () => void): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-3)" });
  wrap.appendChild(
    accessVerdictPanel({
      verdict,
      hardenAction: { label: "Harden with Access", onClick: () => focusWizard() },
      reauthAction: { label: "Re-authenticate via Access", onClick: () => reauthenticate() },
    }),
  );
  // A standing Re-verify control under the panel (re-probes whoami after hardening).
  const reBtn = h("button", { "data-dp": "access-security.button.panel-for", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Re-verify") as HTMLButtonElement;
  reBtn.addEventListener("click", () => void reverify());
  wrap.appendChild(h("div", reBtn));
  return wrap;
}

// verifyingTile is the honest loading state ("Asking your engine what it verified"). It
// mirrors the verdict panel's head geometry (icon + headtext) so the skeleton occupies
// the same shape the resolved verdict will, avoiding a layout jump.
function verifyingTile(): HTMLElement {
  const icon = h("div", { class: "verdict__icon skeleton", "aria-hidden": "true", style: "border-radius:var(--radius-full)" });
  const body = h("div", { class: "verdict__headtext" });
  body.appendChild(h("div", { class: "skeleton", style: "height:18px;width:60%;margin-bottom:8px" }));
  body.appendChild(h("div", { class: "skeleton", style: "height:13px;width:80%" }));
  body.appendChild(h("span", { class: "visually-hidden" }, "Asking your engine what it verified for this request."));
  return h("div", { class: "verdict", role: "status", "aria-busy": "true" }, h("div", { class: "verdict__head" }, icon, body));
}

// verifierErrorTile diagnoses a failed probe: a 401 is the unverified verdict (re-auth),
// not an error; a no-response failure with health reachable is the CONSOLE_ORIGIN setup
// error (red); anything else is an honest block error with Retry.
export function verifierErrorTile(engine: EngineClient, err: unknown, reverify: () => void): HTMLElement {
  if (isUnauthorised(err)) {
    return panelFor({ state: "unverified" }, reverify);
  }
  const origin = location.origin;
  const kind = classifyError(err, { origin });
  if (kind.kind === "network") {
    // Optimistic paint: assume CONSOLE_ORIGIN misconfiguration (the common cause of a
    // network-level failure when health is later reachable). The health probe either
    // confirms this (no repaint needed, the tile is already correct) or disproves it
    // (repaint to the plain block-error). Only repaint on a real state change.
    const host = h("div", { style: "display:grid;gap:var(--space-3)" });
    host.appendChild(consoleOriginTile(origin, reverify));
    // Bound the health probe (HEALTH_PROBE_TIMEOUT_MS) so the tile never waits indefinitely.
    const healthWithTimeout = Promise.race([
      engine.health(),
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("health probe timed out")), HEALTH_PROBE_TIMEOUT_MS)),
    ]);
    void healthWithTimeout
      .then(() => {
        // Health responded: the CONSOLE_ORIGIN tile is the correct diagnosis. No repaint.
        // THIS IS THE VERDICT, AND IT WAS BEING THROWN AWAY. The authenticated call threw with no response
        // AND the unauthenticated health probe answered in the same breath: that pair is the CORS fingerprint, and
        // it is the difference between "set CONSOLE_ORIGIN on the engine" (a two-minute fix) and "your engine is
        // down" (a support call). The console computes it, paints it, and until now kept no record of ever having
        // reached it, so a customer who saw this tile and closed the tab left nothing behind.
        recordFeatureProbe("whoami", "origin-rejected");
      })
      .catch(() => {
        // Health also failed (or timed out): engine is unreachable, not a CONSOLE_ORIGIN
        // issue. Switch to the plain block error (real state change).
        // The OTHER half of the same fork, and it must be its own row: an engine that is genuinely
        // unreachable and one that is up and rejecting the origin are the two states this whole probe exists to
        // separate, and a single "network" row for both would separate nothing.
        recordFeatureProbe("whoami", "network");
        host.replaceChildren(blockError(err, reverify, { origin }));
      });
    return host;
  }
  // whoami absent (D1 pending) returns a non-2xx the engine client throws as a generic
  // error; present it as the honest session-present degrade rather than a hard failure,
  // because the shell did connect. A genuine network failure is diagnosed above
  // (console-origin versus unreachable); a server error here is the connected-but-degraded case.
  if (kind.kind === "server") {
    // A whoami 5xx presented to the operator as a benign "your session is present" degrade. It reads as a
    // healthy-but-quiet console; it is a broken engine. This is the "the verifier just says session-present
    // forever" ticket, and the tile it renders is the reason nobody escalated it. The verdict is recorded even
    // though the paint stays calm: the customer's screen and the pack's evidence need not agree about severity,
    // and here they must not.
    const serverOutcome = featureOutcomeForError(err);
    if (serverOutcome !== null) recordFeatureProbe("whoami", serverOutcome);
    return panelFor({ state: "session-present" }, reverify);
  }
  const outcome = featureOutcomeForError(err);
  if (outcome !== null) recordFeatureProbe("whoami", outcome);
  return blockError(err, reverify, { origin });
}

// consoleOriginTile is the red setup-error verdict for the CONSOLE_ORIGIN/redirect
// footgun (C2, wireframe state 4). It names the exact value to set and offers Retry.
function consoleOriginTile(origin: string, reverify: () => void): HTMLElement {
  const card = h("div", { class: "verdict verdict--danger", role: "alert" });
  card.appendChild(
    h(
      "div",
      { class: "verdict__head" },
      h("span", { class: "verdict__icon", "aria-hidden": "true" }, svgIcon(ICON_ALERT, { size: 22 })),
      h("div", { class: "verdict__headtext" }, h("h3", { class: "verdict__title" }, "Could not verify: the engine did not respond to an authenticated request")),
    ),
  );
  const body = h("p", { class: "verdict__body" });
  body.appendChild(document.createTextNode("The engine answered "));
  body.appendChild(h("span", { class: "mono" }, "GET /admin/health"));
  body.appendChild(document.createTextNode(" but the authenticated call failed with no response. The likely cause is that the engine's "));
  body.appendChild(h("span", { class: "mono" }, "CONSOLE_ORIGIN"));
  body.appendChild(document.createTextNode(" is not set to this console's origin ("));
  body.appendChild(h("span", { class: "mono" }, origin));
  body.appendChild(document.createTextNode(")."));
  card.appendChild(body);
  card.appendChild(h("p", { class: "verdict__caveat field__hint" }, "Set CONSOLE_ORIGIN on the engine to this origin, then re-verify. This is a setup error, not an engine outage."));
  const retry = h("button", { "data-dp": "access-security.button.retry", class: "btn btn--secondary btn--sm", type: "button" }, "Retry") as HTMLButtonElement;
  retry.addEventListener("click", () => void reverify());
  card.appendChild(h("div", { class: "verdict__actions" }, retry));
  return card;
}

// focusWizard moves focus to the setup wizard heading (the "harden" path stays on the
// Enforcement tab, where the wizard already lives, so no navigation is needed).
function focusWizard(): void {
  // The wizard sits behind a collapsed disclosure (calm contract): open it first so
  // the hand-off lands on visible content, then scroll + focus its heading.
  const host = document.getElementById("access-wizard-disclosure") as HTMLDetailsElement | null;
  if (host && !host.open) host.open = true;
  const target = document.getElementById("access-wizard-heading");
  if (target) {
    scrollToSafe(target, { behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------------------
// Role-basis note (surfaced in the enforcement verifier after a re-verify)
// ---------------------------------------------------------------------------

// roleBasisNote explains WHY the caller holds the role they hold, using the
// roleSource the engine reports in whoami. It is shown below the verdict panel
// after a re-verify, not before (it requires a live whoami round trip). The
// wording is precise: "passed Cloudflare Access policy", never "used a second
// factor". Groups are the customer's own directory data; they are escaped by
// the h() text-node path and never injected as HTML.
export function roleBasisNote(
  roleSource: RoleSource,
  role: Role,
  email: string | null,
  groups: string[],
  identityProvider: string | undefined,
): HTMLElement {
  const wrap = h("div", { class: "card card--inset", style: "margin-top:var(--space-2)" });
  const row = h("div", { style: "display:flex;gap:var(--space-2);align-items:flex-start" });
  row.appendChild(h("span", { style: "color:var(--trust);flex:none;margin-top:2px" }, svgIcon(ICON_INFO, { size: 16 })));

  const providerSuffix = identityProvider ? ` via ${identityProvider}` : "";

  let basisEl: HTMLElement;
  switch (roleSource) {
    case "owner-token": {
      basisEl = h("span", h("b", "Role basis: "), "owner via the shared token (break-glass). Actions on this path are not attributed to a person in the audit log; prefer Cloudflare Access for attributable per-person access.");
      break;
    }
    case "email": {
      const emailStr = email ?? "unknown";
      basisEl = h("span", h("b", "Role basis: "), `granted directly to `, h("span", { class: "mono" }, emailStr), ` (${roleSource}${providerSuffix}).`);
      break;
    }
    case "group": {
      const groupsEl = h("span");
      if (groups.length === 0) {
        groupsEl.appendChild(document.createTextNode("your identity-provider group(s)"));
      } else {
        for (const [i, g] of groups.entries()) {
          if (i > 0) groupsEl.appendChild(document.createTextNode(", "));
          groupsEl.appendChild(h("span", { class: "mono" }, g));
        }
      }
      basisEl = h("span");
      basisEl.appendChild(h("b", "Role basis: "));
      basisEl.appendChild(document.createTextNode(`${role} via your identity-provider group(s): `));
      basisEl.appendChild(groupsEl);
      if (providerSuffix) basisEl.appendChild(document.createTextNode(providerSuffix));
      basisEl.appendChild(document.createTextNode(". Group mapping applies when a sign-in carries groups (Cloudflare Access, or a native identity provider that sends groups)."));
      break;
    }
    case "custom": {
      basisEl = h("span", h("b", "Role basis: "), "a custom role (an account-defined capability bundle) conferred by a per-email grant or a group mapping that named it. Its authority is the role's own capability set, resolved and enforced by the engine; the built-in role is the least-privilege viewer floor.");
      break;
    }
    case "default": {
      basisEl = h("span", h("b", "Role basis: "), "viewer (default, no explicit grant). No per-email or per-group role was found; the engine falls back to the least-privilege default.");
      break;
    }
  }
  row.appendChild(basisEl);
  wrap.appendChild(row);
  return wrap;
}
