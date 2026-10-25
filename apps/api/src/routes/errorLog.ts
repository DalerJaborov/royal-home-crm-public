import { visibleErrorLogs } from "../lib/systemErrorVisibility.js";
import { visibleSystemErrorWhere } from "../lib/investigationOperations.js";
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { STUCK_LIMIT, findStuckConversations } from "../lib/stuckConversations.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { AI_REPLY_RETRY_MAX_ATTEMPTS } from "../jobs/aiReplyRetryPolicy.js";
import { classifyErrorLog, errorLogPriorityWhere, type ErrorLogPriority } from "../lib/errorLogClassify.js";
import { checkGeminiHealth } from "../lib/integrationHealth.js";
import { dushanbeStartOfToday } from "../lib/dushanbeTime.js";

export const errorLogRouter = Router();

const clientErrorSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(500).optional(),
});

/** Браузер сообщает о своих ошибках (window.onerror/unhandledrejection) —
 * чтобы баги фронта не оставались невидимыми, пока о них не расскажет агент. */
errorLogRouter.post("/", requireAuth, async (req, res) => {
  const parsed = clientErrorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  // Дедуп за 10 минут: одна и та же ошибка в цикле рендера не должна заспамить журнал.
  const recentSame = await prisma.errorLog.count({
    where: {
      source: "web",
      message: parsed.data.message,
      createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
    },
  });
  if (recentSame === 0) {
    await prisma.errorLog.create({
      data: {
        source: "web",
        message: parsed.data.message,
        stack: parsed.data.stack,
        url: parsed.data.url,
        agentId: req.agent!.id,
        userAgent: req.headers["user-agent"]?.slice(0, 300),
      },
    });
  }
  res.status(204).end();
});

/**
 * Здоровье системы для админа: ошибки + счётчики за 24ч/7 дней.
 *
 * Счётчики считают ТОЛЬКО неразобранные — иначе показатель нечем обнулить и он
 * перестаёт что-либо значить: директор видит «1 за сутки» неделю подряд и
 * привыкает не смотреть. Разобранные никуда не деваются, их видно по галочке
 * «показать разобранные».
 *
 * ДВЕ КАТЕГОРИИ (аудит 03.09.2026, раздел 4-5, lib/errorLogClassify.ts):
 * каждая строка размечена `priority`. count24h/count7d считают ТОЛЬКО
 * actionable — иначе резерв/повтор ИИ-конвейера красит бейдж «Здоровье
 * системы» в тревожный цвет за то, что CRM уже сама решила. Эксплуатационный
 * шум по-прежнему виден: `operationalUnresolvedCount` и `?priority=` — полный
 * список как был доступен тому, у кого auditLog.view (задача 03.09.2026 —
 * право не изобретаем), фильтрация только меняет, что показано ПО УМОЛЧАНИЮ
 * (см. SystemHealthSection на фронте).
 */
const errorPriorityQuery = z.enum(["operational", "actionable"]).optional();
/**
 * СТРАНИЦЫ (02.10.2026): список кончался на пятидесяти свежих без способа
 * увидеть дальше. Теперь экран дочитывает кнопкой «Показать ещё»; без
 * параметров — первая страница из пятидесяти, как и было («Здоровье» берёт
 * отсюда только счётчики).
 */
const errorPageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

errorLogRouter.get("/", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const includeResolved = req.query.includeResolved === "true";
  const priorityFilter = errorPriorityQuery.safeParse(req.query.priority).data;
  const paging = errorPageQuery.safeParse(req.query);
  if (!paging.success) {
    return res.status(400).json({ error: "Неверные параметры", details: paging.error.flatten() });
  }
  const { page, pageSize } = paging.data;
  const unresolved = { resolvedAt: null };
  // Отбор по категории — в самой выборке (errorLogPriorityWhere), а не в памяти
  // после неё: иначе всплеск шума вытеснял из окна все настоящие ошибки.
  const listWhere: Prisma.ErrorLogWhereInput = {
    AND: [visibleSystemErrorWhere(req.agent?.role), includeResolved ? {} : unresolved, priorityFilter ? errorLogPriorityWhere(priorityFilter) : {}],
  };
  const [rows, total, weekUnresolved, resolvedCount] = await Promise.all([
    visibleErrorLogs(can(req, "clients.securityReview") ? req.agent?.role : undefined).findMany({
      where: listWhere,
      // id — добивка порядка: ошибки одной пачки пишутся в одну миллисекунду,
      // и без неё строки перескакивали бы между страницами.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    visibleErrorLogs(can(req, "clients.securityReview") ? req.agent?.role : undefined).count({ where: listWhere }),
    // Одна выборка на оба счётчика (24ч/7д) и на операционный шум: priority не
    // поле в базе, а текстовая классификация — считать её можно только в
    // памяти. take — предел выборки; неделя редко даёт больше пары тысяч строк,
    // а затяжную аварию такой запас всё равно покрывает с кратным запасом.
    visibleErrorLogs(can(req, "clients.securityReview") ? req.agent?.role : undefined).findMany({
      where: { ...visibleSystemErrorWhere(req.agent?.role), ...unresolved, createdAt: { gte: weekAgo } },
      select: { source: true, message: true, createdAt: true },
      take: 5000,
    }),
    visibleErrorLogs(can(req, "clients.securityReview") ? req.agent?.role : undefined).count({ where: { ...visibleSystemErrorWhere(req.agent?.role), resolvedAt: { not: null } } }),
  ]);
  const recent = rows.map((r) => ({ ...r, priority: classifyErrorLog(r.source, r.message) as ErrorLogPriority }));
  const actionableWeek = weekUnresolved.filter((r) => classifyErrorLog(r.source, r.message) === "actionable");
  const count24h = actionableWeek.filter((r) => r.createdAt >= dayAgo).length;
  const count7d = actionableWeek.length;
  const operationalUnresolvedCount = weekUnresolved.length - actionableWeek.length;
  res.json({ recent, total, page, pageSize, count24h, count7d, resolvedCount, operationalUnresolvedCount });
});

/**
 * Проверка ключа Gemini ПО ТРЕБОВАНИЮ (13.09.2026, просьба владельца).
 *
 * `checkGeminiHealth()` уже вызывается раз в сутки из cron.ts
 * (runIntegrationHealthChecks) — этот маршрут запускает ТОТ ЖЕ код синхронно,
 * по кнопке «Проверить сейчас» на экране «Здоровье системы», не заменяя
 * суточный тик и не заводя вторую копию логики. Отказ уже попадёт в журнал
 * ошибок самой функцией (см. integrationHealth.ts) — здесь только пробрасываем
 * результат на экран.
 */
errorLogRouter.post("/gemini-health-check", requireAuth, requirePermission("auditLog.view"), async (_req, res) => {
  const result = await checkGeminiHealth();
  res.json(result);
});

/** Отметить ошибку разобранной — она уходит из счётчиков и из утреннего уведомления. */
errorLogRouter.post("/:id/resolve", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  try {
    await visibleErrorLogs(can(req, "clients.securityReview") ? req.agent?.role : undefined).update({
      where: { ...visibleSystemErrorWhere(req.agent?.role), id: req.params.id },
      data: { resolvedAt: new Date(), resolvedById: req.agent!.id },
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Запись не найдена" });
    }
    throw err;
  }
});

/** Вернуть ошибку в работу, если отметили разобранной по ошибке. */
errorLogRouter.post("/:id/reopen", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  try {
    await visibleErrorLogs(can(req, "clients.securityReview") ? req.agent?.role : undefined).update({
      where: { ...visibleSystemErrorWhere(req.agent?.role), id: req.params.id },
      data: { resolvedAt: null, resolvedById: null },
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Запись не найдена" });
    }
    throw err;
  }
});

/** `scope: "today"` — только ошибки сегодняшнего дня по Душанбе: пульт
 *  обещает «N ошибок за сегодня · Разобрать все», а закрывались и все старые,
 *  ни разу не показанные (аудит 23.09.2026, №56). Без тела — все, как раньше
 *  (кнопка в Настройках → Система). */
const resolveAllSchema = z.object({ scope: z.enum(["all", "today"]).default("all") });

/** «Разобрал всё» — типичный сценарий после разбора пачки однотипных ошибок. */
errorLogRouter.post("/resolve-all", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = resolveAllSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const { count } = await visibleErrorLogs(can(req, "clients.securityReview") ? req.agent?.role : undefined).updateMany({
    where: {
      ...visibleSystemErrorWhere(req.agent?.role),
      resolvedAt: null,
      ...(parsed.data.scope === "today" ? { createdAt: { gte: dushanbeStartOfToday(new Date()) } } : {}),
    },
    data: { resolvedAt: new Date(), resolvedById: req.agent!.id },
  });
  res.json({ resolved: count });
});

/**
 * ЗАВИСШИЕ ДИАЛОГИ (18.08.2026, жалоба владельца: «ИИ сегодня многим не
 * ответил, замолчал»).
 *
 * При сбое ИИ клиент не получает вообще никакого сообщения — бот молча пробует
 * ответить в фоне ~13 часов (решение владельца 03.08.2026, окно расширено
 * 16.08.2026, см. ai/aiRetryQueue.ts), а если не получилось — диалог остаётся
 * без ответа до следующего сообщения клиента. Эта очередь живёт ТОЛЬКО в памяти
 * процесса и нигде не сохраняется, поэтому снаружи нельзя отличить «ещё
 * пытается» от «уже сдался» — раздел ниже показывает и считает оба случая
 * вместе: диалог, где последняя реплика сегодня — от клиента, а ответа бота на
 * неё в переписке ещё нет.
 */
/** Предпросмотр — сколько диалогов сегодня без ответа и с каких пор, без единой
 *  отправки. Канал и имя прячутся тем же правом, что и в «Сообщениях»
 *  (clients.viewOrigin) — список сам по себе не повод открывать площадку. */
errorLogRouter.get("/stuck-conversations", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const rows = await findStuckConversations();
  const canSeeOrigin = can(req, "clients.viewOrigin");
  res.json({
    count: rows.length,
    limited: rows.length >= STUCK_LIMIT,
    items: rows.map((r) => ({
      id: r.id,
      channel: canSeeOrigin ? r.channel : null,
      name: canSeeOrigin ? r.name : null,
      lastMessageAt: r.lastMessageAt,
    })),
  });
});

/**
 * «Повторить всем зависшим» — кнопка на экране ошибок (18.08.2026, после дня с
 * перебоями Gemini).
 *
 * Список диалогов берём ЗАНОВО в момент запуска (не тот, что видел предпросмотр
 * секунды назад): диалог мог получить ответ фоновой очередью aiRetryQueue как
 * раз между открытием страницы и нажатием кнопки, и второй ответ поверх уже
 * пришедшего был бы ровно тем дублем, ради которого весь этот файл существует.
 *
 * Отправка идёт ПОСЛЕДОВАТЕЛЬНО и в фоне, а не внутри запроса: диалогов может
 * быть много, каждый ход — это отдельный вызов ИИ (секунды), и синхронный ответ
 * рисковал бы упереться в таймаут прокси на сервере раньше, чем дойдёт до
 * последнего диалога. Итог виден по новым записям ErrorLog (отказы) и по тому,
 * что предпросмотр выше со временем пустеет.
 */
errorLogRouter.post("/stuck-conversations/retry", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const rows = await findStuckConversations();
  res.json({ queued: rows.length });
  if (rows.length === 0) return;

  /**
   * КНОПКА НЕ ОТВЕЧАЕТ САМА — СТАВИТ В ОЧЕРЕДЬ (аудит №4, 27.08).
   *
   * Один диалог могли одновременно проигрывать трое: ночная автоматика
   * здоровья (проход живёт минутами), задание ai-reply-retry и эта кнопка.
   * Каждый проверял «последняя реплика — клиентская», потом секунды-минуты
   * генерировал ответ — и после простоя Gemini клиент получал ДВА разных
   * ответа на одно сообщение (жалоба владельца «отправляется два сообщения»).
   * Очередь дедуплицирует по диалогу сама, и исполнитель остаётся ровно один.
   */
  void Promise.all(
    rows.map((row) =>
      enqueueBackgroundJob({
        type: "ai-reply-retry",
        payload: { conversationId: row.id },
        dedupeKey: `ai-reply-retry:${row.id}`,
        maxAttempts: AI_REPLY_RETRY_MAX_ATTEMPTS,
      })
    )
  ).catch((err) => logSystemError("ai", `Повтор зависших диалогов не поставлен в очередь: ${describeError(err)}`));
});
