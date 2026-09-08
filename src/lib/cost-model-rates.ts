// Rates, inputs and base maths for the downpipes cost ESTIMATION library: the
// constants, operator-entered pricing and model inputs, the cadence/retention-window
// conversions, and the small numeric guards that keep every figure finite. The
// estimation engine (cost-model-estimate.ts) builds on this layer, and cost-model.ts
// re-exports both as one library.
//
// EVERY figure this module returns is an ESTIMATE, not a quote or a guarantee.
//
// This module is PURE and DETERMINISTIC by contract:
//   - no DOM access, no engine import, no network;
//   - no wall-clock (Date.now / performance.now) and no randomness (Math.random /
//     crypto) APIs, so the same inputs always give the same outputs and the module is
//     trivially unit-testable.
// It transmits nothing. Nothing here is a no-custody concern: it never touches a key,
// a secret, or archive content, only sizes and counts.
//
// House rules followed: Australian English; precise claims (an estimate is an estimate);
// custom domains only (no vendor URLs appear here at all). exactOptionalPropertyTypes is
// ON, so optional fields are added via conditional spreads and are never assigned
// undefined; noUncheckedIndexedAccess is satisfied by guarding every indexed read.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// DAYS_PER_MONTH ROUNDS the standard averaging constant 365.25 / 12 = 30.4375 to 30.44, so any figure
// derived from it reads 0.0082 per cent high. Used for every cadence-to-runs and window-to-runs conversion.
export const DAYS_PER_MONTH = 30.44;

// DEFAULT_SEG_BYTES is the writer's segment-size constant, read from the engine
// (engine/src/dest/types.ts: MAX_STREAM_SEGMENT_BYTES = 1 GiB, the single-put
// ceiling). The engine seals one segment (one destination object) per record and does
// NOT pack small records together, so this is the maximum bytes a single object can hold.
// Object counts derived as ceil(dA / segBytes) are therefore an ESTIMATE and, for a
// workload of many small records, a LOWER bound on the true object count (each small
// record is still its own object). The screen states this assumption plainly and the
// operator can override segBytes to match an observed bytes-per-object ratio.
export const DEFAULT_SEG_BYTES = 1024 * 1024 * 1024; // 1 GiB

// DEFAULT_DEDUP_RATIO is the conservative default stored ratio d (a 40 per cent
// reduction from WITHIN-RUN content-addressed dedup plus compression; the engine's
// addressing key is per-run, so this ratio never spans runs). Operator-overridable.
export const DEFAULT_DEDUP_RATIO = 0.6;

// DEFAULT_OVERHEAD_BYTES is a modest per-run fixed overhead O (root and shard
// manifests, RUNLOG, signatures): 64 KiB. Refined from observed data when available.
export const DEFAULT_OVERHEAD_BYTES = 64 * 1024; // 64 KiB

// DEFAULT_MANIFEST_OBJECTS is the small constant count of non-segment objects a run
// writes (root, shard manifest, capsule and so on). An estimate; folded into newObjects.
export const DEFAULT_MANIFEST_OBJECTS = 3;

// BYTES_PER_GB is the decimal GB used by storage and egress pricing (cloud object-store
// list prices are quoted per decimal GB, 1e9 bytes, not per binary GiB).
export const BYTES_PER_GB = 1e9;

// OBJECTS_PER_MILLION is the denominator for per-million object-operation pricing (Class A/B list
// prices are quoted per million operations).
export const OBJECTS_PER_MILLION = 1_000_000;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

// Pricing is a destination's per-unit rates, all operator-entered. These are INDICATIVE
// public list prices when taken from a preset; the screen tells the operator to enter
// their own contracted rates and every field is editable. All rates are non-negative.
export interface Pricing {
  // storagePerGBMonth: storage price per GB-month (P_store).
  storagePerGBMonth: number;
  // classAPerMillion: write-class price per million PUT/write operations (P_classA).
  classAPerMillion: number;
  // classBPerMillion: read-class price per million GET/read operations (P_classB).
  classBPerMillion: number;
  // egressPerGB: egress price per GB (P_egress). Zero for in-account R2 reads.
  egressPerGB: number;
}

// PresetId names the indicative pricing presets the screen offers.
export type PresetId = "r2" | "s3-standard" | "custom";

// PRESETS are INDICATIVE starting points from typical public list pricing. They are NOT a
// quote and NOT contracted rates; the operator overrides every field with their own.
// R2's zero egress is presented as a fact, not a sales claim. (Verify against current published
// pricing before relying on these figures.)
export const PRESETS: Readonly<Record<PresetId, Readonly<Pricing>>> = {
  // Cloudflare R2. The standout is zero egress; the model surfaces it as an advantage.
  r2: { storagePerGBMonth: 0.015, classAPerMillion: 4.5, classBPerMillion: 0.36, egressPerGB: 0 },
  // Amazon S3 Standard (first-tier figures). PUT is Class A, GET is Class B.
  "s3-standard": { storagePerGBMonth: 0.023, classAPerMillion: 5.0, classBPerMillion: 0.4, egressPerGB: 0.09 },
  // Custom: everything zero; the operator enters their destination's rates.
  custom: { storagePerGBMonth: 0, classAPerMillion: 0, classBPerMillion: 0, egressPerGB: 0 },
};

// PRESET_PROVENANCE says, for each preset, WHOSE price list it is and WHEN a human last checked it
// against that list.
//
// WHY THIS EXISTS. Until no rate here carried a source, a checked-on date or a gate. An
// audit that day compared all fifteen figures against current published pricing and found ZERO drift,
// which sounds like the table was fine and is the wrong conclusion to draw: it was correct by a stable
// vendor rather than by any control. In the two months to that date the non-Cloudflare storage market
// repriced twice, and nothing here would have noticed either move. A number that is right by luck reads
// identically to a number that is right by design, and only one of them stays right.
//
// The rate term is most of what the cost estimate computes, so a silently stale figure is not a
// rounding difference to the operator reading it.
//
// The date is a CHECKED-ON date, not a valid-until. It records that somebody looked, which is the only
// thing anybody can honestly assert about a third party's price list.
//
// "custom" is deliberately absent: it is all zeros by design, there is no source to check it against,
// and giving it a date would be the kind of ceremony that makes an unchecked thing look checked.
export interface PresetProvenance {
  /** Whose published price list this preset is taken from, in the words a reader can go and verify. */
  readonly source: string;
  /** ISO date a human last compared this preset against that list. Not a valid-until. */
  readonly checkedOn: string;
}

export const PRESET_PROVENANCE: Readonly<Record<"r2" | "s3-standard", PresetProvenance>> = {
  r2: { source: "Cloudflare R2 published list pricing", checkedOn: "2026-08-06" },
  "s3-standard": { source: "Amazon S3 Standard published list pricing, first-tier figures", checkedOn: "2026-08-06" },
};

// How long a checked-on date may stand before the gate calls it unwitnessed. Ninety days is chosen
// against the observed reprice interval rather than as a round number: two non-Cloudflare repricings
// landed inside the sixty-two days to, so a window materially longer than that would let a
// whole reprice cycle pass unnoticed, and a much shorter one would fire on a market that had not moved.
export const PRESET_CHECK_MAX_AGE_DAYS = 90;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// GrowthModel selects how per-run stored growth is modelled.
//   "snapshot"    (the DEFAULT; the live engine's behaviour): the content-address key
//                 derives from the per-run master, so dedup applies only WITHIN a run and
//                 every run stores a FULL snapshot. Per-run growth is the whole stored
//                 size A0 = S x d (plus overhead), regardless of churn.
//   "churn-dedup" (FUTURE; applies only once cross-run dedup ships): content addressing
//                 spans runs, so a run stores only its churn, S x c x d. A stable
//                 addressing key is a recorded design decision, not current
//                 behaviour; any figure computed under this model must be labelled so.
export type GrowthModel = "snapshot" | "churn-dedup";

// Inputs are the operator-entered (or engine-observed) model parameters. In manual mode
// the operator enters them; in observed mode the screen seeds sourceBytes (from the real
// per-run archiveBytesWritten), segBytes (via observed bytes-per-object), overheadBytes
// and runsPerMonth from the engine run history, then lets the operator override. All
// sizes are bytes; all counts are non-negative. Defaults are documented on each field
// and applied by withDefaults.
export interface Inputs {
  // sourceBytes: S, the source logical size in bytes (operator-entered or observed).
  sourceBytes: number;
  // dedupRatio: d, stored bytes / logical bytes, 0 < d <= 1 (WITHIN-RUN dedup plus
  // compression). Default DEFAULT_DEDUP_RATIO (0.6).
  dedupRatio: number;
  // churnFraction: c, the fraction of logical content new or changed since the previous
  // run, 0 <= c <= 1 (operator-entered or observed). Drives per-run growth ONLY under
  // the "churn-dedup" growth model; under the default per-run snapshot model every run
  // stores the full snapshot regardless of churn.
  churnFraction: number;
  // growthModel: how per-run stored growth is modelled (see GrowthModel). Default
  // "snapshot", the live engine's behaviour.
  growthModel: GrowthModel;
  // runsPerMonth: f, derived from the schedule cadence (use cadenceToRunsPerMonth).
  runsPerMonth: number;
  // retentionRuns: R, retention depth in runs (or a day window converted via
  // retentionWindowToRuns). Bounds the retained-with-GC regime.
  retentionRuns: number;
  // overheadBytes: O, per-run fixed overhead bytes. Default DEFAULT_OVERHEAD_BYTES (64 KiB).
  overheadBytes: number;
  // segBytes: the writer's target segment size, used only to estimate object counts.
  // Default DEFAULT_SEG_BYTES (the engine's 1 GiB single-put ceiling).
  segBytes: number;
  // drillsPerMonth: number of integrity drills per month (Class B reads, no egress).
  drillsPerMonth: number;
  // restoresPerMonth: number of in-account restores per month (Class B reads; egress only
  // when the restored data is downloaded out of the account).
  restoresPerMonth: number;
  // offlineRecoveriesPerMonth: number of full out-of-account recovery downloads per month.
  // These ALWAYS incur egress on the whole recoverable archive size for the regime in play.
  offlineRecoveriesPerMonth: number;
  // driveEgressFree: true when in-account reads (drill/restore in the same account) incur
  // no egress (true for R2 same-account). Offline recovery still incurs egress regardless.
  driveEgressFree: boolean;
}

// The model's documented defaults. churnFraction has no universal default (it is the
// operator's workload), so it defaults to 0; the screen prompts for it with low/expected/
// high quick-sets. retentionRuns defaults to 0, meaning "keep everything" for the retained
// projection until the operator sets a window.
export const DEFAULT_INPUTS: Readonly<Inputs> = {
  sourceBytes: 0,
  dedupRatio: DEFAULT_DEDUP_RATIO,
  churnFraction: 0,
  growthModel: "snapshot",
  runsPerMonth: 0,
  retentionRuns: 0,
  overheadBytes: DEFAULT_OVERHEAD_BYTES,
  segBytes: DEFAULT_SEG_BYTES,
  drillsPerMonth: 0,
  restoresPerMonth: 0,
  offlineRecoveriesPerMonth: 0,
  driveEgressFree: true,
};

// withDefaults fills any omitted field from DEFAULT_INPUTS and clamps the bounded inputs
// to their valid ranges (d into (0, 1], c into [0, 1], counts to >= 0). It is total: a
// partial, even empty, object yields a complete, valid Inputs. Pure; no mutation of the
// argument.
export function withDefaults(partial: Partial<Inputs>): Inputs {
  const sourceBytes = nonNeg(partial.sourceBytes ?? DEFAULT_INPUTS.sourceBytes);
  // d must be strictly positive and at most 1; clamp into (0, 1].
  const dRaw = partial.dedupRatio ?? DEFAULT_INPUTS.dedupRatio;
  const dedupRatio = Math.min(1, Math.max(Number.EPSILON, finite(dRaw, DEFAULT_DEDUP_RATIO)));
  const churnFraction = clamp01(partial.churnFraction ?? DEFAULT_INPUTS.churnFraction);
  // An unknown growth-model string degrades to the honest default (per-run snapshots, the
  // live engine's behaviour), never to the future churn-dedup projection.
  const growthModel: GrowthModel = partial.growthModel === "churn-dedup" ? "churn-dedup" : "snapshot";
  const runsPerMonth = nonNeg(partial.runsPerMonth ?? DEFAULT_INPUTS.runsPerMonth);
  const retentionRuns = nonNeg(partial.retentionRuns ?? DEFAULT_INPUTS.retentionRuns);
  const overheadBytes = nonNeg(partial.overheadBytes ?? DEFAULT_INPUTS.overheadBytes);
  // segBytes must be strictly positive (it is a divisor); fall back to the default.
  const segBytes = Math.max(1, finite(partial.segBytes ?? DEFAULT_INPUTS.segBytes, DEFAULT_SEG_BYTES));
  const drillsPerMonth = nonNeg(partial.drillsPerMonth ?? DEFAULT_INPUTS.drillsPerMonth);
  const restoresPerMonth = nonNeg(partial.restoresPerMonth ?? DEFAULT_INPUTS.restoresPerMonth);
  const offlineRecoveriesPerMonth = nonNeg(partial.offlineRecoveriesPerMonth ?? DEFAULT_INPUTS.offlineRecoveriesPerMonth);
  const driveEgressFree = partial.driveEgressFree ?? DEFAULT_INPUTS.driveEgressFree;
  return {
    sourceBytes,
    dedupRatio,
    churnFraction,
    growthModel,
    runsPerMonth,
    retentionRuns,
    overheadBytes,
    segBytes,
    drillsPerMonth,
    restoresPerMonth,
    offlineRecoveriesPerMonth,
    driveEgressFree,
  };
}

// ---------------------------------------------------------------------------
// Cadence and retention-window conversions
// ---------------------------------------------------------------------------

// Cadence names the standard schedule cadences the screen offers (mirroring the downpipe
// schedule). "custom" is handled via cadenceSecondsToRunsPerMonth, not this table.
export type Cadence = "every15min" | "hourly" | "every6h" | "daily" | "weekly";

// CADENCE_SECONDS maps each standard cadence to its interval in seconds.
export const CADENCE_SECONDS: Readonly<Record<Cadence, number>> = {
  every15min: 15 * 60, // 900
  hourly: 60 * 60, // 3600
  every6h: 6 * 60 * 60, // 21600
  daily: 24 * 60 * 60, // 86400
  weekly: 7 * 24 * 60 * 60, // 604800
};

// CADENCE_RUNS_PER_MONTH maps each standard cadence to its runs-per-month (f), using
// DAYS_PER_MONTH (30.44). These approximations follow: every 15 min ~= 2880,
// hourly ~= 730, every 6 h ~= 122, daily ~= 30.4, weekly ~= 4.35.
export const CADENCE_RUNS_PER_MONTH: Readonly<Record<Cadence, number>> = {
  every15min: cadenceSecondsToRunsPerMonth(CADENCE_SECONDS.every15min),
  hourly: cadenceSecondsToRunsPerMonth(CADENCE_SECONDS.hourly),
  every6h: cadenceSecondsToRunsPerMonth(CADENCE_SECONDS.every6h),
  daily: cadenceSecondsToRunsPerMonth(CADENCE_SECONDS.daily),
  weekly: cadenceSecondsToRunsPerMonth(CADENCE_SECONDS.weekly),
};

// cadenceSecondsToRunsPerMonth converts a cadence interval in seconds to runs per month (f),
// using DAYS_PER_MONTH: f = (DAYS_PER_MONTH x 86400) / intervalSeconds. A non-positive
// interval returns 0. This is the general helper behind cadenceToRunsPerMonth and the table.
export function cadenceSecondsToRunsPerMonth(intervalSeconds: number): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return 0;
  return (DAYS_PER_MONTH * 24 * 60 * 60) / intervalSeconds;
}

// cadenceToRunsPerMonth returns runs per month (f) for a named standard cadence: every 15
// min ~= 2880, hourly ~= 730, every 6 h ~= 122, daily ~= 30.4, weekly ~= 4.35 (DAYS_PER_MONTH
// = 30.44 days/month). Use cadenceSecondsToRunsPerMonth for a custom interval.
export function cadenceToRunsPerMonth(cadence: Cadence): number {
  return CADENCE_RUNS_PER_MONTH[cadence];
}

// retentionWindowToRuns converts a retention window in DAYS to a retention depth R in runs,
// for the given runs-per-month f: R = ceil(f x days / DAYS_PER_MONTH). A non-positive
// window or f yields 0 (keep everything).
export function retentionWindowToRuns(days: number, runsPerMonth: number): number {
  const d = nonNeg(days);
  const f = nonNeg(runsPerMonth);
  if (d === 0 || f === 0) return 0;
  // Snap away sub-epsilon floating overshoot before ceil, so an exact integer result (for
  // example daily x 7 days = exactly 7 runs) is not pushed up to 8 by 7.0000000000001.
  const raw = (f * d) / DAYS_PER_MONTH;
  const snapped = Math.abs(raw - Math.round(raw)) < 1e-9 ? Math.round(raw) : raw;
  return Math.ceil(snapped);
}

// ---------------------------------------------------------------------------
// Small numeric guards (pure; keep the module self-contained)
// ---------------------------------------------------------------------------

// nonNeg coerces to a finite, non-negative number (NaN/Infinity/negatives become 0).
export function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// finite returns n when finite, otherwise the fallback.
export function finite(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback;
}

// clamp01 clamps to [0, 1] (and coerces non-finite to 0).
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// clampDedup clamps a stored ratio d to (0, 1] (a divisor/multiplier that must be positive).
export function clampDedup(d: number): number {
  if (!Number.isFinite(d)) return DEFAULT_DEDUP_RATIO;
  return Math.min(1, Math.max(Number.EPSILON, d));
}

// sanitisePricing clamps every rate to a finite, non-negative number, so a stray negative or
// NaN in operator input can never make a cost go negative or non-finite.
export function sanitisePricing(p: Pricing): Pricing {
  return {
    storagePerGBMonth: nonNeg(p.storagePerGBMonth),
    classAPerMillion: nonNeg(p.classAPerMillion),
    classBPerMillion: nonNeg(p.classBPerMillion),
    egressPerGB: nonNeg(p.egressPerGB),
  };
}

// dedupeSortedAsc sorts numbers ascending and removes duplicates (stable, pure).
export function dedupeSortedAsc(xs: number[]): number[] {
  const sorted = [...xs].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of sorted) {
    const last = out.length === 0 ? undefined : out[out.length - 1];
    if (last === undefined || last !== x) out.push(x);
  }
  return out;
}
