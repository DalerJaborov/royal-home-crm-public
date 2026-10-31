import { z } from "zod";
import { clientDisplayName, clientKindLabel, formatClientCode, parseShortCode } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { cardWhereFromParam } from "../../../lib/cardIdParam.js";
import { phoneSafeText } from "../../../lib/clientPhone.js";
import { dushanbeDateString, dushanbeDateTimeString } from "../../../lib/dushanbeTime.js";
import { visibleInteractionWhere } from "../../../lib/investigationPrivacy.js";
import { TASK_WHERE } from "../../../lib/tasks.js";
import { presentClient } from "../../../routes/clients/shared.js";
import { FOREIGN_CLIENT_SCOPE_MESSAGE } from "../actor.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * get_client_card — КАРТОЧКА КЛИЕНТА ЦЕЛИКОМ С МАСКАМИ (П3, группа «read»).
 *
 * Подача — `presentClient` из routes/clients/shared.ts, ТА ЖЕ, что у GET /clients/:id:
 * телефон/запасные номера/WhatsApp закрыты маской без права clients.viewPhone, источник и
 * ник — без clients.viewOrigin, номер внутри имени и заметок гасится. Доступ — как у
 * остальных инструментов помощника про одного клиента (get_client_history): Корзина — «не
 * найден»; рядовому агенту — только свой и принятый клиент (REST пустил бы ещё и по своей
 * сделке и бывшему владельцу, помощник строже намеренно); чужой — отказ.
 */
const argsSchema = z.object({ clientId: z.string().trim().min(1).max(100) });

export const getClientCardTool: AssistantReadToolPlugin = {
  name: "get_client_card",
  level: "A",
  description:
    "Полная карточка ОДНОГО клиента: статус, агент, требования (бюджет, район, комнаты), заметки, последний контакт, " +
    "ближайшая задача. Телефон — с маской, если у человека нет права его видеть. Зови, когда нужны детали " +
    "известного клиента (id из find_clients/search_clients или номер ПК-000042). НЕ зови для поиска клиентов; " +
    "переписка и история — в get_client_history.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "id клиента из find_clients/search_clients или номер карточки (42)" },
    },
    required: ["clientId"],
  },
  statusPhrase: "Открываю карточку клиента…",
  async run(rawArgs, { actor }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите клиента" };
    // «ПК-000042» / «42» / id — карточка находится по любому из трёх.
    const shortCode = parseShortCode(parsed.data.clientId);
    const where = cardWhereFromParam(shortCode !== null ? String(shortCode) : parsed.data.clientId);
    if (!where) return { error: "Клиент не найден" };
    const ownScope = actor.canViewAllClients ? undefined : actor.id;

    const client = await prisma.client.findUnique({
      where,
      include: {
        desiredDistrict: { select: { name: true } },
        assignedAgent: { select: { fullName: true } },
      },
    });
    // Корзина и чужой непринятый лид для агента — «не найден» (как в get_client_history).
    if (!client || client.deletedAt || (ownScope && client.acceptedAt === null)) return { error: "Клиент не найден" };
    if (ownScope && client.assignedAgentId !== ownScope) return { error: FOREIGN_CLIENT_SCOPE_MESSAGE };

    const canSeePhone = actor.canViewPhone && client.acceptedAt !== null;
    const presented = presentClient(
      client,
      canSeePhone,
      actor.permissions?.has("clients.viewOrigin") ?? false,
      actor.role
    );

    const visible = visibleInteractionWhere(actor.role);
    const [lastInteraction, nextTask] = await Promise.all([
      prisma.interaction.findFirst({
        where: { clientId: client.id, ...visible },
        orderBy: { createdAt: "desc" },
        select: { type: true, outcome: true, createdAt: true },
      }),
      prisma.interaction.findFirst({
        where: { clientId: client.id, ...TASK_WHERE, ...visible, completedAt: null, nextActionDate: { not: null } },
        orderBy: { nextActionDate: "asc" },
        select: { type: true, nextAction: true, nextActionDate: true },
      }),
    ]);

    return {
      id: client.id,
      code: formatClientCode(client.shortId, client.kind),
      href: `/clients/${client.shortId}`,
      name: safeField(clientDisplayName(presented)),
      kind: clientKindLabel(client),
      status: client.status,
      workStatus: client.workStatus,
      source: presented.source ?? null,
      pendingAcceptance: presented.pendingAcceptance,
      agent: client.assignedAgent?.fullName ?? null,
      phone: presented.phone,
      whatsappPhone: presented.whatsappPhone ?? null,
      extraPhones: presented.extraPhones ?? [],
      email: presented.email ?? null,
      requirements: {
        budgetMin: client.budgetMin ? Number(client.budgetMin) : null,
        budgetMax: client.budgetMax ? Number(client.budgetMax) : null,
        currency: client.currency,
        district: client.desiredDistrict?.name ?? null,
        rooms: client.desiredRooms,
        propertyType: client.desiredType,
        areaMin: client.desiredAreaMin,
        address: safeField(phoneSafeText(client.address, canSeePhone), 200),
        notes: safeField(presented.requirementsNotes, 800),
      },
      aiScore: client.aiScore,
      aiInsight: safeField(presented.aiInsight, 600),
      hot: client.hotSince !== null,
      lastContact: {
        date: dushanbeDateString(client.lastContactAt),
        lastRecord: lastInteraction
          ? { type: lastInteraction.type, outcome: lastInteraction.outcome, date: dushanbeDateString(lastInteraction.createdAt) }
          : null,
      },
      nextTask: nextTask
        ? {
            type: nextTask.type,
            text: safeField(phoneSafeText(nextTask.nextAction, canSeePhone)),
            at: nextTask.nextActionDate ? dushanbeDateTimeString(nextTask.nextActionDate) : null,
          }
        : null,
      createdAt: dushanbeDateString(client.createdAt),
    };
  },
};
