import { hostname } from "node:os";
import { Prisma, type BackgroundJob } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { jobHandlerOf } from "./registry.js";
import { pultModuleOfJob } from "./jobModules.js";
import { isPultModuleEnabled } from "../lib/pultModules.js";
import { notifyStuckWorkGivenUp } from "../lib/stuckWork.js";
// Регистрация всех обработчиков — побочным эффектом импорта (см. handlers.ts).
import "./handlers.js";

/**
 * ЦИКЛ ИСПОЛНЕНИЯ ОЧЕРЕДИ (чертёж §2.2). Живёт в worker-процессе, тик — из
 * cron.ts через scheduleTracked («background-jobs», раз в минуту: точность
 * «в пределах минуты» покрывает всех семерых потребителей §2.3, а секунды
 * им не обещаны).
 *
 * Захват — атомарный условный UPDATE c FOR UPDATE SKIP LOCKED: сегодня воркер
 * один и это избыточно, но захват корректен при наложении тиков и бесплатно
 * готов ко второму воркеру.
 */

const BATCH_SIZE = 10;
/** Interactive work keeps its durable DB queue, but never waits behind media.
 * One slot per lane also prevents a long model turn from blocking delivery. */
export const CUSTOMER_JOB_LANES = {
  inbox: "customer-inbox-consume",
  outbox: "customer-outbox-dispatch",
  intake: "customer-contact-intake",
} as const;
type CustomerJobLane = keyof typeof CUSTOMER_JOB_LANES;
const customerBusy: Record<CustomerJobLane, boolean> = { inbox: false, outbox: false, intake: false };
const CUSTOMER_JOB_TYPES = Object.values(CUSTOMER_JOB_LANES);
/**
 * ТЯЖЁЛЫЕ ТИПЫ — В ХВОСТ ПАРТИИ (аудит №4, 27.08).
 *
 * Партия исполняется последовательно, и ffmpeg-джоб (сжатие сырого ролика)
 * живёт минуты. Если он оказывался в партии ПЕРЕД ответом клиенту, быстрая
 * фаза ai-reply-retry (обещанные 30 секунд) превращалась в полчаса: человек,
 * попавший на сбой ИИ, ждал ответ втрое дольше, чем задумано. Клиентские
 * задания идут первыми, ffmpeg — последним; за один тик берём не больше одного
 * тяжёлого, чтобы остальные не копили очередь за собой.
 */
const HEAVY_TYPES = [
  "clip-compress",
  "video-handoff-publish",
  "photo-post-publish",
  "social-repost-publish",
  // Свободный ролик в соцсети (12.10.2026): шесть каналов подряд, минуты — лёгким заданием
  // он держал бы тики очереди перед ответами клиентам.
  "social-video-publish",
  // Повторная расшифровка (E6 глубокой проверки 02.10.2026): скачивание записи
  // до 2 минут и Gemini до 3 минут на кусок. Лёгким заданием она снималась с
  // ожидания через 60 с, жгла попытку и продолжалась оторванной, а партия из
  // десяти шла параллельно и упиралась в лимит общего ключа. Тяжёлая — одна
  // за тик, то есть расшифровки из очереди идут по одной.
  "transcription-retry",
];
const MAX_HEAVY_PER_TICK = 1;
/**
 * ТАЙМАУТ НА ОДНО ЗАДАНИЕ (22.09.2026, разбор ежедневного «не завершил тик»
 * у cron "background-jobs"). Партия исполняется ПОСЛЕДОВАТЕЛЬНО (см. цикл в
 * runBackgroundJobsTick), и один зависший обработчик (внешний вызов без
 * собственного таймаута, забытый await) держал весь тик до сторожевого
 * MAX_TICK_TIMEOUT_MS — а остальные BATCH_SIZE-1 заданий партии ждали своей
 * очереди молча, без единой попытки. Promise.race не отменяет сам промис
 * обработчика (Node этого не умеет, тот же приём, что у scheduleTracked) —
 * только перестаёт его ждать здесь; задание уходит по обычной лестнице
 * ретраев (PENDING + backoff, см. runOne) так же, как при обычной ошибке.
 * Тяжёлые типы (ffmpeg) получают запас на порядок больше лёгких.
 */
const LIGHT_JOB_TIMEOUT_MS = 60_000;
const HEAVY_JOB_TIMEOUT_MS = 8 * 60_000;
/** Срок одной попытки задания: свой у обработчика, иначе по тяжести типа. */
export function effectiveJobTimeoutMs(type: string): number {
  return jobHandlerOf(type)?.timeoutMs ?? (HEAVY_TYPES.includes(type) ? HEAVY_JOB_TIMEOUT_MS : LIGHT_JOB_TIMEOUT_MS);
}

/** RUNNING старше этого срока — воркер умер между run и DONE; подбираем. */
const STUCK_RUNNING_MIN = 15;
/** DONE хранится неделю — бесплатный журнал «что делала система», потом чистим. */
const KEEP_DONE_DAYS = 7;
/** Джоб из будущей версии кода (после отката) — не ронять, отложить. */
const UNKNOWN_TYPE_DELAY_MS = 10 * 60_000;

export async function claimBatch(): Promise<BackgroundJob[]> {
  // Подбор зависшего RUNNING СЧИТАЕТСЯ попыткой (аудит №4): джоб, роняющий сам
  // процесс (OOM на ffmpeg), не доходит до catch и раньше ретраился вечно —
  // каждые 15 минут новый захват, maxAttempts не наступал никогда. Теперь такой
  // захват доращивает attempts, и runOne отправит перебравшего в GIVEN_UP.
  //
  // dedupeKey ЖИВЁТ ДО КОНЦА ЛЕСТНИЦЫ ПОПЫТОК (13.09.2026, задание docs/TASKS.md
  // строка 273), а не снимается на первом захвате. Раньше ключ обнулялся здесь
  // же, при переходе в RUNNING — и у заданий с долгой лестницей (ai-reply-retry:
  // до 46 попыток и ~13 часов, перепланируется через PENDING на каждый бэкофф)
  // ключ оказывался свободен уже после первого захвата. Крон здоровья ставит
  // "ai-reply-retry:{id}" каждые 30 минут — и находил ключ свободным на каждом
  // тике, набирая по диалогу больше десяти живых заданий одновременно.
  // Теперь снятие ключа — дело runOne, и только при финальном статусе (DONE,
  // GIVEN_UP, SKIPPED): см. комментарии там. Промежуточный RUNNING/PENDING
  // (в т.ч. подбор зависшего и бэкофф-реланч) ключ не трогает вовсе.
  //
  // ТЯЖЁЛЫЕ И ЛЁГКИЕ ЗАХВАТЫВАЮТСЯ РАЗДЕЛЬНО (E9 глубокой проверки 02.10.2026).
  // Раньше партия — 10 самых старых по runAt без различия типа. Пачка из 15
  // роликов объекта давала 10 тяжёлых в каждом захвате: выполнялось одно,
  // девять возвращались с тем же runAt и в следующем захвате снова были
  // первыми, а лёгкие со свежим runAt (повтор ответа клиенту, отложенный пуш,
  // поиск записи) в партию не попадали, пока не кончатся ролики. Теперь в
  // партии не больше MAX_HEAVY_PER_TICK тяжёлых, остальные места — лёгким.
  const due = Prisma.sql`((status = 'PENDING' AND "runAt" <= now())
         OR (status = 'RUNNING' AND "lockedAt" < now() - make_interval(mins => ${STUCK_RUNNING_MIN}::int)))`;
  const claimed = await prisma.$queryRaw<BackgroundJob[]>`
    WITH heavy AS (
      SELECT id FROM "BackgroundJob"
      WHERE ${due} AND type = ANY(${HEAVY_TYPES}::text[])
      ORDER BY "runAt"
      LIMIT ${MAX_HEAVY_PER_TICK}
      FOR UPDATE SKIP LOCKED
    ), light AS (
      SELECT id FROM "BackgroundJob"
      WHERE ${due} AND NOT (type = ANY(${HEAVY_TYPES}::text[]))
        AND NOT (type = ANY(${CUSTOMER_JOB_TYPES}::text[]))
      ORDER BY "runAt"
      LIMIT ${BATCH_SIZE - MAX_HEAVY_PER_TICK}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "BackgroundJob" SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${hostname()}, "updatedAt" = now(),
      attempts = attempts + (CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END)
    WHERE id IN (
      SELECT id FROM heavy UNION ALL SELECT id FROM light
    )
    RETURNING *`;
  // 02.10.2026: `UPDATE … WHERE id IN (… ORDER BY … LIMIT …) RETURNING` порядок строк НЕ
  // гарантирует — Postgres отдаёт их в порядке обхода таблицы, а не подзапроса. Партия
  // исполнялась «как легла», и `ORDER BY "runAt"` внутри подзапроса определял лишь КТО
  // попал в партию, а не очерёдность. Следствие: тест выхода процесса
  // (background-jobs-shutdown-releases-batch) то проходил, то видел «начато третье вместо
  // первого» — и на main, и в одиночку (три из пяти запусков красные на одной базе).
  // Сортировка стабильная: при равных `runAt` порядок остаётся прежним.
  return claimed.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
}

/**
 * Попытка, снятая с ожидания по таймауту, НЕ ОСТАНОВЛЕНА: Promise.race только
 * перестаёт её ждать, а сама она работает дальше и может ещё отправить клиенту
 * сообщение. Следующая попытка раньше, чем через столько же времени, шла бы с
 * ней наперегонки — клиент получал бы ответ дважды (аудит 23.09.2026 №24).
 */
class JobTimedOut extends Error {
  constructor(readonly timeoutMs: number) {
    super(`задание не завершилось за ${Math.round(timeoutMs / 1000)}с — снято с ожидания`);
  }
}

export function nextAttemptDelayMs(err: unknown, backoffMs: number): number {
  return err instanceof JobTimedOut ? Math.max(backoffMs, err.timeoutMs) : backoffMs;
}

async function runOne(job: BackgroundJob): Promise<void> {
  const handler = jobHandlerOf(job.type);
  if (!handler) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "PENDING", runAt: new Date(Date.now() + UNKNOWN_TYPE_DELAY_MS), lockedAt: null, lockedBy: null },
    });
    return;
  }
  // Попытки уже исчерпаны ЗАХВАТАМИ зависшего RUNNING (см. claimBatch) —
  // задание убивало процесс, не доживая до catch. Не запускаем в N+1-й раз.
  if (job.attempts >= job.maxAttempts) {
    const givenUpLastError = job.lastError ?? "процесс умирал на этом задании, не доходя до ошибки";
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "GIVEN_UP", lastError: givenUpLastError, lockedAt: null, lockedBy: null, dedupeKey: null },
    });
    await handler
      .onGiveUp(job.payload)
      .catch((e) => console.error(`[jobs] onGiveUp ${job.type}:`, e instanceof Error ? e.message : e));
    await logSystemError(
      "background-jobs",
      `Задание ${job.type} (${job.id}) сдалось: ${job.attempts} захватов без завершения — вероятно, роняло процесс`
    );
    // Видимость для человека (владелец 21.09.2026, «Что не доехало») — ровно
    // здесь, один раз на окончательную сдачу, а не на каждую попытку.
    await notifyStuckWorkGivenUp({ ...job, lastError: givenUpLastError });
    return;
  }
  // Модуль пульта выключили, пока задание ждало (jobs/jobModules.ts): SKIPPED —
  // это не ошибка и не «сделано», onGiveUp не зовём, журнал ошибок не трогаем.
  const module = pultModuleOfJob(job.type);
  if (module && !(await isPultModuleEnabled(module))) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "SKIPPED", lastError: `module:${module}:off`, lockedAt: null, lockedBy: null, dedupeKey: null },
    });
    return;
  }
  // Свежий лизинг перед стартом: партия исполняется последовательно, и джоб в
  // хвосте мог прождать дольше STUCK_RUNNING_MIN — без обновления lockedAt его
  // «подобрал» бы следующий тик, пока этот только начинает.
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { lockedAt: new Date() } }).catch(() => {});
  try {
    const payload = handler.schema.parse(job.payload);
    const timeoutMs = effectiveJobTimeoutMs(job.type);
    const timedOut = Symbol("timeout");
    const result = await Promise.race([
      handler.run(payload).then(() => "done" as const),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
    ]);
    if (result === timedOut) {
      throw new JobTimedOut(timeoutMs);
    }
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "DONE", lastError: null, lockedAt: null, lockedBy: null, dedupeKey: null },
    });
  } catch (err) {
    const attempts = job.attempts + 1;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (attempts >= job.maxAttempts) {
      // Молчаливых смертей не бывает: сдаёмся громко — обработчику слово
      // (уведомить персонал), затем след в журнале ошибок.
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: "GIVEN_UP", attempts, lastError: message, lockedAt: null, lockedBy: null, dedupeKey: null },
      });
      await handler
        .onGiveUp(job.payload)
        .catch((e) => console.error(`[jobs] onGiveUp ${job.type}:`, e instanceof Error ? e.message : e));
      await logSystemError(
        "background-jobs",
        `Задание ${job.type} (${job.id}) сдалось после ${attempts} попыток: ${message}`
      );
      // Видимость для человека (владелец 21.09.2026, «Что не доехало») — ровно
      // здесь, один раз на окончательную сдачу, а не на каждую попытку.
      await notifyStuckWorkGivenUp({ ...job, attempts, lastError: message });
    } else {
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          attempts,
          lastError: message,
          runAt: new Date(Date.now() + nextAttemptDelayMs(err, handler.backoff(attempts))),
          lockedAt: null,
          lockedBy: null,
        },
      });
    }
  }
}

/**
 * Идёт ли прямо сейчас исполнение задания — читает мягкая смерть процесса
 * (worker.ts): обрыв посреди джоба оставляет его RUNNING на 15 минут, а при
 * обрыве между side-effect'ом (сообщение клиенту ушло) и отметкой DONE работа
 * повторится. Оба процесса ждут завершения текущего джоба перед выходом.
 */
let busy = false;
/** Выставляется на SIGTERM: новые задания в этом тике уже не начинаем. */
let stopping = false;

export function isBackgroundJobRunning(): boolean {
  return busy || Object.values(customerBusy).some(Boolean);
}

export function stopBackgroundJobs(): void {
  stopping = true;
}

/** Same atomic claim/attempt ladder and handlers as the ordinary runner. No
 * in-memory queue, new send retry, alternative provider or policy grant. */
export async function runCustomerJobsTick(lane: CustomerJobLane): Promise<number> {
  if (stopping || customerBusy[lane]) return 0;
  customerBusy[lane] = true; // before the first await: overlapping ticks cannot claim ahead
  try {
    const [job] = await prisma.$queryRaw<BackgroundJob[]>`
      UPDATE "BackgroundJob" SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${hostname()}, "updatedAt" = now(),
        attempts = attempts + (CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END)
      WHERE id IN (
        SELECT id FROM "BackgroundJob" WHERE type = ${CUSTOMER_JOB_LANES[lane]}
          AND ((status = 'PENDING' AND "runAt" <= now())
            OR (status = 'RUNNING' AND "lockedAt" < now() - make_interval(mins => ${STUCK_RUNNING_MIN}::int)))
        ORDER BY "runAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING *`;
    if (!job) return 0;
    if (stopping) {
      await prisma.backgroundJob.updateMany({ where: { id: job.id, status: "RUNNING" },
        data: { status: "PENDING", lockedAt: null, lockedBy: null } });
      return 0;
    }
    await runOne(job);
    return 1;
  } finally { customerBusy[lane] = false; }
}

/** Один тик воркера: захватить партию, исполнить по одному, подчистить старые DONE. */
export async function runBackgroundJobsTick(): Promise<number> {
  if (stopping) return 0;
  const claimed = await claimBatch();
  // Сначала клиентские задания, тяжёлый ffmpeg — в конце и не больше одного за
  // тик (см. HEAVY_TYPES): иначе монтаж задерживал ответ клиенту на десятки минут.
  const heavy = claimed.filter((j) => HEAVY_TYPES.includes(j.type));
  const light = claimed.filter((j) => !HEAVY_TYPES.includes(j.type));
  const postponed = heavy.slice(MAX_HEAVY_PER_TICK);
  if (postponed.length > 0) {
    // Возвращаем лишние тяжёлые в очередь — их возьмёт следующий тик (через
    // минуту), а не подбор зависших через пятнадцать.
    await prisma.backgroundJob
      .updateMany({
        where: { id: { in: postponed.map((j) => j.id) } },
        data: { status: "PENDING", lockedAt: null, lockedBy: null },
      })
      .catch((err) => console.error("[jobs] возврат тяжёлых заданий:", err instanceof Error ? err.message : err));
  }
  const batch = [...light, ...heavy.slice(0, MAX_HEAVY_PER_TICK)];
  busy = true;
  try {
    for (const [index, job] of batch.entries()) {
      // ОСТАТОК ПАРТИИ ВОЗВРАЩАЕМ В ОЧЕРЕДЬ СРАЗУ (22.09.2026), а не оставляем
      // RUNNING «до подбора зависших». Раньше выход процесса бросал захваченные,
      // но НЕ НАЧАТЫЕ задания как есть — и стоило это трижды:
      //  - минута ожидания превращалась в пятнадцать (STUCK_RUNNING_MIN), а
      //    деплоев бывает два десятка в день;
      //  - подбор зависшего доращивает attempts (см. claimBatch), то есть
      //    задание, которое ни разу не запускалось, жгло лестницу попыток и
      //    могло дойти до GIVEN_UP с диагнозом «роняло процесс» — неверным;
      //  - владелец видел их в «Что не доехало» (lib/stuckWork.ts, тот же порог
      //    в 15 минут) как зависшие, хотя это был обычный выкат.
      // Возврат — тот же, что у лишних тяжёлых выше: PENDING, замок снят,
      // attempts не трогаем (попытки не было).
      if (stopping) {
        const rest = batch.slice(index);
        await prisma.backgroundJob
          .updateMany({
            where: { id: { in: rest.map((j) => j.id) }, status: "RUNNING" },
            data: { status: "PENDING", lockedAt: null, lockedBy: null },
          })
          .catch((err) =>
            console.error("[jobs] возврат партии при выходе:", err instanceof Error ? err.message : err)
          );
        break;
      }
      await runOne(job);
    }
  } finally {
    busy = false;
  }
  // Чистка дешёвая (индекс status+runAt) и не заслуживает отдельного тика.
  await prisma.backgroundJob
    .deleteMany({
      where: { status: { in: ["DONE", "SKIPPED"] }, runAt: { lt: new Date(Date.now() - KEEP_DONE_DAYS * 24 * 3_600_000) } },
    })
    .catch(() => {});
  return batch.length;
}
