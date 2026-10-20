/**
 * ПОДСКАЗКИ РАСПОЗНАВАНИЮ РЕЧИ КЛИЕНТА.
 *
 * История. 09.10.2026 (docs/robot-upgrade-speed-understanding-2026-10-09.md, П1 и п.7
 * плана): расшифровка клиента шла без подсказки языка (`inputAudioTranscription: {}`), и
 * 56–64 % её кусков приходили не кириллицей. У AudioTranscriptionConfig по справочнику API
 * есть `languageCodes[]` и `customVocabulary[]`, но примет ли их gemini-3.8-live, сказано не
 * было — поэтому обе подсказки лежали за флагом LIVE_VOICE_TRANSCRIBE_HINTS=1, выключенные.
 *
 * 11.10.2026 — ЗАМЕР НА РЕАЛЬНЫХ ЗАПИСЯХ ВНУТРИ КОНТЕЙНЕРА ПРОДА
 * (docs/journal/2026-10-11-transcribe-hints-default.md):
 *  - `languageCodes: ["tg-TJ", "ru-RU"]` gemini-3.8-live ПРИНИМАЕТ; расшифровка таджикской
 *    и русской речи по телефону — кириллицей, почти как эталон основного распознавания;
 *  - модель ещё и ПОНИМАЕТ лучше: переспросов «плохо слышно» 0 вместо 9–12;
 *  - порядок ["tg-TJ", "ru-RU"] проверен; на русской речи он не хуже ["ru-RU"];
 *  - словарь `customVocabulary` на 3.8 отдельного выигрыша не дал, а на
 *    gemini-3.5-transcribe-live вставлялся в текст расшифровки как сказанное.
 *
 * Поэтому теперь: подсказка языка ВКЛЮЧЕНА ПО УМОЛЧАНИЮ (выключатель
 * LIVE_VOICE_TRANSCRIBE_HINTS=0 возвращает прежний `{}`), словарь — отдельным флагом
 * LIVE_VOICE_TRANSCRIBE_VOCAB=1, по умолчанию НЕ отправляется.
 *
 * Если модель всё же отвергнет setup из-за поля — LiveVoiceClient.connect повторяет ту же
 * модель с пустым `{}` (ai/liveVoiceClient.ts, «откат подсказки распознаванию»): звонок
 * важнее подсказки.
 *
 * Словарь — официальные районы, народные названия мест (ai/folkPlaces.ts — тот же список,
 * что у чат-бота, не копия) и название агентства.
 */
import { FOLK_PLACES } from "./folkPlaces.js";

/** Языки речи звонящих (BCP-47, как в справочнике Live API): таджикский первым — порядок
 *  проверен замером 11.10.2026, на русской речи он не хуже одного «ru-RU». */
export const LIVE_VOICE_TRANSCRIBE_LANGUAGES = ["tg-TJ", "ru-RU"] as const;
/** Подсказка для режима «Только русский» и клиента с досье «ru». */
export const LIVE_VOICE_TRANSCRIBE_LANGUAGES_RU = ["ru-RU"] as const;
/** Потолок словаря: подсказка, а не справочник; длинный список модель всё равно не держит. */
const VOCABULARY_CAP = 100;

export function liveVoiceTranscriptionVocabulary(): string[] {
  const words = ["Royal Home", "Сино", "Фирдавси", "Шохмансур", "Исмоили Сомони", "Душанбе", ...FOLK_PLACES.map((p) => p.name)];
  return [...new Set(words)].slice(0, VOCABULARY_CAP);
}

/**
 * Язык, под который подсказывать распознаванию: «ru» — замок «Только русский» или клиент с
 * досье «ru»; иначе (досье «tg» или язык неизвестен) — null, то есть таджикский и русский.
 * Отличается от resolveLiveVoiceLanguage моста: тот неизвестный язык сводит к «ru» (язык
 * ответа), а здесь неизвестный — значит слушать оба.
 */
export function liveVoiceTranscriptionHintLanguage(
  forceRussianOnly: boolean,
  known: "ru" | "tg" | null | undefined
): "ru" | "tg" | null {
  if (forceRussianOnly) return "ru";
  return known ?? null;
}

/**
 * Тело `inputAudioTranscription` для setup Gemini. По умолчанию — подсказка языка;
 * LIVE_VOICE_TRANSCRIBE_HINTS=0 — прежний пустой объект; словарь — только с
 * LIVE_VOICE_TRANSCRIBE_VOCAB=1.
 */
export function liveVoiceInputTranscriptionConfig(language?: "ru" | "tg" | null): Record<string, unknown> {
  if (process.env.LIVE_VOICE_TRANSCRIBE_HINTS === "0") return {};
  const config: Record<string, unknown> = {
    languageCodes: language === "ru" ? [...LIVE_VOICE_TRANSCRIBE_LANGUAGES_RU] : [...LIVE_VOICE_TRANSCRIBE_LANGUAGES],
  };
  if (process.env.LIVE_VOICE_TRANSCRIBE_VOCAB === "1") config.customVocabulary = liveVoiceTranscriptionVocabulary();
  return config;
}
