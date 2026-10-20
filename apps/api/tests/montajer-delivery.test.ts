import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers/waitFor.js";

/**
 * МНОГО ФАЙЛОВ БЕЗ ПОТЕРЬ И БЕЗ ПУТАНИЦ (25.09.2026, владелец: «если там 15, все
 * 15 должен получить монтажёр, в прошлый раз был баг»; «защиту поставь, чтобы
 * вообще никогда ни описания, ни ролики не путались»).
 *
 * Интеграция на базе стенда: настоящие dispatchToEditor / сторож досылки /
 * журнал, подменён только Telegram (sendDocumentFile/sendDocument/sendMessage).
 * Повтор по 429 на уровне самого Bot API — tests/montajer-telegram-429.test.ts.
 */

const { sendMessage, sendDocumentFile, sendDocument, sendPushToAgent, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
  sendDocumentFile: vi.fn(),
  sendDocument: vi.fn(),
  sendPushToAgent: vi.fn(async () => {}),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
  sendDocument,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { prisma } = await import("../src/db.js");
const { dispatchToEditor, setMontajerSendPauseMsForTests, resendSourceVideos } = await import("../src/lib/videoHandoff.js");
const { runVideoHandoffRedeliveryTick, redeliveryDelayMs } = await import("../src/lib/videoHandoffRedelivery.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const phone = `+99293${runId.toString().slice(-7)}`;
const MONTAJER_CHAT = `8${runId.toString().slice(-8)}`;
let districtId: string;
let montajerId: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

/** Что «ушло» в Telegram: каждый вызов с именем и подписью, по порядку. */
type SentCall = { kind: "file" | "fileId"; name: string | null; caption: string };
let sent: SentCall[] = [];

/** Поведение подменённого Telegram: по умолчанию всё доходит, file_id — от имени. */
function telegramWorks(failOn: (name: string, callNo: number) => boolean = () => false) {
  let callNo = 0;
  sendDocumentFile.mockReset().mockImplementation(async (_chat: string, _file: unknown, name: string, caption: string) => {
    callNo++;
    sent.push({ kind: "file", name, caption });
    if (failOn(name, callNo)) throw new Error("Telegram API sendDocument (файлом): timeout");
    return { message_id: callNo, document: { file_id: `fid-${name}`, file_unique_id: `u-${name}` } };
  });
  sendDocument.mockReset().mockImplementation(async (_chat: string, _fileId: string, caption: string) => {
    sent.push({ kind: "fileId", name: null, caption });
    return {};
  });
}

async function seedProperty(label: string) {
  const p = await prisma.property.create({
    data: {
      title: `Много файлов-${label}-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 61,
      price: 410000,
      currency: "TJS",
      districtId,
      address: `Проверочная, ${propertyIds.length + 1}`,
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return p;
}

/** N исходников с разными именами и строгим временем загрузки (порядок = i). */
async function addRawVideos(propertyId: string, count: number) {
  const base = Date.now() - 60 * 60 * 1000;
  for (let i = 0; i < count; i++) {
    const storageKey = `${propertyId}/${randomUUID()}.mp4`;
    const filePath = localVideoFilePath(storageKey);
    if (!filePath) throw new Error("путь хранилища не разрешился");
    await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.alloc(512 + i));
    rawDirs.add(pathMod.dirname(filePath));
    await prisma.propertyVideo.create({
      data: {
        propertyId,
        storageKey,
        filename: `raw-${i + 1}.mp4`,
        sizeBytes: 512 + i,
        uploadedById: montajerId,
        uploadedAt: new Date(base + i * 1000),
      },
    });
  }
}

/** Объект занимает место монтажёра — как после выдачи из очереди. */
async function seat(propertyId: string) {
  await prisma.property.update({
    where: { id: propertyId },
    data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffDeliveredAt: null, videoHandoffDispatchAttempts: 0 },
  });
}

async function release(propertyId: string) {
  await prisma.property.update({ where: { id: propertyId }, data: { videoHandoffStatus: "NONE" } });
}

/** Журнал и file_id пишутся «в отрыве» (void) — читать только дождавшись. */
async function journalEntry(propertyId: string, nth: number) {
  const rows = await waitFor(
    async () => {
      const found = await prisma.montajerMessage.findMany({ where: { propertyId, kind: "HANDOFF" }, orderBy: { sentAt: "asc" } });
      return found.length >= nth ? found : null;
    },
    { label: `запись журнала №${nth}` }
  );
  return rows[nth - 1]!;
}

async function videosWithFileIds(propertyId: string) {
  return waitFor(
    async () => {
      const videos = await prisma.propertyVideo.findMany({ where: { propertyId }, orderBy: { uploadedAt: "asc" } });
      return videos.every((v) => v.telegramFileId !== null) ? videos : null;
    },
    { label: "file_id у всех файлов" }
  );
}

/** Все номера объектов «№NNN» в тексте. */
function objectNumbers(text: string): number[] {
  return [...text.matchAll(/№(\d+)/g)].map((m) => Number(m[1]));
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Много файлов-${runId}` } })).id;
  montajerId = (
    await prisma.agent.create({
      data: {
        fullName: "Монтажёр пятнадцати файлов",
        phone,
        role: "EDITOR",
        passwordHash: await bcrypt.hash("testpass123", 4),
        telegramChatId: MONTAJER_CHAT,
      },
    })
  ).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoHandoffEnabled: true, videoMontajerAgentId: true } });
  originalSettings = s ? { videoHandoffEnabled: s.videoHandoffEnabled, videoMontajerAgentId: s.videoMontajerAgentId } : null;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
  // Боевая пауза 1,1 с между файлами — 16 секунд на каждые 15 файлов; сама
  // пауза проверена в montajer-telegram-429.test.ts, здесь проверяем порядок.
  setMontajerSendPauseMsForTests(0);
});

beforeEach(async () => {
  // Чужие висящие передачи в общей базе мешали бы «место монтажёра одно».
  await prisma.property.updateMany({
    where: { videoHandoffStatus: "SENT_TO_EDITOR", id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED" },
  });
  sent = [];
  sendMessage.mockReset().mockResolvedValue(undefined);
  logSystemError.mockClear();
  telegramWorks();
});

afterEach(async () => {
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { videoHandoffStatus: "NONE" } });
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null },
  });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("15 файлов одного объекта", () => {
  it("все 15 уходят по порядку, в каждой подписи номер объекта, доставка отмечена, «15 из 15», в журнале 15 строк", async () => {
    const p = await seedProperty("15");
    await addRawVideos(p.id, 15);
    await seat(p.id);

    expect(await dispatchToEditor(p.id, montajerId)).toBe(true);

    expect(sent).toHaveLength(15);
    sent.forEach((call, i) => {
      expect(call.kind).toBe("file");
      expect(call.name).toBe(`${p.shortId}_${i + 1}из15.mp4`);
      expect(call.caption.startsWith(`Объект №${p.shortId} · файл ${i + 1} из 15`)).toBe(true);
    });
    // Файл i — это исходник i по времени загрузки (file_id выдан по имени).
    const videos = await videosWithFileIds(p.id);
    videos.forEach((v, i) => {
      expect(v.telegramFileId).toBe(`fid-${p.shortId}_${i + 1}из15.mp4`);
      expect(v.montajerDeliveredToId).toBe(montajerId);
      expect(v.montajerDeliveredAt).not.toBeNull();
    });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffDeliveredAt: true } });
    expect(after.videoHandoffDeliveredAt).not.toBeNull();

    const texts = sendMessage.mock.calls.map((c) => String(c[1]));
    expect(texts).toContain(`Отправлено 15 из 15 файлов объекта №${p.shortId}.`);

    const journal = await journalEntry(p.id, 1);
    expect(journal.text).toContain("Файлов: 15");
    for (let i = 1; i <= 15; i++) expect(journal.text).toContain(`${i}. raw-${i}.mp4 — `);
    expect(journal.text.match(/✓ файлом/g)?.length).toBe(15);
  });

  it("сбой на 7-м без повтора — доставка не отмечена, «дошло 14 из 15»; сторож досылает ТОЛЬКО 7-й", async () => {
    const p = await seedProperty("15-сбой");
    await addRawVideos(p.id, 15);
    await seat(p.id);
    telegramWorks((name, callNo) => callNo === 7);

    expect(await dispatchToEditor(p.id, montajerId)).toBe(false);

    const s = await prisma.property.findUniqueOrThrow({
      where: { id: p.id },
      select: { videoHandoffDeliveredAt: true, videoHandoffSentAt: true, videoHandoffDispatchAttempts: true },
    });
    expect(s.videoHandoffDeliveredAt).toBeNull();
    expect(sent).toHaveLength(15); // сбой одного не останавливает остальные
    expect(sendMessage.mock.calls.map((c) => String(c[1]))).toContain(
      `Объект №${p.shortId}: дошло 14 из 15 файлов, остальное дошлю автоматически.`
    );
    const journal = await journalEntry(p.id, 1);
    expect(journal.text).toContain("7. raw-7.mp4 — 0 МБ — ✗ не дошёл");

    sent = [];
    telegramWorks();
    sendMessage.mockClear();
    const tick = await runVideoHandoffRedeliveryTick(
      new Date(s.videoHandoffSentAt!.getTime() + redeliveryDelayMs(s.videoHandoffDispatchAttempts) + 1000)
    );
    expect(tick.redelivered).toBe(1);
    expect(sent).toEqual([{ kind: "file", name: `${p.shortId}_7из15.mp4`, caption: expect.stringMatching(new RegExp(`^Объект №${p.shortId} · файл 7 из 15`)) }]);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffDeliveredAt: true } });
    expect(after.videoHandoffDeliveredAt).not.toBeNull();
    expect(sendMessage.mock.calls.map((c) => String(c[1]))).toContain(`Отправлено 15 из 15 файлов объекта №${p.shortId}.`);
    // Журнал досылки честно помнит, что 14 уже были у монтажёра.
    const second = await journalEntry(p.id, 2);
    expect(second.text.match(/✓ уже был у монтажёра/g)?.length).toBe(14);
  });

  it("«файлы» при всех 15 у монтажёра — ничего не шлёт и отвечает «уже у вас»", async () => {
    const p = await seedProperty("15-повтор");
    await addRawVideos(p.id, 15);
    await seat(p.id);
    await dispatchToEditor(p.id, montajerId);
    sent = [];

    const resent = await resendSourceVideos();

    expect(resent).toEqual({ ok: false, shortId: p.shortId, alreadyAll: 15 });
    expect(sent).toHaveLength(0);
  });
});

describe("два объекта подряд — подписи и файлы не перепутаны", () => {
  it("каждая подпись и каждое имя несут номер своего объекта и ни одного чужого", async () => {
    const a = await seedProperty("А");
    const b = await seedProperty("Б");
    await addRawVideos(a.id, 3);
    await addRawVideos(b.id, 4);

    await seat(a.id);
    await dispatchToEditor(a.id, montajerId);
    const forA = sent;
    await release(a.id);
    sent = [];
    await seat(b.id);
    await dispatchToEditor(b.id, montajerId);
    const forB = sent;

    expect(forA).toHaveLength(3);
    expect(forB).toHaveLength(4);
    for (const [calls, own] of [
      [forA, a.shortId],
      [forB, b.shortId],
    ] as const) {
      for (const call of calls) {
        expect(call.name!.startsWith(`${own}`)).toBe(true);
        expect(new Set(objectNumbers(call.caption))).toEqual(new Set([own]));
      }
    }
  });
});

/**
 * СВОЙСТВО: случайные наборы и случайные сбои. fast-check в зависимостях нет —
 * простой цикл по 50 наборам с воспроизводимым генератором (номер набора в
 * тексте падения укажет, какой повторить).
 */
function seededRandom(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

describe("свойство: любые N от 1 до 20 и любые сбои — после досылки у всех file_id, чужих номеров нет", () => {
  it("50 случайных наборов", async () => {
    const rnd = seededRandom(20260925);
    const objects: { id: string; shortId: number }[] = [];
    for (let run = 0; run < 50; run++) {
      const n = 1 + Math.floor(rnd() * 20);
      const failing = new Set(Array.from({ length: n }, (_, i) => i + 1).filter(() => rnd() < 0.3));
      const p = await seedProperty(`свойство-${run}`);
      objects.push(p);
      await addRawVideos(p.id, n);
      await seat(p.id);
      sent = [];
      // Первый круг — со сбоями на выбранных файлах, дальше Telegram здоров.
      telegramWorks((name) => failing.has(Number(name.match(/_(\d+)из/)?.[1] ?? 1)));
      await dispatchToEditor(p.id, montajerId);
      const firstRound = [...sent];
      telegramWorks();
      // Досылка (как сторож): только недошедшее, пока не дойдёт всё.
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffDeliveredAt: true } });
        if (st.videoHandoffDeliveredAt) break;
        await dispatchToEditor(p.id, montajerId);
      }
      const videos = await videosWithFileIds(p.id);
      const context = `набор ${run}: N=${n}, сбои=${[...failing].join(",")}`;
      expect(videos.every((v) => v.telegramFileId !== null), context).toBe(true);
      expect(videos.every((v) => v.montajerDeliveredToId === montajerId), context).toBe(true);
      const st = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffDeliveredAt: true } });
      expect(st.videoHandoffDeliveredAt, context).not.toBeNull();
      // Каждый файл первого круга ушёл ровно один раз, досылка — только сбойные.
      expect(firstRound.length, context).toBe(n);
      const resent = sent.slice(firstRound.length);
      expect(resent.length, context).toBe(failing.size);
      for (const call of sent) {
        expect(new Set(objectNumbers(call.caption)), context).toEqual(new Set([p.shortId]));
        if (call.name) expect(call.name.startsWith(`${p.shortId}`), context).toBe(true);
      }
      await release(p.id);
    }
    // Номера всех 50 объектов разные — проверка «ни одного чужого» не вырождена.
    expect(new Set(objects.map((o) => o.shortId)).size).toBe(50);
  }, 180_000);
});
