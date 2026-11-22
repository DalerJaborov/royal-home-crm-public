import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ СОСТОЯНИЯ РАЗГОВОРА ПОМОЩНИЦЫ (повторное ревью волны 2 «Шабнам», 22.11.2026).
 *
 * В строке `TelegramDialogState` (kind "assistant") лежат история, `sent`, `expenseMemory`, `expenseFix`,
 * `expenseFile`, `lastUserTurn`. Писатель, который собирает payload заново или пишет прочитанное без замка,
 * стирает чужие поля (так пропадали запомненные фото и вопрос про файл). Поэтому запись — только через
 * `telegram/assistantDialogState.ts` (слияние под замком строки).
 *
 * Сторож считает в каждом файле `apps/api/src` обращения к `telegramDialogState`, кроме чтения
 * (`findUnique`/`findFirst`/`findMany`/`count`), и сырой SQL `INSERT/UPDATE/DELETE "TelegramDialogState"`.
 * Число в списке — точное: новый писатель в любом файле краснит прогон (через дверь или вписать с причиной),
 * исчезнувший — тоже (устаревшая запись не должна молча прикрывать будущий обход).
 * Слепое пятно: запись через псевдоним (`const t = prisma.telegramDialogState`) — псевдоним сам считается
 * обращением, поэтому тоже краснит.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Файл → сколько прямых записей и почему мимо двери. Файлы помощницы (kind "assistant") сюда не вписывать. */
const DIRECT_DIALOG_WRITES: Record<string, { writes: number; why: string }> = {
  "telegram/assistantDialogState.ts": { writes: 4, why: "сама дверь: заготовка строки, запись, уборка заготовки, «/new»" },
  "lib/telegramModeration.ts": { writes: 3, why: "свой вид разговора: вопрос модератору" },
  "lib/narrationVoicelessCopy.ts": { writes: 2, why: "свой вид разговора: монтажёр, копия без голоса" },
  "telegram/clipReviewBot.ts": { writes: 3, why: "свой вид разговора: комментарий к возврату ролика" },
  "telegram/montajerReceive.ts": { writes: 4, why: "свои виды разговора: приём ролика и выбор «без голоса»" },
  "telegram/assistantPropertyDraft.ts": { writes: 4, why: "свой вид разговора: мастер объекта под своим замком черновика" },
};

const READ_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count"]);

/** Прямые записи состояния разговора в исходнике. Экспорт ради самопроверки сторожа ниже. */
export function dialogStateWrites(source: string): number {
  let count = 0;
  for (const m of source.matchAll(/\btelegramDialogState\b(?:\s*\.\s*(\w+))?/g)) {
    if (!m[1] || !READ_METHODS.has(m[1])) count++;
  }
  // Сырой SQL: и со схемой (`public."TelegramDialogState"`), и с экранированными кавычками в строке ($executeRawUnsafe).
  count += [...source.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:\\?"?public\\?"?\.)?\\?"?TelegramDialogState\b/gi)].length;
  return count;
}

/** Разовые скрипты API тоже пишут в базу прода — проверяем их вместе с `src` (пути с префиксом `scripts/`). */
const SCRIPTS = path.resolve(SRC, "../scripts");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" || e.name === "node_modules" ? [] : files(p);
    return /\.(?:ts|mts|js|mjs)$/.test(p) ? [p] : [];
  });
}
const rel = (p: string) => p.startsWith(SCRIPTS + path.sep)
  ? `scripts/${path.relative(SCRIPTS, p).split(path.sep).join("/")}`
  : path.relative(SRC, p).split(path.sep).join("/");
const allFiles = () => [...files(SRC), ...(fs.existsSync(SCRIPTS) ? files(SCRIPTS) : [])];

describe("состояние разговора помощницы пишется только через одну дверь", () => {
  it("сторож ловит прямую запись, сырой SQL и псевдоним, а чтение пропускает", () => {
    expect(dialogStateWrites(`await prisma.telegramDialogState.findUnique({ where: { chatId } });`)).toBe(0);
    expect(dialogStateWrites(`await prisma.telegramDialogState.upsert({ where: { chatId }, create, update });`)).toBe(1);
    expect(dialogStateWrites(`await tx.telegramDialogState\n  .update({ where: { chatId }, data });`)).toBe(1);
    expect(dialogStateWrites(`await tx.$executeRaw\`UPDATE "TelegramDialogState" SET payload = ...\`;`)).toBe(1);
    expect(dialogStateWrites(`const t = prisma.telegramDialogState; await t.update({});`)).toBe(1);
    expect(dialogStateWrites(`await tx.$executeRaw\`DELETE FROM public."TelegramDialogState" WHERE 1=1\`;`)).toBe(1);
    expect(dialogStateWrites(`await prisma.$executeRawUnsafe("UPDATE \\"TelegramDialogState\\" SET payload = '{}'");`)).toBe(1);
    expect(dialogStateWrites(`await tx.$queryRaw\`SELECT 1 FROM "TelegramDialogState" FOR UPDATE\`;`)).toBe(0);
  });

  it("прямых записей ровно столько, сколько вписано с причиной", () => {
    const actual = Object.fromEntries(
      allFiles().map((p) => [rel(p), dialogStateWrites(fs.readFileSync(p, "utf8"))] as const).filter(([, n]) => n > 0),
    );
    const expected = Object.fromEntries(Object.entries(DIRECT_DIALOG_WRITES).map(([file, { writes }]) => [file, writes]));
    expect(actual).toEqual(expected);
  });

  it("файлы помощницы не пишут состояние сами — только через дверь", () => {
    const offenders = allFiles()
      .map((p) => ({ file: rel(p), source: fs.readFileSync(p, "utf8") }))
      .filter(({ file, source }) => file !== "telegram/assistantDialogState.ts"
        && /kind\s*(?:===|!==|:)\s*["']assistant["']|DIALOG_KIND\s*=\s*["']assistant["']/.test(source)
        && dialogStateWrites(source) > 0
        && file !== "telegram/assistantPropertyDraft.ts")
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
