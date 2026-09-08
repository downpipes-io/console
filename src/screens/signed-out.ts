// Signed-out (IA route /signed-out): a REDIRECT, not a copy surface. app.ts routes both
// 401s and sign-out straight to /passkey now, so nothing lands here except a stale
// bookmark or a hand-typed deep link; rather than maintain a second sign-in screen whose
// copy drifts (it claimed the 401-landing role, framed auth as edge-only Access and
// listed the shared admin token as a coequal way in), this forwards to the one live
// sign-in, preserving the intended URL. The route stays registered so old links work.
//
// Same-origin next-URL guard is the standard path-only check. The render-time
// navigate(..., { replace: true }) is the established pattern (common.ts requireEngine);
// the minimal body below renders only for the instant before the route change (and as an
// honest fallback if navigation is somehow suppressed).
//
// No palette actions: the screen has no authenticated engine context and no role.
// Zero-actions is the correct export here.

import { h } from "../lib/dom.ts";
import { navigate } from "../lib/nav.ts";
import type { RouteMatch } from "../lib/router.ts";
import type { Screen } from "./common.ts";

export const signedOutScreen: Screen = {
  route: "/signed-out",
  title: "Signed out",
  measure: "prose",
  actions: [],
  render(match: RouteMatch) {
    // The intended URL, preserved so sign-in returns the operator there. Only same-origin
    // in-app paths are honoured: must start with "/" and not start with "//".
    const rawNext = match.query.get("next");
    const next = rawNext?.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
    const to = `/passkey?next=${encodeURIComponent(next)}`;

    navigate(to, { replace: true });

    // The momentary fallback body: one line and a real link, no second sign-in narrative.
    const page = h("main", { class: "ob-page", id: "main", tabindex: "-1" });
    page.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin:var(--space-8) auto;text-align:center" },
        "Signed out. Taking you to ",
        h("button", { "data-dp": "signed-out.button.navigate", class: "linklike", type: "button", on: { click: () => navigate(to, { replace: true }) } }, "sign-in"),
        ".",
      ),
    );
    return page;
  },
};
