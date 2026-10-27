// Image and media verification for automatic investigations (AIVS 1.24). Works on the images kept with the case
// (uploaded, or retrieved from the submitted link) after AIVS's case analysis has run, and reports OBSERVATIONS:
//   - text inside the image (OCR) and whether it matches a claim
//   - matches with the reference archive and earlier cases (AIVS's perceptual hashing): possible reuse of an old image
//   - embedded metadata: editing software, capture time earlier than the claim
//   - optional reverse-image search (Google Cloud Vision web detection, GOOGLE_VISION_API_KEY)
//   - optional AI image description (a vision model on your own Ollama server, INVESTIGATE_VISION_MODEL)
// Nothing here declares an image manipulated or AI-generated. Indicators are labelled as possible and say what would be
// needed to confirm them. Only archive or metadata dates well before the claim count as a "possible reuse" signal.
import fs from "node:fs";
import { similarities } from "./autoeval.js";
import { isLocalHost } from "./ollama.js";

const EDITORS = /photoshop|gimp|lightroom|snapseed|picsart|facetune|canva|pixlr|affinity|paint\.net|faceapp|remini|meitu|vsco|capcut/i;
const DAY = 864e5;

export function makeMediaCheck(db, { config, storage, audit }) {
  const V = { visionKey: "", visionBase: "https://vision.googleapis.com", timeoutMs: 15000, ...(config.mediaCheck || {}) };
  const vision = { model: config.investigate?.visionModel || "", base: String(config.investigate?.visionBase || config.ai?.baseUrl || config.ollama?.url || "").replace(/\/+$/, "").replace(/\/(v1|api)$/, "") };
  const status = () => ({
    reverse_search: V.visionKey ? { configured: true, service: "Google Cloud Vision web detection" } : { configured: false, needs: "GOOGLE_VISION_API_KEY (Google Cloud Vision API with web detection; the image is sent to Google)" },
    ai_vision: vision.model && vision.base && isLocalHost(safeHost(vision.base)) ? { configured: true, model: vision.model } : { configured: false, needs: "INVESTIGATE_VISION_MODEL: a vision model installed on your own Ollama server (for example qwen2.5vl or llava)" }
  });
  const safeHost = u => { try { return new URL(u).hostname; } catch { return ""; } };

  async function post(url, body, timeoutMs) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(`HTTP ${r.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 120)}` : ""}`); return j; }
    catch (e) { if (e.name === "AbortError") throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`); throw e; } finally { clearTimeout(t); }
  }
  async function reverseSearch(buf) {
    const j = await post(`${V.visionBase}/v1/images:annotate?key=${encodeURIComponent(V.visionKey)}`, { requests: [{ image: { content: buf.toString("base64") }, features: [{ type: "WEB_DETECTION", maxResults: 10 }] }] }, V.timeoutMs);
    const w = j?.responses?.[0]?.webDetection || {}, http = u => /^https?:\/\//i.test(String(u || ""));
    return { pages: (w.pagesWithMatchingImages || []).filter(p => http(p.url)).slice(0, 8).map(p => ({ url: p.url, title: String(p.pageTitle || "").replace(/<[^>]+>/g, "").slice(0, 200), full_match: !!p.fullMatchingImages?.length })),
      full_matches: (w.fullMatchingImages || []).length, partial_matches: (w.partialMatchingImages || []).length, labels: (w.bestGuessLabels || []).map(l => l.label).filter(Boolean).slice(0, 3) };
  }
  async function describe(buf, claims) {
    const prompt = `Describe only what is visible in this image in 2-3 sentences (people, objects, place features, visible text). Then say whether the image is consistent with these claims, using only what is visible: ${claims.map(c => `claim ${c.seq}: ${String(c.text).replace(/<\/?content/gi, "")}`).join("; ").slice(0, 1500)}. Do not guess dates, places or identities that cannot be seen. Do not say whether the image is real, edited or AI-generated.\nJSON: {"description": "...", "consistent": "yes|no|unclear", "reason": "..."}`;
    const j = await post(`${vision.base}/api/chat`, { model: vision.model, stream: false, format: "json", options: { temperature: 0 }, messages: [{ role: "user", content: prompt, images: [buf.toString("base64")] }] }, Math.max(15000, config.ai?.timeoutMs || 90000));
    const o = JSON.parse(String(j?.message?.content || "").replace(/^```(?:json)?|```$/g, "").trim());
    return { description: String(o.description || "").slice(0, 600), consistent: ["yes", "no", "unclear"].includes(o.consistent) ? o.consistent : "unclear", reason: String(o.reason || "").slice(0, 300), model: vision.model };
  }

  // claimDate: when the content says it was published (or received); images[i].link = { url, source } for images from the link
  async function analyse({ user, caseId, claims, claimDate, links = {}, budgetMs = 60000, check = () => {} }) {
    const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
    const media = db.prepare("SELECT * FROM media WHERE case_id = ? AND kind = 'image' AND parent_media_id IS NULL ORDER BY uploaded_at, id").all(caseId);
    const cd = claimDate ? Date.parse(claimDate) : NaN, st = status(), out = [];
    for (const m of media) {
      check();
      const img = { media_id: m.id, name: m.original_name, width: m.width, height: m.height, sha256: m.sha256, link: links[m.id] || null, observations: [], ocr: null, archive: [], reverse: null, ai: null };
      const ocr = db.prepare("SELECT * FROM ocr_texts WHERE media_id = ? ORDER BY id DESC").get(m.id);
      if (ocr?.current_text || ocr?.text) {
        const t = String(ocr.current_text || ocr.original_text).trim(), sims = similarities(t, claims.map(c => c.text)), best = sims.length ? sims.indexOf(Math.max(...sims)) : -1;
        img.ocr = { text: t.slice(0, 1500), confidence: ocr.confidence ?? null, matches_claim: best >= 0 && sims[best] >= 0.3 ? claims[best].seq : null, similarity: best >= 0 ? sims[best] : null };
        img.observations.push({ kind: "text", strength: "observed", text: img.ocr.matches_claim ? `The text in the image repeats claim ${img.ocr.matches_claim}.` : t.length > 15 ? "The image contains text that does not repeat any of the claims." : "Little or no text was read in the image." });
      }
      for (const x of db.prepare("SELECT x.*, a.documented_date, a.title AS archive_title, a.record_type, c.title AS case_title, c.created_at AS case_created FROM matches x LEFT JOIN archive_records a ON a.id = x.target_archive_id LEFT JOIN cases c ON c.id = x.target_case_id WHERE x.case_id = ? AND x.media_id = ?").all(caseId, m.id)) {
        const when = x.target_archive_id ? x.documented_date : x.case_created, days = when && !isNaN(cd) ? Math.round((cd - Date.parse(when)) / DAY) : null;
        const rec = { kind: x.kind, level: x.level, archive_id: x.target_archive_id, case_id: x.target_case_id, title: x.archive_title || x.case_title, date: when, days_before_claim: days, record_type: x.record_type || null };
        img.archive.push(rec);
        const strong = x.level === "identical" || x.level === "strong";
        if (x.target_archive_id && (x.record_type === "misleading" || (days != null && days > 30)) && strong)
          img.observations.push({ kind: "reuse", strength: "strong", text: `Possible reuse of an old image: it ${x.level === "identical" ? "is identical to" : "closely matches"} archive record ${x.target_archive_id} (“${rec.title}”), documented ${String(when).slice(0, 10)}${days != null ? `, ${days} days before the claim` : ""}${x.record_type === "misleading" ? ", already assessed as used misleadingly" : ""}.` });
        else if (x.target_archive_id) img.observations.push({ kind: "archive", strength: strong ? "moderate" : "weak", text: `${strong ? "Matches" : "Possibly resembles"} archive record ${x.target_archive_id} (“${rec.title}”, documented ${String(when).slice(0, 10)}).${x.kind === "perceptual" && x.level !== "identical" ? " The copies are not identical: the image may have been cropped, re-encoded or edited; compare them side by side." : ""}` });
        else if (x.target_case_id) img.observations.push({ kind: "earlier_case", strength: "weak", text: `The same or a similar image was received before, in case ${x.target_case_id} (“${rec.title}”).` });
      }
      const meta = JSON.parse(m.metadata_json || "{}"), soft = Object.entries(meta).find(([k, v]) => /software|creator ?tool|processing/i.test(k) && EDITORS.test(String(v)));
      if (soft) img.observations.push({ kind: "metadata", strength: "weak", text: `The image's metadata names editing software (${soft[0]} = ${String(soft[1]).slice(0, 60)}). Editing software is used for ordinary cropping too; this alone does not show manipulation.` });
      if (m.meta_capture_at && !isNaN(cd) && cd - Date.parse(m.meta_capture_at) > 30 * DAY) img.observations.push({ kind: "metadata_date", strength: "weak", text: `The metadata capture time (${String(m.meta_capture_at).slice(0, 10)}) is ${Math.round((cd - Date.parse(m.meta_capture_at)) / DAY)} days before the claim. Metadata can be wrong or copied; confirm by other means.` });
      if (!Object.keys(meta).length) img.observations.push({ kind: "metadata", strength: "observed", text: "No embedded metadata (normal for images taken from websites and social media); nothing follows from its absence." });
      if (m.width && m.height && m.width * m.height < 200 * 200) img.observations.push({ kind: "quality", strength: "observed", text: `The image is small (${m.width}×${m.height}), so visual checks are limited.` });
      let buf = null; try { buf = fs.readFileSync(storage.pathOf(m.sha256)); } catch {}
      if (buf && st.reverse_search.configured && left() > 5000) {
        try {
          audit(user, "Image sent to reverse-image search (automatic investigation)", "case", caseId, { media: m.id, service: "Google Cloud Vision", sha256: m.sha256 });
          img.reverse = await reverseSearch(buf);
          img.observations.push({ kind: "reverse", strength: "observed", text: img.reverse.pages.length ? `Reverse-image search found the image on ${img.reverse.pages.length} other page(s)${img.reverse.full_matches ? ` (${img.reverse.full_matches} full match(es))` : ""}. Check the earliest of them for the image's original context.` : "Reverse-image search found no other pages with this image (this does not show the image is original)." });
        } catch (e) { img.reverse = { error: e.message }; img.observations.push({ kind: "reverse", strength: "observed", text: `Reverse-image search failed (${e.message}).` }); }
      }
      if (buf && st.ai_vision.configured && left() > 15000) {
        try {
          audit(user, "Image sent to AI service (automatic investigation)", "case", caseId, { media: m.id, model: vision.model, endpoint: safeHost(vision.base) });
          img.ai = await describe(buf, claims);
          img.observations.push({ kind: "ai", strength: "ai", text: `AI description (${vision.model}, not verified): ${img.ai.description}${img.ai.consistent !== "unclear" ? ` The model judged the image ${img.ai.consistent === "yes" ? "consistent" : "not consistent"} with the claims${img.ai.reason ? `: ${img.ai.reason}` : ""}.` : ""}` });
        } catch (e) { img.ai = { error: e.message }; }
      }
      out.push(img);
    }
    const reuse = out.flatMap(i => i.observations.filter(o => o.kind === "reuse").map(o => ({ media_id: i.media_id, text: o.text })));
    return { images: out, reuse, services: st, note: out.length ? "AIVS reports observations about images; it does not decide that an image is manipulated or AI-generated." : "No image was available for this investigation." };
  }
  return { analyse, status };
}
