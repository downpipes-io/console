// Credential lifecycle registry (build contract section 4 + section 9 console surfaces):
// the account's own list of credentials, keys, licences, certificates and TOKENS, each with
// a lifecycle class (ephemeral / functional), an optional expiry date, the days-remaining and
// an ok / approaching / expired / no-expiry state, what it powers (a usage link), and the
// add / edit / delete flow. The registry is the account's own list; the vendor reads nothing,
// and an item carries a redaction-safe label, a kind, a class and (optionally) a date only,
// never the secret itself. Some items are AUTO-OBSERVED by the engine (a destination access
// key, a SAML signing certificate); the rest the operator tracks by hand.
//
// House rules carried through:
//   - No-custody / redaction-by-construction: an item is a label + kind + class + an optional
//     expiry date + an optional note/purpose. There is NO field for the secret/key/value, and
//     the copy says so.
//   - Capability gating: add / edit / delete AND the cleanup attestation are gated with
//     can(caller.role, "expiry.config") (Operator, Approver, Owner): the CLIENT MIRROR of the
//     engine's server-side gate. The engine is ALWAYS the enforcement point; a gated control is
//     shown disabled-with-reason, never hidden-then-403. The read (GET /admin/expiry) is any
//     authenticated role.
//   - Status by hue + shape + label, never colour alone: an expired item never reads green, AND a
//     no-expiry item reads NEUTRAL (a distinct honest state, never green).
//   - Honest copy throughout: never a fabricated expiry date; never "verified deleted" (the cleanup
//     attestation is the operator's word, not a Cloudflare-side check).
//   - Calm density: ONE at-a-glance band, the "Needs attention" tier and the
//     four-tile summary band are mutually exclusive.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, actions, render)
// and the load lifecycle, and re-exports the symbols external callers (the credentials validator) depend
// on. The pure tone/ordering/summary helpers, the constants and the small DOM/predicate helpers live in
// the ./credentials/helpers.ts leaf; the list, posture/summary bands and detail drawer in
// ./credentials/list.ts; the add/edit, cleanup-attest and remove flows in ./credentials/forms.ts. The file
// was split for size while keeping the public surface byte-identical.
//
// CSP / CSSOM: styles via h() + node.style.setProperty (the dom.ts builder), never setAttribute("style").

import { h } from "../lib/dom.ts";
import {
  pageHeader,
  requireEngine,
  defineScreen,
  type Screen,
  type ScreenContext,
} from "./common.ts";
import { goSignedOut, navigate } from "../lib/nav.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonRows } from "../components/feedback.ts";
import { callerCan } from "../lib/identity-custom-roles.ts";
import type { EngineClient } from "../api.ts";
import { ROUTE_CREDENTIALS, callerCanCap } from "./credentials/helpers.ts";
import { renderList, openItemDrawer } from "./credentials/list.ts";
import { openItemForm } from "./credentials/forms.ts";

// Re-exports: the credentials validator (test/validate-credentials.ts) imports the pure tone/ordering/
// summary/phrase helpers BY NAME from this module, so the split keeps every one of those imports working
// unchanged. They live in the ./credentials/helpers.ts leaf (all pure + DOM-free, so importing them in Node
// never touches a DOM); re-exporting them here keeps the public import surface of screens/credentials.ts
// byte-identical.
export {
  expiryStateTone,
  expiryStateLabel,
  stateOrder,
  remainingSortValue,
  compareExpiry,
  expirySummary,
  daysPhrase,
  soonestTileValue,
  lifecycleLabel,
} from "./credentials/helpers.ts";

// ---------------------------------------------------------------------------
// The screen descriptor. measure:"wide" because the list reads
// as a dense, urgency-ranked table. The go-to navigation lives in shell/registry.ts +
// shell/nav.ts; this descriptor contributes the screen-owned add action (gated by
// expiry.config so the palette never offers it to a role that cannot save).
//
// The route is a PAIR: the list "/credentials" and the deep-linkable detail
// "/credentials/:id". Activating a row navigates to /credentials/:id (carrying the
// filter query), which re-opens the drawer on a refresh; closing it navigates back to
// /credentials with the query intact. This is the same route-param drawer idiom the
// downpipes screen uses (sources-downpipes.ts). nav.ts still links the bare list route.
// ---------------------------------------------------------------------------

export const credentialsScreen: Screen = defineScreen({
  route: [ROUTE_CREDENTIALS, `${ROUTE_CREDENTIALS}/:id`],
  title: "Credentials and expiry",
  measure: "wide",
  actions: [
    // Add a tracked item: a write-class action gated by expiry.config so it is offered
    // only to roles that can save (Operator, Approver, Owner). The engine re-enforces
    // the capability server-side. The target carries ?add=1 so invoking the verb-titled
    // command opens the add form on arrival rather than just landing on the list.
    {
      id: "credentials.add",
      title: "Track a credential or key expiry",
      group: "Actions",
      kind: "navigate",
      keywords: ["credential", "key", "licence", "certificate", "token", "expiry", "expire", "add", "track", "renew", "rotate", "lifecycle"],
      target: `${ROUTE_CREDENTIALS}?add=1`,
      when: ({ caller: c }) => c !== null && callerCan(c.role, "expiry.config", c.customRole ?? null),
    },
  ],
  render(ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;
    // A non-null alias the hoisted load() reads (a function declaration is not narrowed
    // by the guard above).
    const eng: EngineClient = engine;

    // The detail id from the deep-link route ("/credentials/:id"). When set, the row's
    // drawer re-opens once the list is in hand, so a REFRESH on a detail URL restores it.
    const detailId = ctx.pattern === `${ROUTE_CREDENTIALS}/:id` ? ctx.params.id : undefined;

    root.appendChild(
      pageHeader(
        "Credentials and expiry",
        "Track the dated items your recovery depends on: destination access keys, licences, certificates and one-shot setup tokens. A silent expiry never breaks a backup unseen, and a spent token never lingers. The list is your own; the vendor reads nothing, and an item records a label, a kind and a date only, never the secret itself.",
      ),
    );

    const region = h("div", { class: "async-region", style: "margin-top:var(--space-5)" });
    root.appendChild(region);

    const load = (): void => {
      region.replaceChildren(skeletonRows(5));
      void eng
        .listExpiry()
        .then((rows) => {
          region.replaceChildren(renderList(eng, rows, load));
          // Re-open the deep-linked drawer once the list is in hand (so the row exists);
          // an unknown id falls back to the bare list (the URL is corrected).
          if (detailId !== undefined) {
            const target = rows.find((r) => r.id === detailId);
            if (target) openItemDrawer(eng, target, load);
            else navigate(ROUTE_CREDENTIALS, { replace: true });
          }
        })
        .catch((err) => {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: the expiry list is a skeleton until this replaces it.
            region.replaceChildren(sessionEnded(load));
            return goSignedOut();
          }
          region.replaceChildren(blockError(err, load, { origin: location.origin }));
        });
    };
    load();

    // ?add=1 (the palette's verb command, writeGate permitting): open the add form once
    // the screen has mounted, so the command does what its title says.
    if (ctx.query.get("add") === "1" && callerCanCap("expiry.config")) {
      queueMicrotask(() => openItemForm(eng, null, load));
    }

    return root;
  },
});
