// Runtime configuration. Everything comes from environment variables (or a .env file next to package.json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// minimal .env loader (no dependency): KEY=value lines, # comments
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile) && !process.env.AIVS_SKIP_DOTENV) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = process.env;
const int = (v, d) => (v === undefined || v === "" ? d : parseInt(v, 10));

export const config = {
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
    braveUsdPerRequest: env.BRAVE_USD_PER_REQUEST ? Number(env.BRAVE_USD_PER_REQUEST) : null, timeoutMs: int(env.SEARCH_TIMEOUT_MS, 10000)
  },
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
    facebookToken: env.FACEBOOK_ACCESS_TOKEN || "", facebookPages: env.FACEBOOK_PAGES || "", facebookCommentPosts: int(env.WATCH_FACEBOOK_COMMENT_POSTS, 10),
    tiktokClientKey: env.TIKTOK_CLIENT_KEY || "", tiktokClientSecret: env.TIKTOK_CLIENT_SECRET || "", tiktokDailyRequests: Math.min(1000, int(env.WATCH_TIKTOK_DAILY_REQUESTS, 500)),
    telegramToken: env.TELEGRAM_BOT_TOKEN || "", telegramOwnChannels: env.TELEGRAM_OWN_CHANNELS || "",
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN || "", whatsappAppSecret: env.WHATSAPP_APP_SECRET || "" },
  isTest: env.NODE_ENV === "test"
};
