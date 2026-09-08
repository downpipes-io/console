// Deriving each vendor tile's state (live / configured / available) from the FOUR config systems a destination
// can live in: the SIEM audit-log push (a singleton), the OTLP metrics push (a singleton), the support pull
// credentials (per scope), and the notify channels (a list, one-or-more per kind). This is the integration
// sibling of idp-connections/grid.ts's tileState(), which derives the same three states from IdP connections.
//
// Every function here is pure and builds no DOM, so test/validate-integrations.ts drives them directly. It
// imports one predicate from the Notifications screen (downpipeScopeIsMissing), which is itself DOM-free and
// touches no document at module load, so the purity of this module is unchanged by the reuse. The engine reads
// it consumes are the redaction-safe VIEW types (never a secret).
//
// A note on singletons: the SIEM push is ONE destination, not one-per-vendor, so at most one SIEM tile can
// hold it. Identity comes from the config's own `vendor` tag, which the console writes when the operator sets
// the destination up from a vendor tile and the engine echoes in its redacted view.
//
// WHY IT IS NOT THE WIRE. Until a tile claimed the push when the live format AND sink matched its
// own, and that pair is not injective over this catalogue: Splunk and CrowdStrike Falcon Next-Gen SIEM both
// take splunk-hec over http, so ONE live Splunk push rendered BOTH tiles Active and both panels claimed the
// same config as their own. Vendors that genuinely share a wire and are genuinely interchangeable on it (CEF
// over syslog-TLS backs QRadar, ArcSight, FortiSIEM, LogRhythm and Securonix) are a different case from two
// vendors whose credentials are shaped differently, and the wire cannot tell them apart.
//
// THE UNTAGGED CASE IS NAMED, NOT GUESSED. A push stored before the tag existed carries no vendor, and
// pushOwnedBy then falls back to the wire match, which is what the operator has been looking at all along, so
// an existing destination keeps its tile. That fallback is the ONLY place the old ambiguity survives, it is
// self-clearing (any Replace writes the tag), and the vendor-specific credential guidance no longer rides on
// it: that keys off the vendor's own credScheme, so a shared wire cannot put Splunk's instruction on
// CrowdStrike's form.
//
// House rules: Australian English, no em dashes, precise claims.

import type { PushDestinationView, OtlpPushDestinationView, SupportStatus, NotifyChannel, NotifyRule, DownpipeState } from "../../api.ts";
import { downpipeScopeIsMissing } from "../notifications/shared.ts";
import { CATALOGUE, type Vendor, vendorSlug } from "./catalogue.ts";
import type { TileState } from "./grid.ts";

// The config reads the coordinator fans out, each nullable/empty so a partial/failed read degrades to
// "available" for that family rather than throwing (the coordinator surfaces a load error separately). rules +
// downpipes back the notify routing surface (which events reach a connected chat/ITSM channel).
export interface ConfigSnapshot {
  push: PushDestinationView | null;
  otlp: OtlpPushDestinationView | null;
  support: SupportStatus | null;
  channels: NotifyChannel[];
  rules: NotifyRule[];
  downpipes: DownpipeState[];
}

// onOff folds a present/enabled pair into the shared three-state result.
function onOff(present: boolean, enabled: boolean): TileState {
  if (!present) return "available";
  return enabled ? "live" : "configured";
}

// namedPushMatches reports whether the live push destination belongs to a NAMED catalogue vendor, so the Custom
// tile can stand down. A tagged config names its vendor outright; an untagged one falls back to the wire match.
function namedPushMatches(p: NonNullable<ConfigSnapshot["push"]>): boolean {
  if (p.vendor !== undefined) return CATALOGUE.some((v) => v.kind === "push" && !v.custom && vendorSlug(v) === p.vendor);
  return CATALOGUE.some((v) => v.kind === "push" && !v.custom && v.pushFormat === p.format && (v.pushSink ?? "http") === (p.sink ?? "http"));
}

// pushOwnedBy answers whether a given live push destination belongs to THIS vendor's tile. A TAGGED config
// answers by identity: exactly the tile whose slug the config records, and no other. An UNTAGGED config (stored
// before the tag existed) falls back to the wire match, which is the state the operator has already been
// reading. The Custom tile owns the push only when no named vendor does, on whichever of the two answers
// applies. The push panel uses this to show the active config as this tile's own, or a clean "set up" state on
// every tile that is not the active one (the audit push is a single destination, so without this every SIEM tile
// would render the same active config).
export function pushOwnedBy(v: Vendor, view: NonNullable<ConfigSnapshot["push"]>): boolean {
  if (v.kind !== "push" || !view.present) return false;
  if (v.custom) return !namedPushMatches(view);
  if (view.vendor !== undefined) return view.vendor === vendorSlug(v);
  return view.format === v.pushFormat && (view.sink ?? "http") === (v.pushSink ?? "http");
}

// vendorState maps one vendor onto its state, reading only the config family its SetupKind belongs to.
export function vendorState(v: Vendor, snap: ConfigSnapshot): TileState {
  switch (v.kind) {
    case "push": {
      const p = snap.push;
      if (v.custom) {
        // The Custom tile owns the push only when its format+sink match NO named catalogue vendor (otherwise
        // that named vendor's tile owns it, and Custom stays available).
        if (!p?.present) return "available";
        return namedPushMatches(p) ? "available" : onOff(true, Boolean(p.enabled));
      }
      // Identity, not the wire: pushOwnedBy is the ONE answer to "is this tile's vendor the live push", so the
      // tile state and the panel body can never disagree about it (they used to hold separate comparisons).
      const matches = Boolean(p?.present) && pushOwnedBy(v, p as NonNullable<ConfigSnapshot["push"]>);
      return onOff(matches, Boolean(p?.enabled));
    }
    case "metrics-push": {
      const o = snap.otlp;
      return onOff(Boolean(o?.present), Boolean(o?.enabled));
    }
    case "pull": {
      // The pull SIEM vendors (Sentinel, Cribl, Exabeam) all read the audit-feed scope, so the audit-feed
      // grant lights any of them. An expired grant still exists but is refused, so it reads as "configured".
      // A grant whose stored expiry cannot be read (SupportGrantView.expiryUnreadable) is refused too, and
      // the engine answers `expired: true` for it, so it lands on the same "configured", which is the right
      // answer to the question a TILE asks. TileState is a closed three-member setup vocabulary and it holds
      // no room for a CAUSE; the tile is deliberately coarse here and the panel below it is not. The cause is
      // named once, in supportGrantPresentation, which this tile's own panel body renders through
      // renderPullCredentials, so no second mechanism decides it.
      const g = snap.support?.auditFeed;
      return onOff(Boolean(g), Boolean(g && !g.expired));
    }
    case "metrics": {
      // The pull metrics vendors (Prometheus, Grafana, ...) all scrape /metrics with the metrics-scope token.
      // Same three-state reading as the audit-feed arm above, and the same panel names the cause.
      const g = snap.support?.metrics ?? null;
      return onOff(Boolean(g), Boolean(g && !g.expired));
    }
    case "notify": {
      const of = snap.channels.filter((c) => c.kind === v.channelKind);
      if (of.length === 0) return "available";
      return of.some((c) => c.enabled) ? "live" : "configured";
    }
    default:
      return "available";
  }
}

// notifyChannelsFor returns the existing channels of a notify vendor's kind, so its panel can list/edit them.
export function notifyChannelsFor(v: Vendor, channels: NotifyChannel[]): NotifyChannel[] {
  if (v.kind !== "notify") return [];
  return channels.filter((c) => c.kind === v.channelKind);
}

// routeIsInert answers whether a rule that NAMES one of this vendor's channels has stopped delivering to it.
// Two ways it can survive and reach nobody:
//   - it is turned off (enabled: false), so it never matches; and
//   - it is scoped to a DELETED downpipe. Removing a downpipe drops the downpipe, its history and its
//     replication state, and deliberately does not prune the notify rules scoped to it (that leniency is the
//     engine's, and it is correct). Such a rule survives and matches nothing forever, because the engine's
//     ruleSelects compares an emission's downpipeId to the rule's and no emission carries the dead id again.
//
// downpipeScopeIsMissing is REUSED from the Notifications screen rather than re-derived, so the two surfaces
// that read the same rules cannot drift. It returns false for an EMPTY downpipe list, which is load-bearing
// here: the coordinator's downpipe read is best-effort and defaults to [], and a failed read must claim
// nothing rather than declare every per-downpipe scope dead.
export function routeIsInert(r: NotifyRule, downpipes: readonly DownpipeState[]): boolean {
  return !r.enabled || downpipeScopeIsMissing(r.scope, downpipes);
}

// VendorRoutes splits the rules naming this vendor's channels by whether they can actually fire. The panel's
// headline claim is about `live` only; `inert` is what it has to say out loud instead of counting silently.
export interface VendorRoutes {
  live: NotifyRule[];
  inert: NotifyRule[];
}

// rulesForVendor returns the alert-routing rules that deliver to any of this vendor's channels, split by
// whether they can still fire, so the panel can show whether anything really reaches a connected chat/ITSM
// channel. A channel whose only rules are inert reaches nobody, exactly like a channel with no rule at all,
// and the undivided count used to hide that: it printed "1 alert rule routes events to Slack" for a rule
// scoped to a downpipe the operator had deleted, and suppressed both the warning and the fix-it action.
export function rulesForVendor(v: Vendor, snap: ConfigSnapshot): VendorRoutes {
  const ids = new Set(notifyChannelsFor(v, snap.channels).map((c) => c.id));
  if (ids.size === 0) return { live: [], inert: [] };
  const matching = snap.rules.filter((r) => r.channelIds.some((id) => ids.has(id)));
  return {
    live: matching.filter((r) => !routeIsInert(r, snap.downpipes)),
    inert: matching.filter((r) => routeIsInert(r, snap.downpipes)),
  };
}

// inertRouteReason names why ONE surviving rule delivers nothing, keeping the stored ids visible (the rule's
// own id, and the dead downpipe id) so the operator can find the row rather than hunt for it. A rule that is
// both turned off and scoped to a deleted downpipe reports the dead scope, because that is the one an operator
// cannot fix with a toggle.
export function inertRouteReason(r: NotifyRule, downpipes: readonly DownpipeState[]): string {
  if (r.scope.kind === "downpipe" && downpipeScopeIsMissing(r.scope, downpipes)) {
    return `${r.id} is scoped to downpipe ${r.scope.downpipeId}, which no longer exists`;
  }
  return `${r.id} is turned off`;
}

// MAX_INERT_NAMED caps how many dead routes the panel names before a "+N more" tail, keeping the panel inside
// the calm-density budget. The Notifications rules tab is where the full list lives.
const MAX_INERT_NAMED = 3;

// inertRoutesText is the sentence the panel adds when rules name this vendor's channels but deliver nothing,
// or null when there are none. Pure, so the validator asserts the wording and the ids without a DOM.
export function inertRoutesText(v: Vendor, routes: VendorRoutes, downpipes: readonly DownpipeState[]): string | null {
  const n = routes.inert.length;
  if (n === 0) return null;
  const named = routes.inert.slice(0, MAX_INERT_NAMED).map((r) => inertRouteReason(r, downpipes));
  const more = n - named.length;
  const tail = more > 0 ? `, and ${more} more` : "";
  const lead = n === 1 ? `1 alert rule names a ${v.name} channel but delivers nothing` : `${n} alert rules name a ${v.name} channel but deliver nothing`;
  return `${lead}: ${named.join("; ")}${tail}. Repair ${n === 1 ? "it" : "them"} on the Notifications rules tab.`;
}

// noLiveRouteText is the warning shown when nothing reaches this vendor's channels. It separates the two
// reasons, because "no alert rule sends events to it YET" is untrue when a rule exists and has stopped
// working, and that wording sends the operator to create a second rule beside a broken one.
export function noLiveRouteText(v: Vendor, routes: VendorRoutes): string {
  if (routes.inert.length > 0) {
    return `This channel is connected, but nothing reaches it: every alert rule naming it has stopped delivering. Repair those rules, or choose what should alert ${v.name}.`;
  }
  return `This channel is connected, but no alert rule sends events to it yet, so nothing reaches it. Choose what should alert ${v.name}.`;
}
