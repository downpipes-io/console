// Coverage / gap detection for the Security centre (build contract section 7 + section 9): which resources are
// protected, which are unprotected (exist but are NOT backed up), and which are backed up but never proven
// recoverable. The view is computed in the customer's own account over a reference inventory; the vendor reads
// nothing. The PURE projection (coverageFindings and its helpers) is the load-bearing logic the validator
// asserts (the "exists but is NOT backed up" wording, the danger tone, the back-up action on exactly the
// unprotected rows). Moved verbatim from the security-centre coordinator for size; it imports the shared leaf
// (./shared.ts) only, so it never imports another section module (which would form a cycle).
//
// HONEST UNKNOWN: with no inventory stored the engine makes NO coverage claim, and this section says so plainly
// and points at enabling read-only discovery, rather than implying full coverage. NO-CUSTODY: a coverage row
// carries a type, native id, label, status and the covering downpipe id only; every server-supplied string
// enters the DOM as a text node. House rules: Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { emptyState } from "../../components/feedback.ts";
import { badge, type StatusTone } from "../../components/status.ts";
import { statTile, statGrid } from "../../components/stat-tiles.ts";
import { relativeTime } from "../../lib/format.ts";
import { ICON_INFO, ICON_EXTERNAL, ICON_PLUS, ICON_REFRESH, ICON_SHIELD_CHECK } from "../../lib/icons.ts";
import type { CoverageReport, CoverageResource, CoverageResourceType, CoverageStatus, InventoryResource, ResourceInventory } from "../../api.ts";
import { groupLabel, noteLine } from "./shared.ts";

// PopulateInventory is the injected affordance the coordinator wires for an access.policy caller: the
// label is fixed ("Populate inventory") and onClick opens the populate modal. It is OPTIONAL so the pure
// render stays usable without it (the validator passes a no-op, and a caller without access.policy passes
// none, so no affordance is shown). Keeping the modal/engine behaviour in the coordinator (behind this
// callback) keeps this module's render DOM-light and engine-free, exactly as the back-up action already is.
export interface PopulateInventory {
  onClick: () => void;
}

// COVERAGE_INVENTORY_TYPES is the fixed render order of the four inventory groups (one textarea each in
// the populate modal), matching the engine's ResourceInventory shape. Exported so the coordinator builds
// exactly these four textareas in this order.
export const COVERAGE_INVENTORY_TYPES: CoverageResourceType[] = ["kv", "r2", "d1", "secrets"];

// parseInventoryGroup parses one textarea's worth of pasted resources into InventoryResource[]. The format
// is one resource per line, "<id>" or "<id>, <label>" (the FIRST comma splits id from an optional label;
// a label may itself contain commas). Blank lines are ignored so a trailing newline is harmless. It does
// NO validation of the id charset or bounds: that is the engine's authority (validateInventory), which
// answers a bad id with a 400 the populate modal surfaces verbatim. It is a pure string transform, so it
// is unit-testable without a DOM and carries no value or key (an id/label is account metadata only).
// inventoryLinesIntended counts the lines the operator MEANT as resources: every non-blank line in the paste
// (G308). It is the denominator parseInventoryGroup has never had.
//
// parseInventoryGroup drops a line whose id is empty (a line that is only a comma, or only a label), silently, so
// the saved inventory is smaller than the paste and the coverage grid then reports coverage against a roster with
// a hole in it. The operator sees a success toast with a count they have no reason to check. Pure; the ids and
// labels are never read.
export function inventoryLinesIntended(text: string): number {
  let n = 0;
  for (const raw of text.split("\n")) if (raw.trim() !== "") n++;
  return n;
}

// inventoryLinesDropped is the count of non-blank lines parseInventoryGroup discarded across all four groups.
// Pure; it re-runs the parse rather than reaching into it, so the two can never disagree about what was kept.
export function inventoryLinesDropped(groups: Record<CoverageResourceType, string>): { accepted: number; dropped: number } {
  let intended = 0;
  let accepted = 0;
  for (const text of Object.values(groups)) {
    intended += inventoryLinesIntended(text);
    accepted += parseInventoryGroup(text).length;
  }
  return { accepted, dropped: Math.max(0, intended - accepted) };
}

export function parseInventoryGroup(text: string): InventoryResource[] {
  const out: InventoryResource[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const comma = line.indexOf(",");
    if (comma === -1) {
      out.push({ id: line });
      continue;
    }
    const id = line.slice(0, comma).trim();
    const name = line.slice(comma + 1).trim();
    if (id === "") continue; // a line that is only a comma/label has no id; skip it
    out.push(name === "" ? { id } : { id, name });
  }
  return out;
}

// parseInventory turns the four textareas (keyed by type) into a ResourceInventory the engine accepts. An
// omitted/blank group becomes an empty list (the engine treats an empty group as "the operator has none").
// Pure and DOM-free so the coordinator can build it from the modal's controls and the validator can assert
// the parse. The engine validates + bounds the result; this only shapes the body.
export function parseInventory(groups: Record<CoverageResourceType, string>): ResourceInventory {
  return {
    kv: parseInventoryGroup(groups.kv),
    r2: parseInventoryGroup(groups.r2),
    d1: parseInventoryGroup(groups.d1),
    secrets: parseInventoryGroup(groups.secrets),
  };
}

// CoverageFinding is the data behind one rendered coverage row: the resource it concerns, a tone, a
// short status label, a one-line plain-English statement and (for an unprotected resource) the
// "Back this up" call to action. It is a pure projection of a CoverageResource, so the ordering and
// the "exists but is NOT backed up" wording are unit-testable without a DOM (the same seam the rest
// of this screen uses). The action carries no behaviour here; it is the typed intent the renderer
// turns into a button that routes to the downpipe-create flow.
export interface CoverageFinding {
  resource: CoverageResource;
  tone: StatusTone;
  statusLabel: string;
  statement: string;
  // "back-up" is the only action: an unprotected resource gets a "Back this up" affordance. A
  // covered resource (protected/untested) gets none here (the row links to its covering downpipe
  // instead). Absent means no primary action.
  action?: "back-up";
}

// coverageStatusTone maps a coverage status to a tone, NEVER a stale green: an unprotected resource
// reads danger (it exists and nothing backs it up), an untested resource reads warn (backed up but
// recoverability unproven, so not safe), and only a protected resource reads ok. Exported for the
// validator (the load-bearing "unprotected is never the ok tone" honesty).
export function coverageStatusTone(status: CoverageStatus): StatusTone {
  switch (status) {
    case "protected": return "ok";
    case "untested": return "warn";
    case "unprotected": return "danger";
  }
}

// coverageStatusLabel is the short human label per status. "not backed up" is deliberately blunt for
// the unprotected case (the gap this feature exists to surface); "backed up, not yet proven" states
// the untested middle honestly (never "safe"). The strong label is "proven", not "protected": on
// this screen the strong state means a restore has been PROVEN, whereas Sources/Overview use
// "protected" for merely attached-and-covered, so reusing the word here would overclaim. Exported
// for the validator.
export function coverageStatusLabel(status: CoverageStatus): string {
  switch (status) {
    case "protected": return "proven";
    case "untested": return "backed up, not yet proven";
    case "unprotected": return "not backed up";
  }
}

// coverageTypeLabel is the human label for a resource type (the inventory groups by type).
export function coverageTypeLabel(type: CoverageResourceType): string {
  switch (type) {
    case "kv": return "KV namespace";
    case "r2": return "R2 bucket";
    case "secrets": return "Secrets Store secret";
    case "d1": return "D1 database";
  }
}

// coverageStatusOrder ranks a status for display: the worst (unprotected) leads, then the unproven
// middle (untested), then protected, so the most important gap is at the top. Exported for the test.
export function coverageStatusOrder(status: CoverageStatus): number {
  switch (status) {
    case "unprotected": return 0;
    case "untested": return 1;
    case "protected": return 2;
  }
}

// compareCoverageResources orders coverage rows for display: by status (unprotected first, then
// untested, then protected), then by type for a stable grouping, then by display name. This puts the
// "exists but is NOT backed up" findings at the top where an operator sees them immediately.
// Exported so the validator asserts the ranking.
export function compareCoverageResources(a: CoverageResource, b: CoverageResource): number {
  const st = coverageStatusOrder(a.status) - coverageStatusOrder(b.status);
  if (st !== 0) return st;
  if (a.type !== b.type) return a.type.localeCompare(b.type);
  return a.name.localeCompare(b.name);
}

// coverageStatement is the one-line, plain-English, precise statement for a row. The unprotected case
// is the contract's exact framing: "<resource> exists but is NOT backed up". The untested case states
// the unproven middle honestly; the protected case states what protected actually means (backed up,
// runs succeed, restore proven), never an absolute "safe". The resource name is the engine's own
// redaction-safe label; it is rendered as a text node by the caller, never parsed as markup.
export function coverageStatement(resource: CoverageResource): string {
  const what = `${coverageTypeLabel(resource.type)} "${resource.name}"`;
  switch (resource.status) {
    case "unprotected":
      return `${what} exists but is NOT backed up. No downpipe covers it; create one to start protecting it.`;
    case "untested":
      return `${what} is backed up but its recoverability has not been proven. Run a restore test so it can be counted as protected.`;
    case "protected":
      return `${what} is backed up, its runs succeed and a restore has been proven. It is protected.`;
  }
}

// coverageFindings is the PURE projection the renderer consumes: the ranked rows turned into
// CoverageFinding descriptors (tone, status label, statement, and the "back this up" action for an
// unprotected resource). It is the load-bearing logic the validator asserts (the "exists but is NOT
// backed up" wording, the danger tone, and the presence of the back-up action on exactly the
// unprotected rows). It does no I/O and reads only redaction-safe fields.
export function coverageFindings(report: CoverageReport): CoverageFinding[] {
  return report.resources
    .slice()
    .sort(compareCoverageResources)
    .map((resource) => {
      const finding: CoverageFinding = {
        resource,
        tone: coverageStatusTone(resource.status),
        statusLabel: coverageStatusLabel(resource.status),
        statement: coverageStatement(resource),
      };
      if (resource.status === "unprotected") finding.action = "back-up";
      return finding;
    });
}

// renderCoverage builds the Coverage section. It has three honest states:
//   - hasInventory:false  -> the honest-unknown state (no inventory): make NO coverage claim and
//                            prompt the operator to enable read-only discovery to detect gaps.
//   - hasInventory:true, no resources -> a stored-but-empty inventory (nothing to report yet).
//   - hasInventory:true, resources    -> the rollup tiles, then the ranked findings (unprotected
//                            warn/danger findings with a "Back this up" action first).
// `populate` is the OPTIONAL "Populate inventory" affordance the coordinator wires for an access.policy
// caller (it opens the populate modal); when omitted (a caller without access.policy, or the validator's
// pure render) no populate affordance is shown, only Refresh and the back-up actions.
// Exported so the validator can render it against a stub and inspect the result tree. Every
// server-supplied string is a text node; no inline script, no inline handler, no setAttribute(style).
export function renderCoverage(report: CoverageReport, reload: () => void, populate?: PopulateInventory): HTMLElement {
  const section = h("section", { class: "stack", style: "display:grid;gap:var(--space-4)", "aria-labelledby": "coverage-h" });

  const head = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  lead.appendChild(h("h2", { id: "coverage-h", style: "font-size:var(--text-lg)" }, "Coverage"));
  lead.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "Which of your resources are protected, which exist but are not backed up, and which are backed up but never proven recoverable. Computed in your own account; the vendor reads nothing.",
    ),
  );
  head.appendChild(lead);
  const actions = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  // The "Populate inventory" affordance sits beside Refresh for an access.policy caller, so the operator
  // can record the reference inventory the gap view compares against without dropping to a curl.
  if (populate) {
    const populateBtn = h("button", { "data-dp": "security-centre.button.populate", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Populate inventory") as HTMLButtonElement;
    populateBtn.addEventListener("click", populate.onClick);
    actions.appendChild(populateBtn);
  }
  const refreshBtn = h("button", { "data-dp": "security-centre.button.refresh#1", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Refresh") as HTMLButtonElement;
  refreshBtn.addEventListener("click", reload);
  actions.appendChild(refreshBtn);
  head.appendChild(actions);
  section.appendChild(head);

  // HONEST UNKNOWN: no inventory stored. Make no coverage claim; point at read-only discovery.
  if (!report.hasInventory) {
    section.appendChild(coverageUnknownState(populate));
    return section;
  }

  // An inventory is stored but empty (nothing to report yet) -- a distinct, honest state.
  if (report.resources.length === 0) {
    section.appendChild(coverageEmptyState());
    return section;
  }

  section.appendChild(coverageRollup(report.rollup, report.generatedAt));
  section.appendChild(renderCoveragePopulated(report));
  return section;
}

// coverageEmptyState: an inventory is recorded but lists no resources, so there is nothing to compare
// against the downpipes yet -- a distinct, honest state from the no-inventory unknown.
function coverageEmptyState(): HTMLElement {
  return emptyState({
    title: "Inventory is empty",
    body: "An inventory is recorded but lists no resources, so there is nothing to compare against your downpipes yet. Add resources to your inventory (or run read-only discovery) to surface any gaps.",
  });
}

// COVERAGE_CARDS_PER_GROUP bounds how many finding cards each group renders up front. A coverage list must
// never HIDE a finding (an unshown "exists but not backed up" resource is a gap the operator never acts on), so
// the group label always states the TRUE count and a "Show all" affordance reveals every remaining card in
// place. The cap keeps the calm default BOUNDED: without it a large inventory rendered one card per resource
// with no ceiling, growing the page without bound. Matches the slice(0, LIMIT) idiom used
// across the console (fleet-section, notifications, restore plan). The exact ceiling is a calm-density
// judgement; 50 lets a normal account (a handful of resources) never meet the affordance, and only bounds the
// page at real scale. Exported so the validator asserts the default render is capped without a magic number.
export const COVERAGE_CARDS_PER_GROUP = 50;

// appendCoverageGroup renders one finding group into `list`: the labelled heading (carrying the TRUE count),
// then up to COVERAGE_CARDS_PER_GROUP cards in the group's own container, then -- only when the group is larger
// -- a "Show all N" button that appends the remaining cards into that container and removes itself. Nothing is
// hidden: the count is always honest and every card is one click away; the cap only defers the tail so the
// default render stays bounded. A no-op for an empty group. The cards sit in their own container so "Show all"
// appends into the correct group position without an insertBefore.
function appendCoverageGroup(list: HTMLElement, label: string, tone: StatusTone, findings: CoverageFinding[]): void {
  if (findings.length === 0) return;
  list.appendChild(groupLabel(`${label} (${findings.length})`, tone));
  const cards = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  for (const f of findings.slice(0, COVERAGE_CARDS_PER_GROUP)) cards.appendChild(coverageCard(f));
  list.appendChild(cards);
  const rest = findings.slice(COVERAGE_CARDS_PER_GROUP);
  if (rest.length === 0) return;
  const showAll = h(
    "button",
    { "data-dp": "security-centre.button.show-all", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Show all ${findings.length} findings in this group` },
    `Show all ${findings.length}`,
  ) as HTMLButtonElement;
  showAll.addEventListener("click", () => {
    for (const f of rest) cards.appendChild(coverageCard(f));
    showAll.remove();
  });
  list.appendChild(showAll);
}

// renderCoveragePopulated builds the grouped finding list (not backed up, then unproven, then
// protected) for a non-empty inventory. Each group is shown only when it has members, capped per group.
function renderCoveragePopulated(report: CoverageReport): HTMLElement {
  const findings = coverageFindings(report);
  const list = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  appendCoverageGroup(list, "Exists but not backed up", "danger", findings.filter((f) => f.resource.status === "unprotected"));
  appendCoverageGroup(list, "Backed up, recoverability not yet proven", "warn", findings.filter((f) => f.resource.status === "untested"));
  appendCoverageGroup(list, "Protected", "ok", findings.filter((f) => f.resource.status === "protected"));
  return list;
}

// coverageRollup renders the headline counts (total / protected / unprotected / untested) as stat
// tiles, with honest tones: any unprotected reads danger, any untested reads warn, all-protected
// reads ok. Never a stale green.
function coverageRollup(rollup: CoverageReport["rollup"], generatedAt: string): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "coverage-rollup-h", style: "display:grid;gap:var(--space-4)" });
  const header = h("div", { class: "card__header" });
  header.appendChild(h("h3", { class: "card__title", id: "coverage-rollup-h" }, "Coverage rollup"));
  card.appendChild(header);

  card.appendChild(
    statGrid(
      statTile({
        label: "Inventoried",
        value: String(rollup.total),
        status: { tone: "neutral", label: "resources" },
        secondary: "Resources recorded in your reference inventory.",
      }),
      statTile({
        label: "Not backed up",
        value: String(rollup.unprotected),
        status: rollup.unprotected > 0 ? { tone: "danger", label: rollup.unprotected === 1 ? "gap" : "gaps" } : { tone: "ok", label: "none" },
        secondary: rollup.unprotected > 0 ? "Resources that exist with no downpipe covering them." : "Every inventoried resource has a downpipe.",
      }),
      statTile({
        label: "Not yet proven",
        value: String(rollup.untested),
        status: rollup.untested > 0 ? { tone: "warn", label: "unproven" } : { tone: "ok", label: "none" },
        secondary: rollup.untested > 0 ? "Backed up, but recoverability is not yet proven." : "No unproven backups.",
      }),
      statTile({
        label: "Protected",
        value: String(rollup.protected),
        status: { tone: rollup.protected === rollup.total && rollup.total > 0 ? "ok" : "neutral", label: "proven" },
        secondary: "Backed up, runs succeed and a restore has been proven.",
      }),
    ),
  );

  card.appendChild(
    noteLine(ICON_INFO, `Coverage is computed over the resources in your reference inventory. A resource the inventory does not list is not counted here. Generated ${relativeTime(generatedAt)}.`),
  );
  return card;
}

// coverageCard renders one finding: the resource, its status badge, the plain-English statement, and
// (for an unprotected resource) the "Back this up" action linking to the downpipe-create flow; a
// covered resource instead links to its covering downpipe. Every string is a text node.
function coverageCard(finding: CoverageFinding): HTMLElement {
  const { resource } = finding;
  const card = h("section", {
    class: resource.status === "unprotected" ? "card card--warn" : "card",
    "aria-label": `${coverageTypeLabel(resource.type)} ${resource.name} (${finding.statusLabel})`,
    style: "display:grid;gap:var(--space-3)",
  });

  const header = h("div", { style: "display:flex;justify-content:space-between;gap:var(--space-3);align-items:flex-start;flex-wrap:wrap" });
  const titleWrap = h("div", { style: "display:flex;gap:var(--space-2);align-items:flex-start" });
  titleWrap.appendChild(h("span", { class: `dot dot--${finding.tone}`, "aria-hidden": "true", style: "margin-top:6px;flex:none" }));
  const titleText = h("div", { style: "display:grid;gap:var(--space-1)" });
  titleText.appendChild(h("h4", { style: "font-size:var(--text-md)" }, resource.name));
  titleText.appendChild(
    h(
      "span",
      { class: "field__hint", style: "display:inline-flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" },
      h("span", { style: "color:var(--text-muted)" }, "Resource:"),
      h("span", { class: "mono" }, coverageTypeLabel(resource.type)),
      h("span", { class: "mono" }, resource.id),
    ),
  );
  titleWrap.appendChild(titleText);
  header.appendChild(titleWrap);
  header.appendChild(badge(finding.tone, finding.statusLabel));
  card.appendChild(header);

  card.appendChild(h("p", { style: "color:var(--text)" }, finding.statement));
  card.appendChild(coverageCardActions(finding));

  return card;
}

// coverageCardActions builds the action row for one finding: an unprotected resource gets the "Back
// this up" call to action (routes to the downpipe-create flow); a covered resource links to its
// covering downpipe instead.
function coverageCardActions(finding: CoverageFinding): HTMLElement {
  const { resource } = finding;
  const actions = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  if (finding.action === "back-up") {
    const backUpBtn = h(
      "button",
      { "data-dp": "security-centre.button.back-up", class: "btn btn--primary btn--sm", type: "button", "aria-label": `Back up ${resource.name}` },
      svgIcon(ICON_PLUS, { size: 14 }),
      "Back this up",
    ) as HTMLButtonElement;
    // Carry the clicked resource into the create wizard via the same query bridge
    // add-source uses (?type= is the mappable prefill; the native id is not an engine
    // binding name, so it cannot seed ?binding=), so the wizard lands preselected on
    // the resource type instead of discarding the context the operator just chose.
    backUpBtn.addEventListener("click", () => {
      const params = new URLSearchParams({ type: resource.type });
      navigate(`/downpipes/new?${params.toString()}`);
    });
    actions.appendChild(backUpBtn);
  } else if (resource.downpipeId !== undefined) {
    const dpId = resource.downpipeId;
    // An UNTESTED resource (backed up, recoverability not yet proven) gets a direct route to prove it: the
    // attended-verification runner, which proves every in-scope run at once. It works in any key posture (it
    // recovers keys in the browser), and it is the ONLY in-platform proof path in the offline-key-only
    // posture, so it replaces the old "run a restore test" hint that had no route to act on for that posture.
    if (resource.status === "untested") {
      const proveBtn = h(
        "button",
        { "data-dp": "security-centre.button.prove", class: "btn btn--secondary btn--sm", type: "button", "aria-label": `Prove recoverability of ${resource.name}` },
        svgIcon(ICON_SHIELD_CHECK, { size: 14 }),
        "Prove recoverability",
      ) as HTMLButtonElement;
      proveBtn.addEventListener("click", () => navigate("/restore/attend"));
      actions.appendChild(proveBtn);
    }
    const viewBtn = h(
      "button",
      { "data-dp": "security-centre.button.view", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `View the downpipe covering ${resource.name}` },
      "View downpipe",
      svgIcon(ICON_EXTERNAL, { size: 12 }),
    ) as HTMLButtonElement;
    viewBtn.addEventListener("click", () => navigate(`/downpipes/${encodeURIComponent(dpId)}`));
    actions.appendChild(viewBtn);
  }
  return actions;
}

// coverageUnknownState is the HONEST-UNKNOWN render: with no inventory stored the engine makes no
// coverage claim, so this section does not either. It is the day-one state, so it leads with the
// action that ends it, never a wall of guidance with no route to act on it. For an access.policy caller
// (populate present) that action is "Populate inventory" (record the reference inventory in-console, no
// curl needed); otherwise it points at setting up read-only discovery, which lives on Sources.
function coverageUnknownState(populate?: PopulateInventory): HTMLElement {
  return emptyState({
    title: "Coverage is unknown",
    body: "No resource inventory is recorded, so the engine cannot tell which resources exist or detect gaps; coverage is unknown, not that everything is covered. Read-only discovery records a resource id and a label only, never a credential or a value.",
    action: populate
      ? { label: "Populate inventory", onClick: populate.onClick }
      : { label: "Set up discovery", onClick: () => navigate("/sources") },
  });
}
