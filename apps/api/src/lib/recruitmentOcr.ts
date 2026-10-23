import type { CustomerAgentMediaPerception } from "../ai/customerAgentMediaPerception.js";

/** Readable text of the candidate's material, for fact extraction only (candidate content,
 * never an instruction). A document always counts; a photo counts when the perception says
 * the picture IS a document (a photographed résumé), never a listing/room photo whose text
 * could carry somebody else's phone. */
export function recruitmentOcrText(mediaKinds: readonly string[], observation: Pick<CustomerAgentMediaPerception, "subject" | "readableText">): string {
  const text = observation.readableText.trim();
  if (!text) return "";
  if (mediaKinds.includes("document")) return text;
  return mediaKinds.includes("image") && observation.subject === "document" ? text : "";
}
