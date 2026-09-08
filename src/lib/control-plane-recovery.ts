// Control-plane recovery -- the PURE model behind the recovery banner + reconcile form (no DOM, no
// network), so the load-bearing decisions are testable in isolation (the console idiom: extract the logic,
// keep the render thin). Two pieces:
//
//   recoveryBannerModel -- given the engine's ControlPlaneStatus, decide whether to raise the standing banner
//     and with what copy. The banner is the SILENCE-KILLER's console face: a SchedulerDO wipe leaves the
//     control plane empty and backups silently stopped; the engine latches recovery-required (so whoami
//     resolves to viewer, never a silently re-bootstrapped Owner) and this banner makes that loud, with the
//     break-glass reconcile affordance. Precise, never alarmist-when-fine: it shows ONLY when the engine
//     reports recoveryRequired.
//
//   parseReconcileInput -- validate the operator's reconcile form (the signed no-custody export JSON they
//     pulled out-of-band from the destination bucket, its detached signature, and the break-glass ADMIN_TOKEN)
//     BEFORE any request. No-custody: the export is parsed and shape-checked but never re-serialised or
//     mutated by the console; the engine re-verifies the signature + the no-custody invariant server-side and
//     is the enforcement point -- this is a friendly client pre-flight only.

import type { ControlPlaneStagedSummary, ControlPlaneStatus } from "./api/types/control-plane.ts";
import { recordRecoveryRefusal } from "./client-diag/ring.ts";
import { type RecoveryRefusalCode, withRefusalCode } from "./recovery-refusal-codes.ts";

// RecoveryBannerModel is the banner's resolved presentation: show or not, plus the copy. tone was ALWAYS
// "danger" when shown, and that is why it is no longer: on an estate whose configuration came back the
// danger copy asserts that backups have stopped when they are running, which is both untrue on the first
// screen an operator sees and a mask over the NEXT real latch. tone, title and body are all chosen by the
// same `exit` discriminant below, so the sentence and the button can never disagree. reason is the
// engine's redaction-safe one-line explanation (or a stable fallback when the engine sent none). staged
// carries the auto-heal's staged-recovery summary when one exists, so the banner can offer the
// break-glass CONFIRM (no pasted export needed) instead of the manual reconcile form, which a sealed estate's
// artefact can never satisfy (see ControlPlaneStagedSummary).
export interface RecoveryBannerModel {
  show: boolean;
  tone: "danger" | "warn";
  title: string;
  body: string;
  reason: string | null;
  staged: ControlPlaneStagedSummary | null;
  exit: RecoveryExit;
}

// RecoveryExit is WHICH way out this estate actually has, and it exists because the latch's three
// exits are guarded as EXACT COMPLEMENTS. The two break-glass routes rebuild a wiped plane, so both refuse a
// NON-EMPTY role table; the acknowledge clears the latch and so refuses an EMPTY one. Between them they cover
// every estate. The banner used to choose between the first two alone, so on an established account -- which
// the last-Owner guard makes the norm -- every button it offered was one the engine had to refuse, and the
// engine's own 409 then pointed at the sibling route that refuses them too.
//
// Two of the five members offer NO ACTION, and that is the deliberate half of this repair rather than a gap.
// A button wired to a route that must refuse is worse than no button: it costs an operator mid-incident a
// round trip and a refusal to learn what the console already knew. Each of the two says what does open the
// way instead, and both of those paths are reachable without leaving the product.
//
//   acknowledge       the plane came back and authority survived. The acknowledge clears the latch. THE ONE
//                     EXIT AN ESTABLISHED ACCOUNT HAS, and the one the console never called.
//   confirm           a wiped plane with an auto-heal-staged export: the break-glass confirm restores access.
//   reconcile         a wiped plane with nothing staged: the manual break-glass rebuild.
//   await-config      authority survived and the configuration is NOT KNOWN to be back (the engine said it is
//                     empty, or did not say). Nothing here can be rebuilt, because every rebuild route refuses
//                     the surviving role table, and nothing should be acknowledged either: on a still-empty
//                     plane the latch is telling the truth and the next health pass would set it again. The
//                     way out is the configuration returning, by the health pass or by hand, then the
//                     acknowledge.
//   grant-role-first  the plane came back while the role table stayed empty, which is what break-glass
//                     activity during a latch produces. The reconcile refuses a non-empty plane and the
//                     acknowledge refuses an empty role table, so the way out is a break-glass role grant.
export type RecoveryExit = "acknowledge" | "confirm" | "reconcile" | "await-config" | "grant-role-first";

// RECOVERY_BANNER_TITLE / _BODY are the standing copy. The title names the condition; the body states the
// consequence (backups stopped) and the remedy (break-glass reconcile), with no secret and no alarmist
// over-claim. Exported so the test pins the exact strings.
export const RECOVERY_BANNER_TITLE = "Control plane needs recovery";
export const RECOVERY_BANNER_BODY =
  "The scheduler control plane appears to have been lost, so scheduled backups have stopped. Your archived data is unaffected and remains independently recoverable. Recover the control plane from a signed config export with your break-glass token.";

// The RECOVERED copy. The banner above asserts that backups have STOPPED, and on an estate whose
// configuration is back that sentence is false, on the first screen an operator sees, for as long as the latch
// stands. It is not a softer wording of the same fact: the two states have different truths and different
// remedies, and the tone follows, because a standing danger banner over a recovered estate also masks the
// NEXT real latch. Exported so the validator pins the exact strings.
export const RECOVERY_RECOVERED_TITLE = "Recovery is still marked open";
export const RECOVERY_RECOVERED_BODY =
  "Your control-plane configuration is back and scheduled backups are running again, but the recovery flag the engine raised is still set, so this notice stands until someone clears it. Check the reason below is something you have actually put right, then acknowledge it.";
// The two no-action states, whose whole job is to name the path that IS open.
//
// await-config's copy deliberately does NOT assert that the plane is empty. It is reached both when the engine
// says configEmpty and when the engine did not say, and a body that asserted emptiness would be a claim this
// state has not established. What it CAN assert in both is the half that decides the remedy: authority
// survived, so no break-glass route is the way out.
export const RECOVERY_AWAIT_CONFIG_TITLE = "Recovery is marked open and your operator roles survived";
export const RECOVERY_AWAIT_CONFIG_BODY =
  "Your operator roles are intact, so this was not a full wipe, and the break-glass rebuild routes refuse an estate with surviving authority by design: neither of them is your way out. If your configuration has not come back yet, the scheduled health pass re-applies it from the signed export when it can reach one, and you can put a downpipe or destination back yourself in the meantime. Once the configuration is back, this notice clears with Acknowledge recovery.";
export const RECOVERY_GRANT_ROLE_TITLE = "Configuration is back, but no operator role is left";
export const RECOVERY_GRANT_ROLE_BODY =
  "Your configuration has returned while the operator role table is empty, which is what break-glass activity during a recovery leaves behind. Neither remedy is open in this state: the manual rebuild refuses an estate whose plane is no longer empty, and acknowledging would remove the only explanation for why every caller is resolving to viewer. Grant an owner role with your break-glass token, then acknowledge as that owner.";

// recoveryBannerModel maps the engine's recovery status to the banner presentation. It shows the banner ONLY
// when the engine reports recoveryRequired (never on a healthy plane, never on a brand-new empty account: the
// engine distinguishes amnesia -- empty config but a bucket with runs -- from a fresh account, and only the
// former latches recoveryRequired). A null status (the read failed / not yet resolved) shows nothing: the
// banner must never be raised on an unknown state, only on a confirmed recovery-required latch.
// It also resolves WHICH EXIT the estate has, from the engine's two emptiness facts. The table is the whole
// repair and it is written out rather than nested, because the guards it mirrors are exact
// complements and a reader has to be able to check it against them line by line:
//
//   roleTableEmpty   configEmpty   exit               why
//   false            false         acknowledge        the plane came back, authority survived
//   false            true          await-config       every rebuild route refuses surviving authority
//   false            ABSENT        await-config       same reason: authority alone decides this one
//   true             false         grant-role-first   reconcile refuses a live plane, acknowledge an empty table
//   true             true          confirm/reconcile  the genuine wipe the break-glass routes are built for
//   true             ABSENT        confirm/reconcile  unchanged
//   ABSENT           false         acknowledge        the plane is back; if the table is empty after all, the
//                                                     engine refuses honestly and names the role grant
//   ABSENT           true          confirm/reconcile  unchanged from before this field existed
//   ABSENT           ABSENT        confirm/reconcile  unchanged: an unread emptiness is not a recovered plane
//
// BOTH ABSENCES MEAN UNKNOWN, AND NEITHER MEANS FALSE. roleTableEmpty absent must not be read as a surviving
// role table, and configEmpty absent must not be read as a plane that came back: the second is the dangerous
// direction, because it would offer an acknowledge -- the action that CLEARS the warning -- over a plane
// nobody has established anything about, which is the false all-clear this whole banner exists to prevent.
// Reading absent-as-false would turn a confirmed latch into the recovered state on a body that carries no
// configEmpty at all. Every unknown row falls back to the behaviour that was already there.
export function recoveryBannerModel(status: ControlPlaneStatus | null): RecoveryBannerModel {
  const show = status?.recoveryRequired === true;
  const reason = show ? (status?.reason ?? null) : null;
  const staged = show ? (status?.staged ?? null) : null;
  const configEmpty = typeof status?.configEmpty === "boolean" ? status.configEmpty : null;
  const roleTableEmpty = typeof status?.roleTableEmpty === "boolean" ? status.roleTableEmpty : null;
  const wipeExit: RecoveryExit = staged !== null ? "confirm" : "reconcile";
  // Read in the order the guards decide things. A plane that is KNOWN to be back settles it first, because
  // that is the only state the acknowledge can pass in. Otherwise a role table that is KNOWN to have survived
  // settles it, because that alone makes every break-glass route refuse, whether or not the plane's own
  // emptiness was reported. Everything left is the unknown or the genuine wipe, and both keep the behaviour
  // that was already there.
  const exit: RecoveryExit =
    configEmpty === false
      ? roleTableEmpty === true
        ? "grant-role-first"
        : "acknowledge"
      : roleTableEmpty === false
        ? "await-config"
        : wipeExit;
  const copy = COPY_FOR_EXIT[exit];
  return { show, tone: copy.tone, title: copy.title, body: copy.body, reason, staged, exit };
}

// COPY_FOR_EXIT pins one title/body/tone per exit, so the sentence an operator reads and the action they are
// offered can never disagree: they are chosen by the same discriminant, in one place. The two break-glass
// exits keep the original standing copy verbatim, because on a genuinely wiped plane it was, and remains,
// true.
const COPY_FOR_EXIT: Readonly<Record<RecoveryExit, { tone: "danger" | "warn"; title: string; body: string }>> = {
  confirm: { tone: "danger", title: RECOVERY_BANNER_TITLE, body: RECOVERY_BANNER_BODY },
  reconcile: { tone: "danger", title: RECOVERY_BANNER_TITLE, body: RECOVERY_BANNER_BODY },
  acknowledge: { tone: "warn", title: RECOVERY_RECOVERED_TITLE, body: RECOVERY_RECOVERED_BODY },
  "await-config": { tone: "danger", title: RECOVERY_AWAIT_CONFIG_TITLE, body: RECOVERY_AWAIT_CONFIG_BODY },
  "grant-role-first": { tone: "danger", title: RECOVERY_GRANT_ROLE_TITLE, body: RECOVERY_GRANT_ROLE_BODY },
};

// ReconcileInput is the validated reconcile-form payload ready to send: the parsed export artefact (an opaque
// object the console forwards verbatim -- it never re-serialises it), its detached signature, and the
// break-glass token. No field is ever logged or stored; the token is held only for the one request.
export interface ReconcileInput {
  exportArtefact: unknown;
  signature: string;
  token: string;
}

// ParseReconcileResult is the discriminated outcome of validating the reconcile form. A rejection carries
// BOTH the operator-facing message (with the code already stamped in) and the code itself, so a caller (and
// the validator) can read the class without parsing prose.
export type ParseReconcileResult =
  | { ok: true; value: ReconcileInput }
  | { ok: false; error: string; code: RecoveryRefusalCode };

// looksLikeControlPlaneExport is a cheap client-side shape gate mirroring the engine's isControlPlaneExport
// (the engine is the authority and re-checks everything; this only catches an obvious paste mistake early
// with a friendly message). It checks the version pin + the structural fields the reconcile depends on.
export function looksLikeControlPlaneExport(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.exportedAt === "string" &&
    typeof o.configContentHash === "string" &&
    Array.isArray(o.downpipes) &&
    Array.isArray(o.destinations) &&
    Array.isArray(o.roles) &&
    typeof o.priorAuditHead === "object" &&
    o.priorAuditHead !== null
  );
}

// parseReconcileInput validates the operator's reconcile form. It requires non-empty export JSON that parses
// and looks like a control-plane export, a non-empty detached signature, and a non-empty break-glass token.
// It returns a friendly, specific error for each failure (no oracle: these are operator-input mistakes, not a
// security boundary -- the engine is). The export is parsed but returned as the opaque parsed value, never
// re-serialised, so the bytes the engine signed are preserved by the client forwarding `export: value`.
//
// Each rejection carries a STABLE REFUSAL CODE stamped into the message (lib/recovery-refusal-codes.ts).
// These rejections are decided in the browser and never reach the engine, so on the wiped engine this flow
// exists for, the code on screen is the only trace of them anywhere, and it is what the operator reads out.
export function parseReconcileInput(raw: { exportText: string; signature: string; token: string }): ParseReconcileResult {
  const exportText = raw.exportText.trim();
  const signature = raw.signature.trim();
  const token = raw.token.trim();
  // The reconcile half: a browser-side rejection the engine can never see (and on a wiped engine there
  // may be no engine left to see anything). The op is `cp-restore`, not `estate-import`: the two flows share
  // this code vocabulary and are different tickets.
  const refuse = (message: string, code: RecoveryRefusalCode): ParseReconcileResult => {
    recordRecoveryRefusal("cp-restore", code);
    return { ok: false, error: withRefusalCode(message, code), code };
  };
  if (exportText === "") return refuse("Paste the signed control-plane export JSON (the …/_RECOVERY/CONTROL-PLANE/<version>-<time>.json file from your destination bucket).", "DP-R01");
  let exportArtefact: unknown;
  try {
    exportArtefact = JSON.parse(exportText);
  } catch {
    return refuse("The export is not valid JSON. Paste the whole .json file exactly as it is in the bucket.", "DP-R02");
  }
  if (!looksLikeControlPlaneExport(exportArtefact)) {
    return refuse("That JSON does not look like a control-plane export (expected a v:1 artefact with downpipes, destinations and a prior audit head).", "DP-R03");
  }
  if (signature === "") return refuse("Paste the detached signature (the matching …json.sig file from your destination bucket).", "DP-R04");
  if (token === "") return refuse("Enter your break-glass token (ADMIN_TOKEN) to authorise the reconcile.", "DP-R06");
  return { ok: true, value: { exportArtefact, signature, token } };
}
