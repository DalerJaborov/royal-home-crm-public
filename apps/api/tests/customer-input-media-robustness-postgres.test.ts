import fs from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";
import { privateFilePath } from "../src/lib/privateFiles.js";
import type { FetchedAttachments } from "../src/messengers/attachments.js";

/**
 * Надёжность сохранения файлов клиента (ревью #465, 26.11.2026): один процесс — одно скачивание за раз (иначе
 * 6–8 клиентов с видео по 100 МБ разом = OOM всего API при mem_limit 768m), диск меньше 1 ГБ, причина «ключ канала
 * не работает», повторные пути не качают второй раз.
 */

const state = vi.hoisted(() => ({ value: null as unknown, inFlight: 0, maxInFlight: 0, calls: 0, delayMs: 0 }));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/attachments.js")>();
  return {
    ...actual,
    fetchAttachments: vi.fn(async () => {
      state.calls++; state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((r) => setTimeout(r, state.delayMs));
      state.inFlight--;
      return state.value;
    }),
  };
});
const { keepCustomerInputMedia, KEEP_MAX_CONCURRENT_DOWNLOADS } = await import("../src/lib/customerInputMedia.js");

const runId = Date.now().toString(36);
const conversationIds: string[] = [];
const savedFiles: string[] = [];
const accountIds: string[] = [];

async function jpegBase64(): Promise<string> {
  return (await sharp({ create: { width: 16, height: 16, channels: 3, background: "#aa3355" } }).jpeg().toBuffer()).toString("base64");
}
async function conversationWith(subscriberId: string, mids: string[]) {
  const c = await prisma.botConversation.create({
    data: { channel: "WHATSAPP" as never, subscriberId, name: `robust ${runId}`, lastMessageAt: new Date(),
      messages: mids.map((mid) => ({ role: "user", content: "[вложение без текста]", mid })) as never },
  });
  conversationIds.push(c.id);
  return c.id;
}
async function entry(conversationId: string, mid: string) {
  const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { messages: true } });
  return (row.messages as Array<Record<string, unknown>>).find((m) => m.mid === mid)!;
}

beforeEach(async () => {
  state.inFlight = 0; state.maxInFlight = 0; state.calls = 0; state.delayMs = 0;
  state.value = { images: [{ kind: "image", mediaType: "image/jpeg", data: await jpegBase64() }], audios: [], medias: [], hadUnsupported: false, lost: [] } satisfies FetchedAttachments;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.customerPendingMedia.deleteMany({ where: { subscriberId: { contains: runId } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  for (const f of savedFiles) { const full = privateFilePath(f); if (full) fs.rmSync(full, { force: true }); }
});

describe("общий предел скачиваний", () => {
  it("пять клиентов разом: в полёте не больше одного скачивания, но сохранены все пять (очередь, не отказ)", async () => {
    expect(KEEP_MAX_CONCURRENT_DOWNLOADS).toBe(1);
    state.delayMs = 40;
    const sub = `wa-conc-${runId}`;
    const mids = ["c0", "c1", "c2", "c3", "c4"];
    const id = await conversationWith(sub, mids);
    const results = await Promise.all(mids.map((mid) => keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid,
      sources: [{ url: `https://cdn.example/${mid}.jpg`, declaredKind: "image" }] })));
    expect(results).toEqual(["attached", "attached", "attached", "attached", "attached"]);
    expect(state.maxInFlight).toBe(1);
    for (const mid of mids) {
      const e = await entry(id, mid);
      savedFiles.push(...(e.attachments as Array<{ file: string }>).map((a) => a.file));
      expect(e.attachments).toHaveLength(1);
    }
  });

  it("повторный путь по тому же сообщению не качает второй раз (файлы уже в реплике)", async () => {
    const sub = `wa-dup-${runId}`;
    const id = await conversationWith(sub, ["d0"]);
    const input = { channel: "WHATSAPP", subscriberId: sub, mid: "d0", sources: [{ url: "https://cdn.example/d0.jpg", declaredKind: "image" }] };
    expect(await keepCustomerInputMedia(input)).toBe("attached");
    savedFiles.push(...((await entry(id, "d0")).attachments as Array<{ file: string }>).map((a) => a.file));
    expect(await keepCustomerInputMedia(input)).toBe("already");
    expect(state.calls).toBe(1);
  });
});

describe("диск меньше 1 ГБ", () => {
  it("не качаем, на реплике пометка с причиной, в журнале громкая запись", async () => {
    vi.spyOn(fs.promises, "statfs").mockResolvedValue({ bavail: 10, bsize: 1024 } as never);
    const sub = `wa-disk-${runId}`;
    const id = await conversationWith(sub, ["k0"]);
    const out = await keepCustomerInputMedia({ channel: "WHATSAPP", subscriberId: sub, mid: "k0", sources: [{ url: "https://cdn.example/k0.mp4", declaredKind: "video" }] });
    expect(out).toBe("attached");
    expect(state.calls).toBe(0);
    expect((await entry(id, "k0")).attachmentsLost).toEqual([{ kind: "video", reason: "failed" }]);
    await waitFor(async () => (await prisma.errorLog.count({ where: { message: { contains: "меньше 1 ГБ" } } })) > 0);
  });
});

describe("ключ канала не работает", () => {
  it("«не скачалось» у аккаунта с отметкой accessLostAt становится причиной «ключ не работает»", async () => {
    const externalId = `ig-dead-${runId}`;
    const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId, title: `dead ${runId}`, token: "x", accessLostAt: new Date() } });
    accountIds.push(account.id);
    const sub = `ig-key-${runId}`;
    const c = await prisma.botConversation.create({ data: { channel: "INSTAGRAM" as never, subscriberId: sub, name: `robust ${runId}`, lastMessageAt: new Date(),
      messages: [{ role: "user", content: "[вложение без текста]", mid: "n0" }] as never } });
    conversationIds.push(c.id);
    state.value = { images: [], audios: [], medias: [], hadUnsupported: true, lost: [{ kind: "image", reason: "failed" }] } satisfies FetchedAttachments;
    await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId: sub, mid: "n0", accountExternalId: externalId, sources: [{ url: "https://cdn.example/n0.jpg", declaredKind: "image" }] });
    expect((await entry(c.id, "n0")).attachmentsLost).toEqual([{ kind: "image", reason: "no_key" }]);
  });

  it("у живого аккаунта причина остаётся «не скачалось»", async () => {
    const sub = `ig-live-${runId}`;
    const c = await prisma.botConversation.create({ data: { channel: "INSTAGRAM" as never, subscriberId: sub, name: `robust ${runId}`, lastMessageAt: new Date(),
      messages: [{ role: "user", content: "[вложение без текста]", mid: "l0" }] as never } });
    conversationIds.push(c.id);
    state.value = { images: [], audios: [], medias: [], hadUnsupported: true, lost: [{ kind: "image", reason: "failed" }] } satisfies FetchedAttachments;
    await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId: sub, mid: "l0", accountExternalId: `ig-live-${runId}`, sources: [{ url: "https://cdn.example/l0.jpg", declaredKind: "image" }] });
    expect((await entry(c.id, "l0")).attachmentsLost).toEqual([{ kind: "image", reason: "failed" }]);
  });
});
