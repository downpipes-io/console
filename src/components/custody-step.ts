// The optional "protect your break-glass key" step.
// It presents the tiered offline-storage menu and, for the M-of-N tier, performs the
// envelope encryption and Shamir split IN THIS BROWSER, offering the ciphertext and each
// custodian share as separate downloads. The chosen scheme and custodian sign-off flow back
// to the recovery sheet via the onChange callback (public metadata only).
//
// NO-CUSTODY, sacred here above all: every key, share, wrapping key and ciphertext is
// produced in this browser. The private key, the wrapping key and the ciphertext are ONLY ever
// offered as a download and are never transmitted. The component reads the break-glass identity
// bytes from the in-memory ceremony result (which the operator just generated locally), wraps
// them locally, and hands back downloads. It surfaces this plainly in the UI on every tier.
//
// THE ONE SANCTIONED EXCEPTION: a single custodian SHARE may, only when the operator explicitly
// clicks Email, be POSTed to the operator's OWN engine so the engine can email that custodian (a
// browser cannot send email). It is safe because the ciphertext (the envelope over identity.key) is
// NEVER POSTed, so captured shares stay useless (S1), and a share below the threshold reveals nothing.
// The email sender is host-injected (opts.sendShare); when the host omits it the split is download-only.
//
// The per-tier panels and crypto actions live in custody-step-panels.ts, the small local
// helpers in custody-step-helpers.ts, and the paper companion in custody-paper.ts (extracted
// to keep this file under the structural budget; the logic is byte-for-byte the same and the
// public exports here are unchanged).
//
// House rules: Australian English; no em dashes; CSSOM via node.style / the h() style
// helper (never setAttribute("style")); every server/operator string via textContent or
// escape; status by shape + label, not colour alone; reduced-motion honoured (no animated
// affordances are introduced; the only transient is the existing copy "Copied" flash which
// the design tokens already gate); accessible labels on every control.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_EXTERNAL } from "../lib/icons.ts";
import { badge } from "./status.ts";
import { infoTip } from "./info-tip.ts";
import type { CustodyKeyInput } from "../lib/custody-files.ts";
import {
  SCHEME_OPTIONS,
  makeSplitSignoffs,
  type CustodyScheme,
  type CustodyMetadata,
} from "../lib/custody.ts";
import {
  renderUndecided,
  renderTier12,
  renderSplit,
  type CustodyPanelContext,
  type SendShareFn,
} from "./custody-step-panels.ts";

// renderPaperCompanion is re-exported here so the keys/onboarding hosts that import it from
// this module keep working unchanged.
export { renderPaperCompanion } from "./custody-paper.ts";

// CustodyStepOptions wires the component to the key source. `result` is the in-memory
// break-glass identity bytes (the only part of a ceremony this step reads); a full
// CeremonyResult satisfies it, and a host holding only a parsed identity.key can pass the
// narrow shape directly. `onChange` is called whenever the chosen scheme or custodian
// sign-off changes, so the host can refresh the recovery sheet with the new public metadata.
// `downloadText` is the host's local-download helper (a blob download; no network), passed in
// so the component does not duplicate it.
export interface CustodyStepOptions {
  result: CustodyKeyInput;
  onChange: (meta: CustodyMetadata) => void;
  // Returns whether the browser actually accepted the delivery. It used to be typed `=> void`, which
  // discarded the one honest signal the host's downloadText already computes: a browser that blocks the
  // second and subsequent automatic downloads does not throw, so the split panel reported "Downloaded."
  // while a share never reached disk, and the wrapping key exists only in that closure.
  downloadText: (name: string, content: string) => boolean;
  // sendShare is OPTIONAL. When the host supplies it (from its EngineClient.sendCustodyShare), the M-of-N
  // split gains a per-share Email action (the one sanctioned network exception; see the header). When
  // omitted, the split is download-only. Wire it only where outbound email is expected to be configured
  // (the onboarding custody step runs after the email-setup gate); the engine still refuses gracefully if
  // email is not set up, and the operator can always download instead.
  sendShare?: SendShareFn;
}

// renderCustodyStep builds the whole step: the no-transmission banner, the tier menu, the
// per-tier panel, and the optional YubiKey layer. It returns a single element to append.
export function renderCustodyStep(opts: CustodyStepOptions): HTMLElement {
  const root = h("div", { class: "custody-step" });

  // State for this step instance. The chosen scheme and the split parameters drive both the
  // rendered panel and the metadata handed back to the recovery sheet. Nothing here is a
  // key or a share value: the actual bytes never live in this state, only the public
  // selections.
  const state = {
    scheme: "undecided" as CustodyScheme,
    splitN: 5,
    splitThreshold: 3,
    signoffs: [] as CustodyPanelContext["state"]["signoffs"],
  };

  // emitMeta builds the public CustodyMetadata and notifies the host. exactOptionalProperty:
  // n/threshold are present only for the split scheme.
  const emitMeta = (): void => {
    if (state.scheme === "mofn-split") {
      opts.onChange({ scheme: state.scheme, n: state.splitN, threshold: state.splitThreshold, signoffs: state.signoffs });
      return;
    }
    opts.onChange({ scheme: state.scheme, signoffs: state.signoffs });
  };

  // The context the per-tier panels reach for (shared mutable state + the host callbacks).
  const ctx: CustodyPanelContext = {
    state,
    result: opts.result,
    downloadText: opts.downloadText,
    emitMeta,
    ...(opts.sendShare ? { sendShare: opts.sendShare } : {}),
  };

  // The in-browser-only guarantee stays VISIBLE (one short line + badge); the longer
  // explanation of WHY nothing is transmitted moves into an infoTip. The section title and
  // "(optional)" framing is the collapsed-disclosure summary the host wraps this in, so it is
  // not repeated here.
  root.appendChild(
    h(
      "p",
      { class: "field__hint", style: "display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap" },
      "Choose how to keep the break-glass key safe offline.",
      badge("trust", "In-browser only"),
      infoTip("Any encryption, wrapping key or custodian share is generated in this browser. The private key, the wrapping key and the encrypted key file are never transmitted. A single custodian share may, only when you click Email, be sent through your own engine to email that custodian; the encrypted key file never is, so captured shares stay useless. Maelstrom receives nothing.", { label: "Why this is in-browser first" }),
    ),
  );

  // THE CEREMONY, named before the button rather than discovered after it. Emailing a share is the ONE
  // action in this step that leaves the browser, and it is a step-up gated write on the engine
  // (POST /custody/send-share), so the browser opens a passkey prompt on Email. Shown only when the host
  // wired a sender: a download-only split runs no ceremony and must not promise one.
  if (opts.sendShare) {
    root.appendChild(
      h("p", { class: "field__hint measure" },
        "Emailing a share goes through your own engine, so you may be asked to confirm with your own passkey when you click Email. If you dismiss that prompt, or it fails, no share is sent and the shares stay here for you to try again or download instead.",
      ),
    );
  }

  // The tier menu (radio group; status by selected-state + label). The panel host below
  // re-renders when the selection changes.
  const panelHost = h("div", { class: "custody-panel" });

  const menu = h("div", { class: "custody-menu", role: "radiogroup", "aria-label": "Offline custody scheme" });
  for (const o of SCHEME_OPTIONS) {
    const id = `custody-scheme-${o.id}`;
    const radio = h("input", { type: "radio", name: "custody-scheme", id, value: o.id }) as HTMLInputElement;
    const assuranceBadge = o.assurance === "highest"
      ? badge("trust", "Highest assurance")
      : o.assurance === "cold"
        ? badge("info", "Cold storage")
        : badge("default", "Fits most teams");
    // Compact card: title + badge + a single one-line summary, with the longer tier
    // explanation (o.detail) tucked into an infoTip rather than rendered as a paragraph in
    // the panel below.
    const label = h(
      "label",
      { class: "custody-menu__item", for: id },
      radio,
      h(
        "span",
        { class: "custody-menu__body" },
        h("span", { class: "custody-menu__title" }, h("strong", o.label), assuranceBadge, infoTip(o.detail, { label: `About: ${o.label}` })),
        h("span", { class: "field__hint" }, o.summary),
      ),
    );
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      state.scheme = o.id;
      // Reset split sign-offs when entering the split tier so they match N.
      if (state.scheme === "mofn-split") state.signoffs = makeSplitSignoffs(state.splitN);
      else state.signoffs = [];
      emitMeta();
      panelHost.replaceChildren(renderPanel());
    });
    menu.appendChild(label);
  }
  root.appendChild(menu);
  // Group-level doc link: the scheme radios are one custody choice, so the link
  // explaining the offline-storage options and the custodian sign-off lives on the group, not a radio.
  root.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/concepts/key-ceremony-and-recovery-kit#your-standing-duty-after-the-ceremony", target: "_blank", rel: "noreferrer noopener" },
      "About offline custody",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  root.appendChild(panelHost);
  panelHost.appendChild(renderPanel());

  // renderPanel renders the body for the current scheme.
  function renderPanel(): HTMLElement {
    switch (state.scheme) {
      case "undecided":
        return renderUndecided();
      case "password-manager":
      case "encrypted-usb-paper":
        return renderTier12(ctx, state.scheme);
      case "mofn-split":
        return renderSplit(ctx);
    }
  }

  // Emit the initial (undecided) metadata so the host starts consistent.
  emitMeta();
  return root;
}
