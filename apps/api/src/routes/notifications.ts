import { visibleNotificationsWhere } from "../lib/investigationNotifications.js";
import { Router } from "express";
import { z } from "zod";
import { pageQuerySchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth } from "../auth/middleware.js";
import { maskPhonesInText } from "../lib/clientPhone.js";

/**
 * Лента уведомлений в шапке (17-18.08.2026, макет design_handoff, экран «notif»).
 *
 * Записи пишутся не отсюда, а из push.ts (см. lib/notifications.ts) — рядом с
 * каждым уже существующим sendPushToAgent/sendPushToAgents, одной точкой на весь
 * API. Этот роутер — только чтение своей ленты и отметки прочитанного.
 */
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

const PAGE_SIZE = 20;

/**
 * ДВА ВЕРХНИХ УРОВНЯ — ОТДЕЛЬНЫМ СПИСКОМ ПОВЕРХ ЛЕНТЫ (владелец 09.09.2026,
 * переделано под его формулировку 12.09.2026).
 *
 * Он назвал первым «ждёт моего одобрения» и объяснил почему: такие строки
 * блокируют работу других людей. Вторым — критичное: то, на чём теряют клиента
 * или деньги. Обе категории читают не «когда дойдут руки», а сразу, поэтому они
 * не тонут в общей ленте.
 *
 * Только НЕПРОЧИТАННОЕ: прочитанное — значит разобранное, ему здесь не место,
 * оно остаётся в общей ленте ниже.
 *
 * Потолок небольшой и жёсткий: список из тридцати неотложных дел — это уже не
 * список неотложных дел.
 */
const PINNED_LIMIT = 10;

/**
 * GET /me/notifications — своя лента, свежие сверху, с числом непрочитанных.
 *
 * unreadCount считается отдельным count(), а не по items: непрочитанные могут
 * быть за пределами текущей страницы, а бейдж на колокольчике обязан показывать
 * правду по всей ленте, а не по первым двадцати записям.
 */
notificationsRouter.get("/", async (req, res) => {
  const parsed = pageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный номер страницы", details: parsed.error.flatten() });
  }
  const { page } = parsed.data;
  const where = visibleNotificationsWhere(req.agent!.id, req.agent!.role);

  /**
   * ДВА ВЕРХНИХ УРОВНЯ ТЯНЕМ ПО ВСЕЙ ЛЕНТЕ, а не только со страницы.
   *
   * «Ждёт решения» и «Критичное» — то, из-за чего ленту вообще открывают. Такая
   * строка недельной давности выпадает за двадцать записей первой страницы, и
   * без отдельного запроса с глаз исчезает ровно то, что дольше всех ждёт.
   * Остальные два уровня живут обычной постраничной лентой.
   */
  const pinnedWhere = { ...where, read: false, level: { in: ["APPROVAL", "CRITICAL"] } };

  const [items, total, unreadCount, pinned, approvalCount, criticalCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, read: false } }),
    // Только на первой странице: это шапка ленты, а не её часть, и повторять её
    // над каждой следующей страницей незачем.
    page === 1
      ? prisma.notification.findMany({ where: pinnedWhere, orderBy: { createdAt: "desc" }, take: PINNED_LIMIT })
      : Promise.resolve([]),
    prisma.notification.count({ where: { ...where, read: false, level: "APPROVAL" } }),
    prisma.notification.count({ where: { ...where, read: false, level: "CRITICAL" } }),
  ]);

  /**
   * СТАРЫЕ СТРОКИ ЗАКРЫВАЮТСЯ НА ВЫДАЧЕ (22.09.2026) — тем же приёмом, что и
   * номер внутри имени клиента (lib/clientPhone.ts): с сегодняшнего дня лента
   * пишется уже с маской (lib/notifications.ts), но всё, что записано РАНЬШЕ,
   * живёт в БД с открытым номером — а колокольчик хранит уведомления 90 дней.
   * Узкий разбор, а не maskPhonesInFreeText: в теле рядом стоят дата и время.
   */
  const canSeePhone = can(req, "clients.viewPhone");
  const shown = <T extends { title: string; body: string }>(rows: T[]): T[] =>
    canSeePhone ? rows : rows.map((n) => ({ ...n, title: maskPhonesInText(n.title), body: maskPhonesInText(n.body) }));

  res.json({
    items: shown(items),
    unreadCount,
    pinned: shown(pinned),
    approvalCount,
    criticalCount,
    hasMore: page * PAGE_SIZE < total,
  });
});

const idParamSchema = z.object({ id: z.guid() });

/** Отметить одно уведомление прочитанным — только своё: чужой id молча не находится (404). */
notificationsRouter.post("/:id/read", async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Неверный идентификатор" });

  const result = await prisma.notification.updateMany({
    where: { id: parsed.data.id, ...visibleNotificationsWhere(req.agent!.id, req.agent!.role) },
    data: { read: true },
  });
  if (result.count === 0) return res.status(404).json({ error: "Уведомление не найдено" });
  res.json({ ok: true });
});

const readManySchema = z.object({ ids: z.array(z.guid()).min(1).max(200) });

/**
 * Отметить прочитанными перечисленные записи — автопрочтение ленты (WEB-PAGES16,
 * 04.10.2026): шлёт только то, что человек видит, и без «Ждёт решения»/«Критичное».
 * Только свои: чужой id просто не совпадёт с agentId и не затронется.
 */
notificationsRouter.post("/read-many", async (req, res) => {
  const parsed = readManySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверный список уведомлений", details: parsed.error.flatten() });

  const result = await prisma.notification.updateMany({
    where: { id: { in: parsed.data.ids }, ...visibleNotificationsWhere(req.agent!.id, req.agent!.role), read: false },
    data: { read: true },
  });
  res.json({ ok: true, count: result.count });
});

/** Отметить всю ленту прочитанной — кнопка «Прочитать всё». */
notificationsRouter.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({
    where: { ...visibleNotificationsWhere(req.agent!.id, req.agent!.role), read: false },
    data: { read: true },
  });
  res.json({ ok: true });
});
