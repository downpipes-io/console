// Retention policy section (ASVS V14.2.7) for the upsert editor, split out of ./editor-upsert.ts
// (move-only). See ./editor.ts for the barrel.
//
// keepRuns / keepDays bound how much history is RETAINED; the enforce toggle is OFF by default and
// gates DELETION. Empty fields mean "keep everything" (no policy sent). The fields seed from the
// existing config when editing so the operator can read and change the current policy in place.

import { h } from "../../lib/dom.ts";
import { field } from "../../components/field.ts";
import { wholeNumberBetween } from "../../components/field-bounds.ts";
import { groupNumber } from "../../lib/format.ts";
import {
  RETENTION_MAX_KEEP_RUNS,
  RETENTION_MAX_KEEP_DAYS,
  type Downpipe,
  type RetentionPolicy,
} from "../../api.ts";
import { validateRetention } from "./helpers.ts";
import { breakGlassPruneEntryNote } from "../restore-flow/break-glass-prune.ts";

// buildRetentionSection builds the retention disclosure and exposes resolve(): the wire policy (or
// undefined when no policy is set) plus a blocking error flag. A policy exists when either limit is
// set OR the operator turned enforce on. On a validation failure resolve() shows the inline error,
// opens the disclosure and focuses the offending field, then returns { error: true }; the caller
// must NOT submit.
export function buildRetentionSection(existing: Downpipe | null): {
  el: HTMLElement;
  resolve: () => { policy: RetentionPolicy | undefined; error: boolean };
} {
  const existingRetention = existing?.retention;
  const keepRunsField = field({
    id: "dp-keep-runs",
    label: "Runs to keep",
    type: "text",
    value: existingRetention?.keepRuns !== undefined ? String(existingRetention.keepRuns) : "",
    hint: `Keep the N most recent runs. Whole number, 1 to ${groupNumber(RETENTION_MAX_KEEP_RUNS)}. Leave blank for no run limit.`,
    placeholder: "10",
    // The same bound validateRetention enforces at submit, now enforced at the field on blur. Blank
    // stays valid: blank is "no limit on this axis", not an unfinished entry.
    validate: wholeNumberBetween({
      noun: "Runs to keep",
      min: 1,
      max: RETENTION_MAX_KEEP_RUNS,
      remedy: "Type how many recent runs to keep, or leave it blank to keep every run.",
    }),
    doc: { href: "https://docs.downpipes.io/backing-up/retention-and-pruning", anchor: "the-three-knobs" },
  });
  const keepDaysField = field({
    id: "dp-keep-days",
    label: "Days to keep",
    type: "text",
    value: existingRetention?.keepDays !== undefined ? String(existingRetention.keepDays) : "",
    hint: `Keep runs from the last N days. Whole number, 1 to ${groupNumber(RETENTION_MAX_KEEP_DAYS)}. Leave blank for no day limit.`,
    placeholder: "30",
    validate: wholeNumberBetween({
      noun: "Days to keep",
      min: 1,
      max: RETENTION_MAX_KEEP_DAYS,
      remedy: "Type how many days of runs to keep, or leave it blank to keep every run.",
    }),
    doc: { href: "https://docs.downpipes.io/backing-up/retention-and-pruning", anchor: "the-three-knobs" },
  });
  // The enforce toggle: a plain checkbox, OFF by default, with a loud honest warning that turning it on
  // makes the engine DELETE superseded runs and their unreferenced segments on the schedule. Until it is
  // on, retention is dry-run: the engine logs the prune plan and deletes nothing.
  //
  // The hint also states the break-glass-only case, because without it this control promises something it
  // cannot do automatically in that posture. A break-glass-only engine holds no key that decrypts the shard
  // manifests, so its unattended cron pass cannot tell a segment a retained run still needs from an orphan;
  // that scheduled pass defers and records passSkipCode "break-glass-only" rather than guessing. This closes
  // a gap this used to dead-end on: the hint used to say "prune offline with the reader instead", a
  // terminal instruction that broke the house no-customer-CLI rule. It no longer does -- a break-glass-only
  // operator can run this SAME policy from their browser instead, on demand, with their own key (see
  // breakGlassPruneEntryNote below); nothing here promises the unattended schedule can do it alone.
  const enforceCheckbox = h("input", {
    type: "checkbox",
    id: "dp-retention-enforce",
    style: "margin-top:3px;flex:none",
  }) as HTMLInputElement;
  enforceCheckbox.checked = existingRetention?.enforce === true;
  const enforceRow = h(
    "label",
    { for: "dp-retention-enforce", style: "display:flex;gap:var(--space-2);align-items:flex-start;font-size:var(--text-base)" },
    enforceCheckbox,
    h(
      "span",
      "Enforce deletion (off = report only). ",
      h(
        "span",
        { class: "field__hint" },
        "When on, the engine DELETES superseded runs and their unreferenced segments on the schedule. When off, it logs the prune plan in the engine log and deletes nothing. Turn this on only when you are sure the limits above are right. In a break-glass-only posture the engine holds no key that can read which segments a run still needs, so the unattended scheduled pass defers instead of deleting, and records that it did; run this downpipe's prune from the console with your own key instead (below).",
      ),
    ),
  );
  const retentionError = h("p", { class: "field__error", role: "alert", hidden: true });
  const el = h(
    "details",
    { class: "disclosure" },
    h("summary", "Retention: prune old runs (off by default)"),
    h(
      "div",
      { class: "disclosure__body" },
      h("p", { class: "field__hint measure" }, "Set how much run history to keep. The engine supersedes runs outside the window and prunes their unreferenced segments. At least one limit is required to set a policy; leave both blank to keep everything."),
      keepRunsField.el,
      keepDaysField.el,
      enforceRow,
      // The break-glass-only no-CLI prune entry point: only meaningful for an EXISTING downpipe (a
      // new, unsaved one has no runs yet to prune), so it is omitted on the create path.
      existing ? breakGlassPruneEntryNote(existing.id) : undefined,
      retentionError,
    ),
  );

  const resolve = (): { policy: RetentionPolicy | undefined; error: boolean } => {
    // Build the retention policy from the fields. A blank field is "no limit on this axis"; both blank
    // (with enforce off) means NO policy at all (keep everything, the engine's default), so retention is
    // omitted entirely. A non-integer entry is rejected inline before validateRetention so the operator
    // sees a precise message rather than the engine's 400. parseField returns the integer, or
    // undefined for a blank field, or NaN for a non-integer (so the bounds check below catches it).
    retentionError.hidden = true;
    const keepRunsRaw = keepRunsField.value().trim();
    const keepDaysRaw = keepDaysField.value().trim();
    const parseField = (raw: string): number | undefined => (raw === "" ? undefined : Number(raw));
    const keepRuns = parseField(keepRunsRaw);
    const keepDays = parseField(keepDaysRaw);
    const enforce = enforceCheckbox.checked;
    // A policy exists when either limit is set OR the operator turned enforce on (an enforce-on with no
    // limit is a mistake validateRetention catches with the "needs at least one limit" message, which is
    // the honest reason rather than silently dropping the toggle).
    let retentionPolicy: RetentionPolicy | undefined;
    if (keepRuns !== undefined || keepDays !== undefined || enforce) {
      retentionPolicy = {
        ...(keepRuns !== undefined ? { keepRuns } : {}),
        ...(keepDays !== undefined ? { keepDays } : {}),
        ...(enforce ? { enforce: true } : {}),
      };
      const retentionErr = validateRetention(retentionPolicy);
      if (retentionErr !== null) {
        retentionError.textContent = retentionErr;
        retentionError.hidden = false;
        el.open = true;
        // Focus the offending field: the days field only when runs is fine and days is the problem;
        // otherwise the runs field (the "needs at least one limit" and runs-range cases land here).
        const daysBad = keepDays !== undefined && (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > RETENTION_MAX_KEEP_DAYS);
        const runsBad = keepRuns !== undefined && (!Number.isInteger(keepRuns) || keepRuns < 1 || keepRuns > RETENTION_MAX_KEEP_RUNS);
        (daysBad && !runsBad ? keepDaysField : keepRunsField).focus();
        return { policy: undefined, error: true };
      }
    }
    return { policy: retentionPolicy, error: false };
  };

  return { el, resolve };
}
