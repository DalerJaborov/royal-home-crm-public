import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ «ОДИН ДЕЖУРНЫЙ» (28.11.2026): код в src/lib, src/jobs, src/messengers и src/ai не читает
 * Settings.callbackOperatorAgentId напрямую, кроме dutyOperator.ts и явного списка исключений с причиной.
 * Новый читатель обходит правило «человек один» (номер переадресации, потом запасной) и рано или поздно
 * приведёт к «уведомили одного, зазвонил другой».
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ROOTS = ["lib", "jobs", "messengers", "ai"];

const ALLOWED: Record<string, string> = {
  "lib/telephony/dutyOperator.ts": "единственная дверь",
  "lib/agentSettingsCleanup.ts": "очистка настройки при увольнении сотрудника, не выбор дежурного",
  "lib/settingsSnapshots.ts": "список полей для снимков настроек",
  "lib/telephony/consultantCallbackTarget.ts": "своя цепочка выбора: сначала liveVoiceTransferAgentId, потом дежурный; перевод на dutyOperator отдельной задачей",
  "lib/telephony/liveCallTransfer.ts": "своя цепочка выбора перевода живого звонка (liveVoiceTransferAgentId раньше дежурного); перевод на dutyOperator отдельной задачей",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "generated" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("callbackOperatorAgentId читает только dutyOperator.ts", () => {
  it("нет новых прямых читателей", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(SRC, root))) {
        const rel = relative(SRC, file).replaceAll("\\", "/");
        if (ALLOWED[rel]) continue;
        const code = readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .join("\n");
        if (code.includes("callbackOperatorAgentId")) offenders.push(rel);
      }
    }
    expect(offenders, "Берите дежурного через lib/telephony/dutyOperator.ts (loadDutyOperator / loadDutyAgentId)").toEqual([]);
  });

  it("список исключений не врёт: каждый файл из него существует и действительно читает поле", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(readFileSync(join(SRC, rel), "utf8")).toContain("callbackOperatorAgentId");
    }
  });
});
