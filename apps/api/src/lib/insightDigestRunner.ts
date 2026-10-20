import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications } from "./notifications.js";
import { logSystemError } from "./systemError.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import type { CaseCandidate } from "./insightDigest.js";

/**
 * Оркестратор полного цикла генерации диджеста «Инсайты от ИИ».
 *
 * Шаги 2 (collectCandidates) и 3 (judgeCase / generateVerdicts) выполняются
 * параллельными агентами в отдельных модулях. Этот файл НЕ зависит от них
 * напрямую: импорты обёрнуты в try/catch, и при отсутствии модулей диджест
 * создаётся со статусом FAILED/PARTIAL, а не падает целиком.
 *
 * Идемпотентность: повторный вызов с тем же periodStart возвращает уже
 * существующий id — крон может безопасно перезапускаться без дублей.
 */

/**
 * Попытка загрузить collectCandidates из insightDigest.js. Модуль может быть
 * ещё не создан (параллельный агент), поэтому импорт динамический и с защитой.
 */
async function tryCollectCandidates(
  periodStart: Date,
  periodEnd: Date
): Promise<{ candidates: CaseCandidate[]; error: string | null }> {
  try {
    const mod = await import("./insightDigest.js");
    if (typeof mod.collectCandidates !== "function") {
      return { candidates: [], error: "collectCandidates не экспортируется из insightDigest.js" };
    }
    const result = await mod.collectCandidates(periodStart, periodEnd);
    if (!Array.isArray(result)) {
      return { candidates: [], error: "collectCandidates вернул не массив" };
    }
    return { candidates: result as CaseCandidate[], error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { candidates: [], error: `Не удалось загрузить collectCandidates: ${message}` };
  }
}

/**
 * Ранжирование и отбор лучших кандидатов. Если rankAndPick не экспортируется,
 * берём всех кандидатов как есть (упрощённый fallback).
 */
async function tryRankAndPick(candidates: CaseCandidate[]): Promise<CaseCandidate[]> {
  try {
    const mod = await import("./insightDigest.js");
    if (typeof mod.rankAndPick === "function") {
      const result = await mod.rankAndPick(candidates);
      return Array.isArray(result) ? (result as CaseCandidate[]) : candidates;
    }
  } catch {
    // Модуль недоступен — возвращаем всех кандидатов без ранжирования.
  }
  return candidates;
}

/**
 * Генерация вердиктов по отобранным кейсам. Аналогично collectCandidates —
 * модуль может быть ещё не готов. generateVerdicts обновляет verdict через
 * Prisma самостоятельно, возвращает void.
 */
async function tryGenerateVerdicts(
  cases: { id: string; kind: string; severity: number; timeline: unknown; verdict: unknown }[]
): Promise<{ error: string | null }> {
  try {
    const mod = await import("./insightJudge.js");
    if (typeof mod.generateVerdicts !== "function") {
      return { error: "generateVerdicts не экспортируется из insightJudge.js" };
    }
    await mod.generateVerdicts(cases);
    return { error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Не удалось загрузить generateVerdicts: ${message}` };
  }
}

/**
 * ЗАСТРЯВШЕЕ «собирается…» СНИМАЕТСЯ САМО (21.09.2026, соседний баг того же класса).
 *
 * Строка выпуска заводится со статусом GENERATING ДО сбора кандидатов и вердиктов
 * — это минуты работы с ИИ. Снять этот статус мог только тот процесс, который его
 * поставил, а автовыкат перезапускает контейнеры по каждому мержу в main. Рестарт
 * посреди сборки оставлял строку в GENERATING навсегда, и проверка
 * идемпотентности выше возвращала её id КАК ГОТОВЫЙ: период заклинивало
 * насмерть — крон в 09:00 отдавал мёртвую строку, кнопка «Собрать сейчас» тоже,
 * а директор видел вечное «собирается…» (apps/web DigestBits.tsx).
 *
 * Признак мёртвой сборки — возраст, как у захвата обработки фото
 * (routes/properties/photos.ts, ENHANCE_LOCK_WINDOW_MS): живая укладывается
 * в минуты, получасовой GENERATING не переживает ни один рестарт.
 *
 * Захват атомарный и без новой колонки: побеждает тот, чей `updateMany` обновил
 * `createdAt`. Для этой строки `createdAt` и означает «когда начали собирать
 * ЭТОТ выпуск» — после обновления строка выглядит свежей, и параллельный
 * претендент (крон и кнопка могут совпасть) уходит по ветке «сборка идёт».
 */
const INSIGHT_DIGEST_STALE_MS = 30 * 60_000;

async function reclaimStuckDigest(existing: { id: string; status: string; createdAt: Date }): Promise<boolean> {
  if (existing.status !== "GENERATING") return false;
  const cutoff = new Date(Date.now() - INSIGHT_DIGEST_STALE_MS);
  if (existing.createdAt >= cutoff) return false;

  const claimed = await prisma.insightDigest.updateMany({
    where: { id: existing.id, status: "GENERATING", createdAt: { lt: cutoff } },
    data: { createdAt: new Date() },
  });
  if (claimed.count === 0) return false;

  /**
   * Недособранные кейсы прошлой попытки убираем ДО пересборки. `sourceKey`
   * уникален глобально: оставь их — и каждый `insightCase.create` новой сборки
   * упёрся бы в дубль, её собственный catch проглотил бы это по кейсу, и выпуск
   * вышел бы пустым и со статусом READY. Разобранные на встрече кейсы
   * (`reviewedAt`) не трогаем: заметка директора дороже полноты пересборки.
   */
  const dropped = await prisma.insightCase.deleteMany({
    where: { digestId: existing.id, reviewedAt: null },
  });
  console.warn(
    `[insight-digest] Сборка выпуска ${existing.id} оборвалась (статус GENERATING с ${existing.createdAt.toISOString()}) — собираем заново, отброшено кейсов: ${dropped.count}`
  );
  return true;
}

/**
 * ВЫПУСК, КОТОРЫЙ НЕ СОБРАЛСЯ ПОЛНОСТЬЮ, МОЖНО СОБРАТЬ ЕЩЁ РАЗ (HELPER-FINAL03,
 * аудит Codex 04.10.2026).
 *
 * Раньше повторная генерация того же периода отдавала существующий id при любом статусе,
 * кроме застрявшего GENERATING: выпуск, потерявший кейс при записи (временный сбой базы),
 * или упавший целиком (FAILED), оставался неполным навсегда, хотя крон в конце месяца и
 * кнопка «Собрать сейчас» как раз и нужны для повтора.
 *
 * Пересобираем FAILED и PARTIAL, где есть потерянные при записи кейсы
 * (`coverage.failedCases`). PARTIAL только из-за вердиктов не трогаем: кейсы целы, а
 * пересборка потратила бы бюджет ИИ и стёрла бы уже полученные вердикты. Захват
 * атомарный, по статусу, который читали: проигравший параллельный претендент
 * (крон и кнопка) уходит по ветке «сборка идёт». Недособранные кейсы убираем, как у
 * reclaimStuckDigest: `sourceKey` уникален глобально, и без этого новая сборка упёрлась
 * бы в дубли. Разобранные на встрече (`reviewedAt`) остаются.
 */
async function reclaimIncompleteDigest(existing: { id: string; status: string; coverage?: unknown }): Promise<boolean> {
  const failedCases = (existing.coverage as { failedCases?: unknown } | null | undefined)?.failedCases;
  const lostCases = typeof failedCases === "number" && failedCases > 0;
  if (existing.status !== "FAILED" && !(existing.status === "PARTIAL" && lostCases)) return false;

  const claimed = await prisma.insightDigest.updateMany({
    where: { id: existing.id, status: existing.status },
    data: { status: "GENERATING", createdAt: new Date() },
  });
  if (claimed.count === 0) return false;

  const dropped = await prisma.insightCase.deleteMany({
    where: { digestId: existing.id, reviewedAt: null },
  });
  console.warn(
    `[insight-digest] Выпуск ${existing.id} (статус ${existing.status}) собран не полностью — собираем заново, отброшено кейсов: ${dropped.count}`
  );
  return true;
}
export async function generateInsightDigest(
  periodStart: Date,
  periodEnd: Date,
  meetingAt: Date
): Promise<string> {
  // 1. Рубильник
  const settings = await prisma.settings.findFirst();
  if (settings?.insightDigestEnabled === false) {
    return "DISABLED";
  }

  // 2. Идемпотентность
  const existing = await prisma.insightDigest.findUnique({
    where: { periodStart },
    select: { id: true, status: true, createdAt: true, coverage: true },
  });
  // Строка есть — но собрана ли она? Сборку могло оборвать рестартом, и тогда
  // её надо пересобрать, а не отдавать вечное «собирается…» как готовый выпуск.
  // Так же пересобираем выпуск, потерявший кейсы при записи, и упавший целиком.
  const reclaimed = existing ? (await reclaimStuckDigest(existing)) || (await reclaimIncompleteDigest(existing)) : false;
  // Не наш случай (выпуск собран, или сборка идёт прямо сейчас) — отдаём id,
  // как и раньше: повторный вызов крона не должен плодить дубли.
  if (existing && !reclaimed) return existing.id;

  // 3. Создаём диджест со статусом GENERATING. Крон в 09:00 и кнопка «Собрать
  //    сейчас» могут стартовать одновременно и оба пройти проверку выше —
  //    уникальный индекс periodStart тогда роняет второго; ловим P2002 и
  //    отдаём id того, кто успел первым (ревью 03.09.2026).
  let digestId: string;
  if (existing) {
    // Пересборка идёт В ТУ ЖЕ строку: уникальный индекс periodStart всё равно
    // не дал бы завести вторую, да и ссылки директора на выпуск остались бы
    // висеть на старой.
    digestId = existing.id;
  } else {
    try {
      const digest = await prisma.insightDigest.create({
        data: {
          periodStart,
          periodEnd,
          meetingAt,
          status: "GENERATING",
          coverage: { calls: 0, analyzed: 0, findings: 0, penalties: 0 },
        },
        select: { id: true },
      });
      digestId = digest.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await prisma.insightDigest.findUnique({ where: { periodStart }, select: { id: true } });
        if (winner) return winner.id;
      }
      throw err;
    }
  }

  try {
    // 4. Сбор кандидатов
    const { candidates, error: collectError } = await tryCollectCandidates(periodStart, periodEnd);
    if (collectError) {
      console.error(`[insight-digest] collectCandidates: ${collectError}`);
      void logSystemError("api", `InsightDigest collectCandidates: ${collectError}`);
      await prisma.insightDigest.update({
        where: { id: digestId },
        data: { status: "FAILED", coverage: { calls: 0, analyzed: 0, findings: 0, penalties: 0, error: collectError } },
      });
      return digestId;
    }

    // 5. Ранжирование
    const picked = await tryRankAndPick(candidates);

    // 6. Создание InsightCase для каждого отобранного кандидата.
    //    snapshotTimeline может быть недоступен (модуль ещё не готов) —
    //    используем raw как fallback для timeline.
    let snapshotTimelineFn: ((c: CaseCandidate) => Promise<unknown>) | null = null;
    try {
      const mod = await import("./insightDigest.js");
      if (typeof mod.snapshotTimeline === "function") {
        snapshotTimelineFn = mod.snapshotTimeline;
      }
    } catch {
      // snapshotTimeline недоступен — будем использовать raw
    }

    const createdCases: { id: string; sourceKey: string; kind: string; severity: number; timeline: unknown; verdict: unknown }[] = [];
    let failedCreates = 0;
    for (const c of picked) {
      try {
        const timeline = snapshotTimelineFn
          ? await snapshotTimelineFn(c).catch(() => c.raw)
          : c.raw;
        const ic = await prisma.insightCase.create({
          data: {
            digestId: digestId,
            agentId: c.agentId,
            clientId: c.clientId,
            kind: c.kind,
            severity: c.severity,
            sourceKey: c.sourceKey,
            timeline: timeline ?? {},
          },
        });
        createdCases.push({
          id: ic.id,
          sourceKey: ic.sourceKey,
          kind: ic.kind,
          severity: ic.severity,
          timeline: ic.timeline,
          verdict: ic.verdict,
        });
      } catch (err) {
        // Не роняем весь диджест из-за одного кейса. Дубликат sourceKey (P2002) — штатный
        // пропуск: кейс уже есть в базе. Любая другая ошибка записи — потерянный кейс: он
        // обязан попасть в статус и coverage, иначе выпуск уходил в READY без него и
        // повторная генерация это не исправляла (HELPER-FINAL03).
        const duplicate = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        console.error(`[insight-digest] Не удалось создать кейс ${c.sourceKey}:`, err instanceof Error ? err.message : err);
        if (!duplicate) failedCreates++;
      }
    }
    if (failedCreates > 0) {
      void logSystemError(
        "api",
        `InsightDigest ${digestId}: не записано кейсов — ${failedCreates} из ${picked.length}. Выпуск помечен PARTIAL, повторная генерация пересоберёт его.`
      );
    }

    // 7. Генерация вердиктов (generateVerdicts обновляет БД сама)
    const { error: verdictError } = await tryGenerateVerdicts(createdCases);
    if (verdictError) {
      console.error(`[insight-digest] generateVerdicts: ${verdictError}`);
      void logSystemError("api", `InsightDigest generateVerdicts: ${verdictError}`);
    }

    // Считаем сколько вердиктов реально записано (generateVerdicts мог пропустить
    // часть из-за бюджета или ошибок).
    // `verdict: undefined` Prisma выбрасывает из where — считались бы ВСЕ кейсы
    // и отказ Gemini (429/таймаут → verdict=null) давал бы READY вместо PARTIAL.
    let verdictsApplied = 0;
    if (createdCases.length > 0) {
      const withVerdict = await prisma.insightCase.count({
        where: { digestId: digestId, NOT: { verdict: { equals: Prisma.DbNull } } },
      });
      verdictsApplied = withVerdict;
    }

    // 8. Определение финального статуса
    let status: string;
    if (verdictError && createdCases.length > 0 && verdictsApplied === 0) {
      status = "FAILED";
    } else if (verdictError || failedCreates > 0 || (createdCases.length > 0 && verdictsApplied < createdCases.length)) {
      status = "PARTIAL";
    } else {
      status = "READY";
    }

    // 9. Обновление coverage
    const penaltiesCount = createdCases.filter((c) => c.kind === "score_penalty").length;
    await prisma.insightDigest.update({
      where: { id: digestId },
      data: {
        status,
        coverage: {
          calls: candidates.length,
          analyzed: createdCases.length,
          findings: createdCases.length,
          penalties: penaltiesCount,
          ...(verdictError ? { verdictError } : {}),
          ...(failedCreates > 0 ? { failedCases: failedCreates } : {}),
        },
      },
    });

    return digestId;
  } catch (err) {
    // Любая непредвиденная ошибка — ставим FAILED и возвращаем id
    const message = err instanceof Error ? err.message : String(err);
    console.error("[insight-digest] Неожиданная ошибка генерации:", message);
    void logSystemError("api", `InsightDigest generation failed: ${message}`);
    await prisma.insightDigest.update({
      where: { id: digestId },
      data: { status: "FAILED", coverage: { calls: 0, analyzed: 0, findings: 0, penalties: 0, error: message } },
    }).catch(() => {});
    return digestId;
  }
}

/**
 * Уведомление директоров о готовности диджеста. Пуш + запись в ленту уведомлений.
 *
 * `immediate` (владелец 07.09.2026, часы алармов): у этой функции ДВА
 * вызывающих с разной природой. Крон (biweekly, «0 9 15,28-31 * *») — пассивный
 * аларм, директор его не просил именно сейчас, значит ставим в общую очередь
 * (lib/directorAlertQueue.ts) и ждём часов алармов, как и остальные фоновые
 * сигналы. Кнопка «Собрать сейчас» (routes/insights.ts) — наоборот, директор
 * САМ только что нажал и явно хочет увидеть результат немедленно: откладывать
 * ответ на его собственное действие было бы неправильно понятым требованием
 * «не будить ночью» — здесь никого не будят, здесь отвечают на клик.
 */
export async function notifyDirectorsAboutInsightDigest(digestId: string, immediate = false): Promise<void> {
  const digest = await prisma.insightDigest.findUnique({
    where: { id: digestId },
    include: { _count: { select: { cases: true } } },
  });
  if (!digest) return;

  const meetingDate = dushanbeWallClock(digest.meetingAt).toISOString().slice(0, 10);
  const casesCount = digest._count.cases;
  const tag = `insight-digest-${digest.periodStart.toISOString()}`;
  const title = "📊 Инсайты от ИИ готовы";
  const body = `${casesCount} кейсов для собрания ${meetingDate}`;
  // Экрана одного диджеста нет — раздел «Инсайты» сам открывает свежий (аудит 23.09.2026, №16).
  const url = "/insights";

  if (!immediate) {
    // Третий уровень владельца: советы системы, не работа и не тревога.
    await enqueueDirectorAlert({ title, body, url, tag, kind: "oversight", level: "INSIGHT", recipientRoles: ["DIRECTOR", "ADMIN"] });
    return;
  }

  const directors = await prisma.agent.findMany({
    where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
    select: { id: true },
  });
  if (directors.length === 0) return;
  const directorIds = directors.map((d) => d.id);
  // Третий уровень владельца: советы системы, не работа и не тревога.
  const payload = { kind: "oversight" as const, level: "INSIGHT" as const, tag, title, body, url };
  await sendPushToAgents(directorIds, payload);
  // createNotifications уже вызывается внутри sendPushToAgents — отдельный
  // вызов не нужен. Но если VAPID не настроен, push не уходит, а лента должна
  // наполниться в любом случае. Страховка:
  await createNotifications(directorIds, {
    kind: payload.kind,
    // Уровень обязателен и здесь: страховка пишет ТУ ЖЕ строку по тому же тегу,
    // и без него она понизила бы инсайт до «Прочего» (см. PushPayload.level).
    level: payload.level,
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
  });
}