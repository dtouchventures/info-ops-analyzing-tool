// Identify file type from its first bytes. The browser-supplied MIME type is never trusted.
export function sniff(b) {
  const h = (o, ...bytes) => bytes.every((x, i) => b[o + i] === x);
  const s = (o, str) => b.toString("latin1", o, o + str.length) === str;
  if (h(0, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", kind: "image", ext: "jpg" };
  if (h(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", kind: "image", ext: "png" };
  if (s(0, "RIFF") && s(8, "WEBP")) return { mime: "image/webp", kind: "image", ext: "webp" };
  if (s(0, "GIF87a") || s(0, "GIF89a")) return { mime: "image/gif", kind: "image", ext: "gif" };
  if (s(4, "ftyp")) {
    const brand = b.toString("latin1", 8, 12);
    if (/^(heic|heix|hevc|mif1|msf1)/.test(brand)) return { mime: "image/heic", kind: "image", ext: "heic" };
    if (/^qt/.test(brand)) return { mime: "video/quicktime", kind: "video", ext: "mov" };
    return { mime: "video/mp4", kind: "video", ext: "mp4" };
  }
  if (h(0, 0x1a, 0x45, 0xdf, 0xa3)) return { mime: "video/webm", kind: "video", ext: "webm" };
  if (s(0, "%PDF-")) return { mime: "application/pdf", kind: "document", ext: "pdf" };
  if (h(0, 0x50, 0x4b, 0x03, 0x04)) return { mime: "application/zip", kind: "document", ext: "docx" };   // confirmed as Word by the document reader
  return null;
}
