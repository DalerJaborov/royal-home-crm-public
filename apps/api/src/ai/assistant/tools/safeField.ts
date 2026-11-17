import { neutralizeFence, wrapUntrusted } from "../../untrustedContent.js";

/**
 * ПОЛЕ, ПРИШЕДШЕЕ ОТ КЛИЕНТА, — В ГРАНИЦАХ «ДАННЫЕ, НЕ КОМАНДЫ» (инструменты П3).
 *
 * ОДНА реализация на весь помощник (П2 задача 2.5 + инструменты П3; копия в
 * `ai/assistant.ts` убрана при сборке П3): имя клиента, название объекта, заметки
 * приходят из Instagram, с сайта и от бота дословно, и голым текстом в контекст
 * модели не идут. Маску телефона (`clientNamePhoneSafe`/`phoneSafeText`)
 * накладывать ДО этой обёртки: обёртка режет и гасит «<>».
 */
export const SAFE_FIELD_MAX_CHARS = 300;

export function safeField(value: string | null | undefined, maxChars: number = SAFE_FIELD_MAX_CHARS): string | null {
  return value ? wrapUntrusted("crm_note", value, maxChars) || null : null;
}

/**
 * ТЕКСТ ИЗ КАРТОЧКИ В ПРЕВЬЮ ПОДТВЕРЖДЕНИЯ — то, что человек читает глазами
 * (имя клиента, название/адрес объекта, причина). Теги `wrapUntrusted` в
 * карточке подтверждения показались бы человеку мусором, поэтому здесь иное:
 * угловые скобки гасятся (`neutralizeFence` — граница не закрывается изнутри),
 * обратные кавычки, переводы строк и управляющие знаки уходят, длина режется.
 * Для МОДЕЛИ превью дополнительно оборачивается целиком (`previewForModel`,
 * tools/run.ts). Одна реализация на группы «prop» и «show» (сведено при сборке П3).
 */
export function plainField(value: string | null | undefined, maxChars = 120): string | null {
  if (!value) return null;
  const flat = neutralizeFence(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}
