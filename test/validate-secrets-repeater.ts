// The secrets repeater on the downpipe editor, driven through the REAL buildSecretsSection.
//
//   node test/validate-secrets-repeater.ts
//
// What this section decides. Each row names a secret in the operator's Cloudflare Secrets Store and the
// Worker binding the engine reads it through, and getSecrets() produces the wire shape the upsert sends.
// Three of its behaviours are load-bearing and were untested:
//
//   1. getSecrets DROPS an incomplete row. A half-filled row must never reach the engine as a secret
//      with an empty name or an empty binding, because a downpipe would then claim to back up a secret
//      it cannot resolve.
//   2. storeId RIDES INVISIBLY. It is the Secrets Store resource id, recorded so a roster re-attach can
//      rebuild the binding. The operator never sees or edits it, so nothing on screen would reveal its
//      loss: a row that silently dropped its storeId would look perfectly correct and break re-attach
//      later, which is the worst shape a bug can have.
//   3. The LAST ROW CANNOT BE REMOVED. The delete handler returns early at one row, so the section can
//      never present zero rows and leave an operator with nothing to type into.
//
// The interesting assertions are about what getSecrets OMITS, so several cases below check absence.

import { installDomShim, qsa } from "./dom-shim.ts";
installDomShim();

const { buildSecretsSection } = await import("../src/screens/sources-downpipes/editor-secrets-section.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

type Section = ReturnType<typeof buildSecretsSection>;

// setRow types into row `i`'s two inputs exactly as an operator would: the name control then the
// binding control, in DOM order within that row.
function setRow(section: Section, i: number, name: string, binding: string): void {
  const rows = qsa(section.el, ".secrets-repeater__row");
  const row = rows[i];
  if (row === undefined) throw new Error(`no row ${i}`);
  const inputs = qsa(row as unknown as HTMLElement, "input");
  const nameEl = inputs[0] as unknown as { value: string } | undefined;
  const bindEl = inputs[1] as unknown as { value: string } | undefined;
  if (nameEl === undefined || bindEl === undefined) throw new Error(`row ${i} has ${inputs.length} inputs`);
  nameEl.value = name;
  bindEl.value = binding;
}

function rowCount(section: Section): number {
  return qsa(section.el, ".secrets-repeater__row").length;
}

function clickAdd(section: Section): void {
  const btn = qsa(section.el, "button").find((b) => String((b as unknown as { textContent: string }).textContent ?? "").includes("Add secret"));
  if (btn === undefined) throw new Error("no Add secret button");
  (btn as unknown as { click: () => void }).click();
}

function clickDelete(section: Section, i: number): void {
  const rows = qsa(section.el, ".secrets-repeater__row");
  const row = rows[i];
  if (row === undefined) throw new Error(`no row ${i}`);
  const del = qsa(row as unknown as HTMLElement, "button")[0];
  if (del === undefined) throw new Error(`row ${i} has no delete button`);
  (del as unknown as { click: () => void }).click();
}

function build(existing: unknown, prefill: unknown, editing: boolean): Section {
  const s = buildSecretsSection(existing as never, prefill as never, editing);
  markConnected(s.el as unknown as never);
  return s;
}

const secretsDownpipe = (secrets: Array<{ name: string; binding: string; storeId?: string }>) =>
  ({ source: { type: "secrets", secrets } }) as unknown;

async function main(): Promise<void> {
  console.log("(1) a fresh section starts with exactly one empty row, and getSecrets is empty");
  {
    const s = build(null, undefined, false);
    ok("(1a) one row is present", rowCount(s) === 1);
    ok("(1b) getSecrets returns nothing, because the row is blank", s.getSecrets().length === 0);
  }

  console.log("\n(2) add and remove rows");
  {
    const s = build(null, undefined, false);
    clickAdd(s);
    clickAdd(s);
    ok("(2a) two adds give three rows", rowCount(s) === 3);
    setRow(s, 0, "A", "SRC_A");
    setRow(s, 1, "B", "SRC_B");
    setRow(s, 2, "C", "SRC_C");
    ok("(2b) all three reach getSecrets in DOM order", JSON.stringify(s.getSecrets()) === JSON.stringify([{ name: "A", binding: "SRC_A" }, { name: "B", binding: "SRC_B" }, { name: "C", binding: "SRC_C" }]));
    clickDelete(s, 1);
    ok("(2c) deleting the middle row leaves two", rowCount(s) === 2);
    ok("(2d) and removes exactly that row, preserving the order of the rest", JSON.stringify(s.getSecrets()) === JSON.stringify([{ name: "A", binding: "SRC_A" }, { name: "C", binding: "SRC_C" }]));
  }

  console.log("\n(3) the last row cannot be removed");
  {
    const s = build(null, undefined, false);
    setRow(s, 0, "ONLY", "SRC_ONLY");
    clickDelete(s, 0);
    ok("(3a) deleting the only row is a no-op", rowCount(s) === 1);
    ok("(3b) its typed values survive the attempt", JSON.stringify(s.getSecrets()) === JSON.stringify([{ name: "ONLY", binding: "SRC_ONLY" }]));
    // And down to one from several: the guard must hold at the boundary, not just when it started at one.
    const t = build(null, undefined, false);
    clickAdd(t);
    clickDelete(t, 0);
    ok("(3c) removing down to one row works", rowCount(t) === 1);
    clickDelete(t, 0);
    ok("(3d) the guard then holds at one", rowCount(t) === 1);
  }

  console.log("\n(4) getSecrets drops an INCOMPLETE row rather than sending half of one");
  {
    const s = build(null, undefined, false);
    clickAdd(s);
    clickAdd(s);
    setRow(s, 0, "GOOD", "SRC_GOOD");
    setRow(s, 1, "NAME_ONLY", "");
    setRow(s, 2, "", "BINDING_ONLY");
    const out = s.getSecrets();
    ok("(4a) only the complete row survives", out.length === 1 && out[0]?.name === "GOOD");
    ok("(4b) a row with a name and no binding is dropped", !out.some((x) => x.name === "NAME_ONLY"));
    ok("(4c) a row with a binding and no name is dropped", !out.some((x) => x.binding === "BINDING_ONLY"));
  }

  console.log("\n(5) storeId rides invisibly, survives edits, and is never invented");
  {
    const s = build(secretsDownpipe([
      { name: "KEEP", binding: "SRC_KEEP", storeId: "store-abc123" },
      { name: "PLAIN", binding: "SRC_PLAIN" },
    ]), undefined, true);
    ok("(5a) both existing secrets seed a row", rowCount(s) === 2);
    const out = s.getSecrets();
    ok("(5b) the row that had a storeId still carries it", out.find((x) => x.name === "KEEP")?.storeId === "store-abc123");
    ok("(5c) the row that had none does NOT gain one", out.find((x) => x.name === "PLAIN") !== undefined && !("storeId" in (out.find((x) => x.name === "PLAIN") ?? {})));
    // The point of the invisible field: renaming the human-facing values must not shake the id loose.
    setRow(s, 0, "RENAMED", "SRC_RENAMED");
    const after = s.getSecrets();
    ok("(5d) editing the name and binding keeps the storeId attached to that row", after.find((x) => x.name === "RENAMED")?.storeId === "store-abc123");
    // A newly added row has no store id, because the operator has not deployed that secret yet.
    clickAdd(s);
    setRow(s, 2, "NEW", "SRC_NEW");
    ok("(5e) a newly added row carries no storeId", !("storeId" in (s.getSecrets().find((x) => x.name === "NEW") ?? {})));
  }

  console.log("\n(6) removing a row does not move another row's storeId onto it");
  {
    // The delete handler splices by entry identity rather than by index. If it spliced by a stale index,
    // the rows and their invisible ids would drift apart, and the resulting config would name the right
    // secrets against the wrong store ids: a re-attach failure with nothing wrong on screen.
    const s = build(secretsDownpipe([
      { name: "ONE", binding: "SRC_ONE", storeId: "store-1" },
      { name: "TWO", binding: "SRC_TWO", storeId: "store-2" },
      { name: "THREE", binding: "SRC_THREE", storeId: "store-3" },
    ]), undefined, true);
    clickDelete(s, 0);
    const out = s.getSecrets();
    ok("(6a) two rows remain", out.length === 2);
    ok("(6b) TWO still holds store-2", out.find((x) => x.name === "TWO")?.storeId === "store-2");
    ok("(6c) THREE still holds store-3", out.find((x) => x.name === "THREE")?.storeId === "store-3");
    ok("(6d) no row inherited the deleted row's store-1", !out.some((x) => x.storeId === "store-1"));
  }

  console.log("\n(7) the prefill seeds the first row's binding and its storeId, with the name left to type");
  {
    const s = build(null, { type: "secrets", secretBinding: "SRC_SECRET_apikey", secretStoreId: "store-prefill" }, false);
    ok("(7a) one row is seeded", rowCount(s) === 1);
    // The name is deliberately blank: the operator has just deployed the binding and still has to label
    // it, so getSecrets holds nothing back until they do. That is case (4)'s rule applied here.
    ok("(7b) getSecrets is empty until the name is typed", s.getSecrets().length === 0);
    setRow(s, 0, "API_KEY", "SRC_SECRET_apikey");
    const out = s.getSecrets();
    ok("(7c) once named it carries the prefilled binding", out[0]?.binding === "SRC_SECRET_apikey");
    ok("(7d) and the prefilled storeId", out[0]?.storeId === "store-prefill");
  }

  console.log(`\n${failures === 0 ? "SECRETS-REPEATER OK: incomplete rows are dropped, the last row is kept, and storeId rides invisibly without drifting" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
