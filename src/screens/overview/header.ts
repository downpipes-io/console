// Overview header builders: the page-header action slot (freshness stamp, auto-refresh
// pause, manual Refresh) and the trust telemetry row (the no-custody constant). Moved
// verbatim out of view.ts for size; behaviour unchanged.
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { autoRefreshToggle } from "../../lib/refresh-pref.ts";
import { noCustodyChip, NO_CUSTODY_SCOPE } from "../../components/trust-chips.ts";
import { infoTip } from "../../components/info-tip.ts";
import { ICON_REFRESH } from "../../lib/icons.ts";

// headerActions builds the page-header action slot: the "Updated …" freshness stamp,
// the auto-refresh pause and a manual Refresh (always available, read-only). The fleet
// drill lives in the Recovery posture card (it is Operator+ and belongs with the
// recovery surface), not in the page header.
export function headerActions(onRefresh: () => void, updatedStamp: HTMLElement): HTMLElement {
  const refresh = h(
    "button",
    { "data-dp": "overview.button.refresh#2", class: "btn btn--secondary btn--sm", type: "button", on: { click: onRefresh } },
    svgIcon(ICON_REFRESH, { size: 14 }),
    "Refresh",
  );
  // The auto-refresh pause (WCAG 2.2.2): the cadence is the auto-updating content;
  // the operator can stop it. Manual Refresh stays available either way.
  return h("div", { class: "page-header__actions" }, updatedStamp, autoRefreshToggle(), refresh);
}

export function trustRow(): HTMLElement {
  const row = h("div", { class: "trust-row", role: "region", "aria-label": "Trust posture" });
  // The no-custody chip is a true constant the product earns by construction (keygen.ts;
  // no upload path anywhere). The Access verdict chip's ONE home is the shell account
  // area (app-shell renderAccount, its design home); repeating
  // it here put the same verdict on screen twice inches apart on every visit.
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (it explains the
  // no-custody guarantee). It is set on the CHIP itself, not the row, so the "?" sits on the component it
  // explains rather than the wide row. No behaviour, no effect on the genuine console.
  const chip = noCustodyChip();
  chip.dataset.tourId = "overview-no-custody";
  row.appendChild(chip);
  // The chip's label is the CLAIM; NO_CUSTODY_SCOPE is the qualification that makes it true, and
  // until now the only carrier of that qualification was the chip's title attribute. A title is a
  // hover-only affordance: the chip is a plain span, so no keystroke reaches it, a touch device has
  // no hover at all, and a generic span's title is not announced as a description. Every reader who
  // does not use a mouse was therefore left with the unqualified label, a stronger claim than the
  // product makes. The console's own accessibility rule already forbids this ("triggered on focus as well as hover
  // (never hover-only) ... never the only place essential information lives"); the Access verdict
  // chip complies because components/verdict.ts repeats its explanations as visible prose on the
  // same screens, and this chip had no such panel.
  //
  // The info-tip is the console's existing progressive-disclosure primitive:
  // a real focusable button with role="tooltip" and aria-describedby, opened by focus, click or tap.
  // It carries the SAME STRING, verbatim, so not a word of the existing copy changes; it only
  // becomes reachable. Density cost is one 1.15rem glyph on a row that holds a single chip.
  row.appendChild(infoTip(NO_CUSTODY_SCOPE, { label: "About the no-custody claim" }));
  return row;
}
