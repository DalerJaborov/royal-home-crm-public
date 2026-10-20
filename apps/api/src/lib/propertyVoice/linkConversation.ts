import type { ConversationPropertySource } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { noticeOwnerOfConversationInterest, readConversationInterestWitness, readScopedConversationInterestWitness, lockConversationInterestWitness, type ConversationInterestWitness } from "../propertyInterestNotice.js";
import { publishConversationUpdated } from "../livePublish.js";
import type { CustomerTransportReference } from "../customerConversationScope.js";

/**
 * СВЯЗЬ «ДИАЛОГ ↔ ОБЪЕКТ» («голос рынка», 03.10.2026).
 *
 * ЗАЧЕМ. Бот узнаёт объект разговора в нескольких местах — пересланный пост,
 * номер в словах клиента, реклама, показ, страница сайта, — отвечает по нему и
 * тут же «забывает». Вопросы и возражения клиентов при этом лежали только в
 * `BotConversation.messages` без привязки к объекту, и собрать «что говорят про
 * эту квартиру» было не из чего. Эти хелперы оставляют след в
 * `ConversationProperty` из тех мест, где объект УЖЕ определён кодом.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО.
 *  • Догадок: связь пишется только по факту, который код уже установил.
 *  • Влияния на разговор: функции НИКОГДА НЕ БРОСАЮТ. Запись следа — статистика,
 *    клиент уже получил ответ; отказ базы уходит в журнал ошибок (молча терять
 *    нельзя — иначе «голос» объекта тихо пустеет), но ход диалога не рвёт.
 *
 * ИДЕМПОТЕНТНОСТЬ. Пара (диалог, объект) одна. Повторное узнавание (клиент
 * прислал тот же пост ещё раз, повтор доставки вебхука) двигает `lastSeenAt` и
 * растит `hits`, источник первого узнавания не перезаписывается.
 */

export interface LinkConversationInput {
  conversationId: string;
  propertyId: string;
  source: ConversationPropertySource;
  /**
   * Только гарантировать, что пара есть: не двигать lastSeenAt и не растить hits.
   * Нужно там, где то же узнавание уже учтено другим путём, а этот — страховка
   * (первое сообщение: диалога ещё не было, когда вебхук узнавал объект).
   */
  ensureOnly?: boolean;
}

/**
 * Идемпотентно записывает связь. Возвращает true, если запись есть к концу вызова.
 *
 * ХОЗЯИН ОБЪЕКТА УЗНАЁТ ОБ ЭТОМ ДИАЛОГЕ (10.10.2026, аудит
 * docs/audit-bots-2026-10-10-object-routing.md, P0-3/P0-7): сюда сходятся все
 * места, где код уже определил объект разговора, — пересланный пост, ссылка,
 * реклама, номер в тексте. Поэтому и уведомление хозяину зовётся отсюда, одним
 * местом, а не копией в каждом узнавателе. Показ объекта ботом (EXPOSURE) —
 * наша инициатива, а не интерес клиента: хозяина он не будит. Дедуп, отбор
 * «клиент уже у хозяина» и отсутствие персональных данных — внутри.
 */
export async function linkConversationProperty(input: LinkConversationInput): Promise<boolean> {
  if (!input.conversationId || !input.propertyId) return false;
  try {
    const witness = await readConversationInterestWitness(input.conversationId);
    return witness ? await linkWithWitness(input, witness) : false;
  } catch (err) {
    void logSystemError("api", `Связь диалога с объектом не записана: ${describeError(err)}`, { dedupKey: "property-voice-link" });
    return false;
  }
}

async function linkWithWitness(input: LinkConversationInput, witness: ConversationInterestWitness): Promise<boolean> {
  const write = () => prisma.$transaction(async tx => {
    if (input.conversationId !== witness.conversationId || !await lockConversationInterestWitness(tx, witness)) return false;
    if (!await writeLink(input, tx)) return false;
    if (input.source !== "EXPOSURE") {
      // A first exposure must not hide a later explicit interest from the owner.
      // Preserve the first interest source and the ensureOnly counters.
      await tx.conversationProperty.updateMany({
        where: { conversationId: input.conversationId, propertyId: input.propertyId, source: "EXPOSURE" },
        data: { source: input.source },
      });
    }
    return true;
  });
  let linked: boolean;
  try {
    try { linked = await write(); }
    catch (err) {
      // An external writer can still win the unique pair. PostgreSQL aborts
      // the failed tx: retry once in a NEW native-locked tx, never in that tx.
      if ((err as { code?: string }).code !== "P2002") throw err;
      linked = await write();
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "P2003") {
      void logSystemError("api", `Связь диалога с объектом не записана: ${describeError(err)}`, { dedupKey: "property-voice-link" });
    }
    return false;
  }
  if (linked && input.source !== "EXPOSURE") {
    void publishConversationUpdated("bot", input.conversationId);
    void noticeOwnerOfConversationInterest({ conversationId: input.conversationId, propertyId: input.propertyId, witness });
  }
  return linked;
}

async function writeLink(input: LinkConversationInput, db: TxClient): Promise<boolean> {
  const { conversationId, propertyId, source } = input;
  if (!conversationId || !propertyId) return false;
  const now = new Date();
  if (input.ensureOnly) {
    await db.conversationProperty.createMany({
      data: [{ conversationId, propertyId, source, firstSeenAt: now, lastSeenAt: now, hits: 1 }],
      skipDuplicates: true,
    });
    return true;
  }
  await db.conversationProperty.upsert({
    where: { conversationId_propertyId: { conversationId, propertyId } },
    create: { conversationId, propertyId, source, firstSeenAt: now, lastSeenAt: now, hits: 1 },
    update: { lastSeenAt: now, hits: { increment: 1 } },
  });
  return true;
}

/**
 * То же, но диалог находится по паре (канал, собеседник) — так устроены места,
 * где объект определяют (показ, интерес из пересланного поста): у них есть
 * `channel` и `recipientId`, а id диалога нет. Нет такого диалога (человека
 * показали до первого сообщения, сайт без чата) — писать нечего, это не ошибка.
 */
export async function linkConversationPropertyByChannel(input: {
  channel: string;
  recipientId: string;
  accountId?: string | null;
  transport?: CustomerTransportReference;
  propertyId: string;
  source: ConversationPropertySource;
}): Promise<boolean> {
  const { channel, recipientId, propertyId, source } = input;
  if (!channel || !recipientId || !propertyId) return false;
  try {
    const witness = await readScopedConversationInterestWitness({ channel, subscriberId: recipientId, accountId: input.accountId, transport: input.transport });
    if (!witness) return false;
    return await linkWithWitness({ conversationId: witness.conversationId, propertyId, source }, witness);
  } catch (err) {
    void logSystemError("api", `Диалог для связи с объектом не найден: ${describeError(err)}`, {
      dedupKey: "property-voice-link-lookup",
    });
    return false;
  }
}

/**
 * Пачка объектов одному собеседнику (ручная отправка подборки): диалог ищется
 * ОДИН раз, а не по разу на объект.
 */
export async function linkConversationPropertiesByChannel(input: {
  channel: string;
  recipientId: string;
  accountId?: string | null;
  transport?: CustomerTransportReference;
  propertyIds: string[];
  source: ConversationPropertySource;
}): Promise<void> {
  const { channel, recipientId, source } = input;
  const propertyIds = [...new Set(input.propertyIds)].slice(0, 50);
  if (!channel || !recipientId || propertyIds.length === 0) return;
  try {
    const witness = await readScopedConversationInterestWitness({ channel, subscriberId: recipientId, accountId: input.accountId, transport: input.transport });
    if (!witness) return;
    await Promise.all(
      propertyIds.map((propertyId) => linkWithWitness({ conversationId: witness.conversationId, propertyId, source }, witness))
    );
  } catch (err) {
    void logSystemError("api", `Диалог для связи с объектами не найден: ${describeError(err)}`, {
      dedupKey: "property-voice-link-lookup",
    });
  }
}

/**
 * Единственный объект диалога — или null. Нужен там, где надо приписать вещь
 * ОДНОМУ объекту (вопрос собственнику): при двух и более связанных объектах
 * однозначного ответа нет, и приписывать нельзя.
 */
export async function singleLinkedPropertyId(conversationId: string): Promise<string | null> {
  try {
    const rows = await prisma.conversationProperty.findMany({
      where: { conversationId },
      select: { propertyId: true },
      take: 2,
    });
    return rows.length === 1 ? rows[0].propertyId : null;
  } catch (err) {
    void logSystemError("api", `Объекты диалога не прочитаны: ${describeError(err)}`, {
      dedupKey: "property-voice-single",
    });
    return null;
  }
}
