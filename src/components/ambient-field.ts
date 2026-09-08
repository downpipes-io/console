// The ambient field (Wave 1, a light "rain", adapted from the website's hero downpour
// in website/src/components/HeroFlow.astro, stripped to just the falling streaks). It is
// a fixed canvas mounted as the first layer of the shell (like the Aurora wash): z-index
// -1, transparent, pointer-events none, aria-hidden; the page background shows through
// and content sits above.
//
// Intensity is an operator choice (lib/rain-pref.ts), surfaced in Settings:
//   - off, no rain (the canvas stays empty)
//   - medium, a steady rain (the default; the former "light" drizzle was removed as
//               too faint to see, so medium is now the gentlest tier)
//   - storm, heavy, wind-slanted rain with occasional lightning
//
// This is the ONE sanctioned piece of infinite ambient motion in the console, an
// explicit owner decision, mirroring the opt-in Aurora precedent, so it is gated HARD
// on motionOK(): under OS prefers-reduced-motion OR the in-app "reduced" setting it does
// not run at all, it pauses while the tab is hidden, and it re-evaluates live on a
// preference change. The lightning is infrequent and a single moderate flash (no rapid
// strobe), well under the WCAG 2.3.1 three-flashes-per-second threshold. Canvas2d + rAF
// only; no dependency.

import { motionOK, onA11yChange } from "../lib/a11y-prefs.ts";
import { getRainPref, onRainChange, type RainPref } from "../lib/rain-pref.ts";

interface Drop {
  x: number;
  y: number;
  vy: number; // px/sec, downward
  len: number; // streak length, px
  alpha: number;
  teal: boolean;
}

interface Preset {
  density: number; // count = (w*h)/density, capped
  cap: number;
  vyMin: number;
  vyMax: number;
  lenMin: number;
  lenMax: number;
  alphaMin: number;
  alphaMax: number;
  wind: number; // px/sec horizontal (slant)
  lineWidth: number;
  lightning: boolean;
}

const PRESETS: Record<Exclude<RainPref, "off">, Preset> = {
  medium: { density: 30000, cap: 44, vyMin: 120, vyMax: 240, lenMin: 8, lenMax: 16, alphaMin: 0.05, alphaMax: 0.16, wind: 10, lineWidth: 1, lightning: false },
  storm: { density: 12000, cap: 120, vyMin: 360, vyMax: 680, lenMin: 12, lenMax: 26, alphaMin: 0.08, alphaMax: 0.24, wind: 75, lineWidth: 1.4, lightning: true },
};

export function ambientField(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "ambient-field";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const c2d = ctx;

  let preset: Preset | null = null; // null = off
  let drops: Drop[] = [];
  let raf = 0;
  let last = 0;
  let running = false;
  let w = 1;
  let h = 1;
  let indigo = "#84a4ff";
  let teal = "#4fd0bf";

  // Lightning state (storm only).
  let strikeIn = 0;
  let flash = 0;
  let bolt: number[] | null = null;
  let boltLife = 0;

  const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

  const readColours = (): void => {
    const cs = getComputedStyle(document.documentElement);
    const a = cs.getPropertyValue("--accent").trim();
    const t = cs.getPropertyValue("--trust").trim();
    if (a) indigo = a;
    if (t) teal = t;
  };

  const makeDrop = (y: number): Drop => {
    const p = preset!;
    return {
      x: Math.random() * w,
      y,
      vy: rnd(p.vyMin, p.vyMax),
      len: rnd(p.lenMin, p.lenMax),
      alpha: rnd(p.alphaMin, p.alphaMax),
      teal: Math.random() < 0.14,
    };
  };

  const resize = (): void => {
    w = Math.max(1, window.innerWidth);
    h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const build = (): void => {
    if (!preset) {
      drops = [];
      return;
    }
    const count = Math.round(Math.min(preset.cap, Math.max(8, (w * h) / preset.density)));
    drops = [];
    for (let i = 0; i < count; i++) drops.push(makeDrop(Math.random() * h));
  };

  const makeBolt = (): number[] => {
    const pts: number[] = [];
    let x = rnd(w * 0.12, w * 0.88);
    let y = 0;
    pts.push(x, y);
    const segs = 5 + Math.floor(Math.random() * 4);
    const endY = h * rnd(0.45, 0.72);
    for (let i = 0; i < segs; i++) {
      y += endY / segs;
      x += rnd(-w * 0.05, w * 0.05);
      pts.push(x, y);
    }
    return pts;
  };

  const frame = (now: number): void => {
    if (!running || !preset) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    const p = preset;
    c2d.clearRect(0, 0, w, h);

    // Rain streaks, drawn along the velocity vector (so wind slants them).
    const vx = p.wind;
    c2d.lineWidth = p.lineWidth;
    c2d.lineCap = "round";
    for (const d of drops) {
      d.y += d.vy * dt;
      d.x += vx * dt;
      if (d.y - d.len > h || d.x < -60 || d.x > w + 60) {
        const nd = makeDrop(-rnd(0, h * 0.25));
        d.x = nd.x;
        d.y = nd.y;
        d.vy = nd.vy;
        d.len = nd.len;
        d.alpha = nd.alpha;
        d.teal = nd.teal;
      }
      const speed = Math.hypot(vx, d.vy) || 1;
      const tailX = d.x - (vx / speed) * d.len;
      const tailY = d.y - (d.vy / speed) * d.len;
      c2d.globalAlpha = d.alpha;
      c2d.strokeStyle = d.teal ? teal : indigo;
      c2d.beginPath();
      c2d.moveTo(tailX, tailY);
      c2d.lineTo(d.x, d.y);
      c2d.stroke();
    }
    c2d.globalAlpha = 1;

    // Lightning (storm only): a single moderate sky-flash + a thin bolt, infrequent.
    if (p.lightning) {
      strikeIn -= dt;
      if (strikeIn <= 0) {
        strikeIn = rnd(4.5, 11);
        flash = 1;
        bolt = makeBolt();
        boltLife = 0.22;
      }
      if (flash > 0) {
        const g = c2d.createLinearGradient(0, 0, 0, h * 0.7);
        g.addColorStop(0, "rgba(206, 226, 255, 1)");
        g.addColorStop(1, "rgba(206, 226, 255, 0)");
        c2d.globalAlpha = flash * 0.32; // moderate peak; no full-screen white strobe
        c2d.fillStyle = g;
        c2d.fillRect(0, 0, w, h);
        c2d.globalAlpha = 1;
        flash = Math.max(0, flash - dt * 3); // ~0.33s decay, single ramp (no rapid flicker)
      }
      if (bolt && boltLife > 0) {
        boltLife -= dt;
        c2d.globalAlpha = Math.max(0, boltLife / 0.22) * 0.7;
        c2d.strokeStyle = "rgba(234, 242, 255, 1)";
        c2d.lineWidth = 2;
        c2d.beginPath();
        c2d.moveTo(bolt[0]!, bolt[1]!);
        for (let i = 2; i < bolt.length; i += 2) c2d.lineTo(bolt[i]!, bolt[i + 1]!);
        c2d.stroke();
        c2d.globalAlpha = 1;
        if (boltLife <= 0) bolt = null;
      }
    }

    raf = window.requestAnimationFrame(frame);
  };

  const start = (): void => {
    if (running || !preset) return;
    if (!motionOK()) return; // hard gate: no ambient motion under reduced-motion
    if (typeof document !== "undefined" && document.hidden) return;
    running = true;
    last = 0;
    raf = window.requestAnimationFrame(frame);
  };

  const stop = (): void => {
    running = false;
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    c2d.clearRect(0, 0, w, h);
  };

  // configure applies a preference: off stops + clears; otherwise (re)build and start.
  const configure = (pref: RainPref): void => {
    stop();
    preset = pref === "off" ? null : PRESETS[pref];
    strikeIn = rnd(3, 8);
    flash = 0;
    bolt = null;
    build();
    start();
  };

  readColours();
  resize();
  configure(getRainPref());

  window.addEventListener("resize", () => { resize(); build(); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else start(); });
  onRainChange((pref) => { readColours(); configure(pref); });
  // Re-evaluate on a motion-preference change: the gate may have flipped.
  onA11yChange(() => { readColours(); if (motionOK()) start(); else stop(); });

  return canvas;
}
