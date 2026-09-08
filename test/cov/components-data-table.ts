// Coverage on the configurable DATA TABLE (src/components/data-table.ts), the superset table
// machine: a /-focusable filter, faceted chips, sortable headers, multi-select with a
// select-all indeterminate header box, a bulk-action bar, a density toggle, roving-tabindex
// row navigation, large-list windowing past a threshold, and the filtered/true empty states.
//
// The existing validate-components.ts exercises only the pure seams (the windowing maths,
// the sort comparator, the bulk-rejection guard). It never constructs the dataTable() machine,
// so the whole 650-line render body sat uncovered. This validator RENDERS the REAL component
// under the shared DOM shim (test/dom-shim.ts, the same hand-rolled approach the stable-component
// validator uses) and drives its behaviour, so each assertion exercises production code paths
// rather than re-implementing them.
//
// Run with: node test/cov/components-data-table.ts
//
// House rules: Australian English, no em dashes, precise claims.

import {
  installDomShim,
  qs,
  qsa,
  textOf,
  classesOf,
  flushAsync,
  activeElement,
  keydown,
  type ShimNode,
  type ShimEvent,
} from "../dom-shim.ts";

// Install BEFORE importing any module that touches document at load time (dom.ts builds
// elements eagerly inside helpers, and components create singleton live regions at module scope).
installDomShim();

// The shim deliberately omits requestAnimationFrame and getBoundingClientRect because the stable
// components do not need them. The data table's windowed paint() guards rAF with a typeof check
// and uses a measured row height for one corrective repaint; to cover those branches we provide a
// synchronous rAF and a measurable rect WITHOUT touching the shared shim file. The rAF callbacks
// are queued and drained by drainRaf() so a test can run them deterministically. The measured
// height is parsed from the row's first cell style.height when set, else a small default, so the
// corrective-repaint branch (measured != assumed) is reachable.
const rafQueue: Array<() => void> = [];
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (cb: () => void): number => {
  rafQueue.push(cb);
  return rafQueue.length;
};
function drainRaf(): void {
  const pending = rafQueue.splice(0, rafQueue.length);
  for (const cb of pending) cb();
}
// The measured data-row height returned by getBoundingClientRect (below). Default 60 so the
// windowed corrective-repaint branch (measured differs from the assumed 49 by more than 1px)
// fires; a test that needs focusRow's scroll maths to line up with the painted slice sets it
// to the comfortable assumption (49) so the corrective repaint is a no-op.
let measuredRowHeight = 60;
function setMeasuredRowHeight(h: number): void {
  measuredRowHeight = h;
}
// Add getBoundingClientRect to the shim node prototype at runtime from the test (this augments
// the in-memory class, it does not edit the shared shim source). A measured height of 60 differs
// from the comfortable assumption (49) so the windowed corrective repaint genuinely fires.
{
  const protoCarrier = document.createElement("div") as unknown as ShimNode;
  const proto = Object.getPrototypeOf(protoCarrier) as Record<string, unknown>;
  if (typeof proto.getBoundingClientRect !== "function") {
    proto.getBoundingClientRect = function (this: ShimNode): { height: number } {
      const h = this.style.getPropertyValue("height");
      const parsed = h ? parseFloat(h) : NaN;
      return { height: Number.isFinite(parsed) && parsed > 0 ? parsed : measuredRowHeight };
    };
  }
  // scrollTop is read by the windowed paint() to compute the slice. The shim has no layout, so
  // give every node a plain 0-defaulting scrollTop backed by a private field (a real element
  // starts at 0). Without this, viewport.scrollTop reads undefined and the slice maths go NaN,
  // mounting no rows. Defined on the prototype so it applies to every node, test-local only.
  if (!Object.getOwnPropertyDescriptor(proto, "scrollTop")) {
    Object.defineProperty(proto, "scrollTop", {
      configurable: true,
      get(this: ShimNode & { scrollTop_?: number }): number {
        return this.scrollTop_ ?? 0;
      },
      set(this: ShimNode & { scrollTop_?: number }, v: number): void {
        this.scrollTop_ = v;
      },
    });
  }
}

// The shim stores dataset writes in a plain object that is NOT mirrored to the element's
// attributes, so a [data-key="..."] attribute selector never matches (a real browser bridges
// el.dataset.key to the data-key attribute). The data table resolves the active row by that
// selector in focusRow and in its one-tab-stop guards, so without the bridge the roving and
// windowed-focus paths cannot be exercised. We install a mirroring dataset Proxy on every
// element the component creates by wrapping document.createElement(NS), entirely from the test
// (the shared shim file is untouched). Writes mirror into node.attrs as data-<kebab-key>;
// deletes clear the attribute. dataset reads still return the live value.
function kebab(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}
function installMirroringDataset(node: ShimNode): void {
  const backing: Record<string, string> = {};
  const proxy = new Proxy(backing, {
    set(target, prop: string, value: string): boolean {
      target[prop] = String(value);
      node.attrs[kebab(prop)] = String(value);
      return true;
    },
    deleteProperty(target, prop: string): boolean {
      delete target[prop];
      delete node.attrs[kebab(prop)];
      return true;
    },
  });
  Object.defineProperty(node, "dataset", { value: proxy, configurable: true, writable: true });
}
{
  const docAny = document as unknown as {
    createElement: (tag: string) => ShimNode;
    createElementNS: (ns: string, tag: string) => ShimNode;
  };
  const origCreate = docAny.createElement.bind(docAny);
  const origCreateNS = docAny.createElementNS.bind(docAny);
  docAny.createElement = (tag: string): ShimNode => {
    const n = origCreate(tag);
    installMirroringDataset(n);
    return n;
  };
  docAny.createElementNS = (ns: string, tag: string): ShimNode => {
    const n = origCreateNS(ns, tag);
    installMirroringDataset(n);
    return n;
  };
}

const { dataTable } = await import("../../src/components/data-table.ts");
import type { DataColumn, BulkAction } from "../../src/components/data-table-types.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: unknown, b: unknown, label: string): void {
  const cond = a === b;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures++;
}

// Shim-node bridges (the real render returns HTMLElement at the type level).
const SN = (n: unknown): ShimNode => n as unknown as ShimNode;
const attr = (n: unknown, k: string): string | null => SN(n).getAttribute(k);
const click = (n: unknown): void => SN(n).click();
const _fireKeydownOn = (n: unknown, key: string): boolean => SN(n).dispatchEvent(keydown({ key }) as ShimEvent);
function fireInput(input: unknown, value: string): void {
  SN(input).value = value;
  SN(input).dispatchEvent({
    type: "input",
    target: SN(input),
    currentTarget: SN(input),
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  } as ShimEvent);
}
function fireChange(input: unknown): void {
  SN(input).dispatchEvent({
    type: "change",
    target: SN(input),
    currentTarget: SN(input),
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  } as ShimEvent);
}
function fireScroll(viewport: unknown): void {
  SN(viewport).dispatchEvent({
    type: "scroll",
    target: SN(viewport),
    currentTarget: SN(viewport),
    defaultPrevented: false,
    bubbles: false,
    preventDefault() {},
    stopPropagation() {},
  } as ShimEvent);
}

// The shim's window.setTimeout is node's real timer; announceCount schedules a 30ms write. Wait
// past it so the live-region text settles before a test reads it.
async function settleAnnounce(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 50));
}

interface Row {
  id: string;
  name: string;
  records: number;
  status: "ok" | "failed";
}

const baseColumns: Array<DataColumn<Row>> = [
  { key: "name", header: "Name", render: (r) => r.name, sortable: true, sortValue: (r) => r.name },
  { key: "records", header: "Records", numeric: true, render: (r) => r.records, sortable: true, sortValue: (r) => r.records },
  { key: "status", header: "Status", render: (r) => r.status },
];

function rowsN(n: number, prefix = "row"): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `${prefix}-${i}`, name: `${prefix}-${String(i).padStart(3, "0")}`, records: (i * 7) % 50, status: i % 3 === 0 ? "failed" : "ok" });
  }
  return out;
}

async function main(): Promise<void> {
  // =========================================================================
  // 1. Basic render: a small table with NO toolbar features and no activation.
  //    The non-activatable wrap takes a focusable region role (WCAG 2.1.1).
  // =========================================================================
  console.log("\n-- data-table: basic render (no features) --");
  {
    const handle = dataTable<Row>({
      label: "Downpipes",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(3),
    });
    document.body.appendChild(handle.el);
    const root = handle.el;
    eq(SN(root).classList.contains("data-table"), true, "root carries the data-table class");
    eq(attr(root, "data-density"), "comfortable", "default density is comfortable");
    const tableEl = qs(root, "table")!;
    eq(attr(tableEl, "aria-label"), "Downpipes", "table carries the accessible label");
    const ths = qsa(root, "th");
    eq(ths.length, 3, "three header cells (no select column without bulk actions)");
    ok("every th has scope=col", ths.every((th) => attr(th, "scope") === "col"));
    ok("the numeric Records header gets the num class", classesOf(ths[1]).includes("num"));
    ok("a non-numeric header has no num class", !classesOf(ths[2]).includes("num"));
    const bodyRows = qsa(qs(root, "tbody"), "tr");
    eq(bodyRows.length, 3, "three body rows render");
    // Non-activatable: the wrap is a labelled focusable region for keyboard horizontal scroll.
    const wrap = qs(root, ".dt-wrap")!;
    eq(attr(wrap, "tabindex"), "0", "a non-activatable wrap is focusable for keyboard scroll");
    eq(attr(wrap, "role"), "region", "the non-activatable wrap is a region");
    eq(attr(wrap, "aria-label"), "Downpipes", "the wrap region is labelled");
    // No rows are role=button without onRowActivate.
    ok("no activatable rows without onRowActivate", qsa(root, "tr[role=button]").length === 0);
    SN(root).remove();
  }

  // =========================================================================
  // 2. Toolbar visibility: hidden under the min-row threshold (no active state),
  //    shown at or above it.
  // =========================================================================
  console.log("\n-- data-table: progressive toolbar visibility --");
  {
    const few = dataTable<Row>({
      label: "Few",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(3),
      filter: { placeholder: "Filter" },
    });
    document.body.appendChild(few.el);
    eq(SN(qs(few.el, ".dt-toolbar")).hidden, true, "the toolbar is hidden under the min-row threshold with no active filter");
    SN(few.el).remove();

    const many = dataTable<Row>({
      label: "Many",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(10),
      filter: { placeholder: "Filter" },
    });
    document.body.appendChild(many.el);
    eq(SN(qs(many.el, ".dt-toolbar")).hidden, false, "the toolbar is shown at or above the min-row threshold");
    SN(many.el).remove();

    // A restored filter forces the toolbar visible even with few rows (so active state is clearable).
    const restored = dataTable<Row>({
      label: "Restored",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(3),
      filter: { placeholder: "Filter" },
      initialState: { query: "row-000" },
    });
    document.body.appendChild(restored.el);
    eq(SN(qs(restored.el, ".dt-toolbar")).hidden, false, "a restored active filter keeps the toolbar visible under the threshold");
    SN(restored.el).remove();
  }

  // =========================================================================
  // 3. Filter input: typing narrows the set (debounced), updates the count, and
  //    a no-match query renders the filtered-empty card with a working Clear.
  // =========================================================================
  console.log("\n-- data-table: filter + filtered-empty + clear --");
  {
    // A recorder written only from inside a callback: on a local `let` the compiler keeps the
    // narrowing from its initialiser, because it cannot see the callback run, so the assertion below
    // reads as always-false and proves nothing. Narrowing on an object's properties is discarded at
    // each call, which is the assumption that holds here.
    const rec: { lastState: { query: string; facets: string[] } | null } = { lastState: null };
    const handle = dataTable<Row>({
      label: "Filterable",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(10),
      filter: { placeholder: "Filter rows", resultLabel: "downpipes" },
      onStateChange: (s) => { rec.lastState = { query: s.query, facets: s.facets }; },
    });
    document.body.appendChild(handle.el);
    const input = qs(handle.el, "input.dt-filter")!;
    eq(attr(input, "type"), "search", "the filter is a search input");
    eq(attr(input, "aria-label"), "Filter rows", "the filter is labelled by its placeholder");

    // Typing a matching query narrows to one row (the debounce timer fires after 120ms).
    fireInput(input, "row-003");
    await new Promise<void>((r) => setTimeout(r, 160));
    let bodyRows = qsa(qs(handle.el, "tbody"), "tr");
    eq(bodyRows.length, 1, "a matching query narrows the visible rows");
    ok("onStateChange fired with the query", rec.lastState !== null && rec.lastState.query === "row-003");
    await settleAnnounce();
    ok("the count reflects the filtered subset", textOf(qs(handle.el, ".dt-count")).includes("of 10"));

    // A no-match query renders the filtered-empty card.
    fireInput(input, "nothing-matches-xyz");
    await new Promise<void>((r) => setTimeout(r, 160));
    const emptyCard = qs(handle.el, ".dt-filtered-empty");
    ok("a no-match query renders the filtered-empty card", emptyCard !== null);
    ok("the filtered-empty card explains nothing matched", textOf(emptyCard).includes("No rows match"));

    // The Clear button resets the query and restores the full set; the input is cleared too.
    const clearBtn = qsa(emptyCard!, "button").find((b) => textOf(b).includes("Clear"))!;
    click(clearBtn);
    await new Promise<void>((r) => setTimeout(r, 20));
    eq(SN(input).value, "", "Clear empties the filter input");
    bodyRows = qsa(qs(handle.el, "tbody"), "tr");
    eq(bodyRows.length, 10, "Clear restores the full row set");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 3b. Filtered-empty Clear with FACETS present: clicking Clear resets every facet
  //     chip's aria-pressed (the facet-reset loop inside the Clear handler).
  // =========================================================================
  console.log("\n-- data-table: filtered-empty Clear resets facet chips --");
  {
    const handle = dataTable<Row>({
      label: "FacetClear",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(10),
      filter: { placeholder: "Filter" },
      // A facet whose predicate matches nothing, so activating it empties the visible set.
      facets: [{ id: "none", label: "Impossible", predicate: () => false }],
    });
    document.body.appendChild(handle.el);
    const chip = qs(handle.el, ".dt-facet")!;
    click(chip);
    eq(attr(chip, "aria-pressed"), "true", "the impossible facet is active");
    const emptyCard = qs(handle.el, ".dt-filtered-empty");
    ok("an empty-matching facet renders the filtered-empty card", emptyCard !== null);
    const clearBtn = qsa(emptyCard!, "button").find((b) => textOf(b).includes("Clear"))!;
    click(clearBtn);
    // The Clear handler resets every facet chip's pressed state and restores the full set.
    eq(attr(qs(handle.el, ".dt-facet"), "aria-pressed"), "false", "Clear resets the facet chip aria-pressed");
    eq(qsa(qs(handle.el, "tbody"), "tr").length, 10, "Clear restores the full set after a facet emptied it");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 4. Custom getText: the filter matches the caller-supplied text, not the cells.
  // =========================================================================
  console.log("\n-- data-table: filter getText override --");
  {
    const handle = dataTable<Row>({
      label: "GetText",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(10),
      filter: { placeholder: "Filter", getText: (r) => `tag-${r.records}` },
    });
    document.body.appendChild(handle.el);
    const input = qs(handle.el, "input.dt-filter")!;
    // "row-001" is in the rendered cells but NOT in getText, so it must NOT match.
    fireInput(input, "row-001");
    await new Promise<void>((r) => setTimeout(r, 160));
    ok("a query that matches a cell but not getText finds nothing", qs(handle.el, ".dt-filtered-empty") !== null);
    // "tag-0" matches the getText of the zero-records rows.
    fireInput(input, "tag-0");
    await new Promise<void>((r) => setTimeout(r, 160));
    ok("a query that matches getText narrows the set", qsa(qs(handle.el, "tbody"), "tr").length >= 1);
    SN(handle.el).remove();
  }

  // =========================================================================
  // 5. Facets: toggling a chip narrows by predicate, flips aria-pressed, and a
  //    second facet ANDs with the first. The result count reflects the subset.
  // =========================================================================
  console.log("\n-- data-table: faceted chips --");
  {
    const handle = dataTable<Row>({
      label: "Faceted",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(12),
      facets: [
        { id: "failed", label: "Failed", tone: "danger", predicate: (r) => r.status === "failed" },
        { id: "even", label: "Even records", predicate: (r) => r.records % 2 === 0 },
      ],
    });
    document.body.appendChild(handle.el);
    const facetWrap = qs(handle.el, ".dt-facets")!;
    eq(attr(facetWrap, "role"), "group", "the facet strip is a labelled group");
    const chips = qsa(facetWrap, ".dt-facet");
    eq(chips.length, 2, "two facet chips render");
    ok("a toned facet renders a leading dot", qs(chips[0], ".dot") !== null);
    eq(attr(chips[0], "aria-pressed"), "false", "a facet starts unpressed");

    const before = qsa(qs(handle.el, "tbody"), "tr").length;
    click(chips[0]);
    eq(attr(chips[0], "aria-pressed"), "true", "clicking a facet sets aria-pressed true");
    const afterFailed = qsa(qs(handle.el, "tbody"), "tr").length;
    ok("the failed facet narrows the set", afterFailed < before && afterFailed > 0);

    // Toggling it off again restores aria-pressed false (the delete branch).
    click(chips[0]);
    eq(attr(chips[0], "aria-pressed"), "false", "clicking an active facet toggles it off");
    eq(qsa(qs(handle.el, "tbody"), "tr").length, before, "toggling the facet off restores the full set");

    // Two facets AND together.
    click(chips[0]);
    click(chips[1]);
    const both = qsa(qs(handle.el, "tbody"), "tr").length;
    ok("two active facets AND (subset of either alone)", both <= afterFailed);
    SN(handle.el).remove();
  }

  // =========================================================================
  // 6. Sort: clicking a sortable header cycles asc -> desc -> none, sets aria-sort,
  //    and reorders the rows. A non-sortable column has no sort button.
  // =========================================================================
  console.log("\n-- data-table: sortable headers + cycle --");
  {
    const handle = dataTable<Row>({
      label: "Sortable",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(8),
    });
    document.body.appendChild(handle.el);
    const ths = qsa(handle.el, "th");
    // The Name and Records headers are sortable buttons; Status is not.
    const nameBtn = qs(ths[0], "button.dt-sort")!;
    ok("a sortable header is a real button", nameBtn !== null);
    ok("a non-sortable header has no sort button", qs(ths[2], "button.dt-sort") === null);
    eq(attr(ths[0], "aria-sort"), "none", "an unsorted header reports aria-sort none");

    const firstNameBefore = textOf(qsa(qsa(qs(handle.el, "tbody"), "tr")[0], "td")[0]);
    // Click 1: ascending.
    click(nameBtn);
    eq(attr(qsa(handle.el, "th")[0], "aria-sort"), "ascending", "first sort click is ascending");
    const firstAsc = textOf(qsa(qsa(qs(handle.el, "tbody"), "tr")[0], "td")[0]);
    ok("ascending sort puts the lowest name first", firstAsc <= firstNameBefore || firstAsc === "row-000");

    // Click 2: descending.
    click(qs(qsa(handle.el, "th")[0], "button.dt-sort"));
    eq(attr(qsa(handle.el, "th")[0], "aria-sort"), "descending", "second sort click is descending");
    const firstDesc = textOf(qsa(qsa(qs(handle.el, "tbody"), "tr")[0], "td")[0]);
    ok("descending sort puts the highest name first", firstDesc >= firstAsc);

    // Click 3: back to none (the original order returns).
    click(qs(qsa(handle.el, "th")[0], "button.dt-sort"));
    eq(attr(qsa(handle.el, "th")[0], "aria-sort"), "none", "third sort click clears the sort");

    // Sorting a DIFFERENT column from a sorted state takes the sortKey-changed branch.
    click(qs(qsa(handle.el, "th")[0], "button.dt-sort")); // name asc
    click(qs(qsa(handle.el, "th")[1], "button.dt-sort")); // switch to records asc
    eq(attr(qsa(handle.el, "th")[1], "aria-sort"), "ascending", "switching to a new sortable column sorts it ascending");
    eq(attr(qsa(handle.el, "th")[0], "aria-sort"), "none", "the previously sorted column resets to none");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 6b. initialSort + a sr-only sortable header (the visually-hidden header branch).
  // =========================================================================
  console.log("\n-- data-table: initialSort + sr-only header --");
  {
    const cols: Array<DataColumn<Row>> = [
      { key: "name", header: "Name", render: (r) => r.name, sortable: true, sortValue: (r) => r.name, srOnlyHeader: true },
      { key: "records", header: "Records", numeric: true, render: (r) => r.records },
    ];
    const handle = dataTable<Row>({
      label: "Initial",
      rowKey: (r) => r.id,
      columns: cols,
      rows: rowsN(6),
      initialSort: { key: "name", dir: "desc" },
    });
    document.body.appendChild(handle.el);
    eq(attr(qsa(handle.el, "th")[0], "aria-sort"), "descending", "initialSort applies the requested direction");
    ok("a sortable sr-only header keeps its label in a visually-hidden span", qs(qsa(handle.el, "th")[0], ".visually-hidden") !== null);
    // The first row is the highest name (desc) from initialSort.
    eq(textOf(qsa(qsa(qs(handle.el, "tbody"), "tr")[0], "td")[1]), String(rowsN(6).find((r) => r.name === "row-005")!.records), "initialSort desc orders rows on first paint");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 6c. A non-sortable column with a sr-only header (the non-sortable sr-only branch).
  // =========================================================================
  console.log("\n-- data-table: non-sortable sr-only header --");
  {
    const cols: Array<DataColumn<Row>> = [
      { key: "name", header: "Name", render: (r) => r.name },
      { key: "act", header: "Actions", srOnlyHeader: true, render: () => "x", width: "1px" },
    ];
    const handle = dataTable<Row>({
      label: "SrOnly",
      rowKey: (r) => r.id,
      columns: cols,
      rows: rowsN(3),
    });
    document.body.appendChild(handle.el);
    ok("a non-sortable sr-only header renders a visually-hidden span", qs(qsa(handle.el, "th")[1], ".visually-hidden") !== null);
    eq(SN(qsa(handle.el, "th")[1]).style.getPropertyValue("width"), "1px", "a column width hint is applied to the header");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 6d. cycleSort from a restored key with a NULL direction: the first click on the
  //     already-current column with no direction set takes the final else (-> ascending).
  // =========================================================================
  console.log("\n-- data-table: sort cycle from a null direction --");
  {
    const handle = dataTable<Row>({
      label: "NullDir",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(6),
      // A restored sortKey with no direction (the URL had a key but no dir): the header is
      // marked current but reports aria-sort none until the operator clicks it.
      initialState: { sortKey: "name", sortDir: null },
    });
    document.body.appendChild(handle.el);
    eq(attr(qsa(handle.el, "th")[0], "aria-sort"), "none", "a restored key with a null direction reports aria-sort none");
    // Clicking the already-current column with a null direction sets ascending (the final else).
    click(qs(qsa(handle.el, "th")[0], "button.dt-sort"));
    eq(attr(qsa(handle.el, "th")[0], "aria-sort"), "ascending", "clicking the current null-direction column sets ascending");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 6e. A windowed list WITHOUT onRowActivate: the viewport itself takes a focusable
  //     region role so a keyboard user can scroll the clipped columns (WCAG 2.1.1).
  // =========================================================================
  console.log("\n-- data-table: windowed list without row activation (focusable viewport) --");
  {
    const handle = dataTable<Row>({
      label: "BigNoActivate",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(300),
      windowThreshold: 150,
      // no onRowActivate
    });
    document.body.appendChild(handle.el);
    drainRaf();
    const viewport = qs(handle.el, ".dt-viewport")!;
    eq(attr(viewport, "tabindex"), "0", "a non-activatable windowed viewport is focusable for keyboard scroll");
    eq(attr(viewport, "role"), "region", "the non-activatable windowed viewport is a region");
    eq(attr(viewport, "aria-label"), "BigNoActivate", "the windowed viewport region is labelled");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 7. Selection + bulk bar: per-row checkboxes, a select-all header box with an
  //    indeterminate partial state, a bulk bar that appears on selection, a
  //    successful bulk action that clears the selection, and getSelected/clearSelection.
  // =========================================================================
  console.log("\n-- data-table: selection + bulk action (success) --");
  {
    const ran: Row[][] = [];
    const actions: Array<BulkAction<Row>> = [
      { id: "export", label: "Export", run: (rows) => { ran.push(rows); } },
      { id: "delete", label: "Delete", danger: true, run: (rows) => { ran.push(rows); } },
    ];
    const handle = dataTable<Row>({
      label: "Selectable",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(5),
      bulkActions: actions,
    });
    document.body.appendChild(handle.el);
    // The bulk bar exists but is hidden until a selection is made.
    const bulkBar = qs(handle.el, ".dt-bulkbar")!;
    eq(SN(bulkBar).hidden, true, "the bulk bar starts hidden");
    eq(attr(bulkBar, "aria-live"), "polite", "the bulk bar is a polite live region");
    // A select column header is present.
    eq(qsa(handle.el, "th").length, baseColumns.length + 1, "a select column header is added when bulk actions are present");

    // Select the first row via its checkbox.
    const rows = qsa(qs(handle.el, "tbody"), "tr");
    const firstBox = qs(rows[0], "input.dt-check")!;
    eq(attr(firstBox, "aria-label"), "Select row-000", "a per-row checkbox derives its label from the first column");
    SN(firstBox).checked = true;
    fireChange(firstBox);
    eq(SN(rows[0]).getAttribute("aria-selected"), "true", "selecting a row marks it aria-selected");
    eq(SN(bulkBar).hidden, false, "the bulk bar appears once a row is selected");
    ok("the bulk bar shows the selected count", textOf(bulkBar).includes("1 selected"));
    eq(handle.getSelected().length, 1, "getSelected reports the selected row");

    // The header box is now indeterminate (some, not all).
    const headBox = qs(qs(handle.el, "thead"), "input.dt-check")!;
    eq(SN(headBox).indeterminate, true, "the header box is indeterminate on a partial selection");

    // Selecting all via the header box.
    SN(headBox).checked = true;
    fireChange(headBox);
    eq(handle.getSelected().length, 5, "the header select-all selects every visible row");
    ok("the bulk bar shows all selected", textOf(qs(handle.el, ".dt-bulkbar")).includes("5 selected"));
    const headBoxAll = qs(qs(handle.el, "thead"), "input.dt-check")!;
    eq(SN(headBoxAll).checked, true, "the header box is checked when all are selected");
    eq(SN(headBoxAll).indeterminate, false, "the header box is not indeterminate when all are selected");

    // Run the Export bulk action: it receives all rows and clears the selection on resolve.
    const exportBtn = qsa(qs(handle.el, ".dt-bulkbar"), "button").find((b) => textOf(b).includes("Export"))!;
    ok("a non-danger bulk action uses the secondary button style", SN(exportBtn).className.includes("btn--secondary"));
    click(exportBtn);
    await flushAsync();
    eq(ran.length, 1, "the bulk action ran once");
    eq(ran[0]!.length, 5, "the bulk action received every selected row");
    eq(handle.getSelected().length, 0, "a resolved bulk action clears the selection by default");
    eq(SN(qs(handle.el, ".dt-bulkbar")).hidden, true, "the bulk bar hides again once the selection is cleared");

    // The danger action carries the danger button style (re-select a row to show the bar again).
    const aRow = qsa(qs(handle.el, "tbody"), "tr")[0];
    const aBox = qs(aRow, "input.dt-check")!;
    SN(aBox).checked = true;
    fireChange(aBox);
    const deleteBtn = qsa(qs(handle.el, ".dt-bulkbar"), "button").find((b) => textOf(b).includes("Delete"))!;
    ok("a danger bulk action uses the danger button style", SN(deleteBtn).className.includes("btn--danger"));

    // The header select-all UNCHECK branch: select all, then uncheck the header box (deletes every key).
    const headBox2 = qs(qs(handle.el, "thead"), "input.dt-check")!;
    SN(headBox2).checked = true;
    fireChange(headBox2);
    eq(handle.getSelected().length, 5, "header select-all re-selects every row");
    const headBox3 = qs(qs(handle.el, "thead"), "input.dt-check")!;
    SN(headBox3).checked = false;
    fireChange(headBox3);
    eq(handle.getSelected().length, 0, "unchecking the header select-all clears every row");

    // The bulk bar's Clear selection button empties the selection (re-select first).
    const reBox = qs(qsa(qs(handle.el, "tbody"), "tr")[0], "input.dt-check")!;
    SN(reBox).checked = true;
    fireChange(reBox);
    eq(handle.getSelected().length, 1, "a row is re-selected before testing Clear selection");
    const clearSel = qs(handle.el, ".dt-bulkbar__clear")!;
    click(clearSel);
    eq(handle.getSelected().length, 0, "the bulk bar Clear selection button empties the selection");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 7b. A bulk action that REJECTS: the error is surfaced in the bar and the
  //     selection is kept for retry (the catch branch).
  // =========================================================================
  console.log("\n-- data-table: bulk action rejection keeps selection --");
  {
    const origError = console.error;
    let loggedError = false;
    console.error = () => { loggedError = true; };
    try {
      const actions: Array<BulkAction<Row>> = [
        { id: "boom", label: "Detonate", run: async () => { throw new Error("engine unreachable"); } },
      ];
      const handle = dataTable<Row>({
        label: "Rejector",
        rowKey: (r) => r.id,
        columns: baseColumns,
        rows: rowsN(4),
        bulkActions: actions,
      });
      document.body.appendChild(handle.el);
      const box = qs(qsa(qs(handle.el, "tbody"), "tr")[0], "input.dt-check")!;
      SN(box).checked = true;
      fireChange(box);
      const btn = qsa(qs(handle.el, ".dt-bulkbar"), "button").find((b) => textOf(b).includes("Detonate"))!;
      click(btn);
      await flushAsync();
      ok("a rejected bulk action keeps the selection for retry", handle.getSelected().length === 1);
      ok("a rejected bulk action surfaces the failure in the bar", textOf(qs(handle.el, ".dt-bulkbar__n")).includes("failed"));
      ok("a rejected bulk action echoes the error message", textOf(qs(handle.el, ".dt-bulkbar__n")).includes("engine unreachable"));
      ok("a rejected bulk action logs the detail for the developer", loggedError);
      SN(handle.el).remove();
    } finally {
      console.error = origError;
    }
  }

  // =========================================================================
  // 7c. keepSelection:true keeps the selection after a successful run.
  // =========================================================================
  console.log("\n-- data-table: bulk action keepSelection --");
  {
    const actions: Array<BulkAction<Row>> = [
      { id: "tag", label: "Tag", keepSelection: true, run: () => {} },
    ];
    const handle = dataTable<Row>({
      label: "Keep",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(4),
      bulkActions: actions,
    });
    document.body.appendChild(handle.el);
    const box = qs(qsa(qs(handle.el, "tbody"), "tr")[0], "input.dt-check")!;
    SN(box).checked = true;
    fireChange(box);
    const btn = qsa(qs(handle.el, ".dt-bulkbar"), "button").find((b) => textOf(b).includes("Tag"))!;
    click(btn);
    await flushAsync();
    eq(handle.getSelected().length, 1, "keepSelection:true keeps the selection after a successful run");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 7d. Deselecting a row via its checkbox (the box.checked=false branch) and the
  //     syncHeaderCheckbox path after a partial change.
  // =========================================================================
  console.log("\n-- data-table: per-row deselect --");
  {
    const handle = dataTable<Row>({
      label: "Deselect",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(4),
      bulkActions: [{ id: "x", label: "X", run: () => {} }],
      rowLabel: (r) => r.name,
    });
    document.body.appendChild(handle.el);
    const rows = qsa(qs(handle.el, "tbody"), "tr");
    const box0 = qs(rows[0], "input.dt-check")!;
    eq(attr(box0, "aria-label"), "Select row-000", "rowLabel supplies the checkbox label when provided");
    // Select then deselect the same row.
    SN(box0).checked = true;
    fireChange(box0);
    eq(handle.getSelected().length, 1, "selecting the row registers it");
    SN(box0).checked = false;
    fireChange(box0);
    eq(handle.getSelected().length, 0, "deselecting the row via its checkbox removes it");
    eq(SN(rows[0]).getAttribute("aria-selected"), null, "deselecting clears aria-selected on the row");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 8. Row activation + roving tabindex: Enter/Space/click open the detail; a click
  //    on an inner control does NOT activate; ArrowDown/Up/Home/End move the active row.
  // =========================================================================
  console.log("\n-- data-table: row activation + roving keys --");
  {
    let activated: Row | null = null;
    const handle = dataTable<Row>({
      label: "Activatable",
      rowKey: (r) => r.id,
      columns: [
        ...baseColumns,
        { key: "act", header: "Actions", srOnlyHeader: true, render: () => {
          const b = document.createElement("button");
          b.textContent = "Open";
          return b as unknown as HTMLElement;
        } },
      ],
      rows: rowsN(6),
      onRowActivate: (r) => { activated = r; },
    });
    document.body.appendChild(handle.el);
    const rows = qsa(qs(handle.el, "tbody"), "tr");
    eq(attr(rows[0], "role"), "button", "an activatable row is role=button");
    eq(attr(rows[0], "tabindex"), "0", "the first row is the single tab stop");
    eq(attr(rows[1], "tabindex"), "-1", "a non-active row is out of the tab order");
    // The wrap is NOT a focusable region when rows are activatable (focus lives on the rows).
    ok("the wrap is not a separate region when rows are activatable", attr(qs(handle.el, ".dt-wrap"), "role") !== "region");

    // Click activates.
    click(rows[2]);
    eq(activated && (activated as Row).id, "row-2", "a row click activates that row");

    // Enter + Space activate (target must be the row itself).
    activated = null;
    const enterEv = keydown({ key: "Enter" });
    enterEv.target = SN(rows[1]);
    SN(rows[1]).dispatchEvent(enterEv as ShimEvent);
    eq(activated && (activated as Row).id, "row-1", "Enter on a row activates it");
    activated = null;
    const spaceEv = keydown({ key: " " });
    spaceEv.target = SN(rows[3]);
    SN(rows[3]).dispatchEvent(spaceEv as ShimEvent);
    eq(activated && (activated as Row).id, "row-3", "Space on a row activates it");

    // A click that originates on an inner control must NOT activate the row.
    activated = null;
    const innerBtn = qs(rows[0], "button")!;
    click(innerBtn);
    ok("a click on an inner control does not activate the row", activated === null);

    // Roving keys: ArrowDown from the tbody moves the active stop to the next row.
    const tbody = qs(handle.el, "tbody")!;
    const downEv = keydown({ key: "ArrowDown" });
    downEv.target = SN(rows[0]);
    SN(tbody).dispatchEvent(downEv as ShimEvent);
    eq(attr(qsa(qs(handle.el, "tbody"), "tr")[1], "tabindex"), "0", "ArrowDown moves the tab stop to the next row");
    ok("ArrowDown moves focus to the next row", activeElement() === (qsa(qs(handle.el, "tbody"), "tr")[1] as unknown as ShimNode));

    // ArrowUp moves it back.
    const r1 = qsa(qs(handle.el, "tbody"), "tr")[1];
    const upEv = keydown({ key: "ArrowUp" });
    upEv.target = SN(r1);
    SN(tbody).dispatchEvent(upEv as ShimEvent);
    eq(attr(qsa(qs(handle.el, "tbody"), "tr")[0], "tabindex"), "0", "ArrowUp moves the tab stop back up");

    // End jumps to the last row; Home back to the first.
    const r0 = qsa(qs(handle.el, "tbody"), "tr")[0];
    const endEv = keydown({ key: "End" });
    endEv.target = SN(r0);
    SN(tbody).dispatchEvent(endEv as ShimEvent);
    eq(attr(qsa(qs(handle.el, "tbody"), "tr")[5], "tabindex"), "0", "End jumps the tab stop to the last row");
    const rLast = qsa(qs(handle.el, "tbody"), "tr")[5];
    const homeEv = keydown({ key: "Home" });
    homeEv.target = SN(rLast);
    SN(tbody).dispatchEvent(homeEv as ShimEvent);
    eq(attr(qsa(qs(handle.el, "tbody"), "tr")[0], "tabindex"), "0", "Home jumps the tab stop to the first row");

    // A key on a row that is already at the boundary is a no-op (next === idx returns early).
    const atTop = qsa(qs(handle.el, "tbody"), "tr")[0];
    const upAtTop = keydown({ key: "ArrowUp" });
    upAtTop.target = SN(atTop);
    const handled = SN(tbody).dispatchEvent(upAtTop as ShimEvent);
    ok("ArrowUp at the first row is a no-op (not prevented)", handled === true);

    // A non-navigation key is ignored by the roving handler.
    const tabEv = keydown({ key: "Tab" });
    tabEv.target = SN(qsa(qs(handle.el, "tbody"), "tr")[0]);
    ok("a non-navigation key is ignored by the roving handler", SN(tbody).dispatchEvent(tabEv as ShimEvent) === true);
    SN(handle.el).remove();
  }

  // =========================================================================
  // 8b. The renderPlain one-tab-stop guard: when the active row is replaced out from
  //     under the table (setRows drops it) the guard restores a single tab stop on the
  //     first row, so a keyboard user is never stranded with zero stops.
  // =========================================================================
  console.log("\n-- data-table: roving stop restored after the active row is replaced --");
  {
    const handle = dataTable<Row>({
      label: "Restranded",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(5),
      onRowActivate: () => {},
    });
    document.body.appendChild(handle.el);
    const tbody = qs(handle.el, "tbody")!;
    // Move the active stop to row index 3 via roving.
    const r0 = qsa(tbody, "tr[data-key]")[0]!;
    const endEv = keydown({ key: "End" });
    endEv.target = SN(r0);
    SN(tbody).dispatchEvent(endEv as ShimEvent);
    eq(attr(qsa(qs(handle.el, "tbody"), "tr")[4], "tabindex"), "0", "the active stop moved off the first row");
    // Replace the rows with a set that does NOT contain the active key: the guard restores a stop.
    handle.setRows(rowsN(4, "fresh"));
    const newRows = qsa(qs(handle.el, "tbody"), "tr[data-key]");
    const stops = newRows.filter((r) => attr(r, "tabindex") === "0");
    eq(stops.length, 1, "exactly one tab stop remains after the active row is replaced");
    eq(attr(newRows[0], "tabindex"), "0", "the restored tab stop is on the first row");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 9. Density toggle: switching to compact updates the root attribute, the
  //    aria-pressed state and the live announcement, and re-renders.
  // =========================================================================
  console.log("\n-- data-table: density toggle --");
  {
    const handle = dataTable<Row>({
      label: "Dense",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(10),
      density: true,
    });
    document.body.appendChild(handle.el);
    const group = qs(handle.el, ".dt-density")!;
    eq(attr(group, "role"), "group", "the density toggle is a labelled group");
    const btns = qsa(group, ".dt-density__btn");
    eq(btns.length, 2, "two density buttons");
    eq(attr(btns[0], "aria-pressed"), "true", "comfortable starts pressed");
    eq(attr(btns[1], "aria-pressed"), "false", "compact starts unpressed");

    click(btns[1]); // compact
    eq(attr(handle.el, "data-density"), "compact", "selecting compact updates the root density attribute");
    eq(attr(qsa(qs(handle.el, ".dt-density"), ".dt-density__btn")[1], "aria-pressed"), "true", "compact becomes pressed");
    eq(attr(qsa(qs(handle.el, ".dt-density"), ".dt-density__btn")[0], "aria-pressed"), "false", "comfortable becomes unpressed");
    ok("the density change is announced politely", textOf(qs(handle.el, ".dt-density .visually-hidden")).includes("density"));

    click(qsa(qs(handle.el, ".dt-density"), ".dt-density__btn")[0]); // back to comfortable
    eq(attr(handle.el, "data-density"), "comfortable", "selecting comfortable updates the root density attribute back");
    SN(handle.el).remove();
  }

  // =========================================================================
  // 10. True-empty (no rows at all): the default empty node, and a custom empty node.
  // =========================================================================
  console.log("\n-- data-table: true-empty states --");
  {
    const handle = dataTable<Row>({
      label: "Empty",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: [],
    });
    document.body.appendChild(handle.el);
    const empty = qs(handle.el, ".dp-table__empty");
    ok("a truly empty table renders the default empty node", empty !== null);
    eq(textOf(empty), "No rows.", "the default empty text reads No rows.");
    SN(handle.el).remove();

    const custom = document.createElement("div");
    custom.className = "my-empty";
    custom.textContent = "Nothing to back up yet.";
    const handle2 = dataTable<Row>({
      label: "CustomEmpty",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: [],
      empty: custom as unknown as Node,
    });
    document.body.appendChild(handle2.el);
    ok("a caller-supplied empty node is used for the true-empty state", qs(handle2.el, ".my-empty") !== null);
    SN(handle2.el).remove();
  }

  // =========================================================================
  // 11. Windowing: a dataset past the threshold renders a windowed viewport with
  //     aria-rowcount, spacer rows, only the visible slice mounted, and a scroll
  //     handler that swaps the slice. The rAF corrective repaint runs once.
  // =========================================================================
  console.log("\n-- data-table: windowed large list --");
  {
    let activated: Row | null = null;
    const handle = dataTable<Row>({
      label: "Big",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(300),
      windowThreshold: 150,
      onRowActivate: (r) => { activated = r; },
    });
    document.body.appendChild(handle.el);
    drainRaf(); // run the one corrective repaint queued on first paint
    const tableEl = qs(handle.el, "table.dt-table--windowed")!;
    ok("a large list renders a windowed table", tableEl !== null);
    eq(attr(tableEl, "aria-rowcount"), String(300 + 1), "aria-rowcount reports the true total plus the header");
    const viewport = qs(handle.el, ".dt-viewport")!;
    ok("the windowed body has a scrollable viewport", viewport !== null);
    // Spacer rows keep the scrollbar honest.
    ok("the windowed body has spacer rows", qsa(handle.el, ".dt-spacer").length === 2);
    // Only a slice of the 300 data rows is mounted.
    const mountedData = qsa(qs(handle.el, "tbody"), "tr[data-key]");
    ok("only a slice of rows is mounted (windowing)", mountedData.length > 0 && mountedData.length < 300);
    // The first mounted data row carries aria-rowindex (1-based, header is 1).
    ok("a windowed data row carries aria-rowindex", attr(mountedData[0], "aria-rowindex") !== null);
    // A windowed announcement notes scrolling reveals more.
    ok("a windowed table announces that scrolling reveals more rows", textOf(qs(handle.el, ".dt-windowed-wrap .visually-hidden")).includes("scroll to load more"));

    // Scroll down: the paint() handler swaps the slice (a different start index).
    const firstKeyBefore = attr(mountedData[0], "data-key");
    SN(viewport).scrollTop = 200 * 49; // jump well down
    fireScroll(viewport);
    const mountedAfter = qsa(qs(handle.el, "tbody"), "tr[data-key]");
    const firstKeyAfter = attr(mountedAfter[0], "data-key");
    ok("scrolling swaps the rendered slice", firstKeyBefore !== firstKeyAfter);

    // A second scroll to the SAME slice start is a no-op (the start===lastStart early return).
    const keyAtSame = attr(qsa(qs(handle.el, "tbody"), "tr[data-key]")[0], "data-key");
    fireScroll(viewport); // scrollTop unchanged -> same start
    eq(attr(qsa(qs(handle.el, "tbody"), "tr[data-key]")[0], "data-key"), keyAtSame, "a scroll to the same slice does not re-render");

    // Activating a windowed row still works (roving handler reads live rows by key).
    const aRow = qsa(qs(handle.el, "tbody"), "tr[data-key]")[0];
    click(aRow);
    ok("a windowed row activates on click", activated !== null);
    SN(handle.el).remove();
  }

  // =========================================================================
  // 11b. focusRow into an off-screen windowed row: pressing End from a mounted row
  //      scrolls the viewport and focuses the row on the next frame (the rAF path).
  // =========================================================================
  console.log("\n-- data-table: windowed roving to an off-screen row --");
  {
    // Make the measured row height match the comfortable assumption (49) so the corrective
    // repaint is a no-op and focusRow's scroll target (which uses the configured height) lines
    // up with the painted slice, exactly as it would in a browser at default zoom.
    setMeasuredRowHeight(49);
    const handle = dataTable<Row>({
      label: "BigRove",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(300),
      windowThreshold: 150,
      onRowActivate: () => {},
    });
    document.body.appendChild(handle.el);
    drainRaf();
    const tbody = qs(handle.el, "tbody")!;
    const firstRow = qsa(tbody, "tr[data-key]")[0]!;
    // End jumps to row index 299, which is off-screen: focusRow scrolls then focuses on rAF.
    const endEv = keydown({ key: "End" });
    endEv.target = SN(firstRow);
    SN(tbody).dispatchEvent(endEv as ShimEvent);
    // The paint() that the scroll triggers mounts the tail; the queued rAF then focuses it.
    fireScroll(qs(handle.el, ".dt-viewport"));
    drainRaf();
    const last = qsa(qs(handle.el, "tbody"), "tr[data-key]").find((r) => attr(r, "data-key") === "row-299");
    ok("End in a windowed table scrolls the last row into view", last !== undefined);
    ok("the off-screen target row becomes the tab stop after the scroll", last !== undefined && attr(last, "tabindex") === "0");
    SN(handle.el).remove();
    setMeasuredRowHeight(60); // restore the differing default for any later windowed render
  }

  // =========================================================================
  // 12. setRows: replacing rows updates the body and drops selections for rows
  //     that no longer exist. clearSelection empties the selection. focusFilter
  //     focuses the filter input. getState reflects the live filter/sort.
  // =========================================================================
  console.log("\n-- data-table: handle methods (setRows / clearSelection / focusFilter / getState) --");
  {
    const handle = dataTable<Row>({
      label: "Handle",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(10),
      filter: { placeholder: "Filter" },
      bulkActions: [{ id: "x", label: "X", run: () => {} }],
    });
    document.body.appendChild(handle.el);

    // Select two rows.
    const rows = qsa(qs(handle.el, "tbody"), "tr");
    for (const i of [0, 1]) {
      const b = qs(rows[i], "input.dt-check")!;
      SN(b).checked = true;
      fireChange(b);
    }
    eq(handle.getSelected().length, 2, "two rows selected before setRows");

    // Replace the rows so that row-0 survives but row-1 is gone: the stale selection is dropped.
    handle.setRows([rowsN(10)[0]!, ...rowsN(10, "fresh")]);
    eq(qsa(qs(handle.el, "tbody"), "tr").length, 11, "setRows renders the replacement set");
    eq(handle.getSelected().length, 1, "setRows drops selections for rows that no longer exist");

    // clearSelection empties what remains.
    handle.clearSelection();
    eq(handle.getSelected().length, 0, "clearSelection empties the selection");

    // focusFilter moves focus to the filter input.
    handle.focusFilter();
    ok("focusFilter focuses the filter input", activeElement() === (qs(handle.el, "input.dt-filter") as unknown as ShimNode));

    // getState reflects the live state (a sort applied via the header shows up). With bulk actions
    // the first th is the select column, so Records is the third header.
    const recordsHeader = qsa(handle.el, "th").find((t) => textOf(t).includes("Records"))!;
    click(qs(recordsHeader, "button.dt-sort"));
    const state = handle.getState();
    eq(state.sortKey, "records", "getState reports the live sort key");
    eq(state.sortDir, "asc", "getState reports the live sort direction");
    ok("getState reports an empty facet list when none are active", Array.isArray(state.facets) && state.facets.length === 0);
    SN(handle.el).remove();
  }

  // =========================================================================
  // 13. The whole toolbar (filter + facets + density) composes, and a sr-only-free
  //     header default renders the header as a plain text node.
  // =========================================================================
  console.log("\n-- data-table: full toolbar composition --");
  {
    const handle = dataTable<Row>({
      label: "Full",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(20),
      filter: { placeholder: "Search" },
      facets: [{ id: "ok", label: "OK", predicate: (r) => r.status === "ok" }],
      density: true,
      bulkActions: [{ id: "x", label: "X", run: () => {} }],
    });
    document.body.appendChild(handle.el);
    ok("the toolbar has a filter", qs(handle.el, "input.dt-filter") !== null);
    ok("the toolbar has facets", qs(handle.el, ".dt-facets") !== null);
    ok("the toolbar has a density toggle", qs(handle.el, ".dt-density") !== null);
    ok("a plain (non-sortable, non-sr-only) header renders its text", textOf(qsa(handle.el, "th").find((t) => textOf(t).includes("Status"))!).includes("Status"));
    SN(handle.el).remove();
  }

  // =========================================================================
  // 14. Edge branches: a restored ACTIVE facet renders pre-pressed; a windowed list at
  //     COMPACT density; a per-row checkbox label that falls back to the positional label
  //     when the first column has no text; and a bulk rejection that throws a non-Error.
  // =========================================================================
  console.log("\n-- data-table: edge branches --");
  {
    // 14a. A restored active facet (initialState.facets) renders with aria-pressed already true.
    const handle = dataTable<Row>({
      label: "RestoredFacet",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(12),
      facets: [{ id: "failed", label: "Failed", predicate: (r) => r.status === "failed" }],
      initialState: { facets: ["failed"] },
    });
    document.body.appendChild(handle.el);
    eq(attr(qs(handle.el, ".dt-facet"), "aria-pressed"), "true", "a restored active facet renders pre-pressed");
    ok("a restored active facet narrows the first paint", qsa(qs(handle.el, "tbody"), "tr").length < 12);
    SN(handle.el).remove();
  }
  {
    // 14b. A windowed list at compact density: renderWindowed reads the compact row height.
    const handle = dataTable<Row>({
      label: "BigCompact",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(300),
      windowThreshold: 150,
      density: true,
      initialDensity: "compact",
    });
    document.body.appendChild(handle.el);
    drainRaf();
    eq(attr(handle.el, "data-density"), "compact", "the windowed table starts at compact density");
    ok("a compact windowed table still mounts a slice", qsa(qs(handle.el, "tbody"), "tr[data-key]").length > 0);
    SN(handle.el).remove();
  }
  {
    // 14c. A per-row checkbox whose first column renders empty text falls back to "row N".
    const cols: Array<DataColumn<Row>> = [
      { key: "blank", header: "Blank", render: () => "" },
      { key: "name", header: "Name", render: (r) => r.name },
    ];
    const handle = dataTable<Row>({
      label: "BlankFirst",
      rowKey: (r) => r.id,
      columns: cols,
      rows: rowsN(3),
      bulkActions: [{ id: "x", label: "X", run: () => {} }],
      // no rowLabel, so the table derives from the first column (which is blank).
    });
    document.body.appendChild(handle.el);
    const firstBox = qs(qsa(qs(handle.el, "tbody"), "tr")[0], "input.dt-check")!;
    eq(attr(firstBox, "aria-label"), "Select row 1", "an empty first column falls back to a positional row label");
    SN(handle.el).remove();
  }
  {
    // 14d. A bulk rejection that throws a NON-Error value: the message falls back to "error".
    const origError = console.error;
    console.error = () => {};
    try {
      const handle = dataTable<Row>({
        label: "NonErrorThrow",
        rowKey: (r) => r.id,
        columns: baseColumns,
        rows: rowsN(3),
        bulkActions: [{ id: "boom", label: "Boom", run: async () => { throw "a bare string"; } }],
      });
      document.body.appendChild(handle.el);
      const box = qs(qsa(qs(handle.el, "tbody"), "tr")[0], "input.dt-check")!;
      SN(box).checked = true;
      fireChange(box);
      click(qsa(qs(handle.el, ".dt-bulkbar"), "button").find((b) => textOf(b).includes("Boom"))!);
      await flushAsync();
      ok("a non-Error bulk throw still keeps the selection", handle.getSelected().length === 1);
      ok("a non-Error bulk throw surfaces the generic error wording", textOf(qs(handle.el, ".dt-bulkbar__n")).includes("(error)"));
      SN(handle.el).remove();
    } finally {
      console.error = origError;
    }
  }
  {
    // 14f. A selectable table with NO data columns: the per-row checkbox label derivation has
    // no first column to read, so it falls back to the positional "row N" label (the firstCol
    // false branch). An unusual configuration, but a valid one the guard exists for.
    const handle = dataTable<Row>({
      label: "NoColumns",
      rowKey: (r) => r.id,
      columns: [],
      rows: rowsN(2),
      bulkActions: [{ id: "x", label: "X", run: () => {} }],
    });
    document.body.appendChild(handle.el);
    const box = qs(qsa(qs(handle.el, "tbody"), "tr")[0], "input.dt-check")!;
    eq(attr(box, "aria-label"), "Select row 1", "a column-less selectable table uses the positional row label");
    SN(handle.el).remove();
  }
  {
    // 14e. The roving handler ignores a key whose target resolves to a spacer row (windowed):
    // a keydown originating on the aria-hidden spacer must be a no-op (the dt-spacer guard).
    const handle = dataTable<Row>({
      label: "SpacerKey",
      rowKey: (r) => r.id,
      columns: baseColumns,
      rows: rowsN(300),
      windowThreshold: 150,
      onRowActivate: () => {},
    });
    document.body.appendChild(handle.el);
    drainRaf();
    const tbody = qs(handle.el, "tbody")!;
    const spacer = qs(handle.el, ".dt-spacer")!;
    const ev = keydown({ key: "ArrowDown" });
    ev.target = SN(spacer);
    ok("a roving key on a spacer row is a no-op (not prevented)", SN(tbody).dispatchEvent(ev as ShimEvent) === true);
    SN(handle.el).remove();
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(failures === 0 ? "\nDATA-TABLE COVERAGE VECTORS PASS" : `\n${failures} FAILURE(S)`);
  // Driving the real table schedules production timers (the debounce, the announceCount tick).
  // Exit deterministically so a late tick can never flip a green run.
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nCOMPONENTS-DATA-TABLE THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
