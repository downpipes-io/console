// The READ-ONLY "Test connection" result renderer for the add-connection flow of the external-identity-
// providers screen. Split from ./forms.ts for size; behaviour, copy and markup are unchanged.
//
// House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import type { IdpTestResult } from "../../api.ts";

// renderIdpTestResult renders the engine's READ-ONLY "test connection" probe result ({ ok, checks }) next to
// the form: an overall line plus each check (name + pass/warn/failed + detail). It mutates nothing and is
// shown only after the operator clicks "Test connection", so a misconfigured trust root is caught before it
// is saved rather than at first sign-in.
export function renderIdpTestResult(host: HTMLElement, res: IdpTestResult): void {
  const wrap = h("div", { class: "card", style: "display:grid;gap:var(--space-2);margin-top:var(--space-3)" });
  wrap.appendChild(
    h(
      "p",
      { class: res.ok ? "field__hint" : "field__error", role: "status" },
      res.ok
        ? "Connection test passed: the provider's metadata is reachable and the configuration is valid. You can add it now."
        : "Connection test found problems. Fix the failed checks below, then test again before adding.",
    ),
  );
  const ul = h("ul", { class: "idp-list" });
  for (const c of res.checks) {
    const mark = c.status === "pass" ? "OK" : c.status === "warn" ? "Warning" : "Failed";
    ul.appendChild(h("li", h("strong", `${c.name}: ${mark}.`), c.detail ? ` ${c.detail}` : ""));
  }
  wrap.appendChild(ul);
  host.replaceChildren(wrap);
}
