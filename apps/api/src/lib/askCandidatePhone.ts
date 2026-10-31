/**
 * ДОГОНЯЮЩАЯ ПРОСЬБА О НОМЕРЕ У КАНДИДАТОВ, КОТОРЫЕ ЕГО НЕ ОСТАВИЛИ.
 *
 * Владелец 03.09.2026: «всем, у кого нет номера телефона, отправь автоматически,
 * чтобы они отправили номер телефона — с ними хотят созвониться».
 *
 * Речь о тех, кто написал ДО того, как бот начал спрашивать номер обязательно
 * (SCENARIO_JOB, то же 03.09.2026): у новых номер спрашивается прямо в разговоре.
 *
 * ПРОХОД РЕГУЛЯРНЫЙ, А НЕ РАЗОВЫЙ (владелец 03.09.2026: «сделай, чтобы бот сам
 * просил номер, когда окно откроется»). Instagram и WhatsApp не принимают
 * инициативное сообщение позже 24 часов с последней реплики человека — на первом
 * прогоне четверо из девяти оказались именно за этой границей. Окно открывается
 * ровно тогда, когда человек напишет снова, и предсказать этот момент нельзя —
 * поэтому очередь просматривается по расписанию (cron.ts, каждые 15 минут), и
 * просьба уходит в тот же час, когда стало можно.
 *
 * ЭТО СООБЩЕНИЯ ЖИВЫМ ЛЮДЯМ, ПОЭТОМУ ЗДЕСЬ БОЛЬШЕ ЗАПРЕТОВ, ЧЕМ ДЕЙСТВИЙ:
 *
 *  • РОВНО ОДИН РАЗ каждому. Отметка `JobApplication.phoneAskedAt` ставится
 *    только после фактической отправки, поэтому повторный прогон безопасен, а
 *    неудачная попытка не сжигает человека.
 *  • Тем, кто уже дал номер, не пишем — их в выборке нет по определению.
 *  • Молчим, если выключен бот целиком, его канал или ползунок «Вакансии»:
 *    рубильник, до которого дотягивается не всё, хуже отсутствующего.
 *  • НЕ ДУБЛИРУЕМ САМОГО БОТА. Написав нам, кандидат первым делом получает
 *    обычный ответ бота, а тот по своим правилам номер уже просит. Если просьба
 *    в последних репликах есть — считаем дело сделанным и молчим: два
 *    сообщения подряд про один и тот же номер выглядят как неисправный автомат.
 *  • НЕ ОПЕРЕЖАЕМ БОТА. Последним в переписке говорит человек — значит ответ
 *    бота ещё готовится, и наша просьба пришла бы поперёд него.
 *  • Уважаем отказ от переписки (`optedOutAt`) и действующую паузу бота: если
 *    диалог взял на себя человек, писать поверх него нельзя.
 *  • ОКНО META. Instagram и WhatsApp не принимают инициативное сообщение позже
 *    24 часов с последней реплики человека. Такие диалоги пропускаются с
 *    честной пометкой в отчёте, а не «отправляются» в никуда: у Telegram этого
 *    ограничения нет, и он проходит целиком.
 *  • Текст пишет модель на языке кандидата и по его же переписке
 *    (shortAgentReply) — как напоминания молчащим. Модель не ответила — человек
 *    пропускается: рассылать одинаковую строку в переписку, которая шла на
 *    таджикском, значит расписаться, что это автомат.
 *
 * ЗАПУСК НА ПРОДЕ (из каталога репозитория на сервере, после выката):
 *     docker compose -f docker-compose.prod.yml --env-file .env.production exec api \
 *       node dist/lib/askCandidatePhone.js            — показать, кому уйдёт
 *     docker compose -f docker-compose.prod.yml --env-file .env.production exec api \
 *       node dist/lib/askCandidatePhone.js --apply    — отправить
 *
 * Почему в src/lib, а не в scripts/ — см. lib/backfillJobApplications.ts: в
 * прод-образе каталога scripts/ нет и tsx из него вырезан.
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../db.js";
import { shortAgentReply } from "../ai/shortAgentReply.js";
import type { ChatMessage } from "../ai/client.js";
import { sendBotMessageWithMid } from "../messengers/sendBotMessage.js";
import { accountTokenById } from "../messengers/accounts.js";
import { BOT_CHANNELS, asBotChannel, loadBotChannelToggles, type BotChannelToggles } from "../messengers/botChannels.js";
import { loadBotCapabilities } from "../messengers/botCapabilities.js";
import { appendConversationMessages, appendTelegramConversationMessages } from "../messengers/appendMessages.js";
import { sendMessage as sendTelegramMessage } from "../telegram/api.js";
import { describeError } from "./describeError.js";

/** Окно Meta: позже человеку инициативно не написать (то же ограничение, что у
 *  напоминаний молчащим в cron.ts). */
const META_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Сколько последних реплик показываем модели — ей нужен язык и суть разговора,
 *  а не вся история. */
const HISTORY_TURNS = 12;

/**
 * Как узнать, что бот уже просил номер сам. Слова, а не точная фраза: текст
 * каждый раз пишет модель и на языке кандидата. Латиница — для таджикского,
 * набранного латиницей, так пишет заметная часть людей.
 */
const PHONE_ASK_WORDS = /(номер|телефон|рақам|ракам|raqam|nomer|telefon|whatsapp)/i;
/** Сколько последних реплик бота смотрим. Дальше — уже другой разговор. */
const RECENT_BOT_TURNS = 4;

/**
 * НЕ ГОВОРИТЬ ПОВЕРХ ЖИВОГО БОТА (владелец 17.09.2026: «шлёт по 3-4 пузыря подряд
 * без ответа клиента»).
 *
 * Прежний гвард смотрел только на РОЛЬ последней реплики: «последним говорил
 * человек — значит бот ещё отвечает, пропускаем». Обратный случай он не закрывал:
 * бот ответил секунду назад, последняя реплика уже его — и просьба о номере
 * уходила третьим сообщением подряд, хотя человек не сказал ни слова. Для
 * кандидата это выглядит как неисправный автомат, а для Meta — как рассылка.
 *
 * Поэтому смотрим ещё и на ВРЕМЯ: бот говорил только что — очередь вернётся к
 * этому диалогу следующим проходом (через 15 минут), никто не потерян.
 */
const BOT_JUST_SPOKE_MS = 15 * 60 * 1000;

/** Когда бот последний раз говорил в этой переписке. null — время не записано
 *  (реплики до 01.08.2026) или бот ещё не говорил. */
export function botSpokeAt(messages: StoredMessage[]): Date | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (!m.at) return null;
    const at = new Date(m.at);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return null;
}

export function botAlreadyAskedPhone(messages: StoredMessage[]): boolean {
  const recentBot = messages.filter((m) => m.role === "assistant").slice(-RECENT_BOT_TURNS);
  return recentBot.some((m) => PHONE_ASK_WORDS.test(m.content));
}

const INSTRUCTION =
  "Кандидат писал нам о работе, но НЕ оставил номер телефона. Напиши ОДНО короткое дружелюбное " +
  "сообщение на языке кандидата: скажи, что без номера его заявку не принять, и " +
  "попроси прислать номер телефона прямо сюда. Оттолкнись от того, о чём вы уже говорили, чтобы было " +
  "видно, что ты помнишь этого человека. Строго запрещено: обещать трудоустройство, называть зарплату и " +
  "условия, торопить, писать «вы не ответили» и любые внутренние пометки. Также запрещены слово «HR» и любое обещание звонка или связи (владелец 20.09.2026). Ничего, кроме просьбы о номере " +
  "и причины, в сообщении быть не должно.";

export interface AskPhoneResult {
  /** Кандидаты без номера, которых ещё не просили. */
  candidates: number;
  sent: number;
  /** Кому не отправили и почему — по одной строке на человека. */
  skipped: { who: string; reason: string }[];
}

interface Row {
  id: string;
  conversationId: string;
  channel: string;
  name: string | null;
  contactName: string | null;
}

type StoredMessage = { role: "user" | "assistant"; content: string; at?: string };

function readMessages(raw: unknown): StoredMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role, content, at } = item as { role?: unknown; content?: unknown; at?: unknown };
    if (typeof content !== "string" || !content.trim()) continue;
    if (role !== "user" && role !== "assistant") continue;
    out.push({ role, content, ...(typeof at === "string" ? { at } : {}) });
  }
  return out.slice(-HISTORY_TURNS);
}

/**
 * Кого вообще стоит рассматривать — ВСЁ, что известно без модели, решается
 * запросом, а не в цикле (02.10.2026, разбор кандидатов).
 *
 * СТАТУС. Просьба о номере «чтобы с вами связались» уместна только тому, кто в
 * воронке: не NOT_CANDIDATE (продавец, ошибочно попавший в анкеты), не
 * REJECTED (ему отказали) и не HIRED (он уже работает у нас). Раньше фильтра не
 * было вовсе, и всем троим уходило сообщение каждые 15 минут, пока не уйдёт.
 *
 * ГОЛОДАНИЕ ОЧЕРЕДИ. Предел (50 у крона) раньше брался с самых новых анкет ДО
 * проверок, а пропуски «прошло больше 24 часов», «переписка не найдена»,
 * «канал выключен» ничем не помечались — такие строки вечно занимали все 50
 * мест, и до живого кандидата за ними очередь не доходила никогда. Теперь в
 * выборку попадают только диалоги, которым МОЖНО написать сейчас: найденные,
 * без отказа от переписки и без паузы бота, по включённому каналу, а у
 * Instagram/WhatsApp — с открытым 24-часовым окном. Окно откроется снова, когда
 * человек напишет, — тогда он и вернётся в выборку; помечать его навсегда нельзя.
 *
 * НОМЕР УЖЕ ЕСТЬ У ЧЕЛОВЕКА. Кандидат мог дать номер в другом канале: досье
 * (ContactProfile) одно, анкет две. Просить ещё раз — та же «рассылка»,
 * поэтому анкеты, чьё досье уже знает номер по другой анкете, не берём.
 *
 * TELEGRAM_DIRECT (личные сообщения) сюда не попадает сам: его переписка лежит
 * в своей таблице, а писать в неё от имени бота нечем.
 */
async function selectAskableRows(toggles: BotChannelToggles, limit: number): Promise<Row[]> {
  const now = new Date();
  const notPaused = { OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }] };
  const offChannels = BOT_CHANNELS.filter((c) => !toggles.channels[c]);
  const base = {
    phoneAskedAt: null,
    status: { notIn: ["NOT_CANDIDATE", "REJECTED", "HIRED"] },
    ...(offChannels.length > 0 ? { channel: { notIn: offChannels } } : {}),
    AND: [
      { OR: [{ phone: null }, { phone: "" }] },
      {
        OR: [
          { contactProfileId: null },
          {
            contactProfile: {
              jobApplications: { none: { AND: [{ phone: { not: null } }, { NOT: { phone: "" } }] } },
            },
          },
        ],
      },
    ],
    NOT: { conversationId: null },
  };

  // Meta: только диалоги с открытым окном — их за сутки сотни, не тысячи.
  const metaOpen = await prisma.botConversation.findMany({
    where: { lastMessageAt: { gte: new Date(now.getTime() - META_WINDOW_MS) }, optedOutAt: null, ...notPaused },
    select: { id: true },
    take: 5000,
  });
  // Telegram окна не знает — но диалог должен существовать и не стоять на паузе.
  const telegramRows = await prisma.jobApplication.findMany({
    where: { ...base, channel: "TELEGRAM" },
    select: { conversationId: true },
    take: 5000,
  });
  const telegramIds = telegramRows.map((r) => r.conversationId as string);
  const telegramOpen = telegramIds.length
    ? await prisma.telegramConversation.findMany({
        where: { id: { in: telegramIds }, ...notPaused },
        select: { id: true },
      })
    : [];

  const rows = await prisma.jobApplication.findMany({
    where: {
      ...base,
      OR: [
        { channel: "TELEGRAM", conversationId: { in: telegramOpen.map((c) => c.id) } },
        { channel: { not: "TELEGRAM" }, conversationId: { in: metaOpen.map((c) => c.id) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, conversationId: true, channel: true, name: true, contactName: true },
  });
  return rows.map((r) => ({ ...r, conversationId: r.conversationId as string }));
}

export async function askCandidatePhone(options: { apply: boolean; limit?: number }): Promise<AskPhoneResult> {
  const result: AskPhoneResult = { candidates: 0, sent: 0, skipped: [] };

  const capabilities = await loadBotCapabilities();
  if (!capabilities.vacancies) {
    result.skipped.push({ who: "—", reason: "рубильник Настройки → Бот → «Вакансии» выключен: бот молчит" });
    return result;
  }
  const toggles = await loadBotChannelToggles();
  if (!toggles.botEnabled) {
    result.skipped.push({ who: "—", reason: "бот выключен целиком (Настройки → Бот)" });
    return result;
  }

  const rows = await selectAskableRows(toggles, options.limit ?? 200);
  result.candidates = rows.length;

  for (const row of rows) {
    const who = row.name ?? row.contactName ?? row.conversationId.slice(0, 8);
    const isTelegram = row.channel === "TELEGRAM";

    // Канальный рубильник — до вызова модели: платить за текст, который некуда
    // отправить, незачем.
    const botChannel = asBotChannel(row.channel);
    if (botChannel && !toggles.channels[botChannel]) {
      result.skipped.push({ who, reason: `канал ${row.channel} выключен` });
      continue;
    }

    const conv = isTelegram
      ? await prisma.telegramConversation.findUnique({
          where: { id: row.conversationId },
          select: { chatId: true, messages: true, lastMessageAt: true, pausedUntil: true },
        })
      : await prisma.botConversation.findUnique({
          where: { id: row.conversationId },
          select: {
            subscriberId: true,
            accountId: true,
            messages: true,
            lastMessageAt: true,
            pausedUntil: true,
            optedOutAt: true,
          },
        });
    if (!conv) {
      result.skipped.push({ who, reason: "переписка не найдена" });
      continue;
    }
    if ("optedOutAt" in conv && conv.optedOutAt) {
      result.skipped.push({ who, reason: "человек просил ему не писать" });
      continue;
    }
    if (conv.pausedUntil && conv.pausedUntil.getTime() > Date.now()) {
      result.skipped.push({ who, reason: "диалог взял на себя сотрудник (бот на паузе)" });
      continue;
    }
    if (!isTelegram) {
      const last = conv.lastMessageAt?.getTime() ?? 0;
      if (Date.now() - last > META_WINDOW_MS) {
        result.skipped.push({
          who,
          reason: "прошло больше 24 часов — Instagram/WhatsApp инициативное сообщение не доставят",
        });
        continue;
      }
    }

    // Аккаунт выключен тумблером (Настройки → Каналы): первым ему писать нельзя
    // (CHANNEL-NEW-11). Отметку phoneAskedAt не ставим: включат аккаунт, и просьба ещё нужна.
    if (!isTelegram && "accountId" in conv && conv.accountId) {
      if ((await accountTokenById(conv.accountId, row.channel)).disabled) {
        result.skipped.push({ who, reason: "аккаунт выключен в Настройках → Каналы" });
        continue;
      }
    }

    const history = readMessages(conv.messages);
    if (history.length === 0) {
      result.skipped.push({ who, reason: "переписка пустая — не о чем говорить" });
      continue;
    }
    if (history[history.length - 1]?.role === "user") {
      // Человек только что написал — ответ бота ещё готовится. Наша просьба
      // пришла бы поперёд него; вернёмся к этому диалогу следующим проходом.
      result.skipped.push({ who, reason: "бот ещё отвечает на последнее сообщение" });
      continue;
    }
    const spokeAt = botSpokeAt(history);
    if (spokeAt && Date.now() - spokeAt.getTime() < BOT_JUST_SPOKE_MS) {
      // Бот только что писал сам — не встаём третьим пузырём в очередь (см.
      // BOT_JUST_SPOKE_MS). Отметку НЕ ставим: просьба ещё нужна, просто позже.
      result.skipped.push({ who, reason: "бот писал в этот диалог только что — просьба отложена" });
      continue;
    }
    if (botAlreadyAskedPhone(history)) {
      // Бот уже попросил номер сам — задача выполнена, второе сообщение лишнее.
      // Отметку ставим, чтобы очередь не возвращалась к этому диалогу вечно.
      if (options.apply) {
        await prisma.jobApplication.update({ where: { id: row.id }, data: { phoneAskedAt: new Date() } });
      }
      result.skipped.push({ who, reason: "бот уже просил номер в переписке" });
      continue;
    }

    if (!options.apply) {
      result.sent++; // в режиме просмотра это «ушло бы»
      continue;
    }

    try {
      const text = await shortAgentReply(history as ChatMessage[], INSTRUCTION, { name: row.name });
      if (!text) {
        result.skipped.push({ who, reason: "ИИ не ответил — попробуйте позже" });
        continue;
      }

      /**
       * ПЕРЕПРОВЕРКА ПЕРЕД САМОЙ ОТПРАВКОЙ (тот же приём, что у sendFollowUps
       * в cron.ts — «между выборкой и этой строкой прошёл вызов ИИ, и клиент
       * мог за это время ответить»).
       *
       * `shortAgentReply` — это секунды на живом кандидате, который продолжает
       * переписываться с боем НЕЗАВИСИМО от этого прохода: он вполне мог
       * прислать номер именно в эти секунды, бот его уже принял и записал в
       * jobApplication.phone, а мы всё ещё держим в руках готовый текст «дайте
       * ваш номер» — и без этой проверки отправили бы его человеку, который
       * только что его дал. Проверяем оба поля: phone (дал сам) и phoneAskedAt
       * (эту же анкету мог обработать соседний тик — маловероятно при гварде
       * от наложения в cron.ts, но дважды за один номер не пишем никогда).
       */
      const fresh = await prisma.jobApplication.findUnique({
        where: { id: row.id },
        select: { phone: true, phoneAskedAt: true },
      });
      if (!fresh || (fresh.phone && fresh.phone !== "") || fresh.phoneAskedAt) {
        result.skipped.push({ who, reason: "номер уже появился, пока готовился текст — сообщение не ушло" });
        continue;
      }

      if (isTelegram) {
        const chatId = (conv as { chatId: string }).chatId;
        await sendTelegramMessage(chatId, text);
        await appendTelegramConversationMessages(row.conversationId, [
          { role: "assistant", content: text, by: { kind: "bot" } },
        ]);
      } else {
        const bot = conv as { subscriberId: string; accountId: string | null };
        const accountToken = (await accountTokenById(bot.accountId, row.channel)).token;
        const delivery = await sendBotMessageWithMid(row.channel, bot.subscriberId, text, accountToken);
        if (!delivery.sent) {
          result.skipped.push({ who, reason: "канал не принял сообщение" });
          continue;
        }
        // В историю пишем только фактически отправленное — иначе в переписке
        // появилась бы реплика, которой человек никогда не видел. mid обязателен:
        // без него эхо Meta сходит за ручной ответ сотрудника (см. cron.ts).
        await appendConversationMessages(row.conversationId, [
          { role: "assistant", content: text, by: { kind: "bot" }, ...(delivery.mid ? { mid: delivery.mid } : {}) },
        ]);
      }

      // Отметка — ПОСЛЕ отправки: иначе сбой транспорта навсегда лишал бы
      // человека единственной просьбы о номере.
      await prisma.jobApplication.update({ where: { id: row.id }, data: { phoneAskedAt: new Date() } });
      result.sent++;
    } catch (err) {
      result.skipped.push({ who, reason: describeError(err) });
    }
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes("--apply");
  askCandidatePhone({ apply })
    .then((r) => {
      console.log(
        `Кандидатов без номера, которых ещё не просили: ${r.candidates}. ` +
          (apply ? `Отправлено: ${r.sent}.` : `Ушло бы: ${r.sent}. РЕЖИМ ПРОСМОТРА — ничего не отправлено.`)
      );
      for (const s of r.skipped) console.log(`  пропущен ${s.who}: ${s.reason}`);
      if (!apply) console.log("Отправить — тот же запуск с --apply.");
    })
    .catch((err) => {
      console.error("Просьба о номере прервана:", err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
