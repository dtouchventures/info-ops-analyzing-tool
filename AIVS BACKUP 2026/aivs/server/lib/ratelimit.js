// Fixed-window rate limiting per signed-in user (or per IP address before sign-in). In memory, so it applies
// per server process; put a reverse proxy limit in front for multi-server deployments.
import { HttpError } from "./auth.js";
export function makeLimiter({ windowMs, limit, name }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, Math.min(windowMs, 60000)).unref();
  return (req, res, next) => {
    const key = req.user ? `u${req.user.id}` : `ip${req.ip}`, now = Date.now();
    let h = hits.get(key); if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    res.setHeader(`X-RateLimit-${name}-Remaining`, Math.max(0, limit - h.n));
    if (h.n > limit) { res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000)); return next(new HttpError(429, `Too many ${name === "Heavy" ? "uploads, retrievals or analyses" : "requests"} in a short time. Wait ${Math.ceil((h.reset - now) / 60000)} minute(s) and try again.`)); }
    next();
  };
}
