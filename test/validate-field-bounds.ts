// Teeth for the field-bounds fix: every control whose catalogue row states a bound refuses an
// out-of-bounds value AT THE FIELD, on blur, with a message this file names exactly.
//
// THE DEFECT. components/field.ts validates on blur
// only when the field carries a rule, so a field() call passing neither `validate` nor `required` is
// silent by construction. The role-name box took a 65-character name under a hint reading "1 to 64
// chars"; the retention boxes took 0 and -5 under a hint reading "Whole number, 1 to 10,000"; the
// WORM retention box took 0 under a hint reading "greater than zero".
//
// WHAT THIS FILE ASSERTS, AND WHY IN THIS SHAPE.
//
//   1. IDENTITY, NOT PRESENCE. Every assertion below compares the error slot's text to the FULL
//      expected string. "an error appeared" is not the check: a field showing the wrong message, or
//      a screen-level banner leaking into the slot, passes that and fails this.
//
//   2. THE EMPTY STATE IS NEVER THE PROOF. An assertion that only refuses the empty box passes on a
//      field that refuses everything, and that exact bug has shipped in this repo before. So each
//      control is driven three ways: the out-of-bounds value must produce ITS OWN message, the
//      in-bounds value must produce NO message, and blank must produce either no message (an
//      optional field) or the DIFFERENT `required` message. A validator that always fails, always
//      passes, or collapses the bound into the empty check fails at least one of the three.
//
//   3. THE REAL CALL SITE, NOT A RE-DECLARATION. Section A builds the actual screen modules and
//      fires a real blur event on the real control, so it proves the wiring, not just the validator.
//      Section B reads each call site through the TypeScript AST and asserts the bound it passes,
//      which covers the controls whose screens need a live engine to render and, for every control,
//      catches a bound edited at the call site away from the one the catalogue cites. The AST is
//      used rather than a text search on purpose: a regex over the file matches the bound inside a
//      COMMENT just as happily as the one in the code, and would then prove nothing.
//
// Run with: node test/validate-field-bounds.ts

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { installDomShim, type ShimNode } from "./dom-shim.ts";

installDomShim();

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = join(HERE, "..");

let failures = 0;
function ok(label: string, cond: boolean, detail?: string): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!cond) failures++;
}

// fireBlur dispatches the event field() itself listens for, so the blur path under test really runs.
function fireBlur(control: ShimNode): void {
  control.dispatchEvent({
    type: "blur",
    target: control,
    currentTarget: control,
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  });
}

// findById walks a rendered subtree for a control by its id. The shim has no document-wide index for
// a detached tree, and every section below renders detached.
function findById(root: ShimNode, id: string): ShimNode | null {
  if (root.id === id) return root;
  for (const child of (root.children ?? []) as ShimNode[]) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}

// errorTextFor returns what the operator would READ in the control's own error slot: the empty
// string when the slot is hidden or empty, so "no error" and "an error" are never confused.
function errorTextFor(root: ShimNode, id: string): string {
  const control = findById(root, id);
  if (!control) return "<<control not found>>";
  // The slot is a sibling inside the same .field wrapper, and carries the id `<control id>-error`.
  const slot = findById(root, `${id}-error`);
  if (!slot) return "<<error slot not found>>";
  return slot.hidden === true ? "" : String(slot.textContent ?? "");
}

// probe drives ONE control three ways and asserts all three outcomes, which is the whole discipline
// of point 2 above: a mutant that always errors fails `inBounds`, one that never errors fails
// `outOfBounds`, and one that only refuses blank fails both.
function probe(opts: {
  name: string;
  root: ShimNode;
  id: string;
  outOfBounds: string;
  expected: string;
  inBounds: string;
  blankExpected: string;
}): void {
  const control = findById(opts.root, opts.id);
  if (!control) {
    ok(`${opts.name}: the control is in the rendered screen`, false, `no element with id "${opts.id}"`);
    return;
  }
  control.value = opts.outOfBounds;
  fireBlur(control);
  const got = errorTextFor(opts.root, opts.id);
  ok(`${opts.name}: refuses ${JSON.stringify(opts.outOfBounds)} with its own message`, got === opts.expected, `expected ${JSON.stringify(opts.expected)}\n         got      ${JSON.stringify(got)}`);

  control.value = opts.inBounds;
  fireBlur(control);
  const clean = errorTextFor(opts.root, opts.id);
  ok(`${opts.name}: accepts ${JSON.stringify(opts.inBounds)} with no error`, clean === "", `expected no error, got ${JSON.stringify(clean)}`);

  control.value = "";
  fireBlur(control);
  const blank = errorTextFor(opts.root, opts.id);
  ok(`${opts.name}: blank reads ${opts.blankExpected === "" ? "as no error" : "as the required message, not the bound message"}`, blank === opts.blankExpected, `expected ${JSON.stringify(opts.blankExpected)}\n         got      ${JSON.stringify(blank)}`);
  // The empty state and the out-of-bounds state must not be the same message, or an assertion on
  // one of them would silently be an assertion on the other.
  ok(`${opts.name}: the blank message is not the bound message`, blank !== opts.expected);
}

// ===========================================================================================
// Section A. The real screens, rendered, with a real blur on the real control.
// ===========================================================================================

console.log("\nA. bounds refused at the field, on blur, in the real screens\n");

{
  // as-binding and as-kv-ns, the two add-source identifier controls whose existing rules were wired
  // into field()'s validate arm. Both left the control SILENT on blur before the fix and now produce
  // the messages named here, with the refusal previously arriving only at Attach.
  // as-kv-ns matters most: the engine's attach route checks that a namespace id is PRESENT and not
  // its shape, so this field is the only place the hexadecimal charset holds.
  const { buildSourceFields } = await import("../src/screens/add-source-fields.ts");
  const sourceFields = buildSourceFields();
  const idsRoot = sourceFields.idsField as unknown as ShimNode;
  probe({
    name: "as-binding",
    root: idsRoot,
    id: "as-binding",
    outOfBounds: "SRC KV uploads",
    expected: "Use a valid binding name: a letter or underscore, then letters, digits or underscores (for example SRC_KV_uploads). No spaces, dots or dashes.",
    inBounds: "SRC_KV_uploads",
    blankExpected: "Binding name is required.",
  });
  probe({
    name: "as-kv-ns",
    root: idsRoot,
    id: "as-kv-ns",
    outOfBounds: "0f2ac7c1-b6e0",
    expected: "The KV namespace id must be hexadecimal (0-9, a-f) only, 8 to 64 characters. Paste the id exactly as Cloudflare returns it.",
    inBounds: "0f2ac7c1b6e0470a8f3d2c9b1e6a4d5f",
    blankExpected: "KV namespace id is required.",
  });
  // The remaining five identifier controls. Every one read CLEAN on blur with a precise error only at Attach before the repair, so the
  // message each names below is the one Attach was already producing; what moved is WHEN it appears.
  // Each expected string is the FULL message, so a field that starts showing a neighbouring control's
  // reason fails here rather than passing on "an error appeared".
  probe({
    name: "as-r2-bucket",
    root: idsRoot,
    id: "as-r2-bucket",
    outOfBounds: "uploads/prod",
    expected: "The R2 bucket name may use letters, digits, hyphens and underscores only (starting with a letter or digit), up to 64 characters.",
    inBounds: "uploads-prod",
    blankExpected: "R2 bucket name is required.",
  });
  probe({
    name: "as-d1-name",
    root: idsRoot,
    id: "as-d1-name",
    outOfBounds: "app db",
    expected: "The D1 database name may use letters, digits, hyphens and underscores only (starting with a letter or digit), up to 64 characters.",
    inBounds: "app-db",
    blankExpected: "D1 database name is required.",
  });
  probe({
    name: "as-d1-id",
    root: idsRoot,
    id: "as-d1-id",
    outOfBounds: "62a9",
    expected: "The D1 database id must be a UUID or a hexadecimal id (0-9, a-f and the UUID hyphens only). Paste the id exactly as wrangler returns it.",
    inBounds: "62a9f0c1-b6e0-470a-8f3d-2c9b1e6a4d5f",
    blankExpected: "D1 database id is required.",
  });
  probe({
    name: "as-sec-store",
    root: idsRoot,
    id: "as-sec-store",
    outOfBounds: "6e32e830-8255",
    expected: "The Secrets Store id must be hexadecimal (0-9, a-f) only, 8 to 64 characters. Paste the id exactly as Cloudflare returns it.",
    inBounds: "6e32e830825542ef0a1b2c3d4e5f6071",
    blankExpected: "Secrets Store id is required.",
  });
  probe({
    name: "as-sec-name",
    root: idsRoot,
    id: "as-sec-name",
    outOfBounds: "api key",
    expected: "The secret name (the store entry key) may use letters, digits, hyphens and underscores only (starting with a letter or digit), up to 64 characters.",
    inBounds: "API_KEY",
    blankExpected: "The secret name (the store entry key) is required.",
  });
  // ONE STATE, ONE SENTENCE, and this is the assertion whose absence let the two drift apart.
  //
  // as-sec-name refused an empty box twice with two different sentences: "Secret name is required."
  // at the field, composed by components/field.ts from the control's LABEL, and "The secret name (the
  // store entry key) is required." when Attach was pressed, composed by validateSourceInput from the
  // noun phrase. The blankExpected row above pins the field's half. It cannot pin the agreement,
  // because it never reads the other half, so an edit to either one would pass it.
  //
  // This compares the two producers directly. The field's message is read out of the RENDERED control
  // rather than from the constant, so a call site that stopped passing requiredMessage fails here even
  // though the constant is untouched. Driving both moments in a browser is a separate exercise; this
  // is the cheap check that runs on every build.
  {
    const control = findById(idsRoot, "as-sec-name");
    if (control === null) {
      ok("as-sec-name: the control is in the rendered screen (agreement check)", false);
    } else {
      control.value = "";
      fireBlur(control);
      const atField = errorTextFor(idsRoot, "as-sec-name");
      const { validateSourceInput } = await import("../src/lib/add-source.ts");
      const atAttach = validateSourceInput({ type: "secrets", binding: "SRC_SECRET", storeId: "6e32e830825542ef0a1b2c3d4e5f6071", secretName: "" })
        .find((e) => e.field === "secretName")?.reason ?? "<<Attach did not refuse an empty secret name>>";
      ok("as-sec-name: the field and Attach refuse an empty box with the SAME sentence", atField === atAttach, `field  ${JSON.stringify(atField)}\n         attach ${JSON.stringify(atAttach)}`);
      // The agreement above would also hold if BOTH said nothing, so the sentence itself is named.
      ok("as-sec-name: that sentence names the store entry key, not just the label", atField === "The secret name (the store entry key) is required.", `got ${JSON.stringify(atField)}`);
    }
  }
  // ===========================================================================================
  // ONE NOUN PHRASE, TWO MOMENTS: the accepted blur-vs-Attach split, pinned so it cannot widen.
  // ===========================================================================================
  //
  // WHAT WAS RULED. All seven
  // add-source identifier controls refuse an empty box twice: once at the field on blur, composed by
  // components/field.ts, and once when Attach is pressed, composed by validateSourceInput. as-sec-name
  // was repaired to say ONE sentence at both moments. The other six say two, and that was ruled
  // ACCEPTABLE and is not to be re-raised: each blur sentence is the LABEL the operator is reading
  // directly above the box, so the shorter form names the field precisely as the screen names it. That
  // is the generic composer working rather than drift.
  //
  // WHAT WAS LEFT UNGATED, AND IS GATED HERE. The blankExpected rows above pin all seven blur
  // sentences, but the block above compares the two PRODUCERS for as-sec-name only. So the other six
  // could drift on the Attach side with nothing noticing. This block compares both producers for all
  // seven.
  //
  // THE RELATION PINNED, AND WHY NOT VERBATIM. Pinning fourteen sentences verbatim would fail today
  // (they are not equal) and would have to be edited for every legitimate copy edit, and a pin that is
  // routinely edited stops being evidence. So what is pinned is the DERIVATION, which is the ruling's
  // own reasoning: both sentences are composed from ONE noun phrase, and that noun phrase is the label
  // read out of the RENDERED control, never written down here.
  //
  //     blur   ===  `<label> is required.`
  //     attach ===  `<article><noun> is required<tail>`
  //
  // with article, the first-letter case fold, and tail drawn per control from the small table below.
  // A consistent copy edit to a label and its Attach noun phrase moves both sentences and this pin
  // does not move. A change to the ARTICLE, the CASE or the TAIL does move it, and those are exactly
  // the shapes the divergence takes. It also catches a LABEL CHANGE that silently changes an error
  // message: blur follows the new label while the Attach noun phrase does not, so the attach leg fails.
  //
  // THE SPLIT IS NOT ONE SHAPE, and the table records the three it really is (28 cases measured):
  //   * four controls gain exactly a leading "The " and nothing else;
  //   * as-binding gains "A " AND folds the first letter, because validateBindingName writes its
  //     sentence out by hand rather than composing it from the noun phrase;
  //   * as-d1-id gains "The " AND a trailing clause. That tail is the ONE verbatim string in this
  //     pin, so a copy edit to it moves the pin; that cost is accepted for one 44-character tail
  //     rather than for fourteen sentences.
  // The tail carries literal backticks into an error slot that renders as plain text. That is
  // recorded here, deliberately NOT folded into this pin, and reported separately.
  {
    const { validateSourceInput, SECRET_NAME_REQUIRED } = await import("../src/lib/add-source.ts");
    // labelTextFor returns the <label for="<id>"> the operator reads directly above the box, out of
    // the rendered tree, so the derivation is checked against the screen rather than against source.
    const labelTextFor = (root: ShimNode, id: string): string => {
      let found: string | null = null;
      const walk = (n: ShimNode): void => {
        if (found !== null) return;
        if (String(n.tagName ?? "").toLowerCase() === "label" && n.getAttribute?.("for") === id) {
          found = String(n.textContent ?? "");
          return;
        }
        for (const c of (n.children ?? []) as ShimNode[]) walk(c);
      };
      walk(root);
      return found ?? "<<no label for this control>>";
    };
    // charAt rather than s[0]: under noUncheckedIndexedAccess an index read is string | undefined, and the
    // `s === ""` guard in front of it is not something the checker can carry into the branch. charAt returns
    // a string for every input, so the guard is the only thing that changes and it changes nothing: charAt(0)
    // of "" is "", which is what the empty branch already returns.
    const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

    // Each row: the input that leaves ONE box empty with every sibling holding its catalogued valid
    // value, the SourceInput key the error comes back under, and the three decorations Attach applies.
    const SHAPES = [
      { id: "as-binding", key: "binding", article: "A ", fold: true, tail: ".",
        empty: { type: "kv", binding: "", namespaceId: "0f2ac7c1b6e0470a8f3d2c9b1e6a4d5f" },
        filled: { type: "kv", binding: "SRC_KV_uploads", namespaceId: "0f2ac7c1b6e0470a8f3d2c9b1e6a4d5f" } },
      { id: "as-kv-ns", key: "namespaceId", article: "The ", fold: false, tail: ".",
        empty: { type: "kv", binding: "SRC_KV_uploads", namespaceId: "" },
        filled: { type: "kv", binding: "SRC_KV_uploads", namespaceId: "0f2ac7c1b6e0470a8f3d2c9b1e6a4d5f" } },
      { id: "as-r2-bucket", key: "bucketName", article: "The ", fold: false, tail: ".",
        empty: { type: "r2", binding: "SRC_R2_uploads", bucketName: "" },
        filled: { type: "r2", binding: "SRC_R2_uploads", bucketName: "uploads-prod" } },
      { id: "as-d1-name", key: "databaseName", article: "The ", fold: false, tail: ".",
        empty: { type: "d1", binding: "SRC_D1_app", databaseName: "", databaseId: "62a9f0c1-b6e0-470a-8f3d-2c9b1e6a4d5f" },
        filled: { type: "d1", binding: "SRC_D1_app", databaseName: "app-db", databaseId: "62a9f0c1-b6e0-470a-8f3d-2c9b1e6a4d5f" } },
      { id: "as-d1-id", key: "databaseId", article: "The ", fold: false, tail: " (the id wrangler returns from `d1 create`).",
        empty: { type: "d1", binding: "SRC_D1_app", databaseName: "app-db", databaseId: "" },
        filled: { type: "d1", binding: "SRC_D1_app", databaseName: "app-db", databaseId: "62a9f0c1-b6e0-470a-8f3d-2c9b1e6a4d5f" } },
      { id: "as-sec-store", key: "storeId", article: "The ", fold: false, tail: ".",
        empty: { type: "secrets", binding: "SRC_SECRET", storeId: "", secretName: "API_KEY" },
        filled: { type: "secrets", binding: "SRC_SECRET", storeId: "6e32e830825542ef0a1b2c3d4e5f6071", secretName: "API_KEY" } },
    ] as const;

    for (const shape of SHAPES) {
      const control = findById(idsRoot, shape.id);
      if (control === null) {
        ok(`${shape.id}: the control is in the rendered screen (two-moment relation)`, false);
        continue;
      }
      const label = labelTextFor(idsRoot, shape.id);
      control.value = "";
      fireBlur(control);
      const atField = errorTextFor(idsRoot, shape.id);
      const atAttach = validateSourceInput(shape.empty as never)
        .find((e) => e.field === shape.key)?.reason ?? "<<Attach did not refuse this empty box>>";

      // WITNESS at the Attach moment, same process: the SAME box holding its catalogued valid value
      // must come back with NO error. Without it, a producer that refuses everything, or one that has
      // stopped discriminating, would satisfy the two identity checks below on the empty state alone.
      const attachClean = validateSourceInput(shape.filled as never).find((e) => e.field === shape.key);
      ok(`${shape.id}: Attach accepts the catalogued valid value (witness for the readings below)`, attachClean === undefined, `got ${JSON.stringify(attachClean?.reason)}`);

      ok(`${shape.id}: the blur sentence IS the label above the box plus " is required."`, atField === `${label} is required.`, `label  ${JSON.stringify(label)}\n         blur   ${JSON.stringify(atField)}`);
      const expectedAttach = `${shape.article}${shape.fold ? lowerFirst(label) : label} is required${shape.tail}`;
      ok(`${shape.id}: the Attach sentence is that same noun phrase under its recorded decoration`, atAttach === expectedAttach, `expected ${JSON.stringify(expectedAttach)}\n         got      ${JSON.stringify(atAttach)}`);
    }

    // as-sec-name is the seventh, and the POSITIVE CONTROL OF THE RIGHT KIND: it reads as AGREEING, so
    // an instrument that reported divergence everywhere could not tell a real split from an artefact.
    // Its call site passes requiredMessage, so its blur sentence is deliberately NOT the label form.
    {
      const control = findById(idsRoot, "as-sec-name");
      if (control === null) {
        ok("as-sec-name: the control is in the rendered screen (two-moment relation)", false);
      } else {
        const label = labelTextFor(idsRoot, "as-sec-name");
        control.value = "";
        fireBlur(control);
        const atField = errorTextFor(idsRoot, "as-sec-name");
        const atAttach = validateSourceInput({ type: "secrets", binding: "SRC_SECRET", storeId: "6e32e830825542ef0a1b2c3d4e5f6071", secretName: "" })
          .find((e) => e.field === "secretName")?.reason ?? "<<Attach did not refuse an empty secret name>>";
        const attachClean = validateSourceInput({ type: "secrets", binding: "SRC_SECRET", storeId: "6e32e830825542ef0a1b2c3d4e5f6071", secretName: "API_KEY" }).find((e) => e.field === "secretName");
        ok("as-sec-name: Attach accepts the catalogued valid value (witness)", attachClean === undefined, `got ${JSON.stringify(attachClean?.reason)}`);
        // No sentence is written down: both moments are compared to the ONE exported constant that
        // owns this wording, so a copy edit there moves both moments and never moves this pin.
        ok("as-sec-name: both moments are the one exported sentence, byte for byte", atField === SECRET_NAME_REQUIRED && atAttach === SECRET_NAME_REQUIRED, `field  ${JSON.stringify(atField)}\n         attach ${JSON.stringify(atAttach)}`);
        // The repair is what makes it the odd one out, so the pin states the difference rather than
        // letting a dropped requiredMessage quietly return it to the label form the other six use.
        ok("as-sec-name: its blur sentence is deliberately NOT the label form the other six use", atField !== `${label} is required.`, `label ${JSON.stringify(label)}`);
        // Containment, not identity, and measurably weaker than the identity the six get. Because the
        // message is overridden it does not follow the label, so this only holds the two to naming the
        // same thing. Driven: renaming the label to "Widget" fails this line, while renaming it to
        // "Store entry" passes, since those words already appear inside the parenthetical. That is the
        // price of the requiredMessage override, stated rather than hidden.
        ok("as-sec-name: the sentence still names the field the label names", atField.toLowerCase().includes(label.toLowerCase()), `label ${JSON.stringify(label)}\n         blur  ${JSON.stringify(atField)}`);
      }
    }
  }
  // The 65th character, on the three controls whose bound is a LENGTH as well as a charset. The
  // catalogued invalid values above are all charset failures, so without these rows a validator that
  // dropped {0,63} from the pattern would pass every assertion in this file.
  for (const [id, expected] of [
    ["as-r2-bucket", "The R2 bucket name may use letters, digits, hyphens and underscores only (starting with a letter or digit), up to 64 characters."],
    ["as-d1-name", "The D1 database name may use letters, digits, hyphens and underscores only (starting with a letter or digit), up to 64 characters."],
    ["as-sec-name", "The secret name (the store entry key) may use letters, digits, hyphens and underscores only (starting with a letter or digit), up to 64 characters."],
  ] as const) {
    const control = findById(idsRoot, id);
    if (control === null) {
      ok(`${id}: the control is in the rendered screen`, false);
      continue;
    }
    control.value = "a".repeat(65);
    fireBlur(control);
    ok(`${id}: refuses a 65-character name with its own message`, errorTextFor(idsRoot, id) === expected);
    control.value = "a".repeat(64);
    fireBlur(control);
    ok(`${id}: accepts a 64-character name with no error`, errorTextFor(idsRoot, id) === "");
  }
}

{
  const { buildRetentionSection } = await import("../src/screens/sources-downpipes/editor-retention-section.ts");
  const sec = buildRetentionSection(null);
  const root = sec.el as unknown as ShimNode;
  probe({
    name: "dp-keep-runs",
    root,
    id: "dp-keep-runs",
    outOfBounds: "0",
    expected: "Runs to keep must be a whole number from 1 to 10,000. Type how many recent runs to keep, or leave it blank to keep every run.",
    inBounds: "10",
    blankExpected: "",
  });
  probe({
    name: "dp-keep-runs (negative)",
    root,
    id: "dp-keep-runs",
    outOfBounds: "-5",
    expected: "Runs to keep must be a whole number from 1 to 10,000. Type how many recent runs to keep, or leave it blank to keep every run.",
    inBounds: "9999",
    blankExpected: "",
  });
  probe({
    name: "dp-keep-runs (non-numeric)",
    root,
    id: "dp-keep-runs",
    outOfBounds: "abc",
    expected: "Runs to keep must be a whole number from 1 to 10,000. Type how many recent runs to keep, or leave it blank to keep every run.",
    inBounds: "1",
    blankExpected: "",
  });
  probe({
    name: "dp-keep-days",
    root,
    id: "dp-keep-days",
    outOfBounds: "0",
    expected: "Days to keep must be a whole number from 1 to 36,500. Type how many days of runs to keep, or leave it blank to keep every run.",
    inBounds: "30",
    blankExpected: "",
  });
  probe({
    name: "dp-keep-days (above the maximum)",
    root,
    id: "dp-keep-days",
    outOfBounds: "36501",
    expected: "Days to keep must be a whole number from 1 to 36,500. Type how many days of runs to keep, or leave it blank to keep every run.",
    inBounds: "36500",
    blankExpected: "",
  });
}

{
  const { buildWormBlock, buildStsBlock, buildPricingBlock } = await import("../src/screens/destination-form-fields.ts");
  const opts = {} as unknown as Parameters<typeof buildWormBlock>[0];
  const worm = buildWormBlock(opts);
  probe({
    name: "dest-worm-days",
    root: worm.section as unknown as ShimNode,
    id: "dest-worm-days",
    outOfBounds: "0",
    expected: "The retention window must be a whole number of days of at least 1. Type how many days each archive object stays locked, for example 30.",
    inBounds: "30",
    blankExpected: "",
  });
  probe({
    name: "dest-worm-days (negative)",
    root: worm.section as unknown as ShimNode,
    id: "dest-worm-days",
    outOfBounds: "-5",
    expected: "The retention window must be a whole number of days of at least 1. Type how many days each archive object stays locked, for example 30.",
    inBounds: "1",
    blankExpected: "",
  });

  const sts = buildStsBlock(opts);
  probe({
    name: "dest-sts-duration (below the minimum)",
    root: sts.section as unknown as ShimNode,
    id: "dest-sts-duration",
    outOfBounds: "899",
    expected: "The session duration must be a whole number of seconds from 900 to 43,200. Type a duration in that range, or leave it blank for the default of 3600.",
    inBounds: "3600",
    blankExpected: "",
  });
  probe({
    name: "dest-sts-duration (above the maximum)",
    root: sts.section as unknown as ShimNode,
    id: "dest-sts-duration",
    outOfBounds: "43201",
    expected: "The session duration must be a whole number of seconds from 900 to 43,200. Type a duration in that range, or leave it blank for the default of 3600.",
    inBounds: "43200",
    blankExpected: "",
  });

  const pricing = buildPricingBlock(opts, { edited: false });
  const pricingRoot = pricing.section as unknown as ShimNode;
  for (const [id, noun] of [
    ["dest-price-storage", "storage"],
    ["dest-price-classa", "writes"],
    ["dest-price-classb", "reads"],
    ["dest-price-egress", "egress"],
  ] as const) {
    probe({
      name: id,
      root: pricingRoot,
      id,
      outOfBounds: "-1",
      expected: `The ${noun} rate must be a number that is not negative. Type the rate as a plain number, with no currency symbol or thousands separator, for example 0.015.`,
      inBounds: "0.015",
      blankExpected: "",
    });
    probe({
      name: `${id} (a currency symbol the control would otherwise eat)`,
      root: pricingRoot,
      id,
      outOfBounds: "$0.02",
      expected: `The ${noun} rate must be a number that is not negative. Type the rate as a plain number, with no currency symbol or thousands separator, for example 0.015.`,
      inBounds: "0",
      blankExpected: "",
    });
  }
}

{
  // THE badInput PLUMBING, END TO END. On a type="number" control the browser discards anything that
  // is not a valid floating-point number, so a typed "abc" reaches the validator as "" and reads as
  // an untouched box. field.ts hands the validator validity.badInput as its second argument so a
  // bounds check can tell the two apart; without that hand-off this control accepts "abc" in
  // silence, which is the defect on the type-mismatch edge. Asserted on a REAL screen control, so
  // reverting field.ts to the one-argument call fails here rather than only in a factory unit test.
  const { buildWormBlock } = await import("../src/screens/destination-form-fields.ts");
  const worm = buildWormBlock({} as unknown as Parameters<typeof buildWormBlock>[0]);
  const root = worm.section as unknown as ShimNode;
  const control = findById(root, "dest-worm-days") as (ShimNode & { validity?: unknown }) | null;
  if (control === null) {
    ok("dest-worm-days: the control is in the rendered screen (badInput leg)", false);
  } else {
    // What the browser leaves behind after eating "abc": an empty .value and badInput set.
    control.validity = { badInput: true };
    control.value = "";
    fireBlur(control);
    ok(
      'dest-worm-days: a value the control could not convert (a typed "abc") is refused, not read as blank',
      errorTextFor(root, "dest-worm-days") === "The retention window must be a whole number of days of at least 1. Type how many days each archive object stays locked, for example 30.",
      `got ${JSON.stringify(errorTextFor(root, "dest-worm-days"))}`,
    );
    // The negative control for the same leg: a genuinely empty box, badInput clear, must stay silent.
    control.validity = { badInput: false };
    control.value = "";
    fireBlur(control);
    ok("dest-worm-days: a genuinely empty box stays silent", errorTextFor(root, "dest-worm-days") === "");
  }
}

{
  // push-secret, the SIEM audit-log push credential. Its message belongs here, and the control it belongs to is the most awkward one in
  // this file to reach: the push form lives behind an Owner gate and behind a "Set up <vendor>" click
  // on an Integrations vendor tile, and the panel refuses to paint into a subtree that is not
  // connected. All three are honoured rather than worked around, because the point of Section A is
  // that the WIRING is proved, not the factory.
  //
  // WHAT THE CONTROL DID BEFORE. It carried `required: true` and nothing else, while the note beneath
  // it told a Splunk operator the token had to be pasted as "Splunk <token>" and that a bare token was
  // not enough. So the console stated the rule and accepted the value that breaks it, on a write-only
  // field it never re-displays, against an endpoint whose only answer to a bare HEC token is a 401
  // that reads exactly like a revoked one.
  const { setCaller } = await import("../src/lib/caller-state.ts");
  const { CATALOGUE } = await import("../src/screens/integrations/catalogue.ts");
  const { renderSetupBody } = await import("../src/screens/integrations/panels.ts");
  setCaller({ role: "owner", email: "owner@example.com", method: "access", subject: "s" } as never);
  const stubEngine = {
    origin: "https://control.downpipes.io",
    metricsEndpointUrl: () => "https://control.downpipes.io/metrics",
    getPush: async () => ({ present: false }),
    getOtlpPush: async () => ({ present: false }),
    getSupport: async () => ({ vendorSealConfigured: true, signerConfigured: true, diagnostics: null, auditFeed: null, metrics: null }),
    listNotifyChannels: async () => [],
    listNotifyRules: async () => [],
    listDownpipes: async () => [],
  } as unknown as Parameters<typeof renderSetupBody>[0];
  const emptySnap = { push: null, otlp: null, support: null, channels: [], rules: [], downpipes: [] } as unknown as Parameters<typeof renderSetupBody>[3];
  const openFor = async (vendorName: string): Promise<ShimNode> => {
    const vendor = CATALOGUE.find((v) => v.name === vendorName && v.kind === "push");
    if (!vendor) throw new Error(`no push vendor named ${vendorName}`);
    const body = renderSetupBody(stubEngine, vendor, "allowed", emptySnap, () => {});
    (document.body as unknown as { appendChild: (n: unknown) => void }).appendChild(body);
    await new Promise((r) => setTimeout(r, 0));
    const setUp = [...(body.querySelectorAll("button") as unknown as Iterable<{ textContent?: string | null; click?: () => void }>)].find((btn) => (btn.textContent ?? "").startsWith("Set up"));
    setUp?.click?.();
    await new Promise((r) => setTimeout(r, 0));
    return body as unknown as ShimNode;
  };
  const splunkRoot = await openFor("Splunk");
  const SCHEME_MSG = "The HEC token must carry its scheme: the word Splunk, then a space, then the token your destination issued. Type Splunk and a space in front of the value you copied, for example Splunk 12345678-abcd-1234-abcd-1234567890ab.";
  probe({
    name: "push-secret (Splunk: the scheme the form states is the scheme it enforces)",
    root: splunkRoot,
    id: "push-secret",
    outOfBounds: "12345678-abcd-1234-abcd-1234567890ab",
    expected: SCHEME_MSG,
    inBounds: "Splunk 12345678-abcd-1234-abcd-1234567890ab",
    blankExpected: "Auth secret is required.",
  });
  probe({
    name: "push-secret (Splunk: the engine's own length cap, mirrored at the field)",
    root: splunkRoot,
    id: "push-secret",
    outOfBounds: `Splunk ${"a".repeat(8192)}`,
    expected: "The HEC token must be 8,192 characters or fewer. Check you pasted a token rather than a file or a whole response.",
    inBounds: `Splunk ${"a".repeat(8185)}`,
    blankExpected: "Auth secret is required.",
  });
  // THE DISCRIMINATION, and the reason the rule is the vendor's and not the wire format's: CrowdStrike
  // Falcon Next-Gen SIEM takes the SAME splunk-hec format over the SAME http sink and issues a plain
  // bearer token. A format-keyed rule refused the correct Falcon credential and told that operator to
  // put the word Splunk in front of it.
  const falconRoot = await openFor("CrowdStrike Falcon Next-Gen SIEM");
  probe({
    name: "push-secret (CrowdStrike Falcon: no scheme required, so the same bare token is accepted)",
    root: falconRoot,
    id: "push-secret",
    outOfBounds: `x${"a".repeat(8192)}`,
    expected: "The bearer token must be 8,192 characters or fewer. Check you pasted a token rather than a file or a whole response.",
    inBounds: "12345678-abcd-1234-abcd-1234567890ab",
    blankExpected: "Auth secret is required.",
  });
}

{
  const { buildSecretsSection } = await import("../src/screens/sources-downpipes/editor-secrets-section.ts");
  const sec = buildSecretsSection(null, undefined, false);
  const root = sec.el as unknown as ShimNode;
  probe({
    name: "dp-secret-name",
    root,
    id: "dp-secret-name-1",
    outOfBounds: "-leading-hyphen",
    expected: "A secret name must be 1 to 64 characters, starting with a letter or digit, then letters, digits, hyphens or underscores. Correct it to the name your Secrets Store shows, for example API_KEY.",
    inBounds: "API_KEY",
    blankExpected: "",
  });
  probe({
    name: "dp-secret-name (65 characters)",
    root,
    id: "dp-secret-name-1",
    outOfBounds: "a".repeat(65),
    expected: "A secret name must be 1 to 64 characters, starting with a letter or digit, then letters, digits, hyphens or underscores. Correct it to the name your Secrets Store shows, for example API_KEY.",
    inBounds: "a".repeat(64),
    blankExpected: "",
  });
  probe({
    name: "dp-secret-binding (a leading digit the engine's own rule allows but the console does not)",
    root,
    id: "dp-secret-binding-1",
    outOfBounds: "1SRC_SECRET",
    expected: "A binding must be 1 to 64 characters, starting with a letter or underscore, then letters, digits or underscores. Correct it to the binding the engine reads this secret through, for example SRC_SECRET_apikey.",
    inBounds: "SRC_SECRET_apikey",
    blankExpected: "",
  });
  probe({
    name: "dp-secret-binding (65 characters)",
    root,
    id: "dp-secret-binding-1",
    outOfBounds: `A${"a".repeat(64)}`,
    expected: "A binding must be 1 to 64 characters, starting with a letter or underscore, then letters, digits or underscores. Correct it to the binding the engine reads this secret through, for example SRC_SECRET_apikey.",
    inBounds: `A${"a".repeat(63)}`,
    blankExpected: "",
  });
}

{
  const { renderSplit } = await import("../src/components/custody-step-panels.ts");
  const ctx = {
    state: { scheme: "shamir", splitN: 5, splitThreshold: 3, signoffs: [] },
    result: { privateKey: new Uint8Array(32) },
    downloadText: () => true,
    emitMeta: () => {},
  } as unknown as Parameters<typeof renderSplit>[0];
  const root = renderSplit(ctx) as unknown as ShimNode;
  probe({
    name: "custody-split-n (below the minimum)",
    root,
    id: "custody-split-n",
    outOfBounds: "1",
    expected: "The share count must be a whole number from 2 to 16. Type how many shares to cut the key into, for example 5.",
    inBounds: "5",
    blankExpected: "",
  });
  probe({
    name: "custody-split-n (above the maximum)",
    root,
    id: "custody-split-n",
    outOfBounds: "17",
    expected: "The share count must be a whole number from 2 to 16. Type how many shares to cut the key into, for example 5.",
    inBounds: "16",
    blankExpected: "",
  });
  probe({
    name: "custody-split-threshold",
    root,
    id: "custody-split-threshold",
    outOfBounds: "1",
    expected: "The threshold must be a whole number of at least 2. Type 2 or more, so no single share can rebuild the key on its own.",
    inBounds: "3",
    blankExpected: "",
  });
}

{
  const { builderBody } = await import("../src/screens/roles-builder/form.ts");
  const engine = {} as unknown as Parameters<typeof builderBody>[0];
  const root = builderBody(engine, [], () => {}) as unknown as ShimNode;
  // builder-name and builder-label are the two controls that carry BOTH `required` and a validator,
  // so their blank state must read as the required message and NOT as the bound message. That is the
  // distinction point 2 above exists for, asserted here on a real control.
  probe({
    name: "builder-name (65 characters)",
    root,
    id: "builder-name",
    outOfBounds: "a".repeat(65),
    expected: "The role name must be 1 to 64 characters of lowercase letters, digits and hyphen, and cannot start or end with a hyphen. Rename it in that shape, for example kv-restorer.",
    inBounds: "a".repeat(64),
    blankExpected: "Role name is required.",
  });
  probe({
    name: "builder-name (a trailing hyphen)",
    root,
    id: "builder-name",
    outOfBounds: "kv-",
    expected: "The role name must be 1 to 64 characters of lowercase letters, digits and hyphen, and cannot start or end with a hyphen. Rename it in that shape, for example kv-restorer.",
    inBounds: "kv-restorer",
    blankExpected: "Role name is required.",
  });
  probe({
    name: "builder-label (129 characters)",
    root,
    id: "builder-label",
    outOfBounds: "a".repeat(129),
    expected: "The display label must be 128 characters or fewer. Shorten the name shown in the role catalogue, for example KV restorer.",
    inBounds: "a".repeat(128),
    blankExpected: "Display label is required.",
  });
}

// ===========================================================================================
// Section B. Every call site's bound, read off the AST.
// ===========================================================================================
//
// Section A cannot reach the controls whose screens need a live engine and an opened overlay to
// render (the push forms, the notification channel form, the restore flow, the change-number modal,
// the import drawer, the per-share custodian form). This section covers all nineteen, including
// those, by reading each field() call's OWN validate argument out of the TypeScript AST and
// asserting the bound it passes. Reading the AST rather than the file text is the point: the same
// numbers appear in the comments beside these call sites, and a text search would match those.

console.log("\nB. each call site passes the bound the catalogue cites\n");

// EXPECTED is the derived defect set: every control this change wired, its file, and the literal
// bound its validator must carry. A control missing from the source, or carrying a different bound,
// fails below.
const EXPECTED: Array<{ id: string; file: string; factory: string; mustContain: string[] }> = [
  { id: "custody-split-n", file: "src/components/custody-step-panels.ts", factory: "wholeNumberBetween", mustContain: ["MIN_SHARES", "MAX_SHARES"] },
  { id: "custody-split-threshold", file: "src/components/custody-step-panels.ts", factory: "wholeNumberAtLeast", mustContain: ["MIN_THRESHOLD"] },
  { id: "custody-share-emaillabel-", file: "src/components/custody-step-panels.ts", factory: "atMostChars", mustContain: ["120"] },
  { id: "cm-emergency-number", file: "src/components/require-change.ts", factory: "atMostChars", mustContain: ["CHANGE_NUMBER_MAX"] },
  { id: "dest-worm-days", file: "src/screens/destination-form-fields.ts", factory: "wholeNumberAtLeast", mustContain: ["min: 1", "days"] },
  { id: "dest-sts-duration", file: "src/screens/destination-form-fields.ts", factory: "wholeNumberBetween", mustContain: ["900", "43200"] },
  { id: "channel-jsm-api-key", file: "src/screens/notifications/channels.ts", factory: "atMostChars", mustContain: ["NOTIFY_API_KEY_MAX"] },
  { id: "channel-servicenow-api-key", file: "src/screens/notifications/channels.ts", factory: "atMostChars", mustContain: ["NOTIFY_API_KEY_MAX"] },
  // channel-servicenow-username is asserted HERE and not in Section A because its screen needs a live
  // engine and an opened overlay, which is the population this section exists for. Its sibling password
  // field above it already carried atMostChars for the same reason and this one had been left out: a
  // 257-character username passed blur AND Save, and the only refusal came from the engine as a generic
  // channel error.
  { id: "channel-servicenow-username", file: "src/screens/notifications/channels.ts", factory: "atMostChars", mustContain: ["NOTIFY_USERNAME_MAX"] },
  // The seven add-source identifier controls are driven live in Section A as well; the rows here catch
  // a bound edited at the call site away from the validator the catalogue cites.
  { id: "as-binding", file: "src/screens/add-source-fields.ts", factory: "bindingNameFieldValidator", mustContain: [] },
  { id: "as-kv-ns", file: "src/screens/add-source-fields.ts", factory: "kvNamespaceIdFieldValidator", mustContain: [] },
  { id: "as-r2-bucket", file: "src/screens/add-source-fields.ts", factory: "r2BucketNameFieldValidator", mustContain: [] },
  { id: "as-d1-name", file: "src/screens/add-source-fields.ts", factory: "databaseNameFieldValidator", mustContain: [] },
  { id: "as-d1-id", file: "src/screens/add-source-fields.ts", factory: "databaseIdFieldValidator", mustContain: [] },
  { id: "as-sec-store", file: "src/screens/add-source-fields.ts", factory: "secretsStoreIdFieldValidator", mustContain: [] },
  { id: "as-sec-name", file: "src/screens/add-source-fields.ts", factory: "secretNameFieldValidator", mustContain: [] },
  // The last three entries are asserted HERE and not in Section A because their screens need a live
  // engine and an opened overlay. All three were ACCEPTING rather than merely refusing late: a
  // 65-character change number and a 501-character justification were both taken on blur AND at
  // Confirm, with the gate then proceeding carrying the over-length value, and the OTLP auth secret took
  // an 8,193-character value and a value carrying CR and LF and POSTED both to the engine.
  { id: "cm-change-number", file: "src/components/require-change.ts", factory: "atMostChars", mustContain: ["CHANGE_NUMBER_MAX"] },
  { id: "cm-emergency-reason", file: "src/components/require-change.ts", factory: "atMostChars", mustContain: ["CHANGE_REASON_MAX"] },
  { id: "otlp-push-secret", file: "src/screens/settings/otlp-push.ts", factory: "pushAuthSecret", mustContain: [] },
  { id: "rs-max", file: "src/screens/restore-flow/flow.ts", factory: "wholeNumberAtLeast", mustContain: ["min: 1"] },
  { id: "builder-name", file: "src/screens/roles-builder/form.ts", factory: "matchingPattern", mustContain: ["CUSTOM_ROLE_NAME_PATTERN"] },
  { id: "builder-label", file: "src/screens/roles-builder/form.ts", factory: "atMostChars", mustContain: ["128"] },
  { id: "otlp-push-header-name", file: "src/screens/settings/otlp-push.ts", factory: "matchingPattern", mustContain: ["HTTP_HEADER_NAME_PATTERN"] },
  { id: "push-header-name", file: "src/screens/settings/push.ts", factory: "matchingPattern", mustContain: ["HTTP_HEADER_NAME_PATTERN"] },
  { id: "import-list", file: "src/screens/sources-downpipes/editor-import.ts", factory: "firstFailingLine", mustContain: ["BINDING_NAME_PATTERN"] },
  { id: "dp-secret-name-", file: "src/screens/sources-downpipes/editor-secrets-section.ts", factory: "matchingPattern", mustContain: ["RESOURCE_NAME_PATTERN"] },
  { id: "dp-secret-binding-", file: "src/screens/sources-downpipes/editor-secrets-section.ts", factory: "matchingPattern", mustContain: ["BINDING_NAME_PATTERN"] },
  { id: "dp-keep-runs", file: "src/screens/sources-downpipes/editor-retention-section.ts", factory: "wholeNumberBetween", mustContain: ["RETENTION_MAX_KEEP_RUNS"] },
  { id: "dp-keep-days", file: "src/screens/sources-downpipes/editor-retention-section.ts", factory: "wholeNumberBetween", mustContain: ["RETENTION_MAX_KEEP_DAYS"] },
];

// The four destination rate controls come from ONE rateField helper, so they are asserted once, at
// the helper, rather than four times at call sites that pass only an id and a label.
const RATE_HELPER = { file: "src/screens/destination-form-fields.ts", factory: "nonNegativeRate" };

interface CallSite {
  file: string;
  line: number;
  id: string | null;
  validateText: string | null;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const callSites: CallSite[] = [];
for (const abs of walkTs(join(CONSOLE_ROOT, "src"))) {
  const rel = relative(CONSOLE_ROOT, abs).replaceAll("\\", "/");
  if (rel === "src/components/field.ts") continue;
  const sf = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "field" &&
      node.arguments.length >= 1 &&
      ts.isObjectLiteralExpression(node.arguments[0] as ts.Node)
    ) {
      const obj = node.arguments[0] as ts.ObjectLiteralExpression;
      let id: string | null = null;
      let validateText: string | null = null;
      for (const p of obj.properties) {
        if (!ts.isPropertyAssignment(p) || !p.name) continue;
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
        if (key === "id") {
          const v = p.initializer;
          id = ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text : v.getText(sf);
        } else if (key === "validate") {
          // getText on the INITIALIZER returns the validator expression only. Leading comments are
          // attached to the property, not the expression, so a bound quoted in a comment beside this
          // call site cannot satisfy the assertions below.
          validateText = p.initializer.getText(sf);
        }
      }
      callSites.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, id, validateText });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// A scan that found nothing reads exactly like a scan that found no problem.
ok(`the AST scan found the console's field() calls (${callSites.length})`, callSites.length >= 150, `found only ${callSites.length}; the console had 177 when this test was written`);

for (const want of EXPECTED) {
  const site = callSites.find((c) => c.file === want.file && c.id !== null && (c.id === want.id || c.id.includes(want.id)));
  if (!site) {
    ok(`${want.id}: the call site is in ${want.file}`, false, "no field() call with that id was found");
    continue;
  }
  ok(`${want.id}: passes a validate argument`, site.validateText !== null, `${site.file}:${site.line} passes no validate`);
  if (site.validateText === null) continue;
  ok(`${want.id}: validates through ${want.factory}`, site.validateText.includes(want.factory), `${site.file}:${site.line} validate reads: ${site.validateText.slice(0, 120)}`);
  for (const literal of want.mustContain) {
    ok(`${want.id}: carries the bound ${JSON.stringify(literal)}`, site.validateText.includes(literal), `${site.file}:${site.line} validate reads: ${site.validateText.slice(0, 160)}`);
  }
}

{
  const helperSites = callSites.filter((c) => c.file === RATE_HELPER.file && c.validateText?.includes(RATE_HELPER.factory));
  ok(`the four destination rate controls validate through ${RATE_HELPER.factory}`, helperSites.length === 1, `expected exactly one rateField helper call, found ${helperSites.length}`);
}

// ===========================================================================================
// Section C. The factories themselves, at the exact edges.
// ===========================================================================================
//
// Section A drives the controls a screen renders; this section pins the boundary ARITHMETIC, which
// is where an off-by-one hides: at-min and at-max must be accepted and below-min and above-max
// refused, and the badInput arm (the browser having eaten the operator's text on a number control)
// must refuse rather than read as blank.

console.log("\nC. the bound factories at their exact edges\n");

{
  const { wholeNumberBetween, wholeNumberAtLeast, atMostChars, matchingPattern, firstFailingLine, nonNegativeRate } = await import("../src/components/field-bounds.ts");

  const between = wholeNumberBetween({ noun: "N", min: 2, max: 16, remedy: "R." });
  ok("wholeNumberBetween: refuses one below the minimum", between("1") === "N must be a whole number from 2 to 16. R.");
  ok("wholeNumberBetween: accepts the minimum itself", between("2") === null);
  ok("wholeNumberBetween: accepts the maximum itself", between("16") === null);
  ok("wholeNumberBetween: refuses one above the maximum", between("17") === "N must be a whole number from 2 to 16. R.");
  ok("wholeNumberBetween: accepts blank (the empty box is field()'s own business)", between("") === null);
  ok("wholeNumberBetween: refuses blank when the control reports badInput", between("", { badInput: true }) === "N must be a whole number from 2 to 16. R.");
  ok("wholeNumberBetween: refuses a decimal", between("2.5") === "N must be a whole number from 2 to 16. R.");
  ok("wholeNumberBetween: refuses exponent notation Number() would accept", between("1e1") === "N must be a whole number from 2 to 16. R.");

  const atLeast = wholeNumberAtLeast({ noun: "M", min: 1, unit: "days", remedy: "R." });
  ok("wholeNumberAtLeast: refuses zero", atLeast("0") === "M must be a whole number of days of at least 1. R.");
  ok("wholeNumberAtLeast: refuses a negative", atLeast("-5") === "M must be a whole number of days of at least 1. R.");
  ok("wholeNumberAtLeast: accepts the minimum itself", atLeast("1") === null);
  ok("wholeNumberAtLeast: refuses a non-numeric string", atLeast("abc") === "M must be a whole number of days of at least 1. R.");
  ok("wholeNumberAtLeast: accepts blank", atLeast("") === null);

  const chars = atMostChars({ noun: "L", max: 128, remedy: "R." });
  ok("atMostChars: accepts the maximum itself", chars("a".repeat(128)) === null);
  ok("atMostChars: refuses one above the maximum", chars("a".repeat(129)) === "L must be 128 characters or fewer. R.");
  ok("atMostChars: accepts blank", chars("") === null);

  const pattern = matchingPattern({ pattern: /^[a-z]+$/, rule: "Rule.", remedy: "R." });
  ok("matchingPattern: accepts a match", pattern("abc") === null);
  ok("matchingPattern: refuses a non-match", pattern("ABC") === "Rule. R.");
  ok("matchingPattern: accepts blank", pattern("") === null);

  const lines = firstFailingLine({ lineRule: (l) => /^[A-Z_]+$/.test(l), describe: "a name.", remedy: "R." });
  ok("firstFailingLine: accepts an all-good list", lines("AAA\nBBB") === null);
  ok("firstFailingLine: names the offending line by number", lines("AAA\nbbb\nCCC") === "Line 2 is not a name. R.");
  ok("firstFailingLine: skips blank lines rather than refusing them", lines("AAA\n\n\nBBB") === null);
  ok("firstFailingLine: accepts blank", lines("") === null);

  const rate = nonNegativeRate({ noun: "Rate", remedy: "R." });
  ok("nonNegativeRate: accepts zero", rate("0") === null);
  ok("nonNegativeRate: accepts a decimal", rate("0.015") === null);
  ok("nonNegativeRate: refuses a negative", rate("-1") === "Rate must be a number that is not negative. R.");
  ok("nonNegativeRate: refuses a currency symbol", rate("$1") === "Rate must be a number that is not negative. R.");
  ok("nonNegativeRate: refuses Infinity, which Number() accepts", rate("Infinity") === "Rate must be a number that is not negative. R.");
  ok("nonNegativeRate: refuses blank when the control reports badInput", rate("", { badInput: true }) === "Rate must be a number that is not negative. R.");
  ok("nonNegativeRate: accepts blank", rate("") === null);
}

console.log(failures === 0 ? "\nFIELD BOUNDS VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
