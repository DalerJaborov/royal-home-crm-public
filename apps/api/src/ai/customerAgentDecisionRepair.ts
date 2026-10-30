import { customerAgentQuestionSchema, customerAgentSocialActSchema, type CustomerAgentSurface } from "@royal-home/shared";

/**
 * Deterministic repair of a model decision whose SHAPE is wrong but whose intent is clear (live runs: `propose` with a
 * `question` and no `ref`). Pure and conservative: it only re-labels toward the safest kind (`clarify`), never invents
 * evidence, never adds a refs the server does not hold. The result still goes through the strict schema, and the
 * renderer still decides whether the evidence supports the text. Returns null when nothing was repaired.
 */
export interface CustomerAgentDecisionRepair { decision: Record<string, unknown>; repairs: string[] }

const ALLOWED: Record<string, readonly string[]> = {
  reply: ["kind", "refs", "social", "question", "attachment"],
  clarify: ["kind", "refs", "question", "social"],
  propose: ["kind", "ref", "social"],
  skip: ["kind", "reason"],
  escalate: ["kind", "reason"],
  moderation_proposal: ["kind", "action", "reason"],
};
const REF = /^e(?:0|[1-9]\d{0,3})$/;

export function repairCustomerAgentDecision(raw: unknown, ctx: { surface: CustomerAgentSurface; knownRefs: readonly string[]; searchRefs?: readonly string[] }): CustomerAgentDecisionRepair | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.kind !== "string") return null;
  const repairs: string[] = [];
  const known = new Set(ctx.knownRefs);
  let kind = src.kind;
  const normalized = kind.trim().toLowerCase();
  if (normalized !== kind) { kind = normalized; repairs.push("kind_normalized"); }
  if (!(kind in ALLOWED)) return null;

  const question = customerAgentQuestionSchema.safeParse(typeof src.question === "string" ? src.question.trim().toLowerCase() : undefined);
  const social = customerAgentSocialActSchema.safeParse(src.social);
  // A present-but-invalid social act is not guessed at: the correction round names it.
  if (src.social !== undefined && !social.success) return null;
  const socialValue = social.success ? social.data : "none";
  const rawRefs = Array.isArray(src.refs) ? src.refs : typeof src.ref === "string" ? [src.ref] : [];
  const keptRefs = [...new Set(rawRefs.filter((r): r is string => typeof r === "string" && REF.test(r) && known.has(r)))].slice(0, 8);
  const refsDropped = rawRefs.length !== keptRefs.length;

  let out: Record<string, unknown>;
  if (kind === "propose") {
    const ref = typeof src.ref === "string" && REF.test(src.ref) && known.has(src.ref) ? src.ref : null;
    if (ref) out = { kind, ref, social: socialValue };
    else if (ctx.surface === "dm" && ctx.searchRefs?.length === 1 && !(question.success && question.data !== "none")) {
      // The server already read the catalogue for this very request (customerAgentSearchIntent) and the model "proposed" with nothing to
      // propose: a `propose` ref must be a proposal, so the answer is a reply built from that one search result.
      out = { kind: "reply", refs: [ctx.searchRefs[0]], social: socialValue, question: "none" };
      repairs.push("propose_bare_to_search_reply");
    } else {
      const asked = question.success && question.data !== "none" ? question.data : ctx.surface === "dm" ? "property" : null;
      if (!asked) return null;
      out = { kind: "clarify", refs: keptRefs, question: asked, social: socialValue };
      repairs.push(question.success && question.data !== "none" ? "propose_question_to_clarify" : "propose_bare_to_clarify");
    }
  } else if (kind === "reply" || kind === "clarify") {
    if (refsDropped && rawRefs.length) repairs.push("unknown_refs_dropped");
    const q = question.success ? question.data : "none";
    if (kind === "reply" && (keptRefs.length || !rawRefs.length)) {
      out = { kind, refs: keptRefs, social: socialValue, question: q };
      if (src.attachment === "buyer_guide") out.attachment = "buyer_guide";
    } else if (kind === "reply") {
      // Only reached when every ref the model named was unknown. A reply that never named a ref (greeting, thanks) is valid as it stands.
      out = { kind: "clarify", refs: [], question: q !== "none" ? q : "clarify_previous", social: socialValue };
      repairs.push(q !== "none" ? "reply_without_refs_to_clarify" : "reply_bare_to_clarify_previous");
    } else {
      out = { kind, refs: keptRefs, question: q !== "none" ? q : "clarify_previous", social: socialValue };
      if (q === "none") repairs.push("clarify_question_defaulted");
    }
  } else {
    out = {};
    for (const key of ALLOWED[kind]) if (key in src || key === "kind") out[key] = key === "kind" ? kind : src[key];
  }
  const extras = Object.keys(src).filter(key => key !== "say" && !ALLOWED[kind].includes(key));
  if (extras.length && !repairs.some(r => r.startsWith("propose") || r.startsWith("reply_"))) repairs.push("extra_fields_dropped");
  return repairs.length ? { decision: out, repairs } : null;
}
