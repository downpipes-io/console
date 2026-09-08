// Validate that the standalone "Add a source" screen now offers the TWO TOKEN sources (Cloudflare
// configuration + Workers scripts) alongside the four BINDING stores, gated on the engine
// advertising them, and that picking one hands off into the create-downpipe wizard with the source
// pre-selected. Two layers, no jsdom, no network (the engine api + nav are stubbed; the DOM uses the
// shared shim). Run with `node test/validate-token-source.ts`.
//
// Layer A (pure: src/lib/token-source.ts + the wizard's prefillFromQuery round-trip):
//   - tokenSourceOffered reads the SAME discovery signals the wizard gates on: cf-config when
//     cfConfigSurfaces is non-empty, workers when workersSupported === true; neither on an empty or
//     undefined response (fail-soft).
//   - tokenSourceCreateQuery / tokenSourceCreatePath build the EXACT create-route query the picker
//     navigates to (type + optional account/zone for cf-config, type + optional account/prefix for
//     workers), and prefillFromQuery round-trips it back to an EditorPrefill (no cross-field leak).
//
// Layer B (the REAL addSourceScreen rendered under the DOM shim):
//   - the picker offers cf-config + workers buttons WHEN the engine advertises them, and HIDES them
//     when it does not (and when discovery fails), always keeping the four binding buttons;
//   - selecting a token source HIDES the binding steps (identifiers + attach) and shows the hand-off
//     panel whose Continue navigates to /downpipes/new?type=<token source> (the exact bridge query);
//   - the BINDING flow is UNCHANGED: the four buttons are present and selecting kv shows the binding
//     id fields with the attach step visible (no hand-off).

import { installDomShim, qsa, qs, textOf, flushAsync } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
installDomShim();

import {
  TOKEN_SOURCE_TYPES,
  TOKEN_SOURCE_META,
  tokenSourceOffered,
  tokenSourceCreateQuery,
  tokenSourceCreatePath,
  tokenSourceLabel,
  tokenSourceSummary,
  isTokenSourceType,
} from "../src/lib/token-source.ts";
import type { SourceDiscovery } from "../src/api.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { h as domH } from "../src/lib/dom.ts";
import { prefillFromQuery, sourcesDownpipesScreen } from "../src/screens/sources-downpipes.ts";
import { openEditor } from "../src/screens/sources-downpipes/editor-upsert.ts";
import { addSourceScreen } from "../src/screens/add-source.ts";
import type { Caller, DownpipeState, StatusReport, DestinationStatus, DestinationList, OwnerActionResult, Downpipe } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: string, want: string): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}\n    got=${JSON.stringify(got)}\n    want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// A discovery response builder: only the fields the gates read matter; the rest are empty.
function disc(over: Partial<SourceDiscovery>): SourceDiscovery {
  return { bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: false, ...over };
}
const SURFACES = [{ id: "dns", label: "DNS records", category: "Zone", scope: "zone" as const, restoreTier: "out-of-band" }];

// ---------------------------------------------------------------------------
console.log("\n-- Layer A.1: tokenSourceOffered mirrors the wizard's gates --");
// ---------------------------------------------------------------------------

{
  const both = tokenSourceOffered(disc({ cfConfigSurfaces: SURFACES, workersSupported: true }));
  ok("cf-config offered when cfConfigSurfaces is non-empty", both["cf-config"] === true);
  ok("workers offered when workersSupported === true", both.workers === true);

  const cfOnly = tokenSourceOffered(disc({ cfConfigSurfaces: SURFACES }));
  ok("cf-config offered, workers NOT, when only surfaces present", cfOnly["cf-config"] === true && cfOnly.workers === false);

  const wkOnly = tokenSourceOffered(disc({ workersSupported: true }));
  ok("workers offered, cf-config NOT, when only workersSupported", wkOnly.workers === true && wkOnly["cf-config"] === false);

  const neither = tokenSourceOffered(disc({}));
  ok("neither offered on a bare discovery (older engine)", neither["cf-config"] === false && neither.workers === false);

  ok("empty cfConfigSurfaces array does NOT offer cf-config", tokenSourceOffered(disc({ cfConfigSurfaces: [] }))["cf-config"] === false);
  ok("workersSupported:false does NOT offer workers", tokenSourceOffered(disc({ workersSupported: false })).workers === false);

  const failSoft = tokenSourceOffered(undefined);
  ok("a FAILED discovery (undefined) offers neither (fail-soft)", failSoft["cf-config"] === false && failSoft.workers === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- Layer A.2: the create-route query the picker hands off + the wizard round-trip --");
// ---------------------------------------------------------------------------

// The exact bridge query the "Add a source" picker uses (type only, the common hand-off).
eq("cf-config bare hand-off path", tokenSourceCreatePath({ type: "cf-config" }), "/downpipes/new?type=cf-config");
eq("workers bare hand-off path", tokenSourceCreatePath({ type: "workers" }), "/downpipes/new?type=workers");

// With an optional pre-selection (the inline-form path, if ever used): keys match prefillFromQuery.
eq("cf-config with zone + account", tokenSourceCreateQuery({ type: "cf-config", account: "acc1", zone: "zone9" }), "type=cf-config&account=acc1&zone=zone9");
eq("workers with account", tokenSourceCreateQuery({ type: "workers", account: "acc1" }), "type=workers&account=acc1");
// Cross-field values never leak across the two shapes: a zone only ever rides on cf-config.
eq("workers drops a stray zone", tokenSourceCreateQuery({ type: "workers", zone: "zone9" }), "type=workers");
// Empty / whitespace optional fields are dropped.
eq("blank optionals are dropped", tokenSourceCreateQuery({ type: "workers", account: "  " }), "type=workers");

// Round-trip: the query the picker emits parses back to the right EditorPrefill (the actual hand-off).
{
  const p = prefillFromQuery(new URLSearchParams(tokenSourceCreateQuery({ type: "cf-config" })));
  ok("cf-config bare round-trips to type=cf-config", p.type === "cf-config" && p.accountId === undefined && p.zoneId === undefined);
}
{
  const p = prefillFromQuery(new URLSearchParams(tokenSourceCreateQuery({ type: "cf-config", account: "acc1", zone: "zone9" })));
  ok("cf-config+zone round-trips with account+zone", p.type === "cf-config" && p.accountId === "acc1" && p.zoneId === "zone9");
}
{
  const p = prefillFromQuery(new URLSearchParams(tokenSourceCreateQuery({ type: "workers", account: "acc1" })));
  ok("workers round-trips with account", p.type === "workers" && p.accountId === "acc1");
  ok("workers prefill carries NO zoneId", p.zoneId === undefined);
}
// The four binding types still parse exactly as before (back-compat).
{
  const p = prefillFromQuery(new URLSearchParams("binding=SRC_KV_x&type=kv"));
  ok("binding hand-off unchanged (type=kv + binding)", p.type === "kv" && p.binding === "SRC_KV_x" && p.accountId === undefined);
}
{
  const p = prefillFromQuery(new URLSearchParams("type=secrets&secretBinding=SRC_S_x"));
  ok("secrets hand-off unchanged (type=secrets + secretBinding)", p.type === "secrets" && p.secretBinding === "SRC_S_x");
}
// Native resource ids ride the attach-success bridge so a new downpipe records them with zero manual entry.
{
  const p = prefillFromQuery(new URLSearchParams("binding=SRC_KV_x&type=kv&namespaceId=ns-123"));
  ok("kv bridge carries namespaceId", p.type === "kv" && p.namespaceId === "ns-123");
}
{
  const p = prefillFromQuery(new URLSearchParams("binding=SRC_R2_x&type=r2&bucketName=my-bucket"));
  ok("r2 bridge carries bucketName", p.type === "r2" && p.bucketName === "my-bucket");
}
{
  const p = prefillFromQuery(new URLSearchParams("binding=SRC_D1_x&type=d1&databaseId=db-uuid"));
  ok("d1 bridge carries databaseId", p.type === "d1" && p.databaseId === "db-uuid");
}
{
  const p = prefillFromQuery(new URLSearchParams("type=secrets&secretBinding=SRC_S_x&storeId=store-abc"));
  ok("secrets bridge carries storeId as secretStoreId", p.type === "secrets" && p.secretStoreId === "store-abc");
}
// An unknown / absent type yields an empty prefill (never a token field from nowhere).
ok("unknown type yields empty prefill", Object.keys(prefillFromQuery(new URLSearchParams("type=bogus"))).length === 0);
ok("isTokenSourceType narrows correctly", isTokenSourceType("cf-config") && isTokenSourceType("workers") && !isTokenSourceType("kv") && !isTokenSourceType(null));

// The meta copy is honest (states the token-based / no-binding model; workers names reprovision).
ok("cf-config summary states token-based, no binding", /token-based/.test(TOKEN_SOURCE_META["cf-config"].summary) && /no binding/.test(TOKEN_SOURCE_META["cf-config"].summary));
ok("workers summary states reprovision restore", /reprovision/.test(TOKEN_SOURCE_META.workers.summary));
ok("stream summary states reprovision restore", /reprovision/.test(TOKEN_SOURCE_META.stream.summary));
ok("images summary states reprovision restore", /reprovision/.test(TOKEN_SOURCE_META.images.summary));
ok("artifacts summary states reprovision restore", /reprovision/.test(TOKEN_SOURCE_META.artifacts.summary));
ok("TOKEN_SOURCE_TYPES is exactly cf-config, workers, stream, images, artifacts", TOKEN_SOURCE_TYPES.join(",") === "cf-config,workers,stream,images,artifacts");

// ---------------------------------------------------------------------------
console.log("\n-- Layer B: the REAL Add-a-source picker (rendered under the DOM shim) --");
// ---------------------------------------------------------------------------

// Stub the nav bridge so a Continue click's navigate() is captured (not executed).
let lastNav: string | null = null;
installNav({
  navigate: (to: string) => { lastNav = to; },
  onUnauthorised: () => {},
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  signOut: () => {},
});

const OWNER: Caller = { method: "passkey", email: "o@test", role: "owner", groups: [], isOnlyOwner: true };
const VIEWER: Caller = { method: "passkey", email: "v@test", role: "viewer", groups: [], isOnlyOwner: false };

// renderPicker connects a stub engine whose discoverSources resolves the given response (or rejects),
// sets the caller, renders the REAL screen, and drains async so the token buttons append.
async function renderPicker(found: SourceDiscovery | "reject", caller: Caller = OWNER): Promise<unknown> {
  const engine = connect("https://engine.test");
  (engine as unknown as { discoverSources: () => Promise<SourceDiscovery> }).discoverSources = () =>
    found === "reject" ? Promise.reject(new Error("discovery down")) : Promise.resolve(found);
  setCaller(caller);
  lastNav = null;
  const root = addSourceScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/sources/add" } as never);
  await flushAsync();
  return root;
}

// The picker's source buttons (the radiogroup), read by their rendered label text.
function pickerLabels(root: unknown): string[] {
  const group = qs(root, '[role="radiogroup"]');
  if (!group) return [];
  return qsa(group, '[role="radio"]').map((b) => textOf(b).trim());
}

// B.1: both token sources advertised: the picker shows all six choices.
{
  const root = await renderPicker(disc({ cfConfigSurfaces: SURFACES, workersSupported: true }));
  const labels = pickerLabels(root);
  ok("four binding stores present", ["KV namespace", "R2 bucket", "D1 database", "Secrets Store secret"].every((l) => labels.includes(l)));
  ok(`cf-config offered in the picker (label "${tokenSourceLabel("cf-config")}")`, labels.includes(tokenSourceLabel("cf-config")));
  ok(`workers offered in the picker (label "${tokenSourceLabel("workers")}")`, labels.includes(tokenSourceLabel("workers")));
  ok("picker has exactly six choices when both advertised", labels.length === 6);
}

// B.2: neither advertised: only the four bindings; no token buttons.
{
  const root = await renderPicker(disc({}));
  const labels = pickerLabels(root);
  ok("picker has only the four bindings when neither advertised", labels.length === 4);
  ok("cf-config hidden when not advertised", !labels.includes(tokenSourceLabel("cf-config")));
  ok("workers hidden when not advertised", !labels.includes(tokenSourceLabel("workers")));
}

// B.2b: discovery FAILS: the four bindings still stand (the failure never blocks the screen), but the
// failed READ is now STATED. A silently shortened picker would otherwise be indistinguishable from an
// engine that genuinely offers nothing more.
{
  const root = await renderPicker("reject");
  const labels = pickerLabels(root);
  ok("picker still offers the four bindings when discovery rejects (the failure never blocks the screen)", labels.length === 4 && !labels.includes(tokenSourceLabel("workers")));
  const text = textOf(root);
  ok("a rejected discovery says the catalogue could not be READ", text.includes("could not be read"));
  ok("and says it is a failed read, NOT an empty account", text.includes("not an empty account"));
  ok("and offers a retry", text.includes("Retry the read"));
}

// B.2b-ii: discovery SUCCEEDS: the failed-read notice must not appear (a signal that cries wolf is worse
// than no signal).
{
  const root = await renderPicker(disc({ workersSupported: true }));
  ok("a successful discovery shows no failed-read notice", !textOf(root).includes("could not be read"));
}

// B.2c: only one advertised: just that token source is added.
{
  const root = await renderPicker(disc({ workersSupported: true }));
  const labels = pickerLabels(root);
  ok("only workers added when only workersSupported", labels.includes(tokenSourceLabel("workers")) && !labels.includes(tokenSourceLabel("cf-config")) && labels.length === 5);
}

// B.3: selecting a TOKEN source hides the binding steps + shows the hand-off, and Continue navigates
// to the exact create-route query.
{
  const root = await renderPicker(disc({ cfConfigSurfaces: SURFACES, workersSupported: true }));
  const group = qs(root, '[role="radiogroup"]')!;
  const radios = qsa(group, '[role="radio"]');
  // The cf-config button is the one whose label is the cf-config label.
  const cfBtn = radios.find((b) => textOf(b).trim() === tokenSourceLabel("cf-config"))!;
  ok("cf-config button found to click", !!cfBtn);
  (cfBtn as unknown as { click: () => void }).click();
  await flushAsync();

  // The binding-id field (#as-binding) must now be hidden (its ancestor bindingSteps is hidden).
  const bindingInput = qs(root, "#as-binding");
  // The bindingSteps wrapper is hidden; assert no VISIBLE attach button / identifiers heading remains.
  const headings = qsa(root, ".page-header__title").map((n) => textOf(n));
  ok("the identifiers/attach steps are replaced by a Continue step heading", headings.some((t) => /Continue on the downpipe/.test(t)));
  // The hand-off panel's Continue button navigates to the create route with type=cf-config.
  const buttons = qsa(root, "button");
  const cont = buttons.find((b) => /Continue to set up the .* downpipe/.test(textOf(b)));
  ok("a Continue (hand-off) button is shown for the token source", !!cont);
  (cont as unknown as { click: () => void }).click();
  await flushAsync();
  eq("Continue navigates to the cf-config create route", lastNav ?? "", "/downpipes/new?type=cf-config");
  // The summary line states it is configured on the downpipe (the honest hand-off copy).
  ok("the hand-off explains config is configured on the downpipe", /configured on the downpipe/.test(textOf(root)));
  // Sanity: the binding input node exists in the tree but inside the hidden steps (back-compat node).
  ok("the binding field node still exists (only hidden, not destroyed)", !!bindingInput);
}

// B.3b: workers hand-off navigates to type=workers.
{
  const root = await renderPicker(disc({ workersSupported: true }));
  const group = qs(root, '[role="radiogroup"]')!;
  const wkBtn = qsa(group, '[role="radio"]').find((b) => textOf(b).trim() === tokenSourceLabel("workers"))!;
  (wkBtn as unknown as { click: () => void }).click();
  await flushAsync();
  const cont = qsa(root, "button").find((b) => /Continue to set up the .* downpipe/.test(textOf(b)))!;
  (cont as unknown as { click: () => void }).click();
  await flushAsync();
  eq("Continue navigates to the workers create route", lastNav ?? "", "/downpipes/new?type=workers");
  ok("the workers hand-off names reprovision restore", /reprovision/.test(textOf(root)));
}

// B.4: the BINDING flow is UNCHANGED: selecting kv shows the binding id fields + the attach step,
// and does NOT navigate anywhere (no hand-off).
{
  const root = await renderPicker(disc({ cfConfigSurfaces: SURFACES, workersSupported: true }));
  const group = qs(root, '[role="radiogroup"]')!;
  const kvBtn = qsa(group, '[role="radio"]').find((b) => textOf(b).trim() === "KV namespace")!;
  (kvBtn as unknown as { click: () => void }).click();
  await flushAsync();
  // The KV namespace id field is present + visible (its block not hidden); the binding field present.
  const kvNs = qs(root, "#as-kv-ns");
  ok("KV id field present after selecting KV", !!kvNs);
  ok("binding name field present after selecting KV", !!qs(root, "#as-binding"));
  // The attach step heading is back; no Continue-handoff button.
  const headings = qsa(root, ".page-header__title").map((n) => textOf(n));
  ok("the attach step is shown for a binding store", headings.some((t) => /Attach it to the engine/.test(t)));
  ok("no token hand-off button for a binding store", !qsa(root, "button").some((b) => /Continue to set up the .* downpipe/.test(textOf(b))));
  ok("selecting a binding store navigates nowhere", lastNav === null);
}

// B.5: a Viewer (no downpipe.write) sees the explanation, never the picker (the gate is unchanged).
{
  const root = await renderPicker(disc({ cfConfigSurfaces: SURFACES, workersSupported: true }), VIEWER);
  ok("viewer sees no source picker (gated)", !qs(root, '[role="radiogroup"]'));
  ok(
    "viewer sees the PERMISSION explanation in customer language, not the raw capability id",
    /permission to create or edit downpipes/i.test(textOf(root)) && !/downpipe write capability/i.test(textOf(root)) && !/downpipe\.write/.test(textOf(root)),
  );
}

// ---------------------------------------------------------------------------
console.log("\n-- Layer C: the create WIZARD auto-selects the token source from the hand-off query --");
// ---------------------------------------------------------------------------
// Drive the REAL sources-downpipes screen at /downpipes/new?type=<token source> and assert the
// wizard's source step lands with the matching token-source row CHECKED (and, for cf-config, the
// per-surface panel shown), proving the prefill actually selects the right source end-to-end.

const STATUS: StatusReport = {
  service: "engine", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
  operationalConfigured: { public: true, private: false }, destConfigured: true, destKind: "r2",
  updateChannelConfigured: false, licenceConfigured: true, downpipeCount: 0, ready: true,
};
const DEST: DestinationStatus = { present: true, bucket: "archive", endpointHost: "r2.example" };
const DEST_LIST: DestinationList = { destinations: [{ present: true, id: "d1", label: "Archive", bucket: "archive", isDefault: true }], defaultId: "d1" };

// renderWizard connects a stub engine for the whole create flow and renders the screen at the create
// route with the given query, draining async so the wizard's source step builds + auto-selects.
async function renderWizard(query: string, found: SourceDiscovery): Promise<unknown> {
  // Clear any prior wizard/overlay from the document so a stale checked radio from an earlier
  // sub-test cannot be read first (each render appends a fresh screen + overlay to document.body).
  (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  const engine = connect("https://engine.test");
  const stub = engine as unknown as Record<string, unknown>;
  stub.listDownpipes = async (): Promise<DownpipeState[]> => [];
  stub.status = async (): Promise<StatusReport> => STATUS;
  stub.getDestination = async (): Promise<DestinationStatus> => DEST;
  stub.listDestinations = async (): Promise<DestinationList> => DEST_LIST;
  stub.discoverSources = async (): Promise<SourceDiscovery> => found;
  setCaller(OWNER);
  const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(query), pattern: "/downpipes/new" } as never);
  // The screen mounts to a detached root; mark it connected so its in-place logic runs, then drain.
  (root as { connectedRoot_?: boolean }).connectedRoot_ = true;
  document.body.appendChild(root as never);
  await flushAsync(20);
  return root;
}

// The wizard renders into an overlay appended to document.body, so read the whole document. We assert
// on the checked row's id (stable: wiz-cfg-account-<acc> / wiz-cfg-zone-<zone> / wiz-wk-account-<acc>),
// the same key the auto-select targets, rather than the value attribute (the DOM shim's input.value
// getter does not reflect the value ATTRIBUTE, only a property write; the id is reliable in both).
// The source step's container is role="group" since the multi-select landed (the checkbox groups
// and the token-source radios coexist, mutually exclusive), so the checked radio is read from it.
function checkedSourceId(): string | null {
  const checked = qsa(document.body, '[role="group"] input').find((r) => (r as { checked?: boolean }).checked);
  return checked ? ((checked as { id?: string }).id ?? null) : null;
}

// C.1: a cf-config hand-off (account-wide, no zone) ticks the account-wide cf-config checkbox, and
// the scope preset control (its console-side replacement for the old per-surface panel) appears.
{
  const found = disc({
    cfConfigSurfaces: [{ id: "acct-settings", label: "Account settings", category: "Account", scope: "account", restoreTier: "out-of-band" }],
    workersSupported: true,
    engineAccountId: "acc1",
    accounts: [{ accountId: "acc1", accountName: "Acme", kv: [], r2: [], d1: [], secrets: [], zones: [], errors: [] }],
  });
  await renderWizard("type=cf-config", found);
  ok("cf-config hand-off ticks the account-wide cf-config checkbox", checkedSourceId() === "wiz-cfacct-acc1");
  ok("the cf-config scope preset is shown after auto-select", /Account configuration only/.test(textOf(document.body)));
}

// C.2: a workers hand-off selects the (sole) workers account row.
{
  const found = disc({
    workersSupported: true,
    engineAccountId: "acc1",
    accounts: [{ accountId: "acc1", accountName: "Acme", kv: [], r2: [], d1: [], secrets: [], zones: [], errors: [] }],
  });
  await renderWizard("type=workers", found);
  ok("workers hand-off selects the workers account row", checkedSourceId() === "wiz-wk-account-acc1");
}

// C.3: a cf-config hand-off naming a specific zone ticks THAT zone's checkbox (not the account-wide one).
{
  const found = disc({
    cfConfigSurfaces: SURFACES,
    engineAccountId: "acc1",
    accounts: [{ accountId: "acc1", accountName: "Acme", kv: [], r2: [], d1: [], secrets: [], zones: [{ id: "z9", name: "example.com" }], errors: [] }],
  });
  await renderWizard("type=cf-config&account=acc1&zone=z9", found);
  // The zone checkbox group is a selectableSourceList (../src/screens/sources/shared.ts), whose own
  // id scheme is `sel-<groupId>-<value>`; the wizard's zone group id is `wiz-cfzone-<accountId>`.
  ok("cf-config zone hand-off ticks the named zone's checkbox (not the account-wide one)", checkedSourceId() === "sel-wiz-cfzone-acc1-z9");
}

// checkedIds returns every checked input's id under the source step's group, so a MULTI-tick (2+
// zones) can be asserted, unlike checkedSourceId's single-match.
function checkedIds(): string[] {
  return qsa(document.body, '[role="group"] input')
    .filter((r) => (r as { checked?: boolean }).checked)
    .map((r) => (r as { id?: string }).id ?? "");
}
function tick(el: unknown, checked: boolean): void {
  (el as { checked: boolean }).checked = checked;
  (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(makeEvent({ type: "change", bubbles: true }));
}

// C.4: the multi-zone BULK tick -- ticking several zone checkboxes
// queues one downpipe each (mirroring kv/r2/d1's multi-select exactly), and switching the scope
// preset to "Account configuration only" clears any ticked zones rather than leaving an invisible
// tick that would still create a downpipe (a real defect this test caught: the preset's own clear
// used to reach for tokenRows, which never carried zone checkboxes, so nothing actually unticked).
{
  const found = disc({
    cfConfigSurfaces: SURFACES,
    engineAccountId: "acc1",
    accounts: [{
      accountId: "acc1", accountName: "Acme", kv: [], r2: [], d1: [], secrets: [],
      zones: [{ id: "z1", name: "alpha.example" }, { id: "z2", name: "beta.example" }, { id: "z3", name: "gamma.example" }],
      errors: [],
    }],
  });
  await renderWizard("", found);
  const z1 = qs(document.body, "#sel-wiz-cfzone-acc1-z1");
  const z2 = qs(document.body, "#sel-wiz-cfzone-acc1-z2");
  ok("both zone checkboxes exist before any tick", z1 !== null && z2 !== null);
  tick(z1, true);
  tick(z2, true);
  const afterTicks = checkedIds();
  ok("ticking 2 zones checks BOTH (a multi-select, not a radio)", afterTicks.includes("sel-wiz-cfzone-acc1-z1") && afterTicks.includes("sel-wiz-cfzone-acc1-z2"));
  ok("3 zones -> the preset defaults to \"This zone only\" (zone-only), not the wasteful account+zone", (qs(document.body, "select[aria-label=\"Cloudflare configuration scope\"]") as unknown as { value: string } | null)?.value === "zone-only");
  // Switch the preset to "Account configuration only": the two ticked zones must be UNTICKED (the
  // regression this test guards), since a zone tick is meaningless and invisible under that preset.
  const presetSel = qs(document.body, "select[aria-label=\"Cloudflare configuration scope\"]") as unknown as { value: string; dispatchEvent: (e: unknown) => void } | null;
  ok("preset select found", presetSel !== null);
  if (presetSel) {
    presetSel.value = "account-only";
    presetSel.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  const afterPresetSwitch = checkedIds();
  ok("switching to \"Account configuration only\" unticks both zones (no invisible tick survives)", !afterPresetSwitch.includes("sel-wiz-cfzone-acc1-z1") && !afterPresetSwitch.includes("sel-wiz-cfzone-acc1-z2"));
}

// ---------------------------------------------------------------------------
console.log("\n-- C.5: switching the preset TO 'account-and-zone' clears a stranded account tick --");
// The SYMMETRIC guard to C.4: switching to "account-only" clears zone ticks; switching to
// "account-and-zone" HIDES the account row, so its tick must be cleared too. Without this a hidden
// account tick silently mints a redundant standalone account downpipe -- the very account-config
// duplication the whole feature exists to prevent.
{
  const found = disc({
    cfConfigSurfaces: SURFACES,
    engineAccountId: "acc1",
    accounts: [{ accountId: "acc1", accountName: "Acme", kv: [], r2: [], d1: [], secrets: [], zones: [{ id: "z1", name: "alpha.example" }, { id: "z2", name: "beta.example" }], errors: [] }],
  });
  await renderWizard("", found);
  // Two zones default to "zone-only", under which the account-wide row is offered (the explicit "also
  // back up the account once" affordance). Tick the account row + a zone.
  const acctBox = qs(document.body, "#wiz-cfacct-acc1");
  ok("the account-wide row is offered under the zone-only default", acctBox !== null);
  tick(acctBox, true);
  tick(qs(document.body, "#sel-wiz-cfzone-acc1-z1"), true);
  ok("account row + a zone are both ticked", checkedIds().includes("wiz-cfacct-acc1") && checkedIds().includes("sel-wiz-cfzone-acc1-z1"));
  const presetSel = qs(document.body, "select[aria-label=\"Cloudflare configuration scope\"]") as unknown as { value: string; dispatchEvent: (e: unknown) => void } | null;
  ok("preset select found", presetSel !== null);
  if (presetSel) {
    presetSel.value = "account-and-zone"; // hides the account row
    presetSel.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  ok("switching to \"Account + this zone\" clears the now-hidden account tick (no redundant downpipe)", !checkedIds().includes("wiz-cfacct-acc1"));
  ok("the zone tick is kept (its row stays visible under account-and-zone)", checkedIds().includes("sel-wiz-cfzone-acc1-z1"));
}

// ---------------------------------------------------------------------------
console.log("\n-- Layer D: the 'use the advanced editor' hand-off carries the account/zone/surfaces --");
// ---------------------------------------------------------------------------
// From the wizard's source step, "Use the advanced editor" hands the picked
// TOKEN/MEDIA source off to the full editor. The hand-off must seed accountId (and the cf-config
// zone/surfaces), so the editor's Create build carries them; otherwise the engine rejects every save
// of a token/media source with no UI recovery. Each of the five token/media types is driven end to
// end: render the wizard with the hand-off, click into the advanced editor, save, and assert the
// captured addDownpipe payload carries the account (and, for cf-config, the zone).

// renderHandoff renders the wizard for a token/media hand-off, captures addDownpipe, and returns a
// driver split into its two steps -- openAdvancedEditor (click "Use the advanced editor") and
// saveEditor (fill the name, click Create) -- so a test can act inside the editor (e.g. click a
// cf-config scope-shortcut button) between the two; saveViaEditor is the original one-call
// convenience (open then save with a fixed name) kept for the existing D.1-D.5 callers.
async function renderHandoff(query: string, found: SourceDiscovery): Promise<{
  openAdvancedEditor: () => Promise<void>;
  saveEditor: (name: string) => Promise<Downpipe | null>;
  saveViaEditor: () => Promise<Downpipe | null>;
}> {
  (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  const engine = connect("https://engine.test");
  const stub = engine as unknown as Record<string, unknown>;
  let captured: Downpipe | null = null;
  stub.listDownpipes = async (): Promise<DownpipeState[]> => [];
  stub.status = async (): Promise<StatusReport> => STATUS;
  stub.getDestination = async (): Promise<DestinationStatus> => DEST;
  stub.listDestinations = async (): Promise<DestinationList> => DEST_LIST;
  stub.discoverSources = async (): Promise<SourceDiscovery> => found;
  stub.addDownpipe = async (dp: Downpipe): Promise<{ status: string }> => { captured = dp; return { status: "ok" }; };
  setCaller(OWNER);
  const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(query), pattern: "/downpipes/new" } as never);
  (root as { connectedRoot_?: boolean }).connectedRoot_ = true;
  document.body.appendChild(root as never);
  await flushAsync(20);
  const openAdvancedEditor = async (): Promise<void> => {
    const link = qsa(document.body, "button").find((b) => /Use the advanced editor/.test(textOf(b)));
    if (!link) return;
    (link as unknown as { click: () => void }).click();
    await flushAsync(20);
  };
  const saveEditor = async (name: string): Promise<Downpipe | null> => {
    // The editor is open in a fresh overlay. Fill the name field and click Create downpipe.
    const nameInput = qs(document.body, "#dp-name");
    if (nameInput) (nameInput as unknown as { value: string }).value = name;
    const create = qsa(document.body, "button").find((b) => /Create downpipe/.test(textOf(b)));
    if (!create) return null;
    (create as unknown as { click: () => void }).click();
    await flushAsync(20);
    return captured;
  };
  return {
    openAdvancedEditor,
    saveEditor,
    saveViaEditor: async (): Promise<Downpipe | null> => {
      await openAdvancedEditor();
      return saveEditor("Handoff downpipe");
    },
  };
}

const ACCT = { accountId: "acc1", accountName: "Acme", kv: [], r2: [], d1: [], secrets: [], zones: [] as Array<{ id: string; name: string }>, errors: [] as string[] };

// D.1: workers hand-off: the editor save carries accountId.
{
  const found = disc({ workersSupported: true, engineAccountId: "acc1", accounts: [{ ...ACCT }] });
  const h = await renderHandoff("type=workers&account=acc1", found);
  const dp = await h.saveViaEditor();
  ok("workers hand-off saved via the advanced editor", dp !== null);
  ok("workers editor save carries accountId (old hand-off dropped it)", (dp?.source as { accountId?: string } | undefined)?.accountId === "acc1");
}

// D.2: stream hand-off: the editor save carries accountId.
{
  const found = disc({ streamSupported: true, engineAccountId: "acc1", accounts: [{ ...ACCT }] });
  const h = await renderHandoff("type=stream&account=acc1", found);
  const dp = await h.saveViaEditor();
  ok("stream editor save carries accountId", (dp?.source as { accountId?: string } | undefined)?.accountId === "acc1");
}

// D.3: images hand-off: the editor save carries accountId.
{
  const found = disc({ imagesSupported: true, engineAccountId: "acc1", accounts: [{ ...ACCT }] });
  const h = await renderHandoff("type=images&account=acc1", found);
  const dp = await h.saveViaEditor();
  ok("images editor save carries accountId", (dp?.source as { accountId?: string } | undefined)?.accountId === "acc1");
}

// D.4: artifacts hand-off: the editor save carries accountId.
{
  const found = disc({ artifactsSupported: true, engineAccountId: "acc1", accounts: [{ ...ACCT }] });
  const h = await renderHandoff("type=artifacts&account=acc1", found);
  const dp = await h.saveViaEditor();
  ok("artifacts editor save carries accountId", (dp?.source as { accountId?: string } | undefined)?.accountId === "acc1");
}

// D.5: cf-config hand-off (with a zone): the editor save carries accountId AND zoneId.
{
  const found = disc({
    cfConfigSurfaces: [{ id: "dns", label: "DNS records", category: "Zone", scope: "zone", restoreTier: "out-of-band" }],
    engineAccountId: "acc1",
    accounts: [{ ...ACCT, zones: [{ id: "z9", name: "example.com" }] }],
  });
  const h = await renderHandoff("type=cf-config&account=acc1&zone=z9", found);
  const dp = await h.saveViaEditor();
  ok("cf-config editor save carries accountId", (dp?.source as { accountId?: string } | undefined)?.accountId === "acc1");
  ok("cf-config editor save carries zoneId (old hand-off dropped it)", (dp?.source as { zoneId?: string } | undefined)?.zoneId === "z9");
}

// D.6: the advanced editor's cf-config scope SHORTCUT buttons (editor-cf-config-section.ts):
// "This zone only" ticks exactly the zone-scoped surfaces and
// unticks the account-scoped one, so a zone-identified downpipe edited one at a time (outside the
// wizard's own bulk flow) can still stop duplicating the account config in one click.
{
  const found = disc({
    cfConfigSurfaces: [
      { id: "dns", label: "DNS records", category: "Zone", scope: "zone", restoreTier: "out-of-band" },
      { id: "acct_members", label: "Account members", category: "Access", scope: "account", restoreTier: "manual" },
    ],
    engineAccountId: "acc1",
    accounts: [{ ...ACCT, zones: [{ id: "z9", name: "example.com" }] }],
  });
  const h = await renderHandoff("type=cf-config&account=acc1&zone=z9", found);
  await h.openAdvancedEditor();
  // The editor's OWN buildCfConfigSection loads its surface catalogue via a second, independent
  // discoverSources() call; give it a tick to resolve before the shortcut button has anything to act on.
  await flushAsync(20);
  const zoneOnlyBtn = qsa(document.body, "button").find((b) => textOf(b).trim() === "This zone only");
  ok("the \"This zone only\" scope shortcut is offered for a zone-identified downpipe", !!zoneOnlyBtn);
  if (zoneOnlyBtn) { (zoneOnlyBtn as unknown as { click: () => void }).click(); }
  const dp = await h.saveEditor("Zone-only downpipe");
  const include = (dp?.source as { include?: string[] } | undefined)?.include ?? [];
  ok("\"This zone only\" restricts include to the zone-scoped surface, excluding the account one", include.length === 1 && include[0] === "dns");
  ok("\"This zone only\" switches capture mode to manual (an explicit restricted selection)", (dp?.source as { cfConfigMode?: string } | undefined)?.cfConfigMode === "manual");
}

// D.6: guard: a token/media hand-off that carried NO account refuses the editor save locally (a
// clear local error), never firing addDownpipe to lean on the engine's 400.
{
  const found = disc({ workersSupported: true, accounts: [{ ...ACCT, accountId: "" }] });
  // No account in the query and a discovery that yields no usable account id: the editor must guard.
  const h = await renderHandoff("type=workers", disc({ workersSupported: true }));
  void found;
  const dp = await h.saveViaEditor();
  ok("a token source with no accountId is refused locally (no addDownpipe)", dp === null);
}

// D.7: the advanced editor's cf-config scope shortcut "Account + this zone" -- the mirror of D.6's
// "This zone only": it ticks EVERY visible surface (zone AND account), the compact "back up
// everything for this zone, account included" shape. Narrow to zone-only FIRST (as D.6 does) so
// clicking this button next demonstrably WIDENS the pick back to every surface, proving the button's
// own effect rather than just the catalogue's default "everything ticked" load state.
{
  const found = disc({
    cfConfigSurfaces: [
      { id: "dns", label: "DNS records", category: "Zone", scope: "zone", restoreTier: "out-of-band" },
      { id: "acct_members", label: "Account members", category: "Access", scope: "account", restoreTier: "manual" },
    ],
    engineAccountId: "acc1",
    accounts: [{ ...ACCT, zones: [{ id: "z9", name: "example.com" }] }],
  });
  const h = await renderHandoff("type=cf-config&account=acc1&zone=z9", found);
  await h.openAdvancedEditor();
  // See D.6's note: the editor's OWN buildCfConfigSection loads its surface catalogue independently.
  await flushAsync(20);
  const zoneOnlyBtn = qsa(document.body, "button").find((b) => textOf(b).trim() === "This zone only");
  if (zoneOnlyBtn) { (zoneOnlyBtn as unknown as { click: () => void }).click(); }
  const acctZoneBtn = qsa(document.body, "button").find((b) => textOf(b).trim() === "Account + this zone");
  ok("the \"Account + this zone\" scope shortcut is offered for a zone-identified downpipe", !!acctZoneBtn);
  if (acctZoneBtn) { (acctZoneBtn as unknown as { click: () => void }).click(); }
  const dp = await h.saveEditor("Account and zone downpipe");
  const include = (dp?.source as { include?: string[] } | undefined)?.include ?? ["unset"];
  ok("\"Account + this zone\" widens a narrowed pick back to every visible surface (compact include:[])", include.length === 0);
  ok("\"Account + this zone\" sets capture mode to manual (an explicit preset is a manual choice, unlike the wizard's own auto form)", (dp?.source as { cfConfigMode?: string } | undefined)?.cfConfigMode === "manual");
  ok("zoneId is still carried (the shortcut only changes surfaces, never the fixed identity)", (dp?.source as { zoneId?: string } | undefined)?.zoneId === "z9");
}

// D.8: editing an EXISTING legacy single-zone cf-config downpipe (zoneId set, cfConfigMode UNSET, a
// pre-multi-zone non-empty include -- the shape every cf-config downpipe had before this feature
// existed) through openEditor directly (the real edit path: sources-downpipes.ts's "Edit" action calls
// openEditor(engine, target.config, ...)). The editor must infer MANUAL mode from the explicit legacy
// include (buildCfConfigSection mirrors the engine's resolveCfConfigMode: explicit cfConfigMode wins,
// else a non-empty include means a prior manual pick), and the scope shortcuts must act on top of that
// inferred state exactly as they do for a fresh hand-off (D.7).
{
  const found = disc({
    cfConfigSurfaces: [
      { id: "dns", label: "DNS records", category: "Zone", scope: "zone", restoreTier: "out-of-band" },
      { id: "acct_members", label: "Account members", category: "Access", scope: "account", restoreTier: "manual" },
    ],
  });
  const existingLegacy: Downpipe = {
    id: "dp-legacy-zone",
    name: "Legacy zone config",
    cadenceSeconds: 86400,
    enabled: true,
    source: { type: "cf-config", zoneId: "z9", accountId: "acc1", include: ["dns"], exclude: [] },
  };
  (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
  const engine = connect("https://engine.test");
  const stub = engine as unknown as Record<string, unknown>;
  // Written only inside the addDownpipe stub below, which the checker cannot follow, so it would
  // otherwise narrow this to null and make every assertion on it read as unreachable.
  let captured = null as Downpipe | null;
  stub.discoverSources = async (): Promise<SourceDiscovery> => found;
  stub.listDestinations = async (): Promise<DestinationList> => DEST_LIST;
  stub.addDownpipe = async (dp: Downpipe): Promise<{ status: string }> => { captured = dp; return { status: "ok" }; };
  setCaller(OWNER);
  openEditor(engine, existingLegacy, STATUS, () => {}, () => {});
  await flushAsync(20);

  const modeSel = qs(document.body, "select[aria-label=\"Cloudflare config capture mode\"]") as unknown as { value: string } | null;
  ok("a legacy downpipe (no cfConfigMode, non-empty include) infers MANUAL mode, not auto", modeSel?.value === "manual");

  const acctZoneBtn = qsa(document.body, "button").find((b) => textOf(b).trim() === "Account + this zone");
  ok("the \"Account + this zone\" scope shortcut is offered when editing an existing zone downpipe", !!acctZoneBtn);
  if (acctZoneBtn) { (acctZoneBtn as unknown as { click: () => void }).click(); }

  const saveBtn = qsa(document.body, "button").find((b) => textOf(b).trim() === "Save changes");
  ok("an existing downpipe's save button reads \"Save changes\"", !!saveBtn);
  if (saveBtn) { (saveBtn as unknown as { click: () => void }).click(); }
  await flushAsync(20);

  const include = (captured?.source as { include?: string[] } | undefined)?.include ?? ["unset"];
  ok("\"Account + this zone\" widens the legacy single-surface pick to every visible surface (include:[])", include.length === 0);
  ok("capture mode stays manual after the shortcut (an explicit preset is a manual choice)", (captured?.source as { cfConfigMode?: string } | undefined)?.cfConfigMode === "manual");
  ok("zoneId is preserved unchanged through the edit", (captured?.source as { zoneId?: string } | undefined)?.zoneId === "z9");
}

// ---------------------------------------------------------------------------
console.log("\n-- DOM-shim regression: h()'s attrs-based checked:true also sets the live property --");
// ---------------------------------------------------------------------------
// A real bug hit exactly this gap: h("input", {type:
// "checkbox", checked:true}) -- the pattern editor-cf-config-section.ts's renderCfSurfaces and the
// wizard's zone/account rows all use to pre-tick a restored selection -- only wrote the CONTENT
// attribute in the shim, leaving the live .checked property false; a test asserting .checked on such a
// checkbox would see it unticked even though it rendered ticked, hiding real product bugs behind a
// shim gap (worked around at 2 call sites with a direct property write). Pinned here, narrowly, in the
// shim itself, so a future shim change cannot reopen it.
{
  const cb = domH("input", { type: "checkbox", checked: true });
  ok("h(\"input\", {checked:true}).checked reads true as a LIVE PROPERTY, not just the attribute", cb.checked === true);
  ok("...and the content attribute is set too (attribute and property stay in sync)", cb.getAttribute("checked") === "");
}

// ---------------------------------------------------------------------------
console.log("\n-- Layer E: the Owner-only ATTACH handler (security-critical path) --");
// ---------------------------------------------------------------------------
// The binding-attach flow collects a one-shot deploy token (type=password),
// calls engine.changeBindings once, clears the token on success, and routes an isUnauthorised
// error to the signed-out flow. Drive the REAL screen with a stubbed changeBindings and assert:
//   (1) the token is cleared from the input after a successful attach;
//   (2) the attach button is re-enabled after both success and failure;
//   (3) an isUnauthorised error routes to the signed-out flow (never clears the token);
//   (4) an empty token shows the inline error WITHOUT calling changeBindings.

// renderAttach renders the picker for an Owner, selects the KV binding store, fills a valid binding
// name + KV namespace id, and returns handles to the token input and attach button plus the captured
// changeBindings calls. The engine's changeBindings is replaced with a controllable stub.
type ChangeBindingsStub = (token: string, add: unknown[], remove: unknown[]) => Promise<OwnerActionResult<{ attached: string[]; detached: string[] }>>;
// Convenience builders for the two OwnerActionResult arms the attach handler must tell apart.
const applied = (attached: string[]): OwnerActionResult<{ attached: string[]; detached: string[] }> => ({ status: "result", value: { attached, detached: [] } });
const queued = (): OwnerActionResult<{ attached: string[]; detached: string[] }> => ({ status: "queued", queued: { ownerActionQueued: true, id: "oa_attach", status: "pending" } });
async function renderAttach(changeBindings: ChangeBindingsStub): Promise<{
  root: unknown;
  tokenInput: { value: string; focus: () => void };
  attachBtn: { disabled: boolean; click: () => void };
  attachErr: () => string;
  calls: Array<{ token: string }>;
}> {
  const engine = connect("https://engine.test");
  const calls: Array<{ token: string }> = [];
  (engine as unknown as { discoverSources: () => Promise<SourceDiscovery> }).discoverSources = () => Promise.resolve(disc({}));
  (engine as unknown as { changeBindings: ChangeBindingsStub }).changeBindings = (token, add, remove) => {
    calls.push({ token });
    return changeBindings(token, add, remove);
  };
  setCaller(OWNER);
  const root = addSourceScreen.render({ params: {}, query: new URLSearchParams(), pattern: "/sources/add" } as never);
  await flushAsync();
  // KV is the default selected type, so the binding + KV id fields are already visible.
  const binding = qs(root, "#as-binding") as unknown as { value: string };
  const kvNs = qs(root, "#as-kv-ns") as unknown as { value: string };
  binding.value = "MY_KV";
  kvNs.value = "0f2ac7c1b6e0470a8c1d2e3f4a5b6c7d";
  const tokenInput = qs(root, 'input[type="password"]') as unknown as { value: string; focus: () => void };
  const attachBtn = qsa(root, "button").find((b) => /Attach this source/.test(textOf(b))) as unknown as { disabled: boolean; click: () => void };
  return {
    root, tokenInput, attachBtn, calls,
    // The visible alert text (the inline attach error / empty-token prompt), or "" when none is shown.
    attachErr: () => {
      const shown = qsa(root, 'p[role="alert"]').find((p) => !(p as { hidden?: boolean }).hidden);
      return shown ? textOf(shown) : "";
    },
  };
}

// E.1 + E.2 (success): the token is cleared, the button re-enabled, and the success card rendered after an
// APPLIED attach (status:result).
{
  const a = await renderAttach(() => Promise.resolve(applied(["MY_KV"])));
  a.tokenInput.value = "deploy-token-xyz";
  a.attachBtn.click();
  await flushAsync();
  ok("changeBindings called exactly once on a valid attach", a.calls.length === 1);
  ok("the pasted token reached changeBindings", a.calls[0]?.token === "deploy-token-xyz");
  ok("E.1 the token input is cleared after a successful attach", a.tokenInput.value === "");
  ok("E.2a the attach button is re-enabled after success", a.attachBtn.disabled === false);
  ok("E.1b the success card (Configure a downpipe) renders on an applied attach", qsa(a.root as never, "button").some((b) => /Configure a downpipe/.test(textOf(b))));
}

// E.1c (DV — dual control): a QUEUED attach (HTTP 202, status:queued) must NOT be read as a completed attach.
// This is the exact bug in this screen the fix closes: a zero-arg .then() showed "attached, verified safe" and
// the success card on any resolution, telling the operator to revoke a token still needed to complete it.
{
  const a = await renderAttach(() => Promise.resolve(queued()));
  a.tokenInput.value = "deploy-token-queued";
  a.attachBtn.click();
  await flushAsync();
  ok("changeBindings called once on the queued attach", a.calls.length === 1);
  ok("E.1c a queued attach does NOT render the success card (nothing was attached)", !qsa(a.root as never, "button").some((b) => /Configure a downpipe/.test(textOf(b))));
  ok("E.1c the attach button is re-enabled so the operator can retry after approval", a.attachBtn.disabled === false);
}

// E.2 (failure): the button is re-enabled and the token is NOT cleared after a non-auth failure.
{
  const a = await renderAttach(() => Promise.reject(new Error("attach: bucket not found")));
  a.tokenInput.value = "deploy-token-fail";
  a.attachBtn.click();
  await flushAsync();
  ok("changeBindings called once on the failing attach", a.calls.length === 1);
  ok("E.2b the attach button is re-enabled after failure", a.attachBtn.disabled === false);
  ok("the inline attach error is surfaced on failure", /not found/.test(a.attachErr()));
  ok("the token is retained on a non-auth failure (operator can retry)", a.tokenInput.value === "deploy-token-fail");
}

// E.3: an isUnauthorised error routes to the signed-out flow (onUnauthorised), not an inline error.
{
  let signedOut = 0;
  installNav({
    navigate: (to: string) => { lastNav = to; },
    onUnauthorised: () => { signedOut++; },
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });
  // The engine client throws Error("<verb>: <status>"); isUnauthorised reads the trailing 401.
  const a = await renderAttach(() => Promise.reject(new Error("change bindings: 401")));
  a.tokenInput.value = "deploy-token-401";
  a.attachBtn.click();
  await flushAsync();
  ok("E.3 an unauthorised attach routes to the signed-out flow", signedOut === 1);
  // Restore the default nav stub for any later code.
  installNav({ navigate: (to: string) => { lastNav = to; }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
}

// E.4: an empty token shows the inline error WITHOUT calling changeBindings.
{
  const a = await renderAttach(() => Promise.resolve(applied([])));
  a.tokenInput.value = "   "; // whitespace only, trims to empty
  a.attachBtn.click();
  await flushAsync();
  ok("E.4 an empty token never calls changeBindings", a.calls.length === 0);
  ok("E.4 an empty token shows the inline 'paste the deploy token' error", /deploy token/i.test(a.attachErr()));
}

// ---------------------------------------------------------------------------
void tokenSourceSummary; // referenced for completeness in the meta assertions above
console.log(failures === 0 ? "\nTOKEN-SOURCE VALIDATORS PASS" : `\n${failures} FAILURE(S)`);
// Force a clean exit: the rendered screen arms a standing auto-refresh setTimeout that would
// otherwise keep the event loop alive after the assertions complete (the screen never unmounts here).
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures > 0 ? 1 : 0);
