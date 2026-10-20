import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/apiError";
import { draftMediaConflict, draftMediaConflictTitle } from "../draftMediaConflict";

/**
 * D14 (решение владельца 02.10.2026, «да, по советам»): черновик из переписки
 * не заменяет фото агента молча. Сервер отвечает 409
 * DRAFT_MEDIA_REPLACE_CONFIRM, мастер спрашивает «Заменить N загруженных фото
 * на фото из переписки?» и повторяет запрос с ответом. «Нет» и закрытие окна —
 * фото агента остаются.
 */
const WIZARD = fs
  .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../PropertyWizard.tsx"), "utf8")
  .replace(/\r\n/g, "\n");

describe("Вопрос «Заменить фото?» в мастере", () => {
  it("узнаёт ответ сервера и число файлов агента", () => {
    const err = new ApiError("x", 409, { code: "DRAFT_MEDIA_REPLACE_CONFIRM", draftPhotoCount: 3, draftVideoCount: 1 });
    expect(draftMediaConflict(err)).toEqual({ photoCount: 3, videoCount: 1 });
    expect(draftMediaConflict(new ApiError("x", 409, { error: "другое" }))).toBeNull();
    expect(draftMediaConflict(new ApiError("x", 500, { code: "DRAFT_MEDIA_REPLACE_CONFIRM" }))).toBeNull();
    expect(draftMediaConflict(new Error("сеть"))).toBeNull();
  });

  it("вопрос называет число фото простыми словами", () => {
    expect(draftMediaConflictTitle(3, 0)).toBe("Заменить 3 загруженных фото на фото из переписки?");
    expect(draftMediaConflictTitle(1, 0)).toBe("Заменить 1 загруженное фото на фото из переписки?");
    expect(draftMediaConflictTitle(2, 1)).toBe("Заменить 2 загруженных фото и 1 видео на фото из переписки?");
  });

  it("«Да» — замена, «Нет» и закрытие — оставить фото агента", () => {
    expect(WIZARD).toMatch(/onConfirm=\{\(\) => answer\("replace"\)\}/);
    expect(WIZARD).toMatch(/onCancel=\{\(\) => answer\("keep"\)\}/);
    expect(WIZARD).toMatch(/cancelLabel="Нет, оставить мои"/);
  });

  it("оба входа (из чата и выбор продавца в мастере) ловят вопрос сервера", () => {
    expect(WIZARD).toMatch(/setMediaConflict\(\{ clientId, mode: "start", [^}]*\.\.\.conflict \}\)/);
    expect(WIZARD).toMatch(/setMediaConflict\(\{ clientId, mode: "enrich", \.\.\.conflict \}\)/);
  });

  it("плитки агента не чистятся до ответа сервера", () => {
    const start = WIZARD.slice(WIZARD.indexOf("async function startFromClient("));
    const beforeRequest = start.slice(0, start.indexOf("await api<"));
    expect(beforeRequest).not.toMatch(/clearDraftMedia\(/);
    expect(beforeRequest).not.toMatch(/setAutosaveArmed\(true\)/);
  });
});
