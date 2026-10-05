// The faked engine's guided-first-run write handlers (steps 3 to 5 of the setup walk): the
// discovery-token verify, the binding attach/detach, and the downpipe create (see demo-routes-write.ts
// for the rest of the write handlers). Each mutates the world so the screens and the derived setup-state
// fact (demo-routes-read.ts deriveSetupStateView) reflect the learner's own action the moment it lands,
// which is what lets the training walk grade by world state.

import type { AttachSourceInput, BulkDownpipeItemResult, BulkDownpipeResponse, Downpipe, DownpipeState, PendingChangeBody, RoleEntry, SourceSpec } from "../api/types.ts";
import { DEMO_ACCT_ID, demoDiscoveredAccount, ORG_OWNER_EMAIL } from "./demo-seed.ts";
import { demoEpoch, demoIso, json, queuedChange, readBody, world } from "./demo-world.ts";

// writeDiscoveryToken models POST /admin/sources/discovery-token (setDiscoveryToken): the engine verifies
// the pasted token LIVE against Cloudflare before storing, so the demo branches on two training sentinels
// to teach the real failure paths the screen's copy is built around, and treats every other value as a
// verified token (the training replica's documented "paste anything" happy path). The success path mutates
// the world: the token reads as present and the discovered account appears, so the Sources screens and the
// derived setup-state fact reflect the connect the moment it lands. The pasted value itself is never
// stored or echoed; it is compared against the two sentinel spellings and discarded.
export function writeDiscoveryToken(init?: RequestInit): Response {
  const { token } = readBody<{ token?: string | null }>(init);
  if (token === "training-bad-token") {
    // The refused-token path: Cloudflare answered 401, so nothing is stored. The words are the engine's own
    // for that case (engine src/admin/router-discovery.ts POST /sources/discovery-token: resolveDiscoveryAccounts
    // records "accounts: HTTP 401", and the route answers 400 "token verification failed: <why>. Create a
    // READ-ONLY token, ..."), so the course shows the refusal a real engine sends.
    return json({ error: "token verification failed: accounts: HTTP 401. Create a READ-ONLY token, the \"Read all resources\" template is simplest and also covers Cloudflare configuration backup (zones, DNS, WAF/rulesets); at minimum it needs Account Settings read plus Workers KV Storage, Workers R2 Storage, D1 and Secrets Store read." }, { status: 400 });
  }
  if (token === null) {
    world.sourceDiscovery = { ...world.sourceDiscovery, tokenPresent: false, accounts: [] };
    return json({ present: false });
  }
  if (token === "training-empty-scopes") {
    // Verified but sees NO accounts, stored with a warning. A real engine never answers this way: it refuses a
    // token that sees no account with a 400 (router-discovery.ts). The branch stays so the console's defensive
    // zero-accounts path (setup-flow actions.ts verifyToken, sources token-entry.ts) has a fixture; the course
    // does not teach it.
    world.sourceDiscovery = { ...world.sourceDiscovery, tokenPresent: true, accounts: [] };
    return json({ present: true, setAt: demoEpoch(0), setBy: ORG_OWNER_EMAIL, accountsSeen: [], selected: [], engineAccountId: null });
  }
  // The account also lists an empty archive bucket, so the setup surface's destination can be picked from the
  // discovered list without reusing a bucket that is itself a backup source.
  const acct = demoDiscoveredAccount();
  acct.r2 = [{ name: "northwind-backups" }, ...acct.r2];
  world.sourceDiscovery = { ...world.sourceDiscovery, tokenPresent: true, engineAccountId: DEMO_ACCT_ID, accounts: [acct] };
  return json({ present: true, setAt: demoEpoch(0), setBy: ORG_OWNER_EMAIL, accountsSeen: [{ id: DEMO_ACCT_ID, name: "Northwind Trading Co" }], selected: [DEMO_ACCT_ID], engineAccountId: DEMO_ACCT_ID });
}

// writeAttachSources models POST /admin/sources/attach (changeBindings): attach and/or detach source
// binding stanzas in one atomic write. The demo applies the result to the world's bound tier so a fresh
// attach is visible on the Sources screen, in the create wizard, and in the derived setup-state fact on
// the next read. The one-shot deploy token in the body is never inspected or stored (the real engine
// uses it once for the deploy write and discards it; the demo has no deploy to make).
export function writeAttachSources(init?: RequestInit): Response {
  // The wire field is `sources` (client-sources.ts changeBindings: { token, sources: add, remove }).
  const body = readBody<{ sources?: AttachSourceInput[]; remove?: string[] }>(init);
  const add = Array.isArray(body.sources) ? body.sources : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];
  const bound = world.sourceDiscovery.bound;
  const listFor = (type: string): string[] | null =>
    type === "kv" ? bound.kv : type === "r2" ? bound.r2 : type === "d1" ? bound.d1 : type === "secrets" ? bound.secrets : null;
  const attached: string[] = [];
  for (const input of add) {
    if (typeof input?.binding !== "string" || input.binding === "") continue;
    const list = listFor(input.type);
    if (list === null) continue;
    if (!list.includes(input.binding)) list.push(input.binding);
    attached.push(input.binding);
  }
  const detached: string[] = [];
  for (const name of remove) {
    if (typeof name !== "string") continue;
    for (const list of [bound.kv, bound.r2, bound.d1, bound.secrets]) {
      const at = list.indexOf(name);
      if (at >= 0) {
        list.splice(at, 1);
        detached.push(name);
      }
    }
  }
  return json({ attached, detached });
}

// writeAddDownpipe models POST /admin/downpipes (addDownpipe), honouring the world's OWN governance
// posture the way the engine does. With dual control ON (the seeded demo org), the mutation is DEFERRED:
// HTTP 202 { queued: true, id } and the change LANDS in world.configChanges as a real pending
// ConfigChange, so the toast's View opens an inbox that contains the change the visitor just made. With
// dual control OFF (a fresh account, the training-start world), the engine applies the write inline and
// answers the created DownpipeState, which is what lets the training walk's first downpipe exist and then
// run.
export function writeAddDownpipe(init?: RequestInit): Response {
  const out = addOneDownpipe(readBody<Downpipe>(init));
  if (out.status === "refused") return json({ error: out.error }, { status: 400 });
  if (out.status === "pending") return json(out.body, { status: 202 });
  return json(out.state);
}

// addOneDownpipe is the single-create body shared by POST /admin/downpipes and each item of POST
// /admin/downpipes/bulk (the engine runs every bulk item through the same gated single-upsert path).
function addOneDownpipe(
  dp: Partial<Downpipe>,
): { status: "pending"; id: string; body: PendingChangeBody } | { status: "applied"; id: string; state: DownpipeState } | { status: "refused"; id: string; error: string } {
  const id = typeof dp.id === "string" && dp.id !== "" ? dp.id : "dp-new";
  if (world.configApprovalPolicy.requireConfigApproval) {
    // The engine refuses a proposal from a caller with no verified email (proposeConfigMutation), so a queued
    // change always names its proposer. The demo mirrors the refusal rather than queue a change with none.
    const proposedBy = world.whoami.email;
    if (proposedBy === null) {
      return { status: "refused", id, error: "dual control requires an attributable identity; the bare-token fallback cannot propose a config change" };
    }
    const body: PendingChangeBody = queuedChange(`chg-${id}-${world.changeSeq++}`);
    const name = typeof dp.name === "string" && dp.name !== "" ? dp.name : id;
    world.configChanges.unshift({
      id: body.id,
      kind: "downpipe-upsert",
      proposedBy,
      proposedAt: demoIso(0),
      status: "pending",
      diff: [{ kind: "added", area: "downpipes", text: `${name}: create (awaiting a second approver before it takes effect)` }],
    });
    return { status: "pending", id, body };
  }
  const cadence = typeof dp.cadenceSeconds === "number" && dp.cadenceSeconds > 0 ? dp.cadenceSeconds : 86_400;
  const source: SourceSpec = dp.source !== undefined ? dp.source : { type: "kv", include: [], exclude: [] };
  // The required fields are defaulted the way the engine's validateConfig would have bounded them; each
  // optional field rides through ONLY when the body carried it (exactOptionalPropertyTypes: a spread of
  // the Partial would smuggle present-as-undefined keys onto the exact type).
  const config: Downpipe = {
    id,
    name: typeof dp.name === "string" && dp.name !== "" ? dp.name : id,
    cadenceSeconds: cadence,
    enabled: typeof dp.enabled === "boolean" ? dp.enabled : true,
    source,
    ...(dp.destinationId !== undefined ? { destinationId: dp.destinationId } : {}),
    ...(dp.destinationIds !== undefined ? { destinationIds: dp.destinationIds } : {}),
    ...(dp.restoreTestCadenceSeconds !== undefined ? { restoreTestCadenceSeconds: dp.restoreTestCadenceSeconds } : {}),
    ...(dp.retention !== undefined ? { retention: dp.retention } : {}),
    ...(dp.schedule !== undefined ? { schedule: dp.schedule } : {}),
  };
  const existing = world.downpipes.findIndex((d) => d.config.id === id);
  if (existing >= 0) {
    world.downpipes[existing] = { ...world.downpipes[existing]!, config };
    return { status: "applied", id, state: world.downpipes[existing]! };
  }
  const state: DownpipeState = { config, nextRunAt: Date.now() + cadence * 1000, lastRunId: null, inFlight: false };
  world.downpipes.push(state);
  if (world.historyByDownpipe[id] === undefined) world.historyByDownpipe[id] = [];
  // The engine STATUS follows the write (the training-start status carries downpipeCount 0).
  world.status = { ...world.status, downpipeCount: world.downpipes.length };
  return { status: "applied", id, state };
}

// writeBulkAddDownpipes models POST /admin/downpipes/bulk (bulkAddDownpipes): each item runs through the
// single-create body above, continue-on-error, and the answer is the engine's per-item, index-aligned
// BulkDownpipeResponse (lib/api/types/downpipes.ts). Before this the route fell to benignWrite, whose body
// has no `results`, so lib/bulk-create.ts threw reading results[k] and "Protect N sources" never finished.
// The engine's ungated cap (100) is honoured with its maxBatch refusal.
export function writeBulkAddDownpipes(init?: RequestInit): Response {
  const body = readBody<{ downpipes: Downpipe[] }>(init);
  const items = Array.isArray(body.downpipes) ? body.downpipes : [];
  const cap = world.configApprovalPolicy.requireConfigApproval ? 25 : 100;
  if (items.length > cap) return json({ error: `at most ${cap} downpipes per request`, maxBatch: cap }, { status: 400 });
  const results: BulkDownpipeItemResult[] = [];
  let applied = 0;
  let pending = 0;
  let failed = 0;
  for (const dp of items) {
    const out = addOneDownpipe(dp ?? {});
    if (out.status === "refused") {
      failed++;
      results.push({ id: out.id, status: "error", error: out.error });
    } else if (out.status === "pending") {
      pending++;
      results.push({ id: out.id, status: "pending", changeId: out.body.id });
    } else {
      applied++;
      results.push({ id: out.id, status: "applied" });
    }
  }
  const response: BulkDownpipeResponse = { results, applied, pending, failed };
  return json(response);
}

// writeSetRole models POST /admin/roles (setRole): the grant is stored on the world's role table and the
// answer is the engine's RoleGrantResult (the stored row plus a one-time invite token), so the team step
// reads "Role stored for <email> as <role>" instead of the benignWrite shape's "undefined as undefined".
export function writeSetRole(init?: RequestInit): Response {
  const { email, role, expiresAt } = readBody<{ email: string; role: RoleEntry["role"]; expiresAt?: string }>(init);
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "a valid email is required" }, { status: 400 });
  if (typeof role !== "string") return json({ error: "a role is required" }, { status: 400 });
  const entry: RoleEntry = { email, role, grantedBy: world.whoami.email ?? ORG_OWNER_EMAIL, grantedAt: demoIso(0), ...(typeof expiresAt === "string" ? { expiresAt } : {}) };
  const at = world.roles.findIndex((r) => r.email === email);
  if (at >= 0) world.roles[at] = entry;
  else world.roles.push(entry);
  return json({ ...entry, inviteToken: "demo-invite-token-not-real" });
}

// writeRestoreApprovalPolicy models POST /admin/config/restore-approval-policy: the choice PERSISTS for the
// session on the world's approval policy, which GET /admin/config/approval-policy serves, so the choice
// reads back. A sole identity cannot require a second approver: the engine refuses that, and so does this.
export function writeRestoreApprovalPolicy(init?: RequestInit): Response {
  const { requireRestoreApproval } = readBody<{ requireRestoreApproval: boolean }>(init);
  if (typeof requireRestoreApproval !== "boolean") return json({ error: "requireRestoreApproval must be a boolean" }, { status: 400 });
  // The signed-in owner counts even when the role table does not list them (the fresh-account world).
  const approvers = new Set([...world.roles.filter((r) => r.role === "owner" || r.role === "approver").map((r) => r.email), world.whoami.email]).size;
  if (requireRestoreApproval && approvers < 2) {
    return json({ error: "a second approver cannot be required while only one identity can approve; invite a second Owner or Approver first" }, { status: 400 });
  }
  world.configApprovalPolicy = { ...world.configApprovalPolicy, requireRestoreApproval };
  return json({ requireRestoreApproval });
}

// writeSignInContextPolicy models POST /admin/config/signin-context-policy: the owner-opt-in
// unusual-location sign-in notify toggle. The choice PERSISTS for the session on the world's approval
// policy, which GET /admin/config/approval-policy serves, so the switch reads back on and stays on.
export function writeSignInContextPolicy(init?: RequestInit): Response {
  const { notifyNewSignInContext } = readBody<{ notifyNewSignInContext: boolean }>(init);
  if (typeof notifyNewSignInContext !== "boolean") return json({ error: "notifyNewSignInContext must be a boolean" }, { status: 400 });
  world.configApprovalPolicy = { ...world.configApprovalPolicy, notifyNewSignInContext };
  return json({ notifyNewSignInContext });
}

// writeSendCustodyShare models POST /admin/custody/send-share: the demo has no mail binding, so it answers
// the engine's advisory result shape with sent:true and sends nothing (the share never leaves the tab).
export function writeSendCustodyShare(): Response {
  return json({ sent: true });
}
