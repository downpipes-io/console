// Shared leaf helpers, constants and the screen-local state types for the cost calculator.
// These are the small, dependency-free building blocks the view, the results builder and the
// observed-seed derivation all reach for: the currency / percentage / byte-unit formatting, the
// cadence and retention conversions, the parse-and-validate helpers (an invalid entry is never
// lost), and the projection horizons. They live in this leaf so no sibling module imports
// another. All maths stays in lib/cost-model.ts.

import { h } from "../../lib/dom.ts";
import { groupNumber } from "../../lib/format.ts";
import { CADENCE_SECONDS, DAYS_PER_MONTH, type Cadence, type Inputs, type PresetId, type OpCountsLike } from "../../lib/cost-model.ts";
import { type CadenceBasis, cadenceRunsPerMonth } from "../../lib/cost-cadence.ts";

// ---------------------------------------------------------------------------
// Screen-local constants
// ---------------------------------------------------------------------------

// The projection horizons the table and the cumulative-cost sparkline use: months 1, 3, 6, 12.
// The headline is taken at month 12 (the labelled "projected month 12" figure).
export const PROJECTION_MONTHS = [1, 3, 6, 12];
export const HEADLINE_MONTH = 12;

// The minimum number of run-history entries carrying the observed byte/segment fields
// before the screen defaults to observed mode. One run is enough to seed a size; we ask
// for at least two so the churn estimate is a real per-run delta and not a single point.
export const MIN_OBSERVED_RUNS = 2;

// The currency symbol the pricing presets are quoted in. The presets are indicative
// public USD list prices; the operator overrides every field with
// their own contracted rates, in whatever currency those rates are. We show a neutral
// "$" prefix and state plainly that the figures inherit the operator's entered rates.
export const CURRENCY_PREFIX = "$";

// The dedup ratio is entered as a stored-percentage for the operator (a 0.6 ratio reads
// as "60 per cent of logical size stored"); this bounds the field's accepted input.
export const PCT_MAX = 100;

// money() formatting thresholds: below SUB_CENT_THRESHOLD a
// figure shows four decimals so a sub-cent rate is not rounded to "$0.00"; at or above
// LARGE_FIGURE_THRESHOLD the cents are dropped and the integer part is grouped for readability.
const SUB_CENT_THRESHOLD = 0.01;
const LARGE_FIGURE_THRESHOLD = 1000;

// CADENCE_MATCH_TOLERANCE is the relative tolerance matchCadence uses to map a runs-per-month
// figure back to a named cadence (0.5 per cent), since the runs-per-month constants are
// non-integers. Named so the literal and the comment cannot drift.
const CADENCE_MATCH_TOLERANCE = 0.005;

// PCT_DECIMAL_FACTOR is the precision factor ratioToPct rounds to: one decimal place of a
// percentage (multiply by ten, round, divide by ten).
const PCT_DECIMAL_FACTOR = 10;

// ---------------------------------------------------------------------------
// Screen-local state model
// ---------------------------------------------------------------------------

// Mode is the calculator's operating mode. "observed" is seeded from
// run history; "manual" is entered from defaults. The toggle switches between them
// without losing the operator's edits in either.
export type Mode = "observed" | "manual";

// HistoryLoad is the settled result of the single engine read (listAllHistory). It is a
// discriminated result, never a thrown control-flow: "seedable" carries the observed
// seed; "no-fields" means history was read but no run carried the observed fields (so
// manual is correct and honest); "empty" means there were no runs at all; "error"
// carries the thrown transport error for the inline note (NOT a block; a 401 is routed
// to signed-out by the caller before this is built).
// Exported so the observed-seed derivation (summariseHistory) can be unit-tested directly;
// it is otherwise a screen-internal type.
export type HistoryLoad =
  // opCountsPerRun is the EXACT mean per-run Cloudflare op tally, present when the observed
  // runs carry it; the platform ledger uses it for an exact "cost to run", else it falls back to an estimate.
  // cadence records what the seeded runs a month rest on (the configured schedules, or the run-gap
  // fallback), so the cadence field can say exactly where its figure came from.
  | { kind: "seedable"; seed: Inputs; runs: number; cadence: CadenceBasis; opCountsPerRun?: OpCountsLike }
  | { kind: "no-fields"; runs: number }
  | { kind: "empty" }
  | { kind: "error"; error: unknown };

// ---------------------------------------------------------------------------
// Small presentation + parsing helpers (presentation only; never fed to the engine).
// ---------------------------------------------------------------------------

// money formats a currency figure with a fixed prefix and sensible precision: cents for
// small figures, whole units with grouping for large ones. Presentation only; the value
// comes from the cost-model library, never the reverse. A non-finite figure reads "-".
export function money(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  const v = Math.max(0, n);
  if (v === 0) return `${CURRENCY_PREFIX}0.00`;
  if (v < SUB_CENT_THRESHOLD) return `${CURRENCY_PREFIX}${v.toFixed(4)}`;
  if (v < LARGE_FIGURE_THRESHOLD) return `${CURRENCY_PREFIX}${v.toFixed(2)}`;
  // Large figures: group the integer part, drop the cents for readability.
  return `${CURRENCY_PREFIX}${groupNumber(Math.round(v))}`;
}

// formatRate formats a pricing rate for an editable field (up to four decimals, no
// trailing-zero noise), so a 0.015 storage rate shows as "0.015" not "0.0150".
export function formatRate(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  // Up to 4 decimals, trimmed.
  return trimZeros(n.toFixed(4));
}

// formatNumberInput formats a plain number for a number field (trim trailing zeros, no
// exponent for the magnitudes here). An integer shows without a decimal point.
export function formatNumberInput(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return trimZeros(n.toFixed(4));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// ---- byte-unit conversion (display only; storage is bytes) -----------------

export type ByteUnit = "MB" | "GB" | "TB";

// bytesToUnit picks a friendly unit (GB by default; TB for large; MB for small) and the
// magnitude in that unit, for the source-size field's initial display. Decimal units (1e9
// GB) to match the pricing convention the library uses (BYTES_PER_GB = 1e9).
export function bytesToUnit(bytes: number): { value: number; unit: ByteUnit } {
  const b = Math.max(0, bytes);
  if (b >= 1e12) return { value: b / 1e12, unit: "TB" };
  if (b >= 1e9 || b === 0) return { value: b / 1e9, unit: "GB" };
  return { value: b / 1e6, unit: "MB" };
}

export function unitToBytes(value: number, unit: ByteUnit): number {
  const v = Math.max(0, value);
  switch (unit) {
    case "MB": return v * 1e6;
    case "GB": return v * 1e9;
    case "TB": return v * 1e12;
  }
}

export function byteUnitOptions(selected: ByteUnit): HTMLOptionElement[] {
  const units: ByteUnit[] = ["MB", "GB", "TB"];
  return units.map((u) => {
    const opt = h("option", { value: u }, u) as HTMLOptionElement;
    if (u === selected) opt.selected = true;
    return opt;
  });
}

// ---- ratio <-> percentage --------------------------------------------------

export function ratioToPct(ratio: number): number {
  // one decimal place of a percentage
  return Math.round(clamp01(ratio) * 100 * PCT_DECIMAL_FACTOR) / PCT_DECIMAL_FACTOR;
}

export function pctToRatio(pct: number): number {
  return clamp01(pct / 100);
}

// ---- cadence display helpers -----------------------------------------------

// PRESET_CADENCES lists the named cadences the Schedule cadence select offers, shortest first.
export const PRESET_CADENCES: readonly Cadence[] = ["every15min", "hourly", "every6h", "daily", "weekly"];

// presetRunsPerMonth is the runs a month a named cadence preset sets. It is the rule the Observed seed
// applies to a downpipe on that cadence (lib/cost-cadence.ts cadenceRunsPerMonth): the engine can start a
// run up to 10 per cent early and starts runs only on its 15-minute tick, so the count is the month divided
// by the shortest gap the engine can leave. Daily is 2,630,016 / 78,300 = 33.589, not 30.44; every 15 minutes
// and hourly are unchanged, because the tick takes up the early start. The cost model's own arithmetic
// (lib/cost-model-rates.ts cadenceToRunsPerMonth, one run per interval) is unchanged; the screen picks this
// figure so a preset and the Observed seed for the same schedule agree.
export function presetRunsPerMonth(cadence: Cadence): number {
  return cadenceRunsPerMonth(CADENCE_SECONDS[cadence]);
}

// PRESET_SWEEP_RUNS_PER_MONTH is the cadence sensitivity sweep at the preset figures, longest cadence first,
// so the Sensitivity table and the select give the same runs a month for the same cadence.
export const PRESET_SWEEP_RUNS_PER_MONTH: readonly number[] = [...PRESET_CADENCES].reverse().map(presetRunsPerMonth);

// matchCadence returns the named cadence whose preset runs-per-month matches the given value
// closely, or null when it is a custom interval. The match is tolerant (within 0.5 per
// cent) because the runs-per-month figures are non-integers.
export function matchCadence(runsPerMonth: number): Cadence | null {
  for (const c of PRESET_CADENCES) {
    const rpm = presetRunsPerMonth(c);
    if (rpm > 0 && Math.abs(rpm - runsPerMonth) / rpm < CADENCE_MATCH_TOLERANCE) return c;
  }
  return null;
}

// runsPerMonthToMinutes converts a runs-per-month figure back to an interval in minutes,
// for seeding the custom-interval field. Returns 0 when there are no runs.
export function runsPerMonthToMinutes(runsPerMonth: number): number {
  if (!Number.isFinite(runsPerMonth) || runsPerMonth <= 0) return 0;
  const secondsPerRun = (DAYS_PER_MONTH * 24 * 60 * 60) / runsPerMonth;
  return Math.round((secondsPerRun / 60) * 10) / 10;
}

// runsToWindowDays converts a retention depth in runs to an approximate window in days at
// the given cadence, for keeping the days field in step with the runs field. Returns 0
// when there are no runs per month (the window is undefined without a cadence).
export function runsToWindowDays(retentionRuns: number, runsPerMonth: number): number {
  if (!Number.isFinite(retentionRuns) || retentionRuns <= 0) return 0;
  if (!Number.isFinite(runsPerMonth) || runsPerMonth <= 0) return 0;
  const days = (retentionRuns * DAYS_PER_MONTH) / runsPerMonth;
  return Math.round(days * 10) / 10;
}

// ---- parsing + validation (inputs never lost) ------------------------------

// parseNonNeg parses a non-negative finite number, or null when the entry is not a usable
// number. A null result means "do not patch the model" (the field's own validate() shows
// the error), so an in-progress or invalid entry never silently becomes 0 in the model.
export function parseNonNeg(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function parsePositive(raw: string): number | null {
  const n = parseNonNeg(raw);
  return n !== null && n > 0 ? n : null;
}

// parsePct parses a percentage in [min, 100], or null when out of range / not a number.
export function parsePct(raw: string, min: number): number | null {
  const n = parseNonNeg(raw);
  if (n === null) return null;
  if (n < min || n > PCT_MAX) return null;
  return n;
}

export function nonNegNumberError(v: string, label: string, allowZero = true): string | null {
  if (v === "") return null; // empty optional field is not an error on blur (field.ts honours this)
  const n = Number(v);
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  if (n < 0) return `${label} cannot be negative.`;
  if (!allowZero && n === 0) return `${label} must be greater than zero.`;
  return null;
}

export function positiveNumberError(v: string, label: string): string | null {
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  if (n <= 0) return `${label} must be greater than zero.`;
  return null;
}

export function pctError(v: string, label: string, min: number): string | null {
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  if (n < min) return min === 0 ? `${label} cannot be negative.` : `${label} must be at least ${min}.`;
  if (n > PCT_MAX) return `${label} cannot exceed ${PCT_MAX}.`;
  return null;
}

// ---- misc ------------------------------------------------------------------

export function presetLabel(id: PresetId): string {
  switch (id) {
    case "r2": return "Cloudflare R2";
    case "s3-standard": return "Amazon S3 Standard";
    case "custom": return "Custom";
  }
}

// formGridStyle: a two-column inputs / pricing grid that collapses to one column under
// the wide breakpoint. Inline because the screen composite is not in the shipped token
// CSS; it is built from tokens (the same approach overview.ts gridStyle uses).
export function formGridStyle(): string {
  return "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--space-5);align-items:stretch;margin-top:var(--space-4)";
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function clampNonNeg(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

// withoutOneOccurrence returns a copy of xs with the FIRST element equal to value removed
// (used to drop the single baseline-seal run from the per-run writes, leaving the incremental
// runs). If no element matches, the original list is returned unchanged. Pure; does not
// mutate the argument.
export function withoutOneOccurrence(xs: number[], value: number): number[] {
  const out: number[] = [];
  let removed = false;
  for (const x of xs) {
    if (!removed && x === value) {
      removed = true;
      continue;
    }
    out.push(x);
  }
  return out;
}

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// destinationIdsInUse is the set of destination ids the downpipes actually write to: each downpipe's ordered
// fan-out (destinationIds), else its single destinationId, else the account default, which is where a
// downpipe with neither writes. The cost estimate sums every destination in its list as if each backup wrote
// to all of them, so seeding the list from EVERY account destination prices copies the engine never makes.
// Returns null when there is no downpipe to read, so the caller keeps its every-destination fallback rather
// than pricing an empty list. A row is read defensively: the list route returns stored values verbatim. A row
// with no config object is skipped rather than counted against the default, because it is not a downpipe
// that writes anywhere.
export function destinationIdsInUse(downpipes: readonly unknown[], defaultId: string | null): Set<string> | null {
  if (downpipes.length === 0) return null;
  const out = new Set<string>();
  for (const row of downpipes) {
    const cfg = (row as { config?: { destinationIds?: unknown; destinationId?: unknown } } | null)?.config;
    if (typeof cfg !== "object" || cfg === null) continue;
    const fanOut = Array.isArray(cfg?.destinationIds) ? cfg.destinationIds.filter((id): id is string => typeof id === "string" && id !== "") : [];
    if (fanOut.length > 0) {
      for (const id of fanOut) out.add(id);
    } else if (typeof cfg?.destinationId === "string" && cfg.destinationId !== "") {
      out.add(cfg.destinationId);
    } else if (defaultId !== null) {
      out.add(defaultId);
    }
  }
  return out;
}
