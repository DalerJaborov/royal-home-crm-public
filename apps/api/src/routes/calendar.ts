import { investigationViewerRole } from "../auth/investigations.js";
import { visibleInteractionWhere } from "../lib/investigationPrivacy.js";
import { Router } from "express";
import { dushanbeDayRange, dushanbeEndOfDay } from "../lib/dushanbeTime.js";
import { dateRangeQuerySchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, scopeToOwnAgent } from "../auth/middleware.js";
import { TASK_WHERE } from "../lib/tasks.js";
import { withMaskedClient } from "../lib/clientPhone.js";
import { presentInteractions, transcriptAccess } from "../lib/callTranscripts.js";

export const calendarRouter = Router();

/** Предел задач в днях сетки (месяц всего агентства у руководителя). */
const CALENDAR_RANGE_CAP = 1500;
/** Предел просроченных — самые свежие из них. */
const CALENDAR_OVERDUE_CAP = 500;

/** Задачи в диапазоне дат (для месячной сетки календаря) + все просроченные — независимо от диапазона,
 * чтобы старый "хвост" не терялся при переключении месяцев. Без from/to — просроченные + неделя вперёд. */
calendarRouter.get("/tasks", requireAuth, async (req, res) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const ownAgentId = scopeToOwnAgent(req);
  const now = new Date();
  const rangeTo = parsed.data.to ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  // setHours считал бы конец суток в поясе процесса (UTC), то есть 04:59 утра
  // следующего дня по Душанбе — задачи вечера последнего дня терялись.
  const rangeEnd = parsed.data.to ? dushanbeEndOfDay(rangeTo) : rangeTo;
  // Симметрично с to: сырая дата «2026-08-01» парсится как полночь UTC = 05:00 по
  // Душанбе, и будущие задачи на 00:00-05:00 первого дня сетки выпадали из выборки
  // (приём тот же, что в reports.ts). Просроченные ловит ветка lt: now.
  const rangeFrom = parsed.data.from ? dushanbeDayRange(parsed.data.from).start : undefined;

  /**
   * ДВЕ ВЫБОРКИ, А НЕ ОДНА (аудит 23.09.2026, №52). Была одна общая с take 500
   * по возрастанию даты: при пятистах просроченных в агентстве (у руководителя
   * это задачи всех агентов) все места забирали старые просрочки, и сетка
   * месяца приходила ПУСТОЙ. Теперь дни сетки выбираются отдельно и целиком
   * (свой предел), а просроченные — отдельно, самые свежие из них.
   */
  const baseWhere = {
    ...TASK_WHERE,
    // completedAt раньше не проверяли — задача "исчезала" из этого списка только
    // потому, что complete-роут стирал nextAction/nextActionDate. Теперь дата
    // остаётся (нужна для KPI), поэтому явно исключаем уже выполненные.
    completedAt: null,
    // subjectAgentId ?? agentId (П-10, 17.09.2026) — см. комментарий у той же
    // замены в routes/dashboard.ts.
    ...(ownAgentId ? { OR: [{ agentId: ownAgentId }, { subjectAgentId: ownAgentId }] } : {}),
  };
  const include = {
    client: { select: { id: true, shortId: true, fullName: true, phone: true } },
    property: { select: { id: true, shortId: true, title: true } },
    agent: { select: { fullName: true } },
  } as const;
  const [inRange, overdue] = await Promise.all([
    prisma.interaction.findMany({
      where: { ...baseWhere, ...visibleInteractionWhere(investigationViewerRole(req)), nextActionDate: { lte: rangeEnd, gte: rangeFrom ?? now } },
      orderBy: { nextActionDate: "asc" },
      take: CALENDAR_RANGE_CAP,
      include,
    }),
    // Просроченные не ограничены снизу по дате — без take список бы рос без
    // предела по мере накопления истории агентства. Берём самые свежие.
    prisma.interaction.findMany({
      where: { ...baseWhere, ...visibleInteractionWhere(investigationViewerRole(req)), nextActionDate: { lt: now } },
      orderBy: { nextActionDate: "desc" },
      take: CALENDAR_OVERDUE_CAP,
      include,
    }),
  ]);
  const seen = new Set(inRange.map((t) => t.id));
  const tasks = [...overdue.filter((t) => !seen.has(t.id)), ...inRange].sort(
    (a, b) => (a.nextActionDate?.getTime() ?? 0) - (b.nextActionDate?.getTime() ?? 0)
  );

  // Телефон клиента рядовому сотруднику закрыт (см. lib/clientPhone.ts): здесь он
  // приходил целиком, и запрет в разделе «Клиенты» ничего не значил — номер брали
  // из карточки задачи.
  // Именно viewPhone, а не viewAll: пресет MANAGER содержит viewAll и НЕ содержит
  // viewPhone, поэтому по viewAll номер приезжал менеджеру целиком — до 500 задач
  // по всему агентству. Во всех остальных маршрутах решает viewPhone.
  const canSeeFull = can(req, "clients.viewPhone");
  /**
   * presentInteraction, а не только withMaskedClient (22.09.2026). Выборка идёт
   * через `include` без `select`, то есть наружу уходят ВСЕ строковые колонки
   * записи — `notes`, `nextAction`, `liveNote`, `voiceNoteTranscript`,
   * `transcript`, `transcriptRu`, — а закрыт был один вложенный клиент. Это и
   * обход `clients.viewPhone` (номер в тексте), и обход прав на разговор:
   * расшифровка чужого звонка приезжала в календарь целиком, до 500 записей.
   * Общая точка выдачи записи хронологии — lib/callTranscripts.ts.
   */
  const access = transcriptAccess(req.agent);
  res.json(presentInteractions(tasks, access).map((task) => withMaskedClient(task, canSeeFull)));
});
