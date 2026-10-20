import { prisma } from "../db.js";

/**
 * ПОЧЕМУ ЛИД ДОСТАЛСЯ ИМЕННО ВАМ — строка для экранов принятия (23.09.2026).
 *
 * Распределение (services/leads/assignment.ts) давно отдаёт лид агенту объекта,
 * о котором спрашивал клиент, и пишет причину в `Client.assignReason` и сам
 * объект в `Client.matchedPropertyId`. Но окно «Новый клиент» на телефоне,
 * строки «Ждут вашего принятия» на Главной и карточка до приёма этого не
 * показывали: агент принимал лид вслепую и не знал, что клиент пришёл по его же
 * объекту. Процент совпадения выводился только для `own_property_match`.
 *
 * Гейт «до приёма только имя» (routes/clients/list.ts, card.ts) эта строка не
 * пробивает: она говорит про ВАШ объект и про то, почему лид ваш, а не про
 * бюджет, район или контакты клиента — ровно как matchScore, который гейт
 * намеренно оставляет.
 *
 * Текст собирается здесь, в одном месте для списка и карточки, чтобы ПК,
 * телефон и окно приёма не держали по своей копии формулировок.
 */

export interface LeadReason {
  /** Готовая строка для экрана: «Спрашивал про ваш объект №12 «1-комн · Сино»». */
  text: string;
  /** Объект, если причина — объект и он не удалён: экран делает из него ссылку. */
  propertyShortId: number | null;
}

type ReasonInput = { assignReason: string | null; matchedPropertyId: string | null };
type PropertyRef = { shortId: number; title: string; deletedAt: Date | null };

const PROPERTY_REASON_VERB: Record<string, string> = {
  instagram_post_link: "Прислал ссылку на пост вашего объекта",
  own_property_explicit: "Спрашивал про ваш объект",
  own_property_shown: "Бот показывал ему ваш объект",
  own_property_match: "Ищет похожее на ваш объект",
};

/** Руководитель сам назначил клиента агенту (routes/clients/lifecycle.ts, /assign). */
export const SUPERVISOR_ASSIGN_REASON = "supervisor_assigned";

/**
 * Клиент пришёл агенту «Передачей дел» руководителя (lib/agentHandover.ts).
 * Решение владельца 02.10.2026 (B7): такой клиент сразу принят — его не
 * трогают ни карусель «не принял», ни срок «первый звонок за 15 минут».
 */
export const HANDOVER_ASSIGN_REASON = "handover";

/** Чистая сборка строки — отдельно от базы, чтобы её можно было проверить тестом. */
export function leadReasonText(c: ReasonInput, property: PropertyRef | null): LeadReason | null {
  if (c.assignReason === "requested_by_client") {
    return { text: "Клиент сам назвал вас", propertyShortId: null };
  }
  if (c.assignReason === SUPERVISOR_ASSIGN_REASON) {
    return { text: "Назначил руководитель", propertyShortId: null };
  }
  if (c.assignReason === HANDOVER_ASSIGN_REASON) {
    return { text: "Передал руководитель из дел другого сотрудника", propertyShortId: null };
  }
  const verb = c.assignReason ? PROPERTY_REASON_VERB[c.assignReason] : undefined;
  if (!verb) return null;
  if (!property) return { text: verb, propertyShortId: null };
  const trashed = property.deletedAt !== null;
  return {
    text: `${verb} №${property.shortId} «${property.title}»${trashed ? " (объект удалён)" : ""}`,
    propertyShortId: trashed ? null : property.shortId,
  };
}

/** Причины для страницы клиентов ОДНИМ запросом объектов, без N+1. */
export async function loadLeadReasons(clients: readonly (ReasonInput & { id: string })[]): Promise<Map<string, LeadReason>> {
  const propertyIds = [
    ...new Set(clients.map((c) => (c.assignReason && PROPERTY_REASON_VERB[c.assignReason] ? c.matchedPropertyId : null)).filter((v): v is string => !!v)),
  ];
  const properties = propertyIds.length
    ? await prisma.property.findMany({
        where: { id: { in: propertyIds } },
        select: { id: true, shortId: true, title: true, deletedAt: true },
      })
    : [];
  const byId = new Map(properties.map((p) => [p.id, p]));
  const result = new Map<string, LeadReason>();
  for (const c of clients) {
    const reason = leadReasonText(c, c.matchedPropertyId ? byId.get(c.matchedPropertyId) ?? null : null);
    if (reason) result.set(c.id, reason);
  }
  return result;
}
