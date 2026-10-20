import { describe, expect, it } from "vitest";
import { COMMENT_ACTIONS, COMMENT_DECISION_LIMITS, commentDecisionSchema, commentDecisionProviderSchema } from "@royal-home/shared";

const meta = { privateReply: true, supportsModeration: true };
const publicOnly = { privateReply: false, supportsModeration: true };

describe("whole CommentDecision contract", () => {
  it.each([
    null, "reply", [], false, { action: "unknown", reply: "Useful text" }, { action: "REPLY" },
    { action: true }, { action: "reply", reply: 42 }, { action: "reply", reply: ["Text"] },
    { action: "reply", reply: null }, { action: "ignore", reason: {} }, { action: "ignore", reason: null },
    { action: "reply", dm: false }, { action: "reply", dm: null },
    { action: "reply", reply: "Text", propertyId: "other-property" },
    { action: "ignore", clientId: "other-client" }, { action: "delete", actorId: "staff" },
    { action: "owner", capability: "staff" },
  ])("rejects the entire malformed result %# without normalization/coercion", (result) => {
    expect(commentDecisionSchema(meta).safeParse(result).success).toBe(false);
  });

  it.each([
    { action: "reply", reply: "Салом!" }, { action: "reply" }, { action: "reply", reply: "" },
    { action: "reply", reply: "   ", dm: "", reason: " " }, { action: "ignore" },
    { action: "escalate" }, { action: "escalate", reason: "Нужен сотрудник", reply: "" },
    { action: "owner" }, { action: "owner", reply: "Написали вам в директ." },
    { action: "hide", reason: "spam" }, { action: "delete" },
  ])("preserves existing valid optional/empty fields %#", (result) => {
    expect(commentDecisionSchema(meta).parse(result)).toEqual(result);
  });

  it.each(["reply", "dm", "reason"] as const)("rejects oversized %s instead of silently truncating", (field) => {
    expect(commentDecisionSchema(meta).safeParse({ action: "reply", [field]: "x".repeat(COMMENT_DECISION_LIMITS[field] + 1) }).success).toBe(false);
    expect(commentDecisionSchema(meta).safeParse({ action: "reply", [field]: "x".repeat(COMMENT_DECISION_LIMITS[field]) }).success).toBe(true);
  });

  it.each(["YOUTUBE", "TELEGRAM"])("%s rejects meaningful DM as a whole object but keeps blank no-op DM", () => {
    expect(commentDecisionSchema(publicOnly).safeParse({ action: "reply", reply: "Valid public text", dm: "Private text" }).success).toBe(false);
    for (const dm of [undefined, "", " \n\t "]) expect(commentDecisionSchema(publicOnly).safeParse({ action: "reply", dm }).success).toBe(true);
  });

  it("adapter moderation support is separate from provider rights and excludes unsupported actions", () => {
    const withoutHandlers = commentDecisionSchema({ ...publicOnly, supportsModeration: false });
    for (const action of ["hide", "delete"]) expect(withoutHandlers.safeParse({ action }).success).toBe(false);
    expect(withoutHandlers.safeParse({ action: "escalate" }).success).toBe(true);
  });

  it("provider declarations derive enums/types from the runtime factory and advertise only supported DM", () => {
    const withDm = commentDecisionProviderSchema(meta);
    const noDm = commentDecisionProviderSchema(publicOnly);
    const properties = withDm.properties as Record<string, { type: string; enum?: string[] }>;
    expect(properties.action.enum).toEqual([...COMMENT_ACTIONS]);
    expect(properties.dm.type).toBe("string"); expect(properties.reply.type).toBe("string");
    expect(noDm.properties).not.toHaveProperty("dm"); expect(noDm.required).toEqual(["action"]);
    expect((properties.action as { description?: string }).description).toContain("пишем ему в личку");
    expect((properties.action as { description?: string }).description).not.toContain("обратимо");
    expect(((noDm.properties as Record<string, { description?: string }>).action).description).not.toContain("пишем ему в личку");
    expect(((noDm.properties as Record<string, { description?: string }>).action).description).not.toContain("обратимо");
    expect(Object.keys(withDm).sort()).toEqual(["properties", "required", "type"]);
    const disabled = commentDecisionProviderSchema({ ...publicOnly, supportsModeration: false }).properties as typeof properties;
    expect(disabled.action.enum).toEqual(["reply", "escalate", "ignore", "owner"]);
  });
});
