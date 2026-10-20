import { prisma } from "../db.js";

/**
 * Ключ группы находок судьи (17.09.2026, тот же приём, что уже жил внутри
 * routes/botAudit.ts GET "/" — вынесен сюда, чтобы routes/botAudit.ts и
 * ai/botAudit.ts (создание находок) читали ОДНО значение, а не считали его
 * заново каждый по-своему и не разъехались молча).
 *
 * type + первые 60 знаков `why` в нижнем регистре: судья формулирует «why»
 * чуть по-разному от диалога к диалогу даже для одного и того же нарушения,
 * а первые слова обычно называют суть («Повторно спросил то, что клиент уже
 * сказал», «Выдумал скидку 10%») — точнее не разойдётся, а дороже считать смысл
 * находок моделью тут не стоит.
 */
export const GROUP_KEY_LEN = 60;

export function groupWhyPrefix(why: string): string {
  return why.slice(0, GROUP_KEY_LEN).toLowerCase();
}

export function groupKey(type: string, why: string): string {
  return `${type}::${groupWhyPrefix(why)}`;
}

/** Сколько записей журнала действий сканируем в поисках закрытых групп. Предел —
 *  тот же принцип, что и везде в файле: полный проход по вечно растущему
 *  AuditLog на каждый запуск судьи слишком дорог, а последних записей достаточно,
 *  чтобы не гонять просмотренное. */
const CLOSED_GROUPS_SCAN_LIMIT = 2000;

/**
 * Группы (type+why), которые владелец уже закрыл вердиктом «бот прав» — судья
 * не должен заводить по ним новые находки заново (17.09.2026, «повторы
 * исключить полностью»). Источник — журнал действий (AuditLog): отдельного
 * поля «вердикт» на BotAuditFinding в схеме нет и заводить его в этой задаче
 * нельзя, а `logAudit` уже пишет verdict/type/why в `meta` при каждом решении
 * по находке (см. routes/botAudit.ts, resolve и group/resolve).
 */
export async function getClosedGroupKeys(): Promise<Set<string>> {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: ["BOT_AUDIT_RESOLVE", "BOT_AUDIT_RESOLVE_GROUP"] },
      meta: { path: ["verdict"], equals: "bot_right" },
    },
    orderBy: { createdAt: "desc" },
    take: CLOSED_GROUPS_SCAN_LIMIT,
    select: { meta: true },
  });
  const keys = new Set<string>();
  for (const row of rows) {
    const meta = row.meta as { type?: unknown; why?: unknown } | null;
    if (!meta || typeof meta.type !== "string" || typeof meta.why !== "string") continue;
    keys.add(groupKey(meta.type, meta.why));
  }
  return keys;
}
