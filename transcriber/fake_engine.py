"""Scripted recogniser used ONLY by the automated tests (TRANSCRIBE_FAKE_ENGINE=1). It runs faster-whisper's real
voice activity detection on the real decoded audio, and returns fixed text for each detected speech region, so the
service's decoding, validation, silence handling, language choice and job flow are tested without the model."""
from types import SimpleNamespace

from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

SCRIPT = {"en": "the county road will close on monday", "sw": "barabara ya kaunti itafungwa jumatatu"}


class FakeModel:
    def detect_language(self, audio):
        a = decode_audio(audio)
        lang = "sw" if len(a) / 16000 > 11 else "en"   # the test Kiswahili recording is the longer one
        probs = [(lang, 0.91), ("en" if lang == "sw" else "sw", 0.06), ("fr", 0.03)]
        return lang, 0.91, probs

    def transcribe(self, audio, language=None, vad_filter=True, vad_parameters=None, **kw):
        a = decode_audio(audio)
        regions = get_speech_timestamps(a, VadOptions(**(vad_parameters or {}))) if vad_filter else [{"start": 0, "end": len(a)}]
        segs = []
        for i, r in enumerate(regions):
            segs.append(SimpleNamespace(start=r["start"] / 16000, end=r["end"] / 16000, text=" " + SCRIPT.get(language, "?"), avg_logprob=-0.3, no_speech_prob=0.05, compression_ratio=1.3))
        info = SimpleNamespace(language=language, duration=len(a) / 16000, duration_after_vad=sum((r["end"] - r["start"]) for r in regions) / 16000)
        return iter(segs), info
