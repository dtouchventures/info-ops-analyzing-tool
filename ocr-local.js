// ---------------------------------------------------------------- offline OCR (no-install edition)
// Tesseract.js 5.1.1, its WebAssembly core and the English and Kiswahili language data are embedded in
// this file, so text can be read from images with no server and no internet. Everything runs in this browser.
const LOCALOCR = (() => {
  const A = { lib: "__B64_LIB__", worker: "__B64_WORKER__", core: "__B64_CORE__", eng: "__B64_ENG__", swa: "__B64_SWA__" };
  const bytes = k => { const s = atob(A[k]), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const urlOf = k => URL.createObjectURL(new Blob([bytes(k)], { type: "text/javascript" }));
  let libP = null; const workers = new Map();
  const lib = () => (libP ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = urlOf("lib"); s.onload = ok; s.onerror = () => { libP = null; no(new Error("The offline text reader could not start in this browser.")); }; document.head.appendChild(s); }));
  async function read(url, lang, onProgress) {
    if (!/^(eng|swa|eng\+swa)$/.test(lang)) throw new Error("Choose English, Kiswahili or both.");
    await lib();
    if (!workers.has(lang)) {
      const start = window.Tesseract.createWorker(lang.split("+").map(code => ({ code, data: bytes(code) })), 1, {
        // a page opened from a file cannot share blob URLs with its workers, so the WebAssembly core and the
        // worker code go into one worker script (the worker skips importScripts when TesseractCore already exists)
        workerPath: URL.createObjectURL(new Blob([bytes("core"), "\n;\n", bytes("worker")], { type: "text/javascript" })), corePath: "embedded", workerBlobURL: false, cacheMethod: "none", gzip: true,
        logger: m => m.status === "recognizing text" && onProgress?.(m.progress), errorHandler: e => console.warn("OCR worker:", e)
      });
      const w = await Promise.race([start, new Promise((_, no) => setTimeout(() => no(new Error("The offline text reader did not start within 90 seconds. Close other heavy tabs and try again, or type the text in.")), 90000))])
        .catch(e => { throw new Error(String(e?.message || e).startsWith("The offline") ? e.message : `The offline text reader could not start: ${e?.message || e}`); });
      workers.set(lang, w);
    }
    const r = await Promise.race([workers.get(lang).recognize(url), new Promise((_, no) => setTimeout(() => no(new Error("Reading the text took more than 3 minutes and was stopped. Try a smaller image or type the text in.")), 180000))]);
    return { text: r.data.text.trim(), confidence: r.data.confidence, engine: `Tesseract.js 5.1.1 (offline, in this browser; ${lang})` };
  }
  return { read };
})();
