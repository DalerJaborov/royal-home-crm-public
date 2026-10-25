import { visibleErrorLogs } from "./systemErrorVisibility.js";
import { visibleSystemErrorWhere } from "./investigationOperations.js";
import { ALL_SCREENS, type AdsDigestSummary } from "@royal-home/shared";
import { prisma } from "../db.js";
import { dushanbeStartOfToday, dushanbeStartOfMonth } from "./dushanbeTime.js";
import { loadMoneyContext, roundMoney, toTjs } from "./money.js";
import { TASK_WHERE } from "./tasks.js";
import { classifyErrorLog } from "./errorLogClassify.js";
import { countDealReviewsAnswered } from "./dealReviews.js";
import { AWAITING_REVIEW_WHERE } from "./telephony/awaitingReview.js";
import { countBotPausedNoReply24h } from "./botPauseWatch.js";
import { countMissedCallsNoCallbackYesterday } from "./telephony/missedCallEscalation.js";
import { countStuckWorkGivenUpSince, countStuckWorkHangingNow } from "./stuckWork.js";
import { countPropertiesWithNoGroupShare } from "./facebookGroupShare.js";
import { loadAdsYesterdaySummary } from "./ads/adsDigest.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * Числа утреннего среза: сколько задач у команды сегодня, что было вчера,
 * сколько комиссии набежало за месяц.
 *
 * Их считают два места — push-сводка директору в 08:00 (cron.ts) и утренний
 * отчёт, который приезжает в начало рабочей сессии (routes/morningReport.ts).
 * Раньше это были две копии одного запроса, и сегодняшние правки — исключить
 * задачи клиентов из корзины и сузить окно ошибок до суток — пришлось вносить
 * дважды. Один пропущенный экземпляр означал бы, что два отчёта про одно и то
 * же утро показывают разные цифры.
 *
 * Границы суток и месяца — по Душанбе (UTC+5), а не по часовому поясу
 * процесса: контейнер живёт в UTC, и начало дня там наступает в 05:00 по
 * Душанбе, из-за чего ночные заявки попадали не в те сутки.
 */
export interface MorningNumbers {
  /** Задачи с наступающим сроком сегодня, невыполненные. */
  tasksToday: number;
  /** Новые клиенты за вчерашний день (по Душанбе). */
  leadsYesterday: number;
  /** Закрытые сделки за вчерашний день. */
  dealsYesterday: number;
  /** Комиссия за текущий месяц в сомони: долларовые сделки конвертируются. */
  commissionMonth: number;
  /**
   * Неразобранные ошибки за вчерашний день, ТРЕБУЮЩИЕ действия человека.
   *
   * Эксплуатационный шум ИИ-конвейера (резерв ответил, повтор помог/не помог —
   * см. lib/errorLogClassify.ts) сюда не входит: аудит 03.09.2026 (раздел 4-5)
   * нашёл, что именно такие строки составляли больше трети «поймано N ошибок» в
   * push-сводке директору, хотя ни одна не ждала от него решения — CRM сама уже
   * сделала всё, что могла (ответила резервной моделью, поставила повтор в
   * фоновую очередь).
   */
  errorsYesterday: number;
  /**
   * ВХОДЯЩИЕ ЗВОНКИ ЗА ВЧЕРА и сколько из них потеряли.
   *
   * До этого про телефон в утренней сводке не было ни слова: директор в 08:00 узнавал
   * про новых клиентов, сделки и ошибки — но не про то, что вчера до агентства не
   * дозвонились одиннадцать человек. Потерянное обращение стоит дороже любой другой
   * цифры в этом списке, и узнавать о нём, случайно открыв вкладку, поздно.
   */
  incomingYesterday: number;
  missedYesterday: number;
  /** Состоявшиеся разговоры, которые так и не разобрал оператор (на сейчас, за месяц). */
  unqualifiedNow: number;
  /**
   * СКОРОСТЬ ПЕРВОГО КАСАНИЯ ЗА ВЧЕРА (совет экспертов 26.08, пункт 7).
   *
   * Конверсия лида падает в разы после первых пятнадцати минут, а
   * Instagram-реклама приводит людей вечером, когда агенты заняты. firstContactAt
   * автофиксируется давно — но никуда не агрегировался и ни на что не влиял.
   * Медиана, а не среднее: один лид, до которого дошли через сутки, сдвинул бы
   * среднее так, что цифра перестала бы значить что-либо.
   *
   * null — вчера не было ни одного лида с состоявшимся первым касанием
   * (выходной, тишина): в письме такая строка не печатается вовсе.
   */
  firstTouchMedianMin: number | null;
  /** Сколько вчерашних лидов ждали первого касания дольше часа. */
  firstTouchSlowCount: number;
  /** Сколько вчерашних лидов вообще не дождались первого касания. */
  firstTouchNoneCount: number;
  /**
   * КАРТА ОБСЛЕДОВАННОГО: экраны, куда за всё время наблюдения не зашёл никто.
   *
   * Владелец 08.09.2026: «есть места, куда мы ещё не доходили в коде и на
   * экране» — там баги не просто есть, их никто никогда не видел, и пожаловаться
   * на них некому. Счётчик (lib/routeHits.ts) отмечает посещения, а разность с
   * полным списком экранов (ALL_SCREENS) и есть ответ.
   *
   * Строка живёт ИМЕННО в утреннем отчёте, а не на отдельном экране: инструмент,
   * ради которого надо не забыть куда-то зайти, не работает. Этот отчёт владелец
   * читает каждое утро и так.
   *
   * Пустой массив, пока наблюдение идёт меньше недели: в первые дни «не заходили»
   * будет написано почти про всё, и настоящая находка утонет в шуме.
   */
  unvisitedScreens: string[];
  /**
   * ПРОДАВЦЫ БЕЗ ОБЪЕКТА СТАРШЕ 7 ДНЕЙ (docs/flow-audit-property-11-09.md, Пачка 9
   * #6). На 11.09.2026 разведка нашла 57 из 72 активных продавцов в таком
   * состоянии — цифра, которую раньше не видел никто, потому что единственный
   * механизм контроля (`runSellerNoPropertyAlarmTick`, lib/sellerNoPropertyAlarm.ts)
   * считает срок ОТ ДАТЫ ВСТРЕЧИ (Interaction SELLER_MEETING) и алармит только
   * ДИРЕКТОРУ лично по одному клиенту за раз, с лесенкой проверок (агент мог
   * объясниться перед ИИ) — у карточки без единой зафиксированной встречи этот
   * счётчик вообще не стартует, и «висит без встречи» не то же самое, что «висит
   * без объекта». Здесь — грубая ежедневная цифра по ВОЗРАСТУ КАРТОЧКИ (createdAt),
   * без ИИ-лесенки, ровно как считал разведчик 11.09: honest count, не замена
   * алармa, а отдельный градусник для директора.
   */
  sellersWithoutPropertyOver7Days: number;
  /**
   * «Итог показа» не заполнен больше 48 часов — прямо сейчас (пачка 10,
   * 11.09.2026, п.3, flow-audit-lead-to-showing-11-09.md, ТОП-10 п.4). Живой
   * счёт, а не «сколько уведомили за сутки»: висящий долг важнее того, сколько
   * раз про него уже написали.
   */
  showingSummariesOverdue48h: number;
  /**
   * «БОТ НА ПАУЗЕ И ЗАБЫЛИ» (Пачка 17, 12.09.2026, lib/botPauseWatch.ts). Сколько
   * диалогов на паузе бота прямо сейчас ждут ответа ЖИВОГО ЧЕЛОВЕКА дольше 24
   * часов — фиксированный ежедневный градусник, тот же приём, что у
   * sellersWithoutPropertyOver7Days: не замена самой тревоге (та шлёт пуш агенту
   * и снимает паузу сама через botPauseEscalateHours), а честная цифра для
   * директора независимо от настроенных порогов.
   */
  botPausedNoReply24h: number;
  /**
   * «ПРОДАНО МИМО АГЕНТСТВА» ЗА НЕДЕЛЮ (пачка 13, 11.09.2026, п.1).
   *
   * Заявки на удаление объекта с причиной SOLD_ELSEWHERE, одобренные за
   * последние 7 дней. Каждая уже эскалирована в СБ поодиночке
   * (lib/sellerRefusalReview.ts) в момент одобрения — здесь только счётчик,
   * чтобы директор видел динамику, а не только разовые тревоги по одной.
   */
  soldElsewhereWeek: number;
  /**
   * «ПЕРЕДУМАЛ ПРОДАВАТЬ» ЗА НЕДЕЛЮ (пачка 13, п.2) — заявки на удаление
   * КАРТОЧКИ продавца с причиной CHANGED_MIND, одобренные за последние 7 дней.
   * Отдельно от emptySellerCardsWeek (NO_OBJECT, «пустышка»): второе значит
   * «продавать было нечего с самого начала», первое — человек передумал
   * после обращения. Смешивать их значило бы стереть разницу, ради которой
   * причины и разводили.
   */
  changedMindWeek: number;
  /** «Пустышка» (NO_OBJECT) за неделю — см. changedMindWeek. */
  emptySellerCardsWeek: number;
  /**
   * Реактивация старых клиентов пачкой (Пачка 12, 11.09.2026) — за последние 7
   * суток: сколько реактивационных сообщений отправлено (Interaction
   * `[reactivation]`, см. jobs/clientReactivation.ts) и сколько из ЭТИХ
   * клиентов после того уже возвращались сами (Client.returnedAt позже
   * отправки — тот же признак «клиент вернулся», что показывает значок в
   * списке клиентов). Окно ответа не закрывается неделей отправки: клиент мог
   * ответить позже, но метрика утра НАМЕРЕННО грубая (то же решение, что у
   * sellersWithoutPropertyOver7Days выше) — точный разбор по неделям, если
   * понадобится, будет отдельным экраном, не тут.
   */
  reactivationSentThisWeek: number;
  reactivationRepliedThisWeek: number;
  /**
   * ОТВЕТЫ НА ВОПРОС ОБ ОТЗЫВЕ ЗА ВЧЕРА (Пачка 11, 11.09.2026).
   * Считает ответы, а не заданные вопросы — «спросили» неинтересно директору,
   * важно, сколько клиентов реально ответили.
   */
  reviewsYesterday: number;
  /**
   * ПРОПУЩЕННЫЕ ЗВОНКИ БЕЗ ПЕРЕЗВОНА ЗА ВЧЕРА (Пачка 18, 12.09.2026) — на сейчас,
   * той же логикой, что unqualifiedNow: закрытый сегодня утром вчерашний разрыв
   * уже не разрыв. См. lib/telephony/missedCallEscalation.ts, тот же крон каждые
   * 30 минут уже напоминает/эскалирует по каждому такому звонку отдельно — здесь
   * только общий счёт для директора.
   */
  missedCallsNoCallbackYesterday: number;
  /**
   * ПОСТЫ БЕЗ ПРИВЯЗАННОЙ КАРТОЧКИ ОБЪЕКТА, ЗА СУТКИ (П-13, 18.09.2026,
   * `docs/audit/recon-17-09/06-chats-misrouting-30d.md` §5.2). Комментаторы под
   * такими Reels не получают привязку к объекту через
   * `lib/instagramPostLead.ts` — лид-магнит не узнаёт публикацию ни по ссылке,
   * ни по идентификатору (см. `messengers/comments.ts` — «за два часа набралось
   * N комментариев, а лид-магнит её не узнаёт»). Список ссылок за сутки, чтобы
   * их можно было привязать к объекту вручную (`POST /ads/link-post`) — на
   * будущее, без переписывания уже пришедших комментариев задним числом.
   */
  unlinkedAdPosts: { url: string; count: number }[];
  /**
   * ОБЪЕКТ СНЯТ ИЗ-ЗА «ПОТЕРЯННОГО» ПРОДАВЦА, А ПРОДАВЕЦ УЖЕ НЕ «ПОТЕРЯННЫЙ»
   * (найдено 18.09.2026 на объекте #82). `lib/propertyAutoStatus.ts` снимает
   * объект с продажи автоматически, когда его продавца помечают «Потерянным» —
   * но обратно статус не поднимает НИКОГДА, даже если карточку продавца потом
   * поправили (вручную, или как здесь — чинили баг владения, из-за которого
   * человек попал в «Потерянные» ошибочно). Карточка продавца выздоравливает,
   * объект остаётся висеть снятым, и заметить это можно только открыв карточку
   * объекта глазами. Счётчик — тот же приём, что у sellersWithoutPropertyOver7Days:
   * не чинит сам (возврат в продажу — решение человека), только не даёт разъезду
   * пропасть незамеченным.
   */
  propertiesWithdrawnSellerRecovered: number;
  /**
   * «ОТВЕЧЕННЫЙ ЗВОНОК ЗАСЧИТАН ПО ДОГАДКЕ» ЗА ВЧЕРА (20.09.2026,
   * lib/telephony/callTracker.ts, UNCONFIRMED_ANSWER_LOG_INTERVAL_MS).
   *
   * Когда DIALSTATUS не читается со станции (перегруженная АТС, обрыв туннеля),
   * CRM намеренно засчитывает такой звонок разговором — потерять настоящий
   * контакт дороже, чем изредка посчитать лишний. Но каждый такой случай тихо
   * искажает Royal Score и автостатус клиента (см. docs/telephony-deep-calllife-20-09.md,
   * раздел 2), а единственным следом был throttled раз-в-час журнал, который
   * никто не обязан читать. Число здесь — НИЖНЯЯ ГРАНИЦА (сам троттлинг режет
   * до одной строки в час), но рост изо дня в день — уже сигнал смотреть в
   * сторону станции/туннеля, а не тишина, как было раньше.
   */
  unconfirmedAnswersYesterday: number;
  /**
   * «ЧТО НЕ ДОЕХАЛО» (владелец 21.09.2026, экран /stuck-work, lib/stuckWork.ts).
   *
   * stuckWorkGivenUpYesterday — задания фоновой очереди (BackgroundJob),
   * исчерпавшие попытки за сутки; stuckWorkHangingNow — сколько висит СЕЙЧАС
   * (просроченный PENDING/зависший RUNNING), а не за сутки: это долг, который
   * копится, а не событие вчерашнего дня, тот же приём, что и
   * unqualifiedNow выше. Печатается строкой ТОЛЬКО когда сумма больше нуля —
   * пустая ночь не должна занимать место в сводке (правило владельца, п.3
   * задания: «если ноль — строку не печатать вовсе»).
   */
  stuckWorkGivenUpYesterday: number;
  stuckWorkHangingNow: number;
  /**
   * «РАЗДАТЬ ПО ГРУППАМ FACEBOOK» (28.09.2026) — объекты в продаже, ещё не
   * выложенные НИ В ОДНУ группу (lib/facebookGroupShare.ts). `null` — список
   * групп в Настройках пуст: тогда строка не печатается вовсе, как и у прочих
   * счётчиков этого файла при нуле, только здесь «нечего считать», а не «всё
   * сделано» — печатать 0 значило бы соврать, что настройка заведена.
   */
  groupShareNotDoneCount: number | null;
  /**
   * РЕКЛАМА ЗА ВЧЕРА (волна 1, 03.10.2026, lib/ads/adsDigest.ts): потрачено, обращения
   * по Meta, клиенты в CRM, цена клиента и тренд к прошлой неделе. null — кабинет не
   * подключён или вчера трат не было (строка в сводке не печатается); поле
   * необязательное, чтобы прежние читатели и тестовые подделки не менялись.
   */
  adsYesterday?: AdsDigestSummary | null;
}

export interface LoadMorningNumbersOptions {
  /**
   * Считать рекламу за вчера (adsYesterday). По умолчанию НЕТ: loadMorningNumbers зовут и
   * плитки «Штаба», и утренний отчёт, и брифинг — лишние запросы к рекламным таблицам им
   * ни к чему. Сейчас строка про рекламу нужна только пуш-сводке директору (cron.ts).
   */
  ads?: boolean;
}

export async function loadMorningNumbers(options: LoadMorningNumbersOptions = {}): Promise<MorningNumbers> {
  const startOfToday = dushanbeStartOfToday();
  const startOfTomorrow = new Date(startOfToday.getTime() + 86400000);
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOfMonth = dushanbeStartOfMonth();

  const [
    tasksToday,
    leadsYesterday,
    dealsYesterday,
    monthDeals,
    errorsYesterdayRows,
    incomingYesterday,
    missedYesterday,
    unqualifiedNow,
    yesterdayLeads,
  ] = await Promise.all([
    prisma.interaction.count({
      where: { ...TASK_WHERE, investigationOnly: false, completedAt: null, nextActionDate: { gte: startOfToday, lt: startOfTomorrow } },
    }),
    prisma.client.count({ where: { createdAt: { gte: startOfYesterday, lt: startOfToday }, deletedAt: null } }),
    prisma.deal.count({ where: { stage: "COMPLETED", closedAt: { gte: startOfYesterday, lt: startOfToday } } }),
    // Сумма по валютам считается базой: в Node приезжает не список сделок, а
    // одна строка на валюту (их две). Раньше сюда тянулись все сделки месяца.
    prisma.deal.groupBy({
      by: ["currency"],
      where: { stage: "COMPLETED", closedAt: { gte: startOfMonth } },
      _sum: { commissionAmount: true },
    }),
    // Верхняя граница обязательна: без неё в 08:00 окно растягивалось на 32 часа
    // (вчера 00:00 → сейчас), а сводка называла это «за сутки».
    // resolvedAt: null — разобранные ошибки не должны будить директора повторно.
    // Текст сообщения читаем сами (не .count()) — только по нему отличается
    // эксплуатационный шум ИИ-конвейера от того, что ждёт действия человека
    // (classifyErrorLog ниже). Предел выборки — сутки редко дают тысячи строк,
    // но без take счётчик остался бы небезопасным при затяжной аварии.
    visibleErrorLogs().findMany({
      where: { ...visibleSystemErrorWhere(), createdAt: { gte: startOfYesterday, lt: startOfToday }, resolvedAt: null },
      select: { source: true, message: true },
      take: 5000,
    }),
    prisma.incomingCall.count({ where: { startedAt: { gte: startOfYesterday, lt: startOfToday } } }),
    prisma.incomingCall.count({
      where: { startedAt: { gte: startOfYesterday, lt: startOfToday }, answered: false },
    }),
    // Неразобранные — НА СЕЙЧАС и за месяц, а не за вчера: это долг, который копится,
    // и мерить его сутками бессмысленно. Условие ТО ЖЕ, что в журнале входящих —
    // AWAITING_REVIEW_WHERE (разговор с карточкой ИЛИ сообщение автоответчика без неё);
    // своя копия не видела голосовое без карточки (аудит Codex 04.10, CHANNEL-NEW-13).
    prisma.incomingCall.count({
      where: {
        startedAt: { gte: new Date(startOfToday.getTime() - 30 * 86400000) },
        ...AWAITING_REVIEW_WHERE,
      },
    }),
    // Вчерашние лиды с их первым касанием: считаем медиану и «медленных» в Node —
    // строк за сутки десятки, а SQL-перцентиль ради этого читался бы хуже.
    prisma.client.findMany({
      where: { createdAt: { gte: startOfYesterday, lt: startOfToday }, deletedAt: null },
      select: { createdAt: true, firstContactAt: true },
    }),
  ]);

  const errorsYesterday = errorsYesterdayRows.filter(
    (e) => classifyErrorLog(e.source, e.message) === "actionable"
  ).length;

  // В сомони: сводка подписывает сумму как «с.», и долларовые сделки иначе
  // попадали в цифру директору заниженными примерно в одиннадцать раз.
  const money = await loadMoneyContext();
  const commissionMonth = roundMoney(
    monthDeals.reduce((sum, row) => sum + toTjs(row._sum.commissionAmount, row.currency, money), 0)
  );

  // Первое касание: минуты от создания карточки до первой работы агента.
  const touchedMinutes = yesterdayLeads
    .filter((c) => c.firstContactAt)
    .map((c) => (c.firstContactAt!.getTime() - c.createdAt.getTime()) / 60_000)
    .filter((m) => m >= 0)
    .sort((a, b) => a - b);
  const firstTouchMedianMin =
    touchedMinutes.length > 0 ? Math.round(touchedMinutes[Math.floor(touchedMinutes.length / 2)]) : null;
  const firstTouchSlowCount = touchedMinutes.filter((m) => m > 60).length;
  const firstTouchNoneCount = yesterdayLeads.filter((c) => !c.firstContactAt).length;

  const unvisitedScreens = await loadUnvisitedScreens();
  const sellersWithoutPropertyOver7Days = await countSellersWithoutPropertyOver7Days(startOfToday);
  // Показатель «итоги показа просрочены больше двух суток» убран 14.09.2026 вместе
  // с механизмом обязательных окон (решение владельца).
  const showingSummariesOverdue48h = 0;
  const startOfWeek = new Date(startOfToday.getTime() - 7 * 86_400_000);
  const [soldElsewhereWeek, changedMindWeek, emptySellerCardsWeek] = await Promise.all([
    prisma.propertyDeleteRequest.count({
      where: { reason: "SOLD_ELSEWHERE", status: "APPROVED", decidedAt: { gte: startOfWeek } },
    }),
    prisma.clientDeleteRequest.count({
      where: { reason: "CHANGED_MIND", status: "APPROVED", decidedAt: { gte: startOfWeek } },
    }),
    prisma.clientDeleteRequest.count({
      where: { reason: "NO_OBJECT", status: "APPROVED", decidedAt: { gte: startOfWeek } },
    }),
  ]);
  const { sent: reactivationSentThisWeek, replied: reactivationRepliedThisWeek } =
    await countReactivationWeek(startOfToday);
  const reviewsYesterday = await countDealReviewsAnswered(startOfYesterday, startOfToday);
  const botPausedNoReply24h = await countBotPausedNoReply24h();
  const missedCallsNoCallbackYesterday = await countMissedCallsNoCallbackYesterday(startOfToday);
  const unlinkedAdPosts = await loadUnlinkedAdPosts();
  const propertiesWithdrawnSellerRecovered = await countPropertiesWithdrawnSellerRecovered();
  // Из уже прочитанных строк ошибок за вчера (errorsYesterdayRows выше) — не
  // отдельным запросом: те же строки уже в памяти, а фильтр по source+тексту
  // ровно тот же приём, что classifyErrorLog чуть выше. Тот же литеральный
  // dedupKey, которым теперь помечена запись в callTracker.ts — без него
  // message.startsWith не совпал бы (текст начинается именно с него).
  const unconfirmedAnswersYesterday = errorsYesterdayRows.filter(
    (e) => e.source === "telephony" && e.message.startsWith("Ответ клиента не подтверждён станцией")
  ).length;
  const [stuckWorkGivenUpYesterday, stuckWorkHangingNow, groupShareNotDoneCount] = await Promise.all([
    countStuckWorkGivenUpSince(startOfYesterday),
    countStuckWorkHangingNow(),
    countPropertiesWithNoGroupShare(),
  ]);

  // Реклама не имеет права уронить утренние числа: сбой — в журнал, строка просто не печатается.
  const adsYesterday = options.ads
    ? await loadAdsYesterdaySummary().catch((err) => {
        void logSystemError("ads", `Реклама для утренней сводки не посчитана: ${describeError(err)}`, {
          dedupKey: "ads-morning-digest",
        });
        return null;
      })
    : null;

  return {
    tasksToday,
    leadsYesterday,
    dealsYesterday,
    commissionMonth,
    errorsYesterday,
    incomingYesterday,
    missedYesterday,
    unqualifiedNow,
    firstTouchMedianMin,
    firstTouchSlowCount,
    firstTouchNoneCount,
    unvisitedScreens,
    sellersWithoutPropertyOver7Days,
    showingSummariesOverdue48h,
    soldElsewhereWeek,
    changedMindWeek,
    emptySellerCardsWeek,
    reactivationSentThisWeek,
    reactivationRepliedThisWeek,
    reviewsYesterday,
    botPausedNoReply24h,
    missedCallsNoCallbackYesterday,
    unlinkedAdPosts,
    propertiesWithdrawnSellerRecovered,
    unconfirmedAnswersYesterday,
    stuckWorkGivenUpYesterday,
    stuckWorkHangingNow,
    groupShareNotDoneCount,
    adsYesterday,
  };
}

/** Ссылка на пост Instagram внутри текста ошибки — та же форма, что пишет
 *  `messengers/comments.ts` (`mediaPermalink ?? row.mediaId`). */
const AD_POST_URL_RE = /instagram\.com\/\S+/i;

/** См. doc-comment у MorningNumbers.unlinkedAdPosts выше. */
async function loadUnlinkedAdPosts(): Promise<{ url: string; count: number }[]> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await visibleErrorLogs().findMany({
    where: {
      source: "meta",
      message: { contains: "лид-магнит её не узнаёт" },
      createdAt: { gte: since },
    },
    select: { message: true },
    take: 500,
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    const url = AD_POST_URL_RE.exec(row.message)?.[0]?.replace(/[.,)\]]+$/, "");
    if (!url) continue;
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return [...counts.entries()].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count);
}

/** См. doc-comment у MorningNumbers.propertiesWithdrawnSellerRecovered выше. */
async function countPropertiesWithdrawnSellerRecovered(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT DISTINCT p.id
        FROM "Property" p
        JOIN "Client" c ON c.id = p."sellerClientId"
       WHERE p.status = 'WITHDRAWN'
         AND p."deletedAt" IS NULL
         AND c."deletedAt" IS NULL
         AND c.status <> 'LOST'
         AND EXISTS (
           SELECT 1 FROM "AuditLog" a
            WHERE a."entityId" = p.id AND a."entityType" = 'Property'
              AND a.action = 'PROPERTY_STATUS_CHANGED' AND a.meta ->> 'reason' = 'seller-lost'
         )
       LIMIT 2000
    ) t
  `;
  return Number(rows[0]?.n ?? 0);
}

/** См. doc-comment у MorningNumbers.reactivationSentThisWeek выше. */
async function countReactivationWeek(startOfToday: Date): Promise<{ sent: number; replied: number }> {
  const weekAgo = new Date(startOfToday.getTime() - 7 * 86_400_000);
  const sentInteractions = await prisma.interaction.findMany({
    where: { type: "SYSTEM", notes: { startsWith: "[reactivation]" }, createdAt: { gte: weekAgo } },
    select: { clientId: true, createdAt: true },
    take: 2000,
  });
  if (sentInteractions.length === 0) return { sent: 0, replied: 0 };

  const clients = await prisma.client.findMany({
    where: { id: { in: sentInteractions.map((i) => i.clientId) } },
    select: { id: true, returnedAt: true },
  });
  const returnedAtByClient = new Map(clients.map((c) => [c.id, c.returnedAt]));
  const replied = sentInteractions.filter((i) => {
    const returnedAt = returnedAtByClient.get(i.clientId);
    return returnedAt != null && returnedAt.getTime() > i.createdAt.getTime();
  }).length;

  return { sent: sentInteractions.length, replied };
}

/** Статусы, в которых карточка продавца уже не в работе — те же, что и в
 *  lib/dealStalePipeline.ts (ACTIVE_STATUS_WHERE): «Потерян»/«Сделка закрыта»/
 *  «Архив» и так объясняют отсутствие объекта, считать их не нужно. */
const SELLER_INACTIVE_STATUSES = ["LOST", "DEAL_CLOSED", "ARCHIVED"] as const;

/** Грубый ежедневный счёт — см. doc-comment у MorningNumbers.sellersWithoutPropertyOver7Days
 *  за тем, чем он отличается от runSellerNoPropertyAlarmTick.
 *  Экспортирована ради точечного теста (ночная проверка 24.09.2026). */
export async function countSellersWithoutPropertyOver7Days(startOfToday: Date): Promise<number> {
  const cutoff = new Date(startOfToday.getTime() - 7 * 86_400_000);
  const candidates = await prisma.client.findMany({
    where: {
      kind: "SELLER",
      deletedAt: null,
      status: { notIn: [...SELLER_INACTIVE_STATUSES] },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    take: 2000,
  });
  if (candidates.length === 0) return 0;

  const withProperty = await prisma.property.findMany({
    // deletedAt: null — ночная проверка 24.09.2026: без него объект, ушедший в
    // Корзину, всё ещё засчитывался как «объект есть», и продавец занижал
    // счётчик «без объекта 7+ дней» — зеркало sellerNoPropertyAlarm.ts этот
    // фильтр уже ставит.
    where: { sellerClientId: { in: candidates.map((c) => c.id) }, deletedAt: null },
    select: { sellerClientId: true },
    distinct: ["sellerClientId"],
  });
  const haveProperty = new Set(withProperty.map((p) => p.sellerClientId));
  return candidates.filter((c) => !haveProperty.has(c.id)).length;
}

/** Неделя — столько нужно накопить, чтобы «не заходили» означало правду. */
const OBSERVATION_WARMUP_DAYS = 7;

/**
 * Экраны без единого посещения за всё время наблюдения.
 *
 * Отдельно про «за всё время»: окно в неделю здесь было бы ошибкой. Раздел,
 * который открывают раз в месяц при сдаче отчётности, попадал бы в список
 * каждую неделю и приучил бы не обращать на него внимания — а список ценен
 * ровно тем, что в него попадает только по-настоящему нехоженое.
 */
async function loadUnvisitedScreens(): Promise<string[]> {
  const [earliest, visited] = await Promise.all([
    prisma.routeHit.aggregate({ _min: { firstSeenAt: true } }),
    prisma.routeHit.findMany({ where: { kind: "screen" }, select: { key: true } }),
  ]);

  const startedAt = earliest._min.firstSeenAt;
  if (!startedAt) return []; // счётчик только что выкачен, данных нет вовсе
  const daysObserved = (Date.now() - startedAt.getTime()) / 86_400_000;
  if (daysObserved < OBSERVATION_WARMUP_DAYS) return [];

  const seen = new Set(visited.map((v) => v.key));
  return ALL_SCREENS.filter((screen) => !seen.has(screen));
}
