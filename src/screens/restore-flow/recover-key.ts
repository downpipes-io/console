// Reassemble a split (Shamir M-of-N) key: THE STANDALONE RECONSTRUCT-AND-DOWNLOAD SCREEN.
//
// This screen collects an operator's quorum of Shamir share files (by paste or file-picker) plus the small
// encrypted key file (identity.key.enc), reconstructs identity.key locally, and offers the recovered file as a
// local download. Since the reconstruction card itself lives in ./reassembly.ts (shared with the
// in-console break-glass restore panel, which reassembles a split key to decap a run master); THIS screen is a
// thin wrapper that mounts the card in DOWNLOAD-ONLY mode (showDownload:true, no onRecovered), so it stays
// exactly what it always was: reconstruct-and-download, with no engine call anywhere.
//
// NO-CUSTODY: renderRecoverKey takes NO EngineClient and passes none to the card, so this screen CANNOT reach
// the network. The recovered identity.key is only ever offered as a local download; nothing is uploaded and
// the M-of-N threshold is never weakened (see reassembly.ts's own header for the primitive-level guarantees).
//
// Gate: this screen previously gated on canDo("operator") with no engine call to mirror. Now that reassembly FEEDS a real restore (the break-
// glass panel decaps a run master from the reconstructed key and calls POST /admin/restore/capsule +
// /admin/restore), the reassembly surface gates on the capability the restore path actually enforces at its
// entry: restore.verify (the read-safe viewer floor the capsule route, the blind-test and the attest routes
// all gate on, and the SAME capability proof.ts already mirrors on this screen family). Mirroring the real
// per-route capability in BOTH directions is what keeps the console gate honest rather than a role rank that
// no engine call backs.
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { canCap, capGateReason } from "../common.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { titleCase } from "../../lib/format.ts";
import { navigate } from "../../lib/nav.ts";
import { inlineOutcome } from "../../components/error-view.ts";
import { ICON_LOCK, ICON_KEYS } from "../../lib/icons.ts";
import { renderReassemblyCard } from "./reassembly.ts";

function keyHandlingNote(): HTMLElement {
  return h(
    "p",
    { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
    h("span", { style: "flex:none;margin-top:1px;color:var(--trust)" }, svgIcon(ICON_LOCK, { size: 14 })),
    h(
      "span",
      "Your shares and the encrypted key file are read here in your browser and combined locally. Nothing is uploaded and nothing is sent anywhere. Reconstructing here does not start a restore: it only produces a local identity.key you can download and keep, or use exactly as you would any offline key.",
    ),
  );
}

// renderRecoverKey is the /restore/recover-key screen body. It mounts the shared reassembly card in
// download-only mode and wires a best-effort wipe of the card's secret buffers on navigation away.
export function renderRecoverKey(): HTMLElement {
  const root = h("div", { class: "stack", style: "display:grid;gap:var(--space-4);max-width:44rem" });
  root.appendChild(h("h2", { style: "margin:0;font-size:var(--text-lg)" }, "Reassemble your split key"));
  root.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin:0" },
      "Load a quorum of your Shamir shares plus the small encrypted key file (identity.key.enc), and reconstruct identity.key locally in this browser.",
    ),
  );
  root.appendChild(keyHandlingNote());

  if (!canCap("restore.verify")) {
    root.appendChild(
      inlineOutcome({
        heading: `${titleCase(capabilityPhrase("restore.verify"))} required`,
        reason: capGateReason("restore.verify"),
        reassurance: `Reassembly runs entirely in your browser and reveals nothing about your key, but it sits with the break-glass recovery tools that feed a restore, so it gates on the same ${capabilityPhrase("restore.verify")} that the restore path enforces.`,
      }),
    );
    return root;
  }

  const card = renderReassemblyCard({ showDownload: true });
  root.appendChild(card.el);

  // Best-effort wipe on navigation away (root leaves the DOM): the card zeros its share bodies, the
  // envelope's ciphertext/iv and the recovered bytes and drops the references. Mirrors the canary screen's
  // MutationObserver-on-disconnect teardown pattern; it is best-effort (a hard tab close cannot run JS to
  // wipe) and additive to the GC that already reclaims a replaced screen. The everConnected guard means a DOM
  // mutation BEFORE this screen is mounted never fires a premature teardown that would then stop observing.
  let everConnected = false;
  const observer = new MutationObserver(() => {
    if (root.isConnected) { everConnected = true; return; }
    if (everConnected) {
      card.teardown();
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return root;
}

// recoverKeyDiscoveryNote is a small, calm-density secondary link (not its own card) pointing at this screen,
// for the /restore runless landing (workspace.ts, next to the attended-verification entry card). Deliberately
// minimal: this is a niche, break-glass-only path, so it earns a line, not a band. Navigates inline so it
// matches the same shape as the Keys -> Custody tab's own discovery link, the only other entry point.
export function recoverKeyDiscoveryNote(): HTMLElement {
  const link = h(
    "button",
    { "data-dp": "restore-flow.button.navigate-restore-recover-key", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/restore/recover-key") } },
    svgIcon(ICON_KEYS, { size: 13 }),
    "Reassemble a split (M-of-N) key",
  );
  return h(
    "p",
    { class: "field__hint measure", style: "margin:0;display:flex;align-items:center;gap:var(--space-2)" },
    "Holding a split key instead of one file?",
    link,
  );
}
