// The open-source "thank you" / SBOM dialog for the console. It opens the same
// canonical bill of materials the public website shows (src/data/sbom.ts, generated
// by tools/gen-sbom.mjs) in a focus-trapped modal, reached from a quiet link in the
// Licence screen's Provenance section.
//
// Why it lives here and not in screens/: it is a reusable component (a modal body
// builder) with no screen lifecycle, and the components/ surface is held to the 90
// per cent coverage gate, so test/cov/components-licences-dialog.ts renders it.
//
// House rules: Australian English, the noun is "licence", no em dashes, precise
// claims. Text goes in via h()'s text-node path, never innerHTML,
// so a name or a licence string can never inject markup.

import { h } from "../lib/dom.ts";
import { openModal } from "./modal.ts";
import { SBOM, type Sbom, type SbomComponent, type SbomDependency } from "../data/sbom.ts";

// A muted hint paragraph, the console's standard secondary text.
function hint(text: string): HTMLElement {
  return h("p", { style: "color:var(--text-muted);font-size:var(--text-sm);margin:0" }, text);
}

// sectionHead renders a small uppercase section label above a group.
function sectionHead(text: string): HTMLElement {
  return h(
    "h3",
    {
      style:
        "color:var(--text);font-size:var(--text-md);font-weight:600;margin:var(--space-5) 0 var(--space-2)",
    },
    text,
  );
}

// licencePill renders the SPDX id as a small mono pill.
function licencePill(licence: string): HTMLElement {
  return h(
    "span",
    {
      style:
        "font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted);border:1px solid var(--border);border-radius:var(--radius-full);padding:1px 8px;white-space:nowrap",
    },
    licence,
  );
}

// depRow renders one dependency: its name (a link to the project), version, licence
// pill, and a one-line purpose. The name is a real external link.
function depRow(dep: SbomDependency): HTMLElement {
  const top = h("div", {
    style: "display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px",
  });
  const name = h(
    "a",
    {
      href: dep.url,
      target: "_blank",
      rel: "noopener noreferrer",
      style: "font-family:var(--font-mono);font-size:var(--text-sm);color:var(--text-link)",
    },
    dep.name,
  );
  top.appendChild(name);
  if (dep.version) {
    top.appendChild(
      h(
        "span",
        { style: "font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)" },
        dep.version,
      ),
    );
  }
  top.appendChild(licencePill(dep.licence));

  const row = h("div", { style: "padding:var(--space-2) 0;border-top:1px solid var(--border-subtle)" });
  row.appendChild(top);
  if (dep.purpose) {
    row.appendChild(
      h(
        "p",
        { style: "color:var(--text-muted);font-size:var(--text-sm);margin:4px 0 0" },
        dep.purpose,
      ),
    );
  }
  return row;
}

// componentBlock renders a product component: name, language tag, blurb, an optional
// note (for the static site, which ships no runtime dependency) and its runtime deps.
function componentBlock(comp: SbomComponent): HTMLElement {
  const card = h("div", {
    style:
      "border:1px solid var(--border-subtle);border-radius:var(--radius);padding:var(--space-4);background:var(--surface-inset)",
  });

  const head = h("div", {
    style: "display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2)",
  });
  head.appendChild(h("h4", { style: "color:var(--text);font-weight:600;margin:0" }, comp.name));
  head.appendChild(
    h(
      "span",
      {
        style:
          "font-family:var(--font-mono);font-size:var(--text-xs);text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted)",
      },
      comp.lang,
    ),
  );
  card.appendChild(head);

  card.appendChild(
    h("p", { style: "color:var(--text-muted);font-size:var(--text-sm);margin:6px 0 0" }, comp.blurb),
  );
  if (comp.note) {
    card.appendChild(
      h(
        "p",
        { style: "color:var(--text-muted);font-size:var(--text-sm);font-style:italic;margin:6px 0 0" },
        comp.note,
      ),
    );
  }
  if (comp.runtime.length > 0) {
    const list = h("div", { style: "margin-top:var(--space-3)" });
    for (const dep of comp.runtime) list.appendChild(depRow(dep));
    card.appendChild(list);
  }
  return card;
}

// buildLicencesBody assembles the dialog body from the canonical SBOM. It takes the
// data as a parameter (defaulting to the bundled SBOM) so it can be rendered with a
// fixture under test. Pure: it builds and returns DOM, opening nothing.
export function buildLicencesBody(sbom: Sbom = SBOM): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column" });

  // The lead thank-you is the dialog's actual message, so it reads in the primary text
  // colour; the muted hint styling stays for genuine metadata (counts, generated-at).
  body.appendChild(
    h(
      "p",
      { style: "color:var(--text);font-size:var(--text-sm);margin:0" },
      "downpipes is built on a great deal of open-source work, and we are grateful for it. Everything " +
        "the product ships at runtime is a small, audited set of cryptography under permissive MIT and BSD " +
        "licences; the rest is the toolchain that builds and tests it. Thank you to everyone who maintains " +
        "these projects.",
    ),
  );

  // A one-line summary and the download link to the full, machine-readable SBOM.
  const meta = h("div", {
    style: "display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);margin-top:var(--space-4)",
  });
  meta.appendChild(
    h(
      "a",
      {
        class: "btn btn--secondary btn--sm",
        href: sbom.downloadUrl,
        target: "_blank",
        rel: "noopener noreferrer",
      },
      "Download the full SBOM (CycloneDX)",
    ),
  );
  meta.appendChild(
    hint(
      `${sbom.summary.runtimePackages} runtime dependencies, ${sbom.summary.toolingPackages} build tools, ` +
        `${sbom.summary.totalPackages.toLocaleString("en-AU")} packages in the full list.`,
    ),
  );
  body.appendChild(meta);

  body.appendChild(sectionHead("What the product runs on"));
  body.appendChild(hint("The third-party code that ships to your browser, runs in your account, or travels inside the offline reader."));
  const comps = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-3);margin-top:var(--space-3)" });
  for (const comp of sbom.components) comps.appendChild(componentBlock(comp));
  body.appendChild(comps);

  body.appendChild(sectionHead("Built and tested with"));
  body.appendChild(hint("The frameworks, compilers, linters and test tools we rely on. They do not ship to you, but their authors still deserve the credit."));
  const tools = h("div", { style: "margin-top:var(--space-2)" });
  for (const dep of sbom.tooling) tools.appendChild(depRow(dep));
  body.appendChild(tools);

  body.appendChild(
    h(
      "p",
      {
        style:
          "color:var(--text-muted);font-size:var(--text-xs);margin:var(--space-5) 0 0;padding-top:var(--space-3);border-top:1px solid var(--border-subtle)",
      },
      `List generated ${sbom.generatedAt}. The downloadable SBOM is the full transitive list of all ` +
        `${sbom.summary.totalPackages.toLocaleString("en-AU")} packages, every runtime dependency under a permissive licence.`,
    ),
  );

  return body;
}

// openLicencesDialog opens the modal. The body scrolls inside the dialog (the shared
// overlay engine handles the focus trap, Esc, inert background and focus restore).
export function openLicencesDialog(): void {
  openModal({
    title: "Open-source licences and thanks",
    body: buildLicencesBody(),
    actions: [{ label: "Close", variant: "primary", onClick: () => {} }],
  });
}
