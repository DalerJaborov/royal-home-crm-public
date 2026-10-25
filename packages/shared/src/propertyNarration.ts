import { z } from "zod";

export const narrationConfigSchema = z.object({
  ownerReportPreviewEnabled: z.boolean().optional(),
  modelId: z.string().trim().max(100).default(""),
  voices: z.array(z.object({ id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/), name: z.string().trim().min(1).max(80) })).max(50).default([]),
}).refine((v) => new Set(v.voices.map((voice) => voice.id)).size === v.voices.length, "Голоса не должны повторяться");
export type NarrationConfig = z.infer<typeof narrationConfigSchema>;
export type NarrationFacts = { type: string; rooms: number | null; areaSqm: string; floor: number | null; totalFloors: number | null; district: string | null };
export function suggestedNarration(facts: NarrationFacts): string {
  const types: Record<string, string> = { APARTMENT: "Квартира", HOUSE: "Дом", LAND: "Участок", COMMERCIAL: "Коммерческое помещение" };
  return [types[facts.type] ?? "Объект недвижимости", facts.rooms ? `${facts.rooms} комнат.` : "", `Площадь ${facts.areaSqm} квадратных метров.`,
    facts.floor ? `Этаж ${facts.floor}${facts.totalFloors ? ` из ${facts.totalFloors}` : ""}.` : "",
    facts.district ? `Район: ${facts.district}.` : "",
    "Цена и номер телефона указаны в описании под видео. Поделитесь этим видео с теми, кто ищет недвижимость.",
  ].filter(Boolean).join(" ");
}
export const narrationDraftSchema = z.object({
  expectedRevision: z.number().int().min(0), requestKey: z.string().uuid(),
  script: z.string().trim().min(10).max(5000).optional(),
  voiceId: z.string().trim().max(100).optional(),
});
export const narrationActionSchema = z.object({ expectedRevision: z.number().int().positive(), confirmed: z.literal(true) });
export const narrationHandoffSchema = narrationActionSchema.extend({
  audioReviewed: z.literal(true),
  requestKey: z.string().uuid(), mode: z.enum(["AUDIO_ONLY", "WITH_SOURCES"]), editorId: z.string().uuid().optional(),
});
export type PropertyNarrationItem = {
  id: string; revision: number; script: string; voiceId: string | null; status: string;
  approvedAt: string | null; stale: boolean; hasAudio: boolean; errorCode: string | null; createdAt: string;
  canReconcile?: boolean;
};
export type PropertyNarrationView = {
  versions: PropertyNarrationItem[]; suggestedScript: string; config: NarrationConfig;
  configured: boolean; canApprove: boolean; canConfigure?: boolean; canDraft?: boolean; sendsEnabled: boolean;
  deliveries?: Array<{ id: string; status: string; mode: string; versionId: string; createdAt: string; lastError: string | null; planHash: string | null }>;
  ownerReportsEnabled?: boolean;
  ownerReport?: { active: boolean; revision: number; executionMode: string; deliveries: Array<{ id: string; status: string; period: string; lastError: string | null }> };
  readiness?: { voiceCount: number; modelConfigured: boolean; apiKeyConfigured: boolean };
};
