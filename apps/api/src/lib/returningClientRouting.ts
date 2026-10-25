import { prisma } from "../db.js";
import { requestedAgentStillAvailable } from "./requestedAgent.js";
import { absenceKindOf } from "./agentAvailability.js";
import { SALES_AGENT_ROLES } from "@royal-home/shared";

/**
 * КОМУ ДОСТАЁТСЯ ВЕРНУВШИЙСЯ КЛИЕНТ (владелец 08.09.2026, ПЕРЕПИСАНО 16.09.2026).
 *
 * Карточка была неактивной, потерянной, закрытой или удалённой, клиент вдруг сам
 * написал или позвонил. Кому его отдать?
 *
 * ГЛАВНОЕ ПРАВИЛО, КОТОРОЕ ОТМЕНЯЕТ ВСЕ ПРЕЖНИЕ РАЗВИЛКИ (владелец 16.09.2026,
 * дословно): «Продавец никогда не уходит. Даже если агент в отпуске или на
 * больничном». И шире: «Только я могу передавать продавца или покупателя. А не
 * система».
 *
 * Раньше здесь стояли три разных ответа: смотрели, есть ли у продавца объект в
 * работе, был ли у покупателя состоявшийся разговор, и какой именно вид отсутствия
 * у агента. Все три отменены — они решали задачу компании («вернувшемуся нужно
 * физическое действие, а человек в отпуске его не сделает») ценой того, что система
 * забирала карточку у агента без его и без владельца ведома.
 *
 * ОСТАЛОСЬ ДВА ПРАВИЛА:
 *
 *   ПРОДАВЕЦ ОСТАЁТСЯ ЗА СВОИМ АГЕНТОМ ВСЕГДА. Объект продаётся силами всей
 *   компании, пока его человек в отъезде, — продавец ничего не теряет, и бот
 *   говорит ему ровно это (lib/absentAgentNotice.ts, ветка "kept"). Объект при
 *   этом может быть ещё не заведён: ждать его — не повод отнимать карточку.
 *
 *   ПОКУПАТЕЛЬ ТОЖЕ ОСТАЁТСЯ ЗА СВОИМ АГЕНТОМ при любом отсутствии (владелец
 *   23.09.2026: «заморозка — только чтобы не приходили новые, продавцы и
 *   покупатели, которые сейчас у него, остаются у него», иначе рушится его KPI).
 *   До этого при отпуске покупатель уходил в общую очередь. Владельцу уходит
 *   уведомление, что человек вернулся, а его агента нет: передать или нет,
 *   решает владелец, а не тик.
 *
 * ПАУЗА «НЕ ПРИНИМАЮ НОВЫХ ЛИДОВ» ОТСУТСТВИЕМ НЕ СЧИТАЕТСЯ. Человек просил закрыть
 * ВХОД именно затем, чтобы спокойно доработать своих перед отпуском; вернувшийся
 * свой клиент входом не является.
 */

export type ReturningRoute =
  /** Остаётся за прежним агентом без всякого предложения — карточка просто оживает. */
  | {
      kind: "keep";
      agentId: string;
      /** seller-absent-agent — продавец при любом отсутствии агента; buyer-sick-agent —
       *  покупатель при больничном: карточка остаётся, решение за владельцем. */
      reason: "seller-absent-agent" | "buyer-sick-agent" | "buyer-absent-agent";
      /** Владельцу нужно узнать об этом случае: он решает, передавать или нет. */
      notifyOwner: boolean;
    }
  /** Предлагаем прежнему агенту: он решает, принять или отдать. */
  | { kind: "offer"; agentId: string }
  /** Прежнему не предлагаем — обычная раздача по очереди. */
  | { kind: "queue"; reason: "no-agent" | "unavailable" };

/**
 * ПРЕЖНИЙ АГЕНТ МОЖЕТ ПРИНЯТЬ СВОЕГО ВЕРНУВШЕГОСЯ КЛИЕНТА? (02.10.2026, B1 глубокой
 * проверки). Одно правило для всех путей возврата — сообщение в привязанную
 * переписку, звонок, заявка: уволенный, замороженный и не-агент — нет; пауза
 * «не принимаю новых лидов» — НЕ помеха (см. шапку файла: пауза закрывает вход,
 * а свой вернувшийся клиент входом не является).
 *
 * Раньше пути возврата из «Потерянных» звали голую requestedAgentStillAvailable,
 * а она паузу считает недоступностью — агент на паузе терял своего клиента в
 * очередь руководителя. Заморозку проверяем явно: пути возврата из «Потерянных»
 * не проходят через absenceKindOf, и замороженный агент с включённой паузой
 * иначе выглядел бы «только на паузе».
 */
export async function returningAgentStillAvailable(agentId: string | null | undefined): Promise<string | null> {
  if (!agentId) return null;
  const available = await requestedAgentStillAvailable(agentId);
  if (available) return available;
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { isActive: true, role: true, frozenAt: true, leadsPausedUntil: true },
  });
  const blockedOnlyByPause =
    agent?.isActive === true && (SALES_AGENT_ROLES as readonly string[]).includes(agent.role) && agent.frozenAt === null && agent.leadsPausedUntil !== null;
  return blockedOnlyByPause ? agentId : null;
}

/** P8: доступный текущий владелец, затем исторический, иначе AUTO-очередь.
 * Уточнение владельца 25.10.2026: при восстановлении любая заморозка,
 * включая отпуск/больничный, исключает прежнего агента. Пауза новых лидов
 * не исключает своего клиента. Прямую политику отсутствия для уже активной
 * работы в decideReturningClient это исключение не меняет. */
export async function preferredReturningOwnerId(currentId: string | null, historicalId: string | null): Promise<string | null> {
  for (const id of [...new Set([currentId, historicalId].filter((value): value is string => !!value))]) {
    const agent = await prisma.agent.findUnique({ where: { id }, select: { isActive: true, role: true, frozenAt: true } });
    if (agent?.isActive && agent.frozenAt === null && (SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) return id;
  }
  return null;
}

export interface ReturningClientInput {
  clientId: string;
  kind: string;
  lastAgentId: string | null;
}


export async function decideReturningClient(input: ReturningClientInput): Promise<ReturningRoute> {
  // «Прочее обращение» агенту не назначается вовсе — решать нечего.
  if (input.kind === "OTHER" || !input.lastAgentId) return { kind: "queue", reason: "no-agent" };

  const absence = await absenceKindOf(input.lastAgentId);
  const absent = absence !== null;

  if (!absent) {
    /**
     * Агент на месте — предлагаем ему, как и раньше. Сюда же попадает пауза «не
     * принимаю новых лидов»: она закрывает только ВХОД, а свой вернувшийся клиент
     * входом не является (см. шапку файла).
     */
    const available = await returningAgentStillAvailable(input.lastAgentId);
    if (available) return { kind: "offer", agentId: available };
    return { kind: "queue", reason: "unavailable" };
  }

  /**
   * Дальше — агента нет на работе. Раньше здесь смотрели объект у продавца,
   * состоявшийся разговор у покупателя и вид отсутствия — три развилки. Осталось
   * одно различие: продавец не уходит никогда, покупатель уходит только при отпуске.
   */
  if (input.kind === "SELLER") {
    // Объект может быть ещё не заведён — это не повод отнимать карточку. Бот
    // объяснит продавцу, что его квартиру продаёт вся компания, пока агента нет.
    return { kind: "keep", agentId: input.lastAgentId, reason: "seller-absent-agent", notifyOwner: false };
  }

  // Любое отсутствие (отпуск, больничный, разбирательство): карточка остаётся за
  // агентом, а владельцу уходит строка — передавать или нет, решает он.
  return {
    kind: "keep",
    agentId: input.lastAgentId,
    reason: absence === "VACATION" ? "buyer-absent-agent" : "buyer-sick-agent",
    notifyOwner: true,
  };
}
