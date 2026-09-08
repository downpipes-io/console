// The single ACTION REGISTRY.
// One source of truth shared by the command palette, the go-to shortcuts, the "?"
// cheat-sheet and any row overflow menus, so RBAC and discoverability never drift.
// Each command's `when` gates by the caller's role and by engine state; a command
// the role cannot run is never shown, so there is no palette entry that 403s.
//
// This module defines the registry SHAPE and the go-to + action set. It is the one
// source the command palette UI (screens/command-palette/), the go-to shortcuts, the
// cheat-sheet and any overflow menus all read. Dangerous commands carry kind:"flow" so
// the consumer opens the safe review-then-confirm flow rather than executing directly.

import type { Caller } from "../api.ts";
import type { Capability } from "../lib/identity.ts";
import { callerCan } from "../lib/identity-custom-roles.ts";
import { noteGateComputedBlind } from "../lib/client-diag/identity-gate.ts";

// The engine-state facts a command's `when` may gate on (kept minimal; screens
// pass the live values). All optional so a partial/unknown state never throws.
export interface EngineState {
  ready?: boolean;            // GET /admin/status.ready
  downpipeCount?: number;     // GET /admin/status.downpipeCount
  updateAvailable?: boolean;  // GET /admin/updates.updateAvailable
  connected?: boolean;        // an engine client is set
}

export interface CommandContext {
  caller: Caller | null;
  engine: EngineState;
}

export type CommandKind =
  | "navigate"  // go to a route (benign)
  | "action"    // run a benign action inline (toggle theme, copy URL, export)
  | "flow";     // open a safe review-then-confirm flow (restore, delete, rotate)

export interface Command {
  id: string;
  title: string;
  group: "Navigation" | "Downpipes" | "Runs" | "Actions";
  kind: CommandKind;
  keywords: string[];
  // The route to navigate to (for kind "navigate"), or the action id the consumer
  // dispatches (for "action"/"flow"). The consumer owns dispatch; the registry
  // stays free of DOM/IO so it is trivially testable and shared.
  target: string;
  // A go-to shortcut chord (e.g. "g o"), shown in the cheat-sheet and palette.
  shortcut?: string;
  // when gates visibility by role + engine state; absent means always available.
  when?: (ctx: CommandContext) => boolean;
}

// requireCap builds a `when` that gates a command by a CAPABILITY (the capability model), so a command the caller's role cannot exercise is never
// listed in the palette (the mirror of the engine's per-route capability gate; the engine
// is the enforcement point). New affordances gate with can(role, capability) rather than
// the legacy cumulative ladder, so the two narrow roles (restore-operator, access-admin)
// are gated by their real capabilities. A null caller (whoami pending) fails closed, and WITNESSES.
//
// The witness is the third leg of this residue fix, alongside canDo and canCap in screens/common.ts.
// identity-gate.ts's own comment already named the command palette as a witness site and it was not one, so
// a palette opened before whoami returned hid every capability-gated command, restore included, and left no
// row saying the gate had been decided without an identity to decide it from.
function requireCap(capability: Capability): (ctx: CommandContext) => boolean {
  // Gate on the caller's EFFECTIVE capability set via callerCan, so a NAMED custom role (role pinned to
  // the engine's "viewer" floor, real authority in its capability set) can reach a palette command its
  // custom role genuinely grants. For the six built-in roles customRole is absent and
  // callerCan(role, cap, null) === can(role, cap), so this is a no-op for them.
  return (ctx) => {
    if (ctx.caller === null) {
      noteGateComputedBlind();
      return false;
    }
    return callerCan(ctx.caller.role, capability, ctx.caller.customRole ?? null);
  };
}

// hasDownpipes gates commands that only make sense once a downpipe exists.
function hasDownpipes(ctx: CommandContext): boolean {
  return (ctx.engine.downpipeCount ?? 0) > 0;
}

// The day-one command set (information-architecture.md 2.4). Navigation is
// readable by every role; mutating commands carry a role `when`; dangerous ones
// are kind:"flow" so the consumer opens the safe flow.
export const COMMANDS: Command[] = [
  // ---- Navigation (go-to; every role) ----
  { id: "go-overview", title: "Go to Overview", group: "Navigation", kind: "navigate", target: "/", keywords: ["overview", "dashboard", "home"], shortcut: "g o" },
  { id: "go-downpipes", title: "Go to Downpipes", group: "Navigation", kind: "navigate", target: "/downpipes", keywords: ["downpipes", "sources", "backup routes"], shortcut: "g d" },
  { id: "go-runs", title: "Go to Runs", group: "Navigation", kind: "navigate", target: "/runs", keywords: ["runs", "history", "activity"], shortcut: "g r" },
  { id: "go-restore", title: "Go to Restore", group: "Navigation", kind: "navigate", target: "/restore", keywords: ["restore", "recovery", "drill"], shortcut: "g s" },
  { id: "go-keys", title: "Go to Keys", group: "Navigation", kind: "navigate", target: "/keys", keywords: ["keys", "break-glass", "ceremony", "recovery sheet"], shortcut: "g k" },
  { id: "go-access", title: "Go to Access", group: "Navigation", kind: "navigate", target: "/access", keywords: ["access", "zero trust", "security"], shortcut: "g a" },
  { id: "go-audit", title: "Go to Audit log", group: "Navigation", kind: "navigate", target: "/access/audit", keywords: ["audit", "log", "tamper-evident"], shortcut: "g l" },
  { id: "go-settings", title: "Go to Settings", group: "Navigation", kind: "navigate", target: "/settings", keywords: ["settings", "connection", "residency"] },
  { id: "go-licence", title: "Go to Licence and updates", group: "Navigation", kind: "navigate", target: "/licence", keywords: ["licence", "license", "updates", "provenance"] },
  { id: "go-map", title: "Go to Topology map", group: "Navigation", kind: "navigate", target: "/map", keywords: ["map", "topology", "sources", "destinations", "flows", "diagram"], shortcut: "g m" },
  { id: "go-costs", title: "Go to Cost calculator", group: "Navigation", kind: "navigate", target: "/costs", keywords: ["cost", "calculator", "estimate", "price", "pricing", "storage", "projection"], shortcut: "g c" },
  // Notifications + Security centre (section 9). Both screens are READ-visible
  // to every authenticated role (a Viewer reads alerting config and posture), so the go-to
  // navigations carry no role gate, exactly like the rail. The write surfaces are gated
  // inside the screens with can(role, capability); the capability-gated deep-links below
  // surface the configure/accept destinations only to roles that can act there.
  { id: "go-notifications", title: "Go to Notifications", group: "Navigation", kind: "navigate", target: "/notifications", keywords: ["notifications", "alerts", "channels", "rules", "webhook", "slack", "pagerduty", "teams", "email", "history"], shortcut: "g n" },
  { id: "go-security", title: "Go to Security centre", group: "Navigation", kind: "navigate", target: "/security", keywords: ["security", "posture", "score", "checks", "controls", "cis", "essential eight", "nist", "iso", "risk", "remediation"], shortcut: "g e" },
  // Credentials (the expiry tracker) and Reports (the signed reports) are READ-visible to
  // every authenticated role (a Viewer reads tracked expiries and downloads a report), so
  // the go-to navigations carry no role gate, exactly like the rail. The write surfaces
  // (add/edit/delete on credentials) are gated inside the screen with can(role, capability);
  // the capability-gated deep-link below surfaces the add destination only to roles that can act.
  { id: "go-credentials", title: "Go to Credentials and expiry", group: "Navigation", kind: "navigate", target: "/credentials", keywords: ["credentials", "expiry", "expire", "keys", "licence", "certificate", "rotation", "renew", "secrets", "tracker"], shortcut: "g v" },
  { id: "go-reports", title: "Go to Reports", group: "Navigation", kind: "navigate", target: "/reports", keywords: ["reports", "report", "audit", "evidence", "sla", "immutability", "posture", "restore tests", "pdf", "signed", "tamper-evident"], shortcut: "g p" },

  // ---- Downpipes ----
  { id: "create-downpipe", title: "Create downpipe", group: "Downpipes", kind: "navigate", target: "/downpipes/new", keywords: ["new", "add", "create", "downpipe", "source"], when: requireCap("downpipe.write") },

  // ---- Runs / restore (dangerous -> flow) ----
  // Split by capability, matching the engine's per-route gate: REQUEST a restore hits restore.request
  // (POST /admin/restore/request, held by Operator, Restore operator, Approver and Owner); APPLY one hits
  // restore.apply (POST /admin/restore with confirm, held by Restore operator, Approver and Owner). Gating
  // by capability, not the cumulative role rank, is the fix: a restore-operator holds both yet sits
  // off the rank ladder, so the old requireRole gates hid the restore commands from the recovery-only role
  // the engine accepts. Two entries keep palette claims honest; the engine remains the enforcement point.
  { id: "request-restore", title: "Request a restore", group: "Runs", kind: "flow", target: "restore.request", keywords: ["restore", "recover", "request"], when: (ctx) => requireCap("restore.request")(ctx) && hasDownpipes(ctx) },
  { id: "apply-restore", title: "Apply a restore", group: "Runs", kind: "flow", target: "restore.start", keywords: ["restore", "recover", "apply", "approve"], when: (ctx) => requireCap("restore.apply")(ctx) && hasDownpipes(ctx) },

  // ---- Actions (benign inline) ----
  { id: "open-recovery-sheet", title: "Open recovery sheet", group: "Actions", kind: "action", target: "keys.recovery-sheet", keywords: ["recovery", "sheet", "print", "fingerprints"] },
  { id: "verify-access", title: "Verify Access enforcement", group: "Actions", kind: "action", target: "access.verify", keywords: ["access", "verify", "enforcement", "zero trust"] },
  // Honest navigation, not an "action": opening Licence and updates IS the check
  // (every visit refetches the licence + update channel); there is no separate
  // probe to run, so an action kind would promise more than happens. This baseline
  // entry owns the id, so the licence screen's matching navigation declaration
  // dedups against it cleanly (sweep: licence-palette-actions-navigate).
  { id: "check-updates", title: "Open Licence and updates", group: "Navigation", kind: "navigate", target: "/licence", keywords: ["updates", "version", "provenance", "licence", "check"] },
  { id: "export-audit", title: "Export audit log", group: "Actions", kind: "action", target: "audit.export", keywords: ["audit", "export", "siem", "download"] },
  // Configure notification rules: a write-class destination, gated by the notify.config
  // capability so it is offered only to roles that can configure alerting (Operator,
  // Approver, Owner). It navigates to the rules sub-view where the add/edit forms live;
  // the engine re-enforces the capability server-side.
  { id: "configure-notify-rules", title: "Configure notification rules", group: "Actions", kind: "navigate", target: "/notifications/rules", keywords: ["notifications", "rules", "configure", "alert", "routing", "channel"], when: requireCap("notify.config") },
  // Review the security posture: a read available to every authenticated role (posture.read),
  // surfaced as an action so it is discoverable by verb ("review", "posture") as well as by
  // the go-to navigation above.
  { id: "review-posture", title: "Review security posture", group: "Actions", kind: "navigate", target: "/security", keywords: ["posture", "security", "review", "score", "checks", "remediation"], when: requireCap("posture.read") },
  { id: "toggle-theme", title: "Toggle theme", group: "Actions", kind: "action", target: "theme.toggle", keywords: ["theme", "dark", "light", "appearance"] },
  // Switch the console framing (executive plain-English answers <-> the technical
  // console). The chrome toggle is shown only to callers whose default is the executive
  // skin or who hold a stored override (app-shell), so this command is how everyone
  // else reaches the flip. Presentation only, no authority; handled by defaultDispatch.
  { id: "toggle-view-mode", title: "Switch console view (executive or technical)", group: "Actions", kind: "action", target: "view.toggle", keywords: ["view", "mode", "executive", "technical", "console", "switch", "plain", "answers"] },
  { id: "sign-out", title: "Sign out", group: "Actions", kind: "action", target: "auth.sign-out", keywords: ["sign out", "log out", "clear"] },
];

// visibleCommands filters the registry by the current context (role + engine
// state). The palette, the cheat-sheet and the go-to layer all call this so they
// stay consistent. Exercised directly by validate-registry.ts (the RBAC-filtering
// proof), so it is a referenced export.
export function visibleCommands(ctx: CommandContext): Command[] {
  return COMMANDS.filter((c) => (c.when ? c.when(ctx) : true));
}

// goToShortcuts maps the "g <letter>" chords to their routes, for the keyboard
// layer in the shell. Derived from the registry so it never drifts.
export function goToShortcuts(): Array<{ chord: string; route: string; title: string }> {
  return COMMANDS.filter((c) => c.kind === "navigate" && c.shortcut).map((c) => ({
    chord: c.shortcut!,
    route: c.target,
    title: c.title,
  }));
}
