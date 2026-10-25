import { Router } from "express";
import { BW, EW } from "../ai/wordBoundary.js";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { sanitizeStyleText } from "../ai/styleLearning.js";
import { buildShortReplySystem } from "../ai/leadQualifier.js";
import { callAiText } from "../ai/client.js";
import { EMPTY_LESSON, lessonDedupKey } from "../lib/botLessons.js";
import { groupKey, groupWhyPrefix } from "../lib/botAuditGroups.js";
import { dushanbeWallClock } from "../lib/dushanbeTime.js";
import { applyReplyFeedback, ReplyFeedbackError } from "../lib/replyFeedback.js";
import { logAudit } from "../lib/audit.js";
import { TG_PREFIX } from "./conversations.js";
import type { ConversationMessage } from "@royal-home/shared";

/**
 * «Тренажёр бота» (17.09.2026) — одна переписка, одно решение, применяется сразу.
 *
 * Ничего не хранит само: очередь СОБИРАЕТ элементы из трёх уже существующих
 * источников обучения бота (BotLesson без правила, BotAuditFinding без вердикта,
 * последние неоценённые ответы бота), а решения владельца применяются через уже
 * существующие ручки (`/conversations/:id/reply-feedback`, `PATCH /bot-learning`,
 * `POST /bot-audit/group/resolve`) — см. компонент `BotTrainer.tsx` на фронте.
 *
 * СКОРОСТЬ (владелец 17.09.2026, «ничего не должно зависать»): один запрос,
 * без N+1. Сырые случаи и находки берутся обычными findMany с пределом, а текст
 * переписки для контекста подгружается ОДНИМ батчем на все уникальные
 * conversationId сразу (loadConversationContexts ниже), а не по одному запросу
 * на элемент очереди.
 */
export const botTrainerRouter = Router();

/** Потолок группы находок, разбираемой одной кнопкой POST /decide (kind="finding",
 *  22.09.2026, класс «Пагинация»): группа по префиксу «why» ничем не ограничена
 *  по числу и не привязана к окну времени. Тот же приём, что «Разобрать все» в
 *  siteNotifications.ts (#710) — не молчим об остатке, а сообщаем remaining. */
const BOT_FINDING_GROUP_CAP = 2000;

const queueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(30),
});

/** Сколько сырых случаев/находок сканируем перед группировкой и обрезкой до
 *  лимита — тот же компромисс, что и у `routes/botLearning.ts`/`routes/botAudit.ts`:
 *  разом сканировать всю вечно растущую таблицу дорого, последних достаточно. */
const SCAN_LIMIT = 120;
/** Сколько последних диалогов сканируем в поисках «свежих ответов без оценки»
 *  (источник 3, самый дешёвый сигнал, добавляется только когда мест в очереди
 *  ещё не хватило первыми двумя источниками). */
const SAMPLE_SCAN_CONVERSATIONS = 40;
/** Не больше стольких «образцов» в сутки — иначе очередь тонет в рутине там, где
 *  бот и так справляется, а вопросов и находок владельцу не хватает. */
const SAMPLE_DAILY_LIMIT = 10;
/** Сколько реплик контекста показываем ДО вопроса клиента (не считая сам вопрос
 *  и ответ бота). */
const CTX_SIZE = 4;
/** Сколько последних реплик диалога вообще рассматриваем при поиске контекста —
 *  чтобы не таскать в память переписки в тысячи сообщений ради последних четырёх. */
const MESSAGES_WINDOW = 40;

type QueueItemKind = "question" | "finding" | "sample";

interface QueueItem {
  id: string;
  kind: QueueItemKind;
  channel: string;
  name: string;
  bucket: string;
  at: string;
  ctx: { role: "user" | "assistant"; text: string }[];
  q: string;
  a: string;
  dupCount: number;
  urgent: boolean;
  conversationId: string | null;
  messageKey?: string;
  lessonId?: string;
  /** Все id той же группы повторов (владелец 17.09.2026: «повторы исключить
   *  полностью») — решение применяется ко всем разом, тем же способом, что и
   *  `PATCH /bot-learning/group`. Только у kind="question". */
  lessonGroupIds?: string[];
  /** Только у kind="finding" — параметры для `POST /bot-audit/group/resolve`. */
  findingType?: string;
  findingWhy?: string;
}

/**
 * Тема разговора — по ключевым словам (решение по умолчанию: отдельной
 * классификации тем в базе нет, а заводить её в этой задаче нельзя — схему не
 * трогаем). Порядок проверок важен: «аренда» и «другой город» помечаются
 * срочными и проверяются первыми.
 */
function classifyBucket(...texts: string[]): { bucket: string; urgent: boolean } {
  const t = texts.join(" \n ").toLowerCase();
  if (/аренд|ижора|kiray/.test(t)) return { bucket: "аренда", urgent: true };
  if (/другой город|хучанд|худжанд|бустон|кулоб|куляб|вилоят/.test(t)) return { bucket: "другой город", urgent: true };
  if (/продав|сотиш|фурух/.test(t)) return { bucket: "продавец", urgent: false };
  if (/цена|нарх|торг|скидк/.test(t)) return { bucket: "цена", urgent: false };
  // `рус\b` не совпадало ни с чем (см. ai/wordBoundary.ts): жалобы «ответь на
  // рус» падали в «другое» вместо разбора языка.
  if (new RegExp(`язык|забон|тадж|${BW}рус${EW}`, "u").test(t)) return { bucket: "язык", urgent: false };
  return { bucket: "другое", urgent: false };
}

function isSameDushanbeDay(a: Date, b: Date): boolean {
  return dushanbeWallClock(a).toISOString().slice(0, 10) === dushanbeWallClock(b).toISOString().slice(0, 10);
}

interface ConversationRecord {
  messages: ConversationMessage[];
  /** Сколько реплик отрезано спереди окном MESSAGES_WINDOW: позиция в `messages`
   *  плюс это число — позиция в полном диалоге (ACCESS-07). */
  offset: number;
  name: string | null;
  channel: string;
}

/**
 * Один батч на ВСЕ уникальные conversationId сразу (а не по одному на элемент
 * очереди, см. заголовок файла). `tg_`-префикс (routes/conversations.ts,
 * TG_PREFIX) отличает диалог Telegram-бота от диалога Meta-каналов —
 * BotLesson.conversationId, записанный из `reply-feedback`, может нести его;
 * записанный из `recordLesson()` (client_confused/operator_override) — нет,
 * это всегда голый BotConversation.id.
 */
async function loadConversationContexts(rawIds: string[]): Promise<Map<string, ConversationRecord>> {
  const result = new Map<string, ConversationRecord>();
  const uniq = Array.from(new Set(rawIds.filter(Boolean)));
  const tgIds = uniq.filter((id) => id.startsWith(TG_PREFIX)).map((id) => id.slice(TG_PREFIX.length));
  const botIds = uniq.filter((id) => !id.startsWith(TG_PREFIX));

  const [botRows, tgRows] = await Promise.all([
    botIds.length
      ? prisma.botConversation.findMany({
          where: { id: { in: botIds } },
          select: { id: true, channel: true, name: true, messages: true, client: { select: { fullName: true } } },
        })
      : Promise.resolve([]),
    tgIds.length
      ? prisma.telegramConversation.findMany({
          where: { id: { in: tgIds } },
          select: { id: true, messages: true, client: { select: { fullName: true } } },
        })
      : Promise.resolve([]),
  ]);

  for (const row of botRows) {
    const raw = Array.isArray(row.messages) ? (row.messages as unknown as ConversationMessage[]) : [];
    result.set(row.id, {
      // Обрезаем сразу здесь (владелец 17.09.2026, «ничего не должно тормозить»):
      // дальше по коду нужны максимум последние CTX_SIZE+2 реплик, тащить в
      // память тысячи сообщений старого диалога незачем.
      messages: raw.slice(-MESSAGES_WINDOW),
      offset: Math.max(0, raw.length - MESSAGES_WINDOW),
      name: row.client?.fullName ?? row.name ?? null,
      channel: row.channel,
    });
  }
  for (const row of tgRows) {
    const raw = Array.isArray(row.messages) ? (row.messages as unknown as ConversationMessage[]) : [];
    result.set(TG_PREFIX + row.id, {
      messages: raw.slice(-MESSAGES_WINDOW),
      offset: Math.max(0, raw.length - MESSAGES_WINDOW),
      name: row.client?.fullName ?? null,
      channel: "TELEGRAM",
    });
  }
  return result;
}

/** Ключ реплики для `/conversations/:id/reply-feedback` — mid, если он есть,
 *  иначе позиция в массиве (см. `replyFeedbackSchema` в @royal-home/shared).
 *  `offset` — сколько реплик срезало окно: applyReplyFeedback ищет `idx:N` в
 *  ПОЛНОМ диалоге, и номер в окне попал бы на чужую реплику (ACCESS-07). */
function messageKeyOf(messages: ConversationMessage[], idx: number, offset = 0): string {
  const mid = messages[idx]?.mid ?? messages[idx]?.mid2;
  return mid || `idx:${offset + idx}`;
}

/** Последние CTX_SIZE реплик ДО индекса `idx`, замаскированные так же, как и
 *  сам урок (sanitizeStyleText — телефоны и ники не должны утекать в чужой
 *  экран, тот же приём, что и в lib/botLessons.ts). */
function ctxBefore(messages: ConversationMessage[], idx: number): { role: "user" | "assistant"; text: string }[] {
  const from = Math.max(0, idx - CTX_SIZE);
  return messages.slice(from, idx).map((m) => ({ role: m.role, text: sanitizeStyleText(m.content ?? "") }));
}

/**
 * Источник 1 — BotLesson без правила (бот не понял, ждёт подсказки).
 * Группировка тем же ключом, что и «Обучение бота» (lessonDedupKey), — один и
 * тот же случай от разных клиентов не должен занимать несколько мест в очереди.
 *
 * РЕШЕНИЕ ПО УМОЛЧАНИЮ (сомнение = решение, 17.09.2026): берём только
 * `lesson: null`, БЕЗ уже разобранных ночным кроном `lesson: EMPTY_LESSON`
 * (в отличие от списка «Вопросы» в «Списки», см. QUESTION_WHERE в
 * routes/botLearning.ts). Причина — решение «Верно» в тренажёре как раз и
 * переводит случай в `EMPTY_LESSON, active:false` (та же запись, что оставляет
 * ночной разбор, когда учиться нечему): без этого исключения только что решённый
 * элемент читался бы тем же фильтром и возвращался в очередь на следующий
 * запрос, а «повторы исключить полностью» — прямое требование владельца.
 * Экран «Списки» этим фильтром не задет — он как был, так и остался.
 */
async function collectQuestions(limit: number): Promise<QueueItem[]> {
  const rows = await prisma.botLesson.findMany({
    where: { lesson: null, investigationOnly: false },
    orderBy: { createdAt: "desc" },
    take: SCAN_LIMIT,
  });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = lessonDedupKey(row.botMessage, row.humanMessage);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const items: QueueItem[] = [];
  const convIds = Array.from(groups.values())
    .map((g) => g[0].conversationId)
    .filter((id): id is string => !!id);
  const contexts = await loadConversationContexts(convIds);
  for (const list of groups.values()) {
    if (items.length >= limit) break;
    const head = list[0];
    const convId = head.conversationId;
    const conv = convId ? contexts.get(convId) : undefined;
    let ctx: { role: "user" | "assistant"; text: string }[] = [];
    let messageKey: string | undefined;
    if (conv) {
      // Ищем реплику бота с этим же текстом ближе к концу диалога — точное
      // совпадение по mid тут недоступно (BotLesson не хранит его), берём
      // последнее вхождение с конца, это самое свежее и самое вероятное.
      const idx = [...conv.messages].map((m, i) => i).reverse().find((i) => conv.messages[i].role === "assistant" && conv.messages[i].content === head.botMessage);
      if (idx !== undefined) {
        ctx = ctxBefore(conv.messages, idx);
        messageKey = messageKeyOf(conv.messages, idx, conv.offset);
      }
    }
    const { bucket, urgent } = classifyBucket(head.botMessage, head.humanMessage);
    items.push({
      id: `question:${head.id}`,
      kind: "question",
      channel: head.channel,
      name: conv?.name ?? "Клиент",
      bucket,
      at: head.createdAt.toISOString(),
      ctx,
      q: sanitizeStyleText(head.humanMessage),
      a: sanitizeStyleText(head.botMessage),
      dupCount: list.length,
      urgent,
      conversationId: convId ?? null,
      messageKey,
      lessonId: head.id,
      lessonGroupIds: list.map((r) => r.id),
    });
  }
  return items;
}

/** Источник 2 — находки судьи (BotAuditFinding) без вердикта, сгруппированные
 *  (type, why) — той же группировкой, что и раздел «Аудит диалогов». */
async function collectFindings(limit: number): Promise<QueueItem[]> {
  const rows = await prisma.botAuditFinding.findMany({
    where: { resolvedAt: null, type: { not: "agent_bypassed_crm" } },
    orderBy: { createdAt: "desc" },
    take: SCAN_LIMIT,
  });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = groupKey(row.type, row.why);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const sortedGroups = Array.from(groups.values()).sort((a, b) => b.length - a.length);
  const items: QueueItem[] = [];
  const convIds = sortedGroups.map((g) => g[0].conversationId).filter((id): id is string => !!id);
  const contexts = await loadConversationContexts(convIds);
  for (const list of sortedGroups) {
    if (items.length >= limit) break;
    const head = list[0];
    const conv = head.conversationId ? contexts.get(head.conversationId) : undefined;
    const { bucket, urgent } = classifyBucket(head.why, head.quote);
    items.push({
      id: `finding:${groupKey(head.type, head.why)}`,
      kind: "finding",
      channel: head.channel,
      name: conv?.name ?? "Клиент",
      bucket,
      at: head.createdAt.toISOString(),
      // Контекст находки — весь диалог недоступен по одной цитате достоверно
      // (в отличие от вопроса, у находки нет botMessage-якоря для точного
      // совпадения), поэтому показываем сами последние реплики диалога,
      // если он нашёлся, иначе — пусто (лента ниже покажет только цитату).
      ctx: conv ? conv.messages.slice(-(CTX_SIZE + 1), -1).map((m) => ({ role: m.role, text: sanitizeStyleText(m.content ?? "") })) : [],
      q: sanitizeStyleText(head.why),
      a: sanitizeStyleText(head.quote),
      dupCount: list.length,
      urgent,
      conversationId: head.conversationId ?? null,
      findingType: head.type,
      findingWhy: head.why,
    });
  }
  return items;
}

/**
 * Источник 3 — выборка последних ответов бота без оценки (`reply-feedback` ещё
 * не нажимали). Только заполнитель: применяется, только когда источники 1 и 2
 * не наполнили очередь целиком, и не больше SAMPLE_DAILY_LIMIT в сутки —
 * иначе рутинные диалоги, где бот и так справляется, вытесняли бы настоящие
 * вопросы и находки.
 *
 * Без счётчика в памяти процесса (он не переживает перезапуск и гонку
 * параллельных запросов) — предел считаем по `at` реплики за СЕГОДНЯШНИЙ день
 * по Душанбе (lib/dushanbeTime.ts, а не setHours — грабли репозитория).
 */
async function collectSamples(limit: number): Promise<QueueItem[]> {
  if (limit <= 0) return [];
  const rows = await prisma.botConversation.findMany({
    where: { lastMessageAt: { not: null } },
    orderBy: { lastMessageAt: "desc" },
    take: SAMPLE_SCAN_CONVERSATIONS,
    select: { id: true, channel: true, name: true, messages: true, client: { select: { fullName: true } } },
  });
  const now = new Date();
  const items: QueueItem[] = [];
  for (const row of rows) {
    if (items.length >= limit) break;
    const raw = Array.isArray(row.messages) ? (row.messages as unknown as ConversationMessage[]) : [];
    const messages = raw.slice(-MESSAGES_WINDOW);
    const offset = Math.max(0, raw.length - MESSAGES_WINDOW);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant" || (m.by && m.by.kind !== "bot") || m.feedback) continue;
      if (!m.at || !isSameDushanbeDay(new Date(m.at), now)) break;
      let q = "";
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === "user") {
          q = messages[j].content ?? "";
          break;
        }
      }
      if (!q.trim() || !m.content?.trim()) break;
      const { bucket, urgent } = classifyBucket(q, m.content);
      items.push({
        id: `sample:${row.id}:${offset + i}`,
        kind: "sample",
        channel: row.channel,
        name: row.client?.fullName ?? row.name ?? "Клиент",
        bucket,
        at: m.at,
        ctx: ctxBefore(messages, i),
        q: sanitizeStyleText(q),
        a: sanitizeStyleText(m.content),
        dupCount: 1,
        urgent,
        conversationId: row.id,
        messageKey: messageKeyOf(messages, i, offset),
      });
      break;
    }
  }
  return items.slice(0, SAMPLE_DAILY_LIMIT);
}

/**
 * GET /api/v1/bot-trainer/queue?limit=30 — очередь тренажёра, один запрос.
 * Право — как у `/bot-learning` (settings.manage): решения меняют промт бота.
 */
botTrainerRouter.get("/queue", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const parsed = queueQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
  const { limit } = parsed.data;
  try {
    // Настоящее число ждущих случаев (02.10.2026, класс «Пагинация»): раньше
    // total был длиной очереди, то есть упирался в limit=30, и виджет «N ждут»
    // на пульте никогда не показывал больше тридцати. Теперь — count() по тем
    // же условиям, что и у источников 1 и 2 (повторы считаются как случаи), плюс
    // попавшие в очередь образцы: их и так не больше SAMPLE_DAILY_LIMIT.
    const [questions, waitingLessons, waitingFindings] = await Promise.all([
      collectQuestions(limit),
      prisma.botLesson.count({ where: { lesson: null, investigationOnly: false } }),
      prisma.botAuditFinding.count({ where: { resolvedAt: null, type: { not: "agent_bypassed_crm" } } }),
    ]);
    const findings = await collectFindings(Math.max(0, limit - questions.length));
    const samples = await collectSamples(Math.max(0, limit - questions.length - findings.length));
    const items = [...questions, ...findings, ...samples];
    // Срочные — первыми, дальше по свежести (owner: «дедуп по dedupKey» уже
    // сделан внутри каждого источника; между источниками ключи разной природы
    // и коллизия маловероятна, поэтому здесь не дублируем).
    items.sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return new Date(b.at).getTime() - new Date(a.at).getTime();
    });
    res.json({ items, total: Math.max(items.length, waitingLessons + waitingFindings + samples.length) });
  } catch (err) {
    await logSystemError("ai", `Очередь тренажёра бота не собралась: ${describeError(err)}`);
    res.status(502).json({ error: "Не удалось собрать очередь, подробности в журнале ошибок" });
  }
});

const variantsSchema = z.object({
  conversationId: z.string().min(1),
  messageKey: z.string().min(1),
});

/** Таймаут запроса к ИИ (владелец 17.09.2026: «ничего не должно зависать») —
 *  дольше ждать вариантов бессмысленно, композер для своего текста доступен
 *  сразу и без вариантов. */
const VARIANTS_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

const VARIANTS_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 2,
      description: "Ровно два РАЗНЫХ коротких варианта ответа клиенту, ни один не повторяет прежний ответ бота.",
    },
  },
  required: ["variants"],
};

/**
 * POST /api/v1/bot-trainer/variants — два варианта «как надо было ответить»
 * после «Неверно». Промт-система — `buildShortReplySystem` (ai/leadQualifier.ts,
 * уже используется для «Ответить за агента» и напоминаний): свой промт здесь не
 * пишем, как велит бриф, только своя схема ответа (два варианта, а не один).
 */
botTrainerRouter.post("/variants", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const parsed = variantsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  const { conversationId, messageKey } = parsed.data;

  const contexts = await loadConversationContexts([conversationId]);
  const conv = contexts.get(conversationId);
  if (!conv) return res.json({ variants: [] });

  let idx = -1;
  if (messageKey.startsWith("idx:")) {
    const n = Number(messageKey.slice(4));
    if (Number.isInteger(n) && n >= 0 && n < conv.messages.length) idx = n;
  } else {
    idx = conv.messages.findIndex((m) => m?.mid === messageKey || m?.mid2 === messageKey);
  }
  if (idx === -1) return res.json({ variants: [] });

  const prevAnswer = conv.messages[idx]?.content ?? "";
  const history = conv.messages.slice(0, idx + 1).map((m) => ({ role: m.role, content: m.content ?? "" }));
  const instruction =
    `Прежний ответ бота на последнее сообщение клиента был неверным: "${prevAnswer.slice(0, 300)}". ` +
    "Дай ДВА РАЗНЫХ коротких варианта, как надо было ответить на последнее сообщение клиента. " +
    "Варианты должны отличаться друг от друга и не повторять прежний ответ дословно.";
  const system = buildShortReplySystem(instruction, { name: conv.name ?? undefined });

  try {
    const result = await withTimeout(
      callAiText<{ variants?: string[] }>({
        endpoint: "bot-trainer-variants",
        system,
        messages: history,
        maxTokens: 300,
        effort: "medium",
        schema: VARIANTS_SCHEMA,
        conversationId,
      }),
      VARIANTS_TIMEOUT_MS
    );
    const variants = (result?.variants ?? []).filter((v) => typeof v === "string" && v.trim()).slice(0, 2);
    res.json({ variants });
  } catch (err) {
    await logSystemError("ai", `Варианты тренажёра бота не удались: ${describeError(err)}`);
    res.json({ variants: [] });
  }
});

const decideSchema = z.object({
  itemId: z.string().min(1),
  kind: z.enum(["question", "finding", "sample"]),
  verdict: z.enum(["good", "bad", "mute"]),
  note: z.string().max(300).optional(),
  channel: z.string().min(1),
  conversationId: z.string().optional().nullable(),
  messageKey: z.string().optional(),
  lessonId: z.string().optional(),
  lessonGroupIds: z.array(z.string()).optional(),
  findingType: z.string().optional(),
  findingWhy: z.string().optional(),
  /** Текст вопроса/ответа с карточки — только чтобы записать читаемый
   *  BotLesson.humanMessage/botMessage у verdict="mute" (сервер их больше
   *  неоткуда взять для kind="question"/"finding", где нет messageKey). */
  q: z.string().max(2000).optional(),
  a: z.string().max(2000).optional(),
});

/** Какого рода случай заводим для «Не отвечать» — свой kind, как и у остальных
 *  источников BotLesson (owner_bad, audit_finding, lost_client, ...). */
const MUTE_LESSON_KIND = "owner_mute";

/**
 * POST /api/v1/bot-trainer/decide — одно решение тренажёра, применяется сразу.
 *
 * Каждый verdict использует УЖЕ СУЩЕСТВУЮЩИЙ механизм обучения бота, а не свой:
 *  - kind="sample" (верно/неверно) — та же логика, что у «Верно/Неверно» прямо
 *    в чате (lib/replyFeedback.ts, общая с `POST /conversations/:id/reply-feedback`).
 *  - kind="question" (верно/неверно) — то же обновление BotLesson, что делает
 *    `PATCH /bot-learning/group`, группой: все схлопнутые повторы разом.
 *  - kind="finding" (верно/неверно) — та же транзакция, что у
 *    `POST /bot-audit/group/resolve`: закрыть группу находок + (при «неверно»)
 *    один урок на всю группу.
 *  - verdict="mute" (любой kind) — новое: правило «в таких случаях не отвечать»
 *    нигде раньше не заводилось, ни у одного из трёх источников нет для него
 *    готовой ручки. Заводит BotLesson{kind:"owner_mute", active:true} и, если
 *    решение относится к конкретной реплике (sample), вдобавок гасит её тем же
 *    reply-feedback(bad) — карточка не должна вернуться в очередь снова.
 */
botTrainerRouter.post("/decide", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const parsed = decideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const { itemId, kind, verdict, note, channel, conversationId, messageKey, lessonId, lessonGroupIds, findingType, findingWhy, q, a } =
    parsed.data;
  // Investigation evidence belongs in the private audit, never general bot training.
  if (kind === "finding" && findingType === "agent_bypassed_crm") return res.status(404).json({ error: "Запись не найдена" });
  const userId = req.agent!.id;
  const referencedLessonIds = [...new Set([...(lessonGroupIds ?? []), ...(lessonId ? [lessonId] : [])])];
  if (referencedLessonIds.length && await prisma.botLesson.count({
    where: { id: { in: referencedLessonIds }, investigationOnly: true },
  })) return res.status(404).json({ error: "Запись не найдена" });

  try {
    let lessonCreated = false;
    let groupRemaining = 0;

    if (verdict === "mute") {
      const muteNote = note?.trim() ? note.trim().slice(0, 300) : "Случай без уточнения — см. первоисточник";
      const lessonData = {
        kind: MUTE_LESSON_KIND,
        channel,
        conversationId: conversationId ?? null,
        botMessage: sanitizeStyleText(a ?? ""),
        humanMessage: sanitizeStyleText(q ?? ""),
        lesson: `Если ${muteNote} — не отвечать вовсе.`,
        active: true,
      };
      // Новый урок и погашение источника — одной транзакцией (кроме kind="sample",
      // где источник гасится через applyReplyFeedback — отдельный, самодостаточный
      // механизм с собственной логикой, не голый updateMany): порознь падение
      // между ними оставляло источник неразобранным, и тот же случай снова
      // попадал бы в выборку тренера, порождая второй урок.
      if (kind === "question" && lessonId) {
        await prisma.$transaction([
          prisma.botLesson.create({ data: lessonData }),
          prisma.botLesson.updateMany({ where: { id: { in: lessonGroupIds ?? [lessonId] }, investigationOnly: false }, data: { lesson: EMPTY_LESSON, active: false } }),
        ]);
      } else if (kind === "finding" && findingType && findingWhy) {
        await prisma.$transaction([
          prisma.botLesson.create({ data: lessonData }),
          prisma.botAuditFinding.updateMany({
            where: { type: findingType, resolvedAt: null, why: { startsWith: groupWhyPrefix(findingWhy), mode: "insensitive" } },
            data: { resolvedAt: new Date(), resolvedById: userId },
          }),
        ]);
      } else {
        await prisma.botLesson.create({ data: lessonData });
        // Сама карточка гасится тем же способом, что и «Неверно» — иначе при
        // kind="sample" тот же неоценённый ответ снова попал бы в выборку.
        if (kind === "sample" && conversationId && messageKey) {
          await applyReplyFeedback({ rawId: conversationId, messageKey, verdict: "bad", note: muteNote, userId }).catch(() => {});
        }
      }
      lessonCreated = true;
    } else if (kind === "sample") {
      if (!conversationId || !messageKey) return res.status(400).json({ error: "Нет ссылки на переписку" });
      await applyReplyFeedback({ rawId: conversationId, messageKey, verdict, note, userId });
    } else if (kind === "question") {
      if (!lessonId) return res.status(400).json({ error: "Нет урока" });
      const ids = lessonGroupIds ?? [lessonId];
      if (verdict === "good") {
        // «Бот прав» — тот же исход, что и у ночного разбора, которому учиться
        // не на чем: EMPTY_LESSON, active:false (см. lib/botLessons.ts, distillLessons).
        await prisma.botLesson.updateMany({ where: { id: { in: ids }, investigationOnly: false }, data: { lesson: EMPTY_LESSON, active: false } });
      } else {
        const lesson = note?.trim().slice(0, 300) || EMPTY_LESSON;
        await prisma.botLesson.updateMany({ where: { id: { in: ids }, investigationOnly: false }, data: { lesson, active: lesson !== EMPTY_LESSON } });
        lessonCreated = lesson !== EMPTY_LESSON;
      }
    } else if (kind === "finding") {
      if (!findingType || !findingWhy) return res.status(400).json({ error: "Нет группы находок" });
      const whyPrefix = groupWhyPrefix(findingWhy);
      const groupWhere = { type: findingType, resolvedAt: null, why: { startsWith: whyPrefix, mode: "insensitive" as const } };
      const matches = await prisma.botAuditFinding.findMany({ where: groupWhere, take: BOT_FINDING_GROUP_CAP });
      if (matches.length === 0) return res.status(404).json({ error: "Группа не найдена или уже разобрана" });
      groupRemaining =
        matches.length < BOT_FINDING_GROUP_CAP
          ? 0
          : (await prisma.botAuditFinding.count({ where: groupWhere })) - matches.length;
      if (groupRemaining > 0) {
        void logSystemError(
          "ai",
          `Тренажёр бота: группа находок «${findingType}/${findingWhy.slice(0, 80)}» больше потолка ${BOT_FINDING_GROUP_CAP} — разобраны первые, осталось ${groupRemaining}`
        );
      }
      const ids = matches.map((m) => m.id);
      await prisma.$transaction(async (tx) => {
        await tx.botAuditFinding.updateMany({ where: { id: { in: ids } }, data: { resolvedAt: new Date(), resolvedById: userId } });
        if (verdict === "bad") {
          const first = matches[0];
          const botMessage = sanitizeStyleText(first.quote).slice(0, 300);
          const lessonText = sanitizeStyleText(first.why).slice(0, 300);
          await tx.botLesson.create({
            data: {
              kind: "audit_finding",
              channel: first.channel,
              conversationId: first.conversationId,
              botMessage: botMessage || "(нарушение без цитаты)",
              humanMessage: lessonText,
              lesson: lessonText,
              active: false,
            },
          });
        }
      });
      lessonCreated = verdict === "bad";
      logAudit(req, "BOT_AUDIT_RESOLVE_GROUP", "BotAuditFinding", findingType, {
        verdict: verdict === "good" ? "bot_right" : "bot_error",
        type: findingType,
        why: findingWhy.slice(0, 300),
        count: ids.length,
      });
    }

    res.json({ ok: true, itemId, lessonCreated, ...(groupRemaining > 0 ? { groupRemaining } : {}) });
  } catch (err) {
    if (err instanceof ReplyFeedbackError) return res.status(err.status).json({ error: err.message });
    await logSystemError("ai", `Решение тренажёра бота (${itemId}) не применилось: ${describeError(err)}`);
    res.status(502).json({ error: "Не удалось применить решение, подробности в журнале ошибок" });
  }
});
