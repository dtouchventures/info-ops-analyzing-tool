// Settings: personal preferences, administration and service status.
import { App, crumbs } from "../app.js";
import { esc } from "../ui.js";

export async function render(el) {
  crumbs("<b>Settings</b>");
  const admin = App.can("users.manage") || App.can("settings.manage") || App.can("audit.read");
  el.innerHTML = `<div class="pagehead"><div><h1>Settings</h1><p>Your preferences, administration and the secondary tools.</p></div></div>
    <div class="grid g2">
      <div class="card"><div class="hd"><h3>You</h3></div><div class="bd small">
        <p style="margin-top:0"><b>${esc(App.me.display_name)}</b> · ${esc(App.meta.roles[App.me.role])}</p>
        <p><b>Interface:</b> ${App.guided() ? "Guided: one step at a time, secondary tools hidden." : "Advanced: every tab of a case and the secondary tools in the menu."} Switch with <b>Guided / Advanced</b> at the top of the page.</p>
        <div class="row"><button class="btn sm" id="setPw" type="button">Change password</button><a class="btn sm ghost" href="#/privacy">How AIVS handles data</a></div></div></div>
      <div class="card"><div class="hd"><h3>System</h3></div><div class="bd small">
        <p style="margin-top:0">The AI models in use with their measured scores, and which services are working on this installation.</p>
        <div class="row"><a class="btn sm" href="#/models">AI models</a><a class="btn sm" href="#/status">Service status</a>${admin ? `<a class="btn sm primary" href="#/admin">Administration</a>` : ""}</div>
        ${admin ? `<p class="tiny sub">Users and roles, AI connection, audit trail, storage checks and training data.</p>` : ""}</div></div>
    </div>`;
  el.querySelector("#setPw").onclick = () => document.getElementById("pwLink")?.click();
}
