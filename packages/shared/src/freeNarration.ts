import { z } from "zod";
import type { NarrationConfig, NarrationLang } from "./propertyNarration.js";

/**
 * ОЗВУЧКА СВОБОДНОГО ТЕКСТА (16.11.2026, решение владельца: «Да, сделай»).
 * Сотрудник присылает свой текст (Шабнам в Telegram или API), выбирает голос из утверждённых
 * для озвучки роликов и получает mp3. Текст читается слово в слово. Движок, голоса, модель,
 * словарь и дневной бюджет — те же, что у озвучки объектов (lib/narrationGeneration.ts);
 * здесь только пределы на человека и правила языка.
 */
export const FREE_NARRATION_DEFAULTS = { perPersonDaily: 0, maxChars: 5000, budgetPercent: 100 } as const;

export function freeNarrationLimits(config: Pick<NarrationConfig, "freeNarrationPerPersonDaily" | "freeNarrationMaxChars" | "freeNarrationBudgetPercent">) {
  return {
    perPersonDaily: config.freeNarrationPerPersonDaily ?? FREE_NARRATION_DEFAULTS.perPersonDaily,
    maxChars: config.freeNarrationMaxChars ?? FREE_NARRATION_DEFAULTS.maxChars,
    budgetPercent: config.freeNarrationBudgetPercent ?? FREE_NARRATION_DEFAULTS.budgetPercent,
  };
}

export function freeNarrationEnabled(config: Pick<NarrationConfig, "freeNarrationEnabled">): boolean {
  return config.freeNarrationEnabled !== false;
}

/** Рубильник «рекламный текст из фактов» (23.11.2026). Зависит от общего рубильника озвучки текста. */
export function freeNarrationAdTextEnabled(config: Pick<NarrationConfig, "freeNarrationEnabled" | "freeNarrationAdText">): boolean {
  return freeNarrationEnabled(config) && config.freeNarrationAdText !== false;
}

/** Пошаговый выбор голоса с образцом (по умолчанию включён). */
export function freeNarrationVoiceStepperEnabled(config: Pick<NarrationConfig, "freeNarrationEnabled" | "freeNarrationVoiceStepper">): boolean {
  return freeNarrationEnabled(config) && config.freeNarrationVoiceStepper !== false;
}

/** Рубильник кнопки «Озвучить этот текст» под длинным сообщением (23.11.2026). По умолчанию ВЫКЛ (ревью: «редко беспокоить»): владелец включает в Настройках. */
export function freeNarrationOfferEnabled(config: Pick<NarrationConfig, "freeNarrationEnabled" | "freeNarrationOfferButton">): boolean {
  return freeNarrationEnabled(config) && config.freeNarrationOfferButton === true;
}

/**
 * Язык текста по буквам: таджикские ғ ӣ қ ӯ ҳ ҷ дают «tg», иная кириллица — «ru»;
 * не определился (латиница, цифры) — null: язык-подсказку модели не передаём.
 */
export function detectFreeNarrationLang(text: string): NarrationLang | null {
  if (/[ғӣқӯҳҷҒӢҚӮҲҶ]/u.test(text)) return "tg";
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  return cyrillic > 0 && cyrillic >= latin ? "ru" : null;
}

export const freeNarrationRequestSchema = z.object({
  text: z.string().trim().min(3).max(5000),
  voiceId: z.string().trim().max(100).optional(),
  lang: z.enum(["tg", "ru"]).nullable().optional(),
  /** Ключ повтора: тот же запрос второй раз не создаёт вторую озвучку и не платит. */
  requestKey: z.string().uuid(),
}).strict();
export type FreeNarrationRequest = z.infer<typeof freeNarrationRequestSchema>;

export type FreeNarrationResult = {
  id: string; status: "READY"; chars: number; voiceId: string; voiceName: string | null; lang: NarrationLang | null; fileUrl: string;
};
