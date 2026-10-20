import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  localVideoUpload,
  localVideoDelete,
  localVideoFilePath,
  localVideoExists,
  createLocalUploadSession,
  writeLocalUploadPart,
  completeLocalUploadSession,
  abortLocalUploadSession,
} from "../src/lib/localVideoStorage.js";

/**
 * Закрытое локальное хранилище видео (31.08.2026, замена Cloudflare R2) —
 * защита от обхода пути и базовый круг upload/exists/delete. Роуты
 * (video-upload-multipart.test.ts) проверяют это же на живых HTTP-запросах с
 * ключами, которые формирует сам сервер; здесь — прямые вызовы модуля с
 * ключами, которые мог бы прислать кто угодно, если бы формат когда-нибудь
 * ослабили.
 */

const validKey = () => `00000000-0000-0000-0000-000000000001/${randomUUID()}.mp4`;
const createdPaths: string[] = [];

afterAll(() => {
  for (const p of createdPaths) fs.rmSync(p, { force: true });
});

describe("localVideoUpload/localVideoFilePath — формат ключа", () => {
  it("сохраняет и находит файл по валидному ключу", async () => {
    const key = validKey();
    await localVideoUpload(key, Buffer.from("привет"));
    const filePath = localVideoFilePath(key);
    expect(filePath).toBeTruthy();
    createdPaths.push(filePath!);
    expect(await localVideoExists(key)).toBe(true);
    expect(fs.readFileSync(filePath!, "utf8")).toBe("привет");
  });

  it("отклоняет ключ с попыткой выйти за пределы папки хранилища (../)", async () => {
    await expect(localVideoUpload("../../../etc/passwd", Buffer.from("x"))).rejects.toThrow();
    expect(localVideoFilePath("../../../etc/passwd")).toBeNull();
  });

  it("отклоняет ключ без второго уровня (голый uuid без файла)", () => {
    expect(localVideoFilePath("00000000-0000-0000-0000-000000000001")).toBeNull();
  });

  it("отклоняет ключ с посторонним расширением-обходом (uuid.mp4/../x)", () => {
    expect(localVideoFilePath(`00000000-0000-0000-0000-000000000001/${randomUUID()}.mp4/../x`)).toBeNull();
  });

  it("localVideoExists — false для недопустимого или отсутствующего ключа", async () => {
    expect(await localVideoExists("не-такой-ключ")).toBe(false);
    expect(await localVideoExists(validKey())).toBe(false); // валидный формат, файла никогда не было
  });
});

describe("localVideoDelete", () => {
  it("true для успешного удаления и для уже отсутствующего файла (тот же контракт, что был у r2Delete)", async () => {
    const key = validKey();
    await localVideoUpload(key, Buffer.from("x"));
    expect(await localVideoDelete(key)).toBe(true);
    expect(await localVideoExists(key)).toBe(false);
    expect(await localVideoDelete(key)).toBe(true); // повторное удаление — не ошибка
  });

  it("false для недопустимого ключа — нечего резолвить, нечего удалять", async () => {
    expect(await localVideoDelete("../../etc/passwd")).toBe(false);
  });
});

describe("completeLocalUploadSession — сборка частей", () => {
  /**
   * Сторож течи слушателей. Часть — 8 МБ, значит одиннадцать частей это ролик
   * с телефона тяжелее 88 МБ, то есть обычный. Раньше сторож отказа вешался на
   * поток внутри цикла и не снимался: с одиннадцатой части Node печатал
   * MaxListenersExceededWarning, а на большом файле на одном потоке копились
   * тысячи слушателей. Порог Node (10) и есть то, что здесь проверяется, —
   * поэтому частей заведомо больше.
   */
  it("не течёт слушателями отказа: пятнадцать частей без предупреждения Node", async () => {
    const sessionId = randomUUID();
    const key = validKey();
    const totalParts = 15;

    await createLocalUploadSession(sessionId);
    for (let n = 1; n <= totalParts; n++) {
      await writeLocalUploadPart(sessionId, n, Buffer.from(`часть-${n};`));
    }

    const warnings: string[] = [];
    const onWarning = (w: Error) => {
      if (w.name === "MaxListenersExceededWarning") warnings.push(w.message);
    };
    process.on("warning", onWarning);
    try {
      await completeLocalUploadSession(sessionId, key, totalParts);
      // Предупреждение Node приходит следующим тиком, а не в самом вызове.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("warning", onWarning);
    }

    expect(warnings).toEqual([]);

    const filePath = localVideoFilePath(key);
    createdPaths.push(filePath!);
    const expected = Array.from({ length: totalParts }, (_, i) => `часть-${i + 1};`).join("");
    expect(fs.readFileSync(filePath!, "utf8")).toBe(expected);
  });

  it("части удаляются только после успешной сборки, а отказ виден вызывающему", async () => {
    const sessionId = randomUUID();
    await createLocalUploadSession(sessionId);
    await writeLocalUploadPart(sessionId, 1, Buffer.from("одна часть"));

    // Вторая часть не дописана — честный ENOENT на чтении.
    await expect(completeLocalUploadSession(sessionId, validKey(), 2)).rejects.toThrow();
  });
});

describe("abortLocalUploadSession — честный результат (07.10.2026)", () => {
  it("true, когда папки сессии нет или она удалена", async () => {
    const sessionId = randomUUID();
    await createLocalUploadSession(sessionId);
    await writeLocalUploadPart(sessionId, 1, Buffer.from("часть"));
    expect(await abortLocalUploadSession(sessionId)).toBe(true);
    expect(await abortLocalUploadSession(sessionId)).toBe(true);
  });

  it("false, когда каталог частей удалить не удалось — уборка не должна стирать строку сессии", async () => {
    const sessionId = randomUUID();
    await createLocalUploadSession(sessionId);
    const spy = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("EBUSY"));
    try {
      expect(await abortLocalUploadSession(sessionId)).toBe(false);
    } finally {
      spy.mockRestore();
      await abortLocalUploadSession(sessionId);
    }
  });
});
