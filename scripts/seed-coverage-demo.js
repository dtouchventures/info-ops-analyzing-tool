// Load the labelled synthetic demonstration case for the Evidence coverage view (safe to run more than once).
import { config } from "../server/config.js";
import { createApp } from "../server/app.js";
import { seedCoverageDemo } from "../server/lib/training.js";
const { ctx } = createApp(config);
const admin = ctx.db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
if (!admin) { console.error("Start the server once first so the administrator account exists."); process.exit(1); }
const r = await seedCoverageDemo(ctx, admin);
console.log(r.message);
console.log("Open it in AIVS: switch the records toggle (top right) to Training, open the case, then the Evidence coverage tab.");
