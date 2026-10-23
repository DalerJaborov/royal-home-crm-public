import { randomUUID } from "node:crypto";
import {
  liveEventPayloadSchema,
  type LiveEvent,
  type LiveEventInput,
  type LiveEventType,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { dropMissionControlSections } from "./pultCacheHook.js";
import { logSystemError } from "./systemError.js";
import { guardBackgroundFailure, isShuttingDown, trackBackgroundTask } from "./shutdownState.js";

/**
 * ШИНА ЖИВЫХ СОБЫТИЙ (12.09.2026) — сервер→браузер без опроса по таймеру.
 *
 * ── ПОЧЕМУ ТАБЛИЦА, А НЕ pg_notify ────────────────────────────────────────
 * Процессов два: контейнер `api` (HTTP, ENABLE_BACKGROUND=0) и контейнер
 * `worker` (кроны, Telegram-поллер) — см. docker-compose.prod.yml. SSE-подписки
 * живут только в HTTP-процессе, а половина событий рождается в worker, значит
 * нужен общий канал между процессами.
 *
 * pg_notify напрашивается и был первым выбором, но LISTEN требует СВОЕГО
 * постоянного соединения с Postgres: у Prisma такого не достать (движок
 * запросов мультиплексирует пул и уведомления наружу не отдаёт), а драйвера
 * `pg` в зависимостях нет и ставить его нельзя. Redis/BullMQ в проекте тоже
 * нет. Оставался один общий ресурс, который уже есть у обоих процессов, — сама
 * база.
 *
 * Поэтому канал — таблица LiveEventOutbox, «хвост» которой api дочитывает раз в
 * секунду. Цена честная: ОДИН короткий индексный запрос в секунду на процесс, и
 * только пока есть хоть один подписчик. Это заметно дешевле того, что
 * заменяется: каждая открытая вкладка сейчас опрашивает десятки роутов каждые
 * 25 секунд.
 *
 * Внутри своего процесса доставка мгновенная: publish() отдаёт событие местным
 * подписчикам сразу после вставки, не дожидаясь обхода. Обход пропускает строки
 * со своим `origin`, поэтому задвоения нет.
 *
 * Когда/если в проекте появится `pg` или Redis — меняется ровно этот файл:
 * наружу торчат только publish()/subscribe().
 */

/** Как часто дочитывать хвост таблицы (только пока есть подписчики). */
const TAIL_POLL_MS = 1_000;
/** Предел выборки за один обход — правило проекта: роут/запрос со списком имеет потолок. */
const TAIL_BATCH = 200;
/** Сколько живут строки транспорта. Это не журнал: журнал переходов — StageEvent. */
const OUTBOX_TTL_MS = 5 * 60_000;
/** Чистка запускается раз в столько публикаций (в ОБОИХ процессах — worker тоже). */
const CLEANUP_EVERY = 200;

/**
 * Больше шести вкладок на человека поток не держит (см. routes/events.ts).
 * Было 3 — поднято 22.09.2026: журнал прода показал, что ВСЕ 429 на
 * /api/v1/events приходились на четвёртое окно ОДНОГО агента (вторая вкладка
 * браузера + телефон +/или CRM, открытая дважды) — то есть лимит бил по
 * живым людям, а не по утечке вкладок, которую он должен ловить.
 */
export const MAX_STREAMS_PER_AGENT = 6;
/**
 * Общий потолок на процесс: поток занимает сокет и память, но не соединение к БД.
 * Было 200 — поднято 22.09.2026 вместе с потолком на агента (тот же разбор
 * прода): подняли на агента, не подняв общий, — и общий потолок стал бы новым
 * местом отказа при том же штате.
 */
export const MAX_STREAMS_TOTAL = 500;

/**
 * Метка процесса. Нужна ровно для одного: не доставить второй раз то, что этот
 * же процесс уже отдал подписчикам сразу после вставки.
 */
const INSTANCE_ID = randomUUID();

/**
 * ФЛАГ. По умолчанию ВКЛЮЧЕНО (и в dev, и в проде) — выключается только явным
 * LIVE_EVENTS=0. Смысл флага в том, чтобы поток можно было погасить одной
 * переменной окружения, не выкатывая код: опрос по таймеру никуда не делся и
 * подхватит всё сам.
 */
export function liveEventsEnabled(): boolean {
  const raw = (process.env.LIVE_EVENTS ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

export interface Subscriber {
  agentId: string;
  role: string;
  /**
   * Точечная надбавка права `messages.view` (находка ночной проверки
   * 24.09.2026, №245/К2-3) — сотрудник смотрит все переписки не по пресету
   * роли (пресет AGENT даёт только `messages.viewOwn`), а по индивидуальной
   * галочке. Считается ОДИН РАЗ при открытии потока (routes/events.ts, из
   * фактических прав req.agent!.can), а не на каждое событие — см.
   * MESSAGES_VIEW_ADDRESSING_MARK ниже.
   */
  seesAllMessages?: boolean;
  /** Отдать событие в сокет. Обязан не бросать: шина не должна падать из-за одного клиента. */
  deliver: (event: LiveEvent) => void;
  /** Закрыть поток со стороны сервера — при остановке процесса (closeAllStreams). */
  close?: () => void;
}

const subscribers = new Set<Subscriber>();
let tailTimer: NodeJS.Timeout | null = null;
let lastSeq = 0;
let publishCount = 0;
let tailRunning = false;

/**
 * Метка адресации для чат-событий (message.new, conversation.updated),
 * которые точечная надбавка messages.view обязана получать сверх обычных
 * ролей (находка 24.09.2026, №245/К2-3, разбор — livePublish.ts, OVERSEER_ROLES).
 *
 * Кладётся в `roles` тех же строк LiveEventOutbox, что и обычные роли: столбец
 * `String[]`, а не enum на уровне БД, так что лишней миграции это не требует, и
 * метка одинаково доезжает что при доставке местным подписчикам, что через
 * обход хвоста таблицы вторым процессом (worker публикует message.new из
 * Telegram-поллера). Ни один Role её не совпадёт — это не роль, а сигнал
 * «прогони проверку seesAllMessages».
 */
export const MESSAGES_VIEW_ADDRESSING_MARK = "PERM:messages.view";

/**
 * Кому событие. Пустые оба списка — широковещательное (то, что и так видно
 * всем: пересчёт снимка пульта). Это НЕ замена проверке прав: событие несёт
 * только идентификаторы, а данные подписчик берёт обычным роутом, где права
 * проверяются как всегда.
 */
function isForSubscriber(row: { agentIds: string[]; roles: string[] }, sub: Subscriber): boolean {
  if (row.agentIds.length === 0 && row.roles.length === 0) return true;
  if (row.agentIds.includes(sub.agentId)) return true;
  if (row.roles.includes(sub.role)) return true;
  if (sub.seesAllMessages && row.roles.includes(MESSAGES_VIEW_ADDRESSING_MARK)) return true;
  return false;
}

function fanOut(event: LiveEvent, addressing: { agentIds: string[]; roles: string[] }): void {
  for (const sub of subscribers) {
    if (!isForSubscriber(addressing, sub)) continue;
    try {
      sub.deliver(event);
    } catch {
      // Сокет уже мёртв — его снимет своя же обработка "close"; шина молчит.
    }
  }
}

/**
 * ДОГНАТЬ ПРОПУЩЕННОЕ ПОСЛЕ ОБРЫВА (пачка B пульта, 23.10.2026).
 *
 * Вкладка переподключается с последним виденным id (Last-Event-ID / query):
 * отдаём события из LiveEventOutbox (живут 5 минут) после этого id, которые
 * адресованы подписчику, — в пределах TAIL_BATCH. Повторы клиент отсеивает по
 * id. Вызывать ПОСЛЕ subscribe(): так событие, пришедшее между выборкой и
 * подпиской, не теряется (в худшем случае приходит дважды). Возвращает число
 * отданных событий; отказ базы не ломает поток — опрос по таймеру остаётся.
 */
export async function replayMissedEvents(sub: Subscriber, afterSeq: number): Promise<number> {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return 0;
  try {
    const rows = await prisma.liveEventOutbox.findMany({
      where: { seq: { gt: afterSeq }, createdAt: { gte: new Date(Date.now() - OUTBOX_TTL_MS) } },
      orderBy: { seq: "asc" },
      take: TAIL_BATCH,
    });
    let sent = 0;
    for (const row of rows) {
      if (!isForSubscriber({ agentIds: row.agentIds, roles: row.roles }, sub)) continue;
      const payload = liveEventPayloadSchema.safeParse(row.payload);
      if (!payload.success) continue;
      sub.deliver({ id: row.seq, type: row.type as LiveEventType, at: row.createdAt.toISOString(), payload: payload.data });
      sent += 1;
    }
    return sent;
  } catch {
    return 0;
  }
}

/** Сколько сейчас потоков всего и у конкретного сотрудника. */
export function streamStats(agentId?: string): { total: number; forAgent: number } {
  let forAgent = 0;
  if (agentId) for (const s of subscribers) if (s.agentId === agentId) forAgent += 1;
  return { total: subscribers.size, forAgent };
}

/**
 * Подписаться на поток. Возвращает функцию отписки.
 *
 * Обход хвоста заводится на ПЕРВОМ подписчике и глохнет на последнем: процесс
 * без открытых вкладок (ночь, worker) не ходит в базу вообще.
 */
export function subscribe(sub: Subscriber): () => void {
  subscribers.add(sub);
  if (subscribers.size === 1) void startTail();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscribers.delete(sub);
    if (subscribers.size === 0) stopTail();
  };
}

/**
 * ЗАКРЫТЬ ВСЕ ПОТОКИ ПРИ ОСТАНОВКЕ (аудит 23.09.2026, круг 3, №76).
 *
 * `server.close()` ждёт, пока закроется каждое открытое соединение, а поток
 * живых событий сам не кончается никогда: пока открыта хоть одна вкладка CRM,
 * мягкая остановка на каждом выкате висела все 15 секунд до жёсткого выхода —
 * это 15 лишних секунд, когда сайт без API, и оборванные на полуслове фоновые
 * задачи (досброс посещений, отключение от базы так и не выполнялись). Вкладка
 * после закрытия сама переподключится к новому процессу — так же, как после
 * обрыва сети.
 */
export function closeAllStreams(): number {
  const all = [...subscribers];
  for (const sub of all) {
    try {
      sub.close?.();
    } catch {
      // Сокет уже мёртв — закрывать нечего.
    }
  }
  return all.length;
}

/**
 * ЗАКРЫТЬ ПОТОКИ ОДНОГО СОТРУДНИКА (находка №148, ночная проверка 24.09.2026).
 *
 * Подписка запоминает роль и право `messages.view` в момент открытия потока и
 * сама их не обновляет. Уволенный продолжал получать «пульс» и события, а
 * пониженный в должности — события прежней роли до перезагрузки вкладки.
 * Зовётся при отключении, заморозке, смене роли и прав: вкладка сама
 * переподключится (получит новый пропуск), а если доступа больше нет — упрётся
 * в отказ входа. Возвращает число закрытых потоков.
 */
export function closeStreamsForAgent(agentId: string): number {
  const mine = [...subscribers].filter((sub) => sub.agentId === agentId);
  for (const sub of mine) {
    try {
      sub.close?.();
    } catch {
      // Сокет уже мёртв — закрывать нечего.
    }
  }
  return mine.length;
}

async function startTail(): Promise<void> {
  if (tailTimer) return;
  // Начинаем с текущего конца таблицы: подписчик не должен получить историю за
  // последние пять минут одним залпом — он только что загрузил свежие данные.
  try {
    const newest = await prisma.liveEventOutbox.findFirst({ orderBy: { seq: "desc" }, select: { seq: true } });
    lastSeq = newest?.seq ?? 0;
  } catch {
    lastSeq = 0;
  }
  if (subscribers.size === 0) return; // пока читали, последний отписался
  // Уборка на старте обхода, а не только раз в CLEANUP_EVERY публикаций: при
  // редких событиях счётчик доходит до порога месяцами, а первый подписчик
  // приходит каждое утро.
  void cleanup();
  tailTimer = setInterval(() => void pollTail(), TAIL_POLL_MS);
  // unref: незавершённый интервал не должен держать процесс при остановке.
  tailTimer.unref?.();
}

function stopTail(): void {
  if (!tailTimer) return;
  clearInterval(tailTimer);
  tailTimer = null;
}

/** Дочитать хвост. Один обход за раз: медленная база не должна копить параллельные запросы. */
async function pollTail(): Promise<void> {
  // При остановке пул закрывается раньше, чем гаснут открытые SSE-соединения
  // (grace period в index.ts) — обход не имеет смысла начинать заново.
  if (tailRunning || subscribers.size === 0 || isShuttingDown()) return;
  tailRunning = true;
  try {
    const rows = await prisma.liveEventOutbox.findMany({
      where: { seq: { gt: lastSeq } },
      orderBy: { seq: "asc" },
      take: TAIL_BATCH,
    });
    let foreign = false;
    for (const row of rows) {
      lastSeq = row.seq;
      // Своё уже отдано в publish() — иначе подписчик получил бы событие дважды.
      if (row.origin === INSTANCE_ID) continue;
      // Событие второго процесса (worker: бот, ролики, фоновые ошибки) сбросило
      // кэш пульта только у себя — здесь его надо сбросить до раздачи, иначе
      // перезапрос вкладки получит снимок до события.
      if (!foreign) { foreign = true; dropMissionControlSections("all"); }
      const payload = liveEventPayloadSchema.safeParse(row.payload);
      if (!payload.success) continue;
      fanOut(
        { id: row.seq, type: row.type as LiveEventType, at: row.createdAt.toISOString(), payload: payload.data },
        { agentIds: row.agentIds, roles: row.roles }
      );
    }
  } catch (err) {
    // Обход не имеет права уронить процесс: поток — удобство, опрос по таймеру
    // на фронте остаётся запасным путём и покажет те же данные.
    void logSystemError("api", `Обход хвоста живых событий: ${err instanceof Error ? err.message : String(err)}`, { quietPult: true });
  } finally {
    tailRunning = false;
  }
}

/** Снести протухшие строки транспорта. Молча: это уборка, а не операция пользователя. */
async function cleanup(): Promise<void> {
  if (isShuttingDown()) return; // при остановке следующая публикация всё равно не случится
  try {
    await prisma.liveEventOutbox.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - OUTBOX_TTL_MS) } } });
  } catch {
    /* уборка не обязана получиться с первого раза — повторится через CLEANUP_EVERY публикаций */
  }
}

/**
 * Опубликовать событие. Зовётся ПОСЛЕ успешного коммита: событие, пережившее
 * откат, отправило бы браузер за данными, которых нет.
 *
 * Вызывающему ждать нечего — `void publish(...)`. Отказ базы гасится внутри:
 * ни одна бизнес-операция не должна упасть из-за того, что не доехало
 * уведомление об обновлении.
 */
export function publish(input: LiveEventInput): Promise<void> {
  // Регистрируем ПРОМИС ЦЕЛИКОМ, а не отдельные шаги внутри: shutdown() зовёт
  // `drainBackgroundTasks()` до `prisma.$disconnect()`, и большинство публикаций,
  // начатых до сигнала остановки, успевают честно доехать до базы вместо гонки
  // с закрытием пула (см. shutdownState.ts).
  return trackBackgroundTask(publishImpl(input));
}

async function publishImpl(input: LiveEventInput): Promise<void> {
  if (!liveEventsEnabled()) return;

  // Схема закрытая (strict): случайно переданный объект клиента с телефоном
  // будет отвергнут здесь, а не уедет в браузер. Отвергнут, а не обрезан —
  // молчаливое обрезание спрятало бы ошибку вызывающего.
  const payload = liveEventPayloadSchema.safeParse(input.payload ?? {});
  if (!payload.success) {
    void logSystemError("api", `Живое событие ${input.type}: недопустимая нагрузка (${payload.error.message})`, { quietPult: true });
    return;
  }

  const agentIds = [...new Set((input.agentIds ?? []).filter((id) => typeof id === "string" && id.length > 0))];
  const roles = [...new Set((input.roles ?? []).filter((r) => typeof r === "string" && r.length > 0))];

  try {
    const row = await prisma.liveEventOutbox.create({
      data: { type: input.type, payload: payload.data, agentIds, roles, origin: INSTANCE_ID },
      select: { seq: true, createdAt: true },
    });
    // Местным подписчикам — сразу, без ожидания обхода: задержка внутри процесса
    // получается равной одной вставке, а не секунде.
    fanOut(
      { id: row.seq, type: input.type, at: row.createdAt.toISOString(), payload: payload.data },
      { agentIds, roles }
    );
  } catch (err) {
    // Прод 16.09 20:19: «Cannot use a pool after calling end on the pool» — гонка
    // остановки, не баг интеграции. `guardBackgroundFailure` печатает ОДНУ
    // info-строку и выходит; иначе — обычный путь через logSystemError.
    if (guardBackgroundFailure(`публикация живого события ${input.type}`, err)) return;
    void logSystemError("api", `Публикация живого события ${input.type}: ${err instanceof Error ? err.message : String(err)}`, { quietPult: true });
    return;
  }

  publishCount += 1;
  if (publishCount % CLEANUP_EVERY === 0) void cleanup();
}

/** Только для тестов: сбросить состояние шины между сценариями. */
export function __resetEventBusForTests(): void {
  subscribers.clear();
  stopTail();
  lastSeq = 0;
  publishCount = 0;
}

/** Только для тестов: метка этого процесса (проверка «свои строки не задваиваются»). */
export const __INSTANCE_ID = INSTANCE_ID;
