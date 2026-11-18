import { deleteReasonLabelsFor, DELETE_REQUEST_REASON_LABELS, type DeleteRequestReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { publishRequestUpdated } from "./livePublish.js";
import { logTimeline } from "./timeline.js";

/**
 * ЗАЯВКА НА УДАЛЕНИЕ КЛИЕНТА — ОДНА ДВЕРЬ (16.11.2026).
 *
 * Заявку заводит агент кнопкой (routes/clients/deleteRequests.ts) и — с 16.11.2026 —
 * сама CRM, когда работа по клиенту закончилась отказом: «Потерянных» больше нет,
 * а «пусть сами люди решают» (владелец) значит, что карточку в Корзину убирает
 * руководитель, а не автоматика. Так приходят: отказ клиента, исчерпанные
 * передачи (lib/clientRefuse.ts, lib/clientTransfer.ts) и отказ продавца после
 * снятия последнего объекта (lib/sellerRefusalReview.ts).
 *
 * Удаления здесь нет: только заявка в очереди «Заявки на удаление» и сообщение
 * тем, у кого есть право `clients.delete`. Вторая заявка по тому же клиенту не
 * заводится — возвращается уже ждущая.
 */
export interface FileClientDeleteRequestInput {
  clientId: string;
  /** Кто просит — агент карточки или нажавший сотрудник (обязателен в схеме). */
  requestedById: string;
  reason: DeleteRequestReason;
  comment?: string | null;
  voiceNoteUrl?: string | null;
  voiceNoteTranscript?: string | null;
}

export type FileClientDeleteRequestResult =
  | { ok: true; created: true; id: string }
  | { ok: true; created: false; id: string }
  | { ok: false; error: string };

function reasonLabel(reason: string, kind: string | null | undefined): string {
  const labels = deleteReasonLabelsFor((kind as "BUYER" | "SELLER" | "OTHER" | undefined) ?? undefined);
  return labels[reason as DeleteRequestReason] ?? DELETE_REQUEST_REASON_LABELS[reason as DeleteRequestReason] ?? reason;
}

/**
 * Работа по клиенту закончилась (отказ, исчерпаны передачи, продавец снял
 * последний объект) — заявка на удаление руководителю от имени агента карточки.
 * Не бросает: сбой заявки не имеет права откатить уже записанный отказ, поэтому
 * отказ попадает в хронологию карточки строкой, видимой руководителю.
 */
export async function fileEndOfWorkDeleteRequest(
  client: { id: string; assignedAgentId: string | null },
  requestedById: string | null,
  comment: string
): Promise<void> {
  // Заявка не завелась — одной строки в хронологии мало: её никто не увидит, и
  // карточка повиснет ничьей (ревью 18.11.2026). Руководству — уведомление.
  const note = async (text: string) => {
    await logTimeline({
      clientId: client.id,
      actor: { kind: "system", source: "refuse", subjectAgentId: client.assignedAgentId },
      type: "SYSTEM",
      notes: text,
    }).catch(() => {});
    const card = await prisma.client.findUnique({ where: { id: client.id }, select: { shortId: true, fullName: true } }).catch(() => null);
    if (card) void enqueueDirectorAlert({
      title: `⚠️ ${card.fullName}: решите судьбу карточки`,
      body: text,
      url: `/clients/${card.shortId}`,
      tag: `end-of-work-unfiled-${client.id}`,
      recipientPermission: "clients.delete",
    });
  };
  if (!requestedById) {
    await note("Работа завершена, но заявку на удаление завести не от кого: у карточки нет агента. Решение — за руководителем");
    return;
  }
  try {
    const filed = await fileClientDeleteRequest({ clientId: client.id, requestedById, reason: "OTHER", comment });
    if (!filed.ok) await note(`Работа завершена, но заявка на удаление не заведена: ${filed.error}`);
  } catch (err) {
    console.error("[отказ] заявка на удаление:", err instanceof Error ? err.message : err);
    await note("Работа завершена, но заявка на удаление не заведена из-за сбоя. Решение — за руководителем");
  }
}

export async function fileClientDeleteRequest(input: FileClientDeleteRequestInput): Promise<FileClientDeleteRequestResult> {
  const client = await prisma.client.findUnique({
    where: { id: input.clientId },
    select: { id: true, fullName: true, kind: true, deletedAt: true },
  });
  if (!client || client.deletedAt) return { ok: false, error: "Клиент не найден" };

  const existing = await prisma.clientDeleteRequest.findFirst({
    where: { clientId: client.id, status: "PENDING" },
    select: { id: true },
  });
  if (existing) return { ok: true, created: false, id: existing.id };

  const request = await prisma.clientDeleteRequest.create({
    data: {
      clientId: client.id,
      requestedById: input.requestedById,
      reason: input.reason,
      comment: input.comment?.trim() || null,
      commentVoiceUrl: input.voiceNoteUrl ?? null,
      commentVoiceTranscript: input.voiceNoteTranscript ?? null,
    },
  });

  // Кому решать — тем и сообщаем, по праву, а не по роли (lib/recipients.ts).
  // Часы алармов (владелец 07.09.2026): заявка уже в очереди Архива, ждёт
  // решения в любом случае — откладывается только пуш о ней.
  const author = await prisma.agent.findUnique({ where: { id: input.requestedById }, select: { fullName: true } });
  void enqueueDirectorAlert({
    title: "🗑️ Заявка на удаление клиента",
    body: `${author?.fullName ?? "Агент"}: ${client.fullName} — ${reasonLabel(input.reason, client.kind)}`,
    url: "/archive",
    kind: "oversight",
    // Первый уровень владельца: пока заявка не решена, агент стоит и ждёт
    // (см. NOTIFICATION_LEVELS в @royal-home/shared).
    level: "APPROVAL",
    tag: `delete-request-${request.id}`,
    recipientPermission: "clients.delete",
  });

  publishRequestUpdated({
    requestId: request.id,
    clientId: client.id,
    agentIds: [input.requestedById],
    stage: "PENDING",
    actorId: input.requestedById,
  });

  return { ok: true, created: true, id: request.id };
}
