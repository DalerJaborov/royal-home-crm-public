import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Уборка закрытого хранилища вложений.
 *
 * Удаление файлов необратимо: ошибка здесь стирает фото и голосовые клиентов
 * навсегда, а восстанавливать их неоткуда. Поэтому проверяется не «функция что-то
 * удалила», а каждое ограничение по отдельности — именно те, из-за отсутствия
 * которых такой код и становится опасным:
 *
 *   1. Свежий файл переживает уборку.
 *   2. Старый — удаляется (иначе смысла в задаче нет).
 *   3. Уборка не выходит за пределы своей папки: ни в соседнюю, ни во вложенную,
 *      ни на файлы с чужими именами.
 *   4. Потолок удалений за один проход соблюдается.
 *
 * Каталог хранилища задаётся переменной среды ДО загрузки модуля — ровно так же,
 * как на боевом сервере. Параметром его передать нельзя (и не должно быть можно):
 * убирать разрешено только там, куда мы сами и пишем.
 */

const runId = `${Date.now()}-${process.pid}`;
const root = path.join(os.tmpdir(), `rh-private-cleanup-${runId}`);
const privateDir = path.join(root, "uploads-private");
/** Соседняя папка — за её содержимое уборка отвечать не должна вовсе. */
const neighbourDir = path.join(root, "чужое");
/** Вложенная папка внутри хранилища: обхода вглубь быть не должно. */
const nestedDir = path.join(privateDir, "вложенная");

const DAY_MS = 24 * 60 * 60 * 1000;

type Cleanup = typeof import("../src/lib/privateFiles.js").cleanupPrivateFiles;
let cleanupPrivateFiles: Cleanup;
/** Весь модуль целиком — для проверок «какие типы принимает хранилище» ниже.
 *  Они живут ЗДЕСЬ, а не отдельным файлом: каталог хранилища модуль запоминает
 *  при первой загрузке, а процесс прогона один на сотни файлов — второй файл со
 *  своим каталогом забирал загрузку себе, и уборка чистила чужую, уже удалённую
 *  папку (CI 21.09.2026: «expected 0 to be 2»). */
let pf: typeof import("../src/lib/privateFiles.js");
/** Значение до подмены — вернём его, чтобы соседние файлы тестов не унесло
 *  во временный каталог, если прогон идёт в одном процессе. */
let previousDirEnv: string | undefined;

/** Файл с заданным возрастом. Имя — как у настоящих: uuid + расширение. */
function makeOwnFile(ageDays: number, dir: string = privateDir): string {
  const name = `${randomUUID()}.jpg`;
  return makeFile(name, ageDays, dir);
}

function makeFile(name: string, ageDays: number, dir: string): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, `содержимое ${name}`);
  const at = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(full, at, at);
  return full;
}

beforeAll(async () => {
  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(neighbourDir, { recursive: true });
  // Переменная среды читается модулем один раз при загрузке — поэтому импорт
  // динамический и строго после неё.
  previousDirEnv = process.env.PRIVATE_UPLOADS_DIR;
  process.env.PRIVATE_UPLOADS_DIR = privateDir;
  pf = await import("../src/lib/privateFiles.js");
  ({ cleanupPrivateFiles } = pf);
});

beforeEach(() => {
  // Каждый сценарий начинает с чистого хранилища: файлы между ними не наследуются.
  fs.rmSync(privateDir, { recursive: true, force: true });
  fs.mkdirSync(privateDir, { recursive: true });
});

afterAll(() => {
  // Убираем за собой: каталог временный, но оставлять мусор незачем.
  fs.rmSync(root, { recursive: true, force: true });
  if (previousDirEnv === undefined) delete process.env.PRIVATE_UPLOADS_DIR;
  else process.env.PRIVATE_UPLOADS_DIR = previousDirEnv;
});

describe("Что уборка оставляет", () => {
  it("свежий файл не удаляется", () => {
    const today = makeOwnFile(0);
    const yesterday = makeOwnFile(1);
    const month = makeOwnFile(30);

    const result = cleanupPrivateFiles();

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(today)).toBe(true);
    expect(fs.existsSync(yesterday)).toBe(true);
    expect(fs.existsSync(month)).toBe(true);
  });

  it("файл на границе срока (179 суток) ещё живёт", () => {
    // Срок хранения — 180 суток. Проверяем именно край: ошибка на единицу здесь
    // означала бы, что мы удаляем на сутки раньше обещанного.
    const almostOld = makeOwnFile(179);

    cleanupPrivateFiles();

    expect(fs.existsSync(almostOld)).toBe(true);
  });
});

describe("Что уборка удаляет", () => {
  it("файл старше срока хранения удаляется", () => {
    const old = makeOwnFile(200);
    const veryOld = makeOwnFile(400);
    const fresh = makeOwnFile(2);

    const result = cleanupPrivateFiles();

    expect(result.deleted).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(veryOld)).toBe(false);
    // Свежий рядом со старыми — не задет.
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe("За пределы своей папки уборка не выходит", () => {
  it("старый файл в СОСЕДНЕЙ папке не трогается", () => {
    const outside = makeOwnFile(400, neighbourDir);
    makeOwnFile(400); // чтобы проход реально работал, а не выходил вхолостую

    const result = cleanupPrivateFiles();

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(outside)).toBe(true);
    fs.rmSync(outside, { force: true });
  });

  it("старый файл во ВЛОЖЕННОЙ папке не трогается — обхода вглубь нет", () => {
    fs.mkdirSync(nestedDir, { recursive: true });
    const nested = makeOwnFile(400, nestedDir);

    const result = cleanupPrivateFiles();

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(nested)).toBe(true);
    // Сам каталог тоже на месте: уборка удаляет файлы, а не структуру.
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it("старый файл с ЧУЖИМ именем не трогается — удаляем только то, что сами создали", () => {
    const foreign = makeFile("важное.txt", 400, privateDir);
    const backup = makeFile("uploads-private.tar.gz", 400, privateDir);
    const almostOurs = makeFile("00000000-0000-4000-8000-00000000000.jpg", 400, privateDir); // на символ короче uuid

    const result = cleanupPrivateFiles();

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.existsSync(almostOurs)).toBe(true);
  });
});

describe("Потолок за проход", () => {
  it("за один проход удаляется не больше потолка, остаток ждёт следующего", () => {
    const files = Array.from({ length: 5 }, () => makeOwnFile(400));

    const first = cleanupPrivateFiles({ maxDeletions: 2 });
    expect(first.deleted).toBe(2);
    expect(first.capped).toBe(true);
    expect(files.filter((f) => fs.existsSync(f))).toHaveLength(3);

    const second = cleanupPrivateFiles({ maxDeletions: 2 });
    expect(second.deleted).toBe(2);
    expect(files.filter((f) => fs.existsSync(f))).toHaveLength(1);

    // Третий проход добирает остаток — и потолок уже не упирается.
    const third = cleanupPrivateFiles({ maxDeletions: 2 });
    expect(third.deleted).toBe(1);
    expect(third.capped).toBe(false);
    expect(files.filter((f) => fs.existsSync(f))).toHaveLength(0);
  });

  it("нулевой потолок не удаляет ничего", () => {
    const old = makeOwnFile(400);

    const result = cleanupPrivateFiles({ maxDeletions: 0 });

    expect(result.deleted).toBe(0);
    expect(result.capped).toBe(true);
    expect(fs.existsSync(old)).toBe(true);
  });

  it("потолок нельзя поднять снаружи — только опустить", () => {
    // Просьба «удали хоть миллион» не должна поднимать зашитый предел прохода:
    // именно он и есть страховка от того, что ошибка в условиях снесёт хранилище
    // целиком за одну ночь. Зашитый предел — 500, кладём 501 старый файл.
    const files = Array.from({ length: 501 }, () => makeOwnFile(400));

    const result = cleanupPrivateFiles({ maxDeletions: Number.MAX_SAFE_INTEGER });

    expect(result.deleted).toBe(500);
    expect(result.capped).toBe(true);
    expect(files.filter((f) => fs.existsSync(f))).toHaveLength(1);
  });
});

describe("закрытое хранилище: видео и документы от клиентов", () => {
  const cases: Array<[mime: string, ext: string]> = [
    ["video/mp4", "mp4"],
    ["video/quicktime", "mov"],
    ["video/3gpp", "3gp"],
    ["video/mpeg", "mpeg"],
    ["application/pdf", "pdf"],
    ["text/plain", "txt"],
  ];

  it.each(cases)("%s сохраняется, находится по имени и отдаётся с тем же типом", async (mime, ext) => {
    const data = Buffer.from(`содержимое ${mime}`);
    const name = await pf.savePrivateFile(data, mime);
    expect(name).not.toBeNull();
    expect(name!.endsWith(`.${ext}`)).toBe(true);

    const full = pf.privateFilePath(name!);
    expect(full).not.toBeNull();
    expect(fs.readFileSync(full!).equals(data)).toBe(true);
    expect(pf.privateMimeType(name!)).toBe(mime);
  });

  it("тип с параметрами (как у MediaRecorder и части мессенджеров) тоже принимается", async () => {
    const name = await pf.savePrivateFile(Buffer.from("x"), "video/mp4; codecs=avc1");
    expect(name?.endsWith(".mp4")).toBe(true);
  });

  it("video/webm сохраняется; отдаётся как audio/webm — общее расширение с голосовыми", async () => {
    // Обратный поиск по расширению берёт первое совпадение. Голосовых .webm
    // большинство, их тип не меняем; WebM-видео браузер опознаёт по контейнеру.
    const name = await pf.savePrivateFile(Buffer.from("x"), "video/webm");
    expect(name?.endsWith(".webm")).toBe(true);
    expect(pf.privateMimeType(name!)).toBe("audio/webm");
  });

  it("неизвестный тип по-прежнему отклоняется, а не пишется под чужим расширением", async () => {
    expect(await pf.savePrivateFile(Buffer.from("x"), "application/zip")).toBeNull();
  });
});
