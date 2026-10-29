import { fetchPage } from './fetchurl.js';

export const isKdfTopic = q => /\b(kdf|kenya defence forces|kenya defense forces|kenya army|kenya navy|kenya air force|military recruitment)\b/i.test(q);
export function isKdfOfficial(url) {
  try {
    const u = new URL(url), h = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.protocol === 'https:' && !u.username && !u.password && (h === 'mod.go.ke' || h.endsWith('.mod.go.ke') ||
      (['x.com', 'twitter.com'].includes(h) && /^\/kdfinfo(?:\/|$)/i.test(u.pathname)) ||
      (h === 'facebook.com' && /^\/OfficialKDF(?:\/|$)/i.test(u.pathname)));
  } catch { return false; }
}
const clean = x => String(x || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
export function officialFeed(xml) {
  const read = (item, tag) => clean(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(item)?.[1]);
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 12).map(m => {
    const url = read(m[1], 'link'), date = read(m[1], 'pubDate');
    return { url, title: read(m[1], 'title'), snippet: read(m[1], 'description').slice(0, 1600), published_at: date && !isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
      publisher: 'Kenya Ministry of Defence / KDF', official: 'Kenya Ministry of Defence / KDF' };
  }).filter(r => isKdfOfficial(r.url));
}
export function makeKdfOfficial(config, { page = fetchPage, json = async url => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Official-source search service failed.');
  const j = await r.json(); if (j.error) throw new Error('Official-source search service failed.'); return j;
} } = {}) {
  return async q => {
    if (!isKdfTopic(q)) q = `Kenya Defence Forces ${q}`;
    const topic = /recruit|cadet|enlist|vacanc/i.test(q) ? 'recruitment' : q.split(/\s+/).slice(0, 7).join(' ');
    const url = new URL('https://www.mod.go.ke/'); url.searchParams.set('s', topic); url.searchParams.set('feed', 'rss2');
    const results = [], errors = [];
    const feeds = [url];
    if (topic === 'recruitment') { const warnings = new URL(url); warnings.searchParams.set('s', 'fake recruitment'); feeds.push(warnings); }
    await Promise.all(feeds.map(async feed => {
      try { const r = await page(feed.href, { allowXml: true }); if (!isKdfOfficial(r.finalUrl || feed.href)) throw new Error('Unexpected official-site redirect.'); if (!r.xml) throw new Error('Official site did not return its search feed.'); results.push(...officialFeed(r.xml)); } catch { errors.push('An official Ministry of Defence search feed could not be read.'); }
    }));
    if (config.mediaCheck?.serpapiKey) {
      // Search the website and official accounts separately so website results cannot crowd out social posts.
      await Promise.all(['site:mod.go.ke', '(site:x.com/kdfinfo OR site:facebook.com/OfficialKDF)'].map(async scope => {
        try {
          const u = new URL('https://serpapi.com/search.json'); u.searchParams.set('engine', 'google');
          u.searchParams.set('q', `${q} ${scope}`); u.searchParams.set('num', '8'); u.searchParams.set('api_key', config.mediaCheck.serpapiKey);
          const j = await json(u); results.push(...(j.organic_results || []).filter(r => isKdfOfficial(r.link)).map(r => ({ url: r.link, title: clean(r.title), snippet: clean(r.snippet), published_at: null, publisher: 'KDF official channel (indexed result)', official: 'KDF official channel' })));
        } catch { errors.push('An indexed official KDF channel search could not be completed.'); }
      }));
    }
    // Never convert an inaccessible official source into a successful no-match search.
    if (errors.length && !results.length) throw new Error(errors.join(' '));
    const byUrl = new Map();
    for (const r of results) { const previous = byUrl.get(r.url); byUrl.set(r.url, previous ? { ...r, published_at: previous.published_at || r.published_at } : r); }
    const unique = [...byUrl.values()], year = /\b20\d{2}\b/.exec(q)?.[0] || String(new Date().getUTCFullYear());
    const score = r => Number(topic === 'recruitment' && /recruit|cadet|vacanc/i.test(r.title)) * 3 + Number(r.published_at?.startsWith(year)) * 4;
    unique.sort((a,b) => score(b) - score(a));
    const social = unique.filter(r => !new URL(r.url).hostname.endsWith('mod.go.ke')).slice(0, 2);
    const selected = [...social, ...unique.filter(r => !social.includes(r))].slice(0, 8);
    const found = selected.map(r => ({ ...r, snippet: `${r.snippet}${errors.length ? ' Coverage incomplete: ' + [...new Set(errors)].join(' ') : ''}` }));
    found.coverage_errors = [...new Set(errors)];
    found.coverage = { website: errors.some(e => /feed/.test(e)) ? 'incomplete' : 'searched', social: !config.mediaCheck?.serpapiKey ? 'not_configured' : errors.some(e => /indexed/.test(e)) ? 'incomplete' : 'searched', social_matches: unique.filter(r => !new URL(r.url).hostname.endsWith('mod.go.ke')).length };
    return found;
  };
}
