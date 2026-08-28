"""Ambient soundtrack for a hidden speaker: constant rain, random events, a heavy clock on the minute.

  audio/venv/bin/python audio/ambience.py --device "JBL Flip"    # any substring of the output device name
  audio/venv/bin/python audio/ambience.py --list                  # show output devices

One output stream mixes three layers:
  bed     audio/sfx/rain.wav looped forever at --rain gain (0 = off)
  events  a random clip from audio/sfx/ (quill, creak, chant, thunder), weighted, one at a time,
          random gap between them
  clock   audio/sfx/clock-recorded.wav (or --clock synth) struck on every real wall-clock minute (--no-clock to silence)
Events and the clock never overlap each other; the rain runs under everything. Ctrl-C stops.
"""
import argparse, glob, os, random, threading, time
import numpy as np, sounddevice as sd
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
SFX = os.path.join(HERE, "sfx")
KINDS = {"quill": 5, "creak": 4, "chant": 2, "thunder": 2}   # relative frequency
GAIN  = {"quill": 0.5, "creak": 0.6, "chant": 1.0, "thunder": 0.9}
SR = 44100

ap = argparse.ArgumentParser()
ap.add_argument("--device", default=None, help="substring of output device name (default: system default)")
ap.add_argument("--list", action="store_true")
ap.add_argument("--min-gap", type=float, default=6.0)
ap.add_argument("--max-gap", type=float, default=25.0)
ap.add_argument("--volume", type=float, default=1.0, help="master gain")
ap.add_argument("--rain", type=float, default=0.35, help="rain bed gain (0 = no rain)")
ap.add_argument("--no-clock", action="store_true")
ap.add_argument("--clock", default="recorded", choices=["recorded", "synth"], help="which clock strike: recorded (ratchet+mechanism+bell) or synth (the original)")
a = ap.parse_args()

if a.list:
    for i, d in enumerate(sd.query_devices()):
        if d["max_output_channels"]: print(i, d["name"], d["max_output_channels"], "out")
    raise SystemExit

dev = None
if a.device:
    for i, d in enumerate(sd.query_devices()):
        if a.device.lower() in d["name"].lower() and d["max_output_channels"]:
            dev = i; break
    if dev is None: raise SystemExit(f"no output device matching {a.device!r} (try --list)")

def load(f):
    sr, x = wavfile.read(f)
    x = x.astype(np.float32) / 32768.0
    if x.ndim > 1: x = x.mean(axis=1)
    if sr != SR:  # cheap linear resample; clips were all rendered at 44.1k anyway
        x = np.interp(np.linspace(0, len(x), int(len(x) * SR / sr), endpoint=False), np.arange(len(x)), x)
    return x

clips = {k: [load(f) for f in sorted(glob.glob(os.path.join(SFX, f"{k}-*.wav")))] for k in KINDS}
kinds = [k for k in KINDS if clips[k]]
weights = [KINDS[k] for k in kinds]
rain = load(os.path.join(SFX, "rain.wav")) if a.rain > 0 and os.path.exists(os.path.join(SFX, "rain.wav")) else None
clock_file = os.path.join(SFX, f"clock-{a.clock}.wav")
clock = load(clock_file) if not a.no_clock and os.path.exists(clock_file) else None

# --- mixer state (touched from the audio callback and the scheduler thread) ---
lock = threading.Lock()
rain_pos = 0
event = None          # (array, pos) currently playing foreground clip
def busy():
    with lock: return event is not None

def callback(out, frames, t, status):
    global rain_pos, event
    buf = np.zeros(frames, dtype=np.float32)
    if rain is not None:
        idx = (rain_pos + np.arange(frames)) % len(rain)
        buf += rain[idx] * a.rain
        rain_pos = (rain_pos + frames) % len(rain)
    with lock:
        if event is not None:
            x, pos = event
            n = min(frames, len(x) - pos)
            buf[:n] += x[pos:pos + n]
            event = (x, pos + n) if pos + n < len(x) else None
    out[:, 0] = np.clip(buf * a.volume, -1, 1)

def play(x, label):
    global event
    with lock: event = (x, 0)
    print(time.strftime("%H:%M:%S"), label, flush=True)
    while busy(): time.sleep(0.05)

def to_minute(): return 60 - (time.time() % 60)

def idle(secs):
    """wait, but strike the clock on any minute boundary that falls inside the wait"""
    end = time.time() + secs
    while True:
        rem = end - time.time()
        if rem <= 0: return
        if clock is not None and to_minute() < min(rem, 1.0):
            time.sleep(max(0, to_minute())); play(clock, "clock"); continue
        time.sleep(min(rem, 0.25))

name = sd.query_devices(dev)["name"] if dev is not None else "default output"
print(f"ambience on {name} — rain {a.rain if rain is not None else 'off'}, clock {'on' if clock is not None else 'off'}, "
      + ", ".join(f"{k} x{len(clips[k])}" for k in kinds), flush=True)
last = None
with sd.OutputStream(samplerate=SR, channels=1, device=dev, callback=callback, blocksize=2048):
    idle(random.uniform(2, 6))
    while True:
        k = random.choices(kinds, weights)[0]
        if k == last and len(kinds) > 1: k = random.choices(kinds, weights)[0]
        x = random.choice(clips[k]) * GAIN[k]; last = k
        # never straddle the minute: if the clip would run into the strike, let the strike go first
        if clock is not None and to_minute() < len(x) / SR + 0.5: idle(to_minute() + 0.1)
        play(x, k)
        idle(random.uniform(a.min_gap, a.max_gap))
