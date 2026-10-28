// Ingest pipeline: sniff type → store original unchanged (SHA-256 addressed) → read dimensions and
// embedded metadata → compute perceptual hashes (images) / archive windows (archive images).
import fs from "node:fs";
import exifr from "exifr";
import sharp from "sharp";
import { sniff } from "./sniff.js";
import { submissionHashes, archiveWindows } from "./hashing.js";
import { nowISO, nextId } from "./db.js";
import { HttpError } from "./auth.js";
import { extractDocument, isTextName } from "./docs.js";

const META_FIELDS = ["Make", "Model", "Software", "DateTimeOriginal", "CreateDate", "ModifyDate", "OffsetTimeOriginal", "Artist", "Copyright", "ImageDescription", "CreatorTool", "GPSLatitude", "GPSLongitude", "GPSLatitudeRef", "GPSLongitudeRef", "LensModel", "HostComputer"];
export async function readMetadata(file) {
  try {
    const m = await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: true, iptc: false, icc: false, reviveValues: false, translateValues: false, mergeOutput: true });
    if (!m) return {};
    const out = {};
    for (const k of META_FIELDS) if (m[k] !== undefined && m[k] !== null && String(m[k]).trim() !== "") out[k] = Array.isArray(m[k]) ? m[k].join(", ") : String(m[k]).trim().slice(0, 300);
    return out;
  } catch { return {}; }
}
// "2026:10:15 05:58:12" -> "2026-10-15T05:58:12" (no time zone is implied; EXIF usually has none)
export const exifDateToIso = s => { const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || ""); return m && m[1] !== "0000" ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null; };

export function makeMedia(db, storage) {
  const ins = db.prepare(`INSERT INTO media(id,case_id,archive_id,sha256,original_name,mime,kind,size,width,height,parent_media_id,frame_time,frame_origin,metadata_json,meta_capture_at,dhash,phash,dhash_m,phash_m,is_training,uploaded_by,uploaded_at,thumb_sha256)
    VALUES (@id,@case_id,@archive_id,@sha256,@original_name,@mime,@kind,@size,@width,@height,@parent_media_id,@frame_time,@frame_origin,@metadata_json,@meta_capture_at,@dhash,@phash,@dhash_m,@phash_m,@is_training,@uploaded_by,@uploaded_at,@thumb_sha256)`);
  const insWin = db.prepare("INSERT INTO archive_windows(media_id,label,x,y,w,h,dhash,phash) VALUES (?,?,?,?,?,?,?,?)");

  // tmpFile: path of uploaded file. Returns the media row.
  async function ingest(tmpFile, { name, caseId = null, archiveId = null, isTraining = 0, user, parent = null, frameTime = null, frameOrigin = null }) {
    const fd = fs.openSync(tmpFile, "r"), head = Buffer.alloc(64); fs.readSync(fd, head, 0, 64, 0); fs.closeSync(fd);
    let t = sniff(head);
    if (!t && isTextName(name)) t = { mime: "text/plain", kind: "document", ext: "txt" };
    if (!t) { fs.rmSync(tmpFile, { force: true }); throw new HttpError(415, `${name}: unsupported file type. Use images (JPEG, PNG, WebP, GIF, HEIC), video (MP4, MOV, AVI, WebM, 3GP), audio (MP3, WAV, M4A, AAC, OGG/Opus voice notes, FLAC, AMR) or documents (PDF, Word .docx, TXT, CSV, JSON).`); }
    if (archiveId && t.kind !== "image") { fs.rmSync(tmpFile, { force: true }); throw new HttpError(415, "Archive records need an image (for a video, capture a frame first)."); }
    const size = fs.statSync(tmpFile).size;
    let width = null, height = null, meta = {}, hashes = {};
    let doc = null;
    if (t.kind === "document") {
      if (caseId == null) { fs.rmSync(tmpFile, { force: true }); throw new HttpError(415, "Documents can be added to cases only."); }
      try { doc = await extractDocument(fs.readFileSync(tmpFile), name); }
      catch (e) {
        // keep a PDF even when its text cannot be read here (it is evidence); refuse only wrong or protected files
        if (t.ext === "pdf" && !/password/i.test(e.message)) doc = { type: "pdf", mime: "application/pdf", ext: "pdf", extractor: "none (text not readable on the server)", text: "", pages: null, meta: {}, created: null, truncated: false,
          warnings: [`The text could not be read on the server (${String(e.message).slice(0, 200)}). The original is kept unchanged. Use “Read text from pages (OCR)” to read it in your browser.`] };
        else { fs.rmSync(tmpFile, { force: true }); throw new HttpError(e.status || 422, `${name}: ${e.message}`); }
      }
      t = { ...t, mime: doc.mime, ext: doc.ext }; meta = doc.meta;
    }
    if (t.kind === "image") {
      try {
        const md = await sharp(tmpFile, { failOn: "none" }).metadata();
        width = md.width; height = md.height;
        if (md.orientation >= 5) [width, height] = [height, width];
      } catch { fs.rmSync(tmpFile, { force: true }); throw new HttpError(422, `${name}: the image could not be decoded. It may be damaged.`); }
      meta = await readMetadata(tmpFile);
      hashes = await submissionHashes(tmpFile);
    }
    const buf = t.kind === "image" ? fs.readFileSync(tmpFile) : null;
    let thumb = null;
    if (buf) { try { thumb = (await storage.putBuffer(await sharp(buf, { failOn: "none" }).rotate().resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer(), "image/jpeg")).sha256; } catch { thumb = null; } }
    const { sha256 } = await storage.putFile(tmpFile, t.mime);
    const row = {
      id: nextId(db, "media", n => `M-${String(n).padStart(6, "0")}`), case_id: caseId, archive_id: archiveId, sha256,
      original_name: String(name || `upload.${t.ext}`).replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200), mime: t.mime, kind: t.kind, size, width, height,
      parent_media_id: parent, frame_time: frameTime, frame_origin: frameOrigin,
      metadata_json: JSON.stringify(meta), meta_capture_at: doc ? (doc.created ? doc.created.slice(0, 19) : null) : exifDateToIso(meta.DateTimeOriginal || meta.CreateDate),
      dhash: hashes.dhash || null, phash: hashes.phash || null, dhash_m: hashes.dhash_m || null, phash_m: hashes.phash_m || null,
      thumb_sha256: thumb, is_training: isTraining ? 1 : 0, uploaded_by: user?.id ?? null, uploaded_at: nowISO()
    };
    ins.run(row);
    if (doc) db.prepare("INSERT INTO document_texts(media_id,extractor,pages,chars,text,truncated,warnings,extracted_at) VALUES (?,?,?,?,?,?,?,?)").run(row.id, doc.extractor, doc.pages, doc.text.length, doc.text, doc.truncated ? 1 : 0, JSON.stringify(doc.warnings), nowISO());
    if (archiveId && buf) for (const w of await archiveWindows(buf)) insWin.run(row.id, w.label, w.x, w.y, w.w, w.h, w.d, w.p);
    return row;
  }
  return { ingest };
}
