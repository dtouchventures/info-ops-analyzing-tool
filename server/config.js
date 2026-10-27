// Runtime configuration. Everything comes from environment variables (or a .env file next to package.json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// minimal .env loader (no dependency): KEY=value lines, # comments
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile) && !process.env.AIVS_SKIP_DOTENV) {
  // the file may have been saved by Notepad or PowerShell as UTF-16 ("Unicode") or with a byte-order mark; both are read correctly
  const raw = fs.readFileSync(envFile), text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString("utf16le") : raw[0] === 0xfe && raw[1] === 0xff ? Buffer.from(raw.subarray(2)).swap16().toString("utf16le") : raw.toString("utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    const v = m ? m[2].replace(/^["']|["']$/g, "") : "";
    // an empty line (KEY=) does not hide a later line that gives the same key a value
    if (m && !line.trim().startsWith("#") && v !== "" && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const env = process.env;
const int = (v, d) => (v === undefined || v === "" ? d : parseInt(v, 10));

export const config = {
  reportTimezone: env.REPORT_TIMEZONE || 'Africa/Nairobi',
  port: int(env.PORT, 8080),
  host: env.HOST || "127.0.0.1",
  dataDir: path.resolve(ROOT, env.DATA_DIR || "data"),
  backupDir: env.BACKUP_DIR ? path.resolve(ROOT, env.BACKUP_DIR) : null,   // default: "backups" next to the data folder
  backupKeep: int(env.BACKUP_KEEP, 7),
  backupDisabled: env.BACKUP_DISABLED === "true",
  cookieSecure: env.COOKIE_SECURE === "true",
  trustProxy: env.TRUST_PROXY === "true",
  sessionHours: int(env.SESSION_HOURS, 10),
  maxUploadMb: int(env.MAX_UPLOAD_MB, 200),
  allowSelfApproval: env.ALLOW_SELF_APPROVAL === "true",
  ai: {
    provider: (env.AI_PROVIDER || "").toLowerCase(),   // "anthropic" | "openai" | "" (disabled)
    apiKey: env.AI_API_KEY || "",
    model: env.AI_MODEL || "",
    baseUrl: env.AI_BASE_URL || "",
    timeoutMs: int(env.AI_TIMEOUT_MS, 90000),
    maxImages: int(env.AI_MAX_IMAGES, 6),
    trainingOnly: env.AI_TRAINING_ONLY !== "false",    // cloud AI only for training cases unless switched off (not applied to Ollama on your own network)
    numCtx: int(env.AI_NUM_CTX, 8192),                  // Ollama context window in tokens (more = longer case material, more memory on the server)
    keepAlive: env.AI_KEEP_ALIVE || "30m",               // how long Ollama keeps the model loaded between questions
    healthTimeoutMs: int(env.AI_HEALTH_TIMEOUT_MS, 120000),
    connectTimeoutMs: int(env.AI_CONNECT_TIMEOUT_MS, 30000),   // waiting for the Ollama server to answer the model list in the health check
    allowRemote: env.AI_ALLOW_REMOTE === "true"          // Ollama on a public address is refused unless this is set
  },
  // Verify Information may retrieve public web pages; private and local addresses are always refused
  // unless this is set (only for testing against a local site).
  allowPrivateFetch: env.AIVS_ALLOW_PRIVATE_FETCH === "true",
  // requests per user (or per IP before sign-in) in each window; "heavy" covers page retrieval, uploads, analysis, AI and imports
  rateLimit: { windowMs: int(env.RATE_WINDOW_SECONDS, 300) * 1000, general: int(env.RATE_LIMIT_GENERAL, 1500), heavy: int(env.RATE_LIMIT_HEAVY, 60) },
  // evidence search services (server side only; keys are never sent to browsers)
  search: {
    factcheckKey: env.GOOGLE_FACTCHECK_API_KEY || "", factcheckBase: env.FACTCHECK_BASE_URL || "https://factchecktools.googleapis.com",
    braveKey: env.BRAVE_SEARCH_API_KEY || "", braveBase: env.BRAVE_BASE_URL || "https://api.search.brave.com",
    braveUsdPerRequest: env.BRAVE_USD_PER_REQUEST ? Number(env.BRAVE_USD_PER_REQUEST) : null, timeoutMs: int(env.SEARCH_TIMEOUT_MS, 10000),
    // free public indexes used by automatic investigations (claim keywords are sent to them); SEARCH_GDELT=false / SEARCH_WIKIPEDIA=false to switch off
    gdelt: env.SEARCH_GDELT !== "false", gdeltBase: env.GDELT_BASE_URL || "https://api.gdeltproject.org",
    wikipedia: env.SEARCH_WIKIPEDIA !== "false", wikipediaBase: env.WIKIPEDIA_BASE_URL || "https://{lang}.wikipedia.org"
  },
  // one-click automatic investigations: total time per investigation, how many run at once, and whether case content may
  // go to an AI service outside your network (off: only Ollama on your own network is used automatically)
  investigate: { timeoutMs: int(env.INVESTIGATE_TIMEOUT_S, 900) * 1000, concurrency: int(env.INVESTIGATE_CONCURRENCY, 2), allowExternalAI: env.INVESTIGATE_ALLOW_EXTERNAL_AI === "true",
    maxLinkImages: int(env.INVESTIGATE_MAX_LINK_IMAGES, 3),
    // optional AI image description: a vision model on your own Ollama server (for example qwen2.5vl:7b or llava:7b)
    visionModel: env.INVESTIGATE_VISION_MODEL || "", visionBase: env.INVESTIGATE_VISION_URL || "" },
  // optional reverse-image search for automatic investigations (images are sent to Google Cloud Vision web detection)
  mediaCheck: { visionKey: env.GOOGLE_VISION_API_KEY || "", visionBase: env.GOOGLE_VISION_BASE_URL || "https://vision.googleapis.com", timeoutMs: int(env.SEARCH_TIMEOUT_MS, 15000) },
  // social media post lookup through the platforms' public embed services (no key except Facebook/Instagram)
  social: { metaToken: env.META_OEMBED_TOKEN || "", timeoutMs: int(env.SOCIAL_TIMEOUT_MS, 10000) },
  // optional local AI for social media analysis (Ollama on this computer or an institution server; never the internet)
  ollama: { url: env.OLLAMA_URL || ((env.AI_PROVIDER || "").toLowerCase() === "ollama" ? env.AI_BASE_URL || "http://localhost:11434" : ""), model: env.OLLAMA_MODEL || ((env.AI_PROVIDER || "").toLowerCase() === "ollama" ? env.AI_MODEL || "" : ""), timeoutMs: int(env.OLLAMA_TIMEOUT_MS, 60000), batch: int(env.OLLAMA_BATCH_SIZE, 20), allowRemote: env.OLLAMA_ALLOW_REMOTE === "true" || env.AI_ALLOW_REMOTE === "true" },
  // official platform APIs for collecting public posts (server side only; leave blank to keep a collector off)
  collect: { youtubeKey: env.YOUTUBE_API_KEY || "", xBearer: env.X_BEARER_TOKEN || "", timeoutMs: int(env.COLLECT_TIMEOUT_MS, 15000), maxItems: int(env.COLLECT_MAX_ITEMS, 500), rssFeeds: env.RSS_FEEDS || "" },
  // speech-to-text: the AIVS transcription service on a server on your network (transcriber/ folder); nothing goes elsewhere
  transcribe: { url: env.TRANSCRIBE_URL || "", token: env.TRANSCRIBE_TOKEN || "", maxMb: int(env.TRANSCRIBE_MAX_MB, 500), timeoutMs: int(env.TRANSCRIBE_TIMEOUT_MS, 600000), allowRemote: env.TRANSCRIBE_ALLOW_REMOTE === "true" },
  // KDF Mention Watch: scheduled collection for active watchlists, and the X filtered stream when your X access includes it
  watch: { enabled: env.WATCH_ENABLED !== "false", tickSeconds: int(env.WATCH_TICK_SECONDS, 30), xStream: env.WATCH_X_STREAM === "true", xBackfillMinutes: Math.min(5, int(env.WATCH_X_BACKFILL_MINUTES, 0)),
    xDailyPosts: int(env.WATCH_X_DAILY_POSTS, 2000), xPostsPerRun: Math.min(500, int(env.WATCH_X_POSTS_PER_RUN, 100)), usdPerXPost: env.X_USD_PER_POST ? Number(env.X_USD_PER_POST) : 0.005,
    youtubeSearchDaily: Math.min(100, int(env.WATCH_YOUTUBE_SEARCH_DAILY, 90)), metricsRefreshMinutes: int(env.WATCH_METRICS_REFRESH_MINUTES, 60) },
  // more platforms for Mention Watch, each through its own official API (leave blank to keep a platform off)
  platforms: { redditClientId: env.REDDIT_CLIENT_ID || "", redditClientSecret: env.REDDIT_CLIENT_SECRET || "", redditUsername: env.REDDIT_USERNAME || "",
    blueskyHandle: env.BLUESKY_HANDLE || "", blueskyAppPassword: env.BLUESKY_APP_PASSWORD || "", blueskyPds: env.BLUESKY_PDS || "https://bsky.social",
    mastodonInstances: env.MASTODON_INSTANCES || "", threadsToken: env.THREADS_ACCESS_TOKEN || "", threadsDailyQueries: Math.min(2200, int(env.WATCH_THREADS_DAILY_QUERIES, 1000)),
    instagramToken: env.INSTAGRAM_ACCESS_TOKEN || "", instagramUserId: env.INSTAGRAM_USER_ID || "", graphVersion: env.META_GRAPH_VERSION || "v26.0",
    facebookToken: env.FACEBOOK_ACCESS_TOKEN || env.META_PAGE_ACCESS_TOKEN || "", facebookPages: env.FACEBOOK_PAGES || "", facebookCommentPosts: int(env.WATCH_FACEBOOK_COMMENT_POSTS, 10),
    tiktokClientKey: env.TIKTOK_CLIENT_KEY || "", tiktokClientSecret: env.TIKTOK_CLIENT_SECRET || "", tiktokDailyRequests: Math.min(1000, int(env.WATCH_TIKTOK_DAILY_REQUESTS, 500)),
    telegramToken: env.TELEGRAM_BOT_TOKEN || "", telegramOwnChannels: env.TELEGRAM_OWN_CHANNELS || "",
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN || "", whatsappAppSecret: env.WHATSAPP_APP_SECRET || "" },
  // Live monitoring (1.26): every post of the authorised Facebook Pages, collected through the Meta Graph API with a Page
  // access token kept on the server, then analysed, verified and reported automatically (server/lib/livemonitor.js)
  // automatic monitoring of the organisation's own Facebook Page is off unless LIVE_FACEBOOK_MONITORING=true (1.29); the Meta Graph
  // integration stays available for Verify Information and for later authorised use
  live: { enabled: env.LIVE_FACEBOOK_MONITORING === "true",  pageToken: env.META_PAGE_ACCESS_TOKEN || env.FACEBOOK_ACCESS_TOKEN || "", pageIds: env.META_PAGE_IDS || "",
    graphVersion: env.META_GRAPH_VERSION || "v26.0", graphBase: env.META_GRAPH_BASE_URL || "https://graph.facebook.com", appId: env.META_APP_ID || "", appSecret: env.META_APP_SECRET || "",
    intervalMinutes: Math.max(1, int(env.LIVE_MONITOR_INTERVAL_MINUTES, 5)), initialPosts: Math.min(100, int(env.LIVE_MONITOR_INITIAL_POSTS, 25)), maxPagesPerSync: Math.min(20, int(env.LIVE_MONITOR_MAX_PAGES, 5)),
    autoAnalyse: env.LIVE_AUTO_ANALYSE !== "false", analyseConcurrency: Math.max(1, int(env.LIVE_ANALYSE_CONCURRENCY, 1)), storeImages: env.LIVE_STORE_IMAGES !== "false",
    engagementRefreshMinutes: int(env.LIVE_ENGAGEMENT_REFRESH_MINUTES, 30), timeoutMs: int(env.LIVE_TIMEOUT_MS, 20000), tickSeconds: int(env.LIVE_TICK_SECONDS, 30),
    // Instagram stays "Not connected" until a connection test with these settings has succeeded
    igUserId: env.INSTAGRAM_USER_ID || "", igToken: env.INSTAGRAM_ACCESS_TOKEN || env.META_PAGE_ACCESS_TOKEN || "" },
  isTest: env.NODE_ENV === "test"
};
