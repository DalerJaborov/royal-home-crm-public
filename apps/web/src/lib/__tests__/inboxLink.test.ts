import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inboxOpenHref } from "../inboxLink";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("ссылка на диалог в «Сообщениях»", () => {
  it("диалог Instagram/WhatsApp открывается по id", () => {
    expect(inboxOpenHref("BOT", "abc")).toBe("/messages?open=abc");
  });

  it("Telegram — с префиксом tg_, иначе раздел его не найдёт", () => {
    expect(inboxOpenHref("TELEGRAM", "abc")).toBe("/messages?open=tg_abc");
  });

  it("никто не ведёт на ?conversation= — раздел этот параметр не читает и открывает чужой диалог (23.09.2026)", () => {
    const offenders = sourceFiles(SRC).filter((f) => fs.readFileSync(f, "utf8").includes("/messages?conversation="));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
