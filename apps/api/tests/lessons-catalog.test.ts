import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  catalogProblem,
  lessonNumberFromQuery,
  loadLessonCatalog,
  resetLessonCatalogCache,
  searchLessons,
} from "../src/lib/lessons/catalog.js";

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: logSpy,
}));

/** Каталог видеоуроков (28.11.2026): пустой каталог, битый манифест, безопасные пути, поиск и фрагмент. */
const manifest = fs.readFileSync(path.join(__dirname, "fixtures", "lessons-manifest.json"), "utf8");
let dir: string;
const saved = process.env.LESSONS_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessons-"));
  process.env.LESSONS_DIR = dir;
  resetLessonCatalogCache();
  logSpy.mockClear();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.LESSONS_DIR;
  else process.env.LESSONS_DIR = saved;
  resetLessonCatalogCache();
});

describe("загрузка каталога", () => {
  it("нет каталога и нет манифеста — «уроки пока не загружены», без исключений", async () => {
    process.env.LESSONS_DIR = path.join(dir, "no-such-dir");
    const catalog = await loadLessonCatalog();
    expect(catalog.status).toBe("empty");
    expect(catalogProblem(catalog)).toBe("Уроки пока не загружены");
    expect(logSpy).not.toHaveBeenCalled(); // «каталога нет» — не авария
  });

  it("манифест нечитаем не из-за отсутствия (это папка) — «недоступны», одна запись в журнал с ключом, не «не загружены»", async () => {
    fs.mkdirSync(path.join(dir, "manifest.json"));
    const catalog = await loadLessonCatalog();
    expect(catalog.status).toBe("invalid");
    expect(catalogProblem(catalog)).toBe("Уроки сейчас недоступны");
    await loadLessonCatalog(); // из кэша — второй записи нет
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![2]).toMatchObject({ dedupKey: "lessons-catalog-problem" });
  });

  it("манифест не по схеме — запись в журнал; плохой путь у строки — строка отброшена и ОДНА запись на загрузку", async () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ lessons: [{ number: "x" }] }));
    await loadLessonCatalog();
    expect(logSpy).toHaveBeenCalledTimes(1);
    resetLessonCatalogCache();
    logSpy.mockClear();
    const m = JSON.parse(manifest);
    const bad = [
      { ...m.lessons[0], number: 7, file: "../../x.mp4" },
      { ...m.lessons[0], number: 8, file: "../../y.mp4" },
      m.lessons[1],
    ];
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ lessons: bad }));
    const catalog = await loadLessonCatalog();
    if (catalog.status !== "ok") throw new Error("ожидали ok");
    expect(catalog.lessons.map((l) => l.number)).toEqual([2]);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("width и height из манифеста читаются; без них — null (в Telegram не передаются)", async () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
    const catalog = await loadLessonCatalog();
    if (catalog.status !== "ok") throw new Error("ожидали ok");
    expect(catalog.lessons.find((l) => l.number === 1)).toMatchObject({ width: 1080, height: 1920 });
    expect(catalog.lessons.find((l) => l.number === 3 && l.lang === "ru")).toMatchObject({ width: null, height: null });
  });

  it("символьная ссылка наружу из каталога — отказ (realpath)", async (ctx) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lessons-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.mp4"), "x");
      fs.mkdirSync(path.join(dir, "ru"));
      try {
        fs.symlinkSync(path.join(outside, "secret.mp4"), path.join(dir, "ru", "link.mp4"));
      } catch {
        ctx.skip(); // Windows без права на симлинки
        return;
      }
      fs.writeFileSync(path.join(dir, "ru", "ok.mp4"), "x");
      const m = JSON.parse(manifest);
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ lessons: [{ ...m.lessons[0], number: 1, file: "ru/link.mp4" }, { ...m.lessons[1], number: 2, file: "ru/ok.mp4" }] }),
      );
      const catalog = await loadLessonCatalog();
      if (catalog.status !== "ok") throw new Error("ожидали ok");
      expect(catalog.lessons.map((l) => l.number)).toEqual([2]);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("битый манифест (не JSON и не по схеме) — отдельный статус, не падение", async () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), "{not json");
    expect((await loadLessonCatalog()).status).toBe("invalid");
    resetLessonCatalogCache();
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ lessons: [{ number: "x" }] }));
    const catalog = await loadLessonCatalog();
    expect(catalog.status).toBe("invalid");
    expect(catalogProblem(catalog)).toBe("Уроки сейчас недоступны");
    expect(logSpy).toHaveBeenCalledTimes(2); // по записи на каждую загрузку
  });

  it("читает манифест, сортирует по номеру, кэширует на минуту", async () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
    const catalog = await loadLessonCatalog();
    if (catalog.status !== "ok") throw new Error("ожидали ok");
    expect(catalog.lessons.map((l) => `${l.number}:${l.lang}`)).toEqual(["1:ru", "2:ru", "3:ru", "3:tj"]);
    expect(catalog.lessons[0]!.filePath).toBe(path.join(dir, "ru", "urok-01-ru.mp4"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ lessons: [] }));
    expect((await loadLessonCatalog()).status).toBe("ok"); // из кэша
    resetLessonCatalogCache();
    expect((await loadLessonCatalog()).status).toBe("empty");
  });

  it("путь выхода из каталога (../) отбрасывается", async () => {
    const evil = { lessons: [{ number: 1, lang: "ru", title: "Плохой", file: "../../etc/passwd", transcript: "x" }, JSON.parse(manifest).lessons[1]] };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(evil));
    const catalog = await loadLessonCatalog();
    if (catalog.status !== "ok") throw new Error("ожидали ok");
    expect(catalog.lessons.map((l) => l.number)).toEqual([2]);
  });
});

describe("поиск", () => {
  async function lessons() {
    fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
    const catalog = await loadLessonCatalog();
    if (catalog.status !== "ok") throw new Error("ожидали ok");
    return catalog.lessons;
  }

  it("номер: «урок 3», «3», «№3»", () => {
    expect(lessonNumberFromQuery("урок 3")).toBe(3);
    expect(lessonNumberFromQuery(" 3 ")).toBe(3);
    expect(lessonNumberFromQuery("№3")).toBe(3);
    expect(lessonNumberFromQuery("как принять заявку")).toBeNull();
  });

  it("по номеру: язык человека первым", async () => {
    const all = await lessons();
    expect(searchLessons(all, "урок 3", "tj").map((h) => h.lesson.lang)).toEqual(["tj", "ru"]);
    expect(searchLessons(all, "3", "ru")[0]!.lesson.lang).toBe("ru");
  });

  it("по словам с окончаниями: «принять заявку» находит «Новая заявка», фрагмент из текста урока", async () => {
    const all = await lessons();
    const hits = searchLessons(all, "как принять заявку?", "ru");
    expect(hits[0]!.lesson.number).toBe(2);
    expect(hits[0]!.snippet).toContain("Принять");
  });

  it("по таджикскому тексту: «намоиш» находит урок на таджикском", async () => {
    const all = await lessons();
    const hits = searchLessons(all, "намоиш мизоҷ", "tj");
    expect(hits[0]!.lesson).toMatchObject({ number: 3, lang: "tj" });
  });

  it("совпадение в названии весомее совпадения в тексте; ничего не нашлось — пусто; служебные слова не ищутся", async () => {
    const all = await lessons();
    expect(searchLessons(all, "показ", "ru")[0]!.lesson.number).toBe(3);
    expect(searchLessons(all, "квантовая бухгалтерия", "ru")).toEqual([]);
    expect(searchLessons(all, "как это сделать", "ru")).toEqual([]);
  });
});
