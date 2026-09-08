// The Sources screen body: the load -> discover -> render lifecycle, the bounded
// wait-for-the-deploy poll handle, and renderCatalogue (the whole three-tier surface
// built from one discovery result). Moved verbatim from the screen coordinator for
// size; it imports the shared leaf, the connect-first token card, the add-source body
// and the on-engine + account tiers. The coordinator's descriptor calls renderSources.
//
// One question: what in your Cloudflare account is protected, and what is not yet?
//
// The screen answers it in three honest tiers:
//   1. Protected, attached to the engine AND covered by a downpipe.
//   2. Attached, not yet protected, bound to the engine; one tick and a shared
//      schedule away from protection (the bulk create lives here).
//   3. Across your accounts, everything that exists, listed via the owner's own
//      READ-ONLY API token (DO-stored, verified live, audited, never re-shown).
//      The engine's account gets the attach flow (generated stanzas + a bounded
//      wait-for-the-deploy poll); other accounts list names read-only with the
//      honest boundary: bindings cannot cross accounts.
//
// Until the token is set (and nothing is bound), the screen IS the connect form: the
// very first thing a fresh deployment asks for, because every later step reads through
// it. Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { pageHeader, canDo, canCap, collapsedSection, openDisclosureByTitle } from "../common.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { ICON_PLUS } from "../../lib/icons.ts";
import type { EngineClient, SourceDiscovery } from "../../api.ts";
import { type ProtectType, type MissingSource, type PollHooks, type ProtectedSourceRow, protectedSourceTable } from "./shared.ts";
import { connectCard } from "./token-entry.ts";
import { openAddSourceWizard } from "./add-source.ts";
import { driftTier, attachedTier } from "./tiers.ts";
import { accountTier } from "./account.ts";
import { cfWideTier } from "./cf-wide.ts";

// tagDisclosureHeading wraps a collapsedSection's heading TEXT in an inline span carrying the public tour's
// inert data-tour-id, so the "?" info-point pins beside the heading words (a content-sized box), not at the page
// edge (a block heading would put its right edge at the full row width). It is a tour-only hook with no
// behaviour and no effect on the genuine console; it leaves the heading's accessible text unchanged.
function tagDisclosureHeading(section: HTMLElement, id: string): void {
  const heading = section.querySelector(".disclosure__heading") as HTMLElement | null;
  if (!heading) return;
  const text = heading.textContent ?? "";
  heading.textContent = "";
  heading.appendChild(h("span", { dataset: { tourId: id } }, text));
}

// renderSources builds the screen root: the page header, the async region, and the
// load() that discovers sources + lists downpipes, derives the drift set, and renders
// the catalogue. A single poll handle means a regenerated stanza never stacks a second
// poller, and navigation away stops it (the interval dies with the detached DOM check).
export function renderSources(eng: EngineClient): HTMLElement {
  const root = h("div");

  // The header add-action (add-action consistency with Downpipes and Destinations): the one
  // primary that OPENS THE PICKER WIZARD DIRECTLY, no disclosure doorway in between. The wizard
  // needs the live discovery result, so the open handler is late-bound by each render (null until
  // a token-present catalogue is up); on the connect-first state it lands on the region's first
  // field (the token form) instead. data-tour-id: the public tour's Sources beat spotlights this
  // button (the add action IS the story there).
  const addBtn = h(
    "button",
    { "data-dp": "sources.button.add",
      class: "btn btn--primary btn--sm",
      type: "button",
      dataset: { tourId: "sources-add" },
      on: { click: () => { if (openAdd) openAdd(); else openDisclosureByTitle(region, "Add a source"); } },
    },
    svgIcon(ICON_PLUS, { size: 14 }),
    "Add a source",
  );
  let openAdd: (() => void) | null = null;
  root.appendChild(
    pageHeader(
      "Sources",
      "Everything your account holds, and how much of it is protected. Connect your account once; after that, picking what to back up is ticking boxes.",
      addBtn,
    ),
  );

  const region = h("div", { class: "async-region" });
  root.appendChild(h("h2", { class: "visually-hidden" }, "Source catalogue"));
  root.appendChild(region);

  // One poll handle so a regenerated stanza never stacks a second poller, and
  // navigation away stops it (the interval dies with the detached DOM check).
  let waitPoll: number | null = null;
  const stopWaitPoll = (): void => {
    if (waitPoll !== null) {
      clearInterval(waitPoll);
      waitPoll = null;
    }
  };

  const load = (): void => {
    stopWaitPoll();
    openAdd = null; // re-bound by a token-present catalogue render below
    region.replaceChildren(skeletonRows(5));
    void Promise.allSettled([eng.discoverSources(), eng.listDownpipes()])
      .then((results) => {
        const discRes = results[0];
        const listRes = results[1];
        if (discRes.status === "rejected") {
          const err = discRes.reason;
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: the source catalogue is a skeleton until this replaces it.
            region.replaceChildren(sessionEnded(() => load()));
            return goSignedOut();
          }
          region.replaceChildren(blockError(err, () => load(), { origin: location.origin }));
          return;
        }
        const found = discRes.value;
        const piped = new Set<string>();
        // Each configured source binding -> its type and the downpipe(s) that depend on it,
        // so a binding the engine no longer exposes can be shown as an error against the
        // downpipes it breaks (not silently dropped, the way a LIVE-only listing would).
        // covers keeps the id + name pairs so the Protected table can link each binding to
        // the downpipe that covers it (downpipes keeps the name set for the drift rows).
        const configured = new Map<string, { type: ProtectType; downpipes: Set<string>; covers: Array<{ id: string; name: string }> }>();
        const note = (binding: string, type: ProtectType, dp: { id: string; name: string }): void => {
          piped.add(binding);
          const e = configured.get(binding) ?? { type, downpipes: new Set<string>(), covers: [] };
          e.downpipes.add(dp.name);
          if (!e.covers.some((c) => c.id === dp.id)) e.covers.push(dp);
          configured.set(binding, e);
        };
        // listDownpipes can fail independently of discoverSources. When it does, the
        // configured/piped maps stay empty, so a bound source would otherwise read as
        // 'Attached, not yet protected' even when a downpipe protects it. Surface that the
        // coverage read is incomplete rather than showing a confidently wrong status.
        const coverageIncomplete = listRes.status === "rejected";
        if (listRes.status === "fulfilled") {
          for (const st of listRes.value) {
            const src = st.config.source;
            const dp = { id: st.config.id, name: st.config.name || st.config.id };
            if ((src.type === "kv" || src.type === "r2" || src.type === "d1") && typeof src.binding === "string" && src.binding !== "") {
              note(src.binding, src.type, dp);
            }
            for (const sec of src.secrets ?? []) note(sec.binding, "secrets", dp);
          }
        }
        // Drift: a configured source whose backing binding is not present in the deployed
        // engine. These are exactly the bindings buildAdapter throws "source binding error"
        // on at run time; the listing now shows them FIRST, in an error state.
        const boundNames = new Set<string>([...found.bound.kv, ...found.bound.r2, ...found.bound.d1, ...found.bound.secrets]);
        const missing: MissingSource[] = [...configured.entries()]
          .filter(([binding]) => !boundNames.has(binding))
          .map(([binding, e]) => ({ binding, type: e.type, downpipes: [...e.downpipes].sort() }))
          .sort((a, b) => a.binding.localeCompare(b.binding));
        // binding -> the covering downpipe(s), for the Protected table's Downpipe column.
        const covered = new Map<string, Array<{ id: string; name: string }>>([...configured.entries()].map(([binding, e]) => [binding, e.covers]));
        region.replaceChildren(renderCatalogue(eng, { found, piped, missing, covered }, load, { setWaitPoll: (id) => { stopWaitPoll(); waitPoll = id; }, stopWaitPoll, setOpenAdd: (fn) => { openAdd = fn; } }, coverageIncomplete));
      });
  };
  load();

  return root;
}

// coverageWarning is the inline banner shown when listDownpipes could not be loaded: the
// protection status derived from the downpipe list is then incomplete, so a bound source may
// read 'not yet protected' even when a downpipe protects it. Stated honestly rather than shown
// as a confident, wrong status.
function coverageWarning(): HTMLElement {
  return h(
    "div",
    { class: "card card--warn", role: "status", style: "padding:var(--space-3)" },
    h("p", { class: "field__hint", style: "margin:0;color:var(--text)" }, "Downpipe coverage could not be loaded, so the protection status below may be incomplete. A bound source can read as not yet protected even if a downpipe protects it. Reload to try again."),
  );
}

// protectedSection renders the 'Protected' tier: bound sources that a downpipe covers, as a
// row table (matching the /downpipes layout) so the covered fleet reads as an orderly,
// sortable, filterable table rather than a ragged list. Kept prominent (the owner's 'the
// attached sources are hidden' feedback), never a bare collapsed count. Returns null when
// nothing is protected so the caller appends nothing.
function protectedSection(protectedOnes: ProtectedSourceRow[]): HTMLElement | null {
  if (protectedOnes.length === 0) return null;
  const sec = h("section");
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the protected
  // tier), set on an INLINE span wrapping the heading TEXT so the "?" sits beside the words. No behaviour.
  sec.appendChild(h("h3", { class: "section-title" }, h("span", { dataset: { tourId: "sources-protected" } }, `Protected (${protectedOnes.length})`)));
  sec.appendChild(h("p", { class: "field__hint", style: "margin-top:0" }, "Attached to the engine and covered by a downpipe. Activate a row to manage it in Downpipes."));
  sec.appendChild(protectedSourceTable(protectedOnes));
  return sec;
}

// renderCatalogue builds the whole three-tier surface from one discovery result.
// refresh re-runs the screen load, so every configuration change (token saved,
// accounts chosen, deploy detected) comes back through one path and the listing
// is never stale after a change. coverageIncomplete is set when listDownpipes failed,
// so the protection status shown may be incomplete (a visible warning is rendered).
interface CatalogueContext {
  found: SourceDiscovery;
  piped: ReadonlySet<string>;
  missing: readonly MissingSource[];
  // binding -> the covering downpipe(s) (id + name), read by the Protected table so each
  // row can link to the downpipe that covers it.
  covered: ReadonlyMap<string, Array<{ id: string; name: string }>>;
}

function renderCatalogue(engine: EngineClient, ctx: CatalogueContext, refresh: () => void, polls: PollHooks, coverageIncomplete: boolean): HTMLElement {
  const { found, piped, missing, covered } = ctx;
  const wrap = h("div", { class: "screen-stack" });
  const ownerGate = canDo("owner");
  // Protecting or re-attaching a source upserts a downpipe (downpipe.write on the engine), so gate
  // those actions on that capability rather than the operator ladder rank a custom role sits below.
  const opGate = canCap("downpipe.write");

  const boundAll = [
    ...found.bound.kv.map((n) => ({ name: n, type: "kv" as ProtectType })),
    ...found.bound.r2.map((n) => ({ name: n, type: "r2" as ProtectType })),
    ...found.bound.d1.map((n) => ({ name: n, type: "d1" as ProtectType })),
    // Secrets Store bindings are first-class here too: protected ones list in the Protected table,
    // unprotected ones in the bulk-protect tier (where a ticked set bundles into one Secrets downpipe).
    ...found.bound.secrets.map((n) => ({ name: n, type: "secrets" as ProtectType })),
  ];
  const protectedOnes: ProtectedSourceRow[] = boundAll
    .filter((b) => piped.has(b.name))
    .map((b) => ({ ...b, coveredBy: covered.get(b.name) ?? [] }));
  const attachable = boundAll.filter((b) => !piped.has(b.name));

  // ---- needs attention: configured sources the engine no longer exposes -> show FIRST so a
  // dropped binding is seen the moment the screen loads, even before the connect form ----
  const driftSection = missing.length > 0 ? driftTier(engine, missing, found, { refresh, ownerGate, opGate }) : null;

  // ---- the connect-first state: no token, nothing bound -> the screen IS the form ----
  // (boundAll includes the Secrets Store bindings, so "nothing bound" covers all four kinds.)
  if (!found.tokenPresent && boundAll.length === 0) {
    if (driftSection) wrap.appendChild(driftSection);
    wrap.appendChild(connectCard(engine, ownerGate, refresh));
    return wrap;
  }

  // The coverage warning rides above every tier so an incomplete protection read is seen first.
  if (coverageIncomplete) wrap.appendChild(coverageWarning());

  if (driftSection) wrap.appendChild(driftSection);

  // ---- Add a source, ABOVE the growing lists, matching "Add a destination" on Destinations
  // (a collapsedSection add-action over the cards). Action buttons stay above lists that grow.
  // Only when a discovery token is present (the wizard needs it); the no-token path below keeps
  // the connect form prominent instead. ----
  // Wire the header's "+ Add a source" primary straight to the picker wizard (add-action
  // consistency: one primary, no disclosure doorway). Only when a discovery token is present
  // (the wizard needs it); the no-token path keeps the connect form as the landing surface.
  if (found.tokenPresent) {
    polls.setOpenAdd?.(() => openAddSourceWizard(engine, found, refresh, ownerGate));
  }

  // ---- your sources: attached + protected, surfaced prominently ----
  const protectedTier = protectedSection(protectedOnes);
  if (protectedTier) wrap.appendChild(protectedTier);

  // attached, not yet protected (the bulk-protect tier), also kept prominent. When
  // nothing waits, the tier is one quiet note; anchor it inside the Protected panel
  // as a footer row rather than floating it between sections.
  const attachedSection = attachedTier(engine, attachable, found, { refresh, opGate, ownerGate });
  if (attachable.length === 0 && protectedTier) protectedTier.appendChild(attachedSection);
  else wrap.appendChild(attachedSection);

  // Cloudflare-wide sources (token-authenticated: config / Workers / Stream / Images / Artifacts):
  // the add/remove surface so they are explicitly added before the create-downpipe wizard offers them
  // (it gates on this set). Null on an older engine that does not record the added set (legacy ungated).
  const cfWide = cfWideTier(engine, found, refresh, ownerGate);
  if (cfWide) wrap.appendChild(cfWide);

  // Secrets Store bindings need no separate note here: protected ones list in the Protected
  // table, unprotected ones in the bulk-protect tier (bundling into one Secrets downpipe), and
  // the add-source wizard offers Secrets Store as a type, the same paths as every other store.

  // ---- adding more: the guided wizard is the primary path; the full multi-account
  // catalogue and token management fold behind one disclosure so nothing sits open on
  // load (owner feedback: no walls of open lists, no loose token box). ----
  if (found.tokenPresent) {
    // The add-source action now lives ABOVE the lists (top of renderCatalogue); here only the
    // full multi-account catalogue + token management fold behind one disclosure. data-tour-id is an inert hook
    // the public page-walkthrough tour pins a "?" info-point to (the full account catalogue). No behaviour.
    const catalogueSection = collapsedSection(
      "Browse the full catalogue and manage your connected account",
      accountTier(engine, found, piped, refresh, ownerGate, polls),
    );
    tagDisclosureHeading(catalogueSection, "sources-catalogue");
    wrap.appendChild(catalogueSection);
  } else {
    // No discovery token yet (but something is bound): the connect/enable form is the
    // next step, so keep it prominent rather than behind a disclosure.
    wrap.appendChild(accountTier(engine, found, piped, refresh, ownerGate, polls));
  }

  return wrap;
}
