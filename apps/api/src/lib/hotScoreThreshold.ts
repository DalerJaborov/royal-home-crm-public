import { prisma } from "../db.js";

/**
 * Единственный порог «высокий скоринг» на всю CRM — Settings.hotScoreThreshold
 * (по умолчанию 70). Им уже пользовалась автопередача после отказа; аудит 02.09.2026
 * (03-alarms.md §6.1 B) нашёл рядом ещё два зашитых числа (85 в пульте/подсказках,
 * 70 в алармах) — теперь все читают отсюда, менять порог = одно поле в Настройках.
 */
export async function loadHotScoreThreshold(): Promise<number> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { hotScoreThreshold: true } });
  return s?.hotScoreThreshold ?? 70;
}
