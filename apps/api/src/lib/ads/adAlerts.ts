import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { enqueueDirectorAlert } from "../directorAlertQueue.js";
import { dushanbeWallClock } from "../dushanbeTime.js";
import { loadMoneyContext, roundMoney, toTjs } from "../money.js";
import { shouldAlert } from "../notifications.js";
import { REJECTED_AD_STATUSES } from "./adReconcile.js";
import {
  fetchAdAccountDetails,
  isMetaAdsConfigured,
  loadMetaAdsCredentials,
  type AdAccountDetails,
  type MetaAdsCredentials,
} from "./metaAdsApi.js";

/**
 * ИИ-ПОДСКАЗКИ ПУШЕМ: реклама сама говорит, когда что-то пошло не так.
 *
 * Владелец не обязан открывать раздел, чтобы узнать о проблеме, — критичные
 * сигналы приходят пушем (и в ленту уведомлений, sendPushToAgents пишет туда
 * сам). Сигнала два, оба считаются из наших же дневных строк, без похода в Meta:
 *
 *  1. ЦЕНА ОБРАЩЕНИЯ ВЫРОСЛА ВДВОЕ: последние 7 дней против предыдущих 7.
 *     Так выглядит выгоревший креатив или сломанная аудитория.
 *  2. ДЕНЬГИ БЕЗ ОТДАЧИ: объявление потратило заметную сумму за неделю и не
 *     принесло ни одного обращения.
 *
 * Порог «раз в сутки на сигнал» — жёсткий: алерт, который приходит каждый час,
 * отключают через день, и дальше он не защищает ничего.
 */

/** Не беспокоим из-за мелочи: сигналы только когда за неделю потрачено больше. */
const MIN_WEEK_SPEND_USD = 10;
/** «Без отдачи» — потратил за неделю больше этого и ноль обращений. */
const WASTED_SPEND_USD = 15;

let lastAlertDay: string | null = null;

/**
 * Расход в долларах: AdSpendDaily.spend хранится в валюте кабинета (USD или TJS), а пороги
 * и тексты сигналов долларовые. Сумма сомони, принятая за доллары, давала ложное «потратили
 * от $15» на 20 сомони, а сложение разных валют (несколько кабинетов) искажало цену
 * обращения (аудит 04.10.2026, CHANNEL-NEW-17). Сомони делим на курс CRM, остальное как есть.
 */
function spendInUsd(spend: unknown, currency: string, usdToTjs: number): number {
  const n = Number(spend ?? 0);
  return currency === "TJS" ? n / usdToTjs : n;
}

/** Суточная проверка сигналов. Возвращает число отправленных алертов. */
export async function checkAdAlerts(): Promise<number> {
  // Сутки дедупа — ПО ДУШАНБЕ, а не по UTC: с UTC-датой они катились в 05:00
  // местного времени, и около этого часа возможен был второй пакет алертов за
  // один душанбинский день (или пропуск). Границы суток в этом проекте только
  // через lib/dushanbeTime.ts (CLAUDE.md).
  const today = dushanbeWallClock().toISOString().slice(0, 10);
  if (lastAlertDay === today) return 0;

  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week1From = new Date(now - 7 * day);
    const week2From = new Date(now - 14 * day);

    const money = await loadMoneyContext();
    const sumWeek = (rows: { currency: string; _sum: { spend: unknown; conversations: number | null } }[]) => ({
      spend: rows.reduce((acc, r) => acc + spendInUsd(r._sum.spend, r.currency, money.usdToTjs), 0),
      conversations: rows.reduce((acc, r) => acc + (r._sum.conversations ?? 0), 0),
    });
    const [thisWeekRows, prevWeekRows] = await Promise.all([
      prisma.adSpendDaily.groupBy({
        by: ["currency"],
        where: { date: { gte: week1From }, ad: { excluded: false } },
        _sum: { spend: true, conversations: true },
      }),
      prisma.adSpendDaily.groupBy({
        by: ["currency"],
        where: { date: { gte: week2From, lt: week1From }, ad: { excluded: false } },
        _sum: { spend: true, conversations: true },
      }),
    ]);

    const alerts: { title: string; body: string }[] = [];

    const { spend: spendNow, conversations: convNow } = sumWeek(thisWeekRows);
    const { spend: spendPrev, conversations: convPrev } = sumWeek(prevWeekRows);

    if (spendNow >= MIN_WEEK_SPEND_USD && convNow > 0 && convPrev > 0 && spendPrev > 0) {
      const costNow = spendNow / convNow;
      const costPrev = spendPrev / convPrev;
      if (costNow >= costPrev * 2) {
        alerts.push({
          title: "Обращения из рекламы подорожали вдвое",
          body:
            `Неделя к неделе: было ~$${costPrev.toFixed(2)} за обращение, стало ~$${costNow.toFixed(2)}. ` +
            `Так выглядит выгоревший креатив или сломанная аудитория — загляните в «Рекламу», раздел «Разбор ИИ».`,
        });
      }
    }

    // Объявления, потратившие за неделю заметно и без единого обращения.
    const wasted = await prisma.adSpendDaily.groupBy({
      by: ["adId", "currency"],
      where: { date: { gte: week1From }, ad: { excluded: false } },
      _sum: { spend: true, conversations: true },
    });
    // У одного объявления строки могут быть в двух валютах (кабинет сменил валюту): сводим в доллары.
    const perAd = new Map<string, { spendUsd: number; conversations: number }>();
    for (const w of wasted) {
      const acc = perAd.get(w.adId) ?? { spendUsd: 0, conversations: 0 };
      acc.spendUsd += spendInUsd(w._sum.spend, w.currency, money.usdToTjs);
      acc.conversations += w._sum.conversations ?? 0;
      perAd.set(w.adId, acc);
    }
    const wastedIds = [...perAd]
      .filter(([, a]) => a.spendUsd >= WASTED_SPEND_USD && a.conversations === 0)
      .map(([adId]) => adId);
    if (wastedIds.length > 0) {
      const ads = await prisma.ad.findMany({
        where: { id: { in: wastedIds.slice(0, 3) } },
        select: {
          name: true,
          campaignName: true,
          property: { select: { shortId: true } },
          // «Гибкое» объявление платит за несколько объектов — называем их все.
          properties: { select: { property: { select: { shortId: true } } } },
        },
      });
      const names = ads
        .map((a) => {
          const shortIds = a.properties.map((p) => p.property.shortId);
          if (shortIds.length === 0 && a.property) shortIds.push(a.property.shortId);
          return shortIds.length > 0 ? shortIds.map((id) => `№${id}`).join("+") : a.campaignName ?? a.name;
        })
        .join(", ");
      alerts.push({
        title: "Реклама тратит без отдачи",
        body:
          `За неделю ${wastedIds.length} объявл. потратили от $${WASTED_SPEND_USD} и не принесли ни одного обращения` +
          (names ? ` (${names})` : "") +
          ". Возможно, стоит их выключить — подробности в «Рекламе».",
      });
    }

    if (alerts.length === 0) return 0;

    // Часы алармов (владелец 07.09.2026): раньше этот тик уходил ночью
    // (крон "token-and-finance-daily", 01:20 по Душанбе) — ставим в очередь,
    // доставит flushDirectorAlertQueue утром.
    for (const alert of alerts) {
      await enqueueDirectorAlert({
        title: alert.title,
        body: alert.body,
        url: "/ads",
        tag: "ads-alert",
        recipientRoles: ["DIRECTOR", "MARKETING", "ADMIN"],
      });
    }
    lastAlertDay = today;
    return alerts.length;
  } catch (err) {
    void logSystemError("ads", `Проверка сигналов рекламы не прошла: ${describeError(err)}`);
    return 0;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * ТРЕВОГИ ДИРЕКТОРУ, ВОЛНА 1 «РЕКЛАМА» (03.10.2026)
 *
 * Три сигнала поверх двух выше: объявление отклонено Meta, платёж не прошёл или
 * долг растёт, деньги кончились. Поведение двух старых проверок не менялось.
 *
 * ДЕДУПЛИКАЦИЯ — В БАЗЕ, А НЕ В ПАМЯТИ ПРОЦЕССА. `lastAlertDay` выше живёт в
 * переменной модуля и теряется при каждом рестарте API (а выкат на сайт — это
 * рестарт): после выката директору приходил второй пакет тех же сигналов. Здесь
 * используется общий предохранитель проекта `shouldAlert(tag, окно)` — он смотрит
 * на последнюю запись очереди алармов и ленты уведомлений с этим tag, то есть
 * переживает и рестарт, и несколько экземпляров API. Тот же приём, что у алармов
 * просрочек в propertyPipeline.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** «Объявление отклонено» — один раз на объявление. */
const DISAPPROVED_WINDOW_MS = 30 * DAY_MS;
/** Ключ дедупликации «отклонено»: `ads-disapproved:<id объявления>`. */
const DISAPPROVED_TAG_PREFIX = "ads-disapproved:";
/** «Деньги кончились / платёж не прошёл» — раз в сутки, пока причина стоит: она останавливает ВСЮ рекламу. */
const ACCOUNT_STOPPED_WINDOW_MS = 20 * HOUR_MS;
/** Долг: на той же ступени — не чаще раза в неделю; новая ступень (рост) — сразу, у неё другой tag. */
const DEBT_WINDOW_MS = 7 * DAY_MS;

/** Свежесть отклонённого объявления: создано за этот срок или тратило за последние 14 дней — старые хвосты не будят. */
const DISAPPROVED_FRESH_MS = 30 * DAY_MS;
const DISAPPROVED_SPEND_DAYS = 14;
/** За один проход — не больше стольких уведомлений об отклонённых: на первом запуске их могут быть десятки. */
const MAX_DISAPPROVED_PER_RUN = 10;

/**
 * Порог долга кабинета, сомони (~100 долларов по курсу CRM). Meta копит долг до
 * порога списания и обнуляет его картой — маленький долг это норма, будить из-за него
 * нельзя. Уведомление приходит на пороге (первое превышение) и дальше ТОЛЬКО на каждом
 * удвоении долга (см. debtStep): T, 2T, 4T… — в обычном цикле списания долг не растёт
 * вдвое за неделю, поэтому 2–3 пуша за один цикл не должны получаться; на одной и той
 * же ступени дедуп не пускает повтор неделю (DEBT_WINDOW_MS).
 *
 * ⚠️ НАСТРОИТЬ ПОСЛЕ ПЕРВОГО РЕАЛЬНОГО ОТВЕТА КАБИНЕТА. 1000 с. — оценка по порядку
 * величин (порог списания Meta неизвестен заранее, он растёт с историей кабинета), на
 * живом `balance` не проверялась. В Настройки порог сознательно не выносится.
 */
export const DEBT_ALERT_TJS = 1000;

/** account_status Meta (reference/ad-account): что какое значение значит для денег. */
const ACCOUNT_STATUS_ACTIVE = 1;
const ACCOUNT_STATUS_TEXT: Record<number, { title: string; why: string }> = {
  2: { title: "Рекламный кабинет отключён", why: "Meta отключила кабинет — реклама не идёт" },
  3: { title: "Не прошёл платёж за рекламу", why: "Meta не смогла списать деньги по карте — реклама остановлена до оплаты" },
  7: { title: "Рекламный кабинет на проверке рисков", why: "Meta проверяет кабинет — показы могут быть остановлены" },
  8: { title: "Рекламный кабинет ждёт расчёта", why: "Meta проводит расчёт по кабинету — реклама может не идти" },
  9: { title: "Платёж за рекламу не прошёл, идёт льготный период", why: "Meta даёт время оплатить, иначе кабинет остановится" },
  100: { title: "Рекламный кабинет закрывается", why: "кабинет в статусе «ожидает закрытия»" },
  101: { title: "Рекламный кабинет закрыт", why: "кабинет закрыт — реклама не идёт" },
};

const fmtMoney = (n: number): string => `${new Intl.NumberFormat("ru-RU").format(Math.round(n))} с.`;

/** Одна тревога по кабинету: ключ устойчивой дедупликации, окно и текст. */
export interface AccountAlert {
  /** Хвост tag: полный — `ads-account:<кабинет>:<key>`. */
  key: string;
  title: string;
  body: string;
  windowMs: number;
}

/**
 * Ступень долга: null — ниже порога; иначе номер удвоения (0 на пороге, 1 на двойном,
 * 2 на четверном…). Это и есть «растущий долг» без хранения истории: новая ступень —
 * новый tag — новое уведомление, а на старой ступени дедуп не пускает повтор.
 */
export function debtStep(debtTjs: number | null, thresholdTjs: number = DEBT_ALERT_TJS): number | null {
  if (debtTjs == null || !Number.isFinite(debtTjs) || thresholdTjs <= 0 || debtTjs < thresholdTjs) return null;
  return Math.floor(Math.log2(debtTjs / thresholdTjs));
}

/**
 * ЧИСТАЯ ЛОГИКА порогов по одному кабинету (без базы и без Meta — тестируется на
 * фикстурах). Возвращает 0–3 тревоги: кабинет не активен, достигнут лимит расхода,
 * долг дорос до новой ступени. «Не активен» и «платёж не прошёл» — одна тревога с
 * текстом по коду статуса, а не две: это один и тот же повод.
 *
 * @param debtTjs долг кабинета (balance) в сомони по курсу CRM; null — не прочитан.
 */
export function evaluateAccountAlerts(d: AdAccountDetails, debtTjs: number | null): AccountAlert[] {
  const out: AccountAlert[] = [];
  const label = d.name ? `«${d.name}»` : d.id;

  const status = d.accountStatus ?? null;
  if (status != null && status !== ACCOUNT_STATUS_ACTIVE) {
    const known = ACCOUNT_STATUS_TEXT[status];
    out.push({
      key: `status:${status}`,
      title: known?.title ?? "Рекламный кабинет не активен",
      body:
        `Кабинет ${label}: ${known?.why ?? `статус Meta ${status} вместо «активен»`}` +
        (status === 2 && d.disableReason ? ` (код причины ${d.disableReason})` : "") +
        ". Загляните в «Рекламу» и в кабинет Meta, пока не потеряны показы.",
      windowMs: ACCOUNT_STOPPED_WINDOW_MS,
    });
  }

  if (d.spendCap != null && d.spendCap > 0 && d.amountSpent != null && d.amountSpent >= d.spendCap) {
    out.push({
      key: "cap",
      title: "Достигнут лимит расхода рекламного кабинета",
      body:
        `Кабинет ${label}: потрачено ${d.amountSpent.toFixed(2)} ${d.currency} при лимите ${d.spendCap.toFixed(2)} ${d.currency} — ` +
        `Meta не будет показывать рекламу, пока лимит не поднят.`,
      windowMs: ACCOUNT_STOPPED_WINDOW_MS,
    });
  }

  const step = debtStep(debtTjs);
  if (step != null && debtTjs != null) {
    out.push({
      key: `debt:${step}`,
      title: step === 0 ? "Долг по рекламному кабинету" : "Долг по рекламному кабинету растёт",
      body:
        `Кабинет ${label}: к оплате ${fmtMoney(debtTjs)} (${(d.balance ?? 0).toFixed(2)} ${d.currency})` +
        (d.fundingSource ? `, платёж идёт с ${d.fundingSource}` : "") +
        ". Проверьте, что карта в порядке, иначе реклама встанет.",
      windowMs: DEBT_WINDOW_MS,
    });
  }
  return out;
}

/** Как называет объявление текст тревоги: объекты (№107+№55) → кампания → имя. */
function adLabel(a: {
  name: string;
  campaignName: string | null;
  property: { shortId: number } | null;
  properties: { property: { shortId: number } }[];
}): string {
  const shortIds = a.properties.map((p) => p.property.shortId);
  if (shortIds.length === 0 && a.property) shortIds.push(a.property.shortId);
  return shortIds.length > 0 ? shortIds.map((id) => `№${id}`).join("+") : a.campaignName ?? a.name;
}

const REJECTED_TEXT: Record<string, string> = {
  DISAPPROVED: "отклонено модерацией",
  WITH_ISSUES: "есть проблемы с показом",
  ADSET_DISAPPROVED: "отклонена группа объявлений",
  CAMPAIGN_DISAPPROVED: "отклонена кампания",
};

/** Текст уведомления об одном отклонённом объявлении. Чистая функция — для теста. */
export function disapprovedAlertText(label: string, status: string): { title: string; body: string } {
  return {
    title: "Объявление отклонено Meta",
    body:
      `Объявление ${label}: ${REJECTED_TEXT[status] ?? status}. Реклама по нему не идёт — ` +
      `откройте «Рекламу», поправьте или перезапустите объявление.`,
  };
}

/**
 * ТРЕВОГА (а): объявление отклонено Meta. Статус берётся из уже сохранённого Ad.status
 * (синхронизация раз в 15 минут), в Meta не ходим. ОДНО уведомление на объявление:
 * tag `ads-disapproved:<id>`, окно 30 суток через shouldAlert (переживает рестарт).
 * Старые хвосты (отклонено давно и не тратит) не поднимаем — иначе на первом запуске
 * директору прилетела бы вся история кабинета; сводка по ним уже ложится в журнал
 * ошибок сторожем сверки (adReconcile.ts, AD_REJECTED, без пуша).
 */
export async function checkAdDisapprovedAlerts(now: Date = new Date()): Promise<number> {
  const freshFrom = new Date(now.getTime() - DISAPPROVED_FRESH_MS);
  const spendFrom = new Date(now.getTime() - DISAPPROVED_SPEND_DAYS * DAY_MS);

  // Уже отправленные исключаем В САМОМ ЗАПРОСЕ (по тому же tag, что и дедуп shouldAlert):
  // иначе `take` отдавал первые по createdTime, отправленные оставались в выборке все 30
  // дней окна и вытесняли новые отклонённые — их уведомление не доходило никогда.
  const sentSince = new Date(now.getTime() - DISAPPROVED_WINDOW_MS);
  const [queued, notified] = await Promise.all([
    prisma.pendingDirectorAlert.findMany({
      where: { tag: { startsWith: DISAPPROVED_TAG_PREFIX }, createdAt: { gte: sentSince } },
      select: { tag: true },
      take: 5000,
    }),
    prisma.notification.findMany({
      where: { tag: { startsWith: DISAPPROVED_TAG_PREFIX }, createdAt: { gte: sentSince } },
      select: { tag: true },
      take: 5000,
    }),
  ]);
  const alreadySentIds = Array.from(
    new Set([...queued, ...notified].flatMap((r) => (r.tag ? [r.tag.slice(DISAPPROVED_TAG_PREFIX.length)] : [])))
  );

  const rejected = await prisma.ad.findMany({
    where: {
      excluded: false,
      ...(alreadySentIds.length > 0 ? { id: { notIn: alreadySentIds } } : {}),
      status: { in: Array.from(REJECTED_AD_STATUSES) },
      OR: [{ createdTime: { gte: freshFrom } }, { spend: { some: { date: { gte: spendFrom }, spend: { gt: 0 } } } }],
    },
    select: {
      id: true,
      name: true,
      campaignName: true,
      status: true,
      property: { select: { shortId: true } },
      properties: { select: { property: { select: { shortId: true } } } },
    },
    orderBy: [{ createdTime: "desc" }, { id: "asc" }],
    take: MAX_DISAPPROVED_PER_RUN * 3,
  });

  let sent = 0;
  for (const ad of rejected) {
    if (sent >= MAX_DISAPPROVED_PER_RUN) break;
    const tag = `${DISAPPROVED_TAG_PREFIX}${ad.id}`;
    if (!(await shouldAlert(tag, DISAPPROVED_WINDOW_MS, now))) continue;
    const text = disapprovedAlertText(adLabel(ad), ad.status ?? "DISAPPROVED");
    await enqueueDirectorAlert({
      ...text,
      url: "/ads",
      tag,
      recipientRoles: ["DIRECTOR", "MARKETING", "ADMIN"],
    });
    sent++;
  }
  return sent;
}

/** Откуда брать реквизиты кабинетов — подменяется в тестах, чтобы не ходить в Meta. */
export interface AccountAlertDeps {
  credentials?: () => Promise<MetaAdsCredentials>;
  details?: (c: MetaAdsCredentials, accountId: string) => Promise<AdAccountDetails | null>;
}

/**
 * ТРЕВОГИ (б) и (в): долг кабинета, не прошедший платёж, лимит расхода, неактивный
 * кабинет. Данные — один запрос реквизитов на кабинет (fetchAdAccountDetails, у
 * вызова свой таймаут, «не читается» = null). Кабинет не ответил — молчим про него:
 * ложное «деньги кончились» хуже пропуска, а недоступность Meta и так попадает в
 * журнал ошибок синхронизацией.
 */
export async function checkAdAccountAlerts(now: Date = new Date(), deps: AccountAlertDeps = {}): Promise<number> {
  const credentials = await (deps.credentials ?? loadMetaAdsCredentials)();
  if (!isMetaAdsConfigured(credentials)) return 0;
  const load = deps.details ?? fetchAdAccountDetails;
  const moneyCtx = await loadMoneyContext();

  let sent = 0;
  for (const accountId of credentials.adAccountIds) {
    const details = await load(credentials, accountId);
    if (!details) continue;
    const debtTjs = details.balance != null ? roundMoney(toTjs(details.balance, details.currency, moneyCtx)) : null;
    for (const alert of evaluateAccountAlerts(details, debtTjs)) {
      const tag = `ads-account:${accountId}:${alert.key}`;
      if (!(await shouldAlert(tag, alert.windowMs, now))) continue;
      await enqueueDirectorAlert({
        title: alert.title,
        body: alert.body,
        url: "/ads",
        tag,
        recipientRoles: ["DIRECTOR", "MARKETING", "ADMIN"],
      });
      sent++;
    }
  }
  return sent;
}
