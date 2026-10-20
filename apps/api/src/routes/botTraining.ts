import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { logAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { decideTraining, nextTrainingQuestion } from "../ai/training.js";
import { GUARD_LABELS, loadGuardStats, type GuardName } from "../ai/guardMetrics.js";

/**
 * Экран «Тренировка» (23.08.2026, пункт 6 очереди ИИ): владелец отвечает на
 * реальные вопросы клиентов, выбирая лучший из сгенерированных вариантов или
 * вписывая свой. Подбор вопроса и генерация вариантов — в ai/training.ts,
 * здесь только окно наружу и проверка прав/рубильника.
 *
 * Право то же, что у «Обучение бота» (routes/botLearning.ts): GET — settings.view,
 * запись — settings.manage. Сохранение образца требует ещё и requireElevation —
 * тот же довод, что у PATCH /bot-learning/:id: текст отсюда попадает в промт бота
 * (через StyleExample → styleLearning.ts) и меняет то, что бот говорит клиентам.
 */
export const botTrainingRouter = Router();

/**
 * Экран доступен, только если владелец включил рубильник в Настройках
 * (Settings.botTrainingScreenEnabled). Проверка на СЕРВЕРЕ, а не только в
 * интерфейсе — та же причина, что у ИИ-ассистента (routes/ai.ts): спрятанная
 * кнопка защищает от случайного клика, а не от прямого запроса к API.
 */
async function requireTrainingEnabled<P>(_req: Request<P>, res: Response, next: NextFunction) {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { botTrainingScreenEnabled: true },
  });
  if (settings?.botTrainingScreenEnabled !== true) {
    return res.status(403).json({ error: "Экран тренировки выключен в Настройках" });
  }
  next();
}

/**
 * Следующий вопрос для тренировки: реальная реплика клиента ещё без образца +
 * 2-3 сгенерированных варианта ответа. Каждый вызов — новый случайный вопрос и
 * новая генерация, поэтому GET, но без кеша на стороне клиента (см. хук useNextTrainingQuestion).
 */
/**
 * СЧЁТЧИКИ ФИЛЬТРОВ ОТВЕТА (совет экспертов 26.08, пункт 8).
 *
 * Сколько раз за последние две недели каждый guard чинил реплику бота: повторное
 * приветствие, переспрошенный вопрос, продублированная ссылка, отсечённый спам.
 * Это прямая мера того, насколько промт расходится с желаемым поведением —
 * раньше промт в тысячу строк правился вслепую, и понять «стало лучше или хуже»
 * можно было только по жалобам.
 */
botTrainingRouter.get("/guard-stats", requireAuth, requirePermission("settings.view"), async (_req, res) => {
  const rows = await loadGuardStats(14);
  // Свод по фильтрам за всё окно — то, на что смотрят в первую очередь; разбивка
  // по дням остаётся рядом, чтобы видеть, растёт нарушение или затухает.
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.guard, (totals.get(r.guard) ?? 0) + r.count);
  res.json({
    days: 14,
    // Подпись отдаём вместе с ключом: иначе на экране окажутся сырые латинские
    // `service_offer` и `bot_repeat`. Неизвестный ключ (фильтр переименовали, а в
    // базе остались старые строки) показываем как есть — это честнее пропуска.
    totals: [...totals.entries()]
      .map(([guard, count]) => ({ guard, label: GUARD_LABELS[guard as GuardName] ?? guard, count }))
      .sort((a, b) => b.count - a.count),
    daily: rows,
  });
});

botTrainingRouter.get(
  "/next",
  requireAuth,
  requirePermission("settings.view"),
  requireTrainingEnabled,
  async (_req, res) => {
    try {
      const result = await nextTrainingQuestion();
      if (result.status === "empty") {
        return res.json({ done: true });
      }
      if (result.status === "generation_failed") {
        await logSystemError(
          "ai",
          `Тренировка бота: не удалось сгенерировать варианты ответа (вопрос: ${result.clientText.slice(0, 80)})`
        );
        return res.status(502).json({ error: "Не удалось сгенерировать варианты ответа, попробуйте ещё раз" });
      }
      res.json({
        done: false,
        clientText: result.clientText,
        channel: result.channel,
        conversationId: result.conversationId,
        variants: result.variants,
        groundedIndex: result.groundedIndex,
        groundedSources: result.groundedSources,
      });
    } catch (err) {
      await logSystemError("ai", `Тренировка бота: подбор вопроса не удался: ${describeError(err)}`);
      res.status(502).json({ error: "Не удалось подобрать вопрос, попробуйте ещё раз" });
    }
  }
);

/** Сколько последних образцов уходит в интерфейс за один запрос. */
const SAMPLES_LIMIT = 50;

const samplesQuerySchema = z.object({
  /** id последнего показанного образца — курсор для «показать ещё». Без него —
   *  первая страница. */
  cursor: z.string().uuid().optional(),
});

/**
 * Список уже сохранённых образцов манеры (StyleExample), свежие сверху.
 *
 * `enabled: true` — тот же фильтр, что при подборе кандидата для тренировки
 * (nextTrainingQuestion, ai/training.ts:192) и при сборке few-shot в промт бота
 * (styleLearning.ts:397): списком должно быть именно то, что реально участвует
 * в манере бота, а не выключенные неудачные примеры.
 *
 * Курсорная подгрузка (14.09.2026, жалоба владельца на «Обучение ИИ»): раньше
 * `take: 50` без курсора обрезал список навсегда — до хвоста было не добраться.
 * `nextCursor` — id последнего отданного образца; клиент присылает его назад,
 * чтобы получить следующую страницу. `total` — честный счётчик по базе, а не
 * длина текущей выдачи (см. ту же ошибку в BotTab.tsx).
 */
botTrainingRouter.get(
  "/samples",
  requireAuth,
  requirePermission("settings.view"),
  requireTrainingEnabled,
  async (req, res) => {
    const parsed = samplesQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
    const { cursor } = parsed.data;

    const [rows, total] = await Promise.all([
      prisma.styleExample.findMany({
        where: { enabled: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: SAMPLES_LIMIT,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, clientText: true, agentText: true, source: true, channel: true, createdAt: true },
      }),
      prisma.styleExample.count({ where: { enabled: true } }),
    ]);
    res.json({
      samples: rows.map((r) => ({
        id: r.id,
        clientText: r.clientText,
        agentText: r.agentText,
        source: r.source,
        channel: r.channel,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length === SAMPLES_LIMIT ? rows[rows.length - 1].id : null,
      total,
    });
  }
);

const sampleUpdateSchema = z
  .object({
    /** Участвует ли образец в промте бота (few-shot манеры) и в подборе для тренировки. */
    enabled: z.boolean(),
  })
  .strict();

/**
 * Выключить неудачный образец манеры, не удаляя его (14.09.2026, жалоба владельца:
 * «Сохранённые примеры манеры» — единственное место в интерфейсе, откуда до сих
 * пор было нельзя ни выключить, ни удалить неудачный пример; убрать его можно было
 * только правкой базы напрямую).
 *
 * Строго по образцу PATCH /bot-learning/:id: то же право, то же повторное
 * подтверждение личности (requireElevation) — текст образца попадает прямо в
 * промт бота и меняет то, что бот говорит клиентам.
 */
botTrainingRouter.patch(
  "/samples/:id",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const parsed = sampleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    }
    try {
      const updated = await prisma.styleExample.update({
        where: { id: req.params.id },
        data: { enabled: parsed.data.enabled },
        select: { id: true, enabled: true },
      });
      logAudit(req, "STYLE_EXAMPLE_UPDATE", "StyleExample", updated.id, { enabled: updated.enabled });
      res.json(updated);
    } catch {
      res.status(404).json({ error: "Запись не найдена" });
    }
  }
);

/**
 * Убрать образец манеры совсем.
 *
 * Строго по образцу DELETE /bot-learning/:id: то же право и повторное
 * подтверждение личности, необратимо, подтверждение — на интерфейсе.
 */
botTrainingRouter.delete(
  "/samples/:id",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    try {
      const removed = await prisma.styleExample.delete({
        where: { id: req.params.id },
        select: { id: true, source: true, channel: true },
      });
      // В журнал — источник и канал: сам текст (первоисточник манеры) исчезает
      // вместе с записью, восстановить будет нельзя.
      logAudit(req, "STYLE_EXAMPLE_DELETE", "StyleExample", removed.id, {
        source: removed.source,
        channel: removed.channel,
      });
      res.json({ ok: true, id: removed.id });
    } catch {
      res.status(404).json({ error: "Запись не найдена" });
    }
  }
);

const decideSchema = z
  .object({
    clientText: z.string().min(1).max(2000),
    channel: z.string().max(50).nullable().optional(),
    /** Варианты, показанные владельцу, — присылаются обратно, чтобы сервер не
     *  держал состояние между GET /next и этим запросом (сам экран — тонкий клиент).
     *  До 4: 2-3 обычных плюс необязательный grounded (см. VARIANTS_MAX в ai/training.ts). */
    variants: z.array(z.string().max(2000)).min(1).max(4).optional(),
    chosenIndex: z.number().int().min(0).max(3).optional(),
    /** Пусто — не считается: пустая строка означает «поле не заполнено», а не
     *  «владелец сохраняет пустой ответ». */
    customText: z.string().max(2000).optional(),
  })
  .refine((v) => v.chosenIndex !== undefined || (v.customText?.trim().length ?? 0) > 0, {
    message: "Нужно выбрать один из вариантов или вписать свой ответ",
  })
  .refine((v) => v.chosenIndex === undefined || (v.variants?.[v.chosenIndex] ?? "").length > 0, {
    message: "Указанного варианта нет в списке",
  });

/**
 * Сохранить решение владельца: либо `chosenIndex` (какой из присланных вариантов
 * лучше), либо `customText` (свой ответ). Дубль пары [clientText, agentText] —
 * не ошибка (см. rememberAgentReply в styleLearning.ts): владелец мог случайно
 * выбрать то же самое второй раз, отвечаем 200 с пометкой, а не 500.
 */
botTrainingRouter.post(
  "/decide",
  requireAuth,
  requirePermission("settings.manage"),
  requireTrainingEnabled,
  requireElevation,
  async (req, res) => {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    }
    const { clientText, channel, variants, chosenIndex, customText } = parsed.data;
    // Свой вариант первичнее выбора из списка: если владелец вписал текст, он
    // явно передумал насчёт сгенерированных вариантов, даже если chosenIndex
    // остался в теле запроса от предыдущего клика интерфейса.
    const agentText = customText?.trim() || (chosenIndex !== undefined ? variants?.[chosenIndex] : undefined);
    if (!agentText) {
      return res.status(400).json({ error: "Нет текста ответа" });
    }

    const result = await decideTraining({ clientText, agentText, channel: channel ?? null });
    if (result.ok) return res.json({ ok: true });
    if (result.reason === "duplicate") return res.json({ ok: true, duplicate: true });
    res.status(400).json({
      error:
        result.reason === "invalid_answer"
          ? "Ответ слишком короткий или пустой — допишите по существу"
          : "Вопрос клиента не годится для примера",
    });
  }
);
