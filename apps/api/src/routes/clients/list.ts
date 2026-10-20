/** Списки клиентов: GET /, GET /trash, GET /lost (Г2, §1.2). Перенос verbatim. */
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import {
  clientDisplayName,
  clientQuerySchema,
  type ClientSort,
  parseShortCode,
  REFUSAL_REASON_LABELS,
  type RefusalReason,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission, scopeToOwnAgent } from "../../auth/middleware.js";
import { loadMoneyContext } from "../../lib/money.js";
import { logSystemError } from "../../lib/systemError.js";
import { toSearchTokens, toTokenVariants } from "../../lib/searchTokens.js";
import { fuzzyClientIds } from "../../lib/fuzzySearch.js";
import { loadSellerPropertyAddresses } from "../../lib/sellerPropertyAnchor.js";
import { loadLeadReasons } from "../../lib/leadReason.js";
import { budgetSortKey, computeHiddenReason, maskPhone, presentClient } from "./shared.js";
import { TERMINAL_CLIENT_STATUSES } from "../../lib/clientContact.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../lib/clientPhone.js";
import { dushanbeStartOfToday } from "../../lib/dushanbeTime.js";

export const listRouter = Router();

/**
 * Клиенты из списка id, у кого последняя реплика в переписке — от самого
 * клиента, и диалог не открывали после неё (BotConversation/TelegramConversation).
 * Один признак «непрочитано» на два места: бейдж непрочитанного в обычном
 * списке (ниже) и исключение из фильтра «скрыл заявку на удаление» — если
 * клиент написал, пока заявка висит, карточка обязана остаться на виду
 * (владелец 18.09.2026, разбор «что если клиент напишет во время заявки»).
 */
/** Сколько висящих заявок на удаление читаем за раз — см. место применения ниже. */
const PENDING_DELETE_SCAN_LIMIT = 500;

async function clientIdsWithUnreadReply(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ clientId: string; unread: boolean }[]>`
    SELECT "clientId", bool_or(unread) AS unread FROM (
      SELECT c."clientId" AS "clientId",
             (
               jsonb_typeof(c.messages) = 'array'
               AND (c.messages -> -1 ->> 'role') = 'user'
               AND (c."readAt" IS NULL OR COALESCE(c."lastMessageAt", c."updatedAt") > c."readAt")
             ) AS unread
      FROM "BotConversation" c
      WHERE c."clientId" IN (${Prisma.join(ids)})
      UNION ALL
      SELECT c."clientId" AS "clientId",
             (
               jsonb_typeof(c.messages) = 'array'
               AND (c.messages -> -1 ->> 'role') = 'user'
               AND (c."readAt" IS NULL OR COALESCE(c."lastMessageAt", c."updatedAt") > c."readAt")
             ) AS unread
      FROM "TelegramConversation" c
      WHERE c."clientId" IN (${Prisma.join(ids)})
    ) t
    WHERE t."clientId" IS NOT NULL
    GROUP BY "clientId"
  `;
  return new Set(rows.filter((r) => r.unread).map((r) => r.clientId));
}

/**
 * Порядок выборки для каждого режима сортировки (словарь режимов — CLIENT_SORTS
 * в @royal-home/shared). Вторым ключом всегда id: без однозначного «последнего»
 * поля строки с одинаковым статусом/источником могли бы поменяться местами между
 * двумя запросами и та же карточка приходила бы и на первой, и на второй странице.
 *
 * `budget_*` здесь нет намеренно — бюджеты в разных валютах, их порядок считается
 * не базой (см. loadPage ниже).
 */
const CLIENT_ORDER_BY: Partial<Record<ClientSort | "name", Prisma.ClientOrderByWithRelationInput[]>> = {
  name: [{ fullName: "asc" }, { id: "asc" }],
  name_asc: [{ fullName: "asc" }, { id: "asc" }],
  // «Мой вид» (артефакт, экран «Клиенты»): сначала непринятые, затем по давности контакта.
  attention_desc: [{ acceptedAt: { sort: "asc", nulls: "first" } }, { lastContactAt: "asc" }, { id: "asc" }],
  name_desc: [{ fullName: "desc" }, { id: "asc" }],
  status_asc: [{ status: "asc" }, { id: "asc" }],
  status_desc: [{ status: "desc" }, { id: "asc" }],
  // Оценка ИИ есть не у каждой карточки. Пустая — это «не оценено», а не «ноль»:
  // в обоих направлениях такие уходят вниз, иначе «сначала лучшие» открывалось бы
  // списком карточек вообще без оценки.
  score_asc: [{ aiScore: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  score_desc: [{ aiScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  source_asc: [{ source: "asc" }, { id: "asc" }],
  source_desc: [{ source: "desc" }, { id: "asc" }],
  created_asc: [{ createdAt: "asc" }, { id: "asc" }],
  created_desc: [{ createdAt: "desc" }, { id: "asc" }],
  contact_asc: [{ lastContactAt: "asc" }, { id: "asc" }],
  contact_desc: [{ lastContactAt: "desc" }, { id: "asc" }],
  agent_asc: [{ assignedAgent: { fullName: "asc" } }, { id: "asc" }],
  agent_desc: [{ assignedAgent: { fullName: "desc" } }, { id: "asc" }],
};

/**
 * Предел прохода для сортировки по бюджету — ровно тот же приём и то же число,
 * что у сортировки по цене объектов (routes/properties.ts): курс живёт в
 * Настройках, а не в таблице, поэтому упорядочить пересчитанные суммы в SQL
 * нечем. Упёршийся потолок пишется в журнал, а не обрезает выдачу молча.
 */
const BUDGET_SORT_SCAN_CAP = 5000;

/**
 * Потолок «следующего шага» на странице списка клиентов (22.09.2026, класс
 * «Пагинация»). Число клиентов страницы уже ограничено `pageSize` (до 200),
 * но незакрытых nextActionDate на клиента формально ничем не ограничено —
 * потолок здесь на СТРОКИ, а не на id клиентов, как и просит правило. 20 на
 * клиента с большим запасом покрывает реальную очередь обещаний.
 */
const PENDING_STEPS_PER_CLIENT_CAP = 20;

listRouter.get("/", requireAuth, async (req, res) => {
  const parsed = clientQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const {
    status,
    kind,
    districtId,
    agentId,
    source,
    workStatus,
    inactiveLevel,
    q,
    sort,
    page: pageNum,
    pageSize: requestedSize,
    hot,
    pendingAcceptance,
    noFirstContactYesterday,
    scope,
  } = parsed.data;
  // «Прочие обращения» — отдельный раздел меню и отдельное право. Раньше вкладка
  // держалась только на проверке роли в вебе, а сервер отдал бы список любому, кто
  // подставит kind=OTHER руками (спасала лишь случайность: OTHER не назначается агенту).
  if (kind === "OTHER" && !can(req, "otherInquiries.view")) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  const ownAgentId = scopeToOwnAgent(req);
  // Вкладка «Все мои клиенты» — только у своего агента, границу прав не двигает
  // (руководство и так видит всё через обычные срезы/Корзину/lost). Без
  // ownAgentId параметр молча игнорируется — не открывает лазейку показать
  // чужую Корзину без archive.view.
  const allMine = scope === "allMine" && !!ownAgentId;

  /**
   * ПОИСК ЗАГЛЯДЫВАЕТ И В КОРЗИНУ (04.09.2026, право archive.view).
   *
   * Обычные списки Корзину не показывают никогда — деталь ниже относится
   * ТОЛЬКО к строке поиска: искали живого клиента, а он оказался удалён (или
   * найден по номеру, который уже переехал в другую, ещё не восстановленную
   * карточку) — раньше поиск отвечал «ничего не найдено», хотя карточка
   * существует, просто в Корзине, и человек тратил время на повторный ввод
   * данных. Своя область агента (ownAgentId) сюда не пускается: агенту
   * Корзина не по праву в принципе, и подмешивать её в его личный список не
   * нужно, даже если бы право откуда-то у него появилось.
   */
  const includeTrash = Boolean(q) && !ownAgentId && can(req, "archive.view");
  const where: Prisma.ClientWhereInput = { deletedAt: includeTrash || allMine ? undefined : null };
  /**
   * ЗАЯВКА НА УДАЛЕНИЕ — КАРТОЧКА ИСЧЕЗАЕТ ИЗ СПИСКА СРАЗУ (владелец 17.09.2026):
   * «после удаления пусть у агента исчезнет... чтобы не мозолить глаза агенту».
   * До решения руководства карточка висела в обычном списке до самого approve —
   * агент, отправивший заявку, продолжал видеть её как ни в чём не бывало.
   * Карточка при этом НЕ удалена (deletedAt всё ещё null) — решение выносит
   * руководство через очередь Заявок (GET /delete-requests), а не список.
   * Тот, у кого есть `clients.delete`, видит список как обычно: он и есть
   * тот самый решающий, ему нужен полный контекст, а не урезанный список.
   *
   * ИСКЛЮЧЕНИЕ — КЛИЕНТ НАПИСАЛ, ПОКА ЗАЯВКА ВИСИТ (владелец 18.09.2026,
   * разбор «что если в этот момент в чат обратятся»). Пуш и колокольчик о
   * новом сообщении агенту всё равно приходят (notifyAgentOfClientMessage их
   * не фильтрует), но без этого исключения кликнуть было бы некуда: карточка
   * пропала бы из его же списка, а сама переписка идёт как ни в чём не бывало
   * (intake.ts заявку на удаление не проверяет вовсе). Прячем только те
   * карточки, где нет непрочитанной реплики клиента.
   */
  if (!can(req, "clients.delete")) {
    const pendingDeleteIds = (
      await prisma.clientDeleteRequest.findMany({
        where: { status: "PENDING", ...(ownAgentId ? { client: { assignedAgentId: ownAgentId } } : {}) },
        select: { clientId: true },
        // ПОТОЛОК ОБЯЗАТЕЛЕН (19.09.2026). Очередь заявок на удаление
        // рассасывается только когда руководство до неё дошло, то есть расти
        // может без предела — а читается она здесь на КАЖДУЮ отрисовку списка
        // клиентов, самого горячего экрана после дашборда. Следом идёт разбор
        // непрочитанного по `messages -> -1` (никаким индексом не
        // обслуживается) и `notIn` с этим же списком в основном запросе: без
        // потолка цена растёт вместе с очередью, и список клиентов начинает
        // отваливаться по таймауту в случайное время дня.
        //
        // Отказ здесь безопасен в правильную сторону: не попавшая в выборку
        // заявка означает, что карточка ОСТАНЕТСЯ на виду у агента, а не
        // исчезнет. Пятьсот — тот же кап, что у общекомандных хелперов
        // антифрода (routes/oversight.ts).
        take: PENDING_DELETE_SCAN_LIMIT,
      })
    ).map((r) => r.clientId);
    if (pendingDeleteIds.length > 0) {
      const unread = await clientIdsWithUnreadReply(pendingDeleteIds);
      const idsToHide = pendingDeleteIds.filter((id) => !unread.has(id));
      if (idsToHide.length > 0) where.id = { notIn: idsToHide };
    }
  }
  if (allMine) {
    /**
     * ВКЛАДКА «ВСЕ МОИ КЛИЕНТЫ» (18.09.2026, задание В §f п.1, Р-2/Р-7
     * `docs/audit/lead-ownership-17-09.md`). Ни один обычный срез сюда не
     * применяется: ни `deletedAt: null` (Корзина), ни ограничение по
     * kind/assignReason (см. ветку ниже), ни status/workStatus/pendingAcceptance
     * (эти три и так применяются только если явно запрошены — см. условия
     * дальше по файлу). Держатель — ТЕКУЩИЙ (`assignedAgentId`) ИЛИ ПОСЛЕДНИЙ
     * (`lastAgentId` — то же поле, что пишут trashClient/deactivateClient/
     * detachAgentForCandidate при тихом уходе карточки), чтобы карточка была
     * видна и после того, как её увели автоматикой.
     */
    where.OR = [{ assignedAgentId: ownAgentId }, { lastAgentId: ownAgentId }];
  } else if (ownAgentId) {
    where.assignedAgentId = ownAgentId;
    /**
     * АГЕНТУ — ТОЛЬКО ПОКУПАТЕЛИ И ПРОДАВЦЫ (владелец 30.08.2026: «сделай так, чтобы
     * агентам шли только две категории лидов, весь остальной мусор — только админу и
     * директору»).
     *
     * До этого правило держалось на случайности: «прочие обращения» просто не
     * назначались агенту, и в его список не попадали. Но путей назначения несколько
     * (возврат из Корзины, ручное переназначение, утренняя волна), и каждый новый
     * снова открывал бы мусору дорогу. Право `otherInquiries.view` закрывает вкладку
     * «Прочие обращения» целиком (ниже по файлу), а это — тот же запрет на уровне
     * выборки, чтобы он не зависел от того, как карточка получила агента.
     *
     * ИСКЛЮЧЕНИЕ: карточка, где клиент сам назвал сотрудника (assignReason
     * `requested_by_client`, см. services/leads/intake.ts). Тип у неё может остаться
     * OTHER — бот не понял, покупает человек или продаёт, — но «соедините меня с
     * Умеджоном» это не мусор, и назначенный агент обязан её видеть. Назначить и
     * спрятать было бы хуже, чем не назначать вовсе.
     */
    where.OR = [{ kind: { in: ["BUYER", "SELLER"] } }, { assignReason: "requested_by_client" }];
  } else if (agentId) where.assignedAgentId = agentId;
  // Разделяем вкладки: «Клиенты» (BUYER) и «Продавцы» (SELLER). Без фильтра — все.
  if (kind) where.kind = kind;
  if (status) where.status = status;
  if (source) where.source = source;
  if (districtId) where.desiredDistrictId = districtId;
  // «Светофор неактивных» (routes/oversight.ts, /traffic-light-summary) — клик
  // по числу матрицы агент×цвет ведёт сюда с этими двумя фильтрами. inactiveLevel
  // без workStatus не имеет смысла (поле хранит ПОСЛЕДНИЙ цвет и после возврата
  // в ACTIVE — см. комментарий у Client.inactiveLevel в schema.prisma), поэтому
  // фильтруется только вместе, а не отдельным условием.
  if (workStatus) where.workStatus = workStatus;
  /**
   * «Неактивные» — это те, с кем ещё работают, а не потерянные (23.09.2026).
   * Предел попыток светофора переводит в LOST, но workStatus=INACTIVE остаётся
   * (lib/clientLifecycle.ts::markClientLost), и без этого условия число в
   * матрице светофора и список по клику по нему расходились бы. Явно заданный
   * фильтр status сильнее: его выбрал человек.
   */
  if (workStatus === "INACTIVE" && !status) where.status = { notIn: [...TERMINAL_CLIENT_STATUSES] };
  if (inactiveLevel) where.inactiveLevel = inactiveLevel;
  // Раздел «Горячие клиенты»: отказные с заполненной карточкой или после показа.
  if (hot) where.hotSince = { not: null };
  /**
   * СРЕЗ «ЖДУТ ПРИНЯТИЯ» — ЧЕСТНО НА СЕРВЕРЕ (07.09.2026, «дашборд агента против ТЗ»).
   *
   * До этого дня и главная агента (PendingLeadsRows), и окно входящего лида
   * (IncomingLeadWindow), и вкладка «Клиенты» → «Ждут принятия» запрашивали
   * обычную страницу (20–100 карточек обычной сортировки) и фильтровали
   * `pendingAcceptance` уже на клиенте — переназначенный старый лид с дедлайном
   * в минутах мог оказаться на 21-й позиции и просто не попасть в ответ.
   * `acceptedAt IS NULL` — то же условие, что даёт `pendingAcceptance` в
   * presentClient (shared.ts), здесь оно фильтрует выборку, а не красит ответ.
   */
  /**
   * ЭСКАЛИРОВАННЫЙ ЛИД — БОЛЬШЕ НЕ «ЖДЁТ ПРИНЯТИЯ» У ТОГО ЖЕ АГЕНТА (14.09.2026,
   * скриншот владельца: карточка «Ака», «Никто не принял», просроченный таймер,
   * живые кнопки Принять/Отклонить). `reassignStaleLeads` (services/leads/
   * reassignment.ts) при эскалации ставит `escalatedAt` и ОСТАВЛЯЕТ того же
   * `assignedAgentId`/`acceptedAt: null` — это запись «для истории, кто держал
   * лид», а не приглашение решать дальше: дальше это дело руководителя
   * (пуш «Заявку никто не принял» уходит именно ему). Без этого условия
   * IncomingLeadWindow и «Ждут вашего принятия» на Главной (тот же запрос и тот
   * же ключ кэша) показывали эскалированный лид агенту как свежий полноэкранный
   * оффер — с уже нулевым таймером и без единого шанса, что «Принять» сработает.
   */
  if (pendingAcceptance) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { workStatus: "ACTIVE" }];
    where.acceptedAt = null;
    where.escalatedAt = null;
    // Те же границы, что у числа «Ждут принятия» (routes/clients/summary.ts,
    // awaitingWhere; 24.09.2026, пункт 25): закрытые и «Прочие» принимать некому.
    if (!status) where.status = { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] };
    if (!kind && !ownAgentId) where.kind = { in: ["BUYER", "SELLER"] };
  }

  /**
   * СРЕЗ «ВЧЕРА ОСТАЛИСЬ БЕЗ ОТВЕТА» — ТЕМ ЖЕ ПРАВИЛОМ, ЧТО И ЧИСЛО НА ПЛИТКЕ.
   *
   * Условие дословно повторяет firstTouchNoneCount в lib/morningNumbers.ts:
   * карточка создана вчерашними сутками Душанбе и первого касания не было.
   * Границы суток — через dushanbeStartOfToday, никогда через setHours: контейнер
   * живёт в UTC, и «вчера» по серверным часам начиналось бы на пять часов позже.
   *
   * Если правило первого касания когда-нибудь изменится, менять надо оба места —
   * иначе директор увидит на плитке одно число, а в списке другое, и это ровно
   * то, ради чего срез вообще переехал на сервер.
   */
  if (noFirstContactYesterday) {
    const startOfToday = dushanbeStartOfToday();
    where.createdAt = { gte: new Date(startOfToday.getTime() - 86_400_000), lt: startOfToday };
    where.firstContactAt = null;
  }
  // Та же логика, что у поиска объектов (см. routes/properties.ts): каждое слово
  // должно найтись, порядок слов не важен, написание — тоже. «Исмоилова Гулнора»
  // раньше не находило «Гулнора Исмоилова», а «Ismoilova» — вообще ничего.
  // Телефон ищем самим словом без вариантов: цифрам раскладка не нужна.
  const clientTokens = q ? toSearchTokens(q) : [];
  /**
   * НОМЕР КЛИЕНТА (ТЗ п. 2: номер должен работать «в карточке; в поиске; в
   * списках»). Разбираем ВЕСЬ запрос целиком, ДО разбиения на слова: «ПК-000042»
   * распадается на «ПК» и «000042», и требование найти оба слова в имени не
   * выполнялось никогда. До 14.08.2026 поиск умел только ФИО и телефон, и номер
   * не находил вовсе — при том что он показан в карточке и агенты диктуют его
   * друг другу.
   */
  const shortIdMatch = q ? parseShortCode(q) : null;
  if (clientTokens.length > 0) {
    /**
     * ПОИСК ПО НОМЕРУ — ТОЛЬКО ТОМУ, КОМУ НОМЕР ВИДЕН (владелец 30.08.2026).
     *
     * Прочитать номер агент не может, а подтвердить догадку — мог: маска
     * `+992•••••57` показывает две последние цифры, и перебор по хвосту в этой же
     * строке поиска отвечал «да/нет» на каждую попытку. Право, которое
     * обходится перебором, правом не является; поиск по имени и по номеру
     * карточки при этом остаётся у всех.
     */
    const canSearchByPhone = can(req, "clients.viewPhone");
    /**
     * ЗАПАСНОЙ И WHATSAPP-НОМЕР ТОЖЕ ИЩУТСЯ (04.09.2026).
     *
     * До этого дня строка поиска смотрела только в `phone` — карточка с номером,
     * записанным ЗАПАСНЫМ (`extraPhones`) или как адрес WhatsApp, не находилась
     * вообще, хотя оба поля видны в самой карточке. Владелец наткнулся на это на
     * себе: его личный номер был вторым (`extraPhones`) на тестовой карточке, и
     * поиск по нему не находил ничего.
     *
     * `extraPhones` — массив, Prisma не умеет `contains` по его элементам, поэтому
     * подстрочное совпадение (по духу — то же самое, что и `findPhoneOwners` в
     * lib/clientPhones.ts, только по подстроке, а не по хвосту) считается сырым SQL.
     *
     * ИНДЕКС ПОД ЭТОТ ЗАПРОС (аудит надёжности 13.09.2026, находка 1): раньше
     * здесь стоял `EXISTS (SELECT 1 FROM unnest(...) AS p WHERE p ILIKE ...)` —
     * без индекса, годного под ILIKE по элементу массива (GIN(gin_trgm_ops) строит
     * триграммы по значению КОЛОНКИ, не по элементам массива в ней). Запрос
     * переписан на `client_extra_phones_search_text(...) ILIKE` — то же самое
     * «встречается ли подстрока хоть в одном из номеров» (функция склеивает
     * элементы через пробел; пробел-разделитель не даёт совпадению перескочить
     * между номерами — toSearchTokens режет запрос по не-буквам-не-цифрам,
     * поэтому token сам пробела никогда не содержит), но теперь именно эта форма
     * индексирована — см. миграцию 20260914140000_client_phone_trgm_search,
     * "Client_extraPhones_trgm_idx". Вызов здесь обязан совпадать с индексным
     * выражением СЛОВО В СЛОВО, иначе планировщик индекс не увидит; функция —
     * не голый array_to_string, потому что тот помечен в каталоге STABLE, а
     * индексное выражение требует IMMUTABLE (см. миграцию).
     */
    const extraPhoneMatches =
      canSearchByPhone && clientTokens.length > 0
        ? await Promise.all(
            clientTokens.map((token) =>
              prisma.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "Client"
                WHERE "whatsappPhone" ILIKE ${"%" + token + "%"}
                   OR client_extra_phones_search_text("extraPhones") ILIKE ${"%" + token + "%"}
              `
            )
          )
        : [];
    /**
     * ПОИСК ПО НИКУ СОЦСЕТИ — ТОЛЬКО ТОМУ, КОМУ НИК ВИДЕН (clientOrigin.ts).
     *
     * Ник заведён «чтобы админ и директор с лёгкостью даже через поиск могли их
     * искать» (docs/razbor-zhaloby-admina-31-08-2026.md §10) — но именно потому,
     * что это самая короткая дорога к клиенту в обход агентства, агенту он нигде
     * не показывается (lib/clientOrigin.ts). Открыть его поиском значило бы
     * прятать поле в карточке и тут же выдавать его строкой поиска — то же самое
     * дырявое правило, которого урок уже дважды учил на телефоне.
     */
    const canSearchByOrigin = can(req, "clients.viewOrigin");
    const byTokens = clientTokens.map((token, i) => ({
      OR: [
        ...toTokenVariants(token).map((variant) => ({
          fullName: { contains: variant, mode: "insensitive" as const },
        })),
        ...(canSearchByPhone ? [{ phone: { contains: token } }] : []),
        ...(extraPhoneMatches[i]?.length ? [{ id: { in: extraPhoneMatches[i].map((r) => r.id) } }] : []),
        // Раскладка/транслит здесь не нужны: ник — не имя, которое произносят и
        // могли записать на слух в другом алфавите, а точная строка из профиля
        // соцсети. Ищем токен как есть, без учёта регистра.
        ...(canSearchByOrigin ? [{ socialUsername: { contains: token, mode: "insensitive" as const } }] : []),
        /**
         * ОСТАЛЬНЫЕ ПОЛЯ КАРТОЧКИ (04.09.2026, «поиск по всем параметрам»).
         *
         * Почта, адрес, ник телеграма и свободные пожелания клиента видны в
         * карточке всем, у кого вообще есть доступ к списку, — без отдельного
         * права, в отличие от телефона и соцсети выше. Почта ДО принятия лида
         * в самой карточке скрыта (presentClient), но здесь это не важно:
         * ищется совпадение, а не отдаётся значение поля.
         */
        { email: { contains: token, mode: "insensitive" as const } },
        { address: { contains: token, mode: "insensitive" as const } },
        { requirementsNotes: { contains: token, mode: "insensitive" as const } },
        { telegramUsername: { contains: token, mode: "insensitive" as const } },
        // Район желаемого поиска — часть якоря отображаемого имени («ищет 2к
        // Сино…», владелец 21.09.2026), обязан находиться тем же поиском, что
        // и остальные поля карточки, иначе якорь виден, а найти по нему нельзя.
        { desiredDistrict: { name: { contains: token, mode: "insensitive" as const } } },
      ],
    }));
    // Номер — АЛЬТЕРНАТИВА словам, а не дополнительное условие к ним: голое «42»
    // должно находить и карточку №42, и телефон, в котором встречается «42».
    where.AND = shortIdMatch !== null ? [{ OR: [{ shortId: shortIdMatch }, { AND: byTokens }] }] : byTokens;
  }

  // Список выдаёт 20 записей на страницу, но селекты-справочники («Назначить
  // клиенту» на карточке объекта) берут первую страницу и других не запрашивают —
  // для них разрешён явный ?pageSize= до 200, иначе выбрать можно было только из
  // двадцати самых новых.
  const pageSize = requestedSize ?? 20;
  // По умолчанию — новые заявки/клиенты сверху (по дате добавления), чтобы сразу
  // видеть, кто новый. Остальные режимы приходят нажатием на заголовок колонки.
  // Явный `sort` в запросе (например, руководительская сортировка в шторке
  // фильтров) главнее среза: `pendingAcceptance` меняет только выборку.
  const orderBy =
    (sort && CLIENT_ORDER_BY[sort]) ??
    (pendingAcceptance
      ? // «Ждут принятия» — самые старые ожидающие первыми: тот, кого назначили
        // давнее всех и до сих пор не приняли, важнее вчерашнего лида.
        [{ assignedAt: "asc" as const }, { id: "asc" as const }]
      : [{ createdAt: "desc" as const }, { id: "asc" as const }]);

  const listInclude = {
    desiredDistrict: true,
    assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
    // Только для hiddenReason ниже («Все мои» — единственный срез, где
    // Корзина вообще может встретиться в обычном списке).
    ...(allMine ? { deletedBy: { select: { fullName: true } } } : {}),
  } satisfies Prisma.ClientInclude;
  type ClientListRow = Prisma.ClientGetPayload<{ include: typeof listInclude }>;

  /**
   * Страница выдачи. Отдельной функцией, потому что запрашивается дважды: второй
   * раз — по результатам нечёткого поиска ниже, и сортировка там обязана быть той же.
   *
   * Бюджет — особый случай: суммы лежат каждая в своей валюте, и `orderBy` по голой
   * колонке смешал бы доллары с сомони ($40 000 встали бы перед 100 000 сомони).
   * Поэтому для двух этих режимов из базы берутся только id и суммы, порядок
   * считается по пересчитанному в сомони значению, а полными записями
   * запрашивается ровно страница.
   */
  async function loadPage(scopedWhere: Prisma.ClientWhereInput): Promise<[ClientListRow[], number]> {
    if (sort !== "budget_asc" && sort !== "budget_desc") {
      return Promise.all([
        prisma.client.findMany({
          where: scopedWhere,
          orderBy,
          skip: (pageNum - 1) * pageSize,
          take: pageSize,
          include: listInclude,
        }),
        prisma.client.count({ where: scopedWhere }),
      ]);
    }

    const [rows, count, money] = await Promise.all([
      prisma.client.findMany({
        where: scopedWhere,
        select: { id: true, budgetMin: true, budgetMax: true, currency: true },
        // Порядок прохода задан явно: без него база вольна отдать строки как ей
        // удобно, и при одинаковых бюджетах (или при упёршемся потолке) две
        // соседние страницы могли бы показать одну и ту же карточку дважды.
        // Сортировка в JS устойчива, поэтому этот порядок и станет тай-брейком.
        orderBy: { id: "asc" },
        take: BUDGET_SORT_SCAN_CAP,
      }),
      prisma.client.count({ where: scopedWhere }),
      loadMoneyContext(),
    ]);
    if (count > BUDGET_SORT_SCAN_CAP) {
      void logSystemError(
        "api",
        `Сортировка по бюджету: под фильтр попало ${count} клиентов, упорядочены первые ${BUDGET_SORT_SCAN_CAP}`
      );
    }

    const direction = sort === "budget_asc" ? 1 : -1;
    const ordered = rows
      .map((r) => ({ id: r.id, tjs: budgetSortKey(r, money) }))
      .sort((a, b) => {
        // Карточки без бюджета всегда в конце — в обоих направлениях: пустое поле
        // означает «ещё не спросили», и открывать ими «сначала дорогие» незачем.
        if (a.tjs === null || b.tjs === null) return a.tjs === b.tjs ? 0 : a.tjs === null ? 1 : -1;
        return (a.tjs - b.tjs) * direction;
      })
      .slice((pageNum - 1) * pageSize, pageNum * pageSize)
      .map((r) => r.id);

    const page = await prisma.client.findMany({ where: { id: { in: ordered } }, include: listInclude });
    // findMany по списку id возвращает записи в порядке БД, а не в порядке списка —
    // без пересборки страница пришла бы неотсортированной.
    const byId = new Map(page.map((c) => [c.id, c]));
    return [ordered.map((id) => byId.get(id)).filter((c): c is ClientListRow => c !== undefined), count];
  }

  let [items, total] = await loadPage(where);

  // Fallback на pg_trgm (lib/fuzzySearch.ts): токенный поиск по ФИО выше не терпит
  // опечаток и гласных-вариаций написания. Включается только когда точный/токенный
  // поиск ничего не нашёл — те же остальные фильтры (район/статус/агент) сохраняются.
  if (q && clientTokens.length > 0 && total === 0) {
    const fuzzyIds = await fuzzyClientIds(q);
    if (fuzzyIds.length > 0) {
      const fuzzyWhere: Prisma.ClientWhereInput = { ...where, AND: undefined, id: { in: fuzzyIds } };
      [items, total] = await loadPage(fuzzyWhere);
    }
  }

  /**
   * Следующий шаг по каждому клиенту страницы.
   *
   * ЗАЧЕМ. Список клиентов был перечнем: имя, статус, бюджет, когда последний раз
   * общались. Того единственного, что определяет работу на сегодня — «что я обещал
   * сделать и когда», — в нём не было, и рабочая очередь жила отдельно в Календаре.
   * Агент держал два экрана: в одном люди, в другом обещания.
   *
   * Обещание живёт в хронологии (Interaction.nextAction/nextActionDate), а не в
   * карточке клиента, поэтому его надо доставать отдельно. ОДНИМ запросом на всю
   * страницу, а не по клиенту: `await` внутри цикла по списку из базы — это N+1,
   * и на странице в 25 строк он означал бы 25 обращений вместо одного.
   *
   * Берём самое раннее НЕвыполненное: просроченное вчера важнее назначенного на
   * следующей неделе.
   */
  const pendingSteps = items.length
    ? await prisma.interaction.findMany({
        where: {
          clientId: { in: items.map((c) => c.id) },
          nextActionDate: { not: null },
          completedAt: null,
        },
        orderBy: { nextActionDate: "asc" },
        select: { clientId: true, nextAction: true, nextActionDate: true },
        // Потолок — строки, а не id клиентов: страница даёт до `pageSize` клиентов,
        // а незакрытых обещаний на одного формально сколько угодно.
        take: items.length * PENDING_STEPS_PER_CLIENT_CAP,
      })
    : [];
  const stepByClient = new Map<string, { nextAction: string | null; nextActionDate: Date | null }>();
  for (const step of pendingSteps) {
    // orderBy уже поставил самое раннее первым — первое попавшееся и берём.
    if (!stepByClient.has(step.clientId)) {
      stepByClient.set(step.clientId, { nextAction: step.nextAction, nextActionDate: step.nextActionDate });
    }
  }

  /**
   * «Непрочитано» в СВОЁМ списке клиентов (владелец 31.08.2026: «в чатах на
   * телефоне красное должно быть, как в вотсапе»).
   *
   * Считаем ТОЛЬКО когда список открыт самим агентом (ownAgentId) — общий
   * инбокс `/messages` (routes/conversations.ts) для этого не годится: он
   * закрыт правом `messages.view`, которого у роли AGENT нет по умолчанию, и
   * показывает переписку вообще всех клиентов, а не только своих. Здесь же
   * агент и так видит только свой список — переиспользуем тот же признак
   * «последняя реплика от клиента, диалог не открывали после неё»
   * (readAt/lastMessageAt на BotConversation/TelegramConversation), что и
   * общий инбокс, одним batched-запросом на всю страницу — не по клиенту.
   */
  const unreadByClient = new Map<string, boolean>();
  if (ownAgentId && items.length > 0) {
    const unread = await clientIdsWithUnreadReply(items.map((c) => c.id));
    for (const id of unread) unreadByClient.set(id, true);
  }

  /**
   * ОТОБРАЖАЕМОЕ ИМЯ («Джахонгир · Маяковский», владелец 21.09.2026) — считаем
   * здесь и отдаём готовой строкой `displayName`, чтобы web не тянул за собой
   * якорную логику отдельно для десктопа и мобильного. Адрес объекта продавца —
   * ОДНИМ батчем на страницу (lib/sellerPropertyAnchor.ts), не по клиенту.
   */
  const sellerIds = items.filter((c) => c.kind === "SELLER").map((c) => c.id);
  const sellerAddresses = sellerIds.length ? await loadSellerPropertyAddresses(sellerIds) : new Map<string, string>();
  // «Почему лид ваш» (lib/leadReason.ts) — только непринятым: это подсказка к
  // кнопке «Принять», после приёма она живёт в хронологии карточки.
  const leadReasons = await loadLeadReasons(items.filter((c) => !c.acceptedAt));
  const canSeePhone = can(req, "clients.viewPhone");
  const nextStepFor = (clientId: string, gateUntilAccepted: boolean, seesPhone: boolean) => {
    const step = stepByClient.get(clientId);
    if (!step || gateUntilAccepted) return null;
    return { ...step, nextAction: phoneSafeText(step.nextAction, seesPhone) };
  };

  res.json({
    items: items.map((c) => {
      /**
       * ДО ПРИЁМА ЛИДА — ТОЛЬКО ИМЯ, БЕЗ ТРЕБОВАНИЙ И КОНТАКТОВ.
       *
       * Тот же гейт, что у карточки клиента (card.ts, `gateUntilAccepted`) — там
       * же живая история 20.08.2026: агент увидел маленький бюджет и тихо
       * отказался, не нажав «Принять» формально. Этот список — ВТОРОЙ путь к тем
       * же данным: «Ждут вашего принятия» на Главной и полноэкранный «Входящий
       * лид» (IncomingLeadWindow) читают именно этот ответ, а гейт стоял только
       * на GET /clients/:id — вторую дверь никто не запирал, и бюджет/район
       * агент видел прямо на экране приёма лида, до кнопки «Принять».
       *
       * Только для СВОЕГО непринятого лида (`ownAgentId === c.assignedAgentId`) —
       * не для руководителя со `scopeToOwnAgent` пустым, который смотрит общий
       * список: ему решение «принимать или нет» не принадлежит, прятать нечего.
       */
      const gateUntilAccepted = !!ownAgentId && ownAgentId === c.assignedAgentId && !c.acceptedAt;
      const gated = gateUntilAccepted
        ? {
            ...c,
            budgetMin: null,
            budgetMax: null,
            requirementsNotes: null,
            desiredDistrictId: null,
            desiredDistrict: null,
            desiredRooms: null,
            desiredType: null,
            aiInsight: null,
            aiInsightAt: null,
          }
        : c;
      const presented = presentClient(
        gated,
        canSeePhone && !gateUntilAccepted,
        can(req, "clients.viewOrigin")
      );
      return {
        // canSeePhone форсированно снят гейтом: право `clients.viewPhone` у
        // агента есть почти всегда (иначе ему нечем звонить своим клиентам), но
        // здесь речь не про право, а про то, что лид ещё не его — presentClient
        // при canSeePhone=false заодно закрывает email (см. shared.ts:137).
        ...presented,
        // Имя считаем из УЖЕ показанной карточки (presented): сырое имя несло
        // «Входящий +992…» и источник клиента мимо clients.viewPhone/viewOrigin
        // (аудит Codex 04.10.2026, ACCESS-01).
        displayName: clientDisplayName(presented, { propertyAddress: sellerAddresses.get(c.id) ?? null }),
        // Ближайший шаг — свободный текст из хронологии: до приёма лида хронология
        // закрыта (гейт выше), без права на номер номер в тексте шага маскируется.
        nextStep: nextStepFor(c.id, gateUntilAccepted, canSeePhone),
        leadReason: leadReasons.get(c.id) ?? null,
        unread: unreadByClient.get(c.id) ?? false,
        // «Все мои» — единственный срез, где карточка может быть в Корзине,
        // OTHER, LOST и т.д. одновременно с показом в списке держателя; та же
        // функция считает текст и в уведомлениях (задание В §f п.2/3).
        ...(allMine
          ? {
              hiddenReason: computeHiddenReason({
                ...c,
                deletedByName: (c as unknown as { deletedBy?: { fullName: string } | null }).deletedBy?.fullName,
              }),
            }
          : {}),
      };
    }),
    total,
    page: pageNum,
    pageSize,
  });
});

/** Корзина клиентов (мягко удалённые) — только ADMIN/DIRECTOR. Регистрируется
 * ДО "/:id", иначе Express принял бы "trash" за shortId и не нашёл клиента. */
/**
 * Постранично, а не всё разом (владелец 20.08.2026: «супер скорость»). Раньше
 * `take: 200` без пагинации отдавал разом до двухсот карточек — на телефоне
 * это 200 строк DOM при открытии редко посещаемого экрана. Тот же page/pageSize,
 * что и у обычного списка клиентов (GET /clients) — 20 на страницу.
 */
const CLIENT_TRASH_PAGE_SIZE = 20;
listRouter.get("/trash", requireAuth, requirePermission("archive.view"), async (req, res) => {
  // Math.trunc — как в oversight.ts: ?page=1.3 давал нецелый skip и 500 от Prisma.
  const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
  const where: Prisma.ClientWhereInput = { deletedAt: { not: null } };
  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
      include: {
        desiredDistrict: true,
        deletedBy: { select: { id: true, fullName: true } },
      },
      skip: (page - 1) * CLIENT_TRASH_PAGE_SIZE,
      // Корзина копится годами и никем не чистится, но отдаём её страницами.
      take: CLIENT_TRASH_PAGE_SIZE,
    }),
    prisma.client.count({ where }),
  ]);
  // Та же маска, что у GET / (находка №151): телефон, запасные номера, e-mail и
  // источник закрываются правами clients.viewPhone / clients.viewOrigin и здесь.
  const canSeePhone = can(req, "clients.viewPhone");
  const canSeeOrigin = can(req, "clients.viewOrigin");
  res.json({
    items: items.map((c) => presentClient(c, canSeePhone, canSeeOrigin)),
    total,
    page,
    pageSize: CLIENT_TRASH_PAGE_SIZE,
  });
});

/**
 * GET /clients/lost — раздел «Потерянные клиенты» (решение владельца 11.08.2026,
 * свой раздел рядом с «Горячими»). Зарегистрирован ДО `GET /:id` ниже: иначе
 * Express принял бы «lost» за id и отдавал бы 404 вместо списка.
 *
 * Клиент попадает сюда, когда предел передач (Settings.leadMaxTransfers) исчерпан:
 * несколько агентов подряд не смогли его закрыть, и автоматика прекращает
 * назначать его дальше — это не оценка клиента, а факт про нас.
 *
 * Цепочка отказов строится по записям SYSTEM/NEGATIVE в хронологии: их же создают
 * POST /clients/:id/refuse и «Итог объекта: Неактивный» (routes/me.ts) — оба пути
 * закрытия карточки сведены к одному маркеру, чтобы раздел видел обоих. Отдельных
 * полей для истории заводить не пришлось: то, что уже пишется в хронологию,
 * оказалось достаточно.
 */
/**
 * СТРАНИЦЫ ВМЕСТО ОБРЕЗА (02.10.2026). «Потерянные» и «Отложенные» молча
 * кончались на двухстах: экран писал «Показаны последние 200 из N», а увидеть
 * остальных было нечем. Теперь экран дочитывает страницы кнопкой «Показать
 * ещё»; потолок страницы — прежние двести, так что ответ не толще, чем был.
 */
const sectionPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
/** Потолок на СТРОКИ цепочки SYSTEM-событий по клиентам «Потерянные» (22.09.2026,
 *  класс «Пагинация»): клиентов не больше страницы (≤ 200), но событий на
 *  одного — передач, отказов — формально сколько угодно. 30 на клиента с запасом. */
const LOST_CLIENTS_CHAIN_PER_CLIENT_CAP = 30;

listRouter.get("/lost", requireAuth, requirePermission("clients.assign"), async (req, res) => {
  /**
   * `?kind=SELLER|BUYER` — срез «Потерянные» ВНУТРИ раздела (21.09.2026).
   *
   * Владелец: «должно быть всего 2 раздела — Продавцы, Покупатели, — а когда в
   * них заходишь, потом уже неактивные, потерянные». До этого «Потерянные»
   * были отдельной вкладкой верхнего уровня и показывали оба вида вперемешку;
   * разделить их на клиенте нельзя — список обрезан двумя сотнями свежих, и
   * отбор по уже полученной странице соврал бы ровно тогда, когда потерянных
   * много.
   *
   * Значение читаем сами, без zod-схемы всего запроса: параметр один, и любая
   * посторонняя строка просто игнорируется — срез не сужает права (право
   * clients.assign проверено выше), а только выборку.
   */
  const paging = sectionPageSchema.safeParse(req.query);
  if (!paging.success) {
    return res.status(400).json({ error: "Неверные параметры", details: paging.error.flatten() });
  }
  const { page, pageSize } = paging.data;
  const kindParam = req.query.kind;
  const kind: "SELLER" | "BUYER" | null = kindParam === "SELLER" ? "SELLER" : kindParam === "BUYER" ? "BUYER" : null;
  const lostWhere = { status: "LOST" as const, deletedAt: null, ...(kind ? { kind } : {}) };
  // Сколько их всего — чтобы экран честно сказал, что показывает не весь список.
  // Обрезка была молчаливой: двести первых выглядели как «все потерянные», и по
  // такому экрану директор делал вывод о масштабе потерь.
  const total = await prisma.client.count({ where: lostWhere });
  const clients = await prisma.client.findMany({
    where: lostWhere,
    // По моменту потери (lostAt), а не эскалации (аудит 23.09.2026, №51):
    // escalatedAt пуст у потерянных после отказа агента и после «светофора»
    // неактивных, и такие карточки падали в конец списка, а «двести свежих»
    // оказывались не свежими. Старые карточки без lostAt — по escalatedAt.
    // id — добивка порядка: без неё строки с одинаковыми датами (и старые без
    // обеих) перескакивали бы между страницами «Показать ещё».
    orderBy: [
      { lostAt: { sort: "desc", nulls: "last" } },
      { escalatedAt: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ],
    /**
     * Предел выборки — как у соседней «Корзины» в этом же файле.
     *
     * Статус LOST терминальный: записи оттуда не уходят и не чистятся. Без
     * потолка через год работы этот экран тянул бы всю накопленную историю
     * потерянных клиентов ОДНИМ ответом, да ещё с цепочкой отказов по каждому
     * (запрос ниже). Поэтому — страницами (sectionPageSchema выше).
     */
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      phone: true,
      refusalCount: true,
      refusalReason: true,
      escalatedAt: true,
      lostAt: true,
    },
  });
  if (clients.length === 0) return res.json({ items: [], total, page, pageSize });

  // Один запрос на всех, а не по клиенту — список руководства открывается сразу
  // целиком, N+1 здесь означал бы N обращений к базе на одном экране.
  /**
   * Цепочка — ВСЕ служебные события карточки, а не только помеченные
   * outcome="NEGATIVE".
   *
   * Признак outcome ставит только «Завершить сделку → Без сделки»
   * (POST /clients/:id/refuse). Передачи (lib/clientTransfer.ts) пишут такую же
   * запись SYSTEM без него — и клиент, потерянный ровно после трёх передач,
   * открывался в «Потерянных» с ПУСТОЙ цепочкой, то есть без того единственного,
   * ради чего раздел делался: «через кого именно и почему». Все SYSTEM-записи и
   * есть история переходов между агентами — передачи, отказы, перевод в
   * Неактивные и возврат.
   */
  const chain = await prisma.interaction.findMany({
    where: { clientId: { in: clients.map((c) => c.id) }, type: "SYSTEM" },
    orderBy: { createdAt: "asc" },
    // Потолок — строки, а не id клиентов (клиентов не больше страницы).
    take: clients.length * LOST_CLIENTS_CHAIN_PER_CLIENT_CAP,
    select: {
      clientId: true,
      notes: true,
      createdAt: true,
      agent: { select: { fullName: true } },
    },
  });
  const chainByClient = new Map<string, typeof chain>();
  for (const hop of chain) {
    chainByClient.set(hop.clientId, [...(chainByClient.get(hop.clientId) ?? []), hop]);
  }

  const canSeePhone = can(req, "clients.viewPhone");
  res.json({
    items: clients.map((c) => ({
      id: c.id,
      shortId: c.shortId,
      // Имя карточки незнакомого звонившего CRM составляет из номера — правило
      // то же, что в presentClient (routes/clients/shared.ts), список «Потерянные»
      // его просто не звал.
      fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
      kind: c.kind,
      phone: canSeePhone ? c.phone : maskPhone(c.phone),
      refusalCount: c.refusalCount,
      lastReason: c.refusalReason ? REFUSAL_REASON_LABELS[c.refusalReason as RefusalReason] ?? c.refusalReason : null,
      lostAt: c.lostAt ?? c.escalatedAt,
      // Каждый шаг — кто вёл и что записал при закрытии. Именно это владелец
      // просил видеть в разделе: «через кого именно, причина и комментарий
      // каждого отказа», не открывая карточку по одной.
      chain: (chainByClient.get(c.id) ?? []).map((hop) => ({
        agentName: hop.agent?.fullName ?? "—",
        // Комментарий при отказе — свободный текст, куда номер попадает и руками
        // («звонить на 900001016»), и автоматикой из расшифровки. Закрыт тем же
        // правом, что и `phone` строкой выше (владелец 30.08.2026).
        notes: phoneSafeText(hop.notes, canSeePhone),
        at: hop.createdAt,
      })),
    })),
    total,
    page,
    pageSize,
  });
});

/**
 * GET /clients/deferred — раздел «Отложенные» (задача G, план 03-04.09.2026,
 * решение владельца). Зарегистрирован ДО `GET /:id` ниже — та же причина, что
 * у "lost"/"trash" выше: иначе Express принял бы "deferred" за id.
 *
 * ВИДИМОСТЬ — не clients.assign, как у «Потерянных»: агенту нужно видеть СВОИ
 * отложенные (task G5, «агенту — свои отложенные с датой возврата»), поэтому
 * requireAuth + scopeToOwnAgent (кто без clients.viewAll — видит только свои,
 * управленец с clients.viewAll — всех), тот же приём, что и у обычного списка
 * клиентов (GET /) чуть ниже, а не отдельная проверка права.
 */
listRouter.get("/deferred", requireAuth, async (req, res) => {
  // Страницами, как «Потерянные» выше (sectionPageSchema): раньше молча 200.
  const paging = sectionPageSchema.safeParse(req.query);
  if (!paging.success) {
    return res.status(400).json({ error: "Неверные параметры", details: paging.error.flatten() });
  }
  const { page, pageSize } = paging.data;
  const ownAgentId = scopeToOwnAgent(req);
  const where: Prisma.ClientWhereInput = {
    workStatus: "DEFERRED",
    status: { notIn: [...TERMINAL_CLIENT_STATUSES] },
    deletedAt: null,
    ...(ownAgentId ? { assignedAgentId: ownAgentId } : {}),
  };
  const total = await prisma.client.count({ where });
  const clients = await prisma.client.findMany({
    where,
    // Ближе к возврату — выше: это и есть то, что нужно проверить в первую
    // очередь (уже почти истёк срок), а не самые свежие отсрочки.
    orderBy: [{ deferredUntil: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      phone: true,
      deferredAt: true,
      deferredReason: true,
      deferredUntil: true,
      assignedAgent: { select: { id: true, fullName: true } },
    },
  });

  const canSeePhone = can(req, "clients.viewPhone");
  res.json({
    items: clients.map((c) => ({
      id: c.id,
      shortId: c.shortId,
      fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
      kind: c.kind,
      phone: canSeePhone ? c.phone : maskPhone(c.phone),
      deferredAt: c.deferredAt,
      deferredReason: c.deferredReason
        ? REFUSAL_REASON_LABELS[c.deferredReason as RefusalReason] ?? c.deferredReason
        : null,
      deferredUntil: c.deferredUntil,
      agentName: c.assignedAgent?.fullName ?? null,
    })),
    total,
    page,
    pageSize,
  });
});
