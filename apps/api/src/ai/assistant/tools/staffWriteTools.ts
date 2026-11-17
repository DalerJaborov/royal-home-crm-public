import { z } from "zod";
import {
  ABSENCE_KIND_LABELS,
  ABSENCE_KINDS,
  agentUpdateSchema,
  isPermissionId,
  isReadOnlyRole,
  normalizeOverrides,
  parsePermissionOverrides,
  PERMISSIONS,
  resolvePermissions,
  ROLE_LABELS,
  ROLE_PRESETS,
  ROLES,
  type PermissionId,
  type PermissionOverrides,
  type Role,
} from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { loadAgentAccess } from "../../../auth/middleware.js";
import {
  AssistantActionError,
  type AssistantActionActor,
  type AssistantActionExecutor,
  type AssistantActionPreview,
  type AssistantActionSnapshot,
} from "../../../lib/assistantActions.js";
import { runAsActor } from "../../../lib/requestActor.js";
import { logSystemError } from "../../../lib/systemError.js";
import { describeError } from "../../../lib/describeError.js";
import {
  createStaffMember,
  deleteStaffMember,
  forbiddenDirectorTarget,
  forbiddenPrivilegedTarget,
  forbiddenRoleGrant,
  freezeStaffMember,
  handoverStaffWork,
  pauseStaffLeads,
  PRIVILEGED_TARGET_ERROR,
  resetStaffTwoFactor,
  restoreStaffRole,
  resumeStaffLeads,
  revertStaffHandover,
  setStaffPermissions,
  unfreezeStaffMember,
  updateStaffMember,
  wouldLoseLastDirector,
  type StaffActor,
  type StaffOutcome,
} from "../../../lib/staffAdmin.js";
import { maskStaffPhone } from "./staffPrivacy.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";
import type { AssistantActor } from "../actor.js";
import type { StaffToolName } from "./staffToolNames.js";

/**
 * СОТРУДНИКИ И ПРАВА ЧЕРЕЗ ПОМОЩНИЦУ (10.11.2026, владелец: «все возможности
 * директора вплоть от создания или удаления работников и изменения прав»).
 *
 * НИ ОДНОЙ СВОЕЙ ЗАПИСИ: каждое исполнение — функция lib/staffAdmin.ts, та же,
 * что у маршрута раздела «Команда» (routes/agents.ts). Здесь только карточка
 * «было → станет», снимок для STALE и сообщение директорам.
 *
 * ГРАНИЦА ВХОДА — КАК У REST:
 *  - право маршрута (`requires`, брокер + повторная проверка здесь по свежим правам);
 *  - всё, что в REST стоит за requireElevation, помечено `stepUp`: в Telegram —
 *    только после кода Google Authenticator этого нажатия (telegram/assistantStepUp.ts),
 *    в CRM — окно подтверждения личности; пароль в чат не принимается никогда;
 *  - только личка (`privateTelegram`), в группе инструменты ещё и скрыты
 *    (GROUP_HIDDEN_TOOLS), и чтение тоже;
 *  - акционер (только чтение) — отказ.
 * Правила по данным (учётка директора, раздающий права, последний директор, себя не
 * удалить и не заморозить) — внутри lib, поэтому совпадают с REST дословно.
 */

const AGENT_ID = z.string().trim().min(1).max(64);

const TARGET_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  role: true,
  isActive: true,
  sipExtension: true,
  instagramUsername: true,
  takesUnknownCalls: true,
  sharePostTelegram: true,
  whisperLanguage: true,
  weeklyDaysOff: true,
  frozenAt: true,
  absenceKind: true,
  absenceUntil: true,
  leadsPausedUntil: true,
  leadsPausedById: true,
  permissions: true,
  totpEnabled: true,
} as const;

type TargetRow = NonNullable<Awaited<ReturnType<typeof loadTarget>>>;

function loadTarget(id: string) {
  return prisma.agent.findUnique({ where: { id }, select: TARGET_SELECT });
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** Снимок учётки: любая чужая правка между карточкой и нажатием — STALE. */
function targetSnapshot(row: TargetRow | null): AssistantActionSnapshot {
  if (!row) return { exists: false };
  return {
    exists: true,
    id: row.id,
    fullName: row.fullName,
    phone: row.phone,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    sipExtension: row.sipExtension,
    instagramUsername: row.instagramUsername,
    takesUnknownCalls: row.takesUnknownCalls,
    sharePostTelegram: row.sharePostTelegram,
    whisperLanguage: row.whisperLanguage,
    weeklyDaysOff: row.weeklyDaysOff,
    frozenAt: iso(row.frozenAt),
    absenceKind: row.absenceKind,
    absenceUntil: iso(row.absenceUntil),
    leadsPausedUntil: iso(row.leadsPausedUntil),
    permissions: parsePermissionOverrides(row.permissions),
    totpEnabled: row.totpEnabled,
  };
}

const roleLabel = (role: string) => ROLE_LABELS[role as Role] ?? role;
const personLabel = (row: { fullName: string; role: string }) => `${plainField(row.fullName, 80) ?? "—"} (${roleLabel(row.role)})`;
const permissionLabel = (id: string) => PERMISSIONS.find((p) => p.id === id)?.label ?? id;
const yesNo = (value: boolean) => (value ? "да" : "нет");

/**
 * Свежие права нажавшего — как requireAuth + requirePermission на маршруте: учётка
 * активна, не акционер, каждое право маршрута есть. StaffActor для lib — оттуда же.
 */
async function staffActorOf(actor: AssistantActionActor, requires: readonly PermissionId[]): Promise<StaffActor> {
  const access = await loadAgentAccess(actor.agentId, prisma);
  if (!access || !access.isActive) throw new AssistantActionError(403, "FORBIDDEN", "Ваша учётка отключена");
  if (isReadOnlyRole(access.role)) throw new AssistantActionError(403, "READ_ONLY_ROLE", "Режим просмотра: изменения недоступны");
  for (const permission of requires) {
    if (!access.permissions.has(permission) || !actor.can(permission)) {
      throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на это действие");
    }
  }
  return { id: actor.agentId, role: access.role, can: (permission) => access.permissions.has(permission) };
}

const CODE_BY_STATUS: Record<number, string> = { 400: "BAD_REQUEST", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT" };

function failed(outcome: Extract<StaffOutcome<unknown>, { ok: false }>): AssistantActionError {
  return new AssistantActionError(outcome.status, CODE_BY_STATUS[outcome.status] ?? "FAILED", outcome.body.error);
}

function unwrap<T>(outcome: StaffOutcome<T>): T {
  if (!outcome.ok) throw failed(outcome);
  return outcome.body;
}

/** Те же два отказа по учётке, что во всех мутациях REST, — заранее, чтобы не показывать карточку впустую. */
async function assertTargetManageable(staff: StaffActor, target: TargetRow | null, directorMessage = "Учётку директора может менять только директор"): Promise<TargetRow> {
  if (!target || target.phone.includes("-deleted:")) throw new AssistantActionError(404, "NOT_FOUND", "Сотрудник не найден");
  if (await forbiddenDirectorTarget(staff, target.id)) throw new AssistantActionError(403, "FORBIDDEN", directorMessage);
  if (await forbiddenPrivilegedTarget(staff, target.id)) throw new AssistantActionError(403, "FORBIDDEN", PRIVILEGED_TARGET_ERROR);
  return target;
}

const run = <T>(actor: AssistantActionActor, work: () => Promise<T>) => runAsActor(actor.agentId, work);
/** Метка для журнала и сообщения руководству (оно уходит из lib/staffAdmin.ts — одной дверью с REST). */
const via = (actor: AssistantActionActor) => ({ via: "assistant" as const, channel: actor.channel });

interface StaffToolSpec<A> {
  name: StaffToolName;
  statusPhrase: string;
  description: string;
  parameters: Record<string, unknown>;
  requires: readonly PermissionId[];
  stepUp: boolean;
  schema: z.ZodType<A>;
  snapshot: (args: A) => Promise<AssistantActionSnapshot>;
  preview: (args: A, snap: AssistantActionSnapshot, staff: StaffActor, actor: AssistantActionActor) => Promise<AssistantActionPreview>;
  execute: (args: A, staff: StaffActor, actor: AssistantActionActor, snap: AssistantActionSnapshot) => Promise<{ result: unknown; entityId?: string | null }>;
  undo?: AssistantActionExecutor<A>["undo"];
  allowed: (actor: AssistantActor) => boolean;
}

function staffTool<A>(spec: StaffToolSpec<A>): AssistantWriteToolPlugin {
  const executor: AssistantActionExecutor<A> = {
    tool: spec.name,
    requires: spec.requires,
    channels: ["crm", "telegram"],
    privateTelegram: true,
    ...(spec.stepUp ? { stepUp: true as const } : {}),
    parseArgs: (raw) => spec.schema.parse(raw),
    async snapshot(args, actor) {
      await staffActorOf(actor, spec.requires);
      return spec.snapshot(args);
    },
    async buildPreview(args, snap, actor) {
      const staff = await staffActorOf(actor, spec.requires);
      return spec.preview(args, snap, staff, actor);
    },
    async execute(args, actor, ctx) {
      const staff = await staffActorOf(actor, spec.requires);
      const done = await run(actor, () => spec.execute(args, staff, actor, ctx.snapshotBefore));
      return { result: done.result, audit: { entityType: "Agent", entityId: done.entityId ?? null } };
    },
    ...(spec.undo ? { undo: spec.undo } : {}),
  };
  return {
    name: spec.name,
    level: "C",
    statusPhrase: spec.statusPhrase,
    description: spec.description,
    parameters: spec.parameters,
    allowed: (actor) => actor.surface !== "telegram-group" && !isReadOnlyRole(actor.role) && spec.allowed(actor),
    executor: executor as never,
  };
}

const has = (actor: AssistantActor, permission: PermissionId) => actor.permissions?.has(permission) ?? false;
const STEP_UP_NOTE = " Нужен код из Google Authenticator (в CRM — подтверждение личности).";

// ───────────────────────────── создать ─────────────────────────────

const createArgs = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(5).max(32),
  role: z.enum(ROLES),
  email: z.string().trim().email().optional(),
  sipExtension: z.string().trim().regex(/^\d{3,5}$/).optional(),
});

export const createStaffTool = staffTool({
  name: "create_staff",
  statusPhrase: "Готовлю карточку нового сотрудника…",
  description:
    "Завести нового сотрудника (учётку CRM): имя, телефон-логин, роль. Зови, когда директор просит добавить/принять на работу " +
    "сотрудника. Роль — одна из: " + ROLES.map((r) => `${r} (${roleLabel(r)})`).join(", ") + ". Если роль или телефон не названы — " +
    "сначала спроси. Инструмент ничего не меняет сам: карточка «было → станет», исполняет человек кнопкой." + STEP_UP_NOTE,
  parameters: {
    type: "object",
    properties: {
      fullName: { type: "string", description: "Имя и фамилия" },
      phone: { type: "string", description: "Телефон, по нему сотрудник входит в CRM" },
      role: { type: "string", enum: [...ROLES] },
      email: { type: "string" },
      sipExtension: { type: "string", description: "Внутренний номер, если назван; иначе CRM выдаст сама" },
    },
    required: ["fullName", "phone", "role"],
  },
  requires: ["agents.manage"],
  stepUp: true,
  schema: createArgs,
  async snapshot(args) {
    const taken = await prisma.agent.findUnique({ where: { phone: args.phone }, select: { id: true } });
    return { phoneTaken: taken !== null };
  },
  async preview(args, snap, staff) {
    if (await forbiddenDirectorTarget(staff, undefined, args.role)) throw new AssistantActionError(403, "FORBIDDEN", "Создавать директора может только директор");
    const roleDenied = forbiddenRoleGrant(staff, undefined, args.role);
    if (roleDenied) throw new AssistantActionError(403, "FORBIDDEN", roleDenied);
    if (snap.phoneTaken) throw new AssistantActionError(409, "CONFLICT", "Агент с таким телефоном уже существует");
    return {
      title: `👤 Новый сотрудник: ${plainField(args.fullName, 80)}`,
      was: { Сотрудник: "нет в CRM" },
      becomes: {
        Имя: plainField(args.fullName, 80),
        Телефон: args.phone,
        Роль: roleLabel(args.role),
        "Внутр. номер": args.sipExtension ?? "выдаст CRM",
        ...(args.email ? { Почта: args.email } : {}),
      },
      risk: `Войдёт по коду на этот телефон. Права — по роли «${roleLabel(args.role)}».`,
    };
  },
  async execute(args, staff, actor) {
    const body = unwrap(await createStaffMember(staff, args, via(actor))) as { id: string; fullName: string; extensionNote?: string };
    return { result: { agentId: body.id, fullName: body.fullName, href: `/team/${body.id}`, note: body.extensionNote ?? null }, entityId: body.id };
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

// ───────────────────────────── изменить ─────────────────────────────

const updateChanges = agentUpdateSchema.strict().refine((v) => Object.keys(v).length > 0, "Нечего менять");
const updateArgs = z.object({ agentId: AGENT_ID, changes: updateChanges });

const FIELD_LABELS: Record<string, string> = {
  fullName: "Имя",
  phone: "Телефон",
  email: "Почта",
  role: "Роль",
  isActive: "Учётка включена",
  sipExtension: "Внутр. номер",
  instagramUsername: "Instagram",
  takesUnknownCalls: "Принимает незнакомые звонки",
  sharePostTelegram: "Посты в Telegram",
  whisperLanguage: "Язык подсказки",
  weeklyDaysOff: "Выходные",
};
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function fieldValue(field: string, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "role") return roleLabel(String(value));
  if (typeof value === "boolean") return yesNo(value);
  if (field === "weeklyDaysOff" && Array.isArray(value)) return value.length ? value.map((d) => WEEKDAYS[Number(d)] ?? d).join(", ") : "нет";
  if (field === "fullName") return plainField(String(value), 80);
  return value;
}

export const updateStaffTool = staffTool({
  name: "update_staff",
  statusPhrase: "Готовлю изменения сотрудника…",
  description:
    "Изменить карточку сотрудника: имя, телефон, почту, роль, внутренний номер, Instagram, выходные (0 — воскресенье), " +
    "«принимает незнакомые звонки», отключить (isActive=false) или включить обратно учётку. agentId — из list_staff/get_staff_card. " +
    "Передавай в changes ТОЛЬКО то, что просили поменять. Отдела в CRM нет — так и скажи. Права по одному — set_staff_permissions." + STEP_UP_NOTE,
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      changes: {
        type: "object",
        properties: {
          fullName: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          role: { type: "string", enum: [...ROLES] },
          isActive: { type: "boolean" },
          sipExtension: { type: "string", nullable: true },
          instagramUsername: { type: "string", nullable: true },
          takesUnknownCalls: { type: "boolean" },
          sharePostTelegram: { type: "boolean" },
          weeklyDaysOff: { type: "array", items: { type: "integer" } },
        },
      },
    },
    required: ["agentId", "changes"],
  },
  requires: ["agents.manage"],
  stepUp: true,
  schema: updateArgs,
  snapshot: async (args) => targetSnapshot(await loadTarget(args.agentId)),
  async preview(args, _snap, staff) {
    const target = await assertTargetManageable(staff, await loadTarget(args.agentId), "Управлять учёткой директора может только директор");
    const changes = args.changes as Record<string, unknown>;
    if (await forbiddenDirectorTarget(staff, target.id, changes.role as string | undefined)) {
      throw new AssistantActionError(403, "FORBIDDEN", "Управлять учёткой директора может только директор");
    }
    const roleDenied = forbiddenRoleGrant(staff, target.id, changes.role as string | undefined);
    if (roleDenied) throw new AssistantActionError(403, "FORBIDDEN", roleDenied);
    if (await wouldLoseLastDirector(target.id, changes as { role?: string; isActive?: boolean })) {
      throw new AssistantActionError(409, "LAST_DIRECTOR", "В системе должен остаться хотя бы один активный директор");
    }
    const current = target as unknown as Record<string, unknown>;
    const was: Record<string, unknown> = {};
    const becomes: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(changes)) {
      const label = FIELD_LABELS[field] ?? field;
      // Прежний телефон и почта — не для модели и не для чата: только хвост (staffPrivacy.ts).
      was[label] = field === "phone" || field === "email" ? maskStaffPhone(String(current[field] ?? "")) : fieldValue(field, current[field]);
      becomes[label] = fieldValue(field, value);
    }
    const deactivating = changes.isActive === false && target.isActive;
    const roleChange = changes.role !== undefined && changes.role !== target.role;
    const roleOnly = Object.keys(changes).every((key) => key === "role");
    const risk = [
      deactivating ? "Учётка отключится сразу: вход, сессии и пуши гаснут, непринятые лиды уйдут в очередь. Клиенты в работе останутся за ним — передайте дела отдельно." : null,
      roleChange ? "Права станут как у новой роли; личные надстройки прав сбросятся." : null,
      roleChange && roleOnly ? "Отменить можно 15 минут — роль и личные права вернутся." : null,
      deactivating || roleChange || changes.phone !== undefined ? "Руководству придёт одно сообщение об этом." : null,
    ].filter(Boolean).join(" ");
    return {
      title: `${deactivating ? "🚫" : "👤"} ${plainField(target.fullName, 80)}: ${deactivating ? "отключить учётку" : "изменить"}`,
      was,
      becomes,
      ...(risk ? { risk } : {}),
      // Откатывается только смена одной роли; отключение и прочие поля — нет (их хвосты не возвращаются).
      ...(roleOnly && roleChange ? {} : { irreversible: true }),
    };
  },
  async execute(args, staff, actor) {
    const body = unwrap(await updateStaffMember(staff, args.agentId, args.changes, via(actor))) as { id: string; fullName: string; role: string; isActive: boolean; releasedLeads?: number; clientsLeft?: number };
    return {
      result: { agentId: body.id, fullName: body.fullName, href: `/team/${body.id}`, releasedLeads: body.releasedLeads ?? 0, clientsLeft: body.clientsLeft ?? 0 },
      entityId: body.id,
    };
  },
  /** Откат роли: прежняя роль и прежние личные права (смена роли их сбрасывала). */
  async undo(args, actor, ctx) {
    const staff = await staffActorOf(actor, ["agents.manage", "permissions.manage"]);
    const before = ctx.snapshotBefore;
    if (Object.keys(args.changes).some((key) => key !== "role")) {
      throw new AssistantActionError(409, "NOT_UNDOABLE", "Отменяется только смена роли");
    }
    // Роль и личные права — одной записью (lib/staffAdmin.ts::restoreStaffRole): сбой
    // посередине не должен оставлять прежнюю роль без снятых прав.
    const after = ctx.snapshotAfter;
    await run(actor, async () =>
      unwrap(await restoreStaffRole(staff, args.agentId, { expectedRole: String(after.role), role: String(before.role), permissions: before.permissions }, via(actor)))
    );
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

// ───────────────────────────── удалить ─────────────────────────────

const targetArgs = z.object({ agentId: AGENT_ID });

async function activeClientsOf(agentId: string): Promise<number> {
  return prisma.client.count({ where: { assignedAgentId: agentId, deletedAt: null, status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] } } });
}

export const deleteStaffTool = staffTool({
  name: "delete_staff",
  statusPhrase: "Готовлю удаление сотрудника…",
  description:
    "Удалить сотрудника из CRM. Его клиенты и объекты сначала раздаются команде по KPI; если за ним есть сделки или история, " +
    "учётка отключается, а телефон освобождается. Своя учётка не удаляется. Если директор хочет лишь закрыть вход — это " +
    "update_staff с isActive=false; передать дела конкретному человеку — handover_staff_work." + STEP_UP_NOTE,
  parameters: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
  requires: ["agents.manage"],
  stepUp: true,
  schema: targetArgs,
  snapshot: async (args) => ({ ...targetSnapshot(await loadTarget(args.agentId)), activeClients: await activeClientsOf(args.agentId) }),
  async preview(args, snap, staff) {
    if (args.agentId === staff.id) throw new AssistantActionError(400, "SELF", "Нельзя удалить собственную учётную запись");
    const target = await assertTargetManageable(staff, await loadTarget(args.agentId), "Управлять учёткой директора может только директор");
    return {
      title: `🗑 Удалить сотрудника: ${personLabel(target)}`,
      was: { Сотрудник: personLabel(target), "Клиентов в работе": snap.activeClients },
      becomes: { Сотрудник: "удалён", Клиенты: "раздаются команде по KPI" },
      risk: "Если за ним есть сделки или история — учётка отключится, телефон освободится. Руководству придёт одно сообщение.",
      irreversible: true,
    };
  },
  async execute(args, staff, actor, snap) {
    const body = unwrap(await deleteStaffMember(staff, args.agentId, via(actor)));
    return {
      result: {
        fullName: snap.fullName,
        deactivatedInsteadOfDeleted: body.deactivatedInsteadOfDeleted === true,
        clients: body.handover.clients,
        properties: body.handover.properties,
      },
      entityId: args.agentId,
    };
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

// ───────────────────────────── заморозить / разморозить ─────────────────────────────

const freezeArgs = z.object({
  agentId: AGENT_ID,
  reason: z.string().trim().min(3).max(500),
  kind: z.enum(ABSENCE_KINDS).optional(),
  until: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const freezeStaffTool = staffTool({
  name: "freeze_staff",
  statusPhrase: "Готовлю заморозку…",
  description:
    "Заморозить сотрудника (отпуск VACATION, больничный SICK, прочее OTHER): новые лиды ему не идут, непринятые уходят в очередь, " +
    "KPI замирает. Причина обязательна — спроси, если не названа. until — дата выхода ГГГГ-ММ-ДД, если названа. Себя заморозить нельзя." + STEP_UP_NOTE,
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      reason: { type: "string" },
      kind: { type: "string", enum: [...ABSENCE_KINDS] },
      until: { type: "string", description: "ГГГГ-ММ-ДД" },
    },
    required: ["agentId", "reason"],
  },
  requires: ["agents.manage"],
  stepUp: true,
  schema: freezeArgs,
  snapshot: async (args) => targetSnapshot(await loadTarget(args.agentId)),
  async preview(args, _snap, staff) {
    const target = await assertTargetManageable(staff, await loadTarget(args.agentId));
    if (target.frozenAt) throw new AssistantActionError(409, "CONFLICT", "Сотрудник уже заморожен");
    if (target.id === staff.id) throw new AssistantActionError(400, "SELF", "Нельзя заморозить самого себя");
    return {
      title: `❄️ Заморозить: ${personLabel(target)}`,
      was: { Статус: "работает" },
      becomes: {
        Статус: args.kind ? ABSENCE_KIND_LABELS[args.kind] : "заморожен",
        Причина: plainField(args.reason, 200),
        ...(args.until ? { "Выход": args.until } : {}),
      },
      risk: "Новые лиды не пойдут, непринятые уйдут в очередь (лиды по его объектам останутся). Отменить — 15 минут (снятые лиды в очереди останутся), позже — «разморозь».",
    };
  },
  async execute(args, staff, actor, snap) {
    const body = unwrap(await freezeStaffMember(staff, args.agentId, args, via(actor))) as { released: number };
    return { result: { fullName: snap.fullName, releasedLeads: body.released }, entityId: args.agentId };
  },
  /** Откат — разморозка (REST разрешает); снятые лиды остаются в очереди, это сказано в карточке. */
  async undo(args, actor) {
    const staff = await staffActorOf(actor, ["agents.manage"]);
    await run(actor, async () => unwrap(await unfreezeStaffMember(staff, args.agentId, via(actor))));
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

export const unfreezeStaffTool = staffTool({
  name: "unfreeze_staff",
  statusPhrase: "Готовлю разморозку…",
  description: "Разморозить сотрудника: снова получает лиды и звонки." + STEP_UP_NOTE,
  parameters: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
  requires: ["agents.manage"],
  stepUp: true,
  schema: targetArgs,
  snapshot: async (args) => targetSnapshot(await loadTarget(args.agentId)),
  async preview(args, _snap, staff) {
    const target = await assertTargetManageable(staff, await loadTarget(args.agentId));
    if (!target.frozenAt) throw new AssistantActionError(409, "CONFLICT", "Сотрудник не заморожен");
    return {
      title: `✅ Разморозить: ${personLabel(target)}`,
      was: { Статус: target.absenceKind ? ABSENCE_KIND_LABELS[target.absenceKind as keyof typeof ABSENCE_KIND_LABELS] : "заморожен" },
      becomes: { Статус: "работает" },
    };
  },
  async execute(args, staff, actor, snap) {
    unwrap(await unfreezeStaffMember(staff, args.agentId, via(actor)));
    return { result: { fullName: snap.fullName }, entityId: args.agentId };
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

// ───────────────────────────── передача дел ─────────────────────────────

const handoverArgs = z.object({ agentId: AGENT_ID, toAgentId: z.guid().optional(), deactivate: z.boolean().optional() });

export const handoverStaffWorkTool = staffTool({
  name: "handover_staff_work",
  statusPhrase: "Готовлю передачу дел…",
  description:
    "Передать ВСЕ дела сотрудника (клиенты в работе, задачи, объекты): конкретному коллеге (toAgentId) или без получателя — " +
    "по команде по KPI. deactivate=true — сразу отключить его учётку (увольнение). Вернуть как было — revert_staff_handover. " +
    "Одного клиента передаёт change_client_agent, один объект — transfer_property." + STEP_UP_NOTE,
  parameters: {
    type: "object",
    properties: { agentId: { type: "string", description: "Чьи дела" }, toAgentId: { type: "string", description: "Кому; пусто — по команде" }, deactivate: { type: "boolean" } },
    required: ["agentId"],
  },
  requires: ["agents.manage"],
  stepUp: true,
  schema: handoverArgs,
  snapshot: async (args) => ({
    from: targetSnapshot(await loadTarget(args.agentId)),
    to: args.toAgentId ? targetSnapshot(await loadTarget(args.toAgentId)) : null,
    activeClients: await activeClientsOf(args.agentId),
  }),
  async preview(args, snap, staff) {
    const from = await assertTargetManageable(staff, await loadTarget(args.agentId));
    if (args.toAgentId === from.id) throw new AssistantActionError(400, "BAD_REQUEST", "Нельзя передать дела тому же сотруднику");
    let toLabel = "команде по KPI";
    if (args.toAgentId) {
      const to = await loadTarget(args.toAgentId);
      if (!to) throw new AssistantActionError(404, "NOT_FOUND", "Получатель не найден");
      if (!to.isActive) throw new AssistantActionError(409, "CONFLICT", "Получатель отключён — выберите активного сотрудника");
      if (to.frozenAt) throw new AssistantActionError(409, "CONFLICT", `${plainField(to.fullName, 80)} сейчас заморожен(а) — выберите другого сотрудника.`);
      toLabel = personLabel(to);
    }
    if (args.deactivate) {
      if (from.id === staff.id) throw new AssistantActionError(400, "SELF", "Свою учётку отключить нельзя — попросите другого руководителя");
      if (await wouldLoseLastDirector(from.id, { isActive: false })) {
        throw new AssistantActionError(409, "LAST_DIRECTOR", "В системе должен остаться хотя бы один активный директор");
      }
    }
    return {
      title: `📦 Передать дела: ${personLabel(from)} → ${toLabel}`.slice(0, 200),
      was: { "Дела у": personLabel(from), "Клиентов в работе": snap.activeClients },
      becomes: { "Дела у": toLabel, ...(args.deactivate ? { "Учётка": "отключена" } : {}) },
      risk: `Клиенты, задачи и объекты уйдут сразу. Вернуть можно просьбой «верни дела».${args.deactivate ? " Руководству придёт одно сообщение об отключении." : ""}`,
    };
  },
  async execute(args, staff, actor) {
    const body = unwrap(await handoverStaffWork(staff, args.agentId, { toAgentId: args.toAgentId, deactivate: args.deactivate }, via(actor))) as {
      clients: number; tasks: number; properties: number; batchId?: string | null; deactivated: boolean;
    };
    return {
      result: { clients: body.clients, tasks: body.tasks, properties: body.properties, batchId: body.batchId ?? null, deactivated: body.deactivated },
      entityId: args.agentId,
    };
  },
  /** Откат — тот же «Вернуть всё как было» (revert_staff_handover / REST), по снимку раздачи. */
  async undo(_args, actor, ctx) {
    const staff = await staffActorOf(actor, ["agents.manage"]);
    const batchId = (ctx.result as { batchId?: string | null } | null)?.batchId;
    if (!batchId) throw new AssistantActionError(409, "NOT_UNDOABLE", "Передавать было нечего — возвращать тоже");
    await run(actor, async () => unwrap(await revertStaffHandover(staff, batchId, via(actor))));
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

const revertArgs = z.object({ batchId: z.string().trim().min(1).max(64) });

export const revertStaffHandoverTool = staffTool({
  name: "revert_staff_handover",
  statusPhrase: "Готовлю возврат дел…",
  description:
    "Вернуть всё как было после передачи дел: клиенты, задачи и объекты, что ещё у получателей, возвращаются прежнему сотруднику; " +
    "отключённая тем же действием учётка включается. batchId — из get_staff_card (раздел «Передачи дел»)." + STEP_UP_NOTE,
  parameters: { type: "object", properties: { batchId: { type: "string" } }, required: ["batchId"] },
  requires: ["agents.manage"],
  stepUp: true,
  schema: revertArgs,
  async snapshot(args) {
    const batch = await prisma.agentHandoverBatch.findUnique({
      where: { id: args.batchId },
      select: { id: true, fromAgentId: true, revertedAt: true, clients: true, tasks: true, properties: true, deactivated: true },
    });
    return batch ? { ...batch, revertedAt: iso(batch.revertedAt) } : { exists: false };
  },
  async preview(_args, snap, staff) {
    if (snap.exists === false) throw new AssistantActionError(404, "NOT_FOUND", "Передача дел не найдена");
    if (snap.revertedAt) throw new AssistantActionError(409, "CONFLICT", "Эта передача дел уже возвращена");
    const from = await assertTargetManageable(staff, await loadTarget(String(snap.fromAgentId)));
    const count = (value: unknown) => (Array.isArray(value) ? value.length : Number(value) || 0);
    return {
      title: `↩️ Вернуть дела: ${personLabel(from)}`,
      was: { Передано: `клиентов ${count(snap.clients)}, задач ${count(snap.tasks)}, объектов ${count(snap.properties)}` },
      becomes: { "Дела у": personLabel(from), ...(snap.deactivated ? { Учётка: "включена" } : {}) },
      risk: "Вернётся только то, что ещё у получателей и не тронуто.",
    };
  },
  async execute(args, staff, actor, snap) {
    const body = unwrap(await revertStaffHandover(staff, args.batchId, via(actor)));
    return { result: body, entityId: String(snap.fromAgentId) };
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

// ───────────────────────────── 2FA ─────────────────────────────

export const resetStaffTwoFactorTool = staffTool({
  name: "reset_staff_2fa",
  statusPhrase: "Готовлю сброс Google Authenticator…",
  description:
    "Сбросить сотруднику Google Authenticator (потерял телефон): входит по коду из СМС и настраивает приложение заново; все его " +
    "сессии закрываются." + STEP_UP_NOTE,
  parameters: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
  requires: ["agents.reset2fa"],
  stepUp: true,
  schema: targetArgs,
  snapshot: async (args) => targetSnapshot(await loadTarget(args.agentId)),
  async preview(args, _snap, staff) {
    const target = await assertTargetManageable(staff, await loadTarget(args.agentId), "Управлять учёткой директора может только директор");
    return {
      title: `🔐 Сбросить Google Authenticator: ${personLabel(target)}`,
      was: { Authenticator: target.totpEnabled ? "включён" : "не включён" },
      becomes: { Authenticator: "сброшен", Сессии: "закрыты" },
      risk: "Руководству придёт одно сообщение об этом.",
      irreversible: true,
    };
  },
  async execute(args, staff, actor, snap) {
    unwrap(await resetStaffTwoFactor(staff, args.agentId, via(actor)));
    return { result: { fullName: snap.fullName, totpEnabled: false }, entityId: args.agentId };
  },
  allowed: (actor) => has(actor, "agents.reset2fa"),
});

// ───────────────────────────── права ─────────────────────────────

const permissionList = z.array(z.string().trim().min(1).max(64)).max(40).default([]);
const permissionsArgs = z.object({
  agentId: AGENT_ID,
  grant: permissionList,
  revoke: permissionList,
  /** true — вернуть права ровно как у роли (снять все личные надстройки). */
  resetToRole: z.boolean().optional(),
});
type PermissionsArgs = z.infer<typeof permissionsArgs>;

/** Новые надстройки из текущих: «добавить» и «снять» по одному праву, остальное как было. */
export function mergePermissionChanges(role: Role, current: PermissionOverrides, args: Pick<PermissionsArgs, "grant" | "revoke" | "resetToRole">): PermissionOverrides {
  if (args.resetToRole) return { granted: [], revoked: [] };
  const preset = new Set<PermissionId>(ROLE_PRESETS[role] ?? []);
  const granted = new Set<PermissionId>(current.granted);
  const revoked = new Set<PermissionId>(current.revoked);
  for (const id of args.grant as PermissionId[]) {
    revoked.delete(id);
    if (!preset.has(id)) granted.add(id);
  }
  for (const id of args.revoke as PermissionId[]) {
    granted.delete(id);
    if (preset.has(id)) revoked.add(id);
  }
  return normalizeOverrides(role, { granted: [...granted], revoked: [...revoked] });
}

function unknownPermissions(args: PermissionsArgs): string[] {
  return [...args.grant, ...args.revoke].filter((id) => !isPermissionId(id));
}

export const setStaffPermissionsTool = staffTool({
  name: "set_staff_permissions",
  statusPhrase: "Готовлю изменение прав…",
  description:
    "Добавить (grant) или снять (revoke) сотруднику отдельные права, либо вернуть права как у роли (resetToRole). Названия прав — " +
    "id из get_staff_card (раздел «Права»), не придумывай. У директора права не настраиваются; акционеру права не добавляются. " +
    "Сменить роль целиком — update_staff." + STEP_UP_NOTE,
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      grant: { type: "array", items: { type: "string" } },
      revoke: { type: "array", items: { type: "string" } },
      resetToRole: { type: "boolean" },
    },
    required: ["agentId"],
  },
  requires: ["permissions.manage"],
  stepUp: true,
  schema: permissionsArgs,
  snapshot: async (args) => targetSnapshot(await loadTarget(args.agentId)),
  async preview(args, snap) {
    if (snap.exists === false || String(snap.phone ?? "").includes("-deleted:")) throw new AssistantActionError(404, "NOT_FOUND", "Агент не найден");
    const unknown = unknownPermissions(args);
    if (unknown.length > 0) {
      throw new AssistantActionError(400, "UNKNOWN_PERMISSION", `Таких прав нет: ${unknown.slice(0, 5).join(", ")}. Возьмите названия из карточки сотрудника.`);
    }
    const role = snap.role as Role;
    if (role === "DIRECTOR") throw new AssistantActionError(400, "DIRECTOR", "У директора всегда полный доступ — права не настраиваются");
    const current = snap.permissions as PermissionOverrides;
    const next = mergePermissionChanges(role, current, args);
    if (role === "SHAREHOLDER" && next.granted.length > 0) throw new AssistantActionError(400, "SHAREHOLDER", "Акционеру права не добавляются");
    const before = resolvePermissions(role, current);
    const after = resolvePermissions(role, next);
    const added = [...after].filter((p) => !before.has(p)).map(permissionLabel);
    const removed = [...before].filter((p) => !after.has(p)).map(permissionLabel);
    if (added.length === 0 && removed.length === 0) throw new AssistantActionError(409, "NO_CHANGE", "Права уже такие — менять нечего");
    return {
      title: `🔐 Права: ${plainField(String(snap.fullName), 80)} (${roleLabel(role)})`,
      was: { Добавлено: "—", Снято: "—" },
      becomes: { Добавлено: added.join(", ") || "—", Снято: removed.join(", ") || "—" },
      risk: "Подействует сразу, открытые вкладки сотрудника переподключатся. Руководству придёт одно сообщение.",
    };
  },
  async execute(args, staff, actor, snap) {
    const role = snap.role as Role;
    const next = mergePermissionChanges(role, snap.permissions as PermissionOverrides, args);
    const before = resolvePermissions(role, snap.permissions as PermissionOverrides);
    unwrap(await setStaffPermissions(staff, args.agentId, next, via(actor)));
    const after = resolvePermissions(role, next);
    const added = [...after].filter((p) => !before.has(p)).map(permissionLabel);
    const removed = [...before].filter((p) => !after.has(p)).map(permissionLabel);
    return { result: { fullName: snap.fullName, added, removed }, entityId: args.agentId };
  },
  /** Откат — тот же PUT прав прежним набором; только пока права никто не трогал после нас (снимок брокера). */
  async undo(args, actor, ctx) {
    const staff = await staffActorOf(actor, ["permissions.manage"]);
    const previous = ctx.snapshotBefore.permissions as PermissionOverrides;
    await run(actor, async () => unwrap(await setStaffPermissions(staff, args.agentId, previous, via(actor))));
  },
  allowed: (actor) => has(actor, "permissions.manage"),
});

// ───────────────────────────── пауза заявок ─────────────────────────────

const pauseArgs = z.object({ agentId: AGENT_ID, hours: z.number().int().min(1).max(720), reason: z.string().trim().max(300).optional() });

export const pauseStaffLeadsTool = staffTool({
  name: "pause_staff_leads",
  statusPhrase: "Готовлю паузу заявок…",
  description:
    "Поставить сотруднику паузу новых заявок на hours часов (выходной, перегруз): текущие клиенты остаются у него. Только агентам " +
    "и РОП. Снять — resume_staff_leads. Без кода: в CRM эта кнопка без подтверждения личности.",
  parameters: {
    type: "object",
    properties: { agentId: { type: "string" }, hours: { type: "integer", description: "1–720" }, reason: { type: "string" } },
    required: ["agentId", "hours"],
  },
  requires: ["agents.manage"],
  stepUp: false,
  schema: pauseArgs,
  snapshot: async (args) => targetSnapshot(await loadTarget(args.agentId)),
  async preview(args, snap) {
    if (snap.exists === false) throw new AssistantActionError(404, "NOT_FOUND", "Сотрудник не найден");
    return {
      title: `⏸ Пауза заявок: ${plainField(String(snap.fullName), 80)} на ${args.hours} ч`,
      was: { "Новые заявки": snap.leadsPausedUntil ? `пауза до ${String(snap.leadsPausedUntil).slice(0, 16).replace("T", " ")} UTC` : "получает" },
      becomes: { "Новые заявки": `пауза ${args.hours} ч`, ...(args.reason ? { Причина: plainField(args.reason, 200) } : {}) },
      risk: "Непринятые лиды уйдут в очередь, текущие клиенты останутся. Сотрудник получит уведомление.",
    };
  },
  async execute(args, staff, actor, snap) {
    const body = unwrap(await pauseStaffLeads(staff, args.agentId, { hours: args.hours, reason: args.reason }, via(actor))) as { pausedUntil: Date; released: number };
    return { result: { fullName: snap.fullName, pausedUntil: body.pausedUntil, releasedLeads: body.released }, entityId: args.agentId };
  },
  async undo(args, actor) {
    const staff = await staffActorOf(actor, ["agents.manage"]);
    await run(actor, async () => unwrap(await resumeStaffLeads(staff, args.agentId, via(actor))));
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

export const resumeStaffLeadsTool = staffTool({
  name: "resume_staff_leads",
  statusPhrase: "Готовлю снятие паузы…",
  description: "Снять паузу заявок сотрудника (любую: свою или поставленную руководителем).",
  parameters: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
  requires: ["agents.manage"],
  stepUp: false,
  schema: targetArgs,
  snapshot: async (args) => targetSnapshot(await loadTarget(args.agentId)),
  async preview(_args, snap) {
    if (snap.exists === false) throw new AssistantActionError(404, "NOT_FOUND", "Сотрудник не найден");
    if (!snap.leadsPausedUntil || Date.parse(String(snap.leadsPausedUntil)) <= Date.now()) {
      throw new AssistantActionError(409, "CONFLICT", "Пауза не включена");
    }
    return {
      title: `▶️ Снять паузу заявок: ${plainField(String(snap.fullName), 80)}`,
      was: { "Новые заявки": "пауза" },
      becomes: { "Новые заявки": "получает" },
    };
  },
  async execute(args, staff, actor, snap) {
    unwrap(await resumeStaffLeads(staff, args.agentId, via(actor)));
    return { result: { fullName: snap.fullName }, entityId: args.agentId };
  },
  allowed: (actor) => has(actor, "agents.manage"),
});

/** Группа «Команда» (уровень C). Порядок — как в разделе CRM. */
export const staffWriteTools: readonly AssistantWriteToolPlugin[] = [
  createStaffTool,
  updateStaffTool,
  deleteStaffTool,
  freezeStaffTool,
  unfreezeStaffTool,
  handoverStaffWorkTool,
  revertStaffHandoverTool,
  resetStaffTwoFactorTool,
  setStaffPermissionsTool,
  pauseStaffLeadsTool,
  resumeStaffLeadsTool,
];
