// Read the existing durable workers without copying or restarting their work.
export function backgroundOverview(db, user) {
  const state = s => ({ queued: 'Pending', running: 'Processing', done: 'Completed', completed: 'Completed', failed: 'Failed', rejected: 'Rejected' })[s] || s;
  const jobs = [];
  const add = (table, owner, fields, kind, link) => {
    // Table/column names are fixed by this module; only the requester is input.
    for (const r of db.prepare(`SELECT ${fields} FROM ${table} WHERE ${owner}=? ORDER BY created_at DESC LIMIT 50`).all(user.id)) {
      jobs.push({ ...r, key: `${kind}:${r.id}`, kind, status_label: state(r.status), href: link(r) });
    }
  };
  add('video_analyses', 'created_by', 'id,case_id,status,stage,created_at', 'Video analysis', r => `#/case/${encodeURIComponent(r.case_id)}/media`);
  add('screenshot_analyses', 'created_by', 'id,original_name,status,stage,created_at', 'Screenshot analysis', r => `#/monitor/shot/${encodeURIComponent(r.id)}`);
  add('transcripts', 'created_by', 'id,case_id,status,progress,created_at', 'Speech transcription', r => `#/case/${encodeURIComponent(r.case_id)}/media`);
  add('io_jobs', 'created_by', 'id,dataset_id,status,progress,created_at', 'Social media analysis', r => r.dataset_id ? `#/monitor/${r.dataset_id}` : '#/monitor');
  // AI runs use a different timestamp and owner column.
  for (const r of db.prepare('SELECT id,case_id,status,started_at AS created_at FROM ai_runs WHERE requested_by=? ORDER BY started_at DESC LIMIT 50').all(user.id)) {
    jobs.push({ ...r, key: `AI:${r.id}`, kind: 'AI analysis', status_label: state(r.status), href: `#/case/${encodeURIComponent(r.case_id)}/ai` });
  }
  return jobs.sort((a,b) => b.created_at.localeCompare(a.created_at));
}
