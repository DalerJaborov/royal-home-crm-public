import { z } from "zod";
import { assistantKnowledgeIndexSchema } from "@royal-home/shared";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { indexCompanyKnowledge, knowledgeSemanticIndexEnabled, pendingKnowledgeIndex, type KnowledgeEmbeddingOptions } from "../knowledgeSemantic.js";
import { loadToolActor, asPluginExecutor } from "./showingToolSupport.js";
import type { AssistantToolPlugin } from "./types.js";

const snapshotRows = z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive(), title: z.string().max(100) })).max(10);

const indexOperator = (role: string) => role === "DIRECTOR" || role === "ADMIN";

async function requireIndexOperator(actor: AssistantActionActor): Promise<void> {
  if (actor.channel !== "crm" || !indexOperator((await loadToolActor(actor)).actor.role)) {
    throw new AssistantActionError(403, "FORBIDDEN", "Обновлять индекс может только администратор или директор в CRM");
  }
}

/** Root supplies the same spending reservation policy used by query embeddings. No unbudgeted default. */
export function createKnowledgeSemanticTools(options: () => KnowledgeEmbeddingOptions): AssistantToolPlugin[] {
  const executor: AssistantActionExecutor<Record<string, never>> = {
    tool: "index_company_knowledge", channels: ["crm"],
    parseArgs: (raw) => assistantKnowledgeIndexSchema.parse(raw),
    async snapshot(_args, actor) {
      await requireIndexOperator(actor);
      if (!knowledgeSemanticIndexEnabled()) throw new AssistantActionError(409, "DISABLED", "Индексация общих знаний выключена");
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
      await requireIndexOperator(actor);
      if (!knowledgeSemanticIndexEnabled()) throw new AssistantActionError(409, "DISABLED", "Индексация общих знаний выключена");
      const rows = snapshotRows.parse(ctx.snapshotBefore.rows);
      const result = await indexCompanyKnowledge(rows, options());
      return { result: { ...result, status: "Пакет поискового индекса обработан" },
        audit: { entityType: "AssistantKnowledgeIndex", entityId: ctx.actionId } };
    },
  };
  return [{ name: executor.tool, level: "C", statusPhrase: "Готовлю обновление поиска знаний…",
    allowed: (actor) => actor.surface === "crm-private" && indexOperator(actor.role) && knowledgeSemanticIndexEnabled(),
    description: "Только по явной просьбе администратора или директора в CRM. Подготовь индекс утверждённых редакций пилота и дождись подтверждения платных запросов Google. Сохранение правила и обычный вопрос не запускают индексацию.",
    executor: asPluginExecutor(executor) }];
}
