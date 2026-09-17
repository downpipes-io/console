// Types for source-text.mjs, which is plain JavaScript. Same arrangement as outside-write-decl.d.mts and
// workspace-root.d.mts beside it.
//
// It exists because test/validate-sealed-export-unseal.ts imports blankComments, and tsconfig.test.json
// type-checks test/ under the same strictness src gets, so an untyped .mjs import is an error there rather
// than an implicit any.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

/**
 * Every comment byte replaced by a space, newlines and offsets preserved, so a line number or an offset
 * taken from the result still points at the same place in the original. Quote and template aware: a `//`
 * inside a string and a `/*` inside a regex literal are not comments. String literals are left intact by
 * design, because several gates read things that legitimately live inside them. Pure.
 */
export function blankComments(src: string): string;

/** Runs the blanker against fixtures whose answer is known. Exits non-zero on a disagreement. */
export function selfTest(): void;
