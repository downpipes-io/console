// Config version history: a READ-ONLY, git-style timeline of the account's governance configuration. The
// engine versions its OWN config (every config mutation captures a hash-chained, signed snapshot of the
// versionable posture: downpipes, role grants, group mappings, custom roles, notify channels/rules, the
// SRE-alert webhook destination, posture risk-accepts, tracked expiries and the coverage inventory). This
// screen renders that history newest-first; each row expands to the version snapshot's family counts and a
// plain-English (Australian) diff against its parent; the chain verify verdict is shown as an honest
// badge; and a "Take a snapshot now" button captures the current posture, gated on access.policy.
//
// READ-ONLY by design. There is NO config rollback endpoint on the engine, so this screen delivers history
// + verify + manual snapshot only. It never restores or re-applies a past version (rollback is not
// delivered). It is the config-history analogue of the runs/audit read surfaces, not a write surface.
//
// House rules: reading the history/version/diff is gated on downpipe.read (the read floor; any
// authenticated role may view the config). The manual snapshot is a config-policy act gated on
// access.policy (Owner / access-admin), shown disabled-with-reason for a caller who lacks it (the engine
// re-checks, defence in depth). Every server-supplied string (a summary, a diff line, an author email, a
// hash label) enters the DOM as a TEXT NODE via the dom.ts h() builder; no innerHTML, no inline handlers,
// strict-CSP safe. No-custody: a version carries an id, a timestamp, an author email, redaction-safe
// summary/diff lines and hash labels only; never a value or a key.
//
// This module is SELF-OWNED: it exports one screen descriptor; app.ts wires it into SCREENS.

import { recordContractSkew } from "../lib/client-diag/ring.ts";
import type { ClientDiagFieldFamily } from "../lib/client-diag/vocab.ts";
import { h, svgIcon } from "../lib/dom.ts";
import {
  pageHeader, requireEngine, canCap, capGateReason, refuseWithReason, defineScreen, type Screen, type ScreenContext,
} from "./common.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised, classifyError, errText } from "../lib/errors.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonRows, emptyState } from "../components/feedback.ts";
import { toast } from "../components/toast.ts";
import { badge } from "../components/status.ts";
import { relativeTime, absoluteTime } from "../lib/format.ts";
import { ICON_SHIELD_CHECK, ICON_ALERT, ICON_PLUS, ICON_CHEVRON_DOWN } from "../lib/icons.ts";
import type {
  EngineClient,
  ConfigHistory,
  ConfigVersionHeader,
  ConfigChainVerdict,
  ConfigVersion,
  ConfigDiffLine,
} from "../api.ts";

// The route the config version-history timeline owns.
export const ROUTE_CONFIG_HISTORY = "/config/history";

export const configHistoryScreen: Screen = defineScreen({
  route: ROUTE_CONFIG_HISTORY,
  title: "Config history",
  measure: "wide",
  // The screen-owned palette command: navigate to the config version-history timeline. Surfaced to any
  // authenticated caller (the read floor is downpipe.read; everyone who can see the config can read its
  // history), so the gate here only requires a known caller.
  actions: [
    {
      id: "config-history.open",
      title: "View config version history",
      group: "Navigation",
      kind: "navigate",
      keywords: ["config", "history", "version", "timeline", "diff", "snapshot", "chain", "audit", "governance"],
      target: ROUTE_CONFIG_HISTORY,
      when: ({ caller: c }) => c !== null,
    },
  ],
  render(_ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;
    return renderConfigHistory(engine);
  },
});

function renderConfigHistory(engine: EngineClient): HTMLElement {
  const root = h("div");

  // The manual-snapshot action is a config-policy act (access.policy). Shown disabled-with-reason for a
  // caller who lacks it, not hidden, so the gate reads as governed (the engine re-checks regardless).
  // pageHeader wraps the actions slot, so the button is passed directly.
  root.appendChild(
    pageHeader(
      "Config history",
      "A read-only, tamper-evident timeline of changes to this account's governance configuration: downpipes, roles, notification routing, posture risk-accepts and tracked expiries. Each version is a hash-chained, signed snapshot. Expand a version to read what changed and the posture it captured. This view does not roll back a past version.",
      snapshotButton(engine, () => load()),
    ),
  );

  const region = h("div", { class: "async-region" });
  root.appendChild(region);

  const load = (): void => loadHistory(engine, region, load);

  load();
  return root;
}

// loadHistory fetches the config history and renders it into region, classifying a not-yet-wired
// engine (404/501) as an honest empty state and any other transport fault as a retryable block error.
// reload re-runs the same load (passed in so the Retry button and the snapshot button share one path).
function loadHistory(engine: EngineClient, region: HTMLElement, reload: () => void): void {
  region.replaceChildren(skeletonRows(4));
  void engine
    .getConfigHistory()
    .then((history) => {
      // Paint UNCONDITIONALLY (no root.isConnected guard). setMain attaches screens through the
      // View Transitions API, so this root reaches the DOM a frame AFTER render() returns; the
      // faked tour engine resolves in a microtask BEFORE that, and a connectivity guard here
      // discarded the only load this screen ever makes (a permanent skeleton on the public tour).
      // Painting into a detached-but-about-to-attach region is what every other screen does; a
      // region that was truly navigated away from is unreferenced and collected either way.
      region.replaceChildren(renderHistory(engine, history));
    })
    .catch((err) => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the history list is a skeleton until this replaces it.
        region.replaceChildren(sessionEnded(() => reload()));
        return goSignedOut();
      }
      // Distinguish a not-yet-wired engine (404/501: the config-history routes are absent on this build)
      // from a genuine transport fault (5xx / network) where a Retry is appropriate.
      const kind = classifyError(err, { origin: location.origin });
      if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
        region.replaceChildren(
          emptyState({
            title: "Config history is not available on this engine",
            body: "This engine build does not version its configuration yet. When it does, every config change appears here as a signed, verifiable snapshot.",
          }),
        );
      } else {
        region.replaceChildren(blockError(err, () => reload(), { origin: location.origin }));
      }
    });
}

function renderHistory(engine: EngineClient, history: ConfigHistory): HTMLElement {
  const wrap = h("div");

  // The chain verify verdict leads the list: the on-screen proof that the history is tamper-evident, or an
  // honest break at the first failing version.
  wrap.appendChild(renderVerifyBanner(history.verify));

  if (history.versions.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "No config history yet",
        body: "The first version is captured when the configuration is first stored, or when you take a snapshot now. Until then there is nothing to compare.",
      }),
    );
    return wrap;
  }

  const list = h("div", { class: "card-list" });
  // Newest-first (the engine already reverses); each row leads with its id and a head marker. A row knows
  // its parent's id (the version below it in the list) so the expanded diff can compare against the parent.
  for (let i = 0; i < history.versions.length; i++) {
    const v = history.versions[i]!;
    // The parent is the NEXT entry in the newest-first list (the chronologically prior version), if any.
    const parent = i + 1 < history.versions.length ? history.versions[i + 1]! : null;
    list.appendChild(renderVersionRow(engine, v, parent, history.headId));
  }
  wrap.appendChild(list);
  return wrap;
}

// renderVerifyBanner shows the chain verdict as an honest badge plus a one-line explanation. Intact reads
// as a trust badge over the checked range; a break names the first failing version id without overclaiming.
function renderVerifyBanner(verify: ConfigChainVerdict): HTMLElement {
  const card = h("div", { class: "card card--inset", style: "display:flex;align-items:center;gap:var(--space-3)" });
  // The DELETED TAIL first: the recompute only checks the versions still held, so removing the newest ones
  // leaves the rest linking cleanly and `intact` reads true. The engine's head anchor, committed with each
  // version and never lowered by a rollover, is what catches it.
  if (verify.headTruncated === true) {
    card.appendChild(svgIcon(ICON_ALERT, { size: 18 }));
    card.appendChild(badge("danger", "Versions deleted"));
    const where =
      verify.headTruncatedAt !== undefined
        ? `The history ends below version ${verify.headTruncatedAt}, which this engine recorded as its head: the newest versions have been removed or rewritten. The versions that remain still link to one another, which is why the recompute alone reads clean.`
        : "The history ends below the head this engine recorded: the newest versions have been removed or rewritten.";
    card.appendChild(h("span", { class: "field__hint" }, where));
    return card;
  }
  if (verify.intact) {
    card.appendChild(svgIcon(ICON_SHIELD_CHECK, { size: 18 }));
    card.appendChild(badge("ok", "Chain verified"));
    const range =
      verify.earliestId < 0
        ? "There are no versions to verify yet."
        : verify.earliestId === verify.checkedThrough
          ? `Version ${verify.checkedThrough} recomputes to its stored hash and signature.`
          : `Versions ${verify.earliestId} to ${verify.checkedThrough} recompute to their stored hashes and signatures, and each links to the one before it.`;
    card.appendChild(h("span", { class: "field__hint" }, range));
  } else {
    card.appendChild(svgIcon(ICON_ALERT, { size: 18 }));
    card.appendChild(badge("danger", "Chain broken"));
    const where =
      verify.brokenAt !== undefined
        ? `Version ${verify.brokenAt} does not recompute to its stored hash, signature or chain link. The history may have been altered.`
        : "The chain did not verify. The history may have been altered.";
    card.appendChild(h("span", { class: "field__hint" }, where));
  }
  return card;
}

// renderVersionRow renders one version as a collapsed card that expands to the snapshot summary + a diff
// against its parent (loaded lazily on first expand). The header row is text-only (no secrets).
function renderVersionRow(
  engine: EngineClient,
  v: ConfigVersionHeader,
  parent: ConfigVersionHeader | null,
  headId: ConfigVersionHeader["id"],
): HTMLElement {
  const isHead = v.id === headId;
  const details = h("details", { class: "card disclosure" });

  const summaryEl = h("summary", { class: "disclosure__summary", style: "display:flex;align-items:center;gap:var(--space-3);cursor:pointer;list-style:none" });
  summaryEl.appendChild(svgIcon(ICON_CHEVRON_DOWN, { size: 14 }));
  const head = h("div", { style: "display:flex;flex-direction:column;gap:2px;flex:1;min-width:0" });
  const titleRow = h("div", { style: "display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap" });
  titleRow.appendChild(h("strong", { class: "mono" }, `v${v.id}`));
  if (isHead) titleRow.appendChild(badge("info", "Current"));
  titleRow.appendChild(h("span", { style: "color:var(--text)" }, v.summary));
  head.appendChild(titleRow);
  const meta = h("div", { class: "field__hint", style: "display:flex;gap:var(--space-3);flex-wrap:wrap" });
  meta.appendChild(h("span", { title: absoluteTime(v.at) }, relativeTime(v.at)));
  meta.appendChild(h("span", v.author ? `by ${v.author}` : "by a shared token (break-glass), no attributable email"));
  head.appendChild(meta);
  summaryEl.appendChild(head);
  details.appendChild(summaryEl);

  const body = h("div", { class: "disclosure__body", style: "padding-top:var(--space-3);display:grid;gap:var(--space-3)" });
  body.appendChild(h("p", { class: "field__hint" }, "Loading details…"));
  details.appendChild(body);

  // Lazy-load the full version snapshot + the diff against the parent on first expand only.
  let loaded = false;
  details.addEventListener("toggle", () => {
    if (!details.open || loaded) return;
    loaded = true;
    void loadVersionDetail(engine, v, parent, body);
  });

  return details;
}

async function loadVersionDetail(engine: EngineClient, v: ConfigVersionHeader, parent: ConfigVersionHeader | null, body: HTMLElement): Promise<void> {
  try {
    // Fetch the full version (for the posture summary) and, when there is a parent, the diff against it.
    const versionResult = await engine.getConfigVersion(v.id);
    const diffResult = parent !== null ? await engine.getConfigDiff(parent.id, v.id) : null;

    // An unloadable diff used to read "one of the versions is no longer retained", which names neither
    // and sends the operator (and support) looking in both. The version HEADERS are listed, so both
    // versions exist; a missing BODY is a retention fault in the engine's own config store, and saying
    // WHICH body is gone is the whole diagnostic value. We already know whether this version's body is
    // retained, so on the failure path only (never on the happy path) ask the same question of the
    // parent. A failed probe leaves it unknown, and the copy says unknown rather than guessing.
    let parentRetained: boolean | null = null;
    if (parent !== null && diffResult !== null && !diffResult.found) {
      parentRetained = await engine
        .getConfigVersion(parent.id)
        .then((r) => r.found)
        .catch(() => null);
    }

    const out = h("div", { style: "display:grid;gap:var(--space-3)" });

    // The plain-English diff against the parent (the operator-facing payoff). The first version has no
    // parent, so it shows the genesis note instead.
    out.appendChild(renderDiffBlock(parent, diffResult, v.id, { thisRetained: versionResult.found, parentRetained }));

    // The posture snapshot this version captured, as redaction-safe family COUNTS (the diff is the
    // readable change; the snapshot view confirms the shape of the posture at this point in time).
    if (versionResult.found) {
      out.appendChild(renderSnapshotSummary(versionResult.version));
    } else {
      out.appendChild(h("p", { class: "field__hint" }, "The full snapshot for this version is no longer retained."));
    }

    body.replaceChildren(out);
  } catch (err) {
    if (isUnauthorised(err)) { goSignedOut(); return; }
    body.replaceChildren(blockError(err, () => { void loadVersionDetail(engine, v, parent, body); }, { origin: location.origin }));
  }
}

// DiffRetention is what the caller learned about the two SNAPSHOT BODIES behind the two listed version
// headers: whether this version's body is retained, and (probed only when the diff could not be built)
// whether the parent's is. parentRetained stays null when it was not probed or the probe failed, and the
// copy then says unknown rather than guessing.
export interface DiffRetention {
  thisRetained: boolean;
  parentRetained: boolean | null;
}

// unloadableDiffReason is the PURE sentence for a diff that could not be built. The old copy ("one of the
// versions is no longer retained") named neither version, so an operator asking "what changed in version
// 30?" could not tell support which snapshot body the engine had lost, and a diff that failed for some
// OTHER reason was reported as a retention gap that may not exist. Each branch is a precise, honest claim.
export function unloadableDiffReason(thisId: number, parentId: number, retention: DiffRetention): string {
  const { thisRetained, parentRetained } = retention;
  if (!thisRetained && parentRetained === false) {
    return `The diff cannot be built: the full snapshots for v${parentId} and v${thisId} are both no longer retained. Only their headers remain.`;
  }
  if (!thisRetained) {
    return `The diff cannot be built: the full snapshot for v${thisId} is no longer retained (only its header remains). Quote v${thisId} to support: a listed version whose snapshot body is gone is a retention fault in the engine's config store.`;
  }
  if (parentRetained === false) {
    return `The diff cannot be built: the full snapshot for v${parentId} is no longer retained (only its header remains), so there is nothing to compare v${thisId} against. Quote v${parentId} to support.`;
  }
  if (parentRetained === true) {
    return `The diff for v${thisId} could not be built even though both snapshots (v${parentId} and v${thisId}) are still retained. That is a fault in the engine's config store, not a retention gap.`;
  }
  return `The diff for v${thisId} could not be built. Whether the v${parentId} snapshot is still retained could not be read, so which of the two is missing is unknown.`;
}

// renderDiffBlock renders the plain-English diff against the parent, line by line as TEXT NODES (never
// markup), each tagged with an added/removed/changed cue. The genesis version (no parent) shows a note.
function renderDiffBlock(
  parent: ConfigVersionHeader | null,
  diffResult: { found: false } | { found: true; from: number; to: number; changes: ConfigDiffLine[] } | null,
  thisId: number,
  retention: DiffRetention,
): HTMLElement {
  const wrap = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-1)" });
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-bottom:var(--space-1)" }, parent !== null ? `Changes since v${parent.id}` : "Change"));

  if (parent === null) {
    wrap.appendChild(h("p", { style: "color:var(--text)" }, "Initial configuration snapshot. There is no earlier version to compare against."));
    return wrap;
  }
  if (diffResult === null || diffResult.found === false) {
    wrap.appendChild(h("p", { class: "field__hint" }, unloadableDiffReason(thisId, parent.id, retention)));
    return wrap;
  }
  if (diffResult.changes.length === 0) {
    wrap.appendChild(h("p", { style: "color:var(--text)" }, "No detectable configuration change against the previous version."));
    return wrap;
  }
  for (const line of diffResult.changes) {
    const row = h("p", { class: "mono", style: "color:var(--text);white-space:pre-wrap;margin:0;display:flex;gap:var(--space-2);align-items:baseline" });
    row.appendChild(h("span", { class: "field__hint", style: "min-width:4.5em" }, diffKindLabel(line.kind)));
    row.appendChild(h("span", line.text));
    wrap.appendChild(row);
  }
  return wrap;
}

// diffKindLabel maps an add/remove/change kind to a short text cue (no colour reliance for the meaning).
function diffKindLabel(kind: ConfigDiffLine["kind"]): string {
  switch (kind) {
    case "added": return "added";
    case "removed": return "removed";
    case "changed": return "changed";
    default: return "change";
  }
}

// renderSnapshotSummary shows the captured posture as redaction-safe family COUNTS. It reads the snapshot
// only to count list lengths and the webhook flag; it never renders a raw value (a downpipe name, an email,
// a host) here, because the diff already carries the readable change and the snapshot carries no secret.
function renderSnapshotSummary(version: ConfigVersion): HTMLElement {
  const s = version.snapshot;
  const wrap = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-2)" });
  wrap.appendChild(h("p", { class: "field__hint" }, "Posture captured"));

  const counts: Array<{ label: string; n: number }> = [
    { label: "downpipes", n: countOf(s.downpipes, "snapshot-counts") },
    // role grants get their OWN field family, because they are the one the ticket names: "the v9 snapshot says
    // 0 role grants but we had 12". A snapshot that reports zero grants is a snapshot an auditor will read as
    // evidence that nobody held a role, and it is the count that most needs to be right.
    { label: "role grants", n: countOf(s.roles, "role-grants") },
    { label: "group mappings", n: countOf(s.groupRoles, "snapshot-counts") },
    { label: "custom roles", n: countOf(s.customRoles, "snapshot-counts") },
    { label: "notify channels", n: countOf(s.notifyChannels, "snapshot-counts") },
    { label: "notify rules", n: countOf(s.notifyRules, "snapshot-counts") },
    { label: "risk accepts", n: countOf(s.riskAccepts, "snapshot-counts") },
    { label: "tracked expiries", n: countOf(s.expiryItems, "snapshot-counts") },
  ];
  const grid = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" });
  for (const c of counts) {
    grid.appendChild(h("span", { class: "tag" }, `${c.n} ${c.label}`));
  }
  // The SRE-alert webhook is a stable scalar (presence + redacted host); show its presence as a chip.
  if (s.webhook?.configured) {
    grid.appendChild(h("span", { class: "tag" }, s.webhook.host ? `SRE-alert webhook -> ${s.webhook.host}` : "SRE-alert webhook set"));
  }
  if (s.coverage !== undefined) grid.appendChild(h("span", { class: "tag" }, "coverage inventory recorded"));
  wrap.appendChild(grid);

  // The content hash, as an opaque label, for the operator who wants the exact fingerprint of the posture.
  wrap.appendChild(h("p", { class: "mono field__hint", style: "word-break:break-all;margin:0" }, `content ${version.contentHash}`));
  return wrap;
}

// countOf returns a list length defensively (the snapshot families are typed loosely so a newer engine
// cannot break this older console; a non-array degrades to 0 rather than throwing).
//
// The degrade is right and its SILENCE is the bug. A field that arrived as something other than an array
// is counted as 0 and printed as a fact ("0 role grants"), so a signed, hash-chained snapshot presents a count
// that is not a measurement at all. ABSENT is not recorded (an older snapshot legitimately lacks a family, and
// a row there would fire on every historical version); PRESENT-AND-NOT-AN-ARRAY is engine drift and is recorded.
// EXPORTED for the validator: the test suite drives THIS function over the payload a skewed engine really
// sends, rather than hand-posting a contract-skew row into the recorder and asserting it comes back.
export function countOf(list: unknown, family: ClientDiagFieldFamily): number {
  if (Array.isArray(list)) return list.length;
  if (list !== undefined && list !== null) recordContractSkew("wrong-shape", family);
  return 0;
}

// snapshotButton builds the "Take a snapshot now" action: a config-policy act (access.policy). When the
// caller lacks the capability it renders disabled-with-reason (not hidden), so the gate reads as governed;
// the engine re-checks regardless. On success it toasts the outcome (a new version, or "no change" when the
// engine de-duped against the head) and reloads the timeline.
// Exported for test/validate-gate-refusal-reachable.ts, which drives the refused branch and asserts a
// click reaches nothing. The screen's own render is behind requireEngine() and a live timeline fetch,
// so reaching this control through it would test the fetch rather than the gate.
export function snapshotButton(engine: EngineClient, reload: () => void): HTMLElement {
  const allowed = canCap("access.policy");
  const btn = h("button", { "data-dp": "config-history.button.snapshot-button", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), "Take a snapshot now") as HTMLButtonElement;
  if (!allowed) {
    // Refused, not removed from the tab order (refuseWithReason): the early return is what
    // proves no click handler is ever attached on this branch.
    refuseWithReason(btn, capGateReason("access.policy"));
    return btn;
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const result = await engine.snapshotConfig();
      if (result.created) {
        toast({ message: `Snapshot captured as v${result.id}` });
        reload();
      } else {
        toast({ message: "No change since the last version, so nothing was captured." });
      }
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not take a snapshot (${errText(err)}).`, tone: "warn" });
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
