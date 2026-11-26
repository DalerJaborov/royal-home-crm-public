import { prisma } from "../../db.js";
import { SALES_AGENT_ROLES } from "@royal-home/shared";
import { FOLK_PLACES } from "../../ai/folkPlaces.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";

/**
 * ПОДСКАЗКА РАСШИФРОВКЕ ЗВОНКА: КТО И ЧТО МОЖЕТ ПРОЗВУЧАТЬ (26.11.2026, ПК-001086).
 *
 * Клиент звонит по ролику и читает с него фамилию агента и ориентир: «агент
 * Сайфуллоев», «масҷиди Мехкалон, Қазоқон». Расшифровка без подсказки отдала
 * «Файзуллоев» — и имя подошло двоим. Список здесь — фамилии действующих
 * продавцов, ориентиры и адреса объектов в продаже (слова от пяти букв, самые
 * частые первыми) и народные названия мест. Инструкция в ai/transcribe.ts
 * запрещает вписывать слова, которых не было; это подсказка написания, не словарь
 * подмены.
 *
 * Кэш на десять минут: список читается на каждый кусок записи, а меняется
 * раз в день (новый объект, новый сотрудник).
 */
const CACHE_MS = 10 * 60_000;
const MAX_WORDS = 80;
const MAX_PROPERTIES = 500;
const MIN_WORD_LENGTH = 5;

/** Слова, которые есть у половины объектов и ничего не подсказывают. */
const SKIP_WORDS = new Set([
  "улица", "кучаи", "проспект", "район", "ориентир", "рядом", "возле", "напротив", "сторона", "дома", "домов",
  "квартира", "квартал", "торговый", "центр", "школа", "рынок", "мечети", "мечеть", "около", "здание", "новостройка",
]);

let cache: { at: number; words: string[] } | null = null;

export function resetTranscriptionVocabularyCache(): void {
  cache = null;
}

export async function transcriptionVocabulary(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.words;
  try {
    return await buildVocabulary();
  } catch (err) {
    // Подсказка — не условие расшифровки: без неё запись всё равно расшифровывается,
    // но сбой чтения виден в «Здоровье системы», а не проглочен.
    void logSystemError("telephony", `Подсказка расшифровке (фамилии, ориентиры) не собралась: ${describeError(err)}`);
    return [];
  }
}

async function buildVocabulary(): Promise<string[]> {
  const [agents, properties] = await Promise.all([
    prisma.agent.findMany({
      where: { isActive: true, role: { in: [...SALES_AGENT_ROLES] } },
      select: { fullName: true },
      take: 200,
    }),
    prisma.property.findMany({
      where: { deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } },
      select: { landmark: true, address: true },
      orderBy: { createdAt: "desc" },
      take: MAX_PROPERTIES,
    }),
  ]);
  const names = agents.map((a) => a.fullName.trim()).filter(Boolean);
  const freq = new Map<string, { word: string; n: number }>();
  for (const p of properties) {
    const text = [p.landmark, p.address].filter(Boolean).join(" ");
    for (const raw of text.match(/[\p{L}][\p{L}-]*/gu) ?? []) {
      const key = raw.toLowerCase();
      if (raw.length < MIN_WORD_LENGTH || SKIP_WORDS.has(key)) continue;
      // Имена мест пишут с заглавной; строчные слова — обычная речь («возле», «сторона»).
      if (!/^\p{Lu}/u.test(raw)) continue;
      const entry = freq.get(key) ?? { word: raw, n: 0 };
      entry.n++;
      freq.set(key, entry);
    }
  }
  const places = [...freq.values()].sort((a, b) => b.n - a.n).map((e) => e.word);
  const folk = FOLK_PLACES.map((p) => p.name);
  const words = [...new Set([...names, ...places, ...folk])].slice(0, MAX_WORDS);
  cache = { at: Date.now(), words };
  return words;
}
