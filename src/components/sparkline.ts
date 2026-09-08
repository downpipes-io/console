// Sparklines and mini-bars. Small INLINE SVG only, no chart
// library (supply chain + the brief): a sparkline for a downpipe's record/byte trend
// on its card or a stat tile, and a compact bars series for run history. Drawn with
// currentColor and semantic tokens so the chart themes for free in both Obsidian and
// the light companion, and so no fill ever depends on hue alone.
//
// The hard accessibility rule the design system makes non-negotiable: a chart is
// NEVER the only representation of a number that matters. Every chart here carries a
// text alternative conveying the same information (the latest value and the trend
// direction in words), exposed to assistive tech via role="img" + aria-label, and a
// visually-hidden caption is also emitted so the figure is available as real text
// next to the graphic, not locked inside an image. Reduced motion is respected by
// drawing static geometry (there is no animation to gate; the line/bars just render).

import { h } from "../lib/dom.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// A small horizontal inset so a line, its end dot and the fallback baselines are never
// clipped at the SVG edges. Shared by the trend path and the single-point/empty fallbacks.
const SPARK_PAD_X = 1.5;
// The bar count above which the inter-bar gap narrows from 2px to 1px so a dense series
// does not overflow at the default 120px width.
const DENSE_BARS_THRESHOLD = 40;

// The semantic tone a chart can carry. "accent" is the neutral default (the indigo
// action accent); the status tones colour a chart that is itself a health read (a
// freshness or reliability trend). Colour is never the only signal here: the text
// alternative carries the meaning, so the tone is a reinforcement, not the message.
export type ChartTone = "accent" | "ok" | "warn" | "danger" | "info" | "trust" | "muted";

function toneColor(tone: ChartTone): string {
  switch (tone) {
    case "ok": return "var(--ok)";
    case "warn": return "var(--warn)";
    case "danger": return "var(--danger)";
    case "info": return "var(--info)";
    case "trust": return "var(--trust)";
    case "muted": return "var(--text-muted)";
    case "accent": return "var(--accent)";
  }
}

export interface SparklineOptions {
  // The series, oldest-first. Non-finite entries are treated as gaps (skipped in the
  // path), so a missing run does not distort the trend.
  values: number[];
  // The width and height of the drawing box in CSS px. Defaults suit a stat-tile or
  // a table cell.
  width?: number;
  height?: number;
  tone?: ChartTone; // default "accent"
  // Render an area fill under the line (a soft, low-opacity wash). Off by default for
  // the most restrained read; on for a hero tile.
  area?: boolean;
  // Mark the latest point with a small dot (orients the eye to "now"). Default true.
  markLast?: boolean;
  // The accessible name and the visible caption. Pass a phrase that states the latest
  // value AND the direction in words, e.g. "Records per run: 12,304, up over the last
  // 14 runs." If omitted, a direction-only phrase is derived from the series.
  label?: string;
  // A short unit/label used only when deriving the fallback phrase (e.g. "records").
  unitLabel?: string;
  // When true (the default) a visually-hidden caption is emitted alongside the SVG so
  // the figure is real text in the DOM, not only the SVG's aria-label. A caller that
  // already renders the value as visible text next to the chart can pass false.
  withCaption?: boolean;
}

// buildTrendPath draws the 2+-point trend: the optional area wash, the line, and the latest
// dot, appended in order to `svg`. The x-scale spans the FULL series length (n) so a skipped
// gap reads as a gap, not a compression.
function buildTrendPath(svg: SVGElement, points: Array<{ v: number; i: number }>, n: number, width: number, height: number, area: boolean, markLast: boolean): void {
  const max = Math.max(...points.map((p) => p.v));
  const min = Math.min(...points.map((p) => p.v));
  const span = max - min || 1;
  const padX = SPARK_PAD_X;
  const padY = 3;
  const x = (i: number) => padX + (n <= 1 ? 0 : (i / (n - 1)) * (width - padX * 2));
  const y = (v: number) => height - padY - ((v - min) / span) * (height - padY * 2);

  const coords = points.map((p) => ({ cx: x(p.i), cy: y(p.v) }));
  const linePath = coords.map((c, idx) => `${idx === 0 ? "M" : "L"}${round(c.cx)} ${round(c.cy)}`).join(" ");

  if (area) {
    const first = coords[0]!;
    const last = coords[coords.length - 1]!;
    const areaPath = `${linePath} L${round(last.cx)} ${round(height - padY)} L${round(first.cx)} ${round(height - padY)} Z`;
    const areaEl = document.createElementNS(SVG_NS, "path");
    areaEl.setAttribute("d", areaPath);
    areaEl.setAttribute("fill", "currentColor");
    areaEl.setAttribute("opacity", "0.12");
    areaEl.setAttribute("stroke", "none");
    svg.appendChild(areaEl);
  }

  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("d", linePath);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  if (markLast) {
    const last = coords[coords.length - 1]!;
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", round(last.cx));
    dot.setAttribute("cy", round(last.cy));
    dot.setAttribute("r", "2");
    dot.setAttribute("fill", "currentColor");
    svg.appendChild(dot);
  }
}

// buildSinglePointFallback draws a flat midline + a dot, so a one-run downpipe still reads as
// a chart rather than an empty box.
function buildSinglePointFallback(svg: SVGElement, width: number, height: number): void {
  const cy = round(height / 2);
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("d", `M${SPARK_PAD_X} ${cy} L${round(width - SPARK_PAD_X)} ${cy}`);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("opacity", "0.5");
  svg.appendChild(line);
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", round(width - SPARK_PAD_X));
  dot.setAttribute("cy", cy);
  dot.setAttribute("r", "2");
  dot.setAttribute("fill", "currentColor");
  svg.appendChild(dot);
}

// buildEmptyFallback draws a dashed baseline so the slot is honestly empty, not a broken graphic.
function buildEmptyFallback(svg: SVGElement, width: number, height: number): void {
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("d", `M${SPARK_PAD_X} ${round(height / 2)} L${round(width - SPARK_PAD_X)} ${round(height / 2)}`);
  line.setAttribute("stroke", "var(--border-strong)");
  line.setAttribute("stroke-width", "1");
  line.setAttribute("stroke-dasharray", "3 3");
  svg.appendChild(line);
}

// sparkline renders a single-series trend line. The return is a small wrapper holding
// the SVG (role="img" with the text alternative) and, by default, a visually-hidden
// caption carrying the same phrase as real text.
export function sparkline(opts: SparklineOptions): HTMLElement {
  const width = opts.width ?? 120;
  const height = opts.height ?? 34;
  const tone = opts.tone ?? "accent";
  const markLast = opts.markLast !== false;
  const color = toneColor(tone);

  // Keep only finite points, with their original index, so gaps are skipped but the
  // x-scale still spans the full series (a gap reads as a gap, not a compression).
  const points = opts.values
    .map((v, i) => ({ v, i }))
    .filter((p) => Number.isFinite(p.v));

  const phrase = opts.label ?? derivePhrase(opts.values, opts.unitLabel);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `spark spark--${tone}`);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", phrase);
  svg.style.color = color;

  if (points.length >= 2) buildTrendPath(svg, points, opts.values.length, width, height, opts.area === true, markLast);
  else if (points.length === 1) buildSinglePointFallback(svg, width, height);
  else buildEmptyFallback(svg, width, height);

  const wrap = h("span", { class: "spark-wrap" }, svg);
  if (opts.withCaption !== false) {
    wrap.appendChild(h("span", { class: "visually-hidden" }, phrase));
  }
  return wrap;
}

export interface MiniBarsOptions {
  // The series, oldest-first; non-finite entries render as empty (gap) bars.
  values: number[];
  width?: number;
  height?: number;
  tone?: ChartTone; // default "accent"
  // A per-bar tone override (e.g. colour a failed run's bar danger). Index-aligned to
  // values; entries left undefined fall back to the base tone. Colour is paired with
  // the text alternative, never the sole signal.
  toneAt?: (index: number, value: number) => ChartTone | undefined;
  label?: string;
  unitLabel?: string;
  withCaption?: boolean;
}

// miniBars renders a compact bar series (run history magnitudes). Each bar is a rect
// scaled to the series max; a per-bar tone lets a failed run read danger while the
// rest read accent. The text alternative carries the latest value + direction.
export function miniBars(opts: MiniBarsOptions): HTMLElement {
  const width = opts.width ?? 120;
  const height = opts.height ?? 34;
  const baseTone = opts.tone ?? "accent";
  const n = opts.values.length;
  const phrase = opts.label ?? derivePhrase(opts.values, opts.unitLabel);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `spark spark--bars spark--${baseTone}`);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", phrase);

  const finite = opts.values.filter((v) => Number.isFinite(v));
  const max = finite.length ? Math.max(...finite) : 1;
  if (n > 0) {
    const gap = n > DENSE_BARS_THRESHOLD ? 1 : 2;
    const barW = Math.max(1, (width - gap * (n - 1)) / n);
    const padY = 2;
    opts.values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const ratio = max > 0 ? Math.max(0, v) / max : 0;
      const barH = Math.max(1.5, ratio * (height - padY * 2));
      const x = i * (barW + gap);
      const y = height - padY - barH;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", round(x));
      rect.setAttribute("y", round(y));
      rect.setAttribute("width", round(barW));
      rect.setAttribute("height", round(barH));
      rect.setAttribute("rx", barW > 3 ? "1" : "0");
      const t = opts.toneAt?.(i, v) ?? baseTone;
      rect.setAttribute("fill", toneColor(t));
      svg.appendChild(rect);
    });
  }

  const wrap = h("span", { class: "spark-wrap" }, svg);
  if (opts.withCaption !== false) {
    wrap.appendChild(h("span", { class: "visually-hidden" }, phrase));
  }
  return wrap;
}

// derivePhrase builds a fallback text alternative from a series: the latest finite
// value plus the trend direction over the series (up / down / steady / no data). The
// phrase is plain Australian English, no em dashes; a caller with a richer phrase
// (with a formatted value + unit) should pass `label` instead.
function derivePhrase(values: number[], unitLabel?: string): string {
  const finite = values.filter((v) => Number.isFinite(v));
  const unit = unitLabel ? `${unitLabel}: ` : "";
  if (finite.length === 0) return `${unitLabel ? `${unitLabel}, ` : ""}no data yet`;
  const last = finite[finite.length - 1]!;
  if (finite.length === 1) return `${unit}${groupInt(last)} (one data point)`;
  const first = finite[0]!;
  const dir = last > first ? "up" : last < first ? "down" : "steady";
  const overN = finite.length;
  return `${unit}${groupInt(last)}, ${dir} over the last ${overN} points`;
}

// groupInt is a tiny, dependency-free thousands grouping for the derived phrase only
// (presentation; never fed back to the engine). A caller that needs richer formatting
// passes a pre-built `label`.
function groupInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// round trims SVG coordinates to two decimals so the emitted path is compact and the
// markup stays small (the bundle and the DOM both stay lean).
function round(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

// Test-seam export: the phrase-derivation logic is pure and independently assertable.
export { derivePhrase as _testDerivePhrase };
