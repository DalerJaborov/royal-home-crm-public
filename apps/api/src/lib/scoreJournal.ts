/**
 * Журнал Royal Score: что и почему повлияло на счёт агента.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 03.08.2026 (отменяет решение от 01.08): счёт считается ПРЯМО
 * по этому журналу — сумма событий в скользящем окне (см. computeRoyalScore ниже),
 * а не взвешенной моделью восьми показателей из kpi.ts. Риск «потолка 100» (две
 * сделки — и штрафы перестают ощущаться) снят окном: старые начисления сами
 * выходят из расчёта, вместо того чтобы застревать в счёте навсегда. Подробности —
 * docs/spec-compliance-03-08-2026.md и docs/owner-spec-verbatim-31-07-01-08-2026.md
 * (часть 3, таблица начисления и списания).
 *
 * ЗАПИСИ НЕ УДАЛЯЮТСЯ. Маршрутов правки и удаления нет вовсе — не потому, что
 * забыли, а потому, что журнал, из которого можно вычеркнуть строку, не разрешает
 * спор, а создаёт его.
 *
 * ЗАПИСЬ НИКОГДА НЕ РОНЯЕТ ОСНОВНОЕ ДЕЙСТВИЕ. Закрытие сделки не должно
 * проваливаться из-за того, что не записалась строка в журнал: деньги важнее
 * объяснения. Поэтому все ошибки здесь не выбрасываются наружу — но и не молчат:
 * каждая, кроме «уже записано», уходит в журнал ошибок через logSystemError.
 */

import { DEFAULT_EVENT_POINTS, type ScoreEventKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { royalScoreEnabled } from "./royalScoreSwitch.js";
import { logSystemError } from "./systemError.js";

/**
 * ВИДЫ СОБЫТИЙ И ИХ ЦЕНЫ ЖИВУТ В ОБЩЕМ ПАКЕТЕ.
 *
 * Каталог (ключ + подпись + цена по умолчанию) — `@royal-home/shared`,
 * `royalScoreEvents.ts`. Здесь только реэкспорт, чтобы десяток файлов,
 * импортирующих `ScoreEventKind`/`DEFAULT_EVENT_POINTS` отсюда, не пришлось
 * трогать.
 *
 * Список переехал 10.09.2026 потому, что копий было две: цены здесь, подписи и
 * группы — на экране Настроек. Экран отправляет `royalScoreEventPoints`
 * ЦЕЛИКОМ, своим набором ключей, а сервер записывает присланное поверх
 * прежнего: событие, которого экран не знал, не просто нельзя было настроить —
 * сохранение формы стирало ему ранее заданную цену. Так молча выпали
 * `lead_ignored` и `client_recovered_bonus`.
 */
export type { ScoreEventKind };
export { DEFAULT_EVENT_POINTS };


export interface ScoreEventInput {
  agentId: string;
  kind: ScoreEventKind;
  /** Изменение в баллах, как его видит человек. Ноль допустим: бывают события без
   *  цены, но с объяснением («карточка ушла на проверку»). */
  delta: number;
  reason: string;
  /** Кто инициировал; не задан — система. */
  initiatorId?: string | null;
  /**
   * Что породило событие: id сделки, показа, лида.
   *
   * FAIR PLAY, «одно действие — одни баллы». Повторный PATCH сделки (сеть моргнула,
   * кнопку нажали дважды, вебхук доставился второй раз) не должен писать «+10 за
   * сделку» ещё раз: иначе агент, умеющий кликать, обгоняет агента, умеющего
   * продавать. Арбитр — уникальность в БД, а не проверка «а нет ли уже такого»:
   * два одновременных запроса оба увидели бы пустоту.
   *
   * Не задан — событие повторяться МОЖЕТ (ручная правка счёта делается сколько
   * угодно раз, и каждая обязана остаться в журнале отдельной строкой).
   */
  sourceId?: string | null;
}

/** Ошибка уникального ограничения Prisma — «такое событие уже записано». */
const UNIQUE_VIOLATION = "P2002";

function scoreEventData(input: ScoreEventInput) {
  return {
    agentId: input.agentId,
    kind: input.kind,
    // Округляем до сотых, а не до целого: «объект исправлен после возврата»
    // даёт +2.7 (90% от снятых 3 баллов, п. 20 таблицы владельца) — Math.round
    // здесь съедал бы дробную часть и превращал 2.7 в 3.
    delta: Math.round(input.delta * 100) / 100,
    reason: input.reason.slice(0, 500),
    initiatorId: input.initiatorId ?? null,
    sourceId: input.sourceId ?? null,
  };
}

/**
 * Несколько событий ОДНОЙ транзакцией: либо записаны все, либо ни одного
 * (находка №161). Ручное переопределение пишет пару «погасить старое + начислить
 * верное»; по отдельности сбой второй записи оставлял агента с баллами в минусе,
 * а директор видел «ok». В отличие от recordScoreEvent ошибку НЕ глотает —
 * решать, что ответить, должен вызывающий. Рубильник выключен — не пишет ничего.
 */
export async function recordScoreEventsAtomic(inputs: ScoreEventInput[]): Promise<void> {
  if (!(await royalScoreEnabled())) return;
  await prisma.$transaction(inputs.map((input) => prisma.royalScoreEvent.create({ data: scoreEventData(input) })));
}

/**
 * Возвращает промис, но ЖДАТЬ его обязательно не нужно: своя обработка ошибок
 * внутри, поэтому обычный вызов без await остаётся «записали и пошли дальше»
 * (так вызывает большинство мест — начисление не должно задерживать ответ).
 *
 * Ждать нужно там, где вызывающий сразу после ответа читает журнал: иначе
 * ответ 200 уходит раньше записи, и клиент видит несуществующее «ничего не
 * изменилось». Ровно на этом падал client-loss-fault.test.ts в CI, оставаясь
 * зелёным локально — гонка, а не разница окружений.
 */
export async function recordScoreEvent(input: ScoreEventInput): Promise<void> {
  // Рубильник выключен — событие не пишется вовсе, не только не влияет на счёт.
  // Одна точка на все начисления: сюда идут и cardReminders.ts, и deals.ts, и
  // properties/*, и interactions.ts, и ручная корректировка directора
  // (royalScoreEvents.ts) — другого пути записи в журнал нет.
  if (!(await royalScoreEnabled())) return;
  return prisma.royalScoreEvent
    .create({ data: scoreEventData(input) })
    /**
     * PUSH ОБ ИЗМЕНЕНИИ СЧЁТА УБРАН СОВСЕМ (владелец 20.09.2026: «Royal Score
     * удалить»). Начисления идут пачками с ночных разборов, и агент получал
     * подряд несколько вибраций про баллы — ровно тот поток, после которого
     * уведомления выключают целиком. Сам счёт и полная история с причинами
     * никуда не делись: они открыты в кабинете агента в любой момент.
     * Вместе с этим удалён lib/scoreAlert.ts — у него не осталось вызывающих.
     */
    .catch((err) => {
      // Повтор — это НЕ ошибка, а сработавшая защита: событие уже записано, второй
      // раз баллы не начисляются. Шуметь в консоль здесь значило бы приучить всех
      // не читать её.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[scoreJournal] событие не записано:", message);
      // Одной консоли контейнера мало: непоставленный балл не виден ни агенту, ни
      // директору, а «Здоровье системы» показывает зелёное. Пишем в журнал ошибок
      // — так же, как отказы внешних интеграций (аудит 12.08.2026, пункт К).
      void logSystemError("api", `Royal Score: событие ${input.kind} не записано — ${message}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
    })
    .then(() => undefined);
}

export interface ScoreEventView {
  id: string;
  at: string;
  kind: string;
  delta: number;
  reason: string;
  /** Кто инициировал; null — система. */
  initiator: string | null;
}

/**
 * Последние события агента.
 *
 * Предел выборки обязателен: маршрут, возвращающий массив, без потолка однажды
 * вернёт всё. Пятьдесят — это несколько месяцев работы одного человека, дальше
 * листать некому.
 */
export async function loadScoreEvents(agentId: string, limit = 50): Promise<ScoreEventView[]> {
  const rows = await prisma.royalScoreEvent.findMany({
    where: { agentId },
    orderBy: { at: "desc" },
    take: Math.min(Math.max(1, limit), 200),
    include: { initiator: { select: { fullName: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    kind: r.kind,
    delta: r.delta,
    reason: r.reason,
    initiator: r.initiator?.fullName ?? null,
  }));
}

/** Цена «Сделка закрыта» ПО УМОЛЧАНИЮ (таблица владельца). В журнал routes/deals.ts
 *  пишет цену из каталога (loadEventPoints) — ту, которой считается счёт (C11,
 *  02.10.2026); константа осталась для тестов с настройками по умолчанию. */
export const DEAL_CLOSED_POINTS = DEFAULT_EVENT_POINTS.deal_closed;

/** То же самое для бонуса за возвращённого клиента — тот же routes/deals.ts,
 *  тот же момент закрытия сделки, до похода за Settings.royalScoreEventPoints. */
export const CLIENT_RECOVERED_BONUS_POINTS = DEFAULT_EVENT_POINTS.client_recovered_bonus;

/**
 * Цена события с учётом настроек. null/не заданное поле в Settings —
 * значение по умолчанию (тот же принцип, что и loadKpiWeights в kpi.ts).
 */
export async function loadEventPoints(): Promise<Record<ScoreEventKind, number>> {
  const settings = await prisma.settings.findFirst({ select: { royalScoreEventPoints: true } });
  const overrides = settings?.royalScoreEventPoints;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return DEFAULT_EVENT_POINTS;
  }
  const merged = { ...DEFAULT_EVENT_POINTS };
  for (const key of Object.keys(merged) as ScoreEventKind[]) {
    const value = (overrides as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * ОТМЕНА ПЕРЕОПРЕДЕЛЕНИЯ — строка с этим префиксом sourceId (routes/royalScoreEvents.ts).
 * Директор снимает «по вине агента»: журнал только на дозапись, поэтому пишется
 * строка того же вида с обратным знаком (`override-revert-<id>`) и строка нового
 * вида (`override-apply-<id>`).
 */
export const SCORE_OVERRIDE_REVERT_PREFIX = "override-revert-";
/** Обе строки переопределения (отмена и новый вид) — не новые события, а поправка старого. */
export const SCORE_OVERRIDE_PREFIX = "override-";

/**
 * ВКЛАД СОБЫТИЯ В СЧЁТ — ОДНО ПРАВИЛО ДЛЯ ВСЕХ, КТО СКЛАДЫВАЕТ ЖУРНАЛ.
 *
 * Цена берётся из каталога (Настройки), а не из записанного delta — правка цены
 * действует и на уже записанные события (см. computeRoyalScore). Исключение —
 * строка-отмена переопределения: она того же вида, что исходная, и по цене вида
 * считалась ЕЩЁ ОДНИМ штрафом. Снятие вины давало −10 вместо 0 (глубокая
 * проверка 02.10.2026, C3). Отмена гасит исходное событие по той же цене, по
 * которой оно считается, — поэтому вклад отмены = минус цена вида.
 */
export function scoreEventPoints(
  event: { kind: string; delta: number; sourceId?: string | null },
  points: Record<ScoreEventKind, number>
): number {
  const price = points[event.kind as ScoreEventKind];
  if (event.sourceId?.startsWith(SCORE_OVERRIDE_REVERT_PREFIX)) {
    return price !== undefined ? -price : event.delta;
  }
  return price ?? event.delta;
}

/**
 * Royal Score агента: стартовый счёт + сумма событий в скользящем окне, зажатая
 * в границы 0–100 (спецификация 01.08.2026, часть 3: «Royal Score никогда не
 * может быть больше 100 / меньше 0»).
 *
 * ПОЧЕМУ ОКНО, А НЕ ВЕСЬ ЖУРНАЛ. Голая сумма за всё время ломается ровно так, как
 * описано в owner-spec-verbatim: две сделки поднимают счёт к потолку, и штрафы
 * перестают ощущаться. Окно (по умолчанию 30 дней, Settings.royalScoreWindowDays)
 * снимает это: старое начисление само выходит из расчёта, и удержаться наверху
 * можно только продолжая работать — решение владельца от 03.08.2026.
 *
 * Цены событий читаются из настроек НА МОМЕНТ РАСЧЁТА, а не на момент записи в
 * журнал: если директор меняет цену задним числом, пересчёт сразу отражает новое
 * значение для старых событий в окне. Сам журнал (что произошло и когда) при этом
 * не переписывается — правится только вес, а не факт.
 */
export async function computeRoyalScore(agentId: string, now: Date = new Date()): Promise<number> {
  const settings = await prisma.settings.findFirst({
    select: { royalScoreWindowDays: true, royalScoreStartingScore: true },
  });
  const windowDays = settings?.royalScoreWindowDays ?? 30;
  const startingScore = settings?.royalScoreStartingScore ?? 100;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const points = await loadEventPoints();
  const events = await prisma.royalScoreEvent.findMany({
    where: { agentId, at: { gte: windowStart, lte: now } },
    select: { kind: true, delta: true, sourceId: true },
  });

  // Цена события пересчитывается по актуальным настройкам (см. выше), а не берётся
  // из сохранённого delta — иначе правка цены в настройках не действовала бы на
  // события, уже попавшие в журнал, и осталась бы работать только для будущих.
  const sum = events.reduce((acc, e) => acc + scoreEventPoints(e, points), 0);
  return Math.min(100, Math.max(0, Math.round(startingScore + sum)));
}

/**
 * Шесть показателей владельца (docs/owner-spec-verbatim, часть 3, строка 162):
 * «Продажи 40% · Скорость обработки лидов 20% · Работа с CRM 15% · Работа с
 * объектами 10% · Выполнение задач 10% · Дисциплина 5%». Проценты — не формула
 * пересчёта (счёт по решению от 03.08 считается прямо по журналу событий, без
 * весов), а РАСШИФРОВКА: к какому смысловому блоку относится каждый вид
 * события, чтобы агент видел не только «что» (журнал), но и «откуда набежало» —
 * крупными категориями, а не построчно.
 *
 * Вес — только подпись для интерфейса (сортировка блоков, ширина индикатора),
 * НЕ множитель: категория с весом 5% не режет вклад события в пять раз — цена
 * события остаётся ровно той, что в `DEFAULT_EVENT_POINTS`/Настройках.
 *
 * `kpi_override`/`lead_missed` — устаревшие виды (см. выше), в категории
 * сознательно не включены: они не должны появляться в новых записях, и куда их
 * относить — решать не на чем.
 */
export type RoyalScoreCategoryKey = "sales" | "speed" | "crm" | "properties" | "tasks" | "discipline";

export const ROYAL_SCORE_CATEGORIES: { key: RoyalScoreCategoryKey; label: string; weightPercent: number }[] = [
  { key: "sales", label: "Продажи", weightPercent: 40 },
  { key: "speed", label: "Скорость обработки лидов", weightPercent: 20 },
  { key: "crm", label: "Работа с CRM", weightPercent: 15 },
  { key: "properties", label: "Работа с объектами", weightPercent: 10 },
  { key: "tasks", label: "Выполнение задач", weightPercent: 10 },
  { key: "discipline", label: "Дисциплина", weightPercent: 5 },
];

/** Экспортируется наружу, потому что «к какому показателю относится событие» —
 *  вопрос не только счёта агента: разбор проблемных мест (lib/problemReport.ts)
 *  считает просевшие категории ЗА ОТЧЁТНЫЙ ПЕРИОД, а не за скользящее окно, и
 *  вторая копия этой таблицы разошлась бы с этой при первом же новом виде события. */
export const CATEGORY_OF: Partial<Record<ScoreEventKind, RoyalScoreCategoryKey>> = {
  deal_closed: "sales",
  client_lost_agent_fault: "sales",
  client_lost_no_fault: "sales",
  client_recovered_bonus: "sales",
  deal_closed_reversed: "sales",
  client_recovered_bonus_reversed: "sales",
  lead_accepted: "speed",
  lead_declined_1: "speed",
  lead_declined_2: "speed",
  lead_declined_3: "speed",
  lead_declined_4plus: "speed",
  call_15min_missed: "speed",
  call_on_time: "speed",
  card_filled: "crm",
  card_not_filled: "crm",
  mandatory_window_on_time: "crm",
  mandatory_window_overdue: "crm",
  security_review: "crm",
  property_added: "properties",
  property_reworked: "properties",
  property_rework_fixed: "properties",
  photos_approved_first_try: "properties",
  video_approved_first_try: "properties",
  photos_overdue: "properties",
  video_overdue: "properties",
  showing_done: "tasks",
  showing_missed: "tasks",
  meeting_done: "tasks",
  meeting_overdue: "tasks",
  task_on_time: "tasks",
  task_overdue: "tasks",
  inactivity_penalty: "discipline",
  inactivity_warning: "discipline",
  client_revived_from_red: "discipline",
  client_revived_from_yellow: "discipline",
};

/**
 * Человеческое описание каждого события — источник для панели «Как считаются
 * баллы» в личном кабинете агента (владелец 03.09.2026: «чтобы агенты видели
 * за что какой минус и плюс»). Один текст на весь проект: и здесь, и на
 * фронте показывается ровно это, а не отдельно придуманная копия.
 */
export const EVENT_LABELS: Partial<Record<ScoreEventKind, string>> = {
  lead_accepted: "Принял лид",
  lead_declined_1: "Отказ от лида, 1-й подряд — без штрафа",
  lead_declined_2: "Отказ от лида, 2-й подряд",
  lead_declined_3: "Отказ от лида, 3-й подряд",
  lead_declined_4plus: "Отказ от лида, 4-й и далее подряд",
  lead_ignored: "Лид не принят и не отклонён — ушёл сам",
  call_15min_missed: "Не позвонил за 15 минут после приёма лида",
  call_on_time: "Позвонил вовремя",
  mandatory_window_on_time: "Обязательное окно заполнено вовремя",
  mandatory_window_overdue: "Обязательное окно просрочено",
  card_filled: "Карточка клиента полностью заполнена",
  card_not_filled: "Карточка не заполнена",
  showing_done: "Показ проведён, итог заполнен",
  showing_missed: "Показ пропущен без предупреждения",
  meeting_done: "Встреча с продавцом проведена",
  meeting_overdue: "Встреча просрочена",
  task_on_time: "Задача выполнена вовремя",
  task_overdue: "Задача просрочена",
  property_added: "Объект добавлен в CRM",
  property_reworked: "Объект отправлен на доработку",
  property_rework_fixed: "Доработка объекта исправлена",
  photos_approved_first_try: "Фото приняты с первого раза",
  video_approved_first_try: "Видео принято с первого раза",
  photos_overdue: "Фото просрочены",
  video_overdue: "Видео просрочено",
  deal_closed: "Сделка закрыта",
  client_lost_agent_fault: "Клиент потерян по вине агента",
  client_lost_no_fault: "Клиент потерян не по вине агента",
  client_recovered_bonus: "Возвращён ранее потерянный клиент — сверх баллов за саму сделку",
  deal_closed_reversed: "Сделка аннулирована после закрытия (комиссия обнулена)",
  client_recovered_bonus_reversed: "Надбавка за возвращённого клиента отменена вместе со сделкой",
  inactivity_penalty: "Слив в неактивные без предупреждения",
  inactivity_warning: "Предупреждение: клиент близок к сливу без действий",
  security_review: "Карточка ушла на проверку СБ",
  client_revived_from_red: "Дозвонился и вывел клиента из красного",
  client_revived_from_yellow: "Дозвонился и вывел клиента из жёлтого",
};

/**
 * Полная таблица «событие → баллы» для панели агента — цены берутся из
 * Settings.royalScoreEventPoints (loadEventPoints), не из DEFAULT_EVENT_POINTS
 * напрямую: правка директором должна тут же отражаться в объяснении, а не
 * только в самом счёте.
 */
export interface EventPointsGuideRow {
  kind: string;
  label: string;
  category: RoyalScoreCategoryKey;
  points: number;
}

export async function buildEventPointsGuide(): Promise<EventPointsGuideRow[]> {
  const points = await loadEventPoints();
  return (Object.keys(CATEGORY_OF) as ScoreEventKind[]).map((kind) => ({
    kind,
    label: EVENT_LABELS[kind] ?? kind,
    category: CATEGORY_OF[kind]!,
    points: points[kind],
  }));
}

/**
 * Сумма событий за окно (те же правила, что и `computeRoyalScore`: цена — из
 * актуальных настроек, окно — `Settings.royalScoreWindowDays`), сгруппированная
 * по шести показателям. Сумма всех категорий может НЕ РАВНЯТЬСЯ `computeRoyalScore
 * − startingScore` — устаревшие события (`kpi_override`/`lead_missed`), если
 * они ещё встречаются в окне у кого-то из старых агентов, в категории не входят
 * и потерялись бы из расшифровки молча; это ожидаемо и не является ошибкой.
 */
export async function computeRoyalScoreBreakdown(
  agentId: string,
  now: Date = new Date()
): Promise<Record<RoyalScoreCategoryKey, number>> {
  const settings = await prisma.settings.findFirst({ select: { royalScoreWindowDays: true } });
  const windowDays = settings?.royalScoreWindowDays ?? 30;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const points = await loadEventPoints();
  const events = await prisma.royalScoreEvent.findMany({
    where: { agentId, at: { gte: windowStart, lte: now } },
    select: { kind: true, delta: true, sourceId: true },
  });

  const sums = emptyBreakdown();
  for (const e of events) {
    const category = CATEGORY_OF[e.kind as ScoreEventKind];
    if (!category) continue;
    sums[category] += scoreEventPoints(e, points);
  }
  return sums;
}

function emptyBreakdown(): Record<RoyalScoreCategoryKey, number> {
  return Object.fromEntries(ROYAL_SCORE_CATEGORIES.map((c) => [c.key, 0])) as Record<RoyalScoreCategoryKey, number>;
}

/**
 * То же самое, но на список агентов сразу: один запрос настроек и один запрос
 * событий (`agentId IN […]`) вместо двух запросов НА КАЖДОГО.
 *
 * Нужна виджетам дашборда, которые считают разбивку по всей команде за один заход
 * («слабое звено недели»). Поштучный вариант там означал 2×N запросов при каждом
 * открытии главной — то самое «await внутри map по списку из БД», которого соседние
 * функции dashboardInsights.ts уже избегают.
 *
 * Возвращает запись на КАЖДЫЙ переданный id, даже если событий у агента не было:
 * иначе вызывающему пришлось бы отличать «нет событий» от «агента забыли», а нули
 * и есть правильный ответ для того, у кого за окно ничего не происходило.
 */
export async function computeRoyalScoreBreakdownBatch(
  agentIds: string[],
  now: Date = new Date()
): Promise<Map<string, Record<RoyalScoreCategoryKey, number>>> {
  const result = new Map<string, Record<RoyalScoreCategoryKey, number>>();
  if (!agentIds.length) return result;

  const settings = await prisma.settings.findFirst({ select: { royalScoreWindowDays: true } });
  const windowDays = settings?.royalScoreWindowDays ?? 30;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const points = await loadEventPoints();
  const events = await prisma.royalScoreEvent.findMany({
    where: { agentId: { in: agentIds }, at: { gte: windowStart, lte: now } },
    select: { agentId: true, kind: true, delta: true, sourceId: true },
  });

  for (const agentId of agentIds) result.set(agentId, emptyBreakdown());
  for (const e of events) {
    const category = CATEGORY_OF[e.kind as ScoreEventKind];
    if (!category) continue;
    const sums = result.get(e.agentId);
    if (!sums) continue;
    sums[category] += scoreEventPoints(e, points);
  }
  return result;
}
