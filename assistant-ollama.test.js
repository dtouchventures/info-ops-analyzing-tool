// Research assistant on Ollama (AIVS 1.12): native API with context size and a JSON schema, a real health check,
// answers grounded in the case's documents and sources, every citation, link, date and "web search" claim checked,
// local-network rules, and the rule-based fallback when the service fails, times out or answers badly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, login } from "./helpers.js";

let S, ana, view, fake, F, mode = "good", seen = [];
const AI = u => ({ provider: "ollama", baseUrl: u, model: "qwen3:4b-instruct", timeoutMs: 1500, healthTimeoutMs: 1500, numCtx: 4096, trainingOnly: true, maxImages: 6, apiKey: "" });
before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/api/tags") return json(200, { models: [{ name: mode === "nomodel" ? "llama3.2:3b" : "qwen3:4b-instruct" }] });
    if (req.url !== "/api/chat") return json(404, { error: "not found" });
    const j = JSON.parse(body); seen.push(j);
    if (!j.format) return json(200, { model: j.model, message: { content: "OK" }, total_duration: 1e9 });         // health check
    if (mode === "error") return json(500, { error: "model runner has unexpectedly stopped" });
    if (mode === "slow") { await new Promise(r => setTimeout(r, 2500)); return json(200, { message: { content: "{}" } }); }
    if (mode === "garbage") return json(200, { model: j.model, message: { content: "Here is my analysis: the claim is false." } });
    const user = j.messages.at(-1).content, ids = [...user.matchAll(/<source id="([^"]+)"/g)].map(m => m[1]);
    const doc = ids.find(i => /#1$/.test(i)), ev = ids.find(i => i.startsWith("E-")), dates = ids.find(i => i.endsWith("@dates")), sw = /Kiswahili/.test(j.messages[0].content);
    const out = { answer: sw ? `Hati inasema barabara itafungwa [${doc}].` : `The notice says the road closes on 3 March [${doc}].`,
      facts: [{ text: sw ? "Hati inataja tarehe 3 Machi 2025" : "The notice names 3 March 2025 as the closure date", sources: [doc] }, { text: "A county statement confirms the closure", sources: [ev] },
        { text: "The ministry confirmed it on its website", sources: ["E-999999"] }, { text: "I searched the web and found three news reports about it", sources: [doc] }],
      missing: [{ text: "No independent source confirms the date" }],
      suggestions: [{ text: "Compare with the county page at https://invented.example/notice", sources: [] }, { text: "Ask the county roads office for the original notice", sources: [] }],
      timeline: [{ date: "2025-03-03", event: "Road closure begins, per the notice", sources: [doc] }, { date: "2024-01-01", event: "Earlier unrelated closure", sources: [] }, { date: "2026-10-20", event: "Case received", sources: [dates] }] };
    return json(200, { model: j.model, message: { content: JSON.stringify(out) }, prompt_eval_count: 1500, eval_count: 300, total_duration: 4.2e9 });
  });
  await new Promise(ok => fake.listen(0, "127.0.0.1", ok)); F = `http://127.0.0.1:${fake.address().port}`;
  S = await startServer({ ai: AI(F) }); [ana, view] = await Promise.all([login(S.base, "ana"), login(S.base, "view")]);
});
after(async () => { await S.close(); fake.close(); });

async function makeCase() {
  const id = (await ana.post("/api/cases", { claim_text: "PUBLIC NOTICE shared on social media: the Garissa road will be closed for repairs from 3 March 2025.", source_platform: "Facebook" })).body.id;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aivs-a-")), f = path.join(dir, "notice.txt");
  fs.writeFileSync(f, "COUNTY GOVERNMENT OF GARISSA\nPublic notice: the Garissa road will be closed for repairs from 3 March 2025. Motorists should use the bypass.");
  const fd = new FormData(); fd.append("files", new Blob([fs.readFileSync(f)]), "notice.txt");
  const m = await ana.post(`/api/cases/${id}/media`, undefined, { form: fd }); assert.equal(m.status, 201, JSON.stringify(m.body));
  await ana.post(`/api/cases/${id}/analyse?wait=1`, {});
  const ev = (await ana.post(`/api/cases/${id}/evidence`, { kind: "source_claim", text: "County roads office statement: the closure starts on 3 March 2025.", reference: "https://county.example/roads/statement" })).body.id;
  return { id, ev };
}

test("health check: really asks the model; Available only when it answers; file written for support", async () => {
  mode = "good"; const h = (await ana.get("/api/ai/health?force=1")).body;
  assert.equal(h.state, "ok", JSON.stringify(h)); assert.equal(h.model, "qwen3:4b-instruct"); assert.equal(h.reply, "OK"); assert.ok(h.latency_ms >= 0);
  assert.equal(h.ai.local, true); assert.equal(h.ai.trainingOnly, false, "AI_TRAINING_ONLY does not apply to Ollama on the organisation's network");
  assert.match(fs.readFileSync(path.join(S.dataDir, "ai-health.txt"), "utf8"), /Result: ok/);
  mode = "nomodel"; const m = (await ana.get("/api/ai/health?force=1")).body; assert.equal(m.state, "failed"); assert.match(m.error, /ollama pull qwen3:4b-instruct/);
  mode = "good"; await ana.get("/api/ai/health?force=1");
});

test("a complete case question: grounded in the document and sources, checked, facts kept apart from suggestions", async () => {
  mode = "good"; seen = []; const { id, ev } = await makeCase();
  const r = await ana.post(`/api/cases/${id}/assistant`, { question: "Summarise the evidence and build a timeline", mode: "ai" });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.mode, "ai", "a real (non-training) case is allowed on the private Ollama server");
  const req = seen.at(-1), user = req.messages.at(-1).content;
  assert.equal(req.options.num_ctx, 4096); assert.equal(req.stream, false); assert.ok(req.format?.properties?.facts, "a JSON schema is sent");
  assert.match(user, /Motorists should use the bypass/, "the uploaded document's text is sent"); assert.match(user, new RegExp(`<source id="${ev}"`)); assert.match(user, /No searches have been run for this case/);
  assert.match(req.messages[0].content, /You cannot search the web/);
  const msg = (await ana.get(`/api/cases/${id}/assistant`)).body.messages.at(-1), S2 = msg.sources;
  assert.equal(msg.provider, "ollama"); assert.equal(msg.model, "qwen3:4b-instruct");
  assert.match(msg.content, /\*\*Facts from the case records\*\*/); assert.match(msg.content, /Suggested verification steps \(suggestions, not findings\)/); assert.match(msg.content, /\*\*Timeline \(from the records\)\*\*/);
  assert.match(msg.content, new RegExp(`A county statement confirms the closure \\[${ev}\\]`));
  assert.doesNotMatch(msg.content, /- The ministry confirmed it on its website/, "a fact citing a record that does not exist is not shown as a fact");
  assert.doesNotMatch(msg.content, /- I searched the web/, "a claimed web search that never happened is not shown");
  assert.doesNotMatch(msg.content, /invented\.example/, "an invented link is removed"); assert.match(msg.content, /link removed: not in the case records/);
  assert.doesNotMatch(msg.content, /- 2024-01-01/, "a timeline entry that cites no record is dropped from the timeline"); assert.match(msg.content, /2025-03-03/);
  assert.equal(S2.removed, 3); assert.equal(S2.links_removed, 1); assert.ok(S2.cited.includes(ev)); assert.ok(S2.cited.some(x => x.endsWith("#1"))); assert.ok(S2.invalid.includes("E-999999"));
  assert.equal(S2.stats.prompt_tokens, 1500); assert.equal(S2.searches_in_log, 0);
  assert.ok(S.ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id = ? AND action = 'Case records sent to AI research assistant'").get(id).n === 1);
});

test("Kiswahili question gets a Kiswahili answer; searches AIVS really ran are disclosed to the model", async () => {
  mode = "good"; seen = []; const { id } = await makeCase();
  await ana.post(`/api/cases/${id}/retrieve`, { use: ["holdings", "kb"] });
  await ana.post(`/api/cases/${id}/assistant`, { question: "Je, ushahidi gani unaunga mkono dai hili? Toa muhtasari", mode: "ai" });
  const req = seen.at(-1); assert.match(req.messages[0].content, /Kiswahili/); assert.match(req.messages.at(-1).content, /SEARCH LOG[\s\S]*holdings/);
  const msg = (await ana.get(`/api/cases/${id}/assistant`)).body.messages.at(-1); assert.match(msg.content, /Ukweli kutoka kwenye rekodi za kesi/); assert.match(msg.content, /mapendekezo, si matokeo/);
  assert.ok(msg.sources.searches_in_log >= 1);
});

test("service failures fall back to the rule-based answer and say why; nothing invented is stored", async () => {
  const { id } = await makeCase();
  for (const [m, re] of [["error", /unexpectedly stopped/], ["slow", /did not answer within 2 s/], ["garbage", /not valid JSON/]]) {
    mode = m; const r = await ana.post(`/api/cases/${id}/assistant`, { question: "What is missing?", mode: "ai" });
    assert.equal(r.status, 201); assert.equal(r.body.mode, "rules"); assert.equal(r.body.fallback, true); assert.match(r.body.error, re);
    const ms = (await ana.get(`/api/cases/${id}/assistant`)).body.messages, last = ms.at(-1), err = ms.at(-2);
    assert.equal(last.provider, "rules"); assert.match(last.content, /What is missing/); assert.match(last.sources.fallback_from_ai, re); assert.equal(err.status, "error");
  }
  mode = "good";
  assert.equal((await view.post(`/api/cases/${id}/assistant`, { question: "x", mode: "ai" })).status, 403);
});

test("unreachable and misconfigured services: clear messages, AI not shown as available, rules still answer", async () => {
  const closed = await new Promise(ok => { const t = http.createServer().listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => ok(p)); }); });   // a port nothing listens on
  const S2 = await startServer({ ai: AI(`http://127.0.0.1:${closed}`) }), a2 = await login(S2.base, "ana");
  const h = (await a2.get("/api/ai/health?force=1")).body; assert.equal(h.state, "failed"); assert.match(h.error, /refused the connection[\s\S]*OLLAMA_HOST=0\.0\.0\.0/);
  const id = (await a2.post("/api/cases", { claim_text: "A short claim about the Garissa road closure in March." })).body.id;
  const r = await a2.post(`/api/cases/${id}/assistant`, { question: "Summarise the case", mode: "ai" }); assert.equal(r.body.mode, "rules"); assert.match(r.body.error, /refused/);
  await S2.close();
  const S3 = await startServer({ ai: AI("http://ollama.example.com:11434") }), a3 = await login(S3.base, "ana");
  const st = (await a3.get("/api/ai/health")).body; assert.equal(st.state, "not_configured"); assert.match(st.error, /public address/); await S3.close();
  const S4 = await startServer({ ai: { ...AI("http://10.104.4.151:11434") } }); assert.equal(S4.ctx.ai.status().local, true, "the 10.104.4.151 server counts as the organisation's own network"); await S4.close();
});
