/**
 * ОБРАЩЕНИЕ ПО ВАКАНСИИ НИКОГДА НЕ ОСТАЁТСЯ У АГЕНТА (17.09.2026).
 *
 * Реклама вакансии «агент по продажам» идёт одновременно с рекламой квартир, и
 * кандидаты пишут в те же WhatsApp и Instagram. До этой правки intent=job давал
 * карточку «прочее обращение», а если у номера карточка УЖЕ была (человек когда-то
 * спрашивал про квартиру), то kindChangeUpdate менял только тип: агент оставался
 * назначенным, а ему же уходил push «Клиент вернулся с другим запросом». Агент
 * звонил кандидату как покупателю — живые случаи 302, 315, 319.
 *
 * Здесь одно место, куда сходятся оба пути: автоматический (бот распознал работу
 * прямо в переписке, messengers/conversation.ts) и ручной (руководитель нажал
 * «В кандидаты» на карточке, routes/clients/lifecycle.ts).
 *
 * КОМУ УХОДИТ УВЕДОМЛЕНИЕ. Отдельного «ответственного за кандидатов» в CRM нет:
 * раздел «Вакансии» открыт по праву vacancies.view (пресеты MANAGER и ADMIN,
 * см. routes/vacancies.ts). До 17.09.2026 новую анкету не показывали вовсе —
 * только счётчик на дашборде, который надо было открыть. Берём тот же круг людей
 * и тот же канал, что у остальных обращений без агента (push + лента).
 */

import { channelLabel } from "@royal-home/shared";
import { prisma } from "../db.js";
import { findAgentsWithPermission } from "./recipients.js";
import { sendPushToAgent, closeLeadPushNotification } from "../push.js";
import { closeClientSatellites } from "./clientSatellites.js";
import { closeNotifications, createNotifications } from "./notifications.js";
import { trashBlocker, trashClient } from "./trashClient.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { isPlaceholderName } from "./placeholderName.js";
import type { ChatMessage } from "../ai/shared.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { logTimeline, type TimelineTx } from "./timeline.js";

/** Текст события в хронологии — один на оба пути, чтобы он не разъехался. */
export const CANDIDATE_INTERACTION_NOTE = "Обращение переведено в кандидаты на вакансию";

/**
 * Позвать тех, кто разбирает очередь кандидатов.
 *
 * Fire-and-forget: разговор с кандидатом не должен падать из-за уведомления.
 */
export async function notifyCandidateOwners(input: {
  /** Имя кандидата как его знает переписка — для текста уведомления. */
  name?: string | null;
  /** Откуда пришёл: WHATSAPP / INSTAGRAM / TELEGRAM… */
  channel: string;
  /** Диалог, чтобы уведомление по одному кандидату не плодилось. */
  conversationId: string;
  /** Пояснение: «бот распознал вакансию» или «перевёл руководитель». */
  why: string;
}): Promise<void> {
  try {
    const alert = {
      title: "💼 Новый кандидат на вакансию",
      // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
      body: `${input.name?.trim() || "Без имени"} — ${input.why} (${channelLabel(input.channel)})`,
      url: "/vacancies",
      tag: `candidate-${input.conversationId}`,
    };
    /**
     * РУКОВОДСТВУ НОЧЬЮ ПУШ НЕ ШЛЁМ (02.10.2026, правило владельца). Круг
     * vacancies.view — это руководство (MANAGER/ADMIN), а кандидаты пишут в
     * любой час: прежний прямой пуш будил руководителя в три ночи. Тот же приём,
     * что у notifyHr (lib/interviewInviteCall.ts): в часы алармов — очередь
     * руководству (она сама доставит пуш и строку ленты, одну на событие), вне
     * их — сразу строка в ленте, без пуша. Тег прежний: повтор по тому же
     * диалогу схлопывается в ту же строку, а не плодит вторую.
     */
    if (await isWithinAlarmHours()) {
      await enqueueDirectorAlert({ ...alert, recipientPermission: "vacancies.view" });
    } else {
      const recipients = await findAgentsWithPermission("vacancies.view");
      if (recipients.length === 0) return;
      await createNotifications(recipients, { ...alert, kind: "oversight" });
    }
  } catch (err) {
    void logSystemError("ai", `Уведомление о кандидате не отправлено: ${describeError(err)}`);
  }
}

/**
 * Снять агента с карточки, которая оказалась обращением по вакансии.
 *
 * НЕ удаляет карточку и не трогает переписку: это половина работы, общая для
 * автоматического и ручного пути. Полный ручной перевод (с анкетой и уходом
 * карточки из списков) — convertClientToJobApplication ниже.
 *
 * `actorId` — кто нажал. Для автоматики null: подписывать событие живым
 * человеком здесь нельзя (П-10, та же ошибка, что чинится в
 * lib/changeClientAgent.ts) — владение карточкой (прежний агент) не значит,
 * что он сейчас действовал. Автоматический путь пишется от лица бота
 * (`kind: "bot"`, распознал переписку), `subjectAgentId` — прежний держатель,
 * если он был, просто чтобы было кому увидеть запись в своей ленте.
 */
export async function detachAgentForCandidate(input: {
  clientId: string;
  actorId: string | null;
  /** Дописывается к CANDIDATE_INTERACTION_NOTE через двоеточие. */
  reason: string;
  /** Канал переписки — только для автоматического пути (actorId === null). */
  channel?: string;
  /**
   * Участвовать в чужой открытой транзакции вместо своей — тот же приём, что
   * `tx` у `logTimeline`/`closePendingPropertyDeleteRequests`. Нужен
   * `convertClientToJobApplication`: анкета кандидата и снятие агента обязаны
   * фиксироваться одной транзакцией, иначе падение между ними оставляет
   * человека одновременно и в «Вакансиях», и активным клиентом за агентом.
   */
  tx?: TimelineTx;
}): Promise<{ ok: boolean; previousAgentId: string | null }> {
  const db = input.tx ?? prisma;
  const client = await db.client.findUnique({
    where: { id: input.clientId },
    select: { id: true, shortId: true, assignedAgentId: true, lastAgentId: true, kind: true },
  });
  if (!client) return { ok: false, previousAgentId: null };
  const previousAgentId = client.assignedAgentId;
  const subjectAgentId = previousAgentId ?? client.lastAgentId ?? null;

  const runWrites = async (tx: TimelineTx) => {
    // LAW-A2-PENDING: найдено 17.09.2026 сторожем `assigned-agent-single-writer`
    // при работе над законом о владении клиентом — прямая запись мимо
    // changeClientAgent, но НЕ часть этого закона (эта функция из отдельной,
    // параллельно вышедшей фичи «кандидаты на вакансию», см. шапку файла и
    // комментарий у `detachAgentForCandidate` выше про то, почему `actorId`
    // для автоматики уже правильно берётся из прежнего агента). Перевод на
    // changeClientAgent здесь требует решения, распространяется ли П-3 на этот
    // случай (клиент оказался кандидатом, а не лидом — по духу закона это не
    // «увели клиента», а «переклассифицировали ошибку» — нужен отдельный взгляд,
    // не входит в задание А1/А2 по владению лидами). Заведена отдельная задача.
    await tx.client.update({
      where: { id: client.id },
      data: {
        kind: "OTHER",
        // LAW-A2-PENDING (объяснение — комментарий над этим блоком выше).
        assignedAgentId: null,
        // Карточка выходит из раздачи целиком: принятие, эскалация и счётчик
        // кругов относятся к лиду, которого больше нет.
        acceptedAt: null,
        escalatedAt: null,
        // Предложение реактивации прежнему агенту гаснет вместе с лидом
        // (02.10.2026): иначе принятие предложения или его истечение по крону
        // (lib/reactivationOffers.ts) возвращали кандидата агенту — вторым
        // входом мимо этой функции.
        reactivationOfferedToAgentId: null,
        reactivationOfferedAt: null,
        // Кто вёл — сохраняем: если окажется, что человек всё-таки покупатель,
        // возвращать его будет к кому (тот же приём, что в lib/trashClient.ts).
        ...(previousAgentId ? { lastAgentId: previousAgentId } : {}),
      },
    });
    await logTimeline({
      clientId: client.id,
      actor: input.actorId
        ? { kind: "agent", agentId: input.actorId }
        : { kind: "bot", source: "clientToCandidate", subjectAgentId, channel: input.channel },
      type: "SYSTEM",
      notes: `${CANDIDATE_INTERACTION_NOTE}: ${input.reason}`,
      tx,
    });
  };

  // Оповещения и пуши ниже — сеть, а не запись в базу: если вызывающая сторона
  // передала СВОЮ транзакцию (`input.tx`), она обязана держать её открытой
  // как можно короче, поэтому здесь мы только пишем и возвращаемся — сторона,
  // владеющая транзакцией, вызывает `runDetachSideEffects` сама, ПОСЛЕ коммита
  // (см. `convertClientToJobApplication`).
  if (input.tx) {
    await runWrites(input.tx);
    return { ok: true, previousAgentId };
  }
  await prisma.$transaction((tx) => runWrites(tx));
  await runDetachSideEffects(client, previousAgentId, input.reason);
  return { ok: true, previousAgentId };
}

async function runDetachSideEffects(
  client: { id: string; shortId: number },
  previousAgentId: string | null,
  reason: string
): Promise<void> {
  // Спутники лида — требования, просьбы о звонке, окна итогов — к кандидату
  // отношения не имеют и висели бы у агента задачами.
  await closeClientSatellites(client.id).catch((err) =>
    console.error("[кандидат] спутники карточки:", err instanceof Error ? err.message : err)
  );
  // Уведомление о лиде у прежнего агента гасим: лида больше нет, а нажатие по
  // нему открыло бы карточку, которой он уже не владеет.
  if (previousAgentId) {
    await closeLeadPushNotification(previousAgentId, `lead-${client.id}`).catch(() => {});
    /**
     * СТРОКА В КОЛОКОЛЬЧИКЕ — ОТДЕЛЬНО ОТ PUSH-БАННЕРА (17.09.2026, живые
     * случаи 302/315/319 из шапки файла).
     *
     * `closeLeadPushNotification` выше гасит только OS-баннер по тегу
     * `lead-<id>` — ту же роль для ленты уведомлений (колокольчик) играет
     * `closeNotifications` (см. lib/trashClient.ts, тот же приём при удалении
     * карточки). `trashClient` ниже по цепочке ЭТОГО клиента не закроет: она
     * зовётся, когда `client.assignedAgentId` уже `null` (снят строкой выше по
     * этой же функции), а `closeNotifications` внутри trashClient стоит под
     * условием `if (client.assignedAgentId)` — агент, которому реально
     * приходили уведомления по этому лиду, туда просто не попадает. Без этой
     * строки лента продолжала показывать «Новый лид» с рабочей ссылкой на
     * уже переведённую в кандидаты карточку — 4 таких клика по 302/315/319
     * упёрлись в 404 в один день.
     */
    await closeNotifications(
      previousAgentId,
      { clientId: client.id, clientShortId: client.shortId },
      "Обращение переведено в кандидаты на вакансию"
    ).catch(() => {});
    /**
     * ПРЕЖНИЙ АГЕНТ УЗНАЁТ, ЧТО КЛИЕНТ УШЁЛ — НЕ ТОЛЬКО «ВАКАНСИИ» (18.09.2026,
     * задание В, §f п.3). До сих пор пуш о новом кандидате уходил только тем, у
     * кого есть vacancies.view (notifyCandidateOwners выше по файлу) — держатель
     * карточки узнавал о потере клиента, только наткнувшись на пропажу из
     * своего списка.
     */
    void sendPushToAgent(previousAgentId, {
      title: "💼 Клиент оказался кандидатом на вакансию",
      body: `${reason} — карточка снята с вас и передана в «Вакансии»`,
      url: "/clients",
      tag: `client-to-candidate-${client.id}`,
    }).catch((err) =>
      void logSystemError(
        "api",
        `Пуш прежнему агенту о переводе в кандидаты не отправлен (${client.id}, ${previousAgentId}): ${err instanceof Error ? err.message : err}`
      )
    );
  }
}

/**
 * Причина в хронологии РУЧНОГО перевода. Одна строка на запись и на чтение:
 * по ней lib/rescoreJobApplications.ts узнаёт анкету, которую руководитель
 * перевёл в кандидаты сам, и не прячет её в NOT_CANDIDATE за то, что разговор
 * шёл «про покупку» (ровно поэтому её и переводили руками).
 */
export const MANUAL_CANDIDATE_REASON = "перевод в раздел «Вакансии» вручную";
/** Полный текст события ручного перевода в хронологии карточки. */
export const MANUAL_CANDIDATE_NOTE = `${CANDIDATE_INTERACTION_NOTE}: ${MANUAL_CANDIDATE_REASON}`;

/**
 * РУЧНОЙ ПЕРЕВОД «КЛИЕНТ → КАНДИДАТ» (17.09.2026).
 *
 * Нужен, чтобы разгрести то, что уже натворила прежняя логика: 302 Шоира, 315
 * Азиза, 319 Томирис заведены не «прочими обращениями», а ПОКУПАТЕЛЯМИ с
 * назначенным агентом — автоматика их не тронет, а руками агенту приходилось
 * звонить и выяснять, что это соискатель. Поэтому функция обязана работать и для
 * BUYER/SELLER с агентом, а не только для OTHER.
 *
 * Что делает:
 *  0) СНАЧАЛА спрашивает, можно ли убрать карточку (открытая сделка, объекты
 *     продавца в работе — trashBlocker). Нельзя — 409, и НИЧЕГО не изменено
 *     (02.10.2026: раньше анкета создавалась и агент снимался ДО отказа, и
 *     клиент со сделкой оставался без агента, а повтор плодил анкеты);
 *  1) переносит человека в раздел «Вакансии» анкетой (телефон, имя, всё, что
 *     известно из карточки и переписки, последний присланный файл как резюме).
 *     Анкету, которую бот уже собрал, ДОПОЛНЯЕТ, а не перезаписывает;
 *  2) снимает агента и пишет событие в хронологию от лица нажавшего;
 *  3) убирает карточку из списков ТЕМ ЖЕ механизмом, что и удаление, — в Корзину
 *     (lib/trashClient.ts). Нового статуса не заводим: каждая точка чтения в CRM
 *     уже фильтрует по deletedAt, а пятый способ «спрятать» карточку неизбежно
 *     разъехался бы с четырьмя существующими.
 */
export async function convertClientToJobApplication(input: {
  clientId: string;
  /** Кто нажал: попадёт в хронологию карточки и в Корзину как удаливший. */
  actorId: string;
}): Promise<{ ok: true; applicationId: string } | { ok: false; status: number; error: string }> {
  const client = await prisma.client.findUnique({
    where: { id: input.clientId },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      phone: true,
      source: true,
      requirementsNotes: true,
      deletedAt: true,
      assignedAgentId: true,
    },
  });
  if (!client) return { ok: false, status: 404, error: "Клиент не найден" };
  if (client.deletedAt) return { ok: false, status: 400, error: "Карточка уже в Корзине" };

  // Отказ — ДО любой записи: карточку со сделкой или объектами в работе
  // убрать нельзя, а значит и анкету заводить, и агента снимать рано.
  const blocked = await trashBlocker(client.id);
  if (blocked) return { ok: false, status: blocked.status, error: blocked.error };

  /**
   * Самая свежая переписка этого человека: из неё берём канал, рассказ о себе и
   * резюме. Несколько диалогов бывает (писал и в WhatsApp, и в Instagram) —
   * анкета одна, привязываем к последнему, остальные остаются в переписке.
   *
   * ИЩЕМ ВО ВСЕХ ТРЁХ ТАБЛИЦАХ ПЕРЕПИСКИ, а не только в `BotConversation`
   * (правка 21.09.2026). Раньше у человека, писавшего в Telegram, переписка не
   * находилась вовсе: анкета создавалась без `conversationId`, без рассказа и без
   * резюме — даже если он прислал его боту, — а в разделе «Вакансии» кнопка
   * «Переписка» у такой анкеты всегда открывала пустоту.
   */
  const [botConv, tgConv, tgDirectConv, clientProfile] = await Promise.all([
    prisma.botConversation.findFirst({
      where: { clientId: client.id },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, channel: true, name: true, messages: true, lastMessageAt: true, contactProfileId: true },
    }),
    prisma.telegramConversation.findFirst({
      where: { clientId: client.id },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, username: true, messages: true, lastMessageAt: true, contactProfileId: true },
    }),
    prisma.telegramDirectConversation.findFirst({
      where: { clientId: client.id },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, username: true, messages: true, lastMessageAt: true, contactProfileId: true },
    }),
    // Досье человека — на случай, если у самой переписки привязки нет.
    prisma.contactProfile.findFirst({
      where: { clientId: client.id, mergedIntoId: null },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true },
    }),
  ]);

  const conversation = [
    botConv ? { ...botConv, channel: botConv.channel, name: botConv.name } : null,
    tgConv ? { ...tgConv, channel: "TELEGRAM", name: tgConv.username } : null,
    // Личные сообщения Telegram — отдельная таблица переписки, и метка канала
    // у анкеты своя (02.10.2026): с меткой "TELEGRAM" раздел «Вакансии» искал
    // этот диалог среди переписок Telegram-бота и не находил ничего.
    tgDirectConv ? { ...tgDirectConv, channel: "TELEGRAM_DIRECT", name: tgDirectConv.username } : null,
  ]
    .filter((c): c is NonNullable<typeof c> => c !== null)
    // Без даты последнего сообщения — в самый хвост: это заведомо более старая
    // или пустая переписка, и выбирать её вместо живой нельзя.
    .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))[0];

  const messages = Array.isArray(conversation?.messages)
    ? (conversation.messages as unknown as ChatMessage[])
    : [];
  // Тот же выбор резюме, что у бота (lib/jobApplications.ts): последний файл или
  // фото за разговор — кандидат мог переслать документ заново.
  const cv = messages
    .flatMap((m) => m.attachments ?? [])
    .filter((a) => a.kind === "file" || a.kind === "image")
    .pop();
  const said = messages
    .filter((m) => m.role === "user" && m.content?.trim())
    .map((m) => m.content.trim())
    .join("\n")
    .slice(0, 8000);
  const rawText = [client.requirementsNotes?.trim(), said].filter(Boolean).join("\n").slice(0, 8000) || null;

  // Запасное имя карточки («Клиент WhatsApp», «Входящий ***67») именем
  // кандидата не считается: HR позвал бы человека чужим словом.
  const realName = isPlaceholderName(client.fullName) ? null : client.fullName;
  const contactProfileId = conversation?.contactProfileId ?? clientProfile?.id ?? null;
  const channel = conversation?.channel ?? String(client.source);

  // Анкета кандидата и снятие агента — одной транзакцией: порознь падение
  // между ними оставляло человека одновременно и в «Вакансиях» (анкета уже
  // есть), и активным клиентом за прежним агентом (снятие не состоялось).
  // trashClient — вне её (у него свои пуши и оповещения), но причины его
  // отказа уже проверены выше, а ещё раз — под замком строки клиента ниже.
  const outcome = await prisma.$transaction(async (tx) => {
    // Два нажатия подряд (двойной клик, повтор после сбоя сети) идут по
    // очереди, а не наперегонки: второе ждёт первое и находит его анкету.
    await tx.$executeRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`;
    const lockedBlock = await trashBlocker(client.id, tx);
    if (lockedBlock) return { ok: false as const, ...lockedBlock };

    // Одна анкета на человека: по диалогу (уникален), а без переписки — по
    // карточке. Повторное нажатие дополняет ту же анкету, а не заводит вторую.
    const existing = conversation
      ? await tx.jobApplication.findUnique({ where: { conversationId: conversation.id } })
      : await tx.jobApplication.findFirst({ where: { clientId: client.id }, orderBy: { createdAt: "desc" } });

    let app;
    if (!existing) {
      app = await tx.jobApplication.create({
        data: {
          ...(conversation ? { conversationId: conversation.id } : {}),
          channel,
          contactName: conversation?.name ?? null,
          name: realName,
          phone: client.phone || null,
          clientId: client.id,
          ...(contactProfileId ? { contactProfileId } : {}),
          ...(rawText ? { rawText } : {}),
          ...(cv?.file ? { cvFile: cv.file } : {}),
        },
      });
    } else {
      /**
       * ДОПОЛНЯЕМ, А НЕ ПЕРЕЗАПИСЫВАЕМ (02.10.2026). Бот мог уже собрать анкету:
       * настоящее имя, номер, который кандидат сам напечатал, рассказ о себе. Раньше
       * всё это затиралось данными карточки — запасным именем, номером карточки,
       * требованиями «3 хона, Сино». Теперь поле пишется, только если пустое, а
       * рассказ дописывается в конец.
       */
      const filled = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";
      const appendText =
        rawText && !(existing.rawText ?? "").includes(rawText)
          ? filled(existing.rawText)
            ? `${existing.rawText}\n\n${rawText}`.slice(0, 16000)
            : rawText
          : undefined;
      app = await tx.jobApplication.update({
        where: { id: existing.id },
        data: {
          ...(!filled(existing.name) && realName ? { name: realName } : {}),
          ...(!filled(existing.phone) && client.phone ? { phone: client.phone } : {}),
          ...(!filled(existing.contactName) && conversation?.name ? { contactName: conversation.name } : {}),
          ...(!filled(existing.cvFile) && cv?.file ? { cvFile: cv.file } : {}),
          ...(appendText ? { rawText: appendText } : {}),
          ...(existing.clientId ? {} : { clientId: client.id }),
          ...(!existing.contactProfileId && contactProfileId ? { contactProfileId } : {}),
          // Анкету, когда-то отложенную как «не кандидат», руководитель только
          // что признал кандидатом сам — она возвращается в очередь, иначе HR
          // получил бы «Новый кандидат», а в разделе его не нашёл.
          ...(existing.status === "NOT_CANDIDATE" ? { status: "NEW" } : {}),
        },
      });
    }

    await detachAgentForCandidate({
      clientId: client.id,
      actorId: input.actorId,
      reason: MANUAL_CANDIDATE_REASON,
      tx,
    });
    return { ok: true as const, app };
  });
  if (!outcome.ok) return outcome;
  const application = outcome.app;

  // Оповещения — после коммита (см. комментарий в detachAgentForCandidate у
  // `runDetachSideEffects`): здесь, а не внутри detachAgentForCandidate, потому
  // что ей передана чужая (эта) транзакция, и сама она их не шлёт.
  await runDetachSideEffects(client, client.assignedAgentId, MANUAL_CANDIDATE_REASON);

  const trashed = await trashClient(client.id, input.actorId);
  if (!trashed.ok) {
    // Сюда доходит только гонка: сделку или объект завели в те миллисекунды,
    // что прошли между проверкой под замком и удалением. Анкета уже есть и это
    // правильно — человек и правда кандидат; говорим прямо, что осталось
    // сделать руками, вместо молчаливого «готово».
    return { ok: false, status: trashed.status, error: trashed.error };
  }

  void notifyCandidateOwners({
    name: application.name ?? realName,
    channel: application.channel,
    conversationId: conversation?.id ?? client.id,
    why: "перевод из клиентов вручную",
  });

  return { ok: true, applicationId: application.id };
}
