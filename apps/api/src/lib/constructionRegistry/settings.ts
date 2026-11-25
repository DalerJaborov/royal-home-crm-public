/**
 * Рубильники реестра строек (Настройки → Каналы). Отдельный лёгкий модуль без зависимостей от sync/link/view:
 * его зовут все три, и общий импорт через sync.ts давал бы цикл (audit:deps, no-circular).
 */
import { prisma } from "../../db.js";

export async function loadRegistrySettings(): Promise<{ enabled: boolean; notify: boolean }> {
  try {
    const row = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { constructionRegistryEnabled: true, constructionRegistryNotify: true },
    });
    return { enabled: row?.constructionRegistryEnabled !== false, notify: row?.constructionRegistryNotify !== false };
  } catch {
    return { enabled: true, notify: true };
  }
}
