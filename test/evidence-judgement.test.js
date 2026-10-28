import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceJudgement, checkAiSections } from "../server/lib/ioassessment.js";

const report = () => ({ overall: { verdict: "supported", strength: "strong" }, claims: [{ id: "c1", text: "The road reopened." }], assessments: [{ verdict: "supported", strength: "strong" }], evidence: [
  { claim_id: "c1", stance: "supports", page_read: true, tier: "official", source_url: "https://agency.example/notice" },
  { claim_id: "c1", stance: "supports", page_read: true, tier: "news", source_url: "https://news.example/report" }
] });

test("likelihood follows substantive evidence and corroboration, not confidence alone", () => {
  const r = report();
  assert.match(evidenceJudgement(r), /^It is highly likely/);
  r.evidence[1].repeat_of = "first";
  assert.match(evidenceJudgement(r), /^It is likely/);
  r.evidence[0].page_read = false;
  assert.match(evidenceJudgement(r), /^Insufficient evidence to assess/);
});
test("conflicting, weak, uncheckable and uncovered claims do not receive likelihood guesses", () => {
  for (const verdict of ["mixed", "insufficient", "not_verifiable", "extraction_blocked"]) {
    const r = report(); r.overall.verdict = verdict;
    assert.match(evidenceJudgement(r), /^Insufficient evidence to assess/);
  }
  const r = report(); r.evidence[1].stance = "contradicts";
  assert.match(evidenceJudgement(r), /^Insufficient evidence to assess/);
  r.evidence[1].stance = "supports"; r.overall.strength = "weak";
  assert.match(evidenceJudgement(r), /^Insufficient evidence to assess/);
  r.overall.strength = "strong"; r.claims.push({ id: "c2" }); r.assessments.push({ verdict: "supported", strength: "strong" });
  assert.match(evidenceJudgement(r), /^Insufficient evidence to assess/);
});
test("contradicting evidence produces a judgement about falsity, not intent", () => {
  const r = report(); r.overall.verdict = "contradicted"; r.assessments[0].verdict = "contradicted";
  r.evidence.forEach(e => { e.stance = "contradicts"; });
  assert.match(evidenceJudgement(r), /highly likely.*claim is false/);
  assert.doesNotMatch(evidenceJudgement(r), /intent|hostile|coordination/);
});
test("AI drafting cannot upgrade or remove the evidence judgement", () => {
  const base = { assessment: "Insufficient evidence to assess. Keep this evidence-based assessment.", evidence_judgement: "Insufficient evidence to assess.", recommendations: [] };
  const result = checkAiSections({ assessment: "It is highly likely that this is false. ".repeat(15) }, base);
  assert.equal(result.assessment, base.assessment);
});
