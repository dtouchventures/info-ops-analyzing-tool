// Visual comparison aids for the analyst's eye. None of these establish authenticity or manipulation.
const loadImg = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("Image could not be loaded.")); i.src = src; });
const cache = new Map();
function draw(img, w, h, mirror, sx = 0, sy = 0, sw, sh) {
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high";
  if (mirror) { x.translate(c.width, 0); x.scale(-1, 1); }
  x.drawImage(img, sx, sy, sw ?? img.naturalWidth, sh ?? img.naturalHeight, 0, 0, c.width, c.height); return c;
}
const grey = (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, g = new Float32Array(c.width * c.height); for (let i = 0; i < g.length; i++) g[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2]; return g; };

// locate the submission inside the archive image (scale + offset search at low resolution)
function align(arch, sub, mirror, hintW) {
  const AW = 96, AH = Math.round(AW * arch.naturalHeight / arch.naturalWidth), ga = grey(draw(arch, AW, AH)), ratio = sub.naturalHeight / sub.naturalWidth;
  let best = { err: Infinity, x: 0, y: 0, w: 1, h: 1 };
  for (let w = Math.max(16, Math.floor(AW * Math.max(.4, (hintW || 1) - .25))); w <= AW; w++) {
    const h = Math.round(w * ratio); if (h > AH || h < 8) continue;
    const gs = grey(draw(sub, w, h, mirror)); let ms = 0; for (const v of gs) ms += v; ms /= gs.length;
    for (let y = 0; y <= AH - h; y++) for (let x = 0; x <= AW - w; x++) {
      let ma = 0, n = 0; for (let j = 0; j < h; j += 2) for (let i = 0; i < w; i += 2) { ma += ga[(y + j) * AW + x + i]; n++; } ma /= n;
      let e = 0; for (let j = 0; j < h; j += 2) for (let i = 0; i < w; i += 2) e += Math.abs((ga[(y + j) * AW + x + i] - ma) - (gs[j * w + i] - ms));
      e /= n; if (e < best.err) best = { err: e, x: x / AW, y: y / AH, w: w / AW, h: h / AH };
    }
  }
  return best;
}
export async function differenceMap(archUrl, subUrl, { mirrored, hintW }) {
  const key = `d|${archUrl}|${subUrl}|${mirrored}`; if (cache.has(key)) return cache.get(key);
  const [a, s] = await Promise.all([loadImg(archUrl), loadImg(subUrl)]);
  const r = align(a, s, mirrored, hintW), W = 360, H = Math.round(W * s.naturalHeight / s.naturalWidth);
  const ca = draw(a, W, H, false, r.x * a.naturalWidth, r.y * a.naturalHeight, r.w * a.naturalWidth, r.h * a.naturalHeight), cs = draw(s, W, H, mirrored);
  const blur = c => draw(draw(c, W / 4, H / 4, false, 0, 0, c.width, c.height), W, H, false, 0, 0, W / 4, H / 4);
  const ga = grey(blur(ca)), gs = grey(blur(cs)); let ma = 0, ms = 0; for (let i = 0; i < ga.length; i++) { ma += ga[i]; ms += gs[i]; } ma /= ga.length; ms /= gs.length;
  const out = draw(s, W, H, mirrored), ox = out.getContext("2d"), od = ox.getImageData(0, 0, W, H), d = od.data; let changed = 0;
  for (let i = 0; i < ga.length; i++) {
    const diff = Math.abs((ga[i] - ma) - (gs[i] - ms)), g = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2], k = Math.min(1, Math.max(0, (diff - 28) / 40));
    if (diff > 40) changed++;
    d[i * 4] = g * .45 + 230 * k; d[i * 4 + 1] = g * .45 * (1 - k) + 20 * k; d[i * 4 + 2] = g * .45 * (1 - k) + 30 * k;
  }
  ox.putImageData(od, 0, 0);
  const res = { url: out.toDataURL("image/jpeg", .88), changed: changed / ga.length, region: r }; cache.set(key, res); return res;
}
export async function errorLevel(url) {
  const key = `e|${url}`; if (cache.has(key)) return cache.get(key);
  const img = await loadImg(url), sc = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight)), W = Math.round(img.naturalWidth * sc), H = Math.round(img.naturalHeight * sc);
  const a = draw(img, W, H), re = await loadImg(a.toDataURL("image/jpeg", .9)), b = draw(re, W, H);
  const da = a.getContext("2d").getImageData(0, 0, W, H), db = b.getContext("2d").getImageData(0, 0, W, H).data, d = da.data;
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, Math.abs(d[i + k] - db[i + k]) * 18);
  a.getContext("2d").putImageData(da, 0, 0); const res = { url: a.toDataURL("image/png") }; cache.set(key, res); return res;
}
// archive image with the matched window outlined
export async function matchedRegion(archUrl, m) {
  const a = await loadImg(archUrl), sc = Math.min(1, 900 / a.naturalWidth), c = draw(a, a.naturalWidth * sc, a.naturalHeight * sc), x = c.getContext("2d");
  if (m.ww != null) {
    x.fillStyle = "rgba(7,21,40,.55)"; x.fillRect(0, 0, c.width, c.height);
    const r = [m.wx * c.width, m.wy * c.height, m.ww * c.width, m.wh * c.height];
    x.drawImage(a, m.wx * a.naturalWidth, m.wy * a.naturalHeight, m.ww * a.naturalWidth, m.wh * a.naturalHeight, ...r);
    x.strokeStyle = "#13948f"; x.lineWidth = 4; x.strokeRect(...r);
  }
  return c.toDataURL("image/jpeg", .88);
}
export function bindSlider(box) {
  const clip = box.querySelector(".clip"), inner = box.querySelector(".clip img");
  const size = () => inner.style.setProperty("--w", box.clientWidth + "px"); size(); new ResizeObserver(size).observe(box);
  const set = x => { const r = box.getBoundingClientRect(); clip.style.width = `${Math.max(0, Math.min(100, (x - r.left) / r.width * 100))}%`; };
  let drag = false;
  box.onpointerdown = e => { drag = true; box.setPointerCapture(e.pointerId); set(e.clientX); };
  box.onpointermove = e => drag && set(e.clientX); box.onpointerup = () => (drag = false);
  box.tabIndex = 0; box.onkeydown = e => { const w = parseFloat(clip.style.width || "50"); if (e.key === "ArrowLeft") clip.style.width = `${Math.max(0, w - 5)}%`; if (e.key === "ArrowRight") clip.style.width = `${Math.min(100, w + 5)}%`; };
}
