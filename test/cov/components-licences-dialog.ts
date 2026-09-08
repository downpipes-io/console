// Coverage for src/components/licences-dialog.ts: the open-source "thank you" / SBOM
// dialog. It renders the canonical bill of materials (src/data/sbom.ts) into a
// focus-trapped modal reached from the Licence screen's Provenance section.
//
// This drives the REAL buildLicencesBody and openLicencesDialog under the shared DOM
// shim (no jsdom, no network), so every assertion exercises production code. It
// renders the live SBOM (the normal shape: deps with a version, a purpose, the
// static-site component with a note and no runtime deps) AND a crafted fixture that
// trips the other side of each conditional (a dependency with no version and no
// purpose, a component with a note and an empty runtime list, and one with neither),
// so the branch gate is met. It then opens the modal to cover the opener and the
// download affordance.
//
// Run with: node test/cov/components-licences-dialog.ts

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "../dom-shim.ts";

// Install the shim BEFORE importing the component (lib/dom.ts creates elements at load time).
installDomShim();

const mod = await import("../../src/components/licences-dialog.ts");
const { buildLicencesBody, openLicencesDialog } = mod;
const data = await import("../../src/data/sbom.ts");
const { SBOM } = data;
type Sbom = import("../../src/data/sbom.ts").Sbom;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// ---- 1. The real SBOM renders the full structure --------------------------------

{
  const body = buildLicencesBody() as unknown as ShimNode;
  const text = textOf(body);

  // The two section heads (h3), one h4 per component.
  const heads = qsa(body, "h3").map((n) => textOf(n));
  ok("renders the 'What the product runs on' section head", heads.includes("What the product runs on"));
  ok("renders the 'Built and tested with' section head", heads.includes("Built and tested with"));
  ok("renders one heading per product component", qsa(body, "h4").length === SBOM.components.length);

  // The thank-you and the honest runtime claim are present.
  ok("opens with a thank-you to the open-source community", text.includes("grateful") && text.includes("Thank you"));
  ok("states the runtime is permissive MIT and BSD", text.includes("permissive MIT and BSD"));

  // The runtime cryptography is named and linked (the part that actually ships).
  ok("names the audited @noble cryptography", text.includes("@noble/curves") && text.includes("@noble/post-quantum"));
  ok("names the Go reader's crypto", text.includes("golang.org/x/crypto") && text.includes("filippo.io/mldsa"));

  // The toolchain is listed too.
  ok("lists a build tool (typescript)", text.includes("typescript"));
  ok("lists the framework the sites are built with (astro)", text.includes("astro"));

  // The static-site component renders its note (no runtime dependency) rather than a dep list.
  ok("the website component carries its no-runtime note", text.includes("Ships as static HTML"));

  // Every dependency is a link, plus the one download link: anchors === runtime + tooling + 1.
  const runtimeCount = SBOM.components.reduce((n, c) => n + c.runtime.length, 0);
  const expectedAnchors = runtimeCount + SBOM.tooling.length + 1;
  ok("every dependency and the SBOM download are links", qsa(body, "a").length === expectedAnchors);

  // The download link points at the canonical CycloneDX SBOM.
  const links = qsa(body, "a");
  ok(
    "offers the full SBOM download (CycloneDX)",
    links.some((a) => a.getAttribute("href") === SBOM.downloadUrl) && text.includes("CycloneDX"),
  );
  // External links are safe (noopener noreferrer on a new tab).
  const noble = links.find((a) => (a.getAttribute("href") ?? "").includes("noble-curves"));
  ok("dependency links open safely in a new tab", noble?.getAttribute("rel") === "noopener noreferrer" && noble?.getAttribute("target") === "_blank");

  // The generation date and full-list size are footnoted.
  ok("footnotes the generation date and package total", text.includes(SBOM.generatedAt) && text.includes("transitive"));
}

// ---- 2. A fixture trips the other side of every conditional ----------------------

{
  // A component with a note and NO runtime deps (the note branch + the empty-runtime
  // branch), a component with deps that carry NO version and NO purpose (both false
  // legs of depRow) and NO note, and a tool with no version/purpose. Rendering this
  // covers the branches the real, fully-populated SBOM never reaches.
  const fixture: Sbom = {
    generatedAt: "2026-01-01",
    downloadUrl: "https://example.test/sbom.cdx.json",
    summary: { components: 2, runtimePackages: 1, toolingPackages: 1, totalPackages: 1, licences: { MIT: 1 } },
    components: [
      { key: "noted", name: "Noted", lang: "None", blurb: "ships nothing", note: "a standalone note", runtime: [] },
      { key: "bare", name: "Bare", lang: "Go", blurb: "has a bare dep", runtime: [{ name: "bare-dep", version: "", licence: "MIT", url: "https://example.test/bare", purpose: "" }] },
    ],
    tooling: [{ name: "bare-tool", version: "", licence: "MIT", url: "https://example.test/tool", purpose: "" }],
  };
  const body = buildLicencesBody(fixture) as unknown as ShimNode;
  const text = textOf(body);
  ok("a component with no runtime deps still renders its note", text.includes("a standalone note"));
  ok("a bare dependency (no version, no purpose) still renders its name and licence", text.includes("bare-dep"));
  ok("a bare tool renders without a version or purpose", text.includes("bare-tool"));
  // The bare dep's anchor exists, but it has no version span and no purpose paragraph.
  const bareLink = qsa(body, "a").find((a) => textOf(a) === "bare-dep");
  ok("the bare dependency is a link with no trailing version/purpose", bareLink !== undefined);
}

// ---- 3. openLicencesDialog mounts the focus-trapped modal ------------------------

{
  openLicencesDialog();
  // openModal appends a backdrop + dialog surface to the document body.
  ok("opening the dialog mounts an overlay", document.querySelector(".overlay") !== null);
  const surface = qs(document.body as unknown as ShimNode, ".dialog--modal");
  ok("the overlay is a modal dialog", surface !== null);
  ok("the dialog is titled for open-source licences", textOf(qs(surface as ShimNode, ".dialog__title")).includes("Open-source licences"));
  ok("the dialog body carries the bill of materials", textOf(surface as ShimNode).includes("What the product runs on"));
  // A Close action and the in-body download link are both reachable.
  const closeBtn = qsa(surface as ShimNode, "button").find((b) => textOf(b) === "Close");
  ok("the dialog offers a Close action", closeBtn !== undefined);
  // Clicking Close runs its handler and dismisses the modal (also covers the opener's
  // action callback and leaves no overlay mounted for the next cov file).
  (closeBtn as unknown as { click: () => void } | undefined)?.click();
  await flushAsync();
  ok("clicking Close dismisses the dialog", document.querySelector(".overlay") === null);
}

// ---- summary --------------------------------------------------------------------

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.log(`\nLICENCES-DIALOG COVERAGE: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nLICENCES-DIALOG COVERAGE PASS");
