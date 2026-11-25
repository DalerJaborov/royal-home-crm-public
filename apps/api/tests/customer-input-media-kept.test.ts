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
 * Ревью #428: ожидание реплики больше не живёт в памяти. Реплики нет — файлы ждут
 * в CustomerPendingMedia, и ledger забирает их в своей транзакции. Проверяем оба
 * порядка, повтор вебхука и уборку ничьих.
 */

const fetched = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/attachments.js")>();
  return { ...actual, fetchAttachments: vi.fn(async () => fetched.value) };
});

const { keepCustomerInputMedia, takePendingCustomerMedia, cleanupStalePendingCustomerMedia, KEEP_MAX_FILES } = await import(
  "../src/lib/customerInputMedia.js"
);

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

async function pendingRows(channel: string, sub: string, mid: string) {
  return prisma.customerPendingMedia.findMany({ where: { channel, subscriberId: sub, mid } });
}

function filesOf(raw: unknown): string[] {
  return (raw as Array<{ file: string }>).map((f) => f.file);
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
  await prisma.customerPendingMedia.deleteMany({ where: { subscriberId: { contains: runId } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  for (const f of savedFiles) {
    const full = privateFilePath(f);
    if (full) fs.rmSync(full, { force: true });
  }
});

describe("Файл клиента — сотруднику, в любом пути записи реплики", () => {
  for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK"]) {
    it(`${channel}: реплика уже записана (ход удержан) — файл и пометка ложатся в неё сразу`, async () => {
      const sub = `keep-${channel}-${runId}`;
      const mid = `mid-${channel}-${runId}`;
      const id = await conversationWith(channel, sub, [
        { role: "assistant", content: "Здравствуйте" },
        { role: "user", content: "[вложение без текста]", mid },
      ]);
      const result = await keepCustomerInputMedia({ channel, subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }, { url: "https://cdn.example/b.mp4" }] });
      expect(result).toBe("attached");
      const e = await entry(id, mid);
      const names = filesOf(e.attachments);
      expect(names).toHaveLength(1);
      savedFiles.push(...names);
      expect(privateFilePath(names[0])).toBeTruthy();
      expect(e.attachmentsLost).toEqual([{ kind: "video", reason: "too_big" }]);
      expect(await pendingRows(channel, sub, mid)).toHaveLength(0);
      const [shown] = presentMessages([e], true, true);
      expect(shown.attachments?.map((a) => a.lost ?? a.kind)).toEqual(["image", "too_big"]);
    });
  }

  it("ядро (dm_lane_core): реплики ещё нет — файл ждёт в базе, ledger забирает его в своей транзакции", async () => {
    const sub = `keep-core-${runId}`;
    const mid = `mid-core-${runId}`;
    await conversationWith("WHATSAPP", sub, [{ role: "user", content: "до", mid: `other-${runId}` }]);
    expect(await keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("pending");
    const [row] = await pendingRows("WHATSAPP", sub, mid);
    const [file] = filesOf(row.files);
    savedFiles.push(file);
    // Перезапуск API здесь ничего не меняет: ждут строка в базе и файл на диске.
    expect(privateFilePath(file)).toBeTruthy();
    const taken = await prisma.$transaction((tx) => takePendingCustomerMedia(tx, "WHATSAPP", sub, mid));
    expect(taken?.attachments?.[0].file).toBe(file);
    expect(taken?.attachmentsLost).toEqual([{ kind: "video", reason: "too_big" }]);
    expect(await pendingRows("WHATSAPP", sub, mid)).toHaveLength(0);
  });

  it("повтор вебхука до записи реплики: строка ожидания одна, лишние копии удалены", async () => {
    const sub = `keep-dup-pending-${runId}`;
    const mid = `mid-dup-pending-${runId}`;
    await conversationWith("INSTAGRAM", sub, []);
    expect(await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("pending");
    const [first] = filesOf((await pendingRows("INSTAGRAM", sub, mid))[0].files);
    savedFiles.push(first);
    const dir = path.dirname(privateFilePath(first)!);
    const before = fs.readdirSync(dir).length;
    expect(await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("pending");
    expect(await pendingRows("INSTAGRAM", sub, mid)).toHaveLength(1);
    expect(fs.readdirSync(dir).length).toBe(before);
  });

  it("первая попытка ничего не скачала, повтор скачал — ждут файлы повтора, а старая пометка «не скачалось» снимается", async () => {
    const sub = `keep-retry-${runId}`;
    const mid = `mid-retry-${runId}`;
    const id = await conversationWith("WHATSAPP", sub, []);
    fetched.value = { images: [], audios: [], medias: [], hadUnsupported: true, lost: [{ kind: "image", reason: "failed" }] } satisfies FetchedAttachments;
    expect(await keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("pending");
    fetched.value = { images: [{ kind: "image", mediaType: "image/jpeg", data: await jpegBase64() }], audios: [], medias: [], hadUnsupported: false, lost: [] } satisfies FetchedAttachments;
    expect(await keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("pending");
    const [row] = await pendingRows("WHATSAPP", sub, mid);
    const [file] = filesOf(row.files);
    savedFiles.push(file);
    expect(privateFilePath(file)).toBeTruthy();
    expect(row.lost).toEqual([]);
    // Реплика пришла с пометкой от первой попытки — прикрепление файла её снимает.
    await prisma.botConversation.update({ where: { id }, data: { messages: [{ role: "user", content: "", mid, attachmentsLost: [{ kind: "image", reason: "failed" }] }] as never } });
    fetched.value = { images: [], audios: [], medias: [], hadUnsupported: true, lost: [{ kind: "image", reason: "failed" }] } satisfies FetchedAttachments;
    // Третья доставка ничего не скачала: ждущие файлы второй всё равно ложатся в реплику.
    expect(await keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("attached");
    const e = await entry(id, mid);
    expect(filesOf(e.attachments)).toEqual([file]);
    expect(e.attachmentsLost).toBeUndefined();
  });

  it("старый путь уже сохранил вложения — не перезаписываем и не копим дубль на диске", async () => {
    const sub = `keep-dup-${runId}`;
    const mid = `mid-dup-${runId}`;
    const id = await conversationWith("INSTAGRAM", sub, [
      { role: "user", content: "[📷]", mid, attachments: [{ kind: "image", file: "00000000-0000-0000-0000-000000000000.jpg", mime: "image/jpeg" }] },
    ]);
    const dir = path.dirname(privateFilePath(savedFiles[0])!);
    const before = fs.readdirSync(dir).length;
    expect(await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("already");
    expect(fs.readdirSync(dir).length).toBe(before);
    expect(((await entry(id, mid)).attachments as unknown[]).length).toBe(1);
    expect(await pendingRows("INSTAGRAM", sub, mid)).toHaveLength(0);
  });

  it("ничья строка ожидания старше двух суток убирается вместе с файлом", async () => {
    const sub = `keep-stale-${runId}`;
    const mid = `mid-stale-${runId}`;
    await conversationWith("WHATSAPP", sub, []);
    expect(await keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid, sources: [{ url: "https://cdn.example/a.jpg" }] })).toBe("pending");
    const [row] = await pendingRows("WHATSAPP", sub, mid);
    const [file] = filesOf(row.files);
    await prisma.customerPendingMedia.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    const { deleted } = await cleanupStalePendingCustomerMedia();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await pendingRows("WHATSAPP", sub, mid)).toHaveLength(0);
    expect(privateFilePath(file)).toBeNull();
  });

  it("потолок сохранения — десять файлов, а не три, как у модели; лишние — «слишком много за раз»", async () => {
    expect(KEEP_MAX_FILES).toBe(10);
    const sub = `keep-many-${runId}`;
    const mid = `mid-many-${runId}`;
    const id = await conversationWith("INSTAGRAM", sub, [{ role: "user", content: "", mid }]);
    const sources = Array.from({ length: 12 }, (_, i) => ({ url: `https://cdn.example/${i}.jpg` }));
    expect(await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId: sub, mid, sources })).toBe("attached");
    const e = await entry(id, mid);
    savedFiles.push(...filesOf(e.attachments));
    expect((e.attachmentsLost as Array<{ reason: string }>).filter((l) => l.reason === "too_many")).toHaveLength(2);
  });
});

describe("Сторож класса: каждая запись входящего мимо старого цикла сохраняет файл", () => {
  it("рядом с каждым recordScopedCustomerInput стоит keepIncomingMediaForStaff, а ledger забирает ждущие файлы", () => {
    const src = path.resolve(__dirname, "../src");
    for (const f of ["messengers/conversation.ts", "messengers/customerQualifierTurn.ts"]) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      const calls = text.split("await recordScopedCustomerInput(").length - 1;
      const keeps = text.split("keepIncomingMediaForStaff(input)").length - 1;
      expect({ f, keeps: keeps >= calls }).toEqual({ f, keeps: true });
    }
    const conv = fs.readFileSync(path.join(src, "messengers/conversation.ts"), "utf8");
    expect(conv).toMatch(/keepIncomingMediaForStaff\(input\);\s*\n\s*traceNoReply\("dm_lane_core"\)/);
    const ledger = fs.readFileSync(path.join(src, "lib/customerQualifierLedger.ts"), "utf8");
    expect(ledger).toMatch(/await takePendingCustomerMedia\(tx, evidence\.channel, evidence\.peer, evidence\.eventId\)/);
  });
});
