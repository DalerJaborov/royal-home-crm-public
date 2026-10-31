import type { NextFunction, Request, Response } from "express";
import {
  parsePermissionOverrides,
  resolvePermissions,
  type PermissionId,
  type Role,
  isReadOnlyRole,
} from "@royal-home/shared";
import { verifyAccessToken } from "./jwt.js";
import { prisma } from "../db.js";
import { runAsActor } from "../lib/requestActor.js";
import { logSystemError } from "../lib/systemError.js";

/** «Онлайн» на экране Команда: lastSeenAt обновляется не чаще раза в минуту на агента,
 * запись — в фоне и best-effort, чтобы не тормозить и не ронять сам запрос. */
const lastSeenCache = new Map<string, number>();
const LAST_SEEN_THROTTLE_MS = 60_000;

function touchLastSeen(agentId: string) {
  const now = Date.now();
  const prev = lastSeenCache.get(agentId);
  if (prev && now - prev < LAST_SEEN_THROTTLE_MS) return;
  lastSeenCache.set(agentId, now);
  prisma.agent.update({ where: { id: agentId }, data: { lastSeenAt: new Date() } }).catch(() => {});
}

/** Вывезен (31.10.2026): по нему же ИИ-помощник строит своего «актора»
 *  (ai/assistant/actor.ts, actorFromAccess) — один разбор прав на всю CRM. */
export interface AgentAccess {
  role: Role;
  isActive: boolean;
  permissions: Set<PermissionId>;
  /**
   * Внутренний номер на АТС. Лежит здесь, а не читается отдельным запросом, ровно
   * по одной причине: по нему окно оператора понимает, ЕГО ли это входящий звонок
   * (см. lib/telephony/incomingCalls.ts, activeIncomingFor). Опрос идёт раз в
   * секунду во время разговора, и лишнее чтение агента на каждый опрос — это
   * запрос в секунду на каждого оператора за один короткий текст.
   */
  sipExtension: string | null;
}

/**
 * Права и роль читаются из БАЗЫ, а не из JWT, и это принципиально.
 *
 * Раньше роль бралась из токена: если директор понижал администратора или
 * отключал учётку, старый токен продолжал работать со старыми правами до конца
 * срока жизни (часы). Для системы, где права раздаются точечно, это дыра —
 * снятая галочка обязана действовать сразу.
 *
 * Плата за это — чтение агента на каждый запрос, поэтому держим короткий кэш в
 * памяти процесса. TTL намеренно маленький: даже если инвалидация где-то не
 * сработает, отставание не превысит 15 секунд. При изменении прав/роли/статуса
 * кэш сбрасывается явно через invalidateAgentAccess.
 */
const ACCESS_TTL_MS = 15_000;
const accessCache = new Map<string, { value: AgentAccess; expiresAt: number }>();

/** Сбросить кэш доступа: без аргумента — весь (смена пресетов ролей при деплое). */
export function invalidateAgentAccess(agentId?: string) {
  if (agentId) accessCache.delete(agentId);
  else accessCache.clear();
}

export async function loadAgentAccess(agentId: string): Promise<AgentAccess | null> {
  const cached = accessCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { role: true, isActive: true, permissions: true, sipExtension: true },
  });
  if (!agent) return null;

  const value: AgentAccess = {
    role: agent.role as Role,
    isActive: agent.isActive,
    permissions: resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions)),
    sipExtension: agent.sipExtension,
  };
  accessCache.set(agentId, { value, expiresAt: Date.now() + ACCESS_TTL_MS });
  return value;
}

/**
 * РЕЖИМ ТОЛЬКО ДЛЯ ЧТЕНИЯ ДЛЯ АКЦИОНЕРА (10.10.2026, роль SHAREHOLDER).
 *
 * Одних прав недостаточно: большая часть записывающих роутов защищена только
 * `requireAuth` плюс проверкой «своё» (свой клиент, свой объект, свой профиль), а
 * не отдельной галочкой — у акционера нет ни одной «пишущей» галочки, но «своё» у
 * него тоже есть (он сотрудник), и такие роуты ему открыты. Перечислять роуты и
 * вычёркивать их по одному — значит забыть следующий, который добавят завтра.
 * Поэтому запрет стоит ОДНИМ местом, в requireAuth, и работает по умолчанию:
 * всё, что меняет данные, закрыто, кроме короткого списка исключений ниже.
 *
 * Исключения: чтение (GET/HEAD/OPTIONS); вход/выход/обновление токена
 * (/api/v1/auth/*); правка собственного профиля, где меняется и пароль
 * (PATCH /api/v1/me — routes/me.ts); подписка на пуши своего устройства
 * (POST /api/v1/push/subscribe|unsubscribe); отчёт интерфейса об ошибке
 * (POST /api/v1/errors) — без него акционер не сможет сообщить о поломке.
 * POST /api/v1/push/action идёт без requireAuth (подпись в самом запросе), сюда не
 * доходит и в исключения не нужен.
 *
 * Чистая функция вынесена и экспортирована ради теста: он обходит ВСЕ
 * зарегистрированные роуты и сверяет их с этим предикатом.
 */
const READ_ONLY_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const READ_ONLY_EXEMPT_WRITES = new Set([
  "PATCH /api/v1/me",
  "POST /api/v1/push/subscribe",
  "POST /api/v1/push/unsubscribe",
  "POST /api/v1/errors",
  // Своё и только своё: тема и настройки интерфейса, фото профиля, выход из
  // собственных сессий. Это не данные компании (решение 10.10.2026).
  "PUT /api/v1/me/preferences",
  "POST /api/v1/me/avatar",
]);
/** DELETE /api/v1/me/sessions/:id — тоже своё (завершить свою сессию на другом устройстве). */
const READ_ONLY_EXEMPT_PREFIXES: ReadonlyArray<readonly [string, string]> = [["DELETE", "/api/v1/me/sessions/"]];

export const READ_ONLY_ROLE_RESPONSE = {
  error: "Режим просмотра: изменения недоступны",
  code: "READ_ONLY_ROLE",
} as const;

export function isReadOnlyExemptRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (READ_ONLY_SAFE_METHODS.has(m)) return true;
  const clean = path.split("?")[0]!.replace(/\/+$/, "") || "/";
  if (clean === "/api/v1/auth" || clean.startsWith("/api/v1/auth/")) return true;
  if (READ_ONLY_EXEMPT_WRITES.has(`${m} ${clean}`)) return true;
  return READ_ONLY_EXEMPT_PREFIXES.some(([method, prefix]) => m === method && clean.startsWith(prefix) && clean.length > prefix.length);
}

declare global {
  namespace Express {
    interface Request {
      agent?: {
        id: string;
        role: Role;
        permissions: Set<PermissionId>;
        /** Внутренний номер на АТС — по нему опознаётся «мой» входящий звонок. */
        sipExtension: string | null;
        /** Короткая проверка права в теле роута, когда middleware недостаточно. */
        can: (permission: PermissionId) => boolean;
      };
    }
  }
}

export async function requireAuth<P>(req: Request<P>, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }
  let agentId: string;
  try {
    agentId = verifyAccessToken(header.slice("Bearer ".length)).sub;
  } catch {
    return res.status(401).json({ error: "Недействительный или истёкший токен" });
  }

  try {
    const access = await loadAgentAccess(agentId);
    // Учётку удалили или отключили — токен обязан перестать работать немедленно,
    // не дожидаясь истечения срока.
    if (!access) return res.status(401).json({ error: "Учётная запись не найдена" });
    if (!access.isActive) {
      return res.status(403).json({ error: "Учётная запись отключена", accountDisabled: true });
    }

    // Акционер только смотрит (см. isReadOnlyExemptRequest).
    if (isReadOnlyRole(access.role) && !isReadOnlyExemptRequest(req.method, req.originalUrl)) {
      return res.status(403).json(READ_ONLY_ROLE_RESPONSE);
    }

    req.agent = {
      id: agentId,
      role: access.role,
      permissions: access.permissions,
      sipExtension: access.sipExtension,
      can: (permission) => access.permissions.has(permission),
    };
    touchLastSeen(agentId);

    /**
     * ЗДЕСЬ БЫЛА ЖЁСТКАЯ БЛОКИРОВКА CRM за незаполненное обязательное окно
     * (решение владельца 11.08.2026, отменено 13.09.2026: «вообще убери»).
     *
     * Механизм и так стоял на паузе рубильником с 08.09.2026 и не срабатывал ни
     * разу с тех пор. Убран целиком, а не оставлен выключенным: выключенная
     * блокировка, способная запереть всю CRM, — это ружьё, которое однажды
     * включат, не помня цены.
     */

    // Дальше запрос живёт «от имени» сотрудника: AsyncLocalStorage переживает
    // await, и журнал переходов (db.ts) видит, КТО перевёл статус, из любой
    // глубины кода без протаскивания agentId через сигнатуры.
    runAsActor(agentId, () => next());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auth] Не удалось проверить доступ:", message);
    // Пул соединений Prisma занят (приёмка 08.09.2026: 6 одновременных
    // пользователей исчерпывали connection_limit, и это падало сюда 500-кой —
    // requireAuth стоит перед КАЖДЫМ защищённым роутом, включая /auth/refresh,
    // /me, /settings, /dashboard/counters). Это временный отказ, не поломка
    // авторизации — клиенту стоит повторить запрос, а не разлогинивать
    // пользователя. logSystemError сам дедупит одинаковый текст на 10 минут,
    // так что при затяжном исчерпании пула в журнал не льётся построчно.
    res.set("Retry-After", "2");
    void logSystemError("api", `Пул соединений БД занят при проверке доступа: ${message}`);
    return res.status(503).json({ error: "Сервис временно недоступен, повторите запрос" });
  }
}

/**
 * Пропускает, если у сотрудника есть ХОТЯ БЫ ОДНО из перечисленных прав.
 * Обычно передаётся одно — несколько нужны там, где к разделу ведут разные
 * сценарии (например, справочник сотрудников нужен и для назначения лида,
 * и для управления учётками).
 *
 * Директор проходит любую проверку: resolvePermissions выдаёт ему весь реестр.
 */
export function requirePermission(...permissions: PermissionId[]) {
  return <P,>(req: Request<P>, res: Response, next: NextFunction) => {
    if (!req.agent) {
      return res.status(401).json({ error: "Требуется авторизация" });
    }
    if (!permissions.some((p) => req.agent!.permissions.has(p))) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }
    next();
  };
}

/** Проверка права внутри тела роута (когда ветвление зависит от данных запроса). */
export function can(req: Request, permission: PermissionId): boolean {
  return req.agent?.permissions.has(permission) ?? false;
}

/**
 * Ограничение выборки своими записями. Раньше опиралось на роль AGENT, теперь —
 * на право «видеть всех»: сотруднику можно открыть чужие карточки галочкой, не
 * меняя роль, и наоборот — отобрать их у менеджера.
 */
export function scopeToOwnAgent(req: Request): string | undefined {
  if (!req.agent) return undefined;
  return req.agent.permissions.has("clients.viewAll") ? undefined : req.agent.id;
}

/**
 * МОЖНО ЛИ ПРИВЯЗАТЬ К СВОЕЙ ЗАПИСИ ЭТОГО КЛИЕНТА (аудит 23.09.2026).
 *
 * Сделка, объект («карточка продавца»), ссылка клиенту принимают clientId из
 * запроса. Сделка проверяла, что клиент свой, а объект и ссылка — нет: агент
 * присылал id чужого клиента, объект брал его настоящий телефон в «контакт
 * владельца» и отдавал агенту в ответе (номер в обход маски clients.viewPhone),
 * а ссылка писала «отправлен объект» в хронологию чужого клиента. Правило то же,
 * что у списка клиентов агента: свой — это закреплённый за ним.
 */
export function canBindClient(req: Request, client: { assignedAgentId: string | null }): boolean {
  if (!req.agent) return false;
  if (client.assignedAgentId === req.agent.id) return true;
  // «Видеть всех» — не «писать во всех» (глубокая проверка 02.10.2026, A3).
  // Привязка — это запись: сделка бронирует объект, объект ставит клиента
  // продавцом, ссылка пишет в хронологию. Служба безопасности видит всех
  // клиентов (clients.viewAll), но ничего не меняет — по viewAll она заводила
  // сделку на чужого покупателя. Чужого клиента привязывает тот, кто распределяет
  // (clients.assign), — то же правило, что foreignWriteDenied в clients/shared.ts.
  return req.agent.permissions.has("clients.viewAll") && req.agent.permissions.has("clients.assign");
}

/**
 * То же для сделок, но по своему праву. Право deals.viewAll было объявлено и
 * выдавалось пресетами, а на API не влияло вообще: сделки скоупились правом на
 * клиентов, и два права расходились друг с другом на одном экране.
 */
export function scopeDealsToOwnAgent(req: Request): string | undefined {
  if (!req.agent) return undefined;
  return req.agent.permissions.has("deals.viewAll") ? undefined : req.agent.id;
}

/**
 * ЗАПИСЬ В ЧУЖУЮ СДЕЛКУ (глубокая проверка 02.10.2026, A3).
 *
 * scopeDealsToOwnAgent решает только «видно ли»: с deals.viewAll сотрудник видит
 * любую сделку. Писать по нему же было ошибкой — служба безопасности (deals.viewAll
 * без единого права на запись, «видит..., но ничего не меняет») отменяла чужую
 * живую сделку, и объект продавца молча снимался с брони. Правило то же, что
 * у клиентов (foreignWriteDenied в routes/clients/shared.ts): чужую сделку меняет
 * руководство — тот, кто подтверждает закрытие (deals.complete) или
 * распределяет клиентов (clients.assign). Свою сделку — всегда её агент.
 *
 * Возвращает текст отказа или null, если писать можно. Рядового агента
 * (ownAgentId задан) ограничивает проверка владения строкой выше по маршруту.
 */
export function foreignDealWriteDenied(
  req: Request,
  deal: { agentId: string },
  ownAgentId: string | undefined
): string | null {
  if (ownAgentId) return null;
  if (!req.agent) return "Недостаточно прав";
  if (deal.agentId === req.agent.id) return null;
  if (req.agent.permissions.has("deals.complete") || req.agent.permissions.has("clients.assign")) return null;
  return "Чужую сделку ведёт её агент или руководитель";
}

/** Может ли текущий сотрудник открыть карточку, закреплённую за указанным агентом. */
export function canAccessAssignedAgent(req: Request, assignedAgentId: string | null | undefined): boolean {
  if (!req.agent) return false;
  return req.agent.permissions.has("clients.viewAll") || req.agent.id === assignedAgentId;
}

/** То же для объекта: право на все объекты либо своя карточка. */
export function canAccessAssignedProperty(req: Request, assignedAgentId: string | null | undefined): boolean {
  if (!req.agent) return false;
  return req.agent.permissions.has("properties.editForeign") || req.agent.id === assignedAgentId;
}
