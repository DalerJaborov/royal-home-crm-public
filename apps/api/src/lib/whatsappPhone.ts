import { prisma } from "../db.js";
import { normalizeDigits } from "./shared/phoneText.js";
import { findPhoneOwners, phoneTail } from "./clientPhones.js";

/**
 * Телефон клиента из WhatsApp — без ожидания, пока человек продиктует его словами.
 *
 * Требование владельца от 31.07.2026, п. 4: «У диалога WhatsApp идентификатор
 * отправителя и есть его номер телефона (wa_id). Подставлять его в карточку клиента
 * автоматически».
 *
 * Что здесь важно понимать про сам wa_id:
 *
 *  1. Это номер ТОЛЬКО в канале WHATSAPP. В INSTAGRAM и FACEBOOK `subscriberId` —
 *     произвольный идентификатор профиля (IGSID / PSID), и превращать его в телефон
 *     нельзя ни при каких условиях: получится карточка с номером «+178901234567890».
 *     Поэтому канал проверяется в одном месте — здесь, а не у каждого вызывающего.
 *
 *  2. Это номер, С КОТОРОГО пишут, а не обязательно тот, по которому просят
 *     перезвонить. Человек пишет с личного, а просит звонить мужу/на рабочий; пишет
 *     помощник, а покупает начальник. Поэтому wa_id хранится ОТДЕЛЬНЫМ полем
 *     `Client.whatsappPhone` («откуда пишет» — факт, подтверждённый транспортом) и не
 *     затирает `Client.phone` («по какому звонить» — то, что человек назвал сам). У
 *     новой карточки, где звонить пока некуда, wa_id становится и `phone` тоже:
 *     номер, с которого написали, всё же лучше пустоты и точно лучше, чем ждать
 *     диктовки. Как только клиент назовёт другой номер, агент правит `phone` в
 *     карточке — `whatsappPhone` при этом остаётся, и адрес переписки не теряется.
 *
 *  3. Клиент с этим номером мог существовать раньше (писал в прошлом месяце, пришёл
 *     с сайта, заведён руками). Это повод СВЯЗАТЬ диалог с существующей карточкой, а
 *     не завести вторую: `Client.phone` уникален, и слепое создание уронило бы приём
 *     сообщения на конфликте. Поиск здесь терпимый к записи номера (см. ниже).
 *
 * Показ номера наружу этот модуль не решает: маскировка живёт там же, где и была, —
 * `presentClient` в routes/clients.ts. `whatsappPhone` проходит ровно через неё же,
 * отдельного механизма видимости не заводим.
 */

/** Канал, в котором subscriberId — это телефон. Единственный. */
export const WHATSAPP_CHANNEL = "WHATSAPP";

/** Разумные границы длины номера в цифрах — как в extractTypedPhone (leadQualifier). */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/**
 * wa_id → телефон в международном формате (+992…). Для любого другого канала, пустого
 * или непохожего на номер значения — null, и вызывающий просто идёт прежним путём
 * (ждёт, пока номер продиктуют).
 *
 * wa_id приходит как «992900000001» — цифры без «+». Приведение к формату общее с
 * остальной CRM (normalizeDigits): свой вариант разошёлся бы с сайтом и Telegram-ботом,
 * и один и тот же человек получил бы две карточки с «+992900000001» и «900000001».
 */
export function whatsAppPhoneFromSubscriberId(channel: string, subscriberId: string): string | null {
  if (channel !== WHATSAPP_CHANNEL) return null;
  const digits = (subscriberId ?? "").replace(/[^\d]/g, "");
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return normalizeDigits(digits);
}

/** Последние 9 цифр — то, чем номер узнаётся независимо от записи кода страны.
 *  Правило одно на всю CRM и живёт в lib/clientPhones.ts. */
const tail9 = phoneTail;

export interface ExistingClientMatch {
  id: string;
  /** Телефон КАК ОН ЗАПИСАН в карточке — его и надо передавать дальше в
   *  createLeadFromChannel, чтобы её findUnique попал точно и отработал штатный путь
   *  «клиент уже есть» / «клиент был в Корзине». */
  phone: string;
  whatsappPhone: string | null;
  deletedAt: Date | null;
}

/**
 * Ищет карточку по номеру ТЕРПИМО к записи: одна и та же цифра могла попасть в базу
 * как «+992900000001», «992900000001» или «+992 90 000 00 01». Форма сайта и боты
 * нормализуют номер, а вот руками и импортом (clientPhoneSchema требует лишь 9 цифр,
 * пробелы и скобки разрешены) он ложится ровно как набрали. Точный findUnique такие
 * расхождения пропускает — и человек, которого в CRM уже ведут, получил бы вторую
 * карточку, а wa_id в неё бы не попал.
 *
 * Шаг 1 — точное совпадение: индекс по уникальному phone, закрывает подавляющее
 * большинство случаев. Шаг 2 — сравнение последних 9 цифр уже ОЧИЩЕННОГО от разделителей
 * значения; делается в SQL, потому что LIKE по сырой колонке «992 90 000 00 01» на
 * «900000001» не срабатывает вовсе (именно на этом ловится дубликат). Шаг 2 идёт по
 * таблице целиком и потому стоит дороже — но выполняется только когда шаг 1 промахнулся,
 * то есть на первом сообщении незнакомого номера, а не на каждой реплике диалога.
 *
 * Карточки из Корзины тоже возвращаются: их воскрешает createLeadFromChannel, и лучше
 * отдать её ему, чем создать дубликат в обход.
 *
 * ШАГ 2 СМОТРИТ НЕ ТОЛЬКО В `phone` (18.08.2026). Раньше он сравнивал единственную
 * колонку, и клиент, позвонивший со второй симки («на первой кончились деньги»),
 * не находился: CRM заводила ему новую карточку и отдавала ДРУГОМУ агенту. Теперь
 * тот же хвост из девяти цифр ищется ещё и в `extraPhones` (запасные номера — см.
 * lib/clientPhones.ts) и в `whatsappPhone` (номер, с которого человек пишет; он же
 * часто и есть его второй телефон). Ровно это узнавание уводит звонок на своего
 * агента прямо на гудке — без ИИ и без задержки.
 */
export async function findClientByPhoneDigits(phone: string): Promise<ExistingClientMatch | null> {
  const exact = await prisma.client.findUnique({
    where: { phone },
    select: { id: true, phone: true, whatsappPhone: true, deletedAt: true },
  });
  if (exact) return exact;

  const suffix = tail9(phone);
  if (suffix.length < MIN_DIGITS) return null;
  // Совпадений в норме ноль или одно; если их несколько (старые дубликаты, которые
  // ещё не объединили), findPhoneOwners уже отсортировал: сначала тот, у кого номер
  // ГЛАВНЫЙ, затем по дате создания — он и есть «настоящая» карточка.
  const rows = await findPhoneOwners([phone], { includeDeleted: true, limit: 5 });
  const found = rows[0];
  return found ? { id: found.id, phone: found.phone, whatsappPhone: found.whatsappPhone, deletedAt: found.deletedAt } : null;
}

export interface WhatsAppLeadIdentity {
  /** Номер WhatsApp (wa_id), приведённый к +992…. Всегда заполнен. */
  waPhone: string;
  /**
   * Телефон, который надо передать в createLeadFromChannel. Совпадает с waPhone для
   * нового человека и равен УЖЕ ЗАПИСАННОМУ телефону, если карточка нашлась, — так
   * createLeadFromChannel попадает в свою ветку «клиент уже есть» вместо попытки
   * создать дубликат и падения на уникальном индексе.
   */
  leadPhone: string;
  /** Найденная карточка (в том числе из Корзины) или null. */
  existingClientId: string | null;
}

/**
 * Всё, что нужно знать про клиента WhatsApp ДО оформления заявки. null — канал не
 * WhatsApp или wa_id не похож на номер: поведение остаётся прежним.
 */
export async function resolveWhatsAppLeadIdentity(
  channel: string,
  subscriberId: string
): Promise<WhatsAppLeadIdentity | null> {
  const waPhone = whatsAppPhoneFromSubscriberId(channel, subscriberId);
  if (!waPhone) return null;
  const existing = await findClientByPhoneDigits(waPhone);
  return {
    waPhone,
    leadPhone: existing?.phone ?? waPhone,
    existingClientId: existing?.id ?? null,
  };
}

/**
 * Дописывает номер WhatsApp в карточку, если его там ещё нет. Ничего не перетирает:
 * уже сохранённый wa_id — тоже факт, и менять его на новый (а такое бывает: человек
 * сменил симку и написал заново) без ведома агента опаснее, чем оставить как есть.
 * Ошибку не бросает: это обогащение карточки, из-за него не должно падать входящее.
 */
export async function rememberWhatsAppPhone(clientId: string, waPhone: string): Promise<void> {
  try {
    await prisma.client.updateMany({
      where: { id: clientId, whatsappPhone: null },
      data: { whatsappPhone: waPhone },
    });
  } catch (err) {
    console.error("[whatsapp] запись номера в карточку:", err instanceof Error ? err.message : err);
  }
}

export type LinkOutcome =
  /** Канал не WhatsApp, номер не разобран или карточки с таким номером нет. */
  | { linked: false; reason: "no_phone" | "no_client" }
  /** Диалог уже привязан (к этой же или к другой карточке) — ничего не меняли. */
  | { linked: false; reason: "already_linked"; clientId: string }
  | { linked: true; clientId: string };

/**
 * Связывает диалог WhatsApp с УЖЕ СУЩЕСТВУЮЩЕЙ карточкой клиента по номеру. Ничего
 * не создаёт и никого не назначает: это именно узнавание «нам пишет наш клиент».
 * Идемпотентна — повторная доставка вебхука ничего не портит.
 *
 * Карточка из Корзины сознательно НЕ привязывается: её воскрешение — отдельное
 * решение с назначением агента и записью в историю, и живёт оно в
 * createLeadFromChannel. Тихо подцепить удалённого клиента к живому диалогу значило
 * бы вернуть его в работу мимо этой логики.
 *
 * `BotConversation.clientId` больше НЕ уникален (19.08.2026, было ограничением
 * схемы — если клиент уже писал в Instagram, привязать WhatsApp было физически
 * нельзя, возвращали `client_busy`). Теперь у карточки может быть несколько
 * диалогов бот-платформы разом — привязываем без оговорок.
 */
export async function linkWhatsAppConversationToClient(
  conversationId: string,
  channel: string,
  subscriberId: string
): Promise<LinkOutcome> {
  const waPhone = whatsAppPhoneFromSubscriberId(channel, subscriberId);
  if (!waPhone) return { linked: false, reason: "no_phone" };

  const conversation = await prisma.botConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, clientId: true, adExternalId: true },
  });
  if (!conversation) return { linked: false, reason: "no_client" };
  if (conversation.clientId) {
    // Диалог уже сведён с карточкой — номер всё равно дописываем: связать могли
    // раньше, чем появилось это поле, или вообще другим путём (через сайт).
    await rememberWhatsAppPhone(conversation.clientId, waPhone);
    return { linked: false, reason: "already_linked", clientId: conversation.clientId };
  }

  const existing = await findClientByPhoneDigits(waPhone);
  if (!existing || existing.deletedAt) return { linked: false, reason: "no_client" };

  await rememberWhatsAppPhone(existing.id, waPhone);

  await prisma.botConversation.update({
    where: { id: conversationId },
    data: { clientId: existing.id },
  });
  // Диалог пришёл с рекламы, а карточка ещё без атрибуции — переносим ad_id
  // (только в пустое поле: какое объявление ПРИВЕЛО, а не последнее увиденное).
  if (conversation.adExternalId) {
    await prisma.client
      .updateMany({ where: { id: existing.id, sourceAdId: null }, data: { sourceAdId: conversation.adExternalId } })
      .catch(() => {
        // Атрибуция — статистика, не данные клиента: привязку диалога она не отменяет.
      });
  }
  return { linked: true, clientId: existing.id };
}
