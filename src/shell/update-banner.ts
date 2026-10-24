// The update strip: one full-width line under the context bar on every screen while the "Update available"
// chip has a verdict. It names the release and links to the Updates section of Licence and updates. It
// reuses the chip's verdict (updateChipView in lib/app-refresh.ts) and the engine's support status for the
// running version, the same data the end-of-support notice reads (screens/licence/support-notice.ts). A
// second line asks for an alert destination when the engine has none, with or without an update.
//
// The decision is pure (updateBannerModel, visibleBanner) so a validator pins every state. The DOM half
// only turns the decision into the strip. The strip is hidden until a verdict lands, so it never flickers in.
// A dismissal lasts for the browser session and is keyed on the recommended version and the tone, so a new
// release, or a worse support status, shows the line again. Every storage read and write is guarded: when storage throws, the line still shows.

import { h, svgIcon } from "../lib/dom.ts";
import { ICON_CLOSE } from "../lib/icons.ts";
import { loadDraft, saveDraft } from "../lib/draft.ts";
import { longDateUtc } from "../lib/format.ts";
import { onSessionCleared } from "../lib/store.ts";
import { supportNotice } from "../screens/licence/support-notice.ts";
import type { UpdateStatus } from "../api.ts";
import type { UpdateChipView } from "./chrome.ts";

export type UpdateBannerTone = "neutral" | "warn" | "danger";

// SinkState is what the notify channel list says: "none" = no channel at all, "disabled" = channels exist and
// every one is switched off, "ok" = at least one is enabled. null = not known (the read failed or has not
// landed), which never shows a prompt.
export type SinkState = "none" | "disabled" | "ok";

// UpdateBannerModel is the strip's update line before any dismissal: the tone, the sentence and the
// dismissal key (the recommended version of each component with an update, and the tone).
export interface UpdateBannerModel {
  tone: UpdateBannerTone;
  message: string;
  key: string;
}

// UpdateBannerState is what the shell holds: the update line (null = no verdict) and the alert destination
// state.
export interface UpdateBannerState {
  update: UpdateBannerModel | null;
  sink: SinkState | null;
}

// formatSupportDate writes the end-of-support date in the ending line, the same way the support notice in
// Licence and updates does: the day number, the full month name and the year.
export const formatSupportDate: (iso: string) => string = longDateUtc;

export const SINK_PROMPT = "No alert destination is set, so alerts reach nobody. Set one in Notifications.";
export const SINK_DISABLED_PROMPT = "No alert destination is enabled, so alerts reach nobody. Turn one on in Notifications.";
export const SINK_PROMPT_ROUTE = "/notifications" as const;
const UPDATE_DRAFT_ID = "update-banner-dismissed";
const SINK_DRAFT_ID = "update-banner-sink-dismissed";

// releaseLabel names what is available, the way the chip's aria-label names the component: "engine 0.3.9",
// "console 0.3.8", "engine 0.3.9 and console 0.3.8". A component without a version is named alone.
function releaseLabel(upd: UpdateStatus, components: string[]): { text: string; key: string } {
  const parts: Array<{ name: string; version: string | undefined }> = components.map((c) => ({
    name: c,
    version: c === "engine" ? (upd.components?.engine?.recommendedVersion ?? upd.recommendedVersion) : upd.components?.[c]?.recommendedVersion,
  }));
  const text = parts.map((p) => (p.version ? `${p.name} ${p.version}` : p.name)).join(" and ");
  const key = parts.map((p) => `${p.name}@${p.version ?? ""}`).join("|");
  return { text, key };
}

// updateBannerModel is the update line for a chip verdict, or null when the chip is hidden. The tone comes
// from the support notice's own rule for the RUNNING engine version (supportNotice): "end-of-life" is
// danger, "ending" is warning, anything else is neutral. Support status describes the engine, so a
// console-only update stays neutral. The dismissal key carries the tone, so a dismissed warning comes back
// when the status becomes end-of-life.
export function updateBannerModel(chip: UpdateChipView | null, upd: UpdateStatus, now: number = Date.now()): UpdateBannerModel | null {
  if (chip === null) return null;
  const { text, key } = releaseLabel(upd, chip.components);
  const engineUpdate = chip.components.includes("engine");
  const notice = engineUpdate ? supportNotice(upd, now) : null;
  const recommended = upd.components?.engine?.recommendedVersion ?? upd.recommendedVersion;
  if (notice !== null && recommended) {
    if (notice.past) {
      return { tone: "danger", key: `${key}#danger`, message: `Engine ${upd.currentVersion} is past its end of support. Update to ${recommended} in Licence and updates.` };
    }
    return { tone: "warn", key: `${key}#warn`, message: `Support for engine ${upd.currentVersion} ends on ${formatSupportDate(notice.supportedUntil)}. Update to ${recommended} before then in Licence and updates.` };
  }
  return { tone: "neutral", key: `${key}#neutral`, message: `A new release is available: ${text}. Review and apply it in Licence and updates.` };
}

// sinkStateFrom reads the notify channels. A channel counts only while it is enabled: a disabled channel
// delivers nothing. A failed read is unknown (null), never "none".
export function sinkStateFrom(channels: ReadonlyArray<{ enabled?: boolean }> | null): SinkState | null {
  if (channels === null) return null;
  if (channels.length === 0) return "none";
  return channels.some((c) => c.enabled !== false) ? "ok" : "disabled";
}

export interface BannerDismissals {
  update: string | null;
  sink: string | null;
}

// readDismissals reads the session dismissals. A throwing store reads as "not dismissed".
export function readDismissals(): BannerDismissals {
  let update: string | null = null;
  let sink: string | null = null;
  try {
    const u = loadDraft<string>(UPDATE_DRAFT_ID);
    update = typeof u === "string" ? u : null;
    const k = loadDraft<string>(SINK_DRAFT_ID);
    sink = typeof k === "string" ? k : null;
  } catch {
    // Storage refused: the line still shows.
  }
  return { update, sink };
}

export function writeUpdateDismissal(key: string): void {
  try {
    saveDraft(UPDATE_DRAFT_ID, key);
  } catch {
    // Storage refused: the dismissal lasts until the page reloads only.
  }
}

export function writeSinkDismissal(key: string): void {
  try {
    saveDraft(SINK_DRAFT_ID, key);
  } catch {
    // Storage refused: the dismissal lasts until the page reloads only.
  }
}

export interface VisibleBanner {
  update: UpdateBannerModel | null;
  sink: { key: string; message: string } | null;
}

// visibleBanner applies the dismissals. An update line dismissed for THIS key (versions and tone) stays
// hidden; a new key shows it again. The destination line stands alone: it shows whenever no
// destination is set, with or without an update line. It is never shown in the tour (the sample engine has no channels, and the visitor has no real destination to set), and is
// dismissed per state ("none" or "disabled").
export function visibleBanner(state: UpdateBannerState, dismissed: BannerDismissals, tour: boolean = false): VisibleBanner | null {
  const update = state.update !== null && dismissed.update !== state.update.key ? state.update : null;
  let sink: VisibleBanner["sink"] = null;
  if (!tour && (state.sink === "none" || state.sink === "disabled") && dismissed.sink !== state.sink) {
    sink = { key: state.sink, message: state.sink === "none" ? SINK_PROMPT : SINK_DISABLED_PROMPT };
  }
  if (update === null && sink === null) return null;
  return { update, sink };
}

// ---- DOM ------------------------------------------------------------------------------------------

export interface UpdateStrip {
  el: HTMLElement;
  apply(state: UpdateBannerState): void;
}

interface Line {
  el: HTMLElement;
  text: HTMLElement;
  dismiss: HTMLButtonElement;
}

// updateLine and sinkLine build the two lines once. Each button carries its own literal data-dp hook so the
// hook census can read it. The lines carry their own class names, so a query for the setup strip's classes
// never reaches them.
function updateLine(go: () => void, dismiss: () => void): Line {
  const text = h("span", { class: "update-strip__text" });
  const btn = h("button", { "data-dp": "shell-update-banner.button.dismiss#1", class: "update-strip__dismiss", type: "button", "aria-label": "Dismiss the update notice", on: { click: dismiss } }, svgIcon(ICON_CLOSE, { size: 14 }));
  const el = h(
    "div",
    { class: "update-strip__line", dataset: { updateStrip: "update" } },
    text,
    h("button", { "data-dp": "shell-update-banner.button.go#1", class: "linklike update-strip__go", type: "button", on: { click: go } }, "Open Licence and updates"),
    btn,
  );
  el.hidden = true;
  return { el, text, dismiss: btn };
}

function sinkLine(go: () => void, dismiss: () => void): Line {
  const text = h("span", { class: "update-strip__text" });
  const btn = h("button", { "data-dp": "shell-update-banner.button.dismiss#2", class: "update-strip__dismiss", type: "button", "aria-label": "Dismiss the alert destination notice", on: { click: dismiss } }, svgIcon(ICON_CLOSE, { size: 14 }));
  const el = h(
    "div",
    { class: "update-strip__line", dataset: { updateStrip: "sink" } },
    text,
    h("button", { "data-dp": "shell-update-banner.button.go#2", class: "linklike update-strip__go", type: "button", on: { click: go } }, "Open Notifications"),
    btn,
  );
  el.hidden = true;
  return { el, text, dismiss: btn };
}

// buildUpdateStrip builds the strip, hidden until apply is given a verdict. The container is a polite live
// region, so a line that appears is announced once. The two lines are built once and updated in place, so a
// refresh never replaces a focused control. After a dismiss, focus moves to the other line's dismiss button,
// or to the main content when no line is left.
export function buildUpdateStrip(opts: { navigate: (route: string) => void; updateRoute: string; tour: () => boolean; focusMain: () => void }): UpdateStrip {
  const el = h("div", { class: "update-strip", role: "status", "aria-label": "Update notice" });
  el.hidden = true;
  let last: UpdateBannerState = { update: null, sink: null };
  // The in-memory copy of this page's dismissals, always the newest. When the session store refuses a write,
  // the dismissal still holds until the page reloads.
  const held: BannerDismissals = { update: null, sink: null };
  let current: VisibleBanner | null = null;

  const onDismissUpdate = (): void => {
    if (current?.update) {
      held.update = current.update.key;
      writeUpdateDismissal(current.update.key);
    }
    render();
    if (current?.sink) sink.dismiss.focus();
    else opts.focusMain();
  };
  const onDismissSink = (): void => {
    if (current?.sink) {
      held.sink = current.sink.key;
      writeSinkDismissal(current.sink.key);
    }
    render();
    if (current?.update) upd.dismiss.focus();
    else opts.focusMain();
  };
  const upd = updateLine(() => opts.navigate(opts.updateRoute), onDismissUpdate);
  const sink = sinkLine(() => opts.navigate(SINK_PROMPT_ROUTE), onDismissSink);
  el.append(upd.el, sink.el);
  // A sign-out drops the in-memory dismissals too (the session store is cleared by the sign-out itself), so a
  // different sign-in in the same page starts with the strip as the engine reports it.
  onSessionCleared(() => {
    held.update = null;
    held.sink = null;
    last = { update: null, sink: null };
    render();
  });

  const render = (): void => {
    const stored = readDismissals();
    const vis = visibleBanner(last, { update: held.update ?? stored.update, sink: held.sink ?? stored.sink }, opts.tour());
    current = vis;
    el.classList.remove("update-strip--warn", "update-strip--danger");
    if (vis === null) {
      el.hidden = true;
      upd.el.hidden = true;
      sink.el.hidden = true;
      return;
    }
    el.hidden = false;
    upd.el.hidden = vis.update === null;
    sink.el.hidden = vis.sink === null;
    if (vis.update !== null) {
      if (upd.text.textContent !== vis.update.message) upd.text.textContent = vis.update.message;
      if (vis.update.tone === "warn") el.classList.add("update-strip--warn");
      if (vis.update.tone === "danger") el.classList.add("update-strip--danger");
    }
    if (vis.sink !== null && sink.text.textContent !== vis.sink.message) sink.text.textContent = vis.sink.message;
  };
  return {
    el,
    apply(state) {
      last = state;
      render();
    },
  };
}
