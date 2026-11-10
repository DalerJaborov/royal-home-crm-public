import { z } from "zod";
import {
  ABSENCE_KIND_LABELS,
  describePermissions,
  parsePermissionOverrides,
  ROLE_LABELS,
  ROLE_PRESET_SUMMARY,
  type PermissionId,
  type Role,
} from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { findStaffByName } from "../../../lib/agentNameLookup.js";
import { availabilityOf } from "../../../lib/agentAvailability.js";
import { dushanbeDateTimeString } from "../../../lib/dushanbeTime.js";
import { activeLeadCounts, NO_LEADS } from "../../../lib/leadLimits.js";
import { listStaffDirectory, listStaffHandovers } from "../../../lib/staffAdmin.js";
import { loadStaffLive, ONLINE_WINDOW_MS } from "../../../lib/staffLive.js";
import type { AssistantActor } from "../actor.js";
import { safeField } from "./safeField.js";
import { maskStaffEmail, maskStaffPhone } from "./staffPrivacy.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * ЧТЕНИЕ РАЗДЕЛА «КОМАНДА» ДЛЯ ПОМОЩНИЦЫ (10.11.2026). Права — как у REST:
 *  - list_staff — как GET /agents (agents.manage | clients.assign | team.viewFull),
 *    телефоны и почта — только с agents.manage (тот же select, lib/staffAdmin.ts);
 *  - get_staff_card — карточка: учётка (agents.manage), права (permissions.manage, как
 *    GET /agents/:id/permissions), «сейчас» (team.viewFull, lib/staffLive.ts — то же
 *    тело, что GET /agents/:id/live), передачи дел (agents.manage);
 *  - staff_now — «кто сейчас в работе» (team.viewFull, как экран «Команда»).
 * Только личка: в общей группе — ничего про сотрудников (assistantBot.ts скрывает их,
 * а здесь отказ на случай, если скрыть забудут).
 */

const has = (actor: AssistantActor, permission: PermissionId) => actor.permissions?.has(permission) ?? false;
const roleLabel = (role: string) => ROLE_LABELS[role as Role] ?? role;
const GROUP_REFUSAL = { error: "Про сотрудников и права — только в личке с Шабнам" };

function privateOnly(actor: AssistantActor): boolean {
  return actor.surface !== "telegram-group";
}

function statusOf(row: { isActive: boolean; frozenAt: Date | null; absenceKind?: string | null; absenceUntil?: Date | null }): string {
  if (!row.isActive) return "🚫 отключён";
  if (row.frozenAt) {
    const kind = row.absenceKind ? ABSENCE_KIND_LABELS[row.absenceKind as keyof typeof ABSENCE_KIND_LABELS] : "заморожен";
    return `❄️ ${kind}${row.absenceUntil ? ` до ${dushanbeDateTimeString(row.absenceUntil).slice(0, 10)}` : ""}`;
  }
  return "✅ работает";
}

// ───────────────────────────── list_staff ─────────────────────────────

const listArgs = z.object({
  query: z.string().trim().max(120).optional(),
  status: z.enum(["active", "frozen", "inactive", "all"]).optional(),
});

export const listStaffTool: AssistantReadToolPlugin = {
  name: "list_staff",
  level: "A",
  statusPhrase: "Смотрю команду…",
  description:
    "Список сотрудников CRM (раздел «Команда»): имя, роль, работает / заморожен / отключён, agentId для других действий. query — " +
    "часть имени; status — active (по умолчанию), frozen, inactive, all. Зови перед любым действием с сотрудником, чтобы взять agentId; " +
    "если подходят несколько — покажи и спроси, не выбирай сам.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Имя или фамилия, можно часть" },
      status: { type: "string", enum: ["active", "frozen", "inactive", "all"] },
    },
  },
  allowed: (actor) => privateOnly(actor) && (has(actor, "agents.manage") || has(actor, "clients.assign") || has(actor, "team.viewFull")),
  async run(raw, { actor }) {
    if (!privateOnly(actor)) return GROUP_REFUSAL;
    if (!(has(actor, "agents.manage") || has(actor, "clients.assign") || has(actor, "team.viewFull"))) return { error: "Недостаточно прав" };
    const args = listArgs.parse(raw ?? {});
    const staffActor = { id: actor.id, role: actor.role, can: (p: PermissionId) => has(actor, p) };
    const rows = (await listStaffDirectory(staffActor, { telephony: false })) as Array<{
      id: string; fullName: string; role: string; isActive: boolean; frozenAt: Date | null; absenceKind: string | null; absenceUntil: Date | null;
      phone?: string; sipExtension?: string | null;
    }>;
    let ids: Set<string> | null = null;
    if (args.query) {
      const match = await findStaffByName(args.query, { includeInactive: true });
      ids = new Set(match.kind === "one" ? [match.agent.id] : match.kind === "many" ? match.candidates.map((c) => c.id) : []);
    }
    const status = args.status ?? "active";
    const filtered = rows
      .filter((r) => !r.phone?.includes("-deleted:"))
      .filter((r) => (ids ? ids.has(r.id) : true))
      .filter((r) =>
        status === "all" ? true : status === "inactive" ? !r.isActive : status === "frozen" ? r.isActive && r.frozenAt !== null : r.isActive
      )
      .slice(0, 40);
    return {
      total: filtered.length,
      staff: filtered.map((r) => ({
        agentId: r.id,
        name: safeField(r.fullName, 80),
        role: roleLabel(r.role),
        status: statusOf(r),
        // Телефон и почту список не отдаёт вовсе (staffPrivacy.ts); внутренний номер — служебный.
        ...(r.sipExtension !== undefined ? { extension: r.sipExtension ?? null } : {}),
        href: `/team/${r.id}`,
      })),
    };
  },
};

// ───────────────────────────── get_staff_card ─────────────────────────────

const cardArgs = z.object({ agentId: z.string().trim().min(1).max(64) });

export const getStaffCardTool: AssistantReadToolPlugin = {
  name: "get_staff_card",
  level: "A",
  statusPhrase: "Открываю карточку сотрудника…",
  description:
    "Карточка сотрудника по agentId (из list_staff): роль, статус, пауза заявок, внутренний номер, включён ли Google Authenticator " +
    "(телефон — только последние 2 цифры: полный номер — логин входа, он виден в CRM), " +
    "права (что включено сверх роли и что снято, с id прав для set_staff_permissions), «сейчас»: в сети ли, лиды в работе, ближайшая " +
    "задача, звонки за неделю; последние передачи дел с batchId для revert_staff_handover. Видно ровно то, что вам видно в CRM.",
  parameters: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
  allowed: (actor) => privateOnly(actor) && (has(actor, "agents.manage") || has(actor, "team.viewFull") || has(actor, "permissions.manage")),
  async run(raw, { actor }) {
    if (!privateOnly(actor)) return GROUP_REFUSAL;
    const canManage = has(actor, "agents.manage");
    const canTeam = has(actor, "team.viewFull");
    const canPermissions = has(actor, "permissions.manage");
    if (!canManage && !canTeam && !canPermissions) return { error: "Недостаточно прав" };
    const { agentId } = cardArgs.parse(raw ?? {});
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true, fullName: true, role: true, isActive: true, phone: true, email: true, sipExtension: true, totpEnabled: true,
        frozenAt: true, frozenReason: true, absenceKind: true, absenceUntil: true, leadsPausedUntil: true, permissions: true,
        telegramChatId: true, takesUnknownCalls: true, weeklyDaysOff: true,
      },
    });
    if (!agent || agent.phone.includes("-deleted:")) return { error: "Сотрудник не найден" };
    const availability = availabilityOf(agent);
    const card: Record<string, unknown> = {
      agentId: agent.id,
      name: safeField(agent.fullName, 80),
      role: roleLabel(agent.role),
      roleSummary: ROLE_PRESET_SUMMARY[agent.role as Role] ?? null,
      status: statusOf(agent),
      ...(agent.frozenAt ? { frozenReason: safeField(agent.frozenReason, 200) } : {}),
      leadsPausedUntil: availability.pausedUntil ? dushanbeDateTimeString(availability.pausedUntil) : null,
      href: `/team/${agent.id}`,
    };
    if (canManage) {
      Object.assign(card, {
        // Только хвост: полный номер — логин входа, его видно в CRM (staffPrivacy.ts).
        phoneLast2: maskStaffPhone(agent.phone),
        email: maskStaffEmail(agent.email),
        extension: agent.sipExtension,
        googleAuthenticator: agent.totpEnabled ? "включён" : "не включён",
        telegramLinked: Boolean(agent.telegramChatId),
        takesUnknownCalls: agent.takesUnknownCalls,
        weeklyDaysOff: agent.weeklyDaysOff,
      });
    }
    if (canPermissions) {
      const role = agent.role as Role;
      const overrides = parsePermissionOverrides(agent.permissions);
      const items = describePermissions(role, overrides);
      card.permissions = {
        editable: role !== "DIRECTOR",
        // Только отличия от роли и короткий список включённого: весь реестр модели не нужен.
        changedFromRole: items.filter((p) => p.overridden).map((p) => ({ id: p.id, label: p.label, enabled: p.enabled })),
        enabled: items.filter((p) => p.enabled).map((p) => ({ id: p.id, label: p.label })),
        disabled: items.filter((p) => !p.enabled).map((p) => ({ id: p.id, label: p.label })),
      };
    }
    if (canTeam) {
      const live = await loadStaffLive(agent.id, { role: actor.role, can: (p) => has(actor, p) });
      if (live) {
        card.now = {
          online: live.now.online,
          lastSeen: live.now.lastSeenAt ? dushanbeDateTimeString(live.now.lastSeenAt) : null,
          nextTask: live.now.nextTask
            ? { title: safeField(live.now.nextTask.title, 120), at: live.now.nextTask.at ? dushanbeDateTimeString(live.now.nextTask.at) : null }
            : null,
          leadsInWork: live.leads.inWork,
          leadLimit: live.leads.limit || null,
          unacceptedLeads: live.leads.unaccepted,
          callsThisWeek: { total: live.calls.weekTotal, talked: live.calls.weekTalked, missedIncoming: live.calls.weekMissedIncoming },
        };
      }
    }
    if (canManage) {
      const handovers = await listStaffHandovers(agent.id);
      card.handovers = handovers.map((h) => ({
        batchId: h.id,
        at: dushanbeDateTimeString(h.createdAt),
        clients: h.clients,
        tasks: h.tasks,
        properties: h.properties,
        deactivated: h.deactivated,
        reverted: h.revertedAt !== null,
      }));
    }
    return card;
  },
};

// ───────────────────────────── staff_now ─────────────────────────────

export const staffNowTool: AssistantReadToolPlugin = {
  name: "staff_now",
  level: "A",
  statusPhrase: "Смотрю, кто сейчас в работе…",
  description:
    "Кто сейчас в работе: по каждому активному сотруднику — в сети ли (заходил в CRM последние 3 минуты), заморожен, пауза заявок, " +
    "сколько лидов в работе. Зови на «кто сейчас работает», «кто на месте», «кто в отпуске».",
  allowed: (actor) => privateOnly(actor) && has(actor, "team.viewFull"),
  async run(_raw, { actor }) {
    if (!privateOnly(actor)) return GROUP_REFUSAL;
    if (!has(actor, "team.viewFull")) return { error: "Недостаточно прав" };
    const rows = await prisma.agent.findMany({
      where: { isActive: true, NOT: { phone: { contains: "-deleted:" } } },
      select: { id: true, fullName: true, role: true, isActive: true, lastSeenAt: true, frozenAt: true, absenceKind: true, absenceUntil: true, leadsPausedUntil: true },
      orderBy: { fullName: "asc" },
      take: 200,
    });
    const leads = await activeLeadCounts(rows.map((r) => r.id));
    const now = Date.now();
    const staff = rows.map((r) => {
      const availability = availabilityOf(r);
      return {
        agentId: r.id,
        name: safeField(r.fullName, 80),
        role: roleLabel(r.role),
        status: statusOf(r),
        online: Boolean(r.lastSeenAt && now - r.lastSeenAt.getTime() < ONLINE_WINDOW_MS),
        lastSeen: r.lastSeenAt ? dushanbeDateTimeString(r.lastSeenAt) : null,
        leadsPausedUntil: availability.pausedUntil ? dushanbeDateTimeString(availability.pausedUntil) : null,
        leadsInWork: (leads.get(r.id) ?? NO_LEADS).total,
      };
    });
    return { online: staff.filter((s) => s.online).length, total: staff.length, staff };
  },
};

export const staffReadTools: readonly AssistantReadToolPlugin[] = [listStaffTool, getStaffCardTool, staffNowTool];
