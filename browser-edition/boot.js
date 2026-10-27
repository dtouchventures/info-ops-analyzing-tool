// ---------------------------------------------------------------- training material (synthetic) + boot
const TRAINING = {
  archive: [
    { file: "archive_convoy.jpg", url: "__URL_archive_convoy__", title: "Supply convoy crossing a flooded track (SYNTHETIC)", documented_date: "2018-10-14", record_type: "original",
      description: "SYNTHETIC TRAINING RECORD. Documented as a routine convoy crossing during seasonal rains; all vehicles completed the crossing.", source_ref: "Training dataset · record convoy-2018" },
    { file: "archive_notice.jpg", url: "__URL_archive_notice__", title: "Counterfeit ‘national call-up’ notice (SYNTHETIC)", documented_date: "2024-05-12", record_type: "misleading",
      description: "SYNTHETIC TRAINING RECORD. Fabricated notice template previously assessed as misleading; its printed date reads 14 October 1968.", source_ref: "Training dataset · prior report TRN-VR-0112" }
  ],
  cases: [
    { file: "case_convoy.jpg", url: "__URL_case_convoy__", title: "Training 1 · Flooded convoy photo", claim_text: "BREAKING: Several KDF supply trucks were abandoned in floodwater along the Garissa-Modika road last night after flash floods. Soldiers were forced to retreat on foot.", source_platform: "X (Twitter) — synthetic example", priority: "urgent" },
    { file: "case_notice.jpg", url: "__URL_case_notice__", title: "Training 2 · Recruitment notice", claim_text: "URGENT PUBLIC NOTICE: The Ministry of Defence has opened recruitment this month. Applicants must pay a Sh5,000 processing fee via M-Pesa before registration.", source_platform: "WhatsApp forward — synthetic example", priority: "priority" },
    { file: "case_patrol.jpg", url: "__URL_case_patrol__", title: "Training 3 · Patrol photo", claim_text: "KDF troops conducted a routine reassurance patrol near the Sector 3 outpost this morning. The area remains calm.", source_platform: "Facebook repost — synthetic example", priority: "routine" }
  ]
};
(async () => {
  const root = document.getElementById("root");
  root.innerHTML = `<div class="boot"><span class="spin"></span> ${LOCAL ? "Opening your saved work…" : "Connecting to the shared case store…"}</div>`;
  if (LOCAL) {
    try { await LOCALAPI.boot(); }
    catch (e) { root.innerHTML = `<div class="boot"><div class="card" style="max-width:560px"><div class="hd"><h3>AIVS cannot save in this browser</h3></div><div class="bd"><p>${esc(e.message || String(e))}</p><p class="small muted">Open the file in a current Chrome, Edge or Firefox window that is not private or incognito.</p></div></div></div>`; return; }
    if (!LOCALAPI.profile) {
      await new Promise(resolve => {
        root.innerHTML = `<div class="boot"><form class="card" id="lp" style="max-width:560px;width:100%"><div class="hd"><h3>AIVS · no-install edition</h3></div><div class="bd">
          <p>This edition runs entirely in this browser. Your work is saved here, on this computer, and nothing is sent to the internet.</p>
          <label class="f" for="lpn">Your name, as it should appear on your work <span class="req">*</span></label><input type="text" id="lpn" maxlength="80" autocomplete="name" required>
          <div class="callout warn" style="margin-top:12px"><div>There is no sign-in here, so this name is <b>not a verified identity</b>. Reports label approvals made in this edition as <b>local analyst acknowledgements</b>.</div></div>
          <div id="lpe" class="callout bad" style="margin-top:10px" hidden></div><button class="btn primary" style="margin-top:14px" id="lpb">Start</button></div></form></div>`;
        $("#lpn").focus();
        $("#lp").onsubmit = async ev => { ev.preventDefault(); try { await LOCALAPI.setName($("#lpn").value); resolve(); } catch (er) { $("#lpe").hidden = false; $("#lpe").textContent = er.message; } };
      });
    }
  }
  try { await initPlatform(); } catch (e) { console.error(e); }
  if (!PL.db) {
    root.innerHTML = `<div class="boot"><div class="card" style="max-width:520px"><div class="hd"><h3>Sign-in needed</h3></div><div class="bd"><p>AIVS keeps cases, evidence and approvals in a shared store tied to claude.ai accounts. Open this page while signed in to claude.ai, using a link that has been shared with you.</p><p class="small muted">Nothing is stored in this browser, and no figures are shown without the shared store.</p></div></div></div>`;
    return;
  }
  shell(); route();
})();
