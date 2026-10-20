import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { dushanbeWallClock } from "../dushanbeTime.js";
import { logSystemError } from "../systemError.js";
import { Prisma } from "../../generated/prisma/client.js";
import { setAdProperties } from "./adAllocation.js";
import { buildAdMatcher } from "./adMatching.js";
import { runReconcileAfterSync } from "./adReconcile.js";
import { recentMonths, upsertAdExpenses } from "./adExpenseSync.js";
import { looksLikeBrandAd } from "./adSubject.js";
import {
  fetchAdAccountCurrency,
  fetchMetaAdById,
  fetchMetaAdDailyStats,
  fetchMetaAds,
  fetchMetaAdSets,
  isMetaAdsConfigured,
  loadMetaAdsCredentials,
  MetaAdsTokenError,
  type AdSetScope,
  type MetaAdEntity,
  type MetaAdSetsResult,
  type MetaAdsCredentials,
} from "./metaAdsApi.js";
import { parseAdSetSettings, saveAdSetSettings } from "./adSetSettings.js";

/**
 * СИНХРОНИЗАЦИЯ РАСХОДОВ НА РЕКЛАМУ.
 *
 * Идёт каждые 15 минут (cron.ts; раньше раз в час — «новая реклама сразу видна»)
 * и КАЖДЫЙ РАЗ ПЕРЕЗАЛИВАЕТ последние семь дней поверх
 * уже сохранённых. Это не расточительство: Meta правит цифры задним числом —
 * отклонённые показы, доначисления, пересчёт результатов доезжают в течение
 * нескольких суток. Разовая выгрузка «за вчера» навсегда запомнила бы промежуточные
 * числа, и отчёт расходился бы с кабинетом на глазах у владельца.
 *
 * ПОВТОР БЕЗОПАСЕН. Ключ «объявление + день» уникален, запись идёт через upsert:
 * хоть десять прогонов подряд — сумма за день не удвоится. То же и с самими
 * объявлениями (ключ «система + внешний id»).
 *
 * ОДИН ПРОГОН ЗА РАЗ (ревью 03.10.2026, п. 2). Синхронизацию зовут крон (каждые 15
 * минут), фоновое обновление при открытии раздела и кнопка в Настройках; общего
 * флага в памяти для трёх путей и двух процессов мало. Прогон берёт advisory-замок
 * Postgres (одна константа на весь прогон): не взял — прогон ПРОПУСКАЕТСЯ без ошибки,
 * его догонит соседний. Замок транзакционный (pg_try_advisory_xact_lock): снимается
 * сам при любом завершении, в том числе при падении процесса.
 *
 * ТРАНЗАКЦИЙ ВНУТРИ ПРОГОНА нет сознательно: каждая строка самодостаточна и
 * повторяема, а одна общая транзакция на несколько тысяч upsert-ов держала бы
 * соединения минутами. Транзакция снаружи держит ТОЛЬКО замок (одно соединение).
 */

/** Сколько последних дней перезаливаем при обычном прогоне. */
const REFRESH_DAYS = 7;
/** Сколько дней тянем при первом (или ручном полном) прогоне — примерно квартал. */
export const FULL_SYNC_DAYS = 90;

/** Ключ advisory-замка синхронизации рекламы (произвольная константа проекта). */
export const ADS_SYNC_LOCK_ID = 7_310_030_001;
/** Потолок жизни транзакции-держателя замка: прогон по сотням объявлений укладывается в минуты. */
const ADS_SYNC_LOCK_TX_MS = 30 * 60 * 1000;
/**
 * Сколько ждать замок, прежде чем пропустить прогон. В бою 0: соседний прогон уже
 * делает ту же работу, ждать нечего. В тестах — долго: они идут в два процесса на одной
 * базе и обязаны дождаться своей очереди, а не «пропустить» проверяемый прогон.
 */
const DEFAULT_LOCK_WAIT_MS = process.env.NODE_ENV === "test" ? 120_000 : 0;

export interface MetaAdsSyncResult {
  /** Сколько объявлений увидели в кабинете. */
  ads: number;
  /** Сколько из них привязаны к объектам (всего, включая привязанные ранее). */
  matched: number;
  /** Сколько объявлений так и остались без объекта. */
  unmatched: number;
  /** Сколько рекламируют само агентство — объекта у них нет и не будет. */
  brand: number;
  /** Сколько объявлений признаны чужими — рекламой других клиентов подрядчика. */
  foreign: number;
  /** Сколько карточек попутно получили верную ссылку на публикацию Instagram. */
  healed: number;
  /** Сколько объявлений неполные: материалов больше, чем найденных объектов. */
  incomplete: number;
  /** Сколько проблем нашла сверка (lib/ads/adReconcile.ts) после этого прогона. */
  issues: number;
  /** Сколько дневных строк расхода записано/обновлено. */
  spendRows: number;
  days: number;
  currency: "USD" | "TJS";
  /** true — прогон не выполнялся: другой прогон держал замок. Остальные числа нулевые. */
  skipped?: boolean;
}

export interface SyncMetaAdsOptions {
  /** Сколько ждать замок, мс; по умолчанию 0 (в тестах — ждём очереди). */
  lockWaitMs?: number;
}

/** YYYY-MM-DD по календарю Душанбе — им же меряет сутки вся остальная CRM. */
function isoDay(offsetDays = 0): string {
  const wall = dushanbeWallClock();
  wall.setUTCDate(wall.getUTCDate() - offsetDays);
  return wall.toISOString().slice(0, 10);
}

/** «2026-08-20» → полночь UTC. Колонка объявлена как DATE, время в ней не хранится. */
function toDateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Выполняет `fn` под advisory-замком синхронизации. Не взяли за `waitMs` — null
 * (прогон пропускается без ошибки).
 */
async function withSyncLock<T>(waitMs: number, fn: () => Promise<T>): Promise<{ value: T } | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${ADS_SYNC_LOCK_ID}::bigint) AS locked`;
        if (!rows[0]?.locked) return null;
        return { value: await fn() };
      },
      { timeout: ADS_SYNC_LOCK_TX_MS, maxWait: 15_000 }
    );
    if (got) return got;
    if (Date.now() >= deadline) return null;
    await sleep(1000);
  }
}

/**
 * Чтение настроек групп под прогоном: только для слоя обучения, поэтому НИКОГДА не роняет
 * синхронизацию расходов. Умерший маркер здесь не перебрасываем — те же вызовы рядом
 * (объявления, расход) бросят его сами и с нужным текстом для директора.
 */
async function readAdSetsSafely(
  credentials: MetaAdsCredentials,
  adAccountId: string,
  scope: AdSetScope
): Promise<MetaAdSetsResult> {
  try {
    return await fetchMetaAdSets(credentials, adAccountId, { scope });
  } catch (err) {
    if (!(err instanceof MetaAdsTokenError)) {
      void logSystemError("ads", `Настройки групп объявлений ${adAccountId} не прочитаны: ${describeError(err)}`, {
        dedupKey: `ads-adset-read:${adAccountId}`,
        dedupWindowMs: 24 * 60 * 60 * 1000,
      });
    }
    return { byId: new Map(), partial: true, skipped: "failed" };
  }
}

/**
 * Как часто перечитываем настройки ОСТАНОВЛЕННЫХ, архивных и удалённых групп. Настройки таких
 * групп сами не меняются, а читать их каждые 15 минут — это самый тяжёлый запрос синхронизации
 * (таргетинг целиком, страницы по 50), съедающий лимит Meta. Действующие группы читаются каждым
 * прогоном. Память процесса: после рестарта первый прогон читает всё один раз.
 */
const INACTIVE_ADSETS_REFRESH_MS = 24 * 60 * 60 * 1000;
const lastInactiveAdSetsRead = new Map<string, number>();

/** Сбрасывает суточный учёт чтения неактивных групп (для тестов и принудительной синхронизации). */
export function resetAdSetReadThrottle(): void {
  lastInactiveAdSetsRead.clear();
}

async function readAdSetsThrottled(credentials: MetaAdsCredentials, adAccountId: string): Promise<MetaAdSetsResult> {
  const active = await readAdSetsSafely(credentials, adAccountId, "active");
  // Лимит запросов Meta: до конца прогона больше не спрашиваем (откат и второй запрос только усилят торможение).
  if (active.skipped === "rate_limit") return active;
  const last = lastInactiveAdSetsRead.get(adAccountId);
  if (last !== undefined && Date.now() - last < INACTIVE_ADSETS_REFRESH_MS) return active;
  const inactive = await readAdSetsSafely(credentials, adAccountId, "inactive");
  if (!inactive.skipped) lastInactiveAdSetsRead.set(adAccountId, Date.now());
  const byId = new Map(active.byId);
  for (const [id, row] of inactive.byId) if (!byId.has(id)) byId.set(id, row);
  return { byId, partial: active.partial || inactive.partial };
}

function skippedResult(days: number): MetaAdsSyncResult {
  return {
    ads: 0,
    matched: 0,
    unmatched: 0,
    brand: 0,
    foreign: 0,
    healed: 0,
    incomplete: 0,
    issues: 0,
    spendRows: 0,
    days,
    currency: "USD",
    skipped: true,
  };
}

/**
 * Один прогон. Бросает только на отказе Meta — вызывающий (cron или роут) решает,
 * писать это в журнал или показать человеку. Параллельный прогон пропускается:
 * результат с `skipped: true`.
 */
export async function syncMetaAds(days = REFRESH_DAYS, options: SyncMetaAdsOptions = {}): Promise<MetaAdsSyncResult> {
  const credentials = await loadMetaAdsCredentials();
  if (!isMetaAdsConfigured(credentials)) {
    throw new Error("Рекламный кабинет не подключён: нужны маркер с правом ads_read и идентификатор кабинета");
  }
  const locked = await withSyncLock(options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, () => runSync(credentials, days));
  return locked ? locked.value : skippedResult(days);
}

/** Валюта кабинета: ответ Meta, а при отказе чтения последняя сохранённая валюта расходов этого кабинета. */
async function resolveAccountCurrency(credentials: MetaAdsCredentials, adAccountId: string): Promise<"USD" | "TJS" | null> {
  const fetched = await fetchAdAccountCurrency(credentials, adAccountId);
  if (fetched) return fetched;
  const last = await prisma.adSpendDaily.findFirst({
    where: { ad: { platform: "META", adAccountId } },
    orderBy: { date: "desc" },
    select: { currency: true },
  });
  return last?.currency ?? null;
}

async function runSync(credentials: MetaAdsCredentials, days: number): Promise<MetaAdsSyncResult> {
  const since = isoDay(Math.max(0, days - 1));
  const until = isoDay(0);

  // Матчер строится ОДИН на весь прогон, а не на кабинет: карточки и лента
  // Instagram общие, а перечитывать их на каждый кабинет — лишние походы в Graph.
  const matcher = await buildAdMatcher();

  let matched = 0;
  let unmatched = 0;
  let foreign = 0;
  let brandAds = 0;
  let incomplete = 0;
  let spendRows = 0;
  let adsSeen = 0;
  let currency: "USD" | "TJS" = "USD";

  for (const adAccountId of credentials.adAccountIds) {
    // Отказ чтения валюты не превращается в «USD»: сохранённые сомони стали бы
    // долларами (ADS-ROOT02). Нет ни ответа Meta, ни сохранённой валюты — кабинет
    // в этом тике пропускаем, следующий прогон (через 15 минут) догонит.
    const accountCurrency = await resolveAccountCurrency(credentials, adAccountId);
    if (!accountCurrency) {
      void logSystemError("ads", `Расходы кабинета ${adAccountId} не записаны: валюта не прочитана и сохранённой нет`, {
        dedupKey: `ads-currency-skip:${adAccountId}`,
        dedupWindowMs: 6 * 60 * 60 * 1000,
      });
      continue;
    }
    currency = accountCurrency;
    const [entities, stats, adSets] = await Promise.all([
      fetchMetaAds(credentials, adAccountId),
      fetchMetaAdDailyStats(credentials, adAccountId, since, until),
      readAdSetsThrottled(credentials, adAccountId),
    ]);
    adsSeen += entities.length;

    /** Внешний id объявления → его id в нашей базе, чтобы не искать заново под расходы. */
    const idByExternal = new Map<string, string>();

    for (const entity of entities) {
      const stored = await storeAdEntity(entity, { adAccountId, matcher, adSets, accountCurrency });
      idByExternal.set(entity.id, stored.rowId);
      if (stored.outcome === "foreign") foreign++;
      else if (stored.outcome === "matched") matched++;
      else if (stored.outcome === "brand") brandAds++;
      else unmatched++;
      if (stored.incomplete) incomplete++;
    }

    /**
     * Расход по объявлениям, которых нет в выдаче /ads (ревью 03.10.2026, п. 8):
     * заархивированные и удалённые. Список /ads мог их не отдать, а расход у них был —
     * раньше он отбрасывался, CRM становилась меньше кабинета Meta, и директору каждый
     * день шёл SPEND_MISMATCH. Надёжный путь не зависит от того, как Meta фильтрует
     * список: строка объявления ищется в нашей базе по внешнему id (оно уже было
     * синхронизировано, пока работало), а если её нет — заводится по ad_id из insights
     * с именами оттуда же и пометкой «ARCHIVED» (в архиве). Привязку по названию
     * пробуем тем же матчером; креатива у такой строки нет, поэтому материалов нет.
     */
    const recordSpendRows = async (): Promise<void> => {
      const missing = Array.from(new Set(stats.map((s) => s.adId))).filter((id) => !idByExternal.has(id));
      if (missing.length > 0) {
        const known = await prisma.ad.findMany({
          where: { platform: "META", externalId: { in: missing } },
          select: { id: true, externalId: true },
        });
        for (const k of known) idByExternal.set(k.externalId, k.id);
        for (const externalId of missing) {
          if (idByExternal.has(externalId)) continue;
          const sample = stats.find((s) => s.adId === externalId);
          const name = sample?.adName ?? `Объявление ${externalId} (в архиве)`;
          const found = await matcher.matchAll({
            name,
            campaignName: sample?.campaignName ?? null,
            adsetName: sample?.adsetName ?? null,
          });
          const row = await prisma.ad.upsert({
            where: { platform_externalId: { platform: "META", externalId } },
            create: {
              platform: "META",
              externalId,
              adAccountId,
              name,
              campaignName: sample?.campaignName ?? null,
              adsetName: sample?.adsetName ?? null,
              status: "ARCHIVED",
              brand: found.matches.length === 0 && looksLikeBrandAd(name),
              excluded: false,
              lastSyncedAt: new Date(),
            },
            update: {},
            select: { id: true },
          });
          idByExternal.set(externalId, row.id);
          if (found.matches.length > 0) {
            await setAdProperties(
              row.id,
              found.matches.map((m) => ({ propertyId: m.propertyId, weight: 1, source: m.source })),
              found.matches[0].source,
              { respectManual: true }
            );
          }
        }
      }

      for (const stat of stats) {
        const adId = idByExternal.get(stat.adId);
        if (!adId) continue;

        const data = {
          spend: stat.spend,
          currency: accountCurrency,
          impressions: stat.impressions,
          reach: stat.reach,
          clicks: stat.clicks,
          conversations: stat.conversations,
        };
        await prisma.adSpendDaily.upsert({
          where: { adId_date: { adId, date: toDateColumn(stat.date) } },
          create: { adId, date: toDateColumn(stat.date), ...data },
          update: data,
        });
        spendRows++;
      }
    };
    await recordSpendRows();
  }

  // updateMany, а не update: строки настроек может не быть (чистая база, тестовый
  // стенд) — отсутствие отметки о времени не повод терять уже записанные расходы.
  await prisma.settings.updateMany({ where: { id: "singleton" }, data: { metaAdsSyncedAt: new Date() } });

  // Финансы → Расходы: строка «реклама за месяц» ведётся автоматически по итогам
  // каждой сверки — бухгалтер её не вводит и не правит (lib/ads/adExpenseSync.ts).
  await upsertAdExpenses(recentMonths(days));

  // Сторож сверки: деньги не на тех объектах, потерянные по дороге, отклонённые
  // объявления — до того, как об этом спросит владелец. Не бросает (adReconcile.ts).
  const issues = await runReconcileAfterSync(credentials, { from: toDateColumn(since), to: toDateColumn(until) });

  return {
    ads: adsSeen,
    matched,
    unmatched,
    /** Реклама самого агентства — считается отдельно от незакрытой работы. */
    brand: brandAds,
    foreign,
    healed: matcher.healedCount(),
    incomplete,
    issues: issues.length,
    spendRows,
    days,
    currency,
  };
}

type AdStoreOutcome = "foreign" | "matched" | "brand" | "unmatched";

/**
 * Одно объявление из Meta → строка Ad и её связи с объектами. Общая для полного
 * прогона и для догрузки одного объявления по номеру (ensureMetaAdKnown), чтобы
 * правила привязки, «чужого» и брендового не разошлись между двумя путями.
 */
async function storeAdEntity(
  entity: MetaAdEntity,
  ctx: {
    adAccountId: string;
    matcher: Awaited<ReturnType<typeof buildAdMatcher>>;
    adSets: MetaAdSetsResult | null;
    accountCurrency: "USD" | "TJS";
  }
): Promise<{ rowId: string; outcome: AdStoreOutcome; incomplete: boolean }> {
  const { adAccountId, matcher, adSets, accountCurrency } = ctx;
  let incompleteFlag = false;
  const existing = await prisma.ad.findUnique({
    where: { platform_externalId: { platform: "META", externalId: entity.id } },
    select: {
      id: true,
      propertyId: true,
      matchSource: true,
      excluded: true,
      caption: true,
      _count: { select: { properties: true } },
    },
  });

  // Объявление прочитано по облегчённому набору полей (Meta отказала на
  // asset_feed_spec): материалов в нём может быть больше, чем мы видим. Такой
  // прогон связи только ДОБАВЛЯЕТ, ничего не удаляет и не перезаписывает
  // материалы и их число (иначе «гибкое» объявление теряло связи B, C, D).
  const partial = entity.partial === true;
  const hadLinks = !!existing && (existing._count.properties > 0 || !!existing.propertyId);

  // Привязку, сделанную человеком, синхронизация не трогает НИКОГДА — иначе
  // ночной прогон стирал бы работу маркетолога, и доверия к экрану не осталось
  // бы после первой же ночи. Окончательное решение принимает setAdProperties
  // внутри транзакции: PATCH маркетолога мог прийти, пока шёл матчинг.
  const keepManual = existing?.matchSource === "MANUAL";
  // Все объекты объявления, а не первый: «гибкое» объявление несёт несколько
  // роликов про разные квартиры (lib/ads/adMatching.ts::matchAll).
  const found = keepManual ? null : await matcher.matchAll(entity);
  const matches = found?.matches ?? [];
  const hasObject = keepManual ? !!existing?.propertyId : matches.length > 0 || (partial && hadLinks);

  /**
   * Чужая реклама в общем кабинете подрядчика. Ручной вердикт человека сильнее
   * машины в обе стороны: он мог как забрать объявление себе («это наше»), так и
   * привязать его к объекту — привязанное чужим уже не бывает.
   */
  const excluded = keepManual || hasObject ? false : existing?.excluded ?? !matcher.isOurs(entity);

  // Реклама самого агентства: объекта у неё нет и не будет. Привязанное
  // человеком брендовым уже не считается — его вердикт сильнее шаблона.
  const brand = hasObject ? false : looksLikeBrandAd(entity.caption ?? existing?.caption ?? null);

  const outcome: AdStoreOutcome = excluded ? "foreign" : hasObject ? "matched" : brand ? "brand" : "unmatched";

  const common = {
    adAccountId,
    excluded,
    name: entity.name,
    campaignId: entity.campaignId,
    campaignName: entity.campaignName,
    adsetId: entity.adsetId,
    adsetName: entity.adsetName,
    postUrl: entity.postUrl,
    postShortcode: entity.postUrl ? shortcodeOf(entity.postUrl) : null,
    mediaId: entity.mediaId,
    thumbnailUrl: entity.thumbnailUrl,
    // Текст, который отдала Meta, сохраняем только когда он есть: пустой ответ
    // не должен стирать подпись, добытую в прошлый раз другим путём.
    ...(entity.caption ? { caption: entity.caption } : {}),
    brand,
    // Материалы и их число: поле необязательно у источника (мок, старый вызов) —
    // тогда колонки не трогаем, чтобы не затереть разобранное раньше. По
    // облегчённому ответу (partial) их тоже не пишем: он неполный по построению.
    ...(entity.assets && !partial
      ? {
          creativeAssets: (found?.assets ?? entity.assets) as unknown as Prisma.InputJsonValue,
          assetCount: found?.assetCount ?? Math.max(1, entity.assets.length),
        }
      : {}),
    createdTime: entity.createdTime ? new Date(entity.createdTime) : null,
    startTime: entity.startTime ? new Date(entity.startTime) : null,
    stopTime: entity.stopTime ? new Date(entity.stopTime) : null,
    status: entity.status,
    objective: entity.objective,
    lastSyncedAt: new Date(),
  };

  const row = await prisma.ad.upsert({
    where: { platform_externalId: { platform: "META", externalId: entity.id } },
    create: { platform: "META", externalId: entity.id, ...common },
    update: common,
    select: { id: true },
  });

  // Настройки группы для будущего слоя обучения. Сбой записи не должен
  // ронять синхронизацию расходов — деньги важнее подсказок.
  const adSetRaw = entity.adsetId ? adSets?.byId.get(entity.adsetId) : undefined;
  if (adSetRaw) {
    try {
      await saveAdSetSettings(row.id, parseAdSetSettings(adSetRaw), adSets?.partial ?? true, accountCurrency);
    } catch (err) {
      void logSystemError("ads", `Настройки группы объявления ${entity.id} не сохранены: ${describeError(err)}`, {
        dedupKey: "ads-adset-save",
        dedupWindowMs: 24 * 60 * 60 * 1000,
      });
    }
  }

  // Связь с объектами пишется ТОЛЬКО через setAdProperties (Ad.propertyId и
  // AdProperty в одной транзакции) — отдельно от upsert выше сознательно.
  // Ручную привязку не трогаем никогда.
  if (!keepManual && !(partial && matches.length === 0)) {
    await setAdProperties(
      row.id,
      matches.map((m) => ({ propertyId: m.propertyId, weight: 1, source: m.source })),
      matches[0]?.source ?? "POST_URL",
      { additive: partial, respectManual: true }
    );
    if (!partial && matches.length > 0 && found && found.assetCount > matches.length) incompleteFlag = true;
  }
  return { rowId: row.id, outcome, incomplete: incompleteFlag };
}

/** Короткий код публикации из её адреса — тот же, что у бота (sharedMedia.ts). */
function shortcodeOf(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * Обёртка для крона: молча ничего не делает, пока кабинет не подключён, и сама
 * пишет отказ в журнал. Возвращает null, если синхронизация не состоялась (или её
 * пропустили: соседний прогон держит замок).
 */
export async function syncMetaAdsQuietly(days = REFRESH_DAYS): Promise<MetaAdsSyncResult | null> {
  const credentials = await loadMetaAdsCredentials();
  if (!isMetaAdsConfigured(credentials)) return null;

  try {
    const result = await syncMetaAds(days);
    return result.skipped ? null : result;
  } catch (err) {
    if (err instanceof MetaAdsTokenError) {
      void logSystemError(
        "ads",
        `Маркер рекламного кабинета больше не действует (${err.message}). Отчёт по рекламе замер: ` +
          `выпустите новый маркер с правом ads_read и вставьте его в Настройки → Интеграции.`
      );
      return null;
    }
    void logSystemError("ads", `Расходы на рекламу не синхронизированы: ${describeError(err)}`);
    return null;
  }
}

/** Номер объявления, которое уже пытались догрузить: Graph не дёргаем на каждое сообщение. */
const lazyTried = new Map<string, number>();
const LAZY_RETRY_MS = 60 * 60 * 1000;
const LAZY_TIMEOUT_MS = 8_000;

/**
 * ДОГРУЗКА НЕИЗВЕСТНОГО ОБЪЯВЛЕНИЯ ПО НОМЕРУ (03.10.2026, «почему Ноза»).
 *
 * Бону пришла с рекламы объекта №103 (агент Умед), а строки Ad с этим номером не
 * было: список /ads откатился на выборку без фильтра статусов и архивное объявление
 * не отдал. Бот не узнал объект, и заявка ушла по общей очереди к Нозе. Теперь
 * перед разбором такого сообщения объявление читается из Meta напрямую по ad_id и
 * сохраняется теми же правилами, что и в полном прогоне (storeAdEntity).
 *
 * Не бросает и не держит ход дольше LAZY_TIMEOUT_MS: без объявления бот всё равно
 * ответит, просто без объекта. true — строка Ad есть (была или появилась).
 */
export async function ensureMetaAdKnown(adId: string | undefined | null): Promise<boolean> {
  if (!adId) return false;
  const known = await prisma.ad
    .findUnique({ where: { platform_externalId: { platform: "META", externalId: adId } }, select: { id: true } })
    .catch(() => null);
  if (known) return true;
  const tried = lazyTried.get(adId);
  if (tried && Date.now() - tried < LAZY_RETRY_MS) return false;
  lazyTried.set(adId, Date.now());
  if (lazyTried.size > 2000) lazyTried.delete(lazyTried.keys().next().value!);

  const work = async (): Promise<boolean> => {
    const credentials = await loadMetaAdsCredentials();
    if (!isMetaAdsConfigured(credentials)) return false;
    const fetched = await fetchMetaAdById(credentials, adId);
    if (!fetched) return false;
    const adAccountId = fetched.adAccountId ?? credentials.adAccountIds[0];
    if (!adAccountId) return false;
    // Догрузка не пишет расходов, а adSets здесь null: валюта в storeAdEntity не используется,
    // поэтому запасной USD при отказе чтения ничего не портит.
    const accountCurrency = (await fetchAdAccountCurrency(credentials, adAccountId).catch(() => null)) ?? "USD";
    const matcher = await buildAdMatcher();
    const stored = await storeAdEntity(fetched.entity, { adAccountId, matcher, adSets: null, accountCurrency });
    console.log(`[реклама] объявление ${adId} догружено по номеру: ${stored.outcome}`);
    return true;
  };
  try {
    return await Promise.race([
      work(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), LAZY_TIMEOUT_MS).unref?.()),
    ]);
  } catch (err) {
    void logSystemError("ads", `Объявление ${adId}, с которого пришёл клиент, не догружено из Meta: ${describeError(err)}`, {
      dedupKey: "ads-lazy-fetch",
      dedupWindowMs: 6 * 60 * 60 * 1000,
    });
    return false;
  }
}

/** Только для тестов. */
export function resetLazyAdFetch(): void {
  lazyTried.clear();
}
