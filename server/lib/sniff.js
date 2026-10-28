// Identify file type from its first bytes. The browser-supplied MIME type is never trusted.
export function sniff(b) {
  const h = (o, ...bytes) => bytes.every((x, i) => b[o + i] === x);
  const s = (o, str) => b.toString("latin1", o, o + str.length) === str;
  if (h(0, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", kind: "image", ext: "jpg" };
  if (h(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", kind: "image", ext: "png" };
  if (s(0, "RIFF") && s(8, "WEBP")) return { mime: "image/webp", kind: "image", ext: "webp" };
  if (s(0, "GIF87a") || s(0, "GIF89a")) return { mime: "image/gif", kind: "image", ext: "gif" };
  if (h(0, 0x49, 0x49, 0x2a, 0x00) || h(0, 0x4d, 0x4d, 0x00, 0x2a)) return { mime: "image/tiff", kind: "image", ext: "tiff" };
  // audio recordings (voice notes, calls, broadcasts)
  if (s(0, "RIFF") && s(8, "AVI ")) return { mime: "video/x-msvideo", kind: "video", ext: "avi" };   // AVI (1.35)
  if (s(0, "RIFF") && s(8, "WAVE")) return { mime: "audio/wav", kind: "audio", ext: "wav" };
  if (s(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return { mime: "audio/mpeg", kind: "audio", ext: "mp3" };   // MP3 (ID3 tag or MPEG audio frame)
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { mime: "audio/aac", kind: "audio", ext: "aac" };                    // AAC in ADTS frames
  if (s(0, "OggS")) return { mime: "audio/ogg", kind: "audio", ext: b.includes(Buffer.from("OpusHead")) ? "opus" : "ogg" };  // WhatsApp voice notes are Ogg Opus
  if (s(0, "fLaC")) return { mime: "audio/flac", kind: "audio", ext: "flac" };
  if (s(0, "#!AMR")) return { mime: "audio/amr", kind: "audio", ext: "amr" };
  if (s(4, "ftyp")) {
    const brand = b.toString("latin1", 8, 12);
    if (/^(M4A |M4B |F4A )/.test(brand)) return { mime: "audio/mp4", kind: "audio", ext: "m4a" };
    if (/^3g/.test(brand)) return { mime: "video/3gpp", kind: "video", ext: "3gp" };
    if (/^(avif|avis)/.test(brand)) return { mime: "image/avif", kind: "image", ext: "avif" };
    if (/^(heic|heix|hevc|mif1|msf1)/.test(brand)) return { mime: "image/heic", kind: "image", ext: "heic" };
    if (/^qt/.test(brand)) return { mime: "video/quicktime", kind: "video", ext: "mov" };
    return { mime: "video/mp4", kind: "video", ext: "mp4" };
  }
  if (h(0, 0x1a, 0x45, 0xdf, 0xa3)) return { mime: "video/webm", kind: "video", ext: "webm" };
  if (s(0, "%PDF-")) return { mime: "application/pdf", kind: "document", ext: "pdf" };
  if (h(0, 0x50, 0x4b, 0x03, 0x04)) return { mime: "application/zip", kind: "document", ext: "docx" };   // confirmed as Word by the document reader
  return null;
}
