// Evidence retrieval for claims. Each connector runs on the server; keys stay in server configuration.
//   factcheck  Google Fact Check Tools API (ClaimReview records published by fact-checkers). Free key.
//   web        Brave Search API (web results). Paid key.
//   official   Brave Search restricted to official and independent public-interest sources (Kenya module).
//   kb         AIVS knowledge base: approved datasets in the dataset registry (local, no key).
//   holdings   Earlier AIVS investigations with similar claims (local, no key).
// Results are stored as evidence SUGGESTIONS with the exact URL, title and publisher returned by the service.
// Nothing is invented: if a connector is not configured or fails, the result says so and stores nothing.
import { HttpError } from "./auth.js";
import { nowISO, nextId } from "./db.js";
import { ratingToVerdict, VERDICTS, activeVerdict } from "../../shared/verdict.js";

export const OFFICIAL_SOURCES = [
  ["knbs.or.ke", "Kenya National Bureau of Statistics"], ["health.go.ke", "Ministry of Health"], ["iebc.or.ke", "Independent Electoral and Boundaries Commission"],
  ["centralbank.go.ke", "Central Bank of Kenya"], ["cma.or.ke", "Capital Markets Authority"], ["kra.go.ke", "Kenya Revenue Authority"], ["mod.go.ke", "Ministry of Defence"],
  ["meteo.go.ke", "Kenya Meteorological Department"], ["ndma.go.ke", "National Drought Management Authority"], ["ca.go.ke", "Communications Authority of Kenya"],
  ["kenyalaw.org", "Kenya Law (Kenya Gazette and laws)"], ["redcross.or.ke", "Kenya Red Cross"], ["africacheck.org", "Africa Check"], ["pesacheck.org", "PesaCheck"]
];
const STOP = new Set("the a an and or of to in on at for with by from is are was were be been being this that these those it its as has have had will would can could should may might not no yes their there they them he she his her our we you your i me my about after before over under into than then also just very more most such only other some any each all both few many much do does did done new says said according breaking urgent update alert ya na wa kwa la za katika kuwa ni hii huu hiyo hizo leo jana sasa".split(" "));
export function buildQuery(text) {
  const words = String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/[#@][\p{L}\p{N}_]+/gu, m => m.slice(1)).split(/[^\p{L}\p{N}'-]+/u).filter(w => w.length > 2 && !STOP.has(w.toLowerCase()));
  return [...new Set(words)].slice(0, 14).join(" ").slice(0, 200);
}
const tokens = s => new Set(String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOP.has(w)));
export function relevance(a, b) { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.min(A.size, B.size); }

async function getJson(url, headers, timeoutMs) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ac.signal });
    const body = await r.text(); let j = null; try { j = JSON.parse(body); } catch {}
    if (!r.ok) throw new Error(`HTTP ${r.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 160)}` : ""}`);
    if (!j) throw new Error("the service did not return JSON");
    return j;
  } catch (e) { if (e.name === "AbortError") throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`); throw e; }
  finally { clearTimeout(t); }
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
const isHttp = u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

export function makeRetrieval(db, { config, audit, usage }) {
  const S = { timeoutMs: 10000, factcheckKey: "", factcheckBase: "https://factchecktools.googleapis.com", braveKey: "", braveBase: "https://api.search.brave.com", braveUsdPerRequest: null,
    gdelt: false, gdeltBase: "https://api.gdeltproject.org", wikipedia: false, wikipediaBase: "https://{lang}.wikipedia.org", ...(config.search || {}) };
  const connectors = {
    factcheck: { label: "Google Fact Check Tools (published fact-checks)", configured: !!S.factcheckKey, needs: "GOOGLE_FACTCHECK_API_KEY (free; create it in a Google Cloud project with the Fact Check Tools API enabled)", external: "Google",
      async run(q, { lang }) {
        const u = new URL("/v1alpha1/claims:search", S.factcheckBase); u.searchParams.set("query", q); u.searchParams.set("pageSize", "10"); u.searchParams.set("key", S.factcheckKey); if (lang) u.searchParams.set("languageCode", lang);
        const j = await getJson(u, {}, S.timeoutMs); usage("factcheck", "claims:search", 0);
        const out = [];
        for (const c of j.claims || []) for (const r of c.claimReview || []) if (isHttp(r.url)) out.push({ title: r.title || c.text, url: r.url, publisher: r.publisher?.name || host(r.url), published_at: r.reviewDate || null,
          rating: r.textualRating || null, claim_reviewed: c.text || null, claimant: c.claimant || null, language: r.languageCode || null, snippet: c.text ? `Claim reviewed: “${c.text}”${c.claimant ? ` (claimant: ${c.claimant})` : ""}` : "" });
        return out;
      } },
    web: { label: "Web search (Brave Search API)", configured: !!S.braveKey, needs: "BRAVE_SEARCH_API_KEY (paid plan; you choose and accept the provider's terms)", external: "Brave",
      async run(q) { return brave(q); } },
    official: { label: "Official and fact-checking sources (Kenya and East Africa)", configured: !!S.braveKey, needs: "BRAVE_SEARCH_API_KEY (searches only the listed official and fact-checking sites)", external: "Brave",
      async run(q) { return brave(`${q} (${OFFICIAL_SOURCES.map(([d]) => `site:${d}`).join(" OR ")})`, { official: true }); } },
    kb: { label: "AIVS knowledge base (approved datasets)", configured: true, needs: null, external: null,
      async run(q, { training = false } = {}) {
        const fq = [...tokens(q)].slice(0, 12).map(w => `"${w.replace(/"/g, "")}"`).join(" OR "); if (!fq) return [];
        return db.prepare(`SELECT r.id, r.claim, r.label_raw, r.label, r.language, r.source_url, r.publisher, r.published_at, d.name AS dataset, d.license FROM kb_fts f JOIN kb_records r ON r.id = f.rowid JOIN kb_datasets d ON d.id = r.dataset_id
          WHERE kb_fts MATCH ? AND d.status = 'approved' AND d.use_retrieval = 1 AND r.review_status != 'removed' AND r.dup_of IS NULL AND (d.is_synthetic = 0 OR ?) ORDER BY bm25(kb_fts) LIMIT 10`).all(fq, training ? 1 : 0)
          .map(r => ({ title: r.claim, url: isHttp(r.source_url) ? r.source_url : null, publisher: r.publisher || r.dataset, published_at: r.published_at, rating: r.label_raw || r.label, kb_label: r.label, claim_reviewed: r.claim, language: r.language,
            snippet: `Dataset “${r.dataset}” (licence: ${r.license}), record KB-${r.id}`, kb_id: r.id }));
      } },
    holdings: { label: "Earlier AIVS investigations", configured: true, needs: null, external: null, async run() { return []; } },   // handled per claim below
    // free public indexes, no key (switch off with SEARCH_GDELT=false or SEARCH_WIKIPEDIA=false)
    news: { label: "News coverage index (GDELT)", configured: !!S.gdelt, needs: "on unless SEARCH_GDELT=false (free GDELT DOC 2.0 API, no key; claim keywords are sent to GDELT)", external: "GDELT Project",
      async run(q, { lang }) {
        const words = [...tokens(q)].filter(w => !/^\d+$/.test(w)).slice(0, 6); if (words.length < 2) return [];
        const u = new URL("/api/v2/doc/doc", S.gdeltBase); u.searchParams.set("query", words.join(" ") + (lang === "sw" ? " sourcelang:swahili" : ""));
        for (const [k, v] of [["mode", "artlist"], ["format", "json"], ["maxrecords", "15"], ["sort", "hybridrel"], ["timespan", "12months"]]) u.searchParams.set(k, v);
        const j = await getJson(u, {}, S.timeoutMs); usage("news", "doc/artlist", 0);
        const gd = s => { const m = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(s || ""); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null; };
        return (j.articles || []).filter(a => isHttp(a.url)).map(a => ({ title: a.title, url: a.url, publisher: a.domain || host(a.url), published_at: gd(a.seendate), snippet: a.title || "", language: a.language || null }));
      } },
    reference: { label: "Wikipedia (background reference)", configured: !!S.wikipedia, needs: "on unless SEARCH_WIKIPEDIA=false (free Wikipedia search API, no key; claim keywords are sent to Wikimedia)", external: "Wikimedia",
      async run(q, { lang }) {
        const wl = lang === "sw" ? "sw" : "en", base = S.wikipediaBase.replace("{lang}", wl);
        const u = new URL("/w/api.php", base); for (const [k, v] of [["action", "query"], ["list", "search"], ["srsearch", q.slice(0, 250)], ["format", "json"], ["srlimit", "5"]]) u.searchParams.set(k, v);
        const j = await getJson(u, {}, S.timeoutMs); usage("reference", "search", 0);
        return (j.query?.search || []).map(r => ({ title: r.title, url: `${base}/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`, publisher: `Wikipedia (${wl})`,
          published_at: r.timestamp || null, date_kind: "last edited", snippet: String(r.snippet || "").replace(/<[^>]+>/g, "") }));
      } }
  };
  async function brave(q, { official } = {}) {
    const u = new URL("/res/v1/web/search", S.braveBase); u.searchParams.set("q", q.slice(0, 380)); u.searchParams.set("count", "8"); u.searchParams.set("safesearch", "moderate");
    const j = await getJson(u, { "X-Subscription-Token": S.braveKey }, S.timeoutMs); usage(official ? "official" : "web", "web/search", S.braveUsdPerRequest);
    return (j.web?.results || []).filter(r => isHttp(r.url)).map(r => ({ title: r.title, url: r.url, publisher: r.profile?.name || r.meta_url?.hostname || host(r.url), published_at: r.page_age || null,
      snippet: String(r.description || "").replace(/<[^>]+>/g, ""), language: r.language || null, official: official ? (OFFICIAL_SOURCES.find(([d]) => (host(r.url) || "").endsWith(d))?.[1] || null) : null }));
  }
  const status = () => Object.entries(connectors).map(([k, c]) => ({ key: k, label: c.label, configured: c.configured, needs: c.needs, sends_to: c.external }));

  // Run the selected connectors for the case's checkable claims; store results as suggestions.
  async function retrieve(user, caseId, { claimIds, use } = {}, cases) {
    const c = cases.mustCase(caseId); cases.requireEdit(user, c);
    // without an explicit list, the free public indexes (GDELT, Wikipedia) are not used: they are chosen explicitly (automatic investigations, or the search box)
    const want = (use && use.length ? use : Object.keys(connectors).filter(k => !["news", "reference"].includes(k))).filter(k => connectors[k]);
    const claims = db.prepare("SELECT * FROM claims WHERE case_id = ? AND removed = 0 ORDER BY seq").all(caseId)
      .filter(cl => !claimIds?.length || claimIds.includes(cl.id));
    const checkable = claims.filter(cl => cl.kind !== "media" && (!cl.claim_type || cl.claim_type === "factual"));
    const skipped = claims.filter(cl => !checkable.includes(cl)).map(cl => ({ claim: cl.seq, reason: cl.kind === "media" ? "about the attached media; checked with image tools" : `looks like ${cl.claim_type === "appeal" ? "a call to action" : `a ${cl.claim_type}`}, not a checkable statement` }));
    const lang = /\b(na|ya|wa|kwa|ni|katika)\b/i.test(c.claim_text) && !/\b(the|and|of)\b/i.test(c.claim_text) ? "sw" : null;
    const report = [], added = { total: 0 };
    const ins = db.prepare(`INSERT OR IGNORE INTO evidence(id,case_id,kind,origin,status,text,reference,suggested_links,sys_key,source_url,source_title,source_publisher,source_published_at,connector,rating,retrieved_at,claim_id,related_case_id,created_by,created_at)
      VALUES (@id,@case_id,@kind,'retrieval','suggested',@text,@reference,@links,@sys_key,@source_url,@source_title,@source_publisher,@source_published_at,@connector,@rating,@retrieved_at,@claim_id,@related_case_id,@created_by,@created_at)`);
    const exists = db.prepare("SELECT 1 FROM evidence WHERE case_id = ? AND sys_key = ?");
    const logR = db.prepare("INSERT INTO retrievals(case_id,claim_id,connector,query,status,error,results,user_id,at) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const key of want) {
      const con = connectors[key], row = { connector: key, label: con.label, configured: con.configured, needs: con.needs, queries: 0, results: 0, stored: 0, errors: [] };
      report.push(row);
      if (!con.configured) { row.status = "not_configured"; continue; }
      for (const cl of checkable) {
        const q = buildQuery(cl.text); if (!q) continue;
        let results = [];
        try {
          if (key === "holdings") results = similarCases(c, cl);
          else results = await con.run(q, { lang, training: !!c.is_training });
          logR.run(caseId, cl.id, key, q, "ok", null, results.length, user.id, nowISO()); row.queries++;
        } catch (e) { row.errors.push(`Claim ${cl.seq}: ${e.message}`); logR.run(caseId, cl.id, key, q, "error", String(e.message).slice(0, 300), 0, user.id, nowISO()); if (key !== "holdings") usageFail(key); continue; }
        row.results += results.length;
        for (const r of results.slice(0, 6)) {
          const rel = relevance(cl.text, `${r.claim_reviewed || ""} ${r.title || ""} ${r.snippet || ""}`);
          if (key !== "holdings" && rel < 0.15) continue;                                     // clearly unrelated
          const sysKey = `ret:${cl.id}:${r.url || r.kb_id || r.case_id}`; if (exists.get(caseId, sysKey)) continue;
          const v = ratingToVerdict(r.rating), stance = v === "contradicted" ? "contradicts" : v === "supported" ? "supports" : "context";
          const fc = key === "factcheck" || key === "kb";
          const text = key === "holdings" ? `Earlier investigation ${r.case_id} examined a similar claim: “${r.claim_text}” (${r.status}${r.verdict ? `; verdict ${VERDICTS[r.verdict] || r.verdict}` : ""}).`
            : fc ? `${r.publisher || "A fact-checker"} published a fact-check${r.rating ? ` rating the claim “${r.rating}”` : ""}${r.claim_reviewed ? `: “${String(r.claim_reviewed).slice(0, 300)}”` : ""}${r.published_at ? ` (${String(r.published_at).slice(0, 10)})` : ""}. Check that it concerns the same claim before relying on it.`
            : `${r.official ? `Official or fact-checking source (${r.official}): ` : "Search result: "}“${String(r.title || "").slice(0, 200)}”${r.snippet ? ` — ${String(r.snippet).slice(0, 300)}` : ""}. Open and read the source before relying on it.`;
          ins.run({ id: nextId(db, "evidence", n => `E-${String(n).padStart(6, "0")}`), case_id: caseId, kind: fc ? "source_claim" : "lead", text, reference: r.url || (r.kb_id ? `AIVS knowledge base record KB-${r.kb_id}` : `AIVS case ${r.case_id}`),
            links: JSON.stringify(fc && v ? [{ claim_id: cl.id, stance }] : []), sys_key: sysKey, source_url: r.url || null, source_title: r.title ? String(r.title).slice(0, 500) : null, source_publisher: r.publisher || null,
            source_published_at: r.published_at || null, connector: key, rating: r.rating || null, retrieved_at: nowISO(), claim_id: cl.id, related_case_id: r.case_id || null, created_by: user.id, created_at: nowISO() });
          row.stored++; added.total++;
        }
      }
      row.status = row.errors.length && !row.queries ? "error" : row.errors.length ? "partial" : "ok";
    }
    suggestVerdicts(caseId);
    cases.change(user, caseId, `Evidence search: ${added.total} suggestion(s) from ${report.filter(r => r.status === "ok" || r.status === "partial").map(r => r.connector).join(", ") || "no configured service"}`, () => {}, { report: report.map(({ connector, status, queries, results, stored }) => ({ connector, status, queries, results, stored })) });
    return { connectors: report, checkable: checkable.length, skipped, stored: added.total };
  }

  function similarCases(c, cl) {
    const q = [...tokens(cl.text)].slice(0, 10); if (q.length < 2) return [];
    const rows = db.prepare(`SELECT x.text AS claim_text, x.assessment, c.id, c.title, c.status, c.conclusion FROM claims x JOIN cases c ON c.id = x.case_id WHERE x.removed = 0 AND c.id != ? AND c.is_training = ? AND c.status IN ('approved','archived','awaiting_approval','analyst_review','needs_evidence')`).all(c.id, c.is_training);
    return rows.map(r => ({ ...r, rel: relevance(cl.text, r.claim_text) })).filter(r => r.rel >= 0.5).sort((a, b) => b.rel - a.rel).slice(0, 3)
      .map(r => ({ case_id: r.id, claim_text: r.claim_text, status: r.status, verdict: ["approved", "archived"].includes(r.status) ? r.assessment : null, title: r.title }));
  }

  // A suggested verdict per claim, only from published ratings (fact-checks and approved datasets), with its basis.
  function suggestVerdicts(caseId) {
    const up = db.prepare("UPDATE claims SET suggested_assessment = ?, suggested_basis = ?, suggested_at = ? WHERE id = ?");
    for (const cl of db.prepare("SELECT id FROM claims WHERE case_id = ? AND removed = 0").all(caseId)) {
      const ev = db.prepare("SELECT * FROM evidence WHERE case_id = ? AND claim_id = ? AND connector IN ('factcheck','kb') AND status != 'dismissed'").all(caseId, cl.id);
      const rated = ev.map(e => ({ e, v: activeVerdict(ratingToVerdict(e.rating)) })).filter(x => x.v);
      if (!rated.length) { up.run(null, null, null, cl.id); continue; }
      const kinds = [...new Set(rated.map(x => x.v))];
      const list = rated.slice(0, 4).map(x => `${x.e.source_publisher || "a fact-checker"} rated it “${x.e.rating}” (${x.e.id})`).join("; ");
      if (kinds.length === 1) up.run(kinds[0], `Suggested from ${rated.length} published rating${rated.length > 1 ? "s" : ""}: ${list}. Confirm that each one concerns this exact claim, then decide.`, nowISO(), cl.id);
      else up.run(null, `Published ratings disagree (${kinds.map(k => VERDICTS[k]).join(" vs ")}): ${list}. Read the sources and decide.`, nowISO(), cl.id);
    }
  }
  function usageFail(service) { try { db.prepare("INSERT INTO api_usage(at,service,operation,units,est_cost_usd,status) VALUES (?,?,?,?,?,?)").run(nowISO(), service, "call", 1, null, "error"); } catch {} }
  return { status, retrieve, connectors, suggestVerdicts };
}
