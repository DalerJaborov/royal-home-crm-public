import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { AVATAR_RETRY_AFTER_MS, contactAvatarPath, ensureContactAvatar } from "../src/lib/contactAvatar.js";
import { chatArchiveCutoff, isChatArchived } from "../src/lib/chatArchive.js";

/**
 * СПИСОК ЧАТОВ 26.11.2026: архив по правилу «без карточки и 30 дней тишины», имя безымянного по интересу,
 * миниатюра собеседника (одна загрузка на человека). Список читается через `channel=ARCHT…`: чужие строки общей
 * базы в проверки не попадают.
 */
const fetchInstagramProfileMock = vi.fn();
const safeOpenMock = vi.fn();
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  fetchInstagramProfile: (...args: unknown[]) => fetchInstagramProfileMock(...args),
}));
vi.mock("../src/lib/safeFetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/safeFetch.js")>()),
  safeOpen: (...args: unknown[]) => safeOpenMock(...args),
}));

const runId = Date.now();
const CHANNEL = `ARCHT${runId}`;
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-list-avatars-"));
process.env.PRIVATE_UPLOADS_DIR = privateDir;

let adminToken = "";
let adminId = "";
let clientId = "";
const botIds: Record<string, string> = {};
const profileIds: string[] = [];

const get = (path: string) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${adminToken}`);

async function listIds(extra = ""): Promise<{ ids: string[]; body: any }> {
  const response = await get(`/conversations?grouped=1&channel=${CHANNEL}${extra}`);
  expect(response.status).toBe(200);
  return { ids: response.body.items.map((item: { id: string }) => item.id), body: response.body };
}

async function setArchiveSwitch(value: boolean) {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { chatArchiveEnabled: value }, create: { id: "singleton", chatArchiveEnabled: value } });
}

async function makeConversation(key: string, data: Record<string, unknown>) {
  const row = await prisma.botConversation.create({
    data: {
      channel: CHANNEL,
      subscriberId: `archt-${runId}-${key}`,
      messages: [{ role: "user", content: `сообщение ${key}`, at: new Date().toISOString() }],
      ...data,
    } as never,
  });
  botIds[key] = row.id;
  return row;
}

beforeAll(async () => {
  const admin = await prisma.agent.create({ data: { fullName: `ArchT admin ${runId}`, phone: `+99291${String(runId).slice(-8)}1`, role: "ADMIN", passwordHash: "x" } });
  adminId = admin.id;
  adminToken = signAccessToken({ sub: adminId, role: "ADMIN" });
  const client = await prisma.client.create({ data: { fullName: `ArchT client ${runId}`, phone: `fixture-archt-${runId}`, source: "PHONE_CALL", acceptedAt: new Date(), assignedAgentId: adminId } });
  clientId = client.id;
  await setArchiveSwitch(true);

  // Границы правила: 30 суток и пять минут тишины, 30 суток без пяти минут, карточка клиента и давняя тишина.
  await makeConversation("old", { name: "ArchTarget старый", lastMessageAt: ago(30 * DAY + 5 * 60_000) });
  await makeConversation("edge", { name: "Почти тридцать суток", lastMessageAt: ago(30 * DAY - 5 * 60_000) });
  await makeConversation("carded", { clientId, name: "С карточкой", lastMessageAt: ago(90 * DAY) });
  await makeConversation("returns", { name: "Вернётся", lastMessageAt: ago(45 * DAY) });
  // Имена по интересу: безымянные с собранным leadDraft, и именованный, у которого имя главнее.
  await makeConversation("buyer", { lastMessageAt: ago(2 * 60_000), leadDraft: { stage: "chatting", intent: "buy", rooms: 2, districtName: "Шохмансур", budgetMax: 650000 } });
  await makeConversation("seller", { lastMessageAt: ago(3 * 60_000), leadDraft: { stage: "chatting", intent: "sell", rooms: 3, districtName: "Сино", budgetMax: 90000 } });
  await makeConversation("land", { lastMessageAt: ago(4 * 60_000), leadDraft: { stage: "chatting", intent: "buy", type: "участок", districtName: "Варзоб", budgetMax: 300000 } });
  await makeConversation("named", { name: "Фарида", lastMessageAt: ago(5 * 60_000), leadDraft: { stage: "chatting", intent: "buy", rooms: 1 } });
  await makeConversation("nothing", { lastMessageAt: ago(6 * 60_000) });
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { channel: CHANNEL } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: adminId } }).catch(() => undefined);
  fs.rmSync(privateDir, { recursive: true, force: true });
});

describe("правило архива чатов", () => {
  it("ровно 30 суток ещё не архив, с карточкой клиента не архивируется никогда (чистая функция)", async () => {
    const now = new Date("2026-11-26T10:00:00Z");
    const cutoff = chatArchiveCutoff(now);
    expect(now.getTime() - cutoff.getTime()).toBe(30 * DAY);
    expect(isChatArchived({ clientId: null, lastActivityAt: cutoff }, now)).toBe(false);
    expect(isChatArchived({ clientId: null, lastActivityAt: new Date(cutoff.getTime() - 1) }, now)).toBe(true);
    expect(isChatArchived({ clientId: "c1", lastActivityAt: new Date(cutoff.getTime() - 400 * DAY) }, now)).toBe(false);
  });

  it("«Все» не показывает архивные, «Архив» показывает только их, счётчики сходятся", async () => {
    const main = await listIds();
    expect(main.ids).toContain(botIds.edge);
    expect(main.ids).toContain(`client:${clientId}`);
    expect(main.ids).not.toContain(botIds.old);
    expect(main.ids).not.toContain(botIds.returns);
    expect(main.body.archiveEnabled).toBe(true);
    expect(main.body.counts.archived).toBe(2);
    expect(main.body.counts.all).toBe(main.ids.length);
    expect(main.body.total).toBe(main.ids.length);

    const archive = await listIds("&archived=1");
    expect(archive.ids.sort()).toEqual([botIds.old, botIds.returns].sort());
    expect(archive.body.total).toBe(2);
    // Вкладки считаются по основному списку и в архиве: архив их не раздувает.
    expect(archive.body.counts.all).toBe(main.body.counts.all);
  });

  it("поиск находит и архивные переписки", async () => {
    const found = await listIds("&q=ArchTarget");
    expect(found.ids).toEqual([botIds.old]);
  });

  it("новое сообщение клиента возвращает чат в основной список", async () => {
    await prisma.botConversation.update({ where: { id: botIds.returns }, data: { lastMessageAt: new Date() } });
    const main = await listIds();
    expect(main.ids).toContain(botIds.returns);
    expect((await listIds("&archived=1")).ids).toEqual([botIds.old]);
    expect(main.body.counts.archived).toBe(1);
  });

  it("выключенный рубильник возвращает прежний список: архива нет", async () => {
    await setArchiveSwitch(false);
    try {
      const main = await listIds();
      expect(main.ids).toContain(botIds.old);
      expect(main.body.archiveEnabled).toBe(false);
      expect(main.body.counts.archived).toBe(0);
      // Просьба «Архив» при выключенном рубильнике не прячет и не выдаёт только архивное.
      const asked = await listIds("&archived=1");
      expect(asked.ids).toContain(botIds.edge);
    } finally {
      await setArchiveSwitch(true);
    }
  });
});

describe("страницы списка (порция, без дублей)", () => {
  it("порция 40, вторая страница продолжает первую без повторов", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      channel: CHANNEL, subscriberId: `archt-${runId}-bulk-${i}`, lastMessageAt: ago((10 + i) * 60_000),
      messages: [{ role: "assistant", content: `bulk ${i}`, at: new Date().toISOString() }],
    }));
    await prisma.botConversation.createMany({ data: many as never });
    const first = await get(`/conversations?grouped=1&channel=${CHANNEL}&page=1`);
    const second = await get(`/conversations?grouped=1&channel=${CHANNEL}&page=2`);
    expect(first.body.pageSize).toBe(40);
    expect(first.body.items).toHaveLength(40);
    expect(second.body.items).toHaveLength(first.body.total - 40);
    const ids = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(first.body.total);
    // Порядок свежести сохраняется на стыке страниц.
    const times = [...first.body.items, ...second.body.items].map((item: { lastMessageAt: string }) => new Date(item.lastMessageAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe("имя безымянного чата по интересу", () => {
  const item = async (key: string) => (await listIds()).body.items.find((row: { id: string }) => row.id === botIds[key]);

  it("покупатель: «Ищет 2к · Шохмансур», бюджет и метка для кружка отдельно", async () => {
    const row = await item("buyer");
    expect(row.name).toBe("Ищет 2к · Шохмансур");
    expect(row.unnamed).toBe(true);
    expect(row.interest).toMatchObject({ budget: "до 650 тыс.", badge: "2к", kind: "buy" });
  });

  it("продавец и участок", async () => {
    expect((await item("seller")).name).toBe("Продаёт 3к · Сино");
    expect((await item("seller")).interest.kind).toBe("sell");
    const land = await item("land");
    expect(land.name).toBe("Ищет участок · Варзоб");
    expect(land.interest.badge).toBe("Уч.");
  });

  it("настоящее имя главнее интереса", async () => {
    const row = await item("named");
    expect(row.name).toBe("Фарида");
    expect(row.unnamed).toBe(false);
  });

  it("про интерес ничего не собрано: имени по интересу нет", async () => {
    const row = await item("nothing");
    expect(row.name).toBeNull();
    expect(row.interest).toBeNull();
    expect(row.unnamed).toBe(true);
  });
});

describe("миниатюра собеседника", () => {
  async function png() {
    return sharp({ create: { width: 400, height: 300, channels: 3, background: "#3366cc" } }).png().toBuffer();
  }
  const okResponse = async () => ({ res: new Response(new Uint8Array(await png()), { status: 200, headers: { "content-type": "image/png" } }) });

  it("грузит один раз: 96px webp в закрытое хранилище, повтор не качает второй раз", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    safeOpenMock.mockReset().mockImplementation(okResponse);

    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-1" })).toBe("stored");
    const saved = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(saved.avatarKey).toMatch(/^[0-9a-f-]{36}\.webp$/);
    expect(saved.avatarFetchedAt).not.toBeNull();
    const file = contactAvatarPath(saved.avatarKey!);
    expect(file).not.toBeNull();
    expect(file!.startsWith(path.join(privateDir, "avatars"))).toBe(true);
    const meta = await sharp(file!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 96, 96]);

    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-1" })).toBe("skipped");
    expect(fetchInstagramProfileMock).toHaveBeenCalledTimes(1);
    expect(safeOpenMock).toHaveBeenCalledTimes(1);
  });

  it("два входящих одновременно качают фото один раз", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    safeOpenMock.mockReset().mockImplementation(okResponse);
    const results = await Promise.all([1, 2, 3].map(() => ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-2" })));
    expect(results.filter((r) => r === "stored")).toHaveLength(1);
    expect(safeOpenMock).toHaveBeenCalledTimes(1);
  });

  it("канал не отдал фото: тихо без аватара, повтор не раньше недели", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    fetchInstagramProfileMock.mockReset().mockResolvedValue({});
    safeOpenMock.mockReset();
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-3" })).toBe("none");
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-3" })).toBe("skipped");
    expect(fetchInstagramProfileMock).toHaveBeenCalledTimes(1);
    const later = new Date(Date.now() + AVATAR_RETRY_AFTER_MS + 60_000);
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-3", now: later })).toBe("none");
    expect(fetchInstagramProfileMock).toHaveBeenCalledTimes(2);
    expect(safeOpenMock).not.toHaveBeenCalled();
    expect((await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } })).avatarKey).toBeNull();
  });

  it("отказ скачивания не бросает наружу и не оставляет файла", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    safeOpenMock.mockReset().mockRejectedValue(new Error("HTTP 401"));
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-4" })).toBe("failed");
    expect((await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } })).avatarKey).toBeNull();
  });

  it("WhatsApp фото не отдаёт: даже не пробуем и отметку не ставим", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    fetchInstagramProfileMock.mockReset();
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "WHATSAPP", subscriberId: "99290" })).toBe("skipped");
    expect((await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } })).avatarFetchedAt).toBeNull();
  });

  it("список отдаёт подписанную ссылку; по ней открывается только миниатюра, чужая подпись и чужое имя нет", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    safeOpenMock.mockReset().mockImplementation(okResponse);
    await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-5" });
    await prisma.botConversation.update({ where: { id: botIds.named }, data: { contactProfileId: profile.id } });

    const row = (await listIds()).body.items.find((r: { id: string }) => r.id === botIds.named);
    expect(row.avatarUrl).toMatch(/^\/api\/v1\/attachments\/s\/[0-9a-f-]{36}\.webp\?a=.+&e=\d+&k=.+&v=a$/);
    expect(row.avatarSeed).toBe(profile.id);
    const ok = await request(app).get(row.avatarUrl);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/webp");
    expect(ok.headers["cache-control"]).toMatch(/private/);

    const tampered = await request(app).get(row.avatarUrl.replace(/k=[^&]+/, "k=AAAAAAAAAAAAAAAAAAAAAA"));
    expect(tampered.status).toBe(403);
    // Подпись выдана на одно имя: подставить другой файл под неё нельзя.
    const otherName = row.avatarUrl.replace(/s\/[0-9a-f-]{36}\.webp/, "s/00000000-0000-0000-0000-000000000000.webp");
    expect((await request(app).get(otherName)).status).toBe(403);
    // Та же подпись без `v=a` не открывает миниатюру как вложение переписки.
    const asAttachment = await request(app).get(row.avatarUrl.replace("&v=a", ""));
    expect(asAttachment.status).not.toBe(200);
  });
});
