import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startServer, login } from "./helpers.js";
import { providers } from "../server/ai/providers.js";
import { describeWithGemini } from "../server/lib/gemini-images.js";

test("optional Gemini images: consent, metadata stripping, results, failures and private status", async () => {
  const original = providers.gemini.complete;
  let calls = 0, fail = false;
  providers.gemini.complete = async (cfg, input) => {
    calls++;
    assert.equal(cfg.apiKey, "test-server-secret");
    assert.equal(input.images.length, 1);
    const md = await sharp(Buffer.from(input.images[0].base64, "base64")).metadata();
    assert.ok(md.width <= 1600 && md.height <= 1600);
    assert.ok(!md.exif && !md.xmp, "metadata must not leave the server");
    if (fail) throw new Error("quota error containing test-server-secret");
    return { text: JSON.stringify({ description: "A teal rectangle.", visible_text: "" }) };
  };
  const s = await startServer({ geminiImages: { apiKey: "test-server-secret", model: "test-image-model" } });
  try {
    const client = await login(s.base, "ana");
    const status = await client.get("/api/gemini-images/status");
    assert.deepEqual(status.body, { configured: true, model: "test-image-model" });
    assert.equal((await fetch(s.base + "/api/gemini-images/status")).status, 401);
    const image = await sharp({ create: { width: 2200, height: 100, channels: 3, background: "#137c84" } }).withMetadata().png().toBuffer();
    async function submit(consent) {
      const form = new FormData();
      form.append("files", new Blob([image], { type: "image/png" }), "public-shape.png");
      form.append("request_key", crypto.randomUUID());
      if (consent) form.append("gemini_public_images", "true");
      const response = await client.post("/api/investigations", undefined, { form });
      assert.equal(response.status, 202);
      for (let n = 0; n < 600; n++) {
        const r = (await client.get(`/api/investigations/${response.body.id}`)).body;
        if (["done", "failed"].includes(r.status)) { assert.equal(r.status, "done", r.error); return r; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Investigation timed out");
    }
    const local = await submit(false);
    assert.equal(calls, 0, "no external call without per-submission consent");
    assert.equal(local.input.gemini_public_images, false);
    const opted = await submit(true);
    assert.equal(calls, 1);
    assert.equal(opted.input.gemini_public_images, true);
    assert.ok(opted.result.media.images[0].observations.some(x => x.strength === "ai" && x.text.includes("Google Gemini")));
    fail = true;
    const failed = await submit(true);
    assert.equal(calls, 2);
    assert.match(failed.result.media.images[0].gemini.error, /Local checks continue/);
    assert.ok(!JSON.stringify(failed).includes("test-server-secret"));
    await assert.rejects(describeWithGemini({}, image), /not configured/);
  } finally {
    providers.gemini.complete = original;
    await s.ctx.investigations.close(); s.ctx.tasks.close(); await s.close(); s.ctx.db.close();
  }
});

test('Gemini accepts a single wrapped image result and rejects ambiguous or invalid responses',async()=>{
  const original=providers.gemini.complete;
  const cfg={geminiImages:{apiKey:'secret',model:'test'}};
  const image=await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toBuffer();
  try {
    providers.gemini.complete=async()=>({text:JSON.stringify([{description:'One test image.',visible_text:'TEST'}])});
    assert.equal((await describeWithGemini(cfg,image)).visible_text,'TEST');
    for(const value of [[],[{description:'First'},{description:'Second'}],null,{description:''}]) {
      providers.gemini.complete=async()=>({text:JSON.stringify(value)});
      await assert.rejects(describeWithGemini(cfg,image),/Local checks continue/);
    }
  } finally {providers.gemini.complete=original;}
});
