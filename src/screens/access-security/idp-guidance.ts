// The optional identity-provider setup guidance for the enforcement sub-view. This is the
// collapsible in-product section that walks an operator through wiring EntraID, Okta or
// GitHub so attributable per-person SSO works, without leaving the product. The framing is
// explicit: Access and an IdP are optional. downpipes works fully on the shared-token path
// with no Cloudflare Zero Trust seats and no IdP licences.
//
// No-custody: every wrangler command shown here uses non-secret values (CF_ACCESS_TEAM_DOMAIN
// and CF_ACCESS_AUD are identifiers, not secrets). The client secret and OAuth secret
// stay in Cloudflare; the console links out and says so.
//
// Accuracy: the steps mirror /engine/docs/ACCESS.md exactly. Do not invent steps.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { codeBlock } from "../../components/code-block.ts";
import { docLink } from "../../components/doc-link.ts";
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
const ACCESS_DOC = "https://docs.downpipes.io/identity-access/cloudflare-access-login-methods";
const IDENTITY_DOC = "https://docs.downpipes.io/operations/identity-and-access";

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
        "Cloudflare Access is optional. The engine never gates a backup, a recovery or any data-plane operation on whether Access is configured.",
      ),
    ),
  );
  optCard.appendChild(docLink({ href: IDENTITY_DOC, anchor: "cloudflare-access-is-optional-and-added-for-attributability", label: "Why you might add it anyway" }));
  optCard.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Access buys attributability: on the shared admin token alone, the engine knows a call was authorised, but not by whom.",
    ),
  );
  optCard.appendChild(docLink({ href: IDENTITY_DOC, anchor: "cloudflare-access-is-optional-and-added-for-attributability", label: "What the audit log records" }));
  optCard.appendChild(docLink({ href: ACCESS_DOC, anchor: "what-it-costs-and-the-zero-licence-path", label: "What each provider costs" }));
  optCard.appendChild(
    h(
      "p",
      { class: "field__hint" },
      h("b", "Zero-licence path: "),
      "GitHub plus the Zero Trust free tier gives per-person sign-in and team-based roles at no licence cost.",
    ),
  );
  return optCard;
}

// commonWiringNote is the one-line summary of the wiring that is the same across every provider, so
// the per-provider sections below do not restate it.
function commonWiringNote(): HTMLElement {
  // A wrapper, so the link is a sibling of the note rather than a child of its text, which is how
  // components/field.ts renders every other doc link in the console.
  return h(
    "div",
    { style: "display:grid;gap:var(--space-1)" },
    h(
      "p",
      { class: "field__hint measure" },
      "The wiring is the same for every provider, and you run it in the Cloudflare dashboard. The console links out and never captures a client secret or OAuth secret.",
    ),
    docLink({ href: IDENTITY_DOC, anchor: "wiring-access-in-the-dashboard-step-by-step", label: "The dashboard steps, in order" }),
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

  // The dashboard walkthrough these steps summarise, kept verbatim on one page rather than on three
  // screens. The anchors are the page's own provider headings; anchor-check.mjs proves they resolve.
  // Explicit, not derived from the card title: deriving it produced "Every GitHub (zero-licence
  // path) step, in full", and a label is read by a person, not assembled for one.
  // Each provider writes its own link with a plain literal anchor, so the doc-link gate reads every
  // anchor as written. The three links sit on three lines.
  if (provider === "github") body.appendChild(docLink({ href: ACCESS_DOC, anchor: "github", label: "Every GitHub step, in full" }));
  else if (provider === "entra") body.appendChild(docLink({ href: ACCESS_DOC, anchor: "microsoft-entra-id", label: "Every Entra ID step, in full" }));
  else body.appendChild(docLink({ href: ACCESS_DOC, anchor: "okta", label: "Every Okta step, in full" }));
  // The links render in the same place, with the same text.

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
      "Create an OAuth App under your organisation, with the callback URL below. The Client Secret goes into Cloudflare, never here.",
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
      "Create a self-hosted application over BOTH custom domains, then copy the AUD tag it generates.",
      [],
    ),
  ];
}

function entraIdpSteps(): HTMLElement[] {
  return [
    idpStep("1", "In the Azure portal: register an application",
      "Register an application with the redirect URI below, then create a client secret. The secret goes into Cloudflare, never here.",
      [
        labelledCopy("Redirect URI (template)", "https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback"),
      ],
    ),
    idpStep("2", "In the Azure portal: configure API permissions and group claims",
      "Add User.Read for the email claim. For group-based roles, add GroupMember.Read.All with admin consent, and check with Microsoft: group claims can need an Entra P1 or P2 plan.",
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
      "Create an OIDC Web Application with the redirect URI below. The Client Secret goes into Cloudflare, never here.",
      [
        labelledCopy("Redirect URI (template)", "https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback"),
      ],
    ),
    idpStep("2", "In Okta: configure the groups claim",
      "Optional, and only for group-based roles. Add a groups claim on the Sign On tab. The claim name must be groups, and Okta sends display names, so map on those.",
      [],
    ),
    idpStep("3", "In Cloudflare Zero Trust: add the Okta login method",
      "Add the Okta login method with your domain and credentials, and enable Support groups to forward the claim.",
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
      "Copy the AUD tag and your Zero Trust team name into the engine. They are identifiers, not secrets, so wrangler.toml vars is the right home.",
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
