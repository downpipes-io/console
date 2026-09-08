// Destinations: where backups go, as a first-class screen. The question this screen
// answers (the calm contract): "Where do backups go, and is it proven reachable?"
//
// The destination is the one piece of the pipeline the operator must BRING (a bucket
// they own); everything else flows from bindings. The engine already carries the whole
// surface (GET /admin/destinations (list) + GET /admin/destination (env/deploy
// fallback) + POST /admin/destinations (add/edit) + POST /admin/destination/verify
// (re-probe), api.ts): a console-set destination is verified LIVE before it is stored
// (reachability + auth + a real write probe; a refusal is returned with the honest
// reason and nothing is stored), held in the scheduler DO at runtime (no CLI, no
// redeploy), audited (who and when, never the value), and always wins over the
// deploy-time configuration, which remains the fallback. This screen renders that
// surface in five states:
//
//   - LOADING: a skeleton while GET /admin/destinations resolves.
//   - MULTI-DESTINATION: a two-up card grid with an Add-another disclosure above it
//     (when listDestinations returns one or more results).
//   - UNCONFIGURED (no console record, no deploy-time env): one centred setup form,
//     R2-first (the endpoint is derived from the account id; region is fixed to auto)
//     with an S3-compatible variant, ending in the one primary action: Verify and save.
//   - CONFIGURED: one quiet posture card (bucket / endpoint / region / set-by /
//     verified, with a Verify now re-probe), the object-lock trade-off stated honestly
//     when the delete probe was refused, and the replace/remove levers. A deploy-time
//     configuration is named as such, with the console-set path behind a disclosure.
//   - ERROR: the block error with a real Retry that re-runs the load.
//
// Gates: reading the destination is any authenticated role; setting, replacing,
// removing and re-verifying are OWNER-exclusive server-side, so those controls render
// disabled-with-reason for everyone else (never hidden-then-403). The engine is always
// the enforcement point; canDo/gateReason are the client mirror only.
//
// No-custody invariants kept: the secret access key is sent ONCE over the
// authenticated same-origin channel, never persisted client-side, never re-displayed
// (the status endpoint is redaction-safe by construction); every server string enters
// the DOM via textContent / the typed h() builder (strict CSP, no innerHTML over
// server data, no inline handlers). Australian English, no em dashes, precise claims.
//
// This file is the screen orchestrator only: the setup form (destination-form.ts), its
// field-group builders (destination-form-fields.ts), the submit path
// (destination-submit.ts) and the card renderers (destination-cards.ts) live in sibling
// modules so neither the file nor any one function carries the whole surface.

import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonRows } from "../components/feedback.ts";
import { h, svgIcon } from "../lib/dom.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { ICON_PLUS } from "../lib/icons.ts";
import { goSignedOut } from "../lib/nav.ts";
import { openDisclosureByTitle, pageHeader, requireEngine, type Screen } from "./common.ts";
import { renderConfigured, renderList, renderSetup } from "./destination-cards.ts";

// Exporting this route constant means a rename here is caught by `tsc` wherever else it is referenced.
export const ROUTE_DESTINATIONS = "/destinations";

export const destinationsScreen: Screen = {
  route: ROUTE_DESTINATIONS,
  title: "Destinations",
  // Wide: the multi-destination list lays its cards two-up to use the space. The
  // first-run setup form self-caps via .card.measure and the single deploy-time posture card
  // is wrapped in .measure below, so neither is flung wide; values are left-aligned now, so
  // the old "flung to the walls" reason for prose no longer applies.
  measure: "wide",
  actions: [
    // The ungated go-to, one palette row per destination (the configure-flavoured
    // entry navigated to the identical route, so its keywords fold in here): every
    // rail item stays palette-reachable for every role (a Viewer reads the posture;
    // the writes gate on the screen + the engine).
    {
      id: "go-destinations",
      title: "Go to Destinations",
      group: "Navigation",
      kind: "navigate",
      keywords: ["destinations", "destination", "archive", "bucket", "where backups go", "configure", "r2", "s3"],
      target: "/destinations",
    },
  ],
  render() {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    // The header add-action (add-action consistency with Downpipes): the same primary
    // button shape, targeting the existing "Add a destination" disclosure, which stays
    // the one landing surface. On the first-run setup-form state (no disclosure yet:
    // the form IS the screen) it lands on the region's first field instead. The
    // deploy-bound state (a destination bound at deploy time, no console record yet)
    // renders that same surface as a "Replace from the console" disclosure instead, so both titles are
    // named here and openDisclosureByTitle opens whichever one this render actually produced.
    const addBtn = h(
      "button",
      { "data-dp": "destinations.button.add", class: "btn btn--primary btn--sm", type: "button", on: { click: () => openDisclosureByTitle(region, ["Add a destination", "Replace from the console"]) } },
      svgIcon(ICON_PLUS, { size: 14 }),
      "Add a destination",
    );
    root.appendChild(
      pageHeader(
        "Destinations",
        "Where your backups live. Verified buckets in your custody; add as many as you need and pick a default.",
        addBtn,
      ),
    );

    const region = h("div", { class: "async-region", style: "margin-top:var(--space-5)" });
    root.appendChild(region);

    // load is re-runnable: the first load, the block error's Retry, and every mutation
    // (save / replace / remove / verify) re-render through it, so the screen always
    // shows the engine's current truth rather than an optimistic guess.
    const load = (): void => {
      region.replaceChildren(skeletonRows(4));
      void engine
        .listDestinations()
        .then((list) => {
          if (list.destinations.length > 0) {
            // One or more console-set destinations: list them (each with make-default / remove) and
            // offer to add another. This is the multi-destination surface.
            region.replaceChildren(renderList(engine, list, load));
            return;
          }
          // None yet: show the deploy-time posture if the engine was configured at deploy, otherwise
          // the first-time setup form (which adds the first console destination, becoming the default).
          return engine.getDestination().then((st) => {
            region.replaceChildren(st.envConfigured ? h("div", { class: "measure" }, renderConfigured(engine, st, load)) : renderSetup(engine, load));
          });
        })
        .catch((err) => {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: the destination list is a skeleton until this replaces it.
            region.replaceChildren(sessionEnded(load));
            return goSignedOut();
          }
          region.replaceChildren(blockError(err, load, { origin: location.origin }));
        });
    };
    load();

    return root;
  },
};
