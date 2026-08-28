"""Play-agent: runs on the machine that owns the audio interface when the game server lives elsewhere.

  audio/venv/bin/python audio/play_agent.py --server http://192.168.0.246:4141 --device UMC1820

Polls the server for speech/bell jobs, fetches the wav, plays it on the requested output channel
(all other channels silent), reports done. Start the server with CT_PLAY=remote.
"""
import argparse, io, time, sys
import numpy as np, requests, sounddevice as sd, soundfile as sf

ap = argparse.ArgumentParser()
ap.add_argument("--server", required=True)
ap.add_argument("--device", default="UMC1820")
a = ap.parse_args()

dev = None
for i, d in enumerate(sd.query_devices()):
    if a.device.lower() in d["name"].lower() and d["max_output_channels"] > 0: dev = i; break
if dev is None: sys.exit(f"no output device matching {a.device!r}")
nout = sd.query_devices(dev)["max_output_channels"]
print(f"play-agent on {sd.query_devices(dev)['name']} ({nout} out) ← {a.server}", flush=True)

def play(job):
    wav = requests.get(a.server + job["url"], timeout=30).content
    x, sr = sf.read(io.BytesIO(wav), dtype="float32", always_2d=False)
    if x.ndim > 1: x = x[:, 0]
    if job.get("head"):
        n = int(sr * job["head"])
        if len(x) > n:
            fade = min(n, int(sr * 0.4)); x = x[:n].copy(); x[-fade:] *= np.linspace(1, 0, fade, dtype="float32")
    rate = float(job.get("rate") or 1.0)
    if rate != 1.0:
        x = np.interp(np.arange(0, len(x), rate), np.arange(len(x)), x).astype("float32")
    ch = max(1, min(nout, int(job["channel"])))
    out = np.zeros((len(x), nout), dtype="float32"); out[:, ch - 1] = x
    print(time.strftime("%H:%M:%S"), f"job {job['id']} → ch {ch} ({len(x)/sr:.1f}s)", flush=True)
    sd.play(out, sr, device=dev, blocking=True)

while True:
    try:
        j = requests.get(a.server + "/api/play/next", timeout=5).json().get("job")
        if j:
            try: play(j)
            except Exception as e: print("play failed:", e, flush=True)
            requests.post(a.server + "/api/play/done", json={"id": j["id"]}, timeout=5)
        else:
            time.sleep(0.3)
    except Exception as e:
        print("server unreachable:", e, flush=True); time.sleep(2)
