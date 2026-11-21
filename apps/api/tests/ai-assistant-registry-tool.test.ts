import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Шабнам и реестр строек (21.11.2026, ai/assistant/tools/registryReadTool.ts): поиск по названию отдаёт цвет, оценку
 * застройщика и дату обновления; в общей группе отказ; рубильник выключен — отказ. Данные тестовые, со своим runId.
 */
const { prisma } = await import("../src/db.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { groupHiddenToolsForTests } = await import("../src/telegram/assistantBot.js");

const runId = String(Date.now()).slice(-8);
const plugin = findAssistantToolPlugin("get_construction_registry");
if (!plugin || plugin.level !== "A") throw new Error("нет инструмента реестра");
type Actor = Parameters<typeof plugin.run>[1]["actor"];
const actor = (surface: string) => ({ agentId: "x", permissions: new Set(), surface, canViewPhone: false }) as unknown as Actor;
const call = (args: Record<string, unknown>, surface = "telegram-private") => plugin.run(args, { actor: actor(surface) }) as Promise<any>;

let developerId = "";
let projectId = "";
let runIdDb = "";
let prevEnabled = true;

beforeAll(async () => {
  prevEnabled = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { constructionRegistryEnabled: true } }))?.constructionRegistryEnabled ?? true;
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { constructionRegistryEnabled: true }, create: { id: "singleton", constructionRegistryEnabled: true } });
  developerId = (await prisma.constructionDeveloper.create({ data: { nameNormalized: `dev-${runId}`, displayName: `Застройщик ${runId}` } })).id;
  projectId = (
    await prisma.constructionProject.create({
      data: {
        sourceId: `t-${runId}`, qaror: `${runId}`, title: `ЖК Тестовый ${runId}`, customer: `Застройщик ${runId}`, colorStatus: "GREEN", listHash: "t",
        category: "residential", lat: 38.5, lng: 68.7, sourceUrl: "https://www.memor.pro/sokhtmon/test/", developerId,
      },
    })
  ).id;
  runIdDb = (await prisma.constructionSyncRun.create({ data: { trigger: "manual", ok: true, finishedAt: new Date() } })).id;
});

afterAll(async () => {
  await prisma.constructionSyncRun.deleteMany({ where: { id: runIdDb } });
  await prisma.constructionProject.deleteMany({ where: { id: projectId } });
  await prisma.constructionDeveloper.deleteMany({ where: { id: developerId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { constructionRegistryEnabled: prevEnabled } });
});

describe("get_construction_registry", () => {
  it("по названию: цвет, оценка и дата обновления", async () => {
    const r = await call({ query: `Тестовый ${runId}` });
    expect(r.found).toBe(1);
    expect(r.items[0].status).toBeTruthy();
    expect(r.updatedCaption).toBeTruthy();
  });
  it("в общей группе отказ, имя скрыто в группе", async () => {
    expect((await call({ query: "ЖК" }, "telegram-group")).error).toBeTruthy();
    expect(groupHiddenToolsForTests().has("get_construction_registry")).toBe(true);
  });
  it("без аргументов — просьба уточнить", async () => {
    expect((await call({})).error).toBeTruthy();
  });
  it("рубильник выключен — отказ", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { constructionRegistryEnabled: false } });
    expect((await call({ query: "ЖК" })).error).toMatch(/выключен/);
    await prisma.settings.update({ where: { id: "singleton" }, data: { constructionRegistryEnabled: true } });
  });
});
