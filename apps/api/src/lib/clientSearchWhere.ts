/**
 * ПОСТРОИТЕЛЬ УСЛОВИЯ ПОИСКА КЛИЕНТОВ — ОДИН НА REST И НА ИИ-ПОМОЩНИКА
 * (31.10.2026, пачка П3, группа «read», docs/design/internal-assistant-architecture-2026-10-31.md §3).
 *
 * Тело вынесено из `routes/clients/list.ts` (GET /clients) БЕЗ изменения поведения:
 * строка поиска (слова по ФИО/почте/адресу/«заметкам»/району/нику, номер карточки,
 * телефон — только тому, кому он виден), срез агента (только покупатели и продавцы),
 * скрытие карточек с висящей заявкой на удаление и простые фильтры. Помощник
 * (`ai/assistant/tools/findClients.ts`) зовёт ту же функцию — иначе поиск «в чате» и
 * «в списке» разошлись бы в первой же правке, а права на телефон/ник обходились бы
 * вторым путём.
 *
 * Права приходят ФЛАГАМИ (`canSearchByPhone`, `canSearchByOrigin`, `canDelete`), а не
 * `req`: помощник не ходит через express-запрос.
 */
import { parseShortCode } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { toSearchTokens, toTokenVariants } from "./searchTokens.js";

/**
 * Клиенты из списка id, у кого последняя реплика в переписке — от самого
 * клиента, и диалог не открывали после неё (BotConversation/TelegramConversation).
 * Один признак «непрочитано» на два места: бейдж непрочитанного в обычном
 * списке и исключение из фильтра «скрыл заявку на удаление» — если клиент
 * написал, пока заявка висит, карточка обязана остаться на виду
 * (владелец 18.09.2026, разбор «что если клиент напишет во время заявки»).
 */
export async function clientIdsWithUnreadReply(ids: string[]): Promise<Set<string>> {
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

/** Сколько висящих заявок на удаление читаем за раз (потолок обязателен: очередь растёт без предела). */
const PENDING_DELETE_SCAN_LIMIT = 500;

/**
 * ЗАЯВКА НА УДАЛЕНИЕ — КАРТОЧКА ИСЧЕЗАЕТ ИЗ СПИСКА СРАЗУ (владелец 17.09.2026).
 * Возвращает id, которые надо спрятать: тот, у кого есть `clients.delete`, решает
 * эти заявки сам и видит список целиком (пустой ответ). Исключение — клиент написал,
 * пока заявка висит (18.09.2026): такая карточка остаётся на виду.
 *
 * Отказ потолка безопасен: не попавшая в выборку заявка оставит карточку на виду.
 */
export async function pendingDeleteHiddenClientIds(params: {
  ownAgentId: string | undefined;
  canDelete: boolean;
}): Promise<string[]> {
  if (params.canDelete) return [];
  const pendingDeleteIds = (
    await prisma.clientDeleteRequest.findMany({
      where: {
        status: "PENDING",
        ...(params.ownAgentId ? { client: { assignedAgentId: params.ownAgentId } } : {}),
      },
      select: { clientId: true },
      take: PENDING_DELETE_SCAN_LIMIT,
    })
  ).map((r) => r.clientId);
  if (pendingDeleteIds.length === 0) return [];
  const unread = await clientIdsWithUnreadReply(pendingDeleteIds);
  return pendingDeleteIds.filter((id) => !unread.has(id));
}

/**
 * АГЕНТУ — ТОЛЬКО ПОКУПАТЕЛИ И ПРОДАВЦЫ (владелец 30.08.2026): «прочие обращения»
 * видит руководство. Исключение — клиент сам назвал сотрудника (`requested_by_client`).
 * Условие кладётся в `where.OR` вместе со скоупом `assignedAgentId`.
 */
export const AGENT_CLIENT_KIND_SCOPE: Prisma.ClientWhereInput[] = [
  { kind: { in: ["BUYER", "SELLER"] } },
  { assignReason: "requested_by_client" },
];

export interface ClientFieldFilters {
  kind?: Prisma.ClientWhereInput["kind"];
  status?: Prisma.ClientWhereInput["status"];
  source?: Prisma.ClientWhereInput["source"];
  districtId?: string;
  /** Раздел «Горячие клиенты»: отказные с заполненной карточкой или после показа. */
  hot?: boolean;
}

/** Простые фильтры по полям карточки — только заданные. */
export function clientFieldFilters(f: ClientFieldFilters): Prisma.ClientWhereInput {
  return {
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.districtId ? { desiredDistrictId: f.districtId } : {}),
    ...(f.hot ? { hotSince: { not: null } } : {}),
  };
}

/**
 * Условие текстового поиска для `where.AND`, либо `null`, когда в запросе нет слов
 * (тогда фильтра нет, а не пустая выдача).
 *
 * Каждое слово запроса должно найтись, порядок и написание слов не важны
 * («Исмоилова Гулнора» = «Гулнора Исмоилова»). Номер карточки («ПК-000042», «42»)
 * — АЛЬТЕРНАТИВА словам, а не дополнительное условие: голое «42» находит и карточку
 * №42, и телефон с «42».
 *
 * Телефон (основной, запасной, WhatsApp) ищется ТОЛЬКО при `canSearchByPhone` — иначе
 * право `clients.viewPhone` обходилось бы перебором хвоста («да/нет» на догадку).
 * Ник соцсети — только при `canSearchByOrigin` (`clients.viewOrigin`). Поля адреса,
 * заметок, почты, телеграма и желаемого района видны всем, у кого есть доступ к списку.
 */
export async function buildClientTextSearchAnd(
  q: string | undefined,
  rights: { canSearchByPhone: boolean; canSearchByOrigin: boolean }
): Promise<Prisma.ClientWhereInput[] | null> {
  const clientTokens = q ? toSearchTokens(q) : [];
  if (!q || clientTokens.length === 0) return null;
  const shortIdMatch = parseShortCode(q);
  /**
   * ЗАПАСНОЙ И WHATSAPP-НОМЕР ТОЖЕ ИЩУТСЯ (04.09.2026). `extraPhones` — массив, Prisma
   * не умеет `contains` по его элементам, поэтому подстрочное совпадение считается
   * сырым SQL. Вызов `client_extra_phones_search_text(...)` обязан совпадать с индексным
   * выражением СЛОВО В СЛОВО (миграция 20260914140100_client_phone_trgm_search), иначе
   * планировщик индекс не увидит.
   */
  const extraPhoneMatches = rights.canSearchByPhone
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
  const byTokens: Prisma.ClientWhereInput[] = clientTokens.map((token, i) => ({
    OR: [
      ...toTokenVariants(token).map((variant) => ({
        fullName: { contains: variant, mode: "insensitive" as const },
      })),
      ...(rights.canSearchByPhone ? [{ phone: { contains: token } }] : []),
      ...(extraPhoneMatches[i]?.length ? [{ id: { in: extraPhoneMatches[i].map((r) => r.id) } }] : []),
      // Раскладка/транслит ник не нужны: это точная строка из профиля соцсети.
      ...(rights.canSearchByOrigin ? [{ socialUsername: { contains: token, mode: "insensitive" as const } }] : []),
      // Остальные поля карточки (04.09.2026, «поиск по всем параметрам»). Почта до
      // принятия лида в карточке скрыта, но здесь ищется совпадение, а не отдаётся поле.
      { email: { contains: token, mode: "insensitive" as const } },
      { address: { contains: token, mode: "insensitive" as const } },
      { requirementsNotes: { contains: token, mode: "insensitive" as const } },
      { telegramUsername: { contains: token, mode: "insensitive" as const } },
      // Район желаемого поиска — часть якоря отображаемого имени (21.09.2026).
      { desiredDistrict: { name: { contains: token, mode: "insensitive" as const } } },
    ],
  }));
  return shortIdMatch !== null ? [{ OR: [{ shortId: shortIdMatch }, { AND: byTokens }] }] : byTokens;
}
