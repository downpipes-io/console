// Restore the dry-run review (the hero panel): the impact summary
// scaled to the plan and escalated for a non-latest / redirected / large restore, the plan
// figures, the resolved destinations sample (each row offering a granular single-record
// re-entry), the skipped + cf-config disclosures, the precise integrity statement, the
// plan-hash binding cue, and the confirm + apply gate. Moved verbatim out of
// restore-flow.ts for size: no confirmation / dual-control wording and no plan-hash
// handling is changed. House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { inlineOutcome } from "../../components/error-view.ts";
import { groupNumber, humanBytes, absoluteTime, relativeTime } from "../../lib/format.ts";
import { ICON_SHIELD_CHECK, ICON_ALERT, ICON_RESTORE } from "../../lib/icons.ts";
import { buildSkippedGroups } from "./skip-groups.ts";
import {
  restorePlanHash,
  type EngineClient, type RestorePlan, type RestoreRequest,
} from "../../api.ts";
import {
  LARGE_RESTORE_WRITES, BREAK_GLASS_PREFIX, MAX_DISPLAY_ROWS,
  type FlowPrefill, writeSummarySentence, reviewImpactLine, configSurfacesToApply, figure, sourceTypeBadge,
  reportPlanHashFailed, UNWRITTEN_MARK, UNWRITTEN_TEXT,
} from "./shared.ts";
import { renderConfirm } from "./confirm.ts";

// unwrittenNote renders the dry-run reassurance as its own marked element. Every copy on the card is built
// here, so the confirm step can revise all of them at once when an apply's outcome becomes unknown
// (confirm.ts markApplyOutcomeUnknown) and none can be missed. The mark is the only contract between the
// two: the text lives in one place and the class in one place, both in shared.ts.
function unwrittenNote(): HTMLElement {
  return h("span", { class: UNWRITTEN_MARK }, UNWRITTEN_TEXT);
}

// ---- the dry-run review (the hero panel) ------------------------------------

// crossZoneNeedsConfirm decides whether a cross-zone restore must be typed to confirm. It is exported and
// separate from renderPlan for one reason: as a line inside the render it could not be asserted at all.
// The type-to-confirm only arms behind a usable dual-control approval, so under a stub engine the panel
// renders its "needs approval" state and the rule is invisible, which is why the cross-zone render test
// says in as many words that it cannot check this. A guard nothing can observe is a guard nothing holds up.
//
// A PROVEN mismatch only. A warning whose originZone is null means the archive's origin could not be read,
// usually because the identity record sits outside a windowed restore, and the ENGINE warns without
// refusing there. Demanding a confirmation would block a restore the engine is perfectly happy to run, so
// getting this backwards is silent: the screen simply looks more cautious.
export function crossZoneNeedsConfirm(plan: RestorePlan): boolean {
  return plan.crossZoneWarning !== undefined && plan.crossZoneWarning.originZone !== null;
}

export async function renderPlan(
  engine: EngineClient,
  plan: RestorePlan,
  buildRequest: (confirm: boolean) => RestoreRequest,
  paintStepper: (step: number) => void,
  reenter: (prefill: FlowPrefill) => void,
  // onPlanHash is a best-effort side channel for the context rail's live journey summary: once
  // the hash below is computed, it is handed the value (or null if it could not be computed) so the
  // summary can show the SAME redaction-safe cue this card shows, without recomputing it twice.
  onPlanHash?: (hash: string | null) => void,
): Promise<HTMLElement> {
  const card = h("div", { class: "card restore-plan" });
  // tabindex="-1": programmatically focusable so collapsing the pick form into
  // its one-line summary can move focus here, without adding this heading to the Tab order.
  card.appendChild(h("h2", { class: "card__title restore-plan__heading", tabindex: "-1" }, "Review the restore plan"));

  // In-flow ok:false is an expected inline outcome (channel one), never an error toast.
  if (!plan.ok) {
    const reason = plan.reason ?? "The engine could not build a plan for this run.";
    if (reason.startsWith(BREAK_GLASS_PREFIX)) {
      card.appendChild(
        inlineOutcome({
          heading: "Break-glass-only posture",
          reason,
          // This used to name only attended verification (proof, never a write), which was the whole
          // truth when this branch was written -- the break-glass panel could only ever dry-run. It can now
          // apply (its own confirm+apply block, gated by the same dual control), so an operator who reached
          // the STANDARD flow first (this screen) rather than the panel's own secondary entry point is told
          // both are on offer, not steered at the one that cannot write.
          reassurance: "This posture keeps no in-account read-back key. Prove recoverability here with attended verification (supply your break-glass key in your browser; the engine verifies a sample against the keys you recover; nothing is written), or apply a real restore from the break-glass restore panel, which opens and can write this run with the same key under dual control.",
        }),
      );
      card.appendChild(
        h(
          "div",
          { style: "margin-top:var(--space-3);display:flex;gap:var(--space-2);flex-wrap:wrap" },
          h("button", { "data-dp": "restore-flow.button.navigate-restore-attend#2", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/restore/attend") } }, svgIcon(ICON_SHIELD_CHECK, { size: 14 }), "Attended verification"),
          h("button", { "data-dp": "restore-flow.button.navigate-restore-break-glass#2", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/restore/break-glass") } }, svgIcon(ICON_RESTORE, { size: 14 }), "Break-glass restore (preview + apply)"),
        ),
      );
    } else {
      card.appendChild(inlineOutcome({ heading: "Restore not possible", reason, reassurance: "Nothing was written." }));
    }
    return card;
  }

  const req = buildRequest(false);
  const isRedirect = req.target?.binding !== undefined && req.target.binding !== "";
  // carryTarget is the blast-radius choice this plan was built with, carried onto every re-entry below. A
  // re-entry re-mounts the pick form and AUTO-RUNS its own dry-run (flow.ts's prefill branch), so whatever it
  // does not carry is not merely lost from the form: it is absent from the plan that then paints, and from
  // the approval that arms against it. Dropping the redirect meant narrowing to one record silently wrote
  // that record back over its LIVE ORIGINAL binding, moments after the operator had chosen a redirect and
  // reviewed a plan that showed the redirect target on every row, with no type-to-confirm because the new
  // plan was not a redirect.
  //
  // confirm.ts's retry-subset re-entry has always carried it; these two had not. One expression, spread at
  // every site, is one thing to keep true rather than three.
  const carryTarget = isRedirect && req.target?.binding !== undefined ? { targetBinding: req.target.binding } : {};
  const isNonLatest = plan.isLatest === false;
  const highImpact = isRedirect || isNonLatest;
  const isLarge = plan.plannedWrites >= LARGE_RESTORE_WRITES;
  // isCrossAccount: the dry-run reported a cf-config / media leg whose target account is not
  // the archive's origin, so the apply writes into a DIFFERENT Cloudflare account. It escalates the confirm
  // to a type-to-confirm naming the target account, and the apply sets confirmDifferentAccountId (confirm.ts).
  const isCrossAccount = (plan.crossAccountWarnings?.length ?? 0) > 0;
  // isCrossZone gates on a PROVEN mismatch, matching the engine exactly. A warning whose originZone is null
  // means the archive's origin could not be read (usually because the identity record is outside a windowed
  // restore), and the engine warns without refusing, so demanding a type-to-confirm here would block a
  // restore the engine is happy to run.
  const isCrossZone = crossZoneNeedsConfirm(plan);

  // The impact summary: real text scaled to the plan, escalated for a non-latest,
  // redirected or large restore and CALM for the routine default.
  card.appendChild(impactBanner(plan, req, { isRedirect, isNonLatest, isLarge }));

  // The plan figures (tabular numerals): records verified, planned writes, upper-bound
  // bytes, and the latest-or-not state.
  card.appendChild(planFigures(plan));

  // Resolved destinations (the sample[]): where exactly each record will land. Each row offers a
  // "Restore just this" affordance that re-enters the SAME flow scoped to that one record (a granular
  // single-record restore), unless this plan is ALREADY a single-record plan (req.recordName set), in
  // which case there is nothing to narrow. The per-record re-entry runs a fresh dry-run, so it flows
  // through the identical dry-run -> dual-control -> apply path with its own distinct plan hash/approval.
  if (plan.sample.length > 0) {
    const alreadyGranular = req.recordName !== undefined && req.recordName !== "";
    const onRestoreOne = alreadyGranular
      ? undefined
      : (name: string) =>
          reenter({
            runId: plan.runId,
            recordName: name,
            ...carryTarget,
            note: `Restoring one record (${name}) from run ${plan.runId}. Review the re-scoped plan, then request a fresh approval and apply.`,
          });
    card.appendChild(resolvedDestinations(plan.sample, plan.plannedWrites, isRedirect, onRestoreOne));
  }

  // Skipped records (the skipped[]): NOT a flat "N records skipped" wall. The list mixes very different
  // things, and an account-config restore is dominated by ~195 Cloudflare account-configuration surfaces
  // that are RE-PROVISIONED (not restored in place), so showing them as "skipped" beside real data objects
  // read as a wall of failures (owner). Group by what the operator should actually DO: investigate (no
  // target binding), re-provision (config / Workers / secrets / media), or nothing (excluded by selection).
  for (const group of buildSkippedGroups(plan.skipped)) card.appendChild(group);

  // cf-config diff preview: the per-surface changes a Cloudflare-config apply WOULD write back (idempotent
  // surfaces only, shown only when an edit token was supplied). Nothing is written in a dry-run.
  if (plan.configChanges && plan.configChanges.length > 0) {
    const n = plan.configChanges.length;
    // Open when something will actually apply, matching the media preview below. For example,
    // the plan text can be 1,750 characters closed and 6,343 open, so on a config-only restore a
    // closed disclosure is the difference between the diff being present and the diff being read. The
    // summary states the surfaces that WILL apply first, because that is the number the operator is
    // deciding on; the total examined follows it.
    const willApply = configSurfacesToApply(plan);
    const details = h(
      "details",
      { class: "disclosure", ...(willApply > 0 ? { open: true } : {}) },
      h("summary", `Cloudflare config changes (${willApply} of ${n} surface${n === 1 ? "" : "s"} to apply)`),
    );
    const list = h("ul", { class: "skipped-list disclosure__body" });
    for (const c of plan.configChanges) {
      list.appendChild(h("li", h("span", { class: "mono" }, c.surface), " ", h("span", { class: "field__hint" }, c.willApply ? c.summary : `${c.summary} (nothing to apply)`)));
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  // Media re-upload preview: the captured Stream video / Images files an apply WOULD re-upload (shown
  // only when a media edit token was supplied). Each row offers the same granular "Restore just this"
  // re-entry the resolved-destinations sample offers, scoped to that one media record's name AND
  // carrying the media token/account forward (shared.ts FlowPrefill.mediaRestore), so narrowing to one
  // file does not lose the credentials the operator already typed. Never shown for artifacts: the
  // engine's mediaPlanned union is images/stream only (a git-push re-provision has no REST re-upload, so
  // an artifact record never reaches this bucket -- it stays in the out-of-band group below with
  // guidance only, never a fabricated action).
  if (plan.mediaPlanned && plan.mediaPlanned.length > 0) {
    const n = plan.mediaPlanned.length;
    const alreadyGranular = req.recordName !== undefined && req.recordName !== "";
    const details = h("details", { class: "disclosure", open: true }, h("summary", `Media to re-upload on apply (${n} file${n === 1 ? "" : "s"})`));
    const list = h("ul", { class: "skipped-list disclosure__body" });
    for (const m of plan.mediaPlanned) {
      const li = h(
        "li",
        h("span", { class: "mono" }, m.name),
        " ",
        h(
          "span",
          { class: "field__hint" },
          m.type === "stream"
            ? "video: re-uploads as a NEW id (Stream transcodes every upload; update references after apply)"
            : "image: re-uploads keeping its original id",
        ),
      );
      if (!alreadyGranular && req.mediaRestore) {
        const mediaRestore = req.mediaRestore;
        li.appendChild(
          h(
            "button",
            { "data-dp": "restore-flow.button.reenter",
              class: "btn btn--ghost btn--sm",
              type: "button",
              "aria-label": `Restore just the media file ${m.name}`,
              on: {
                click: () =>
                  reenter({
                    runId: plan.runId,
                    recordName: m.name,
                    mediaRestore,
                    ...carryTarget,
                    note: `Restoring one media file (${m.name}) from run ${plan.runId}. Review the re-scoped plan, then request a fresh approval and apply.`,
                  }),
              },
            },
            "Restore just this",
          ),
        );
      }
      list.appendChild(li);
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  // D1 table-subset dependency warnings: a SELECTED child table's foreign-key parent is in the backup but
  // NOT in the restore scope, so its references would dangle. Advisory only (a D1 restore runs with foreign
  // key enforcement off); shown as a caution so the operator can widen the selection before confirming.
  if (plan.dependencyWarnings && plan.dependencyWarnings.length > 0) {
    const warns = plan.dependencyWarnings;
    const note = h("div", { class: "impact impact--warn", role: "note" });
    note.appendChild(h("div", { class: "impact__head" }, svgIcon(ICON_ALERT, { size: 18 }), h("span", `${warns.length} selected table${warns.length === 1 ? "" : "s"} reference a parent not in this restore`)));
    const list = h("ul", { class: "skipped-list" });
    for (const w of warns) {
      list.appendChild(h("li", h("span", { class: "mono" }, w.table), " references ", h("span", { class: "mono" }, w.missingParent), h("span", { class: "field__hint" }, ` (in ${w.database}, not selected)`)));
    }
    note.appendChild(list);
    card.appendChild(note);
  }

  // REDUCED-FIDELITY WARNINGS: records this apply WOULD write, and would write missing a stored field the
  // engine cannot reproduce. These are NOT skipped records and are deliberately not rendered in the skipped
  // groups above: those groups tell an operator a record is still in the archive and not in their account,
  // which is the opposite of what is about to happen here.
  //
  // The case that exists today is a Workers KV key whose captured expiration has already passed, which is
  // every TTL-bearing key in a backup older than its namespace's time to live. The key restores and then does
  // not expire until a new one is set, and for a namespace of session or cache keys that is a decision worth
  // making before approving rather than reading about on the receipt afterwards. Advisory, never a gate: the
  // writes succeed and are already counted in plannedWrites, so this changes nothing about the apply.
  //
  // Rendered as a caution rather than as an alert, matching the D1 dependency lint above: it is a thing to
  // know, not a thing that is wrong. Engine-authored prose and record names render as escaped text (the
  // console XSS invariant), never innerHTML.
  if (plan.fidelityWarnings && plan.fidelityWarnings.length > 0) {
    const warns = plan.fidelityWarnings;
    const note = h("div", { class: "impact impact--warn", role: "note" });
    note.appendChild(h("div", { class: "impact__head" }, svgIcon(ICON_ALERT, { size: 18 }), h("span", "Some records restore at reduced fidelity")));
    const list = h("ul", { class: "skipped-list" });
    for (const w of warns) {
      list.appendChild(h("li", h("span", { class: "mono" }, w.name), " ", h("span", { class: "field__hint" }, w.reason)));
    }
    note.appendChild(list);
    card.appendChild(note);
  }

  // CROSS-ACCOUNT WARNING: a cf-config / media apply would write into a DIFFERENT Cloudflare
  // account than the one the archive was captured from (or one the archive did not record). This is a
  // legitimate disaster-recovery migration, but it is never silent: the engine refuses the apply unless the
  // target account is echoed back, so the confirm step turns this into a type-to-confirm. Shown prominently
  // so the operator sees the different-account write before confirming it. Account ids render as escaped text
  // (the console XSS invariant), never innerHTML.
  if (plan.crossAccountWarnings && plan.crossAccountWarnings.length > 0) {
    const note = h("div", { class: "impact impact--warn", role: "note" });
    note.appendChild(h("div", { class: "impact__head" }, svgIcon(ICON_ALERT, { size: 18 }), h("span", "Cross-account restore: this writes into a different Cloudflare account")));
    const list = h("ul", { class: "skipped-list" });
    for (const w of plan.crossAccountWarnings) {
      const origin = w.originAccount !== null
        ? h("span", "captured from ", h("span", { class: "mono" }, w.originAccount))
        : h("span", "no recorded origin account");
      list.appendChild(h("li", h("span", { class: "mono" }, w.leg === "cf-config" ? "Cloudflare config" : "Media"), " (", origin, ") will be written into ", h("span", { class: "mono" }, w.targetAccount), h("span", { class: "field__hint" }, " (confirm the target account on apply)")));
    }
    note.appendChild(list);
    card.appendChild(note);
  }

  // CROSS-ZONE: the account guard above does not cover the right account and the WRONG ZONE, which is
  // the easier mistake for a customer with several zones. The engine refuses the apply on a proven mismatch
  // unless the target zone is echoed back, so this drives the same type-to-confirm the account warning
  // does. Without it the engine's refusal would arrive with nothing on screen having predicted it, and the
  // customer would have no way through the console to proceed deliberately.
  //
  // The surfaces are NAMED rather than counted, because a count cannot be reviewed. Zone ids and surface
  // names render as escaped text (the console XSS invariant), never innerHTML.
  if (plan.crossZoneWarning) {
    const w = plan.crossZoneWarning;
    const note = h("div", { class: "impact impact--warn", role: "note" });
    note.appendChild(h("div", { class: "impact__head" }, svgIcon(ICON_ALERT, { size: 18 }), h("span", "Cross-zone restore: this writes into a different Cloudflare zone")));
    const origin = w.originZone !== null
      ? h("span", "captured from zone ", h("span", { class: "mono" }, w.originZone))
      : h("span", "the archive does not record which zone it came from");
    const list = h("ul", { class: "skipped-list" });
    list.appendChild(h("li", origin, ", writing into zone ", h("span", { class: "mono" }, w.targetZone),
      h("span", { class: "field__hint" }, w.originZone !== null ? " (confirm the target zone on apply)" : " (the zone could not be checked, so this is not blocked)")));
    for (const s of w.zoneSurfaces) list.appendChild(h("li", { class: "mono" }, s));
    note.appendChild(list);
    card.appendChild(note);
  }

  // The precise integrity statement: verified, not "proven perfect".
  //
  // The reassurance is a SEPARATE, MARKED element rather than the tail of this string, so it can be revised
  // when it stops being true. See unwrittenNote below.
  card.appendChild(
    h(
      "p",
      { class: "restore-plan__integrity field__hint" },
      svgIcon(ICON_SHIELD_CHECK, { size: 14 }),
      " Every record above was opened read-only and its plaintext hash verified. ",
      unwrittenNote(),
    ),
  );

  // The dual-control binding key (plan hash): show the operator the EXACT hash an
  // approval binds to. Computed client-side from the request
  // (the engine recomputes and gates on it server-side). Redaction-safe (names, counts,
  // selectors only). If it cannot be computed, the flow still works; the hash is a cue.
  let planHash: string | null = null;
  try {
    // Bind the surface allow-list the ENGINE resolved for this plan, not one derived here. The engine
    // binds it and the default is its proven set, which the console has no copy of, so a mirror that
    // omitted it produced a different hash for every cf-config restore.
    planHash = await restorePlanHash(
      req.cfConfig !== undefined && plan.cfConfigSurfaces !== undefined
        ? { ...req, cfConfig: { ...req.cfConfig, surfaces: plan.cfConfigSurfaces } }
        : req,
    );
  } catch {
    // THE HASH THE WHOLE DUAL-CONTROL GATE MATCHES ON COULD NOT BE COMPUTED IN THIS BROWSER. The flow
    // carries on (the hash is a cue, and the engine is the authority), but the consequence is not cosmetic: with
    // a null hash the client apply gate can never arm, so Apply stays greyed out however many approvers sign,
    // and the screen says only "awaiting approval". restorePlanHash needs WebCrypto, which is absent outside a
    // secure context, so a console served over plain http lands here on every restore it ever runs. The throw
    // is swallowed and never read; only the class travels.
    //
    // Through the SHARED latch, not recordRestoreGateBlocked directly: the approval recheck below sees the same
    // null hash for the same run and would otherwise record a second row for one blocked plan, making `count` mean
    // "how many code paths noticed" rather than "how many plans were blocked".
    reportPlanHashFailed(req.runId ?? null);
    planHash = null;
  }
  onPlanHash?.(planHash);

  // 3. Confirm + apply. Gated by BOTH the role AND a usable dual-control
  // approval bound to this plan hash; renderConfirm is async because it asks the
  // engine (listApprovals) whether a distinct approver has already signed this plan
  // before it offers an enabled Apply.
  card.appendChild(await renderConfirm(engine, plan, req, planHash, { highImpact, isLarge, isRedirect, isNonLatest, isCrossAccount, isCrossZone }, paintStepper, reenter));
  return card;
}

function impactBanner(plan: RestorePlan, req: RestoreRequest, flags: { isRedirect: boolean; isNonLatest: boolean; isLarge: boolean }): HTMLElement {
  // Tone tracks the confirm friction exactly (renderApplyControls: highImpact || isLarge
  // escalates to type-to-confirm), so the banner and the gate never disagree. The calm
  // default (same binding, latest run, small) is the happy path of the hero screen and
  // two gates still stand before any write, so it reads as a plain statement, not an alert
  // box. Why every tone ends "Nothing has been written yet": the block at the foot of this file.
  if (!flags.isNonLatest && !flags.isRedirect && !flags.isLarge) {
    return h(
      "p",
      { class: "impact__line", role: "note", style: "margin:0 0 var(--space-4)" },
      `${reviewImpactLine(plan)} `,
      unwrittenNote(),
    );
  }
  // Tone is reserved for the genuinely dangerous blast radius: a redirect writes every record to
  // ONE binding the operator chose, not its original source, so it is always danger. An older run
  // restored back to its ORIGINAL bindings is a real caution but not that kind of danger, so it
  // reads warn (amber) - the same tone the approvals inbox already uses for this exact fact. When
  // a plan is BOTH a redirect and non-latest, the banner is danger and the redirect fact leads
  // (the headline, then its own escalate line first), with the older-run fact stated straight
  // after it, never the other way round.
  const tone: "warn" | "danger" = flags.isRedirect ? "danger" : "warn";
  const wrap = h("div", { class: `impact impact--${tone}`, role: "note" });
  const head = h(
    "div",
    { class: "impact__head" },
    svgIcon(ICON_ALERT, { size: 20 }),
    h("span", flags.isRedirect ? "Redirecting the whole run to one binding" : flags.isNonLatest ? "Restoring an older run over current data" : "A large write to your live account on apply"),
  );
  wrap.appendChild(head);
  // The one-sentence exact effect (real text), scaled to the plan. The bare write summary
  // only: the older-run fact is stated ONCE, by its escalate line below, never twice in
  // one banner (the combined impactSentence stays for the one-sentence surfaces).
  wrap.appendChild(h("p", { class: "impact__line" }, `${writeSummarySentence(plan, req)} `, unwrittenNote()));
  if (flags.isRedirect && req.target?.binding) {
    wrap.appendChild(
      h("p", { class: "impact__escalate" }, `Every record is written to binding ${req.target.binding}, not to its original source binding.`),
    );
  }
  if (flags.isNonLatest) {
    wrap.appendChild(
      h("p", { class: "impact__escalate" }, `You are restoring an older run (${plan.runId}) over current data. This is not the latest run for this downpipe.`),
    );
  }
  return wrap;
}

function planFigures(plan: RestorePlan): HTMLElement {
  const grid = h("div", { class: "restore-figs" });
  // "Records verified" carries the ok dot: a good-value read (every record hash-verified). The
  // "Latest run" tile carries the warn dot only for a non-latest run: a terse visual back-reference
  // to the older-run caution the banner above already states in full, never a second full sentence.
  grid.appendChild(figure("Records verified", groupNumber(plan.recordsVerified), "full chain + plaintext hash", "ok"));
  // "written on apply" left the count's SCOPE unstated, so a config-only plan's honest zero read as the
  // whole plan. The caption now says what the number counts, on every plan rather than only the config
  // ones, because a figure that only explains itself when it would otherwise mislead is a figure the
  // operator has learnt to read wrongly everywhere else.
  grid.appendChild(figure("Planned writes", groupNumber(plan.plannedWrites), "data records written on apply"));
  // The config leg gets its own tile whenever the plan carries a config diff at all, including the diff
  // where nothing will apply: a plan that examined 59 surfaces and found nothing to change should say zero
  // out loud, not go quiet and leave the data-record zero standing alone.
  if (plan.configChanges !== undefined) {
    const examined = plan.configChanges.length;
    grid.appendChild(figure("Config surfaces to apply", groupNumber(configSurfacesToApply(plan)), `of ${groupNumber(examined)} examined`));
  }
  grid.appendChild(figure("Upper-bound bytes", humanBytes(plan.bytes), "summed plaintext size"));
  grid.appendChild(figure("Latest run", plan.isLatest ? "Yes" : "No", plan.isLatest ? "the newest run" : "an older run", plan.isLatest ? "none" : "warn"));
  // Last possible write: absent only on the refusal stubs above that never reach here (plan.ok is already
  // true by this point). This is the WRITE-COMPLETION bound (engine RESTORE_APPLY_DEADLINE_MS = the
  // approval's own TTL plus the reservation lease an apply holds while it writes), not the refusal
  // boundary. The engine refuses a FRESH apply reservation earlier, when the approval itself expires
  // (anchor + APPROVAL_TTL_MS), which is up to RESTORE_APPLY_LEASE_MS (30 minutes today) before this
  // instant: effectiveStatus reads "expired" at that earlier point, ahead of the reservation branch. This
  // screen does not compute that earlier instant, because the engine does not publish it on the plan (only
  // an approval record carries expiresAt, once one exists) and re-deriving RESTORE_APPLY_LEASE_MS here
  // would duplicate an engine constant the console has no way to keep in step with. The absolute instant
  // leads (stable in a screenshot, matching absoluteTime's own design intent); the caption states what the
  // instant actually bounds and says plainly that approval has to happen earlier.
  if (plan.applyDeadline !== undefined) {
    grid.appendChild(figure(
      "Last possible write",
      absoluteTime(plan.applyDeadline),
      `writing can continue until this instant at the latest (${relativeTime(plan.applyDeadline)}); approve and reserve the apply earlier`,
    ));
  }
  return grid;
}

function resolvedDestinations(
  sample: RestorePlan["sample"],
  // plannedWrites is the plan's full write count, so the sample can say what fraction of
  // the whole it shows rather than reading as if these rows were the entire restore.
  plannedWrites: number,
  isRedirect: boolean,
  // onRestoreOne, when supplied, adds a per-row "Restore just this" affordance that scopes the flow to
  // exactly that one record (a granular single-record restore). Absent when the plan is already a
  // single-record plan (there is nothing to narrow), so the column is omitted entirely in that case.
  onRestoreOne?: (recordName: string) => void,
): HTMLElement {
  const wrap = h("section", { class: "restore-sample" });
  // A normal mixed-case sub-heading (not the small muted .section-label micro-label,
  // which shouts inside the plan card), matching the other in-card h3 sub-headings
  // (drawer-section__title). restore-sample__title carries the
  // element's own spacing.
  wrap.appendChild(h("h3", { class: "restore-sample__title", style: "font-size:var(--text-md);font-weight:var(--weight-semibold)" }, "Resolved destinations (sample)"));
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      `A sample of ${groupNumber(sample.length)} of ${groupNumber(plannedWrites)} planned writes; every sampled record was hash-verified read-only.`,
    ),
  );
  if (isRedirect) {
    wrap.appendChild(h("p", { class: "field__hint" }, "Every sampled record resolves to the redirect target, which is the point of a redirect."));
  }
  if (onRestoreOne) {
    wrap.appendChild(h("p", { class: "field__hint" }, "Restore the whole run with the controls below, or restore one record on its own with the per-row action."));
  }
  const tableWrap = h("div", { class: "dp-table-wrap" });
  const tableEl = h("table", { class: "dp-table", "aria-label": "Sample of records to write and their resolved destinations" });
  const headRow = h(
    "tr",
    h("th", { scope: "col" }, "Record"),
    h("th", { scope: "col" }, "Type"),
    h("th", { scope: "col" }, "Destination"),
    h("th", { scope: "col", class: "num" }, "Size"),
  );
  if (onRestoreOne) headRow.appendChild(h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Restore one record")));
  tableEl.appendChild(h("thead", headRow));
  const tbody = h("tbody");
  for (const s of sample.slice(0, MAX_DISPLAY_ROWS)) {
    const dest = s.binding || s.namespace || s.bucket || "-";
    const row = h(
      "tr",
      h("td", h("span", { class: "mono" }, s.name)),
      h("td", sourceTypeBadge(s.sourceType)),
      h("td", h("span", { class: "mono" }, dest)),
      h("td", { class: "num" }, humanBytes(s.plaintextSize)),
    );
    if (onRestoreOne) {
      // "Restore just this" re-enters the flow scoped to exactly this record (a fresh dry-run with its
      // own plan hash + approval). The aria-label names the record so the action is unambiguous to AT.
      row.appendChild(
        h(
          "td",
          h(
            "button",
            { "data-dp": "restore-flow.button.restore-one",
              class: "btn btn--ghost btn--sm",
              type: "button",
              "aria-label": `Restore just the record ${s.name}`,
              on: { click: () => onRestoreOne(s.name) },
            },
            "Restore just this",
          ),
        ),
      );
    }
    tbody.appendChild(row);
  }
  tableEl.appendChild(tbody);
  tableWrap.appendChild(tableEl);
  wrap.appendChild(tableWrap);
  return wrap;
}

// ---- the skipped records, grouped by what to DO about them (not one flat wall) ----


// ---- where the dry-run reassurance sits, and why it moved --------------------------------------
//
// "Nothing has been written yet" is the one sentence a frightened operator needs earliest, and until now
// it was the LAST thing on the card. It rode on the integrity statement, which sits below the
// resolved-destinations table (up to 200 rows), below every skipped group, and below the cross-account
// and cross-zone warnings. So an operator scrolling a large plan met the entire blast radius, in warn
// and danger tints, before reaching the sentence that says none of it has happened.
//
// It now ends the impact banner in EVERY tone, which is the first element on the card, so the
// reassurance arrives before the blast radius rather than after it. The integrity statement keeps its
// own copy of the fact deliberately: that sentence is about the records "above" and their read-only
// hash verification, which is a claim about the table it follows, and it is correctly placed for them.
