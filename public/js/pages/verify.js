// Verify Information: one box for a claim, article text or a link. Creates a case, archives the page
// (for links) and splits the content into claims, then hands over to the case workspace.
import { api } from "../api.js";
import { App, crumbs, refreshNavCounts } from "../app.js";
import { $, $$, esc, errMsg, fmtDT, kb, toLocalInput, fromLocalInput } from "../ui.js";
import { recognise } from "../lib/ocr.js";
import { parseSourceLink, parsePostScreenshot } from "/shared/text.js";

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
const MODES = `<div class="seg" role="tablist" aria-label="What are you checking?" style="margin-bottom:14px"><button type="button" role="tab" data-go="#/verify">Claim, text or link</button><button type="button" role="tab" data-go="#/verify/post">Social media post</button></div>`;
const SOCIAL = ["X (Twitter)", "Facebook", "Instagram", "TikTok", "YouTube", "Telegram", "Threads", "LinkedIn", "WhatsApp", "Reddit"];
const isSocial = v => { const L = /^https?:\/\/\S+$/i.test(v) ? parseSourceLink(v) : null; return L && SOCIAL.includes(L.platform) ? L : null; };
function modes(el, which) {
  $$("[data-go]", el).forEach(b => { const on = b.dataset.go === (which === "post" ? "#/verify/post" : "#/verify"); b.classList.toggle("on", on); b.setAttribute("aria-selected", on); b.onclick = () => { if (!on) location.hash = b.dataset.go; }; });
}
export async function render(el, params = []) {
  if (!App.can("case.create")) { el.innerHTML = `<div class="callout warn"><div>Your role can read cases but cannot start new ones.</div></div>`; return; }
  if (params[0] === "post") return renderPost(el);
  crumbs(`<b>Verify information</b>${App.training ? " · training records" : ""}`);
  el.innerHTML = `<div class="pagehead"><div><h1>Verify information</h1><p>Paste what you want to check. AIVS creates a case, keeps the original exactly as received, and splits it into separate claims for you to assess.</p></div></div>
    ${MODES}<div class="split"><div class="stack"><div class="card"><div class="bd">
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
  modes(el, "text");
  const input = $("#vi"), err = $("#verr");
  const isUrl = () => /^https?:\/\/\S+$/i.test(input.value.trim());
  input.oninput = () => { const L = isSocial(input.value.trim()); $("#vhint").innerHTML = L ? `<b>This is a ${esc(L.platform)} link.</b> Social platforms do not show posts to page retrieval. <a href="#/verify/post" id="toPost">Check it as a social media post</a> instead.` : isUrl() ? "<b>Link detected.</b> AIVS will retrieve the public page, archive it and extract its text. PDF links are read too." : "For a link, AIVS retrieves the public page from its server, stores an unchanged copy with its fingerprint, and reads its title and publication date when the page states one."; const tp = $("#toPost"); if (tp) tp.onclick = e => { e.preventDefault(); pendingLink = input.value.trim(); location.hash = "#/verify/post"; }; };
  $$("[data-sample]").forEach(b => b.onclick = () => { input.value = SAMPLES[+b.dataset.sample][1]; $("#vt").value = SAMPLES[+b.dataset.sample][0]; input.dispatchEvent(new Event("input")); input.focus(); });
  $("#vgo").onclick = async () => {
    const v = input.value.trim();
    if (!v) { err.hidden = false; err.textContent = "Paste a claim, some text or a link first."; input.focus(); return; }
    if (/^\S+\.\S+\/?\S*$/.test(v) && !/^https?:\/\//i.test(v) && !/\s/.test(v)) { err.hidden = false; err.textContent = "That looks like a web address. Add https:// at the start so AIVS can retrieve it."; return; }
    if (isSocial(v)) { pendingLink = v; location.hash = "#/verify/post"; return; }
    err.hidden = true; const b = $("#vgo"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Working…';
    const stages = isUrl() ? ["Retrieving the page…", "Archiving a copy…", "Splitting into claims…", "Searching for evidence…"] : ["Creating the case…", "Splitting into claims…", "Searching for evidence…"]; let si = 0;
    $("#vprog").textContent = stages[0]; const t = setInterval(() => { si = Math.min(si + 1, stages.length - 1); $("#vprog").textContent = stages[si]; }, 1500);
    try {
      const r = await api.post("/api/verify", { input: v, title: $("#vt").value.trim() || undefined, priority: $("#vp").value, is_training: App.training, search: !!$("#vs")?.checked });
      refreshNavCounts();
      $("#vres").innerHTML = resultCard(r, r.source ? `<div class="small"><b>${esc(r.source.title || r.source.final_url)}</b> · ${esc(r.source.site || "")}<div class="sub">${r.source.published ? `Published ${fmtDT(r.source.published)} according to ${esc(r.source.published_basis)}` : "The page states no machine-readable publication date. Establish it another way."} · archived copy SHA-256 ${esc(r.source.sha256.slice(0, 16))}…</div></div>` : "", r.truncated ? `<div class="callout warn" style="margin-top:8px"><div>The page was long; only the first 12,000 characters were used as the text to check. The full page is in the archived copy.</div></div>` : "");
      $("#vagain").onclick = () => { input.value = ""; $("#vt").value = ""; $("#vres").innerHTML = ""; input.focus(); };
      $("#vres").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    finally { clearInterval(t); $("#vprog").textContent = ""; b.disabled = false; b.textContent = "Analyze"; }
  };
}

// ---------------------------------------------------------------- shared result card
let pendingLink = "";   // a social link pasted into the text box, carried over to the post form
function resultCard(r, top = "", extra = "") {
  return `<div class="card" id="vcard"><div class="hd"><h3>Case ${esc(r.id)} created</h3><span class="chip sup right">${r.claims.length} claim${r.claims.length === 1 ? "" : "s"} found</span></div><div class="bd">
    ${top}${extra}
    <ol class="claimlist">${r.claims.map(c => `<li><span>${esc(c.text)}</span> <span class="chip ${TYPE[c.claim_type]?.[1] || "grey"}">${TYPE[c.claim_type]?.[0] || esc(c.kind)}</span>${c.suggested_assessment ? ` <span class="chip info" title="${esc(c.suggested_basis || "")}">suggestion: ${esc(VLABEL[c.suggested_assessment])}</span>` : ""}${(r.evidence || []).filter(e => e.claim_id === c.id && e.source_url).slice(0, 3).map(e => `<div class="cite small"><a href="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(e.source_title || e.source_url)}</a> <span class="sub">${esc(e.source_publisher || "")}${e.rating ? ` · rated “${esc(e.rating)}”` : ""}</span></div>`).join("")}</li>`).join("") || `<li class="muted">No separate claims were found. Open the case and add them yourself.</li>`}</ol>
    ${searchSummary(r)}
    <div class="row" style="margin-top:12px"><a class="btn primary" href="#/case/${esc(r.id)}${App.guided() ? "" : "/claims"}">${App.guided() ? "Continue: Review findings" : "Open the case"}</a><a class="btn" href="#/case/${esc(r.id)}/media">Add images or video</a><button class="btn ghost" id="vagain">Verify something else</button></div></div></div>`;
}

// ---------------------------------------------------------------- Social media post
const PLATFORMS = ["X (Twitter)", "Facebook", "Instagram", "TikTok", "YouTube", "Telegram", "WhatsApp", "Threads", "LinkedIn", "Reddit", "Other"];
function serviceFor(platform) { return (App.meta.social || []).find(s => s.platforms.includes(platform)) || null; }
function availability(L) {
  if (!L) return "";
  const s = serviceFor(L.platform);
  if (!s) return `<span class="chip grey">No public lookup for ${esc(L.platform)}</span> <span class="sub">Paste the text and add a screenshot.</span>`;
  if (!s.configured) return `<span class="chip grey">Not configured</span> <span class="sub">${esc(s.label)} needs ${esc(s.needs)}. Paste the text and add a screenshot meanwhile.</span>`;
  return `<span class="chip sup">Lookup available</span> <span class="sub">${esc(s.label)}: ${esc(s.gives)}.</span>`;
}
function ioContextCard(x, post) {
  if (!x) return "";
  if (!x.datasets_searched) return `<div class="panel small" style="margin-top:10px"><b>Account and message in your post datasets</b><div class="sub" style="margin-top:4px">No post datasets have been imported into the <a href="#/monitor">IO monitor</a>, so there is nothing to compare this post with. AIVS does not collect posts from platforms.</div></div>`;
  const acc = post.account ? esc(post.account) : "this account";
  return `<div class="panel small" style="margin-top:10px"><b>Account and message in your post datasets</b> <span class="sub">(${x.datasets_searched} dataset${x.datasets_searched > 1 ? "s" : ""} imported into the IO monitor)</span>
    <ul style="margin:6px 0 0 18px">
      <li>${x.account ? (x.account_posts ? `<b>${acc}</b> has ${x.account_posts} post${x.account_posts > 1 ? "s" : ""} in ${x.account_datasets.map(d => `<a href="#/monitor/${d.id}/accounts">${esc(d.name)}</a> (${d.n}, ${fmtDT(d.first)} to ${fmtDT(d.last)})`).join(", ")}.` : `<b>${acc}</b> does not appear in the imported datasets.`) : "No account was recorded, so accounts were not compared."}</li>
      <li>${x.similar.length ? `The same or nearly the same message appears <b>${x.similar.length}${x.similar.length === 20 ? "+" : ""} time${x.similar.length > 1 ? "s" : ""}</b> from <b>${x.similar_accounts} account${x.similar_accounts > 1 ? "s" : ""}</b>. Earliest: ${esc(x.similar[0].account)} at ${fmtDT(x.similar[0].posted_at)} in <a href="#/monitor/${x.similar[0].dataset_id}/messages">${esc(x.similar[0].dataset)}</a>.` : "No near-identical message was found in the imported datasets."}</li></ul>
    <div class="sub" style="margin-top:4px">Signals to investigate, not proof. Repeated wording can be organic sharing; absence here says nothing about the rest of the platform.</div></div>`;
}

async function renderPost(el) {
  crumbs(`<a href="#/verify">Verify information</a> / <b>Social media post</b>${App.training ? " · training records" : ""}`);
  const ocrOn = (App.meta.ocr || []).length > 0, files = [];   // { file, ocr: {text, confidence, lang} | null, state }
  el.innerHTML = `<div class="pagehead"><div><h1>Check a social media post</h1><p>Record one public post with its link, its words and screenshots. AIVS keeps everything as received, splits the words into claims, and compares the account and message with your imported post datasets.</p></div></div>
    ${MODES}<div class="split"><div class="stack"><div class="card"><div class="bd">
      <label class="f" for="pu" style="margin-top:0">Link to the post</label>
      <div class="row" style="flex-wrap:nowrap"><input type="url" id="pu" maxlength="2000" placeholder="https://x.com/account/status/1234567890" style="flex:1"><button class="btn" id="plook" type="button">Look up</button></div>
      <div class="hint" id="pav">Optional. Paste the link from the platform's Share or Copy link button.</div>
      <div id="pst" aria-live="polite"></div>
      <label class="f" for="ptx">Words of the post <span class="req">*</span></label>
      <textarea id="ptx" rows="6" maxlength="20000" placeholder="Filled in by Look up or by reading a screenshot, or paste the text yourself"></textarea>
      <div class="hint" id="ptxsrc">Check the words against the original. AIVS records where they came from.</div>
      <div class="grid g2"><div><label class="f" for="pa">Account</label><input type="text" id="pa" maxlength="200" placeholder="@handle or page name"></div>
        <div><label class="f" for="pp">Platform</label><select id="pp"><option value="">Choose…</option>${PLATFORMS.map(p => `<option>${esc(p)}</option>`).join("")}</select></div></div>
      <div class="grid g2"><div><label class="f" for="pt">Posted at</label><input type="datetime-local" id="pt"></div>
        <div><label class="f" for="ptb">How the time is known</label><input type="text" id="ptb" maxlength="300" placeholder="for example: shown on the post"></div></div>
      <label class="f">Screenshots, images or video of the post</label>
      <div class="dropzone" id="pdz" tabindex="0" role="button" aria-label="Add screenshots, images or video"><b>Drop files here</b><div class="small muted">or paste a screenshot (Ctrl+V), or <u>choose files</u> · up to 10 files, ${App.meta.maxUploadMb} MB each${ocrOn ? " · screenshots are read in this browser (English and Kiswahili)" : ""}</div><input type="file" id="pfi" multiple accept="image/*,video/*" hidden></div>
      <ul class="uplist" id="pul"></ul>
      <div class="grid g2"><div><label class="f" for="pti">Title (optional)</label><input type="text" id="pti" maxlength="200" placeholder="AIVS suggests one if left empty"></div>
        <div><label class="f" for="ppr">Priority</label><select id="ppr"><option value="routine">Routine</option><option value="priority">Priority</option><option value="urgent">Urgent</option></select></div></div>
      ${searchOpt()}
      ${App.training ? `<div class="callout train" style="margin-top:12px"><div>You are viewing Training records: this becomes a training case (TR-…), kept apart from real cases.</div></div>` : ""}
      <div id="perr" class="callout bad" style="margin-top:12px" hidden></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="pgo">Analyze post</button><span id="pprog" class="small muted" aria-live="polite"></span></div>
    </div></div></div>
    <div class="stack"><div class="card"><div class="hd"><h3>What AIVS can read</h3></div><div class="bd small">
      <ul style="margin:0 0 0 18px;line-height:1.7">${(App.meta.social || []).map(s => `<li><b>${esc(s.label)}</b>: ${s.configured ? `${esc(s.gives)}.` : `<span class="chip grey">not configured</span> needs ${esc(s.needs)}.`}</li>`).join("")}
        <li><b>WhatsApp, Threads, LinkedIn, Reddit</b>: no public lookup. Paste the text and add a screenshot.</li></ul>
      <div class="callout info" style="margin-top:10px"><div>Lookups use each platform's public embed service, the same one websites use to show a post. AIVS does not log in, scrape or collect other posts. Video and audio are not transcribed.</div></div>
      <div class="callout warn" style="margin-top:10px"><div>A post's account, time and wording show what was published, not whether it is true. Each claim still needs evidence and a reviewer.</div></div></div></div></div></div>
    <div id="vres" style="margin-top:14px"></div>`;
  modes(el, "post");
  const pu = $("#pu"), st = $("#pst"), err = $("#perr"), ptx = $("#ptx");
  let textSrc = "typed", looked = null;
  const setSrc = (src, label) => { textSrc = src; $("#ptxsrc").innerHTML = label; };
  const fill = (id, v, force) => { const x = $(id); if (v && (force || !x.value.trim() || x.dataset.auto === "1")) { x.value = v; x.dataset.auto = "1"; x.classList.add("autofilled"); } };
  ["#pa", "#pp", "#pt", "#ptb"].forEach(id => $(id).addEventListener("input", () => { delete $(id).dataset.auto; $(id).classList.remove("autofilled"); }));
  ptx.addEventListener("input", () => { ptx.classList.remove("autofilled"); delete ptx.dataset.auto; if (textSrc !== "typed" && !textSrc.endsWith("-edited")) setSrc(textSrc + "-edited", `${esc($("#ptxsrc").textContent)} (edited by you)`); });
  let lookedFor = null;
  const onLink = () => {
    const v = pu.value.trim(), L = /^https?:\/\/\S+$/i.test(v) ? parseSourceLink(v) : null;
    if (lookedFor !== null && lookedFor !== v) {   // a different post: drop what the previous lookup filled in
      lookedFor = null; looked = null; st.innerHTML = "";
      ["#ptx", "#pa", "#pp", "#pt", "#ptb"].forEach(id => { const x = $(id); if (x.dataset.auto === "1" && (id !== "#ptx" || textSrc === "embed")) { x.value = ""; delete x.dataset.auto; x.classList.remove("autofilled"); } });
      if (textSrc === "embed") setSrc("typed", "Check the words against the original. AIVS records where they came from.");
    }
    $("#pav").innerHTML = !v ? "Optional. Paste the link from the platform's Share or Copy link button." : !L ? "The link should start with https://" : availability(L) + (L.post_id && L.published_at ? `<div class="sub" style="margin-top:4px">Posting time from the post ID: ${fmtDT(L.published_at)}.</div>` : "");
    if (L && SOCIAL.includes(L.platform)) { fill("#pp", L.platform); fill("#pa", L.account); if (L.published_at) { fill("#pt", toLocalInput(L.published_at)); fill("#ptb", L.published_basis); } }
    const s = L && serviceFor(L.platform); $("#plook").disabled = !(s && s.configured);
  };
  pu.oninput = onLink;
  $("#plook").onclick = async () => {
    const v = pu.value.trim(); if (!v) return;
    const b = $("#plook"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Looking up…';
    st.innerHTML = `<div class="callout info" style="margin-top:8px"><div><span class="spin"></span> Asking the platform's public embed service…</div></div>`;
    try {
      const r = await api.post("/api/social/lookup", { url: v }); looked = r; lookedFor = v;
      if (!r.social) { st.innerHTML = `<div class="callout warn" style="margin-top:8px"><div>This is not a social media post link${r.platform ? ` (${esc(r.platform)})` : ""}. For web pages and articles, use <a href="#/verify">Claim, text or link</a>.</div></div>`; return; }
      fill("#pp", r.platform, true); fill("#pa", r.account, true);
      if (r.posted_at) { fill("#pt", toLocalInput(r.posted_at), true); fill("#ptb", r.posted_basis, true); }
      if (r.status === "ok") {
        if (ptx.value.trim() && ptx.value.trim() !== r.text && textSrc !== "embed") { st.innerHTML = `<div class="callout info" style="margin-top:8px"><div><b>Retrieved from ${esc(r.text_source)}.</b> The words box already has text, so it was not replaced. <button class="btn sm" id="useEmbed">Use the retrieved words</button><div class="sub" style="margin-top:4px">${esc(r.text)}</div></div></div>`; $("#useEmbed").onclick = () => { ptx.value = r.text; ptx.dataset.auto = "1"; ptx.classList.add("autofilled"); setSrc("embed", `From ${esc(r.text_source)}.`); }; }
        else { ptx.value = r.text; ptx.dataset.auto = "1"; ptx.classList.add("autofilled"); setSrc("embed", `From ${esc(r.text_source)}. Check it against the post.`);
          st.innerHTML = `<div class="callout info" style="margin-top:8px"><div><b>Post found${r.author_name ? `: ${esc(r.author_name)}` : ""}.</b> Words, account${r.posted_at ? " and time" : ""} were filled in below in blue. The platform's answer will be archived with the case.</div></div>`; }
      } else st.innerHTML = `<div class="callout ${r.status === "not_configured" ? "" : "warn"}" style="margin-top:8px"><div><b>${r.status === "not_configured" ? "Lookup not configured." : r.status === "no_text" ? "Post found, but without its words." : "The post could not be retrieved."}</b> ${esc(r.message || "")}${r.account || r.posted_at ? " What the link itself shows (account, ID time) was filled in." : ""}</div></div>`;
    } catch (e) { st.innerHTML = `<div class="callout bad" style="margin-top:8px"><div>${esc(errMsg(e))}</div></div>`; }
    finally { b.textContent = "Look up"; onLink(); }
  };
  // screenshots: read the text in this browser and offer it for the empty fields
  const list = () => {
    $("#pul").innerHTML = files.map((f, i) => `<li><span class="chip ${f.file.type.startsWith("video/") ? "info" : "teal"}">${f.file.type.startsWith("video/") ? "video" : "image"}</span><div class="small"><b>${esc(f.file.name)}</b> · ${kb(f.file.size)}<div class="sub" id="pfs${i}">${esc(f.state || "")}</div></div>
      <div class="row">${f.file.type.startsWith("image/") && ocrOn ? `<button class="btn sm" data-ocr="${i}" ${f.busy ? "disabled" : ""}>${f.ocr ? "Read again" : "Read text"}</button>` : ""}<button class="btn sm ghost" data-rm="${i}" aria-label="Remove ${esc(f.file.name)}">Remove</button></div></li>`).join("");
    $$("[data-rm]").forEach(b => b.onclick = () => { files.splice(+b.dataset.rm, 1); list(); });
    $$("[data-ocr]").forEach(b => b.onclick = () => readShot(+b.dataset.ocr, true));
  };
  async function readShot(i, force) {
    const f = files[i]; if (!f || f.busy) return; f.busy = true; f.state = "Reading text… 0%"; list();
    const langs = App.meta.ocr || [], lang = langs.length > 1 ? "eng+swa" : langs[0].code;
    try {
      const r = await recognise(f.file, lang, p => { const x = $(`#pfs${files.indexOf(f)}`); if (x) x.textContent = `Reading text… ${Math.round(p * 100)}%`; });
      f.ocr = { text: r.text, confidence: Math.round(r.confidence), lang };
      const g = parsePostScreenshot(r.text, { fileTime: f.file.lastModified });
      const used = [];
      if (g.text && (!ptx.value.trim() || force && textSrc.startsWith("ocr"))) { ptx.value = g.text; ptx.classList.add("autofilled"); setSrc("ocr", `Read from ${esc(f.file.name)} with OCR (${f.ocr.confidence}% confidence). Names, numbers and small print are often misread: correct it against the image.`); used.push("words"); }
      if (g.account && !$("#pa").value.trim()) { fill("#pa", g.account); used.push("account"); }
      if (g.platform && !$("#pp").value) { fill("#pp", g.platform); used.push("platform"); }
      if (g.posted_at && !$("#pt").value) { fill("#pt", toLocalInput(g.posted_at)); fill("#ptb", g.time_basis); used.push("time"); }
      f.state = r.text ? `Text read (${f.ocr.confidence}% confidence)${used.length ? `; filled in: ${used.join(", ")}` : "; the fields already had values, so nothing was replaced"}. The text is saved with the image.` : "No text found in this image.";
    } catch (e) { f.state = `Could not read the text: ${errMsg(e)}`; }
    finally { f.busy = false; list(); }
  }
  const add = fs => {
    for (const file of fs) {
      if (files.length >= 10) { err.hidden = false; err.textContent = "Up to 10 files per post. Add more later in the case."; break; }
      if (!/^(image|video)\//.test(file.type)) { err.hidden = false; err.textContent = `${file.name}: only images and video can be added here. Add documents in the case.`; continue; }
      if (file.size > App.meta.maxUploadMb * 1048576) { err.hidden = false; err.textContent = `${file.name} is larger than ${App.meta.maxUploadMb} MB.`; continue; }
      files.push({ file, ocr: null, state: file.type.startsWith("image/") ? (ocrOn ? "" : "Text reading (OCR) is not installed on this server.") : "Stored unchanged; frames can be extracted in the case." });
    }
    list();
    files.forEach((f, i) => { if (ocrOn && f.file.type.startsWith("image/") && !f.ocr && !f.busy && !f.state) readShot(i, false); });
  };
  const dz = $("#pdz"), fi = $("#pfi");
  dz.onclick = () => fi.click(); dz.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); }; dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); add([...e.dataTransfer.files]); };
  fi.onchange = () => { add([...fi.files]); fi.value = ""; };
  const onPaste = e => { if (!document.body.contains(dz)) return document.removeEventListener("paste", onPaste); const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); add(fs.map(f => f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}.png`, { type: f.type }))); } };
  document.addEventListener("paste", onPaste);
  if (pendingLink) { pu.value = pendingLink; pendingLink = ""; onLink(); if (!$("#plook").disabled) $("#plook").click(); } else onLink();

  $("#pgo").onclick = async () => {
    err.hidden = true;
    if (files.some(f => f.busy)) { err.hidden = false; err.textContent = "A screenshot is still being read. Wait a moment, then try again."; return; }
    const url = pu.value.trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) { err.hidden = false; err.textContent = "The post's link should start with https://"; pu.focus(); return; }
    if (!ptx.value.trim() && !files.some(f => f.ocr?.text)) { err.hidden = false; err.textContent = "Add the words of the post: paste them, use Look up, or add a screenshot and read its text."; ptx.focus(); return; }
    const fd = new FormData();
    const put = (k, v) => { if (v != null && v !== "") fd.append(k, v); };
    put("url", url); put("text", ptx.value.trim()); put("account", $("#pa").value.trim()); put("platform", $("#pp").value);
    const pt = fromLocalInput($("#pt").value); put("posted_at", pt); if (pt) put("posted_basis", $("#ptb").value.trim() || "entered by the analyst");
    put("text_source", textSrc); put("title", $("#pti").value.trim()); put("priority", $("#ppr").value); put("is_training", App.training ? "true" : "false"); put("search", $("#vs")?.checked ? "true" : "local");
    files.forEach((f, i) => { fd.append("files", f.file, f.file.name); if (f.ocr) fd.append(`ocr_${i}`, JSON.stringify(f.ocr)); });
    const b = $("#pgo"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Working…';
    const stages = [files.length ? "Uploading files…" : "Creating the case…", "Archiving what the platform returned…", "Splitting into claims…", "Searching for evidence…", "Comparing with your post datasets…"]; let si = 0;
    $("#pprog").textContent = stages[0]; const t = setInterval(() => { si = Math.min(si + 1, stages.length - 1); $("#pprog").textContent = stages[si]; }, 1500);
    try {
      const r = await api.upload("/api/verify/post", fd, p => { if (si === 0) $("#pprog").textContent = `Uploading files… ${Math.round(p * 100)}%`; });
      refreshNavCounts(); document.removeEventListener("paste", onPaste);
      const P = r.post || {};
      const top = `<div class="small"><b>${esc(P.platform || "Post")}</b>${P.account ? ` · ${esc(P.account)}` : ""}${P.url ? ` · <a href="${esc(P.url)}" target="_blank" rel="noopener noreferrer nofollow">open the post</a>` : ""}
        <div class="sub">${P.posted_at ? `Posted ${fmtDT(P.posted_at)} (${esc(P.posted_basis || "")})` : "No posting time recorded. Establish it another way."} · words: ${esc(r.text_basis)}${P.archived_sha256 ? ` · platform's answer archived, SHA-256 ${esc(P.archived_sha256.slice(0, 16))}…` : ""}</div></div>
        ${P.lookup_status && P.lookup_status !== "ok" && P.lookup_message ? `<div class="callout warn" style="margin-top:8px"><div>${esc(P.lookup_message)}</div></div>` : ""}
        ${r.media?.length ? `<div class="small" style="margin-top:8px">${r.media.length} file${r.media.length > 1 ? "s" : ""} stored unchanged with SHA-256: ${r.media.map(m => esc(m.name)).join(", ")}. Image matching and metadata are in the case's Media tab.</div>` : ""}
        ${r.media_errors?.length ? `<div class="callout bad" style="margin-top:8px"><div>Not stored: ${r.media_errors.map(esc).join("; ")}</div></div>` : ""}`;
      $("#vres").innerHTML = resultCard(r, top, ioContextCard(r.io_context, P));
      $("#vagain").onclick = () => render(el, ["post"]);
      $("#vres").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    finally { clearInterval(t); $("#pprog").textContent = ""; b.disabled = false; b.textContent = "Analyze post"; }
  };
}
