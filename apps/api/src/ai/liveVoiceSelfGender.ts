import { selfGenderReminder, selfGenderRule, voiceGender, type VoiceGender } from "@royal-home/shared";

/**
 * РОД ГОЛОСА — ОТ ГОЛОСА, КОТОРЫЙ ФАКТИЧЕСКИ ЗВУЧИТ (02.10.2026, жалоба владельца:
 * женский голос говорил о себе «понял, записал»).
 *
 * Голос выбирается в нескольких местах (консультант по языку человека, сценарные
 * звонки, проверочный звонок, переменная окружения), и промт каждой роли о нём не
 * знает. Поэтому правило рода вешается ОДИН раз — в мосте, в точке
 * gemini.connect(), где имя голоса уже окончательное
 * (lib/telephony/liveVoiceBridge.ts). Так оно действует во всех ролях сразу,
 * включая те, чьи промты пишутся в других ветках (приглашение кандидата).
 *
 * Правило идёт В КОНЦЕ промта: оно перебивает любое «ты сотрудница …» выше, если
 * голос мужской (см. selfGenderRule в packages/shared/src/geminiVoices.ts).
 */
export function withSelfGenderRule(systemInstruction: string, voiceName: string | null | undefined): string {
  return withSelfGenderRuleFor(systemInstruction, voiceGender(voiceName));
}

/** То же по готовому полу — для голоса ElevenLabs, у которого нет имени из каталога
 *  Gemini: пол владелец указывает в Настройках (03.10.2026). */
export function withSelfGenderRuleFor(systemInstruction: string, gender: VoiceGender): string {
  return `${systemInstruction}\n<system_role>\n${selfGenderRule(gender)}\n</system_role>\n`;
}

/** Первая служебная реплика с напоминанием о роде (модель её не произносит). */
export function withSelfGenderReminder(trigger: string, voiceName: string | null | undefined): string {
  return withSelfGenderReminderFor(trigger, voiceGender(voiceName));
}

export function withSelfGenderReminderFor(trigger: string, gender: VoiceGender): string {
  return `${trigger} ${selfGenderReminder(gender)}`;
}

/**
 * Пол голоса, который звучит в ЭТОМ звонке. Gemini — по имени голоса из каталога;
 * ElevenLabs — по полю из Настроек (у voice id имени из каталога нет, и пол
 * по имени Gemini-голоса там был бы чужим: мужской голос ElevenLabs при женском
 * Kore по умолчанию говорил бы о себе «поняла»).
 */
export function selfGenderForCall(
  provider: { provider: "google" } | { provider: "elevenlabs"; voiceGender: VoiceGender },
  voiceName: string | null | undefined
): VoiceGender {
  return provider.provider === "elevenlabs" ? provider.voiceGender : voiceGender(voiceName);
}
