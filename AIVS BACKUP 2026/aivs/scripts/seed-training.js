// Load the labelled synthetic training cases and archive records (safe to run once).
import { config } from "../server/config.js";
import { createApp } from "../server/app.js";
import { seedTraining } from "../server/lib/training.js";
const { ctx } = createApp(config);
const admin = ctx.db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
if (!admin) { console.error("Start the server once first so the administrator account exists."); process.exit(1); }
console.log((await seedTraining(ctx, admin)).message);
