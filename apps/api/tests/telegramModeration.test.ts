import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Модерация из Telegram (lib/telegramModeration.ts, 22.09.2026) — граничные
 * случаи из задания владельца. Telegram подменён целиком: тест не ходит в сеть,
 * проверяет решения в базе и то, ЧТО бот отправил/отредактировал.
 */

const tg = vi.hoisted(() => {
  let nextId = 1000;
  return {
    sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ message_id: nextId++ })),
    sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: nextId++ })),
    editMessageText: vi.fn(async (_chatId: string, _messageId: number, _text: string, _buttons?: unknown) => {}),
    answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
    sendMediaGroupFiles: vi.fn(async () => [{ message_id: nextId++ }]),
    sendPhotoFromDisk: vi.fn(async () => ({ message_id: nextId++ })),
    sendVideoFromDisk: vi.fn(async () => ({ message_id: nextId++ })),
  };
});

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  ...tg,
  isTelegramEnabled: () => true,
}));
// Передача монтажёру — своя механика со своими тестами; здесь только не даём ей
// начать слать ролики, когда объект уходит в монтаж.
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  queueVideoHandoff: vi.fn(async () => {}),
}));

// CHANNEL-CROSSCHECK01: управляемый сбой удаления фото (временная ошибка базы).
const photoRemoval = vi.hoisted(() => ({ failNext: false }));
vi.mock("../src/lib/propertyPhotoRemoval.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/propertyPhotoRemoval.js")>();
  return {
    ...original,
    removePropertyPhoto: vi.fn(async (...args: Parameters<typeof original.removePropertyPhoto>) => {
      if (photoRemoval.failNext) {
        photoRemoval.failNext = false;
        throw new Error("временный сбой базы при удалении фото");
      }
      return original.removePropertyPhoto(...args);
    }),
  };
});

const { prisma } = await import("../src/db.js");
const mod = await import("../src/lib/telegramModeration.js");
const { rejectReview } = await import("../src/lib/propertyReview.js");

const runId = String(Date.now()).slice(-7);
const agentIds: string[] = [];
const propertyIds: string[] = [];
let adminA: { id: string; chatId: string };
let adminB: { id: string; chatId: string };
let plainAgent: { id: string; chatId: string };
let cbSeq = 0;

async function makeAgent(suffix: string, role: "ADMIN" | "AGENT") {
  const chatId = `77${runId}${suffix}`;
  await prisma.agent.deleteMany({ where: { telegramChatId: chatId } });
  const a = await prisma.agent.create({
    data: {
      fullName: `Модератор ${suffix}`,
      phone: `+99293${runId}${suffix}`,
      role,
      passwordHash: await bcrypt.hash("testpass123", 4),
      telegramChatId: chatId,
      telegramModeration: true,
    },
  });
  agentIds.push(a.id);
  return { id: a.id, chatId };
}

async function makePendingProperty(opts: { withVideo?: boolean; videoBytes?: number } = {}) {
  const p = await prisma.property.create({
    data: {
      title: `ТГ-модерация ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 250000,
      currency: "TJS",
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "PENDING_REVIEW",
      ownerContact: "+992900000001",
      assignedAgentId: plainAgent.id,
      photos: { create: [{ url: "/uploads/tm-a.webp", thumbUrl: "/uploads/thumbs/tm-a.webp", order: 0 }] },
    },
  });
  propertyIds.push(p.id);
  if (opts.withVideo !== false) {
    await prisma.propertyVideo.create({
      data: { propertyId: p.id, storageKey: `tm/${p.id}.mp4`, filename: "v.mp4", sizeBytes: opts.videoBytes ?? 1000, uploadedById: plainAgent.id },
    });
  }
  return p;
}

function tap(chatId: string, data: string, messageId?: number, id = `cb-${runId}-${++cbSeq}`) {
  return mod.handleModerationCallback({ id, data, message: { chat: { id: Number(chatId) }, message_id: messageId } });
}

async function recordCard(propertyId: string, who: { id: string; chatId: string }, messageId: number, version = 0) {
  return prisma.telegramModerationMessage.create({
    data: { kind: "REVIEW", propertyId, agentId: who.id, chatId: who.chatId, messageId, text: "карточка", propertyVersion: version },
  });
}

const allTexts = () =>
  [...tg.sendMessage.mock.calls, ...tg.sendMessageWithButtons.mock.calls].map((c) => String(c[1]));

beforeAll(async () => {
  adminA = await makeAgent("1", "ADMIN");
  adminB = await makeAgent("2", "ADMIN");
  plainAgent = await makeAgent("3", "AGENT");
});

beforeEach(() => {
  for (const fn of Object.values(tg)) fn.mockClear();
});

afterAll(async () => {
  await prisma.telegramModerationMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.telegramPhotoBatch.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.propertyStatusTransition?.deleteMany?.({ where: { propertyId: { in: propertyIds } } }).catch(() => {});
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
});

describe("модерация в Telegram", () => {
  it("1. гонка двух админов: одобряет один, второй видит «Уже решил»", async () => {
    const p = await makePendingProperty();
    await Promise.all([tap(adminA.chatId, `tm:a:${p.shortId}`), tap(adminB.chatId, `tm:a:${p.shortId}`)]);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("EDITING");
    const approvals = await waitFor(async () => {
      const n = await prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_PHOTOS_APPROVED" } });
      return n >= 1 ? n : null;
    });
    expect(approvals).toBe(1);
    expect(allTexts().filter((t) => t.startsWith("Уже решил") || t.includes("не на проверке")).length).toBe(1);
  });

  it("2. решение в CRM гасит кнопки у всех модераторов", async () => {
    const p = await makePendingProperty();
    await recordCard(p.id, adminA, 11);
    await recordCard(p.id, adminB, 12);
    const r = await rejectReview(p.id, { material: "photos", reason: "тёмные" }, { agentId: adminA.id, source: "crm" });
    expect(r.ok).toBe(true);
    await waitFor(async () => (tg.editMessageText.mock.calls.length >= 2 ? true : null));
    for (const call of tg.editMessageText.mock.calls) {
      expect(call[2]).toContain("Возвращено на доработку");
      expect(call[2]).toContain("в CRM");
      expect(call[3]).toBeNull(); // кнопки сняты
    }
    const open = await prisma.telegramModerationMessage.count({ where: { propertyId: p.id, resolvedAt: null } });
    expect(open).toBe(0);
  });

  it("3. повторная доставка того же callback не решает второй раз, ответ Telegram — сразу", async () => {
    const p = await makePendingProperty();
    const id = `dup-${runId}`;
    await tap(adminA.chatId, `tm:a:${p.shortId}`, undefined, id);
    await tap(adminA.chatId, `tm:a:${p.shortId}`, undefined, id);
    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(2);
    expect(allTexts().some((t) => t.startsWith("Уже решил"))).toBe(false);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("EDITING");
  });

  it("4. чат без права модерации ничего не решает", async () => {
    const p = await makePendingProperty();
    await tap(plainAgent.chatId, `tm:a:${p.shortId}`);
    expect(allTexts()[0]).toContain("Нет права модерации");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING_REVIEW");
    await tap("999999999", `tm:a:${p.shortId}`);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING_REVIEW");
  });

  it("5а. карточку изменили, пока висела: старая «устарело», пришла новая, решения нет", async () => {
    const p = await makePendingProperty();
    await recordCard(p.id, adminA, 21, 0);
    await prisma.property.update({ where: { id: p.id }, data: { version: { increment: 1 } } });
    await tap(adminA.chatId, `tm:a:${p.shortId}`, 21);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING_REVIEW");
    expect(tg.editMessageText.mock.calls[0]?.[2]).toContain("Устарело");
    expect(tg.sendMessageWithButtons.mock.calls.some((c) => String(c[1]).includes(`№${p.shortId} на проверке`))).toBe(true);
  });

  it("5б. объект в корзине — «Объект удалён»", async () => {
    const p = await makePendingProperty();
    await recordCard(p.id, adminA, 31, 0);
    await prisma.property.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    await tap(adminA.chatId, `tm:a:${p.shortId}`, 31);
    expect(tg.editMessageText.mock.calls[0]?.[2]).toContain("Объект удалён");
  });

  it("6+8. большое видео — ссылка в CRM, карточка всё равно уходит; телефон собственника скрыт", async () => {
    const p = await makePendingProperty({ videoBytes: 60 * 1024 * 1024 });
    tg.sendPhotoFromDisk.mockRejectedValueOnce(new Error(`Forbidden: bot was blocked by the user ${runId}`));
    await mod.notifyTelegramReview(p.id);
    const texts = allTexts();
    expect(texts.some((t) => t.includes("Видео не удалось прислать"))).toBe(true);
    const cards = tg.sendMessageWithButtons.mock.calls.filter((c) => String(c[1]).includes(`№${p.shortId} на проверке`));
    expect(cards.length).toBeGreaterThanOrEqual(2); // обоим админам
    expect(cards.every((c) => !String(c[1]).includes("900000001"))).toBe(true);
    const rows = await prisma.telegramModerationMessage.count({ where: { propertyId: p.id } });
    expect(rows).toBeGreaterThanOrEqual(2);
    // Бот заблокирован — в журнал ошибок, рассылка при этом дошла до конца.
    await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: `bot was blocked by the user ${runId}` } } }));
  });

  it("Вернуть: причина кнопкой + комментарий текстом, аудит с source telegram", async () => {
    const p = await makePendingProperty();
    await tap(adminA.chatId, `tm:rr:${p.shortId}:1`);
    expect(await mod.handleModerationText(adminA.chatId, "переснимите днём")).toBe(true);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("AWAITING_PHOTOS");
    expect(after.reviewRejectionReason).toContain("переснимите днём");
    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_PHOTOS_REJECTED" } })
    );
    expect((audit.meta as { source?: string }).source).toBe("telegram");
  });

  it("диалог живёт 15 минут: просроченный ответ не принимается", async () => {
    const p = await makePendingProperty();
    await mod.setDialog(adminB.chatId, adminB.id, { kind: "reject_comment", shortId: p.shortId, reason: 0 }, new Date(Date.now() - mod.DIALOG_TTL_MS - 1000));
    expect(await mod.handleModerationText(adminB.chatId, "поздно")).toBe(false);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING_REVIEW");
  });

  it("Поправить: ввод проверяется той же схемой, что PATCH в CRM", () => {
    expect(mod.parseFieldInput("areaSqm", "-5").ok).toBe(false);
    expect(mod.parseFieldInput("price", "abc").ok).toBe(false);
    expect(mod.parseFieldInput("price", "320 000")).toEqual({ ok: true, value: 320000 });
    expect(mod.parseFieldInput("rooms", "2,5").ok).toBe(false);
  });

  it("досланные фото: «Все ✅» решает один, второй видит «Уже решил»", async () => {
    const p = await makePendingProperty();
    const photo = await prisma.propertyPhoto.findFirstOrThrow({ where: { propertyId: p.id } });
    await mod.notifyTelegramPhotoBatch(p.id, [photo.id]);
    const batch = await prisma.telegramPhotoBatch.findFirstOrThrow({ where: { propertyId: p.id } });
    tg.sendMessage.mockClear();
    tg.sendMessageWithButtons.mockClear();
    await Promise.all([tap(adminA.chatId, `tm:pa:${batch.shortCode}`), tap(adminB.chatId, `tm:pa:${batch.shortCode}`)]);
    expect(allTexts().filter((t) => t.startsWith("Уже решил")).length).toBe(1);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(1);
    const resolved = await prisma.telegramModerationMessage.count({ where: { batchId: batch.id, resolvedAt: null } });
    expect(resolved).toBe(0);
  });

  /**
   * CHANNEL-CROSSCHECK01 (аудит Codex, 04.10.2026): решение по досланным фото фиксировалось
   * ДО удаления, и временный сбой удаления оставлял фото на месте, а повторный клик получал
   * «Уже решил»; «одобрить» оставшееся закрывало партию и писало «удалено 1», хотя ничего не удалено.
   */
  describe("сбой удаления отклонённого фото откатывает решение", () => {
    async function makeBatch(photoCount: number) {
      const p = await makePendingProperty({ withVideo: false });
      for (let i = 1; i < photoCount; i++) {
        await prisma.propertyPhoto.create({
          data: { propertyId: p.id, url: `/uploads/tm-b${i}-${runId}.webp`, thumbUrl: `/uploads/thumbs/tm-b${i}-${runId}.webp`, order: i },
        });
      }
      const photos = await prisma.propertyPhoto.findMany({ where: { propertyId: p.id }, orderBy: { order: "asc" } });
      await mod.notifyTelegramPhotoBatch(p.id, photos.map((ph) => ph.id));
      const batch = await prisma.telegramPhotoBatch.findFirstOrThrow({ where: { propertyId: p.id } });
      tg.sendMessage.mockClear();
      tg.sendMessageWithButtons.mockClear();
      photoRemoval.failNext = false;
      return { p, photos, batch };
    }

    it("«Все ❌»: сбой удаления возвращает партию в разбор, повторный клик удаляет фото", async () => {
      const { p, batch } = await makeBatch(2);
      photoRemoval.failNext = true;

      await tap(adminA.chatId, `tm:pr:${batch.shortCode}`);

      const afterFail = await prisma.telegramPhotoBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(afterFail.resolvedAt).toBeNull();
      expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(2);
      expect(allTexts().some((t) => t.includes("Не удалось удалить"))).toBe(true);

      tg.sendMessage.mockClear();
      await tap(adminA.chatId, `tm:pr:${batch.shortCode}`);

      expect(allTexts().some((t) => t.startsWith("Уже решил"))).toBe(false);
      expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(0);
      const afterRetry = await prisma.telegramPhotoBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(afterRetry.resolvedAt).not.toBeNull();
    });

    it("«❌» по одному фото: сбой удаления снимает решение, повтор удаляет фото", async () => {
      const { p, photos, batch } = await makeBatch(2);
      photoRemoval.failNext = true;

      await tap(adminA.chatId, `tm:pn:${batch.shortCode}:0`);

      const afterFail = await prisma.telegramPhotoBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect((afterFail.decisions as Record<string, string>)[photos[0].id]).toBeUndefined();
      expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(2);

      tg.sendMessage.mockClear();
      await tap(adminA.chatId, `tm:pn:${batch.shortCode}:0`);

      expect(allTexts().some((t) => t.includes("По этому фото уже решили"))).toBe(false);
      expect(await prisma.propertyPhoto.findUnique({ where: { id: photos[0].id } })).toBeNull();
      const afterRetry = await prisma.telegramPhotoBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect((afterRetry.decisions as Record<string, string>)[photos[0].id]).toBe("no");
    });
  });});
