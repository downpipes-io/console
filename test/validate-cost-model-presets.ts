// Presets, constants and defaults cross-checks for the cost-model validator.

import {
  PRESETS,
  DEFAULT_DEDUP_RATIO,
  DEFAULT_OVERHEAD_BYTES,
  DEFAULT_SEG_BYTES,
  DEFAULT_MANIFEST_OBJECTS,
  BYTES_PER_GB,
  DAYS_PER_MONTH,
  withDefaults,
  type Inputs,
} from "../src/lib/cost-model.ts";
import type { Harness } from "./validate-cost-model-shared.ts";

export function run(h: Harness): void {
  const { ok } = h;
  // -------------------------------------------------------------------------
  // Presets and constants are exactly the spec's figures.
  // -------------------------------------------------------------------------
  ok("R2 preset: storage 0.015 /GB-mo", PRESETS.r2.storagePerGBMonth === 0.015);
  ok("R2 preset: Class A 4.50 /M", PRESETS.r2.classAPerMillion === 4.5);
  ok("R2 preset: Class B 0.36 /M", PRESETS.r2.classBPerMillion === 0.36);
  ok("R2 preset: egress 0 (the standout)", PRESETS.r2.egressPerGB === 0);
  ok("S3 Standard preset: storage 0.023", PRESETS["s3-standard"].storagePerGBMonth === 0.023);
  ok("S3 Standard preset: PUT 5.00 /M", PRESETS["s3-standard"].classAPerMillion === 5.0);
  ok("S3 Standard preset: GET 0.40 /M", PRESETS["s3-standard"].classBPerMillion === 0.4);
  ok("S3 Standard preset: egress 0.09 /GB", PRESETS["s3-standard"].egressPerGB === 0.09);
  ok("Custom preset: all zero", PRESETS.custom.storagePerGBMonth === 0 && PRESETS.custom.classAPerMillion === 0 && PRESETS.custom.classBPerMillion === 0 && PRESETS.custom.egressPerGB === 0);
  // 30.44 is a ROUNDING of 365.25 / 12, which is 30.4375, so every runs-per-month figure the library
  // derives reads 0.0082 per cent high. That is far below the accuracy of any input the operator gives
  // it and is not worth changing, but the rounding is deliberate and has to be recorded: a later reader
  // who "corrects" the constant to the exact quotient moves every cadence, retention-window and
  // runs-per-month figure on the costs screen, and nothing else in the suite would object.
  ok("DAYS_PER_MONTH is 30.44, the ROUNDED 365.25 / 12 and not the exact 30.4375", DAYS_PER_MONTH === 30.44 && DAYS_PER_MONTH !== 365.25 / 12);
  ok("DEFAULT_SEG_BYTES is the engine's 1 GiB single-put ceiling", DEFAULT_SEG_BYTES === 1024 * 1024 * 1024);
  ok("DEFAULT_DEDUP_RATIO is 0.6", DEFAULT_DEDUP_RATIO === 0.6);
  ok("DEFAULT_OVERHEAD_BYTES is 64 KiB", DEFAULT_OVERHEAD_BYTES === 64 * 1024);
  // These two were the only cost-model constants no assertion in the suite compared to a literal.
  // Every other appearance of them across test/ is on the EXPECTED side of an assertion whose actual
  // side divides or adds the same constant, so both cancel and neither could fail. Changing
  // DEFAULT_MANIFEST_OBJECTS to any integer, or BYTES_PER_GB from the decimal GB that storage list
  // prices are quoted in to a binary GiB, would have rewritten every figure the costs screen shows
  // and passed the whole suite. Pinned here, alongside the constants that already were.
  ok("DEFAULT_MANIFEST_OBJECTS is 3", DEFAULT_MANIFEST_OBJECTS === 3);
  ok("BYTES_PER_GB is the DECIMAL GB list prices are quoted in, not a binary GiB", BYTES_PER_GB === 1e9 && BYTES_PER_GB !== 1024 * 1024 * 1024);

  // -------------------------------------------------------------------------
  // Defaults: a partial (even empty) Inputs becomes complete and valid.
  // -------------------------------------------------------------------------
  const def = withDefaults({});
  ok("withDefaults: dedupRatio default 0.6", def.dedupRatio === 0.6);
  ok("withDefaults: churnFraction default 0", def.churnFraction === 0);
  ok("withDefaults: overheadBytes default 64 KiB", def.overheadBytes === DEFAULT_OVERHEAD_BYTES);
  ok("withDefaults: segBytes default 1 GiB", def.segBytes === DEFAULT_SEG_BYTES);
  ok("withDefaults: driveEgressFree default true", def.driveEgressFree === true);
  // THE HONEST DEFAULT: the growth model defaults to per-run snapshots (the live engine's
  // behaviour), and an unknown value degrades to snapshot, never to the future projection.
  ok("withDefaults: growthModel defaults to snapshot (the live engine's behaviour)", def.growthModel === "snapshot");
  ok("withDefaults: churn-dedup is honoured only when explicitly selected", withDefaults({ growthModel: "churn-dedup" }).growthModel === "churn-dedup");
  ok("withDefaults: an unknown growth model degrades to snapshot", withDefaults({ growthModel: "nonsense" as Inputs["growthModel"] }).growthModel === "snapshot");
  // Clamps: d into (0,1], c into [0,1], negatives to 0.
  ok("withDefaults: dedupRatio clamps above 1 to 1", withDefaults({ dedupRatio: 5 }).dedupRatio === 1);
  ok("withDefaults: dedupRatio clamps <=0 to positive", withDefaults({ dedupRatio: 0 }).dedupRatio > 0);
  ok("withDefaults: churn clamps above 1 to 1", withDefaults({ churnFraction: 2 }).churnFraction === 1);
  ok("withDefaults: churn clamps below 0 to 0", withDefaults({ churnFraction: -1 }).churnFraction === 0);
  ok("withDefaults: negative sourceBytes coerced to 0", withDefaults({ sourceBytes: -10 }).sourceBytes === 0);
}
