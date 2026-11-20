import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * РАСКЛАДКА ГЛАВНОЙ НЕ СТИРАЕТСЯ ЧУЖИМ СОХРАНЕНИЕМ НАСТРОЕК (ревью #326, 20.11.2026).
 *
 * PUT /me/preferences заменяет документ целиком. Раскладку главной «Нового вида»
 * (`home`) шлёт только отдельное сохранение «Оформления»; старая вкладка или обычное
 * сохранение темы её не знают — и до этой правки молча стирали. Теперь тело без
 * `home` оставляет сохранённую, а явный сброс («Вернуть как было») по-прежнему сбрасывает.
 */
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
let agentId = "";
let token = "";
const put = (body: unknown) => request(app).put("/api/v1/me/preferences").set("Authorization", `Bearer ${token}`).send(body);
const stored = async () => ((await prisma.agent.findUnique({ where: { id: agentId }, select: { preferences: true } }))?.preferences ?? {}) as Record<string, unknown>;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент раскладки ${runId}`, phone: `+99297${tail}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  token = signAccessToken({ sub: agent.id, role: "AGENT" });
});
afterAll(async () => {
  await deleteAgentsWithTraces([agentId]);
});

describe("PUT /me/preferences и раскладка главной", () => {
  it("сохранение без `home` (тема, старая вкладка) оставляет сохранённую раскладку", async () => {
    const layout = { blocks: { AGENT: { hidden: ["agentMonth"], order: ["agentPending", "agentTiles"] } } };
    expect((await put({ theme: "royal-home-2026-light", home: layout })).status).toBe(200);
    const res = await put({ theme: "royal-home-2026-night", dismissedHints: ["x"] });
    expect(res.status).toBe(200);
    expect(res.body.home).toEqual(layout);
    const now = await stored();
    expect(now.home).toEqual(layout);
    expect(now.theme).toBe("royal-home-2026-night");
  });

  it("«Вернуть как было» (`home: { blocks: {} }`) сбрасывает раскладку", async () => {
    expect((await put({ theme: "royal-home-2026-light", home: { blocks: { AGENT: { hidden: ["agentMonth"] } } } })).status).toBe(200);
    const res = await put({ theme: "royal-home-2026-light", home: { blocks: {} } });
    expect(res.status).toBe(200);
    expect((await stored()).home).toEqual({ blocks: {} });
    // И следующее сохранение без `home` не воскрешает старую раскладку.
    await put({ theme: "royal-home-2026-light" });
    expect((await stored()).home).toEqual({ blocks: {} });
  });

  it("битая сохранённая раскладка не роняет сохранение и не переносится дальше", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { preferences: { home: { blocks: { HACKER: { hidden: ["x"] } } } } } });
    const res = await put({ theme: "royal-home-2026-light" });
    expect(res.status).toBe(200);
    expect((await stored()).home).toBeUndefined();
  });

  it("«Размер текста»: сохранение без поля его не стирает, выбор — меняет, чужое значение — 400", async () => {
    expect((await put({ theme: "royal-home-2026-light", textSize: "xlarge" })).status).toBe(200);
    const res = await put({ theme: "royal-home-2026-night" });
    expect(res.status).toBe(200);
    expect(res.body.textSize).toBe("xlarge");
    expect((await put({ theme: "royal-home-2026-night", textSize: "normal" })).status).toBe(200);
    expect((await stored()).textSize).toBe("normal");
    expect((await put({ theme: "royal-home-2026-night", textSize: "huge" })).status).toBe(400);
    // Битое сохранённое значение не переносится дальше.
    await prisma.agent.update({ where: { id: agentId }, data: { preferences: { textSize: "huge" } } });
    expect((await put({ theme: "royal-home-2026-light" })).status).toBe(200);
    expect((await stored()).textSize).toBeUndefined();
  });
});
