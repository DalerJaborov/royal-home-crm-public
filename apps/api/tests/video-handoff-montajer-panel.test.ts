import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * ПАНЕЛЬ МОНТАЖЁРА В КАРТОЧКЕ ОБЪЕКТА (25.09.2026, В1 спецификации
 * docs/handoff-2026-09-25-montage-control-spec.md). Монтажёр с ролью EDITOR
 * не видел `PropertyVideoFixCard` в карточке вообще (карточка не монтировала
 * компонент для его роли) — и попутно нашлась дыра: `finishHandoffAfterStateCheck`
 * и старт сессии purpose=handoff проверяли реоткрытие приёма ТОЛЬКО через
 * canManageProperty, а у EDITOR есть properties.editForeign с 08.09.2026 —
 * значит canManageProperty была ИСТИНА для любого монтажёра на любом чужом
 * объекте, и он мог реоткрыть приём готового ролика где угодно, в любом
 * состоянии. finalReopenDeniedReason (routes/properties/videos.ts) закрывает
 * это одной проверкой на оба места входа; montajerMayUploadFinal
 * (packages/shared/src/montajerFinalUpload.ts) — общее правило «когда именно
 * монтажёр может прислать готовый ролик сам».
 *
 * Telegram/пуши/публикация подменены — тест не ходит в реальные каналы.
 */

const { sendMessage, sendDocumentFile, sendPushToAgent, sendPushToAgents, publishApprovedPost, publishAfterEditingComplete, logSystemError } =
  vi.hoisted(() => ({
    sendMessage: vi.fn(async () => {}),
    sendDocumentFile: vi.fn(async () => {}),
    sendPushToAgent: vi.fn(async () => {}),
    sendPushToAgents: vi.fn(async () => 0),
    publishApprovedPost: vi.fn(async () => []),
    publishAfterEditingComplete: vi.fn(async () => ({ updated: {} })),
    logSystemError: vi.fn(async () => {}),
  }));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost,
}));
vi.mock("../src/lib/propertyPipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyPipeline.js")>()),
  publishAfterEditingComplete,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { RESEND_WINDOW_MS } = await import("../src/lib/videoHandoff.js");
const { MONTAJER_FINAL_REPLACE_WINDOW_MS } = await import("@royal-home/shared");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let ownerAgentId: string;
let ownerToken: string;
let editorMontajerId: string;
let editorMontajerToken: string;
const propertyIds: string[] = [];
let previousMontajerAgentId: string | null | undefined;

async function setHandoffSettings(montajerAgentId: string | null) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoMontajerAgentId: montajerAgentId },
    create: { id: "singleton", videoMontajerAgentId: montajerAgentId },
  });
}

async function makeProperty(
  status: "SENT_TO_EDITOR" | "NONE" | "RECEIVED" | "QUEUED" = "SENT_TO_EDITOR",
  extra: {
    receivedAt?: Date;
    publishedChannels?: string[];
    ownerContact?: string;
    assignedAgentId?: string | null;
  } = {}
) {
  const p = await prisma.property.create({
    data: {
      title: `Панель монтажёра ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: extra.assignedAgentId === undefined ? ownerAgentId : extra.assignedAgentId,
      createdById: ownerAgentId,
      ownerContact: extra.ownerContact ?? null,
      videoHandoffStatus: status,
      videoHandoffSentAt: status === "SENT_TO_EDITOR" ? new Date() : null,
      videoHandoffReceivedAt: extra.receivedAt ?? null,
      publishedChannels: extra.publishedChannels ?? [],
    },
  });
  propertyIds.push(p.id);
  return p;
}

function startSession(propertyId: string, token: string, purpose: "raw" | "handoff" = "handoff") {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      uploadKey: `${runId}-${propertyId}-${Math.random().toString(36).slice(2)}`,
      filename: "final.mp4",
      sizeBytes: 1024,
      contentType: "video/mp4",
      purpose,
    });
}

function singleUpload(propertyId: string, token: string) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/video-handoff/upload`)
    .set("Authorization", `Bearer ${token}`)
    .attach("video", Buffer.from("готовый ролик — тест панели монтажёра"), "final.mp4");
}

beforeEach(async () => {
  if (!districtId) {
    districtId = (await prisma.district.create({ data: { name: `Панель монтажёра-${runId}` } })).id;
  }
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
  publishApprovedPost.mockClear();
  publishAfterEditingComplete.mockClear();
  logSystemError.mockClear();

  if (!ownerAgentId) {
    const passwordHash = await bcrypt.hash(password, 10);
    const owner = await prisma.agent.create({
      data: { fullName: "Ведущий объект", phone: `+992960${runId}`, role: "AGENT", passwordHash },
    });
    ownerAgentId = owner.id;
    const editorMontajer = await prisma.agent.create({
      data: { fullName: "Монтажёр панели", phone: `+992961${runId}`, role: "EDITOR", passwordHash },
    });
    editorMontajerId = editorMontajer.id;

    ownerToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992960${runId}`, password })).body.accessToken;
    editorMontajerToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992961${runId}`, password })).body.accessToken;

    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
    previousMontajerAgentId = settings?.videoMontajerAgentId ?? null;
    await setHandoffSettings(editorMontajerId);
  }
});

afterEach(async () => {
  if (propertyIds.length) {
    await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: propertyIds } } });
  }
});

afterAll(async () => {
  await setHandoffSettings(previousMontajerAgentId ?? null);
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerAgentId, editorMontajerId] } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("1-4: EDITOR — реоткрытие приёма только в окне montajerMayUploadFinal (старт сессии purpose=handoff)", () => {
  it("1) объект NONE — 409, текст «не ждёт готовый ролик», состояние объекта не меняется", async () => {
    const p = await makeProperty("NONE");
    const res = await startSession(p.id, editorMontajerToken, "handoff");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не ждёт готовый ролик");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true } });
    expect(after.videoHandoffStatus).toBe("NONE");
  });

  it("2) RECEIVED час назад, без публикаций — 201, объект уходит в SENT_TO_EDITOR с videoHandoffManualSince", async () => {
    const p = await makeProperty("RECEIVED", { receivedAt: new Date(Date.now() - 60 * 60 * 1000), publishedChannels: [] });
    const res = await startSession(p.id, editorMontajerToken, "handoff");
    expect(res.status).toBe(201);
    const after = await prisma.property.findUniqueOrThrow({
      where: { id: p.id },
      select: { videoHandoffStatus: true, videoHandoffManualSince: true },
    });
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(after.videoHandoffManualSince).not.toBeNull();
  });

  it("3) RECEIVED 4 часа назад — за окном, 409", async () => {
    const p = await makeProperty("RECEIVED", { receivedAt: new Date(Date.now() - 4 * 60 * 60 * 1000), publishedChannels: [] });
    const res = await startSession(p.id, editorMontajerToken, "handoff");
    expect(res.status).toBe(409);
  });

  it("4) RECEIVED час назад, но уже опубликован (YOUTUBE) — 409", async () => {
    const p = await makeProperty("RECEIVED", { receivedAt: new Date(Date.now() - 60 * 60 * 1000), publishedChannels: ["YOUTUBE"] });
    const res = await startSession(p.id, editorMontajerToken, "handoff");
    expect(res.status).toBe(409);
  });

  it("5) SENT_TO_EDITOR — 201, обычная передача не сломана", async () => {
    const p = await makeProperty("SENT_TO_EDITOR");
    const res = await startSession(p.id, editorMontajerToken, "handoff");
    expect(res.status).toBe(201);
  });
});

describe("6: одиночная загрузка /:id/video-handoff/upload — та же проверка", () => {
  it("EDITOR, объект NONE — 409 тем же текстом", async () => {
    const p = await makeProperty("NONE");
    const res = await singleUpload(p.id, editorMontajerToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не ждёт готовый ролик");
  });
});

describe("7: регресс — ЗАМЕНА РОЛИКА ВРУЧНУЮ ведущим объект агентом не сломана", () => {
  it("AGENT, ведущий объект, NONE — 201", async () => {
    const p = await makeProperty("NONE");
    const res = await startSession(p.id, ownerToken, "handoff");
    expect(res.status).toBe(201);
  });
});

describe("8: /marketing/video-handoff/:id/resend — EDITOR допущен сервером (не 403), но держателем быть обязан", () => {
  it("объект QUEUED (не держатель) — 409 code NOT_HOLDER, фоновую отправку не запускаем", async () => {
    const p = await makeProperty("QUEUED");
    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${p.id}/resend`)
      .set("Authorization", `Bearer ${editorMontajerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_HOLDER");
  });
});

describe("9: GET /api/v1/properties/:id — контакт собственника скрыт монтажёру, delivered по telegramFileId", () => {
  it("чужой объект: ownerContactHidden true, videos[].delivered соответствует telegramFileId", async () => {
    const p = await makeProperty("SENT_TO_EDITOR", { ownerContact: "+992900000099" });
    await prisma.propertyVideo.create({
      data: {
        propertyId: p.id,
        filename: "raw-delivered.mp4",
        sizeBytes: 1024,
        storageKey: `${p.id}/delivered.mp4`,
        uploadKey: `${runId}-${p.id}-delivered`,
        uploadedById: ownerAgentId,
        telegramFileId: "tg-file-id-delivered",
      },
    });
    await prisma.propertyVideo.create({
      data: {
        propertyId: p.id,
        filename: "raw-not-delivered.mp4",
        sizeBytes: 1024,
        storageKey: `${p.id}/not-delivered.mp4`,
        uploadKey: `${runId}-${p.id}-not-delivered`,
        uploadedById: ownerAgentId,
      },
    });
    // Большой файл: ушёл ссылкой, file_id нет, но отметка «у монтажёра» стоит.
    await prisma.propertyVideo.create({
      data: {
        propertyId: p.id,
        filename: "raw-big-link.mp4",
        sizeBytes: 1024,
        storageKey: `${p.id}/big-link.mp4`,
        uploadKey: `${runId}-${p.id}-big-link`,
        uploadedById: ownerAgentId,
        montajerDeliveredAt: new Date(),
        montajerDeliveredToId: editorMontajerId,
      },
    });

    const res = await request(app).get(`/api/v1/properties/${p.id}`).set("Authorization", `Bearer ${editorMontajerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContactHidden).toBe(true);
    expect(res.body.ownerContact).toBeNull();
    const byName: Record<string, boolean> = {};
    for (const v of res.body.videoHandoff.videos as Array<{ name: string; delivered: boolean }>) {
      byName[v.name] = v.delivered;
    }
    expect(byName["raw-delivered.mp4"]).toBe(true);
    expect(byName["raw-not-delivered.mp4"]).toBe(false);
    expect(byName["raw-big-link.mp4"]).toBe(true);
  });
});

describe("10: окно замены монтажёра равно окну повтора бота", () => {
  it("MONTAJER_FINAL_REPLACE_WINDOW_MS === RESEND_WINDOW_MS", () => {
    expect(MONTAJER_FINAL_REPLACE_WINDOW_MS).toBe(RESEND_WINDOW_MS);
  });
});
