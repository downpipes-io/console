// Volume-based licensing (self-serve tiers): the pure, DOM-free logic behind the Licence card's two
// quiet estate/band sentences. Split out as its own leaf (shared.ts sits at the max-lines guardrail)
// rather than added there, matching the family's own precedent for a small, cohesive sub-feature
// (update-outcome-copy.ts, update-ramp.ts and friends). Every function here is pure so the validator
// exercises it directly in Node, with no DOM.
//
// The two sentences, and the calm-density rule they both keep: quiet plain
// text, no colour, no badge, no motion, nothing that implies the licence gates anything (fail-open
// holds regardless of estate or band).
//   - the ESTATE line renders whenever the engine reports a measured estate: "Your estate measures
//     about {X} across {N} account(s)." -- always shown when estate is present, independent of band.
//     "account(s)" here is the engine's own measured count of distinct source accounts; it is a
//     different figure from the band line's estate count below, so it keeps its own word.
//   - the BAND line renders only when the token's features[] carry a COMPLETE band triple
//     (band:<tier>, estates:<n>, protected-gb:<n>): "Your {Tier} tier covers {N} estate(s) and
//     {Y} GB of protected data." A missing or malformed piece means the whole line is withheld
//     (never a partially-guessed sentence) -- see parseBandFeatures. Wording, word order and
//     number formatting (thousands separators, no GB/TB unit switch) match this sentence's two
//     other surfaces verbatim: control-plane's bandCoversPhrase (the activation/renewal emails)
// and the self-serve terms page (the email's wording was made canonical, this line now matches it).
//   - the OVER-BAND line follows the band line, and ONLY it, when the measured estate has grown
//     past what the band covers (more accounts than the pack allows, or more protected data than
//     it allows): one calm sentence, no link, no call to action beyond "contact support".
//
// House rules: Australian English, no em dashes, precise claims.

import { tierDisplayName } from "../../lib/billing.ts";
import { groupNumber } from "../../lib/format.ts";
import type { EstateSummary } from "../../api.ts";

// BandInfo is the volume-licensing band parsed off a licence's features[] strings: the tier the pack
// is named for, how many estates it covers, and how much protected data (in GB) it covers. An msp
// licence's estates/protectedGb are already the MULTIPLIED total (e.g. estates:3 protected-gb:3000
// for a 3x pack, off control-plane's 1-estate/1,000 GB base pack), so nothing here needs
// pack-multiple arithmetic -- it just reads the numbers off the token verbatim. Field named
// "estates" (not "accounts") to match the wire feature key control-plane
// actually emits (issue.ts's tierToFeatures: `estates:${band.estates}`) and the word every other
// surface uses for this figure (bandCoversPhrase, the pricing page). An earlier version of this file
// read a feature key ("accounts:") control-plane has never emitted, so parseBandFeatures's
// all-or-nothing check silently failed the triple on every real licence and the band line never
// rendered for any customer; fixed alongside the wording alignment since it is the same triple.
export interface BandInfo {
  tier: string;
  estates: number;
  protectedGb: number;
}

// ESTATE_OVER_BAND_LINE is the one calm sentence that follows the band line when the measured
// estate has outgrown it. No colour, no icon, no link (calm-density §7a): the fix is a human
// conversation at the next support contact, not a self-service upsell click.
export const ESTATE_OVER_BAND_LINE =
  "Your estate has grown past this band; when you next contact support we will suggest the right tier." as const;

const BYTES_PER_GB = 1024 ** 3;

// gbLabel renders a GB quantity as this pair of sentences' shared size phrase: one decimal place in
// GB, switching to TB once the quantity reaches 1000 GB. The GB->TB step is still /1024 (binary,
// consistent with lib/format.ts's humanBytes chain); 1000 is only the READABILITY threshold for when
// to switch units, not a change of base, so a value just past it still reads as a clean "~1.0 TB".
function gbLabel(gb: number): string {
  if (gb < 1000) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(1)} TB`;
}

// estateSizeLabel renders a measured byte total (EstateSummary.totalProtectedBytes) as the estate
// line's {X}. Pure; exported so the validator pins the GB/TB switchover directly.
export function estateSizeLabel(totalProtectedBytes: number): string {
  return gbLabel(totalProtectedBytes / BYTES_PER_GB);
}

// bandSizeLabel renders a band's already-in-GB allowance (BandInfo.protectedGb, off the token's
// protected-gb:<n> feature) as the band line's {Y}: a plain GB figure with thousands separators, no
// GB/TB unit switch. Deliberately NOT gbLabel/estateSizeLabel's format: this figure has to match
// bandCoversPhrase's rendering of the identical number in the licence emails byte-for-byte,
// which cross-surface agreement outranks matching the estate
// line's own, differently-sourced, continuously-measured figure.
export function bandSizeLabel(protectedGb: number): string {
  return `${groupNumber(protectedGb)} GB`;
}

// accountWord pluralises "account" the same way this screen family already does elsewhere
// (billing.ts's renewalSentence: `${days} ${days === 1 ? "day" : "days"}`). Used by the ESTATE
// line only; the BAND line's estate count uses estateWord below (a different concept, same shape).
function accountWord(n: number): string {
  return n === 1 ? "account" : "accounts";
}

// estateWord pluralises "estate" for the band line, matching control-plane's bandCoversPhrase
// (email-templates.ts) so a customer reads the identical word in the console and in the email.
function estateWord(n: number): string {
  return n === 1 ? "estate" : "estates";
}

// estateSummaryLine renders the Licence card's estate line, or null when there is nothing honest to
// say: the engine reports no estate at all (absent field, or explicit null on an account with no
// completed run yet), or a malformed partial estate (a non-finite/negative byte or account count --
// the type promises a full EstateSummary, the wire does not; honest-degrade).
export function estateSummaryLine(estate: EstateSummary | null | undefined): string | null {
  if (!estate) return null;
  const { totalProtectedBytes, accounts } = estate;
  if (typeof totalProtectedBytes !== "number" || !Number.isFinite(totalProtectedBytes) || totalProtectedBytes < 0) return null;
  if (typeof accounts !== "number" || !Number.isFinite(accounts) || accounts < 0) return null;
  // The engine counts DISTINCT account ids off source selectors, and binding-scoped sources (kv/r2/
  // d1/secrets) carry no accountId at all -- so an estate made only of those measures accounts:0
  // while living in exactly one account: the engine's own. Flooring the DISPLAYED count at one when
  // any downpipe exists keeps the sentence honest ("across 1 account", which is where those sources
  // live) instead of the absurd "across 0 accounts"; the raw figure still travels untouched in the
  // support pack, and band comparisons elsewhere use the raw value.
  const downpipes = typeof estate.downpipes === "number" && Number.isFinite(estate.downpipes) ? estate.downpipes : 0;
  const shownAccounts = accounts === 0 && downpipes > 0 ? 1 : accounts;
  return `Your estate measures about ${estateSizeLabel(totalProtectedBytes)} across ${shownAccounts} ${accountWord(shownAccounts)}.`;
}

// estateFiguresUnreadable separates estateSummaryLine's two null cases, which are NOT the same thing:
// "the engine reports no estate at all" (absent, or null on an account with no completed run) is a
// calm nothing, but "the engine reported an estate whose figures do not parse" (a non-finite or
// negative byte/account count) is a FAULT that currently renders as the SAME calm nothing. This
// predicate is true only for the second, so the screen can say the figures could not be read rather
// than showing the silence that reads as "nothing to report". The malformed value is never rendered,
// only the verdict. Pure; exported for the validator.
export function estateFiguresUnreadable(estate: EstateSummary | null | undefined): boolean {
  if (!estate) return false;
  const { totalProtectedBytes, accounts } = estate;
  if (typeof totalProtectedBytes !== "number" || !Number.isFinite(totalProtectedBytes) || totalProtectedBytes < 0) return true;
  if (typeof accounts !== "number" || !Number.isFinite(accounts) || accounts < 0) return true;
  return false;
}

// ESTATE_UNREADABLE_LINE is what the Licence card says when estateFiguresUnreadable is true.
export const ESTATE_UNREADABLE_LINE =
  "Your engine reported estate figures the console cannot read, so the estate size and the over-band check are not shown. The raw figures still travel in a support pack.";

// bandFeaturesMalformed is true when the licence's features[] CLAIM a volume band (a band: string is
// present) but the triple does not parse completely (a missing estates:/protected-gb: piece, or a
// non-numeric/negative one). parseBandFeatures is deliberately all-or-nothing and returns null for
// that case, which renders identically to a licence that simply carries no band at all: a MIS-MINTED
// token therefore looks exactly like an ordinary one, and neither the band line nor the over-band
// nudge ever appears. This predicate is the difference between those two, so the screen can say so.
// Pure; the offending feature strings are never rendered, only the verdict.
export function bandFeaturesMalformed(features: string[] | undefined): boolean {
  if (!Array.isArray(features)) return false;
  if (extractFeatureValue(features, "band:") === null) return false; // no band claimed: nothing is wrong
  return parseBandFeatures(features) === null;
}

// BAND_MALFORMED_LINE is what the Licence card says when bandFeaturesMalformed is true.
export const BAND_MALFORMED_LINE =
  "This licence claims a volume band the console cannot read, so the band line and the over-band check are not shown. Re-activate with the token from your activation email, and contact support if it keeps happening.";

// extractFeatureValue returns the trimmed value after the first feature string carrying `prefix`
// (e.g. "band:"), or null when no such string is present or its value is empty. Only the first match
// counts (a duplicate/conflicting second string is ignored rather than overriding).
function extractFeatureValue(features: string[], prefix: string): string | null {
  for (const f of features) {
    if (typeof f !== "string" || !f.startsWith(prefix)) continue;
    const value = f.slice(prefix.length).trim();
    if (value.length > 0) return value;
  }
  return null;
}

// parseBandFeatures reads the volume-licensing band off a licence's features[] strings
// (band:<tier>, estates:<n>, protected-gb:<n>), or null when the triple is not COMPLETELY and
// validly present -- the task's defensive rule: a missing piece or a malformed number means show
// nothing extra, never a partially-guessed sentence. The tier id itself is accepted as any non-empty
// string (an id this console build does not recognise still renders honestly via
// tierDisplayName's title-case fallback, rather than being treated as malformed). Reads "estates:",
// the key control-plane's tierToFeatures actually emits (issue.ts:314) -- an earlier version of
// this parser read "accounts:", a key that has never existed on the wire, so it withheld the band
// line and the over-band check on every real licence.
export function parseBandFeatures(features: string[] | undefined): BandInfo | null {
  if (!Array.isArray(features)) return null;
  const tier = extractFeatureValue(features, "band:");
  const estatesRaw = extractFeatureValue(features, "estates:");
  const protectedGbRaw = extractFeatureValue(features, "protected-gb:");
  if (tier === null || estatesRaw === null || protectedGbRaw === null) return null;
  const estates = Number(estatesRaw);
  const protectedGb = Number(protectedGbRaw);
  if (!Number.isFinite(estates) || estates < 0) return null;
  if (!Number.isFinite(protectedGb) || protectedGb < 0) return null;
  return { tier, estates, protectedGb };
}

// bandSummaryLine renders the Licence card's band line from an already-parsed BandInfo (the caller
// only calls this once parseBandFeatures has returned non-null). Wording, order and number format
// match control-plane's bandCoversPhrase verbatim (see the file header note).
export function bandSummaryLine(band: BandInfo): string {
  return `Your ${tierDisplayName(band.tier)} tier covers ${band.estates} ${estateWord(band.estates)} and ${bandSizeLabel(band.protectedGb)} of protected data.`;
}

// estateExceedsBand is true when the measured estate has grown past what the band covers: more
// accounts than the pack allows, or more protected data than it allows (either dimension is enough).
// A missing/malformed estate never claims over-band (nothing to compare); this is the SAME honest
// arithmetic estateSummaryLine applies, just phrased as a predicate rather than a rendered line.
export function estateExceedsBand(estate: EstateSummary | null | undefined, band: BandInfo): boolean {
  if (!estate) return false;
  const { totalProtectedBytes, accounts } = estate;
  if (typeof accounts === "number" && Number.isFinite(accounts) && accounts > band.estates) return true;
  if (typeof totalProtectedBytes === "number" && Number.isFinite(totalProtectedBytes) && totalProtectedBytes > band.protectedGb * BYTES_PER_GB) return true;
  return false;
}
