"""Run on the Ubuntu server after install: checks the REAL model with spoken English and Kiswahili (made with
espeak-ng), a video, silence and an invalid file, and prints accuracy and speed.
    sudo -u aivs-transcribe /opt/aivs-transcribe/venv/bin/python /opt/aivs-transcribe/selftest.py
The synthetic voices are robotic; real recordings will score differently."""
import json, os, re, sys, tempfile, time, urllib.request, uuid
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests"))
from make_speech import make_all, EN, SW

URL = os.environ.get("SELFTEST_URL", "http://127.0.0.1:9000"); TOKEN = os.environ.get("TRANSCRIBE_TOKEN") or open("/etc/aivs-transcribe.env").read().split("TRANSCRIBE_TOKEN=")[1].split()[0]
def req(method, path, body=None, ctype=None):
    r = urllib.request.Request(URL + path, data=body, method=method, headers={"Authorization": f"Bearer {TOKEN}", **({"Content-Type": ctype} if ctype else {})})
    try:
        with urllib.request.urlopen(r, timeout=3600) as x: return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")
def submit(path, lang="auto"):
    b = uuid.uuid4().hex; data = open(path, "rb").read()
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{lang}\r\n--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{os.path.basename(path)}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{b}--\r\n".encode()
    st, j = req("POST", "/v1/jobs", body, f"multipart/form-data; boundary={b}")
    if st != 202: return st, j
    while True:
        st, j = req("GET", f"/v1/jobs/{j['id']}")
        if j.get("status") in ("done", "failed"): req("DELETE", f"/v1/jobs/{j['id']}"); return st, j
        print(f"   … {int((j.get('progress') or 0) * 100)}%", end="\r"); time.sleep(1)
words = lambda t: re.findall(r"[a-zà-ÿ']+", t.lower())
def accuracy(ref, hyp):
    r, h = words(ref), words(hyp); d = [[i + j if i * j == 0 else 0 for j in range(len(h) + 1)] for i in range(len(r) + 1)]
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1): d[i][j] = min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (r[i-1] != h[j-1]))
    return max(0.0, 1 - d[-1][-1] / max(1, len(r)))
d = make_all(tempfile.mkdtemp()); ok = True
_, h = req("GET", "/health"); print(f"Engine {h.get('engine')} model {h.get('model')} ({h.get('compute_type')}), {h.get('cpu_threads')} threads, RAM {h.get('ram_available_gb')}/{h.get('ram_total_gb')} GB free")
for name, ref, want in [("english.wav", EN, "en"), ("kiswahili.wav", SW, "sw"), ("video.mp4", EN, "en")]:
    st, j = submit(f"{d}/{name}"); r = j.get("result") or {}
    text = " ".join(s["text"] for s in r.get("segments", []))
    acc = accuracy(ref, text); good = j.get("status") == "done" and r.get("language") == want and acc >= 0.6; ok &= good
    print(f"{'PASS' if good else 'FAIL'}  {name}: language {r.get('language')} ({r.get('language_basis')}), word accuracy {acc:.0%}, {r.get('speed_x_realtime')}x real time\n      “{text[:160]}”{' ' + j.get('error','') if j.get('error') else ''}")
st, j = submit(f"{d}/kiswahili.wav", "sw"); r = j.get("result") or {}; acc = accuracy(SW, " ".join(s["text"] for s in r.get("segments", [])))
print(f"{'PASS' if acc >= 0.6 else 'FAIL'}  kiswahili.wav with Kiswahili chosen manually: word accuracy {acc:.0%}"); ok &= acc >= 0.6
st, j = submit(f"{d}/silence.wav"); good = j.get("status") == "done" and not j["result"]["segments"]; ok &= good
print(f"{'PASS' if good else 'FAIL'}  silence.wav: {'no text produced' if good else j}")
for name, code in [("not-audio.mp3", 415), ("video-no-sound.mp4", 422)]:
    st, j = submit(f"{d}/{name}"); good = st == code; ok &= good
    print(f"{'PASS' if good else 'FAIL'}  {name}: refused with {st}: {j.get('detail')}")
print("\nALL CHECKS PASSED" if ok else "\nSOME CHECKS FAILED (see above)")
