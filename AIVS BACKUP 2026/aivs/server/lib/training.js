// Synthetic training material: separate IDs (TR-, TA-), flagged is_training, never matched against real
// cases or the real archive, and excluded from real dashboards and reports.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { nowISO } from "./db.js";

const T = path.join(ROOT, "training", "images");
const ARCHIVE = [
  { file: "archive_convoy.jpg", title: "Supply convoy crossing a flooded track (SYNTHETIC)", date: "2018-10-14", type: "original",
    description: "SYNTHETIC TRAINING RECORD. Documented as a routine convoy crossing during seasonal rains; all vehicles completed the crossing.", ref: "Training dataset · record convoy-2018" },
  { file: "archive_notice.jpg", title: "Counterfeit ‘national call-up’ notice (SYNTHETIC)", date: "2024-05-12", type: "misleading",
    description: "SYNTHETIC TRAINING RECORD. Fabricated notice template previously assessed as misleading; its printed date reads 14 October 1968.", ref: "Training dataset · prior report TRN-VR-0112" }
];
const CASES = [
  { file: "case_convoy.jpg", title: "Training 1 · Flooded convoy photo", claim_text: "BREAKING: Several KDF supply trucks were abandoned in floodwater along the Garissa-Modika road last night after flash floods. Soldiers were forced to retreat on foot.", source_platform: "X (Twitter) — synthetic example", priority: "urgent" },
  { file: "case_notice.jpg", title: "Training 2 · Recruitment notice", claim_text: "URGENT PUBLIC NOTICE: The Ministry of Defence has opened recruitment this month. Applicants must pay a Sh5,000 processing fee via M-Pesa before registration.", source_platform: "WhatsApp forward — synthetic example", priority: "priority" },
  { file: "case_patrol.jpg", title: "Training 3 · Patrol photo", claim_text: "KDF troops conducted a routine reassurance patrol near the Sector 3 outpost this morning. The area remains calm.", source_platform: "Facebook repost — synthetic example", priority: "routine" }
];

export async function seedTraining({ db, media, cases, storage, audit }, user) {
  if (db.prepare("SELECT COUNT(*) n FROM cases WHERE is_training = 1").get().n) return { created: false, message: "Training cases already exist." };
  const tmp = f => { const t = path.join(storage.tmpDir, `seed-${Date.now()}-${f}`); fs.copyFileSync(path.join(T, f), t); return t; };
  const nextA = () => `TA-${String(db.prepare("INSERT INTO counters(name,value) VALUES ('archive-training',1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get().value).padStart(4, "0")}`;
  for (const a of ARCHIVE) {
    const id = nextA(), now = nowISO();
    db.prepare("INSERT INTO archive_records(id,is_training,title,description,documented_date,record_type,source_ref,created_by,created_at,updated_at) VALUES (?,1,?,?,?,?,?,?,?,?)").run(id, a.title, a.description, a.date, a.type, a.ref, user.id, now, now);
    await media.ingest(tmp(a.file), { name: a.file, archiveId: id, isTraining: 1, user });
    db.prepare("INSERT INTO archive_history(archive_id,at,user_id,action,details) VALUES (?,?,?,?,?)").run(id, now, user.id, "Created (training seed)", null);
  }
  const received = new Date(Date.now() - 2 * 3600e3).toISOString(), ids = [];
  for (const c of CASES) {
    const id = cases.create(user, { ...c, received_at: received, is_training: 1 });
    await media.ingest(tmp(c.file), { name: c.file, caseId: id, isTraining: 1, user });
    ids.push(id);
  }
  audit(user, "Training material loaded", "settings", "training", { cases: ids });
  return { created: true, cases: ids, message: `Loaded ${ids.length} training cases and ${ARCHIVE.length} training archive records.` };
}
