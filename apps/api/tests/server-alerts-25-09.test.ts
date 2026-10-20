import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * РАЗБОР ЖУРНАЛА ВЛАДЕЛЬЦА 25.09.2026 — четыре причины шума, каждая со своим
 * стражем:
 *  1. явный dedupKey не узнавал повтор (ключа нет в тексте) — «Статистика
 *     роликов (YOUTUBE)» легла 4 строками за минуту, и каждая будила директора;
 *  2. нехватка права у ключа YouTube писалась строкой на КАЖДЫЙ объект;
 *  3. Telegram «message is not modified» считался отказом правки подписи;
 *  4. «сайт ещё без выдачи статистики» напоминал каждый час, а не раз в сутки.
 */

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "alerts-25-09:test-token";

const { prisma } = await import("../src/db.js");
const { logSystemError, onNewSystemError } = await import("../src/lib/systemError.js");
const { isYoutubeScopeError, reportYoutubeScopeMissing, resetYoutubeScopeReportForTests } = await import("../src/lib/youtubeScope.js");
const { editMessageCaption } = await import("../src/telegram/api.js");

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { message: { contains: runId } } });
});

describe("logSystemError: явный dedupKey узнаёт повтор, даже если ключа нет в тексте", () => {
  it("два вызова с одним ключом и разным текстом — одна строка и одно «новое» оповещение", async () => {
    const seen: string[] = [];
    onNewSystemError((_source, message) => {
      if (message.includes(runId)) seen.push(message);
    });
    const key = `alerts-key-${runId}`;
    await logSystemError("meta", `Статистика роликов (YOUTUBE): 1 из 1 — ${runId}`, { dedupKey: key });
    await logSystemError("meta", `Статистика роликов (YOUTUBE): 27 из 27 — ${runId}`, { dedupKey: key });
    const rows = await prisma.errorLog.findMany({ where: { dedupKey: key } });
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("старая строка без колонки ключа (ключ — начало текста) тоже узнаётся", async () => {
    const key = `Нет связи ${runId}`;
    await prisma.errorLog.create({ data: { source: "telephony", message: `${key}: 30 с подряд` } });
    await logSystemError("telephony", `${key}: 45 с подряд`, { dedupKey: key });
    expect(await prisma.errorLog.count({ where: { message: { startsWith: key } } })).toBe(1);
  });

  it("dedupWindowMs растягивает окно: час назад — повтор при суточном окне, новая строка при обычном", async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const dayKey = `alerts-day-${runId}`;
    const plainKey = `alerts-plain-${runId}`;
    await prisma.errorLog.createMany({
      data: [
        { source: "site-sync", message: `старое ${runId}`, dedupKey: dayKey, createdAt: hourAgo },
        { source: "site-sync", message: `старое ${runId}`, dedupKey: plainKey, createdAt: hourAgo },
      ],
    });
    await logSystemError("site-sync", `новое ${runId}`, { dedupKey: dayKey, dedupWindowMs: 24 * 60 * 60 * 1000 });
    await logSystemError("site-sync", `новое ${runId}`, { dedupKey: plainKey });
    expect(await prisma.errorLog.count({ where: { dedupKey: dayKey } })).toBe(1);
    expect(await prisma.errorLog.count({ where: { dedupKey: plainKey } })).toBe(2);
  });
});

describe("YouTube: нехватка права у ключа — одна суточная строка на все объекты", () => {
  it("узнаёт отказ Google по праву и не путает его с другими", () => {
    expect(isYoutubeScopeError("Request had insufficient authentication scopes.")).toBe(true);
    expect(isYoutubeScopeError("insufficientPermissions")).toBe(true);
    expect(isYoutubeScopeError("The request cannot be completed because you have exceeded your quota.")).toBe(false);
    expect(isYoutubeScopeError("Video not found")).toBe(false);
    expect(isYoutubeScopeError(undefined)).toBe(false);
  });

  it("тридцать объектов подряд дают одну строку с рецептом; перезапуск сервера её не повторяет", async () => {
    await prisma.errorLog.deleteMany({ where: { source: "youtube", dedupKey: "youtube-scope-missing" } });
    resetYoutubeScopeReportForTests();
    for (let i = 0; i < 30; i += 1) reportYoutubeScopeMissing();
    const where = { source: "youtube", dedupKey: "youtube-scope-missing" };
    await waitFor(async () => (await prisma.errorLog.count({ where })) > 0);
    expect(await prisma.errorLog.count({ where })).toBe(1);
    const row = await prisma.errorLog.findFirstOrThrow({ where });
    expect(row.message).toContain("youtube.force-ssl");

    // «Перезапуск»: отметка в памяти пропала, но строка за сутки в базе есть.
    resetYoutubeScopeReportForTests();
    reportYoutubeScopeMissing();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.errorLog.count({ where })).toBe(1);
    await prisma.errorLog.deleteMany({ where });
  });
});

describe("Telegram: «message is not modified» при правке подписи — не отказ", () => {
  function telegramReplies(description: string) {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 })
    ) as typeof fetch;
  }

  it("подпись уже такая — вызов проходит без исключения", async () => {
    telegramReplies(
      "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message"
    );
    await expect(editMessageCaption("@channel", 42, "подпись")).resolves.toBeUndefined();
  });

  it("настоящий отказ по-прежнему летит исключением", async () => {
    telegramReplies("Bad Request: message to edit not found");
    await expect(editMessageCaption("@channel", 42, "подпись")).rejects.toThrow(/message to edit not found/);
  });
});
