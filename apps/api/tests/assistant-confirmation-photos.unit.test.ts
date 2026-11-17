import { rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantActionView } from "@royal-home/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { findPhotos, sendPhoto, editCaption, editText } = vi.hoisted(() => ({
  findPhotos: vi.fn(),
  sendPhoto: vi.fn(),
  editCaption: vi.fn(),
  editText: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  prisma: { propertyPhoto: { findMany: findPhotos }, $disconnect: async () => {} },
}));
vi.mock("../src/upload.js", async (importOriginal) => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { ...(await importOriginal<typeof import("../src/upload.js")>()), uploadsDir: await mkdtemp(join(tmpdir(), "assistant-photo-confirmation-")) };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendPhotoFromDisk: sendPhoto,
  editMessageCaption: editCaption,
  editMessageText: editText,
  TelegramApiError: class TelegramApiError extends Error {
    constructor(public readonly errorCode: number) { super("Telegram rejected photo"); }
  },
}));

import { uploadsDir } from "../src/upload.js";
import { TelegramApiError } from "../src/telegram/api.js";
import { editTelegramConfirmationMessage, sendTelegramPriceConfirmationPhotos } from "../src/telegram/assistantConfirmationPhotos.js";

const action: AssistantActionView = {
  id: "action-1",
  tool: "change_property_price",
  status: "PENDING",
  preview: { title: "Цена объекта ОБ-000132", was: {}, becomes: {} },
  expiresAt: "2026-11-04T13:01:00.000Z",
  executedAt: null,
  undoneAt: null,
  undoUntil: null,
  result: null,
};
const buttons = [[{ text: "Да", callback_data: "as:ok:bundle" }]];
const caption = "ОБ-000132\nБыло: 879 000 с. → 810 000 с.";
const files = ["cover.webp", "other.webp"];

beforeEach(async () => {
  vi.resetAllMocks();
  await Promise.all(files.map(name => writeFile(path.join(uploadsDir, name), name)));
  findPhotos.mockResolvedValue(files.map(name => ({ url: `/uploads/${name}` })));
  sendPhoto.mockResolvedValue({ message_id: 72 });
});
afterAll(async () => {
  await Promise.all(files.map(name => rm(path.join(uploadsDir, name), { force: true })));
  await rmdir(uploadsDir);
});

describe("group price confirmation photos", () => {
  it("reads public property photos only and puts the same compact caption and buttons on the first", async () => {
    expect(await sendTelegramPriceConfirmationPhotos("-1", action, caption, buttons, 41)).toBe(true);
    expect(findPhotos).toHaveBeenCalledWith(expect.objectContaining({
      where: { property: { shortId: 132, deletedAt: null, publishedOnSite: true, offSite: false } },
      take: 4,
    }));
    expect(sendPhoto).toHaveBeenNthCalledWith(1, "-1", path.join(uploadsDir, files[0]), caption, buttons, 8_000,
      { replyTo: 41, singleAttempt: true });
    expect(sendPhoto).toHaveBeenNthCalledWith(2, "-1", path.join(uploadsDir, files[1]), undefined, undefined, 5_000,
      { replyTo: 72, singleAttempt: true });
  });

  it("leaves text fallback available when the photo is unavailable or was rejected", async () => {
    findPhotos.mockResolvedValueOnce([{ url: "/uploads/../cover.webp" }, { url: "/uploads/missing.webp" }]);
    expect(await sendTelegramPriceConfirmationPhotos("-1", action, caption, buttons)).toBe(false);
    expect(sendPhoto).not.toHaveBeenCalled();
    sendPhoto.mockRejectedValueOnce(new TelegramApiError(400, "sendPhoto", "Invalid photo"));
    expect(await sendTelegramPriceConfirmationPhotos("-1", action, caption, buttons)).toBe(false);
  });

  it("avoids a second confirmation when the photo delivery is uncertain", async () => {
    sendPhoto.mockRejectedValueOnce(new Error("timeout"));
    expect(await sendTelegramPriceConfirmationPhotos("-1", action, caption, buttons)).toBe(true);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  it("replaces the correct caption or text in place and removes the buttons", async () => {
    const message = { chat: { id: -1 }, message_id: 72 };
    const photoMessage = { ...message, photo: [{ file_id: "photo" }] };
    await editTelegramConfirmationMessage(photoMessage, "Готово");
    await editTelegramConfirmationMessage(message, "Отменено");
    expect(editCaption).toHaveBeenCalledWith("-1", 72, "Готово", null);
    expect(editText).toHaveBeenCalledWith("-1", 72, "Отменено", null);
  });
});
