// Field-catalogue reconciliation gate (the "impossible to miss a field" mechanism).
//
// Pairs with scripts/field-census.mjs. The census derives the denominator from source;
// this gate proves the catalogue covers it and that each control meets the three
// guarantees (placeholder, doc link, doc answers). It is the max-lines-lint.mjs pattern:
// collect failures, print them, exit non-zero in --enforce mode.
//
// Two modes:
//   (report, default) print the burndown and exit 0. Useful while the catalogue is still filling in;
//                     the failure counts ARE the remaining work.
//   --enforce         exit 1 on any missing/orphan row or any non-exempt G1/G2/G3 gap. Wired
//                     into `npm run lint` so a new field cannot regress.
//
// Run AFTER the census so it reads a fresh field-census.jsonl:
//   node scripts/field-census.mjs && node scripts/field-catalogue-gate.mjs [--enforce]
//
// --census <path> and --catalogue <path> override the two inputs (both default to the committed
// internal-docs artefacts); see test/validate-field-catalogue-gate.ts, which points both at private
// temp copies to mutation-test the G1/G2/G3 discrimination without touching the shared catalogue.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refuseIfStale, staleness, treeLine } from "./sibling-staleness.mjs";
import { findWorkspaceDir } from "./workspace-root.mjs";

// WHERE THE CATALOGUE LIVES, resolved rather than assumed.
//
// join(scripts, "..", "..", "internal-docs", "FIELD-CATALOGUE") would assert that the console checkout's
// parent IS the workspace root, which is true of the primary checkout and false of every worktree. The
// consequence is a graded NUMBER rather than a crash: the catalogue is the denominator this gate reconciles
// the census against, so resolving a stale or unrelated internal-docs would grade this checkout against a
// checkout that is not it, with the direction of the error not predictable from the outside.
//
// Exit 2 is reserved for "could not check", distinct from this gate's exit 1 for real drift, matching
// internal-docs/FIELD-CATALOGUE/verify-citations.mjs. Without this refusal, a worktree whose parent is not
// the workspace root would die on a raw ENOENT stack trace at exit 1, so "the sibling is missing" and "the
// catalogue disagrees with the source" would share an exit code and the reader would have to parse a Node
// stack to tell them apart.
//
// THE REFUSAL FIRES ONLY WHEN A DEFAULT PATH IS ACTUALLY NEEDED. Both inputs can be overridden, and a
// caller that overrides BOTH reads nothing out of internal-docs at all, so demanding the sibling of that
// caller would refuse a run that has no sibling to be wrong about. test/validate-field-catalogue-gate.ts
// drives this gate with both overrides pointed at a private temp fixture and runs inside `npm run
// validate`, whose CI job checks console out ALONE: an unnarrowed refusal there would fire before either
// flag is read, so every execFileSync call would return no parseable stdout and every assertion in that
// test would fail with got=null. The refusal is right in every case where the shared catalogue is
// genuinely read, which is why it is narrowed here rather than removed.
const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = join("internal-docs", "FIELD-CATALOGUE", "catalogue.jsonl");
const argPath = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const CENSUS_OVERRIDE = argPath("--census");
const CATALOGUE_OVERRIDE = argPath("--catalogue");
const NEEDS_WORKSPACE = CENSUS_OVERRIDE === null || CATALOGUE_OVERRIDE === null;
const WORKSPACE = findWorkspaceDir(CONSOLE_ROOT, MARKER);
if (WORKSPACE === null && NEEDS_WORKSPACE) {
  console.error(`\nFATAL field-catalogue: could not resolve the workspace root from ${CONSOLE_ROOT}.`);
  console.error(`  Tried the direct parent and the owner of any .worktrees segment; none carries ${MARKER}`);
  console.error("  outside a .worktrees directory, which is refused however it is reached.");
  console.error("  Check internal-docs out beside this repo, or set DOWNPIPES_WORKSPACE=/path/to/workspace-root.");
  console.error("  Refusing to grade, because every catalogued field would reconcile against a catalogue that");
  console.error("  is not this checkout's, which is wrong rather than merely incomplete.\n");
  process.exit(2);
}
// Null only when BOTH inputs were overridden, which is the one case the refusal above lets through.
const CAMPAIGN = WORKSPACE === null ? null : join(WORKSPACE, "internal-docs", "FIELD-CATALOGUE");

// HOW OLD THAT CATALOGUE IS, SAID OUT LOUD AND THEN REFUSED.
//
// The note above settles WHICH internal-docs is read. It says nothing about HOW OLD it is, and that second
// question matters just as much: a stale sibling can make this gate exit 0 reporting full coverage while a
// sibling gate reading the identical checkout exits 2 naming the lag, so staleness on its own is not
// self-evident from this gate's own output.
//
// WHY A REFUSAL HERE RATHER THAN A PRINTED CAVEAT. Every number this gate prints is a count of MISSES
// derived by reconciling console/src against a catalogue in another repository, and against an old
// catalogue those counts are wrong in BOTH directions at once: a control catalogued after the checkout's
// HEAD reads as `missing`, an accusation against a fix that has already landed, and a row retired after it
// reads as `orphan`. Nothing in the output carries a sha, a digest or a direction, so there is nothing in a
// red for a reader to audit and nothing in a green to doubt. That is the case where exit 2 beats a finding.
// docs/scripts/check-immutability-verdicts.mjs faces the same stale-sibling risk and MEASURES instead of
// refusing, because it names each reading and the direction it moved, which a reader can weigh. The
// postures differ on what the output hands the reader, not on a rule applied to every gate.
//
// IT IS HELD TO THE SAME NARROWING AS THE REFUSAL ABOVE, and the condition is NEEDS_WORKSPACE rather than
// CAMPAIGN. A caller that overrides both inputs reads nothing out of internal-docs, so it gets neither the
// line nor the refusal, but CAMPAIGN is non-null for it anyway whenever the workspace happens to resolve.
// Keying this on CAMPAIGN alone would make the both-override caller exit 2 beside the shared checkout even
// though it never reads it, exactly the false refusal the narrowing above exists to prevent.
if (NEEDS_WORKSPACE && WORKSPACE !== null) {
  const SIBLING = join(WORKSPACE, "internal-docs");
  const s = staleness(SIBLING);
  console.log(treeLine("[field-catalogue]", "internal-docs", SIBLING, s));
  refuseIfStale({
    repoDir: SIBLING,
    label: "internal-docs",
    tag: "[field-catalogue]",
    allowEnv: "FIELD_CATALOGUE_ALLOW_STALE",
    measured: s,
    why: [
      "Every count below is a count of MISSES reconciled against that catalogue, and an old one is wrong in",
      "both directions at once: a control catalogued since that HEAD reads as uncatalogued, and a row retired",
      "since it reads as an orphan. The percentage would describe a reconciliation nobody has to do.",
    ],
  });
}

const ENFORCE = process.argv.includes("--enforce");
const readJsonl = (p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --census reads the census from somewhere other than its canonical home, so `field:gate` can grade a
// FRESH census without writing one into the shared internal-docs repo. Defaults to the committed artefact,
// so every existing caller is unchanged.
const censusPath = CENSUS_OVERRIDE ?? join(/** @type {string} */ (CAMPAIGN), "field-census.jsonl");
const census = readJsonl(censusPath);

// --catalogue, same shape as --census and for the same reason: test/validate-field-catalogue-gate.ts plants
// a G1/G2/G3 gap in a PRIVATE copy of the catalogue to prove this gate's exit code actually moves, and must
// never write into the shared internal-docs repo to do it. Defaults to the committed artefact, so every
// existing caller (field:gate, an operator running the script bare) is unchanged.
const cataloguePath = CATALOGUE_OVERRIDE ?? join(/** @type {string} */ (CAMPAIGN), "catalogue.jsonl");
const catalogue = readJsonl(cataloguePath);
const censusByKey = new Map(census.map((r) => [r.key, r]));

// FLOORS ON BOTH SIDES OF THE RECONCILIATION, checked before anything is graded.
//
// Every count below is a count of MISSES, so both inputs going empty is the quietest possible pass: an
// empty census makes `missing` zero (nothing in source to be uncatalogued) and `pct` divide by zero, so
// the gate printed NaN% one line above its own clean report; an empty catalogue makes `orphan` and both
// G-gap lists zero. Neither is exotic. The census is DERIVED by scripts/field-census.mjs walking src, and
// `field:gate` regenerates it into node_modules/.cache on every run, so a census that emits no rows (src
// moved, a control idiom the parser stops recognising, an interrupted write) lands here as a file the
// gate reads without complaint.
//
// The floors are 150 each: low enough that a genuine round of field removals passes and high enough that
// a collapse cannot. This gate is the one documented as enforcing the field-catalogue rule, so it has to
// fail rather than congratulate itself when it has nothing to reconcile.
const MIN_ROWS = 150;
if (census.length < MIN_ROWS) {
  console.error(`\n[field-catalogue] FAIL: the census at ${censusPath} holds ${census.length} row(s), expected at least ${MIN_ROWS}. Re-run scripts/field-census.mjs; every burndown number below is derived from this denominator.\n`);
  process.exit(1);
}
if (catalogue.length < MIN_ROWS) {
  console.error(`\n[field-catalogue] FAIL: the catalogue holds ${catalogue.length} row(s), expected at least ${MIN_ROWS}. Nothing to reconcile the census against, so no guarantee below has been checked.\n`);
  process.exit(1);
}

// Controls where a placeholder example is meaningful. A select/checkbox/radio/toggle/switch/
// file input, or a secret, is exempt from G1 and satisfies its guidance through options + the
// doc link instead.
const TYPEABLE = new Set(["input", "text", "email", "url", "number", "search", "tel", "textarea"]);
const placeholderExempt = (r) => {
  const c = censusByKey.get(r.key);
  if (!c || !TYPEABLE.has(c.control)) return true; // not a typeable control -> no placeholder expected
  return String(r.placeholder_status || "").startsWith("na"); // declared secret/boolean/etc
};

// Per-key exemptions with a rationale, mirroring max-lines-lint's EXEMPT.
// key -> rationale. A key here is skipped by the G1/G2 checks and must carry a reason, reconciled per
// internal-docs/FIELD-CATALOGUE/CROSS-CHECK-PROTOCOL.md. Structural/chrome controls (table toolbars,
// filter bars, the command palette, the nav rail, appearance toggles, generic list/checkbox-row
// helpers) are exempted as not documented data fields. The two blackout-window time fields are NOT
// here: their format is documented at backing-up/overview#maintenance-blackout-windows and both carry
// their own inline doc: (editor-schedule-windows.ts), so G2 is satisfied for real. One real control
// (the per-downpipe enable switch) has no answering page and is marked FLAGGED-needs-docs, an owner
// follow-up, rather than pointed at a page that would not answer it. Every doc claim below must be kept
// verified against source and the docs main.
const EXEMPT = new Map([
  ["src/components/code-block.ts::toggle", "reveal/conceal eye toggle for an on-screen value (aria-pressed icon button, keyField); not a data-entry field."],
  ["src/components/confirm.ts::text", "type-to-confirm gate: the value is a shown token to re-type, not a documentable field (matches this row's own justified-na note)."],
  ["src/components/data-table-rows.ts::Select all rows", "table header bulk-select checkbox (tri-state select-all); table chrome, not a data field."],
  ["src/components/data-table-rows.ts::checkbox", "table per-row select checkbox; table chrome, not a data field."],
  ["src/components/data-table-toolbar.ts::search", "table filter/search input; table chrome, not a documented data field."],
  ["src/components/data-table-toolbar.ts::toggle#1", "table facet-chip filter toggle; table chrome, not a data field."],
  ["src/components/data-table-toolbar.ts::toggle#2", "table row-density (comfortable/compact) toggle; table chrome, not a data field."],
  ["src/components/recovery-codes-panel.ts::checkbox", "\"I have saved my recovery codes\" acknowledgement gate (buildSaveConfirmGate); a confirm-gate like type-to-confirm, not a data field with accepted values."],
  ["src/lib/demo/tour/nav-bar.ts::toggle", "tour-demo Play/Pause / info toggle button (src/lib/demo/tour/); demo-only chrome, not a product field."],
  ["src/screens/command-palette/surface.ts::text", "the Cmd+K command-palette search input; navigation chrome, not a documented data field."],
  ["src/screens/map/filter-bar.ts::toggle", "map facet-filter single-select toggle button; filter-bar chrome, not a data field."],
  ["src/screens/notifications/shared.ts::checkbox", "the checkboxRow() helper's own internal input; not itself a business field. Its meaningful call sites (channel-enabled, rule-enabled) are catalogued and exempted separately, below."],
  ["src/screens/notifications/channels.ts::channel-enabled", "on/off checkbox for whether a channel is active, shown only on edit (a new channel starts enabled). Its consequence is stated in full inline (channels.ts hint: \"a disabled channel is kept but receives nothing until re-enabled\"). day-2/notifications.mdx carries the group-level link nearby but shows enabled only inside JSON samples, not the toggle's semantics, so this is left self-documenting rather than pointed at a page that would not answer it."],
  ["src/screens/notifications/rule-form.ts::rule-enabled", "on/off checkbox for whether a rule is active, shown only on edit; same basis as channel-enabled (full inline hint: \"a disabled rule delivers nothing until re-enabled\"; day-2/notifications.mdx does not state this beyond the sample JSON)."],
  ["src/screens/onboarding/carousel-cards-connect-keys.ts::checkbox", "self-attestation prerequisite checklist item (has the operator turned on Workers Paid / R2 / Access / email in their own Cloudflare dashboard); each item's own explanation is inline, not a separate data field with accepted values."],
  ["src/screens/onboarding/shared.ts::toggle", "System/Light/Dark colour-theme picker (onboarding's own copy of the settings/appearance.ts control); decorative preference, self-evident from its own labelled options."],
  ["src/screens/settings/appearance.ts::radio#1", "System/Light/Dark colour-theme picker; decorative preference, self-evident from its own labelled options."],
  ["src/screens/settings/appearance.ts::radio#2", "Aurora backdrop Off/On picker; decorative only, honours reduced motion, self-evident from its own labelled options."],
  ["src/screens/settings/appearance.ts::radio#3", "Rain backdrop Off/Medium/Storm picker; decorative only, honours reduced motion, self-evident from its own labelled options."],
  ["src/screens/settings/appearance.ts::radio#4", "prefRow(): the generic accessibility-preference radiogroup idiom (e.g. reduced motion); decorative/preference UI, self-evident from its own labelled options."],
  ["src/screens/sources/shared.ts::checkbox", "selectableSourceList()'s generic per-item checkbox; a reusable list-selection primitive (used for R2/KV/D1/Secrets binding lists and more), not itself a business field."],
  ["src/screens/sources/shared.ts::search", "selectableSourceList()'s live filter box for a long binding list; list-filter chrome, not a data field."],
  ["src/shell/dom.ts::Executive view (plain-English answers)", "Executive/Technical view-mode segmented control; explicitly presentation-only per its own code comment (\"no authority: it changes the skin, never what the engine permits\"), not a data field."],
  ["src/shell/dom.ts::Technical view (the full operator console)", "the paired button of the Executive/Technical view-mode control above; presentation-only skin toggle, not a data field."],
  ["src/shell/rail.ts::toggle", "the rail's \"show all screens (read-only)\" escape-hatch toggle; navigation chrome, not a data field."],
  // FLAGGED-needs-docs: a real operator control with no page that documents it as its own subject.
  // Do not fabricate a link; this is logged for the owner as a docs follow-up.
  ["src/screens/sources-downpipes/table.ts::checkbox", "FLAGGED-needs-docs: the per-downpipe enable/disable switch (enabledSwitch, sources-downpipes/table.ts, data-dp sources-downpipes.checkbox.enabled-switch). On/off is self-evident, but no page documents the control as its subject or states what toggling it does and preserves: backing-up/overview.mdx's downpipe field table (cadenceSeconds, destinationIds, retention, restoreTestCadenceSeconds) has no enabled row, and the disabled state is only named incidentally elsewhere (topology-map.mdx's map-state legend \"Disabled | The downpipe is paused, ... deliberate state, not a failure\"; offboarding-and-exit.mdx's \"pause every downpipe\" exit step; the downpipe_enabled OTLP metric). Unlike channel-enabled/rule-enabled there is no full inline hint either, and switching a backup off is consequential, so it is flagged for a real docs home (an enabled row on backing-up/overview) rather than exempted as trivial or pointed at a page that would not answer it."],
  // GROUP-LINK: a real field() control whose accepted values ARE documented, but whose honest doc link
  // lives at the group level, because a sibling control in the same group cannot carry its own field()
  // doc and depends on that group link for its own G2. Giving the field its own inline doc: as well would
  // render two links to the identical URL side by side, so the field carries no inline doc of its own; the
  // group link is the field's real, sole doc link, cited in the row's doc_url.
  ["src/screens/costs/inputs-section.ts::cost-source", "Answered by the group 'About source size' link (inputs-section.ts sourceSizeField, the <a> at lines 118-123, rendered below the number+unit row). The sibling 'Source size unit' select (raw select, data-dp costs.select.unit, cannot take a field() doc) shares that same group link, and nesting a doc inside the number field would also drop the GB select below it on a phone, so cost-source's field-level doc: was removed rather than duplicating it. cost-prediction#manual-mode-and-observed-mode states the source size as a number plus a unit (MB/GB/TB)."],
  ["src/screens/idp-connections/forms.ts::idp-secret", "Answered by the group 'About secret modes (confidential or public)' link (forms.ts presetFields, the <a> at lines 128-133). It is deliberately built to stay visible when Public client ticks and hides this field (secretSlot.hidden, forms.ts:122), and the sibling idp-public-client checkbox (raw checkbox, cannot take a field() doc) depends on it, so idp-secret's field-level doc: was removed rather than duplicating it. connect-oidc-oauth2 states the two working secret modes (public/PKCE vs a write-only confidential secret)."],
  // NOT REACHABLE: a control gated off in the live UI, so no operator can encounter it undocumented.
  // sources/stream-images-artifacts.mdx does not document Artifact Registry on the published page (the
  // prose is inside an MDX comment block pending GA), so doc_url is null in the catalogue rather than
  // citing a page that would not answer it.
  ["src/screens/sources-downpipes/editor-wizard-source-rows.ts::wiz-source#4", "Artifact Registry is gated behind ARTIFACTS_GA (console/src/lib/token-source.ts:94, currently false). editor-wizard-source-sections.ts:321 gates the row on ARTIFACTS_GA && found.artifactsSupported && isAdded(\"artifacts\"), so with the flag false the row is never appended and the control is unreachable in the live UI. The published sources/stream-images-artifacts.mdx (title 'Stream and Images sources') does not answer it: the Artifact Registry prose is inside an MDX comment block (stream-images-artifacts.mdx:57-83) pending GA. Re-check when ARTIFACTS_GA flips true and that prose is restored to the page."],
]);

const censusKeys = new Set(census.map((r) => r.key));
const catKeys = new Set(catalogue.map((r) => r.key));

const missing = census.filter((r) => !catKeys.has(r.key));               // in source, not catalogued
const orphan = catalogue.filter((r) => !censusKeys.has(r.key));           // catalogued, not in source (stale)
// G1/G2 are read from the SOURCE (the census hasPlaceholder/hasDoc), not the catalogue's self-report,
// so the gate proves the code actually carries the placeholder and the doc link, not just that the row claims it.
const g1gaps = catalogue.filter((r) => !EXEMPT.has(r.key) && !placeholderExempt(r) && !censusByKey.get(r.key)?.hasPlaceholder);
const g2gaps = catalogue.filter((r) => {
  if (EXEMPT.has(r.key)) return false;
  const c = censusByKey.get(r.key);
  if (!c) return false; // absence is a `missing` finding, not a G2 gap
  // A field() control must carry the inline doc link in the SOURCE (census hasDoc). A raw / group
  // control (a radio, checkbox or bare input) cannot take a field() doc, so its link lives at the
  // group level and is recorded as the catalogue row's doc_url.
  return c.mechanism === "field" ? !c.hasDoc : !r.doc_url;
});
const g3gaps = catalogue.filter((r) => r.doc_url && r.doc_answers !== "yes");
// RECORDED divergences, and the word is load-bearing. This reads the catalogue's own hand-written
// `divergence` string; it does not compare the client validator against the server one. So it can only ever
// report a divergence a human already found and wrote down, and it reports zero for one nobody noticed.
//
// That is not hypothetical. A field validated only as `v.length >= 1` against a server bound of, say, 128
// characters is exactly this shape: the client accepts far more than the server will, and if the server
// side (the engine's boundedStr, say) returns null on an over-long value rather than refusing it, the value
// can be SILENTLY DROPPED rather than refused. Every row with an empty "divergence" string reads as clean
// to this filter regardless of whether such a gap exists, because nothing here re-derives looseness from
// the two validators themselves.
//
// Deriving looseness mechanically is not available here: both validator columns are prose describing code in
// two repos, not a machine-comparable shape. So the honest fix is the label, which now says RECORDED, and
// this note. A gate that cannot check something must say so rather than print a number that reads as a
// measurement. See internal-docs/GUARD-THAT-CHECKS-A-LIST.md for the shape.
const divergences = catalogue.filter((r) => /client-looser|drift-risk/.test(String(r.divergence || "")));

const pct = (n) => `${((n / census.length) * 100).toFixed(1)}%`;
console.log(`\n[field-catalogue] census ${census.length} controls / catalogued ${census.length - missing.length} (${pct(census.length - missing.length)})\n`);
console.log("Burndown:");
console.log(`  uncatalogued controls (must reach 0):     ${missing.length}`);
console.log(`  orphan catalogue rows (stale key):        ${orphan.length}`);
console.log(`  G1 placeholder gaps (typeable, no eg):    ${g1gaps.length}`);
console.log(`  G2 doc-link gaps (no doc_url):            ${g2gaps.length}`);
console.log(`  G3 doc-answers gaps (link != 'yes'):     ${g3gaps.length}`);
console.log(`  RECORDED divergences (client-looser):     ${divergences.length}   <- from the catalogue's own divergence column, NOT derived; an unrecorded one reads as zero`);

if (missing.length) {
  console.log(`\nFirst 15 uncatalogued controls (of ${missing.length}):`);
  for (const r of missing.slice(0, 15)) console.log(`  ${r.key}   [${r.mechanism} ${r.control}]  ${r.fn ?? ""}`);
}
if (orphan.length) {
  console.log(`\nOrphan catalogue rows (key not in current source; re-seed from the census):`);
  for (const r of orphan.slice(0, 15)) console.log(`  ${r.key}`);
}
if (divergences.length) {
  console.log(`\nValidation divergences to resolve:`);
  for (const r of divergences) console.log(`  ${r.key}  ->  ${r.divergence}`);
}

const hardFail = missing.length + orphan.length + g1gaps.length + g2gaps.length + g3gaps.length;
if (ENFORCE && hardFail) {
  console.error(`\n[field-catalogue] FAIL (enforce): ${hardFail} unresolved (missing/orphan/G1/G2/G3). Catalogue every control, add its placeholder + doc link, and make sure the linked page actually answers it.\n`);
  process.exit(1);
}
console.log(`\n[field-catalogue] ${ENFORCE ? "enforce" : "report"} mode: ${hardFail === 0 ? "OK, all guarantees met" : `${hardFail} open (report mode, not failing the build yet)`}\n`);
