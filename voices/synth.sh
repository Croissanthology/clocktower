#!/bin/bash
# synth.sh <voice-id> <output.wav> <text...>
#
# Synthesizes speech locally for one of the Blood on the Clocktower AI
# player voices. Routes to either macOS `say` (built-in) or piper-tts
# (neural, via the venv/models in this directory) depending on voice-id.
#
# Exits 0 on success (and the output file exists and is non-empty).
# Exits non-zero on any failure, with a message on stderr.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPER_BIN="$SCRIPT_DIR/venv/bin/piper"
PYTHON_BIN="$SCRIPT_DIR/venv/bin/python3"
KOKORO_SYNTH="$SCRIPT_DIR/kokoro_synth.py"
MODELS_DIR="$SCRIPT_DIR/models"

usage() {
  echo "Usage: $0 <voice-id> <output.wav> <text...>" >&2
  echo "" >&2
  echo "Known voice-ids:" >&2
  echo "  macOS say:   oldman  oldman-wheeze  monotone  eerie" >&2
  echo "  piper:       snape  northern  cori  alba  jenny" >&2
  echo "  piper/semaine (multi-speaker, one model): prudence  spike  obadiah  poppy" >&2
  echo "  kokoro (neural, k- prefix): k-george  k-fable  k-lewis  k-fenrir  k-onyx" >&2
  echo "               k-heart  k-nicole  k-bella  k-emma  k-isabella" >&2
  exit 1
}

if [ "$#" -lt 3 ]; then
  usage
fi

VOICE_ID="$1"
OUT="$2"
shift 2
TEXT="$*"

if [ -z "$TEXT" ]; then
  echo "Error: no text provided" >&2
  exit 1
fi

ENGINE=""
MACVOICE=""
MODEL=""
SPEAKER=""
KOKORO_VOICE=""

case "$VOICE_ID" in
  oldman)
    ENGINE=mac; MACVOICE="Grandpa (English (US))" ;;
  oldman-wheeze)
    ENGINE=mac; MACVOICE="Albert" ;;
  monotone)
    ENGINE=mac; MACVOICE="Fred" ;;
  eerie)
    ENGINE=mac; MACVOICE="Whisper" ;;
  snape)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-alan-medium.onnx" ;;
  northern)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-northern_english_male-medium.onnx" ;;
  cori)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-cori-high.onnx" ;;
  alba)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-alba-medium.onnx" ;;
  jenny)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-jenny_dioco-medium.onnx" ;;
  prudence)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-semaine-medium.onnx"; SPEAKER=0 ;;
  spike)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-semaine-medium.onnx"; SPEAKER=1 ;;
  obadiah)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-semaine-medium.onnx"; SPEAKER=2 ;;
  poppy)
    ENGINE=piper; MODEL="$MODELS_DIR/en_GB-semaine-medium.onnx"; SPEAKER=3 ;;
  k-george)
    ENGINE=kokoro; KOKORO_VOICE="bm_george" ;;
  k-fable)
    ENGINE=kokoro; KOKORO_VOICE="bm_fable" ;;
  k-lewis)
    ENGINE=kokoro; KOKORO_VOICE="bm_lewis" ;;
  k-fenrir)
    ENGINE=kokoro; KOKORO_VOICE="am_fenrir" ;;
  k-onyx)
    ENGINE=kokoro; KOKORO_VOICE="am_onyx" ;;
  k-heart)
    ENGINE=kokoro; KOKORO_VOICE="af_heart" ;;
  k-nicole)
    ENGINE=kokoro; KOKORO_VOICE="af_nicole" ;;
  k-bella)
    ENGINE=kokoro; KOKORO_VOICE="af_bella" ;;
  k-emma)
    ENGINE=kokoro; KOKORO_VOICE="bf_emma" ;;
  k-isabella)
    ENGINE=kokoro; KOKORO_VOICE="bf_isabella" ;;
  *)
    echo "Error: unknown voice-id '$VOICE_ID'" >&2
    usage
    ;;
esac

OUT_DIR="$(dirname "$OUT")"
mkdir -p "$OUT_DIR" 2>/dev/null

if [ "$ENGINE" = "mac" ]; then
  if ! say -v "$MACVOICE" --file-format=WAVE --data-format=LEI16@22050 -o "$OUT" "$TEXT" 2>/tmp/synth_err.$$; then
    echo "Error: say synthesis failed for voice-id '$VOICE_ID' (voice='$MACVOICE')" >&2
    cat /tmp/synth_err.$$ >&2
    rm -f /tmp/synth_err.$$
    exit 1
  fi
  rm -f /tmp/synth_err.$$

elif [ "$ENGINE" = "piper" ]; then
  if [ ! -x "$PIPER_BIN" ]; then
    echo "Error: piper not found at $PIPER_BIN" >&2
    echo "  Set it up with: cd $SCRIPT_DIR && /opt/homebrew/bin/python3.12 -m venv venv && venv/bin/pip install piper-tts" >&2
    exit 1
  fi
  if [ ! -f "$MODEL" ]; then
    echo "Error: model file not found: $MODEL" >&2
    exit 1
  fi
  SPK_ARGS=()
  if [ -n "$SPEAKER" ]; then
    SPK_ARGS=(-s "$SPEAKER")
  fi
  if ! printf '%s' "$TEXT" | "$PIPER_BIN" -m "$MODEL" "${SPK_ARGS[@]}" -f "$OUT" 2>/tmp/synth_err.$$; then
    echo "Error: piper synthesis failed for voice-id '$VOICE_ID' (model='$MODEL')" >&2
    cat /tmp/synth_err.$$ >&2
    rm -f /tmp/synth_err.$$
    exit 1
  fi
  rm -f /tmp/synth_err.$$

elif [ "$ENGINE" = "kokoro" ]; then
  if [ ! -x "$PYTHON_BIN" ]; then
    echo "Error: venv python not found at $PYTHON_BIN" >&2
    exit 1
  fi
  if [ ! -f "$MODELS_DIR/kokoro-v1.0.onnx" ] || [ ! -f "$MODELS_DIR/voices-v1.0.bin" ]; then
    echo "Error: kokoro model files not found in $MODELS_DIR" >&2
    echo "  Expected: kokoro-v1.0.onnx and voices-v1.0.bin" >&2
    exit 1
  fi
  if ! "$PYTHON_BIN" "$KOKORO_SYNTH" "$KOKORO_VOICE" "$OUT" "$TEXT" 2>/tmp/synth_err.$$; then
    echo "Error: kokoro synthesis failed for voice-id '$VOICE_ID' (kokoro-voice='$KOKORO_VOICE')" >&2
    cat /tmp/synth_err.$$ >&2
    rm -f /tmp/synth_err.$$
    exit 1
  fi
  rm -f /tmp/synth_err.$$

else
  echo "Error: internal — no engine resolved for voice-id '$VOICE_ID'" >&2
  exit 1
fi

if [ ! -s "$OUT" ]; then
  echo "Error: output file missing or empty: $OUT" >&2
  exit 1
fi

echo "Wrote $OUT"
exit 0
