import { wrapUntrusted } from "../../untrustedContent.js";

/**
 * ПОЛЕ, ПРИШЕДШЕЕ ОТ КЛИЕНТА, — В ГРАНИЦАХ «ДАННЫЕ, НЕ КОМАНДЫ» (инструменты П3).
 *
 * Тот же приём и тот же потолок, что у `safeField` в `ai/assistant.ts` (там он
 * не экспортируется, а правка assistant.ts вне группы «read»): имя клиента, название
 * объекта, заметки приходят из Instagram, с сайта и от бота дословно, и голым текстом
 * в контекст модели не идут. Маску телефона (`clientNamePhoneSafe`/`phoneSafeText`)
 * накладывать ДО этой обёртки: обёртка режет и гасит «<>».
 *
 * TODO при следующей сводке: `assistant.ts` может импортировать эту функцию вместо
 * своей копии — тело одинаковое.
 */
export const SAFE_FIELD_MAX_CHARS = 300;

export function safeField(value: string | null | undefined, maxChars: number = SAFE_FIELD_MAX_CHARS): string | null {
  return value ? wrapUntrusted("crm_note", value, maxChars) || null : null;
}
