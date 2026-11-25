import type { RegistryChoice } from "@royal-home/shared";
import { prisma } from "../../db.js";
import type { PropertyAccessActor } from "../propertyAccess.js";
import { canEditRegistryLinkAs } from "./access.js";
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

export type RegistryChoiceOutcome =
  | AutoLinkOutcome
  | "picked"
  | "not-in-registry"
  /** «Нет в реестре», а отвергать нечего: у объекта нет точки или рядом нет проектов. Ничего не записано. */
  | "nothing-to-reject"
  /** Проекта нет, он пропал из реестра или он не жилой: связь не поставлена. */
  | "unknown-project"
  | "forbidden"
  /** Рубильник реестра выключен: выбор не применяется. */
  | "off";

/** Текст «выбор не сохранился» для ответа создания и правки; null — сохранилось (или нечего было сохранять). */
export const REGISTRY_NOTHING_TO_REJECT =
  "«Нет в реестре» не сохранилось: у объекта нет точки на карте или рядом нет проектов реестра, отмечать нечего.";
export function registryChoiceError(outcome: RegistryChoiceOutcome | null): string | null {
  if (outcome === null) return "Выбор застройщика не сохранился. Повторите в карточке объекта.";
  if (outcome === "nothing-to-reject") return REGISTRY_NOTHING_TO_REJECT;
  if (outcome === "unknown-project") return "Выбранного проекта уже нет в реестре строек. Выберите другой в карточке объекта.";
  if (outcome === "forbidden") return "Менять привязку к реестру может ответственный агент или руководитель.";
  return null;
}

/**
 * ВЫБОР СОТРУДНИКА В ПОЛЕ «ЗАСТРОЙЩИК И РАЗРЕШЕНИЕ» ВМЕСТЕ С СОХРАНЕНИЕМ ОБЪЕКТА (25.11.2026): мастер, форма правки.
 * Той же дверью, что и автосвязь: без выбора — автосвязь как раньше; выбран проект — ручная связь (MANUAL, автоматика её
 * больше не трогает); «нет в реестре» — связь снимается, проекты рядом отвергаются. Права — то же правило, что у карточки и
 * Шабнам (canEditRegistryLinkAs). Ошибка не роняет сохранение объекта, но возвращается (null) — ответ сохранения несёт
 * registryError, сотрудник видит «не сохранилось» (ревью PR #441).
 */
export async function applyRegistryChoice(
  propertyId: string,
  choice: RegistryChoice | undefined,
  actor: PropertyAccessActor,
): Promise<RegistryChoiceOutcome | null> {
  if (!choice) return autoLinkPropertyById(propertyId, actor.agentId);
  try {
    if (!(await loadRegistrySettings()).enabled) return "off";
    const property = await prisma.property.findFirst({
      where: { id: propertyId, deletedAt: null },
      select: { assignedAgentId: true, intakeAgentId: true, createdById: true },
    });
    if (!property || !canEditRegistryLinkAs(actor, property)) return "forbidden";
    if (choice.kind === "none") {
      const rejected = await markNotInRegistry(propertyId, actor.agentId);
      return rejected > 0 ? "not-in-registry" : "nothing-to-reject";
    }
    // Только живой жилой проект: пропавший из реестра или школа/больница в связь не ставятся (ревью PR #441).
    const project = await prisma.constructionProject.findFirst({
      where: { id: choice.projectId, removedAt: null, category: "residential" },
      select: { id: true },
    });
    if (!project) {
      // Выбор не годится — решает автоматика, как будто выбора не было; сотруднику — что выбор не сохранился.
      await autoLinkProperty(propertyId, { actorId: actor.agentId, notify: true });
      return "unknown-project";
    }
    await linkPropertyManually(propertyId, project.id, actor.agentId);
    return "picked";
  } catch (err) {
    void logSystemError("api", `Реестр строек: выбор сотрудника для объекта ${propertyId} не сохранён: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}