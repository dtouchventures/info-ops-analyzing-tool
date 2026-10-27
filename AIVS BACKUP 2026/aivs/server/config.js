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
    trainingOnly: env.AI_TRAINING_ONLY !== "false"     // AI only for training cases unless explicitly switched off
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
  isTest: env.NODE_ENV === "test"
};
