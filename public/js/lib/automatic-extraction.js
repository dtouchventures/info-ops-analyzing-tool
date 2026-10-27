import { api } from '../api.js';
import { recognise } from './ocr.js';

// Uses locally served OCR assets; file contents do not leave this server.
export async function extractAttachedText(media, languages, progress = () => {}) {
  const lang = languages.length > 1 ? 'eng+swa' : languages[0]?.code;
  if (!lang) throw new Error('OCR language data is not installed.');
  const content = `/api/media/${encodeURIComponent(media.id)}/content`;
  let result;
  if (media.kind === 'image') result = await recognise(content, lang, progress);
  else if (media.kind === 'document' && /pdf/.test(media.mime) && (!media.document?.chars || media.document?.warnings?.some(w => /scanned/i.test(w)))) {
    result = await readPdfText(content, languages, progress);
  } else return;
  await api.post(`/api/media/${encodeURIComponent(media.id)}/ocr`, { text: result.text, lang, confidence: result.confidence, engine: result.engine || 'Tesseract (local, automatic)' });
}

export async function readPdfText(source, languages, progress = () => {}) {
    const lang = languages.length > 1 ? 'eng+swa' : languages[0]?.code;
    if (!lang) throw new Error('OCR language data is not installed.');
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const input = typeof source === 'string' ? { url: source } : { data: new Uint8Array(await source.arrayBuffer()) };
    const task = pdfjs.getDocument({ ...input, isEvalSupported: false }), doc = await task.promise;
    const pages = Math.min(doc.numPages, 12), parts = []; let confidence = 0;
    try {
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i), view = page.getViewport({ scale: 1.5 }), canvas = document.createElement('canvas');
        const scale = Math.min(1, 2200 / Math.max(view.width, view.height)), viewport = page.getViewport({ scale: 1.5 * scale });
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const ocr = await recognise(blob, lang, p => progress((i - 1 + p) / pages));
        parts.push(`--- Page ${i} ---\n${ocr.text}`); confidence += ocr.confidence;
        canvas.width = canvas.height = 0;
      }
      return { text: parts.join('\n\n'), confidence: confidence / pages,
        engine: `PDF + Tesseract (local); ${pages}/${doc.numPages} pages` };
    } finally { await task.destroy(); }
}
