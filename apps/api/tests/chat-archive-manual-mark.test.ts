import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { isChatArchived } from "../src/lib/chatArchive.js";

/**
 * РУЧНОЙ АРХИВ (27.11.2026): «В архив» / «Вернуть» из строки списка, возврат новым входящим, фото в шапке переписки.
 * Список читается через `channel=MARK…`: чужие строки общей базы в проверки не попадают.
 */
const runId = Date.now();
const CHANNEL = `MARK${runId}`;
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

let adminToken = "";
let adminId = "";
let bossToken = "";
let bossId = "";
let clientId = "";
let profileId = "";
const ids: Record<string, string> = {};

const get = (path: string) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${adminToken}`);
const mark = (id: string, action: string) => request(app).post("/api/v1/conversations/archive-mark").set("Authorization", `Bearer ${adminToken}`).send({ id, action });

async function listIds(extra = ""): Promise<string[]> {
  const response = await get(`/conversations?grouped=1&channel=${CHANNEL}${extra}`);
  expect(response.status).toBe(200);
  return response.body.items.map((item: { id: string }) => item.id);
}

async function make(key: string, data: Record<string, unknown>) {
  const at = (data.lastMessageAt as Date | undefined) ?? new Date();
  const row = await prisma.botConversation.create({
    data: { channel: CHANNEL, subscriberId: `mark-${runId}-${key}`, messages: [{ role: "user", content: key, at: at.toISOString() }], ...data } as never,
  });
  ids[key] = row.id;
}

beforeAll(async () => {
  const admin = await prisma.agent.create({ data: { fullName: `Mark admin ${runId}`, phone: `+99292${String(runId).slice(-8)}1`, role: "ADMIN", passwordHash: "x" } });
  adminId = admin.id;
  adminToken = signAccessToken({ sub: adminId, role: "ADMIN" });
  const boss = await prisma.agent.create({ data: { fullName: `Mark boss ${runId}`, phone: `+99293${String(runId).slice(-8)}2`, role: "ADMIN", passwordHash: "x" } });
  bossId = boss.id;
  bossToken = signAccessToken({ sub: bossId, role: "ADMIN" });
  const client = await prisma.client.create({ data: { fullName: `Mark client ${runId}`, phone: `fixture-mark-${runId}`, source: "PHONE_CALL", acceptedAt: new Date(), assignedAgentId: adminId } });
  clientId = client.id;
  const profile = await prisma.contactProfile.create({ data: { avatarKey: `${randomUUID()}.webp` } });
  profileId = profile.id;
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { chatArchiveEnabled: true }, create: { id: "singleton", chatArchiveEnabled: true } });
  await make("fresh", { lastMessageAt: ago(60_000), contactProfileId: profileId });
  await make("old", { lastMessageAt: ago(45 * DAY) });
  await make("carded", { clientId, lastMessageAt: ago(2 * 60_000) });
});

afterAll(async () => {
  await prisma.customerInquiry.deleteMany({ where: { endpointScope: { channel: CHANNEL } } }).catch(() => undefined);
  await prisma.botConversation.deleteMany({ where: { channel: CHANNEL } });
  await prisma.contactProfile.deleteMany({ where: { id: profileId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, bossId] } } }).catch(() => undefined);
});

describe("ручной архив: правило над одной строкой", () => {
  const now = new Date("2026-11-27T10:00:00Z");
  const base = { clientId: null, lastActivityAt: new Date(now.getTime() - 40 * DAY), lastMessageAt: new Date(now.getTime() - 40 * DAY) };
  it("метка «в архив» главнее карточки и свежести, пока нет нового входящего", () => {
    const fresh = { clientId: "c1", lastActivityAt: new Date(now.getTime() - 60_000), lastMessageAt: new Date(now.getTime() - 60_000) };
    expect(isChatArchived({ ...fresh, archiveMark: "ARCHIVED", archiveMarkAt: now, archiveMarkById: "me" }, now, "me")).toBe(true);
    // Чужая отметка не прячет: агент не уберёт чат у руководства.
    expect(isChatArchived({ ...fresh, archiveMark: "ARCHIVED", archiveMarkAt: now, archiveMarkById: "agent" }, now, "boss")).toBe(false);
    // Пришло новое входящее после метки: чат возвращается сам.
    expect(isChatArchived({ ...fresh, lastMessageAt: new Date(now.getTime() + 1000), archiveMark: "ARCHIVED", archiveMarkAt: now, archiveMarkById: "me" }, now, "me")).toBe(false);
  });
  it("«Вернуть» держит старый чат без карточки в списке, но не дольше следующего простоя", () => {
    expect(isChatArchived(base, now)).toBe(true);
    expect(isChatArchived({ ...base, archiveMark: "RESTORED", archiveMarkAt: now, archiveMarkById: "me" }, now, "me")).toBe(false);
  });
});

describe("POST /conversations/archive-mark", () => {
  it("плохие данные и чужой id", async () => {
    expect((await mark("", "archive")).status).toBe(400);
    expect((await mark(ids.fresh, "delete")).status).toBe(400);
    expect((await mark(randomUUID(), "archive")).status).toBe(404);
    expect((await request(app).post("/api/v1/conversations/archive-mark").send({ id: ids.fresh, action: "archive" })).status).toBe(401);
  });

  it("«В архив» убирает чат из «Все» и кладёт в «Архив»; «Вернуть» возвращает", async () => {
    expect(await listIds()).toContain(ids.fresh);
    expect((await mark(ids.fresh, "archive")).status).toBe(200);
    expect(await listIds()).not.toContain(ids.fresh);
    expect(await listIds("&archived=1")).toContain(ids.fresh);
    const counts = (await get(`/conversations?grouped=1&channel=${CHANNEL}`)).body.counts;
    expect(counts.archived).toBeGreaterThanOrEqual(2);

    expect((await mark(ids.fresh, "restore")).status).toBe(200);
    expect(await listIds()).toContain(ids.fresh);
    expect(await listIds("&archived=1")).not.toContain(ids.fresh);
  });

  it("отметка действует только у поставившего: у другого сотрудника чат остаётся в списке", async () => {
    await mark(ids.fresh, "restore");
    expect((await mark(ids.fresh, "archive")).status).toBe(200);
    expect(await listIds()).not.toContain(ids.fresh);
    const boss = await request(app).get(`/api/v1/conversations?grouped=1&channel=${CHANNEL}`).set("Authorization", `Bearer ${bossToken}`);
    expect(boss.body.items.map((item: { id: string }) => item.id)).toContain(ids.fresh);
    // В поиске архивная строка помечена: на ней «Вернуть», а не «В архив».
    const found = await get(`/conversations?grouped=1&channel=${CHANNEL}&q=fresh`);
    expect(found.body.items.find((item: { id: string }) => item.id === ids.fresh)?.archived).toBe(true);
    await mark(ids.fresh, "restore");
  });

  it("новое входящее после «В архив» само возвращает чат в список", async () => {
    await mark(ids.fresh, "archive");
    expect(await listIds("&archived=1")).toContain(ids.fresh);
    await prisma.botConversation.update({ where: { id: ids.fresh }, data: { lastMessageAt: new Date(Date.now() + 5000) } });
    expect(await listIds()).toContain(ids.fresh);
    expect(await listIds("&archived=1")).not.toContain(ids.fresh);
  });

  it("давний чат без карточки лежит в архиве сам; «Вернуть» оставляет его в списке", async () => {
    expect(await listIds("&archived=1")).toContain(ids.old);
    expect((await mark(ids.old, "restore")).status).toBe(200);
    expect(await listIds()).toContain(ids.old);
    expect(await listIds("&archived=1")).not.toContain(ids.old);
  });

  it("чат с карточкой клиента архивируется вручную по `client:…` целиком", async () => {
    const group = `client:${clientId}`;
    expect(await listIds()).toContain(group);
    expect((await mark(group, "archive")).status).toBe(200);
    expect(await listIds()).not.toContain(group);
    expect(await listIds("&archived=1")).toContain(group);
    await mark(group, "restore");
    expect(await listIds()).toContain(group);
  });

  it("выключенный рубильник: ручная отметка ничего не прячет", async () => {
    await mark(ids.fresh, "restore");
    await mark(ids.fresh, "archive");
    await prisma.settings.update({ where: { id: "singleton" }, data: { chatArchiveEnabled: false } });
    try {
      expect(await listIds()).toContain(ids.fresh);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { chatArchiveEnabled: true } });
    }
  });
});

describe("фото в шапке открытой переписки", () => {
  it("детали переписки отдают ту же подписанную ссылку на миниатюру, что и список", async () => {
    await mark(ids.fresh, "restore");
    const detail = await get(`/conversations/${ids.fresh}`);
    expect(detail.status).toBe(200);
    expect(detail.body.avatarUrl).toMatch(/^\/api\/v1\/attachments\/s\/[0-9a-f-]{36}\.webp\?/);
    expect(detail.body.avatarSeed).toBe(profileId);
    const list = await get(`/conversations?grouped=1&channel=${CHANNEL}`);
    const row = list.body.items.find((r: { id: string }) => r.id === ids.fresh);
    expect(row?.avatarSeed).toBe(profileId);
  });
});
