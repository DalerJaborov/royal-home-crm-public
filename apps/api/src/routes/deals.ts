import { Router, type Request } from "express";
import type { Prisma } from "../generated/prisma/client.js";
import { dealQuerySchema, parseShortCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, scopeDealsToOwnAgent } from "../auth/middleware.js";
import { withMaskedClient } from "../lib/clientPhone.js";
import { createDealFor, seesDealMoneyFor, updateDealFor } from "../lib/dealWrites.js";

/**
 * Раздел «Сделки». Создание и правка — одна дверь в lib/dealWrites.ts (10.11.2026):
 * роут разбирает запрос и отдаёт ответ, правила живут там же, где их зовёт
 * ИИ-помощница. Здесь остаются список и то, как деньги сделки уходят наружу.
 */
/**
 * Prisma-«Decimal» → число или null, ДЛЯ ОТВЕТА ROUTE, НЕ ДЛЯ БД.
 *
 * Глобальный `signMediaUrlsInResponses` (lib/mediaJsonSign.ts, К11, 11.09.2026)
 * переписывает res.json целиком: он рекурсивно обходит ответ через
 * `Object.entries` и собирает новый POJO ключ-в-ключ, чтобы подписать
 * ссылки /uploads где угодно в дереве. Экземпляр decimal.js — тоже «object»
 * с собственными перечисляемыми полями (`s`/`e`/`d`), и после такого обхода
 * теряет прототип: клиенту вместо "20000" уходит сырой `{s:1,e:4,d:[20000]}`,
 * а `Number(...)` от него — NaN (найдено 11.09, тесты про комиссию сделки).
 * Чинить это в самой middleware нельзя — файл занят параллельным агентом
 * (задача аудита К11), поэтому здесь, в единственном месте, откуда деньги
 * сделки уходят наружу, Decimal переводится в обычное число ДО res.json.
 */
function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const DEAL_MONEY_FIELDS = [
  "soldPrice",
  "commissionAmount",
  "commissionPercent",
  "commissionIntakeAmount",
  "commissionRealtorAmount",
  "commissionCompanyAmount",
] as const;

/**
 * СТЕРЕТЬ ДЕНЬГИ ИЗ СДЕЛКИ (ночная проверка 24.09.2026, №159/М4).
 *
 * Право «видеть комиссии» — finance.view, то же самое, которым уже гейтятся
 * деньги в отчётах (routes/reports.ts, tests/reports-money-needs-finance.test.ts),
 * а не deals.setCommission (это отдельное право — КТО МОЖЕТ ПРАВИТЬ сумму
 * руками, не кто может её видеть). Своя сделка — исключение: агент обязан
 * видеть комиссию по сделке, которую сам ведёт (см. seesDealMoney ниже), иначе
 * он не может проверить, на что рассчитывает после закрытия.
 *
 * Поле, которое смотреть нельзя, — undefined, а не null: null — это «денег
 * нет/не считано», а undefined честно говорит «это поле вам не показывают».
 */
export function serializeDealMoney<T extends Record<string, unknown>>(deal: T, seesMoney: boolean): T {
  const out: Record<string, unknown> = { ...deal };
  for (const field of DEAL_MONEY_FIELDS) {
    if (!(field in out)) continue;
    if (!seesMoney) {
      delete out[field];
      continue;
    }
    out[field] = decimalToNumber(out[field]);
  }
  return out as T;
}

/**
 * Видит ли ЗАПРАШИВАЮЩИЙ деньги ЭТОЙ сделки: право на финансы, своя сделка —
 * или сделка ждёт его одобрения.
 *
 * ОДОБРЯЮЩИЙ ВИДИТ СУММЫ ТОЙ СДЕЛКИ, КОТОРУЮ ОДОБРЯЕТ (глубокая проверка
 * 02.10.2026, C15; решение владельца «да, по советам»). Менеджер с правом
 * закрывать сделки (deals.complete), но без finance.view нажимал «Одобрить» —
 * необратимое денежное событие — не видя ни цены, ни комиссии. Теперь цену и
 * доли ИМЕННО этой сделки он видит, пока она «Ждёт одобрения» и пока он вправе
 * её одобрить: чужую сделку одобряет только тот, кто видит все сделки
 * (deals.viewAll, иначе PATCH отвечает 403 — scopeDealsToOwnAgent). Закрытые,
 * отменённые и остальные сделки, отчёты и «Финансы» по-прежнему закрыты.
 */
export function seesDealMoney(req: Request, deal: { agentId: string; stage: string }): boolean {
  // Правило — одно на REST и ИИ-помощницу (lib/dealWrites.ts).
  return seesDealMoneyFor(req, deal);
}

export const dealsRouter = Router();

dealsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = dealQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const { stage, agentId, q } = parsed.data;
  const ownAgentId = scopeDealsToOwnAgent(req);
  // Телефоны — по отдельному праву clients.viewPhone (директор и администрация).
  // Раньше здесь стояло «все клиенты», и галочка на список карточек заодно открывала
  // всю базу контактов — при том что сотруднику для звонка номер не нужен вовсе.
  const seesClientContacts = can(req, "clients.viewPhone");

  const where: Prisma.DealWhereInput = {};
  if (ownAgentId) where.agentId = ownAgentId;
  else if (agentId) where.agentId = agentId;
  if (stage) where.stage = stage;
  // Поиск командной палитры (аудит 23.09.2026, №67): q проверялся схемой и
  // выбрасывался — раздел «Сделки» в поиске показывал одни и те же пять
  // последних сделок, что бы ни набрали. По телефону — только тому, кто номера
  // и так видит: иначе поиск стал бы способом проверять, чей это номер.
  if (q) {
    // Номером считаем только запрос из цифр и знаков номера: цифры, выдернутые
    // из «Азиз 2», искали бы по телефонам совсем не то.
    const digits = /^[\d\s+()-]+$/.test(q) ? q.replace(/\D/g, "") : "";
    // НОМЕР («ОБ-000088», «ПК-42», «№88») — как в поиске объектов и клиентов
    // (05.10.2026): раньше сделку по номеру объекта или клиента найти было нельзя.
    const shortId = parseShortCode(q);
    where.OR = [
      ...(shortId !== null ? [{ property: { shortId } }, { client: { shortId } }] : []),
      { client: { fullName: { contains: q, mode: "insensitive" } } },
      { property: { title: { contains: q, mode: "insensitive" } } },
      { property: { address: { contains: q, mode: "insensitive" } } },
      ...(seesClientContacts && digits.length >= 4 ? [{ client: { phone: { contains: digits } } }] : []),
    ];
  }

  const include = {
    client: { select: { id: true, shortId: true, fullName: true, phone: true } },
    property: { select: { id: true, shortId: true, title: true, price: true, currency: true, photos: { take: 1, orderBy: { order: "asc" as const } } } },
    agent: { select: { id: true, fullName: true } },
  };
  /**
   * ДВЕ ВЫБОРКИ, А НЕ ОДНА НА 500.
   *
   * Раньше сюда уходил один запрос `take: 500` по всем стадиям сразу,
   * отсортированный по дате начала. Пока сделок мало, это незаметно; но
   * завершённые и отменённые копятся годами, а активных всегда десятки. В тот
   * день, когда закрытых наберётся пятьсот, они займут собой весь потолок — и
   * ДЕЙСТВУЮЩАЯ сделка, начатая давно, просто исчезнет с доски. Молча: ни ошибки,
   * ни пометки, карточки на экране нет.
   *
   * Теперь у доски свой предел, у архива — свой, и архив физически не может
   * вытеснить работу. Пределы остаются оба: роут, возвращающий массив, обязан
   * иметь потолок.
   */
  const CLOSED_STAGES = ["COMPLETED", "CANCELLED"] as const;
  /**
   * Активная доска не показывает клиентов из Корзины (27.08.2026): удаление
   * разрешено только при всех сделках CANCELLED, поэтому рабочая сделка
   * удалённого клиента появиться тут в норме не должна — фильтр на случай
   * гонки (клиента удаляют в момент, когда сделку как раз двигают) и как
   * страховка от прямого вызова API мимо интерфейса. Архив (closedDeals ниже)
   * фильтр НЕ получает нарочно: отменённая сделка удалённого клиента — законная
   * бухгалтерская история, прятать её из архива не за чем.
   */
  const activeWhere = stage ? where : { ...where, stage: { notIn: [...CLOSED_STAGES] } };
  const [activeDeals, closedDeals] = await Promise.all([
    prisma.deal.findMany({
      where: { ...activeWhere, client: { deletedAt: null } },
      orderBy: { startedAt: "desc" },
      take: 500,
      include,
    }),
    // Запрошена конкретная стадия — второй запрос не нужен: она уже целиком в первом.
    stage
      ? Promise.resolve([])
      : prisma.deal.findMany({
          where: { ...where, stage: { in: [...CLOSED_STAGES] } },
          // Архив листается на экране от свежих к старым — тем же порядком и берём.
          orderBy: { startedAt: "desc" },
          take: 500,
          include,
        }),
  ]);
  const deals = [...activeDeals, ...closedDeals];
  // Телефон клиента виден только тем, кому открыты клиенты. Права «все сделки» и
  // «все клиенты» выдаются по отдельности, и первое не должно раскрывать базу
  // контактов целиком.
  // withMaskedClient, а не ручная подмена одного поля (22.09.2026): у карточек
  // незнакомых звонивших номер лежит В ИМЕНИ («Входящий +992910001003»), и
  // список сделок отдавал его рядом с честно замаскированным `phone`. Общая
  // точка закрывает оба поля разом — см. lib/clientPhone.ts.
  res.json(deals.map((d) => serializeDealMoney(withMaskedClient(d, seesClientContacts), seesDealMoney(req, d))));
});

dealsRouter.post("/", requireAuth, async (req, res) => {
  const outcome = await createDealFor(req, req.body);
  if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
  if (!("deal" in outcome)) throw new Error("createDealFor вернул план без dryRun");
  res.status(201).json(serializeDealMoney(outcome.deal, seesDealMoney(req, outcome.deal)));
});

dealsRouter.patch("/:id", requireAuth, async (req, res) => {
  const outcome = await updateDealFor(req, req.params.id, req.body);
  if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
  if (!("deal" in outcome)) throw new Error("updateDealFor вернул план без dryRun");
  res.json(serializeDealMoney(outcome.deal, seesDealMoney(req, outcome.deal)));
});
