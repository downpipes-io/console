// Validates the setup model's ACTIONS (lib/setup-flow/actions.ts and actions-apply.ts) and the Finish data
// (receipt.ts) over the demo engine (setup-surface-harness.ts), the same engine the tour and the training
// course run on. validate-setup-state.ts holds the step model and validate-setup-surface.ts the rendered page;
// this file calls each action the way a question of the page calls it, and reads what the engine then holds.
//
// Coverage:
//   (1) the first-hour path, one action at a time, on a fresh account: Connect, Destination, Protect, Keys,
//       Apply, First backup, Finish. After each action the step model moves to the next step, and only then.
//   (2) Keys in the tab: the per-file download again, the recovery sheet, the possession proof (the saved key
//       matches, another key does not, a file that is not a key is refused) and the posture lock.
//   (3) The plan's refusals: a schedule, retention or restore test the posture cannot run, and no picks.
//   (4) The engine's refusals: the demo token sentinels (a refused token, a token that sees no account).
//   (5) The guards: a caller who is not an Owner, a tab with no engine, a session that ended (401), and an
//       engine fault (500). Each action refuses with its own kind and sends nothing it should not.
//   (6) The Finish receipt and the next steps, over each value the draft and the facts can hold.
//   (7) The operational posture with one pick of every kind: the operational key files, an attach of each
//       binding kind, the operator's own retention and storage prices, the configuration and token-read
//       downpipes, and Finish.
//   (8) Welcome's engine check and the keys-wait sentences.
//   (9) One engine call refused, queued or answered oddly while every other call succeeds: the action names
//       what happened and what the tab still holds.
//  (10) The leave guard while the tab holds keys the engine does not have.
//
// Run with node test/validate-setup-actions.ts.

import { installDomShim } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const harness = await import("./setup-surface-harness.ts");
const sf = await import("../src/lib/setup-flow/index.ts");
const { setCeremony, signOut, connect } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");
const { runKeyCeremony, identityFile } = await import("../src/keygen.ts");
const { parseIdentityFile } = await import("../src/lib/keydecap.ts");
const { probeEngine, accessSentence } = await import("../src/lib/setup-flow/engine-probe.ts");
const { keysWaitMessage } = await import("../src/lib/setup-flow/install.ts");
type SetupSnapshot = import("../src/lib/setup-flow/types.ts").SetupSnapshot;
type RunHistoryEntry = import("../src/api.ts").RunHistoryEntry;

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// Every 401 below leaves for sign-in on the next task. The count proves the hand-off fired.
let signedOut = 0;
function quietNav(): void {
  installNav({
    navigate: () => {},
    onUnauthorised: () => { signedOut++; },
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });
}
const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// freshWorld starts a new demo account for `who`, with no keys held in this tab and a model that has read it.
async function freshWorld(who = harness.OWNER): Promise<ReturnType<typeof sf.setupModel>> {
  harness.resetSetupWorld(who);
  quietNav();
  setCeremony(null);
  const m = sf.setupModel();
  m.reset();
  await m.refresh();
  return m;
}

// answerAll makes every /admin/* call answer `status`, so a guard or a fault path runs without the demo world.
function answerAll(status: number): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: status === 401 ? "unauthorised" : "the engine failed this request" }), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

// faultAt answers the calls to the given engine paths with the given status and body, and leaves every other
// call to the demo engine, so an action meets a refusal at exactly one step. It returns the undo.
function faultAt(paths: Record<string, [number, unknown]>): () => void {
  const demo = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const hit = paths[new URL(url, "https://console.test").pathname];
    if (hit) return new Response(JSON.stringify(hit[1]), { status: hit[0], headers: { "content-type": "application/json" } });
    return demo(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = demo; };
}
const REFUSED: unknown = { error: "the engine refused this call" };
const OWNER_QUEUED: unknown = { ownerActionQueued: true, id: "oa-setup-1" };
const CHANGE_QUEUED: unknown = { queued: true, id: "chg-setup-1" };

// atApply walks a fresh account to Apply under offline key only: token, destination, one pick, keys made and saved.
async function atApply(): Promise<ReturnType<typeof sf.setupModel>> {
  const am = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  am.update({ provider: "r2", bucket: "setup-archive" });
  await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  am.update({ picks: [PAYMENTS], custody: "password-manager" });
  await sf.acknowledgePosture("break-glass-only");
  await sf.generateKeys();
  sf.confirmKeysSaved();
  return am;
}

const PAYMENTS = "kv:demo-acct-northwind:demo-kv-payments";

console.log("-- (1) the first-hour path over a fresh demo account --");
const m = await freshWorld();
// The snapshot at Finish, before the later sections reset the world. Section (6) varies it.
let walked: SetupSnapshot = m.get();
{
  ok("a fresh account opens on Welcome", m.get().current === "welcome");
  sf.startSetup();
  ok("Start records that setup began", m.get().draft.started);

  const empty = await sf.verifyToken("   ");
  ok("Connect: an empty token is refused on its field, nothing is sent", !empty.ok && empty.error.kind === "validation" && empty.error.field === "token");
  const vt = await sf.verifyToken("cf-read-only-demo");
  ok("Connect: the engine verifies the token and sees one account", vt.ok && vt.data.accountsSeen === 1);
  ok("Connect: the engine's own account is read from the token", m.get().facts.engineAccountId === "demo-acct-northwind");
  ok("Connect is done: Destination is current", m.get().current === "destination");

  const choice = await sf.readAccountChoice();
  ok("the account choice names the one account, browsed and the engine's own", choice.ok && choice.data.seen.length === 1 && choice.data.selected[0] === "demo-acct-northwind" && choice.data.engineAccountId === "demo-acct-northwind");
  const none = await sf.chooseAccounts([], null);
  ok("choosing no account to browse is refused on its field", !none.ok && none.error.kind === "validation" && none.error.field === "accounts");
  const chosen = await sf.chooseAccounts(["demo-acct-northwind"], "demo-acct-northwind");
  ok("choosing the one account is saved", chosen.ok);
  const disc = await sf.refreshDiscovery();
  ok("discovery lists the account's resources", disc.ok && disc.data.resources > 0);

  m.update({ provider: "r2", bucket: "" });
  const noBucket = await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  ok("Destination: no bucket is refused on its field", !noBucket.ok && noBucket.error.field === "bucket");
  m.update({ bucket: "setup-archive" });
  const noKey = await sf.saveDestination({ accessKeyId: " ", secretAccessKey: "secret" });
  ok("Destination: no access key ID is refused on its field", !noKey.ok && noKey.error.field === "accessKeyId");
  const noSecret = await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "" });
  ok("Destination: no secret is refused on its field", !noSecret.ok && noSecret.error.field === "secretAccessKey");
  ok("Destination: nothing was stored by a refused save", m.get().facts.setup?.destination.configured === false);
  const saved = await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  ok("Destination: the engine stores the R2 destination in the engine's own account", saved.ok && m.get().facts.setup?.destination.bucket === "setup-archive" && m.get().facts.setup?.destination.kind === "r2");
  ok("Destination is done: Protect is current", m.get().current === "protect");

  m.update({ picks: [PAYMENTS] });
  ok("Protect is done with one pick: Keys is current", m.get().current === "keys");
  ok("the pick is a binding the engine has not attached yet", sf.bindingsToAttach().map((i) => i.binding).join(",") === "SRC_KV_northwind_payments");

  const early = await sf.generateKeys();
  ok("Keys: no keys are made before a posture is confirmed", !early.ok && early.error.field === "posture");
  const ack = await sf.acknowledgePosture("break-glass-only");
  ok("Keys: the engine records the offline-key-only posture and its statement hash", ack.ok && ack.data.recorded && ack.data.hashPrefix.startsWith("sha384:"));
  const noCustody = await sf.generateKeys();
  ok("Keys: no keys are made before a custody scheme is chosen", !noCustody.ok && noCustody.error.field === "custody");
  ok("the sheet records no custody before a scheme is chosen", sf.custodyForSheet() === undefined);
  m.update({ custody: "mofn-split", splitShares: 3, splitThreshold: 2 });
  const sheet = sf.custodyForSheet();
  ok("a split records N, the threshold and a blank sign-off per share", sheet?.scheme === "mofn-split" && sheet.n === 3 && sheet.threshold === 2 && sheet.signoffs.length === 3);
  m.update({ custody: "password-manager" });
  ok("a single-holder scheme records no sign-offs", sf.custodyForSheet()?.signoffs.length === 0);

  const plan0 = sf.selfDeployPlan();
  ok("the self-deploy plan shows the commands without values while no keys are held", plan0.secrets.every((x) => x.value === null) && plan0.stanzas.includes("SRC_KV_northwind_payments"));
  const keys = await sf.generateKeys();
  ok("Keys: the ceremony makes the offline-key-only files, with no operational key", keys.ok && keys.data.files.join(",") === "identity.key,recipient.pub,signer.pub,recovery-sheet.txt" && keys.data.fingerprints.operational === null && keys.data.refused.length === 0);
  ok("Keys are not done until the files are confirmed saved", m.get().current === "keys");
  const plan1 = sf.selfDeployPlan();
  ok("the self-deploy plan carries the values while the tab holds the keys, and no operational pair", plan1.secrets.every((x) => x.value !== null) && !plan1.secrets.some((x) => x.command.endsWith("OPERATIONAL_PRIVATE")));

  const other = await sf.acknowledgePosture("operational");
  ok("the posture cannot change under keys made for the other one", !other.ok && other.error.kind === "refused" && /other posture/.test(other.error.message));

  console.log("-- (2) keys in the tab: download again, the sheet, the possession proof --");
  for (const name of ["identity.key", "recipient.pub", "signer.pub", "recovery-sheet.txt"]) {
    const r = sf.redownloadFile(name);
    ok(`${name} can be downloaded again while the tab holds the keys`, r.ok);
  }
  const notAFile = sf.redownloadFile("notes.txt");
  ok("a name that is not a ceremony file is refused", !notAFile.ok && notAFile.error.kind === "validation" && /no file called notes\.txt/.test(notAFile.error.message));
  const noOp = sf.redownloadFile("operational.pub");
  ok("there is no operational.pub under offline key only", !noOp.ok && noOp.error.kind === "validation");
  // The sheet opens through a blob URL that is revoked 10 seconds later, for the new tab still reading it
  // (lib/file-delivery.ts openHtmlTab). No tab reads it here, so that one timer does not hold the process open.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const timer = realSetTimeout(fn, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }) as typeof setTimeout;
  let opened: ReturnType<typeof sf.openRecoverySheet>;
  try {
    opened = sf.openRecoverySheet();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  ok("the recovery sheet opens from the held keys", opened.ok && opened.data.opened);

  m.update({ refusedFiles: ["identity.key"] });
  const blocked = sf.confirmKeysSaved();
  ok("saved cannot be confirmed while a file the browser refused is not saved", !blocked.ok && blocked.error.field === "files" && /identity\.key/.test(blocked.error.message));
  sf.redownloadFile("identity.key");
  ok("a delivered file leaves the refused list", m.get().draft.refusedFiles.length === 0);

  const held = sf.currentCeremony();
  const notKey = await sf.verifyIdentityFile("this is not a key file");
  ok("a file that is not an identity.key is refused, and nothing is recorded", !notKey.ok && notKey.error.field === "identityFile" && m.get().draft.possession === null);
  const same = held ? await sf.verifyIdentityFile(identityFile(held.breakGlass)) : null;
  ok("the saved identity.key proves possession", same?.ok === true && same.data.match && m.get().draft.possession === "match");
  const stranger = await runKeyCeremony({ operational: false });
  const priv = parseIdentityFile(identityFile(stranger.breakGlass));
  const wrong = await sf.verifyRecoveredIdentity(priv);
  ok("a key from another ceremony does not match, and says so", wrong.ok && !wrong.data.match && m.get().draft.possession === "mismatch");
  ok("the proof zeroes the private it was given", priv.x25519Scalar.every((b) => b === 0) && priv.mlkemSeed.every((b) => b === 0));

  const confirmed = sf.confirmKeysSaved();
  ok("with every file saved, Keys is done: Apply is current", confirmed.ok && m.get().current === "apply");

  console.log("-- Apply, First backup, Finish --");
  const noToken = await sf.applyWithDeployToken("  ");
  ok("Apply: an empty deploy token is refused on its field", !noToken.ok && noToken.error.field === "token");
  const stages: string[] = [];
  const applied = await sf.applyWithDeployToken("deploy-token-demo", (stage, state) => stages.push(`${stage}:${state}`));
  ok("Apply installs the keys and attaches the pick", applied.ok && applied.data.keysInstalled && applied.data.attached.join(",") === "SRC_KV_northwind_payments");
  ok("Apply reports each stage in order", stages.join(" ") === "install-keys:start install-keys:done confirm-keys:start confirm-keys:done attach-sources:start attach-sources:done confirm-sources:start confirm-sources:start confirm-sources:done done:done");
  ok("the tab drops the keys once the engine holds them", sf.currentCeremony() === null && m.get().draft.keysSent);
  ok("the self-deploy plan has no values once the keys are dropped", sf.selfDeployPlan().secrets.every((x) => x.value === null));
  ok("the deploy token is recorded as used and not revoked", m.get().draft.deployTokenUsed && !m.get().draft.deployTokenRevoked);
  ok("Apply is done: First backup is current", m.get().current === "backup");
  const again: string[] = [];
  const rerun = await sf.applyWithDeployToken("deploy-token-demo", (stage, state) => again.push(`${stage}:${state}`));
  ok("Apply again installs nothing and attaches nothing (keys in, pick live)", rerun.ok && !rerun.data.keysInstalled && rerun.data.attached.length === 0 && again.includes("install-keys:skipped") && again.includes("attach-sources:skipped"));

  console.log("-- (3) the plan's refusals --");
  const d0 = m.get().draft;
  m.update({ schedule: "fortnightly" as never });
  const badSched = sf.planDownpipes();
  ok("an unknown schedule is refused on its field", !badSched.ok && badSched.error.field === "schedule");
  m.update({ schedule: d0.schedule, retention: "90-days" });
  const badRet = sf.planDownpipes();
  ok("a pruning retention is refused under offline key only, with the reason", !badRet.ok && badRet.error.field === "retention" && /pruning does not run/.test(badRet.error.message));
  m.update({ retention: "keep-all", restoreTest: "weekly" });
  const badRt = sf.planDownpipes();
  ok("a scheduled restore test is refused under offline key only", !badRt.ok && badRt.error.field === "restoreTest");
  m.update({ restoreTest: null, retentionCustom: { keepRuns: 10, enforce: true } });
  const badCustom = sf.planDownpipes();
  ok("an own retention is refused under offline key only", !badCustom.ok && badCustom.error.message === sf.CUSTOM_RETENTION_UNAVAILABLE);
  m.update({ retentionCustom: null, picks: [] });
  const noPicks = sf.planDownpipes();
  ok("a plan with no pick is refused on the picks", !noPicks.ok && noPicks.error.field === "picks");
  m.update({ picks: [PAYMENTS], names: { [PAYMENTS]: "Payments ledger" } });
  const plan = sf.planDownpipes();
  ok("the plan is one daily downpipe under the user's own name, restore tests off", plan.ok && plan.data.length === 1 && plan.data[0]!.dp.name === "Payments ledger" && plan.data[0]!.dp.cadenceSeconds === 86_400 && plan.data[0]!.dp.restoreTestCadenceSeconds === 0);

  const noneYet = await sf.runNow();
  ok("Run now before a downpipe exists is refused", !noneYet.ok && noneYet.error.kind === "validation");
  const created = await sf.createDownpipes();
  ok("First backup creates the downpipe on the engine", created.ok && created.data.created.length === 1 && created.data.queued === 0);
  const started = await sf.runNow();
  ok("Run now starts one run of the created downpipe and watches it", started.ok && started.data.length === 1 && m.get().draft.firstRun?.runId === started.data[0]!.runId);
  const seen: string[] = [];
  const watch = started.ok ? sf.watchRun(started.data[0]!.downpipeId, started.data[0]!.runId, (p) => seen.push(p.stage), { intervalMs: 5, maxMs: 20_000 }) : null;
  const end = watch ? await watch.done : null;
  ok("the watch ends on the ring's own ending: ok with no seal verdict reads unverified, never sealed", end?.stage === "unverified" && seen.at(-1) === "unverified" && !seen.includes("sealed"));
  ok("First backup is done: Finish is current, and the console cannot say protected", m.get().current === "finish" && !m.get().protectedNow && !sf.canSayProtected(m.get()));

  const receipt = sf.buildReceipt(m.get());
  const val = (lines: Array<{ label: string; value: string }>, label: string): string | undefined => lines.find((l) => l.label === label)?.value;
  ok("the receipt names the posture confirmed here and the engine's record of it", val(receipt.posture, "Key posture") === "Offline key only" && val(receipt.posture, "Recorded by the engine") === "Yes");
  ok("the receipt names the destination the engine holds", val(receipt.destination, "Bucket") === "setup-archive" && val(receipt.destination, "Account") === "The engine's account (demo-acct-northwind)" && val(receipt.destination, "Immutability") === "Off");
  ok("the receipt names the source as Cloudflare names it, with its kind and binding", receipt.sources.length === 1 && receipt.sources[0]!.name === "northwind-payments" && receipt.sources[0]!.type === "KV namespace" && receipt.sources[0]!.binding === "SRC_KV_northwind_payments");
  ok("the receipt says the deploy token is not confirmed revoked", /NOT confirmed revoked/.test(receipt.tokens[2]!.status));
  ok("the receipt reports the first run as sealed with the seal not verified, and its record count", val(receipt.firstRun, "Result") === "Sealed, seal not verified" && val(receipt.firstRun, "Records") !== undefined);
  sf.markDeployTokenRevoked(true);
  ok("a ticked revoke reads as confirmed on the receipt", /confirmed you revoked/.test(sf.buildReceipt(m.get()).tokens[2]!.status));

  const checksRead = await sf.readEngineChecks();
  ok("the engine check puts the keys first, present, then only rows the engine observed", checksRead.ok && checksRead.data[0]!.name === "Keys on your engine" && checksRead.data[0]!.ok && checksRead.data.slice(1).every((c) => c.word === "verified" || c.word === "failed"));

  const badEmail = await sf.grantRole("not an email", "viewer");
  ok("Team: an address that is not an email is refused on its field", !badEmail.ok && badEmail.error.field === "email");
  const granted = await sf.grantRole(" teammate@northwind.example ", "operator");
  ok("Team: the role is stored for the trimmed address and recorded in the draft", granted.ok && granted.data.email === "teammate@northwind.example" && m.get().draft.grants.some((g) => g.email === "teammate@northwind.example" && g.role === "operator"));
  sf.skipTeam();
  ok("skipping Team is recorded", m.get().draft.teamSkipped);
  const later = await sf.setRestoreApproval("later");
  ok("restore approval 'later' sends nothing and keeps the engine default", later.ok && later.data.requireRestoreApproval === null && m.get().draft.restoreApproval === "later");
  const solo = await sf.setRestoreApproval("solo");
  ok("restore approval 'solo' is stored on the engine as not required", solo.ok && solo.data.requireRestoreApproval === false);

  walked = m.get();
  const removed = await sf.removeToken();
  ok("the read-only token can be removed, and the engine then reads none", removed.ok && m.get().facts.tokenPresent === false);
}

console.log("-- (4) the engine's refusals: the demo token sentinels --");
{
  await freshWorld();
  const refused = await sf.verifyToken(sf.DEMO_TOKEN_SENTINELS.refused);
  ok("a token the engine refuses is shown as the engine wrote it, on the token field", !refused.ok && refused.error.kind === "refused" && refused.error.field === "token");
  ok("and Connect is not done", sf.setupModel().get().current !== "destination");
  const zero = await sf.verifyToken(sf.DEMO_TOKEN_SENTINELS.zeroAccounts);
  ok("a token that sees no account is a warning, not a success", !zero.ok && zero.error.kind === "zero-accounts");
}

console.log("-- (5) the guards: not an Owner, no engine, a session that ended, an engine fault --");
{
  await freshWorld(harness.VIEWER);
  const viewerCalls: Array<[string, () => Promise<{ ok: boolean; error?: { kind: string } }>]> = [
    ["verifyToken", () => sf.verifyToken("x")],
    ["removeToken", () => sf.removeToken()],
    ["chooseAccounts", () => sf.chooseAccounts(["a"], "a")],
    ["saveDestination", () => sf.saveDestination({ accessKeyId: "a", secretAccessKey: "b" })],
    ["acknowledgePosture", () => sf.acknowledgePosture("break-glass-only")],
    ["recordPostureAgain", () => sf.recordPostureAgain()],
    ["generateKeys", () => sf.generateKeys()],
    ["applyWithDeployToken", () => sf.applyWithDeployToken("t")],
    ["createDownpipes", () => sf.createDownpipes()],
    ["runNow", () => sf.runNow(["a"])],
    ["grantRole", () => sf.grantRole("a@b.example", "viewer")],
    ["setRestoreApproval", () => sf.setRestoreApproval("solo")],
  ];
  for (const [name, call] of viewerCalls) {
    const r = await call();
    ok(`a Viewer is refused ${name} as not an Owner`, !r.ok && r.error?.kind === "not-owner");
  }

  await freshWorld({ ...harness.OWNER, isOnlyOwner: true });
  const second = await sf.setRestoreApproval("second");
  ok("a sole Owner cannot require a second approver, and the reason names a second Owner", !second.ok && second.error.kind === "refused" && /only Owner/.test(second.error.message) && /second Owner first/.test(second.error.message) && !/Owner or Approver/.test(second.error.message));

  const dm = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  const destTry = async (d: Partial<SetupSnapshot["draft"]>, creds = { accessKeyId: "AKID", secretAccessKey: "secret" }): Promise<string | undefined> => {
    dm.reset();
    dm.update({ bucket: "archive", ...d });
    const r = await sf.saveDestination(creds);
    return r.ok ? "saved" : r.error.field;
  };
  ok("an R2 bucket in another account needs that account's ID", (await destTry({ provider: "r2", otherAccount: true, r2AccountId: " " })) === "r2AccountId");
  ok("an S3 endpoint that is not an https URL is refused on its field", (await destTry({ provider: "s3", endpoint: "http://s3.example.com" })) === "endpoint");
  ok("lock days that are not a whole number are refused on their field", (await destTry({ provider: "s3", endpoint: "https://s3.example.com", immutability: "governance", immutabilityDays: "ten" })) === "immutabilityDays");
  ok("a role ARN that is not an ARN is refused on its field", (await destTry({ provider: "s3", endpoint: "https://s3.example.com", roleArn: "not-an-arn" })) === "roleArn");
  ok("an Entra tenant with no client ID is refused on its field", (await destTry({ provider: "azure", endpoint: "https://acct.blob.core.windows.net", entraTenantId: "11111111-2222-3333-4444-555555555555" })) === "entraTenantId");
  ok("nothing was stored by any refused save", dm.get().facts.setup?.destination.configured === false);

  await freshWorld();
  const keysFirst = await sf.applyWithDeployToken("t");
  ok("Apply before Connect is refused: the engine needs its own account", !keysFirst.ok && keysFirst.error.kind === "refused" && /Connect your account first/.test(keysFirst.error.message));
  await sf.verifyToken("cf-read-only-demo");
  const noKeys = await sf.applyWithDeployToken("t");
  ok("Apply with no keys in the tab is refused: generate them first", !noKeys.ok && /Generate and save your keys first/.test(noKeys.error.message));
  ok("with no keys in the tab there is nothing to download, open, confirm or compare", !sf.redownloadFile("identity.key").ok && !sf.openRecoverySheet().ok && !sf.confirmKeysSaved().ok && !(await sf.verifyIdentityFile("x")).ok);

  signOut();
  const noEngine: Array<[string, () => Promise<{ ok: boolean; error?: { kind: string } }>]> = [
    ["verifyToken", () => sf.verifyToken("x")],
    ["removeToken", () => sf.removeToken()],
    ["readAccountChoice", () => sf.readAccountChoice()],
    ["chooseAccounts", () => sf.chooseAccounts(["a"], "a")],
    ["saveDestination", () => sf.saveDestination({ accessKeyId: "a", secretAccessKey: "b" })],
    ["applyWithDeployToken", () => sf.applyWithDeployToken("t")],
    ["createDownpipes", () => sf.createDownpipes()],
    ["runNow", () => sf.runNow(["a"])],
    ["grantRole", () => sf.grantRole("a@b.example", "viewer")],
    ["setRestoreApproval", () => sf.setRestoreApproval("solo")],
    ["readEngineChecks", () => sf.readEngineChecks()],
  ];
  for (const [name, call] of noEngine) {
    const r = await call();
    ok(`with no engine connected, ${name} says so`, !r.ok && r.error?.kind === "no-engine");
  }
  const orphanWatch = await sf.watchRun("a", "a-0001", () => {}).done;
  ok("with no engine connected, the run watch ends failed and says why", orphanWatch.stage === "failed" && /No engine/.test(orphanWatch.message ?? ""));

  // A session that ended: every engine call answers 401. Each action returns "unauthorised" and the tab leaves
  // for sign-in on the next task, after the caller has painted.
  await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  sf.setupModel().update({ picks: [PAYMENTS], bucket: "archive" });
  connect("https://console.test");
  answerAll(401);
  const before = signedOut;
  const expired: Array<[string, () => Promise<{ ok: boolean; error?: { kind: string } }>]> = [
    ["verifyToken", () => sf.verifyToken("x")],
    ["saveDestination", () => sf.saveDestination({ accessKeyId: "a", secretAccessKey: "b" })],
    ["removeToken", () => sf.removeToken()],
    ["readAccountChoice", () => sf.readAccountChoice()],
    ["chooseAccounts", () => sf.chooseAccounts(["a"], "a")],
    ["runNow", () => sf.runNow(["a"])],
    ["grantRole", () => sf.grantRole("a@b.example", "viewer")],
    ["setRestoreApproval", () => sf.setRestoreApproval("solo")],
    ["readEngineChecks", () => sf.readEngineChecks()],
  ];
  for (const [name, call] of expired) {
    const r = await call();
    ok(`a 401 on ${name} returns unauthorised`, !r.ok && r.error?.kind === "unauthorised");
  }
  const expiredWatch = await sf.watchRun("a", "a-0001", () => {}, { intervalMs: 5, maxMs: 1000 }).done;
  ok("a 401 during the run watch ends it failed: the session ended", expiredWatch.stage === "failed" && /session ended/.test(expiredWatch.message ?? ""));
  await nextTask();
  ok("each 401 handed the tab to sign-in on the next task", signedOut - before === expired.length + 1);

  // An engine fault: every call answers 500. The action refuses with the engine's reason and nothing is
  // recorded as done.
  answerAll(500);
  const faulted: Array<[string, () => Promise<{ ok: boolean; error?: { kind: string } }>]> = [
    ["verifyToken", () => sf.verifyToken("x")],
    ["saveDestination", () => sf.saveDestination({ accessKeyId: "a", secretAccessKey: "b" })],
    ["removeToken", () => sf.removeToken()],
    ["readAccountChoice", () => sf.readAccountChoice()],
    ["chooseAccounts", () => sf.chooseAccounts(["a"], "a")],
    ["runNow", () => sf.runNow(["a"])],
    ["grantRole", () => sf.grantRole("a@b.example", "viewer")],
    ["setRestoreApproval", () => sf.setRestoreApproval("solo")],
    ["readEngineChecks", () => sf.readEngineChecks()],
  ];
  for (const [name, call] of faulted) {
    const r = await call();
    ok(`an engine fault on ${name} is refused with a reason`, !r.ok && r.error?.kind === "refused");
  }
  const failedRead = await sf.refreshDiscovery();
  ok("a discovery read that fails is refused with the read error", !failedRead.ok && failedRead.error.kind === "refused");
}

console.log("-- (6) the run stages, the receipt and the next steps over each value --");
{
  const e = (over: Partial<RunHistoryEntry>): RunHistoryEntry => ({ runId: "r", index: 1, startedAt: "", status: "in-flight", ...over }) as RunHistoryEntry;
  ok("no entry yet reads starting", sf.runStageOf(null) === "starting");
  ok("an entry with nothing counted reads starting", sf.runStageOf(e({})) === "starting");
  ok("records counted reads reading", sf.runStageOf(e({ recordCount: 5 })) === "reading");
  ok("segments written reads sealing", sf.runStageOf(e({ recordCount: 5, segmentsWritten: 1 })) === "sealing");
  ok("archive bytes written reads sealing", sf.runStageOf(e({ archiveBytesWritten: 10 })) === "sealing");
  ok("ok with a verified seal reads sealed", sf.runStageOf(e({ status: "ok", sealVerification: { status: "verified" } as never })) === "sealed");
  ok("ok with a suspect seal reads failed, never sealed", sf.runStageOf(e({ status: "ok", sealVerification: { status: "suspect" } as never })) === "failed");
  ok("ok with no seal verdict reads unverified", sf.runStageOf(e({ status: "ok" })) === "unverified");
  ok("failed reads failed", sf.runStageOf(e({ status: "failed" })) === "failed");
  ok("abandoned reads failed", sf.runStageOf(e({ status: "abandoned" })) === "failed");

  const base = walked;
  const withD = (d: Partial<SetupSnapshot["draft"]>, f: Partial<SetupSnapshot["facts"]> = {}): SetupSnapshot => ({ ...base, draft: { ...base.draft, ...d }, facts: { ...base.facts, ...f } });
  const line = (lines: Array<{ label: string; value: string }>, label: string): string => lines.find((l) => l.label === label)?.value ?? "";

  const split = sf.buildReceipt(withD({ custody: "mofn-split", splitShares: 5, splitThreshold: 3, possession: "mismatch" }));
  ok("a split names its custodians and threshold", line(split.custody, "Custodians") === "5 (any 3 recover)");
  ok("a failed possession proof says the file did not match", line(split.custody, "Key possession checked") === "No, the file did not match");
  const unchosen = sf.buildReceipt(withD({ custody: null, posture: null, postureRecorded: null, possession: "match" }, { keysReady: false, enginePosture: null }));
  ok("no custody scheme reads Not chosen", line(unchosen.custody, "Custody scheme") === "Not chosen" && line(unchosen.custody, "Custodians") === "Not chosen");
  ok("no posture reads Not chosen, with no statement and no record", line(unchosen.posture, "Key posture") === "Not chosen" && line(unchosen.posture, "Statement") === "Not recorded here" && line(unchosen.posture, "Recorded by the engine") === "Not reported");
  ok("a matched possession proof says so", line(unchosen.custody, "Key possession checked") === "Yes, the saved file matches");
  const inherited = sf.buildReceipt(withD({ posture: null }, { keysReady: true, enginePosture: "operational" }));
  ok("keys the engine already held read as set in another tab or before this setup, with no statement recorded here", /set in another tab or before this setup/.test(line(inherited.posture, "Key posture")) && line(inherited.posture, "Statement") === "Not recorded here");
  const keysNoPosture = sf.buildReceipt(withD({ posture: null }, { keysReady: true, enginePosture: null }));
  ok("keys with no posture reported read as set in another tab or before this setup", line(keysNoPosture.posture, "Key posture") === "Set in another tab or before this setup");
  const unrecorded = sf.buildReceipt(withD({ postureRecorded: false, postureRefusal: "unknown or stale acceptance statement version (HTTP 400)" }));
  ok("a posture the engine did not record gives the engine's reason and says how to record it", /^No \(unknown or stale acceptance statement version \(HTTP 400\)\)\. Record it again at Finish, or re-affirm it on the Keys screen\.$/.test(line(unrecorded.posture, "Recorded by the engine")));
  const otherAcct = sf.buildReceipt(withD({ otherAccount: true, r2AccountId: "acct-2" }));
  ok("an R2 bucket in another account names that account", line(otherAcct.destination, "Account") === "Cloudflare account acct-2");
  const s3 = sf.buildReceipt(withD({ provider: "s3" }, { setup: { ...base.facts.setup!, destination: { ...base.facts.setup!.destination, kind: "s3" as never } } }));
  ok("a destination outside Cloudflare says so", line(s3.destination, "Account") === "Outside Cloudflare");
  const dest0 = base.facts.destinations[0];
  if (dest0) {
    const locked = sf.buildReceipt(withD({}, { destinations: [{ ...dest0, worm: { mode: "compliance", retentionDays: 30 }, objectLock: "enforced" } as never] }));
    ok("an enforced compliance lock names its mode, days and enforcement", line(locked.destination, "Immutability") === "Compliance, 30 days (enforced)");
    const gov = sf.buildReceipt(withD({}, { destinations: [{ ...dest0, worm: { mode: "governance", retentionDays: 7 } } as never] }));
    ok("a governance lock the engine has not verified says so", line(gov.destination, "Immutability") === "Governance, 7 days (not verified as enforced)");
  } else ok("the engine lists the saved destination", false);
  const custom = sf.buildReceipt(withD({ retentionCustom: { keepRuns: 30, keepDays: 90, enforce: false } }));
  ok("an own retention reads as its runs and days, report only", line(custom.schedule, "Retention") === "Keep 30 runs or 90 days, report only");
  ok("an own retention with deletion on says so", sf.customRetentionLabel({ keepDays: 14, enforce: true }) === "Keep 14 days, deletion on");
  const unknownSched = sf.buildReceipt(withD({ schedule: "never" as never, retention: "none" as never }));
  ok("a schedule or retention not in the list reads Not chosen", line(unknownSched.schedule, "Schedule") === "Not chosen" && line(unknownSched.schedule, "Retention") === "Not chosen");
  const selfDeploy = sf.buildReceipt(withD({ applyRoute: "self-deploy", deployTokenUsed: false }, { tokenPresent: false }));
  ok("a self-deploy says the deploy token was not used, and no read-only token is stored", selfDeploy.tokens[2]!.status === "Not used: you deployed yourself" && selfDeploy.tokens[0]!.status === "Not stored");
  const notUsed = sf.buildReceipt(withD({ applyRoute: "token", deployTokenUsed: false }));
  ok("a token route that never used the token says Not used", notUsed.tokens[2]!.status === "Not used");
  const noRun = sf.buildReceipt(withD({ firstRun: null }));
  ok("no first run reads Not started and Not reported", line(noRun.firstRun, "Run") === "Not started" && line(noRun.firstRun, "Result") === "Not reported" && noRun.firstRun.length === 2);
  const fr = base.draft.firstRun;
  if (fr) {
    const ring = base.facts.runs[fr.downpipeId] ?? [];
    const verified = sf.buildReceipt(withD({}, { runs: { ...base.facts.runs, [fr.downpipeId]: ring.map((x) => x.runId === fr.runId ? { ...x, sealVerification: { status: "verified" } as never } : x) } }));
    ok("a first run with a verified seal reads Sealed and verified", line(verified.firstRun, "Result") === "Sealed and verified");
    const failedRun = sf.buildReceipt(withD({}, { runs: { ...base.facts.runs, [fr.downpipeId]: ring.map((x) => x.runId === fr.runId ? { ...x, status: "failed" as const } : x) } }));
    ok("a failed first run reads as its status", line(failedRun.firstRun, "Result") === "failed");
  } else ok("the walk recorded its first run", false);
  const noSetup = sf.buildReceipt(withD({ provider: "r2" }, { setup: null, destinations: [] }));
  ok("with no setup-state read the destination falls back to the draft's bucket and says what was not reported", line(noSetup.destination, "Bucket") === base.draft.bucket && line(noSetup.destination, "Endpoint") === "Not reported");

  const hardenAll = sf.hardeningSuggestions(withD({ provider: "r2", otherAccount: false, immutability: "off", deployTokenUsed: true, deployTokenRevoked: false }));
  ok("hardening names a second destination, Object Lock, an attended verification and the token revoke", hardenAll.length === 4 && /Revoke the deploy token/.test(hardenAll[3]!));
  const hardenNone = sf.hardeningSuggestions(withD({ provider: "s3", immutability: "compliance", posture: "operational", deployTokenUsed: false }, { keysReady: true, enginePosture: "operational" }));
  ok("hardening names nothing that does not apply", hardenNone.length === 0);
  const next = sf.finishNextSteps(base);
  ok("Finish offers team, restore approval and hardening, each with what skipping it does", next.map((n) => n.id).join(",") === "team,approval,hardening" && next.every((n) => n.skipDefault.startsWith("Skip")));

  ok("R2 cannot lock objects; S3 can", sf.immutabilityChoices("r2").filter((c) => c.unavailable !== undefined).length === 2 && sf.immutabilityChoices("s3").every((c) => c.unavailable === undefined));
  ok("R2 prices from the R2 list and S3 from the S3 Standard list", sf.pricingDefaults("r2").storagePerGBMonth !== sf.pricingDefaults("s3").storagePerGBMonth && sf.pricingDefaults("s3").currency === "USD");
  ok("the deploy token adds D1 and Secrets Store only when a pick needs them", sf.deployTokenPermissions(new Set(["kv"])).length === 3 && sf.deployTokenPermissions(new Set(["d1", "secrets"])).length === 5);
  ok("the default restore test is weekly under operational and off otherwise", sf.defaultRestoreTest("operational") === "weekly" && sf.defaultRestoreTest("break-glass-only") === "off" && sf.defaultRestoreTest(null) === "off");
  ok("a sole identity sees the second-approver choice as unavailable", sf.restoreApprovalChoices(true).find((c) => c.id === "second")?.unavailable !== undefined && sf.restoreApprovalChoices(false).every((c) => c.unavailable === undefined));
  ok("a step route carries its sub-step, encoded", sf.stepRoute("keys", "saved files") === "/setup/keys/saved%20files" && sf.stepRoute("connect") === "/setup/connect");
  ok("the next main step follows the order and ends after Finish", sf.nextMainStep("connect") === "destination" && sf.nextMainStep("finish") === null);
  ok("an optional step has no next main step", sf.nextMainStep("team") === null);

  console.log("-- (6b) the plan's Key offline line once the ceremony is gone --");
  {
    const { planGroups } = await import("../src/screens/setup/b/plan.ts");
    const keysLine = (s: SetupSnapshot, id: string): { value: string; state: string } => {
      const line = planGroups(s, new Set(), null).find((g) => g.step === "keys")!.lines.find((l) => l.id === id)!;
      return { value: line.value, state: line.state };
    };
    const gone = { ...withD({ keysGenerated: true, keysSaved: true, keysSent: false, possession: null }, { keysReady: false }), runtime: { ceremonyHeld: false } };
    const filesGone = keysLine(gone, "files");
    const savedGone = keysLine(gone, "saved");
    ok("Key files reads Make them again once the ceremony is gone", filesGone.value === "Make them again");
    ok("Key offline does not confirm keys the tab no longer holds", savedGone.value === "Not confirmed" && savedGone.state === "unset");

    const held = { ...withD({ keysGenerated: true, keysSaved: true, keysSent: false, possession: null }, { keysReady: false }), runtime: { ceremonyHeld: true } };
    const savedHeld = keysLine(held, "saved");
    ok("Key offline still confirms while the tab holds the keys", savedHeld.value === "You confirmed" && savedHeld.state === "set");
  }
}

console.log("-- (7) the operational posture with one pick of every kind --");
{
  const om = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  // The destination is one of the account's own R2 buckets, so Protect must not offer it as a source.
  om.update({ provider: "r2", bucket: "northwind-backups", pricing: { storagePerGBMonth: 0.02, classAPerMillion: 5, classBPerMillion: 0.5, egressPerGB: 0 } });
  const saved = await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  ok("the destination saves with the operator's own storage prices", saved.ok);
  const all = om.get().facts.groups.flatMap((g) => g.resources);
  const dest = all.find((r) => r.kind === "r2" && r.name === "northwind-backups");
  ok("Protect marks the destination bucket unavailable as a source, and says why", dest?.unavailable === "This is your backup destination.");
  om.update({ manual: [{ kind: "kv", name: "audit-log", id: "0123456789abcdef0123456789abcdef" }] });
  await sf.refreshDiscovery();
  const manual = om.get().facts.groups.flatMap((g) => g.resources).find((r) => r.name === "audit-log");
  ok("a namespace added by ID is listed beside discovery's, with its binding", manual !== undefined && manual.binding === sf.manualBindingFor("kv", "audit-log") && manual.id === "0123456789abcdef0123456789abcdef");
  const pick = (kind: string, name?: string): string => all.find((r) => r.kind === kind && r.unavailable === undefined && (name === undefined || r.name === name))!.key;
  const picks = [pick("d1"), pick("kv", "northwind-sessions"), pick("r2", "northwind-statements"), pick("secrets"), all.find((r) => r.kind === "cf-config" && r.id === undefined)!.key, all.find((r) => r.kind === "cf-config" && r.id !== undefined)!.key, pick("workers"), pick("stream")];
  const streamKey = pick("stream");
  om.update({ picks, mediaContent: [streamKey] });

  const ack = await sf.acknowledgePosture("operational");
  ok("the operational posture is recorded", ack.ok && om.get().draft.posture === "operational");
  om.update({ custody: "encrypted-usb-paper" });
  const keys = await sf.generateKeys();
  ok("the operational ceremony adds operational.pub and an operational fingerprint", keys.ok && keys.data.files.includes("operational.pub") && keys.data.fingerprints.operational !== null);
  ok("operational.pub can be downloaded again", sf.redownloadFile("operational.pub").ok);
  const plan = sf.selfDeployPlan();
  ok("the self-deploy plan sets the operational pair too", plan.secrets.some((x) => x.command.endsWith("OPERATIONAL_PRIVATE") && x.value !== null) && plan.secrets.some((x) => x.command.endsWith("OPERATIONAL_PUBLIC")));
  ok("the plan has a wrangler stanza for each binding kind", ["d1_databases", "kv_namespaces", "r2_buckets", "secrets_store_secrets"].every((s) => plan.stanzas.includes(s)));
  sf.confirmKeysSaved();
  const applied = await sf.applyWithDeployToken("deploy-token-demo");
  ok("Apply attaches the D1, KV, R2 and Secrets Store picks", applied.ok && applied.data.attached.length === 4);
  ok("the attached picks read live, and First backup is current", om.get().current === "backup" && sf.bindingsToAttach().length === 0);
  const again = await sf.generateKeys();
  ok("no keys are made over keys the engine now holds", !again.ok && again.error.kind === "refused" && /already holds keys/.test(again.error.message));
  const reack = await sf.acknowledgePosture("break-glass-only");
  ok("the posture cannot be confirmed again over keys the engine holds", !reack.ok && /already holds keys/.test(reack.error.message));

  om.update({ restoreTest: "weekly", retentionCustom: { keepRuns: 30, keepDays: 90, enforce: true } });
  const planned = sf.planDownpipes();
  const byType = (type: string) => planned.ok ? planned.data.filter((p) => p.dp.source.type === type) : [];
  ok("the plan makes a downpipe for each binding pick, the configuration and each token read", planned.ok && ["d1", "kv", "r2", "secrets", "workers", "stream"].every((ty) => byType(ty).length === 1) && byType("cf-config").length >= 1);
  ok("the operator's own retention and a weekly restore test ride on every downpipe", planned.ok && planned.data.every((p) => p.dp.retention?.keepRuns === 30 && p.dp.retention?.keepDays === 90 && p.dp.retention?.enforce === true && p.dp.restoreTestCadenceSeconds === 604_800));
  ok("Stream copies its media only because it was ticked", (byType("stream")[0]?.dp.source as { includeContent?: boolean } | undefined)?.includeContent === true && (byType("workers")[0]?.dp.source as { includeContent?: boolean } | undefined)?.includeContent === undefined);
  om.update({ retentionCustom: { keepDays: 30, enforce: false } });
  const reportOnly = sf.planDownpipes();
  ok("an own retention without deletion sends no enforce flag", reportOnly.ok && reportOnly.data.every((p) => p.dp.retention?.keepDays === 30 && p.dp.retention?.enforce === undefined && p.dp.retention?.keepRuns === undefined));
  om.update({ retentionCustom: null, retention: "90-days" });
  const preset = sf.planDownpipes();
  ok("a pruning preset is accepted under the operational posture", preset.ok && preset.data.every((p) => p.dp.retention?.keepDays === 90 && p.dp.retention?.enforce === true));

  const created = await sf.createDownpipes();
  ok("First backup creates every planned downpipe in one bulk call", created.ok && preset.ok && created.data.created.length === preset.data.length && created.data.failures.length === 0);
  const started = await sf.runNow();
  ok("Run now starts a run of each created downpipe, and watches the first", started.ok && created.ok && started.data.length === created.data.created.length && om.get().draft.firstRun?.runId === started.data[0]!.runId);
  const end = started.ok ? await sf.watchRun(started.data[0]!.downpipeId, started.data[0]!.runId, () => {}, { intervalMs: 5, maxMs: 20_000 }).done : null;
  ok("the first run ends on the ring's own ending", end?.stage === "unverified" || end?.stage === "sealed");
  const receipt = sf.buildReceipt(om.get());
  const val = (lines: Array<{ label: string; value: string }>, label: string): string | undefined => lines.find((l) => l.label === label)?.value;
  ok("the receipt lists every pick and names the preset retention and the weekly restore test", receipt.sources.length === picks.length && val(receipt.schedule, "Retention") === "Keep 90 days" && val(receipt.schedule, "Restore test") === "Weekly");
  ok("the receipt names the custody scheme and one custodian", val(receipt.custody, "Custodians") === "1" && val(receipt.custody, "Custody scheme") !== "Not chosen");
  ok("hardening under the operational posture does not ask for an attended verification", !sf.hardeningSuggestions(om.get()).some((x) => /attended verification/.test(x)));

  // Finish acknowledges setup with the engine and goes to Overview.
  let went = "";
  installNav({ navigate: (to: string) => { went = to; }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
  await sf.finishSetup(false);
  ok("Finish lands on Overview", went === "/");

  // A reload drops the key material: the draft still says generated, the tab holds nothing, and Apply's reason says
  // to generate again.
  const rm = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  rm.update({ picks: [PAYMENTS], keysGenerated: true });
  const apply = rm.get().steps.find((s) => s.id === "apply");
  ok("after a reload Apply says to make the keys again, naming both causes", apply?.status === "locked" && /make your keys again \(leaving setup or reloading the page cleared them\)/.test(apply.reason ?? ""));
}

console.log("-- (8) Welcome's engine check and the keys-wait sentences --");
{
  await freshWorld();
  const up = await probeEngine(true);
  ok("the demo engine answers health and status, and reports its version", up.state === "ok" && up.version !== "");
  ok("a second check without Retry shares the first answer", (await probeEngine()) === up);
  // healthThen answers health with `health` and every other call with `status`, as an engine behind Access does:
  // health is not signed in, the rest is.
  const healthThen = (health: { ok: boolean }, status: number): void => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const body = new URL(url, "https://console.test").pathname === "/admin/health" ? health : { error: "refused" };
      return new Response(JSON.stringify(body), { status: body === health ? 200 : status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };
  healthThen({ ok: false }, 200);
  ok("an engine that answers health and says it is not healthy reads as reachable and not ok", (await probeEngine(true)).state === "engine-not-ok");
  healthThen({ ok: true }, 401);
  ok("health answered and then a 401 reads as signed out, not as unreachable", (await probeEngine(true)).state === "unauthorised");
  healthThen({ ok: true }, 403);
  const blocked = await probeEngine(true);
  ok("health answered and then a refusal reads as the Access signature, with the engine's message", blocked.state === "health-ok-status-failing" && blocked.message !== "");
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  const down = await probeEngine(true);
  ok("no answer at all reads as unreachable, with the browser's message", down.state === "unreachable" && /Failed to fetch/.test(down.message));
  ok("a verified sign-in needs no remark", accessSentence({ state: "verified" } as never) === null);
  ok("a recovery-code sign-in says to use the usual sign-in", /recovery code/.test(accessSentence({ state: "recovery-verified" } as never) ?? ""));
  ok("an admin-token sign-in says how to retire it", /admin token/.test(accessSentence({ state: "token-fallback" } as never) ?? ""));
  ok("an unverified session says to sign in again", /not verified/.test(accessSentence({ state: "unverified" } as never) ?? ""));
  ok("an unknown sign-in says the console could not confirm it", /could not confirm/.test(accessSentence({ state: "unknown" } as never) ?? ""));

  const wait = (lastFault: string | null) => keysWaitMessage({ ending: "exhausted", lastRead: null, lastFault } as never);
  ok("a keys wait with no engine binding says to restore the binding", /no engine binding/.test(wait("engine-binding-absent")));
  ok("a keys wait that failed in the console says nothing reached the engine", /inside this console/.test(wait("console-origin-fault")));
  ok("a keys wait the engine refused says to check its logs", /answers with an error/.test(wait("engine-not-ok")));
  ok("a keys wait the engine stopped answering says it restarts", /stopped answering/.test(wait("transport-error")));
  ok("a keys wait that ran out says the keys were sent, and not to make new ones", /has not reported them yet/.test(wait(null)) && /Do not make new keys/.test(wait(null)));
}

console.log("-- (9) one engine call refused, queued or answered oddly --");
{
  // Connect: a token change queued for a second owner stores nothing yet; an answer with no account list is
  // zero accounts, never a success.
  let undo: () => void;
  await freshWorld();
  undo = faultAt({ "/admin/sources/discovery-token": [202, OWNER_QUEUED] });
  const queuedToken = await sf.verifyToken("cf-read-only-demo");
  const queuedRemove = await sf.removeToken();
  undo();
  ok("a token queued for a second owner says so, and stores nothing yet", !queuedToken.ok && queuedToken.error.kind === "queued" && sf.setupModel().get().facts.tokenPresent !== true);
  ok("a token removal queued for a second owner says the token stays until then", !queuedRemove.ok && queuedRemove.error.kind === "queued" && /stays until then/.test(queuedRemove.error.message));
  undo = faultAt({ "/admin/sources/discovery-token": [200, {}] });
  const noList = await sf.verifyToken("cf-read-only-demo");
  undo();
  ok("a verified token whose answer lists no account is the zero-accounts warning", !noList.ok && noList.error.kind === "zero-accounts");
  undo = faultAt({ "/admin/sources/discovery-accounts": [202, OWNER_QUEUED], "/admin/sources/discovery-status": [200, {}] });
  const queuedChoice = await sf.chooseAccounts(["demo-acct-northwind"], "demo-acct-northwind");
  const bare = await sf.readAccountChoice();
  undo();
  ok("an account choice queued for a second owner changes nothing yet", !queuedChoice.ok && queuedChoice.error.kind === "queued");
  undo = faultAt({ "/admin/config/restore-approval-policy": [202, OWNER_QUEUED] });
  const queuedRestoreApproval = await sf.setRestoreApproval("solo");
  undo();
  ok("turning off restore approval queued for a second owner says so, and the draft choice is not stored", !queuedRestoreApproval.ok && queuedRestoreApproval.error.kind === "queued" && /stays on until then/.test(queuedRestoreApproval.error.message) && sf.setupModel().get().draft.restoreApproval === null);
  ok("a discovery status with no lists reads as nothing seen, nothing selected and no engine account", bare.ok && bare.data.seen.length === 0 && bare.data.selected.length === 0 && bare.data.engineAccountId === null);

  // Keys: a precheck that meets an ended session makes no keys.
  const km = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  km.update({ custody: "password-manager" });
  await sf.acknowledgePosture("break-glass-only");
  undo = faultAt({ "/admin/setup-state": [401, { error: "unauthorised" }] });
  const before = signedOut;
  const expiredKeys = await sf.generateKeys();
  undo();
  await nextTask();
  ok("a keys precheck that meets an ended session makes no keys and hands over to sign-in", !expiredKeys.ok && expiredKeys.error.kind === "unauthorised" && sf.currentCeremony() === null && signedOut === before + 1);
  const noCeremony = parseIdentityFile(identityFile((await runKeyCeremony({ operational: false })).breakGlass));
  const nothingHeld = await sf.verifyRecoveredIdentity(noCeremony);
  ok("a rebuilt key with no ceremony in the tab is refused, and its private is still zeroed", !nothingHeld.ok && noCeremony.x25519Scalar.every((b) => b === 0));

  // Apply: the install refused or the session ended keeps the keys in the tab; an attach refused after the
  // install says the keys are in.
  await atApply();
  undo = faultAt({ "/admin/keys/install": [401, { error: "unauthorised" }] });
  const expiredInstall = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("an install that meets an ended session installs nothing and keeps the keys in the tab", !expiredInstall.ok && expiredInstall.error.kind === "unauthorised" && /Nothing was installed/.test(expiredInstall.error.message) && sf.currentCeremony() !== null);
  undo = faultAt({ "/admin/keys/install": [500, REFUSED] });
  const refusedInstall = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("an install the engine refuses is shown on the token field, and the tab keeps the keys", !refusedInstall.ok && refusedInstall.error.kind === "refused" && refusedInstall.error.field === "token" && sf.currentCeremony() !== null && !sf.setupModel().get().draft.keysSent);
  undo = faultAt({ "/admin/sources/attach": [500, REFUSED] });
  const refusedAttach = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("an attach refused after the install says the keys are installed and the sources are not", !refusedAttach.ok && /^Your keys are installed\. The sources did not attach: /.test(refusedAttach.error.message) && sf.currentCeremony() === null);
  undo = faultAt({ "/admin/sources/attach": [202, OWNER_QUEUED] });
  const queuedAttach = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("an attach queued for a second owner says to paste a token again after the approval", !queuedAttach.ok && queuedAttach.error.kind === "queued");
  undo = faultAt({ "/admin/sources/attach": [401, { error: "unauthorised" }] });
  const expiredAttach = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("an attach that meets an ended session returns unauthorised", !expiredAttach.ok && expiredAttach.error.kind === "unauthorised");
  await sf.applyWithDeployToken("deploy-token-demo");

  // First backup: a create refused, queued or unauthorised; a run the engine skipped; a run that failed.
  const bm = sf.setupModel();
  bm.update({ picks: [] });
  const noPlan = await sf.createDownpipes();
  ok("creating with no pick returns the plan's own refusal", !noPlan.ok && noPlan.error.field === "picks");
  bm.update({ picks: [PAYMENTS] });
  undo = faultAt({ "/admin/downpipes": [500, REFUSED] });
  const refusedCreate = await sf.createDownpipes();
  undo();
  ok("a create the engine refuses creates nothing and says why", !refusedCreate.ok && refusedCreate.error.kind === "refused" && bm.get().facts.downpipes.length === 0);
  undo = faultAt({ "/admin/downpipes": [401, { error: "unauthorised" }] });
  const expiredCreate = await sf.createDownpipes();
  undo();
  ok("a create that meets an ended session returns unauthorised", !expiredCreate.ok && expiredCreate.error.kind === "unauthorised");
  undo = faultAt({ "/admin/downpipes": [202, CHANGE_QUEUED] });
  const queuedCreate = await sf.createDownpipes();
  undo();
  ok("a create queued for a second approver counts as queued, not created", queuedCreate.ok && queuedCreate.data.queued === 1 && queuedCreate.data.created.length === 0);
  bm.update({ createdDownpipeIds: [] });
  const made = await sf.createDownpipes();
  ok("with the engine answering, the create succeeds", made.ok && made.data.created.length === 1);
  undo = faultAt({ "/admin/trigger": [200, { skipped: "in-flight" }] });
  const skipped = await sf.runNow();
  undo();
  ok("a run the engine skipped is refused, and no first run is recorded", !skipped.ok && /skipped the run/.test(skipped.error.message) && bm.get().draft.firstRun === null);
  undo = faultAt({ "/admin/trigger": [500, REFUSED] });
  const refusedRun = await sf.runNow();
  undo();
  ok("a run the engine refuses says why", !refusedRun.ok && refusedRun.error.kind === "refused");
  undo = faultAt({ "/admin/history": [200, { entries: [{ runId: "r-fail", index: 1, startedAt: "", status: "failed", error: "The source could not be read." }] }] });
  const failedRun = await sf.watchRun("any", "r-fail", () => {}, { intervalMs: 5, maxMs: 2000 }).done;
  undo();
  ok("a run that failed ends the watch failed, with the engine's reason", failedRun.stage === "failed" && failedRun.message === "The source could not be read.");
  const stopped = sf.watchRun("any", "never-listed", () => {}, { intervalMs: 5, maxMs: 60_000 });
  stopped.stop();
  ok("a watch stopped by the page ends in its last stage, never sealed", (await stopped.done).stage === "starting");

  // Team and the engine check.
  undo = faultAt({ "/admin/roles": [202, CHANGE_QUEUED] });
  const queuedGrant = await sf.grantRole("second@northwind.example", "approver");
  undo();
  ok("a role grant queued for a second approver is recorded as queued", queuedGrant.ok && queuedGrant.data.queued && queuedGrant.data.inviteToken === undefined);
  undo = faultAt({ "/admin/preflight": [500, REFUSED] });
  const keysOnly = await sf.readEngineChecks();
  undo();
  ok("with no preflight answer the check shows the keys row only, never an invented pass", keysOnly.ok && keysOnly.data.length === 1);
  const items = [
    { id: "a", name: "Cron ticking", requires: "a cron trigger", required: true, status: "verified", evidence: "ticked" },
    { id: "b", name: "Queue bound", requires: "a queue", required: true, status: "unknown", evidence: "not observed" },
    { id: "c", name: "R2 reachable", requires: "an R2 binding", required: true, status: "failed", evidence: "403" },
  ];
  undo = faultAt({ "/admin/preflight": [200, { items }] });
  const ordered = await sf.readEngineChecks();
  undo();
  ok("the check lists failures first and leaves out what the engine has not observed", ordered.ok && ordered.data.map((c) => c.name).join(",") === "Keys on your engine,R2 reachable,Cron ticking" && ordered.data[1]!.detail === "Requires an R2 binding. Observed: 403");

  // Finish with the acknowledge refused still lands on Overview, and says so only when complete.
  let went = "";
  installNav({ navigate: (to: string) => { went = to; }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
  undo = faultAt({ "/admin/setup/acknowledge": [500, REFUSED] });
  await sf.finishSetup(true);
  undo();
  ok("Finish lands on Overview even when the acknowledge is refused", went === "/");

  // The engine check with no client connects to this origin; a status with no version says so; a whoami that
  // fails without a 401 degrades to a session that is present.
  signOut();
  undo = faultAt({ "/admin/status": [200, {}], "/admin/whoami": [500, REFUSED] });
  const probe = await probeEngine(true);
  undo();
  ok("with no engine client the check connects to this origin and reads it", probe.state === "ok");
  ok("a status with no version reads not reported", probe.state === "ok" && probe.version === "not reported");
  ok("a whoami that fails without a 401 reads as a session that is present", probe.state === "ok" && probe.verdict?.state === "session-present");

  // Discovery under the minimal token: every kind it cannot read says why.
  const mm = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  mm.update({ tokenScope: "minimal", manual: [{ kind: "secrets", name: "api-key", id: "store-1" }, { kind: "kv", name: "northwind_payments", id: "demo-kv-payments" }] });
  await sf.refreshDiscovery();
  const res = mm.get().facts.groups.flatMap((g) => g.resources);
  ok("under the minimal token the kinds it cannot read are listed as unavailable, with the reason", res.some((r) => r.unavailable !== undefined && r.kind !== "r2"));
  const manualSecret = res.find((r) => r.name === "api-key");
  ok("a secret added by its store ID carries the secret name for the attach", manualSecret?.secretName === "api-key" && manualSecret.id === "store-1");
  ok("a resource added by ID that discovery already lists is not listed twice", res.filter((r) => r.binding === sf.manualBindingFor("kv", "northwind_payments")).length === 1);

}

console.log("-- (10) the leave guard while the tab holds keys the engine does not have --");
{
  const { leaveGuardAllows, clearLeaveGuard } = await import("../src/lib/nav.ts");
  await atApply();
  const anchor = document.createElement("div");
  (document as unknown as { body: { appendChild: (n: unknown) => unknown } }).body.appendChild(anchor);
  const release = sf.guardUnbankedKeys(anchor);
  ok("moving between setup steps keeps the keys and passes", leaveGuardAllows("/setup/apply") && leaveGuardAllows("/setup") && leaveGuardAllows("/setup?from=keys"));
  // The Keys screen is outside setup (review M1): the palette's "Go to Keys" and the g-then-k shortcut asked
  // nothing, and a second move from there cleared the keys with no prompt.
  ok("the Keys screen is outside setup and asks first", !leaveGuardAllows("/keys") && !leaveGuardAllows("/keys/rotate"));
  ok("leaving setup with keys the engine does not have asks first", !leaveGuardAllows("/overview"));
  setCeremony(null);
  ok("with no keys in the tab, leaving passes", leaveGuardAllows("/overview"));
  release();
  const detached = document.createElement("div");
  sf.guardUnbankedKeys(detached);
  ok("a guard whose page was torn down clears itself and passes", leaveGuardAllows("/overview") && leaveGuardAllows("/overview"));
  clearLeaveGuard();
}

console.log("-- (11) the review fixes: posture, statement, re-wrap report, session purge, lost answers, tokens --");
{
  const { clearSessionData } = await import("../src/lib/store.ts");
  const { readRevokeReminder, clearRevokeReminder } = await import("../src/lib/setup-flow/revoke-reminder.ts");
  const { leaveGuardAllows, clearLeaveGuard } = await import("../src/lib/nav.ts");
  // rewriteAt passes one engine path to the demo engine and rewrites its JSON answer; throwAfter passes it and
  // then throws, as a lost answer does (the engine did the work, the browser never heard).
  const rewriteAt = (path: string, fn: (body: Record<string, unknown>) => Record<string, unknown>): (() => void) => {
    const demo = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const res = await demo(input, init);
      if (new URL(url, "https://console.test").pathname !== path) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(fn(body)), { status: res.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return () => { globalThis.fetch = demo; };
  };
  const onceAt = (path: string, first: () => Promise<Response>): (() => void) => {
    const demo = globalThis.fetch;
    let used = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!used && new URL(url, "https://console.test").pathname === path) {
        used = true;
        const res = await demo(input, init);
        void res;
        return first();
      }
      return demo(input, init);
    }) as typeof fetch;
    return () => { globalThis.fetch = demo; };
  };

  // B1: the keys follow the posture in the draft, which a reload keeps, and never a memory-only copy.
  const b1 = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  b1.update({ provider: "r2", bucket: "setup-archive" });
  await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  b1.update({ picks: [PAYMENTS], custody: "password-manager" });
  await sf.acknowledgePosture("operational");
  const gen = await sf.generateKeys();
  ok("B1: keys are made for the posture the draft confirms (operational, with its file)", gen.ok && sf.currentCeremony()?.operational !== null && gen.data.files.includes("operational.pub"));
  setCeremony(await runKeyCeremony({ operational: false }));
  b1.update({ keysGenerated: true, keysSaved: false });
  const wrongSaved = sf.confirmKeysSaved();
  ok("B1: Saved refuses keys made for the other posture", !wrongSaved.ok && wrongSaved.error.message === sf.POSTURE_MISMATCH && !b1.get().draft.keysSaved);
  b1.update({ keysSaved: true });
  const wrongApply = await sf.applyWithDeployToken("deploy-token-demo");
  ok("B1: Apply refuses to install keys made for the other posture, and sends nothing", !wrongApply.ok && wrongApply.error.message === sf.POSTURE_MISMATCH && !b1.get().draft.keysSent && !b1.get().facts.keysReady);
  setCeremony(null);

  // B2: a statement the engine refuses stays open with the engine's reason until it is recorded.
  const b2 = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  let undo = faultAt({ "/admin/keys/posture-acknowledgement": [400, { error: "unknown or stale acceptance statement version; reload the page and try again" }] });
  const refused = await sf.acknowledgePosture("break-glass-only");
  undo();
  ok("B2: a refused statement keeps the choice and carries the engine's reason", refused.ok && !refused.data.recorded && /unknown or stale acceptance statement version/.test(refused.data.reason ?? "") && b2.get().draft.postureRecorded === false && /HTTP 400/.test(b2.get().draft.postureRefusal ?? ""));
  const recorded = await sf.recordPostureAgain();
  ok("B2: recording it again records it and clears the reason", recorded.ok && recorded.data.recorded && b2.get().draft.postureRecorded === true && b2.get().draft.postureRefusal === null);
  undo = faultAt({ "/admin/keys/posture-acknowledgement": [401, { error: "unauthorised" }] });
  const before = signedOut;
  const expired = await sf.acknowledgePosture("break-glass-only");
  undo();
  await nextTask();
  ok("m2: a statement that meets an ended session hands over to sign-in, and records nothing", !expired.ok && expired.error.kind === "unauthorised" && signedOut === before + 1);

  // B3: the install's re-wrap report reaches the draft as the engine gave it, and its absence is not a pass.
  await atApply();
  const wrapped = await sf.applyWithDeployToken("deploy-token-demo");
  const rw = sf.setupModel().get().draft.rewrap;
  ok("B3: the demo install reports the token and the destination key encrypted", wrapped.ok && rw?.ok === true && rw.wrapped === 2 && rw.leftPlaintext === 0);
  await atApply();
  undo = rewriteAt("/admin/keys/install", (b) => { const { rewrap: _drop, ...rest } = b; return rest; });
  const silent = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("B3: an install answer with no re-wrap report leaves the report null, never a pass", silent.ok && sf.setupModel().get().draft.rewrap === null);
  await atApply();
  undo = rewriteAt("/admin/keys/install", (b) => ({ ...b, rewrap: { ok: false, wrapped: 1, alreadyWrapped: 0, leftPlaintext: 1, failedClasses: ["discovery-token"] } }));
  const partial = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  const prw = sf.setupModel().get().draft.rewrap;
  ok("B3: a pass that left a credential unencrypted is kept with its class", partial.ok && prw !== null && !prw.ok && prw.leftPlaintext === 1 && prw.failedClasses.join() === "discovery-token");

  // m3: an install whose answer is lost, although the engine took the keys, carries on once the engine says so.
  await atApply();
  undo = onceAt("/admin/keys/install", async () => { throw new TypeError("Failed to fetch"); });
  const lost = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("m3: a lost install answer, with the keys on the engine, carries on without sending them again", lost.ok && sf.currentCeremony() === null && sf.setupModel().get().draft.keysSent && !sf.setupModel().get().draft.keysInstallUnconfirmed);
  // m4: straight after the install an isolate of the old version can answer "no keys" for a few seconds. One such
  // answer is not taken as the truth: the keys are never sent a second time over the first set.
  await atApply();
  {
    const demo = globalThis.fetch;
    let installs = 0;
    let staleReads = 1;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const path = new URL(url, "https://console.test").pathname;
      if (path === "/admin/keys/install") {
        installs++;
        await demo(input, init);
        throw new TypeError("Failed to fetch");
      }
      if (path === "/admin/setup-state" && staleReads > 0) {
        staleReads--;
        const res = await demo(input, init);
        const body = (await res.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, keysReady: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return demo(input, init);
    }) as typeof fetch;
    const stale = await sf.applyWithDeployToken("deploy-token-demo");
    globalThis.fetch = demo;
    ok("m4: one stale 'no keys' read after a lost install answer does not send the keys again", stale.ok && installs === 1 && sf.currentCeremony() === null);
  }
  // CONTROL: a lost answer with no keys on the engine stops, keeps the keys and marks the install unconfirmed.
  await atApply();
  {
    const demo = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (new URL(url, "https://console.test").pathname === "/admin/keys/install") throw new TypeError("Failed to fetch");
      return demo(input, init);
    }) as typeof fetch;
    const lostNoKeys = await sf.applyWithDeployToken("deploy-token-demo");
    globalThis.fetch = demo;
    const dd = sf.setupModel().get().draft;
    ok("m3 CONTROL: a lost answer with no keys on the engine stops, keeps the keys, and marks the install unconfirmed", !lostNoKeys.ok && sf.currentCeremony() !== null && dd.keysInstallUnconfirmed && !dd.keysSent);
  }

  // Live proof 2: an attach refused straight after the install is tried once more, with the same token.
  await atApply();
  undo = onceAt("/admin/sources/attach", async () => new Response(JSON.stringify({ error: "scheduler/seal Durable Objects are not both present" }), { status: 409, headers: { "content-type": "application/json" } }));
  const retried = await sf.applyWithDeployToken("deploy-token-demo");
  undo();
  ok("live 2: an attach refused once after the install succeeds on its one retry", retried.ok && retried.data.attached.length === 1);

  // M4: each press whose token reached the engine is counted, outside the tab too, until the revoke is confirmed.
  clearRevokeReminder();
  await atApply();
  undo = faultAt({ "/admin/sources/attach": [500, REFUSED] });
  await sf.applyWithDeployToken("deploy-token-one");
  undo();
  const second = await sf.applyWithDeployToken("deploy-token-two");
  const d4 = sf.setupModel().get().draft;
  ok("M4: two presses that reached the engine count two tokens, in the draft and outside the tab", second.ok && d4.deployTokenUses === 2 && readRevokeReminder()?.tokens === 2);
  // Overview draws the reminder from the record outside the tab, and its own tick clears it.
  const { revokeReminderBanner } = await import("../src/screens/overview/setup-card.ts");
  const banner = revokeReminderBanner();
  const bannerText = banner?.textContent ?? "";
  ok("M4: Overview asks for each of the two tokens, with the tick beside it", /You pasted a deploy token 2 times in setup\. Revoke each token you made/.test(bannerText) && bannerText.includes("I revoked each of them."));
  const box = banner?.querySelector("#overview-revoke-tick") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void } | null;
  if (box) {
    box.checked = true;
    const { makeEvent } = await import("./dom-shim-core.ts");
    box.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  ok("M4: Overview's tick clears the reminder and says so", readRevokeReminder() === null && (banner?.textContent ?? "").includes("You confirmed you revoked each deploy token."));
  ok("M4 CONTROL: with no reminder stored, Overview shows none", revokeReminderBanner() === null);
  // The demo keeps no record outside the tab; this tab's own setup draft still reminds, once a token was used.
  sf.setupModel().update({ deployTokenUsed: true, deployTokenRevoked: false, deployTokenUses: 1 });
  ok("M4: with only this tab's draft, Overview still asks for the one token", readRevokeReminder() === null && (revokeReminderBanner()?.textContent ?? "").includes("Revoke the deploy token you used in setup"));
  sf.setupModel().update({ deployTokenRevoked: true });
  const { noteDeployTokenUsed } = await import("../src/lib/setup-flow/revoke-reminder.ts");
  noteDeployTokenUsed();
  ok("M4: a token use is recorded outside the tab", readRevokeReminder()?.tokens === 1);
  sf.markDeployTokenRevoked(true);
  ok("M4: confirming the revoke in setup clears the reminder outside the tab", readRevokeReminder() === null);

  // M1: leaving setup for the Keys screen with keys in the tab asks, and "Leave anyway" clears them at once.
  await atApply();
  const anchor = document.createElement("div");
  (document as unknown as { body: { appendChild: (n: unknown) => unknown } }).body.appendChild(anchor);
  sf.guardUnbankedKeys(anchor);
  ok("M1: the palette's Go to Keys asks first", !leaveGuardAllows("/keys"));
  const dlg = document.querySelector<HTMLElement>("[role=dialog], dialog");
  const leave = [...(dlg?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "Leave anyway");
  leave?.click();
  await nextTask();
  ok("M1: Leave anyway clears the keys from the tab", leave !== undefined && sf.currentCeremony() === null);
  clearLeaveGuard();

  // M2: signing out purges the setup draft, its storage and the model, so the next person starts from nothing.
  const m2 = await freshWorld();
  await sf.verifyToken("cf-read-only-demo");
  await sf.acknowledgePosture("break-glass-only");
  const keys = (): string[] => { const out: string[] = []; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k !== null) out.push(k); } return out; };
  ok("M2: the setup draft is stored in the draft family", keys().includes("dp-draft:setup-v1"));
  clearSessionData();
  ok("M2: the session purge removes it", !keys().some((k) => k.includes("setup")));
  ok("M2: and resets the model: no acknowledged statement, no engine facts", !m2.get().draft.postureAcknowledged && m2.get().draft.posture === null && m2.get().facts.readAt === 0 && m2.get().facts.fullReadAt === 0);
  connect("https://console.test");

  // Live proof 3: the shell's read lists no resources, so it never counts as the setup page's full read.
  const m3 = await freshWorld();
  m3.clearSession();
  await m3.refresh("shell");
  ok("live 3: a shell read leaves the full read undone", m3.get().facts.readAt > 0 && m3.get().facts.fullReadAt === 0);
  await m3.refresh("full");
  ok("live 3: a full read records itself", m3.get().facts.fullReadAt > 0);
}

console.log("-- (12) a discovery listing that repeats a resource (an engine paging fault) collapses to one row --");
{
  const m = await freshWorld();
  const acctId = "n1-dup-account";
  // The same resource, five times over, one per kind: the shape a paging fault hands the console when a
  // listing page repeats (the console cannot tell that apart from five real, identically-named resources
  // by name alone, which is why identity, not a re-fetch, is what has to carry the fix).
  const kvItem = { id: "kv-1", name: "n1-kv" };
  const r2Item = { name: "n1-r2" };
  const d1Item = { id: "d1-1", name: "n1-d1" };
  const secretItem = { storeId: "store-1", name: "n1-secret" };
  harness.currentWorld().sourceDiscovery = {
    bound: { kv: [], r2: [], d1: [], secrets: [] },
    tokenPresent: true,
    engineAccountId: acctId,
    accounts: [
      {
        accountId: acctId,
        accountName: "N1 duplicate test",
        kv: [kvItem, kvItem, kvItem, kvItem, kvItem],
        r2: [r2Item, r2Item, r2Item, r2Item, r2Item],
        d1: [d1Item, d1Item, d1Item, d1Item, d1Item],
        secrets: [secretItem, secretItem, secretItem, secretItem, secretItem],
        zones: [],
        errors: [],
      },
    ],
  };
  await m.refresh("full");
  const groups = m.get().facts.groups;
  const countOf = (kind: string): number => groups.find((g) => g.kind === kind)?.resources.length ?? -1;
  ok("N1: a listing that repeats an R2 bucket five times shows it once", countOf("r2") === 1);
  ok("N1: the same fault on a KV namespace shows it once", countOf("kv") === 1);
  ok("N1: the same fault on a D1 database shows it once", countOf("d1") === 1);
  ok("N1: the same fault on a Secrets Store secret shows it once", countOf("secrets") === 1);

  // Only the four kinds this account discovered: the account-wide cf-config/Workers/Stream/Images rows
  // are always offered (as "not offered by this engine") and are not part of what this fault duplicated.
  const discoveredKinds = new Set(["d1", "kv", "r2", "secrets"]);
  const allResources = groups.filter((g) => discoveredKinds.has(g.kind)).flatMap((g) => g.resources);
  ok("N1: one row per resource, four kinds discovered", allResources.length === 4);
  m.update({ picks: allResources.map((r) => r.key) });
  const picked = sf.pickedResources(m.get());
  ok("N1: a pick selects exactly one row per resource, not five", picked.length === 4 && new Set(picked.map((r) => r.key)).size === 4);

  const { sourcesValue, tokenValue } = await import("../src/screens/setup/b/plan.ts");
  ok("N1: the plan's resource counts equal the distinct count, one of each kind", sourcesValue(m.get()) === "1 D1, 1 KV, 1 R2, 1 secret");
  // tokenValue's total is every discoverable resource, including the always-offered token-read rows
  // (cf-config, Workers, Stream, Images) this engine does not support: 4 duplicated-then-collapsed plus
  // those 4, never 5 times either half.
  ok("N1: the plan's total also reads the distinct count", tokenValue(m.get()).endsWith("8 resources"));

  const bindings = sf.bindingsToAttach().map((i) => i.binding);
  ok("N1: the attach request lists each binding once", bindings.length === 4 && new Set(bindings).size === 4);
}

console.log(failures === 0 ? `\nSETUP ACTIONS PASS (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks} checks`);
verdictReached(failures, checks);
if (failures > 0) process.exitCode = 1;
