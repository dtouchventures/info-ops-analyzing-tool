import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { makeReverseImageSearch } from "../server/lib/reverse-image.js";
import { startServer, login } from "./helpers.js";

test("online reverse search confirms image copies, checks dates and saves durable case results", async () => {
  const image=fs.readFileSync("training/images/case_convoy.jpg");
  let base, failure=false, calls=0;
  const fake=http.createServer(async(req,res)=>{
    const send=o=>{res.setHeader("content-type","application/json");res.end(JSON.stringify(o));};
    if(req.url==="/image") {for await(const _ of req){}return send({image_id:"test-upload"});}
    if(req.url.startsWith("/search.json")) {const u=new URL(req.url,base);assert.equal(u.searchParams.get("type"),"exact_matches");assert.equal(u.searchParams.get("image_id"),"test-upload");assert.equal(u.searchParams.get("api_key"),"test-secret");return send({search_metadata:{status:"Success"},exact_matches:[{link:base+"/earlier",title:"Earlier copy",thumbnail:base+"/image.jpg"}]});}
    if(req.url==="/v1/images:annotate") {
      calls++; assert.equal(req.headers["x-goog-api-key"],"test-secret");
      for await(const _ of req){}
      if(failure)return send({responses:[{error:{code:7,message:"invalid test-secret"}}]});
      return send({responses:[{webDetection:{pagesWithMatchingImages:[{url:base+"/later",pageTitle:"Later copy",fullMatchingImages:[{url:base+"/image.jpg"}]},{url:base+"/earlier",pageTitle:"Earlier copy",fullMatchingImages:[{url:base+"/image.jpg"}]}],fullMatchingImages:[{url:base+"/image.jpg"}]}}]});
    }
    if(req.url==="/image.jpg"){res.setHeader("content-type","image/jpeg");return res.end(image);}
    res.setHeader("content-type","text/html");res.end(`<html><head><title>Test image copy</title><meta property="article:published_time" content="${req.url==="/earlier"?"2018-03-01":"2021-04-02"}T12:00:00Z"><meta property="og:image" content="${base}/image.jpg"></head><body><article>This is a synthetic page for checking dated image matches.</article></body></html>`);
  });
  await new Promise(r=>fake.listen(0,"127.0.0.1",r));base=`http://127.0.0.1:${fake.address().port}`;
  const config={allowPrivateFetch:true,mediaCheck:{visionKey:"test-secret",visionBase:base,timeoutMs:3000}};
  let s;
  try {
    const search=makeReverseImageSearch(config);
    const result=await search.search(image);
    assert.equal(result.status,"completed");assert.equal(result.pages.length,2);
    assert.ok(result.pages.every(p=>p.match_status==="confirmed"));
    assert.equal(result.earliest_known.date,"2018-03-01T12:00:00.000Z");
    assert.match(result.note,/not proof of the first upload/);
    const serp=await makeReverseImageSearch({...config,mediaCheck:{provider:"serpapi",serpapiKey:"test-secret",serpapiBase:base}}).search(image);
    assert.equal(serp.service,"SerpApi Google Lens");assert.equal(serp.earliest_known.date,"2018-03-01T12:00:00.000Z");
    failure=true;await assert.rejects(search.search(image),/search failed/);
    const before=calls;await assert.rejects(makeReverseImageSearch({}).search(image),/GOOGLE_VISION_API_KEY/);assert.equal(calls,before);
    failure=false;
    const blocked=await makeReverseImageSearch({...config,allowPrivateFetch:false}).search(image);
    assert.equal(blocked.earliest_known,null);assert.ok(blocked.pages.every(p=>p.match_status==="unverified"));
    s=await startServer(config);const ana=await login(s.base,"ana"),view=await login(s.base,"view");
    assert.equal((await ana.get("/api/reverse-images/status")).body.configured,true);
    const c=(await ana.post("/api/cases",{claim_text:"The submitted convoy image is claimed to be recent."})).body;
    const form=new FormData();form.append("files",new Blob([image]),"convoy.jpg");
    const m=(await ana.post(`/api/cases/${c.id}/media`,null,{form})).body.media[0];
    assert.equal((await view.post(`/api/cases/${c.id}/tasks`,{kind:"collection",input:{reverse_image:true,media_id:m.id,confirm_external:true}})).status,403);
    const task=(await ana.post(`/api/cases/${c.id}/tasks`,{kind:"collection",input:{reverse_image:true,media_id:m.id,confirm_external:true}})).body;
    let saved;for(let n=0;n<100;n++){saved=(await ana.get(`/api/tasks/${task.id}`)).body;if(["failed","completed"].includes(saved.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(saved.status,"completed",saved.error);assert.equal(saved.result.reverse_image.earliest_known.date,"2018-03-01T12:00:00.000Z");
    assert.ok(!JSON.stringify(saved).includes("test-secret"));
  } finally {if(s){s.ctx.tasks.close();await s.ctx.investigations.close();await s.close();s.ctx.db.close();}await new Promise(r=>fake.close(r));}
});
