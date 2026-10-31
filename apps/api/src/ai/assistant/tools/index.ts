import { registerAssistantActionExecutor } from "../../../lib/assistantActions.js";
import { clientOwnershipTools } from "./clientOwnershipTools.js";
import { propertyTools } from "./propertyTools.js";
import { readTools } from "./readTools.js";
import { showingNoteTools } from "./showingNoteTools.js";
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

for (const plugin of [...readTools, ...clientOwnershipTools, ...propertyTools, ...showingNoteTools]) add(plugin);

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
