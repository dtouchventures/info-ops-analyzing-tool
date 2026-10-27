// Local OCR with Tesseract.js, served from this AIVS server (no CDN). English and Kiswahili.
let loading = null; const workers = new Map();
function loadScript() {
  if (window.Tesseract) return Promise.resolve();
  return loading ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = "/vendor/tesseract/tesseract.min.js"; s.onload = ok; s.onerror = () => no(new Error("The OCR engine could not be loaded from the server.")); document.head.appendChild(s); });
}
const progress = new Map();   // the current caller's progress handler per worker (workers are reused)
export async function recognise(url, lang, onProgress) {
  await loadScript();
  if (!workers.has(lang)) workers.set(lang, await window.Tesseract.createWorker(lang, 1, {
    workerPath: "/vendor/tesseract/worker.min.js", corePath: "/vendor/tesseract-core", langPath: "/vendor/tessdata", gzip: true, workerBlobURL: false,
    logger: m => { if (m.status === "recognizing text") try { progress.get(lang)?.(m.progress); } catch {} }
  }));
  progress.set(lang, onProgress);
  let r; try { r = await workers.get(lang).recognize(url); } finally { progress.delete(lang); }
  return { text: r.data.text.trim(), confidence: r.data.confidence, engine: "Tesseract.js 5.1.1 (local)" };
}
