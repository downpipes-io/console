// Overview (IA screen 1) Cloudflare-coverage hero: the nine Cloudflare surfaces from the public
// adverts (Workers KV, R2, D1, Secrets Store, Workers, Stream, Images, Artifact Registry,
// Configuration) as a 3x3 grid, each tile coloured by where that surface sits in the backup journey.
// It mirrors the advert's "Your Cloudflare account" panel so the console and the marketing read the
// same, but here the colours are the operator's REAL state, not a provocation:
//   covered  (green) - at least one downpipe backs this surface up. Read from the live downpipe list,
//                      which is already on the Overview, so it refreshes on the normal 30s poll.
//   added    (amber) - the surface is added as a source but NO downpipe backs it up yet (the real,
//                      actionable gap). Read from source discovery (bound bindings for kv/r2/d1/secrets,
//                      the added token set for the five Cloudflare-wide sources).
//   unadded  (slate) - not added at all. A quiet "not set up yet", deliberately NOT red: an account
//                      that simply does not use Stream/Images should not read as broken (this codebase
//                      never cries wolf). The text label carries the meaning, so colour is never alone.
//   notoken          - a token surface that cannot be offered because NO read-only discovery token is
//                      stored. Account discovery is OPT-IN, so this is the DEFAULT state of a healthy,
//                      current engine, and it is actionable: the tile links to Sources to add one.
//   unavailable      - a token surface the DEPLOYED engine does not advertise (an older engine): it
//                      cannot be added here, so it reads "not on this engine", not a false "not added".
//
// WHY notoken IS A SEPARATE STATE. It used to be folded into unavailable, so an estate that had simply
// never stored a discovery token was told "Not on this engine" for four surfaces the engine supports
// unconditionally (the adapters are compiled in; router-discovery.ts:247 advertises them the moment a token
// exists). The tile was also non-actionable, so the one control that fixes it was not offered, and the
// remedy the copy implied (roll the engine forward) would never have worked.
//
// This is the SAME mistake lib/token-source.ts documents under its tokenPresent gate: "testing the flags
// alone therefore called a healthy, current, correctly-configured engine version skew for every customer who
// had simply never stored a read-only Cloudflare token". That module gates on tokenPresent and declines to
// report skew, expressly because "the screen tells the operator so". This screen did not. It does now, and
// the two now read tokenPresent the same way, including the distinction that matters: tokenPresent ABSENT
// (an engine predating the account tier) is genuine skew and stays "not on this engine", while tokenPresent
// FALSE is the healthy opt-in default and says so.
//   unknown          - the downpipe list or the discovery read could not be resolved: an honest unknown,
//                      never an asserted "not covered" off an absent list.
//
// The pure surfaceCoverage() computes the per-surface state with no DOM so a validator can round-trip
// every branch; buildSurfaceCoverageGrid() renders it. Each tile is a real navigation: unadded -> add it
// on Sources, added -> the create-downpipe wizard pre-filled with that source, covered -> its downpipe(s).
// The target screen enforces the role; this surface only navigates. House rules: Australian English, no
// em dashes, precise claims. No <style> is injected (rules live in tokens.css).

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { sourceIcon } from "../sources-downpipes/helpers.ts";
import { tokenSourceOffered, isTokenSourceType } from "../../lib/token-source.ts";
import { classifyError } from "../../lib/errors.ts";
import type { SourceSpec, SourceDiscovery, DownpipeState } from "../../api.ts";
import type { Settled, OverviewData } from "./shared.ts";

// SurfaceType is the canonical nine-member union (api.ts SourceSpec.type): the four binding sources
// (kv/r2/d1/secrets) plus the five Cloudflare-wide token sources (cf-config/workers/stream/images/artifacts).
export type SurfaceType = SourceSpec["type"];

// SurfaceState is the per-surface verdict the tile colours on. See the module header for what each means.
export type SurfaceState = "covered" | "added" | "unadded" | "notoken" | "unavailable" | "unknown";

export interface SurfaceCoverage {
  type: SurfaceType;
  label: string;
  state: SurfaceState;
  downpipeCount: number; // how many downpipes back this surface up (0 unless covered)
}

// SURFACES is the nine surfaces in the advert's grid order (left to right, top to bottom): the four
// bindings first, then the five Cloudflare-wide sources, so the console grid reads exactly like the ad.
// The label is the human surface name (the advert's wording); the icon is the SAME sourceIcon() the
// Sources and Downpipes screens use, so a surface looks the same everywhere.
const SURFACES: ReadonlyArray<{ type: SurfaceType; label: string }> = [
  { type: "kv", label: "Workers KV" },
  { type: "r2", label: "R2" },
  { type: "d1", label: "D1" },
  { type: "secrets", label: "Secrets Store" },
  { type: "workers", label: "Workers" },
  { type: "stream", label: "Stream" },
  { type: "images", label: "Images" },
  { type: "artifacts", label: "Artifact Registry" },
  { type: "cf-config", label: "Configuration" },
];

// isBindingType narrows a surface to the four BINDING sources, whose "added" signal is a present
// wrangler binding in discovery.bound (not the token addedSources set).
function isBindingType(t: SurfaceType): t is "kv" | "r2" | "d1" | "secrets" {
  return t === "kv" || t === "r2" || t === "d1" || t === "secrets";
}

// surfaceCoverage computes the nine surfaces' state from the live downpipe list and the settled source
// discovery. It is the one place the red/amber/green logic lives, pure and DOM-free so a validator
// round-trips every branch.
//   downpipes === null            -> the list could not be read: every surface is an honest "unknown"
//                                    (never assert "not covered" off an absent list).
//   covered                       -> at least one downpipe has source.type === surface (any enabled state;
//                                    coverage, not health, is what this grid reads).
//   discovery not ok / value null -> a non-covered surface is "unknown" (we cannot tell added from not).
//   binding source                -> "added" when discovery.bound[type] is non-empty, else "unadded".
//   token source not offered      -> "unavailable" (the deployed engine has no adapter for it).
//   token source, legacy engine   -> addedSources absent means the engine does not gate adds (the legacy
//                                    "all supported are available" wizard), so an offered, uncovered token
//                                    surface reads "added" (available to protect), never a false "unadded".
//   token source, gating engine   -> "added" when addedSources includes it, else "unadded".
export function surfaceCoverage(
  downpipes: readonly DownpipeState[] | null,
  discovery: Settled<SourceDiscovery> | null,
): SurfaceCoverage[] {
  if (downpipes === null) {
    return SURFACES.map((s) => ({ type: s.type, label: s.label, state: "unknown" as const, downpipeCount: 0 }));
  }
  // Count downpipes per surface type (covered = at least one). Null-defensive on a partial wire shape.
  const counts = new Map<SurfaceType, number>();
  for (const dp of downpipes) {
    const t = dp?.config?.source?.type;
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // A partial response can settle ok:true with an undefined value (the type promises SourceDiscovery; the
  // wire does not), so treat a missing value as no-discovery rather than throwing on disc.bound.
  const disc = discovery?.ok && discovery.value ? discovery.value : null;
  const offered = disc ? tokenSourceOffered(disc) : null;
  return SURFACES.map((s): SurfaceCoverage => {
    const downpipeCount = counts.get(s.type) ?? 0;
    if (downpipeCount > 0) return { type: s.type, label: s.label, state: "covered", downpipeCount };
    if (disc === null) return { type: s.type, label: s.label, state: "unknown", downpipeCount: 0 };
    if (isBindingType(s.type)) {
      const added = (disc.bound?.[s.type] ?? []).length > 0;
      return { type: s.type, label: s.label, state: added ? "added" : "unadded", downpipeCount: 0 };
    }
    // Token source (the five Cloudflare-wide sources). s.type has narrowed to TokenSourceType here.
    //
    // The tokenPresent gate comes FIRST, because the engine's no-token branch (router-discovery.ts:194)
    // returns none of the capability flags, so testing the flags alone cannot tell "no token stored" from
    // "engine too old to have them" and blames the engine for both. Read defensively off the wire, and read
    // the same way lib/token-source.ts reads it: ABSENT means an engine predating the account tier (real
    // skew, so "not on this engine" stands), FALSE means the healthy opt-in default (which is notoken).
    const tier: unknown = (disc as { tokenPresent?: unknown }).tokenPresent;
    if (tier !== true && tier !== undefined) {
      return { type: s.type, label: s.label, state: "notoken", downpipeCount: 0 };
    }
    if (!isTokenSourceType(s.type) || offered === null || !offered[s.type]) {
      return { type: s.type, label: s.label, state: "unavailable", downpipeCount: 0 };
    }
    if (disc.addedSources === undefined) {
      return { type: s.type, label: s.label, state: "added", downpipeCount: 0 };
    }
    const added = disc.addedSources.includes(s.type);
    return { type: s.type, label: s.label, state: added ? "added" : "unadded", downpipeCount: 0 };
  });
}

// TilePresentation is the per-state copy + navigation target. cta is "" for the non-actionable states
// (unavailable / unknown), which render as a static tile rather than a button.
interface TilePresentation {
  status: string;
  cta: string;
  route: string;
  aria: string;
}

function tilePresentation(c: SurfaceCoverage): TilePresentation {
  switch (c.state) {
    case "covered": {
      const word = c.downpipeCount === 1 ? "downpipe" : "downpipes";
      const status = c.downpipeCount === 1 ? "In a downpipe" : `In ${c.downpipeCount} downpipes`;
      return {
        status,
        cta: "View downpipes",
        route: `/downpipes?type=${c.type}`,
        aria: `${c.label}: backed up in ${c.downpipeCount} ${word}. View downpipes.`,
      };
    }
    case "added":
      return {
        status: "Added, no downpipe",
        cta: "Create a downpipe",
        route: `/downpipes/new?type=${c.type}`,
        aria: `${c.label}: added as a source but no downpipe backs it up. Create a downpipe.`,
      };
    case "unadded":
      return {
        status: "Not added",
        cta: "Add as a source",
        route: "/sources",
        aria: `${c.label}: not added. Add it as a source.`,
      };
    case "notoken":
      return {
        status: "Needs a discovery token",
        cta: "Add a discovery token",
        route: "/sources",
        aria: `${c.label}: needs a read-only Cloudflare discovery token before it can be added. Add a discovery token.`,
      };
    case "unavailable":
      return {
        status: "Not on this engine",
        cta: "",
        route: "/sources",
        aria: `${c.label}: not available on this engine version.`,
      };
    case "unknown":
      return {
        status: "Coverage unknown",
        cta: "",
        route: "/sources",
        aria: `${c.label}: coverage could not be read.`,
      };
  }
}

// surfaceTile renders one surface card. The actionable states (covered/added/unadded) are a single
// keyboard-operable button that navigates; the non-actionable states (unavailable/unknown) are a static
// div, so the grid never offers a click that does nothing. The status dot is paired with a text label,
// so the state never depends on colour alone (WCAG 1.4.1).
function surfaceTile(c: SurfaceCoverage): HTMLElement {
  const p = tilePresentation(c);
  const top = h(
    "div",
    { class: "surf__top" },
    h("span", { class: "surf__icon", "aria-hidden": "true" }, svgIcon(sourceIcon(c.type), { size: 18 })),
    h("span", { class: "surf__name" }, c.label),
  );
  const statusLine = h(
    "div",
    { class: "surf__status" },
    h("span", { class: "surf__dot", "aria-hidden": "true" }),
    h("span", p.status),
  );
  // notoken is actionable on purpose: storing a discovery token is exactly the control that clears it, and
  // the old folded-in state offered no way to reach it.
  const interactive = c.state === "covered" || c.state === "added" || c.state === "unadded" || c.state === "notoken";
  if (!interactive) {
    return h("div", { class: "surf", dataset: { state: c.state, surface: c.type }, "aria-label": p.aria }, top, statusLine);
  }
  return h(
    "button",
    { "data-dp": "overview.button.navigate#2",
      class: "surf",
      type: "button",
      dataset: { state: c.state, surface: c.type },
      "aria-label": p.aria,
      on: { click: () => navigate(p.route) },
    },
    top,
    statusLine,
    h("span", { class: "surf__cta", "aria-hidden": "true" }, p.cta),
  );
}

// DiscoveryFailure is the COARSE class of a failed source-discovery read. The Settled<SourceDiscovery>
// carries the thrown error, and surfaceCoverage deliberately discards it (it computes states, not
// reasons), which left the hero saying "Coverage unknown" nine times over with NO indication that a
// Cloudflare account read had FAILED, let alone why. An expired or under-scoped discovery token, an
// engine that cannot be reached, and a genuinely empty account all rendered identically. This is the
// missing half: the class, and the sentence that names the control which fixes it.
export type DiscoveryFailure = "auth" | "rate-limited" | "engine" | "unreachable" | "other";

// discoveryFailureClass maps a failed discovery read to its coarse class. It reads ONLY the console's own
// closed error taxonomy (lib/errors.ts), never the message text, so no engine or Cloudflare API string is
// carried into the copy. Returns null when discovery succeeded, was never attempted, or is absent (there
// is no failure to report). Pure; exported for the validator.
export function discoveryFailureClass(discovery: Settled<SourceDiscovery> | null): DiscoveryFailure | null {
  if (discovery === null || discovery.ok) return null;
  const kind = classifyError(discovery.error).kind;
  switch (kind) {
    case "unauthorised":
    case "forbidden":
    case "access-redirect":
      return "auth";
    case "rate-limited":
      return "rate-limited";
    case "server":
      // The engine answered, and FAILED. The discovery route is where the engine makes its live
      // Cloudflare API call, so this is overwhelmingly a discovery-token problem (expired, rescoped,
      // revoked), which is exactly the setup-time misconfiguration the operator can fix themselves.
      return "engine";
    case "network":
    case "console-origin":
    case "html-body":
      return "unreachable";
    default:
      return "other";
  }
}

// DISCOVERY_FAILURE_NOTES is the one honest sentence per class: what happened, and the one control that
// fixes it. No class blames the operator's session for an engine fault, and none of them cries wolf: a
// rate-limited read resolves itself, and says so.
const DISCOVERY_FAILURE_NOTES: Readonly<Record<DiscoveryFailure, string>> = {
  auth: "Coverage is unknown because your session could not read source discovery. Sign in again, then refresh.",
  "rate-limited": "Coverage is unknown because Cloudflare rate-limited the account read. It should resolve on the next refresh.",
  engine: "Coverage is unknown because the engine could not read your Cloudflare account. The usual cause is an expired, revoked or under-scoped discovery token; re-paste it on Sources.",
  unreachable: "Coverage is unknown because the engine could not be reached to read your Cloudflare account.",
  other: "Coverage is unknown because the Cloudflare account read failed. Open Sources to check your discovery token.",
};

// discoveryFailureNote is the rendered sentence for a failed discovery read, or null when there is none.
// Pure; exported for the validator.
export function discoveryFailureNote(discovery: Settled<SourceDiscovery> | null): string | null {
  const cls = discoveryFailureClass(discovery);
  return cls === null ? null : DISCOVERY_FAILURE_NOTES[cls];
}

// coverageSummary builds the one-line mono summary that mirrors the advert's "9 surfaces" chip, with the
// honest counts. When coverage could not be read (the downpipe list or discovery failed) it says so
// rather than printing a false "9 not added".
function coverageSummary(cov: SurfaceCoverage[]): HTMLElement {
  const n = (st: SurfaceState): number => cov.filter((c) => c.state === st).length;
  // COUNTED, NOT TYPED. This read "9 surfaces" as a literal beside a grid derived from SURFACES, so a tenth
  // surface would render ten tiles under a chip that said nine. This tree has already litigated exactly this
  // and written the verdict down beside a different number (editor-wizard-source-rows.ts: "the registry moved
  // four times in one afternoon while this string did not").
  const total = cov.length;
  const totalChip = (): HTMLElement => h("b", `${total} surface${total === 1 ? "" : "s"}`);
  const allUnknown = cov.every((c) => c.state === "unknown");
  if (allUnknown) {
    return h("div", { class: "ov-coverage__summary" }, totalChip(), " · coverage could not be read");
  }
  const covered = n("covered");
  const added = n("added");
  const unadded = n("unadded");
  const notoken = n("notoken");
  const unavailable = n("unavailable");
  const unknown = n("unknown");
  const parts: Array<HTMLElement | string> = [
    totalChip(),
    " · ",
    // "protected" was this chip's word for a surface that merely has a downpipe, which is coverage and not
    // health: a paused downpipe, or one whose every run has failed for two months, counted here. The tile
    // below says "In a downpipe", and security-centre/coverage.ts:131 records the rule the chip was breaking
    // ("reusing the word here would overclaim"). The chip now says what the tiles say.
    h("span", { class: "s-ok" }, h("b", String(covered)), " in a downpipe"),
    " · ",
    h("span", { class: "s-amber" }, h("b", String(added)), " added"),
    " · ",
    h("span", { class: "s-un" }, h("b", String(unadded)), " not added"),
  ];
  // AND THE PARTIAL UNKNOWN, which had no part at all. Unknown was named only when EVERY surface was unknown,
  // so a mix of three read and six unread rendered "3 in a downpipe · 0 added · 0 not added": six surfaces
  // nobody checked, presented as two zeros, and "0 not added" reads as no gaps. Every other minority state
  // here already gets its own count; the one that means "we did not check" was the one that did not.
  if (unknown > 0) {
    parts.push(" · ", h("span", { class: "s-muted" }, h("b", String(unknown)), " could not be read"));
  }
  // The no-token count is named before the engine one, because it is the DEFAULT state (account discovery is
  // opt-in) and the actionable one. It used to be counted as "not on this engine", which is how a healthy
  // current estate came to report four surfaces its engine supports as missing from that engine.
  if (notoken > 0) {
    parts.push(" · ", h("span", { class: "s-un" }, h("b", String(notoken)), notoken === 1 ? " needs a discovery token" : " need a discovery token"));
  }
  // Only name "not on this engine" when there is one to name. With a token stored, a current engine offers
  // four of the five token sources (artifacts is held behind the ARTIFACTS_GA beta gate), so this is not
  // silent even on an up-to-date build, and the earlier claim that it would be was wrong.
  if (unavailable > 0) {
    parts.push(" · ", h("span", { class: "s-muted" }, h("b", String(unavailable)), " not on this engine"));
  }
  return h("div", { class: "ov-coverage__summary" }, ...parts);
}

// buildSurfaceCoverageGrid is the Overview hero: the panel header (title + the honest summary chip) and
// the 3x3 grid of surface tiles. Pure given the data, so a poll re-runs it on fresh data. The green/amber
// layer is recomputed every poll from the live downpipe list; the added layer reads the discovery the
// view fetched once and cached (discovery makes live Cloudflare API calls, so it is deliberately NOT on
// the 30s poll).
export function buildSurfaceCoverageGrid(data: OverviewData): HTMLElement {
  const downpipes = data.downpipes.ok && Array.isArray(data.downpipes.value) ? data.downpipes.value : null;
  const cov = surfaceCoverage(downpipes, data.discovery);

  const section = h("section", { class: "ov-coverage", "aria-labelledby": "ov-coverage-h" });
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to, set on an
  // INLINE span around the heading TEXT so the "?" sits beside the words. No behaviour on the real console.
  section.appendChild(
    h(
      "div",
      { class: "ov-coverage__head" },
      h("h2", { id: "ov-coverage-h", class: "ov-coverage__title" }, h("span", { dataset: { tourId: "overview-coverage" } }, "Your Cloudflare account")),
      coverageSummary(cov),
    ),
  );
  const grid = h("div", { class: "ov-coverage-grid" });
  for (const c of cov) grid.appendChild(surfaceTile(c));
  section.appendChild(grid);
  // When the discovery read FAILED, say so under the grid. Without this the hero showed nine mute
  // "Coverage unknown" tiles, which reads like an account with nothing in it rather than a failed
  // Cloudflare read, and the operator had nothing to act on (the usual cause, an expired or
  // under-scoped discovery token, is theirs to fix in one paste).
  const note = discoveryFailureNote(data.discovery);
  if (note !== null) section.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, note));
  return section;
}
