// The optional identity-provider setup guidance for the enforcement sub-view. This is the
// collapsible in-product section that walks an operator through wiring EntraID, Okta or
// GitHub so attributable per-person SSO works, without leaving the product. The framing is
// explicit: Access and an IdP are optional. downpipes works fully on the shared-token path
// with no Cloudflare Zero Trust seats and no IdP licences. Extracted verbatim from
// enforcement.ts (finding console-src-024-01).
//
// No-custody: every wrangler command shown here uses non-secret values (CF_ACCESS_TEAM_DOMAIN
// and CF_ACCESS_AUD are identifiers, not secrets). The client secret and OAuth secret
// stay in Cloudflare; the console links out and says so.
//
// Accuracy: the steps mirror /engine/docs/ACCESS.md exactly. Do not invent steps.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { codeBlock } from "../../components/code-block.ts";
import {
  ICON_EXTERNAL,
  ICON_INFO,
  ICON_SHIELD_CHECK,
  ICON_LOCK,
} from "../../lib/icons.ts";
import { ROUTE_ROLES, noteLine, accentBadge } from "./shared.ts";
import { labelledCopy } from "./enforcement-leaf.ts";

// idpSetupGuidance is the collapsible in-product identity-provider setup section.
// It is placed after the Access setup wizard so operators who want attributable per-person
// SSO can wire EntraID, Okta or GitHub without leaving the product. The framing is
// explicit: Access and an IdP are optional. downpipes works fully on the shared-token
// path with no Cloudflare Zero Trust seats and no IdP licences.
export function idpSetupGuidance(): HTMLElement {
  const details = h("details", { class: "card", style: "padding:0" });
  const summary = h(
    "summary",
    {
      style: "cursor:pointer;padding:var(--space-4) var(--space-5);display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);font-weight:var(--weight-medium)",
    },
  );
  const summaryLeft = h("div", { style: "display:flex;align-items:center;gap:var(--space-2)" });
  summaryLeft.appendChild(svgIcon(ICON_INFO, { size: 16 }));
  summaryLeft.appendChild(document.createTextNode("Set up an identity provider (optional)"));
  summary.appendChild(summaryLeft);
  summary.appendChild(accentBadge("Optional"));
  details.appendChild(summary);

  const inner = h("div", { style: "padding:0 var(--space-5) var(--space-5);display:grid;gap:var(--space-5)" });

  inner.appendChild(optionalityCard());
  inner.appendChild(commonWiringNote());

  // --- Provider sections ---
  inner.appendChild(idpSection("github", "GitHub (zero-licence path)"));
  inner.appendChild(idpSection("entra", "Microsoft Entra ID"));
  inner.appendChild(idpSection("okta", "Okta"));

  // --- Engine vars (shared across all providers) ---
  inner.appendChild(engineVarsSection());

  // --- Link to group-role mapping panel ---
  inner.appendChild(afterSetupNote());

  details.appendChild(inner);
  return details;
}

// optionalityCard states, up front, that an identity provider is not required and explains why an
// operator might add one anyway (attributability, plus the zero-licence GitHub path).
function optionalityCard(): HTMLElement {
  const optCard = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-3)" });
  optCard.appendChild(
    h(
      "p",
      h("b", "You do not need an identity provider to use downpipes."),
      " ",
      h(
        "span",
        { class: "field__hint" },
        "Cloudflare Access and identity providers are entirely optional. downpipes works fully on the shared-token path with no Cloudflare Zero Trust seats and no identity-provider licences. The engine will never gate a backup, a recovery or any data-plane operation on whether Access is configured.",
      ),
    ),
  );
  optCard.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "The reason to add Access is attributability. Without it, every admin call is authenticated by a shared bearer token: the engine knows the call was authorised, but not by whom. With Access, each caller is identified by a verified email, roles are per-person, and the audit log records who did what.",
    ),
  );
  optCard.appendChild(
    h(
      "p",
      { class: "field__hint" },
      h("b", "Zero-licence path: "),
      "GitHub login + Cloudflare Access free tier (historically up to 50 users; verify the current limit at cloudflare.com/plans/zero-trust/) gives per-person SSO and team-based roles at no additional licence cost from either Cloudflare or GitHub. If your organisation already pays for Okta or has Entra ID included with Microsoft 365, those work too. Verify each vendor's current terms before committing; pricing changes.",
    ),
  );
  return optCard;
}

// commonWiringNote is the one-line summary of the wiring that is the same across every provider, so
// the per-provider sections below do not restate it.
function commonWiringNote(): HTMLElement {
  return h(
    "p",
    { class: "field__hint measure" },
    "Regardless of which provider you use, the overall wiring is the same: create a login method in Cloudflare Zero Trust, create an Access application protecting both custom domains, then set two non-secret engine vars. The steps are yours to run in the Cloudflare dashboard and your provider; the console links out and never captures a client secret or OAuth secret.",
  );
}

// idpSection returns a collapsible <details> card for one provider. Each expands
// independently so an operator who only cares about GitHub is not forced through Okta steps.
function idpSection(provider: "github" | "entra" | "okta", title: string): HTMLElement {
  const details = h("details", { class: "card card--inset", style: "padding:0" });
  const summary = h(
    "summary",
    {
      style: "cursor:pointer;padding:var(--space-3) var(--space-4);display:flex;align-items:center;gap:var(--space-2);font-weight:var(--weight-medium)",
    },
  );
  summary.appendChild(svgIcon(ICON_SHIELD_CHECK, { size: 16 }));
  summary.appendChild(document.createTextNode(title));
  if (provider === "github") summary.appendChild(accentBadge("no extra licence"));
  details.appendChild(summary);

  const body = h("div", { style: "padding:0 var(--space-4) var(--space-4);display:grid;gap:var(--space-4)" });

  const steps = provider === "github" ? githubIdpSteps() : provider === "entra" ? entraIdpSteps() : oktaIdpSteps();
  for (const step of steps) body.appendChild(step);

  details.appendChild(body);
  return details;
}

// githubIdpSteps / entraIdpSteps / oktaIdpSteps each return the ordered instructional steps for one
// provider, so idpSection stays a thin per-provider switch and a fourth provider (e.g. Google
// Workspace) is added as its own function rather than another inline branch. The steps mirror
// /engine/docs/ACCESS.md exactly; the Client/OAuth secret always goes into Cloudflare, never here.
function githubIdpSteps(): HTMLElement[] {
  return [
    idpStep("1", "On GitHub: create an OAuth App",
      "In your GitHub organisation, go to Settings > Developer settings > OAuth Apps > New OAuth App. Set the authorisation callback URL to the value shown below. Note the Client ID and generate a Client Secret. The Client Secret goes into Cloudflare, never here.",
      [
        labelledCopy("Authorisation callback URL (template)", "https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback"),
      ],
    ),
    idpStep("2", "In Cloudflare Zero Trust: add the GitHub login method",
      "Go to Settings > Authentication > Login methods > Add new > GitHub. Enter the Client ID and the Client Secret. To send team membership as group claims (which the engine uses for group-based roles), enable the read:org scope in the login-method settings. Save.",
      [
        noteLine(ICON_INFO, "When group claims are enabled, the engine receives groups in the form <org>/<team-slug> (for example myorg/ops). Use that exact form as the group name in the group-role mapping panel on this screen."),
      ],
    ),
    idpStep("3", "In Cloudflare Zero Trust: create the Access application",
      "Go to Access > Applications > Add an application > Self-hosted. Add both your engine custom domain and your console custom domain as application domains. Configure the policy to allow the GitHub login method you just added. After saving, Cloudflare generates an AUD tag; copy it for the engine vars below.",
      [],
    ),
  ];
}

function entraIdpSteps(): HTMLElement[] {
  return [
    idpStep("1", "In the Azure portal: register an application",
      "Go to Microsoft Entra ID > App registrations > New registration. Set the redirect URI type to Web and the URI to the value below. Note the Application (client) ID. Under Certificates and secrets, create a new client secret (goes into Cloudflare, never here).",
      [
        labelledCopy("Redirect URI (template)", "https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback"),
      ],
    ),
    idpStep("2", "In the Azure portal: configure API permissions and group claims",
      "Under API permissions, add User.Read (required for the email claim). If you want group claims for group-based roles, add GroupMember.Read.All and grant admin consent. Under Token configuration, add a groups claim. Note: emitting group claims to an external relying party can require an Entra ID P1 or P2 plan; verify this with Microsoft before relying on group-based roles from a free Entra tier.",
      [
        noteLine(ICON_INFO, "Cloudflare Access receives group object IDs (GUIDs) by default, not display names, unless you configure optional claims to emit group_names. Use the exact string the engine receives as the group name in the group-role mapping panel. You can confirm what the engine receives via GET /admin/whoami after signing in."),
      ],
    ),
    idpStep("3", "In Cloudflare Zero Trust: add the Entra ID login method",
      "Go to Settings > Authentication > Login methods > Add new > Azure AD (Entra ID). Enter your Entra tenant ID, the Application (client) ID, and the client secret. Enable Support groups if you want group claims forwarded. Save.",
      [],
    ),
    idpStep("4", "In Cloudflare Zero Trust: create the Access application",
      "Go to Access > Applications > Add an application > Self-hosted. Add both custom domains. Configure the policy. After saving, note the AUD tag for the engine vars below.",
      [],
    ),
  ];
}

function oktaIdpSteps(): HTMLElement[] {
  return [
    idpStep("1", "In the Okta Admin Console: create an app integration",
      "Go to Applications > Applications > Create App Integration. Choose OIDC as the sign-in method and Web Application as the application type. Set the redirect URI to the value below. Note the Client ID and generate a Client Secret (goes into Cloudflare, never here).",
      [
        labelledCopy("Redirect URI (template)", "https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback"),
      ],
    ),
    idpStep("2", "In Okta: configure the groups claim",
      "On the application's Sign On tab, under Edit > OpenID Connect ID Token, add a groups claim with a filter that covers the groups you want forwarded (for example a regex .* to forward all groups, or a specific prefix). The claim name must be groups. Okta sends group display names, so use the display name as the group name in the engine's group-role mapping panel. This step is optional; skip it if you do not need group-based roles.",
      [],
    ),
    idpStep("3", "In Cloudflare Zero Trust: add the Okta login method",
      "Go to Settings > Authentication > Login methods > Add new > Okta. Enter your Okta domain, the Client ID, and the Client Secret. Enable Support groups to have Cloudflare Access forward the groups claim. Save. Okta is a paid product; use it if your organisation already pays for it.",
      [],
    ),
    idpStep("4", "In Cloudflare Zero Trust: create the Access application",
      "Go to Access > Applications > Self-hosted. Add both custom domains. Configure the policy. After saving, note the AUD tag for the engine vars below.",
      [],
    ),
  ];
}

// idpStep renders one instructional step inside a provider section, using the same
// card--inset + step-label geometry as the wizard above.
function idpStep(num: string, title: string, desc: string, body: Node[]): HTMLElement {
  const sec = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-3)" });
  const head = h("div", { style: "display:flex;gap:var(--space-3);align-items:baseline" });
  head.appendChild(h("span", { class: "section-label" }, `Step ${num}`));
  head.appendChild(h("b", { style: "font-size:var(--text-base)" }, title));
  sec.appendChild(head);
  if (desc) sec.appendChild(h("p", { class: "field__hint measure" }, desc));
  const stack = h("div", { style: "display:grid;gap:var(--space-2)" });
  for (const node of body) stack.appendChild(node);
  if (body.length > 0) sec.appendChild(stack);
  return sec;
}

// engineVarsSection shows the two non-secret engine vars (team domain + AUD) that the
// operator sets after creating the Access application. These are identifiers, not secrets;
// showing them here stays within the no-custody boundary. The wrangler commands are
// copyable. CF_ACCESS_TEAM_DOMAIN accepts either the full host or just the team name.
function engineVarsSection(): HTMLElement {
  // The not-a-secret fact is stated ONCE, in the intro paragraph; the heading, the code-block
  // comments and the closing note do not restate it.
  const card = h("section", { class: "card card--inset", "aria-labelledby": "idp-engine-vars-h", style: "display:grid;gap:var(--space-3)" });
  const head = h("div", { style: "display:flex;gap:var(--space-3);align-items:baseline" });
  head.appendChild(h("span", { class: "section-label" }, "Final step"));
  head.appendChild(h("b", { id: "idp-engine-vars-h", style: "font-size:var(--text-base)" }, "Set the engine vars to match"));
  card.appendChild(head);
  card.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "After creating the Access application, copy the AUD tag and your Zero Trust team name into the engine. These are identifiers, not secrets; they go in wrangler.toml vars or as wrangler secrets. The engine normalises CF_ACCESS_TEAM_DOMAIN whether you supply the full host or just the team name.",
    ),
  );
  card.appendChild(
    codeBlock(
      "# In the engine wrangler.toml [vars]:\n[vars]\nCF_ACCESS_TEAM_DOMAIN = \"<your-team>.cloudflareaccess.com\"\nCF_ACCESS_AUD         = \"<the AUD tag from the Access application>\"\n# Then redeploy. (wrangler secret put also works.)",
      { copyLabel: "Copy engine vars" },
    ),
  );
  card.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "After setting both vars, redeploy the engine with the guided deploy (from engine/: npm run deploy; it preserves your console-attached sources, unlike a bare wrangler deploy), then use the Verify enforcement now button in the Access setup wizard above to confirm Access is verifying.",
    ),
  );
  card.appendChild(
    noteLine(
      ICON_LOCK,
      "The two vars identify which Access application the engine trusts. The engine verifies the RS256-signed JWT Cloudflare injects on every request, fetching Cloudflare's public keys from the team domain. It does not trust the header without verification.",
    ),
  );
  return card;
}

// afterSetupNote links to the group-role mapping panel (already on the Roles and access
// tab) so the operator knows where to go once Access is wired and the IdP sends groups.
function afterSetupNote(): HTMLElement {
  const card = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-2)" });
  card.appendChild(h("b", "Once Access is wired: group-to-role mapping"));
  card.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "If your identity provider sends group claims (enabled in the login-method settings above), you can map group names to roles. This is optional; the mapping panel is on the Roles and access tab of this screen.",
    ),
  );
  const linkBtn = h(
    "button",
    { "data-dp": "access-security.button.navigate#2", class: "btn btn--secondary btn--sm", type: "button" },
    "Go to group-to-role mapping",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  ) as HTMLButtonElement;
  linkBtn.addEventListener("click", () => navigate(ROUTE_ROLES));
  card.appendChild(h("div", linkBtn));
  return card;
}
