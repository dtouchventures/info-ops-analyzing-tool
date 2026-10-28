// Task rationale uses the existing evidence judgement, never a new prediction.
export function informationTasks(verdict, judgement, { imageOnly = false, reference = "" } = {}) {
  const grounded = /^It is (highly )?likely that /i.test(judgement || "");
  let rationale = grounded ? judgement.split(", based on")[0].replace(/[.]$/, "").replace(/^./, c => c.toLowerCase()) : "likelihood cannot yet be assessed from the available evidence";
  if (grounded && verdict === "contradicted") rationale = rationale.replace(/\blikely\b/, "unlikely").replace(/\bfalse\b/, "accurate");
  const action = grounded && ["contradicted", "misleading"].includes(verdict)
    ? "prepare an evidence-linked clarification for approval"
    : grounded && verdict === "supported" ? "prepare factual talking points for approval"
    : "prepare an evidence-gap brief and treat the narrative as unverified";
  return [
    `There is a need to task authorised information operations staff to ${action}${reference ? ` ${reference}` : ""}; ${rationale}.`,
    `There is a need to monitor ${imageOnly ? "public reuse of the image and changes in captions" : "related public narratives and recurring claims"}, record observed circulation, and report changes without presuming coordination.`,
    "There is a need to preserve the supporting evidence, submit proposed communication tasks for authorised review, and reassess the judgement when new evidence becomes available."
  ];
}
