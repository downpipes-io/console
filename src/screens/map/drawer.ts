// The read-oriented detail drawer the map view opens for one flow, plus its two pure data
// reads (the last-fetched run ring, the 3-2-1 copies readout). These build DOM and read the
// stashed MapData but own no view lifecycle, so they take their inputs (the flow, the engine
// for the lazy recent-runs read, the stashed MapData, and an onClose callback the view owns)
// as parameters.
//
// No-custody is never weakened: every server-supplied string (a source name, a binding, a
// bucket name, a run id) reaches the DOM through the dom.ts textContent path (kvRow / h()),
// so there is no markup-injection surface.

import type { EngineClient, RunHistoryEntry } from "../../api.ts";
import { drawerSection, kvRow, openDetailDrawer } from "../../components/detail-drawer.ts";
import { inlineRetry, refusalText, sessionEnded } from "../../components/error-view.ts";
import { confirmModal } from "../../components/modal.ts";
import { distinctDownReasonLabels, summariseReplication } from "../../components/replication.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import type { FlowRecord } from "../../components/topology.ts";
import { h, refuseWithReason, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { cadenceLabel, humanBytes, titleCase } from "../../lib/format.ts";
import { ICON_EXTERNAL, ICON_TRASH } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { capGateReason, gateReason } from "../common.ts";
import { downpipeIdOf, type MapData } from "./data.ts";
import {
  endpointText,
  freshnessLine,
  kindWord,
  lastRunText,
  recentRunsList,
  statusPresent,
} from "./panels.ts";

// The view-owned dependencies the drawer reads or calls back into. lastData is the stashed
// MapData (for the freshness ring and the copies readout); engine drives the lazy recent-runs
// read; onClose is the view's drawer-close handler (it clears openId and navigates back to the
// base route with the current filters, guarded against the close the view triggers itself).
export interface MapDrawerDeps {
  engine: EngineClient;
  lastData: MapData | null;
  onClose: () => void;
  // refresh re-runs the map load after a mutation from this drawer (a delete, a roster clean-up),
  // so the edge disappears at once; the drawer-sync close-on-vanish then closes the drawer.
  refresh: () => void;
  // Role gates, resolved by the caller (canDo): delete is Operator+; the roster clean-up is
  // owner-grade (keys.ceremony on the engine). A gated action renders disabled-with-reason,
  // never hidden-then-403.
  canDelete: boolean;
  canReconcile: boolean;
}

// buildMapDrawer mounts the read-oriented detail drawer for one flow. It shows the config
// (source, binding, schedule, destination), a freshness line (honest hue + shape + label), and
// a lazily-loaded recent-runs strip; the footer links to the full Downpipes surface for the
// gated actions (so a Viewer is never shown a write button that 403s). Every server string
// enters via textContent (kvRow / h()). The flow snapshot is read at open time; the live, gated
// detail lives behind "Open in Downpipes".
export function buildMapDrawer(flow: FlowRecord, deps: MapDrawerDeps): { close: () => void } {
  const body = h("div");

  // Freshness line (honest). Derived from the flow's status; never a stale green. The
  // last-fetched ring distinguishes a never-run pipe from an unreadable history, so an
  // "unknown" is explained by its actual cause.
  body.appendChild(freshnessLine(flow, flowRing(deps.lastData, flow.id)));

  body.appendChild(flowSection(flow, deps.lastData));
  body.appendChild(runsSection(flow, deps.engine));
  // A standing "Unknown" edge gets the WHY and the way out, right here: the lazily-loaded roster
  // note distinguishes a never-ran downpipe from an orphaned roster record, and (owner) offers the
  // one-click clean-up when the engine reports structural ghosts. Nothing on the map is ever a
  // permanent grey line with no affordance again.
  if (flow.status === "unknown") body.appendChild(rosterNoteSection(flow, deps));

  const fresh = statusPresent(flow.status);
  const handle = openDetailDrawer({
    title: flow.source.name,
    meta: h("span", { class: "mono" }, `${kindWord(flow.source.kind)} to ${flow.destination.name}`),
    badges: [badge(fresh.tone, fresh.label)],
    body,
    // Keyed by the flow id: /map is deep-linkable too (?open=<id>, openMapDrawer in
    // drawer-sync.ts), and renderMap builds a fresh MapView/MapController on every
    // screen.render(), so an identity-resolved quiet re-render (app.ts) constructs a NEW
    // controller whose own drawerHandle dedup guard (syncMapDrawer's `if (host.drawerHandle)
    // return`) starts unset and cannot see the still-mounted drawer the PREVIOUS controller
    // opened. The key guard in openOverlay (dialog.ts) is what actually stops the stack, the
    // same guard sources-downpipes/detail.ts relies on.
    key: `map-drawer:${flow.id}`,
    // Closing returns to /map (the base path with current filters), which clears ?open and
    // re-resolves this screen. The view's onClose is guarded so a close WE triggered (a
    // navigation away, or a re-sync that found the flow gone) does not recurse into a navigate.
    onClose: deps.onClose,
    actions: [
      // The destination really is the Downpipes drawer (where Run now / Drill / Start restore
      // live); a separate "Start restore" action here would navigate to the same drawer and
      // over-promise a distinct capability, so it is not offered. Delete lives HERE too: the map
      // is where an orphaned or unwanted flow is discovered, and sending the operator to another
      // screen to remove it would be a dead end (an id the Downpipes list cannot resolve lands
      // silently on the bare list with nothing to act on).
      {
        label: "Open in Downpipes",
        icon: svgIcon(ICON_EXTERNAL, { size: 14 }),
        onClick: () => navigate(`/downpipes/${encodeURIComponent(downpipeIdOf(flow.id))}`),
      },
      {
        label: "Delete downpipe",
        icon: svgIcon(ICON_TRASH, { size: 14 }),
        variant: "danger",
        ...(deps.canDelete ? {} : { disabled: true, disabledReason: capGateReason("downpipe.delete"), gateOp: "downpipe-delete" as const }),
        onClick: () => { void deleteFlowDownpipe(flow, deps); },
      },
    ],
  });
  return handle;
}

// downpipeName resolves the human name for the flow's downpipe from the stashed list (the flow
// itself carries only the source/destination labels), falling back to the id.
function downpipeName(flow: FlowRecord, lastData: MapData | null): string {
  const dpId = downpipeIdOf(flow.id);
  if (lastData?.downpipes.ok) {
    const state = lastData.downpipes.value.find((s) => s.config.id === dpId);
    if (state && typeof state.config.name === "string" && state.config.name.trim() !== "") return state.config.name;
  }
  return dpId;
}

// downpipeRev resolves the CONFIG REVISION the map last read this downpipe at, from the same stashed list
// downpipeName reads. It is the base the delete states (engine ifMatchRev), so a delete fired from the map
// over a downpipe another operator has since edited is refused and named rather than applied over the top.
// Absent when the list is not loaded, when the row is not in it, or against an engine older than the
// precondition; absent states nothing, an unconditional delete.
function downpipeRev(flow: FlowRecord, lastData: MapData | null): number | undefined {
  const dpId = downpipeIdOf(flow.id);
  if (!lastData?.downpipes.ok) return undefined;
  return lastData.downpipes.value.find((s) => s.config.id === dpId)?.configRev;
}

// deleteFlowDownpipe is the map-drawer delete: the SAME danger-tier safe confirm as the Downpipes
// drawer (blast radius named: archives remain), then the gated delete. On success the map refresh
// drops the edge and the drawer-sync close-on-vanish closes this drawer; a change-gate-queued
// delete says so honestly, distinct from "nothing was deleted" (an undeletable row).
async function deleteFlowDownpipe(flow: FlowRecord, deps: MapDrawerDeps): Promise<void> {
  const dpId = downpipeIdOf(flow.id);
  const name = downpipeName(flow, deps.lastData);
  const ok = await confirmModal({
    title: "Delete this downpipe?",
    body: `This stops scheduled backups for ${name} and removes its run history. Existing archives in your destination are not deleted. You can recreate the route later.`,
    confirmLabel: "Delete downpipe",
    cancelLabel: "Cancel",
    variant: "danger",
    busyLabel: "Deleting",
  });
  if (!ok) return;
  try {
    const res = await deps.engine.deleteDownpipe(dpId, downpipeRev(flow, deps.lastData));
    if (res.status === "pending") {
      surfacePendingChange("delete");
      return;
    }
    if (res.value.deleted) {
      const sweep = res.value.swept !== undefined && res.value.swept > 0
        ? ` (including ${res.value.swept} orphaned roster ${res.value.swept === 1 ? "entry" : "entries"} a normal delete could not reach)`
        : "";
      toast({ message: `Deleted ${name}${sweep}` });
    } else {
      toast({ message: `The engine reported nothing was deleted for ${name}; the map has been refreshed.`, tone: "warn" });
    }
    deps.refresh();
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    toast({ message: `Could not delete ${name}. ${refusalText(err)}`, tone: "warn" });
  }
}

// rosterNoteSection is the lazily-loaded WHY for a standing "Unknown" edge. It asks the engine's
// roster-hygiene report whether this flow is a never-ran downpipe (a valid config waiting for its
// first run, or simply unwanted: delete it below) or an orphaned roster record (a structural ghost
// the clean-up removes), and offers the owner-grade one-click clean-up when ghosts exist. Failures
// degrade to silence: this section is an explanation, never a blocker.
function rosterNoteSection(flow: FlowRecord, deps: MapDrawerDeps): HTMLElement {
  const section = drawerSection("Why is this unknown?");
  const host = h("div", h("p", { class: "field__hint" }, "Checking the roster..."));
  section.appendChild(host);
  const dpId = downpipeIdOf(flow.id);
  void deps.engine
    .rosterHygiene()
    .then((report) => {
      const ghost = report.ghosts.find((g) => g.embeddedId === dpId || g.key === `dp:${dpId}`);
      const neverRan = report.neverRan.some((n) => n.id === dpId);
      const parts: HTMLElement[] = [];
      if (ghost) {
        parts.push(h("p", { class: "field__hint" },
          "This entry is an orphaned roster record: its stored key does not match its id, so it can never run and, until this release, could not be deleted. Delete downpipe below removes it, or clean up every orphaned entry at once."));
      } else if (neverRan) {
        parts.push(h("p", { class: "field__hint" },
          "This downpipe has never completed a run, so the map makes no freshness claim. If it is newly created, the next scheduled tick starts it; if it is unwanted, Delete downpipe below removes it."));
      }
      if (report.ghostCount > 0) {
        const noun = report.ghostCount === 1 ? "entry" : "entries";
        parts.push(h("p", { class: "field__hint" }, `The engine reports ${report.ghostCount} orphaned roster ${noun} in total.`));
        const cleanup = h(
          "button",
          { "data-dp": "map.button.cleanup", class: "btn btn--sm", type: "button" },
          `Clean up ${report.ghostCount} orphaned ${noun}`,
        );
        // The shared refusal primitive sets aria-disabled, the title and the described-by reason
        // together, so the name stays "Clean up 2 orphaned entries" rather than announcing the
        // reason with a stray separator glued onto the end of it.
        if (!deps.canReconcile) refuseWithReason(cleanup, gateReason("owner"));
        // aria-disabled keeps the button focusable so the reason is announced, but does not block a keyboard
        // activation, so the gate is re-checked here (the engine enforces it regardless).
        cleanup.addEventListener("click", () => { if (!deps.canReconcile) return; void runRosterCleanup(deps, cleanup); });
        parts.push(h("div", { style: "margin-top:var(--space-2)" }, cleanup));
      }
      if (parts.length === 0) {
        // No roster-side explanation (e.g. the history read failed for this poll): keep the
        // freshness line's own honest wording and say nothing extra here.
        //
        // The whole section is removed, not just its body: removing only the host would leave the heading
        // "Why is this unknown?" standing over nothing, so the drawer would ask the operator's question
        // and then show a blank where the answer belongs.
        section.remove();
        return;
      }
      host.replaceChildren(...parts);
    })
    .catch(() => {
      // Removing the host here would be the wrong degrade for a FAILED READ: the empty case above
      // genuinely has nothing to say; this case has something to say and could not read it, so silently
      // deleting the body would leave the same dangling question heading. The retry REPLACES this section
      // rather than emptying it and appending a fresh one INSIDE itself, which would nest one
      // `.drawer-section` (and one more `margin-bottom`) per retry and, on the branch above that calls
      // `section.remove()`, remove only the inner one and leave the empty outer standing in the drawer: the
      // very blank-where-the-answer-belongs state this section must avoid. replaceWith keeps the fresh
      // section a child of the DRAWER, so its own remove() still reaches the drawer.
      host.replaceChildren(
        inlineRetry({
          message: "The engine did not answer with its roster report, so why this route reads as unknown could not be worked out. The rest of this drawer is unaffected.",
          onReload: () => { section.replaceWith(rosterNoteSection(flow, deps)); },
        }),
      );
    });
  return section;
}

// runRosterCleanup drives the owner-grade heal (confirm-to-act, counts reported honestly) and
// refreshes the map so a removed ghost's edge disappears at once.
async function runRosterCleanup(deps: MapDrawerDeps, button: HTMLButtonElement): Promise<void> {
  const ok = await confirmModal({
    title: "Clean up orphaned roster entries?",
    body: "This removes roster records whose stored key does not match their id (they can never run and cannot be deleted normally) and rehomes any that hold real state. Valid downpipes, run history and archives are not touched.",
    confirmLabel: "Clean up",
    cancelLabel: "Cancel",
    busyLabel: "Cleaning up",
  });
  if (!ok) return;
  button.disabled = true;
  try {
    const res = await deps.engine.reconcileRoster();
    const bits: string[] = [];
    if (res.removed > 0) bits.push(`${res.removed} removed`);
    if (res.rehomed > 0) bits.push(`${res.rehomed} rehomed`);
    const summary = bits.length > 0 ? bits.join(", ") : "nothing needed cleaning";
    toast({ message: `Roster clean-up finished: ${summary}.${res.ghostsRemaining > 0 ? ` ${res.ghostsRemaining} remaining.` : ""}` });
    deps.refresh();
  } catch (err) {
    button.disabled = false;
    if (isUnauthorised(err)) return goSignedOut();
    toast({ message: `Could not clean up the roster. ${refusalText(err)}`, tone: "warn" });
  }
}

// This file carries no drawer-local error-to-text helper: both delete paths go through
// components/error-view.ts refusalText, the same reviewed rule the destination form, the source
// token, the downpipe toasts and the licence verbs go through, so every refusal reads with the same
// care regardless of which screen shows it: the engine's own sentence when the throw carries one, the
// reviewed sentence for the classified kind when it does not. THE CONSOLE'S OWN INTERNAL TOKENS MUST
// NEVER SURFACE; THE ENGINE'S OWN WORDS MAY.
//
// The composition contract is "<what failed>. <why>": the no-reason branch returns a whole reviewed
// sentence carrying its own advice, and nesting one inside a parenthesis inside another sentence would
// put two full stops in one parenthesis and two instructions in one line.

// flowSection builds the config section from the FlowRecord (source, binding, schedule,
// destination, per-run bytes, state), plus the 3-2-1 copies readout for a fan-out downpipe.
function flowSection(flow: FlowRecord, lastData: MapData | null): HTMLElement {
  const flowRows = [
    kvRow("Source", endpointText(flow.source)),
    kvRow("Destination", endpointText(flow.destination)),
    kvRow("Schedule", flow.cadence !== undefined ? titleCase(cadenceLabel(flow.cadence)) : "no cadence"),
    kvRow("Last run", lastRunText(flow)),
    kvRow("Per run", flow.bytesPerRun != null ? humanBytes(flow.bytesPerRun) : "unknown"),
    kvRow("State", flow.enabled ? (flow.running ? "Running" : "Enabled") : "Disabled"),
  ];
  // For a 3-2-1 fan-out downpipe, the honest redundancy readout: "N of M copies" + how many are down.
  const copies = copiesRow(lastData, flow.id);
  if (copies) flowRows.push(copies);
  return drawerSection("Flow", ...flowRows);
}

// runsSection builds the recent-runs section, loaded lazily (the map already has the latest
// entry, but the full ring is a per-open detail). A per-section failure is a small inline note,
// not a global error (the rest of the drawer is immediately usable).
function runsSection(flow: FlowRecord, engine: EngineClient): HTMLElement {
  const section = drawerSection("Recent runs");
  const runsHost = h("div", h("p", { class: "field__hint" }, "Loading recent runs..."));
  section.appendChild(runsHost);
  // A failure branch with nothing to press is a dead end wearing a sentence: re-opening the drawer
  // would re-run this read, but nothing on screen would say so, and a recovery the operator has to
  // guess is no recovery at all. The retry below is explicit.
  const load = (): void => {
    runsHost.replaceChildren(h("p", { class: "field__hint" }, "Loading recent runs..."));
    void engine
      .listHistory(downpipeIdOf(flow.id))
      .then((entries) => {
        if (entries.length === 0) {
          runsHost.replaceChildren(h("p", { class: "field__hint" }, "No runs yet."));
          return;
        }
        runsHost.replaceChildren(recentRunsList(entries));
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the runs list reads "Loading recent runs..." until this replaces it.
          runsHost.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        runsHost.replaceChildren(
          inlineRetry({
            message: "The engine did not answer with this downpipe's run history, so no runs are listed. The rest of this drawer is unaffected.",
            onReload: load,
          }),
        );
      });
  };
  load();
  return section;
}

// flowRing returns the last-fetched run ring for a flow, or null when the history read failed
// (so the drawer can tell "never run" apart from "could not be read").
export function flowRing(lastData: MapData | null, id: string): RunHistoryEntry[] | null {
  const hist = lastData?.history;
  if (!hist?.ok) return null;
  return hist.value[downpipeIdOf(id)] ?? [];
}

// copiesRow builds the drawer's 3-2-1 redundancy readout for a FAN-OUT downpipe: "N of M copies",
// with how many destinations are down or catching up, from PROVEN per-destination replication
// state. Returns null for a single-destination downpipe (no redundancy concept) or when the data
// is not yet loaded.
export function copiesRow(lastData: MapData | null, flowId: string): HTMLElement | null {
  const data = lastData;
  if (!data?.downpipes.ok) return null;
  const dpId = downpipeIdOf(flowId);
  const state = data.downpipes.value.find((s) => s.config.id === dpId);
  if (!state) return null;
  const cfg = state.config;
  const ids = cfg.destinationIds && cfg.destinationIds.length > 0 ? cfg.destinationIds : cfg.destinationId ? [cfg.destinationId] : [];
  if (ids.length < 2) return null; // a single-destination downpipe has no redundancy concept
  const repl = data.replication?.ok ? data.replication.value[dpId] : undefined;
  const ring = data.history.ok ? data.history.value[dpId] ?? [] : [];
  const latestRunId = ring.find((e) => e.status === "ok")?.runId ?? null;
  // The drawer derives its own summary, so it needs the SAME anchor the map edge does or the two disagree
  // on the same downpipe: the lane would read "catching up" while the line below it said "1 never reported". The
  // anchor comes off the downpipe's own engine state (sealedRuns + replAnchors), and summariseReplication only
  // counts a destination as never-reported once at least two backups have succeeded since it joined the fan-out.
  // Withheld when the heartbeat read faulted, for the same reason the map edge withholds it: with no read, a
  // destination that holds every run is as row-less as one that holds nothing, so absence proves nothing.
  const anchor =
    data.replication?.ok === true
      ? {
          ...(state.sealedRuns !== undefined ? { sealedRuns: state.sealedRuns } : {}),
          ...(state.replAnchors !== undefined ? { anchors: state.replAnchors } : {}),
        }
      : {};
  const s = summariseReplication(ids, repl, latestRunId, anchor);
  // "never reported" outranks "catching up" in the detail line, because they call for opposite actions. A
  // destination the engine has never reported on across successive successful backups is not behind and will not
  // catch up on its own; telling the operator it is catching up would leave a dead replication leg looking
  // amber indefinitely. A destination too young to judge is NOT in that set: it is counted as catching up,
  // which it is.
  // Name WHY the down destinations are down (credential vs retention lock vs throttle vs network),
  // from the engine's per-destination reason, rather than a flat "N down". Generic/absent reasons add
  // nothing, so the parenthetical only appears when there is an actionable cause to show.
  const downReasons = distinctDownReasonLabels(s);
  const shortfall = s.downIds.length
    ? ` - ${s.downIds.length} down${downReasons.length ? ` (${downReasons.join("; ")})` : ""}`
    : s.neverReportedIds.length
      ? ` - ${s.neverReportedIds.length} never reported`
      : s.copies < s.intended
        ? " - catching up"
        : "";
  const detail = s.redundancy === "pending"
    ? `${s.intended} destinations (no run yet)`
    : `${s.copies} of ${s.intended} copies${shortfall}`;
  return kvRow("Copies", detail);
}
