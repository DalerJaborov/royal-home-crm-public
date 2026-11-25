import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { autoLinkProperty, MATCH_PROPERTY_SELECT, toMatchInput, type AutoLinkOutcome } from "./link.js";
import { loadRegistrySettings } from "./sync.js";

/**
 * ОДНА ДВЕРЬ «ОБЪЕКТ ПОЯВИЛСЯ ИЛИ СМЕНИЛ АДРЕС/ТОЧКУ → СВЕРИТЬ С РЕЕСТРОМ» (21.11.2026, расширено 25.11.2026).
 * Зовут её все пути, которые создают объект или меняют то, по чему он сопоставляется (адрес, точка, состояние, название,
 * описание): форма CRM и мастер, черновик Шабнам (тот же createProperty), объект с сайта и принятая правка с сайта,
 * принятая заявка на правку, геокодер, точка из GPS фото. Импорт CSV точку не ставит — ему сверять нечем.
 * Список путей держит сторож tests/construction-registry-autolink-paths.test.ts.
 *
 * Фоновый вызов: не роняет сохранение, ошибка — в журнал. Ничего не делает, если рубильник выключен или у объекта нет
 * точки; ручную связь не трогает; сомнительное оставляет человеку; уже стоящую AUTO-связь пересчитывает (link.ts).
 */
export async function autoLinkPropertyById(propertyId: string): Promise<AutoLinkOutcome | null> {
  try {
    if (!(await loadRegistrySettings()).enabled) return null;
    const p = await prisma.property.findFirst({
      where: { id: propertyId, deletedAt: null, lat: { not: null }, lng: { not: null } },
      select: MATCH_PROPERTY_SELECT,
    });
    return p ? await autoLinkProperty(toMatchInput(p)) : null;
  } catch (err) {
    void logSystemError("api", `Реестр строек: автосвязь объекта ${propertyId} не удалась: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
