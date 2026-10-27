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
  // Ollama running on this computer or a server on the network: free, no key, data stays local
  ollama: openaiCompatible("Ollama (local AI, no key)", "http://localhost:11434", false)
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
