// Validate the setup surface's page-level behaviours that are not the step model's (validate-setup-state.ts
// holds those): what its questions render and do, driven through the REAL page (/setup, screens/setup/b/)
// over the demo engine (setup-surface-harness.ts), never a copy of its logic.
//
// Coverage:
//   Moved here with its control from the retired first-run deck's team card: the team view's
//     "Grant role" -> setRole. A real fault says no role was granted and offers a one-press retry, never a
//     "pending engine support" disguise; a 401 hands off to sign-in; a success states the stored fact, shows
//     the one-time invite link once when the engine mints one, and otherwise says to tell them out of band.
//   B40: the team view is gated on roles.write (Owner and access-admin), not the owner ladder.
//   The team view offers only the built-in roles the caller can grant, and names the ones it withholds (moved
//     here from validate-roles-access-gating.ts with the retired first-run invite form).
//   Finish over a first run with no seal verdict (VERIFY_AT_SEAL off): "sealed", never "verified" or
//     "protected", with the first run as an open item that offers a restore test.
//   An install set up before this setup page (downpipes with no integrity stamp): the shell counts it set up,
//     and in a tab that runs setup the first backup view offers the run as optional, with "Leave setup" to
//     skip it.
//   A console set up elsewhere, in a tab that did not run setup (regression review F3): /setup and its
//     questions go to Overview rather than show plan and receipt lines from an empty draft; the team invite
//     and the engine's own check stand alone, with "Open the console" as the way out. A tab that ran setup
//     keeps its receipt (control), and a fresh engine keeps setup (control).
//   The hand-off for a caller who is not an Owner says the screens open when setup is done, not when a
//     backup is sealed (F6). Finish names the restore test as the proof Overview waits for (F8).
//   Protect's add-by-id sheet refuses a name whose SRC_* binding would pass the engine's 64 characters.
//   Apply and First backup through the real questions: the own-wrangler route lists the secrets and the
//     binding stanza, "Install and attach" refuses no token and then installs and attaches with one, the revoke
//     tick records the revoke, and "Create and run now" creates the downpipe and watches its run to the seal.
//   A first backup where the engine did not start one of two runs (a 500, or an answer with no run id): the run
//     view names that downpipe, never says sealed or offers the receipt, and "Run it again" starts only it; the
//     run view, the strip and Finish agree before and after.
//
// Run with .

import { installDomShim, flushAsync, qs, qsa, textOf } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const harness = await import("./setup-surface-harness.ts");
const { getEngine } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");
type Caller = import("../src/api.ts").Caller;

let failures = 0;
let checks = 0;
const h = {
  ok(label: string, cond: boolean): void {
    checks++;
    console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
    if (!cond) failures++;
  },
};
const ok = h.ok.bind(h);

console.log("\n-- the team view's Grant role -> setRole (real page) --");
// setRoleResult is the shape EngineClient.setRole resolves to (RoleEntry); only the
// fields the success copy reads (email, role) are asserted.
type SetRoleArgs = { email: string; role: string };

// driveInvite renders the REAL setup page at /setup/team for an Owner, injects a setRole double with the
// given behaviour, fills the email field, picks the role tile, presses the real "Grant role" primary (the
// label says what the call does: a role-table upsert; whether an email goes out depends on engine config the
// console cannot see), and reports what happened: the captured setRole arguments, whether the sign-in
// hand-off fired, whether the handler threw (an unhandled rejection escaping its own handling), and the
// rendered text. It rebuilds the world each call so scenarios are independent. The ok entry may carry the
// engine-minted inviteToken the 200 body returns alongside the entry.
async function driveInvite(
  behaviour: { kind: "ok"; entry: SetRoleArgs & { inviteToken?: string } } | { kind: "throw"; error: Error },
  opts: { email: string; role?: "viewer" | "operator" | "approver" } = { email: "teammate@example.com" },
): Promise<{ captured: SetRoleArgs | null; signedOut: boolean; threw: boolean; outputText: string; rootText: string }> {
  harness.resetSetupWorld(harness.OWNER);
  const engine = getEngine();
  if (!engine) return { captured: null, signedOut: false, threw: false, outputText: "", rootText: "" };

  let signedOut = false;
  installNav({
    navigate: () => {},
    onUnauthorised: () => { signedOut = true; },
    refreshIdentity: async () => {},
    signOut: () => {},
    onAuthenticated: async () => {},
  });

  let captured: SetRoleArgs | null = null;
  // setRole resolves to a MutationResult (the change-control gate may defer a role change): the success
  // path wraps the entry as { status:"applied", value }.
  (engine as unknown as { setRole: (email: string, role: string) => Promise<{ status: "applied"; value: SetRoleArgs }> }).setRole = async (email, role) => {
    captured = { email, role };
    if (behaviour.kind === "throw") throw behaviour.error;
    return { status: "applied", value: behaviour.entry };
  };

  let threw = false;
  const onRejection = () => { threw = true; };
  process.on("unhandledRejection", onRejection);
  try {
    const root = await harness.renderSetup("/setup/team");
    const emailInput = qsa(root, "input").find((i) => i.getAttribute("type") === "email");
    if (emailInput) (emailInput as { value: string }).value = opts.email;
    if (opts.role) {
      const tile = qsa(root, "input").find((i) => i.getAttribute("value") === opts.role);
      if (tile) {
        // A browser unchecks the rest of a radio group when one is checked; the shim does not, so this does.
        for (const r of qsa(root, "input")) if (r.getAttribute("name") === tile.getAttribute("name")) (r as unknown as { checked: boolean }).checked = false;
        (tile as unknown as { checked: boolean }).checked = true;
        tile.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
      }
    }
    qs(root, "form.fb-stage")?.dispatchEvent(makeEvent({ type: "submit", bubbles: true }));
    await flushAsync();
    const out = qsa(root, ".fb-msg").find((m) => !(m as unknown as { hidden: boolean }).hidden && m.getAttribute("hidden") === null) ?? null;
    return { captured, signedOut, threw, outputText: out ? textOf(out) : "", rootText: textOf(root) };
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

// 7a. setRole REAL FAULT (a 503): NEW CONTRACT (finding invite-d3-false-pending) -- a
// real failure renders the retryable blockError, never the pendingEngineNote (dressing
// a 500/503 up as a missing feature masked real errors); the handler does not throw;
// the engine was actually called with the entered email + default role.
{
  const r = await driveInvite({ kind: "throw", error: new Error("set role: 503") }, { email: "ada@example.com" });
  ok("7a: setRole was called (real handler reached the write)", r.captured !== null);
  ok("7a: setRole received the entered email", r.captured?.email === "ada@example.com");
  ok("7a: setRole received the default role (viewer)", r.captured?.role === "viewer");
  ok("7a: a real fault (503) says no role was granted, with a one-press retry", r.rootText.includes("No role was granted") && r.rootText.includes("Try again"));
  ok("7a: a real fault is NOT dressed up as pending engine support", !r.rootText.includes("Pending engine support"));
  ok("7a: the handler did NOT throw (degraded, not crashed)", r.threw === false);
  ok("7a: a non-2xx is NOT routed to signed-out", r.signedOut === false);
}

// 7a2. setRole 404: every released engine serves POST /admin/roles, so a 404 is a fault like
// any other and renders the retryable block error, with no pending-engine note and no
// internal work-item ID.
{
  const r = await driveInvite({ kind: "throw", error: new Error("set role: 404") }, { email: "ada@example.com" });
  ok("7a2: a 404 renders the retryable failure", r.rootText.includes("Try again"));
  ok("7a2: a 404 is NOT dressed up as pending engine support", !r.rootText.includes("Pending engine support"));
  ok("7a2: the 404 copy names no internal work-item ID", !/\bD[1-5]\b/.test(r.rootText));
  ok("7a2: a 404 does not throw", r.threw === false);
  ok("7a2: a 404 is NOT routed to signed-out", r.signedOut === false);
}

// 7b. setRole 401: routes to signed-out (goSignedOut), does not throw, and does NOT
// render the pendingEngineNote (the handler returns early on unauthorised).
{
  const r = await driveInvite({ kind: "throw", error: new Error("set role: 401") }, { email: "grace@example.com" });
  ok("7b: a 401 routes to signed-out", r.signedOut === true);
  ok("7b: a 401 does not throw", r.threw === false);
  ok("7b: a 401 does not render the pendingEngineNote degrade", !r.rootText.includes("Pending engine support"));
}

// 7c. setRole SUCCESS (finding invite-d3-false-pending): the engine enforces the role
// table, so the success copy states the stored fact plainly and must NOT carry an
// enforcement caveat (one would tell the Owner an enforced grant was unenforced). With no inviteToken in the 200 body, the out-of-band hint renders.
{
  const r = await driveInvite(
    { kind: "ok", entry: { email: "linus@example.com", role: "operator" } },
    { email: "linus@example.com", role: "operator" },
  );
  ok("7c: setRole received the selected role (operator)", r.captured?.role === "operator");
  ok("7c: success reflects the stored member", r.outputText.includes("linus@example.com") && r.outputText.includes("Operator"));
  ok("7c: success states the stored fact plainly", r.outputText.includes("Role stored for"));
  ok("7c: success carries NO enforcement caveat", !r.outputText.includes("Subject to the engine enforcing"));
  ok("7c: with no invite token, the out-of-band hint renders", r.outputText.includes("out of band"));
  ok("7c: success does not throw", r.threw === false);
  ok("7c: success does not sign out", r.signedOut === false);
}

// 7c2. setRole SUCCESS carrying the minted inviteToken (finding grant-vs-invite-link-
// contradiction): the 200 body's token renders as the copyable /#/register?invite=
// enrolment link (the only artefact that passes the engine's registration gate), shown
// once and never persisted.
{
  const r = await driveInvite(
    { kind: "ok", entry: { email: "ada@example.com", role: "viewer", inviteToken: "tok-onb-1" } },
    { email: "ada@example.com" },
  );
  ok("7c2: the 200's inviteToken renders the enrolment link", r.outputText.includes("/#/register?invite=tok-onb-1"));
  ok("7c2: the link copy says it is shown once and not stored", r.outputText.includes("Shown once") && r.outputText.includes("does not store it"));
  ok("7c2: success with a token does not throw", r.threw === false);
}

  // B40: the team view POSTs /admin/roles, which the engine gates on roles.write (Owner AND access-admin), the
// same capability the main Access roles table uses. It must gate on roles.write, not the owner ladder: an
// access-admin must not be under-granted a control the engine allows, and a viewer must see the reason in
// customer language and no form.
{
  const aa: Caller = { method: "access", email: "aa@example.com", role: "access-admin", groups: [], isOnlyOwner: false };
  harness.resetSetupWorld(aa);
  const aaText = textOf(await harness.renderSetup("/setup/team"));
  ok("B40: an access-admin (holds roles.write) sees the team form", aaText.includes("Teammate email") && aaText.includes("Grant role"));
  ok("B40: the access-admin is not shown the gate reason", !aaText.includes("needs permission to manage roles and members"));
  harness.resetSetupWorld(harness.OWNER);
  ok("B40: an owner still sees the team form", textOf(await harness.renderSetup("/setup/team")).includes("Teammate email"));
  const viewer: Caller = { method: "access", email: "v@example.com", role: "viewer", groups: [], isOnlyOwner: false };
  harness.resetSetupWorld(viewer);
  const vText = textOf(await harness.renderSetup("/setup/team"));
  ok(
    "B40: a viewer sees the PERMISSION reason in customer language, not the raw id, and not the form (R-19)",
    vText.includes("needs permission to manage roles and members") && !vText.includes("roles.write") && !vText.includes("Teammate email"),
  );
}

// The team view offers only the roles the caller can grant (moved here from validate-roles-access-gating.ts with
// the retired first-run invite form). An Access admin holds roles.write and access.policy only, so the engine
// refuses Operator, Approver and Restore operator from them (requireGrantWithinAuthority) and Owner as well
// (requireNotOwnerEscalation). The expected lists are written out, not derived from ROLE_CAPABILITIES.
{
  // The kit names each tile group uid("role"), so the group's radios share a name that starts with "fb-role-".
  const tileValues = (root: unknown): (string | null)[] =>
    qsa(root, "input").filter((i) => (i.getAttribute("name") ?? "").startsWith("fb-role-")).map((i) => i.getAttribute("value"));
  const aa: Caller = { method: "access", email: "aa@example.com", role: "access-admin", groups: [], isOnlyOwner: false };
  harness.resetSetupWorld(aa);
  const aaRoot = await harness.renderSetup("/setup/team");
  ok("team roles: an access-admin is offered Viewer and Access admin only", JSON.stringify(tileValues(aaRoot)) === JSON.stringify(["viewer", "access-admin"]));
  ok("team roles: the access-admin's view names the withheld roles", textOf(aaRoot).includes("Not offered: Operator, Approver, Owner, Restore operator."));
  ok("team roles: and gives the Owner rule", textOf(aaRoot).includes("Only an Owner can grant Owner."));
  ok("team roles: no tile describes a withheld role", !textOf(aaRoot).includes("Runs and edits downpipes") && !textOf(aaRoot).includes("Full control, including keys and roles."));
  harness.resetSetupWorld(harness.OWNER);
  const ownerRoot = await harness.renderSetup("/setup/team");
  ok(
    "team roles, negative control: an Owner is offered all six",
    JSON.stringify(tileValues(ownerRoot)) === JSON.stringify(["viewer", "operator", "approver", "owner", "restore-operator", "access-admin"]),
  );
  ok("team roles, negative control: and no withheld note", !textOf(ownerRoot).includes("Not offered:"));
}

console.log("\n-- Finish: a first run the engine sealed but did not verify (VERIFY_AT_SEAL off) --");
// finishFor renders the REAL Finish view over an established demo estate whose first downpipe's latest ok run is
// the run this setup started (setup runs the estate's downpipes when it created none), with its seal verdict
// kept or removed. The engine attaches the verdict when the run completes, so a row without one is final. The
// downpipe's OLDER runs stay verified: they say nothing about this setup's run and must not stand in for it.
async function finishFor(verdict: boolean): Promise<string> {
  harness.resetSetupWorld(harness.OWNER, { kind: "default" });
  const w = harness.currentWorld();
  const dp = w.downpipes[0];
  const id = dp?.config.id ?? "";
  const entry = (w.historyByDownpipe[id] ?? []).find((e) => e.status === "ok");
  if (entry === undefined) return "";
  if (verdict) entry.sealVerification = { status: "verified", tier: "sampled-decrypt", sampled: 8, at: Date.now() };
  else delete entry.sealVerification;
  const { setupModel } = await import("../src/lib/setup-flow/model.ts");
  setupModel().update({ firstRun: { downpipeId: id, runId: entry.runId } });
  // resetSetupWorld clears the draft, not the facts: read this estate before the page renders from them.
  await setupModel().refresh("full");
  return textOf(await harness.renderSetup("/setup/finish"));
}
{
  const unv = await finishFor(false);
  ok("unverified: the view rendered a receipt", unv.includes("Your backup plan"));
  ok("unverified: the downpipe's older runs are verified (the population that could mislead)", (harness.currentWorld().historyByDownpipe[harness.currentWorld().downpipes[0]?.config.id ?? ""] ?? []).filter((e) => e.sealVerification?.status === "verified").length >= 1);
  ok("unverified: the headline says sealed, and not verified or protected", unv.includes("Your first backup is sealed") && !unv.includes("You are protected") && !unv.includes("sealed and verified"));
  ok("unverified: the first run row says verify-at-seal is off and offers a restore test", unv.includes("Sealed, seal not verified") && unv.includes("verify-at-seal switched off") && unv.includes("Run a restore test"));
  ok("unverified: the lede counts the first run as open", /items? below (is|are) still open/.test(unv));
  const ver = await finishFor(true);
  ok("verified (control): the same estate with a verdict reads sealed and verified", ver.includes("Sealed and verified") && !ver.includes("verify-at-seal switched off"));
}

console.log("\n-- An install set up before this setup page: /setup offers the first run and does not force it --");
// The demo estate with every integrity stamp removed: keys, a destination, the account connected and downpipes,
// but no downpipe the engine has stamped (not run, failed, or verify-at-seal off). The shell counts it set up
// (validate-setup-state.ts), so /setup opened by hand shows the steps done and offers the run as optional.
async function estateSetup(stamped: boolean): Promise<{ text: string; complete: boolean | undefined }> {
  harness.resetSetupWorld(harness.OWNER, { kind: "default" });
  if (!stamped) {
    for (const d of harness.currentWorld().downpipes) {
      delete d.lastIntegrityVerifiedAt;
      delete d.lastIntegrityVerifiedOk;
    }
  }
  const { setupModel } = await import("../src/lib/setup-flow/model.ts");
  const { setupViewOf } = await import("../src/lib/setup-state.ts");
  // A tab that pressed Start: a tab that did not run setup is sent to Overview (the next section).
  setupModel().update({ started: true });
  await setupModel().refresh("full");
  // "/setup" resumes on the first open question (validate-setup-state.ts checks resumeQ lands on "backup" for
  // this estate); the page's own route for that step is rendered here.
  const text = textOf(await harness.renderSetup(stamped ? "/setup/finish" : "/setup/backup/plan"));
  // The shell's view of this read alone: the model keeps a page-life latch (completeSeen), and earlier sections
  // of this validator read complete estates, so the latch is set aside to grade the rule itself.
  return { text, complete: setupViewOf({ ...setupModel().get(), completeSeen: false })?.complete };
}
{
  const u = await estateSetup(false);
  ok("unstamped estate: the shell counts setup complete", u.complete === true);
  ok("unstamped estate: the first backup view offers the run", u.text.includes("Run your first backup") && u.text.includes("Run now"));
  ok("unstamped estate: it says the run is optional and how to skip it", u.text.includes("This console is already set up, so this run is optional. To skip it, choose Leave setup."));
  ok("unstamped estate: Leave setup is on the page", u.text.includes("Leave setup"));
  ok("unstamped estate: nothing says protected", !u.text.includes("You are protected"));
  const st = await estateSetup(true);
  ok("CONTROL, stamped estate: setup reads complete by its sealed record, and no view offers an optional run", st.complete === true && !st.text.includes("this run is optional"));
}

console.log("\n-- A console set up elsewhere: /setup goes to Overview, the team invite and the engine check stand alone --");
// The populated demo estate (8 downpipes, a team, change approval on), opened in a tab with an empty draft: the
// case a direct URL, the "Invite your team" link after a new Owner registers, and a Viewer all reach. The draft
// holds none of the answers, so a plan or receipt line would be false (an empty Sources value, "Only you have
// access" over a team of five). The page must leave for Overview instead.
{
  const { setupModel } = await import("../src/lib/setup-flow/model.ts");
  const elsewhere = async (path: string, who: Caller = harness.OWNER, started = false): Promise<{ text: string; left: string[]; bar: boolean }> => {
    harness.resetSetupWorld(who, { kind: "default" });
    if (started) setupModel().update({ started: true });
    await setupModel().refresh("full");
    const root = await harness.renderSetup(path);
    await flushAsync(6);
    return { text: textOf(root), left: [...harness.leftSetup], bar: qs(root, ".fb-progress") !== null };
  };
  for (const path of ["/setup", "/setup/welcome", "/setup/keys", "/setup/finish", "/setup/finish/hardening", "/setup/approval"]) {
    const r = await elsewhere(path);
    ok(`set up elsewhere: ${path} goes to Overview`, r.left.includes("/"));
    ok(`set up elsewhere: ${path} shows no plan or receipt line`, !r.text.includes("Your backup plan") && !r.text.includes("Skip: only you have access.") && !r.text.includes("Not set"));
  }
  const viewer = await elsewhere("/setup", harness.VIEWER);
  ok("set up elsewhere: a Viewer opening /setup goes to Overview, not a receipt", viewer.left.includes("/") && !viewer.text.includes("Your backup plan"));
  const team = await elsewhere("/setup/team");
  ok("set up elsewhere: the team invite stays, with its form", team.left.length === 0 && team.text.includes("Invite your team") && team.text.includes("Teammate email") && team.text.includes("Grant role"));
  ok("set up elsewhere: the team invite's way out is the console, not a receipt this tab never made", team.text.includes("Open the console") && !team.text.includes("Back to the receipt"));
  ok("set up elsewhere: the team invite shows no setup progress", !team.bar);
  const check = await elsewhere("/setup/finish/check");
  ok("set up elsewhere: the engine's own check stays, read only", check.left.length === 0 && check.text.includes("What your engine reports"));
  ok("set up elsewhere: the check's way out is the console", check.text.includes("Open the console") && !check.text.includes("Back to the receipt"));
  const ran = await elsewhere("/setup/finish", harness.OWNER, true);
  ok("CONTROL, a tab that ran setup: /setup/finish keeps its receipt and stays", ran.left.length === 0 && ran.text.includes("Your backup plan"));
  const ranTeam = await elsewhere("/setup/team", harness.OWNER, true);
  ok("CONTROL, a tab that ran setup: the team invite goes back to the receipt", ranTeam.text.includes("Back to the receipt"));
}
{
  // A fresh engine, which the shell does not count set up. The model's latch (completeSeen) lasts the page's
  // life and the sections above read complete estates, so it is set aside here the way estateSetup grades the
  // rule: through the page's own test for it, on a snapshot with the latch cleared.
  const { setupModel } = await import("../src/lib/setup-flow/model.ts");
  const { setupDoneElsewhere } = await import("../src/screens/setup/b/flow.ts");
  harness.resetSetupWorld(harness.OWNER);
  await setupModel().refresh("full");
  ok("CONTROL, a fresh engine: an empty draft is not set up elsewhere, so /setup keeps setup", !setupDoneElsewhere({ ...setupModel().get(), completeSeen: false }, new Set()));
}

console.log("\n-- The hand-off and Finish name the rule each follows (F6, F8) --");
{
  const { setupModel } = await import("../src/lib/setup-flow/model.ts");
  harness.resetSetupWorld(harness.VIEWER);
  setupModel().update({ started: true });
  await setupModel().refresh("full");
  const hand = textOf(await harness.renderSetup("/setup/connect/token"));
  ok("hand-off: a Viewer on an Owner step is told the screens open when setup is done", hand.includes("An Owner sets up downpipes") && hand.includes("When setup is done, every screen opens for you."));
  ok("hand-off: it does not say the screens wait for a sealed backup", !hand.includes("When the first backup is sealed"));
  const fin = await finishFor(true);
  ok("finish: after a sealed first backup, Finish says Overview waits for a restore test", fin.includes("A sealed backup is not yet a proven restore. Overview lists it as not proven until a restore test passes."));
}

console.log("\n-- Protect's add-by-id sheet: the binding a name makes must fit the engine's 64 characters --");
// A resource added by its id attaches at Apply as SRC_<type>_<name>, and the engine's attach route refuses a
// binding longer than 64 characters (engine src/admin/attach-plan.ts BINDING_NAME). The sheet refuses it on the
// field, before Apply. Driven through the real sheet: open it from Protect, pick R2, type a name, press Add.
async function addR2ById(name: string): Promise<{ error: string; added: number }> {
  harness.resetSetupWorld(harness.OWNER);
  const { setupModel } = await import("../src/lib/setup-flow/model.ts");
  // A tab that pressed Start, as any tab on Protect has: the model's page-life latch was set by the complete
  // estates above, and a tab that did not run setup would be sent to Overview.
  setupModel().update({ started: true });
  const root = await harness.renderSetup("/setup/protect");
  qsa(root, "button").find((b) => textOf(b) === "Add a resource by its id")?.dispatchEvent(makeEvent({ type: "click", bubbles: true }));
  await flushAsync();
  const sheet = qsa(document.body as unknown as Parameters<typeof qsa>[0], "dialog").find((d) => textOf(d).includes("Add a resource by its id"));
  if (sheet === undefined) return { error: "(no sheet)", added: -1 };
  const r2 = qsa(sheet, "input").find((i) => i.getAttribute("value") === "r2");
  if (r2) {
    (r2 as unknown as { checked: boolean }).checked = true;
    r2.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  await flushAsync();
  const field = qs(sheet, "#setup-byid-r2-bucket");
  if (field) (field as unknown as { value: string }).value = name;
  qsa(sheet, "button").find((b) => textOf(b) === "Add to the list")?.dispatchEvent(makeEvent({ type: "click", bubbles: true }));
  await flushAsync(12);
  const err = qs(sheet, "#setup-byid-r2-bucket-e");
  const shown = err !== null && !(err as unknown as { hidden: boolean }).hidden;
  const added = setupModel().get().draft.manual.length;
  sheet.remove?.();
  return { error: shown && err ? textOf(err) : "", added };
}
{
  const long = await addR2ById("a".repeat(60));
  ok("add-by-id: a 60-character bucket name is refused on its field (SRC_R2_ makes 67 characters)", long.error.includes("longer than the 64 characters the engine accepts") && long.error.includes(`SRC_R2_${"a".repeat(60)}`));
  ok("add-by-id: and the refused resource does not join the list", long.added === 0);
  const fits = await addR2ById("media-uploads");
  ok("add-by-id (control): a name whose binding fits is added, with no field error", fits.added === 1 && fits.error === "");
}

console.log("\n-- Apply and First backup through the real page: install, attach, revoke, create and run --");
{
  // The questions before Apply are answered through the setup actions (validate-setup-actions.ts drives those),
  // so this section renders the two questions that follow them: Apply and First backup.
  const sf = await import("../src/lib/setup-flow/index.ts");
  const { setCeremony } = await import("../src/lib/store.ts");
  harness.resetSetupWorld(harness.OWNER);
  setCeremony(null);
  const m = sf.setupModel();
  await m.refresh("full");
  await sf.verifyToken("cf-read-only-demo");
  m.update({ provider: "r2", bucket: "setup-archive" });
  await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  m.update({ picks: ["kv:demo-acct-northwind:demo-kv-payments"], custody: "password-manager" });
  await sf.acknowledgePosture("break-glass-only");
  await sf.generateKeys();
  sf.confirmKeysSaved();
  ok("apply: the walk reached Apply with the keys in this tab", m.get().current === "apply" && sf.currentCeremony() !== null);

  // current is the page the harness shows now: a primary that moves on renders the next URL into a new <main>.
  const current = (): HTMLElement => qsa(document.body, "main").at(-1) as unknown as HTMLElement;
  const press = (root: HTMLElement): void => { qs(root, "form.fb-stage")?.dispatchEvent(makeEvent({ type: "submit", bubbles: true })); };
  const until = async (cond: () => boolean, ms = 8000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };

  const manualText = textOf(await harness.renderSetup("/setup/apply/manual"));
  ok("apply (own wrangler): the page lists each secret to set and the binding stanza for the pick", manualText.includes("npx wrangler secret put SIGNER_PRIVATE") && manualText.includes("npx wrangler secret put CONFIG_WRAP_KEY") && manualText.includes("SRC_KV_northwind_payments"));
  ok("apply (own wrangler): no operational secret under offline key only", !manualText.includes("OPERATIONAL_PRIVATE"));

  const apply = await harness.renderSetup("/setup/apply/token");
  const applyText = textOf(apply);
  ok("apply: the page asks for one deploy token, with the own-wrangler route beside it", qs(apply, "#setup-deploy-token") !== null && applyText.includes("Paste one deploy token") && applyText.includes("My own wrangler or CI"));
  press(apply);
  await flushAsync(6);
  const tokenErr = qs(apply, "#setup-deploy-token-e");
  ok("apply: Install and attach with no token says to paste it, and installs nothing", tokenErr !== null && textOf(tokenErr).includes("Paste the deploy token first") && !m.get().facts.keysReady);
  const tokenInput = qs(apply, "#setup-deploy-token") as unknown as { value: string };
  tokenInput.value = "deploy-token-demo";
  press(apply);
  const applied = await until(() => m.get().facts.keysReady && sf.bindingsToAttach().length === 0 && current() !== apply);
  ok("apply: the real primary installs the keys and attaches the pick", applied && m.get().draft.keysSent && sf.currentCeremony() === null);
  ok("apply: the token is cleared from the field the moment it is sent", tokenInput.value === "");
  ok("apply: the checklist showed the four stages it ran, attaching the pick by its name", ["Install your keys", "Engine loads the keys", "Attach northwind-payments", "Bindings go live"].every((l) => textOf(apply).includes(l)));
  await flushAsync(6);
  const revoke = current();
  ok("apply: the next question asks to revoke the deploy token", textOf(revoke).includes("I revoked the deploy token."));
  const tick = qsa(revoke, "input").find((i) => i.getAttribute("type") === "checkbox");
  if (tick) {
    (tick as unknown as { checked: boolean }).checked = true;
    tick.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  press(revoke);
  await until(() => m.get().draft.deployTokenRevoked && current() !== revoke, 3000);
  ok("apply: the revoke tick is recorded", m.get().draft.deployTokenRevoked);

  const plan = await harness.renderSetup("/setup/backup/plan");
  const planText = textOf(plan);
  const nameInput = qsa(plan, "input").find((i) => (i as unknown as { value: string }).value === "northwind-payments");
  ok("backup: the plan lists the pick as a downpipe, named after it, with the SRC_* binding beside it", nameInput !== undefined && planText.includes("SRC_KV_northwind_payments"));
  ok("backup: under offline key only the restore tests are attended, not scheduled", planText.includes("Restore tests: attended, with your key."));
  if (nameInput) {
    (nameInput as unknown as { value: string }).value = "Payments ledger";
    nameInput.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  press(plan);
  const created = await until(() => m.get().facts.downpipes.some((x) => x.config.name === "Payments ledger") && m.get().draft.firstRun !== null);
  ok("backup: Create and run now creates the downpipe under the typed name and starts its run", created);
  // On the setup surface the demo engine runs the first backup on the clock (demo-world.ts TIMED_RUN, about 7
  // seconds) and completes it with the seal verdict, as an engine with verify-at-seal on does.
  const sealed = await until(() => textOf(current()).includes("See your receipt"), 15_000);
  const runText = textOf(current());
  ok("backup: the run view logs each stage the engine reports, then the seal", sealed && ["Starting", "Reading your data", "Sealing the archive", "Sealed and verified"].every((l) => runText.includes(l)));
  ok("backup: the headline says sealed and verified only once the engine's verdict is in", runText.includes("Your first backup is sealed and verified") && m.get().protectedNow);
  ok("backup: First backup is done and Finish is current", m.get().current === "finish");

  // Finish over the same first run. With the statement recorded, the credentials the engine reported encrypted
  // and the token revoked, nothing is open: "You are protected". Each open item below keeps it off (review B2, B3).
  const finishText = async (): Promise<string> => textOf(await harness.renderSetup("/setup/finish"));
  const clean = await finishText();
  ok("finish: with nothing open the headline is You are protected, and the credentials row says the engine encrypted them", clean.includes("You are protected") && clean.includes("Encrypted by your engine when your keys were installed (2 credentials)."));
  const saved = m.get().draft;
  m.update({ rewrap: null });
  const noReport = await finishText();
  ok("finish: an install answer with no re-wrap report is an open item that names both credentials, and protected stays off", !noReport.includes("You are protected") && noReport.includes("Your engine did not report encrypting the read-only token and the destination key, saved before the keys.") && noReport.includes("I saved them again."));
  m.update({ rewrap: { ok: false, wrapped: 1, leftPlaintext: 1, failedClasses: ["discovery-token"] } });
  const partial = await finishText();
  ok("finish: a pass that left one credential unencrypted names its class, and protected stays off", !partial.includes("You are protected") && partial.includes("1 saved credential is not encrypted (discovery-token)."));
  m.update({ credentialsResaved: true });
  ok("finish: the user's re-save tick closes it", (await finishText()).includes("You saved them again after the keys"));
  m.update({ rewrap: saved.rewrap, credentialsResaved: false, postureRecorded: false, postureRefusal: "unknown or stale acceptance statement version (HTTP 400)" });
  const unrec = await finishText();
  ok("finish: a statement the engine did not record is open, with its reason and a way to record it, and protected stays off", !unrec.includes("You are protected") && unrec.includes("not recorded by your engine (unknown or stale acceptance statement version (HTTP 400))") && unrec.includes("Record it again"));
  m.update({ postureRecorded: true, postureRefusal: null, applyRoute: "self-deploy", keysSent: false });
  const selfDeploy = await finishText();
  ok("finish: on the self-deploy route the credentials saved before the keys are open, since no engine route encrypted them", !selfDeploy.includes("You are protected") && selfDeploy.includes("Your own wrangler set the wrap key, and that does not encrypt what was saved before it."));
  m.update({ applyRoute: saved.applyRoute, keysSent: true });
  ok("finish (control): restored, the headline is You are protected again", (await finishText()).includes("You are protected"));
}

console.log("\n-- A first backup that only partly sealed, then a new tab (customer-path F3 and F11), over the demo engine --");
{
  // Estate A of the 27 September customer-path test, on the demo engine: setup creates a D1 and an R2 downpipe and
  // runs both; the D1 run fails and the R2 run seals and verifies. Then a new signed-in tab in the same browser
  // opens "/" and "/setup". The walk to Apply uses the setup actions (validate-setup-actions.ts drives them);
  // First backup, the run view, the strip and Finish are the real code.
  const sf = await import("../src/lib/setup-flow/index.ts");
  const { setCeremony } = await import("../src/lib/store.ts");
  const { forceRefreshSetup } = await import("../src/lib/app-refresh.ts");
  const { renderSetupStrip } = await import("../src/shell/rail.ts");
  const { lastSetupView } = await import("../src/lib/setup-state.ts");
  const { applyWorldTransform } = await import("../src/lib/demo/demo-world.ts");
  const { injectRunFailure } = await import("../src/lib/demo/demo-state.ts");
  type SetupView = import("../src/lib/setup-state.ts").SetupView;
  const COPY = "downpipes.setup.first-backup";
  const store = (globalThis as unknown as { localStorage: Storage }).localStorage;
  const session = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
  const current = (): HTMLElement => qsa(document.body, "main").at(-1) as unknown as HTMLElement;
  const press = (root: HTMLElement): void => { qs(root, "form.fb-stage")?.dispatchEvent(makeEvent({ type: "submit", bubbles: true })); };
  const until = async (cond: () => boolean, ms = 15_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };
  const primaryLabel = (): string => { const l = qs(current(), ".fb-primary__label"); return l ? textOf(l) : ""; };
  const h1Text = (): string => { const e = qs(current(), ".fb-h1"); return e ? textOf(e) : ""; };
  // The shell's side: the view the strip is given (app-refresh.ts), and the strip it draws on Overview ("/").
  let shellView: SetupView | null | "unset" = "unset";
  const shell = { setSetup: (v: SetupView | null) => { shellView = v; } } as never;
  // `model` is the shell's reading of setup (lib/setup-read.ts); `view` is what app-refresh.ts hands the strip.
  const strip = async (): Promise<{ model: SetupView | null; view: SetupView | null; text: string; go: string; to: string[] }> => {
    shellView = "unset";
    await forceRefreshSetup(shell);
    const view = shellView === "unset" ? null : shellView;
    const model = lastSetupView();
    const el = document.createElement("div") as unknown as HTMLElement;
    const to: string[] = [];
    renderSetupStrip({ setup: view, setupStrip: el, activePattern: "/", caller: harness.OWNER, navigateFn: (r: string) => to.push(r) } as never);
    const goEl = qs(el, ".setup-strip__go");
    if (goEl) goEl.click();
    return { model, view, text: textOf(el), go: goEl ? textOf(goEl) : "", to };
  };

  harness.resetSetupWorld(harness.OWNER);
  setCeremony(null);
  const m = sf.setupModel();
  await m.refresh("full");
  await sf.verifyToken("cf-read-only-demo");
  m.update({ provider: "r2", bucket: "setup-archive" });
  await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  m.update({ picks: ["d1:demo-acct-northwind:ledger-db-0a1b2c", "r2:demo-acct-northwind:northwind-statements"], custody: "password-manager" });
  await sf.acknowledgePosture("break-glass-only");
  await sf.generateKeys();
  sf.confirmKeysSaved();
  const applied = await sf.applyWithDeployToken("deploy-token-demo");
  sf.markDeployTokenRevoked(true);
  ok("F3 walk: Apply installed the keys and attached the D1 and the R2", applied.ok && m.get().current === "backup");

  // First tab: Create and run now through the real page. The D1 run fails; the R2 run seals on the demo clock.
  press(await harness.renderSetup("/setup/backup/plan"));
  const startedBoth = await until(() => harness.currentWorld().downpipes.filter((d) => d.inFlight).length === 2, 8000);
  const w = harness.currentWorld();
  const d1 = w.downpipes.find((d) => d.config.source.type === "d1");
  const r2 = w.downpipes.find((d) => d.config.source.type === "r2");
  const d1Run = d1 ? (w.historyByDownpipe[d1.config.id] ?? [])[0] : undefined;
  if (d1 && d1Run) {
    d1Run.status = "failed";
    d1Run.error = "run failed";
    delete w.settleQueue[d1Run.runId];
    d1.inFlight = false;
  }
  ok("F3 walk: Create and run now created both downpipes and started both runs", startedBoth && d1 !== undefined && r2 !== undefined && d1Run !== undefined);
  const ended = await until(() => primaryLabel() === "Run it again", 15_000);
  ok("same tab: the run view ends on 'Your first backup did not finish' with Run it again", ended && h1Text() === "Your first backup did not finish");
  const lines = qsa(current(), ".fb-log__line");
  const sealLine = lines.find((l) => /sealed and verified/i.test(textOf(l)));
  const failLine = lines.find((l) => (l.getAttribute("class") ?? "").includes("fb-log__line--failed"));
  ok("same tab: the failure line names the D1 downpipe", failLine !== undefined && textOf(failLine).includes(`${d1?.config.name}: did not finish`));
  ok("F11, same tab: the seal line under the failure is not in the success tone", sealLine !== undefined && !(sealLine.getAttribute("class") ?? "").includes("fb-log__line--sealed"));
  ok("F11, same tab: the seal line names the downpipe that sealed, not '1 of 2' of the backup", sealLine !== undefined && textOf(sealLine).includes(`${r2?.config.name}: sealed and verified`) && !textOf(sealLine).includes("1 of 2"));
  ok("same tab: the model does not count First backup done, and nothing is protected", m.get().current === "backup" && !m.get().protectedNow);
  const finishSame = textOf(await harness.renderSetup("/setup/finish"));
  ok("same tab: Finish says the first backup is not sealed yet, never 'You are protected'", finishSame.includes("Your first backup is not sealed yet") && !finishSame.includes("You are protected"));
  ok("same tab: a copy of the setup draft is kept for a new tab", store.getItem(COPY) !== null);

  // The browser the customer-path test used had already shown the one-time completion strip.
  store.setItem("dp-setup-celebrated", "1");

  // CONTROL, a new tab in ANOTHER browser (no copy): it cannot tell setup's downpipes from later ones, so it keeps
  // the rule for a console set up elsewhere. Nothing locks, and /setup goes to Overview.
  const copy = store.getItem(COPY);
  store.removeItem(COPY);
  m.reset();
  session.clear();
  const other = await strip();
  ok("CONTROL, another browser: unlocked, and no first-backup strip", other.model?.complete === true && (other.model.firstBackupOpen ?? null) === null && !other.text.includes("not finished"));
  harness.leftSetup.length = 0;
  await harness.renderSetup("/setup");
  await flushAsync(6);
  ok("CONTROL, another browser: /setup goes to Overview", harness.leftSetup.includes("/"));
  if (copy !== null) store.setItem(COPY, copy);

  // A new signed-in tab in the same browser: its session storage is empty, localStorage is the browser's.
  m.reset();
  session.clear();
  harness.leftSetup.length = 0;
  const tab = await strip();
  ok("new tab: the shell is unlocked (setup is never forced)", tab.model?.complete === true);
  ok("new tab: Overview shows the strip, which says the first backup is not finished, 1 of 2 sealed", tab.text.includes("Your first backup is not finished: 1 of 2 downpipes sealed."));
  ok("new tab: the strip's Continue setup opens /setup", tab.go === "Continue setup" && tab.to.at(-1) === "/setup");
  await harness.renderSetup("/setup");
  const onRun = await until(() => primaryLabel() === "Run it again", 8000);
  ok("new tab: /setup does not go to Overview", !harness.leftSetup.includes("/"));
  ok("new tab: /setup resumes on the run view, which says the first backup did not finish and offers Run it again", onRun && h1Text() === "Your first backup did not finish");

  // Run it again: the D1 runs again on the demo clock and seals, the R2's run stands; the receipt and Finish follow.
  press(current());
  const resealed = await until(() => primaryLabel() === "See your receipt", 20_000);
  ok("new tab: Run it again runs the D1 again, and every downpipe is sealed and verified", resealed && h1Text() === "Your first backup is sealed and verified" && m.get().protectedNow);
  press(current());
  await until(() => textOf(current()).includes("Your backup plan"), 5000);
  const fin = textOf(current());
  ok("new tab: Finish shows the receipt, sealed and verified", (fin.includes("You are protected") || fin.includes("Your first backup is sealed and verified")) && fin.includes("Sealed and verified") && !fin.includes("not sealed yet"));
  ok("new tab: the receipt keeps this setup's answers (the destination bucket)", fin.includes("setup-archive"));
  ok("once every downpipe sealed, the copy is removed", store.getItem(COPY) === null);
  const after = await strip();
  ok("once every downpipe sealed, the shell has no unfinished first backup", after.model?.complete === true && after.model.firstBackupOpen === null && !after.text.includes("not finished"));

  // CONTROL: a failure after a first backup that fully sealed is normal operations, not setup.
  if (d1) applyWorldTransform((world) => injectRunFailure(world, d1.config.id));
  const opsView = await strip();
  ok("CONTROL, a later failure of the D1: no unfinished first backup, and no copy for a new tab", opsView.model?.complete === true && (opsView.model.firstBackupOpen ?? null) === null && store.getItem(COPY) === null);
  m.reset();
  session.clear();
  harness.leftSetup.length = 0;
  await harness.renderSetup("/setup");
  await flushAsync(6);
  ok("CONTROL, a later failure of the D1: a new tab's /setup goes to Overview, not back into setup", harness.leftSetup.includes("/"));
  store.removeItem("dp-setup-celebrated");
}

console.log("\n-- A first backup where the second downpipe did not start (a 500, then an answer with no run id), over the demo engine --");
{
  // Setup creates a D1 and an R2 downpipe and runs both. The engine starts the first and refuses the second (a
  // 500), or answers it with no run id (the engine skipped it, as when a run of it is still in flight). The first
  // run seals on the demo clock. The run view, the strip and Finish must agree that the first backup is not done,
  // the run view must name the downpipe that did not start, and "Run it again" must start it, after which all
  // three say it sealed.
  const sf = await import("../src/lib/setup-flow/index.ts");
  const { setCeremony } = await import("../src/lib/store.ts");
  const { forceRefreshSetup } = await import("../src/lib/app-refresh.ts");
  const { renderSetupStrip } = await import("../src/shell/rail.ts");
  type SetupView = import("../src/lib/setup-state.ts").SetupView;
  const current = (): HTMLElement => qsa(document.body, "main").at(-1) as unknown as HTMLElement;
  const press = (root: HTMLElement): void => { qs(root, "form.fb-stage")?.dispatchEvent(makeEvent({ type: "submit", bubbles: true })); };
  const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };
  const primaryLabel = (): string => { const l = qs(current(), ".fb-primary__label"); return l ? textOf(l) : ""; };
  const h1Text = (): string => { const e = qs(current(), ".fb-h1"); return e ? textOf(e) : ""; };
  const settled = (): boolean => primaryLabel() === "Run it again" || primaryLabel() === "See your receipt";
  // The strip the shell draws on Overview from its own read of setup (app-refresh.ts, shell/rail.ts).
  const stripText = async (): Promise<string> => {
    let view: SetupView | null = null;
    await forceRefreshSetup({ setSetup: (v: SetupView | null) => { view = v; } } as never);
    const el = document.createElement("div") as unknown as HTMLElement;
    renderSetupStrip({ setup: view, setupStrip: el, activePattern: "/", caller: harness.OWNER, navigateFn: () => {} } as never);
    return textOf(el);
  };
  const finishText = async (): Promise<string> => textOf(await harness.renderSetup("/setup/finish"));
  const OPEN = "Your first backup is not finished: 1 of 2 downpipes sealed.";

  for (const answer of ["500", "no run id"] as const) {
    const tag = `second trigger ${answer === "500" ? "refused (500)" : "answered with no run id"}`;
    harness.resetSetupWorld(harness.OWNER);
    setCeremony(null);
    const m = sf.setupModel();
    await m.refresh("full");
    await sf.verifyToken("cf-read-only-demo");
    m.update({ provider: "r2", bucket: "setup-archive" });
    await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
    m.update({ picks: ["d1:demo-acct-northwind:ledger-db-0a1b2c", "r2:demo-acct-northwind:northwind-statements"], custody: "password-manager" });
    await sf.acknowledgePosture("break-glass-only");
    await sf.generateKeys();
    sf.confirmKeysSaved();
    const applied = await sf.applyWithDeployToken("deploy-token-demo");
    sf.markDeployTokenRevoked(true);
    // The demo engine answers every trigger; the second trigger of Create and run now gets the fault instead.
    const demo = globalThis.fetch;
    const triggered: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url, "https://console.test");
      if (u.pathname === "/admin/trigger") {
        triggered.push(String((JSON.parse(String(init?.body ?? "{}")) as { id?: unknown }).id));
        if (triggered.length === 2) {
          return answer === "500"
            ? new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "content-type": "application/json" } })
            : new Response(JSON.stringify({ skipped: "a previous run is still in flight (coalesced)" }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      return demo(input, init);
    }) as typeof fetch;

    press(await harness.renderSetup("/setup/backup/plan"));
    const ended = await until(settled, 20_000);
    const missedId = triggered[1] ?? "";
    const missedName = harness.currentWorld().downpipes.find((x) => x.config.id === missedId)?.config.name ?? "(none)";
    const runText = textOf(current());
    ok(`${tag}: Create and run now created both downpipes and triggered both`, applied.ok && m.get().draft.createdDownpipeIds.length === 2 && triggered.length === 2 && ended);
    ok(`${tag}: the run view does not say sealed`, !/sealed/i.test(h1Text()) && h1Text() === "Your first backup did not finish");
    ok(`${tag}: the run view does not offer the receipt, it offers Run it again`, primaryLabel() === "Run it again" && !runText.includes("See your receipt"));
    const line = qsa(current(), ".fb-log__line--failed").map((l) => textOf(l)).find((t) => t.includes(`${missedName}: did not start`)) ?? "";
    ok(`${tag}: the run view names the downpipe that did not start`, line !== "");
    ok(
      `${tag}: with the reason`,
      answer === "500" ? line.includes("The request failed (trigger: 500).") : line.includes("The engine skipped the run. It may already be running."),
    );
    // Agreement, before Run it again: the model, the strip and Finish all say the first backup is not done.
    const viewOpen = h1Text() === "Your first backup did not finish" && primaryLabel() === "Run it again";
    const s1 = await stripText();
    const f1 = await finishText();
    ok(`${tag}: CONTROL, the model says First backup is not done and nothing is protected`, m.get().current === "backup" && !m.get().protectedNow);
    ok(`${tag}: CONTROL, the strip says 1 of 2 sealed`, s1.includes(OPEN));
    ok(`${tag}: CONTROL, Finish says not sealed yet`, f1.includes("Your first backup is not sealed yet"));
    ok(`${tag}: the run view, the strip and Finish agree: not done`, viewOpen && s1.includes(OPEN) && f1.includes("Your first backup is not sealed yet"));

    // Back on the run view (as "Continue setup" resumes it), Run it again starts only the downpipe that did not start.
    await harness.renderSetup("/setup/backup/run");
    const again = await until(() => primaryLabel() === "Run it again", 8000);
    ok(`${tag}: the run view, opened again, still offers Run it again and not the receipt`, again && h1Text() === "Your first backup did not finish");
    triggered.length = 0;
    press(current());
    const sealed = await until(() => primaryLabel() === "See your receipt", 20_000);
    ok(`${tag}: Run it again starts the downpipe that did not start, and only that one`, triggered.join(",") === missedId);
    ok(`${tag}: then every downpipe seals, and the run view says sealed and verified`, sealed && h1Text() === "Your first backup is sealed and verified");
    const viewSealed = sealed && h1Text() === "Your first backup is sealed and verified";
    const s2 = await stripText();
    const fin = await finishText();
    ok(`${tag}: the model says First backup is done and protected`, m.get().current === "finish" && m.get().protectedNow);
    ok(`${tag}: the strip has no unfinished first backup`, !s2.includes("not finished") && !s2.includes("not sealed"));
    ok(`${tag}: Finish says sealed and verified`, !fin.includes("not sealed yet") && fin.includes("Sealed and verified"));
    ok(`${tag}: the run view, the strip and Finish agree: sealed`, viewSealed && !s2.includes("not finished") && !fin.includes("not sealed yet"));
    globalThis.fetch = demo;
  }
}

console.log("\n-- The plan column before Connect on an engine that already holds keys (customer-path F11) --");
{
  // deploy.sh made the keys, so the engine holds them before the console first loads. Before Connect nothing is
  // picked and nothing is attached: Apply must not read ticked with "Keys and 0 bindings live".
  const { setupModel } = await import("../src/lib/setup-flow/model.ts");
  harness.resetSetupWorld(harness.OWNER);
  const w = harness.currentWorld();
  w.setupState = { ...w.setupState, keysReady: true, signerConfigured: true, breakGlassConfigured: true };
  setupModel().update({ started: true });
  await setupModel().refresh("full");
  const root = await harness.renderSetup("/setup/connect/token");
  const plan = qs(root, ".fb-plan");
  const planText = plan ? textOf(plan) : "";
  ok("F11: the plan column rendered, with Keys installed", planText.includes("Your backup plan") && planText.includes("Keys installed"));
  ok("F11: Apply does not read 'Keys and 0 bindings live' before anything is picked", !planText.includes("bindings live"));
  ok("F11: Apply says the keys are in and nothing is attached yet", planText.includes("Keys installed, picks not attached yet"));
  ok("F11: the model does not count Apply done", setupModel().get().steps.find((x) => x.id === "apply")?.status !== "done");
}

console.log(failures === 0 ? `\nSETUP SURFACE PASS (${checks} checks)` : `\n${failures} FAILURE(S)`);
verdictReached(failures, checks);
if (failures > 0) process.exitCode = 1;
