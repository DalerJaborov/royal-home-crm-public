import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ ДВЕРИ КОПИЙ МОНТАЖА (21.11.2026, владелец: «монтажёр получает все файлы? Я получаю копию,
 * а озвучки мне не приходят»).
 *
 * Голос озвучки и его текст уходили монтажёру прямым sendDocumentFile/sendMessage (lib/narrationDelivery.ts)
 * мимо lib/montageObservers.ts — наблюдатель видел строку «озвучка придёт отдельным mp3», а самого mp3 не
 * видел никогда. Правило: файл, который читает чат монтажёра (videoMontajerAgentId / usableMontajerWhere +
 * telegramChatId) и сам шлёт в Telegram, обязан звать общую дверь копий (sendMontageCopies или sendToMontajer).
 * Исключения — только с причиной ниже.
 */
// Чтение исходников: база не нужна (setup.ts без настоящей базы ничего не сбрасывает).
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Читают чат монтажёра и шлют в Telegram, но монтажёру по своему почину не пишут. */
const NOT_A_MONTAJER_SEND: Record<string, string> = {
  "telegram/bot.ts": "ответы в диалоге на сообщения самого человека (в том числе монтажёра); задания монтажёру идут через sendToMontajer",
  "telegram/clipReviewBot.ts": "ролик на проверку модератору; монтажёру отсюда не пишется ничего (возврат — sendBackToMontajer)",
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : files(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const importsTelegramSend = (source: string, file: string) =>
  [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].some((m) => {
    const fromApi = /(?:^|\/)telegram\/api\.js$/.test(m[2]!) || (file.startsWith("telegram/") && m[2] === "./api.js");
    return fromApi && /\bsend\w*/.test(m[1]!);
  });

describe("дверь копий монтажа: всё, что уходит монтажёру, видит наблюдатель", () => {
  const senders = files(SRC)
    .map((p) => ({ file: rel(p), source: fs.readFileSync(p, "utf8") }))
    .filter(({ file, source }) => /videoMontajerAgentId|usableMontajerWhere/.test(source) && /telegramChatId/.test(source) && importsTelegramSend(source, file));

  it("каждый файл, который сам шлёт в чат монтажёра, зовёт sendMontageCopies или sendToMontajer", () => {
    const bypass = senders
      .filter(({ file }) => !NOT_A_MONTAJER_SEND[file])
      .filter(({ file, source }) => file !== "lib/montageObservers.ts" && !/\bsendMontageCopies\(|\bsendToMontajer\(/.test(source))
      .map(({ file }) => file);
    expect(bypass).toEqual([]);
  });

  it("озвучка монтажёру (mp3 и текст) копируется наблюдателям той же дверью", () => {
    const source = fs.readFileSync(path.join(SRC, "lib/narrationDelivery.ts"), "utf8");
    expect(source).toMatch(/copyNarrationToObservers\(/);
    expect(source).toMatch(/sendMontageCopies\(/);
    expect(source).toMatch(/montageCopyNote\(/);
  });

  it("исключения не устарели: файл существует и по-прежнему подходит под признак", () => {
    for (const file of Object.keys(NOT_A_MONTAJER_SEND)) expect(senders.map((s) => s.file)).toContain(file);
  });
});
