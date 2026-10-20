import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ОТКАЗ ДИСКА ПРИ СОХРАНЕНИИ ВЛОЖЕНИЯ ОБЯЗАН БЫТЬ ВИДЕН.
 *
 * Файл при отказе диска ронялся и роняется дальше — это сознательное решение
 * (storeFetchedAttachments: реплика клиента важнее вложения, терять весь ход
 * из-за одного файла нельзя). Но `catch` был ПУСТОЙ, и «не тот формат» с
 * «кончилось место» выглядели для вызывающего одинаково — как `null`. На полном
 * диске молча пропадали бы все фото и голосовые всех клиентов подряд, а агенту
 * это показывалось бы как «неподдерживаемый формат аудио».
 *
 * Отказ здесь настоящий, а не подменённый `fs`: каталог хранилища подменён на
 * ФАЙЛ, поэтому `mkdirSync` внутри privateDirPath бросает `EEXIST` — ровно так
 * же, как повёл бы себя кончившийся диск или том только на чтение.
 */

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined) }));

const { logSystemError } = await import("../src/lib/systemError.js");
const { savePrivateFile } = await import("../src/lib/privateFiles.js");

/**
 * Каталог документов сделки вычисляется в ТЕЛЕ модуля и там же создаётся, так
 * что подменять переменную надо до импорта — как и `UPLOADS_DIR` в соседних
 * тестах. Подменяем на НАСТОЯЩИЙ временный каталог (иначе модуль не
 * импортируется вовсе), а ломаем его уже в самом тесте.
 */
const dealDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-deal-docs-"));
process.env.DEAL_DOCS_DIR = dealDocsDir;
const { saveDealDocumentFile } = await import("../src/lib/dealDocumentFiles.js");

const blocker = path.join(os.tmpdir(), `rh-private-blocked-${process.pid}-${Date.now().toString(36)}`);
let previousDir: string | undefined;

beforeAll(() => {
  previousDir = process.env.PRIVATE_UPLOADS_DIR;
  // Не каталог, а файл: любая попытка сделать его каталогом или писать внутрь падает.
  fs.writeFileSync(blocker, "это файл, а не каталог");
});

afterEach(() => vi.mocked(logSystemError).mockClear());

afterAll(() => {
  if (previousDir === undefined) delete process.env.PRIVATE_UPLOADS_DIR;
  else process.env.PRIVATE_UPLOADS_DIR = previousDir;
  delete process.env.DEAL_DOCS_DIR;
  fs.rmSync(blocker, { force: true });
  fs.rmSync(dealDocsDir, { recursive: true, force: true });
});

describe("Вложение не записалось на диск", () => {
  it("файл роняется как раньше, но сбой попадает в журнал", async () => {
    process.env.PRIVATE_UPLOADS_DIR = blocker;
    const result = await savePrivateFile(Buffer.from("аудио"), "audio/webm;codecs=opus");

    // Поведение не изменилось: вызывающий по-прежнему получает null и роняет файл.
    expect(result).toBeNull();
    // Главная проверка: о сбое теперь знает журнал, а не только пустой catch.
    expect(logSystemError).toHaveBeenCalledWith("api", expect.stringContaining("не сохранилось"));
  });

  it("неподдерживаемый формат в журнал НЕ пишется — это не сбой, а ответ на то, что прислали", async () => {
    process.env.PRIVATE_UPLOADS_DIR = blocker;
    const result = await savePrivateFile(Buffer.from("что-то"), "application/x-msdownload");

    expect(result).toBeNull();
    expect(logSystemError).not.toHaveBeenCalled();
  });
});

describe("Документ сделки не записался на диск", () => {
  /**
   * Тот же разбор: пустой `catch` делал отказ диска неотличимым от
   * неподдерживаемого формата, и маршрут отвечал агенту «Недопустимый формат
   * файла» на кончившееся место. Поведение прежнее (null), но сбой теперь виден.
   */
  it("возвращает null как раньше, но сбой попадает в журнал", () => {
    // Каталог подменяем на файл уже ПОСЛЕ загрузки модуля: путь он запомнил
    // строкой, а писать будет в то, что окажется по этому пути сейчас.
    fs.rmSync(dealDocsDir, { recursive: true, force: true });
    fs.writeFileSync(dealDocsDir, "это файл, а не каталог");

    const result = saveDealDocumentFile(Buffer.from("скан"), "application/pdf");

    expect(result).toBeNull();
    expect(logSystemError).toHaveBeenCalledWith("api", expect.stringContaining("не сохранился"));

    fs.rmSync(dealDocsDir, { force: true });
    fs.mkdirSync(dealDocsDir, { recursive: true });
  });
});
