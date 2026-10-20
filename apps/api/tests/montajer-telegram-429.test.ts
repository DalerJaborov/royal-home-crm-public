import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers/waitFor.js";

/**
 * 15 ФАЙЛОВ ПОДРЯД И ЛИМИТ TELEGRAM (25.09.2026, задание B1). Здесь НЕ подменяется
 * telegram/api.ts — настоящий sendDocumentFile с настоящим повтором по
 * `retry_after` (postMultipartWithRetry), подменён только сетевой fetch: он
 * играет роль Bot API и на 7-м файле отвечает 429.
 *
 * Проверяем:
 *  — пауза между файлами одному чату держится (≥ 1,1 с), и никакой файл не
 *    теряется, когда Telegram всё же просит подождать: ждём retry_after и шлём
 *    тот же файл, все 15 доходят по порядку;
 *  — если Telegram просит ждать дольше минуты (flood-wait), круг честно
 *    останавливается, не долбя чат остальными файлами: они не отмечены как
 *    дошедшие, `videoHandoffDeliveredAt` пуст — сторож дошлёт.
 */

process.env.TELEGRAM_BOT_TOKEN = "429:test-token";
delete process.env.TELEGRAM_API_BASE_URL;

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { prisma } = await import("../src/db.js");
const { dispatchToEditor, setMontajerSendPauseMsForTests } = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const phone = `+99294${runId.toString().slice(-7)}`;
const MONTAJER_CHAT = `7${runId.toString().slice(-8)}`;
let districtId: string;
let montajerId: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;
const realFetch = globalThis.fetch;

type DocAttempt = { name: string; at: number; answered: 200 | 429 };
let attempts: DocAttempt[] = [];

/** Bot API в памяти: 429 с retry_after на заданный по счёту документ, один раз. */
function fakeBotApi(opts: { rateLimitOnDocument: number; retryAfterSec: number; repeat429?: boolean }) {
  let documents = 0;
  let limited = false;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/bot429:test-token/")) throw new Error(`тест не ходит в сеть: ${url}`);
    const method = url.split("/").pop();
    if (method === "sendDocument" && init?.body instanceof FormData) {
      const file = init.body.get("document") as File;
      documents++;
      if (documents === opts.rateLimitOnDocument || (opts.repeat429 && limited)) {
        limited = true;
        attempts.push({ name: file.name, at: Date.now(), answered: 429 });
        return new Response(
          JSON.stringify({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${opts.retryAfterSec}`, parameters: { retry_after: opts.retryAfterSec } })
        );
      }
      attempts.push({ name: file.name, at: Date.now(), answered: 200 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: documents, document: { file_id: `fid-${file.name}`, file_unique_id: `u-${file.name}` } } }));
    }
    // sendMessage (контрольное «отправлено N из N») и прочее — просто «ок».
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch;
}

async function seedHolderWithVideos(count: number) {
  const p = await prisma.property.create({
    data: {
      title: `Лимит Telegram-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 350000,
      currency: "TJS",
      districtId,
      address: "Лимитная, 7",
      condition: "GOOD",
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: new Date(),
    },
  });
  propertyIds.push(p.id);
  const base = Date.now() - 60_000;
  for (let i = 0; i < count; i++) {
    const storageKey = `${p.id}/${randomUUID()}.mp4`;
    const filePath = localVideoFilePath(storageKey);
    if (!filePath) throw new Error("путь хранилища не разрешился");
    await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.alloc(256));
    rawDirs.add(pathMod.dirname(filePath));
    await prisma.propertyVideo.create({
      data: { propertyId: p.id, storageKey, filename: `raw-${i + 1}.mp4`, sizeBytes: 256, uploadedById: montajerId, uploadedAt: new Date(base + i) },
    });
  }
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Лимит Telegram-${runId}` } })).id;
  montajerId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр лимита", phone, role: "EDITOR", passwordHash: await bcrypt.hash("testpass123", 4), telegramChatId: MONTAJER_CHAT },
    })
  ).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoHandoffEnabled: true, videoMontajerAgentId: true } });
  originalSettings = s ? { videoHandoffEnabled: s.videoHandoffEnabled, videoMontajerAgentId: s.videoMontajerAgentId } : null;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
});

beforeEach(async () => {
  attempts = [];
  await prisma.property.updateMany({
    where: { videoHandoffStatus: "SENT_TO_EDITOR", id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED" },
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setMontajerSendPauseMsForTests();
  await prisma.settings.update({ where: { id: "singleton" }, data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("15 файлов подряд через настоящий telegram/api.ts", () => {
  it("429 на 7-м — ждём retry_after и шлём тот же файл; пауза между файлами держится; все 15 дошли по порядку", async () => {
    setMontajerSendPauseMsForTests(); // боевая пауза 1,1 с
    fakeBotApi({ rateLimitOnDocument: 7, retryAfterSec: 1 });
    const p = await seedHolderWithVideos(15);

    expect(await dispatchToEditor(p.id, montajerId)).toBe(true);

    const ok = attempts.filter((a) => a.answered === 200);
    expect(ok.map((a) => a.name)).toEqual(Array.from({ length: 15 }, (_, i) => `${p.shortId}_${i + 1}из15.mp4`));
    const limited = attempts.find((a) => a.answered === 429)!;
    expect(limited.name).toBe(`${p.shortId}_7из15.mp4`);
    // Повтор того же файла — не раньше retry_after (1 с) + запас 1 с из api.ts.
    const retried = ok.find((a) => a.name === limited.name)!;
    expect(retried.at - limited.at).toBeGreaterThanOrEqual(2_000 - 50);
    // Между соседними файлами — не меньше паузы 1,1 с (минус дрожь таймера).
    for (let i = 1; i < ok.length; i++) expect(ok[i]!.at - ok[i - 1]!.at).toBeGreaterThanOrEqual(1_100 - 50);

    // file_id пишется «в отрыве» — дожидаемся (tests/helpers/waitFor.ts).
    await waitFor(async () => {
      const videos = await prisma.propertyVideo.findMany({ where: { propertyId: p.id } });
      return videos.every((v) => v.telegramFileId && v.montajerDeliveredToId === montajerId);
    });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffDeliveredAt: true } });
    expect(after.videoHandoffDeliveredAt).not.toBeNull();
  }, 60_000);

  it("Telegram просит ждать дольше минуты — круг останавливается на 7-м, остальные не долбим, доставка не отмечена", async () => {
    setMontajerSendPauseMsForTests(0);
    fakeBotApi({ rateLimitOnDocument: 7, retryAfterSec: 120, repeat429: true });
    const p = await seedHolderWithVideos(15);

    expect(await dispatchToEditor(p.id, montajerId)).toBe(false);

    // 6 дошли, 7-й получил 429 один раз, 8–15 не отправлялись вовсе.
    expect(attempts.filter((a) => a.answered === 200)).toHaveLength(6);
    expect(attempts.filter((a) => a.answered === 429)).toHaveLength(1);
    const videos = await prisma.propertyVideo.findMany({ where: { propertyId: p.id }, orderBy: { uploadedAt: "asc" } });
    expect(videos.map((v) => v.montajerDeliveredToId === montajerId)).toEqual([...Array(6).fill(true), ...Array(9).fill(false)]);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffDeliveredAt: true } });
    expect(after.videoHandoffDeliveredAt).toBeNull();
    const journal = await waitFor(() => prisma.montajerMessage.findFirst({ where: { propertyId: p.id }, orderBy: { sentAt: "desc" } }));
    expect(journal.text.match(/✗ не дошёл/g)?.length).toBe(9);
  }, 30_000);
});
