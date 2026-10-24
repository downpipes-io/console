// The end-of-support notice in the Updates section. A release is supported until 90 days after its
// successor ships. The engine works that date out from the signed update channel and reports it for its own
// running version as `supportedUntil`, with `supportStatus` ("supported", "ending" or "end-of-life"; engine
// src/admin/update-support.ts). The console never works out a support date of its own. This module decides
// whether the engine's answer needs a notice, and builds it. The decision is pure and takes `now`, so a
// validator can pin the clock; the DOM half only turns the decision into a banner.
//
// Three states, and silence otherwise:
//   - end-of-life: the date is past. The running engine gets no more fixes. A danger banner.
//   - ending: the date is SUPPORT_NOTICE_DAYS days away or nearer. A warning banner.
//   - supported, or neither field: no notice. The latest release has no date, and an older engine or a
//     channel without release dates sends neither field; that is not a fault to report.
// The engine's `supportStatus` decides. When it is absent, the same 30-day rule runs on `supportedUntil`.

import { h } from "../../lib/dom.ts";
import { banner } from "../../components/feedback.ts";
import { longDateUtc } from "../../lib/format.ts";
import type { UpdateStatus } from "../../api.ts";

// SUPPORT_NOTICE_DAYS is how far ahead of supportedUntil the notice starts.
export const SUPPORT_NOTICE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// SupportNotice is the pure decision. daysLeft is whole days until the date, rounded up, and zero or
// negative once the date has passed.
export interface SupportNotice {
  supportedUntil: string;
  daysLeft: number;
  past: boolean;
}

// supportNotice returns the notice to show, or null when there is none. Only a verified status counts:
// an unverified channel carries no date the console may trust. A notice needs a date to name.
export function supportNotice(updates: Pick<UpdateStatus, "verified" | "supportedUntil" | "supportStatus">, now: number = Date.now()): SupportNotice | null {
  if (updates.verified !== true || typeof updates.supportedUntil !== "string") return null;
  const at = Date.parse(updates.supportedUntil);
  if (!Number.isFinite(at)) return null;
  const delta = at - now;
  const s = updates.supportStatus;
  const known = s === "supported" || s === "ending" || s === "end-of-life";
  const past = known ? s === "end-of-life" : delta < 0;
  const ending = known ? s === "ending" : delta <= SUPPORT_NOTICE_DAYS * MS_PER_DAY;
  if (!past && !ending) return null;
  const daysLeft = delta < 0 ? Math.floor(delta / MS_PER_DAY) : Math.ceil(delta / MS_PER_DAY);
  return { supportedUntil: updates.supportedUntil, daysLeft, past };
}

// supportNoticeLine is the banner copy for a notice and the running engine version.
export function supportNoticeLine(n: SupportNotice, version: string): string {
  const when = longDateUtc(n.supportedUntil);
  if (n.past) {
    return `Engine ${version} reached its end of support on ${when}. It gets no more fixes, including security fixes. Backups and restores keep running. Update to the latest release.`;
  }
  const left = Math.max(1, n.daysLeft);
  const days = left === 1 ? "1 day" : `${left} days`;
  return `Engine ${version} reaches its end of support on ${when}, in ${days}. After that date it gets no more fixes, including security fixes. Update to the latest release before then.`;
}

// supportNoticeBanner is the rendered notice, or null when there is none.
export function supportNoticeBanner(updates: UpdateStatus, now: number = Date.now()): HTMLElement | null {
  const n = supportNotice(updates, now);
  if (n === null) return null;
  return h("div", { style: "margin:var(--space-3) 0" }, banner({ tone: n.past ? "danger" : "warn", message: supportNoticeLine(n, updates.currentVersion) }));
}
