// Provider adapters. Each takes { system, text, images:[{id, base64, media_type}] } and returns raw model text.
// API keys are read from server configuration only and never sent to the browser or stored.
async function post(url, headers, body, timeoutMs) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ac.signal });
    const txt = await r.text();
    if (!r.ok) { let msg = txt.slice(0, 300); try { msg = JSON.parse(txt).error?.message || msg; } catch {} throw new Error(`Provider returned HTTP ${r.status}: ${msg}`); }
    return JSON.parse(txt);
  } catch (e) { if (e.name === "AbortError") throw new Error(`Provider did not answer within ${Math.round(timeoutMs / 1000)} s.`); throw e; }
  finally { clearTimeout(t); }
}

export const providers = {
  anthropic: {
    label: "Anthropic Messages API",
    async complete(cfg, { system, text, images }) {
      const content = [];
      for (const im of images) { content.push({ type: "text", text: `Image ${im.id}:` }); content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.base64 } }); }
      content.push({ type: "text", text });
      const j = await post(`${(cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
        { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        { model: cfg.model, max_tokens: 4096, temperature: 0, system, messages: [{ role: "user", content }] }, cfg.timeoutMs);
      return { text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"), model: j.model || cfg.model };
    }
  },
  openai: openaiCompatible("OpenAI-compatible Chat Completions API", "https://api.openai.com", true),
  // Google Gemini through its OpenAI-compatible endpoint (free tier available; check Google's terms on data use)
  gemini: openaiCompatible("Google Gemini (OpenAI-compatible endpoint)", "https://generativelanguage.googleapis.com/v1beta/openai", true),
  // Ollama on this computer or a server on the organisation's network: native API (sets the context size, which
  // the OpenAI-compatible endpoint cannot, so long case material is not silently cut), no key, data stays local
  ollama: ollamaNative()
};
// multi-turn text chat used by the research assistant
providers.anthropic.chat = async function (cfg, { system, messages }) {
  const j = await post(`${(cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    { model: cfg.model, max_tokens: 2048, temperature: 0.2, system, messages }, cfg.timeoutMs);
  return { text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"), model: j.model || cfg.model };
};
export function chatUrl(base) { const b = base.replace(/\/$/, ""); return /\/(openai|v\d+(beta)?)$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`; }
function openaiCompatible(label, defaultBase, needsKey) {
  const url = cfg => chatUrl(cfg.baseUrl || defaultBase), auth = cfg => (cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {});
  return {
    label, defaultBase, needsKey,
    async complete(cfg, { system, text, images }) {
      const content = [{ type: "text", text }];
      for (const im of images) { content.push({ type: "text", text: `Image ${im.id}:` }); content.push({ type: "image_url", image_url: { url: `data:${im.media_type};base64,${im.base64}` } }); }
      const j = await post(url(cfg), auth(cfg), { model: cfg.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content }] }, cfg.timeoutMs);
      return { text: j.choices?.[0]?.message?.content || "", model: j.model || cfg.model };
    },
    async chat(cfg, { system, messages }) {
      const j = await post(url(cfg), auth(cfg), { model: cfg.model, temperature: 0.2, messages: [{ role: "system", content: system }, ...messages] }, cfg.timeoutMs);
      return { text: j.choices?.[0]?.message?.content || "", model: j.model || cfg.model };
    }
  };
}

// ---------------------------------------------------------------- Ollama native API
export const ollamaBase = cfg => String(cfg.baseUrl || "http://localhost:11434").replace(/\/+$/, "").replace(/\/(v1|api)$/, "");
const stripThink = t => String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
async function ollamaCall(cfg, pathname, body, timeoutMs) {
  const base = ollamaBase(cfg), ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base + pathname, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
    if (!r.ok) throw new Error(`Ollama answered HTTP ${r.status}${j?.error ? `: ${String(j.error).slice(0, 200)}` : ""}`);
    if (!j) throw new Error("Ollama did not return JSON.");
    return j;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Ollama at ${base} did not answer within ${Math.round(timeoutMs / 1000)} s. A model on a CPU can be slow, especially on the first question while it loads; try again, or raise AI_TIMEOUT_MS.`);
    const code = e.cause?.code || e.cause?.errors?.[0]?.code || "";
    if (/ECONNREFUSED/.test(code)) throw new Error(`Ollama refused the connection at ${base}. Check that Ollama is running and listening on the network (OLLAMA_HOST=0.0.0.0:11434 on the server) and that its firewall allows this AIVS computer.`);
    if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT/.test(code)) throw new Error(`The Ollama server ${base} cannot be reached from this computer (${code}). Check the network or VPN connection and the server's firewall.`);
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) throw new Error(`The address in AI_BASE_URL (${base}) could not be found.`);
    if (e.message === "fetch failed") throw new Error(`Could not connect to Ollama at ${base} (${code || e.cause?.message || "network error"}). Check AI_BASE_URL, the network and the server's firewall.`);
    throw e;
  } finally { clearTimeout(t); }
}
function ollamaNative() {
  const opts = cfg => ({ temperature: 0.1, num_ctx: cfg.numCtx || 8192 });
  return {
    label: "Ollama (local AI on your network, no key)", defaultBase: "http://localhost:11434", needsKey: false, native: true,
    async chat(cfg, { system, messages, format }) {
      const j = await ollamaCall(cfg, "/api/chat", { model: cfg.model, stream: false, keep_alive: cfg.keepAlive || "30m", options: opts(cfg), ...(format ? { format } : {}), messages: [{ role: "system", content: system }, ...messages] }, cfg.timeoutMs);
      return { text: stripThink(j.message?.content), model: j.model || cfg.model, stats: { prompt_tokens: j.prompt_eval_count ?? null, answer_tokens: j.eval_count ?? null, seconds: j.total_duration ? Math.round(j.total_duration / 1e8) / 10 : null, context: opts(cfg).num_ctx } };
    },
    async complete(cfg, { system, text, images }) {
      const j = await ollamaCall(cfg, "/api/chat", { model: cfg.model, stream: false, format: "json", keep_alive: cfg.keepAlive || "30m", options: { ...opts(cfg), temperature: 0 },
        messages: [{ role: "system", content: system }, { role: "user", content: text, ...(images.length ? { images: images.map(i => i.base64) } : {}) }] }, cfg.timeoutMs);
      return { text: stripThink(j.message?.content), model: j.model || cfg.model };
    },
    // a real check: the server answers, the model is installed, and it generates text
    async health(cfg, { timeoutMs }) {
      // listing models needs no model to load, so no answer here means the server cannot be reached (network, VPN or firewall)
      let tags; const t0 = Date.now();
      // a busy network or a computer still starting up can delay the first answer, so allow AI_CONNECT_TIMEOUT_MS (30 s) and try twice
      const wait = Math.min(cfg.connectTimeoutMs || 30000, timeoutMs);
      for (let i = 0; ; i++) {
        try { tags = await ollamaCall(cfg, "/api/tags", null, wait); break; }
        catch (e) {
          if (!/did not answer within/.test(e.message)) throw e;
          if (i >= 1) throw new Error(`The Ollama server ${ollamaBase(cfg)} did not answer a simple request (list of models) within ${Math.round(wait / 1000)} s, twice, so this computer cannot reach it at the moment. Check the VPN or network connection, then press Check connection (AIVS also checks again by itself). To test from this computer: npm run check:ai`);
        }
      }
      const names = (tags.models || []).map(m => m.name), found = names.find(n => n === cfg.model || n === `${cfg.model}:latest` || n.replace(/:latest$/, "") === cfg.model);
      if (!found) throw Object.assign(new Error(`The model “${cfg.model}” is not installed on the Ollama server. Installed: ${names.slice(0, 8).join(", ") || "none"}. On the server run: ollama pull ${cfg.model}`), { models: names });
      const g = await ollamaCall(cfg, "/api/chat", { model: cfg.model, stream: false, keep_alive: cfg.keepAlive || "30m", options: { temperature: 0, num_predict: 8, num_ctx: cfg.numCtx || 8192 }, messages: [{ role: "user", content: "Reply with the single word OK." }] }, timeoutMs);
      const reply = stripThink(g.message?.content);
      if (!reply) throw new Error("The model answered with empty text.");
      return { model: found, reply: reply.slice(0, 40), latency_ms: Date.now() - t0, models: names.slice(0, 20) };
    }
  };
}
