// The chain-verdict surface, the audit event table (with "Load older events" pagination and
// the page-only facets/sort), and the per-event detail modal for the audit log sub-view.
// Every server-supplied string reaches the DOM as a text node, and the target union is the
// closed, redaction-safe shape, so only safe fields can render. Split out of audit.ts to keep
// that file under the structural cap.

import { h, svgIcon } from "../../lib/dom.ts";
import { collapsedSection } from "../common.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { codeBlock } from "../../components/code-block.ts";
import { dataTable } from "../../components/data-table.ts";
import { badge } from "../../components/status.ts";
import { openModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { emptyState } from "../../components/feedback.ts";
import { relativeTime, absoluteTime } from "../../lib/format.ts";
import { ICON_INFO, ICON_CHEVRON_DOWN } from "../../lib/icons.ts";
import type {
  EngineClient,
  AuditEvent,
  AuditPage,
  ChainVerdict,
  AuditFilters,
} from "../../api.ts";
import { noteLine, errText, auditSourceIpDisplay, AUDIT_PAGE_LIMIT } from "./shared.ts";
import {
  kvLine,
  describeTarget,
  outcomeStatus,
  actorMethodLabel,
  actorIdentifier,
  actionLabel,
} from "./audit-display.ts";
import { hasActiveAuditFilter, clearAuditFilters, reflectAuditFiltersInUrl } from "./audit-filters.ts";

export function renderChainVerdict(verdict: ChainVerdict): HTMLElement {
  // A break is a RESULT, not an error: render it calmly as the detection the
  // tamper-evident design exists to provide. Precise claim: tamper-evident, not
  // tamper-proof.
  // A DELETED TAIL IS A BREAK THE RECOMPUTE CANNOT SEE, so it is checked FIRST (G313). verify walks the entries
  // the engine still holds and checks each links to the one before it, so removing the NEWEST entries leaves the
  // survivors linking perfectly and `intact` comes back TRUE. The engine's head anchor is written on every append
  // and a retention rollover never lowers it, so a retained head below that anchor is a removed or rewritten tail
  // and nothing else. Rendering "Chain intact" over it would be the calmest possible way to hide the one event
  // this screen exists to show.
  if (verdict.headTruncated === true) {
    return verdictSurface({
      tone: "danger",
      title: `Entries after ${verdict.headTruncatedAt ?? verdict.checkedThrough} are missing`,
      body: "The retained log ends below the chain head this engine recorded, so the newest entries have been removed or rewritten. The entries that remain still link to one another, which is why the recompute alone reads clean: a deletion at the end of a chain leaves no gap behind it. Export what remains and investigate the store.",
      assertive: true,
    });
  }
  if (verdict.intact) {
    const through = verdict.checkedThrough < 0 ? "no events yet" : `entry ${verdict.checkedThrough}`;
    // A ROLLED-OVER CHAIN IS INTACT AND IS ALSO MISSING ITS BEGINNING, and until only the first
    // half was said. "The chain recomputes cleanly from the earliest retained entry" was true and was also
    // the whole problem: it named the earliest retained entry without naming WHICH entry that is, so the
    // reading was identical on a log that begins at entry 1 and on one whose first two thousand entries
    // have been destroyed. The engine sends the rolled-over count and the earliest retained seq on this
    // very response. This is not a break and is not toned as one: retention is working as designed, and
    // what the operator needs is the number, because an export can only ever carry what is still held.
    // THE FLAG IS THE FACT; THE COUNT IS ONLY HOW MUCH. `rolledOver === true && (count ?? 0) > 0` made the
    // COUNT the trigger, so a rollover the engine reports WITHOUT a usable count fell through to the plain
    // intact surface below and the operator read the very sentence this branch was written to stop them
    // reading. That state is reachable and was driven through the real Durable Object: a rollover record
    // whose count has been lost is reported as rolledOver:true with rolledOverCount:0, and the engine books
    // `rollover-record-lost` for it, so the product knows the record can go while the destroyed entries
    // stay destroyed. A count is worth having and its absence is not a reason to say nothing: earliestSeq
    // rides the same response and names WHERE the retained chain begins, which is the half that tells the
    // operator an export cannot carry the beginning.
    const n = verdict.rolledOverCount;
    const counted = typeof n === "number" && Number.isFinite(n) && n > 0;
    if (verdict.rolledOver === true) {
      const begins = verdict.earliestSeq !== undefined && verdict.earliestSeq > 0 ? `The retained chain begins at entry ${verdict.earliestSeq}. ` : "";
      const many = !counted || n !== 1;
      const howMany = counted ? `${n} earlier ${many ? "entries have" : "entry has"} rolled over` : "earlier entries have rolled over";
      const those = counted ? `Those ${many ? "entries are" : "entry is"}` : "They are";
      return verdictSurface({
        tone: "warn",
        title: `Chain intact through ${through}, and ${howMany}`,
        body: `${begins}${those} past the engine's retention cap and are no longer held, so an export from here carries the retained chain and not the full history. The retained chain recomputes cleanly from its earliest entry and the export carries the chain head hash, so an external verifier can still confirm nothing was truncated inside it.`,
      });
    }
    // The RESULT only; the mechanism explanation lives in "What this log proves" above.
    return verdictSurface({
      tone: "ok",
      title: verdict.checkedThrough < 0 ? "Chain intact (no events yet)" : `Chain intact through ${through}`,
      body: "The chain recomputes cleanly from the earliest retained entry; the export carries the chain head hash so an external verifier can confirm nothing was truncated.",
    });
  }
  return verdictSurface({
    tone: "danger",
    title: `Break detected at entry ${verdict.brokenAt ?? verdict.checkedThrough}`,
    body: "The chain does not recompute from this entry. This is a result, not an error: it is exactly the detection the tamper-evident design exists to provide. Investigate the store and export what remains for an external check.",
    assertive: true,
  });
}

export function renderAuditEvents(engine: EngineClient, page: AuditPage, filters: AuditFilters, reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });

  // The chain head line: one eager line; the full 103-char head hash collapses (a verification
  // artefact most visits never use, but copyable in full via codeBlock for the auditor, C5-4).
  {
    const headLabel = h("p", { class: "field__hint", style: "margin-bottom:var(--space-1)" }, `Chain head: ${page.headSeq < 0 ? "no events yet" : `entry ${page.headSeq}`}`);
    wrap.appendChild(headLabel);
    wrap.appendChild(collapsedSection("Chain head hash", codeBlock(page.headHash, { copyLabel: "Copy chain head hash" })));
  }

  if (page.events.length === 0) {
    // Distinguish true-empty from filtered-empty (design-system 6.21). The filter is
    // server-side now, so a filtered-empty result means the engine returned no matching
    // events; clearing resets the filters, the URL and re-fetches the full trail.
    const filtered = hasActiveAuditFilter(filters);
    if (filtered) {
      wrap.appendChild(
        emptyState({
          title: "No events match this filter",
          body: "The engine returned no audit events for the current filter. Clear it to see the full trail.",
          action: {
            label: "Clear filters",
            variant: "secondary",
            onClick: () => {
              clearAuditFilters(filters);
              reflectAuditFiltersInUrl(filters);
              reload();
            },
          },
        }),
      );
    } else {
      wrap.appendChild(
        emptyState({
          title: "No privileged actions recorded yet",
          body: "Restores, downpipe changes, role changes and key-ceremony intents will appear here automatically.",
        }),
      );
    }
    return wrap;
  }

  // The dataTable here sorts and narrows the LOADED page only; the authoritative filter is
  // the server-side bar above (console-access-4), so this table carries no free-text filter
  // (a page-only text match would miss events beyond the fetched page and mislead). The
  // facets are a fast within-page narrow, labelled as such by the note below.
  // loadedEvents grows as "Load older events" appends pages (before = the oldest loaded seq).
  let loadedEvents: AuditEvent[] = page.events.slice();
  const handle = dataTable<AuditEvent>({
    label: "Audit events",
    rows: page.events,
    rowKey: (e) => String(e.seq),
    onRowActivate: (e) => openAuditDetail(e),
    facets: [
      // Action is one dimension (an event has exactly one action): selecting two actions shows either,
      // never AND to empty. Outcome (denied) is orthogonal, so it keeps narrowing (denied restores).
      { id: "restore-apply", group: "action", label: "restore apply", tone: "warn", predicate: (e) => e.action === "restore-apply" },
      { id: "role-change", group: "action", label: "role change", tone: "info", predicate: (e) => e.action === "role-change" },
      { id: "downpipe-delete", group: "action", label: "delete", tone: "danger", predicate: (e) => e.action === "downpipe-delete" },
      { id: "denied", label: "denied", tone: "danger", predicate: (e) => e.outcome === "denied" },
    ],
    initialSort: { key: "seq", dir: "desc" },
    columns: [
      { key: "outcome", header: "Outcome", sortable: true, sortValue: (e) => e.outcome, render: (e) => outcomeStatus(e.outcome) },
      {
        key: "actor",
        header: "Actor",
        sortable: true,
        sortValue: (e) => e.actorEmail ?? e.actorMethod,
        render: (e) => {
          const cell = h("span");
          cell.appendChild(h("span", { class: "mono" }, actorIdentifier(e)));
          cell.appendChild(h("br"));
          cell.appendChild(h("span", { class: "field__hint" }, actorMethodLabel(e.actorMethod)));
          return cell;
        },
      },
      { key: "action", header: "Action", sortable: true, sortValue: (e) => e.action, render: (e) => badge("default", actionLabel(e.action)) },
      { key: "target", header: "Target (redacted)", render: (e) => describeTarget(e.target) },
      { key: "ts", header: "When", sortable: true, sortValue: (e) => e.ts, render: (e) => h("span", { title: absoluteTime(e.ts) }, relativeTime(e.ts)) },
      {
        key: "ip",
        header: "Source IP",
        render: (e) => {
          const ip = auditSourceIpDisplay(e);
          // A real IP renders mono; a legitimately-blank engine event reads "system" (titled
          // "engine-initiated") so it is DISTINCT from a genuinely missing IP, which reads "not recorded".
          if (ip.kind === "ip") return h("span", { class: "mono field__hint" }, ip.text);
          if (ip.kind === "system") return h("span", { class: "field__hint", title: "Engine-initiated; no client request to record an IP from" }, ip.text);
          return h("span", { class: "field__hint" }, ip.text);
        },
      },
      {
        key: "expand",
        header: "Expand",
        srOnlyHeader: true,
        width: "1px",
        render: (e) => {
          const btn = h("button", { "data-dp": "access-security.button.open-audit-detail", class: "btn btn--ghost btn--icon btn--sm", type: "button", "aria-label": `Expand event ${e.seq}` }, svgIcon(ICON_CHEVRON_DOWN, { size: 16 })) as HTMLButtonElement;
          btn.addEventListener("click", () => openAuditDetail(e));
          return btn;
        },
      },
    ],
  });
  wrap.appendChild(handle.el);

  // "Load older events": re-query with before = the oldest loaded seq and APPEND, so the
  // trail is not pinned at the most recent page. Hidden when the loaded set already ends
  // at the earliest retained entry (seq 0, or a short page meaning no more older events).
  const pageLimit = filters.limit ?? AUDIT_PAGE_LIMIT;
  const olderBtn = h("button", { "data-dp": "access-security.button.older", class: "btn btn--secondary btn--sm", type: "button" }, "Load older events") as HTMLButtonElement;
  const olderHost = h("div", { style: "display:flex;justify-content:center" }, olderBtn);
  const oldestSeq = (): number | null =>
    loadedEvents.length ? loadedEvents.reduce((min, e) => Math.min(min, e.seq), Number.MAX_SAFE_INTEGER) : null;
  const updateOlderVisibility = (lastBatchCount: number): void => {
    const oldest = oldestSeq();
    olderHost.hidden = oldest === null || oldest <= 0 || lastBatchCount < pageLimit;
  };
  updateOlderVisibility(page.events.length);
  olderBtn.addEventListener("click", async () => {
    const oldest = oldestSeq();
    if (oldest === null) return;
    olderBtn.dataset.busy = "true";
    olderBtn.disabled = true;
    try {
      const olderPage = await engine.listAudit({ ...filters, before: oldest });
      const known = new Set(loadedEvents.map((e) => e.seq));
      loadedEvents = [...loadedEvents, ...olderPage.events.filter((e) => !known.has(e.seq))];
      handle.setRows(loadedEvents);
      updateOlderVisibility(olderPage.events.length);
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not load older events (${errText(err)}).`, tone: "warn" });
    } finally {
      olderBtn.dataset.busy = "false";
      olderBtn.disabled = false;
    }
  });
  wrap.appendChild(olderHost);

  // Make the two-tier filtering honest: the bar above filters the whole log on the engine;
  // the facets and column sort here narrow and order the loaded page only. A page-capped
  // hint when the page is full so an operator does not assume the page is the whole trail.
  const pageHint = page.events.length >= (filters.limit ?? AUDIT_PAGE_LIMIT)
    ? `Showing the most recent ${page.events.length} events; Load older events extends the table further back. Use the filters above to search the whole log on the engine; the facets and column sort here narrow and order the loaded set only.`
    : "The facets and column sort here narrow and order the loaded set; the filter bar above searches the whole log on the engine.";
  wrap.appendChild(noteLine(ICON_INFO, pageHint));
  return wrap;
}

// openAuditDetail shows the full redacted event, including the change-control fields for
// a restore (plan hash, requester, approver, reason). Every field is the closed,
// redaction-safe union; the modal can only render safe fields.
function openAuditDetail(e: AuditEvent): void {
  const body = h("div", { style: "display:grid;gap:var(--space-3)" });

  body.appendChild(kvLine("Sequence", h("span", { class: "mono" }, `#${e.seq}`)));
  body.appendChild(kvLine("Outcome", outcomeStatus(e.outcome)));
  body.appendChild(kvLine("Action", badge("default", actionLabel(e.action))));
  body.appendChild(kvLine("Actor", h("span", { class: "mono" }, actorIdentifier(e))));
  body.appendChild(kvLine("Method", actorMethodLabel(e.actorMethod)));
  body.appendChild(kvLine("When", h("span", { title: absoluteTime(e.ts) }, absoluteTime(e.ts))));
  // Always show the Source IP line, distinguishing a real IP from a legitimately-blank engine event
  // ("system / engine-initiated") and from a genuinely missing IP ("not recorded"), so the "from where"
  // promise stays honest rather than silently omitting the field for both blank cases.
  {
    const ip = auditSourceIpDisplay(e);
    if (ip.kind === "ip") body.appendChild(kvLine("Source IP", h("span", { class: "mono" }, ip.text)));
    else if (ip.kind === "system") body.appendChild(kvLine("Source IP", h("span", { class: "field__hint" }, "system (engine-initiated)")));
    else body.appendChild(kvLine("Source IP", h("span", { class: "field__hint" }, "not recorded")));
  }
  body.appendChild(kvLine("Target", describeTarget(e.target)));

  // Change-control detail for a restore (the question Marcus always asks).
  if (e.target.kind === "restore") {
    const t = e.target;
    body.appendChild(h("hr", { style: "border:none;border-top:1px solid var(--border-subtle);margin:var(--space-1) 0" }));
    body.appendChild(kvLine("Run", h("span", { class: "mono" }, t.runId)));
    body.appendChild(kvLine("Plan hash", h("span", { class: "mono", style: "word-break:break-all" }, t.planHash)));
    if (t.approverEmail) body.appendChild(kvLine("Approver", h("span", { class: "mono" }, t.approverEmail)));
    if (t.redirectBinding) body.appendChild(kvLine("Redirect target", h("span", { class: "mono" }, t.redirectBinding)));
    body.appendChild(kvLine("Latest run", t.isLatest ? "yes" : "no (non-latest)"));
    if (t.reason) body.appendChild(kvLine("Reason", t.reason));
  }

  // The chain linkage (the proof surface).
  body.appendChild(h("hr", { style: "border:none;border-top:1px solid var(--border-subtle);margin:var(--space-1) 0" }));
  body.appendChild(kvLine("Previous hash", h("span", { class: "mono field__hint", style: "word-break:break-all" }, e.prevHash)));
  body.appendChild(kvLine("This hash", h("span", { class: "mono field__hint", style: "word-break:break-all" }, e.hash)));

  openModal({
    title: `Audit event #${e.seq}`,
    body,
    actions: [{ label: "Close", variant: "secondary", onClick: () => {} }],
  });
}
