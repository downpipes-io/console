// Every prefilled rate must say whose price list it came from and when somebody last checked it.
//
// WHY THIS EXISTS
// ---------------
// An audit compared all fifteen figures in PRESETS against current published pricing and
// found ZERO drift: every non-R2 destination is priced as AWS.
//
// That is the finding, and it is not the reassuring one it looks like. The table was correct because
// Cloudflare and Amazon had not moved, not because anything checks. In the two months to that date the
// non-Cloudflare storage market repriced twice, and nothing in this repository would have noticed either.
//
// A number that is right by luck reads identically to a number that is right by design. The rate term is
// most of what the cost estimate computes, so the difference reaches the operator.
//
// The audit also refuted the claim it was sent to confirm. The rates were NOT stale. So the repair is not
// "correct the numbers" and it is not "add more vendors", which the destination form's own comment argues
// against at src/screens/destination-form-fields.ts:128. It is to make the correctness WITNESSED.
//
// WHAT IT CHECKS
// --------------
// Every preset that claims to be somebody's published price carries a named source and a checked-on date,
// the date is real and not in the future, and it has not aged past PRESET_CHECK_MAX_AGE_DAYS.
//
// It deliberately does NOT check the rates themselves against a live price list. Nothing here can reach
// one, and a check that cannot run is worse than an absent one: it would report the same green whether the
// rate was verified or unreachable. This asserts only what it can settle, which is whether a human looked
// and how long ago.
//
// "custom" is excluded on purpose. It is all zeros by design, there is no source to check it against, and
// dating it would make an unchecked thing look checked.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.
//
//   node test/validate-preset-rate-provenance.ts

import { PRESETS, PRESET_PROVENANCE, PRESET_CHECK_MAX_AGE_DAYS } from "../src/lib/cost-model-rates.ts";

let failures = 0;
let checks = 0;

function fail(msg: string): void {
  failures += 1;
  console.error(`  FAIL ${msg}`);
}

function ok(msg: string): void {
  checks += 1;
  console.log(`  ok   ${msg}`);
}

// A preset whose figures are all zero is not claiming to be anybody's price list, so it owes no
// provenance. Derived from the rates rather than from a hardcoded name, so a future all-zero preset is
// covered without anybody remembering to add it here, and a "custom" that stopped being zero would start
// owing provenance rather than keeping its exemption.
const isAllZero = (id: keyof typeof PRESETS): boolean =>
  Object.values(PRESETS[id]).every((v) => v === 0);

const claiming = (Object.keys(PRESETS) as Array<keyof typeof PRESETS>).filter((id) => !isAllZero(id));

if (claiming.length === 0) {
  // Every preset being all-zero would make this file vacuous while still exiting 0, which is the exact
  // shape the row behind it is about. Refuse instead.
  console.error("validate-preset-rate-provenance: REFUSED, no preset claims to be a published price.");
  console.error("  Every preset is all zeros, so this check has nothing to grade and will not report that it passed.");
  process.exit(2);
}
ok(`${claiming.length} preset(s) claim to be a published price and are graded here`);

// The clock is read once. Node is the only source of "now" available, and the point of the age check is
// wall-clock drift, so there is nothing to inject.
const now = Date.now();
const DAY_MS = 86_400_000;

for (const id of claiming) {
  const p = (PRESET_PROVENANCE as Record<string, { source?: string; checkedOn?: string } | undefined>)[id];
  if (p === undefined) {
    fail(`preset "${id}" carries published-looking rates and no provenance, so nothing records whose price it is`);
    continue;
  }

  if (typeof p.source !== "string" || p.source.trim() === "") {
    fail(`preset "${id}" has no named source, so a reader cannot go and verify it`);
  } else {
    ok(`"${id}" names its source`);
  }

  const raw = p.checkedOn;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    fail(`preset "${id}" has no checked-on date in YYYY-MM-DD form, so its age cannot be computed`);
    continue;
  }
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(t)) {
    fail(`preset "${id}" has a checked-on date that is not a real date: ${raw}`);
    continue;
  }
  if (t > now + DAY_MS) {
    // A future date is not a typo to shrug at. It defeats the age check entirely and would keep this
    // gate green forever.
    fail(`preset "${id}" is checked-on ${raw}, which is in the future, so the age check can never fire`);
    continue;
  }
  const ageDays = Math.floor((now - t) / DAY_MS);
  if (ageDays > PRESET_CHECK_MAX_AGE_DAYS) {
    fail(`preset "${id}" was last checked ${ageDays} days ago against ${p.source}, past the ${PRESET_CHECK_MAX_AGE_DAYS}-day window. Re-check it against the published list and move the date, or switch the screen to say the figure is unwitnessed.`);
  } else {
    ok(`"${id}" was checked ${ageDays} day(s) ago, inside the ${PRESET_CHECK_MAX_AGE_DAYS}-day window`);
  }
}

if (failures > 0) process.exitCode = 1;
console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=validate-preset-rate-provenance.ts`);
process.exit(failures === 0 ? 0 : 1);
