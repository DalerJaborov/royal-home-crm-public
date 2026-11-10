import { createKnowledgeSemanticTools } from "./knowledgeSemanticTools.js";
import { createAssistantEmbeddingMoneyGuard } from "../moneyBudget.js";
import { knowledgeTools } from "./knowledgeTools.js";
import { registerAssistantActionExecutor } from "../../../lib/assistantActions.js";
import { clientOwnershipTools } from "./clientOwnershipTools.js";
import { completeTaskTool } from "./completeTaskTool.js";
import { dealReadTools } from "./dealReadTools.js";
import { dealWriteTools } from "./dealWriteTools.js";
import { expenseTools } from "./expenseTools.js";
import { propertyTools } from "./propertyTools.js";
import { readTools } from "./readTools.js";
import { showingNoteTools } from "./showingNoteTools.js";
import { staffReadTools } from "./staffReadTools.js";
import { staffWriteTools } from "./staffWriteTools.js";
import { transferPropertyTool } from "./transferPropertyTool.js";
import type { AssistantToolPlugin } from "./types.js";

export type { AssistantToolPlugin } from "./types.js";

/**
 * Реестр плагинов. Каждая группа живёт в своём файле — исполнители разных групп
 * не правят один и тот же список (меньше конфликтов при слиянии).
 */
const plugins = new Map<string, AssistantToolPlugin>();

function add(plugin: AssistantToolPlugin): () => void {
  if (plugins.has(plugin.name)) throw new Error(`Инструмент помощника «${plugin.name}» уже зарегистрирован`);
  let unregisterExecutor: (() => void) | null = null;
  if (plugin.level !== "A") {
    if (plugin.executor.tool !== plugin.name) {
      throw new Error(`Исполнитель «${plugin.executor.tool}» не совпадает с именем инструмента «${plugin.name}»`);
    }
    unregisterExecutor = registerAssistantActionExecutor(plugin.executor as never);
  }
  plugins.set(plugin.name, plugin);
  return () => {
    if (plugins.get(plugin.name) === plugin) plugins.delete(plugin.name);
    unregisterExecutor?.();
  };
}

for (const plugin of [...createKnowledgeSemanticTools(() => ({ beforeAttempt: createAssistantEmbeddingMoneyGuard() })), ...knowledgeTools, ...readTools, ...clientOwnershipTools, ...propertyTools, ...showingNoteTools, completeTaskTool, ...expenseTools, ...dealReadTools, ...dealWriteTools, ...staffReadTools, ...staffWriteTools, transferPropertyTool]) add(plugin);

/** Для тестов: добавить плагин на время теста; возвращает функцию снятия. */
export function registerAssistantToolPlugin(plugin: AssistantToolPlugin): () => void {
  return add(plugin);
}

export function findAssistantToolPlugin(name: string): AssistantToolPlugin | null {
  return plugins.get(name) ?? null;
}

export function listAssistantToolPlugins(): AssistantToolPlugin[] {
  return [...plugins.values()];
}
