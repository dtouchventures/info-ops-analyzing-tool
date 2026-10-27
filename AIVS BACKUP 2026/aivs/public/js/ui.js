// Small UI toolkit: escaping, formatting, toasts, modals, status chips, empty states.
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
export const fmtDT = iso => { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
export const fmtD = iso => { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }); };
export const ago = iso => { const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return fmtD(iso); };
export const kb = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export const toLocalInput = iso => { if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return ""; return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const fromLocalInput = v => (v ? new Date(v).toISOString() : null);

export function toast(msg, kind = "") {
  const t = document.createElement("div"); t.className = `toast ${kind}`; t.textContent = msg;
  $("#toasts").appendChild(t); setTimeout(() => t.remove(), kind === "err" ? 7000 : 4000);
}
export const errMsg = e => e?.details?.length ? `${e.message} ${Array.isArray(e.details) ? e.details.join(" ") : ""}` : (e?.message || String(e));
export function fail(e) { console.warn(e); toast(errMsg(e), "err"); }

export const STATUS = { draft: "Draft", analysing: "Analysing", analysis_failed: "Analysis failed", analyst_review: "Under investigation", needs_evidence: "Needs additional evidence", awaiting_approval: "Awaiting review", approved: "Approved", rejected: "Rejected", archived: "Archived" };
export const CONCL = { supported: ["Supported", "sup"], contradicted: ["Contradicted", "con"], mixed: ["Mixed findings", "mix"], partially_supported: ["Partially supported", "mix"], misleading_context: ["Misleading context", "con"], insufficient: ["Insufficient evidence", "unr"], not_verifiable: ["Not verifiable", "grey"] };
export const ASSESS = { unassessed: ["Not assessed", "grey"], supported: ["Supported", "sup"], partially_supported: ["Partially supported", "mix"], contradicted: ["Contradicted", "con"], misleading_context: ["Misleading context", "con"], insufficient: ["Insufficient evidence", "unr"], not_verifiable: ["Not verifiable", "grey"] };
export const STRENGTH = { none: ["No evidence", "grey"], weak: ["Weak evidence", "unr"], moderate: ["Moderate evidence", "mix"], strong: ["Strong evidence", "sup"] };
export const KIND = { observation: ["Observed detail", "What can be seen directly in the media or a record."], source_claim: ["Source statement", "What a source, document or person says."], inference: ["Analyst inference", "Reasoning that connects facts; state it as such."], lead: ["Investigative lead", "Points to a check: archive similarity, metadata. Not proof on its own."] };
export const status = s => `<span class="status st-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
export const concl = c => c ? `<span class="chip ${CONCL[c]?.[1] || "grey"}">${esc(CONCL[c]?.[0] || c)}</span>` : "";
export const pri = p => `<span class="pri-${esc(p)}">${esc(p === "urgent" ? "Urgent" : p === "priority" ? "Priority" : "Routine")}</span>`;
export const empty = (title, text, action = "") => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;

// modal(title, bodyHtml, buttons:[{label, kind, value}], {wide}) -> Promise<{value, el}>
export function modal(title, body, buttons = [{ label: "Close", value: null }], { wide = false, onOpen } = {}) {
  return new Promise(resolve => {
    const bg = document.createElement("div"); bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="mt"><div class="mh"><h2 id="mt">${esc(title)}</h2><button class="btn ghost sm" data-x style="margin-left:auto" aria-label="Close">✕</button></div><div class="mb">${body}</div>
      <div class="mf">${buttons.map((b, i) => `<button class="btn ${b.kind || ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
    document.body.appendChild(bg);
    const prev = document.activeElement, close = value => { bg.remove(); document.removeEventListener("keydown", key); prev?.focus?.(); resolve({ value, el: bg }); };
    const key = e => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", key);
    bg.addEventListener("click", async e => {
      if (e.target === bg || e.target.closest("[data-x]")) return close(null);
      const b = e.target.closest("[data-i]"); if (!b) return;
      const def = buttons[+b.dataset.i];
      if (def.validate) { const err = await def.validate(bg); if (err) { const box = bg.querySelector(".merr") || bg.querySelector(".mb").appendChild(Object.assign(document.createElement("div"), { className: "callout bad merr" })); box.textContent = err; return; } }
      const v = typeof def.value === "function" ? def.value(bg) : def.value; bg.remove(); document.removeEventListener("keydown", key); prev?.focus?.(); resolve({ value: v, el: bg });
    });
    onOpen?.(bg); (bg.querySelector("input,textarea,select") || bg.querySelector("[data-i]"))?.focus();
  });
}
export const confirmBox = (title, text, label = "Confirm", kind = "primary") => modal(title, `<p>${esc(text)}</p>`, [{ label: "Cancel", value: false }, { label, kind, value: true }]).then(r => !!r.value);

// zoom viewer
export function viewer(src, caption) {
  const v = document.createElement("div"); v.className = "viewer"; v.setAttribute("role", "dialog"); v.setAttribute("aria-label", "Image viewer");
  v.innerHTML = `<div class="vh"><span class="small" style="min-width:0">${esc(caption || "")}</span><span style="margin-left:auto;display:flex;gap:6px"><button class="btn sm" data-z="-">−</button><span class="small num" data-zl style="min-width:48px;text-align:center;align-self:center">Fit</span><button class="btn sm" data-z="+">+</button><button class="btn sm" data-z="1">Fit</button><button class="btn sm primary" data-close>Close</button></span></div><div class="vb"><img class="fit" alt="${esc(caption || "")}"></div>`;
  document.body.appendChild(v);
  const img = v.querySelector("img"); img.src = src; let z = 1;
  const apply = () => { img.classList.toggle("fit", z === 1); img.style.width = z === 1 ? "" : `${img.naturalWidth * z}px`; v.querySelector("[data-zl]").textContent = z === 1 ? "Fit" : `${Math.round(z * 100)}%`; };
  const close = () => { v.remove(); document.removeEventListener("keydown", key); };
  const key = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", key);
  v.addEventListener("click", e => {
    const b = e.target.closest("[data-z]"); if (b) { z = b.dataset.z === "1" ? 1 : b.dataset.z === "+" ? (z === 1 ? 1.5 : Math.min(8, z * 1.5)) : (z <= 1.5 ? 1 : z / 1.5); apply(); }
    if (e.target.closest("[data-close]") || e.target === v.querySelector(".vb")) close();
  });
  v.querySelector("[data-close]").focus();
}
export const icon = name => {
  const P = { home: "M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6", verify: "M9 12l2 2 4-4M4 5l8-3 8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11z", search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5", monitor: "M3 17l5-6 4 4 4-7 5 9M3 21h18", chat: "M4 5h16v11H9l-5 4z", data: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3", upload: "M12 16V4M7 9l5-5 5 5M4 20h16", social: "M7 8a3 3 0 1 0 0 .1M17 5a3 3 0 1 0 0 .1M17 16a3 3 0 1 0 0 .1M9.5 9.5l5-3M9.5 10.5l5 4", dash: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z", cases: "M4 6h16M4 12h16M4 18h10", new: "M12 5v14M5 12h14", archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4", review: "M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", reports: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6", admin: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2" };
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name]}"/></svg>`;
};
