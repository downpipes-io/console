// The Licence and updates screen body: render(engine, data, reload) assembles the screen from its loaded
// payload. The calm contract: three eager sections (the tile band, the Licence card
// with the fail-open status plus the folded-in activation action area, and the read-only Updates section
// carrying the one safe-apply interactive control), with the Enterprise services and Provenance bodies
// present collapsed. Fail-open is stated ONCE, in the Licence card, and pull-not-push ONCE, in the Updates
// section, never echoed per section. Moved verbatim from the licence coordinator for size; copy, markup,
// section order and event wiring are unchanged. The section modules are imported one-way; this view never
// imports the coordinator. House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { collapsedSection } from "../common.ts";
import { banner } from "../../components/feedback.ts";
import { badge, statusWithLabel, type StatusTone } from "../../components/status.ts";
import { statTile, statGrid } from "../../components/stat-tiles.ts";
import { dateOnly } from "../../lib/format.ts";
import { LICENCE_ACCOUNT_MISMATCH_LINE, LICENCE_ACCOUNT_UNKNOWN_LINE, LICENCE_STAMP_UNREADABLE_LINE, licenceAccountMismatch, licenceAccountUnknown, licenceExpired, licenceStampUnreadable, renewalNotice, tierDisplayName } from "../../lib/billing.ts";
import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import { consoleVersion } from "../../lib/console-version.ts";
import { recordConsoleBuildCheck } from "../../lib/client-diag/ring.ts";
import {
  type LicenceData,
  LICENCE_CARD_HEADING_ID,
  UPDATES_HEADING_ID,
  licenceTileTone,
  licenceTileLabel,
  updateTileTone,
  updateTileValue,
  updateTileLabel,
  signingTileTone,
  signingTileValue,
  signingTileLabel,
  updateControlState,
  consoleUpdateAvailable,
  componentVersionList,
  updateVersionRows,
  lastUpdateSummary,
  standaloneRollbackOffered,
  updateIncident,
  updateUnresolved,
} from "./shared.ts";
import { detailRow, expiredSentence, renewalSentence } from "./detail-rows.ts";
import {
  BAND_MALFORMED_LINE,
  ESTATE_OVER_BAND_LINE,
  ESTATE_UNREADABLE_LINE,
  bandFeaturesMalformed,
  bandSummaryLine,
  estateExceedsBand,
  estateFiguresUnreadable,
  estateSummaryLine,
  parseBandFeatures,
} from "./estate-band.ts";
import { activationSection } from "./activation.ts";
import { renderReleaseMetadata, updateControl } from "./update.ts";
import { rollbackControl, type RollbackUrgentInfo } from "./rollback.ts";
import { renderEnterpriseBody, renderProvenanceBody } from "./provenance.ts";
import type { EngineClient } from "../../api.ts";

// runningUnstampedRecorded latches the running-bundle-unstamped fact to ONE row per session. The build this tab
// is running cannot change while the tab is open, so a second row would be the same fact counted twice, and it
// would land in the same coalesced row that the post-apply checks are read out of.
let runningUnstampedRecorded = false;

export function render(engine: EngineClient, data: LicenceData, reload: () => void | Promise<void>): HTMLElement {
  const wrap = h("div");
  // Fail-open is absolute: every state reassures the data path is never gated.
  // A community/invalid licence is a fully working state, not a problem.
  const isEnterprise = data.licence.tier === "enterprise";
  // The console-component update verdict (multi-component P1): the engine's components map vs THIS
  // bundle's baked version. Honestly false on an old engine (no map) and on an unstamped build.
  const ownVersion = consoleVersion();
  // An unstamped running bundle silently blinds this verdict. With no version to compare,
  // consoleUpdateAvailable is false however far behind the running console actually is, so the screen reads "up to
  // date" two releases late and the pack shows a console that agrees with it.
  //
  // THE CLASS IS `running-unstamped`, NOT `unstamped`, AND THAT IS THE WHOLE FIX. This is a fact about THE BUNDLE
  // THIS TAB IS RUNNING (no baked __CONSOLE_VERSION__ define). The post-apply check's `unstamped` is a fact about
  // what THE ORIGIN just served. console-version.ts calls them "two distinct questions, deliberately separated",
  // and until now the ring re-merged them: both pushed {console-build-check, updates, unstamped}, the tuple key
  // coalesced them into one row, and support could not tell "the update verdict was computed blind, no apply ever
  // happened" from "an apply landed assets carrying no stamp". Different remedies, same row.
  //
  // LATCHED ONCE PER SESSION. It used to fire on EVERY licence render, so ordinary repeat visits inflated the
  // count and destroyed any reading of how many post-apply checks actually failed. It is a fact about the build,
  // and a build does not change while the tab is open: stating it once is stating it exactly as often as it is
  // true.
  if (ownVersion === null && !runningUnstampedRecorded) {
    runningUnstampedRecorded = true;
    recordConsoleBuildCheck("running-unstamped");
  }
  const consoleUpd = consoleUpdateAvailable(data.updates, ownVersion);
  // The three eager sections (calm-density §7a) in order, then the collapsed bodies.
  wrap.appendChild(summaryBand(data, consoleUpd));
  wrap.appendChild(licenceCard(engine, data, reload, isEnterprise));
  wrap.appendChild(updatesSection(engine, data, reload, consoleUpd));
  wrap.appendChild(demotedSections(data, isEnterprise));
  return wrap;
}

// --- Summary band -----------------------------------------------------------
// Three tiles: licence tier/state, update status, update signing. Status by
// shape+label, not colour alone. Fail-open and the signer scheme are taught in
// their owning sections (Licence card, Provenance), not repeated here.
// consoleUpd is the SPA's own console-component verdict (multi-component P1), so
// a console-only release still reads "Available"; false on every old engine.
function summaryBand(data: LicenceData, consoleUpd: boolean): HTMLElement {
  // A RECORDED failed rollback outranks every other update fact here: in that state the engine is running
  // exactly the version the channel recommends, so updateAvailable is false and this tile used to read a
  // green "Up to date" over an engine serving a build its own canary rejected.
  const unresolved = updateUnresolved(data.updateState);
  // .lic-tiles applies the 3-up tile sizing to the stat grid within.
  return h(
    "div",
    { class: "lic-tiles", style: "margin-bottom:var(--space-5)" },
    statGrid(
      statTile({
        label: "Licence tier",
        value: tierDisplayName(data.licence.tier),
        status: {
          tone: licenceTileTone(data.licence),
          label: licenceTileLabel(data.licence),
        },
      }),
      statTile({
        label: "Update status",
        value: updateTileValue(data.updates, consoleUpd, unresolved),
        status: {
          tone: updateTileTone(data.updates, consoleUpd, unresolved),
          label: updateTileLabel(data.updates, consoleUpd, unresolved),
        },
        secondary: data.updates.currentVersion,
      }),
      statTile({
        label: "Update signing",
        value: signingTileValue(data.updates),
        status: {
          tone: signingTileTone(data.updates),
          label: signingTileLabel(data.updates),
        },
      }),
    ),
  );
}

// --- Licence card -----------------------------------------------------------
// The fail-open statement (once for the screen), tier-aware detail rows and the
// folded-in Activate licence action area (§7a: a status and its one action are
// one object).
function licenceCard(engine: EngineClient, data: LicenceData, reload: () => void | Promise<void>, isEnterprise: boolean): HTMLElement {
  // The renewal note is computed from notAfter for a time-boxed paid tier; null for
  // Community (no expiry) or an absent/unparseable notAfter. It drives the renewal
  // sentence (which carries the re-pin instruction) and the amber "Renews soon" badge.
  const renewal = renewalNotice(data.licence);
  // Whether this licence has LAPSED, asked of the engine's closed reasonCode rather than inferred from the
  // tier, which the engine sets to "community" for every fail-open cause including this one.
  const expired = licenceExpired(data.licence);

  const lic = h("div", { class: "card measure" });
  const licHeader = h(
    "div",
    { class: "card__header" },
    // tabindex=-1 makes the heading a programmatic focus target (a11y): after a successful Activate /
    // Replace / Remove the handler reloads the region (dropping focus to <body>); the activation section
    // moves focus back here so a keyboard/screen-reader user is not stranded at the top of the document.
    h("h2", { class: "card__title", id: LICENCE_CARD_HEADING_ID, tabindex: "-1" }, "Licence"),
    data.licence.valid
      ? badge("ok", `${tierDisplayName(data.licence.tier)}, valid`)
      : badge("default", `${tierDisplayName(data.licence.tier)}`),
  );
  // Renews-soon is an amber cue ALONGSIDE the tier badge (status by shape + label, not
  // colour alone): the operator should be ready to re-pin the renewed token. Never alarming
  // since fail-open holds regardless; it is a heads-up, not a fault.
  if (renewal?.renewsSoon) licHeader.appendChild(badge("warn", "Renews soon", { dot: true }));
  lic.appendChild(licHeader);

  // Fail-open is stated HERE, once for the whole screen (the header, the tile band
  // and the Provenance section no longer echo it); the full security-feature list
  // lives only in the Enterprise services section below.
  lic.appendChild(
    h(
      "p",
      { style: "color:var(--text)" },
      "A licence never gates the data or recovery path: backups and restores work at every tier. Community is the full product, security included; Enterprise adds services and assurance, not features.",
    ),
  );

  // THE LICENCE WAS MINTED FOR ANOTHER ACCOUNT. The engine has computed this verdict and shipped it on
  // every licence read since the field existed, and this console had no reference to it at all: a token
  // issued against someone else's Cloudflare account was stored, reported as the tier it names, and
  // confirmed to the operator as activated, with nothing anywhere saying it was the wrong licence.
  //
  // A WARN BANNER RATHER THAN A QUIET HINT, and it does not breach the no-notice-stacking rule. The
  // malformed-band and unreadable-stamp lines below are quiet because they say the console could not READ
  // a value; this one says the value was read perfectly and is about a different account, which is the one
  // fact on this card the operator is being told something false about. It cannot stack with the expired
  // banner above either: the engine's expiry branch returns before the account comparison is made, so a
  // licence can carry an expiry verdict or an account verdict, never both.
  if (licenceAccountMismatch(data.licence)) {
    lic.appendChild(banner({ tone: "warn", message: LICENCE_ACCOUNT_MISMATCH_LINE }));
  } else if (licenceAccountUnknown(data.status.cfAccountId)) {
    // THE ENGINE HAS NOT IDENTIFIED ITS OWN ACCOUNT YET, the state GET /admin/status's cfAccountId
    // being absent leaves. Before this the card
    // said nothing here, which read exactly like "binding does not apply" or "binding already
    // happened" -- indistinguishable from a fresh deployment's operator. A quiet hint, not a banner:
    // like the malformed-band and unreadable-stamp lines below, it says the console could not read a
    // value yet, not that something is wrong. Mutually exclusive with the mismatch banner above by
    // construction: the engine only computes accountClaimMatchesEngine (what the mismatch reads) once
    // it already knows its own account, which is the exact condition licenceAccountUnknown checks the
    // absence of.
    lic.appendChild(h("p", { class: "field__hint" }, LICENCE_ACCOUNT_UNKNOWN_LINE));
  }

  // Renewal awareness (enterprise): ONE plain-words line carrying the validity date
  // and, when the renewal is near, the re-pin instruction (the amber header badge is
  // the cue; a third telling via a banner was notice stacking). The expired state
  // keeps its info banner: that is the moment reassurance is action-relevant.
  if (isEnterprise && renewal) {
    lic.appendChild(renewalSentence(renewal));
  }

  // THE EXPIRY BANNER, GATED ON EXPIRY. It used to sit inside the branch above, behind
  // `tier === "enterprise"`, and the engine resolves an expired licence to tier "community" (its fail-open
  // path funnels every reason code through one community() helper). So the banner about an expired licence
  // was unreachable by the one customer whose licence had expired, and reachable only by a fixture. It now
  // reads licenceExpired, which asks reasonCode, the closed discriminator the engine actually sends.
  //
  // The copy no longer names Enterprise, because on this path the console cannot know the tier: the engine
  // drops features[] on expiry and reports community, so the only things it still says about the token are
  // its lapsed date and where it came from. Naming a tier here would be a guess printed as a fact.
  if (expired && renewal) {
    lic.appendChild(expiredSentence(renewal));
    // Honest, fail-open framing: an expired licence does not gate anything. The engine answers community;
    // backups and restores continue. The operator re-activates to restore the paid services and assurance,
    // not to unlock the product.
    lic.appendChild(
      banner({
        tone: "info",
        message:
          "This licence token has passed its validity date. Fail-open holds: nothing is gated, backups and restores continue exactly as before, and the engine reports the Community tier. Paste the renewed licence token under Activate licence below to restore the paid services and assurance.",
      }),
    );
  }

  // Volume-based licensing (self-serve tiers): two quiet plain-text lines, calm-density budget
  // -- no colour, no badge, no motion, no link, nothing that implies the
  // licence gates anything (fail-open holds regardless of estate or band). The estate line renders
  // whenever the engine reports a measured estate; the band line renders only when the token's
  // features[] carry a COMPLETE band triple (parseBandFeatures is all-or-nothing: a missing or
  // malformed piece withholds the whole line, never a partially-guessed one); the over-band line
  // follows the band line, and only it, when the measured estate has genuinely grown past it.
  const estateLine = estateSummaryLine(data.licence.estate);
  if (estateLine) lic.appendChild(h("p", { style: "color:var(--text)" }, estateLine));
  // A withheld line and a MALFORMED one used to render identically (both simply absent), so a
  // mis-minted licence or a corrupted estate figure read as an ordinary quiet card. Name the fault
  // instead: the console never renders the malformed value, only the fact that it could not be read.
  // The malformed estate figures ride in the pack raw and NOTHING
  // flags them, so neither the bot nor a support engineer is prompted to look at a card that reads as an
  // ordinary quiet one. The console already has the honest verdict on screen; this puts it in the bundle.
  else if (estateFiguresUnreadable(data.licence.estate)) {
    recordWireAnomaly("estate-figure", "non-finite");
    lic.appendChild(h("p", { class: "field__hint" }, ESTATE_UNREADABLE_LINE));
  }
  const band = parseBandFeatures(data.licence.features);
  if (band) {
    lic.appendChild(h("p", { style: "color:var(--text)" }, bandSummaryLine(band)));
    if (estateExceedsBand(data.licence.estate, band)) {
      lic.appendChild(h("p", { style: "color:var(--text)" }, ESTATE_OVER_BAND_LINE));
    }
  } else if (bandFeaturesMalformed(data.licence.features)) {
    // A MIS-MINTED volume licence, whose band triple fails the all-or-nothing parse. Its band line and its
    // over-band nudge never render, so it looks exactly like an ordinary token with no band at all, and the bot
    // drops licence.features entirely. Its own field class, not a shared "licence" one: a mis-minted token is a
    // BILLING fault and an unparseable notAfter is a RENEWAL fault, and they go to different people.
    recordWireAnomaly("licence-band", "unparseable");
    lic.appendChild(h("p", { class: "field__hint" }, BAND_MALFORMED_LINE));
  }
  // An unparseable notAfter silently disarms the whole renewal machinery (renewalNotice returns null,
  // so there is no renews-soon cue and no expired cue), which is the exact shape of a healthy licence.
  // Say that the date cannot be read, so nobody waits for a warning that can never fire.
  // An unparseable notAfter silently DISARMS the whole renews-soon machinery, and a
  // disarmed warning is indistinguishable from a licence that is simply not near its expiry, which is why "we
  // never saw a renewal warning before our Enterprise token lapsed" has never been answerable from the pack.
  if (licenceStampUnreadable(data.licence)) {
    recordWireAnomaly("licence-not-after", "unparseable");
    lic.appendChild(h("p", { class: "field__hint" }, LICENCE_STAMP_UNREADABLE_LINE));
  }

  // Detail rows. notAfter renders as a clean UTC date via the shared formatter (it falls
  // back to the raw string only if it does not parse, so a non-standard value still shows).
  // The label is tier-aware so a non-enterprise token carrying a notAfter never reads as the
  // free tier expiring: Enterprise is time-boxed ("Valid until"); any other tier labels the
  // stamp neutrally ("Token stamped until"), because Community fails open and never lapses.
  // When the renewal sentence above already stated the validity date, the row would say the
  // same date twice on one card, so it is skipped in that case.
  // The expired sentence above states the same date, so the row is skipped on that path too; without the
  // second clause an expired licence said its lapsed date twice on one card, once as a sentence and once
  // under a "Token stamped until" label that reads as though nothing had happened.
  if (data.licence.notAfter && !(isEnterprise && renewal) && !(expired && renewal)) lic.appendChild(detailRow(isEnterprise ? "Valid until" : "Token stamped until", dateOnly(data.licence.notAfter) || data.licence.notAfter));
  if (data.licence.reason) lic.appendChild(detailRow("Note", data.licence.reason));
  if (data.licence.features?.length) lic.appendChild(detailRow("Features", data.licence.features.join(", ")));

  // --- Activate licence (the Licence card's action area, §7a) ---------------
  // The portal activation path (the no-customer-CLI rule): paste the licence token from the activation
  // email and the engine verifies it live against the pinned vendor signer and stores it in the scheduler
  // DO (no Worker secret, no redeploy). It is FOLDED INTO the Licence card as its action area (under a
  // hairline + a sub-heading) rather than a separate adjacent card, so the screen keeps its three eager
  // sections (calm-density §7a): a licence status and its one action belong to the same object. Owner-gated
  // to mirror the engine's keys.ceremony gate; a non-owner still sees the control disabled-with-reason (the
  // engine is the enforcement point). Calm density holds (no ambient effects, no notice stacking, one
  // inline error channel). The focusAnchorId is the Licence card heading, refocused after a reload.
  lic.appendChild(h("hr", { style: "border:none;border-top:1px solid var(--border-subtle);margin:var(--space-4) 0" }));
  lic.appendChild(activationSection(engine, data.licence, reload, LICENCE_CARD_HEADING_ID, data.status.cfAccountId));
  return lic;
}

// --- Updates section --------------------------------------------------------
// An unboxed section (7a: boxes are for interactive objects; this is read-only
// facts). The status line says "Update available" when one is, no extra banner
// restating it one line below. Pull-not-push is stated here, once for the screen.
// consoleUpd folds the console-component verdict into the status line + the
// control-state decision, so a console-only release surfaces the apply control.
function updatesSection(engine: EngineClient, data: LicenceData, reload: () => void, consoleUpd: boolean): HTMLElement {
  const upd = h("section", { class: "measure", style: "margin-top:var(--space-5)" });
  // The heading is the ?open=updates deep-link target (the shell's update chip): a stable id plus
  // tabindex=-1 so the coordinator can scroll to and focus it (the LICENCE_CARD_HEADING_ID idiom).
  upd.appendChild(h("h2", { class: "section-title", id: UPDATES_HEADING_ID, tabindex: "-1" }, "Updates"));

  // Same incident precedence as the tile band: the section's own status line must not read "Nothing pending"
  // while the engine is live on a version whose rollback failed.
  const incident = updateIncident(data.updateState);
  const unresolved = updateUnresolved(data.updateState);
  const updTone: StatusTone = updateTileTone(data.updates, consoleUpd, unresolved);
  const updLabel = updateTileLabel(data.updates, consoleUpd, unresolved);
  upd.appendChild(h("div", { style: "margin:var(--space-3) 0" }, statusWithLabel(updTone, updLabel)));

  // Per-component version state -- NEVER a single "platform version". The engine and the console version
  // INDEPENDENTLY, so a lone number cannot say which it refers to; each component states its own running
  // version and verdict ("Engine 0.1.7 -> 0.1.9", "Console 0.1.9 -- up to date"). These are the SAME rows
  // the apply control acts on, so the read-only facts and the apply surface can never disagree.
  upd.appendChild(componentVersionList(updateVersionRows(data.updates, consoleVersion())));
  if (data.updates.notes) upd.appendChild(detailRow("Notes", data.updates.notes));
  if (data.updates.reason) upd.appendChild(detailRow("Reason", data.updates.reason));

  upd.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Updates are pull-not-push and signature-pinned: the engine pulls a vendor-signed channel in your account and verifies it against a pinned release signer (post-quantum hybrid: Ed25519 with ML-DSA-87). Nothing is auto-pushed; applying is an operator-driven redeploy after you review the version and its provenance.",
    ),
  );

  // Rich release metadata: the signed channel's changelog / impact / required steps / risk class / compat
  // for an AVAILABLE update, so the operator reads "what's in this update" (and a migration/breaking release is
  // rendered with care) before committing. Read-only; renders nothing when there is no available update.
  const releaseBlock = renderReleaseMetadata(data.updates);
  if (releaseBlock) upd.appendChild(releaseBlock);

  // The compact "Last update: …" line (a controlled rollback reads as the safety net working, never an
  // alarm). One quiet line, in the read-only facts; it is omitted entirely when there is nothing to show.
  const lastLine = lastUpdateSummary(data.updateState);
  if (lastLine) upd.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, lastLine));

  // URGENT one-click rollback (engine FOLD 1): when the hourly canary found a promoted-but-unsettled new version
  // UNHEALTHY, the engine records rollbackNeeded (it holds no deploy credential, so it cannot revert itself).
  // Surface it PROMINENTLY, above the normal apply control, as a first-class rollback the owner completes in one
  // click. It outranks an available update (fix the live engine first). Owner-gated; the engine enforces.
  //
  // AND the second incident, which had no surface at all. A settle that records "rollback-failed" writes
  // pending:null and carries NO rollbackNeeded forward (setUpdateSettled's engine branch clears it, because
  // settling normally does resolve the flag), so every signal this section reads said there was nothing to
  // show while the engine served the rejected build. updateIncident derives it from the recorded outcome.
  const rollbackNeeded = data.updateState?.rollbackNeeded ?? null;
  const urgentInfo: RollbackUrgentInfo | null = rollbackNeeded
    ? { cause: "canary", recommendedVersion: rollbackNeeded.recommendedVersion, toVersion: rollbackNeeded.toVersion, canaryVerdict: rollbackNeeded.canaryVerdict, at: rollbackNeeded.at }
    : incident
      ? { cause: "rollback-failed", onVersion: incident.onVersion, target: incident.target, reason: incident.reason }
      : null;
  if (urgentInfo) upd.appendChild(rollbackControl(engine, { urgent: true, info: urgentInfo }, reload));

  // The safe-apply control (the ONE interactive object in this otherwise read-only section). It renders only
  // when an update is available (an engine update, OR a console-component update this bundle can see) OR a
  // prior promote is awaiting verification (updateControlState); otherwise the Updates section stays purely
  // the read-only facts above (§7a: no empty interactive box). Owner-gated (mirrors the engine's
  // keys.ceremony gate) as disabled-with-reason for non-owners; the engine enforces.
  const ctrlState = updateControlState(data.updates, data.updateState, consoleUpd);
  // destConfigured (design s4): reused verbatim from the engine's existing StatusReport.destConfigured fact
  // (already loaded for the tile band above), so a live apply can never be offered with nowhere to fly the
  // canary flight that verifies it.
  if (ctrlState.kind !== "none") upd.appendChild(updateControl(engine, data.updates, ctrlState, reload, data.status.destConfigured));

  // STANDALONE roll back: a first-class "Roll back to the previous version" control, available INDEPENDENT of an
  // in-flight apply (so the owner can revert a quietly-bad version any time), as long as there is a recorded
  // prior version to go back to. It is omitted only when it would be a guaranteed no-target: nothing has been
  // applied/rolled-back from here yet (no `last` outcome) AND nothing is pending/needing rollback, in that case
  // the engine has no known-good target and the control would always refuse, so §7a says don't render it. When
  // the urgent rollbackNeeded control is already shown above, this standalone one is suppressed (one rollback
  // affordance, not two). Owner-gated; the engine enforces and is the authority on whether a target exists.
  if (!urgentInfo && standaloneRollbackOffered(data.updateState)) {
    upd.appendChild(rollbackControl(engine, { urgent: false }, reload));
  }
  return upd;
}

// --- Demoted sections -------------------------------------------------------
// Enterprise services (community/pro only) and Provenance present collapsed
// (collapsedSection: the bodies render now, so find-in-page still works). The
// Provenance section carries a stable id for deep-linking.
function demotedSections(data: LicenceData, isEnterprise: boolean): HTMLElement {
  const demoted = h("div", { class: "stack-sm measure", style: "margin-top:var(--space-5)" });
  if (!isEnterprise) demoted.appendChild(collapsedSection("Enterprise services", renderEnterpriseBody()));
  const provenance = collapsedSection("Provenance", renderProvenanceBody(data));
  provenance.id = "provenance";
  demoted.appendChild(provenance);
  return demoted;
}
