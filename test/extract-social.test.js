// Automatic extraction of Facebook and Instagram links (1.31) against local TEST DOUBLES: the post's public page metadata is read
// only where the site's robots.txt allows it, a sign-in wall counts as blocked, nothing is invented; source detection, earlier
// investigations of the same link, the AI's reading of the content (Ollama stand-in), "Generate Report" and browser capture.
// The real platforms are checked on a connected computer with `npm run check:verify-url -- <link>`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, login } from "./helpers.js";

let F, fake, S, ana;
const OG = (desc, extra = "") => `<html><head><title>Fixture Page | Facebook</title><meta property="og:title" content="Fixture Page"><meta property="og:description" content="${desc}"><meta property="og:image" content="${F}/img.jpg"><meta property="article:published_time" content="2026-10-20T08:00:00Z">${extra}</head><body>public post</body></html>`;
before(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), html = (c, b, h = {}) => { res.writeHead(c, { "content-type": "text/html", ...h }); res.end(b); }, j = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/fb/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nAllow: /FixturePage/posts/\nDisallow: /\n"); }
    if (u.pathname === "/ig/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nDisallow: /\n"); }
    if (u.pathname === "/fb/FixturePage/posts/1111111111") return html(200, OG("TEST FIXTURE: The Ministry of Health confirmed 12 new cholera cases in Garissa County on 20 October 2026."));
    if (u.pathname === "/fb/FixturePage/posts/2222222222") return html(302, "", { location: "/fb/login/?next=post" });
    if (u.pathname === "/fb/login/") return html(200, "<html><head><title>Log in to Facebook</title></head><body>Log in</body></html>");
    if (u.pathname === "/missing") return html(404, "not found");
    if (u.pathname === "/news/ok") return html(200, `<html><head><title>TEST FIXTURE: County update</title><meta property="article:published_time" content="2026-10-20T06:00:00Z"></head><body><article><p>TEST FIXTURE ARTICLE: The Ministry of Health confirmed 12 new cholera cases in Garissa County on 20 October 2026. Residents were asked to boil water.</p></article></body></html>`);
    if (u.pathname === "/img.jpg") { res.writeHead(404); return res.end(); }
    if (u.pathname === "/api/tags") return j(200, { models: [{ name: "qwen3:4b-instruct" }] });
    if (u.pathname === "/api/show") return j(200, { capabilities: ["completion"] });
    if (u.pathname === "/api/chat") { let b = ""; req.on("data", d => (b += d)); req.on("end", () => {
      const p = JSON.parse(b).messages.at(-1).content;
      if (/single word OK/.test(p)) return j(200, { message: { content: "OK" }, model: "qwen3:4b-instruct" });
      if (/narratives: up to 3/.test(p)) return j(200, { model: "qwen3:4b-instruct", message: { content: JSON.stringify({ language: "en", narratives: ["A cholera outbreak in Garissa is being confirmed by the health ministry"], sentiment: { label: "neutral", towards: "the Ministry of Health" },
        misleading: [{ quote: "12 new cholera cases in Garissa County", why: "a figure without a named source document" }, { quote: "words that are not in the post", why: "invented" }],
        entities: { people: [], organisations: ["Ministry of Health"], places: ["Garissa County", "Nairobi"], dates: ["20 October 2026"] }, gaps: ["The source of the case count is not linked."] }) } });
      return j(200, { model: "qwen3:4b-instruct", message: { content: "{}" } }); }); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ allowPrivateFetch: true, search: { gdelt: false, wikipedia: false, timeoutMs: 2000 }, social: { timeoutMs: 3000, bases: { page: { "www.facebook.com": `${F}/fb`, "facebook.com": `${F}/fb`, "www.instagram.com": `${F}/ig` } } },
    ai: { provider: "ollama", model: "qwen3:4b-instruct", baseUrl: F, apiKey: "", timeoutMs: 8000, healthTimeoutMs: 4000, maxImages: 6 } });
  ana = await login(S.base, "ana");
});
after(async () => { await S.ctx.investigations.close(); await S.close(); fake.close(); });

async function investigate(fields) {
  const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await ana.post("/api/investigations", undefined, { form: fd }); if (r.status !== 202) return r;
  for (let i = 0; i < 600; i++) { const g = await ana.get(`/api/investigations/${r.body.id}`); if (["done", "failed"].includes(g.body.status)) return g.body; await new Promise(ok => setTimeout(ok, 100)); }
  throw new Error("investigation did not finish");
}
const stage = (inv, k) => inv.stages.find(s => s.key === k);

test("1. an accessible public web page: read, analysed by the AI (language, narratives, claims quoted, names checked), report with four sections", async () => {
  const inv = await investigate({ url: `${F}/news/ok` }), r = inv.result;
  assert.equal(inv.status, "done", inv.error); assert.equal(stage(inv, "source").status, "done"); assert.match(stage(inv, "source").detail, /not investigated before/);
  assert.match(r.content, /12 new cholera cases/); assert.ok(r.claims.length >= 1);
  const a = r.ai.content; assert.ok(a, JSON.stringify(r.ai)); assert.equal(a.language, "en"); assert.equal(a.narratives.length, 1); assert.equal(a.sentiment.label, "neutral");
  assert.deepEqual(a.misleading.map(m => m.quote), ["12 new cholera cases in Garissa County"], "a quote not in the content is removed");
  assert.ok(!a.entities.places.includes("Nairobi") && a.entities.places.includes("Garissa County"), "a place not in the content is removed"); assert.ok(a.dropped.entities >= 1);
  assert.match(a.note, /not evidence/); assert.equal(r.ai.used, true);
  for (const k of ["background", "analysis", "assessment", "recommendations"]) assert.ok(r.io_assessment[k], k);
  // Generate Report writes the one-page report again from the stored facts
  const g = await ana.post(`/api/investigations/${inv.id}/report`, {}); assert.equal(g.status, 200, JSON.stringify(g.body)); assert.ok(["ai", "rules"].includes(g.body.written_by));
  assert.ok((await ana.get(`/api/investigations/${inv.id}`)).body.result.io_assessment.regenerated_at);
  // the same link again: the earlier investigation is named
  const again = await investigate({ url: `${F}/news/ok?utm_source=x` }); assert.match(stage(again, "source").detail, new RegExp(`investigated before: ${inv.report_id}`)); assert.equal(again.preview.source_info.previous[0].id, inv.id);
});

test("2. a Facebook post whose public page metadata the site allows: text, date and source read automatically; the link and method are recorded", async () => {
  const url = "https://www.facebook.com/FixturePage/posts/1111111111", inv = await investigate({ url }), r = inv.result;
  assert.equal(inv.status, "done", inv.error); assert.ok(!r.blocked, JSON.stringify(r.blocked));
  assert.match(stage(inv, "source").detail, /Facebook post · account FixturePage · ID 1111111111/);
  assert.match(r.content, /12 new cholera cases/); assert.match(r.source.method, /Open Graph/); assert.equal(r.source.url, url); assert.equal(r.source.platform, "Facebook");
  assert.ok(r.source.published_at?.startsWith("2026-10-20")); assert.ok(r.source.notes.some(n => /shortened|embed|description/i.test(n)) || /may be shortened/.test(r.source.method));
  assert.ok(r.claims.length >= 1);
});

test("3. a Facebook post behind a sign-in wall: blocked as a platform restriction, every attempt explained, nothing invented, alternatives offered", async () => {
  const inv = await investigate({ url: "https://www.facebook.com/FixturePage/posts/2222222222" }), r = inv.result;
  assert.equal(inv.status, "done"); assert.equal(r.overall.verdict, "extraction_blocked"); assert.equal(stage(inv, "extract").status, "warning");
  assert.ok(r.blocked.attempts.some(a => /Open Graph/.test(a.method) && a.result === "blocked" && /sign-in page/.test(a.detail)), JSON.stringify(r.blocked.attempts));
  assert.ok(r.blocked.options.includes("browser_capture")); assert.equal(r.content, ""); assert.equal(r.claims.length, 0);
  assert.match(r.references.note, /BRAVE_SEARCH_API_KEY/, "independent references: says why none could be looked for");
  // one-click capture from the analyst's browser continues the same link
  const c = await ana.post("/api/investigations/capture", { url: "https://www.facebook.com/FixturePage/posts/2222222222?__cft__=x", text: "The Ministry of Health confirmed 12 new cholera cases in Garissa County on 20 October 2026.", title: "Fixture Page | Facebook" });
  assert.equal(c.status, 202, JSON.stringify(c.body));
  let n; for (let i = 0; i < 600; i++) { n = (await ana.get(`/api/investigations/${c.body.id}`)).body; if (n.status === "done") break; await new Promise(ok => setTimeout(ok, 100)); }
  assert.ok(!n.result.blocked); assert.deepEqual(n.result.source.provenance.items, ["text captured from the analyst's own browser view"]); assert.equal(n.result.source.provenance.continues, inv.report_id);
  assert.equal((await ana.post("/api/investigations/capture", { url: "https://www.facebook.com/x/posts/1", text: "" })).status, 400, "an empty capture is refused");
});

test("4. an Instagram link whose robots.txt forbids automated access: not read, and the report says so", async () => {
  const inv = await investigate({ url: "https://www.instagram.com/p/FixtureAbC1/" }), r = inv.result;
  assert.equal(r.overall.verdict, "extraction_blocked"); assert.match(stage(inv, "source").detail, /Instagram post · ID FixtureAbC1/);
  assert.ok(r.blocked.attempts.some(a => /Open Graph/.test(a.method) && a.result === "not permitted" && /robots\.txt/.test(a.detail)), JSON.stringify(r.blocked.attempts));
});

test("5. an unavailable page and an invalid address", async () => {
  const inv = await investigate({ url: `${F}/missing` }); assert.equal(inv.result.overall.verdict, "extraction_blocked"); assert.match(inv.result.blocked.reason, /HTTP 404/);
  const bad = await investigate({ url: "https://exa mple.com/x" }); assert.equal(bad.status, 400);
});
