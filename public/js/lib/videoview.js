// Video verification results (1.35), shown on Verify Information and on the case's media card ("Reverse video search").
// Verified matches (compared by AIVS itself) and possible similarities are labelled differently; coverage and limits always shown.
import { esc } from "../ui.js";

const thumb = id => `/api/media/${encodeURIComponent(id)}/thumb`;
const day = d => (d ? String(d).slice(0, 10) : "date not known");
const link = (u, t) => /^https?:\/\//i.test(String(u || "")) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t || u)}</a>` : esc(t || u || "");
const KIND = { recycled: ["Possible recycled footage", "con"], possible_recycled: ["Possible similarity", "unr"], context: ["Possible misleading context", "con"], date: ["Date inconsistency", "unr"], location: ["Location inconsistency", "unr"],
  metadata_date: ["Metadata date", "grey"], metadata_location: ["Metadata location", "grey"], repeats_claim: ["Observed", "grey"] };
const icon = s => (s === "done" ? "✓" : s === "warning" ? "!" : s === "failed" ? "×" : s === "skipped" ? "–" : "");
export const stagesHtml = list => `<ol class="istages">${(list || []).map((s, i) => `<li class="${esc(s.status)}"><span class="dot">${icon(s.status)}</span><span>${i + 1}. ${esc(s.label || s.key)}${s.detail ? `<span class="tiny sub" style="display:block">${esc(s.detail)}</span>` : ""}</span></li>`).join("")}</ol>`;

export function videoResultHtml(v) {
  if (!v) return "";
  if (v.error) return `<div class="callout bad"><div>${esc(v.video?.name || "Video")}: verification did not finish (${esc(v.error)}).</div></div>`;
  const ok = v.internet_search;
  return `<div class="vres">
    <p class="small" style="margin:0 0 8px"><b>${esc(v.summary)}</b></p>
    <div class="callout ${ok ? "info" : "warn"}" style="margin-bottom:8px"><div class="small">${esc(v.coverage)}</div></div>
    <div class="frames">${(v.keyframes || []).map(k => `<figure><img src="${thumb(k.media_id)}" alt="Keyframe at ${esc(k.t)} s" loading="lazy"><figcaption class="num">${esc(k.t)} s · ${esc(k.origin || "")}${(v.matches || []).some(m => m.keyframe_t === k.t && m.verification === "verified") ? ' <span class="chip con">verified match</span>' : ""}</figcaption></figure>`).join("")}</div>
    ${v.findings?.length ? `<h4 style="margin:10px 0 4px">Findings</h4><ul class="small" style="margin:0 0 0 18px">${v.findings.map(f => `<li><span class="chip ${KIND[f.kind]?.[1] || "grey"}">${esc(KIND[f.kind]?.[0] || f.kind)}</span> ${esc(f.text)}</li>`).join("")}</ul>` : `<p class="small sub">No finding: nothing suggests recycled footage or inconsistent dates or places in what was checked.</p>`}
    <h4 style="margin:10px 0 4px">Matches, ranked by relevance</h4>
    ${v.matches?.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>#</th><th>Result</th><th>Source, date</th><th>Keyframe</th><th>How it was compared</th></tr></thead><tbody>${v.matches.map(m => `<tr>
      <td class="num">${m.rank}</td><td>${m.verification === "verified" ? '<span class="chip con">Verified match</span>' : '<span class="chip unr">Possible similarity</span>'}</td>
      <td>${m.url ? link(m.url, m.title || m.url) : esc(`${m.title || ""} (${m.source === "archive" ? "archive record" : "case"} ${m.ref || ""})`)}<div class="tiny sub">${esc(m.publisher || "")} · ${esc(day(m.date))}${m.days_before_claim != null ? ` · ${esc(m.days_before_claim)} days before the claim` : ""}${m.date_basis ? ` · ${esc(m.date_basis)}` : ""}${m.snapshot_sha256 ? " · page archived" : ""}</div></td>
      <td class="num">${esc(m.keyframe_t)} s</td><td class="tiny">${esc(m.method)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small sub">No earlier copy was found${ok ? " by the services used" : " in the local archive, earlier cases or earlier videos"}. This does not show that the footage is new or authentic.</p>`}
    <details class="small" style="margin-top:8px"><summary>Speech, on-screen text and file details</summary>
      <p><b>Speech</b> (machine transcript, not checked): ${v.transcript?.text ? esc(v.transcript.text) : esc(v.transcript?.skipped || v.transcript?.error || "not transcribed")}</p>
      <p><b>On-screen text</b> (OCR of keyframes; text in logos only when readable): ${v.onscreen_text?.length ? v.onscreen_text.map(o => `“${esc(o.text)}” <span class="tiny sub">(${esc(o.t)} s)</span>`).join("; ") : "none readable"}</p>
      <p><b>File</b>: ${esc(v.video?.name || "")} · ${v.probe?.duration_s ? `${esc(v.probe.duration_s.toFixed(1))} s · ` : ""}${v.probe?.video ? `${esc(v.probe.video.codec)} ${esc(v.probe.video.width)}×${esc(v.probe.video.height)} · ` : ""}SHA-256 <span class="mono tiny">${esc(v.video?.sha256 || "")}</span>${v.probe?.metadata?.creation_time ? ` · container creation time ${esc(v.probe.metadata.creation_time)} (metadata; can be wrong)` : ""}</p>
      ${v.errors?.length ? `<p><b>Problems</b>: ${esc(v.errors.join(" · "))}</p>` : ""}${v.notes?.length ? `<p class="sub">${esc(v.notes.join(" "))}</p>` : ""}
    </details>
    <p class="tiny sub" style="margin-top:6px">${esc((v.limits || []).join(" "))} Verified = AIVS compared the two pictures itself (perceptual hashes ≤ ${esc(v.thresholds?.verified?.score ?? 24)}/128 and embedding ≥ ${esc(v.thresholds?.verified?.cosine ?? 0.9)}); possible = similar but not confirmed.</p>
  </div>`;
}
