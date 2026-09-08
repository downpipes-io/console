// Audit log sub-view of the Access and security area: the tamper-evident, hash-chained
// record (D4) with the verify-chain action, JSON and CSV export, server-side filters seeded
// from and reflected to the URL, expandable change-control detail, and the honest F6 boundary
// copy. Every server-supplied string reaches the DOM as a text node, and the target union is
// the closed, redaction-safe shape, so only safe fields can render. Shared leaves come from
// ./shared.ts; the display labels, the filter bar and the event table live in the sibling
// audit-display, audit-filters and audit-events modules.

import type { AuditFilters, ChainVerdict, EngineClient } from "../../api.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { banner, skeletonRows } from "../../components/feedback.ts";
import { toast } from "../../components/toast.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { featureOutcomeForError, recordFeatureProbe } from "../../lib/client-diag/ring.ts";
import type { ClientDiagFeatureClass } from "../../lib/client-diag/vocab.ts";
import { classifyError, isForbidden, isUnauthorised } from "../../lib/errors.ts";
import {
  ICON_ALERT,
  ICON_LICENCE,
  ICON_SHIELD_CHECK,
} from "../../lib/icons.ts";
import { h, refuseWithReason, svgIcon } from "../../lib/dom.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { lazyDisclosure, pendingEngineNote } from "../common.ts";
import { downloadText } from "./audit-display.ts";
import { renderAuditEvents, renderChainVerdict } from "./audit-events.ts";
import { auditFilterBar, auditFiltersFromQuery } from "./audit-filters.ts";
import { errText } from "./shared.ts";

// ---- the audit.read denial, said ONCE and applied to every surface it governs ------------------------
//
// WHY THIS IS ONE CONSTANT AND NOT THREE SENTENCES. The screen already had the denial copy in exactly one
// place, the banner in load()'s isForbidden branch, and that banner was correct. What it could not do was
// reach the toolbar, because the toolbar is built ABOVE the async region and lives OUTSIDE it, so
// replacing the region's children could never remove or refuse a control that is not one of them. The
// result was measured against a live estate as an Operator and again as a Viewer, rendered
// text identical: the banner said "you do not have permission to view the audit log" while "Verify chain
// integrity", "Export (JSON)" and "Export (CSV)" sat above it, enabled, in the tab order, carrying no
// aria-disabled, no title and no description. A screen that names a refusal and then offers the refused
// actions is not a legible refusal.
//
// THE REMEDY IS SHARED so the banner and the controls cannot drift into saying different things about the
// same denial. AUDIT_READ_REMEDY names WHO can help and is the sentence both surfaces end on.
const AUDIT_READ_REMEDY = "An Owner or Access admin can grant it.";

/** The banner shown where the audit table would be. Unchanged copy; now sourced from the same remedy. */
const AUDIT_READ_DENIED_BANNER = `You do not have permission to view the audit log. ${AUDIT_READ_REMEDY}`;

// The CONTROL-shaped form of the same refusal. It differs from the banner deliberately: a banner explains
// a missing table, a control has to explain why it will not act. It names the permission in customer
// language via capabilityPhrase (never the raw dotted id), and it attributes the refusal to the
// ENGINE rather than to the caller's role, which is the precise claim here. audit.read sits in the read
// floor every built-in role holds (lib/identity-model.ts) and the engine folds that floor into every
// custom role too (engine scheduler-do-rbac.ts, "custom roles are additive"), so the client's own
// capability table would answer "you hold this" for every caller composable today. The 403 is the only
// thing that established the denial, so the sentence says that and nothing it has not established.
const AUDIT_READ_DENIED_CONTROL = `Requires ${capabilityPhrase("audit.read")}; the engine refused this read. ${AUDIT_READ_REMEDY}`;

/**
 * A latch over the privileged controls on this screen, so a denial that arrives ASYNCHRONOUSLY still
 * reaches controls built before it and controls built after it.
 *
 * WHY A LATCH RATHER THAN THE ORDINARY BUILD-TIME SHAPE. refuseWithReason's own contract (lib/dom.ts) is
 * `if (allowed) el.addEventListener(...); else refuseWithReason(el, r)`: the caller must never attach a
 * handler on the refused branch, because aria-disabled is an announcement and does not stop a click. That
 * shape needs the answer BEFORE the control is built, and here there is no such answer to have. canCap
 * cannot supply one (audit.read is in the read floor, so it is true for every caller), and the near-cap
 * card's own two export buttons are created later still, from an unrelated status read. So the controls
 * are registered here, the latch refuses whatever it already holds the moment deny() is called, and it
 * refuses anything registered afterwards on arrival. Every handler asks isDenied() first, which is what
 * actually makes a refused control inert; the refusal marking is what makes it legible.
 */
interface DenialLatch {
  register: (el: HTMLElement) => void;
  deny: () => void;
  isDenied: () => boolean;
}

function denialLatch(reason: string): DenialLatch {
  const controls = new Set<HTMLElement>();
  let denied = false;
  const mark = (el: HTMLElement): void => {
    // Idempotent: deny() may run on every load() retry, and refuseWithReason appends a description node
    // each time it is called, so marking twice would announce the same reason twice.
    if (el.getAttribute("aria-disabled") === "true") return;
    refuseWithReason(el, reason);
  };
  return {
    register: (el) => {
      controls.add(el);
      if (denied) mark(el);
    },
    deny: () => {
      denied = true;
      for (const el of controls) mark(el);
    },
    isDenied: () => denied,
  };
}

export function renderAuditPanel(engine: EngineClient, query: URLSearchParams): HTMLElement {
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-5)", "aria-labelledby": "audit-h" });

  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the tamper-evident
  // chain integrity check). No behaviour; no effect on the genuine console.
  const verifyBtn = h("button", { "data-dp": "access-security.button.verify", class: "btn btn--secondary btn--sm", type: "button", dataset: { tourId: "audit-verify" } }, svgIcon(ICON_SHIELD_CHECK, { size: 14 }), "Verify chain integrity") as HTMLButtonElement;
  const exportJsonBtn = h("button", { "data-dp": "access-security.button.export-json", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_LICENCE, { size: 14 }), "Export (JSON)") as HTMLButtonElement;
  const exportCsvBtn = h("button", { "data-dp": "access-security.button.export-csv", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_LICENCE, { size: 14 }), "Export (CSV)") as HTMLButtonElement;

  // Registered with the latch AT BUILD TIME, before anything is fetched, so a denial arriving from the
  // very first load() finds all three already held. Registration neither refuses nor enables anything on
  // its own; only deny() marks, and only isDenied() makes a handler inert.
  const denial = denialLatch(AUDIT_READ_DENIED_CONTROL);
  denial.register(verifyBtn);
  denial.register(exportJsonBtn);
  denial.register(exportCsvBtn);

  const toolbar = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  // A11Y-05: the audit panel's section heading is correctly placed as the first h2 below
  // the screen h1; the roles and fallback panels gain matching h2s elsewhere.
  // data-tour-id on an INLINE span wrapping the heading TEXT so the public tour's "?" sits beside the words, not
  // at the page edge. Inert; no behaviour, no effect on the genuine console.
  lead.appendChild(h("h2", { id: "audit-h", style: "font-size:var(--text-lg)" }, h("span", { dataset: { tourId: "audit-heading" } }, "Audit log")));
  lead.appendChild(h("p", { class: "field__hint measure" }, "Append-only record of every privileged action: who, what (redacted of values), when, from where, and the outcome. Stored in your own account; the vendor cannot read or alter it."));
  toolbar.appendChild(lead);
  toolbar.appendChild(h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" }, verifyBtn, exportJsonBtn, exportCsvBtn));
  wrap.appendChild(toolbar);

  // The audit boundary, stated NOW regardless of D4 (F6). It is the panel's ONE standing
  // banner (7a); the tamper-evident mechanism and the redaction/retention facts sit behind
  // the "What this log proves" disclosure above the filter bar.
  wrap.appendChild(
    banner({
      tone: "info",
      message:
        "This trail covers actions driven against the engine admin API. Out-of-band posture changes (applying a secret, redeploying the engine, editing Cloudflare Access policy) are recorded only as console intent plus, where the engine can detect the result, an engine-observed event; the authoritative record for those lives in Cloudflare, deploy and Wrangler logs.",
    }),
  );

  // Hidden until the verify action populates it: an empty grid child still occupies a row, so
  // leaving it visible creates a dead band in the section gap before verification ever runs.
  const verifyHost = h("div", { role: "region", "aria-label": "Audit chain verification result", hidden: true });
  wrap.appendChild(verifyHost);

  // Near-cap warning (C8-02 / DEF-03): fetch the engine status and surface a calm,
  // export-linked warning only when auditNearCap is explicitly true. We do not surface
  // anything when the status call fails (honest: we only show the warning when the engine
  // reports it). The warning sits above the filter bar so it is seen before the table.
  // Hidden until populated, for the same dead-band reason as verifyHost above.
  const nearCapHost = h("div", { hidden: true });
  wrap.appendChild(nearCapHost);
  // The latch is handed down because this card builds TWO MORE export buttons of its own, later, from an
  // unrelated status read (the "Export now" pair inside the warning). They delegate to the toolbar pair,
  // so the isDenied() guard above already makes them inert, but an inert control that still looks live is
  // the same defect one level down. Registering them with the same latch means they are born refused when
  // the denial has already landed, and refused on arrival when it lands afterwards.
  mountNearCapWarning(engine, nearCapHost, exportJsonBtn, exportCsvBtn, denial);

  // console-access-2 + console-access-4: the filters are the SERVER-SIDE query the engine
  // applies, seeded from the URL so a filtered view is bookmarkable and survives a
  // refresh. Every change re-fetches via load() and is reflected back to the URL.
  const filters: AuditFilters = auditFiltersFromQuery(query);

  const region = h("div", { class: "async-region" });

  // load drives the list SERVER-SIDE from the AuditFilters (actor/action/outcome/from/to),
  // so a search reaches beyond the first page (console-access-4); it is debounced for the
  // free-text actor input. A failure degrades honestly to the pending-engine note.
  const load = (): void => {
    region.replaceChildren(skeletonRows(6));
    void engine
      .listAudit(filters)
      .then((page) => region.replaceChildren(renderAuditEvents(engine, page, filters, load)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the audit table is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        // A 403 is a capability-gate denial (the caller lacks audit.read), NOT the engine audit store being
        // unwired. Say so plainly: the generic pending-engine note below reads as an unbuilt feature and
        // misleads a legitimately-denied viewer.
        //
        // THE OLD COMMENT HERE POINTED AT A SIBLING THAT DOES NOT EXIST. It said "the sibling reports
        // screen already distinguishes this"; reports.ts, reports-helpers.ts, reports-evidence-packs.ts
        // and reports-rto.ts contain no isForbidden, no 403 and no permission copy of any kind, and the
        // only other isForbidden site in the console is sources-downpipes/detail-actions.ts's drillLatest.
        // That one is the real precedent and it is followed here: it names the permission in customer
        // language and its own comment says the control "should already be gated disabled-with-reason".
        //
        // AND REFUSE THE ACTIONS, which is the half this branch was missing until. The banner
        // replaces `region`, and the three privileged buttons are built ABOVE it and live OUTSIDE it, so
        // no amount of replacing the region's children could ever reach them. Driven against a live estate
        // as an Operator and as a Viewer, rendered text identical: the denial was stated and all three
        // actions stayed enabled. Every one of them is refused by the SAME capability at the engine (GET
        // /audit, GET /audit/verify and GET /audit/export each gate on audit.read, engine
        // admin/router-rbac.ts), so a caller denied the list is denied all three, and clicking them was
        // measured to produce a second, WORSE message: "retry once the engine is healthy" told a denied
        // operator to wait for a fault that does not exist. Refusing them, rather than hiding them, is the
        // house rule (design-system: disabled-with-reason, never hidden-then-403), and it is the right one
        // here: an action that vanishes teaches nothing, an action that names the permission it needs and
        // who can grant it is a governed refusal a customer can act on.
        if (isForbidden(err)) {
          denial.deny();
          region.replaceChildren(banner({ tone: "info", message: AUDIT_READ_DENIED_BANNER }));
          return;
        }
        // The audit tile says the engine's audit store is not live yet. On a 404/501 that is
        // true and the pending-engine note is honest. But on a 500 the engine IS live and IS broken, and on a
        // network throw it is unreachable: in both cases the record of every privileged action is not being read,
        // and the customer must NOT be told the trail is merely "coming soon" while a real fault hides it. "The
        // audit tab says pending the engine but our engine is deployed" was the ticket, verbatim; route a genuine
        // fault to the honest block error with Retry, and keep pending-engine only for a genuine not-wired build.
        recordFeature("audit-events", err);
        const cls = classifyError(err);
        const notWired = cls.kind === "server" && (cls.status === 404 || cls.status === 501);
        if (!notWired) {
          region.replaceChildren(blockError(err, load, { origin: location.origin }));
          return;
        }
        region.replaceChildren(
          pendingEngineNote({
            what: "The audit event table could not load. When the engine audit store is live, this shows the redacted, hash-chained record of every privileged action, filterable server-side by actor, action, outcome and date, with expandable change-control detail.",
            dependsOn: "D4 the engine audit store (GET /admin/audit)",
            interim: `The engine returned: ${errText(err)}. The interim who-did-what is Cloudflare Access logs plus structured privileged-route logs. The trail is design-complete, pending the engine.`,
          }),
        );
      });
  };

  // What the chain proves, in one collapsed place (the tamper-evident mechanism + the
  // redaction and retention facts), instead of two standing notes bracketing every visit.
  wrap.appendChild(
    lazyDisclosure("What this log proves", () =>
      h(
        "div",
        { style: "display:grid;gap:var(--space-3)" },
        h(
          "p",
          { class: "field__hint measure" },
          "Each entry is hashed together with the one before it, so deleting, editing or reordering any entry breaks the chain from that point and is detectable. The export carries the chain head hash so an external party can confirm nothing was truncated. This is tamper-evident, which means detectable, not impossible.",
        ),
        h(
          "p",
          { class: "field__hint measure" },
          "Denied and failed actions are recorded too. The log records that a restore of a run targeted a binding, never a key and never a record value: redaction by construction. The engine retains entries up to a fixed cap and rolls over oldest-first; export before rollover to retain older entries.",
        ),
      ),
    ),
  );

  // The server-side filter bar (debounced text + selects + dates). It mutates `filters`,
  // reflects them to the URL, and calls load(); it never filters client-side.
  wrap.appendChild(auditFilterBar(filters, load));
  wrap.appendChild(region);

  // isDenied() FIRST in each handler, and that is what actually makes a refused control inert.
  // refuseWithReason marks and announces; it deliberately does not stop the click (lib/dom.ts), and its
  // usual caller answers that by never attaching a handler at all. That is not available here: the denial
  // is not known until a fetch has failed, long after these listeners are bound. So the guard lives inside
  // the handler, where it is checked at the moment of the click rather than at the moment of the build.
  verifyBtn.addEventListener("click", () => {
    if (denial.isDenied()) return;
    handleVerifyChain(engine, verifyBtn, verifyHost);
  });

  exportJsonBtn.addEventListener("click", () => {
    if (denial.isDenied()) return;
    void runAuditExport(engine, "json", exportJsonBtn);
  });
  exportCsvBtn.addEventListener("click", () => {
    if (denial.isDenied()) return;
    void runAuditExport(engine, "csv", exportCsvBtn);
  });

  load();

  return wrap;
}

// mountNearCapWarning fetches the engine status and surfaces a calm, export-linked warning only when
// auditNearCap is explicitly true (C8-02 / DEF-03), so the warning only ever reflects what the engine
// reports.
//
// The three outcomes are now DISTINCT, because they were not. A failed status read used to render exactly
// what "the log is fine" renders (nothing), so a customer whose audit log rolled past retention unexported
// was never warned, and afterwards nobody could say whether the console had checked at all. A read that
// failed, and an engine whose status carries no auditNearCap field to read, are both reported as an UNKNOWN
// capacity (a quiet hint with the export to hand), never as an all-clear. They are hints, not alarms: this
// is the absence of a check, not the presence of a fault.
export type NearCapView = "rolling" | "warn" | "unknown-not-reported" | "unknown-read-failed" | "none";

// nearCapView is the PURE decision behind the capacity notice. Exported so the validator pins the two
// properties that matter: an UNKNOWN is never mapped to "none", and a log that is ALREADY LOSING ENTRIES is
// never mapped to "warn".
//
// THE FOURTH STATE, AND WHY THE THREE WERE NOT ENOUGH. The engine's retained audit count SATURATES at its
// retention cap: from the first rollover onwards it is pinned there, so auditNearCap is true both at the
// moment nothing has been lost and after ten thousand entries have been destroyed. This function was handed
// only that boolean, so it answered "warn" to both, and the warn card's copy is written in the future tense
// ("once the cap is reached, oldest entries are rolled over") and ends "Export now to retain the full
// history". Past the cap the full history no longer exists to export, so that is a remedy the operator
// cannot take, offered at the one moment they most need the truth. auditRolledOverCount separates the two
// states and the engine now sends it.
//
// A count of 0 is a REPORTED zero and stays "warn", which is correct: nothing has rolled yet and the export
// really does still retain everything. An ABSENT count on an older engine also reads "warn", which is the
// same answer this function has always given and is the safe direction: a capacity warning that could not
// read the loss must not be silently upgraded to a claim about it.
export function nearCapView(read: "ok" | "failed", auditNearCap: boolean | undefined, auditRolledOverCount?: number): NearCapView {
  if (read === "failed") return "unknown-read-failed";
  if (auditNearCap === undefined) return "unknown-not-reported";
  if (!auditNearCap) return "none";
  return typeof auditRolledOverCount === "number" && auditRolledOverCount > 0 ? "rolling" : "warn";
}

// NEAR_CAP_UNKNOWN_COPY is the copy for each unknown. Both say plainly that a check did not answer, and
// neither claims a fault: an absent check is not a broken audit log.
const NEAR_CAP_UNKNOWN_COPY: Record<"unknown-not-reported" | "unknown-read-failed", string> = {
  "unknown-not-reported": "This engine build does not report audit-log capacity, so the console cannot warn you before entries roll over. Export the log periodically to keep the full history.",
  "unknown-read-failed": "The engine's audit-log capacity could not be read, so the console cannot tell you whether the log is near its cap. This is a failed check, not an all-clear. Export the log if you need to be certain of retaining it.",
};

function mountNearCapWarning(
  engine: EngineClient,
  nearCapHost: HTMLElement,
  exportJsonBtn: HTMLButtonElement,
  exportCsvBtn: HTMLButtonElement,
  denial: DenialLatch,
): void {
  const showUnknown = (view: "unknown-not-reported" | "unknown-read-failed"): void => {
    nearCapHost.replaceChildren(h("p", { class: "field__hint", role: "status" }, NEAR_CAP_UNKNOWN_COPY[view]));
    nearCapHost.hidden = false;
  };

  void engine
    .status()
    .then((s) => {
      const view = nearCapView("ok", s.auditNearCap, s.auditRolledOverCount);
      if (view === "none") return;
      if (view === "unknown-not-reported" || view === "unknown-read-failed") {
        showUnknown(view);
        return;
      }
      const rolledAway = view === "rolling" ? (s.auditRolledOverCount ?? 0) : 0;
      // POLITE, AND THE ROLE NOW SAYS SO. This card used to declare role="alert" (which implies
      // assertive) together with aria-live="polite", so the two declarations disagreed about
      // whether to interrupt and the answer depended on which one the assistive technology
      // honoured. Measured in Chromium: the AX node came out role=alert with live=polite, so the
      // disagreement genuinely reached the AT rather than being resolved in the browser.
      //
      // It is POLITE, for four reasons rather than by preference:
      //   1. In the approaching state the trigger is a threshold being APPROACHED, not an event that
      //      has happened: no entry has rolled off yet, and none will before the user finishes the
      //      sentence they are hearing. In the ROLLING state entries have gone, but they went
      //      gradually over the weeks before this page was opened, so there is still nothing that
      //      interrupting would let the user prevent. Reasons 2 to 4 hold in both states unchanged.
      //   2. It is not a response to anything the user did. It arrives from a background status
      //      read, at an arbitrary moment, on a screen the user is already reading. Assertive would
      //      cut off the audit table they asked for.
      //   3. The remedy is inside the card and is not tied to the announcement: the two Export
      //      buttons stay on the screen, and the card sits ABOVE the filter bar, so a screen-reader
      //      user meets it early in the reading order whether or not the region ever speaks.
      //   4. The sibling state in this same function (showUnknown, above) already announces with
      //      role="status". "We cannot tell you whether your audit log is about to roll" being
      //      polite while "your audit log is approaching capacity" is assertive would be one
      //      function disagreeing with itself.
      //
      // KNOWN RESIDUE, named rather than implied away: this card is inserted into nearCapHost
      // already populated, and toast.ts:36 records the precondition that announcement needs the
      // region to pre-exist in the DOM. role="alert" is special-cased by browsers to speak on
      // insertion; role="status" is not, so on some assistive technologies this warning will not be
      // spoken at all and will be met in the reading order instead. Moving the live region onto
      // nearCapHost would fix that, but nearCapHost is `hidden` precisely because an empty grid
      // child leaves a dead band in the section gap (see its own comment above), so the fix costs a
      // layout regression. The unknown-state sibling has always lived with the same residue.
      const warningEl = h("div", { class: "card card--inset", role: "status", "aria-live": "polite", style: "display:flex;gap:var(--space-3);align-items:flex-start;padding:var(--space-3) var(--space-4);border-color:var(--warn-border, var(--border))" });
      warningEl.appendChild(h("span", { style: "color:var(--warn-fg);flex:none;margin-top:2px" }, svgIcon(ICON_ALERT, { size: 16 })));
      const body = h("div", { style: "display:grid;gap:var(--space-2);flex:1" });
      // TWO SENTENCES, BECAUSE THE TWO STATES ARE NOT THE SAME STATE. The approaching one promises that an
      // export keeps everything, and it can, because nothing has been dropped yet. The rolling one must not
      // repeat that promise: entries are already gone, no export can bring them back, and an operator told
      // to "export now to retain the full history" would take an incomplete document away believing it was
      // complete. It names what is already lost, and what an export can still do.
      body.appendChild(h("b", { style: "color:var(--warn-fg)" }, rolledAway > 0 ? "Audit log at capacity, oldest entries already rolled over" : "Audit log approaching capacity"));
      body.appendChild(
        h(
          "p",
          { class: "field__hint" },
          rolledAway > 0
            ? `The engine reports the audit log is at its cap and has already rolled ${rolledAway} ${rolledAway === 1 ? "entry" : "entries"} off the oldest end. ${rolledAway === 1 ? "That entry is" : "Those entries are"} no longer held and cannot be recovered. Chain verifiability is preserved from the earliest retained entry, and an export from here carries the retained log rather than the full history. Export regularly to keep what is still held.`
            : "The engine reports the audit log is near its cap. Once the cap is reached, oldest entries are rolled over; chain verifiability is preserved from the earliest retained entry. Export now to retain the full history.",
        ),
      );
      const exportRow = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-1)" });
      const exportNowJson = h("button", { "data-dp": "access-security.button.export-now-json", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_LICENCE, { size: 14 }), "Export (JSON)") as HTMLButtonElement;
      const exportNowCsv = h("button", { "data-dp": "access-security.button.export-now-csv", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_LICENCE, { size: 14 }), "Export (CSV)") as HTMLButtonElement;
      denial.register(exportNowJson);
      denial.register(exportNowCsv);
      exportNowJson.addEventListener("click", () => exportJsonBtn.click());
      exportNowCsv.addEventListener("click", () => exportCsvBtn.click());
      exportRow.appendChild(exportNowJson);
      exportRow.appendChild(exportNowCsv);
      body.appendChild(exportRow);
      warningEl.appendChild(body);
      nearCapHost.replaceChildren(warningEl);
      nearCapHost.hidden = false;
    })
    .catch(() => {
      // The status read FAILED. Never imply a warning the engine did not give, and never imply an
      // all-clear it did not give either: say that the check did not answer.
      showUnknown("unknown-read-failed");
    });
}

// handleVerifyChain runs the verify-chain action and renders the verdict (or, for a 404/501,
// the calm "not yet wired" info, distinguished from a real server or network error which reads
// as "chain integrity is unknown" rather than a misleading neutral "nothing to report").
async function handleVerifyChain(engine: EngineClient, verifyBtn: HTMLButtonElement, verifyHost: HTMLElement): Promise<void> {
  verifyBtn.dataset.busy = "true";
  verifyBtn.disabled = true;
  try {
    const verdict: ChainVerdict = await engine.verifyAuditChain();
    verifyHost.replaceChildren(renderChainVerdict(verdict));
    verifyHost.hidden = false;
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    // Distinguish "not yet wired" (404/501 = route absent, integrity unknown/pending)
    // from an actual server or network error (integrity could not be determined).
    // Neither is a quiet neutral: a neutral tone reads as "nothing to report", which
    // is misleading when the real state is "chain integrity is unknown".
    //
    // AND A 403 IS NEITHER OF THOSE. GET /audit/verify gates on audit.read, the same capability as the
    // list, so a denied caller who reaches this handler (a role changed under an open page, or a click
    // that raced the first load) was told "Chain integrity could not be determined ... retry once the
    // engine is healthy or check the engine logs". The engine is healthy, waiting will not help, and a
    // caller denied the audit log cannot read the engine logs either: three false directions in one
    // sentence. It gets the honest refusal instead, and the toolbar's own refusal is the standing form.
    const kind = classifyError(err);
    const denied = isForbidden(err);
    const notWired =
      kind.kind === "server" && (kind.status === 404 || kind.status === 501);
    verifyHost.replaceChildren(
      verdictSurface({
        tone: notWired ? "info" : "warn",
        title: denied
          ? "Chain verification is not permitted for you"
          : notWired
            ? "Chain verification pending the engine audit store"
            : "Chain integrity could not be determined",
        body: denied
          ? `Verifying the chain requires ${capabilityPhrase("audit.read")}, and the engine refused it. Chain integrity is unknown to you, not unknown to the engine. ${AUDIT_READ_REMEDY}`
          : notWired
            ? `The verify route is not yet wired on this engine build (${errText(err)}). When the engine audit store is live, this confirms the chain recomputes cleanly or names the first broken entry.`
            : `The verify route returned an error (${errText(err)}). Chain integrity is unknown; retry once the engine is healthy or check the engine logs.`,
      }),
    );
    // UNHIDE, which this branch never did. verifyHost starts `hidden` (an empty grid child leaves a dead
    // band, see its own comment) and only the SUCCESS path above cleared it, so every failure verdict this
    // branch has ever built was written into a hidden container and shown to nobody. Measured on a live
    // estate: clicking "Verify chain integrity" as a denied operator put the full warn
    // verdict into the DOM with hidden still true, so the click appeared to do nothing at all. That holds
    // for every failure this branch covers, not only the denial.
    verifyHost.hidden = false;
  } finally {
    verifyBtn.dataset.busy = "false";
    verifyBtn.disabled = false;
  }
}

// runAuditExport downloads the audit log in the chosen format. Mirroring the verify-chain
// handling, only a 404/501 (the export route not yet wired) is the calm "pending the engine"
// info; any other failure is a real, warn-tone failure, never softened to pending (nothing was
// downloaded).
async function runAuditExport(engine: EngineClient, format: "json" | "csv", btn: HTMLButtonElement): Promise<void> {
  btn.dataset.busy = "true";
  btn.disabled = true;
  try {
    const text = await engine.exportAudit(format);
    downloadText(`downpipe-audit.${format}`, text, format === "json" ? "application/json" : "text/csv");
    toast({ message: `Audit log exported (${format.toUpperCase()}), with the chain head hash included` });
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    // The same three-way split as handleVerifyChain, for the same measured reason: GET /audit/export gates
    // on audit.read, and a denied caller was told "Nothing was downloaded; retry once the engine is
    // healthy". Nothing was downloaded is true; the rest sends them to wait on a fault that is not there.
    if (isForbidden(err)) {
      toast({ message: `The export was refused: it requires ${capabilityPhrase("audit.read")}. Nothing was downloaded. ${AUDIT_READ_REMEDY}`, tone: "info" });
      return;
    }
    const kind = classifyError(err);
    const notWired = kind.kind === "server" && (kind.status === 404 || kind.status === 501);
    if (notWired) {
      toast({ message: `Export is pending the engine audit store (${errText(err)}).`, tone: "info" });
    } else {
      toast({ message: `The export failed (${errText(err)}). Nothing was downloaded; retry once the engine is healthy.`, tone: "warn" });
    }
  } finally {
    btn.dataset.busy = "false";
    btn.disabled = false;
  }
}

// recordFeature: the feature-skew emit helper (see roles.ts). A 401 records nothing: a lapsed session is the ordinary
// state of a console left open overnight, and a fault row for each one would bury the true faults.
function recordFeature(featureClass: ClientDiagFeatureClass, err: unknown): void {
  const outcome = featureOutcomeForError(err);
  if (outcome !== null) recordFeatureProbe(featureClass, outcome);
}
