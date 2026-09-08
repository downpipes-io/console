// Configuration-section builders for the downpipe detail drawer (flow.md C): the resolved
// destination cell (the fan-out primary/copy labels) and the cf-config discovery + capture
// mode panel. Moved verbatim from detail.ts to keep that module under the structural
// threshold. Australian English, no em dashes, precise claims.

import type { Downpipe, DownpipeState, EngineClient, StatusReport } from "../../api.ts";
import { drawerSection, kvRow } from "../../components/detail-drawer.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { cfDiscoveryBlackout, cfRediscoverRefusalClass, cfRediscoverThrowClass, recordCatalogueDegraded } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { groupNumber, relativeTime } from "../../lib/format.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { destinationSummary, errMsg } from "./helpers.ts";

// destinationCell resolves the per-downpipe fan-out selection (dp.destinationIds; index 0 is the
// PRIMARY the run seals to, the rest are REPLICA copies, api.ts) to the real destination labels via
// the destinations list so a downpipe written to two buckets shows BOTH, not a single account-wide
// summary (the walkthrough finding: "two destinations show one"). An empty selection follows the
// account default. Loaded async like the run history; falls back to the honest one-line summary if
// the list cannot be read.
export function destinationCell(engine: EngineClient, dp: Downpipe, status: StatusReport | null): HTMLElement {
  const chosenDestIds = dp.destinationIds && dp.destinationIds.length > 0
    ? dp.destinationIds
    : dp.destinationId
      ? [dp.destinationId]
      : [];
  const destHost = h("div", { style: "display:grid;gap:var(--space-1);min-width:0" });
  destHost.appendChild(h("span", { class: "field__hint" }, "Loading destination…"));
  void engine
    .listDestinations()
    .then((list) => {
      const live = list.destinations.filter((x) => typeof x.id === "string") as Array<{ id: string; label?: string; bucket?: string; isDefault?: boolean }>;
      const byId = new Map(live.map((x) => [x.id, x]));
      const nameOf = (x: { label?: string; bucket?: string; id: string }): string => x.label ?? x.bucket ?? x.id;
      if (chosenDestIds.length === 0) {
        // Follows the account default (the common single-copy case): name the real bucket,
        // not just "In-account R2", so the drawer agrees with the Destinations screen and map.
        const def = live.find((x) => x.isDefault) ?? null;
        destHost.replaceChildren(
          def
            ? h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1);flex-wrap:wrap" }, nameOf(def), badge("neutral", "default"))
            : h("span", destinationSummary(status)),
        );
        return;
      }
      const rows = chosenDestIds.map((id, i) => {
        const x = byId.get(id);
        const kids: Array<Node | string> = [x ? nameOf(x) : id];
        if (chosenDestIds.length > 1) kids.push(badge(i === 0 ? "trust" : "neutral", i === 0 ? "primary" : "copy"));
        if (x?.isDefault) kids.push(badge("neutral", "default"));
        return h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1);flex-wrap:wrap" }, ...kids);
      });
      const note = chosenDestIds.length > 1
        ? [h("span", { class: "field__hint" }, `${chosenDestIds.length} destinations (3-2-1 fan-out): the primary is sealed first; each copy is replicated after every run.`)]
        : [];
      destHost.replaceChildren(...rows, ...note);
    })
    .catch(() => {
      destHost.replaceChildren(h("span", destinationSummary(status)));
    });
  return destHost;
}

// cfConfigDiscoverySection builds the cf-config discovery + capture mode panel (read-cost control).
// A cf-config downpipe in AUTO mode backs up only the surfaces the account actually USES (discovered
// ~daily), not one GET per surface in the whole registry every run; MANUAL captures the operator's selected
// surfaces. This panel shows which mode, the last-discovery recency + counts, and a Rediscover button.
// Operator-gated (mode + rediscover both mutate state server-side). Only called for the cf-config type.
export function cfConfigDiscoverySection(engine: EngineClient, dp: Downpipe, state: DownpipeState, opGate: boolean, reload: () => void): HTMLElement {
  // Effective mode mirrors the engine's resolveCfConfigMode: explicit wins; absent derives from the
  // selection (a non-empty include is an explicit pick -> manual; empty = all -> auto).
  const mode: "auto" | "manual" = dp.source.cfConfigMode ?? (dp.source.include.length > 0 ? "manual" : "auto");
  const disc = state.cfConfigDiscovery;
  const statusCell = disc
    ? h(
        "span",
        { style: "display:grid;gap:2px" },
        h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-1)" }, h("span", { class: "dot dot--ok", "aria-hidden": "true" }), `${groupNumber(disc.present.length)} surfaces in use`),
        h("span", { class: "field__hint" }, `${groupNumber(disc.empty.length)} unused · discovered ${relativeTime(disc.at)}`),
      )
    : neverDiscoveredHint();

  const modeSel = h(
    "select",
    { "data-dp": "sources-downpipes.select.mode-sel", class: "field__select", "aria-label": "Cloudflare config capture mode" },
    h("option", { value: "auto" }, "Auto: capture surfaces in use"),
    h("option", { value: "manual" }, "Manual: my selected surfaces"),
  ) as HTMLSelectElement;
  modeSel.value = mode;
  modeSel.disabled = !opGate;
  modeSel.addEventListener("change", async () => {
    const next: "auto" | "manual" = modeSel.value === "manual" ? "manual" : "auto";
    modeSel.disabled = true;
    try {
      const res = await engine.setCfConfigMode(dp.id, next);
      // QUEUED, NOT FAILED. The capture mode is a change-controlled mutation, so with the approval gate armed
      // the engine answers 202 and applies nothing. This branch used to be absent: the queued answer arrived
      // with no `ok` field and fell into the else below, which told the operator the change could not be made
      // and reverted the select, for a request the engine had accepted. The select is reverted here TOO, but
      // for the true reason (nothing has changed YET), and the toast names the queue rather than a failure.
      if (res.status === "pending") {
        surfacePendingChange("capture mode change");
        modeSel.value = mode;
        return;
      }
      if (res.value.ok) {
        toast({ message: `Capture mode set to ${next}.` });
        reload();
      } else {
        toast({ message: `Could not change capture mode (${res.value.error ?? "failed"}).`, tone: "warn" });
        modeSel.value = mode;
      }
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not change capture mode. ${errMsg(err)}`, tone: "warn" });
      modeSel.value = mode;
    } finally {
      modeSel.disabled = !opGate;
    }
  });

  const rediscoverBtn = h("button", { "data-busy-label": "Discovering\u2026", "data-dp": "sources-downpipes.button.rediscover", class: "btn btn--secondary", type: "button" }, "Rediscover") as HTMLButtonElement;
  rediscoverBtn.disabled = !opGate;
  rediscoverBtn.addEventListener("click", async () => {
    rediscoverBtn.disabled = true;
    const prev = rediscoverBtn.textContent;
    rediscoverBtn.textContent = "Discovering…";
    try {
      const res = await engine.rediscoverCfConfig(dp.id);
      if (res.ok && res.discovery) {
        // A REDISCOVER CAN SUCCEED AND SEE NOTHING, and that is the state the whole gap is about. The probe
        // does not throw on a scope 403: it files every surface as `unavailable`, returns ok, and the console
        // toasts "Discovered 0 surfaces in use". An expired or rescoped discovery token therefore looked, from
        // here and from the pack, exactly like a healthy account with nothing configured -- which is why
        // "cf-config backups capture nothing new" has never been answerable. Zero present, zero empty and at
        // least one unavailable is not an empty account, it is a blind token.
        if (cfDiscoveryBlackout(res.discovery)) recordCatalogueDegraded("cf-discovery-all-unavailable");
        toast({ message: `Discovered ${groupNumber(res.discovery.present.length)} surfaces in use (${groupNumber(res.discovery.empty.length)} unused, ${groupNumber(res.discovery.unavailable.length)} unavailable).` });
        reload();
      } else {
        // The operator pressed Rediscover and it did not complete, so the STALE surface set stands and the
        // next cf-config run captures against it. WHICH refusal it was is the row: a cleared token, an account
        // the owner took out of discovery scope and a rate limit are three different remedies and used to be one
        // coalesced count. The engine's sentence selects the member and is never copied.
        recordCatalogueDegraded(cfRediscoverRefusalClass(res.error));
        toast({ message: `Rediscover failed (${res.error ?? "unknown"}).`, tone: "warn" });
      }
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // The rediscover CALL threw. A 403 (the engine refused this caller's role though the console offered
      // the button), a 429 (retry; nothing is broken), a web page answering at the engine's address and a dead
      // transport are separated here, because only one of them is a reason to go and look at the token. A lapsed
      // Access session returns NULL and records nothing: it is the ordinary overnight state.
      const thrown = cfRediscoverThrowClass(err);
      if (thrown !== null) recordCatalogueDegraded(thrown);
      toast({ message: `Rediscover failed. ${errMsg(err)}`, tone: "warn" });
    } finally {
      rediscoverBtn.disabled = !opGate;
      rediscoverBtn.textContent = prev;
    }
  });

  const modeDoc = h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/operations/cloudflare-config-backup-restore#choosing-what-to-capture-mode-and-scope", target: "_blank", rel: "noreferrer noopener" },
    "About capture mode",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  );
  // Surfaces discovery could not capture split into two rows, not one bare count: a definitive Cloudflare
  // plan/entitlement gate (disc.gated) and a token-scope/other fault (disc.unavailable) are different facts
  // with opposite remedies (a plan decision the operator makes elsewhere vs a permission group missing from
  // the discovery token), and used to collapse into the one "N unavailable" figure below.
  // Each row is present only while its population is non-empty, so a fully-readable token shows neither.
  const unreadableRows = unreadableSurfaceRows(disc);
  return drawerSection("Configuration discovery", kvRow("Capture mode", modeSel), kvRow("Surfaces", statusCell), ...unreadableRows, kvRow("Refresh", rediscoverBtn), modeDoc);
}

// unreadableSurfaceRows builds the "not carried by this account's plan" and "not readable with this token"
// rows (each a <details> disclosure naming the surfaces, collapsed by default), skipping a row whose
// population is empty. Kept as a pure function of the discovery record so it renders identically wherever a
// CfConfigDiscovery is read, and so the never-discovered / no-disc case (disc undefined) draws neither row.
function unreadableSurfaceRows(disc: DownpipeState["cfConfigDiscovery"]): HTMLElement[] {
  if (!disc) return [];
  const rows: HTMLElement[] = [];
  if (disc.gated.length > 0) {
    rows.push(
      kvRow(
        "Not on this plan",
        surfaceDisclosure(
          `${groupNumber(disc.gated.length)} ${disc.gated.length === 1 ? "surface" : "surfaces"} not carried by this account's Cloudflare plan`,
          disc.gated,
          "Cloudflare answered with a definitive plan-entitlement gate: this account's plan does not include the product, so there is nothing here to capture. No token change or rediscovery fixes this; it is a plan decision, not a permission gap.",
        ),
      ),
    );
  }
  if (disc.unavailable.length > 0) {
    rows.push(
      kvRow(
        "Not readable",
        surfaceDisclosure(
          `${groupNumber(disc.unavailable.length)} ${disc.unavailable.length === 1 ? "surface" : "surfaces"} not readable with this token`,
          disc.unavailable,
          [
            "The discovery token could not read these, most often a permission group the “Read all resources” template does not reliably include (Access/Gateway, Logpush, Load Balancing Monitors and Pools, DNS Firewall, Hyperdrive, Account Rulesets/WAF). Add the matching permission group and rediscover.",
          ],
          "https://docs.downpipes.io/operations/cloudflare-config-backup-restore#permission-groups-the-read-all-resources-template-does-not-reliably-include",
          "Which permission group each surface needs",
        ),
      ),
    );
  }
  return rows;
}

// surfaceDisclosure is the shared <details> shape for a surface-id population: a count summary, a one-line
// lead naming what the population means and its remedy, the surface ids themselves (registry ids, the same
// vocabulary the docs use), and an optional doc link for the populations that have a fuller remedy written
// up (the permission-group table). Collapsed by default so a healthy downpipe's drawer stays calm; opening
// it is the operator asking "which ones, specifically".
function surfaceDisclosure(summaryText: string, ids: string[], lead: string | string[], docHref?: string, docLabel?: string): HTMLElement {
  const body = h("div", { class: "disclosure__body" });
  for (const p of Array.isArray(lead) ? lead : [lead]) {
    body.appendChild(h("p", { class: "field__hint", style: "margin:0 0 var(--space-2)" }, p));
  }
  const list = h("ul", { class: "skipped-list" });
  for (const id of [...ids].sort()) list.appendChild(h("li", h("span", { class: "mono" }, id)));
  body.appendChild(list);
  if (docHref !== undefined) {
    body.appendChild(
      h(
        "a",
        { class: "field__doc linklike", href: docHref, target: "_blank", rel: "noreferrer noopener" },
        docLabel ?? "Read more",
        svgIcon(ICON_EXTERNAL, { size: 13 }),
      ),
    );
  }
  return h("details", { class: "disclosure" }, h("summary", summaryText), body);
}

// neverDiscoveredHint is the "not yet discovered" line, with the row that makes it visible remotely (G243).
// A cf-config downpipe whose discovery has NEVER run is capturing EVERY surface the token can see, not the
// surfaces in use: the operator picked the calm auto mode and believes it is narrowing, and it is not. That is a
// degraded capture mode, and it is silent by construction (there is no cfConfigDiscovery block in the pack for a
// downpipe that never discovered, and an ABSENT block reads exactly like a section the pack simply did not
// gather). The row asserts the absence, which is the one thing an absence cannot do for itself.
function neverDiscoveredHint(): HTMLElement {
  recordCatalogueDegraded("cf-never-discovered");
  return h("span", { class: "field__hint" }, "Not yet discovered. Capturing all surfaces until the first refresh.");
}
