import { sendFinanceReportPdfTool } from "./financeReportPdfTool.js";
import { createKnowledgeSemanticTools } from "./knowledgeSemanticTools.js";
import { createAssistantEmbeddingMoneyGuard } from "../moneyBudget.js";
import { knowledgeTools } from "./knowledgeTools.js";
import { groupQuietPlugin } from "./groupQuietTool.js";
import { startPropertyDraftTool } from "./startPropertyDraftTool.js";
import { notificationPrefPlugin } from "./notificationPrefTool.js";
import { registerAssistantActionExecutor } from "../../../lib/assistantActions.js";
import { brainReadTools } from "./brainReadTools.js";
import { getClientBaseOverviewTool } from "./clientBaseOverviewTool.js";
import { getConstructionRegistryTool } from "./registryReadTool.js";
import { linkPropertyRegistryTool } from "./registryLinkTool.js";
import { clientOwnershipTools } from "./clientOwnershipTools.js";
import { completeTaskTool } from "./completeTaskTool.js";
import { dealReadTools } from "./dealReadTools.js";
import { dealWriteTools } from "./dealWriteTools.js";
import { directorTools } from "./directorTools.js";
import { expenseTools } from "./expenseTools.js";
import { marketTools } from "./marketTools.js";
import { propertyTools } from "./propertyTools.js";
import { readTools } from "./readTools.js";
import { sendStaffMessagePlugin } from "./sendStaffMessageTool.js";
import { showingNoteTools } from "./showingNoteTools.js";
import { staffReadTools } from "./staffReadTools.js";
import { staffWriteTools } from "./staffWriteTools.js";
import { transferPropertyTool } from "./transferPropertyTool.js";
import type { AssistantToolPlugin } from "./types.js";
import type { AssistantActor } from "../actor.js";
import { isReadOnlyRole } from "@royal-home/shared";

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

for (const plugin of [...createKnowledgeSemanticTools(() => ({ beforeAttempt: createAssistantEmbeddingMoneyGuard() })), ...knowledgeTools, ...readTools, ...clientOwnershipTools, ...propertyTools, ...showingNoteTools, completeTaskTool, ...expenseTools, ...dealReadTools, ...dealWriteTools, ...marketTools, ...staffReadTools, ...staffWriteTools, transferPropertyTool, notificationPrefPlugin, groupQuietPlugin, startPropertyDraftTool, ...brainReadTools, getConstructionRegistryTool, linkPropertyRegistryTool, getClientBaseOverviewTool, sendStaffMessagePlugin, ...directorTools, sendFinanceReportPdfTool]) add(plugin);

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

/**
 * ДОСТУПЕН ЛИ ИНСТРУМЕНТ АКТОРУ — ОДНО МЕСТО (27.11.2026).
 *
 * Сверху `allowed` самого инструмента — общий запрет режима просмотра: запись (B, C)
 * роли «только смотрит» (акционер) не объявляется и не исполняется, даже если автор
 * нового инструмента забыл это в своём `allowed`. Исключение — исполнитель с флагом
 * `readOnlyRoleAllowed` (своё: «не присылать такое»). Сервер держит то же брокером
 * (lib/assistantActions.ts, assertRoleMayWrite) — это подсказка модели, а там защита.
 */
export function assistantPluginAllowed(plugin: AssistantToolPlugin, actor: AssistantActor): boolean {
  if (plugin.level !== "A" && isReadOnlyRole(actor.role) && !plugin.executor.readOnlyRoleAllowed) return false;
  return plugin.allowed ? plugin.allowed(actor) : true;
}
