// Turn the token in .env into the token AIVS needs, and save it back into .env. The token is never printed.
//   - a person's token (someone who manages the Page): with META_APP_ID and META_APP_SECRET it is first extended to a
//     long-lived token; then Meta is asked for the Page's own token, which is saved as META_PAGE_ACCESS_TOKEN. A Page
//     token obtained from a long-lived user token does not expire.
//   - with several Pages in META_PAGE_IDS, the (long-lived) person's token is saved instead; AIVS then asks Meta for each
//     Page's token itself while it runs.
// Usage: put the token from Graph API Explorer in .env as META_PAGE_ACCESS_TOKEN, then run  npm run meta:token
import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "../server/config.js";
import { makeGraph } from "../server/lib/meta-graph.js";

const L = config.live, pages = String(L.pageIds || "").split(/[\s,;]+/).filter(Boolean), envFile = path.join(ROOT, ".env");
const say = s => console.log(s);
if (!L.pageToken || !pages.length) { say("Set META_PAGE_ACCESS_TOKEN (the token from Graph API Explorer) and META_PAGE_IDS in .env first."); process.exit(2); }
const G = t => makeGraph({ token: t, version: L.graphVersion, base: L.graphBase, appId: L.appId, appSecret: L.appSecret, timeoutMs: L.timeoutMs });
const save = (tok, what) => {
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter(l => !/^\s*META_PAGE_ACCESS_TOKEN\s*=/.test(l));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`META_PAGE_ACCESS_TOKEN=${tok}`, "");
  fs.writeFileSync(envFile, lines.join("\r\n"));
  say(`Saved in .env: ${what}. Restart AIVS (Ctrl+C, then npm start) so it uses it.`);
};
try {
  let g = G(L.pageToken);
  const me = await g.get("me", { fields: "id,name" });
  if (pages.includes(me.id)) { say(`The token in .env is already the Page token of “${me.name}” (${me.id}). Nothing to change.`);
    if (L.appId && L.appSecret) { const v = await g.validate(); say(`Expiry: ${v.expires_at || "not reported"}.`); } else say("Set META_APP_ID and META_APP_SECRET to see when it expires.");
    process.exit(0); }
  say(`The token in .env belongs to the person “${me.name}”. Getting the Page's own token…`);
  let user = L.pageToken, long = false;
  if (L.appId && L.appSecret) { try { const x = await g.longLived(); user = x.token; long = true; say(`Extended to a long-lived token${x.expires_in ? ` (about ${Math.round(x.expires_in / 86400)} days)` : ""}.`); } catch (e) { say(`Could not extend the token: ${g.redact(e.message)}`); } }
  else say("META_APP_ID and META_APP_SECRET are not set, so the token cannot be extended: the result will expire like the token from Graph API Explorer (usually within hours).");
  g = G(user);
  if (pages.length > 1) { save(user, `${long ? "the long-lived" : "the"} token of ${me.name}; AIVS asks Meta for each Page's token while it runs`); process.exit(0); }
  const pt = await g.pageToken(pages[0]);
  if (!pt.token) { say(`Meta did not give the Page token for ${pages[0]}. ${me.name} must manage the Page, and the token needs the permissions pages_show_list and pages_read_engagement (tick them in Graph API Explorer, then Generate Access Token).`); process.exit(1); }
  const check = await G(pt.token).get("me", { fields: "id,name" });
  if (check.id !== pages[0]) { say(`Unexpected: the token Meta returned belongs to ${check.name} (${check.id}). Nothing was saved.`); process.exit(1); }
  save(pt.token, `the Page token of “${check.name}” (${check.id})${long ? ", which does not expire" : ", which expires when the Explorer token does"}`);
} catch (e) { say(`Meta refused: ${G(L.pageToken).redact(e.message)}`); process.exit(1); }
