// RunsView: the data-bound body lifecycle for the Runs screen. It loads on mount, exposes
// a manual refresh (the header button + the __runsRefresh handle), and self-disposes when
// navigated away (the body is detached by the router; any in-flight load that resolves
// into a detached element is dropped). It deliberately does NOT poll: the run history is a
// deliberate read the operator opens, not a live dashboard (the Overview owns the live
// poll); a manual refresh keeps it honest without making requests from a backgrounded
// screen. It owns the six-state matrix (loading / empty / filtered-empty / partial-via-
// table / error / success); the summary band, the table and the run detail come from the
// sibling modules.

import { h } from "../../lib/dom.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { blockError } from "../../components/error-view.ts";
import { toast } from "../../components/toast.ts";
import { groupNumber } from "../../lib/format.ts";
import type { EngineClient } from "../../api.ts";
import type { DataTableHandle } from "../../components/data-table.ts";
import { isUnsuccessful, type FleetRun } from "./types.ts";
import { flatten, loadingSkeleton, buildEmpty } from "./helpers.ts";
import { buildSummary } from "./summary.ts";
import { buildTable } from "./table.ts";
import { openRunDetail } from "./detail.ts";

export class RunsView {
  readonly el: HTMLElement;
  private engine: EngineClient;
  private query: URLSearchParams;
  private detail: { detailDp: string | undefined; detailIndex: string | undefined };
  private content: HTMLElement;
  private liveRegion: HTMLElement;
  private table: DataTableHandle<FleetRun> | null = null;
  private firstLoadDone = false;
  private inFlight = false;
  private detailOpened = false;

  constructor(engine: EngineClient, query: URLSearchParams, detail: { detailDp: string | undefined; detailIndex: string | undefined }) {
    this.engine = engine;
    this.query = query;
    this.detail = detail;
    this.content = h("div", { class: "async-region" });
    // A polite live region announces refresh outcomes for assistive tech without
    // stealing focus (mirrors overview.ts).
    this.liveRegion = h("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    this.el = h("div", this.content, this.liveRegion);

    // The "/" key focuses the table filter (flow parity with Downpipes), unless the
    // operator is already typing in a field. Scoped to this view's element lifetime.
    this.el.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "/") return;
      const t = ev.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      ev.preventDefault();
      this.table?.focusFilter();
    });
  }

  start(): void {
    void this.load();
  }

  refresh(): void {
    void this.load();
  }

  // everConnected latches once the element has been seen IN the document; "not connected"
  // means dead ONLY after that (the router attaches the screen inside a view transition, so
  // a fast engine can resolve the first fetch BEFORE attachment - treating that as
  // "navigated away" left the loading skeleton on screen forever; the map's local
  // fixture-engine reproduction caught it).
  private everConnected = false;

  private isAlive(): boolean {
    if (this.el.isConnected) {
      this.everConnected = true;
      return true;
    }
    return !this.everConnected;
  }

  private announce(message: string): void {
    this.liveRegion.textContent = message;
  }

  // fetchRuns reads the screen's source (all run history) and enriches each slug id with its
  // human name. The downpipe list rides along so each id carries its Downpipe.name in the
  // table, the drawer and the filter; the history read is the core, the list is an enrichment,
  // so a name-read failure degrades to ids rather than failing the screen.
  private async fetchRuns(): Promise<FleetRun[]> {
    const [all, states] = await Promise.all([
      this.engine.listAllHistory(),
      this.engine.listDownpipes().catch(() => null),
    ]);
    const names = new Map<string, string>();
    for (const s of states ?? []) names.set(s.config.id, s.config.name);
    return flatten(all.byDownpipe, names);
  }

  // maybeOpenDeepLink opens the deep-linked run detail once the data is present (so the drawer
  // has its run). If the run id in the URL no longer resolves, it falls back to the list URL.
  private maybeOpenDeepLink(runs: FleetRun[]): void {
    if (!this.detail.detailDp || this.detail.detailIndex === undefined || this.detailOpened) return;
    const run = runs.find((r) => r.downpipeId === this.detail.detailDp && String(r.index) === this.detail.detailIndex);
    if (run) {
      this.detailOpened = true;
      openRunDetail(this.engine, run);
    } else {
      // Say why the deep link did not open (a stale bookmark, a rolled-off ring
      // entry, or a deleted downpipe), matching the toast sources-downpipes.ts
      // already gives for the equivalent dangling-id fallback there, rather than the
      // operator's browser silently changing the address bar with no explanation.
      toast({ message: "That run no longer exists; showing the current list.", tone: "info" });
      navigate("/runs", { replace: true });
    }
  }

  private async load(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    if (!this.firstLoadDone) {
      this.content.replaceChildren(loadingSkeleton());
    } else {
      this.content.setAttribute("aria-busy", "true");
      this.content.classList.add("is-refetching");
    }

    let runs: FleetRun[];
    try {
      runs = await this.fetchRuns();
    } catch (err) {
      if (!this.isAlive()) {
        this.inFlight = false;
        return;
      }
      this.inFlight = false;
      this.content.classList.remove("is-refetching");
      this.content.setAttribute("aria-busy", "false");
      if (isUnauthorised(err)) {
        goSignedOut();
        return;
      }
      // 5xx / network -> inline block with Retry (channel two). The history read is the
      // whole screen's source, so a failure is the honest whole-screen error, never a
      // stale green.
      this.content.replaceChildren(blockError(err, () => this.refresh(), { origin: location.origin }));
      return;
    }

    if (!this.isAlive()) {
      this.inFlight = false;
      return; // navigated away mid-load: drop the result, do not render into a detached node
    }

    const wasRefresh = this.firstLoadDone;
    this.renderContent(runs);
    this.firstLoadDone = true;
    this.inFlight = false;
    this.content.classList.remove("is-refetching");
    this.content.setAttribute("aria-busy", "false");

    // Announce a manual refresh outcome to assistive tech (the palette / header refresh
    // is otherwise a silent in-place swap). The first paint is not announced, so the
    // screen does not speak over its own arrival; a refresh states the fresh posture.
    if (wasRefresh) {
      // isUnsuccessful, not `=== "failed"`. This live region sat a hundred lines from the summary tile
      // that already reads "Failed or abandoned", and counted only the failures: an estate whose runs
      // were ALL abandoned overnight announced "no failures" to a screen-reader user, on the one screen
      // they had opened to find out what went wrong. The wording follows the tile rather than inventing
      // a third vocabulary for the same set.
      const unsuccessful = runs.filter((r) => isUnsuccessful(r.status)).length;
      this.announce(
        unsuccessful > 0
          ? `Runs refreshed: ${groupNumber(runs.length)} total, ${groupNumber(unsuccessful)} failed or abandoned.`
          : `Runs refreshed: ${groupNumber(runs.length)} total, none failed or abandoned.`,
      );
    }

    this.maybeOpenDeepLink(runs);
  }

  private renderContent(runs: FleetRun[]): void {
    // True-empty: no runs across any downpipe. Teach the next action rather than show an
    // empty table (the table's own filtered-empty handles the rows-exist-none-match case).
    if (runs.length === 0) {
      this.table = null;
      this.content.replaceChildren(buildEmpty());
      return;
    }

    const wrap = h("div");
    // The summary band: throughput, freshness and outcome at a glance, computed from the
    // full set of each downpipe's recent-run history ring (not the filtered view), so it
    // reads the fleet's true posture over that ring. The ring's own bound is
    // disclosed inside buildSummary now, matching the restore date-picker and the
    // notifications history's disclosure of the identically-shaped ring.
    wrap.appendChild(buildSummary(runs));

    // The activity section, with its own h2 heading so the document outline is
    // valid below the screen h1. The count lives in the summary band's Runs tile, once.
    const section = h("section", { "aria-labelledby": "runs-activity-h" });
    section.appendChild(h("h2", { id: "runs-activity-h", style: "font-size:var(--text-lg);margin:var(--space-6) 0 var(--space-3)" }, "Activity"));

    this.table = buildTable(runs, this.query);
    section.appendChild(this.table.el);

    section.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-3)" },
        "Open a run for its detail, a drill and a dry-run restore.",
      ),
    );
    wrap.appendChild(section);

    this.content.replaceChildren(wrap);
  }
}
