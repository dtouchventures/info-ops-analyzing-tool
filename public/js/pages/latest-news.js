import { api } from '../api.js';
import { esc, fmtDT } from '../ui.js';

export async function renderLatestNews(body) {
  body.innerHTML = `<div class="card"><div class="hd"><h2>Latest Kenya news</h2><button class="btn sm ghost" id="newsRefresh">Refresh</button></div><div class="bd"><p>General headlines across the Kenya news edition. This feed is separate from keyword matches and alerts. It checks for updates every minute while open; indexing can delay new articles.</p><p class="small sub">Headlines are discovery leads, not verified findings. Open the source article and submit its link to Verify Information for an assessment.</p><p id="newsState" role="status">Loading latest headlines…</p><div id="newsItems"></div></div></div>`;
  const panel=body.querySelector('#newsItems'),state=body.querySelector('#newsState'),button=body.querySelector('#newsRefresh');
  let timer=null,busy=false,signature='';
  async function update(){
    clearTimeout(timer);
    if(!panel.isConnected||busy)return;
    if(document.hidden){timer=setTimeout(update,5000);return;}
    busy=true;button.disabled=true;
    try{
      const data=await api.get('/api/watch/news/latest');if(!panel.isConnected)return;
      state.textContent=(data.error ? `${data.error}${data.checked_at ? ' Last successful refresh: '+fmtDT(data.checked_at) : ''}` : '')||`Last refreshed: ${data.checked_at?fmtDT(data.checked_at):'not available'} · ${data.articles.length} headlines · Updates every minute`;
      state.className=data.stale?'small warn':'small sub';
      const next=JSON.stringify(data.articles);
      if(next!==signature){signature=next;panel.innerHTML=data.articles.length?data.articles.map(a=>`<article style="padding:12px 0;border-top:1px solid var(--line);overflow-wrap:anywhere"><h3 style="margin:0 0 6px;font-size:16px"><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h3><p class="small sub" style="margin:0">${esc(a.publisher)} · ${a.published_at?fmtDT(a.published_at):'Publication time not stated'}</p></article>`).join(''):'<p>No headlines are available from this feed yet.</p>';}
    }catch{if(panel.isConnected)state.textContent='The news feed could not be reached. Existing headlines are retained; reconnecting automatically.';}
    finally{busy=false;button.disabled=false;if(panel.isConnected)timer=setTimeout(update,60000);}
  }
  button.onclick=update;
  await update();
}
