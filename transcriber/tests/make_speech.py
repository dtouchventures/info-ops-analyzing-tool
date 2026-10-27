"""Make spoken test recordings with espeak-ng (offline): English, Kiswahili, silence, a video with sound, a video
without sound, and invalid files. Used by the tests and by selftest.py on the server."""
import ctypes, os, struct, subprocess, sys, wave

def synth(text, voice, path):
    try:
        import espeakng_loader as E
        lib = ctypes.CDLL(E.get_library_path()); data = os.path.dirname(E.get_data_path())
    except ImportError:
        lib = ctypes.CDLL("libespeak-ng.so.1"); data = None
    CB = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)
    buf = []
    def cb(wav, n, ev):
        if wav and n > 0: buf.extend(wav[i] for i in range(n))
        return 0
    keep = CB(cb)
    rate = lib.espeak_Initialize(2, 500, data.encode() if data else None, 0)
    lib.espeak_SetSynthCallback(keep)
    if lib.espeak_SetVoiceByName(voice.encode()) != 0: raise RuntimeError(f"voice {voice} not available")
    lib.espeak_SetParameter(1, 140, 0)   # rate (words per minute)
    t = text.encode("utf-8")
    lib.espeak_Synth(t, len(t) + 1, 0, 0, 0, 1, None, None); lib.espeak_Synchronize()
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        pad = [0] * int(rate * 0.6)
        w.writeframes(struct.pack(f"<{len(pad)*2+len(buf)}h", *pad, *buf, *pad))
    return path

EN = "The county government says the main road to Garissa will be closed for repairs from Monday. Motorists should use the bypass."
SW = "Serikali ya kaunti inasema barabara kuu ya Garissa itafungwa kwa ukarabati kuanzia Jumatatu. Madereva watumie njia mbadala."

def make_all(d):
    os.makedirs(d, exist_ok=True)
    synth(EN, "en", f"{d}/english.wav"); synth(SW, "sw", f"{d}/kiswahili.wav")
    ff = lambda *a: subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *a], check=True)
    ff("-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "8", f"{d}/silence.wav")
    ff("-f", "lavfi", "-i", "color=c=navy:s=320x240:d=9", "-i", f"{d}/english.wav", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f"{d}/video.mp4")
    ff("-f", "lavfi", "-i", "color=c=gray:s=320x240:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", f"{d}/video-no-sound.mp4")
    ff("-i", f"{d}/kiswahili.wav", "-c:a", "libmp3lame", "-b:a", "64k", f"{d}/kiswahili.mp3")
    open(f"{d}/not-audio.mp3", "wb").write(b"This is a text file renamed to .mp3\n" * 20)
    return d

if __name__ == "__main__":
    print(make_all(sys.argv[1] if len(sys.argv) > 1 else "testmedia"))
