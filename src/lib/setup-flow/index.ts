// The headless setup model's public surface: the ONLY module a setup UI (the reference walk in
// screens/setup/, or a concept) imports from lib/setup-flow/. README.md in this folder is the API.

import { confirmModal } from "../../components/modal.ts";
import { clearLeaveGuard, navigate, registerLeaveGuard } from "../nav.ts";
import { clearSensitiveState, getCeremony } from "../store.ts";
import { setupModel } from "./model.ts";

export * from "./types.ts";
export { MAIN_STEPS, OPTIONAL_STEPS, ALL_STEPS, OWNER_STEPS, stepRoute, parseSetupParams, nextMainStep, pickedBindingsLive, firstRunSealed, firstRunDone, firstBackupOutstanding, effectivePosture, isSetupStepId, setUpByEstateFacts, type StepDef } from "./steps.ts";
export { setupModel, pickedResources, defaultDraft, manualBindingFor, SetupModel, type RefreshScope } from "./model.ts";
export * from "./inventory.ts";
export {
  type ActionResult, type ActionError, type ActionErrorKind, type DestinationCredentials, type GeneratedKeys,
  startSetup, verifyToken, refreshDiscovery, saveDestination, acknowledgePosture, recordPostureAgain, custodyForSheet, generateKeys, ceremonyMatchesPosture, POSTURE_MISMATCH,
  redownloadFile, openRecoverySheet, confirmKeysSaved, currentCeremony, verifyIdentityFile, verifyRecoveredIdentity, removeToken, readAccountChoice, chooseAccounts, leaveAfterPaint,
} from "./actions.ts";
export {
  type ApplyStage, type ApplyStageState, type ApplyProgress, type ApplyResult, type SelfDeployPlan, type CreateResult,
  type RunStage, type RunProgress,
  applyWithDeployToken, bindingsToAttach, markDeployTokenRevoked, selfDeployPlan, planDownpipes, createDownpipes, runNow,
  runStageOf, watchRun, grantRole, skipTeam, setRestoreApproval, readEngineChecks, type EngineCheck,
} from "./actions-apply.ts";
export { buildReceipt, hardeningSuggestions, finishNextSteps, canSayProtected, type Receipt, type ReceiptLine, type NextStep } from "./receipt.ts";
export { downloadText } from "./ceremony-files.ts";
export { finishSetup } from "./install.ts";

// guardUnbankedKeys registers THE leave guard for the setup surface: while this tab holds generated keys the
// engine does not have yet, leaving /setup (an in-app link, the rail, the command palette, a go-to shortcut,
// browser Back or Forward, reload or close) asks first. Moving between /setup steps keeps the material and
// passes silently. The Keys screen is NOT exempt: it is outside setup, and a detour there once let the rail
// or a second shortcut clear the keys with no prompt. On "Leave anyway" the keys are cleared at once, so the
// prompt's words are what happens. `anchor` is any element of the rendered setup page: when it is detached (a
// forced redirect tore the page down) the guard clears itself.
export function guardUnbankedKeys(anchor: HTMLElement): () => void {
  const guard = (to: string): boolean => {
    if (!anchor.isConnected) {
      clearLeaveGuard(guard);
      return true;
    }
    if (getCeremony() === null) return true;
    if (to === "/setup" || to.startsWith("/setup/") || to.startsWith("/setup?")) return true;
    void confirmModal({
      title: "Leave before installing your keys?",
      body: "Your keys were generated in this browser and are not on your engine yet. Leaving clears them from this tab, and the files you downloaded will not match the new set you would have to generate.",
      confirmLabel: "Leave anyway",
      variant: "danger",
    }).then((ok) => {
      if (ok) {
        clearLeaveGuard(guard);
        clearSensitiveState();
        setupModel().touch();
        navigate(to);
      }
    });
    return false;
  };
  registerLeaveGuard(guard, () => getCeremony() !== null);
  return () => clearLeaveGuard(guard);
}
