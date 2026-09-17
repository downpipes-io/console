// Types for workspace-root.mjs, which is plain JavaScript. Same arrangement as hook-lib.d.mts beside it.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

/** True when any segment of this path is literally ".worktrees". */
export function underWorktrees(p: string): boolean;

/** Candidate workspace roots for a checkout at startDir, best first, before any marker or refusal test. */
export function workspaceCandidates(startDir: string): string[];

/** The workspace root carrying markerRelPath, or null when no candidate does. */
export function findWorkspaceDir(startDir: string, markerRelPath: string): string | null;
