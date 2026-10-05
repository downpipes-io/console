// Shared assertion helpers for the node-driven validate-*.ts suites. Each suite calls makeChecks()
// to get its own isolated counter plus the ok/eq/has/lacks reporters, so the previously copy-pasted
// helper bodies live in one place and a change to the output format updates every suite at once.

export interface Checks {
  /** Assert a boolean condition. */
  ok(label: string, cond: boolean): void;
  /** Assert strict equality, printing got/want on failure. */
  eq<T>(label: string, got: T, want: T): void;
  /** Assert that haystack contains needle. */
  has(label: string, haystack: string, needle: string): void;
  /** Assert that haystack does NOT contain needle. */
  lacks(label: string, haystack: string, needle: string): void;
  /** Number of failed assertions so far. */
  readonly failures: number;
}

export function makeChecks(): Checks {
  let failures = 0;
  return {
    ok(label: string, cond: boolean): void {
      console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
      if (!cond) failures++;
    },
    eq<T>(label: string, got: T, want: T): void {
      const cond = got === want;
      console.log(
        cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
      );
      if (!cond) failures++;
    },
    has(label: string, haystack: string, needle: string): void {
      const cond = haystack.includes(needle);
      console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  "${needle}" not in: ${haystack}`);
      if (!cond) failures++;
    },
    lacks(label: string, haystack: string, needle: string): void {
      const cond = !haystack.includes(needle);
      console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  unexpected "${needle}" in: ${haystack}`);
      if (!cond) failures++;
    },
    get failures(): number {
      return failures;
    },
  };
}
