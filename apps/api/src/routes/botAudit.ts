import { canViewInvestigations } from "@royal-home/shared";
import { requireInvestigations } from "../auth/investigations.js";
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { runBotAudit } from "../ai/botAudit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { logAudit } from "../lib/audit.js";
import { sanitizeStyleText } from "../ai/styleLearning.js";
import { groupKey, groupWhyPrefix } from "../lib/botAuditGroups.js";
import { phoneSafeText } from "../lib/clientPhone.js";

export const botAuditRouter = Router();

/**
 * ЦИТАТА И ПРИЧИНА — СВОБОДНЫЙ ТЕКСТ ИЗ ПЕРЕПИСКИ (аудит Codex 04.10.2026, ACCESS-03).
 * Нарушение links_phone/agent_bypassed_crm по определению несёт номер, а право
 * auditLog.view не даёт права на номер: clients.viewPhone решает отдельно. Маска —
 * общая phoneSafeText из lib/clientPhone.ts, при отдаче (в базе цитата дословная:
 * владельцу нужны настоящие значения). Маскируем ДО группировки: ключ группы
 * строится по `why` и иначе выдал бы номер из первых 60 знаков через `id`.
 */
function presentFinding<T extends { quote: string; why: string }>(row: T, canSeePhone: boolean): T {
  if (canSeePhone) return row;
  return { ...row, quote: phoneSafeText(row.quote, false), why: phoneSafeText(row.why, false) };
}

/** Окно проверки в часах. Потолок — квартал: судья берёт из окна СЛУЧАЙНЫЕ
 *  диалоги с пределом выборки, поэтому широкое окно не делает прогон дороже.
 *  Без параметра берётся месяц (см. WINDOW_HOURS в ai/botAudit.ts). */
const runSchema = z.object({ hours: z.number().min(1).max(24 * 90).optional() });

/** Кнопка «Проверить диалоги» — синхронный прогон судьи по случайным диалогам
 *  за окно. См. ai/botAudit.ts про то, как формируются правила и находки. */
botAuditRouter.post("/run", requireAuth, requireInvestigations, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  try {
    const summary = await runBotAudit(parsed.data.hours);
    res.json(summary);
  } catch (err) {
    await logSystemError("ai", `Аудит диалогов не удался: ${describeError(err)}`);
    res.status(502).json({ error: "Аудит не удался, подробности в журнале ошибок" });
  }
});

/** Сколько групп отдаём за раз (17.09.2026: «страницы по группам», тот же приём
 *  «показать ещё», что у трёх лент «Обучение бота»). Групп на порядок меньше,
 *  чем сырых находок (~38 групп на 900 находок на проде), поэтому смещение
 *  по номеру, а не курсор по id — группа не строка таблицы. */
const GROUPS_PAGE = 20;

const listQuerySchema = z.object({
  includeResolved: z.enum(["true", "false"]).optional(),
  /** Сколько групп уже показано — следующая порция начинается отсюда. */
  groupsOffset: z.coerce.number().int().min(0).optional(),
});

/** Сгруппированные находки — не по диалогу (иначе одна и та же проблема
 *  показывается десятки раз), а по (type, why): владельцу нужно видеть
 *  повторяющиеся системные проблемы, а не список отдельных диалогов. */
botAuditRouter.get("/", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
  const includeResolved = parsed.data.includeResolved === "true";
  const groupsOffset = parsed.data.groupsOffset ?? 0;
  const canSeePhone = can(req, "clients.viewPhone");
  const rows = (
    await prisma.botAuditFinding.findMany({
      where: { ...(includeResolved ? {} : { resolvedAt: null }), ...(!canViewInvestigations(req.agent?.role) ? { type: { not: "agent_bypassed_crm" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
    })
  ).map((row) => presentFinding(row, canSeePhone));
  // `id` — ключ группировки (тот же groupKey), чтобы клиент, копящий порции
  // групп «Показать ещё», мог склеить группу, приехавшую в двух порциях подряд
  // (список пересчитывается между запросами, и группы сдвигаются).
  const groups = new Map<
    string,
    { id: string; type: string; why: string; severity: string; count: number; examples: typeof rows }
  >();
  for (const row of rows) {
    const key = groupKey(row.type, row.why);
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (g.examples.length < 3) g.examples.push(row);
    } else {
      groups.set(key, { id: key, type: row.type, why: row.why, severity: row.severity, count: 1, examples: [row] });
    }
  }
  // Счётчики отдельными запросами, а не длиной `rows`: список обрезан пределом
  // в 500 строк, и без честного итога владелец видел бы «500» и не знал, сколько
  // на самом деле висит неразобранным (на проде это 104 из 104).
  const [unresolvedTotal, resolvedTotal] = await Promise.all([
    prisma.botAuditFinding.count({ where: { resolvedAt: null, ...(!canViewInvestigations(req.agent?.role) ? { type: { not: "agent_bypassed_crm" } } : {}) } }),
    prisma.botAuditFinding.count({ where: { NOT: { resolvedAt: null }, ...(!canViewInvestigations(req.agent?.role) ? { type: { not: "agent_bypassed_crm" } } : {}) } }),
  ]);
  const allGroups = Array.from(groups.values()).sort((a, b) => b.count - a.count);
  const page = allGroups.slice(groupsOffset, groupsOffset + GROUPS_PAGE);
  // total — настоящее число находок под этим фильтром (02.10.2026), а не длина
  // выборки, упиравшаяся в 500. groupsLimited — группы и их счётчики собраны
  // только из последних 500 находок: честно говорим, что дальше не смотрели.
  const total = includeResolved ? unresolvedTotal + resolvedTotal : unresolvedTotal;
  res.json({
    total,
    groupsLimited: total > rows.length,
    unresolvedTotal,
    resolvedTotal,
    groups: page,
    groupsTotal: allGroups.length,
    groupsNextOffset: groupsOffset + page.length < allGroups.length ? groupsOffset + page.length : null,
  });
});

/** Сколько примеров-цитат отдаём за раз внутри одной раскрытой группы («ещё N
 *  таких»). GET, а не поле ответа /: список приходит без лимита, только когда
 *  владелец сам раскрыл группу. */
const GROUP_EXAMPLES_PAGE = 10;

const groupExamplesQuerySchema = z.object({
  type: z.string().min(1),
  why: z.string().min(1),
  cursor: z.string().uuid().optional(),
});

/**
 * Ещё цитаты внутри уже показанной группы (17.09.2026: «внутри группы —
 * показать ещё цитат», группа на экране несёт только первые три примера).
 * Совпадение — тот же ключ, что и группировка выше: тип точный, `why` —
 * по первым 60 знакам без учёта регистра (`mode: "insensitive"` — Postgres).
 */
botAuditRouter.get("/group-examples", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = groupExamplesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
  const { type, why, cursor } = parsed.data;
  if (type === "agent_bypassed_crm" && !canViewInvestigations(req.agent?.role)) return res.status(404).json({ error: "Группа не найдена" });
  const rows = await prisma.botAuditFinding.findMany({
    where: { type, resolvedAt: null, why: { startsWith: groupWhyPrefix(why), mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    take: GROUP_EXAMPLES_PAGE,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
  res.json({
    items: rows.map((row) => presentFinding(row, can(req, "clients.viewPhone"))),
    nextCursor: rows.length === GROUP_EXAMPLES_PAGE ? rows[rows.length - 1].id : null,
  });
});

/**
 * ВЕРДИКТ ЖИВОГО ЧЕЛОВЕКА ПО НАХОДКЕ (30.08.2026, тот же разбор, что дал кнопки
 * «Бот прав» / «Бот ошибся — разобрать» у «Ушедших молча клиентов», см.
 * lib/lostConversations.ts и routes/botLearning.ts — здесь ровно та же идея,
 * перенесённая на BotAuditFinding).
 *
 * ПОЧЕМУ ВЕРДИКТ НЕОБЯЗАТЕЛЕН. Кнопка «Разобрался» в интерфейсе существовала до
 * вердикта (см. BotAuditSection.tsx) и продолжает работать без него — старое
 * поведение "просто снять с учёта" никуда не делось, вердикт лишь ДОБАВЛЯЕТ смысл.
 *
 * bot_error — судья прав, нарушение настоящее: случай уходит в ту же очередь
 * обучения бота, что и живые правки оператора (BotLesson), — с ГОТОВЫМ текстом
 * правила (why судьи уже объясняет, что нарушено) и ВЫКЛЮЧЕННЫМ по умолчанию
 * (active=false). Дальше это обычная запись в «Чему бот научился»
 * (routes/botLearning.ts, BotLessonsSection.tsx) с уже знакомой кнопкой
 * «Правило верное — включить»: находка не идёт в промт сама, пока владелец не
 * подтвердит её ещё раз на том экране, — то же самое двойное подтверждение, что
 * и у предложений из недельной сводки «Ушедшие молча клиенты» (kind=lost_client).
 *
 * bot_right — судья ошибся (ложное срабатывание) или нарушение уже неактуально:
 * находка просто закрывается, никакого урока.
 */
const resolveSchema = z.object({ verdict: z.enum(["bot_right", "bot_error"]).optional() });

/** Какого рода случай заводим в очередь обучения — свой kind, чтобы отличать
 *  источник записи от живых ошибок бота и от предложений из сводки. */
const AUDIT_LESSON_KIND = "audit_finding";

/** Так же режем длину, как и сама находка при записи (ai/botAudit.ts):
 *  правило в промте не резиновое, длинная находка ему не идёт на пользу. */
const LESSON_MAX = 300;

/** Сколько находок одной группы можно разобрать одним нажатием — тот же
 *  предел выборки, что и у сырого списка GET "/" (500), группа физически не
 *  может превысить общий предел. */
const GROUP_RESOLVE_MAX = 500;

const groupResolveSchema = z.object({
  type: z.string().min(1),
  why: z.string().min(1),
  verdict: z.enum(["bot_right", "bot_error"]),
});

/**
 * Вердикт на ВСЮ группу находок разом (17.09.2026, добавка к заданию: «повторы
 * исключить полностью» + исходное «действия на всю группу: „Бот ошибся —
 * учесть” создаёт ОДИН урок на группу, не 30»). Объявлена ДО `/:id/resolve`,
 * иначе Express принял бы «group» за `:id`.
 *
 * bot_error — ОДИН урок на всю группу (готовый текст judge уже общий для всех
 * находок группы), а не по одному на находку — иначе группа из 30 одинаковых
 * находок превратилась бы в 30 одинаковых строк в «Чему бот научился», ровно
 * то, от чего родилась группировка на этом экране.
 * bot_right — группа закрывается целиком и её ключ (type+why) уходит в
 * getClosedGroupKeys(): следующий прогон судьи по этому же классу нарушений
 * находку заново не заведёт (см. ai/botAudit.ts, runBotAudit).
 */
botAuditRouter.post("/group/resolve", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = groupResolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  const { type, why, verdict } = parsed.data;
  if (type === "agent_bypassed_crm" && !canViewInvestigations(req.agent?.role)) return res.status(404).json({ error: "Группа не найдена" });
  const whyPrefix = groupWhyPrefix(why);
  const matches = await prisma.botAuditFinding.findMany({
    where: { type, resolvedAt: null, why: { startsWith: whyPrefix, mode: "insensitive" } },
    take: GROUP_RESOLVE_MAX,
  });
  if (matches.length === 0) return res.status(404).json({ error: "Группа не найдена или уже разобрана" });
  const ids = matches.map((m) => m.id);

  // Одна транзакция: закрытие всей группы и (для bot_error) единственный урок —
  // либо оба шага, либо ни одного, тем же приёмом, что и одиночный /:id/resolve.
  await prisma.$transaction(async (tx) => {
    await tx.botAuditFinding.updateMany({
      where: { id: { in: ids } },
      data: { resolvedAt: new Date(), resolvedById: req.agent!.id },
    });
    // Private investigation excerpts must never become shared bot-training examples.
    if (verdict === "bot_error" && type !== "agent_bypassed_crm") {
      const first = matches[0];
      const botMessage = sanitizeStyleText(first.quote).slice(0, LESSON_MAX);
      const lessonText = sanitizeStyleText(first.why).slice(0, LESSON_MAX);
      await tx.botLesson.create({
        data: {
          kind: AUDIT_LESSON_KIND,
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

  logAudit(req, "BOT_AUDIT_RESOLVE_GROUP", "BotAuditFinding", type, {
    verdict,
    type,
    why: why.slice(0, 300),
    count: ids.length,
  });
  res.json({ resolved: ids.length, lessonCreated: verdict === "bot_error" });
});

botAuditRouter.post("/:id/resolve", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  const { verdict } = parsed.data;
  try {
    const finding = await prisma.botAuditFinding.findUnique({ where: { id: req.params.id } });
    if (finding?.type === "agent_bypassed_crm" && !canViewInvestigations(req.agent?.role)) return res.status(404).json({ error: "Запись не найдена" });
    if (!finding) return res.status(404).json({ error: "Запись не найдена" });

    // Одна транзакция: закрытие находки и урок для обучения — либо оба, либо
    // ни одного, иначе отказ на втором шаге оставил бы находку закрытой, а
    // случай — не заведённым, и второй раз кнопку уже не нажать (находка
    // пропадёт из списка неразобранных).
    await prisma.$transaction(async (tx) => {
      await tx.botAuditFinding.update({
        where: { id: finding.id },
        data: { resolvedAt: new Date(), resolvedById: req.agent!.id },
      });
      if (verdict === "bot_error" && finding.type !== "agent_bypassed_crm") {
        // sanitizeStyleText ОБЯЗАТЕЛЕН (тот же приём, что и recordLesson в
        // ai/botLessons.ts): quote — дословная цитата бота, и если нарушение
        // было как раз в том, что бот повторил номер клиента, этот номер уедет
        // прямо в промт КАЖДОГО будущего разговора вместе с «уроком», если его
        // потом включат. Правило одно и то же независимо от источника урока.
        const botMessage = sanitizeStyleText(finding.quote).slice(0, LESSON_MAX);
        const lessonText = sanitizeStyleText(finding.why).slice(0, LESSON_MAX);
        await tx.botLesson.create({
          data: {
            kind: AUDIT_LESSON_KIND,
            channel: finding.channel,
            conversationId: finding.conversationId,
            botMessage: botMessage || "(нарушение без цитаты)",
            humanMessage: lessonText,
            // Готовый текст правила — вывод судьи уже объясняет, что нарушено,
            // повторно спрашивать модель не о чем (это готовый вывод человека,
            // подтвердившего находку, а не сырой случай для ночного разбора).
            lesson: lessonText,
            // Выключено нарочно: попадает в общий список «Чему бот научился» и
            // ждёт того же явного включения, что и предложения из недельной
            // сводки, — правило меняет промт КАЖДОГО диалога, и такой шаг не
            // должен происходить только оттого, что кто-то разобрал одну находку.
            active: false,
          },
        });
      }
    });

    logAudit(req, "BOT_AUDIT_RESOLVE", "BotAuditFinding", finding.id, {
      verdict: verdict ?? "unspecified",
      type: finding.type,
      // `why` в мете обязателен (17.09.2026): getClosedGroupKeys() читает его
      // отсюда, чтобы судья не заводил находки по уже закрытым вердиктом
      // «бот прав» группам заново — без текста находки ключ группы не собрать.
      why: finding.why.slice(0, 300),
      severity: finding.severity,
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Запись не найдена" });
    }
    throw err;
  }
});

/**
 * «Разобрать все» — типичный сценарий после прогона судьи: находки создаются
 * пачкой за один раз (ai/botAudit.ts), а разбирать их по одной незачем, если
 * все — тот же класс ложных срабатываний (тот же приём, что errorLog.ts
 * /resolve-all). Без вердикта, как и одиночная кнопка «Разобрался» без
 * verdict, — просто снимает находки с учёта, ничему бота не учит: заводить
 * урок пачкой означало бы менять промт КАЖДОГО диалога по чужому решению
 * «разобрать всё», а не по осознанному подтверждению одной находки.
 */
botAuditRouter.post("/resolve-all", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const { count } = await prisma.botAuditFinding.updateMany({
    where: { resolvedAt: null, ...(!canViewInvestigations(req.agent?.role) ? { type: { not: "agent_bypassed_crm" } } : {}) },
    data: { resolvedAt: new Date(), resolvedById: req.agent!.id },
  });
  res.json({ resolved: count });
});
