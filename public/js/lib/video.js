// Frame capture in the browser from a stored case video. Frames are uploaded as new images that point
// back to the video with their exact timestamp; the original video file is never altered.
import { api } from "../api.js";
const seek = (v, t) => new Promise((ok, no) => { const h = () => { v.removeEventListener("seeked", h); ok(); }; v.addEventListener("seeked", h); v.onerror = () => no(new Error("The video could not be decoded by this browser.")); v.currentTime = t; });
export async function openVideo(url) {
  const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = url;
  await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error("This browser cannot play this video format. Try Chrome or Edge, or convert the file to MP4 (H.264).")); });
  return v;
}
export function frameBlob(v) {
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  return new Promise(ok => c.toBlob(ok, "image/png"));
}
export async function uploadFrame(mediaId, blob, time, origin) {
  const fd = new FormData(); fd.append("frame", blob, `frame-${time.toFixed(2)}.png`); fd.append("time", String(time)); fd.append("origin", origin);
  return api.upload(`/api/media/${mediaId}/frames`, fd);
}
export async function sampleFrames(mediaId, url, n = 6, onProgress) {
  const v = await openVideo(url), d = v.duration;
  if (!isFinite(d) || d <= 0) throw new Error("The video duration could not be read.");
  const count = Math.max(2, Math.min(n, Math.ceil(d)));
  for (let i = 0; i < count; i++) {
    const t = Math.min(d - 0.05, (d * (i + 0.5)) / count);
    await seek(v, t); await uploadFrame(mediaId, await frameBlob(v), t, "auto"); onProgress?.((i + 1) / count);
  }
  return count;
}
