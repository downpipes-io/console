// Keys and break-glass: the trust anchor. The key ceremony runs in
// THIS browser (keygen.ts, reused verbatim), the no-custody legend makes legible what
// stays here vs goes to the engine vs goes nowhere, the wiring block shows the
// out-of-band wrangler commands (the console NEVER submits a secret) and polls GET
// /admin/status for presence, and the recovery sheet carries only PUBLIC fingerprints.
//
// No-custody invariants: the break-glass PRIVATE is generated here and is only ever
// offered as the downloaded identity.key; there is deliberately NO command and NO field
// that puts it on the engine. Each private value the engine legitimately holds (the
// signer, the operational private in that posture, CONFIG_RECIPIENT_PRIVATE and
// CONFIG_WRAP_KEY) is concealed behind a reveal toggle. In-memory key material is
// cleared on confirmed save / navigation away.
//
// Offline recovery guidance: the screen carries the EXACT downpipe CLI invocations an
// operator needs during an incident, as copyable command blocks, so an operator reading
// the console during an incident does not need to consult external documentation.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, actions, render) and
// composes the four tabs. The accessible tab chrome, the no-CLI token-apply affordance, the recovery-sheet and
// the small presenters live in the ./keys/shared.ts leaf; the Posture tab (presence + ceremony + wiring +
// posture switch) in ./keys/posture.ts; the Rotate break-glass tab in ./keys/rotation.ts; the Custody tab in
// ./keys/custody.ts; the Offline recovery tab in ./keys/offline-recovery.ts.

import { h } from "../lib/dom.ts";
import { pageHeader, requireEngine, type Screen, type ScreenContext } from "./common.ts";
import { renderCustodyTab } from "./keys/custody.ts";
import { renderOfflineRecovery } from "./keys/offline-recovery.ts";
import { getLastFailingRunlogDestination, renderPostureTab } from "./keys/posture.ts";
import { renderRotationSection } from "./keys/rotation.ts";
import { renderRunlogResignSection } from "./keys/runlog-resign.ts";
import {
  KEYS_ACTIONS, keysTabFor, 
  ROUTE_KEYS, ROUTE_KEYS_CUSTODY, ROUTE_KEYS_RECOVERY,ROUTE_KEYS_ROTATE, renderKeysTabs,
} from "./keys/shared.ts";

export const keysScreen: Screen = {
  // Four routes, one per section, so each is deep-linkable (see keys/shared.ts). /keys stays the
  // screen's home and serves Posture, so every existing link to /keys lands exactly where it did.
  route: [ROUTE_KEYS, ROUTE_KEYS_ROTATE, ROUTE_KEYS_CUSTODY, ROUTE_KEYS_RECOVERY],
  title: "Keys",
  measure: "prose",
  actions: KEYS_ACTIONS,
  render(ctx: ScreenContext) {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    root.appendChild(
      pageHeader(
        "Keys and break-glass",
        "Your keys, your engine's posture and the offline recovery you can run yourself. The break-glass private key is generated in this browser and never sent to us; you download it and keep it offline.",
      ),
    );

    // The screen is organised into four sections (a non-linear reference and admin surface, so one clear
    // home per task rather than a long scroll of disclosures): Posture (state + (re)key + the
    // break-glass-only switch), Rotate break-glass, Custody (the actionable M-of-N split), and
    // Offline recovery (the commands). Each is its own ROUTE, so the section on screen is the section in
    // the URL; only the active one is built, so a heavy section costs nothing until it is opened.
    root.appendChild(
      renderKeysTabs(
        [
          {
            id: "posture",
            label: "Posture",
            panel: () => {
              const panel = renderPostureTab(engine);
              panel.appendChild(renderRunlogResignSection(engine, getLastFailingRunlogDestination()));
              return panel;
            },
          },
          { id: "rotate", label: "Rotate break-glass", panel: () => renderRotationSection(engine) },
          { id: "custody", label: "Custody", panel: () => renderCustodyTab() },
          { id: "recovery", label: "Offline recovery", panel: () => renderOfflineRecovery() },
        ],
        keysTabFor(ctx.pattern),
      ),
    );

    return root;
  },
};
