import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { applyShowingReply } from "./showingConfirmation.js";
import { fetchAndStoreClientAvatarIfMissing } from "./clientAvatar.js";
import { buildFallbackAvatarUrl } from "./clientAvatarFallback.js";
import { scrubMentionedPhones } from "./telephony/callPhoneMasking.js";

/**
 * Пуш агенту, когда его клиент написал в мессенджер.
 *
 * Раньше уведомление уходило только когда ИИ распознавал ПОВТОРНОЕ обращение
 * (notifyRepeatInquiry в leads.ts). Обычное сообщение — в том числе пока агент сам ведёт
 * переписку и бот на паузе — не уведомляло никого: агент узнавал о нём, только если
 * догадывался открыть карточку. Для переписки, которая должна работать как обычный
 * мессенджер, этого мало.
 *
 * Шлём только по клиентам с назначенным агентом: пока заявка не принята, диалог ведёт
 * бот, и дёргать им некого. Тег общий на клиента — несколько сообщений подряд заменяют
 * друг друга в шторке, а не копятся десятком карточек.
 *
 * Никогда не бросает и никого не ждёт: входящее сообщение важнее уведомления о нём.
 *
 * Здесь же засчитывается ответ на просьбу подтвердить показ. Причина — не
 * экономия файла: это единственная точка, через которую проходит КАЖДОЕ входящее
 * сообщение клиента из всех каналов (Meta, Telegram). Развешивать разбор
 * ответа по каждому транспорту значило бы получить канал, где подтверждение молча
 * не работает. Сама логика — в lib/showingConfirmation.ts, тут только вызов.
 */
/**
 * Когда по этому клиенту уже уходил push о сообщении.
 *
 * В памяти процесса, а не в базе: это защита от ПАЧКИ («здравствуйте» / «а
 * можно...» / «и ещё» подряд), она живёт минуты, и ради неё писать колонку на
 * каждое входящее сообщение незачем. Перезапуск сбрасывает — и это правильное
 * поведение: после перезапуска лучше лишнее уведомление, чем проглоченное.
 *
 * Тег в шторке пачку не решает: он схлопывает КАРТОЧКИ уведомлений, но каждое всё
 * равно даёт вибрацию и звук. Именно из-за этого уведомления и отключают целиком.
 */
const lastMessagePush = new Map<string, number>();

/** Чтобы карта не росла вечно на живой базе: чистим всё, что старше часа. */
function forgetOldMessagePushes(now: number): void {
  if (lastMessagePush.size < 500) return;
  for (const [id, at] of lastMessagePush) {
    if (now - at > 60 * 60 * 1000) lastMessagePush.delete(id);
  }
}

/** Только для тестов: окно живёт в памяти процесса и переживает смену настроек. */
export function resetClientMessageThrottle(): void {
  lastMessagePush.clear();
}

async function messageThrottleMs(): Promise<number> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { pushMessageThrottleMinutes: true },
  });
  return Math.max(0, s?.pushMessageThrottleMinutes ?? 3) * 60_000;
}

/**
 * КЛИЕНТ ПОДАЛ ПРИЗНАК ЖИЗНИ — ЭТО НЕ ТО ЖЕ, ЧТО «С НИМ РАБОТАЛИ».
 *
 * Отметка идёт в `lastClientMessageAt`, а НЕ в `lastContactAt`. Разница
 * принципиальная, и на ней уже обожглись 12.08.2026, когда сообщение двигало
 * `lastContactAt`:
 *
 *   `lastContactAt` — когда с клиентом работал СОТРУДНИК. Это поле читают отчёты:
 *   кандидаты на остывание (lib/clientAutoStatus.ts), «забытые клиенты»
 *   (lib/problemReport.ts), подсказки ИИ (routes/ai.ts). Стоило переписке его
 *   двигать — и клиент, которому каждый день отвечает один бот, а человек не
 *   тронул ни разу, во всех отчётах выглядел обслуженным. Ровно тот случай, ради
 *   которого отчёты и заведены, переставал в них попадать.
 *
 *   `lastClientMessageAt` — когда клиент писал САМ. Ради него правка и делалась:
 *   напоминание о незаполненной карточке (lib/cardReminders.ts) стыдило агента
 *   за клиента, с которым прямо сейчас идёт живая переписка. Читает поле только
 *   оно — отчётам «забытых» и остывания видеть его НЕ надо.
 *
 * ТОЛЬКО ОТМЕТКА, БЕЗ Interaction НА КАЖДУЮ РЕПЛИКУ. Запись в хронологию на каждое
 * сообщение утопила бы карточку в четырёх десятках строк за один разговор — то же
 * решение, что «одна запись на звонок» в lib/telephony/qualifyIncoming.ts.
 *
 * `updateMany`, а не `update`: карточка могла уехать в Корзину, и отметка
 * не имеет права ронять приём сообщения. По той же причине `deletedAt: null` —
 * удалённый клиент не оживает от того, что ему написал бот.
 *
 * `firstContactAt` НЕ трогаем: это метка первой работы АГЕНТА, а не активности клиента.
 */
async function markClientWroteHimself(clientId: string): Promise<void> {
  await prisma.client
    .updateMany({ where: { id: clientId, deletedAt: null }, data: { lastClientMessageAt: new Date() } })
    .catch((err) => console.error("[messenger] отметка сообщения клиента:", err instanceof Error ? err.message : err));
}

export async function notifyAgentOfClientMessage(
  clientId: string,
  text: string,
  channel?: string,
  subscriberId?: string | null,
  conversationId?: string
): Promise<void> {
  // Отметка — ПЕРВЫМ делом: она не зависит ни от разбора подтверждения показа
  // ниже, ни от того, назначен ли агент вовсе (у непринятого лида агента нет, а
  // сообщение от него есть). Саму функцию вызывающие не ждут (`void
  // notifyAgentOfClientMessage`), поэтому ожидание здесь ничего не задерживает,
  // зато отметка гарантированно доходит до базы, а не теряется на перезапуске.
  await markClientWroteHimself(clientId);

  // ДО проверки назначенного агента: подтверждение показа привязано к записи
  // взаимодействия, а не к текущему владельцу карточки, и не должно теряться,
  // если клиента как раз передают между агентами.
  await applyShowingReply(clientId, text);

  try {
    // findFirst с deletedAt: null (27.08.2026) — соседний markClientWroteHimself
    // выше нарочно фильтрует удалённых («карточка могла уехать в Корзину»), а
    // этот запрос той же функции фильтр не наследовал: push «клиент написал»
    // уходил агенту по карточке, которой уже нет ни в одном списке.
    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: {
        id: true,
        shortId: true,
        fullName: true,
        assignedAgentId: true,
        avatarUrl: true,
        phone: true,
        whatsappPhone: true,
        extraPhones: true,
      },
    });
    if (!client?.assignedAgentId) return;

    // Лениво, best-effort: если аватара ещё нет, а канал и идентификатор собеседника
    // известны — пробуем забрать его один раз. Не даём упасть остальному — сама
    // fetchAndStoreClientAvatarIfMissing уже ничего не бросает, await здесь только
    // чтобы аватар успел попасть В ЭТОТ ЖЕ пуш, а не только в следующий.
    const photoUrl =
      client.avatarUrl ?? (channel && subscriberId ? await fetchAndStoreClientAvatarIfMissing(client.id, channel, subscriberId) : null);

    // Настоящего фото нет — рисуем кружок с инициалами и тоном по имени
    // (lib/clientAvatarFallback.ts). Просьба владельца 19.08.2026: без этого в шторке все
    // клиенты выглядели одинаковой иконкой приложения, а именно там аватар и нужен —
    // чтобы понять, кто написал, не открывая карточку. Ни сети, ни диска это не стоит:
    // картинка целиком выводится из имени клиента. Значок «покупатель/продавец» здесь
    // был (домик/ключ по kind) и убран 21.09.2026 вместе с тем же значком в самой CRM
    // (components/ClientAvatar.tsx) — решение владельца.
    const avatarUrl = photoUrl ?? (await buildFallbackAvatarUrl(client.fullName));

    // Антиспам на пачку сообщений. Проверяется ПОСЛЕ разбора подтверждения показа
    // выше: пропустить уведомление можно, пропустить «да, приду» — нет.
    const throttleMs = await messageThrottleMs();
    const now = Date.now();
    if (throttleMs > 0) {
      const last = lastMessagePush.get(client.id);
      if (last && now - last < throttleMs) return;
    }

    // ЗАПАСНОЙ НОМЕР В ПУШЕ — ТА ЖЕ МАСКИРОВКА, ЧТО И В ИСТОРИИ (04.09.2026,
    // lib/clientPhoneMasking.ts). Пуш — это ЖИВОЙ поток, отдельный от записи в
    // BotConversation.messages: он уходит на телефон агента ДО и НЕЗАВИСИМО от
    // того, что осядет в переписке (см. вызовы notifyAgentOfClientMessage — все
    // они шлют пуш РАНЬШЕ, чем текст попадёт в saveIncoming). Если маскировать
    // только историю, агент всё равно прочитал бы номер в самом уведомлении —
    // дыра, а не защита.
    let trimmed = text.trim();
    try {
      trimmed = scrubMentionedPhones(trimmed, client).text;
    } catch (err) {
      console.error("[phone-mask] пуш о сообщении клиента:", err instanceof Error ? err.message : err);
    }
    const handledChat = conversationId ? await prisma.botConversation.findFirst({
      where: { id: conversationId, clientId: client.id, propertyChatAgentId: client.assignedAgentId }, select: { id: true },
    }) : null;
    const delivered = await sendPushToAgent(client.assignedAgentId, {
      kind: "message",
      title: client.fullName,
      // Пустой текст — клиент прислал фото или голосовое: пуш всё равно нужен,
      // иначе вложение остаётся незамеченным до следующего открытия карточки.
      body: trimmed ? trimmed.slice(0, 140) : "Прислал вложение",
      url: handledChat ? `/messages?open=${handledChat.id}` : `/clients/${client.shortId}`,
      tag: `client-message-${client.id}`,
      avatarUrl: avatarUrl ?? undefined,
    });

    // Отметку ставим только на доставленном: иначе первое же уведомление, не
    // ушедшее из-за отсутствия подписки, закрыло бы окно и следующие сообщения
    // тоже промолчали бы.
    if (delivered > 0) {
      lastMessagePush.set(client.id, now);
      forgetOldMessagePushes(now);
    }
  } catch (err) {
    console.error("[push] сообщение клиента:", err instanceof Error ? err.message : err);
  }
}
