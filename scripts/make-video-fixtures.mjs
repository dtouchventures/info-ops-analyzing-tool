// Generates the SYNTHETIC sample videos used by test/videocheck.test.js (AIVS 1.35). Each scene is an invented "photograph" (a random
// texture) with a caption labelled TEST FIXTURE, rendered with Playwright and assembled into video with FFmpeg. They show no real
// people, places or events. Usage: node scripts/make-video-fixtures.mjs   (needs FFmpeg: system PATH or the bundled package)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import sharp from "sharp";
import { videoTools } from "../server/lib/videocheck.js";

const OUT = path.resolve("test/fixtures/video"); fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(OUT, ".tmp-"));
const ff = videoTools({}).ffmpeg?.path; if (!ff) throw new Error("FFmpeg is needed");
const run = args => { const r = spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
const scene = (seed, hue, caption) => `<html><body style="margin:0;width:960px;height:540px;overflow:hidden;font-family:Arial">
  <svg width="960" height="540" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="5" seed="${seed}"/><feColorMatrix values="${hue}"/></filter><rect width="960" height="540" filter="url(#n)"/>
  <rect x="${(seed * 37) % 600 + 60}" y="${(seed * 53) % 260 + 60}" width="260" height="120" fill="rgba(20,20,20,.55)"/><circle cx="${(seed * 71) % 700 + 120}" cy="${(seed * 29) % 300 + 140}" r="70" fill="rgba(255,255,255,.35)"/></svg>
  ${caption ? `<div style="position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.72);color:#fff;font-size:34px;font-weight:bold;padding:14px 22px">${caption}</div>` : ""}</body></html>`;
const H = { green: "0.3 0.5 0.1 0 0.05  0.2 0.7 0.1 0 0.1  0.1 0.3 0.3 0 0.05  0 0 0 0 1", sand: "0.8 0.3 0.1 0 0.1  0.6 0.4 0.1 0 0.08  0.3 0.2 0.2 0 0.02  0 0 0 0 1", blue: "0.2 0.2 0.3 0 0.05  0.2 0.4 0.4 0 0.1  0.3 0.5 0.7 0 0.15  0 0 0 0 1", grey: "0.4 0.4 0.2 0 0.1  0.4 0.4 0.2 0 0.1  0.4 0.4 0.2 0 0.1  0 0 0 0 1" };
const scenes = { A: [3, H.green, "TEST FIXTURE · Garissa · 14 October 2019"], B: [9, H.sand, "TEST FIXTURE · KDF CONVOY"], C: [21, H.grey, ""], D: [33, H.blue, "TEST FIXTURE · Lamu"], E: [47, H.sand, ""] };
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), page = await browser.newPage({ viewport: { width: 960, height: 540 } });
for (const [k, [seed, hue, cap]] of Object.entries(scenes)) { await page.setContent(scene(seed, hue, cap)); await page.screenshot({ path: path.join(TMP, `${k}.png`) }); }
await browser.close();
// a scene as 3 s of video with a slow zoom (so that consecutive frames differ slightly, as in real footage)
const clip = (k, out) => run(["-loop", "1", "-i", path.join(TMP, `${k}.png`), "-vf", "zoompan=z='min(zoom+0.0008,1.05)':d=75:s=960x540:fps=25,format=yuv420p", "-t", "3", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", out]);
for (const k of Object.keys(scenes)) clip(k, path.join(TMP, `${k}.mp4`));
const concat = (keys, list) => { fs.writeFileSync(list, keys.map(k => `file '${path.join(TMP, `${k}.mp4`)}'`).join("\n")); };
// 1. "recycled" footage: scenes A, B, C with a sound track (a tone; speech is supplied by the test's transcription stand-in)
concat(["A", "B", "C"], path.join(TMP, "abc.txt"));
run(["-f", "concat", "-safe", "0", "-i", path.join(TMP, "abc.txt"), "-f", "lavfi", "-i", "sine=frequency=440:duration=9", "-c:v", "copy", "-c:a", "aac", "-b:a", "48k", "-shortest", "-movflags", "+faststart", path.join(OUT, "recycled-convoy.mp4")]);
// 2. the same footage as AVI (MPEG-4 Part 2), as a second upload of the same video in another format
run(["-i", path.join(OUT, "recycled-convoy.mp4"), "-c:v", "mpeg4", "-q:v", "6", "-c:a", "mp3", "-b:a", "64k", path.join(OUT, "recycled-convoy.avi")]);
// 3. other footage as MOV, no sound
concat(["D", "E"], path.join(TMP, "de.txt"));
run(["-f", "concat", "-safe", "0", "-i", path.join(TMP, "de.txt"), "-c:v", "copy", "-an", "-f", "mov", path.join(OUT, "fresh-lamu.mov")]);
// 4. an "earlier published copy" of scene A, as a web page would show it: smaller and recompressed; and an unrelated picture
await sharp(path.join(TMP, "A.png")).resize(640, 360).jpeg({ quality: 70 }).toFile(path.join(OUT, "earlier-copy-scene-a.jpg"));
await sharp(path.join(TMP, "E.png")).resize(640, 360).jpeg({ quality: 70 }).toFile(path.join(OUT, "unrelated-scene-e.jpg"));
fs.rmSync(TMP, { recursive: true, force: true });
for (const f of fs.readdirSync(OUT)) console.log(f, fs.statSync(path.join(OUT, f)).size);
