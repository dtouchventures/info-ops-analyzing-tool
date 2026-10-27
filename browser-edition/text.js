// Rule-based text analysis shared by the server and the browser (plain ES module, no dependencies).
// English and Kiswahili date words, recency terms, Kenyan places and organisations, figures and contacts.
// Deliberately conservative: it proposes candidate claims and entities for an analyst to edit.

const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTHS_SW = ["januari", "februari", "machi", "aprili", "mei", "juni", "julai", "agosti", "septemba", "oktoba", "novemba", "desemba"];
const MON_RE = "(jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch)?|machi|apr(?:il|ili)?|may|mei|jun(?:e|i)?|jul(?:y|ai)?|aug(?:ust)?|agosti|sep(?:t(?:ember|emba)?)?|oct(?:ober)?|oktoba|nov(?:ember|emba)?|dec(?:ember)?|desemba)";
function monIdx(m) {
  const s = m.toLowerCase();
  for (const L of [MONTHS_EN, MONTHS_SW]) { const i = L.findIndex(x => x === s); if (i >= 0) return i; }
  if (s === "mei") return 4; if (s === "machi") return 2; if (s === "agosti") return 7; if (s === "oktoba") return 9; if (s === "desemba") return 11;
  return MONTHS_EN.findIndex(x => x.startsWith(s.slice(0, 3)));
}
const PLACES = ["Baringo","Bomet","Bungoma","Busia","Elgeyo-Marakwet","Embu","Garissa","Homa Bay","Isiolo","Kajiado","Kakamega","Kericho","Kiambu","Kilifi","Kirinyaga","Kisii","Kisumu","Kitui","Kwale","Laikipia","Lamu","Machakos","Makueni","Mandera","Marsabit","Meru","Migori","Mombasa","Murang'a","Nairobi","Nakuru","Nandi","Narok","Nyamira","Nyandarua","Nyeri","Samburu","Siaya","Taita-Taveta","Tana River","Tharaka-Nithi","Trans-Nzoia","Turkana","Uasin Gishu","Vihiga","Wajir","West Pokot","Modika","Dadaab","Liboi","Hulugho","Kolbio","Boni","Kiunga","Mpeketoni","Eldoret","Thika","Malindi","Kismayo","Mogadishu","Afmadow","Dhobley","Lower Juba","Gedo","Somalia","Ethiopia","South Sudan","Uganda","Tanzania","DRC","Goma","Kenya"];
const ORGS = ["Kenya Defence Forces","KDF","Ministry of Defence","MoD","Kenya Army","Kenya Navy","Kenya Air Force","National Police Service","Police","DCI","AMISOM","ATMIS","AUSSOM","UN","United Nations","EAC","Al-Shabaab","Red Cross","NDMA","KWS","Wizara ya Ulinzi","Jeshi"];
const RECENCY = ["breaking","today","tonight","this morning","this afternoon","this evening","last night","yesterday","just now","right now","happening now","currently","this week","this month","this year","now open","ongoing","as we speak",
  "leo","jana","usiku wa jana","jana usiku","leo asubuhi","asubuhi hii","sasa hivi","hivi punde","wiki hii","mwezi huu","kwa sasa"];
const LEADS = /^(breaking|urgent|update|alert|just in|exclusive|habari|taarifa|tahadhari)\s*(news|public notice|kwa umma)?\s*[:!\-–]+\s*/i;

function extractEntities(text) {
  const T = String(text || ""), dates = [], used = [];
  const add = (m, iso, precision) => { if (used.some(([a, b]) => m.index < b && m.index + m[0].length > a)) return; used.push([m.index, m.index + m[0].length]); dates.push({ text: m[0], iso, year: iso ? +iso.slice(0, 4) : null, precision }); };
  const pad = n => String(n).padStart(2, "0");
  const pats = [
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"), m => `${m[3]}-${pad(monIdx(m[2]) + 1)}-${pad(m[1])}`, "day"],
    [new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–]\\s*\\d{1,2})?,?\\s+(\\d{4})\\b`, "gi"), m => `${m[3]}-${pad(monIdx(m[1]) + 1)}-${pad(m[2])}`, "day"],
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, m => `${m[1]}-${m[2]}-${m[3]}`, "day"],
    [/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g, m => `${m[3]}-${pad(m[2])}-${pad(m[1])}`, "day"],   // day/month/year (Kenyan usage)
    [new RegExp(`\\b${MON_RE}\\s+(\\d{4})\\b`, "gi"), m => `${m[2]}-${pad(monIdx(m[1]) + 1)}-01`, "month"],
    [/\b(19[4-9]\d|20[0-4]\d)\b/g, m => `${m[1]}-01-01`, "year"]
  ];
  for (const [re, f, precision] of pats) { let m; re.lastIndex = 0; while ((m = re.exec(T))) { const iso = f(m); if (!/NaN|-00-|-0-/.test(iso)) add(m, iso, precision); } }
  const low = T.toLowerCase();
  const relative = RECENCY.filter(r => new RegExp(`(^|[^a-z])${r.replace(/ /g, "\\s+")}([^a-z]|$)`, "i").test(low));
  const locations = PLACES.filter(p => new RegExp(`\\b${p.replace(/[-']/g, ".")}\\b`, "i").test(T));
  const orgs = ORGS.filter(o => new RegExp(`\\b${o}\\b`, o.length <= 3 ? "" : "i").test(T)).filter((o, i, a) => !(o === "KDF" && a.includes("Kenya Defence Forces")));
  const numbers = [];
  for (const re of [/\b(?:K?Sh\.?|KES|Ksh)\s?[\d,]+(?:\.\d+)?\b/gi, /\(?\+?\b(?:254|0)\d{1,3}\)?[\s-]?\d{3}[\s-]?\d{3,4}\b/g,
    /\b\d[\d,]*\s+(?:soldiers|troops|officers|people|civilians|vehicles|trucks|killed|dead|injured|casualties|bodies|recruits|wanajeshi|watu|magari)\b/gi]) {
    let m; while ((m = re.exec(T))) numbers.push(m[0].trim());
  }
  return { dates, relative, locations, orgs, numbers: [...new Set(numbers)] };
}

// Split a post into candidate claims. Adds an explicit timing claim when recency words appear and a
// media claim when media is attached, because those are what recycled-media posts usually get wrong.
function extractClaims(text, hasMedia) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const claims = splitSentences(clean).map(s => ({ text: s, kind: "statement" }));
  const ent = extractEntities(clean);
  if (ent.relative.length) claims.push({ text: `The events described are recent (the post uses ${ent.relative.map(r => `“${r}”`).join(", ")})`, kind: "timing" });
  if (ent.locations.length && claims.length) claims.push({ text: `The events took place in or near ${ent.locations.join(", ")}`, kind: "location" });
  if (hasMedia) claims.push({ text: "The attached media shows the event described in the post", kind: "media" });
  return claims;
}
function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(])/).map(s => s.replace(LEADS, "").replace(/[.!]+$/, "").trim()).filter(s => s.split(/\s+/).length >= 4);
}

// Text that looks like instructions aimed at an AI system. Flagged to the analyst; never obeyed.
const INJECTION = [/ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i, /disregard (your|the|all) (instructions|rules|system prompt)/i,
  /you are (now )?(chatgpt|claude|an ai|a language model|the assistant)/i, /system prompt/i, /\b(assistant|system)\s*:/i, /(classify|mark|rate|label) (this|it) as (authentic|true|verified|supported)/i,
  /do not (flag|report|mention)/i, /(puuza|usizingatie) maagizo/i];
function injectionFlags(text) { return INJECTION.filter(re => re.test(String(text || ""))).map(re => (String(text).match(re) || [""])[0]); }

// ---------------------------------------------------------------- statement type (hint for the analyst)
// Rule-based and conservative. Distinguishes statements that can be checked against evidence from opinions,
// predictions, satire and questions, in English and Kiswahili. The analyst always decides; a hint never
// sets an assessment by itself.
const TYPE_CUES = {
  question: [/\?\s*$/, /^(who|what|when|where|why|how|is|are|did|does|can|will|je|nani|nini|lini|wapi|kwa nini|vipi)\b/i],
  appeal: [/^(please\s+)?(share|forward|send|retweet|repost|spread|tell everyone|sambaza|tuma|shiriki|wajulishe)\b/i, /\b(share (this|widely)|before (they|it gets?) (delete|remove)|sambaza (ujumbe )?huu)\b/i],
  satire: [/\b(satire|satirical|parody|spoof|just kidding|#satire|#parody|kejeli|utani|mzaha)\b/i],
  prediction: [/\b(will|shall|going to|is expected to|are expected to|is set to|are set to|forecast|predicts?|projected to|is likely to|are likely to|by 20[3-9]\d|in the coming (days|weeks|months|years))\b/i,
    /\b(itakuwa|watakuwa|atakuwa|inatarajiwa|wanatarajiwa|anatarajiwa|huenda|siku zijazo|mwaka ujao)\b/i],
  opinion: [/\b(i think|i believe|i feel|in my (view|opinion)|we believe|should|ought to|must be|it is (shameful|a disgrace|terrible|wonderful|unacceptable)|best|worst|greatest|corrupt (leaders|government)|useless|disgraceful|shameful)\b/i,
    /\b(nadhani|naamini|nafikiri|kwa maoni yangu|inapaswa|lazima|aibu|bora kuliko|mbaya zaidi)\b/i]
};
function classifyStatement(text) {
  const t = String(text || "").trim(), cues = [];
  for (const type of ["satire", "appeal", "question", "prediction", "opinion"]) {
    for (const re of TYPE_CUES[type]) { const m = t.match(re); if (m) { cues.push(m[0]); return { type, cues }; } }
  }
  return { type: "factual", cues };
}
const STATEMENT_TYPES = {
  factual: "Factual claim: can be checked against evidence",
  opinion: "Opinion or value judgement: not verifiable as true or false",
  prediction: "Prediction about the future: not verifiable yet",
  satire: "Marked as satire or humour: check how it is being shared",
  question: "Question: not a claim by itself",
  appeal: "Call to action (share, forward, send): not a claim by itself"
};

// ---------------------------------------------------------------- source details from a link and the text
// Everything here is a suggestion shown to the analyst, who can change it. Dates are only derived where the
// platform documents how post IDs encode time (X/Twitter "snowflake" IDs; TikTok video IDs).
const OUTLETS = { "nation.africa": "Nation (Kenya)", "standardmedia.co.ke": "The Standard (Kenya)", "the-star.co.ke": "The Star (Kenya)", "citizen.digital": "Citizen Digital",
  "kbc.co.ke": "KBC", "capitalfm.co.ke": "Capital FM", "tuko.co.ke": "Tuko", "kenyans.co.ke": "Kenyans.co.ke", "pd.co.ke": "People Daily", "kenyanews.go.ke": "Kenya News Agency",
  "bbc.com": "BBC", "bbc.co.uk": "BBC", "aljazeera.com": "Al Jazeera", "reuters.com": "Reuters", "apnews.com": "AP News", "theeastafrican.co.ke": "The EastAfrican", "monitor.co.ug": "Daily Monitor (Uganda)",
  "thecitizen.co.tz": "The Citizen (Tanzania)", "africacheck.org": "Africa Check", "pesacheck.org": "PesaCheck" };
const XEPOCH = 1288834974657n;
const fromXId = id => { try { const n = BigInt(id); if (n < 2n ** 40n) return null; const ms = Number((n >> 22n) + XEPOCH); return ms > Date.UTC(2010, 10, 1) && ms < Date.now() + 864e5 ? new Date(ms).toISOString() : null; } catch { return null; } };
const fromTikTokId = id => { try { const s = Number(BigInt(id) >> 32n); return s > Date.UTC(2016, 0, 1) / 1000 && s * 1000 < Date.now() + 864e5 ? new Date(s * 1000).toISOString() : null; } catch { return null; } };

function parseSourceLink(input) {
  let u; try { u = new URL(String(input || "").trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|mbasic)\./, ""), p = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const r = { url: u.href, platform: null, account: null, post_id: null, published_at: null, published_basis: null };
  if (/^(twitter\.com|x\.com|vxtwitter\.com|fxtwitter\.com|fixupx\.com)$/.test(host)) {
    r.platform = "X (Twitter)";
    if (p[0] && !["i", "search", "hashtag", "home", "explore"].includes(p[0])) r.account = "@" + p[0];
    const st = p.indexOf("status"); if (st >= 0 && /^\d+$/.test(p[st + 1] || "")) { r.post_id = p[st + 1]; r.published_at = fromXId(r.post_id); if (r.published_at) r.published_basis = "derived from the post ID in the link (X post IDs encode their creation time)"; }
    if (p[0] === "hashtag" && p[1]) r.hashtags = ["#" + p[1]];
  } else if (/^(facebook\.com|fb\.com|fb\.watch)$/.test(host)) {
    r.platform = "Facebook";
    if (p[0] && !["story.php", "permalink.php", "watch", "groups", "photo", "photo.php", "share", "reel", "profile.php", "events"].includes(p[0])) r.account = p[0];
    if (p[0] === "groups" && p[1]) r.account = `group ${p[1]}`;
    if (p[0] === "profile.php" && u.searchParams.get("id")) r.account = `profile ${u.searchParams.get("id")}`;
  } else if (host === "instagram.com") {
    r.platform = "Instagram"; if (p[0] && !["p", "reel", "reels", "tv", "stories", "explore"].includes(p[0])) r.account = "@" + p[0]; if (p[0] === "stories" && p[1]) r.account = "@" + p[1];
  } else if (host === "tiktok.com" || host === "vm.tiktok.com") {
    r.platform = "TikTok"; if (p[0]?.startsWith("@")) r.account = p[0];
    const v = p.indexOf("video"); if (v >= 0 && /^\d+$/.test(p[v + 1] || "")) { r.post_id = p[v + 1]; r.published_at = fromTikTokId(r.post_id); if (r.published_at) r.published_basis = "derived from the video ID in the link (TikTok video IDs encode their upload time)"; }
  } else if (host === "youtube.com" || host === "youtu.be") {
    r.platform = "YouTube"; if (p[0]?.startsWith("@")) r.account = p[0]; if ((p[0] === "c" || p[0] === "channel" || p[0] === "user") && p[1]) r.account = p[1];
  } else if (host === "t.me" || host === "telegram.me") { r.platform = "Telegram"; if (p[0] && p[0] !== "s") r.account = "@" + p[0]; if (p[0] === "s" && p[1]) r.account = "@" + p[1]; }
  else if (/(^|\.)whatsapp\.com$|^wa\.me$/.test(host)) r.platform = "WhatsApp";
  else if (host === "threads.net") { r.platform = "Threads"; if (p[0]?.startsWith("@")) r.account = p[0]; }
  else if (host === "linkedin.com") { r.platform = "LinkedIn"; if ((p[0] === "in" || p[0] === "company") && p[1]) r.account = p[1]; }
  else if (host === "reddit.com") { r.platform = "Reddit"; if (p[0] === "r" && p[1]) r.account = "r/" + p[1]; if (p[0] === "user" && p[1]) r.account = "u/" + p[1]; }
  else { const k = Object.keys(OUTLETS).find(d => host === d || host.endsWith("." + d)); r.platform = k ? OUTLETS[k] : `${host} (website)`; }
  return r;
}
const extractHashtags = text => [...new Set((String(text || "").match(/(^|[^\p{L}\p{N}_&/#])#[\p{L}\p{N}_]{2,60}/gu) || []).map(h => h.trim().replace(/^[^#]+/, "")))];
const extractLinks = text => [...new Set(String(text || "").match(/https?:\/\/[^\s<>"'“”‘’)\]]+/g) || [])].map(l => l.replace(/[.,;:!?]+$/, ""));

// Suggestions for the source fields of a new case, from a link and/or the pasted text.
function suggestSource({ text = "", url = "" } = {}) {
  const link = String(url || "").trim() || extractLinks(text)[0] || "", L = link ? parseSourceLink(link) : null, ent = extractEntities(text);
  const tags = [...new Set([...(L?.hashtags || []), ...extractHashtags(text)])];
  const days = [...new Set(ent.dates.filter(d => d.precision === "day").map(d => d.iso))];
  let event = null;
  if (ent.relative.length) event = { basis: `the text says ${ent.relative.slice(0, 3).map(r => `“${r}”`).join(", ")}` };
  else if (days.length === 1) { const d = ent.dates.find(x => x.iso === days[0]); event = { at: `${days[0]}T00:00:00.000Z`, basis: `date written in the text: “${d.text}”` }; }
  return { url: L ? L.url : null, platform: L?.platform || null, account: L?.account || null, published_at: L?.published_at || null, published_basis: L?.published_basis || null, hashtags: tags, event };
}
