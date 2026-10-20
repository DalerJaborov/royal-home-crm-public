import { describe, it, expect, vi } from "vitest";

/**
 * Скорость первого касания в утренней сводке (совет экспертов 26.08, пункт 7).
 *
 * firstContactAt фиксировался давно, но никуда не агрегировался: ни один экран
 * и ни одно письмо не называли цифру, хотя конверсия лида падает в разы после
 * первых пятнадцати минут.
 *
 * ПОЛНЫЙ МОК PRISMA, А НЕ ЖИВАЯ БАЗА (найдено 03.09.2026). loadMorningNumbers
 * считает «лидов за вчера» БЕЗ фильтра по тесту — это настоящий агрегат на всю
 * компанию, ровно как в проде. Прежняя версия теста создавала свои фикстуры
 * поверх ОБЩЕЙ базы разработки и звала настоящий prisma.client.findMany:
 * любой чужой клиент, реально созданный вчера (а в общей базе, где параллельно
 * работают десятки сессий, такие есть всегда), считался вместе с тестовыми —
 * тест то падал, то проходил в зависимости от того, кто и что успел создать. Не
 * трогаем реальные записи (жалко чужую работу и рискованно), а полностью
 * подменяем prisma: тест контролирует «вчерашних лидов» напрямую, без похода в
 * базу вовсе.
 */

// Значение по умолчанию — []: loadMorningNumbers зовёт prisma.client.findMany
// НЕСКОЛЬКО раз за один прогон (вчерашние лиды — этот тест их и подставляет
// через mockResolvedValueOnce, но 11.09.2026 пачки 9/10 добавили ещё один
// самостоятельный запрос: countSellersWithoutPropertyOver7Days читает
// кандидатов-продавцов тем же prisma.client.findMany). Без дефолта второй (и
// любой следующий) вызов получал undefined и падал на candidates.length —
// mockResolvedValueOnce покрывает только ОДИН, самый первый вызов в очереди.
const clientFindMany = vi.fn().mockResolvedValue([]);

vi.mock("../src/db.js", () => ({
  prisma: {
    // count — задачи на сегодня; findMany — reactivationSentThisWeek читает
    // напоминания-«[reactivation]» тем же interaction.findMany (см. ниже);
    // без мока падало на "Cannot read properties of undefined (reading 'findMany')".
    interaction: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    client: { count: vi.fn().mockResolvedValue(0), findMany: clientFindMany },
    deal: { count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) },
    // findMany, не count: errorsYesterday теперь классифицирует текст сообщения
    // (operational/actionable — lib/errorLogClassify.ts, 03.09.2026), а это
    // видно только читая строки, не считая их в базе.
    errorLog: { findMany: vi.fn().mockResolvedValue([]) },
    // Пачка 18 (12.09.2026): countMissedCallsNoCallbackYesterday читает пропущенные
    // findMany-ом и сверяет перезвон по Interaction — без мока падало на
    // "prisma.incomingCall.findMany is not a function".
    incomingCall: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    // Пачка 17 (12.09.2026): countBotPausedNoReply24h считает диалоги на паузе
    // в обеих таблицах диалогов.
    botConversation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    telegramConversation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    // Карта обследованного (08.09.2026, lib/routeHits.ts): loadMorningNumbers
    // теперь зовёт и это — без мока падало не по смыслу теста, а на
    // "Cannot read properties of undefined (reading 'aggregate')". aggregate
    // отдаёт firstSeenAt=null — ровно то же, что и на настоящей пустой базе:
    // loadUnvisitedScreens возвращает [] сразу, findMany не влияет на результат
    // теста про скорость первого касания вовсе.
    routeHit: {
      aggregate: vi.fn().mockResolvedValue({ _min: { firstSeenAt: null } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // countSellersWithoutPropertyOver7Days (пачка 9/10, 11.09.2026): после
    // кандидатов-продавцов читает объекты по ним тем же findMany, что и
    // routes/properties/* — этот тест их не создаёт, пустой список = 0 без
    // объекта у всех кандидатов, что для []-кандидатов (дефолт выше) не
    // выполняется вовсе.
    property: { findMany: vi.fn().mockResolvedValue([]) },
    // countShowingSummariesOverdue48h (pendingSummaries.ts, та же пачка):
    // отдельная модель, без мока падало на "Cannot read properties of
    // undefined (reading 'count')" уже после первых трёх новых полей.
    pendingSummary: { count: vi.fn().mockResolvedValue(0) },
    // Очередь фоновых заданий (21.09.2026, #627): в сводку добавились
    // «сдалось за сутки» и «висит сейчас» — countStuckWorkGivenUpSince и
    // countStuckWorkHangingNow (lib/stuckWork.ts), оба через .count() по
    // BackgroundJob. Без мока падало на «Cannot read properties of undefined
    // (reading 'count')» — и не в новой правке, а здесь: подмена перечисляет
    // модели руками, поэтому КАЖДЫЙ новый счётчик в сводке надо вписывать и
    // сюда (та же грабля, что у остальных строк выше).
    backgroundJob: { count: vi.fn().mockResolvedValue(0) },
    // Пачки 11-13 (11.09.2026): «за неделю одобрено» в сводке — соседние
    // счётчики «продано в другом месте / передумал / пустая карточка
    // продавца» читают заявки на удаление тем же .count(). Без мока падало на
    // "Cannot read properties of undefined (reading 'count')".
    propertyDeleteRequest: { count: vi.fn().mockResolvedValue(0) },
    clientDeleteRequest: { count: vi.fn().mockResolvedValue(0) },
    // countDealReviewsAnswered (lib/dealReviews.ts) идёт через $queryRaw, не
    // через модель prisma.dealReview — той же причины, что и весь остальной
    // слой DealDocument (см. lib/dealDocumentsDb.ts): миграция написана
    // руками. rows[0]?.count ?? 0 спокойно принимает пустой массив.
    $queryRaw: vi.fn().mockResolvedValue([]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
// Заглушка ЧАСТИЧНАЯ, но перечислять экспорты руками нельзя: как только денежный
// модуль обзаводится новой функцией (03.09.2026 — roundMoney), мок перестаёт её
// отдавать, и падает не деньги, а этот тест про скорость первого касания.
// importOriginal оставляет всё настоящим, кроме курса, который тесту не нужен.
vi.mock("../src/lib/money.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/money.js")>()),
  loadMoneyContext: vi.fn().mockResolvedValue({ usdToTjs: 1 }),
}));

const { loadMorningNumbers } = await import("../src/lib/morningNumbers.js");
const { dushanbeStartOfToday } = await import("../src/lib/dushanbeTime.js");

const startOfToday = dushanbeStartOfToday();
const yesterday = (hoursFromStart: number) => new Date(startOfToday.getTime() - 86400000 + hoursFromStart * 3600000);

/** Вчерашний лид: создан во столько-то, первое касание через minutesLater минут (null — не дождался). */
function lead(createdHour: number, minutesLater: number | null) {
  const createdAt = yesterday(createdHour);
  return { createdAt, firstContactAt: minutesLater === null ? null : new Date(createdAt.getTime() + minutesLater * 60_000) };
}

describe("скорость первого касания за вчера", () => {
  it("медиана считается по коснувшимся лидам, медленные и без ответа — отдельно", async () => {
    clientFindMany.mockResolvedValueOnce([
      lead(9, 5), // быстро
      lead(10, 15), // медиана
      lead(11, 120), // дольше часа
      lead(12, null), // не дождался вовсе
    ]);

    const numbers = await loadMorningNumbers();

    // Три коснувшихся: 5, 15, 120 → медиана 15.
    expect(numbers.firstTouchMedianMin).toBe(15);
    expect(numbers.firstTouchSlowCount).toBe(1);
    expect(numbers.firstTouchNoneCount).toBe(1);
  });

  it("вчера никого не коснулись — медианы нет, но «без ответа» видно", async () => {
    clientFindMany.mockResolvedValueOnce([lead(9, null), lead(10, null)]);

    const numbers = await loadMorningNumbers();

    expect(numbers.firstTouchMedianMin).toBeNull();
    expect(numbers.firstTouchNoneCount).toBe(2);
  });

  it("запрос лидов ограничен окном [вчера, сегодня) — сегодняшние в него не попадут", async () => {
    // При полном моке Prisma нельзя проверить границу окна через РЕЗУЛЬТАТ
    // запроса (findMany и так вернёт что скажет мок) — проверяем то, что
    // реально гарантирует исключение сегодняшних лидов: аргументы, с которыми
    // код обратился к базе. Именно этот where раньше растягивался на 32 часа
    // без верхней границы (см. комментарий в morningNumbers.ts).
    clientFindMany.mockResolvedValueOnce([]);
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000);

    await loadMorningNumbers();

    // prisma.client.findMany вызывается за один прогон НЕСКОЛЬКО раз (11.09.2026,
    // countSellersWithoutPropertyOver7Days читает кандидатов-продавцов тем же
    // методом) — .at(-1) больше не гарантированно берёт запрос лидов. Ищем по
    // форме where: только у запроса лидов createdAt задаёт ОБЕ границы (gte и lt).
    type LeadsCall = { where: { createdAt?: { gte?: Date; lt?: Date } } };
    const leadsCall = clientFindMany.mock.calls
      .map((args) => args[0] as LeadsCall)
      .find((arg) => arg?.where?.createdAt?.gte && arg?.where?.createdAt?.lt);
    expect(leadsCall, "запрос лидов с окном [gte, lt) должен быть среди вызовов findMany").toBeTruthy();
    expect(leadsCall!.where.createdAt!.gte!.getTime()).toBe(startOfYesterday.getTime());
    expect(leadsCall!.where.createdAt!.lt!.getTime()).toBe(startOfToday.getTime());
  });
});
