import { randomInt, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * МОНТАЖЁР — ТОТ, КТО НАЗНАЧЕН В НАСТРОЙКАХ, А НЕ РОЛЬ (прод 19.11.2026).
 * Назначенный монтажёр (Settings.videoMontajerAgentId) заведён с ролью MARKETING, а передача
 * озвучки искала сотрудника с ролью EDITOR: ни одна озвучка не ушла монтажёру, а отказ
 * глотался пустым catch и выглядел как «объект не у монтажёра». Очередь монтажа роль не
 * проверяет, поэтому монтажёр получал исходники и монтировал без голоса.
 * Ревью того же дня: активный, но НЕ назначенный сотрудник голос не получает; отказ самой отправки
 * (FAILED/UNKNOWN) и зависшая передача не проходят молча; подпись «замените только голос» — только
 * когда наш голос в ролике уже был.
 *
 * Настоящая база; наружу (Telegram) ничего не уходит — сеть подменена.
 */
const net = vi.hoisted(() => ({ document: vi.fn(), message: vi.fn(), actor: { id: "", role: "DIRECTOR" } }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendDocumentFile: net.document,
  sendMessage: net.message,
}));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/middleware.js")>()),
  requireAuth: (req: { agent?: unknown }, _res: unknown, next: () => void) => { req.agent = { ...net.actor, permissions: new Set(["marketing.access"]) }; next(); },
}));
vi.mock("../src/routes/properties/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/properties/shared.js")>()),
  canManageProperty: () => true,
}));

import { prisma } from "../src/db.js";
import { afterNarrationApproved, runNarrationAutoFlow } from "../src/lib/narrationAutoFlow.js";
import { executeNarrationDelivery, prepareNarrationDeliveryPlan } from "../src/lib/narrationDelivery.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
import { localVideoDelete, localVideoUpload } from "../src/lib/localVideoStorage.js";
import { narrationRouter } from "../src/routes/properties/narration.js";
import { askMontajerForVoicelessCopy, VOICELESS_COPY_HINT, voicelessCopyHint } from "../src/lib/narrationMontajerNote.js";
import { voicelessCopyAsk } from "../src/lib/narrationVoicelessCopy.js";
import { buildMontajerMessageText } from "../src/lib/videoHandoff.js";
import { waitFor } from "./helpers/waitFor.js";

const fx = { approverId: randomUUID(), montajerId: randomUUID(), strangerId: randomUUID(), districtId: randomUUID(), propertyIds: [] as string[], clientIds: [] as string[], storageKeys: [] as string[] };
let oldMontajerId: string | null = null;
let settingsExisted = false;
const app = express(); app.use(express.json()); app.use("/properties", narrationRouter);

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  settingsExisted = !!settings; oldMontajerId = settings?.videoMontajerAgentId ?? null;
  await prisma.agent.createMany({ data: [
    { id: fx.approverId, fullName: "Synthetic narration approver", phone: `role-approver-${fx.approverId}`, role: "DIRECTOR", passwordHash: "unused", isActive: true },
    // Как на проде: монтажёр назначен в Настройках, но роль у него MARKETING, не EDITOR.
    { id: fx.montajerId, fullName: "Synthetic marketing montajer", phone: `role-montajer-${fx.montajerId}`, role: "MARKETING", passwordHash: "unused", isActive: true, telegramChatId: `synthetic-${fx.montajerId}` },
    // Активный сотрудник с Telegram, но НЕ назначенный монтажёром: голос ему не уходит никогда.
    { id: fx.strangerId, fullName: "Synthetic active stranger", phone: `role-stranger-${fx.strangerId}`, role: "EDITOR", passwordHash: "unused", isActive: true, telegramChatId: `synthetic-${fx.strangerId}` },
  ] });
  net.actor.id = fx.approverId;
  await prisma.district.create({ data: { id: fx.districtId, name: `Synthetic montajer role district ${fx.districtId}` } });
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
  net.document.mockResolvedValue({ message_id: 1, document: { file_id: "synthetic" } });
  net.message.mockResolvedValue({ message_id: 1 });
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", videoMontajerAgentId: fx.montajerId }, update: { videoMontajerAgentId: fx.montajerId } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await prisma.property.deleteMany({ where: { id: { in: fx.propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: fx.clientIds } } });
  for (const key of fx.storageKeys.splice(0)) await localVideoDelete(key);
  fx.propertyIds.length = 0; fx.clientIds.length = 0;
  await prisma.agent.update({ where: { id: fx.montajerId }, data: { telegramChatId: `synthetic-${fx.montajerId}`, isActive: true } });
});
afterAll(async () => {
  if (settingsExisted) await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldMontajerId } });
  else await prisma.settings.updateMany({ where: { id: "singleton" }, data: { videoMontajerAgentId: null } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [fx.approverId, fx.montajerId, fx.strangerId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [fx.approverId, fx.montajerId, fx.strangerId] } } });
  await prisma.district.deleteMany({ where: { id: fx.districtId } });
});

/** Объект с готовой озвучкой, одобренной человеком; по умолчанию — у монтажёра (SENT_TO_EDITOR). */
async function propertyWithApprovedVoice(opts: { handoff?: "SENT_TO_EDITOR" | "RECEIVED"; remakeReason?: string; withFile?: boolean } = {}) {
  const sellerId = randomUUID(); fx.clientIds.push(sellerId);
  await prisma.client.create({ data: { id: sellerId, fullName: "Synthetic seller", phone: `+99291${randomInt(1000000, 9999999)}`, source: "WALK_IN", kind: "SELLER", assignedAgentId: fx.approverId } });
  const id = randomUUID(); fx.propertyIds.push(id);
  const p = await prisma.property.create({ data: { id, title: "Synthetic narration role property", type: "APARTMENT", areaSqm: 61, price: 400000, currency: "TJS", districtId: fx.districtId,
    address: "Synthetic fixture only", condition: "GOOD", sellerClientId: sellerId, videoHandoffStatus: opts.handoff ?? "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffDeliveredAt: new Date(),
    ...(opts.remakeReason ? { videoHandoffRemakeReason: opts.remakeReason } : {}) }, include: { district: true } });
  const facts = narrationFacts(p);
  const storageKey = `${p.id}/${randomUUID()}.mp3`;
  if (opts.withFile) { fx.storageKeys.push(storageKey); await localVideoUpload(storageKey, Buffer.from("synthetic mp3 bytes, never sent")); }
  const version = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Синтетический текст озвучки.", factsSnapshot: facts, factsHash: narrationHash(facts),
    status: "READY", storageKey, approvedAt: new Date(), approvedById: fx.approverId, createdById: fx.approverId, requestKey: randomUUID(), source: "AUTO" } });
  return { p, version };
}
const errorByKey = (dedupKey: string) => prisma.errorLog.findFirst({ where: { dedupKey } });

describe("озвучка уходит назначенному монтажёру, а не роли EDITOR", () => {
  it("одобрение: монтажёр с ролью MARKETING получает передачу QUEUED", async () => {
    const { p, version } = await propertyWithApprovedVoice();
    expect(await afterNarrationApproved(p.id, version.id)).toBe("QUEUED");
    const rows = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "QUEUED", editorId: fx.montajerId, mode: "AUDIO_ONLY", versionId: version.id });
  });

  it("обход раз в минуту делает то же самое", async () => {
    const { p, version } = await propertyWithApprovedVoice();
    await runNarrationAutoFlow({});
    const rows = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "QUEUED", editorId: fx.montajerId, versionId: version.id });
  });

  it("у назначенного монтажёра нет Telegram: передачи нет, но журнал ошибок говорит об этом", async () => {
    await prisma.agent.update({ where: { id: fx.montajerId }, data: { telegramChatId: null } });
    const { p, version } = await propertyWithApprovedVoice();
    expect(await afterNarrationApproved(p.id, version.id)).not.toBe("QUEUED");
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id } })).toBe(0);
    const row = await waitFor(() => errorByKey(`narration-delivery-refused:${p.id}:MONTAJER_NO_TELEGRAM`), { label: "запись о монтажёре без Telegram" });
    expect(row?.message).toContain(`Озвучка объекта №${p.shortId}: `);
    expect(row?.message).toContain("не подключён Telegram");
  });

  it("обход: объект у монтажёра, озвучка одобрена, голос не ушёл — сторож пишет в журнал причину", async () => {
    await prisma.agent.update({ where: { id: fx.montajerId }, data: { telegramChatId: null } });
    const { p } = await propertyWithApprovedVoice();
    await runNarrationAutoFlow({});
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id } })).toBe(0);
    const row = await waitFor(() => errorByKey(`narration-voice-not-sent:${p.id}:MONTAJER_NO_TELEGRAM`), { label: "сторож обхода" });
    expect(row?.message).toContain(`Озвучка объекта №${p.shortId} одобрена, объект у монтажёра, а голос ему не ушёл`);
    expect(row?.message).toContain("Telegram");
  });

  it("монтажёр отключён: причина не выдаётся за «нет Telegram»", async () => {
    await prisma.agent.update({ where: { id: fx.montajerId }, data: { isActive: false } });
    const { p, version } = await propertyWithApprovedVoice();
    expect(await afterNarrationApproved(p.id, version.id)).not.toBe("QUEUED");
    const row = await waitFor(() => errorByKey(`narration-delivery-refused:${p.id}:MONTAJER_INACTIVE`), { label: "запись об отключённом монтажёре" });
    expect(row?.message).toContain("отключён");
    expect(row?.message).not.toContain("Telegram");
  });

  it("одобрение устаревшей версии у объекта, который не у монтажёра, — штатно, без тревоги", async () => {
    const { p, version } = await propertyWithApprovedVoice({ handoff: "RECEIVED" });
    await prisma.property.update({ where: { id: p.id }, data: { areaSqm: 99 } }); // факты озвучки разошлись
    await afterNarrationApproved(p.id, version.id);
    await expect(waitFor(() => prisma.errorLog.findFirst({ where: { dedupKey: { startsWith: `narration-delivery-refused:${p.id}:` } } }), { timeoutMs: 600 })).rejects.toThrow();
  });
});

describe("голос получает только назначенный монтажёр", () => {
  it("prepare с активным, но не назначенным сотрудником — отказ MONTAJER_NOT_ASSIGNED", async () => {
    const { p, version } = await propertyWithApprovedVoice();
    await expect(prepareNarrationDeliveryPlan(p.id, version.id, "AUDIO_ONLY", fx.strangerId)).rejects.toMatchObject({ code: "MONTAJER_NOT_ASSIGNED" });
  });

  it("ручная передача с чужим editorId — 409, строки передачи нет", async () => {
    const { p, version } = await propertyWithApprovedVoice();
    const res = await request(app).post(`/properties/${p.id}/narration/${version.id}/handoff-preview`)
      .send({ expectedRevision: 1, confirmed: true, audioReviewed: true, requestKey: randomUUID(), mode: "AUDIO_ONLY", editorId: fx.strangerId });
    expect(res.status).toBe(409);
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("монтажёра сменили в Настройках между постановкой и отправкой — FAILED, файл не ушёл, журнал говорит «передайте вручную»", async () => {
    const { p, version } = await propertyWithApprovedVoice({ withFile: true });
    expect(await afterNarrationApproved(p.id, version.id)).toBe("QUEUED");
    const delivery = await prisma.propertyNarrationDelivery.findFirstOrThrow({ where: { propertyId: p.id } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: fx.strangerId } });
    expect(await executeNarrationDelivery(delivery.id)).toEqual({ status: "FAILED" });
    expect(net.document).not.toHaveBeenCalled();
    expect((await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe("FAILED");
    const row = await waitFor(() => errorByKey(`narration-delivery-outcome:${delivery.id}:FAILED`), { label: "журнал об упавшей передаче" });
    expect(row?.message).toContain(`Озвучка объекта №${p.shortId}: `);
    expect(row?.message).toContain("передайте вручную");
  });
});

describe("отказ самой отправки не проходит молча", () => {
  it("Telegram ответил ошибкой посреди отправки — UNKNOWN и запись в журнал со сверкой", async () => {
    const { p, version } = await propertyWithApprovedVoice({ withFile: true });
    expect(await afterNarrationApproved(p.id, version.id)).toBe("QUEUED");
    const delivery = await prisma.propertyNarrationDelivery.findFirstOrThrow({ where: { propertyId: p.id } });
    net.document.mockRejectedValueOnce(new Error("Telegram: Bad Request: chat not found"));
    expect(await executeNarrationDelivery(delivery.id)).toEqual({ status: "UNKNOWN" });
    const row = await waitFor(() => errorByKey(`narration-delivery-outcome:${delivery.id}:UNKNOWN`), { label: "журнал о неизвестном результате" });
    expect(row?.message).toContain(`Озвучка объекта №${p.shortId}: `);
    expect(row?.message).toContain("Сверка неопределённой доставки");
  });

  it("файла озвучки нет — FAILED до Telegram; обход потом напоминает, что голос не ушёл", async () => {
    const { p, version } = await propertyWithApprovedVoice(); // без файла
    expect(await afterNarrationApproved(p.id, version.id)).toBe("QUEUED");
    const delivery = await prisma.propertyNarrationDelivery.findFirstOrThrow({ where: { propertyId: p.id } });
    expect(await executeNarrationDelivery(delivery.id)).toEqual({ status: "FAILED" });
    expect(net.document).not.toHaveBeenCalled();
    await waitFor(() => errorByKey(`narration-delivery-outcome:${delivery.id}:FAILED`), { label: "журнал об упавшей передаче" });
    // Повторное одобрение отвечает «уже», обход версию не берёт — сторож зависших всё равно напоминает.
    expect(await afterNarrationApproved(p.id, version.id)).toBe("ALREADY");
    await runNarrationAutoFlow({});
    const reminder = await waitFor(() => errorByKey(`narration-voice-not-sent:${p.id}:stalled:${delivery.id}`), { label: "напоминание сторожа" });
    expect(reminder?.message).toContain(`Озвучка объекта №${p.shortId} одобрена, объект у монтажёра, а голос ему не ушёл`);
    expect(reminder?.message).toContain("передайте вручную");
  });

  it("зависшая UNKNOWN-передача старой версии держит новую (BUSY) — сторож это видит", async () => {
    const { p, version } = await propertyWithApprovedVoice();
    await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: version.id, editorId: fx.montajerId, mode: "AUDIO_ONLY", requestKey: randomUUID(),
      createdById: fx.approverId, status: "UNKNOWN", executionMode: "LIVE", claimStartedAt: new Date(Date.now() - 3_600_000) } });
    // Новая версия (цена та же — факты те же), одобрена человеком.
    const facts = narrationFacts(p);
    const v2 = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 2, script: "Новый синтетический текст.", factsSnapshot: facts, factsHash: narrationHash(facts),
      status: "READY", storageKey: `${p.id}/v2.mp3`, approvedAt: new Date(), approvedById: fx.approverId, createdById: fx.approverId, requestKey: randomUUID(), source: "AUTO" } });
    expect(await afterNarrationApproved(p.id, v2.id)).toBe("BUSY");
    await runNarrationAutoFlow({});
    const row = await waitFor(() => prisma.errorLog.findFirst({ where: { dedupKey: { startsWith: `narration-voice-not-sent:${p.id}:stalled:` } } }), { label: "сторож зависшей передачи" });
    expect(row?.message).toContain("неизвестным результатом");
  });
});

describe("монтажёру — один готовый файл и текст озвучки текстом (владелец 19.11.2026)", () => {
  it("путь «объект → монтажёр → голос → сдача»: нигде не просим второй файл, текст — в подписи к mp3, без .txt", async () => {
    expect(askMontajerForVoicelessCopy()).toBe(false);
    expect(voicelessCopyHint()).toBe("");
    const { p, version } = await propertyWithApprovedVoice({ withFile: true });
    // Задание монтажёру с исходниками.
    const task = await buildMontajerMessageText(p.id, null);
    expect(task).toContain("🎙 Озвучка одобрена: mp3 придёт сразу после файлов ролика — вклейте её сами.");
    // Голос: одно mp3, подпись с текстом.
    expect(await afterNarrationApproved(p.id, version.id)).toBe("QUEUED");
    const delivery = await prisma.propertyNarrationDelivery.findFirstOrThrow({ where: { propertyId: p.id } });
    expect(await executeNarrationDelivery(delivery.id)).toEqual({ status: "SENT" });
    expect(net.document).toHaveBeenCalledOnce();
    expect(net.document.mock.calls[0][2]).toMatch(/\.mp3$/);
    expect(net.document.mock.calls[0][3]).toBe(`Озвучка к ролику №${p.shortId}, версия 1, одобрена. Вклейте этот голос сами: музыка, громкость и монтаж ваши.\n\nТекст:\nСинтетический текст озвучки.`);
    // Сдача: просьбы вдогонку о ролике без голоса нет.
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: "/uploads/handoff/none.mp4" } });
    expect(await voicelessCopyAsk(p.id)).toBeNull();
    const everything = [task, ...net.document.mock.calls.map((c) => String(c[3])), ...net.message.mock.calls.map((c) => String(c[1]))].join("\n");
    expect(everything).not.toMatch(/без голоса|два файла/u);
  });

  it("передача со старым планом (.txt) в очереди уходит по-новому; отправленная по старому плану не повторяется", async () => {
    const { p, version } = await propertyWithApprovedVoice({ withFile: true });
    const { plan } = await prepareNarrationDeliveryPlan(p.id, version.id, "AUDIO_ONLY");
    const base = `Озвучка к ролику №${p.shortId}, версия 1, одобрена. Вклейте этот голос сами: музыка, громкость и монтаж ваши.`;
    const legacyPlan = { ...plan, files: [{ ...plan.files[0], caption: `${base} ${VOICELESS_COPY_HINT}` },
      { id: `${version.id}-script`, storageKey: "SCRIPT", filename: `property-${p.shortId}-voice-v1.txt`, caption: version.script }] };
    const sent = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: version.id, editorId: fx.montajerId, mode: "AUDIO_ONLY", requestKey: randomUUID(),
      createdById: fx.approverId, plan: legacyPlan, status: "SENT", executionMode: "LIVE", deliveredAt: new Date() } });
    expect(await executeNarrationDelivery(sent.id)).toEqual({ status: "NOT_CLAIMED" });
    const queued = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: version.id, editorId: fx.montajerId, mode: "AUDIO_ONLY", requestKey: randomUUID(),
      createdById: fx.approverId, plan: legacyPlan, status: "QUEUED", executionMode: "LIVE" } });
    expect(await executeNarrationDelivery(queued.id)).toEqual({ status: "SENT" });
    expect(net.document).toHaveBeenCalledOnce();
    expect(net.document.mock.calls[0][2]).toMatch(/\.mp3$/);
    expect(net.document.mock.calls[0][3]).toBe(`${base}\n\nТекст:\nСинтетический текст озвучки.`);
    expect(net.message).not.toHaveBeenCalled();
    const receipts = (await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id: queued.id } })).receipts;
    expect(receipts).toHaveProperty(`${version.id}.messageId`, 1);
  });
});

describe("подпись к mp3 при возврате ролика", () => {
  it("возврат «вклейте голос» (голоса монтажёру ещё не уходило) — обычная строка «Вклейте этот голос сами»", async () => {
    const { p, version } = await propertyWithApprovedVoice({ remakeReason: "NARRATION_CHANGED" });
    const { plan } = await prepareNarrationDeliveryPlan(p.id, version.id, "AUDIO_ONLY");
    expect(plan.files[0].caption).toContain("Вклейте этот голос сами");
    expect(plan.files[0].caption).not.toContain("замените в ролике только голос");
    expect(plan.files[0].caption).toContain("\n\nТекст:\nСинтетический текст озвучки.");
    expect(plan.files[0].caption).not.toContain("без голоса");
    expect(plan.files).toHaveLength(1);
  });

  it("смена озвучки, а наш прежний голос в ролике уже есть (была передача SENT) — «замените только голос»", async () => {
    const { p, version } = await propertyWithApprovedVoice({ remakeReason: "NARRATION_CHANGED" });
    await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: version.id, editorId: fx.montajerId, mode: "AUDIO_ONLY", requestKey: randomUUID(),
      createdById: fx.approverId, status: "SENT", executionMode: "LIVE" } });
    const { plan } = await prepareNarrationDeliveryPlan(p.id, version.id, "AUDIO_ONLY");
    expect(plan.files[0].caption).toContain("замените в ролике только голос");
  });
});
