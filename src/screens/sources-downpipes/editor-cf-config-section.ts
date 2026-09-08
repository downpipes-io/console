// Cloudflare configuration (cf-config) source controls for the upsert editor, split out of
// ./editor-upsert.ts (move-only). See ./editor.ts for the barrel.
//
// cf-config is authenticated by the engine's read-only DISCOVERY token (not a per-downpipe key, not a
// Workers binding), and what it backs up is a set of config SURFACES for one account (and optionally one
// zone). The account/zone identity is fixed for the downpipe's life; only the surface selection is
// editable. Empty source.include means "all surfaces", held as a null sentinel until the catalogue
// loads, then expanded to every visible id so the checkboxes mirror reality.

import { cfSurfaceListThrowClass, recordCatalogueDegraded } from "../../lib/client-diag/ring.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import type { EngineClient, Downpipe } from "../../api.ts";
import type { EditorPrefill } from "./editor-types.ts";

// buildCfConfigSection builds the cf-config block (mode select + surface picker) and loads the
// surface catalogue from the engine. It is a self-contained closure exposing the fixed identity
// (accountId / zoneId) and getInclude(): the wire `include` (preserving "[] = all" when every
// visible surface is ticked, and the saved/prefill selection when the catalogue never loaded) plus
// the capture mode. isCfConfig gates the block's initial visibility and the async catalogue load.
export function buildCfConfigSection(
  engine: EngineClient,
  existing: Downpipe | null,
  prefill: EditorPrefill | undefined,
  isCfConfig: boolean,
): {
  el: HTMLElement;
  accountId: string | null;
  zoneId: string | null;
  getInclude: () => string[];
  getMode: () => "auto" | "manual";
} {
  // Identity (account/zone/surfaces) comes from the existing downpipe when editing; on a CREATE reached
  // from the "Add a source" / wizard hand-off it comes from the prefill, so the account/zone the operator
  // already chose survives the jump into this editor instead of being dropped (the engine would otherwise
  // 400 a token source that carried no account, with no UI recovery).
  const cfZoneId = existing?.source.zoneId ?? prefill?.zoneId ?? null;
  const cfAccountId = existing?.source.accountId ?? prefill?.accountId ?? null;
  const cfScope: "all" | "account" = cfZoneId === null ? "account" : "all";
  const cfPrefillSurfaces = prefill?.surfaces && prefill.surfaces.length > 0 ? prefill.surfaces : null;
  let cfSurfaces: Set<string> | null =
    existing?.source.include && existing.source.include.length > 0
      ? new Set(existing.source.include)
      : cfPrefillSurfaces !== null
        ? new Set(cfPrefillSurfaces)
        : null;
  // Capture mode: AUTO (default) backs up the surfaces in USE, discovered automatically and refreshed
  // daily, so a run reads only what exists (not one GET per surface in the whole registry); MANUAL captures the
  // operator's ticked surfaces below. The surface picker is only meaningful in manual mode.
  // Effective mode mirrors the engine's resolveCfConfigMode: explicit wins; for a pre-feature downpipe
  // an existing non-empty include is an explicit pick -> manual, an empty include (= all) -> auto.
  let cfMode: "auto" | "manual" = existing?.source.cfConfigMode ?? ((existing?.source.include?.length ?? 0) > 0 ? "manual" : "auto");

  const cfAutoNote = h(
    "p",
    { class: "field__hint", style: "margin:0" },
    "Auto backs up the configuration surfaces in use, discovered automatically and refreshed daily, so a run reads only what exists. Switch to Manual to pick exact surfaces.",
  );
  const cfModeSel = h(
    "select",
    { "data-dp": "sources-downpipes.select.cf-mode-sel", class: "field__select", "aria-label": "Cloudflare config capture mode" },
    h("option", { value: "auto" }, "Auto: capture surfaces in use (recommended)"),
    h("option", { value: "manual" }, "Manual: pick exact surfaces"),
  ) as HTMLSelectElement;
  cfModeSel.value = cfMode;
  // inBand is carried through from the engine catalogue. Without it this picker showed all 313 surfaces
  // identically, so nothing on screen distinguished the ones a restore actually re-applies from the ones
  // the customer has to re-apply themselves. That is the single most over-claimable number in the
  // product, and the picker is where a customer forms their expectation of it.
  //
  // `available` is the other half of that split and was being dropped here: the engine sends it, the
  // API type declares it, and this mapping read only inBand, so a surface whose write path exists but
  // has never been proven looked exactly like one with no write path at all. Both are off by default,
  // which is why dropping it was safe rather than an over-claim, but they are not the same thing to an
  // operator deciding whether to name one: naming an available surface puts it in the restore scope and
  // binds it into the approval hash, and naming a surface with no writer does nothing.
  let cfCatalogue: Array<{ id: string; label: string; category: string; scope: "zone" | "account"; inBand: boolean; available: boolean }> = [];
  let cfCatalogueLoaded = false;
  const cfVisible = (): Array<{ id: string; label: string; category: string; inBand: boolean; available: boolean }> =>
    cfScope === "account" ? cfCatalogue.filter((s) => s.scope === "account") : cfCatalogue;
  // data-dp so a harness journey can assert the split sentence by hook rather than by guessing at a
  // class shared with every other hint on the screen.
  const cfSummary = h("p", { "data-dp": "sources-downpipes.text.cf-surface-summary", class: "field__hint", style: "margin:0" });
  const cfPanel = h("div", { class: "stack-xs" });
  // cfScopePresetRow is a fast shortcut ABOVE the per-category manual picker, ZONE-scoped downpipes
  // only (an account-wide downpipe has no zone/account distinction to shortcut: it only ever offers
  // account surfaces). "This zone only" ticks exactly the catalogue's scope:"zone" ids (unticking
  // every account one, so this downpipe stops duplicating the account config the source-granularity
  // audit found); "Account + this zone" ticks every visible surface (mirrors the existing "All"
  // button below). Either tap switches to Manual (an explicit preset IS a manual choice) and
  // re-renders the picker so its checkboxes reflect the new selection. Same two labels as the
  // create wizard's scope preset (editor-wizard-source-rows.ts) so the concept reads identically in
  // both places; "Account configuration only" has no equivalent here because an existing
  // downpipe's identity (zone vs account) is fixed for its life, only the surface selection is
  // editable (see the module comment above).
  const cfScopePresetRow = h("p", { class: "field__hint", style: "margin:0", hidden: cfZoneId === null });
  const applyCfScopePreset = (zoneOnly: boolean): void => {
    if (!cfCatalogueLoaded) return;
    cfSurfaces = new Set((zoneOnly ? cfCatalogue.filter((s) => s.scope === "zone") : cfVisible()).map((s) => s.id));
    cfMode = "manual";
    cfModeSel.value = "manual";
    applyCfMode();
    renderCfSurfaces();
  };
  if (cfZoneId !== null) {
    cfScopePresetRow.replaceChildren(
      "Scope shortcuts: ",
      h("button", { "data-dp": "sources-downpipes.button.apply-cf-scope-preset-true", class: "linklike", type: "button", on: { click: () => applyCfScopePreset(true) } }, "This zone only"),
      " · ",
      h("button", { "data-dp": "sources-downpipes.button.apply-cf-scope-preset-false", class: "linklike", type: "button", on: { click: () => applyCfScopePreset(false) } }, "Account + this zone"),
      ".",
    );
  }
  const el = h(
    "div",
    { class: "field", hidden: !isCfConfig },
    h("span", { class: "field__label" }, "Cloudflare configuration to back up"),
    h(
      "p",
      { class: "field__hint", style: "margin:0" },
      cfZoneId !== null
        ? `Zone configuration (zone ${cfZoneId}).`
        : "Account-wide configuration (account settings, Zero Trust, notifications, rulesets).",
      " Authenticated by your read-only discovery token, no per-downpipe key. For full per-zone coverage, widen that token to the ",
      h("b", "Read all resources"),
      " template under Sources.",
    ),
    cfModeSel,
    cfAutoNote,
    cfScopePresetRow,
    cfSummary,
    cfPanel,
    // Group-level doc link (audit G2): the capture-mode select and the per-surface tickboxes are one
    // cf-config control, so the link explaining what configuration is captured lives on the group.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/operations/cloudflare-config-backup-restore#what-cf-config-captures", target: "_blank", rel: "noreferrer noopener" },
      "About Cloudflare config capture",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/operations/cloudflare-config-backup-restore#choosing-what-to-capture-mode-and-scope", target: "_blank", rel: "noreferrer noopener" },
      "About capture mode and scope",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  // applyCfMode shows the surface picker only in manual mode (in auto, discovery decides what is captured).
  const applyCfMode = (): void => {
    const manual = cfMode === "manual";
    cfAutoNote.hidden = manual;
    cfSummary.hidden = !manual;
    cfPanel.hidden = !manual;
  };
  cfModeSel.addEventListener("change", () => {
    cfMode = cfModeSel.value === "manual" ? "manual" : "auto";
    applyCfMode();
  });
  applyCfMode();
  const renderCfSurfaces = (): void => {
    const sel = cfSurfaces;
    if (!cfCatalogueLoaded || sel === null) return;
    const visible = cfVisible();
    const byCat = new Map<string, Array<{ id: string; label: string; inBand: boolean; available: boolean }>>();
    for (const s of visible) {
      const arr = byCat.get(s.category) ?? [];
      arr.push({ id: s.id, label: s.label, inBand: s.inBand, available: s.available });
      byCat.set(s.category, arr);
    }
    // The in-band figure is counted over the SELECTED set, not the whole catalogue, because that is the
    // number that describes what this downpipe will actually re-apply. Counting it over the catalogue
    // would keep saying 19 after a customer unticked all 19.
    const inBandSelected = (): number => visible.filter((s) => s.inBand && sel.has(s.id)).length;
    const summarise = (): void => {
      const n = inBandSelected();
      cfSummary.textContent =
        `Backing up ${sel.size} of ${visible.length} configuration surfaces, untick any you don't want. ` +
        `${n} of the ${sel.size} re-apply in console on a restore; the rest are captured and verified for you to re-apply yourself.`;
    };
    const groups: HTMLElement[] = [];
    for (const [cat, items] of byCat) {
      const boxes: HTMLInputElement[] = [];
      const summary = h("summary");
      const setSummary = (): void => {
        summary.textContent = `${cat}, ${items.filter((i) => sel.has(i.id)).length}/${items.length}`;
      };
      const rows = items.map((it) => {
        const id = `edit-surf-${it.id}`;
        const cb = h("input", { type: "checkbox", id, ...(sel.has(it.id) ? { checked: true } : {}) }) as HTMLInputElement;
        boxes.push(cb);
        cb.addEventListener("change", () => {
          if (cb.checked) sel.add(it.id);
          else sel.delete(it.id);
          setSummary();
          summarise();
        });
        const label = h("label", { for: id }, it.label);
        // The two badges are mutually exclusive by construction in the engine catalogue, and the parity
        // gate asserts that, so this reads inBand first rather than treating the pair as independent.
        // The wording is deliberately not symmetrical: "restores in console" is a promise, and the
        // second badge is an availability note. Calling it something like "restores when named" would
        // make it sound like the same promise with an extra step, when the difference is that the first
        // is proven against a real account and the second is not.
        if (it.inBand) label.appendChild(h("span", { class: "badge badge--info", style: "margin-inline-start:var(--space-2)" }, "restores in console"));
        else if (it.available)
          label.appendChild(
            h(
              "span",
              {
                class: "badge badge--warn",
                style: "margin-inline-start:var(--space-2)",
                title: "A write path exists but has not been proven against a real Cloudflare account, so it is off by default. It runs only if you name this surface and an approver signs a plan that includes it.",
              },
              "write path not proven",
            ),
          );
        return h("div", { class: "checkbox-row" }, cb, label);
      });
      const setAll = (on: boolean): void => {
        items.forEach((it, k) => {
          boxes[k]!.checked = on;
          if (on) sel.add(it.id);
          else sel.delete(it.id);
        });
        setSummary();
        summarise();
      };
      const allNone = h(
        "p",
        { class: "field__hint", style: "margin:0" },
        h("button", { "data-dp": "sources-downpipes.button.set-all-true", class: "linklike", type: "button", on: { click: () => setAll(true) } }, "All"),
        " · ",
        h("button", { "data-dp": "sources-downpipes.button.set-all-false", class: "linklike", type: "button", on: { click: () => setAll(false) } }, "None"),
      );
      setSummary();
      groups.push(h("details", { class: "source-list__details" }, summary, h("div", { class: "stack-xs", style: "padding-left:var(--space-3)" }, allNone, ...rows)));
    }
    summarise();
    cfPanel.replaceChildren(...groups);
  };
  if (isCfConfig) {
    cfSummary.textContent = "Loading configuration surfaces…";
    void engine
      .discoverSources()
      .then((found) => {
        // Both flags default to false on a missing field, for the reason the API type gives: an older
        // engine sends neither, and "absent" must read as "makes no promise", never as "assume it does".
        cfCatalogue = (found.cfConfigSurfaces ?? []).map((s) => ({ id: s.id, label: s.label, category: s.category, scope: s.scope, inBand: s.inBand === true, available: s.available === true }));
        cfCatalogueLoaded = true;
        if (cfSurfaces === null) cfSurfaces = new Set(cfVisible().map((s) => s.id));
        if (cfCatalogue.length === 0) {
          // G243: the EDITOR re-read the catalogue and got nothing back, on a downpipe that is ALREADY backing up
          // cf-config. The saved selection is preserved (correctly), so the screen looks calm, and nothing said why
          // the list is not there. TWO STATES ARRIVE HERE AND THEY ARE NOT THE SAME FAULT, so only one of them is
          // recorded, on exactly the gate the wizard's twin applies (cfWithheldCatalogueClass,
          // editor-wizard-source-sections.ts): this is the SECOND producer of cf-catalogue-empty and it was left
          // ungated when the first was fixed.
          //
          //   tokenPresent === true   the engine WALKED THE TOKEN PATH and still returned no catalogue. The
          //                           catalogue is a static compiled-in list on that path, so a rescoped, expired
          //                           or revoked token cannot empty it, and the one fact established is that this
          //                           engine predates cf-config. Record it: the remedy is to update the engine.
          //   anything else           NO DISCOVERY TOKEN IS SET (the owner cleared it, or never pasted one), or the
          //                           engine is too old to report tokenPresent at all. In neither case did the
          //                           engine walk the token path, so nothing about the catalogue was established
          //                           and a cf-catalogue-empty row would tell support to update a healthy, current
          //                           engine. Record NOTHING here: the engine files its own no-token discovery
          //                           observation server-side (recordDiscoveryHealth, tokenPresent false), an
          //                           engine too old to report the field is token-source-tier skew which
          //                           tokenSourceSkewFamilies already carries, and the sentence below tells the
          //                           operator which of the two they are looking at.
          const tokenStored = found.tokenPresent === true;
          if (tokenStored) recordCatalogueDegraded("cf-catalogue-empty");
          cfSummary.textContent = tokenStored
            ? "Your saved surface selection is preserved. This engine returned no surface catalogue, so it predates Cloudflare configuration backup: update the engine to re-pick surfaces here."
            : "Your saved surface selection is preserved. No discovery token is stored, so the surface catalogue was not read. Paste a discovery token under Sources to re-pick surfaces here.";
          return;
        }
        renderCfSurfaces();
      })
      .catch((err) => {
        // G243: the surface list did not load, so the operator is re-picking surfaces against a list that is not
        // there. A swallowed read with a calm sentence under it, and nothing anywhere said it happened.
        //
        // IT IS CLASSIFIED, and until now it was not. This catch wrote cf-surface-list-unreadable on EVERY throw,
        // and the Rediscover button next door (detail-config-section.ts) has classified its own throw for a round:
        // seven states shared this one row, and two of them are not faults at all. A LAPSED CLOUDFLARE ACCESS
        // SESSION is the commonest editor open there is (a tab left open overnight, and this console is
        // Access-fenced) and it wrote a fault row against a healthy engine and a healthy token, on the very screen
        // whose remedy is "go and look at your discovery token". It now records nothing, and neither does a 401,
        // which signs the operator out here exactly as it does everywhere else. The five that remain are five
        // different phone calls: the address, the role, an edge refusal, a rate limit, a dropped call.
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: this line reads "Loading configuration surfaces…" and nothing else
          // was going to replace it, so the editor would sit on a load that had stopped.
          cfSummary.textContent = "Your session ended before the surface list loaded. Your saved selection is preserved on save.";
          return goSignedOut();
        }
        const thrown = cfSurfaceListThrowClass(err);
        if (thrown !== null) recordCatalogueDegraded(thrown);
        cfSummary.textContent = "Could not load the surface list; your saved selection is preserved on save.";
      });
  }

  return {
    el,
    accountId: cfAccountId,
    zoneId: cfZoneId,
    getMode: () => cfMode,
    // Preserve "[] = all" when every visible surface is ticked. If the catalogue never loaded (discover
    // failed, or the engine returned none), keep the chosen include (the existing one when editing, the
    // prefill surfaces on a hand-off create) so editing the schedule or retention can never silently
    // narrow what is captured.
    getInclude: () => {
      if (!cfCatalogueLoaded || cfSurfaces === null) return existing?.source.include ?? cfPrefillSurfaces ?? [];
      return cfSurfaces.size >= cfVisible().length ? [] : [...cfSurfaces];
    },
  };
}
