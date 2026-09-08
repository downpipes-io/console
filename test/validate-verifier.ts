// The enforcement verifier is the trust-closing step, so its verdict mapping and error-path branching are
// correctness-critical for the security display. Three pieces carry that logic:
//   (a) the Access and security screen's own verdict read (deriveVerdict, shared.ts) maps EVERY whoami
//       method the engine can report to the honest AccessVerdict, and records the one it cannot read;
//   (b) verifierErrorTile (verifier.ts) maps a failed probe to 401-unverified / network-CONSOLE_ORIGIN
//       / server-degrade;
//   (c) roleBasisNote (verifier.ts) renders each of the five roleSource branches.
// A regression in any of these would silently show the wrong security state.
//
// Run with: node test/validate-verifier.ts
//
// deriveVerdict is driven through the REAL store (the boot-resolved caller the screen reads), not by calling a
// mapping function the screen does not use, because a live OIDC, SAML or recovery session must never be shown
// as the shared break-glass token. verifierErrorTile and roleBasisNote render DOM, so they run under the shared
// DOM shim with a fake engine; the test never re-implements them.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { qs, textOf, type ShimNode } from "./dom-shim.ts";
import { SN } from "./validate-stable-components-shared.ts";
import { deriveVerdict } from "../src/screens/access-security/shared.ts";
import { verifierErrorTile, roleBasisNote } from "../src/screens/access-security/verifier.ts";
import { accessVerdictPanel } from "../src/components/verdict.ts";
import { setCaller, setWhoamiAvailable } from "../src/lib/store.ts";
import { reset as resetRing, snapshot } from "../src/lib/client-diag/ring.ts";
import type { AuthMethod, Caller, EngineClient, Role, RoleSource } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// A fake engine whose health() resolves: enough for verifierErrorTile's network branch (its racing
// health probe never changes the SYNCHRONOUS tile this test asserts).
const fakeEngine = { async health() { return { ok: true }; } } as unknown as EngineClient;
const noop = (): void => undefined;

// tileText reads the visible title/body text of a rendered tile for assertions.
function tileText(el: HTMLElement): string {
  return textOf(SN(el) as unknown as ShimNode);
}

function main(): void {
  // ------------------------------------------------------------------------
  console.log("\n-- the security screen's verdict: EVERY method the engine can report, driven through the store --");
  // ------------------------------------------------------------------------
  // The screen reads the boot-resolved caller, so the caller is what the test sets: nothing here calls a
  // mapping function directly, and nothing hand-builds a verdict. The panel is the REAL accessVerdictPanel, which
  // is what the customer reads, and the rows are the REAL ring's, which is what the pack carries.
  const asCaller = (method: string, identityProvider?: string): Caller =>
    ({ method: method as AuthMethod, email: "tim@example.com", role: "owner", groups: [], isOnlyOwner: true, ...(identityProvider !== undefined ? { identityProvider } : {}) }) as Caller;
  const drive = (method: string, identityProvider?: string): { state: string; panel: string; rows: string[] } => {
    resetRing();
    setWhoamiAvailable(true);
    setCaller(asCaller(method, identityProvider));
    const v = deriveVerdict();
    const panel = tileText(accessVerdictPanel({ verdict: v }));
    return { state: v.state, panel, rows: snapshot().records.map((r) => `${r.kind}/${String(r.fieldClass ?? "")}/${String(r.anomaly ?? "")}`) };
  };
  const SHARED_TOKEN_CLAIM = "shared admin token";

  eq("access + IdP -> verified with provider", drive("access", "GitHub").state, "verified");
  eq("access -> verified", drive("access").state, "verified");
  eq("passkey -> passkey-verified", drive("passkey").state, "passkey-verified");
  // The four states that USED to be the shared-token claim, on the one screen whose job is the posture.
  eq("oidc -> idp-verified (a live native OIDC session, NOT the break-glass token)", drive("oidc").state, "idp-verified");
  eq("saml -> idp-verified (a live native SAML session, NOT the break-glass token)", drive("saml").state, "idp-verified");
  eq("recovery -> recovery-verified (attributable, and its own state)", drive("recovery").state, "recovery-verified");
  eq("a method this build has never heard of -> unknown, and NO posture claim", drive("quantum-attest").state, "unknown");
  // And the break-glass claim is worn only by the break-glass method.
  eq("token -> token-fallback", drive("token").state, "token-fallback");
  ok("token: the panel DOES name the shared token (it is true here)", drive("token").panel.includes(SHARED_TOKEN_CLAIM));
  for (const m of ["access", "passkey", "oidc", "saml", "recovery", "quantum-attest"]) {
    ok(`${m}: the panel never claims the shared admin token`, !drive(m).panel.includes(SHARED_TOKEN_CLAIM));
  }
  // DISCRIMINATION: the seven methods are six distinct verdicts (oidc and saml share idp-verified, and the panel
  // separates them by protocol), where they used to be three, four of them collapsed onto the worst one.
  ok(
    "the engine's six methods plus an unrecognised one are SIX distinct verdicts, not three",
    new Set(["access", "passkey", "oidc", "saml", "recovery", "token", "quantum-attest"].map((m) => drive(m).state)).size === 6,
  );
  ok("oidc and saml are separated by protocol in the panel the customer reads", drive("oidc").panel.includes("OIDC") && drive("saml").panel.includes("SAML"));
  // AND THE PACK. The six known methods are legitimate states and record NOTHING; only the method the console
  // could not read writes a row, and the row carries the closed class, never the method string.
  for (const m of ["access", "passkey", "oidc", "saml", "recovery", "token"]) {
    eq(`${m}: a legitimate sign-in records NOTHING (no wolf-cry in the pack)`, drive(m).rows.length, 0);
  }
  eq("an unrecognised method records the wire anomaly", drive("quantum-attest").rows, ["wire-anomaly/auth-method/unknown-enum"]);
  ok("REDACTION: the unrecognised method string never reaches the ring", !JSON.stringify(snapshot()).includes("quantum-attest"));
  setCaller(null);
  setWhoamiAvailable(false);
  eq("whoami unavailable -> session-present, never a verified green", deriveVerdict().state, "session-present");

  // ------------------------------------------------------------------------
  console.log("\n-- verifierErrorTile: 401 vs network vs server map to distinct tiles --");
  // ------------------------------------------------------------------------
  {
    // A 401 is the unverified verdict (re-auth), NOT an error tile.
    const tile = verifierErrorTile(fakeEngine, new Error("whoami: 401"), noop);
    ok("401 -> unverified verdict ('Access session not valid')", tileText(tile).includes("Access session not valid"));
    ok("401 -> NOT the CONSOLE_ORIGIN danger tile", qs(SN(tile) as unknown as ShimNode, ".verdict--danger") === null);
  }
  {
    // A no-status fetch failure is the CONSOLE_ORIGIN setup error (red danger tile) synchronously.
    const tile = verifierErrorTile(fakeEngine, new Error("Failed to fetch"), noop);
    ok("network -> the CONSOLE_ORIGIN danger tile is painted", qs(SN(tile) as unknown as ShimNode, ".verdict--danger") !== null);
    ok("network -> names CONSOLE_ORIGIN", tileText(tile).includes("CONSOLE_ORIGIN"));
  }
  {
    // A server (non-2xx, has a status) error is the connected-but-degraded session-present verdict.
    const tile = verifierErrorTile(fakeEngine, new Error("whoami: 503"), noop);
    ok("server -> session-present verdict ('Session present')", tileText(tile).includes("Session present"));
    ok("server -> NOT the CONSOLE_ORIGIN danger tile", qs(SN(tile) as unknown as ShimNode, ".verdict--danger") === null);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- roleBasisNote: each of the five roleSource branches renders the right basis --");
  // ------------------------------------------------------------------------
  const note = (src: RoleSource, role: Role, email: string | null, groups: string[], idp?: string): string =>
    tileText(roleBasisNote(src, role, email, groups, idp));
  {
    const t = note("owner-token", "owner", null, []);
    ok("owner-token -> names the shared token (break-glass)", t.includes("Role basis:") && t.includes("shared token"));
  }
  {
    const t = note("email", "operator", "person@example.com", [], "GitHub");
    ok("email -> names the direct grant + the email", t.includes("granted directly to") && t.includes("person@example.com"));
    ok("email -> carries the provider suffix", t.includes("via GitHub"));
  }
  {
    const t = note("group", "approver", "person@example.com", ["myorg/ops", "myorg/sec"]);
    ok("group -> names the role and the verified groups", t.includes("approver via your identity-provider group(s)") && t.includes("myorg/ops") && t.includes("myorg/sec"));
  }
  {
    // A group source with NO groups falls back to the generic phrasing, never an empty list.
    const t = note("group", "viewer", null, []);
    ok("group, no groups -> the generic 'your identity-provider group(s)' phrasing", t.includes("your identity-provider group(s)"));
  }
  {
    const t = note("custom", "viewer", "person@example.com", []);
    ok("custom -> names a custom role / capability bundle", t.includes("Role basis:") && t.includes("custom role"));
  }
  {
    const t = note("default", "viewer", null, []);
    ok("default -> names the least-privilege viewer fallback", t.includes("viewer (default") && t.includes("least-privilege"));
  }

  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
    if (failures > 0) process.exit(1);
}

main();
