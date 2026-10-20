import { prisma } from "../db.js";

/**
 * АВТОЗАКРЫТИЕ ДУБЛЕЙ ОШИБОК (18.08.2026, решение владельца: часть автоматики
 * мониторинга здоровья системы).
 *
 * `logSystemError` дедупит одну и ту же поломку только в окне 10 минут — при
 * длительном сбое (например Gemini недоступен несколько часов) это всё равно
 * даёт десятки отдельных неразобранных строк с одинаковым source+message,
 * которые директор разбирает вручную одну за другой кнопкой «Разобрался».
 * Здесь то же самое происходит само: из каждой группы одинаковых неразобранных
 * ошибок остаётся открытой только САМАЯ СВЕЖАЯ (по ней видно, что проблема ещё
 * жива и когда она давала знать о себе в последний раз), а более старые копии
 * помечаются разобранными — они не несут новой информации, только повторяют её.
 *
 * Ошибки, которые сотрудник уже разбирал руками, не трогаем: `resolvedById`
 * автозакрытия оставляем `null`, чтобы в интерфейсе было видно, что это не
 * человек — resolvedAt при этом заполнен, иначе группировка считала бы их
 * неразобранными снова на следующем проходе.
 */
export async function autoResolveDuplicateErrors(): Promise<number> {
  const groups = await prisma.errorLog.groupBy({
    by: ["source", "message"],
    where: { resolvedAt: null },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });
  if (groups.length === 0) return 0;

  let resolved = 0;
  for (const group of groups) {
    const rows = await prisma.errorLog.findMany({
      where: { source: group.source, message: group.message, resolvedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const staleIds = rows.slice(1).map((r) => r.id);
    if (staleIds.length === 0) continue;
    const { count } = await prisma.errorLog.updateMany({
      where: { id: { in: staleIds } },
      data: { resolvedAt: new Date() },
    });
    resolved += count;
  }
  return resolved;
}
