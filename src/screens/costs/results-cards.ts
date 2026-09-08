// The results card builders (pure given inputs + pricing): the headline, the Cloudflare-platform
// ledger, the per-source-type breakdown, the destination-storage split tiles and the one-off seal.
// Every figure is consumed from lib/cost-model.ts, never reimplemented. Moved verbatim from
// ./results.ts for size; behaviour is unchanged. House rules: Australian English, no em dashes,
// precise claims ("estimate" / "projected").

import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { h } from "../../lib/dom.ts";
import { statTile, statGrid } from "../../components/stat-tiles.ts";
import { dataTable, type DataColumn } from "../../components/data-table.ts";
import { humanBytes, groupNumber } from "../../lib/format.ts";
import {
  HEADLINE_MONTH,
  money,
  plural,
} from "./helpers.ts";
import type {
  Inputs,
  CostBreakdown,
  RecurringEstimate,
  CapacityEstimate,
} from "../../lib/cost-model.ts";
import type { SourceTypeCostRow } from "./seed.ts";
import type { ResultsCtx } from "./results-types.ts";

export function buildHeadline(recurring: RecurringEstimate, inputs: Inputs, ctx: ResultsCtx): HTMLElement {
  const card = h("div", { class: "cost-headline card" });
  card.appendChild(h("span", { class: "stat__label" }, `Estimated recurring monthly cost, projected month ${HEADLINE_MONTH}`));
  card.appendChild(h("div", { class: "cost-headline__value tnum" }, money(recurring.total)));
  const marginPct = Math.round(recurring.safetyMargin * 100);
  // The three-ledger breakdown, so the headline is never a mystery number.
  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-1)" },
      `Destination storage ${money(recurring.storage.total)} plus Cloudflare resources ${money(recurring.platform.total)} plus plan base ${money(recurring.basePlan)}, with a ${marginPct} per cent safety margin.`,
    ),
  );
  // The growth-model mechanism is taught at its control and in the assumptions; the basis line only
  // NAMES the model. The not-shipped caveat stays on the future model.
  const modelWord =
    inputs.growthModel === "churn-dedup"
      ? "cross-run dedup growth (applies only once cross-run dedup ships)"
      : "per-run snapshot accumulation";
  // With Custom rates the operator may have entered any currency; the storage outputs inherit it.
  const currencyNote = ctx.presetId === "custom" ? " Storage figures are in the currency of your entered rates." : "";
  const destNote = ctx.destinationLabel ? ` Storage rates prefilled from your destination ${ctx.destinationLabel}.` : "";
  const basis =
    ctx.mode === "observed"
      ? `Accumulate basis, ${modelWord}, projected from your last ${ctx.observedRuns} ${plural(ctx.observedRuns, "run")}. An estimate, not a quote.${currencyNote}${destNote}`
      : `Accumulate basis, ${modelWord}, with retention enforcement off. An estimate, not a quote.${currencyNote}${destNote}`;
  card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, basis));
  return card;
}

// buildPlatformCard renders the Cloudflare-platform ledger: the cost to RUN the backup, priced at paid
// rates with the free tier deliberately NOT assumed. `exact` is true when the figure comes from the run
// history's measured op tally (cost Phase 3); otherwise it is the over-estimate from object counts.
export function buildPlatformCard(recurring: RecurringEstimate, cap: CapacityEstimate, exact: boolean): HTMLElement {
  const p = recurring.platform;
  const section = h("section", { class: "cost-platform", style: "margin-top:var(--space-4)", "aria-labelledby": "cost-plat-h" });
  section.appendChild(h("h3", { id: "cost-plat-h", style: "font-size:var(--text-md);margin-bottom:var(--space-2)" }, "Cost to run the backup (Cloudflare)"));
  section.appendChild(
    statGrid(
      statTile({ label: "Cloudflare resources", value: money(p.total), secondary: exact ? "Per month, measured from your run history." : "Per month, at paid rates." }),
      statTile({ label: "Archive writes", value: money(p.r2ClassA), secondary: "R2 Class A operations that write your archive." }),
      statTile({ label: "Source reads", value: money(p.kvReads), secondary: exact ? "Reading the source each run (measured)." : "Reading the source each run, priced high (the source mix is not known here)." }),
      statTile({ label: "Plan base", value: money(recurring.basePlan), secondary: "The Workers Paid plan the engine runs on." }),
    ),
  );
  // Feasibility: the platform LOAD one run imposes (subrequests and Worker invocations), so the operator
  // sees capacity, not only dollars. Shown only when there is work to do.
  if (cap.subrequests > 0) {
    section.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-2)" },
        `Feasibility: about ${groupNumber(Math.round(cap.subrequests))} platform subrequests per run, roughly ${groupNumber(cap.invocations)} Worker ${plural(cap.invocations, "invocation")} per run.`,
      ),
    );
  }
  section.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)" },
      exact
        ? "Measured from your run history: the exact Cloudflare operations your backups made, priced at paid rates with no free-tier allowance assumed (other workloads in your account may already use it). If you already run other Workers on the Paid plan, the backup does not add the plan base."
        : "Estimated and priced at Cloudflare's paid rates, with no free-tier allowance assumed, because other workloads in your account may already use it. The figure sharpens to your measured operations once a backup has run. If you already run other Workers on the Paid plan, the backup does not add the plan base.",
    ),
  );
  return section;
}

// SOURCE_TYPE_LABEL renders an engine source-type id as a human name; an unknown id (a newer engine's
// source type) falls back to the raw id rather than being dropped.
const SOURCE_TYPE_LABEL: Readonly<Record<string, string>> = {
  kv: "Workers KV",
  r2: "R2",
  d1: "D1",
  secrets: "Secrets Store",
  "cf-config": "Cloudflare config",
  workers: "Workers",
  stream: "Stream",
  images: "Images",
  artifacts: "Artifact Registry",
};

interface SourceTypeRow {
  source: string;
  stored: string;
  storage: string;
  platform: string;
  total: string;
}

// buildSourceTypeBreakdown renders the per-source-type cost table: what each kind of source costs to back
// up per month (destination storage + Cloudflare resources), from the run history. The account-wide plan
// base and the wiggle margin are stated in the headline, not split in here, so this is the variable-cost
// split. A platform figure still estimated (no measured opCounts yet) is marked "(est.)".
export function buildSourceTypeBreakdown(rows: SourceTypeCostRow[]): HTMLElement {
  const section = h("section", { class: "cost-by-source", style: "margin-top:var(--space-5)", "aria-labelledby": "cost-bysrc-h" });
  section.appendChild(h("h3", { id: "cost-bysrc-h", style: "font-size:var(--text-md);margin-bottom:var(--space-2)" }, "Cost by source type"));
  section.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-bottom:var(--space-3)" },
      "What each kind of source costs to back up per month, from your run history: destination storage plus Cloudflare resources. The plan base and the safety margin are account-wide and sit in the headline above, not split in here.",
    ),
  );
  // G261: a source-type id with no label in this console build becomes a cryptic raw id in the cost table (the
  // "why does my bill have a row called `hyperdrive` in it" ticket). It is an engine that backs up a source type
  // this console has never heard of, which is version skew, and it read as a rendering bug.
  for (const r of rows) {
    if (SOURCE_TYPE_LABEL[r.sourceType] === undefined) recordContractSkew("unknown-enum-member", "source-type");
  }
  const tableRows: SourceTypeRow[] = rows.map((r) => ({
    source: SOURCE_TYPE_LABEL[r.sourceType] ?? r.sourceType,
    stored: humanBytes(r.storedBytes),
    storage: money(r.storageCost),
    platform: `${money(r.platformCost)}${r.exact ? "" : " (est.)"}`,
    total: money(r.total),
  }));
  const columns: Array<DataColumn<SourceTypeRow>> = [
    { key: "source", header: "Source", render: (r) => r.source },
    { key: "stored", header: "Stored", numeric: true, render: (r) => r.stored },
    { key: "storage", header: "Storage/mo", numeric: true, render: (r) => r.storage },
    { key: "platform", header: "Cloudflare/mo", numeric: true, render: (r) => r.platform },
    { key: "total", header: "Total/mo", numeric: true, render: (r) => r.total },
  ];
  const table = dataTable<SourceTypeRow>({ label: "Monthly cost by source type", rows: tableRows, rowKey: (r) => r.source, columns });
  section.appendChild(table.el);
  return section;
}

export function buildSplitTiles(b: CostBreakdown): HTMLElement {
  return statGrid(
    splitTile("Storage", b.storage, `Averaged at ${humanBytes(b.averageStoredBytes)} stored.`),
    splitTile("Writes", b.writes, `${groupNumber(b.objectsWrittenPerMonth)} objects written per month.`),
    splitTile("Reads", b.reads, "Drill and restore read operations."),
    splitTile("Egress", b.egress, b.egress === 0 ? "Nil at this destination's egress rate." : "Out-of-account downloads."),
  );
}

function splitTile(label: string, value: number, secondary: string): HTMLElement {
  return statTile({ label, value: money(value), secondary });
}

export function buildInitialCost(initial: number): HTMLElement {
  return h(
    "div",
    { class: "cost-initial card card--inset", style: "margin-top:var(--space-4)" },
    h("span", { class: "field__hint" }, "Initial one-off seal"),
    h("span", { class: "tnum", style: "font-weight:var(--weight-medium);margin-left:var(--space-2)" }, money(initial)),
    h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "The write cost of the first full seal of the archive, charged once. Included in every cumulative figure below."),
  );
}
