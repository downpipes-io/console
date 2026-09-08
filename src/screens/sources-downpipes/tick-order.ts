// Tick-order tracking for the destination fan-out pickers (3-2-1). A LEAF: no imports, so both the
// create-wizard picker (./destination-fanout.ts) and the edit-editor picker
// (./editor-destination-section.ts) can share one implementation rather than each keeping its own
// copy of the ordering rule, which is how the two drifted apart in the first place.
//
// WHY THIS EXISTS. Index 0 of destinationIds is the PRIMARY the run seals to (engine
// src/sched/destinations.ts primaryDestinationId takes the first non-blank entry), and a restore
// reads its own bucket. Both pickers used to report the ticked ids by walking the checkboxes in LIST
// order, which makes the primary whichever destination happens to be listed first rather than the one
// the operator ticked first. Every statement of the contract says the opposite: the on-screen summary
// ("the first ticked is the primary"), the field catalogue row for the control, and the published docs
// page (backing-up/multiple-destinations, "Tick order is the selection order: the first ticked is
// index 0, the primary"). So the DOM was the only thing saying list order, and it is the DOM that was
// wrong.

// tickOrderTracker returns a sync function. Feed it the currently-ticked ids each time the selection
// changes and it returns them in the order they were TICKED: unticking drops an id, re-ticking appends
// it at the end, and everything else keeps the position it already had.
//
// seed is the order an existing selection already has (the edit path passes the downpipe's stored
// destinationIds). Seeding rather than inferring matters because tick order was never persisted: a
// stored list can only be taken at face value, never reconstructed. Anything in seed that is not
// actually ticked is dropped on the first sync, so a stale seed cannot invent a selection.
export function tickOrderTracker(seed: readonly string[] = []): (tickedIds: readonly string[]) => string[] {
  let order: string[] = [...seed];
  return (tickedIds: readonly string[]): string[] => {
    const ticked = new Set(tickedIds);
    // Drop what is no longer ticked, leaving the survivors in their established tick order.
    order = order.filter((id) => ticked.has(id));
    // Append what is newly ticked. Normally that is a single id (one change event, one checkbox).
    // Several can arrive together only on the first sync of a pre-ticked render, and there the caller
    // has already put the rows in stored order, so appending in the given order preserves it.
    for (const id of tickedIds) if (!order.includes(id)) order.push(id);
    return [...order];
  };
}
