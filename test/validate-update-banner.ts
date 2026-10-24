// The update strip (src/shell/update-banner.ts): the full-width line under the context bar while the
// "Update available" chip has a verdict.
//
// Two halves. The pure decision runs on a pinned clock: no verdict gives nothing; the tone follows the
// engine's support status for the RUNNING version through the support notice's own rule; a console-only
// update stays neutral; a dismissal hides the line for the same versions and tone and shows it for a new
// version or a worse tone; the alert-destination line counts ENABLED channels only and is absent in the tour.
// Then the real strip is built over the DOM shim and driven: hidden until a verdict, updated in place, a real
// dismiss button with a name, focus after a dismiss, a polite live region, a throwing session store, and the
// refresh in lib/app-refresh.ts: the update line at the chip's moment, the destination line when its bounded
// read returns, and a re-read when a channel changes.
//
//   node test/validate-update-banner.ts

import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import type { UpdateStatus } from "../src/api.ts";

let failures = 0;
function ok(what: string, cond: boolean): void {
  console.log(cond ? `  ok   ${what}` : `  FAIL ${what}`);
  if (!cond) failures++;
}

const { installDomShim, textOf, qs, qsa, activeElement } = await import("./dom-shim.ts");
installDomShim();
const {
  updateBannerModel, visibleBanner, sinkStateFrom, buildUpdateStrip, readDismissals, SINK_PROMPT, SINK_DISABLED_PROMPT,
  formatSupportDate,
} = await import("../src/shell/update-banner.ts");
const { refreshUpdateChip, updateChipView, wireSinkRefresh, SINK_READ_TIMEOUT_MS } = await import("../src/lib/app-refresh.ts");
const { requestAlertSinkRefresh } = await import("../src/lib/alert-sink-signal.ts");
const { UPDATE_CHIP_ROUTE } = await import("../src/shell/chrome.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const UNTIL = "2027-01-03T00:00:00.000Z";
const UNTIL_MS = Date.parse(UNTIL);
const base: UpdateStatus = { configured: true, verified: true, currentVersion: "0.3.7", recommendedVersion: "0.3.9", updateAvailable: true };
const chipOf = (u: UpdateStatus, own: string | null = null) => updateChipView(u, own);
type El = { hidden: boolean; click(): void; getAttribute(n: string): string | null; className?: string };
const asEl = (n: unknown): El => n as El;
const none = { update: null, sink: null };
const strip = (tour = false, focus: string[] = []) => buildUpdateStrip({ navigate: () => {}, updateRoute: UPDATE_CHIP_ROUTE, tour: () => tour, focusMain: () => { focus.push("main"); } });

console.log("-- the decision --");
{
  ok("no chip verdict: the strip is hidden", updateBannerModel(null, base) === null);
  ok("no update, no destination problem: nothing shows", visibleBanner({ update: null, sink: "ok" }, none) === null && visibleBanner({ update: null, sink: null }, none) === null);
  ok("the support date is one formatter: day, full month, year", formatSupportDate(UNTIL) === "3 January 2027" && formatSupportDate("2026-10-25T00:00:00.000Z") === "25 October 2026");
  ok("the support date reads the UTC day at the day boundary", formatSupportDate("2026-10-25T23:59:59.999Z") === "25 October 2026" && formatSupportDate("2026-10-26T00:00:00.000Z") === "26 October 2026");

  const neutral = updateBannerModel(chipOf(base), base, UNTIL_MS - 90 * DAY_MS)!;
  ok("neutral: tone is neutral", neutral.tone === "neutral");
  ok("neutral: names the engine release and the screen", neutral.message === "A new release is available: engine 0.3.9. Review and apply it in Licence and updates.");

  const supportedU = { ...base, supportedUntil: UNTIL, supportStatus: "supported" as const };
  ok("supported status stays neutral", updateBannerModel(chipOf(supportedU), supportedU, UNTIL_MS - 60 * DAY_MS)!.tone === "neutral");

  const endingU = { ...base, supportedUntil: UNTIL, supportStatus: "ending" as const };
  const ending = updateBannerModel(chipOf(endingU), endingU, UNTIL_MS - 10 * DAY_MS)!;
  ok("ending: tone is warn", ending.tone === "warn");
  ok("ending: names the running version, the date and the target", ending.message === "Support for engine 0.3.7 ends on 3 January 2027. Update to 0.3.9 before then in Licence and updates.");

  const eolU = { ...base, supportedUntil: UNTIL, supportStatus: "end-of-life" as const };
  const eol = updateBannerModel(chipOf(eolU), eolU, UNTIL_MS + DAY_MS)!;
  ok("end-of-life: tone is danger", eol.tone === "danger");
  ok("end-of-life: names the running version and the target", eol.message === "Engine 0.3.7 is past its end of support. Update to 0.3.9 in Licence and updates.");
  ok("the key carries the tone: ending and end-of-life differ for the same versions", ending.key !== eol.key && ending.key.startsWith("engine@0.3.9") && eol.key.startsWith("engine@0.3.9"));

  const unverifiedEol = { ...eolU, verified: false };
  ok("an unverified channel carries no trusted support date: no chip, no strip", updateBannerModel(chipOf(unverifiedEol), unverifiedEol) === null);

  const consoleOnly: UpdateStatus = { ...base, updateAvailable: false, currentVersion: "0.3.9", components: { console: { kind: "static", recommendedVersion: "0.2.9", riskClass: "low" } } as never, supportedUntil: UNTIL, supportStatus: "end-of-life" };
  const co = updateBannerModel(chipOf(consoleOnly, "0.2.8"), consoleOnly, UNTIL_MS + DAY_MS)!;
  ok("console-only: neutral whatever the engine's support says", co.tone === "neutral");
  ok("console-only: names the console component and its version", co.message === "A new release is available: console 0.2.9. Review and apply it in Licence and updates.");

  const both: UpdateStatus = { ...base, components: { engine: { kind: "worker", recommendedVersion: "0.3.9", riskClass: "low" }, console: { kind: "static", recommendedVersion: "0.2.9", riskClass: "low" } } as never };
  const bm = updateBannerModel(chipOf(both, "0.2.8"), both)!;
  ok("engine and console: names both", bm.message.startsWith("A new release is available: engine 0.3.9 and console 0.2.9."));
  ok("the dismissal key carries each component's version and the tone", bm.key === "engine@0.3.9|console@0.2.9#neutral");
}

console.log("-- dismissal and the alert-destination line --");
{
  const m = updateBannerModel(chipOf(base), base)!;
  const state = { update: m, sink: "ok" as const };
  ok("not dismissed: the update line shows", visibleBanner(state, none)?.update?.key === m.key);
  ok("dismissed for the same version and tone: hidden", visibleBanner(state, { update: m.key, sink: null }) === null);
  const next = updateBannerModel(chipOf({ ...base, recommendedVersion: "0.4.0" }), { ...base, recommendedVersion: "0.4.0" })!;
  ok("a new recommended version shows it again", visibleBanner({ update: next, sink: "ok" }, { update: m.key, sink: null })?.update?.key === next.key);
  const endingU = { ...base, supportedUntil: UNTIL, supportStatus: "ending" as const };
  const eolU = { ...base, supportedUntil: UNTIL, supportStatus: "end-of-life" as const };
  const w = updateBannerModel(chipOf(endingU), endingU, UNTIL_MS - DAY_MS)!;
  const d = updateBannerModel(chipOf(eolU), eolU, UNTIL_MS + DAY_MS)!;
  ok("a dismissed warning comes back when the status becomes end-of-life", visibleBanner({ update: d, sink: "ok" }, { update: w.key, sink: null })?.update?.tone === "danger");

  ok("zero channels: the destination line shows", visibleBanner({ update: m, sink: sinkStateFrom([]) }, none)?.sink?.message === SINK_PROMPT);
  ok("all channels disabled: the line shows with the disabled wording", visibleBanner({ update: m, sink: sinkStateFrom([{ enabled: false }, { enabled: false }]) }, none)?.sink?.message === SINK_DISABLED_PROMPT);
  ok("the disabled wording is the approved text", SINK_DISABLED_PROMPT === "No alert destination is enabled, so alerts reach nobody. Turn one on in Notifications.");
  ok("one enabled channel: no destination line", visibleBanner({ update: m, sink: sinkStateFrom([{ enabled: false }, { enabled: true }]) }, none)?.sink === null);
  ok("a failed channel read is unknown: no destination line", sinkStateFrom(null) === null && visibleBanner({ update: m, sink: null }, none)?.sink === null);
  ok("sink dismissal is separate: update dismissed, sink still shows", visibleBanner({ update: m, sink: "none" }, { update: m.key, sink: null })?.sink?.message === SINK_PROMPT);
  ok("sink dismissed, update still shows", visibleBanner({ update: m, sink: "none" }, { update: null, sink: "none" })?.update !== null && visibleBanner({ update: m, sink: "none" }, { update: null, sink: "none" })?.sink === null);
  ok("a dismissed 'none' line comes back as 'disabled'", visibleBanner({ update: m, sink: "disabled" }, { update: null, sink: "none" })?.sink?.message === SINK_DISABLED_PROMPT);
  ok("both dismissed: hidden", visibleBanner({ update: m, sink: "none" }, { update: m.key, sink: "none" }) === null);
  ok("tour mode: no destination line", visibleBanner({ update: m, sink: "none" }, none, true)?.sink === null);
  ok("tour mode: the update line still shows", visibleBanner({ update: m, sink: "none" }, none, true)?.update?.key === m.key);
  // The destination line stands alone: it needs no update line.
  ok("sink alone (none): the destination line shows", visibleBanner({ update: null, sink: "none" }, none)?.sink?.message === SINK_PROMPT && visibleBanner({ update: null, sink: "none" }, none)?.update === null);
  ok("sink alone (disabled): the disabled wording shows", visibleBanner({ update: null, sink: "disabled" }, none)?.sink?.message === SINK_DISABLED_PROMPT);
  ok("sink alone, dismissed: hidden this session", visibleBanner({ update: null, sink: "none" }, { update: null, sink: "none" }) === null);
  ok("sink alone, dismissed as 'none', comes back as 'disabled'", visibleBanner({ update: null, sink: "disabled" }, { update: null, sink: "none" })?.sink?.message === SINK_DISABLED_PROMPT);
  ok("sink alone in the tour: nothing shows", visibleBanner({ update: null, sink: "none" }, none, true) === null);
  ok("update alone: the update line shows, no destination line", visibleBanner({ update: m, sink: "ok" }, none)?.update?.key === m.key && visibleBanner({ update: m, sink: "ok" }, none)?.sink === null);
  ok("both: both lines show", visibleBanner({ update: m, sink: "none" }, none)?.update !== null && visibleBanner({ update: m, sink: "none" }, none)?.sink !== null);
  ok("the line reads as the approved wording", SINK_PROMPT === "No alert destination is set, so alerts reach nobody. Set one in Notifications.");
}

console.log("-- the strip in the DOM --");
{
  const nav: string[] = [];
  const focus: string[] = [];
  const s = buildUpdateStrip({ navigate: (r) => nav.push(r), updateRoute: UPDATE_CHIP_ROUTE, tour: () => false, focusMain: () => { focus.push("main"); } });
  const el = asEl(s.el);
  ok("hidden before any verdict (no flicker)", el.hidden === true);
  ok("it is a polite live region with a label", el.getAttribute("role") === "status" && el.getAttribute("aria-label") === "Update notice");
  ok("no inner element uses a setup strip class", !String((s.el as unknown as { innerHTML?: string }).innerHTML ?? "").includes("setup-strip") && qsa(s.el, '[class*="setup-strip"]').length === 0);

  const m = updateBannerModel(chipOf(base), base)!;
  s.apply({ update: m, sink: "none" });
  const lineBefore = qs(s.el, '[data-update-strip="update"]');
  ok("a verdict shows the strip with both lines", el.hidden === false && qsa(s.el, ".update-strip__line").filter((l) => !asEl(l).hidden).length === 2);
  ok("the update line text is on the page", textOf(s.el).includes("A new release is available: engine 0.3.9."));
  const btns = qsa(s.el, "button");
  ok("every control is a real button", btns.length === 4 && btns.every((b) => (b as unknown as { tagName: string }).tagName.toLowerCase() === "button"));
  const dismissUpdate = asEl(qs(s.el, '[data-update-strip="update"] .update-strip__dismiss'));
  ok("the dismiss button has an accessible name", dismissUpdate.getAttribute("aria-label") === "Dismiss the update notice");
  asEl(qs(s.el, '[data-update-strip="update"] .update-strip__go')).click();
  ok("the link goes to the Updates section", nav[0] === "/licence?open=updates");
  asEl(qs(s.el, '[data-update-strip="sink"] .update-strip__go')).click();
  ok("the destination link goes to Notifications", nav[1] === "/notifications");

  s.apply({ update: m, sink: "none" });
  ok("a refresh updates in place: the same line element stays", qs(s.el, '[data-update-strip="update"]') === lineBefore && qs(s.el, '[data-update-strip="update"] .update-strip__dismiss') === (dismissUpdate as unknown));

  dismissUpdate.click();
  ok("dismissing the update line leaves the destination line", asEl(qs(s.el, '[data-update-strip="update"]')).hidden === true && textOf(s.el).includes("No alert destination"));
  ok("after a dismiss, focus moves to the other line's dismiss button", activeElement() === qs(s.el, '[data-update-strip="sink"] .update-strip__dismiss'));
  ok("the dismissal is held for the session", readDismissals().update === m.key);
  s.apply({ update: m, sink: "none" });
  ok("a refresh with the same version keeps it dismissed", asEl(qs(s.el, '[data-update-strip="update"]')).hidden === true);
  const next = updateBannerModel(chipOf({ ...base, recommendedVersion: "0.4.0" }), { ...base, recommendedVersion: "0.4.0" })!;
  s.apply({ update: next, sink: "none" });
  ok("a new recommended version shows it again", textOf(s.el).includes("engine 0.4.0"));
  asEl(qs(s.el, '[data-update-strip="sink"] .update-strip__dismiss')).click();
  ok("after a dismiss with the other line showing, focus moves to it", activeElement() === qs(s.el, '[data-update-strip="update"] .update-strip__dismiss'));
  s.apply({ update: next, sink: "none" });
  ok("the destination dismissal is held, separately", asEl(qs(s.el, '[data-update-strip="sink"]')).hidden === true && readDismissals().sink === "none");
  asEl(qs(s.el, '[data-update-strip="update"] .update-strip__dismiss')).click();
  ok("both dismissed: the strip is hidden and focus goes to the main content", el.hidden === true && focus.length === 1);
  s.apply({ update: null, sink: "none" });
  ok("the verdict going away hides it", el.hidden === true);

  const endingU = { ...base, supportedUntil: UNTIL, supportStatus: "ending" as const };
  const w = updateBannerModel(chipOf(endingU), endingU, UNTIL_MS - 5 * DAY_MS)!;
  const s2 = strip();
  s2.apply({ update: w, sink: "ok" });
  ok("ending: warning tone class", String(asEl(s2.el).className).includes("update-strip--warn"));
  const eolU = { ...base, supportedUntil: UNTIL, supportStatus: "end-of-life" as const };
  const eolM = updateBannerModel(chipOf(eolU), eolU, UNTIL_MS + DAY_MS)!;
  s2.apply({ update: eolM, sink: "ok" });
  ok("end-of-life: danger tone class, the warning class is gone", String(asEl(s2.el).className).includes("update-strip--danger") && !String(asEl(s2.el).className).includes("update-strip--warn"));
  s2.apply({ update: m, sink: "ok" });
  ok("neutral again: no tone class", !String(asEl(s2.el).className).includes("update-strip--"));

  // The newest dismissal wins when a later write fails: the older stored key must not mask it.
  const tourStrip = strip(true);
  tourStrip.apply({ update: m, sink: "none" });
  ok("tour mode: the update line shows and the destination line does not", textOf(tourStrip.el).includes("A new release") && asEl(qs(tourStrip.el, '[data-update-strip="sink"]')).hidden === true);

  // A session store that throws on every call.
  const throwing = () => { throw new Error("blocked"); };
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = { getItem: throwing, setItem: throwing, removeItem: throwing, key: throwing, length: 0 };
  const s3 = strip();
  s3.apply({ update: m, sink: "none" });
  ok("storage throwing: the line still renders", asEl(s3.el).hidden === false && textOf(s3.el).includes("A new release"));
  asEl(qs(s3.el, '[data-update-strip="update"] .update-strip__dismiss')).click();
  ok("storage throwing: dismiss does not throw and the line stays hidden until reload", asEl(qs(s3.el, '[data-update-strip="update"]')).hidden === true);
  asEl(qs(s3.el, '[data-update-strip="sink"] .update-strip__dismiss')).click();
  ok("storage throwing: both dismissed in memory hides the strip", asEl(s3.el).hidden === true);
  installDomShim();
}

console.log("-- the newest dismissal wins --");
{
  installDomShim();
  const m1 = updateBannerModel(chipOf(base), base)!;
  const m2 = updateBannerModel(chipOf({ ...base, recommendedVersion: "0.4.0" }), { ...base, recommendedVersion: "0.4.0" })!;
  // The session store holds the OLDER dismissal (m1) and refuses every write, so the newer one (m2) exists
  // only in memory. The store answers the update dismissal key with m1 and everything else with nothing.
  const refuse = () => { throw new Error("quota"); };
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
    getItem: (k: string) => (k.includes("update-banner-dismissed") ? JSON.stringify(m1.key) : null),
    setItem: refuse, removeItem: refuse, key: () => null, length: 0,
  };
  const s = strip();
  s.apply({ update: m1, sink: "ok" });
  ok("the stored older dismissal hides its own key", asEl(s.el).hidden === true);
  s.apply({ update: m2, sink: "ok" });
  ok("a new version shows over the older stored dismissal", asEl(s.el).hidden === false);
  asEl(qs(s.el, '[data-update-strip="update"] .update-strip__dismiss')).click();
  s.apply({ update: m2, sink: "ok" });
  ok("the newer in-memory dismissal wins over the older stored one", asEl(s.el).hidden === true);
  installDomShim();
}

console.log("-- a sign-out clears the held dismissals --");
{
  installDomShim();
  const m = updateBannerModel(chipOf(base), base)!;
  const refuse = () => { throw new Error("quota"); };
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = { getItem: () => null, setItem: refuse, removeItem: refuse, key: () => null, length: 0 };
  const s = strip();
  s.apply({ update: m, sink: "none" });
  asEl(qs(s.el, '[data-update-strip="update"] .update-strip__dismiss')).click();
  asEl(qs(s.el, '[data-update-strip="sink"] .update-strip__dismiss')).click();
  ok("both lines are dismissed in memory (the store refuses writes)", asEl(s.el).hidden === true);
  const { clearSessionData } = await import("../src/lib/store.ts");
  clearSessionData();
  ok("a sign-out hides the strip until a verdict arrives", asEl(s.el).hidden === true);
  s.apply({ update: m, sink: "none" });
  ok("after the next sign-in the update line shows again", asEl(qs(s.el, '[data-update-strip="update"]')).hidden === false);
  ok("after the next sign-in the destination line shows again", asEl(qs(s.el, '[data-update-strip="sink"]')).hidden === false);
  installDomShim();
}

console.log("-- the refresh feeds the shell --");
{
  installDomShim();
  type St = { update: { tone: string } | null; sink: string | null };
  const calls: St[] = [];
  const shellStub = { setUpdateAvailable: () => {}, setUpdateBanner: (s: St) => { calls.push(s); } } as never;
  let channelReads = 0;

  // The update line goes out at the chip's moment, before the channel read answers.
  let release: (v: Array<{ enabled: boolean }>) => void = () => {};
  const slow = new Promise<Array<{ enabled: boolean }>>((r) => { release = r; });
  const pending = refreshUpdateChip(shellStub, async () => base, "0.1.0", () => { channelReads++; return slow; });
  await new Promise((r) => setTimeout(r, 10));
  ok("the update line is set before the channel read returns", calls.length === 1 && calls[0]!.update?.tone === "neutral" && calls[0]!.sink === null);
  release([]);
  await pending;
  ok("the destination line is added when the read returns: no channels", calls.at(-1)?.update !== null && calls.at(-1)?.sink === "none" && channelReads === 1);

  await refreshUpdateChip(shellStub, async () => base, "0.1.0", async () => [{ enabled: false }]);
  ok("all channels disabled: sink state is disabled", calls.at(-1)?.sink === "disabled");
  await refreshUpdateChip(shellStub, async () => base, "0.1.0", async () => [{ enabled: true }]);
  ok("one enabled channel: sink state is ok", calls.at(-1)?.sink === "ok");
  await refreshUpdateChip(shellStub, async () => base, "0.1.0", async () => { throw new Error("channels unreachable"); });
  ok("a failed channel read: the update line stays, destination unknown", calls.at(-1)?.update !== null && calls.at(-1)?.sink === null);

  // A hung read cannot hold the strip. The bound is injected (50 ms here), and a guard turns "never returns"
  // into a failed assertion instead of a hung run.
  const HUNG_BOUND_MS = 50;
  const GUARD_MS = 1500;
  const before = calls.length;
  const t0 = Date.now();
  const outcome = await Promise.race([
    refreshUpdateChip(shellStub, async () => base, "0.1.0", () => new Promise(() => {}), HUNG_BOUND_MS).then(() => "returned"),
    new Promise<string>((r) => setTimeout(() => r("hung"), GUARD_MS)),
  ]);
  const took = Date.now() - t0;
  ok("a never-resolving channel read returns within the bound, not hung", outcome === "returned" && took < GUARD_MS);
  ok("the update line showed first and the destination stays unknown", calls.length > before && calls[before]!.update !== null && calls[before]!.sink === null && calls.at(-1)?.update !== null && calls.at(-1)?.sink === null);
  ok("the default bound is the shipped 5 seconds", SINK_READ_TIMEOUT_MS === 5000);

  const reads = channelReads;
  await refreshUpdateChip(shellStub, async () => ({ ...base, updateAvailable: false, recommendedVersion: "0.3.7" }), "0.1.0", async () => { channelReads++; return []; });
  ok("up to date: no update line, and the channel read still runs so the destination line stands alone", calls.at(-1)?.update === null && calls.at(-1)?.sink === "none" && channelReads === reads + 1);
  await refreshUpdateChip(shellStub, async () => { throw new Error("updates unreachable"); }, "0.1.0", async () => { channelReads++; return []; });
  ok("the update read failed: the channel read still runs", channelReads === reads + 2 && calls.at(-1)?.sink === "none");
}

console.log("-- the strip element with each line alone --");
{
  installDomShim();
  const m = updateBannerModel(chipOf(base), base)!;
  const vis = (s: { el: unknown }) => qsa(s.el as never, ".update-strip__line").filter((l) => !asEl(l).hidden).length;
  const sinkEl = (s: { el: unknown }) => asEl(qs(s.el as never, '[data-update-strip="sink"]'));
  const { clearDraft } = await import("../src/lib/draft.ts");
  clearDraft("update-banner-dismissed");
  clearDraft("update-banner-sink-dismissed");
  const a = strip();
  a.apply({ update: null, sink: "none" });
  ok("sink alone: the strip shows with one line, the destination line", asEl(a.el).hidden === false && vis(a) === 1 && sinkEl(a).hidden === false && textOf(a.el).includes("No alert destination is set"));
  asEl(qs(a.el, '[data-update-strip="sink"] .update-strip__dismiss')).click();
  const hiddenOnDismiss = asEl(a.el).hidden === true;
  a.apply({ update: null, sink: "none" });
  ok("sink alone, dismissed: the strip is hidden and stays hidden on a refresh", hiddenOnDismiss && asEl(a.el).hidden === true);
  const b = strip();
  b.apply({ update: m, sink: "ok" });
  ok("update alone: the strip shows the update line only", asEl(b.el).hidden === false && vis(b) === 1 && sinkEl(b).hidden === true);
  const c = strip();
  c.apply({ update: m, sink: "disabled" });
  ok("both: the strip shows two lines", asEl(c.el).hidden === false && vis(c) === 2);
  const d = strip();
  d.apply({ update: null, sink: "ok" });
  ok("neither: the strip element is hidden", asEl(d.el).hidden === true && vis(d) === 0);
}

console.log("-- a channel change re-reads the list --");
{
  type St = { update: { tone: string } | null; sink: string | null };
  const calls: St[] = [];
  const shellStub = { setUpdateAvailable: () => {}, setUpdateBanner: (s: St) => { calls.push(s); } } as never;
  await refreshUpdateChip(shellStub, async () => base, "0.1.0", async () => []);
  ok("before the change: the destination line is asked for", calls.at(-1)?.sink === "none");
  wireSinkRefresh(shellStub);
  const n = calls.length;
  requestAlertSinkRefresh();
  ok("with no engine connected the signal does nothing and does not throw", calls.length === n);

  // Connect an engine whose channel list answers from a fake fetch.
  const { connect } = await import("../src/lib/store.ts");
  let listed: Array<{ id: string; kind: string; name: string; enabled: boolean; createdAt: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as { url: string }).url);
    if (url.endsWith("/admin/notify/channels")) return new Response(JSON.stringify(listed), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  connect("https://engine.test");
  requestAlertSinkRefresh();
  await new Promise((r) => setTimeout(r, 50));
  ok("a channel change re-reads: still no channel, the line stays", calls.at(-1)?.sink === "none");
  listed = [{ id: "c1", kind: "webhook", name: "ops", enabled: true, createdAt: "2026-10-13T00:00:00Z" }];
  requestAlertSinkRefresh();
  await new Promise((r) => setTimeout(r, 50));
  ok("after a channel is added, the signal clears the destination line at once", calls.at(-1)?.sink === "ok" && calls.at(-1)?.update !== null);
  listed = [{ ...listed[0]!, enabled: false }];
  requestAlertSinkRefresh();
  await new Promise((r) => setTimeout(r, 50));
  ok("after the only channel is switched off, the disabled line is asked for", calls.at(-1)?.sink === "disabled");
  // The real client calls: saving or removing a channel fires the signal with no help from the screen.
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(typeof input === "string" ? input : (input as { url: string }).url);
    if (url.endsWith("/admin/notify/channels") && init?.method === "POST") {
      listed = [{ id: "c2", kind: "webhook", name: "ops2", enabled: true, createdAt: "2026-10-13T00:00:00Z" }];
      return new Response(JSON.stringify(listed[0]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/admin/notify/channels/delete")) {
      listed = [];
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/admin/notify/channels")) return new Response(JSON.stringify(listed), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  listed = [];
  const { getEngine } = await import("../src/lib/store.ts");
  const eng = getEngine()!;
  await eng.upsertNotifyChannel({ kind: "webhook", name: "ops2", url: "https://hooks.example.com/x", enabled: true });
  await new Promise((r) => setTimeout(r, 50));
  ok("saving a channel through the client clears the destination line", calls.at(-1)?.sink === "ok");
  await eng.deleteNotifyChannel("c2");
  await new Promise((r) => setTimeout(r, 50));
  ok("removing the channel through the client brings the line back", calls.at(-1)?.sink === "none");
  // With no update line, a channel change still re-reads: the destination line stands alone.
  await refreshUpdateChip(shellStub, async () => ({ ...base, updateAvailable: false, recommendedVersion: "0.3.7" }), "0.1.0", async () => listed);
  ok("no update: the destination line shows alone", calls.at(-1)?.update === null && calls.at(-1)?.sink === "none");
  listed = [{ id: "c3", kind: "webhook", name: "ops3", enabled: true, createdAt: "2026-10-14T00:00:00Z" }];
  requestAlertSinkRefresh();
  await new Promise((r) => setTimeout(r, 50));
  ok("no update: a channel change still re-reads and clears the destination line", calls.at(-1)?.update === null && calls.at(-1)?.sink === "ok");
  globalThis.fetch = realFetch;
}

console.log(failures === 0 ? "\nUPDATE BANNER PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures);
if (failures > 0) process.exit(1);
