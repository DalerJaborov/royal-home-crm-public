import { pickNarrationVoice, type NarrationConfig } from "@royal-home/shared";

/**
 * ГОЛОС ПО ОДНОМУ (24.11.2026): как «Послушать и выбрать» в мастере CRM, но кнопками в Шабнам.
 * Список голосов один: сначала голос по умолчанию, дальше в порядке настроек; фильтр «Муж. / Жен. / Все».
 * Нажатие кнопки несёт только `<номер><фильтр>` (например `3m`), потому что callback_data у Telegram ≤ 64 байт.
 */
export type VoiceFilter = "a" | "m" | "f";
export const VOICE_STEPPER_MAX = 8;
export type StepperVoice = { index: number; id: string; name: string; gender?: "male" | "female" };

export function voiceFilterOf(raw: string | undefined): { pos: number; filter: VoiceFilter } | null {
  const m = /^(\d{1,2})([amf])$/u.exec(raw ?? "");
  return m ? { pos: Number(m[1]), filter: m[2] as VoiceFilter } : null;
}

/** Голоса для показа: `index` — место в `config.voices` (по нему идёт платная кнопка «Выбрать»). */
export function stepperVoices(config: Pick<NarrationConfig, "voices" | "defaultVoiceId">, filter: VoiceFilter): StepperVoice[] {
  const defaultId = pickNarrationVoice(config);
  return config.voices
    .slice(0, VOICE_STEPPER_MAX)
    .map((v, index) => ({ index, id: v.id, name: v.name, gender: v.gender }))
    .filter((v) => filter === "a" || (filter === "m" ? v.gender === "male" : v.gender === "female"))
    .sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
}

/** Какие фильтры вообще нужны: если все голоса одного пола, кнопок «Муж./Жен.» нет. */
export function stepperHasBothGenders(config: Pick<NarrationConfig, "voices">): boolean {
  const genders = new Set(config.voices.slice(0, VOICE_STEPPER_MAX).map((v) => v.gender).filter(Boolean));
  return genders.has("male") && genders.has("female");
}

/** Место голоса в списке: с последнего выбранного, иначе с начала; по кругу вперёд и назад. */
export function stepperStartPos(list: readonly StepperVoice[], lastVoiceId: string | undefined): number {
  const at = lastVoiceId ? list.findIndex((v) => v.id === lastVoiceId) : -1;
  return at >= 0 ? at : 0;
}
export const stepperWrap = (pos: number, total: number): number => (total <= 0 ? 0 : ((pos % total) + total) % total);
