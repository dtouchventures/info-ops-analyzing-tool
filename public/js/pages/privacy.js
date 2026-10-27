// Privacy notice: what this installation stores, who can see it, and what leaves the server.
import { App, crumbs } from "../app.js";

export async function render(el) {
  crumbs(`<b>Privacy</b>`);
  const ai = App.meta.ai;
  el.innerHTML = `<div class="pagehead"><div><h1>How AIVS handles data</h1><p>This describes this installation as it is configured now. The operator of the installation is responsible for it.</p></div></div>
  <div class="card"><div class="bd prose">
    <h3>What is stored</h3>
    <ul><li><b>Your account:</b> user name, display name, role, a scrypt hash of your password (never the password itself), and the time of your last sign-in. Your interface mode (guided or advanced).</li>
      <li><b>Sessions:</b> only a hash of the session token, with its expiry. The browser keeps the token in an HTTP-only, same-site cookie (also marked Secure when the installation is served over HTTPS, as it should be).</li>
      <li><b>Investigation material</b> that users enter or upload: case text, files (kept unchanged), retrieved pages, evidence, notes, reports. Material can contain personal information about third parties; enter only what the investigation needs.</li>
      <li><b>Audit log:</b> who did what and when, in a hash-chained log that cannot be edited without detection.</li>
      <li><b>Not stored:</b> analytics, advertising identifiers or tracking. Failed sign-in counters are kept in memory for 15 minutes to slow password guessing; they include your IP address and disappear when the server restarts.</li></ul>
    <h3>Who can see it</h3>
    <p>Only signed-in users of this installation, according to their role: viewers read, analysts work on their own or assigned cases, reviewers approve, administrators manage users and settings. Approvals and notes are recorded under the signed-in account.</p>
    <h3>What leaves the server</h3>
    <ul><li><b>Verify information with a link:</b> the server requests that public page. The site sees this server's address and a user-agent naming AIVS. Private and local network addresses are refused.</li>
      <li><b>AI assistance:</b> ${ai.configured ? `connected to ${ai.providerLabel || ai.provider}. Content is sent only when an analyst previews exactly what will be sent and confirms; the destination is written to the audit log.` : "not configured, so nothing is sent to an AI service."}</li>
      <li><b>Search the web</b> for an image: you upload the image to the outside service yourself; AIVS sends nothing.</li>
      <li>Everything else, including image matching and reading text in images, runs on this server.</li></ul>
    <h3>Keeping and deleting</h3>
    <p>Cases, files and the audit log are kept until an administrator removes them. Approved reports are frozen and kept with their fingerprints. Retention periods and deletion controls are planned (Phase 6); until then, the operator should set a retention policy and back up the data folder securely.</p>
    <h3>Questions or corrections</h3><p>Contact the administrator of this installation.</p></div></div>`;
}
