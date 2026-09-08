// Overview (IA screen 1) side column: the "what needs me" attention list and the recovery
// posture card group (RPO, recovery mode, the dated drill-evidence + audit trail, the fleet
// Drill all action). The posture reads the REAL drill-evidence / audit trail and states the
// honest "pending engine" boundary rather than faking a history, and renders as first-class
// stat tiles matching the status row at the top of the page (not a demoted disclosure). House
// rules: Australian English, no em dashes, precise claims.

import type {
  AuditEvent,
  DrillEvidenceEntry,
  StatusReport,
} from "../../api.ts";
import { statGrid, statTile } from "../../components/stat-tiles.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError } from "../../lib/errors.ts";
import { absoluteTime, groupNumber, relativeTime, titleCase } from "../../lib/format.ts";
import {
  ICON_ALERT,
  ICON_CHEVRON_RIGHT,
  ICON_INFO,
  ICON_RESTORE,
  ICON_SHIELD_CHECK,
} from "../../lib/icons.ts";
import { caller, navigate, whoamiAvailable } from "../../lib/nav.ts";
import { actionLabel } from "../access-security/audit-display.ts";
import { ROUTE_AUDIT } from "../access-security/shared.ts";
import { canCap, capGateReason } from "../common.ts";
import {
  type FleetSummary,
  newestDrill,
  type OverviewData,
  plural,
  type Settled,
  trailReadState,
} from "./shared.ts";

// ---- needs-me attention list + recovery posture -----------------------------
// The attention list ("what needs me") stays in the narrow side column beside the fleet table;
// the standing recovery posture is rendered full-width by the page builders (build.ts /
// executive.ts) so its four stat tiles flow across the page like the status row at the top,
// which is what its first-class-tiles design intends. It used to be crammed into the side column.

interface NeedItem {
  readonly tone: "warn" | "info" | "trust" | "danger";
  readonly glyph: string;
  readonly title: string;
  readonly desc: string;
  readonly action: { label: string; onClick: () => void };
}

// collectNeedsItems assembles the attention list (pure, testable). Failed/stale are NOT
// restated here: the non-dismissible banner above and the worst-first fleet table already
// carry the same fact and the same destinations (one failed downpipe was encoded five times
// on one screen). The empty state stays honest about them instead.
export function collectNeedsItems(data: OverviewData, fleet: FleetSummary): NeedItem[] {
  const items: NeedItem[] = [];

  const upd = data.updates.ok ? data.updates.value : null;
  if (upd?.updateAvailable) {
    items.push({
      tone: "info",
      glyph: ICON_INFO,
      title: `Update ${upd.recommendedVersion ?? "available"}`,
      desc: "Review provenance before applying.",
      action: { label: "Review", onClick: () => navigate("/licence") },
    });
  }
  // Prove recoverability so the evidence trail is complete. Only meaningful once there
  // are runs to drill (anyRuns implies history.ok), and SUPPRESSED once the
  // drill-evidence trail holds a dated drill (the same precedence recoverableAnswer
  // applies): a standing nag beside a "last proven recoverable: 2h ago" read would
  // train the owner to ignore this list.
  const proven = data.drillEvidence.ok && newestDrill(data.drillEvidence.value) !== null;
  if (fleet.anyRuns && !proven) {
    items.push({
      tone: "trust",
      glyph: ICON_SHIELD_CHECK,
      title: "Prove recoverability",
      desc: "Drill a recent run so recovery is demonstrated, not assumed, and the evidence trail is complete.",
      action: { label: "Recovery", onClick: () => navigate("/restore") },
    });
  }
  // Access not verified: surface the harden path when the verdict is the token fallback.
  // Only when whoami is available (D1); the honest unknown is not an action item.
  const c = caller();
  if (whoamiAvailable() && c && c.method === "token") {
    items.push({
      tone: "warn",
      glyph: ICON_ALERT,
      title: "Access is not enforced",
      desc: "The engine is reachable with the shared token; put it behind Cloudflare Access to attribute actions.",
      action: { label: "Harden", onClick: () => navigate("/access") },
    });
  }
  // Pending restore approvals are an item for whoever can sign one (dual control, D2), shown only
  // when the inbox actually holds a pending request: a standing prompt with nothing to
  // approve is noise, and an unreadable inbox is an unknown, not an action item.
  // Gated by the restore.approve CAPABILITY, matching the engine's gate for POST /restore/approve
  // and the approvals inbox's own approve/reject gate (restore-flow/approvals.ts). The old
  // role-NAME test (approver/owner) excluded restore-operator, which holds restore.approve, so the
  // recovery-only role was never told its own inbox had work waiting.
  const pendingApprovals = data.approvals.ok ? data.approvals.value.filter((a) => a.status === "requested").length : 0;
  if (whoamiAvailable() && c && canCap("restore.approve") && pendingApprovals > 0) {
    items.push({
      tone: "info",
      glyph: ICON_RESTORE,
      title: `${pendingApprovals} ${plural(pendingApprovals, "restore")} awaiting approval`,
      desc: "A second authorised sign-off is needed (dual control).",
      action: { label: "Open inbox", onClick: () => navigate("/restore/approvals") },
    });
  }
  return items;
}

// attentionReadsUnread names the engine reads this list DEPENDS ON that did not answer. It exists because
// the all-clear below is a positive claim, and a positive claim made from reads that failed is a claim made
// from nothing.
//
// THE HONESTY GATE THAT WAS ALREADY HERE COULD NOT CATCH THIS, AND THE REASON IS THE WHOLE FINDING. It
// tested `fleet.failed > 0 || fleet.stale > 0`, and those counters are computed by summariseFleet from the
// history and downpipe reads: when either read FAILS, summariseFleet builds no rows, so every counter comes
// back ZERO. A lost read and a clean fleet produce the identical FleetSummary, so the gate written to stop
// exactly this saw a healthy zero and stood aside. That is the "lost read as zero" shape, inside the guard.
//
// Before the repair, driving the real renderer, a console whose downpipe list was refused rendered
// "Nothing needs your attention. Backups are current and recovery posture is in force." BYTE FOR BYTE
// identical to a fully healthy fleet, and a console whose EVERY read was refused rendered "Nothing needs
// your attention yet." byte for byte identical to a brand-new estate. The executive framing of this very
// screen reads the SAME OverviewData and answers "Unknown, we could not read the downpipe list" to the same
// fault, so the two framings, which their own comments promise cannot disagree, disagreed.
//
// Only the reads this list actually consults are named. discovery, health and the licence are omitted on
// purpose: nothing in collectNeedsItems reads them, so a failure there does not make THIS list incomplete,
// and naming it would cry wolf. Exported so the validator drives it over each read in turn.
export function attentionReadsUnread(data: OverviewData): string[] {
  const unread: string[] = [];
  if (!data.downpipes.ok) unread.push("the downpipe list");
  if (!data.history.ok) unread.push("the run history");
  if (!data.updates.ok) unread.push("the update channel");
  if (!data.drillEvidence.ok) unread.push("the drill-evidence trail");
  if (!data.approvals.ok) unread.push("the restore-approvals inbox");
  return unread;
}

// ATTENTION_INCOMPLETE_LEAD is the sentence that replaces the all-clear when a read this list depends on did
// not answer. It is a could-not-tell, not an alarm: nothing is known to be wrong, and saying so is the point.
export const ATTENTION_INCOMPLETE_LEAD =
  "This list is incomplete, so it cannot say that nothing needs you." as const;

// listPhrase joins the named reads into an Australian-English list ("A", "A and B", "A, B and C"), no
// serial comma, matching the copy elsewhere on this screen.
function listPhrase(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function buildNeedsMe(data: OverviewData, fleet: FleetSummary): HTMLElement {
  const section = h("section", { "aria-labelledby": "ov-needs-h" });
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the triage list),
  // set on an INLINE span wrapping the heading TEXT so the "?" sits just to the right of the words, not at the
  // page edge. No behaviour; no effect on the genuine console.
  section.appendChild(h("h2", { id: "ov-needs-h", style: "font-size:var(--text-lg);margin-bottom:var(--space-3)" }, h("span", { dataset: { tourId: "overview-attention" } }, "Needs your attention")));

  const items = collectNeedsItems(data, fleet);

  if (items.length === 0) {
    // FIRST honesty gate, and it outranks the two below: an empty list is only an all-clear when the reads
    // that build it actually answered. A refused read contributes no items for the same reason a healthy one
    // does, so silence here is ambiguous until the reads are checked. See attentionReadsUnread.
    const unread = attentionReadsUnread(data);
    if (unread.length > 0) {
      section.appendChild(
        h(
          "div",
          { class: "card card--inset", style: "display:flex;align-items:flex-start;gap:var(--space-3)" },
          h("span", { class: "dot dot--neutral", "aria-hidden": "true", style: "margin-top:6px;flex:none" }),
          h(
            "div",
            { style: "min-width:0" },
            h("p", { style: "font-weight:var(--weight-medium)" }, ATTENTION_INCOMPLETE_LEAD),
            // The failed reads are NAMED, not counted. "Some reads failed" sends the operator hunting; the
            // list above already shows each read's own status, and naming them here joins the two.
            h("p", { class: "field__hint", style: "margin-top:2px" }, `The engine did not answer for ${listPhrase(unread)}. Nothing is known to be wrong; this is an honest unknown. Retry, or check the engine connection.`),
          ),
        ),
      );
      return section;
    }
    // Honesty gate: the calm all-clear may only render when the fleet read backs it.
    // With failures or staleness in force the banner above owns that fact; this list
    // points at it rather than claiming calm beneath a danger banner.
    if (fleet.failed > 0 || fleet.stale > 0) {
      section.appendChild(
        h(
          "p",
          { class: "field__hint" },
          "The failed or stale downpipes flagged in the banner above are what need you; they lead the fleet table.",
        ),
      );
      return section;
    }
    // AN EMPTY RUN HISTORY AND A BRAND-NEW ESTATE WERE THE SAME SENTENCE, and they are opposite states.
    // "Nothing needs your attention yet" is the teaching copy for an estate that has never run anything.
    // It was also what an operator saw over an estate whose every run record had rolled out of the bounded
    // ring, because the rings were the only thing on the wire and an empty map reads the same either way.
    // The engine now publishes the count of runs it RECORDED alongside the rings, so the two can be told
    // apart, and this is the branch that tells them apart. It does not claim a fault: run history rolling
    // is normal and the archives are untouched. It says the console cannot show what those runs did, which
    // is the fact the operator needs before they go looking for evidence that is not there.
    const rolled = fleet.runsRolledOverCount;
    const historyRolled = !fleet.anyRuns && typeof rolled === "number" && rolled > 0;
    section.appendChild(
      h(
        "div",
        { class: "card card--inset", style: "display:flex;align-items:center;gap:var(--space-3)" },
        h("span", { style: "color:var(--ok-fg);display:inline-flex", "aria-hidden": "true" }, svgIcon(ICON_SHIELD_CHECK, { size: 18 })),
        // The stronger claim only when runs back it (with runs, an empty list implies a
        // dated drill exists: the prove-recoverability item suppresses only on evidence).
        h("p", fleet.anyRuns
          ? "Nothing needs your attention. Backups are current and recovery posture is in force."
          : historyRolled
            // `at least` when the account-global counter has been wound back below a retained index: the
            // figure is then a floor rather than a measurement, and the engine says so rather than letting
            // a reader take an under-reported loss for the whole of it.
            ? `Nothing needs your attention, and this estate is not new: ${fleet.runlogCounterReset === true ? "at least " : ""}${groupNumber(rolled)} ${rolled === 1 ? "run has" : "runs have"} rolled out of the retained run history. Your archives are not affected; the console can no longer show you what those runs did.`
            : "Nothing needs your attention yet."),
      ),
    );
    return section;
  }

  const list = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-2)" });
  for (const item of items) list.appendChild(needCard(item));
  section.appendChild(list);
  return section;
}

function needCard(item: NeedItem): HTMLElement {
  const tone = item.tone;
  const iconColor =
    tone === "warn" ? "var(--warn)" : tone === "danger" ? "var(--danger)" : tone === "trust" ? "var(--trust)" : "var(--info)";
  return h(
    "div",
    { class: "card", style: "display:flex;align-items:flex-start;gap:var(--space-3);padding:var(--space-3)" },
    h("span", { style: `color:${iconColor};flex:none;display:inline-flex;margin-top:1px`, "aria-hidden": "true" }, svgIcon(item.glyph, { size: 18 })),
    h(
      "div",
      { style: "flex:1 1 auto;min-width:0" },
      h("div", { style: "font-weight:var(--weight-medium)" }, item.title),
      h("div", { class: "field__hint", style: "margin-top:1px" }, item.desc),
    ),
    h(
      "button",
      { "data-dp": "overview.button.click#1", class: "btn btn--secondary btn--sm", type: "button", style: "flex:none", on: { click: () => item.action.onClick() } },
      item.action.label,
    ),
  );
}

// buildRecoverySection renders the standing recovery posture as a first-class card group: a
// heading with the fleet Drill all action beside it, then the posture facts (RPO, recovery
// mode, the dated drill-evidence and audit trail) as stat tiles matching the status row at the
// top of the page, an honest D4 boundary note, and a link to the full recovery surface. Always
// visible (no disclosure): the owner reads recovery posture at a glance, not one open away. The
// drill remains reachable from the command palette regardless.
export function buildRecoverySection(data: OverviewData, fleet: FleetSummary, onDrillFleet: () => void | Promise<void>): HTMLElement {
  const section = h("section", { class: "ov-recovery", "aria-labelledby": "ov-recovery-h" });

  // The heading carries the fleet Drill all action beside it, gated on the drill.run capability the
  // engine enforces (POST /admin/drill); a caller lacking it sees the button disabled and the reason
  // as visible text below (matching the needs-me gate style), never a hover-only title.
  const opGate = canCap("drill.run");
  section.appendChild(
    h(
      "div",
      { class: "ov-recovery__head" },
      h("h2", { id: "ov-recovery-h", class: "ov-recovery__title" }, "Recovery posture"),
      drillButton(onDrillFleet, opGate),
    ),
  );
  if (!opGate) section.appendChild(h("p", { class: "field__hint" }, capGateReason("drill.run")));

  // The posture facts as tiles, in the SAME stat grid the status row uses, so recovery reads as
  // one system with the health / configuration / licence / updates cards above it.
  section.appendChild(
    statGrid(
      recoveryPointCard(fleet),
      recoveryModeCard(data.status),
      lastDrilledCard(data.drillEvidence),
      lastAuditedCard(data.audit),
    ),
  );

  section.appendChild(buildBoundaryNote(data));

  // A chevron, not the external-link glyph: /restore is in-app navigation, not a new tab.
  section.appendChild(
    h(
      "button",
      { "data-dp": "overview.button.navigate-restore", class: "linklike", type: "button", style: "display:inline-flex;align-items:center;gap:var(--space-1)", on: { click: () => navigate("/restore") } },
      "Open recovery surface",
      svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
    ),
  );
  return section;
}

// drillButton builds the fleet-drill trigger (Operator+, J5 step 3, the one write this surface
// owns). data-drill-all is the hook the view's per-drill progress repaints (setDrillProgress);
// the data-busy guard stops a double click drilling every run twice (a drill is a sequence of
// POSTs). Disabled for a Viewer; the gate reason is rendered beside it by the caller.
function drillButton(onDrillFleet: () => void | Promise<void>, opGate: boolean): HTMLButtonElement {
  const btn = h(
    "button",
    { "data-dp": "overview.button.drill-button",
      class: "btn btn--secondary btn--sm",
      type: "button",
      "data-drill-all": "true",
      ...(opGate ? {} : { disabled: true }),
    },
    svgIcon(ICON_SHIELD_CHECK, { size: 14 }),
    "Drill all",
  ) as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    if (btn.dataset.busy === "true") return;
    btn.dataset.busy = "true";
    btn.disabled = true;
    try {
      await onDrillFleet();
    } finally {
      btn.dataset.busy = "false";
      btn.disabled = !opGate;
    }
  });
  return btn;
}

// recoveryPointCard: the fleet's WORST-CASE recovery point, which is the age of the OLDEST good
// backup among downpipes that are meant to be protected.
//
// This card used to read fleet.newestGoodAt, so a fleet with one downpipe backed up five
// minutes ago and nine untouched for a month rendered "Recovery point (RPO): 5m ago, Fleet-wide".
// A recovery point answers how much you could lose right now, and that is set by the stalest
// protected system, never the freshest. The old tile was reassuring in exactly the direction that
// hides risk, on the highest-billing "is it working" tile on the page, under a term of art an
// operator may already trust from other tooling.
//
// A downpipe that has NEVER had a good backup does not get a duration, because it does not have one.
// Its recovery point is undefined rather than long, and any duration printed for it would be smaller
// than the truth. It takes the headline instead, since it is the worse state.
function recoveryPointCard(fleet: FleetSummary): HTMLElement {
  if (fleet.noGoodBackupCount > 0) {
    const n = fleet.noGoodBackupCount;
    return statTile({
      label: "Recovery point (RPO)",
      value: "No good backup",
      status: { tone: "warn", label: `${n} of ${fleet.total}` },
      secondary: `${n} ${n === 1 ? "downpipe has" : "downpipes have"} never completed a good backup, so there is no recovery point for ${n === 1 ? "it" : "them"} yet.`,
    });
  }
  const rpo = fleet.worstGoodAt;
  return statTile({
    label: "Recovery point (RPO)",
    value: rpo ? relativeTime(rpo) : "No good backup yet",
    status: rpo ? { tone: "trust", label: "Worst case" } : { tone: "neutral", label: "Unproven" },
    secondary: rpo
      ? "Age of the OLDEST good backup, which is the most you could lose."
      : "Run a backup, then drill to prove recoverability.",
    ...(rpo ? { title: absoluteTime(rpo) } : {}),
  });
}

// recoveryModeCard: two-recipient (an operational read-back key is present, so the engine can
// verify the integrity chain and restore a sample in account) vs break-glass-only, inferred from
// operationalConfigured.private (matching the key ceremony wording). Account-wide presence;
// per-downpipe mode is on the Restore screen. An unread status degrades to an honest unknown
// tile rather than asserting a mode.
function recoveryModeCard(status: Settled<StatusReport>): HTMLElement {
  if (!status.ok) return statTile({ label: "Recovery mode", state: "unknown" });
  // Another lone hold-out of exactly the shape this repair exists for. A status read
  // that SETTLES ok can still carry a partial payload (the type promises operationalConfigured, the wire
  // does not), and the sibling site that reads the same field on the onboarding card already writes
  // `s.operationalConfigured?.private`. This one did not, so an ok:true status with the object absent threw
  // here and, before the boundary below it existed, took the entire Overview down with it: driven on the
  // served bundle, that single missing object was the difference between nine stat tiles and a permanent
  // loading skeleton.
  //
  // An ABSENT posture is not "break-glass-only". Defaulting it to false would assert the more alarming of
  // the two recovery modes off a field that never arrived, and the operator would be told the engine holds
  // no read-back key on no evidence at all, so the honest unknown tile is used instead: the same answer an
  // unread status gets, because the console knows exactly as much in both cases.
  const posture = status.value.operationalConfigured as { private?: boolean } | undefined;
  if (posture === null || typeof posture !== "object") {
    // NOT the shared `state: "unknown"` tile, and the distinction is the point. That tile's copy reads
    // "could not reach the engine", which would be a false claim here: the engine WAS reached, answered
    // 200, and simply did not carry the field. Sending an operator to check reachability over a payload
    // gap is a wrong remedy for a real fault, and it is the same class of error as the crash above.
    return statTile({
      label: "Recovery mode",
      value: "Unknown",
      status: { tone: "neutral", label: "Not reported" },
      secondary: "The engine answered but did not report the recovery posture, so this console cannot say whether an in-account read-back key is present.",
    });
  }
  const twoRecipient = posture.private === true;
  // In the break-glass-only posture the engine holds no read-back key, so recovery is proven with ATTENDED
  // verification (the operator supplies the break-glass key in the browser), not an offline rehearsal. The
  // tile routes there so the honest "no key here reads the archives" statement carries a real next step.
  return statTile({
    label: "Recovery mode",
    value: twoRecipient ? "Two-recipient" : "Break-glass-only",
    status: twoRecipient ? { tone: "info", label: "In-account verify" } : { tone: "info", label: "Attended verify" },
    secondary: twoRecipient
      ? "The engine can verify recovery in account."
      : "By design no key here reads the archives; prove recoverability with attended verification.",
    ...(twoRecipient ? {} : { onActivate: () => navigate("/restore/attend") }),
  });
}

// buildBoundaryNote: the honest D4 boundary statement, conditional on what was actually
// read: when the trail is live the copy says so; when it is not yet wired it states the
// boundary plainly rather than faking a history.
function buildBoundaryNote(data: OverviewData): HTMLElement {
  const state = trailReadState(data.drillEvidence, data.audit);
  const copy =
    state === "live"
      ? "Evidence is generated and stored in account; nothing is sent to the vendor. The dated drill-evidence and audit trail above is read live from the engine."
      : state === "not-wired"
        ? "Evidence is generated and stored in account; nothing is sent to the vendor. The durable, dated drill-evidence and audit record is an engine addition; until it ships, the recovery surface shows in-session drills plus recorded offline rehearsals."
        : "Evidence is generated and stored in account; nothing is sent to the vendor. The durable, dated drill-evidence and audit trail could not be read (the engine faulted); the tiles above show each read's status, and in-session drills plus recorded offline rehearsals stand in the meantime.";
  return h("p", { class: "field__hint" }, copy);
}

// lastDrilledCard renders the "Last proven recoverable" posture tile from the REAL drill-evidence
// trail (console-overview-1). Honest by construction:
//   - read failed as a genuine 404/501 (the durable trail is not wired yet): an engine addition,
//     never a faked date; a real fault (500/network) reads as an engine error, not an unbuilt feature
//     (recoveryReadFailedTile, B39);
//   - read ok but empty: no drill recorded yet, prompt one (the value is a real state);
//   - read ok with entries: the newest dated drill, with its absolute time in the tile title.
// recoveryReadFailedTile renders a recovery posture tile whose engine read FAILED, telling a genuinely
// not-wired route (404/501, an honest engine addition) apart from a real fault (a 500 the engine served
// while broken, or an unreachable network throw). Rendering "Pending engine / Engine addition" for a real
// fault tells the operator the durable trail is an unbuilt future feature when the engine has it and just
// faulted: the B37/B23/B24 pending-vs-broken collapse, here on the overview recovery tiles. `settle()`
// carries the error, so the two cases are distinguishable; a real fault reads as an honest engine error.
export function recoveryReadFailedTile(label: string, error: unknown, pendingSecondary: string): HTMLElement {
  const cls = classifyError(error);
  const notWired = cls.kind === "server" && (cls.status === 404 || cls.status === 501);
  if (notWired) {
    return statTile({
      label,
      value: "Pending engine",
      status: { tone: "neutral", label: "Engine addition" },
      secondary: pendingSecondary,
    });
  }
  return statTile({
    label,
    value: "Could not read",
    status: { tone: "warn", label: "Engine error" },
    secondary: "The engine faulted on this read; it is not an unbuilt feature. Refresh to try again.",
  });
}

function lastDrilledCard(drillEvidence: Settled<DrillEvidenceEntry[]>): HTMLElement {
  if (!drillEvidence.ok) {
    return recoveryReadFailedTile(
      "Last proven recoverable",
      drillEvidence.error,
      "In-session drills work now; the durable dated trail ships with the engine.",
    );
  }
  const newest = newestDrill(drillEvidence.value);
  if (!newest) {
    return statTile({
      label: "Last proven recoverable",
      value: "Not drilled yet",
      status: { tone: "warn", label: "Unproven" },
      secondary: "Run a drill so recovery is demonstrated, not assumed.",
    });
  }
  const kindWord = newest.kind === "offline-rehearsal" ? "Offline rehearsal" : "In-account drill";
  return statTile({
    label: "Last proven recoverable",
    value: relativeTime(newest.recordedAt),
    status: { tone: "trust", label: kindWord },
    secondary: `Newest ${kindWord.toLowerCase()}${newest.recordedBy ? ` by ${newest.recordedBy}` : ""}.`,
    title: absoluteTime(newest.recordedAt),
  });
}

// lastAuditedCard renders the "Last audited" posture tile from the newest audit event (D4). Same
// honest precedence as lastDrilledCard: pending-engine when the chain is not wired, a prompt when
// wired-but-empty, a real timestamp plus the action and its OUTCOME otherwise.
//
// THE OUTCOME IS NOT OPTIONAL HERE, AND LEAVING IT OUT WAS THE DEFECT. This tile used to compose
// "Newest: <action> by <email>." and never read newest.outcome, so a refused action rendered as an
// accomplished one on the first screen an operator sees. Half the closed action vocabulary is
// phrased as a completed deed (a role granted, a downpipe deleted, a recovery code used), so a
// denied role grant read as a granted role and a failed break-glass sign-in read as a break-glass
// sign-in. The sibling audit table has always carried an Outcome column beside the Action one and
// was never wrong; this tile is the only console surface that composed the one without the other.
//
// The badge is deliberately NOT taken from the outcome, which is the opposite call to the one the
// support screen makes about an unreadable expiry, and the reason is who can move it. Half the
// closed action set is written by routes an unauthenticated caller can reach (the break-glass
// recovery sign-in above all), so a danger tone on a single failed row would let anyone on the
// public internet paint a customer's Overview red by mistyping an email. The tile says what the
// newest row was; the posture tiles beside it say whether anything is wrong.
function lastAuditedCard(audit: Settled<AuditEvent[]>): HTMLElement {
  if (!audit.ok) {
    return recoveryReadFailedTile(
      "Last audited",
      audit.error,
      "The tamper-evident audit trail ships with the engine.",
    );
  }
  const newest = audit.value[0] ?? null; // the page is newest-first; we asked for one
  if (!newest) {
    return statTile({
      label: "Last audited",
      value: "No events yet",
      status: { tone: "neutral", label: "Wired" },
      secondary: "Privileged actions are recorded here as they happen.",
    });
  }
  return statTile({
    label: "Last audited",
    value: relativeTime(newest.ts),
    status: { tone: "info", label: "Audit chain" },
    secondary: newestAuditSentence(newest),
    title: absoluteTime(newest.ts),
    // The remedy is REACHABLE, not merely named: a refused row opens the audit log already filtered
    // to that outcome, which is the screen that carries the actor, the source IP and the chain hash.
    // A successful row leaves the tile a plain region, exactly as it has always been.
    ...(newest.outcome === "success"
      ? {}
      : { onActivate: () => navigate(`${ROUTE_AUDIT}?outcome=${newest.outcome}`) }),
  });
}

// auditTileActor decides who this tile is allowed to NAME, and it is the half of the repair that
// outlives the engine fix. `POST /admin/auth/recovery` is unauthenticated by design, and until
// recoveryRecover used to write the caller-supplied email straight into actorEmail on both
// negative branches, so a refused break-glass attempt could carry an address that exists nowhere in
// the account, chosen by whoever typed it. The audit chain is append-only and tamper-evident, so
// every such row an engine has already written stays there for ever and this tile still renders it.
//
// The rule applied here is the engine's OWN, stated on the authn-failure member of the same closed
// union: "No identity is verified on a failure, so the actor fields are null (V16.3.1)". It is what
// routeRecoveryAlert already does inside the same feature, refusing to echo an address it calls "an
// unverified guess we must not echo as if it were a real account".
//
// It is deliberately NARROW. An operator who authenticated and then had an action refused IS a
// verified actor and is still named, because the identity was established before the refusal; only
// the break-glass sign-in path can carry an actor nothing checked. The audit table is left alone
// and shows the raw stored value, which is right: it renders the Outcome in its own column beside
// it, so a reader there has the discriminator this one-line tile does not.
function auditTileActor(e: AuditEvent): string | null {
  if (!e.actorEmail) return null;
  if (e.outcome !== "success" && e.actorMethod === "recovery") return "an unverified address";
  return e.actorEmail;
}

// newestAuditSentence composes the tile's one line. Exported for the validator, which drives it over
// every member of the closed outcome union rather than over the one an estate happens to hold.
//
// The vocabulary is BORROWED, never invented. The action phrase comes from actionLabel, the audit
// log's own tsc-complete Record over the closed action union, and the outcome word from the same
// titleCase the Outcome column and the detail modal's Outcome line print. The private switch that
// used to live here labelled 11 of the union's members and hyphen-stripped the rest, so the Overview
// and the audit log disagreed about what an action was called; three of its 11 arms named actions
// (role-grant, role-revoke, downpipe-update) that are not members of AuditAction at all and no
// engine has ever written. The server-supplied strings still reach the DOM through the h()
// textContent path in statTile, so there is no markup surface.
export function newestAuditSentence(e: AuditEvent): string {
  const who = auditTileActor(e);
  const head = `Newest: ${actionLabel(e.action)}${who === null ? "" : ` by ${who}`}. Outcome: ${titleCase(e.outcome)}`;
  if (e.outcome === "success") return `${head}.`;
  // Denied is refused before the action runs; failed is attempted and unfinished. Saying which is
  // what stops a past-tense action label reading as a completed deed, and the remedy is named
  // because a refusal an operator cannot act on is a refusal that gets ignored.
  const consequence = e.outcome === "denied" ? "so it was not carried out" : "so it did not complete";
  return `${head}, ${consequence}. Open the audit log filtered to ${e.outcome}.`;
}
