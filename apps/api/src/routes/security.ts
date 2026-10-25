import { requireInvestigations } from "../auth/investigations.js";
import { Router, type Request, type Response } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { recentFlaggedPostShowingCalls } from "../lib/postShowingCallFeed.js";
import { requireAuth, requirePermission, can } from "../auth/middleware.js";
import { classifyClientLossFaultBatch } from "../lib/clientLossFault.js";
import { clientNamePhoneSafe, clientPhoneFor, phoneSafeText } from "../lib/clientPhone.js";
import { logSystemError } from "../lib/systemError.js";
import { securityListQuerySchema, type RefusalInitiator, type SecurityReviewState } from "@royal-home/shared";

/**
 * Кабинет службы безопасности.
 *
 * Отдельного кабинета СБ не было вовсе: право `clients.securityReview` и панель
 * вердикта жили только внутри карточки конкретного клиента (см. routes/clients.ts,
 * POST /:id/security-review). Найти самому, у КОГО из клиентов сейчас открыт
 * вопрос, было нельзя — только руками, открывая карточки одну за другой.
 *
 * Здесь — минимальная агрегация уже существующих данных, без новых таблиц и
 * миграций: Client.securityReview (PENDING/CLEARED/CONFIRMED) — единственный
 * источник истины и для покупателя, и для продавца (kind=BUYER/SELLER), потому
 * что оба пути закрытия карточки (POST /clients/:id/refuse и «Итог объекта» в
 * routes/me.ts, коммит 4ef464b) пишут в одно и то же поле одной и той же модели.
 *
 * Деление на два раздела — по kind:
 *   • «Клиенты в СБ» — kind BUYER/OTHER (путь покупателя, отказ клиента).
 *   • «Потерянные объекты» — kind SELLER (путь продавца, «Итог объекта: Неактивный»
 *     или отказ собственника). Отдельной модели Property-исхода нет: заявка
 *     продавца — тот же Client, и вести её как отдельную сущность значило бы
 *     завести дублирующую модель ради одного экрана. Это осознанное решение
 *     (см. финальный отчёт агента) — карточка самого объекта (Property) исход
 *     закрытия заявки продавца не хранит вовсе, хранит его Client.
 *
 * ВАЖНО про «инициатора»: поля Client.refusalInitiator в схеме нет — инициатор
 * фиксируется только текстом в хронологии (Interaction.notes, "Инициатор: …"),
 * которую пишут routes/clients.ts и routes/me.ts в момент закрытия. Здесь он
 * восстанавливается best-effort разбором последней системной записи по клиенту —
 * тот же текст, что видит человек, открыв карточку, просто вынутый на список.
 * Если формат заметки когда-нибудь изменится, разбор надо поправить вместе с ним.
 */

const INITIATOR_LABEL_TO_CODE: Record<string, RefusalInitiator> = {
  Клиент: "CLIENT",
  Агент: "AGENT",
  Собственник: "OWNER",
  Компания: "COMPANY",
};

function extractInitiator(notes: string | null | undefined): RefusalInitiator | null {
  if (!notes) return null;
  const match = notes.match(/Инициатор:\s*([^.]+)/);
  if (!match) return null;
  const label = match[1].trim();
  return INITIATOR_LABEL_TO_CODE[label] ?? null;
}

export const securityRouter = Router();

securityRouter.use(requireAuth, requireInvestigations, requirePermission("clients.securityReview"));

const clientListSelect = {
  id: true,
  shortId: true,
  fullName: true,
  phone: true,
  kind: true,
  refusalReason: true,
  refusalCount: true,
  // Видно рядом с вердиктом СБ (владелец 20-21.08.2026, антифрод): отказ клиента
  // с высоким ИИ-скорингом — уже сам по себе тревожный сигнал (см. отдельный
  // сигнал «Отказ при хорошем скоринге» в routes/oversight.ts для карточек, ещё
  // НЕ дошедших до СБ). Здесь просто показываем число рядом — вторую логику
  // отбора внутри этого кабинета не заводим.
  aiScore: true,
  securityReview: true,
  securityReviewedAt: true,
  securityNote: true,
  createdAt: true,
  lastContactAt: true,
  assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
  securityReviewer: { select: { id: true, fullName: true } },
  interactions: {
    where: { type: "SYSTEM" as const },
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { notes: true, createdAt: true },
  },
} as const;

/** Сколько кандидатов на классификацию вины разбираем разом (сводка и фильтр
 *  «вина агента») — конвейер СБ разбирает закрытые карточки, а не весь каталог,
 *  но потолок всё равно обязателен (правило CLAUDE.md про пагинацию): молчаливая
 *  обрезка недопустима, упёршийся предел пишется в журнал, как и у сортировки
 *  цены в routes/properties/list.ts. */
const FAULT_SCAN_CAP = 5000;

type Kind = "BUYER" | "SELLER" | "OTHER";

function baseWhere(kindFilter: { in: Kind[] }, verdict: SecurityReviewState | undefined) {
  return {
    securityReview: verdict ? verdict : { not: null },
    kind: kindFilter,
    // Корзина не разбирается (26.08.2026): удалённый клиент оставался в списках и
    // счётчиках СБ навсегда — все смежные выборки (oversight, matching) её исключают.
    deletedAt: null,
  };
}

async function listSecurityClients(
  kindFilter: { in: Kind[] },
  page: number,
  pageSize: number,
  verdict: SecurityReviewState | undefined,
  agentFault: boolean | undefined,
  canSeePhone: boolean
) {
  const where = baseWhere(kindFilter, verdict);

  // Вина агента — НЕ колонка (считает lib/clientLossFault.ts по просроченным окнам
  // и задачам на текущий момент), поэтому фильтровать ею одним WHERE нельзя. Берём
  // id всех подходящих карточек (до FAULT_SCAN_CAP — кабинет СБ разбирает закрытые
  // случаи, не весь каталог клиентов), классифицируем БАТЧЕМ (две запроса на весь
  // список, не на страницу), дальше режем найденные id на страницы в памяти и одним
  // запросом подтягиваем полные записи ровно нужной страницы — тот же приём, что и
  // у сортировки цены объектов (routes/properties/list.ts, SORT_SCAN_CAP).
  type Row = Prisma.ClientGetPayload<{ select: typeof clientListSelect }>;
  let rows: Row[];
  let total: number;
  let lossFaults: Map<string, "client_lost_agent_fault" | "client_lost_no_fault">;

  if (agentFault !== undefined) {
    const candidateTotal = await prisma.client.count({ where });
    if (candidateTotal > FAULT_SCAN_CAP) {
      void logSystemError(
        "api",
        `Кабинет СБ: под фильтр «вина агента» попало ${candidateTotal} карточек, разобраны первые ${FAULT_SCAN_CAP}`
      );
    }
    const candidates = await prisma.client.findMany({
      where,
      select: { id: true },
      orderBy: { securityReviewedAt: { sort: "desc", nulls: "first" } },
      take: FAULT_SCAN_CAP,
    });
    const allFaults = await classifyClientLossFaultBatch(candidates.map((c) => c.id));
    const wanted = agentFault ? "client_lost_agent_fault" : "client_lost_no_fault";
    const matchingIds = candidates.map((c) => c.id).filter((id) => (allFaults.get(id) ?? "client_lost_no_fault") === wanted);
    total = matchingIds.length;
    const pageIds = matchingIds.slice((page - 1) * pageSize, page * pageSize);
    const pageRows = await prisma.client.findMany({ where: { id: { in: pageIds } }, select: clientListSelect });
    // findMany по списку id возвращает записи в порядке БД, а не в порядке
    // отобранного списка — пересобираем в исходном порядке (см. list.ts у объектов).
    const byId = new Map(pageRows.map((r) => [r.id, r]));
    rows = pageIds.map((id) => byId.get(id)).filter((r): r is (typeof pageRows)[number] => r !== undefined);
    lossFaults = allFaults;
  } else {
    const [foundRows, foundTotal] = await Promise.all([
      prisma.client.findMany({
        where,
        select: clientListSelect,
        orderBy: [{ securityReviewedAt: { sort: "desc", nulls: "first" } }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.client.count({ where }),
    ]);
    rows = foundRows;
    total = foundTotal;
    // Классификация вины — двумя запросами на всю страницу. Поштучный вызов внутри
    // map давал по два обращения к базе на каждую строку: сорок клиентов — восемьдесят
    // параллельных запросов на одно открытие раздела.
    lossFaults = await classifyClientLossFaultBatch(rows.map((r) => r.id));
  }

  const items = rows.map((row) => {
      const lastNote = row.interactions[0]?.notes ?? null;
      const lossFault = lossFaults.get(row.id) ?? "client_lost_no_fault";
      return {
        id: row.id,
        shortId: row.shortId,
        // Имя карточки — тем же правом, что и телефон строкой ниже (22.09.2026):
        // у заведённых до 20.08.2026 номер лежит в имени (lib/clientPhone.ts), и
        // кабинет СБ отдавал его сырым, при том что рядом phone уже маскировался.
        fullName: clientNamePhoneSafe(row.fullName, canSeePhone),
        // Право `clients.securityReview` входит только в пресет SECURITY, а
        // `clients.viewPhone` в нём нет: сотрудник СБ, открыв карточку того же
        // клиента, видел маску, а через свой кабинет выкачивал открытые номера
        // страницами по сорок. Правило одно на всю CRM — см. lib/clientPhone.ts.
        phone: clientPhoneFor(row.phone, canSeePhone),
        kind: row.kind,
        refusalReason: row.refusalReason,
        refusalCount: row.refusalCount,
        aiScore: row.aiScore,
        securityReview: row.securityReview,
        securityReviewedAt: row.securityReviewedAt,
        securityNote: row.securityNote,
        createdAt: row.createdAt,
        lastContactAt: row.lastContactAt,
        responsibleAgent: row.assignedAgent,
        reviewedBy: row.securityReviewer,
        initiator: extractInitiator(lastNote),
        // Оценка по текущему состоянию карточки (просрочки на сейчас), а не
        // снимок на момент потери — см. lib/clientLossFault.ts: снимок нигде не
        // сохраняется, PENDING/CONFIRMED-случаи через recordScoreEvent вообще не
        // проходят (там классификация запускается только при эскалации после
        // предела передач). Для кабинета СБ это ориентир для человека, а не
        // автоматическое начисление баллов — вердикт всё равно выносит СБ сам.
        lossFault,
      };
  });

  return { items, total, page, pageSize };
}

function parseQuery(req: Request, res: Response) {
  const parsed = securityListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
    return null;
  }
  return {
    page: parsed.data.page,
    verdict: parsed.data.verdict,
    agentFault: parsed.data.agentFault === undefined ? undefined : parsed.data.agentFault === "1",
  };
}

/** Раздел 1: «Клиенты в СБ» — путь покупателя (kind BUYER/OTHER). */
securityRouter.get("/lost-clients", async (req, res) => {
  const q = parseQuery(req, res);
  if (!q) return;
  const pageSize = 40;
  const result = await listSecurityClients(
    { in: ["BUYER", "OTHER"] },
    q.page,
    pageSize,
    q.verdict,
    q.agentFault,
    can(req, "clients.viewPhone")
  );
  res.json(result);
});

/** Раздел 2: «Потерянные объекты» — путь продавца (kind SELLER). */
securityRouter.get("/lost-properties", async (req, res) => {
  const q = parseQuery(req, res);
  if (!q) return;
  const pageSize = 40;
  const result = await listSecurityClients(
    { in: ["SELLER"] },
    q.page,
    pageSize,
    q.verdict,
    q.agentFault,
    can(req, "clients.viewPhone")
  );
  res.json(result);
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /security/summary?tab=clients|properties — суммы по вердиктам ПО ВСЕЙ
 * выборке (не по одной странице списка), заменяет честную заглушку «карточек
 * больше, чем на странице, сумму сервер не считает». groupBy по securityReview
 * даёт три плитки бесплатно (одна БД-агрегация); «С просрочками агента» — тем
 * же батч-классификатором, что и фильтр выше, с тем же потолком FAULT_SCAN_CAP.
 * Вердикт-фильтр экрана сюда не передаётся — плашка нарочно показывает разбивку
 * по ВСЕМ вердиктам сразу, а не пересчитывает один и тот же вердикт четыре раза.
 *
 * ПЛИТКИ ИЗ МАКЕТА c99db05f (`renderSecurityScreen`, 14.09.2026): «Подозрительных
 * входов», «Изменений прав доступа», «Красные флаги со звонков». Не привязаны к
 * `tab` (это не про клиентов/объекты, а про компанию целиком), но считаются в
 * одном запросе — экран открывает их вместе с остальной сводкой. Три честных
 * источника, найденных разведкой:
 *  1. LoginLog.isNewDevice (schema.prisma) — единственный существующий признак
 *     «подозрительного» входа в CRM: явного флага «подозрительный» нет, есть
 *     факт первого входа с нового устройства. Плитка так и называется в счётчике,
 *     без слова «подозрительный» — оно было бы выдумкой поверх реального поля.
 *  2. AuditLog с action=AGENT_PERMISSIONS_UPDATE (пишет routes/agents.ts при
 *     PUT /agents/:id/permissions) — единственный вид записи в журнале именно
 *     про смену прав/роли; отдельной модели под это нет.
 *  3. Красные находки робозвонка после показа (антифрод) — ровно то же, что
 *     отдаёт GET /oversight/showing-survey-calls, здесь просто агрегируется за
 *     неделю для сводки, без нового роута. Источник с 17.09.2026 —
 *     `PostShowingCall` через lib/postShowingCallFeed.ts (владелец выбрал один
 *     механизм опроса из двух); форма плитки не менялась.
 */
securityRouter.get("/summary", async (req, res) => {
  const kindFilter: { in: Kind[] } = req.query.tab === "properties" ? { in: ["SELLER"] } : { in: ["BUYER", "OTHER"] };
  const where = baseWhere(kindFilter, undefined);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - WEEK_MS);

  const [groups, total, pendingOldCount, newDeviceLogins, permissionChangeCount, lastPermissionChange, flaggedCalls] =
    await Promise.all([
      prisma.client.groupBy({ by: ["securityReview"], where, _count: { _all: true } }),
      prisma.client.count({ where }),
      prisma.client.count({
        where: {
          ...where,
          securityReview: "PENDING",
          OR: [{ securityReviewedAt: null, createdAt: { lte: weekAgo } }, { securityReviewedAt: { lte: weekAgo } }],
        },
      }),
      prisma.loginLog.count({ where: { isNewDevice: true, createdAt: { gte: weekAgo } } }),
      prisma.auditLog.count({ where: { action: "AGENT_PERMISSIONS_UPDATE", createdAt: { gte: weekAgo } } }),
      prisma.auditLog.findFirst({
        where: { action: "AGENT_PERMISSIONS_UPDATE" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      recentFlaggedPostShowingCalls(weekAgo, 20),
    ]);
  const countFor = (state: SecurityReviewState) => groups.find((g) => g.securityReview === state)?._count._all ?? 0;

  if (total > FAULT_SCAN_CAP) {
    void logSystemError("api", `Кабинет СБ: сводка «вина агента» считает первые ${FAULT_SCAN_CAP} из ${total} карточек`);
  }
  const candidates = await prisma.client.findMany({ where, select: { id: true }, take: FAULT_SCAN_CAP });
  const faults = await classifyClientLossFaultBatch(candidates.map((c) => c.id));
  const agentFault = [...faults.values()].filter((v) => v === "client_lost_agent_fault").length;

  // Флаги — превью для плитки (имя клиента + первая находка), полный разбор
  // остаётся в «Конвейере»/оверсайте (GET /oversight/showing-survey-calls),
  // здесь только то, что помещается на карточку без ещё одного запроса.
  const flagClientIds = [...new Set(flaggedCalls.map((c) => c.clientId))];
  // Потолок — строки, а не id (22.09.2026, класс «Пагинация»): flaggedCalls уже
  // ограничен двадцатью звонками (recentFlaggedPostShowingCalls выше), поэтому
  // flagClientIds физически не больше 20 — take здесь для явности инварианта.
  const flagClients = flagClientIds.length
    ? await prisma.client.findMany({
        where: { id: { in: flagClientIds } },
        select: { id: true, fullName: true },
        take: flagClientIds.length,
      })
    : [];
  const flagClientById = new Map(flagClients.map((c) => [c.id, c.fullName]));
  // Служба безопасности имеет clients.securityReview, но не clients.viewPhone
  // (22.09.2026): имя карточки и находка-цитата из разговора — свободный текст с
  // возможным номером, закрываем тем же правом, что и везде.
  const canSeePhone = can(req, "clients.viewPhone");
  const callRedFlags = flaggedCalls.map((c) => ({
    id: c.id,
    clientName: clientNamePhoneSafe(flagClientById.get(c.clientId) ?? "Клиент", canSeePhone),
    detail: phoneSafeText(c.flags[0]?.detail ?? null, canSeePhone),
    createdAt: c.createdAt,
  }));

  res.json({
    pending: countFor("PENDING"),
    cleared: countFor("CLEARED"),
    confirmed: countFor("CONFIRMED"),
    agentFault,
    pendingOldCount,
    total,
    alerts: {
      newDeviceLogins,
      permissionChangeCount,
      lastPermissionChangeAt: lastPermissionChange?.createdAt ?? null,
      callRedFlags,
    },
  });
});
