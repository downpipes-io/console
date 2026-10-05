// The one doc link. Every console surface that sends a reader to the documentation renders the same
// anchor: the field__doc class, an external-link icon, and target/rel set together.
//
// WHY THIS EXISTS AS A FUNCTION. The markup was hand-copied at 60 call sites before this file. All
// 60 were measured and none had drifted: 51 carried all three attributes identically and no anchor
// anywhere in the console had target="_blank" without rel="noreferrer noopener", so this is not a
// repair. It is a fence built before the horse leaves, because the copy programme is about to add
// roughly 226 more links and 286 hand-copies of a security-relevant attribute pair is how a
// tabnabbing hole gets introduced by a rewriter who is thinking about wording.
//
// The docs rewrite measured the same shape on prose: five SIEM pages carried one byte-identical
// paragraph, five rewriters shortened it five different ways, and no per-page reviewer could see it
// because each read one page. Shared strings diverge when they are copies. This makes them one.
import { h, svgIcon } from "../lib/dom.ts";
import { ICON_EXTERNAL } from "../lib/icons.ts";

export type DocRef = { href: string; anchor?: string; label?: string };

/** The canonical URL for a doc reference: href, plus #anchor when the reference deep-links. */
export function docHref(doc: DocRef): string {
  return doc.anchor ? `${doc.href}#${doc.anchor}` : doc.href;
}

/**
 * A "Learn more" link to the documentation.
 *
 * `label` should say what the reader will find, not that a link exists: the console already uses
 * "How your key is handled" and "What each source type captures" where the destination is specific.
 * It falls back to "Learn more" only when nothing better is true.
 */
export function docLink(doc: DocRef): HTMLAnchorElement {
  return h(
    "a",
    { class: "field__doc linklike", href: docHref(doc), target: "_blank", rel: "noreferrer noopener" },
    doc.label ?? "Learn more",
    svgIcon(ICON_EXTERNAL, { size: 13 }),
  ) as HTMLAnchorElement;
}
