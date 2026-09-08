// Small generic leaf builders for the Licence screen family: a label/value detail row (plain string or an
// arbitrary node), an honest "field not reported" placeholder, and the Enterprise renewal sentence. Split out
// of shared.ts verbatim (size only, finding the 0.1.5 update-UX work tipped shared.ts over the max-lines
// guardrail; these four are the least update-specific of that file's contents, so they are the cleanest cut).
// Pure DOM leaf builders, no state, no engine calls. House rules: Australian English, no em dashes, precise
// claims.

import { h } from "../../lib/dom.ts";
import { dateOnly } from "../../lib/format.ts";
import type { RenewalNotice } from "../../lib/billing.ts";

// detailRowNode is like detailRow but accepts an arbitrary node as the value,
// used when the value is a compound element (a placeholder, a link, etc.).
export function detailRowNode(label: string, valueNode: HTMLElement): HTMLElement {
  return h("div", { class: "kv-row" }, h("span", { class: "kv-row__label field__hint" }, label), valueNode);
}

export function detailRow(label: string, value: string): HTMLElement {
  return h("div", { class: "kv-row" }, h("span", { class: "kv-row__label field__hint" }, label), h("span", { class: "kv-row__value" }, value));
}

// provenancePlaceholder builds an inline hint-styled placeholder for a field the
// engine does not yet report. Labelled honestly so the card never claims unknown facts.
export function provenancePlaceholder(reason: string): HTMLElement {
  return h("span", { class: "field__hint", style: "font-style:italic" }, `(${reason})`);
}

// renewalSentence renders the plain-words validity line for an Enterprise licence. It
// states the valid-until date and, when the renewal is near or past, the day count in the
// same sentence, so the operator reads the posture without decoding a badge. Fail-open is
// implied by the surrounding card copy; this line is about the subscription, not the data.
//
// THE RENEWS-SOON LINE USED TO PROMISE A GRACE WINDOW, and there is no such thing. It read
// "the grace window covers a short lag, so nothing is interrupted", which named a mechanism
// this product does not have: engine admin/licence.ts checkExpiry is `expiry <= Date.now()`,
// so a licence lapses on the instant its validity date passes, with no buffer of any length.
// What actually protects a customer whose renewal is late is FAIL-OPEN, which is a different
// and far stronger guarantee, and the reassurance is now attributed to it. The claim is also
// narrowed to what fail-open really covers: backups and restores continue, while the paid
// services and assurance do lapse, so "nothing is interrupted" was an overclaim on top of an
// invented mechanism. This is the sentence a customer reads in the thirty days BEFORE they
// lapse, so it is the one that decides whether a late renewal frightens them.
export function renewalSentence(r: RenewalNotice): HTMLElement {
  const when = dateOnly(r.notAfter) || r.notAfter;
  let copy: string;
  if (r.expired) {
    const days = Math.abs(r.daysUntil);
    copy = `Your Enterprise subscription token shows a validity date of ${when} (${days} ${days === 1 ? "day" : "days"} ago).`;
  } else if (r.renewsSoon) {
    // The renews-soon line carries the renewal instruction itself; no separate banner. The renewed
    // token is pasted in Activate licence below (the portal path), not set as a Worker secret.
    copy = `Your Enterprise subscription is valid until ${when} (${r.daysUntil} ${r.daysUntil === 1 ? "day" : "days"} from now). It renews with a new licence token: when it arrives, paste the renewed licence token under Activate licence below. A late renewal does not interrupt backups or restores.`;
  } else {
    copy = `Your Enterprise subscription is valid until ${when}.`;
  }
  return h("p", { style: "color:var(--text);margin-top:var(--space-3)" }, copy);
}

// expiredSentence renders the validity line for a licence the ENGINE has resolved as expired, which is a
// different case from renewalSentence's expired branch above and needs its own words.
//
// The difference is what the console knows. renewalSentence runs on a licence the engine reports as
// enterprise and VALID, so it can name the tier. On the expiry path the engine has already failed open: it
// reports tier "community", drops features[] and returns before the account claim is compared, so the tier
// the customer used to hold is not on the wire at all. This sentence therefore says "licence token" and
// nothing about which one, because the alternative is a guess printed as a fact.
export function expiredSentence(r: RenewalNotice): HTMLElement {
  const when = dateOnly(r.notAfter) || r.notAfter;
  const days = Math.abs(r.daysUntil);
  return h(
    "p",
    { style: "color:var(--text);margin-top:var(--space-3)" },
    `Your licence token shows a validity date of ${when}, which passed ${days} ${days === 1 ? "day" : "days"} ago.`,
  );
}
