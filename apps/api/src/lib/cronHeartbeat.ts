import { isPrivateCron, withCronPrivacy } from "./investigationOperations.js";
import { AsyncLocalStorage } from "node:async_hooks";
import cron from "node-cron";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { isPultModuleEnabled } from "./pultModules.js";
import { isShuttingDown, trackBackgroundTask } from "./shutdownState.js";
import type { PultModuleId } from "@royal-home/shared";
import { API_PROCESS_TICKS } from "./apiProcessTicks.js";

/**
 * ПУЛЬС КРОН-ТИКОВ (26.08.2026, архитектурное ревью, пункт 9).
 *
 * 43 тика — 43 способа молча потерять «переназначение протухших лидов» или
 * утреннюю сводку: тик, который перестал запускаться, не пишет ничего никуда,
 * и узнаётся это от владельца через неделю. scheduleTracked — та же сигнатура,
 * что у cron.schedule (плюс имя первым аргументом), поэтому замена механическая.
 *
 * Пульс — best-effort: запись в базу не имеет права уронить или задержать сам
 * тик (у каждого тика свой try/catch, обёртка ничего в нём не меняет). Смерть
 * ВСЕГО процесса ловит внешний сторож (ops/health-watch.sh по /api/v1/health/deep) —
 * здесь ловится смерть ОТДЕЛЬНОЙ задачи внутри живого процесса: снятый с
 * расписания тик, вечно висящий await, ошибка на каждом запуске.
 */

type TickFn = () => void | Promise<void>;

/**
 * СБОЙ ВНУТРИ ТИКА ВИДЕН, А НЕ ТОЛЬКО В КОНСОЛИ (аудит 23.09.2026, №64).
 *
 * У каждого тика свой try/catch (так и задумано: сбой одной задачи не отменяет
 * соседнюю), но 80 из 87 таких catch только печатали в консоль контейнера. Для
 * обёртки ниже тик завершался успешно: пульс писал lastOkAt, в журнале ошибок
 * пусто, «Здоровье системы» зелёное — и сломанная задача молчала неделями.
 *
 * Тик выполняется внутри tickContext, поэтому помощники ниже знают, ЧЕЙ это
 * сбой, без лишнего аргумента в сотне мест: отметка ложится в lastError этого
 * тика, а lastOkAt не двигается.
 */
const tickContext = new AsyncLocalStorage<{ name: string; failure: string | null }>();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Сбой в тике, который сам уже пишет в журнал своим источником: только отметка тика и консоль. */
export function markCronTickFailed(label: string, err: unknown): string {
  const reason = errorText(err);
  console.error(`[cron] ${label}:`, reason);
  const tick = tickContext.getStore();
  if (tick) tick.failure = `${label}: ${reason}`.slice(0, 500);
  return reason;
}

/** Сбой в тике: отметка тика, консоль и журнал ошибок (источник «cron»). */
export function reportCronTickError(label: string, err: unknown): void {
  const reason = markCronTickFailed(label, err);
  const tick = tickContext.getStore();
  void logSystemError("cron", `${tick ? `Крон «${tick.name}»` : "Крон"}: ${label} — ${reason}`, {
    stack: err instanceof Error ? err.stack : undefined,
  }).catch(() => {});
}

/**
 * СБОЙ ОДНОЙ СТРОКИ НЕ РОНЯЕТ ВЕСЬ ТИК (№173 ночной проверки 24.09).
 *
 * Тик проходит список (лиды, показы, объекты) одним циклом. Без `try` на строку
 * одна «плохая» запись — битые данные, гонка, отказ базы на одном update —
 * обрывала цикл, и все строки после неё в этот тик не обрабатывались; на
 * следующем тике та же запись снова шла первой и снова обрывала всё.
 * Вызывается из `catch` вокруг тела цикла: отметка тика (lastError), консоль и
 * журнал ошибок. Дедуп по метке, а не по тексту: одна и та же поломка на сотне
 * строк — одна запись в журнале на окно, номер строки — в тексте.
 */
export function reportCronRowError(label: string, rowRef: string | number | null | undefined, err: unknown): void {
  const reason = markCronTickFailed(`${label} (${rowRef ?? "?"})`, err);
  const tick = tickContext.getStore();
  void logSystemError("cron", `${tick ? `Крон «${tick.name}»` : "Крон"}: ${label} — ${reason} (запись ${rowRef ?? "?"})`, {
    stack: err instanceof Error ? err.stack : undefined,
    dedupKey: `cron-row:${tick?.name ?? "-"}:${label}`,
  }).catch(() => {});
}

/** Что сторож знает о каждом тике: интервал считается из cron-выражения. */
const registry = new Map<
  string,
  { expr: string; intervalMs: number; lowFrequency: boolean; timezone?: string }
>();

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Ожидаемый интервал по cron-выражению. Точная календарная математика тут не
 * нужна — сторожу хватает порядка величины, чтобы отличить «молчит два тика»
 * от нормальной паузы. Незнакомая форма считается суточной: лучше редкий и
 * поздний алерт, чем ложный каждые полчаса.
 *
 * Для недельных/месячных тиков (`isLowFrequency` ниже) это значение больше НЕ
 * участвует в решении о тревоге — там считается честная дата следующего
 * запуска (`nextCronRun`). Тут оно остаётся только для таймаута самого тика
 * (`scheduleTracked`, всегда упирается в `MAX_TICK_TIMEOUT_MS`) и старых
 * тестов, поэтому грубость (неделя что для еженедельных, что для месячных)
 * дальше не искажает поведение.
 */
export function cronIntervalMs(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  const [min = "*", hour = "*", dom = "*", , dow = "*"] = fields.length === 6 ? fields.slice(1) : fields;
  const step = (field: string) => {
    const m = /^\*\/(\d+)$/.exec(field);
    return m ? Number(m[1]) : null;
  };
  if (fields.length === 6 && fields.slice(1).every(field => field === "*")) {
    return fields[0] === "*" ? 1000 : (step(fields[0]) ?? 60) * 1000;
  }
  if (step(min)) return step(min)! * MINUTE; // */N * * * *
  if (min === "*") return MINUTE; // * * * * *
  if (hour === "*") return HOUR; // M * * * *  (раз в час)
  if (step(hour)) return step(hour)! * HOUR; // M */N * * *
  if (dom !== "*" || dow !== "*") return 7 * DAY; // недельные/месячные — только для таймаута, см. комментарий выше
  return DAY; // M H * * *  (раз в сутки)
}

/** День месяца и/или день недели заданы явно — расписание реже суточного. */
function isLowFrequency(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  const [, , dom = "*", , dow = "*"] = fields.length === 6 ? fields.slice(1) : fields;
  return dom !== "*" || dow !== "*";
}

/**
 * Разница между часовым поясом `timeZone` и UTC (в минутах) для конкретного
 * момента времени — через Intl, без сторонней библиотеки. Единственные пояса
 * в этом проекте: без `timezone` (контейнер живёт в UTC) и «Asia/Dushanbe»
 * (фиксированные +5, без перехода на летнее время). Пересчёт на каждый вызов
 * (а не константа) не ломается, даже если появится пояс с DST.
 */
function timezoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / MINUTE);
}

/**
 * Честный следующий запуск по cron-выражению СТРОГО ПОСЛЕ `after` (не «после
 * сейчас», как `node-cron`'s `getNextRun()` — сторожу нужна дата, ожидавшаяся
 * после ПРОШЛОГО пульса, чтобы отличить «ещё не подошёл срок» от «пропустил»).
 * Числовые множества полей берём из `node-cron` (`cron.parse`, публичный API:
 * учитывает списки, диапазоны, шаг) — свой велосипед только для перебора дат.
 * День месяца и день недели: если оба заданы явно — тик по OR (как в POSIX
 * cron), в этом репозитории такого нет, но так честнее.
 */
export function nextCronRun(expr: string, after: Date, timeZone?: string): Date {
  const expressionFields = expr.trim().split(/\s+/);
  const [, , dom = "*", , dow = "*"] = expressionFields.length === 6 ? expressionFields.slice(1) : expressionFields;
  const domStar = dom === "*";
  const dowStar = dow === "*";
  const fields = cron.parse(expr);
  const offsetMin = timeZone ? timezoneOffsetMinutes(after, timeZone) : 0;
  // Работаем в «настенном времени» пояса: сдвигаем момент на offset и читаем
  // поля через getUTC* — так переполнение дня/месяца нормализует сам Date.
  let local = new Date(after.getTime() + offsetMin * MINUTE);
  local = new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds() + 1,
      0
    )
  );
  const MAX_STEPS = 200_000; // с запасом на любое реальное расписание (даже редкий шаг не зациклится)
  for (let i = 0; i < MAX_STEPS; i++) {
    const y = local.getUTCFullYear();
    const mo = local.getUTCMonth();
    const d = local.getUTCDate();
    const h = local.getUTCHours();
    const mi = local.getUTCMinutes();
    const dowValue = local.getUTCDay();
    if (!fields.month.includes(mo + 1)) {
      local = new Date(Date.UTC(y, mo + 1, 1, 0, 0, 0, 0));
      continue;
    }
    const domOk = domStar || fields.dayOfMonth.includes(d);
    const dowOk = dowStar || fields.dayOfWeek.includes(dowValue);
    const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk;
    if (!dayOk) {
      local = new Date(Date.UTC(y, mo, d + 1, 0, 0, 0, 0));
      continue;
    }
    if (!fields.hour.includes(h)) {
      local = new Date(Date.UTC(y, mo, d, h + 1, 0, 0, 0));
      continue;
    }
    if (!fields.minute.includes(mi)) {
      local = new Date(Date.UTC(y, mo, d, h, mi + 1, 0, 0));
      continue;
    }
    const second = fields.second.find(value => value >= local.getUTCSeconds());
    if (second == null) {
      local = new Date(Date.UTC(y, mo, d, h, mi + 1, 0, 0));
      continue;
    }
    local.setUTCSeconds(second, 0);
    return new Date(local.getTime() - offsetMin * MINUTE);
  }
  throw new Error(`nextCronRun: не удалось найти следующий запуск для "${expr}"`);
}

type BeatData = {
  lastRunAt?: Date;
  lastOkAt?: Date;
  lastError?: string | null;
  lastSkippedAt?: Date;
  lastSkipReason?: string | null;
};

function beat(name: string, data: BeatData): void {
  if (isShuttingDown()) return; // при остановке процесс всё равно завершится — писать некуда
  const expr = registry.get(name)?.expr ?? "";
  trackBackgroundTask(
    prisma.cronHeartbeat
      .upsert({
        where: { name },
        update: { ...data, expr },
        create: { name, expr, ...data },
      })
      .catch(() => {
        // База лежит — тик всё равно обязан отработать; её смерть видна и без пульса.
      })
  );
}

/**
 * cron.schedule с пульсом. Имя — стабильное, латиницей: оно же ключ в базе и
 * текст алерта директору.
 */
/**
 * ИДУЩИЕ ТИКИ — ДЛЯ МЯГКОЙ ОСТАНОВКИ (№172 ночной проверки 24.09).
 *
 * Выкат перезапускает процессы посреди тика: робозвонок набран, просьба
 * подтвердить показ ушла — а отметка ещё не записана, и после рестарта то же
 * самое уходило клиенту второй раз. Остановка (index.ts, worker.ts) теперь ждёт,
 * пока `activeTickCount()` не станет нулём, — с тем же потолком, что и задания
 * очереди. Тик, снятый по таймауту, перестаёт считаться сразу: его промис висит
 * вечно, и ждать его — значит каждый выкат стоять весь потолок впустую.
 *
 * `stopNewTicks()` — после сигнала остановки новые срабатывания не начинаются:
 * ждать имеет смысл только то, что уже идёт.
 */
let activeTicks = 0;
let newTicksStopped = false;

export function activeTickCount(): number {
  return activeTicks;
}

export function stopNewTicks(): void {
  newTicksStopped = true;
}

/** Максимальный таймаут тика вне зависимости от интервала — 20 минут. */
const MAX_TICK_TIMEOUT_MS = 20 * MINUTE;

export interface ScheduleTrackedOptions {
  /**
   * Таймаут одного тика. По умолчанию 2×интервал расписания (но не больше
   * MAX_TICK_TIMEOUT_MS) — инцидент 09.09: 5 тиков зависли на await, замок
   * `running` держался 75+ минут, следующие срабатывания молча терялись.
   * Зависший промис в Node НЕЛЬЗЯ отменить — таймаут не убивает его, только
   * перестаёт ждать результат и снимает замок, чтобы расписание не встало.
   */
  timeoutMs?: number;
}

export function scheduleTracked(
  name: string,
  expr: string,
  fn: TickFn,
  options?: Parameters<typeof cron.schedule>[2],
  /** Модуль пульта: выключен — тик пропускается целиком, с отметкой в пульсе. */
  tracked?: { module: PultModuleId },
  trackedOptions?: ScheduleTrackedOptions
): ReturnType<typeof cron.schedule> {
  if (registry.has(name)) {
    // Дубль имени — ошибка программиста: пульс двух тиков в одной строке
    // неотличим от здорового, и сторож ослепнет молча.
    throw new Error(`scheduleTracked: имя "${name}" уже занято`);
  }
  const intervalMs = cronIntervalMs(expr);
  registry.set(name, { expr, intervalMs, lowFrequency: isLowFrequency(expr), timezone: options?.timezone });
  const timeoutMs = Math.min(trackedOptions?.timeoutMs ?? intervalMs * 2, MAX_TICK_TIMEOUT_MS);
  /**
   * Гвард наложения ВСТРОЕН в обёртку — и это часть честности пульса (аудит №4).
   * Пока прошлый запуск не завершился, новые срабатывания пропускаются ЦЕЛИКОМ,
   * без ударов пульса: повисший на await тик перестаёт обновлять lastRunAt, и
   * сторож поднимает тревогу по обычному правилу молчания. Раньше гварды жили
   * внутри самих тиков НИЖЕ удара пульса — зависший тик выглядел идеально
   * здоровым (каждое срабатывание било и lastRunAt, и — мгновенным выходом по
   * гварду — lastOkAt). Свои гварды у тиков остаются, они безвредны.
   */
  let running = false;
  const run = async (): Promise<void> => {
    if (running || newTicksStopped) return;
    running = true;
    const startedAt = Date.now();
    console.log(`[cron] ${name}: старт`);
    // Зависший тик не отменяем (Node не умеет прервать произвольный await) —
    // просто перестаём его ждать и снимаем замок, чтобы расписание не встало
    // (инцидент 09.09: без этого таймаута ticker молчал 75+ минут).
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      // Флаг читается из базы на каждом тике (кэш 15 с): worker-процесс не видит
      // переключений в api-процессе иначе как через базу.
      if (tracked && !(await isPultModuleEnabled(tracked.module))) {
        beat(name, { lastSkippedAt: new Date(), lastSkipReason: `module:${tracked.module}:off` });
        return;
      }
      beat(name, { lastRunAt: new Date(), lastSkipReason: null });
      const tick = { name, failure: null as string | null };
      // Счёт идущих тиков (см. activeTickCount): снимается ровно один раз —
      // когда тик дошёл (успехом или ошибкой) или когда его сняли по таймауту.
      let counted = true;
      const uncount = () => {
        if (!counted) return;
        counted = false;
        activeTicks--;
      };
      activeTicks++;
      const work = tickContext.run(tick, () => withCronPrivacy(name, () => Promise.resolve().then(fn)));
      work.then(uncount, uncount);
      const result = await Promise.race([work.then(() => "done" as const), timeout]);
      if (result === "timeout") {
        uncount();
        timedOut = true;
        const minutes = Math.round(timeoutMs / MINUTE);
        const message = `Крон «${name}» не завершил тик за ${minutes} мин — снят с замка`;
        beat(name, { lastError: message });
        await logSystemError(isPrivateCron(name) ? "investigation" : "cron", message).catch(() => {});
        console.error(`[cron:${name}] ${message}`);
        // Замок снимается ниже, в finally — следующий тик пойдёт по расписанию.
        // Сам зависший промис fn() продолжает висеть в фоне: его результат
        // (и любые ошибки из него) просто игнорируются дальше.
        return;
      }
      if (tick.failure) beat(name, { lastError: tick.failure });
      else beat(name, { lastOkAt: new Date(), lastError: null });
    } catch (err) {
      // Сюда попадает только тик БЕЗ своего try/catch — таких нет, но обёртка
      // обязана быть последним рубежом, а не местом, где ошибка меняет маршрут.
      beat(name, { lastError: errorText(err).slice(0, 500) });
      console.error(`[cron:${name}]`, errorText(err));
      await logSystemError(isPrivateCron(name) ? "investigation" : "cron", `Крон «${name}» упал: ${errorText(err)}`).catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
      running = false;
      const durationMs = Date.now() - startedAt;
      console.log(`[cron] ${name}: конец за ${durationMs} мс${timedOut ? " (таймаут)" : ""}`);
    }
  };
  runners.set(name, run);
  return cron.schedule(expr, () => run(), options);
}

/** Запуск тика вне расписания — тем же путём, с пульсом и замком (для догона). */
const runners = new Map<string, () => Promise<void>>();

/**
 * Насколько поздно ещё имеет смысл догнать пропущенный запуск. Выкат держит
 * процесс лежащим минуту-другую; утренний отчёт, пришедший к обеду, уже не
 * утренний — такой пропуск остаётся сторожу пульса.
 */
const CATCH_UP_WINDOW_MS = 3 * HOUR;

/**
 * ДОГОН СУТОЧНЫХ ТИКОВ, ПРОПУЩЕННЫХ РЕСТАРТОМ (E7 / Ф8 глубокой проверки
 * 02.10.2026).
 *
 * node-cron пропущенное не догоняет. Выкатов — два десятка в день, worker при
 * каждом лежит от полуминуты до полутора (мягкая остановка, миграции, старт).
 * Выкат в 00:04:30 — и KPI за вчера не посчитан, рейтинг стоит на позавчерашнем;
 * в 07:59 — утреннего отчёта нет. Частый тик это переживает (следующий придёт
 * через минуты), суточный теряет день, а сторож пульса для него поднимет
 * тревогу только через двое суток.
 *
 * Вызывается после старта процесса (worker.ts). Для суточных и более редких
 * тиков: строка пульса есть, следующий после неё срок по расписанию уже прошёл,
 * и прошёл недавно (CATCH_UP_WINDOW_MS) — тик запускается сейчас, по одному, тем
 * же путём, что и по расписанию. Тик без строки пульса (новый) вслепую не
 * запускается. Тик, оборванный рестартом посередине, уже отметил lastRunAt и
 * повторно не запускается: полузавершённую работу повторять опаснее, чем
 * пропустить.
 *
 * Возвращает имена запущенных тиков.
 */
export async function catchUpMissedTicks(now: Date = new Date()): Promise<string[]> {
  const daily = [...registry].filter(([name, meta]) => meta.intervalMs >= DAY && runners.has(name));
  if (daily.length === 0) return [];
  const rows = await prisma.cronHeartbeat.findMany({ where: { name: { in: daily.map(([name]) => name) } } });
  const byName = new Map(rows.map((r) => [r.name, r]));
  const missed: string[] = [];
  for (const [name, meta] of daily) {
    const row = byName.get(name);
    const lastSeen = Math.max(row?.lastRunAt?.getTime() ?? 0, row?.lastSkippedAt?.getTime() ?? 0);
    if (!lastSeen) continue;
    const due = nextCronRun(meta.expr, new Date(lastSeen), meta.timezone).getTime();
    if (due > now.getTime() || now.getTime() - due > CATCH_UP_WINDOW_MS) continue;
    missed.push(name);
  }
  for (const name of missed) {
    console.warn(`[cron] ${name}: запуск по расписанию пропущен рестартом — догоняем`);
    await runners.get(name)!();
  }
  return missed;
}

/** Молчание дольше двух интервалов (плюс люфт на занятый event loop) — тревога. */
const SILENCE_FACTOR = 2;
const SLACK_MS = 5 * MINUTE;
/** Повторная тревога по тому же молчанию — не чаще раза в 6 часов. */
const REALERT_MS = 6 * HOUR;

/**
 * Сторожевой проход: кто из зарегистрированных тиков молчит дольше положенного.
 * Вызывается своим тиком из cron.ts (тоже через scheduleTracked — сторож,
 * который молчит сам, увидит внешний мониторинг по отсутствию алертов… шутка:
 * его пульс виден в той же таблице).
 *
 * Первый запуск после деплоя: строк в базе ещё нет — тик, который ни разу не
 * запускался, начинает отсчёт от старта процесса, а не алертит сразу.
 */
const processStartedAt = new Date();

/**
 * Что сторож ждёт: свой реестр плюс тики процесса api (№171 ночной проверки
 * 24.09). Сторож живёт в worker, а live-calls-sweep и робозвонки — в api; их
 * пульс лежит в той же таблице, только реестр не тот. Когда процесс один
 * (ENABLE_BACKGROUND не выключен), тики api уже в своём реестре — с его
 * часовым поясом, второй раз не добавляются.
 */
function expectedTicks(): Map<string, { expr: string; intervalMs: number; lowFrequency: boolean; timezone?: string }> {
  const expected = new Map(registry);
  for (const [name, expr] of Object.entries(API_PROCESS_TICKS)) {
    if (expected.has(name)) continue;
    expected.set(name, { expr, intervalMs: cronIntervalMs(expr), lowFrequency: isLowFrequency(expr) });
  }
  return expected;
}

export async function checkCronHeartbeats(): Promise<number> {
  const expected = expectedTicks();
  const rows = await prisma.cronHeartbeat.findMany({
    where: { name: { in: [...expected.keys()] } },
  });
  const byName = new Map(rows.map((r) => [r.name, r]));
  const now = Date.now();
  let alerts = 0;
  for (const [name, meta] of expected) {
    const row = byName.get(name);
    // Пропуск из-за выключенного модуля — тоже признак жизни тика, а не молчание.
    const lastSeen =
      Math.max(row?.lastRunAt?.getTime() ?? 0, row?.lastSkippedAt?.getTime() ?? 0) || processStartedAt.getTime();
    // Недельные/месячные тики (26.08 → 17.09 баг): «молчит дольше 2×интервала»
    // для них считало интервал неделей ДАЖЕ для месячных — тик, который ждёт
    // 1-го числа, «молчал» 3 недели и будил директора ложной тревогой каждое
    // утро. Честно: следующий ожидаемый запуск по самому cron-выражению
    // (после последнего пульса), а не грубый множитель интервала.
    const expectedNextRun = nextCronRun(meta.expr, new Date(lastSeen), meta.timezone);
    const limit = meta.lowFrequency
      ? expectedNextRun.getTime() + SLACK_MS
      : lastSeen + meta.intervalMs * SILENCE_FACTOR + SLACK_MS;
    if (now <= limit) continue;
    const alertedAt = row?.alertedAt?.getTime() ?? 0;
    // Уже поднимали тревогу по ЭТОМУ молчанию и недавно — не спамим.
    if (alertedAt > lastSeen && now - alertedAt < REALERT_MS) continue;
    alerts++;
    const silentMin = Math.round((now - lastSeen) / MINUTE);
    await logSystemError(
      isPrivateCron(name) ? "investigation" : "cron",
      `Крон-тик «${name}» молчит ${silentMin} мин (расписание ${meta.expr}, ` +
        `следующий ожидался: ${expectedNextRun.toISOString()}; последний запуск: ` +
        `${row?.lastRunAt?.toISOString() ?? "ни разу с этого деплоя"}` +
        (row?.lastError ? `; последняя ошибка: ${row.lastError}` : "") +
        ")"
    );
    await prisma.cronHeartbeat
      .updateMany({ where: { name }, data: { alertedAt: new Date() } })
      .catch(() => {});
  }
  return alerts;
}
