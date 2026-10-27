// Social media analysis views for a post dataset: overview, sentiment, topics and narratives, engagement, claims,
// geography and reports, all with the same filters (date range, platform, theme, topic, tone, keyword).
// Every number on these views is computed by the server from the stored posts; nothing here is sample data
// unless the dataset itself is marked synthetic.
import { api } from "../api.js";
import { App, refreshNavCounts } from "../app.js";
import { $, $$, esc, toast, fail, confirmBox, modal, fmtDT, empty, errMsg } from "../ui.js";

const n = x => Number(x || 0).toLocaleString();
const dt = iso => (iso ? fmtDT(iso) : "—");
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
export const SENT = { positive: ["Positive", "var(--sup)"], negative: ["Negative", "var(--con)"], neutral: ["Neutral", "var(--unr)"], mixed: ["Mixed or uncertain", "var(--mix)"] };
const SK = ["positive", "negative", "neutral", "mixed"];
const FKEYS = ["from", "to", "platform", "theme", "topic", "sentiment", "q"];
let META = null;
export async function meta() { if (!META) META = await api.get("/api/social/overview"); return META; }
export const resetMeta = () => { META = null; };

// ---------------------------------------------------------------- filters (kept in the address, so views and reports can be shared)
export function readFilters() { const qp = new URLSearchParams(location.hash.split("?")[1] || ""); return Object.fromEntries(FKEYS.filter(k => qp.get(k)).map(k => [k, qp.get(k)])); }
export const filterQuery = f => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== "" && v != null)).toString();
export function filterBar(d, I, tab, M) {
  const f = readFilters(), on = Object.keys(f).length;
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur ?? "") === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  return `<form class="card" id="fbar" style="margin-bottom:14px"><div class="bd" style="padding:10px 14px"><div class="fgrid">
    <div><label class="f" for="ff_from" style="margin-top:0">From</label><input type="date" id="ff_from" value="${esc(f.from || "")}"></div>
    <div><label class="f" for="ff_to" style="margin-top:0">To</label><input type="date" id="ff_to" value="${esc(f.to || "")}"></div>
    <div><label class="f" for="ff_platform" style="margin-top:0">Platform</label><select id="ff_platform">${opt("", "All platforms", f.platform)}${(I.platformsAll || []).map(p => opt(p === "Not stated" ? "" : p, p, f.platform)).join("")}</select></div>
    <div><label class="f" for="ff_theme" style="margin-top:0">Theme</label><select id="ff_theme">${opt("", "All themes", f.theme)}${Object.entries(M.themes).map(([k, l]) => opt(k, l, f.theme)).join("")}${opt("none", "No theme", f.theme)}</select></div>
    <div><label class="f" for="ff_topic" style="margin-top:0">Topic</label><select id="ff_topic">${opt("", "All topics", f.topic)}${(I.topicsAll || []).map(t => opt(t.topic_no, `${t.topic_no}. ${t.label}`, f.topic)).join("")}</select></div>
    <div><label class="f" for="ff_sentiment" style="margin-top:0">Tone</label><select id="ff_sentiment">${opt("", "Any tone", f.sentiment)}${SK.map(k => opt(k, SENT[k][0], f.sentiment)).join("")}</select></div>
    <div style="grid-column:span 2"><label class="f" for="ff_q" style="margin-top:0">Keyword or account</label><input type="search" id="ff_q" value="${esc(f.q || "")}" placeholder="e.g. water, #FuelKE"></div></div>
    <div class="row" style="margin-top:8px"><button class="btn sm primary" type="submit">Apply filters</button>${on ? `<a class="btn sm ghost" href="#/monitor/${d.id}/${tab}">Clear (${on})</a>` : ""}<span class="small sub" aria-live="polite">${on ? `${n(I.posts)} of ${n(I.dataset_posts)} posts match` : `All ${n(I.dataset_posts)} posts`}</span></div></div></form>`;
}
export function wireFilters(d, tab) {
  const form = $("#fbar"); if (!form) return;
  form.onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(FKEYS.map(k => [k, $(`#ff_${k}`).value.trim()])); const q = filterQuery(f); App.go(`#/monitor/${d.id}/${tab}${q ? `?${q}` : ""}`); };
}

// ---------------------------------------------------------------- charts (inline SVG; every chart also has its numbers in text or a table)
function stacked(seriesMap, keys, colors, { height = 140, label = "Posts over time" } = {}) {
  const len = seriesMap[keys[0]]?.length || 0; if (len < 2) return `<p class="small muted" style="margin:0">All posts fall in one period, so there is no trend to draw.</p>`;
  const tot = Array.from({ length: len }, (_, i) => keys.reduce((a, k) => a + (seriesMap[k]?.[i] || 0), 0)), max = Math.max(1, ...tot), w = Math.max(2, Math.min(16, Math.floor(860 / len))), W = len * w;
  return `<svg viewBox="0 0 ${W} ${height + 4}" preserveAspectRatio="none" style="width:100%;height:${height + 4}px;display:block" role="img" aria-label="${esc(label)}">${Array.from({ length: len }, (_, i) => { let y = height; return keys.map(k => { const v = seriesMap[k]?.[i] || 0, h = (v / max) * height; y -= h; return v ? `<rect x="${i * w + 0.5}" y="${y.toFixed(1)}" width="${Math.max(1, w - 1)}" height="${h.toFixed(1)}" fill="${colors[k]}"><title>${esc(k)}: ${v}</title></rect>` : ""; }).join(""); }).join("")}
    <line x1="0" y1="${height}" x2="${W}" y2="${height}" stroke="currentColor" stroke-opacity=".25"/></svg>`;
}
function lines(series, { height = 140, colors = ["var(--teal-600, #0f766e)", "var(--con, #b42318)"], names = [] } = {}) {
  const len = Math.max(...series.map(s => s.length)); if (len < 2) return `<p class="small muted" style="margin:0">Not enough periods to draw a trend.</p>`;
  const max = Math.max(1, ...series.flat()), W = 860, x = i => (i / (len - 1)) * W, y = v => height - (v / max) * (height - 6);
  return `<svg viewBox="0 0 ${W} ${height + 4}" preserveAspectRatio="none" style="width:100%;height:${height + 4}px;display:block" role="img" aria-label="${esc(names.join(" compared with ") || "Trend")}">${series.map((s, k) => `<polyline fill="none" stroke="${colors[k % colors.length]}" stroke-width="2" ${k ? 'stroke-dasharray="6 4"' : ""} vector-effect="non-scaling-stroke" points="${s.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`).join("")}<line x1="0" y1="${height}" x2="${W}" y2="${height}" stroke="currentColor" stroke-opacity=".25"/></svg>`;
}
const hbars = (rows, { max, color = "var(--teal-600, #0f766e)" } = {}) => { const m = max || Math.max(1, ...rows.map(r => r.v)); return `<div class="hbars">${rows.map(r => `<div class="hb"><span class="hl" title="${esc(r.l)}">${r.href ? `<a href="${r.href}">${esc(r.l)}</a>` : esc(r.l)}</span><span class="ht"><span style="width:${(r.v / m) * 100}%;background:${r.c || color}"></span></span><span class="hv">${n(r.v)}${r.s ? ` <span class="sub">${esc(r.s)}</span>` : ""}</span></div>`).join("")}</div>`; };
const sentBar = c => { const t = SK.reduce((a, k) => a + (c[k] || 0), 0); return t ? `<span class="sbar" title="${SK.map(k => `${SENT[k][0]} ${c[k] || 0}`).join(", ")}">${SK.map(k => c[k] ? `<span style="width:${(c[k] / t) * 100}%;background:${SENT[k][1]}"></span>` : "").join("")}</span>` : ""; };
const legend = keys => `<div class="legend small">${keys.map(k => `<span><i style="background:${SENT[k][1]}"></i>${SENT[k][0]}</span>`).join("")}</div>`;
const spark = s => { const max = Math.max(1, ...s), w = 100 / Math.max(1, s.length - 1); return s.length > 1 ? `<svg viewBox="0 0 100 22" style="width:100px;height:22px" aria-hidden="true"><polyline fill="none" stroke="var(--teal-600, #0f766e)" stroke-width="1.5" points="${s.map((v, i) => `${(i * w).toFixed(1)},${(20 - (v / max) * 18).toFixed(1)}`).join(" ")}"/></svg>` : ""; };
const kpi = (l, v, sub, href) => `<a class="kpi" ${href ? `href="${href}"` : ""}><div class="l">${l}</div><div class="v">${v}</div><div class="tiny sub">${sub || ""}</div></a>`;
const postsLink = (d, f) => `#/monitor/${d.id}/posts?${filterQuery({ ...readFilters(), ...f })}`;
const emptyFiltered = (d, tab) => `<div class="card"><div class="bd">${empty("No posts match these filters", "Change or clear the filters above.")}<div style="text-align:center"><a class="btn sm" href="#/monitor/${d.id}/${tab}">Clear filters</a></div></div></div>`;

// ---------------------------------------------------------------- overview
export function overview(body, d, I, A, M, el) {
  if (I.empty) return void (body.innerHTML = emptyFiltered(d, "overview"));
  const S = I.sentiment.counts, C = d.content || {}, ai = C.ai_summary, cl = I.claimCounts || {};
  body.innerHTML = `<div class="kpis">${kpi("Posts", n(I.posts), `${n(I.accounts)} accounts`, postsLink(d, {}))}${kpi("Platforms", n(I.platforms.length), esc(I.platforms.slice(0, 3).map(p => p.platform).join(", ")))}
      ${kpi("Negative tone", `${pct(S.negative, I.posts)}%`, `${pct(S.positive, I.posts)}% positive · estimate`, `#/monitor/${d.id}/sentiment?${filterQuery(readFilters())}`)}
      ${kpi("Claims to review", n(cl.needs_review || 0), `${n((cl.unreviewed || 0) + (cl.needs_review || 0) + (cl.in_case || 0) + (cl.dismissed || 0))} claims found`, `#/monitor/${d.id}/claims?status=needs_review`)}
      ${kpi("Coordination indicators", n(A?.summary.synchronised_clusters || 0), `synchronised messages · ${n(A?.summary.hashtag_bursts || 0)} hashtag bursts`, `#/monitor/${d.id}/messages`)}</div>
    <div class="split"><div class="stack">
      <div class="card"><div class="hd"><h3>Posts per ${I.bucket}, by estimated tone</h3><span class="small sub right">From ${dt(I.bucket_start)}</span></div><div class="bd">${stacked(I.sentiment.series, SK, Object.fromEntries(SK.map(k => [k, SENT[k][1]])), { label: "Posts over time by tone" })}${legend(SK)}</div></div>
      <div class="card"><div class="hd"><h3>What is discussed</h3><a class="small right" href="#/monitor/${d.id}/topics?${filterQuery(readFilters())}">Topics and narratives</a></div><div class="bd">
        ${I.themes.length ? hbars(I.themes.slice(0, 8).map(t => ({ l: t.label, v: t.posts, href: `#/monitor/${d.id}/overview?${filterQuery({ ...readFilters(), theme: t.key })}`, s: t.emerging ? `growing ×${t.ratio}` : "" }))) : `<p class="small muted">No predefined theme was found.</p>`}
        ${I.emerging.length ? `<div class="callout info" style="margin-top:10px"><div><b>Growing late in the period:</b> ${I.emerging.slice(0, 5).map(e => `${esc(e.label)} (×${e.ratio}, ${e.late} posts)`).join("; ")}. Its share of posts in the last third of the period is at least twice its earlier share.</div></div>` : ""}</div></div>
    </div><div class="stack">
      <div class="card"><div class="hd"><h3>Research question</h3>${App.can("io.import") ? `<button class="btn sm ghost right" id="rqEdit">Edit</button>` : ""}</div><div class="bd small" id="rqBox">${d.research_question ? esc(d.research_question) : `<span class="muted">Not set. A research question keeps the analysis focused and is printed in reports.</span>`}</div></div>
      <div class="card"><div class="hd"><h3>Platforms</h3></div><div class="bd">${hbars(I.platforms.map(p => ({ l: p.platform, v: p.posts, s: `${pct(p.posts, I.posts)}%` })))}</div></div>
      <div class="card"><div class="hd"><h3>Summary</h3>${ai ? `<span class="chip info right">local AI: ${esc(ai.model)}</span>` : ""}</div><div class="bd small">
        ${ai ? `<p style="margin-top:0">${esc(ai.summary)}</p><ul style="margin:0 0 0 18px">${ai.points.map(p => `<li>${esc(p.text)} <span class="sub">(posts ${p.post_ids.map(i => `<a href="#/monitor/${d.id}/posts?ids=${i}">${i}</a>`).join(", ")})</span></li>`).join("")}</ul>
          <div class="hint">Written by a local AI model from ${ai.sampled_posts} sampled posts and the dataset's figures on ${dt(ai.generated_at)}; each point cites the posts it is based on. Check them.${ai.outdated ? " <b>The dataset has changed since; run it again.</b>" : ""}</div>`
          : `<p class="muted" style="margin-top:0">No AI summary. ${M.ollama.configured && M.ollama.model_available ? "You can ask the local AI model for one below." : "The local AI model (Ollama) is not available, so no summary is written. All figures on this page are computed without AI."}</p>`}
        ${aiButtons(d, M, ["summary"])}</div></div>
      <div class="card"><div class="hd"><h3>Content analysis</h3></div><div class="bd small">${C.generated_at ? `Tone, themes, topics and claims computed ${dt(C.generated_at)} for ${n(C.posts)} posts (${C.topics} topics, ${n(C.claims)} claims).` : "Not computed yet."}
        ${App.can("io.import") ? `<div style="margin-top:8px"><button class="btn sm" id="reEnrich">Re-run content analysis</button></div>` : ""}<div id="jobBox" style="margin-top:8px"></div></div></div>
    </div></div>`;
  if ($("#rqEdit")) $("#rqEdit").onclick = async () => { const r = await modal("Research question", `<label class="f" for="rqIn" style="margin-top:0">What should this analysis answer?</label><textarea id="rqIn" rows="3" maxlength="1000">${esc(d.research_question || "")}</textarea>`, [{ label: "Cancel", value: null }, { label: "Save", kind: "primary", value: m => $("#rqIn", m).value.trim() }]); if (r.value == null) return; try { await api.patch(`/api/io/datasets/${d.id}`, { research_question: r.value }); toast("Research question saved."); el.dispatchEvent(new CustomEvent("reload")); } catch (e) { fail(e); } };
  if ($("#reEnrich")) $("#reEnrich").onclick = async () => { const b = $("#reEnrich"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Analysing…'; try { const r = await api.post(`/api/io/datasets/${d.id}/enrich`); toast(`Content analysis updated: ${r.topics} topics, ${r.claims} claims.`); el.dispatchEvent(new CustomEvent("reload")); } catch (e) { fail(e); b.disabled = false; b.textContent = "Re-run content analysis"; } };
  wireAi(d, el);
}

// ---------------------------------------------------------------- local AI buttons and job progress
function aiButtons(d, M, tasks) {
  if (!App.can("io.import")) return "";
  const o = M.ollama, ok = o.configured && o.reachable && o.model_available;
  const L = { sentiment: "Classify tone with local AI", topics: "Label topics with local AI", summary: "Write a summary with local AI", claims: "Find claims with local AI" };
  return `<div class="row" style="margin-top:10px">${tasks.map(t => `<button class="btn sm" data-ai="${t}" ${ok ? "" : "disabled"}>${L[t]}</button>`).join("")}</div>
    <div class="tiny sub" style="margin-top:4px">${ok ? `Runs on ${esc(o.url)} with ${esc(o.model)}; post text stays on your network. Answers that do not match the required format are rejected and nothing is stored.` : `Local AI unavailable: ${esc(o.error || o.needs || "not configured")}`}</div><div class="aiStatus" aria-live="polite"></div>`;
}
function wireAi(d, el) {
  $$("[data-ai]").forEach(b => b.onclick = async () => {
    const st = b.parentElement.nextElementSibling.nextElementSibling; b.disabled = true;
    try { const { job } = await api.post(`/api/io/datasets/${d.id}/ai`, { task: b.dataset.ai }); await follow(job, st); el.dispatchEvent(new CustomEvent("reload")); }
    catch (e) { st.innerHTML = `<div class="callout bad" style="margin-top:6px"><div>${esc(errMsg(e))}</div></div>`; b.disabled = false; }
  });
}
export async function follow(job, box, label = "Working") {
  for (;;) {
    const j = await api.get(`/api/io/jobs/${job}`);
    if (j.status === "done") { box.innerHTML = `<div class="callout info" style="margin-top:6px"><div>Done: ${esc(Object.entries(j.counts || {}).filter(([k, v]) => !["errors", "dataset_id", "skipped"].includes(k) && typeof v !== "object").map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", "))}.${j.counts?.errors?.length ? ` Problems: ${esc(j.counts.errors.join("; "))}` : ""}</div></div>`; toast("Finished."); return j; }
    if (j.status === "failed") { box.innerHTML = `<div class="callout bad" style="margin-top:6px"><div>Failed: ${esc(j.error)}</div></div>`; throw Object.assign(new Error(j.error), { shown: true }); }
    box.innerHTML = `<div class="small" style="margin-top:6px"><span class="spin"></span> ${esc(label)}… ${Math.round((j.progress || 0) * 100)}%</div>`;
    await new Promise(r => setTimeout(r, 700));
  }
}

// ---------------------------------------------------------------- sentiment
export function sentimentTab(body, d, I, A, M, el) {
  if (I.empty) return void (body.innerHTML = emptyFiltered(d, "sentiment"));
  const S = I.sentiment, c = S.counts, cols = Object.fromEntries(SK.map(k => [k, SENT[k][1]]));
  body.innerHTML = `${S.unclassified ? `<div class="callout info" style="margin-bottom:12px"><div>${n(S.unclassified)} posts have no tone yet (imported before this version). Use <b>Re-run content analysis</b> on the Overview.</div></div>` : ""}<div class="callout warn" style="margin-bottom:12px"><div><b>Estimated tone, not opinion.</b> ${esc(M.limitations[0])} <a href="#" id="evalLink">How accurate is it?</a></div></div>
    <div class="kpis">${SK.map(k => kpi(SENT[k][0], `${pct(c[k], I.posts)}%`, `${n(c[k])} posts`, postsLink(d, { sentiment: k }))).join("")}${kpi("Mean confidence", S.mean_confidence ?? "—", "the method's own estimate")}</div>
    <div class="split"><div class="stack"><div class="card"><div class="hd"><h3>Tone over time (per ${I.bucket})</h3></div><div class="bd">${stacked(S.series, SK, cols, { label: "Tone over time" })}${legend(SK)}</div></div>
      <div class="card"><div class="hd"><h3>Tone by theme</h3></div><div class="tablewrap"><table class="t"><thead><tr><th>Theme</th><th class="n">Posts</th><th>Tone</th><th class="n">Negative</th><th class="n">Positive</th></tr></thead><tbody>${I.themes.map(t => `<tr><td><a href="#/monitor/${d.id}/sentiment?${filterQuery({ ...readFilters(), theme: t.key })}">${esc(t.label)}</a></td><td class="n">${n(t.posts)}</td><td>${sentBar(t.sentiment)}</td><td class="n">${pct(t.sentiment.negative, t.posts)}%</td><td class="n">${pct(t.sentiment.positive, t.posts)}%</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No themes in these posts.</td></tr>`}</tbody></table></div></div></div>
    <div class="stack"><div class="card"><div class="hd"><h3>Tone by platform</h3></div><div class="tablewrap"><table class="t"><thead><tr><th>Platform</th><th>Tone</th>${SK.map(k => `<th class="n">${SENT[k][0].split(" ")[0]}</th>`).join("")}</tr></thead><tbody>${S.by_platform.map(p => `<tr><td>${esc(p.platform)}</td><td>${sentBar(p)}</td>${SK.map(k => `<td class="n">${n(p[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>
      <div class="card"><div class="hd"><h3>Method</h3></div><div class="bd small"><ul style="margin:0 0 0 18px">${S.methods.map(m => `<li>${m.method === "lexicon-1" ? "English and Kiswahili word list (rule-based)" : `Local AI model <b>${esc(m.method.replace("ollama:", ""))}</b>`}: ${n(m.posts)} posts</li>`).join("")}</ul>
        <p class="muted">Open a post list to read examples of each tone and judge the estimate yourself: ${SK.map(k => `<a href="${postsLink(d, { sentiment: k })}">${SENT[k][0].toLowerCase()}</a>`).join(", ")}.</p>${aiButtons(d, M, ["sentiment"])}</div></div></div></div>`;
  $("#evalLink").onclick = async e => { e.preventDefault(); try { const r = await api.get("/api/social/sentiment-evaluation"), row = (l, x) => `<tr><td>${l}</td><td class="n">${x.items}</td><td class="n">${Math.round(x.accuracy * 100)}%</td></tr>`;
    modal("Measured accuracy of the word list", `<p class="small">${esc(r.description)}</p><table class="t"><thead><tr><th>Sentences</th><th class="n">Items</th><th class="n">Correct</th></tr></thead><tbody>${row("All", r.overall)}${row("English", r.english)}${row("Kiswahili", r.kiswahili)}</tbody></table>
      <table class="t" style="margin-top:8px"><thead><tr><th>Tone</th><th class="n">Precision</th><th class="n">Recall</th><th class="n">F1</th></tr></thead><tbody>${SK.map(k => `<tr><td>${SENT[k][0]}</td><td class="n">${r.overall.classes[k].precision}</td><td class="n">${r.overall.classes[k].recall}</td><td class="n">${r.overall.classes[k].f1}</td></tr>`).join("")}</tbody></table>
      <p class="small muted">Real posts use slang, Sheng, sarcasm and mixed languages, so expect lower accuracy on them. To measure it on your own data, label a sample of posts by hand and compare.</p>`, undefined, { wide: true }); } catch (er) { fail(er); } };
  wireAi(d, el);
}

// ---------------------------------------------------------------- topics, narratives, keywords, comparison
export function topicsTab(body, d, I, A, M, el) {
  if (I.empty) return void (body.innerHTML = emptyFiltered(d, "topics"));
  const opts = [...I.themes.map(t => [`theme:${t.key}`, `Theme: ${t.label}`]), ...(I.topicsAll || []).map(t => [`topic:${t.topic_no}`, `Topic ${t.topic_no}: ${t.label}`]), ...I.keywords.slice(0, 15).map(k => [`q:${k.term}`, `Keyword: ${k.term}`])];
  body.innerHTML = `<div class="split"><div class="stack">
      <div class="card"><div class="hd"><h3>Themes</h3><span class="small sub right">Keyword lists, English and Kiswahili</span></div><div class="tablewrap"><table class="t"><thead><tr><th>Theme</th><th class="n">Posts</th><th>Trend</th><th>Tone</th><th>Change</th></tr></thead><tbody>
        ${I.themes.map(t => `<tr><td><a href="#/monitor/${d.id}/topics?${filterQuery({ ...readFilters(), theme: t.key })}">${esc(t.label)}</a></td><td class="n">${n(t.posts)}</td><td>${spark(t.series)}</td><td>${sentBar(t.sentiment)}</td><td class="small">${t.emerging ? `<span class="chip warn">growing ×${t.ratio}</span>` : `<span class="sub">${t.early} → ${t.late}</span>`}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No theme found.</td></tr>`}
        </tbody></table></div><div class="bd tiny sub">${n(I.no_theme)} posts have no theme. “Change” compares the last third of the period with the rest.</div></div>
      <div class="card"><div class="hd"><h3>Topics found in this dataset</h3><span class="small sub right">Keyword clusters (k-means)</span></div><div class="tablewrap"><table class="t"><thead><tr><th>Topic</th><th>Key terms</th><th class="n">Posts</th><th>Trend</th><th>Tone</th></tr></thead><tbody>
        ${I.topics.map(t => `<tr><td><a href="#/monitor/${d.id}/topics?${filterQuery({ ...readFilters(), topic: t.topic_no })}"><b>${t.topic_no}.</b> ${esc(t.label)}</a>${t.label_source !== "terms" ? ` <span class="chip info" title="${esc(t.summary || "")}">AI label</span>` : ""}${t.emerging ? ` <span class="chip warn">growing ×${t.ratio}</span>` : ""}${t.summary ? `<div class="tiny sub">${esc(t.summary)}</div>` : ""}</td><td class="small">${t.terms.map(esc).join(", ")}</td><td class="n">${n(t.posts)}</td><td>${spark(t.series)}</td><td>${sentBar(t.sentiment)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Too few posts to form topics.</td></tr>`}
        </tbody></table></div><div class="bd small">${n(I.unclustered)} posts are not in a topic (too short or too different).${aiButtons(d, M, ["topics"])}</div></div>
      <div class="card"><div class="hd"><h3>Compare two topics</h3></div><div class="bd"><div class="grid g2"><div><label class="f" for="cmpA" style="margin-top:0">First</label><select id="cmpA">${opts.map(([v, l], i) => `<option value="${esc(v)}" ${i === 0 ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
        <div><label class="f" for="cmpB" style="margin-top:0">Second</label><select id="cmpB">${opts.map(([v, l], i) => `<option value="${esc(v)}" ${i === 1 ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div></div>
        <button class="btn sm" id="cmpGo" style="margin-top:10px" ${opts.length < 2 ? "disabled" : ""}>Compare</button><div id="cmpOut" style="margin-top:10px" aria-live="polite"></div></div></div>
    </div><div class="stack">
      <div class="card"><div class="hd"><h3>Keywords</h3></div><div class="bd">${hbars(I.keywords.slice(0, 20).map(k => ({ l: k.term, v: k.count, href: postsLink(d, { q: k.term }), s: `${n(k.posts)} posts` })))}
        ${I.phrases.length ? `<div class="small" style="margin-top:10px"><b>Repeated phrases:</b> ${I.phrases.slice(0, 12).map(p => `<a class="chip grey" href="${postsLink(d, { q: p.term })}">${esc(p.term)} (${p.count})</a>`).join(" ")}</div>` : ""}</div></div>
      <div class="card"><div class="hd"><h3>Hashtags</h3><a class="small right" href="#/monitor/${d.id}/hashtags">Bursts</a></div><div class="bd">${I.hashtags.length ? hbars(I.hashtags.slice(0, 15).map(h => ({ l: h.tag, v: h.posts, href: postsLink(d, { q: h.tag }), s: `${n(h.accounts)} accounts` }))) : `<p class="small muted" style="margin:0">No hashtags in these posts.</p>`}</div></div>
      <div class="card"><div class="hd"><h3>Duplicates</h3></div><div class="bd small">${n(I.duplicates.identical_groups)} groups of identical wording cover ${n(I.duplicates.posts_in_groups)} of these posts. Near-identical messages across the whole dataset are in <a href="#/monitor/${d.id}/messages">Repeated messages</a>.</div></div>
    </div></div>`;
  wireAi(d, el);
  if ($("#cmpGo")) $("#cmpGo").onclick = async () => {
    const out = $("#cmpOut"), pick = v => { const [k, x] = v.split(/:(.*)/); return { [k]: x }; }, A1 = $("#cmpA").value, B1 = $("#cmpB").value;
    if (A1 === B1) { out.innerHTML = `<div class="callout warn"><div>Choose two different items.</div></div>`; return; }
    out.innerHTML = `<span class="spin"></span> Comparing…`;
    try {
      const base = readFilters(), [a, b] = await Promise.all([A1, B1].map(v => api.get(`/api/io/datasets/${d.id}/insights?${filterQuery({ ...base, ...pick(v) })}`).then(r => r.insights)));
      const name = v => opts.find(o => o[0] === v)[1], row = (l, f) => `<tr><td>${l}</td><td class="n">${f(a)}</td><td class="n">${f(b)}</td></tr>`, eng = x => x.empty ? "—" : n(Object.values(x.engagement.totals).reduce((s, v) => s + v, 0));
      const align = (x, y) => { if (x.empty || y.empty) return [x.timeline || [], y.timeline || []]; const s = Math.min(Date.parse(x.bucket_start), Date.parse(y.bucket_start)), ms = x.bucket === "day" || y.bucket === "day" ? 864e5 : 3600e3, e = Math.max(Date.parse(x.last_at), Date.parse(y.last_at)), len = Math.min(400, Math.floor((e - s) / ms) + 1);
        const place = z => { const r = new Array(len).fill(0); const zs = Date.parse(z.bucket_start), zm = z.bucket === "day" ? 864e5 : 3600e3; z.timeline.forEach((v, i) => { const k = Math.min(len - 1, Math.floor((zs + i * zm - s) / ms)); r[k] += v; }); return r; }; return [place(x), place(y)]; };
      out.innerHTML = `<table class="t"><thead><tr><th></th><th class="n">${esc(name(A1))}</th><th class="n">${esc(name(B1))}</th></tr></thead><tbody>${row("Posts", x => n(x.posts))}${row("Accounts", x => n(x.accounts || 0))}${row("Negative tone", x => x.empty ? "—" : `${pct(x.sentiment.counts.negative, x.posts)}%`)}${row("Positive tone", x => x.empty ? "—" : `${pct(x.sentiment.counts.positive, x.posts)}%`)}${row("Engagement (likes + comments + shares + views in data)", eng)}${row("First post", x => dt(x.first_at))}${row("Last post", x => dt(x.last_at))}</tbody></table>
        <div style="margin-top:8px">${lines(align(a, b), { names: [name(A1), name(B1)] })}</div><div class="legend small"><span><i style="background:var(--teal-600, #0f766e)"></i>${esc(name(A1))} (solid)</span><span><i style="background:var(--con)"></i>${esc(name(B1))} (dashed)</span></div>`;
    } catch (e) { out.innerHTML = `<div class="callout bad"><div>${esc(errMsg(e))}</div></div>`; }
  };
}

// ---------------------------------------------------------------- engagement
export function engagementTab(body, d, I) {
  if (I.empty) return void (body.innerHTML = emptyFiltered(d, "engagement"));
  const E = I.engagement, F = ["likes", "comments", "shares", "views"], have = F.filter(f => E.available[f]);
  if (!have.length) return void (body.innerHTML = `<div class="card"><div class="bd">${empty("No engagement counts in this data", "The imported posts have no likes, comments, shares or views columns. AIVS does not estimate them.")}</div></div>`);
  body.innerHTML = `<div class="callout info" style="margin-bottom:12px"><div>${esc(E.note)} Counts are present for ${n(E.posts_with_engagement)} of ${n(I.posts)} posts.</div></div>
    <div class="kpis">${F.map(f => kpi(f[0].toUpperCase() + f.slice(1), E.available[f] ? n(E.totals[f]) : "—", E.available[f] ? `median ${n(E.median_per_post[f])} per post · ${n(E.available[f])} posts` : "not in the data")).join("")}${kpi("Unusual engagement", n(E.unusual.posts), "posts far above the median")}</div>
    <div class="split"><div class="stack"><div class="card"><div class="hd"><h3>Engagement per ${I.bucket}</h3><select id="engM" class="right" aria-label="Measure">${have.map(f => `<option value="${f}">${f}</option>`).join("")}</select></div><div class="bd" id="engChart"></div></div>
      <div class="card"><div class="hd"><h3>Content with the most engagement</h3><span class="small sub right">Likes + comments + shares</span></div><div class="tablewrap"><table class="t"><thead><tr><th>Post</th><th class="n">Likes</th><th class="n">Comments</th><th class="n">Shares</th><th class="n">Views</th></tr></thead><tbody>
        ${E.top.map(p => `<tr><td class="small"><div>${esc(p.text)}</div><div class="tiny sub">${esc(p.platform || "")} · ${esc(p.account)} · ${dt(p.posted_at)}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer nofollow">open</a>` : ""}</div></td>${["likes", "comments", "shares", "views"].map(f => `<td class="n">${p[f] == null ? "—" : n(p[f])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div></div>
    <div class="stack"><div class="card"><div class="hd"><h3>By platform</h3></div><div class="tablewrap"><table class="t"><thead><tr><th>Platform</th><th class="n">Posts</th>${have.map(f => `<th class="n">${f}</th>`).join("")}</tr></thead><tbody>${E.by_platform.map(p => `<tr><td>${esc(p.platform)}</td><td class="n">${n(p.posts)}</td>${have.map(f => `<td class="n">${n(p[f])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>
      <div class="card"><div class="hd"><h3>Unusual engagement (indicator)</h3></div><div class="bd small">${E.unusual.posts ? `<p style="margin-top:0">${n(E.unusual.posts)} post${E.unusual.posts > 1 ? "s have" : " has"} ${esc(E.unusual.rule)}.</p><ul style="margin:0 0 0 18px">${E.unusual.examples.map(x => `<li><a href="#/monitor/${d.id}/posts?ids=${x.id}">${esc(x.text)}</a> <span class="sub">(${n(x.engagement)})</span></li>`).join("")}</ul>` : "No post stands out from the others."}
        <p class="muted">Viral posts are often genuine. Check the platform's current counts and the account's history before reading anything into this.</p></div></div></div></div>`;
  const draw = () => { const f = $("#engM").value; $("#engChart").innerHTML = lines([E.series[f]], { names: [f] }); };
  $("#engM").onchange = draw; draw();
}

// ---------------------------------------------------------------- claims
const CST = { needs_review: ["Needs review", "warn"], unreviewed: ["Not reviewed", "grey"], in_case: ["Being verified", "info"], dismissed: ["No verification needed", "grey"] };
export async function claimsTab(body, d, I, A, M, el) {
  const qp = new URLSearchParams(location.hash.split("?")[1] || ""), status = qp.get("status") || "", q = qp.get("cq") || "", offset = +qp.get("offset") || 0, limit = 20;
  const r = await api.get(`/api/io/datasets/${d.id}/claims?${new URLSearchParams({ status, q, offset, limit, ...(readFilters().theme ? { theme: readFilters().theme } : {}) })}`);
  const go = o => App.go(`#/monitor/${d.id}/claims?${new URLSearchParams({ ...Object.fromEntries(qp), ...o })}`), C = r.counts, all = Object.values(C).reduce((a, b) => a + b, 0);
  body.innerHTML = `<div class="callout warn" style="margin-bottom:12px"><div><b>Claims are not findings.</b> AIVS lists statements that can be checked. A published fact-check about a similar claim, or a red flag, is a reason to look closer. A verdict needs evidence and a reviewer, in a verification case.</div></div>
    <nav class="tabs" aria-label="Claim status"><a href="#/monitor/${d.id}/claims" class="${!status ? "on" : ""}">All <span class="sub">${n(all)}</span></a>${Object.entries(CST).map(([k, [l]]) => `<a href="#/monitor/${d.id}/claims?status=${k}" class="${status === k ? "on" : ""}">${l} <span class="sub">${n(C[k] || 0)}</span></a>`).join("")}</nav>
    <div class="row" style="margin-bottom:10px"><input type="search" id="cq" value="${esc(q)}" placeholder="Search claims" style="flex:1;min-width:200px"><button class="btn sm" id="cqGo">Search</button>${aiButtons(d, M, ["claims"]).replace('<div class="row" style="margin-top:10px">', '<div class="row">')}</div>
    ${r.claims.length ? r.claims.map(c => `<div class="card" style="margin-bottom:10px"><div class="bd">
      <div class="row" style="align-items:flex-start"><div style="flex:1;min-width:0"><b>${esc(c.text)}</b><div class="tiny sub">${n(c.posts)} post${c.posts > 1 ? "s" : ""} · ${n(c.accounts)} account${c.accounts > 1 ? "s" : ""} · first ${dt(c.first_at)}${c.extracted_by !== "rules" ? ` · found by local AI (${esc(c.extracted_by.replace("ollama:", ""))})` : ""}</div></div><span class="chip ${CST[c.status][1]}">${CST[c.status][0]}</span></div>
      ${c.flags.length ? `<div class="small" style="margin-top:8px"><b>Red flags</b><ul style="margin:2px 0 0 18px">${c.flags.map(f => `<li>${esc(f.text)} <span class="sub">Check: ${esc(f.check)}</span></li>`).join("")}</ul></div>` : ""}
      ${c.kb.length ? `<div class="small" style="margin-top:8px"><b>Similar published fact-checks</b> <span class="sub">(approved datasets; similar is not necessarily the same claim)</span>${c.kb.map(k => `<div class="cite"><span class="chip ${k.label === "contradicted" ? "con" : k.label === "supported" ? "sup" : "grey"}">rated “${esc(k.rating)}”</span> ${esc(k.claim)} <span class="sub">${esc(k.publisher || k.dataset)}</span>${k.url ? ` · <a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer nofollow">source</a>` : ""} <span class="sub">· source type: published fact-check</span></div>`).join("")}</div>` : ""}
      ${c.case_id ? `<div class="small" style="margin-top:8px"><b>Verification case <a href="#/case/${esc(c.case_id)}/claims">${esc(c.case_id)}</a></b>: ${esc(c.case_status || "")}${c.case_conclusion ? `, conclusion <b>${esc(c.case_conclusion)}</b>` : ", no conclusion yet"}
        ${c.case_evidence.length ? `<ul style="margin:4px 0 0 18px">${c.case_evidence.map(e => `<li><span class="chip ${e.stance === "supports" ? "sup" : e.stance === "contradicts" ? "con" : "grey"}">${e.stance === "supports" ? "supporting" : e.stance === "contradicts" ? "contradicting" : "context"}</span> ${esc(e.text)}${e.source_url ? ` <a href="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer nofollow">source</a>` : ""}</li>`).join("")}</ul>` : `<div class="sub">No accepted evidence yet.</div>`}</div>` : ""}
      ${c.note ? `<div class="tiny sub" style="margin-top:6px">Note${c.reviewed_by_name ? ` by ${esc(c.reviewed_by_name)}` : ""}: ${esc(c.note)}</div>` : ""}
      <div class="row" style="margin-top:10px"><a class="btn sm ghost" href="#/monitor/${d.id}/posts?ids=${c.post_ids.slice(0, 200).join(",")}">See the posts</a>
        ${!c.case_id && App.can("case.create") ? `<button class="btn sm primary" data-cc="${c.id}">Verify in a case</button>` : ""}
        ${!c.case_id && App.can("io.import") ? `${c.status !== "needs_review" ? `<button class="btn sm" data-cs="${c.id}" data-to="needs_review">Mark needs review</button>` : ""}${c.status !== "dismissed" ? `<button class="btn sm ghost" data-cs="${c.id}" data-to="dismissed">No verification needed</button>` : `<button class="btn sm ghost" data-cs="${c.id}" data-to="unreviewed">Reopen</button>`}` : ""}</div></div></div>`).join("")
      : `<div class="card"><div class="bd">${empty(all ? "No claims match" : "No checkable claims found", all ? "Change the status or search." : "No post contains a statement AIVS recognises as checkable. Opinions, questions and calls to share are not listed.")}</div></div>`}
    ${r.total > limit ? `<div class="row"><button class="btn sm" id="cPrev" ${offset ? "" : "disabled"}>Previous</button><span class="small sub">${offset + 1}–${Math.min(r.total, offset + limit)} of ${n(r.total)}</span><button class="btn sm" id="cNext" ${offset + limit < r.total ? "" : "disabled"}>Next</button></div>` : ""}`;
  $("#cqGo").onclick = () => go({ cq: $("#cq").value.trim(), offset: 0 }); $("#cq").onkeydown = e => e.key === "Enter" && $("#cqGo").click();
  if ($("#cPrev")) { $("#cPrev").onclick = () => go({ offset: Math.max(0, offset - limit) }); $("#cNext").onclick = () => go({ offset: offset + limit }); }
  $$("[data-cc]").forEach(b => b.onclick = async () => { if (!(await confirmBox("Open a verification case?", `A case is created with this claim as the content to verify${d.is_sample ? " (a training case, because the dataset is synthetic)" : ""}. The dataset and claim are recorded in the audit log.`, "Open case"))) return; b.disabled = true; try { const x = await api.post(`/api/io/claims/${b.dataset.cc}/case`); refreshNavCounts(); toast(`Case ${x.id} opened.`); App.go(`#/case/${x.id}/claims`); } catch (e) { fail(e); b.disabled = false; } });
  $$("[data-cs]").forEach(b => b.onclick = async () => {
    let note = "";
    if (b.dataset.to === "dismissed") { const m = await modal("No verification needed", `<label class="f" for="cNote" style="margin-top:0">Why? <span class="req">*</span></label><input type="text" id="cNote" maxlength="500" placeholder="e.g. not a factual claim; out of scope; already verified elsewhere">`, [{ label: "Cancel", value: null }, { label: "Save", kind: "primary", validate: x => (!$("#cNote", x).value.trim() ? "Give a reason." : null), value: x => $("#cNote", x).value.trim() }]); if (m.value == null) return; note = m.value; }
    try { await api.patch(`/api/io/claims/${b.dataset.cs}`, { status: b.dataset.to, note }); toast("Claim updated."); el.dispatchEvent(new CustomEvent("reload")); } catch (e) { fail(e); }
  });
  wireAi(d, el);
}

// ---------------------------------------------------------------- geography
export function geographyTab(body, d, I) {
  if (I.empty) return void (body.innerHTML = emptyFiltered(d, "geography"));
  const G = I.geography, R = G.recorded, known = R.post + R.profile;
  const map = (items, color) => { const pts = items.filter(x => x.xy); if (!pts.length) return `<p class="small muted">No Kenyan county can be placed on the map from these records.</p>`;
    const X = lon => ((lon - 33.8) / (42.0 - 33.8)) * 400 + 20, Y = lat => ((5.2 - lat) / (5.2 + 4.9)) * 480 + 10, max = Math.max(...pts.map(p => p.posts));
    return `<svg viewBox="0 0 440 500" style="width:100%;max-width:440px;height:auto;display:block;margin:0 auto;background:var(--surface-2);border-radius:8px" role="img" aria-label="Posts by county (schematic)">
      <text x="430" y="490" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">schematic: approximate county centres, not boundaries</text>
      ${pts.map(p => `<g><circle cx="${X(p.xy[1]).toFixed(1)}" cy="${Y(p.xy[0]).toFixed(1)}" r="${(5 + 22 * Math.sqrt(p.posts / max)).toFixed(1)}" fill="${color}" fill-opacity=".45" stroke="${color}"><title>${esc(p.name)}: ${p.posts}</title></circle><text x="${X(p.xy[1]).toFixed(1)}" y="${(Y(p.xy[0]) + 3).toFixed(1)}" text-anchor="middle" font-size="10" fill="currentColor">${esc(p.name)}</text></g>`).join("")}</svg>`; };
  const BAS = { post: "Location field in the data", profile: "Self-reported profile location" };
  body.innerHTML = `<div class="callout info" style="margin-bottom:12px"><div>${esc(G.note)}</div></div>
    <div class="kpis">${kpi("Location field in the data", n(R.post), `${pct(R.post, I.posts)}% of posts`)}${kpi("Self-reported profile", n(R.profile), `${pct(R.profile, I.posts)}% of posts`)}${kpi("Unknown", n(R.unknown), `${pct(R.unknown, I.posts)}% of posts`)}${kpi("Places named in text", n(G.mentioned.length), "inferred topics, not locations")}</div>
    ${known < I.posts * 0.2 ? `<div class="callout warn" style="margin-bottom:12px"><div>Most posts carry no location, so these summaries are not representative of where discussion happens.</div></div>` : ""}
    <div class="split"><div class="card"><div class="hd"><h3>Posts by county</h3><div class="seg right" role="tablist" aria-label="Location basis"><button type="button" class="on" data-gb="post">Data field</button><button type="button" data-gb="profile">Self-reported</button><button type="button" data-gb="text">Named in text</button></div></div><div class="bd" id="gmap"></div></div>
      <div class="stack"><div class="card"><div class="hd"><h3>Counties</h3></div><div class="tablewrap"><table class="t"><thead><tr><th>County</th><th>Basis</th><th class="n">Posts</th></tr></thead><tbody>${G.counties.map(c => `<tr><td>${esc(c.name)}</td><td class="small">${BAS[c.basis]}</td><td class="n">${n(c.posts)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No county in the location fields.</td></tr>`}</tbody></table></div></div>
        <div class="card"><div class="hd"><h3>Countries</h3></div><div class="tablewrap"><table class="t"><thead><tr><th>Country</th><th>Basis</th><th class="n">Posts</th></tr></thead><tbody>${G.countries.map(c => `<tr><td>${esc(c.name)}</td><td class="small">${BAS[c.basis]}</td><td class="n">${n(c.posts)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No country in the location fields.</td></tr>`}</tbody></table></div></div>
        <div class="card"><div class="hd"><h3>Places named in the text</h3></div><div class="bd">${G.mentioned.length ? hbars(G.mentioned.slice(0, 15).map(m => ({ l: m.name, v: m.posts, href: postsLink(d, { q: m.name }) }))) : `<p class="small muted" style="margin:0">No Kenyan county or major town is named.</p>`}<div class="tiny sub" style="margin-top:6px">What the posts talk about, not where the posters are.</div></div></div></div></div>`;
  const show = b => { $$("[data-gb]").forEach(x => x.classList.toggle("on", x.dataset.gb === b)); $("#gmap").innerHTML = b === "text" ? map(G.mentioned, "var(--mix)") : map(G.counties.filter(c => c.basis === b), b === "post" ? "var(--teal-600, #0f766e)" : "var(--info, #1c5d99)"); };
  $$("[data-gb]").forEach(x => x.onclick = () => show(x.dataset.gb)); show("post");
}

// ---------------------------------------------------------------- report
export async function reportTab(body, d, I) {
  const f = readFilters(), q = filterQuery(f), { reports } = await api.get(`/api/io/datasets/${d.id}/reports`);
  const link = fmt => `/api/io/datasets/${d.id}/report.${fmt}?${filterQuery({ ...f, research_question: $("#rrq")?.value.trim() || d.research_question || "" })}`;
  body.innerHTML = `<div class="split"><div class="card"><div class="hd"><h3>Generate a report</h3></div><div class="bd">
      <p class="small" style="margin-top:0">The report covers ${Object.keys(f).length ? `the <b>${n(I.posts)}</b> posts matching the current filters (${esc(Object.entries(f).map(([k, v]) => `${k}: ${v}`).join("; "))})` : `all <b>${n(I.dataset_posts)}</b> posts`}. It contains the executive summary, research question, dataset and collection period, methodology, tone, topics and narratives, engagement, geography, coordination indicators, claims with their evidence, limitations and recommendations. Every figure is computed from the stored posts.</p>
      <label class="f" for="rrq">Research question</label><textarea id="rrq" rows="2" maxlength="1000" placeholder="What should this report answer?">${esc(d.research_question || "")}</textarea>
      <div class="row" style="margin-top:12px"><a class="btn primary" data-rf="html" target="_blank" rel="noopener">View report</a><a class="btn" data-rf="pdf">Download PDF</a><a class="btn" data-rf="csv">CSV</a><a class="btn" data-rf="json">JSON</a></div>
      <div class="hint">Each report is stored with its content fingerprint (SHA-256) and an input fingerprint of the posts and settings it was built from, and the generation is written to the audit log.</div></div></div>
    <div class="card"><div class="hd"><h3>Earlier reports</h3></div>${reports.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Report</th><th>Filters</th><th>Download</th></tr></thead><tbody>${reports.map(r => `<tr><td class="small"><b>#${r.id}</b> ${dt(r.created_at)}<div class="tiny sub">${esc(r.by_name || "")} · SHA-256 ${esc(r.content_sha256.slice(0, 12))}…</div></td><td class="small">${esc(Object.entries(r.filters).map(([k, v]) => `${k}: ${v}`).join("; ") || "all posts")}</td><td class="small">${["html", "pdf", "csv", "json"].map(fm => `<a href="/api/io/reports/${r.id}.${fm}" ${fm === "html" ? 'target="_blank" rel="noopener"' : ""}>${fm.toUpperCase()}</a>`).join(" · ")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="bd">${empty("No reports yet", "Generated reports are listed here and can be downloaded again exactly as they were.")}</div>`}</div></div>`;
  const upd = () => $$("[data-rf]").forEach(a => (a.href = link(a.dataset.rf)));
  $("#rrq").oninput = upd; upd();
  $$("[data-rf]").forEach(a => a.addEventListener("click", () => setTimeout(() => App.go(`#/monitor/${d.id}/report${q ? `?${q}` : ""}`), 1500)));
}

// ---------------------------------------------------------------- list page: collection, status and local AI
export function collectCard(M) {
  if (!App.can("io.import")) return "";
  const usable = M.collectors.filter(c => ["news", "youtube", "x"].includes(c.key));
  return `<div class="card"><div class="hd"><h3>Collect public posts</h3></div><div class="bd">
    <label class="f" for="csrc" style="margin-top:0">Source</label><select id="csrc">${usable.map(c => `<option value="${c.key}" ${c.state === "ready" ? "" : "disabled"}>${esc(c.label)}${c.state === "ready" ? "" : " (not configured)"}</option>`).join("")}${M.collectors.filter(c => c.state === "pending").map(c => `<option disabled>${esc(c.label)} (pending access)</option>`).join("")}</select>
    <div id="cfeeds"><label class="f" for="cfd">News website or feed addresses, one per line <span class="req">*</span></label><textarea id="cfd" rows="3" placeholder="https://www.example-news.co.ke"></textarea><div class="hint">A website's home page is enough: AIVS uses the news feed (RSS or Atom) the site announces, and tells you if it has none.</div></div>
    <label class="f" for="cq2">Search words</label><input type="text" id="cq2" maxlength="300" placeholder="e.g. water Garissa (for news: only items containing all the words)">
    <div class="grid g3"><div><label class="f" for="cfrom">From</label><input type="date" id="cfrom"></div><div><label class="f" for="cto">To</label><input type="date" id="cto"></div><div><label class="f" for="cmax">At most</label><input type="number" id="cmax" min="1" max="500" value="100"></div></div>
    <label class="f" for="cname">New dataset name <span class="req">*</span></label><input type="text" id="cname" maxlength="200" placeholder="e.g. County news on water, October">
    <label class="f" for="cauth">Basis for collecting and using these posts <span class="req">*</span></label><input type="text" id="cauth" maxlength="1000" placeholder="e.g. public news feeds under our data policy; YouTube API terms">
    <label class="f" for="crq">Research question</label><input type="text" id="crq" maxlength="1000">
    <div id="cerr" class="callout bad" style="margin-top:10px" hidden></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="cgo">Collect</button></div><div id="cjob" aria-live="polite"></div>
    <div class="hint">Only official access is used: public feeds and documented APIs with keys set by your administrator. AIVS does not scrape, log in or work around privacy settings. Requests are counted under Administration → Usage &amp; storage.</div></div></div>`;
}
export function wireCollect() {
  const src = $("#csrc"); if (!src) return;
  const sync = () => { $("#cfeeds").hidden = src.value !== "news"; }; src.onchange = sync; sync();
  $("#cgo").onclick = async () => {
    const err = $("#cerr"); err.hidden = true; const b = $("#cgo");
    const body = { source: src.value, feeds: $("#cfd").value, query: $("#cq2").value.trim(), from: $("#cfrom").value || undefined, to: $("#cto").value || undefined, max: +$("#cmax").value || 100, name: $("#cname").value.trim(), authorisation: $("#cauth").value.trim(), research_question: $("#crq").value.trim() };
    const miss = [!body.name && "a dataset name", !body.authorisation && "the basis for collecting", src.value === "news" && !body.feeds.trim() && "at least one feed address", src.value !== "news" && !body.query && "search words"].filter(Boolean);
    if (miss.length) { err.hidden = false; err.textContent = `Add ${miss.join(", ")}.`; return; }
    b.disabled = true;
    try { const { job } = await api.post("/api/io/collect", body); const j = await follow(job, $("#cjob"), "Collecting"); if (j.counts?.dataset_id) App.go(`#/monitor/${j.counts.dataset_id}`); }
    catch (e) { if (!e.shown) { err.hidden = false; err.textContent = errMsg(e); } } finally { b.disabled = false; }
  };
}
export function statusCards(M) {
  const ST = { ready: ["Ready", "sup"], not_configured: ["Not configured", "grey"], pending: ["Pending access", "warn"] }, o = M.ollama;
  return `<div class="card"><div class="hd"><h3>Collection status</h3></div><div class="bd small"><ul style="margin:0 0 0 18px;line-height:1.7">${M.collectors.map(c => `<li><b>${esc(c.label)}</b> <span class="chip ${ST[c.state][1]}">${ST[c.state][0]}</span><div class="sub">${esc(c.note || "")}${c.needs ? ` Needs ${esc(c.needs)}.` : ""}</div></li>`).join("")}</ul></div>
      ${M.jobs.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Recent jobs</th><th>Status</th><th>Result</th></tr></thead><tbody>${M.jobs.slice(0, 8).map(j => `<tr><td class="small">${esc(j.kind.replace(/_/g, " "))}${j.dataset_id ? ` · <a href="#/monitor/${j.dataset_id}">dataset ${j.dataset_id}</a>` : ""}<div class="tiny sub">${dt(j.created_at)}${j.by_name ? ` · ${esc(j.by_name)}` : ""}</div></td><td><span class="chip ${j.status === "done" ? "sup" : j.status === "failed" ? "con" : "info"}">${esc(j.status)}</span></td><td class="small">${j.error ? esc(j.error.slice(0, 140)) : j.counts ? esc(Object.entries(j.counts).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")) : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>
    <div class="card"><div class="hd"><h3>Local AI (Ollama)</h3><span class="chip ${o.configured && o.model_available ? "sup" : "grey"} right">${o.configured ? (o.reachable ? (o.model_available ? "Ready" : "Model missing") : "Not reachable") : "Not configured"}</span></div><div class="bd small">
      ${o.configured ? `<dl class="kv"><dt>Server</dt><dd class="mono">${esc(o.url)}</dd><dt>Model</dt><dd class="mono">${esc(o.model)}</dd><dt>Batch size</dt><dd>${o.batch}</dd></dl>${o.error ? `<div class="callout warn" style="margin-top:8px"><div>${esc(o.error)}</div></div>` : ""}` : `<p style="margin-top:0">Optional. Without it, everything on these pages still works with rule-based methods. To use it, install Ollama on this computer or an institution server and set ${esc(o.needs)}.</p>`}
      <p class="muted" style="margin-bottom:0">Used only when an analyst asks, for tone, topic labels, summaries and claim finding. Answers must match a strict format and cite only the posts provided, or they are rejected.</p></div></div>`;
}
