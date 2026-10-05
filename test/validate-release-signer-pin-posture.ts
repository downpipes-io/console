// Validates that the Security centre shows the release-signer-pin posture check the way it shows every
// other check: generically, from report.checks, with no console-side id map or special case to maintain.
//
// WHY NO CONSOLE CODE CHANGED FOR THIS CHECK. src/lib/api/types/posture.ts declares PostureCheck.id as a
// plain string and PostureSeverity already includes "medium"; src/screens/security-centre/posture.ts
// renders title/control/severity/detail/how/remediation straight off the check object. The ONLY place
// this file special-cases a check id is the attended-verification CTA for restore-test-recency and
// attended-verification-cadence (posture.ts checkCard), which this check does not need: its remedy is an
// engine var, carried in the engine's own remediation text. So there is no red/green pair at the console
// level for "the check appears": the renderer already handled an unknown id correctly before this check
// existed. What this file proves instead is that the REAL render path carries the engine's exact
// check (pulled live from the engine source, not retyped here) through to the DOM unmodified: the title,
// the medium-severity badge, the fail/needs-attention grouping, and the engine's own warning sentence as
// the observed detail and the remediation, with no console paraphrase in between.
//
// Run with `node test/validate-release-signer-pin-posture.ts`.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Caller, EngineClient } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller, setWhoamiAvailable } from "../src/lib/store.ts";
import { installDomShim, qsa, type ShimNode, textOf } from "./dom-shim.ts";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const OWNER: Caller = { email: "owner@example.test", role: "owner", customRole: null } as unknown as Caller;

function recordingEngine(): EngineClient {
  return new Proxy(
    {},
    {
      get() {
        return (..._args: unknown[]) => Promise.resolve({});
      },
    },
  ) as unknown as EngineClient;
}

// Resolve the engine checkout the same way the other cross-repo validators in this file family do:
// DOWNPIPES_ENGINE, else a sibling ../engine, else CANNOT CHECK (not a failure: this console must still
// build with no engine beside it).
function engineRoots(): string[] {
  const roots: string[] = [];
  if (process.env.DOWNPIPES_ENGINE) roots.push(process.env.DOWNPIPES_ENGINE);
  roots.push(resolve(import.meta.dirname, "../../engine"));
  return roots;
}
function engineSource(rel: string): string | null {
  const p = engineRoots().map((r) => resolve(r, rel)).find((f) => existsSync(f));
  return p === undefined ? null : readFileSync(p, "utf8");
}

async function main(): Promise<void> {
  installDomShim();
  installNav({
    navigate: () => undefined,
    onUnauthorised: () => undefined,
    refreshIdentity: async () => undefined,
    onAuthenticated: async () => undefined,
    signOut: () => undefined,
  });
  setWhoamiAvailable(true);
  setCaller(OWNER);

  const checksSrc = engineSource("src/admin/posture-checks.ts");
  const signerPinSrc = engineSource("src/admin/update-signer-pin.ts");
  if (checksSrc === null || signerPinSrc === null) {
    verdictCannotCheck(
      "validate-release-signer-pin-posture: REFUSED, no engine checkout is reachable.\n" +
        "  The check this file renders is pulled from the engine's own src/admin/posture-checks.ts and\n" +
        "  src/admin/update-signer-pin.ts, so with no engine there is nothing to render and nothing was\n" +
        "  compared.\n" +
        "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.",
    );
    return;
  }

  // Pull the check's identity straight out of the engine: an id, a title and a control literal, each
  // anchored on a stable surrounding token so a moved anchor is reported, not silently mismatched.
  const idMatch = /id:\s*"(release-signer-pin)"/.exec(checksSrc);
  const titleMatch = /title:\s*"([^"]+)"/.exec(checksSrc.slice(checksSrc.indexOf('"release-signer-pin"')));
  const controlMatch = /control:\s*"([^"]+)"/.exec(checksSrc.slice(checksSrc.indexOf('"release-signer-pin"')));
  ok("engine source: release-signer-pin id anchor found", idMatch !== null);
  ok("engine source: release-signer-pin title anchor found", titleMatch !== null);
  ok("engine source: release-signer-pin control anchor found", controlMatch !== null);
  const engineId = idMatch?.[1] ?? "release-signer-pin";
  const engineTitle = titleMatch?.[1] ?? "";
  const engineControl = controlMatch?.[1] ?? "";

  // Pull the one warning sentence both the status route and this posture check use, with a real
  // fingerprint substituted, exactly as the engine's own releaseSignerPinWarningText would render it.
  const fnMatch = /export function releaseSignerPinWarningText\(fingerprint: string \| null\): string \{\s*return fingerprint !== null\s*\?\s*`([^`]+)`/.exec(signerPinSrc);
  ok("engine source: releaseSignerPinWarningText template found", fnMatch !== null);
  const fingerprint = "edmldsa1:aabbccddeeff00112233445566778899aabbccddeeff0011223344556677889900112233445566";
  const PLACEHOLDER = "$" + "{fingerprint}";
  const engineWarning = (fnMatch?.[1] ?? PLACEHOLDER).replace(PLACEHOLDER, fingerprint);

  const { renderPosture } = await import("../src/screens/security-centre/posture.ts");

  // Failing case: a declared pin that does not match. The console must show the engine's severity,
  // title, control and warning text verbatim, grouped under "needs attention" (the check's status is
  // "fail"), never a console paraphrase.
  const failCheck = {
    id: engineId,
    title: engineTitle,
    severity: "medium",
    status: "fail",
    autoStatus: "fail",
    control: engineControl,
    detail: engineWarning,
    remediation: engineWarning,
    how: "Compares RELEASE_SIGNER_PIN, trimmed and ignoring case, with the edmldsa1 fingerprint of UPDATE_SIGNER_PUBLIC, the key the engine verifies update-channel signatures with. Recomputed live on every read.",
  };
  const failReport = { score: 40, generatedAt: "2026-10-01T00:00:00Z", checks: [failCheck] } as never;
  const failRoot = renderPosture(recordingEngine(), failReport, () => undefined) as unknown as ShimNode;
  const failText = textOf(failRoot);
  ok("fail case: the engine's title renders", engineTitle !== "" && failText.includes(engineTitle));
  ok("fail case: the engine's control renders", engineControl !== "" && failText.includes(engineControl));
  ok("fail case: the medium severity badge renders", failText.includes("medium"));
  ok("fail case: the engine's own warning sentence renders as the observed detail, verbatim", failText.includes(engineWarning));
  ok("fail case: the fingerprint inside the warning renders, not withheld", failText.includes(fingerprint));
  ok("fail case: the check is grouped under Needs attention, not Passing", failText.includes("Needs attention"));
  // The one documented per-id CTA this file's own comment names does not fire for this check: its
  // remedy is an engine env var, not attended verification, so no "Prove it" button should appear.
  ok("fail case: no attended-verification CTA (this check's remedy is an env var, not a proof run)", !failText.includes("Prove it with attended verification"));

  // Passing case: a declared pin that matches. Grouped under Passing, with the engine's own pass detail
  // and remediation, and the severity shown as a neutral "weight" chip, not a live alarm.
  const passCheck = {
    ...failCheck,
    status: "pass",
    autoStatus: "pass",
    detail: "RELEASE_SIGNER_PIN is the fingerprint of the key the engine verifies updates with.",
    remediation: "No action required.",
  };
  const passReport = { score: 100, generatedAt: "2026-10-01T00:00:00Z", checks: [passCheck] } as never;
  const passRoot = renderPosture(recordingEngine(), passReport, () => undefined) as unknown as ShimNode;
  const passText = textOf(passRoot);
  ok("pass case: the engine's pass detail renders", passText.includes("is the fingerprint of the key the engine verifies updates with"));
  ok("pass case: the severity shows as a neutral weight chip, not a live alarm", passText.includes("weight: medium"));
  ok("pass case: no override action row (a plain pass needs none)", qsa(passRoot, "button").every((b) => !textOf(b as unknown as ShimNode).includes("Override")));

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`} -- release-signer-pin posture (${checks} checks)`);
  verdictReached(failures, checks); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exitCode = 1;
}

void main();
