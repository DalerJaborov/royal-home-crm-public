import { mergeTranscriptFragments, TRANSCRIPT_SPEAKER_RE, TRANSCRIPT_SYSTEM_LINE_RE } from "@royal-home/shared";

/**
 * Разбор расшифровки на блоки для TranscriptView. Чистые функции — без React,
 * чтобы их можно было проверить тестом (lib/__tests__/transcriptBlocks.test.ts).
 *
 * Блок хранит СВОЙ текст, а не координаты в исходной строке: после склейки
 * осколков реплики координаты уже не совпадали бы с исходником, а поиск и
 * подсветка должны работать ровно по тому, что нарисовано на экране.
 */

export type Side = "agent" | "client";

export interface Block {
  text: string;
  speakerSide?: Side;
  speakerLabel?: string;
  /** Служебная строка в скобках («[эскалация к оператору] …») — рисуется приглушённо. */
  system?: boolean;
}

function trimBlock(b: Block): Block {
  return { ...b, text: b.text.trim() };
}

/** Подпись говорящего: робот и консультант называются сами, а не именем агента. */
export function speakerOf(word: string, agentName?: string | null): { side: Side; label: string } {
  switch (word.toLowerCase()) {
    case "клиент":
      return { side: "client", label: "Клиент" };
    case "бот":
    case "робот":
    case "ассистент":
      return { side: "agent", label: "Робот" };
    case "консультант":
      return { side: "agent", label: "Консультант" };
    default:
      return { side: "agent", label: agentName || "Агент" };
  }
}

/** Реплики чата: ≥2 строки с префиксом говорящего. Осколки одного говорящего
 *  склеиваются в один пузырь; строки без префикса дописываются к предыдущей реплике. */
function tryDialogue(fullText: string, agentName?: string | null): Block[] | null {
  const lines = fullText.split("\n");
  if (lines.filter((l) => TRANSCRIPT_SPEAKER_RE.test(l.trimStart())).length < 2) return null;

  const turns: Block[] = [];
  let current = null as Block | null;
  for (const line of mergeTranscriptFragments(fullText).split("\n")) {
    const trimmed = line.trimStart();
    const m = TRANSCRIPT_SPEAKER_RE.exec(trimmed);
    if (m) {
      if (current) turns.push(trimBlock(current));
      const { side, label } = speakerOf(m[1], agentName);
      current = { text: trimmed.slice(m[0].length), speakerSide: side, speakerLabel: label };
    } else if (TRANSCRIPT_SYSTEM_LINE_RE.test(trimmed)) {
      if (current) turns.push(trimBlock(current));
      current = null;
      turns.push(trimBlock({ text: trimmed, system: true }));
    } else if (current) {
      current = { ...current, text: current.text + "\n" + line };
    }
  }
  if (current) turns.push(trimBlock(current));
  const result = turns.filter((b) => b.text.length > 0);
  return result.length ? result : null;
}

function paragraphsByBlankLines(fullText: string): Block[] {
  return fullText
    .split(/\n[ \t]*\n+/)
    .map((t) => trimBlock({ text: t }))
    .filter((b) => b.text.length > 0);
}

/** Сплошная простыня длиннее 600 знаков — по 4 предложения на абзац. */
function sentenceGroups(fullText: string): Block[] {
  const sentences = fullText.match(/[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g) ?? [];
  const GROUP_SIZE = 4;
  const groups: Block[] = [];
  for (let i = 0; i < sentences.length; i += GROUP_SIZE) {
    groups.push(trimBlock({ text: sentences.slice(i, i + GROUP_SIZE).join("") }));
  }
  return groups.filter((b) => b.text.length > 0);
}

const LONG_TEXT_THRESHOLD = 600;

export function parseBlocks(fullText: string, agentName?: string | null): Block[] {
  const dialogue = tryDialogue(fullText, agentName);
  if (dialogue) return dialogue;
  const paragraphs = paragraphsByBlankLines(fullText);
  if (paragraphs.length <= 1 && fullText.length > LONG_TEXT_THRESHOLD) {
    const grouped = sentenceGroups(fullText);
    if (grouped.length > 1) return grouped;
  }
  return paragraphs.length ? paragraphs : [trimBlock({ text: fullText })];
}

/* ---------------- подсветка и поиск ---------------- */

export type EntityType = "phone" | "price" | "time" | "unclear";

export interface EntityRange {
  start: number;
  end: number;
  type: EntityType;
}

// Кириллица: \b в JS видит только латиницу, поэтому границы слов — по \p{L}.
// Левую границу (бывший взгляд назад (?<!…)) проверяет findEntities кодом:
// Safari до 16.4 lookbehind не знает и бросает SyntaxError на new RegExp.
const WORD_CHAR = /[\p{L}\d]/u;
const NA = String.raw`(?![\p{L}\d])`;
const ENTITY_SOURCE =
  String.raw`(?<price>\d[\d\s]{0,12}\s?(?:сомони|TJS|\$|долл[а-я]*|тыс[а-я]*|000)${NA})|` +
  String.raw`(?<time>(?:завтра|сегодня|послезавтра|вчера)${NA}|\d{1,2}:\d{2}${NA})|` +
  String.raw`(?<digits>[\d?][\d?\s-]{3,}[\d?]${NA})`;

export function findEntities(text: string): EntityRange[] {
  const ranges: EntityRange[] = [];
  const re = new RegExp(ENTITY_SOURCE, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const groups = m.groups as { price?: string; time?: string; digits?: string } | undefined;
    const start = m.index;
    // Левая граница для дат и номеров: перед ними не буква и не цифра. Иначе —
    // мимо, и поиск со следующего символа (ровно как делал (?<![\p{L}\d])).
    if (!groups?.price && start > 0 && WORD_CHAR.test(text[start - 1] ?? "")) {
      re.lastIndex = start + 1;
      continue;
    }
    const end = start + m[0].length;
    let type: EntityType;
    if (groups?.price) type = "price";
    else if (groups?.time) type = "time";
    else type = m[0].includes("?") ? "unclear" : "phone";
    ranges.push({ start, end, type });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return ranges;
}

export interface SearchRange {
  start: number;
  end: number;
  globalIndex: number;
}

/** Совпадения поиска по каждому блоку (в координатах текста блока); globalIndex
 *  сквозной по всему разговору. Ищем ТОЛЬКО по показанному тексту — без подписей
 *  говорящих, которых на экране нет. */
export function findBlockMatches(blocks: Block[], term: string): SearchRange[][] {
  const needle = term.trim().toLowerCase();
  let global = 0;
  return blocks.map((b) => {
    const ranges: SearchRange[] = [];
    if (!needle) return ranges;
    const lower = b.text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      ranges.push({ start: at, end: at + needle.length, globalIndex: global++ });
      from = at + needle.length;
    }
    return ranges;
  });
}
