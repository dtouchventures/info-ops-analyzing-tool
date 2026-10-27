// AI Watchlist on imported datasets ("historical dataset analysis"). Posts imported into Social Media Analysis
// (CSV, JSON, Excel, screenshots or permitted collection) are checked against every active watchlist that monitors
// that dataset, as soon as they are imported and whenever an analyst asks. Each watchlist then looks at the timeline
// of its matched posts, by their publication time, and raises alerts for documented, configurable conditions:
//   threshold     at least N matching posts within a window (the analyst's own rule, e.g. 10 within 1 hour)
//   volume        a window far above the windows before it: mean + k standard deviations AND a ratio over the mean
//                 AND a minimum count, so a topic that is simply always popular does not alert
//   narrative     a TF-IDF / k-means topic whose recent posting rate is a multiple of its earlier rate
//   repeated      the same or nearly the same wording from several accounts within a period
//   coordination  near-identical text from several accounts within a few minutes (a signal for human review only)
// This is analysis of the posting times recorded in the data, not real-time monitoring; live monitoring needs a
// connected source and runs separately (watch-collect.js). Results are leads for an analyst, never findings.
import crypto from "node:crypto";
import { nowISO } from "./db.js";
import { HttpError } from "./auth.js";
import { classifySentiment, topicClusters, keywordCounts } from "./social-analysis.js";

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const r2 = x => Math.round(x * 100) / 100;
const isoMin = t => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const STOP = new Set(`the and for are but not you all any can her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many over such take than them well were what into more only also then there their about would these other which could after first never where those while being every under before again should since through still because while
  na ya wa kwa ni za la katika hii huu hiyo huo sana hakuna kama lakini pia wao sisi wewe mimi yeye kuna watu leo tena bado kwamba ili hata baada kabla http https www com`.split(/\s+/));
const termsOf = text => { const w = String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").split(/[^\p{L}\p{N}#]+/u).filter(x => x.length >= 3 && !STOP.has(x) && !/^\d+$/.test(x));
  const out = new Set(w); for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`); return [...out]; };
export const HISTORICAL_NOTE = "Historical dataset analysis: based on the publication times recorded in the imported data, not on live monitoring. Gaps or uneven coverage in the data can create or hide rises.";

export function makeDatasetWatch(db, { watch, audit }) {
  const targets = datasetId => watch.list().filter(w => w.status === "active" && (w.definition.all_datasets || (w.definition.datasets || []).includes(Number(datasetId))));
  const datasetIds = wl => wl.definition.all_datasets ? db.prepare("SELECT id FROM io_datasets ORDER BY id").all().map(r => r.id) : (wl.definition.datasets || []).filter(id => db.prepare("SELECT 1 FROM io_datasets WHERE id = ?").get(id));

  // check one dataset's posts that this watchlist has not checked yet (or all of them again after the terms changed)
  function scan(wl, datasetId) {
    const ds = db.prepare("SELECT id, name FROM io_datasets WHERE id = ?").get(Number(datasetId)); if (!ds) throw new HttpError(404, "Dataset not found.");
    const st = db.prepare("SELECT * FROM watch_dataset_scans WHERE watchlist_id = ? AND dataset_id = ?").get(wl.id, ds.id);
    const from = st && st.definition_sha256 === wl.definition_sha256 ? st.last_io_post_id : 0;
    const rows = db.prepare("SELECT * FROM io_posts WHERE dataset_id = ? AND id > ? ORDER BY id").all(ds.id, from);
    const via = `Imported dataset “${ds.name}” (#${ds.id})`;
    let out = { fetched: 0, matched: 0, new_matches: 0 }, error = null;
    try {
      out = watch.ingest(wl, "dataset", rows.map(p => ({ platform: p.platform || "Imported", post_id: p.post_id ? String(p.post_id) : `ds${ds.id}-${p.id}`, url: p.url || null, account: p.account, text: p.text,
        language: p.language || null, posted_at: p.posted_at, likes: p.likes, comments: p.comments, shares: p.shares, views: p.views, repost_of: p.repost_of || null, collected_via: via, dataset_id: ds.id, io_post_id: p.id })), { signalsOnly: true });
    } catch (e) { error = e.message; }
    const last = rows.length ? rows.at(-1).id : from, now = nowISO();
    db.prepare(`INSERT INTO watch_dataset_scans(watchlist_id,dataset_id,last_io_post_id,definition_sha256,posts_checked,matched,scanned_at,status,error) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(watchlist_id,dataset_id) DO UPDATE SET last_io_post_id = excluded.last_io_post_id, definition_sha256 = excluded.definition_sha256, posts_checked = CASE WHEN ? = 0 THEN excluded.posts_checked ELSE posts_checked + excluded.posts_checked END,
      matched = (SELECT COUNT(*) FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = excluded.watchlist_id AND p.dataset_id = excluded.dataset_id), scanned_at = excluded.scanned_at, status = excluded.status, error = excluded.error`)
      .run(wl.id, ds.id, error ? from : last, wl.definition_sha256, rows.length, out.matched, now, error ? "failed" : "ok", error, from);
    labelSentiment(wl.id);
    return { dataset_id: ds.id, dataset: ds.name, checked: rows.length, matched: out.matched, new_matches: out.new_matches, error };
  }
  // sentiment of matched posts that have none yet (trained classifier for English, word list for Kiswahili)
  function labelSentiment(wlId) {
    const ps = db.prepare("SELECT p.id, p.text FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND p.sentiment IS NULL").all(wlId);
    const up = db.prepare("UPDATE watch_posts SET sentiment = ?, sentiment_confidence = ?, sentiment_method = ? WHERE id = ?");
    db.transaction(() => { for (const p of ps) { const s = classifySentiment(p.text); up.run(s.label, s.confidence, s.method, p.id); } })();
  }

  // ------------------------------------------------------------ detectors over the matched posts' timeline
  const postsOf = wlId => db.prepare(`SELECT p.id, p.platform, p.post_id, p.account, p.text, p.url, p.posted_at, p.dataset_id, p.sentiment, m.cluster, m.terms_json
    FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? AND p.dataset_id IS NOT NULL AND p.posted_at IS NOT NULL AND m.is_repost = 0 ORDER BY p.posted_at, p.id`).all(wlId)
    .filter(p => !isNaN(Date.parse(p.posted_at)));
  // counts per window from the first to the last post (empty windows count as zero: the data covers that period)
  function series(posts, minutes) {
    if (!posts.length) return { W: minutes * 60e3, start: null, counts: [], members: [] };
    const W = minutes * 60e3, start = Math.floor(Date.parse(posts[0].posted_at) / W) * W, n = Math.floor((Date.parse(posts.at(-1).posted_at) - start) / W) + 1;
    const counts = new Array(Math.min(n, 200000)).fill(0), members = counts.map(() => []);
    for (const p of posts) { const i = Math.floor((Date.parse(p.posted_at) - start) / W); if (i < counts.length) { counts[i]++; members[i].push(p.id); } }
    return { W, start, counts, members };
  }
  const episodes = flags => { const out = []; flags.forEach((f, i) => { if (!f) return; if (out.length && out.at(-1).end === i - 1) out.at(-1).end = i; else out.push({ start: i, end: i }); }); return out; };

  function volumeSeries(wl, posts) {
    const T = wl.definition.thresholds, s = series(posts, T.volume_window_min), N = T.volume_baseline_windows;
    const stats = s.counts.map((c, i) => {
      if (i < N) return null;
      const base = s.counts.slice(i - N, i), mean = base.reduce((a, b) => a + b, 0) / N, sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / N);
      const spike = c >= T.volume_min_posts && c >= T.volume_ratio * mean && c >= mean + T.volume_sd * sd;
      return { mean: r2(mean), sd: r2(sd), z: sd ? r2((c - mean) / sd) : null, ratio: mean ? r2(c / mean) : null, spike };
    });
    return { ...s, stats, N, sufficient: s.counts.length > N, insufficient_reason: s.counts.length > N ? null : `needs more than ${N} windows of ${T.volume_window_min} min between the first and last matching post; the data spans ${s.counts.length}` };
  }

  function analyse(wlOrId, { user = null } = {}) {
    const wl = typeof wlOrId === "object" ? wlOrId : watch.get(wlOrId), T = wl.definition.thresholds, posts = postsOf(wl.id), raised = { threshold: 0, volume: 0, narrative: 0, repeated: 0, coordination: 0 };
    const base = { mode: "historical", note: HISTORICAL_NOTE, datasets: [...new Set(posts.map(p => p.dataset_id))] };
    const pick = ids => ids.slice(0, 50);
    // threshold: the analyst's own rule
    const ts = series(posts, T.count_window_min);
    for (const e of episodes(ts.counts.map(c => c >= T.count_min_posts))) {
      const ids = ts.members.slice(e.start, e.end + 1).flat(), peak = Math.max(...ts.counts.slice(e.start, e.end + 1)), from = ts.start + e.start * ts.W, to = ts.start + (e.end + 1) * ts.W;
      raised.threshold += watch.raise(wl, "threshold", `thr:${wl.id}:${new Date(from).toISOString()}`, { post_id: ids[0], severity: peak >= 2 * T.count_min_posts ? "medium" : "low",
        title: `${ids.length} matching posts between ${isoMin(from)} and ${isoMin(to)} (${wl.name})`,
        reason: `At least ${T.count_min_posts} matching posts within ${T.count_window_min} min (your rule): ${peak} in the busiest window, ${ids.length} in ${e.end - e.start + 1} window${e.end > e.start ? "s" : ""} in a row from ${isoMin(from)}. ${HISTORICAL_NOTE}`,
        detail: { ...base, window_min: T.count_window_min, threshold_posts: T.count_min_posts, peak, posts: ids.length, from: new Date(from).toISOString(), to: new Date(to).toISOString(), post_ids: pick(ids) } });
    }
    // volume: unusual compared with the windows before
    const vs = volumeSeries(wl, posts);
    for (const e of episodes(vs.stats.map(x => !!x?.spike))) {
      const idx = Array.from({ length: e.end - e.start + 1 }, (_, k) => e.start + k), top = idx.reduce((a, i) => (vs.counts[i] > vs.counts[a] ? i : a), idx[0]), st = vs.stats[top];
      const from = vs.start + e.start * vs.W, ids = idx.flatMap(i => vs.members[i]);
      raised.volume += watch.raise(wl, "volume", `hvol:${wl.id}:${new Date(from).toISOString()}`, { post_id: ids[0], severity: (st.ratio ?? 99) >= 5 && (st.z ?? 99) >= 5 ? "high" : "medium",
        title: `Unusual rise: ${vs.counts[top]} posts in ${T.volume_window_min} min at ${isoMin(vs.start + top * vs.W)} (${wl.name})`,
        reason: `${vs.counts[top]} matching posts were published in the ${T.volume_window_min}-minute window from ${isoMin(vs.start + top * vs.W)}, against an average of ${st.mean} (standard deviation ${st.sd}) in the previous ${vs.N} windows (${st.ratio ?? "∞"}× the average, ${st.z ?? "∞"} standard deviations above it). Threshold: at least ${T.volume_min_posts} posts, ${T.volume_ratio}× the average and ${T.volume_sd} standard deviations above it. A rise can follow genuine news. ${HISTORICAL_NOTE}`,
        detail: { ...base, window_min: T.volume_window_min, baseline_windows: vs.N, current: vs.counts[top], mean: st.mean, sd: st.sd, ratio: st.ratio, z: st.z, window_start: new Date(vs.start + top * vs.W).toISOString(),
          series: vs.counts.slice(Math.max(0, top - vs.N), top + 1), threshold: { min_posts: T.volume_min_posts, ratio: T.volume_ratio, sd: T.volume_sd }, post_ids: pick(ids) } });
    }
    // repeated wording and coordination indicators, per cluster of the same or nearly the same text
    const byCluster = new Map(); for (const p of posts) if (p.cluster) { if (!byCluster.has(p.cluster)) byCluster.set(p.cluster, []); byCluster.get(p.cluster).push(p); }
    const spanH = posts.length ? Math.max(T.repeat_window_h, (Date.parse(posts.at(-1).posted_at) - Date.parse(posts[0].posted_at)) / 3600e3) : 0, reps = [];
    for (const [cl, ps] of byCluster) {
      if (ps.length < 2) continue;
      // repeated wording counts only when it is concentrated in time: the busiest period holds several times the
      // share a steady rate would give it (wording that is repeated all week, like routine notices, does not alert)
      const best = densest(ps, T.repeat_window_h * 3600e3), acc = new Set(best.map(p => String(p.account || "").toLowerCase()).filter(Boolean));
      const expected = ps.length * T.repeat_window_h / spanH, burst = expected ? r2(best.length / expected) : null;
      if (best.length >= T.repeat_min_posts && acc.size >= T.repeat_min_accounts && (burst == null || burst >= T.repeat_burst_ratio)) reps.push({ cl, best, acc, burst });
      // synchronised posting: the most accounts posting this text within a few minutes
      const sync = densest(ps, T.coord_window_min * 60e3, true), sacc = new Set(sync.map(p => String(p.account || "").toLowerCase()).filter(Boolean));
      if (sacc.size >= T.coord_min_accounts) {
        const span = r2((Date.parse(sync.at(-1).posted_at) - Date.parse(sync[0].posted_at)) / 60000);
        const tags = commonOf(sync.map(p => p.text.match(/#[\p{L}\p{N}_]+/gu) || [])), links = commonOf(sync.map(p => p.text.match(/https?:\/\/\S+/g) || []));
        raised.coordination += watch.raise(wl, "coordination", `coord:${wl.id}:${cl}`, { post_id: sync[0].id, severity: sacc.size >= 5 && span <= 10 ? "high" : "medium",
          title: `Possible coordination indicator: ${sacc.size} accounts, near-identical text within ${span} min`,
          reason: `${sacc.size} different accounts posted the same or nearly the same text within ${span} minutes (${isoMin(sync[0].posted_at)} to ${isoMin(sync.at(-1).posted_at)}). Threshold: ${T.coord_min_accounts} accounts within ${T.coord_window_min} min.${tags.length ? ` Shared hashtags: ${tags.join(" ")}.` : ""}${links.length ? ` Shared link: ${links[0]}.` : ""} This is a signal that needs human review, not evidence of coordinated manipulation: people often repost a news item or a call to share together. ${HISTORICAL_NOTE}`,
          detail: { ...base, accounts: sacc.size, posts: sync.length, span_minutes: span, window_min: T.coord_window_min, threshold_accounts: T.coord_min_accounts, shared_hashtags: tags, shared_links: links.slice(0, 5), post_ids: pick(sync.map(p => p.id)) } });
      }
    }
    // one alert per episode: repeated messages whose busiest periods overlap are reported together
    reps.sort((a, b) => b.best.length - a.best.length);
    const groups = [];
    for (const r of reps) {
      const f = Date.parse(r.best[0].posted_at), l = Date.parse(r.best.at(-1).posted_at);
      const g = groups.find(g => f <= g.last && l >= g.first); if (g) { g.items.push(r); g.first = Math.min(g.first, f); g.last = Math.max(g.last, l); } else groups.push({ first: f, last: l, items: [r] });
    }
    for (const g of groups) {
      const all = g.items.flatMap(r => r.best), accounts = new Set(all.map(p => String(p.account || "").toLowerCase()).filter(Boolean)), top = g.items[0];
      const key = `rep:${wl.id}:${top.cl}`, detail = { ...base, posts: all.length, accounts: accounts.size, messages: g.items.map(r => ({ text: r.best[0].text.slice(0, 280), posts: r.best.length, accounts: r.acc.size, burst_ratio: r.burst })),
        platforms: [...new Set(all.map(p => p.platform))], first_at: new Date(g.first).toISOString(), last_at: new Date(g.last).toISOString(), window_h: T.repeat_window_h,
        threshold_posts: T.repeat_min_posts, threshold_accounts: T.repeat_min_accounts, threshold_burst_ratio: T.repeat_burst_ratio, similarity: T.repeat_similarity, post_ids: pick(all.map(p => p.id)) };
      const reason = `${g.items.length === 1 ? "One message was" : `${g.items.length} messages were`} repeated ${all.length} times by ${accounts.size} accounts between ${isoMin(g.first)} and ${isoMin(g.last)}, concentrated in time (${top.burst ?? "∞"}× the rate the same wording has elsewhere in the data). Threshold for each message: at least ${T.repeat_min_posts} posts from ${T.repeat_min_accounts} accounts within ${T.repeat_window_h} h, and ${T.repeat_burst_ratio}× its usual rate; “the same wording” means at least ${Math.round(T.repeat_similarity * 100)}% of three-word sequences shared. Repeated wording can be genuine sharing of news; it is not proof of coordination. ${HISTORICAL_NOTE}`;
      const ex = db.prepare("SELECT id, detail_json FROM watch_alerts WHERE dedupe_key = ?").get(key);
      if (ex) { const old = JSON.parse(ex.detail_json); if (old.posts !== all.length) { db.prepare("UPDATE watch_alerts SET reason = ?, detail_json = ?, updated_at = ? WHERE id = ?").run(reason, JSON.stringify({ ...detail, recommended_action: old.recommended_action }), nowISO(), ex.id); watch.addEvent(ex.id, "updated", null, `now ${all.length} posts from ${accounts.size} accounts`); } }
      else raised.repeated += watch.raise(wl, "repeated", key, { post_id: top.best[0].id, severity: accounts.size >= 10 ? "high" : "medium",
        title: `Repeated wording: ${g.items.length > 1 ? `${g.items.length} messages, e.g. ` : ""}${top.best[0].text.replace(/\s+/g, " ").slice(0, 100)}`, reason, detail });
    }
    // emerging narratives: words and word pairs that suddenly become frequent, grouped by the posts that share them
    for (const n of emerging(wl, posts)) {
      raised.narrative += watch.raise(wl, "narrative", `nar:${wl.id}:${sha(n.terms.slice(0, 3).sort().join(" ")).slice(0, 16)}`, { post_id: n.post_ids[0], severity: n.posts >= 2 * T.narrative_min_posts ? "medium" : "low",
        title: `Emerging narrative: ${n.terms.slice(0, 3).join(" · ")} (${wl.name})`,
        reason: `From ${isoMin(n.from)}, ${n.posts} matching posts in ${T.narrative_window_h} h share the words ${n.terms.slice(0, 6).map(t => `“${t}”`).join(", ")}. Before that window these words appeared in ${n.before} posts in total (${n.baseline_per_window} per ${T.narrative_window_h} h on average): ${n.ratio}× their usual rate. Threshold: at least ${T.narrative_min_posts} posts and ${T.narrative_ratio}× the usual rate. Read the examples to judge what the posts claim. ${HISTORICAL_NOTE}`,
        detail: { ...base, terms: n.terms, posts: n.posts, before: n.before, baseline_per_window: n.baseline_per_window, ratio: n.ratio, from: new Date(n.from).toISOString(), window_h: T.narrative_window_h,
          threshold_posts: T.narrative_min_posts, threshold_ratio: T.narrative_ratio, method: "term burst detection on words and word pairs (TF-IDF vocabulary), posts grouped by shared burst terms", post_ids: pick(n.post_ids) } });
    }
    const total = Object.values(raised).reduce((a, b) => a + b, 0);
    if (user) audit(user, "Watchlist analysed (historical datasets)", "watchlist", String(wl.id), { posts: posts.length, alerts: raised });
    return { posts: posts.length, raised, total, volume: { sufficient: vs.sufficient, insufficient_reason: vs.insufficient_reason } };
  }
  // the largest set of posts within a span (two pointers over time); distinct accounts when asked
  function densest(ps, span, byAccounts = false) {
    const t = ps.map(p => Date.parse(p.posted_at)), key = p => String(p.account || "").toLowerCase(), cnt = new Map();
    let i = 0, distinct = 0, bestScore = 0, bi = 0, bj = -1;
    for (let j = 0; j < ps.length; j++) {
      if (byAccounts) { const k = key(ps[j]); cnt.set(k, (cnt.get(k) || 0) + 1); if (cnt.get(k) === 1) distinct++; }
      while (t[j] - t[i] > span) { if (byAccounts) { const k = key(ps[i]); cnt.set(k, cnt.get(k) - 1); if (cnt.get(k) === 0) distinct--; } i++; }
      const score = byAccounts ? distinct : j - i + 1;
      if (score > bestScore) { bestScore = score; bi = i; bj = j; }
    }
    return ps.slice(bi, bj + 1);
  }
  const commonOf = lists => { const c = new Map(); for (const l of lists) for (const x of new Set(l.map(v => v.toLowerCase()))) c.set(x, (c.get(x) || 0) + 1); return [...c].filter(([, n]) => n >= Math.max(2, Math.ceil(lists.length / 2))).map(([x]) => x); };
  // term bursts: for each window, the words and word pairs whose post count is far above their own average in the
  // windows before; posts sharing those terms form a candidate narrative (the watch terms themselves are left out)
  function emerging(wl, posts) {
    const T = wl.definition.thresholds, W = T.narrative_window_h * 3600e3; if (!posts.length) return [];
    const own = new Set(wl.definition.terms.flatMap(t => termsOf(t))), start = Math.floor(Date.parse(posts[0].posted_at) / W) * W;
    const docs = posts.map(p => ({ id: p.id, w: Math.floor((Date.parse(p.posted_at) - start) / W), terms: new Set(termsOf(p.text).filter(t => !own.has(t))) }));
    const nW = docs.at(-1).w + 1, per = new Map();   // term -> counts per window
    for (const d of docs) for (const t of d.terms) { let a = per.get(t); if (!a) per.set(t, (a = new Array(nW).fill(0))); a[d.w]++; }
    const found = [], seen = new Set();
    for (let w = Math.max(1, T.narrative_baseline_windows); w < nW; w++) {   // judged only after enough earlier windows to know the usual rate
      const burst = [];
      for (const [t, a] of per) {
        const c = a[w]; if (c < T.narrative_min_posts) continue;
        const prev = a.slice(0, w), before = prev.reduce((x, y) => x + y, 0), base = (before + 1) / w;   // +1: a term never seen before still needs real volume
        const mean = before / w, sd = Math.sqrt(prev.reduce((x, y) => x + (y - mean) ** 2, 0) / w);
        if (c >= T.narrative_ratio * base && c >= T.narrative_ratio && c >= mean + T.narrative_sd * sd) burst.push({ t, c, before, base });
      }
      if (!burst.length) continue;
      burst.sort((a, b) => b.c - a.c || a.t.localeCompare(b.t));
      const inW = docs.filter(d => d.w === w), used = new Set();
      for (const b of burst) {
        if (used.has(b.t)) continue;
        const ids = new Set(inW.filter(d => d.terms.has(b.t)).map(d => d.id)), group = [b];
        for (const o of burst) { if (o === b || used.has(o.t)) continue; const oi = inW.filter(d => d.terms.has(o.t)).map(d => d.id), ov = oi.filter(id => ids.has(id)).length; if (ov >= 0.5 * Math.min(ids.size, oi.length)) group.push(o); }
        group.forEach(g => used.add(g.t));
        const members = inW.filter(d => group.some(g => d.terms.has(g.t))).map(d => d.id);
        if (members.length < T.narrative_min_posts) continue;
        const terms = group.sort((a, b) => b.c - a.c).map(g => g.t), key = terms.slice(0, 3).sort().join(" ");
        if (seen.has(key)) continue; seen.add(key);
        const lead = group[0];
        found.push({ terms, from: start + w * W, posts: members.length, before: lead.before, baseline_per_window: r2(lead.before / w), ratio: r2(lead.c / lead.base), post_ids: members });
      }
    }
    return found;
  }
  function narratives(wl, posts) {
    const T = wl.definition.thresholds, tc = topicClusters(posts), end = posts.length ? Date.parse(posts.at(-1).posted_at) : 0, cut = end - T.narrative_window_h * 3600e3;
    const earlierHours = posts.length ? Math.max(T.narrative_window_h, (cut - Date.parse(posts[0].posted_at)) / 3600e3) : 0;
    const topics = tc.topics.map(t => {
      const ms = posts.filter((_, i) => tc.assign[i] === t.topic_no), recent = ms.filter(p => Date.parse(p.posted_at) > cut).length, earlier = ms.length - recent;
      const rr = earlier ? r2((recent / T.narrative_window_h) / (earlier / earlierHours)) : null;
      return { topic_no: t.topic_no, label: t.label, terms: t.terms, posts: ms.length, recent, earlier, rate_ratio: rr, emerging: recent >= T.narrative_min_posts && (earlier === 0 || rr >= T.narrative_ratio),
        post_ids: ms.map(p => p.id), examples: ms.slice(-3).reverse().map(p => ({ id: p.id, account: p.account, posted_at: p.posted_at, text: p.text.slice(0, 280), url: p.url })),
        sentiment: ms.reduce((a, p) => (p.sentiment ? { ...a, [p.sentiment]: (a[p.sentiment] || 0) + 1 } : a), {}) };
    });
    return { topics, earlier_hours: earlierHours, clustered: tc.k ? posts.length - tc.assign.filter(a => a === 0).length : 0, method: "TF-IDF (words and word pairs) with k-means, cosine distance" };
  }

  function scanAll(wlOrId, { user = null } = {}) {
    const wl = typeof wlOrId === "object" ? wlOrId : watch.get(wlOrId);
    const scans = datasetIds(wl).map(id => scan(wl, id)), analysis = analyse(watch.get(wl.id));
    if (user) audit(user, "Watchlist checked against imported datasets", "watchlist", String(wl.id), { scans: scans.map(s => ({ dataset: s.dataset_id, checked: s.checked, new: s.new_matches })), alerts: analysis.raised });
    return { scans, analysis };
  }
  // called after posts are imported or added to a dataset: every active watchlist that monitors it checks the new posts
  function onDatasetChange(datasetId, user = null) {
    return targets(datasetId).map(wl => { const s = scan(wl, datasetId), a = analyse(watch.get(wl.id)); return { watchlist_id: wl.id, watchlist: wl.name, ...s, alerts: a.total }; });
  }

  function analytics(wlOrId) {
    const wl = typeof wlOrId === "object" ? wlOrId : watch.get(wlOrId), T = wl.definition.thresholds;
    const all = db.prepare(`SELECT p.id, p.text, p.account, p.posted_at, p.platform, p.url, p.dataset_id, p.sentiment, p.sentiment_method, m.terms_json, m.source FROM watch_matches m JOIN watch_posts p ON p.id = m.post_id WHERE m.watchlist_id = ? ORDER BY coalesce(p.posted_at, m.detected_at)`).all(wl.id);
    const dated = all.filter(p => p.posted_at && !isNaN(Date.parse(p.posted_at)));
    const span = dated.length ? Date.parse(dated.at(-1).posted_at) - Date.parse(dated[0].posted_at) : 0, unit = span > 3 * 864e5 ? "day" : "hour", W = unit === "day" ? 864e5 : 3600e3;
    const trend = new Map(); for (const p of dated) { const k = new Date(Math.floor(Date.parse(p.posted_at) / W) * W).toISOString(); const t = trend.get(k) || { t: k, n: 0, positive: 0, negative: 0, neutral: 0, mixed: 0 }; t.n++; if (p.sentiment) t[p.sentiment] = (t[p.sentiment] || 0) + 1; trend.set(k, t); }
    const sent = all.reduce((a, p) => ({ ...a, [p.sentiment || "not classified"]: (a[p.sentiment || "not classified"] || 0) + 1 }), {});
    const terms = new Map(); for (const p of all) for (const t of JSON.parse(p.terms_json || "[]")) terms.set(t, (terms.get(t) || 0) + 1);
    const vs = volumeSeries(wl, postsOf(wl.id)), nar = narratives(wl, postsOf(wl.id));
    const alertsByKind = Object.fromEntries(db.prepare("SELECT kind, COUNT(*) n FROM watch_alerts WHERE watchlist_id = ? GROUP BY kind").all(wl.id).map(r => [r.kind, r.n]));
    const methods = [...new Set(all.map(p => p.sentiment_method).filter(Boolean))];
    return {
      posts: all.length, from_datasets: all.filter(p => p.dataset_id).length, collected: all.filter(p => !p.dataset_id).length, first_at: dated[0]?.posted_at || null, last_at: dated.at(-1)?.posted_at || null,
      trend: { unit, points: [...trend.values()].sort((a, b) => a.t.localeCompare(b.t)) },
      sentiment: { counts: sent, methods, note: "Tone estimated per post: trained classifier for English, word list for Kiswahili (see Settings → AI models). Tone is not truth, and negative tone is not misinformation." },
      top_terms: [...terms].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([term, count]) => ({ term, count })),
      top_words: keywordCounts(all.map(p => p.text), 15).keywords.map(k => ({ term: k.term, count: k.count })),
      narratives: { ...nar, topics: nar.topics.map(t => ({ ...t, post_ids: undefined })) },
      volume: { window_min: T.volume_window_min, start: vs.start ? new Date(vs.start).toISOString() : null, counts: vs.counts.slice(-500), offset: Math.max(0, vs.counts.length - 500), spikes: vs.stats.map((s, i) => (s?.spike ? i : -1)).filter(i => i >= 0), sufficient: vs.sufficient, insufficient_reason: vs.insufficient_reason },
      alerts: { by_kind: alertsByKind, recent: db.prepare("SELECT id, kind, severity, title, status, created_at FROM watch_alerts WHERE watchlist_id = ? ORDER BY id DESC LIMIT 20").all(wl.id) },
      scans: db.prepare("SELECT s.*, d.name dataset FROM watch_dataset_scans s LEFT JOIN io_datasets d ON d.id = s.dataset_id WHERE s.watchlist_id = ? ORDER BY s.dataset_id").all(wl.id),
      monitored_datasets: datasetIds(wl).map(id => db.prepare("SELECT id, name, posts, first_at, last_at, is_sample FROM io_datasets WHERE id = ?").get(id)),
      note: HISTORICAL_NOTE
    };
  }
  return { scan, scanAll, analyse, analytics, onDatasetChange, targets };
}
