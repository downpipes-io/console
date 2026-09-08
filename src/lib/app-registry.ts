// The console's self-owned screen list and the one assembled command registry that the
// palette, the go-to chords and the cheat-sheet all read. This is the
// data-and-assembly layer of the app entry (app.ts): the SCREENS descriptor list, the
// REGISTRY folded from it, and the two pure route-classification sets the router wiring
// reads. It holds no runtime state and touches no DOM, so it is a sibling module of app.ts
// rather than inline in the entry. app.ts re-exports the same symbols it consumes from here.

import { overviewScreen } from "../screens/overview.ts";
import { sourcesDownpipesScreen } from "../screens/sources-downpipes.ts";
import { sourcesScreen } from "../screens/sources.ts";
import { destinationsScreen } from "../screens/destinations.ts";
import { addSourceScreen } from "../screens/add-source.ts";
import { runsScreen } from "../screens/runs.ts";
import { restoreFlowScreen } from "../screens/restore-flow.ts";
import { keysScreen } from "../screens/keys.ts";
import { accessSecurityScreen } from "../screens/access-security.ts";
import { idpConnectionsScreen } from "../screens/idp-connections.ts";
import { rolesBuilderScreen } from "../screens/roles-builder.ts";
import { settingsScreen } from "../screens/settings.ts";
import { licenceScreen } from "../screens/licence.ts";
import { onboardingCeremonyScreen } from "../screens/onboarding-ceremony.ts";
import { signedOutScreen } from "../screens/signed-out.ts";
import { passkeyScreen } from "../screens/passkey.ts";
import { commandPaletteScreen } from "../screens/command-palette.ts";
import { costsScreen } from "../screens/costs.ts";
import { mapScreen } from "../screens/map.ts";
import { notificationsScreen } from "../screens/notifications.ts";
import { integrationsScreen } from "../screens/integrations.ts";
import { securityCentreScreen } from "../screens/security-centre.ts";
import { credentialsScreen } from "../screens/credentials.ts";
import { reportsScreen } from "../screens/reports.ts";
import { configChangesScreen } from "../screens/config-changes.ts";
import { configHistoryScreen } from "../screens/config-history.ts";
import { ownerActionsScreen } from "../screens/owner-actions.ts";
import { canaryScreen } from "../screens/canary.ts";
import { COMMANDS } from "../shell/registry.ts";
import { allScreenActions, routesOf, type Screen } from "../screens/common.ts";

// The self-owned screen descriptors. The router wiring registers
// each screen's route(s) FROM this one list via screenRoutes(), and the command palette
// reads their actions via allScreenActions(), so a screen is the single owner of the
// routes it serves and the actions it contributes. These are the elevated area
// modules: sources-downpipes (screen 2), restore-flow (screens 3+4 restore family),
// access-security (the unified Access/Roles/Audit/Fallback governance area, screens
// 6+7), onboarding-ceremony (the first-run wizard + key ceremony, screen 10), and the
// command palette's own deep-linkable landing. They supersede the earlier placeholders
// (downpipes/restore/access/roles/audit/onboarding) at the same routes; runs, keys,
// settings and licence keep their descriptors. Overview is handled separately in app.ts
// because its "/" route carries the first-run onboarding redirect; the rest bind
// straight from their descriptors. The router resolves the FIRST matching pattern, so
// the order here matters only between overlapping patterns; the IA route table has no
// such overlap (each pattern is owned by exactly one screen).
export const SCREENS: Screen[] = [
  destinationsScreen, sourcesScreen, sourcesDownpipesScreen, addSourceScreen, runsScreen, restoreFlowScreen, keysScreen,
  accessSecurityScreen, idpConnectionsScreen, rolesBuilderScreen, settingsScreen, licenceScreen, onboardingCeremonyScreen,
  signedOutScreen, passkeyScreen, commandPaletteScreen, mapScreen, costsScreen,
  // Enterprise feature-layer screens: notifications (channels /
  // rules / history / test-send), the security centre (posture score + severity-ranked
  // checks + Owner-only risk-accept), credentials (the expiry tracker: list + add/edit/
  // delete), and reports (the four signed reports: view JSON, download PDF, signature
  // state). Each owns its route(s) via its descriptor; the router binds them through
  // screenRoutes() and the palette reads the actions they declare (credentials and reports
  // each declare a capability-gated / read action here; the go-to navigations live in
  // shell/registry.ts + shell/nav.ts).
  notificationsScreen, integrationsScreen, securityCentreScreen, credentialsScreen, reportsScreen,
  // Config change-control: the change-requests inbox (the pending config mutations the opt-in four-eyes /
  // dual-control gate is holding for a second approver). It owns /config/changes via its descriptor; the
  // router binds it through screenRoutes() and the palette reads its "review pending config approvals"
  // action. The Owner toggle that turns the gate on/off lives in the Security Centre.
  configChangesScreen,
  // Config version history: a READ-ONLY, git-style timeline of the account's governance configuration
  // (the engine versions its own config as hash-chained, signed snapshots). It owns /config/history via
  // its descriptor; the router binds it through screenRoutes() and the palette reads its "view config
  // version history" action. Read-only: history + chain verify + manual snapshot; no rollback.
  configHistoryScreen,
  // Owner-action dual control: the owner-approval inbox (the pending HIGH-BLAST-RADIUS owner operations the
  // opt-in dual-control gate is holding for a SECOND OWNER, a destination repoint/remove, an identity-provider
  // connection change, the account-browsing token set, ...). It owns /security/owner-actions via its
  // descriptor; the router binds it through screenRoutes() and the palette reads its "review pending owner
  // approvals" action. The same Owner toggle in the Security Centre arms both this and the config-change gate.
  ownerActionsScreen,
  // Canary backup: the on-by-default known-answer integrity flight (the animated bird in its cage).
  // It owns /canary via its descriptor; the router binds it through screenRoutes() and the palette
  // reads its go-to action. The nav rail item lives under Govern in shell/nav.ts.
  canaryScreen,
];

// asCommands adapts the screens' ScreenAction descriptors to the registry Command shape
// (structurally the same minus the `when` ctx typing, which is contravariantly compatible).
// One adapter so the palette is fed by the self-owned screens, not a parallel hand-kept
// list. exactOptionalPropertyTypes: only set `shortcut` / `when` when present.
function asCommands(actions: ReturnType<typeof allScreenActions>): typeof COMMANDS {
  return actions.map((a) => ({
    id: a.id,
    title: a.title,
    group: a.group,
    kind: a.kind,
    keywords: a.keywords,
    target: a.target,
    ...(a.shortcut !== undefined ? { shortcut: a.shortcut } : {}),
    ...(a.when !== undefined ? { when: a.when } : {}),
  }));
}

// reconcileRegistry concatenates the command lists and removes a later command that
// duplicates an earlier one by id, by go-to shortcut, or by NAVIGATION-group target. The
// static COMMANDS are passed first, so they own the canonical Navigation chords and a
// screen's redundant "Go to X" / chord is the one dropped, while every distinct command
// survives: the screens' unique actions (approvals inbox, import-a-list, fleet drill,
// roles, re-run setup, open palette, keyboard help) and any non-Navigation command that
// merely lands on a shared screen. The Navigation-group scope on the target rule is what
// keeps "Import a list of downpipes" (group Downpipes, lands on /downpipes) and "Restore
// from a run" (group Actions, lands on /restore) while still dropping a second go-to.
// Pure-text dedup, no DOM, trivially correct.
function reconcileRegistry(...lists: (typeof COMMANDS)[]): typeof COMMANDS {
  const ids = new Set<string>();
  const navTargets = new Set<string>();
  const shortcuts = new Set<string>();
  const out: typeof COMMANDS = [];
  for (const list of lists) {
    for (const cmd of list) {
      const isGoTo = cmd.kind === "navigate" && cmd.group === "Navigation";
      if (ids.has(cmd.id)) continue;
      if (isGoTo && navTargets.has(cmd.target)) continue;
      // A REPEATED CHORD IS A DUPLICATE CHORD, NOT A DUPLICATE COMMAND, and this used to drop the whole
      // command. Driven against the assembled REGISTRY: "Restore from a run" (restore-flow.ts, group
      // Actions, keywords recover / roll back / dry-run, its own `when` guard) declared shortcut "g s",
      // which the static go-restore row already owned, so it was dropped outright and a customer
      // searching the palette for "recover", "roll back" or "dry-run" found NOTHING. The block above
      // this function asserts in as many words that this exact command survives; it did not, because
      // the chord rule is not Navigation-scoped the way the target rule is and fires first. The chord
      // is dropped and the command kept, which is what the paragraph above always claimed happened.
      // Chord DISPATCH is unaffected either way: keyboard.ts reads goToShortcuts(), which is built from
      // the static COMMANDS, never from this reconciled list.
      const dupShortcut = cmd.shortcut !== undefined && shortcuts.has(cmd.shortcut);
      ids.add(cmd.id);
      if (isGoTo) navTargets.add(cmd.target);
      if (cmd.shortcut !== undefined && !dupShortcut) shortcuts.add(cmd.shortcut);
      if (dupShortcut) {
        const { shortcut: _dropped, ...withoutChord } = cmd;
        out.push(withoutChord);
        continue;
      }
      out.push(cmd);
    }
  }
  return out;
}

// The one assembled command registry the palette, the go-to chords and the cheat-sheet
// all read. It folds the self-owned screens' ScreenAction lists into
// the static day-one COMMANDS and reconciles them into ONE consistent set:
//   - COMMANDS come FIRST so the Navigation group's go-to chords (g o/d/r/s/k/a/l, plus
//     Settings and Licence) stay the canonical chord map the IA names (IA 2.2); a screen
//     that also contributes a pure go-to to the same destination is dropped as a duplicate
//     so the rail, the chords and the palette never show two "Go to X" rows.
//   - overviewScreen is action-collected here even though it is route-bound separately
//     in app.ts (its "/" carries the first-run redirect), so its fleet drill / refresh
//     commands are not lost from the palette.
//   - dedup drops a later command that repeats an earlier id, an earlier go-to shortcut,
//     or an earlier NAVIGATION-group go-to target, so the set is conflict-free; a distinct
//     non-Navigation command that merely routes to the same screen (e.g. "Import a list of
//     downpipes" landing on /downpipes, or "Restore from a run" on /restore) is kept,
//     while a redundant second "Go to X" is dropped. Each command keeps its own `when`, so
//     an action the role cannot run is still never offered.
export const REGISTRY: typeof COMMANDS = reconcileRegistry(
  COMMANDS,
  asCommands(allScreenActions([overviewScreen, ...SCREENS])),
);

// ROUTES is the FULL list of bound route patterns: every pattern screenRoutes() below binds from
// SCREENS, plus the one special case (overview owns "/", bound directly in app.ts rather than through
// screenRoutes() because that route carries the first-run redirect). It is derived FROM the screens'
// own `route` fields, never typed out by hand, so it cannot fall behind them the way the old router.ts
// "ROUTES" map did (that map stopped at 29 hand-copied entries while the screens had grown to 47; the
// router never bound from it, so nothing noticed). Nothing here should ever need to add a route by
// literal: add it to the OWNING screen's descriptor and it appears here automatically.
// scripts/route-table-gate.mjs independently re-derives this list by statically parsing every
// src/screens/**/*.ts file's `route:` field off disk and asserts the two agree, so a screen wired into
// SCREENS with a route this list somehow missed (or vice versa) fails a gate rather than shipping quiet.
/**
 * The bound route set, derived from the screen descriptors.
 *
 * This export carries no suppression tag: knip does not currently report ROUTES as unused, and naming
 * the tag's literal here would itself re-trigger the same class of lint the tag was for.
 * hint it explains. The warning below stands whatever knip currently thinks.
 *
 * Its only consumer imports it DYNAMICALLY and knip cannot follow that. The gate resolves this
 * module at run time (`await import(pathToFileURL(resolve(CONSOLE_ROOT, "src/lib/app-registry.ts")))`,
 * scripts/route-table-gate.mjs:381) precisely so it can be pointed at a DIFFERENT console checkout than the
 * one it lives in, which a static import cannot do. A static-analysis tool reporting this export as unused
 * would be right about what it can see and wrong about the world. Do not delete the export to satisfy it:
 * that removes the very thing the gate compares against, and the gate would then fail on a missing symbol
 * rather than on a real route drift.
 */
export const ROUTES: readonly string[] = Object.freeze([
  ...routesOf(overviewScreen),
  ...SCREENS.flatMap(routesOf),
]);

// The routes that run full-bleed without the shell chrome (IA 2: the one exception). The passkey
// sign-in is full-bleed too: it is a pre-auth landing with no role and no chrome, exactly like the
// signed-out screen. /register is the passkey screen's invite-acceptance route (same pre-auth, no-chrome
// landing): an invite link lands an unenrolled teammate on /register?invite=<token> to set up their passkey.
export const FULL_BLEED = new Set<string>(["/onboarding/:step", "/signed-out", "/passkey", "/register"]);

// The route patterns that hold in-memory key ceremony material. Departing from any
// of these routes must clear that material so it does not linger in memory after the
// operator leaves the ceremony context (no-custody hygiene, finding C6-3).
// clearSensitiveState() is a no-op when state.ceremony is null, so calling it on
// every departure from these routes (including intermediate onboarding steps) is safe.
//
// ALL FOUR keys routes are here, not just /keys. The Keys screen's four sections are routes now
// (keys/shared.ts), so moving from Posture to Custody is a navigation; if only /keys were listed, that
// move would read as a departure from the ceremony context and clear the in-memory material the Custody
// section exists to split. Listing every keys route makes moving BETWEEN sections not a departure, which
// is the same rule that already keeps step-to-step movement inside /onboarding/:step from clearing it,
// while leaving the departure clear intact for any route outside the set.
export const CEREMONY_PATTERNS = new Set<string>([
  "/onboarding/:step",
  "/keys",
  "/keys/rotate",
  "/keys/custody",
  "/keys/recovery",
]);
