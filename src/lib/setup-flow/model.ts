// The headless setup model: one small observable store holding the engine FACTS and the user's DRAFT, and
// the step statuses derived from both (steps.ts). It renders nothing. A UI subscribes, reads get(), and
// calls actions.ts; it never decides a step's status itself.
//
// Persistence: the non-secret draft goes to sessionStorage (so Back, Forward and reload keep answers), in a
// try/catch because storage can be absent or blocked. Tokens, credentials and key material are never in the
// draft. Facts are never persisted: they are re-read from the engine.
//
// While the first backup this setup started is not finished (it created downpipes, and one of them has not
// sealed), a copy of the draft is also kept in localStorage (SETUP_FIRST_BACKUP_KEY). A tab whose own draft is
// empty takes it up, so a new tab resumes that setup where it stopped: the run, "Run it again", the receipt and
// Finish. The copy goes when the first backup is done, and at sign-out with the rest of the session
// (store.ts clearSessionData). The demo keeps no copy: each of its page loads starts a new world.

import type { DiscoveredAccount, EngineClient, SourceDiscovery } from "../../api.ts";
import { getCeremony, getEngine, onSessionCleared } from "../store.ts";
import { engineHoldsUsableOperationalKey } from "../operational-key-posture.ts";
import { DRAFT_PREFIX, SETUP_FIRST_BACKUP_KEY } from "../storage-keys.ts";
import { isCeremonyResult } from "../../keygen.ts";
import { recordReadDegraded } from "../client-diag/ring.ts";
import { demoRunning } from "./revoke-reminder.ts";
import { computeSteps, firstRunSealed, shellComplete, shellFactsRead } from "./steps.ts";
import type { DiscoveredAccountView, FactRead, ManualResource, PickKind, Resource, ResourceGroup, SetupDraft, SetupFacts, SetupRuntime, SetupSnapshot } from "./types.ts";

// In the DRAFT_PREFIX family, so the sign-out and session-end purge (store.ts clearSessionData) removes it.
const DRAFT_KEY = `${DRAFT_PREFIX}setup-v1`;

export function defaultDraft(): SetupDraft {
  return {
    started: false,
    tokenScope: null,
    provider: "r2",
    bucket: "",
    bucketTyped: false,
    otherAccount: false,
    r2AccountId: "",
    endpoint: "",
    region: "auto",
    addressing: "auto",
    storageClass: "",
    label: "",
    immutability: "off",
    immutabilityDays: "",
    roleArn: "",
    stsDuration: "",
    entraTenantId: "",
    entraClientId: "",
    pricing: null,
    picks: [],
    boundSeeded: false,
    manual: [],
    mediaContent: [],
    posture: null,
    postureAcknowledged: false,
    postureRecorded: null,
    postureRefusal: null,
    postureHashPrefix: null,
    custody: null,
    splitShares: 5,
    splitThreshold: 3,
    keysGenerated: false,
    refusedFiles: [],
    keysSaved: false,
    keysSent: false,
    keysInstallUnconfirmed: false,
    rewrap: null,
    credentialsResaved: false,
    possession: null,
    applyRoute: "token",
    deployTokenUsed: false,
    deployTokenUses: 0,
    deployTokenRevoked: false,
    names: {},
    schedule: "daily",
    retention: "keep-all",
    retentionCustom: null,
    restoreTest: null,
    createdDownpipeIds: [],
    firstRun: null,
    startedRuns: [],
    notStarted: [],
    teamSkipped: false,
    grants: [],
    restoreApproval: null,
  };
}

export function emptyFacts(): SetupFacts {
  return {
    setup: null,
    tokenPresent: null,
    accounts: [],
    discoveryReadAt: 0,
    engineAccountId: null,
    engineR2Buckets: [],
    groups: [],
    destinations: [],
    downpipes: [],
    runs: {},
    keysReady: false,
    enginePosture: null,
    engineVersion: null,
    restoreApproval: null,
    readAt: 0,
    fullReadAt: 0,
    readError: null,
    readsAt: {},
    failedReads: [],
  };
}

// parseDraft reads a stored draft. Only known keys are adopted, each only when its type matches the default's.
function parseDraft(raw: string): SetupDraft {
  const base = defaultDraft();
  try {
    const parsed = JSON.parse(raw) as Partial<SetupDraft>;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(parsed)) {
      const want = (base as unknown as Record<string, unknown>)[k];
      if (want === undefined && !(k in base)) continue;
      if (want === null || v === null || typeof v === typeof want) out[k] = v;
    }
    return out as unknown as SetupDraft;
  } catch {
    return base;
  }
}

function loadDraft(): SetupDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw !== null) return parseDraft(raw);
  } catch {
    // Storage blocked: fall through to the first-backup copy, then the default.
  }
  const carried = carriedDraft();
  if (carried === null) return defaultDraft();
  saveDraft(carried);
  return carried;
}

// carriedDraft is the first-backup copy another tab of this setup left (see the header), or null.
function carriedDraft(): SetupDraft | null {
  if (demoRunning()) return null;
  try {
    const raw = localStorage.getItem(SETUP_FIRST_BACKUP_KEY);
    if (raw === null) return null;
    const d = parseDraft(raw);
    return d.createdDownpipeIds.length > 0 ? d : null;
  } catch {
    return null;
  }
}

// draftEmpty: this tab has not worked on setup (no Start, no keys, no downpipe created or run), so it may take up
// the first-backup copy. A tab with work of its own keeps its own draft.
function draftEmpty(d: SetupDraft): boolean {
  return !d.started && !d.keysGenerated && !d.keysSent && d.createdDownpipeIds.length === 0 && d.firstRun === null;
}

function saveDraft(d: SetupDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // Storage blocked or full: answers then last only as long as this tab's memory.
  }
}

// ---- discovery -> resource groups ----------------------------------------------------------------------

// bindingFor mirrors screens/sources/account.ts:127 exactly, so a resource picked here gets the same SRC_*
// binding the Sources screen would give it.
export function bindingFor(prefix: string, name: string): string {
  return `${prefix}${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

const GROUP_ORDER: ReadonlyArray<{ kind: PickKind; label: string }> = [
  { kind: "d1", label: "D1 databases" },
  { kind: "kv", label: "KV namespaces" },
  { kind: "r2", label: "R2 buckets" },
  { kind: "secrets", label: "Secrets Store secrets" },
  { kind: "cf-config", label: "Cloudflare configuration" },
  { kind: "workers", label: "Workers" },
  { kind: "stream", label: "Stream" },
  { kind: "images", label: "Images" },
];

// buildGroups turns GET /admin/sources/discover into the flat list the Protect step shows: one group per
// type, the user's own resource names first, the SRC_* binding as secondary data. Binding kinds are
// selectable only in the engine's own account (bindings attach only there, sources/account.ts:385); token
// kinds are read with the discovery token in any browsed account. A minimal data-only token cannot read the
// token kinds, so they show that reason.
export function buildGroups(disc: SourceDiscovery, minimalToken: boolean): ResourceGroup[] {
  const bound = new Set([...disc.bound.kv, ...disc.bound.r2, ...disc.bound.d1, ...disc.bound.secrets]);
  const engineId = disc.engineAccountId ?? null;
  const out = new Map<PickKind, Resource[]>(GROUP_ORDER.map((g) => [g.kind, []]));
  const push = (r: Resource): void => { out.get(r.kind)?.push(r); };
  const otherAccount = "In another account: bindings attach only in the engine's own account.";
  const minimal = "Your minimal data-only token cannot read this. Widen the token to add it.";
  const accts: DiscoveredAccount[] = disc.accounts ?? [];
  const seenBindings = new Set<string>();
  for (const a of accts) {
    const isEngine = a.accountId === engineId;
    const common = { accountId: a.accountId, accountName: a.accountName };
    const bindingRes = (kind: "kv" | "r2" | "d1" | "secrets", key: string, name: string, binding: string, extra: Partial<Resource>): void => {
      seenBindings.add(binding);
      push({ key, kind, name, binding, bound: bound.has(binding), ...common, ...extra, ...(isEngine ? {} : { unavailable: otherAccount }) });
    };
    for (const n of a.d1) bindingRes("d1", `d1:${a.accountId}:${n.id}`, n.name, bindingFor("SRC_D1_", n.name), { id: n.id });
    for (const n of a.kv) bindingRes("kv", `kv:${a.accountId}:${n.id}`, n.name, bindingFor("SRC_KV_", n.name), { id: n.id });
    for (const n of a.r2) bindingRes("r2", `r2:${a.accountId}:${n.name}`, n.name, bindingFor("SRC_R2_", n.name), {});
    for (const n of a.secrets) bindingRes("secrets", `sec:${a.accountId}:${n.storeId}:${n.name}`, n.name, bindingFor("SRC_SEC_", n.name), { id: n.storeId, secretName: n.name });
    const cfOk = (disc.cfConfigSurfaces?.length ?? 0) > 0;
    const tokenRes = (kind: "cf-config" | "workers" | "stream" | "images", key: string, name: string, supported: boolean, extra: Partial<Resource>): void => {
      const why = minimalToken ? minimal : !supported ? "Your engine does not offer this source." : undefined;
      push({ key, kind, name, bound: false, ...common, ...extra, ...(why !== undefined ? { unavailable: why } : {}) });
    };
    tokenRes("cf-config", `cfc:${a.accountId}`, `${a.accountName}: account configuration`, cfOk, {});
    for (const z of a.zones) tokenRes("cf-config", `cfz:${a.accountId}:${z.id}`, `${z.name}: zone configuration`, cfOk, { id: z.id });
    tokenRes("workers", `workers:${a.accountId}`, `${a.accountName}: Workers`, disc.workersSupported === true, {});
    tokenRes("stream", `stream:${a.accountId}`, `${a.accountName}: Stream`, disc.streamSupported === true, {});
    tokenRes("images", `images:${a.accountId}`, `${a.accountName}: Images`, disc.imagesSupported === true, {});
  }
  // Bindings the engine already has that no browsed account lists (a wrangler deploy): still protectable.
  const lists: Array<["kv" | "r2" | "d1" | "secrets", string[]]> = [["d1", disc.bound.d1], ["kv", disc.bound.kv], ["r2", disc.bound.r2], ["secrets", disc.bound.secrets]];
  for (const [kind, names] of lists) {
    for (const b of names) {
      if (seenBindings.has(b)) continue;
      push({ key: `bound:${b}`, kind, name: b.replace(/^SRC_(KV|R2|D1|SEC)_/i, ""), binding: b, bound: true, accountId: engineId ?? "", accountName: "Engine account" });
    }
  }
  return GROUP_ORDER.map((g) => ({ kind: g.kind, label: g.label, resources: out.get(g.kind) ?? [] })).filter((g) => g.resources.length > 0);
}

// withManual adds the resources the user added by id (Protect's "Add a resource by its id") to their type's
// group, with the same SRC_* binding naming, unless discovery already lists that binding.
const MANUAL_PREFIX: Record<ManualResource["kind"], string> = { kv: "SRC_KV_", r2: "SRC_R2_", d1: "SRC_D1_", secrets: "SRC_SEC_" };
const MANUAL_LABEL: Record<ManualResource["kind"], string> = { d1: "D1 databases", kv: "KV namespaces", r2: "R2 buckets", secrets: "Secrets Store secrets" };
// manualBindingFor is the SRC_* binding a resource added by its id attaches under. The engine's attach route
// refuses a binding longer than 64 characters (engine src/admin/attach-plan.ts BINDING_NAME), so Protect's
// add-by-id sheet checks this length before the resource joins the list.
export function manualBindingFor(kind: ManualResource["kind"], name: string): string {
  return bindingFor(MANUAL_PREFIX[kind], name);
}
export function withManual(groups: ResourceGroup[], manual: readonly ManualResource[], disc: SourceDiscovery, engineId: string | null): ResourceGroup[] {
  if (manual.length === 0) return groups;
  const bound = new Set([...disc.bound.kv, ...disc.bound.r2, ...disc.bound.d1, ...disc.bound.secrets]);
  const listed = new Set(groups.flatMap((g) => g.resources.map((r) => r.binding).filter((b): b is string => b !== undefined)));
  const out = groups.map((g) => ({ ...g, resources: [...g.resources] }));
  for (const mr of manual) {
    const binding = manualBindingFor(mr.kind, mr.name);
    if (listed.has(binding)) continue;
    listed.add(binding);
    const res: Resource = {
      key: `manual:${mr.kind}:${mr.id ?? ""}:${mr.name}`,
      kind: mr.kind,
      name: mr.name,
      binding,
      bound: bound.has(binding),
      accountId: engineId ?? "",
      accountName: "Added by its id",
      ...(mr.id !== undefined ? { id: mr.id } : {}),
      ...(mr.kind === "secrets" ? { secretName: mr.name } : {}),
    };
    let g = out.find((x) => x.kind === mr.kind);
    if (!g) {
      g = { kind: mr.kind, label: MANUAL_LABEL[mr.kind], resources: [] };
      out.push(g);
    }
    g.resources.push(res);
  }
  return out;
}

function accountViews(disc: SourceDiscovery): DiscoveredAccountView[] {
  return (disc.accounts ?? []).map((a) => ({ id: a.accountId, name: a.accountName, isEngineAccount: a.accountId === (disc.engineAccountId ?? null) }));
}

// ---- the store ------------------------------------------------------------------------------------------

type Listener = (s: SetupSnapshot) => void;

// RefreshScope: "full" reads every fact the setup page shows; "shell" reads only what the shell's gate, strip
// and Overview need (setup-state, the downpipe list and the first run's ring), and keeps the discovery,
// destination, policy and status facts from the last full read. Discovery asks Cloudflare live on every call,
// so the shell, which refreshes after navigations and on focus, does not.
export type RefreshScope = "full" | "shell";

export class SetupModel {
  private facts: SetupFacts = emptyFacts();
  private draft: SetupDraft = loadDraft();
  private loading = false;
  private listeners = new Set<Listener>();
  private snap: SetupSnapshot;
  private inflight: Promise<void> | null = null;
  // Bumped when the session ends (clearSession): a read that began in the old session does not write its facts
  // into the new one.
  private session = 0;
  private queued: { scope: RefreshScope; promise: Promise<void>; resolve: () => void } | null = null;
  // Set the first time the shell counts setup complete (steps.ts shellComplete) and never cleared: the model
  // lives as long as the page, so a console that was past setup is never locked again in that page's life,
  // whatever a later read says (a downpipe deleted, a binding dropped by a redeploy). Not cleared by
  // clearSession either: completeness is a fact about the engine, not about who is signed in.
  private completeSeen = false;

  // A plain field, not a constructor parameter property: the validators run TypeScript through Node's
  // type stripping, which does not support parameter properties.
  private readonly engine: () => EngineClient | null;
  // The first-backup copy this tab last wrote, so an unchanged draft is not written again.
  private carried: string | null = null;

  constructor(engine: () => EngineClient | null) {
    this.engine = engine;
    this.snap = this.derive();
  }

  get(): SetupSnapshot {
    // The ceremony lives in the store, outside this model, so re-derive when it changed under us.
    if (this.snap.runtime.ceremonyHeld !== this.ceremonyHeld()) this.snap = this.derive();
    return this.snap;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // update merges non-secret answers into the draft, persists it, and notifies.
  update(patch: Partial<SetupDraft>): void {
    this.draft = { ...this.draft, ...patch };
    saveDraft(this.draft);
    this.emit();
  }

  // touch re-derives after a change outside the model (the ceremony was set or cleared).
  touch(): void {
    this.emit();
  }

  // reset clears the draft (a fresh start). Facts are untouched: they come from the engine.
  reset(): void {
    this.draft = defaultDraft();
    saveDraft(this.draft);
    this.emit();
  }

  // clearSession forgets everything this model holds for the session that just ended (sign-out, or a 401): the
  // draft and the facts. The storage copy is already gone (clearSessionData removes the DRAFT_PREFIX family),
  // so nothing is written back. The next person to sign in on this tab starts from nothing, and never inherits
  // an acknowledged posture statement they did not read.
  clearSession(): void {
    this.session += 1;
    this.carried = null;
    this.draft = defaultDraft();
    this.facts = emptyFacts();
    this.inflight = null;
    this.queued = null;
    this.loading = false;
    this.emit();
  }

  // refresh re-reads the engine facts the steps depend on. Concurrent calls coalesce: one read runs, and a call
  // that arrives during it shares exactly one more, at the widest scope any caller asked for. That second read
  // is what the caller's promise waits for, because the running one may have begun before the change that
  // prompted the call (a save that just landed), and its answer would be stale.
  refresh(scope: RefreshScope = "full"): Promise<void> {
    if (this.inflight === null) return this.start(scope);
    if (this.queued === null) {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((r) => { resolve = r; });
      this.queued = { scope, promise, resolve };
    } else if (scope === "full") this.queued.scope = "full";
    return this.queued.promise;
  }

  private start(scope: RefreshScope): Promise<void> {
    this.loading = true;
    this.emit();
    const run = this.read(scope)
      .catch(() => {
        // read() settles every engine call itself; a throw here is a fault in this model, and the facts stay
        // as they were (fail open).
      })
      .finally(() => {
        this.inflight = null;
        this.loading = false;
        this.emit();
        const q = this.queued;
        this.queued = null;
        if (q !== null) void this.start(q.scope).then(q.resolve);
      });
    this.inflight = run;
    return run;
  }

  // setRuns records a run ring read by watchRun, so a run's progress updates the steps without a full read.
  setRuns(downpipeId: string, entries: SetupFacts["runs"][string]): void {
    this.facts = { ...this.facts, runs: { ...this.facts.runs, [downpipeId]: entries } };
    this.emit();
  }

  private async read(scope: RefreshScope): Promise<void> {
    const session = this.session;
    // A tab that has not worked on setup takes up the first-backup copy another tab of the same setup left
    // (this tab may have opened before that setup created its downpipes).
    if (draftEmpty(this.draft)) {
      const carried = carriedDraft();
      if (carried !== null) {
        this.draft = carried;
        saveDraft(carried);
      }
    }
    const engine = this.engine();
    if (engine === null) {
      this.facts = { ...this.facts, readError: "No engine is connected.", readAt: Date.now(), failedReads: ["setup-state", "downpipes"] };
      return;
    }
    const full = scope === "full";
    const [setup, pipes, disc, dest, policy, status] = await Promise.allSettled([
      engine.getSetupState(),
      engine.listDownpipes(),
      full ? engine.discoverSources() : Promise.resolve(null),
      full ? engine.getDestination() : Promise.resolve(null),
      full ? engine.getConfigApprovalPolicy() : Promise.resolve(null),
      full ? engine.status() : Promise.resolve(null),
    ]);
    const now = Date.now();
    const failed: FactRead[] = [];
    const readsAt = { ...this.facts.readsAt };
    const next: SetupFacts = { ...this.facts, readAt: now, readError: null };
    if (setup.status === "fulfilled") {
      next.setup = setup.value;
      next.keysReady = setup.value.keysReady;
      next.tokenPresent = setup.value.discoveryTokenPresent;
      readsAt["setup-state"] = now;
    } else {
      failed.push("setup-state");
      next.readError = "Could not read the setup state from your engine.";
      // Failing open is right, and leaving it silent would be a fault of its own: "unknown" means no gate, so
      // a setup-state read that quietly fails leaves the strip absent on an engine that is not set up, with
      // nothing in a support pack to say why. The row names the READ, with its HTTP class, and nothing else.
      recordReadDegraded("setup-state", setup.reason);
    }
    if (pipes.status === "fulfilled") {
      next.downpipes = pipes.value;
      readsAt.downpipes = now;
    } else failed.push("downpipes");
    if (full) {
      if (disc.status === "fulfilled" && disc.value !== null) {
        next.engineAccountId = disc.value.engineAccountId ?? null;
        next.accounts = disc.value.tokenPresent ? accountViews(disc.value) : [];
        const acct = (disc.value.accounts ?? []).find((a) => a.accountId === next.engineAccountId);
        next.engineR2Buckets = acct ? acct.r2.map((b) => b.name) : [];
        next.groups = withManual(buildGroups(disc.value, this.draft.tokenScope === "minimal"), this.draft.manual, disc.value, next.engineAccountId);
        next.discoveryReadAt = now;
        readsAt.discovery = now;
      } else failed.push("discovery");
      if (dest.status === "fulfilled" && dest.value !== null) {
        next.destinations = dest.value.present === false ? [] : [dest.value];
        readsAt.destination = now;
      } else failed.push("destination");
      if (policy.status === "fulfilled" && policy.value !== null) {
        next.restoreApproval = policy.value.requireRestoreApproval ?? null;
        readsAt["approval-policy"] = now;
      } else failed.push("approval-policy");
      if (status.status === "fulfilled" && status.value !== null) {
        const st = status.value;
        // engineHoldsUsableOperationalKey, not raw presence: an operational pair left bound beside the
        // OPERATIONAL_RETIRED marker (a strict re-key that did not remove it) still reports "operational"
        // off presence alone, but the engine opens no run with it, so this label must read break-glass-only.
        next.enginePosture = st.signerConfigured && st.breakGlassConfigured ? (engineHoldsUsableOperationalKey(st) ? "operational" : "break-glass-only") : null;
        next.engineVersion = typeof st.engineVersion === "string" && st.engineVersion !== "" ? st.engineVersion : null;
        readsAt.status = now;
      } else failed.push("status");
    }
    // The destination bucket is never offered as a source: an archive backed up into itself grows without
    // bound (destination-form-fields.ts circularity warn).
    const destBucket = next.setup?.destination.bucket ?? (this.draft.provider === "r2" ? this.draft.bucket : "");
    if (destBucket) {
      next.groups = next.groups.map((g) => g.kind !== "r2" ? g : { ...g, resources: g.resources.map((r) => r.name === destBucket && r.accountId === next.engineAccountId ? { ...r, unavailable: "This is your backup destination." } : r) });
    }
    // Run rings for this setup's own runs: the downpipes it created and the runs it started (few; the first
    // backup's progress is read by watchRun).
    const own = new Set(this.draft.createdDownpipeIds);
    if (this.draft.firstRun !== null) own.add(this.draft.firstRun.downpipeId);
    for (const r of this.draft.startedRuns) own.add(r.downpipeId);
    const ids = [...own].filter((id) => next.downpipes.some((d) => d.config.id === id));
    const rings = await Promise.allSettled(ids.map((id) => engine.listHistory(id)));
    const runs = { ...next.runs };
    ids.forEach((id, i) => {
      const r = rings[i];
      if (r?.status === "fulfilled") runs[id] = r.value;
    });
    // A downpipe the engine no longer lists (deleted) has no runs to read: its old ring must not keep the first
    // backup open.
    for (const id of own) if (!ids.includes(id)) delete runs[id];
    next.runs = runs;
    if (session !== this.session) return;
    next.readsAt = readsAt;
    next.failedReads = failed;
    if (full) next.fullReadAt = now;
    this.facts = next;
    this.seedBoundPicks();
  }

  // seedBoundPicks: an engine deployed with SRC_* bindings already (wrangler or IaC) has chosen its sources. The
  // first time discovery lists them, and while nothing is picked and no downpipe exists, they become the picks,
  // so Protect counts as answered, shows them ticked, and First backup plans a downpipe for each. It runs once
  // per draft; the user can untick any of them on Protect.
  private seedBoundPicks(): void {
    const d = this.draft;
    if (d.boundSeeded || d.picks.length > 0 || this.facts.downpipes.length > 0 || this.facts.discoveryReadAt === 0) return;
    const bound = this.facts.groups.flatMap((g) => g.resources.filter((r) => r.bound && r.binding !== undefined && r.unavailable === undefined).map((r) => r.key));
    if (bound.length === 0) return;
    this.draft = { ...d, picks: bound, boundSeeded: true };
    saveDraft(this.draft);
  }

  private ceremonyHeld(): boolean {
    return isCeremonyResult(getCeremony());
  }

  private derive(): SetupSnapshot {
    const runtime: SetupRuntime = { ceremonyHeld: this.ceremonyHeld() };
    const { steps, current } = computeSteps(this.facts, this.draft, runtime);
    if (shellComplete(this.facts, steps)) this.completeSeen = true;
    return { facts: this.facts, draft: this.draft, runtime, steps, current, protectedNow: firstRunSealed(this.facts, this.draft), completeSeen: this.completeSeen, loading: this.loading };
  }

  // syncCarry keeps the first-backup copy (see the header) in step with this tab's draft: written while the
  // first backup this setup started is not done, removed once it is. Only on facts both shell reads answered, so
  // an unread engine never looks like an unfinished backup.
  private syncCarry(): void {
    const d = this.draft;
    if (d.createdDownpipeIds.length === 0 || !shellFactsRead(this.facts) || demoRunning()) return;
    const done = this.snap.steps.find((st) => st.id === "backup")?.status === "done";
    try {
      if (done) {
        localStorage.removeItem(SETUP_FIRST_BACKUP_KEY);
        this.carried = null;
        return;
      }
      const json = JSON.stringify(d);
      if (json === this.carried) return;
      localStorage.setItem(SETUP_FIRST_BACKUP_KEY, json);
      this.carried = json;
    } catch {
      // Storage blocked: the draft lasts in this tab only.
    }
  }

  private emit(): void {
    this.snap = this.derive();
    this.syncCarry();
    for (const fn of [...this.listeners]) {
      try {
        fn(this.snap);
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
  }
}

let instance: SetupModel | null = null;

// setupModel is the one model per tab. The engine getter is the store's, read at each refresh; a validator
// may pass its own on the first call.
export function setupModel(engine?: () => EngineClient | null): SetupModel {
  if (instance === null) {
    const m = new SetupModel(engine ?? getEngine);
    instance = m;
    onSessionCleared(() => m.clearSession());
  }
  return instance;
}

// pickedResources resolves the draft's picks against the discovered resources (a pick whose resource is no
// longer listed is dropped from the answer, not from the draft).
export function pickedResources(s: SetupSnapshot): Resource[] {
  const picked = new Set(s.draft.picks);
  return s.facts.groups.flatMap((g) => g.resources.filter((r) => picked.has(r.key)));
}
