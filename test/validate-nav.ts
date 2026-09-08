// Validates the navigation foundation (src/lib/nav.ts referrer ring + backTo + leave
// guard, and src/lib/draft.ts honesty/prune logic): the pieces every crumb and Back
// control depend on. The bridge's navigate is stubbed via installNav so backTo's
// target is captured without a router; sessionStorage + the engine host are shimmed
// for the draft tests. It ALSO covers the rail's quiet "needs attention" count chip
// (the /credentials count from status.expiryWarnings + status.cleanupPending) AND the
// context-bar "Update available" chip (the pure verdict decision, the chip DOM, the
// fail-open refresh, the /licence?open=updates deep link and its reveal), rendering
// the REAL shell chrome under the shared DOM shim. Run: node test/validate-nav.ts.

// ---- minimal shims (installed before importing the modules under test) ----------
// The DOM shim is imported FIRST and installed before any DOM-touching module is imported, so the
// shell's buildNavLink/applyNavCount (and lib/dom.ts) resolve document/element APIs. None of the
// modules imported below touch document at LOAD time (their document use is inside functions), so the
// install order is sound.
import { installDomShim, dispatchDocKey, keydown } from "./dom-shim.ts";
installDomShim();

const storeUrl: string | null = "https://engine.example.test";
const memStore = new Map<string, string>();
(globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, String(v)),
  removeItem: (k: string) => void memStore.delete(k),
};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  installNav, navigate, recordNav, referrer, backTo, registerLeaveGuard, clearLeaveGuard, intendedNextFrom,
  takePostNavigationFocus,
} from "../src/lib/nav.ts";
import { saveDraft, loadDraft, clearDraft } from "../src/lib/draft.ts";
import { buildNavLink, applyNavCount, type Shell } from "../src/shell/app-shell.ts";
import { buildUpdateChip, applyUpdateChip, updateChipAriaLabel, UPDATE_CHIP_ROUTE, type UpdateChipView } from "../src/shell/chrome.ts";
import { updateChipView, refreshUpdateChip, maybeRefreshUpdateChip, primeUpdateChipRefresh, UPDATE_CHIP_TTL_MS } from "../src/lib/app-refresh.ts";
import { revealUpdatesSection, licenceScreen, UPDATES_HEADING_ID } from "../src/screens/licence.ts";
import { buildSeed } from "../src/lib/demo/demo-seed.ts";
import { h } from "../src/lib/dom.ts";
import { NAV, type NavItem } from "../src/shell/nav.ts";
import type { UpdateStatus } from "../src/api.ts";
import * as store from "../src/lib/store.ts";
import { openDetail } from "../src/screens/sources-downpipes/detail.ts";
import { closeAllOverlays } from "../src/components/dialog.ts";

// store.ts reads the engine URL for the draft scope; stub it through the module the
// draft imports. draft.ts imports getEngineUrl from store.ts, which reads in-memory
// state set by connect(); use the store's own setter path via a tiny shim is overkill,
// so we assert draft behaviour that does not depend on the exact host (prune + honesty
// + round-trip), which hold for any stable scope.
void storeUrl;

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

// Capture where navigate() sends us.
let lastNavigated: string | null = null;
installNav({
  navigate: (to: string) => {
    lastNavigated = to;
  },
  onUnauthorised: () => {},
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  signOut: () => {},
});

console.log("-- referrer ring: records the prior path, ignores same-path replace --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  recordNav("/sources");
  recordNav("/sources/advanced");
  ok("referrer is the path before the current one", referrer() === "/sources");
  recordNav("/sources/advanced"); // same-path replaceState (filter reflection): ignored
  ok("a same-path re-record does not become its own referrer", referrer() === "/sources");
  recordNav("/downpipes");
  ok("the referrer advances to the genuine prior path", referrer() === "/sources/advanced");
}

console.log("-- backTo: returns to a safe referrer, else the structural fallback --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  recordNav("/sources");
  recordNav("/sources/advanced"); // referrer is /sources, current is /sources/advanced
  lastNavigated = null;
  backTo("/sources");
  ok("backTo returns to the real referrer when it is a safe in-app path", lastNavigated === "/sources");

  // Cold deep-link: no useful referrer -> the structural fallback is used.
  recordNav("/restore/:runId-cold"); // a fresh first nav; referrer is whatever preceded
  // Force the referrer to an auth route, which backTo must refuse and fall back instead.
  recordNav("/passkey");
  recordNav("/restore/run-1"); // referrer now /passkey (unsafe)
  lastNavigated = null;
  backTo("/restore");
  ok("backTo refuses an auth-route referrer and uses the fallback", lastNavigated === "/restore");
}

console.log("-- sign-in redirect target: intendedNextFrom captures the operator's real destination --");
{
  const q = (search: string): URLSearchParams => new URLSearchParams(search);

  // An ordinary route (not the sign-in screen): the path + query is captured as-is, unchanged from the
  // pre-fix behaviour.
  ok("an ordinary route with no query captures the bare path", intendedNextFrom({ path: "/downpipes", query: q("") }) === "/downpipes");
  ok("an ordinary route WITH a query captures path + query", intendedNextFrom({ path: "/runs", query: q("status=failed") }) === "/runs?status=failed");

  // The task's explicit requirement: a genuine "/" session still yields next=/.
  ok("a genuine '/' session yields '/'", intendedNextFrom({ path: "/", query: q("") }) === "/");

  // A genuine FIRST landing on the sign-in screen, no next= yet: defaults to "/", unchanged.
  ok("a first landing on /passkey with no next= defaults to '/'", intendedNextFrom({ path: "/passkey", query: q("") }) === "/");
  ok("a first landing on /signed-out with no next= defaults to '/'", intendedNextFrom({ path: "/signed-out", query: q("") }) === "/");

  // THE FIX: already on /passkey carrying a safe,
  // existing next= (a prior, correct redirect) -- PRESERVE it rather than resetting to "/". This is
  // exactly the shape a second, later-settling 401 handler sees once the first caller has already
  // redirected (routeToSignIn's own navigate is a REPLACE, so the address bar genuinely reads /passkey
  // by the time a second caller's rejection is processed).
  ok(
    "already on /passkey with an existing safe next= PRESERVES it (the boot-race fix)",
    intendedNextFrom({ path: "/passkey", query: q("next=%2Fdownpipes") }) === "/downpipes",
  );
  ok(
    "the same preservation holds on /signed-out",
    intendedNextFrom({ path: "/signed-out", query: q("next=%2Fdownpipes") }) === "/downpipes",
  );

  // Safety: an UNSAFE existing next= (protocol-relative or an absolute off-site URL) is never
  // preserved -- falls back to "/", mirroring the same-origin guard app.ts's onAuthenticated already
  // applies when CONSUMING next= after a successful sign-in.
  ok(
    "an unsafe protocol-relative next= is rejected, not preserved",
    intendedNextFrom({ path: "/passkey", query: q(`next=${encodeURIComponent("//evil.example.com")}`) }) === "/",
  );
  ok(
    "an unsafe absolute-URL next= is rejected, not preserved",
    intendedNextFrom({ path: "/passkey", query: q(`next=${encodeURIComponent("https://evil.example.com")}`) }) === "/",
  );
}

console.log("-- sign-in redirect target: end-to-end boot-race regression (a reload of /downpipes racing a second 401) --");
{
  // A minimal fake of the Router surface routeToSignIn actually calls: current() reads back whatever
  // navigate() last wrote, exactly like the real Router (which re-reads location.pathname/search fresh
  // on every call). This proves the INTEGRATION, not just the pure function in isolation: the same
  // production-shaped redirect step is invoked twice in a row, exactly as two independent 401 handlers
  // racing at boot (or across a reload) would each independently call routeToSignIn.
  let path = "/downpipes";
  let search = "";
  const fakeRouter = {
    current: (): { path: string; query: URLSearchParams } => ({ path, query: new URLSearchParams(search) }),
    navigate: (to: string): void => {
      const [p, s] = to.split("?");
      path = p!;
      search = s ?? "";
    },
  };
  const redirectToSignIn = (): void => {
    const to = `/passkey?next=${encodeURIComponent(intendedNextFrom(fakeRouter.current()))}`;
    fakeRouter.navigate(to);
  };

  // FIRST caller: the Downpipes screen's own load() catches its 401 while genuinely on /downpipes.
  redirectToSignIn();
  ok(
    "the FIRST 401 handler redirects to /passkey?next=%2Fdownpipes",
    fakeRouter.current().path === "/passkey" && fakeRouter.current().query.get("next") === "/downpipes",
  );

  // SECOND caller: a slightly later, independent read (a different screen's own load-catch, or the same
  // screen's own freshness-fill helper) ALSO 401s and calls the same redirect step again. Before the fix
  // this unconditionally reset next= to "/" the instant current().path read "/passkey"; it must now
  // preserve the destination the first caller already, correctly, established.
  redirectToSignIn();
  ok(
    "a SECOND, later 401 handler does not clobber the first caller's destination with next=/",
    fakeRouter.current().path === "/passkey" && fakeRouter.current().query.get("next") === "/downpipes",
  );

  // A third call changes nothing further: the redirect is now idempotent under repeated 401s.
  redirectToSignIn();
  ok(
    "a THIRD 401 handler is still idempotent (next= stays /downpipes, never resets)",
    fakeRouter.current().query.get("next") === "/downpipes",
  );

  // A genuine, real "/" session: the operator was actually on Overview when their session died. A
  // single 401 handler (no race in flight) must still yield next=/, unchanged (the task's explicit
  // requirement that this fix must not break).
  path = "/";
  search = "";
  redirectToSignIn();
  ok(
    "a genuine '/' session (no race) still yields next=/",
    fakeRouter.current().path === "/passkey" && fakeRouter.current().query.get("next") === "/",
  );
}

console.log("-- leave guard: a registered guard can veto a navigation --");
{
  lastNavigated = null;
  const guard = (_to: string): boolean => false; // always block
  registerLeaveGuard(guard);
  navigate("/somewhere");
  ok("a vetoing guard stops navigate()", lastNavigated === null);
  clearLeaveGuard(guard);
  navigate("/somewhere");
  ok("after the guard clears, navigate() proceeds", lastNavigated === "/somewhere");

  // A guard only clears for its owner (a newer screen's guard is not clobbered).
  const a = (_to: string): boolean => false;
  const b = (_to: string): boolean => false;
  registerLeaveGuard(a);
  clearLeaveGuard(b); // b is not the active guard: no-op
  lastNavigated = null;
  navigate("/x");
  ok("clearLeaveGuard(other) does not clear the active guard", lastNavigated === null);
  clearLeaveGuard(a);
}

console.log("-- draft: round-trip, clear, and the prune-by-caller pattern --");
{
  clearDraft("t1");
  ok("absent draft reads null", loadDraft("t1") === null);
  saveDraft("t1", [["SRC_KV_a", "kv"], ["SRC_R2_b", "r2"]]);
  const got = loadDraft<Array<[string, string]>>("t1");
  ok("a saved selection round-trips", Array.isArray(got) && got.length === 2 && got[0]![0] === "SRC_KV_a");
  clearDraft("t1");
  ok("a cleared draft reads null again", loadDraft("t1") === null);

  // The honesty contract is a CALLER discipline (no secret in the value); the module
  // stores whatever it is given, so the guard is that callers never pass a secret.
  // Here we assert the value is stored verbatim (so a reviewer can grep call sites),
  // not transformed or "secured" (there is no secure browser store; pretending would
  // be the dishonesty the design refuses).
  saveDraft("t2", { name: "app db", type: "d1" });
  ok("a non-secret draft stores verbatim (no fake 'secure' transform)", JSON.stringify(loadDraft("t2")) === JSON.stringify({ name: "app db", type: "d1" }));
  clearDraft("t2");
}

console.log("-- rail count chip: the quiet /credentials 'needs attention' count (Phase 6) --");
{
  // Find the REAL /credentials nav item so the test is bound to the production rail, not a fixture.
  const credItem = NAV.flatMap((g) => g.items).find((it: NavItem) => it.route === "/credentials");
  ok("the /credentials rail item exists", credItem !== undefined);

  // A helper that renders a genuine rail link via the shell's buildNavLink (the same path renderRail
  // uses), then applies a count via the shell's applyNavCount (the same path setNavCount uses). It
  // returns the link so we can inspect the chip the production code produced.
  const linkFor = (item: NavItem): unknown => buildNavLink(item, () => {});
  type ShimLike = {
    querySelector(sel: string): { textContent: string } | null;
    getAttribute(k: string): string | null;
  };
  const credChip = (count: number | undefined): { chipText: string | null; aria: string | null } => {
    const link = linkFor(credItem!) as ShimLike & Record<string, unknown>;
    applyNavCount(link as never, count);
    const chip = link.querySelector(".nav-item__count");
    return { chipText: chip ? chip.textContent : null, aria: link.getAttribute("aria-label") };
  };

  // The combined count is the SUM the shell carries: (expiryWarnings ?? 0) + (cleanupPending ?? 0).
  // Here the app derives it; the chip's job is to render that integer. Prove > 0 renders text + aria.
  const sum = 2 + 3; // e.g. expiryWarnings=2, cleanupPending=3
  const shown = credChip(sum);
  ok("a count > 0 renders the .nav-item__count chip", shown.chipText !== null);
  ok("the chip text IS the combined integer (not a dot/colour-only marker)", shown.chipText === "5");
  ok("the link carries an aria-label naming the count (status by label, not colour alone)", (shown.aria ?? "").includes("5") && /need|needs/.test(shown.aria ?? ""));

  // ABSENT when the count is 0 (engine reported, but nothing needs attention): no chip, no aria-label.
  const zero = credChip(0);
  ok("a count of 0 renders NO chip", zero.chipText === null);
  ok("a count of 0 leaves no count aria-label on the link", zero.aria === null);

  // ABSENT when the count is undefined (engine did not report the fields: honestly absent, never a
  // fabricated 0). The shell passes null -> applyNavCount(undefined) here.
  const absent = credChip(undefined);
  ok("an undefined/absent count renders NO chip", absent.chipText === null);
  ok("an undefined/absent count leaves no count aria-label", absent.aria === null);

  // Singular wording at 1 (a small honesty/readability check on the label).
  const one = credChip(1);
  ok("a count of 1 uses the singular 'item needs attention'", (one.aria ?? "").includes("1 item needs attention"));

  // A refresh REPLACES the chip rather than stacking a second one (applyNavCount clears first).
  const link = linkFor(credItem!) as ShimLike & { querySelectorAll(sel: string): unknown[] };
  applyNavCount(link as never, 4);
  applyNavCount(link as never, 7); // simulate a status refresh raising the count
  const chips = link.querySelectorAll(".nav-item__count");
  ok("a refreshed count replaces the chip (exactly one chip, no stacking)", chips.length === 1);
  ok("the refreshed chip shows the NEW count", (chips[0] as { textContent: string }).textContent === "7");
  // And a refresh down to 0 removes it entirely.
  applyNavCount(link as never, 0);
  ok("a refresh to 0 removes the chip", link.querySelectorAll(".nav-item__count").length === 0);
}

console.log("-- update chip: the pure verdict decision (updateChipView) --");
{
  // A fixture factory over the mirror type so every case states only what it varies.
  const upd = (over: Partial<UpdateStatus>): UpdateStatus => ({
    configured: true, verified: true, currentVersion: "0.1.2", ...over,
  });
  const consoleComp = (rec: string): NonNullable<UpdateStatus["components"]> => ({
    console: { kind: "static-assets", recommendedVersion: rec, riskClass: "routine" },
  });

  // HIDDEN: unconfigured, unverified (even a lying updateAvailable never shows), up to date.
  ok("unconfigured channel -> hidden", updateChipView(upd({ configured: false }), "0.1.0") === null);
  ok("unverified channel -> hidden even if it claims updateAvailable", updateChipView(upd({ verified: false, updateAvailable: true }), "0.1.0") === null);
  ok("verified + up to date -> hidden", updateChipView(upd({ updateAvailable: false, recommendedVersion: "0.1.2" }), "0.1.2") === null);

  // SHOWN: an engine update. The chip names the COMPONENT with an update, never a version (the engine and
  // console version independently, so a lone number would be ambiguous).
  const eng = updateChipView(upd({ updateAvailable: true, recommendedVersion: "0.2.0" }), "0.1.0");
  ok("engine update available -> shown, names the engine component (no version)", eng !== null && JSON.stringify(eng.components) === JSON.stringify(["engine"]));
  const engNoVer = updateChipView(upd({ updateAvailable: true }), "0.1.0");
  ok("engine update without a named version -> still shown (the chip never needed the version)", (engNoVer?.components.includes("engine") ?? false));
  const engUnstamped = updateChipView(upd({ updateAvailable: true, recommendedVersion: "0.2.0" }), null);
  ok("an unstamped console build still shows an ENGINE update", (engUnstamped?.components.includes("engine") ?? false));

  // SHOWN: a console-only release (components map + a strictly newer baked-version mismatch),
  // exactly the licence screen's own consoleUpdateAvailable decision.
  const con = updateChipView(upd({ updateAvailable: false, components: consoleComp("0.2.0") }), "0.1.0");
  ok("console-only update (components newer than the baked version) -> shown, names the console", con !== null && JSON.stringify(con.components) === JSON.stringify(["console"]));
  ok("console component EQUAL to the baked version -> hidden", updateChipView(upd({ components: consoleComp("0.1.0") }), "0.1.0") === null);
  ok("console component OLDER than the baked version -> hidden (never a downgrade nudge)", updateChipView(upd({ components: consoleComp("0.0.9") }), "0.1.0") === null);
  ok("unstamped build (null own version) cannot honestly compare -> console-only stays hidden", updateChipView(upd({ components: consoleComp("0.2.0") }), null) === null);

  // Both components newer -> the chip names BOTH (engine first, console second), still no version.
  const both = updateChipView(upd({ updateAvailable: true, recommendedVersion: "0.2.0", components: consoleComp("0.2.0") }), "0.1.0");
  ok("engine + console both newer -> one chip naming both components", both !== null && JSON.stringify(both.components) === JSON.stringify(["engine", "console"]));
  ok("the aria-label names both components (no version)", updateChipAriaLabel(both!.components) === "Engine and Console updates available");
  ok("a single-component aria-label reads naturally", updateChipAriaLabel(["engine"]) === "Engine update available");
}

console.log("-- update chip: the REAL context-bar chip DOM (buildUpdateChip / applyUpdateChip) --");
{
  let opened = 0;
  const chip = buildUpdateChip(() => { opened++; });
  type ChipLike = {
    hidden: boolean;
    click(): void;
    getAttribute(k: string): string | null;
    querySelector(sel: string): { textContent: string } | null;
  };
  const c = chip as unknown as ChipLike;

  // Hidden until a real verdict lands: no flicker while status loads.
  ok("the chip is built HIDDEN (nothing shows before a verdict loads)", c.hidden === true);
  ok("the chip is a real button with the plain accessible name", c.getAttribute("type") === "button" && c.getAttribute("aria-label") === "Update available");

  // A verdict shows the chip with the plain 'Update available' label + a component-naming aria-label.
  // NEVER a version: the engine and console version independently, so the chip cannot claim one number.
  applyUpdateChip(chip, { components: ["engine"] });
  ok("a verdict shows the chip", c.hidden === false);
  ok("the visible label reads 'Update available' (no version anywhere on the chip)", c.querySelector(".update-chip__label")?.textContent === "Update available");
  ok("the chip renders NO version element at all", c.querySelector(".update-chip__version") === null);
  ok("the aria-label names the component, not a version", c.getAttribute("aria-label") === "Engine update available");

  // A refresh replaces the accessible name in place, and a null verdict hides it again.
  applyUpdateChip(chip, { components: ["engine", "console"] });
  ok("a refreshed verdict updates the aria-label in place (both components)", c.getAttribute("aria-label") === "Engine and Console updates available");
  applyUpdateChip(chip, null);
  ok("a null verdict hides the chip again (appear/disappear without a reload)", c.hidden === true);
  ok("hiding restores the plain accessible name", c.getAttribute("aria-label") === "Update available");

  // A console-only verdict names the console.
  applyUpdateChip(chip, { components: ["console"] });
  ok("a console-only verdict shows the chip naming the console", c.hidden === false && c.getAttribute("aria-label") === "Console update available");

  // Activation invokes the open callback (the shell wires it to navigate(UPDATE_CHIP_ROUTE)).
  c.click();
  ok("clicking the chip invokes the open callback", opened === 1);
}

console.log("-- update chip: the /licence deep link + the Updates-section reveal --");
{
  // The chip's destination and the licence screen cannot drift: the route the shell navigates to is
  // the licence screen's own route plus the ?open=updates deep link its coordinator handles.
  ok("UPDATE_CHIP_ROUTE targets the licence screen's declared route", licenceScreen.route === "/licence" && UPDATE_CHIP_ROUTE.startsWith("/licence"));
  ok("UPDATE_CHIP_ROUTE carries the open=updates deep link", UPDATE_CHIP_ROUTE === "/licence?open=updates");

  // The wiring the DOM tests cannot reach, pinned at the source (the validate-tour idiom): the
  // shell chrome navigates the chip through the shared constant, the coordinator reads the ?open=
  // flag, the view stamps the heading id, and the app refreshes the chip on nav + focus + identity.
  const domSrc = readFileSync(join("src", "shell", "dom.ts"), "utf8");
  ok("shell/dom.ts wires the chip click to navigate(UPDATE_CHIP_ROUTE)", domSrc.includes("buildUpdateChip(() => cb.navigate(UPDATE_CHIP_ROUTE))"));
  const licSrc = readFileSync(join("src", "screens", "licence.ts"), "utf8");
  ok("licence.ts reads the ?open=updates deep link", licSrc.includes('ctx.query.get("open") === "updates"'));
  ok("licence.ts reveals the Updates section after the FIRST load, deferred past the shell's navigation focus", licSrc.includes("requestAnimationFrame(() => requestAnimationFrame(() => revealUpdatesSection(region)))"));
  const viewSrc = readFileSync(join("src", "screens", "licence", "view.ts"), "utf8");
  ok("licence/view.ts stamps the Updates heading with UPDATES_HEADING_ID + tabindex -1", viewSrc.includes('id: UPDATES_HEADING_ID, tabindex: "-1"'));
  const appSrc = readFileSync(join("src", "app.ts"), "utf8");
  ok("app.ts refreshes the chip on navigation (afterEach)", appSrc.includes("maybeRefreshUpdateChip(shell);"));
  ok("app.ts primes the next refresh after a /licence visit", appSrc.includes('if (match.pattern === "/licence") primeUpdateChipRefresh();'));

  // revealUpdatesSection against a region carrying the heading the view builds (same id + tabindex):
  // found -> scrolled (guarded under the shim) + FOCUSED, so a keyboard/AT operator lands on the section.
  const heading = h("h2", { class: "section-title", id: UPDATES_HEADING_ID, tabindex: "-1" }, "Updates");
  const region = h("div", {}, h("p", {}, "before"), heading);
  ok("revealUpdatesSection finds and focuses the Updates heading", revealUpdatesSection(region) === true && (document as unknown as { activeElement: unknown }).activeElement === heading);
  ok("revealUpdatesSection is honest when the region has no heading (error/skeleton states)", revealUpdatesSection(h("div")) === false);
}

console.log("-- update chip: the fail-open refresh + the low-frequency floor --");
{
  const seen: Array<UpdateChipView | null> = [];
  const shellStub = { setUpdateAvailable: (v: UpdateChipView | null) => { seen.push(v); } } as unknown as Shell;
  const avail: UpdateStatus = { configured: true, verified: true, currentVersion: "0.1.2", updateAvailable: true, recommendedVersion: "0.2.0" };
  const current: UpdateStatus = { configured: true, verified: true, currentVersion: "0.2.0", updateAvailable: false, recommendedVersion: "0.2.0" };

  // A verdict lands on the shell chip; the next refresh can take it away again (no reload).
  await refreshUpdateChip(shellStub, async () => avail, "0.1.0");
  ok("a refresh with an available update SHOWS the chip via the shell handle", seen.length === 1 && seen[0] !== null && seen[0]!.components.includes("engine"));
  await refreshUpdateChip(shellStub, async () => current, "0.1.0");
  ok("a refresh back to up-to-date HIDES the chip (appear/disappear with the cache)", seen.length === 2 && seen[1] === null);

  // Fail-open: a transient read failure leaves the chip exactly as it was (no flicker, no zeroing).
  await refreshUpdateChip(shellStub, async () => { throw new Error("channel unreachable"); }, "0.1.0");
  ok("a failing updates read leaves the chip untouched (fail-open)", seen.length === 2);

  // The refresh floor is the promise the shell makes to the vendor channel host: at most one live
  // read per 15 minutes (navigations and focus events inside the window are free).
  ok("the chip's refresh floor is at least 15 minutes", UPDATE_CHIP_TTL_MS >= 15 * 60 * 1000);

  // With NO engine connected (this validator never connects one) the coalesced entry point is a
  // no-op -- no fetch, no chip change -- and priming the window is always safe to call.
  const before = seen.length;
  maybeRefreshUpdateChip(shellStub);
  primeUpdateChipRefresh();
  ok("maybeRefreshUpdateChip without an engine is a no-op (no chip change)", seen.length === before);
}

console.log("-- update chip: demo/tour seed stays honest (no fabricated update) --");
{
  // The public tour's seeded world says the running version is current, so the chip must stay
  // HIDDEN there -- and the decision must run clean over the seed (the demo serves this exact
  // object from /admin/updates through the same code path).
  const world = buildSeed(Date.now());
  ok("the seeded demo world carries a verified, up-to-date update status", world.updates.verified === true && world.updates.updateAvailable === false);
  ok("the seeded demo verdict hides the chip (honestly absent, no error)", updateChipView(world.updates, "0.1.0") === null);
}

console.log("-- post-navigation focus survives a REAL onClose-driven navigation --");
{
  // Drives the REAL production drawer-close mechanism end to end (never re-implements it):
  // sources-downpipes/detail.ts's openDetail opens a real drawer via components/dialog.ts. Closing it
  // (Escape) fires dialog.ts's teardown(), which restores focus to the invoking row via a focusReturn
  // RESOLVER (re-found by data-key) and then IMMEDIATELY fires openDownpipeDrawer's onClose -- a
  // SECOND, real navigate() back to the plain list. That second navigate is an ORDINARY route change
  // (nav.ts's PostNavigationFocus "none" case, correctly focusing <main> when nothing is declared), and
  // the shell's own swap-and-focus runs in a LATER task than the code that scheduled it (app-shell.ts's
  // own comment on setMain, confirmed against a real browser): without care, onClose declaring no
  // intent of its own would let that deferred focus move silently overwrite the row focus teardown() had
  // JUST restored, a moment earlier, in the same synchronous close: focus would land on <main>, not the
  // row, even though the row was briefly focused first.
  //
  // The nav bridge installed below stands in for app-shell.ts's setMain, deliberately DEFERRED (a
  // macrotask) rather than read inline, so this arm exercises the actual race rather than a same-tick
  // shortcut that could never observe it.
  const stubMain = document.createElement("div");
  stubMain.id = "test-main-region-stub";
  document.body.appendChild(stubMain);
  let bridgeNavigations = 0;
  installNav({
    navigate: () => {
      bridgeNavigations++;
      setTimeout(() => {
        const declared = takePostNavigationFocus();
        (declared.el ?? stubMain).focus();
      }, 0);
    },
    onUnauthorised: () => {},
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });

  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false } as never);
  store.connect("https://engine.example.test");
  const engine = store.getEngine() as unknown as Record<string, unknown>;
  engine.listHistory = () => Promise.resolve([]);
  engine.listDestinations = () => Promise.resolve({ destinations: [] });
  const state = {
    config: { id: "dp-focus-1", name: "nightly", cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } },
    nextRunAt: 0,
    lastRunId: "",
    inFlight: false,
  } as never;

  // The row the drawer must return focus to: a plain activatable <tr data-key>, exactly the shape
  // data-table-rows.ts's buildRow produces for the downpipes table (this arm does not drive the whole
  // downpipes screen, only the close-time focus contract the drawer itself owns).
  const table = document.createElement("table");
  const row = document.createElement("tr");
  row.dataset.key = "dp-focus-1";
  row.setAttribute("tabindex", "0");
  row.textContent = "nightly";
  table.appendChild(row);
  document.body.appendChild(table);
  row.focus();
  ok("(setup) the row holds focus before the drawer opens", document.activeElement === row);

  openDetail(engine as never, state, { latestRun: new Map(), status: null, reload: () => {} });
  await new Promise((r) => setTimeout(r, 0));
  ok("(setup) the drawer opened", document.querySelector('[role="dialog"]') !== null);

  dispatchDocKey(keydown({ key: "Escape" }));
  // Immediately after Escape (synchronous): teardown() has already restored focus to the row.
  ok("focus lands on the row SYNCHRONOUSLY on close (dialog.ts teardown's own focusReturn)", document.activeElement === row);

  // Let the onClose navigation's DEFERRED post-navigation-focus consumption run (the race window).
  await new Promise((r) => setTimeout(r, 20));
  ok("THE FIX: focus is STILL on the row after the onClose navigation's deferred swap consumes the post-navigation-focus intent", document.activeElement === row);
  ok("...and NOT on the shell's <main> stand-in (the pre-fix failure mode this arm plants against)", document.activeElement !== stubMain);
  ok("the onClose navigation genuinely fired (not a no-op the assertions above could pass vacuously against)", bridgeNavigations === 1);

  closeAllOverlays();
  document.body.removeChild(table);
  document.body.removeChild(stubMain);
}

if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nNAVIGATION FOUNDATION VECTORS PASS");
