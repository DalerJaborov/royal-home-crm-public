import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture } from "./helpers/customerCoreGoldenFixture.js";
import { privateFilePath } from "../src/lib/privateFiles.js";
import type { FetchedAttachments } from "../src/messengers/attachments.js";

/**
 * ОБРЫВ МЕЖДУ КОММИТОМ РЕПЛИКИ И СКАЧИВАНИЕМ (ревью #465). Выкат идёт каждую минуту, API может упасть по памяти:
 * фоновая загрузка после коммита не стартует, а повторный проход inbox-consume видит «реплика уже записана» и
 * ничего не качает. Раньше в чате оставалась голая «[📎]»; теперь вместе с репликой в той же транзакции лежит заявка,
 * и сверка ставит пометку «не скачалось». Обрыв моделируем так: фоновую загрузку подменяем пустышкой (процесс «умер»).
 */

const fetched = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/attachments.js")>();
  return { ...actual, fetchAttachments: vi.fn(async () => fetched.value) };
});
vi.mock("../src/lib/customerInputMedia.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/customerInputMedia.js")>();
  return { ...actual, keepIngressMediaInBackground: vi.fn(() => undefined) };
});
const { prepareCustomerDmInboxCoreContext } = await import("../src/lib/customerDmCoreContext.js");
const { settleStalePendingCustomerMedia, keepCustomerInputMedia, cleanupStalePendingCustomerMedia } = await import("../src/lib/customerInputMedia.js");

let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
const savedFiles: string[] = [];
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterAll(async () => {
  for (const name of savedFiles) { const full = privateFilePath(name); if (full) fs.rmSync(full, { force: true }); }
  await f?.cleanup();
});
beforeEach(async () => {
  fetched.value = { images: [{ kind: "image", mediaType: "image/jpeg",
    data: (await sharp({ create: { width: 16, height: 16, channels: 3, background: "#225588" } }).jpeg().toBuffer()).toString("base64") }],
  audios: [], medias: [], hadUnsupported: false, lost: [] } satisfies FetchedAttachments;
});

async function ticketOf(eventKey: string) {
  return prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
}
async function userEntry(conversationId: string) {
  const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { messages: true, subscriberId: true } });
  return { entry: (row.messages as Array<Record<string, unknown>>).find((m) => m.role === "user" && m.customerPropertyAdmission)!, subscriberId: row.subscriberId };
}

it("обрыв после коммита: заявка лежит рядом с репликой, сверка ставит пометку, а не оставляет пустоту", async () => {
  const owner = await f.owner();
  const event = await f.capture(owner, "", [{ type: "image", payload: { url: "https://scontent.cdninstagram.com/synthetic/crash.jpg" } }]);
  expect(await prepareCustomerDmInboxCoreContext(event)).toMatchObject({ status: "prepared" });
  const { conversationId } = Object.assign(await ticketOf(event), {}) as { conversationId: string };
  const { entry, subscriberId } = await userEntry(conversationId);
  const mid = entry.mid as string;
  // Скачивание «не состоялось»: у реплики ни файла, ни пометки, зато есть заявка.
  expect(entry.attachments).toBeUndefined();
  expect(entry.attachmentsLost).toBeUndefined();
  const rows = await prisma.customerPendingMedia.findMany({ where: { subscriberId, mid } });
  expect(rows).toHaveLength(1);
  expect(rows[0].files).toEqual([]);
  // Повторный проход inbox-consume скачивание не запускает (реплика уже записана), но и пустоты не остаётся:
  expect(await prepareCustomerDmInboxCoreContext(event)).toMatchObject({ status: "prepared" });
  expect(await prisma.customerPendingMedia.count({ where: { subscriberId, mid } })).toBe(1);
  // Свежая заявка сверкой не трогается (скачивание могло просто стоять в очереди):
  expect((await settleStalePendingCustomerMedia(new Date())).settled).toBe(0);
  // Через десять минут — пометка «не скачалось» на реплике, заявка снята.
  expect((await settleStalePendingCustomerMedia(new Date(Date.now() + 11 * 60_000))).settled).toBe(1);
  const after = (await userEntry(conversationId)).entry;
  expect(after.attachmentsLost).toEqual([{ kind: "image", reason: "failed", settled: true }]);
  expect(await prisma.customerPendingMedia.count({ where: { subscriberId, mid } })).toBe(0);

  // Медленная очередь всё же докачала файл позже сверки: файл заменяет пометку.
  expect(await keepCustomerInputMedia({ channel: "INSTAGRAM", subscriberId, mid, sources: [{ url: "https://scontent.cdninstagram.com/synthetic/crash.jpg", declaredKind: "image" }] })).toBe("attached");
  const healed = (await userEntry(conversationId)).entry;
  savedFiles.push(...(healed.attachments as Array<{ file: string }>).map((a) => a.file));
  expect(healed.attachments).toHaveLength(1);
  expect(healed.attachmentsLost).toBeUndefined();
});

it("заявка с пометкой не уничтожается ночной уборкой раньше срока (двое суток), а сверка снимает её раньше", async () => {
  const owner = await f.owner();
  const event = await f.capture(owner, "", [{ type: "video", payload: { url: "https://scontent.cdninstagram.com/synthetic/keep.mp4" } }]);
  await prepareCustomerDmInboxCoreContext(event);
  const { conversationId } = await ticketOf(event) as { conversationId: string };
  const { entry, subscriberId } = await userEntry(conversationId);
  const mid = entry.mid as string;
  expect((await cleanupStalePendingCustomerMedia(new Date(Date.now() + 60 * 60_000))).deleted).toBe(0);
  expect(await prisma.customerPendingMedia.count({ where: { subscriberId, mid } })).toBe(1);
  await settleStalePendingCustomerMedia(new Date(Date.now() + 11 * 60_000));
  expect((await userEntry(conversationId)).entry.attachmentsLost).toEqual([{ kind: "video", reason: "failed", settled: true }]);
});
