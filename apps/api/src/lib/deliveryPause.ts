import { prisma, type TxClient } from "../db.js";
import type { DeliveryTarget } from "./conversationState.js";

/**
 * ПАУЗА БОТА В ПЕРЕПИСКЕ — одна дверь без отправки (вынесено из conversationDelivery.ts, ревью #344):
 * её зовёт и сама отправка (`meta.ts` → `lib/threadOwnerPause.ts`, «переписку ведёт другое
 * приложение»), а conversationDelivery.ts тянет за собой отправку — общий модуль без цикла импортов.
 * conversationDelivery.ts переизлучает всё отсюда, прежние вызовы не тронуты.
 */

/**
 * ОТВЕТ ИЗ ПРИЛОЖЕНИЯ META (эхо, мимо CRM) — 12 ЧАСОВ, А НЕ 10 МИНУТ (28.09.2026).
 *
 * Жалоба владельца со скриншотом: директор ответил клиенту из приложения Facebook,
 * а бот продолжал писать тому же человеку. Эхо ставило ту же короткую паузу, что и
 * разовая помощь из CRM, — через 10 минут бот возвращался в разговор, который живой
 * человек ещё вёл. Кто держал телефон, Meta не сообщает, поэтому «бессрочно»
 * (только своему агенту, решение 18.08) здесь не годится; 12 часов покрывают
 * рабочий разговор целиком, а наутро бот снова отвечает сам. Раньше вернуть
 * бота — кнопка «Вернуть боту» в переписке.
 */
export const OPERATOR_ECHO_PAUSE_MS = 12 * 60 * 60 * 1000;

/**
 * ЭСТАФЕТА ВМЕСТО ВЕЧНОЙ ПАУЗЫ (владелец 20.11.2026: «бот не должен же молчать»). В режиме «только заявки» (WhatsApp,
 * Instagram, Facebook) бот после заявки отвечает коротко и не продаёт «вторым голосом» (ai/operator/decide.ts), поэтому
 * ответ сотрудника больше не глушит его на 10 лет: бот уступает человеку на N минут (Настройки → Бот, botStaffQuietMinutes,
 * по умолчанию 180 — запасной вариант эстафеты ревью #333: отложенного ответа «по неотвеченному сообщению» на нынешнем
 * конвейере ядра надёжно не сделать). До заявки в переписке, где писал сотрудник, бот и после срока не задаёт вопросов —
 * только сигнал человеку (ai/operator/decide.ts, staffThread). После заявки — короткий ответ и заметка агенту.
 * Ручная кнопка «Пауза» в переписке ставит свой явный срок и этим правилом не меняется; вне режима (сайт, Telegram) — как
 * было. Уже стоящие вечные паузы НЕ укорачиваются (applyDeliveryPause не укорачивает действующую паузу): отличить
 * автоматическую от поставленной кнопкой «Бессрочно» по данным нельзя (journal 2026-11-20-bot-human-replies.md).
 * null — правило к этому разговору не относится. Сбой чтения — прежняя пауза (null): безопаснее промолчать, чем перебить.
 */
export async function staffRelayPauseMs(target: Pick<DeliveryTarget, "kind" | "id">): Promise<number | null> {
  if (target.kind !== "bot") return null;
  try {
    const row = await prisma.botConversation.findUnique({ where: { id: target.id }, select: { channel: true } });
    if (!row) return null;
    const { loadLeadOnlyConfig } = await import("./leadOnlyConfig.js");
    const { leadOnlyAppliesTo } = await import("../ai/leadOnlyMode.js");
    const config = await loadLeadOnlyConfig();
    // Эстафета — отдельный смысл от «Бот отвечает и после заявки» (ревью #333): её держит только режим и срок из Настроек.
    if (!config.enabled || !leadOnlyAppliesTo(row.channel)) return null;
    return Math.max(5, config.staffQuietMinutes ?? 180) * 60_000;
  } catch {
    return null;
  }
}

/**
 * Поставить паузу бота после отправки и вернуть срок, который реально стоит.
 *
 * Срок по умолчанию (оператор не выбирал его сам) и любая отправка от имени бота
 * НИКОГДА не укорачивают уже действующую паузу (23.09.2026). Раньше запись была
 * безусловной: свой агент ответил клиенту — пауза на 10 лет; следом CRM сама
 * слала напоминание о показе, вопрос об отзыве или «уточняю у собственника»
 * (без отправителя-агента — короткая пауза), и срок сжимался до 10 минут. Через
 * 10 минут бот снова вёл разговор параллельно с агентом, клиент получал два
 * противоречащих ответа, агент об этом не знал.
 *
 * Явный срок, который выбрал живой человек (инбокс: «пауза на час»), ставится как
 * есть — укоротить паузу сознательно агент по-прежнему может.
 */
export async function applyDeliveryPause(
  target: Pick<DeliveryTarget, "kind" | "id">,
  pausedUntil: Date,
  keepLonger: boolean,
  database: Pick<TxClient, "botConversation" | "telegramConversation"> = prisma
): Promise<Date> {
  const now = new Date();
  const isTelegram = target.kind === "telegram";
  if (!keepLonger) {
    if (isTelegram) await database.telegramConversation.update({ where: { id: target.id }, data: { pausedUntil, botPausedAt: now } });
    else await database.botConversation.update({ where: { id: target.id }, data: { pausedUntil, botPausedAt: now } });
    return pausedUntil;
  }
  // botPausedAt двигается только вместе со сроком: действующую паузу начал не этот
  // вызов, и «пауза протухла» (conversationState.isStalePause) считается от её начала.
  const where = { id: target.id, OR: [{ pausedUntil: null }, { pausedUntil: { lt: pausedUntil } }] };
  const data = { pausedUntil, botPausedAt: now };
  const { count } = isTelegram
    ? await database.telegramConversation.updateMany({ where, data })
    : await database.botConversation.updateMany({ where, data });
  if (count > 0) return pausedUntil;
  const current = isTelegram
    ? await database.telegramConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } })
    : await database.botConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } });
  if (!current) throw new Error(`Диалог ${target.id} не найден`);
  return current.pausedUntil ?? pausedUntil;
}
