import type { RegistryChoice } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { autoLinkProperty, linkPropertyManually, markNotInRegistry, type AutoLinkOutcome } from "./link.js";
import { loadRegistrySettings } from "./settings.js";

/**
 * ОДНА ДВЕРЬ «ОБЪЕКТ ПОЯВИЛСЯ ИЛИ СМЕНИЛ АДРЕС/ТОЧКУ → СВЕРИТЬ С РЕЕСТРОМ» (21.11.2026, расширено 25.11.2026).
 * Зовут её все пути, которые создают объект или меняют то, по чему он сопоставляется (адрес, точка, состояние, название,
 * описание): форма CRM и мастер, черновик Шабнам (тот же createProperty), объект с сайта и принятая правка с сайта,
 * принятая заявка на правку, геокодер (и когда точку нашёл, и когда адрес не нашёлся), точка из GPS фото.
 * Импорт CSV точку не ставит — ему сверять нечем. Список путей держит сторож tests/construction-registry-autolink-paths.test.ts.
 *
 * Фоновый вызов: не роняет сохранение, ошибка — в журнал. Рубильник выключен — ничего. Объект без точки — его AUTO-связи
 * снимаются (адрес сменили, точку стёрли). Ручную связь не трогает; сомнительное оставляет человеку.
 * `actorId` — кто сохранил: ему сообщение в ленту про жёлтый/красный не уходит.
 */
export async function autoLinkPropertyById(propertyId: string, actorId: string | null = null): Promise<AutoLinkOutcome | null> {
  try {
    if (!(await loadRegistrySettings()).enabled) return null;
    return await autoLinkProperty(propertyId, { actorId, notify: true });
  } catch (err) {
    void logSystemError("api", `Реестр строек: автосвязь объекта ${propertyId} не удалась: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export type RegistryChoiceOutcome = AutoLinkOutcome | "picked" | "not-in-registry" | "unknown-project";

/**
 * ВЫБОР СОТРУДНИКА В ПОЛЕ «ЗАСТРОЙЩИК И РАЗРЕШЕНИЕ» ВМЕСТЕ С СОХРАНЕНИЕМ ОБЪЕКТА (25.11.2026): мастер, форма правки.
 * Той же дверью, что и автосвязь: без выбора — автосвязь как раньше; выбран проект — ручная связь (MANUAL, автоматика её
 * больше не трогает); «нет в реестре» — связь снимается, проекты рядом отвергаются. Фон: не роняет сохранение, ошибка в
 * журнал. Рубильник выключен — ничего. Права проверяет маршрут сохранения (создатель объекта или тот, кто его правит).
 */
export async function applyRegistryChoice(
  propertyId: string,
  choice: RegistryChoice | undefined,
  actorId: string,
): Promise<RegistryChoiceOutcome | null> {
  if (!choice) return autoLinkPropertyById(propertyId, actorId);
  try {
    if (!(await loadRegistrySettings()).enabled) return null;
    if (choice.kind === "none") {
      await markNotInRegistry(propertyId, actorId);
      return "not-in-registry";
    }
    const project = await prisma.constructionProject.findUnique({ where: { id: choice.projectId }, select: { id: true } });
    // Проекта нет (подложный id или реестр перезабрали) — решает автоматика, как будто выбора не было.
    if (!project) {
      await autoLinkProperty(propertyId, { actorId, notify: true });
      return "unknown-project";
    }
    await linkPropertyManually(propertyId, project.id, actorId);
    return "picked";
  } catch (err) {
    void logSystemError("api", `Реестр строек: выбор сотрудника для объекта ${propertyId} не сохранён: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
