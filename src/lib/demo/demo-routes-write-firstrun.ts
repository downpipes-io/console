// The faked engine's guided-first-run write handlers (steps 3 to 5 of the setup walk), split from
// demo-routes-write.ts along the module seam the size budget names: the discovery-token verify, the
// binding attach/detach, and the downpipe create. Each mutates the world so the screens and the derived
// setup-state fact (demo-routes-read.ts deriveSetupStateView) reflect the learner's own action the
// moment it lands, which is what lets the training walk grade by world state.
//
// House rules: Australian English, precise claims.

import type { AttachSourceInput, Downpipe, DownpipeState, PendingChangeBody, SourceSpec } from "../api/types.ts";
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
    // The refused-token path: Cloudflare declined the token, so nothing is stored. The screen surfaces
    // the coarse reason through failResponse, which is the exact lesson the sentinel exists to teach.
    return json({ error: "the token was refused: Cloudflare answered authentication error (code 10000); nothing was stored" }, { status: 400 });
  }
  if (token === null) {
    world.sourceDiscovery = { ...world.sourceDiscovery, tokenPresent: false, accounts: [] };
    return json({ present: false });
  }
  if (token === "training-empty-scopes") {
    // Verified but sees NO accounts: the engine stores it (it authenticates) and the console's
    // tokenVerifiedToast warns rather than falsely celebrating, the zero-accounts lesson.
    world.sourceDiscovery = { ...world.sourceDiscovery, tokenPresent: true, accounts: [] };
    return json({ present: true, setAt: demoEpoch(0), setBy: ORG_OWNER_EMAIL, accountsSeen: [], selected: [], engineAccountId: null });
  }
  world.sourceDiscovery = { ...world.sourceDiscovery, tokenPresent: true, engineAccountId: DEMO_ACCT_ID, accounts: [demoDiscoveredAccount()] };
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
// HTTP 202 { queued: true, id } and the change now also LANDS in world.configChanges as a real pending
// ConfigChange, so the toast's View opens an inbox that contains the change the visitor just made (it
// used to land nowhere, and the inbox showed only the seeded change). With dual control OFF (a fresh
// account, the training-start world), the engine applies the write inline and answers the created
// DownpipeState, which is what lets the training walk's first downpipe exist and then run.
export function writeAddDownpipe(init?: RequestInit): Response {
  const dp = readBody<Downpipe>(init);
  const id = typeof dp.id === "string" && dp.id !== "" ? dp.id : "dp-new";
  if (world.configApprovalPolicy.requireConfigApproval) {
    const body: PendingChangeBody = queuedChange(`chg-${id}-${world.changeSeq++}`);
    const name = typeof dp.name === "string" && dp.name !== "" ? dp.name : id;
    world.configChanges.unshift({
      id: body.id,
      kind: "downpipe-upsert",
      proposedBy: world.whoami.email,
      proposedAt: demoIso(0),
      status: "pending",
      diff: [{ kind: "added", area: "downpipes", text: `${name}: create (awaiting a second approver before it takes effect)` }],
    });
    return json(body, { status: 202 });
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
    return json(world.downpipes[existing]);
  }
  const state: DownpipeState = { config, nextRunAt: Date.now() + cadence * 1000, lastRunId: null, inFlight: false };
  world.downpipes.push(state);
  if (world.historyByDownpipe[id] === undefined) world.historyByDownpipe[id] = [];
  // The engine STATUS follows the write (the training-start status carries downpipeCount 0).
  world.status = { ...world.status, downpipeCount: world.downpipes.length };
  return json(state);
}
