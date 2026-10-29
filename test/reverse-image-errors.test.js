import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {makeReverseImageSearch,lensHasNoMatches} from '../server/lib/reverse-image.js';
import {reverseImageHtml} from '../public/js/lib/reverseview.js';
const noResults={search_metadata:{status:'Success'},error:"Google Lens hasn't returned any results for this query."};
test('only a successful explicit Lens no-result response is treated as no matches',()=>{
  assert.equal(lensHasNoMatches(true,noResults),true);
  for(const j of [{...noResults,search_metadata:{status:'Error'}},{...noResults,exact_matches:[{link:'https://example.org'}]},{error:noResults.error},{search_metadata:{status:'Success'},error:'Your quota is exhausted.'}]) assert.equal(lensHasNoMatches(true,j),false);
  assert.equal(lensHasNoMatches(false,noResults),false);
});
test('Lens no-results complete safely; access, quota, bad replies and timeouts remain failures without keys',async()=>{
 let mode='none';const image=fs.readFileSync('training/images/case_convoy.jpg');
 const server=http.createServer(async(req,res)=>{
  for await(const chunk of req){}
  if(req.url==='/image'){res.setHeader('content-type','application/json');res.end(JSON.stringify({image_id:'uploaded'}));return;}
  if(mode==='slow'){setTimeout(()=>{if(!res.destroyed)res.end(JSON.stringify({search_metadata:{status:'Success'},exact_matches:[]}));},1500);return;}
  if(mode==='access'||mode==='limit'||mode==='provider'){res.statusCode=mode==='access'?401:mode==='limit'?429:503;res.end('private-test-key must not appear in errors');return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(mode==='none'?noResults:mode==='empty'?{search_metadata:{status:'Success'},exact_matches:[]}:mode==='invalid'?{}:{search_metadata:{status:'Error'},error:'private-test-key error'}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const search=makeReverseImageSearch({mediaCheck:{provider:'serpapi',serpapiKey:'private-test-key',serpapiBase:'http://127.0.0.1:'+server.address().port,serpapiTimeoutMs:1000}});
 try{
  for(mode of ['none','empty']){const r=await search.search(image);assert.equal(r.status,'completed');assert.deepEqual(r.pages,[]);assert.equal(r.earliest_known,null);assert.match(reverseImageHtml(r),/No matches were returned/);assert.doesNotMatch(reverseImageHtml(r),/search failed/);}
  for(const [m,expected]of [['access',/rejected the key or account access/],['limit',/account or rate limit/],['provider',/temporarily unavailable/],['invalid',/search failed/],['error',/search failed/],['slow',/search timeout/]]){mode=m;await assert.rejects(search.search(image),e=>{assert.match(e.message,expected);assert.ok(!e.message.includes('private-test-key'));assert.match(e.message,/No conclusion about earlier postings/);return true;});}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
