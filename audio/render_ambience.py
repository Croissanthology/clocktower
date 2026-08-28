"""Render the ambience to a file instead of a speaker: python render_ambience.py out.wav [minutes]"""
import sys, glob, os, random, numpy as np
from scipy.io import wavfile
HERE=os.path.dirname(os.path.abspath(__file__)); SFX=os.path.join(HERE,"sfx"); SR=44100
out=sys.argv[1]; minutes=float(sys.argv[2]) if len(sys.argv)>2 else 30
KINDS={"quill":5,"creak":4,"chant":1,"thunder":2}; GAIN={"quill":0.5,"creak":0.6,"chant":1.0,"thunder":0.9}
def load(f):
    sr,x=wavfile.read(f); x=x.astype(np.float32)/32768
    if x.ndim>1: x=x.mean(axis=1)
    if sr!=SR: x=np.interp(np.linspace(0,len(x),int(len(x)*SR/sr),endpoint=False),np.arange(len(x)),x)
    return x
clips={k:[load(f) for f in sorted(glob.glob(os.path.join(SFX,f"{k}-*.wav")))] for k in KINDS}
rain=load(os.path.join(SFX,"rain.wav")); clock=load(os.path.join(SFX,"clock-synth.wav"))
N=int(SR*60*minutes); mix=np.zeros(N,dtype=np.float32)
mix+=np.resize(rain,N)*1.0
def add(x,at):
    i=int(at*SR); n=min(len(x),N-i)
    if n>0: mix[i:i+n]+=x[:n]
for m in range(int(minutes)): add(clock,m*60)                      # the clock on every minute
t=random.uniform(2,6); last=None; kinds=list(KINDS); w=[KINDS[k] for k in kinds]
while t<60*minutes-15:
    k=random.choices(kinds,w)[0]
    if k==last: k=random.choices(kinds,w)[0]
    x=random.choice(clips[k])*GAIN[k]; last=k
    tm=60-(t%60)
    if tm<len(x)/SR+0.5: t+=tm+0.1                                  # never straddle the strike
    add(x,t); t+=len(x)/SR+random.uniform(3,10)
# seamless loop: crossfade the last 4 s into the first 4 s
f=SR*4; ramp=np.linspace(0,1,f,dtype=np.float32)
mix[:f]=mix[:f]*ramp+mix[-f:]*(1-ramp); mix=mix[:-f]
mix=np.clip(mix/max(1.0,np.max(np.abs(mix))/0.95),-1,1)
wavfile.write(out,SR,(mix*32767).astype(np.int16)); print("wrote",out,round(len(mix)/SR/60,1),"min")
