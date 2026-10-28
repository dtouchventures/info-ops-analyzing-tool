import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import sharp from "sharp";
import { startServer, login } from "./helpers.js";

test("weak OCR automatically uses local vision and keeps recovered words unverified", async () => {
  let readings = 0;
  const fake = http.createServer(async (req, res) => {
    const chunks=[]; for await (const c of req) chunks.push(c);
    const input=JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("content-type","application/json");
    if (req.url==="/api/show") return res.end(JSON.stringify({capabilities:["vision"]}));
    if (req.url==="/api/chat") {
      readings++; assert.ok(input.messages[0].images.length);
      assert.match(input.messages[0].content,/visible_text/);
      return res.end(JSON.stringify({message:{content:JSON.stringify({description:"A public notice.",visible_text:"The public meeting starts tomorrow at noon.",consistent:"unclear"})}}));
    }
    res.statusCode=404;res.end("{}");
  });
  await new Promise(r=>fake.listen(0,"127.0.0.1",r));
  const s=await startServer({investigate:{visionModel:"test-vision",visionBase:`http://127.0.0.1:${fake.address().port}`}});
  try {
    const api=await login(s.base,"ana");
    const image=await sharp({create:{width:160,height:120,channels:3,background:"white"}}).png().toBuffer();
    const form=new FormData();form.append("files",new Blob([image]),"noisy.png");
    const inv=(await api.post("/api/investigations",undefined,{form})).body;
    let result;
    for(let n=0;n<600;n++) {const r=(await api.get(`/api/investigations/${inv.id}`)).body;if(["done","failed"].includes(r.status)){result=r;break;}await new Promise(r=>setTimeout(r,100));}
    assert.equal(result?.status,"done",result?.error);
    assert.match(result.result.content,/public meeting starts/);
    assert.ok(result.result.source.notes.some(n=>/AI-transcribed words remain unverified/.test(n)));
    assert.ok(result.result.media.images[0].observations.some(o=>o.strength==="ai"));
    assert.equal(readings,1,"reuse the automatic visual reading rather than sending the image twice");
  } finally {await s.ctx.investigations.close();s.ctx.tasks.close();await s.close();s.ctx.db.close();await new Promise(r=>fake.close(r));}
});
