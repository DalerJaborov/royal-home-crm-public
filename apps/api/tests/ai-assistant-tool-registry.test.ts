import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_IDS, type PermissionId } from "@royal-home/shared";

/**
 * СОГЛАСОВАННОСТЬ РЕЕСТРА ИНСТРУМЕНТОВ ПОМОЩНИКА (сборка П3, 31.10.2026).
 *
 * Четыре группы (read, owner, prop, show) писали свои плагины параллельно, и
 * каждая в одиночку была зелёной. Здесь — то, что видно только на СВЕДЁННОМ
 * реестре: одно имя у модели на один инструмент (встроенные + плагины), у
 * записи исполнитель под тем же именем, описание и схема, которые Gemini
 * примет, запись не объявляется без карточки подтверждения и не объявляется в
 * Telegram, если исполнитель пускает только CRM (step-up там не ввести).
 * Проверяется на НАСТОЯЩЕМ `pluginDeclarations`, а не на копии фильтра.
 */

await import("../src/ai/assistant/tools/index.js");
const { listAssistantToolPlugins } = await import("../src/ai/assistant/tools/index.js");
const { BUILTIN_ASSISTANT_TOOL_NAMES, pluginDeclarations } = await import("../src/ai/assistant.js");
const { getAssistantActionExecutor } = await import("../src/lib/assistantActions.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");

const plugins = listAssistantToolPlugins();
const writePlugins = plugins.filter((p) => p.level !== "A");
/** Все права директора; feature flags проверяются отдельно от прав и каналов. */
const fullActor = actorFromAccess("registry-test-director", {
  role: "DIRECTOR",
  permissions: new Set<PermissionId>(PERMISSION_IDS),
}, "crm-private");

type Schema = Record<string, unknown>;

/** Пустая схема объекта (без свойств) где угодно в дереве — Gemini отвечает 400. */
function emptyObjectSchemas(schema: unknown, path = "parameters"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as Schema;
  const found: string[] = [];
  if (node.type === "object") {
    const props = node.properties as Schema | undefined;
    if (!props || Object.keys(props).length === 0) found.push(path);
    for (const [key, child] of Object.entries(props ?? {})) found.push(...emptyObjectSchemas(child, `${path}.${key}`));
    const required = (node.required as string[] | undefined) ?? [];
    for (const name of required) if (!props || !(name in props)) found.push(`${path}.required:${name}`);
  }
  if (node.type === "array") found.push(...emptyObjectSchemas(node.items, `${path}[]`));
  return found;
}

describe("реестр инструментов помощника", () => {
  beforeEach(() => vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "false"));
  afterEach(() => vi.unstubAllEnvs());

  it("в сводном реестре есть инструменты всех четырёх групп", () => {
    const names = plugins.map((p) => p.name);
    for (const name of [
      "find_clients",
      "find_property",
      "get_client_card",
      "get_client_last_call",
      "get_property_card",
      "get_property_work_status",
      "list_my_tasks",
      "change_client_agent",
      "change_property_price",
      "change_property_status",
      "request_property_change",
      "send_to_remake",
      "book_showing",
      "reschedule_showing",
      "cancel_showing",
      "add_client_note",
      "index_company_knowledge",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("имена уникальны среди встроенных и плагинов; snake_case латиницей", () => {
    const all = [...BUILTIN_ASSISTANT_TOOL_NAMES, ...plugins.map((p) => p.name)];
    const dupes = all.filter((name, i) => all.indexOf(name) !== i);
    expect(dupes).toEqual([]);
    for (const name of all) expect(name).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
  });

  it("последний звонок объявляется только в личных режимах", () => {
    expect(pluginDeclarations(fullActor, false, "crm").some(d => d.name === "get_client_last_call")).toBe(true);
    expect(pluginDeclarations({ ...fullActor, surface: "telegram-private" }, false, "telegram")
      .some(d => d.name === "get_client_last_call")).toBe(true);
    expect(pluginDeclarations({ ...fullActor, surface: "telegram-group" }, false, "telegram")
      .some(d => d.name === "get_client_last_call")).toBe(false);
  });

  it("у каждого плагина записи исполнитель под тем же именем и он зарегистрирован в брокере", () => {
    expect(writePlugins.length).toBeGreaterThan(0);
    for (const plugin of writePlugins) {
      expect(plugin.executor.tool, plugin.name).toBe(plugin.name);
      expect(getAssistantActionExecutor(plugin.name), plugin.name).toBe(plugin.executor);
    }
  });

  it("описание не пустое; схема параметров без пустых объектов, required — из свойств", () => {
    for (const plugin of plugins) {
      expect(plugin.description.trim().length, plugin.name).toBeGreaterThan(20);
      expect(plugin.statusPhrase.trim().length, plugin.name).toBeGreaterThan(0);
      if (plugin.parameters !== undefined) {
        expect(plugin.parameters.type, plugin.name).toBe("object");
        expect(emptyObjectSchemas(plugin.parameters), plugin.name).toEqual([]);
      }
    }
  });

  it.each([false, true])("без confirmUi модели объявляется только чтение — в обоих каналах; semantic flag=%s", (semanticEnabled) => {
    vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", String(semanticEnabled));
    const readNames = plugins.filter((p) => p.level === "A").map((p) => p.name).sort();
    for (const channel of ["crm", "telegram"] as const) {
      const declared = pluginDeclarations(fullActor, false, channel).map((d) => d.name).sort();
      expect(declared).toEqual(readNames);
    }
    // По умолчанию (без явного канала) — тоже.
    expect(pluginDeclarations(fullActor, false).map((d) => d.name).sort()).toEqual(readNames);
  });

  it.each([false, true])("с confirmUi объявлены все применимые инструменты; semantic flag=%s", (semanticEnabled) => {
    vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", String(semanticEnabled));
    const applicable = plugins.filter((p) => semanticEnabled || p.name !== "index_company_knowledge");
    const crm = pluginDeclarations(fullActor, true, "crm").map((d) => d.name);
    // При включённом флаге сверяем ВЕСЬ реестр, без фильтра по allowed.
    expect(crm.sort()).toEqual(applicable.map((p) => p.name).sort());

    const telegram = new Set(pluginDeclarations(fullActor, true, "telegram").map((d) => d.name));
    for (const plugin of writePlugins) {
      const allowsTelegram = (plugin.executor.channels ?? ["crm"]).includes("telegram");
      expect(telegram.has(plugin.name), `${plugin.name} (каналы: ${plugin.executor.channels ?? "только crm"})`).toBe(
        allowsTelegram && (semanticEnabled || plugin.name !== "index_company_knowledge"),
      );
    }
    // Передача клиента — опасная зона: только CRM.
    expect(telegram.has("change_client_agent")).toBe(false);
  });

  it.each([false, true])("объявление модели совпадает с плагином: имя, описание, схема; semantic flag=%s", (semanticEnabled) => {
    vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", String(semanticEnabled));
    const declared = new Map(pluginDeclarations(fullActor, true, "crm").map((d) => [d.name, d]));
    for (const plugin of plugins) {
      if (plugin.name === "index_company_knowledge" && !semanticEnabled) {
        expect(declared.has(plugin.name)).toBe(false);
        continue;
      }
      const d = declared.get(plugin.name)!;
      expect(d, plugin.name).toBeDefined();
      expect(d.description).toBe(plugin.description);
      if (plugin.parameters) expect(d.parameters).toEqual(plugin.parameters);
      else expect("parameters" in d).toBe(false);
    }
  });
});
