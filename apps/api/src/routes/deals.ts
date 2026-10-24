import { closeWorkAfterLeavingSale } from "../lib/propertyLeftSale.js";
import { Router, type Request } from "express";
import type { Prisma } from "../generated/prisma/client.js";
import {
  DEAL_DOCUMENT_KIND_LABELS,
  dealCreateSchema,
  dealQuerySchema,
  dealUpdateSchema,
  parseShortCode,
  type DealDocumentKind,
  RATED_ROLES,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { fromCents, splitCents, sumCents, toCents } from "../lib/money.js";
import { can, canBindClient, foreignDealWriteDenied, requireAuth, scopeDealsToOwnAgent } from "../auth/middleware.js";

import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { logAudit } from "../lib/audit.js";
import { loadEventPoints, recordScoreEvent } from "../lib/scoreJournal.js";
import { withMaskedClient } from "../lib/clientPhone.js";
import { conductedShowingWhere } from "../lib/conductedShowing.js";
import { notifyWaitingBuyersOfNewProperty } from "../lib/propertyMatchFilter.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { distinctUploadedKinds, getDealRequiredDocuments } from "../lib/dealDocumentsDb.js";
import { publishDealUpdated } from "../lib/livePublish.js";
import { recomputeSellerCardState } from "../lib/sellerCardState.js";
import { logTimeline } from "../lib/timeline.js";
import { runClientAutopilotInBackground } from "../lib/clientAutopilot.js";
import { closeAutoTasks } from "../lib/autoTasks.js";
import { upsertSalaryExpenses } from "../lib/financeAutomation.js";
import { reverseDealClosedScore } from "../lib/dealAnnul.js";
import { dushanbeWallClock } from "../lib/dushanbeTime.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";

const STAGE_LABELS: Record<string, string> = {
  NEGOTIATION: "Переговоры",
  AGREEMENT_PENDING: "Согласование",
  CONTRACT_SIGNED: "Договор подписан",
  PENDING_APPROVAL: "Ждёт одобрения",
  COMPLETED: "Завершена",
  CANCELLED: "Отменена",
};

/**
 * ПРОЦЕНТ ОТ ЦЕНЫ — С ОКРУГЛЕНИЕМ ДО КОПЕЙКИ ЗДЕСЬ, А НЕ «КАК-НИБУДЬ».
 *
 * Денежные колонки объявлены как обычный `Decimal`, а это в Postgres
 * DECIMAL(65,30): база НЕ округляет ничего. `123457 * 2.5 / 100` в двоичной
 * арифметике даёт 3086.4250000000001818989403545856, и именно это ложилось в
 * комиссию сделки — вместе с хвостом в тридцать знаков, который потом вылезал
 * в выгрузках и в сверках с бухгалтером.
 */
function commissionOf(price: unknown, percent: number): number {
  return fromCents(Math.round((toCents(price) * percent) / 100));
}

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
  if (can(req, "finance.view") || deal.agentId === req.agent!.id) return true;
  return deal.stage === "PENDING_APPROVAL" && canCompleteDeal(req) && can(req, "deals.viewAll");
}

export const dealsRouter = Router();

class DealConflictError extends Error {}

/**
 * Деньги сделки — не поле формы рядового агента.
 *
 * Комиссия считается сервером из Настроек (интейкер + риелтор + компания), и от неё
 * же считается снапшот выплат при закрытии. Пока эти поля принимались от кого угодно,
 * агент мог завести сделку по своему клиенту с любой суммой и сам перевести её в
 * COMPLETED — в бухгалтерии директора появлялась выплата этому агенту, объект
 * помечался «Продано» и уходил на сайт, а вернуть этап назад уже нельзя.
 * Руководителю ручной ввод оставлен: реальная сделка может закрыться не по прайсу.
 */
function canSetCommission(req: Request): boolean {
  return can(req, "deals.setCommission");
}

/**
 * Закрытие сделки — необратимое денежное событие (снапшот долей, статус объекта
 * SOLD, публикация на сайте, KPI). Подтверждает его руководитель, а не тот, кому
 * начисляется выплата. Агент ведёт сделку по стадиям и может её отменить.
 */
function canCompleteDeal(req: Request): boolean {
  return can(req, "deals.complete");
}

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
  const parsed = dealCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  const data = parsed.data;
  /**
   * Сделка НЕ МОЖЕТ родиться терминальной (26.08.2026). Раньше руководителю
   * разрешалось создать её сразу COMPLETED — но транзакция создания выполняет
   * только резерв объекта и deal.create: без closedAt, без снапшота долей
   * комиссии, объект не SOLD, клиент не DEAL_CLOSED, баллы не начислены, сайт
   * не узнал о продаже. Вся отчётность фильтрует по closedAt — такая сделка
   * становилась деньгами-призраком, которых нет ни в одном отчёте. Закрытие
   * (и отмена) идут ТОЛЬКО через PATCH, где живёт вся денежная механика.
   */
  if (data.stage === "COMPLETED" || data.stage === "CANCELLED") {
    return res.status(400).json({
      error: "Сделка не может быть создана сразу закрытой или отменённой — создайте её и закройте отдельным шагом",
    });
  }
  if (!canSetCommission(req) && (data.commissionAmount !== undefined || data.commissionPercent !== undefined)) {
    return res.status(403).json({ error: "Сумму комиссии задаёт руководитель — она считается автоматически по Настройкам" });
  }
  // deletedAt: null — через интерфейс недостижимо (селекты питаются отфильтрованными
  // списками), но прямой вызов API заводил сделку по объекту из Корзины: объект уходил
  // в RESERVED, и после этого его нельзя было ни восстановить, ни удалить.
  const [client, property] = await Promise.all([
    prisma.client.findFirst({
      where: { id: data.clientId, deletedAt: null },
      include: { assignedAgent: { select: { id: true, isActive: true } } },
    }),
    prisma.property.findFirst({ where: { id: data.propertyId, deletedAt: null } }),
  ]);

  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  /**
   * На кого сделка (глубокая проверка 02.10.2026, F1). Кому нельзя назначать
   * чужие сделки — тот заводит сделку только на себя. Руководитель (право
   * clients.assign) может назвать агента явно, а без явного выбора сделка
   * заводится на АГЕНТА КЛИЕНТА: блок «Сделка по объекту» на карточке объекта
   * agentId не шлёт вовсе, и раньше сделка, объект и баллы за закрытие молча
   * уходили самому руководителю, а агент клиента сделку не видел. Отключённый
   * агент клиента сделку не получает — тогда она на того, кто её заводит.
   */
  const clientAgentId = client.assignedAgent?.isActive ? client.assignedAgent.id : undefined;
  const agentId = can(req, "clients.assign") ? data.agentId ?? clientAgentId ?? req.agent!.id : req.agent!.id;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  if (!agent) return res.status(400).json({ error: "Указанный агент не найден" });
  /**
   * ТРЕБОВАНИЕ 10 (аудит 02.09.2026): сделку можно закрыть только при наличии
   * объекта И покупателя. Объект проверяется схемой (propertyId NOT NULL), а
   * покупатель — здесь: клиент обязан быть BUYER. Без этой проверки через API
   * создавалась сделка по продавцу (живой прогон A2), объект уходил в RESERVED,
   * продавец получал DEAL_CLOSED и бонусы — всё мимо бухгалтерии. UI фильтрует
   * список клиентов по kind=BUYER (PropertyDetail.tsx:115), но прямой вызов API
   * обходил этот фильтр.
   */
  if (client.kind !== "BUYER") {
    return res.status(409).json({ error: "Для закрытия сделки необходим покупатель" });
  }
  if (!canBindClient(req, client)) {
    return res.status(403).json({ error: "Агент не может создавать сделку для чужого клиента" });
  }
  if (["SOLD", "WITHDRAWN"].includes(property.status)) {
    return res.status(409).json({ error: "Нельзя создать сделку по проданному или снятому с продажи объекту" });
  }
  // Бронь могла возникнуть раньше самой сделки — по ветке «Договор» в «Итоге
  // показа» (routes/me.ts::completeMeetingSummary, уточнение владельца 13.08.2026
  // ночью). Свою же бронь агент продолжает в сделку — но именно под ТОГО клиента,
  // для кого она сделана (reservedForClientId, найдено код-ревью 13.08.2026): у
  // одного агента бывает несколько активных клиентов, и без этой проверки сделку
  // можно было молча оформить не под того, перезаписав чужую (по факту) бронь.
  // reservedForClientId=null — легаси-строка до миграции, не блокируем.
  const sameAgentReservation = property.status === "RESERVED" && property.assignedAgentId === agentId;
  const reservationClientMismatch =
    sameAgentReservation && property.reservedForClientId != null && property.reservedForClientId !== data.clientId;
  if (property.status === "RESERVED" && (!sameAgentReservation || reservationClientMismatch)) {
    return res.status(409).json({ error: "По объекту уже идёт сделка — объект зарезервирован" });
  }
  // Терминальные стадии на создании отвергнуты выше — проверка показа для
  // закрытия живёт в PATCH, единственном пути закрытия сделки.

  // Для агента поля выше отвергнуты, так что здесь они всегда undefined — комиссия
  // придёт из Настроек. Руководитель может задать свою (одно из двух полей).
  let commissionPercent = data.commissionPercent;
  let commissionAmount = data.commissionAmount;
  if (commissionPercent === undefined && commissionAmount === undefined) {
    const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    // Комиссия сделки = интейкер + риелтор + компания (по умолчанию 0.5+0.5+1 = 2%).
    commissionPercent =
      Number(settings.commissionIntakePercent) +
      Number(settings.commissionRealtorPercent) +
      Number(settings.commissionCompanyPercent);
    commissionAmount = commissionOf(property.price, commissionPercent);
  } else if (commissionAmount === undefined && commissionPercent !== undefined) {
    // Руководитель задал ТОЛЬКО процент. Раньше сумма так и оставалась null:
    // ветка выше срабатывает лишь когда пусты ОБА поля. В деньгах считается
    // именно сумма — доли интейкера, риелтора и компании при закрытии сделки
    // выходили нулевыми, хотя процент в карточке стоял правильный.
    commissionAmount = commissionOf(property.price, commissionPercent);
  } else if (commissionPercent === undefined && commissionAmount !== undefined) {
    // Симметрично: задали сумму — восстанавливаем процент, иначе в карточке
    // сделки пустует поле, по которому потом сверяют условия с клиентом.
    const price = Number(property.price);
    if (price > 0) commissionPercent = (commissionAmount / price) * 100;
  }

  // Риелтор объекта назначается автоматически в момент сделки: им становится
  // агент клиента, выбравшего этот объект. Заранее (при создании объекта)
  // риелтор не назначается — это было бы нечестно к остальным агентам.
  // Объект резервируется, чтобы по нему не завели параллельную сделку.
  let deal;
  try {
    deal = await prisma.$transaction(async (tx) => {
      // Резерв строго по условию AVAILABLE — или уже своя более ранняя бронь с
      // «Договора» в «Итоге показа», сделанная под ЭТОГО ЖЕ клиента — внутри
      // транзакции: два конкурентных POST по одному объекту не создадут две
      // сделки, второй получит count 0 и 409. reservedForClientId=null (легаси)
      // тоже пропускаем — тот же допуск, что и в проверке выше.
      // deletedAt: null — объект читался выше ДО транзакции, а в Корзину его могли
      // отправить за это время; резерв удалённого объекта дал бы сделку у объекта
      // в Корзине (аудит Codex 04.10.2026, №13). Тот же UPDATE берёт блокировку
      // строки, под которой Корзина перепроверяет сделки (lib/trashProperty.ts).
      const reserved = await tx.property.updateMany({
        where: {
          id: property.id,
          deletedAt: null,
          OR: [
            { status: "AVAILABLE" },
            {
              status: "RESERVED",
              assignedAgentId: agentId,
              OR: [{ reservedForClientId: null }, { reservedForClientId: data.clientId }],
            },
          ],
        },
        // reservedAt переставляется на момент сделки — таймер «резерв N рабочих дней»
        // (Настройки → Деньги, см. lib/dealReservation.ts) отсчитывается заново от
        // реального оформления, а не от более ранней предварительной брони.
        data: { status: "RESERVED", assignedAgentId: agentId, reservedAt: new Date(), reservedForClientId: data.clientId },
      });
      if (reserved.count !== 1) {
        throw new DealConflictError("По объекту уже идёт сделка — объект зарезервирован");
      }
      /**
       * ВТОРАЯ АКТИВНАЯ СДЕЛКА ПО ТОМУ ЖЕ ОБЪЕКТУ — НЕТ (аудит №4, 27.08).
       *
       * Атомарный резерв выше НАМЕРЕННО пропускает состояние «объект уже
       * зарезервирован этим же агентом под этого же клиента» — это путь «бронь
       * с Итога показа → сделка». Но ровно из-за этого двойной клик или ретрай
       * после таймаута создавал ВТОРУЮ сделку той же пары: воронка и лимиты
       * считали её как настоящую, а закрыть её было нечем — она висела вечно.
       */
      const liveDeal = await tx.deal.findFirst({
        where: { propertyId: data.propertyId, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { id: true },
      });
      if (liveDeal) {
        throw new DealConflictError("По этому объекту уже есть незакрытая сделка");
      }
      // Сделка — пятая ветка «Итога показа» («Договор»): дошли до неё, значит
      // «Подбор»/«Переговоры» больше не актуальны, сделка несёт свою стадию сама.
      await tx.client.updateMany({ where: { id: data.clientId, buyerStage: { not: null } }, data: { buyerStage: null } });
      return tx.deal.create({
        // Валюта комиссии = валюта объекта: commissionAmount считается от property.price
        // (см. выше), и без этого снапшота сумма теряла единицы измерения ещё на входе.
        data: { ...data, commissionPercent, commissionAmount, currency: property.currency, agentId },
      });
    });
  } catch (error) {
    if (error instanceof DealConflictError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
  // Резерв по сделке — место монтажёра освобождается, как при ручном резерве.
  closeWorkAfterLeavingSale(data.propertyId, "reserved");
  logAudit(req, "DEAL_CREATE", "Deal", deal.id, {
    clientId: data.clientId,
    propertyId: data.propertyId,
    agentId,
    commissionAmount,
  });
  // Живое событие — ПОСЛЕ коммита транзакции, как и в PATCH ниже: без него
  // руководитель видел новую сделку на доске только по таймеру 60 с (ночной
  // аудит 24.09.2026, №11).
  publishDealUpdated({
    dealId: deal.id,
    clientId: deal.clientId,
    agentId: deal.agentId,
    stage: deal.stage,
    actorId: req.agent!.id,
  });
  // «Закройте сделку или обновите статус по заявке…» — покупатель без единой
  // сделки заводит эту задачу (lib/dealStalePipeline.ts::findStaleBuyers, «нет
  // ни одной Deal вообще»); первая же сделка снимает повод, даже до закрытия
  // (21.09.2026, lib/autoTasks.ts).
  void closeAutoTasks(data.clientId, ["deal_stale_buyer_close_deal"]).catch((err) =>
    console.error("[сделка] автозакрытие «закройте сделку»:", err instanceof Error ? err.message : err)
  );
  // Новая сделка — в сводку ИИ на карточке клиента (29.09.2026).
  runClientAutopilotInBackground(data.clientId, "deal_changed");
  res.status(201).json(serializeDealMoney(deal, seesDealMoney(req, deal)));
});

dealsRouter.patch("/:id", requireAuth, async (req, res) => {
  const parsed = dealUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const ownAgentId = scopeDealsToOwnAgent(req);
  const existing = await prisma.deal.findUnique({
    where: { id: req.params.id },
    include: {
      client: {
        select: {
          fullName: true,
          deletedAt: true,
          // lostAt/lastAgentId — только для бонуса «подобрал брошенного» ниже
          // (client_recovered_bonus): lostAt не сбрасывается при реактивации
          // (см. lib/scoreJournal.ts), поэтому это надёжный след «был LOST
          // когда-то», даже если к моменту закрытия сделки status уже не LOST.
          lostAt: true,
          lastAgentId: true,
        },
      },
    },
  });
  if (!existing) return res.status(404).json({ error: "Сделка не найдена" });
  if (ownAgentId && existing.agentId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  {
    const denied = foreignDealWriteDenied(req, existing, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }

  const data = parsed.data;
  // rejectReason и skipDocuments не колонки Deal — снапшот в аудит / флаг чек-листа
  // документов, а не сама запись; dealFields используется вместо data там, где
  // объект целиком уходит в tx.deal.update (иначе Prisma падает валидацией на
  // незнакомом поле — поймано на deal-documents-payout, 11.09.2026). version —
  // тоже не то, что нужно передавать как есть (см. clientVersion ниже, аудит
  // надёжности 13.09.2026, находка 2: пишем через increment, а не присланным числом).
  const { rejectReason, skipDocuments, version: clientVersion, ...dealFields } = data;
  if (existing.stage === "COMPLETED" && data.stage && data.stage !== "COMPLETED") {
    return res.status(409).json({ error: "Завершённую сделку нельзя вернуть на предыдущий этап" });
  }
  /**
   * ОТМЕНЁННАЯ СДЕЛКА ВОЗВРАЩАЕТСЯ В РАБОТУ ТОЛЬКО РУКОВОДИТЕЛЕМ И ТОЛЬКО НА
   * СВОБОДНЫЙ ОБЪЕКТ (ночная проверка 24.09.2026, круг «Сделки, деньги», №3).
   *
   * Стоп выше — только из COMPLETED; ниже — только при клиенте в Корзине. Из
   * CANCELLED в рабочую стадию сделку мог вернуть кто угодно и без единой
   * проверки, а проверка «по объекту уже есть незакрытая сделка» жила только в
   * POST. Реальный путь: резерв истёк (крон отменил сделку и вернул объект в
   * продажу), другой агент завёл по объекту свою сделку, а запоздавший
   * офлайн-PATCH канбана первого агента (без version) досылается с прежним
   * body и оживляет отменённую — две живые сделки на один объект. Роль
   * проверяется здесь, свободность объекта — внутри транзакции ниже, той же
   * проверкой, что и в POST.
   */
  const isRevivingCancelled = existing.stage === "CANCELLED" && !!data.stage && data.stage !== "CANCELLED";
  // АННУЛИРОВАННУЮ СДЕЛКУ НЕ ОЖИВЛЯЕМ (C10, 02.10.2026): она уже снята со всех
  // счётчиков, баллы списаны, объект вернулся в продажу. Состоялась на деле —
  // заводится новой сделкой (lib/dealAnnul.ts).
  if (isRevivingCancelled && existing.annulledAt) {
    return res.status(409).json({ error: "Сделка аннулирована — вернуть её нельзя, заведите новую" });
  }
  if (isRevivingCancelled && !canCompleteDeal(req)) {
    return res.status(403).json({ error: "Вернуть отменённую сделку в работу может только руководитель" });
  }
  /**
   * КЛИЕНТ В КОРЗИНЕ — СДЕЛКУ ДАЛЬШЕ НЕ ДВИГАЕМ (27.08.2026, сплошная охота).
   *
   * Мягкое удаление клиента разрешено, только когда ВСЕ его сделки CANCELLED
   * (routes/clients/card.ts) — то есть у карточки в Корзине почти всегда есть
   * отменённая сделка. Возврата с CANCELLED на рабочую стадию явного запрета не
   * было (единственный стоп выше — «завершённую нельзя вернуть»), и прямой
   * вызов API мог довести такую сделку до COMPLETED: клиенту в Корзине ставился
   * DEAL_CLOSED, писался снапшот долей комиссии, начислялся Royal Score, а
   * директор не мог даже открыть карточку, чтобы сверить, что произошло — CRM
   * отвечает на неё 404. POST /deals такую проверку уже делает (см. комментарий
   * там), здесь её не было.
   */
  if (existing.client?.deletedAt && data.stage && data.stage !== existing.stage) {
    return res.status(409).json({ error: "Клиент этой сделки в Корзине — сначала восстановите карточку" });
  }
  // Право проверяется РАНЬШЕ порядка этапов: агенту, которому вообще нельзя
  // завершать сделки, нужно вернуть «не хватает прав», а не «не в том порядке» —
  // иначе сообщение об ошибке намекало бы, что дело только в стадии.
  if (data.stage === "COMPLETED" && existing.stage !== "COMPLETED" && !canCompleteDeal(req)) {
    return res.status(403).json({ error: "Закрыть сделку может только руководитель" });
  }
  // ЗАВЕРШЕНИЕ ЧЕРЕЗ «ОТПРАВЛЕНО НА ЗАКРЫТИЕ» — но не единственный путь (19.08.2026,
  // просьба владельца). Обычный агент сначала указывает фактическую цену и комиссию
  // суммой (PENDING_APPROVAL), директор одобряет отдельным шагом. Руководитель же
  // (canCompleteDeal) может закрыть сделку сам одним действием, минуя промежуточный
  // этап — тот же смысл, просто без второго человека, которому нечего одобрять:
  // он и вводит цифры, и принимает решение. Требования те же: показ проведён, цена
  // и все три суммы указаны — см. hasFullClosingData ниже.
  // 0,5% «за приём объекта» отменены 11.09.2026 — суммы делятся только между
  // риелтором и компанией, поэтому обязательных сумм закрытия теперь две, а не три.
  const hasFullClosingData =
    data.soldPrice !== undefined &&
    data.commissionRealtorAmount !== undefined &&
    data.commissionCompanyAmount !== undefined;
  /**
   * КОМИССИЯ НЕ БОЛЬШЕ ЦЕНЫ ПРОДАЖИ (найдено аудитом 18.09.2026). Zod проверяет
   * только знак сумм (`moneyNonNegative`/`moneyPositive`), а не их соотношение —
   * ни здесь, ни во фронтенде (DealSubmitModal) ничего не мешало ввести комиссию
   * больше цены объекта и закрыть сделку с такими цифрами. Считаем в копейках,
   * как и остальные деньги в файле (lib/money.ts) — сравнение через Number
   * ловило бы двоичный хвост на суммах с копейками.
   */
  /**
   * ПО ИТОГОВЫМ ЗНАЧЕНИЯМ (находка №215, 01.10.2026): тело запроса ?? то, что уже
   * лежит на сделке. Раньше сравнивалось только когда в теле пришли все три числа
   * сразу — правка одной доли директором на PENDING_APPROVAL или «Одобрить» с
   * уже сохранёнными цифрами проходили мимо проверки.
   */
  const finalSoldPrice = data.soldPrice ?? existing.soldPrice;
  const finalRealtorAmount = data.commissionRealtorAmount ?? existing.commissionRealtorAmount;
  const finalCompanyAmount = data.commissionCompanyAmount ?? existing.commissionCompanyAmount;
  const commissionExceedsPrice =
    finalSoldPrice !== null &&
    finalSoldPrice !== undefined &&
    finalRealtorAmount !== null &&
    finalRealtorAmount !== undefined &&
    finalCompanyAmount !== null &&
    finalCompanyAmount !== undefined &&
    sumCents([finalRealtorAmount, finalCompanyAmount]) > toCents(finalSoldPrice);
  const isDirectComplete =
    data.stage === "COMPLETED" && existing.stage !== "COMPLETED" && existing.stage !== "PENDING_APPROVAL" && canCompleteDeal(req);
  if (isDirectComplete && !hasFullClosingData) {
    return res.status(400).json({
      error: "Укажите фактическую цену продажи и комиссию (риелтор, компания), прежде чем закрывать сделку",
    });
  }
  if (isDirectComplete && commissionExceedsPrice) {
    return res.status(400).json({
      error: "Комиссия (риелтор + компания) не может превышать фактическую цену продажи",
    });
  }
  if (data.stage === "COMPLETED" && existing.stage !== "COMPLETED" && existing.stage !== "PENDING_APPROVAL" && !isDirectComplete) {
    return res.status(409).json({ error: "Сделку можно завершить только после отправки на закрытие" });
  }
  // Отправить обратно на доработку (PENDING_APPROVAL → CONTRACT_SIGNED) — тоже решение
  // руководителя, не агента: тот, кто отправил сумму, не должен сам её у себя откатывать.
  // Находка №214 (01.10.2026): «назад» — это ЛЮБОЙ уход из PENDING_APPROVAL, кроме
  // одобрения (COMPLETED) и отмены (CANCELLED, у неё своя ветка). Раньше проверялся
  // только CONTRACT_SIGNED, и агент возвращал свою сделку в NEGOTIATION/
  // AGREEMENT_PENDING сам, мимо роли и мимо обнуления сумм.
  const isRejecting =
    existing.stage === "PENDING_APPROVAL" &&
    !!data.stage &&
    data.stage !== "PENDING_APPROVAL" &&
    data.stage !== "COMPLETED" &&
    data.stage !== "CANCELLED";
  if (isRejecting && !canCompleteDeal(req)) {
    return res.status(403).json({ error: "Вернуть сделку на доработку может только руководитель" });
  }
  // Отклонение без причины оставляло агента гадать, что поправить, а повторная
  // отправка проходила с теми же цифрами без пометки «уже отклоняли» (карта
  // docs/flow-audit-deal-11-09.md, «БАГ процесса»). Комментарий обязателен —
  // это и есть решение директора, а не техническая деталь запроса.
  if (isRejecting && !data.rejectReason) {
    return res.status(400).json({ error: "Укажите причину возврата на доработку" });
  }
  const isSubmittingForApproval = data.stage === "PENDING_APPROVAL" && existing.stage !== "PENDING_APPROVAL";
  /**
   * «Отправить на закрытие» (и прямое завершение директором) доступны только после
   * проведённого показа (спецификация, «Путь покупателя»). Сделку МОЖНО завести
   * раньше показа (переговоры часто начинаются по фото/видео, объект резервируется
   * под них) — блокируем именно ЗАКРЫТИЕ, а не создание: клиент обязан своими
   * глазами увидеть объект, прежде чем сделка считается готовой к закрытию.
   *
   * ОДНО ОПРЕДЕЛЕНИЕ «ПРОВЕДЁННОГО ПОКАЗА» НА ВСЮ CRM (исправлено 14.08.2026).
   * Здесь стояло собственное, более узкое условие — только `completedAt`. Кнопку
   * при этом открывает `hadConductedShowing`, где проведённым считается и показ,
   * до времени которого дожили. Признак берётся из lib/conductedShowing.ts, сюда
   * добавляется только привязка к объекту: показать нужно именно тот, что продаём.
   */
  if (isSubmittingForApproval || isDirectComplete) {
    const hadShowing = await prisma.interaction.findFirst({
      where: { ...conductedShowingWhere(existing.clientId), propertyId: existing.propertyId },
      select: { id: true },
    });
    if (!hadShowing) {
      return res.status(409).json({
        error: isDirectComplete
          ? "Нельзя закрыть сделку без проведённого показа этого объекта"
          : "Нельзя отправить на закрытие без проведённого показа этого объекта",
      });
    }
  }
  /**
   * ЧЕК-ЛИСТ ДОКУМЕНТОВ СДЕЛКИ (Пачка 14, 11.09.2026). Без свидетельства
   * собственности/договора закрытая сделка юридически ничем не подтверждена —
   * та же логика, что у «проведённого показа» чуть выше: блокируем именно
   * закрытие, а не создание или ведение сделки. Список обязательных видов —
   * Settings.dealRequiredDocuments (по умолчанию OWNERSHIP + CONTRACT).
   * Директор может пропустить проверку (`data.skipDocuments`), но только вместе
   * с правом закрывать сделки — обычный агент так закрытие не обойдёт — и это
   * пишется в аудит с перечнем недостающих документов, а не молча.
   */
  // «Одобрить» (PENDING_APPROVAL → COMPLETED) проверяет чек-лист ещё раз (C5,
  // 02.10.2026): между отправкой и одобрением документ мог исчезнуть, а
  // закрытие — необратимое денежное событие.
  const isApprovingSubmitted = existing.stage === "PENDING_APPROVAL" && data.stage === "COMPLETED";
  if (isSubmittingForApproval || isDirectComplete || isApprovingSubmitted) {
    const required = await getDealRequiredDocuments();
    if (required.length > 0) {
      const uploadedSet = new Set<string>(await distinctUploadedKinds(existing.id));
      const missing = required.filter((kind) => !uploadedSet.has(kind));
      if (missing.length > 0) {
        if (skipDocuments && canCompleteDeal(req)) {
          logAudit(req, "DEAL_SKIP_DOCUMENTS", "Deal", existing.id, { missingKinds: missing });
        } else {
          return res.status(400).json({
            // Русскими названиями, а не кодами OWNERSHIP/CONTRACT (аудит 23.09.2026, №58).
            error: `Не хватает документов сделки: ${missing
              .map((kind) => DEAL_DOCUMENT_KIND_LABELS[kind as DealDocumentKind] ?? kind)
              .join(", ")}. Загрузите их в «документы» на карточке сделки.`,
            missingDocumentKinds: missing,
          });
        }
      }
    }
  }
  if (isSubmittingForApproval && !hasFullClosingData) {
    // Цена и комиссия суммой — обязательны здесь: это и есть смысл шага, а не
    // необязательное уточнение. Директор одобряет уже готовые цифры, а не пустые поля.
    return res.status(400).json({
      error: "Укажите фактическую цену продажи и комиссию (риелтор, компания), прежде чем отправлять на закрытие",
    });
  }
  if (isSubmittingForApproval && commissionExceedsPrice) {
    // См. doc-comment у commissionExceedsPrice выше — та же проверка, что и у
    // прямого закрытия директором: агент не должен суметь отправить на
    // одобрение цифры, где комиссия больше цены продажи.
    return res.status(400).json({
      error: "Комиссия (риелтор + компания) не может превышать фактическую цену продажи",
    });
  }
  if (!canSetCommission(req) && (data.commissionAmount !== undefined || data.commissionPercent !== undefined)) {
    return res.status(403).json({ error: "Сумму комиссии задаёт руководитель — она считается автоматически по Настройкам" });
  }
  // Суммы риелтора/компании — вводит сам агент, но ТОЛЬКО в момент отправки на
  // закрытие. Править их у уже отправленной или закрытой сделки — снова дело
  // руководителя (тот же принцип, что и у commissionAmount/commissionPercent выше).
  const settingCommissionSums =
    data.commissionRealtorAmount !== undefined ||
    data.commissionCompanyAmount !== undefined;
  if (settingCommissionSums && !isSubmittingForApproval && !canSetCommission(req)) {
    return res.status(403).json({ error: "Комиссию по уже отправленной сделке может поправить только руководитель" });
  }

  /**
   * Цена продажи — денежное поле того же класса, что и комиссия (26.08.2026):
   * раньше data.soldPrice не ограничивался НИЧЕМ — рядовой агент мог править её
   * на любой стадии, включая закрытую, без следа в аудите. Разрешено: при
   * отправке на закрытие / прямом закрытии (там она и вводится) и руководителю;
   * у закрытой сделки — только руководителю и со строкой в Журнале действий.
   */
  if (data.soldPrice !== undefined) {
    const allowedNow = isSubmittingForApproval || isDirectComplete || canSetCommission(req);
    if (!allowedNow) {
      return res.status(403).json({ error: "Цена продажи задаётся при отправке на закрытие; поправить её потом может только руководитель" });
    }
    if (existing.stage === "COMPLETED") {
      if (!canSetCommission(req)) {
        return res.status(403).json({ error: "Цену продажи закрытой сделки меняет только руководитель" });
      }
      logAudit(req, "DEAL_SOLD_PRICE_CHANGE", "Deal", existing.id, {
        was: existing.soldPrice ? Number(existing.soldPrice) : null,
        becomes: data.soldPrice,
      });
    }
  }

  const isCompleting = data.stage === "COMPLETED" && existing.stage !== "COMPLETED";
  // №215: любое действие, которое закрывает сделку или меняет цену/доли, проверяется
  // по итоговым значениям. Возврат на доработку (isRejecting) суммы всё равно обнулит.
  if (
    commissionExceedsPrice &&
    !isRejecting &&
    (isCompleting || isSubmittingForApproval || settingCommissionSums || data.soldPrice !== undefined)
  ) {
    return res.status(400).json({
      error: "Комиссия (риелтор + компания) не может превышать фактическую цену продажи",
    });
  }
  // Правка суммы у УЖЕ закрытой сделки (директор исправляет опечатку) обязана
  // пересчитать снапшот долей: иначе Финансы продолжали показывать выплаты от старой
  // суммы, и «валовая комиссия ≠ выплаты + доход компании» — отчёт переставал сходиться.
  const isRepricingClosed =
    existing.stage === "COMPLETED" &&
    (data.commissionAmount !== undefined || data.commissionPercent !== undefined) &&
    !isCompleting;

  /**
   * Один процент без суммы (26.08.2026): раньше isRepricingClosed срабатывал, но
   * взаимного восстановления процент↔сумма (как в POST) в PATCH не было — карточка
   * показывала новый процент, а commissionAmount и весь снапшот выплат оставались
   * от старого. Пересчитываем сумму от базы: фактическая цена продажи, иначе цена
   * объявления. Симметрично — сумма без процента.
   */
  if (isRepricingClosed && data.commissionAmount === undefined && data.commissionPercent !== undefined) {
    const propertyForBase = await prisma.property.findUnique({
      where: { id: existing.propertyId },
      select: { price: true },
    });
    const priceBase = Number(data.soldPrice ?? existing.soldPrice ?? propertyForBase?.price ?? 0);
    // Округление до копейки здесь же: колонка Decimal(65,30) сохранила бы
    // двоичный хвост процента как есть (см. commissionOf).
    if (priceBase > 0) data.commissionAmount = commissionOf(priceBase, data.commissionPercent);
  } else if (isRepricingClosed && data.commissionAmount !== undefined && data.commissionPercent === undefined) {
    const propertyForBase = await prisma.property.findUnique({
      where: { id: existing.propertyId },
      select: { price: true },
    });
    const priceBase = Number(data.soldPrice ?? existing.soldPrice ?? propertyForBase?.price ?? 0);
    // До четырёх знаков, как у соседних веток пересчёта: в Decimal(65,30) не должен
    // лечь двоичный хвост деления.
    if (priceBase > 0) {
      data.commissionPercent = Math.round((data.commissionAmount / priceBase) * 100 * 10000) / 10000;
    }
  }
  // ПОДНЯТО НАВЕРХ (было объявлено только внутри транзакции, у расчёта split) —
  // нужно ЕЩЁ И здесь, до транзакции, для сигнала «сделка аннулирована» ниже
  // (isVoidingClosedDeal), а второй копии этой формулы заводить не стоит.
  // ПУТЬ ЧЕРЕЗ PENDING_APPROVAL ИЛИ ПРЯМОЕ ЗАКРЫТИЕ ДИРЕКТОРОМ (19.08.2026): суммы
  // риелтора/компании лежат либо на existing (агент указал их раньше, при отправке
  // на закрытие), либо приходят прямо в этом же запросе (директор закрывает сам,
  // минуя PENDING_APPROVAL). data имеет приоритет над снапшотом.
  const effRealtor = data.commissionRealtorAmount ?? existing.commissionRealtorAmount;
  const effCompany = data.commissionCompanyAmount ?? existing.commissionCompanyAmount;
  const hasExplicitSums = effRealtor !== null && effRealtor !== undefined && effCompany !== null && effCompany !== undefined;
  /**
   * ДОЛИ — ИСТИНА, ОБЩАЯ КОМИССИЯ РАВНА ИХ СУММЕ (аудит 04.10.2026, CRM-01). Когда
   * руководитель правит закрытую сделку, прислав доли вместе с суммой или процентом
   * (ветка «доли введены руками» в транзакции ниже, пересчёта по ней нет),
   * commissionAmount=4000 при долях 1000+2000 ложилась как есть: общая не сходилась
   * с выплатами. Выравниваем ДО журнала и UPDATE, чтобы аудит, колонка и снапшот
   * говорили одно число. Процент — от цены продажи, как у соседних веток; без цены
   * продажи остаётся присланный.
   */
  if (isRepricingClosed && settingCommissionSums && hasExplicitSums) {
    const sharesCents = sumCents([effRealtor, effCompany]);
    data.commissionAmount = fromCents(sharesCents);
    const soldPriceCents = toCents(data.soldPrice ?? existing.soldPrice ?? 0);
    if (soldPriceCents > 0) {
      data.commissionPercent = Math.round((sharesCents / soldPriceCents) * 100 * 10000) / 10000;
    }
  }
  // dealFields скопирован из data ВЫШЕ, до этого блока: достроенная здесь вторая
  // величина (сумма из процента или процент из суммы) в него не попадала. Доли
  // снапшота и аудит считались от новой суммы, а в колонку ложилась старая
  // (аудит Codex 04.10.2026, №6). Дописываем итог в то, что уходит в UPDATE.
  if (isRepricingClosed) {
    if (data.commissionAmount !== undefined) dealFields.commissionAmount = data.commissionAmount;
    if (data.commissionPercent !== undefined) dealFields.commissionPercent = data.commissionPercent;
  }
  const isCancelling = data.stage === "CANCELLED" && existing.stage !== "CANCELLED";

  // FAIR PLAY: правка ЗАВЕРШЁННОГО этапа задним числом обязана оставлять след.
  //
  // Сумма закрытой сделки — это выплаты людям и доход компании в отчётах, которые
  // уже прочитаны. Менять её иногда нужно (директор исправляет опечатку), но
  // молчаливая правка означает, что вчерашний отчёт и сегодняшний расходятся, а
  // объяснить расхождение нечем. Поэтому старое значение уходит в журнал ДО того,
  // как его перезапишут: спор «сколько было» решается записью, а не памятью.
  if (isRepricingClosed) {
    logAudit(req, "DEAL_REPRICE_CLOSED", "Deal", existing.id, {
      wasAmount: existing.commissionAmount ? Number(existing.commissionAmount) : null,
      wasPercent: existing.commissionPercent ? Number(existing.commissionPercent) : null,
      becomesAmount: data.commissionAmount ?? null,
      becomesPercent: data.commissionPercent ?? null,
    });
  }
  // Отмена сделки могла вернуть объект в AVAILABLE (см. isCancelling в транзакции
  // ниже) — отмечаем это здесь и уведомляем ждущих покупателей уже ПОСЛЕ коммита,
  // тем же best-effort приёмом, что и синхронизация с сайтом при isCompleting чуть
  // ниже (docs/auto-match-alert-plan-31-08-2026.md).
  let propertyReleasedToAvailable = false;


  /**
   * НАХОДКА АУДИТА 13.09.2026 (Fix 4): «комиссия скорректирована до нуля» на УЖЕ
   * ЗАКРЫТОЙ сделке (директор аннулирует сделку — мошенничество/ошибка) достижимо
   * ТОЛЬКО через commissionRealtorAmount=0 и commissionCompanyAmount=0 одновременно —
   * commissionAmount/commissionPercent сама схема (`moneyPositive()`/`z.number().
   * positive()`, packages/shared/src/schemas.ts) не пропускает 0 вовсе, так что
   * isRepricingClosed (гейт которого — именно commissionAmount/commissionPercent)
   * для сигнала «аннулирована» не годится напрямую. settingCommissionSums (выше,
   * до этой строки) уже отвечает на «в ЭТОМ запросе директор что-то поправил в
   * долях», hasExplicitSums — что итоговые суммы вообще определены (не null).
   */
  const isVoidingClosedDeal =
    existing.stage === "COMPLETED" &&
    !isCompleting &&
    settingCommissionSums &&
    hasExplicitSums &&
    Number(effRealtor) === 0 &&
    Number(effCompany) === 0;
  try {
    // Продавец, чью карточку нужно пересчитать ПОСЛЕ того, как сама Deal получит
    // stage: "COMPLETED" (ниже, tx.deal.update) — decideSellerCardState считает
    // hasCompletedDeal по Deal.stage В БАЗЕ, а не по локальной переменной isCompleting,
    // и на момент блока ниже (до tx.deal.update) эта самая сделка ещё лежит со старым
    // stage. Пересчёт раньше времени видел бы 0 завершённых сделок по единственному
    // объекту продавца и уводил бы его в LOST вместо DEAL_CLOSED (поймано при
    // починке 13.09.2026 — см. коммит).
    let sellerClientIdToRecompute: string | null = null;
    let completedPropertyIdForInteraction: string | null = null;
    // Возврат отменённой сделки снова зарезервировал объект — место монтажёра
    // освобождаем после коммита, как в POST.
    let revivedReservedProperty = false;
    const updated = await prisma.$transaction(async (tx) => {
      // Stage changes also write a timeline Interaction whose property FK
      // needs a row lock. Always take Property before Deal, as expiry does;
      // otherwise rejection or the timeline insert can deadlock with expiry.
      if (data.stage && data.stage !== existing.stage) {
        await tx.$queryRaw`SELECT "id" FROM "Property" WHERE "id"=${existing.propertyId} FOR UPDATE`;
      }
      if (isCompleting) {
        const property = await tx.property.findUnique({ where: { id: existing.propertyId } });
        if (!property) throw new DealConflictError("Объект не найден");

        const propertyUpdate = await tx.property.updateMany({
          where: { id: property.id, status: { in: ["AVAILABLE", "RESERVED"] } },
          // Фактическая цена продажи — та, что директор прислал сейчас (data.soldPrice),
          // иначе та, что агент указал при отправке на закрытие (existing.soldPrice,
          // снапшот на Deal). Без обеих — цена объявления, как было раньше.
          data: {
            status: "SOLD",
            soldAt: new Date(),
            // №219: тот же приоритет, что у Deal.soldPrice (новое из тела, иначе уже
            // снятое с агента, иначе цена объявления) — одно значение для обоих.
            soldPrice: data.soldPrice ?? existing.soldPrice ?? property.price,
            reservedAt: null,
            reservedForClientId: null,
          },
        });
        if (propertyUpdate.count !== 1) {
          throw new DealConflictError("Объект уже продан или снят с продажи");
        }
        await tx.client.update({ where: { id: existing.clientId }, data: { status: "DEAL_CLOSED" } });

        // Продавец объекта — отдельная карточка (Property.sellerClientId, без
        // прямой связи с Deal). До 05.09.2026 у него не было НИКАКОГО реального
        // закрытия: единственный способ пометить продавца «Сделка закрыта» был
        // тот же ручной дропдаун статуса, который не запускал ничего (найдено на
        // живом примере на проде). Теперь ставится тем же событием, что и у
        // покупателя, — реальным закрытием сделки, не текстовой меткой.
        // Сам пересчёт (decideSellerCardState через recomputeSellerCardState) —
        // ПОСЛЕ tx.deal.update ниже, где эта Deal получает stage: "COMPLETED"; см.
        // комментарий у объявления sellerClientIdToRecompute выше.
        if (property.sellerClientId) {
          sellerClientIdToRecompute = property.sellerClientId;
          completedPropertyIdForInteraction = property.id;
        }
      }

      if (isCancelling) {
        // Сделка сорвалась — объект автоматически возвращается в продажу, риелтор
        // снимается (он появится снова с новой сделкой), клиент остаётся в работе.
        // Освобождаем/размораживаем только если по объекту/клиенту нет ДРУГИХ живых
        // или завершённых сделок — чужую активную сделку отмена этой не трогает.
        const [otherPropertyDeals, otherClosedClientDeals] = await Promise.all([
          tx.deal.count({
            where: { propertyId: existing.propertyId, id: { not: existing.id }, stage: { notIn: ["CANCELLED"] } },
          }),
          tx.deal.count({
            where: { clientId: existing.clientId, id: { not: existing.id }, stage: { notIn: ["CANCELLED"] } },
          }),
        ]);
        if (otherPropertyDeals === 0) {
          const releasedReservation = await tx.property.updateMany({
            where: { id: existing.propertyId, status: "RESERVED" },
            data: { status: "AVAILABLE", reservedAt: null, reservedForClientId: null },
          });
          if (releasedReservation.count === 1) propertyReleasedToAvailable = true;
          await tx.property.updateMany({
            where: { id: existing.propertyId, status: "AVAILABLE", assignedAgentId: existing.agentId },
            data: { assignedAgentId: null },
          });
          // Симметрично покупателю чуть ниже: если сделку отменили и по этому
          // объекту больше нет других живых/закрытых сделок, продавец, которому
          // при завершении проставилось DEAL_CLOSED, возвращается в работу.
          const cancelledProperty = await tx.property.findUnique({
            where: { id: existing.propertyId },
            select: { sellerClientId: true },
          });
          if (cancelledProperty?.sellerClientId) {
            await tx.client.updateMany({
              where: { id: cancelledProperty.sellerClientId, status: "DEAL_CLOSED" },
              data: { status: "CONTACTED" },
            });
          }
        }
        if (otherClosedClientDeals === 0) {
          await tx.client.updateMany({
            where: { id: existing.clientId, status: "DEAL_CLOSED" },
            data: { status: "HOT" },
          });
        }
      }

      // Снапшот распределения комиссии в момент закрытия — по действующим долям
      // из Настроек. История выплат не меняется, даже если проценты потом поменяют.
      // 0,5% «за приём объекта» отменены 11.09.2026: доля бывшего интейкера
      // всегда уходит компании, как раньше было только у объектов без интейкера
      // (Property.intakeAgentId остаётся полем «кто завёл объект», к деньгам
      // больше не имеет отношения — см. docs/intake-share-removal-11-09.md).
      // Пересчитывается ещё и когда руководитель правит сумму у уже закрытой сделки
      // (isRepricingClosed) — снапшот обязан остаться согласованным с комиссией.
      let split: Record<string, number | string | boolean | null> = {};
      // ПУТЬ ЧЕРЕЗ PENDING_APPROVAL ИЛИ ПРЯМОЕ ЗАКРЫТИЕ ДИРЕКТОРОМ (19.08.2026):
      // суммы риелтора/компании лежат либо на existing (агент указал их раньше,
      // при отправке на закрытие), либо приходят прямо в этом же запросе
      // (директор закрывает сам, минуя PENDING_APPROVAL, — см. isDirectComplete
      // выше). data имеет приоритет: если директор что-то поправил в том же
      // запросе, фиксируется его версия, а не устаревший снапшот. Просто
      // складываются, без пересчёта по процентам из Настроек — одобрение не
      // должно молча подменять цифры, которые кто-то уже ввёл руками.
      // effRealtor/effCompany/hasExplicitSums — объявлены ВЫШЕ, до транзакции
      // (нужны также сигналу isVoidingClosedDeal вне неё).
      if (isCompleting && hasExplicitSums) {
        // refusedLeadSplit у НОВЫХ закрытий всегда false: правило «отказной лид»
        // отменено владельцем 09.09.2026 (см. подробный разбор ниже, у isRefusedLead).
        // Колонка остаётся ради уже закрытых сделок — их снапшоты не переписываются.
        split = {
          // Сложение целыми сотыми: две доли, введённые руками, дают ровно ту
          // сумму, которую человек видел на экране, без двоичного хвоста.
          commissionAmount: fromCents(sumCents([effRealtor, effCompany])),
          commissionIntakeAmount: 0,
          commissionIntakeAgentId: null,
          refusedLeadSplit: false,
        };
      } else if (existing.stage !== "COMPLETED" && settingCommissionSums && hasExplicitSums) {
        /**
         * ДОЛИ ВВЕДЕНЫ ДО ЗАКРЫТИЯ — commissionAmount ПЕРЕСЧИТЫВАЕТСЯ СРАЗУ
         * (ночная проверка 24.09.2026, круг «Сделки, деньги», находка №1).
         *
         * Раньше сумма складывалась только на «Одобрить» (ветка выше), а при
         * «Отправить на закрытие» и при правке долей директором на ждущей
         * сделке в базе оставалась оценка с создания — 2 % от цены объявления.
         * Именно её печатали «Решить сейчас», колонка «Ждёт одобрения», телефон
         * и пульт: директор одобрял, глядя на цифру, к которой введённые агентом
         * суммы отношения не имеют. Формула та же, что при одобрении, — доли
         * складываются в целых сотых. Процент — от фактической цены продажи
         * (присланной сейчас или уже снятой при отправке), с округлением до
         * четырёх знаков, чтобы в Decimal(65,30) не лёг двоичный хвост; без
         * цены продажи процент не трогаем.
         */
        const amountCents = sumCents([effRealtor, effCompany]);
        const soldPriceCents = toCents(data.soldPrice ?? existing.soldPrice ?? 0);
        split = {
          commissionAmount: fromCents(amountCents),
          ...(soldPriceCents > 0
            ? { commissionPercent: Math.round((amountCents / soldPriceCents) * 100 * 10000) / 10000 }
            : {}),
        };
      } else if (isRepricingClosed && settingCommissionSums) {
        /** Руководитель прислал доли руками вместе с переоценкой — они и есть
         *  истина, пересчёт по процентам их бы молча подменил (26.08.2026). */
      } else if (existing.stage === "COMPLETED" && !isCompleting && settingCommissionSums && hasExplicitSums) {
        /**
         * ДОЛИ ЗАКРЫТОЙ СДЕЛКИ ПРАВЯТСЯ БЕЗ commissionAmount/Percent (находка №212,
         * 01.10.2026). Главный случай — обнуление (0/0): схема не пропускает нулевую
         * commissionAmount, поэтому директор аннулирует сделку именно долями, а
         * валовая комиссия раньше оставалась прежней (Финансы: «валовая ≠ выплаты +
         * доход компании»). Валовая = сумма долей в целых сотых, процент — от цены.
         */
        const amountCents = sumCents([effRealtor, effCompany]);
        const soldPriceCents = toCents(data.soldPrice ?? existing.soldPrice ?? 0);
        split = {
          commissionAmount: fromCents(amountCents),
          ...(soldPriceCents > 0
            ? { commissionPercent: Math.round((amountCents / soldPriceCents) * 100 * 10000) / 10000 }
            : {}),
        };
      } else if (
        isRepricingClosed &&
        existing.commissionIntakeAmount !== null &&
        existing.commissionRealtorAmount !== null &&
        existing.commissionCompanyAmount !== null &&
        Number(existing.commissionAmount ?? 0) > 0
      ) {
        /**
         * ПЕРЕОЦЕНКА МАСШТАБИРУЕТ СНАПШОТ, а не пересчитывает по ТЕКУЩИМ процентам
         * из Настроек (26.08.2026): ручное распределение при закрытии терялось, а
         * если проценты с тех пор меняли — переоценка задним числом переписывала
         * доли по новым правилам, вопреки обещанию схемы «смена настроек не трогает
         * уже выплаченные деньги». Пересчёт по Настройкам остаётся только для
         * legacy-сделок без снапшота (ветка ниже).
         */
        const newBaseCents = toCents(data.commissionAmount ?? existing.commissionAmount);
        /**
         * Доли пересчитываются ПРОПОРЦИОНАЛЬНО старому снапшоту и делятся
         * методом наибольшего остатка: сумма трёх долей равна новой базе ровно,
         * до копейки. Раньше здесь было умножение на коэффициент с округлением
         * до целых сомони у двух долей — копейки исчезали, а всю накопленную
         * разницу молча забирала компания.
         */
        const [intakeCents, realtorCents, companyCents] = splitCents(newBaseCents, [
          toCents(existing.commissionIntakeAmount),
          toCents(existing.commissionRealtorAmount),
          toCents(existing.commissionCompanyAmount),
        ]);
        split = {
          commissionIntakeAmount: fromCents(intakeCents),
          commissionRealtorAmount: fromCents(realtorCents),
          commissionCompanyAmount: fromCents(companyCents),
          commissionIntakeAgentId: existing.commissionIntakeAgentId,
          refusedLeadSplit: existing.refusedLeadSplit,
        };
      } else if (isCompleting || isRepricingClosed) {
        const settings = await tx.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
        const realtorP = Number(settings.commissionRealtorPercent);
        // 0,5% «за приём объекта» отменены 11.09.2026: Settings.commissionIntakePercent
        // остаётся в схеме как история (поле убрано из UI и Zod), но доля, которую
        // оно когда-то отводило интейкеру, теперь всегда прибавляется к доле компании —
        // ровно так, как уже было для объектов без интейкера.
        const companyP = Number(settings.commissionCompanyPercent) + Number(settings.commissionIntakePercent);
        const totalP = realtorP + companyP;
        const base = Number(data.commissionAmount ?? existing.commissionAmount ?? 0);
        const baseCents = toCents(base);
        /**
         * ПРАВИЛО «ОТКАЗНОЙ ЛИД» (70/30 риелтор/интейкер) ОТМЕНЕНО деньгами дважды:
         * сам сплит — владельцем 09.09.2026, а долю интейкера в нём — 11.09.2026 (её
         * больше не получает никто). Флаг `refusedLeadSplit` читаем только чтобы
         * пронести его в снапшот истории уже закрытых сделок — на расчёт он не влияет.
         */
        const isRefusedLead = isCompleting ? false : existing.refusedLeadSplit;
        if (baseCents > 0 && totalP > 0) {
          // ДЕЛЕНИЕ КОМИССИИ — В ЦЕЛЫХ СОТЫХ, МЕТОДОМ НАИБОЛЬШЕГО ОСТАТКА: сумма
          // долей равна базе по построению, копейки распределены по правилу, а не
          // отданы компании остатком (см. историю в git blame).
          const [realtorCents, companyCents] = splitCents(baseCents, [realtorP, companyP]);
          split = {
            commissionIntakeAmount: 0,
            commissionRealtorAmount: fromCents(realtorCents),
            commissionCompanyAmount: fromCents(companyCents),
            commissionIntakeAgentId: null,
            refusedLeadSplit: isRefusedLead,
          };
        }
      }

      // Сбрасываем refusalCount на закрытой сделке — ПОСЛЕ того, как isRefusedLead
      // выше уже использовал его для снапшота раздела этой самой сделки (тот
      // расчёт не меняется). Без сброса карточка навсегда оставалась «отказной»:
      // клиент, вернувшийся через год за другим объектом, снова получал бы
      // сплит 70/30, хотя к новой сделке те давние отказы отношения не имеют —
      // найдено 11.08.2026 при разборе раздела «Потерянные клиенты».
      if (isCompleting) {
        await tx.client.updateMany({
          where: { id: existing.clientId, refusalCount: { gt: 0 } },
          data: { refusalCount: 0 },
        });
      }

      // Возврат отменённой сделки в работу — см. isRevivingCancelled выше: те же
      // две проверки, что у POST /deals, внутри транзакции, чтобы параллельное
      // создание сделки по этому же объекту не проскочило между чтением и записью.
      if (isRevivingCancelled) {
        const revivedProperty = await tx.property.findUnique({
          where: { id: existing.propertyId },
          select: { status: true },
        });
        if (!revivedProperty || ["SOLD", "WITHDRAWN"].includes(revivedProperty.status)) {
          throw new DealConflictError("Объект уже продан или снят с продажи — отменённую сделку не вернуть");
        }
        /**
         * РЕЗЕРВ ОБЪЕКТА — ТЕМ ЖЕ АТОМАРНЫМ updateMany, ЧТО В POST (аудит Codex
         * 04.10.2026, №8). Транзакция идёт в READ COMMITTED и раньше Property не
         * трогала: findFirst ниже не видит незакоммиченную сделку параллельного
         * POST, обе коммитились, и по объекту выходило две живые сделки (уникального
         * индекса «одна живая сделка на объект» нет). Обновление объекта берёт
         * блокировку его строки: параллельный POST ждёт и после коммита видит
         * RESERVED под другим клиентом (409). Заодно оживлённая сделка перестаёт
         * держать AVAILABLE-объект: таймер резерва смотрит только на RESERVED.
         */
        const reservedAgain = await tx.property.updateMany({
          where: {
            id: existing.propertyId,
            deletedAt: null,
            OR: [
              { status: "AVAILABLE" },
              {
                status: "RESERVED",
                assignedAgentId: existing.agentId,
                OR: [{ reservedForClientId: null }, { reservedForClientId: existing.clientId }],
              },
            ],
          },
          data: {
            status: "RESERVED",
            assignedAgentId: existing.agentId,
            reservedAt: new Date(),
            reservedForClientId: existing.clientId,
          },
        });
        if (reservedAgain.count !== 1) {
          throw new DealConflictError("По объекту уже идёт сделка — объект зарезервирован");
        }
        revivedReservedProperty = true;
        const liveDeal = await tx.deal.findFirst({
          where: { propertyId: existing.propertyId, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
          select: { id: true },
        });
        if (liveDeal) {
          throw new DealConflictError("По этому объекту уже есть незакрытая сделка");
        }
      }

      // data.soldPrice здесь пишется на саму Deal (снапшот при отправке на закрытие) —
      // Property.soldPrice обновляется отдельно, только при реальном завершении (выше).
      //
      // ОПТИМИСТИЧНАЯ БЛОКИРОВКА (13.09.2026, находка 2 — см. Deal.version в
      // schema.prisma). update() принимает в where только уникальные поля, а
      // version им не является, поэтому пишем через updateMany с версией в
      // условии и проверяем count: 0 строк значит, что канбан подвинул эту же
      // сделку раньше нас. Старый вызывающий без version (clientVersion===
      // undefined, пока и канбан, и DealSubmitModal его не шлют — см. отчёт)
      // обновляется как раньше, безусловно; версия растёт в любом случае.
      //
      // СТАДИЯ — ВСЕГДА В УСЛОВИИ (глубокая проверка 02.10.2026, C9). Решение о
      // переходе (одобрить, вернуть, отменить) принято по `existing`, прочитанной
      // ДО транзакции. «Одобрить» с пульта версию не шлёт, и возврат на доработку,
      // успевший между чтением и записью, затирался: сделка COMPLETED с уже
      // обнулёнными ценой и долями, объект SOLD. Стадия сменилась — 409, вся
      // транзакция (объект, клиент) откатывается.
      const updateResult = await tx.deal.updateMany({
        where:
          clientVersion !== undefined
            ? { id: existing.id, stage: existing.stage, version: clientVersion }
            : { id: existing.id, stage: existing.stage },
        data: {
          ...dealFields,
          ...split,
          // ОТКЛОНЕНИЕ (PENDING_APPROVAL → CONTRACT_SIGNED, докстринг isRejecting
          // выше): четыре суммы закрытия обнуляются — повторная отправка тех же
          // цифр без исправления больше не проходит молча (hasFullClosingData
          // на следующем isSubmittingForApproval снова потребует их все).
          // reservationExpiredAt снимается: срок резерва ниже начинается заново (C1).
          ...(isRejecting
            ? {
                soldPrice: null,
                commissionAmount: null,
                commissionRealtorAmount: null,
                commissionCompanyAmount: null,
                reservationExpiredAt: null,
              }
            : {}),
          closedAt: isCompleting ? new Date() : existing.closedAt,
          version: { increment: 1 },
        },
      });
      if (updateResult.count === 0) {
        throw new DealConflictError("Сделка изменена другим пользователем, обновите страницу");
      }
      // ВОЗВРАТ НА ДОРАБОТКУ — СВЕЖИЙ СРОК РЕЗЕРВА (глубокая проверка 02.10.2026, C1).
      // Пока сделка ждала одобрения, таймер резерва её не трогал (lib/dealReservation.ts),
      // но срок считался от создания и к возврату давно истёк — ближайший час отменил
      // бы сделку, которую директор только что вернул поправить. Агенту — обычный
      // срок резерва на исправление, от момента возврата.
      if (isRejecting) {
        await tx.property.updateMany({
          where: { id: existing.propertyId, status: "RESERVED" },
          data: { reservedAt: new Date() },
        });
      }
      const deal = await tx.deal.findUniqueOrThrow({ where: { id: existing.id } });

      // Смена этапа сделки — часть истории общения с клиентом, а не только состояние
      // канбана: без этой записи «Сделка закрыта» на карточке клиента ничем не объяснена.
      if (data.stage && data.stage !== existing.stage) {
        await logTimeline({
          clientId: existing.clientId,
          actor: { kind: "agent", agentId: req.agent!.id },
          propertyId: existing.propertyId,
          type: "SYSTEM",
          notes: isCompleting
            ? "Сделка закрыта"
            : isCancelling
              ? "Сделка отменена"
              : `Этап сделки изменён: ${STAGE_LABELS[data.stage] ?? data.stage}`,
          tx,
        });
      }

      return deal;
    });
    if (revivedReservedProperty) closeWorkAfterLeavingSale(existing.propertyId, "reserved");

    // Продавец объекта — отдельная карточка (Property.sellerClientId, без прямой
    // связи с Deal). До 05.09.2026 у него не было НИКАКОГО реального закрытия:
    // единственный способ пометить продавца «Сделка закрыта» был ручной дропдаун
    // статуса, который не запускал ничего. Теперь ставится тем же событием, что и
    // у покупателя, — реальным закрытием сделки, не текстовой меткой.
    //
    // ПРОДАВЕЦ С НЕСКОЛЬКИМИ ОБЪЕКТАМИ (находка аудита 13.09.2026): закрывать
    // карточку сразу при завершении ОДНОЙ сделки — та же ошибка, что правило
    // decideSellerCardState (lib/sellerCardState.ts) уже один раз исправляло и
    // покрыло тестом («продан ОДИН объект из трёх» не закрывает карточку, пока
    // остальные объекты в работе). Раньше здесь стоял свой updateMany, вслепую
    // проставлявший DEAL_CLOSED при любом закрытии сделки — вторая, разошедшаяся
    // копия того же правила. Переиспользуем саму функцию вместо повторной
    // реализации.
    //
    // НАМЕРЕННО ПОСЛЕ ТРАНЗАКЦИИ, А НЕ ВНУТРИ НЕЁ: recomputeSellerCardState
    // (lib/sellerCardState.ts) типизирована на `Prisma.TransactionClient | typeof
    // prisma`, и её собственные два других вызывающих (lib/sellerRefusalReview.ts,
    // lib/sellerSaleNotice.ts) уже вызывают её так же, БЕЗ передачи tx — extended
    // клиент (prisma.$extends(...) в db.ts, перехват переходов status/stage) делает
    // тип реального `tx` внутри `$transaction` структурно несовместимым с
    // `Prisma.TransactionClient` из сгенерированного клиента (TS2345), а не просто
    // стилистическим расхождением. К моменту этого вызова property уже SOLD и Deal
    // уже COMPLETED — оба закоммичены (transaction выше уже resolved), так что
    // recomputeSellerCardState на глобальном `prisma` видит ровно то же состояние,
    // что видела бы и внутри tx. Как и три соседних лучших усилия чуть ниже (снятие
    // с сайта и т.д.), это не строго атомарно с самой транзакцией — тот же класс
    // компромисса, что там уже документирован.
    if (sellerClientIdToRecompute) {
      const sellerBefore = await prisma.client.findUnique({
        where: { id: sellerClientIdToRecompute },
        select: { status: true },
      });
      const sellerVerdict = await recomputeSellerCardState({ sellerClientId: sellerClientIdToRecompute });
      // Пишем в хронологию только на ФАКТИЧЕСКИЙ переход в DEAL_CLOSED, не на
      // каждый пересчёт (recomputeSellerCardState сам решает KEEP/LOST/DEAL_CLOSED).
      if (sellerVerdict?.next === "DEAL_CLOSED" && sellerBefore?.status !== "DEAL_CLOSED") {
        await logTimeline({
          clientId: sellerClientIdToRecompute,
          actor: { kind: "agent", agentId: req.agent!.id },
          propertyId: completedPropertyIdForInteraction!,
          type: "SYSTEM",
          notes: "Сделка закрыта — объект продан",
        });
      }
    }

    // Правка суммы комиссии — денежное действие, оно обязано быть в Журнале действий
    // отдельной строкой, даже если этап сделки не менялся.
    if (data.commissionAmount !== undefined || data.commissionPercent !== undefined) {
      logAudit(req, "DEAL_COMMISSION_CHANGE", "Deal", existing.id, {
        fromAmount: existing.commissionAmount?.toString() ?? null,
        toAmount: data.commissionAmount ?? null,
        fromPercent: existing.commissionPercent?.toString() ?? null,
        toPercent: data.commissionPercent ?? null,
        stage: existing.stage,
        clientId: existing.clientId,
        propertyId: existing.propertyId,
      });
    }

    // Объект продан — снимаем его с сайта. Закрытие сделки меняет статус объекта
    // напрямую в транзакции, минуя PATCH /properties/:id, где живёт единственный
    // вызов синхронизации: из-за этого проданная квартира продолжала висеть на
    // royalhome.tj как продающаяся, и по ней звонили.
    // Закрытая сделка — главное событие в счёте агента, и в его кабинете оно должно
    // читаться словами, а не превращаться в безымянный прирост показателя «Договоры».
    // Инициатор — тот, кто закрыл: закрывает руководитель, и агент должен видеть,
    // что запись появилась не сама по себе.
    // Начисления ДОЖИДАЕМСЯ, а не отпускаем «выстрелил и забыл»: без await ответ
    // 200 «сделка закрыта» уходил раньше, чем строки счёта успевали записаться.
    // Клиенту (и тесту) обещан закрытый результат, а баллов в базе ещё нет —
    // перезапуск процесса ровно в этот зазор терял +10/+3 навсегда и молча:
    // recordScoreEvent гасит любую ошибку внутри себя, так что ожидание не
    // добавляет запросу ни одного нового способа упасть, только честность.
    // Цены начислений — из каталога баллов, по которому их считает счёт: константа
    // по умолчанию расходилась с ценой в Настройках, и журнал агента показывал
    // «+10», а счёт прибавлял другое число (C11, 02.10.2026).
    const scorePoints = (isCompleting || isVoidingClosedDeal) && existing.agentId ? await loadEventPoints() : null;
    if (isCompleting && existing.agentId && scorePoints) {
      await recordScoreEvent({
        agentId: existing.agentId,
        kind: "deal_closed",
        delta: scorePoints.deal_closed,
        reason: `Сделка закрыта: ${existing.client?.fullName ?? "клиент"}`,
        initiatorId: req.agent!.id,
        // Одна сделка — одно начисление, сколько бы раз ни пришёл PATCH.
        sourceId: existing.id,
      });

      // БОНУС «ПОДОБРАЛ БРОШЕННОГО» (01.09.2026): клиент когда-то был LOST у
      // ДРУГОГО агента (lastAgentId — прежний хозяин, lostAt — надёжный след,
      // что LOST реально был, даже если status с тех пор сменился на реактивации,
      // см. services/leads/intake.ts) и сделку довёл не тот, кто его слил, а
      // нынешний агент. Пишется ОТДЕЛЬНЫМ событием, поверх обычного deal_closed
      // выше — это не другая сделка, а надбавка к ней.
      if (existing.client?.lostAt && existing.client.lastAgentId && existing.client.lastAgentId !== existing.agentId) {
        await recordScoreEvent({
          agentId: existing.agentId,
          kind: "client_recovered_bonus",
          delta: scorePoints.client_recovered_bonus,
          reason: `Клиент, ранее потерянный другим агентом, доведён до сделки — ${existing.client?.fullName ?? "клиент"}`,
          initiatorId: req.agent!.id,
          // Тот же паттерн, что и у deal_closed: одна сделка — одно начисление.
          sourceId: `client-recovered-${existing.id}`,
        });
      }

      /**
       * САЛЮТ КОМАНДЕ (владелец 03.09.2026): «поднять дух команды», не только
       * начислить баллы тихо в фоне. Push ВСЕМ активным агентам (не только
       * закрывшему) — единственный способ «сообщить команде прямо сейчас»,
       * который в проекте уже есть: своего канала мгновенных сообщений между
       * открытыми вкладками в CRM нет. Fire-and-forget — салют не должен
       * задержать ответ 200 «сделка закрыта».
       */
      const closer = await prisma.agent.findUnique({ where: { id: existing.agentId }, select: { fullName: true } });
      void prisma.agent
        .findMany({ where: { role: { in: [...RATED_ROLES] }, isActive: true }, select: { id: true } })
        .then((agents) =>
          sendPushToAgents(
            agents.map((a) => a.id),
            {
              kind: "celebration",
              title: `🎉 Сделка закрыта — ${closer?.fullName ?? "агент"}`,
              body: `${existing.client?.fullName ?? "Клиент"} — поздравляем!`,
              url: "/deals",
              tag: `deal-celebration-${existing.id}`,
            }
          )
        )
        .catch((err) => console.error("[push] салют команде за сделку:", err));
    }

    /**
     * НАХОДКА АУДИТА 13.09.2026: переоценка УЖЕ ЗАКРЫТОЙ сделки (isRepricingClosed
     * выше) до нулевой комиссии — директор аннулирует сделку задним числом
     * (мошенничество/ошибка) — никогда не трогала Royal Score. Баллы «Сделка
     * закрыта» (и, если был, бонус «подобрал брошенного») начислялись при
     * первом закрытии и оставались висеть у агента навсегда, даже когда сама
     * сделка перестала считаться состоявшейся.
     *
     * ЗАПИСИ ЖУРНАЛА НЕ УДАЛЯЮТСЯ (см. заголовок lib/scoreJournal.ts — решение
     * не потому, что забыли маршрут удаления, а потому что стираемый журнал не
     * разрешает спор, а создаёт его). Поэтому компенсация — ОТДЕЛЬНОЕ событие
     * («…_reversed»), а не delete/update прежней строки. sourceId у компенсации
     * ТОТ ЖЕ, что у оригинала (Deal.id, и `client-recovered-${id}` — тот же
     * приём, что и у самого бонуса выше): уникальность (kind, sourceId, agentId)
     * не даёт списать эти баллы дважды, сколько раз ни повтори PATCH с той же
     * нулевой комиссией.
     *
     * Сигнал «сделка аннулирована» — isVoidingClosedDeal (объявлен до
     * транзакции выше, вместе с effRealtor/effCompany): обе доли, риелтора и
     * компании, скорректированы до 0 на уже закрытой сделке — единственный
     * реально достижимый способ обнулить комиссию (commissionAmount/Percent
     * сама схема нулю не позволяет, см. комментарий у объявления).
     */
    // №212: обнулённые доли должны дойти и до зарплатной строки за месяц закрытия
    // (раньше её пересобирал только ночной тик по прошлому месяцу, а более давняя
    // не обновлялась никогда). Строка, которую поправил человек, не трогается.
    // C12 (02.10.2026): то же для ЛЮБОЙ правки долей/комиссии закрытой сделки, не
    // только обнуления — доля 500 → 700 у июльской сделки в октябре оставляла
    // «Зарплату июля» 500 навсегда. Текущий месяц не трогаем: его строку заводит
    // ночной тик 1-го числа следующего, по всем сделкам месяца разом.
    const closedMonthKey = existing.closedAt
      ? (() => {
          const w = dushanbeWallClock(existing.closedAt);
          return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}`;
        })()
      : null;
    const nowWall = dushanbeWallClock();
    const currentMonthKey = `${nowWall.getUTCFullYear()}-${String(nowWall.getUTCMonth() + 1).padStart(2, "0")}`;
    const changedClosedShares =
      existing.stage === "COMPLETED" && !isCompleting && (settingCommissionSums || isRepricingClosed);
    if (
      closedMonthKey &&
      (isVoidingClosedDeal || (changedClosedShares && closedMonthKey < currentMonthKey))
    ) {
      try {
        await upsertSalaryExpenses(closedMonthKey);
      } catch (err) {
        void logSystemError("api", `Зарплатная строка после правки долей сделки ${existing.id} не обновлена: ${describeError(err)}`);
      }
    }

    if (isVoidingClosedDeal && existing.agentId && scorePoints) {
      // Тот же sourceId, что у оригинального deal_closed — вторая переоценка до
      // нуля (или аннулирование той же сделки потом) не спишет баллы ещё раз.
      // Одна функция на оба пути снятия баллов — lib/dealAnnul.ts (C10, 02.10.2026).
      await reverseDealClosedScore({
        dealId: existing.id,
        agentId: existing.agentId,
        client: existing.client,
        initiatorId: req.agent!.id,
        reason: `Сделка аннулирована после закрытия (комиссия обнулена): ${existing.client?.fullName ?? "клиент"}`,
        points: scorePoints,
      });
    }

    /**
     * ПОСТ-КОММИТ ЗАКРЫТИЯ (Пачка 8, 11.09.2026, docs/flow-audit-deal-11-09.md п.3).
     * Три шага — снятие объекта с сайта, уведомление стороны продавца, гашение
     * «Итога объекта» — раньше были fire-and-forget: падение процесса между
     * коммитом транзакции и этими вызовами теряло их безвозвратно, без единого
     * повтора (риск, отмеченный в карте аудита). Теперь это одно задание
     * очереди с dedupeKey на сделку — задваивания PATCH не плодят второй прогон,
     * а сбой ретраится самим воркером (см. jobs/dealCloseFollowup.ts).
     */
    if (isCompleting) {
      // Объект продан сделкой: посты и повторы в соцсетях, место монтажёра и будущие
      // показы гасятся тем же набором, что при ручной смене статуса (раньше —
      // только в PATCH /properties/:id, аудит 02.10.2026).
      closeWorkAfterLeavingSale(existing.propertyId, "sold");
      // AWAIT, НЕ FIRE-AND-FORGET (найдено 11.09 в тестах): именно от «выстрелил и
      // забыл» здесь и уходили — see докстринг выше. `enqueueBackgroundJob` сама не
      // бросает наружу (ошибки проглочены внутри неё, best-effort по контракту),
      // так что await не добавляет ответу нового способа упасть — только гарантию,
      // что к моменту ответа 200 задание уже лежит в базе, а не «когда-нибудь допишется».
      await enqueueBackgroundJob({
        type: "deal-close-followup",
        payload: {
          dealId: existing.id,
          propertyId: existing.propertyId,
          closedById: req.agent!.id,
          buyerName: existing.client?.fullName ?? null,
        },
        maxAttempts: 5,
        dedupeKey: `deal-close-followup:${existing.id}`,
      });

      /**
       * ВОПРОС ОБ ОТЗЫВЕ ЧЕРЕЗ 3 ДНЯ (Пачка 11, 11.09.2026). Тоже задание очереди
       * с dedupeKey на сделку — повторный PATCH на закрытие (задваивание клика)
       * не ставит вопрос дважды; runAt в будущем, обработчик сам подождёт своего часа.
       */
      void enqueueBackgroundJob({
        type: "deal-review-ask",
        payload: { dealId: existing.id },
        maxAttempts: 5,
        dedupeKey: `deal-review-ask:${existing.id}`,
        runAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      });
    }

    if (propertyReleasedToAvailable) {
      void prisma.property
        .findUnique({
          where: { id: existing.propertyId },
          // areaSqm/floor/totalFloors — условия подбора наравне с районом и ценой
          // (владелец 09.09.2026). Без них выборка молча шла бы по неполным
          // требованиям: поле, которого нет в select, фильтр просто не проверяет.
          select: {
            id: true,
            shortId: true,
            title: true,
            districtId: true,
            type: true,
            rooms: true,
            price: true,
            currency: true,
            areaSqm: true,
            floor: true,
            totalFloors: true,
          },
        })
        .then((property) => (property ? notifyWaitingBuyersOfNewProperty(property) : undefined))
        .catch((err) =>
          console.error("[автоподбор] сделка отменена, объект вернулся в продажу:", err instanceof Error ? err.message : err)
        );
    }

    if (data.stage && data.stage !== existing.stage) {
      // DEAL_REJECT отдельным действием (не DEAL_STAGE_CHANGE) — в аудите иначе
      // не отличить возврат на доработку директором от обычной смены этапа
      // агентом (карта docs/flow-audit-deal-11-09.md, риск №4).
      logAudit(
        req,
        isCompleting ? "DEAL_COMPLETE" : isCancelling ? "DEAL_CANCEL" : isRejecting ? "DEAL_REJECT" : "DEAL_STAGE_CHANGE",
        "Deal",
        existing.id,
        {
          from: existing.stage,
          to: data.stage,
          clientId: existing.clientId,
          propertyId: existing.propertyId,
          ...(isRejecting ? { rejectReason } : {}),
        }
      );
    }

    // «Коротко от ИИ» на карточке клиента обязано узнать об исходе сделки — тем же
    // фоновым автопилотом, что и звонки/сообщения (найдено 18.09.2026: до этого
    // сводка не знала о сделке вовсе, пока её не пересчитал случайный звонок).
    // Только на СЕТТЛЕНИЕ (COMPLETED/CANCELLED), а не на промежуточные этапы —
    // они и так не меняют факт «на чём остановились» так, как исход сделки.
    // С 29.09.2026 и на смену этапа: сводка — единственный рассказ о клиенте
    // (блок «Путь клиента» убран), и строка «Сейчас» обязана знать этап сделки.
    if (isCompleting || isCancelling) {
      runClientAutopilotInBackground(existing.clientId, "deal_closed");
    } else if (data.stage && data.stage !== existing.stage) {
      runClientAutopilotInBackground(existing.clientId, "deal_changed");
    }

    // «Закройте сделку или обновите статус по заявке…» (lib/dealStalePipeline.ts) —
    // повод исчез: либо сделка settled, либо агент прямо сдвинул этап руками
    // (21.09.2026, lib/autoTasks.ts). Любая смена этапа считается «обновили
    // статус», ровно как формулирует сама задача.
    if (data.stage && data.stage !== existing.stage) {
      void closeAutoTasks(existing.clientId, ["deal_stale_buyer_close_deal"]).catch((err) =>
        console.error("[сделка] автозакрытие «закройте сделку»:", err instanceof Error ? err.message : err)
      );
    }

    // Живое событие — ПОСЛЕ коммита транзакции (она закрылась выше), и
    // независимо от того, кто менял: доска сделок открыта и у руководителей.
    if (data.stage && data.stage !== existing.stage) {
      publishDealUpdated({
        dealId: existing.id,
        clientId: existing.clientId,
        agentId: existing.agentId,
        stage: data.stage,
        actorId: req.agent!.id,
      });
    }

    // Уведомляем агента сделки, только если этап сменил кто-то другой (админ/менеджер) —
    // сам себе агент этого не пропустит, он уже смотрит на экран.
    if (data.stage && data.stage !== existing.stage && req.agent!.id !== existing.agentId) {
      sendPushToAgent(existing.agentId, {
        title: isRejecting ? "🔄 Сделка возвращена на доработку" : isCompleting ? "Сделка закрыта 🎉" : "🔄 Этап сделки изменён",
        body: isRejecting
          ? `${existing.client.fullName} — причина: ${rejectReason}`
          : `${existing.client.fullName} — ${STAGE_LABELS[data.stage] ?? data.stage}`,
        url: "/deals",
        tag: `deal-${existing.id}`,
      }).catch((err) => console.error("[push] смена этапа сделки:", err));
    }

    res.json(serializeDealMoney(updated, seesDealMoney(req, updated)));
  } catch (error) {
    if (error instanceof DealConflictError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
});
