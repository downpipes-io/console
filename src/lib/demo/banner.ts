// The persistent public-tour honesty banner. A small, unobtrusive,
// always-on pill that reads "Demo. Sample data. Resets on reload.", so the faked tour is LABELLED a demo at
// all times and is never mistaken for a real account. It is installed ONLY by startDemo() (the tour/demo
// flag path), so it is dead weight in the bundle on the genuine console and never renders there.
//
// It is driven by the DISTINCT public-demo signal (the tour-mode boot, not the engine's throwaway-demo
// `demoMode` flag): conflating the two would be dishonest, because the public faked tour has NO reset
// endpoint to call (reset is a page reload, not a server action). Keeping a separate banner makes the
// honesty posture explicit, and the throwaway engine's "Reset demo" affordance stays suppressed (it renders
// only when status.demoMode === true, and the demo status sets demoMode !== true, so no code change is
// needed to hide it; the assertion in the tour contract guard locks that).
//
// The banner also carries a "Reset sample data" control: a real <button> that re-seeds the in-browser world
// and re-renders the current screen in place (no page reload), so a visitor whose simulated write "stuck" can
// snap the demo back to pristine without hunting for a hard refresh. It is the one interactive affordance on
// the otherwise informational pill.
//
// House rules: Australian English, precise claims. CSP: every style is applied through
// the CSSOM by the h() builder (per-property setProperty), never an inline style attribute, so the banner
// runs under the console's strict style-src 'self' with no 'unsafe-inline'. The banner pill carries the
// (role="note") standing label plus the Reset control; the outer strip is pointer-transparent so it never
// traps a click on the app behind it.

import { h, svgIcon } from "../dom.ts";
import { ICON_EXTERNAL } from "../icons.ts";
import { resetWorld } from "./demo-world.ts";
import { navigate, currentRoute } from "../nav.ts";
import { clearEntityCaches } from "../store.ts";
import { toast } from "../../components/toast.ts";
import { emit } from "./tour/analytics.ts";

// The stable element id, so a double install is a no-op (the second call finds the existing banner and
// returns) and a test can find + remove it deterministically. One banner per page.
const BANNER_ID = "tour-demo-banner";

// The stable id of the SCREENSHOT-ROBUST corner marker (distinct from the bottom banner). One per page.
const CORNER_ID = "tour-demo-corner";

// The <body> class the banner install tags, so tokens.css can give the page content bottom clearance
// (body.dp-demo-banner .main gets padding-bottom): without it the floating pill sat over the last line of
// page content at rest. Tour-mode only by construction (installTourBanner is called only by startDemo).
const BODY_CLASS = "dp-demo-banner";

// The banner copy. Precise and honest: it names the demo, the sample data, and the reload-resets behaviour
// (the faked backend re-seeds on a fresh page load). No security claim is made here; the proof-of-moat
// screens carry the precise security language.
const BANNER_TEXT = "Demo. Sample data. Resets on reload.";
// The training walk's variant of the same honesty (demo-fetch passes it in training mode): the surface is
// a COURSE, so the label says so, while keeping the same three honest facts in the same order.
export const TRAINING_BANNER_TEXT = "Training course on sample data. Type anything where a key or a token is asked for. Everything resets on reload.";

// installTourBanner injects the persistent honesty banner into document.body and returns it (or the existing
// one on a redundant call). Idempotent: a second call never stacks a second banner. It is a no-op when there
// is no document.body to mount into (defensive; startDemo runs at boot when the body exists). The banner is
// fixed to the bottom-centre and pointer-transparent except for the pill itself, so it never blocks a click
// on the app behind it and never overlaps the skip link (which is top-left).
export function installTourBanner(doc: Document = document, text: string = BANNER_TEXT): HTMLElement | null {
  const existing = doc.getElementById(BANNER_ID);
  if (existing) return existing;
  const body = doc.body;
  if (!body) return null;

  // The "demo" status dot: a shape cue paired with the label so the banner reads by shape + text, not by
  // colour alone (WCAG 1.4.1). Decorative, so it is aria-hidden; the text carries the
  // meaning. Sized and coloured through the CSSOM (CSP-safe).
  const dot = h("span", {
    "aria-hidden": "true",
    style: "width:7px;height:7px;border-radius:var(--radius-full);background:var(--accent);flex:0 0 auto;display:inline-block",
  });

  // The "Reset sample data" control: a real <button> the visitor presses to snap the demo back to its pristine
  // seed without hunting for a hard refresh (a click that "stuck" and an in-app refresh that did not clear it
  // is the gap this closes). It re-seeds the in-browser world and RE-RENDERS the current screen in place (no
  // page reload), so the visitor keeps their place and, mid-tour, their chapter. Keyboard reachable, on the
  // console's own .linklike control style; CSP-safe styles. The whole pill already re-enables pointer-events.
  const resetBtn = h(
    "button",
    { "data-dp": "lib-demo-banner.button.reset",
      type: "button",
      class: "linklike",
      dataset: { tourReset: "true" },
      "aria-label": "Reset the sample data to its starting state",
      style: ["font-size:var(--text-sm)", "font-weight:600", "color:var(--accent-subtle-fg)", "white-space:nowrap"].join(";"),
      on: { click: () => resetSampleData() },
    },
    "Reset sample data",
  );

  // A hairline separator between the standing label and the reset control, so the two read as distinct.
  const sep = h("span", { "aria-hidden": "true", style: "width:1px;height:14px;background:var(--border);flex:0 0 auto" });

  // The pill: the accent-subtle surface (the brand accent family, deliberately distinct from a warning hue,
  // since the demo is not an error state), with the brand-accent foreground for an AA contrast on that
  // surface in both themes. pointer-events:auto so the pill itself is hover/selectable, inside a
  // pointer-events:none wrapper so the rest of the fixed strip never intercepts clicks on the app.
  const pill = h(
    "div",
    {
      style: [
        "pointer-events:auto",
        "display:inline-flex",
        "align-items:center",
        "gap:var(--space-2)",
        "padding:var(--space-2) var(--space-4)",
        "border-radius:var(--radius-full)",
        "background:var(--accent-subtle-bg)",
        "color:var(--accent-subtle-fg)",
        "border:1px solid var(--border)",
        "box-shadow:var(--shadow)",
        "font-family:var(--font-sans)",
        "font-size:var(--text-sm)",
        "font-weight:500",
        "line-height:1.3",
        // No nowrap on the pill: on a very narrow screen it wraps its content onto a second line rather than
        // clip; text-align:center keeps a wrapped line tidy. max-width:92vw never lets the pill exceed the
        // viewport (the 92vw idiom also dodges the desktop scrollbar gutter a 100vw-based width would overflow).
        "flex-wrap:wrap",
        "justify-content:center",
        "text-align:center",
        "max-width:92vw",
      ].join(";"),
    },
    dot,
    h("span", text),
    sep,
    resetBtn,
  );

  // The fixed outer strip: bottom-centred, above the standing chrome (the sticky z-rung) but below modals,
  // toasts and the palette, so a dialog or the command palette always sits over it. pointer-events:none so
  // only the pill is interactive and the banner never blocks the app underneath.
  const banner = h(
    "div",
    {
      id: BANNER_ID,
      // role="note" + an aria-label announces the standing demo context to assistive tech once, without the
      // urgency of a live region (it is permanent, not a transient alert) and without trapping focus.
      role: "note",
      "aria-label": `${text} This is a guided experience with sample data, not a real account.`,
      dataset: { tourBanner: "true" },
      style: [
        "position:fixed",
        "left:0",
        "right:0",
        "bottom:var(--space-4)",
        "z-index:var(--z-sticky)",
        "display:flex",
        "justify-content:center",
        "pointer-events:none",
      ].join(";"),
    },
    pill,
  );

  body.appendChild(banner);
  // Tag <body> so tokens.css gives the page content bottom clearance while the pill floats over it (see
  // BODY_CLASS above). classList is guarded for an exotic host document; the clearance is a nicety, not a gate.
  body.classList?.add(BODY_CLASS);
  return banner;
}

// removeTourBanner removes the banner (and the body clearance class) if present (the cov validator restores
// the DOM after asserting the install). A no-op when absent. The tour itself never REMOVES the banner; it is
// persistent by design, though the tour director display-toggles it hidden while the guided walk's nav-bar
// occupies the same bottom band (the top-right DEMO pill keeps the honesty label) and restores it on exit.
export function removeTourBanner(doc: Document = document): void {
  doc.getElementById(BANNER_ID)?.remove();
  doc.body?.classList?.remove(BODY_CLASS);
}

// installTourCornerMarker injects the SCREENSHOT-ROBUST demo marker: a small fixed "DEMO" badge pinned in the
// TOP-RIGHT corner at a z-index ABOVE modals, toasts, the command palette and tooltips, so it survives ANY open
// overlay AND most screenshot crops (the bottom banner is hidden by a dialog and croppable). It makes the public
// tour unmistakably a demo even with a modal open or a cropped screenshot, so a screenshot of the real-looking
// console UI can never be passed off as a real account. It is pointer-transparent (never blocks the app), a
// role="note" with an aria-label (announced once, never a focus trap), and tokenised end to end. Idempotent: a
// second call returns the existing marker. A no-op-safe view (no body -> null). CSP: every style via the CSSOM.
export function installTourCornerMarker(doc: Document = document, label = "DEMO"): HTMLElement | null {
  const existing = doc.getElementById(CORNER_ID);
  if (existing) return existing;
  const body = doc.body;
  if (!body) return null;

  // The "demo" dot: a shape cue paired with the label (shape + text, not colour alone). Decorative.
  const dot = h("span", {
    "aria-hidden": "true",
    style: "width:6px;height:6px;border-radius:var(--radius-full);background:var(--accent-fg);flex:0 0 auto;display:inline-block",
  });

  const marker = h(
    "div",
    {
      id: CORNER_ID,
      role: "note",
      "aria-label": "Demo, sample data. This is a product tour, not a real account.",
      dataset: { tourCorner: "true" },
      style: [
        "position:fixed",
        "top:var(--space-3)",
        "right:var(--space-3)",
        // ABOVE everything: modals (300), toasts (400), palette (500) and tooltips (600), so the marker stays
        // visible with any overlay open. It must never be hidden by a dialog the way the bottom banner is.
        "z-index:calc(var(--z-tooltip) + 1)",
        "display:inline-flex",
        "align-items:center",
        "gap:var(--space-2)",
        "padding:6px var(--space-3)",
        "border-radius:var(--radius-full)",
        // The brand accent (deliberately distinct from a warning hue, since the demo is not an error), with the
        // accent foreground for AA contrast in both themes. A clear marker, not obnoxious.
        "background:var(--accent)",
        "color:var(--accent-fg)",
        "border:1px solid var(--accent)",
        "box-shadow:var(--shadow)",
        "font-family:var(--font-sans)",
        "font-size:var(--text-xs)",
        "font-weight:700",
        "letter-spacing:var(--tracking-wide)",
        "line-height:1",
        // Pointer-transparent so it never intercepts a click on the app behind it (it is a marker, not a control).
        "pointer-events:none",
        "user-select:none",
      ].join(";"),
    },
    dot,
    h("span", label),
  );

  body.appendChild(marker);
  return marker;
}

// removeTourCornerMarker removes the corner marker if present (the cov validator restores the DOM after
// asserting it). A no-op when absent. The tour itself never calls this; the marker is persistent by design.
export function removeTourCornerMarker(doc: Document = document): void {
  doc.getElementById(CORNER_ID)?.remove();
}

// The stable id of the ALWAYS-VISIBLE site link (one per page; validators find + remove it by id).
const SITE_LINK_ID = "tour-site-link";

// installTourSiteLink injects the persistent tour-to-site affordance: a small fixed "downpipes.io" button
// pinned directly BELOW the top-right DEMO marker, at the same above-everything z-index, so a visitor
// always has a one-click path from the tour back to the marketing site (learn more, pricing, deploy),
// during the guided walk AND in free-roam, with any modal open. This is the standing half of the
// bidirectional funnel; the site's header carries the other half (its Live-tour button). Unlike the
// pointer-transparent DEMO marker it IS interactive (a real anchor), opens in a new tab so the visitor's
// place in the tour is never lost, and carries the same server-side-counted ?src= convention as the other
// CTAs (the tour itself sends nothing anywhere; the click emits the local, flag-gated funnel event the
// other CTAs share). Idempotent; a document with no body is a no-op. CSP: every style via the CSSOM.
export function installTourSiteLink(doc: Document = document): HTMLElement | null {
  const existing = doc.getElementById(SITE_LINK_ID);
  if (existing) return existing;
  const body = doc.body;
  if (!body) return null;
  const link = h(
    "a",
    {
      id: SITE_LINK_ID,
      href: "https://downpipes.io/?src=tour-chrome",
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-label": "Learn more at downpipes.io (opens in a new tab)",
      title: "The full story, pricing and deploy guides, on downpipes.io",
      dataset: { tourSiteLink: "true" },
      style: [
        "position:fixed",
        // Stacked directly below the DEMO corner marker (top-3 + the marker's ~26px height + a 8px gap).
        "top:calc(var(--space-3) + 34px)",
        "right:var(--space-3)",
        // The same above-everything layer as the DEMO marker, so the way back to the site survives any
        // open modal, toast, palette or tooltip; always visible is the whole point.
        "z-index:calc(var(--z-tooltip) + 1)",
        "display:inline-flex",
        "align-items:center",
        "gap:var(--space-2)",
        "padding:6px var(--space-3)",
        "border-radius:var(--radius-full)",
        // A quiet raised surface: clearly a control, deliberately calmer than the accent DEMO marker
        // above it (the honesty label keeps the loudest voice in the corner).
        "background:var(--surface-raised)",
        "color:var(--text)",
        "border:1px solid var(--border)",
        "box-shadow:var(--shadow)",
        "font-family:var(--font-sans)",
        "font-size:var(--text-xs)",
        "font-weight:600",
        "line-height:1",
        "text-decoration:none",
        "pointer-events:auto",
      ].join(";"),
      on: { click: () => emit({ name: "cta_clicked", detail: "site-chrome" }) },
    },
    h("span", "downpipes.io"),
    h("span", { "aria-hidden": "true", style: "display:inline-flex" }, svgIcon(ICON_EXTERNAL, { size: 11 })),
  );
  body.appendChild(link);
  return link;
}

// removeTourSiteLink removes the site link if present (validator hygiene). A no-op when absent; the tour
// itself never calls this (the affordance is persistent by design).
export function removeTourSiteLink(doc: Document = document): void {
  doc.getElementById(SITE_LINK_ID)?.remove();
}

// A small tour-distinct favicon: the same dark rounded mark as the real console but with a clear amber/accent
// "demo" dot in the corner, so the browser tab icon is NOT identical to the real console either. A data URI so
// no new asset is fetched and it works under the strict CSP. Authored as a trusted in-repo constant (never
// server data). Kept small.
const TOUR_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
      '<rect width="512" height="512" rx="112" fill="#0e1014"/>' +
      '<g transform="translate(-11.5 -15)" fill="none" stroke="#84a4ff" stroke-width="72" stroke-linejoin="round">' +
      '<rect x="160" y="256" width="192" height="192" rx="52"/><path d="M352 84V400"/></g>' +
      '<circle cx="404" cy="108" r="92" fill="#f5a623"/>' +
      "</svg>",
  );

// swapTourFavicon points the page's favicon at the tour-distinct mark (the amber-dotted variant), so the browser
// tab ICON is not identical to the real console. It updates the existing <link rel="icon"> (or adds one), and is
// idempotent + best-effort: a missing head or a DOM hiccup is a no-op (the favicon is a marker, not a gate).
export function swapTourFavicon(doc: Document = document): void {
  const head = doc.head ?? doc.getElementsByTagName?.("head")?.[0];
  if (!head) return;
  let link = doc.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
  if (!link) {
    link = h("link", { rel: "icon", type: "image/svg+xml" }) as HTMLLinkElement;
    head.appendChild(link);
  }
  link.setAttribute("href", TOUR_FAVICON);
  link.setAttribute("type", "image/svg+xml");
}

// resetSampleData snaps the demo back to its pristine starting state: it re-seeds the in-browser world, then
// RE-RENDERS the current screen in place by re-navigating to the current route (the router re-resolves and
// re-runs the screen + its data load), so the reset is immediately visible WITHOUT a full page reload and the
// visitor keeps their place (and, mid-tour, their chapter, since the info-points re-resolve their anchors
// live). A brief "Sample data reset" toast confirms it. It is exported so a test can drive it directly; in
// production the banner's Reset button is the only caller. Best-effort: a re-render fault never throws into the
// click handler (the world is already re-seeded; the next navigation paints it).
export function resetSampleData(): void {
  resetWorld();
  // Clear the store's entity + command-palette search caches (the downpipe list, the run rings, the search
  // snapshots) so the in-place reset is FULLY pristine: those caches are filled lazily and read by the command
  // palette, so without this a palette opened before the reset could show a stale snapshot until a real reload.
  clearEntityCaches();
  try {
    navigate(currentRoute());
  } catch {
    // A re-render hiccup is non-fatal: the world is re-seeded, so the next screen the visitor opens is pristine.
  }
  try {
    toast({ message: "Sample data reset.", tone: "success" });
  } catch {
    // A toast fault is non-fatal: the reset already happened and the re-rendered screen shows it.
  }
}
