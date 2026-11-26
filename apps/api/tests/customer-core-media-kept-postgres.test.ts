import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture } from "./helpers/customerCoreGoldenFixture.js";
import { waitFor } from "./helpers/waitFor.js";
import { privateFilePath } from "../src/lib/privateFiles.js";
import { presentMessages } from "../src/lib/messageAttachments.js";
import type { FetchedAttachments } from "../src/messengers/attachments.js";

/**
 * ОСНОВНОЙ ПУТЬ ПРИЁМА КЛИЕНТА СОХРАНЯЕТ ФАЙЛ (26.11.2026, жалоба владельца, повторная).
 *
 * Прод 25–26.11: 8 клиентских файлов из 8 потеряно молча — реплика «[вложение без текста]»,
 * ни файла, ни пометки. Хуки сохранения (#428) стояли в старом цикле и в ветке HELD вебхука, а
 * клиентов ведёт ядро: подписанный вебхук → durable-вход → customer-inbox-consume →
 * prepareCustomerDmInboxCoreContext → recordScopedCustomerInput. Этот тест идёт именно им —
 * подлинный подписанный вход Instagram со вложением, настоящая запись реплики; подменён только
 * транспорт скачивания (Graph/CDN).
 */

const fetched = vi.hoisted(() => ({ value: null as unknown, sources: [] as Array<{ url: string; declaredKind?: string }>, profile: "" }));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/attachments.js")>();
  return {
    ...actual,
    fetchAttachments: vi.fn(async (sources: Array<{ url: string; declaredKind?: string }>, _managed?: unknown, _max?: number, profile?: string) => {
      fetched.sources = sources; fetched.profile = profile ?? "model"; return fetched.value;
    }),
  };
});
const { prepareCustomerDmInboxCoreContext } = await import("../src/lib/customerDmCoreContext.js");

let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
const savedFiles: string[] = [];
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const name of savedFiles) { const full = privateFilePath(name); if (full) fs.rmSync(full, { force: true }); }
  await f?.cleanup();
});
beforeEach(async () => {
  fetched.sources = []; fetched.profile = "";
  fetched.value = { images: [{ kind: "image", mediaType: "image/jpeg",
    data: (await sharp({ create: { width: 32, height: 32, channels: 3, background: "#336699" } }).jpeg().toBuffer()).toString("base64") }],
  audios: [], medias: [], hadUnsupported: false, lost: [] } satisfies FetchedAttachments;
});

async function recordedEntry(eventKey: string) {
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
  const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! }, select: { messages: true } });
  const entry = (row.messages as Array<Record<string, unknown>>).find((m) => m.role === "user" && m.customerPropertyAdmission);
  return { entry: entry!, conversationId: ticket.conversationId! };
}

it("фото без текста: файл лежит в реплике, ложной пометки «не сохранилось» нет", async () => {
  const owner = await f.owner();
  const event = await f.capture(owner, "", [{ type: "image", payload: { url: "https://scontent.cdninstagram.com/synthetic/photo.jpg" } }]);
  expect(await prepareCustomerDmInboxCoreContext(event)).toMatchObject({ status: "prepared" });
  const entry = await waitFor(async () => {
    const { entry: e } = await recordedEntry(event);
    return Array.isArray(e.attachments) && e.attachments.length ? e : false;
  });
  const files = (entry.attachments as Array<{ kind: string; file: string }>);
  savedFiles.push(...files.map((a) => a.file));
  expect(files).toHaveLength(1);
  expect(files[0].kind).toBe("image");
  expect(entry.attachmentsLost).toBeUndefined();
  expect(fetched.profile).toBe("staff"); // потолки платформы, а не разбора моделью
  expect(fetched.sources.map((s) => s.url)).toEqual(["https://scontent.cdninstagram.com/synthetic/photo.jpg"]);
  expect(presentMessages([entry], true).at(0)?.attachments?.map((a) => a.lost)).toEqual([undefined]);
});

it("файл не скачался: пометка с причиной на месте вложения, а не тишина", async () => {
  const owner = await f.owner();
  fetched.value = { images: [], audios: [], medias: [], hadUnsupported: true, lost: [{ kind: "video", reason: "too_big" }] } satisfies FetchedAttachments;
  const event = await f.capture(owner, "", [{ type: "video", payload: { url: "https://scontent.cdninstagram.com/synthetic/clip.mp4" } }]);
  await prepareCustomerDmInboxCoreContext(event);
  const entry = await waitFor(async () => {
    const { entry: e } = await recordedEntry(event);
    return Array.isArray(e.attachmentsLost) && e.attachmentsLost.length ? e : false;
  });
  expect(entry.attachmentsLost).toEqual([{ kind: "video", reason: "too_big" }]);
  expect(presentMessages([entry], true).at(0)?.attachments?.[0]).toMatchObject({ kind: "video", lost: "too_big", file: null });
});

it("платформа заявила файл, но адреса нет: пометка «канал не отдал файл», скачивание даже не пытаются", async () => {
  const owner = await f.owner();
  const event = await f.capture(owner, "", [{ type: "audio", payload: {} }]);
  await prepareCustomerDmInboxCoreContext(event);
  const entry = await waitFor(async () => {
    const { entry: e } = await recordedEntry(event);
    return Array.isArray(e.attachmentsLost) && e.attachmentsLost.length ? e : false;
  });
  expect(entry.attachmentsLost).toEqual([{ kind: "audio", reason: "unavailable" }]);
  expect(fetched.sources).toEqual([]);
});

it("повторная подготовка той же реплики не плодит файлы", async () => {
  const owner = await f.owner();
  const event = await f.capture(owner, "", [{ type: "image", payload: { url: "https://scontent.cdninstagram.com/synthetic/again.jpg" } }]);
  await prepareCustomerDmInboxCoreContext(event);
  await waitFor(async () => { const { entry } = await recordedEntry(event); return Array.isArray(entry.attachments) && entry.attachments.length === 1; });
  await prepareCustomerDmInboxCoreContext(event);
  const { entry } = await recordedEntry(event);
  savedFiles.push(...(entry.attachments as Array<{ file: string }>).map((a) => a.file));
  expect(entry.attachments).toHaveLength(1);
});
