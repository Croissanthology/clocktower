"""Procedural sound effects for the clocktower table.

  bell.wav          dark bell rung before an AI speaks
  quill-N.wav       quill scratching on parchment
  creak-N.wav       old wood settling
  (chant-N.wav are real public-domain gregorian phrases, cut by hand from archive.org — not generated here)

Run:  audio/venv/bin/python audio/make_sfx.py
"""
import os, subprocess, sys, random
import numpy as np
from scipy.io import wavfile

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sfx")
ROOT = os.path.dirname(HERE)
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)

def write(name, x, peak=0.8):
    x = np.nan_to_num(np.asarray(x, dtype=np.float64))
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    wavfile.write(os.path.join(OUT, name), SR, (x * 32767).astype(np.int16))
    print("wrote", name, f"{len(x)/SR:.1f}s")

def env(n, attack, decay):
    t = np.arange(n) / SR
    return np.minimum(t / max(attack, 1e-4), 1.0) * np.exp(-t / decay)

def lowpass(x, cutoff):
    # one-pole, cheap and good enough for texture
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x); acc = 0.0
    for i, v in enumerate(x):
        acc = a * acc + (1 - a) * v; y[i] = acc
    return y

# ---- bell: inharmonic partials of a low church bell (hum, prime, tierce, quint, nominal)
def bell(f0=110.0, dur=6.0):
    n = int(SR * dur); t = np.arange(n) / SR
    partials = [(0.5, 1.0, 5.0), (1.0, 0.8, 3.5), (1.2, 0.5, 2.5), (1.5, 0.35, 2.0),
                (2.0, 0.45, 1.6), (2.51, 0.2, 1.1), (3.0, 0.12, 0.9), (4.2, 0.06, 0.6)]
    x = np.zeros(n)
    for ratio, amp, dec in partials:
        f = f0 * ratio * (1 + rng.normal(0, 0.002))
        x += amp * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) * np.exp(-t / dec)
    strike = rng.normal(0, 1, n) * np.exp(-t / 0.012)
    x += 0.6 * lowpass(strike, 2500)
    x *= np.minimum(t / 0.003, 1.0)
    return x

# ---- quill: bursts of filtered noise with stroke-shaped envelopes, a few strokes per clip
def quill(dur=None):
    dur = dur or rng.uniform(1.8, 3.5)
    n = int(SR * dur); x = np.zeros(n); pos = int(SR * 0.1)
    while pos < n - SR * 0.3:
        L = int(SR * rng.uniform(0.08, 0.32))
        t = np.arange(L) / SR
        shape = np.clip(np.sin(np.pi * t / t[-1]), 0, 1) ** rng.uniform(0.6, 1.6)
        noise = rng.normal(0, 1, L)
        # scratch texture: modulate with a fast jitter so it grains
        grain = 0.6 + 0.4 * np.sin(2 * np.pi * rng.uniform(40, 120) * t + rng.uniform(0, 6))
        seg = noise * shape * grain
        seg = seg - lowpass(seg, 900)           # highpass-ish, keep the hiss
        x[pos:pos + L] += seg * rng.uniform(0.5, 1.0)
        pos += L + int(SR * rng.uniform(0.03, 0.25))
    return x

# ---- creak: stick-slip — a slowly sliding pitch of short pulses, resonant, drifting
def creak(dur=None):
    dur = dur or rng.uniform(1.2, 2.6)
    n = int(SR * dur); t = np.arange(n) / SR
    rate = rng.uniform(25, 60) * (1 + 0.5 * np.sin(2 * np.pi * rng.uniform(0.3, 0.9) * t + rng.uniform(0, 6)))
    rate *= np.interp(t, [0, dur], [1.0, rng.uniform(0.4, 1.4)])
    phase = np.cumsum(rate) / SR
    pulses = (np.diff(np.floor(phase), prepend=0) > 0).astype(float)
    # ring each pulse through a wooden resonance
    f_res = rng.uniform(180, 420)
    k = int(SR * 0.03); tk = np.arange(k) / SR
    ir = np.sin(2 * np.pi * f_res * tk) * np.exp(-tk / 0.006) + 0.5 * np.sin(2 * np.pi * f_res * 2.7 * tk) * np.exp(-tk / 0.003)
    x = np.convolve(pulses, ir)[:n]
    x *= np.clip(np.sin(np.pi * t / dur), 0, 1) ** 0.7 * (0.7 + 0.3 * rng.random(n) )
    return x

if __name__ == "__main__":
    write("bell.wav", bell())
    for i in range(4): write(f"quill-{i}.wav", quill(), peak=0.5)
    # creaks are real CC0 recordings (archive.org Red_Library_Creaks); procedural creak() kept for reference
