import { z } from "zod";
import { formatClientName } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../../lib/clientPhone.js";
import {
  dushanbeDateString,
  dushanbeDayRange,
  dushanbeInputToDate,
  dushanbeTimeString,
} from "../../../lib/dushanbeTime.js";
import { visibleInteractionWhere } from "../../../lib/investigationPrivacy.js";
import { TASK_WHERE } from "../../../lib/tasks.js";
import { propertyHref } from "./propertyPresenter.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * list_my_tasks — МОИ ЗАДАЧИ И ПОКАЗЫ НА ДЕНЬ (П3, группа «read»).
 *
 * Задача в CRM — запись хронологии с `nextAction` и `nextActionDate` (lib/tasks.ts,
 * отдельной модели нет), показ — такая же запись типа SHOWING. Условие — `TASK_WHERE`
 * (не удалённый клиент, не отменённая, не закрытое назначение) и принадлежность актору
 * как у GET /calendar/tasks: `agentId` ИЛИ `subjectAgentId` (запись ИИ/бота от имени
 * агента). «Мои» — ВСЕГДА свои, даже у руководителя: чужие задачи не показываются, а
 * общий календарь агентства — не задача этого инструмента. Сутки — Душанбе
 * (lib/dushanbeTime.ts), не UTC. Просроченные (прошлые дни, не закрытые) — отдельным
 * списком, самые свежие.
 */
const MAX_ITEMS = 20;

const argsSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

const taskSelect = {
  id: true,
  type: true,
  nextAction: true,
  nextActionDate: true,
  completedAt: true,
  client: { select: { id: true, shortId: true, kind: true, fullName: true } },
  property: { select: { id: true, shortId: true, title: true } },
} satisfies Prisma.InteractionSelect;

export const listMyTasksTool: AssistantReadToolPlugin = {
  name: "list_my_tasks",
  level: "A",
  description:
    "Мои задачи и показы на день (по умолчанию сегодня) и мои просроченные. Зови на «что у меня сегодня/завтра», " +
    "«какие у меня показы». Дата — ГГГГ-ММ-ДД по Душанбе. НЕ зови для задач других сотрудников и для общей " +
    "статистики; для будущих показов всей команды есть get_upcoming_showings.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "Дата ГГГГ-ММ-ДД (Душанбе). Без неё — сегодня" },
    },
  },
  statusPhrase: "Смотрю ваши задачи…",
  async run(rawArgs, { actor }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Дата должна быть в виде ГГГГ-ММ-ДД" };
    const date = parsed.data.date ?? dushanbeDateString();
    const noon = dushanbeInputToDate(date, "12:00");
    // Date.UTC молча «докручивает» 2031-13-45 до реальной даты — сверяем круг туда и обратно.
    if (Number.isNaN(noon.getTime()) || dushanbeDateString(noon) !== date) return { error: "Некорректная дата" };
    const day = dushanbeDayRange(noon);
    const startOfToday = dushanbeDayRange(new Date()).start;

    const mine: Prisma.InteractionWhereInput = {
      ...TASK_WHERE,
      ...visibleInteractionWhere(actor.role),
      OR: [{ agentId: actor.id }, { subjectAgentId: actor.id }],
    };
    const [dayRows, overdueRows] = await Promise.all([
      prisma.interaction.findMany({
        where: { ...mine, nextActionDate: { gte: day.start, lt: day.end } },
        orderBy: { nextActionDate: "asc" },
        take: MAX_ITEMS,
        select: taskSelect,
      }),
      // Просрочка — только незакрытое и до сегодняшних суток (если смотрим будущий день,
      // сегодняшние ещё-не-наступившие не просрочены, а попавшие в «день» не дублируем).
      prisma.interaction.findMany({
        where: { ...mine, completedAt: null, nextActionDate: { lt: startOfToday } },
        orderBy: { nextActionDate: "desc" },
        take: MAX_ITEMS,
        select: taskSelect,
      }),
    ]);

    type Row = (typeof dayRows)[number];
    const present = (r: Row) => ({
      id: r.id,
      kind: r.type === "SHOWING" ? "showing" : "task",
      type: r.type,
      date: r.nextActionDate ? dushanbeDateString(r.nextActionDate) : null,
      time: r.nextActionDate ? dushanbeTimeString(r.nextActionDate) : null,
      done: r.completedAt !== null,
      text: safeField(phoneSafeText(r.nextAction, actor.canViewPhone)),
      client: {
        name: safeField(clientNamePhoneSafe(formatClientName(r.client), actor.canViewPhone)),
        href: `/clients/${r.client.shortId}`,
      },
      property: r.property
        ? { title: safeField(r.property.title), href: propertyHref(r.property.shortId) }
        : null,
      href: `/clients/${r.client.shortId}`,
    });

    const dayIds = new Set(dayRows.map((r) => r.id));
    return {
      date,
      today: dushanbeDateString(),
      tasks: dayRows.map(present),
      // Просроченные не дублируют строки выбранного дня (если смотрим прошедший день).
      overdue: overdueRows.filter((r) => !dayIds.has(r.id)).map(present),
      ...(dayRows.length === 0 && overdueRows.length === 0 ? { note: "На этот день задач и показов нет" } : {}),
    };
  },
};
