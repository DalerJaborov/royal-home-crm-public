import { narrationSpeechText, type NarrationFacts, type NarrationLang } from "./propertyNarration.js";

/**
 * ДЛИНА ОЗВУЧКИ ДО ОПЛАТЫ (18.11.2026, владелец: «аудио не должно быть длиннее видео»).
 *
 * Одно правило на сервер и экран: карточка показывает «Укладывается в ролик: ~32 с из 35 с» и
 * не даёт нажать «Озвучить», сервер отвечает 400 ДО обращения к ElevenLabs. Защита после синтеза
 * (lib/narrationMix.ts: ускорение до 15 %, короче текст, стоп-кадр) остаётся как есть.
 *
 * Секунды считаются по тексту, который реально уйдёт в синтез (числа словами, narrationSpeechText),
 * делёным на скорость речи. Скорость — замер по уже озвученным версиям (сервер присылает её в карточку,
 * lib/narrationLengthCalibration.ts), а без замеров — осторожная постоянная ниже: она нарочно
 * МЕДЛЕННЕЕ живой речи, чтобы оценка выходила длиннее настоящей, а не короче.
 */

/** Подгонка длины при наложении голоса: ускорение не больше 15 %, стоп-кадр не больше 3 с. */
export const NARRATION_FIT = { maxTempo: 1.15, maxFreezeSec: 3 } as const;
/** Голос начинается через 0,3 с: первое слово не съедается на склейке. */
export const NARRATION_VOICE_START_SEC = 0.3;
/** Допуск на хвост: тишина в конце mp3 ElevenLabs. */
export const NARRATION_VOICE_TAIL_TOLERANCE_SEC = 0.5;

/**
 * Знаков речи в секунду без замеров. ОЦЕНКА: обычная скорость ElevenLabs для русского около 16–18
 * знаков в секунду с пробелами; берём 14 (оценка длиннее настоящей), для таджикского 13.
 */
export const NARRATION_DEFAULT_CHARS_PER_SEC: Record<NarrationLang, number> = { ru: 14, tg: 13 };
/** Замер скорости принимается только в этих пределах: выброс (обрезанный файл, пустой текст) не ломает оценку. */
export const NARRATION_CHARS_PER_SEC_RANGE = { min: 9, max: 22 } as const;

/** Сколько секунд голоса помещается в ролик: сам ролик плюс допуск на хвост, минус задержка начала, с ускорением до 15 %. */
export function narrationMaxVoiceSec(clipSec: number): number {
  if (!(clipSec > 0)) return 0;
  return (clipSec + NARRATION_VOICE_TAIL_TOLERANCE_SEC - NARRATION_VOICE_START_SEC) * NARRATION_FIT.maxTempo;
}

export function narrationCharsPerSec(lang: NarrationLang | null | undefined, measured?: Partial<Record<NarrationLang, number>> | null): number {
  const l: NarrationLang = lang === "tg" ? "tg" : "ru";
  const m = measured?.[l];
  if (m && m >= NARRATION_CHARS_PER_SEC_RANGE.min && m <= NARRATION_CHARS_PER_SEC_RANGE.max) return m;
  return NARRATION_DEFAULT_CHARS_PER_SEC[l];
}

/** Оценка секунд голоса по тексту (числа уже словами — как уйдёт в синтез). */
export function estimateNarrationSec(script: string, lang: NarrationLang | null | undefined, measured?: Partial<Record<NarrationLang, number>> | null): number {
  const spoken = narrationSpeechText(script.trim(), lang ?? null);
  if (!spoken) return 0;
  return spoken.length / narrationCharsPerSec(lang, measured);
}

export type NarrationLengthCheck = {
  /** Оценка длины голоса, секунды (округлено вверх). */
  estSec: number;
  /** Длина ролика, секунды (округлено). */
  clipSec: number;
  /** Сколько голоса влезает с ускорением до 15 %. */
  maxSec: number;
  fits: boolean;
  /** На сколько секунд длиннее допустимого (0, если влезает). */
  overBySec: number;
};

/** null — длина ролика неизвестна (ролика ещё нет): проверять не с чем, озвучку не держим. */
export function narrationLengthCheck(script: string, lang: NarrationLang | null | undefined, clipSec: number | null | undefined,
  measured?: Partial<Record<NarrationLang, number>> | null): NarrationLengthCheck | null {
  if (!clipSec || !(clipSec > 0)) return null;
  const est = estimateNarrationSec(script, lang, measured);
  const max = narrationMaxVoiceSec(clipSec);
  const fits = est <= max;
  return { estSec: Math.ceil(est), clipSec: Math.round(clipSec), maxSec: Math.floor(max), fits, overBySec: fits ? 0 : Math.max(1, Math.ceil(est - max)) };
}

/** Проверка по НАСТОЯЩЕЙ длине готового голоса (ревью 18.11): аудио уже есть — оценка по тексту не нужна. */
export function narrationAudioLengthCheck(audioSec: number, clipSec: number | null | undefined): NarrationLengthCheck | null {
  if (!clipSec || !(clipSec > 0) || !(audioSec > 0)) return null;
  const max = narrationMaxVoiceSec(clipSec);
  const fits = audioSec <= max;
  return { estSec: Math.round(audioSec), clipSec: Math.round(clipSec), maxSec: Math.floor(max), fits, overBySec: fits ? 0 : Math.max(1, Math.ceil(audioSec - max)) };
}

/** Строка агенту под текстом: «Укладывается в ролик: ~32 с из 35 с» / «Длиннее ролика на 6 с. Сократите текст». */
export function narrationLengthLine(check: NarrationLengthCheck): string {
  return check.fits
    ? `Укладывается в ролик: ~${check.estSec} с из ${check.clipSec} с`
    : `Длиннее ролика на ${check.overBySec} с. Сократите текст, иначе голос не поместится.`;
}

/** Что из фактов озвучки поменялось — для строки «Изменилось: цена и этаж». Порядок — как звучит в тексте. */
const FACT_LABELS: Array<[keyof NarrationFacts, string]> = [
  ["type", "вид объекта"], ["rooms", "комнаты"], ["areaSqm", "площадь"], ["floor", "этаж"],
  ["totalFloors", "этажность"], ["district", "район"], ["price", "цена"], ["currency", "цена"], ["landSotka", "участок"],
];
export function narrationFactsChanges(before: Partial<NarrationFacts> | null | undefined, after: Partial<NarrationFacts> | null | undefined): string[] {
  if (!before || !after) return [];
  const norm = (v: unknown) => v === undefined || v === null || v === "" ? null : String(v);
  const out: string[] = [];
  for (const [key, label] of FACT_LABELS) {
    if (norm(before[key]) !== norm(after[key]) && !out.includes(label)) out.push(label);
  }
  return out;
}

/** «цена», «цена и этаж», «цена, этаж и район». */
export function narrationChangesLine(changes: readonly string[]): string | null {
  if (!changes.length) return null;
  if (changes.length === 1) return `Изменилось: ${changes[0]}`;
  return `Изменилось: ${changes.slice(0, -1).join(", ")} и ${changes[changes.length - 1]}`;
}
