// A SYNTHETIC dataset for demonstrating and testing the AI Watchlist: exactly 1,000 invented public posts about an
// election over seven days, with three planted patterns whose times are known, so every alert can be checked
// against the records that caused it:
//   1. an unusual rise: from 14:00 UTC on day 6, about 70 posts in two hours claim ballot boxes were burned in a
//      named place (a new narrative that barely appears earlier);
//   2. synchronised near-identical posts: at 10:00 UTC on day 5, 12 new accounts post the same call to share
//      within 6 minutes, with the same hashtag and link;
//   3. steady background discussion (registration, queues, results, unrelated sport and weather) at a normal rate.
// Accounts, places, links and quotes are invented. Deterministic: the same seed gives the same posts.
const BACKGROUND = [
  ["Voter registration closes on Friday, check your status on the IEBC portal", "en"], ["Long queues at the polling station this morning but people are patient", "en"],
  ["The ballot papers in our ward were delivered on time, officials say", "en"], ["Who is ready for the debate tonight? Election questions on jobs and fees", "en"],
  ["IEBC says tallying will be streamed live from the national centre", "en"], ["Our county election officers are training clerks this week", "en"],
  ["Remember to carry your ID card when you go to vote", "en"], ["Kura yako ni sauti yako, jitokeze kupiga kura", "sw"], ["Foleni ni ndefu lakini watu wametulia kituoni", "sw"],
  ["Matokeo ya uchaguzi yatatangazwa na IEBC pekee", "sw"], ["The voting process in our village was calm and orderly", "en"], ["Observers praised the voting arrangements in the county", "en"],
  ["I hope the election results are announced quickly and fairly", "en"], ["Turnout looks lower than last time in our polling centre", "en"], ["Ballot boxes were sealed in front of agents, all parties present", "en"],
  ["Football: great match last night, the league is getting exciting", "en"], ["Rain expected in the afternoon, carry an umbrella", "en"], ["Fuel prices went up again this week", "en"]
];
const PLACES = ["Kiwanja", "Mlima Ward", "Ziwa Centre", "Sokoni", "Bondeni"];
const SPIKE = ["Ballot boxes burned in {p} last night, the election is being stolen!", "Breaking: ballot boxes burned at {p} polling centre, share widely", "They burned ballot boxes in {p}, IEBC is hiding it",
  "Video shows ballot boxes burned in {p}, why is nobody talking about this", "Masanduku ya kura yamechomwa {p}, uchaguzi umeibiwa", "Ballot boxes burned in {p}? I want IEBC to explain"];
const SYNC = "URGENT: IEBC officials caught changing results in {p}. Share before they delete this! #ElectionTruth https://example.invalid/synthetic-results";

export function watchDemoRows({ seed = 7, start = "2026-10-01T00:00:00Z" } = {}) {
  let s = seed >>> 0; const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296), pick = a => a[Math.floor(rand() * a.length)];
  const t0 = Date.parse(start), rows = [], acc = n => `voter_${String(n).padStart(3, "0")}`;
  // background: about 5 posts an hour for 7 days, busier in the day
  for (let h = 0; h < 7 * 24; h++) {
    const hour = h % 24, n = hour >= 7 && hour <= 21 ? 7 + Math.floor(rand() * 5) : Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const [text, lang] = pick(BACKGROUND), t = t0 + h * 3600e3 + Math.floor(rand() * 3600e3);
      rows.push({ account: acc(1 + Math.floor(rand() * 400)), posted_at: new Date(t).toISOString(), text: rand() < 0.15 ? `${text} #Election2026` : text, language: lang, platform: pick(["X", "Facebook", "TikTok"]), likes: Math.floor(rand() * 40) });
    }
  }
  while (rows.length > 915) rows.splice(Math.floor(rand() * rows.length), 1);   // exactly 1,000 posts with the 85 planted ones
  // a few earlier mentions of the burned-boxes story (so the rise is a rise, not a first sighting)
  for (let i = 0; i < 3; i++) rows.push({ account: acc(500 + i), posted_at: new Date(t0 + (2 + i) * 864e5 + 12 * 3600e3).toISOString(), text: pick(SPIKE).replace("{p}", pick(PLACES)), language: "en", platform: "X", likes: 3 });
  // planted 2: 12 new accounts, same text within 6 minutes on day 5 at 10:00
  const sync = t0 + 4 * 864e5 + 10 * 3600e3;
  for (let i = 0; i < 12; i++) rows.push({ account: `truth_teller_${String(i + 1).padStart(2, "0")}`, posted_at: new Date(sync + Math.floor((i / 12) * 6 * 60e3)).toISOString(), text: SYNC.replace("{p}", "Sokoni"), language: "en", platform: "X", likes: 1, account_created_at: new Date(sync - 2 * 864e5).toISOString() });
  // planted 1: the rise on day 6 from 14:00, about 70 posts in two hours
  const spike = t0 + 5 * 864e5 + 14 * 3600e3;
  for (let i = 0; i < 70; i++) rows.push({ account: acc(600 + Math.floor(rand() * 300)), posted_at: new Date(spike + Math.floor(rand() * 2 * 3600e3)).toISOString(), text: pick(SPIKE).replace("{p}", pick(PLACES)), language: "en", platform: pick(["X", "Facebook"]), likes: Math.floor(rand() * 200) });
  rows.sort((a, b) => a.posted_at.localeCompare(b.posted_at));
  return rows.map((r, i) => ({ ...r, post_id: `syn-${seed}-${i + 1}` }));
}
export const WATCH_DEMO = {
  name: "SYNTHETIC: election discussion with planted patterns (AI Watchlist demo)",
  description: "1,000 invented public posts over 7 days. Planted: an unusual rise of a 'ballot boxes burned' narrative on day 6 from 14:00 UTC, and 12 new accounts posting the same call to share within 6 minutes on day 5 at 10:00 UTC. Everything else is ordinary background discussion.",
  source: "Generated by AIVS (server/lib/watch-demo.js), seed 7", authorisation: "Synthetic data created for training and demonstration; no real people or posts"
};
