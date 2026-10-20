import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ГРУППЫ ДУБЛЕЙ НЕ ОТДАЮТ ИСТОЧНИК КЛИЕНТА БЕЗ clients.viewOrigin
 * (аудит Codex 04.10.2026, ACCESS-01, расширение).
 *
 * Так было: маска строки закрывала только номер и имя, а source, telegramChatId и
 * telegramUsername уходили всякому с clients.merge — ник в Telegram это дорога к
 * клиенту в обход агентства (lib/clientOrigin.ts).
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const TG_ID = `tg-origin-${runId}`;
const TG_USER = `origin_user_${runId}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
let blindToken = "";
let seeingToken = "";

beforeAll(async () => {
  const mkAgent = async (phone: string, permissions: unknown) =>
    (
      await prisma.agent.create({
        data: { fullName: `Слияние ${phone}`, phone, role: "MANAGER", passwordHash: "x", permissions: permissions as never },
      })
    ).id;
  const blind = await mkAgent(`+99291${tail}`, { granted: ["clients.merge", "clients.viewPhone"], revoked: ["clients.viewOrigin"] });
  const seeing = await mkAgent(`+99292${tail}`, { granted: ["clients.merge", "clients.viewPhone", "clients.viewOrigin"], revoked: [] });
  agentIds.push(blind, seeing);
  blindToken = signAccessToken({ sub: blind, role: "MANAGER" });
  seeingToken = signAccessToken({ sub: seeing, role: "MANAGER" });
  // Chat id в базе уникален, поэтому ник и чат есть у одной карточки, а пару в группу
  // собирает один и тот же номер, записанный по-разному.
  const phones = [`+99293${tail}1`, `+992 93${tail}1`];
  for (const [i, phone] of phones.entries()) {
    const c = await prisma.client.create({
      data: {
        fullName: `Дубль Источника ${i}`,
        phone,
        kind: "BUYER",
        source: "TELEGRAM",
        ...(i === 0 ? { telegramChatId: TG_ID, telegramUsername: TG_USER } : {}),
      } as never,
    });
    clientIds.push(c.id);
  }
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("GET /clients/duplicates", () => {
  it("без clients.viewOrigin источник и Telegram-идентификаторы скрыты", async () => {
    const res = await request(app).get("/api/v1/clients/duplicates").set("Authorization", `Bearer ${blindToken}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(TG_ID);
    expect(text).not.toContain(TG_USER);
    const group = (res.body as Array<{ clients: Array<{ id: string; source: unknown }> }>).find((g) =>
      g.clients.some((c) => clientIds.includes(c.id))
    );
    expect(group).toBeTruthy();
    expect(group!.clients.every((c) => c.source === null)).toBe(true);
  });

  it("с clients.viewOrigin отдаётся как есть", async () => {
    const res = await request(app).get("/api/v1/clients/duplicates").set("Authorization", `Bearer ${seeingToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(TG_ID);
  });
});
