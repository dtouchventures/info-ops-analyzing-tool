import crypto from 'node:crypto';
import { HttpError } from './auth.js';

const DAY=86400000, OFFSET=3*3600000;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const iso=t=>new Date(t).toISOString();
const day=t=>iso(Number(t)+OFFSET).slice(0,10);
const normal=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const canonical=value=>{try{const u=new URL(value);u.hash='';for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(k))u.searchParams.delete(k);return u.href.replace(/\/$/,'');}catch{return '';}};
export function dailyCutoff(now){const d=day(now);let end=Date.parse(d+'T23:59:00+03:00');if(end>now)end-=DAY;return end;}
export function makeBriefReports(db,{audit,notify,now=()=>Date.now()}={}) {
  let timer=null,lastError=null;
  const setting=k=>db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  function initialise(){if(!setting('brief_daily_enabled_at'))db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run('brief_daily_enabled_at',iso(now()));}
  function get(id){if(!Number.isSafeInteger(Number(id))||Number(id)<1)throw new HttpError(404,'Report not found.');const r=db.prepare('SELECT * FROM brief_reports WHERE id=?').get(id);if(!r)throw new HttpError(404,'Report not found.');if(hash(r.snapshot_json)!==r.sha256)throw new HttpError(500,'The saved report does not match its fingerprint.');return {...r,snapshot:JSON.parse(r.snapshot_json),snapshot_json:undefined};}
  function save(user,kind,scope,snapshot,key){return db.transaction(()=>{
    const prior=db.prepare('SELECT id FROM brief_reports WHERE dedupe_key=?').get(key);if(prior)return {...get(prior.id),reused:true};
    const id=db.prepare('SELECT coalesce(max(id),0)+1 n FROM brief_reports').get().n;
    const reference=`JICHO-${kind==='daily'?'DAY':'CON'}-${day(kind==='daily'&&snapshot.window_to?Date.parse(snapshot.window_to):now()).replace(/-/g,'')}-${String(id).padStart(6,'0')}`;
    const json=JSON.stringify({...snapshot,reference,status:'Draft — not approved',created_at:iso(now())});
    db.prepare('INSERT INTO brief_reports(id,reference,kind,is_training,window_from,window_to,snapshot_json,sha256,dedupe_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,reference,kind,scope,snapshot.window_from||null,snapshot.window_to||null,json,hash(json),key,user?.id||null,iso(now()));
    audit?.(user,'Summary report generated','brief',String(id),{reference,kind,items:snapshot.items.length,scope});
    if(kind==='daily')notify?.send(db.prepare("SELECT id FROM users WHERE active=1 AND role IN ('admin','reviewer','hod','analyst')").all().map(u=>u.id),{kind:'daily_report',title:`Daily monitoring report: ${reference}`,body:`${snapshot.items.length} unique important alert item(s). Draft; review before use.`,link:'#/reports',ref:reference});
    return get(id);
  }).immediate();}
  function daily(user=null,{end=now(),training=false,scheduled=false}={}){
    end=Number(end);if(!Number.isFinite(end))throw new HttpError(400,'Invalid reporting window.');
    const from=end-DAY,a=iso(from),b=iso(end),tr=training?1:0;
    const watch=db.prepare(`SELECT a.id,a.title,a.reason,a.severity AS priority,a.status,a.created_at,p.url,p.text AS content,a.case_id FROM watch_alerts a LEFT JOIN watch_posts p ON p.id=a.post_id WHERE a.created_at>=? AND a.created_at<? AND a.is_training=? AND a.severity IN ('high','medium') AND a.status!='dismissed' ORDER BY a.created_at`).all(a,b,tr).map(r=>({...r,origin:'AI Watchlist',ref:`WATCH-${r.id}`}));
    const live=db.prepare(`SELECT a.id,a.title,a.reason,a.priority,a.status,a.created_at,p.permalink_url AS url,p.message AS content FROM live_alerts a LEFT JOIN social_posts p ON p.id=a.post_id WHERE a.created_at>=? AND a.created_at<? AND a.is_training=? AND a.priority IN ('high','medium') AND a.status!='dismissed' ORDER BY a.created_at`).all(a,b,tr).map(r=>({...r,origin:'Live monitoring',ref:`LIVE-${r.id}`}));
    const groups=new Map();
    for(const r of [...watch,...live]){
      const content=normal(r.content),key=canonical(r.url)||(content.length>=30?hash(content):r.ref);
      const item={title:r.title,summary:r.reason,content_excerpt:String(r.content||'').slice(0,1500),priority:r.priority,status:r.status,alerts:[{ref:r.ref,origin:r.origin,title:r.title,reason:r.reason,status:r.status,priority:r.priority}],source_url:r.url||null,refs:[r.ref],origins:[r.origin],first_detected:r.created_at,last_detected:r.created_at,case_ids:r.case_id?[r.case_id]:[]};
      const prior=groups.get(key);
      if(!prior)groups.set(key,item);else{prior.refs.push(r.ref);prior.alerts.push(...item.alerts);prior.status=[...new Set(prior.alerts.map(a=>a.status))].join(', ');prior.origins=[...new Set([...prior.origins,r.origin])];prior.case_ids=[...new Set([...prior.case_ids,...item.case_ids])];if(r.priority==='high'&&prior.priority!=='high'){prior.priority='high';prior.title=r.title;prior.summary=r.reason;}prior.first_detected=[prior.first_detected,r.created_at].sort()[0];prior.last_detected=[prior.last_detected,r.created_at].sort().at(-1);}
    }
    const items=[...groups.values()].sort((a,b)=>Number(b.priority==='high')-Number(a.priority==='high')||b.last_detected.localeCompare(a.last_detected));
    const coverage={active_watchlists:db.prepare("SELECT count(*) n FROM watchlists WHERE status='active'").get().n,enabled_live_sources:db.prepare('SELECT count(*) n FROM social_sources WHERE enabled=1 AND is_training=?').get(tr).n,last_watch_success:db.prepare("SELECT max(finished_at) at FROM watch_runs WHERE status='ok' AND started_at>=? AND started_at<?").get(a,b).at,last_live_success:db.prepare("SELECT max(s.finished_at) at FROM social_syncs s JOIN social_sources p ON p.id=s.source_id WHERE s.status='ok' AND p.is_training=? AND s.started_at>=? AND s.started_at<?").get(tr,a,b).at};
    return save(user,'daily',tr,{title:'Daily Information Operations monitoring report',window_from:a,window_to:b,scheduled,selection_basis:'High and medium priority alerts created in the preceding 24 hours; dismissed and other-scope alerts excluded. Window includes its start and excludes its end.',raw_count:watch.length+live.length,duplicate_count:watch.length+live.length-items.length,items,coverage,assessment:[items.length?`${items.length} unique important alert item(s) were recorded. Priority ranks monitoring leads; it does not establish accuracy or intent.`:'No qualifying important alerts were recorded in this reporting window. This does not establish an absence of events or complete monitoring coverage.','Information Operations significance: assess possible effects on public understanding and confidence in official communication against the linked evidence; alert volume alone does not establish misinformation, coordination or intent.','Collection depends on connected sources. Review coverage gaps and source records before drawing conclusions.'],recommendations:['Task authorised IO staff to prepare a decision brief on the high-priority leads, recording the evidence gaps and relevant official communication.','Record material narrative changes in the IO monitoring log; prepare factual holding lines for authorised review where evidence remains unresolved.','Preserve source references, review proposed communication before release and reassess when new evidence changes the judgement.']},`daily:${scheduled?'scheduled':'manual'}:${tr}:${scheduled?b:b.slice(0,16)+':'+hash(JSON.stringify([items,coverage]))}`);
  }
  function candidates(training=false){return db.prepare("SELECT id,report_id,case_id,subject,overall,completed_at FROM investigations WHERE status='done' AND result_json IS NOT NULL AND is_training=? ORDER BY completed_at DESC LIMIT 500").all(training?1:0);}
  function consolidate(user,ids,{training=false,title='Consolidated Information Operations verification report'}={}){
    if(!Array.isArray(ids)||ids.length>50||ids.some(x=>typeof x!=='string'||!/^INV-\d+$/.test(x)))throw new HttpError(400,'Select between two and fifty completed verifications.');
    ids=[...new Set(ids)].sort();if(ids.length<2)throw new HttpError(400,'Select at least two distinct verifications.');
    if(typeof title!=='string')throw new HttpError(400,'Enter a report title.');
    title=String(title).trim().slice(0,200)||'Consolidated Information Operations verification report';
    const rows=ids.map(id=>db.prepare("SELECT id,report_id,case_id,subject,overall,result_json,completed_at FROM investigations WHERE id=? AND status='done' AND is_training=?").get(id,training?1:0));
    if(rows.some(r=>!r?.result_json))throw new HttpError(400,'A selected verification is incomplete, unavailable or belongs to another record scope.');
    const groups=new Map();
    for(const row of rows){const r=JSON.parse(row.result_json);const claims=(r.claims||[]).map(c=>String(c.text||'')).filter(Boolean);const claimFindings=(r.claims||[]).map((c,i)=>{const a=(r.assessments||[]).find(x=>x.claim_id===c.id)||(r.assessments||[])[i]||{};return {id:c.id||null,text:String(c.text||''),verdict:a.verdict||c.assessment||'Not separately assessed',reason:a.reason||c.rationale||null};});
      const source=canonical(r.source?.url),assessment=r.io_assessment?.assessment||(Array.isArray(r.sections?.assessment)?r.sections.assessment.join(' '):r.sections?.assessment)||'See the original verification for its evidence-based assessment.';
      const key=hash(JSON.stringify([source||normal(r.content)||row.case_id||row.id,claimFindings.map(c=>[normal(c.text),c.verdict,normal(c.reason)]).sort((a,b)=>a[0].localeCompare(b[0])),r.overall?.verdict||row.overall,normal(assessment)]));
      const entry={source_sha256:hash(row.result_json),id:row.id,report_id:row.report_id,case_id:row.case_id,completed_at:row.completed_at,verdict:r.overall?.label||r.overall?.verdict||row.overall||'Not assessed',assessment,claim_findings:claimFindings,source_url:r.source?.url||null,claims,evidence:(r.evidence||[]).map(e=>({id:e.id,url:e.source_url||null,title:e.source_title||e.reference||null,stance:e.stance||null,date:e.source_published_at||null}))};
      if(!groups.has(key))groups.set(key,{title:row.subject||row.report_id,summary:entry.assessment,priority:'verification',refs:[],verifications:[]});const group=groups.get(key);group.refs.push(row.report_id);group.verifications.push(entry);
    }
    const items=[...groups.values()],sourceRows=rows.map(r=>[r.id,hash(r.result_json)]);
    return save(user,'consolidated',training?1:0,{title,source_ids:ids,raw_count:ids.length,duplicate_count:ids.length-items.length,items,assessment:[`${ids.length} selected verifications are presented as ${items.length} distinct finding group(s). Each original report, case and evidence reference remains traceable.`,'Information Operations significance and likelihood remain those recorded in the individual verifications. Conflicting or unresolved findings are retained; no combined truth judgement or intent is invented.','This consolidated document is a new draft. Approval of an individual source report does not approve this document.'],recommendations:['Task authorised IO staff to prepare a consolidated decision brief referencing each distinct finding and any unresolved or conflicting assessments.','Prepare evidence-linked factual talking points or qualified holding lines for authorised review, according to the findings and uncertainty in each source report.','Preserve each source report and its evidence references, and update the consolidated assessment when material new evidence appears.']},'consolidated:'+hash(JSON.stringify([training?1:0,title,sourceRows])));
  }
  function tick(){
    initialise();const enabled=Date.parse(setting('brief_daily_enabled_at')),first=Date.parse(day(enabled)+'T23:59:00+03:00'),last=dailyCutoff(now());
    const completed=db.prepare("SELECT max(window_to) at FROM brief_reports WHERE kind='daily' AND dedupe_key LIKE 'daily:scheduled:0:%'").get().at;
    let due=completed?Date.parse(completed)+DAY:first;
    for(let count=0;due<=last&&count<7;count++,due+=DAY)daily(null,{end:due,scheduled:true});
    lastError=null;
  }
  function start(){if(timer)return;const run=()=>{try{tick();}catch{lastError='The daily report could not be generated; it will retry automatically.';console.error(lastError);}};run();timer=setInterval(run,30000);timer.unref();}
  function status(){const at=now(),cutoff=Date.parse(day(at)+'T23:59:00+03:00');return {enabled:!!timer,time:'23:59',timezone:'Africa/Nairobi',next_due:iso(cutoff>at?cutoff:cutoff+DAY),catch_up:true,last_error:lastError};}
  return {get,daily,consolidate,candidates,tick,start,stop(){clearInterval(timer);timer=null;},status,list(training=false){return db.prepare('SELECT id,reference,kind,window_from,window_to,created_at,sha256 FROM brief_reports WHERE is_training=? ORDER BY id DESC LIMIT 200').all(training?1:0);}};
}
