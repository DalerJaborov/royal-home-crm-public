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
 * видел никогда.
 *
 * Признак — ФАКТИЧЕСКИЕ вызовы отправки (ревью #348), а не упоминания: файл (1) берёт чат монтажёра
 * (`editor.telegramChatId`, `montajer….telegramChatId`, `usableMontajerWhere`, `videoMontajerAgentId`) и
 * (2) сам вызывает функцию отправки из telegram/api.ts. Такой файл обязан звать общую дверь копий
 * (sendMontageCopies или sendToMontajer). Исключения — только с причиной ниже.
 */
// Чтение исходников: база не нужна (setup.ts без настоящей базы ничего не сбрасывает).
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Берут чат монтажёра и шлют в Telegram, но монтажёру по своему почину не пишут. */
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

/** Число вызовов send*-функций, импортированных из telegram/api.ts (с учётом `as`) — тот же счёт, что у staff-notice-one-door. */
function telegramSendCalls(source: string, file: string): number {
  const names = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const fromApi = /(?:^|\/)telegram\/api\.js$/.test(m[2]!) || (file.startsWith("telegram/") && m[2] === "./api.js");
    if (!fromApi) continue;
    for (const part of m[1]!.split(",")) {
      const [orig, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (orig && /^send/.test(orig)) names.add((alias ?? orig).trim());
    }
  }
  let count = 0;
  for (const name of names) count += [...source.matchAll(new RegExp(String.raw`\b${name}\(`, "g"))].length;
  return count;
}
const READS_MONTAJER_CHAT = /\b(?:editor|montajer\w*)\??\.telegramChatId\b|\busableMontajerWhere\(|\bvideoMontajerAgentId\b/;
const CALLS_COPY_DOOR = /\bsendMontageCopies\(|\bsendToMontajer\(/;

describe("дверь копий монтажа: всё, что уходит монтажёру, видит наблюдатель", () => {
  const senders = files(SRC)
    .map((p) => ({ file: rel(p), source: fs.readFileSync(p, "utf8") }))
    .filter(({ file, source }) => file !== "telegram/api.ts" && READS_MONTAJER_CHAT.test(source) && telegramSendCalls(source, file) > 0);

  it("каждый файл, который сам шлёт в чат монтажёра, зовёт sendMontageCopies или sendToMontajer", () => {
    const bypass = senders
      .filter(({ file }) => !NOT_A_MONTAJER_SEND[file] && file !== "lib/montageObservers.ts")
      .filter(({ source }) => !CALLS_COPY_DOOR.test(source))
      .map(({ file }) => file);
    expect(bypass).toEqual([]);
  });

  it("признак видит настоящую отправку озвучки монтажёру (иначе сторож молчал бы всегда)", () => {
    expect(senders.map((s) => s.file)).toContain("lib/narrationDelivery.ts");
    const source = fs.readFileSync(path.join(SRC, "lib/narrationDelivery.ts"), "utf8");
    expect(source).toMatch(/copyNarrationToObservers\(/);
    expect(source).toMatch(/montageCopyNote\(/);
  });

  it("признак срабатывает на вызов, а не на упоминание", () => {
    const file = "lib/fake.ts";
    const imported = `import { sendDocumentFile } from "../telegram/api.js";\n`;
    expect(telegramSendCalls(`${imported}// sendDocumentFile — упоминание в комментарии без скобок`, file)).toBe(0);
    expect(telegramSendCalls(`${imported}await sendDocumentFile(editor.telegramChatId, file);`, file)).toBe(1);
    expect(telegramSendCalls(`import { sendDocumentFile as sendDoc } from "../telegram/api.js";\nawait sendDoc(chatId, f);`, file)).toBe(1);
  });

  it("исключения не устарели: файл существует и по-прежнему подходит под признак", () => {
    for (const file of Object.keys(NOT_A_MONTAJER_SEND)) expect(senders.map((s) => s.file)).toContain(file);
  });
});
