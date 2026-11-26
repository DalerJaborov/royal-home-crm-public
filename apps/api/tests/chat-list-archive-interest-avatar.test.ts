import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { AVATAR_REFRESH_AFTER_MS, AVATAR_RETRY_AFTER_MS, cleanupOrphanContactAvatars, contactAvatarPath, ensureContactAvatar } from "../src/lib/contactAvatar.js";
import { ensureConversationContactProfile } from "../src/messengers/conversationStore.js";
import { isInstagramKeyRefusal } from "../src/lib/instagramAccountAccess.js";
import { chatArchiveCutoff, isChatArchived } from "../src/lib/chatArchive.js";

/**
 * СПИСОК ЧАТОВ 26.11.2026: архив по правилу «без карточки и 30 дней тишины», имя безымянного по интересу,
 * миниатюра собеседника (одна загрузка на человека). Список читается через `channel=ARCHT…`: чужие строки общей
 * базы в проверки не попадают.
 */
const fetchInstagramProfileMock = vi.fn();
const fetchMessengerPicMock = vi.fn();
const accountTokenMock = vi.fn();
const logErrorMock = vi.fn();
const safeOpenMock = vi.fn();
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  fetchInstagramProfile: (...args: unknown[]) => fetchInstagramProfileMock(...args),
  fetchMessengerProfilePic: (...args: unknown[]) => fetchMessengerPicMock(...args),
}));
vi.mock("../src/messengers/accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/accounts.js")>()),
  accountTokenById: (...args: unknown[]) => accountTokenMock(...args),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...args: unknown[]) => logErrorMock(...args),
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
  // Все страницы подряд: после теста порций в канале больше сорока строк.
  const items: any[] = [];
  let body: any = null;
  for (let page = 1; page <= 10; page++) {
    const response = await get(`/conversations?grouped=1&channel=${CHANNEL}${extra}&page=${page}`);
    expect(response.status).toBe(200);
    body = response.body;
    items.push(...body.items);
    if (items.length >= body.total || body.items.length === 0) break;
  }
  return { ids: items.map((item: { id: string }) => item.id), body: { ...body, items } };
}

async function setArchiveSwitch(value: boolean) {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { chatArchiveEnabled: value }, create: { id: "singleton", chatArchiveEnabled: value } });
}

async function makeConversation(key: string, data: Record<string, unknown>) {
  const row = await prisma.botConversation.create({
    data: {
      channel: CHANNEL,
      subscriberId: `archt-${runId}-${key}`,
      // Время реплики совпадает с последним входящим: архив смотрит и на него (последняя активность любой стороны).
      messages: [{ role: "user", content: `сообщение ${key}`, at: ((data.lastMessageAt as Date | undefined) ?? new Date()).toISOString() }],
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
  // Давняя тишина, но кто-то ждёт: такие чаты в архив не уходят.
  const oldAt = ago(60 * DAY);
  await makeConversation("w-paused", { lastMessageAt: oldAt, pausedUntil: new Date(Date.now() + DAY) });
  await makeConversation("w-phone", { lastMessageAt: oldAt, leadDraft: { stage: "awaiting_phone" } });
  await makeConversation("w-accepting", { lastMessageAt: oldAt, leadDraft: { stage: "accepting" } });
  await makeConversation("w-inquiry", { lastMessageAt: oldAt });
  await makeConversation("w-done", { lastMessageAt: oldAt, leadDraft: { stage: "chatting" } });
  // Обращение у каждого диалога заводит триггер базы (по умолчанию HOLD, это ничего не значит); тут его ведёт бот нового агента.
  await prisma.customerInquiry.update({ where: { conversationId: botIds["w-inquiry"] }, data: { ownerMode: "BOT" } });
  // Входящее давно, но последней писала НАША сторона неделю назад: чат живой.
  await makeConversation("w-agent", {
    lastMessageAt: oldAt,
    messages: [
      { role: "user", content: "давно", at: oldAt.toISOString() },
      { role: "assistant", content: "агент написал", at: ago(7 * DAY).toISOString(), by: { kind: "agent", agentId: "a", agentName: "A" } },
    ],
  });
});

afterAll(async () => {
  await prisma.customerInquiry.deleteMany({ where: { endpointScope: { channel: CHANNEL } } }).catch(() => undefined);
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
    expect(main.body.counts.archived).toBe(3);
    expect(main.body.counts.all).toBe(main.ids.length);
    expect(main.body.total).toBe(main.ids.length);

    const archive = await listIds("&archived=1");
    expect(archive.ids.sort()).toEqual([botIds.old, botIds.returns, botIds["w-done"]].sort());
    expect(archive.body.total).toBe(3);
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
    expect((await listIds("&archived=1")).ids.sort()).toEqual([botIds.old, botIds["w-done"]].sort());
    expect(main.body.counts.archived).toBe(2);
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

describe("что в архив не уходит: кто-то ждёт или писала наша сторона", () => {
  const keep = ["w-paused", "w-phone", "w-accepting", "w-inquiry", "w-agent"];

  it("пауза бота, заявка ждёт номер или принятия, обращение ведёт сотрудник, давний ответ агента: остаются в основном списке", async () => {
    const main = await listIds();
    for (const key of keep) expect(main.ids, key).toContain(botIds[key]);
    // Контроль того же срока без признаков ожидания (у него тоже есть обращение в HOLD): уходит в архив.
    expect(main.ids).not.toContain(botIds["w-done"]);
    const archive = await listIds("&archived=1");
    expect(archive.ids).toContain(botIds["w-done"]);
    for (const key of keep) expect(archive.ids, key).not.toContain(botIds[key]);
  });

  it("чистая функция даёт тот же ответ, что запрос", () => {
    const now = new Date("2026-11-26T10:00:00Z");
    const old = new Date(now.getTime() - 60 * DAY);
    expect(isChatArchived({ clientId: null, lastActivityAt: old }, now)).toBe(true);
    expect(isChatArchived({ clientId: null, lastActivityAt: old, botPaused: true }, now)).toBe(false);
    expect(isChatArchived({ clientId: null, lastActivityAt: old, agentAttention: true }, now)).toBe(false);
    expect(isChatArchived({ clientId: null, lastActivityAt: old, leadStage: "awaiting_phone" }, now)).toBe(false);
    expect(isChatArchived({ clientId: null, lastActivityAt: old, leadStage: "accepting" }, now)).toBe(false);
    expect(isChatArchived({ clientId: null, lastActivityAt: old, openInquiry: true }, now)).toBe(false);
    expect(isChatArchived({ clientId: null, lastActivityAt: old, leadStage: "chatting" }, now)).toBe(true);
  });
});

describe("миниатюра: ключ аккаунта-получателя, отказы, обновление, уборка", () => {
  const ok = async () => ({
    res: new Response(new Uint8Array(await sharp({ create: { width: 200, height: 200, channels: 3, background: "#aa3366" } }).png().toBuffer()), { status: 200 }),
  });
  const newProfile = async () => {
    const p = await prisma.contactProfile.create({ data: {} });
    profileIds.push(p.id);
    return p;
  };

  it("Instagram второго аккаунта: профиль спрашивается ключом ЭТОГО аккаунта", async () => {
    const profile = await newProfile();
    accountTokenMock.mockReset().mockResolvedValue({ id: "acc2", token: "token-of-account-2", disabled: false });
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    safeOpenMock.mockReset().mockImplementation(ok);
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-acc2", accountId: "acc2" })).toBe("stored");
    expect(accountTokenMock).toHaveBeenCalledWith("acc2", "INSTAGRAM");
    expect(fetchInstagramProfileMock).toHaveBeenCalledWith("ig-acc2", "token-of-account-2");
  });

  it("Messenger: ключ Страницы того же аккаунта", async () => {
    const profile = await newProfile();
    accountTokenMock.mockReset().mockResolvedValue({ id: "page1", token: "page-token", disabled: false });
    fetchMessengerPicMock.mockReset().mockResolvedValue("https://cdn.example.invalid/m.jpg");
    safeOpenMock.mockReset().mockImplementation(ok);
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "FACEBOOK", subscriberId: "psid-1", accountId: "page1" })).toBe("stored");
    expect(fetchMessengerPicMock).toHaveBeenCalledWith("psid-1", "page-token");
  });

  it("аккаунт выключен или без ключа: не пробуем и попытку не занимаем (общий ключ не подставляем)", async () => {
    const profile = await newProfile();
    fetchInstagramProfileMock.mockReset();
    for (const answer of [{ id: "a", token: "t", disabled: true }, { id: "a", token: undefined, disabled: false }]) {
      accountTokenMock.mockReset().mockResolvedValue(answer);
      expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-off", accountId: "a" })).toBe("skipped");
    }
    expect(fetchInstagramProfileMock).not.toHaveBeenCalled();
    expect((await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } })).avatarFetchedAt).toBeNull();
  });

  it("общая дверь входящего передаёт accountId диалога", async () => {
    const conversation = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `archt-${runId}-door`, messages: [] } });
    accountTokenMock.mockReset().mockResolvedValue({ id: "acc-door", token: "token-door", disabled: false });
    fetchInstagramProfileMock.mockReset().mockResolvedValue({});
    safeOpenMock.mockReset();
    const profileId = await ensureConversationContactProfile({
      id: conversation.id, channel: "INSTAGRAM", subscriberId: conversation.subscriberId, name: null, contactProfileId: null, accountId: "acc-door",
    });
    if (profileId) profileIds.push(profileId);
    await vi.waitFor(() => expect(fetchInstagramProfileMock).toHaveBeenCalledWith(conversation.subscriberId, "token-door"));
    await prisma.botConversation.delete({ where: { id: conversation.id } });
  });

  it("«объект не существует» (400, subcode 33) не считается отказом ключа", () => {
    const body = JSON.stringify({ error: { message: "Object with ID does not exist", type: "GraphMethodException", code: 100, error_subcode: 33 } });
    expect(isInstagramKeyRefusal(400, body)).toBe(false);
  });

  it("таймаут и сетевой отказ не попадают в журнал ошибок, неожиданное попадает", async () => {
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    accountTokenMock.mockReset();
    logErrorMock.mockReset();
    for (const message of ["таймаут 6000 мс", "fetch failed", "The operation timed out"]) {
      const p = await newProfile();
      safeOpenMock.mockReset().mockRejectedValue(new Error(message));
      expect(await ensureContactAvatar({ profileId: p.id, channel: "INSTAGRAM", subscriberId: "ig-t" })).toBe("failed");
    }
    expect(logErrorMock).not.toHaveBeenCalled();
    const p = await newProfile();
    safeOpenMock.mockReset().mockImplementation(async () => ({ res: new Response(new Uint8Array([1, 2, 3]), { status: 200 }) }));
    expect(await ensureContactAvatar({ profileId: p.id, channel: "INSTAGRAM", subscriberId: "ig-bad" })).toBe("failed");
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it("смена фото в канале: обновление не раньше 90 дней, старый файл удаляется", async () => {
    const profile = await newProfile();
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    accountTokenMock.mockReset();
    safeOpenMock.mockReset().mockImplementation(ok);
    await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-r" });
    const first = (await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } })).avatarKey!;
    const soon = new Date(Date.now() + AVATAR_REFRESH_AFTER_MS - 60_000);
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-r", now: soon })).toBe("skipped");
    const later = new Date(Date.now() + AVATAR_REFRESH_AFTER_MS + 60_000);
    expect(await ensureContactAvatar({ profileId: profile.id, channel: "INSTAGRAM", subscriberId: "ig-r", now: later })).toBe("stored");
    const second = (await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } })).avatarKey!;
    expect(second).not.toBe(first);
    expect(contactAvatarPath(first)).toBeNull();
    expect(contactAvatarPath(second)).not.toBeNull();
  });

  it("ночная уборка стирает миниатюры без досье и не трогает свежие, живые и чужие по формату", async () => {
    const dir = path.join(privateDir, "avatars");
    fs.mkdirSync(dir, { recursive: true });
    const live = await newProfile();
    fetchInstagramProfileMock.mockReset().mockResolvedValue({ profilePic: "https://cdn.example.invalid/p.jpg" });
    safeOpenMock.mockReset().mockImplementation(ok);
    accountTokenMock.mockReset();
    await ensureContactAvatar({ profileId: live.id, channel: "INSTAGRAM", subscriberId: "ig-sweep" });
    const liveKey = (await prisma.contactProfile.findUniqueOrThrow({ where: { id: live.id } })).avatarKey!;
    const orphan = "11111111-1111-4111-8111-111111111111.webp";
    const fresh = "22222222-2222-4222-8222-222222222222.webp";
    for (const name of [orphan, fresh]) fs.writeFileSync(path.join(dir, name), "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "не наш формат");
    // «Свежий» файл: время файла впереди часов уборки, возраст суток не набран.
    const future = new Date(Date.now() + 3 * DAY);
    fs.utimesSync(path.join(dir, fresh), future, future);
    const result = await cleanupOrphanContactAvatars(new Date(Date.now() + 2 * DAY));
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(dir, orphan))).toBe(false);
    expect(fs.existsSync(path.join(dir, fresh))).toBe(true);
    expect(fs.existsSync(path.join(dir, liveKey))).toBe(true);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });
});
