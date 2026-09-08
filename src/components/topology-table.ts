// The accessible DATA TABLE projection of the topology map (topology.ts): the data-table
// column set and its cell renderers. This is the canonical, operable surface (the parity
// contract: every downpipe the SVG draws appears here, with a real per-row OPEN button), and
// it is shared by both the SVG map and the live-flow view, so it lives in its own sibling
// reused by both. Split out of topology.ts as a sibling so the renderer stays under the size
// budget. Moved verbatim from topology.ts; the columns, the cells and the markup are
// byte-for-byte the original (topology.ts re-exports topologyTableColumns by name).
//
// No-custody is never weakened: every server-supplied string (a node name, a downpipe id)
// reaches the DOM through the dom.ts textContent path (h() / a text node), so there is no
// markup-injection surface. House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon, type Child } from "../lib/dom.ts";
import { ICON_EXTERNAL } from "../lib/icons.ts";
import { relativeTime, absoluteTime, cadenceLabel } from "../lib/format.ts";
import type { DataColumn } from "./data-table-types.ts";
import { kindWord, throughputText, relativeFrom, toMsLocal } from "./topology-model.ts";
import type { FlowRecord, FlowEndpoint, StatusPresentation, TopologyTableRow } from "./topology-types.ts";

// topologyTableColumns are the data-table columns: source, destination, status (hue +
// glyph + label), last run (relative + absolute title), cadence, throughput (numeric,
// right-aligned), and (when an open handler is supplied) a trailing OPEN column whose cell
// is a REAL <button> with an accessible name ("Open <source> to <destination>"). That
// button is the real, keyboard-operable control that opens the downpipe drawer (spec
// section 5: real buttons with accessible names, not bare SVG shapes); the SVG is a pure
// visual. Exposed so a screen can extend/reorder; renderTopology uses them as-is. An
// optional `now` makes the relative "last run" phrase agree exactly with the SVG edge label
// (both computed against the same instant); omitting it uses the ambient clock.
export function topologyTableColumns(now?: number, onOpen?: (id: string) => void): Array<DataColumn<TopologyTableRow>> {
  const columns: Array<DataColumn<TopologyTableRow>> = [
    {
      key: "source",
      header: "Source",
      render: (r) => endpointCell(r.flow.source),
      sortable: true,
      sortValue: (r) => r.flow.source.name,
    },
    {
      key: "destination",
      header: "Destination",
      render: (r) => endpointCell(r.flow.destination),
      sortable: true,
      sortValue: (r) => r.flow.destination.name,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => statusCell(r.presentation, r.flow.running),
      sortable: true,
      sortValue: (r) => r.presentation.label,
    },
    {
      key: "lastRun",
      header: "Last run",
      render: (r) => lastRunCell(r.flow, now),
      sortable: true,
      // Sort by the timestamp (epoch ms), missing last so a never-run flow sinks.
      sortValue: (r) => lastRunMs(r.flow.lastRunAt),
    },
    {
      key: "cadence",
      header: "Cadence",
      render: (r) => (r.flow.cadence !== undefined && Number.isFinite(r.flow.cadence) ? cadenceLabel(r.flow.cadence) : "-"),
      sortable: true,
      sortValue: (r) => r.flow.cadence ?? null,
    },
    {
      key: "throughput",
      header: "Per run",
      render: (r) => throughputText(r.flow.bytesPerRun) || "-",
      numeric: true,
      sortable: true,
      sortValue: (r) => (r.flow.bytesPerRun ?? null),
    },
  ];
  if (onOpen) {
    columns.push({
      key: "open",
      header: "Open",
      srOnlyHeader: true,
      width: "1px",
      render: (r) => openButton(r.flow, onOpen),
    });
  }
  return columns;
}

// openButton is the REAL, keyboard-operable control that opens a downpipe's drawer: a
// genuine <button> element (not a bare SVG shape with an ARIA role) carrying an explicit
// accessible name, "Open <source> to <destination>". dataTable ignores clicks on inner
// buttons for its own row activation, so this button owns the open action without a
// double-fire. Used in the accessible table, which is the operable surface (spec section 5).
function openButton(flow: FlowRecord, onOpen: (id: string) => void): HTMLButtonElement {
  const label = `Open ${flow.source.name} to ${flow.destination.name}`;
  const btn = h("button", { "data-dp": "components-topology-table.button.open",
    class: "btn btn--ghost btn--sm topo-open",
    type: "button",
    "aria-label": label,
  }) as HTMLButtonElement;
  btn.appendChild(svgIcon(ICON_EXTERNAL, { size: 14 }));
  btn.addEventListener("click", () => onOpen(flow.id));
  return btn;
}

function endpointCell(ep: FlowEndpoint): HTMLElement {
  const wrap = h("span", { class: "topo-cell-node" });
  wrap.appendChild(h("span", { class: "topo-cell-node__name" }, ep.name));
  wrap.appendChild(h("span", { class: "topo-cell-node__kind field__hint" }, ` ${kindWord(ep.kind)}`));
  return wrap;
}

// statusCell renders hue (dot tone) + shape (glyph) + label, never colour alone. A running
// flow adds the "running" word so the table carries the in-flight state the SVG animates.
function statusCell(p: StatusPresentation, running: boolean): HTMLElement {
  // Layout (inline-flex, centred, gap) comes from the .topo-status rule in tokens.css; no inline style needed.
  const wrap = h("span", { class: `topo-status topo-status--${p.tone}` });
  wrap.appendChild(h("span", { class: "topo-status__glyph", "aria-hidden": "true" }, svgIcon(p.glyph, { size: 14 })));
  wrap.appendChild(h("span", p.label));
  if (running) wrap.appendChild(h("span", { class: "badge badge--info" }, "running"));
  return wrap;
}

function lastRunCell(flow: FlowRecord, now?: number): Child {
  if (flow.lastRunAt === undefined || flow.lastRunAt === null || flow.lastRunAt === "") return "-";
  // When the render path passes `now`, the cell's relative phrase agrees exactly with the
  // SVG edge label; otherwise fall back to the shared ambient-clock relativeTime.
  const rel = now !== undefined ? relativeFrom(flow.lastRunAt, now) : relativeTime(flow.lastRunAt);
  const abs = absoluteTime(flow.lastRunAt);
  return h("span", { class: "tnum", ...(abs ? { title: abs } : {}) }, rel);
}

// lastRunMs is the clock-free sort comparable for the "last run" column (epoch ms, missing
// last). It reuses toMsLocal so there is one parse-to-ms path.
function lastRunMs(input: string | number | null | undefined): number | null {
  return toMsLocal(input);
}
