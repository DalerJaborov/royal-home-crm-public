import { z } from "zod";

export const recruitmentCommunicationChannelSchema = z.enum(["SMS", "ASSISTANT_CALL"]);
export const recruitmentContactPreviewSchema = z.object({
  purpose: z.enum(["INVITE", "CLARIFY"]),
  interviewAt: z.string().datetime({ offset: true }).optional(),
  channels: z.array(recruitmentCommunicationChannelSchema).min(1).max(2)
    .refine(items => new Set(items).size === items.length, "Повтор канала"),
  language: z.enum(["ru", "tg"]),
  address: z.string().trim().min(1).max(300).optional(),
  mapUrl: z.string().trim().url().max(1000).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["maps.google.com", "www.google.com", "google.com", "maps.app.goo.gl", "yandex.ru", "yandex.com", "2gis.ru", "2gis.tj", "2gis.com", "go.2gis.com"].includes(url.hostname);
  }, "Нужна HTTPS-ссылка Google Maps, Яндекс Карт или 2ГИС").optional(),
  preparation: z.string().trim().max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.purpose === "INVITE" && !value.interviewAt) ctx.addIssue({ code: "custom", path: ["interviewAt"], message: "Укажите время собеседования" });
  if (value.purpose === "CLARIFY" && value.interviewAt) ctx.addIssue({ code: "custom", path: ["interviewAt"], message: "Уточнение анкеты не назначает собеседование" });
  if (value.mapUrl && !value.channels.includes("SMS")) ctx.addIssue({ code: "custom", path: ["mapUrl"], message: "Ссылка на карту отправляется по SMS — выберите этот способ связи" });
});
export const recruitmentContactConfirmSchema = z.object({
  previewId: z.string().uuid(), idempotencyKey: z.string().uuid(),
}).strict();
export type RecruitmentContactPreviewInput = z.infer<typeof recruitmentContactPreviewSchema>;
export type RecruitmentContactConfirmInput = z.infer<typeof recruitmentContactConfirmSchema>;
export type RecruitmentCommunicationChannel = z.infer<typeof recruitmentCommunicationChannelSchema>;
export type RecruitmentCommunicationStatus = "PREVIEW" | "QUEUED" | "IN_FLIGHT" | "ACCEPTED" | "DELIVERED" |
  "CONFIRMED" | "COMPLETED" | "REJECTED" | "UNKNOWN" | "CANCELLED" | "DRY_RUN";
export interface RecruitmentCommunicationDelivery {
  id: string; channel: RecruitmentCommunicationChannel; status: RecruitmentCommunicationStatus; reason?: string;
  result?: { purpose: "INVITE" | "CLARIFY"; summary: string; transcript: string[]; candidateSpoke: boolean };
}
export interface RecruitmentContactOptions {
  sourceKind?: "CORE" | "LEGACY_HR";
  sms: { available: boolean; reason?: string };
  assistantCall: { available: boolean; reason?: string };
  clarification: { available: boolean; reason?: string };
  /** addressTg — адрес для приглашения на таджикском (если отличается от address). */
  office: { address: string | null; addressTg?: string | null; mapUrl: string | null; preparation: string | null };
  language: "ru" | "tg" | null;
  recentDeliveries: RecruitmentCommunicationDelivery[];
}
export interface RecruitmentContactPreview {
  previewId: string; text: string; callSummary?: string; expiresAt: string;
  /** Число СМС-сегментов текста (UCS-2: 70 / 67 на сегмент); только если выбран канал SMS. */
  smsSegments?: number;
}
export interface RecruitmentContactConfirmation {
  interviewSaved: boolean; deliveries: RecruitmentCommunicationDelivery[];
}
