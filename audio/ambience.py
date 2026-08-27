"""Random, never-overlapping ambient sounds for a hidden speaker.

  audio/venv/bin/python audio/ambience.py --device "JBL Flip"    # any substring of the output device name
  audio/venv/bin/python audio/ambience.py --list                  # show output devices

Picks a random clip from audio/sfx/ (quill, creak, chant) with weights, plays it,
then waits a random gap. One sound at a time by construction. Ctrl-C to stop.
"""
import argparse, glob, os, random, time
import numpy as np, sounddevice as sd
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
SFX = os.path.join(HERE, "sfx")
KINDS = {"quill": 5, "creak": 4, "chant": 2, "thunder": 2}   # relative frequency
GAIN  = {"quill": 0.5, "creak": 0.6, "chant": 0.8, "thunder": 0.9}
CLOCK = os.path.join(SFX, "clock.wav")                       # heavy hands: one clunk on every real minute

ap = argparse.ArgumentParser()
ap.add_argument("--device", default=None, help="substring of output device name (default: system default)")
ap.add_argument("--list", action="store_true")
ap.add_argument("--min-gap", type=float, default=6.0)
ap.add_argument("--max-gap", type=float, default=25.0)
ap.add_argument("--volume", type=float, default=1.0)
ap.add_argument("--no-clock", action="store_true")
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

clips = {k: sorted(glob.glob(os.path.join(SFX, f"{k}-*.wav"))) for k in KINDS}
kinds = [k for k in KINDS if clips[k]]
weights = [KINDS[k] for k in kinds]
last = None
clock = None
if os.path.exists(CLOCK) and not a.no_clock:
    csr, cx = wavfile.read(CLOCK); clock = (csr, cx.astype(np.float32) / 32768.0 * a.volume)
def to_minute(): return 60 - (time.time() % 60)
def idle(secs):
    """sleep, but strike the clock on the minute boundary if it falls inside the wait"""
    end = time.time() + secs
    while True:
        rem = end - time.time()
        if rem <= 0: return
        if clock and to_minute() < min(rem, 1.0):
            time.sleep(max(0, to_minute())); print(time.strftime("%H:%M:%S"), "clock"); sd.play(clock[1], clock[0], device=dev, blocking=True)
            continue
        time.sleep(min(rem, 0.5))
print("ambience on", sd.query_devices(dev)["name"] if dev is not None else "default output", "—", {k: len(clips[k]) for k in kinds})
while True:
    k = random.choices(kinds, weights)[0]
    if k == last and len(kinds) > 1: k = random.choices(kinds, weights)[0]
    f = random.choice(clips[k]); last = k
    sr, x = wavfile.read(f)
    x = x.astype(np.float32) / 32768.0 * GAIN[k] * a.volume
    # never straddle the minute: if the clip would run into the strike, wait for the strike first
    if clock and to_minute() < len(x) / sr + 0.5: idle(to_minute() + 0.1)
    print(time.strftime("%H:%M:%S"), os.path.basename(f))
    sd.play(x, sr, device=dev, blocking=True)
    idle(random.uniform(a.min_gap, a.max_gap))
