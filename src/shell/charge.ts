// The "downpipe charge" (the product signature): a finite blue fill drawn down the rail
// mark's downspout (the BRAND_MARK "M352 84V400" subpath) on a real navigation, as if the
// new screen rained down the pipe. Factored out of the shell entry (app-shell.ts) so the
// entry stays the assembler; mountShell still gates it on motionOK() before calling.
//
// Single in-flight (a rapid nav restarts it cleanly) and self-removing on finish. Driven by
// the Web Animations API so motionOK() (checked by the caller) is the SOLE gate: the
// imperative path is not subject to the CSS reduced-motion media query, which is exactly what
// lets an operator who chose "full" still see it, while reduced-motion callers never inject
// the node at all.

// Animation tuning for the charge. Grouped here so a regression or a brand-colour update
// edits a named constant rather than a raw number buried in the keyframe arrays.
const CHARGE_DURATION_MS = 720; // total length of both the mark pulse and the fill sweep
const CHARGE_PEAK_SCALE = 1.35; // the mark briefly grows so the small (22px) rail glyph reads
const CHARGE_PEAK_OFFSET = 0.42; // keyframe offset of the scale/glow peak
const CHARGE_GLOW_RADIUS_PX = 10; // drop-shadow blur at the peak
const CHARGE_GLOW_PEAK_OPACITY = 0.9; // drop-shadow alpha at the peak
const CHARGE_ACCENT_RGB = "59, 102, 240"; // brand blue for the glow halo
const CHARGE_FILL_IN_OFFSET = 0.18; // the downspout fill has faded fully in by here
const CHARGE_FILL_FULL_OFFSET = 0.72; // the fill reaches the bottom of the pipe by here

export function chargeRailMark(): void {
  const body = document.querySelector(".rail__brand .dp-mark-body");
  if (!body) return;
  body.querySelector(".dp-mark-charge")?.remove();
  const charge = document.createElementNS("http://www.w3.org/2000/svg", "path");
  charge.setAttribute("class", "dp-mark-charge");
  charge.setAttribute("d", "M352 84V400");
  charge.setAttribute("pathLength", "100");
  body.appendChild(charge);
  // A pronounced, slow scale-pulse + blue glow on the whole mark so the charge is
  // clearly visible at the rail's small (22px) size, a subtle pulse there is easy
  // to miss. transform-origin centred so the glyph pulses in place; the glow halo
  // extends past the glyph so the effect reads larger than the mark itself.
  const svg = body.closest("svg");
  if (svg instanceof SVGElement) {
    svg.style.transformOrigin = "center";
    svg.animate(
      [
        { transform: "scale(1)", filter: `drop-shadow(0 0 0 rgba(${CHARGE_ACCENT_RGB}, 0))` },
        { transform: `scale(${CHARGE_PEAK_SCALE})`, filter: `drop-shadow(0 0 ${CHARGE_GLOW_RADIUS_PX}px rgba(${CHARGE_ACCENT_RGB}, ${CHARGE_GLOW_PEAK_OPACITY}))`, offset: CHARGE_PEAK_OFFSET },
        { transform: "scale(1)", filter: `drop-shadow(0 0 0 rgba(${CHARGE_ACCENT_RGB}, 0))` },
      ],
      { duration: CHARGE_DURATION_MS, easing: "ease-out" },
    );
  }
  const anim = charge.animate(
    [
      { strokeDashoffset: 100, opacity: 0 },
      { opacity: 1, offset: CHARGE_FILL_IN_OFFSET },
      { strokeDashoffset: 0, opacity: 1, offset: CHARGE_FILL_FULL_OFFSET },
      { strokeDashoffset: 0, opacity: 0 },
    ],
    { duration: CHARGE_DURATION_MS, easing: "ease-out", fill: "forwards" },
  );
  // Remove the charge element once the animation settles. The rejection case (the animation was
  // cancelled, for example the element left the DOM mid-run) is handled identically to completion:
  // either way the node should go. remove() on an already-detached node is a safe no-op.
  const cleanup = (): void => {
    try { charge.remove(); } catch { /* already removed */ }
  };
  anim.finished.then(cleanup, cleanup);
}
