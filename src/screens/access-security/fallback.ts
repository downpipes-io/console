// Sessions and fallback sub-view of the Access and security area: the session context card,
// self-service and admin session controls, the caller's own passkey inventory, the demoted
// shared-token disclosure (the Require-Access lock-out guardrail, an honest read-only posture,
// not a switch), and the link to the single offboarding ceremony on the Roles tab. The engine
// enforces the session and passkey levers; the console mirrors who may run them. Shared verdict
// and badge leaves come from ./shared.ts.

import { h, svgIcon, type Child } from "../../lib/dom.ts";
import { navigate, signOut, caller, whoamiAvailable, goSignedOut } from "../../lib/nav.ts";
import { codeBlock } from "../../components/code-block.ts";
import { badge } from "../../components/status.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { relativeTime } from "../../lib/format.ts";
import { ICON_EXTERNAL, ICON_LOCK, ICON_ALERT } from "../../lib/icons.ts";
import type { EngineClient, RequireAccessPreflight } from "../../api.ts";
import { ROUTE_ROLES, roleBadge, noteLine, deriveVerdict, reauthenticate, statusLine } from "./shared.ts";
import { sessionsAndPasskeysSection } from "./sessions-passkeys.ts";

export function renderFallbackPanel(engine: EngineClient): HTMLElement {
  // A11Y-05: the fallback tabpanel gets a section-level h2 below the screen h1, so the
  // card h3/h4 headings sit under a real section heading rather than jumping from h1.
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-5)", "aria-labelledby": "fallback-h" });
  wrap.appendChild(
    h(
      "div",
      { style: "display:grid;gap:var(--space-1)" },
      h("h2", { id: "fallback-h", style: "font-size:var(--text-lg)" }, "Sessions and fallback"),
      h("p", { class: "field__hint measure" }, "Your current session, session and passkey controls, and the lower-assurance shared-token path. The console surfaces these honestly; closing the token path and ending an IdP session are engine and Cloudflare actions, not console switches."),
    ),
  );

  wrap.appendChild(sessionCard());
  // Sessions and passkeys (ASVS V7.4.5 (L2) / V7.5.2 (L2) PARTIAL / V6.5.6 (L3, implemented)): self-service session termination + the
  // caller's own passkey inventory for any authenticated user, and the admin session levers gated to the
  // appropriate capability. Placed under "This session" so the related session controls sit together.
  // The section itself lives in ./sessions-passkeys.ts (its own cohesive module).
  wrap.appendChild(sessionsAndPasskeysSection(engine));

  // The shared-token disclosure is already collapsed; offboarding lives on the Roles tab (one
  // ceremony, one record), linked rather than duplicated here.
  // align-items:start so the collapsed shared-token disclosure keeps its natural height instead of
  // stretching to match the taller sibling card (a stretched closed <details> reads as an empty slab).
  const grid = h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:var(--space-5);align-items:start", class: "fallback-grid" });
  grid.appendChild(tokenFallbackDisclosure(engine));
  grid.appendChild(offboardingLinkCard());
  wrap.appendChild(grid);
  return wrap;
}

// tokenFallbackDisclosure demotes the shared token behind a disclosure with a loud posture warning (AS 1.5).
// console-access-1: the require-Access affordance is an HONEST READ-ONLY posture status, not an interactive
// control that does nothing. Setting the posture is still out of band (ADMIN_TOKEN_DISABLED is an env var the
// console cannot write, by no-custody design), but READING it is not: POST /admin/policy/require-access is the
// engine's authoritative verdict, and the console now consults it BEFORE it advises closing the token path.
//
// Why the consult is load-bearing rather than decorative (AUTH-1). Deleting or disabling the token is an act
// the engine cannot intercept and the operator cannot undo from the app. If no second factor is enrolled (no
// owner passkey, no Cloudflare Access, no recovery codes, no second owner), doing it locks them out, and the
// in-app recovery paths need a working credential too. So the engine computes safeToDisableToken, and this
// panel shows the closing steps ONLY when that verdict is true; otherwise it shows the engine's own
// lockoutWarning verbatim rather than paraphrasing a safety verdict. A caller on the bare token is refused
// too, because disabling it mid-session would strand even them.
//
// FAIL SAFE, and not silently: when the pre-flight cannot be read the panel says so and withholds the steps,
// because an unread verdict is not a permission.
function tokenFallbackDisclosure(engine: EngineClient): HTMLElement {
  const details = h("details", { class: "card", style: "padding:0" });
  const summary = h("summary", { style: "cursor:pointer;padding:var(--space-4) var(--space-5);display:flex;align-items:center;gap:var(--space-2);font-weight:var(--weight-medium);color:var(--warn-fg)" });
  summary.appendChild(svgIcon(ICON_ALERT, { size: 16 }));
  summary.appendChild(document.createTextNode("Advanced: shared token (break-glass) fallback"));
  details.appendChild(summary);

  const inner = h("div", { style: "padding:0 var(--space-5) var(--space-5);display:grid;gap:var(--space-3)" });
  inner.appendChild(h("p", { class: "field__hint", style: "color:var(--warn-fg)" }, "A shared token cannot be rotated per person, is unattributable in the audit log, and is a phishing and screenshot risk. Prefer Cloudflare Access."));
  inner.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "The shared admin token is entered on the connect screen, not here, and lives only in memory; the console never persists it. The engine never downgrades a present-but-invalid Access assertion to the token path.",
    ),
  );
  inner.appendChild(h("hr", { style: "border:none;border-top:1px solid var(--border-subtle);margin:var(--space-1) 0" }));

  // Require-Access POSTURE, read from the engine rather than guessed from this session. The old copy here
  // derived the posture from the caller's own Access verdict and then said in as many words that the console
  // could not read it; the engine had shipped the read all along and nothing called it.
  inner.appendChild(h("h4", { style: "font-size:var(--text-md);margin:0" }, "Require Access (close the shared-token path)"));
  const host = h("div", { style: "display:grid;gap:var(--space-3)" });
  inner.appendChild(host);

  function loadPreflight(): void {
    host.replaceChildren(skeletonRows(2));
    void engine.requireAccessPreflight()
      .then((pf) => host.replaceChildren(requireAccessBody(pf)))
      .catch((err: unknown) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the Require-Access preflight is a skeleton until this replaces it.
          host.replaceChildren(sessionEnded(() => loadPreflight()));
          return goSignedOut();
        }
        // Withhold the closing steps: an unread verdict is not a permission. The Retry re-reads.
        host.replaceChildren(
          statusLine("warn", "The engine's lock-out check could not be read", "The steps for closing the token path are withheld until the engine confirms you have another way in. Closing it without one locks you out, and the recovery paths need a working credential too."),
          blockError(err, () => loadPreflight()),
        );
      });
  }
  loadPreflight();

  details.appendChild(inner);
  return details;
}

// requireAccessBody renders the engine's verdict. Split out so the branch table is one readable place and so
// the console's own suite drives every branch from a plain object rather than through the network.
export function requireAccessBody(pf: RequireAccessPreflight): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-3)" });

  if (pf.enforced) {
    wrap.appendChild(
      statusLine("ok", "The shared-token path is closed", "Your engine reports that only Cloudflare Access verified requests are accepted. Nothing further is needed here."),
    );
    return wrap;
  }
  if (pf.tokenFallbackDisabled) {
    wrap.appendChild(
      statusLine("warn", "The token path is disabled, but Access is not configured", "Your engine reports the shared-token fallback off while Cloudflare Access is not wired, which leaves no accepted sign-in path. Wire Access (the team domain and the AUD tag) before relying on this posture."),
    );
    return wrap;
  }

  wrap.appendChild(
    statusLine(
      "warn",
      "Shared-token path reachable",
      pf.accessConfigured
        ? "Cloudflare Access is configured and the shared token is still accepted as a fallback. Closing the token path leaves Access as the only way in."
        : "Cloudflare Access is not configured, so the engine is administrable with the shared token alone.",
    ),
  );

  if (!pf.safeToDisableToken) {
    // The engine's own words, verbatim. When there IS a second factor but this caller is on the bare token,
    // the engine sends no warning text, so the console states that narrower refusal itself.
    wrap.appendChild(
      noteLine(
        ICON_ALERT,
        pf.lockoutWarning !== null
          ? pf.lockoutWarning
          : "You are signed in with the shared token itself, so closing the token path now would end your own access mid-session. Sign in with a passkey or through Cloudflare Access, then close it from that session.",
      ),
    );
    wrap.appendChild(h("p", { class: "field__hint" }, secondFactorSentence(pf)));
    wrap.appendChild(
      h(
        "p",
        { class: "field__hint" },
        "The steps for closing the token path appear here once your engine reports it is safe. ",
        h(
          "a",
          { class: "field__doc linklike", href: "https://docs.downpipes.io/operations/identity-and-access#retire-the-token-once-a-way-back-in-exists", target: "_blank", rel: "noreferrer noopener" },
          "Arranging another way back in",
        ),
      ),
    );
    return wrap;
  }

  // Safe to advise. This is guidance, not a console action: the console configures nothing and submits no
  // secret (no-custody). Closing the token path is done by removing the engine's ADMIN_TOKEN secret.
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Your engine reports another way in, and you are not signed in with the token itself, so closing the token path will not lock you out. Run this against your engine in your own account:",
    ),
  );
  wrap.appendChild(codeBlock("wrangler secret delete ADMIN_TOKEN", { copyLabel: "Copy the close-token command" }));
  wrap.appendChild(noteLine(ICON_LOCK, `${secondFactorSentence(pf)} The console never submits a secret; this command is yours to run, and there is deliberately no console switch that claims to set the posture, because the console cannot enforce it.`));
  return wrap;
}

// secondFactorSentence names WHICH ways back in the engine found, so an operator who has none learns what to
// arrange rather than only that something is missing. Pure, so the suite reads it without a DOM.
export function secondFactorSentence(pf: RequireAccessPreflight): string {
  const present: string[] = [];
  if (pf.secondFactor.passkeyOwnerEnrolled) present.push("an Owner passkey");
  if (pf.secondFactor.accessConfigured) present.push("Cloudflare Access");
  if (pf.secondFactor.recoveryReady) present.push("recovery codes");
  if (pf.secondFactor.secondOwner) present.push("a second Owner");
  if (present.length === 0) return "Your engine reports no other way in: no Owner passkey, no Cloudflare Access, no recovery codes and no second Owner.";
  return `Ways back in your engine can see: ${present.join(", ")}.`;
}

// offboardingLinkCard points at the SINGLE offboarding ceremony (the Remove action on the
// member's row, Roles and access tab, which runs openOffboardModal), rather than running a
// second removal flow with divergent ceremony here. One path means the IdP confirmation is
// always offered and, when given, always recorded.
function offboardingLinkCard(): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "offboard-h" });
  card.appendChild(h("div", { class: "card__header" }, h("h3", { class: "card__title", id: "offboard-h" }, "Offboard a member")));
  card.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "Offboarding lives on the Roles and access tab: use Remove on the member's row (Owner only). It removes the in-app role immediately, audits it, and records your confirmation of the IdP / Access cleanup the console cannot do for you.",
    ),
  );
  const btn = h(
    "button",
    { "data-dp": "access-security.button.navigate#1", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate(ROUTE_ROLES) } },
    "Open Roles and access",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  );
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, btn));
  return card;
}

// sessionCard surfaces the verified identity, role, protected hostname and session
// expiry (D1), with an honest re-auth + sign-out that credit the edge. Pre-whoami it
// omits the expiry rather than faking it, and never shows a fabricated email or green.
function sessionCard(): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "session-h" });
  card.appendChild(h("div", { class: "card__header" }, h("h3", { class: "card__title", id: "session-h" }, "This session")));

  const c = caller();
  const known = whoamiAvailable() && c;

  const grid = h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--space-4)", class: "session-grid" });

  const left = h("div", { style: "display:grid;gap:var(--space-2)" });
  left.appendChild(sessionRow("Identity", known && c!.email ? h("span", { class: "mono" }, c!.email) : h("span", { class: "field__hint" }, "from Cloudflare Access (the engine does not yet report it)")));
  left.appendChild(sessionRow("Identity provider", known && c!.identityProvider ? c!.identityProvider : h("span", { class: "field__hint" }, "not reported")));
  left.appendChild(sessionRow("Active role", known ? roleBadge(c!.role) : h("span", { class: "field__hint" }, "not yet reported")));
  // Groups: show the caller's verified IdP groups when present. These are the customer's
  // own directory data. Empty list = Access not wired or IdP does not send groups.
  if (known && c!.groups.length > 0) {
    const groupList = h("span", { class: "field__hint" });
    for (const [i, g] of c!.groups.entries()) {
      if (i > 0) groupList.appendChild(document.createTextNode(", "));
      groupList.appendChild(h("span", { class: "mono" }, g));
    }
    left.appendChild(sessionRow("IdP groups (verified)", groupList));
  }
  grid.appendChild(left);

  const right = h("div", { style: "display:grid;gap:var(--space-2)" });
  right.appendChild(sessionRow("Protected hostname", h("span", { class: "mono" }, location.host)));
  // Expiry is omitted rather than faked when not known (AS 4 degrade rule).
  if (known && c!.method === "access" && c!.sessionExpiresAt !== undefined) {
    right.appendChild(sessionRow("Session expires", h("span", { class: "tnum" }, relativeTime(c!.sessionExpiresAt * 1000))));
  } else {
    right.appendChild(sessionRow("Session expires", h("span", { class: "field__hint" }, "not reported")));
  }
  right.appendChild(sessionRow("Auth method", authMethodBadge()));
  grid.appendChild(right);

  card.appendChild(grid);
  card.appendChild(h("hr", { style: "border:none;border-top:1px solid var(--border-subtle);margin:var(--space-4) 0" }));

  const footer = h("div", { style: "display:flex;justify-content:space-between;gap:var(--space-3);align-items:center;flex-wrap:wrap" });
  footer.appendChild(h("p", { class: "field__hint measure" }, "Sign out clears in-memory state in this console and ends the engine passkey session if one exists. Ending the SSO session happens at Access; the console cannot invalidate an edge session itself."));
  const actions = h("div", { style: "display:flex;gap:var(--space-2)" });
  const reauth = h("button", { "data-dp": "access-security.button.reauth", class: "btn btn--secondary btn--sm", type: "button" }, "Re-authenticate") as HTMLButtonElement;
  reauth.addEventListener("click", () => reauthenticate());
  const signout = h("button", { "data-dp": "access-security.button.signout", class: "btn btn--ghost btn--sm", type: "button" }, "Sign out") as HTMLButtonElement;
  // The REAL sign-out (the shell account-menu path via the nav bridge), not the 401
  // redirect: the in-memory state is genuinely cleared and a passkey session genuinely
  // ended, so the session does not survive the Back button.
  signout.addEventListener("click", () => signOut());
  actions.appendChild(reauth);
  actions.appendChild(signout);
  footer.appendChild(actions);
  card.appendChild(footer);

  return card;
}

function sessionRow(label: string, value: Child): HTMLElement {
  // Left-aligned label+value pair (.kv-pair, the borderless sibling of .kv-row, which WRAPS rather than
  // letting a nowrap badge overhang) so the session card reads as a stable two-column list.
  return h("div", { class: "kv-pair" }, h("span", { class: "section-label" }, label), h("span", { class: "small kv-pair__value" }, value));
}

// authMethodBadge names THIS session's sign-in method on the session card. It now has an arm for every
// verdict accessVerdictFromCaller can reach, because the states it used to sweep into its fall-through are real,
// live sign-in methods (the engine's own OIDC and SAML, and a recovery-code sign-in), and the fall-through said
// "Method not reported" about sessions the engine reported perfectly well. The break-glass badge is worn only by
// the break-glass method; an unrecognised method says so plainly rather than claiming either posture.
function authMethodBadge(): HTMLElement {
  const v = deriveVerdict();
  switch (v.state) {
    case "verified":
      return badge("trust", "Cloudflare Access");
    case "passkey-verified":
      return badge("trust", "Passkey");
    case "idp-verified":
      return badge("trust", v.protocol === "saml" ? "Single sign-on (SAML)" : "Single sign-on (OIDC)");
    case "recovery-verified":
      return badge("warn", "Recovery code");
    case "token-fallback":
      return badge("warn", "Shared token");
    case "session-present":
      return badge("warn", "Method not reported");
    default:
      return badge("neutral", "Method not recognised");
  }
}
