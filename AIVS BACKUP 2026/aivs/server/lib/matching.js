// Compare a case's images (and video frames) with:
//   1. identical bytes (SHA-256) anywhere in the same scope — "identical file"
//   2. the reference archive (full image + crop windows, normal and mirrored) — perceptual similarity
//   3. media in other cases — "seen before"
// Real and training data never match each other.
import { ham, levelOf } from "./hashing.js";
import { nowISO } from "./db.js";

export function runMatching(db, caseRow) {
  const scope = caseRow.is_training ? 1 : 0;
  const mine = db.prepare("SELECT * FROM media WHERE case_id = ? AND kind = 'image'").all(caseRow.id);
  const archive = db.prepare(`SELECT m.id AS media_id, m.sha256, m.archive_id, w.label, w.x, w.y, w.w, w.h, w.dhash, w.phash
    FROM archive_windows w JOIN media m ON m.id = w.media_id JOIN archive_records a ON a.id = m.archive_id
    WHERE a.active = 1 AND a.is_training = ?`).all(scope);
  const archiveMedia = db.prepare("SELECT m.id, m.sha256, m.archive_id FROM media m JOIN archive_records a ON a.id = m.archive_id WHERE a.active = 1 AND a.is_training = ?").all(scope);
  const others = db.prepare(`SELECT m.id, m.sha256, m.case_id, m.dhash, m.phash FROM media m JOIN cases c ON c.id = m.case_id
    WHERE m.case_id != ? AND m.kind = 'image' AND c.is_training = ? AND m.dhash IS NOT NULL`).all(caseRow.id, scope);

  const out = [];
  for (const m of mine) {
    if (!m.dhash) continue;
    const variants = [[m.dhash, m.phash, 0], [m.dhash_m, m.phash_m, 1]];
    // exact
    for (const a of archiveMedia) if (a.sha256 === m.sha256) out.push({ media_id: m.id, target_media_id: a.id, target_archive_id: a.archive_id, kind: "exact", level: "identical", score: 0, dhash_distance: 0, phash_distance: 0, window_label: "identical file", mirrored: 0 });
    for (const o of others) if (o.sha256 === m.sha256) out.push({ media_id: m.id, target_media_id: o.id, target_case_id: o.case_id, kind: "exact", level: "identical", score: 0, dhash_distance: 0, phash_distance: 0, window_label: "identical file", mirrored: 0 });
    // archive (best window per archive media)
    const best = new Map();
    for (const w of archive) {
      if (w.sha256 === m.sha256) continue;
      for (const [d, p, mir] of variants) {
        const dd = ham(d, w.dhash), pd = ham(p, w.phash), score = dd + pd, cur = best.get(w.media_id);
        if (!cur || score < cur.score) best.set(w.media_id, { media_id: m.id, target_media_id: w.media_id, target_archive_id: w.archive_id, kind: "perceptual", dhash_distance: dd, phash_distance: pd, score, window_label: w.label, wx: w.x, wy: w.y, ww: w.w, wh: w.h, mirrored: mir });
      }
    }
    for (const b of best.values()) { const level = levelOf(b.score); if (level) out.push({ ...b, level }); }
    // other cases
    const bestCase = new Map();
    for (const o of others) {
      if (o.sha256 === m.sha256) continue;
      for (const [d, p, mir] of variants) {
        const dd = ham(d, o.dhash), pd = ham(p, o.phash), score = dd + pd, cur = bestCase.get(o.case_id);
        if (!cur || score < cur.score) bestCase.set(o.case_id, { media_id: m.id, target_media_id: o.id, target_case_id: o.case_id, kind: "perceptual", dhash_distance: dd, phash_distance: pd, score, window_label: "full image", mirrored: mir });
      }
    }
    for (const b of bestCase.values()) if (levelOf(b.score) === "strong") out.push({ ...b, level: "strong" });
  }
  const ins = db.prepare(`INSERT INTO matches(case_id,media_id,target_media_id,target_archive_id,target_case_id,kind,level,dhash_distance,phash_distance,score,window_label,wx,wy,ww,wh,mirrored,created_at)
    VALUES (@case_id,@media_id,@target_media_id,@target_archive_id,@target_case_id,@kind,@level,@dhash_distance,@phash_distance,@score,@window_label,@wx,@wy,@ww,@wh,@mirrored,@created_at)`);
  db.transaction(() => {
    db.prepare("DELETE FROM matches WHERE case_id = ?").run(caseRow.id);
    for (const r of out) ins.run({ target_archive_id: null, target_case_id: null, wx: null, wy: null, ww: null, wh: null, ...r, case_id: caseRow.id, created_at: nowISO() });
  })();
  return { matches: out, archiveCount: new Set(archiveMedia.map(a => a.archive_id)).size, imageCount: mine.length };
}
