// Social media analysis report for a post dataset (with the filters the analyst chose). Built only from stored
// records and computed results; the content JSON is stored write-once by its SHA-256, so the same report can be
// downloaded again later in any format and checked against its fingerprint. Recomputing with the same data,
// filters and settings gives the same input fingerprint and the same findings.
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { insights, LIMITATIONS, SENTIMENT_LABELS, THEMES, filterSql } from "./social-analysis.js";
import { CAVEATS } from "./io.js";

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const fmt = iso => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");

export function buildReport(db, { dataset: d, filters, user, version, researchQuestion }) {
  const I = insights(db, d.id, filters), A = JSON.parse(d.analysis_json || "null"), E = JSON.parse(d.enrich_json || "null");
  const { where, params } = filterSql(filters);
  const ids = db.prepare(`SELECT p.id, p.text, p.sentiment FROM io_posts p WHERE ${where} ORDER BY p.id`).all({ ds: d.id, ...params });
  const input_sha256 = crypto.createHash("sha256").update(JSON.stringify([d.file_sha256, ids.map(r => [r.id, r.text, r.sentiment]), A?.params || null])).digest("hex");
  const idSet = new Set(ids.map(r => r.id));
  const claims = db.prepare("SELECT c.*, k.status AS case_status, k.conclusion AS case_conclusion, k.title AS case_title FROM io_claims c LEFT JOIN cases k ON k.id = c.case_id WHERE c.dataset_id = ? ORDER BY c.posts DESC").all(d.id)
    .map(c => ({ ...c, post_ids: JSON.parse(c.post_ids || "[]"), flags: JSON.parse(c.flags || "[]"), kb: JSON.parse(c.kb_json || "[]") })).filter(c => c.post_ids.some(i => idSet.has(i)));
  const evidence = id => db.prepare("SELECT e.id, e.kind, e.text, e.reference, e.source_url, e.source_title, e.source_publisher, e.rating, l.stance FROM evidence e LEFT JOIN evidence_links l ON l.evidence_id = e.id WHERE e.case_id = ? AND e.status = 'accepted'").all(id);
  const claimRows = claims.slice(0, 60).map(c => ({ id: c.id, text: c.text, posts: c.posts, accounts: c.accounts, first_at: c.first_at, status: c.status, case_id: c.case_id, case_status: c.case_status, case_conclusion: c.case_conclusion,
    red_flags: c.flags.map(f => f.text), published_fact_checks: c.kb.map(k => ({ claim: k.claim, rating: k.rating, publisher: k.publisher, url: k.url, dataset: k.dataset, similarity: k.similarity })),
    case_evidence: c.case_id ? evidence(c.case_id).map(e => ({ id: e.id, stance: e.stance || "context", text: e.text.slice(0, 300), source: e.source_url || e.reference })) : [] }));
  const S = I.sentiment, n = I.posts;
  const indicators = A ? { repeated_messages: A.summary.clusters, synchronised: A.summary.synchronised_clusters, hashtag_bursts: A.summary.hashtag_bursts, network_groups: A.summary.network_groups,
    top: A.clusters.filter(c => c.synchronised).slice(0, 5).map(c => ({ id: c.id, text: c.text.slice(0, 200), posts: c.posts, accounts: c.accounts, window_accounts: c.sync.accounts, first_at: c.first_at })), params: A.params, scope: "whole dataset (filters do not apply)" } : null;
  // executive summary: sentences generated from the numbers above, nothing else
  const top = (o, k) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[k === "k" ? 0 : 1];
  const exec = I.empty ? [`No posts match the selected filters (${d.posts} posts in the dataset).`] : [
    `${n.toLocaleString()} posts from ${I.accounts.toLocaleString()} accounts, posted between ${fmt(I.first_at)} and ${fmt(I.last_at)}${I.platforms.length ? ` on ${I.platforms.map(p => p.platform).join(", ")}` : ""}.`,
    `Estimated tone: ${["positive", "negative", "neutral", "mixed"].map(l => `${pct(S.counts[l], n)}% ${SENTIMENT_LABELS[l].toLowerCase()}`).join(", ")} (rule-based estimate; see limitations).`,
    I.themes.length ? `Most discussed themes: ${I.themes.slice(0, 3).map(t => `${t.label} (${t.posts})`).join(", ")}.` : "No predefined theme was found in these posts.",
    I.emerging.length ? `Growing late in the period: ${I.emerging.slice(0, 3).map(e => `${e.label} (×${e.ratio})`).join(", ")}.` : "No theme or topic grew markedly in the last third of the period.",
    indicators ? `${indicators.synchronised} repeated message${indicators.synchronised === 1 ? " was" : "s were"} posted in a synchronised way and ${indicators.hashtag_bursts} hashtag burst${indicators.hashtag_bursts === 1 ? " was" : "s were"} found in the whole dataset; these are indicators for review, not evidence of coordination.` : null,
    `${claims.length} checkable claim${claims.length === 1 ? "" : "s"} found; ${claims.filter(c => c.status === "needs_review").length} need review (red flags or matching published fact-checks), ${claims.filter(c => c.case_id).length} are being verified in cases.`
  ].filter(Boolean);
  const recs = [];
  if (claims.some(c => c.status === "needs_review" && !c.case_id)) recs.push("Open verification cases for the claims marked “needs review” and check them against the sources listed with each red flag.");
  if (claimRows.some(c => c.published_fact_checks.length)) recs.push("Read the matching published fact-checks in full: a similar claim is not necessarily the same claim, place or date.");
  if (indicators?.synchronised) recs.push("For synchronised messages, examine the accounts' history, creation dates and other posts outside this dataset before drawing any conclusion.");
  if (I.engagement?.unusual?.posts) recs.push("Check posts with unusually high engagement against the platform's current counts; counts change after collection.");
  if (I.geography && I.geography.recorded.post + I.geography.recorded.profile < n * 0.2) recs.push("Most posts carry no location: do not read the geographic summary as representative.");
  recs.push("Compare these results with posts collected another way (a different query, period or platform) before generalising.");
  const data = {
    kind: "aivs-social-media-analysis-report", version: 1, aivs_version: version, generated_at: new Date().toISOString(), generated_by: user?.display_name || user?.username || null,
    title: `Social media analysis: ${d.name}`, research_question: researchQuestion || d.research_question || null, synthetic: !!d.is_sample,
    dataset: { id: d.id, name: d.name, description: d.description, source: d.source, authorisation: d.authorisation, collection_method: d.collection_method || "file", file_sha256: d.file_sha256, posts: d.posts, accounts: d.accounts, imported_at: d.imported_at,
      provenance: db.prepare("SELECT collected_via, COUNT(*) n, MIN(collected_at) first, MAX(collected_at) last FROM io_posts WHERE dataset_id = ? GROUP BY collected_via ORDER BY n DESC LIMIT 10").all(d.id) },
    filters, collection_period: { first_post: I.first_at, last_post: I.last_at },
    executive_summary: exec,
    methodology: [
      `Sentiment: ${(S?.methods || []).map(m => `${m.method === "lexicon-1" ? "English/Kiswahili word list with negation and intensifiers (lexicon-1)" : `local AI model ${m.method.replace("ollama:", "")} via Ollama, validated JSON`} for ${m.posts} posts`).join("; ") || "not computed"}.`,
      `Themes: keyword lists in English and Kiswahili for ${Object.keys(THEMES).length} themes. Topics: k-means clustering of TF-IDF word vectors computed from this dataset${E ? ` (${E.topics} topics, vocabulary ${E.vocabulary} terms)` : ""}.`,
      `Narrative change: a theme or topic is marked as growing when its share of posts in the last third of the period is at least twice its earlier share, with at least 5 posts.`,
      indicators ? `Coordination indicators (whole dataset): near-identical messages by word-pair overlap ≥ ${indicators.params.min_similarity}; synchronised when ≥3 accounts post one message within ${indicators.params.window_min} minutes and a Poisson test (p < 0.01, corrected) or half of its accounts support it; hashtag bursts by a Poisson test (p < 0.001, ≥5 posts).` : "Coordination indicators: not computed.",
      "Claims: sentences classified as checkable statements by AIVS's rules, grouped when identical, compared with approved fact-check datasets in the AIVS knowledge base; human review decides every verdict in a verification case.",
      "Engagement: public counts as recorded in the data; unusual engagement is a robust outlier test (median and median absolute deviation on a log scale)."
    ],
    sentiment: I.empty ? null : { counts: S.counts, percent: Object.fromEntries(Object.entries(S.counts).map(([k, v]) => [k, pct(v, n)])), mean_confidence: S.mean_confidence, methods: S.methods, by_platform: S.by_platform },
    themes: I.themes?.map(t => ({ key: t.key, label: t.label, posts: t.posts, share: pct(t.posts, n), sentiment: t.sentiment, emerging: t.emerging, change_ratio: t.ratio })) || [],
    topics: I.topics?.map(t => ({ topic_no: t.topic_no, label: t.label, label_source: t.label_source, terms: t.terms, posts: t.posts, share: pct(t.posts, n), emerging: t.emerging, change_ratio: t.ratio, summary: t.summary })) || [],
    keywords: I.keywords?.slice(0, 25) || [], hashtags: I.hashtags?.slice(0, 20).map(h => ({ tag: h.tag, posts: h.posts, accounts: h.accounts })) || [], duplicates: I.duplicates || null,
    engagement: I.empty ? null : { totals: I.engagement.totals, median_per_post: I.engagement.median_per_post, posts_with_engagement: I.engagement.posts_with_engagement, by_platform: I.engagement.by_platform, unusual: { posts: I.engagement.unusual.posts, rule: I.engagement.unusual.rule }, note: I.engagement.note },
    geography: I.empty ? null : { recorded: I.geography.recorded, counties: I.geography.counties.slice(0, 20).map(({ xy, ...x }) => x), countries: I.geography.countries.slice(0, 20).map(({ xy, ...x }) => x), mentioned_in_text: I.geography.mentioned.slice(0, 20).map(({ xy, ...x }) => x), note: I.geography.note },
    coordination_indicators: indicators, claims: { total: claims.length, by_status: Object.fromEntries(["unreviewed", "needs_review", "in_case", "dismissed"].map(s => [s, claims.filter(c => c.status === s).length])), listed: claimRows },
    sources: I.sources || [], limitations: [...LIMITATIONS, ...CAVEATS.slice(1)], recommendations: recs,
    reproducibility: { input_sha256, posts_included: ids.length, analysis_params: A?.params || null, content_analysis: E ? { generated_at: E.generated_at, sentiment_method: E.sentiment_method, topics: E.topics } : null }
  };
  return data;
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const table = (head, rows) => `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${head.length}">None</td></tr>`}</tbody></table>`;
export function reportHtml(d, { sha256, id }) {
  const filt = Object.entries(d.filters || {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "none (all posts)";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>body{font:14px/1.5 system-ui,Segoe UI,Arial,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#0b1f3a}h1{font-size:22px}h2{font-size:15px;text-transform:uppercase;border-bottom:2px solid #0f766e;padding-bottom:3px;margin-top:28px}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}th,td{border:1px solid #c9d6dd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eef3f5}.m{color:#44596c;font-size:12px}.b{background:#5b3fc4;color:#fff;padding:6px 10px;border-radius:4px}a{color:#0f5f99;overflow-wrap:anywhere}</style></head><body>
${d.synthetic ? `<p class="b">SYNTHETIC DATASET: invented posts for practice. Nothing in this report describes real people or events.</p>` : ""}
<h1>${esc(d.title)}</h1><p class="m">AIVS ${esc(d.aivs_version)} · report ${esc(id ?? "preview")} · generated ${esc(fmt(d.generated_at))}${d.generated_by ? ` by ${esc(d.generated_by)}` : ""} · content SHA-256 ${esc(sha256 || "")}</p>
<h2>Research question</h2><p>${esc(d.research_question || "Not stated.")}</p>
<h2>Executive summary</h2><ul>${d.executive_summary.map(s => `<li>${esc(s)}</li>`).join("")}</ul>
<h2>Dataset</h2>${table(["Item", "Value"], [["Name", d.dataset.name], ["Source", d.dataset.source], ["Basis for use", d.dataset.authorisation], ["Collection method", d.dataset.collection_method], ["Posts in dataset", d.dataset.posts], ["Accounts", d.dataset.accounts], ["File SHA-256", d.dataset.file_sha256 || "—"], ["Collection period (posts)", `${fmt(d.collection_period.first_post)} to ${fmt(d.collection_period.last_post)}`], ["Filters", filt]])}
<p class="m">Provenance: ${d.dataset.provenance.map(p => `${esc(p.collected_via || "not recorded")} (${p.n} posts)`).join("; ")}</p>
<h2>Methodology</h2><ol>${d.methodology.map(m => `<li>${esc(m)}</li>`).join("")}</ol>
<h2>Sentiment findings</h2>${d.sentiment ? table(["Tone", "Posts", "%"], Object.entries(d.sentiment.counts).map(([k, v]) => [SENTIMENT_LABELS[k], v, d.sentiment.percent[k]])) + `<p class="m">Mean confidence ${d.sentiment.mean_confidence ?? "—"} (the method's own estimate, not a measured accuracy).</p>` : "<p>No posts.</p>"}
<h2>Topic and narrative findings</h2>${table(["Theme", "Posts", "Share %", "Growing late in period"], d.themes.map(t => [t.label, t.posts, t.share, t.emerging ? `yes (×${t.change_ratio})` : "no"]))}
${table(["Topic (keyword cluster)", "Key terms", "Posts", "Growing"], d.topics.map(t => [t.label, t.terms.join(", "), t.posts, t.emerging ? `yes (×${t.change_ratio})` : "no"]))}
${table(["Keyword", "Mentions", "Posts"], d.keywords.slice(0, 15).map(k => [k.term, k.count, k.posts]))}${table(["Hashtag", "Posts", "Accounts"], d.hashtags.slice(0, 15).map(h => [h.tag, h.posts, h.accounts]))}
<p class="m">Identical wording: ${d.duplicates ? `${d.duplicates.identical_groups} groups covering ${d.duplicates.posts_in_groups} posts` : "—"}.</p>
<h2>Public engagement findings</h2>${d.engagement ? table(["Measure", "Total", "Median per post"], Object.entries(d.engagement.totals).map(([k, v]) => [k, v, d.engagement.median_per_post[k]])) + `<p class="m">${esc(d.engagement.note)} Posts with unusual engagement: ${d.engagement.unusual.posts} (${esc(d.engagement.unusual.rule)}).</p>` : "<p>No engagement data.</p>"}
<h2>Geography</h2>${d.geography ? `<p class="m">${esc(d.geography.note)}</p>${table(["Basis", "Posts"], [["Location field in the data", d.geography.recorded.post], ["Self-reported profile location", d.geography.recorded.profile], ["Unknown", d.geography.recorded.unknown]])}${table(["County (recorded)", "Basis", "Posts"], d.geography.counties.map(c => [c.name, c.basis, c.posts]))}${table(["Place named in text", "Posts"], d.geography.mentioned_in_text.map(c => [c.name, c.posts]))}` : ""}
<h2>Coordination indicators</h2>${d.coordination_indicators ? `<p>${d.coordination_indicators.repeated_messages} repeated messages, ${d.coordination_indicators.synchronised} synchronised, ${d.coordination_indicators.hashtag_bursts} hashtag bursts (${esc(d.coordination_indicators.scope)}). Indicators require human verification; they are not evidence of coordinated manipulation.</p>${table(["Message", "Posts", "Accounts", "Accounts in one window", "First"], d.coordination_indicators.top.map(c => [c.text, c.posts, c.accounts, c.window_accounts, fmt(c.first_at)]))}` : "<p>Not computed.</p>"}
<h2>Claim verification findings</h2><p>${d.claims.total} claims: ${Object.entries(d.claims.by_status).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")}.</p>
${d.claims.listed.map(c => `<div style="border:1px solid #c9d6dd;border-radius:4px;padding:8px;margin:8px 0"><b>${esc(c.text)}</b><div class="m">${c.posts} posts · ${c.accounts} accounts · status: ${esc(c.status.replace("_", " "))}${c.case_id ? ` · case ${esc(c.case_id)} (${esc(c.case_status)}${c.case_conclusion ? `, conclusion: ${esc(c.case_conclusion)}` : ""})` : " · not verified in a case"}</div>
${c.red_flags.length ? `<div>Red flags: ${c.red_flags.map(esc).join(" ")}</div>` : ""}${c.published_fact_checks.length ? `<div>Similar published fact-checks: ${c.published_fact_checks.map(k => `${esc(k.publisher)} rated “${esc(k.rating)}”: ${esc(k.claim)}${k.url ? ` (<a href="${esc(k.url)}">${esc(k.url)}</a>)` : ""}`).join("; ")}</div>` : ""}
${c.case_evidence.length ? `<div>Accepted evidence in the case: ${c.case_evidence.map(e => `[${esc(e.stance)}] ${esc(e.text)}`).join("; ")}</div>` : ""}</div>`).join("")}
<h2>Sources linked in posts</h2>${table(["Site", "Category", "Posts"], d.sources.map(s => [s.host, s.category, s.posts]))}
<h2>Limitations and confidence</h2><ul>${d.limitations.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
<h2>Recommendations for further verification</h2><ul>${d.recommendations.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
<h2>Reproducibility</h2><p class="m">Input fingerprint ${esc(d.reproducibility.input_sha256)} over ${d.reproducibility.posts_included} posts, their text and tone labels, and the analysis settings. Generating the report again from the same data and filters gives the same fingerprint.</p></body></html>`;
}
const csvq = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
export function reportCsv(d) {
  const rows = [["section", "item", "value", "detail"]];
  rows.push(["report", "title", d.title, d.generated_at], ["report", "research_question", d.research_question || "", ""], ["report", "input_sha256", d.reproducibility.input_sha256, `${d.reproducibility.posts_included} posts`]);
  for (const s of d.executive_summary) rows.push(["summary", "", s, ""]);
  if (d.sentiment) for (const [k, v] of Object.entries(d.sentiment.counts)) rows.push(["sentiment", k, v, `${d.sentiment.percent[k]}%`]);
  for (const t of d.themes) rows.push(["theme", t.label, t.posts, t.emerging ? `growing x${t.change_ratio}` : ""]);
  for (const t of d.topics) rows.push(["topic", t.label, t.posts, t.terms.join(" ")]);
  for (const k of d.keywords) rows.push(["keyword", k.term, k.count, `${k.posts} posts`]);
  for (const h of d.hashtags) rows.push(["hashtag", h.tag, h.posts, `${h.accounts} accounts`]);
  if (d.engagement) for (const [k, v] of Object.entries(d.engagement.totals)) rows.push(["engagement", k, v, `median ${d.engagement.median_per_post[k]}`]);
  for (const c of d.claims.listed) rows.push(["claim", c.status, c.text, `${c.posts} posts; case ${c.case_id || "none"}; fact-checks ${c.published_fact_checks.length}; red flags ${c.red_flags.length}`]);
  for (const l of d.limitations) rows.push(["limitation", "", l, ""]);
  for (const r of d.recommendations) rows.push(["recommendation", "", r, ""]);
  return "﻿" + rows.map(r => r.map(csvq).join(",")).join("\r\n") + "\r\n";
}
const safe = s => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/×/g, "x").replace(/≥/g, ">=").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
export function reportPdf(d, { sha256, id }) {
  return new Promise(ok => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 54, bottom: 60, left: 54, right: 54 }, info: { Title: safe(d.title), Author: "AIVS" } }), ch = []; doc.on("data", c => ch.push(c)); doc.on("end", () => ok(Buffer.concat(ch)));
    const W = doc.page.width - 108, NAVY = "#0b1f3a", MUTED = "#44596c";
    const h2 = t => { doc.moveDown(0.8); doc.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text(safe(t).toUpperCase()); doc.moveDown(0.2); };
    const p = (t, o = {}) => doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size || 9.5).fillColor(o.color || NAVY).text(safe(t), { width: W });
    const li = t => p(`• ${t}`, { size: 9 });
    if (d.synthetic) { const y = doc.y; doc.rect(54, y, W, 22).fill("#5b3fc4"); doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9.5).text("SYNTHETIC DATASET - invented posts for practice. Nothing here is real.", 62, y + 6, { width: W - 16 }); doc.y = y + 30; }
    p(d.title, { bold: true, size: 16 }); p(`AIVS ${d.aivs_version} · report ${id ?? "preview"} · generated ${fmt(d.generated_at)} · content SHA-256 ${sha256 || ""}`, { size: 7.5, color: MUTED });
    h2("Research question"); p(d.research_question || "Not stated.");
    h2("Executive summary"); d.executive_summary.forEach(li);
    h2("Dataset"); [["Name", d.dataset.name], ["Source", d.dataset.source], ["Basis for use", d.dataset.authorisation], ["Collection method", d.dataset.collection_method], ["Posts", d.dataset.posts], ["Period", `${fmt(d.collection_period.first_post)} to ${fmt(d.collection_period.last_post)}`], ["Filters", Object.entries(d.filters || {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "none"]].forEach(([k, v]) => p(`${k}: ${v}`, { size: 9 }));
    h2("Methodology"); d.methodology.forEach((m, i) => p(`${i + 1}. ${m}`, { size: 9 }));
    h2("Sentiment findings"); if (d.sentiment) Object.entries(d.sentiment.counts).forEach(([k, v]) => li(`${SENTIMENT_LABELS[k]}: ${v} posts (${d.sentiment.percent[k]}%)`));
    h2("Topic and narrative findings"); d.themes.forEach(t => li(`${t.label}: ${t.posts} posts (${t.share}%)${t.emerging ? `, growing x${t.change_ratio}` : ""}`)); d.topics.forEach(t => li(`Topic “${t.label}”: ${t.posts} posts; terms ${t.terms.join(", ")}`));
    p(`Top keywords: ${d.keywords.slice(0, 12).map(k => `${k.term} (${k.count})`).join(", ")}`, { size: 9 }); p(`Top hashtags: ${d.hashtags.slice(0, 10).map(h => `${h.tag} (${h.posts})`).join(", ") || "none"}`, { size: 9 });
    h2("Public engagement findings"); if (d.engagement) { Object.entries(d.engagement.totals).forEach(([k, v]) => li(`${k}: total ${v}, median per post ${d.engagement.median_per_post[k]}`)); p(`${d.engagement.note} Unusual engagement: ${d.engagement.unusual.posts} posts.`, { size: 8.5, color: MUTED }); }
    h2("Geography"); if (d.geography) { p(d.geography.note, { size: 8.5, color: MUTED }); li(`Location field in data: ${d.geography.recorded.post}; self-reported: ${d.geography.recorded.profile}; unknown: ${d.geography.recorded.unknown}`); d.geography.counties.slice(0, 10).forEach(c => li(`${c.name} (${c.basis}): ${c.posts}`)); }
    h2("Coordination indicators"); if (d.coordination_indicators) { p(`${d.coordination_indicators.synchronised} synchronised repeated messages, ${d.coordination_indicators.hashtag_bursts} hashtag bursts (${d.coordination_indicators.scope}). Indicators for human verification only.`, { size: 9 }); d.coordination_indicators.top.forEach(c => li(`${c.posts} posts by ${c.accounts} accounts (${c.window_accounts} in one window): ${c.text}`)); }
    h2("Claim verification findings"); p(`${d.claims.total} claims: ${Object.entries(d.claims.by_status).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")}.`, { size: 9 });
    d.claims.listed.slice(0, 30).forEach(c => { p(`“${c.text}”`, { bold: true, size: 9 }); p(`${c.posts} posts · status ${c.status.replace("_", " ")}${c.case_id ? ` · case ${c.case_id} (${c.case_status}${c.case_conclusion ? `, ${c.case_conclusion}` : ""})` : ""}`, { size: 8, color: MUTED });
      c.published_fact_checks.forEach(k => p(`Published fact-check: ${k.publisher} rated "${k.rating}" - ${k.claim}${k.url ? ` (${k.url})` : ""}`, { size: 8 })); c.case_evidence.forEach(e => p(`Evidence [${e.stance}]: ${e.text}`, { size: 8 })); doc.moveDown(0.3); });
    h2("Limitations and confidence"); d.limitations.forEach(li);
    h2("Recommendations for further verification"); d.recommendations.forEach(li);
    h2("Reproducibility"); p(`Input fingerprint ${d.reproducibility.input_sha256} over ${d.reproducibility.posts_included} posts.`, { size: 8.5, color: MUTED });
    doc.end();
  });
}
