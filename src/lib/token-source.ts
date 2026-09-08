// The pure logic behind offering the TOKEN-BASED sources (Cloudflare configuration, Workers scripts,
// Stream, Images and Artifacts) from the standalone "Add a source" screen, as well as from the
// create-downpipe wizard.
//
// Why this module exists, framework-free and DOM-free:
//   The five binding-free sources (cf-config, workers, stream, images, artifacts) are unlike the four BINDING sources
//   (kv / r2 / d1 / secrets). A binding source is REGISTERED as a wrangler binding by the
//   engine's safety harness (lib/add-source.ts computes the stanza; the engine attaches it).
//   All five binding-free sources (cf-config, workers, stream, images, artifacts) carry NO binding
//   and NO standalone source object: they are
//   authenticated by the engine's read-only DISCOVERY token and configured PER DOWNPIPE
//   (account / zone + the cf-config per-surface selection live on the downpipe). So
//   "adding" one is not an attach; it is a hand-off into the create-downpipe wizard with the
//   token-source pre-selected. This module holds the two load-bearing decisions that hand-off
//   needs, so the picker (src/screens/add-source.ts) and the wizard's prefill bridge
//   (src/screens/sources-downpipes.ts) share ONE implementation and a validator can unit
//   round-trip it without a DOM:
//     1. tokenSourceOffered(found): which token sources the deployed engine advertises
//        (cf-config when it returns a non-empty cfConfigSurfaces catalogue; workers when
//        workersSupported === true). This is the SAME engine-capability signal the wizard's
//        source step gates on, read off the SAME GET /admin/sources/discover response.
//     2. tokenSourceCreateQuery(opts): the exact create-route query string the picker
//        navigates to (/downpipes/new?type=cf-config&zone=... or
//        /downpipes/new?type=workers&account=... or /downpipes/new?type=stream&account=...,
//        the same shape for images and artifacts), built with URLSearchParams so it
//        round-trips cleanly through the wizard's prefillFromQuery.
//   Nothing here reaches the network, reads a token, or touches a value. It is the pure core;
//   the screen composes it with the picker chrome and the navigation.
//
// House: Australian English, no em dashes, precise claims.

import type { SourceDiscovery } from "../api.ts";

// TokenSourceType is the closed set of binding-FREE sources: authenticated by the read-only
// discovery token, carrying no wrangler binding and no standalone source object. It is a strict
// subset of SourceSpec["type"] (api.ts), the members that are NOT one of the four bindings.
export type TokenSourceType = "cf-config" | "workers" | "stream" | "images" | "artifacts";

// TOKEN_SOURCE_TYPES is the value-level companion (the union is type-only): the order the picker
// appends them in, after the four bindings. Kept in lockstep with TokenSourceType.
export const TOKEN_SOURCE_TYPES: readonly TokenSourceType[] = ["cf-config", "workers", "stream", "images", "artifacts"];

// TokenSourceMeta is the picker copy for a token source: the human label, and the HONEST one-line
// summary that states the credential model (token-based, no binding) and the restore caveat for
// workers (reprovision). The icon is screen-local (an in-repo SVG constant), so it is not here.
export interface TokenSourceMeta {
  label: string;
  summary: string;
}

// TOKEN_SOURCE_META carries the label + one-line summary per token source. The summaries are the
// exact, honest claims the build brief specifies: cf-config is zone & account settings, token-based
// with no binding; workers is Worker scripts, token-based with no binding, and restore is reprovision
// (you re-deploy the script), never a one-click in-console write, so the copy can never overclaim.
export const TOKEN_SOURCE_META: Record<TokenSourceType, TokenSourceMeta> = {
  "cf-config": {
    label: "Cloudflare config",
    summary: "Back up Cloudflare zone & account settings, token-based, no binding.",
  },
  workers: {
    label: "Workers",
    summary: "Back up Worker scripts, token-based, no binding; restore is reprovision.",
  },
  stream: {
    label: "Stream",
    summary: "Back up Cloudflare Stream video metadata (and optionally the video files), token-based, no binding; restore is reprovision.",
  },
  images: {
    label: "Images",
    summary: "Back up Cloudflare Images metadata + variant config (and optionally the image files), token-based, no binding; restore is reprovision.",
  },
  artifacts: {
    label: "Artifacts",
    summary: "Back up Cloudflare Artifact Registry namespaces & repositories (and optionally the repository contents), token-based, no binding; restore is reprovision.",
  },
};

// tokenSourceLabel / tokenSourceSummary are the small accessors over TOKEN_SOURCE_META (so a caller
// reads one field without destructuring the record).
export function tokenSourceLabel(t: TokenSourceType): string {
  return TOKEN_SOURCE_META[t].label;
}
export function tokenSourceSummary(t: TokenSourceType): string {
  return TOKEN_SOURCE_META[t].summary;
}

// ARTIFACTS_GA is the beta gate for the Cloudflare Artifact Registry source. Artifact Registry is a
// Cloudflare CLOSED BETA that almost no account can reach, and its backup cannot yet be verified end
// to end, so the console does NOT offer or let a user select it as a source while this flag is false.
// This is a gate, not a deletion: every artifacts code path (the source spec, the wizard row builder,
// the restore flow, the map node and the Overview coverage advert) stays intact and dormant behind
// this one flag. Fail-safe: hidden while false.
//
// IT IS NOT THE AUTHORITY. The engine's SELECTABLE_SOURCE_TYPES (sched/config-validate.ts) decides what a
// downpipe config may name, and it omits "artifacts" for the same reason. Flipping this flag ALONE would
// offer the operator a source the engine then refuses at save, which is a source they can pick and never
// protect. test/validate-source-type-parity.ts fails on exactly that combination, so the two open together
// or not at all. Flip this when the engine's list gains "artifacts", not before.
export const ARTIFACTS_GA = false;

// tokenSourceOffered decides, from the engine's discovery response, which token sources to OFFER in
// the picker. It mirrors EXACTLY the gates the create-downpipe wizard's source step uses
// (sources-downpipes.ts): cf-config is offered when the engine returns a non-empty cfConfigSurfaces
// catalogue (the engine advertises the cf-config adapter that way); workers is offered when
// workersSupported is the literal true; stream and images are each offered when their streamSupported /
// imagesSupported flag is the literal true. Artifact Registry is additionally held behind the
// ARTIFACTS_GA beta gate, so it is never offered while the source is in closed beta even if the engine
// advertises artifactsSupported. An OLDER engine that returns none of the flags hides them all cleanly,
// so the picker degrades to the four bindings with no error. Pure; never throws; never inspects a token.
//
// `found` is optional so a FAILED discovery fetch (passed as undefined) offers none of the token sources:
// the picker falls back to the four bindings rather than erroring (the build brief's fail-soft rule).
export function tokenSourceOffered(found: SourceDiscovery | undefined): Record<TokenSourceType, boolean> {
  const cfConfig = (found?.cfConfigSurfaces ?? []).length > 0;
  const workers = found?.workersSupported === true;
  const stream = found?.streamSupported === true;
  const images = found?.imagesSupported === true;
  const artifacts = ARTIFACTS_GA && found?.artifactsSupported === true;
  return { "cf-config": cfConfig, workers, stream, images, artifacts };
}

// TokenSourceSkewFamily is the closed set of contract-skew field families the predicate below can report. Each
// names ONE capability the deployed engine did not advertise, and each is a DIFFERENT symptom with a different
// blast radius: the customer whose Workers source vanished from Add a source and the customer whose Stream
// source vanished report different tickets and lose different backups.
export type TokenSourceSkewFamily =
  | "token-source-tier"
  | "token-source-cf-config"
  | "token-source-workers"
  | "token-source-stream"
  | "token-source-images";

// tokenSourceSkewFamilies reads the discovery response for evidence of an OLDER ENGINE, and it reports
// WHICH capabilities are missing, one family per capability, not a single all-or-nothing verdict.
//
// A current engine on the token path advertises every one of them: router-discovery.ts answers cfConfigSurfaces
// plus workersSupported / streamSupported / imagesSupported as LITERAL TRUE on that path, unconditionally. So a
// present token beside a missing capability can only be an engine that predates it. That is the
// "our Workers source disappeared after the update" ticket, and the remedy is to roll the engine forward.
//
// WHY PER-CAPABILITY AND NOT ALL-OR-NOTHING. The first cut fired only when ALL FOUR were absent, and the four
// flags landed on four different dates (tokenPresent 11 Jun, cfConfigSurfaces 13 Jun, workersSupported 18 Jun,
// stream/imagesSupported 20 Jun). Every engine build between those dates advertises a strict SUBSET, and a
// subset is not zero: an engine that offers cf-config but not Workers produced NO ROW AT ALL and was
// byte-identical in the pack to a healthy, current engine. Those subset builds are precisely what a rollback
// lands on, so the one state the gap exists to catch was the one state that recorded nothing, while the only
// state that did record was a two-day slice of engine history. The missing capability is now the discriminator,
// and because fieldFamily is part of the ring's tuple key, "cf-config only" (3 rows) and "cf-config + workers"
// (2 rows) and "none at all" (4 rows) are three distinguishable pack readings.
//
// THE tokenPresent GATE. Account discovery is OPT-IN, so tokenPresent false is the DEFAULT, and the engine's
// no-token branch returns none of the capability flags either. Testing the flags alone therefore called a
// healthy, current, correctly-configured engine "version skew" for every customer who had simply never stored a
// read-only Cloudflare token. The no-token state needs no row from the browser: the engine records it itself as
// a no-token discovery observation, and the screen tells the operator so.
//
// tokenPresent ABSENT is not the same as tokenPresent false, and it gets its own family. Both of the engine's
// discovery branches emit the field (false at router-discovery.ts:194, true at :247), so a current engine always
// sends it; a response that omits it altogether is an engine that predates the account tier entirely. That is
// the OLDEST and most skewed engine there is, and the first cut SILENCED it: the `!== true` gate swallowed the
// undefined and it read exactly like the healthy no-token default. The family asserts only what the code
// established, that the response carried no account-tier field, and never that a token exists (on this engine
// the console cannot know). The wire is read defensively because the wire is untrusted: the response is a bare
// JSON cast, so the declared `boolean` is a promise about a current engine, not a fact about this one.
//
// ARTIFACTS IS DELIBERATELY NOT HERE. The engine advertises artifactsSupported, and the console suppresses the
// Artifacts source itself behind the ARTIFACTS_GA beta gate, so its absence from the picker is the console's own
// decision and not engine skew. A family for it would fire on every healthy engine.
//
// Pure, exported and DOM-free, because the predicate is the thing that has to be right: a validator drives THIS
// rather than the recorder.
export function tokenSourceSkewFamilies(found: SourceDiscovery | undefined): TokenSourceSkewFamily[] {
  if (found === undefined) return []; // a FAILED read: its own state, handled by the screen's error branch
  const tier: unknown = (found as { tokenPresent?: unknown }).tokenPresent;
  if (tier === undefined) return ["token-source-tier"]; // an engine older than the account tier itself
  if (tier !== true) return []; // no discovery token: the healthy, opt-in default
  const skew: TokenSourceSkewFamily[] = [];
  if ((found.cfConfigSurfaces ?? []).length === 0) skew.push("token-source-cf-config");
  if (found.workersSupported !== true) skew.push("token-source-workers");
  if (found.streamSupported !== true) skew.push("token-source-stream");
  if (found.imagesSupported !== true) skew.push("token-source-images");
  return skew;
}

// TokenSourceCreateOpts is the input to tokenSourceCreateQuery: the token source type plus its
// OPTIONAL pre-selection. cf-config may carry a zone (an account-only config downpipe omits it) and,
// like the others, the Cloudflare account. Every field is optional because the picker hands off the
// TYPE and lets the wizard collect the account/zone/selection + destination + schedule. Empty /
// whitespace fields are dropped.
export interface TokenSourceCreateOpts {
  type: TokenSourceType;
  account?: string;
  zone?: string;
}

// tokenSourceCreateQuery builds the create-route QUERY STRING (no leading "?") the picker navigates
// to so the wizard opens with this token source pre-selected. It always carries type; it carries
// account for ANY type when the caller supplies a non-empty value (cf-config, workers, stream, images
// and artifacts all round-trip account), and zone only for cf-config. stream, images and artifacts
// carry only account (no zone or prefix). The keys match the wizard's prefillFromQuery reader EXACTLY
// (type / account / zone), so the hand-off round-trips. zone is only ever emitted for cf-config, so it
// can never leak onto another source shape. Pure; never throws.
export function tokenSourceCreateQuery(opts: TokenSourceCreateOpts): string {
  const qs = new URLSearchParams();
  qs.set("type", opts.type);
  const account = (opts.account ?? "").trim();
  if (account !== "") qs.set("account", account);
  if (opts.type === "cf-config") {
    const zone = (opts.zone ?? "").trim();
    if (zone !== "") qs.set("zone", zone);
  }
  return qs.toString();
}

// tokenSourceCreatePath is the convenience wrapper that prefixes the create route, returning the full
// path the picker hands off to (e.g. "/downpipes/new?type=cf-config"). Kept here so the route string
// lives next to the query builder and a test asserts the whole hand-off target in one place.
export function tokenSourceCreatePath(opts: TokenSourceCreateOpts): string {
  return `/downpipes/new?${tokenSourceCreateQuery(opts)}`;
}

// isTokenSourceType is the type guard the wizard's prefill reader uses to narrow a raw query `type`
// value to a TokenSourceType (so prefillFromQuery honours type=cf-config / type=workers exactly like
// it already honours the four binding types).
export function isTokenSourceType(t: string | null | undefined): t is TokenSourceType {
  return t === "cf-config" || t === "workers" || t === "stream" || t === "images" || t === "artifacts";
}
