import type { TransferRequestView } from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { sendPushToAgent } from "../push.js";
import { sendMessageWithButtons, isTelegramEnabled } from "../telegram/api.js";
import { clientNamePhoneSafe } from "./clientPhone.js";
import { publish } from "./eventBus.js";

/**
 * ПЕРЕДАЧА РОП — С УВЕДОМЛЕНИЕМ ДИРЕКТОРУ (решение владельца 16.11.2026, вторая редакция).
 *
 * «У агентов не должно быть прав передавать друг другу объекты и клиентов, и никаких уведомлений им
 * тоже. Директор передаёт сразу. РОП тоже передаёт что хочет и сразу, но после этого директору уходит
 * уведомление и в Telegram, и в CRM: РОП передал вот это, вот это, кнопки «Подтвердить» / «Отклонить».»
 *
 * Передача уже выполнена к моменту уведомления — тем же кодом, что и у директора. «Подтвердить» только
 * снимает вопрос. «Отклонить» возвращает карточку прежнему хозяину теми же функциями (с проверкой, что она
 * всё ещё у того, кому её передал РОП). Не ответил директор — передача остаётся как есть.
 *
 * ЭТОТ МОДУЛЬ — только запись и уведомление (без возврата карточки), чтобы двери передачи могли звать его без цикла импортов:
 * возврат при «Отклонить» живёт в ownershipTransferRequest.ts и сам зовёт эти же двери.
 *
 * Единая точка: `recordRopTransfer` зовётся из `transferPropertyByManager` и `assignClientManually` — то есть
 * из всех входов передачи (экран, помощница) — и срабатывает только для роли HEAD_OF_SALES.
 * Рубильник `Settings.ropTransferAlertEnabled` выключает только уведомление, не саму передачу.
 */

/** Метка в resultNote, пока отклонённая передача возвращается обратно. */
export const EXECUTING_MARK = "executing";

/** Кому уходит уведомление: директор и администратор (активные). */
export async function reviewerAgents(): Promise<{ id: string; telegramChatId: string | null }[]> {
  return prisma.agent.findMany({
    where: { isActive: true, role: { in: ["DIRECTOR", "ADMIN"] } },
    select: { id: true, telegramChatId: true },
  });
}

export function isTransferReviewer(role: string | null | undefined): boolean {
  return role === "DIRECTOR" || role === "ADMIN";
}

export type RequestRow = Prisma.OwnershipTransferRequestGetPayload<Record<string, never>>;

export async function toViews(rows: RequestRow[]): Promise<TransferRequestView[]> {
  if (rows.length === 0) return [];
  const agentIds = [...new Set(rows.flatMap((r) => [r.fromAgentId, r.toAgentId, r.requestedById]))];
  const propertyIds = rows.map((r) => r.propertyId).filter((v): v is string => !!v);
  const clientIds = rows.map((r) => r.clientId).filter((v): v is string => !!v);
  const [agents, properties, clients] = await Promise.all([
    prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } }),
    propertyIds.length
      ? prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { id: true, shortId: true, title: true } })
      : [],
    clientIds.length
      ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, shortId: true, fullName: true } })
      : [],
  ]);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const propById = new Map(properties.map((p) => [p.id, p]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const ag = (id: string | null) => {
    const a = id ? agentById.get(id) : undefined;
    return a ? { id: a.id, fullName: a.fullName } : null;
  };
  return rows.map((r) => {
    const p = r.propertyId ? propById.get(r.propertyId) : undefined;
    const c = r.clientId ? clientById.get(r.clientId) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      // Телефон из имени клиента и причины не показываем никому (см. clientNamePhoneSafe).
      targetTitle: p
        ? clientNamePhoneSafe(`Объект №${p.shortId} · ${p.title}`, false)
        : c
          ? `Клиент ${clientNamePhoneSafe(c.fullName, false)}`
          : "Удалено",
      targetShortId: p?.shortId ?? c?.shortId ?? null,
      targetId: r.propertyId ?? r.clientId ?? "",
      fromAgent: ag(r.fromAgentId),
      toAgent: ag(r.toAgentId),
      requestedBy: ag(r.requestedById),
      reason: clientNamePhoneSafe(r.reason, false),
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      resultNote: r.resultNote,
    };
  });
}

export const pushTag = (id: string) => `transfer-review-${id}`;

export function publishTransferChanged(agentIds: string[], requestId: string): void {
  void Promise.resolve(publish({ type: "transfer.pending", payload: { requestId }, agentIds: [...new Set(agentIds)] })).catch(() => {});
}

export function transferReviewButtons(id: string, crmUrl: string) {
  return [
    [
      { text: "✅ Подтвердить", callback_data: `tr:a:${id}` },
      { text: "↩️ Отклонить", callback_data: `tr:d:${id}` },
    ],
    [{ text: "🔗 Открыть в CRM", url: crmUrl }],
  ];
}

function crmUrlFor(row: Pick<RequestRow, "propertyId" | "clientId">): string {
  const base = (process.env.CRM_PUBLIC_URL || "https://crm.royalhome.tj").replace(/\/+$/, "");
  return row.propertyId ? `${base}/properties/${row.propertyId}` : `${base}/clients`;
}

/** Уведомить директора и администратора: окно в CRM (живое событие), пуш и Telegram с кнопками. */
export async function notifyReviewers(row: RequestRow): Promise<void> {
  const [view] = await toViews([row]);
  const reviewers = await reviewerAgents();
  const text =
    `🔁 РОП ${view.requestedBy?.fullName ?? ""} передал(а): ${view.targetTitle}\n` +
    `${view.fromAgent?.fullName ?? "—"} → ${view.toAgent?.fullName ?? "—"}\n` +
    `Причина: ${view.reason}\n\n` +
    `Подтвердите или отклоните (отклонить — вернуть прежнему хозяину).`;
  for (const r of reviewers) {
    void sendPushToAgent(r.id, {
      kind: "oversight",
      level: "APPROVAL",
      title: "🔁 РОП передал карточку",
      body: `${view.requestedBy?.fullName ?? "РОП"}: ${view.targetTitle} → ${view.toAgent?.fullName ?? ""}. Подтвердите или отклоните.`,
      url: "/",
      tag: pushTag(row.id),
    }).catch((err) => console.error("[push] передача РОП директору:", err));
    if (r.telegramChatId && isTelegramEnabled()) {
      void sendMessageWithButtons(r.telegramChatId, text, transferReviewButtons(row.id, crmUrlFor(row))).catch((err) =>
        console.error("[telegram] передача РОП директору:", err)
      );
    }
  }
  publishTransferChanged([...reviewers.map((r) => r.id), row.requestedById], row.id);
}

/**
 * Запомнить передачу РОП и сообщить директору. Зовётся ПОСЛЕ успешной передачи из единых дверей.
 * Не роняет передачу: любая ошибка только в лог.
 */
export async function recordRopTransfer(input: {
  kind: "PROPERTY" | "CLIENT";
  targetId: string;
  fromAgentId: string | null;
  toAgentId: string;
  actorId: string;
  actorRole: string | null | undefined;
  reason: string;
}): Promise<void> {
  try {
    // Директор и администратор передают без уведомления; остальные, кто вообще может передавать (РОП и любой с правом), — с ним.
    if (isTransferReviewer(input.actorRole)) return;
    if (!input.fromAgentId || input.fromAgentId === input.toAgentId) return;
    const settings = await prisma.settings.findFirst({ select: { ropTransferAlertEnabled: true } });
    if (settings && settings.ropTransferAlertEnabled === false) return;
    const where = { status: "PENDING" as const, ...(input.kind === "PROPERTY" ? { propertyId: input.targetId } : { clientId: input.targetId }) };
    // Повторная передача той же карточки: прежнее ждущее уведомление снимается — решать надо по последней.
    // Цепочка A→B, потом B→C: «Отклонить» должен вернуть исходному хозяину A, а не B — наследуем fromAgentId прежней записи.
    const row = await prisma.$transaction(async (tx) => {
      const prior = await tx.ownershipTransferRequest.findMany({ where, select: { id: true, fromAgentId: true, toAgentId: true } });
      let originalFrom = input.fromAgentId as string;
      for (const p of prior) {
        if (p.toAgentId === input.fromAgentId) originalFrom = p.fromAgentId;
      }
      if (prior.length) {
        await tx.ownershipTransferRequest.updateMany({
          where: { id: { in: prior.map((p) => p.id) }, status: "PENDING" },
          data: { status: "CANCELLED", resultNote: "Карточку передали повторно" },
        });
      }
      return tx.ownershipTransferRequest.create({
        data: {
          kind: input.kind,
          propertyId: input.kind === "PROPERTY" ? input.targetId : null,
          clientId: input.kind === "CLIENT" ? input.targetId : null,
          fromAgentId: originalFrom,
          toAgentId: input.toAgentId,
          requestedById: input.actorId,
          reason: input.reason,
          expiresAt: new Date(),
        },
      });
    });
    await notifyReviewers(row);
  } catch (err) {
    console.error("[transfer-review] не удалось записать передачу РОП:", err);
  }
}

