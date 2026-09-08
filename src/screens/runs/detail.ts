// The Runs run-detail drawer: the rich per-run detail the wire shape carries (counts and
// sizes only; no-custody), the verify-at-seal verdict, and the inline Drill (channel one:
// an ok:false is an EXPECTED inline outcome, not a toast). The drill gate is a CLIENT
// MIRROR of the engine's server-side gate (Operator+, shown disabled-with-reason to a
// Viewer); the engine is the enforcement point. After a passing in-account drill it
// records drill evidence best-effort; a missing evidence route never shadows the
// drill result.

import { h, svgIcon } from "../../lib/dom.ts";
import { canCap, capGateReason } from "../common.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { inlineOutcome } from "../../components/error-view.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { badge, runStatusTone } from "../../components/status.ts";
import { openDetailDrawer, drawerSection, kvRow, type DrawerAction } from "../../components/detail-drawer.ts";
import { toast } from "../../components/toast.ts";
import { relativeTime, absoluteTime, groupNumber, humanBytes } from "../../lib/format.ts";
import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import { ICON_DOWNPIPES, ICON_PLAY, ICON_RESTORE } from "../../lib/icons.ts";
import type { EngineClient, DrillResult } from "../../api.ts";
import { type FleetRun, isUnsuccessful } from "./types.ts";
import { BREAK_GLASS_PREFIX, drillEvidenceMissedNote, writeDrillEvidence } from "../restore-flow/shared.ts";
import { humanDuration, sealVerifyDetail, shortfallCount, shortfallReason, runBytes, predecessorLine } from "./helpers.ts";

export function openRunDetail(engine: EngineClient, run: FleetRun): void {
  const { tone, label } = runStatusTone(run.status);
  // The header badge is the ONE status statement (the body carries no duplicate Status row),
  // so the tour's "run-status" info-point pins here.
  const statusBadge = badge(tone, label);
  statusBadge.dataset.tourId = "run-status";
  const body = buildRunDetailBody(run);

  // The drill renders inline in its own section (channel one: an ok:false is an EXPECTED
  // inline outcome, not a toast). The result host is shared with the drill action below.
  const drillResult = h("div");
  body.appendChild(buildDrillSection(run, drillResult));

  // The shared detail drawer (one drawer chrome with the map's flow drawer, one kvRow):
  // the downpipe name is the title, the slug id the mono meta, the status the badge.
  // Closing returns to the list WITH the query string the row carried in, so the
  // operator's filter/facets/sort survive the open-and-close round trip.
  openDetailDrawer({
    title: `${run.downpipeName || run.downpipeId} run ${groupNumber(run.index)}`,
    ...(run.downpipeName && run.downpipeName !== run.downpipeId ? { meta: h("span", { class: "mono" }, run.downpipeId) } : {}),
    badges: [statusBadge],
    body,
    // Keyed by the downpipe id + run index (the SAME pair the deep-linkable route
    // /runs/:downpipeId/:index carries, runs/table.ts's onRowActivate): RunsView.render()
    // builds a fresh view instance every screen.render() call, so its own detailOpened
    // once-only guard (view.ts) resets on an identity-resolved quiet re-render and
    // maybeOpenDeepLink fires openRunDetail a second time while the first drawer from the
    // PREVIOUS view instance is still mounted. run.runId is not used here: it can be an
    // empty string (kvRow's `run.runId || "-"` fallback), so it is not a safe idempotency
    // key on its own (the same fix sources-downpipes/detail.ts already carries).
    key: `runs-detail:${run.downpipeId}:${run.index}`,
    actions: buildRunDetailActions(engine, run, drillResult),
    onClose: () => navigate(`/runs${location.search}`),
  });
}

// The static per-run detail sections (run, throughput, verify-at-seal, failure). The drill
// section is appended separately by the caller because it shares a result host with the
// drill action.
function buildRunDetailBody(run: FleetRun): HTMLElement {
  const body = h("div");

  // The rich per-run detail the wire shape now carries (counts and sizes only;
  // no-custody). An absent optional figure reads "-", never a false zero. The downpipe
  // (name first, slug id demoted to the mono meta), the run index AND the status badge
  // live in the drawer header, so the section does not repeat them.
  // tourTag stamps an inert data-tour-id the public page-walkthrough tour pins a "?" info-point to (the
  // seal verdict, the record + segment counts). No behaviour; no effect on the genuine console.
  const tourTag = (id: string, el: HTMLElement): HTMLElement => { el.dataset.tourId = id; return el; };
  const runSection = drawerSection(
    "Run",
    kvRow("Run id", h("span", { class: "mono" }, run.runId || "-")),
    kvRow("Started", `${relativeTime(run.startedAt)} (${absoluteTime(run.startedAt)})`),
    kvRow("Duration", typeof run.durationMs === "number" ? humanDuration(run.durationMs) : "-"),
  );
  // Predecessor: lets an auditor walk this downpipe's run chain from the console alone,
  // rather than only from the sealed archive's own RUNLOG. Omitted entirely on an engine that has not
  // yet reported a chain verdict for this row (predecessorLine returns null), never shown as a guess.
  const predecessor = predecessorLine(run);
  if (predecessor !== null) runSection.appendChild(kvRow("Predecessor", h("span", { class: "mono" }, predecessor)));
  body.appendChild(runSection);

  const shortfall = shortfallCount(run);
  // Both sizes go through runBytes, so a CORRUPT figure is flagged and read as "no honest figure" rather
  // than walking the `typeof === "number"` guard (typeof NaN is "number") and drawing the same dash an ABSENT
  // figure draws. Read once, used for the has-a-figure test AND for the rows below, so the drawer cannot decide
  // one way and render the other -- and so a corrupt figure cannot record twice on one open.
  const plaintextBytes = runBytes(run.bytes);
  const archiveBytes = runBytes(run.archiveBytesWritten);
  // hasThroughputFigure must ask the same question the rows answer. It used to test `typeof run.bytes ===
  // "number"`, so a FAILED run whose byte figure arrived NaN counted as HAVING a figure: the honest "the run
  // failed before writing" line was suppressed and four dash rows were drawn in its place. That is the mask this
  // gap is named for, on the very screen it names.
  const hasThroughputFigure =
    typeof run.recordCount === "number" ||
    plaintextBytes !== null ||
    archiveBytes !== null ||
    typeof run.segmentsWritten === "number";
  if (isUnsuccessful(run.status) && !hasThroughputFigure) {
    // A run that ended without a success and recorded nothing: one honest line, not four dash rows. An
    // ABANDONED run is the commonest shape of this, because the engine never received a completion at all,
    // and it used to draw the four dashes the failed case was fixed to stop drawing.
    body.appendChild(
      drawerSection("Throughput", h("p", { class: "field__hint" }, run.status === "abandoned"
        ? "No throughput recorded: the engine never received a result for this run."
        : "No throughput recorded: the run failed before writing.")),
    );
  } else {
    const throughput = drawerSection(
      "Throughput",
      kvRow("Records", tourTag("run-records", h("span", typeof run.recordCount === "number" ? groupNumber(run.recordCount) : "-"))),
      // BOTH sizes are guarded. The drawer has two byte fields off ONE RunHistoryEntry, so they share a
      // corruption source; guarding only the archive total left the plaintext-read figure drawing the identical
      // dash for a corrupt value and an absent one, with no row anywhere. runBytes() is also what gates the
      // section's own visibility above, so the raw fields must not be read back here.
      kvRow("Plaintext read", plaintextBytes !== null ? humanBytes(plaintextBytes) : "-"),
      kvRow("Archive written", archiveBytes !== null ? humanBytes(archiveBytes) : "-"),
      // The tour tag wraps the whole ROW, not the value: the spotlight frames the label and the figure together.
      tourTag("run-segments", kvRow("Segments written", h("span", typeof run.segmentsWritten === "number" ? groupNumber(run.segmentsWritten) : "-"))),
    );
    // Records the run is short of the live source (recordsIncomplete + recordsSkipped + recordsVanished):
    // shown as its own row ONLY when the total is non-zero, so a fully captured run (0 on all three) does not
    // show a fabricated zero. The kind breakdown rides in the outcome below.
    if (shortfall > 0) throughput.appendChild(kvRow("Not fully captured", groupNumber(shortfall)));
    body.appendChild(throughput);
  }

  // A run short of the live source is not a clean success: state it loudly and calmly under the throughput,
  // with no soothing line, and name WHICH kinds were short (partial seal / could not be captured / vanished
  // mid-crawl) so the operator knows what churned before relying on this run for a restore.
  if (shortfall > 0) {
    body.appendChild(
      inlineOutcome({
        heading: "This backup is not fully captured",
        reason: `This run is short of the live source: ${shortfallReason(run)}. The archive is not a full copy for ${shortfall === 1 ? "that record" : "those records"}, so investigate before relying on this run for a full restore.`,
      }),
    );
  }

  // Verify-at-seal verdict (the engine reads the just-written archive back and verifies it before
  // reporting the run a clean success). Rendered only when the run carries the field; an older run
  // sealed before verify-at-seal shows nothing here (honest absence, never a fabricated pass).
  const seal = run.sealVerification;
  if (seal) {
    // The seal instant is the one wire value in this drawer that can KILL THE SCREEN. `new Date(x)` on a
    // malformed instant yields an Invalid Date, and .toISOString() on an Invalid Date THROWS a RangeError, which
    // escapes this render and takes the whole drawer with it: the customer clicks one specific run and nothing
    // opens, while every other run opens fine, and there is no error anywhere except their devtools console. The
    // instant is now checked BEFORE it is converted. When it will not parse the drawer renders the seal verdict
    // and states the check time as honestly unknown, rather than dying, and the corrupt value is recorded as a
    // wire anomaly of its own field class: only the class travels, never the malformed instant.
    // The instant is epoch-ms on the wire, so the check is over the DATE it converts to, not a string parse: a
    // NaN, an infinity or (a wire shape the type does not promise) a string that will not read as a date all
    // yield an Invalid Date, and .toISOString() on an Invalid Date is the throw that kills this drawer.
    const sealAtValid = Number.isFinite(new Date(seal.at as string | number).getTime());
    if (!sealAtValid) recordWireAnomaly("seal-at", "unparseable");
    body.appendChild(
      drawerSection(
        "Verify at seal",
        kvRow("Result", tourTag("run-seal", h("span", sealVerifyDetail(seal)))),
        kvRow("Checked", sealAtValid ? `${relativeTime(new Date(seal.at).toISOString())} (${absoluteTime(seal.at)})` : "The engine did not report a readable time for this check."),
      ),
    );
    if (seal.status === "suspect") {
      // A suspect verdict is a real recoverability signal: surface it loudly with no soothing line.
      // It is fail-open (nothing was deleted or blocked), but the archive should be investigated.
      body.appendChild(
        inlineOutcome({
          heading: "Seal check suspect",
          reason: seal.reason
            ? `The read-back verification at seal was suspect: ${seal.reason}. Investigate before relying on this run.`
            : "The read-back verification at seal was suspect. Investigate before relying on this run.",
        }),
      );
    }
  }

  // The ABANDONED verdict, which had no surface here at all. It is a real recoverability signal (the engine
  // counts it as a failure for staleness, strikes and metrics) and it is NOT a failure the engine can
  // explain, so it gets its own words and warn rather than danger. The engine's own string, "abandoned (run
  // lease expired)", is coarse enough to be the whole body without help.
  if (run.status === "abandoned") {
    body.appendChild(
      verdictSurface({
        tone: "warn",
        title: "This run was abandoned",
        body: "The engine never received a result for this run and reclaimed it when its lease expired. Nothing was sealed under it, so it is not a recovery point. It is not a diagnosed failure: the run's verdict was lost rather than reported, so treat it as a run that did not happen and check the next one.",
      }),
    );
  }

  if (run.status === "failed" && run.error) {
    // A failed run's coarse, enumerated reason (escaped, never a stack) as an honest DANGER
    // verdict, not the neutral/info treatment: the failure is a real recoverability signal.
    // The wording stays calm; it is the run's recorded result, not an error toast.
    // Tag an INLINE span wrapping the verdict title TEXT (content-sized), so the tour's "?" sits beside
    // the heading words, not at the card's right edge.
    const failOutcome = verdictSurface({ tone: "danger", title: "This run failed", body: run.error });
    const failTitle = failOutcome.querySelector(".verdict__title") as HTMLElement | null;
    if (failTitle) {
      const t = failTitle.textContent ?? "";
      failTitle.textContent = "";
      failTitle.appendChild(h("span", { dataset: { tourId: "run-failure" } }, t));
    } else {
      failOutcome.dataset.tourId = "run-failure";
    }
    body.appendChild(failOutcome);
    // The doc affordance on the one surface where a first-timer meets a failure. The runs screens
    // carried no docs link at all: the screen where the
    // question is sharpest ("what do I do now?") is exactly where the answer must be one click away.
    body.appendChild(
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/a-backup-run-failed", target: "_blank", rel: "noreferrer noopener" },
        "A backup run failed: what to do",
      ),
    );
  }

  return body;
}

// The Drill section shell: the inline result host plus the role-gate hint. The hint
// reasons are visible here, not hover-only titles (touch has no hover and a title is
// invisible to keyboard users); mirrors the restore screen's Viewer hint. The drill gate
// is asymmetric ON PURPOSE: drill.run is Operator+ in the engine, while the dry-run
// restore is held from the Viewer role up.
function buildDrillSection(run: FleetRun, drillResult: HTMLElement): HTMLElement {
  const drillSection = drawerSection("Drill");
  drillSection.appendChild(drillResult);

  const opGate = canCap("drill.run");
  if (!opGate) {
    drillSection.appendChild(h("p", { class: "field__hint" }, `${capGateReason("drill.run")} Dry-run restore stays available to your role.`));
  } else if (!run.runId) {
    // A run the engine served with NO id. The console states it honestly and moves on, and the operator is
    // simply told this run cannot be drilled or restored, so the fault reads as a product limitation rather than
    // the serialisation regression it is. A run without an id cannot be restored AT ALL, which makes it the most
    // consequential of these anomalies, and it left no trace anywhere.
    recordWireAnomaly("run-id-missing", "missing");
    drillSection.appendChild(h("p", { class: "field__hint" }, "This run has no id, so it cannot be drilled or restored."));
  } else {
    // A drillable run that has not been drilled yet: a quiet idle line, never a bare heading.
    drillResult.replaceChildren(drillIdleLine());
  }
  return drillSection;
}

// drillIdleLine is the quiet before-any-drill read of the Drill section, also restored after a
// transport failure (the toast carries the error; the section returns to its idle state).
function drillIdleLine(): HTMLElement {
  return h("p", { class: "field__hint" }, "Run a drill to verify this run restores.");
}

// The drawer's two primary verbs: drill this run (Operator+, inline outcome) and build a
// restore plan. The drill action paints into the shared result host.
function buildRunDetailActions(engine: EngineClient, run: FleetRun, drillResult: HTMLElement): DrawerAction[] {
  const canDrill = canCap("drill.run") && run.runId !== "";

  let drillBusy = false;
  return [
    {
      label: "Drill this run",
      icon: svgIcon(ICON_PLAY, { size: 14 }),
      ...(canDrill ? {} : { disabled: true, disabledReason: run.runId ? capGateReason("drill.run") : "This run has no id to drill." }),
      onClick: async () => {
        if (drillBusy) return; // one drill at a time
        drillBusy = true;
        drillResult.replaceChildren(h("p", { class: "field__hint" }, "Running the drill..."));
        try {
          const res: DrillResult = await engine.drill(run.runId);
          renderDrill(drillResult, res);
          // Record drill evidence after a PASSING in-account drill: a dated recoverability
          // entry so the trail exists even where the engine cannot self-verify offline. An ok:false
          // drill is not evidence of recoverability, so only a pass is recorded. A refused write no
          // longer shadows the drill verdict, but it is no longer SILENT either: it is stated beside
          // the pass, because "never drilled" and "drilled, evidence not written" are different facts
          // and the recoverability report cannot tell them apart on its own.
          if (res.ok) {
            void writeDrillEvidence(engine, run.runId, () => drillResult.appendChild(drillEvidenceMissedNote()));
          }
        } catch (err) {
          drillResult.replaceChildren(drillIdleLine());
          if (isUnauthorised(err)) return goSignedOut();
          toast({ message: `Could not run the drill (${err instanceof Error ? err.message : String(err)}).`, tone: "warn" });
        } finally {
          drillBusy = false;
        }
      },
    },
    {
      // Matches the restore landing's primary verb so the journey reads as one
      // action across screens (sweep: restore-recoverability-naming).
      label: "Build a restore plan",
      icon: svgIcon(ICON_RESTORE, { size: 14 }),
      ...(run.runId ? {} : { disabled: true, disabledReason: "This run has no id to restore." }),
      onClick: () => navigate(`/restore/${encodeURIComponent(run.runId)}`),
    },
    {
      // THE WAY OUT OF A FAILED RUN, which this drawer did not have. Drill and Build a restore plan are
      // both things to do with an archive that EXISTS; the commonest day-two action on a run that failed
      // is to fix the cause and run it again, and Run now lives on the downpipe
      // (sources-downpipes/detail-actions.ts). Until now nothing here led there: the downpipe's name is in
      // the drawer title as inert text, and the only navigate() calls in this file were /runs and /restore.
      // A customer had to already know where to go, which is the assumption a walk keeps finding.
      label: "Open the downpipe",
      icon: svgIcon(ICON_DOWNPIPES, { size: 14 }),
      // The training walk's fix-and-rerun step asks the learner to press THIS, so the spotlight and its
      // "Your task is here" chip pin to the button. They used to pin to the failure verdict's title text,
      // which is prose: the chip pulsed on a line that does nothing when clicked.
      tourId: "run-open-downpipe",
      ...(run.downpipeId ? {} : { disabled: true, disabledReason: "This run does not name its downpipe." }),
      onClick: () => navigate(`/downpipes/${encodeURIComponent(run.downpipeId)}`),
    },
  ];
}

export function renderDrill(host: HTMLElement, res: DrillResult): void {
  if (res.ok) {
    host.replaceChildren(
      inlineOutcome({
        heading: "Drill passed",
        reason: `Verified ${groupNumber(res.recordsVerified)} records${res.sampleRestored ? " and restored a sample" : ""}.${res.isLatest === false ? " This is not the latest run." : ""}`,
      }),
    );
    return;
  }
  if ((res.reason ?? "").startsWith(BREAK_GLASS_PREFIX)) {
    // The break-glass-only posture returns ok:false with the documented reason; that is
    // an EXPECTED inline outcome, and the only one that earns a reassurance. The reason
    // itself already names the offline rehearsal path, so it is not repeated here.
    host.replaceChildren(
      inlineOutcome({
        heading: "Drill could not complete",
        reason: res.reason ?? "The drill did not complete.",
        reassurance: "Nothing was written; this is the expected outcome of that posture, not a fault.",
      }),
    );
    return;
  }
  // Every other engine reason (integrity, missing object, destination access, freshness,
  // configuration) is a real recoverability problem: surface it loudly, with no soothing
  // line (mirrors restore-flow.ts renderDrillResult).
  host.replaceChildren(
    verdictSurface({
      tone: "danger",
      title: "Drill failed",
      body: `${res.reason ?? "The drill did not complete."} Investigate before relying on this run.`,
      assertive: true,
    }),
  );
}
