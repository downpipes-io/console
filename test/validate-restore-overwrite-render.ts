// The restore plan must SHOW which live KV keys and R2 objects an apply would replace, and a keep-live-keys
// choice must reach the engine and survive a re-entry.
//
// WHY THIS EXISTS
// ---------------
// The in-account restore replaces a live KV key or R2 object of the same name. The engine's dry run now asks
// the target about every KV and R2 record (RestorePlan.overwriteCheck, and targetExists on each preview row)
// without reading a live value, and an apply can keep the live keys (RestoreRequest.onExisting "skip"). A
// field the console does not render is a field the operator never sees, so this drives the REAL renderPlan
// under the shared DOM shim and asserts what reaches the screen:
//
//   - a plan that would replace live keys says so as a caution, counts them and names them;
//   - under keep-live-keys the same plan says the names are kept, calmly;
//   - a plan where nothing exists says that, and a failed check is never reported as "nothing exists";
//   - each sampled row says what is in the target now, and a row with no answer reads "Not checked";
//   - an older engine's plan (no overwriteCheck, no targetExists) renders exactly the old four columns;
//   - "Restore just this" on a keep-live-keys plan carries the choice into the re-entry;
//   - a keep-live-keys plan from an engine that did not echo onExisting "skip" (an engine older than 0.3.7,
//     which ignores the field and overwrites) is refused: no approval request and no apply is offered;
//   - the RECEIPT of a keep-live-keys apply reads kept names as kept, in the account and needing nothing,
//     never as "records outstanding" or "re-provisioned out of band".
//
// Run with `node test/validate-restore-overwrite-render.ts`.

import { installDomShim, qs, qsa, textOf } from "./dom-shim.ts";
installDomShim();

import type { RestorePlan, RestoreRequest, RestoreResult } from "../src/lib/api/types/restore-types.ts";
import { renderPlan } from "../src/screens/restore-flow/plan.ts";
import { renderReceipt, restoreOutcome } from "../src/screens/restore-flow/receipt.ts";
import type { FlowPrefill } from "../src/screens/restore-flow/shared.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The only engine calls renderPlan reaches (via renderConfirm) are approval lookups; the apply path is
// behind a click this test never makes.
const engine = {
  listApprovals: async () => [],
  requestRestore: async () => ({}),
  restore: async () => ({}),
} as never;

const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const sample: RestorePlan["sample"] = [
  { name: "a", sourceType: "kv", binding: "KV_ns", namespace: "ns", plaintextSize: 10, targetExists: true },
  { name: "b", sourceType: "kv", binding: "KV_ns", namespace: "ns", plaintextSize: 10, targetExists: false },
  { name: "x", sourceType: "r2", binding: "R2_bkt", bucket: "bkt", plaintextSize: 10 },
];
const basePlan: RestorePlan = {
  ok: true,
  runId: RUN,
  mode: "dry-run",
  recordsVerified: 3,
  isLatest: true,
  plannedWrites: 3,
  bytes: 30,
  sample,
  skipped: [],
  overwriteCheck: { checked: 3, existing: 1, absent: 1, unknown: 1, existingSample: ["a"] },
};

// skipPlan is basePlan as an engine that supports keep-live-keys returns it for a "skip" request: it echoes
// the choice. Every keep-live-keys case below uses it, except the one that tests an engine without the echo.
const skipPlan: RestorePlan = { ...basePlan, onExisting: "skip" };

async function render(plan: RestorePlan, req: RestoreRequest, reenter: (p: FlowPrefill) => void = () => undefined): Promise<HTMLElement> {
  return renderPlan(engine, plan, () => req, () => undefined, reenter);
}
const note = (el: HTMLElement): ReturnType<typeof qs> => qs(el, "[data-restore-overwrite]");

console.log("-- a plan that would replace live keys says so, as a caution --");
{
  const el = await render(basePlan, { runId: RUN });
  const n = note(el);
  ok("the overwrite note is rendered", n !== null);
  const text = n === null ? "" : textOf(n);
  ok("it counts the live keys an apply replaces", /1 live key or object will be replaced/.test(text));
  ok("it is a caution (impact--warn)", n !== null && (n.getAttribute("class") ?? "").includes("impact--warn"));
  ok("it names the existing key", /\ba\b/.test(text));
  ok("it tells the operator how to keep them", text.includes("Keep live keys that already exist"));
  ok("it counts the names an apply creates", /creates 1 name that does not exist/.test(text));
  ok("it counts the names whose check failed", /check failed for 1 name/.test(text));
  ok("it says the check does not read live values", /does not read live values/.test(text));
}

console.log("\n-- under keep-live-keys the same plan says the names are kept, calmly --");
{
  const el = await render(skipPlan, { runId: RUN, onExisting: "skip" });
  const n = note(el);
  const text = n === null ? "" : textOf(n);
  ok("it says the live key is kept", /1 live key or object in this plan already exists and will be kept/.test(text));
  ok("it is not a caution", n !== null && !(n.getAttribute("class") ?? "").includes("impact--warn"));
  ok("it says the apply leaves them as they are", /leaves these names as they are/.test(text));
  ok("it says a name whose check fails is not written", /does not write a name whose check fails/.test(text));
}

console.log("\n-- nothing exists, and a failed check is never 'nothing exists' --");
{
  const none = await render({ ...basePlan, overwriteCheck: { checked: 3, existing: 0, absent: 3, unknown: 0, existingSample: [] } }, { runId: RUN });
  ok("a plan where nothing exists says so", /None of the 3 KV keys and R2 objects in this plan exist in the target now/.test(textOf(note(none) ?? none)));
  const unknownOnly = await render({ ...basePlan, overwriteCheck: { checked: 3, existing: 0, absent: 1, unknown: 2, existingSample: [] } }, { runId: RUN });
  const t = textOf(note(unknownOnly) ?? unknownOnly);
  ok("a plan with failed checks does not claim nothing exists", !/None of the/.test(t) && /2 names could not be checked/.test(t));
}

console.log("\n-- the sample is bounded, and says how many it does not list --");
{
  const el = await render({ ...basePlan, overwriteCheck: { checked: 30, existing: 25, absent: 5, unknown: 0, existingSample: Array.from({ length: 20 }, (_, i) => `k${i}`) } }, { runId: RUN });
  ok("it names the 5 existing names the sample leaves out", /And 5 more names not listed/.test(textOf(note(el) ?? el)));
}

console.log("\n-- each sampled row says what is in the target now --");
{
  const el = await render(basePlan, { runId: RUN });
  const table = qs(el, "table.dp-table");
  const text = table === null ? "" : textOf(table);
  ok("the table has an 'In target now' column", text.includes("In target now"));
  ok("a live key reads 'Exists, replaced'", text.includes("Exists, replaced"));
  ok("an absent key reads 'New'", text.includes("New"));
  ok("an unchecked row reads 'Not checked', never 'New'", text.includes("Not checked"));
  const kept = await render(skipPlan, { runId: RUN, onExisting: "skip" });
  ok("under keep-live-keys a live key reads 'Exists, kept'", textOf(qs(kept, "table.dp-table") ?? kept).includes("Exists, kept"));
}

console.log("\n-- an older engine's plan renders as it always did --");
{
  const old: RestorePlan = { ...basePlan, sample: sample.map(({ targetExists: _t, ...rest }) => rest) };
  delete old.overwriteCheck;
  const el = await render(old, { runId: RUN });
  ok("no overwrite note without an overwriteCheck", note(el) === null);
  const heads = qsa(el, "table.dp-table th").map((th) => textOf(th));
  ok("no 'In target now' column without targetExists", !heads.includes("In target now"));
}

console.log("\n-- 'Restore just this' on a keep-live-keys plan carries the choice --");
{
  let seen: FlowPrefill | null = null;
  const el = await render(skipPlan, { runId: RUN, onExisting: "skip" }, (p) => {
    seen = p;
  });
  const btn = qs(el, '[data-dp="restore-flow.button.restore-one"]');
  ok("the per-row action is offered", btn !== null);
  (btn as unknown as { click(): void } | null)?.click();
  ok("the re-entry carries keepExisting", (seen as FlowPrefill | null)?.keepExisting === true);
  let plain: FlowPrefill | null = null;
  const el2 = await render(basePlan, { runId: RUN }, (p) => {
    plain = p;
  });
  (qs(el2, '[data-dp="restore-flow.button.restore-one"]') as unknown as { click(): void } | null)?.click();
  ok("a plan without keep-live-keys does not add it", plain !== null && (plain as FlowPrefill).keepExisting === undefined);
}

// applyButtons lists the approval-request and apply controls a plan offers, and confirmSection finds the
// "Confirm and apply" section that holds them (renderConfirm). Without a signed-in role the shim renders the
// section without its buttons, so the section is the signal that the apply path was reached.
const applyButtons = (el: HTMLElement): ReturnType<typeof qsa> =>
  qsa(el, "button").filter((b) => /^restore-flow\.button\.(apply|request)/.test(b.getAttribute("data-dp") ?? ""));
const confirmSection = (el: HTMLElement): ReturnType<typeof qs> => qs(el, ".restore-confirm");

console.log("\n-- a keep-live-keys plan from an engine that did not confirm it is refused --");
{
  const older = await render(basePlan, { runId: RUN, onExisting: "skip" });
  const text = textOf(older);
  ok("it says this engine cannot keep live keys", text.includes("This engine cannot keep live keys"));
  ok("it names the engine version that can", text.includes("engine 0.3.7 or later"));
  ok("it says an older engine would replace the live keys", /would replace the live keys/.test(text));
  ok("it offers no approval request and no apply", applyButtons(older).length === 0 && confirmSection(older) === null);
  ok("it shows no overwrite note that could read as a working plan", note(older) === null);
  const oldEngine: RestorePlan = { ...basePlan, sample: sample.map(({ targetExists: _t, ...rest }) => rest) };
  delete oldEngine.overwriteCheck;
  const oldEl = await render(oldEngine, { runId: RUN, onExisting: "skip" });
  ok("an older engine's plan (no overwriteCheck, no echo) is refused for keep-live-keys", textOf(oldEl).includes("This engine cannot keep live keys") && confirmSection(oldEl) === null);
  const plain = await render({ ...basePlan, onExisting: "overwrite" }, { runId: RUN, onExisting: "skip" });
  ok('an "overwrite" echo for a keep-live-keys request is refused too', textOf(plain).includes("This engine cannot keep live keys"));
  const confirmed = await render(skipPlan, { runId: RUN, onExisting: "skip" });
  ok('a plan that echoes "skip" is not refused', !textOf(confirmed).includes("This engine cannot keep live keys"));
  ok('a plan that echoes "skip" reaches the confirm-and-apply section', confirmSection(confirmed) !== null);
  const defaultReq = await render(basePlan, { runId: RUN });
  ok("a plan without keep-live-keys needs no echo", !textOf(defaultReq).includes("This engine cannot keep live keys") && confirmSection(defaultReq) !== null);
}

console.log("\n-- the receipt of a keep-live-keys apply reads kept names as kept --");
{
  const KEPT = "kept the live key or object: one of the same name exists in the target, and this restore was asked to skip existing keys; nothing written";
  const MARKER = "the captured value is an incompleteness marker (the object vanished or was skipped at capture), not real bytes; nothing written";
  const res: RestoreResult = {
    ok: true,
    runId: RUN,
    mode: "applied",
    recordsVerified: 4,
    recordsRestored: 2,
    bytesRestored: 20,
    isLatest: true,
    failures: [],
    skipped: [
      { name: "a", reason: KEPT },
      { name: "x", reason: KEPT },
    ],
  };
  const outcome = restoreOutcome(res);
  ok("an apply that only kept live keys is not 'skipped'", outcome.kind === "clean" && outcome.skippedCount === 0);
  ok("it counts the kept names on their own", outcome.keptCount === 2);
  const req: RestoreRequest = { runId: RUN, onExisting: "skip" };
  const el = renderReceipt(res, req, null, "op@example.com", "hash", null, null, null, () => undefined);
  const text = textOf(el);
  const title = qs(el, ".restore-receipt__title");
  ok("the title does not say records are outstanding", title !== null && textOf(title) === "Restore applied");
  ok("the receipt says the live keys were kept, as chosen", /2 live keys or objects already existed and were kept, as you chose/.test(text));
  ok("the kept names get their own calm group", text.includes("2 live keys or objects kept, as you chose") && /need no action/.test(text));
  ok("the receipt never calls them outstanding", !/still outstanding/.test(text) && !/records outstanding/.test(text));
  ok("the receipt never files them as re-provisioned out of band", !/re-provisioned out of band/.test(text));
  const mixed = restoreOutcome({ ...res, skipped: [...(res.skipped ?? []), { name: "m", reason: MARKER }] });
  ok("a real skip beside kept names is still 'skipped', counting only the real one", mixed.kind === "skipped" && mixed.skippedCount === 1 && mixed.keptCount === 2);
}

verdictReached(failures);
console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures}`);
if (failures > 0) process.exit(1);
