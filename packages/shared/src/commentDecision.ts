import { z } from "zod";

export const COMMENT_ACTIONS = ["reply", "hide", "delete", "escalate", "ignore", "owner"] as const;
export type CommentAction = typeof COMMENT_ACTIONS[number];
export interface CommentDecisionCapabilities {
  privateReply: boolean;
  /** Adapter has these handlers; this is not proof of provider permissions. */
  supportsModeration: boolean;
}
export const COMMENT_DECISION_LIMITS = { reply: 2200, dm: 4000, reason: 2000 } as const;

/** Whole untrusted result. Empty optional strings keep the existing no-op paths. */
export function commentDecisionSchema(capabilities: CommentDecisionCapabilities) {
  const dm = z.string().max(COMMENT_DECISION_LIMITS.dm);
  return z.object({
    action: z.enum(capabilities.supportsModeration ? COMMENT_ACTIONS : ["reply", "escalate", "ignore", "owner"])
      .describe("reply — ответить, hide — скрыть спам, delete — удалить мат, оскорбление, травлю или рекламу " +
        "агентства/риелтора (безвозвратно), owner — собственник продаёт свою недвижимость" +
        (capabilities.privateReply ? ": пишем ему в личку" : "") + ", " +
        "escalate — не знаю ответа, ignore — отвечать не на что"),
    reply: z.string().max(COMMENT_DECISION_LIMITS.reply).describe("Публичный ответ на языке комментария, одна-две короткие фразы").optional(),
    dm: (capabilities.privateReply ? dm : dm.regex(/^\s*$/))
      .describe("Личное сообщение автору на языке комментария; пусто, если повода нет").optional(),
    reason: z.string().max(COMMENT_DECISION_LIMITS.reason).describe("Чего не хватает, чтобы ответить самому (для эскалации)").optional(),
  }).strict();
}
export type CommentDecision = z.output<ReturnType<typeof commentDecisionSchema>>;

/** Derive the existing Gemini parameter subset from the same runtime factory.
 * Bounds/strictness stay authoritative on the server; do not advertise unsupported DM. */
export function commentDecisionProviderSchema(capabilities: CommentDecisionCapabilities): Record<string, unknown> {
  const generated = z.toJSONSchema(commentDecisionSchema(capabilities), { target: "openapi-3.0" });
  const fields = generated.properties as Record<string, Record<string, unknown>>;
  const properties = Object.fromEntries(Object.entries(fields)
    .filter(([name]) => name !== "dm" || capabilities.privateReply)
    .map(([name, field]) => [name, Object.fromEntries(["type", "enum", "description"]
      .filter((key) => field[key] !== undefined).map((key) => [key, field[key]]))]));
  return { type: generated.type, properties, required: generated.required };
}
