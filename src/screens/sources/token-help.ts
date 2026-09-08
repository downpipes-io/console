// The two token-help modals for the Sources screen. tokenHelp explains the READ-ONLY
// discovery token (browse everything you own); attachTokenHelp explains the ONE-SHOT
// deploy token the in-product attach/detach uses. Moved here verbatim so the token
// forms, the add-source wizard, the tiers and the external callers (the Keys screen,
// the by-id add-source screen, the onboarding configure step) can reach attachTokenHelp
// through one leaf without importing a sibling section. The coordinator re-exports
// attachTokenHelp so its public import path is unchanged. Australian English, no em
// dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { openModal } from "../../components/modal.ts";

// tokenHelp is the step-by-step modal: where to create the token, which read-only
// template covers everything (data sources AND Cloudflare configuration), the
// minimal data-only alternative, and the account scope, so nobody leaves the
// console to guess. Backing up Cloudflare configuration needs read across dozens of
// products, so the ready-made "Read all resources" read-only template is the
// recommended path; the narrow custom token is offered for data-only deployments.
export function tokenHelp(): void {
  // The minimal, data-sources-only scopes: enough to enumerate and back up KV/R2/D1/Secrets, but
  // NOT Cloudflare configuration (DNS, WAF, zone & account settings span dozens of read scopes).
  const minimalScopes = h(
    "ul",
    { class: "stack-sm", style: "list-style:none;padding-left:var(--space-4);margin-top:var(--space-2)" },
    h("li", h("span", { class: "mono" }, "Account Settings : Read"), h("span", { class: "field__hint" }, " (lets the engine list which accounts the token can see)")),
    h("li", h("span", { class: "mono" }, "Workers KV Storage : Read")),
    h("li", h("span", { class: "mono" }, "Workers R2 Storage : Read")),
    h("li", h("span", { class: "mono" }, "D1 : Read")),
    h("li", h("span", { class: "mono" }, "Secrets Store : Read")),
  );
  const body = h(
    "div",
    { class: "stack-sm" },
    h("p", "Four steps, all in the Cloudflare dashboard:"),
    h(
      "ol",
      { class: "setup-steps" },
      h("li", { class: "setup-steps__item" }, "Open ", h("b", "My Profile → API Tokens"), " (dash.cloudflare.com/profile/api-tokens) and press ", h("b", "Create Token"), "."),
      h("li", { class: "setup-steps__item" }, "Pick the ", h("b", "Read all resources"), " template. It is read-only across your account and covers both your data sources (KV, R2, D1, Secrets Store) and your Cloudflare configuration (DNS, WAF, zone and account settings), so configuration backup works with no second token."),
      h("li", { class: "setup-steps__item" }, "Under ", h("b", "Account Resources"), ", include every account you want browsable (or All accounts for an organisation token), then ", h("b", "Create"), " it."),
      h("li", { class: "setup-steps__item" }, "Copy the token value, paste it here and press Verify and save."),
    ),
    h(
      "details",
      { class: "disclosure" },
      h("summary", "Prefer a minimal, data-only token?"),
      h(
        "div",
        { class: "disclosure__body stack-sm" },
        h("p", { class: "field__hint", style: "margin:0" }, "If you only back up data (KV, R2, D1, Secrets Store) and not Cloudflare configuration, choose ", h("b", "Create Custom Token"), " instead and add just these five permissions, every one ", h("b", "Account"), "-type and ", h("b", "Read"), ". Configuration surfaces and per-zone backup stay unavailable until you widen the token."),
        minimalScopes,
      ),
    ),
    h(
      "p",
      { class: "field__hint" },
      "Read-only is the point: the token can never write or change anything in your account. The engine uses it only to list your resources and read their configuration; your KV, R2, D1 and Secrets Store values are read through the in-account bindings, never this token. It is verified before it is stored, kept in your account by your engine, recorded in the audit trail (who set it, when; never the value), and removable here in one click. Give it an expiry if your policy likes rotation; replacing it is one paste.",
    ),
  );
  openModal({ title: "Create the read-only discovery token", body });
}

// attachTokenHelp is the step-by-step modal for the ONE-SHOT deploy token the in-product
// attach/detach uses. The token must EDIT the Worker's bindings, and the dashboard "Edit
// Cloudflare Workers" template is the ready-made starting point, but it only bundles Workers
// Scripts, KV and R2: it predates D1 and Secrets Store, so attaching a NEW source of either
// kind needs that permission added to the token by hand (Cloudflare will not let the engine
// bind a resource the token cannot itself see; live-confirmed, see deploy-safety-bindings.mdx).
// The engine never drops its own bindings: it reads them, proves the change is safe, writes,
// and verifies.
export function attachTokenHelp(engineAccountId: string | null): void {
  const body = h(
    "div",
    { class: "stack-sm" },
    h(
      "p",
      { class: "field__hint" },
      "The engine edits its own bindings through Cloudflare, so the token needs to see every resource type the engine binds. The template below covers the common case. It is one-shot: revoke it the moment the change lands. Prefer no token? The deploy path needs none.",
    ),
    h("p", "Four steps in the Cloudflare dashboard:"),
    h(
      "ol",
      { class: "setup-steps" },
      h("li", { class: "setup-steps__item" }, "Open ", h("b", "My Profile -> API Tokens"), " and press ", h("b", "Create Token"), "."),
      h(
        "li",
        { class: "setup-steps__item" },
        "Use the ",
        h("b", "Edit Cloudflare Workers"),
        " template (it grants Workers Scripts, Workers KV Storage and Workers R2 Storage edit). Under ",
        h("b", "Account Resources"),
        " scope it to the engine's OWN account",
        engineAccountId ? h("span", null, " (id ", h("span", { class: "mono" }, engineAccountId), ")") : null,
        ".",
      ),
      h("li", { class: "setup-steps__item" }, "Attaching a D1 or Secrets Store source? Add ", h("b", "D1: Edit"), " or ", h("b", "Secrets Store: Edit"), " to the same token: the template predates both, and the attach is refused without the matching one."),
      h("li", { class: "setup-steps__item" }, "Optionally set the expiry to the soonest the dashboard offers (tomorrow is the minimum); the real control is revoking it after."),
      h("li", { class: "setup-steps__item" }, "Create, copy, paste here. Then revoke it on the same API Tokens page."),
    ),
    h(
      "p",
      { class: "field__hint" },
      "What the engine does with it: reads its current bindings, proves the change cannot drop a single one of its own (its Durable Objects, the archive, its secrets), applies it, then re-reads to verify everything survived. Any doubt and it refuses without writing, pointing you at the deploy. The token is never stored or logged; the change is audited by binding name.",
    ),
  );
  openModal({ title: "Create the one-shot deploy token", body });
}
