// The guided-setup, credentials-count and update-chip refresh helpers, split out of the app
// entry (app.ts). They own the small coalescing timers and the setup-view state, and the entry
// reads the current setup view back through getSetupView() for the route gate and the shell
// strip. No polling loop lives here: every helper runs only when called from a real navigation,
// a focus event, or an identity resolution.

import { getEngine } from "./store.ts";
import { channelReasonClassFor, recordReadDegraded, recordUpdateChannelUnverified } from "./client-diag/ring.ts";
import { fetchSetup, setupCelebrated, markSetupCelebrated, type SetupView } from "./setup-state.ts";
import { consoleVersion } from "./console-version.ts";
import { consoleUpdateAvailable } from "../screens/licence/shared.ts";
import type { UpdateStatus } from "../api.ts";
import type { Shell } from "../shell/app-shell.ts";
import type { UpdateChipView } from "../shell/chrome.ts";

// setupView is the guided-setup state the route gate and the shell strip read (the
// setup-first IA). null = unknown or acknowledged-complete, which NEVER gates
// (fail-open: a transient setup-state read failure must not lock a working
// console). It refreshes on identity resolution and after every navigation while
// setup is incomplete (each step's completion is observed within a navigation or
// two of the action that completed it).
let setupView: SetupView | null = null;
let setupRefreshAt = 0;

// getSetupView exposes the current guided-setup state to the route gate and the afterEach
// hook in app.ts without those reaching for the module variable directly.
export function getSetupView(): SetupView | null {
  return setupView;
}

export async function refreshSetup(shell: Shell): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  const now = Date.now();
  if (now - setupRefreshAt < 2000) return; // coalesce bursts (afterEach fires on redirects too)
  setupRefreshAt = now;
  const view = await fetchSetup(engine);
  // Completed-and-acknowledged renders nothing; completed-but-new shows the
  // completion strip ONCE (auto-acknowledged on first showing, so it never nags
  // across boots; the dismiss closes it sooner). Unknown clears any stale gating.
  setupView = view;
  if (view === null) shell.setSetup(null);
  else if (view.complete && setupCelebrated()) shell.setSetup(null);
  else {
    shell.setSetup(view);
    if (view.complete) markSetupCelebrated();
  }
}

// forceRefreshSetup clears the coalesce window so the next refreshSetup is not skipped, then
// fires it. It is the focus-handler and identity-resolution path (the natural "did it land?"
// moments), where the coalesce delay must not swallow the read.
export function forceRefreshSetup(shell: Shell): void {
  setupRefreshAt = 0;
  void refreshSetup(shell);
}

// refreshExpiryCount reads the engine status and surfaces the combined "credentials need attention"
// count as the one quiet chip on the /credentials rail item: status.expiryWarnings (functional
// credentials approaching/expired) + status.cleanupPending (spent ephemeral tokens awaiting deletion
// confirmation). HONESTLY ABSENT: when the engine reports NEITHER field (an older engine), the count
// is left as null so no chip is shown rather than a fabricated 0; when it reports at least one, the
// other defaults to 0 (the missing half is genuinely none). Fail-open: a transient status read
// failure leaves the existing chip untouched (no flicker to zero on a blip). It runs on identity
// resolution and on the same nav/focus cadence as the setup refresh, no polling loop, no ambient
// behaviour.
export async function refreshExpiryCount(shell: Shell): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  try {
    const status = await engine.status();
    const reported = status.expiryWarnings !== undefined || status.cleanupPending !== undefined;
    shell.setNavCount("/credentials", reported ? (status.expiryWarnings ?? 0) + (status.cleanupPending ?? 0) : null);
  } catch (err) {
    // Transient/absent status: leave the chip as-is (fail-open; never fabricate or zero on a blip).
    //
    // Keeping the chip is right, keeping QUIET about it is not. A status read that is persistently
    // failing leaves the credentials count frozen at whatever it last was, so a credential that expired while
    // the read was broken is never flagged, and the chip looks like a healthy zero rather than an unknown.
    recordReadDegraded("status", err);
  }
}

// maybeRefreshExpiryCount coalesces the nav-driven count refresh so a burst of navigations (a
// redirect chain) makes at most one status read every few seconds. Not a timer/loop: it only runs
// when called from a real navigation or focus.
let expiryRefreshAt = 0;
export function maybeRefreshExpiryCount(shell: Shell): void {
  const now = Date.now();
  if (now - expiryRefreshAt < 3000) return;
  expiryRefreshAt = now;
  void refreshExpiryCount(shell);
}

// ---- the context-bar "Update available" chip --------------------------------------------------

// updateChipView is THE chip decision, pure: the update verdict -> the chip view, or null for
// hidden. Shown ONLY when a verified channel genuinely carries something newer: the engine says
// updateAvailable, or the release's console component is strictly newer than the version baked
// into THIS bundle (consoleUpdateAvailable -- the licence screen's own decision, reused verbatim
// so the chip and the Updates section can never disagree). Unconfigured, unverified, up to date,
// an unstamped build with no engine update, and a not-yet-loaded verdict all yield null: the chip
// never renders on an unknown or a fabrication. The version shown is the release the chip points
// at: the top-level recommended version when the engine itself updates, else the console
// component's; null when the channel named none (the chip then reads plain "Update available").
export function updateChipView(upd: UpdateStatus, ownConsoleVersion: string | null): UpdateChipView | null {
  // THIS LINE IS THE GAP. The engine consults the channel host and RETURNS the verdict here; the console
  // reads it, hides the chip, and throws the verdict away. So a channel whose SIGNATURE has been failing for six
  // weeks (the operator is two releases behind and was never told) and a healthy verified channel with nothing new
  // to offer BOTH produce no chip -- and produced an identical pack, because status.updateChannelConfigured is
  // Boolean(env.UPDATE_CHANNEL_URL && env.UPDATE_SIGNER_PUBLIC), an env-var presence check that stays true while the
  // signature fails for a month. It is not a verdict. This row is.
  //
  // Only INTENDED-BUT-UNVERIFIED is recorded, and INTENT is the word that had to change. The guard was
  // `upd.configured && !upd.verified`, and `configured` is the ENGINE'S VERDICT, not the operator's intent: the
  // engine answers configured:false for an unparseable UPDATE_CHANNEL_URL, a non-https one, and an
  // UPDATE_SIGNER_PUBLIC that will not parse. In all three BOTH env vars are set and the operator plainly meant to
  // have updates. So a truncated or whitespace-mangled paste of the signer key -- a base64url blob the operator
  // pastes by hand, and one of the likeliest ways an update channel silently freezes -- fell into the drop bucket:
  // no chip, no row, and a pack byte-identical to a healthy verified channel with nothing new to offer. That is
  // this gap's headline sentence, and it survived the first fix because the fix trusted the wrong boolean.
  //
  // An engine with NEITHER channel env var set is channelIntended:false and records nothing. That is a customer
  // who does not want update notifications, it is the product working as chosen, and a fault row on it would cry
  // wolf on every healthy estate that never wired the channel. A VERIFIED channel records nothing either.
  //
  // The reason is CLASSIFIED, never carried: channelReasonClassFor prefers the engine's own CLOSED channelFault
  // and falls back to the prose classifier, which reads upd.reason only to SELECT a member. The text -- which can
  // embed the channel URL and the signer key id -- is discarded; clamping it into the pack would be a leak with a
  // length bound on it, and a clamp is not a redaction.
  if (upd.channelIntended === true && !upd.verified) recordUpdateChannelUnverified(channelReasonClassFor(upd));
  if (!upd.configured || !upd.verified) return null;
  const engineUpd = upd.updateAvailable === true;
  const consoleUpd = consoleUpdateAvailable(upd, ownConsoleVersion);
  if (!engineUpd && !consoleUpd) return null;
  // Name the components with an update, never a version: the chip cannot claim a single number when the
  // engine and console version independently. (Engine first, console second: the apply order.)
  const components: string[] = [];
  if (engineUpd) components.push("engine");
  if (consoleUpd) components.push("console");
  return { components };
}

// refreshUpdateChip reads the update verdict and reflects it on the shell's chip (appear or
// disappear, no reload). The fetcher is injectable for the validators; fail-open like every
// refresh here: a transient read failure leaves the current chip state untouched (no flicker,
// no fabricated verdict), and the next window retries.
export async function refreshUpdateChip(
  shell: Shell,
  fetchUpdates: () => Promise<UpdateStatus>,
  ownConsoleVersion: string | null,
): Promise<void> {
  try {
    const upd = await fetchUpdates();
    // THIS USED TO RECORD A CONSOLE-SKEW ROW HERE, comparing ownConsoleVersion against upd.currentVersion. That
    // was wrong at the root: upd.currentVersion is ENGINE_VERSION, the ENGINE's own running version, and the
    // console's is package.json's. They are two independently incremented numbers from two separate repos, so
    // the comparison fabricated a skew on every healthy customer (console 0.1.10 vs engine 0.1.9 read as
    // "console-ahead") and inverted the direction on the stale-bundle ticket it was written for.
    //
    // The honest comparison is the RUNNING bundle against WHAT THE ORIGIN SERVES, both from the same repo and
    // the same release, and it lives at boot (recordServedBundleSkew, app.ts) where no engine read is needed.
    shell.setUpdateAvailable(updateChipView(upd, ownConsoleVersion));
  } catch (err) {
    // Transient/absent updates read: leave the chip as-is (fail-open; hidden stays hidden).
    //
    // "hidden stays hidden" is indistinguishable, on screen and in the pack, from "there is no update".
    // An operator stuck two releases behind, reporting that the console never told them, is this read failing
    // silently, and nothing anywhere records that it did.
    recordReadDegraded("update-chip", err);
  }
}

// UPDATE_CHIP_TTL_MS is the chip's refresh floor. GET /admin/updates has the engine consult the
// vendor channel host LIVE, so the shell asks at most once per 15 minutes; navigations and focus
// events inside the window are free (the verdict already on the chip stands). The licence screen
// remains the fresh authority: every visit there refetches on its own. Exported so the validator
// pins the floor (a regression to a chatty cadence fails loudly).
export const UPDATE_CHIP_TTL_MS = 15 * 60 * 1000;
let updateChipFetchedAt = 0;

// maybeRefreshUpdateChip coalesces the nav/focus/identity-driven chip refresh to the 15-minute
// floor. The stamp is taken BEFORE the read (not on success), so a failing channel coalesces
// identically; otherwise every navigation would retry the vendor-host hit. Not a timer/loop: it
// only runs when called from a real navigation, a focus event, or an identity resolution.
export function maybeRefreshUpdateChip(shell: Shell): void {
  const engine = getEngine();
  if (!engine) return;
  const now = Date.now();
  if (now - updateChipFetchedAt < UPDATE_CHIP_TTL_MS) return;
  updateChipFetchedAt = now;
  void refreshUpdateChip(shell, () => engine.updates(), consoleVersion());
}

// primeUpdateChipRefresh clears the coalesce window so the NEXT nav/focus refresh refetches.
// Called after a /licence visit -- the one screen where the verdict changes under the operator
// (an apply or rollback lands there) -- so the chip reflects an applied update on the very next
// navigation rather than up to 15 minutes later.
export function primeUpdateChipRefresh(): void {
  updateChipFetchedAt = 0;
}
