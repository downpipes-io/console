// Source-step section assembly for the guided create wizard, split out of
// ./editor-wizard-source-rows.ts. See ./editor.ts for the barrel.
//
// appendSourceSections appends the wizard's source-step rows to the radiogroup `list`: the already-
// attached KV/R2/D1 groups, then the token-authenticated Cloudflare sections (configuration, Workers,
// Stream, Images, Artifact Registry), each gated on what the engine advertises. It is the verbatim
// section-append portion of the old buildSourceList body; the per-row apply()/builder closures are
// passed in (they still live in ./editor-wizard-source-rows.ts and own the shared mutable state).

import { recordCatalogueDegraded } from "../../lib/client-diag/ring.ts";
import type { ClientDiagCatalogueClass } from "../../lib/client-diag/vocab.ts";
import { h } from "../../lib/dom.ts";
import { ARTIFACTS_GA } from "../../lib/token-source.ts";
import type { SourceDiscovery } from "../../api.ts";

// SectionBuilders is the set of row/group-builder closures appendSourceSections appends with. Each
// returns its element; they own the shared wizard state via their defining closure, so this module
// never touches state directly. The BOUND sources (kv/r2/d1/secrets) AND cf-config (zones +
// account-wide) are all MULTI-SELECT checkboxes (tick as many as you like, each becomes its own
// downpipe; ticked secrets bundle into one); the remaining token-authenticated Cloudflare sections
// (workers/stream/images/artifacts) stay single-pick radios (each is one account-wide downpipe with
// its own per-pick configuration).
export interface SectionBuilders {
  multiGroup: (type: "kv" | "r2" | "d1" | "secrets", label: string, names: string[]) => HTMLElement | null;
  // cfPresetControl renders the cf-config scope preset (account-only / zone-only /
  // account-and-zone), once for the whole section. cfAccountRow renders one account's tick-many
  // "back up account-wide configuration" checkbox; cfZoneGroup renders one account's zones as a
  // tick-many checkbox group (mirroring multiGroup), or null when it has none.
  cfPresetControl: () => HTMLElement;
  cfAccountRow: (accountId: string, accountName: string, isEngine: boolean, multiAccount: boolean) => HTMLElement;
  cfZoneGroup: (accountId: string, zones: Array<{ id: string; name: string }>) => HTMLElement | null;
  selectWorkers: (opts: { rowId: string; label: string; accountId: string; display: string }) => HTMLElement;
  selectStream: (opts: { rowId: string; label: string; accountId: string; display: string }) => HTMLElement;
  selectImages: (opts: { rowId: string; label: string; accountId: string; display: string }) => HTMLElement;
  selectArtifacts: (opts: { rowId: string; label: string; accountId: string; display: string }) => HTMLElement;
}

// HINT_INDENT aligns a group's hint paragraph with the radio LABEL column (a 16px control
// plus the .checkbox-row gap), so the hint reads as part of the group rather than flush to
// the modal edge while every label indents.
const HINT_INDENT = "margin:0;padding-left:calc(16px + var(--space-2))";

// cfConfigWithheldReason names WHY the Cloudflare configuration section is not on offer. The section is
// withheld for a handful of reasons, and they used to be indistinguishable (the section simply did not
// render), which is the fault behind "the wizard stopped offering Cloudflare configuration" and
// "cf-config backups capture nothing new". Each reason names the one control that fixes it.
//   no token         -> account discovery is OPT-IN and no read-only discovery token has been stored, so the
//                       engine answered the discovery route before it ever built a catalogue. This is the
//                       DEFAULT state of an install that only backs up bound sources (KV, R2, D1, secrets),
//                       and nothing is wrong with it. The remedy is a token, not an update.
//   catalogue empty  -> a token IS stored, the engine walked the token path, and it still returned no
//                       configuration surfaces. On that path the catalogue is a static compiled-in list, so the
//                       only thing that empties it is an engine that predates the feature. Update the engine.
//   not added        -> the engine gates adds and cf-config was never added on the Sources screen.
//   no accounts      -> the catalogue is there but the token could read NO account, so there is nothing
//                       to scope a config downpipe to.
// Pure (no DOM), so the validator drives every branch. It carries no token, URL or API text.
export function cfConfigWithheldReason(found: SourceDiscovery, cfConfigAdded: boolean, accountCount: number): string {
  const catalogueEmpty = (found.cfConfigSurfaces ?? []).length === 0;
  if (catalogueEmpty) {
    // THE TOKEN GATE, and it is the difference between a remedy and a wild goose chase. GET /sources/discover
    // returns the surface catalogue only on the TOKEN path; with no discovery token stored it returns early with
    // { bound, tokenPresent: false } and no capability fields at all. So an empty catalogue means "this engine is
    // too old" ONLY when a token is present. Without one, telling the operator to check a token that can no
    // longer read their account (or to update a current engine) names two remedies for a state that needs
    // neither. tokenPresent ABSENT is an engine that predates the account tier itself, which the token-source
    // skew families already report, so it is not spoken about here either.
    if (found.tokenPresent !== true) {
      return "Cloudflare configuration (DNS, WAF, zone and account settings) is not on offer because this engine has no Cloudflare discovery token. Add a read-only discovery token under Sources to browse and back up your account and zone configuration. Your bound sources (KV, R2, D1, secrets) need no token and are unaffected.";
    }
    return "Cloudflare configuration (DNS, WAF, zone and account settings) is not on offer: this engine read your account with its discovery token and returned no configuration surfaces, which means it predates the feature. Update the engine.";
  }
  if (!cfConfigAdded) {
    return "Cloudflare configuration (DNS, WAF, zone and account settings) is not on offer because it has not been added as a source yet. Add it under Sources, then return here.";
  }
  if (accountCount === 0) {
    return "Cloudflare configuration is supported by this engine, but the discovery token could not read any account, so there is nothing to scope a configuration backup to. Give the token account read access under Sources.";
  }
  return "Cloudflare configuration is not on offer at the moment. Check the discovery token under Sources.";
}

// cfWithheldCatalogueClass is cfConfigWithheldReason's CLOSED-CLASS TWIN (G243): the same branches, in the same
// order, returning the frozen class instead of the prose. It is a separate pure function rather than a second
// return value so the prose and the class cannot drift apart silently: the validator drives BOTH over the same
// inputs and asserts they agree branch for branch.
//
// cf-catalogue-empty IS GATED ON `tokenPresent === true`, AND WITHOUT THAT GATE IT WAS THE COMMONEST FALSE ROW
// THE WIZARD COULD WRITE. Its vocabulary says one thing: this engine predates the cf-config feature, update the
// engine. That reading is true only on the TOKEN path, where GET /sources/discover returns
// `cfConfigSurfaces: cfConfigCatalogue()` from a STATIC COMPILED-IN list (no token state -- expired, rescoped,
// revoked -- can empty it). With NO discovery token the engine returns early with { bound, tokenPresent:false }
// and no capability fields at all, so the catalogue is absent because account discovery was never switched on.
// Account discovery is OPT-IN, so that is the DEFAULT state of the install base: ungated, every wizard render on
// a healthy, current, bound-sources-only engine wrote a row telling support to update it. That is the same fault
// the token-source module names and gates against (src/lib/token-source.ts: tokenSourceSkewFamilies returns []
// unless tier === true), and it is the fault this class exists to prevent, inverted.
//
// So with no token this returns NULL: the engine files its own no-token discovery observation server-side and
// the wizard tells the operator on screen, and neither of those is a catalogue fault. tokenPresent ABSENT (an
// engine that predates the account tier) is likewise not a catalogue fault: it is token-source-tier skew, which
// has its own producer.
//
// It returns NULL for the reason prose's catch-all branch ("not on offer at the moment") too, and that is
// deliberate rather than lazy. The caller cannot reach that branch today, but the function is public and total,
// and a classifier that answered `cf-no-accounts` for a state it had not actually established would put a row in
// the sealed pack asserting the discovery token cannot read an account when it plainly can. A class support can
// act on and that is WRONG is worse evidence than no class at all, so the caller records nothing here.
export function cfWithheldCatalogueClass(found: SourceDiscovery, cfConfigAdded: boolean, accountCount: number): ClientDiagCatalogueClass | null {
  if ((found.cfConfigSurfaces ?? []).length === 0) return found.tokenPresent === true ? "cf-catalogue-empty" : null;
  if (!cfConfigAdded) return "cf-not-added";
  if (accountCount === 0) return "cf-no-accounts";
  return null;
}

// appendSourceSections appends every offered source row to `list` and returns whether any row was
// added (which the caller uses to pick the list vs the empty state). Verbatim move of the old inner
// section-append block.
export function appendSourceSections(
  list: HTMLElement,
  found: SourceDiscovery,
  b: SectionBuilders,
): boolean {
  const { multiGroup, cfPresetControl, cfAccountRow, cfZoneGroup, selectWorkers, selectStream, selectImages, selectArtifacts } = b;

  // Gate the token-authenticated sections on what was ADDED on the Sources screen. found.addedSources is
  // the engine's record of which token source types the operator explicitly added; these need no binding,
  // so without this they were "always available" here even when nobody added them (the misalignment the
  // owner reported). An ABSENT field (an older engine, or the env-token IaC fallback) means UNGATED: keep
  // the legacy behaviour and offer every supported type. A PRESENT array gates: a type is offered only when
  // it was added, so this wizard mirrors the Sources screen, never a source nobody added.
  const gateAdded = found.addedSources !== undefined;
  const addedSet = new Set(found.addedSources ?? []);
  const isAdded = (t: string): boolean => !gateAdded || addedSet.has(t);

  // Group A: sources ALREADY attached to the engine, route with no token, as MULTI-SELECT checkbox
  // groups (filterable + All/None, so a fleet of hundreds is tick-all rather than one-at-a-time).
  // Each ticked store binding becomes its own downpipe; ticked SECRETS bundle into one Secrets
  // downpipe (the product model: named secrets read through their own bindings). A source that
  // already has a downpipe renders DISABLED with its badge (one downpipe per source).
  const bound = found.bound;
  let anyRow = false;
  const boundGroups: Array<{ type: "kv" | "r2" | "d1" | "secrets"; label: string; names: string[] }> = [
    { type: "kv", label: "KV namespaces", names: bound.kv },
    { type: "r2", label: "R2 buckets", names: bound.r2 },
    { type: "d1", label: "D1 databases", names: bound.d1 },
    { type: "secrets", label: "Secrets Store secrets", names: bound.secrets },
  ];
  const groupEls: HTMLElement[] = [];
  for (const g of boundGroups) {
    const el = multiGroup(g.type, g.label, g.names);
    if (el !== null) {
      anyRow = true;
      groupEls.push(el);
    }
  }
  if (groupEls.length > 0) {
    list.appendChild(h("span", { class: "field__label" }, "Attached sources (tick as many as you like)"));
    for (const el of groupEls) list.appendChild(el);
    list.appendChild(h("p", { class: "field__hint", style: HINT_INDENT },
      bound.secrets.length > 0
        ? "Each ticked source becomes its own downpipe; ticked secrets bundle into one Secrets downpipe. They share the schedule and destinations you pick next."
        : "Each ticked source becomes its own downpipe. They share the schedule and destinations you pick next."));
  }

  // Not-yet-attached sources are DELIBERATELY not listed here. A downpipe needs a LIVE engine
  // binding, so a store must be attached before it can be backed up; listing unattached stores
  // in the create flow only invites a broken downpipe (it would fail at run time with a source
  // binding error). Attaching belongs on the Sources screen (the catalogue, or "Attach a source
  // manually"); this wizard offers only what is ready to protect now: attached bindings (above)
  // and Cloudflare configuration (below).

  // Cloudflare configuration is offered whenever the ENGINE itself supports it, the engine
  // advertises that by returning the surface catalogue (cfConfigSurfaces). cf-config is
  // authenticated by the read-only discovery TOKEN, not a Workers binding, so it can back up
  // ANY account/zone the token can read; it must NEVER hide behind which account is the engine's
  // own. (The earlier gate on engineAccountId silently dropped this whole section for a
  // multi-account or under-scoped token, the engine leaves engineAccountId null until one
  // account is designated, so config vanished with no explanation.) Offer the scope preset, then
  // an account-wide tick-many row per discovered account (account-scoped surfaces: account
  // settings, Zero Trust, notifications, rulesets) plus each account's zones as a tick-many group
  // (DNS / WAF / zone settings): tick as many zones as you like, each becomes its own downpipe
  // (surfaces per the preset), so an N-zone customer bulk-creates in one pass instead of running
  // the wizard N times (the source-granularity audit's fix). When no zones list, say how to
  // broaden the token rather than dropping config.
  const cfSupported = (found.cfConfigSurfaces ?? []).length > 0 && isAdded("cf-config");
  const cfAccts = (found.accounts ?? []).map((a) => ({ accountId: a.accountId, accountName: a.accountName, zones: a.zones ?? [] }));
  if (cfAccts.length === 0 && found.engineAccountId) cfAccts.push({ accountId: found.engineAccountId, accountName: found.engineAccountId, zones: [] });
  if (cfSupported && cfAccts.length > 0) {
    anyRow = true;
    const multiAcct = cfAccts.length > 1;
    list.appendChild(h("span", { class: "field__label" }, "Cloudflare configuration"));
    list.appendChild(cfPresetControl());
    for (const acct of cfAccts) {
      const isEngine = found.engineAccountId != null && acct.accountId === found.engineAccountId;
      list.appendChild(cfAccountRow(acct.accountId, acct.accountName, isEngine, multiAcct));
      const zoneGroup = cfZoneGroup(acct.accountId, acct.zones);
      if (zoneGroup !== null) list.appendChild(zoneGroup);
    }
    if (!cfAccts.some((a) => a.zones.length > 0)) {
      // G243: PER-ZONE BACKUP WAS NOT OFFERED, and this branch recorded nothing at all. The three WITHHELD
      // classes below only fire when the whole Cloudflare section is dropped; a token that can read the account
      // but lists no zones keeps the section on offer, so none of them fires, the account-wide surfaces work, and
      // the zone half is simply absent. "Per-zone DNS/WAF backup is unavailable" is the ticket, the hint beside
      // it says so to whoever is looking at the screen, and it died with the render.
      //
      // THE ROW IS EMITTED ONLY OFF ACCOUNTS THE TOKEN ACTUALLY READ (`found.accounts`), never off cfAccts. Line
      // 169 above synthesises a placeholder account from engineAccountId when discovery returned NONE, and that
      // placeholder's `zones: []` is a HARD-CODED LITERAL that no token ever read. A row emitted from it would
      // assert "this token can read the account and sees no zones under it" about a token that read no account at
      // all: a fact the code never established, and the wrong one to act on. That state is cf-no-accounts.
      //
      // What the row does and does not say is in the vocabulary: it records the WITHHELD CAPABILITY (no zones were
      // offered) and does NOT establish the cause. An under-scoped token and an account that genuinely holds no
      // domains arrive here identically, because the engine hands the console the same empty zone list for both.
      // No token, account id or zone name rides: the class is the whole row.
      if ((found.accounts ?? []).length > 0) recordCatalogueDegraded("cf-zones-empty");
      list.appendChild(h("p", { class: "field__hint", style: HINT_INDENT },
        "No zones listed yet. To also back up per-zone DNS, WAF and zone settings, give the discovery token the \"Read all resources\" template under Sources. Account-wide configuration above works with the token you have."));
    }
  } else {
    // Cloudflare configuration is NOT on offer. It used to simply VANISH here, which is the same shape
    // on screen as "this product does not exist", so an operator whose discovery token had been
    // rescoped had no way to tell an under-scoped token from an old engine from a source nobody added.
    // Name which of the three it is. These are the only three reasons the section can be withheld, and
    // each has a different fix, so each gets its own sentence rather than one hedged catch-all.
    // G243: the wizard WITHHELD the Cloudflare-configuration offer, and this records which of the three
    // confusable reasons applied. The hint below says it to whoever is looking at the screen and dies with the
    // render; the row says it to support. "The wizard stopped offering Cloudflare configuration" is the ticket,
    // and an under-scoped token, an engine that predates the feature and a source that was never added are three
    // different remedies. No token, account id or surface name rides: the class is the whole row.
    const withheld = cfWithheldCatalogueClass(found, isAdded("cf-config"), cfAccts.length);
    if (withheld !== null) recordCatalogueDegraded(withheld);
    list.appendChild(h("p", { class: "field__hint", style: HINT_INDENT }, cfConfigWithheldReason(found, isAdded("cf-config"), cfAccts.length)));
  }

  // Workers scripts are offered whenever the ENGINE itself supports it, the engine advertises that
  // via found.workersSupported (exactly as cfConfigSurfaces gates cf-config). Like cf-config, the
  // workers source is authenticated by the read-only discovery TOKEN, not a binding, and is
  // account-scoped (Worker scripts are account-level, not per-zone), so it is offered as one row
  // PER discovered account, never gated on which account is the engine's own. The honest restore
  // posture (reprovision, secret bindings name-only) rides in the row's info-tip and the help line.
  if (found.workersSupported === true && isAdded("workers")) {
    const wkAccts = (found.accounts ?? []).map((a) => ({ accountId: a.accountId, accountName: a.accountName }));
    if (wkAccts.length === 0 && found.engineAccountId) wkAccts.push({ accountId: found.engineAccountId, accountName: found.engineAccountId });
    if (wkAccts.length > 0) {
      anyRow = true;
      const multiAcct = wkAccts.length > 1;
      list.appendChild(h("span", { class: "field__label" }, "Workers scripts"));
      for (const acct of wkAccts) {
        const isEngine = found.engineAccountId != null && acct.accountId === found.engineAccountId;
        list.appendChild(selectWorkers({
          rowId: `account-${acct.accountId}`,
          label: multiAcct
            ? `${acct.accountName}${isEngine ? " (this engine's account)" : ""}, Worker scripts`
            : "All Worker scripts (code, bindings metadata, version inventory)",
          accountId: acct.accountId,
          display: multiAcct ? `${acct.accountName} Workers` : "Workers scripts",
        }));
      }
      list.appendChild(h("p", { class: "field__hint", style: HINT_INDENT },
        "Backs up Worker code, bindings metadata and a version inventory. Secret bindings are captured by name only (a reprovision checklist, never values); restore is reprovision, you re-deploy the script, not a blind in-console write."));
    }
  }

  // Cloudflare Stream is offered whenever the engine supports it (found.streamSupported), exactly
  // like workers, account-scoped and token-authenticated. v1 captures the video metadata inventory.
  if (found.streamSupported === true && isAdded("stream")) {
    const stAccts = (found.accounts ?? []).map((a) => ({ accountId: a.accountId, accountName: a.accountName }));
    if (stAccts.length === 0 && found.engineAccountId) stAccts.push({ accountId: found.engineAccountId, accountName: found.engineAccountId });
    if (stAccts.length > 0) {
      anyRow = true;
      const multiAcct = stAccts.length > 1;
      list.appendChild(h("span", { class: "field__label" }, "Cloudflare Stream"));
      for (const acct of stAccts) {
        const isEngine = found.engineAccountId != null && acct.accountId === found.engineAccountId;
        list.appendChild(selectStream({
          rowId: `account-${acct.accountId}`,
          label: multiAcct
            ? `${acct.accountName}${isEngine ? " (this engine's account)" : ""}, Stream videos`
            : "All Stream videos (metadata inventory)",
          accountId: acct.accountId,
          display: multiAcct ? `${acct.accountName} Stream` : "Stream videos",
        }));
      }
      list.appendChild(h("p", { class: "field__hint", style: HINT_INDENT },
        "Backs up your Stream video inventory and metadata. Tick file contents below to also capture the video files and captions (size-gated). Restore is reprovision (you re-upload from the inventory), not a blind in-console write."));
    }
  }

  // Cloudflare Images is offered whenever the engine supports it (found.imagesSupported), exactly
  // like stream, account-scoped and token-authenticated. v1 captures the image metadata inventory.
  if (found.imagesSupported === true && isAdded("images")) {
    const imAccts = (found.accounts ?? []).map((a) => ({ accountId: a.accountId, accountName: a.accountName }));
    if (imAccts.length === 0 && found.engineAccountId) imAccts.push({ accountId: found.engineAccountId, accountName: found.engineAccountId });
    if (imAccts.length > 0) {
      anyRow = true;
      const multiAcct = imAccts.length > 1;
      list.appendChild(h("span", { class: "field__label" }, "Cloudflare Images"));
      for (const acct of imAccts) {
        const isEngine = found.engineAccountId != null && acct.accountId === found.engineAccountId;
        list.appendChild(selectImages({
          rowId: `account-${acct.accountId}`,
          label: multiAcct
            ? `${acct.accountName}${isEngine ? " (this engine's account)" : ""}, Images`
            : "All Images (metadata inventory + variants)",
          accountId: acct.accountId,
          display: multiAcct ? `${acct.accountName} Images` : "Images",
        }));
      }
      list.appendChild(h("p", { class: "field__hint", style: HINT_INDENT },
        "Backs up your Images inventory, metadata and variant config. Tick file contents below to also capture the image files (size-gated). Restore is reprovision (you re-upload from the inventory), not a blind in-console write."));
    }
  }

  // Cloudflare Artifact Registry is offered whenever the engine supports it (found.artifactsSupported),
  // exactly like images, account-scoped and token-authenticated. v1 captures the namespace/repo inventory.
  // It is additionally held behind the ARTIFACTS_GA beta gate (lib/token-source.ts): Artifact Registry is
  // a Cloudflare closed beta, so the wizard never offers it while the gate is false even if the engine
  // advertises artifactsSupported. The builder (selectArtifacts) and every downstream artifacts path stay
  // intact and dormant; flip ARTIFACTS_GA to true to offer it again.
  if (ARTIFACTS_GA && found.artifactsSupported === true && isAdded("artifacts")) {
    const arAccts = (found.accounts ?? []).map((a) => ({ accountId: a.accountId, accountName: a.accountName }));
    if (arAccts.length === 0 && found.engineAccountId) arAccts.push({ accountId: found.engineAccountId, accountName: found.engineAccountId });
    if (arAccts.length > 0) {
      anyRow = true;
      const multiAcct = arAccts.length > 1;
      list.appendChild(h("span", { class: "field__label" }, "Cloudflare Artifact Registry"));
      for (const acct of arAccts) {
        const isEngine = found.engineAccountId != null && acct.accountId === found.engineAccountId;
        list.appendChild(selectArtifacts({
          rowId: `account-${acct.accountId}`,
          label: multiAcct
            ? `${acct.accountName}${isEngine ? " (this engine's account)" : ""}, Artifact Registry`
            : "All Artifact Registry (namespace + repository inventory)",
          accountId: acct.accountId,
          display: multiAcct ? `${acct.accountName} Artifacts` : "Artifacts",
        }));
      }
      list.appendChild(h("p", { class: "field__hint", style: HINT_INDENT },
        "Backs up your Artifact Registry inventory: namespaces and repositories with their metadata. Tick file contents below to also capture the repository contents (size-gated). Restore is reprovision (you re-create and re-push from the inventory), not a blind in-console write."));
    }
  }

  return anyRow;
}
