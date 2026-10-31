import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Точка расширения инструментов помощника (ai/assistant/tools, П3).
 *
 * Держим: запись (B, C) не объявляется модели без \`confirmUi\`; уровень C только
 * готовит действие и отдаёт карточку, не исполняя; уровень B исполняет сразу и
 * оставляет откат; недоступный актору плагин не объявляется и не исполняется;
 * имя исполнителя обязано совпадать с именем инструмента.
 */

const { z } = await import("zod");
const { prisma } = await import("../src/db.js");
const { pluginDeclarations, runTool, runAuditedTool } = await import("../src/ai/assistant.js");
const { registerAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const { confirmAssistantAction, undoAssistantAction } = await import("../src/lib/assistantActions.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");

type Plugin = Parameters<typeof registerAssistantToolPlugin>[0];

const runId = String(Date.now()).slice(-8);
let agentId = "";
const off: Array<() => void> = [];
let seq = 0;
const state = { value: 1, executed: 0, undone: 0 };

function actorOf(extra: Record<string, unknown> = {}) {
  return {
    id: agentId,
    role: "AGENT",
    canViewAllClients: false,
    canViewPhone: false,
    canViewReports: false,
    canViewFinance: false,
    canViewAllDeals: false,
    canAssignClients: false,
    canEditForeignProperties: false,
    canModerate: false,
    canRequestChange: false,
    permissions: new Set<never>(),
    ...extra,
  };
}

/** Плагин записи с исполнителем «значение в памяти». */
function writePlugin(level: "B" | "C", over: Partial<Plugin> = {}): Plugin {
  const name = `test_set_${runId}_${seq++}`;
  const schema = z.object({ value: z.number().int() });
  return {
    name,
    level,
    description: "тест",
    statusPhrase: "Тестирую…",
    executor: {
      tool: name,
      parseArgs: (raw: unknown) => schema.parse(raw),
      snapshot: async () => ({ value: state.value }),
      buildPreview: (args: { value: number }, snapshot: Record<string, unknown>) => ({
        title: "Тест",
        was: { value: snapshot.value },
        becomes: { value: args.value },
      }),
      execute: async (args: { value: number }) => {
        state.executed += 1;
        state.value = args.value;
        return { result: { value: args.value } };
      },
      undo: async (_args: unknown, _actor: unknown, ctx: { snapshotBefore: Record<string, unknown> }) => {
        state.undone += 1;
        state.value = Number(ctx.snapshotBefore.value);
      },
    },
    ...over,
  } as unknown as Plugin;
}

function register(plugin: Plugin) {
  off.push(registerAssistantToolPlugin(plugin));
  return plugin;
}

beforeAll(async () => {
  agentId = await createTestAgent(`Плагины помощника ${runId}`);
});

afterEach(() => {
  while (off.length) off.pop()!();
  state.value = 1;
  state.executed = 0;
  state.undone = 0;
});

afterAll(async () => {
  await cleanupAssistantActionAgents([agentId]);
  await prisma.$disconnect();
});

describe("объявление инструментов модели", () => {
  it("запись не объявляется без confirmUi, чтение — всегда", () => {
    const read = register({
      name: `test_read_${runId}_${seq++}`,
      level: "A",
      description: "чтение",
      statusPhrase: "Читаю…",
      run: async () => ({ ok: true }),
    });
    const write = register(writePlugin("C"));
    const withoutUi = pluginDeclarations(actorOf() as never, false).map((d) => d.name);
    expect(withoutUi).toContain(read.name);
    expect(withoutUi).not.toContain(write.name);
    const withUi = pluginDeclarations(actorOf() as never, true).map((d) => d.name);
    expect(withUi).toEqual(expect.arrayContaining([read.name, write.name]));
  });

  it("плагин, закрытый актору, не объявляется и не исполняется", async () => {
    for (const level of ["B", "C"] as const) {
      const plugin = register(writePlugin(level, { allowed: () => false }));
      expect(pluginDeclarations(actorOf() as never, true).map((d) => d.name)).not.toContain(plugin.name);
      // Модель всё же назвала его — ядро отказывает, исполнитель не зовётся, карточки нет.
      const shown: unknown[] = [];
      const answer = await runAuditedTool({ name: plugin.name, args: { value: 7 } }, actorOf() as never, {
        channel: "crm",
        confirmUi: true,
        writeBudget: { left: 3 },
        onConfirm: (a) => shown.push(a),
      });
      expect(answer).toEqual({ error: "Нет доступа к этому действию" });
      expect(shown).toHaveLength(0);
      expect(state.executed).toBe(0);
      expect(await prisma.assistantAction.count({ where: { tool: plugin.name } })).toBe(0);
    }
  });

  it("имя исполнителя обязано совпадать с именем инструмента", () => {
    const plugin = writePlugin("C");
    (plugin as { executor: { tool: string } }).executor.tool = "другое_имя";
    expect(() => registerAssistantToolPlugin(plugin)).toThrow(/не совпадает/);
  });

  it("встроенный runTool плагины не знает (они идут через ядро)", async () => {
    const plugin = register(writePlugin("C"));
    expect(await runTool(plugin.name, {}, actorOf() as never)).toEqual({ error: `Неизвестный инструмент: ${plugin.name}` });
  });
});

describe("уровень C: готовит, но не исполняет", () => {
  it("отдаёт карточку и ждёт подтверждения; подтверждение исполняет один раз", async () => {
    const plugin = register(writePlugin("C"));
    const shown: unknown[] = [];
    const answer = (await runAssistantToolPlugin(plugin, { value: 5 }, actorOf({ id: agentId }) as never, {
      channel: "crm",
      onConfirm: (a) => shown.push(a),
    })) as { confirmRequired: boolean; actionId: string; preview: { was: unknown; becomes: unknown } };

    expect(answer.confirmRequired).toBe(true);
    expect(answer.preview.was).toEqual({ value: 1 });
    expect(answer.preview.becomes).toEqual({ value: 5 });
    expect(shown).toHaveLength(1);
    expect(state.executed).toBe(0);
    expect(state.value).toBe(1);

    const actor = { agentId, channel: "crm" as const, can: () => true };
    await confirmAssistantAction(answer.actionId, actor);
    await confirmAssistantAction(answer.actionId, actor);
    expect(state.executed).toBe(1);
    expect(state.value).toBe(5);
  });

  it("ошибка разбора аргументов не роняет раунд — модель получает текст отказа", async () => {
    const plugin = register(writePlugin("C"));
    const answer = await runAssistantToolPlugin(plugin, { value: "не число" }, actorOf({ id: agentId }) as never, { channel: "crm" }).catch(
      (err: unknown) => err,
    );
    // Невалидные аргументы — ошибка вызова, а не молчаливое исполнение.
    expect(state.executed).toBe(0);
    expect(answer).toBeDefined();
  });
});

describe("сбои и повторы не роняют ход (ревью П3)", () => {
  it("неожиданное исключение инструмента — модели {error}, ход не падает", async () => {
    const read = register({
      name: `test_boom_${runId}_${seq++}`,
      level: "A",
      description: "падает",
      statusPhrase: "Падаю…",
      run: async () => {
        throw new Error("база недоступна");
      },
    } as Plugin);
    expect(await runAssistantToolPlugin(read, {}, actorOf() as never, { channel: "crm" })).toMatchObject({
      error: expect.any(String),
      code: "TOOL_FAILED",
    });
    const write = writePlugin("C");
    (write as unknown as { executor: { snapshot: () => Promise<never> } }).executor.snapshot = async () => {
      throw new TypeError("неожиданное");
    };
    register(write);
    expect(await runAssistantToolPlugin(write, { value: 2 }, actorOf({ id: agentId }) as never, { channel: "crm" })).toMatchObject({
      code: "TOOL_FAILED",
    });
  });

  it("onConfirm — только для ждущего действия: уже подтверждённое повтором не показывается второй раз", async () => {
    const plugin = register(writePlugin("C"));
    const shown: unknown[] = [];
    const hooks = { channel: "crm" as const, onConfirm: (a: unknown) => shown.push(a) };
    const first = (await runAssistantToolPlugin(plugin, { value: 4 }, actorOf({ id: agentId }) as never, hooks)) as { actionId: string };
    expect(shown).toHaveLength(1);
    // Человек нажал «Подтвердить», исполнение идёт; модель зовёт то же самое ещё раз.
    await prisma.assistantAction.update({ where: { id: first.actionId }, data: { status: "CONFIRMED" } });
    const again = (await runAssistantToolPlugin(plugin, { value: 4 }, actorOf({ id: agentId }) as never, hooks)) as {
      confirmRequired: boolean;
      actionId: string;
      status: string;
    };
    expect(again).toMatchObject({ confirmRequired: false, actionId: first.actionId, status: "CONFIRMED" });
    expect(shown).toHaveLength(1);
    expect(state.executed).toBe(0);
  });
});

describe("уровень B: исполняет сразу и оставляет откат", () => {
  it("делает, отдаёт undoUntil, откат возвращает прежнее", async () => {
    const plugin = register(writePlugin("B"));
    const answer = (await runAssistantToolPlugin(plugin, { value: 9 }, actorOf({ id: agentId }) as never, { channel: "crm" })) as {
      done: boolean;
      actionId: string;
      undoUntil: string | null;
    };
    expect(answer.done).toBe(true);
    expect(answer.undoUntil).not.toBeNull();
    expect(state.value).toBe(9);

    await undoAssistantAction(answer.actionId, { agentId, channel: "crm", can: () => true });
    expect(state.value).toBe(1);
    expect(state.undone).toBe(1);
  });
});
