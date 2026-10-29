// Publisher identity is not a truth rating. Discovery is open to outlets outside this seed catalogue.
import { fetchPage, isPrivateAddress } from './fetchurl.js';
export const KENYAN_NEWS = [
  ['nation.africa','Nation','nation-media'], ['ntvkenya.co.ke','NTV Kenya','nation-media'],
  ['businessdailyafrica.com','Business Daily','nation-media'], ['theeastafrican.co.ke','The EastAfrican','nation-media'],
  ['standardmedia.co.ke','The Standard / KTN','standard-group'],
  ['citizen.digital','Citizen Digital / Royal Media Services','royal-media'],
  ['the-star.co.ke','The Star','radio-africa'], ['mpasho.co.ke','Mpasho','radio-africa'],
  ['kbc.co.ke','KBC','kbc'], ['capitalfm.co.ke','Capital FM','capital-fm'],
  ['peopledaily.digital','People Daily','people-daily'], ['pd.co.ke','People Daily','people-daily'],
  ['kenyanews.go.ke','Kenya News Agency','kenya-news-agency'], ['tuko.co.ke','Tuko','tuko'],
  ['kenyans.co.ke','Kenyans.co.ke','kenyans'], ['tv47.digital','TV47','tv47'],
  ['thekenyatimes.com','The Kenya Times','kenya-times']
];
export function publisherIdentity(url) {
  try { const h=new URL(url).hostname.toLowerCase().replace(/^www\./,''); const r=KENYAN_NEWS.find(([d])=>h===d||h.endsWith('.'+d));return r?{name:r[1],group:r[2]}:null; } catch {return null;}
}
export const publicNewsLink = value => {try{const u=new URL(value);const h=u.hostname.replace(/^\[|\]$/g,'');return /^https?:$/.test(u.protocol)&&!u.username&&!u.password&&h!=='localhost'&&!h.endsWith('.localhost')&&!h.endsWith('.local')&&!((h.includes(':')||/^\d+\./.test(h))&&isPrivateAddress(h));}catch{return false;}};
const text = s => String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
export function newsResults(j) {
  const out=[],seen=new Set();
  const visit=(r,depth=0)=>{
    if(!r||typeof r!=='object'||depth>3||out.length>=40)return;
    if(publicNewsLink(r.link)&&r.title&&!seen.has(r.link)){
      seen.add(r.link);const known=publisherIdentity(r.link);
      out.push({url:r.link,title:text(r.title).slice(0,500),snippet:text(r.snippet||r.description||r.title).slice(0,1200),publisher:known?.name||text(r.source?.name||r.source?.title||(typeof r.source==='string'?r.source:'')||'News publisher (identity not assessed)'),published_at:r.iso_date&&!isNaN(Date.parse(r.iso_date))?new Date(r.iso_date).toISOString():null});
    }
    visit(r.highlight,depth+1);for(const child of r.stories||[])visit(child,depth+1);
  };
  for(const r of j.news_results||[])visit(r);
  // Give different publishers room in the bounded evidence list; retain other outlets as candidates.
  const groups=new Set(),first=[],rest=[];
  for(const r of out){const group=publisherIdentity(r.url)?.group||new URL(r.url).hostname;if(groups.has(group))rest.push(r);else{groups.add(group);first.push(r);}}
  return [...first,...rest];
}
export function makeKenyanNewsSearch(config,{request=fetch}={}) {
  return async q=>{
    const u=new URL('https://serpapi.com/search.json');
    for(const[k,v]of Object.entries({engine:'google_news',q,gl:'ke',hl:'en',api_key:config.mediaCheck?.serpapiKey||''}))u.searchParams.set(k,v);
    try{
      const r=await request(u,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();const j=await r.json();
      const none=j.search_metadata?.status==='Success'&&/^(?:Google News|Google) (?:hasn't|has not) returned any results for this query\.?$/i.test(j.error||'');
      if(!none&&(j.error||j.search_metadata?.status!=='Success'||!Array.isArray(j.news_results)))throw Error();
      return newsResults(j);
    }catch{throw new Error('Kenya news-index search could not complete. Check SerpApi access, quota and connection; no verification conclusion was made.');}
  };
}
export function parseLatestNews(xml) {
  if(!/<rss\b|<feed\b/i.test(xml))throw Error('Invalid feed');
  const field=(s,k)=>text(new RegExp(`<${k}[^>]*>([\\s\\S]*?)<\\/${k}>`,'i').exec(s)?.[1]);
  const out=[],seen=new Set();
  for(const match of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
    const s=match[1],url=field(s,'link'),title=field(s,'title'),date=field(s,'pubDate');
    const sourceUrl=text(/<source\b[^>]*url=["']([^"']+)["']/i.exec(s)?.[1]);
    if(sourceUrl){try{if(/(^|\.)(facebook\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|instagram\.com)$/.test(new URL(sourceUrl).hostname))continue;}catch{continue;}}
    if(!publicNewsLink(url)||!title||seen.has(url))continue;seen.add(url);
    out.push({url,title:title.slice(0,500),publisher:field(s,'source')||'Publisher not stated',published_at:date&&!isNaN(Date.parse(date))?new Date(date).toISOString():null});
    if(out.length===100)break;
  }
  return out.sort((a,b)=>(Date.parse(b.published_at)||0)-(Date.parse(a.published_at)||0));
}
export function makeLatestKenyaNews({page=fetchPage,now=()=>Date.now(),ttl=60000}={}) {
  let cached=null,checked=0,pending=null;
  return {async get(){
    if(cached&&now()-checked<ttl)return cached;
    if(pending)return pending;
    pending=(async()=>{
      try{
        const r=await page('https://news.google.com/rss/search?q=Kenya&hl=en-KE&gl=KE&ceid=KE:en',{allowXml:true});
        if(!r.xml)throw Error();
        cached={articles:parseLatestNews(r.xml),checked_at:new Date(now()).toISOString(),stale:false,error:null,refresh_seconds:60,source:'Google News — Kenya edition',note:'General Kenya-related headlines. Independent of watchlist keywords and alerts. Headlines are not verified findings. Indexing can lag publication; coverage is not exhaustive.'};
      }catch{cached={...(cached||{articles:[],checked_at:null}),stale:true,error:'The latest-news feed could not be refreshed. Previously fetched headlines are retained.',refresh_seconds:60};}
      checked=now();return cached;
    })();try{return await pending;}finally{pending=null;}
  }};
}
