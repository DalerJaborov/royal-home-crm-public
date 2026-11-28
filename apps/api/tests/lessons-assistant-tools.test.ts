import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ВИДЕОУРОКИ В ШАБНАМ (28.11.2026): find_lessons / send_lesson / send_all_lessons.
 * Telegram подменён (к нему тест не ходит), каталог — во временной папке из fixtures/lessons-manifest.json,
 * «видео» — пустые файлы.
 */
const { sendVideoFromDisk, sendVideoByFileId, sendMessage, sentLog, logSpy } = vi.hoisted(() => {
  const sentLog: { via: "disk" | "file_id"; chat: string; caption: string; protect: boolean }[] = [];
  return {
    sentLog,
    logSpy: vi.fn(),
    sendVideoFromDisk: vi.fn(async (chat: string, _path: string, caption: string, _t?: number, _b?: unknown, meta?: { protectContent?: boolean }) => {
      sentLog.push({ via: "disk", chat, caption, protect: meta?.protectContent === true });
      return { message_id: 1, video: { file_id: "FILEID-1" } };
    }),
    sendVideoByFileId: vi.fn(async (chat: string, _fileId: string, caption: string, options?: { protectContent?: boolean }) => {
      sentLog.push({ via: "file_id", chat, caption, protect: options?.protectContent === true });
      return { message_id: 2 };
    }),
    sendMessage: vi.fn(async (..._args: unknown[]) => ({ message_id: 3 })),
  };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendVideoFromDisk,
  sendVideoByFileId,
  sendMessage,
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/systemError.js")>();
  logSpy.mockImplementation(original.logSystemError);
  return { ...original, logSystemError: logSpy };
});

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { prisma } = await import("../src/db.js");
const { loadAgentAccess } = await import("../src/auth/middleware.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { pluginDeclarations } = await import("../src/ai/assistant.js");
const { findAssistantToolPlugin, listAssistantToolPlugins, assistantPluginAllowed } = await import("../src/ai/assistant/tools/index.js");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const { resetLessonCatalogCache } = await import("../src/lib/lessons/catalog.js");
const { resetLessonSendLimits, takeLessonSendSlot, takeLessonBroadcastSlot, LESSON_SENDS_PER_MINUTE } = await import("../src/lib/lessons/sender.js");
const { TelegramApiError } = await import("../src/telegram/api.js");
const { __resetShutdownStateForTests, beginShutdown } = await import("../src/lib/shutdownState.js");
const { lessonsGuideFor } = await import("../src/ai/assistant.js");
const { ASSISTANT_LESSON_TOPIC_MAP, ASSISTANT_LESSONS_GUIDE } = await import("../src/ai/assistant/promptSections.js");
const { BUILTIN_ASSISTANT_TOOL_NAMES } = await import("../src/ai/assistant.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now();
const ids: string[] = [];
const ownChat = `91${String(runId).slice(-8)}`;
const groupChat = `-100${String(runId).slice(-9)}`;
let agentId: string;
let shareholderId: string;
let dir: string;
const savedDir = process.env.LESSONS_DIR;
const savedPause = process.env.LESSONS_SEND_PAUSE_MS;

async function makeAgent(role: "AGENT" | "SHAREHOLDER", chat: string | null) {
  const a = await prisma.agent.create({
    data: {
      fullName: `Тест уроки ${role} ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role,
      passwordHash: await bcrypt.hash("testpass123", 4),
      telegramChatId: chat,
    },
  });
  ids.push(a.id);
  return a.id;
}

async function actorOf(id: string, surface: "telegram-private" | "telegram-group" | "crm-private") {
  const access = await loadAgentAccess(id);
  if (!access) throw new Error("нет доступа");
  const actor = actorFromAccess(id, access, surface);
  if (surface === "telegram-private") actor.telegramChatId = ownChat;
  if (surface === "telegram-group") actor.groupChat = { chatId: groupChat, registeredAt: Date.now() };
  return actor;
}

function writeCatalog(withFiles = true) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures", "lessons-manifest.json"), path.join(dir, "manifest.json"));
  if (!withFiles) return;
  for (const rel of ["ru/urok-01-ru.mp4", "ru/urok-02-ru.mp4", "ru/urok-03-ru.mp4", "tj/urok-03-tj.mp4"]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "video");
  }
}

const run = async (name: string, args: Record<string, unknown>, actor: Awaited<ReturnType<typeof actorOf>>, question?: string) =>
  runAssistantToolPlugin(findAssistantToolPlugin(name)!, args, actor, { channel: "telegram", ...(question ? { question } : {}) });

beforeAll(async () => {
  agentId = await makeAgent("AGENT", ownChat);
  shareholderId = await makeAgent("SHAREHOLDER", `92${String(runId).slice(-8)}`);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessons-tools-"));
  process.env.LESSONS_DIR = dir;
  process.env.LESSONS_SEND_PAUSE_MS = "0";
});
afterAll(async () => {
  await prisma.lessonVideoCache.deleteMany({});
  await deleteAgentsWithTraces(ids);
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.LESSONS_DIR;
  else process.env.LESSONS_DIR = savedDir;
  if (savedPause === undefined) delete process.env.LESSONS_SEND_PAUSE_MS;
  else process.env.LESSONS_SEND_PAUSE_MS = savedPause;
});
/** Фоновая рассылка прошлого теста дописывает кэш file_id уже после очистки: ждём, пока счётчики вызовов перестанут расти. */
async function settleBackgroundSends() {
  let last = -1;
  for (;;) {
    const now = sendVideoFromDisk.mock.calls.length + sendVideoByFileId.mock.calls.length + sendMessage.mock.calls.length;
    if (now === last) return;
    last = now;
    await new Promise((r) => setTimeout(r, 80));
  }
}
beforeEach(async () => {
  await settleBackgroundSends();
  sendVideoFromDisk.mockClear();
  sendVideoByFileId.mockClear();
  sendMessage.mockClear();
  logSpy.mockClear();
  __resetShutdownStateForTests();
  delete process.env.TELEGRAM_API_BASE_URL;
  sentLog.length = 0;
  resetLessonSendLimits();
  resetLessonCatalogCache();
  fs.rmSync(dir, { recursive: true, force: true });
  writeCatalog();
  await prisma.lessonVideoCache.deleteMany({});
});

describe("реестр и права", () => {
  it("три инструмента зарегистрированы; send_* — действия общего уровня, find — чтение", () => {
    expect(findAssistantToolPlugin("find_lessons")).toMatchObject({ level: "A" });
    expect(findAssistantToolPlugin("find_lessons")).not.toHaveProperty("sideEffect");
    expect(findAssistantToolPlugin("send_lesson")).toMatchObject({ level: "A", sideEffect: "shared" });
    expect(findAssistantToolPlugin("send_all_lessons")).toMatchObject({ level: "A", sideEffect: "shared" });
  });

  it("в группе не скрыты, сотруднику объявлены; акционеру (режим просмотра) — только поиск", async () => {
    const group = await actorOf(agentId, "telegram-group");
    const names = pluginDeclarations(group, true, "telegram").map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["find_lessons", "send_lesson", "send_all_lessons"]));
    const viewer = await actorOf(shareholderId, "telegram-private");
    const viewerNames = pluginDeclarations(viewer, true, "telegram").map((d) => d.name);
    expect(viewerNames).toContain("find_lessons");
    expect(viewerNames).not.toContain("send_lesson");
    expect(await run("send_lesson", { number: 1 }, viewer)).toMatchObject({ code: "READ_ONLY_ROLE" });
    expect(sendVideoFromDisk).not.toHaveBeenCalled();
  });

  it("актор без роли (не сотрудник) — инструменты недоступны", () => {
    const stranger = { id: "", role: "" } as never;
    for (const name of ["find_lessons", "send_lesson", "send_all_lessons"]) {
      expect(assistantPluginAllowed(findAssistantToolPlugin(name)!, stranger)).toBe(false);
    }
  });

  it("карта «тема → инструменты» в промпте называет только существующие инструменты", () => {
    const real = new Set([...listAssistantToolPlugins().map((p) => p.name), ...BUILTIN_ASSISTANT_TOOL_NAMES]);
    for (const { tools } of ASSISTANT_LESSON_TOPIC_MAP) for (const t of tools) expect(real.has(t), t).toBe(true);
    expect(ASSISTANT_LESSONS_GUIDE).toContain("create_task");
    expect(ASSISTANT_LESSONS_GUIDE).toContain("не выдумывай");
  });
});

describe("find_lessons", () => {
  it("находит по теме, возвращает название и фрагмент из текста урока", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    const res = (await run("find_lessons", { query: "как принять заявку" }, actor)) as { lessons: { number: number; title: string; answerFromLesson: string }[] };
    expect(res.lessons[0]).toMatchObject({ number: 2, title: "Новая заявка" });
    expect(res.lessons[0]!.answerFromLesson).toContain("Принять");
  });

  it("таджикские буквы в вопросе — таджикский урок первым", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    const res = (await run("find_lessons", { query: "намоиш" }, actor, "намоиш чӣ тавр сабт мешавад?")) as { lang: string; lessons: { lang: string }[] };
    expect(res.lang).toBe("tj");
    expect(res.lessons[0]!.lang).toBe("tj");
  });

  it("ничего не нашлось и пустой каталог — честный ответ, не падение", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    expect(await run("find_lessons", { query: "квантовая бухгалтерия" }, actor)).toMatchObject({ lessons: [], note: expect.stringContaining("нет в каталоге") });
    fs.rmSync(dir, { recursive: true, force: true });
    resetLessonCatalogCache();
    expect(await run("find_lessons", { query: "заявка" }, actor)).toMatchObject({ lessons: [], note: "Уроки пока не загружены" });
  });
});

describe("send_lesson", () => {
  it("личка: файлом с подписью и запретом пересылки; file_id запоминается; повтор идёт по file_id", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    expect(await run("send_lesson", { number: 2 }, actor)).toMatchObject({ ok: true, sent: "Урок 2. Новая заявка" });
    expect(sendVideoFromDisk).toHaveBeenCalledTimes(1);
    const call = sendVideoFromDisk.mock.calls[0]!;
    expect(call[0]).toBe(ownChat);
    expect(call[2]).toBe("Урок 2. Новая заявка");
    expect(call[5]).toMatchObject({ protectContent: true, durationSec: 156.6 });
    expect(await prisma.lessonVideoCache.findUnique({ where: { lang_number: { lang: "ru", number: 2 } } })).toMatchObject({ fileId: "FILEID-1" });

    resetLessonSendLimits();
    expect(await run("send_lesson", { number: 2 }, actor)).toMatchObject({ ok: true });
    expect(sendVideoFromDisk).toHaveBeenCalledTimes(1);
    expect(sendVideoByFileId).toHaveBeenCalledWith(ownChat, "FILEID-1", "Урок 2. Новая заявка", { protectContent: true });
  });

  it("заменили файл на сервере — кэш file_id не используется, шлём файлом", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    await run("send_lesson", { number: 1 }, actor);
    resetLessonSendLimits();
    fs.writeFileSync(path.join(dir, "ru/urok-01-ru.mp4"), "video, но другой и подлиннее");
    await run("send_lesson", { number: 1 }, actor);
    expect(sendVideoByFileId).not.toHaveBeenCalled();
    expect(sendVideoFromDisk).toHaveBeenCalledTimes(2);
  });

  it("file_id протух — шлём файлом и обновляем запись", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    await run("send_lesson", { number: 3 }, actor);
    resetLessonSendLimits();
    sendVideoByFileId.mockRejectedValueOnce(new Error("wrong file identifier"));
    sendVideoFromDisk.mockResolvedValueOnce({ message_id: 9, video: { file_id: "FILEID-2" } });
    expect(await run("send_lesson", { number: 3 }, actor)).toMatchObject({ ok: true });
    expect(await prisma.lessonVideoCache.findUnique({ where: { lang_number: { lang: "ru", number: 3 } } })).toMatchObject({ fileId: "FILEID-2" });
  });

  it("группа: уходит в группу, без защиты от пересылки; «мне в личку» — в личный чат с защитой", async () => {
    const actor = await actorOf(agentId, "telegram-group");
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ ok: true, to: "эта группа" });
    expect(await run("send_lesson", { number: 1, target: "me" }, actor)).toMatchObject({ ok: true, to: "личка" });
    expect(sentLog.map((x) => [x.chat, x.protect])).toEqual([[groupChat, false], [ownChat, true]]);
  });

  it("из CRM (не Telegram): в личный чат из профиля; нет привязки — подсказка", async () => {
    const actor = await actorOf(agentId, "crm-private");
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ ok: true });
    expect(sentLog[0]!.chat).toBe(ownChat);
    await prisma.agent.update({ where: { id: agentId }, data: { telegramChatId: null } });
    try {
      resetLessonSendLimits();
      expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("Telegram не привязан") });
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { telegramChatId: ownChat } });
    }
  });

  it("язык: по умолчанию русский, таджикские буквы в вопросе — таджикский; явный lang главнее", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    await run("send_lesson", { number: 3 }, actor);
    resetLessonSendLimits();
    await run("send_lesson", { number: 3 }, actor, "дарси намоишро ба тоҷикӣ фиристед");
    resetLessonSendLimits();
    await run("send_lesson", { number: 3, lang: "ru" }, actor, "дарси намоишро ба тоҷикӣ фиристед");
    expect(sentLog.map((x) => x.caption)).toEqual(["Урок 3. Показ объекта", "Урок 3. Нишон додани объект", "Урок 3. Показ объекта"]);
  });

  it("по теме без номера; нет такого номера или языка — честная ошибка", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    expect(await run("send_lesson", { query: "принять заявку" }, actor)).toMatchObject({ sent: "Урок 2. Новая заявка" });
    expect(await run("send_lesson", { number: 77 }, actor)).toMatchObject({ error: expect.stringContaining("77") });
    expect(await run("send_lesson", { number: 1, lang: "tj" }, actor)).toMatchObject({ error: expect.stringContaining("на русском") });
    expect(await run("send_lesson", {}, actor)).toMatchObject({ error: expect.any(String) });
  });

  it("двойная отправка одного урока в тот же чат за минуту — отказ; в другой чат можно", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ ok: true });
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("уже отправлен") });
    expect(sendVideoFromDisk).toHaveBeenCalledTimes(1);
    const group = await actorOf(agentId, "telegram-group");
    expect(await run("send_lesson", { number: 1 }, group)).toMatchObject({ ok: true });
  });

  it("предел в минуту на чат", () => {
    for (let n = 1; n <= LESSON_SENDS_PER_MINUTE; n += 1) expect(takeLessonSendSlot("c", { number: n, lang: "ru" }).ok).toBe(true);
    expect(takeLessonSendSlot("c", { number: 99, lang: "ru" })).toMatchObject({ ok: false });
    expect(takeLessonSendSlot("other", { number: 99, lang: "ru" }).ok).toBe(true);
    expect(takeLessonSendSlot("c", { number: 100, lang: "ru" }, Date.now() + 61_000).ok).toBe(true);
  });

  it("файла нет на сервере или каталог пуст — ошибка без падения", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    fs.rmSync(path.join(dir, "ru/urok-02-ru.mp4"));
    expect(await run("send_lesson", { number: 2 }, actor)).toMatchObject({ error: expect.stringContaining("недоступен") });
    fs.rmSync(path.join(dir, "manifest.json"));
    resetLessonCatalogCache();
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: "Уроки пока не загружены" });
  });

  it("сбой Telegram — честная ошибка", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    sendVideoFromDisk.mockRejectedValueOnce(new Error("boom"));
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("Не получилось") });
  });
});

describe("send_all_lessons", () => {
  it("оглавление, уроки на языке человека по порядку, «Это все»; в группе без защиты", async () => {
    const actor = await actorOf(agentId, "telegram-group");
    expect(await run("send_all_lessons", {}, actor)).toMatchObject({ ok: true, started: true, count: 3 });
    await waitFor(async () => (sendMessage.mock.calls.length >= 2 ? true : null));
    expect(sendMessage.mock.calls[0]![1]).toBe("Уроки по CRM:\n1. Вход в CRM\n2. Новая заявка\n3. Показ объекта");
    expect(sendMessage.mock.calls[1]![1]).toBe("Это все");
    expect(sendVideoFromDisk.mock.calls.map((c) => c[2])).toEqual(["Урок 1. Вход в CRM", "Урок 2. Новая заявка", "Урок 3. Показ объекта"]);
    expect(sentLog.every((x) => x.chat === groupChat && !x.protect)).toBe(true);
  });

  it("не чаще раза в час на чат; таджикский — свой набор; в другой чат можно", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    expect(await run("send_all_lessons", { lang: "tj" }, actor)).toMatchObject({ ok: true, count: 1 });
    await waitFor(async () => (sendMessage.mock.calls.length >= 2 ? true : null));
    expect(await run("send_all_lessons", {}, actor)).toMatchObject({ error: expect.stringContaining("Повторить можно через") });
    const group = await actorOf(agentId, "telegram-group");
    expect(await run("send_all_lessons", {}, group)).toMatchObject({ ok: true });
  });

  it("пустой каталог — «уроки пока не загружены»", async () => {
    fs.rmSync(path.join(dir, "manifest.json"));
    resetLessonCatalogCache();
    const actor = await actorOf(agentId, "telegram-private");
    expect(await run("send_all_lessons", {}, actor)).toMatchObject({ error: "Уроки пока не загружены" });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("метка «уже отправлен» и замок «в процессе» (правка по ревью 28.11)", () => {
  it("сбой Telegram: после «попробуй ещё раз» урок уходит, а не «уже отправлен»", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    sendVideoFromDisk.mockRejectedValueOnce(new Error("boom"));
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("Не получилось") });
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ ok: true });
  });

  it("файла нет на сервере: после появления файла повтор проходит", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    fs.rmSync(path.join(dir, "ru/urok-01-ru.mp4"));
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("недоступен") });
    fs.writeFileSync(path.join(dir, "ru/urok-01-ru.mp4"), "video");
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ ok: true });
  });

  it("пока урок уходит, повтор в тот же чат — «отправляется»; после успеха — «уже отправлен»", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    let release!: () => void;
    sendVideoFromDisk.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ message_id: 1, video: { file_id: "F" } }); }) as never,
    );
    const first = run("send_lesson", { number: 1 }, actor);
    await waitFor(async () => (sendVideoFromDisk.mock.calls.length > 0 ? true : null));
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("отправляется") });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("уже отправлен") });
  });

  it("слот: done(false) снимает замок и минутный счёт, done(true) ставит метку", () => {
    const lesson = { number: 5, lang: "ru" as const };
    const a = takeLessonSendSlot("slot-chat", lesson);
    if (!a.ok) throw new Error("ожидали ok");
    expect(takeLessonSendSlot("slot-chat", lesson)).toMatchObject({ ok: false, error: expect.stringContaining("отправляется") });
    a.done(false);
    const b = takeLessonSendSlot("slot-chat", lesson);
    if (!b.ok) throw new Error("ожидали ok");
    b.done(true);
    expect(takeLessonSendSlot("slot-chat", lesson)).toMatchObject({ ok: false, error: expect.stringContaining("уже отправлен") });
  });

  it("слот «все уроки»: done(false) час не блокирует, done(true) блокирует", () => {
    const a = takeLessonBroadcastSlot("bc-chat");
    if (!a.ok) throw new Error("ожидали ok");
    expect(takeLessonBroadcastSlot("bc-chat")).toMatchObject({ ok: false, error: expect.stringContaining("уже отправляются") });
    a.done(false);
    const b = takeLessonBroadcastSlot("bc-chat");
    if (!b.ok) throw new Error("ожидали ok");
    b.done(true);
    expect(takeLessonBroadcastSlot("bc-chat")).toMatchObject({ ok: false, error: expect.stringContaining("Повторить можно через") });
  });

  it("«все уроки»: провал на первом сообщении (оглавлении) час не блокирует", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    sendMessage.mockRejectedValueOnce(new Error("net down"));
    expect(await run("send_all_lessons", {}, actor)).toMatchObject({ ok: true, started: true });
    await waitFor(async () => (logSpy.mock.calls.length >= 1 ? true : null));
    // слот снят: повтор разрешён
    expect(await run("send_all_lessons", {}, actor)).toMatchObject({ ok: true, started: true });
  });
});

describe("отказ чата 400/403", () => {
  it("403 при отправке файлом: понятная фраза, в журнал не пишем, метка не ставится", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    sendVideoFromDisk.mockRejectedValueOnce(new TelegramApiError(403, "sendVideo (с диска)", "Forbidden: bot was blocked by the user"));
    const res = await run("send_lesson", { number: 1 }, actor);
    expect(res).toMatchObject({ error: expect.stringContaining("Старт") });
    expect(logSpy).not.toHaveBeenCalled();
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ ok: true });
  });

  it("400 «нет права слать видео в группе»: своя фраза", async () => {
    const actor = await actorOf(agentId, "telegram-group");
    sendVideoFromDisk.mockRejectedValueOnce(new TelegramApiError(400, "sendVideo (с диска)", "Bad Request: not enough rights to send videos to the chat"));
    expect(await run("send_lesson", { number: 1 }, actor)).toMatchObject({ error: expect.stringContaining("нет права отправлять видео") });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("403 по file_id: с диска повторно не грузим; «файл не тот» (400) — грузим", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    await run("send_lesson", { number: 2 }, actor);
    resetLessonSendLimits();
    sendVideoFromDisk.mockClear();
    logSpy.mockClear();
    sendVideoByFileId.mockRejectedValueOnce(new TelegramApiError(403, "sendVideo", "Forbidden: bot was blocked by the user"));
    expect(await run("send_lesson", { number: 2 }, actor)).toMatchObject({ error: expect.stringContaining("Старт") });
    expect(sendVideoFromDisk).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    resetLessonSendLimits();
    sendVideoByFileId.mockRejectedValueOnce(new TelegramApiError(400, "sendVideo", "Bad Request: wrong file identifier/HTTP URL specified"));
    expect(await run("send_lesson", { number: 2 }, actor)).toMatchObject({ ok: true });
    expect(sendVideoFromDisk).toHaveBeenCalledTimes(1);
  });

  it("«все уроки»: после 403 на уроке рассылка останавливается, «Это все» не шлём, в журнал не пишем", async () => {
    const actor = await actorOf(agentId, "telegram-group");
    sendVideoFromDisk.mockRejectedValueOnce(new TelegramApiError(403, "sendVideo (с диска)", "Forbidden: bot was kicked from the supergroup chat"));
    expect(await run("send_all_lessons", {}, actor)).toMatchObject({ ok: true, started: true });
    await waitFor(async () => (sendVideoFromDisk.mock.calls.length >= 1 ? true : null));
    await new Promise((r) => setTimeout(r, 150));
    expect(sendVideoFromDisk).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1); // только оглавление
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("остановка сервера прерывает «все уроки»: дальше уроки не шлются", async () => {
    const actor = await actorOf(agentId, "telegram-group");
    beginShutdown();
    expect(await run("send_all_lessons", {}, actor)).toMatchObject({ ok: true, started: true });
    await waitFor(async () => (sendMessage.mock.calls.length >= 1 ? true : null));
    await new Promise((r) => setTimeout(r, 150));
    expect(sendVideoFromDisk).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("размеры видео и предел 50 МБ", () => {
  it("width/height — из манифеста; без них в Telegram не передаются", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    await run("send_lesson", { number: 1 }, actor);
    expect(sendVideoFromDisk.mock.calls[0]![5]).toMatchObject({ width: 1080, height: 1920 });
    await run("send_lesson", { number: 3 }, actor);
    const meta = sendVideoFromDisk.mock.calls[1]![5] as Record<string, unknown>;
    expect(meta).not.toHaveProperty("width");
    expect(meta).not.toHaveProperty("height");
  });

  it("файл больше 50 МБ без своего Bot API — отказ без загрузки; со своим сервером — шлём", async () => {
    const actor = await actorOf(agentId, "telegram-private");
    fs.truncateSync(path.join(dir, "ru/urok-02-ru.mp4"), 51 * 1024 * 1024);
    expect(await run("send_lesson", { number: 2 }, actor)).toMatchObject({ error: expect.stringContaining("больше 50 МБ") });
    expect(sendVideoFromDisk).not.toHaveBeenCalled();
    process.env.TELEGRAM_API_BASE_URL = "http://telegram-bot-api:8081";
    expect(await run("send_lesson", { number: 2 }, actor)).toMatchObject({ ok: true });
    expect(sendVideoFromDisk).toHaveBeenCalledTimes(1);
  });
});

describe("блок промпта про уроки", () => {
  it("нет send_lesson среди объявленных (режим просмотра) или каталога нет — блока нет", async () => {
    const viewer = await actorOf(shareholderId, "telegram-private");
    expect(await lessonsGuideFor(pluginDeclarations(viewer, true, "telegram", true))).toBe("");
    const staff = await actorOf(agentId, "telegram-private");
    const staffDecl = pluginDeclarations(staff, true, "telegram");
    expect(await lessonsGuideFor(staffDecl)).toBe(ASSISTANT_LESSONS_GUIDE);
    fs.rmSync(path.join(dir, "manifest.json"));
    resetLessonCatalogCache();
    expect(await lessonsGuideFor(staffDecl)).toBe("");
  });
});
