// A config-only restore plan must not headline a zero. Run with:
//   node test/validate-restore-config-only-headline.ts
//
// WHY THIS EXISTS. A Cloudflare-config downpipe carries configuration and no data records, so its dry-run
// comes back with plannedWrites 0 and recordsVerified 0 while its configChanges list real surfaces the apply
// would write. The plan screen read those two numbers as the whole plan: the figure row showed
// "Planned writes 0" and the calm impact banner read "On apply, this writes 0 verified records back to their
// original bindings". Both statements were true of data records and both told the operator the opposite of
// what the plan does.
//
// Captured on a live re-proof: the same screen read Planned writes 0 while the disclosure below offered five
// surfaces to change out of 59 examined, headed "Cloudflare config changes (59 surfaces)". The plan text was
// 1,750 characters before the disclosure was opened and 6,343 after, so a closed disclosure genuinely hid
// the diff and the zero was all there was to read.
//
// THE COUNT IS NOT INFLATED. plannedWrites means data records and is load-bearing elsewhere: the large-write
// friction threshold reads it, the approvals inbox shows it to the approver, and the receipt reconciles
// against it. Folding config surfaces into it would make one number mean two things and would escalate a
// config restore to type-to-confirm on a record count it never had. So the count stays honest and the screen
// states the config leg beside it, where the operator reads the zero, rather than only inside a section they
// have to open.
//
// This asserts on the text the screen PRESENTS, not on internal state, and in both directions: a
// data-bearing plan must still report its own count and must not grow a config claim it has no surfaces for.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim, qs, textOf } from "./dom-shim.ts";
installDomShim();

import type { RestorePlan, RestoreRequest } from "../src/lib/api/types/restore-types.ts";
import { renderPlan } from "../src/screens/restore-flow/plan.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// renderPlan reaches the engine only for approval lookups; the apply path is behind a click never made here.
const engine = { listApprovals: async () => [], requestRestore: async () => ({}), restore: async () => ({}) } as never;

const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// The shape the live re-proof captured: 59 surfaces examined, 5 of them with something to write. The other
// 54 read "no changes (already matches the snapshot)" and must not be counted as writes.
function configChanges(): NonNullable<RestorePlan["configChanges"]> {
  const willApply = [
    { surface: "dns", summary: "1 to add", willApply: true },
    { surface: "zone-settings", summary: "1 to change", willApply: true },
    { surface: "url-normalization", summary: "1 to change", willApply: true },
    { surface: "rulesets", summary: "1 to change, 1 live-only (left in place)", willApply: true },
    { surface: "zone-setting-auto-origin-tls-kex", summary: "1 to change", willApply: true },
  ];
  const unchanged = Array.from({ length: 54 }, (_, i) => ({ surface: `surface-${i}`, summary: "no changes (already matches the snapshot)", willApply: false }));
  return [...willApply, ...unchanged];
}

const configOnly: RestorePlan = {
  ok: true, runId: RUN, mode: "dry-run",
  recordsVerified: 0, isLatest: true, plannedWrites: 0, bytes: 0,
  sample: [], skipped: [],
  configChanges: configChanges(),
};

const dataOnly: RestorePlan = {
  ok: true, runId: RUN, mode: "dry-run",
  recordsVerified: 12, isLatest: true, plannedWrites: 12, bytes: 2048,
  sample: [], skipped: [],
};

const bothLegs: RestorePlan = { ...dataOnly, configChanges: configChanges() };

const req: RestoreRequest = { runId: RUN, cfConfig: { token: "t", accountId: "acct-1", zoneId: "zone-1" } };
const plainReq: RestoreRequest = { runId: RUN };

async function render(plan: RestorePlan, r: RestoreRequest): Promise<HTMLElement> {
  return await renderPlan(engine, plan, () => r, () => undefined, () => undefined);
}

async function main(): Promise<void> {
  console.log("-- a config-only plan (real renderPlan, asserted on the text the screen presents) --");
  {
    const el = await render(configOnly, req);
    const text = textOf(el);
    // The impact banner is the first thing read and is where the zero did its damage.
    const banner = qs(el as never, ".impact__line");
    const bannerText = banner ? textOf(banner) : "";
    ok("the impact banner names the config surfaces the apply would write", /5 Cloudflare config surfaces/.test(bannerText));
    ok(
      "the impact banner does not claim the apply writes verified records",
      !/writes 0 verified records/.test(bannerText) && !/Write 0 verified records/.test(bannerText),
    );
    ok("the impact banner still says nothing has been written yet", /Nothing has been written yet/.test(bannerText));

    // The figure row is the second reading of the same zero.
    const figs = textOf(qs(el as never, ".restore-figs")!);
    ok("the figure row carries a config-surfaces figure", /Config surfaces to apply/.test(figs));
    // textOf concatenates the tile's label, value and caption with no separator, so the value is asserted
    // as the text immediately following its own label. That adjacency is the point: it is what a reader sees.
    ok("the config figure counts only the surfaces that will apply", /Config surfaces to apply5of 59 examined/.test(figs));
    ok("the config figure says how many surfaces were examined", /of 59 examined/.test(figs));
    ok("the planned-writes figure says what it counts", /data records written on apply/.test(figs));

    // The diff must not be hidden behind a closed section when it is the whole plan.
    const details = (el as unknown as { querySelectorAll(sel: string): Array<{ getAttribute(n: string): string | null; textContent: string }> }).querySelectorAll("details");
    const configDetails = details.find((d) => /Cloudflare config changes/.test(d.textContent));
    ok("the Cloudflare config disclosure renders", configDetails !== undefined);
    ok("the Cloudflare config disclosure is open when surfaces will apply", configDetails?.getAttribute("open") !== null);
    ok("the surface diff is present in the plan text", /url-normalization/.test(text));
  }

  console.log("\n-- a data-only plan still reports its own count and claims no config --");
  {
    const el = await render(dataOnly, plainReq);
    const bannerText = textOf(qs(el as never, ".impact__line")!);
    ok("the impact banner states the record count", /writes 12 verified records/.test(bannerText));
    ok("the impact banner makes no config claim", !/Cloudflare config surfaces/.test(bannerText));
    const figs = textOf(qs(el as never, ".restore-figs")!).replace(/\s+/g, " ");
    ok("the planned-writes figure states the count", /Planned writes12data records written on apply/.test(figs));
    ok("no config figure is invented for a plan with no config", !/Config surfaces to apply/.test(figs));
  }

  console.log("\n-- a plan with both legs states both, and neither count absorbs the other --");
  {
    const el = await render(bothLegs, req);
    const bannerText = textOf(qs(el as never, ".impact__line")!);
    ok("the impact banner states the record count", /writes 12 verified records/.test(bannerText));
    ok("the impact banner states the config surfaces too", /5 Cloudflare config surfaces/.test(bannerText));
    const figs = textOf(qs(el as never, ".restore-figs")!).replace(/\s+/g, " ");
    ok("the planned-writes figure still counts data records only", /Planned writes12data records/.test(figs));
    ok("the config figure still counts surfaces only", /Config surfaces to apply5of 59 examined/.test(figs));
  }

  console.log("\n-- a plan whose config surfaces all already match claims no writes it does not make --");
  {
    const noneApply: RestorePlan = {
      ...configOnly,
      configChanges: Array.from({ length: 59 }, (_, i) => ({ surface: `surface-${i}`, summary: "no changes (already matches the snapshot)", willApply: false })),
    };
    const el = await render(noneApply, req);
    const bannerText = textOf(qs(el as never, ".impact__line")!);
    ok("the impact banner claims no config surfaces when none will apply", !/Cloudflare config surfaces/.test(bannerText));
    const figs = textOf(qs(el as never, ".restore-figs")!).replace(/\s+/g, " ");
    ok("the config figure reads zero rather than 59", /Config surfaces to apply0of 59 examined/.test(figs));
  }

  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

await main();
