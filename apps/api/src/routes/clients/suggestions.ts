/**
 * Предложения ИИ по карточке. С 12.09.2026 здесь остался ОДИН маршрут — история
 * разборов (`GET /:id/card-suggestions`): подтверждать больше нечего, разбор
 * пишет услышанное в карточку сам (см. примечание ниже и lib/cardSuggestions.ts).
 */
import { Router } from "express";
import { prisma } from "../../db.js";
import { can, canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { suggestionHistoryFor } from "../../lib/cardSuggestions.js";
import { phoneSafeText } from "../../lib/clientPhone.js";

export const suggestionsRouter = Router();

/**
 * «Я в работе» — агент говорит, что клиент сложный и карточка заполняется по ходу
 * (решение владельца 30.07, третий пакет п. 8: «чтобы через 12 часов KPI не упал,
 * а бедный агент работает с клиентом»).
 *
 * Отсчёт напоминаний о незаполненной карточке начинается заново от этой отметки,
 * а не отключается: если агент правда работает, он дозаполнит; если жмёт кнопку
 * бесконечно — каждое нажатие видно в хронологии, и это разговор с руководителем,
 * а не дыра в системе.
 */
/**
 * ЗДЕСЬ БЫЛИ ТРИ МАРШРУТА БАННЕРА «После разговора: проверьте, верно ли поняли
 * клиента»: GET /:id/card-suggestion (что показать), POST .../apply (записать),
 * POST .../dismiss (отклонить).
 *
 * Баннер отменён владельцем 12.09.2026: «я уже сто раз убираю этот блок, чтобы он
 * исчез у всех и больше не появлялся. Я специально плачу за дорогую модель, чтобы
 * она не переспрашивала». Разбор звонка пишет услышанное в карточку сам и молча
 * (lib/cardSuggestions.ts::buildSuggestionFromCall), предложение не остаётся в
 * состоянии pending ни на секунду, и подтверждать стало нечего.
 *
 * Маршруты удалены, а не оставлены отвечать пустотой, ровно затем, чтобы баннер
 * нельзя было вернуть одной правкой фронтенда. Прежнее решение (07.08.2026,
 * «заполнять с подтверждением агента») отменено тем же владельцем — история
 * обоих решений записана в lib/cardSuggestions.ts.
 */

/**
 * История предложений ИИ по карточке — п.8 ТЗ «Путь покупателя»: разворачивающийся
 * список на карточке клиента, что машина предлагала раньше и что решил агент.
 *
 * Права: историю смотрит тот, кто ведёт клиента, или тот, кому доступ даёт
 * canAccessAssignedAgent (руководство и т.п.).
 *
 * С 12.09.2026 это единственный способ увидеть, что именно машина расслышала в
 * разговоре и на каких цитатах клиента это держится: сам разбор пишется в
 * карточку молча, а строка в хронологии несёт только «было → стало».
 */
suggestionsRouter.get("/:id/card-suggestions", requireAuth, async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    select: { id: true, assignedAgentId: true, acceptedAt: true, deletedAt: true },
  });
  // Корзина и «до принятия» — те же правила, что у самой карточки и у соседних
  // card-fill/property-draft (глубокая проверка 02.10.2026, A6): подсказки несут
  // бюджет, район и дословные цитаты клиента — ровно то, что карточка до
  // принятия лида агенту не показывает.
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (scopeToOwnAgent(req) && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  // Цитаты, заметка и адрес — слова клиента, в них звучит номер. Тем же правом,
  // что поле phone (lib/clientPhone.ts).
  const canSeePhone = can(req, "clients.viewPhone");
  const history = await suggestionHistoryFor(client.id);
  res.json(
    history.map((suggestion) => ({
      id: suggestion.id,
      createdAt: suggestion.createdAt,
      resolvedAt: suggestion.resolvedAt,
      status: suggestion.status,
      budgetMin: suggestion.budgetMin === null ? null : Number(suggestion.budgetMin),
      budgetMax: suggestion.budgetMax === null ? null : Number(suggestion.budgetMax),
      districtId: suggestion.districtId,
      districtName: suggestion.district?.name ?? null,
      rooms: suggestion.rooms,
      type: suggestion.type,
      address: phoneSafeText(suggestion.address, canSeePhone),
      notes: phoneSafeText(suggestion.notes, canSeePhone),
      evidence: suggestion.evidence.map((quote) => phoneSafeText(quote, canSeePhone)),
    }))
  );
});

