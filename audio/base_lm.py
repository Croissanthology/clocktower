"""A real base model (no chat template, no assistant) as a tiny HTTP continuation server.

  audio/venv/bin/python audio/base_lm.py                 # loads mlx-community/Qwen2.5-3B-4bit (a real base model), serves :4243
  POST /complete {"prompt": "...", "max_tokens": 80, "temperature": 0.9}  → {"text": "..."}

The tea party's Scroll-Creature talks through this: whatever the visitors say becomes the last line of the
White Rabbit's notebook, and the model just... continues the notebook.
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
MODEL = os.environ.get("BASE_MODEL", "mlx-community/Qwen2.5-3B-4bit")
PORT = int(os.environ.get("BASE_PORT", "4243"))
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler, make_logits_processors
print("loading", MODEL, flush=True)
model, tok = load(MODEL)
print("ready on", PORT, flush=True)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "model": MODEL}).encode())
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); b = json.loads(self.rfile.read(n) or b"{}")
        t0 = time.time()
        sampler = make_sampler(temp=float(b.get("temperature", 0.9)), top_p=0.95)
        procs = make_logits_processors(repetition_penalty=float(b.get("repetition_penalty", 1.25)), repetition_context_size=60)
        text = generate(model, tok, prompt=b.get("prompt", ""), max_tokens=int(b.get("max_tokens", 80)), sampler=sampler, logits_processors=procs, verbose=False)
        for stop in b.get("stop", []):
            if stop and stop in text: text = text.split(stop)[0]
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"text": text, "seconds": round(time.time() - t0, 2)}).encode())
        print(f"{time.strftime('%H:%M:%S')} {len(text)} chars in {time.time()-t0:.1f}s", flush=True)

HTTPServer(("0.0.0.0", PORT), H).serve_forever()
