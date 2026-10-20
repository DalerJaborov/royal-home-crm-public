/**
 * Перевод разговора в CallDetails хранится локально (считается по клику), но
 * начинается с пропса. После повторной расшифровки сервер очищает оригинал и
 * перевод, а строка звонка остаётся раскрытой и не перемонтируется: локальный
 * перевод и «перевод не нужен» переживали смену оригинала, и новый текст
 * показывался рядом со старым переводом (аудит 04.10.2026, WEB-PAGES09).
 */
export interface TranslationSource {
  transcript: string | null;
  transcriptRu: string | null;
}

export interface TranslationReset {
  translatedRu: string | null;
  notNeeded: false;
}

/** Что делать с локальным состоянием перевода: `null` — ничего, иначе сбросить. */
export function translationResetFor(seen: TranslationSource, now: TranslationSource): TranslationReset | null {
  if (seen.transcript === now.transcript && seen.transcriptRu === now.transcriptRu) return null;
  return { translatedRu: now.transcriptRu, notNeeded: false };
}
