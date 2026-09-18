# Renders the Beginner course's narration: one MP3 per step, spoken by Kokoro-82M's af_heart, plus the
# manifest that holds the audio to the script.
#
# WHY THIS IS PYTHON AND NOT PART OF THE NODE CHAIN. The model is a 310 MB ONNX file and the phonemiser is a
# native library; neither belongs in the console's install, and neither is needed to BUILD or SERVE the
# course. Rendering happens on a workstation when the copy changes, and the committed MP3s are what ships.
# scripts/narration-gate.ts is the half that runs everywhere, and it fails if these two ever disagree.
#
# WHY KOKORO. It is Apache-2.0, model and voices alike, so the audio can ship in a commercial product
# without an attribution or a non-commercial clause. The field was auditioned before this was chosen; the
# alternatives were either non-commercial (XTTS, F5-TTS weights, several Piper voices) or a service whose
# voices are not licensed for embedding (the Edge and Google web endpoints).
#
# SETUP, once:
#   python3 -m venv .venv && .venv/bin/pip install kokoro-onnx lameenc numpy
#   brew install espeak-ng          # the bundled phonemiser data path is baked at wheel-build time
#   curl -L -o kokoro-v1.0.onnx  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
#   curl -L -o voices-v1.0.bin   https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
#
# RUN, from the console directory:
#   node scripts/narration-gate.ts --print-source \
#     | PHONEMIZER_ESPEAK_LIBRARY=/opt/homebrew/lib/libespeak-ng.dylib ESPEAK_DATA_PATH=/opt/homebrew/share \
#       .venv/bin/python scripts/render-narration.py --model <dir holding the two model files>
#
# It reads the step text from stdin (the gate is the one composer of that text) and writes
# public/narration/*.mp3 plus public/narration/manifest.json. The manifest carries the sha256 of the text it
# ACTUALLY spoke, which is what makes the gate meaningful: only a real render can move it.
#
# House rules: Australian English, precise claims.

import argparse
import hashlib
import json
import os
import pathlib
import sys

CONSOLE_ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = CONSOLE_ROOT / "public" / "narration"
# 64 kbps mono is the point where speech stops improving to the ear and the page keeps getting heavier.
BITRATE_KBPS = 64


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=".", help="directory holding kokoro-v1.0.onnx and voices-v1.0.bin")
    args = ap.parse_args()

    source = json.load(sys.stdin)
    voice = source["voice"]
    engine = source["engine"]
    steps = source["steps"]
    if len(steps) < 15:
        print(f"[render-narration] REFUSED: {len(steps)} step(s) on stdin, below the floor of 15.", file=sys.stderr)
        return 2

    import numpy as np
    import lameenc
    from kokoro_onnx import Kokoro

    model_dir = pathlib.Path(args.model).resolve()
    ko = Kokoro(str(model_dir / "kokoro-v1.0.onnx"), str(model_dir / "voices-v1.0.bin"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    rendered = []
    for step in steps:
        text = step["text"]
        audio, rate = ko.create(text, voice=voice, speed=1.0, lang="en-us")
        pcm = (np.clip(np.asarray(audio), -1.0, 1.0) * 32767).astype("<i2").tobytes()
        enc = lameenc.Encoder()
        enc.set_bit_rate(BITRATE_KBPS)
        enc.set_in_sample_rate(rate)
        enc.set_channels(1)
        enc.set_quality(2)
        data = enc.encode(pcm) + enc.flush()
        name = f"s{step['id']}.mp3"
        (OUT_DIR / name).write_bytes(data)
        rendered.append({
            "id": step["id"],
            "file": name,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "bytes": len(data),
            "seconds": round(len(audio) / rate, 1),
        })
        print(f"[render-narration] {step['id']:>5s}  {len(data) / 1024:6.1f} KB  {rendered[-1]['seconds']:5.1f}s")

    # Retire audio for steps the walk no longer has, so a removed chapter cannot leave a stale file behind
    # that the manifest never mentions and nobody ever hears.
    keep = {r["file"] for r in rendered} | {"manifest.json"}
    for f in OUT_DIR.iterdir():
        if f.name not in keep:
            f.unlink()
            print(f"[render-narration] removed {f.name}, no longer a step")

    manifest = {"engine": engine, "voice": voice, "bitrateKbps": BITRATE_KBPS, "steps": rendered}
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    total = sum(r["bytes"] for r in rendered)
    print(f"[render-narration] wrote {len(rendered)} step(s), {total / 1024:.0f} KB total, to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
