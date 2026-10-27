// Settings → AI models: each trained model with its data, method, measured scores (on held-out test data),
// confusion matrix, comparison with simpler methods, limitations, and a box to try it on any sentence.
import { api } from "../api.js";
import { crumbs } from "../app.js";
import { $, esc, fail } from "../ui.js";

const pct = x => `${(x * 100).toFixed(1)}%`;
export async function render(el) {
  crumbs(`<a href="#/settings">Settings</a> / <b>AI models</b>`);
  const r = await api.get("/api/ai/models");
  el.innerHTML = `<div class="pagehead"><div><h1>AI models</h1><p>What runs inside AIVS, what it was trained on, and how well it scored on data it never saw. ${esc(r.note)}</p></div></div>
    ${r.models.length ? r.models.map(card).join("") : `<div class="callout warn"><div>No trained model is installed: sentiment uses the word list. Run <code>npm run train:sentiment</code> to train one.</div></div>`}`;
  el.querySelectorAll("[data-try]").forEach(f => f.onsubmit = async e => {
    e.preventDefault(); const out = f.querySelector(".tryout"), text = f.querySelector("textarea").value;
    try {
      const p = await api.post("/api/ai/models/sentiment/try", { text });
      out.innerHTML = `<b>${esc(p.label)}</b> <span class="sub">(${esc(p.method)})</span>${p.probabilities ? ` · ${Object.entries(p.probabilities).map(([k, v]) => `${esc(k)} ${pct(v)}`).join(" · ")}` : ""}
        <div class="tiny sub">${esc(p.basis || "")}</div>${p.explanation?.length ? `<div class="tiny">Words that pushed towards “${esc(p.label)}”: ${p.explanation.map(t => `<code>${esc(t.term.replace(/^neg_/, "not "))}</code>`).join(" ")}</div>` : ""}`;
    } catch (err) { fail(err); }
  });
}

function card(m) {
  const t = m.test, B = m.baselines || {}, cm = t.confusion_matrix, max = Math.max(...cm.matrix.flat());
  return `<div class="card"><div class="hd"><h3>${esc(m.task === "sentiment" ? "Sentiment classifier" : m.task)}</h3><span class="chip ${m.loaded ? "sup" : "grey"}">${m.loaded ? "In use" : "Not loaded"}</span><span class="mono small right">${esc(m.id)}</span></div><div class="bd">
    <div class="grid g2">
      <div class="small">
        <p style="margin-top:0"><b>Method:</b> ${esc(m.method)}.</p>
        <p><b>Training data:</b> <a href="${esc(m.data.source)}" target="_blank" rel="noopener noreferrer">${esc(m.data.name)}</a>, ${esc(m.data.language)}. ${m.data.sizes.train.toLocaleString()} training, ${m.data.sizes.validation.toLocaleString()} validation and ${m.data.sizes.test.toLocaleString()} test examples (official splits). Downloaded ${esc(m.data.downloaded_at)}; each file's SHA-256 is recorded.</p>
        <p class="tiny sub">${esc(m.data.citation)}</p>
        <p><b>Settings chosen on the validation split:</b> ${Object.entries(m.hyperparameters).map(([k, v]) => `${esc(k.replace(/_/g, " "))} ${esc(v)}`).join(", ")}. Trained ${esc(m.trained_at.slice(0, 10))} in ${esc(m.training_seconds)} s.</p>
      </div>
      <div>
        <table class="t"><thead><tr><th>Test data (${t.n.toLocaleString()} examples)</th><th class="n">Accuracy</th><th class="n">Macro F1</th><th class="n">Macro recall</th></tr></thead><tbody>
          <tr><td><b>This model</b></td><td class="n"><b>${pct(t.accuracy)}</b></td><td class="n"><b>${pct(t.macro.f1)}</b></td><td class="n">${pct(t.macro.recall)}</td></tr>
          ${B.word_list ? `<tr><td>Word list used before</td><td class="n">${pct(B.word_list.accuracy)}</td><td class="n">${pct(B.word_list.macro.f1)}</td><td class="n">${pct(B.word_list.macro.recall)}</td></tr>` : ""}
          ${B.majority_class ? `<tr><td>Always the most common label</td><td class="n">${pct(B.majority_class.accuracy)}</td><td class="n">${pct(B.majority_class.macro.f1)}</td><td class="n">${pct(B.majority_class.macro.recall)}</td></tr>` : ""}</tbody></table>
        <table class="t" style="margin-top:10px"><thead><tr><th>Label</th><th class="n">Precision</th><th class="n">Recall</th><th class="n">F1</th><th class="n">Examples</th></tr></thead><tbody>
          ${t.per_class.map(c => `<tr><td>${esc(c.label)}</td><td class="n">${pct(c.precision)}</td><td class="n">${pct(c.recall)}</td><td class="n">${pct(c.f1)}</td><td class="n">${c.support.toLocaleString()}</td></tr>`).join("")}</tbody></table>
      </div>
    </div>
    <h4 style="margin:14px 0 6px">Confusion matrix (rows: true label; columns: predicted)</h4>
    <table class="t cm" style="max-width:520px"><thead><tr><th></th>${cm.labels.map(l => `<th class="n">${esc(l)}</th>`).join("")}</tr></thead><tbody>
      ${cm.matrix.map((row, i) => `<tr><th>${esc(cm.labels[i])}</th>${row.map((v, j) => `<td class="n" style="background:color-mix(in srgb, ${i === j ? "var(--sup)" : "var(--con)"} ${Math.round(8 + 50 * v / max)}%, transparent)">${v.toLocaleString()}</td>`).join("")}</tr>`).join("")}</tbody></table>
    <h4 style="margin:14px 0 6px">Limitations</h4><ul class="small">${m.data.limitations.map(l => `<li>${esc(l)}</li>`).join("")}${m.selection?.process_note ? `<li>${esc(m.selection.process_note)}</li>` : ""}</ul>
    <form data-try="${esc(m.id)}" class="tryform"><label class="f" for="try-${esc(m.id)}">Try it</label><textarea id="try-${esc(m.id)}" rows="2" maxlength="2000" placeholder="Type or paste a sentence, in English (Kiswahili goes to the word list)"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn sm primary">Classify</button></div><div class="tryout small" aria-live="polite" style="margin-top:6px"></div></form>
  </div></div>`;
}
