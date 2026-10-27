// Verify Information: one box for a claim, article text or a link. Creates a case, archives the page
// (for links) and splits the content into claims, then hands over to the case workspace.
import { api } from "../api.js";
import { App, crumbs, refreshNavCounts } from "../app.js";
import { $, $$, esc, errMsg, fmtDT } from "../ui.js";

const TYPE = { factual: ["checkable statement", "teal"], opinion: ["opinion", "warn"], prediction: ["prediction", "warn"], satire: ["satire or humour", "warn"], question: ["question", "warn"], appeal: ["call to action", "warn"] };
// Invented practice texts, clearly labelled. They are not real posts.
const SAMPLES = [
  ["Practice: health rumour (English)", "BREAKING: The Ministry of Health has confirmed that drinking hot lemon water every hour cures malaria. Clinics in Kisumu have stopped giving medicine since last week. Share before they delete this!"],
  ["Practice: job scam (Kiswahili)", "TANGAZO: Wizara ya Ulinzi inaajiri vijana 5,000 mwezi huu. Tuma Sh1,500 kwa M-Pesa namba 0712 345 678 ili kusajiliwa. Nafasi ni chache, tuma leo!"],
  ["Practice: opinion and prediction", "I think the new road in Garissa is the worst project ever built. Prices of fuel will rise by 2030. The road was opened in March 2024 by the county government."]
];

const VLABEL = { supported: "Supported", contradicted: "Contradicted", partially_supported: "Partially supported", misleading_context: "Misleading context", insufficient: "Insufficient evidence", not_verifiable: "Not verifiable" };
function searchOpt() {
  const ext = (App.meta.search || []).filter(s => s.sends_to), on = ext.filter(s => s.configured);
  return `<div class="panel small" style="margin-top:12px"><label><input type="checkbox" id="vs" ${on.length ? "checked" : ""}> Also search for published fact-checks and sources</label>
    <div class="sub" style="margin-top:4px">Always searched: the AIVS knowledge base and earlier investigations (inside AIVS). External: ${ext.map(s => `${esc(s.label)} ${s.configured ? "<b>(ready)</b>" : "<span>(not configured)</span>"}`).join(", ") || "none"}.${on.length ? " With this ticked, the claim wording is sent to the services marked ready." : " No external service has an API key, so only internal sources are searched. AIVS will not invent results."}</div></div>`;
}
function searchSummary(r) {
  const S = r.search; if (!S) return "";
  if (S.error) return `<div class="callout warn" style="margin-top:8px"><div>Evidence search could not run: ${esc(S.error)}. The case was created; you can search again from its Claims tab.</div></div>`;
  const rows = (S.connectors || []).map(x => `<li>${esc(x.label)}: ${!x.configured ? "not configured" : x.errors?.length ? `<span style="color:var(--con)">${esc(x.errors.join("; "))}</span>` : `${x.results} result${x.results === 1 ? "" : "s"}`}</li>`).join("");
  const n = (r.evidence || []).length;
  return `<div class="panel small" style="margin-top:10px"><b>Evidence search</b><ul style="margin:4px 0 0 18px">${rows}</ul><div class="sub" style="margin-top:4px">${n ? `${n} suggestion${n > 1 ? "s" : ""} await your review in the case. Suggestions are not findings.` : "No suggestions found. That does not show the claim is true or false."}</div></div>`;
}
export async function render(el) {
  if (!App.can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role can read cases but cannot start new ones.</div></div>`; return; }
  crumbs(`<b>Verify information</b>${App.training ? " · training records" : ""}`);
  el.innerHTML = `<div class="pagehead"><div><h1>Verify information</h1><p>Paste what you want to check. AIVS creates a case, keeps the original exactly as received, and splits it into separate claims for you to assess.</p></div></div>
    <div class="split"><div class="stack"><div class="card"><div class="bd">
      <label class="f" for="vi" style="margin-top:0">Claim, article text or link <span class="req">*</span></label>
      <textarea id="vi" rows="8" maxlength="20000" placeholder="Paste a post, a message, part of an article, or a single link such as https://example.org/news/story"></textarea>
      <div class="hint" id="vhint">For a link, AIVS retrieves the public page from its server, stores an unchanged copy with its fingerprint, and reads its title and publication date when the page states one.</div>
      <div class="grid g2"><div><label class="f" for="vt">Title (optional)</label><input type="text" id="vt" maxlength="200" placeholder="AIVS suggests one if left empty"></div>
        <div><label class="f" for="vp">Priority</label><select id="vp"><option value="routine">Routine</option><option value="priority">Priority</option><option value="urgent">Urgent</option></select></div></div>
      ${searchOpt()}
      ${App.training ? `<div class="callout train" style="margin-top:12px"><div>You are viewing Training records: this becomes a training case (TR-…), kept apart from real cases.</div></div>` : ""}
      <div id="verr" class="callout bad" style="margin-top:12px" hidden></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="vgo">Analyze</button><span id="vprog" class="small muted" aria-live="polite"></span></div>
      <details style="margin-top:14px"><summary class="small sub">Try a practice text (invented examples)</summary><div class="row" style="margin-top:8px">${SAMPLES.map(([l], i) => `<button class="btn sm ghost" data-sample="${i}">${esc(l)}</button>`).join("")}</div></details>
    </div></div></div>
    <div class="stack"><div class="card"><div class="hd"><h3>What happens</h3></div><div class="bd small">
      <ol style="margin:0 0 0 18px;line-height:1.7"><li>A case is created and the content is preserved as received.</li><li>Links: the page is retrieved once and archived with its SHA-256 fingerprint. Private or local network addresses are refused.</li>
        <li>The text is split into separate claims. Opinions, predictions, satire and questions are flagged, because they cannot be shown true or false.</li><li>Each checkable claim is searched against the knowledge base, earlier cases and, if configured, fact-check and web search services. Results come back as suggestions with links.</li><li>You review suggestions, assess each claim with evidence, and send the conclusion to a reviewer.</li></ol>
      <div class="callout info" style="margin-top:10px"><div>AIVS does not decide what is true. Automated steps produce suggestions and leads. Each conclusion is made by an analyst and approved by a second person.</div></div></div></div></div></div>
    <div id="vres" style="margin-top:14px"></div>`;
  const input = $("#vi"), err = $("#verr");
  const isUrl = () => /^https?:\/\/\S+$/i.test(input.value.trim());
  input.oninput = () => { $("#vhint").innerHTML = isUrl() ? "<b>Link detected.</b> AIVS will retrieve the public page, archive it and extract its text." : "For a link, AIVS retrieves the public page from its server, stores an unchanged copy with its fingerprint, and reads its title and publication date when the page states one."; };
  $$("[data-sample]").forEach(b => b.onclick = () => { input.value = SAMPLES[+b.dataset.sample][1]; $("#vt").value = SAMPLES[+b.dataset.sample][0]; input.dispatchEvent(new Event("input")); input.focus(); });
  $("#vgo").onclick = async () => {
    const v = input.value.trim();
    if (!v) { err.hidden = false; err.textContent = "Paste a claim, some text or a link first."; input.focus(); return; }
    if (/^\S+\.\S+\/?\S*$/.test(v) && !/^https?:\/\//i.test(v) && !/\s/.test(v)) { err.hidden = false; err.textContent = "That looks like a web address. Add https:// at the start so AIVS can retrieve it."; return; }
    err.hidden = true; const b = $("#vgo"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Working…';
    const stages = isUrl() ? ["Retrieving the page…", "Archiving a copy…", "Splitting into claims…", "Searching for evidence…"] : ["Creating the case…", "Splitting into claims…", "Searching for evidence…"]; let si = 0;
    $("#vprog").textContent = stages[0]; const t = setInterval(() => { si = Math.min(si + 1, stages.length - 1); $("#vprog").textContent = stages[si]; }, 1500);
    try {
      const r = await api.post("/api/verify", { input: v, title: $("#vt").value.trim() || undefined, priority: $("#vp").value, is_training: App.training, search: !!$("#vs")?.checked });
      refreshNavCounts();
      $("#vres").innerHTML = `<div class="card"><div class="hd"><h3>Case ${esc(r.id)} created</h3><span class="chip sup right">${r.claims.length} claim${r.claims.length === 1 ? "" : "s"} found</span></div><div class="bd">
        ${r.source ? `<div class="small"><b>${esc(r.source.title || r.source.final_url)}</b> · ${esc(r.source.site || "")}<div class="sub">${r.source.published ? `Published ${fmtDT(r.source.published)} according to ${esc(r.source.published_basis)}` : "The page states no machine-readable publication date. Establish it another way."} · archived copy SHA-256 ${esc(r.source.sha256.slice(0, 16))}…</div></div>` : ""}
        ${r.truncated ? `<div class="callout warn" style="margin-top:8px"><div>The page was long; only the first 12,000 characters were used as the text to check. The full page is in the archived copy.</div></div>` : ""}
        <ol class="claimlist">${r.claims.map(c => `<li><span>${esc(c.text)}</span> <span class="chip ${TYPE[c.claim_type]?.[1] || "grey"}">${TYPE[c.claim_type]?.[0] || esc(c.kind)}</span>${c.suggested_assessment ? ` <span class="chip info" title="${esc(c.suggested_basis || "")}">suggestion: ${esc(VLABEL[c.suggested_assessment])}</span>` : ""}${(r.evidence || []).filter(e => e.claim_id === c.id && e.source_url).slice(0, 3).map(e => `<div class="cite small"><a href="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(e.source_title || e.source_url)}</a> <span class="sub">${esc(e.source_publisher || "")}${e.rating ? ` · rated “${esc(e.rating)}”` : ""}</span></div>`).join("")}</li>`).join("") || `<li class="muted">No separate claims were found. Open the case and add them yourself.</li>`}</ol>
        ${searchSummary(r)}
        <div class="row" style="margin-top:12px"><a class="btn primary" href="#/case/${esc(r.id)}/claims">Open the case</a><a class="btn" href="#/case/${esc(r.id)}/media">Add images or video</a><button class="btn ghost" id="vagain">Verify something else</button></div></div></div>`;
      $("#vagain").onclick = () => { input.value = ""; $("#vt").value = ""; $("#vres").innerHTML = ""; input.focus(); };
      $("#vres").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    finally { clearInterval(t); $("#vprog").textContent = ""; b.disabled = false; b.textContent = "Analyze"; }
  };
}
