#!/usr/bin/env python3
"""Rough per-file mean pitch (F0) estimate via autocorrelation, just to
sanity-check male/female/register when we can't literally listen.
Not scientific -- just a coarse signal for voice selection."""
import sys, glob
import numpy as np
import soundfile as sf

def estimate_f0(y, sr, fmin=60, fmax=400, frame=2048, hop=512):
    f0s = []
    for start in range(0, len(y) - frame, hop):
        seg = y[start:start+frame].astype(np.float64)
        seg = seg - seg.mean()
        if np.abs(seg).max() < 0.01:
            continue
        seg = seg * np.hanning(len(seg))
        ac = np.correlate(seg, seg, mode="full")[len(seg)-1:]
        lag_min = int(sr / fmax)
        lag_max = int(sr / fmin)
        if lag_max >= len(ac):
            continue
        segment = ac[lag_min:lag_max]
        if len(segment) == 0:
            continue
        peak = np.argmax(segment) + lag_min
        if ac[0] == 0:
            continue
        conf = segment[np.argmax(segment)] / ac[0]
        if conf > 0.3 and peak > 0:
            f0s.append(sr / peak)
    return f0s

for path in sorted(glob.glob("samples/k-*.wav")):
    y, sr = sf.read(path)
    if y.ndim > 1:
        y = y.mean(axis=1)
    f0s = estimate_f0(y, sr)
    if f0s:
        f0s = np.array(f0s)
        print(f"{path}: median_f0={np.median(f0s):.0f}Hz  mean={f0s.mean():.0f}Hz  n_voiced_frames={len(f0s)}")
    else:
        print(f"{path}: no voiced frames detected")
