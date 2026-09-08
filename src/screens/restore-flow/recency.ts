// Restore (IA screens 3 + 4) scheduled-restore-test recency: a fleet-wide read of
// restorability assurance, so a DR responder sees which downpipes have a proven recent
// restore test before they need one. The read is identical to the downpipes screen's
// (the pure restoreTestRecency helper), so it is never a stale green. Moved verbatim out
// of restore-flow.ts for size. House rules: Australian English, no em dashes, precise
// claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { ICON_CHEVRON_RIGHT } from "../../lib/icons.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { skeletonRows, emptyState } from "../../components/feedback.ts";
import { badge, type StatusTone } from "../../components/status.ts";
import type { EngineClient, DownpipeState } from "../../api.ts";
// The scheduled-restore-test recency helpers live with the
// downpipes screen (their primary surface); the restore screen echoes the same honest
// read here so a DR responder sees recoverability assurance across the fleet without
// duplicating the tone/recency logic. Pure functions, no DOM, so importing them is cheap
// and there is no cycle (sources-downpipes does not import this screen).
import { restoreTestRecency, restoreTestCadenceLabel, type RestoreTestRecencyKind } from "../sources-downpipes.ts";

// renderRestoreTestRecencyCard lists each downpipe's scheduled-restore-test cadence and
// last-test recency, computed by the pure restoreTestRecency() helper (shared with the
// downpipes screen) so the read is identical and never a stale green. A failed last test
// reads danger; never-tested / overdue read warn; a recent pass reads ok. Capability-free
// (read only); the engine is the enforcement point for any write.
export function renderRestoreTestRecencyCard(engine: EngineClient): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "rt-recency-h", style: "margin-top:var(--space-5);display:grid;gap:var(--space-3)" });
  const head = h("div", { class: "card__header" });
  head.appendChild(h("h2", { class: "card__title", id: "rt-recency-h" }, "Scheduled restore tests"));
  head.appendChild(badge("trust", "restorability assurance"));
  card.appendChild(head);
  card.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "Each downpipe's restore-test cadence and the recency of its last test, so restorability is evidenced by a drill, not assumed. A scheduled test is a sample-verify drill with no writes; the cadence is set per downpipe in its editor.",
    ),
  );
  // The cadence itself is not set here (this card is a read-only fleet view): it is the "Restore test cadence"
  // select in each downpipe's editor. A direct link there answers "where do I change this" at the point the
  // question arises, rather than leaving the visitor to find the Downpipes screen themselves.
  card.appendChild(
    h(
      "button",
      { "data-dp": "restore-flow.button.navigate-downpipes#2", class: "linklike", type: "button", style: "display:inline-flex;align-items:center;gap:var(--space-1)", on: { click: () => navigate("/downpipes") } },
      "Set a restore-test cadence on a downpipe",
      svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
    ),
  );

  const region = h("div", skeletonRows(3));
  card.appendChild(region);

  void engine
    .listDownpipes()
    .then((list) => region.replaceChildren(restoreTestRecencyList(list)))
    .catch((err) => {
      if (isUnauthorised(err)) return goSignedOut();
      // Read-only context: a calm inline note, never a global error that blocks restore.
      region.replaceChildren(
        h("p", { class: "field__hint" }, "Could not load the scheduled-restore-test recency. The restore flow above is unaffected."),
      );
    });

  return card;
}

// The recency groups, worst first, in the SAME priority order recencyOrder ranks by below (so the
// grouped tile grid and the bucket ranking can never disagree), keyed by the recency KIND rather
// than the tone (a could-not-test deferral and an overdue pass are both "warn", but they are very
// different states and each heading must name its state precisely). A real failure leads; the
// unattributed not-passed and the could-not-test deferral follow (both self-heal: a test runs
// automatically after the next successful backup); then never-tested-or-overdue, the posture
// deferral, no-test-scheduled, and a recent pass trails.
const RECENCY_GROUPS: ReadonlyArray<{ kinds: readonly RestoreTestRecencyKind[]; tone: StatusTone; heading: (n: number) => string }> = [
  { kinds: ["failed"], tone: "danger", heading: (n) => `Failed last test (${n})` },
  { kinds: ["failed-unattributed"], tone: "danger", heading: (n) => `Did not pass, cause unrecorded (${n})` },
  { kinds: ["deferred-no-run"], tone: "warn", heading: (n) => `Not yet testable (${n})` },
  { kinds: ["never", "overdue"], tone: "warn", heading: (n) => `Never tested or overdue (${n})` },
  // A sub-100 attended verification is a real but PARTIAL proof: amber, and distinct from never-tested
  // (it exercised a random subset that recovered), so its own group names it faithfully.
  { kinds: ["attended-partial"], tone: "warn", heading: (n) => `Attended verification, partial sample (${n})` },
  // The break-glass-only posture whose only recorded evidence is a deferred scheduled test: attended
  // verification is now the in-platform proof path for it (the group tile links there).
  { kinds: ["deferred-posture"], tone: "neutral", heading: (n) => `Attended verification available (${n})` },
  { kinds: ["off"], tone: "neutral", heading: (n) => `No test scheduled (${n})` },
  // A full (100% sample) attended proof reads green like a recent scheduled test, but named for its method.
  { kinds: ["attended-full"], tone: "ok", heading: (n) => `Attended verification, full sample (${n})` },
  { kinds: ["ok"], tone: "ok", heading: (n) => `Recently tested (${n})` },
];

// restoreTestRecencyList regroups the fleet BY STATE (the security-centre checks list's own
// grouping idiom: a dot + mixed-case heading naming the count, worst group first) into a
// scannable tile grid, replacing the prior seven near-identical prose rows. Same facts per
// downpipe as before (name, cadence, last-tested line); empty when no downpipes exist (the empty
// state teaches), and a state whose group has no members is omitted rather than shown empty.
function restoreTestRecencyList(list: DownpipeState[]): HTMLElement {
  if (list.length === 0) {
    return emptyState({
      title: "No downpipes yet",
      body: "Once you create a downpipe, its scheduled-restore-test recency appears here. New downpipes default to a weekly restore test.",
    });
  }
  // Most-urgent group first; within a group, name is the tiebreaker.
  const ranked = list.slice().sort((a, b) => recencyOrder(a) - recencyOrder(b) || a.config.name.localeCompare(b.config.name));
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-4)" });
  for (const [bucket, meta] of RECENCY_GROUPS.entries()) {
    const members = ranked.filter((state) => recencyOrder(state) === bucket);
    if (members.length === 0) continue;
    const group = h("div", { style: "display:grid;gap:var(--space-2)" });
    group.appendChild(groupHeading(meta.heading(members.length), meta.tone));
    const tiles = h("div", { class: "rt-tiles" });
    for (const state of members) tiles.appendChild(recencyTile(state));
    group.appendChild(tiles);
    wrap.appendChild(group);
  }
  return wrap;
}

// groupHeading is the security-centre checks list's own group-header idiom (a status dot beside a
// mixed-case section label naming the count), reproduced here in the same tokens rather than
// imported cross-screen from security-centre's own internal module split.
function groupHeading(text: string, tone: StatusTone): HTMLElement {
  return h(
    "div",
    { style: "display:flex;gap:var(--space-2);align-items:center" },
    h("span", { class: `dot dot--${tone}`, "aria-hidden": "true" }),
    h("span", { class: "section-label" }, text),
  );
}

let rtTileSeq = 0;

// recencyTile renders one downpipe's tile: the name and the dot+text state chip (badge, never
// colour alone) on a head row, then the cadence and the last-tested-line detail beneath - the
// identical three facts the old prose row showed. The tone-coloured left edge (rt-tile--<tone>)
// is a second, purely visual echo of the SAME tone the chip already states in text.
function recencyTile(state: DownpipeState): HTMLElement {
  const r = restoreTestRecency(state);
  const nameId = `rt-name-${++rtTileSeq}`;
  const tile = h("div", { class: `rt-tile rt-tile--${r.tone}`, role: "group", "aria-labelledby": nameId });
  tile.appendChild(
    h(
      "div",
      { style: "display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);flex-wrap:wrap" },
      h("span", { class: "rt-tile__name", id: nameId }, state.config.name),
      badge(r.tone, r.label, { dot: true }),
    ),
  );
  tile.appendChild(h("p", { class: "field__hint", style: "margin:0" }, restoreTestCadenceLabel(state.config.restoreTestCadenceSeconds)));
  tile.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, r.detail));
  // The offline-key-only posture whose scheduled test defers (or a sub-100 attended proof that wants a
  // fuller one) gets a direct route into the attended-verification runner: the in-platform proof path, the
  // no-CLI replacement for the old "rehearse offline" dead-end.
  if (r.kind === "deferred-posture" || r.kind === "attended-partial") {
    tile.appendChild(
      h(
        "button",
        { "data-dp": "restore-flow.button.navigate-restore-attend#3", class: "linklike", type: "button", style: "display:inline-flex;align-items:center;gap:var(--space-1);margin-top:var(--space-1)", on: { click: () => navigate("/restore/attend") } },
        r.kind === "attended-partial" ? "Run a full attended verification" : "Prove it with attended verification",
        svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
      ),
    );
  }
  return tile;
}

// recencyOrder ranks a downpipe's restore-test recency for display by its KIND's group index,
// derived from the same RECENCY_GROUPS table the headings render from so the two can never
// disagree. An unknown kind (future engine) sinks to the last group rather than leading.
function recencyOrder(state: DownpipeState): number {
  const kind = restoreTestRecency(state).kind;
  const idx = RECENCY_GROUPS.findIndex((g) => g.kinds.includes(kind));
  return idx === -1 ? RECENCY_GROUPS.length - 1 : idx;
}
