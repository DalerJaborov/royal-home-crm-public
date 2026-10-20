/**
 * ДОСЬЕ СОБЕСЕДНИКОВ — тот же объект, что инбокс отдаёт полем `contact`, но по
 * id самого досье: панель открывается и из карточки клиента, и из кандидата на
 * слияние, где никакого диалога под рукой нет.
 *
 * Права те же, что у инбокса (`messages.view` / `messages.viewOwn`): досье — это
 * содержание переписки другими словами, и открывать его шире, чем саму
 * переписку, значило бы обойти запрет.
 */

import { Router } from "express";
import { z } from "zod";
import {
  CONTACT_CATEGORIES,
  contactCategoryLabel,
  isContactCategory,
  type ContactCategory,
} from "@royal-home/shared";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { logAudit } from "../lib/audit.js";
import { chatScopeAgentId, contactProfileBelongsTo } from "../lib/chatScope.js";
import { mergeContactProfiles, setContactCategory } from "../lib/contactProfiles.js";
import { contactProfileView } from "../lib/contactProfileView.js";
import { clientNamePhoneSafe } from "../lib/clientPhone.js";

export const contactsRouter = Router();

function permsFor(req: Parameters<typeof can>[0]) {
  return {
    canSeeOrigin: can(req, "clients.viewOrigin"),
    canSeePhone: can(req, "clients.viewPhone"),
    canMerge: can(req, "clients.merge"),
  };
}

/**
 * КАНДИДАТЫ НА СЛИЯНИЕ ДОСЬЕ — очередь на ручное подтверждение.
 *
 * Код находит их с 20.09 (`proposeContactLink`) и складывает в базу, но решить
 * их было нечем: ни списка, ни кнопки. Кандидаты копились, и это хуже, чем если
 * бы их не искали вовсе — бот читал одно досье из двух и не знал половины того,
 * что человек рассказал.
 *
 * АВТОМАТИКА ЗДЕСЬ НЕ РЕШАЕТ НИЧЕГО, и это главное свойство: склеенные досье
 * двух людей означают чужой бюджет и чужой адрес в ответе бота. Поэтому только
 * человек с правом `clients.merge` — тот же круг, что уже решает споры о
 * дубликатах клиентов.
 *
 * Маршрут стоит ВЫШЕ `/:id` нарочно: иначе «links» прочитается как id досье.
 */
/**
 * РАЗБОР ДУБЛЕЙ — ТОЛЬКО ТОМУ, КТО ВИДИТ ВСЮ ПЕРЕПИСКУ (`messages.view`), а не
 * `messages.viewOwn`.
 *
 * Пресеты и так дают `clients.merge` только руководству, но щит сотрудника
 * (Настройки → сотрудник) выдаёт права по одной, и этого достаточно: агент с
 * «Объединять дубликаты» и «Чатами своих клиентов» получал очередь с именами и
 * категориями людей ВСЕГО агентства, а нажатием «это один человек» сливал два
 * досье, ни одного из которых ему читать не положено. Решение по дублю — это
 * чтение обоих досье, поэтому круг тот же, что у чтения переписки целиком (тот
 * же случай, что пауза бота в routes/conversations.ts: общий гейт намеренно
 * пускает оба права, и здесь им положено расходиться).
 */
contactsRouter.get(
  "/links",
  requireAuth,
  requirePermission("clients.merge"),
  requirePermission("messages.view"),
  async (req, res) => {
    // Имя досье — такой же носитель номера, как поле `phone`: у WhatsApp имени
    // часто нет вовсе и транспорт отдаёт вместо него сам номер, а карточка
    // незнакомого звонившего заводится с номером В ИМЕНИ («Входящий +992…»).
    // Право `clients.merge` есть у пресета MANAGER, а `clients.viewPhone` — нет,
    // так что без этой проверки очередь склеек показывала бы номер тому, кому он
    // закрыт во всём остальном (тот же класс — см. lib/clientPhone.ts).
    const canSeePhone = can(req, "clients.viewPhone");
    const rows = await prisma.contactLinkCandidate.findMany({
      where: { status: "PENDING" },
      select: {
        id: true,
        reason: true,
        createdAt: true,
        left: { select: { id: true, displayName: true, category: true, messagesIn: true, lastSeenAt: true } },
        right: { select: { id: true, displayName: true, category: true, messagesIn: true, lastSeenAt: true } },
      },
      orderBy: { createdAt: "desc" },
      // Предел выборки, как у любого маршрута со списком. Очередь на ручной разбор
      // длиннее пятидесяти означает, что пороги подобраны неверно, а не что нужно
      // больше строк на экране.
      take: 50,
    });
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        createdAt: r.createdAt,
        left: profileBrief(r.left, canSeePhone),
        right: profileBrief(r.right, canSeePhone),
      })),
    });
  }
);

function profileBrief(
  p: {
    id: string;
    displayName: string | null;
    category: string;
    messagesIn: number;
    lastSeenAt: Date;
  },
  canSeePhone: boolean
) {
  return {
    id: p.id,
    displayName: p.displayName && clientNamePhoneSafe(p.displayName, canSeePhone),
    category: (isContactCategory(p.category) ? p.category : "UNKNOWN") as ContactCategory,
    messagesIn: p.messagesIn,
    lastSeenAt: p.lastSeenAt,
  };
}

/**
 * КАКОЕ ДОСЬЕ ОСТАЁТСЯ ЖИТЬ. Решает код, а не человек: выбор «основного» руками
 * — это лишний вопрос на экране, а ответ на него всегда один и тот же.
 *
 * Порядок: досье с карточкой клиента (в ней уже висят сделки и история), затем
 * то, где больше входящих, затем то, что появилось раньше. Слитая запись не
 * удаляется, поэтому ошибка выбора не теряет ничего.
 */
function survivorOf(
  a: { id: string; clientId: string | null; messagesIn: number; firstSeenAt: Date },
  b: { id: string; clientId: string | null; messagesIn: number; firstSeenAt: Date }
): { targetId: string; sourceId: string } {
  const aWins =
    !!a.clientId !== !!b.clientId
      ? !!a.clientId
      : a.messagesIn !== b.messagesIn
        ? a.messagesIn > b.messagesIn
        : a.firstSeenAt <= b.firstSeenAt;
  return aWins ? { targetId: a.id, sourceId: b.id } : { targetId: b.id, sourceId: a.id };
}

contactsRouter.post(
  "/links/:id/confirm",
  requireAuth,
  requirePermission("clients.merge"),
  requirePermission("messages.view"),
  async (req, res) => {
    const candidate = await prisma.contactLinkCandidate.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        status: true,
        reason: true,
        left: { select: { id: true, clientId: true, messagesIn: true, firstSeenAt: true } },
        right: { select: { id: true, clientId: true, messagesIn: true, firstSeenAt: true } },
      },
    });
    if (!candidate) return res.status(404).json({ error: "Кандидат не найден" });
    if (candidate.status !== "PENDING") {
      return res.status(409).json({ error: "Этот кандидат уже разобран" });
    }
    /**
     * ЗАХВАТ КАНДИДАТА ДО СЛИЯНИЯ, А НЕ ПРОВЕРКА ПЕРЕД НИМ (правка 22.09.2026).
     *
     * Проверки статуса строкой выше мало: между ней и слиянием проходит время, и
     * двойное нажатие или повтор по таймауту давали ДВА слияния одной пары.
     * Второе прибавляло счётчик входящих ещё раз (бот читает его в промте как
     * «пишет нам 74 сообщения») и заводило вторую запись в журнале слияний.
     * Захватываем условным обновлением: победитель ровно один.
     */
    const claimed = await prisma.contactLinkCandidate.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "IN_PROGRESS" },
    });
    if (claimed.count === 0) {
      return res.status(409).json({ error: "Этот кандидат уже разобран" });
    }
    const { targetId, sourceId } = survivorOf(candidate.left, candidate.right);
    const merged = await mergeContactProfiles({
      targetId,
      sourceId,
      reason: candidate.reason,
      byId: req.agent!.id,
    });
    // Отметку ACCEPTED ставит само слияние, одной транзакцией с переносом: иначе
    // разобранный кандидат остался бы в очереди при упавшем переносе.
    if (!merged) {
      // Слияние не состоялось — возвращаем кандидата в очередь, иначе он застрял
      // бы захваченным навсегда и разобрать его стало бы нечем.
      await prisma.contactLinkCandidate.updateMany({
        where: { id: candidate.id, status: "IN_PROGRESS" },
        data: { status: "PENDING" },
      });
      return res.status(500).json({ error: "Не удалось объединить досье" });
    }
    logAudit(req, "contact.link.confirm", "contactProfile", targetId, { sourceId, candidateId: candidate.id });
    res.json({ ok: true, targetId });
  }
);

contactsRouter.post(
  "/links/:id/dismiss",
  requireAuth,
  requirePermission("clients.merge"),
  requirePermission("messages.view"),
  async (req, res) => {
    const updated = await prisma.contactLinkCandidate.updateMany({
      // Отклоняется только то, что ещё не разобрано: иначе повторное нажатие
      // переписало бы решение, принятое кем-то другим.
      where: { id: req.params.id, status: "PENDING" },
      // REJECTED, а не DISMISSED: именно это значение перечислено в схеме, и
      // отчёт «сколько отклонено» по чужому слову дал бы ноль (правка 22.09.2026).
      data: { status: "REJECTED", decidedAt: new Date(), decidedById: req.agent!.id },
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: "Кандидат не найден или уже разобран" });
    }
    logAudit(req, "contact.link.dismiss", "contactLinkCandidate", req.params.id);
    res.json({ ok: true });
  }
);

/**
 * Сужение выдачи для того, у кого есть только `messages.viewOwn`, живёт в
 * `lib/chatScope.ts` — там же, где сужается инбокс. Здесь его нарочно НЕТ: пока
 * правило было выписано в каждом входе своими руками, один из входов и отдавал
 * то, что другой прятал (находка 5.1 проверки бота 21.09.2026).
 */
contactsRouter.get(
  "/:id",
  requireAuth,
  requirePermission("messages.view", "messages.viewOwn"),
  async (req, res) => {
    // Полный доступ — только у того, кто видит все переписки. Остальным досье
    // отдаётся, лишь когда человек и правда их клиент (см. contactProfileBelongsTo).
    // 404, а не 403: иначе по коду ответа можно перебором узнать, какие досье
    // существуют, — тот же приём, что в инбоксе.
    const scopeAgentId = chatScopeAgentId(req);
    if (scopeAgentId && !(await contactProfileBelongsTo(req.params.id, scopeAgentId))) {
      return res.status(404).json({ error: "Досье не найдено" });
    }
    const contact = await contactProfileView(req.params.id, permsFor(req));
    if (!contact) return res.status(404).json({ error: "Досье не найдено" });
    res.json({ contact });
  }
);

const patchSchema = z.object({ category: z.enum(CONTACT_CATEGORIES) });

/**
 * РУЧНАЯ ПРАВКА КАТЕГОРИИ. Бот ошибается, а владелец хочет, чтобы «внутреннее
 * понимание» можно было поправить, не дожидаясь следующей переписки. Смена
 * дописывается в историю с `src=agent` — прошлое не стирается (решение
 * владельца), поэтому видно и то, кем человек считался раньше, и кто это
 * изменил.
 *
 * Право — `messages.view`: тот же круг, что управляет ботом на паузе. Агенту с
 * `messages.viewOwn` панель видна, но менять роль собеседника он не может.
 */
contactsRouter.patch("/:id", requireAuth, requirePermission("messages.view"), async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неизвестная категория", details: parsed.error.flatten() });
  }
  const existing = await prisma.contactProfile.findUnique({
    where: { id: req.params.id },
    select: { id: true, category: true },
  });
  if (!existing) return res.status(404).json({ error: "Досье не найдено" });

  // `setContactCategory` намеренно не ставит UNKNOWN поверх известной категории
  // («в этом ходе не понял» — не то же, что «снова незнакомец»). Человеку такой
  // отказ нужно объяснить, а не молча вернуть прежнее значение.
  if (parsed.data.category === "UNKNOWN" && existing.category !== "UNKNOWN") {
    return res.status(400).json({
      error: `Вернуть «${contactCategoryLabel("UNKNOWN")}» нельзя: выберите, кто это на самом деле`,
    });
  }

  await setContactCategory({ profileId: existing.id, category: parsed.data.category, source: "agent" });
  logAudit(req, "contact.category", "contactProfile", existing.id, {
    from: existing.category,
    to: parsed.data.category,
  });

  const contact = await contactProfileView(existing.id, permsFor(req));
  if (!contact) return res.status(404).json({ error: "Досье не найдено" });
  res.json({ contact });
});

/** Код категории из базы может не пережить правку словаря — показываем как есть. */
export function safeCategory(value: string): string {
  return isContactCategory(value) ? value : "UNKNOWN";
}
