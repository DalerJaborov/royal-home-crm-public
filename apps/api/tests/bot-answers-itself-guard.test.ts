import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ «БОТ ОТВЕЧАЕТ САМ» (18.11.2026, lib/botAnswersItself.ts). Файл клиентского бота, который зовёт людей пушем
 * (sendPushToAgent(s) / enqueueDirectorAlert), обязан спросить дверь «Бот отвечает сам» — или стоять в списке ниже с
 * причиной, почему его сигнал остаётся при любой настройке. Новый способ позвать руководство мимо двери ломает этот тест.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const SCOPE: Array<{ dir: string; match: RegExp }> = [
  { dir: "messengers", match: /\.ts$/ },
  { dir: "ai", match: /\.ts$/ },
  { dir: "jobs", match: /\.ts$/ },
  { dir: "lib", match: /^(customer|client|channel|comment|leadOnly)[^/]*\.ts$/ },
];
const CALLS_PEOPLE = /\b(sendPushToAgents?|enqueueDirectorAlert)\(/;

/** Сигнал остаётся всегда — и почему (таблица в шапке lib/botAnswersItself.ts). */
const ALWAYS: Record<string, string> = {
  "ai/botAudit.ts": "автоаудитор качества бота — сотрудникам о боте, не о клиенте",
  "ai/callAnalysis.ts": "разбор звонков агентов, не клиентский бот",
  "jobs/aiReplyRetry.ts": "техсбой: ИИ не ответил после всех повторов",
  "jobs/telegramReplyRetry.ts": "техсбой: ИИ не ответил после всех повторов (Telegram)",
  "jobs/customerCallbackNotify.ts": "клиент сам просит звонок или человека — это заявка",
  "jobs/customerIntakeNotify.ts": "заявка с номером — агенту",
  "jobs/customerOwnerQuestionNotify.ts": "вопрос по объекту — агенту объекта",
  "jobs/customerShowingNotify.ts": "запись на показ — заявка",
  "jobs/siteResync.ts": "техсбой синхронизации сайта",
  "lib/channelKeyAlarm.ts": "техсбой: ключ канала умер (401)",
  "lib/clientDeleteRequest.ts": "работа с карточкой в CRM, не бот",
  "lib/clientLifecycle.ts": "работа с карточкой в CRM, не бот",
  "lib/clientMerge.ts": "работа с карточкой в CRM, не бот",
  "lib/clientMessageAlert.ts": "агенту — о сообщении ЕГО клиента",
  "lib/clientRefuse.ts": "работа с карточкой в CRM, не бот",
  "lib/clientToCandidate.ts": "работа с карточкой в CRM, не бот",
  "lib/clientTransfer.ts": "работа с карточкой в CRM, не бот",
  "lib/clientTrashAnomalyAlarm.ts": "техсбой: аномалия корзины",
  "lib/customerAgentRevisionAlert.ts": "техсбой: настройка ядра бота",
  "lib/customerRecruitmentAlert.ts": "вакансия — рекрутеру (его путь не меняется)",
  "lib/leadOnlyHandover.ts": "заявка с номером не дошла до агента — сбой заявки",
};

function scopedFiles(): string[] {
  const out: string[] = [];
  for (const { dir, match } of SCOPE) {
    for (const name of readdirSync(join(SRC, dir))) if (match.test(name)) out.push(`${dir}/${name}`);
  }
  return out;
}

describe("сторож: зовут руководство только через дверь «Бот отвечает сам»", () => {
  it("каждый файл бота с пушем людям спрашивает lib/botAnswersItself.ts или объяснён в списке", () => {
    const offenders = scopedFiles().filter((file) => {
      const text = readFileSync(join(SRC, file), "utf8");
      return CALLS_PEOPLE.test(text) && !text.includes("botAnswersItself") && !(file in ALWAYS);
    });
    expect(offenders).toEqual([]);
  });

  it("список исключений не врёт: каждый файл из него существует и действительно зовёт людей", () => {
    const files = new Set(scopedFiles());
    for (const file of Object.keys(ALWAYS)) {
      expect(files.has(file), file).toBe(true);
      expect(CALLS_PEOPLE.test(readFileSync(join(SRC, file), "utf8")), file).toBe(true);
    }
  });

  it("настройку читает одна дверь: botAnswersItself из Settings — только lib/botAnswersItself.ts", () => {
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { if (entry.name !== "generated") walk(rel); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        if (/botAnswersItself\s*:\s*true/.test(readFileSync(join(SRC, rel), "utf8"))) readers.push(rel);
      }
    };
    for (const dir of ["lib", "messengers", "ai", "jobs", "routes", "services"]) walk(dir);
    expect(readers).toEqual(["lib/botAnswersItself.ts"]);
  });
});
