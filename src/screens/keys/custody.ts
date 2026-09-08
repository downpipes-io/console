// The Custody tab of the Keys and break-glass screen: the ACTIONABLE M-of-N split made runnable from
// the Keys screen (not only during a ceremony), plus the long-form multi-custodian teaching reference beneath
// it. The split is browser-only (custody-step.ts transmits nothing): the key source is an in-memory ceremony
// result if one exists, otherwise the operator selects their identity.key file locally (parsed in the browser,
// never uploaded). Moved verbatim from the keys coordinator for size; it imports the shared leaf (./shared.ts)
// only, so it never imports another tab module (which would form a cycle).
//
// NO-CUSTODY: the console splits only a random 256-bit WRAPPING key, never the break-glass private directly;
// it envelope-encrypts the key file in your browser, Shamir-splits the wrapping key M-of-N, and offers the
// ciphertext and each share as downloads. House style: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { getCeremony, getEngine } from "../../lib/store.ts";
import { renderCustodyStep } from "../../components/custody-step.ts";
import { isCeremonyResult } from "../../keygen.ts";
import type { CeremonyResult } from "../../keygen.ts";
import type { CustodyKeyInput } from "../../lib/custody-files.ts";
import { downloadText } from "./shared.ts";
import { b64urlEncode, concat } from "../../bytes.ts";
import { collapsedSection } from "../common.ts";
import { parseIdentityFile as parseIdentityStrict } from "../../lib/keydecap.ts";
import { renderReassemblyCard, wipeOnDisconnect } from "../restore-flow/reassembly.ts";
import { navigate } from "../../lib/nav.ts";

// renderCustodyTab makes the multi-custodian split runnable from the Keys screen (not only during a
// ceremony). The split is browser-only (custody-step.ts transmits nothing). Key source: an in-memory
// ceremony result if one exists, otherwise the operator selects their identity.key file locally (it is
// parsed in the browser and never uploaded). The long-form guidance sits beneath as the reference.
export function renderCustodyTab(): HTMLElement {
  const wrap = h("div");

  const action = h("div", { class: "card measure", style: "margin-bottom:var(--space-4)" });
  action.appendChild(h("h2", { class: "card__title" }, "Split custody now"));
  action.appendChild(
    h("p", { class: "field__hint" }, "Encrypt your identity.key in this browser and split the wrapping key M-of-N across your custodians. Everything is produced here and offered as downloads; nothing is sent anywhere."),
  );
  const stepHost = h("div", { style: "margin-top:var(--space-3)" });
  action.appendChild(stepHost);

  const mountStep = (result: CustodyKeyInput): void => {
    stepHost.replaceChildren(
      renderCustodyStep({
        result,
        onChange: () => {
          /* sheet sign-off is recorded during a ceremony; here the split downloads stand alone */
        },
        // The "key-ceremony" surface tag is what puts a refused or unavailable download into the client-diag
        // ring (and so into the support pack). sendShare is the custody-share email, the one sanctioned
        // network exception. Both are load-bearing: the tag is the evidence channel, the sender is the feature.
        downloadText: (name, content) => downloadText(name, content, "text/plain", "key-ceremony"),
        sendShare: (input) => getEngine()?.sendCustodyShare(input) ?? Promise.resolve({ sent: false, reason: "no-engine" }),
      }),
    );
  };

  const inMemoryRaw = getCeremony();
  const inMemory: CeremonyResult | null = isCeremonyResult(inMemoryRaw) ? inMemoryRaw : null;
  if (inMemory) {
    // A ceremony just ran in this tab: split directly against it.
    mountStep(inMemory);
  } else {
    // No in-tab key material: let the operator load their identity.key locally (parsed in the browser).
    action.appendChild(renderFileInputBlock(mountStep, stepHost));
    action.appendChild(renderQuorumBlock(mountStep, stepHost));
  }

  wrap.appendChild(action);
  wrap.appendChild(renderRecoverKeyLink());
  wrap.appendChild(renderMultiCustodianCard());
  return wrap;
}

// renderRecoverKeyLink is a quiet secondary link to the in-browser split-key reassembly screen
// (/restore/recover-key), the reverse of the split above: gather a quorum of shares plus the encrypted key
// file and reconstruct identity.key locally. A single line, not its own card (calm-density budget), so it
// reads as a natural next step after "Split custody now" without competing with it for attention.
function renderRecoverKeyLink(): HTMLElement {
  const link = h(
    "button",
    { "data-dp": "keys.button.navigate-restore-recover-key", class: "btn btn--ghost btn--sm", type: "button", on: { click: () => navigate("/restore/recover-key") } },
    "Recover a split key in this browser",
  );
  return h(
    "p",
    { class: "field__hint measure", style: "margin:0 0 var(--space-2);display:flex;align-items:center;gap:var(--space-2)" },
    "Already hold a quorum of shares?",
    link,
  );
}

// renderFileInputBlock builds the local identity.key picker used when no ceremony is in memory. The
// FileReader keeps the file in the browser; we parse the v1 file to its identityB64 and build the
// minimal shape the custody step reads (it only ever touches result.breakGlass.identityB64). stepHost
// is cleared when the selected file is not a recognised identity.key.
function renderFileInputBlock(mountStep: (result: CustodyKeyInput) => void, stepHost: HTMLElement): HTMLElement {
  const block = h("div");
  const fileInput = h("input", { "data-dp": "keys.file.read-as-text", type: "file", accept: ".key,text/plain", "aria-label": "Select your identity.key file" }) as HTMLInputElement;
  const fileErr = h("p", { class: "field__error", role: "alert", hidden: true });
  block.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Select your identity.key to split it. It stays in this browser and is never uploaded."),
  );
  block.appendChild(fileInput);
  block.appendChild(fileErr);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileErr.hidden = true;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const identityB64 = parseIdentityFile(text);
      if (identityB64 === null) {
        fileErr.textContent = "That does not look like an identity.key file (expected a downpipe-identity-v1 line).";
        fileErr.hidden = false;
        stepHost.replaceChildren();
        return;
      }
      // The label check above is a SHAPE guard and nothing more: it never decodes the token and never
      // checks its length, so this screen used to accept material the restore path would reject, and
      // would split it. The failure surfaced only at recovery, after the shares had been distributed to
      // custodians and the original file very possibly destroyed, which is the worst possible moment.
      // Validate with the SAME audited parser the restore path uses (it decodes base64url and enforces
      // the 96 bytes), so a bad file is refused here instead. The parsed copy is only needed for the
      // check, so it is zeroed straight away rather than carried.
      try {
        const probe = parseIdentityStrict(text);
        probe.x25519Scalar.fill(0);
        probe.mlkemSeed.fill(0);
      } catch {
        fileErr.textContent = "That file carries a downpipe-identity-v1 label but is not a valid identity.key, so it cannot be split. Check you selected the right file.";
        fileErr.hidden = false;
        stepHost.replaceChildren();
        return;
      }
      // The custody step reads only breakGlass.identityB64 (CustodyKeyInput), so the parsed
      // identity bytes are a complete, sound input with no cast.
      mountStep({ breakGlass: { identityB64 } });
    };
    reader.onerror = () => { fileErr.textContent = "Could not read that file."; fileErr.hidden = false; };
    reader.readAsText(file);
  });
  return block;
}

// renderQuorumBlock lets an operator who ALREADY split their key load a quorum of shares and reassemble
// it here, which is what makes re-splitting possible when custodians change. Without it this screen
// accepted only a whole identity.key, so a customer who had done exactly what the product recommended,
// and destroyed the unsplit original, had no way back in.
//
// Re-splitting is NOT revocation, and the copy says so. A re-split mints a fresh wrapping key and a
// fresh identity.key.enc, but the OLD shares still open the OLD ciphertext and recover the same key. If
// a departing custodian kept both, the only real remedy is rotating the break-glass key itself.
function renderQuorumBlock(mountStep: (result: CustodyKeyInput) => void, stepHost: HTMLElement): HTMLElement {
  const err = h("p", { class: "field__error", role: "alert", hidden: true });
  const card = renderReassemblyCard({
    showDownload: false,
    onRecovered: (recovered) => {
      err.hidden = true;
      if (recovered === null) {
        err.textContent = "The reassembled file is not a valid identity.key, so it cannot be split.";
        err.hidden = false;
        stepHost.replaceChildren();
        return;
      }
      // The card hands back the PARSED key, so the recovered file's text never reaches this closure. The
      // custody step's own contract is base64url, so re-encode from the bytes rather than re-parsing text:
      // one string instead of two, and the one that is gone is the whole identity.key file.
      const identityB64 = b64urlEncode(concat(recovered.x25519Scalar, recovered.mlkemSeed));
      mountStep({ breakGlass: { identityB64 } });
    },
    onInvalidated: () => {
      // The loaded shares or ciphertext changed, so anything reassembled from the old set is stale and
      // must not stay mounted as the thing about to be re-split.
      err.hidden = true;
      stepHost.replaceChildren();
    },
  });
  const block = h("div", { style: "margin-top:var(--space-4)" },
    h("p", { class: "field__hint" }, "Already split this key? Load a quorum of shares to reassemble it here, then split it again for your current custodians. Reassembly happens in this browser and nothing is uploaded."),
    h("p", { class: "field__hint" }, "Re-splitting makes new shares for the same key. Anyone holding an old share and the old identity.key.enc can still rebuild it, so destroy the old encrypted key file when you re-split. If a departing custodian may have held both, rotate the key itself rather than re-splitting it."),
    collapsedSection("Reassemble a split (M-of-N) key instead", card.el),
    err,
  );
  // This block returns a bare element, so nothing else can reach card.teardown(). A quorum reassembled here
  // rebuilds the WHOLE break-glass key (that is the point of the block), so leaving its shares, envelope and
  // reconstructed key loaded after the Custody tab goes away is the same hole the break-glass panels had.
  wipeOnDisconnect(block, () => card.teardown());
  return block;
}

// parseIdentityFile extracts the base64url identity from a downpipe identity.key file
// ("downpipe-identity-v1 <identityB64>"). Returns null if the label is absent or the token is
// missing. A light shape guard only; the custody step / loaders validate the bytes downstream.
function parseIdentityFile(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("downpipe-identity-v1"));
  if (!line) return null;
  const token = line.slice("downpipe-identity-v1".length).trim();
  return token !== "" ? token : null;
}

// renderMultiCustodianCard explains the M-of-N custody pattern and points to the in-browser
// tooling. The interactive splitter is the custody step (components/custody-step.ts), shown
// in the ceremony-result card once a ceremony is in memory. This standalone card stays
// useful for a returning operator (no ceremony in memory) who wants to understand or apply
// the pattern.
//
// The console IS no-custody and DOES perform the split, because it splits only a random
// 256-bit WRAPPING key, never the break-glass private directly: it envelope-encrypts the
// key file in your browser, Shamir-splits the wrapping key M-of-N, and offers the ciphertext
// and each share as downloads. Nothing is transmitted. (Splitting the ~3 KB key directly is
// the wrong pattern; Shamir tooling targets short secrets, which is why only the wrapping
// key is split.)
//
// Claims are precise: "post-quantum hybrid" not "quantum-proof"; the threshold is the
// operator's risk decision; the engine holds only the break-glass PUBLIC key.
function renderMultiCustodianCard(): HTMLElement {
  // The long-form teaching (the "why" and the recommended operational pattern). The Custody tab
  // renders the ACTIONABLE split above this; this stays as the reference beneath it.
  const card = h("div", { class: "measure" });

  card.appendChild(
    h(
      "p",
      { style: "color:var(--text)" },
      "An Enterprise or CISO-reviewed deployment should split custody of the break-glass private across several independent holders, so no single person or system is a single point of failure for recovery.",
    ),
  );

  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      "After a key ceremony, this screen offers the split in your browser under \"Protect your break-glass key\": it does not split the key file directly. It encrypts the key file with a random 256-bit wrapping key, splits only that wrapping key M-of-N, and offers the ciphertext and each custodian share as separate downloads.",
    ),
  );

  // Operational pattern guidance (applies whether you use the in-browser splitter or an
  // external Shamir tool on the wrapping key).
  card.appendChild(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-4)" }, "Recommended operational pattern"));

  const steps = [
    "Run the key ceremony, then use the in-browser custody step to encrypt the key file and split the wrapping key M-of-N (for example 3 of 5). Save identity.key itself to secure offline storage as well.",
    "Distribute each share to a separate custodian, stored on separate offline media. No single custodian holds more than one share or any combination that meets the threshold alone.",
    "Store the small ciphertext (identity.key.enc) apart from the shares, in a password manager or on an encrypted drive. On its own it carries no usable key.",
    "Record the quorum threshold and which custodian holds which share on the recovery sheet (the custody step fills these sign-off lines), and keep the recovery sheet separate from any share.",
    "During recovery, assemble a quorum of custodians, reconstruct the wrapping key from their shares, decrypt the ciphertext to obtain identity.key, run the offline restore, then drop the reconstructed key and shares from that session.",
    "After a rotation, repeat the custody step on the new identity.key and re-distribute the new shares. Retain or destroy the old shares according to your policy for recovering archives sealed before the rotation.",
  ];
  const ol = h("ol", { style: "padding-left:var(--space-5);display:flex;flex-direction:column;gap:var(--space-2);margin-top:var(--space-2)" });
  for (const step of steps) ol.appendChild(h("li", { class: "field__hint" }, step));
  card.appendChild(ol);

  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-4)" },
      "If you prefer your own tooling, any Shamir-over-GF(256) implementation that treats the 32-byte wrapping key as opaque bytes is sufficient; the split does not depend on the key format. The post-quantum hybrid key material (X25519 + ML-KEM-1024) stays in identity.key, which the wrapping key protects.",
    ),
  );

  return card;
}
