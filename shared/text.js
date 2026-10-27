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
export const PLACES = ["Baringo","Bomet","Bungoma","Busia","Elgeyo-Marakwet","Embu","Garissa","Homa Bay","Isiolo","Kajiado","Kakamega","Kericho","Kiambu","Kilifi","Kirinyaga","Kisii","Kisumu","Kitui","Kwale","Laikipia","Lamu","Machakos","Makueni","Mandera","Marsabit","Meru","Migori","Mombasa","Murang'a","Nairobi","Nakuru","Nandi","Narok","Nyamira","Nyandarua","Nyeri","Samburu","Siaya","Taita-Taveta","Tana River","Tharaka-Nithi","Trans-Nzoia","Turkana","Uasin Gishu","Vihiga","Wajir","West Pokot","Modika","Dadaab","Liboi","Hulugho","Kolbio","Boni","Kiunga","Mpeketoni","Eldoret","Thika","Malindi","Kismayo","Mogadishu","Afmadow","Dhobley","Lower Juba","Gedo","Somalia","Ethiopia","South Sudan","Uganda","Tanzania","DRC","Goma","Kenya"];
export const ORGS = ["Kenya Defence Forces","KDF","Ministry of Defence","MoD","Kenya Army","Kenya Navy","Kenya Air Force","National Police Service","Police","DCI","AMISOM","ATMIS","AUSSOM","UN","United Nations","EAC","Al-Shabaab","Red Cross","NDMA","KWS","Wizara ya Ulinzi","Jeshi"];
export const RECENCY = ["breaking","today","tonight","this morning","this afternoon","this evening","last night","yesterday","just now","right now","happening now","currently","this week","this month","this year","now open","ongoing","as we speak",
  "leo","jana","usiku wa jana","jana usiku","leo asubuhi","asubuhi hii","sasa hivi","hivi punde","wiki hii","mwezi huu","kwa sasa"];
const LEADS = /^(breaking|urgent|update|alert|just in|exclusive|habari|taarifa|tahadhari)\s*(news|public notice|kwa umma)?\s*[:!\-–]+\s*/i;

export function extractEntities(text) {
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
export function extractClaims(text, hasMedia) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const claims = splitSentences(clean).map(s => ({ text: s, kind: "statement" }));
  const ent = extractEntities(clean);
  if (ent.relative.length) claims.push({ text: `The events described are recent (the post uses ${ent.relative.map(r => `“${r}”`).join(", ")})`, kind: "timing" });
  if (ent.locations.length && claims.length) claims.push({ text: `The events took place in or near ${ent.locations.join(", ")}`, kind: "location" });
  if (hasMedia) claims.push({ text: "The attached media shows the event described in the post", kind: "media" });
  return claims;
}
export function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(])/).map(s => s.replace(LEADS, "").replace(/[.!]+$/, "").trim()).filter(s => s.split(/\s+/).length >= 4);
}

// Text that looks like instructions aimed at an AI system. Flagged to the analyst; never obeyed.
const INJECTION = [/ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i, /disregard (your|the|all) (instructions|rules|system prompt)/i,
  /you are (now )?(chatgpt|claude|an ai|a language model|the assistant)/i, /system prompt/i, /\b(assistant|system)\s*:/i, /(classify|mark|rate|label) (this|it) as (authentic|true|verified|supported)/i,
  /do not (flag|report|mention)/i, /(puuza|usizingatie) maagizo/i];
export function injectionFlags(text) { return INJECTION.filter(re => re.test(String(text || ""))).map(re => (String(text).match(re) || [""])[0]); }

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
export function classifyStatement(text) {
  const t = String(text || "").trim(), cues = [];
  for (const type of ["satire", "appeal", "question", "prediction", "opinion"]) {
    for (const re of TYPE_CUES[type]) { const m = t.match(re); if (m) { cues.push(m[0]); return { type, cues }; } }
  }
  return { type: "factual", cues };
}
export const STATEMENT_TYPES = {
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

export function parseSourceLink(input) {
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
export const extractHashtags = text => [...new Set((String(text || "").match(/(^|[^\p{L}\p{N}_&/#])#[\p{L}\p{N}_]{2,60}/gu) || []).map(h => h.trim().replace(/^[^#]+/, "")))];
export const extractLinks = text => [...new Set(String(text || "").match(/https?:\/\/[^\s<>"'“”‘’)\]]+/g) || [])].map(l => l.replace(/[.,;:!?]+$/, ""));

// Suggestions for the source fields of a new case, from a link and/or the pasted text.
export function suggestSource({ text = "", url = "" } = {}) {
  const link = String(url || "").trim() || extractLinks(text)[0] || "", L = link ? parseSourceLink(link) : null, ent = extractEntities(text);
  const tags = [...new Set([...(L?.hashtags || []), ...extractHashtags(text)])];
  const days = [...new Set(ent.dates.filter(d => d.precision === "day").map(d => d.iso))];
  let event = null;
  if (ent.relative.length) event = { basis: `the text says ${ent.relative.slice(0, 3).map(r => `“${r}”`).join(", ")}` };
  else if (days.length === 1) { const d = ent.dates.find(x => x.iso === days[0]); event = { at: `${days[0]}T00:00:00.000Z`, basis: `date written in the text: “${d.text}”` }; }
  return { url: L ? L.url : null, platform: L?.platform || null, account: L?.account || null, published_at: L?.published_at || null, published_basis: L?.published_basis || null, hashtags: tags, event };
}

// ---------------------------------------------------------------- Kenya / East Africa red flags (leads, not findings)
// Patterns that fact-checkers in the region often see in scams, fake notices and misleading posts. Each flag
// is a reason to check something, with the public sources that can settle it. None of them proves anything.
export const TOPICS = { government_notice: "Fake government announcement", health: "Public health", finance_scam: "Financial scam or fraudulent investment", election: "Elections",
  statistics: "Public statistics", quotation: "Quotation attributed to someone", disaster: "Disaster or emergency", impersonation: "Impersonation (including AI-generated)", recruitment: "Recruitment or jobs" };
const FLAG_RULES = [
  { key: "payment", topic: "finance_scam", re: [/\b(pay|send|deposit|tuma|lipa|weka)\b[^.!?\n]{0,60}\b(k?sh\.?|kes|ksh|m-?pesa|fee|ada|shilingi)/i, /\b(processing|registration|application|clearance|activation) fee\b|\bada ya (usajili|maombi)\b/i],
    text: "Asks for money (a fee or an M-Pesa payment) before a job, grant, loan, prize or registration. Genuine public recruitment and government services do not ask for payment through personal numbers.", check: "Check the organisation's official website and verified accounts for the notice; search fact-checkers for the same message." },
  { key: "phone", topic: "impersonation", re: [/\b(ministry|wizara|government|serikali|kdf|defence|police|polisi|county|kaunti|kra|nhif|sha|helb|iebc|knbs|safaricom)\b[\s\S]{0,200}(\+?254|\b0)7\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/i],
    text: "Names an official body but gives a personal mobile number as the contact. Official bodies publish their contacts on their own websites.", check: "Compare the number with contacts listed on the organisation's official website." },
  { key: "urgency", topic: null, re: [/\b(share before|before (they|it) (delete|remove)|share (this )?widely|today only|limited (slots|places|offer)|act now|forward to \d+|nafasi (ni )?chache|haraka sana|sambaza (kwa|ujumbe)|leo tu)\b/i],
    text: "Pressures people to act or share quickly. Urgency is a common feature of scams and misleading posts.", check: "Slow down: confirm the claim with an independent source before acting or sharing." },
  { key: "returns", topic: "finance_scam", re: [/\b(guaranteed (returns?|profit|income)|double your money|\d{2,3}\s?% (returns?|profit|interest) (per|a|every) (day|week|month)|risk[- ]free investment|faida ya uhakika|zidisha pesa)\b/i],
    text: "Promises guaranteed or very high returns. Licensed investment schemes cannot guarantee returns.", check: "Check the Capital Markets Authority (cma.or.ke) list of licensed firms and its investor alerts, and Central Bank of Kenya warnings." },
  { key: "cure", topic: "health", re: [/\b(cures?|cured|heals?|tiba ya|inatibu|huponya)\b[^.!?\n]{0,40}\b(malaria|cancer|hiv|aids|covid|diabetes|kisukari|ukimwi|saratani|cholera|kipindupindu|tb|tuberculosis)\b/i, /\b(miracle|secret) (cure|remedy)\b|\bdawa ya miujiza\b/i],
    text: "Claims a cure or treatment for a serious disease. Health claims need confirmation from health authorities or peer-reviewed evidence.", check: "Check the Ministry of Health (health.go.ke), the Kenya Medical Research Institute, WHO guidance, and fact-checkers." },
  { key: "election", topic: "election", re: [/\b(election|ballot|polling|tally|results|rigged|iebc|uchaguzi|kura|matokeo)\b/i],
    text: "Concerns an election. Check it neutrally against official results and records, whichever candidate or party it favours.", check: "Check the IEBC (iebc.or.ke) official results and statements, and independent observers' reports." },
  { key: "statistics", topic: "statistics", re: [/\b\d+(\.\d+)?\s?(%|percent|per cent|asilimia)\b/i, /\b(unemployment|inflation|gdp|census|poverty rate|population|ukosefu wa ajira|mfumuko wa bei|sensa)\b/i],
    text: "Contains statistics. Figures are often quoted out of date, out of context or from the wrong measure.", check: "Find the original figure and its date at the Kenya National Bureau of Statistics (knbs.or.ke), the Central Bank or the publishing agency." },
  { key: "quote", topic: "quotation", re: [/[“"][^”"]{15,300}[”"]\s*,?\s*(said|says|alisema|amesema|according to|kwa mujibu wa)\b/i, /\b(said|alisema|amesema)\b[^.!?\n]{0,60}[“"][^”"]{15,300}[”"]/i],
    text: "Attributes a quotation to someone. Fabricated and altered quotes are common.", check: "Find the original speech, recording, transcript or the person's verified account, and compare the exact words." },
  { key: "disaster", topic: "disaster", re: [/\b(flood(s|ing)?|landslide|earthquake|drought|fire|explosion|collapse|cholera outbreak|mafuriko|maporomoko|tetemeko|ukame|moto|mlipuko)\b/i],
    text: "Concerns a disaster or emergency, where recycled images and false casualty figures spread quickly.", check: "Check the Kenya Meteorological Department (meteo.go.ke), the National Drought Management Authority (ndma.go.ke), the Kenya Red Cross and county disaster statements." },
  { key: "notice", topic: "government_notice", re: [/\b(public notice|press (release|statement)|official notice|circular|gazette notice|tangazo( rasmi)?|taarifa kwa umma)\b/i],
    text: "Presented as an official notice. Fake notices copy letterheads, logos and signatures.", check: "Look for the notice on the issuing body's official website, verified social accounts or the Kenya Gazette (kenyalaw.org)." },
  { key: "recruit", topic: "recruitment", re: [/\b(recruit(ment|ing)|hiring|job (vacancies|offer)|vacancies|ajira|inaajiri|wanaajiri|anaajiri|kuajiri|nafasi za kazi|usajili wa (vijana|askari))\b/i],
    text: "Advertises recruitment or jobs. Fake recruitment notices often ask for fees.", check: "Check the recruiting body's official website for the advert and its stated process." },
  { key: "ai_voice", topic: "impersonation", re: [/\b(voice note|audio|video call|deepfake|ai[- ]generated|sauti ya)\b[\s\S]{0,120}\b(president|rais|governor|gavana|minister|waziri|cs\b|ps\b|ceo|bank)\b/i, /\b(president|rais|governor|minister|waziri)\b[\s\S]{0,120}\b(voice note|audio|video|deepfake)\b/i],
    text: "Involves audio or video of a public figure, which can be imitated with AI. A convincing voice or face is not proof of identity.", check: "Look for the same statement on the person's verified channels and in reliable media; treat AI-detection tools as unreliable on their own." }
];
export function redFlags(text) {
  const t = String(text || ""), out = [];
  for (const r of FLAG_RULES) { const m = r.re.map(re => t.match(re)).find(Boolean); if (m) out.push({ key: r.key, topic: r.topic, cue: m[0].trim().slice(0, 80), text: r.text, check: r.check }); }
  return out;
}
export function topicOf(flags) {
  const order = ["finance_scam", "impersonation", "government_notice", "recruitment", "health", "election", "disaster", "quotation", "statistics"];
  for (const k of order) if (flags.some(f => f.topic === k)) return k;
  return null;
}

// ---------------------------------------------------------------- post screenshots (OCR text -> account, time, message)
// Rule-based reading of a social-media screenshot's OCR text. Every field is a SUGGESTION for the analyst
// to check against the image; nothing is filled in without saying where it came from.
const UI_NOISE = /^(like|likes|comment|comments|share|shares|reply|replies|repost|reposts|retweet|retweets|quote|quotes|follow|following|followers|send|save|more|see more|see translation|translate|write a comment.*|most relevant|all comments|top comments|view more comments.*|liked by.*|reacted.*|sponsored|promoted|pinned|edited|·|…|\.\.\.|views?|bookmarks?|penda|toa maoni|shiriki|jibu|fuata)$/i;
const COUNTS = /^([\d.,]+\s*[kmb]?\s*(likes?|comments?|shares?|views?|reposts?|retweets?|replies|quotes|bookmarks|reactions?|maoni|kushiriki)?\s*)+$/i;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11, januari: 0, februari: 1, machi: 2, aprili: 3, mei: 4, juni: 5, julai: 6, agosti: 7, septemba: 8, oktoba: 9, novemba: 10, desemba: 11 };
const monthOf = m => { const k = String(m).toLowerCase(); return MONTHS[k] ?? MONTHS[k.slice(0, 3)]; };
function clock(h, mi, ap) { h = Number(h); mi = Number(mi || 0); if (ap) { ap = ap.toLowerCase(); if (ap.startsWith("p") && h < 12) h += 12; if (ap.startsWith("a") && h === 12) h = 0; } return [h, mi]; }
export function findPostTime(text, fileTime) {
  const t = String(text || ""), now = fileTime ? new Date(fileTime) : null, yr = (now || new Date()).getFullYear();
  const mk = (y, mo, d, h = 12, mi = 0) => { const x = new Date(y, mo, d, h, mi); return isNaN(x) ? null : x; };
  let m;
  // X: "3:45 PM · Oct 21, 2026"
  if ((m = t.match(/(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?\s*·\s*([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(\d{4})/i)) && monthOf(m[4]) != null) { const [h, mi] = clock(m[1], m[2], m[3]); return { at: mk(+m[6], monthOf(m[4]), +m[5], h, mi), basis: `time shown on the post: “${m[0]}”`, exact: true }; }
  // "21 October 2026 at 15:45" / "October 21, 2026 at 3:45 PM" / "21 October at 15:45"
  if ((m = t.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s*(\d{4})?\s*(?:at|saa)?\s*(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i)) && monthOf(m[2]) != null) { const [h, mi] = clock(m[4], m[5], m[6]); return { at: mk(m[3] ? +m[3] : yr, monthOf(m[2]), +m[1], h, mi), basis: `date and time shown on the post: “${m[0].trim()}”${m[3] ? "" : " (year assumed)"}`, exact: !!m[3] }; }
  if ((m = t.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?\s*(?:at)?\s*(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i)) && monthOf(m[1]) != null) { const [h, mi] = clock(m[4], m[5], m[6]); return { at: mk(m[3] ? +m[3] : yr, monthOf(m[1]), +m[2], h, mi), basis: `date and time shown on the post: “${m[0].trim()}”${m[3] ? "" : " (year assumed)"}`, exact: !!m[3] }; }
  // numeric "21/10/2026 15:45" (day first, as used in Kenya)
  if ((m = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,]+(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?)?/i))) { const [h, mi] = m[4] ? clock(m[4], m[5], m[6]) : [12, 0]; return { at: mk(+m[3], +m[2] - 1, +m[1], h, mi), basis: `date shown on the post: “${m[0].trim()}” (read as day/month/year)${m[4] ? "" : ", no time shown"}`, exact: !!m[4] }; }
  // date without time: "21 October" / "Oct 21, 2026"
  if ((m = t.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*(\d{4})?\b/)) && monthOf(m[2]) != null) return { at: mk(m[3] ? +m[3] : yr, monthOf(m[2]), +m[1]), basis: `date shown on the post: “${m[0].trim()}”, no time shown`, exact: false };
  if ((m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?\b/)) && monthOf(m[1]) != null && /\d/.test(m[2])) return { at: mk(m[3] ? +m[3] : yr, monthOf(m[1]), +m[2]), basis: `date shown on the post: “${m[0].trim()}”, no time shown`, exact: false };
  // relative: "Yesterday at 9:15", "2h", "35 min", "3d" — counted back from the screenshot's file time
  if (now) {
    if ((m = t.match(/\b(yesterday|jana)\s*(?:at|saa)?\s*(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i))) { const [h, mi] = clock(m[2], m[3], m[4]); const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(h, mi, 0, 0); return { at: d, basis: `“${m[0]}” counted back from the screenshot's file time (approximate)`, exact: false };}
    if ((m = t.match(/(?:^|\s|·)(\d{1,2})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?|dakika|saa|siku)\b(?:\s*ago)?/i))) {
      const n = +m[1], u = m[2].toLowerCase(), ms = /^(m|min|dakika)/.test(u) ? 6e4 : /^(h|hr|hour|saa)/.test(u) ? 36e5 : /^(d|day|siku)/.test(u) ? 864e5 : 6048e5;
      return { at: new Date(now - n * ms), basis: `“${m[0].trim()}” counted back from the screenshot's file time (approximate)`, exact: false };
    }
  }
  return null;
}
export function parsePostScreenshot(text, { fileTime } = {}) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const UIW = new Set("like likes comment comments share shares reply replies repost reposts retweet retweets quote quotes send save follow more · • | penda toa maoni shiriki jibu fuata tuma".split(" "));
  const allUi = l => { const w = l.toLowerCase().split(/[\s·•|]+/).filter(Boolean); return w.length > 0 && w.every(x => UIW.has(x) || /^[\d.,]+[kmb]?$/.test(x)); };
  const keep = lines.filter(l => !UI_NOISE.test(l) && !COUNTS.test(l) && !allUi(l) && l.length > 1);
  let account = null, accountBasis = null, platform = null;
  const handle = keep.join(" ").match(/(^|\s)@([A-Za-z0-9_]{2,30})\b/);
  if (handle) { account = handle[2]; accountBasis = `handle “@${handle[2]}” read from the screenshot`; }
  const all = lines.join(" ").toLowerCase();
  if (/\b(repost|retweet|quote|views)\b/.test(all) && handle) platform = "X (Twitter)";
  else if ((/\b(like|comment|share)\b/.test(all) && /\b(comment|share)\b/.test(all)) || /\b(toa maoni|shiriki)\b/.test(all)) platform = "Facebook";
  else if (/\bliked by\b|\binstagram\b/.test(all)) platform = "Instagram";
  else if (/\btiktok\b/.test(all)) platform = "TikTok";
  else if (/\bforwarded\b|\bwhatsapp\b/.test(all)) platform = "WhatsApp";
  // the first short line that is not a time, count or handle is usually the account or page name
  const timeLine = l => !!findPostTime(l, Date.now()) && l.length < 40;
  const nameIdx = keep.findIndex(l => l.length <= 50 && !/[.!?]$/.test(l) && !timeLine(l) && !/^@/.test(l) && /\p{L}/u.test(l) && l.split(" ").length <= 6);
  if (!account && nameIdx >= 0) { account = keep[nameIdx].replace(/\s*[·•✓✔️]+.*$/u, "").trim(); accountBasis = `first name-like line in the screenshot: “${keep[nameIdx]}”`; }
  const time = findPostTime(lines.join("\n"), fileTime);
  const body = keep.filter((l, i) => i !== nameIdx && !(handle && l.replace(/^@/, "").includes(handle[2]) && l.length < 45) && !timeLine(l));
  return { account: account ? account.toLowerCase().replace(/^@/, "").slice(0, 80) : "", account_basis: accountBasis, posted_at: time?.at ? time.at.toISOString() : null, time_basis: time?.basis || null, time_exact: !!time?.exact, text: body.join(" ").trim(), platform };
}
