/**
 * ТЕКСТ ОТКАЗА ЖИВОГО ГОЛОСА ДЛЯ ЧЕЛОВЕКА (02.10.2026, аудит экрана, п. 4).
 *
 * Причина отказа мост пишет в журнал техническим языком (в том числе именами
 * переменных окружения: liveVoiceRtpProblem), и тот же текст уходил в тост менеджера
 * при «Звонок роботом» из карточки и на экран проверочного звонка. Правило владельца
 * (шапка noTechWordsInSettings.test.ts): на экране без жаргона. Журнал и аудит
 * остаются как были — человеку подменяется только ответ маршрута.
 */

const RTP_NOT_CONFIGURED = "Звук станции на сервере не настроен, обратитесь к администратору";

/** Переменные окружения и им подобные идентификаторы в тексте для человека не нужны. */
export function liveVoiceErrorForPerson(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  if (/LIVE_VOICE_RTP_(HOST|PORT)/.test(error)) return RTP_NOT_CONFIGURED;
  return error;
}
