import type { Provider } from "./destinations.ts";
// Source / discovery / setup-state mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

export interface SourceSpec {
  type: "kv" | "r2" | "secrets" | "d1" | "cf-config" | "workers" | "stream" | "images" | "artifacts";
  binding?: string;
  namespaceId?: string;
  bucketName?: string;
  // databaseId (d1 only): the native D1 database id, recorded so a roster re-attach can rebuild the binding
  // and match a re-attached database back to this downpipe. Mirrors namespaceId (kv) / bucketName (r2).
  databaseId?: string;
  zoneId?: string; // cf-config: the Cloudflare zone to snapshot (omit for an account-only downpipe)
  accountId?: string; // cf-config + workers: the Cloudflare account (the engine reads it with the discovery token)
  // workers is account-scoped and read with the read-only discovery token, not a per-downpipe key or a
  // binding; it captures Worker code, bindings metadata and a version inventory (secret bindings are
  // name-only). It backs up every Worker in the account: there is no script-name filter (the engine has
  // never implemented one), so the console offers none.
  // secrets (secrets source): each backed-up secret's source-native name + the env binding it is read
  // through, plus the OPTIONAL Secrets Store store id (recorded so a roster re-attach can rebuild the
  // binding; an id, never a value). storeId is carried invisibly by the editor (it is not operator-editable).
  secrets?: { name: string; binding: string; storeId?: string }[];
  // cfConfigMode (cf-config only) chooses WHICH surfaces each run captures: "auto" (the discovered
  // present set, refreshed daily, so a run is one GET per surface-in-use not all ~314) or "manual" (the
  // operator's include/exclude below). Absent = auto. Round-trips through POST /admin/downpipes.
  cfConfigMode?: "auto" | "manual";
  // includeContent (stream/images/artifacts only) also captures the resource BYTES (video/image/repo
  // blobs), size-gated, not just the metadata inventory. Absent/false = metadata only (the safe default:
  // bytes can multiply a run's size and cost). Round-trips through POST /admin/downpipes.
  includeContent?: boolean;
  include: string[];
  exclude: string[];
}

// CfConfigDiscovery mirrors the engine's cached cf-config surface-discovery result (on DownpipeState):
// which surfaces are present/empty/gated/unavailable, and when the probe ran. The console shows the
// counts + last-discovered time; `at` is epoch ms (rendered with relativeTime).
//
// gated vs unavailable (engine cf-config-discovery.ts) are BOTH surfaces the probe could not capture, and
// they used to render as one bare "unavailable" count here, which is the gap this type closed: `gated` is
// a DEFINITIVE Cloudflare account-plan/entitlement refusal (the account's plan does not carry the product,
// benign, nothing to capture, no remedy available to the operator); `unavailable` is everything else (a
// token-scope gap, a transient fault), which IS actionable -- typically a permission group missing from the
// discovery token (docs operations/cloudflare-config-backup-restore.mdx, "Permission groups the 'Read all
// resources' template does not reliably include"). The engine has always sent both as separate arrays; only
// `unavailable` was mirrored here, so `gated` silently read as undefined and the drawer could not tell a
// plan limitation from a token to fix. Both are non-optional: the engine's probeCfConfig always returns
// them (an empty array, never absent).
export interface CfConfigDiscovery {
  at: number;
  present: string[];
  empty: string[];
  gated: string[];
  unavailable: string[];
}

// SourceDiscovery is GET /admin/sources/discover: the BOUND tier (the engine's own bindings,
// creatable now) plus the opt-in ACCOUNT tier, per browsed account, everything that exists with
// the ids needed to generate a binding stanza. engineAccountId marks the one account stanzas can
// bind in (bindings attach only within the engine's own account; other accounts are honest
// visibility). tokenPresent says whether the account tier is enabled at all.
export interface DiscoveredAccount {
  accountId: string;
  accountName: string;
  kv: Array<{ id: string; name: string }>;
  r2: Array<{ name: string }>;
  d1: Array<{ id: string; name: string }>;
  secrets: Array<{ storeId: string; name: string }>;
  zones: Array<{ id: string; name: string }>; // Cloudflare zones, selectable as cf-config sources
  errors: string[];
}

export interface SourceDiscovery {
  bound: { kv: string[]; r2: string[]; d1: string[]; secrets: string[] };
  tokenPresent: boolean;
  engineAccountId?: string | null;
  accounts?: DiscoveredAccount[];
  accountErrors?: string[];
  // The Cloudflare configuration surface catalogue (metadata), so the wizard can group the
  // surfaces like KV namespaces / R2 buckets and let the operator tick exactly which to capture.
  // inBand and available are OPTIONAL because an older engine on the token path does not send them. A
  // missing inBand must read as false, never as "assume it restores": the whole reason the field exists
  // is that the picker previously implied every surface was equal.
  cfConfigSurfaces?: Array<{
    id: string;
    label: string;
    category: string;
    scope: "zone" | "account";
    restoreTier: string;
    inBand?: boolean;
    available?: boolean;
  }>;
  // workersSupported says the deployed engine can back up Workers scripts (its Workers source adapter
  // is present and the discovery token can read them). Like cfConfigSurfaces gating the cf-config source,
  // this is the engine CAPABILITY signal: the wizard offers the account-scoped Workers source only when
  // the engine advertises it (absent/false hides it cleanly on an older engine). The Workers source is
  // authenticated by the read-only discovery token and is account-scoped, so it is offered per discovered
  // account, exactly like the account-wide cf-config row, never gated on which account is the engine's own.
  workersSupported?: boolean;
  // streamSupported says the deployed engine can back up Cloudflare Stream (its 'stream' source adapter
  // is present). Like workersSupported, the console gates the account-scoped Stream add row on this; an
  // older engine that omits it hides the row cleanly.
  streamSupported?: boolean;
  // imagesSupported says the deployed engine can back up Cloudflare Images (its 'images' source adapter
  // is present). Like streamSupported, the console gates the account-scoped Images add row on this.
  imagesSupported?: boolean;
  // artifactsSupported says the deployed engine can back up Cloudflare Artifact Registry (its 'artifacts'
  // source adapter is present). Like imagesSupported, gates the account-scoped Artifacts add row.
  artifactsSupported?: boolean;
  // addedSources is the token-authenticated source TYPES the operator has explicitly ADDED on the
  // Sources screen (a subset of cf-config / workers / stream / images / artifacts). These need no
  // engine binding (the discovery token is the credential), so they were "always available" in the
  // create wizard; the engine now records which were added so the wizard offers only added types, the
  // same add-then-protect discipline a bound source has. BACKWARD-COMPATIBLE: an OLDER engine (or the
  // env-token IaC fallback) omits this field, and the console keeps the legacy "all supported" wizard
  // behaviour; a PRESENT array (even empty) means the engine gates, so the wizard shows only its members.
  addedSources?: string[];
}

// DiscoveryStatus is the presence-only configuration view (never the token): who enabled account
// browsing and when, the accounts the token saw at verification, which are browsed, and which is
// the engine's own.
export interface DiscoveryStatus {
  present: boolean;
  setAt?: number;
  setBy?: string | null;
  accountsSeen?: Array<{ id: string; name: string }>;
  selected?: string[];
  engineAccountId?: string | null;
  // The token-authenticated source types explicitly added on the Sources screen (cf-config / workers /
  // stream / images / artifacts); setEnabledSources returns the updated set so the Add UI re-reads it.
  enabledSources?: string[];
}

// AttachSourceInput is POST /admin/sources/attach's per-source wire shape (the
// engine validates and maps it to a script-settings binding). Structurally
// compatible with lib/add-source.ts's SourceInput so the catalogue's picks pass
// straight through.
export interface AttachSourceInput {
  type: "kv" | "r2" | "d1" | "secrets";
  binding: string;
  namespaceId?: string;
  bucketName?: string;
  databaseId?: string;
  databaseName?: string;
  storeId?: string;
  secretName?: string;
}

// SetupState is GET /admin/setup-state: the consolidated facts the guided first-run derives its
// steps from. Presence and counts only, never a value. DO-sourced facts (ownerExists,
// downpipeCount, anyRunCompleted) are OPTIONAL because a DO hiccup leaves them honestly absent.
export interface SetupState {
  ownerExists?: boolean;
  keysReady: boolean;
  signerConfigured: boolean;
  breakGlassConfigured: boolean;
  emailConfigured: boolean;
  discoveryTokenPresent: boolean;
  accountsSelected: boolean;
  destination: {
    configured: boolean;
    verified: boolean;
    kind: Provider | null;
    source: "console" | "deploy" | null;
    bucket?: string;
    endpointHost?: string;
  };
  boundSourceCount: number;
  downpipeCount?: number;
  anyRunCompleted?: boolean;
  ready: boolean;
}
