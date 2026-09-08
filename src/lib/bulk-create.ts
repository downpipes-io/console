// The shared many-at-once downpipe-create loop: one place turns a prepared list of downpipes into
// engine calls, so the wizard's multi-source create and the Sources bulk protect batch identically.
// It POSTs /admin/downpipes/bulk in slices (one engine call per slice instead of one per downpipe),
// honours the engine's advertised cap (an oversized slice answers { rebatch: maxBatch }, lower while
// config approval is on, and the loop re-slices deterministically), and FALLS BACK to the per-item
// single create against an OLDER engine whose router does not know the bulk route (a 404), so bulk
// protect keeps working across an engine/console version skew. Outcomes aggregate per item
// (done / queued-for-approval / failures with the engine's bounded reason); a session expiry HALTS the
// loop honestly (halted:true, the caller routes to signed-out) rather than burning the rest of the
// batch on 401s. Pure of the DOM: the callers drive button state, toasts and drafts off the outcome.

import type { Downpipe, BulkDownpipeSend, MutationResult } from "../api.ts";
import { errText, isUnauthorised } from "./errors.ts";
import { recordBulkOutcome, recordContractDrift } from "./client-diag/ring.ts";
import { isRateLimited, rateLimitDelayMs, bulkFailureReason, MAX_RATE_LIMIT_RETRIES } from "./bulk-pacing.ts";

// This module is deliberately DOM-free (no DOM, no network: its own validator drives it under plain
// node), unlike bulk-pacing.ts's own `sleep`, which uses window.setTimeout so a DOM-shimmed validator
// can drive its fake timer. Plain setTimeout (a Node AND browser global) keeps that property here.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One prepared create: the wire Downpipe plus the human label failures are reported under (the
// binding or the downpipe name, whichever the operator recognises in a summary row).
export interface BulkCreateItem {
  dp: Downpipe;
  label: string;
}

// The aggregate outcome, shape-compatible with the Sources tier's historical BulkCreateOutcome so
// reportBulkOutcome renders it unchanged: done = applied now, queued = pending a second approver.
// total is the number of DOWNPIPES the batch set out to create (a ticked-secrets bundle counts once),
// so summaries agree with what actually lands in /downpipes rather than the tick count.
export interface BulkCreateOutcome {
  done: number;
  queued: number;
  failures: Array<{ name: string; reason: string }>;
  halted: boolean;
  total: number;
}

// The two engine calls the loop composes, passed in (rather than an EngineClient) so the loop is a
// pure function of its inputs and the validator can drive it with scripted responders.
export interface BulkCreatePoster {
  bulk: (dps: Downpipe[]) => Promise<BulkDownpipeSend>;
  single: (dp: Downpipe) => Promise<MutationResult<unknown>>;
}

// DEFAULT_BULK_BATCH mirrors the engine's ungated per-request cap (BULK_DOWNPIPES_MAX). Starting at
// the cap means the common path is ceil(n/100) requests; when the engine's effective cap is lower
// (config approval on), the first response says so via rebatch and the loop re-slices.
export const DEFAULT_BULK_BATCH = 100;

// isRouteMissing detects the OLDER-ENGINE case: the transport folds the HTTP status into the thrown
// message as its trailing token ("bulk add downpipes: 404"), so a 404 here means the engine predates
// the bulk route (an /admin sub the router does not know), never a missing resource (the route takes
// no id). Anything else is not a skew signal and keeps its classified handling.
function isRouteMissing(err: unknown): boolean {
  return /:\s*404$/.test(errText(err));
}

// runBulkCreate drives the whole list through the poster. onProgress reports items SETTLED so far
// (applied + queued + failed), so a caller can label the button "Creating 400 of 1000".
export async function runBulkCreate(
  post: BulkCreatePoster,
  items: BulkCreateItem[],
  onProgress?: (settled: number, total: number) => void,
): Promise<BulkCreateOutcome> {
  const out: BulkCreateOutcome = { done: 0, queued: 0, failures: [], halted: false, total: items.length };
  const total = items.length;
  let batchSize = DEFAULT_BULK_BATCH;
  let index = 0;
  // Per-SLICE 429 retry count, matching the shared bulk-pacing budget (MAX_RATE_LIMIT_RETRIES) every
  // other bulk loop (run/disable/delete, the fleet-drill loop) already backs off by, rather than this
  // loop's own weaker one-shot retry with a hardcoded 30s cap. Reset whenever the slice moves on.
  let rateLimitRetries = 0;
  let settled = 0;
  const progress = (): void => {
    if (onProgress) onProgress(settled, total);
  };
  while (index < total) {
    const slice = items.slice(index, index + batchSize);
    let send: BulkDownpipeSend;
    try {
      send = await post.bulk(slice.map((i) => i.dp));
    } catch (err) {
      if (isUnauthorised(err)) {
        // A session expiry CUT THE BATCH SHORT. The items past this point were never
        // attempted, and the operator sees only a toast before being routed to sign-in. Counts only: how
        // many items did not complete, and the class of ending. No item identity travels.
        out.halted = true;
        recordBulkOutcome("create", "auth", total - settled);
        return out;
      }
      if (isRouteMissing(err)) {
        // Contract-drift: the engine's router does not know POST /admin/downpipes/bulk, so this console
        // is newer than the engine it is driving. The loop silently falls back to the per-item create and
        // the operator never learns the two components have skewed; the pack now says so. The class alone is
        // recorded (there is nothing else here to record: no version string, no route, no value).
        recordContractDrift("version-skew");
        // Older engine: no bulk route. Fall back to the per-item single create for the REMAINDER,
        // which is exactly the pre-bulk behaviour (one POST per downpipe, per-item failures).
        return singleFallback(post, items, index, out, settled, total, onProgress);
      }
      // A 429 carries the engine's Retry-After; wait it out and retry the same slice, up to the shared
      // MAX_RATE_LIMIT_RETRIES budget. Exhausting that falls through to the per-slice failure, labelled
      // as rate-limited (bulkFailureReason) rather than the raw "<verb>: 429" transport string, so the
      // loop always terminates and the reason stays honest either way.
      if (isRateLimited(err) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries++;
        await sleep(rateLimitDelayMs(err));
        continue;
      }
      // Any other failure (a transient 5xx, a network fault, or a 429 that exhausted its retries): the
      // slice is reported failed per item, honestly, and the loop continues with the next slice; the
      // caller's summary + preserved draft let the operator retry exactly what failed.
      for (const item of slice) out.failures.push({ name: item.label, reason: bulkFailureReason(err) });
      settled += slice.length;
      progress();
      index += slice.length;
      rateLimitRetries = 0;
      continue;
    }
    if ("rebatch" in send) {
      // The engine's cap is lower than our slice (config approval on). Re-slice; nothing was
      // processed. Guard against a nonsense echo so the loop can never spin in place.
      if (send.rebatch >= slice.length || send.rebatch < 1) {
        for (const item of slice) out.failures.push({ name: item.label, reason: "engine batch cap disagreed; retry" });
        settled += slice.length;
        progress();
        index += slice.length;
        continue;
      }
      batchSize = send.rebatch;
      continue;
    }
    // Index-aligned per-item outcomes.
    for (let k = 0; k < slice.length; k++) {
      const r = send.results[k];
      const label = slice[k]!.label;
      if (r === undefined) {
        out.failures.push({ name: label, reason: "no result returned for this item" });
      } else if (r.status === "applied") {
        out.done++;
      } else if (r.status === "pending") {
        out.queued++;
      } else {
        out.failures.push({ name: label, reason: r.error ?? "refused" });
      }
    }
    settled += slice.length;
    progress();
    index += slice.length;
    rateLimitRetries = 0;
  }
  return out;
}

// singleFallback finishes the list one POST /admin/downpipes at a time (the pre-bulk path), used only
// when the engine has no bulk route. Same aggregate semantics: pending counts as queued, a thrown 401
// halts, any other throw is a per-item failure.
async function singleFallback(
  post: BulkCreatePoster,
  items: BulkCreateItem[],
  from: number,
  out: BulkCreateOutcome,
  settledSoFar: number,
  total: number,
  onProgress?: (settled: number, total: number) => void,
): Promise<BulkCreateOutcome> {
  let settled = settledSoFar;
  for (let i = from; i < items.length; i++) {
    const item = items[i]!;
    try {
      const res = await post.single(item.dp);
      if (res.status === "pending") out.queued++;
      else out.done++;
    } catch (err) {
      if (isUnauthorised(err)) {
        // The same halt, on the per-item fallback leg. `total - settled` is the remainder that was
        // never attempted.
        out.halted = true;
        recordBulkOutcome("create", "auth", total - settled);
        return out;
      }
      out.failures.push({ name: item.label, reason: errText(err) });
    }
    settled++;
    if (onProgress) onProgress(settled, total);
  }
  return out;
}
