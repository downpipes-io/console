// THE CREATE DESTINATION FORM'S R2 BUCKET SELECT OPENS ON A BUCKET THAT RAISES NO WARNING.
//
// Two defects, one select. From 5a0b63cf the select was handed `value: initialBucket ?? ""` and so opened
// with nothing chosen on Create. Once that was fixed to open on the first listed bucket, the tour's first
// bucket (northwind-statements) turned out to be an R2 backup source itself, so the "This bucket is also a
// backup source" note showed on a form the operator had not touched: a warning at rest that nothing the
// operator did caused. Create now opens on the first listed bucket that is not a source. When every listed
// bucket is a source, or the downpipes read failed so the sources are not known, it opens on a "Choose a
// bucket" entry that the required check refuses. Replace still opens on its own bucket.
//
// The DOM shim stores whatever value is assigned and does not model how a browser resolves a <select>, so
// this file teaches it the browser rule for a <select>'s value: an assigned value that matches an option is
// the value, one that matches none reads "", and a select never assigned a value reads its first option.
// Without that the form's own read of the bucket (updateCircWarn) would see "" on an untouched select and
// the at-rest warning check below could not fail.
//
// WHAT THIS PINS, each able to fail on its own:
//   1. CREATE SKIPS SOURCES. The select shows the first listed bucket that is not a backup source, and the
//      circular-archive note is hidden at rest.
//   2. ALL SOURCES, NO GUESS. With every bucket a source, the select shows "Choose a bucket", no note shows,
//      and a save with it left there says "Bucket is required." and sends nothing.
//   3. SOURCES UNKNOWN, NO GUESS. With the downpipes read failed, the select shows "Choose a bucket" too.
//   4. THE WARNING STILL WORKS. Choosing a source bucket shows the note.
//   5. REPLACE SHOWS ITS OWN. Replace on an R2 destination shows that destination's bucket, including one
//      discovery did not list.
//
// Run: node test/validate-dest-r2-create-select.ts

import { flushAsync, installDomShim, markConnected, qs, textOf, ShimNode } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

{
  const desc = Object.getOwnPropertyDescriptor(ShimNode.prototype, "value");
  if (desc?.get === undefined || desc.set === undefined) throw new Error("the DOM shim no longer defines value as an accessor");
  const { get, set } = desc;
  Object.defineProperty(ShimNode.prototype, "value", {
    configurable: true,
    set(this: ShimNode, v: string) {
      set.call(this, v);
    },
    get(this: ShimNode & { valueDirty_?: boolean; options?: ShimNode[] }): string {
      const raw = get.call(this) as string;
      if (this.tagName !== "SELECT") return raw;
      const values = (this.options ?? []).map((o) => o.getAttribute("value") ?? "");
      if (this.valueDirty_ === true) return values.includes(raw) ? raw : "";
      return values[0] ?? "";
    },
  });
}

import type { Caller, EngineClient } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import { destinationForm } from "../src/screens/destination-form.ts";
import type { FormContext } from "../src/screens/destination-form-fields.ts";

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
// The save button is owner-gated, so an Owner is signed in for the blank-save check.
setCaller({ method: "access", email: "owner@test", role: "owner", groups: [], isOnlyOwner: true } as unknown as Caller);

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean, detail?: unknown): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
  if (!cond) failures++;
}

const CIRC_TEXT = "This bucket is also a backup source";

function ctx(sources: string[], downpipesRead = true): FormContext {
  return {
    engineAccountId: "0f2ac7c1b6e0470a8f3d1c2b4a5e6f70",
    engineR2Buckets: ["northwind-statements", "northwind-receipts"],
    sourceR2Buckets: new Set(sources),
    discoveryRead: true,
    downpipesRead,
  };
}

let posts = 0;
const engine = {
  addDestination: async () => {
    posts++;
    return { ok: true } as never;
  },
  getChangePolicy: async () => ({ required: false }),
} as unknown as EngineClient;

// shownValue is the value a browser shows for a <select> (the accessor installed above).
function shownValue(sel: ShimNode): string {
  return (sel as unknown as { value: string }).value;
}

function shownLabel(sel: ShimNode): string {
  const v = shownValue(sel);
  const opt = (sel as unknown as { options: ShimNode[] }).options.find((o) => (o.getAttribute("value") ?? "") === v);
  return opt ? textOf(opt as never) : "";
}

// circShown reads whether the circular-archive note is visible.
function circShown(form: ShimNode): boolean {
  const note = qs(form as never, ".note-quiet") as unknown as (ShimNode & { hidden: boolean }) | null;
  if (note === null || !textOf(note as never).includes(CIRC_TEXT)) throw new Error("the circular-archive note did not render");
  return note.hidden !== true;
}

function open(fctx: FormContext, opts: object = {}): { form: ShimNode; sel: ShimNode } {
  const form = destinationForm(engine, fctx, { confirmReplace: false, onSaved: () => undefined, ...opts } as never) as unknown as ShimNode;
  document.body.replaceChildren(form as never);
  markConnected(form);
  const sel = qs(form as never, "select#dest-r2-bucket");
  if (sel === null) throw new Error("the R2 bucket select did not render");
  return { form, sel };
}

async function main(): Promise<void> {
  console.log("\n-- 1. Create skips a bucket that is already a backup source --");
  {
    const { form, sel } = open(ctx(["northwind-statements"]));
    const shown = shownValue(sel);
    ok("the select shows the first bucket that is not a source", shown === "northwind-receipts", shown);
    ok("and the circular-archive note is hidden at rest", !circShown(form));
  }

  console.log("\n-- 2. every bucket a source: a placeholder, no warning, and a blank save is refused --");
  {
    const { form, sel } = open(ctx(["northwind-statements", "northwind-receipts"]));
    ok("the select shows Choose a bucket", shownValue(sel) === "" && shownLabel(sel) === "Choose a bucket", shownLabel(sel));
    ok("no circular-archive note shows", !circShown(form));
    const setVal = (id: string, v: string) => {
      const el = qs(form as never, `#${id}`) as unknown as { value: string; dispatchEvent: (e: unknown) => boolean } | null;
      if (el === null) throw new Error(`#${id} did not render`);
      el.value = v;
      el.dispatchEvent(makeEvent({ type: "input", bubbles: true }));
    };
    setVal("dest-access-key", "AKIAEXAMPLE");
    setVal("dest-secret", "s3cr3t-example");
    posts = 0;
    const btn = qs(form as never, '[data-dp="destination-form.button.save#1"]') as unknown as { click: () => void } | null;
    if (btn === null) throw new Error("the save button did not render");
    btn.click();
    await flushAsync(20);
    ok("a save with no bucket chosen says Bucket is required.", textOf(form as never).includes("Bucket is required."));
    ok("and sends nothing to the engine", posts === 0, posts);
  }

  console.log("\n-- 3. sources unknown: a placeholder rather than a guess --");
  {
    const { form, sel } = open(ctx([], false));
    ok("with the downpipes read failed, the select shows Choose a bucket", shownLabel(sel) === "Choose a bucket", shownLabel(sel));
    ok("and no circular-archive note shows", !circShown(form));
  }

  console.log("\n-- 4. choosing a source bucket still warns --");
  {
    const { form, sel } = open(ctx(["northwind-statements"]));
    (sel as unknown as { value: string }).value = "northwind-statements";
    sel.dispatchEvent(makeEvent({ type: "input", bubbles: true }) as never);
    ok("choosing a bucket that is a source shows the circular-archive note", circShown(form));
  }

  console.log("\n-- 5. Replace shows its own bucket --");
  {
    const listed = shownValue(open(ctx(["northwind-statements"]), { confirmReplace: true, editId: "d1", initialProvider: "r2", initialBucket: "northwind-statements" }).sel);
    ok("Replace on a listed bucket shows that bucket, even one that is a source", listed === "northwind-statements", listed);
    const unlisted = shownValue(open(ctx([]), { confirmReplace: true, editId: "d2", initialProvider: "r2", initialBucket: "acme-primary" }).sel);
    ok("Replace on a bucket discovery did not list still shows that bucket", unlisted === "acme-primary", unlisted);
  }

  document.body.replaceChildren();
  console.log(failures === 0 ? "\nPASS validate-dest-r2-create-select" : `\nFAIL validate-dest-r2-create-select (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
