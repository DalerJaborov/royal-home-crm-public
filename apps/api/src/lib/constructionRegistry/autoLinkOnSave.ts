import { logSystemError } from "../systemError.js";
import { autoLinkProperty, type AutoLinkOutcome } from "./link.js";
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
