import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { createNotifications } from "../lib/notifications.js";
import { logSystemError } from "../lib/systemError.js";
import { secretsMatch } from "../lib/secretCompare.js";
import { isDuplicateDelivery, markProcessedMessageComplete, releaseProcessedMessage } from "../lib/webhookDedupe.js";

/**
 * ПРИЁМ БЮДЖЕТНЫХ ОПОВЕЩЕНИЙ GOOGLE CLOUD.
 *
 * Владелец 20.08.2026: «бюджет с уведомлением — придёт в CRM и сверится?» — да,
 * вот этим путём. В Google Cloud заводится бюджет на проект (Billing → Budgets),
 * его оповещения уходят в тему Pub/Sub, а та push-подпиской стучится сюда.
 * CRM показывает уведомление директору и складывает факт в журнал, чтобы сумму
 * можно было сверить с нашей собственной оценкой расходов на ИИ.
 *
 * ЗАЧЕМ СВЕРКА. Наша строка «расходы на ИИ» считается из журнала обращений по
 * таблице цен: это оценка. Биллинг Google — факт, но приходит с задержкой до
 * суток. Две цифры рядом отвечают на вопрос «можно ли верить нашей оценке»
 * лучше, чем любая из них по отдельности.
 *
 * ЗАЩИТА. Pub/Sub не подписывает запросы, поэтому адрес содержит секрет
 * (?token=…, он же в Настройках): подписка создаётся с этим адресом, и запрос
 * без совпадающего секрета отбрасывается. Тот же приём, что у вебхука сайта.
 */
export const budgetWebhookRouter = Router();

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026: единственный публичный секрет-роут в проекте без
 * своего лимитера — секрет живёт в `?token=`, сравнение постоянным временем
 * (`secretsMatch`) защищает только от тайминг-атаки, а не от перебора числом
 * попыток. Префикс `/api/v1/webhooks` целиком исключён из общего `apiLimiter`
 * (`app.ts`, `API_LIMIT_EXEMPT_PREFIXES` — «свой потолок у вебхуков внутри
 * роутера»), так что без этого лимитера угадывающий не встречал вообще ничего.
 * Окно и цифра — как у `reportLimiter` (backups.ts): 60 в час с запасом выше
 * любой мыслимой частоты настоящих оповещений Google (даже с учётом, что
 * Pub/Sub шлёт сообщение на каждое обновление расхода, а не только на порогах
 * — см. комментарий ниже).
 *
 * ОТВЕТ НА ПРЕВЫШЕНИЕ — ОБЫЧНЫЙ 429, А НЕ 200 `{ignored:true}` (в отличие от
 * ответа на неверный токен чуть ниже). Это не то же решение, и не нужно, чтобы
 * оно было тем же: 200 на неверный токен защищает от бесконечных повторов
 * Pub/Sub, если ЗАКОННЫЙ токен временно разойдётся (ротация в Настройках) — тут
 * ответчик именно Google, и его retry-политика на 4xx нам мешает. Превышение
 * ЖЕ лимита практически всегда — перебор скриптом, а не Pub/Sub: 60/час с
 * головой хватает настоящему трафику одной подписки, и уж тем более редким
 * оповещениям о пороге. У такого запроса ретрай-политика Pub/Sub ни при чём —
 * его никто не подтверждает и не отменяет ответом. Поэтому здесь повторяем
 * поведение `leadWebhookLimiter` (webhooks.ts): обычный 429 с коротким текстом,
 * без специального `handler`.
 */
const budgetWebhookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов, попробуйте позже" },
});

/** Тело push-сообщения Pub/Sub: полезная нагрузка лежит в base64 внутри message.data. */
const pushSchema = z.object({
  message: z.object({
    data: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
    messageId: z.string().optional(),
  }),
});

// Pub/Sub push — доставка «минимум один раз»: то же сообщение может прийти
// повторно (сеть, наш же 5xx, таймаут). Без дедупликации директор получит
// одно и то же «потрачено N% бюджета» уведомление несколько раз подряд.
// Отметка живёт в БД (lib/webhookDedupe.ts, как у всех остальных вебхуков), а не
// в памяти процесса: API деплоится по многу раз в сутки, и Map после каждого
// рестарта была пуста — Pub/Sub повторяет недоставленное часами, и то же
// оповещение приходило директору снова (до 26.08.2026 этот канал единственный
// жил мимо общей таблицы ProcessedMessage).

/** Полезная нагрузка бюджетного оповещения Google (то, что внутри data). */
const budgetSchema = z.object({
  budgetDisplayName: z.string().optional(),
  costAmount: z.number().optional(),
  budgetAmount: z.number().optional(),
  currencyCode: z.string().optional(),
  alertThresholdExceeded: z.number().optional(),
});

budgetWebhookRouter.post("/google-budget", budgetWebhookLimiter, async (req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { googleBudgetToken: true },
  });
  const expected = settings?.googleBudgetToken?.trim() || process.env.GOOGLE_BUDGET_TOKEN || "";
  const given = typeof req.query.token === "string" ? req.query.token : "";
  // Отвечаем 200 даже на чужой запрос: Pub/Sub на 4xx повторяет доставку часами,
  // и открытый адрес превратился бы в источник бесконечных ретраев. Сравнение —
  // в постоянное время, как у всех остальных вебхуков (secretsMatch).
  if (!expected || !secretsMatch(given, expected)) return res.status(200).json({ ignored: true });

  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) return res.status(200).json({ ignored: true });

  const messageId = parsed.data.message.messageId;
  if (messageId && (await isDuplicateDelivery("GOOGLE_BUDGET", messageId))) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  // Разбор и доставка разведены нарочно: битое сообщение (не разобралось) —
  // постоянный случай, его повторять бессмысленно, отвечаем 200 и держим отметку.
  // А вот сбой доставки уведомления — временный: снимаем отметку и отвечаем 500,
  // чтобы Pub/Sub повторил доставку (раньше любой сбой получал 200, Pub/Sub
  // подтверждал доставку, и оповещение терялось без повтора).
  let payload: z.infer<typeof budgetSchema>;
  try {
    const raw = parsed.data.message.data
      ? Buffer.from(parsed.data.message.data, "base64").toString("utf8")
      : "{}";
    payload = budgetSchema.parse(JSON.parse(raw));
  } catch (err) {
    void logSystemError("api", `Бюджетное оповещение Google не разобрано: ${err instanceof Error ? err.message : err}`);
    // Держим отметку насовсем (см. комментарий выше) — отмечаем завершённой,
    // иначе через STALE_AFTER_MS (lib/webhookDedupe.ts) она считалась бы
    // зависшей и то же битое сообщение разбиралось бы заново при каждом повторе.
    if (messageId) void markProcessedMessageComplete("GOOGLE_BUDGET", messageId);
    return res.status(200).json({ ignored: true });
  }

  try {
    const cost = payload.costAmount ?? 0;
    const budget = payload.budgetAmount ?? 0;
    const currency = payload.currencyCode ?? "USD";
    const share = budget > 0 ? Math.round((cost / budget) * 100) : 0;
    const name = payload.budgetDisplayName ?? "Google Cloud";

    // Google шлёт сообщение на каждое обновление расхода, а не только на порогах.
    // Беспокоим человека только когда порог реально перейдён.
    if (!payload.alertThresholdExceeded) {
      if (messageId) void markProcessedMessageComplete("GOOGLE_BUDGET", messageId);
      return res.status(200).json({ ok: true, noted: true });
    }

    const recipients = await prisma.agent.findMany({
      where: { isActive: true, role: { in: ["DIRECTOR", "ADMIN"] } },
      select: { id: true },
    });
    await createNotifications(
      recipients.map((r) => r.id),
      {
        kind: "finance",
        title: `Google Cloud: потрачено ${share}% бюджета`,
        body: `${name}: ${cost.toFixed(2)} ${currency} из ${budget.toFixed(2)} ${currency}. Сверьте со строкой «расходы на ИИ» в Финансах.`,
        url: "/finance",
      }
    );
    if (messageId) void markProcessedMessageComplete("GOOGLE_BUDGET", messageId);
    res.status(200).json({ ok: true });
  } catch (err) {
    void logSystemError("api", `Бюджетное оповещение Google не доставлено: ${err instanceof Error ? err.message : err}`);
    if (messageId) void releaseProcessedMessage("GOOGLE_BUDGET", messageId);
    res.status(500).json({ error: "Повторите доставку" });
  }
});
