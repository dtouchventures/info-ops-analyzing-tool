// Tests the AI server from THIS computer with the same settings AIVS uses (.env): the network path, the model list,
// one short answer, and the AIVS health check itself. Nothing is sent except "Reply with the single word OK."
// Usage:  npm run check:ai
import { config } from "../server/config.js";
import { providers, ollamaBase } from "../server/ai/providers.js";

const c = config.ai, ms = t0 => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
console.log(`AIVS AI check ${new Date().toISOString()}`);
console.log(`Provider: ${c.provider || "(not set)"}  Model: ${c.model || "(not set)"}  Address: ${c.baseUrl || "(default)"}`);
console.log(`Waits: model list ${Math.round((c.connectTimeoutMs || 30000) / 1000)} s (AI_CONNECT_TIMEOUT_MS), health ${Math.round(c.healthTimeoutMs / 1000)} s (AI_HEALTH_TIMEOUT_MS), questions ${Math.round(c.timeoutMs / 1000)} s (AI_TIMEOUT_MS)`);
const proxies = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"].filter(k => process.env[k] || process.env[k.toLowerCase()]);
if (proxies.length) console.log(`Proxy settings present: ${proxies.join(", ")} (an internal address such as the Ollama server should not go through a proxy)`);
if (c.provider !== "ollama") { console.log("This check is for Ollama (AI_PROVIDER=ollama)."); process.exit(2); }
const base = ollamaBase(c); let bad = 0;
async function step(name, pathname, body, wait) {
  const t0 = Date.now(), ac = new AbortController(), t = setTimeout(() => ac.abort(), wait);
  try {
    const r = await fetch(base + pathname, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const j = await r.json().catch(() => null);
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${name}: HTTP ${r.status} in ${ms(t0)}`); if (!r.ok) bad++;
    return j;
  } catch (e) {
    bad++; console.log(`  FAIL  ${name} after ${ms(t0)}: ${e.name === "AbortError" ? `no answer within ${wait / 1000} s` : `${e.message} ${e.cause?.code || e.cause?.message || ""}`}`);
    return null;
  } finally { clearTimeout(t); }
}
const tags = await step("model list (/api/tags)", "/api/tags", null, 60000);
if (tags) {
  const names = (tags.models || []).map(m => m.name);
  console.log(`        installed: ${names.join(", ") || "none"}`);
  if (!names.some(n => n === c.model || n.replace(/:latest$/, "") === c.model)) { bad++; console.log(`  FAIL  the model ${c.model} is not installed on the server`); }
  const g = await step("a short answer (/api/chat)", "/api/chat", { model: c.model, stream: false, keep_alive: c.keepAlive || "30m", options: { temperature: 0, num_predict: 8, num_ctx: c.numCtx || 8192 }, messages: [{ role: "user", content: "Reply with the single word OK." }] }, 180000);
  if (g) console.log(`        reply: ${String(g.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, 40)}`);
}
const t0 = Date.now();
try { const h = await providers.ollama.health(c, { timeoutMs: c.healthTimeoutMs }); console.log(`  PASS  AIVS health check: ${h.model} answered "${h.reply}" in ${ms(t0)}`); }
catch (e) { bad++; console.log(`  FAIL  AIVS health check after ${ms(t0)}: ${e.message}`); }
console.log(bad ? "\nAt least one step failed. If PowerShell reaches the server but this check does not, Windows Firewall or security software may be blocking node.exe; allow Node.js for this network." : "\nThe AI server is reachable from this computer and the model answers.");
process.exit(bad ? 1 : 0);
