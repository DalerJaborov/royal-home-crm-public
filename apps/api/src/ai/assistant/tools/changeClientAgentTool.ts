import { z } from "zod";
import { formatClientCode } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { loadAgentAccess } from "../../../auth/middleware.js";
import { findActiveAgentByName } from "../../../lib/agentNameLookup.js";
import {
  AssistantActionError,
  type AssistantActionActor,
  type AssistantActionExecutor,
  type AssistantActionSnapshot,
} from "../../../lib/assistantActions.js";
import {
  assignClientManually,
  MANUAL_ASSIGN_GUARD_FIELDS,
  MANUAL_ASSIGN_WRITTEN_SELECT,
  manualAssignFieldValues,
  manualAssignPreconditions,
  manualAssignRevertible,
  revertManualAssign,
  type ManualAssignFieldValues,
} from "../../../lib/assignClientManually.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { checkManualAssignTarget } from "../../../lib/manualAssignTarget.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * change_client_agent — «передай клиента Сайфуллоеву» (уровень C, П3, задача 3.4,
 * docs/design/internal-assistant-architecture-2026-10-31.md §3).
 *
 * ОПАСНАЯ ЗОНА — владение клиентом (docs/law/lead-ownership.md). Поэтому здесь
 * нет НИ ОДНОЙ своей правки владельца: исполнение — `assignClientManually`
 * (lib/assignClientManually.ts), та же функция, что у `POST /clients/:id/assign`,
 * со всеми её проверками, условной записью через `changeClientAgent` и
 * спутниками. Откат — `revertManualAssign`, тот же писатель с источником
 * `assistant.undo`.
 *
 * ГОНКИ, КОТОРЫЕ ЗАКРЫТЫ (подробно — docs/journal/2026-10-31-помощник-owner.md):
 *  1. Превью → подтверждение: брокер сверяет снимок (владелец, принятие,
 *     эскалация, отметки отказа, тип, статусы, контакт, открытая сделка, кому
 *     назначаем) — изменилось хоть что-то → 409 STALE и новое превью.
 *  2. Сверка → запись: `assignClientManually` с `expected` — запись идёт
 *     `updateMany` с прежними значениями полей снимка в WHERE; не совпало → 409.
 *  3. Двойное «Подтвердить» — захват PENDING → CONFIRMED в брокере, исполнение одно.
 *  4. Имя агента → id решается в снимке: если между превью и нажатием появился
 *     однофамилец, снимок не совпадёт — исполнять не по тому человеку нельзя.
 *  5. Откат: только если карточка ровно в состоянии «после назначения» (снимок
 *     брокера + WHERE по владельцу/отметке назначения/принятию/статусам и «нет
 *     открытой сделки» прямо в записи).
 */

const argsSchema = z.object({
  clientId: z.string().trim().min(1).max(64),
  agentName: z.string().trim().min(2).max(120),
});
type Args = z.infer<typeof argsSchema>;

const TOOL = "change_client_agent";
const OPEN_DEAL_STAGES_EXCLUDED = ["COMPLETED", "CANCELLED"] as const;

/** Снимок: всё, что меняет назначение, и всё, от чего зависит решение «можно ли». */
interface Snapshot extends AssistantActionSnapshot {
  clientId: string;
  kind: string;
  deletedAt: string | null;
  fields: ManualAssignFieldValues;
  firstContactAt: string | null;
  lastAgentAttemptAt: string | null;
  hasOpenDeal: boolean;
  /** Кому назначаем — решение по имени на момент снимка. */
  target: { kind: "one"; id: string } | { kind: "none" } | { kind: "many"; ids: string[] };
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Право — как у REST: `requirePermission("clients.assign")` + `requireAuth`
 * (активный сотрудник). Роль — из того же `loadAgentAccess`, от неё зависит
 * назначение после отказа (`canViewInvestigations`).
 */
async function requireAssignAccess(actor: AssistantActionActor): Promise<{ role: string }> {
  if (!actor.can("clients.assign")) {
    throw new AssistantActionError(403, "FORBIDDEN", "Передавать клиентов другому агенту может только руководитель");
  }
  const access = await loadAgentAccess(actor.agentId);
  if (!access || !access.isActive || !access.permissions.has("clients.assign")) {
    throw new AssistantActionError(403, "FORBIDDEN", "Передавать клиентов другому агенту может только руководитель");
  }
  return { role: access.role };
}

const clientSelect = {
  id: true,
  shortId: true,
  fullName: true,
  kind: true,
  deletedAt: true,
  firstContactAt: true,
  lastAgentAttemptAt: true,
  ...MANUAL_ASSIGN_WRITTEN_SELECT,
} as const;

async function readSnapshot(args: Args, actor: AssistantActionActor): Promise<Snapshot> {
  await requireAssignAccess(actor);
  const [client, match, openDeal] = await Promise.all([
    prisma.client.findUnique({ where: { id: args.clientId }, select: clientSelect }),
    findActiveAgentByName(args.agentName),
    prisma.deal.findFirst({
      where: { clientId: args.clientId, stage: { notIn: [...OPEN_DEAL_STAGES_EXCLUDED] } },
      select: { id: true },
    }),
  ]);
  if (!client) throw new AssistantActionError(404, "NOT_FOUND", "Клиент не найден");
  return {
    clientId: client.id,
    kind: client.kind,
    deletedAt: iso(client.deletedAt),
    fields: manualAssignFieldValues(client),
    firstContactAt: iso(client.firstContactAt),
    lastAgentAttemptAt: iso(client.lastAgentAttemptAt),
    hasOpenDeal: openDeal !== null,
    target:
      match.kind === "one"
        ? { kind: "one", id: match.agent.id }
        : match.kind === "many"
          ? { kind: "many", ids: match.candidates.map((c) => c.id) }
          : { kind: "none" },
  };
}

async function agentName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const agent = await prisma.agent.findUnique({ where: { id }, select: { fullName: true } });
  return agent?.fullName ?? null;
}

const QUEUE_LABEL = "без агента (очередь руководителя)";

export const changeClientAgentExecutor: AssistantActionExecutor<Args> = {
  tool: TOOL,
  requires: ["clients.assign"],
  channels: ["crm"],
  parseArgs: (raw) => argsSchema.parse(raw),

  snapshot: (args, actor) => readSnapshot(args, actor),

  async buildPreview(args, raw, actor) {
    const snap = raw as Snapshot;
    const { role } = await requireAssignAccess(actor);
    const client = await prisma.client.findUnique({
      where: { id: snap.clientId },
      select: { shortId: true, fullName: true, kind: true, deletedAt: true, assignmentRefusedAt: true, assignmentCompletedAt: true },
    });
    const denied = manualAssignPreconditions(client, role);
    if (denied) throw new AssistantActionError(denied.status, denied.code, denied.error);

    if (snap.target.kind === "none") {
      throw new AssistantActionError(
        404,
        "AGENT_NOT_FOUND",
        `Среди активных сотрудников нет «${args.agentName}». Уточните имя (как в разделе «Команда»).`
      );
    }
    if (snap.target.kind === "many") {
      const names = await prisma.agent.findMany({
        where: { id: { in: snap.target.ids } },
        select: { fullName: true },
        orderBy: { fullName: "asc" },
      });
      throw new AssistantActionError(
        409,
        "AGENT_AMBIGUOUS",
        `Под «${args.agentName}» подходят несколько сотрудников: ${names.map((n) => n.fullName).join(", ")}. ` +
          "Назовите, кому именно передать — сам я не выбираю."
      );
    }
    const checked = await checkManualAssignTarget(snap.target.id);
    if (!checked.ok) throw new AssistantActionError(checked.status, "TARGET", checked.error);
    if (snap.hasOpenDeal) {
      throw new AssistantActionError(409, "OPEN_DEAL", "У клиента открытая сделка — сначала закройте или отмените её.");
    }
    const target = checked.agent;
    if (snap.fields.assignedAgentId === target.id && snap.fields.acceptedAt) {
      throw new AssistantActionError(409, "NO_CHANGE", `Клиент уже у ${target.fullName} и принят — менять нечего.`);
    }

    const code = formatClientCode(client!.shortId, client!.kind);
    const fromName = (await agentName(snap.fields.assignedAgentId as string | null)) ?? QUEUE_LABEL;
    const toSelf = target.id === actor.agentId;
    const revertible = manualAssignRevertible(snap.fields);
    const risk = [
      toSelf ? "Вы забираете клиента себе." : `${target.fullName} получит пуш «Вам назначили клиента».`,
      "Клиент сразу считается принятым; открытые задачи прежнего агента и объекты продавца перейдут новому.",
      checked.notAgent ? `${target.fullName} — не агент продаж: клиент будет в его портфеле.` : null,
      revertible
        ? "Отменить можно 15 минут, пока карточку никто не тронул."
        : "Отменить нельзя: отметка отказа по назначению снимется и не вернётся.",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      title: `Передать клиента ${code}: ${fromName === QUEUE_LABEL ? "из очереди" : fromName} → ${target.fullName}`.slice(0, 200),
      was: {
        client: code,
        // Имя клиента — чужой текст (его пишет бот со слов клиента). Превью читает
        // человек — здесь без тегов, только погашенные скобки; для модели всё превью
        // оборачивает previewForModel (tools/run.ts).
        clientName: plainField(clientNamePhoneSafe(client!.fullName, actor.can("clients.viewPhone")), 120),
        href: `/clients/${client!.shortId}`,
        agent: fromName,
        accepted: Boolean(snap.fields.acceptedAt),
      },
      becomes: { client: code, agent: toSelf ? `${target.fullName} (вы)` : target.fullName, accepted: true },
      risk,
      ...(revertible ? {} : { irreversible: true }),
    };
  },

  async execute(args, actor, ctx) {
    const { role } = await requireAssignAccess(actor);
    const snap = ctx.snapshotBefore as Snapshot;
    if (snap.target.kind !== "one") {
      throw new AssistantActionError(409, "STALE", "Не ясно, кому передать — попросите заново с точным именем");
    }
    // Запись — только из того состояния, что человек видел в превью: поля
    // условия записи REST плюс тип и статусы (от них зависят проверки и сброс
    // «Потерянных»). assignClientManually кладёт их в WHERE самой записи.
    const expected: Record<string, unknown> = { kind: snap.kind, status: snap.fields.status, workStatus: snap.fields.workStatus };
    for (const field of MANUAL_ASSIGN_GUARD_FIELDS) expected[field] = snap.fields[field];

    const outcome = await assignClientManually({
      clientId: snap.clientId,
      toAgentId: snap.target.id,
      actor: { id: actor.agentId, role },
      via: "assistant",
      expected,
    });
    if (!outcome.ok) {
      const code = outcome.code === "RACE" ? "STALE" : outcome.code;
      throw new AssistantActionError(outcome.status, code, outcome.error);
    }
    const fromName = (await agentName(outcome.previousAgentId)) ?? QUEUE_LABEL;
    return {
      result: {
        clientId: outcome.client.id,
        client: formatClientCode(outcome.client.shortId, outcome.client.kind),
        href: `/clients/${outcome.client.shortId}`,
        fromAgent: fromName,
        toAgent: outcome.target.fullName,
        accepted: true,
      },
      audit: { entityType: "Client", entityId: outcome.client.id },
    };
  },

  async undo(args, actor, ctx) {
    await requireAssignAccess(actor);
    const before = ctx.snapshotBefore as Snapshot;
    const after = ctx.snapshotAfter as Snapshot;
    if (!manualAssignRevertible(before.fields)) {
      throw new AssistantActionError(409, "NOT_UNDOABLE", "Это назначение не откатывается");
    }
    // Вернуть можно только тому, кому вообще можно назначить: прежнего агента
    // успели отключить или заморозить — откат отдал бы клиента тому, кто его не увидит.
    const backTo = before.fields.assignedAgentId as string | null;
    if (backTo) {
      const checked = await checkManualAssignTarget(backTo);
      if (!checked.ok) throw new AssistantActionError(409, "UNDO_TARGET", checked.error);
    }
    const [actorName, fromName] = await Promise.all([
      agentName(actor.agentId),
      agentName(before.fields.assignedAgentId as string | null),
    ]);
    const reverted = await revertManualAssign({
      clientId: before.clientId,
      actorId: actor.agentId,
      before: before.fields,
      after: after.fields,
      reason: `${actorName ?? "Руководитель"} отменил(а) назначение через ИИ-помощника — клиент возвращён: ${fromName ?? QUEUE_LABEL}`,
    });
    if (!reverted.ok) {
      throw new AssistantActionError(
        409,
        "UNDO_STALE",
        reverted.reason === "deleted"
          ? "Клиент уже в Корзине — откатывать нечего"
          : "Карточку уже изменили после назначения (или открыли сделку) — откат затёр бы чужую правку"
      );
    }
  },
};

export const changeClientAgentTool: AssistantWriteToolPlugin = {
  name: TOOL,
  level: "C",
  statusPhrase: "Готовлю передачу клиента…",
  description:
    "Передать клиента (сменить ответственного агента) конкретному сотруднику. Зови, когда руководитель просит " +
    "передать/назначить/переназначить клиента названному агенту или забрать клиента себе. clientId найди через " +
    "search_clients. Инструмент НИЧЕГО не меняет сам: готовит карточку «было → станет», исполняет человек кнопкой " +
    "«Подтвердить». НЕ зови: для передачи объекта недвижимости, для передачи всех дел уволенного (это раздел «Команда»), " +
    "если агент не назван — сначала спроси, кому передать. Если сотрудников с таким именем несколько — " +
    "покажи список и спроси, не выбирай сам.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "ID клиента (из search_clients)" },
      agentName: { type: "string", description: "Имя сотрудника, которому передать, как его назвал человек (фамилия или ФИО)" },
    },
    required: ["clientId", "agentName"],
  },
  allowed: (actor) => actor.canAssignClients,
  executor: changeClientAgentExecutor as never,
};
