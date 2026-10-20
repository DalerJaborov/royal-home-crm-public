/**
 * Обвязка `ownershipPolicy.ts` над Prisma (17.09.2026, закон о владении
 * клиентом — `docs/law/lead-ownership.md`). `ownershipPolicy.ts` сам БД не
 * трогает (чистые предикаты, договор для пачки А2) — снимок собирает и
 * эскалацию вместо запрещённой передачи пишет этот модуль.
 */
import { prisma } from "../../db.js";
import { sendPushToAgent } from "../../push.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { notifyFeedOnly } from "../../lib/notifications.js";
import { logTimeline } from "../../lib/timeline.js";
import type { OwnershipSnapshot } from "./ownershipPolicy.js";

// НЕ импортируем `Tx` из `lib/changeClientAgent.ts` — тот файл сам импортирует
// этот модуль (`escalateInsteadOfTransfer`), и обратный импорт даже только
// типа замкнул бы цикл, который ловит `audit:deps` (`no-circular`). Та же
// строка определения типа, что и там — оба места выводят его прямо из
// сигнатуры `$transaction` расширенного клиента, а не из отдельного модуля.
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Один запрос: карточка + счётчик содержательных Interaction текущего агента
 *  с момента назначения (см. `OwnershipSnapshot.contactAttempts`). */
export async function loadOwnershipSnapshot(clientId: string, tx?: Tx): Promise<OwnershipSnapshot | null> {
  const db = tx ?? prisma;
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      assignedAgentId: true,
      assignedAt: true,
      acceptedAt: true,
      firstContactAt: true,
      lastAgentAttemptAt: true,
      ownPropertyLead: true,
      kind: true,
      status: true,
      workStatus: true,
      deletedAt: true,
    },
  });
  if (!client) return null;

  // Без текущего агента считать его попытки не по чему — Interaction.agentId
  // обязателен (schema.prisma), «попытки без агента» не бывает.
  const contactAttempts = client.assignedAgentId
    ? await db.interaction.count({
        where: {
          clientId,
          agentId: client.assignedAgentId,
          type: { notIn: ["SYSTEM", "STATUS_CHANGE"] },
          createdAt: { gte: client.assignedAt },
        },
      })
    : 0;

  return {
    id: client.id,
    assignedAgentId: client.assignedAgentId,
    acceptedAt: client.acceptedAt,
    firstContactAt: client.firstContactAt,
    lastAgentAttemptAt: client.lastAgentAttemptAt,
    contactAttempts,
    ownPropertyLead: client.ownPropertyLead,
    kind: client.kind,
    status: client.status,
    workStatus: client.workStatus,
    deletedAt: client.deletedAt,
  };
}

const ESCALATION_MARKER_PREFIX = "Автопередача запрещена законом П-3";
/** Дедуп — не чаще раза в 24 ч на клиента и механизм (тот же приём, что у
 *  `poolMarker`/`escalationReminderTag` в `firstCall.ts`/`reassignment.ts`:
 *  маркер по префиксу текста Interaction + `createdAt`, без миграции схемы). */
const ESCALATION_DEDUP_MS = 24 * 3600_000;

export interface EscalateInsteadOfTransferInput {
  clientId: string;
  /** Машинный тег механизма, который хотел передать клиента (в текст записи). */
  mechanism: string;
  /** Человекочитаемая причина запрета — обычно `AutoTransferVerdict.reason`. */
  reason: string;
  tx?: Tx;
}

/**
 * П-3: вместо запрещённой автопередачи — ОДНА SYSTEM-запись «Автопередача
 * запрещена…» от лица ТЕКУЩЕГО держателя (пока нет `actorKind`, см. пачку Б —
 * `Interaction.agentId` обязателен, автора «Система» без него не завести),
 * уведомление всем с правом `clients.assign` (`findAgentsWithPermission`, как
 * в `firstCall.ts`), пуш держателю «клиент ждёт вашего действия», и запись в
 * список его дел (`nextAction`/`nextActionDate` = сейчас + 1 ч — тот же приём,
 * что у `dealStalePipeline.ts`/`buyerThinkingSlowTrack.ts`).
 *
 * Дедуп: не чаще раза в 24 ч НА КЛИЕНТА И МЕХАНИЗМ — один и тот же крон,
 * упорно пытающийся передать того же клиента на каждом тике, не должен
 * заваливать хронологию и пуши руководству одинаковыми строками (та же дыра,
 * что дала 803 записи «первый звонок не совершён» за месяц — `docs/audit/
 * lead-ownership-17-09.md` §1.2/Р-8).
 */
export async function escalateInsteadOfTransfer(input: EscalateInsteadOfTransferInput): Promise<void> {
  const db = input.tx ?? prisma;
  const client = await db.client.findUnique({
    where: { id: input.clientId },
    select: { id: true, shortId: true, fullName: true, assignedAgentId: true },
  });
  if (!client || !client.assignedAgentId) return; // некому эскалировать — держателя нет

  const marker = `${ESCALATION_MARKER_PREFIX}: ${input.reason}`;
  const since = new Date(Date.now() - ESCALATION_DEDUP_MS);
  const already = await db.interaction.findFirst({
    where: {
      clientId: input.clientId,
      type: "SYSTEM",
      notes: { startsWith: ESCALATION_MARKER_PREFIX },
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (already) return;

  const holderId = client.assignedAgentId;
  const now = new Date();
  const text = `${marker}. Решение за руководителем`;

  // SYSTEM, а не держатель карточки (П-10, 17.09.2026, задание Б1, тот же
  // класс дефекта, что «крон подписан тем, кого обвиняет») — держатель здесь
  // ни при чём: закон запретил передачу, решение за руководителем, а
  // subjectAgentId сохраняет задачу в списке дел держателя.
  await logTimeline({
    clientId: input.clientId,
    actor: { kind: "system", source: "law.escalation", subjectAgentId: holderId },
    type: "SYSTEM",
    notes: text,
    nextAction: "Клиент ждёт вашего действия — автопередача заблокирована законом, решает руководитель",
    nextActionDate: new Date(now.getTime() + 3600_000),
    tx: input.tx,
  });

  // Уведомления — best-effort, отдельно от записи в хронологию (та же логика,
  // что и в остальных местах файла: сама эскалация не должна сорваться из-за
  // упавшего пуша).
  // Руководству — в колокольчик и на дашборд, без звонка телефона (владелец
  // 20.09.2026: «эскалация — прямо-таки пуш не нужно»). Телефон звонит одному
  // человеку — тому, от кого ждут действия (ниже).
  const supervisors = await findAgentsWithPermission("clients.assign");
  await notifyFeedOnly(supervisors, {
    kind: "lead",
    title: "Автопередача заблокирована законом",
    body: `${client.fullName}: ${input.reason}`,
    url: `/clients/${client.shortId}`,
    tag: `law-escalation-supervisor-${client.id}`,
  });
  sendPushToAgent(holderId, {
    title: "⚠️ Клиент ждёт вашего действия",
    body: `${client.fullName}: автоматика хотела передать клиента (${input.mechanism}), но клиент уже принят и контакт состоялся — решение за руководителем`,
    url: `/clients/${client.shortId}`,
    tag: `law-escalation-${client.id}`,
  }).catch((err) => console.error("[push] эскалация вместо автопередачи (держателю):", err));
}
