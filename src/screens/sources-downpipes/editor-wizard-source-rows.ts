// Source-step row construction for the guided create wizard, split out of ./editor-wizard.ts.
// See ./editor.ts for the barrel.
//
// buildSourceList builds the wizard's source-step list from one discoverSources() result: the
// already-attached KV/R2/D1 rows plus the token-authenticated Cloudflare sections (configuration,
// Workers, Stream, Images, Artifact Registry). Every row's pick side-effect is factored into an
// apply() closure shared by the row's change listener and the token-source hand-off auto-select, so
// the two paths run identical logic with no synthetic DOM event. The logic is the verbatim body of
// the wizard's old discoverSources().then(found => ...); only the shared mutable state, DOM and
// helpers it touches are passed in via WizardSourceCtx so it can live in its own module.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import type { SourceInput } from "../../lib/add-source.ts";
import type { TokenSourceType } from "../../lib/token-source.ts";
import { navigate } from "../../lib/nav.ts";
import { badge } from "../../components/status.ts";
import { pickIcon, selectableSourceList } from "../sources/shared.ts";
import { infoTip } from "../../components/info-tip.ts";
import type { EngineClient, SourceDiscovery, StatusReport } from "../../api.ts";
import { WORKERS_RESTORE_NOTE, STREAM_RESTORE_NOTE, IMAGES_RESTORE_NOTE, ARTIFACTS_RESTORE_NOTE, ICON_CFCONFIG } from "./helpers.ts";
import type { EditorPrefill, WizType } from "./editor-types.ts";
import { openEditor } from "./editor-upsert.ts";
import { appendSourceSections } from "./editor-wizard-source-sections.ts";
import { defaultCfScopePreset, type CfScopePreset } from "./bulk-assemble.ts";

// WizardState holds the wizard's chosen-* selection that the row apply() closures mutate and read.
// It is the wizard's own mutable state object (a single object so the row module and the wizard
// share one reference, the move-only equivalent of the previous closed-over `let` variables).
// Two selection families coexist, MUTUALLY EXCLUSIVE (ticking one clears the other):
//   - chosenMulti / chosenSecretsMulti / chosenCfZones / chosenCfAccounts: the CHECKBOX selection.
//     Each kv/r2/d1 binding in chosenMulti becomes its own downpipe; the secrets bindings in
//     chosenSecretsMulti bundle into ONE Secrets downpipe; each ticked zone/account in
//     chosenCfZones/chosenCfAccounts becomes its own cf-config downpipe (surfaces per
//     cfScopePreset). This is the many-to-many create (the source-granularity audit added the
//     cf-config leg: N zones ticked bulk-create N downpipes in one pass, not N wizard runs).
//   - the chosen* scalars: the RADIO pick of a token-authenticated Cloudflare-wide source
//     (workers / stream / images / artifacts), one downpipe with per-pick config.
export interface WizardState {
  chosenBinding: string | null;
  chosenType: WizType | null;
  chosenInput: SourceInput | null;
  chosenAccountId: string | null;
  chosenWorkersAccountId: string | null;
  chosenStreamAccountId: string | null;
  chosenImagesAccountId: string | null;
  chosenArtifactsAccountId: string | null;
  cfCatalogue: Array<{ id: string; label: string; category: string; scope: "zone" | "account"; inBand: boolean }>;
  chosenMulti: Map<string, "kv" | "r2" | "d1">;
  chosenSecretsMulti: Set<string>;
  // cfScopePreset is the operator's choice of what a ticked ZONE's downpipe captures (account-only
  // never ticks a zone, so the preset is moot for it): null = not yet defaulted, defaulted once by
  // defaultCfScopePreset the first time the cf-config section renders with a known zone count, then
  // sticky across Back/Continue (see ./bulk-assemble.ts).
  cfScopePreset: CfScopePreset | null;
  // chosenCfZones / chosenCfAccounts are the tick-many cf-config selection: each ticked zone (keyed
  // by zoneId, globally unique) or account becomes its own downpipe. cfMultiAccount says whether
  // more than one Cloudflare account was DISCOVERED (not ticked), so an account downpipe's name
  // matches its row's own label ("Account-wide configuration" vs "<name> configuration").
  chosenCfZones: Map<string, { accountId: string; zoneName: string }>;
  chosenCfAccounts: Map<string, string>;
  cfMultiAccount: boolean;
}

// WizardSourceCtx is the surface the source-row builder needs from the wizard: the shared state, the
// shared DOM the apply() closures toggle, the shared helpers, the "Use the advanced editor" hand-off
// inputs, and the token-source pre-selection. Everything here was an outer-scope binding before.
export interface WizardSourceCtx {
  engine: EngineClient;
  status: StatusReport | null;
  piped: ReadonlySet<string>;
  state: WizardState;
  attachBlock: HTMLElement;
  attachErr: HTMLElement;
  contentPanel: HTMLElement;
  nextBtn: HTMLButtonElement;
  stepHost: HTMLElement;
  showContent: (on: boolean) => void;
  seedName: () => void;
  closeOverlay: () => void;
  onSaved: () => void;
  onClose: () => void;
  prefill: EditorPrefill | undefined;
  tokenPrefill: EditorPrefill | undefined;
  // tokenPrefillApplied is a one-shot flag in the wizard; the builder reads it and reports back the
  // new value via setTokenPrefillApplied (the hand-off auto-selects its row only the first render).
  tokenPrefillApplied: boolean;
  setTokenPrefillApplied: (v: boolean) => void;
}

// buildSourceList renders the wizard's source-step content into ctx.stepHost for one
// discoverSources() result and applies the token-source hand-off auto-select. It is the verbatim
// body of the wizard's old discoverSources().then(found => ...) inner block, so it returns nothing;
// the side effect is the stepHost.replaceChildren() at the end.
export function buildSourceList(ctx: WizardSourceCtx, found: SourceDiscovery): void {
  const { engine, status, piped, state, attachBlock, attachErr, contentPanel, nextBtn, stepHost } = ctx;
  const { showContent, seedName, closeOverlay, onSaved, onClose, prefill, tokenPrefill } = ctx;

  // The step mixes a multi-select (the attached-binding checkbox groups) with a radio pick (the
  // Cloudflare-wide sources), mutually exclusive, so the container is a plain group.
  const list = h("div", { class: "stack-sm", role: "group", "aria-label": "Source to back up" });
  // Registry of the TOKEN-source rows built this render, so a hand-off from "Add a source"
  // (cf-config / workers) can auto-select the matching row by calling its exact apply() closure
  // (no synthetic DOM event, no duplicated side-effect logic). radio is the row's input so the
  // auto-select can also reflect the checked state visually.
  const tokenRows: Array<{ type: TokenSourceType; accountId: string; zoneId: string | null; radio: HTMLInputElement; apply: () => void }> = [];
  // The checkbox groups' clear handles (selectableSourceList expose), so a radio pick can untick
  // the whole multi-selection in one sweep (the mutual exclusion above).
  const groupClears: Array<() => void> = [];

  // clearMultiSelection unticks every checkbox group and empties the multi maps (kv/r2/d1, secrets,
  // AND cf-config zones/accounts, all coexisting checkbox families): run by every token-RADIO
  // apply(), so a radio pick never rides along with a stale multi-selection. Zone groups expose
  // their clearAll into groupClears exactly like multiGroup's, so this loop reaches them too;
  // account rows are plain checkboxes (not a selectableSourceList group), so they are unticked
  // directly off tokenRows.
  const clearMultiSelection = (): void => {
    for (const clear of groupClears) clear();
    for (const r of tokenRows) { if (r.type === "cf-config" && r.zoneId === null) r.radio.checked = false; }
    state.chosenMulti.clear();
    state.chosenSecretsMulti.clear();
    state.chosenCfZones.clear();
    state.chosenCfAccounts.clear();
  };
  // clearTokenSelection is the mirror: the first checkbox tick (kv/r2/d1/secrets OR a cf-config
  // zone/account) unpicks a selected RADIO and resets its scalar state, so the two families never
  // mix. It deliberately SKIPS cf-config rows in the uncheck loop: cf-config is itself a checkbox
  // family now (ticking zone B must not untick zone A), cleared only by clearMultiSelection above.
  const clearTokenSelection = (): void => {
    if (state.chosenBinding === null && state.chosenType === null) return;
    for (const r of tokenRows) { if (r.type !== "cf-config") r.radio.checked = false; }
    state.chosenBinding = null;
    state.chosenType = null;
    state.chosenInput = null;
    state.chosenAccountId = null;
    state.chosenWorkersAccountId = null;
    state.chosenStreamAccountId = null;
    state.chosenImagesAccountId = null;
    state.chosenArtifactsAccountId = null;
    showContent(false);
    attachErr.hidden = true;
    attachBlock.hidden = true;
  };
  // updateNextForMulti reflects the checkbox selection (stores + secrets + cf-config zones/accounts)
  // on the Continue button.
  const updateNextForMulti = (): void => {
    const picks = state.chosenMulti.size + (state.chosenSecretsMulti.size > 0 ? 1 : 0) + state.chosenCfZones.size + state.chosenCfAccounts.size;
    nextBtn.disabled = picks === 0 && state.chosenBinding === null;
    nextBtn.textContent = "Continue";
  };

  // A cf-config hand-off from "Add a source" pre-ticks the matching zone or account checkbox.
  // Unlike the other four token types (workers/stream/images/artifacts, which wait for a rendered
  // row to learn its own display name, then hand off via tokenRows below), a zone/account's NAME is
  // already resolvable straight off `found`, so this seeds state.chosenCfZones/chosenCfAccounts
  // directly, BEFORE the rows render, so a checkbox's initial `checked` (computed from that same
  // state when the row is built) reflects it from first paint rather than a post-render toggle.
  // Runs once, gated by the same one-shot tokenPrefillApplied flag the generic hand-off below uses
  // (which explicitly excludes cf-config so the two mechanisms never both fire for one hand-off).
  if (!ctx.tokenPrefillApplied && tokenPrefill?.type === "cf-config") {
    ctx.setTokenPrefillApplied(true);
    const allZones = (found.accounts ?? []).flatMap((a) => (a.zones ?? []).map((z) => ({ ...z, accountId: a.accountId })));
    let zoneHit: (typeof allZones)[number] | undefined;
    let acctHit: { accountId: string; accountName: string } | undefined;
    if (tokenPrefill.zoneId) {
      zoneHit = allZones.find((z) => z.id === tokenPrefill.zoneId);
    } else if (tokenPrefill.accountId) {
      acctHit = (found.accounts ?? []).find((a) => a.accountId === tokenPrefill.accountId);
    } else if (allZones.length === 0 && (found.accounts ?? []).length === 1) {
      // The common "Add a source" hand-off (no zone/account named): auto-select the SOLE cf-config
      // row when there is exactly one across every discovered account (a lone account with no
      // zones listed -- any zone would add a second row), mirroring the other four token types'
      // same-shaped fallback below. Otherwise leave the section for the operator to disambiguate.
      acctHit = (found.accounts ?? [])[0];
    }
    if (zoneHit !== undefined) state.chosenCfZones.set(zoneHit.id, { accountId: zoneHit.accountId, zoneName: zoneHit.name });
    else if (acctHit !== undefined) state.chosenCfAccounts.set(acctHit.accountId, acctHit.accountName);
    if (zoneHit !== undefined || acctHit !== undefined) updateNextForMulti();
    // G310: NOTHING IS RECORDED HERE, deliberately, and the removed recorder is worth explaining.
    //
    // This branch used to record handoff-dropped/prefill-zone-unmatched on the `else` of the chain above, which
    // fired whenever the type-only hand-off could not auto-select: that is, on ANY estate with more than one
    // discovered zone or account. But a type-only hand-off is the DESIGNED Add-a-source journey (add-source.ts
    // builds the link with the type alone and lets the wizard collect the account/zone), and the fallback's own
    // comment says to "leave the section for the operator to disambiguate". So the row fired on the ordinary
    // click, on the ordinary estate, and coalesced with the fault it was meant to name.
    //
    // The fault it was meant to name -- a deep link that NAMES a zone discovery no longer returns -- has no
    // producer in this console. tokenSourceCreatePath can build a ?zone=/?account= link, and the editor's prefill
    // reader parses one, but NO SCREEN EVER EMITS ONE: every in-app route to /downpipes/new carries the type
    // alone. A class no build can put in the ring is dead vocabulary that reads like coverage, and a pack section
    // that can never be populated is worse than an honest absence: it tells a support engineer the evidence was
    // looked for and not found. The class is therefore gone from the vocabulary rather than guarded into silence.
    // If a per-zone "Protect this zone" control is ever built, it emits the named link, and the class comes back
    // with a real producer behind it.
  }

  // wizGroupIcon is the shared source-type glyph (the Sources screen's), so the wizard's groups
  // read identically to the bulk-protect tier's.
  const wizGroupIcon = pickIcon;

  // multiGroup builds one attached-binding checkbox group (filterable, All/None, scroll-capped):
  // the many-to-many source picker. A binding already covered by a downpipe renders DISABLED with
  // its badge (one downpipe per source); the pickable rows list first. Ticks restore across
  // Back/Continue from the shared state.
  const multiGroup = (type: "kv" | "r2" | "d1" | "secrets", label: string, names: string[]): HTMLElement | null => {
    if (names.length === 0) return null;
    const ordered = [...names.filter((n) => !piped.has(n)), ...names.filter((n) => piped.has(n))];
    const isTicked = (name: string): boolean => (type === "secrets" ? state.chosenSecretsMulti.has(name) : state.chosenMulti.has(name));
    return selectableSourceList({
      groupId: `wiz-${type}`,
      label,
      icon: wizGroupIcon(type),
      open: true,
      items: ordered.map((name) => ({
        value: name,
        label: name,
        checked: isTicked(name),
        ...(piped.has(name) ? { disabled: true, badge: h("span", { style: "margin-left:auto" }, badge("ok", "Already protected")) } : {}),
      })),
      onToggle: (value, checked) => {
        clearTokenSelection();
        if (type === "secrets") {
          if (checked) state.chosenSecretsMulti.add(value);
          else state.chosenSecretsMulti.delete(value);
        } else if (checked) {
          state.chosenMulti.set(value, type);
        } else {
          state.chosenMulti.delete(value);
        }
        updateNextForMulti();
      },
      expose: (handle) => groupClears.push(handle.clearAll),
    });
  };

  // ---- cf-config: scope preset + tick-many zones/accounts (source-granularity audit) ----------
  // cf-config is no longer a single radio pick: the section offers a SCOPE PRESET (what a ticked
  // zone's downpipe captures) plus tick-many checkboxes over the discovered zones and accounts,
  // mirroring the kv/r2/d1 multi-select exactly. Each ticked zone becomes its own downpipe; each
  // ticked account its own account-wide downpipe; a customer with N zones bulk-creates in one pass
  // instead of running the wizard N times, and (under the "zone-only" preset) without duplicating
  // the ~195 account surfaces into every zone. cfZoneGroupEls / cfAccountRowEls hold every rendered
  // row so the preset control can show/hide them; cfPresetHint is the one dynamic explanation line.
  const cfZoneGroupEls: HTMLElement[] = [];
  const cfAccountRowEls: HTMLElement[] = [];
  // cfZoneGroupClears holds ONLY the zone groups' own clearAll handles (a subset of the shared
  // groupClears below, which also carries kv/r2/d1/secrets): switching the preset to "account-only"
  // must untick zones without touching an unrelated store tick, so it needs a scoped clear, not the
  // shared one clearMultiSelection uses.
  const cfZoneGroupClears: Array<() => void> = [];
  // cfAccountRowClears is the SYMMETRIC scoped clear for the account rows: switching the preset to
  // "account-and-zone" HIDES the account row (a ticked account there would duplicate the ~195 account
  // surfaces already inside the zone-and-account bundle), so a stranded tick must be cleared, exactly as
  // switching to "account-only" clears the zone ticks. Without this a hidden account tick silently minted a
  // redundant standalone account downpipe -- the very duplication this feature exists to prevent.
  const cfAccountRowClears: Array<() => void> = [];
  const cfPresetHint = h("p", { class: "field__hint", style: "margin:0" });
  // Counted off the live discovery catalogue, never written into the copy. The account figure used to be
  // the literal "about 195 surfaces", which was right on the day it was typed and is exactly the kind of
  // number that goes stale silently: the registry moved four times in one afternoon while this string did
  // not. An empty catalogue (an older engine, or discovery not yet answered) renders the sentence without
  // a count rather than with a zero, because "0 surfaces" would be a false claim and not a missing one.
  const cfCount = (scope: "zone" | "account"): number => state.cfCatalogue.filter((s) => s.scope === scope).length;
  const cfInBand = (scope: "zone" | "account"): number => state.cfCatalogue.filter((s) => s.scope === scope && s.inBand).length;
  const cfAccountPhrase = (): string => {
    const n = cfCount("account");
    return n === 0 ? "account-wide settings" : `account-wide settings (${n} surfaces)`;
  };
  // The restore sentence is appended only when the catalogue is loaded AND the engine told us which
  // surfaces are in band. It is the honest counterweight to a large capture figure: a customer reading
  // "195 surfaces" should not have to reach the docs to learn how many of them a restore re-applies.
  const cfRestorePhrase = (scope: "zone" | "account"): string => {
    if (state.cfCatalogue.length === 0) return "";
    const n = cfInBand(scope);
    return ` ${n} of them re-apply in console on a restore; the rest are captured and verified for you to re-apply yourself.`;
  };
  const CF_PRESET_HINT = (): Record<CfScopePreset, string> => ({
    "account-only": `Backs up ${cfAccountPhrase()} only, such as Zero Trust, notifications and rulesets. No zone configuration is included.${cfRestorePhrase("account")}`,
    "zone-only": `Backs up each ticked zone's configuration only. Tick the account-wide row below to also back up your account settings once, in a separate downpipe.${cfRestorePhrase("zone")}`,
    "account-and-zone": "Backs up each ticked zone's configuration plus the full account-wide configuration in the same downpipe. Ticking several zones repeats the account-wide configuration in every one.",
  });
  // applyCfConfigVisibility shows/hides the zone group(s) and account row(s) for the current
  // preset: "account-only" has nothing to tick a zone for, so the zone groups hide; "account-and-
  // zone" already carries the account config inside every ticked zone, so the account rows hide
  // (ticking one too would triple it up). Re-run after every preset change AND once after the
  // per-account rows finish building (their hidden state must reflect the CURRENT preset from the
  // first paint, not just after the operator touches the select).
  const applyCfConfigVisibility = (): void => {
    const preset = state.cfScopePreset ?? "account-and-zone";
    cfPresetHint.textContent = CF_PRESET_HINT()[preset];
    for (const el of cfZoneGroupEls) el.hidden = preset === "account-only";
    for (const el of cfAccountRowEls) el.hidden = preset === "account-and-zone";
  };
  // zoneSurfaceIds is the "zone-only" preset's include list: the ids the engine catalogue tags
  // scope:"zone" (DNS, WAF, zone settings, ...), computed live off the discovery catalogue so it
  // never drifts from what the engine actually offers.
  const zoneSurfaceIds = (): string[] => state.cfCatalogue.filter((s) => s.scope === "zone").map((s) => s.id);
  // cfPresetControl renders the 3-option scope preset once for the whole section (not per account:
  // the choice is "what does a ticked zone capture", the same question regardless of which account
  // it belongs to). Defaulted ONCE (state.cfScopePreset starts null): a single zone (or none)
  // defaults to "account-and-zone" (today's exact behaviour, zero surprise for a one-zone
  // customer); 2+ zones default to "zone-only" (the audit's fix). Sticky thereafter across
  // Back/Continue.
  const cfPresetControl = (): HTMLElement => {
    if (state.cfScopePreset === null) {
      const totalZones = (found.accounts ?? []).reduce((n, a) => n + (a.zones?.length ?? 0), 0);
      state.cfScopePreset = defaultCfScopePreset(totalZones);
    }
    const sel = h(
      "select",
      { "data-dp": "sources-downpipes.select.sel", class: "field__select", "aria-label": "Cloudflare configuration scope" },
      h("option", { value: "account-only" }, "Account configuration only"),
      h("option", { value: "zone-only" }, "This zone only"),
      h("option", { value: "account-and-zone" }, "Account + this zone"),
    ) as HTMLSelectElement;
    sel.value = state.cfScopePreset;
    sel.addEventListener("change", () => {
      state.cfScopePreset = (sel.value === "account-only" || sel.value === "zone-only" ? sel.value : "account-and-zone") as CfScopePreset;
      // Each preset switch clears the ticks whose row it HIDES, so nothing invisible still creates a
      // downpipe (the SCOPED clears, not clearMultiSelection's shared one, which would also untick an
      // unrelated kv/r2/d1/secrets tick). "account-only" hides the zone group; "account-and-zone" hides the
      // account rows. Switching to "zone-only" hides neither (it reveals both), so it keeps every tick.
      if (state.cfScopePreset === "account-only" && state.chosenCfZones.size > 0) {
        for (const clear of cfZoneGroupClears) clear();
        state.chosenCfZones.clear();
        updateNextForMulti();
      }
      if (state.cfScopePreset === "account-and-zone" && state.chosenCfAccounts.size > 0) {
        for (const clear of cfAccountRowClears) clear();
        state.chosenCfAccounts.clear();
        updateNextForMulti();
      }
      applyCfConfigVisibility();
    });
    const scopeDoc = h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/operations/cloudflare-config-backup-restore#choosing-what-to-capture-mode-and-scope", target: "_blank", rel: "noreferrer noopener" },
      "About configuration scope",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    );
    return h("div", { class: "stack-xs" }, sel, cfPresetHint, scopeDoc);
  };
  // cfAccountRow renders one account's "back up account-wide configuration" checkbox: tick-many
  // (mirrors multiGroup), unticked by default like every other checkbox here. multiAccount matches
  // appendSourceSections's own multi-account label so the row and the resulting downpipe's name
  // agree; it also stamps state.cfMultiAccount so the bulk-assemble call downstream uses the same
  // label rule with no duplicated "how many accounts" computation.
  const cfAccountRow = (accountId: string, accountName: string, isEngine: boolean, multiAccount: boolean): HTMLElement => {
    state.cfMultiAccount = multiAccount;
    const id = `wiz-cfacct-${accountId}`;
    const label = multiAccount
      ? `${accountName}${isEngine ? " (this engine's account)" : ""}, account-wide settings`
      : "Account-wide settings (Zero Trust, notifications, rulesets)";
    const box = h("input", { type: "checkbox", id }) as HTMLInputElement;
    // A direct property write, not h()'s attrs (checked:true would set the CONTENT ATTRIBUTE; a
    // browser reflects that into the live property for a fresh element, but being explicit here
    // costs nothing and matches the row's own apply() below).
    box.checked = state.chosenCfAccounts.has(accountId);
    const apply = (): void => {
      clearTokenSelection();
      box.checked = true;
      state.chosenCfAccounts.set(accountId, accountName);
      updateNextForMulti();
    };
    box.addEventListener("change", () => {
      clearTokenSelection();
      if (box.checked) state.chosenCfAccounts.set(accountId, accountName);
      else state.chosenCfAccounts.delete(accountId);
      updateNextForMulti();
    });
    tokenRows.push({ type: "cf-config", accountId, zoneId: null, radio: box, apply });
    // The scoped clear the "account-and-zone" preset switch calls (unticks this row without disturbing an
    // unrelated kv/r2/d1/secrets tick); the caller clears state.chosenCfAccounts.
    cfAccountRowClears.push(() => { box.checked = false; });
    const row = h("div", { class: "checkbox-row" }, box, h("label", { for: id, class: "mono" }, label), badge("ok", "config"));
    cfAccountRowEls.push(row);
    return row;
  };
  // cfZoneGroup renders one account's zones as a tick-many checkbox group (filterable, All/None,
  // scroll-capped), the EXACT mirror of multiGroup: each ticked zone becomes its own downpipe.
  // Returns null when the account has no listed zones (multiGroup's own empty-list contract).
  const cfZoneGroup = (accountId: string, zones: Array<{ id: string; name: string }>): HTMLElement | null => {
    if (zones.length === 0) return null;
    const nameOf = new Map(zones.map((z) => [z.id, z.name] as const));
    const group = selectableSourceList({
      groupId: `wiz-cfzone-${accountId}`,
      label: "Zones",
      icon: ICON_CFCONFIG,
      open: true,
      items: zones.map((z) => ({ value: z.id, label: z.name, checked: state.chosenCfZones.has(z.id) })),
      onToggle: (value, checked) => {
        clearTokenSelection();
        if (checked) state.chosenCfZones.set(value, { accountId, zoneName: nameOf.get(value) ?? value });
        else state.chosenCfZones.delete(value);
        updateNextForMulti();
      },
      expose: (handle) => {
        groupClears.push(handle.clearAll); // clearMultiSelection's shared sweep (a radio pick)
        cfZoneGroupClears.push(handle.clearAll); // the preset control's scoped zone-only clear
      },
    });
    cfZoneGroupEls.push(group);
    return group;
  };

  // selectWorkers wires a Workers-scripts row (the workers source): like cf-config, no binding and
  // no inline attach, the read-only discovery token is the credential, so picking it routes
  // straight on. It carries the account id and backs up every Worker in the account. The info-tip
  // states the honest restore posture (reprovision, not a blind write) at the point of pick.
  // applyWorkers is the workers pick side-effect, factored out so BOTH the row's change listener
  // and the token-source hand-off auto-select run the identical logic.
  const applyWorkers = (opts: { accountId: string; display: string }): void => {
    clearMultiSelection(); // a radio pick supersedes any checkbox multi-selection
    state.chosenType = "workers";
    state.chosenWorkersAccountId = opts.accountId;
    state.chosenAccountId = opts.accountId;
    state.chosenBinding = opts.display; // for display / name-seed / dirty-guard; workers has no binding
    state.chosenInput = null;
    showContent(false); // workers captures script code + metadata, not a separate content blob
    seedName();
    attachErr.hidden = true;
    attachBlock.hidden = true;
    nextBtn.disabled = false;
    nextBtn.textContent = "Continue";
  };
  const selectWorkers = (opts: { rowId: string; label: string; accountId: string; display: string }): HTMLElement => {
    const id = `wiz-wk-${opts.rowId}`;
    const radio = h("input", { type: "radio", name: "wiz-source", id, value: opts.rowId, ...(state.chosenType === "workers" && state.chosenWorkersAccountId === opts.accountId ? { checked: true } : {}) }) as HTMLInputElement;
    const apply = (): void => applyWorkers({ accountId: opts.accountId, display: opts.display });
    radio.addEventListener("change", () => { if (radio.checked) apply(); });
    tokenRows.push({ type: "workers", accountId: opts.accountId, zoneId: null, radio, apply });
    return h("div", { class: "checkbox-row" }, radio,
      h("label", { for: id, class: "mono" }, opts.label),
      badge("ok", "scripts"),
      infoTip(WORKERS_RESTORE_NOTE, { label: "About backing up and restoring Workers" }));
  };

  // selectStream wires a Stream row (the stream source): like workers, no binding and no inline
  // attach, the read-only discovery token is the credential, account-scoped. applyStream is the
  // pick side-effect, factored out so the row's change listener and the hand-off auto-select share it.
  const applyStream = (opts: { accountId: string; display: string }): void => {
    clearMultiSelection(); // a radio pick supersedes any checkbox multi-selection
    state.chosenType = "stream";
    state.chosenStreamAccountId = opts.accountId;
    state.chosenAccountId = opts.accountId;
    state.chosenWorkersAccountId = null;
    state.chosenBinding = opts.display; // for display / name-seed / dirty-guard; stream has no binding
    state.chosenInput = null;
    showContent(true); // Stream can also capture the video bytes + captions (opt-in)
    seedName();
    attachErr.hidden = true;
    attachBlock.hidden = true;
    nextBtn.disabled = false;
    nextBtn.textContent = "Continue";
  };
  const selectStream = (opts: { rowId: string; label: string; accountId: string; display: string }): HTMLElement => {
    const id = `wiz-st-${opts.rowId}`;
    const radio = h("input", { type: "radio", name: "wiz-source", id, value: opts.rowId, ...(state.chosenType === "stream" && state.chosenStreamAccountId === opts.accountId ? { checked: true } : {}) }) as HTMLInputElement;
    const apply = (): void => applyStream({ accountId: opts.accountId, display: opts.display });
    radio.addEventListener("change", () => { if (radio.checked) apply(); });
    tokenRows.push({ type: "stream", accountId: opts.accountId, zoneId: null, radio, apply });
    return h("div", { class: "checkbox-row" }, radio,
      h("label", { for: id, class: "mono" }, opts.label),
      badge("ok", "videos"),
      infoTip(STREAM_RESTORE_NOTE, { label: "About backing up and restoring Stream" }));
  };
  // selectImages wires a Cloudflare Images row (account-scoped, token-authenticated, no binding),
  // mirroring selectStream. applyImages is the pick side-effect shared by the row + hand-off auto-select.
  const applyImages = (opts: { accountId: string; display: string }): void => {
    clearMultiSelection(); // a radio pick supersedes any checkbox multi-selection
    state.chosenType = "images";
    state.chosenImagesAccountId = opts.accountId;
    state.chosenAccountId = opts.accountId;
    state.chosenWorkersAccountId = null;
    state.chosenStreamAccountId = null;
    state.chosenBinding = opts.display; // for display / name-seed / dirty-guard; images has no binding
    state.chosenInput = null;
    showContent(true); // Images can also capture the image bytes (opt-in)
    seedName();
    attachErr.hidden = true;
    attachBlock.hidden = true;
    nextBtn.disabled = false;
    nextBtn.textContent = "Continue";
  };
  const selectImages = (opts: { rowId: string; label: string; accountId: string; display: string }): HTMLElement => {
    const id = `wiz-im-${opts.rowId}`;
    const radio = h("input", { type: "radio", name: "wiz-source", id, value: opts.rowId, ...(state.chosenType === "images" && state.chosenImagesAccountId === opts.accountId ? { checked: true } : {}) }) as HTMLInputElement;
    const apply = (): void => applyImages({ accountId: opts.accountId, display: opts.display });
    radio.addEventListener("change", () => { if (radio.checked) apply(); });
    tokenRows.push({ type: "images", accountId: opts.accountId, zoneId: null, radio, apply });
    return h("div", { class: "checkbox-row" }, radio,
      h("label", { for: id, class: "mono" }, opts.label),
      badge("ok", "images"),
      infoTip(IMAGES_RESTORE_NOTE, { label: "About backing up and restoring Images" }));
  };
  // selectArtifacts wires a Cloudflare Artifact Registry row (account-scoped, token-authenticated, no
  // binding), mirroring selectImages. applyArtifacts is the pick side-effect shared by the row + hand-off.
  const applyArtifacts = (opts: { accountId: string; display: string }): void => {
    clearMultiSelection(); // a radio pick supersedes any checkbox multi-selection
    state.chosenType = "artifacts";
    state.chosenArtifactsAccountId = opts.accountId;
    state.chosenAccountId = opts.accountId;
    state.chosenWorkersAccountId = null;
    state.chosenStreamAccountId = null;
    state.chosenImagesAccountId = null;
    state.chosenBinding = opts.display; // for display / name-seed / dirty-guard; artifacts has no binding
    state.chosenInput = null;
    showContent(true); // Artifact Registry can also capture the repo blob contents (opt-in)
    seedName();
    attachErr.hidden = true;
    attachBlock.hidden = true;
    nextBtn.disabled = false;
    nextBtn.textContent = "Continue";
  };
  const selectArtifacts = (opts: { rowId: string; label: string; accountId: string; display: string }): HTMLElement => {
    const id = `wiz-ar-${opts.rowId}`;
    const radio = h("input", { type: "radio", name: "wiz-source", id, value: opts.rowId, ...(state.chosenType === "artifacts" && state.chosenArtifactsAccountId === opts.accountId ? { checked: true } : {}) }) as HTMLInputElement;
    const apply = (): void => applyArtifacts({ accountId: opts.accountId, display: opts.display });
    radio.addEventListener("change", () => { if (radio.checked) apply(); });
    tokenRows.push({ type: "artifacts", accountId: opts.accountId, zoneId: null, radio, apply });
    return h("div", { class: "checkbox-row" }, radio,
      h("label", { for: id, class: "mono" }, opts.label),
      badge("ok", "repositories"),
      infoTip(ARTIFACTS_RESTORE_NOTE, { label: "About backing up and restoring Artifact Registry" }));
  };

  // Append every offered source row (attached KV/R2/D1 + the token-authenticated Cloudflare sections);
  // the section-append logic lives in ./editor-wizard-source-sections.ts and is driven by the builders
  // above. anyRow drives the list-vs-empty-state choice below.
  const anyRow = appendSourceSections(list, found, {
    multiGroup, cfPresetControl, cfAccountRow, cfZoneGroup, selectWorkers, selectStream, selectImages, selectArtifacts,
  });
  // The per-account rows/groups are built inside appendSourceSections (above); their hidden state
  // must reflect the CURRENT preset from first paint, not just after the operator touches the
  // select, so apply it once more now that cfZoneGroupEls/cfAccountRowEls are fully populated.
  applyCfConfigVisibility();

  stepHost.replaceChildren(
    h("p", { class: "field__hint" }, "Pick a source to back up. To offer a new one here, add it under Sources first (attach a store, or add a Cloudflare-wide source), then come back."),
    anyRow ? list : h("p", { class: "field__hint" },
      "No sources added yet. ",
      h("button", { "data-dp": "sources-downpipes.button.navigate-sources", class: "linklike", type: "button", on: { click: () => { closeOverlay(); navigate("/sources"); } } }, "Add one under Sources"),
      " first, then create a downpipe for it."),
    attachBlock,
    contentPanel,
    h(
      "p",
      { class: "field__hint" },
      "Need includes/excludes, retention, exact configuration surfaces, or to name each secret in a Secrets downpipe? ",
      h(
        "button",
        { "data-dp": "sources-downpipes.button.open-editor",
          class: "linklike",
          type: "button",
          on: {
            click: () => {
              closeOverlay();
              // Carry the picked source into the editor so it is never re-typed. For a TOKEN/MEDIA
              // source the editor has no account/zone/surface controls of its own, so the account
              // (and, for cf-config, the zone + surfaces) must ride across, or the editor would
              // build a source with no account and the engine would reject the save with no UI
              // recovery. The account picked for any of the four remaining radio types is in
              // chosenAccountId. cf-config is now a tick-many selection (chosenCfZones /
              // chosenCfAccounts): a SINGLE ticked zone or account (nothing else ticked) carries
              // its identity across exactly like the old single-pick hand-off; a bulk (2+)
              // selection carries nothing cf-config-specific, the same as a multi kv/r2/d1 tick
              // already carries nothing today (there is no one identity to hand off to a
              // single-downpipe editor).
              const singleCfZone = state.chosenCfZones.size === 1 && state.chosenCfAccounts.size === 0 ? [...state.chosenCfZones.entries()][0]! : null;
              const singleCfAccount = state.chosenCfAccounts.size === 1 && state.chosenCfZones.size === 0 ? [...state.chosenCfAccounts.entries()][0]! : null;
              const carryAccountId =
                state.chosenAccountId
                ?? (singleCfZone !== null ? singleCfZone[1].accountId : null)
                ?? (singleCfAccount !== null ? singleCfAccount[0] : null)
                ?? prefill?.accountId
                ?? null;
              const carryZoneId = singleCfZone !== null ? singleCfZone[0] : null;
              // The "zone-only" preset's fixed surface list carries across too, so the editor opens
              // already scoped to it; the other two presets carry null (the editor's "all visible"
              // default, console-src-054-02's compact-wire-form invariant).
              const carrySurfaces = singleCfZone !== null && state.cfScopePreset === "zone-only" ? zoneSurfaceIds() : null;
              const carryType = state.chosenType ?? (singleCfZone !== null || singleCfAccount !== null ? ("cf-config" as const) : prefill?.type);
              const carry: EditorPrefill = {
                ...(state.chosenBinding !== null ? { binding: state.chosenBinding } : prefill?.binding !== undefined ? { binding: prefill.binding } : {}),
                ...(carryType !== undefined ? { type: carryType } : {}),
                ...(prefill?.secretBinding !== undefined ? { secretBinding: prefill.secretBinding } : {}),
                // Carry any native resource id forward (from the attach-success bridge prefill), so the
                // editor records it on a create and the config is roster-rebuildable on re-attach.
                ...(prefill?.namespaceId !== undefined ? { namespaceId: prefill.namespaceId } : {}),
                ...(prefill?.bucketName !== undefined ? { bucketName: prefill.bucketName } : {}),
                ...(prefill?.databaseId !== undefined ? { databaseId: prefill.databaseId } : {}),
                ...(prefill?.secretStoreId !== undefined ? { secretStoreId: prefill.secretStoreId } : {}),
                ...(carryAccountId !== null ? { accountId: carryAccountId } : {}),
                ...(carryZoneId !== null ? { zoneId: carryZoneId } : {}),
                ...(carrySurfaces !== null ? { surfaces: carrySurfaces } : {}),
              };
              openEditor(engine, null, status, onSaved, onClose, carry);
            },
          },
        },
        "Use the advanced editor",
      ),
      ".",
    ),
  );

  // Apply a TOKEN-source hand-off (workers / stream / images / artifacts) ONCE: select the matching
  // row by calling its exact apply() closure (the same side-effect the change listener runs), so
  // the picked account, the Continue enable and the panel all behave as a manual pick would, with
  // no logic duplicated and no synthetic DOM event. cf-config is explicitly EXCLUDED here (its own
  // hand-off, seeded directly off `found` before the rows rendered, runs earlier in this function
  // and already consumed tokenPrefillApplied) so the two mechanisms never both fire for one
  // hand-off. When the hand-off named only the type (the common "Add a source" hand-off), select
  // the SOLE matching row if there is exactly one, else leave the section for the operator to
  // disambiguate (multi-account). The row is also checked so it reads selected.
  if (!ctx.tokenPrefillApplied && tokenPrefill !== undefined && tokenPrefill.type !== "cf-config") {
    ctx.setTokenPrefillApplied(true);
    const candidates = tokenRows.filter((r) => r.type === tokenPrefill.type);
    let target: (typeof tokenRows)[number] | undefined;
    if (tokenPrefill.accountId) {
      target = candidates.find((r) => r.accountId === tokenPrefill.accountId);
    } else if (candidates.length === 1) {
      target = candidates[0];
    }
    if (target) { target.radio.checked = true; target.apply(); }
    // G310: nothing is recorded here either, and for the same reason as the cf-config hand-off above. The
    // removed recorder fired on the `else` of a chain whose type-only fallback only auto-selects when there is
    // exactly ONE candidate row, so every ordinary Add-a-source hand-off on a multi-account estate stamped
    // prefill-account-unmatched into the sealed pack -- a class documented as "the deep link named an ACCOUNT and
    // no discovered row carries it" when no account had been named at all. That is a row asserting a fact the
    // code never established, on a legitimate state, which costs support time rather than saving it.
    // No console screen emits an ?account= link, so the honest state has no producer, and the class is gone.
  }
}
