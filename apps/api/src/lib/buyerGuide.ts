/**
 * ОТПРАВКА ГИДА ПОКУПАТЕЛЯ КЛИЕНТУ В ПЕРЕПИСКЕ.
 *
 * Решение о том, что файл сейчас уместен, принимает модель (см. ai/guideOffer.ts);
 * здесь всё остальное: где взять файл, кому его можно отдать и как не отдать
 * дважды. Функция НЕ бросает: не отдать файл — досадно, уронить из-за этого ответ
 * клиенту — хуже. Всякий отказ уходит в журнал, как любой внешний вызов.
 *
 * ФАЙЛ ТОЛЬКО ПОДПИСЧИКАМ (решение владельца 16.08.2026) — то же условие, что в
 * воронке: ради подписки лид-магнит и делается. Не подписан — файл не уходит, а
 * ждёт: на каждом следующем сообщении человека подписка проверяется заново, и файл
 * улетает сам, как только она появилась. Просить второй раз при этом не нужно —
 * человек уже слышал просьбу и либо подпишется, либо нет.
 *
 * ПРО ЧЕСТНОСТЬ ТЕКСТА. Отправку выполняет код ПОСЛЕ ответа модели, поэтому модели
 * прямо запрещено писать «отправил» (см. GUIDE_PROMPT_RULE): подписки у человека
 * может не оказаться, и обещание окажется ложью. Всё, что относится к файлу,
 * говорит этот модуль своим сообщением.
 */

import { prisma } from "../db.js";
import { publicUploadUrl } from "./crmPublicUrl.js";
import { logSystemError } from "./systemError.js";
import { describeError, fetchInstagramProfile, sendFile, sendMessage } from "../messengers/meta.js";

/** Каналы, куда Meta умеет отправить документ (см. messengers/meta.ts). Telegram
 *  идёт своим транспортом и здесь не обслуживается — там бот отвечает словами. */
const FILE_CHANNELS = new Set(["INSTAGRAM", "WHATSAPP", "FACEBOOK"]);

/** Подписка есть только в Instagram. В WhatsApp подписываться не на что, и
 *  требовать её там значит не отдать файл вообще никому. */
const FOLLOW_REQUIRED_CHANNELS = new Set(["INSTAGRAM"]);

/** Сколько ждём подписки, прежде чем забыть про обещание. Неделя: человек мог
 *  вернуться к переписке через день, а через месяц это уже другой разговор. */
const AWAIT_FOLLOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface GuideSendResult {
  /** Файл действительно ушёл. */
  sent: boolean;
  /** Имя файла для ленты диалога («[файл: ...]»), когда он ушёл. */
  fileName: string | null;
  /** Текст, который код сказал клиенту сам (подпись к файлу или просьба подписаться),
   *  вместе с mid отправленного сообщения Meta — записывается в переписку СРАЗУ,
   *  без stampOutgoingMid: тот проставляет id последней реплике уже ПОСЛЕ append,
   *  а к моменту вызова sendBuyerGuide реплика гида ещё не последняя в истории
   *  (см. royalhome-funnel-double-send-echo-mid-17-08 в памяти агента). */
  said: { text: string; mid: string | null }[];
}

const NOTHING: GuideSendResult = { sent: false, fileName: null, said: [] };

/**
 * Файл берётся из кампании воронки — там его уже загружает владелец через
 * Настройки → Воронка. Отдельной настройки нарочно нет: чек-лист у агентства один,
 * а две копии в разных местах разъедутся при первом же обновлении текста.
 *
 * Берём кампанию с файлом, предпочитая включённую: выключают их, когда реклама
 * закончилась, но файл при этом остаётся тем же и годится для разговора.
 */
async function guideFile(): Promise<{ path: string; name: string; deliverIfUnsure: boolean } | null> {
  try {
    const rows = await prisma.leadMagnetCampaign.findMany({
      where: { NOT: { filePath: null } },
      select: { filePath: true, fileName: true, deliverIfUnsure: true },
      orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
      take: 1,
    });
    const row = rows[0];
    if (!row?.filePath) return null;
    return {
      path: row.filePath,
      name: row.fileName ?? "Перед покупкой квартиры.pdf",
      deliverIfUnsure: row.deliverIfUnsure,
    };
  } catch (err) {
    void logSystemError("meta", `Файл гида не прочитан из кампаний воронки: ${describeError(err)}`);
    return null;
  }
}

/**
 * Подписан ли человек на наш аккаунт.
 *
 * `undefined` — проверить НЕ УДАЛОСЬ (Graph отказал или у маркера нет разрешения),
 * и это не то же самое, что «не подписан». Отказывать из-за нашего сбоя человеку,
 * который всё сделал правильно, — худший исход, поэтому поведение берём из той же
 * настройки кампании, что и воронка («отдавать при сомнении»).
 */
async function isFollower(senderId: string, token?: string): Promise<boolean | undefined> {
  try {
    const profile = await fetchInstagramProfile(senderId, token);
    return profile.isUserFollowBusiness;
  } catch (err) {
    void logSystemError("meta", `Подписка для выдачи гида не проверена: ${describeError(err)}`);
    return undefined;
  }
}

const FOLLOW_ASK: Record<string, string> = {
  tg: "Ин файлро мо ба обуначиёнамон мефиристем. Ба саҳифаи мо обуна шавед, ман ҳозир мефиристам.",
  ru: "Этот файл мы отправляем подписчикам. Подпишитесь на нашу страницу, и я сразу пришлю.",
};

const FILE_CAPTION: Record<string, string> = {
  tg: "Фиристодам, дар он ҳама чиз навишта шудааст.",
  ru: "Отправил, там всё подробно расписано.",
};

/**
 * Отдаёт гид, если он нужен, ещё не уходил и человек подписан.
 *
 * Вызывается КАЖДЫЙ ход: `wanted` приходит от модели только в тот ход, когда она
 * решила отдать файл, а `awaitingFollow` тянется дальше сам — иначе человек,
 * подписавшийся через два сообщения, не получил бы ничего.
 */
export async function sendBuyerGuide(input: {
  /** Модель попросила отдать файл в этом ходе. */
  wanted: boolean;
  conversationId: string;
  channel: string;
  recipientId: string;
  /** Маркер доступа аккаунта, в котором идёт разговор (у нас их несколько). */
  token?: string;
  /** Уже отправляли в этом диалоге — BotConversation.guideSentAt. */
  alreadySent: boolean;
  /** Файл обещан, ждём подписки — BotConversation.guideAwaitFollowAt. */
  awaitingFollowSince: Date | null;
  /** Язык клиента для подписи и просьбы (см. ai/clientLanguage.ts). */
  language: "ru" | "tg" | "mixed" | "unknown";
  now?: Date;
}): Promise<GuideSendResult> {
  const now = input.now ?? new Date();
  if (input.alreadySent) return NOTHING;
  if (!FILE_CHANNELS.has(input.channel)) return NOTHING;

  const stillWaiting =
    input.awaitingFollowSince !== null && now.getTime() - input.awaitingFollowSince.getTime() < AWAIT_FOLLOW_MS;
  if (!input.wanted && !stillWaiting) return NOTHING;

  const file = await guideFile();
  if (!file) {
    // Молчать нельзя: владелец должен узнать про несдержанное обещание от CRM,
    // а не от клиента. Чаще всего это просто не загруженный файл кампании.
    void logSystemError(
      "meta",
      "Бот собрался отдать клиенту файл-гид, но ни в одной кампании воронки файл не загружен."
    );
    return NOTHING;
  }

  const url = publicUploadUrl(file.path);
  if (!url) {
    void logSystemError("meta", "Файл-гид не отправлен: не задан CRM_PUBLIC_URL, Meta неоткуда его забрать.");
    return NOTHING;
  }

  const lang = input.language === "tg" || input.language === "mixed" ? "tg" : "ru";

  if (FOLLOW_REQUIRED_CHANNELS.has(input.channel)) {
    const following = await isFollower(input.recipientId, input.token);
    const allowed = following === true || (following === undefined && file.deliverIfUnsure);
    if (!allowed) {
      // Просим ОДИН раз — в тот ход, когда файл понадобился. Дальше молча ждём:
      // человек, которому напоминают про подписку в каждом сообщении, уходит.
      if (!input.wanted) return NOTHING;
      await prisma.botConversation
        .update({ where: { id: input.conversationId }, data: { guideAwaitFollowAt: now } })
        .catch(() => {});
      let askMid: string | null = null;
      try {
        askMid = await sendMessage(input.channel as "INSTAGRAM", input.recipientId, FOLLOW_ASK[lang], input.token);
      } catch (err) {
        void logSystemError("meta", `Просьба подписаться ради файла не ушла: ${describeError(err)}`);
        return NOTHING;
      }
      return { sent: false, fileName: null, said: [{ text: FOLLOW_ASK[lang], mid: askMid }] };
    }
  }

  /**
   * ЗАХВАТ ДО ОТПРАВКИ, АТОМАРНЫЙ (разбор 30.08.2026: тот же класс гонки, что уже
   * ловили и чинили в leadMagnet.ts — «повтор доставки Meta приходит не следующим
   * по очереди, а ВТОРЫМ HTTP-запросом параллельно первому», см. deliver() там же).
   *
   * `input.alreadySent` — это `guideSentAt`, прочитанный ОДИН раз в самом начале
   * хода (messengers/conversation.ts), а между этим чтением и текущей строкой
   * успевает пройти весь ход: дебаунс, вызов ИИ, генерация ответа. Прежняя запись
   * `guideSentAt` ПОСЛЕ отправки (ниже по файлу) не защищала ничем — только
   * подтверждала то, что уже случилось. Здесь запись ДО отправки, условием
   * `guideSentAt: null`: кто не смог обновить строку — не отправляет вовсе.
   */
  const claimed = await prisma.botConversation.updateMany({
    where: { id: input.conversationId, guideSentAt: null },
    data: { guideSentAt: now, guideAwaitFollowAt: null },
  });
  if (claimed.count === 0) return NOTHING;

  let fileMid: string | null = null;
  // Instagram Send API не принимает документы (PDF) от бизнеса вовсе — только
  // фото/видео/аудио (см. buildFileRequest в messengers/meta.ts, 26.08.2026).
  // Отдаём ссылку: в Instagram она кликабельна, файл человек откроет сам.
  const asLink = input.channel === "INSTAGRAM";
  try {
    fileMid = asLink
      ? await sendMessage("INSTAGRAM", input.recipientId, url, input.token)
      : await sendFile(input.channel as "WHATSAPP" | "FACEBOOK", input.recipientId, url, input.token, file.name);
  } catch (err) {
    void logSystemError("meta", `Файл-гид не ушёл клиенту: ${describeError(err)}`);
    // Откат захвата: отправка не удалась, следующий ход обязан получить право
    // попробовать снова, а не молчать вечно с guideSentAt, будто файл уже ушёл.
    await prisma.botConversation
      .update({ where: { id: input.conversationId }, data: { guideSentAt: null } })
      .catch(() => {});
    return NOTHING;
  }

  const caption = FILE_CAPTION[lang];
  // Подпись отдельным сообщением: файл без единого слова выглядит как случайное
  // вложение, а приписать текст к документу Meta не даёт.
  let captionMid: string | null = null;
  try {
    captionMid = await sendMessage(input.channel as "INSTAGRAM", input.recipientId, caption, input.token);
  } catch (err) {
    void logSystemError("meta", `Подпись к файлу-гиду не ушла: ${describeError(err)}`);
    // Файл уже у клиента, подпись — не критична
  }

  try {
    await prisma.botConversation.update({
      where: { id: input.conversationId },
      data: { guideSentAt: now, guideAwaitFollowAt: null },
    });
  } catch (err) {
    // Файл уже у клиента — ход не роняем. Худшее последствие невыставленной
    // отметки: файл уйдёт второй раз, и это заметно лучше упавшего ответа.
    void logSystemError("meta", `Отметка об отправке гида не записана: ${describeError(err)}`);
  }

  const said: GuideSendResult["said"] = [{ text: caption, mid: captionMid }];
  // Пометка "[файл: ...]" ничего Meta не отправляла отдельно — mid файла относится
  // к ней, а не к подписи, тем же приёмом, что в leadMagnet.ts (see: [файл: ...]).
  // В Instagram файл ушёл ссылкой — в ленту диалога кладём то, что реально отправлено.
  said.push(asLink ? { text: url, mid: fileMid } : { text: `[файл: ${file.name}]`, mid: fileMid });
  return { sent: true, fileName: file.name, said };
}

/** Реплики для ленты диалога: что код сказал и отправил от имени бота, с mid для дедупликации эха. */
export function guideMessages(
  result: GuideSendResult
): { role: "assistant"; content: string; by: { kind: "bot" }; mid?: string }[] {
  return result.said.map(({ text, mid }) => ({
    role: "assistant" as const,
    content: text,
    by: { kind: "bot" as const },
    ...(mid ? { mid } : {}),
  }));
}
