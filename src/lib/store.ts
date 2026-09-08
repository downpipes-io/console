// The in-memory app state. A single module-scoped store
// holds the only references to the engine client, the resolved caller (identity +
// role), the connection target, and the entity caches. Holding them in one place
// is what makes "clear sensitive state on navigation / sign-out" a single call. Nothing here is
// persisted except the connection target and
// the theme (theme lives in lib/theme.ts); no key material is ever stored here.

import * as callerState from "./caller-state.ts";
import { EngineClient, type Caller, type DownpipeState, type RunHistoryEntry, type DestinationStatus, type ExpiryStatus } from "../api.ts";
import { recordStorageBlocked, recordTransportFault } from "./client-diag/ring.ts";
import { setProxiedTopology } from "./api/topology.ts";

// The connection target persists (so a refresh keeps the operator pointed at
// their engine) under this key. It holds ONLY the engine URL (this origin), never a
// token and never a secret; the bearer token, when used, lives in memory only.
const CONN_KEY = "dp-engine-url";

interface StoreState {
  engine: EngineClient | null;
  engineUrl: string | null;
  // Entity caches the palette and screens share (kept small; screens own refresh).
  downpipes: DownpipeState[] | null;
  runsByDownpipe: Map<string, RunHistoryEntry[]>;
  // Redaction-safe SEARCH caches the global palette search fills on its first settled
  // query, so a known fleet's destinations / tracked credentials / runs match without a
  // fetch on every keystroke (the same once-then-cache pattern as `downpipes`). Each holds
  // only names / labels / ids / counts (never a secret or a key); each entry pairs an id
  // with its owning downpipe so a run-id match deep-links to /runs/:downpipeId/:index.
  destinationsForSearch: DestinationStatus[] | null;
  credentialsForSearch: ExpiryStatus[] | null;
  runsForSearch: Array<{ runId: string; index: number; downpipeId: string }> | null;
  // In-memory key-ceremony material reference, so it can be cleared in one call.
  // Typed loosely here (the ceremony types live in keygen.ts) to keep the store
  // dependency-light; the keys screen sets and clears it.
  ceremony: unknown | null;
  // Whether the in-memory ceremony is a DELIBERATE, WARNED re-key: the returning-owner entry card
  // showed the signer-continuity warning before generate, so its install must carry confirmRekey.
  // Held here (not only in a render closure) so a re-render of the result card threads the same intent
  // back and the warned re-key still completes, including a bfcache pageshow re-render (app.ts). The
  // engine refuses a silent overwrite regardless, so this only ever carries an intent the operator was
  // warned about; a non-rekey generate sets it false, so it never leaks across ceremonies.
  ceremonyRekey: boolean;
  // The recovery posture the operator chose at the onboarding fork ("operational" =
  // install the operational key; "break-glass-only" = offline key only). The fork card sets it and
  // the generate card reads it to run the ceremony with { operational: postureChoice === "operational" },
  // so a Back/Forward round-trip between the two cards keeps the choice. Holds no key material; null
  // until a choice is made. Cleared on sign-out.
  postureChoice: "operational" | "break-glass-only" | null;
}

const state: StoreState = {
  engine: null,
  engineUrl: null,
  downpipes: null,
  runsByDownpipe: new Map(),
  destinationsForSearch: null,
  credentialsForSearch: null,
  runsForSearch: null,
  ceremony: null,
  ceremonyRekey: false,
  postureChoice: null,
};

// ---- engine connection ------------------------------------------------------

export function getEngine(): EngineClient | null {
  return state.engine;
}

export function getEngineUrl(): string | null {
  return state.engineUrl;
}

// The step-up re-auth runner (ASVS V7.5.1), set once by the app at boot via setStepUpRunner. connect /
// restoreConnection wire it onto every EngineClient as onStepUpRequired LAZILY (the closure reads the var at
// call time, so the boot order does not matter). Kept here to avoid a store<->screen import cycle: the screen
// (passkey.ts, which owns the WebAuthn ceremony) imports store, so the store cannot import it back.
let stepUpRunner: ((engine: EngineClient) => Promise<string | null>) | null = null;
export function setStepUpRunner(fn: (engine: EngineClient) => Promise<string | null>): void {
  stepUpRunner = fn;
}

// connect points the store at an engine. The URL persists (no token, no secret);
// the optional bearer token is the demoted fallback and stays in memory only.
export function connect(url: string, token?: string): EngineClient {
  state.engineUrl = url;
  state.engine = new EngineClient(url, token);
  state.engine.onStepUpRequired = () => (stepUpRunner ? stepUpRunner(state.engine!) : Promise.resolve(null));
  try {
    localStorage.setItem(CONN_KEY, url);
  } catch (err) {
    // best-effort; a blocked localStorage just means the URL is not remembered. "We have to re-point the
    // console at our engine after every refresh" IS this catch, and nothing else anywhere records it.
    recordStorageBlocked("local", "write", "engine-url", err);
  }
  return state.engine;
}

// restoreConnection re-points the store at a remembered engine URL on boot (no
// token; if the engine is behind Access the cookie rides automatically, and the
// token fallback is re-entered explicitly when needed). Returns the client or null.
export function restoreConnection(): EngineClient | null {
  if (state.engine) return state.engine;
  let url: string | null = null;
  try {
    url = localStorage.getItem(CONN_KEY);
  } catch (err) {
    // The read half of the same fault. The console silently falls back to this origin, so a customer whose
    // engine is elsewhere lands on a console pointed at the wrong place with no explanation at all.
    url = null;
    recordStorageBlocked("local", "read", "engine-url", err);
  }
  if (!url) {
    // No remembered URL: default to THIS origin, which IS the engine (the console
    // worker carries the ENGINE service binding and serves /admin/* same-origin).
    // Never persisted until a connect succeeds.
    url = location.origin;
  }
  // A remembered URL could be stale or (from an older build) a non-https origin the EngineClient
  // now rejects. Guard the construction so a bad remembered value degrades to "not connected"
  // rather than throwing on boot; the operator can re-enter a valid https engine URL.
  try {
    state.engine = new EngineClient(url);
    state.engine.onStepUpRequired = () => (stepUpRunner ? stepUpRunner(state.engine!) : Promise.resolve(null));
    state.engineUrl = url;
    return state.engine;
  } catch {
    // The remembered engine URL is POISONED. No client is constructed, so NO ENGINE CALL IS EVER
    // ATTEMPTED, and every other diagnostic in the ring is therefore silent by construction: the engine-call
    // seam never fires, the transport classifier never runs, and the pack that comes out the other end says
    // nothing is wrong with a console on which nothing works. The operator's report is "every screen says Not
    // connected"; the whole cause is a string in localStorage that a later build stopped accepting.
    //
    // The URL itself never travels. It is a customer value (their engine's hostname), and it is not needed:
    // the class alone tells support to have them re-enter the engine address, which is the entire remedy.
    recordTransportFault("stored-url-invalid");
    return null;
  }
}

// adoptProxiedTopology asks the serving worker whether it proxies the engine surface
// (the ENGINE service binding topology). When it does, THIS origin is the engine URL by
// construction, so adopt it: override any remembered split-topology hostname (stale
// after a move to the proxied topology) and persist the truth. Fail-open: any fetch or
// parse fault leaves the existing connection untouched (a split-topology console serves
// no /engine-topology.json route, so the SPA shell's HTML fallback answers and the JSON
// parse fails, which is the honest "not proxied" signal).
// It also PUBLISHES the verdict to the transport (setProxiedTopology). The transport reads a 5xx
// differently in the two topologies: a proxied engine is a SERVICE BINDING and cannot answer HTML, so an HTML
// 5xx there is a fault at the CONSOLE origin (Cloudflare's own error page in front of a console worker that
// never ran) and not the engine refusing the call. The default is false, so an unknown or split topology keeps
// the reading the console can defend.
export async function adoptProxiedTopology(): Promise<boolean> {
  try {
    const res = await fetch("/engine-topology.json", { cache: "no-store" });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !ct.includes("application/json")) return false;
    const body = (await res.json()) as Record<string, unknown>;
    if (body.proxied !== true) return false;
    setProxiedTopology(true);
    if (state.engineUrl !== location.origin) connect(location.origin);
    return true;
  } catch {
    return false;
  }
}

// ---- caller / identity ------------------------------------------------------

// These four now delegate to lib/caller-state.ts, a leaf that imports nothing but its own type. The
// store keeps the public API so no caller changes; the state simply no longer lives behind the
// EngineClient import, which is what closed the madge-flagged cycle. See caller-state.ts's header.
export function getCaller(): Caller | null {
  return callerState.getCaller();
}

export function setCaller(caller: Caller | null): void {
  callerState.setCaller(caller);
}

export function isWhoamiAvailable(): boolean {
  return callerState.isWhoamiAvailable();
}

export function setWhoamiAvailable(v: boolean): void {
  callerState.setWhoamiAvailable(v);
}

// ---- entity caches ----------------------------------------------------------

export function getDownpipesCache(): DownpipeState[] | null {
  return state.downpipes;
}

export function setDownpipesCache(list: DownpipeState[] | null): void {
  state.downpipes = list;
}

// The per-downpipe run ring is NOT WIRED, and saying so here is the point of this note.
//
// Unlike the downpipes cache immediately above (read by the command palette's entity source), nothing in
// src fills or reads this one: it is only ever cleared, by signOut and clearEntityCaches. The palette's
// own run needs are served by the separate redaction-safe `runsForSearch` snapshot below, which is what
// superseded it. So a run history screen is a fresh round trip every time, by omission rather than by
// decision, and a reader who finds a runs cache in the store would reasonably assume otherwise.
//
// It is kept rather than deleted because the clearing side is real and load-bearing: signOut and the
// tour's "Reset sample data" both prove they sweep this ring, and those assertions are how the sweep
// stays honest as caches are added. Wiring it is a deliberate call about staleness on a screen where
// freshness is the product (a cached run list can show a backup as the last one when a newer has since
// run), not a gap to fill in passing.
export function getRunsCache(downpipeId: string): RunHistoryEntry[] | undefined {
  return state.runsByDownpipe.get(downpipeId);
}

export function setRunsCache(downpipeId: string, runs: RunHistoryEntry[]): void {
  state.runsByDownpipe.set(downpipeId, runs);
}

// ---- redaction-safe search caches (the global command-palette search) -------
// Filled lazily by the palette's entity source on its first settled query and reused on
// subsequent keystrokes, mirroring the downpipes cache. They hold only names / labels /
// ids / counts; never a secret, a value or a key. Nulled on sign-out with the rest.

export function getDestinationsForSearch(): DestinationStatus[] | null {
  return state.destinationsForSearch;
}

export function setDestinationsForSearch(list: DestinationStatus[] | null): void {
  state.destinationsForSearch = list;
}

export function getCredentialsForSearch(): ExpiryStatus[] | null {
  return state.credentialsForSearch;
}

export function setCredentialsForSearch(list: ExpiryStatus[] | null): void {
  state.credentialsForSearch = list;
}

export function getRunsForSearch(): Array<{ runId: string; index: number; downpipeId: string }> | null {
  return state.runsForSearch;
}

export function setRunsForSearch(list: Array<{ runId: string; index: number; downpipeId: string }> | null): void {
  state.runsForSearch = list;
}

// ---- in-memory key material (no-custody) ------------------------------------

export function setCeremony(c: unknown | null, rekey = false): void {
  state.ceremony = c;
  // The rekey intent belongs to THIS ceremony: set it atomically so the two can never drift, and
  // never leave it true once the ceremony is cleared (setCeremony(null) resets it to false).
  state.ceremonyRekey = c ? rekey : false;
}

// getCeremony returns the loosely typed ceremony reference. The store stays dependency-light,
// so the concrete shape lives in keygen.ts; callers MUST narrow the result before use.
export function getCeremony(): unknown | null {
  return state.ceremony;
}

// getCeremonyRekey reports whether the in-memory ceremony was a deliberate, warned re-key (see
// StoreState.ceremonyRekey), so a re-render of the result card can thread confirmRekey back into the
// install. False whenever there is no ceremony, so it never carries an unwarned intent.
export function getCeremonyRekey(): boolean {
  return state.ceremonyRekey;
}

// setPostureChoice records the recovery posture chosen at the onboarding fork; getPostureChoice
// reads it back on the generate card (defaulting the ceremony to the operational key only when the
// operator explicitly chose it). Holds no key material.
export function setPostureChoice(choice: "operational" | "break-glass-only" | null): void {
  state.postureChoice = choice;
}

export function getPostureChoice(): "operational" | "break-glass-only" | null {
  return state.postureChoice;
}

// ---- clearing entity + search caches ----------------------------------------

// clearEntityCaches nulls the redaction-safe entity + command-palette search caches (the downpipe list, the
// per-downpipe run rings, and the destinations/credentials/runs search snapshots). It holds no key material;
// it is the cache half of signOut (which also clears the engine/caller/ceremony), extracted so a caller that
// wants the caches pristine WITHOUT a full sign-out can reuse the exact same set and not drift from signOut.
// The public tour's "Reset sample data" calls it so an in-place re-seed leaves no stale palette snapshot.
export function clearEntityCaches(): void {
  state.downpipes = null;
  state.runsByDownpipe.clear();
  state.destinationsForSearch = null;
  state.credentialsForSearch = null;
  state.runsForSearch = null;
}

// ---- clearing sensitive state -------------------------

// clearSensitiveState nulls the in-memory ceremony key material (state.ceremony).
// That is the only in-memory key material held by the store; it is the one field
// that must be zeroed when the operator navigates away from the key ceremony or
// confirms a save. The caller identity (state.caller) is NOT cleared here because
// it holds no key material -- it is cleared separately by signOut(), which is the
// correct place for a deliberate session end. The engine client and remembered URL
// are also kept (they hold no secret). This function is a no-op when state.ceremony
// is already null, so calling it on every non-ceremony navigation is safe.
export function clearSensitiveState(): void {
  state.ceremony = null;
  state.ceremonyRekey = false;
}

// signOut clears the in-memory engine client (and thus any in-memory bearer
// token), the caller, and the caches. Auth is at the edge, so this is a local
// clear plus guidance, not a server session kill (the signed-out screen says so).
export function signOut(): void {
  state.engine = null;
  callerState.resetCallerState();
  clearEntityCaches(); // the entity + search caches (the exact set, shared so it never drifts from this list)
  state.ceremony = null;
  state.ceremonyRekey = false;
  state.postureChoice = null;
  // The remembered URL is deliberately kept so re-authentication returns the
  // operator to the same engine; it holds no secret.
}
