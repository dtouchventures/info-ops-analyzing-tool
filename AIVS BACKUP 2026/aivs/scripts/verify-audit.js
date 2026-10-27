import path from "node:path";
import { config } from "../server/config.js";
import { openDb } from "../server/lib/db.js";
import { verifyChain } from "../server/lib/audit.js";
const r = verifyChain(openDb(path.join(config.dataDir, "aivs.db")));
console.log(r.ok ? `Audit log intact: ${r.checked} entries verified.` : `AUDIT LOG BROKEN at entry ${r.brokenAt} (after ${r.checked} valid entries).`);
process.exit(r.ok ? 0 : 2);
