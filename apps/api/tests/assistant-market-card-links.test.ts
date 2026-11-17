import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { formatClientCode, formatPropertyCode, type PermissionId } from "@royal-home/shared";

/**
 * Ссылки на карточки в ответах Шабнам про рынок (14.11.2026, ревью architect).
 *
 * Ответ помощницы со ссылкой /properties/ID или /clients/ID сверяется со ссылками, которые вернули инструменты ЭТОГО
 * хода (ai/assistant/cardLinkEvidence.ts); неизвестная ссылка подменяется на «Не удалось подтвердить ссылки».
 * Сторож класса: каждый инструмент ЧТЕНИЯ, который отдаёт ссылку или номер карточки, обязан быть известен
 * cardLinkEvidence. Иначе новый инструмент молча «ломает» ссылки в ответах, и тесты самого инструмента этого не видят.
 * Сквозной тест идёт через цикл помощницы (модель подменена), а не через tool.run напрямую.
 */

const callGeminiTools = vi.fn();
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"], model: "gemini-test", fallbackModels: [], transcribeModels: [], imageModel: "unused", liteModel: "", explicitCaching: false,
  }),
}));

const { prisma } = await import("../src/db.js");
const { runAssistantDetailed } = await import("../src/ai/assistant.js");
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { listAssistantToolPlugins } = await import("../src/ai/assistant/tools/index.js");
const { createCardLinkEvidence } = await import("../src/ai/assistant/cardLinkEvidence.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");

const runId = `${Date.now()}`.slice(-7) + randomInt(100, 999);
const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
const agentIds: string[] = [];
let managerId = "";
let clientId = "";
let clientShortId = 0;
let propertyId = "";
let propertyShortId = 0;
let districtId = "";
let savedEnabled = false;

const PERMS: PermissionId[] = ["clients.viewAll"];
const actor = () => actorFromAccess(managerId, { role: "MANAGER", permissions: new Set(PERMS) });

type Turn = { text: string; calls: { name: string; args: Record<string, unknown>; id?: string }[]; modelParts: unknown[]; tokens: number };
const textTurn = (text: string): Turn => ({ text, calls: [], modelParts: [{ text }], tokens: 1 });
const callsTurn = (calls: Turn["calls"]): Turn => ({ text: "", calls, modelParts: calls.map((c) => ({ functionCall: c })), tokens: 1 });

beforeAll(async () => {
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedEnabled = settings.aiAssistantEnabled;
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
  resetAssistantRuntimeCache();
  const mk = async (fullName: string, role: string) => {
    const row = await prisma.agent.create({ data: { fullName, phone: phone(), role: role as never, passwordHash: "x" } });
    agentIds.push(row.id);
    return row.id;
  };
  managerId = await mk(`Руководитель рынок ${runId}`, "MANAGER");
  const holderId = await mk(`Агент рынок ${runId}`, "AGENT");
  districtId = (await prisma.district.create({ data: { name: `Район ссылок ${runId}` } })).id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент ссылок ${runId}`, phone: phone(), source: "PHONE_CALL", kind: "BUYER", status: "NEW", assignedAgentId: holderId,
      assignedAt: new Date(Date.now() - 60 * 60_000), acceptedAt: new Date(Date.now() - 50 * 60_000), budgetMax: 500_000, currency: "TJS",
      desiredDistrictId: districtId, desiredRooms: 2,
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;
  const property = await prisma.property.create({
    data: { title: `Объект ссылок ${runId}`, type: "APARTMENT", areaSqm: 60, rooms: 2, price: 80000, currency: "TJS", condition: "GOOD", districtId, address: `Улица ${runId}` } as never,
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
});

beforeEach(() => callGeminiTools.mockReset());

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: savedEnabled } });
  resetAssistantRuntimeCache();
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await cleanupAssistantActionAgents(agentIds);
  await prisma.$disconnect();
});

describe("сторож класса: инструмент чтения со ссылкой или номером карточки известен cardLinkEvidence", () => {
  // Инструменты, чьи ссылки ведут НЕ в карточки клиентов/объектов (/deals, /team/...) и номеров карточек не отдают.
  const NOT_CARD_LINKS = new Set(["get_deal_card", "get_my_commission", "get_payouts_due", "list_staff", "get_staff_card", "staff_now"]);
  const CARD_MARKER = /propertyHref\(|\/clients\/\$\{|\/properties\/\$\{|\bshortId:\s*(?!true)/;

  it("каждый такой инструмент обработан в observe (иначе ответ со ссылкой подменяется отказом)", () => {
    const dir = new URL("../src/ai/assistant/tools/", import.meta.url);
    const evidenceSource = readFileSync(new URL("../src/ai/assistant/cardLinkEvidence.ts", import.meta.url), "utf8");
    const readNames = new Set(listAssistantToolPlugins().filter((p) => p.level === "A").map((p) => p.name));
    const missing: string[] = [];
    let checked = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(new URL(file, dir), "utf8");
      if (!CARD_MARKER.test(text)) continue;
      for (const name of [...text.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1])) {
        if (!readNames.has(name) || NOT_CARD_LINKS.has(name)) continue;
        checked++;
        if (!evidenceSource.includes(`case "${name}"`)) missing.push(`${name} (${file})`);
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });

  it("observe принимает ответы обоих рыночных инструментов: ссылка проходит, чужая нет", () => {
    const guard = createCardLinkEvidence();
    guard.observe("market_property_price", { code: "ОБ-000050", shortId: 50, href: "/properties/50", status: "ok" });
    guard.observe("market_for_client", { code: "ПК-000035", shortId: 35, href: "/clients/35", status: "ok" });
    expect(guard.validate("[ОБ-000050](/properties/50) и [ПК-000035](/clients/35)").ok).toBe(true);
    expect(guard.validate("/properties/51").ok).toBe(false);
    // Отказ инструмента ссылок не даёт.
    const denied = createCardLinkEvidence();
    denied.observe("market_for_client", { error: "Клиент не найден", shortId: 36, href: "/clients/36" });
    expect(denied.validate("/clients/36").ok).toBe(false);
  });
});

describe("цикл помощницы: ссылка на карточку после рыночных инструментов не отвергается", () => {
  it("market_property_price и market_for_client: ответ со ссылками доходит как есть", async () => {
    const propLink = `/properties/${propertyShortId}`;
    const clientLink = `/clients/${clientShortId}`;
    callGeminiTools
      .mockResolvedValueOnce(
        callsTurn([
          { name: "market_property_price", args: { propertyId: formatPropertyCode(propertyShortId) }, id: "c-prop" },
          { name: "market_for_client", args: { clientId: formatClientCode(clientShortId, "BUYER") }, id: "c-client" },
        ])
      )
      .mockResolvedValueOnce(textTurn(`Объект [${formatPropertyCode(propertyShortId)}](${propLink}) и клиент [${formatClientCode(clientShortId, "BUYER")}](${clientLink}).`));
    const outcome = await runAssistantDetailed([{ role: "user", content: "Как цена объекта и что на рынке для клиента?" }], actor(), { confirmUi: false, channel: "crm", deadlineMs: 20_000 });
    expect(outcome.ok).toBe(true);
    const reply = (outcome as { reply: string }).reply;
    expect(reply).toContain(propLink);
    expect(reply).toContain(clientLink);
    expect(reply).not.toContain("Не удалось подтвердить ссылки");
  });

  it("контроль: ссылка на карточку, которую инструменты не возвращали, по-прежнему подменяется отказом", async () => {
    callGeminiTools
      .mockResolvedValueOnce(callsTurn([{ name: "market_property_price", args: { propertyId: String(propertyShortId) }, id: "c-prop" }]))
      .mockResolvedValueOnce(textTurn(`Смотрите [другой](/properties/${propertyShortId + 9999}).`));
    const outcome = await runAssistantDetailed([{ role: "user", content: "Цена объекта?" }], actor(), { confirmUi: false, channel: "crm", deadlineMs: 20_000 });
    expect((outcome as { reply: string }).reply).toContain("Не удалось подтвердить ссылки");
  });
});
