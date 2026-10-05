// Browser check for an open dialog's own stacking order: every button inside it must be the topmost
// element at its own centre (document.elementFromPoint), with a toast showing and, wherever the relaunch
// pill mounts, the pill present too. Headless Chromium over a locally served public/.
//
// WHAT IT CHECKS. tokens.css carries two rules for this:
//
//   body:has(.overlay, dialog[open]) #tour-relaunch { display: none !important; }
//   @media (max-width: 767px) { body:has(.overlay) .toast-region { z-index: calc(var(--z-modal) - 1); } }
//
// Without them, a visible relaunch pill or a lifted toast region can sit on top of a dialog's own footer
// actions (Cancel, Apply), taking the click instead of the control the label shows. This script proves both
// rules hold, across three ways a visitor reaches an open dialog:
//
//   tour              ?tour=1, the welcome dismissed with Escape.
//   customer console  ?tour=1, the welcome dismissed with a real click on Free Explore. Loading the console
//                      with no query at all boots no demo data here (tour-mode.ts and training-mode.ts both
//                      gate the faked backend on the query flag), so this stands in for the plain console.
//   training          ?training=1. The intro's only exits start the course (its own header: "Escape starts
//                      it as well"), landing at /setup/welcome every time; the intro is one of the chrome
//                      surfaces that deliberately sits ABOVE every dialog while mounted (by design, so it
//                      stays reachable), so the check runs after it is gone rather than probing under it.
//                      Training mounts no relaunch pill at all.
//
// Each context runs at 375x812 and 1440x900. Below 768px the synthetic dialog is forced tall, matching the
// real repro: a full-height mobile dialog's footer reaches the toast dock at the foot of the screen. At
// desktop the dialog keeps its natural height, because a toast is designed to float above a modal generally
// (tokens.css's own comment: "modal < toast holds on both rungs") and a realistic desktop dialog never
// reaches the toast dock; forcing the same full height there would assert against that design rather than
// against the two rules above.
//
// Playwright is not a dependency of this repo, so this script is not in `npm run validate` and runs by
// hand:
//   PLAYWRIGHT_MODULE=<path to playwright's index.mjs> node scripts/dialog-overlap-stacking.mjs \
//     [--public <dir>]
// --public defaults to this checkout's public/ (run `npm run build` first). Exit 0 when every check passes,
// 1 otherwise. The same check runs automatically on every change in the harness repo's static tier
// (spec/dialog-overlap-stacking.spec.ts), which is where a schedule actually re-runs it; this script is the
// hand-run copy for a local check against one build.

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PUBLIC_DIR = resolve(argValue("--public") ?? fileURLToPath(new URL("../public", import.meta.url)));
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE;
if (!PLAYWRIGHT) {
  console.error("Set PLAYWRIGHT_MODULE to the path of playwright's index.mjs.");
  process.exit(2);
}
const { chromium } = await import(PLAYWRIGHT);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain" };

// A static server with the SPA fallback: a path with no extension that is not a file serves index.html, so
// the console's own router resolves the deep link.
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

/** Builds the synthetic toast + dialog in the page and reports which of the dialog's own buttons (plus the
 *  pill-rect probe, when the pill exists) is covered by something outside the dialog at its own centre. */
async function probeDialogButtons(page, narrow) {
  return page.evaluate((isNarrow) => {
    const pill = document.getElementById("tour-relaunch");
    const pillRect = pill && getComputedStyle(pill).display !== "none" ? pill.getBoundingClientRect() : null;
    const pillReachableBeforeDialog = pillRect
      ? (document.elementFromPoint(pillRect.left + pillRect.width / 2, pillRect.top + pillRect.height / 2)?.closest("#tour-relaunch") ?? null) !== null
      : null;

    let region = document.querySelector(".toast-region");
    if (!region) {
      region = document.createElement("div");
      region.className = "toast-region";
      document.body.appendChild(region);
    }
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.style.pointerEvents = "auto";
    toast.textContent = "Simulated action. In a real console this would run.";
    region.appendChild(toast);

    const ov = document.createElement("div");
    ov.className = "overlay overlay--modal";
    // The entrance animations are visual only; an active transform animation on the dialog would make it a
    // containing block for its own position:fixed children, moving the pill-rect probe to the wrong screen
    // position, so both are turned off before anything is measured.
    ov.style.animation = "none";
    const dlg = document.createElement("div");
    dlg.className = "dialog dialog--modal";
    dlg.setAttribute("role", "dialog");
    dlg.style.animation = "none";
    if (isNarrow) dlg.style.height = "calc(100vh - 40px)";
    dlg.innerHTML =
      '<div class="dialog__header"><h2>Apply restore</h2><button class="btn" id="d-close">Close</button></div>' +
      '<div class="dialog__body">Body</div>' +
      '<div class="dialog__footer"><div class="dialog__actions"><button class="btn" id="d-cancel">Cancel</button><button class="btn btn--primary" id="d-apply">Apply restore</button></div></div>';

    let probeAdded = false;
    if (pillRect) {
      const probe = document.createElement("button");
      probe.className = "btn btn--primary";
      probe.id = "d-probe-under-pill";
      probe.textContent = "Save changes";
      probe.style.cssText = `position:fixed;left:${pillRect.left}px;top:${pillRect.top}px;width:${pillRect.width}px;height:${pillRect.height}px`;
      dlg.appendChild(probe);
      probeAdded = true;
    }
    ov.appendChild(dlg);
    document.body.appendChild(ov);

    const covered = [];
    const buttons = Array.from(dlg.querySelectorAll("button"));
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !dlg.contains(hit)) {
        covered.push(`${b.id} under ${hit ? hit.id || hit.className || hit.tagName : "nothing"}`);
      }
    }

    return { pillPresent: pillRect !== null, pillReachableBeforeDialog, probeAdded, buttonCount: buttons.length, covered };
  }, narrow);
}

async function reachContext(page, name) {
  if (name === "tour") {
    await page.goto(`${BASE}/?tour=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("#tour-persona-fork").waitFor({ state: "visible", timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.locator("#tour-persona-fork").waitFor({ state: "detached", timeout: 10_000 });
    await page.locator("#tour-relaunch").waitFor({ state: "visible", timeout: 10_000 });
    return;
  }
  if (name === "customer console") {
    await page.goto(`${BASE}/?tour=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("#tour-persona-fork").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("#tour-persona-fork button.linklike", { hasText: "Free Explore" }).click();
    await page.locator("#tour-persona-fork").waitFor({ state: "detached", timeout: 10_000 });
    await page.locator("#tour-relaunch").waitFor({ state: "visible", timeout: 10_000 });
    return;
  }
  await page.goto(`${BASE}/?training=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#training-intro").waitFor({ state: "visible", timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.locator("#training-intro").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(500);
}

const CONTEXTS = ["tour", "customer console", "training"];
const VIEWPORTS = [
  { label: "375x812", width: 375, height: 812 },
  { label: "1440x900", width: 1440, height: 900 },
];

const browser = await chromium.launch();
try {
  for (const name of CONTEXTS) {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await reachContext(page, name);
      const expectPill = name !== "training";
      const result = await probeDialogButtons(page, vp.width < 768);
      const pillOk = result.pillPresent === expectPill;
      const reachOk = !expectPill || result.pillReachableBeforeDialog === true;
      const probeOk = !expectPill || result.probeAdded === true;
      const coveredOk = result.covered.length === 0;
      check(
        `${name} at ${vp.label}: every dialog button is topmost`,
        pillOk && reachOk && probeOk && coveredOk,
        `pill present ${result.pillPresent} (expected ${expectPill}); covered: ${JSON.stringify(result.covered)}`,
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? "\nDIALOG OVERLAP: ALL CHECKS PASS" : `\nDIALOG OVERLAP: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
