/**
 * «Уточню у собственника и вернусь» — механика вместо фразы.
 *
 * ЧТО БЫЛО. Бот упирается в то, чего не знает никто, кроме собственника: готов ли
 * тот торговаться, свободна ли квартира на выходных, останется ли мебель. Он честно
 * отвечал «уточню и вернусь» — и не возвращался. Возвращаться было нечему: фраза
 * никуда не записывалась, никакой задачи из неё не рождалось. Для клиента это хуже
 * прямого «не знаю»: ему пообещали и забыли, и следующий шаг он делает уже к
 * другому агентству.
 *
 * ЧТО ТЕПЕРЬ. Обещание превращается в запись. Живой человек видит вопрос, пишет
 * ответ — и ответ САМ уходит клиенту в тот канал, откуда он писал. Круг замыкает
 * код, а не память агента.
 *
 * ПОЧЕМУ ОТПРАВКУ ДЕЛАЕТ СЕРВЕР, А НЕ АГЕНТ РУКАМИ. Ровно на этом уже обожглись с
 * кнопкой «Предложить объект»: она делала пометку в хронологии, а ссылку слала
 * другая кнопка — владелец видел «объект предложен» и был уверен, что клиент
 * получил ссылку, а клиент не получал ничего. Здесь та же ловушка: «ответил в
 * карточке» и «клиент прочитал ответ» обязаны быть одним действием.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { ownerQuestionQueueScope } from "./ownerQuestionAccess.js";
import { ownBotConversationSql } from "./ownBotConversationScope.js";

/** Записывает обещание бота. Ничего не отправляет: клиенту бот уже сказал, что
 *  уточнит, — это его собственная реплика в том же ходе. */
export async function recordOwnerQuestion(input: {
  conversationId: string;
  clientId?: string | null;
  propertyId?: string | null;
  question: string;
}): Promise<void> {
  try {
    await prisma.ownerQuestion.create({
      data: {
        conversationId: input.conversationId,
        clientId: input.clientId ?? null,
        propertyId: input.propertyId ?? null,
        question: input.question.trim().slice(0, 1000),
      },
    });
  } catch (err) {
    // Ход диалога это ронять не должно: клиент уже получил ответ бота.
    void logSystemError("ai", `Вопрос собственнику не записан: ${describeError(err)}`);
  }
}

/**
 * Что видит человек, отвечающий за компанию.
 *
 * Полей стало больше 13.08.2026 по разбору владельца: «не видно, что за квартира,
 * что за вопрос, контекста нет». Раньше отдавались только текст вопроса, имя клиента
 * и название объекта — и ответить по такому было нельзя, не открыв вручную две
 * карточки. Короткие номера нужны для ссылок (карточка открывается по shortId, по
 * внутреннему uuid страница честно отвечает «не найдено»), цена и фото — чтобы
 * узнать объект не читая, а взглядом.
 */
export type { OwnerQuestionView } from "@royal-home/shared";
import type { OwnerQuestionView } from "@royal-home/shared";

/** Незакрытые вопросы — то, что кто-то из живых людей обещал уточнить. */
export async function loadPendingOwnerQuestions(limit = 20, staffAgentId?: string): Promise<OwnerQuestionView[]> {
  // Apply managed staff ACL BEFORE the limit: inaccessible questions must not
  // starve a later authorized/held item. Legacy dashboard callers keep their
  // existing queue; an absent actor cannot expose new managed questions.
  const scope = staffAgentId ? await ownerQuestionQueueScope(prisma, staffAgentId) : "none";
  const managedVisible = scope === "all" ? Prisma.sql`TRUE` : scope === "own" && staffAgentId
    ? Prisma.sql`EXISTS(SELECT 1 FROM "BotConversation" c LEFT JOIN "Client" cl ON cl."id"=c."clientId"
        JOIN "CustomerInquiry" i ON i."conversationId"=c."id" JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId"
        WHERE c."id"=q."conversationId" AND ${ownBotConversationSql(staffAgentId)}
          AND q."replyTarget"->>'nativeId'=c."id" AND q."replyTarget"->>'inquiryId'=i."id"
          AND q."replyTarget"->>'endpointScopeId'=c."endpointScopeId" AND q."replyTarget"->>'channel'=c."channel"
          AND q."replyTarget"->>'peer'=c."subscriberId"
          AND q."replyTarget"->>'accountId' IS NOT DISTINCT FROM c."accountId"
          AND q."replyTarget"->>'bindingRevision'=i."bindingRevision"::text
          AND q."replyTarget"->>'scopeRevision'=s."scopeRevision"::text AND i."closedAt" IS NULL)` : Prisma.sql`FALSE`;
  const selected = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT q."id" FROM "OwnerQuestion" q
    WHERE (q."customerActionId" IS NULL AND q."answeredAt" IS NULL) OR
      (q."customerActionId" IS NOT NULL AND ${managedVisible} AND
        (q."answeredAt" IS NULL OR q."deliveryStatus" IN ('QUEUED','HELD','UNKNOWN','FAILED')))
    ORDER BY (q."answeredAt" IS NOT NULL) ASC, q."askedAt" ASC, q."id" ASC
    LIMIT ${Math.min(Math.max(1, limit), 100)}`);
  if (!selected.length) return [];
  const fetched = await prisma.ownerQuestion.findMany({
    where: { id: { in: selected.map(row => row.id) } },
    orderBy: { askedAt: "asc" },
    take: Math.min(Math.max(1, limit), 100),
  });
  // Retained delivery receipts must stay visible without occupying every
  // staff-work slot ahead of questions that still need an answer. Preserve
  // the SQL priority; findMany's chronological order would undo it.
  const byId = new Map(fetched.map(row => [row.id, row]));
  const rows = selected.flatMap(({ id }) => { const row = byId.get(id); return row ? [row] : []; });
  if (rows.length === 0) return [];

  // Имена подтягиваем ОДНИМ запросом на весь список, а не по строке: это тот же
  // N+1, который в списке из двадцати вопросов дал бы сорок лишних запросов.
  const clientIds = rows.map((r) => r.clientId).filter((id): id is string => !!id);
  const propertyIds = rows.map((r) => r.propertyId).filter((id): id is string => !!id);
  const [clients, properties] = await Promise.all([
    // deletedAt: null (07.09.2026, разведка «осиротевшие спутники») — OwnerQuestion
    // был ЕДИНСТВЕННЫМ спутником вообще без фильтра при выдаче: карточка клиента
    // уходила в Корзину, а вопрос продолжал висеть в панели с пустым именем —
    // ответить на него уже некому, и живой человек тратил время, открывая карточку,
    // которой нет. Строки без найденного клиента отсекаются ниже.
    clientIds.length
      ? prisma.client.findMany({
          where: { id: { in: clientIds }, deletedAt: null },
          select: { id: true, shortId: true, fullName: true },
        })
      : [],
    propertyIds.length
      ? prisma.property.findMany({
          where: { id: { in: propertyIds } },
          select: {
            id: true,
            shortId: true,
            title: true,
            price: true,
            currency: true,
            // Одна первая фотография: панель показывает миниатюру, галерея ей не нужна.
            photos: { take: 1, orderBy: { order: "asc" }, select: { thumbUrl: true } },
          },
        })
      : [],
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const propertyById = new Map(properties.map((p) => [p.id, p]));

  return rows
    // Вопрос БЕЗ карточки (r.clientId === null) остаётся — это нормальный случай
    // (человек ещё не оставил номер). Вопрос С карточкой, которой больше нет
    // среди живых (удалена или ушла в Корзину), — отсекается: отвечать некому.
    .filter((r) => r.customerActionId || !r.clientId || clientById.has(r.clientId))
    .map((r) => {
      const client = r.clientId ? clientById.get(r.clientId) : undefined;
      const property = r.propertyId ? propertyById.get(r.propertyId) : undefined;
      return {
        id: r.id,
        question: r.question,
        askedAt: r.askedAt.toISOString(),
        clientId: r.clientId,
        clientShortId: client?.shortId ?? null,
        clientName: client?.fullName ?? null,
        propertyId: r.propertyId,
        propertyShortId: property?.shortId ?? null,
        propertyTitle: property?.title ?? null,
        // Decimal у Prisma — не число: наружу отдаём строкой, как и остальные цены в API.
        propertyPrice: property ? String(property.price) : null,
        propertyCurrency: property?.currency ?? null,
        propertyThumbUrl: property?.photos[0]?.thumbUrl ?? null,
        answer: r.answer,
        answeredAt: r.answeredAt?.toISOString() ?? null,
        managedRevision: r.managedRevision?.toString() ?? null,
        deliveryStatus: r.deliveryStatus,
      };
    });
}
