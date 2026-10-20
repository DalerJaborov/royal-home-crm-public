/** Списки и карточка объекта: GET /, GET /export, GET /trash, GET /:id (Г3, §1.3).
 * Перенос verbatim. Статичные /export и /trash объявлены ДО /:id — как в исходном
 * файле (см. комментарий у GET /trash и правило №8 чертежа в index.ts). */
import { Router, type Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { propertyQuerySchema, PROPERTY_PIPELINE_STATUSES, parseShortCode } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { computeDemandCounts } from "../matching.js";
import { loadPipelineDeadlines, stageState } from "../../lib/propertyPipeline.js";
import { INSTAGRAM_LINK_CONTAINS } from "../../lib/instagramLink.js";
import { siteListingUrl } from "../../lib/siteListingUrl.js";
import { logSystemError } from "../../lib/systemError.js";
import { presentProperty, stripEmbedding, stripOwnerContact } from "../../lib/ownerContact.js";
import { PROPERTY_LIST_INCLUDE, presentPropertyListItems } from "../../lib/propertyListItem.js";
import { logAudit } from "../../lib/audit.js";
import { toSearchTokens, toTokenVariants } from "../../lib/searchTokens.js";
import { fuzzyPropertyIds } from "../../lib/fuzzySearch.js";
import { loadMoneyContext, priceRangeBranches, toTjs } from "../../lib/money.js";
import { cardWhereFromParam } from "../../lib/cardIdParam.js";
import { videoHandoffCardForProperty } from "../../lib/videoHandoff.js";
import { csvSafeText } from "../../lib/csv.js";
import { propertyOwnerWhere } from "../../lib/propertyOwner.js";

export const listRouter = Router();

/**
 * ГДЕ РОЛИК ЕСТЬ, А ГДЕ НЕТ — причина отказа для строки соцсетей карточки
 * (ОБ-000113, владелец 21.09.2026: «видно, где ролик есть, а где нет»).
 *
 * НЕ заводим новую таблицу — ErrorLog уже получает запись на каждый отказ
 * публикации (см. lib/socialPublish.ts::publishApprovedPost, «отказ обязан
 * попасть в журнал» этой же правки) с текстом вида «Публикация в Instagram
 * (объект <id>) не удалась: …». Ищем последнюю НЕРАЗОБРАННУЮ (resolvedAt
 * пуст) такую запись на объект и определяем канал по названию в тексте —
 * тот же язык, что видит модератор в «Здоровье системы», второй раз его не
 * выдумываем. Разобрал кто-то ошибку — бейдж «не ушло» гаснет сам, без
 * отдельного поля на Property.
 */
const PUBLISH_ERROR_CHANNEL_MARKERS: [string, string][] = [
  ["Instagram", "INSTAGRAM"],
  ["Facebook", "FACEBOOK"],
  ["Telegram", "TELEGRAM"],
  ["TikTok", "TIKTOK"],
  ["YouTube", "YOUTUBE"],
  ["Threads", "THREADS"],
];

async function loadPublishErrorsByChannel(propertyId: string): Promise<Record<string, string>> {
  const rows = await prisma.errorLog.findMany({
    where: {
      resolvedAt: null,
      message: { contains: `(объект ${propertyId})` },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { message: true },
  });
  const byChannel: Record<string, string> = {};
  for (const row of rows) {
    if (!row.message.startsWith("Публикация в")) continue;
    const marker = PUBLISH_ERROR_CHANNEL_MARKERS.find(([needle]) => row.message.includes(needle));
    if (!marker) continue;
    const [, channel] = marker;
    // Отсортировано по убыванию даты — первое совпадение канала и есть самое
    // свежее, дальше по списку интереса нет.
    if (!byChannel[channel]) byChannel[channel] = row.message;
  }
  return byChannel;
}

listRouter.get("/", requireAuth, async (req, res) => {
  const parsed = propertyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const { type, districtId, districtIds, priceMin, priceMax, priceCurrency, rooms, areaMin, areaMax, status, inPrep, q, noVideo, overdue, sort, agentId, sellerClientId, page: pageNum } = parsed.data;

  const where: Prisma.PropertyWhereInput = { deletedAt: null };
  /**
   * ЗАЯВКА НА УДАЛЕНИЕ — КАРТОЧКА ИСЧЕЗАЕТ ИЗ СПИСКА У ТОГО, КТО ЕЁ ПОДАЛ
   * (владелец 17.09.2026, зеркало routes/clients/list.ts): «пусть у агента
   * исчезнет... чтобы не мозолить глаза агенту». Карточка НЕ удалена
   * (deletedAt всё ещё null) — решение выносит руководство через очередь
   * Заявок, кому право есть — тот видит список как обычно.
   *
   * ТОЛЬКО ПО АВТОРУ ЗАЯВКИ, А НЕ ВСЕМ БЕЗ ПРАВА (владелец 19.09.2026,
   * «объекты исчезли у агентов»). Каталог объектов, в отличие от списка
   * клиентов, общий: у клиента есть `assignedAgentId`, и там фильтр сам
   * собой сужался до своих карточек (`client: { assignedAgentId: ownAgentId }`),
   * а здесь сужать было нечем — и одна заявка одного агента прятала объект у
   * ВСЕХ агентов, у маркетинга и у монтажёра сразу, бессрочно, пока
   * руководство не рассмотрит заявку. Нерассмотренная заявка выносила из
   * каталога живой объект для всей команды.
   */
  if (!can(req, "properties.delete")) {
    where.deleteRequests = { none: { status: "PENDING", requestedById: req.agent!.id } };
  }
  if (type) where.type = type;
  if (sellerClientId) where.sellerClientId = sellerClientId;
  // «Мои объекты» / «Все объекты» (владелец 21.08.2026) — фильтр по тому, кто ПРИНЯЛ
  // объект у продавца, а не по assignedAgentId: риелтор сделки появляется только в
  // момент сделки и у большинства свежих объектов его вовсе нет, а переключатель
  // должен работать сразу на каталоге. Доступ при этом не сужается: агент и так видит
  // весь каталог (см. hint у properties.viewAll в permissions.ts) — это просто фильтр,
  // тот же принцип, что и agentId у GET /clients.
  // Одно правило «чей объект» на список, карту и профиль сотрудника — см.
  // lib/propertyOwner.ts::propertyOwnerWhere (28.09.2026). AND, а не прямое
  // присваивание OR: условие поиска ниже тоже собирает OR, и они не должны
  // затирать друг друга.
  const ownerCondition = agentId ? propertyOwnerWhere(agentId) : null;
  // Оба параметра сразу — объединение: ссылка с districtId, поверх которой человек
  // дощёлкал районы, не должна молча терять первый.
  const allDistricts = [...new Set([...(districtIds ?? []), ...(districtId ? [districtId] : [])])];
  if (allDistricts.length > 0) where.districtId = { in: allDistricts };
  if (status) where.status = status;
  // «В подготовке» — одна пилюля вместо четырёх этапов конвейера (21.09.2026,
  // см. propertyQuerySchema.inPrep). Точный status, если он задан, сильнее:
  // пришли оба — человек выбрал конкретный этап, сужение по нему и нужно.
  if (inPrep && !status) where.status = { in: [...PROPERTY_PIPELINE_STATUSES] };
  if (rooms) where.rooms = rooms;
  // Площадь — прямо в where, а не в conditions ниже: тогда она действует и на
  // запасном пути поиска по опечаткам (fuzzyWhere копирует where, но заменяет AND).
  // Валютной развилки, как у цены, здесь нет: метры у всех объектов одни и те же.
  if (areaMin !== undefined || areaMax !== undefined) {
    where.areaSqm = {
      ...(areaMin !== undefined ? { gte: areaMin } : {}),
      ...(areaMax !== undefined ? { lte: areaMax } : {}),
    };
  }
  // Очередь монтажёра: объекты без ссылки на видео-обзор. Пустая строка считается
  // отсутствием наравне с null — поле правится руками, и «сохранил пустым» это ровно
  // то же самое, что «не заполнял». Ключ OR соседствует с AND из поиска по словам:
  // Prisma объединяет их по И, то есть фильтры складываются, а не спорят.
  // Третьим условием — заполненное «не тем»: ссылка на Telegram видео-обзором не
  // считается (правило владельца 13.08.2026), а значит такой объект тоже стоит в
  // очереди монтажёра. Без этого условия его нельзя было найти иначе как глазами.
  if (noVideo) {
    where.OR = [
      { instagramUrl: null },
      { instagramUrl: "" },
      { NOT: { instagramUrl: { contains: INSTAGRAM_LINK_CONTAINS, mode: "insensitive" } } },
    ];
  }
  // Условия-развилки собираются в AND: и цена, и поиск по словам — это OR внутри,
  // а записанные прямо в where.OR они затирали бы друг друга и ключ noVideo выше.
  const conditions: Prisma.PropertyWhereInput[] = [];
  if (ownerCondition) conditions.push(ownerCondition);
  if (priceMin !== undefined || priceMax !== undefined) {
    // Границы фильтра заданы в ОДНОЙ валюте, а цены объектов лежат в разных:
    // сравнение с колонкой price напрямую смешивало доллары с сомони — «до 50 000»
    // отдавало и квартиру за 50 000 сомони, и за 50 000 долларов. См. priceRangeBranches.
    const money = await loadMoneyContext();
    conditions.push({
      OR: priceRangeBranches({ min: priceMin, max: priceMax, currency: priceCurrency }, money),
    });
  }
  // Каждое слово запроса ищется отдельно и должно найтись — в названии или в адресе.
  // Раньше запрос искался целой подстрокой, и «Рудаки 45» не находил объект с адресом
  // «пр. Рудаки, 45»: мешали сокращение и запятая. Запрос из одних знаков препинания
  // даёт пустой список слов — тогда фильтра нет, а не пустая выдача.
  // У каждого слова свои написания: забытая раскладка («Helfrb» = «Рудаки»), латиница
  // («Rudaki») и таджикские буквы («Ҳофиз»/«Хофиз») — см. lib/searchTokens.ts.
  // Условия ДО текстового поиска (пока только цена) — запоминаем отдельно: ниже, для
  // fallback на pg_trgm, нужны те же цена/район/статус/тип, но БЕЗ токенных условий.
  const nonTextConditions = [...conditions];
  const tokens = q ? toSearchTokens(q) : [];
  // НОМЕР ОБЪЕКТА («ОБ-000088», «№88», «88») — 05.10.2026, владелец: «везде где есть
  // поиск объекты не выходят». Клиентский поиск номер понимал с 14.08, объектный —
  // нет: «ОБ-000088» распадался на слова «ОБ» и «000088», которых нет ни в названии,
  // ни в адресе, и ответ был пустым при существующем объекте. Номер ищется вместе
  // со словами (ИЛИ), а не вместо них: «103» бывает и числом в адресе.
  const shortIdMatch = q ? parseShortCode(q) : null;
  const tokenConditions: Prisma.PropertyWhereInput[] = tokens.map((token) => ({
      OR: toTokenVariants(token).flatMap((variant) => [
        { title: { contains: variant, mode: "insensitive" as const } },
        { address: { contains: variant, mode: "insensitive" as const } },
        // ОПИСАНИЕ ТОЖЕ ИЩЕТСЯ (владелец 10.08.2026: «поиск по ключевым словам»).
        // «Евроремонт», «панорамные окна», «своя котельная» в названии не пишут —
        // они живут в описании, и без него поиск отвечал «объектов нет» на самые
        // частые запросы клиентов. Заметки не трогаем: там служебное — торг с
        // собственником, коды домофонов, договорённости, — и всплывать в общем
        // поиске оно не должно.
        { description: { contains: variant, mode: "insensitive" as const } },
      ]),
    }));
  if (shortIdMatch !== null && tokenConditions.length > 0) {
    conditions.push({ OR: [{ shortId: shortIdMatch }, { AND: tokenConditions }] });
  } else {
    conditions.push(...tokenConditions);
  }
  // «Просрочено на этапе» — тот же расчёт, что у stageState ниже, но выраженный
  // условием запроса, чтобы фильтр действовал на ВЕСЬ каталог, а не на текущую
  // страницу из двадцати. Ради этого сроки читаются здесь, до выборки.
  //
  // Арифметика. stageState считает `daysInStage = floor((now - вошёл)/сутки)` и
  // просрочкой зовёт `daysInStage > срок`. Для целого floor это ровно
  // `now - вошёл >= (срок + 1) суток`, то есть «вошёл раньше, чем now минус
  // (срок+1) суток». Строгое `>` в stageState (объект, проживший ровно срок, ещё
  // не просрочен) здесь превращается в это «+1» — если поправить одно и забыть
  // другое, список и краска в карточке разойдутся.
  //
  // Этапы без срока в настройках не просрочиваются никогда — они и не попадают в
  // ветки. Если сроков не задано вовсе, честный ответ — пустой список, а не весь
  // каталог, поэтому ветка-заглушка с несуществующим id.
  if (overdue === "1") {
    const pipelineDeadlines = await loadPipelineDeadlines();
    const now = Date.now();
    const branches: Prisma.PropertyWhereInput[] = Object.entries(pipelineDeadlines)
      .filter(([, days]) => typeof days === "number")
      .map(([stageStatus, days]) => ({
        status: stageStatus as Prisma.PropertyWhereInput["status"],
        stageEnteredAt: { lt: new Date(now - (Number(days) + 1) * 24 * 60 * 60 * 1000) },
      }));
    conditions.push(branches.length > 0 ? { OR: branches } : { id: "-" });
  }

  if (conditions.length > 0) where.AND = conditions;

  const pageSize = 20;
  // Одна форма объекта на все списки — её же отдаёт конвейер (lib/propertyListItem.ts).
  const listInclude = PROPERTY_LIST_INCLUDE;

  /**
   * Сортировка по цене идёт в ОДНОЙ валюте, и поэтому не через orderBy.
   *
   * Цены лежат каждая в своей валюте, а `{ price: "asc" }` сравнивает голую колонку:
   * квартира за $40 000 (≈440 000 сомони) вставала перед квартирой за 100 000 сомони,
   * потому что 40 000 меньше 100 000. Агент, листающий «сначала дешёвые», видел
   * вперемешку два разных масштаба цен.
   *
   * Считать это в БД нечем: курс живёт в Настройках, а не в таблице, и Prisma не
   * умеет ORDER BY по выражению. Поэтому для этих двух режимов сортировки берём
   * из БД только id и цену (три поля на строку, не полные карточки со связями),
   * упорядочиваем по пересчитанной цене и запрашиваем полными записями ровно
   * страницу — двадцать штук. Остальные режимы работают как раньше, целиком в БД.
   *
   * SORT_SCAN_CAP — предел на этот проход. Каталог агентства это сотни объектов;
   * потолок стоит на случай, если он однажды вырастет до размеров, при которых такой
   * способ перестанет годиться. Молча обрезать выдачу нельзя (см. правило про
   * пагинацию в CLAUDE.md), поэтому упёршийся потолок пишется в журнал.
   */
  const sortsByPrice = sort === "price_asc" || sort === "price_desc";
  let items;
  let total;

  if (sortsByPrice) {
    const SORT_SCAN_CAP = 5000;
    const [rows, count, money] = await Promise.all([
      prisma.property.findMany({
        where,
        select: { id: true, price: true, currency: true },
        orderBy: { createdAt: "desc" },
        take: SORT_SCAN_CAP,
      }),
      prisma.property.count({ where }),
      loadMoneyContext(),
    ]);
    total = count;
    if (count > SORT_SCAN_CAP) {
      void logSystemError(
        "api",
        `Сортировка по цене: под фильтр попало ${count} объектов, упорядочены первые ${SORT_SCAN_CAP}`
      );
    }

    const direction = sort === "price_asc" ? 1 : -1;
    const ordered = rows
      .map((r) => ({ id: r.id, tjs: toTjs(r.price, r.currency, money) }))
      .sort((a, b) => (a.tjs - b.tjs) * direction || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice((pageNum - 1) * pageSize, pageNum * pageSize)
      .map((r) => r.id);

    const page = await prisma.property.findMany({ where: { id: { in: ordered } }, include: listInclude });
    // findMany по списку id возвращает записи в порядке БД, а не в порядке списка —
    // без этой пересборки страница пришла бы неотсортированной.
    const byId = new Map(page.map((p) => [p.id, p]));
    items = ordered.map((id) => byId.get(id)).filter((p): p is (typeof page)[number] => p !== undefined);
  } else {
    [items, total] = await Promise.all([
      prisma.property.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
        include: listInclude,
      }),
      prisma.property.count({ where }),
    ]);
    // Точное совпадение по номеру — первым на первой странице: «88» находит и объекты
    // с «88» в описании, а нужный человеку идёт не по дате, а сверху.
    if (shortIdMatch !== null && pageNum === 1) {
      const exact =
        items.find((p) => p.shortId === shortIdMatch) ??
        (await prisma.property.findFirst({
          where: { ...where, AND: [...nonTextConditions, { shortId: shortIdMatch }] },
          include: listInclude,
        }));
      if (exact) items = [exact, ...items.filter((p) => p.id !== exact.id)].slice(0, pageSize);
    }
  }

  // Fallback на pg_trgm (lib/fuzzySearch.ts): токенный поиск выше не терпит опечаток
  // и гласных-вариаций написания («воданасос» ≠ «ваданасос» для ILIKE). Включается
  // ТОЛЬКО когда точный поиск ничего не нашёл — второй проход по индексу на каждый
  // запрос списка не нужен, когда написание и так совпало.
  if (q && tokens.length > 0 && total === 0) {
    const fuzzyIds = await fuzzyPropertyIds(q);
    if (fuzzyIds.length > 0) {
      const fuzzyWhere: Prisma.PropertyWhereInput = {
        ...where,
        AND: nonTextConditions.length > 0 ? nonTextConditions : undefined,
        id: { in: fuzzyIds },
      };
      [items, total] = await Promise.all([
        prisma.property.findMany({
          where: fuzzyWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (pageNum - 1) * pageSize,
          take: pageSize,
          include: listInclude,
        }),
        prisma.property.count({ where: fuzzyWhere }),
      ]);
    }
  }

  const result = await presentPropertyListItems(items, req);
  res.json({ items: result, total, page: pageNum, pageSize });
});

/** Потолок выгрузки каталога (22.09.2026, класс «Пагинация» из CLAUDE.md). Без
 *  него `/properties/export` тянул ВЕСЬ каталог AVAILABLE одним запросом — для
 *  растущей базы это неограниченный ответ на один HTTP-запрос. 20 000 — с
 *  большим запасом над реальным размером каталога (сотни-тысячи объектов), то
 *  есть предел на практике не задевается; если всё же задет — честно говорим
 *  об этом в самом файле (см. ниже), а не отдаём молча усечённый дамп. */
const PROPERTIES_EXPORT_LIMIT = 20_000;

/** Выгрузка всего каталога одним файлом — управленческое действие: мимо пагинации
 *  по 20 это готовый дамп базы объектов, который увольняющийся сотрудник уносит с
 *  собой. Роль ограничена, факт выгрузки пишется в Журнал действий — тем же принципом,
 *  что и выгрузка бухгалтерии (см. expenses.ts). */
listRouter.get("/export", requireAuth, requirePermission("properties.export"), async (req, res) => {
  const format = req.query.format === "json" ? "json" : "csv";
  const [items, total] = await Promise.all([
    prisma.property.findMany({
      // deletedAt — объекты из Корзины не должны утекать в выгрузку: для обычного
      // доступа они не существуют (см. GET /:id), выгрузка не может быть исключением.
      where: { status: "AVAILABLE", deletedAt: null },
      include: { district: true },
      orderBy: { createdAt: "desc" },
      take: PROPERTIES_EXPORT_LIMIT,
    }),
    prisma.property.count({ where: { status: "AVAILABLE", deletedAt: null } }),
  ]);
  const truncated = total > PROPERTIES_EXPORT_LIMIT;
  if (truncated) {
    void logSystemError(
      "api",
      `Выгрузка каталога: в AVAILABLE ${total} объектов, в файл попали первые ${PROPERTIES_EXPORT_LIMIT}`
    );
  }

  // Выгрузка проходит ровно ту же фильтрацию контактов, что и карточка объекта:
  // без неё format=json отдавал агенту сырые записи со ВСЕМИ ownerContact в обход
  // stripOwnerContact — самый простой способ выкачать базу владельцев целиком.
  const visible = items.map((p) => stripEmbedding(stripOwnerContact(p, req.agent!.id, can(req, "properties.viewOwners"))));
  logAudit(req, "PROPERTIES_EXPORT", "Property", null, { format, count: visible.length, total, truncated });

  if (format === "json") {
    // Файл всё равно скачивается блобом (useReports.ts), никто не парсит это
    // как голый массив на лету — обёртка с truncated здесь безопасна.
    return res.json({ items: visible, total, truncated });
  }

  // Разделитель «;», строки через \r\n и BOM в начале — как у выгрузки бухгалтерии
  // (routes/expenses.ts): русский Excel с запятой и без BOM открывал каталог
  // кракозябрами в одну колонку (C18, 02.10.2026).
  const header = "id;title;type;price;currency;district;address;areaSqm;rooms;status";
  const rows = visible.map((p) =>
    [p.id, p.title, p.type, p.price, p.currency, p.district?.name ?? "", p.address ?? "", p.areaSqm, p.rooms ?? "", p.status]
      // csvSafeText — защита от CSV-инъекции (№216): название и адрес вводят люди.
      .map((v) => `"${csvSafeText(v).replace(/"/g, '""')}"`)
      .join(";")
  );
  if (truncated) {
    rows.push(`"— выгружены первые ${PROPERTIES_EXPORT_LIMIT} из ${total} — файл усечён, обратитесь к разработчику —"`);
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send("\uFEFF" + [header, ...rows].join("\r\n"));
});

/** Корзина объектов (мягко удалённые) — только ADMIN/DIRECTOR. Регистрируется
 * ДО "/:id", иначе Express принял бы "trash" за shortId и не нашёл объект. */
/**
 * Постранично, а не всё разом (владелец 20.08.2026: «супер скорость»). Раньше
 * `take: 200` без пагинации отдавал разом до двухсот карточек — на телефоне
 * это 200 строк DOM при открытии редко посещаемого экрана. Тот же page/pageSize,
 * что и у обычного списка объектов (GET /properties) — 20 на страницу.
 */
const TRASH_PAGE_SIZE = 20;
listRouter.get("/trash", requireAuth, requirePermission("archive.view"), async (req, res) => {
  // Math.trunc — как в oversight.ts и clients.ts/trash: ?page=1.3 давал нецелый skip и 500.
  const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
  const where: Prisma.PropertyWhereInput = { deletedAt: { not: null } };
  const [items, total] = await Promise.all([
    prisma.property.findMany({
      where,
      orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
      include: {
        district: true,
        photos: { take: 1, orderBy: { order: "asc" } },
        deletedBy: { select: { id: true, fullName: true } },
      },
      skip: (page - 1) * TRASH_PAGE_SIZE,
      // Тот же потолок, что и раньше, — удалённое не чистится никогда, но
      // отдаём его страницами, а не всё сразу.
      take: TRASH_PAGE_SIZE,
    }),
    prisma.property.count({ where }),
  ]);
  // presentProperty, а не один stripEmbedding (22.09.2026): include тянет все
  // скаляры Property вместе с ownerContact, и Корзина была единственным местом
  // этого файла, где пара «вектор + контакт собственника» разорвана. Сегодня
  // `archive.view` есть только у директора и администратора, у которых
  // properties.viewOwners и так есть, но право раздаётся галочкой в карточке
  // сотрудника — в день, когда «Архив» выдадут агенту или монтажёру, экран стал
  // бы постраничной выгрузкой контактов по всем удалённым объектам компании.
  res.json({ items: items.map((p) => presentProperty(p, req)), total, page, pageSize: TRASH_PAGE_SIZE });
});

/**
 * КТО СОБСТВЕННИК — ИМЕНЕМ, А НЕ ОДНИМ НОМЕРОМ (владелец 24.09.2026). Карточка
 * объекта показывала только телефон из ownerContact, хотя объект почти всегда
 * привязан к карточке продавца (sellerClientId: выбран в мастере или заведён
 * сервером по номеру, crud.ts POST /). Руководитель видел номер и не мог ни
 * узнать имя, ни перейти к переписке и истории продавца.
 *
 * Отдаётся по тому же правилу, что и сам номер: кому номер скрыт, тому и имя
 * (вызывающий не зовёт функцию при ownerContactHidden). `canOpen` — откроется
 * ли карточка продавца у этого сотрудника: правило то же, что у
 * GET /clients/:id (clients/card.ts) — чужие клиенты открыты правом
 * clients.viewAll, свои — закреплённому или прежнему агенту. Без этого ссылка
 * вела бы на «Недостаточно прав».
 */
async function loadSellerClientRef(sellerClientId: string | null, req: Request) {
  if (!sellerClientId) return null;
  const seller = await prisma.client.findUnique({
    where: { id: sellerClientId },
    select: { id: true, shortId: true, fullName: true, assignedAgentId: true, lastAgentId: true, deletedAt: true },
  });
  if (!seller || seller.deletedAt) return null;
  const me = req.agent!.id;
  const canOpen = can(req, "clients.viewAll") || seller.assignedAgentId === me || seller.lastAgentId === me;
  return { id: seller.id, shortId: seller.shortId, fullName: seller.fullName, canOpen };
}

/** Публичный идентификатор в URL — короткий числовой shortId. Остальные роуты (PATCH,
 * /photos, bulk-sync) по-прежнему принимают настоящий id — фронтенд шлёт их с уже
 * загруженной карточки (property.id), не парсит заново из адресной строки. */
listRouter.get("/:id", requireAuth, async (req, res) => {
  const cardWhere = cardWhereFromParam(String(req.params.id));
  if (!cardWhere) return res.status(404).json({ error: "Объект не найден" });
  const property = await prisma.property.findUnique({
    where: cardWhere,
    include: {
      district: true,
      photos: { orderBy: { order: "asc" } },
      // Предел выборки обязателен по стандарту проекта: история цен и показы растут
      // неограниченно, у ходового объекта это сотни строк на каждое открытие
      // карточки. desc уже стоит — верхушка остаётся актуальной (как clients.ts:892).
      priceHistory: { orderBy: { createdAt: "desc" }, take: 200 },
      assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
      intakeAgent: { select: { id: true, fullName: true, avatarUrl: true } },
      handoverFromAgent: { select: { id: true, fullName: true, avatarUrl: true } },
      // Показы (interactions SHOWING) в ответ НЕ подмешиваем (ночная проверка
      // 24.09.2026): include отдавал записи ЦЕЛИКОМ — notes, liveNote, transcript,
      // voiceNoteUrl, recordingUrl и clientId чужих покупателей — любому, кому
      // открыта карточка объекта, а сайт это поле не читал нигде. Кому нужны показы
      // по объекту, берёт их отдельным запросом со своей проверкой прав.
      // Только счётчик: сами ролики карточка тянет отдельным запросом (у него своя
      // проверка прав), а экрану проверки нужно лишь знать, есть ли что одобрять.
      _count: { select: { videos: true } },
    },
  });
  // Мягко удалённый объект ведёт себя как несуществующий: для всех, кроме тех,
  // кому открыта Корзина. Иначе из Корзины нельзя было посмотреть, что именно
  // восстанавливаешь или стираешь навсегда — только название и цену в строке.
  // Право то же самое, что и на сам список корзины (GET /trash), новых дверей
  // это не открывает.
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (property.deletedAt && !can(req, "archive.view")) {
    return res.status(404).json({ error: "Объект не найден" });
  }
  const presented = stripEmbedding(stripOwnerContact(property, req.agent!.id, can(req, "properties.viewOwners")));
  res.json({
    ...presented,
    sellerClient: presented.ownerContactHidden ? null : await loadSellerClientRef(property.sellerClientId, req),
    /** Сколько покупателей ждут такой объект — тем же подсчётом, что и список
     *  (24.09.2026): без поля карточка рисовала запасной 0 рядом с подбором,
     *  в котором покупатели были. */
    demandCount: (await computeDemandCounts([property])).get(property.id) ?? 0,
    /** Сколько сырых роликов загрузил агент — по ним маркетинг одобряет видео. */
    videoCount: property._count.videos,
    pipeline: stageState(property.status, property.stageEnteredAt, await loadPipelineDeadlines()),
    /** «Видно, где ролик есть, а где нет» (ОБ-000113) — свежая неразобранная
     *  причина отказа публикации по каждому из пяти каналов, см. функцию выше. */
    publishErrors: await loadPublishErrorsByChannel(property.id),
    /**
     * Публичный адрес объекта на сайте — им агент делится с клиентом кнопкой
     * «Отправить» в карточке. null, пока объект не опубликован: ссылки просто
     * не существует, и кнопку показывать не на что.
     *
     * Собирает сервер, а не браузер: домен сайта живёт в переменной окружения
     * API (SITE_PUBLIC_URL), и той же ссылкой бот отправляет объекты клиентам.
     * Вторая сборка на фронтенде означала бы вторую правду о том, где лежит
     * объявление, — а фронтенд ещё и требует VITE-переменную, которая без
     * build-arg в Docker молча вырезается из бандла.
     */
    siteUrl: siteListingUrl(property),
    /** Блок «Монтаж» карточки (25.09.2026, задание C) — очередь, попытки
     *  отправки, доставка по каждому ролику, монтажёр. null у объектов, которые
     *  через хендофф вообще не проходили (videoHandoffStatus === "NONE"). */
    videoHandoff: await videoHandoffCardForProperty(property),
  });
});
