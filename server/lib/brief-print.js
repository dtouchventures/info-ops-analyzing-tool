import fs from "node:fs";
import PDFDocument from 'pdfkit';
import { docxFromBody } from './autoreport.js';
import { fit, pdf as formalPdf, docx as formalDocx, html as formalHtml } from './formal-print.js';
import { dtg } from './formal-report.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>s?new Date(s).toLocaleString('en-GB',{timeZone:'Africa/Nairobi',dateStyle:'medium',timeStyle:'short'})+' EAT':'Not recorded';
const letter=i=>`(${String.fromCharCode(97+i)})`;
// Daily exports reuse the established service-writing layout. The immutable
// snapshot/JSON retains every alert; only the printed executive brief is condensed.
const compact=(value,max)=>{const text=String(value||'').replace(/\s+/g,' ').trim();return text.length<=max?text:text.slice(0,max-1).trimEnd()+'…';};
export function dailyFormalReport(r){
  const items=[...r.items].sort((a,b)=>Number(b.priority==='high')-Number(a.priority==='high')||String(b.last_detected||'').localeCompare(String(a.last_detected||'')));
  for(let count=Math.min(5,items.length);count>=0;count--){
    const shown=items.slice(0,count),omitted=items.length-count;
    const report={date:dtg(new Date(r.created_at)),subject:'DAILY INFORMATION OPERATIONS MONITORING REPORT',
      purpose:'To brief important Live Monitoring and AI Watchlist alerts recorded during the preceding 24 hours.',
      background:`${compact(r.reference,65)}. ${r.status||'Draft — not approved'}${r.is_training?' — TRAINING':''}. Window: ${date(r.window_from)} to ${date(r.window_to)} (end excluded). ${r.raw_count} alerts; ${items.length} distinct groups; ${r.duplicate_count} duplicates grouped.`,
      analysis:shown.map((item,i)=>`${i+1}. [${item.priority.toUpperCase()}] ${compact(item.title,90)}. ${compact(item.summary,180)} References: ${compact(item.refs.join(', '),100)}.`).join('\n')+(items.length?(omitted?`\n${omitted} further group(s) are retained in the full saved record/JSON; this page prioritises the highest-priority, then most recent alerts.`:'\nAll distinct alert groups are summarised; full source details remain in the saved record/JSON.'):'No qualifying high- or medium-priority alerts were recorded; this does not establish an absence of events.'),
      assessment:'Recorded alerts are monitoring leads; accuracy, Information Operations effects and intent require corroboration. Likelihood cannot be assessed from alert priority alone.\nCollection coverage may be incomplete; no recorded alert does not establish that no activity occurred.',
      recommendations:['Task IO analysts to verify high-priority narratives against official sources and independent evidence; record gaps and a supported likelihood judgement.','Prepare evidence-linked factual talking points or holding lines for authorised review; monitor narrative changes and reassess when new evidence emerges.'],
      conclusion:'Draft for authorised review. Preserve the full alert record; this brief does not authorise public release.'};
    if(r.coverage)report.background+=` Last successful collection in window: watch ${date(r.coverage.last_watch_success)}; live ${date(r.coverage.last_live_success)}.`;
    const layout=fit(report);if(layout.fits)return {report,layout};
  }
  throw new Error('The daily brief cannot fit the established one-page layout.');
}
export function briefParagraphs(r){
  const p=[],add=(text,bold=false)=>p.push({text:String(text||''),bold});
  add('RESTRICTED',true);add('UNIT: STRATEGIC COMMUNICATION',true);add(r.title,true);add(`${r.reference} · ${r.status}${r.is_training?' · TRAINING':''}`);add(`Generated: ${date(r.created_at)}`);
  add('1. PURPOSE',true);add(r.window_from?'To provide an Information Operations brief of important recorded monitoring alerts from the preceding 24 hours.':'To consolidate selected verification findings while retaining the identity and evidence of each source report.');
  add('2. BACKGROUND',true);
  if(r.window_from)add(`Reporting window: ${date(r.window_from)} to ${date(r.window_to)} (end excluded). ${r.scheduled?'Scheduled daily report; late creation indicates catch-up after downtime.':'Generated on request.'}`);
  add(`${r.raw_count} source record(s); ${r.items.length} distinct item group(s); ${r.duplicate_count} duplicate record(s) grouped. Original references are retained.`);
  if(r.selection_basis)add(r.selection_basis);
  if(r.coverage)add(`Configuration at generation: ${r.coverage.active_watchlists} active watchlist(s), ${r.coverage.enabled_live_sources} enabled live source(s). Last successful watch run within the reporting window: ${date(r.coverage.last_watch_success)}; live sync within the window: ${date(r.coverage.last_live_success)}. Enabled does not confirm continuous or complete collection.`);
  add('3. ANALYSIS AND DISTINCT FINDINGS',true);
  if(!r.items.length)add('No qualifying important alerts were recorded. Review collection coverage before interpreting this absence.');
  r.items.forEach((item,i)=>{
    add(`${i+1}. ${item.title}`,true);add(`Source references: ${item.refs.join(', ')}`);
    if(item.verifications){
      for(const v of item.verifications)add(`Selected source: ${v.report_id} · ${v.id}${v.case_id?' · '+v.case_id:''} · ${v.verdict} · completed ${date(v.completed_at)}. Source fingerprint: ${v.source_sha256||'not recorded'}`);
      const v=item.verifications[0];
      (v.claim_findings||v.claims.map(text=>({text,verdict:null}))).forEach((c,n)=>add(`${letter(n)} ${c.text}${c.verdict?' — '+c.verdict:''}${c.reason?'. '+c.reason:''}`));
      add(v.assessment);if(v.source_url)add(`Submitted source: ${v.source_url}`);
      const citations=new Map();for(const source of item.verifications)for(const e of source.evidence){const key=JSON.stringify([e.url||e.id,e.stance,e.title]);if(!citations.has(key))citations.set(key,{...e,ids:[],reports:[]});const c=citations.get(key);if(!c.ids.includes(e.id))c.ids.push(e.id);if(!c.reports.includes(source.report_id))c.reports.push(source.report_id);}
      for(const e of citations.values())add(`Evidence ${e.ids.join(', ')} (${e.reports.join(', ')}): ${e.title||'Source'} · ${e.stance||'not assessed'} · published ${e.date||'unknown'}${e.url?' · '+e.url:''}`);
    }
    else{add(`Priority: ${item.priority}; alert status: ${item.status}. Monitoring lead, not a verified finding.`);add(item.summary);for(const alert of item.alerts||[])if(alert.reason!==item.summary)add(`Additional alert ${alert.ref} (${alert.priority}, ${alert.status}): ${alert.reason}`);if(item.content_excerpt)add(`Source excerpt: ${item.content_excerpt}`);if(item.source_url)add(`Source: ${item.source_url}`);add(`Detected: ${date(item.first_detected)} to ${date(item.last_detected)} · ${item.origins.join(', ')}`);if(item.case_ids.length)add(`Linked case(s): ${item.case_ids.join(', ')}`);}
  });
  add('5. INFORMATION OPERATIONS ASSESSMENT',true);r.assessment.forEach((s,i)=>add(`${letter(i)} ${s}`));
  add('6. ACTION RECOMMENDATIONS',true);r.recommendations.forEach((s,i)=>add(`${letter(i)} ${s}`));
  add('7. CONCLUSION',true);add('This is a consolidated draft for authorised review. It preserves source findings and uncertainty; it does not approve source claims, establish intent, or authorise public release.');
  add('RESTRICTED',true);return p;
}
export function briefHtml(r){if(r.window_from){const {report,layout}=dailyFormalReport(r);return formalHtml(report,layout);}return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.reference)}</title><style>@page{size:A4;margin:16mm}body{font:10pt/1.35 Arial,sans-serif;color:#000;max-width:180mm;margin:20px auto}p{margin:6pt 0;overflow-wrap:anywhere;white-space:pre-wrap}.head{font-weight:bold;margin-top:12pt;break-after:avoid}h1{font-size:15pt}a{color:#064f66}@media print{body{margin:0;max-width:none}.tools{display:none}}</style></head><body><div class="tools">Print this report with Ctrl+P.</div>${briefParagraphs(r).map(p=>`<p class="${p.bold?'head':''}">${esc(p.text)}</p>`).join('')}</body></html>`;}
export function briefPdf(r){if(r.window_from){const {report,layout}=dailyFormalReport(r);return formalPdf(report,layout);}return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margins:{top:64,bottom:48,left:45,right:45},bufferPages:true,info:{Title:r.title,Creator:'JICHO AI'}}),chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  const arial=fs.existsSync("C:/Windows/Fonts/arial.ttf")&&fs.existsSync("C:/Windows/Fonts/arialbd.ttf");
  if(arial){doc.registerFont("BriefRegular","C:/Windows/Fonts/arial.ttf");doc.registerFont("BriefBold","C:/Windows/Fonts/arialbd.ttf");}
  const regular=arial?"BriefRegular":"Helvetica",bold=arial?"BriefBold":"Helvetica-Bold";
  const paragraphs=briefParagraphs(r);for(const p of paragraphs.slice(1,-1)){if(p.bold&&doc.y>doc.page.height-doc.page.margins.bottom-42)doc.addPage();doc.font(p.bold?bold:regular).fontSize(p.bold?11:10).text(p.text,{paragraphGap:3});doc.moveDown(0.15);}
  const range=doc.bufferedPageRange();for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);doc.page.margins.bottom=0;doc.font(bold).fontSize(9).text('RESTRICTED',45,25,{align:'center',width:505,lineBreak:false});doc.font(regular).fontSize(8).text(`${r.reference} · DRAFT · ${i+1}/${range.count}`,45,doc.page.height-27,{align:'center',width:505,lineBreak:false});doc.page.margins.bottom=48;}
  doc.end();
});}
export function briefDocx(r){if(r.window_from){const {report,layout}=dailyFormalReport(r);return formalDocx(report,layout);}const xml=s=>esc(String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/g,''));return docxFromBody(`<w:body>${briefParagraphs(r).map(p=>`<w:p><w:pPr>${p.bold?'<w:keepNext/>':''}<w:spacing w:after="100"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/>${p.bold?'<w:b/>':''}</w:rPr><w:t xml:space="preserve">${xml(p.text)}</w:t></w:r></w:p>`).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="907" w:right="907" w:bottom="907" w:left="907"/></w:sectPr></w:body>`);}
