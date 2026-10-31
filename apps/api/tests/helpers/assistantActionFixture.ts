import { z } from "zod";
import type { PermissionId } from "@royal-home/shared";
import { prisma } from "../../src/db.js";
import {
  AssistantActionError,
  registerAssistantActionExecutor,
  type AssistantActionActor,
} from "../../src/lib/assistantActions.js";
import { deleteAgentsWithTraces } from "./cleanupAgents.js";
import { waitForSettled } from "./waitFor.js";

/**
 * ТЕСТОВЫЙ ИСПОЛНИТЕЛЬ ДЕЙСТВИЯ ПОМОЩНИКА (lib/assistantActions.ts).
 *
 * Брокер проверяется отдельно от настоящих инструментов (их тесты — в
 * ai-assistant-*-tools и assistant-change-client-agent) на «объекте» в памяти: снимок — его текущая цена,
 * исполнение — смена цены, откат — возврат прежней. Счётчики вызовов — ровно то,
 * что проверяют тесты «исполнилось один раз». Исполнение нарочно ждёт, чтобы
 * два параллельных подтверждения успели встретиться.
 */
export interface FakeProperty {
  price: number;
}

export function makeTestExecutor(
  tool: string,
  opts: { requires?: PermissionId[]; irreversible?: boolean; undoWindowMs?: number; failWith?: Error } = {}
) {
  const store = new Map<string, FakeProperty>();
  const calls = { execute: 0, undo: 0 };
  const argsSchema = z.object({ key: z.string(), price: z.number().int().positive() });
  type Args = z.infer<typeof argsSchema>;

  const read = (key: string): FakeProperty => {
    const item = store.get(key);
    if (!item) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", "Объект не найден");
    return item;
  };

  const unregister = registerAssistantActionExecutor<Args>({
    tool,
    requires: opts.requires,
    undoWindowMs: opts.undoWindowMs,
    parseArgs: (raw) => argsSchema.parse(raw),
    async snapshot(args) {
      return { price: read(args.key).price };
    },
    buildPreview(args, snapshot) {
      return {
        title: `Цена объекта ${args.key}`,
        was: { price: snapshot.price },
        becomes: { price: args.price },
        irreversible: opts.irreversible,
      };
    },
    async execute(args, _actor: AssistantActionActor) {
      calls.execute += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (opts.failWith) throw opts.failWith;
      const item = read(args.key);
      const was = item.price;
      item.price = args.price;
      return { result: { was, price: args.price } };
    },
    async undo(args, _actor, ctx) {
      calls.undo += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      read(args.key).price = Number(ctx.snapshotBefore.price);
    },
  });

  return { store, calls, unregister };
}

export function actorFor(agentId: string, permissions: PermissionId[] = []): AssistantActionActor {
  const granted = new Set<PermissionId>(permissions);
  return { agentId, channel: "crm", can: (permission) => granted.has(permission) };
}

/** Убрать свои действия, дождаться отложенных строк AuditLog и убрать агентов. */
export async function cleanupAssistantActionAgents(agentIds: string[]): Promise<void> {
  await prisma.assistantAction.deleteMany({ where: { agentId: { in: agentIds } } });
  await waitForSettled(() => prisma.auditLog.count({ where: { agentId: { in: agentIds } } }));
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agentIds } } });
  await deleteAgentsWithTraces(agentIds);
}
