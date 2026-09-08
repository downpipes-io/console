// Shared render-context type for the results builders. Held in its own leaf module so the orchestrator
// (./results.ts) and the extracted card builders (./results-cards.ts) can both depend on it without a
// circular import. House rules: Australian English, no em dashes, precise claims.

import type { Mode } from "./helpers.ts";
import type { PresetId, OpCountsLike } from "../../lib/cost-model.ts";
import type { SourceTypeCostRow } from "./seed.ts";

// ResultsCtx is the render context: the mode and observed-run count (for the basis line), the pricing
// preset id (for the currency note), the operator's safety margin (the wiggle slider, a fraction), and
// the destination label when the storage rates were prefilled from a destination.
export interface ResultsCtx {
  mode: Mode;
  observedRuns: number;
  presetId: PresetId;
  safetyMargin: number;
  destinationLabel?: string | null;
  // opCountsPerRun is the EXACT mean per-run Cloudflare op tally from run history (cost Phase 3), when
  // present; the platform ledger prices it exactly instead of estimating from object counts.
  opCountsPerRun?: OpCountsLike;
  // sourceTypeRows is the per-source-type cost breakdown (computed by the view from run history + the
  // downpipe source-type map); rendered as a table when present and non-empty.
  sourceTypeRows?: SourceTypeCostRow[];
}
