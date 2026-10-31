import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { parseNoteSchema, assistantRequestSchema, assistantAuditQuerySchema, propertyHasCondition, visiblePropertyFacts } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadHotScoreThreshold } from "../lib/hotScoreThreshold.js";
import { can, canAccessAssignedAgent, requireAuth, requirePermission, scopeDealsToOwnAgent, scopeToOwnAgent } from "../auth/middleware.js";
import { clientNamePhoneSafe, phoneSafeText } from "../lib/clientPhone.js";
import { callAiText, type ImageInput } from "../ai/client.js";
import { loadMoneyContext, toTjs } from "../lib/money.js";
import { dushanbeWallClock } from "../lib/dushanbeTime.js";
import { thumbsDir } from "../upload.js";
import { scoreClient } from "../ai/scoring.js";
import { buildCardFillSuggestion } from "../ai/cardFill.js";
import { buildPropertyDraftSuggestion } from "../ai/propertyDraft.js";
import { ASSISTANT_ERROR_MESSAGES, isAiAssistantEnabled, runAssistantDetailed } from "../ai/assistant.js";
import { formatPrice, stripDashes } from "../ai/seoGenerator.js";
import { TG_PREFIX } from "./conversations.js";
import { agentSpeechLimiter } from "../lib/agentSpeechLimiter.js";

export const aiRouter = Router();

/**
 * Fix 3b (13.09.2026, аудит надёжности): `rateLimit` был импортирован сверху,
 * но нигде в этом файле не применялся — судя по всему, недоделанное намерение.
 * Каждый маршрут ниже — платный вызов ИИ (ассистент читает и пишет данные CRM
 * изнутри модели, генерация объявления/карточки — токены и время), и без
 * лимитера один агент (скрипт, зависший таб, шальной цикл на фронте) мог гонять
 * его без всякого потолка — тот же класс дыры, что и у улучшения фото (Fix 3a).
 *
 * КЛЮЧ — id АГЕНТА, не IP: тот же приём и та же причина, что у apiLimiter в
 * app.ts (весь офис агентства сидит за одним внешним адресом; лимит по IP
 * делился бы на всех разом). Маршруты уже стоят за requireAuth, так что
 * req.agent к моменту лимитера всегда заполнен.
 *
 * ОКНО И ЧИСЛА — на глаз, не согласованная с владельцем квота (см. также
 * agentAiActionCap.ts): 40/час ассистенту — это по одному сообщению в
 * полторы минуты весь рабочий день, живой диалог столько не производит;
 * второй лимитер (вдвое строже) — на действия, которые запускаются реже
 * одного взгляда на карточку (генерация объявления/заполнение карточки).
 */
const assistantLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `agent:${req.agent!.id}`,
  message: { error: "Слишком много запросов к ИИ-ассистенту за час, подождите" },
});
// Платный вызов модели: свой потолок на сотрудника (находка №149).
const parseNoteLimiter = agentSpeechLimiter("на разбор заметки");

const aiGenerationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `agent:${req.agent!.id}`,
  message: { error: "Слишком много ИИ-генераций за час, подождите" },
});

/**
 * ИИ-ассистент: диалог с доступом к данным CRM (поиск, сводки, задачи по просьбе).
 *
 * SSE (план B3, docs/ai-bots-audit-13-09.md): вместо одного JSON-ответа в конце
 * отдаём поток событий `status` (пошаговые статусы раундов/тулов — см.
 * runAssistant/onStatus в ai/assistant.ts) и финальный `done`/`error`. Заголовки —
 * по образцу routes/events.ts:130-137. Полный токен-стриминг Gemini-ответа не
 * делается — `:streamGenerateContent` в проекте не используется нигде, это
 * отдельная и более рискованная задача (частичный JSON тул-коллов).
 */
aiRouter.post("/assistant", requireAuth, assistantLimiter, async (req, res) => {
  // Рубильник (Настройки → ИИ). Выключен по умолчанию: разделом пока никто не
  // пользуется, а каждый его вызов — это токены и доступ к данным CRM изнутри
  // модели. Проверка стоит на СЕРВЕРЕ, а не только в интерфейсе: спрятанная кнопка
  // защищает от случайного нажатия, а не от запроса. Та же функция, что и
  // повторная проверка внутри цикла раундов (задача 4) — одна логика, не две копии.
  if (!(await isAiAssistantEnabled())) {
    return res.status(403).json({ error: "ИИ-ассистент выключен в Настройках" });
  }

  const parsed = assistantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx буферизует ответы по умолчанию — без этого заголовка статусы копятся в
  // проксе и приезжают пачкой в конце, тот же приём, что и в routes/events.ts.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const sendEvent = (event: "status" | "done" | "error", data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  /**
   * КЛИЕНТ УШЁЛ — РАУНДЫ ОСТАНАВЛИВАЮТСЯ (31.10.2026, пачка П1 задача 1.1).
   * Раньше закрытая панель не значила ничего: сервер дорабатывал все раунды и жёг
   * квоту Gemini на ответ, который некому показать. Слушаем `res`, а не `req`:
   * у входящего запроса событие close в Node 16+ приходит, как только прочитано
   * ТЕЛО (а express.json() читает его ещё до этого обработчика), то есть означало
   * бы «отменить сразу». У ответа close — это закрытие соединения; если ответ к
   * этому моменту уже дописан, отменять нечего.
   */
  const clientGone = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) clientGone.abort();
  });

  try {
    const outcome = await runAssistantDetailed(
      parsed.data.messages,
      {
        id: req.agent!.id,
        role: req.agent!.role,
        canViewAllClients: req.agent!.can("clients.viewAll"),
        // Ассистент ходит в базу под правами вызвавшего — включая право на телефон.
        canViewPhone: req.agent!.can("clients.viewPhone"),
        // Те же права, что закрывают REST /reports и /expenses — get_lead_sources и
        // get_finance_summary обязаны отказывать ровно тем же, кому отказывает интерфейс.
        canViewReports: req.agent!.can("reports.view"),
        canViewFinance: req.agent!.can("finance.view"),
        // Сделки — своим правом (deals.viewAll), а не правом на клиентов: на экране
        // «Сделки» их скоупит именно оно (scopeDealsToOwnAgent).
        canViewAllDeals: req.agent!.can("deals.viewAll"),
      },
      { onStatus: (message) => sendEvent("status", { message }), signal: clientGone.signal },
    );
    if (outcome.ok) {
      sendEvent("done", { reply: outcome.reply });
    } else if (outcome.code !== "aborted") {
      // Код и «повтор поможет» — рядом с текстом (задача 1.2): интерфейс решает по
      // ним, предлагать ли «Повторить», а не гадает по строке.
      sendEvent("error", {
        error: ASSISTANT_ERROR_MESSAGES[outcome.code],
        code: outcome.code,
        retryable: outcome.retryable,
      });
    }
  } catch (err) {
    // runAssistant само ловит и логирует свои ошибки (logSystemError) и штатно не
    // бросает наружу — эта ветка на непредвиденный throw, чтобы соединение не
    // зависло без единого события (клиент иначе ждал бы `done` бесконечно).
    console.error("[ai:assistant:sse]", err instanceof Error ? err.message : err);
    sendEvent("error", { error: ASSISTANT_ERROR_MESSAGES.internal, code: "internal", retryable: true });
  } finally {
    res.end();
  }
});

const ASSISTANT_AUDIT_PAGE_SIZE = 50;

/** Аргументы ассистента почти всегда несут clientId (см. функции-инструменты
 *  выше — get_client_summary, log_interaction и т.п.), но записан только
 *  усечённый до 500 символов JSON аргументов (aiAssistantAudit.ts), а не
 *  отдельное поле в модели — заводить под него миграцию ради одного столбца
 *  в интерфейсе не стоит. Разбор лучшим усилием: обрезанный JSON не парсится
 *  молча, без него просто нет колонки «клиент» у этой строки. */
function extractClientIdFromArgsSummary(argsSummary: string | null): string | null {
  if (!argsSummary) return null;
  try {
    const parsed: unknown = JSON.parse(argsSummary);
    if (parsed && typeof parsed === "object" && "clientId" in parsed) {
      const clientId = (parsed as { clientId?: unknown }).clientId;
      if (typeof clientId === "string" && clientId.length > 0) return clientId;
    }
  } catch {
    // Усечение до 500 символов иногда режет JSON посередине — не роняем запрос.
  }
  return null;
}

/**
 * Журнал обращений к ИИ-ассистенту (aiAssistantAudit.ts, модель
 * AiAssistantAuditLog) — писался с самого начала (`logAssistantToolCall`,
 * вызывается один раз в цикле инструментов в runAssistant), но до сих пор ни
 * один маршрут его не читал. Кто из сотрудников каким инструментом
 * пользовался и по какому клиенту — не механизм защиты (её роль играет
 * `ownScope` внутри runTool на каждом инструменте), а прослеживаемость на
 * случай подозрения, что кто-то собирает через ассистента чужие данные.
 *
 * ДОСТУП — то же право, что у «Здоровья системы» и аудита бота
 * (`auditLog.view`, routes/errorLog.ts, routes/botAudit.ts): это тот же
 * служебный раздел «журналы», отдельное право под один экран не заводим.
 * По ролям это ADMIN (входит в ASSIGNABLE_PERMISSIONS) и DIRECTOR (всегда
 * все права) — как и остальные журналы.
 *
 * Пагинация и период — те же кирпичи, что у ленты активности
 * (`assistantAuditQuerySchema` = `dateRangeQuerySchema` + `page` + `agentId`,
 * см. packages/shared/src/querySchemas.ts).
 */
aiRouter.get("/assistant-audit", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = assistantAuditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const { page, agentId, from, to } = parsed.data;

  const where = {
    ...(agentId ? { agentId } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.aiAssistantAuditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * ASSISTANT_AUDIT_PAGE_SIZE,
      take: ASSISTANT_AUDIT_PAGE_SIZE,
      include: { agent: { select: { id: true, fullName: true } } },
    }),
    prisma.aiAssistantAuditLog.count({ where }),
  ]);

  // Один запрос на всех клиентов страницы, а не N+1 внутри map — та же экономия,
  // что и у include в интеракциях/сделках чуть выше по файлу.
  const clientIds = Array.from(
    new Set(rows.map((r) => extractClientIdFromArgsSummary(r.argsSummary)).filter((id): id is string => id !== null))
  );
  const clients = clientIds.length
    ? await prisma.client.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, shortId: true, fullName: true },
      })
    : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));

  res.json({
    items: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      tool: r.tool,
      argsSummary: r.argsSummary,
      resultCount: r.resultCount,
      agent: r.agent,
      client: clientById.get(extractClientIdFromArgsSummary(r.argsSummary) ?? "") ?? null,
    })),
    total,
    page,
    pageSize: ASSISTANT_AUDIT_PAGE_SIZE,
  });
});

/** 7.1 — разбор свободного текста заметки в структурированные поля. Никогда не сохраняет без подтверждения агента. */
aiRouter.post("/parse-note", requireAuth, parseNoteLimiter, async (req, res) => {
  const parsed = parseNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { text, clientId } = parsed.data;

  const [client, districts] = await Promise.all([
    // deletedAt: null — клиент из Корзины для остальных маршрутов карточки даёт 404
    // (находка №157); здесь он проходил, и его данные уходили в модель.
    prisma.client.findFirst({ where: { id: clientId, deletedAt: null } }),
    prisma.district.findMany({ select: { name: true } }),
  ]);
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  // «Сегодня» — по Душанбе, не по UTC: с 00:00 до 05:00 местного UTC-дата ещё
  // вчерашняя, и модель переводила «завтра»/«в четверг» со сдвигом на день.
  const today = dushanbeWallClock().toISOString().slice(0, 10);

  const result = await callAiText<{
    interaction: {
      type: string;
      outcome?: string;
      notes: string;
      nextAction?: string;
      nextActionDate?: string;
    };
    clientUpdates: {
      budgetMin?: number;
      budgetMax?: number;
      desiredDistrict?: string;
      desiredRooms?: number;
      requirementsNotes?: string;
    };
  }>({
    endpoint: "parse-note",
    system:
      "Ты — ассистент риелторского агентства Royal Home в Душанбе. Разбери заметку агента о разговоре с клиентом. " +
      "КРИТИЧЕСКИ ВАЖНО: используй только факты, явно присутствующие в тексте заметки. Никогда не выдумывай " +
      "детали, эмоции или события, которых нет в исходном тексте — если что-то не упомянуто, оставляй null. " +
      `Сегодняшняя дата: ${today} — используй её, чтобы перевести относительные даты ("завтра", "в четверг") в формат YYYY-MM-DD. ` +
      `Известные районы агентства: ${districts.map((d) => d.name).join(", ")} — если в тексте назван один из них, укажи его точно в этом написании. ` +
      "Если упомянуто несколько районов, укажи только ПЕРВЫЙ названный (desiredDistrict — это одно значение, не список).\n" +
      "Ответь СТРОГО в формате JSON без markdown: " +
      '{"interaction":{"type":"CALL|MESSAGE|MEETING|SHOWING","outcome":"POSITIVE|NEUTRAL|NEGATIVE|NO_ANSWER","notes":"краткое фактическое резюме","nextAction":"следующий шаг или null","nextActionDate":"YYYY-MM-DD или null"},' +
      '"clientUpdates":{"budgetMin":число или null,"budgetMax":число или null,"desiredDistrict":"название района или null","desiredRooms":число или null,"requirementsNotes":"текст или null"}}',
    user: `Текущие данные клиента: бюджет ${client.budgetMin ?? "?"}-${client.budgetMax ?? "?"}, район ${client.desiredDistrictId ?? "не указан"}.\n\nЗаметка агента: ${text}`,
    // Ответ — фиксированный JSON из десятка коротких полей (резюме заметки плюс
    // правки карточки), 600 токенов покрывают его с запасом. Без явного числа
    // ушёл бы дефолт 4096 (geminiClient.ts): разбор заметки вызывается на каждой
    // диктовке агента, и оплаченный «запас в семь раз» тут ничего не даёт.
    maxTokens: 600,
  });

  if (!result) {
    return res.json({
      interaction: { type: "CALL", notes: text },
      clientUpdates: {},
      degraded: true,
    });
  }
  res.json(result);
});

/**
 * Предложение по заполнению карточки со слов клиента (пакет владельца 31.07, п. 5).
 * Ничего не сохраняет — агент подтверждает поля шагами в мастере и жмёт «Сохранить»,
 * который уходит обычным PATCH /clients/:id.
 *
 * POST, а не GET: под капотом платный вызов модели, и повторять его на каждом
 * возврате фокуса в окно (как это делает кэш запросов на GET) незачем.
 */
aiRouter.post("/card-fill/:clientId", requireAuth, aiGenerationLimiter, async (req, res) => {
  const parsed = z.guid().safeParse(req.params.clientId);
  if (!parsed.success) return res.status(400).json({ error: "Неверный идентификатор клиента" });

  const client = await prisma.client.findUnique({
    where: { id: parsed.data },
    select: { id: true, assignedAgentId: true, acceptedAt: true, deletedAt: true },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // До принятия лида карточка агенту закрыта (PATCH /clients/:id ответил бы 403) —
  // подсказывать заполнение того, что он всё равно не сохранит, смысла нет.
  if (scopeToOwnAgent(req) && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  // Цитаты клиента, заметка — его же слова, номер в них звучит открыто. Тем же
  // правом, что поле phone (глубокая проверка 02.10.2026, A6).
  const canSeePhone = can(req, "clients.viewPhone");
  const fill = await buildCardFillSuggestion(client.id);
  res.json({
    ...fill,
    notes: phoneSafeText(fill.notes, canSeePhone),
    evidence: fill.evidence.map((quote) => phoneSafeText(quote, canSeePhone)),
  });
});

/**
 * Черновик карточки ОБЪЕКТА по переписке и звонкам с ПРОДАВЦОМ (задача K, план
 * docs/audit-02-09-2026/19-plan-03-09-evening.md). Ничего не создаёт и не
 * сохраняет — агент подтверждает/правит поля в форме создания объекта
 * (PropertyFormModal) и жмёт обычное «Сохранить», которое уходит POST /properties.
 *
 * POST, а не GET — тот же довод, что и у card-fill: платный вызов модели,
 * повторять на каждый фокус в форму незачем.
 */
aiRouter.post("/property-draft/:clientId", requireAuth, aiGenerationLimiter, async (req, res) => {
  const parsed = z.guid().safeParse(req.params.clientId);
  if (!parsed.success) return res.status(400).json({ error: "Неверный идентификатор клиента" });

  const client = await prisma.client.findUnique({
    where: { id: parsed.data },
    select: { id: true, kind: true, assignedAgentId: true, acceptedAt: true, deletedAt: true },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  // Черновик собирается из ПЕРЕПИСКИ С ПРОДАВЦОМ о ЕГО объекте — у покупателя этих
  // данных просто нет и быть не может (у него в переписке требования к покупке,
  // не параметры объекта на продажу).
  if (client.kind !== "SELLER") {
    return res.status(400).json({ error: "Черновик из переписки доступен только для продавца" });
  }
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // До принятия лида карточка агенту закрыта — тот же гейт, что и у card-fill.
  if (scopeToOwnAgent(req) && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  // Адрес «со слов продавца» и цитаты — свободный текст (A6, см. card-fill выше).
  const canSeePhone = can(req, "clients.viewPhone");
  const draft = await buildPropertyDraftSuggestion(client.id);
  res.json({
    ...draft,
    address: phoneSafeText(draft.address, canSeePhone),
    evidence: draft.evidence.map((quote) => phoneSafeText(quote, canSeePhone)),
  });
});

const generateListingSchema = z.object({
  propertyId: z.guid(),
  language: z.enum(["ru", "tj"]).default("ru"),
});

const GENERATE_LISTING_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 3,
      description: "3 разных по формулировке варианта описания, каждый 400-600 знаков",
    },
  },
  required: ["variants"],
};

/** До 5 фото (по порядку, обложка первая) — миниатюры 800px достаточно модели,
 * чтобы описать реальный вид/ремонт/планировку, а не гадать по цифрам. Полноразмерные
 * оригиналы для этого избыточны и дороже по токенам. Отсутствующий файл на диске
 * (не должно случаться, но диск — внешний мир) просто пропускаем, а не роняем запрос. */
async function loadListingPhotos(propertyId: string): Promise<ImageInput[]> {
  const photos = await prisma.propertyPhoto.findMany({
    where: { propertyId },
    orderBy: { order: "asc" },
    take: 5,
  });
  const images: ImageInput[] = [];
  for (const photo of photos) {
    try {
      const buf = await fs.readFile(path.join(thumbsDir, path.basename(photo.thumbUrl)));
      images.push({ mediaType: "image/webp", data: buf.toString("base64") });
    } catch {
      // Файл пропал с диска — не блокируем генерацию, просто без этого фото.
    }
  }
  return images;
}

/**
 * Подпись под Reels больше не генерируется здесь через ИИ (решение владельца
 * 04.08.2026: шаблоны вместо вызова модели — дешевле и мгновенно). Генерация при
 * создании объекта и кнопка «Перегенерировать» — POST /properties/:id/regenerate-caption
 * (routes/properties.ts, lib/reelsCaptionTemplate.ts). Маршрут `/reels-caption`
 * убран целиком, а не оставлен как мёртвый код.
 */

/** 7.3 — генерация текста объявления, 3 варианта. ADMIN/DIRECTOR only: описание идёт
 * на публичный сайт, рядовой агент не должен публиковать текст за чужие объекты. */
aiRouter.post("/generate-listing", requireAuth, requirePermission("properties.aiListing"), aiGenerationLimiter, async (req, res) => {
  const parsed = generateListingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const property = await prisma.property.findUnique({
    where: { id: parsed.data.propertyId },
    include: { district: true },
  });
  if (!property) return res.status(404).json({ error: "Объект не найден" });

  const isTajik = parsed.data.language === "tj";
  const languageName = isTajik ? "таджикском (тоҷикӣ, кириллица, не транслитерация с русского)" : "русском";
  const images = await loadListingPhotos(property.id);

  // Всегда сомони в тексте для сайта (владелец, 16.09.2026) — той же причине,
  // что в routes/properties/crud.ts: сайт показывает цену только в сомони,
  // а "$" в описании USD-объекта раньше блокировал публикацию КАЖДОГО такого
  // объекта на siteSync.ts (гейт против "доллар"/"$"/USD в тексте).
  const listingMoney = await loadMoneyContext();
  const listingPriceTjs = toTjs(property.price, property.currency, listingMoney);
  // Поля, которых у типа нет (этаж у дома, комнаты у участка), в текст не идут
  // (propertyTypeFields.ts, владелец 08.10.2026).
  const shownFacts = visiblePropertyFacts(property);
  const facts = [
    `Тип: ${property.type}`,
    shownFacts.rooms ? `Комнат: ${shownFacts.rooms}` : "",
    `Площадь: ${property.areaSqm} м²`,
    shownFacts.floor && shownFacts.totalFloors ? `Этаж: ${shownFacts.floor} из ${shownFacts.totalFloors}` : "",
    shownFacts.floor == null && shownFacts.totalFloors ? `Этажей в доме: ${shownFacts.totalFloors}` : "",
    `Цена: ${formatPrice(listingPriceTjs, "TJS")}`,
    `Район: ${property.district?.name ?? "не указан"}`,
    `Адрес: ${property.address ?? "не указан"}`,
    propertyHasCondition(property.type) ? `Состояние: ${property.condition}` : "",
    property.amenities.length ? `Удобства: ${property.amenities.join(", ")}` : "",
    // urgent явно как факт — без него модель раньше сама придумывала "срочная
    // продажа" как расхожий рекламный штамп, даже когда объект спокойно продаётся.
    `Срочная продажа: ${property.urgent ? "да" : "нет"}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await callAiText<{ variants: string[] }>({
    endpoint: "generate-listing",
    system:
      // В самом промте тире тоже нет: модель копирует пунктуацию инструкции,
      // и запрет, написанный через тире, работает заметно хуже.
      "Ты профессиональный SEO-копирайтер риелторского агентства Royal Home в Душанбе (Таджикистан). " +
      `Напиши 3 разных варианта продающего описания объекта на ${languageName} языке, каждый 400-600 знаков. ` +
      "Требования:\n" +
      "1. КРИТИЧЕСКИ ВАЖНО, только правда: используй ТОЛЬКО факты из параметров ниже и то, что реально видно на " +
      "приложенных фото (ремонт, вид из окна, состояние стен/пола/мебели). Никогда не выдумывай преимущества, " +
      "срочность, скидки или детали, которых нет в фактах и не видно на фото. Это обман клиента.\n" +
      '«Срочная продажа: нет» означает, что фразу «срочно/срочная продажа» использовать НЕЛЬЗЯ ни в каком виде.\n' +
      "2. SEO: естественно, без переспама, вплети в текст район, город (Душанбе) и тип объекта (например «квартира " +
      "в Шохмансуре», «дом в Душанбе»), так, как реально ищут покупатели, без списков ключевых слов.\n" +
      "3. НИКОГДА не используй длинное тире (—) и среднее тире (–): по ним текст сразу читается как " +
      "написанный машиной. Вместо них ставь запятую, точку или двоеточие. Дефис внутри слов " +
      "(«3-комнатная») разрешён.\n" +
      "4. Тон деловой и уверенный, как у профессионального агентства. Грамотный литературный язык. " +
      "Ни разговорщины («однушка», «шикарный», восклицательные знаки, эмодзи), ни канцелярита " +
      "(«данный объект», «осуществляется продажа», «является»). Опирайся на цифры и факты, а не на " +
      "прилагательные. Без общих фраз ни о чём («уникальное предложение», «не упустите шанс»).\n" +
      "5. Цену пиши ровно так, как она передана в параметрах («340 000 с.» или «$40 000»). Коды валют " +
      "(TJS, USD) не употребляй никогда.\n" +
      "6. Если в адресе есть узнаваемый ориентир (номер микрорайона вида «91 мкр», улица, посёлок), " +
      "обязательно упомяни его: покупатели ищут именно так. Номер дома и квартиры не пиши.\n" +
      (isTajik
        ? "7. Пиши на литературном таджикском языке (не калька с русского порядка слов), с правильными терминами " +
          "недвижимости, не переводи риелторские штампы дословно.\n"
        : "") +
      "Ответь СТРОГО через инструмент submit_reply с полем variants, ровно 3 строки.",
    user: `Параметры объекта:\n${facts}${images.length ? "\n\n(см. приложенные фото объекта)" : ""}`,
    images,
    maxTokens: 1500,
    schema: GENERATE_LISTING_SCHEMA,
  });

  if (!result) {
    return res.status(503).json({ error: "AI недоступен, попробуйте позже" });
  }
  // Подстраховка поверх запрета в промте: тире модель изредка ставит всё равно,
  // а этот текст идёт прямиком на публичный сайт.
  res.json({ variants: (result.variants ?? []).map(stripDashes) });
});

/** 7.2 — скоринг одного клиента (ручной запуск; тот же код гоняет ночной cron для всех активных клиентов). */
aiRouter.post("/score/:clientId", requireAuth, async (req, res) => {
  const parsedClientId = z.guid().safeParse(req.params.clientId);
  if (!parsedClientId.success) return res.status(400).json({ error: "Неверный идентификатор клиента" });

  const client = await prisma.client.findUnique({ where: { id: parsedClientId.data } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (!["NEW", "CONTACTED", "HOT"].includes(client.status)) {
    return res.status(400).json({ error: "Скоринг доступен только для NEW/CONTACTED/HOT" });
  }

  const result = await scoreClient(client.id);
  if (!result) {
    return res.status(503).json({ error: "AI недоступен, попробуйте позже" });
  }
  res.json(result);
});

/** 7.2 (инсайты вероятной сделки) + 7.5 (простаивающие объекты) + доп. сигналы —
 *  для правой панели дашборда. Каждая категория — независимая эвристика по уже
 *  имеющимся полям (без новых миграций); порог по времени у каждой свой, подобран
 *  под то, как быстро в реальности должно что-то происходить на этом этапе. */
aiRouter.get("/insights", requireAuth, async (req, res) => {
  const ownAgentId = scopeToOwnAgent(req);
  const hotScoreThreshold = await loadHotScoreThreshold();
  const [
    likelyDeals,
    staleProperties,
    forgottenClients,
    overdueTasks,
    staleSellers,
    unseenProperties,
    stuckDeals,
    hotWithoutDeal,
  ] = await Promise.all([
    prisma.client.findMany({
      where: {
        aiScore: { gte: hotScoreThreshold },
        // deletedAt — карточка из Корзины по REST даёт 404, а в инсайтах продолжала
        // висеть: клик по подсказке вёл на несуществующего клиента.
        deletedAt: null,
        status: { notIn: ["HOT", "DEAL_CLOSED", "ARCHIVED"] },
        ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}),
      },
      orderBy: { aiScore: "desc" },
      take: 3,
      select: { id: true, shortId: true, fullName: true, aiScore: true, aiScoreReason: true },
    }),
    computeStalePropertyInsights(ownAgentId),
    computeForgottenClients(ownAgentId),
    computeOverdueTasks(ownAgentId),
    computeStaleSellers(ownAgentId),
    computeUnseenProperties(),
    // Сделки скоупит право на СДЕЛКИ (deals.viewAll), а не на клиентов (находка №157):
    // точечная галочка «все клиенты» не должна открывать чужие сделки.
    computeStuckDeals(scopeDealsToOwnAgent(req)),
    computeHotWithoutDeal(ownAgentId),
  ]);

  /**
   * Причина оценки — пересказ переписки от модели, и номер клиента попадает в неё
   * тем же путём, что и в сводку «Коротко ИИ» (см. ai/scoring.ts). Здесь карточка
   * отдаётся МИМО presentClient, где это правило живёт, — значит его надо позвать
   * руками (владелец 30.08.2026).
   */
  const canSeePhone = can(req, "clients.viewPhone");
  // Все категории несут имя карточки, а часть — свободный текст (причина оценки,
  // следующий шаг): у карточек незнакомых звонивших номер лежит в имени, и роут
  // открыт только requireAuth — доступен любому агенту (22.09.2026). Раньше
  // маску звал лишь likelyDeals; остальные шли сырыми. Правило — lib/clientPhone.ts.
  const mn = <T extends { fullName: string }>(c: T): T =>
    canSeePhone ? c : { ...c, fullName: clientNamePhoneSafe(c.fullName, false) };
  res.json({
    likelyDeals: likelyDeals.map((c) => ({
      ...c,
      fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
      aiScoreReason: phoneSafeText(c.aiScoreReason, canSeePhone),
    })),
    staleProperties,
    forgottenClients: forgottenClients.map(mn),
    overdueTasks: overdueTasks.map((t) => ({ ...mn(t), nextAction: phoneSafeText(t.nextAction, canSeePhone) })),
    staleSellers: staleSellers.map(mn),
    unseenProperties,
    stuckDeals: stuckDeals.map((d) =>
      canSeePhone ? d : { ...d, clientFullName: clientNamePhoneSafe(d.clientFullName, false) }
    ),
    hotWithoutDeal: hotWithoutDeal.map(mn),
  });
});

/**
 * СТОИМОСТЬ ИИ ПО ОДНОМУ РАЗГОВОРУ/ЗВОНКУ (13.09.2026, владелец: «стоимость
 * реально считается, но нигде не видна — ни по конкретному разговору, ни даже
 * общий дневной агрегат»). `conversationId` — Conversation.id мессенджера или
 * channelId звонка живого голоса (см. logAiCall в ai/shared.ts и
 * lib/telephony/liveVoiceBridge.ts) — AiLog не хранит на них FK (разные
 * таблицы, оба должны пережить удаление собеседника), поэтому сумма всегда
 * считается на лету, а не читается из готового поля.
 *
 * Право finance.view, не requireAuth-по-умолчанию: это служебная финансовая
 * цифра для директора/руководителя, не для рядового агента (тот же рубильник,
 * что у /finance/*, см. permissions.ts).
 *
 * `conversationId` приходит и голым (панель карточки клиента, ClientChatPanel —
 * у неё это буквально id из AiLog, см. её докстринг), и с "tg_"-префиксом
 * (мобильный инбокс, MobileChatView — берёт id из общего списка /conversations,
 * где Telegram-диалоги ВСЕГДА префиксованы, TG_PREFIX). AiLog эту логику не
 * знает вовсе — logAiCall (ai/shared.ts) для Telegram пишет голый
 * TelegramConversation.id (см. jobs/telegramReplyRetry.ts), поэтому префикс
 * снимаем здесь же, перед агрегатом, а не заставляем каждого вызывающего
 * помнить, что нужна именно голая форма — найдено 17.09.2026 при разборе
 * похожего рассинхрона у POST /conversations/:id/translate.
 */
aiRouter.get("/cost", requireAuth, requirePermission("finance.view"), async (req, res) => {
  const rawId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
  if (!rawId) return res.status(400).json({ error: "conversationId обязателен" });
  const conversationId = rawId.startsWith(TG_PREFIX) ? rawId.slice(TG_PREFIX.length) : rawId;
  const agg = await prisma.aiLog.aggregate({
    where: { conversationId },
    _sum: { costUsd: true },
    _count: true,
  });
  res.json({
    // null — ни одного вызова с известной ценой модели не было (см. estimateCostUsd),
    // не "бесплатно": ноль в отчёте про деньги должен значить именно ноль.
    costUsd: agg._sum.costUsd != null ? Number(agg._sum.costUsd) : null,
    callCount: agg._count,
  });
});

/** Нет контакта с клиентом дольше 10 дней, а карточка ещё не закрыта/архивирована —
 *  сигнал, что про него могли просто забыть (не про качество лида, как aiScore). */
async function computeForgottenClients(ownAgentId: string | undefined) {
  const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const clients = await prisma.client.findMany({
    where: {
      status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] },
      deletedAt: null,
      lastContactAt: { lte: cutoff },
      ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}),
    },
    orderBy: { lastContactAt: "asc" },
    take: 3,
    select: { id: true, shortId: true, fullName: true, status: true, lastContactAt: true },
  });
  return clients.map((c) => ({
    id: c.id,
    shortId: c.shortId,
    fullName: c.fullName,
    status: c.status,
    daysSinceContact: Math.floor((Date.now() - c.lastContactAt.getTime()) / 86400000),
  }));
}

/** Последнее взаимодействие с клиентом назначило следующий шаг (nextAction/
 *  nextActionDate), а срок уже прошёл, и ничего нового с тех пор не записано. */
async function computeOverdueTasks(ownAgentId: string | undefined) {
  const clients = await prisma.client.findMany({
    where: {
      status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] },
      deletedAt: null,
      ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}),
    },
    take: 500,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      interactions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { nextAction: true, nextActionDate: true, completedAt: true },
      },
    },
  });
  const now = Date.now();
  return clients
    .filter(
      (c) =>
        c.interactions[0]?.nextActionDate &&
        !c.interactions[0].completedAt &&
        c.interactions[0].nextActionDate!.getTime() <= now
    )
    .map((c) => ({
      id: c.id,
      shortId: c.shortId,
      fullName: c.fullName,
      nextAction: c.interactions[0].nextAction,
      daysOverdue: Math.floor((now - c.interactions[0].nextActionDate!.getTime()) / 86400000),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .slice(0, 3);
}

/** Продавец принят (accepted) 5+ дней назад, заявка всё ещё открыта — стоит
 *  проверить, снят ли объект/сделан ли прогресс (интейк-агент мог забыть отчитаться). */
async function computeStaleSellers(ownAgentId: string | undefined) {
  const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const sellers = await prisma.client.findMany({
    where: {
      kind: "SELLER",
      deletedAt: null,
      acceptedAt: { lte: cutoff },
      status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] },
      ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}),
    },
    orderBy: { acceptedAt: "asc" },
    take: 3,
    select: { id: true, shortId: true, fullName: true, acceptedAt: true },
  });
  return sellers.map((c) => ({
    id: c.id,
    shortId: c.shortId,
    fullName: c.fullName,
    daysSinceAccepted: Math.floor((Date.now() - c.acceptedAt!.getTime()) / 86400000),
  }));
}

/** Объект опубликован на сайте неделю+, а просмотров ноль — отдельный сигнал от
 *  «нет показов»: тут дело скорее в видимости/рекламе, чем в цене. */
async function computeUnseenProperties() {
  // 14 дней, не 7: viewsCount растёт только от записанных агентами ПОКАЗОВ
  // (Interaction SHOWING) — за одну неделю отсутствие показа ещё не сигнал.
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const properties = await prisma.property.findMany({
    where: { status: "AVAILABLE", deletedAt: null, publishedOnSite: true, viewsCount: 0, createdAt: { lte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: 3,
    select: { id: true, shortId: true, title: true, price: true, currency: true, createdAt: true },
  });
  return properties.map((p) => ({
    id: p.id,
    shortId: p.shortId,
    title: p.title,
    price: p.price,
    currency: p.currency,
    daysSincePublished: Math.floor((Date.now() - p.createdAt.getTime()) / 86400000),
  }));
}

/** Сделка открыта 14+ дней и не завершена/отменена — давно не двигается к финалу. */
async function computeStuckDeals(ownAgentId: string | undefined) {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const deals = await prisma.deal.findMany({
    where: {
      stage: { notIn: ["COMPLETED", "CANCELLED"] },
      startedAt: { lte: cutoff },
      ...(ownAgentId ? { agentId: ownAgentId } : {}),
    },
    orderBy: { startedAt: "asc" },
    take: 3,
    include: {
      property: { select: { shortId: true, title: true } },
      client: { select: { shortId: true, fullName: true } },
    },
  });
  return deals.map((d) => ({
    id: d.id,
    stage: d.stage,
    daysOpen: Math.floor((Date.now() - d.startedAt.getTime()) / 86400000),
    propertyShortId: d.property.shortId,
    propertyTitle: d.property.title,
    clientShortId: d.client.shortId,
    clientFullName: d.client.fullName,
  }));
}

/** Клиент горячий, а сделки для него ещё нет ни одной (кроме отменённых) — самое
 *  время завести. */
async function computeHotWithoutDeal(ownAgentId: string | undefined) {
  return prisma.client.findMany({
    where: {
      status: "HOT",
      deletedAt: null,
      deals: { none: { stage: { not: "CANCELLED" } } },
      ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}),
    },
    take: 3,
    select: { id: true, shortId: true, fullName: true },
  });
}

/**
 * ЛИЧНО АГЕНТУ — ТОЛЬКО ЕГО ОБЪЕКТЫ (docs/TASKS.md, «дашборд агента против ТЗ»
 * 07.09.2026). Остальные шесть категорий подсказок (likelyDeals, forgottenClients,
 * overdueTasks, staleSellers, stuckDeals, hotWithoutDeal) считались лично агенту
 * через `ownAgentId`, а «Объект простаивает» — по всему агентству: агент видел в
 * своей персональной панели чужой объект, на который он не может ни ответить, ни
 * повлиять. Признак личной ответственности за объект — `intakeAgentId` (тот, кто
 * принял объект у собственника), тот же, что у переключателя «Мои объекты» в
 * каталоге (routes/properties/list.ts): у объекта в статусе AVAILABLE
 * `assignedAgentId` не бывает заполнен — его проставляет сделка при RESERVED
 * (routes/deals.ts) и снимает обратно при возврате в AVAILABLE.
 *
 * Медиана цены за м² по району (allAvailable ниже) СЧИТАЕТСЯ ПО ВСЕМУ РЫНКУ, а не
 * только по своим объектам — это справочная величина «сколько стоит район», не
 * персональная подсказка, и сужать её до объектов одного агента исказило бы саму
 * оценку «дороже/дешевле рынка».
 */
async function computeStalePropertyInsights(ownAgentId: string | undefined) {
  const cutoff = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);

  const candidates = await prisma.property.findMany({
    // deletedAt + take: панель инсайтов открывается на каждый заход на дашборд, а
    // выборка шла без потолка — все доступные объекты со вложенными взаимодействиями.
    where: {
      status: "AVAILABLE",
      deletedAt: null,
      createdAt: { lte: cutoff },
      ...(ownAgentId ? { intakeAgentId: ownAgentId } : {}),
    },
    include: { district: true, interactions: { where: { type: "SHOWING" }, orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
    take: 300,
  });

  const stale = candidates.filter((p) => p.interactions.length === 0 || p.interactions[0].createdAt <= cutoff);

  const districtPrices = new Map<string, number[]>();
  const allAvailable = await prisma.property.findMany({
    where: { status: "AVAILABLE", deletedAt: null },
    select: { districtId: true, type: true, price: true, areaSqm: true, currency: true },
    // Потолок, как у выборки candidates выше: панель открывается при каждом заходе
    // на дашборд, а этот запрос читал ВСЕ объекты в продаже. Сортировка по свежести
    // не искажает медиану, а улучшает её: текущую цену рынка показывает свежий
    // листинг, а не выставленный год назад.
    orderBy: { createdAt: "desc" },
    take: 3000,
  });
  // Цена за м² считается в сомони: в районе достаточно одного долларового объекта,
  // чтобы медиана уехала на порядок, и объект показывался как «дороже рынка на 900%».
  const money = await loadMoneyContext();
  for (const p of allAvailable) {
    // Закрытый объект (offSite) может остаться без района вовсе — в разрезе
    // «медиана по району» ему считаться не с чем, пропускаем.
    if (!p.districtId) continue;
    // Площадь ноль — цена за метр бесконечна и сдвинула бы медиану; пропускаем.
    if (!(Number(p.areaSqm) > 0)) continue;
    const perSqm = toTjs(p.price, p.currency, money) / Number(p.areaSqm);
    // Район И ТИП (находка О9, 02.10.2026): участки и коммерция стоят за метр
    // совсем иначе, чем квартиры, и общая медиана показывала квартиру по рынку
    // «дороже рынка на сотни процентов». Сравниваем с объектами того же типа.
    const key = `${p.districtId}:${p.type}`;
    const arr = districtPrices.get(key) ?? [];
    arr.push(perSqm);
    districtPrices.set(key, arr);
  }

  return stale.slice(0, 3).map((p) => {
    const prices = (p.districtId ? districtPrices.get(`${p.districtId}:${p.type}`) : undefined)?.sort((a, b) => a - b) ?? [];
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
    const ownPerSqm = toTjs(p.price, p.currency, money) / Number(p.areaSqm);
    const diffPercent = median && Number.isFinite(ownPerSqm) ? Math.round(((ownPerSqm - median) / median) * 100) : null;
    return {
      id: p.id,
      shortId: p.shortId,
      title: p.title,
      price: p.price,
      currency: p.currency,
      district: p.district?.name ?? "Без района",
      daysSinceCreated: Math.floor((Date.now() - p.createdAt.getTime()) / 86400000),
      medianPricePerSqmInDistrict: median,
      diffPercent,
    };
  });
}
