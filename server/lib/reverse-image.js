import sharp from "sharp";
import { fetchPage, fetchImage } from "./fetchurl.js";
import { fingerprint, compareFp, VERIFIED } from "./videocheck.js";

const publicUrl = value => { try { const u=new URL(value); return /https?:/.test(u.protocol) && !u.username && !u.password; } catch { return false; } };
export function lensHasNoMatches(httpOk, result) {
  return httpOk && result.search_metadata?.status === "Success" &&
    /^(?:Google Lens|Google) (?:hasn't|has not) returned any results for this query\.?$/i.test(String(result.error || "")) &&
    !(Array.isArray(result.exact_matches) && result.exact_matches.length);
}
function providerFailure(status) {
  const code = [401,403].includes(status) ? "access" : status === 429 ? "limit" : status >= 500 ? "provider" : "request";
  return Object.assign(new Error("Reverse-image provider request failed"), { reverseCode: code });
}
export function makeReverseImageSearch(config) {
  const cfg=config.mediaCheck || {};
  const provider=cfg.provider || (cfg.serpapiKey?"serpapi":"google");
  const configured=provider==="serpapi"?!!cfg.serpapiKey:provider==="google"?!!cfg.visionKey:false;
  const status=()=>({configured,provider,service:provider==="serpapi"?"SerpApi Google Lens":"Google Cloud Vision Web Detection",needs:configured?null:"Configure SERPAPI_API_KEY with REVERSE_IMAGE_PROVIDER=serpapi, or GOOGLE_VISION_API_KEY with REVERSE_IMAGE_PROVIDER=google. Gemini and text-search keys do not enable reverse-image matching."});
  async function search(buffer) {
    if(!status().configured) throw new Error(status().needs);
    let image=await sharp(buffer).rotate().resize({width:1800,height:1800,fit:"inside",withoutEnlargement:true}).flatten({background:"#ffffff"}).jpeg({quality:90}).toBuffer();
    let response;
    try {
      if(provider==="serpapi") {
        for(const width of [1400,1000,700,500]) {if(image.length<=500000)break;image=await sharp(buffer).rotate().resize({width,height:width,fit:"inside",withoutEnlargement:true}).flatten({background:"#ffffff"}).jpeg({quality:80}).toBuffer();}
        if(image.length>500000)throw new Error("Image upload limit");
        const form=new FormData();form.append("image",new Blob([image],{type:"image/jpeg"}),"search-image.jpg");form.append("api_key",cfg.serpapiKey);
        const root=cfg.serpapiBase || "https://serpapi.com";
        const upload=await fetch(`${root}/image`,{method:"POST",body:form,signal:AbortSignal.timeout(cfg.timeoutMs || 20000)});
        if(!upload.ok)throw providerFailure(upload.status);
        const uploaded=await upload.json();
        if(uploaded.error || typeof uploaded.image_id!=="string")throw new Error("Image upload failed");
        const url=new URL(`${root}/search.json`);url.searchParams.set("engine","google_lens");url.searchParams.set("type","exact_matches");url.searchParams.set("image_id",uploaded.image_id);url.searchParams.set("api_key",cfg.serpapiKey);
        const searchTimeout=Math.max(1000,Math.min(120000,Number(cfg.serpapiTimeoutMs) || 60000));
        const found=await fetch(url,{signal:AbortSignal.timeout(searchTimeout)});
        if(!found.ok)throw providerFailure(found.status);
        const j=await found.json();
        if(!lensHasNoMatches(found.ok,j) && (j.error || j.search_metadata?.status!=="Success" || !Array.isArray(j.exact_matches)))throw new Error("Search failed");
        const matches=Array.isArray(j.exact_matches)?j.exact_matches:[];
        response={pagesWithMatchingImages:matches.map(p=>({url:p.link,pageTitle:p.title,fullMatchingImages:(p.image || p.thumbnail)?[{url:p.image || p.thumbnail}]:[]}))};
      } else {
      const r=await fetch(`${cfg.visionBase || "https://vision.googleapis.com"}/v1/images:annotate`,{method:"POST",headers:{"content-type":"application/json","x-goog-api-key":cfg.visionKey},body:JSON.stringify({requests:[{image:{content:image.toString("base64")},features:[{type:"WEB_DETECTION",maxResults:10}]}]}),signal:AbortSignal.timeout(cfg.timeoutMs || 15000)});
      const j=await r.json();
      if(!r.ok || j.error || j.responses?.[0]?.error) throw new Error("provider_error");
      if(!j.responses?.[0]?.webDetection) throw new Error("invalid_response");
      response=j.responses[0].webDetection;
      }
    } catch (e) {
      const detail = provider === "serpapi" && ["TimeoutError","AbortError"].includes(e.name) ? "Google Lens did not respond before the search timeout. Retry this search from Background tasks."
        : e.reverseCode === "access" ? "SerpApi rejected the key or account access. Check the server's SerpApi configuration."
        : e.reverseCode === "limit" ? "SerpApi reached an account or rate limit. Check the account quota before retrying."
        : e.reverseCode === "provider" ? "The reverse-image provider is temporarily unavailable. Retry later."
        : `Check the ${status().service} key, account access, quota and connection.`;
      throw new Error(`Online reverse-image search failed. ${detail} No conclusion about earlier postings was made.`);
    }
    const seen=new Set();
    const pages=(response.pagesWithMatchingImages || []).filter(p=>publicUrl(p.url) && !seen.has(p.url) && seen.add(p.url)).slice(0,8).map(p=>({url:p.url,title:String(p.pageTitle || "").replace(/<[^>]+>/g,"").slice(0,200),provider_match:p.fullMatchingImages?.length?"full":p.partialMatchingImages?.length?"partial":"reported",full_match:!!p.fullMatchingImages?.length,match_status:"not_checked",date:null,date_basis:null,image_urls:[...(p.fullMatchingImages || []),...(p.partialMatchingImages || [])].map(x=>x.url).filter(publicUrl).slice(0,2)}));
    const original=await fingerprint(buffer);
    await Promise.all(pages.slice(0,4).map(async p=>{
      try {
        const page=await fetchPage(p.url,{allowPrivate:!!config.allowPrivateFetch});
        p.title=page.title || p.title;
        if(page.published && Number.isFinite(Date.parse(page.published)) && Date.parse(page.published)<=Date.now()) {p.date=new Date(page.published).toISOString();p.date_basis=page.publishedBasis || "publication date stated by the page";}
        const candidates=[...new Set([...p.image_urls,...(page.images || []).map(x=>typeof x==="string"?x:x.url)])].filter(publicUrl).slice(0,2);
        p.match_status="unverified";
        for(const url of candidates) {
          try {
            const remote=await fetchImage(url,{allowPrivate:!!config.allowPrivateFetch});
            const match=compareFp(original,await fingerprint(remote.raw));
            if(match.score<=VERIFIED.score && match.cosine>=VERIFIED.cosine) {p.match_status="confirmed";p.matched_image_url=remote.finalUrl || url;break;}
          } catch { /* Keep the provider result visibly unverified when access fails. */ }
        }
      } catch {p.match_status="unverified";p.access_note="The page could not be retrieved; its date and image match were not independently checked.";}
      delete p.image_urls;
    }));
    pages.forEach(p=>delete p.image_urls);
    pages.sort((a,b)=>(a.date?Date.parse(a.date):Infinity)-(b.date?Date.parse(b.date):Infinity));
    const earliest=pages.find(p=>p.date && p.match_status==="confirmed");
    return {status:"completed",searched_at:new Date().toISOString(),service:status().service,pages,full_matches:(response.fullMatchingImages || []).length,partial_matches:(response.partialMatchingImages || []).length,earliest_known:earliest?{url:earliest.url,date:earliest.date,date_basis:earliest.date_basis}:null,note:"Results cover the provider's index. Page dates can be wrong or edited. The earliest dated confirmed match among these results is not proof of the first upload or original uploader. Private or inaccessible posts may not be found."};
  }
  return {status,search};
}
