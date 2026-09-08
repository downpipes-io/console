// The destination fan-out picker (3-2-1), driven through the REAL destinationFanout.
//
//   node test/validate-destination-fanout.ts
//
// What this control decides: which destinations a downpipe copies every run to, and WHICH ONE IS THE
// PRIMARY. Getting the set wrong sends backups somewhere unintended; getting the ORDER wrong changes
// which copy a restore reads first. The control is shared by the create wizard and the Sources
// bulk-protect tier, so a defect here reaches both.
//
// The subtlety worth pinning hardest is the ordering rule: the picker reports ids in the order they
// were TICKED, so ticking the third destination and then the first makes the THIRD the primary.
//
// This file used to assert the opposite, because the picker used to walk the checkboxes in list order
// and report that. Every statement of the contract disagreed with it: the on-screen summary ("the first
// ticked is the primary"), the field catalogue row for the control ("tick order = the fan-out order"),
// and the published docs page backing-up/multiple-destinations ("Tick order is the selection order: the
// first ticked is index 0, the primary"). List order meant the primary the run seals to, and therefore
// the bucket a restore reads, was decided by however the destinations happened to be listed rather than
// by the operator's choice. The code now matches the promise, and section (4) pins THAT.

import { installDomShim, qsa, textOf } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
installDomShim();

const { destinationFanout } = await import("../src/screens/sources-downpipes/destination-fanout.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

type Dest = { id?: string; label?: string; bucket?: string; isDefault?: boolean };

// build renders the picker and captures every setChosenDestinationIds call, because the assertions are
// about what the caller is TOLD, not about what the DOM looks like.
function build(destinations: Dest[], destLine = "one copy to the default destination"): {
  el: HTMLElement;
  calls: string[][];
  last: () => string[] | undefined;
} {
  const calls: string[][] = [];
  const el = destinationFanout({ destinations, destLine, setChosenDestinationIds: (ids) => calls.push([...ids]) });
  markConnected(el as unknown as never);
  return { el, calls, last: () => calls[calls.length - 1] };
}

function boxes(el: HTMLElement): Array<{ value: string; checked: boolean; dispatchEvent: (e: ReturnType<typeof makeEvent>) => void }> {
  return qsa(el, "input") as unknown as Array<{ value: string; checked: boolean; dispatchEvent: (e: ReturnType<typeof makeEvent>) => void }>;
}

// tick sets checked and fires change, exactly as a browser would; the picker listens for change.
function tick(el: HTMLElement, value: string, checked = true): void {
  const cb = boxes(el).find((b) => b.value === value);
  if (cb === undefined) throw new Error(`no checkbox for ${value}`);
  cb.checked = checked;
  cb.dispatchEvent(makeEvent({ type: "change" }));
}

function summaryText(el: HTMLElement): string {
  const ps = qsa(el, "p");
  return ps.map((p) => textOf(p as unknown as never)).join(" ");
}

const THREE: Dest[] = [
  { id: "d1", label: "Primary R2", isDefault: true },
  { id: "d2", label: "Off-site S3" },
  { id: "d3", bucket: "cold-archive" },
];

async function main(): Promise<void> {
  console.log("(1) one destination or none degrades to the caller's summary line, with no picker");
    for (const ds of [[], [{ id: "d1", label: "Only" }]] as Dest[][]) {
      const { el, calls } = build(ds, "one copy to R2");
      ok(`(1) ${ds.length} destination(s): renders the caller's line`, textOf(el as unknown as never).includes("one copy to R2"));
      ok(`(1) ${ds.length} destination(s): no checkboxes`, boxes(el).length === 0);
      // Nothing is reported, because there is nothing to choose: the caller keeps its own default.
      ok(`(1) ${ds.length} destination(s): setChosenDestinationIds is never called`, calls.length === 0);
    }

  console.log("\n(2) with several destinations it is a multi-select, reporting none ticked at build");
  {
    const { el, calls, last } = build(THREE);
    ok("(2a) one checkbox per destination", boxes(el).length === 3);
    ok("(2b) the caller is told at build time, not left guessing", calls.length === 1);
    ok("(2c) and told the empty selection", JSON.stringify(last()) === "[]");
    ok("(2d) the summary explains that none ticked means the default", summaryText(el).includes("uses the default destination"));
  }

  console.log("\n(3) ticking reports exactly the ticked ids");
  {
    const { el, last } = build(THREE);
    tick(el, "d2");
    ok("(3a) one tick reports one id", JSON.stringify(last()) === JSON.stringify(["d2"]));
    ok("(3b) the summary calls it a single copy", summaryText(el).includes("1 destination: a single copy"));
    tick(el, "d3");
    ok("(3c) a second tick reports both, in the order they were ticked", JSON.stringify(last()) === JSON.stringify(["d2", "d3"]));
    ok("(3d) the summary names the primary-and-replicas shape", summaryText(el).includes("the first ticked is the primary"));
  }

  console.log("\n(4) THE ORDERING RULE: ids come out in TICK order, not list order");
  {
    // Tick the LAST destination first, then the first. The operator chose the cold archive as their
    // primary, so it must be reported at index 0 even though it is last in the list. A list-order
    // implementation reports ["d1","d3"] and silently seals every run to a destination the operator
    // did not pick first.
    const { el, last } = build(THREE);
    tick(el, "d3");
    tick(el, "d1");
    ok("(4a) ticking d3 then d1 reports d3 first, because d3 was ticked first", JSON.stringify(last()) === JSON.stringify(["d3", "d1"]));
    tick(el, "d2");
    ok("(4b) a later tick appends as a replica, it never displaces the primary", JSON.stringify(last()) === JSON.stringify(["d3", "d1", "d2"]));
    // The whole list reversed, the case where list order and tick order agree on nothing.
    const b = build(THREE);
    tick(b.el, "d3");
    tick(b.el, "d2");
    tick(b.el, "d1");
    ok("(4c) ticking d3,d2,d1 reports them reversed, not sorted back into list order", JSON.stringify(b.last()) === JSON.stringify(["d3", "d2", "d1"]));
    // The control for (4a): when the operator ticks in list order the two rules agree, so this cell
    // passes under either implementation and proves the section is actually exercising the picker.
    const c = build(THREE);
    tick(c.el, "d1");
    tick(c.el, "d3");
    ok("(4d) CONTROL ticking in list order reports list order too", JSON.stringify(c.last()) === JSON.stringify(["d1", "d3"]));
  }

  console.log("\n(4.1) re-ticking is how an operator CHANGES the primary");
  {
    // Unticking drops an id; re-ticking appends it at the end. Without this an operator who wanted a
    // different primary had no way to say so: the rows never move, so re-ticking under list order just
    // reproduced the order they started with.
    const { el, last } = build(THREE);
    tick(el, "d1");
    tick(el, "d2");
    ok("(4.1a) d1 starts as the primary", JSON.stringify(last()) === JSON.stringify(["d1", "d2"]));
    tick(el, "d1", false);
    ok("(4.1b) unticking the primary promotes the survivor", JSON.stringify(last()) === JSON.stringify(["d2"]));
    tick(el, "d1");
    ok("(4.1c) re-ticking d1 puts it back as a REPLICA, so d2 is now the primary", JSON.stringify(last()) === JSON.stringify(["d2", "d1"]));
  }

  console.log("\n(5) unticking removes exactly that id and keeps the rest in order");
  {
    const { el, last } = build(THREE);
    tick(el, "d1");
    tick(el, "d2");
    tick(el, "d3");
    tick(el, "d2", false);
    ok("(5a) unticking the middle leaves the outer two in order", JSON.stringify(last()) === JSON.stringify(["d1", "d3"]));
    tick(el, "d1", false);
    tick(el, "d3", false);
    ok("(5b) unticking everything returns to the empty selection", JSON.stringify(last()) === "[]");
    ok("(5c) and the summary returns to the default line", summaryText(el).includes("uses the default destination"));
  }

  console.log("\n(6) a destination with no id is skipped rather than rendered unusable");
  {
    // An id-less entry cannot be reported (the id IS the value), so rendering a tickbox for it would
    // offer a choice that silently does nothing.
    const { el } = build([{ id: "d1", label: "Has id" }, { label: "No id at all" }, { id: "d3", label: "Also has id" }]);
    const values = boxes(el).map((b) => b.value);
    ok("(6a) only the identified destinations get a checkbox", JSON.stringify(values) === JSON.stringify(["d1", "d3"]));
    ok("(6b) the id-less label is not rendered as a row", !textOf(el as unknown as never).includes("No id at all"));
  }

  console.log("\n(7) labels fall back label, then bucket, then id, and the default is marked");
  {
    const { el } = build([
      { id: "d1", label: "Primary R2", isDefault: true },
      { id: "d2", bucket: "only-a-bucket" },
      { id: "d3" },
    ]);
    const text = textOf(el as unknown as never);
    ok("(7a) a label is used when present, with the default marked", text.includes("Primary R2 (default)"));
    ok("(7b) the bucket is used when there is no label", text.includes("only-a-bucket"));
    ok("(7c) the id is the last resort", text.includes("d3"));
    ok("(7d) only the default carries the suffix", (text.match(/\(default\)/g) ?? []).length === 1);
  }

  console.log("\n(8) THE EDIT PATH keeps a stored order untouched, and lets the operator change it");
  {
    // The edit editor has its own picker (src/screens/sources-downpipes/editor-destination-section.ts),
    // which had its own copy of the ordering rule. It is the surface where the MIGRATION question
    // lives, so both polarities are pinned here.
    const { buildDestinationSection } = await import("../src/screens/sources-downpipes/editor-destination-section.ts");
    const engine = {
      listDestinations: () => Promise.resolve({
        destinations: [
          { id: "d1", label: "Primary R2", isDefault: true },
          { id: "d2", label: "Off-site S3" },
          { id: "d3", bucket: "cold-archive" },
        ],
        defaultId: "d1",
      }),
    } as unknown as Parameters<typeof buildDestinationSection>[0];
    // A downpipe stored with d3 as its PRIMARY, deliberately not the list order.
    const existing = { destinationIds: ["d3", "d1"] } as unknown as Parameters<typeof buildDestinationSection>[1];
    const { el, getChosenIds } = buildDestinationSection(engine, existing, null, true, () => {});
    markConnected(el as unknown as never);
    await new Promise((r) => setTimeout(r, 0)); // let listDestinations resolve and render

    // CONTROL: this holds under either implementation. It is what makes the fix FORWARD-ONLY, so no
    // stored destinationIds array anywhere needs rewriting.
    ok("(8a) CONTROL an untouched edit reports the stored order verbatim, d3 still primary", JSON.stringify(getChosenIds()) === JSON.stringify(["d3", "d1"]));

    // DETECT: untick the primary and re-tick it. Under DOM order the rows never move, so re-ticking
    // just reproduced ["d3","d1"] and the operator had NO way to change the primary at all.
    tick(el, "d3", false);
    ok("(8b) unticking the primary leaves d1", JSON.stringify(getChosenIds()) === JSON.stringify(["d1"]));
    tick(el, "d3", true);
    ok("(8c) re-ticking d3 makes it a REPLICA, so the operator has changed the primary to d1", JSON.stringify(getChosenIds()) === JSON.stringify(["d1", "d3"]));
  }

  console.log(`\n${failures === 0 ? "DESTINATION-FANOUT OK: the reported ids are the ticked set in TICK order, so the primary is the one the operator ticked first, as the summary and the docs promise" : `${failures} FAILURE(S)`}`);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
