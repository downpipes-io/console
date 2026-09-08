// THE READING PACE of the guided tour's autoplay, and the one control that changes it.
//
// A PLAYBACK-SPEED control, which is the convention a visitor already has: the label is the speed, so 2×
// means faster and holds each step for HALF as long, and 0.5× means slower and holds it twice as long. The
// dwell is therefore scaled by the INVERSE of the label, which is the one thing about this that is easy to
// get backwards. The cycle starts at 1× and the first tap is faster, because faster is the common ask.
//
// The choice is remembered (localStorage), so a pace a visitor set survives a chapter change and a reload.
// Nothing here throws: storage is blocked in a private window, and a tour that cannot read a preference must
// still run at the default pace.
//
// It lives outside director.ts because it is the one part of the autoplay machine that reads NONE of the
// director's closure state: it is an index, three options and a storage key. Everything else in that machine
// (the dwell, the task gate, the beat position) is bound to the same shared state and would need that state
// re-plumbed through an interface to live anywhere else.
//
// A NARRATED walk does not offer this at all. There the pace is the length of the voice, and a multiplier
// over it would cut the voice off part way through the step it was scaling.
//
// House rules: Australian English, no em dashes, precise claims.

// The paces on offer, in the order the control cycles them.
const SPEED_OPTIONS: ReadonlyArray<{ label: string; dwellMul: number }> = [
  { label: "1×", dwellMul: 1 },
  { label: "2×", dwellMul: 0.5 },
  { label: "0.5×", dwellMul: 2 },
];
const SPEED_STORAGE_KEY = "downpipes:tour:speed";

export interface ReadingSpeed {
  // The multiplier to apply to a step's dwell (the inverse of the visible label).
  mul(): number;
  // The visible label for the current pace ("1×", "2×", "0.5×").
  label(): string;
  // Move to the next pace and remember it. Returns the new label, so the caller can repaint its control and
  // announce the change without asking twice.
  cycle(): string;
}

// loadIdx reads the remembered index, defaulting to 0 (1×) when storage is blocked or holds anything out of
// range. A stored value from an older, longer option list is out of range and falls back rather than throwing.
function loadIdx(): number {
  try {
    const raw = Number(localStorage.getItem(SPEED_STORAGE_KEY));
    if (Number.isInteger(raw) && raw >= 0 && raw < SPEED_OPTIONS.length) return raw;
  } catch {
    // Storage blocked (private mode, or disabled): fall through to the default pace.
  }
  return 0;
}

export function createReadingSpeed(): ReadingSpeed {
  let idx = loadIdx();
  const label = (): string => SPEED_OPTIONS[idx]?.label ?? "1×";
  return {
    mul(): number {
      return SPEED_OPTIONS[idx]?.dwellMul ?? 1;
    },
    label,
    cycle(): string {
      idx = (idx + 1) % SPEED_OPTIONS.length;
      try {
        localStorage.setItem(SPEED_STORAGE_KEY, String(idx));
      } catch {
        // Storage blocked: the choice still applies for this session, it simply is not remembered.
      }
      return label();
    },
  };
}
