// The pure helpers behind the configurable data table (data-table.ts): the safe cell
// append/extract pair, the sort comparator, the key escaper, and the windowing slice
// maths, plus the test-seam exports. Split out as a dependency-light sibling so the
// component module stays under the size budget; these are all module-level pure functions
// with no closure over the table's state, so the move is behaviour-preserving and the
// component imports them back. Moved verbatim from data-table.ts; data-table.ts re-exports
// the test seams by name so the public surface is identical.
//
// House rules: Australian English, no em dashes, precise claims. No DOM is constructed at
// import time; cellText/cssEscape touch the DOM only when invoked from the render path.

import type { Child } from "../lib/dom.ts";

// appendCell adds a Child to a cell safely (strings/numbers as text nodes, nodes as-is,
// nullish/false skipped) so a server string can never inject markup.
export function appendCell(td: HTMLElement, cell: Child): void {
  if (cell === null || cell === undefined || cell === false) return;
  if (typeof cell === "string" || typeof cell === "number") td.appendChild(document.createTextNode(String(cell)));
  else td.appendChild(cell);
}

// cellText extracts the visible text of a rendered cell for the /-filter and the
// fallback row text. A node contributes its textContent; a string/number its string.
export function cellText(cell: Child): string {
  if (cell === null || cell === undefined || cell === false) return "";
  if (typeof cell === "string" || typeof cell === "number") return String(cell);
  return cell.textContent ?? "";
}

// compareCells orders two sort values: numbers numerically, strings case-insensitively,
// with null/undefined sorting last (so missing values sink rather than jump to the top).
export function compareCells(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

// cssEscape escapes a row key for a [data-key="..."] attribute selector. CSS.escape is
// available in the browser; this guards the type-narrowing and a non-DOM test env.
export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Test-seam exports (pure logic only; zero behaviour change in production).
// Exported under a _test prefix so the call sites are never the production
// path and a future removal cannot accidentally break the public API.
// ---------------------------------------------------------------------------

// windowSlice computes the render slice indices for the windowed viewport:
// the index of the first row to mount (start) and the exclusive end (end), given
// the scroll position (scrollTop), row height, viewport height, and overscan.
// This is the pure-maths core of renderWindowed's paint() callback; extracting it
// here makes the arithmetic directly assertable without a DOM or a scroll event.
export function _testWindowSlice(
  scrollTop: number,
  total: number,
  rowH: number,
  viewportH: number,
  overscan: number,
): { start: number; end: number } {
  const visibleCount = Math.ceil(viewportH / rowH);
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(total, start + visibleCount + overscan * 2);
  return { start, end };
}

// _testCompareCells exposes the sort comparator for the validator.
export { compareCells as _testCompareCells };

// _testBulkActionRejection models the try/catch guard in refreshBulkBar's click
// handler in pure form: it drives a run() call through the guard and returns
// { selectionCleared, errorLogged } so the test can assert that a rejected
// run() surfaces an error and does NOT clear the selection (the operator can
// retry), while a resolved run() clears the selection normally.
export async function _testBulkActionRejection(
  run: () => void | Promise<void>,
  keepSelection: boolean,
): Promise<{ selectionCleared: boolean; errorLogged: boolean }> {
  let selectionCleared = false;
  let errorLogged = false;

  try {
    await run();
  } catch (err) {
    errorLogged = true;
    void err;
    return { selectionCleared, errorLogged: true };
  }
  if (!keepSelection) {
    selectionCleared = true;
  }
  return { selectionCleared, errorLogged };
}
