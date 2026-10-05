// Browser check for the tour's stacking order: what is really on top, measured with elementFromPoint in a
// headless Chromium over a locally served public/ in tour mode (?tour=1).
//
// test/validate-overlay-front-layer.ts proves the marker and the tokens.css text under the DOM shim, which
// has no CSS engine, so it cannot see a stacking defect. This script can. It checks the three cases the
// front-layer rule in public/tokens.css must satisfy:
//
//   A. Toasts stay above modals. /restore/run-visual-xacct-demo: Free Explore, then Apply restore. The
//      "Simulated action" toast must be topmost at its own centre, above the modal backdrop. The pricing
//      pill is mounted and hidden here, so this also proves a hidden front layer does not lift the modal.
//   B. The welcome card stays above a dialog the screen opens by itself (four deep links). Each welcome
//      button must be topmost at its centre, and a real click on Free Explore must dismiss the welcome.
//      The training walk's intro card is checked the same way over the credentials add dialog.
//   C. A confirm raised FROM a front layer sits above it. The external-link interstitial, raised from a
//      link on the welcome card and from a link on the tour rail. The tour's own links all go to
//      first-party hosts (no interstitial), so the check points one at a third-party host first. A toast
//      raised while that confirm is open must still be topmost.
//   D. A dialog the tour opens for a chapter (the run drawer in the Engineering Tour) stays under the rail,
//      so Next is still topmost.
//   E. Below 1024px the guide is a floating panel, not a docked rail (tokens.css's dp-tour-panel rules), and
//      a drawer's own footer action must clear it: at 768 and 390 the run drawer's "Drill this run" button
//      must sit entirely above the panel, not under it, and stay a real click target.
//
// Playwright is not a dependency of this repo, so the check is not in `npm run validate`. Run it by hand:
//   PLAYWRIGHT_MODULE=<path to playwright's index.mjs> node scripts/tour-front-layer-stacking.mjs \
//     [--public <dir>] [--shots <dir>]
// --public defaults to this checkout's public/ (so run `npm run build` first). --shots saves a screenshot
// of each case. Exit 0 when every check passes, 1 otherwise.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PUBLIC_DIR = resolve(argValue("--public") ?? fileURLToPath(new URL("../public", import.meta.url)));
const SHOTS = argValue("--shots");
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE;
if (!PLAYWRIGHT) {
  console.error("Set PLAYWRIGHT_MODULE to the path of playwright's index.mjs.");
  process.exit(2);
}
const { chromium } = await import(PLAYWRIGHT);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain" };

// A static server with the SPA fallback: a path with no extension that is not a file serves index.html,
// so the console's own router resolves the deep link. A missing file with an extension is a 404.
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let file = join(PUBLIC_DIR, decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const isFile = await stat(file).then((s) => s.isFile(), () => false);
  if (!isFile) {
    if (extname(url.pathname) !== "") {
      res.writeHead(404);
      res.end();
      return;
    }
    file = join(PUBLIC_DIR, "index.html");
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
const address = server.address();
const BASE = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};

// topmost(selector, owner) reports what the browser paints on top at the centre of the first visible
// element matching selector, and whether that element sits inside owner.
const topmost = (page, selector, owner) =>
  page.evaluate(
    ([sel, own]) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0);
      if (!el) return { found: false, inOwner: false, hit: "no element" };
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const cls = (hit?.getAttribute("class") ?? "").split(" ")[0];
      const within = hit?.closest("[id], .overlay, .toast-region");
      const where = within && within !== hit ? ` in ${within.id ? `#${within.id}` : `.${(within.getAttribute("class") ?? "").split(" ")[0]}`}` : "";
      const name = hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${cls ? `.${cls}` : ""}${where}` : "nothing";
      return { found: true, inOwner: Boolean(hit?.closest(own)), hit: name };
    },
    [selector, owner],
  );

const zOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).zIndex : "absent";
  }, selector);

// The overlay and the toast fade and rise in, so a shot waits for the entrance to finish.
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const FORK = "#tour-persona-fork";
const freeExplore = (page) => page.locator(`${FORK} button`, { hasText: "Free Explore" });

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // ---- A. Toasts stay above modals (restore-confirm) -------------------------------------------------
  {
    const page = await context.newPage();
    await page.goto(`${BASE}/restore/run-visual-xacct-demo?tour=1`);
    await page.locator(FORK).waitFor();
    await freeExplore(page).click();
    await page.locator(FORK).waitFor({ state: "detached" });
    await page.locator(".restore-confirm").first().waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('.restore-confirm [data-dp^="restore-flow.button.apply"]').click();
    await page.getByRole("dialog").first().waitFor({ state: "visible", timeout: 10_000 });
    const toast = page.locator(".toast-region .toast", { hasText: "Simulated action" }).first();
    await toast.waitFor({ state: "visible", timeout: 10_000 });
    const pill = await page.evaluate(() => {
      const el = document.getElementById("tour-pricing-pill");
      return el ? `${el.dataset.frontLayer === "true" ? "marked" : "unmarked"}, display ${getComputedStyle(el).display}` : "absent";
    });
    const t = await topmost(page, ".toast-region .toast", ".toast-region");
    check("A. restore-confirm: the Simulated action toast is topmost over the Apply restore modal", t.inOwner, `hit ${t.hit}; overlay z ${await zOf(page, ".overlay")}, toast z ${await zOf(page, ".toast-region")}; pricing pill ${pill}`);
    await shot(page, "A-restore-confirm-toast");
    await page.close();
  }

  // ---- B. The welcome card stays above a dialog the screen opens by itself ---------------------------
  const deepLinks = [
    ["credentials add dialog", "/credentials?add=1&tour=1"],
    ["downpipe editor", "/downpipes/dp-payments/edit?tour=1"],
    ["run detail drawer", "/runs/dp-payments/41?tour=1"],
    ["downpipe detail drawer (viewer)", "/downpipes/dp-payments?tour=1&demo-state=role%3Aviewer"],
  ];
  for (const [label, route] of deepLinks) {
    const page = await context.newPage();
    await page.goto(`${BASE}${route}`);
    await page.locator(FORK).waitFor();
    await page.locator(".overlay").first().waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForTimeout(500);
    for (const [name, sel] of [
      ["Governance Tour", `${FORK} [data-tour-start="cto"]`],
      ["Engineering Tour", `${FORK} [data-tour-start="engineer"]`],
      ["Free Explore", `${FORK} button.linklike`],
    ]) {
      const t = await topmost(page, sel, FORK);
      check(`B. ${label}: the welcome's ${name} button is topmost`, t.inOwner, `hit ${t.hit}`);
    }
    await shot(page, `B-${label.split(" ")[0]}-${label.split(" ")[1]}-welcome`);
    const clicked = await freeExplore(page).click({ timeout: 3_000 }).then(() => true, () => false);
    const dismissed = clicked && (await page.locator(FORK).count()) === 0 && (await page.locator("#tour-relaunch").count()) === 1;
    check(`B. ${label}: a real click on Free Explore dismisses the welcome and shows Take the tour`, dismissed, clicked ? "" : "click intercepted");
    await page.close();
  }
  // The training walk's intro card is the same kind of layer (?training=1 works on a loopback host).
  {
    const page = await context.newPage();
    await page.goto(`${BASE}/credentials?add=1&training=1`);
    await page.locator("#training-intro").waitFor();
    await page.locator(".overlay").first().waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForTimeout(500);
    const start = page.locator("#training-intro button", { hasText: "Start the course" });
    const t = await topmost(page, "#training-intro button.btn--primary", "#training-intro");
    // trial: Playwright's hit test for a click, without starting the course.
    const clickable = await start.click({ trial: true, timeout: 3_000 }).then(() => true, () => false);
    check("B. training walk, credentials add dialog: the intro's Start the course button is topmost and clickable", t.inOwner && clickable, `hit ${t.hit}`);
    await shot(page, "B-training-credentials-intro");
    await page.close();
  }

  // ---- C. A confirm raised from a front layer sits above it ------------------------------------------
  const interstitialOnTop = async (page, label, layer) => {
    const dialog = page.getByRole("dialog", { name: "Leaving downpipes" });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    const stay = await topmost(page, '.overlay [role="dialog"] button.btn--secondary', ".overlay");
    const layerStill = (await page.locator(layer).count()) === 1;
    check(`C. ${label}: the Leaving downpipes confirm is topmost over the layer that raised it`, stay.inOwner && layerStill, `hit ${stay.hit}; overlay z ${await zOf(page, ".overlay")}; layer still mounted ${layerStill}`);
    // A toast raised while that lifted confirm is open must still sit above it. The app's toast helper
    // is not reachable from the page, so this mounts a region with the same classes toast.ts uses.
    await page.evaluate(() => {
      const region = document.createElement("div");
      region.className = "toast-region";
      region.dataset.stackingCheck = "true";
      const t = document.createElement("div");
      t.className = "toast";
      t.textContent = "Stacking check toast";
      region.appendChild(t);
      document.body.appendChild(region);
    });
    const t = await topmost(page, '[data-stacking-check] .toast', "[data-stacking-check]");
    check(`C. ${label}: a toast raised while that confirm is open is topmost`, t.inOwner, `hit ${t.hit}`);
    await shot(page, `C-${label.split(" ")[0]}-interstitial`);
    await page.evaluate(() => document.querySelector("[data-stacking-check]")?.remove());
    const stayed = await page.getByRole("button", { name: "Stay here" }).click({ timeout: 3_000 }).then(() => true, () => false);
    check(`C. ${label}: Stay here is clickable and closes the confirm`, stayed && (await dialog.count()) === 0);
  };
  {
    const page = await context.newPage();
    await page.goto(`${BASE}/?tour=1`);
    await page.locator(FORK).waitFor();
    const privacy = page.locator(`${FORK} a[href*="/cookies"]`);
    await privacy.evaluate((a) => a.setAttribute("href", "https://example.com/cookies"));
    await privacy.click();
    await interstitialOnTop(page, "welcome privacy link", FORK);
    await page.close();
  }
  {
    const page = await context.newPage();
    await page.goto(`${BASE}/?tour=1`);
    await page.locator(FORK).waitFor();
    await page.locator(`${FORK} [data-tour-start="engineer"]`).click();
    await page.locator("#tour-nav-bar").waitFor();
    // The rail's pricing link ("I've seen enough") shows from chapter 2, so step forward until it does.
    const link = page.locator('#tour-nav-bar a[target="_blank"]').filter({ visible: true }).first();
    for (let i = 0; i < 20 && (await link.count()) === 0; i++) {
      await page.locator('#tour-nav-bar [data-tour-action="next"]').click();
      await page.waitForTimeout(700);
    }
    await link.waitFor({ state: "visible", timeout: 5_000 });
    await link.evaluate((a) => a.setAttribute("href", "https://example.com/pricing"));
    await link.click();
    await interstitialOnTop(page, "tour rail link", "#tour-nav-bar");
    await page.close();
  }

  // ---- D. A dialog the tour opens for a chapter stays under the rail ----------------------------------
  {
    const page = await context.newPage();
    await page.goto(`${BASE}/?tour=1`);
    await page.locator(FORK).waitFor();
    await page.locator(`${FORK} [data-tour-start="engineer"]`).click();
    await page.locator("#tour-nav-bar").waitFor();
    const next = page.locator('#tour-nav-bar [data-tour-action="next"]');
    let opened = false;
    // Step forward until the chapter's drawer opens. Next is clicked only while no overlay is up.
    for (let i = 0; i < 40 && !opened; i++) {
      await next.click();
      opened = await page.locator(".overlay").first().waitFor({ state: "attached", timeout: 4_000 }).then(() => true, () => false);
    }
    await page.waitForTimeout(800);
    const t = await topmost(page, '#tour-nav-bar [data-tour-action="next"]', "#tour-nav-bar");
    check("D. Engineering Tour run chapter: the rail's Next is topmost over the run drawer", opened && t.inOwner && (await next.count()) === 1, `drawer opened ${opened}; hit ${t.hit}; overlay z ${await zOf(page, ".overlay")}`);
    await shot(page, "D-engineering-run-chapter");
    await page.close();
  }

  // ---- E. Below 1024px a drawer's footer clears the floating guide panel ------------------------------
  for (const vp of [{ width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    const page = await context.newPage();
    await page.setViewportSize(vp);
    await page.goto(`${BASE}/?tour=1`);
    await page.locator(FORK).waitFor();
    await page.locator(`${FORK} [data-tour-start="engineer"]`).click();
    await page.locator("#tour-nav-bar").waitFor();
    const next = page.locator('#tour-nav-bar [data-tour-action="next"]');
    let opened = false;
    // Same walk as D: step Next until the run chapter's drawer mounts.
    for (let i = 0; i < 40 && !opened; i++) {
      await next.click();
      opened = await page.locator(".overlay--drawer").first().waitFor({ state: "attached", timeout: 4_000 }).then(() => true, () => false);
    }
    await page.waitForTimeout(800);
    const panelMode = await page.evaluate(() => document.body.classList.contains("dp-tour-panel"));
    const footerBtn = page.locator('.overlay--drawer [data-dp="components-detail-drawer.button.action-button"]').first();
    const clickable = await footerBtn.click({ trial: true, timeout: 3_000 }).then(() => true, () => false);
    const geom = await page.evaluate(() => {
      const btn = document.querySelector('.overlay--drawer [data-dp="components-detail-drawer.button.action-button"]');
      const panel = document.getElementById("tour-nav-bar");
      const b = btn?.getBoundingClientRect();
      const p = panel?.getBoundingClientRect();
      return {
        btnBottom: b ? Math.round(b.bottom) : null,
        btnTop: b ? Math.round(b.top) : null,
        panelTop: p && p.height > 0 ? Math.round(p.top) : null,
      };
    });
    const clear = geom.btnBottom !== null && (geom.panelTop === null || geom.btnBottom <= geom.panelTop);
    check(
      `E. run drawer footer clears the guide panel at ${vp.width}px`,
      opened && panelMode && clickable && clear,
      `drawer opened ${opened}; panel mode ${panelMode}; clickable ${clickable}; button top/bottom ${geom.btnTop}/${geom.btnBottom}, panel top ${geom.panelTop}`,
    );
    await shot(page, `E-drawer-clears-panel-${vp.width}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? "\nTOUR STACKING: ALL CHECKS PASS" : `\nTOUR STACKING: ${failures} FAILURE(S)`);
// exitCode rather than process.exit(), so piped stdout is flushed in full before the process ends.
process.exitCode = failures === 0 ? 0 : 1;
