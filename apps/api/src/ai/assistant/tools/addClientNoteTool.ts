import { z } from "zod";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { logTimeline } from "../../../lib/timeline.js";
import { assertClientWritable } from "../actor.js";
import { asPluginExecutor, loadToolActor } from "./showingToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * add_client_note — записать заметку в хронологию клиента (уровень B, П3 группа show).
 *
 * Малая запись: исполняется сразу, откат — кнопкой «Отменить». Пишет через единственную
 * точку записи хронологии `logTimeline` с автором `ai` (П-10): в карточке видно, что
 * запись сделал помощник, а `subjectAgentId` — чей это был чат. Тот же приём и тот же
 * тип записи (`SYSTEM`), что у `create_task` в assistant.ts.
 *
 * ПРАВА — `assertClientWritable` ровно как у create_task и у POST /clients/:id/interactions:
 * рядовой агент пишет только в своих принятых клиентов, «видеть всех» без `clients.assign`
 * в чужую карточку не пишет. Корзина и непринятый лид рядового агента — «клиента нет».
 *
 * ЗАПИСЬ УСЛОВНАЯ: вставка идёт в транзакции под блокировкой строки клиента и повторно
 * сверяет «клиент не в Корзине и закреплён за тем же агентом, что в снимке» — клиента
 * успели передать другому, пока человек читал превью, значит писать от прежних прав уже
 * нельзя (409 STALE).
 *
 * ПОВТОР НЕ ДУБЛИРУЕТ (сборка П3, ревью): уровень B пишет без кнопки, а ключ повтора
 * брокера после исполнения меняется (снимок считает заметки). Поэтому идемпотентность —
 * по факту: такая же заметка (тот же сотрудник, клиент и текст) за последние
 * `NOTE_REPEAT_WINDOW_MS` уже лежит — отдаём её, вторую не пишем. Проверка — под той же
 * блокировкой строки клиента, что и вставка: два параллельных вызова не проскочат оба.
 *
 * ОТКАТ удаляет ТОЛЬКО созданную этой записью заметку (id из результата) и только пока
 * она такая же, какой была создана: тип, автор, точный текст, без задачи и без отметки
 * о выполнении. Тронули — `deleteMany` ничего не находит, откат отказывает (409), чужая
 * правка не затирается.
 */
export const NOTE_MAX_CHARS = 2000;
const NOTE_PREFIX = "Заметка (ИИ-помощник): ";
const NOTE_SOURCE = "assistant.add_client_note";
/** Окно, в котором та же заметка считается повтором, а не новой записью. */
export const NOTE_REPEAT_WINDOW_MS = 10 * 60_000;

const argsSchema = z.object({
  clientId: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1, "Текст заметки пустой").max(NOTE_MAX_CHARS, `Заметка длиннее ${NOTE_MAX_CHARS} знаков`),
});
type Args = z.infer<typeof argsSchema>;

/** Клиент, в чью карточку можно писать от имени актора, либо отказ (404/403) — как create_task. */
async function loadWritableClient(clientId: string, actor: Awaited<ReturnType<typeof loadToolActor>>["actor"]) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, assignedAgentId: true, acceptedAt: true, deletedAt: true, assignmentCompletedAt: true },
  });
  const ownScope = actor.canViewAllClients ? undefined : actor.id;
  if (!client || client.deletedAt !== null || (ownScope && client.acceptedAt === null)) {
    throw new AssistantActionError(404, "NOT_FOUND", "Клиент не найден");
  }
  const denied = assertClientWritable(actor, client);
  if (denied) throw new AssistantActionError(403, "FORBIDDEN", denied);
  return client;
}

export const addClientNoteExecutor: AssistantActionExecutor<Args> = {
  tool: "add_client_note",
  channels: ["crm", "telegram"],
  parseArgs(raw) {
    const parsed = argsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const tooLong = parsed.error.issues.some((issue) => issue.code === "too_big");
    throw new AssistantActionError(
      400,
      tooLong ? "NOTE_TOO_LONG" : "BAD_ARGS",
      tooLong ? `Заметка длиннее ${NOTE_MAX_CHARS} знаков — сократите текст` : "Укажите клиента и непустой текст заметки",
    );
  },

  async snapshot(args, actionActor) {
    const { actor } = await loadToolActor(actionActor);
    const client = await loadWritableClient(args.clientId, actor);
    // Сколько заметок помощника этого сотрудника уже лежит в карточке: меняется после
    // записи, поэтому откат видит «ещё одну заметку добавили» и не трогает чужое.
    const assistantNotes = await prisma.interaction.count({
      where: { clientId: client.id, actorKind: "AI", subjectAgentId: actor.id, type: "SYSTEM", notes: { startsWith: NOTE_PREFIX } },
    });
    return { clientId: client.id, assignedAgentId: client.assignedAgentId, assistantNotes };
  },

  buildPreview(args) {
    return {
      title: "Заметка в карточку клиента",
      was: { Заметка: "нет" },
      becomes: { Заметка: args.text.length > 300 ? `${args.text.slice(0, 299)}…` : args.text },
      risk: "Запись появится в хронологии клиента от имени ИИ-помощника; кнопка «Отменить» уберёт её.",
    };
  },

  async execute(args, actionActor, ctx) {
    const { actor } = await loadToolActor(actionActor);
    const created = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ assignedAgentId: string | null; deletedAt: Date | null }>>`
        SELECT "assignedAgentId", "deletedAt" FROM "Client" WHERE id = ${args.clientId} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.deletedAt !== null || row.assignedAgentId !== (ctx.snapshotBefore.assignedAgentId ?? null)) {
        throw new AssistantActionError(409, "STALE", "Карточка клиента изменилась — проверьте ещё раз");
      }
      const notes = `${NOTE_PREFIX}${args.text}`;
      const repeat = await tx.interaction.findFirst({
        where: {
          clientId: args.clientId,
          actorKind: "AI",
          subjectAgentId: actor.id,
          type: "SYSTEM",
          notes,
          createdAt: { gte: new Date(Date.now() - NOTE_REPEAT_WINDOW_MS) },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (repeat) return { id: repeat.id, repeated: true };
      const row2 = await logTimeline({
        clientId: args.clientId,
        actor: { kind: "ai", source: NOTE_SOURCE, subjectAgentId: actor.id },
        type: "SYSTEM",
        notes,
        tx,
      });
      return { id: row2.id, repeated: false };
    });
    return {
      result: {
        noteId: created.id,
        clientId: args.clientId,
        href: `/clients/${args.clientId}`,
        ...(created.repeated ? { repeated: true, note: "Такая заметка уже записана — вторую не добавляю" } : {}),
      },
      audit: { entityType: "Interaction", entityId: created.id },
    };
  },

  async undo(args, actionActor, ctx) {
    const { actor } = await loadToolActor(actionActor);
    const noteId = (ctx.result as { noteId?: string } | null)?.noteId;
    if (!noteId) throw new AssistantActionError(409, "UNDO_STALE", "Не найдена созданная заметка — откатывать нечего");
    const removed = await prisma.interaction.deleteMany({
      where: {
        id: noteId,
        clientId: args.clientId,
        actorKind: "AI",
        subjectAgentId: actor.id,
        type: "SYSTEM",
        notes: `${NOTE_PREFIX}${args.text}`,
        nextAction: null,
        nextActionDate: null,
        completedAt: null,
        taskCancelledAt: null,
        investigationOnly: false,
      },
    });
    if (removed.count === 0) {
      throw new AssistantActionError(409, "UNDO_STALE", "Заметка уже изменена или удалена — откат затёр бы чужую правку");
    }
  },
};

export const addClientNoteTool: AssistantWriteToolPlugin = {
  name: "add_client_note",
  level: "B",
  statusPhrase: "Записываю заметку…",
  description:
    "Записать заметку в хронологию клиента. Звать, когда сотрудник просит «запиши/добавь заметку/пометь у клиента …» и назван клиент (id из поиска). " +
    "Исполняется сразу, у сотрудника остаётся кнопка «Отменить». Текст пиши так, как сказал сотрудник, не дополняй от себя; до 2000 знаков. " +
    "НЕ звать для задачи с датой (create_task), для звонка или для сообщения клиенту: это только внутренняя заметка.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "id клиента из поиска" },
      text: { type: "string", description: "Текст заметки, до 2000 знаков" },
    },
    required: ["clientId", "text"],
  },
  executor: asPluginExecutor(addClientNoteExecutor),
};
