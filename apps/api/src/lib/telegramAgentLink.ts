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
import { getBotUsername, removeKeyboard, requestContact, type TelegramIncomingMessage } from "../telegram/api.js";
import { ASSISTANT_LINK_ASK_CONTACT, ASSISTANT_LINK_RESULT, bothLanguages } from "../telegram/assistantGroupPhrases.js";
import { staffPhoneLookupForms } from "@royal-home/shared";
import { automationSwitchOn } from "./automationSwitches.js";
import { issueLoginCode, LOGIN_SMS_CODE_TTL_MS, maskPhoneForHint, verifyLoginCode } from "./loginSmsCode.js";
import { sendPushToAgent } from "../push.js";
import { logAgentAudit } from "./audit.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";

const LINK_CODE_BYTES = 12;

/** Заводит новый код привязки для агента (или перезаписывает старый, если
 *  агент нажал кнопку второй раз, не завершив привязку первым кодом). */
export async function createTelegramLinkCode(agentId: string): Promise<{ code: string; deepLink: string | null }> {
  const code = crypto.randomBytes(LINK_CODE_BYTES).toString("base64url");
  await prisma.agent.update({ where: { id: agentId }, data: { telegramLinkCode: code } });
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
export async function tryLinkAgentByCode(chatId: string, code: string, telegramUserId?: string | null): Promise<boolean> {
  // Только действующая учётка (G16, 02.10.2026): код, выданный до увольнения,
  // не должен привязывать чат к отключённой учётке.
  const agent = await prisma.agent.findFirst({
    where: { telegramLinkCode: code, isActive: true },
    select: { id: true, fullName: true },
  });
  if (!agent) return false;
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
  const linked = await prisma.$transaction(async (tx) => {
    const claim = await tx.agent.updateMany({
      where: { id: agent.id, telegramLinkCode: code, isActive: true },
      data: { telegramLinkCode: null },
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
  if (!linked) return false;
  // Первое сообщение привязанному сотруднику снимает reply-клавиатуру «Поделиться номером»,
  // которую клиентский бот мог поставить ему ДО привязки (21.11.2026): кнопка не должна висеть.
  await removeKeyboard(chatId, `Готово, ${agent.fullName} — этот чат привязан к вашему аккаунту Royal Home CRM.`).catch(
    () => {}
  );
  await noteTelegramLinked(agent.id);
  return true;
}

/**
 * ПРИВЯЗКА ПО НОМЕРУ ТЕЛЕФОНА (24.11.2026, жалоба владельца «новички пишут в группе, Шабнам не
 * отвечает»: их Telegram не привязан, а код из профиля CRM новичок не знает, где взять).
 *
 * ЗА РУБИЛЬНИКОМ «Привязка Telegram по номеру», ПО УМОЛЧАНИЮ ВЫКЛ (ревью 25.11.2026). Контакт Telegram
 * доказывает только, что на этот номер когда-то завели аккаунт (номер мог смениться у оператора), а
 * привязанный чат получает код входа в CRM. Поэтому даже при ВКЛ:
 *  1) директора и администратора по номеру не привязываем никогда (OWNER_ROLES);
 *  2) номер подтверждается кодом через ту же дверь, что вход (issueLoginCode, назначение
 *     «telegram-link»: СМС на номер из учётки, пуш только если СМС некуда); без верного кода — нет привязки;
 *  3) учётку ищем точными записями номера (staffPhoneLookupForms), а не по хвосту из девяти цифр:
 *     иностранный +998 93 1234567 не должен совпасть с таджикским 93 1234567.
 *
 * Путь: Шабнам в группе один раз даёт новичку кнопку t.me/<бот>?start=staff
 * (telegram/assistantGroupNewcomer.ts) → в личке `/start staff` → бот просит номер нативной кнопкой и
 * открывает окно на 30 минут → СВОЙ контакт (contact.user_id = отправитель) → номер ровно у одного
 * действующего сотрудника, не директора и не админа, без другого Telegram → код на этот номер →
 * шесть цифр в личке за 5 минут → привязка. След в журнале действий и пуш сотруднику (noteTelegramLinked).
 *
 * Клиентский бот не задет: вне окна (никто не открывал ссылку) контакт идёт обычным путём клиента;
 * шесть цифр перехватываются только у того, кому код уже отправлен.
 */
export const STAFF_LINK_START_PAYLOAD = "staff";
export const STAFF_CONTACT_WINDOW_MS = 30 * 60_000;
/** По номеру не привязываем никогда: им — только код из профиля (там подтверждение личности). */
const OWNER_ROLES: ReadonlySet<string> = new Set(["DIRECTOR", "ADMIN"]);

async function phoneLinkEnabled(): Promise<boolean> {
  return automationSwitchOn("telegramPhoneLinkEnabled");
}

/** Действующие сотрудники, у которых номер записан ровно в одной из точных форм этого номера. */
async function findActiveStaffByExactPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return [];
  // Telegram присылает номер то с «+», то без: обе записи, каждая через одно общее правило форм.
  const forms = [...new Set([...staffPhoneLookupForms(phone), ...staffPhoneLookupForms(`+${digits}`), ...staffPhoneLookupForms(digits)])];
  return prisma.agent.findMany({
    where: { isActive: true, phone: { in: forms } },
    select: { id: true, fullName: true, role: true, phone: true, telegramUserId: true, telegramChatId: true },
    take: 3,
  });
}

/** Ссылка из группы в личку с ботом, которая начинает привязку по номеру. */
export async function staffLinkDeepLink(): Promise<string | null> {
  const username = await getBotUsername();
  return username ? `https://t.me/${username}?start=${STAFF_LINK_START_PAYLOAD}` : null;
}

class LinkRefused extends Error {
  constructor(readonly reason: "otherTelegram") {
    super(reason);
  }
}

/** `/start staff` в личке. true — разобрано здесь (клиентской логике сообщение не отдаём). */
export async function askStaffContactForLink(msg: TelegramIncomingMessage): Promise<boolean> {
  if (msg.chat.type !== "private" || !msg.from?.id || msg.from.is_bot) return false;
  const chatId = String(msg.chat.id);
  const telegramUserId = String(msg.from.id);
  const known = (await findAgentByTelegramChatId(chatId)) ?? (await findAgentByTelegramUserId(telegramUserId));
  if (known) {
    await removeKeyboard(chatId, bothLanguages(ASSISTANT_LINK_RESULT.alreadyLinked)).catch(() => {});
    return true;
  }
  // Выключено (по умолчанию) — номер не просим, показываем путь через профиль: старая кнопка в группе
  // не должна открывать привязку, которую директор не включал.
  if (!(await phoneLinkEnabled())) {
    await removeKeyboard(chatId, bothLanguages(ASSISTANT_LINK_RESULT.phoneLinkOff)).catch(() => {});
    return true;
  }
  const now = new Date();
  await prisma.assistantTelegramLinkOffer.upsert({
    where: { telegramUserId },
    create: { telegramUserId, chatId, offeredAt: now, contactRequestedAt: now },
    update: { contactRequestedAt: now, pendingAgentId: null, codeSentAt: null },
  });
  await requestContact(chatId, bothLanguages(ASSISTANT_LINK_ASK_CONTACT));
  return true;
}

/**
 * Контакт в личке в окне после `/start staff`. true — разобрано здесь; false — окна нет, это
 * обычный контакт (клиент делится номером), пусть идёт клиентским путём.
 */
export async function tryLinkAgentByContact(msg: TelegramIncomingMessage): Promise<boolean> {
  if (msg.chat.type !== "private" || !msg.contact || !msg.from?.id || msg.from.is_bot) return false;
  const chatId = String(msg.chat.id);
  const telegramUserId = String(msg.from.id);
  const pending = await prisma.assistantTelegramLinkOffer.findUnique({ where: { telegramUserId } });
  const requestedAt = pending?.contactRequestedAt;
  if (!requestedAt || Date.now() - requestedAt.getTime() > STAFF_CONTACT_WINDOW_MS) return false;
  if (msg.contact.user_id == null || String(msg.contact.user_id) !== telegramUserId) {
    // Окно не закрываем: человек может нажать правильную кнопку.
    await requestContact(chatId, bothLanguages(ASSISTANT_LINK_RESULT.notOwnContact)).catch(() => {});
    return true;
  }
  // Одна попытка на одно окно: дубль апдейта или вторая отправка не привяжут дважды.
  const closed = await prisma.assistantTelegramLinkOffer.updateMany({
    where: { telegramUserId, contactRequestedAt: requestedAt },
    data: { contactRequestedAt: null },
  });
  if (closed.count !== 1) return true;
  const answer = (lines: { ru: string; tg: string }) => removeKeyboard(chatId, bothLanguages(lines)).catch(() => {});
  // Рубильник выключили, пока окно было открыто: номер не берём, показываем путь через профиль.
  if (!(await phoneLinkEnabled())) { await answer(ASSISTANT_LINK_RESULT.phoneLinkOff); return true; }
  const matches = await findActiveStaffByExactPhone(msg.contact.phone_number ?? "");
  if (matches.length === 0) { await answer(ASSISTANT_LINK_RESULT.notFound); return true; }
  if (matches.length > 1) { await answer(ASSISTANT_LINK_RESULT.ambiguous); return true; }
  const [agent] = matches;
  if (OWNER_ROLES.has(agent.role)) { await answer(ASSISTANT_LINK_RESULT.ownerRole); return true; }
  const holder = (await findAgentByTelegramUserId(telegramUserId)) ?? (await findAgentByTelegramChatId(chatId));
  if (holder) {
    await answer(holder.id === agent.id ? ASSISTANT_LINK_RESULT.alreadyLinked : ASSISTANT_LINK_RESULT.otherTelegram);
    return true;
  }
  if ((agent.telegramUserId && agent.telegramUserId !== telegramUserId) || (agent.telegramChatId && agent.telegramChatId !== chatId)) {
    await answer(ASSISTANT_LINK_RESULT.otherTelegram);
    return true;
  }
  // Подтверждение номера кодом — та же дверь, что вход в CRM (лимиты, одноразовость, HMAC в базе).
  const issued = await issueLoginCode({ id: agent.id, phone: agent.phone, telegramChatId: null }, undefined, { purpose: "telegram-link" })
    .catch((err) => {
      void logSystemError("telegram", `Код привязки Telegram по номеру не выдан: ${err instanceof Error ? err.message : String(err)}`, {
        dedupKey: "telegram-link-by-phone-code",
      });
      return { ok: false as const, error: "" };
    });
  if (!issued.ok) { await answer(ASSISTANT_LINK_RESULT.codeNotSent); return true; }
  await prisma.assistantTelegramLinkOffer.update({
    where: { telegramUserId },
    data: { pendingAgentId: agent.id, codeSentAt: new Date() },
  });
  await answer(ASSISTANT_LINK_RESULT.codeSent(issued.channel === "push" ? { sms: false } : { sms: true, mask: maskPhoneForHint(agent.phone) }));
  return true;
}

/**
 * Шесть цифр в личке от того, кому после контакта ушёл код (шаг 2 привязки по номеру). true — разобрано
 * здесь; false — кода никто не ждёт, сообщение идёт своим путём (клиент мог прислать любые цифры).
 */
export async function tryConfirmStaffLinkCode(msg: TelegramIncomingMessage): Promise<boolean> {
  if (msg.chat.type !== "private" || !msg.from?.id || msg.from.is_bot || msg.forward_origin || msg.forward_from_message_id) return false;
  const code = (msg.text ?? "").replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(code)) return false;
  const chatId = String(msg.chat.id);
  const telegramUserId = String(msg.from.id);
  const pending = await prisma.assistantTelegramLinkOffer.findUnique({ where: { telegramUserId } });
  const agentId = pending?.pendingAgentId;
  const sentAt = pending?.codeSentAt;
  if (!agentId || !sentAt) return false;
  const answer = (lines: { ru: string; tg: string }) => removeKeyboard(chatId, bothLanguages(lines)).catch(() => {});
  const closeWindow = () => prisma.assistantTelegramLinkOffer.updateMany({
    where: { telegramUserId, pendingAgentId: agentId, codeSentAt: sentAt },
    data: { pendingAgentId: null, codeSentAt: null },
  });
  if (Date.now() - sentAt.getTime() > LOGIN_SMS_CODE_TTL_MS || !(await phoneLinkEnabled())) {
    await closeWindow();
    await answer(ASSISTANT_LINK_RESULT.codeExpired);
    return true;
  }
  const verified = await verifyLoginCode(agentId, code);
  if (!verified.ok) {
    const final = !/^Неверный код/.test(verified.error);
    if (final) await closeWindow();
    await answer(final ? ASSISTANT_LINK_RESULT.codeExpired : ASSISTANT_LINK_RESULT.wrongCode);
    return true;
  }
  // Один верный код — одна привязка: дубль апдейта окно уже не застанет.
  if ((await closeWindow()).count !== 1) return true;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true, role: true, isActive: true } });
  if (!agent?.isActive) { await answer(ASSISTANT_LINK_RESULT.notFound); return true; }
  if (OWNER_ROLES.has(agent.role)) { await answer(ASSISTANT_LINK_RESULT.ownerRole); return true; }
  try {
    await prisma.$transaction(async (tx) => {
      // Привязки уволенных к этому аккаунту и чату снимаем: поля уникальны (тот же довод, что выше).
      await tx.agent.updateMany({ where: { telegramUserId, id: { not: agentId }, isActive: false }, data: { telegramUserId: null } });
      await tx.agent.updateMany({ where: { telegramChatId: chatId, id: { not: agentId }, isActive: false }, data: { telegramChatId: null } });
      // Захват только свободной учётки (или уже этой же парой): ни чужой Telegram, ни чужой чат не перезаписываем.
      const claim = await tx.agent.updateMany({
        where: {
          id: agentId, isActive: true, role: { notIn: ["DIRECTOR", "ADMIN"] },
          AND: [
            { OR: [{ telegramUserId: null }, { telegramUserId }] },
            { OR: [{ telegramChatId: null }, { telegramChatId: chatId }] },
          ],
        },
        data: { telegramUserId, telegramChatId: chatId },
      });
      if (claim.count !== 1) throw new LinkRefused("otherTelegram");
    });
  } catch (err) {
    if (err instanceof LinkRefused) { await answer(ASSISTANT_LINK_RESULT.otherTelegram); return true; }
    void logSystemError("telegram", `Привязка Telegram по номеру не удалась: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "telegram-link-by-phone",
    });
    await answer(ASSISTANT_LINK_RESULT.otherTelegram);
    return true;
  }
  await answer(ASSISTANT_LINK_RESULT.linked(agent.fullName));
  await noteTelegramLinked(agentId, "telegram-phone");
  return true;
}

/**
 * След и весть о привязке (аудит безопасности 17.11.2026, S2). Telegram — канал
 * кода входа: привязка чужого чата = чужой вход в учётку. Запись в журнале
 * действий и сообщение самому сотруднику в CRM (колокольчик всегда, пуш на
 * устройства; вид «безопасность» личными отключениями не глушится). Если
 * привязывал не он — он узнает сразу, а не когда заглянет в профиль.
 * Сбой сообщения привязку не отменяет, но попадает в «Здоровье системы».
 */
async function noteTelegramLinked(agentId: string, source: "telegram" | "telegram-phone" = "telegram"): Promise<void> {
  logAgentAudit(agentId, "TELEGRAM_LINKED", "Agent", agentId, { source });
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
