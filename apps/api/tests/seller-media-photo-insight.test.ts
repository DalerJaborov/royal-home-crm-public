import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/**
 * Задание seller-photo-insight (jobs/sellerPhotoInsight.ts, lib/sellerMedia.ts) —
 * «Объект продавца заполняется сам», задание МЕДИА, 21.09.2026.
 *
 * Правило экономии токенов §5: один vision-вызов на пачку НОВЫХ снимков, кэш
 * ChatPhotoInsight по sha256 — снимок, уже посчитанный однажды (для любого
 * клиента, ключ не привязан к переписке), второй раз в модель не идёт.
 * callAiText замокан целиком — сам вызов ИИ живёт в отдельном контуре
 * (geminiClient.ts), здесь проверяется только контракт джоба вокруг него.
 */

const aiCalls: { images?: { data: string }[] }[] = [];
let aiReply: { photos: { index: number; isPlan: boolean; condition?: string | null; rooms?: number | null; score: number }[] } | null =
  null;
/** Если задан — отвечает по числу снимков в вызове (пачки больше 12 идут несколькими вызовами). */
let aiReplyFn: ((imagesCount: number) => typeof aiReply) | null = null;
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: async (params: { images?: { data: string }[] }) => {
    aiCalls.push(params);
    return aiReplyFn ? aiReplyFn(params.images?.length ?? 0) : aiReply;
  },
}));

import { prisma } from "../src/db.js";
import { savePrivateFile, privateFilePath } from "../src/lib/privateFiles.js";
import { sellerPhotoInsightJob, PHOTO_INSIGHT_SCHEMA } from "../src/jobs/sellerPhotoInsight.js";

/**
 * 23-24.09.2026 — прод: 14 отказов Gemini HTTP 400 «Invalid JSON payload received.
 * Unknown name "type" at 'tools[0].function_declarations…» подряд, задание ни разу
 * не отработало (0 строк в ChatPhotoInsight). Причина: `condition`/`rooms` в схеме
 * были объявлены как `type: ["string"/"number", "null"]` с null в enum — Gemini
 * принимает не JSON Schema, а её OpenAPI-подмножество (function_declarations
 * parameters), где `type` — одиночная строка, а не массив; тот же запрет уже
 * задокументирован в ai/topicLock.ts. Проверяем форму РЕКУРСИВНО, чтобы регрессия
 * не прошла тихо, если кто-то снова добавит "null" в type у любого поля.
 */
function assertNoArrayTypeOrNullEnum(node: unknown, path = "schema"): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if ("type" in obj) {
    expect(Array.isArray(obj.type), `${path}.type не должен быть массивом (OpenAPI-подмножество Gemini)`).toBe(false);
  }
  if (Array.isArray(obj.enum)) {
    expect(obj.enum.includes(null), `${path}.enum не должен содержать null`).toBe(false);
  }
  if (obj.properties && typeof obj.properties === "object") {
    for (const [key, value] of Object.entries(obj.properties as Record<string, unknown>)) {
      assertNoArrayTypeOrNullEnum(value, `${path}.properties.${key}`);
    }
  }
  if (obj.items) assertNoArrayTypeOrNullEnum(obj.items, `${path}.items`);
}

const runId = Date.now();
let agentId: string;
let clientId: string;
const createdPrivateFiles: string[] = [];
const createdConversationIds: string[] = [];
const createdSha256: string[] = [];

function tinyJpeg(shade: number): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
}

/** Заведомо разные байты (своя ширина у каждого), иначе соседние оттенки сжимаются в один jpeg и sha256 совпадает. */
function distinctJpeg(i: number): Promise<Buffer> {
  return sharp({ create: { width: 8 + i, height: 8, channels: 3, background: { r: 40 + i, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
}

async function makeConversation(clientIdArg: string, buffers: Buffer[]) {
  const files: string[] = [];
  for (const buf of buffers) {
    const name = (await savePrivateFile(buf, "image/jpeg"))!;
    createdPrivateFiles.push(name);
    files.push(name);
  }
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `seller-photo-insight-${runId}-${randomUUID().slice(0, 8)}`,
      clientId: clientIdArg,
      messages: files.map((file, i) => ({
        role: "user",
        content: `[фото ${i}]`,
        attachments: [{ kind: "image", file, mime: "image/jpeg" }],
        at: new Date(Date.now() + i * 1000).toISOString(),
      })),
      lastMessageAt: new Date(),
    },
  });
  createdConversationIds.push(conversation.id);
}

beforeEach(() => {
  aiCalls.length = 0;
  aiReply = null;
  aiReplyFn = null;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.chatPhotoInsight.deleteMany({ where: { sha256: { in: createdSha256 } } });
  for (const name of createdPrivateFiles) {
    const full = privateFilePath(name);
    if (full) fs.rmSync(full, { force: true });
  }
  await prisma.$disconnect();
});

describe("задание seller-photo-insight", () => {
  it("оценивает новые фото и пишет кэш по sha256", async () => {
    const agent = await prisma.agent.create({
      data: { fullName: `Агент оценки фото ${runId}`, phone: `+992939${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    });
    agentId = agent.id;
    const client = await prisma.client.create({
      data: {
        fullName: `Продавец оценки фото ${runId}`,
        phone: `+99294${String(runId).slice(-7)}`,
        source: "WHATSAPP",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientId = client.id;

    const [room, plan] = await Promise.all([tinyJpeg(30), tinyJpeg(180)]);
    createdSha256.push(createHash("sha256").update(room).digest("hex"), createHash("sha256").update(plan).digest("hex"));
    await makeConversation(clientId, [room, plan]);

    aiReply = {
      photos: [
        { index: 0, isPlan: false, condition: "EXCELLENT", score: 91 },
        { index: 1, isPlan: true, condition: null, rooms: 3, score: 4 },
      ],
    };

    await sellerPhotoInsightJob.run({ clientId });

    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].images).toHaveLength(2);

    const insights = await prisma.chatPhotoInsight.findMany({ where: { sha256: { in: createdSha256 } }, orderBy: { score: "desc" } });
    expect(insights).toHaveLength(2);
    expect(insights[0]).toMatchObject({ isPlan: false, condition: "EXCELLENT", score: 91 });
    expect(insights[1]).toMatchObject({ isPlan: true, condition: null, rooms: 3, score: 4 });
  });

  it("уже оценённый снимок (sha256 в кэше) второй раз в модель не уходит", async () => {
    // Кэш из предыдущего теста ("insights[0]" выше) уже лежит в таблице для
    // тех же двух sha256 — повторный запуск на том же клиенте не должен звать ИИ.
    await sellerPhotoInsightJob.run({ clientId });
    expect(aiCalls).toHaveLength(0);
  });

  it("отказ ИИ (null) не бросает исключение и не пишет кэш — мастер просто откроется без оценки", async () => {
    const freshClient = await prisma.client.create({
      data: {
        fullName: `Продавец без денег на ИИ ${runId}`,
        phone: `+99295${String(runId).slice(-7)}`,
        source: "WHATSAPP",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    const photo = await tinyJpeg(222);
    const sha = createHash("sha256").update(photo).digest("hex");
    await makeConversation(freshClient.id, [photo]);

    aiReply = null; // Gemini 402 — тот же контракт, что и у остальных вызовов ИИ.

    await expect(sellerPhotoInsightJob.run({ clientId: freshClient.id })).resolves.toBeUndefined();

    const row = await prisma.chatPhotoInsight.findUnique({ where: { sha256: sha } });
    expect(row).toBeNull();

    await prisma.client.delete({ where: { id: freshClient.id } });
  });

  /**
   * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-31: задание брало максимум 12 новых снимков и
   * завершалось успешно; остаток не ставился повторно (dedupeKey живёт до финального
   * статуса), и без нового сообщения снимки 13+ оставались без оценки навсегда.
   */
  it("13 снимков за одно окно: оцениваются все 13 (вторая пачка внутри того же запуска)", async () => {
    const sellerClient = await prisma.client.create({
      data: {
        fullName: `Продавец 13 фото ${runId}`,
        phone: `+99296${String(runId).slice(-7)}`,
        source: "WHATSAPP",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    const buffers: Buffer[] = [];
    for (let i = 0; i < 13; i++) buffers.push(await distinctJpeg(i));
    const shas = buffers.map((b) => createHash("sha256").update(b).digest("hex"));
    createdSha256.push(...shas);
    await makeConversation(sellerClient.id, buffers);
    aiReplyFn = (n) => ({ photos: Array.from({ length: n }, (_, index) => ({ index, isPlan: false, score: 50 })) });

    await sellerPhotoInsightJob.run({ clientId: sellerClient.id });

    expect(await prisma.chatPhotoInsight.count({ where: { sha256: { in: shas } } })).toBe(13);
    expect(aiCalls.map((c) => c.images?.length)).toEqual([12, 1]);
    await prisma.client.delete({ where: { id: sellerClient.id } });
  });

  it("очень много снимков: число вызовов ИИ за запуск ограничено, остаток ждёт следующего сообщения", async () => {
    const sellerClient = await prisma.client.create({
      data: {
        fullName: `Продавец 60 фото ${runId}`,
        phone: `+99297${String(runId).slice(-7)}`,
        source: "WHATSAPP",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    const buffers: Buffer[] = [];
    for (let i = 0; i < 60; i++) buffers.push(await distinctJpeg(100 + i));
    const shas = buffers.map((b) => createHash("sha256").update(b).digest("hex"));
    createdSha256.push(...shas);
    await makeConversation(sellerClient.id, buffers);
    aiReplyFn = (n) => ({ photos: Array.from({ length: n }, (_, index) => ({ index, isPlan: false, score: 50 })) });

    await sellerPhotoInsightJob.run({ clientId: sellerClient.id });

    expect(aiCalls.length).toBe(4);
    expect(await prisma.chatPhotoInsight.count({ where: { sha256: { in: shas } } })).toBe(48);
    await prisma.client.delete({ where: { id: sellerClient.id } });
  });

  it("схема ответа не содержит массив type / null в enum (Gemini HTTP 400, прод 22-23.09)", () => {
    assertNoArrayTypeOrNullEnum(PHOTO_INSIGHT_SCHEMA);
  });
});
