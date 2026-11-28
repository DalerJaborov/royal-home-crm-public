import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { logSystemAudit } from "./audit.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { enqueueSiteResyncInTransaction } from "./siteResyncQueue.js";
import { loadMoneyContext } from "./money.js";
import { buildPriceDisplay } from "./reelsCaptionTemplate.js";
import { replaceCaptionPriceLines } from "./captionPriceLine.js";
import { stagePriceCaptionTargets } from "./priceCaptionDelivery.js";
import { formatShortCode } from "@royal-home/shared";

/**
 * СТРАЖ КУРСА ДОЛЛАРА (владелец 28.11.2026: «курсы работают? узнаем ли мы о сбое? что будет, если курс изменится?»).
 *
 * Что делает:
 *  1. Скачок курса больше JUMP_LIMIT_PCT за один шаг не применяется сам — ждёт подтверждения руководителя.
 *  2. Курс не обновлялся больше STALE_HOURS часов — одно сообщение директору и админу в сутки.
 *  3. Курс сдвинулся больше порога (Settings.usdRateAlertPct) — цены объектов в долларах на сайте пересылаются
 *     по новому курсу (рубильник usdRateSiteResyncEnabled), а про подписи в соцсетях приходит предупреждение.
 *  4. Подписи в соцсетях сами НЕ переписываются никогда: живые посты правятся только кнопкой руководителя
 *     (refreshStaleRateCaptions). Instagram и TikTok правке через API не поддаются — для них список «руками».
 *
 * Ни одна функция здесь не бросает исключение наружу: курс уже сохранён, сбой стража не должен его откатывать.
 */

/** Скачок за один шаг, % — выше не применяем без подтверждения. */
export const JUMP_LIMIT_PCT = 5;
/** Сколько часов курс может не обновляться, пока не позовём руководство. */
export const STALE_HOURS = 36;
/** Напоминание «не обновлялся» — не чаще раза в сутки. */
const STALE_REPEAT_MS = 24 * 60 * 60 * 1000;
/** За один нажим кнопки правим не больше стольких объектов (посты живые, лишнего не трогаем). */
const CAPTION_BATCH_LIMIT = 40;

const SETTINGS_URL = "/settings?tab=money";

function pctText(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${String(rounded).replace(".", ",")} %`;
}

function rateText(rate: number): string {
  return rate.toFixed(2).replace(".", ",");
}

export function changePct(from: number | null, to: number): number | null {
  return from && from > 0 ? ((to - from) / from) * 100 : null;
}

async function alertLeadership(title: string, body: string, tag: string): Promise<void> {
  await enqueueDirectorAlert({ title, body, url: SETTINGS_URL, kind: "task", tag, recipientRoles: ["DIRECTOR", "ADMIN"] });
}

/** Курс скакнул: не применён, ждёт подтверждения. Сообщение — один раз на каждое новое значение. */
export async function holdJumpedRate(current: number, fetched: number): Promise<void> {
  try {
    const pct = changePct(current, fetched) ?? 0;
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { usdRatePendingValue: true, usdRateAlertsEnabled: true },
    });
    const alreadyPending = settings?.usdRatePendingValue != null && Number(settings.usdRatePendingValue) === fetched;
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { usdRatePendingValue: fetched, usdRatePendingAt: new Date() },
    });
    if (alreadyPending) return;
    logSystemAudit("EXCHANGE_RATE_HELD", "Settings", "singleton", { current, fetched, pct: Math.round(pct * 100) / 100 });
    if (settings?.usdRateAlertsEnabled === false) return;
    await alertLeadership(
      `Курс доллара скакнул: ${rateText(current)} → ${rateText(fetched)} (${pctText(pct)})`,
      `alif.tj отдал курс ${rateText(fetched)}, у нас ${rateText(current)}. Скачок больше ${JUMP_LIMIT_PCT} %, поэтому я его не применил: цены на сайте и деньги остаются по старому курсу. Если курс настоящий — подтвердите в Настройках → Деньги → Курс доллара.`,
      `usd-rate-held-${fetched}`
    );
  } catch (err) {
    void logSystemError("exchange-rate", `Не удалось отметить скачок курса: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Курс применён (ночью, кнопкой «Обновить» или вручную). Если он ушёл от последнего выровненного больше порога —
 * досылает цены на сайт и предупреждает про подписи.
 */
export async function onUsdRateApplied(previous: number | null, next: number, source: "alif-auto" | "manual"): Promise<void> {
  try {
    if (previous != null && previous !== next) {
      logSystemAudit("EXCHANGE_RATE_CHANGED", "Settings", "singleton", {
        from: previous,
        to: next,
        pct: Math.round((changePct(previous, next) ?? 0) * 100) / 100,
        source,
      });
    }
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { usdRateSyncedRate: true, usdRateAlertPct: true, usdRateSiteResyncEnabled: true, usdRateAlertsEnabled: true },
    });
    if (!settings) return;
    const base = settings.usdRateSyncedRate != null ? Number(settings.usdRateSyncedRate) : previous;
    if (base == null) {
      await prisma.settings.update({ where: { id: "singleton" }, data: { usdRateSyncedRate: next } });
      return;
    }
    const pct = changePct(base, next) ?? 0;
    if (Math.abs(pct) < settings.usdRateAlertPct) return;

    const resynced = settings.usdRateSiteResyncEnabled ? await resyncUsdPropertiesOnSite("курс доллара изменился") : null;
    await prisma.settings.update({ where: { id: "singleton" }, data: { usdRateSyncedRate: next } });
    if (!settings.usdRateAlertsEnabled) return;

    const stale = await findStaleRateCaptions();
    const lines = [
      resynced === null
        ? "Цены на сайте не пересчитывались (рубильник выключен) — пересчитать можно в Настройках кнопкой."
        : `Цены на сайте: поставлено на пересчёт ${resynced} ${resynced === 1 ? "объект" : "объектов"} в долларах.`,
      stale.length > 0
        ? `Подпись в соцсетях осталась со старой ценой у ${stale.length} ${stale.length === 1 ? "объекта" : "объектов"}. Обновить? Кнопка «Обновить подписи» — в Настройках → Деньги → Курс доллара.`
        : "Подписи в соцсетях по этому курсу в порядке.",
    ];
    await alertLeadership(`Курс доллара изменился: ${rateText(base)} → ${rateText(next)} (${pctText(pct)})`, lines.join(" "), `usd-rate-shift-${next}`);
  } catch (err) {
    void logSystemError("exchange-rate", `Курс сохранён, но пересчёт после смены курса не прошёл: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Объекты в долларах, которые сейчас стоят на сайте. */
export async function usdPropertiesOnSite(): Promise<string[]> {
  const rows = await prisma.property.findMany({
    where: { currency: "USD", publishedOnSite: true, deletedAt: null, offSite: false },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Поставить на досылку на сайт все объекты в долларах (та же очередь, что у любой правки карточки). Возвращает число. */
export async function resyncUsdPropertiesOnSite(context: string): Promise<number> {
  const ids = await usdPropertiesOnSite();
  for (const id of ids) {
    await prisma.$transaction(async (tx) => {
      await enqueueSiteResyncInTransaction(tx, id, context);
    });
  }
  return ids.length;
}

export interface StaleCaption {
  id: string;
  shortId: number;
  code: string;
  channels: string[];
}

/**
 * Объекты в долларах, у которых подпись вышедшего поста несёт цену по другому курсу. Признак — по тексту: в подписи
 * есть строка цены, но нет сегодняшней «сомони ($)». Старого курса хранить не надо, и список сам пустеет после обновления.
 */
export async function findStaleRateCaptions(): Promise<StaleCaption[]> {
  const money = await loadMoneyContext();
  if (money.fallback) return [];
  const rows = await prisma.property.findMany({
    where: { currency: "USD", deletedAt: null, publishedChannels: { isEmpty: false }, reelsCaption: { not: null } },
    select: { id: true, shortId: true, price: true, currency: true, reelsCaption: true, publishedChannels: true },
    orderBy: { shortId: "asc" },
  });
  const stale: StaleCaption[] = [];
  for (const row of rows) {
    const caption = row.reelsCaption ?? "";
    const expected = buildPriceDisplay(row.price, row.currency, money);
    if (caption.includes(expected)) continue;
    if (replaceCaptionPriceLines(caption, expected).replaced === 0) continue;
    stale.push({ id: row.id, shortId: row.shortId, code: formatShortCode("ОБ", row.shortId), channels: row.publishedChannels });
  }
  return stale;
}

export interface CaptionRefreshSummary {
  /** Объектов, у которых подпись переписана и поставлена на отправку (Telegram, Facebook, YouTube). */
  queued: number;
  /** Объектов, у которых хотя бы в одном канале подпись нужно править руками (Instagram, TikTok и т.п.). */
  manual: { code: string; channels: string[] }[];
  skipped: number;
  /** Сколько ещё осталось за пределом одного нажатия. */
  remaining: number;
}

/**
 * КНОПКА «ОБНОВИТЬ ПОДПИСИ» (только руководитель, по нажатию — не по расписанию).
 * Заменяет строку цены в сохранённой подписи на сегодняшнюю и ставит правку живых постов в ту же очередь, что и правка цены
 * объекта (priceCaptionDelivery): с повторами, сверкой результата и записью в журнал. Остальной текст подписи не трогается.
 */
export async function refreshStaleRateCaptions(): Promise<CaptionRefreshSummary> {
  const stale = await findStaleRateCaptions();
  const batch = stale.slice(0, CAPTION_BATCH_LIMIT);
  const money = await loadMoneyContext();
  const summary: CaptionRefreshSummary = { queued: 0, manual: [], skipped: 0, remaining: stale.length - batch.length };
  for (const item of batch) {
    try {
      const staged = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${item.id} FOR UPDATE`;
        const before = await tx.property.findUnique({ where: { id: item.id } });
        if (!before || before.deletedAt || !before.reelsCaption) return null;
        const expected = buildPriceDisplay(before.price, before.currency, money);
        const rewritten = replaceCaptionPriceLines(before.reelsCaption, expected);
        if (rewritten.replaced === 0 || rewritten.text === before.reelsCaption) return null;
        // Версия растёт: по ней очередь отличает эту правку от прежних (priceCaptionDelivery.revisionKey).
        const after = await tx.property.update({
          where: { id: item.id },
          data: { reelsCaption: rewritten.text, version: { increment: 1 } },
        });
        return stagePriceCaptionTargets(tx, after, rewritten.text);
      });
      if (!staged) {
        summary.skipped++;
        continue;
      }
      if (staged.queued.length > 0) summary.queued++;
      if (staged.manual.length > 0) summary.manual.push({ code: item.code, channels: staged.manual });
      logSystemAudit("PROPERTY_CAPTIONS_REFRESHED", "Property", item.id, {
        shortId: item.shortId,
        reason: "курс доллара",
        queued: staged.queued,
        manual: staged.manual,
      });
    } catch (err) {
      summary.skipped++;
      void logSystemError("exchange-rate", `${item.code}: подпись под новый курс не обновилась: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

/** Сторож свежести: курс не обновлялся больше STALE_HOURS часов — одно сообщение в сутки. Возвращает true, если позвал. */
export async function checkRateFreshness(now = new Date()): Promise<boolean> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { usdToTjsRate: true, usdToTjsRateUpdatedAt: true, usdRateStaleAlertedAt: true, usdRateAlertsEnabled: true },
    });
    if (!settings || !settings.usdRateAlertsEnabled) return false;
    const updatedAt = settings.usdToTjsRateUpdatedAt;
    const ageHours = updatedAt ? (now.getTime() - updatedAt.getTime()) / 3_600_000 : Infinity;
    if (settings.usdToTjsRate != null && ageHours <= STALE_HOURS) return false;
    const hasUsd = (await prisma.property.count({ where: { currency: "USD", deletedAt: null } })) > 0;
    if (!hasUsd) return false;
    if (settings.usdRateStaleAlertedAt && now.getTime() - settings.usdRateStaleAlertedAt.getTime() < STALE_REPEAT_MS) return false;
    await prisma.settings.update({ where: { id: "singleton" }, data: { usdRateStaleAlertedAt: now } });
    const since = updatedAt
      ? `Последний раз курс обновлялся ${Math.floor(ageHours)} ч назад (${String(settings.usdToTjsRate != null ? rateText(Number(settings.usdToTjsRate)) : "—")}).`
      : "Курс ещё ни разу не обновлялся.";
    await alertLeadership(
      "Курс доллара не обновляется",
      `${since} Цены объектов в долларах на сайте и деньги считаются по старому курсу. Попробуйте «Обновить курс сейчас» в Настройках → Деньги → Курс доллара или задайте курс вручную.`,
      `usd-rate-stale-${now.toISOString().slice(0, 10)}`
    );
    return true;
  } catch (err) {
    void logSystemError("exchange-rate", `Сторож курса не отработал: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
