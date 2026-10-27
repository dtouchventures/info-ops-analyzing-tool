"""Service tests: real decoding (PyAV), real voice activity detection (Silero), validation, jobs, cleanup.
The recogniser itself is scripted (fake_engine.py) because Whisper models cannot be downloaded in the build
environment; selftest.py checks the real model on the server."""
import os, sys, tempfile, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE)); sys.path.insert(0, HERE)
os.environ.update(TRANSCRIBE_FAKE_ENGINE="1", TRANSCRIBE_TOKEN="t0ken", TRANSCRIBE_MAX_MINUTES="1", TRANSCRIBE_MAX_MB="5", TRANSCRIBE_WORK_DIR=tempfile.mkdtemp())
from fastapi.testclient import TestClient
import aivs_transcribe as S
from make_speech import make_all
M = make_all(tempfile.mkdtemp()); C = TestClient(S.app); H = {"Authorization": "Bearer t0ken"}

def submit(name, language="auto"):
    with open(f"{M}/{name}", "rb") as f: return C.post("/v1/jobs", files={"file": (name, f)}, data={"language": language}, headers=H)
def wait(jid):
    for _ in range(300):
        j = C.get(f"/v1/jobs/{jid}", headers=H).json()
        if j["status"] in ("done", "failed"): return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")

class Service(unittest.TestCase):
    def test_health_and_token(self):
        h = C.get("/health").json(); self.assertTrue(h["ok"]); self.assertEqual(h["device"], "cpu"); self.assertIn("ram_total_gb", h)
        self.assertEqual(submit_noauth().status_code, 401)
    def test_english_auto(self):
        r = submit("english.wav"); self.assertEqual(r.status_code, 202, r.text); self.assertAlmostEqual(r.json()["duration_s"], 9.4, delta=0.2)
        j = wait(r.json()["id"]); res = j["result"]
        self.assertEqual(j["status"], "done", j); self.assertEqual(res["language"], "en"); self.assertIn("detected automatically", res["language_basis"])
        self.assertTrue(res["speech_found"]); self.assertGreater(res["segments"][0]["end"], 8); self.assertLess(res["segments"][0]["start"], 1)
        self.assertFalse(os.listdir(os.environ["TRANSCRIBE_WORK_DIR"]), "the recording is deleted after the job")
    def test_kiswahili_auto_and_mp3(self):
        j = wait(submit("kiswahili.mp3").json()["id"]); self.assertEqual(j["result"]["language"], "sw"); self.assertIn("barabara", j["result"]["segments"][0]["text"])
    def test_manual_language(self):
        j = wait(submit("english.wav", "sw").json()["id"]); self.assertEqual(j["result"]["language"], "sw"); self.assertEqual(j["result"]["language_basis"], "chosen by the analyst")
    def test_video_audio_track(self):
        j = wait(submit("video.mp4").json()["id"]); self.assertEqual(j["status"], "done"); self.assertTrue(j["result"]["speech_found"])
    def test_silence_gives_no_text(self):
        j = wait(submit("silence.wav").json()["id"]); self.assertEqual(j["result"]["segments"], []); self.assertFalse(j["result"]["speech_found"])
    def test_invalid_files(self):
        r = submit("not-audio.mp3"); self.assertEqual(r.status_code, 415); self.assertIn("not an audio or video recording", r.json()["detail"])
        r = submit("video-no-sound.mp4"); self.assertEqual(r.status_code, 422); self.assertIn("no audio track", r.json()["detail"])
        self.assertEqual(submit("english.wav", "fr").status_code, 400)
    def test_limits(self):
        long = f"{M}/long.wav"; os.system(f"ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=8000:cl=mono -t 75 {long}")
        r = submit("long.wav"); self.assertEqual(r.status_code, 413); self.assertIn("limit is 1 minutes", r.json()["detail"])
        big = f"{M}/big.wav"; os.system(f"ffmpeg -y -loglevel error -f lavfi -i anoisesrc=r=48000 -t 30 -ac 2 {big}")
        r = submit("big.wav"); self.assertEqual(r.status_code, 413); self.assertIn("larger than 5 MB", r.json()["detail"])
        self.assertFalse([f for f in os.listdir(os.environ["TRANSCRIBE_WORK_DIR"])], "rejected uploads are deleted")
    def test_unclear_marking(self):
        seg = type("S", (), dict(start=0, end=2, text=" Thank you for watching!", avg_logprob=-0.2, no_speech_prob=0.1, compression_ratio=1.1))()
        self.assertTrue(S.HALLUCINATION.search(seg.text))

def submit_noauth():
    with open(f"{M}/english.wav", "rb") as f: return C.post("/v1/jobs", files={"file": ("e.wav", f)})

if __name__ == "__main__": unittest.main(verbosity=2)
