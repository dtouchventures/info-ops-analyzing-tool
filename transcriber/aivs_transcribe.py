"""AIVS transcription service: private speech-to-text for AIVS, run on a server on the organisation's network.

Engine: faster-whisper (Whisper models in CTranslate2), on the CPU. Recordings arrive from the AIVS server only
(shared token + firewall), are decoded with PyAV (audio is taken from video containers directly, no ffmpeg
needed), transcribed one at a time in a background worker, and deleted as soon as the job finishes.
Nothing is sent anywhere else.

Never invents speech:
  - voice activity detection (Silero VAD) skips silence and noise, so silence yields no text;
  - Whisper's own no-speech rule drops segments that are probably not speech;
  - segments with low confidence or typical hallucination text are kept but marked "unclear" for the analyst.

API (all routes except /health need the header  Authorization: Bearer <TRANSCRIBE_TOKEN>):
  GET  /health                 engine, model, server resources, queue
  POST /v1/jobs                multipart: file, language = auto | en | sw   -> {id, duration_s}
  GET  /v1/jobs/{id}           status, progress, result when done
  DELETE /v1/jobs/{id}         forget a finished job
"""
import hmac, math, os, re, shutil, tempfile, threading, time, uuid, queue
from typing import Optional

import av
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

VERSION = "1.0.0"
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
THREADS = int(os.environ.get("WHISPER_THREADS", "0")) or max(1, (os.cpu_count() or 2) - 1)
BEAM = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
MAX_MB = int(os.environ.get("TRANSCRIBE_MAX_MB", "500"))
MAX_MIN = int(os.environ.get("TRANSCRIBE_MAX_MINUTES", "120"))
TOKEN = os.environ.get("TRANSCRIBE_TOKEN", "")
WORK = os.environ.get("TRANSCRIBE_WORK_DIR", tempfile.gettempdir())
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR") or None
LANGS = {"en": "English", "sw": "Kiswahili"}
# phrases Whisper is known to produce from silence, music or noise (subtitle credits, video outros)
HALLUCINATION = re.compile(r"(thank(s| you) for watching|subscribe to (my|the|our) channel|subtitles? (by|created)|amara\.org|transcribed by|please like and subscribe|asante kwa kutazama|tafadhali (jiunge|subscribe))", re.I)

app = FastAPI(title="AIVS transcription", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
jobs: dict = {}
work_q: "queue.Queue[str]" = queue.Queue()
lock = threading.Lock()
_engine = {"model": None, "error": None, "loaded_at": None, "speed": None}


def make_model():
    if os.environ.get("TRANSCRIBE_FAKE_ENGINE") == "1":   # tests only: a scripted recogniser
        from fake_engine import FakeModel
        return FakeModel()
    from faster_whisper import WhisperModel
    return WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE, cpu_threads=THREADS, download_root=MODEL_DIR)


def model():
    if _engine["model"] is None:
        with lock:
            if _engine["model"] is None:
                try:
                    _engine["model"] = make_model(); _engine["loaded_at"] = time.time(); _engine["error"] = None
                except Exception as e:  # noqa: BLE001 - reported to the caller
                    _engine["error"] = f"{type(e).__name__}: {e}"
                    raise
    return _engine["model"]


def auth(authorization: Optional[str]):
    if not TOKEN:
        raise HTTPException(503, "The service has no TRANSCRIBE_TOKEN set. Set one in /etc/aivs-transcribe.env and restart.")
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given.encode(), TOKEN.encode()):
        raise HTTPException(401, "Missing or wrong token.")


def mem():
    try:
        with open("/proc/meminfo") as f:
            info = dict(line.split(":", 1) for line in f)
        kb = lambda k: int(info[k].strip().split()[0]) / 1048576
        return round(kb("MemTotal"), 1), round(kb("MemAvailable"), 1)
    except Exception:  # noqa: BLE001
        return None, None


def probe(path: str):
    """Return the duration in seconds of the first audio stream, or raise with a clear reason."""
    try:
        c = av.open(path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(415, f"This file is not an audio or video recording that can be read ({type(e).__name__}).")
    with c:
        a = [s for s in c.streams if s.type == "audio"]
        if not a:
            raise HTTPException(422, "This file has no audio track, so there is no speech to transcribe.")
        s = a[0]
        d = None
        if s.duration is not None and s.time_base:
            d = float(s.duration * s.time_base)
        if not d and c.duration:
            d = c.duration / 1_000_000
        if not d:   # some formats carry no duration: count it
            d = 0.0
            for f in c.decode(s):
                if f.time is not None:
                    d = max(d, float(f.time) + (f.samples / (f.sample_rate or 16000)))
        return round(d, 2), s.codec_context.name, s.rate


@app.get("/health")
def health():
    total, avail = mem()
    ok, err = True, None
    try:
        model()
    except Exception:  # noqa: BLE001
        ok, err = False, _engine["error"]
    return {"ok": ok and bool(TOKEN), "error": err if err else (None if TOKEN else "TRANSCRIBE_TOKEN is not set"), "engine": "faster-whisper", "version": VERSION,
            "model": MODEL_NAME, "compute_type": COMPUTE, "device": "cpu", "cpu_threads": THREADS, "cpu_count": os.cpu_count(),
            "ram_total_gb": total, "ram_available_gb": avail, "max_mb": MAX_MB, "max_minutes": MAX_MIN, "languages": LANGS,
            "queued": work_q.qsize(), "running": sum(1 for j in jobs.values() if j["status"] == "running"), "speed_x_realtime": _engine["speed"]}


@app.post("/v1/jobs")
async def create_job(file: UploadFile = File(...), language: str = Form("auto"), authorization: Optional[str] = Header(None)):
    auth(authorization)
    if language not in ("auto", "en", "sw"):
        raise HTTPException(400, "language must be auto, en or sw.")
    os.makedirs(WORK, exist_ok=True)
    jid = uuid.uuid4().hex
    path = os.path.join(WORK, f"aivs-{jid}.bin")
    size = 0
    with open(path, "wb") as out:
        while True:
            chunk = await file.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_MB * 1048576:
                out.close(); os.remove(path)
                raise HTTPException(413, f"The recording is larger than {MAX_MB} MB.")
            out.write(chunk)
    try:
        duration, codec, rate = probe(path)
    except HTTPException:
        os.remove(path); raise
    if duration > MAX_MIN * 60:
        os.remove(path)
        raise HTTPException(413, f"The recording lasts {duration / 60:.0f} minutes; the limit is {MAX_MIN} minutes. Cut it into parts.")
    jobs[jid] = {"id": jid, "status": "queued", "progress": 0.0, "language_requested": language, "duration_s": duration, "codec": codec, "sample_rate": rate,
                 "created_at": time.time(), "path": path, "result": None, "error": None}
    work_q.put(jid)
    return JSONResponse({"id": jid, "status": "queued", "duration_s": duration, "position": work_q.qsize()}, status_code=202)


@app.get("/v1/jobs/{jid}")
def get_job(jid: str, authorization: Optional[str] = Header(None)):
    auth(authorization)
    j = jobs.get(jid)
    if not j:
        raise HTTPException(404, "No such job. The transcription service may have restarted; start the transcription again.")
    return {k: v for k, v in j.items() if k != "path"}


@app.delete("/v1/jobs/{jid}")
def delete_job(jid: str, authorization: Optional[str] = Header(None)):
    auth(authorization)
    j = jobs.pop(jid, None)
    if j and j.get("path") and os.path.exists(j["path"]):
        os.remove(j["path"])
    return {"ok": True}


def pick_language(m, path, requested):
    """Detected language among English and Kiswahili (the languages AIVS supports), with the evidence for it."""
    if requested in LANGS:
        return requested, None, "chosen by the analyst"
    lang, prob, allp = m.detect_language(audio=path) if hasattr(m, "detect_language") else (None, None, None)
    probs = dict(allp or [])
    if lang in LANGS:
        return lang, prob, f"detected automatically ({prob:.0%} likely)"
    en, sw = probs.get("en", 0), probs.get("sw", 0)
    best = "sw" if sw >= en else "en"
    return best, probs.get(best), f"detected language “{lang}” is not supported; used {LANGS[best]} (the more likely of the two supported languages, {probs.get(best, 0):.0%}). Choose the language manually if this is wrong."


def run(jid):
    j = jobs[jid]; j["status"] = "running"; j["started_at"] = time.time()
    try:
        m = model()
        lang, prob, basis = pick_language(m, j["path"], j["language_requested"])
        segs, info = m.transcribe(j["path"], language=lang, task="transcribe", beam_size=BEAM, vad_filter=True,
                                  vad_parameters={"min_silence_duration_ms": 500}, condition_on_previous_text=False,
                                  temperature=[0.0, 0.2, 0.4], compression_ratio_threshold=2.4, log_prob_threshold=-1.0, no_speech_threshold=0.6)
        out, dropped = [], 0
        total = max(0.1, j["duration_s"] or getattr(info, "duration", 0) or 0.1)
        for s in segs:
            text = (s.text or "").strip()
            j["progress"] = round(min(0.99, s.end / total), 3)
            if not text:
                continue
            if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:     # Whisper's own rule: probably not speech
                dropped += 1; continue
            conf = round(math.exp(s.avg_logprob), 3)
            reasons = []
            if s.avg_logprob < -0.8: reasons.append("low confidence")
            if s.no_speech_prob > 0.5: reasons.append("may not be speech")
            if s.compression_ratio > 2.2: reasons.append("repetitive text")
            if HALLUCINATION.search(text): reasons.append("typical text produced from noise")
            out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text, "confidence": conf, "no_speech_prob": round(s.no_speech_prob, 3),
                        "unclear": bool(reasons), "reasons": reasons})
        took = time.time() - j["started_at"]
        _engine["speed"] = round(total / took, 2) if took > 0 else None
        j["result"] = {"language": lang, "language_name": LANGS.get(lang, lang), "language_probability": round(prob, 3) if prob is not None else None, "language_basis": basis,
                       "engine": "faster-whisper", "model": MODEL_NAME, "compute_type": COMPUTE, "segments": out, "dropped_non_speech": dropped,
                       "speech_found": bool(out), "processing_s": round(took, 1), "speed_x_realtime": _engine["speed"],
                       "vad_speech_s": round(getattr(info, "duration_after_vad", 0) or 0, 2)}
        j["status"] = "done"; j["progress"] = 1.0
    except Exception as e:  # noqa: BLE001 - reported to AIVS
        j["status"] = "failed"; j["error"] = f"{type(e).__name__}: {e}"[:500]
    finally:
        j["finished_at"] = time.time()
        if os.path.exists(j["path"]):
            os.remove(j["path"])        # the recording is not kept on this server


def worker():
    while True:
        jid = work_q.get()
        if jid in jobs:
            run(jid)
        # forget results nobody collected within a day
        for k, v in list(jobs.items()):
            if v["status"] in ("done", "failed") and time.time() - v.get("finished_at", time.time()) > 86400:
                jobs.pop(k, None)


threading.Thread(target=worker, daemon=True).start()
