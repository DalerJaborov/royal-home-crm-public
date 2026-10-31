import { z } from "zod";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import {
  bookShowing,
  findActiveShowing,
  findAgentShowingConflict,
  isReplacementOfOtherShowing,
  showingTimeLabel,
  validateExactShowingSlot,
  SHOWING_HOURS_LAST,
  SHOWING_HOURS_START,
  type BookingProblem,
  type SlotProblem,
} from "../../../lib/showingBooking.js";
import { dushanbeDateString, dushanbeTimeString } from "../../../lib/dushanbeTime.js";
import { assertClientWritable } from "../actor.js";
import { asPluginExecutor, loadToolActor, requireShowingInstant, showingTimeText, TIME_PARAM_DESCRIPTION } from "./showingToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * book_showing — назначить клиенту показ объекта (уровень C, П3 группа show).
 *
 * Исполняет СУЩЕСТВУЮЩИЙ сервис `bookShowing` (lib/showingBooking.ts): часы 09:00–20:00,
 * запас 30 минут, горизонт 30 дней, перенос вместо второй встречи, уведомление агента и
 * продавца, счётчик интереса — всё внутри него, ничего своего здесь нет. Помощник только
 *  - проверяет права ТЕМИ ЖЕ функциями, что POST /clients/:id/interactions (скоуп «свои»,
 *    принятый лид, `assertClientWritable` = foreignWriteDenied);
 *  - заранее считает, что именно сделает сервис (создаст / сдвинет / заменит другой
 *    показ), и показывает это в превью — иначе «назначить» молча перенесло бы чужую встречу;
 *  - вызывает сервис с `reportFailures: false`: отказ идёт сотруднику в чат, а не записью
 *    «Бот не смог назначить показ» и push коллеге.
 */
const argsSchema = z.object({
  clientId: z.string().trim().min(1).max(64),
  propertyId: z.string().trim().min(1).max(64),
  at: z.string().trim().min(1).max(40),
});
type Args = z.infer<typeof argsSchema>;

const SLOT_MESSAGES: Record<SlotProblem, string> = {
  no_time: "Время показа не распознано",
  outside_hours: `Показы назначаются с ${SHOWING_HOURS_START} до ${SHOWING_HOURS_LAST} по Душанбе`,
  past: "Это время уже прошло или наступит меньше чем через 30 минут",
  too_far: "Показ можно назначить не дальше чем на 30 дней вперёд",
};

/** Отказ сервиса → ответ помощника. Состояние поменялось под нами — 409 STALE. */
function bookingError(reason: BookingProblem): AssistantActionError {
  switch (reason) {
    case "no_client":
      return new AssistantActionError(404, "NOT_FOUND", "Клиент не найден");
    case "no_property":
      return new AssistantActionError(404, "NOT_FOUND", "Объект не найден");
    case "unavailable":
      return new AssistantActionError(409, "STALE", "Объект уже недоступен для показа");
    case "no_agent":
      return new AssistantActionError(409, "NO_AGENT", "За клиентом и объектом не закреплён агент — некому вести показ");
    default:
      return new AssistantActionError(422, `SLOT_${reason.toUpperCase()}`, SLOT_MESSAGES[reason]);
  }
}

type Plan = "create" | "same" | "reschedule" | "replace_other";

async function resolveProperty(propertyId: string) {
  const select = { id: true, shortId: true, title: true, status: true, deletedAt: true, assignedAgentId: true } as const;
  return /^\d+$/.test(propertyId)
    ? prisma.property.findFirst({ where: { shortId: Number(propertyId) }, select })
    : prisma.property.findUnique({ where: { id: propertyId }, select });
}

export const bookShowingExecutor: AssistantActionExecutor<Args> = {
  tool: "book_showing",
  channels: ["crm", "telegram"],
  parseArgs(raw) {
    const parsed = argsSchema.parse(raw);
    return { ...parsed, at: requireShowingInstant(parsed.at) };
  },

  async snapshot(args, actionActor) {
    const { actor } = await loadToolActor(actionActor);
    const now = new Date();
    const client = await prisma.client.findUnique({
      where: { id: args.clientId },
      select: {
        id: true, fullName: true, assignedAgentId: true, acceptedAt: true, deletedAt: true, assignmentCompletedAt: true,
      },
    });
    // Корзина и непринятый лид рядового агента — «нет такого клиента», как в REST и create_task.
    const ownScope = actor.canViewAllClients ? undefined : actor.id;
    if (!client || client.deletedAt !== null || (ownScope && client.acceptedAt === null)) {
      throw new AssistantActionError(404, "NOT_FOUND", "Клиент не найден");
    }
    const denied = assertClientWritable(actor, client);
    if (denied) throw new AssistantActionError(403, "FORBIDDEN", denied);

    const property = await resolveProperty(args.propertyId);
    if (!property || property.deletedAt) throw new AssistantActionError(404, "NOT_FOUND", "Объект не найден");
    if (property.status !== "AVAILABLE") {
      throw new AssistantActionError(409, "PROPERTY_UNAVAILABLE", "Объект уже недоступен для показа — показ не назначить");
    }

    const at = new Date(args.at);
    const slot = validateExactShowingSlot(at, now);
    if (!slot.ok) throw bookingError(slot.reason);

    const agentId = client.assignedAgentId ?? property.assignedAgentId;
    if (!agentId) throw bookingError("no_agent");

    // Что сделает bookShowing — теми же запросами и тем же правилом, что он сам.
    const sameProperty = await findActiveShowing({ clientId: client.id, propertyId: property.id, now });
    const other = sameProperty ? null : await findActiveShowing({ clientId: client.id, now });
    const replaced = other?.nextActionDate && isReplacementOfOtherShowing("book", other.nextActionDate, at) ? other : null;
    const existing = sameProperty ?? replaced;
    const plan: Plan = !existing
      ? "create"
      : replaced
        ? "replace_other"
        : sameProperty!.nextActionDate!.getTime() === at.getTime()
          ? "same"
          : "reschedule";

    // Занятость агента входит в снимок: превью с предупреждением «агент занят» нельзя склеить
    // с превью без него (брокер склеивает одинаковые просьбы по снимку), и появление
    // конфликта между превью и «Подтвердить» человек увидит заново.
    const busy = await findAgentShowingConflict({ agentId, at, excludeClientId: client.id, now });

    return {
      clientId: client.id,
      propertyId: property.id,
      propertyStatus: property.status,
      agentId,
      busyShowingId: busy?.id ?? null,
      plan,
      existing: existing
        ? { id: existing.id, at: existing.nextActionDate!.toISOString(), propertyId: existing.propertyId, propertyTitle: existing.property?.title ?? null }
        : null,
    };
  },

  async buildPreview(args, snapshot, actionActor) {
    const { actor } = await loadToolActor(actionActor);
    const at = new Date(args.at);
    const [client, property, agent] = await Promise.all([
      prisma.client.findUniqueOrThrow({ where: { id: String(snapshot.clientId) }, select: { fullName: true } }),
      prisma.property.findUniqueOrThrow({ where: { id: String(snapshot.propertyId) }, select: { title: true } }),
      prisma.agent.findUnique({ where: { id: String(snapshot.agentId) }, select: { fullName: true } }),
    ]);
    const existing = snapshot.existing as { at: string; propertyTitle: string | null } | null;
    const plan = snapshot.plan as Plan;
    const warnings: string[] = [];
    if (plan === "same") warnings.push("На это время показ уже назначен — ничего не изменится.");
    if (plan === "reschedule") warnings.push("У клиента уже есть показ этого объекта — он будет перенесён на новое время, а не добавлен вторым.");
    if (plan === "replace_other") {
      warnings.push(
        `Это время почти совпадает с показом «${plainField(existing?.propertyTitle) || "другой объект"}» — тот показ будет снят и заменён этим.`,
      );
    }
    const busy = snapshot.busyShowingId
      ? await prisma.interaction.findUnique({
          where: { id: String(snapshot.busyShowingId) },
          select: { nextActionDate: true, client: { select: { fullName: true } } },
        })
      : null;
    if (busy?.nextActionDate && busy.client) {
      warnings.push(
        `Агент в это время занят: показ ${showingTimeLabel(busy.nextActionDate)} (${plainField(clientNamePhoneSafe(busy.client.fullName, actor.canViewPhone), 60)}). Назначение это не блокирует.`,
      );
    }
    warnings.push("Агент получит уведомление, продавцу объекта уйдёт запись в хронологию.");
    return {
      title: "Назначить показ",
      was: {
        Показ: existing ? `${showingTimeText(existing.at)}${existing.propertyTitle ? ` — ${plainField(existing.propertyTitle)}` : ""}` : "не назначен",
      },
      becomes: {
        Клиент: plainField(clientNamePhoneSafe(client.fullName, actor.canViewPhone)),
        Объект: plainField(property.title),
        Время: showingTimeText(at),
        "Ведёт показ": plainField(agent?.fullName) || "—",
      },
      risk: warnings.join(" ").slice(0, 500),
    };
  },

  async execute(args, actionActor, ctx) {
    const { actor, agentName } = await loadToolActor(actionActor);
    // Сервис принимает день и время словами/цифрами: точный момент из аргумента
    // возвращается в стенные часы Душанбе (validateExactShowingSlot делает обратное и
    // проверил, что момент не округляется).
    const at = new Date(args.at);
    const propertyId = String(ctx.snapshotBefore.propertyId);
    const result = await bookShowing({
      clientId: args.clientId,
      request: { action: "book", propertyCode: propertyId, day: dushanbeDateString(at), time: dushanbeTimeString(at) },
      actor: { kind: "agent", agentId: actor.id, agentName, via: "assistant" },
      reportFailures: false,
    });
    if (!result.ok) throw bookingError(result.reason);
    return {
      result: {
        interactionId: result.interactionId,
        at: result.at.toISOString(),
        rescheduled: result.rescheduled,
        property: plainField(result.propertyTitle),
        href: `/clients/${args.clientId}`,
      },
      audit: { entityType: "Interaction", entityId: result.interactionId },
    };
  },
};

export const bookShowingTool: AssistantWriteToolPlugin = {
  name: "book_showing",
  level: "C",
  statusPhrase: "Готовлю показ…",
  description:
    "Назначить клиенту показ объекта на конкретное время. Звать, когда сотрудник просит записать/назначить показ и названы клиент и объект. " +
    "Идентификаторы бери из результатов поиска (id), не угадывай. Ничего не записывает сама: покажет карточку «было → станет» и ждёт подтверждения человека. " +
    "НЕ звать для переноса или отмены уже назначенного показа (для этого reschedule_showing / cancel_showing) и для обычной задачи «позвонить» (create_task). " +
    `Показы назначаются с ${SHOWING_HOURS_START} до ${SHOWING_HOURS_LAST} по Душанбе, не раньше чем через 30 минут, не дальше 30 дней.`,
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "id клиента из поиска" },
      propertyId: { type: "string", description: "id объекта из поиска (можно короткий номер ОБ-000088 → 88)" },
      at: { type: "string", description: TIME_PARAM_DESCRIPTION },
    },
    required: ["clientId", "propertyId", "at"],
  },
  executor: asPluginExecutor(bookShowingExecutor),
};
