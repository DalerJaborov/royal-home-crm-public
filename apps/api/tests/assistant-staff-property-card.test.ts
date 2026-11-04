import { rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPropertyCode } from "@royal-home/shared";

vi.mock("../src/upload.js", async (importOriginal) => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return { ...(await importOriginal<typeof import("../src/upload.js")>()), uploadsDir: await mkdtemp(path.join(tmpdir(), "staff-card-fixture-")) };
});

vi.mock("../src/telegram/api.js", async (importOriginal) => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-staff-card-transport";
  try {
    return await importOriginal<typeof import("../src/telegram/api.js")>();
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import { sendStaffPropertyCard } from "../src/telegram/assistantStaffPropertyCard.js";

const fetchMock = vi.fn<typeof fetch>();
const fixtureNames = Array.from({ length: 5 }, (_, i) => `fixture-${i + 1}.webp`);
const corruptName = "corrupt.webp";
const photos = fixtureNames.map(name => `/uploads/${name}`);
const ids: string[] = [];
let agentId: string;
let inactiveId: string;
let districtId: string;
const group = "-10042";
const linkedTelegramId = "5130203407";
const telegramResult = (result: unknown) => Response.json({ ok: true, result });

async function createCard(urls: string[] = [], override: Record<string, unknown> = {}) {
  const row = await prisma.property.create({ data: {
    title: "Тестовый объект", type: "APARTMENT", rooms: 2, areaSqm: 68, price: 620000, currency: "TJS", floor: 7, totalFloors: 12,
    districtId, address: "г. Душанбе, район Сино, ул. Примерная, 24, корпус 2", landmark: "рядом со сквером, вход со двора.",
    condition: "NEW_BUILDING", marketType: "NEW_BUILD", stage: "SHELL",
    instagramUrl: "https://instagram.com/reel/FiXt_9/?igsh=synthetic", assignedAgentId: agentId,
    ownerContact: "Закрытое имя и контакт собственника", clipVideoUrl: "/uploads/test.mp4",
    photos: { create: urls.map((url, order) => ({ url, thumbUrl: url, order })) },
    ...override,
  }, select: { id: true, shortId: true } });
  ids.push(row.id);
  return row;
}

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  agentId = (await prisma.agent.create({ data: { fullName: "Умед & коллеги", phone: `+992901${stamp}`, passwordHash: "x", role: "AGENT",
    telegramChatId: linkedTelegramId, telegramUserId: linkedTelegramId } })).id;
  inactiveId = (await prisma.agent.create({ data: { fullName: "Ведущий сотрудник", phone: `+992902${stamp}`, passwordHash: "x", role: "AGENT",
    telegramChatId: "5130203410", telegramUserId: "5130203410", isActive: false } })).id;
  districtId = (await prisma.district.create({ data: { name: "район Сино", nameTj: "ноҳияи Сино", city: "Душанбе" } })).id;
  await Promise.all(fixtureNames.map((name, i) => sharp({ create: { width: 60, height: 40, channels: 3,
    background: { r: 30 * i, g: 25, b: 50 },
  } }).webp().toFile(path.join(uploadsDir, name))));
  await writeFile(path.join(uploadsDir, corruptName), "not a photo");
});
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, inactiveId] } } });
  await prisma.district.delete({ where: { id: districtId } });
  await Promise.all([...fixtureNames, corruptName].map(name => unlink(path.join(uploadsDir, name))));
  await rmdir(uploadsDir);
});

describe("staff Telegram property card", () => {
  it("sends four real photos as one routed album with the exact card on the first photo", async () => {
    const p = await createCard(["/uploads/../invalid.webp", "/uploads/missing.webp", `/uploads/${corruptName}`,
      "https://cdn.example.test/property.webp", "/uploads/video.mp4", photos[0], photos[0], ...photos.slice(1)]);
    fetchMock.mockResolvedValueOnce(telegramResult([1, 2, 3, 4].map(message_id => ({ message_id }))));
    expect(await sendStaffPropertyCard(group, p.id, "ru", 23, 17)).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/sendMediaGroup$/u);
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("chat_id")).toBe(group);
    expect(form.get("message_thread_id")).toBe("17");
    expect(JSON.parse(String(form.get("reply_parameters")))).toEqual({ message_id: 23, allow_sending_without_reply: true });
    const media = JSON.parse(String(form.get("media")));
    expect(media).toHaveLength(4);
    expect(media[0]).toMatchObject({ type: "photo", media: "attach://f0", parse_mode: "HTML" });
    expect(media.slice(1)).toEqual([1, 2, 3].map(i => ({ type: "photo", media: `attach://f${i}` })));
    expect(media[0].caption).toBe([
      "<b>2-комнатная квартира · 68 м²</b>", "💰 <b>620 000 сомони</b> · 7 из 12 этажей",
      "📍 Душанбе, район Сино, ул. Примерная, 24, корпус 2. Ориентир рядом со сквером, вход со двора.",
      "🏗 Новостройка · коробка, без отделки", '🎬 <a href="https://www.instagram.com/reel/FiXt_9/">Смотреть в Instagram</a>',
      `👤 <a href="tg://user?id=${linkedTelegramId}">Умед &amp; коллеги</a> · ${formatPropertyCode(p.shortId)}`,
    ].join("\n"));
    expect(media[0].caption).not.toContain("Закрытое имя");
    expect([...form.keys()].filter(key => /^f\d$/.test(key))).toEqual(["f0", "f1", "f2", "f3"]);
    for (const [i, name] of fixtureNames.slice(0, 4).entries()) {
      const actual = form.get(`f${i}`) as Blob;
      const expected = await sharp(path.join(uploadsDir, name)).raw().toBuffer();
      expect(await sharp(Buffer.from(await actual.arrayBuffer())).raw().toBuffer()).toEqual(expected);
    }
  });

  it("uses a single photo with Tajik copy and omits invalid links and inactive mentions", async () => {
    const p = await createCard([photos[0]], { address: "Душанбе, кӯчаи Сино", landmark: "<Бозор>", instagramUrl: "https://instagram.com.evil.test/reel/not-ours/",
      assignedAgentId: inactiveId, status: "EDITING", stage: null });
    fetchMock.mockResolvedValueOnce(telegramResult({ message_id: 42 }));
    expect(await sendStaffPropertyCard(group, p.id, "tg", 12, 3)).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/sendPhoto$/u);
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("message_thread_id")).toBe("3");
    expect(form.get("parse_mode")).toBe("HTML");
    expect(form.get("caption")).toContain("📍 Душанбе, ноҳияи Сино, кӯчаи Сино. Нишона &lt;Бозор&gt;.");
    expect(form.get("caption")).toContain("· 7 аз 12 ошёна");
    expect(form.get("caption")).toContain("🏗 Сохтмони нав\nДар монтаж\n👤 Ведущий сотрудник");
    expect(form.get("caption")).not.toContain("href=");
  });

  it("sends the same template as HTML text when no photo is available", async () => {
    const p = await createCard([], { instagramUrl: "https://www.instagram.com/royal_home/", assignedAgentId: null });
    fetchMock.mockResolvedValueOnce(telegramResult({ message_id: 99 }));
    expect(await sendStaffPropertyCard(group, p.id, "ru", 22, 19)).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/sendMessage$/u);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload).toMatchObject({ message_thread_id: 19, reply_to_message_id: 22, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(payload.text).toContain(formatPropertyCode(p.shortId));
    expect(payload.text).not.toContain("https://");
    expect(payload.text).not.toContain("Агент");
  });

  it("does not retry unknown delivery and permits fallback after definite refusal", async () => {
    const p = await createCard([photos[0], photos[1]]);
    fetchMock.mockRejectedValueOnce(new Error("response lost"));
    expect(await sendStaffPropertyCard(group, p.id, "ru")).toBe("uncertain");
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(telegramResult([{ message_id: 21 }]));
    expect(await sendStaffPropertyCard(group, p.id, "ru")).toBe("uncertain");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, { status: 429 }));
    expect(await sendStaffPropertyCard(group, p.id, "ru")).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not send an archived property", async () => {
    const p = await createCard(photos, { deletedAt: new Date() });
    expect(await sendStaffPropertyCard(group, p.id, "ru")).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
