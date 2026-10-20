import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { DEDUP_TEXT_LEN } from "../src/lib/systemError.js";

/**
 * E11 глубокой проверки 02.10.2026: журнал ошибок склеивает повторы по началу
 * текста (DEDUP_TEXT_LEN символов) или по явному ключу, и ПЕРВЫЙ случай нового
 * вида будит директоров пушем «Новая проблема в CRM». Если в начале текста
 * стоит имя файла записи, id звонка или имя клиента — или ключ сам собран из
 * id записи, — каждый случай считается новой проблемой. Сломалась запись
 * разговоров: 60 звонков за день — 60 пушей каждому директору.
 *
 * Сторож для файлов фона и станции: переменная часть в начале текста — только
 * с постоянным ключом вида ошибки; ключ не собирается из id записи.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const FILES = [
  "lib/telephony/callRecordings.ts",
  "lib/telephony/callTracker.ts",
  "lib/telephony/voicemailIngest.ts",
  "lib/telephony/deskTransfer.ts",
  "lib/telephony/agentMobileFallback.ts",
  "lib/telephony/extensionPool.ts",
  "lib/telephony/propertyWhisper.ts",
  "lib/telephony/ariEvents.ts",
  "lib/telephony/stationHealth.ts",
  "jobs/deferredPush.ts",
  "jobs/videoHandoffPublish.ts",
  "jobs/dealCloseFollowup.ts",
];

/** Ключ из id отдельной записи — уникален на каждый случай. */
const PER_RECORD = /(?:\.id\b|interactionId|vm\.name)/;

function problems(file: string): string[] {
  const text = fs.readFileSync(path.join(SRC, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "logSystemError") {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const [, message, context] = node.arguments;
      let key: ts.Expression | undefined;
      if (context && ts.isObjectLiteralExpression(context)) {
        for (const p of context.properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "dedupKey") key = p.initializer;
        }
      }
      const variableEarly =
        message &&
        ((ts.isTemplateExpression(message) && message.head.text.length < DEDUP_TEXT_LEN) || ts.isBinaryExpression(message));
      if (variableEarly && !key) out.push(`${file}:${line} — переменная часть в начале текста без ключа`);
      if (key && ts.isTemplateExpression(key) && PER_RECORD.test(key.getText(sf))) {
        out.push(`${file}:${line} — ключ собран из id записи: ${key.getText(sf)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("журнал ошибок фона и станции: один вид поломки — одна запись и один пуш", () => {
  it("переменные данные не ломают склейку повторов", () => {
    expect(FILES.flatMap(problems)).toEqual([]);
  });
});

/**
 * Тревога сводной проверки телефонии (stationHealth.ts, raiseAlert) сама шлёт
 * директорам пуш и ещё пишет в журнал — а первая запись нового вида будила их
 * вторым пушем «Новая проблема». Правило «одно событие — одно уведомление»:
 * вызывающий, который уже оповестил сам, пишет в журнал без пуша.
 */
describe("журнал без второго пуша, когда вызывающий уже оповестил сам", () => {
  it("silent: запись ложится, крючок «новая проблема» не зовётся", async () => {
    const { prisma } = await import("../src/db.js");
    const { logSystemError, onNewSystemError } = await import("../src/lib/systemError.js");
    const hooked: string[] = [];
    onNewSystemError((_source, message) => hooked.push(message));
    const key = `тест-тихая-тревога-${Date.now()}`;
    await logSystemError("telephony", `${key}: станция не отвечает`, { dedupKey: key, silent: true });
    const row = await prisma.errorLog.findFirst({ where: { dedupKey: key } });
    expect(row).not.toBeNull();
    expect(hooked).toEqual([]);
    await prisma.errorLog.deleteMany({ where: { dedupKey: key } });
  });

  it("raiseAlert пишет в журнал без второго пуша", () => {
    const text = fs.readFileSync(path.join(SRC, "lib/telephony/stationHealth.ts"), "utf8");
    const body = text.slice(text.indexOf("async function raiseAlert"), text.indexOf("export interface StationHealthTickResult"));
    expect(body).toMatch(/logSystemError\([^)]*silent: true/s);
  });
});
