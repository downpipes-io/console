// The destination renderers, split out of destinations.ts so the screen file stays a
// thin orchestrator (guardrail: file size + function size). The MULTI-DESTINATION list now
// reads as a row table (the same dataTable the Downpipes screen uses), with a per-row detail
// drawer carrying the quiet posture and the make-default / replace / remove levers; the
// SINGLE deploy-time posture (no console record) stays a quiet card (it is one fact, not a
// list). renderSetup (the unconfigured setup form) rides along. The posture rows and the
// lever wiring are shared between the card and the drawer so neither path re-implements them.
// The lever ACTION handlers live in destination-cards-actions.ts (the same split family).
//
// No-custody invariants kept: every posture row names something the owner set, never a
// credential (the status endpoint is redaction-safe by construction); every server string
// enters the DOM via textContent / the typed h() builder.

import type { DestinationList, DestinationStatus, EngineClient } from "../api.ts";
import { type DataColumn, dataTable } from "../components/data-table.ts";
import { drawerSection, openDetailDrawer } from "../components/detail-drawer.ts";
import { sessionEnded } from "../components/error-view.ts";
import { noteQuiet, skeletonRows } from "../components/feedback.ts";
import { badge, statusWithLabel } from "../components/status.ts";
import { toast } from "../components/toast.ts";
import { h } from "../lib/dom.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { absoluteTime, relativeTime } from "../lib/format.ts";
import { goSignedOut } from "../lib/nav.ts";
import { canDo, collapsedSection, gateReason } from "./common.ts";
import {
  errMsg,
  makeDefault,
  removeDestination,
  renderConsoleLevers,
  renderDeployFallback,
  toggleReplaceForm,
  verifyDestination,
} from "./destination-cards-actions.ts";
import { destinationForm } from "./destination-form.ts";
import type { Provider } from "./destination-form-fields.ts";
import { loadFormContext } from "./destination-form-fields.ts";

// ---------------------------------------------------------------------------
// The unconfigured state: one centred setup form (the screen's whole work surface).
// ---------------------------------------------------------------------------

export function renderSetup(engine: EngineClient, reload: () => void): HTMLElement {
  // dataset.tourId: the inert training-walk anchor (the tour's data-tour-id idiom); the walk's
  // destination chapter pins its spotlight on this setup card. No behaviour on the genuine console.
  const card = h("div", { class: "card measure", style: "margin:0 auto;display:grid;gap:var(--space-4)", dataset: { tourId: "destination-form" } });
  card.appendChild(
    h(
      "p",
      "Backups need a place to land before anything else works. Connect a bucket you own, prove it writable, and every downpipe writes sealed archives into it.",
    ),
  );
  const host = h("div");
  card.appendChild(host);
  host.replaceChildren(skeletonRows(4));
  // The form benefits from discovery (the engine account's bucket list + the derived
  // endpoint) and the downpipe list (the archive-into-a-source warn). Both are
  // best-effort: a failure just leaves the plain inputs.
  void loadFormContext(engine).then((fctx) => {
    if (fctx === null) {
      // A 401 already routed to signed-out, and PAINT FIRST, THEN LEAVE applies to the routing too: this
      // host is a four-row skeleton and the sign-in route is the only thing that was going to replace it.
      host.replaceChildren(sessionEnded());
      return;
    }
    host.replaceChildren(destinationForm(engine, fctx, { confirmReplace: false, onSaved: reload }));
  });
  return card;
}

// ---------------------------------------------------------------------------
// The multi-destination state: a row table (matching /downpipes), plus an add-another form.
// Each row activates a detail drawer carrying the posture and the levers, so the list reads
// as an orderly table and the per-destination detail stays one click away.
// ---------------------------------------------------------------------------

export function renderList(engine: EngineClient, list: DestinationList, reload: () => void): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-5)" });
  // Add a destination, ABOVE the table, mounted on first open so it stays cheap and
  // the table remains the screen's one eager section.
  const formHost = h("div");
  let mounted = false;
  const details = collapsedSection("Add a destination", formHost) as HTMLDetailsElement;
  details.addEventListener("toggle", () => {
    if (!details.open || mounted) return;
    mounted = true;
    formHost.replaceChildren(skeletonRows(3));
    void loadFormContext(engine).then((fctx) => {
      if (fctx === null) {
        // A 401 already routed to signed-out; the disclosure body is a skeleton until something replaces it.
        formHost.replaceChildren(sessionEnded());
        return;
      }
      formHost.replaceChildren(destinationForm(engine, fctx, { confirmReplace: false, onSaved: reload }));
    });
  });
  wrap.appendChild(details);
  wrap.appendChild(destinationTable(engine, list, reload));
  return wrap;
}

// destinationTable builds the row table over the configured destinations. The columns name
// what the owner set, never a credential (the status endpoint is redaction-safe by
// construction); activating a row opens the detail drawer (posture + levers). count is
// carried into the drawer so the Remove copy can warn when it is the last one.
function destinationTable(engine: EngineClient, list: DestinationList, reload: () => void): HTMLElement {
  const count = list.destinations.length;
  const columns: Array<DataColumn<DestinationStatus>> = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      sortValue: (st) => st.label ?? st.bucket ?? "",
      render: (st) =>
        h(
          "span",
          { class: "dp-name" },
          h("span", { class: "linklike" }, st.label ?? "The archive bucket"),
          st.bucket ? h("span", { class: "dp-name__sub mono" }, st.bucket) : null,
        ),
    },
    {
      key: "provider",
      header: "Provider",
      sortable: true,
      sortValue: (st) => providerKind(st),
      render: (st) => providerBadge(st),
    },
    {
      key: "endpoint",
      header: "Endpoint",
      sortable: true,
      sortValue: (st) => st.endpointHost ?? "",
      render: (st) =>
        st.endpointHost
          ? h(
              "span",
              { class: "dp-name" },
              h("span", { class: "mono" }, st.endpointHost),
              st.region ? h("span", { class: "dp-name__sub mono" }, st.region) : null,
            )
          : h("span", { class: "field__hint" }, "not reported"),
    },
    {
      key: "immutability",
      header: "Immutability",
      sortable: true,
      sortValue: (st) => immutabilitySort(st),
      render: (st) => immutabilityCell(st),
    },
    {
      key: "default",
      header: "Default",
      sortable: true,
      sortValue: (st) => (st.isDefault ? 0 : 1),
      render: (st) => (st.isDefault ? badge("ok", "default") : h("span", { class: "field__hint" }, "-")),
    },
    {
      key: "verified",
      header: "Verified",
      numeric: true,
      sortable: true,
      sortValue: (st) => st.verifiedAt ?? null,
      render: (st) =>
        st.verifiedAt !== undefined
          ? h("span", { class: "mono", title: absoluteTime(st.verifiedAt) }, relativeTime(st.verifiedAt))
          : h("span", { class: "field__hint" }, "never"),
    },
  ];

  return dataTable<DestinationStatus>({
    label: "Destinations",
    rows: list.destinations,
    rowKey: (st) => st.id ?? st.bucket ?? "default",
    onRowActivate: (st) => openDestinationDrawer(engine, st, reload, count),
    columns,
    filter: {
      placeholder: "Filter by name, bucket or endpoint   ( / )",
      resultLabel: "destinations",
      getText: (st) => `${st.label ?? ""} ${st.bucket ?? ""} ${st.endpointHost ?? ""} ${st.region ?? ""}`,
    },
    initialSort: { key: "name", dir: "asc" },
  }).el;
}

// AZURE_STORAGE_SUFFIXES mirrors the engine's closed list of Azure Storage endpoint suffixes, one per
// Azure cloud (AZURE_STORAGE_SUFFIXES in engine/src/dest/provider.ts):
//
//   core.windows.net        the commercial cloud
//   core.usgovcloudapi.net  Azure US Government
//   core.chinacloudapi.cn   Azure China, operated by 21Vianet
//
// THE CONSOLE KNEW ONLY THE FIRST OF THE THREE UNTIL, so a sovereign-cloud Azure destination
// that the engine routes to its Azure client and its Shared Key signer was badged S3 in the operator's own
// destination list. The badge is the sentence that tells them where their archives go, and for a US
// Government or China-cloud account it named the wrong vendor. The list is written out here rather than
// matched loosely for the same reason the engine writes it out: a nearly-right suffix is a host that never
// resolves, and the two closed clouds that are absent from the engine's list (Microsoft Cloud Germany,
// closed in 2021, and the US air-gapped clouds) are absent from this one too, so the two agree by
// construction.
export const AZURE_STORAGE_SUFFIXES: readonly string[] = ["core.windows.net", "core.usgovcloudapi.net", "core.chinacloudapi.cn"];

// AZURE_BLOB_HOST is built from that list the way the engine builds its own, so a cloud added to the list
// is admitted by the matcher in the same edit. The leading "\." is what makes it a match on the ACCOUNT
// LABEL rather than on a bare string ending: without it "notablob.core.windows.net" would read as an Azure
// host, and the "$" is what stops "acct.blob.core.windows.net.evil.example" reading as one. Every dot in a
// suffix is escaped, so a suffix cannot smuggle a regex metacharacter into the pattern.
const AZURE_BLOB_HOST = new RegExp(`\\.blob\\.(?:${AZURE_STORAGE_SUFFIXES.map((sfx) => sfx.replace(/\./g, "\\.")).join("|")})$`, "i");

// providerKind derives the storage provider from the redaction-safe status: an R2 endpoint host (the
// Cloudflare S3-compatible endpoint) reads as R2; Google Cloud Storage's single S3-interop host reads as
// GCS; an Azure Blob endpoint in any Azure cloud reads as Azure; the deploy-time envKind is the fallback
// for an env record without an endpoint host; everything else is an S3-compatible store.
//
// This MIRRORS the engine's own providerForEndpoint (engine/src/dest/provider.ts), which is the
// authority. The console cannot import it across the repo boundary, so the shape is kept deliberately
// identical, including the difference between the two matches: a WHOLE-HOST match for GCS, so a look-alike
// domain ("storage.googleapis.com.evil.example") is not labelled Google, and a SUFFIX match for Azure,
// because Azure's blob endpoint carries the storage account as its first label and so is a different host
// for every account.
function providerKind(st: DestinationStatus): Provider {
  const host = (st.endpointHost ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (/(^|\.)r2\.cloudflarestorage\.com$/.test(host)) return "r2";
  if (host === "storage.googleapis.com") return "gcs";
  if (AZURE_BLOB_HOST.test(host)) return "azure";
  if (st.envKind) return st.envKind;
  return "s3";
}

// PROVIDER_BADGE gives each provider its label and tone. R2 (in-account, the preferred case) reads trust;
// the out-of-account stores read neutral, because any of them can move data out of the Cloudflare account
// and the drawer carries the honest residency note. The label is always present (never colour alone), and
// naming Google or Azure rather than showing a generic "S3" is the point of the whole provider derivation:
// an operator reading their destination list should see where the archives actually go.
const PROVIDER_BADGE: Readonly<Record<Provider, { tone: "trust" | "default"; label: string }>> = {
  r2: { tone: "trust", label: "R2" },
  s3: { tone: "default", label: "S3" },
  gcs: { tone: "default", label: "GCS" },
  azure: { tone: "default", label: "Azure" },
};

function providerBadge(st: DestinationStatus): HTMLElement {
  // The deploy-time binding (source:"deploy") has no console-stored
  // endpoint host (the engine cannot see the wrangler binding's own vendor from inside the scheduler DO),
  // so providerKind's host-sniff falls through to its "s3" default -- a specific, wrong guess is worse
  // here than an honest "configured at deploy" label, which this row already carries as a second badge
  // (openDestinationDrawer) and the table can show sooner, before a click.
  if (st.source === "deploy") return badge("default", "deploy-time");
  const b = PROVIDER_BADGE[providerKind(st)];
  return badge(b.tone, b.label);
}

// immutabilitySort orders the column so the strongest, proven posture surfaces first on an
// ascending sort: enforced Object-Lock, then a configured-but-not-enforced policy (a warning),
// then unknown, then off.
function immutabilitySort(st: DestinationStatus): number {
  if (st.objectLock === "enforced") return 0;
  if (st.objectLock === "not-enforced" && st.worm !== undefined) return 1;
  if (st.worm !== undefined) return 2;
  return 3;
}

// immutabilityCell renders the per-row immutability read, keyed on the LIVE store verdict
// (objectLock), never the configured policy alone: a policy on a bucket without Object-Lock
// protects nothing, and claiming otherwise would be dishonest. Off reads as a plain dash.
//
// The not-enforced cell reads "writes refused" and is a DANGER, not a warning (corrected).
// It used to read "not enforced", which is true of the probe verdict and understates the consequence to
// the point of misleading: a reader takes it as a working destination with a weaker guarantee. Both R2
// (501 NotImplemented) and AWS S3 (ObjectLockConfigurationNotFoundError) REFUSE a write carrying the lock
// headers when the bucket has no Object-Lock configuration, so the destination holds nothing at all. The
// table row is the only surface that carries this without opening the drawer, so it says the consequence.
function immutabilityCell(st: DestinationStatus): HTMLElement {
  if (st.objectLock === "enforced") return statusWithLabel("ok", "Object-Lock");
  if (st.worm !== undefined && st.objectLock === "not-enforced") return statusWithLabel("danger", "writes refused");
  if (st.worm !== undefined) return statusWithLabel("neutral", `${st.worm.mode}, unverified`);
  return h("span", { class: "field__hint" }, "off");
}

// ---------------------------------------------------------------------------
// One destination's detail drawer: the quiet posture rows, the honest immutability /
// object-lock notes, and the make-default / replace / remove / verify levers in the footer.
// Opened from a table row (no URL route: it is a transient detail, not a deep link). count is
// how many destinations exist, so the Remove confirm can warn when it is the last one.
// ---------------------------------------------------------------------------

function openDestinationDrawer(engine: EngineClient, st: DestinationStatus, reload: () => void, count: number): void {
  const ownerGate = canDo("owner");
  const body = h("div");
  body.appendChild(drawerSection("Posture", renderPostureRows(engine, st, reload, ownerGate)));

  // A configured WORM policy on a bucket that does not enforce Object-Lock is the dangerous case, and the
  // danger is not a missing guarantee. The store REFUSES every write that carries the lock headers (R2
  // answers 501 NotImplemented, AWS S3 answers ObjectLockConfigurationNotFoundError), so the destination
  // receives nothing at all. This note used to say the headers were ignored and archives were not
  // protected, which told the reader they had a working destination with a weaker guarantee when they had
  // no working destination. Object-Lock must be enabled when the bucket is created; it cannot be turned on
  // afterwards, so the only fixes are a new bucket or turning the policy off.
  if (st.worm !== undefined && st.objectLock === "not-enforced") {
    body.appendChild(
      noteQuiet(
        h("p", "An immutability policy is set, but this bucket does not enforce Object-Lock, so the store refuses every write that carries the lock headers and no backups can reach this destination. Object-Lock has to be enabled when the bucket is created; it cannot be turned on later. Recreate the bucket with Object-Lock enabled, or set the mode to Off."),
      ),
    );
  }
  // The object-lock posture, stated as the honest trade it is (often deliberate).
  if (st.deleteProbe === "denied") {
    body.appendChild(
      noteQuiet(h("p", "This bucket refuses deletes (object lock). Honest trade: archives are immutable, and retention pruning cannot run.")),
    );
  }
  // Once a second destination joins a deploy-bound one, THIS row is the
  // deploy-time binding itself, now a real, permanent member of the collection (engine
  // ensureDeployDestSeeded) rather than the single implicit fallback the screen used to show as one quiet
  // card. It carries no console-stored credential, so there is nothing for Replace to act on -- said here,
  // beside the row it describes, rather than leaving the lever to answer a submit with a raw refusal.
  if (st.source === "deploy") {
    body.appendChild(
      noteQuiet(h("p", "This is the destination configured at deploy time (a wrangler binding or environment variable), not a console-stored credential, so there is nothing here to replace. It keeps every run it holds until every one of them has a proven copy on another destination.")),
    );
  }
  // The visible gate reason for the owner-only levers (one line, reachable by keyboard, touch
  // and assistive technology alike).
  if (!ownerGate) {
    body.appendChild(h("p", { class: "field__hint" }, `${gateReason("owner")} Verifying, replacing or removing the destination is an Owner action.`));
  }

  // The replace form mounts inside the drawer body on demand (the drawer footer's Replace
  // action reveals it), so opening the drawer stays cheap until the owner asks to edit.
  const replaceHost = h("div", { hidden: true });
  body.appendChild(replaceHost);

  const badges: Node[] = [providerBadge(st)];
  if (st.isDefault) badges.push(badge("ok", "default"));
  if (st.source === "deploy") badges.push(badge("default", "configured at deploy"));

  const handle = openDetailDrawer({
    title: st.label ?? "The archive bucket",
    ...(st.bucket ? { meta: h("span", { class: "mono" }, st.bucket) } : {}),
    badges,
    body,
    // Keyed the same way the row's own dataTable identifies it (rowKey above): this drawer is
    // opened from a table row, not today's deep link, but it is built on the SAME shared
    // openDetailDrawer as the credentials/downpipes/runs/map drawers, all of which share one
    // idempotency guard (dialog.ts). Keying every caller closes the whole class of hazard rather
    // than only the one instance that was independently reproduced live.
    key: `destination-detail:${st.id ?? st.bucket ?? "default"}`,
    actions: buildDrawerActions(engine, st, reload, count, ownerGate, replaceHost, () => handle.close()),
  });
}

// buildDrawerActions assembles the drawer footer levers: Verify now (a live re-probe), Make
// default (when it is not already), Replace (reveal the edit form in the drawer body), Remove
// (a danger confirm). All owner-gated, disabled-with-reason for everyone else. close is the
// drawer's own close, called before a reload re-renders the list.
type DrawerActions = NonNullable<Parameters<typeof openDetailDrawer>[0]["actions"]>;
function buildDrawerActions(
  engine: EngineClient,
  st: DestinationStatus,
  reload: () => void,
  count: number,
  ownerGate: boolean,
  replaceHost: HTMLElement,
  close: () => void,
): DrawerActions {
  const reason = gateReason("owner");
  const actions: DrawerActions = [
    {
      label: "Verify now",
      ...(ownerGate ? {} : { disabled: true, disabledReason: reason, gateOp: "destination-verify" as const }),
      onClick: () => verifyDestination(engine, st, reload),
    },
  ];
  if (st.id !== undefined && !st.isDefault) {
    actions.push({
      label: "Make default",
      ...(ownerGate ? {} : { disabled: true, disabledReason: reason, gateOp: "destination-set-default" as const }),
      onClick: () => makeDefault(engine, st, reload),
    });
  }
  // The deploy-time binding (source:"deploy") has no console-stored
  // credential, so Replace has nothing to act on -- the engine refuses that id outright (putDest: "that
  // destination id is reserved"). Omitted rather than shown disabled: a disabled Replace on every OTHER
  // row means "you lack the Owner role", and reusing that shape here would say the same wrong thing to an
  // Owner who has every right to replace a real destination's credentials, just not this one's absent ones.
  if (st.source !== "deploy") {
    actions.push({
      label: "Replace",
      ...(ownerGate ? {} : { disabled: true, disabledReason: reason, gateOp: "destination-upsert" as const }),
      onClick: () => toggleReplaceForm(engine, st, reload, replaceHost),
    });
  }
  actions.push({
    label: "Remove",
    variant: "danger",
    ...(ownerGate ? {} : { disabled: true, disabledReason: reason, gateOp: "destination-delete" as const }),
    onClick: () => removeDestination(engine, st, count, reload, close),
  });
  return actions;
}

// ---------------------------------------------------------------------------
// One destination card: the quiet posture card kept for the SINGLE deploy-time posture
// (no console record, source "deploy"), where a row table would be a one-row table. The
// make-default / replace / remove levers ride below it. count is how many destinations exist.
// ---------------------------------------------------------------------------

export function renderConfigured(engine: EngineClient, st: DestinationStatus, reload: () => void, count = 0): HTMLElement {
  const ownerGate = canDo("owner");
  const wrap = h("div", { style: "display:grid;gap:var(--space-5)" });
  const headingId = `dest-card-${st.id ?? "env"}`;

  const card = h("section", { class: "card", "aria-labelledby": headingId, style: "display:grid;gap:var(--space-3)" });
  card.appendChild(
    h(
      "div",
      { class: "card__header", style: "margin-bottom:0;justify-content:flex-start;gap:var(--space-3)" },
      h("h2", { class: "card__title", id: headingId }, st.label ?? "The archive bucket"),
      st.isDefault ? badge("ok", "default") : null,
      st.source === "deploy" ? badge("default", "configured at deploy") : null,
    ),
  );

  card.appendChild(renderPostureRows(engine, st, reload, ownerGate));

  // A configured WORM policy on a bucket that does not enforce Object-Lock is the dangerous case, and the
  // danger is not a missing guarantee. The store REFUSES every write that carries the lock headers (R2
  // answers 501 NotImplemented, AWS S3 answers ObjectLockConfigurationNotFoundError), so the destination
  // receives nothing at all. This note used to say the headers were ignored and archives were not
  // protected, which told the reader they had a working destination with a weaker guarantee when they had
  // no working destination. Object-Lock must be enabled when the bucket is created; it cannot be turned on
  // afterwards, so the only fixes are a new bucket or turning the policy off.
  if (st.worm !== undefined && st.objectLock === "not-enforced") {
    card.appendChild(
      noteQuiet(
        h("p", "An immutability policy is set, but this bucket does not enforce Object-Lock, so the store refuses every write that carries the lock headers and no backups can reach this destination. Object-Lock has to be enabled when the bucket is created; it cannot be turned on later. Recreate the bucket with Object-Lock enabled, or set the mode to Off."),
      ),
    );
  }

  // The object-lock posture, stated as the honest trade it is (often deliberate).
  if (st.deleteProbe === "denied") {
    card.appendChild(
      noteQuiet(h("p", "This bucket refuses deletes (object lock). Honest trade: archives are immutable, and retention pruning cannot run.")),
    );
  }

  // The visible gate reason for the owner-only levers above and below (one line for
  // the card, reachable by keyboard, touch and assistive technology alike).
  if (!ownerGate) {
    card.appendChild(h("p", { class: "field__hint" }, `${gateReason("owner")} Verifying, replacing or removing the destination is an Owner action.`));
  }

  if (st.id !== undefined || st.source === "console") {
    renderConsoleLevers(engine, st, reload, count, ownerGate, wrap, card);
  } else {
    renderDeployFallback(engine, st, reload, wrap, card);
  }

  return wrap;
}

// renderPostureRows builds the quiet posture rows (bucket / endpoint / region / set-by /
// verified, plus the STS-auth and immutability rows when notable): names the owner set,
// never a credential (the status endpoint is redaction-safe by construction). The Verified
// row carries the owner-only Verify now re-probe. Returns the rows element for the card/drawer.
function renderPostureRows(engine: EngineClient, st: DestinationStatus, reload: () => void, ownerGate: boolean): HTMLElement {
  // The posture rows: names the owner set, never a credential (the status endpoint is
  // redaction-safe by construction). An absent field reads "not reported", never a guess.
  const rows = h("div", { class: "stack-sm" });
  rows.appendChild(kvLine("Bucket", st.bucket ? h("span", { class: "mono" }, st.bucket) : "not reported"));
  rows.appendChild(kvLine("Endpoint", st.endpointHost ? h("span", { class: "mono" }, st.endpointHost) : "not reported"));
  rows.appendChild(kvLine("Region", st.region ? h("span", { class: "mono" }, st.region) : "not reported"));
  // Authentication posture: shown for the two NOTABLE readings, since a stored long-lived key is the
  // unremarkable default. Honest on both: STS still stores a long-lived principal key scoped to
  // assume-role only, and an Entra destination still stores a long-lived client secret.
  //
  // THE ENTRA ROW WAS MISSING ENTIRELY UNTIL. This branch read only "sts", and the engine
  // answered "keys" for an Entra destination, so the card showed no authentication row at all: a customer
  // could not tell from the console that the destination signs in as a service principal against
  // Microsoft's identity platform rather than with a storage account key.
  if (st.authMode === "entra") {
    rows.appendChild(
      kvLine(
        "Authentication",
        h(
          "span",
          { style: "display:inline-flex;gap:var(--space-3);align-items:baseline;flex-wrap:wrap" },
          h("span", "Microsoft Entra service principal"),
          st.azureEntra ? h("span", { class: "mono" }, `app ${st.azureEntra.clientId}`) : null,
        ),
      ),
    );
  }
  if (st.authMode === "sts") {
    rows.appendChild(
      kvLine(
        "Authentication",
        h(
          "span",
          { style: "display:inline-flex;gap:var(--space-3);align-items:baseline;flex-wrap:wrap" },
          h("span", "STS AssumeRole"),
          st.assumeRoleArn ? h("span", { class: "mono" }, st.assumeRoleArn) : null,
        ),
      ),
    );
  }
  if (st.present) {
    rows.appendChild(
      kvLine("Set by", h("span", st.setBy ?? "unknown", st.setAt !== undefined ? `, ${absoluteTime(st.setAt)}` : "")),
    );
  }

  // Verified: when, plus the Verify now re-probe (owner-only server-side; the engine
  // re-checks the EFFECTIVE destination exactly as a run resolves it). Gated levers
  // render disabled with the reason as VISIBLE text below the card (the tokenEntry
  // pattern), never a hover-only title (no keyboard or touch path).
  const verifyLink = (ownerGate
    ? h("button", { "data-busy-label": "Verifying", "data-dp": "destination-cards.button.verify-link#1", class: "linklike", type: "button" }, "Verify now")
    : h("button", { "data-dp": "destination-cards.button.verify-link#2", class: "linklike", type: "button", disabled: true }, "Verify now")) as HTMLButtonElement;
  if (ownerGate) {
    verifyLink.addEventListener("click", () => {
      verifyLink.disabled = true;
      verifyLink.textContent = "Verifying";
      void engine
        .verifyDestination(st.id)
        .then((res) => {
          if (res.ok) {
            toast({ message: res.ms !== undefined ? `Destination reachable and authorised (${res.ms}ms).` : "Destination reachable and authorised." });
          } else {
            toast({ message: res.reason ? `Destination did not verify: ${res.reason}` : "Destination did not verify (no reason reported).", tone: "warn" });
          }
          reload();
        })
        .catch((err) => {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE: nothing was verified, so the control comes back off "Verifying".
            verifyLink.disabled = false;
            verifyLink.textContent = "Verify now";
            return goSignedOut();
          }
          toast({ message: `Could not verify the destination (${errMsg(err)}).`, tone: "warn" });
          verifyLink.disabled = false;
          verifyLink.textContent = "Verify now";
        });
    });
  }
  rows.appendChild(
    kvLine(
      "Verified",
      h(
        "span",
        { style: "display:inline-flex;gap:var(--space-3);align-items:baseline" },
        st.verifiedAt !== undefined ? h("span", { title: absoluteTime(st.verifiedAt) }, relativeTime(st.verifiedAt)) : h("span", "never"),
        verifyLink,
      ),
    ),
  );
  // Immutability (WORM / Object-Lock). The badge is keyed on the LIVE store verdict (objectLock), NEVER on
  // the configured policy alone: a policy on a bucket that does not enforce Object-Lock protects nothing,
  // and claiming otherwise would be dishonest. A configured-but-not-enforced policy is shown as a warning,
  // and the note below it carries the consequence, which is that the store refuses the write outright.
  if (st.worm !== undefined || st.objectLock === "enforced") {
    const lock = st.objectLock;
    const lockBadge =
      lock === "enforced"
        ? badge("ok", "Object-Lock enforced", { dot: true })
        : lock === "not-enforced"
          ? badge("warn", "not enforced by the bucket", { dot: true })
          : badge("neutral", "enforcement unknown", { dot: true });
    rows.appendChild(
      kvLine(
        "Immutability",
        h(
          "span",
          { style: "display:inline-flex;gap:var(--space-3);align-items:baseline;flex-wrap:wrap" },
          st.worm !== undefined ? h("span", `${st.worm.mode}, ${st.worm.retentionDays} days`) : h("span", "off"),
          lockBadge,
        ),
      ),
    );
  }
  // Retention: what the most recent prune pass did against this destination's bucket. Always one
  // quiet row, so "is retention working" has a standing answer rather than appearing only on trouble.
  rows.appendChild(kvLine("Retention", retentionLine(st)));
  return rows;
}

// timeAt renders a timestamp in the row idiom the Verified row already uses: relative text with the
// absolute time on the title. Renders what arrived; never invents a fallback date.
function timeAt(at: number): HTMLElement {
  return h("span", { title: absoluteTime(at) }, relativeTime(at));
}

// objectCount phrases what reclaimed counts: OBJECTS (run-tree objects plus orphaned segments), never
// bytes. The prune planner reads no object bodies, so a byte figure does not exist for it.
function objectCount(n: number): string {
  return `${n} ${n === 1 ? "object" : "objects"}`;
}

// retentionLine renders the ONE Retention row from the lastPrune sidecar. Absent means "no prune
// recorded", never "retention has never run": an engine older than the sidecar and a not-yet-run pass are
// indistinguishable on the wire, so the copy claims neither. The outcome half drives the tone; the
// reclaim half (lastApplied) survives a later deferral, so the last real reclaim stays visible under a
// warn line.
//
// BINDING INVARIANT: a destination whose delete probe was refused ("denied") never
// renders a reclaimed count. A count on that posture would claim deletions on a bucket that refuses
// them; the deletes-refused line cross-references the object-lock note below instead, so the two reads
// name one posture rather than two disconnected mysteries.
function retentionLine(st: DestinationStatus): HTMLElement {
  const line = h("span", { style: "display:inline-flex;gap:var(--space-3);align-items:baseline;flex-wrap:wrap" });
  const lp = st.lastPrune;
  if (lp === undefined) {
    line.appendChild(h("span", "No prune recorded."));
    return line;
  }
  const denied = st.deleteProbe === "denied";
  const o = lp.lastOutcome;
  const applied = lp.lastApplied;
  if (o.wormBlocked === true) {
    line.appendChild(statusWithLabel("warn", "deletes refused"));
    line.appendChild(
      h(
        "span",
        denied
          ? "object lock refused the last pass's deletes, the same refusal the object-lock note below records"
          : "object lock refused the last pass's deletes",
      ),
    );
    line.appendChild(timeAt(o.at));
  } else if (o.outcome === "deferred") {
    line.appendChild(statusWithLabel("warn", "deferred"));
    const reason =
      o.deferClass === "retained-run-unreadable"
        ? "a retained run could not be read, so deleting would be unsafe and the pass held off"
        : o.deferClass === "runlog-absent"
          ? "no run log was found on this bucket, so the pass held off"
          : "the pass held off";
    line.appendChild(h("span", reason));
    line.appendChild(timeAt(o.at));
  } else if (o.outcome === "error") {
    line.appendChild(statusWithLabel("warn", "error"));
    line.appendChild(h("span", "the last pass failed; it retries on the next pass"));
    line.appendChild(timeAt(o.at));
  } else if (o.outcome === "paused") {
    line.appendChild(statusWithLabel("warn", "paused"));
    line.appendChild(h("span", "the retention downpipes writing here are paused, so the pass left them alone"));
    line.appendChild(timeAt(o.at));
  } else if (o.outcome === "dry-run") {
    line.appendChild(statusWithLabel("neutral", "dry run"));
    line.appendChild(h("span", "retention enforcement is off, so passes plan deletions but delete nothing"));
    line.appendChild(timeAt(o.at));
  } else if (o.outcome === "applied") {
    line.appendChild(statusWithLabel("ok", "applied"));
    if (!denied && applied !== undefined) {
      line.appendChild(h("span", `reclaimed ${objectCount(applied.reclaimed)}`));
      line.appendChild(timeAt(applied.at));
    } else {
      line.appendChild(timeAt(applied?.at ?? o.at));
    }
    return line;
  } else {
    line.appendChild(statusWithLabel("ok", "nothing to prune"));
    line.appendChild(timeAt(o.at));
  }
  // The last real reclaim, kept visible under a non-applied outcome (a week of deferrals must not erase
  // the answer to "when did it last actually reclaim"). Never on a delete-refusing destination.
  if (!denied && applied !== undefined) {
    line.appendChild(
      h("span", { class: "field__hint", title: absoluteTime(applied.at) }, `last reclaimed ${objectCount(applied.reclaimed)} ${relativeTime(applied.at)}`),
    );
  }
  return line;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

// kvLine is one posture row: a fixed label column with the value immediately to its
// right (a definition-list reading, not flung to opposite edges). A grid keeps the
// label column aligned down the card and the values left-aligned beside it, so the
// pair reads as one fact regardless of how wide the card is.
function kvLine(label: string, value: Node | string): HTMLElement {
  const valueEl = h("span", { style: "min-width:0;overflow-wrap:anywhere" });
  if (typeof value === "string") valueEl.appendChild(document.createTextNode(value));
  else valueEl.appendChild(value);
  return h(
    "div",
    { style: "display:grid;grid-template-columns:7.5rem minmax(0,1fr);gap:var(--space-2) var(--space-4);align-items:baseline" },
    h("span", { class: "section-label" }, label),
    valueEl,
  );
}
