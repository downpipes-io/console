// The SIGN-IN FACTOR REVOKE control: the portal action that closes every way a named person authenticates,
// so that half of an offboarding is no longer an administrator API call.
//
// Run with: node test/validate-signin-factor-revoke.ts
//
// It drives the REAL EngineClient over a captured global fetch and the REAL panel over the shared dom-shim,
// never a reimplementation of either. Three things it measures rather than assumes:
//
//   1. THE STEP-UP PROMPT, BY COUNTING IT. A claim that a prompt appears is worthless unless somebody
//      counted, so this counts on both sides. The console side: the revoke really does run the
//      injected ceremony on a 401 { stepUpRequired } and really does carry the token on the retry, so the
//      transport can carry a prompt. The ENGINE side: the route is read out of the engine's own STEPUP_SUBS
//      and it is NOT a member, so no prompt is ever opened for it in practice. The two together are the
//      honest statement, and the copy check below binds them: while the engine does not ask, the modal must
//      not tell the operator to approve one.
//
//   2. THE REFUSALS, DRIVEN. Self-revocation and the Owner-escalation lock are driven through the real
//      render and the real click handlers, and the assertion is that the engine is NEVER CALLED, not merely
//      that a button looks greyed. The engine-side refusals (the sole-Owner floor, the raised dual-control
//      floor, the escalation guard) were driven separately against the real Durable Object; what is checked
//      HERE is that each of their refusal bodies reaches the operator rather than being swallowed.
//
//   3. THE FALSE NEGATIVE. The engine's own header says the dangerous failure of this read is being told NO
//      when the truth is UNPROVABLE. So the tri-state is checked end to end, and the unreadable code count is
//      checked never to render as zero.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineClient } from "../src/api.ts";
import type { Caller, RoleEntry, SignInFactorRow, SignInFactorRevokeResult } from "../src/api.ts";
import { renderSignInFactorsPanel, verdictStatus, factorSummary, revokeSummary, SELF_REVOKE_REASON, OWNER_ROW_REVOKE_REASON } from "../src/screens/access-security/signin-factors.ts";
import { setCaller, setWhoamiAvailable } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";
import { findButtonByText, click } from "./validate-stable-components-shared.ts";
import { engineRoot } from "./engine-root.ts";

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
// isDisabled reads EITHER refusal state, and reading only one of the two is how this check would quietly
// stop checking. The revoke control now expresses its lock with aria-disabled rather than `disabled`, so
// it stays in the tab order and its reason is reachable by keyboard; a reader that only looked for the
// `disabled` attribute would report every locked row as unlocked, and worse, the DISCRIMINATION assertion
// below ("the same caller IS allowed a non-owner row") would pass vacuously because both rows would read
// as enabled. Both states are read here so the discrimination keeps its meaning.
function isDisabled(n: ShimNode | undefined): boolean {
  return n !== undefined && (n.getAttribute("disabled") !== null || n.getAttribute("aria-disabled") === "true");
}
// isEnabled requires BOTH presence and not-disabled. `!isDisabled(x)` alone is vacuously true for an absent
// control, which would let an "is enabled" assertion pass when the control never rendered at all.
function isEnabled(n: ShimNode | undefined): boolean {
  return n !== undefined && !isDisabled(n);
}
function titleOf(n: ShimNode | undefined): string {
  if (n === undefined) return "";
  return (n as unknown as { title?: string }).title || n.getAttribute("title") || "";
}
function rowFor(root: unknown, needle: string): ShimNode | undefined {
  return qsa(root, "tr").find((tr) => textOf(tr).includes(needle));
}

const OWNER: Caller = { method: "passkey", email: "owner1@example.com", role: "owner", groups: [], isOnlyOwner: false };
const ACCESS_ADMIN: Caller = { method: "passkey", email: "admin@example.com", role: "access-admin", groups: [], isOnlyOwner: false };
const VIEWER: Caller = { method: "passkey", email: "viewer@example.com", role: "viewer", groups: [], isOnlyOwner: false };

function factorRow(email: string, over: Partial<SignInFactorRow> = {}): SignInFactorRow {
  return {
    email,
    hasRoleEntry: true,
    signIn: "can-sign-in",
    paths: ["passkey"],
    passkey: { credentials: 1, credentialIds: ["cred-1"], lastAssertedAt: "2026-08-01T00:00:00.000Z" },
    recovery: { present: false, parseable: true, unconsumedCodes: null, keyContinuity: "none", generatedAt: null },
    invites: { live: 0, expired: 0, soonestExpiresAt: null },
    ...over,
  };
}

const ROLES: RoleEntry[] = [
  { email: "owner1@example.com", role: "owner", grantedBy: "bootstrap", grantedAt: "2026-01-01T00:00:00.000Z" },
  { email: "owner2@example.com", role: "owner", grantedBy: "owner1@example.com", grantedAt: "2026-01-02T00:00:00.000Z" },
  { email: "admin@example.com", role: "access-admin", grantedBy: "owner1@example.com", grantedAt: "2026-01-03T00:00:00.000Z" },
  { email: "leaver@example.com", role: "operator", grantedBy: "owner1@example.com", grantedAt: "2026-01-04T00:00:00.000Z" },
] as RoleEntry[];

// The listing deliberately carries a row that is NOT on the roster (ghost@), which is the population this
// whole surface exists for: in practice, a majority of identities on an estate can sign in with no role row.
function listing(rows?: SignInFactorRow[]): { scope: "account"; factors: SignInFactorRow[]; witnessSince: null; groupRoleMappings: number } {
  return {
    scope: "account",
    factors: rows ?? [
      factorRow("owner1@example.com"),
      factorRow("owner2@example.com"),
      factorRow("leaver@example.com", { hasRoleEntry: false, recovery: { present: true, parseable: true, unconsumedCodes: 8, keyContinuity: "live", generatedAt: "2026-02-01T00:00:00.000Z" }, paths: ["passkey", "recovery-code"] }),
      factorRow("ghost@example.com", { hasRoleEntry: false, passkey: { credentials: 0, credentialIds: [], lastAssertedAt: null }, signIn: "indeterminate", paths: [], recovery: { present: true, parseable: false, unconsumedCodes: null, keyContinuity: "unknown", generatedAt: null } }),
    ],
    witnessSince: null,
    groupRoleMappings: 0,
  };
}

interface FakePanelEngine { engine: EngineClient; revoked: string[]; reads: Array<string | undefined> }
function fakePanelEngine(opts: { revoke?: () => Promise<SignInFactorRevokeResult>; rows?: SignInFactorRow[] } = {}): FakePanelEngine {
  const revoked: string[] = [];
  const reads: Array<string | undefined> = [];
  const engine = {
    async listSignInFactors(email?: string) {
      reads.push(email);
      if (email !== undefined) return { ...listing(opts.rows), scope: "email" as const, factors: listing(opts.rows).factors.filter((f) => f.email === email) };
      return listing(opts.rows);
    },
    async listRoles() {
      return ROLES;
    },
    async revokeSignInFactors(email: string) {
      revoked.push(email);
      if (opts.revoke) return opts.revoke();
      return { email, revoked: { passkeyCredentials: 1, recovery: true, invitesLive: 0, invitesExpired: 0 }, sessionsTerminated: true };
    },
  } as unknown as EngineClient;
  return { engine, revoked, reads };
}

// A scripted fetch, the validate-stepup-dest-idp.ts pattern: answer the first request with `first`, the
// second (the step-up retry, if any) with `second`, and record every request's headers so the retry's
// x-downpipes-stepup header can be asserted rather than assumed.
interface Recorded { path: string; method: string; headers: Record<string, string> }
interface CannedResponse { status: number; body: unknown }
function scriptFetch(first: CannedResponse, second?: CannedResponse): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = async (input: unknown, init?: { method?: string; headers?: unknown }) => {
    const headers: Record<string, string> = {};
    const hd = init?.headers;
    if (hd instanceof Headers) for (const [k, v] of hd.entries()) headers[k.toLowerCase()] = v;
    else if (hd && typeof hd === "object") for (const [k, v] of Object.entries(hd as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    calls.push({ path: String(input), method: init?.method ?? "GET", headers });
    const which = calls.length === 1 ? first : (second ?? first);
    return {
      ok: which.status >= 200 && which.status < 300,
      status: which.status,
      async text() { return JSON.stringify(which.body); },
      async json() { return which.body; },
      clone() { return this; },
    };
  };
  return { calls, restore: () => { g.fetch = prev; } };
}

const STEPUP_TOKEN = "stepuptoken-deadbeef";

// stripLineComments removes `//` comment tails. THIS IS THE LOAD-BEARING STEP and not tidiness: the prose
// around and INSIDE the engine's STEPUP_SUBS names a dozen routes and quotes phrases, so a plain string
// search over the raw file would match the discussion and report gates that do not exist. That is the
// comment-scanner mistake, so the reader here does not make it.
function stripLineComments(src: string): string {
  return src.split("\n").map((line) => {
    const i = line.indexOf("//");
    return i === -1 ? line : line.slice(0, i);
  }).join("\n");
}

// The engine's real STEPUP_SUBS membership, read from the engine's own source. Every member is a route sub
// and every route sub starts with a slash, so the extraction requires one: that is a SECOND guard against a
// quoted phrase in surrounding prose being counted as a gated route. Returns null when the sibling engine is
// not checked out, which the caller treats as a SKIP and never as a pass.
function engineStepUpSubs(): Set<string> | null {
  const root = engineRoot();
  if (root === null) return null;
  const src = stripLineComments(readFileSync(join(root, "src/admin/router-core.ts"), "utf8"));
  const m = src.match(/STEPUP_SUBS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  const body = m[1] ?? "";
  return new Set([...body.matchAll(/"(\/[^"]*)"/g)].map((x) => x[1] ?? ""));
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

  // ------------------------------------------------------------------------
  console.log("\n-- 1a: the revoke really runs the step-up ceremony, counted, and carries the token on the retry --");
  // ------------------------------------------------------------------------
  {
    const engine = new EngineClient("https://engine.test");
    let ceremonyRuns = 0;
    engine.onStepUpRequired = async () => { ceremonyRuns++; return STEPUP_TOKEN; };
    const { calls, restore } = scriptFetch(
      { status: 401, body: { stepUpRequired: true } },
      { status: 200, body: { email: "leaver@example.com", revoked: { passkeyCredentials: 1, recovery: true, invitesLive: 0, invitesExpired: 0 }, sessionsTerminated: true } },
    );
    const result = await engine.revokeSignInFactors("leaver@example.com").catch(() => null).finally(restore);
    eq("the ceremony ran EXACTLY ONCE (counted, not assumed)", ceremonyRuns, 1);
    eq("the call was retried, so there are two requests", calls.length, 2);
    ok("both requests are the revoke route", calls.every((c) => c.path.endsWith("/admin/signin-factors/revoke")));
    ok("both requests are POSTs", calls.every((c) => c.method === "POST"));
    ok("the FIRST request carried no step-up token", calls[0]?.headers["x-downpipes-stepup"] === undefined);
    eq("the RETRY carried the ceremony's token", calls[1]?.headers["x-downpipes-stepup"], STEPUP_TOKEN);
    ok("and the retry's body was accepted as a revocation receipt", result !== null && result.sessionsTerminated === true);
  }
  {
    // With NO ceremony wired the original 401 is surfaced and there is NO retry: the console must not
    // pretend a step-up happened when nothing could run one.
    const engine = new EngineClient("https://engine.test");
    const { calls, restore } = scriptFetch({ status: 401, body: { stepUpRequired: true } });
    const threw = await engine.revokeSignInFactors("leaver@example.com").then(() => false).catch(() => true).finally(restore);
    ok("with no ceremony wired the revoke fails rather than silently succeeding", threw);
    eq("and it is NOT retried", calls.length, 1);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 1b: the panel's copy about the step-up prompt agrees with the ENGINE's own STEPUP_SUBS --");
  // ------------------------------------------------------------------------
  {
    const subs = engineStepUpSubs();
    if (subs === null) {
      // TWO CAUSES, SAID APART, because they are different facts and the old line ran them together. No
      // sibling checkout is a property of where this ran. A Set that would not parse is a change in the
      // engine, and is the more interesting of the two: it means this comparison has stopped working while
      // an engine sits right there. Only the first is excused by a console-only clone.
      const rooted = engineRoot() !== null;
      console.log(
        rooted
          ? "CANNOT CHECK the engine STEPUP_SUBS read: an engine IS reachable but its Set would not parse, so the shape has moved"
          : "CANNOT CHECK the engine STEPUP_SUBS read: no sibling engine checkout",
      );
      // Without a REQUIRE arm, a run with no sibling engine would exit 0 with REQUIRE_ENGINE=1 exactly as
      // it did without it, printing one lower-case skip line among its ok lines. What would go unchecked is
      // whether the panel's copy about the step-up prompt agrees with the routes the engine actually gates,
      // which is a claim made to an operator mid-incident.
      if (process.env.REQUIRE_ENGINE === "1") {
        console.error(`validate-signin-factor-revoke: REFUSED, REQUIRE_ENGINE=1 and the engine's STEPUP_SUBS could not be read (${rooted ? "an engine is reachable but the Set would not parse" : "no engine checkout is reachable"}).\n` +
            "  The panel's copy about the step-up prompt is graded against the engine's own gated-route Set,\n" +
            "  so without it this block cannot answer its question and will not report that it did.\n" +
            (rooted
              ? "  Follow the declaration in the engine's src/admin/router-core.ts rather than dropping the check."
              : "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run."),); process.exit(2);
      }
    } else {
      // A POSITIVE CONTROL FIRST. Without it a parse that silently returned an empty Set would "prove" the
      // gap and prove nothing. /passkey/credentials/delete removes ONE credential and IS gated, so it must
      // be found; the revoke removes every credential plus the recovery record plus every invite.
      ok("positive control: /passkey/credentials/delete IS in the engine's STEPUP_SUBS (the parse works)", subs.has("/passkey/credentials/delete"));
      ok("positive control: /roles/delete IS in it too", subs.has("/roles/delete"));
      const gated = subs.has("/signin-factors/revoke");
      console.log(`       measured: /signin-factors/revoke ${gated ? "IS" : "is NOT"} in STEPUP_SUBS (${subs.size} members)`);
      // THE BINDING ASSERTION, NOW IN BOTH DIRECTIONS. Its first form was `gated || !promises`: while the
      // engine did not ask for a step-up here, the modal must not tell the operator to approve one. That
      // half was right: while the engine did not ask for a step-up here, the modal must not tell the
      // operator to approve one. What it did not do was survive the engine changing its mind: a
      // one-directional consistency check stops checking the moment the thing it watches moves, since a
      // route the engine later gated would make `gated` true and the assertion would then pass on copy
      // that had become false.
      //
      // So: gated demands the copy NAME the prompt, ungated demands it stay silent, and there is no state
      // in which this passes without looking at the copy. Line comments are stripped first, so the panel's
      // own explanation of this rule cannot satisfy it (the header above openRevokeModal quotes both
      // wordings).
      //
      // This block is hard-coded to this file and this route; a broader gate over every confirmation that
      // sits in front of a gated write, deriving that set from the engine's own STEPUP_SUBS, is out of
      // scope here. This block stays because it drives the REAL panel and the real ceremony either side of
      // the copy claim, which a broader source-text gate cannot.
      const panelSrc = stripLineComments(
        readFileSync(new URL("../src/screens/access-security/signin-factors.ts", import.meta.url).pathname, "utf8"),
      );
      const promises = /asked to confirm with your own passkey|approve the (passkey )?prompt|step-up prompt will|you will be asked to re-?authenticate/i.test(panelSrc);
      ok(
        gated
          ? "the engine gates this route, so the panel copy NAMES the step-up prompt"
          : "the engine does not gate this route, so the panel copy promises no step-up prompt",
        gated ? promises : !promises,
      );
      // And when it is gated, the copy must also say what a dismissed ceremony leaves behind. requireStepUp
      // runs before the dispatch switch, so a refused prompt revokes nothing; an operator who is told only
      // that a prompt may appear is left guessing whether dismissing it half-offboarded somebody.
      if (gated) {
        ok(
          "the panel copy says a dismissed or failed ceremony revokes nothing",
          /nothing is revoked/i.test(panelSrc),
        );
      }
    }
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 2a: SELF-REVOCATION is refused, and the engine is never called --");
  // ------------------------------------------------------------------------
  {
    setCaller(OWNER);
    const { engine, revoked } = fakePanelEngine();
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    const row = rowFor(el, "owner1@example.com");
    ok("the caller's own row renders in the factor table", row !== undefined);
    const btn = row ? findButtonByText(row, "Revoke sign-in") : undefined;
    ok("Revoke sign-in is DISABLED on the caller's own row", isDisabled(btn));
    eq("and the reason is the console's own self-lockout reason", titleOf(btn), SELF_REVOKE_REASON);
    ok("the reason is also VISIBLE text, not title-only (keyboard and touch users read nothing from a title)", row !== undefined && textOf(row).includes("You cannot revoke your own sign-in factors here"));
    // The load-bearing part: no listener is attached, so a click is a genuine no-op rather than a control
    // that would have reached the engine. The engine PERMITS self-revocation (driven against the real
    // Durable Object: an Owner with a second Owner present revoked their own factors, got
    // 200, and lost both their credential and their recovery record), so nothing downstream would stop it.
    if (btn) click(btn);
    await flushAsync();
    eq("clicking the locked self row never calls the engine", revoked, []);
    ok("and it opens no modal", qs(document.body, ".dialog--modal") === null);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 2b: OWNER ESCALATION. access-admin holds roles.write and is still locked out of an Owner row --");
  // ------------------------------------------------------------------------
  {
    setCaller(ACCESS_ADMIN);
    const { engine, revoked } = fakePanelEngine();
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    const ownerRow = rowFor(el, "owner2@example.com");
    const leaverRow = rowFor(el, "leaver@example.com");
    const ownerBtn = ownerRow ? findButtonByText(ownerRow, "Revoke sign-in") : undefined;
    const leaverBtn = leaverRow ? findButtonByText(leaverRow, "Revoke sign-in") : undefined;
    ok("access-admin: Revoke sign-in is DISABLED on an Owner row", isDisabled(ownerBtn));
    eq("access-admin: the reason names the owner-escalation rule", titleOf(ownerBtn), OWNER_ROW_REVOKE_REASON);
    // The DISCRIMINATION, and without it the lock could be a blanket denial dressed up as a guard. The same
    // access-admin is allowed the non-owner row, which is exactly what the real Durable Object did: 403 on
    // the Owner target, 200 on the non-owner target seconds later.
    ok("access-admin: the SAME caller is allowed a NON-owner row, so this is the escalation guard and not a blanket denial", isEnabled(leaverBtn));
    if (ownerBtn) click(ownerBtn);
    await flushAsync();
    eq("access-admin: clicking the locked Owner row never calls the engine", revoked, []);
    ok("access-admin: and it opens no modal", qs(document.body, ".dialog--modal") === null);
  }
  {
    // An actual Owner is unaffected by the Owner-row lock.
    setCaller(OWNER);
    const { engine } = fakePanelEngine();
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    const ownerRow = rowFor(el, "owner2@example.com");
    ok("an Owner caller may still revoke another Owner's factors (the lock is not universal)", isEnabled(ownerRow ? findButtonByText(ownerRow, "Revoke sign-in") : undefined));
  }
  {
    setCaller(VIEWER);
    const { engine } = fakePanelEngine();
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    ok("a viewer gets no revoke control at all", findButtonByText(el, "Revoke sign-in") === undefined);
    ok("and is told which capability they lack, by name", textOf(el).includes("roles.write") || textOf(el).toLowerCase().includes("manage roles"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 2c: the engine's own refusal bodies reach the operator rather than being swallowed --");
  // ------------------------------------------------------------------------
  {
    // The verbatim sentence the real Durable Object returned for the RAISED DUAL-CONTROL
    // OWNER FLOOR (two Owners, Require Approver armed). It arrives as a 400, so the transport's reason-fold
    // carries the prose; the modal must show it rather than a generic failure.
    const DUAL = "dual control (Require Approver) is on, and revoking this Owner's sign-in factors would leave one Owner who can actually sign in. The stripped Owner still counts toward the two-Owner floor but could no longer approve anything, including their own re-invitation. Appoint another Owner, or turn Require Approver off.";
    const engine = new EngineClient("https://engine.test");
    const { restore } = scriptFetch({ status: 400, body: { error: DUAL } });
    const message = await engine.revokeSignInFactors("owner2@example.com").then(() => "").catch((e: unknown) => (e instanceof Error ? e.message : String(e))).finally(restore);
    ok("the dual-control floor refusal reaches the client with the engine's own sentence intact", message.includes("Appoint another Owner, or turn Require Approver off"));
    ok("and it names the deadlock rather than a demotion nobody performed", message.includes("Require Approver") && !message.includes("demote"));
  }
  {
    // The SOLE-OWNER floor sentence, likewise verbatim from the engine.
    const SOLE = "cannot revoke the sign-in factors of the only Owner: this removes every passkey, recovery code and pending invite at once, so nobody would be able to sign in to this account. Appoint a second Owner first.";
    const engine = new EngineClient("https://engine.test");
    const { restore } = scriptFetch({ status: 400, body: { error: SOLE } });
    const message = await engine.revokeSignInFactors("owner1@example.com").then(() => "").catch((e: unknown) => (e instanceof Error ? e.message : String(e))).finally(restore);
    ok("the sole-Owner floor refusal reaches the client intact", message.includes("Appoint a second Owner first"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 3a: the happy path, driven through the modal, including the pre-confirm inventory read --");
  // ------------------------------------------------------------------------
  {
    setCaller(OWNER);
    const { engine, revoked, reads } = fakePanelEngine();
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    eq("the panel opened with the ACCOUNT-WIDE read (no email), never a self-scoped one", reads, [undefined]);
    const row = rowFor(el, "leaver@example.com");
    const btn = row ? findButtonByText(row, "Revoke sign-in") : undefined;
    ok("the leaver's row offers Revoke sign-in", isEnabled(btn));
    if (btn) click(btn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    ok("the confirm modal opens", surface !== null);
    const text = surface ? textOf(surface) : "";
    ok("it states the act is irreversible", text.includes("cannot be undone"));
    ok("it names recovery codes as unrecoverable", text.includes("Recovery codes cannot be re-derived"));
    ok("it says the person's role is NOT changed by this", text.includes("role, if they still hold one, is not changed"));
    ok("it says a group-conferred role is unaffected, so this is not a demotion", text.includes("identity-provider group is unaffected"));
    // TASK 2: the consequence is shown BEFORE the confirm, read fresh from the engine rather than trusting
    // the row that has been on screen.
    eq("the modal re-read THIS person's factors before confirming", reads, [undefined, "leaver@example.com"]);
    ok("it lists what will be destroyed", text.includes("What this will destroy"));
    ok("and it says the inventory was read just now", text.includes("Read from the engine just now"));
    ok("the inventory names the passkey credential and the usable recovery codes", text.includes("1 passkey credential") && text.includes("8 usable recovery codes"));
    const confirmBtn = surface ? findButtonByText(surface, "Revoke every factor") : undefined;
    ok("the confirm action is present", confirmBtn !== undefined);
    if (confirmBtn) click(confirmBtn);
    await flushAsync();
    eq("engine.revokeSignInFactors actually fired for the named email", revoked, ["leaver@example.com"]);
    ok("the modal closes afterwards", qs(document.body, ".dialog--modal") === null);
  }
  {
    // The pre-confirm read FAILING must not block the revoke: leaving a door open for the sake of a display
    // is the wrong trade. It must, however, say the figures may be stale.
    setCaller(OWNER);
    const revoked: string[] = [];
    const engine = {
      async listSignInFactors(email?: string) {
        if (email !== undefined) throw new Error("read sign-in factors: 500");
        return listing();
      },
      async listRoles() { return ROLES; },
      async revokeSignInFactors(email: string) {
        revoked.push(email);
        return { email, revoked: { passkeyCredentials: 1, recovery: true, invitesLive: 0, invitesExpired: 0 }, sessionsTerminated: true };
      },
    } as unknown as EngineClient;
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    const btn = findButtonByText(rowFor(el, "leaver@example.com") ?? el, "Revoke sign-in");
    if (btn) click(btn);
    await flushAsync();
    const surface = qs(document.body, ".dialog--modal");
    const text = surface ? textOf(surface) : "";
    ok("a failed pre-confirm read says the inventory may be out of date", text.includes("could not be refreshed just now"));
    ok("it does NOT claim the reading is current", !text.includes("Read from the engine just now"));
    const confirmBtn = surface ? findButtonByText(surface, "Revoke every factor") : undefined;
    ok("the revoke is still offered (a failed display must not leave the door open)", confirmBtn !== undefined);
    if (confirmBtn) click(confirmBtn);
    await flushAsync();
    eq("and it still fires", revoked, ["leaver@example.com"]);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 3b: THE FALSE NEGATIVE. Indeterminate is never rendered as a clean bill of health --");
  // ------------------------------------------------------------------------
  {
    const indeterminate = factorRow("ghost@example.com", { signIn: "indeterminate", paths: [], passkey: { credentials: 0, credentialIds: [], lastAssertedAt: null }, recovery: { present: true, parseable: false, unconsumedCodes: null, keyContinuity: "unknown", generatedAt: null } });
    eq("an indeterminate verdict does NOT read as 'no way in'", verdictStatus(indeterminate).label, "cannot be judged");
    ok("and it does not carry the settled 'ok' tone a cleared row gets", verdictStatus(indeterminate).tone !== "ok");
    eq("a no-factor verdict is the only one that reads as cleared", verdictStatus(factorRow("x@e.example", { signIn: "no-factor", paths: [], passkey: { credentials: 0, credentialIds: [], lastAssertedAt: null } })).label, "no way in");
    eq("a can-sign-in verdict is a warning", verdictStatus(factorRow("y@e.example")).tone, "warn");
    // The null-vs-zero rule. A record nobody could parse must never be summarised as "no codes left".
    const summary = factorSummary(indeterminate);
    ok("an unreadable recovery record is named as unreadable", summary.includes("could not be read"));
    ok("and it is NEVER summarised as zero codes", !/0 (usable )?recovery codes|every code used/.test(summary));
    const unknownCount = factorSummary(factorRow("z@e.example", { recovery: { present: true, parseable: true, unconsumedCodes: null, keyContinuity: "unknown", generatedAt: null } }));
    ok("a parseable record with an unknowable count says so rather than reporting zero", unknownCount.includes("unreadable number of codes left"));
    const exhausted = factorSummary(factorRow("w@e.example", { recovery: { present: true, parseable: true, unconsumedCodes: 0, keyContinuity: "live", generatedAt: null } }));
    ok("a genuinely exhausted record IS reported as exhausted (the definite negative is not hidden)", exhausted.includes("every code used"));
    const orphaned = factorSummary(factorRow("v@e.example", { recovery: { present: true, parseable: true, unconsumedCodes: 5, keyContinuity: "orphaned", generatedAt: null } }));
    ok("refuted codes are named as refuted, not as usable", orphaned.includes("can no longer verify") && !orphaned.includes("usable"));
    // And it reaches the screen: the indeterminate row's confirm modal must say the question is unanswered.
    setCaller(OWNER);
    const { engine } = fakePanelEngine({ rows: [indeterminate] });
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    const btn = findButtonByText(el, "Revoke sign-in");
    if (btn) click(btn);
    await flushAsync();
    const text = textOf(qs(document.body, ".dialog--modal"));
    ok("the confirm modal calls an unjudgeable record an unanswered question, not a no", text.includes("unanswered question, not a no"));
    const cancel = findButtonByText(qs(document.body, ".dialog--modal"), "Cancel");
    if (cancel) click(cancel);
    await flushAsync();
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 3c: the receipt. A revoke that closed nothing must not report a reassuring total --");
  // ------------------------------------------------------------------------
  {
    const closedNothing: SignInFactorRevokeResult = { email: "ghost@example.com", revoked: { passkeyCredentials: 0, recovery: false, invitesLive: 0, invitesExpired: 4 }, sessionsTerminated: false };
    const s = revokeSummary("ghost@example.com", closedNothing);
    ok("it says nothing was closed", s.message.startsWith("Nothing was closed"));
    ok("the four expired invites are reported as a sweep, not as ways in", s.message.includes("4 expired invites were swept"));
    ok("and it says no session was ended", s.message.includes("Their live sessions were left alone"));
    ok("a revoke that closed nothing is not dressed up as a warning either", s.tone === undefined);

    const closedSomething: SignInFactorRevokeResult = { email: "leaver@example.com", revoked: { passkeyCredentials: 2, recovery: true, invitesLive: 1, invitesExpired: 3 }, sessionsTerminated: true };
    const s2 = revokeSummary("leaver@example.com", closedSomething);
    ok("a real revoke names each store it closed", s2.message.includes("2 passkey credentials") && s2.message.includes("their recovery codes") && s2.message.includes("1 unexpired invite"));
    ok("the expired sweep stays a SEPARATE sentence and never pads the count that matters", s2.message.includes("3 expired invites were swept"));
    ok("and it says the sessions were ended", s2.message.includes("Their live sessions were ended"));
    // The engine's OWN verdict decides, never a recomputation from the counts. A receipt whose counts look
    // busy but whose sessionsTerminated is false is the expired-only sweep, and it must read as one.
    const contradictory: SignInFactorRevokeResult = { email: "x@e.example", revoked: { passkeyCredentials: 0, recovery: false, invitesLive: 0, invitesExpired: 9 }, sessionsTerminated: false };
    ok("the summary follows the engine's sessionsTerminated, not its own arithmetic", revokeSummary("x@e.example", contradictory).message.startsWith("Nothing was closed"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 3d: the group-claim caveat, and the roster gap this panel exists to show --");
  // ------------------------------------------------------------------------
  {
    setCaller(OWNER);
    const { engine } = fakePanelEngine();
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    const text = textOf(el);
    ok("with no group mappings the panel says an identity with no role row holds no authority", text.includes("An identity with no role row holds no authority here"));
    ok("the panel shows an identity that can sign in with NO role row (the population this exists for)", rowFor(el, "ghost@example.com") !== undefined);
    ok("and it labels that identity as off the roster", textOf(rowFor(el, "ghost@example.com")).includes("no role row"));
    ok("the panel states that revoking is not the same act as removing a role", text.includes("Revoking is not the same act as removing a role"));
  }
  {
    setCaller(OWNER);
    const engine = {
      async listSignInFactors() { return { ...listing(), groupRoleMappings: 3 }; },
      async listRoles() { return ROLES; },
      async revokeSignInFactors() { throw new Error("not reached"); },
    } as unknown as EngineClient;
    const el = renderSignInFactorsPanel(engine);
    await flushAsync();
    const text = textOf(el);
    ok("with mappings configured the panel says the engine cannot tell you who is in a mapped group", text.includes("cannot tell you whether a given identity is in a mapped group"));
    ok("and warns that removing the role row would not have removed a group-conferred one", text.includes("removing their role row would not have removed it"));
    ok("it does NOT claim a role-less identity holds no authority in that case", !text.includes("An identity with no role row holds no authority here"));
  }

  console.log(failures === 0 ? "\nSIGN-IN FACTOR REVOKE PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

void main();
