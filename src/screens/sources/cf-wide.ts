// The Sources screen's "Cloudflare-wide sources" tier: the token-authenticated source types
// (Cloudflare config, Workers, Stream, Images, Artifact Registry) that need no engine binding, the
// read-only discovery token is their credential. Unlike a bound store, these were "always available"
// in the create-downpipe wizard with no add step (the misalignment the owner reported); this tier is
// where they are explicitly ADDED and removed, so the wizard offers only added types, the same
// add-then-protect discipline a bound source has.
//
// Rendered ONLY when the engine records the added set (found.addedSources present) and a discovery
// token is set; an older engine that omits addedSources keeps the legacy ungated wizard and this tier
// stays hidden, so a console talking to an older engine never shows an add it cannot persist. Owner-
// gated (the engine enforces). House: Australian English, no em dashes, precise claims.

import { h, refuseWithReason, svgIcon } from "../../lib/dom.ts";
import { gateReason } from "../common.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { toast } from "../../components/toast.ts";
import { badge } from "../../components/status.ts";
import { TOKEN_SOURCE_TYPES, tokenSourceOffered, tokenSourceLabel, tokenSourceSummary, type TokenSourceType } from "../../lib/token-source.ts";
import { tokenSourceIcon } from "../add-source-glyphs.ts";
import type { EngineClient, SourceDiscovery } from "../../api.ts";
import { errMsg } from "./shared.ts";

// cfWideTier renders the add/remove surface for the five token-authenticated source types. Returns null
// when the engine does not record an added set (older engine -> legacy ungated wizard), when no discovery
// token is set (a token source is read with the token), or when the engine advertises none of the five.
export function cfWideTier(engine: EngineClient, found: SourceDiscovery, refresh: () => void, ownerGate: boolean): HTMLElement | null {
  if (found.addedSources === undefined) return null; // older engine: the wizard stays legacy-ungated, no add surface
  if (!found.tokenPresent) return null; // a token source is read with the discovery token; connect first
  const offered = tokenSourceOffered(found);
  const supported = TOKEN_SOURCE_TYPES.filter((t) => offered[t]);
  if (supported.length === 0) return null; // the deployed engine advertises none of the five
  const added = new Set(found.addedSources);

  const section = h("section");
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the
  // Cloudflare-wide sources), set on an INLINE span around the heading TEXT. No behaviour.
  section.appendChild(h("h3", { class: "section-title" }, h("span", { dataset: { tourId: "sources-cf-wide" } }, "Cloudflare-wide sources")));
  section.appendChild(
    h("p", { class: "field__hint", style: "margin-top:0" },
      "These back up with your read-only discovery token, so they need no engine binding. Add the ones you want to protect; once added, they appear as a source when you create a downpipe."),
  );

  // A tier-level in-flight lock: an Add/Remove writes the FULL desired set computed from THIS render's
  // snapshot, so a second toggle mid-flight would compute from the same stale base and the engine's
  // set-replace would silently drop the first change. Disabling EVERY row's button for the duration (a
  // successful write refreshes the whole tier with a fresh snapshot; a failed one re-enables) makes the
  // writes serialise against one snapshot, so no concurrent toggle is lost.
  const list = h("div", { class: "stack-sm" });
  const buttons: HTMLButtonElement[] = [];
  let busy = false;
  const setBusy = (on: boolean): void => {
    busy = on;
    for (const b of buttons) b.disabled = on;
  };
  for (const t of supported) {
    const row = cfWideRow(engine, found, t, added.has(t), refresh, ownerGate, () => busy, setBusy);
    buttons.push(row.btn);
    list.appendChild(row.el);
  }
  section.appendChild(list);
  return section;
}

// cfWideRow is one token-source row: icon + label + the honest one-line summary, an added/not-added
// badge, and the Add/Remove toggle (owner-gated; the engine enforces). Returns the row element AND its
// button so the tier can serialise writes (see setBusy). The toggle writes the FULL desired set (SET
// semantics) computed from this render's snapshot; the tier-level lock keeps a second toggle from racing it.
function cfWideRow(
  engine: EngineClient,
  found: SourceDiscovery,
  type: TokenSourceType,
  isAdded: boolean,
  refresh: () => void,
  ownerGate: boolean,
  isBusy: () => boolean,
  setBusy: (on: boolean) => void,
): { el: HTMLElement; btn: HTMLButtonElement } {
  const desired = (): string[] => {
    const next = new Set(found.addedSources ?? []);
    if (isAdded) next.delete(type);
    else next.add(type);
    return [...next];
  };
  const label = isAdded ? "Remove" : "Add";
  const btn = (ownerGate
    ? h("button", { "data-dp": "sources.button.cf-wide-row#1", class: isAdded ? "btn btn--ghost btn--sm" : "btn btn--secondary btn--sm", type: "button" }, label)
    : h("button", { "data-dp": "sources.button.cf-wide-row#2", class: "btn btn--secondary btn--sm", type: "button" }, label)) as HTMLButtonElement;
  // The shared refusal primitive: the name stays "Add" or "Remove", which is what the row shows,
  // rather than "Add : Requires the Owner role".
  if (!ownerGate) refuseWithReason(btn, gateReason("owner"));
  if (ownerGate) {
    btn.addEventListener("click", () => {
      if (isBusy()) return; // another row's add/remove is in flight; its refresh will repaint this row
      setBusy(true); // disable every row for the duration so no toggle computes from a stale set
      btn.textContent = isAdded ? "Removing" : "Adding";
      void engine
        .setEnabledSources(desired())
        .then(() => {
          toast({ message: isAdded ? `${tokenSourceLabel(type)} removed as a source.` : `${tokenSourceLabel(type)} added as a source. Create a downpipe for it from Downpipes.` });
          refresh(); // re-reads a fresh snapshot and rebuilds the whole tier (and its buttons)
        })
        .catch((e) => {
          if (isUnauthorised(e)) {
            // PAINT FIRST, THEN LEAVE. setBusy(true) disabled EVERY row for the duration, so a 401 here
            // freezes the whole tier, not just this button. Both come back.
            setBusy(false);
            btn.textContent = label;
            return goSignedOut();
          }
          toast({ message: `Could not update sources. ${errMsg(e)}`, tone: "warn" });
          setBusy(false);
          btn.textContent = label;
        });
    });
  }
  const el = h(
    "div",
    { class: "card", style: "display:flex;align-items:flex-start;gap:var(--space-3);padding:var(--space-3)" },
    h("span", { style: "color:var(--text-muted);flex:none;display:inline-flex;margin-top:1px", "aria-hidden": "true" }, svgIcon(tokenSourceIcon(type), { size: 18 })),
    h(
      "div",
      { style: "flex:1 1 auto;min-width:0" },
      h(
        "div",
        { style: "display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap" },
        h("span", { style: "font-weight:var(--weight-medium)" }, tokenSourceLabel(type)),
        isAdded ? badge("ok", "added") : badge("default", "not added"),
      ),
      h("div", { class: "field__hint", style: "margin-top:1px" }, tokenSourceSummary(type)),
    ),
    h("div", { style: "flex:none" }, btn),
  );
  return { el, btn };
}
