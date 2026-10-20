import { sellerObjectFactsSchema, type SellerObjectFacts } from "@royal-home/shared";
import { prisma } from "../db.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { scheduleSellerPhotoInsights } from "./sellerMedia.js";

/**
 * ФАКТЫ ОБ ОБЪЕКТЕ ПРОДАВЦА — постановка разбора и чтение готового (владелец
 * 21.09.2026: «чтобы деньги зря не тратились на токены, но весь функционал работал»).
 *
 * Модуль НАМЕРЕННО лёгкий: его импортируют точки записи переписки
 * (messengers/appendMessages.ts) и расшифровки звонков — тянуть туда ИИ и гео
 * значило бы закольцевать импорты. Сам разбор живёт в ai/sellerFactsExtract.ts и
 * исполняется только воркером (jobs/sellerFacts.ts).
 *
 * ИИ НЕ ЗОВЁТСЯ НИ ПРИ ОТКРЫТИИ МАСТЕРА, НИ ЧАТА, НИ ПОЛОСЫ — только здесь, в
 * фоне, по событию «продавец что-то сказал».
 */

export const SELLER_FACTS_JOB_TYPE = "seller-facts";

/** Дребезг: разбор идёт через 15 минут тишины. Продавец пишет пачками — пачка
 *  одним вызовом модели, а не по вызову на каждое «и ещё». */
export const SELLER_FACTS_DEBOUNCE_MS = 15 * 60_000;

/** Потолок откладывания: продавец, пишущий без перерыва два часа, всё равно получит
 *  разбор — иначе бесконечный дребезг означал бы «никогда». */
export const SELLER_FACTS_MAX_POSTPONE_MS = 2 * 3_600_000;

/** Один повтор на случай сбоя БАЗЫ. Отказ ИИ заданием не ретраится вовсе: у
 *  callAiText свой единственный повтор, а следующая пачка сообщений всё равно
 *  поставит разбор заново (правило 6 задания: повторов не больше одного). */
export const SELLER_FACTS_MAX_ATTEMPTS = 2;

export function sellerFactsDedupeKey(clientId: string): string {
  return `seller-facts:${clientId}`;
}

/** Продавец — основная сторона или вторая (dualIntent: продаёт и ищет). */
export function isSellerClient(client: { kind: string; dualIntent: boolean }): boolean {
  return client.kind === "SELLER" || client.dualIntent;
}

/**
 * Поставить разбор фактов продавца. Fire-and-forget: зовётся из горячих путей
 * (запись входящей реплики, сохранение расшифровки), сбой постановки не имеет
 * права уронить сам приём сообщения.
 */
export function scheduleSellerFactsRefresh(clientId: string | null | undefined): void {
  if (!clientId) return;
  void enqueueSellerFactsRefresh(clientId).catch((err) =>
    console.error("[seller-facts] постановка разбора:", err instanceof Error ? err.message : err)
  );
}

/**
 * То же по диалогу — для единственной точки записи истории (appendMessages.ts),
 * где известен только id диалога. Один лёгкий SELECT на входящую реплику.
 */
export function scheduleSellerFactsRefreshForConversation(
  channel: "bot" | "telegram" | "telegram-direct",
  conversationId: string
): void {
  void (async () => {
    const row =
      channel === "bot"
        ? await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true } })
        : channel === "telegram"
          ? await prisma.telegramConversation.findUnique({ where: { id: conversationId }, select: { clientId: true } })
          : await prisma.telegramDirectConversation.findUnique({
              where: { id: conversationId },
              select: { clientId: true },
            });
    if (row?.clientId) await enqueueSellerFactsRefresh(row.clientId);
  })().catch((err) =>
    console.error("[seller-facts] постановка разбора по диалогу:", err instanceof Error ? err.message : err)
  );
}

/** Awaitable-вариант постановки — для тестов и мест, где ждать можно. */
export async function enqueueSellerFactsRefresh(clientId: string): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { kind: true, dualIntent: true, deletedAt: true },
  });
  // Покупателю разбор объекта не нужен — и не тратим на него ни строки очереди.
  if (!client || client.deletedAt || !isSellerClient(client)) return;
  // Оценка присланных фото (обложка, планировка, ремонт) — тем же событием, своим
  // заданием и своим кэшем по sha256: новое фото смотрится один раз (lib/sellerMedia.ts).
  scheduleSellerPhotoInsights(clientId);

  const now = Date.now();
  const runAt = new Date(now + SELLER_FACTS_DEBOUNCE_MS);
  const dedupeKey = sellerFactsDedupeKey(clientId);
  const existing = await prisma.backgroundJob.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true, payload: true },
  });

  if (existing?.status === "PENDING") {
    // ДРЕБЕЗГ: новая реплика отодвигает ждущий разбор ещё на 15 минут — так пачка
    // сообщений уходит в модель одним вызовом. Не дальше двух часов от первой
    // реплики пачки (firstAt в payload), иначе болтливый продавец не дождётся.
    const firstAt = Date.parse(String((existing.payload as { firstAt?: unknown } | null)?.firstAt ?? ""));
    if (Number.isFinite(firstAt) && now - firstAt < SELLER_FACTS_MAX_POSTPONE_MS) {
      await prisma.backgroundJob.updateMany({ where: { id: existing.id, status: "PENDING" }, data: { runAt } });
    }
    return;
  }

  if (existing?.status === "RUNNING") {
    // Реплика пришла, пока разбор идёт: основной ключ занят до конца задания, и
    // обычная постановка стала бы no-op — реплика ждала бы следующего сообщения.
    // Запасной ключ даёт ровно одно догоняющее задание; разбор инкрементальный,
    // так что пустой догоняющий прогон стоит один SELECT, а не вызов модели.
    await enqueueBackgroundJob({
      type: SELLER_FACTS_JOB_TYPE,
      payload: { clientId, firstAt: new Date(now).toISOString() },
      maxAttempts: SELLER_FACTS_MAX_ATTEMPTS,
      dedupeKey: `${dedupeKey}:next`,
      runAt,
    });
    return;
  }

  await enqueueBackgroundJob({
    type: SELLER_FACTS_JOB_TYPE,
    payload: { clientId, firstAt: new Date(now).toISOString() },
    maxAttempts: SELLER_FACTS_MAX_ATTEMPTS,
    dedupeKey,
    runAt,
  });
}

/**
 * Готовые факты из базы — БЕЗ вызова ИИ (для мастера, полосы в чате и черновика
 * из переписки). null — фактов нет: разбора ещё не было, модель не ответила, или
 * накопленное уже ушло в объект, заведённый ПОСЛЕ последнего разбора.
 *
 * Последнее — главная защита от «второй квартиры с параметрами первой»: факты,
 * собранные до того, как из них завели объект, описывают именно его. Подставлять
 * их в следующий объект того же продавца — ровно поломка 19.09.2026 (см. шапку
 * ai/propertyDraft.ts). Новые реплики после заведения объекта дадут новый набор.
 */
export async function getSellerObjectFacts(clientId: string): Promise<SellerObjectFacts | null> {
  const [row, lastProperty] = await Promise.all([
    prisma.sellerObjectFacts.findUnique({
      where: { clientId },
      select: { facts: true, factsUpdatedAt: true },
    }),
    latestSellerProperty(clientId),
  ]);
  if (!row?.facts || !row.factsUpdatedAt) return null;
  if (lastProperty && lastProperty.createdAt >= row.factsUpdatedAt) return null;
  return parseSellerFacts(row.facts);
}

/** JSON из базы писала прошлая версия кода — проверяем схемой, а не приведением. */
export function parseSellerFacts(raw: unknown): SellerObjectFacts | null {
  const parsed = sellerObjectFactsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Последний заведённый из этого продавца объект (удалённые не считаются: объект
 *  заводят заново после удаления, и его факты снова законны). */
export function latestSellerProperty(clientId: string) {
  return prisma.property.findFirst({
    where: { sellerClientId: clientId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
}
