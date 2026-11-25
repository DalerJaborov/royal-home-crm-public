import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../src/db.js";
import { privateFilePath } from "../src/lib/privateFiles.js";
import { presentMessages } from "../src/lib/messageAttachments.js";
import type { FetchedAttachments } from "../src/messengers/attachments.js";

/**
 * Файл клиента сохраняется для сотрудника и тогда, когда реплику пишет не старый
 * цикл бота (25.11.2026, кадр владельца: WhatsApp, «Клиент прислал файл — в CRM он
 * не сохранился»). Ход удержан (переписку ведёт сотрудник), ядро клиентского агента,
 * квалификатор — все три писали в историю только текст или метку
 * «[вложение без текста]», а файл не качался вовсе.
 *
 * Скачивание подменено: проверяем сохранение, привязку к реплике по mid, ожидание
 * реплики, которую ядро пишет позже, пометку с причиной и отсутствие дублей.
 */

const fetched = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/attachments.js")>();
  return { ...actual, fetchAttachments: vi.fn(async () => fetched.value) };
});

const { keepCustomerInputMedia, KEEP_MAX_FILES } = await import("../src/lib/customerInputMedia.js");

const runId = Date.now().toString(36);
const createdConversationIds: string[] = [];
const savedFiles: string[] = [];

async function jpegBase64(): Promise<string> {
  return (await sharp({ create: { width: 64, height: 48, channels: 3, background: "#88aa33" } }).jpeg().toBuffer()).toString("base64");
}

async function conversationWith(channel: string, subscriberId: string, messages: unknown[]) {
  const c = await prisma.botConversation.create({
    data: { channel: channel as never, subscriberId, name: `keep ${runId}`, messages: messages as never, lastMessageAt: new Date() },
  });
  createdConversationIds.push(c.id);
  return c.id;
}

async function entry(conversationId: string, mid: string) {
  const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { messages: true } });
  return (row.messages as Array<Record<string, unknown>>).find((m) => m.mid === mid)!;
}

beforeEach(async () => {
  fetched.value = {
    images: [{ kind: "image", mediaType: "image/jpeg", data: await jpegBase64() }],
    audios: [],
    medias: [],
    hadUnsupported: true,
    lost: [{ kind: "video", reason: "too_big" }],
  } satisfies FetchedAttachments;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  for (const f of savedFiles) {
    const full = privateFilePath(f);
    if (full) fs.rmSync(full, { force: true });
  }
});

describe("Файл клиента — сотруднику, в любом пути записи реплики", () => {
  for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK"]) {
    it(`${channel}: реплика-метка получает файл и пометку о несохранённом видео`, async () => {
      const sub = `keep-${channel}-${runId}`;
      const mid = `mid-${channel}-${runId}`;
      const id = await conversationWith(channel, sub, [
        { role: "assistant", content: "Здравствуйте" },
        { role: "user", content: "[вложение без текста]", mid },
      ]);
      const result = await keepCustomerInputMedia({ channel, subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }, { url: "https://cdn.example/b.mp4" }] });
      expect(result).toBe("attached");
      const e = await entry(id, mid);
      const atts = e.attachments as Array<{ kind: string; file: string }>;
      expect(atts).toHaveLength(1);
      expect(atts[0].kind).toBe("image");
      savedFiles.push(atts[0].file);
      expect(privateFilePath(atts[0].file)).toBeTruthy();
      expect(e.attachmentsLost).toEqual([{ kind: "video", reason: "too_big" }]);

      // Экран: фото есть, на месте видео — пометка с причиной; метка «без текста» скрывается (hasAttachments).
      const [shown] = presentMessages([e], true, true);
      expect(shown.attachments?.map((a) => a.lost ?? a.kind)).toEqual(["image", "too_big"]);
    });
  }

  it("реплику ядро пишет позже — файл ждёт её и прикрепляется", async () => {
    const sub = `keep-late-${runId}`;
    const mid = `mid-late-${runId}`;
    const id = await conversationWith("WHATSAPP", sub, [{ role: "user", content: "до", mid: `other-${runId}` }]);
    const pending = keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] });
    await new Promise((r) => setTimeout(r, 400));
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { messages: true } });
    await prisma.botConversation.update({ where: { id }, data: { messages: [...(row.messages as unknown[]), { role: "user", content: "[вложение без текста]", mid }] as never } });
    expect(await pending).toBe("attached");
    const atts = (await entry(id, mid)).attachments as Array<{ file: string }>;
    savedFiles.push(atts[0].file);
    expect(atts).toHaveLength(1);
  }, 20_000);

  it("старый путь уже сохранил вложения — не перезаписываем и не копим дубль на диске", async () => {
    const sub = `keep-dup-${runId}`;
    const mid = `mid-dup-${runId}`;
    const id = await conversationWith("INSTAGRAM", sub, [
      { role: "user", content: "[📷]", mid, attachments: [{ kind: "image", file: "00000000-0000-0000-0000-000000000000.jpg", mime: "image/jpeg" }] },
    ]);
    const before = fs.readdirSync(path.dirname(privateFilePath(savedFiles[0])!)).length;
    expect(await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("already");
    expect(fs.readdirSync(path.dirname(privateFilePath(savedFiles[0])!)).length).toBe(before);
    expect(((await entry(id, mid)).attachments as unknown[]).length).toBe(1);
  });

  it("потолок сохранения — десять файлов, а не три, как у модели", () => {
    expect(KEEP_MAX_FILES).toBe(10);
  });
});

describe("Сторож класса: каждая запись входящего мимо старого цикла сохраняет файл", () => {
  it("рядом с каждым recordScopedCustomerInput стоит keepIncomingMediaForStaff (кроме ядра — там файл сохраняется на входе)", () => {
    const src = path.resolve(__dirname, "../src");
    const files = ["messengers/conversation.ts", "messengers/customerQualifierTurn.ts"];
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      const calls = text.split("await recordScopedCustomerInput(").length - 1;
      const keeps = text.split("keepIncomingMediaForStaff(input)").length - 1;
      expect({ f, keeps: keeps >= calls }).toEqual({ f, keeps: true });
    }
    // Ядро (lib/customerDmCoreContext.ts) записывает реплику позже; его файл сохраняется
    // в conversation.ts на ветке dm_lane_core — там же, где ход отдаётся ядру.
    const conv = fs.readFileSync(path.join(src, "messengers/conversation.ts"), "utf8");
    expect(conv).toMatch(/keepIncomingMediaForStaff\(input\);\s*\n\s*traceNoReply\("dm_lane_core"\)/);
  });
});
