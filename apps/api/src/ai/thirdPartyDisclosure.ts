import { logSystemAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { BW, EW } from "./wordBoundary.js";

/**
 * РОБОТ НАЗВАЛ ЦЕЛЬ ЗВОНКА ПОСТОРОННЕМУ (11.11.2026, симуляции ElevenLabs: на «кто вы и зачем?» мать
 * кандидата услышала «по заявке на работу»). Промт (liveVoicePersona.ts::liveVoiceThirdPartyRule)
 * просьба, а не гарантия, и на пути ElevenLabs звук идёт мимо наших рук — поэтому код проверяет
 * ИТОГ: звонок завершён причиной wrong_person, а в репликах робота есть слова цели (заявка,
 * вакансия, собеседование, показ, квартира, цена, адрес…) — это находка: запись в аудит и в журнал
 * ошибок (видит владелец), без деталей собеседника. Ничего постороннему и в заметки не уходит:
 * найденные слова — только названия категорий, не цитаты.
 *
 * Расшифровка — строки «Бот: …» / «Клиент: …» (LiveVoiceScenarioResult.transcript).
 */

const TERMS: Array<[string, string]> = [
  ["заявка на работу", `${BW}заявк\\p{L}*${EW}|${BW}откликнул\\p{L}*${EW}|${BW}дархост\\p{L}*${EW}`],
  ["вакансия", `${BW}вакан\\p{L}*${EW}|${BW}должност\\p{L}*${EW}`],
  ["собеседование", `${BW}собеседован\\p{L}*${EW}|${BW}мусоҳиб\\p{L}*${EW}`],
  ["показ", `${BW}показ\\p{L}*${EW}|${BW}просмотр\\p{L}*${EW}|${BW}намоиш\\p{L}*${EW}`],
  ["объект", `${BW}квартир\\p{L}*${EW}|${BW}объект\\p{L}*${EW}|${BW}объявлен\\p{L}*${EW}|${BW}хонаи?${EW}`],
  ["деньги", `${BW}цен[аыуе]${EW}|${BW}долларов?${EW}|${BW}сомони${EW}|${BW}тысяч\\p{L}*${EW}|\\$`],
  ["адрес", `${BW}адрес\\p{L}*${EW}|${BW}Бухоро${EW}|${BW}Bukhoro${EW}|${BW}манзил\\p{L}*${EW}`],
];
const TERM_RES = TERMS.map(([label, source]) => [label, new RegExp(source, "iu")] as const);

/** Реплики робота без префикса «Бот:». */
export function botLinesOf(transcript: readonly string[]): string[] {
  const lines: string[] = [];
  for (const line of transcript) {
    const match = /^\s*Бот\s*:\s*(.*)$/isu.exec(line);
    if (match && match[1]!.trim()) lines.push(match[1]!.trim());
  }
  return lines;
}

/**
 * Категории слов цели звонка в репликах робота (по одному разу). Пусто — ничего не названо.
 * Общее приветствие «Royal Home, ищу …» сюда не попадает: в нём нет ни одного слова цели.
 */
export function findThirdPartyDisclosure(transcript: readonly string[]): string[] {
  const text = botLinesOf(transcript).join("\n");
  return TERM_RES.filter(([, re]) => re.test(text)).map(([label]) => label);
}

export type ThirdPartyCallKind = "interview_invite" | "post_showing" | "seller_probe";

export interface ThirdPartyDisclosureSink {
  audit: (action: string, entityId: string, details: { terms: string[] }) => void;
  error: (message: string, dedupKey: string) => void;
}

const defaultSink = (kind: ThirdPartyCallKind): ThirdPartyDisclosureSink => ({
  audit: (action, entityId, details) => logSystemAudit(action, kind, entityId, details),
  error: (message, dedupKey) => void logSystemError("telephony", message, { dedupKey }),
});

/**
 * Звонок закончился «трубку взял не тот»: сверить реплики робота и, если цель названа, оставить след.
 * Возвращает найденные категории (для тестов). Не бросает: след — не повод ронять разбор звонка.
 */
export function reportThirdPartyDisclosure(
  kind: ThirdPartyCallKind,
  entityId: string,
  transcript: readonly string[],
  sink: ThirdPartyDisclosureSink = defaultSink(kind)
): string[] {
  try {
    const terms = findThirdPartyDisclosure(transcript);
    if (terms.length === 0) return [];
    sink.audit("robot_third_party_disclosure", entityId, { terms });
    sink.error(
      `Робот назвал постороннему на линии цель звонка (${terms.join(", ")}): вид «${kind}», запись ${entityId}. ` +
        "Трубку взял не адресат — проверьте расшифровку звонка и правило «посторонний на линии» в промте.",
      `robot-third-party-disclosure-${kind}`
    );
    return terms;
  } catch {
    return [];
  }
}
