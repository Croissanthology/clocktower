#!/usr/bin/env python3
"""
kokoro_synth.py <kokoro-voice-id> <output.wav> <text...>

Thin wrapper around kokoro-onnx used by synth.sh for all `k-*` voice-ids.
Loads the local kokoro-v1.0.onnx + voices-v1.0.bin model files (this dir's
models/), synthesizes one line, and writes a mono 16-bit PCM WAV.

Not meant to be run standalone by humans except for testing -- synth.sh is
the real entry point and does the voice-id -> kokoro-voice-name mapping.
"""
import sys
import os

def main():
    if len(sys.argv) < 4:
        print("Usage: kokoro_synth.py <kokoro-voice> <output.wav> <text...>", file=sys.stderr)
        sys.exit(1)

    voice = sys.argv[1]
    out_path = sys.argv[2]
    text = " ".join(sys.argv[3:])

    if not text.strip():
        print("Error: no text provided", file=sys.stderr)
        sys.exit(1)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, "models", "kokoro-v1.0.onnx")
    voices_path = os.path.join(script_dir, "models", "voices-v1.0.bin")

    if not os.path.isfile(model_path):
        print(f"Error: kokoro model not found at {model_path}", file=sys.stderr)
        sys.exit(1)
    if not os.path.isfile(voices_path):
        print(f"Error: kokoro voices file not found at {voices_path}", file=sys.stderr)
        sys.exit(1)

    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
    except ImportError as e:
        print(f"Error: kokoro-onnx not installed in this venv ({e})", file=sys.stderr)
        sys.exit(1)

    try:
        kokoro = Kokoro(model_path, voices_path)
        samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
        sf.write(out_path, samples, sample_rate, subtype="PCM_16")
    except Exception as e:
        print(f"Error: kokoro synthesis failed for voice '{voice}': {e}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
        print(f"Error: output file missing or empty: {out_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
