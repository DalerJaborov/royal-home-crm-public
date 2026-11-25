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

/**
 * Файл правда спрашивает дверь: импорт из lib/botAnswersItself.js и вызов её функции в КОДЕ, а не слово в комментарии
 * (HANDOFF #283, 19.11: прежняя проверка `includes("botAnswersItself")` проходила от одного упоминания в комментарии).
 */
const IMPORTS_DOOR = /import\s*\{[^}]*\}\s*from\s*["'](?:\.\.?\/)+(?:lib\/)?botAnswersItself\.js["']/;
const ASKS_DOOR = /\b(staffSignalAllowed|loadBotAnswersItself|commentNeedsPerson)\s*\(/;
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}
function asksBotAnswersItselfDoor(src: string): boolean {
  const code = withoutComments(src);
  return IMPORTS_DOOR.test(code) && ASKS_DOOR.test(code.replace(IMPORTS_DOOR, ""));
}

/** Сигнал остаётся всегда — и почему (таблица в шапке lib/botAnswersItself.ts). */
const ALWAYS: Record<string, string> = {
  "ai/callAnalysis.ts": "разбор звонков агентов, не клиентский бот",
  "jobs/aiReplyRetry.ts": "техсбой: ИИ не ответил после всех повторов",
  "jobs/telegramReplyRetry.ts": "техсбой: ИИ не ответил после всех повторов (Telegram)",
  "jobs/customerCallbackNotify.ts": "клиент сам просит звонок или человека — это заявка",
  "jobs/customerIntakeNotify.ts": "заявка с номером — агенту",
  "jobs/customerOwnerQuestionNotify.ts": "вопрос по объекту — агенту объекта",
  "jobs/customerShowingNotify.ts": "запись на показ — заявка",
  "jobs/siteResync.ts": "техсбой синхронизации сайта",
  "lib/channelKeyAlarm.ts": "техсбой: ключ канала умер (401)",
  "lib/channelVolumeWatch.ts": "техсбой: канал почти не приносит новых обращений (вебхук, подписка, токен), не ответ бота",
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
      return CALLS_PEOPLE.test(withoutComments(text)) && !asksBotAnswersItselfDoor(text) && !(file in ALWAYS);
    });
    expect(offenders).toEqual([]);
  });

  it("сторож не обходится словом: упоминание двери в комментарии или один импорт — не вопрос к двери", () => {
    const push = `await sendPushToAgents(ids, { title: "x" });`;
    expect(asksBotAnswersItselfDoor(`// botAnswersItself: тут не нужно\n${push}`)).toBe(false);
    expect(asksBotAnswersItselfDoor(`/* см. lib/botAnswersItself.ts, staffSignalAllowed() */\n${push}`)).toBe(false);
    expect(asksBotAnswersItselfDoor(`import { loadBotAnswersItself } from "../lib/botAnswersItself.js";\n${push}`)).toBe(false);
    expect(asksBotAnswersItselfDoor(`import { staffSignalAllowed } from "../lib/botAnswersItself.js";\n` +
      `if (staffSignalAllowed({ on: true, kind: "technical" })) ${push}`)).toBe(true);
  });

  it("список исключений не врёт: каждый файл из него существует и действительно зовёт людей", () => {
    const files = new Set(scopedFiles());
    for (const file of Object.keys(ALWAYS)) {
      expect(files.has(file), file).toBe(true);
      expect(CALLS_PEOPLE.test(readFileSync(join(SRC, file), "utf8")), file).toBe(true);
    }
  });

  /**
   * Одна дверь чтения на ВСЕ три рубильника (ревью #283, 20.11): «бот отвечает сам», «номер под постом: заявка», «...:
   * разговор». Читать — select `поле: true` или чтение поля строки настроек `.поле` — можно только в lib/botAnswersItself.ts.
   * Запись (routes/settings.ts, схема Zod `поле: z.boolean()`) — не чтение.
   */
  it.each(["botAnswersItself", "botCommentPhoneLead", "botCommentPhoneConversation"])("настройку %s читает одна дверь — lib/botAnswersItself.ts", (field) => {
    const readers: string[] = [];
    const read = new RegExp(`\\b${field}\\s*:\\s*true|\\.${field}\\b`);
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { if (entry.name !== "generated") walk(rel); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        if (read.test(withoutComments(readFileSync(join(SRC, rel), "utf8")))) readers.push(rel);
      }
    };
    for (const dir of ["lib", "messengers", "ai", "jobs", "routes", "services", "telegram"]) walk(dir);
    expect(readers).toEqual(["lib/botAnswersItself.ts"]);
  });

  /**
   * Рубильник заявки по номеру из комментария (ревью #283, 20.11): каждая из трёх дверей messengers/commentPhoneLead.ts
   * спрашивает его САМА — новый вызывающий не может завести карточку по комментарию мимо рубильника.
   */
  it("каждая дверь номера из комментария спрашивает рубильник заявки", () => {
    const src = readFileSync(join(SRC, "messengers/commentPhoneLead.ts"), "utf8");
    for (const door of ["captureCommentPhoneIntoConversation", "attachCommentPhonesToCard", "createLeadFromCommentPhone"]) {
      const start = src.indexOf(`export async function ${door}(`);
      expect(start, door).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport ", start + 10);
      const body = withoutComments(src.slice(start, next === -1 ? undefined : next));
      expect(body, door).toMatch(/await loadCommentPhoneLead\(\)/);
      const gate = body.indexOf("loadCommentPhoneLead(");
      for (const effect of ["acceptLead(", "createLeadFromChannel(", "claimCommentPhone(", "prisma."]) {
        const at = body.indexOf(effect);
        if (at !== -1) expect(gate, `${door}: ${effect} до проверки рубильника`).toBeLessThan(at);
      }
    }
  });
});
