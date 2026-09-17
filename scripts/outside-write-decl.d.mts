// Types for outside-write-decl.mjs, which is plain JavaScript. Same arrangement as workspace-root.d.mts
// beside it.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

/** What one file says, and does, about writing outside this checkout. */
export interface WritePosture {
  /** It calls a filesystem write entry point, judged with comments blanked. */
  writes: boolean;
  /** It carries a FS-WRITES line of either kind. */
  hasDecl: boolean;
  /** That line is the "none outside this repo" posture. */
  none: boolean;
  /** Out-of-repo paths it declares, <workspace>-relative. */
  declared: string[];
  /** Paths declared for the caller but deliberately not driven by the deep half. */
  alsoDeclared: string[];
  /** The arguments a run needs to reach the declared paths, empty when a bare run reaches them. */
  runArgs: string;
}

/** The write posture of one source file, derived from its text alone. Pure. */
export function readDeclaration(source: string): WritePosture;

/** The posture line a file uses when nothing it writes leaves this checkout. */
export const NONE_POSTURE: string;
