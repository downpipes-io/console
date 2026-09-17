// A control that FAILS and a control whose proof EXPIRED are different facts, and this file is the attack
// on the machinery that tells them apart.
//
// WHY IT EXISTS. functional-catalogue-gate.mjs used to read one number, DRIVEN, against one floor, and a
// fall meant "unresolved" whatever caused it. That collapsed a regression (a control's own drive now fails)
// into currency loss (a passing verdict stopped counting because the control's source moved), and left two
// moves when the number fell: re-bank the floor, which asserts coverage is proven when it is not, or hold
// console main red, which is the saturated signal the whole workstream exists to remove. The gate now
// classifies the fall instead, derived from the record rather than declared by anybody.
//
// THE CASE THAT MATTERS is the second one below: one control genuinely regresses WHILE hundreds of verdicts
// expire. A naive split ("nothing is failing, so it must be currency") gets that right by luck and gets the
// fourth case wrong, where the evidence is deleted rather than downgraded. Both are asserted here, and both
// are asserted from the same direction the gate reads them, so a change that relaxes either one fails here
// before it can reach a build.
//
// Three of three guards attacked in this campaign turned out to be blind, and a sibling
// gate's one-directional assertion passed on copy that had become false with its own comment predicting it.
// So every case here is REFUTABLE: it names an outcome that the code as written produces and that a
// plausible weakening changes.
//
// Run with: node test/validate-currency-vs-regression.ts
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims, no AI attribution.

import { classifyDrivenFall, contentDigest, scoreRecord, RECORD_SCHEMA } from "../scripts/verdict-record.mjs";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const CATALOGUE = [
  { key: "keys.button.rotate", file: "src/screens/keys/panel.ts" },
  { key: "sources.button.reattach", file: "src/screens/sources/tiers.ts" },
  { key: "restore-flow.button.drill", file: "src/screens/restore/flow.ts" },
  { key: "access-security.button.add#1", file: "src/screens/access/members.ts" },
  { key: "notifications.button.primary-button#2", file: "src/screens/notifications/panel.ts" },
];
/** The working tree, as the gate sees it: file -> sha256 of what is there NOW. */
const TREE: Record<string, string> = Object.fromEntries(CATALOGUE.map((r) => [r.file, contentDigest(`${r.file} as it is today`)]));
const treeDigest = (file: string) => TREE[file] ?? null;
/** The bytes a verdict was graded against, when that is NOT what the tree holds. */
const MOVED = contentDigest("some older version of this file");

type Entry = { key: string; console_sha: string; ts: string; verdict: string; seq: number; file: string; file_sha256: string };
let seq = 0;
function entry(key: string, verdict: string, ts: string, opts: { stale?: boolean; file?: string } = {}): Entry {
  const row = CATALOGUE.find((r) => r.key === key);
  if (row === undefined) throw new Error(`no catalogue row for ${key}`);
  const file = opts.file ?? row.file;
  return { key, console_sha: "0".repeat(40), ts, verdict, seq: seq++, file, file_sha256: opts.stale === true ? MOVED : (treeDigest(file) ?? MOVED) };
}
const record = (verdicts: Entry[]) => ({ schema: RECORD_SCHEMA, verdicts });
const score = (verdicts: Entry[]) => scoreRecord({ record: record(verdicts), catalogueRows: CATALOGUE, treeDigest });

console.log("\ncurrency is not regression:\n");

// 1. THE BASELINE the classification has to reproduce: everything graded against the code that is here.
//    Without this, every case below could pass because the scorer counts nothing at all.
{
  const s = score([
    entry("keys.button.rotate", "CLEAN", "2026-08-04T01:00:00.000Z"),
    entry("sources.button.reattach", "HANDLED", "2026-08-04T01:00:01.000Z"),
    entry("restore-flow.button.drill", "CLEAN", "2026-08-04T01:00:02.000Z"),
    entry("access-security.button.add#1", "CLEAN", "2026-08-04T01:00:03.000Z"),
  ]);
  ok("four current passes score as four proven", s.driven === 4);
  ok("and none of them is expired", s.expiredPassing.length === 0 && s.expiredFailing.length === 0);
  const c = classifyDrivenFall({ ...s, floor: 4 });
  ok("at the floor, nothing has fallen", c.fell === false && c.currency === false);
}

// 2. PURE CURRENCY LOSS: nothing fails, three passes stopped counting because their source moved. This is
// console main's own state, in miniature: 220 proven, 36 expired, floor 256, 220+36=256.
{
  const s = score([
    entry("keys.button.rotate", "CLEAN", "2026-08-04T01:00:00.000Z"),
    entry("sources.button.reattach", "HANDLED", "2026-08-03T02:00:00.000Z", { stale: true }),
    entry("restore-flow.button.drill", "CLEAN", "2026-08-03T02:00:01.000Z", { stale: true }),
    entry("access-security.button.add#1", "CLEAN", "2026-08-03T02:00:02.000Z", { stale: true }),
  ]);
  ok("one control still proven", s.driven === 1);
  ok("three carry an expired PASS", s.expiredPassing.length === 3);
  ok("and no control carries a standing failure", s.failing.length === 0);
  const c = classifyDrivenFall({ ...s, floor: 4 });
  ok("the fall is classified CURRENCY", c.fell === true && c.currency === true);
  ok("and the expiries account for all of it", c.recoverable === 4 && c.unexplained === 0);
}

// 3. THE CASE A NAIVE SPLIT GETS WRONG, and the one this pass was asked to prove: ONE control genuinely
//    regresses WHILE others expire, and the expiries alone WOULD have accounted for the whole fall. The
//    regression must still gate. The fixture is built so that the sum condition passes and only the
//    failing condition can refuse: driven 1 + expired 3 = 4, which is the floor exactly. Refutable in one
//    edit: delete `failing.length === 0` from classifyDrivenFall and this case reports currency.
{
  const s = score([
    entry("keys.button.rotate", "DETECT", "2026-08-04T01:00:00.000Z"), // fails against the code that is HERE
    entry("notifications.button.primary-button#2", "CLEAN", "2026-08-04T01:00:01.000Z"), // still proven
    entry("sources.button.reattach", "HANDLED", "2026-08-03T02:00:00.000Z", { stale: true }),
    entry("restore-flow.button.drill", "CLEAN", "2026-08-03T02:00:01.000Z", { stale: true }),
    entry("access-security.button.add#1", "CLEAN", "2026-08-03T02:00:02.000Z", { stale: true }),
  ]);
  ok("the regressed control is counted as failing, not as unproven", s.failing.length === 1 && s.failing[0]?.key === "keys.button.rotate");
  ok("and it is outside the proven count", s.driven === 1);
  const c = classifyDrivenFall({ ...s, floor: 4 });
  ok("the expiries alone WOULD have covered the whole fall", c.recoverable === 4 && c.unexplained === 0 && s.expiredPassing.length === 3);
  ok("and a regression alongside them is still NOT classified currency", c.currency === false);
}

// 4. THE OTHER WAY TO HIDE A REGRESSION, and the reason the sum condition exists: do not downgrade the
//    verdict, DELETE it. The record simply stops carrying the control. Nothing fails, nothing expires, and
//    a "failing is zero, therefore currency" rule would wave it through. Refutable: drop the
//    `recoverable >= floor` condition and this case starts reporting currency.
{
  const s = score([
    entry("sources.button.reattach", "HANDLED", "2026-08-03T02:00:00.000Z", { stale: true }),
    entry("restore-flow.button.drill", "CLEAN", "2026-08-03T02:00:01.000Z", { stale: true }),
    // keys.button.rotate and access-security.button.add#1 have been removed from the record entirely.
  ]);
  ok("a deleted verdict leaves no failure behind", s.failing.length === 0);
  ok("and no expiry either, which is exactly what makes it invisible to a naive test", s.expiredPassing.length === 2);
  const c = classifyDrivenFall({ ...s, floor: 4 });
  ok("deleted evidence is NOT classified currency", c.currency === false);
  ok("and the gate can say how much of the fall is unexplained", c.shortfall === 4 && c.unexplained === 2);
}

// 5. A control whose LAST grade was a failure and whose evidence then expired is debt AND an unanswered
//    failure. It must not pay for its own disappearance. Refutable: fold expiredFailing into the
//    recoverable sum and this case flips to currency.
{
  const s = score([
    entry("keys.button.rotate", "CLEAN", "2026-08-04T01:00:00.000Z"),
    entry("sources.button.reattach", "CLEAN", "2026-08-01T02:00:00.000Z", { stale: true }),
    entry("sources.button.reattach", "DETECT", "2026-08-03T02:00:00.000Z", { stale: true }), // later, and it failed
    entry("restore-flow.button.drill", "CLEAN", "2026-08-03T02:00:01.000Z", { stale: true }),
    entry("access-security.button.add#1", "CLEAN", "2026-08-03T02:00:02.000Z", { stale: true }),
  ]);
  ok("the expired control's LATEST verdict is what classifies it", s.expiredFailing.length === 1 && s.expiredFailing[0]?.key === "sources.button.reattach");
  ok("so it is not counted as an expired pass", s.expiredPassing.length === 2);
  const c = classifyDrivenFall({ ...s, floor: 4 });
  ok("a fall it is part of is NOT classified currency", c.currency === false && c.unexplained === 1);
}

// 6. A FRESH GRADE BEATS AN EXPIRED ONE, in both directions. Without this a control could be counted twice,
//    once as proven and once as owed, and the recoverable sum would run past the floor on nothing.
{
  const s = score([
    entry("keys.button.rotate", "CLEAN", "2026-08-01T01:00:00.000Z", { stale: true }),
    entry("keys.button.rotate", "CLEAN", "2026-08-04T01:00:00.000Z"),
    entry("sources.button.reattach", "CLEAN", "2026-08-01T01:00:00.000Z", { stale: true }),
    entry("sources.button.reattach", "DETECT", "2026-08-04T01:00:00.000Z"),
  ]);
  ok("a control graded against the current code is proven, not owed", s.driven === 1 && s.expiredPassing.length === 0);
  ok("and one that now fails is failing, not owed", s.failing.length === 1 && s.expiredFailing.length === 0);
}

// 7. A REFILING is currency too, not a regression: the catalogue moved the control to another source file,
//    so the verdict's own file no longer matches and it stops counting. Same treatment, different reason,
//    and the reason is carried so a reader can tell them apart.
{
  const s = score([
    entry("keys.button.rotate", "CLEAN", "2026-08-04T01:00:00.000Z"),
    entry("restore-flow.button.drill", "CLEAN", "2026-08-03T02:00:00.000Z", { file: "src/screens/restore/old-flow.ts" }),
  ]);
  ok("a refiled control's verdict is dropped", s.movedFile === 1 && s.driven === 1);
  ok("it is expired rather than failing", s.expiredPassing.length === 1 && s.failing.length === 0);
  ok("and the reason is recorded as the refiling, not as moved code", s.expiredPassing[0]?.why === "refiled");
}

// 8. A RISE is never currency. The classification only ever describes a fall, so a record that improves
//    cannot arrive at the non-gating branch by accident.
{
  const s = score([
    entry("keys.button.rotate", "CLEAN", "2026-08-04T01:00:00.000Z"),
    entry("sources.button.reattach", "CLEAN", "2026-08-04T01:00:01.000Z"),
    entry("restore-flow.button.drill", "CLEAN", "2026-08-04T01:00:02.000Z"),
  ]);
  const c = classifyDrivenFall({ ...s, floor: 2 });
  ok("above the floor, nothing has fallen and nothing is excused", c.fell === false && c.currency === false && c.unexplained === 0);
}

console.log(failures === 0 ? "\ncurrency is not regression: OK\n" : `\ncurrency is not regression: ${failures} FAILURE(S)\n`);
verdictReached(failures);
process.exit(failures === 0 ? 0 : 1);
