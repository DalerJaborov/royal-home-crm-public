/**
 * ПРИВЯЗКА ЛИЧНОГО TELEGRAM АГЕНТА К CRM (01.09.2026, владелец: «монтажёр пусть
 * просто отвечает боту»).
 *
 * До этого дня агент не мог получать личные сообщения от CRM-бота — бот умел
 * только вести переписку с КЛИЕНТАМИ (telegram/bot.ts::handleClientMessages).
 * Первое применение — ручная передача видео монтажёру (lib/videoHandoff.ts), но
 * само поле Agent.telegramChatId общее, не привязано к одной функции.
 *
 * Самообслуживание, без участия разработчика: агент жмёт кнопку в своём профиле
 * → получает одноразовый код и прямую ссылку t.me/<бот>?start=<код> → открывает
 * ссылку (или пишет код боту вручную) → бот сам находит агента по коду и
 * запоминает chat_id. Код одноразовый: после успешной привязки обнуляется, им
 * нельзя воспользоваться дважды и нельзя перехватить, отправив тот же код позже.
 */
import crypto from "node:crypto";
import { prisma } from "../db.js";
import {
  answerCallbackQuery,
  editMessageText,
  getBotUsername,
  removeKeyboard,
  sendMessage,
  sendMessageWithButtons,
  type TelegramCallbackQuery,
} from "../telegram/api.js";
import { claimCallback } from "./telegramCallbackClaim.js";
import { sendPushToAgent } from "../push.js";
import { logAgentAudit } from "./audit.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";

const LINK_CODE_BYTES = 12;

/**
 * СРОК ЖИЗНИ КОДА (25.11.2026). Ссылку теперь выдаёт и администратор (Настройки →
 * Сотрудники → «Подключить к Шабнам»), а он пересылает её сотруднику мессенджером:
 * вечная ссылка, утёкшая из переписки, через месяц привязала бы чужой Telegram — канал
 * кода входа. Сутки — с запасом на «открою вечером». Код без срока (выдан до этой
 * правки) действует как раньше, чтобы не сломать привязку, начатую до выката.
 */
export const LINK_CODE_TTL_MS = 24 * 60 * 60_000;
/** Сколько ждём ответа на «Перепривязать этот Telegram?» — дольше код не живёт. */
export const RELINK_CONFIRM_TTL_MS = 15 * 60_000;

/** Код ещё действует: срок не задан (старый код) или не истёк. */
function liveCodeWhere(now: Date) {
  return { OR: [{ telegramLinkCodeExpiresAt: null }, { telegramLinkCodeExpiresAt: { gt: now } }] };
}

/** Заводит новый код привязки для агента (или перезаписывает старый, если
 *  агент нажал кнопку второй раз, не завершив привязку первым кодом). */
export async function createTelegramLinkCode(agentId: string): Promise<{ code: string; deepLink: string | null }> {
  const code = crypto.randomBytes(LINK_CODE_BYTES).toString("base64url");
  await prisma.agent.update({
    where: { id: agentId },
    data: { telegramLinkCode: code, telegramLinkCodeExpiresAt: new Date(Date.now() + LINK_CODE_TTL_MS) },
  });
  const username = await getBotUsername();
  return { code, deepLink: username ? `https://t.me/${username}?start=${code}` : null };
}

/**
 * Обрабатывает `/start <код>` от личного чата в Telegram. true — код подошёл,
 * привязка состоялась (или уже была активна этим же чатом — повторный /start
 * тем же человеком не должен пугать ошибкой). false — код неизвестен/истёк:
 * вызывающий код (telegram/bot.ts) сам решает, что ответить (скорее всего это
 * клиент, впервые пишущий боту, а не монтажёр).
 */
export async function tryLinkAgentByCode(
  chatId: string,
  code: string,
  telegramUserId?: string | null,
  opts: { confirmRelink?: boolean } = {}
): Promise<boolean> {
  return (await linkAgentByCode(chatId, code, telegramUserId, opts)) !== "unknown";
}

/**
 * Итог `/start <код>`: «linked» — привязали; «asked» — этот Telegram уже у ДРУГОЙ
 * действующей учётки, бот спросил кнопками, код не съеден; «unknown» — код не наш.
 */
export type TelegramLinkOutcome = "linked" | "asked" | "unknown";

export async function linkAgentByCode(
  chatId: string,
  code: string,
  telegramUserId?: string | null,
  opts: { confirmRelink?: boolean } = {}
): Promise<TelegramLinkOutcome> {
  const now = new Date();
  // Только действующая учётка (G16, 02.10.2026): код, выданный до увольнения,
  // не должен привязывать чат к отключённой учётке. И только живой код (25.11.2026).
  const agent = await prisma.agent.findFirst({
    where: { telegramLinkCode: code, isActive: true, ...liveCodeWhere(now) },
    select: { id: true, fullName: true },
  });
  if (!agent) return "unknown";
  // НЕ В ТОТ АККАУНТ (25.11.2026, живой случай: у одной сотрудницы две учётки и два Telegram).
  // Раньше чат молча снимался с другой ДЕЙСТВУЮЩЕЙ учётки: открыла ссылку не из того Telegram —
  // и первая учётка тихо осталась без Шабнам. Теперь спрашиваем; код живёт ещё RELINK_CONFIRM_TTL_MS.
  // Отключённая прежняя учётка (увольнение и новый найм, G16) — без вопроса, как раньше.
  if (!opts.confirmRelink) {
    const holders = await otherActiveHolders(agent.id, chatId, telegramUserId);
    if (holders.length > 0) {
      await askRelinkConfirmation(chatId, code, agent, holders);
      return "asked";
    }
  }
  // Чат принадлежит тому, кто прислал код, и он выбирает, к какой учётке его
  // привязать. Прежняя привязка этого чата (обычно — учётка до увольнения и
  // нового найма) снимается: telegramChatId уникален, и без этого привязка
  // падала исключением, а бот молчал (G16, 02.10.2026).
  //
  // КОД «СЪЕДАЕТСЯ» УСЛОВНЫМ АПДЕЙТОМ ВНУТРИ ТРАНЗАКЦИИ (аудит Codex 04.10.2026,
  // ACCESS-10). Раньше запись шла по одному id без условия на сам код: два чата с
  // ещё действующим кодом проходили поиск выше оба, оба получали true, а второй
  // молча перепривязывал учётку и снимал первого. Теперь победитель один: тот, чей
  // updateMany ещё застал этот код (и действующую учётку); остальные получают
  // count=0 и false. Код, сброшенный или заменённый после поиска, тоже не сработает.
  // С кем этот Telegram был до сих пор — для журнала (кого перепривязали, понятно и задним числом).
  const previous = await otherActiveHolders(agent.id, chatId, telegramUserId);
  const linked = await prisma.$transaction(async (tx) => {
    const claim = await tx.agent.updateMany({
      where: { id: agent.id, telegramLinkCode: code, isActive: true, ...liveCodeWhere(now) },
      data: { telegramLinkCode: null, telegramLinkCodeExpiresAt: null },
    });
    if (claim.count === 0) return false;
    await tx.agent.updateMany({
      where: { telegramChatId: chatId, id: { not: agent.id } },
      data: { telegramChatId: null },
    });
    // user id (П5): в общей группе сотрудника узнают только по нему. Прежняя привязка
    // этого Telegram-аккаунта к другой учётке снимается — поле уникально.
    if (telegramUserId) {
      await tx.agent.updateMany({
        where: { telegramUserId, id: { not: agent.id } },
        data: { telegramUserId: null },
      });
    }
    await tx.agent.update({
      where: { id: agent.id },
      data: { telegramChatId: chatId, ...(telegramUserId ? { telegramUserId } : {}) },
    });
    return true;
  });
  if (!linked) return "unknown";
  for (const p of previous) {
    logAgentAudit(agent.id, "TELEGRAM_UNLINKED", "Agent", p.id, { source: "telegram-relink", toAgentId: agent.id });
  }
  // Первое сообщение привязанному сотруднику снимает reply-клавиатуру «Поделиться номером»,
  // которую клиентский бот мог поставить ему ДО привязки (21.11.2026): кнопка не должна висеть.
  await removeKeyboard(chatId, `Готово, ${agent.fullName} — этот чат привязан к вашему аккаунту Royal Home CRM.`).catch(
    () => {}
  );
  await noteTelegramLinked(agent.id);
  return "linked";
}

/**
 * След и весть о привязке (аудит безопасности 17.11.2026, S2). Telegram — канал
 * кода входа: привязка чужого чата = чужой вход в учётку. Запись в журнале
 * действий и сообщение самому сотруднику в CRM (колокольчик всегда, пуш на
 * устройства; вид «безопасность» личными отключениями не глушится). Если
 * привязывал не он — он узнает сразу, а не когда заглянет в профиль.
 * Сбой сообщения привязку не отменяет, но попадает в «Здоровье системы».
 */
async function noteTelegramLinked(agentId: string): Promise<void> {
  logAgentAudit(agentId, "TELEGRAM_LINKED", "Agent", agentId, { source: "telegram" });
  try {
    await sendPushToAgent(agentId, {
      kind: "security",
      title: "🔐 К учётке привязан Telegram",
      body: `${dushanbeDateTimeString(new Date())} по Душанбе к вашей учётке привязан чат Telegram — туда может приходить код входа. Если это были не вы — нажмите «Отвязать» в профиле и сообщите директору.`,
      url: "/profile",
      tag: `telegram-linked-${agentId}`,
    });
  } catch (err) {
    void logSystemError("api", `Сообщение о привязке Telegram не ушло: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: `telegram-linked-notice:${agentId}`,
    });
  }
}

/** Чат уже привязан к какому-то агенту? Основной способ отличить сообщение
 *  СОТРУДНИКА от сообщения клиента в общем потоке апдейтов бота.
 *
 * `isActive: true` (25.09.2026, А5) — уволенный/деактивированный сотрудник не
 * должен продолжать отвечать ботом как действующий агент (в частности как
 * монтажёр: settings.ts запрещает НАЗНАЧИТЬ неактивного, но чат мог остаться
 * привязан у того, кто был активен на момент привязки и разжалован позже). */
export async function findAgentByTelegramChatId(
  chatId: string
): Promise<{ id: string; fullName: string } | null> {
  return prisma.agent.findFirst({ where: { telegramChatId: chatId, isActive: true }, select: { id: true, fullName: true } });
}


/** Сотрудник по Telegram user id (общая группа, нажатие кнопки). Только действующая учётка. */
export async function findAgentByTelegramUserId(
  userId: string
): Promise<{ id: string; fullName: string } | null> {
  return prisma.agent.findFirst({ where: { telegramUserId: userId, isActive: true }, select: { id: true, fullName: true } });
}

// ─────────────── «Перепривязать этот Telegram?» (25.11.2026) ───────────────

/** Префикс кнопок вопроса о перепривязке: tl:y:<код> — да, tl:n:<код> — нет. */
export const RELINK_CALLBACK_PREFIX = "tl:";

/** Другие ДЕЙСТВУЮЩИЕ учётки, за которыми сейчас записан этот чат или этот Telegram-аккаунт. */
async function otherActiveHolders(
  agentId: string,
  chatId: string,
  telegramUserId?: string | null
): Promise<Array<{ id: string; fullName: string }>> {
  return prisma.agent.findMany({
    where: {
      id: { not: agentId },
      isActive: true,
      OR: [{ telegramChatId: chatId }, ...(telegramUserId ? [{ telegramUserId }] : [])],
    },
    select: { id: true, fullName: true },
    take: 3,
  });
}

/**
 * Тексты вопроса — на «вы», по-русски и по-таджикски одним сообщением: язык сотрудника
 * бот здесь ещё не знает (учётка не привязана). Таджикская часть — по скиллу
 * tajik-phrasebook, «шумо», без «лутфан»; ПОМЕЧЕНА ДЛЯ ПРОВЕРКИ НОСИТЕЛЕМ (журнал 25.11).
 */
export const RELINK_TEXTS = {
  question: (from: string, to: string) =>
    `Этот Telegram уже подключён к учётке «${from}» в Royal Home CRM.\n` +
    `Перепривязать его на «${to}»? Тогда Шабнам будет узнавать вас здесь как «${to}», а у «${from}» этот Telegram отключится.\n\n` +
    `Ин Telegram аллакай ба ҳисоби «${from}» дар Royal Home CRM пайваст аст.\n` +
    `Онро ба «${to}» гузаронем? Он гоҳ Шабнам шуморо дар ин ҷо ҳамчун «${to}» мешиносад, ва аз «${from}» ин Telegram ҷудо мешавад.`,
  yes: "Да, перепривязать / Ҳа",
  no: "Нет, оставить / Не",
  kept: (from: string) =>
    `Хорошо, ничего не меняю: этот Telegram остаётся у «${from}».\nХуб, ҳеҷ чиз тағйир намеёбад: ин Telegram дар «${from}» мемонад.`,
  expired:
    "Ссылка устарела. Попросите новую в профиле CRM или у администратора.\nИстинод кӯҳна шуд. Истиноди навро дар профили CRM ё аз маъмур гиред.",
  notYours: "Эта кнопка не для вас.",
} as const;

/** Задать вопрос и укоротить жизнь кода до RELINK_CONFIRM_TTL_MS (если он и так короче — не продлеваем). */
async function askRelinkConfirmation(
  chatId: string,
  code: string,
  agent: { id: string; fullName: string },
  holders: Array<{ id: string; fullName: string }>
): Promise<void> {
  const current = await prisma.agent.findUnique({ where: { id: agent.id }, select: { telegramLinkCodeExpiresAt: true } });
  const cap = new Date(Date.now() + RELINK_CONFIRM_TTL_MS);
  const expiresAt = current?.telegramLinkCodeExpiresAt && current.telegramLinkCodeExpiresAt < cap ? current.telegramLinkCodeExpiresAt : cap;
  await prisma.agent.updateMany({ where: { id: agent.id, telegramLinkCode: code }, data: { telegramLinkCodeExpiresAt: expiresAt } });
  const from = holders.map((h) => h.fullName).join(", ");
  try {
    await sendMessageWithButtons(chatId, RELINK_TEXTS.question(from, agent.fullName), [
      [
        { text: RELINK_TEXTS.yes, callback_data: `${RELINK_CALLBACK_PREFIX}y:${code}` },
        { text: RELINK_TEXTS.no, callback_data: `${RELINK_CALLBACK_PREFIX}n:${code}` },
      ],
    ]);
  } catch (err) {
    void logSystemError("telegram", `Вопрос «перепривязать Telegram» не ушёл: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: `telegram-relink-ask:${agent.id}`,
    });
  }
}

/**
 * Нажатие «Да / Нет» под вопросом о перепривязке. true — кнопка наша и разобрана.
 * Отвечает только тот, кто прислал код: кнопка живёт в его личке, и нажать её может
 * только владелец этого чата (from.id = chat.id). Двойное нажатие гасит claimCallback.
 */
export async function handleTelegramRelinkCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith(RELINK_CALLBACK_PREFIX)) return false;
  const match = data.slice(RELINK_CALLBACK_PREFIX.length).match(/^([yn]):(\S+)$/);
  const chatId = query.message?.chat.id != null ? String(query.message.chat.id) : null;
  const fromId = query.from?.id != null ? String(query.from.id) : null;
  if (!match || !chatId || !fromId || fromId !== chatId) {
    await answerCallbackQuery(query.id, RELINK_TEXTS.notYours).catch(() => {});
    return true;
  }
  if (!(await claimCallback(query.id))) {
    await answerCallbackQuery(query.id).catch(() => {});
    return true;
  }
  await answerCallbackQuery(query.id).catch(() => {});
  const [, choice, code] = match;
  const messageId = query.message?.message_id;
  const reply = async (text: string) => {
    if (messageId) {
      try {
        await editMessageText(chatId, messageId, text);
        return;
      } catch {
        // Сообщение уже не правится (старое, удалено) — ответим новым ниже.
      }
    }
    await sendMessage(chatId, text).catch(() => {});
  };
  if (choice === "n") {
    const holders = await prisma.agent.findMany({
      where: { isActive: true, OR: [{ telegramChatId: chatId }, { telegramUserId: fromId }] },
      select: { fullName: true },
      take: 3,
    });
    await reply(RELINK_TEXTS.kept(holders.map((h) => h.fullName).join(", ") || "прежней учётки"));
    return true;
  }
  const outcome = await linkAgentByCode(chatId, code!, fromId, { confirmRelink: true });
  if (outcome === "unknown") await reply(RELINK_TEXTS.expired);
  else if (messageId) await editMessageText(chatId, messageId, "✅ Перепривязано.").catch(() => {});
  return true;
}
