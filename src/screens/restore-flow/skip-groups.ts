// The skipped-record grouping, shared by the dry-run PLAN and the applied RECEIPT.
//
// It lives in its own leaf module to avoid an import cycle: the receipt and the dry-run plan both need this
// grouping, and plan.ts reaches confirm.ts, which imports the receipt. Neither plan.ts nor the receipt owns
// this module, so both callers import it directly with no cycle between them.
//
// The grouping is the value: whether a record needs investigating, re-provisioning, or nothing. A second
// implementation on the receipt side would drift from this one, which is how an operator ends up being told
// to do different things about the same record before and after they apply.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_ALERT } from "../../lib/icons.ts";
import type { RestorePlan } from "../../api.ts";
import { MAX_DISPLAY_ROWS } from "./shared.ts";

type SkipCategory = "unresolved" | "marker" | "config" | "outofband" | "kept" | "excluded";

// KEPT_PREFIX is the start of the engine's KEPT_EXISTING_REASON (engine src/admin/restore-sinks.ts): a live KV
// key or R2 object that an apply with onExisting "skip" left as it was, because the operator chose to keep
// live keys. The key is IN the account, so it is neither outstanding nor something to re-provision.
const KEPT_PREFIX = "kept the live key or object";

// isKeptSkip says whether a skipped row is a live key the operator chose to keep. The receipt uses it to
// leave kept names out of the "records outstanding" count, because nothing about them is outstanding.
export function isKeptSkip(s: { reason: string }): boolean {
  return s.reason.startsWith(KEPT_PREFIX);
}

// isMarkerSkip says whether a skipped row is a record whose captured value is an incompleteness marker, not
// real bytes. The engine words it two ways (engine admin/restore-plan.ts and restore-apply.ts): "the captured
// value is an incompleteness marker" for a data record, and "the captured value was a marker" for a media
// file. The engine's own diagnostics classify the reason on the same two phrases (engine admin/diag-records.ts
// "marker-skipped"), so a marker is recognised here exactly as the engine recognises it.
function isMarkerSkip(s: { reason: string }): boolean {
  return s.reason.includes("incompleteness marker") || s.reason.includes("the captured value was a marker");
}

// categoriseSkip buckets a skipped record by the operator's next action, from the engine's STABLE reason
// text (engine restore-sinks.ts / restore-plan.ts): a missing/unsupported target binding to investigate, a
// Cloudflare account-config surface that is re-provisioned, another out-of-band resource (Workers / secrets
// / media) that is re-deployed/re-created, a live key the operator chose to keep, or a record simply outside
// the chosen scope. A marker row is its own group: the backup holds no data for it, so there is nothing to
// re-provision out of band, and filing it with Workers and secrets told the operator to recover something
// that was never captured. The marker test runs after "excluded" (a record outside the chosen scope is that,
// whatever it holds) and before the out-of-band fallback that used to catch it.
function categoriseSkip(s: { name: string; reason: string }): SkipCategory {
  const r = s.reason;
  if (r === "target binding not present" || /is not present in the environment/.test(r) || r.startsWith("unsupported sink")) return "unresolved";
  if (s.name === "(window)" || r === "not the selected record" || r === "excluded by selector" || r.startsWith("windowed restore")) return "excluded";
  if (isMarkerSkip(s)) return "marker";
  if (r.startsWith("Cloudflare config")) return "config";
  if (isKeptSkip(s)) return "kept";
  return "outofband"; // Workers script / "restore out of band" (secrets) / media + artifact guidance
}

// The display metadata per category: a plain-English summary count and a one-line lead that says what the
// group IS and what to do, so the operator never reads an EXPECTED re-provision as a failure. Rendered in
// this order: the only group that warrants attention (no target binding) first, then the calm expected ones.
const SKIP_GROUPS: ReadonlyArray<{ id: SkipCategory; alert?: boolean; summary: (n: number) => string; lead: string }> = [
  {
    id: "unresolved",
    alert: true,
    summary: (n) => `${n} ${n === 1 ? "record" : "records"} with no target binding`,
    lead: "No matching live binding was found to restore these into. Usually the source is not attached to this engine (attach it, then re-run), or a redirect named an unknown binding. These are the records to investigate.",
  },
  {
    id: "marker",
    summary: (n) => `${n} ${n === 1 ? "record" : "records"} not captured (incompleteness ${n === 1 ? "marker" : "markers"})`,
    lead: "The backup holds an incompleteness marker for these records, not their data. The source deleted the record before the backup read it, or the backup did not read it, or the read failed. There is nothing to restore, so this restore does not write these records.",
  },
  {
    id: "config",
    summary: (n) => `${n} account-configuration ${n === 1 ? "surface" : "surfaces"} (not written by this restore)`,
    lead: "downpipes captured and verified these Cloudflare account-configuration surfaces (Access, Gateway, account settings and the like). This restore does not write them, and each row says why. To re-apply a writable surface in-console, supply a Cloudflare edit token. Re-provision the other surfaces from the verified snapshot, through the Cloudflare API or in dependency order.",
  },
  {
    id: "outofband",
    summary: (n) => `${n} re-provisioned out of band (Workers, secrets, media)`,
    lead: "Workers scripts (re-deployed, never blind-overwritten) and Secrets Store values (re-created) are recovered out of band from the verified snapshot, not by an in-account write-back. Media files (Stream, Images, Artifact Registry) are recovered out of band here too; supply a media edit token above to re-upload Stream and Images files in-account instead (Artifact Registry blobs are always a git push, never a REST upload, so they stay out of band regardless). A D1 row whose dump would not replay has a malformed backup body, so this restore does not write it.",
  },
  {
    id: "kept",
    summary: (n) => `${n} live ${n === 1 ? "key or object" : "keys or objects"} kept, as you chose`,
    lead: "These names already existed in the target, and you chose to keep live keys. The apply left each one as it was and wrote nothing over it. They are in your account and need no action.",
  },
  {
    id: "excluded",
    summary: (n) => `${n} excluded by your selection`,
    lead: "These records were outside the records or window you chose for this restore. They are not a problem.",
  },
];

// buildSkippedGroups splits the flat skipped[] into the per-action disclosures (see categoriseSkip), in
// SKIP_GROUPS order, returning one <details> per non-empty group with its lead + the record list. An empty
// skipped[] returns nothing. Each list is capped at MAX_DISPLAY_ROWS like the prior flat list; the summary
// always carries the FULL count so a cap never hides the true size.
// Exported so the RECEIPT can group an apply's skipped records exactly as the dry-run plan does. The
// grouping is the whole value here (investigate / re-provision / nothing), and a second implementation on
// the receipt side would drift from this one, which is how an operator ends up being told to do different
// things about the same record before and after they apply.
export function buildSkippedGroups(skipped: RestorePlan["skipped"]): HTMLElement[] {
  const byCat = new Map<SkipCategory, RestorePlan["skipped"]>();
  for (const s of skipped) {
    const arr = byCat.get(categoriseSkip(s)) ?? [];
    arr.push(s);
    byCat.set(categoriseSkip(s), arr);
  }
  const out: HTMLElement[] = [];
  for (const g of SKIP_GROUPS) {
    const items = byCat.get(g.id);
    if (!items || items.length === 0) continue;
    const summary = g.alert
      ? h("summary", svgIcon(ICON_ALERT, { size: 13 }), " ", g.summary(items.length))
      : h("summary", g.summary(items.length));
    const details = h("details", { class: "disclosure" }, summary);
    const body = h("div", { class: "disclosure__body" });
    body.appendChild(h("p", { class: "field__hint", style: "margin:0 0 var(--space-2)" }, g.lead));
    const list = h("ul", { class: "skipped-list" });
    for (const s of items.slice(0, MAX_DISPLAY_ROWS)) {
      list.appendChild(h("li", h("span", { class: "mono" }, s.name), " ", h("span", { class: "field__hint" }, s.reason)));
    }
    body.appendChild(list);
    details.appendChild(body);
    out.push(details);
  }
  return out;
}
