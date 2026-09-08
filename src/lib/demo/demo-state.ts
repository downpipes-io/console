// The DEMO-STATE fixture knob (a private master gap catalogue, held internally, "a vision-judge-every-screen runner":
// "land a demo-state fixture knob so empty / one-item / aged / role states render across all 27
// screens locally and unattended"). This is a TEST-ONLY variant selector over the tour/demo world
// (demo-seed.ts buildSeed), reached ONLY through the existing tour/demo gate (isTourMode(),
// tour-mode.ts): a query flag honoured on a dev host, or on the public tour host. It never reaches a
// real deployment, exactly like the pre-existing ?tour=1 flag itself -- see tour-mode.ts's own header
// comment for that guarantee, which this file inherits unchanged (it adds no new gate, only a second
// query param read behind the SAME isTourMode() boundary, parsed no differently to that flag).
//
// This is a URL query flag interpreted once at boot, not a field({...}) call, a raw
// input/select/checkbox/radio, a screen's control set, or a validator. It adds no customer-facing
// control, moves no field, and changes no validator.
//
// The five variants:
//   default  -- the existing tour/demo seed, byte-unchanged (the pixel-baseline state already relied on).
//   empty    -- every CUSTOMER-CONTENT collection emptied (no downpipes, no destinations, no runs, no
//               audit, ...), so a screen renders its true fresh-account/no-data teach path.
//   minimal  -- every customer-content collection thinned to exactly one representative item (the
//               "just added my first X" render).
//   aged     -- a deep, synthetic history on the cheap ring/history-shaped collections (audit, notify
//               history, config history), simulating weeks of accumulated use.
//   role:<r> -- the signed-in caller's OWN role swapped to one of the six built-in roles, so a screen
//               renders its per-role curated/gated view with no second persona fixture required.
//   training-start -- the empty transform plus fresh-account overrides (setup gate re-engaged, dual
//               control off), the boot state of the guided training walk. Separate from "empty" so the
//               screenshot matrices' empty baselines keep the seeded governance posture unchanged.
//
// This file also owns the training walk's TIME-JUMP transforms (advanceWorldDays / injectRunFailure at
// the bottom): pure world-in world-out functions the training director applies at chapter boundaries,
// following the aged stretch helpers' own clone-and-renumber pattern.
//
// WHY A STRUCTURAL TRANSFORM, NOT A HAND-WRITTEN SECOND SEED: DemoWorld (demo-seed.ts) is ~30 fields;
// hand-authoring a parallel "empty" and "minimal" seed object risks silently drifting from the real
// seed's shape the moment either changes. Instead this file classifies DemoWorld's own fields ONCE
// (the trim* helpers below) and applies one small set of generic empty/thin/stretch operations across
// them, so the transform is reviewable in one pass rather than scattered per-screen logic.
//
// KNOWN LIMITS (honest, not silently perfect -- named so a screen x state test matrix can
// extend them deliberately, not rediscover them by surprise):
//   - `reports` / `evidencePacks` are NOT reshaped for "empty": each is a complex, engine-signed
//     structure this fixture does not recompute, so the Reports screen still shows a signed report
//     under demo-state=empty. A true empty-reports render needs a dedicated per-kind empty body, a
//     follow-up, not a silent gap: it is named here rather than assumed away.
//   - `restorePlan` is left pointing at its seeded run under every variant, including "empty": a
//     restore-flow screen that dereferences it against an emptied `downpipes` array may see a
//     dangling reference. Left alone deliberately rather than guessed at.
//   - `idpProviders` / `idpPresets` are platform CATALOGUE data (the fixed set of presets a customer
//     could add), not customer content, so they are never trimmed by any variant.
//   - The remaining singletons (`configApprovalPolicy`, `support`, `push`,
//     `updateStatusRecord`, `posture`, `rto`, `canary`, `estateSize`, `preflight`, and
//     `sourceDiscovery`'s account-catalogue fields) keep their seeded values under every variant
//     except the small, named "empty" overrides below (`destinationDefault.present`,
//     `coverage.hasInventory`-adjacent fields, `sourceDiscovery.bound`/`tokenPresent`). Extending any
//     of these is additive: add a field to a trim* helper, or a singleton override to
//     emptyOverrides(), without touching the dispatch switch itself.
//
// House rules: Australian English, no em dashes, precise claims, no AI attribution.

import type { AuditEvent, ConfigVersionHeader, NotifyHistoryEntry, RunHistoryEntry } from "../api/types.ts";
import type { Role } from "../identity.ts";
import type { DemoWorld } from "./demo-seed.ts";

export type DemoStateVariant =
  | { kind: "default" }
  | { kind: "empty" }
  | { kind: "minimal" }
  | { kind: "aged" }
  | { kind: "training-start" }
  | { kind: "role"; role: Role };

const DEFAULT_VARIANT: DemoStateVariant = { kind: "default" };

// The six built-in roles (identity.ts's Role union), spelled out here so an unrecognised query value
// degrades to the default variant rather than fabricating a caller with an invalid role string.
const BUILTIN_ROLES: ReadonlySet<string> = new Set(["viewer", "operator", "restore-operator", "approver", "access-admin", "owner"]);

/**
 * Parses the `demo-state` query VALUE (already extracted from the URL) into a DemoStateVariant. An
 * absent, empty, or unrecognised value is the existing default seed, never a thrown error -- exactly
 * tour-mode.ts's own "a malformed URL never accidentally changes behaviour" discipline.
 */
export function parseDemoStateParam(raw: string | null): DemoStateVariant {
  if (raw === "empty" || raw === "minimal" || raw === "aged" || raw === "training-start") return { kind: raw };
  if (raw?.startsWith("role:")) {
    const role = raw.slice("role:".length);
    if (BUILTIN_ROLES.has(role)) return { kind: "role", role: role as Role };
  }
  return DEFAULT_VARIANT;
}

/**
 * Reads the `demo-state` query parameter straight off `location` (defaults to the real `location`; a
 * test passes its own for a pure unit check). Never throws: an unparsable URL degrades to the default
 * variant, mirroring isTourMode's own try/catch shape (tour-mode.ts).
 */
export function demoStateFromLocation(loc: Location = location): DemoStateVariant {
  try {
    return parseDemoStateParam(new URLSearchParams(loc.search).get("demo-state"));
  } catch {
    return DEFAULT_VARIANT;
  }
}

/** A short, stable label for a marker attribute or a ledger evidence string: "default" | "empty" |
 *  "minimal" | "aged" | "role:<r>". Kept here so the marker and any debug logging share one spelling. */
export function demoStateLabel(variant: DemoStateVariant): string {
  return variant.kind === "role" ? `role:${variant.role}` : variant.kind;
}

// ==================================================================================================
// empty / minimal: the collection-trim helpers. Each returns exactly the DemoWorld sub-shape it
// reshapes, spread into the result by applyDemoStateVariant below, so a reviewer can see every field
// this file touches in one place per helper rather than a single sprawling function.
// ==================================================================================================

/** Downpipes plus the two maps keyed by downpipe id, kept coherent: only ids that survive the trim
 *  keep their history/replication entries, so a screen that cross-references them never sees a
 *  dangling id. `keep` is the count of downpipes to retain (0 for empty, 1 for minimal). */
function trimDownpipes(world: DemoWorld, keep: number): Pick<DemoWorld, "downpipes" | "historyByDownpipe" | "replicationByDownpipe"> {
  const downpipes = keep === 0 ? [] : world.downpipes.slice(0, keep);
  const keptIds = new Set(downpipes.map((d) => d.config.id));
  const historyByDownpipe: DemoWorld["historyByDownpipe"] = {};
  const replicationByDownpipe: DemoWorld["replicationByDownpipe"] = {};
  for (const id of keptIds) {
    const hist = world.historyByDownpipe[id];
    if (hist) historyByDownpipe[id] = hist;
    const repl = world.replicationByDownpipe[id];
    if (repl) replicationByDownpipe[id] = repl;
  }
  return { downpipes, historyByDownpipe, replicationByDownpipe };
}

/** Every plain-array collection with no cross-reference to keep coherent: a direct slice(0, keep). */
function trimArrayFields(
  world: DemoWorld,
  keep: number,
): Pick<
  DemoWorld,
  | "drillEvidence"
  | "audit"
  | "approvals"
  | "expiry"
  | "configChanges"
  | "roles"
  | "groupRoles"
  | "customRoles"
  | "notifyChannels"
  | "notifyRules"
  | "notifyHistory"
  | "ownerActions"
  | "passkeyCredentials"
  | "idpConnections"
> {
  const trim = <T>(arr: readonly T[]): T[] => (keep === 0 ? [] : arr.slice(0, keep));
  return {
    drillEvidence: trim(world.drillEvidence),
    audit: trim(world.audit),
    approvals: trim(world.approvals),
    expiry: trim(world.expiry),
    configChanges: trim(world.configChanges),
    roles: trim(world.roles),
    groupRoles: trim(world.groupRoles),
    customRoles: trim(world.customRoles),
    notifyChannels: trim(world.notifyChannels),
    notifyRules: trim(world.notifyRules),
    notifyHistory: trim(world.notifyHistory),
    ownerActions: trim(world.ownerActions),
    passkeyCredentials: trim(world.passkeyCredentials),
    idpConnections: trim(world.idpConnections),
  };
}

/** destinations (DestinationList): the nested destinations[] plus defaultId, kept mutually
 *  consistent -- a trimmed list that still contains the original default keeps pointing at it,
 *  otherwise it falls back to the first surviving entry, and to null only when the list is empty. */
function trimDestinations(world: DemoWorld, keep: number): DemoWorld["destinations"] {
  const list = keep === 0 ? [] : world.destinations.destinations.slice(0, keep);
  const defaultId = list.find((d) => d.id !== undefined && d.id === world.destinations.defaultId)?.id ?? list[0]?.id ?? null;
  return { destinations: list, defaultId };
}

/** coverage (CoverageReport): the resources[] plus its rollup, recomputed from the trimmed slice so
 *  the headline counts never disagree with the cards actually rendered. "empty" also flips
 *  hasInventory to false (the honest no-inventory-configured render), matching gap E11's true-empty
 *  Security-centre state; "minimal" keeps hasInventory true (an inventory WAS configured, it just
 *  holds one resource), matching the "just added my first resource" render instead. */
function trimCoverage(world: DemoWorld, keep: number): DemoWorld["coverage"] {
  if (keep === 0) {
    return { ...world.coverage, hasInventory: false, resources: [], rollup: { total: 0, protected: 0, unprotected: 0, untested: 0 } };
  }
  const resources = world.coverage.resources.slice(0, keep);
  const rollup = { total: resources.length, protected: 0, unprotected: 0, untested: 0 };
  for (const r of resources) {
    if (r.status === "protected") rollup.protected++;
    else if (r.status === "unprotected") rollup.unprotected++;
    else rollup.untested++;
  }
  return { ...world.coverage, resources, rollup };
}

/** configHistory (ConfigHistory): the versions[] plus headId/headHash/verify, recomputed from the
 *  trimmed slice so the chain-verify badge never disagrees with the list actually rendered. Reuses
 *  the type's own documented empty convention (headId -1, earliestId -1, "or -1 for an empty
 *  history" per config-history.ts's own field comments) rather than inventing a new empty shape. */
function trimConfigHistory(world: DemoWorld, keep: number): DemoWorld["configHistory"] {
  const versions = keep === 0 ? [] : world.configHistory.versions.slice(0, keep);
  if (versions.length === 0) {
    return { versions: [], headId: -1, headHash: world.configHistory.headHash, verify: { intact: true, checkedThrough: -1, earliestId: -1 } };
  }
  const head = versions[0]!;
  const tail = versions[versions.length - 1]!;
  return { versions, headId: head.id, headHash: head.contentHash, verify: { intact: true, checkedThrough: head.id, earliestId: tail.id } };
}

/** The small set of singleton overrides "empty" applies beyond the collections above: an honest
 *  no-destination-configured default view, and a source-discovery view with nothing bound. Applied
 *  ONLY for "empty" (minimal keeps these singletons at their seeded, already-small values). */
function emptyOverrides(world: DemoWorld): Pick<DemoWorld, "destinationDefault" | "sourceDiscovery"> {
  return {
    destinationDefault: { ...world.destinationDefault, present: false },
    sourceDiscovery: { ...world.sourceDiscovery, bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: false, accounts: [] },
  };
}

/** training-start: the overrides that make the emptied world read as a genuinely FRESH account, which
 *  "empty" deliberately does not (its consumers are the screenshot matrices, whose baselines depend on
 *  the seeded governance posture surviving). A fresh account has no keys installed yet (the setup gate's
 *  step 1 engages, so the learner meets the locked rail and the checklist Overview) and runs WITHOUT
 *  dual control (requireConfigApproval defaults off on a real new account; the training walk arms it on
 *  screen in the Advanced chapter instead of inheriting the demo org's armed posture). ownerExists stays
 *  true: the learner is signed in as the owner, exactly like a real first run after first sign-in. */
function trainingStartOverrides(world: DemoWorld): Pick<DemoWorld, "setupState" | "configApprovalPolicy" | "status"> {
  return {
    setupState: {
      ...world.setupState,
      keysReady: false,
      signerConfigured: false,
      breakGlassConfigured: false,
      emailConfigured: false,
      anyRunCompleted: false,
      ready: false,
    },
    configApprovalPolicy: { requireConfigApproval: false, requireChangeNumber: false },
    // The engine STATUS mirrors the fresh account too: the onboarding deck's own probes read status()
    // (the generate card reframes to "your keys are already set" on breakGlassConfigured), so a training world
    // whose status still carried the seeded keys let
    // the deck skip the very ceremony the walk teaches. The demo key/destination/downpipe writes flip
    // these back as the learner earns them.
    status: {
      ...world.status,
      signerConfigured: false,
      breakGlassConfigured: false,
      operationalConfigured: { public: false, private: false },
      destConfigured: false,
      destKind: null,
      downpipeCount: 0,
      ready: false,
    },
  };
}

// ==================================================================================================
// aged: the ring/history stretch helpers. Each renumbers the WHOLE combined (real + synthetic) series
// by final array position rather than trying to preserve the seed's own seq/id values, which keeps
// every id/seq positive, unique and correctly ordered regardless of how small the seed's own oldest
// value already is (the seed's ~8-10-entry audit chain starts its oldest entry at a low seq, leaving
// no room to insert further-past entries BELOW it with positive numbers). This fixture never
// recomputes a cryptographic hash chain, so a renumbered hash/prevHash/parentHash string is carried
// through unchanged from its template entry: harmless for a VISUAL accumulation render, and out of
// scope for a chain-integrity check (a different, already-covered gap class).
// ==================================================================================================

const AGED_STRETCH_COUNT = 40; // extra synthetic entries appended as OLDER than every real one
const AGED_STEP_MS = 8 * 60 * 60 * 1000; // 8h apart, walking back weeks of synthetic history

function agedAuditStretch(audit: readonly AuditEvent[]): AuditEvent[] {
  if (audit.length === 0) return [];
  const oldest = audit[audit.length - 1]!; // audit is newest-first (demo-world.ts auditPage's own comment)
  const oldestTs = Date.parse(oldest.ts);
  const synthetic: AuditEvent[] = [];
  for (let i = 1; i <= AGED_STRETCH_COUNT; i++) {
    synthetic.push({ ...oldest, ts: new Date(oldestTs - i * AGED_STEP_MS).toISOString() });
  }
  const combined = [...audit, ...synthetic];
  const total = combined.length;
  return combined.map((e, i) => ({ ...e, seq: total - i }));
}

function agedNotifyHistoryStretch(history: readonly NotifyHistoryEntry[]): NotifyHistoryEntry[] {
  if (history.length === 0) return [];
  const oldest = history[history.length - 1]!; // same newest-first convention as audit
  const oldestTs = Date.parse(oldest.ts);
  const synthetic: NotifyHistoryEntry[] = [];
  for (let i = 1; i <= AGED_STRETCH_COUNT; i++) {
    synthetic.push({ ...oldest, ts: new Date(oldestTs - i * AGED_STEP_MS).toISOString() });
  }
  const combined = [...history, ...synthetic];
  const total = combined.length;
  return combined.map((e, i) => ({ ...e, seq: total - i }));
}

function agedConfigHistoryStretch(history: DemoWorld["configHistory"]): DemoWorld["configHistory"] {
  const versions = history.versions;
  if (versions.length === 0) return history;
  const oldest = versions[versions.length - 1]!; // newest-first (config-history.ts's own field comment)
  const oldestAt = Date.parse(oldest.at);
  const synthetic: ConfigVersionHeader[] = [];
  for (let i = 1; i <= AGED_STRETCH_COUNT; i++) {
    synthetic.push({ ...oldest, at: new Date(oldestAt - i * (AGED_STEP_MS * 1.5)).toISOString() });
  }
  const combined = [...versions, ...synthetic];
  const total = combined.length;
  const renumbered = combined.map((v, i) => ({ ...v, id: total - i }));
  const head = renumbered[0]!;
  const tail = renumbered[renumbered.length - 1]!;
  return { versions: renumbered, headId: head.id, headHash: head.contentHash, verify: { intact: true, checkedThrough: head.id, earliestId: tail.id } };
}

// ==================================================================================================
// applyDemoStateVariant: the single entry point demo-world.ts calls. PURE: takes a world, returns a
// new one (or the SAME reference for "default", so a no-op variant costs nothing and changes
// nothing observable, including object identity for any caller that happens to check it).
// ==================================================================================================

export function applyDemoStateVariant(world: DemoWorld, variant: DemoStateVariant): DemoWorld {
  switch (variant.kind) {
    case "default":
      return world;
    case "role":
      return {
        ...world,
        whoami: {
          ...world.whoami,
          role: variant.role,
          roleSource: "email",
          isOnlyOwner: variant.role === "owner" ? world.whoami.isOnlyOwner : false,
        },
      };
    case "empty":
      return {
        ...world,
        ...trimDownpipes(world, 0),
        ...trimArrayFields(world, 0),
        destinations: trimDestinations(world, 0),
        coverage: trimCoverage(world, 0),
        configHistory: trimConfigHistory(world, 0),
        ...emptyOverrides(world),
      };
    case "minimal":
      return {
        ...world,
        ...trimDownpipes(world, 1),
        ...trimArrayFields(world, 1),
        destinations: trimDestinations(world, 1),
        coverage: trimCoverage(world, 1),
        configHistory: trimConfigHistory(world, 1),
      };
    case "aged":
      return {
        ...world,
        audit: agedAuditStretch(world.audit),
        notifyHistory: agedNotifyHistoryStretch(world.notifyHistory),
        configHistory: agedConfigHistoryStretch(world.configHistory),
      };
    case "training-start":
      // The empty transform plus the fresh-account overrides: the collections are emptied exactly as
      // "empty" empties them, then the setup gate re-engages and dual control reads off. The order
      // matters only for setupState (trainingStartOverrides reads world.setupState, which the collection
      // trims never touch, so composing over the empty result is safe and reviewable in one place).
      return {
        ...world,
        ...trimDownpipes(world, 0),
        ...trimArrayFields(world, 0),
        destinations: trimDestinations(world, 0),
        coverage: trimCoverage(world, 0),
        configHistory: trimConfigHistory(world, 0),
        ...emptyOverrides(world),
        ...trainingStartOverrides(world),
      };
    default: {
      // Exhaustiveness guard: a future DemoStateVariant member fails to compile here until handled.
      const exhaustive: never = variant;
      return exhaustive;
    }
  }
}

// ==================================================================================================
// The training walk's time-jump transforms. Pure, like applyDemoStateVariant: world in, new world out.
// Applied by the training director at chapter boundaries only, where its navigation forces a fresh
// render, so no mounted screen ever holds a reference to the pre-jump world.
// ==================================================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** advanceWorldDays simulates `days` of scheduled operation. Any in-flight run settles first (time
 *  passed, so it completed), then each downpipe's ring gains one synthesised ok run per day, newest a
 *  couple of hours ago, cloned from the ring's most recent ok entry (or its head, forced ok) exactly as
 *  the aged helpers clone their oldest entry. Indexes are renumbered by final array position
 *  (newest-first, so the head carries the highest index), runIds re-minted from the renumbered index,
 *  and the downpipe's lastRunId follows the new head. The audit / notify / config-history rings are
 *  stretched with the existing aged helpers so the accumulation shows on every history-shaped screen,
 *  not only on Runs. No cryptographic chain is recomputed (the aged helpers' own documented stance). */
export function advanceWorldDays(world: DemoWorld, days: number): DemoWorld {
  if (days <= 0) return world;
  const historyByDownpipe: DemoWorld["historyByDownpipe"] = {};
  for (const [dpId, ring] of Object.entries(world.historyByDownpipe)) {
    const settled: RunHistoryEntry[] = ring.map((e) =>
      e.status === "in-flight" ? { ...e, status: "ok", recordCount: e.recordCount ?? 1200, bytes: e.bytes ?? 48_000_000, durationMs: e.durationMs ?? 42_000 } : e,
    );
    const template = settled.find((e) => e.status === "ok") ?? settled[0];
    const synthesised: RunHistoryEntry[] = [];
    if (template !== undefined) {
      const { error: droppedError, ...rest } = template;
      void droppedError;
      const base: RunHistoryEntry = { ...rest, status: "ok" };
      for (let i = 0; i < days; i++) {
        synthesised.push({ ...base, startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - i * DAY_MS).toISOString() });
      }
    }
    const combined = [...synthesised, ...settled];
    const total = combined.length;
    historyByDownpipe[dpId] = combined.map((e, i) => {
      const index = total - i;
      return { ...e, index, runId: `${dpId.replace(/^dp-/, "run-")}-${String(index).padStart(4, "0")}` };
    });
  }
  const downpipes = world.downpipes.map((dp) => {
    const head = historyByDownpipe[dp.config.id]?.[0];
    return head === undefined ? dp : { ...dp, inFlight: false, lastRunId: head.runId };
  });
  return {
    ...world,
    downpipes,
    historyByDownpipe,
    audit: agedAuditStretch(world.audit),
    notifyHistory: agedNotifyHistoryStretch(world.notifyHistory),
    configHistory: agedConfigHistoryStretch(world.configHistory),
  };
}

/** The coarse failure story injectRunFailure writes: a destination write probe refused mid-run. The
 *  wording follows the seeded payments failure (demo-seed.ts run-payments-0040): a real, recoverable
 *  reason an operator can act on, never a stack. */
const INJECTED_FAILURE_ERROR = "destination probe failed: AccessDenied (the bucket policy denied a list during the pre-seal check); nothing was written this run.";

/** injectRunFailure unshifts one failed run at the head of the named downpipe's ring (or the first
 *  downpipe's, when the id is absent or unknown), with a corroborating critical notification appended
 *  ONLY when a notify channel exists to have delivered it (a fresh training account has none, and a
 *  history row naming a channel that does not exist would be the exact dangling-reference shape the
 *  seed avoids). The failure reads as a story the troubleshooting chapter walks: a real coarse error,
 *  worst-first sorting surfaces it, and the rerun settles clean over it. */
export function injectRunFailure(world: DemoWorld, downpipeId?: string): DemoWorld {
  const dpId = downpipeId !== undefined && world.historyByDownpipe[downpipeId] !== undefined ? downpipeId : world.downpipes[0]?.config.id;
  if (dpId === undefined) return world;
  const ring = world.historyByDownpipe[dpId] ?? [];
  const prevIndex = ring[0]?.index ?? 0;
  const index = prevIndex + 1;
  const failed: RunHistoryEntry = {
    runId: `${dpId.replace(/^dp-/, "run-")}-${String(index).padStart(4, "0")}`,
    index,
    startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    status: "failed",
    error: INJECTED_FAILURE_ERROR,
  };
  const historyByDownpipe = { ...world.historyByDownpipe, [dpId]: [failed, ...ring] };
  const downpipes = world.downpipes.map((dp) => (dp.config.id === dpId ? { ...dp, inFlight: false, lastRunId: failed.runId } : dp));
  const channel = world.notifyChannels[0];
  const dpName = world.downpipes.find((d) => d.config.id === dpId)?.config.name ?? dpId;
  const notifyHistory: NotifyHistoryEntry[] =
    channel === undefined
      ? world.notifyHistory
      : [
          {
            seq: (world.notifyHistory[0]?.seq ?? 0) + 1,
            ts: failed.startedAt,
            event: "backup-failure",
            severity: "critical",
            downpipeId: dpId,
            channelId: channel.id,
            channelKind: channel.kind,
            delivered: true,
            detail: `${dpName}: run ${index} failed on the destination pre-seal check.`,
          },
          ...world.notifyHistory,
        ];
  return { ...world, historyByDownpipe, downpipes, notifyHistory };
}
