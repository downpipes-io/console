// Overview (IA screen 1) status tiles, banners and the protection lead line. Each tile
// resolves its own success / unknown (never a stale green); the fleet banner is loud by
// default and not dismissible until resolved; the protection lead reuses the SAME
// fleetProtection generator the downpipes screen subtitles with. Moved verbatim out of
// overview.ts for size. House rules: Australian English, no em dashes, precise claims.

import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { h, frag, type Child } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { banner } from "../../components/feedback.ts";
import { statTile, statGrid } from "../../components/stat-tiles.ts";
import type { SparklineOptions } from "../../components/sparkline.ts";
import type { StatusTone } from "../../components/status.ts";
import { tierDisplayName } from "../../lib/billing.ts";
import { relativeTime, absoluteTime, dateOnly } from "../../lib/format.ts";
import { fleetProtection, destinationFromStatus, type ProtectionTone } from "../../lib/protection-statement.ts";
// The ONE version-skew decision, shared with the Licence card's update tile (lib/update-skew.ts).
import { skewUncomparable, SKEW_UNCOMPARABLE_VALUE, SKEW_UNCOMPARABLE_LABEL, SKEW_UNCOMPARABLE_SECONDARY } from "../../lib/update-skew.ts";
import type {
  StatusReport,
  LicenceStatus,
  UpdateStatus,
} from "../../api.ts";
import { plural, type Settled, type OverviewData, type FleetSummary } from "./shared.ts";

// Presentation dimensions for the recovery-posture tile sparkline (CSS pixels).
const RECOVERY_SPARK_WIDTH = 132;
const RECOVERY_SPARK_HEIGHT = 28;

// buildProtectionLead renders the plain-English protection lead line: the fleet protection summary
// (worst-tone hued dot + the one true sentence) and the blunt fleet not-covered line beneath it. It
// reads the live downpipe list + the engine destination from status (honest unknown when either
// could not be read), and uses the SAME fleetProtection generator the downpipes screen subtitles
// with, so the two surfaces cannot disagree. Every string reaches the DOM via the h() textContent
// path; the dot is a class, not colour alone, paired with the label. No <style> is injected.
export function buildProtectionLead(data: OverviewData): HTMLElement {
  // Null-defensive: a PARTIAL response can settle ok:true yet carry an undefined value (the type
  // promises DownpipeState[]; the wire does not). Treat a missing list exactly like an unread one
  // so fleetProtection never throws on states.length AND the lead never falsely reads "nothing
  // configured" off an absent list; it shows the honest unknown instead (OBS-CONSOLE-1).
  const states = data.downpipes.ok ? data.downpipes.value : undefined;
  const status = data.status.ok ? data.status.value : null;
  // When the downpipe list itself could not be read, do not assert a protection posture from an
  // empty list (that would falsely read "nothing configured"); say so honestly instead.
  if (!data.downpipes.ok || states === undefined) {
    return h(
      "div",
      { class: "card card--inset", role: "region", "aria-label": "Protection statement", style: "display:flex;align-items:flex-start;gap:var(--space-3);margin-bottom:var(--space-4)" },
      h("span", { class: "dot dot--neutral", "aria-hidden": "true", style: "margin-top:6px;flex:none" }),
      h(
        "div",
        { style: "min-width:0" },
        // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the fleet
        // health read), set on an INLINE span wrapping the summary TEXT so the "?" sits just to the right of the
        // words, not at the page edge. No behaviour; no effect on the genuine console.
        h("p", { style: "font-weight:var(--weight-medium)" }, h("span", { dataset: { tourId: "overview-fleet-health" } }, "Protection posture could not be read: the engine did not return the downpipe list.")),
        h("p", { class: "field__hint", style: "margin-top:2px" }, "This is an honest unknown, not a claim that nothing is protected. Retry, or check the engine connection."),
      ),
    );
  }
  const dest = destinationFromStatus(status);
  const fp = fleetProtection(states, dest);
  const tone = protectionToneToStatus(fp.tone);
  // When the only gap is proof (everything IS being backed up), the sub-line carries a direct
  // route to the downpipe(s) with the gap, so the read ends in the action that closes it.
  const proofGapCount = fp.counts.uncovered === 0 ? fp.counts.unproven + fp.counts.partial : 0;
  return h(
    "div",
    { class: "card card--inset", role: "region", "aria-label": "Protection statement", style: "display:flex;align-items:flex-start;gap:var(--space-3);margin-bottom:var(--space-4)" },
    h("span", { class: `dot dot--${tone}`, "aria-hidden": "true", style: "margin-top:6px;flex:none" }),
    h(
      "div",
      { style: "min-width:0" },
      // data-tour-id on an INLINE span wrapping the summary TEXT (see above): the "?" sits beside the words.
      h("p", { style: "font-weight:var(--weight-medium)" }, h("span", { dataset: { tourId: "overview-fleet-health" } }, fp.summary)),
      h(
        "p",
        { class: "field__hint", style: "margin-top:2px" },
        proofGapCount > 0 ? `${fp.notCovered} ` : fp.notCovered,
        proofGapCount > 0
          ? h(
              "button",
              { "data-dp": "overview.button.navigate-downpipes#2", class: "linklike", type: "button", on: { click: () => navigate("/downpipes") } },
              proofGapCount === 1 ? "View the downpipe" : "View the downpipes",
            )
          : null,
      ),
    ),
  );
}

// protectionToneToStatus maps the protection tone to the status-dot tone vocabulary: covered = ok,
// partial = warn, unproven = warn (a backed-up-but-unproven downpipe is a real gap), uncovered =
// danger (nothing is being protected). Never maps unproven/uncovered to ok (the honesty floor).
//
// unreadable = NEUTRAL, which is this product's honest could-not-tell hue and not a reassurance: a refused
// read and a brand-new estate both wear it and both tell the truth. It is deliberately not `warn` and not
// `danger`, because a hue that shouts is a claim about the backup, and the console has no such claim to
// make about a row it could not parse. The words beside the dot carry the whole finding; the dot only
// declines to paint it green, which is the one thing it must never do here.
function protectionToneToStatus(tone: ProtectionTone): StatusTone {
  switch (tone) {
    case "covered": return "ok";
    case "partial": return "warn";
    case "unproven": return "warn";
    case "uncovered": return "danger";
    case "unreadable": return "neutral";
  }
}

// ---- tiles ------------------------------------------------------------------

export function buildTiles(data: OverviewData, fleet: FleetSummary): HTMLElement {
  return statGrid(
    engineTile(data.health),
    configTile(data.status),
    licenceTile(data.licence),
    updatesTile(data.updates),
    recoveryTile(data, fleet),
  );
}

function engineTile(health: Settled<{ ok: boolean; service?: string }>): HTMLElement {
  if (!health.ok) {
    // An unauthenticated health read failing is honest unknown (could be mid-deploy or
    // the Access redirect), never a green tick.
    return statTile({ label: "Engine health", state: "unknown" });
  }
  const h0 = health.value;
  return statTile({
    label: "Engine health",
    value: h0.ok ? "Healthy" : "Unhealthy",
    status: h0.ok ? { tone: "ok", label: "Live" } : { tone: "danger", label: "Down" },
    secondary: h0.service ?? "downpipe engine",
  });
}

function configTile(status: Settled<StatusReport>): HTMLElement {
  if (!status.ok) return statTile({ label: "Configuration", state: "unknown" });
  const s = status.value;
  // PRESENCE wording, never "valid". ready = signer && break-glass && destination present.
  // The gaps are named in owner words (this tile may be the first place the nouns appear),
  // and the read is visible text only: a hover title is invisible to keyboard and touch.
  // A flag that is FALSE is a named gap; a flag that is ABSENT is a gap this console was not told about,
  // and folding the two together is what produced the sentence "Missing: . Open to fix." on a status
  // payload that carried `ready` but none of the three sub-flags. That sentence names nothing while
  // asserting something is missing, and it routed to the onboarding key ceremony, which may not be the
  // gap at all. An absent flag is now counted separately so the tile can say it cannot name the gap.
  const missing: string[] = [];
  let unreported = 0;
  const gap = (flag: boolean | undefined, word: string): void => {
    if (flag === undefined) unreported++;
    else if (!flag) missing.push(word);
  };
  gap(s.signerConfigured, "signing key");
  gap(s.breakGlassConfigured, "break-glass recovery key");
  gap(s.destConfigured, "destination");
  // Not-ready is ACTIONABLE, never a dead warning light (first-owner walkthrough
  // finding): the tile routes to what fixes it (the Destinations screen when the
  // destination is the gap, else the onboarding guide that owns the key ceremony).
  return statTile({
    label: "Configuration",
    value: s.ready ? "Ready" : "Not ready",
    status: s.ready ? { tone: "ok", label: "Present" } : { tone: "warn", label: "Incomplete" },
    secondary: s.ready
      ? "Signer, break-glass and destination present"
      : missing.length > 0
        ? `Missing: ${missing.join(", ")}. Open to fix.`
        : unreported > 0
          // The engine said it is not ready and named none of the three parts, so the tile says exactly
          // that instead of printing an empty list. The route is deliberately the onboarding guide, which
          // walks all three, because with nothing named there is no gap to route to.
          ? "The engine reports it is not ready but did not say which parts are missing. Open the setup guide to check the signer, the break-glass key and the destination."
          : "The engine reports it is not ready, though it reports the signer, the break-glass key and the destination all present. Open the setup guide to check.",
    ...(s.ready ? {} : { onActivate: () => navigate(!s.destConfigured && s.signerConfigured && s.breakGlassConfigured ? "/destinations" : "/onboarding/connect") }),
  });
}

function licenceTile(licence: Settled<LicenceStatus>): HTMLElement {
  // tagTour stamps the inert data-tour-id hook the public page-walkthrough tour pins a "?" info-point to (the
  // fail-open licence). No behaviour; no effect on the genuine console.
  const tagTour = (tile: HTMLElement): HTMLElement => { tile.dataset.tourId = "overview-licence"; return tile; };
  if (!licence.ok) {
    // A licence read failing still reassures the data path is unaffected; the licence
    // never gates anything, so this is neutral, not a warning.
    return tagTour(statTile({
      label: "Licence",
      value: "Unknown",
      status: { tone: "neutral", label: "Unreachable" },
      secondary: "A licence never gates the data or recovery path.",
    }));
  }
  // Null-defensive: a PARTIAL engine response can settle ok:true with an undefined/partial
  // value (the type promises LicenceStatus; the wire does not). Default the tier to
  // "community" and treat a missing valid flag as fail-open so the tile degrades to an honest
  // neutral reading instead of throwing on l.tier and blanking the overview.
  const l = licence.value as LicenceStatus | undefined;
  // The read SETTLED ok and the payload carried no tier, so a PAYING customer's tile reads "Community /
  // Fail-open" off a defensive default. The defaulting is right (a thrown tile blanks the whole Overview) and the
  // SILENCE is the bug: an engine-console contract break is a genuine DEFECT SIGNAL, and today it is byte-for-byte
  // identical to an ordinary community licence. Recorded only when the read SUCCEEDED and the field is absent: an
  // unread licence is the ok:false branch above and is not a contract break.
  if (l === undefined || l.tier === undefined) recordContractSkew("missing-field", "licence-payload");
  const tier = tierDisplayName(l?.tier ?? "community") || "Community";
  const valid = l?.valid === true;
  // A community/invalid licence is NEUTRAL (a warning would falsely imply a data-path
  // problem). The fail-open reassurance renders only in the branches that need it (the
  // unreachable read above, the fail-open state here); a valid Active licence carries
  // the renewal fact, not standing reassurance.
  return tagTour(statTile({
    label: "Licence",
    value: tier,
    status: { tone: valid ? "ok" : "neutral", label: valid ? "Active" : "Fail-open" },
    ...(valid
      ? (l?.notAfter ? { secondary: `Valid until ${dateOnly(l.notAfter)}.` } : {})
      : { secondary: "A licence never gates the data or recovery path." }),
  }));
}

function updatesTile(updates: Settled<UpdateStatus>): HTMLElement {
  if (!updates.ok) return statTile({ label: "Updates", state: "unknown" });
  const u = updates.value;
  let value: string;
  let status: { tone: StatusTone; label: string };
  let secondary: Child;
  if (u.updateAvailable) {
    // The pull-not-push / signature-pinned explanation lives on /licence (the screen
    // the needs-attention item opens), not as standing prose on the tile.
    value = "Update available";
    status = { tone: "info", label: u.recommendedVersion ?? "available" };
    secondary = `Running ${u.currentVersion}.`;
  } else if (!u.configured) {
    value = "Not configured";
    status = { tone: "neutral", label: "Off" };
    secondary = "The update channel is not configured.";
  } else if (!u.verified) {
    value = "Unverified";
    status = { tone: "warn", label: "Check" };
    secondary = u.reason ? `Configured, could not verify: ${u.reason}` : "Configured, could not verify.";
  } else if (skewUncomparable(u)) {
    // A COULD-NOT-CHECK OUTRANKS A PASS, and this arm is the whole reason it is here. The engine could not
    // read one of the two version strings, so updateAvailable is false for a reason that has nothing to do
    // with being current, and configured and verified are both true. Without this arm the tile fell through
    // to the healthy branch below and rendered "Up to date / Current / Running <v>." in ok green, BYTE FOR
    // BYTE the answer a genuinely current engine produces. The Licence card has said "Versions cannot be
    // compared" for this exact payload since the skew enum landed; this tile went on disagreeing with it on
    // the screen the operator lands on, which is the calmer of the two and therefore the more damaging.
    // The words come from the shared leaf so the two surfaces cannot drift apart again.
    value = SKEW_UNCOMPARABLE_VALUE;
    status = { tone: "warn", label: SKEW_UNCOMPARABLE_LABEL };
    secondary = SKEW_UNCOMPARABLE_SECONDARY;
  } else {
    value = "Up to date";
    status = { tone: "ok", label: "Current" };
    secondary = `Running ${u.currentVersion}.`;
  }
  return statTile({ label: "Updates", value, status, secondary });
}

function recoveryTile(data: OverviewData, fleet: FleetSummary): HTMLElement {
  // The recovery-point tile is the observability READ of Screen 4. The durable
  // drill-evidence store is engine dependency D4; until it ships the console has no
  // "last proven recoverable" date to show, so the tile reports the recovery-POINT it
  // CAN compute honestly (the age of the newest good backup, from history) and links to
  // the recovery surface, rather than faking a drill date. Named "Recovery point" (its
  // value IS the recovery point), not "Recovery posture": the side column's "Recovery
  // posture" disclosure is a DIFFERENT control and the shared name collided.
  if (!data.history.ok) {
    return statTile({
      label: "Recovery point",
      state: "unknown",
      onActivate: () => navigate("/restore"),
    });
  }
  if (!fleet.anyRuns) {
    return statTile({
      label: "Recovery point",
      value: "No drills yet",
      status: { tone: "neutral", label: "Unproven" },
      secondary: "Run a drill to prove recoverability.",
      onActivate: () => navigate("/restore"),
    });
  }
  // the at-a-glance tile reads the same worst case as the posture card on the recovery
  // surface, so the two cannot disagree about the same fact. It used to read fleet.newestGoodAt,
  // which is the fleet's BEST case, under a label an operator reads as their exposure.
  if (fleet.noGoodBackupCount > 0) {
    const n = fleet.noGoodBackupCount;
    return statTile({
      label: "Recovery point",
      value: "No good backup",
      status: { tone: "warn", label: `${n} of ${fleet.total}` },
      secondary: "Open the recovery surface to see which downpipes have never completed one.",
      onActivate: () => navigate("/restore"),
    });
  }
  const rpo = fleet.worstGoodAt;
  // A small freshness trend across downpipes' newest record counts, as a reassuring
  // (and honest, text-backed) sparkline. statTile renders it (and emits the text
  // alternative); the spark options are built once and handed in. exactOptionalPropertyTypes:
  // spark / title are spread only when present, so an absent value is omitted, not undefined.
  const trend = fleet.rows
    .map((r) => r.lastRecordCount)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const spark: SparklineOptions | undefined = trend.length
    ? { values: trend, tone: "trust", width: RECOVERY_SPARK_WIDTH, height: RECOVERY_SPARK_HEIGHT, label: `Latest record counts across ${trend.length} downpipes.`, withCaption: false }
    : undefined;
  return statTile({
    label: "Recovery point",
    value: rpo ? relativeTime(rpo) : "-",
    // The status pill names the value's source (the tile label now says "Recovery
    // point", so the pill repeating those words would be pure noise).
    status: { tone: rpo ? "trust" : "neutral", label: "Oldest good backup" },
    // The value already carries the time once; the secondary never restates it (the
    // same "2h ago" twice in one tile was pure noise).
    secondary: "Open the recovery surface to drill and export evidence.",
    ...(spark ? { spark } : {}),
    ...(rpo ? { title: absoluteTime(rpo) } : {}),
    onActivate: () => navigate("/restore"),
  });
}

// ---- banners ----------------------------------------------------------------

export function fleetBanner(fleet: FleetSummary): Node {
  // Failed is the loudest (a run that errored), then stale (a backup that went quiet).
  // Both are NOT dismissible until resolved. Disabled is never flagged. Unknown is not a
  // banner (the engine-health tile already reads unknown; a connection check, not a
  // false backup-failure claim, is the first action).
  if (fleet.failed > 0) {
    return banner({
      tone: "danger",
      message: messageWithLink(
        `${fleet.failed} of ${fleet.total} ${plural(fleet.failed, "downpipe")} failed ${fleet.failed === 1 ? "its" : "their"} last run. A failed backup needs attention.`,
        "View failed runs",
        () => navigate("/runs?status=failed"),
      ),
    });
  }
  if (fleet.stale > 0) {
    return banner({
      tone: "warn",
      message: messageWithLink(
        `${fleet.stale} ${plural(fleet.stale, "downpipe")} ${fleet.stale === 1 ? "is" : "are"} stale: the last good backup is older than the expected cadence.`,
        "View stale downpipes",
        () => navigate("/downpipes?status=stale"),
      ),
    });
  }
  // No banner when calm; return an empty fragment so the caller appends nothing.
  return frag();
}

// messageWithLink builds a banner message node with an inline action link (the banner's
// own action button is reserved; an inline link reads better mid-sentence here). The
// link is a real button styled as a link, keyboard operable.
function messageWithLink(text: string, linkLabel: string, onClick: () => void): Node {
  return h(
    "span",
    `${text} `,
    h("button", { "data-dp": "overview.button.click#2", class: "linklike", type: "button", on: { click: onClick } }, linkLabel),
  );
}
