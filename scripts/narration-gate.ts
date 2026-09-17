// The training-narration gate. The course speaks its steps aloud (public/narration/*.mp3, rendered from the
// Beginner script), and audio is the one part of a course that can silently stop matching the screen: the
// copy is edited, the words on the rail change, and the recording keeps saying the old thing.
//
// So the audio is held to the SCRIPT by content, not by a promise. The renderer (scripts/render-narration.py)
// writes public/narration/manifest.json with the sha256 of the text it actually spoke for each step. This
// gate re-derives that text from src/lib/demo/tour/scripts/training-beginner.ts through the shared composer
// (narration-text.ts, which the rail's own announcement also uses) and compares the hashes.
//
// THERE IS DELIBERATELY NO --write HERE. A gate that could bless its own subject would let a copy edit be
// waved through without re-rendering a single second of audio, which is the exact failure it exists to
// catch. The only thing that may update the manifest is the renderer, because only the renderer has spoken
// the words. `--print-source` emits what the renderer needs (id and text per step) on stdout, so the two
// halves cannot drift over which text is the subject.
//
// Fail-loud (internal-docs/GATE-THAT-CANNOT-CHECK.md): a missing manifest, a missing audio file, an empty
// one, or a derivation under the floor is a refusal, never a pass.
//
// Usage:
//   node scripts/narration-gate.ts                  # gate: derive, hash, compare
//   node scripts/narration-gate.ts --print-source   # feed the renderer: node ... | .venv/bin/python scripts/render-narration.py

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDomShim } from "../test/dom-shim.ts";

installDomShim();
const g = globalThis as unknown as Record<string, unknown>;
g.location = g.location ?? { origin: "https://console.test", search: "", hostname: "console.test", href: "https://console.test/" };

const { TRAINING_BEGINNER } = await import("../src/lib/demo/tour/scripts/training-beginner.ts");
const { narrationTextFor, narrationStepId } = await import("../src/lib/demo/tour/narration-text.ts");

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(CONSOLE_ROOT, "public", "narration");
const MANIFEST = join(DIR, "manifest.json");

// The voice the course speaks in, pinned here so a re-render in a different voice is a visible change to
// this file rather than a quiet change of who the product sounds like.
const VOICE = "af_heart";
const ENGINE = "kokoro-82M";

interface Step { id: string; text: string; file: string; sha256: string; bytes: number; seconds: number }

const derived: Array<{ id: string; text: string; sha256: string }> = [];
for (const [ci, chapter] of TRAINING_BEGINNER.entries()) {
  for (const [bi, beat] of chapter.infoPoints.entries()) {
    const text = narrationTextFor(beat);
    derived.push({ id: narrationStepId(ci, bi), text, sha256: createHash("sha256").update(text).digest("hex") });
  }
}

if (process.argv.includes("--print-source")) {
  process.stdout.write(`${JSON.stringify({ voice: VOICE, engine: ENGINE, steps: derived.map((d) => ({ id: d.id, text: d.text })) }, null, 1)}\n`);
  process.exit(0);
}

// Anti-vacuity: the Beginner walk is eight chapters of two-plus beats. A derivation under the floor means the
// script import collapsed, and a comparison over nothing is not a check.
const FLOOR = 15;
if (derived.length < FLOOR) {
  console.error(`[narration] REFUSED: derived only ${derived.length} step(s), below the floor of ${FLOOR}. The script import returned nothing, so nothing was checked.`);
  process.exit(2);
}

if (!existsSync(MANIFEST)) {
  console.error(`[narration] REFUSED: no manifest at ${MANIFEST}. Render the narration first:`);
  console.error("  node scripts/narration-gate.ts --print-source | <python-with-kokoro> scripts/render-narration.py");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { voice?: string; engine?: string; steps?: Step[] };
const steps = manifest.steps ?? [];
const byId = new Map(steps.map((s) => [s.id, s]));
const problems: string[] = [];

if (manifest.voice !== VOICE) problems.push(`the manifest was rendered in voice "${manifest.voice}", and this gate pins "${VOICE}"`);
if (manifest.engine !== ENGINE) problems.push(`the manifest was rendered by "${manifest.engine}", and this gate pins "${ENGINE}"`);

for (const d of derived) {
  const s = byId.get(d.id);
  if (!s) {
    problems.push(`step ${d.id} has no audio at all (the manifest does not carry it)`);
    continue;
  }
  if (s.sha256 !== d.sha256) {
    problems.push(`step ${d.id} was rendered from different words than the script now carries (re-render it)`);
    continue;
  }
  const p = join(DIR, s.file);
  if (!existsSync(p)) {
    problems.push(`step ${d.id} names ${s.file}, which is not in public/narration`);
    continue;
  }
  const size = statSync(p).size;
  if (size < 2000) problems.push(`step ${d.id} audio ${s.file} is ${size} bytes, which is too small to be a spoken step`);
}
for (const s of steps) {
  if (!derived.some((d) => d.id === s.id)) problems.push(`the manifest carries audio for step ${s.id}, which the walk no longer has`);
}

if (problems.length > 0) {
  console.error(`[narration] FAIL: ${problems.length} problem(s) between the walk and its narration:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("  Re-render: node scripts/narration-gate.ts --print-source | <python-with-kokoro> scripts/render-narration.py");
  process.exit(1);
}

const totalBytes = steps.reduce((n, s) => n + (s.bytes || 0), 0);
console.log(`[narration] OK: ${derived.length} step(s) spoken by ${VOICE}, every one rendered from the words the script carries now (${Math.round(totalBytes / 1024)} KB total).`);
