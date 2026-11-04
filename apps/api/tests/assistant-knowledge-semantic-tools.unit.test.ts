import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), enabled: vi.fn(), pending: vi.fn(), index: vi.fn(), options: vi.fn() }));
vi.mock("../src/ai/assistant/knowledgeSemantic.js", () => ({ knowledgeSemanticIndexEnabled: mocks.enabled, pendingKnowledgeIndex: mocks.pending, indexCompanyKnowledge: mocks.index }));
vi.mock("../src/ai/assistant/tools/showingToolSupport.js", () => ({ loadToolActor: mocks.actor, asPluginExecutor: (executor: unknown) => executor }));
vi.mock("../src/lib/assistantActions.js", () => ({ AssistantActionError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
import { createKnowledgeSemanticTools } from "../src/ai/assistant/tools/knowledgeSemanticTools.js";
import type { AssistantActionExecutor } from "../src/lib/assistantActions.js";
const actor = { agentId: "staff", channel: "crm" as const, can: () => true };
const rows = [{ id: "knowledge", revision: 3, title: "Порядок показа" }];
function tool() {
  const plugin = createKnowledgeSemanticTools(mocks.options)[0];
  if (plugin.level === "A") throw new Error("Expected confirmed action");
  return { plugin, executor: plugin.executor as AssistantActionExecutor<Record<string, never>> };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({ actor: { id: "staff", role: "DIRECTOR" } });
  mocks.enabled.mockReturnValue(true); mocks.pending.mockResolvedValue(rows);
  mocks.index.mockResolvedValue({ indexed: 1, skipped: 0 }); mocks.options.mockReturnValue({ beforeAttempt: vi.fn() });
});
it("requires level C confirmation and hides indexing from read-only actors", () => {
  const { plugin, executor } = tool();
  expect(plugin.level).toBe("C");
  expect(executor.channels).toEqual(["crm"]);
  expect(plugin.allowed?.({ surface: "crm-private", role: "SHAREHOLDER" } as never)).toBe(false);
  expect(plugin.allowed?.({ surface: "crm-private", role: "AGENT" } as never)).toBe(false);
  expect(plugin.allowed?.({ surface: "telegram-private", role: "DIRECTOR" } as never)).toBe(false);
  expect(plugin.allowed?.({ surface: "crm-private", role: "DIRECTOR" } as never)).toBe(true);
  expect(plugin.allowed?.({ surface: "crm-private", role: "ADMIN" } as never)).toBe(true);
  expect(() => executor.parseArgs({ rows, override: true })).toThrow();
});
it("previews exact approved titles and versions without creating a paid request", async () => {
  const { executor } = tool();
  const snapshot = await executor.snapshot({}, actor);
  const preview = await executor.buildPreview({}, snapshot, actor);
  expect(snapshot).toEqual({ rows });
  expect(preview.becomes).toEqual({ "Знание 1": "Порядок показа (версия 3)" });
  expect(preview.risk).toContain("До 1 платных запросов Google");
  expect(mocks.index).not.toHaveBeenCalled(); expect(mocks.options).not.toHaveBeenCalled();
});
it.each(["snapshot", "execute"] as const)("rechecks revoked actor at %s before indexing or budget access", async (phase) => {
  mocks.actor.mockRejectedValue(new Error("actor revoked"));
  const { executor } = tool();
  const operation = phase === "snapshot" ? executor.snapshot({}, actor) : executor.execute({}, actor, { actionId: "approved", snapshotBefore: { rows } });
  await expect(operation).rejects.toThrow("actor revoked");
  expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.index).not.toHaveBeenCalled(); expect(mocks.options).not.toHaveBeenCalled();
});
it("refuses a disabled feature or empty batch before approval", async () => {
  const { executor } = tool();
  mocks.enabled.mockReturnValue(false);
  await expect(executor.snapshot({}, actor)).rejects.toThrow("выключен");
  await expect(executor.execute({}, actor, { actionId: "approved", snapshotBefore: { rows } })).rejects.toThrow("выключен");
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(mocks.index).not.toHaveBeenCalled();
  mocks.enabled.mockReturnValue(true); mocks.pending.mockResolvedValue([]);
  await expect(executor.snapshot({}, actor)).rejects.toThrow("Нет знаний");
  expect(mocks.options).not.toHaveBeenCalled();
});
it("executes only the broker-approved revisions and does not substitute a fresh batch", async () => {
  mocks.pending.mockResolvedValue([{ id: "unapproved", revision: 1, title: "Other" }]);
  const result = await tool().executor.execute({}, actor, { actionId: "approved", snapshotBefore: { rows } });
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(mocks.index).toHaveBeenCalledWith(rows, mocks.options.mock.results[0].value);
  expect(result.audit).toEqual({ entityType: "AssistantKnowledgeIndex", entityId: "approved" });
});
it("propagates partial-batch failure to broker without retrying paid indexing", async () => {
  mocks.index.mockRejectedValue(new Error("partial batch budget exhausted"));
  await expect(tool().executor.execute({}, actor, { actionId: "approved", snapshotBefore: { rows } })).rejects.toThrow("budget exhausted");
  expect(mocks.index).toHaveBeenCalledTimes(1);
});
it("rejects malformed persisted approval before invoking the budget factory", async () => {
  await expect(tool().executor.execute({}, actor, { actionId: "approved", snapshotBefore: { rows: [{ ...rows[0], revision: -1 }] } })).rejects.toThrow();
  expect(mocks.index).not.toHaveBeenCalled(); expect(mocks.options).not.toHaveBeenCalled();
});
