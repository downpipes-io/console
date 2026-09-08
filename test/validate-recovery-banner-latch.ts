// Recovery-banner-silent regression cover: drive a recoveryRequired=true status THROUGH THE BOOT PATH
// (a real EngineClient over a stubbed fetch, feeding the exact checkControlPlaneRecovery try/catch app.ts
// runs) and assert the standing danger banner RENDERS, STANDS through a later failed / route-absent / racing
// read, and is taken down ONLY by a confirmed healthy read. The DOM is the shared hand-rolled shim (no jsdom,
// no network); the REAL updateRecoveryBanner + EngineClient + classifyError are driven, never re-implemented.
// Run with: node test/validate-recovery-banner-latch.ts
//
// Why this exists: driving the real amnesia latch live found the console recovery banner SILENT on
// a wiped plane (the host present but empty) even though the same-origin GET /admin/control-plane/status
// returned recoveryRequired=true. The pure recoveryBannerModel and the client were correct and covered; what
// had NO cover was the boot wiring, where updateRecoveryBanner cleared the host and re-derived the banner from
// a SINGLE read every call, so any later status read that failed, was route-absent, or raced the raising one
// took the banner back down and painted a false all-clear. The latch makes the confirmed danger stand until
// the engine itself reports the plane healthy again; this test pins that so it cannot regress.

import { installDomShim, flushAsync } from "./dom-shim.ts";
installDomShim();

import { EngineClient } from "../src/api.ts";
import { classifyError } from "../src/lib/errors.ts";
import { updateRecoveryBanner, _resetRecoveryLatch } from "../src/components/recovery-banner.ts";
import { RECOVERY_BANNER_TITLE } from "../src/lib/control-plane-recovery.ts";
import { RECOVERY_UNKNOWN_TITLE } from "../src/components/recovery-banner.ts";
import type { ControlPlaneStatus } from "../src/lib/api/types/control-plane.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const HOST_ID = "cp-recovery-banner-host";
function host(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}
function dangerCount(): number {
  const h = host();
  return h ? h.querySelectorAll(".banner--danger").length : -1;
}
function infoCount(): number {
  const h = host();
  return h ? h.querySelectorAll(".banner--info").length : -1;
}
function childCount(): number {
  const h = host();
  return h ? h.childElementCount : -1;
}
function titleShown(text: string): boolean {
  const h = host();
  return h ? (h.textContent ?? "").includes(text) : false;
}
function freshHost(): void {
  _resetRecoveryLatch();
  host()?.remove();
}
// actionLabel reads the banner's ONE action button, so the tests below assert on what the operator
// actually sees, not on the pure model alone (validate-control-plane-recovery.ts already covers the model).
function actionLabel(): string | null {
  const h = host();
  const btn = h ? h.querySelector(".banner__action") : null;
  return btn ? (btn.textContent ?? null) : null;
}

// The bodies the engine's GET /admin/control-plane/status returns. The latched body is the real wiped-plane
// shape (recoveryRequired=true at the top level, with the redaction-safe reason and the emptiness signal).
const LATCHED_BODY: ControlPlaneStatus = {
  recoveryRequired: true,
  reason: "the control plane is empty but the destination bucket still holds backups -- the scheduler control plane appears to have been lost; backups have STOPPED until it is recovered",
  configEmpty: true,
};
const HEALTHY_BODY: ControlPlaneStatus = { recoveryRequired: false, reason: null, configEmpty: false };
// The auto-heal has already staged + resumed backups from a SEALED export. The manual reconcile action
// is unreachable for this artefact (a sealed estate never has the plaintext-signed pair that form needs), so
// the banner must offer the break-glass CONFIRM instead.
const STAGED_LATCHED_BODY: ControlPlaneStatus = {
  recoveryRequired: true,
  reason: "the control plane is empty but the destination bucket still holds backups -- the scheduler control plane appears to have been lost; backups have STOPPED until it is recovered",
  configEmpty: true,
  staged: { sourceKey: "_RECOVERY/CONTROL-PLANE/7-2026-08-01.sealed.json", version: 7, stagedAt: "2026-08-01T00:00:00.000Z", downpipes: 5, resumeApplied: true },
};

// nextResponse is what the stubbed fetch answers on the next call. Each case sets it before driving a boot
// poll. A 2xx body is the JSON status; a non-2xx status code drives the client's throw (parseJson -> verb +
// status), which is what a route-absent (404/501) or a failed (5xx) read looks like to the console.
let nextResponse: () => Response = () => new Response(JSON.stringify(HEALTHY_BODY), { status: 200 });

// checkControlPlaneRecovery is lib/recovery-watch.ts's checkControlPlaneRecoveryOnce, reproduced: read the
// status, raise/clear the banner (now including the applyStaged leg); on a read fault classify a
// route-absent 404/501 apart from a genuine failure and pass that through. Reproduced here so the test drives
// the SAME wiring the console does, over the REAL EngineClient + updateRecoveryBanner + classifyError.
async function checkControlPlaneRecovery(engine: EngineClient): Promise<void> {
  try {
    const status = await engine.controlPlaneStatus();
    updateRecoveryBanner(status, {
      reconcile: (input) => engine.controlPlaneRestore(input.token, input.exportArtefact, input.signature),
      applyStaged: (adminToken) => engine.controlPlaneApplyStaged(adminToken),
      onReconciled: () => {},
      onApplied: () => {},
    });
  } catch (err) {
    const kind = classifyError(err);
    const routeAbsent = kind.kind === "server" && (kind.status === 404 || kind.status === 501);
    updateRecoveryBanner(null, { reconcile: () => Promise.reject(new Error("unavailable")) }, routeAbsent ? "route-absent" : "failed");
  }
}

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async () => nextResponse()) as typeof fetch;
  try {
    const engine = new EngineClient("https://console.test");

    // ---- 1. A fresh boot on a latched plane RAISES the danger banner (the core property). ----
    console.log("\n-- boot: recoveryRequired=true raises the danger banner --");
    freshHost();
    nextResponse = () => new Response(JSON.stringify(LATCHED_BODY), { status: 200 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("a latched plane renders the danger banner", dangerCount() === 1);
    ok("the banner names the condition (Control plane needs recovery)", titleShown(RECOVERY_BANNER_TITLE));
    ok("no calm info banner alongside the danger banner", infoCount() === 0);

    // ---- 2. THE REGRESSION: a later ROUTE-ABSENT read must NOT take the raised banner down. ----
    // This is the exact live silence: GET /admin/control-plane/status once answered recoveryRequired=true,
    // then a later read faulted, and the console cleared the host to empty -- a false all-clear.
    console.log("\n-- a later route-absent / failed / racing read must NOT silence the raised banner --");
    nextResponse = () => new Response("no such route", { status: 404 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("route-absent read after a confirmed latch keeps the danger banner", dangerCount() === 1);
    ok("route-absent read does not empty the host", childCount() === 1);

    nextResponse = () => new Response("upstream error", { status: 500 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("failed read after a confirmed latch keeps the danger banner", dangerCount() === 1);
    ok("failed read does not replace the danger banner with the calm info notice", infoCount() === 0);

    // A confirmed re-read of the SAME latched state keeps it (idempotent, still one banner).
    nextResponse = () => new Response(JSON.stringify(LATCHED_BODY), { status: 200 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("a repeated confirmed latched read keeps exactly one danger banner", dangerCount() === 1 && childCount() === 1);

    // ---- 3. Only a CONFIRMED healthy read (post-reconcile) takes it down: no over-render, no stuck banner. ----
    console.log("\n-- a confirmed healthy read (recoveryRequired=false) takes it down --");
    nextResponse = () => new Response(JSON.stringify(HEALTHY_BODY), { status: 200 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("a confirmed healthy plane clears the danger banner", dangerCount() === 0);
    ok("nothing is left in the host on a confirmed healthy plane", childCount() === 0);

    // ---- 4. A fresh boot on a healthy plane never raises anything (discriminating: silent when fine). ----
    console.log("\n-- discrimination: a healthy plane is silent --");
    freshHost();
    nextResponse = () => new Response(JSON.stringify(HEALTHY_BODY), { status: 200 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("a healthy plane renders no danger banner", dangerCount() === 0);
    ok("a healthy plane renders nothing at all", childCount() === 0);

    // ---- 5. A FAILED read that never followed a confirmed danger still says so calmly. ----
    console.log("\n-- a first failed read, never confirmed danger, is the calm info notice --");
    freshHost();
    nextResponse = () => new Response("upstream error", { status: 500 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("a never-confirmed failed read shows the calm info notice", infoCount() === 1 && dangerCount() === 0);
    ok("the info notice names the unknown state", titleShown(RECOVERY_UNKNOWN_TITLE));

    // ---- 6. A ROUTE-ABSENT read that never followed a confirmed danger renders nothing (older engine). ----
    console.log("\n-- a route-absent older engine, never confirmed, is silent --");
    freshHost();
    nextResponse = () => new Response("no such route", { status: 404 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("a never-confirmed route-absent read renders nothing", childCount() === 0);

    // ---- 7. Banner-below-the-fold: the host must be inserted ABOVE the mounted shell chrome, not
    // appended after it. ensureBannerHost() used to document.body.appendChild(host), which places the host
    // LAST in document order -- after #app (the sticky header, rail and main region the real shell mounts).
    // #app is `min-height: 100vh` (tokens.css .shell), so an append-after host rendered off the BOTTOM of an
    // ordinary viewport: present in the DOM, correctly wired, danger-toned, and invisible without scrolling
    // past the whole Overview screen -- an "estate that needs recovery looks healthy" failure distinct from
    // the banner not rendering at all, and invisible to every DOM-only assertion (childElementCount, a class
    // check, even Playwright's isVisible()) because none of them checks POSITION. Simulate the shell already
    // mounted (as it is by the time app.ts calls startRecoveryWatch, well after mountShell) and assert the
    // banner host lands BEFORE it in document order, so a browser paints it above the chrome with no CSS
    // position/z-index trick and no risk of the shell clipping it.
    console.log("\n-- the banner host is inserted ABOVE the shell chrome, not appended after it --");
    freshHost();
    document.getElementById("app")?.remove();
    const shellRoot = document.createElement("div");
    shellRoot.id = "app";
    shellRoot.appendChild(document.createElement("div")); // stand-in shell content
    document.body.appendChild(shellRoot);
    nextResponse = () => new Response(JSON.stringify(LATCHED_BODY), { status: 200 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    const first = (document.body as unknown as { children: HTMLElement[] }).children[0] ?? null;
    ok("the recovery banner host is the first child of <body>", first?.id === HOST_ID);
    ok("...meaning it precedes the mounted shell (#app) in document order", first?.id !== "app");
    ok("the danger banner still renders (the reorder changes position, not content)", dangerCount() === 1);
    document.getElementById("app")?.remove();

    // ---- 8. A staged auto-heal recovery offers "Confirm and restore access", never the manual
    // reconcile action -- the manual form cannot open a sealed estate's artefact (no plaintext-signed pair
    // ever exists for it), so offering it here would be the exact "refusal with no real path forward" shape
    // this whole review was hunting for. ----
    console.log("\n-- a staged recovery offers the break-glass CONFIRM, not the manual reconcile --");
    freshHost();
    nextResponse = () => new Response(JSON.stringify(STAGED_LATCHED_BODY), { status: 200 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok("a staged recovery still renders exactly one danger banner", dangerCount() === 1);
    ok('the action reads "Confirm and restore access", not "Recover the control plane"', actionLabel() === "Confirm and restore access");
    ok("the banner states backups already resumed (the auto-heal's own summary)", titleShown("already resumed automatically"));
    ok("the banner names the staged generation", titleShown("config v7"));

    // A later read of the SAME latch but with NO staged record (an unsealed / sealing-disabled estate, or an
    // older engine build) falls back to the manual reconcile action -- the two must not be conflated.
    console.log("\n-- an unstaged latch (or an older engine) still offers the manual reconcile action --");
    freshHost();
    nextResponse = () => new Response(JSON.stringify(LATCHED_BODY), { status: 200 });
    await checkControlPlaneRecovery(engine);
    await flushAsync();
    ok('an unstaged latch keeps "Recover the control plane"', actionLabel() === "Recover the control plane");
    ok("no staged summary line is shown when nothing is staged", !titleShown("already resumed automatically"));
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    _resetRecoveryLatch();
  }

  console.log(failures === 0 ? "\nRECOVERY-BANNER-LATCH VECTORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-RECOVERY-BANNER-LATCH THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
