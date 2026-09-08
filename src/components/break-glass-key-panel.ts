// THE BREAK-GLASS KEY PANEL: collect the operator's break-glass identity ENTIRELY IN THIS BROWSER, either as
// an uploaded identity.key or by reassembling an M-of-N Shamir quorum, and hand the parsed private back to the
// caller for a local capsule decap. The key is never uploaded, and nothing here performs an unseal or a
// network call of any kind: it collects, it reports what it holds, and it wipes.
//
// WHY IT IS A MODULE AND NOT A SECOND COPY. This collection is needed by more than one recovery flow (an
// estate-import into a fresh account, and a sibling disaster where the account survives and only the
// scheduler was wiped). Two hand-maintained copies of a surface that holds a reconstructed break-glass
// private key is precisely the arrangement where one of them quietly stops wiping. So it moved here, whole.
//
// THE WIPE CONTRACT IS THE LOAD-BEARING PART. There are TWO independent secret
// holders behind this panel, not one:
//
//   1. `privateKey` in this module's own closure, the parsed identity, and
//   2. the reassembly card, which independently holds raw Shamir shares, the envelope ciphertext/iv and,
//      once quorum is met, a full decrypted identity.key in ITS own closure.
//
// Wiping only the first leaves a reconstructed break-glass private key unzeroed in the tab's memory for the
// rest of the page's life. So the only wipe this module exposes is `wipeAll`, which clears both. There is
// deliberately no way to zero one without the other, because that choice is what went wrong before.
//
// A CALLER STILL OWES ONE THING: navigating away is an exit too, and it is the one that used to wipe nothing.
// dialog.ts tears every overlay down WITHOUT invoking onClose callbacks, deliberately, so an onClose that
// navigates cannot fight a navigation already under way. Mount this panel behind `wipeOnDisconnect(body,
// panel.wipeAll)` as well as the dismiss and cancel paths. `wipeAll` is idempotent, so a dismiss firing it and
// the observer firing it again costs nothing.
//
// House style: Australian English, no em dashes, no rule-of-three.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_CHEVRON_RIGHT, ICON_LOCK } from "../lib/icons.ts";
import { type HybridRecipientPrivate, parseIdentityFile } from "../lib/keydecap.ts";
import { renderReassemblyCard } from "../screens/restore-flow/reassembly.ts";
import { badge } from "./status.ts";

// readIdentityFileLocal reads a selected identity.key in THIS browser (FileReader.readAsText) and parses it.
// It never uploads: the bytes are read locally and the parsed identity is held only in this module's closure.
// A small, deliberate duplicate of screens/restore-flow/attend.ts's readIdentityFile (a components/ module does
// not reach into a screens/ one for a ten-line FileReader wrapper; renderReassemblyCard, which this module DOES
// import, is the one genuinely shared, non-trivial piece, the M-of-N reconstruction).
function readIdentityFileLocal(file: File): Promise<HybridRecipientPrivate> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseIdentityFile(typeof reader.result === "string" ? reader.result : ""));
      } catch (e) {
        reject(e instanceof Error ? e : new Error("that file is not a valid identity.key"));
      }
    };
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsText(file);
  });
}

export interface BreakGlassKeyPanel {
  /** The panel element. Mount it where the sealed sub-panel belongs; it starts hidden. */
  el: HTMLElement;
  /** The identity currently held in this browser, or null. Never serialise or transmit the result. */
  identity: () => HybridRecipientPrivate | null;
  /** Zero BOTH secret holders: this closure's parsed identity and the reassembly card's shares, envelope and reconstructed key. Idempotent. */
  wipeAll: () => void;
  /** Show or hide the panel. Visibility alone never wipes; a caller that hides the panel because no key is needed any more should call wipeAll() itself, and estate-import-modal.ts does. */
  setVisible: (visible: boolean) => void;
}

// THE FILE INPUT'S id IS A LITERAL HERE, DELIBERATELY, and it is not a caller option. scripts/field-census.mjs
// derives a control's declaration site by reading literal id strings out of the source, so an `id: opts.inputId`
// makes a CATALOGUED control invisible to the census: the field-catalogue gate then reports it uncatalogued at
// the caller and orphaned at the panel, which is exactly what happened when this was first extracted. A single
// stable id is also correct on its own terms, because both flows that mount this panel are modals and the
// overlay stack holds one at a time, so two panels are never on the page together.
//
// It is written out at BOTH sites rather than hoisted to a named constant, because a constant reference is not
// a literal either: the census reads the source text, and `id: IDENTITY_INPUT_ID` is as invisible to it as
// `id: opts.inputId` was. The duplication is the price of being catalogued, and the field-catalogue gate is
// what notices if the two ever disagree.

export interface BreakGlassKeyPanelOptions {
  /** The sentence explaining why a key is needed here. Each flow's disaster differs, so each names its own. */
  intro: string;
}

export function renderBreakGlassKeyPanel(opts: BreakGlassKeyPanelOptions): BreakGlassKeyPanel {
  let privateKey: HybridRecipientPrivate | null = null;
  const wipePrivate = (): void => {
    if (privateKey) {
      privateKey.x25519Scalar.fill(0);
      privateKey.mlkemSeed.fill(0);
    }
    privateKey = null;
  };

  const keyStatus = h("p", { class: "field__hint", role: "status", "aria-live": "polite", style: "margin:0" }, "No key supplied yet.");
  const keyErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const identityFileInput = h("input", {
    id: "cp-import-sealed-identity",
    type: "file",
    accept: ".key,text/plain",
    "aria-label": "Select your break-glass identity.key file",
  }) as HTMLInputElement;
  identityFileInput.addEventListener("change", () => {
    const file = identityFileInput.files?.[0];
    if (!file) return;
    keyErr.hidden = true;
    void readIdentityFileLocal(file)
      .then((id) => {
        wipePrivate();
        privateKey = id;
        keyStatus.replaceChildren(
          h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-2)" }, badge("ok", "Key read in this browser", { dot: true }), document.createTextNode("It was not uploaded.")),
        );
      })
      .catch((e: unknown) => {
        wipePrivate();
        keyErr.textContent = e instanceof Error ? `${e.message}. No key left this device.` : "That file could not be read.";
        keyErr.hidden = false;
        keyStatus.textContent = "No key supplied yet.";
      });
  });

  const reassembly = renderReassemblyCard({
    showDownload: false,
    onRecovered: (recovered) => {
      if (recovered === null) {
        keyStatus.textContent = "The reassembled file is not a standard identity.key, so it cannot be used to unseal.";
        wipePrivate();
        return;
      }
      keyErr.hidden = true;
      wipePrivate();
      privateKey = recovered;
      keyStatus.replaceChildren(
        h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-2)" }, badge("ok", "Split key reassembled in this browser", { dot: true }), document.createTextNode("Nothing was uploaded.")),
      );
    },
    onInvalidated: () => {
      wipePrivate();
      keyStatus.textContent = "No key supplied yet.";
    },
  });

  const details = h("details", { class: "field", style: "margin-top:var(--space-2)" });
  details.appendChild(h("summary", { class: "field__label", style: "cursor:pointer" }, "Reassemble a split (M-of-N) key instead"));
  details.appendChild(reassembly.el);

  const el = h(
    "section",
    { class: "card", style: "display:grid;gap:var(--space-3);margin-top:var(--space-2)" },
    h("h3", { class: "card__title" }, "Your break-glass key"),
    h(
      "p",
      { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start;margin:0" },
      h("span", { style: "flex:none;margin-top:1px;color:var(--trust)" }, svgIcon(ICON_LOCK, { size: 14 })),
      h("span", opts.intro),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "cp-import-sealed-identity" }, "Upload identity.key"),
      identityFileInput,
      h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Select the identity.key you saved offline. It is read here and never uploaded."),
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/recovery/attended-verification#how-your-key-is-handled", target: "_blank", rel: "noreferrer noopener" },
        "How your key is handled",
        svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
      ),
    ),
    keyErr,
    keyStatus,
    details,
  );
  el.hidden = true;

  return {
    el,
    identity: () => privateKey,
    // Both holders, always. See the wipe contract in this file's header for why there is no single-holder wipe.
    wipeAll: () => {
      wipePrivate();
      reassembly.teardown();
    },
    setVisible: (visible: boolean) => {
      el.hidden = !visible;
    },
  };
}
