// Perceptual hashing (server side). Ported from the prototype's canvas implementation.
//   dHash: 9×8 greyscale, 64 horizontal gradient bits.
//   pHash: 32×32 greyscale DCT, top-left 8×8 coefficients compared with their median.
// Distances are bit counts out of 64 per hash (0–128 combined). They measure visual similarity of
// near-copies; they are NOT probabilities that two images show the same event.
import sharp from "sharp";

export const THRESH = { strong: 24, possible: 34 };
export const WINDOW_SCALES = [0.85, 0.7, 0.55];
export const BAND_SCALES = [0.75, 0.6];

const COS = (() => { const c = []; for (let u = 0; u < 8; u++) { c[u] = new Float64Array(32); for (let x = 0; x < 32; x++) c[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / 64); } return c; })();
const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
export function ham(a, b) { let n = 0; for (let i = 0; i < 16; i++) n += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)]; return n; }
const toHex = bits => bits.match(/.{4}/g).map(b => parseInt(b, 2).toString(16)).join("");

// working image: auto-oriented, longest side ≤ 640, greyscale raw
export async function workingGrey(input, { mirror = false } = {}) {
  let img = sharp(input, { failOn: "none", limitInputPixels: 100e6 }).rotate();
  if (mirror) img = img.flop();
  const { data, info } = await img.resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
async function shrink(g, x, y, w, h, tw, th) {
  const left = Math.max(0, Math.round(x)), top = Math.max(0, Math.round(y));
  const width = Math.max(1, Math.min(g.width - left, Math.round(w))), height = Math.max(1, Math.min(g.height - top, Math.round(h)));
  return sharp(g.data, { raw: { width: g.width, height: g.height, channels: 1 } })
    .extract({ left, top, width, height }).resize(tw, th, { fit: "fill", kernel: "lanczos3" }).extractChannel(0).raw().toBuffer();
}
export async function hashRegion(g, x = 0, y = 0, w = g.width, h = g.height) {
  const g9 = await shrink(g, x, y, w, h, 9, 8);
  let d = ""; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) d += g9[r * 9 + c] > g9[r * 9 + c + 1] ? "1" : "0";
  const g32 = await shrink(g, x, y, w, h, 32, 32), R = [];
  for (let u = 0; u < 8; u++) { R[u] = new Float64Array(32); for (let yy = 0; yy < 32; yy++) { let s = 0; for (let xx = 0; xx < 32; xx++) s += g32[yy * 32 + xx] * COS[u][xx]; R[u][yy] = s; } }
  const F = []; for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let s = 0; for (let yy = 0; yy < 32; yy++) s += R[u][yy] * COS[v][yy]; F.push(s); }
  const med = F.slice(1).sort((a, b) => a - b)[31];
  let p = ""; for (let i = 0; i < 64; i++) p += F[i] > med ? "1" : "0";
  return { d: toHex(d), p: toHex(p) };
}
// submission: whole image + mirror image
export async function submissionHashes(input) {
  const [g, m] = await Promise.all([workingGrey(input), workingGrey(input, { mirror: true })]);
  const [a, b] = await Promise.all([hashRegion(g), hashRegion(m)]);
  return { dhash: a.d, phash: a.p, dhash_m: b.d, phash_m: b.p, width: g.width, height: g.height };
}
// archive: whole image + 27 overlapping windows + 12 full-width/height bands (crops of archived images)
export async function archiveWindows(input) {
  const g = await workingGrey(input), W = g.width, H = g.height, out = [];
  const add = async (label, x, y, w, h) => out.push({ label, x: x / W, y: y / H, w: w / W, h: h / H, ...(await hashRegion(g, x, y, w, h)) });
  await add("full image", 0, 0, W, H);
  for (const s of WINDOW_SCALES) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const w = W * s, h = H * s;
    await add(`${Math.round(s * 100)}% crop (${["top", "middle", "bottom"][j]}-${["left", "centre", "right"][i]})`, (W - w) * i / 2, (H - h) * j / 2, w, h);
  }
  for (const s of BAND_SCALES) for (let k = 0; k < 3; k++) {
    await add(`${["top", "middle", "bottom"][k]} ${Math.round(s * 100)}% of height`, 0, (H - H * s) * k / 2, W, H * s);
    await add(`${["left", "centre", "right"][k]} ${Math.round(s * 100)}% of width`, (W - W * s) * k / 2, 0, W * s, H);
  }
  return out;
}
export const levelOf = score => score <= THRESH.strong ? "strong" : score <= THRESH.possible ? "possible" : null;
