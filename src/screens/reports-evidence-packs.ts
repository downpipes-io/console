// Compliance evidence packs section, moved out of reports.ts to keep the screen module
// under its size bound (console-struct-miss-reports). Behaviour-preserving: the symbols
// are identical to their former definitions.
//
// evidencePacksSection: download the customer-specific, signed compliance evidence pack for one framework
// (or all). Each pack is generated in-account from the live posture and the framework control mapping
// (engine GET /admin/reports/evidence-pack?framework=<id>&format=pdf), so it states this deployment's real
// posture per control, never a generic capability claim. No report data leaves the account.

import { h, svgIcon } from "../lib/dom.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised, errText } from "../lib/errors.ts";
import { toast } from "../components/toast.ts";
import { ICON_LICENCE, ICON_SHIELD_CHECK } from "../lib/icons.ts";
import type { EngineClient } from "../api.ts";
import { FRAMEWORK_PACKS } from "../api.ts";
import { downloadBytes } from "./reports-helpers.ts";

export function evidencePacksSection(engine: EngineClient): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "evidence-packs-h", style: "display:grid;gap:var(--space-3);margin-top:var(--space-4)" });

  const header = h("div", { style: "display:flex;gap:var(--space-3);align-items:flex-start" });
  header.appendChild(h("span", { style: "color:var(--text-muted);flex:none;margin-top:2px" }, svgIcon(ICON_SHIELD_CHECK, { size: 20 })));
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  // data-tour-id on an INLINE span wrapping the heading TEXT so the public tour's "?" sits beside the words, not
  // at the page edge. Inert; no behaviour, no effect on the genuine console.
  lead.appendChild(h("h2", { class: "card__title", id: "evidence-packs-h" }, h("span", { dataset: { tourId: "evidence-pack" } }, "Compliance evidence packs")));
  lead.appendChild(h("p", { class: "card__subtitle" }, "A signed, dated pack per framework: for each control, the obligation, how downpipes supports it, and the live result of the posture checks that evidence it in this deployment. It maps your obligations; it does not certify you. Generated in your account; no report data leaves it."));
  header.appendChild(lead);
  card.appendChild(header);

  // Download all frameworks (one combined pack).
  const allBtn = h("button", { "data-dp": "reports-evidence-packs.button.all", class: "btn btn--secondary btn--sm", type: "button", dataset: { tourId: "evidence-download" } }, svgIcon(ICON_LICENCE, { size: 14 }), "Download all frameworks") as HTMLButtonElement;
  allBtn.addEventListener("click", () => void downloadEvidencePack(engine, "all", "All frameworks", allBtn));
  card.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" }, allBtn));

  // One row per framework: the label + a Download PDF button.
  const grid = h("div", { style: "display:grid;gap:var(--space-2);margin-top:var(--space-2)" });
  for (const fw of FRAMEWORK_PACKS) {
    const row = h("div", { style: "display:flex;gap:var(--space-3);align-items:center;justify-content:space-between;flex-wrap:wrap;border-top:1px solid var(--border-subtle);padding-top:var(--space-2)" });
    row.appendChild(h("span", { style: "color:var(--text)" }, fw.label));
    const btn = h("button", { "data-dp": "reports-evidence-packs.button.evidence-packs-section", class: "btn btn--ghost btn--sm", type: "button" }, svgIcon(ICON_LICENCE, { size: 14 }), "Download PDF") as HTMLButtonElement;
    btn.addEventListener("click", () => void downloadEvidencePack(engine, fw.id, fw.label, btn));
    row.appendChild(btn);
    grid.appendChild(row);
  }
  card.appendChild(grid);

  return card;
}

// downloadEvidencePack fetches one framework's (or the all) signed pack PDF and triggers the download,
// mirroring downloadPdf: a busy "Preparing" state, an unauthorised redirect, and an honest warn toast on
// any other failure (the api layer names a non-2xx, so an Access-redirect body is never read as a PDF).
async function downloadEvidencePack(engine: EngineClient, framework: string, label: string, btn: HTMLButtonElement): Promise<void> {
  const original = Array.from(btn.childNodes);
  btn.disabled = true;
  btn.replaceChildren(document.createTextNode("Preparing"));
  try {
    const bytes = await engine.getEvidencePackPDF(framework);
    downloadBytes(`downpipe-evidence-pack-${framework}.pdf`, bytes, "application/pdf");
    toast({ message: `${label} evidence pack downloaded` });
  } catch (err) {
    if (isUnauthorised(err)) {
      goSignedOut();
      return;
    }
    toast({ message: `Could not download the ${label} evidence pack (${errText(err)}).`, tone: "warn" });
  } finally {
    btn.disabled = false;
    btn.replaceChildren(...original);
  }
}
