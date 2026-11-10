import { Prisma } from "../generated/prisma/client.js";
import {
  agentCreateSchema,
  agentFreezeSchema,
  agentHandoverSchema,
  agentUpdateSchema,
  describePermissions,
  normalizeOverrides,
  parsePermissionOverrides,
  permissionOverridesSchema,
  resolvePermissions,
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PRESET_SUMMARY,
  SALES_AGENT_ROLES,
  supervisorLeadPauseSchema,
  type PermissionId,
  type Role,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { invalidateAgentAccess } from "../auth/middleware.js";
import { logAgentAudit } from "./audit.js";
import { syncAgentQueuePresence } from "./telephony/operatorQueue.js";
import { syncAgentMobileFallback } from "./telephony/agentMobileFallback.js";
import {
  checkIncomingReadiness,
  describeNewAgentQueueOutcome,
  ensureAgentsInIncomingQueue,
} from "./telephony/agentIncomingReadiness.js";
import {
  checkManualExtension,
  ensureExtensionRecording,
  getExtensionStatuses,
  pickFreeExtension,
} from "./telephony/extensionPool.js";
import { revokeOtherSessions } from "./sessions.js";
import { closeStreamsForAgent } from "./eventBus.js";
import { agentHasCascadeHistory } from "./agentHistory.js";
import { revokeElevation } from "./stepUp.js";
import { handoverAgentWork } from "./agentHandover.js";
import { revertAgentHandover } from "./agentHandoverRevert.js";
import { releaseReactivationOffersOfAgent } from "./reactivationOffers.js";
import { shiftInactiveClockAfterAbsence } from "./inactiveTrafficLight.js";
import { findUnacceptedLeadsOfAgent, releaseLeadsToQueue, type ReleasableLead } from "./agentLeadRelease.js";
import { clearAgentFromSettingsReferences } from "./agentSettingsCleanup.js";
import { alertNoMontajerIfWorkWaits } from "./montajerHandover.js";
import { endLeadPause, notifyAgentAboutSupervisorPause, startLeadPause } from "./agentLeadPause.js";
import { availabilityOf } from "./agentAvailability.js";
import { sendPushToAgents } from "../push.js";
import { notifyStaffChangeLater, type StaffSecurityChange } from "./staffSecurityNotify.js";

/**
 * УПРАВЛЕНИЕ СОТРУДНИКАМИ — ОДНА ДВЕРЬ (10.11.2026, владелец: «все возможности
 * директора вплоть от создания или удаления работников и изменения прав»).
 *
 * До этой правки тела лежали прямо в `routes/agents.ts`, и ИИ-помощница (Шабнам,
 * Telegram) могла бы получить доступ к сотрудникам только второй копией — ровно
 * тот класс, из-за которого правило «одна дверь» и появилось. Теперь маршрут и
 * помощник зовут одни и те же функции этого модуля: проверки (учётка директора,
 * раздающего права, последний директор), запись, хвосты (сессии, очередь
 * входящих, снятие лидов) и журнал — одним текстом.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: права на сам маршрут (`requirePermission`) и
 * подтверждения личности (`requireElevation`). Это граница входа: у REST их
 * держит middleware, у помощника — брокер действий (`requires` + `stepUp`,
 * lib/assistantActions.ts). Внутри функций — только правила, которые зависят от
 * данных (чья учётка, какая роль запрошена).
 *
 * Ответ — `{ ok, status, body }` ровно в том виде, в каком его отдаёт REST:
 * маршрут печатает его без переделки, поэтому поведение REST не менялось
 * (проверено прежними тестами маршрутов).
 */

/** Кто действует: тот же круг сведений, что `req.agent` у маршрута. */
export interface StaffActor {
  id: string;
  role: string;
  can: (permission: PermissionId) => boolean;
}

/** Откуда пришло действие — для журнала и сообщения руководству. REST — без метки. */
export interface StaffCallOptions {
  via?: "assistant";
  /** Где нажали подтверждение помощницы: Telegram или панель CRM. */
  channel?: "telegram" | "crm";
}

/**
 * Сообщение руководству (lib/staffSecurityNotify.ts) — из одной этой точки и для
 * REST, и для помощницы. `assistantOnly` — то, о чём из CRM не сообщаем (заведение
 * рядового сотрудника, заморозка, передача дел видны в разделе «Команда» и так),
 * а из Telegram сообщаем: там нажатие могло быть чужими руками.
 */
function notice(
  actor: StaffActor,
  opts: StaffCallOptions | undefined,
  change: StaffSecurityChange,
  target: { id: string; fullName: string },
  details?: string,
  assistantOnly = false
): void {
  if (assistantOnly && !opts?.via) return;
  notifyStaffChangeLater({
    change,
    actorId: actor.id,
    targetId: target.id,
    targetName: target.fullName,
    details,
    channel: opts?.via ? (opts.channel ?? "crm") : "rest",
  });
}

const roleName = (role: string) => ROLE_LABELS[role as Role] ?? role;
const permissionName = (id: string) => PERMISSIONS.find((p) => p.id === id)?.label ?? id;

/** «Добавлено: …; снято: …» — по итоговым правам, а не по надстройкам. */
export function describePermissionDiff(role: Role, before: unknown, after: unknown): string {
  const was = resolvePermissions(role, parsePermissionOverrides(before));
  const now = resolvePermissions(role, parsePermissionOverrides(after));
  const added = [...now].filter((p) => !was.has(p)).map(permissionName);
  const removed = [...was].filter((p) => !now.has(p)).map(permissionName);
  return [added.length ? `Добавлено: ${added.join(", ")}` : null, removed.length ? `Снято: ${removed.join(", ")}` : null]
    .filter(Boolean)
    .join("; ") || "Без изменений";
}

export type StaffOutcome<T = Record<string, unknown>> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: { error: string; [key: string]: unknown } };

const done = <T>(body: T, status = 200): StaffOutcome<T> => ({ ok: true, status, body });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): StaffOutcome<never> => ({
  ok: false,
  status,
  body: { error, ...extra },
});

function audit(actor: StaffActor, opts: StaffCallOptions | undefined, action: string, entityId: string, meta: Record<string, unknown>) {
  logAgentAudit(actor.id, action, "Agent", entityId, (opts?.via ? { ...meta, source: opts.via } : meta) as Prisma.InputJsonValue);
}

// ───────────────────────────── защиты по данным ─────────────────────────────

/** Учётки директоров и выдача роли DIRECTOR — только для директора: админ не может
 * создать директора, изменить или удалить его учётку. */
export async function forbiddenDirectorTarget(actor: StaffActor, targetId?: string, requestedRole?: string): Promise<boolean> {
  if (actor.role === "DIRECTOR") return false;
  if (requestedRole === "DIRECTOR") return true;
  if (targetId) {
    const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true } });
    if (target?.role === "DIRECTOR") return true;
  }
  return false;
}

/**
 * Роль — это тот же набор прав, поэтому её назначение подчиняется правилу
 * «раздавать права может тот, у кого есть permissions.manage». Без этой проверки
 * обладатель одного agents.manage ставил себе ADMIN. С 14.09.2026 (ADMIN = DIRECTOR)
 * permissions.manage — обычное право пресета ADMIN; роль DIRECTOR по-прежнему
 * отдаёт только директор (forbiddenDirectorTarget). Текст отказа или null.
 */
export function forbiddenRoleGrant(actor: StaffActor, targetId: string | undefined, requestedRole?: string): string | null {
  if (!requestedRole) return null;
  if (actor.can("permissions.manage")) return null;
  if (targetId && targetId === actor.id) {
    return "Нельзя менять собственную роль";
  }
  if (requestedRole === "ADMIN") {
    return "Назначать администратора может только тот, у кого есть право раздавать права";
  }
  return null;
}

/**
 * Учётку того, кто раздаёт права, правит, отключает, замораживает и удаляет только
 * тот, у кого это право тоже есть (G5, 02.10.2026): иначе держатель agents.manage
 * менял админу телефон-логин и входил под ним.
 */
export async function forbiddenPrivilegedTarget(actor: StaffActor, targetId: string): Promise<boolean> {
  if (actor.can("permissions.manage")) return false;
  const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true, permissions: true } });
  if (!target) return false;
  return resolvePermissions(target.role as Role, parsePermissionOverrides(target.permissions)).has("permissions.manage");
}
export const PRIVILEGED_TARGET_ERROR =
  "Управлять учёткой сотрудника, который раздаёт права, может только тот, у кого есть это право";

/** true, если после смены роли/деактивации в системе не останется ни одного активного директора. */
export async function wouldLoseLastDirector(targetId: string, data: { role?: string; isActive?: boolean }): Promise<boolean> {
  const demoted = data.role !== undefined && data.role !== "DIRECTOR";
  const deactivated = data.isActive === false;
  if (!demoted && !deactivated) return false;
  const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true, isActive: true } });
  if (!target || target.role !== "DIRECTOR" || !target.isActive) return false;
  const activeDirectors = await prisma.agent.count({ where: { role: "DIRECTOR", isActive: true } });
  return activeDirectors <= 1;
}

// ───────────────────────────── чтение ─────────────────────────────

const ADMIN_DIRECTORY_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  role: true,
  isActive: true,
  avatarUrl: true,
  createdAt: true,
  kpi: true,
  sipExtension: true,
  whisperLanguage: true,
  /// Ник в Instagram (26.09.2026), см. lib/instagramCollaborators.ts.
  instagramUsername: true,
  /**
   * ПРИЗНАК ОПЕРАТОРА ПЕРВОЙ ЛИНИИ ОБЯЗАН БЫТЬ В ОТВЕТЕ (владелец 20.09.2026):
   * поле, не попавшее в select, интерфейс молча читает как пустое.
   */
  takesUnknownCalls: true,
  // «Присылать мои посты в Telegram» (28.09.2026) — тот же класс находки.
  sharePostTelegram: true,
  // Личные выходные (11.10.2026) — тот же класс.
  weeklyDaysOff: true,
  // Вид и срок отсутствия (09.09.2026) — в ОБЕИХ ветках select: по списку выбирают,
  // кому передать клиента или дела, и человек, которого нет на работе, не должен
  // предлагаться молча.
  frozenAt: true,
  absenceKind: true,
  absenceUntil: true,
} as const;

const PEER_DIRECTORY_SELECT = {
  id: true,
  fullName: true,
  role: true,
  isActive: true,
  avatarUrl: true,
  frozenAt: true,
  absenceKind: true,
  absenceUntil: true,
  // Кому передать клиента — видно, у кого сегодня выходной (11.10.2026).
  weeklyDaysOff: true,
} as const;

/**
 * Список сотрудников (GET /agents). Менеджеру он нужен для назначения лидов —
 * ему отдаётся справочник без учётных данных; контакты, роль и KPI коллег —
 * админская зона (agents.manage). `telephony: false` — без опроса АТС (помощник:
 * Telegram живёт в процессе worker, и звонить станции ради списка незачем).
 */
export async function listStaffDirectory(actor: StaffActor, opts: { telephony?: boolean } = {}) {
  const isAdmin = actor.can("agents.manage");
  const agents = await prisma.agent.findMany({
    select: isAdmin ? ADMIN_DIRECTORY_SELECT : PEER_DIRECTORY_SELECT,
    // Новые сотрудники — сверху, чтобы сразу видеть недавно добавленных.
    orderBy: { createdAt: "desc" },
    // Потолок обязателен даже там, где сотрудников десяток — см. hallOfFame.ts.
    take: 500,
  });
  if (!isAdmin || opts.telephony === false) return agents;
  // Директору к номеру добавляется состояние трубки. Запрос к АТС необязательный:
  // не ответила — список всё равно отдаём.
  const { statuses, problem: stationProblem } = await getExtensionStatuses();
  /**
   * «ПОЛУЧАЕТ ЛИ ЧЕЛОВЕК ОБЩИЕ ВХОДЯЩИЕ» (19.09.2026): номер выдан и трубка на
   * связи — ещё не значит, что станция станет ему звонить (очередь), см.
   * lib/telephony/agentIncomingReadiness.ts.
   */
  const readiness = (await checkIncomingReadiness().catch(() => null)) ?? {
    gaps: [],
    extra: [],
    problem: "АТС недоступна",
  };
  const gapIds = new Set(readiness.gaps.map((g) => g.agentId));
  // Кто получает незнакомые звонки, не будучи оператором (решение владельца 20.09.2026).
  const extraIds = new Set((readiness.extra ?? []).map((g) => g.agentId));
  return agents.map((a) => {
    const ext = "sipExtension" in a && typeof a.sipExtension === "string" ? a.sipExtension : null;
    return {
      ...a,
      // null — про трубку судить НЕЛЬЗЯ: станция не ответила (жалоба владельца 20.09.2026:
      // ложная тревога дороже отсутствия отметки).
      phoneOnline: ext ? (stationProblem ? null : (statuses.get(ext)?.online ?? false)) : null,
      incomingQueueReady: readiness.problem || !ext ? null : !gapIds.has(a.id),
      takesUnknownCallsUnexpected: readiness.problem || !ext ? null : extraIds.has(a.id),
    };
  });
}

/** Прошлые передачи дел сотрудника (GET /agents/:id/handovers) — последние пять. */
export function listStaffHandovers(agentId: string) {
  return prisma.agentHandoverBatch.findMany({
    where: { fromAgentId: agentId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      createdAt: true,
      clients: true,
      tasks: true,
      properties: true,
      deactivated: true,
      toAgentId: true,
      revertedAt: true,
      revertSummary: true,
    },
  });
}

/** Персональные права сотрудника (GET /agents/:id/permissions). */
export async function readStaffPermissions(agentId: string): Promise<StaffOutcome> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, fullName: true, role: true, permissions: true },
  });
  if (!agent) return fail(404, "Агент не найден");
  const role = agent.role as Role;
  const overrides = parsePermissionOverrides(agent.permissions);
  return done({
    agentId: agent.id,
    fullName: agent.fullName,
    role,
    roleSummary: ROLE_PRESET_SUMMARY[role],
    // Директор — владелец: у него всё включено и менять нечего.
    editable: role !== "DIRECTOR",
    overrides,
    items: describePermissions(role, overrides),
  });
}

// ───────────────────────────── создание ─────────────────────────────

export async function createStaffMember(actor: StaffActor, raw: unknown, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const parsed = agentCreateSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Неверные данные", { details: parsed.error.flatten() });
  const rest = parsed.data;
  if (await forbiddenDirectorTarget(actor, undefined, rest.role)) {
    return fail(403, "Создавать директора может только директор");
  }
  const roleDenied = forbiddenRoleGrant(actor, undefined, rest.role);
  if (roleDenied) return fail(403, roleDenied);

  const existing = await prisma.agent.findUnique({ where: { phone: rest.phone } });
  if (existing) return fail(409, "Агент с таким телефоном уже существует");

  // Внутренний номер выдаётся сам, если директор не вписал его вручную: сотрудник
  // должен иметь возможность звонить с первого дня (lib/telephony/extensionPool.ts).
  // Отказ телефонии тут не критичен — человек всё равно заводится.
  let sipExtension = rest.sipExtension ?? null;
  let extensionNote: string | undefined;
  if (!sipExtension) {
    const picked = await pickFreeExtension();
    sipExtension = picked.extension;
    extensionNote = picked.reason;
  } else {
    // Вписанный руками номер проверяется так же, как при правке карточки.
    const check = await checkManualExtension(sipExtension);
    if (!check.ok) return fail(409, check.error);
    extensionNote = check.warning;
  }

  // Паролей нет (19.10.2026): сотрудник входит по коду из СМС/пуша или отпечатком.
  const agent = await prisma.agent.create({ data: { ...rest, sipExtension } });
  // Заведение учётки — действие того же веса, что заморозка и смена прав (12.09.2026).
  audit(actor, opts, "AGENT_CREATE", agent.id, {
    fullName: agent.fullName,
    role: agent.role,
    sipExtension: agent.sipExtension,
  });
  // Новая учётка с правом раздавать права — всегда; рядовой сотрудник — только из помощницы.
  notice(actor, opts, "created", agent, `Роль: ${roleName(agent.role)}`, !(agent.role === "ADMIN" || agent.role === "DIRECTOR"));
  // Мобильное плечо и запись разговоров — сразу (agentMobileFallback.ts, extensionPool.ts).
  if (agent.sipExtension) void syncAgentMobileFallback(agent.id).catch(() => {});
  if (agent.sipExtension) void ensureExtensionRecording(agent.sipExtension).catch(() => {});
  /**
   * ТРЕТИЙ ШАГ — ОЧЕРЕДЬ ВХОДЯЩИХ, СРАЗУ И САМА (19.09.2026). Не вышло — не
   * ошибка заведения, но директору об этом говорим прямо в ответе.
   */
  if (agent.sipExtension && (SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) {
    const fix = await ensureAgentsInIncomingQueue().catch(() => null);
    const note = describeNewAgentQueueOutcome(
      { sipExtension: agent.sipExtension, takesUnknownCalls: agent.takesUnknownCalls },
      fix
    );
    if (note) extensionNote = extensionNote ? `${extensionNote}. ${note}` : note;
  }
  return done(
    {
      id: agent.id,
      fullName: agent.fullName,
      phone: agent.phone,
      role: agent.role,
      sipExtension: agent.sipExtension,
      // «Номер не выдан, потому что…» — молчаливое отсутствие номера выглядело бы как ошибка.
      extensionNote,
    },
    201
  );
}

// ───────────────────────────── правка ─────────────────────────────

export async function updateStaffMember(actor: StaffActor, targetId: string, raw: unknown, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const parsed = agentUpdateSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Неверные данные", { details: parsed.error.flatten() });
  const rest = parsed.data;
  // Несуществующий сотрудник — 404, а не P2025 из update ниже → 500 (24.09.2026, №152).
  const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { id: true, phone: true, role: true } });
  if (!target) return fail(404, "Сотрудник не найден");
  if (await forbiddenDirectorTarget(actor, targetId, rest.role)) {
    return fail(403, "Управлять учёткой директора может только директор");
  }
  if (await forbiddenPrivilegedTarget(actor, targetId)) return fail(403, PRIVILEGED_TARGET_ERROR);
  const roleDenied = forbiddenRoleGrant(actor, targetId, rest.role);
  if (roleDenied) return fail(403, roleDenied);
  if (await wouldLoseLastDirector(targetId, rest)) {
    return fail(409, "В системе должен остаться хотя бы один активный директор");
  }

  // Внутренний номер, вписанный руками, проверяется; null (снять номер) — законно.
  let extensionNote: string | undefined;
  if (typeof rest.sipExtension === "string") {
    const check = await checkManualExtension(rest.sipExtension, targetId);
    if (!check.ok) return fail(409, check.error);
    extensionNote = check.warning;
  }

  // Телефон — логин сотрудника и уникален (аудит 23.09.2026, №63).
  if (rest.phone) {
    const holder = await prisma.agent.findFirst({
      where: { phone: rest.phone, id: { not: targetId } },
      select: { fullName: true },
    });
    if (holder) return fail(409, `Этот телефон уже записан за сотрудником «${holder.fullName}»`);
  }

  // Отключение — переход «был активен → нет», а не повтор флага: лиды снимаем только в первый раз.
  const wasActive =
    rest.isActive === false
      ? (await prisma.agent.findUnique({ where: { id: targetId }, select: { isActive: true } }))?.isActive === true
      : false;

  const data: Record<string, unknown> = { ...rest };
  // Смена роли сбрасывает личные надстройки прав (G9, 02.10.2026); что снято — в журнал.
  let resetOverrides: { granted: string[]; revoked: string[] } | null = null;
  if (rest.role !== undefined) {
    const before = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true, permissions: true } });
    if (before && before.role !== rest.role && before.permissions !== null) {
      const old = parsePermissionOverrides(before.permissions);
      if (old.granted.length > 0 || old.revoked.length > 0) resetOverrides = old;
      data.permissions = Prisma.DbNull;
    }
  }

  const agent = await prisma.agent.update({ where: { id: targetId }, data });
  if (resetOverrides) {
    audit(actor, opts, "AGENT_PERMISSIONS_RESET_ON_ROLE_CHANGE", agent.id, {
      targetAgentName: agent.fullName,
      role: agent.role,
      granted: resetOverrides.granted,
      revoked: resetOverrides.revoked,
    });
  }
  // Роль и статус кэшируются на 15 секунд — сбрасываем сразу.
  invalidateAgentAccess(agent.id);
  // Живой поток помнит роль и права на момент открытия (№148).
  if (rest.role !== undefined || rest.isActive === false) {
    closeStreamsForAgent(agent.id);
  }
  // Отключение учётки обязано убить и сессии устройств.
  const deactivation = rest.isActive === false ? await finishAccountDeactivation(actor, agent, wasActive, opts) : null;
  // Активность или внутренний номер сменились — очередь входящих узнаёт сама (19.08.2026).
  if (rest.isActive !== undefined || rest.sipExtension !== undefined) {
    void syncAgentQueuePresence(agent.id).catch(() => {});
  }
  if (rest.sipExtension !== undefined || rest.phone !== undefined) {
    void syncAgentMobileFallback(agent.id).catch(() => {});
  }
  // Номер сменился — запись разговоров сразу (только когда номер пришёл В ЭТОЙ правке).
  if (typeof rest.sipExtension === "string") {
    void ensureExtensionRecording(rest.sipExtension).catch(() => {});
  }
  // Назначили или сняли оператора — состав очереди и мобильное плечо СРАЗУ (20.09.2026).
  if (rest.takesUnknownCalls !== undefined) {
    void ensureAgentsInIncomingQueue().catch(() => {});
    void syncAgentMobileFallback(targetId).catch(() => {});
  }
  if (rest.role !== undefined && rest.role !== target.role) {
    notice(actor, opts, "role", agent, `${roleName(target.role)} → ${roleName(agent.role)}${resetOverrides ? ", личные права сброшены" : ""}`);
  }
  if (rest.phone !== undefined && rest.phone !== target.phone) notice(actor, opts, "phone", agent, "Телефон — логин входа");
  if (rest.isActive === false && wasActive) {
    notice(actor, opts, "deactivated", agent, deactivation?.clientsLeft ? `Клиентов в работе за ним: ${deactivation.clientsLeft}` : undefined);
  }
  audit(actor, opts, "AGENT_UPDATE", agent.id, {
    fields: Object.keys(rest),
    // Выходные меняют раздачу лидов и штрафы агента — какие дни поставили, видно в журнале.
    ...(rest.weeklyDaysOff !== undefined ? { weeklyDaysOff: rest.weeklyDaysOff } : {}),
  });
  return done({
    id: agent.id,
    fullName: agent.fullName,
    phone: agent.phone,
    role: agent.role,
    isActive: agent.isActive,
    kpi: agent.kpi,
    sipExtension: agent.sipExtension,
    // Смена языка подсказки переозвучивается сама (lib/telephony/whisperSync.ts).
    whisperLanguage: agent.whisperLanguage,
    takesUnknownCalls: agent.takesUnknownCalls,
    sharePostTelegram: agent.sharePostTelegram,
    weeklyDaysOff: agent.weeklyDaysOff,
    // «Сохранили, но проверить номер на АТС не смогли» — предупреждение, а не отказ.
    extensionNote,
    ...(deactivation ?? {}),
  });
}

/**
 * Всё, что обязано случиться СРАЗУ после `isActive = false`, — в одном месте для
 * трёх входов: правка «отключить», «Передать дела» с галочкой «отключить учётку»
 * и удаление, упёршееся в историю. Лиды и предложения реактивации снимаются только
 * при переходе «был активен → нет».
 */
/**
 * Снять уволенного из Настроек и, если это был монтажёр, сразу поднять тревогу
 * «монтажёр не назначен» (решение владельца 11.11.2026: очередь монтажа не
 * должна стоять молча). Тревога — после записи настройки, не до.
 */
async function clearAgentFromSettingsAndAlarm(agentId: string, agentName: string, reason: "deactivate"): Promise<void> {
  alarmIfMontajerCleared(await clearAgentFromSettingsReferences(prisma, agentId, agentName, reason));
}

function alarmIfMontajerCleared(cleared: string[]): void {
  if (!cleared.includes("videoMontajerAgentId")) return;
  void alertNoMontajerIfWorkWaits().catch((err) =>
    console.error("[agents] тревога «монтажёр не назначен» не ушла:", err)
  );
}

async function finishAccountDeactivation(
  actor: StaffActor,
  agent: { id: string; fullName: string },
  wasActive: boolean,
  opts?: StaffCallOptions
): Promise<{ releasedLeads: number; clientsLeft: number } | null> {
  invalidateAgentAccess(agent.id);
  await revokeOtherSessions(agent.id);
  revokeElevation(agent.id);
  closeStreamsForAgent(agent.id);
  await prisma.pushSubscription.deleteMany({ where: { agentId: agent.id } });
  // Настройка не должна молча указывать на уволенного (24.09.2026, М12-в). Best-effort.
  if (wasActive) {
    await clearAgentFromSettingsAndAlarm(agent.id, agent.fullName, "deactivate").catch((err) =>
      console.error(`[agents] снятие уволенного ${agent.fullName} из Настроек не выполнено:`, err)
    );
  }
  return wasActive ? await releaseWorkOfDeactivatedAgent(actor, agent, opts) : null;
}

/**
 * ОТКЛЮЧЕНИЕ УЧЁТКИ НЕ БРОСАЕТ ЛИДЫ (23.09.2026, пункт 16): непринятые лиды —
 * в очередь тем же правилом, что при заморозке, предложения снимаются, клиентов в
 * работе отключение не трогает, но руководитель получает пуш, сколько их осталось.
 */
async function releaseWorkOfDeactivatedAgent(
  actor: StaffActor,
  agent: { id: string; fullName: string },
  opts?: StaffCallOptions
): Promise<{ releasedLeads: number; clientsLeft: number }> {
  const actorRow = await prisma.agent.findUnique({ where: { id: actor.id }, select: { fullName: true } });
  const actorName = actorRow?.fullName ?? "Неизвестно";
  const candidates = await findUnacceptedLeadsOfAgent(agent.id, "Отключение");
  // Снятыми считаются только реально снятые (CRM-03).
  let leads: ReleasableLead[] = [];
  if (candidates.length > 0) {
    await prisma.$transaction(async (tx) => {
      leads = await releaseLeadsToQueue(tx, candidates, {
        agentId: agent.id,
        actorId: actor.id,
        actorName,
        reason: `Учётка агента отключена руководителем ${actorName} — лид возвращён в очередь`,
        source: "deactivate",
      });
    });
  }
  await releaseReactivationOffersOfAgent(agent.id, actor.id).catch((err) =>
    console.error(`[reactivation] предложения отключённого агента ${agent.fullName} не сняты:`, err)
  );
  const clientsLeft = await prisma.client.count({
    where: {
      assignedAgentId: agent.id,
      deletedAt: null,
      acceptedAt: { not: null },
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
    },
  });
  audit(actor, opts, "AGENT_DEACTIVATE_RELEASE", agent.id, { releasedLeads: leads.length, clientsLeft });

  if (leads.length > 0 || clientsLeft > 0) {
    const directors = await prisma.agent.findMany({
      where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
      select: { id: true },
    });
    const parts = [
      leads.length > 0 ? `непринятых лидов возвращено в очередь: ${leads.length}` : null,
      clientsLeft > 0 ? `клиентов в работе осталось за ним: ${clientsLeft}, передайте дела` : null,
    ].filter(Boolean);
    await sendPushToAgents(
      directors.map((d) => d.id),
      {
        title: `Сотрудник отключён: ${agent.fullName}`,
        body: parts.join("; "),
        // Карточка отключённого сотрудника — там «Передать дела».
        url: `/team/${agent.id}`,
        tag: `agent-deactivate-${agent.id}`,
      }
    ).catch((err) => console.error("[agents] пуш руководству об отключении не отправлен:", err));
  }
  return { releasedLeads: leads.length, clientsLeft };
}

// ───────────────────────────── передача дел ─────────────────────────────

/**
 * Передача дел уходящего сотрудника: активные клиенты и задачи уходят выбранному
 * агенту или расходятся по команде обычным распределением. Отдельным действием, а не
 * побочным эффектом отключения: увольнение — не единственная причина.
 */
export async function handoverStaffWork(actor: StaffActor, fromId: string, raw: unknown, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const parsed = agentHandoverSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Неверные данные", { details: parsed.error.flatten() });
  // Учётка директора защищена от админа во ВСЕХ мутациях, включая передачу дел (06.08.2026).
  if (await forbiddenDirectorTarget(actor, fromId)) return fail(403, "Учётку директора может менять только директор");
  if (await forbiddenPrivilegedTarget(actor, fromId)) return fail(403, PRIVILEGED_TARGET_ERROR);
  const from = await prisma.agent.findUnique({ where: { id: fromId }, select: { id: true, fullName: true } });
  if (!from) return fail(404, "Сотрудник не найден");

  const { toAgentId, deactivate } = parsed.data;
  if (toAgentId === from.id) return fail(400, "Нельзя передать дела тому же сотруднику");
  if (toAgentId) {
    const to = await prisma.agent.findUnique({ where: { id: toAgentId }, select: { isActive: true, frozenAt: true, fullName: true } });
    if (!to) return fail(404, "Получатель не найден");
    if (!to.isActive) return fail(409, "Получатель отключён — выберите активного сотрудника");
    // Замороженному дела не передаются (B13, решение владельца 02.10.2026).
    if (to.frozenAt) {
      return fail(
        409,
        `${to.fullName} сейчас заморожен(а) (отпуск, больничный) — передать дела можно, когда заморозку снимут. Выберите другого сотрудника.`
      );
    }
  }
  // Отказы отключения — ДО раздачи, иначе руководитель остался бы с полупроделанной работой.
  if (deactivate) {
    if (from.id === actor.id) return fail(400, "Свою учётку отключить нельзя — попросите другого руководителя");
    if (await wouldLoseLastDirector(from.id, { isActive: false })) {
      return fail(409, "В системе должен остаться хотя бы один активный директор");
    }
  }

  const result = await handoverAgentWork(from.id, toAgentId, actor.id);
  audit(actor, opts, "AGENT_HANDOVER", from.id, {
    toAgentId: toAgentId ?? null,
    clients: result.clients,
    tasks: result.tasks,
    properties: result.properties,
    unassigned: result.unassigned,
    deactivate: Boolean(deactivate),
  });

  // ОТКЛЮЧЕНИЕ СРАЗУ ПОСЛЕ ПЕРЕДАЧИ (владелец 24.09.2026) — те же шаги, что у правки isActive=false.
  let deactivated = false;
  if (deactivate) {
    const before = await prisma.agent.findUnique({ where: { id: from.id }, select: { isActive: true } });
    const agent = await prisma.agent.update({ where: { id: from.id }, data: { isActive: false } });
    await finishAccountDeactivation(actor, agent, before?.isActive === true, opts);
    void syncAgentQueuePresence(agent.id).catch(() => {});
    audit(actor, opts, "AGENT_UPDATE", agent.id, { fields: ["isActive"], afterHandover: true });
    deactivated = true;
    notice(actor, opts, "deactivated", agent, "После передачи дел");
    // Снимок раздачи знает, что учётку отключили тем же нажатием, — возврат включит её обратно.
    if (result.batchId) {
      await prisma.agentHandoverBatch.update({ where: { id: result.batchId }, data: { deactivated: true } });
    }
  }
  notice(actor, opts, "handover", from, `Клиентов: ${result.clients}, задач: ${result.tasks}, объектов: ${result.properties}`, true);
  return done({ ...result, deactivated });
}

/**
 * ВЕРНУТЬ ВСЁ КАК БЫЛО (владелец 24.09.2026) — по снимку раздачи
 * (lib/agentHandoverRevert.ts); учётка, отключённая тем же нажатием, включается.
 */
export async function revertStaffHandover(actor: StaffActor, batchId: string, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const batch = await prisma.agentHandoverBatch.findUnique({
    where: { id: batchId },
    select: { id: true, fromAgentId: true, revertedAt: true, deactivated: true },
  });
  if (!batch) return fail(404, "Передача дел не найдена");
  if (batch.revertedAt) return fail(409, "Эта передача дел уже возвращена");
  if (await forbiddenDirectorTarget(actor, batch.fromAgentId)) return fail(403, "Учётку директора может менять только директор");
  if (await forbiddenPrivilegedTarget(actor, batch.fromAgentId)) return fail(403, PRIVILEGED_TARGET_ERROR);

  const outcome = await revertAgentHandover(batch.id, actor.id);
  if (!outcome.ok) {
    return outcome.reason === "not_found"
      ? fail(404, "Передача дел не найдена")
      : fail(409, "Эта передача дел уже возвращена");
  }
  if (outcome.result.reactivated) {
    // Права и очередь входящих обязаны узнать, что человек снова в строю.
    invalidateAgentAccess(batch.fromAgentId);
    void syncAgentQueuePresence(batch.fromAgentId).catch(() => {});
  }
  audit(actor, opts, "AGENT_HANDOVER_REVERT", batch.fromAgentId, { batchId: batch.id, ...outcome.result });
  return done(outcome.result as unknown as Record<string, unknown>);
}

// ───────────────────────────── второй фактор ─────────────────────────────

/** Аварийный сброс 2FA сотрудника (потерян телефон). Сессии гаснут — повод перезайти. */
export async function resetStaffTwoFactor(actor: StaffActor, targetId: string, opts?: StaffCallOptions): Promise<StaffOutcome> {
  // agents.reset2fa лежит в пресете ADMIN — без этой проверки админ снимал 2FA с владельца (24.09.2026).
  if (await forbiddenDirectorTarget(actor, targetId)) return fail(403, "Управлять учёткой директора может только директор");
  if (await forbiddenPrivilegedTarget(actor, targetId)) return fail(403, PRIVILEGED_TARGET_ERROR);
  const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { id: true, fullName: true } });
  if (!target) return fail(404, "Сотрудник не найден");
  await prisma.agent.update({ where: { id: target.id }, data: { totpEnabled: false, totpSecret: null } });
  await revokeOtherSessions(target.id);
  revokeElevation(target.id);
  logAgentAudit(actor.id, "TOTP_RESET_BY_DIRECTOR", "Agent", target.id, {
    targetName: target.fullName,
    ...(opts?.via ? { source: opts.via } : {}),
  });
  notice(actor, opts, "reset2fa", target);
  return done({ totpEnabled: false });
}

// ───────────────────────────── удаление ─────────────────────────────

export interface DeleteStaffBody {
  ok: true;
  handover: Awaited<ReturnType<typeof handoverAgentWork>>;
  deactivatedInsteadOfDeleted?: true;
  message?: string;
}

/**
 * СНАЧАЛА РАЗДАЁМ КЛИЕНТОВ, ПОТОМ УДАЛЯЕМ (10.08.2026): тем же механизмом, что
 * «Передача дел», без получателя — по очереди KPI. Раздача не откатывается, если
 * удаление потом упрётся в сделки или историю: тогда учётка отключается и телефон
 * освобождается (18.08.2026) — для владельца это и есть «удалил».
 */
export async function deleteStaffMember(actor: StaffActor, targetId: string, opts?: StaffCallOptions): Promise<StaffOutcome<DeleteStaffBody>> {
  if (targetId === actor.id) return fail(400, "Нельзя удалить собственную учётную запись");
  if (await forbiddenDirectorTarget(actor, targetId)) return fail(403, "Управлять учёткой директора может только директор");
  if (await forbiddenPrivilegedTarget(actor, targetId)) return fail(403, PRIVILEGED_TARGET_ERROR);

  const handover = await handoverAgentWork(targetId, undefined, actor.id);

  // Предложения реактивации — ДО удаления (07.09.2026, класс «осиротевшие спутники»).
  await releaseReactivationOffersOfAgent(targetId, actor.id).catch((err) =>
    console.error(`[reactivation] предложения уволенного агента ${targetId} не сняты:`, err)
  );

  // Журнал, который каскад унёс бы вместе со строкой, стирать нельзя (№195, lib/agentHistory.ts).
  if (await agentHasCascadeHistory(targetId)) {
    return disableInsteadOfDelete(actor, targetId, handover, "has history", opts);
  }

  try {
    const deleted = await prisma.agent.delete({ where: { id: targetId } });
    invalidateAgentAccess(deleted.id);
    closeStreamsForAgent(deleted.id);
    // Поля Настроек хранят id строкой, без внешнего ключа (G4, 02.10.2026).
    await clearAgentFromSettingsAndAlarm(deleted.id, deleted.fullName, "deactivate").catch((err) =>
      console.error(`[agents] снятие удалённого ${deleted.fullName} из Настроек не выполнено:`, err)
    );
    audit(actor, opts, "DELETE", deleted.id, {
      fullName: deleted.fullName,
      role: deleted.role,
      handoverClients: handover.clients,
      handoverProperties: handover.properties,
    });
    notice(actor, opts, "deleted", deleted, `Клиентов роздано: ${handover.clients}`);
    // 200 с отчётом, а не пустой 204: руководитель должен видеть, кому ушли клиенты.
    return done({ ok: true, handover });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return fail(404, "Агент не найден");
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      // Сделки и история держат строку: переписывать их на другого агента нельзя
      // (комиссия — снапшот того, кто заработал), поэтому отключаем и освобождаем телефон.
      return disableInsteadOfDelete(actor, targetId, handover, "has deals/properties/history", opts);
    }
    throw err;
  }
}

async function disableInsteadOfDelete(
  actor: StaffActor,
  agentId: string,
  handover: Awaited<ReturnType<typeof handoverAgentWork>>,
  reason: string,
  opts?: StaffCallOptions
): Promise<StaffOutcome<DeleteStaffBody>> {
  const current = await prisma.agent.findUnique({ where: { id: agentId }, select: { phone: true, isActive: true } });
  // Повторное «удалить» (двойное нажатие) не наслаивает метку второй раз.
  const freedPhone = current?.phone.startsWith(`${agentId}-deleted:`)
    ? current.phone
    : `${agentId}-deleted:${current?.phone}`;
  // Telegram отвязываем: учётки «нет», а привязанный чат продолжал бы получать
  // то, что шлётся по id, и не дал бы привязать тот же чат при повторном найме (G4/G16).
  const deactivated = await prisma.agent.update({
    where: { id: agentId },
    data: { isActive: false, phone: freedPhone, telegramChatId: null, telegramUserId: null },
  });
  invalidateAgentAccess(deactivated.id);
  await revokeOtherSessions(deactivated.id);
  revokeElevation(deactivated.id);
  closeStreamsForAgent(deactivated.id);
  // То же, что при отключении тумблером, кроме разбора лидов — его уже сделала раздача.
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  if (current?.isActive) {
    await clearAgentFromSettingsAndAlarm(agentId, deactivated.fullName, "deactivate").catch((err) =>
      console.error(`[agents] снятие удалённого ${deactivated.fullName} из Настроек не выполнено:`, err)
    );
  }
  void syncAgentQueuePresence(agentId).catch(() => {});
  logAgentAudit(actor.id, "UPDATE", "Agent", deactivated.id, {
    fullName: deactivated.fullName,
    deactivatedInsteadOfDeleted: true,
    reason,
    handoverClients: handover.clients,
    handoverProperties: handover.properties,
    ...(opts?.via ? { source: opts.via } : {}),
  });
  notice(actor, opts, "deleted", deactivated, "Есть история — учётка отключена, телефон освобождён");
  return done({
    ok: true,
    deactivatedInsteadOfDeleted: true,
    handover,
    message:
      `Клиенты и объекты переданы другим агентам (${handover.clients} клиентов, ${handover.properties} объектов). ` +
      "За сотрудником числятся сделки или история работы, поэтому строку целиком стереть нельзя — учётка отключена, " +
      "войти в неё больше нельзя, а телефон свободен для нового сотрудника.",
  });
}

// ───────────────────────────── права ─────────────────────────────

/**
 * Персональные права сотрудника (PUT /agents/:id/permissions). Раздавать может
 * директор и админ (14.09.2026); директору права не настраиваются (у него всё),
 * акционеру не добавляются (10.10.2026). normalizeOverrides чистит набор до записи.
 */
export async function setStaffPermissions(actor: StaffActor, targetId: string, raw: unknown, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const parsed = permissionOverridesSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Неверные данные", { details: parsed.error.flatten() });

  const agent = await prisma.agent.findUnique({
    where: { id: targetId },
    select: { id: true, fullName: true, role: true, permissions: true },
  });
  if (!agent) return fail(404, "Агент не найден");
  if (agent.role === "DIRECTOR") return fail(400, "У директора всегда полный доступ — права не настраиваются");
  if (agent.role === "SHAREHOLDER" && parsed.data.granted.length > 0) return fail(400, "Акционеру права не добавляются");

  const overrides = normalizeOverrides(agent.role as Role, parsed.data);
  const isEmpty = overrides.granted.length === 0 && overrides.revoked.length === 0;

  await prisma.agent.update({
    where: { id: agent.id },
    data: { permissions: isEmpty ? Prisma.DbNull : (overrides as unknown as Prisma.InputJsonObject) },
  });
  invalidateAgentAccess(agent.id);
  closeStreamsForAgent(agent.id);
  notice(actor, opts, "permissions", agent, describePermissionDiff(agent.role as Role, agent.permissions, overrides));
  audit(actor, opts, "AGENT_PERMISSIONS_UPDATE", agent.id, {
    targetAgentName: agent.fullName,
    role: agent.role,
    granted: overrides.granted,
    revoked: overrides.revoked,
  });
  return done({
    agentId: agent.id,
    role: agent.role as Role,
    overrides,
    items: describePermissions(agent.role as Role, overrides),
  });
}

// ───────────────────────────── заморозка ─────────────────────────────

/**
 * ЭКСТРЕННАЯ ЗАМОРОЗКА: человек работает в CRM, но новой работы не получает; KPI
 * замирает. Непринятые лиды уходят в очередь, лид по СВОЕМУ объекту остаётся
 * (10.10.2026, P0-5). Требования (PendingSummary) не гасятся — выбор за владельцем
 * (docs/TASKS.md, 22.09.2026).
 */
export async function freezeStaffMember(actor: StaffActor, targetId: string, raw: unknown, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const parsed = agentFreezeSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Неверные данные", { details: parsed.error.flatten() });
  const agent = await prisma.agent.findUnique({
    where: { id: targetId },
    select: { id: true, fullName: true, frozenAt: true },
  });
  if (!agent) return fail(404, "Сотрудник не найден");
  // Директора замораживает только директор (ACCESS-06).
  if (await forbiddenDirectorTarget(actor, agent.id)) return fail(403, "Учётку директора может менять только директор");
  if (await forbiddenPrivilegedTarget(actor, agent.id)) return fail(403, PRIVILEGED_TARGET_ERROR);
  if (agent.frozenAt) return fail(409, "Сотрудник уже заморожен");
  if (agent.id === actor.id) return fail(400, "Нельзя заморозить самого себя");
  if (parsed.data.until && parsed.data.until.getTime() < Date.now()) return fail(400, "Дата выхода уже прошла");

  const toRelease = await findUnacceptedLeadsOfAgent(agent.id, "Заморозка", { keepOwnProperty: true });
  const actorRow = await prisma.agent.findUnique({ where: { id: actor.id }, select: { fullName: true } });

  let releasedLeads: ReleasableLead[] = [];
  let frozenClearedFields: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({
      where: { id: agent.id },
      data: {
        frozenAt: new Date(),
        frozenById: actor.id,
        frozenReason: parsed.data.reason.trim(),
        frozenReasonVoiceUrl: parsed.data.reasonVoiceUrl ?? null,
        frozenReasonVoiceTranscript: parsed.data.reasonVoiceTranscript ?? null,
        // Вид и срок отсутствия (09.09.2026); срок снимет заморозку сам (lib/absenceReturn.ts).
        absenceKind: parsed.data.kind ?? null,
        absenceUntil: parsed.data.until ?? null,
        // Пауза, если она была, теряет смысл: заморозка строже и снимается иначе.
        leadsPausedUntil: null,
        leadsPausedById: null,
        leadsPausedReason: null,
      },
    });
    // Настройка не должна молча указывать на замороженного (24.09.2026, М12-в).
    frozenClearedFields = await clearAgentFromSettingsReferences(tx, agent.id, agent.fullName, "freeze");
    releasedLeads = await releaseLeadsToQueue(tx, toRelease, {
      agentId: agent.id,
      actorId: actor.id,
      actorName: actorRow?.fullName ?? "Неизвестно",
      reason: `Агент заморожен руководителем ${actorRow?.fullName ?? actor.id}: «${parsed.data.reason.trim()}» — лид возвращён в очередь`,
      source: "freeze",
    });
  });
  const released = { count: releasedLeads.length };
  alarmIfMontajerCleared(frozenClearedFields);

  closeStreamsForAgent(agent.id);
  audit(actor, opts, "AGENT_FREEZE", agent.id, { reason: parsed.data.reason, released: released.count });
  notice(actor, opts, "frozen", agent, `Причина: ${parsed.data.reason.trim().slice(0, 120)}`, true);

  if (releasedLeads.length > 0) {
    const directors = await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } });
    const names = releasedLeads.slice(0, 5).map((c) => c.fullName).join(", ");
    const more = releasedLeads.length > 5 ? ` и ещё ${releasedLeads.length - 5}` : "";
    await sendPushToAgents(
      directors.map((d) => d.id),
      {
        title: "Заморозка агента: лиды в очереди",
        body: `${agent.fullName}: ${releasedLeads.length} лид(ов) снято и возвращено в очередь — ${names}${more}`,
        url: "/team",
        tag: `agent-freeze-${agent.id}`,
      }
    ).catch((err) => console.error("[agents] пуш руководству о заморозке не отправлен:", err));
  }

  // «Предложение реактивации» держится за агента — замороженный решать по нему не может (07.09.2026).
  await releaseReactivationOffersOfAgent(agent.id, actor.id).catch((err) =>
    console.error(`[reactivation] предложения замороженного агента ${agent.fullName} не сняты:`, err)
  );

  void syncAgentQueuePresence(agent.id).catch(() => {});
  return done({ ok: true, released: released.count });
}

/** Разморозка: управленческое решение отдельной строкой журнала, а не «изменены поля». */
export async function unfreezeStaffMember(actor: StaffActor, targetId: string, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const agent = await prisma.agent.findUnique({ where: { id: targetId }, select: { id: true, frozenAt: true } });
  if (!agent) return fail(404, "Сотрудник не найден");
  // Те же две защиты, что и на заморозке (ACCESS-06).
  if (await forbiddenDirectorTarget(actor, agent.id)) return fail(403, "Учётку директора может менять только директор");
  if (await forbiddenPrivilegedTarget(actor, agent.id)) return fail(403, PRIVILEGED_TARGET_ERROR);
  if (!agent.frozenAt) return fail(409, "Сотрудник не заморожен");

  // Разморозка и сдвиг часов светофора — одной транзакцией (shiftInactiveClockAfterAbsence).
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({
      where: { id: agent.id },
      data: {
        frozenAt: null,
        frozenById: null,
        frozenReason: null,
        frozenReasonVoiceUrl: null,
        frozenReasonVoiceTranscript: null,
        // Вид и срок отсутствия живут ровно столько же, сколько сама заморозка.
        absenceKind: null,
        absenceUntil: null,
      },
    });
    await shiftInactiveClockAfterAbsence(agent.id, agent.frozenAt, new Date(), tx);
  });
  audit(actor, opts, "AGENT_UNFREEZE", agent.id, {});
  void syncAgentQueuePresence(agent.id).catch(() => {});
  return done({ ok: true });
}

// ───────────────────────────── пауза заявок ─────────────────────────────

/**
 * ПАУЗА ПРИЁМА ЛИДОВ ОТ РУКОВОДИТЕЛЯ (24.09.2026): человек на месте, текущие
 * клиенты остаются, KPI идёт. Без подтверждения личности — обратимо в один клик.
 */
export async function pauseStaffLeads(actor: StaffActor, targetId: string, raw: unknown, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const parsed = supervisorLeadPauseSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Неверные данные", { details: parsed.error.flatten() });
  const agent = await prisma.agent.findUnique({
    where: { id: targetId },
    select: { id: true, fullName: true, role: true, isActive: true, frozenAt: true },
  });
  if (!agent) return fail(404, "Сотрудник не найден");
  if (agent.id === actor.id) return fail(400, "Свою паузу включают в профиле");
  // Лиды раздаются только агентам — пауза остальным ничего бы не изменила.
  if (!(SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) return fail(400, "Лиды получают только агенты и руководитель продаж");
  if (!agent.isActive) return fail(409, "Сотрудник отключён");
  if (agent.frozenAt) return fail(409, "Сотрудник уже заморожен — лиды ему и так не идут");

  const actorRow = await prisma.agent.findUnique({ where: { id: actor.id }, select: { fullName: true } });
  const actorName = actorRow?.fullName ?? "Руководитель";
  // Своя пауза агента, если была, заменяется паузой руководителя с новым сроком.
  const until = new Date(Date.now() + parsed.data.hours * 3600_000);
  const reason = parsed.data.reason?.trim() || null;
  const { released } = await startLeadPause({
    agentId: agent.id,
    until,
    actor: { id: actor.id, fullName: actorName },
    bySupervisor: true,
    reason,
  });
  audit(actor, opts, "AGENT_LEAD_PAUSE_BY_SUPERVISOR", agent.id, {
    targetAgentName: agent.fullName,
    until: until.toISOString(),
    reason,
    released,
  });
  notifyAgentAboutSupervisorPause(agent.id, actorName, { until, reason });
  return done({ ok: true, pausedUntil: until, released });
}

/** Руководитель снимает паузу — любую: и свою, и поставленную самим агентом. */
export async function resumeStaffLeads(actor: StaffActor, targetId: string, opts?: StaffCallOptions): Promise<StaffOutcome> {
  const agent = await prisma.agent.findUnique({
    where: { id: targetId },
    select: { id: true, fullName: true, leadsPausedUntil: true, leadsPausedById: true, frozenAt: true },
  });
  if (!agent) return fail(404, "Сотрудник не найден");
  if (!availabilityOf(agent).pausedUntil) return fail(409, "Пауза не включена");

  await endLeadPause(agent);
  audit(actor, opts, "AGENT_LEAD_RESUME_BY_SUPERVISOR", agent.id, { targetAgentName: agent.fullName });
  const actorRow = await prisma.agent.findUnique({ where: { id: actor.id }, select: { fullName: true } });
  notifyAgentAboutSupervisorPause(agent.id, actorRow?.fullName ?? "Руководитель", null);
  return done({ ok: true });
}

// ───────────────────────────── откат роли ─────────────────────────────

/**
 * ВЕРНУТЬ РОЛЬ ВМЕСТЕ С ЛИЧНЫМИ ПРАВАМИ — ОДНОЙ ЗАПИСЬЮ (10.11.2026, ревью
 * безопасности). Смена роли сбрасывает личные надстройки прав (G9), поэтому откат
 * обязан вернуть обе вещи разом: две записи подряд при сбое второй оставляли бы
 * человека с прежней ролью, но без снятых с него прав — то есть с РАСШИРЕННЫМИ
 * правами. Здесь — одна транзакция с условием «роль всё ещё та, что поставили»,
 * те же защиты, что у правки роли (учётка директора, раздающий права, своя роль,
 * последний директор), журнал и сообщение руководству.
 */
export async function restoreStaffRole(
  actor: StaffActor,
  targetId: string,
  input: { expectedRole: string; role: string; permissions: unknown },
  opts?: StaffCallOptions
): Promise<StaffOutcome> {
  const role = agentUpdateSchema.shape.role.safeParse(input.role);
  if (!role.success || !role.data) return fail(400, "Неверные данные");
  if (!actor.can("permissions.manage")) return fail(403, "Возвращать права может только тот, у кого есть право раздавать права");
  const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { id: true, fullName: true, role: true } });
  if (!target) return fail(404, "Сотрудник не найден");
  if (await forbiddenDirectorTarget(actor, targetId, role.data)) return fail(403, "Управлять учёткой директора может только директор");
  if (await forbiddenPrivilegedTarget(actor, targetId)) return fail(403, PRIVILEGED_TARGET_ERROR);
  const roleDenied = forbiddenRoleGrant(actor, targetId, role.data);
  if (roleDenied) return fail(403, roleDenied);
  if (await wouldLoseLastDirector(targetId, { role: role.data })) {
    return fail(409, "В системе должен остаться хотя бы один активный директор");
  }
  const overrides = normalizeOverrides(role.data as Role, parsePermissionOverrides(input.permissions));
  const isEmpty = overrides.granted.length === 0 && overrides.revoked.length === 0;
  const written = await prisma.$transaction(async (tx) =>
    tx.agent.updateMany({
      where: { id: targetId, role: input.expectedRole as Role },
      data: { role: role.data as Role, permissions: isEmpty ? Prisma.DbNull : (overrides as unknown as Prisma.InputJsonObject) },
    })
  );
  if (written.count === 0) return fail(409, "Роль уже изменили — откат затёр бы чужую правку");
  invalidateAgentAccess(targetId);
  closeStreamsForAgent(targetId);
  void syncAgentQueuePresence(targetId).catch(() => {});
  audit(actor, opts, "AGENT_ROLE_RESTORE", targetId, {
    fromRole: input.expectedRole,
    role: role.data,
    granted: overrides.granted,
    revoked: overrides.revoked,
  });
  notice(actor, opts, "role", target, `${roleName(input.expectedRole)} → ${roleName(role.data)}, личные права возвращены`);
  return done({ agentId: targetId, role: role.data, overrides });
}
