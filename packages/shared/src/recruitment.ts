import { z } from "zod";
import { recruitmentScreeningRulesSchema } from "./recruitmentResume.js";
export * from "./recruitmentResume.js";

/** Existing staff text limits, shared by candidate forms and API boundaries. */
export const RECRUITMENT_NOTE_MAX_LENGTH = 2000;
export const RECRUITMENT_REJECTION_REASON_MAX_LENGTH = 500;

const label = z.string().trim().min(1).max(140);
const publicText = z.string().trim().max(2000);
const keyword = z.string().trim().min(3).max(40).regex(/^[\p{L}\p{N}_-]+$/u).transform(value => value.normalize("NFKC").toLocaleLowerCase());
export const recruitmentPositionKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const recruitmentPositionInputSchema = z.object({
  titleRu: label, titleTg: label,
  detailsRu: publicText, detailsTg: publicText,
  isOpen: z.boolean(),
  // Optional keeps historic catalog witnesses valid. Rules never decide hiring.
  screeningRules: recruitmentScreeningRulesSchema.nullable().optional(),
  keywords: z.array(keyword).max(16).refine(values => new Set(values).size === values.length, "Повтор ключевого слова"),
  postCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{5,128}$/)).max(24)
    .refine(values => new Set(values).size === values.length, "Повтор публикации"),
}).strict();
export const recruitmentPositionSchema = recruitmentPositionInputSchema.extend({
  key: recruitmentPositionKeySchema, revision: z.number().int().positive(),
});
export const recruitmentPositionUpdateSchema = recruitmentPositionInputSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type RecruitmentPosition = z.infer<typeof recruitmentPositionSchema>;
export type RecruitmentPositionInput = z.infer<typeof recruitmentPositionInputSchema>;
const sourceEventKey = z.string().regex(/^[a-f0-9]{64}$/);
export const customerRecruitmentPortfolioSchema = z.array(z.union([
  z.object({ kind: z.literal("link"), url: z.string().url().max(4096).refine(value => {
    try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; }
  }), sourceEventKey }).strict(),
  z.object({ kind: z.enum(["image", "audio", "video", "file"]), file: z.string().regex(/^[a-f0-9-]{36}\.[a-z0-9]{2,4}$/i),
    mime: z.string().min(1).max(120), sourceEventKey }).strict(),
])).max(24);
export type CustomerRecruitmentPortfolio = z.infer<typeof customerRecruitmentPortfolioSchema>;
export const customerAgentVacanciesCallSchema = z.object({
  name: z.literal("get_open_vacancies"), args: z.object({}).strict(),
}).strict();
export const customerAgentVacanciesObservationSchema = z.object({
  kind: z.literal("open_vacancies"), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  collecting: z.boolean(), positions: z.array(recruitmentPositionSchema).max(24),
}).strict();
export type CustomerAgentVacanciesObservation = z.infer<typeof customerAgentVacanciesObservationSchema>;
export function recruitmentKeyword(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
  const parsed = keyword.safeParse(normalized); return parsed.success ? parsed.data : null;
}

/** Strict local parsing only. A supplied URL is not fetched or treated as proof. */
export function recruitmentPostCode(value: string): string | null {
  const raw = value.trim();
  if (/^[A-Za-z0-9_-]{5,128}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
    return url.pathname.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,128})\/?$/)?.[1] ?? null;
  } catch { return null; }
}
