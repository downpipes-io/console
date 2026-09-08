// The Tier 2 paper/QR companion guidance, extracted from custody-step.ts to keep that file
// under the structural budget. The logic is byte-for-byte the same. It is re-exported from
// custody-step.ts so existing importers do not change.
//
// House rules: Australian English; no em dashes; CSSOM via node.style / the h() style helper
// (never setAttribute("style")); every server/operator string via textContent or escape;
// status by shape + label, not colour alone; accessible labels on every control.

import { recordCeremonyStep } from "../lib/client-diag/ring.ts";
import { h } from "../lib/dom.ts";
import { statusWithLabel } from "./status.ts";
import { codeBlock } from "./code-block.ts";
import { b64urlDecode } from "../bytes.ts";
import {
  planQrChunks,
  QR_MAX_BYTES,
} from "../lib/custody.ts";

// renderPaperCompanion builds the Tier 2 paper/QR companion guidance for a payload of a
// given base64 string. It states the one-QR cap and how many codes the payload needs
// (computed by the pure planner), and offers each chunk as a downloadable text file the
// operator can feed to their own offline QR generator, or simply prints the text. We do not
// render scannable QR images in-product: a from-scratch QR encoder for multi-kilobyte
// payloads is a large dependency we will not add (only @noble is permitted), and printing
// the text or generating codes offline is the honest, supply-chain-minimal path.
//
// Exported so the keys/onboarding hosts can show it next to a downloaded ciphertext.
export function renderPaperCompanion(opts: {
  payloadB64: string;
  payloadLabel: string;
  downloadText: (name: string, content: string) => void;
}): HTMLElement {
  const wrap = h("div", { class: "custody-paper", style: "margin-top:var(--space-4)" });
  wrap.appendChild(h("h4", { class: "legend-col__title" }, "Paper companion (print or QR)"));
  // QR planning is over the UTF-8 byte length of the base64 text (the bytes a QR would
  // encode). base64url is ASCII, so the string length equals the byte length.
  const byteLen = opts.payloadB64.length;
  const plan = planQrChunks(byteLen, QR_MAX_BYTES);
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      `One QR code holds at most ${QR_MAX_BYTES.toLocaleString("en-AU")} bytes. ${opts.payloadLabel} is ${byteLen.toLocaleString("en-AU")} bytes, so it needs ${plan.total} ${plan.total === 1 ? "code" : "codes"} if you use QR, or you can simply print the text below. Generate the codes with your own offline QR tool; the console does not transmit anything.`,
    ),
  );
  // Offer each chunk as a download (the operator feeds each to a QR generator), plus the
  // whole text. Content is set via codeBlock (textContent), so no markup injection.
  if (plan.total > 1) {
    const list = h("div", { class: "custody-qr-chunks" });
    for (const r of plan.ranges) {
      const chunk = opts.payloadB64.slice(r.start, r.end);
      const row = h("div", { class: "custody-qr-chunk" });
      row.appendChild(h("span", { class: "field__hint" }, r.label));
      const dl = h(
        "button",
        { "data-dp": "components-custody-paper.button.download-text", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Download ${r.label}` },
        "Download chunk",
      ) as HTMLButtonElement;
      dl.addEventListener("click", () => opts.downloadText(`qr-chunk-${r.index}-of-${plan.total}.txt`, `${chunk}\n`));
      row.appendChild(dl);
      list.appendChild(row);
    }
    wrap.appendChild(list);
  }
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Or print the full text:"));
  wrap.appendChild(codeBlock(opts.payloadB64, { copyLabel: `Copy ${opts.payloadLabel}` }));
  // Validity proof for an operator: decoding round-trips (the text is valid base64url).
  // This is a cheap local check that the printed text is not truncated.
  // BOTH endings are recorded. This round-trip is the one validity proof on the long-term paper backup. An
  // `ok` row is what says the console did check and the check passed; the failed
  // row is what says it warned them. Without the ok row, a ceremony that was never run and one that passed are the
  // same absence. NO PAYLOAD, NO FRAGMENT AND NO DECODE OFFSET RIDES: the payload is the encrypted key material.
  try {
    b64urlDecode(opts.payloadB64);
    recordCeremonyStep("paper-roundtrip-check", true);
    wrap.appendChild(statusWithLabel("ok", "The printable text decodes cleanly (not truncated)."));
  } catch {
    recordCeremonyStep("paper-roundtrip-check", false, "decode");
    wrap.appendChild(statusWithLabel("warn", "The printable text did not decode; do not rely on this copy."));
  }
  wrap.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Unpowered flash can lose its charge in one to five years, so keep a printed copy as the long-term backup."),
  );
  return wrap;
}
