/**
 * ГРУППИРОВКА ВЕРОЯТНЫХ ДУБЛИКАТОВ КЛИЕНТОВ — общая логика для экрана
 * routes/clients/duplicates.ts (GET /duplicates, кнопка «Дубли» в «Клиентах»)
 * и еженедельного напоминания руководству (lib/duplicatesWeeklyDigest.ts,
 * владелец 06.09.2026, разбор слепых зон п.3): обоим нужен один и тот же
 * список групп — разошедшийся код однажды показал бы разные числа на экране
 * и в напоминании.
 *
 * Совпадение нормализованного телефона (последние 9 цифр) ИЛИ телеграм-
 * аккаунта (chatId/username) — только эти два сигнала однозначно
 * идентифицируют человека. Совпадение одного лишь ФИО НЕ считается
 * дубликатом: распространённые имена регулярно принадлежат разным людям, а в
 * Telegram имя вообще произвольный текст.
 */
import { prisma } from "../db.js";

// Поиск дублей группирует ВСЮ выборку разом (совпадение может «разъехаться» по
// разным страницам и не найтись при обычной пагинации) — поэтому явный потолок
// вместо тихого роста памяти/времени ответа по мере роста базы.
export const DUPLICATES_SCAN_LIMIT = 20_000;

export interface DuplicateGroupClient {
  id: string;
  fullName: string;
  phone: string;
  status: string;
  source: string;
  createdAt: Date;
  telegramChatId: string | null;
  telegramUsername: string | null;
  assignedAgent: { id: string; fullName: string } | null;
  _count: { interactions: number; deals: number };
}

export type DuplicateGroupsResult =
  | {
      overLimit: false;
      groups: { clients: DuplicateGroupClient[] }[];
      /**
       * Весь просмотренный список и карта «клиент → номер группы» — отдаются
       * наружу ради ВТОРОГО, более осторожного прохода по тем же данным
       * (похожее имя + похожий номер, lib/duplicateReview.ts::findFuzzyDuplicatePairs,
       * раздел L уровень 4 от 03.09.2026). Иначе тот проход означал бы второй
       * поход в базу за тем же самым списком, а карта нужна ему, чтобы не
       * повторять пару, уже показанную как надёжное совпадение.
       */
      scanned: DuplicateGroupClient[];
      clientToGroup: Map<string, number>;
    }
  | { overLimit: true; candidateCount: number };

export async function findDuplicateClientGroups(): Promise<DuplicateGroupsResult> {
  // OTHER (работа/аренда/прочее) не назначается агенту — вне обычного дубликат-слияния.
  // deletedAt — карточка из Корзины удалена сознательно, предлагать её к слиянию
  // (и тем самым воскрешать её данные в живом клиенте) не нужно.
  const scanWhere = { kind: { not: "OTHER" as const }, deletedAt: null };
  const candidateCount = await prisma.client.count({ where: scanWhere });
  if (candidateCount > DUPLICATES_SCAN_LIMIT) {
    return { overLimit: true, candidateCount };
  }

  const clients = await prisma.client.findMany({
    where: scanWhere,
    select: {
      id: true,
      fullName: true,
      phone: true,
      status: true,
      source: true,
      createdAt: true,
      telegramChatId: true,
      telegramUsername: true,
      assignedAgent: { select: { id: true, fullName: true } },
      _count: { select: { interactions: true, deals: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const groups = new Map<string, DuplicateGroupClient[]>();
  const keysOf = (c: DuplicateGroupClient): string[] => {
    const keys: string[] = [];
    const digits = c.phone.replace(/[^\d]/g, "");
    if (digits.length >= 7) keys.push(`p:${digits.slice(-9)}`);
    if (c.telegramChatId) keys.push(`tc:${c.telegramChatId}`);
    if (c.telegramUsername) keys.push(`tu:${c.telegramUsername.trim().toLowerCase()}`);
    return keys;
  };
  for (const c of clients) {
    for (const key of keysOf(c)) {
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
  }

  // Один и тот же человек мог засветиться сразу по нескольким ключам (телефон +
  // Telegram) — группы, у которых есть общий клиент, схлопываем в одну связную
  // компоненту (union-find по порядковому номеру клиента). Жадное «дописать в
  // первую найденную группу» оставляло мост между ДВУМЯ уже собранными группами
  // нетронутым: один клиент попадал в две группы, а еженедельная сводка считала
  // две пары вместо одной (аудит Codex 04.10.2026, ACCESS-09).
  const position = new Map(clients.map((c, i) => [c.id, i]));
  const parent = clients.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const inGroup = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = position.get(group[0].id)!;
    for (const c of group) {
      const i = position.get(c.id)!;
      inGroup.add(i);
      parent[find(i)] = find(first);
    }
  }
  // Клиенты идут в хронологическом порядке (orderBy createdAt asc выше), поэтому
  // и порядок компонент, и состав каждой — по первому появлению.
  const byRoot = new Map<number, DuplicateGroupClient[]>();
  const groupIndex = new Map<number, number>();
  const clientToGroup = new Map<string, number>();
  clients.forEach((c, i) => {
    if (!inGroup.has(i)) return;
    const root = find(i);
    let list = byRoot.get(root);
    if (!list) {
      list = [];
      byRoot.set(root, list);
      groupIndex.set(root, groupIndex.size);
    }
    list.push(c);
    clientToGroup.set(c.id, groupIndex.get(root)!);
  });
  const merged = [...byRoot.values()];

  return { overLimit: false, groups: merged.map((clients) => ({ clients })), scanned: clients, clientToGroup };
}
