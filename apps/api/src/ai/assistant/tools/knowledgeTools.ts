import { isReadOnlyRole, assistantKnowledgeArchiveSchema, assistantKnowledgeSearchSchema, type AssistantKnowledgeInput } from "@royal-home/shared";
import { loadAgentAccess } from "../../../auth/middleware.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { getCompanyKnowledge, searchCompanyKnowledge, saveCompanyKnowledge, validateCompanyKnowledge, knowledgeContext, KnowledgeConflict } from "../knowledge.js";
import { loadToolActor, asPluginExecutor } from "./showingToolSupport.js";
import type { AssistantToolPlugin } from "./types.js";

const fields = (label: string, text: string): Record<string, string> => Object.fromEntries(
  (text.match(/[\s\S]{1,100}/g) ?? []).map((part, i) => [`${label} ${i + 1}`, part]));
export const saveKnowledgeExecutor: AssistantActionExecutor<AssistantKnowledgeInput> = {
  tool: "save_company_knowledge", channels: ["crm", "telegram"], parseArgs: (raw) => validateCompanyKnowledge(raw),
  async snapshot(args, actor) {
    await loadToolActor(actor);
    const row = await getCompanyKnowledge(args.title);
    return { revision: row?.revision ?? 0, content: row?.content ?? "нет", source: row?.source ?? "нет", archived: row?.archived ?? false };
  },
  buildPreview(args, before) {
    return { title: "Общее знание для ВСЕХ сотрудников", was: { Версия: before.revision, ...fields("Текст", String(before.content)) },
      becomes: { Название: args.title, ...fields("Текст", args.content), ...fields("Источник", args.source), Срок: args.validUntil ?? "без срока" },
      risk: "Будет доступно всем сотрудникам, включая группу. Только общие рабочие знания, без персональных и клиентских данных." };
  },
  async execute(args, actor, ctx) {
    await loadToolActor(actor);
    try {
      const row = await saveCompanyKnowledge(args, actor.agentId, Number(ctx.snapshotBefore.revision));
      return { result: { id: row.id, title: row.title, revision: row.revision, status: "Сохранено в общей памяти" }, audit: { entityType: "AssistantKnowledge", entityId: row.id } };
    } catch (err) { if (err instanceof KnowledgeConflict) throw new AssistantActionError(409, "STALE", err.message); throw err; }
  },
};
export const archiveKnowledgeExecutor: AssistantActionExecutor<{ title: string }> = {
  tool: "archive_company_knowledge", channels: ["crm", "telegram"], parseArgs: (raw) => assistantKnowledgeArchiveSchema.parse(raw),
  async snapshot(args, actor) {
    await loadToolActor(actor);
    const row = await getCompanyKnowledge(args.title);
    if (!row || row.archived) throw new AssistantActionError(404, "NOT_FOUND", "Активное знание не найдено");
    return { revision: row.revision, content: row.content, source: row.source, validUntil: row.validUntil?.toISOString() ?? null };
  },
  buildPreview(args, before) { return { title: "Убрать знание из ответов всем сотрудникам", was: { Название: args.title, Версия: before.revision },
    becomes: { Статус: "Архив, больше не используется в ответах" }, risk: "История версий останется для аудита." }; },
  async execute(args, actor, ctx) {
    await loadToolActor(actor);
    try {
      const row = await saveCompanyKnowledge({ title: args.title, content: String(ctx.snapshotBefore.content), source: String(ctx.snapshotBefore.source), validUntil: typeof ctx.snapshotBefore.validUntil === "string" ? ctx.snapshotBefore.validUntil : null }, actor.agentId, Number(ctx.snapshotBefore.revision), true);
      return { result: { id: row.id, status: "Архивировано, исключено из ответов" }, audit: { entityType: "AssistantKnowledge", entityId: row.id } };
    } catch (err) { if (err instanceof KnowledgeConflict) throw new AssistantActionError(409, "STALE", err.message); throw err; }
  },
};
export const knowledgeTools: AssistantToolPlugin[] = [
  { name: "search_company_knowledge", level: "A", statusPhrase: "Проверяю общие знания…",
    description: "Найти подтверждённые общие знания компании. Используй для правил и инструкций; пустой query показывает последние 6. Укажи источник и версию. Клиентов, цены и доступ проверяй отдельными инструментами CRM.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    async run(raw, { actor }) {
      const access = await loadAgentAccess(actor.id);
      if (!access?.isActive) throw new AssistantActionError(403, "FORBIDDEN", "Учётная запись недоступна");
      return { knowledge: knowledgeContext(await searchCompanyKnowledge(assistantKnowledgeSearchSchema.parse(raw).query)) };
    } },
  { name: "save_company_knowledge", level: "C", statusPhrase: "Готовлю общее знание…", allowed: (actor) => !isReadOnlyRole(actor.role),
    description: "Сохранить или исправить ОБЩЕЕ знание для ВСЕХ сотрудников только по явной просьбе запомнить/исправить для компании. Не сохраняй переписку автоматически, персональные/клиентские данные или секреты. Title точно совпадает с названием обновляемой записи. Content — точный согласованный текст, source — откуда известно; при отсутствии источника спроси. Всегда требуется кнопка подтверждения.",
    parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, source: { type: "string" }, validUntil: { type: "string", description: "Необязательно: ISO дата со смещением, срок актуальности" } }, required: ["title", "content", "source"] },
    executor: asPluginExecutor(saveKnowledgeExecutor) },
  { name: "archive_company_knowledge", level: "C", statusPhrase: "Готовлю архивирование знания…", allowed: (actor) => !isReadOnlyRole(actor.role),
    description: "По явной просьбе забыть/удалить общее знание убрать его из ответов всем. История остаётся для аудита. Сначала найди точное название, затем покажи подтверждение.",
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, executor: asPluginExecutor(archiveKnowledgeExecutor) },
];
