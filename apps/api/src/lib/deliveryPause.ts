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
 * СРОК ПАУЗЫ ПРИ ОТПРАВКЕ — ОДНА ДВЕРЬ для текста, голосового и файла (21.11.2026). После выката #333 на проде встали две
 * новые вечные паузы: интерфейс шлёт с КАЖДЫМ ответом сотрудника явный срок «Бессрочно» (Messages.tsx, MobileChatView.tsx,
 * решение 18.08), и явный срок обходил эстафету. В режиме «только заявки» срок сотрудника не длиннее эстафеты: короче —
 * ставится как выбран (сознательно короткая пауза), длиннее или «Бессрочно» — это эстафета, действующую паузу не
 * укорачиваем. Долгая пауза — только отдельной кнопкой «Пауза» (POST /conversations/:id/pause, с записью в журнал).
 * Вне режима — как было: явный срок ставится как есть, без срока — срок по умолчанию для отправителя (`defaultMs`,
 * conversationDelivery.ts::defaultPauseForSender — передаётся снаружи, чтобы этот модуль не тянул отправку).
 */
export async function deliveryPauseFor(target: Pick<DeliveryTarget, "kind" | "id">, override: Date | undefined,
  sender: { kind: string } | undefined, defaultMs: () => Promise<number>): Promise<{ until: Date; keepLonger: boolean }> {
  if (override && sender?.kind !== "bot" && sender?.kind !== "system") {
    const relay = await staffRelayPauseMs(target);
    if (relay !== null) {
      const relayUntil = new Date(Date.now() + relay);
      return override.getTime() < relayUntil.getTime() ? { until: override, keepLonger: false } : { until: relayUntil, keepLonger: true };
    }
  }
  if (override) return { until: override, keepLonger: sender?.kind === "bot" };
  return { until: new Date(Date.now() + (await defaultMs())), keepLonger: true };
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
  database: Pick<TxClient, "botConversation" | "telegramConversation"> = prisma,
  /** Сотрудник, чей ответ ставит паузу. Нужен для явного срока: ЧУЖУЮ более длинную паузу он не укорачивает. */
  byAgentId?: string | null
): Promise<Date> {
  const now = new Date();
  const isTelegram = target.kind === "telegram";
  const by = byAgentId ? `${byAgentId}|${now.toISOString()}` : null;
  // Новая пауза — новый отсчёт тревоги «бот на паузе» (pauseAlertSentAt, lib/botPauseWatch.ts; 21.11.2026).
  if (!keepLonger) {
    // Явный срок сотрудника ставится как выбран, КРОМЕ одного случая (ревью PR #463): действующая пауза длиннее
    // выбранного срока и поставлена НЕ им (директор нажал «Пауза бессрочно», агент ответил с умолчанием «1 час»).
    // «Поставлена им» — отметка botPausedBy совпала с текущим botPausedAt; всякая иная запись паузы её гасит.
    if (byAgentId) {
      const cur = isTelegram
        ? await database.telegramConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true, botPausedAt: true, botPausedBy: true } })
        : await database.botConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true, botPausedAt: true, botPausedBy: true } });
      if (cur?.pausedUntil && cur.pausedUntil.getTime() > Math.max(now.getTime(), pausedUntil.getTime())) {
        const mine = !!cur.botPausedAt && cur.botPausedBy === `${byAgentId}|${cur.botPausedAt.toISOString()}`;
        if (!mine) return cur.pausedUntil;
      }
    }
    const data = { pausedUntil, botPausedAt: now, pauseAlertSentAt: null, botPausedBy: by };
    if (isTelegram) await database.telegramConversation.update({ where: { id: target.id }, data });
    else await database.botConversation.update({ where: { id: target.id }, data });
    return pausedUntil;
  }
  // botPausedAt двигается только вместе со сроком: действующую паузу начал не этот
  // вызов, и «пауза протухла» (conversationState.isStalePause) считается от её начала.
  const where = { id: target.id, OR: [{ pausedUntil: null }, { pausedUntil: { lt: pausedUntil } }] };
  const data = { pausedUntil, botPausedAt: now, pauseAlertSentAt: null, botPausedBy: by };
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
