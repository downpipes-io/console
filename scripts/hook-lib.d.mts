// Types for hook-lib.mjs, which is plain JavaScript.
//
// Written from the two `targets.push({...})` literals and the return statement in that file rather than
// from what any one caller happens to read, so this describes the module rather than one use of it. The
// two pushes do not carry identical keys: the second omits `hookValueStart`/`hookValueEnd`, and both omit
// `hasStableId` on some paths, so the fields that are not always present are declared optional. Anything
// stated here as required is present on every row.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

/** One call site that is, or could be, a data-dp anchor. */
export interface HookTarget {
  /**
   * The expected data-dp value: `${screen}.${role}.${purpose}`, suffixed `#1`, `#2` and so on when
   * several call sites share one base. Assigned near the end of the census, after the rows are grouped
   * and sorted, and the `_base` it is derived from is deleted from every row on the way out, so a
   * returned row carries this and never that.
   */
  key: string;
  /** Repo-relative path, forward slashes on every platform. */
  file: string;
  line: number;
  /** The enclosing function's name, for reading the census by hand. */
  fn: string;
  /** Emitted inside a loop, so one source line stands for many rendered controls. */
  loopGenerated: boolean;
  canAutoStamp: boolean;
  insertAt: number;
  absFile: string;
  /** Absent on the paths that do not resolve one. */
  mechanism?: string;
  role?: string;
  /** The control already carries a stable id, so the harness can reach it without a hook. */
  hasStableId?: boolean;
  /** The data-dp value already stamped on this call site, when there is one. */
  hookValue?: string;
  hookValueStart?: number;
  hookValueEnd?: number;
}

export interface HookCensus {
  /** Every call site found. */
  targets: HookTarget[];
  /** Needs a hook and has none: the population the harness cannot otherwise reach. */
  missing: HookTarget[];
  /** Carries a hook value. */
  hooked: HookTarget[];
  /** Carries a hook AND a stable id, so the hook buys nothing. */
  redundant: HookTarget[];
  /**
   * Groups of two or more targets sharing one hook value. Typed as a non-empty tuple because the census
   * builds it by filtering for length > 1, so `duplicates[n][0]` always exists. Saying that here means a
   * reader does not have to assert it at each use, and the guarantee is stated where it is enforced.
   */
  duplicates: Array<[HookTarget, ...HookTarget[]]>;
  /** True when the target cannot be reached without a hook. */
  needsHook: (t: HookTarget) => boolean;
}

export function computeHookCensus(srcDir: string): HookCensus;
