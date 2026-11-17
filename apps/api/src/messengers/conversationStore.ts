// Хранилище переписки BotConversation, нужное не только старому чат-движку: служебная
// запись диалога (лид-магнит, комментарии), отметки отправки и доставки. Вынесено из
// messengers/conversation.ts (31.10.2026) без смены поведения.
import { prisma } from "../db.js";
import {
  CustomerScopeDenied,
  ensureScopedBotConversation,
  findScopedBotConversation,
  type CustomerTransportReference,
} from "../lib/customerConversationScope.js";
import { attachContactProfile, identitiesForMessengerChannel } from "../lib/contactProfiles.js";
import { describeError } from "../lib/describeError.js";
import { traceStamp } from "../lib/botTurnTrace.js";
import type { MessengerChannel } from "./turnTypes.js";

/**
 * Проставляет идентификатор ОТПРАВЛЕННОГО сообщения последней нашей реплике.
 *
 * Порядок здесь обратный привычному: ответ бота попадает в переписку ДО отправки
 * (иначе сбой между «сгенерировали» и «отправили» терял бы его), а идентификатор
 * Meta выдаёт только в ответе на отправку. Поэтому проставляем его вдогонку.
 *
 * Нужен ровно для цитат: клиент нажимает «ответить» на конкретное сообщение, Meta
 * присылает его mid — и без этой отметки в переписке не найти, на что он ответил.
 *
 * Бот отвечает двумя пузырями, а лежат они одной репликой: первый идентификатор
 * пишется в `mid`, второй — в `mid2`. Отказ здесь безвреден: пропадёт только цитата,
 * поэтому ошибку глотаем, а не роняем ход, в котором клиент УЖЕ получил ответ.
 */
export async function stampOutgoingMid(
  channel: MessengerChannel,
  subscriberId: string,
  mid: string | null,
  accountId?: string | null | CustomerTransportReference
): Promise<void> {
  if (!mid) { traceStamp(null, "missing"); return; }
  try {
    const scoped = await findScopedBotConversation({ channel, subscriberId,
      ...(typeof accountId === "object" && accountId ? { transport: accountId } : { accountId }) });
    if (!scoped) { traceStamp(mid, "missing"); return; }
    /**
     * Два запроса вместо одного с подставляемым именем поля — нарочно. Имя ключа
     * параметром в `->>` Postgres принять не может: у оператора две подписи (по
     * тексту и по номеру), и параметр неизвестного типа делает вызов неоднозначным.
     */
    const first = await prisma.$executeRaw`
      UPDATE "BotConversation"
      SET "messages" = jsonb_set(
        "messages",
        ARRAY[(jsonb_array_length("messages") - 1)::text, 'mid'],
        to_jsonb(${mid}::text)
      )
      WHERE "id" = ${scoped.id}
        AND jsonb_typeof("messages") = 'array'
        AND jsonb_array_length("messages") > 0
        AND "messages"->-1->>'role' = 'assistant'
        AND "messages"->-1->'customerPropertyDelivery' IS NULL
        AND "messages"->-1->>'mid' IS NULL`;
    // Первый пузырь занял "mid" — значит это второй пузырь того же ответа.
    let affected = first;
    if (first === 0) {
      affected = await prisma.$executeRaw`
        UPDATE "BotConversation"
        SET "messages" = jsonb_set(
          "messages",
          ARRAY[(jsonb_array_length("messages") - 1)::text, 'mid2'],
          to_jsonb(${mid}::text)
        )
        WHERE "id" = ${scoped.id}
          AND jsonb_typeof("messages") = 'array'
          AND jsonb_array_length("messages") > 0
          AND "messages"->-1->>'role' = 'assistant'
          AND "messages"->-1->'customerPropertyDelivery' IS NULL
          AND "messages"->-1->>'mid' IS NOT NULL
          AND "messages"->-1->>'mid2' IS NULL`;
    }
    traceStamp(mid, affected > 0 ? true : "missing");
  } catch (err) {
    traceStamp(mid, false);
    console.error("[бот] идентификатор отправленного сообщения не записан:", describeError(err));
  }
}

/**
 * ОТПРАВКА НЕ УДАЛАСЬ — ПОМЕТИТЬ ОТВЕТ КАК НЕ ДОШЕДШИЙ.
 *
 * Реплика бота пишется в переписку ДО отправки в Meta (так к ней потом
 * привязывается mid), и если отправка упала — закрытое окно 24 часов, отозванный
 * маркер, 5xx Graph API — в CRM остаётся ответ, которого клиент никогда не
 * видел. Вебхуку при этом уже ответили 200, повтора не будет. Сотрудник открывает
 * переписку, видит «бот ответил» и не отвечает сам: человек остаётся без ответа
 * вообще (docs/bot-razbor-20-09.md, класс 7 п. 1).
 *
 * Механизм отметок уже есть и уже показывается галочками в интерфейсе
 * (markMessageDeliveryStatus ниже, DeliveryTicks в вебе) — здесь он применяется к
 * случаю, когда mid'а не будет вовсе, поэтому отметка ставится по последней
 * реплике бота, как в stampOutgoingMid.
 *
 * УСЛОВИЕ `mid IS NULL` — ЭТО И ЕСТЬ ПРОВЕРКА «КЛИЕНТ НЕ ПОЛУЧИЛ НИЧЕГО». Если
 * mid уже стоит, первый пузырь ушёл, и метить всю реплику неудачей было бы
 * враньём в обратную сторону. Отдельный случай «первый пузырь дошёл, второй нет»
 * этим не покрывается: у второго пузыря своего элемента в переписке нет (он
 * ложится тем же элементом через mid2), и честно пометить только его нечем.
 */
export async function markLastReplyUndelivered(
  channel: MessengerChannel,
  subscriberId: string,
  accountId?: string | null | CustomerTransportReference
): Promise<void> {
  try {
    const scoped = await findScopedBotConversation({ channel, subscriberId,
      ...(typeof accountId === "object" && accountId ? { transport: accountId } : { accountId }) });
    if (!scoped) return;
    await prisma.$executeRaw`
      UPDATE "BotConversation"
      SET "messages" = jsonb_set(
        "messages",
        ARRAY[(jsonb_array_length("messages") - 1)::text, 'deliveryStatus'],
        to_jsonb('failed'::text)
      )
      WHERE "id" = ${scoped.id}
        AND jsonb_typeof("messages") = 'array'
        AND jsonb_array_length("messages") > 0
        AND "messages"->-1->>'role' = 'assistant'
        AND "messages"->-1->'customerPropertyDelivery' IS NULL
        AND "messages"->-1->>'mid' IS NULL
        AND "messages"->-1->>'deliveryStatus' IS NULL`;
  } catch (err) {
    console.error("[бот] неудачная отправка не отмечена:", describeError(err));
  }
}

/**
 * Отмечает доставку/прочтение НАШЕГО сообщения — по `mid`/`mid2`, а не по позиции
 * в массиве: статус может прийти для любого прошлого сообщения, не только для
 * последнего (WhatsApp присылает delivered/read с задержкой, а сообщений между
 * ними могло уйти уже несколько). LATERAL — ищем индекс элемента с совпавшим
 * mid ПРЯМО в UPDATE, без гонки «прочитали — записали устаревший снимок»
 * (тот же принцип, что у appendConversationMessages).
 *
 * `read` перекрывает `delivered`, но не наоборот — если статусы придут не по
 * порядку (сеть, ретраи Meta), «прочитано» не должно откатиться обратно на
 * «доставлено».
 */
export async function markMessageDeliveryStatus(
  subscriberId: string,
  mid: string,
  status: "sent" | "delivered" | "read" | "failed",
  accountExternalId?: string
): Promise<void> {
  try {
    const scoped = await findScopedBotConversation({ channel: "WHATSAPP", subscriberId, accountExternalId });
    if (!scoped) return;
    // CTE вместо UPDATE...FROM LATERAL: цель UPDATE нельзя коррелировать из
    // подзапроса во FROM (Postgres 42P10 «invalid reference to FROM-clause
    // entry»), а отдельный CTE — обычный независимый запрос, который потом
    // просто join'ится с целью по id.
    await prisma.$executeRaw`
      WITH idx AS (
        SELECT c.id AS conv_id, (t.ord - 1) AS pos
        FROM "BotConversation" c, jsonb_array_elements(c."messages") WITH ORDINALITY AS t(elem, ord)
        WHERE c."id" = ${scoped.id}
          AND (t.elem->>'mid' = ${mid} OR t.elem->>'mid2' = ${mid})
        ORDER BY t.ord DESC LIMIT 1
      )
      UPDATE "BotConversation" b
      SET "messages" = jsonb_set(b."messages", ARRAY[idx.pos::text, 'deliveryStatus'], to_jsonb(${status}::text))
      FROM idx
      WHERE b."id" = idx.conv_id
        AND (
          b."messages"->(idx.pos::int)->>'deliveryStatus' IS NULL
          OR ${status} = 'read'
          OR b."messages"->(idx.pos::int)->>'deliveryStatus' = 'sent'
        )`;
  } catch (err) {
    console.error("[бот] статус доставки не записан:", describeError(err));
  }
}

/**
 * Заводит (или находит) диалог, переживая параллельный запуск.
 *
 * `upsert` не атомарен: он сначала читает, и если строки нет — вставляет. Meta
 * доставляет первые сообщения нового собеседника пачкой вебхуков одновременно, и
 * тогда ДВА-ТРИ хода читают пустоту, вставляют каждый своё, а уникальный ключ
 * (channel, subscriberId) пропускает только первого. Остальные падали P2002 —
 * то есть первые же слова человека терялись, а Meta повтора не сделает.
 *
 * Отказ по уникальности здесь означает ровно одно: соседний ход только что создал
 * ту же запись. Значит повторяем — второй заход уже попадёт в ветку update. Двух
 * попыток достаточно (проигравшему больше некому проиграть), но на всякий случай
 * последний заход читает строку напрямую: лучше отдать диалог без правки имени,
 * чем уронить ход.
 */
export async function upsertConversation(
  channel: MessengerChannel,
  subscriberId: string,
  name?: string,
  accountId?: string | null,
  /**
   * Аккаунт выбран догадкой (ResolvedAccount.certain=false): scoped facade
   * отклоняет её, не создаёт диалог и не меняет пустую либо прежнюю привязку.
   * Точный другой аккаунт тоже не усыновляет старую переписку: в Gate A такая
   * коллизия удерживается до отдельного contract-cutover scoped ключей.
   */
  accountGuess = false,
  transport?: CustomerTransportReference
) {
  if (accountGuess) throw new CustomerScopeDenied("account_unknown");
  return prisma.$transaction(async tx => {
    const scoped = await ensureScopedBotConversation(tx, { channel, subscriberId, accountId, transport });
    return name ? tx.botConversation.update({ where: { id: scoped.id }, data: { name } })
      : tx.botConversation.findUniqueOrThrow({ where: { id: scoped.id } });
  });
}

/**
 * ДОСЬЕ СОБЕСЕДНИКА НА ПЕРВОМ ЖЕ ВХОДЯЩЕМ (владелец 21.09.2026).
 *
 * Стоит внутри общего входа, а не в `getConversation`, нарочно: в диалог ведут
 * ДВА пути — обычный ход модели и воронка лид-магнита через
 * `ensureConversationId` (lib/leadMagnet.ts, messengers/comments.ts), которая
 * `processMessengerTurn` не зовёт вовсе. Поставь отметку в одном из них — второй
 * молча остался бы без досье, и заметно это стало бы только по жалобе владельца.
 */
export async function ensureConversationContactProfile(conversation: {
  id: string;
  channel: string;
  subscriberId: string;
  name: string | null;
  contactProfileId: string | null;
}): Promise<string | null> {
  const identities = identitiesForMessengerChannel(conversation.channel, conversation.subscriberId);
  if (identities.length === 0) return conversation.contactProfileId;
  return attachContactProfile({
    existingProfileId: conversation.contactProfileId,
    identities,
    name: conversation.name,
    // Имя пришло из профиля соцсети: обращаться им бот не станет
    // («royal_dream_777»), но в досье оно полезно человеку.
    nameSource: "profile",
    link: async (profileId) => {
      await prisma.botConversation.update({
        where: { id: conversation.id },
        data: { contactProfileId: profileId },
      });
    },
  });
}

/**
 * Диалог для СЛУЖЕБНОЙ записи в переписку — без назначения манеры продажи и без
 * всего остального, что делает `getConversation` перед ходом модели.
 *
 * Нужен воронке лид-магнита (lib/leadMagnet.ts): она отвечает человеку сама, без
 * ИИ, и её реплики обязаны лечь в ту же переписку. Иначе в CRM видно, что человек
 * вдруг пишет «спасибо» в пустой диалог, а куда делось всё до этого — неизвестно.
 * Манеру продажи здесь не назначаем нарочно: жребий должен падать, когда с
 * человеком начинает говорить модель, а не когда автомат прислал ему файл.
 *
 * accountId тот же смысл, что у getConversation ниже: в какой НАШ аккаунт
 * написал человек. Воронка лид-магнита живёт в вебхуке наравне с обычным ходом
 * модели и обязана помечать диалог тем же аккаунтом — иначе служебная запись
 * молча осталась бы «ничьей».
 */
export async function ensureConversationId(
  channel: MessengerChannel,
  subscriberId: string,
  name?: string,
  accountId?: string | null,
  accountGuess = false,
  transport?: CustomerTransportReference
): Promise<string> {
  // YouTube comments retain their legacy archival dossier. They have no DM
  // endpoint, customer admission, principal or action/write authority. This is
  // deliberately not a fallback for unknown Meta accounts or other channels.
  if (channel === "YOUTUBE" && (accountId || accountGuess || transport || !subscriberId || subscriberId.length > 512)) {
    throw new CustomerScopeDenied("scope_unknown");
  }
  const conversation = channel === "YOUTUBE" ? await upsertYouTubeCommentArchive(subscriberId, name)
    : await upsertConversation(channel, subscriberId, name, accountId, accountGuess, transport);
  await ensureConversationContactProfile(conversation);
  return conversation.id;
}

export async function upsertYouTubeCommentArchive(subscriberId: string, name?: string) {
  const where = { channel_subscriberId: { channel: "YOUTUBE", subscriberId } };
  const readArchive = async (create: boolean) => prisma.$transaction(async tx => {
    const include = { endpointScope: { select: { kind: true } } } as const;
    const row = create ? await tx.botConversation.upsert({ where, include,
      create: { channel: "YOUTUBE", subscriberId, name, messages: [], leadDraft: { stage: "chatting" } },
      update: name ? { name } : {},
    }) : await tx.botConversation.findUniqueOrThrow({ where, include });
    // The expansion migration attaches only a LEGACY_UNKNOWN scope/HOLD state
    // to archival rows. Never adopt a configured Meta binding as an archive.
    if (row.accountId !== null || row.endpointScope?.kind !== "LEGACY_UNKNOWN") throw new CustomerScopeDenied("scope_unknown");
    return row;
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await readArchive(true); }
    catch (error) { if ((error as { code?: string }).code !== "P2002") throw error; }
  }
  return readArchive(false);
}
