// The Sources screen's "Cloudflare-wide sources" tier: the token-authenticated source types
// (Cloudflare config, Workers, Stream, Images, Artifact Registry) that need no engine binding, the
// read-only discovery token is their credential. Unlike a bound store, these need an explicit add step
// before they appear in the create-downpipe wizard: this tier is where they are added and removed, so
// the wizard offers only added types, the same add-then-protect discipline a bound source has.
//
// Rendered only when the engine records the added set (found.addedSources present) and a discovery
// token is set; an older engine that omits addedSources keeps the legacy ungated wizard and this tier
// stays hidden, so a console talking to an older engine never shows an add it cannot persist. Owner-
// gated: the engine enforces.
//
// Remove is an engine no-op against any downpipe: the engine only records the set the create-downpipe
// wizard OFFERS (POST /sources/enable touches no binding and no running downpipe; see
// scheduler-do-account-config.ts setEnabledSources). A downpipe that already uses the type keeps running
// on its own configuration, untouched, and stays listed. So when one or more downpipes use the type,
// Remove confirms first, naming that true consequence, and the result reports in the neutral tone rather
// than the default success tone (removing a type that still backs a downpipe is not an unqualified win).
import { h, refuseWithReason, svgIcon } from "../../lib/dom.ts";
import { gateReason } from "../common.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { toast } from "../../components/toast.ts";
import { confirmModal } from "../../components/modal.ts";
import { badge } from "../../components/status.ts";
import { TOKEN_SOURCE_TYPES, tokenSourceOffered, tokenSourceLabel, tokenSourceSummary, type TokenSourceType } from "../../lib/token-source.ts";
import { tokenSourceIcon } from "../add-source-glyphs.ts";
import type { EngineClient, SourceDiscovery } from "../../api.ts";
import { errMsg } from "./shared.ts";

// CfWideBacking is which downpipes already use each token-authenticated source type, read by the caller
// (view.ts) off the SAME live downpipe list the rest of the screen uses (never a fresh read at Remove
// time). `known` is false only when that list failed to load, so the Remove confirm can say honestly that
// it could not check, rather than asserting zero.
export interface CfWideBacking {
  byType: ReadonlyMap<TokenSourceType, ReadonlyArray<{ id: string; name: string }>>;
  known: boolean;
}

// joinNames renders a short name list as "A", "A and B", or "A, B and C" (no Oxford comma before "and").
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// removeConsequence builds the Remove confirm's body: what already uses this type (named, when the list
// is short and known), then the true engine consequence: Remove only changes what New downpipe offers;
// it never touches a downpipe already using the type.
function removeConsequence(label: string, downpipes: ReadonlyArray<{ id: string; name: string }>, known: boolean): string {
  const consequence = `Removing hides ${label} from New downpipe.`;
  if (!known) {
    return `Downpipe use could not be checked, so ${label} may still back one. ${consequence} A downpipe already using it keeps running unchanged.`;
  }
  if (downpipes.length === 0) return `No downpipe uses ${label} yet. ${consequence}`;
  const n = downpipes.length;
  const who = n <= 3 ? joinNames(downpipes.map((d) => d.name)) : `${n} downpipes`;
  const verb = n === 1 ? "uses" : "use";
  const keep = n === 1 ? "This downpipe keeps" : "These downpipes keep";
  return `${who} ${verb} ${label} as a source. ${consequence} ${keep} running unchanged.`;
}

// cfWideTier renders the add/remove surface for the five token-authenticated source types. Returns null
// when the engine does not record an added set (older engine -> legacy ungated wizard), when no discovery
// token is set (a token source is read with the token), or when the engine advertises none of the five.
export function cfWideTier(engine: EngineClient, found: SourceDiscovery, refresh: () => void, ownerGate: boolean, backing: CfWideBacking): HTMLElement | null {
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
    const row = cfWideRow(engine, found, t, added.has(t), refresh, ownerGate, () => busy, setBusy, backing);
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
//
// Remove confirms first (the engine call runs no earlier than the confirm's Apply, never on click): the
// module header explains why (Remove is an engine no-op against any downpipe). Add stays one click, as
// before, since adding a type has no consequence for anything that already exists.
function cfWideRow(
  engine: EngineClient,
  found: SourceDiscovery,
  type: TokenSourceType,
  isAdded: boolean,
  refresh: () => void,
  ownerGate: boolean,
  isBusy: () => boolean,
  setBusy: (on: boolean) => void,
  backing: CfWideBacking,
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
  const runToggle = (): void => {
    setBusy(true); // disable every row for the duration so no toggle computes from a stale set
    btn.textContent = isAdded ? "Removing" : "Adding";
    void engine
      .setEnabledSources(desired())
      .then(() => {
        toast(
          isAdded
            ? { message: `${tokenSourceLabel(type)} removed as a source. Downpipes already using it keep running. New downpipe does not offer it.`, tone: "info" }
            : { message: `${tokenSourceLabel(type)} added as a source. Create a downpipe for it from Downpipes.` },
        );
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
  };
  if (ownerGate) {
    btn.addEventListener("click", () => {
      if (isBusy()) return; // another row's add/remove is in flight; its refresh will repaint this row
      if (!isAdded) {
        runToggle();
        return;
      }
      // Remove: confirm first, naming what already uses this type and the true engine consequence.
      // Nothing is sent to the engine until the operator accepts; Cancel calls nothing.
      void confirmModal({
        title: `Remove ${tokenSourceLabel(type)} as a source?`,
        body: removeConsequence(tokenSourceLabel(type), backing.byType.get(type) ?? [], backing.known),
        confirmLabel: "Remove",
        variant: "danger",
      }).then((ok) => {
        if (ok) runToggle();
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
