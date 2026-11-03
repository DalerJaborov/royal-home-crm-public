import { z } from "zod";
import { assistantKnowledgeIndexSchema, isReadOnlyRole } from "@royal-home/shared";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { indexCompanyKnowledge, knowledgeSemanticEnabled, pendingKnowledgeIndex, type KnowledgeEmbeddingOptions } from "../knowledgeSemantic.js";
import { loadToolActor, asPluginExecutor } from "./showingToolSupport.js";
import type { AssistantToolPlugin } from "./types.js";

const snapshotRows = z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive(), title: z.string().max(100) })).max(10);

/** Root supplies the same spending reservation policy used by query embeddings. No unbudgeted default. */
export function createKnowledgeSemanticTools(options: () => KnowledgeEmbeddingOptions): AssistantToolPlugin[] {
  const executor: AssistantActionExecutor<Record<string, never>> = {
    tool: "index_company_knowledge", channels: ["crm", "telegram"],
    parseArgs: (raw) => assistantKnowledgeIndexSchema.parse(raw),
    async snapshot(_args, actor) {
      await loadToolActor(actor);
      if (!knowledgeSemanticEnabled()) throw new AssistantActionError(409, "DISABLED", "Поиск общих знаний по смыслу пока выключен");
      const rows = await pendingKnowledgeIndex();
      if (!rows.length) throw new AssistantActionError(409, "NO_WORK", "Нет знаний, ожидающих индексации");
      return { rows: rows.map(({ id, revision, title }) => ({ id, revision, title })) };
    },
    buildPreview(_args, before) {
      const rows = snapshotRows.parse(before.rows);
      return {
        title: "Подготовить поиск общих знаний по смыслу",
        was: { Ожидают: rows.length },
        becomes: Object.fromEntries(rows.map((row, index) => [`Знание ${index + 1}`, `${row.title} (версия ${row.revision})`])),
        risk: `До ${rows.length} платных запросов Google. Исходные знания не изменятся; сохранится поисковый индекс.`,
      };
    },
    async execute(_args, actor, ctx) {
      await loadToolActor(actor);
      const rows = snapshotRows.parse(ctx.snapshotBefore.rows);
      const result = await indexCompanyKnowledge(rows, options());
      return { result: { ...result, status: "Пакет поискового индекса обработан" },
        audit: { entityType: "AssistantKnowledgeIndex", entityId: ctx.actionId } };
    },
  };
  return [{ name: executor.tool, level: "C", statusPhrase: "Готовлю обновление поиска знаний…",
    allowed: (actor) => !isReadOnlyRole(actor.role) && knowledgeSemanticEnabled(),
    description: "Только по явной просьбе обновить поиск общих знаний по смыслу. Готовит максимум 10 новых/изменённых записей, требует кнопку подтверждения платных Google-запросов. Не запускай автоматически после сохранения или обычного вопроса. Остальные записи обрабатываются отдельной явной просьбой.",
    executor: asPluginExecutor(executor) }];
}
