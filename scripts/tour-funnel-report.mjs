#!/usr/bin/env node
//
// FS-WRITES: none outside this repo

// The weekly tour-funnel report. Operator-run, stdout only: it
// queries the tour's own Analytics Engine dataset (downpipes_tour_funnel, written by the /tour/event ingest
// in src/worker.ts) over the Cloudflare Analytics Engine SQL API and prints the funnel a solo operator needs
// to read once a week: starts, completions, the completion rate, welcome engagement, the per-step drop-off,
// and the campaign (?src=, blob5) and welcome-choice splits (the two walks plus "explore", the dismissal to
// free-explore). No deploy surface, no bindings: it is a plain authenticated read.
//
// Counts are SUM(_sample_interval), NEVER COUNT(): Analytics Engine samples at high volume, and
// _sample_interval is how many raw events each stored row represents, so COUNT() undercounts whenever
// sampling engages. Retention is about 90 days, so the dataset is the pipe, not the archive: keep each
// weekly output (a dated file, a note, anywhere durable), because a quarter from now the early rows are gone.
//
// Credentials come from the environment, never a file and never committed (the convention
// engine/scripts/sync-bindings.mjs uses): CLOUDFLARE_API_TOKEN (a token with Account Analytics Read) and
// CLOUDFLARE_ACCOUNT_ID.
//
// Usage: node scripts/tour-funnel-report.mjs [--since <days>]        (default window: 7 days)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The explicit never annotation is what lets the checker treat everything after a die() as unreachable
// (tsconfig.scripts.json runs these files through tsc), so a guard like `if (!m) die(...)` genuinely narrows.
/** @returns {never} */
function die(msg) {
  console.error(`[tour-funnel-report] ${msg}`);
  process.exit(1);
}

// The dataset name is read from the deploy config that binds it, so this report cannot silently drift from
// what the worker actually writes to.
const toml = readFileSync(join(ROOT, "wrangler.public-demo.toml"), "utf8");
const DATASET = toml.match(/^dataset\s*=\s*"([a-z0-9_]+)"/m)?.[1];
if (!DATASET) die("could not read the Analytics Engine dataset name from wrangler.public-demo.toml");

// The terminal chapter index is DERIVED from the tour scripts rather than hardcoded: both curated walks in
// src/lib/demo/tour/scripts/chapters.ts end on the shared funnelChapter, so completion is a step_reached at
// index (walk length - 1). The derivation parses the two exported walk arrays as text (importing the module
// would pull the whole SPA screen graph into a Node process) and refuses on any surprise, so a walk that
// grows a chapter moves this report with it and a parse failure is loud, never a silently wrong index.
const chaptersSrc = readFileSync(join(ROOT, "src", "lib", "demo", "tour", "scripts", "chapters.ts"), "utf8");
function walkEntries(name) {
  const m = chaptersSrc.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) die(`could not find the ${name} walk in src/lib/demo/tour/scripts/chapters.ts`);
  const entries = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (!/^[A-Za-z0-9_]+$/.test(s)) {
        die(`chapters.ts entry ${JSON.stringify(s)} in ${name} is not a bare identifier; refusing rather than deriving a silently wrong terminal index`);
      }
      return s;
    });
  if (entries.length === 0) die(`the ${name} walk parsed to zero chapters, which cannot be right`);
  return entries;
}
const cto = walkEntries("ctoChapters");
const engineer = walkEntries("engineerChapters");
if (cto.length !== engineer.length) die(`the two walks disagree on length (${cto.length} vs ${engineer.length}); completion needs one terminal index`);
if (cto[cto.length - 1] !== "funnelChapter" || engineer[engineer.length - 1] !== "funnelChapter") {
  die("a walk no longer ends on the shared funnelChapter; re-derive what completion means before trusting this report");
}
const TERMINAL_INDEX = cto.length - 1;

const { values } = parseArgs({ options: { since: { type: "string", default: "7" } } });
const sinceDays = Number.parseInt(String(values.since ?? "7"), 10);
if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 90) {
  die(`--since must be a whole number of days from 1 to 90 (Analytics Engine retains about 90 days); got ${JSON.stringify(values.since)}`);
}

const token = (process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? "").trim();
const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? "").trim();
if (!token) die("CLOUDFLARE_API_TOKEN is not set (a token with Account Analytics Read)");
if (!accountId) die("CLOUDFLARE_ACCOUNT_ID is not set");

const SQL_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
const WINDOW = `timestamp > NOW() - INTERVAL '${sinceDays}' DAY`;

// query POSTs one SQL statement and returns the parsed data rows. The API answers JSON ({ meta, data, rows });
// anything other than a 200 with parseable JSON is reported plainly and stops the run.
async function query(sql) {
  let resp;
  try {
    resp = await fetch(SQL_URL, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: sql });
  } catch (e) {
    die(`the Analytics Engine SQL API was unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await resp.text();
  if (!resp.ok) die(`the SQL API answered HTTP ${resp.status}: ${text.slice(0, 400)}`);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.data) ? parsed.data : [];
  } catch {
    die(`the SQL API answered 200 but not JSON: ${text.slice(0, 400)}`);
  }
}

const n = (row, key) => Math.round(Number(row?.[key] ?? 0));

// The event vocabulary and blob positions mirror src/worker.ts: index1 = event name; blob1 = persona,
// blob2 = route, blob3 = detail, blob4 = anchor, blob5 = src (the ?src= campaign label, carried by
// tour_started and cta_clicked only). double1 = stepIndex.
const startsRows = await query(
  `SELECT blob5 AS src, SUM(_sample_interval) AS n FROM ${DATASET} WHERE index1 = 'tour_started' AND ${WINDOW} GROUP BY src ORDER BY n DESC`,
);
const completionsRows = await query(
  `SELECT SUM(_sample_interval) AS n FROM ${DATASET} WHERE index1 = 'step_reached' AND double1 = ${TERMINAL_INDEX} AND ${WINDOW}`,
);
const stepRows = await query(
  `SELECT double1 AS step, SUM(_sample_interval) AS reached FROM ${DATASET} WHERE index1 = 'step_reached' AND ${WINDOW} GROUP BY step ORDER BY step`,
);
const dropRows = await query(
  `SELECT double1 AS step, SUM(_sample_interval) AS dropped FROM ${DATASET} WHERE index1 = 'drop_step' AND ${WINDOW} GROUP BY step ORDER BY step`,
);
const personaRows = await query(
  `SELECT blob1 AS persona, SUM(_sample_interval) AS n FROM ${DATASET} WHERE index1 = 'persona_chosen' AND ${WINDOW} GROUP BY persona ORDER BY n DESC`,
);
const ctaRows = await query(
  `SELECT blob5 AS src, blob3 AS cta, SUM(_sample_interval) AS n FROM ${DATASET} WHERE index1 = 'cta_clicked' AND ${WINDOW} GROUP BY src, cta ORDER BY n DESC`,
);

const starts = startsRows.reduce((sum, r) => sum + n(r, "n"), 0);
const completions = n(completionsRows[0], "n");
const rate = starts > 0 ? `${((completions / starts) * 100).toFixed(1)}%` : "n/a (no starts)";
// Welcome engagement: every persona_chosen (the two walks AND "explore", the dismissal to free-explore)
// over starts. It reads how many welcome mounts drew any deliberate choice at all; the split below says which.
const welcomeChoices = personaRows.reduce((sum, r) => sum + n(r, "n"), 0);
const engagement = starts > 0 ? `${((welcomeChoices / starts) * 100).toFixed(1)}%` : "n/a (no starts)";
const label = (v) => (v === "" ? "(none)" : v);

console.log(`Tour funnel, last ${sinceDays} day${sinceDays === 1 ? "" : "s"} (dataset ${DATASET})`);
console.log(`  Tour starts:      ${starts}`);
console.log(`  Completions:      ${completions} (step_reached at terminal index ${TERMINAL_INDEX}, derived from chapters.ts)`);
console.log(`  Completion rate:  ${rate}`);
console.log(`  Welcome engagement: ${welcomeChoices} of ${starts} starts made a welcome choice (walks + explore): ${engagement}`);

console.log("\nDrop-off by step (reached = step_reached; left here = drop_step):");
const dropAt = new Map(dropRows.map((r) => [n(r, "step"), n(r, "dropped")]));
if (stepRows.length === 0) console.log("  no step_reached rows in the window");
for (const r of stepRows) {
  const step = n(r, "step");
  console.log(`  step ${String(step).padStart(2)}: reached ${String(n(r, "reached")).padStart(6)}   left here ${String(dropAt.get(step) ?? 0).padStart(6)}`);
}

console.log("\nStarts by campaign source (?src=, blob5):");
if (startsRows.length === 0) console.log("  no tour_started rows in the window");
for (const r of startsRows) console.log(`  ${label(String(r.src ?? "")).padEnd(34)} ${n(r, "n")}`);

console.log("\nWelcome choice (the two walks, plus explore = dismissed to free-explore):");
if (personaRows.length === 0) console.log("  no persona_chosen rows in the window");
for (const r of personaRows) console.log(`  ${label(String(r.persona ?? "")).padEnd(34)} ${n(r, "n")}`);

console.log("\nEnding CTA clicks by campaign source (src is blob5; cta is blob3):");
if (ctaRows.length === 0) console.log("  no cta_clicked rows in the window");
for (const r of ctaRows) console.log(`  ${label(String(r.src ?? "")).padEnd(24)} ${String(r.cta ?? "").padEnd(18)} ${n(r, "n")}`);

console.log(
  "\nNote: Analytics Engine retains roughly 90 days, so this dataset is the pipe, not the archive. Keep this weekly output somewhere durable; rows older than the retention window are gone for good.\n" +
    "Caveats on the ratios: tour_started counts every welcome mount, including crawlers and link-preview fetchers that boot the page, so starts run high and every rate over starts runs low. A visitor who dismisses the welcome and relaunches it mounts the card again, counting a second start and a second choice, so engagement is a coarse ratio over mounts, not deduplicated visitors. The explore choice only exists from the deploy of the welcome-fork rework (authored 2026-08-09): no explore rows exist before it, so welcome engagement is only meaningful for windows that start after that deploy, and the saved 2026-08-09 baseline report predates it, so its numbers are not comparable.",
);
