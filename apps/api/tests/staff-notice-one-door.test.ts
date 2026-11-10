import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ «НЕ ПРИСЫЛАТЬ ТАКОЕ» (владелец 10.11.2026, ревью 11.11).
 *
 * 1. Сообщение сотруднику в Telegram по почину CRM идёт через
 *    telegram/staffNotice.ts::sendStaffNotice — иначе у него нет вида, кнопки
 *    «🔕 Не присылать такое» и проверки личных отключений.
 *    Сторож считает ВЫЗОВЫ функций отправки из telegram/api.ts в каждом файле —
 *    по импорту, а не по слову telegramChatId: чат сотрудника приходит и
 *    переменной (`sendMontageCopies(…, (chatId) => sendMessage(chatId, …))`).
 *    Число в списке ниже — точное: новый вызов в любом файле краснит прогон
 *    (решить: через дверь или вписать с причиной), а исчезнувший — тоже
 *    (устаревшая запись не должна молча прикрывать будущий обход).
 * 2. Push CRM без вида (`kind`) человек выключить не может вовсе. Таких вызовов
 *    PUSH_WITHOUT_KIND_BASELINE; число только убывает.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Файл → сколько в нём прямых отправок в Telegram и почему они мимо двери. */
const DIRECT_TELEGRAM_SENDS: Record<string, { calls: number; why: string }> = {
  "telegram/staffNotice.ts": { calls: 2, why: "сама дверь" },
  "lib/paymentReminders.ts": { calls: 1, why: "через дверь; прямая — ответ на нажатое «✅ Оплатил»" },
  "lib/agentSharePost.ts": { calls: 4, why: "пост идёт через дверь (deliver); прямая — «📋 Текст поста» по нажатию" },
  "telegram/assistantPropertyOffers.ts": { calls: 3, why: "предложение коллеге — через дверь (deliver); карточка «кому подходит» — ответ автору" },
  "lib/loginSmsCode.ts": { calls: 1, why: "код входа — безопасность учётки, выключать нельзя" },
  "lib/telegramAgentLink.ts": { calls: 1, why: "ответ на привязку чата, которую человек сам начал" },
  "lib/telegramModeration.ts": { calls: 11, why: "рабочая очередь модератора с кнопками решения" },
  "telegram/clipReviewBot.ts": { calls: 3, why: "ролик на проверку модератору — рабочая очередь" },
  "lib/montageObservers.ts": { calls: 3, why: "задание монтажёру и копия наблюдателю — рабочий канал монтажа" },
  "lib/videoHandoff.ts": { calls: 3, why: "передача исходников монтажёру — рабочий канал монтажа" },
  "lib/videoHandoffStaleAlarm.ts": { calls: 1, why: "копия напоминания монтажа наблюдателям (sendMontageCopies) — рабочий канал монтажа" },
  "lib/narrationDelivery.ts": { calls: 1, why: "файлы озвучки монтажёру — рабочий канал монтажа" },
  "lib/somonLeads/sendReserved.ts": { calls: 2, why: "заявка с Somon за агентом: выключить = потерять клиента; отдельное решение владельца" },
  "lib/askCandidatePhone.ts": { calls: 1, why: "кандидат на вакансию, не сотрудник" },
  "lib/conversationDelivery.ts": { calls: 4, why: "ответ клиенту в его переписке" },
  "lib/photoPosts.ts": { calls: 1, why: "пост в канал компании" },
  "lib/socialPublish.ts": { calls: 1, why: "публикация в канал компании" },
  "messengers/telegramDirectMessages.ts": { calls: 5, why: "переписка с клиентом" },
  "messengers/telegramGroupComments.ts": { calls: 3, why: "комментарии под постами канала" },
  "routes/expenseWorkspace.ts": { calls: 1, why: "выгрузка CSV по кнопке самого человека" },
  "telegram/bot.ts": { calls: 11, why: "ответы на сообщения и кнопки человека" },
  "telegram/assistantBot.ts": { calls: 35, why: "ответы помощницы на просьбу человека" },
  "telegram/assistantDelivery.ts": { calls: 7, why: "доставка ответа помощницы на просьбу" },
  "telegram/assistantVoice.ts": { calls: 6, why: "голосовой ответ на просьбу" },
  "telegram/assistantReadResults.ts": { calls: 3, why: "карточка/список в ответ на просьбу" },
  "telegram/assistantStaffPropertyCard.ts": { calls: 3, why: "карточка объекта по просьбе" },
  "telegram/assistantPropertyDraft.ts": { calls: 30, why: "мастер объекта — ответы на шаги человека" },
  "telegram/assistantConfirmationPhotos.ts": { calls: 2, why: "фото к подтверждению, которое человек запросил" },
  "telegram/assistantExpenseAlbum.ts": { calls: 1, why: "ответ на присланный альбом чеков" },
  "telegram/assistantExpenseBatchIntake.ts": { calls: 5, why: "ответ на присланные расходы" },
  "telegram/assistantExpenseCard.ts": { calls: 6, why: "карточка расходов по просьбе" },
  "telegram/assistantExpenseReceipt.ts": { calls: 4, why: "ответ на присланный чек" },
};
const PUSH_WITHOUT_KIND_BASELINE = 107;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : files(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

/** Вызовы send*-функций, импортированных из telegram/api.ts (с учётом `as`). */
function telegramSendCalls(source: string, file: string): number {
  const names = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const from = m[2]!;
    const fromApi = /(?:^|\/)telegram\/api\.js$/.test(from) || (file.startsWith("telegram/") && from === "./api.js");
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

/** Вызовы sendPushToAgent(s) с литералом без вида (`kind`). Переданную переменную не судим. */
function pushCallsWithoutKind(source: string): number {
  let count = 0;
  const re = /\bsendPushToAgents?\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (/function\s+$/.test(source.slice(Math.max(0, m.index - 20), m.index))) continue;
    let i = m.index + m[0].length;
    for (let depth = 1; i < source.length && depth; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    const call = source.slice(m.index, i);
    if (call.includes("{") && !/\bkind\b|\.\.\./.test(call)) count++;
  }
  return count;
}

describe("одна дверь для сообщений помощницы по её почину", () => {
  const actual: Record<string, number> = Object.fromEntries(
    files(SRC)
      .map((p) => [rel(p), telegramSendCalls(fs.readFileSync(p, "utf8"), rel(p))] as const)
      .filter(([file, n]) => n > 0 && file !== "telegram/api.ts"),
  );

  it("прямые отправки в Telegram — ровно те, что в списке, с причиной", () => {
    const unexpected = Object.entries(actual)
      .filter(([file, n]) => DIRECT_TELEGRAM_SENDS[file]?.calls !== n)
      .map(([file, n]) => `${file}: ${n} (в списке ${DIRECT_TELEGRAM_SENDS[file]?.calls ?? "нет"})`);
    expect(unexpected, "Шлёте сотруднику по своему почину — через telegram/staffNotice.ts::sendStaffNotice; иначе — запись с причиной").toEqual([]);
  });

  it("устаревших записей в списке нет", () => {
    const stale = Object.keys(DIRECT_TELEGRAM_SENDS).filter((file) => !(file in actual));
    expect(stale).toEqual([]);
  });

  it("сторож видит отправку и через переменную, и через псевдоним (проверка самого сторожа)", () => {
    const planted = `import { sendMessage as tg } from "../telegram/api.js";\nsendMontageCopies(id, "x", (chatId) => tg(chatId, "a"));`;
    expect(telegramSendCalls(planted, "lib/x.ts")).toBe(1);
  });

  it("push CRM без вида — не больше, чем было (число только убывает)", () => {
    const total = files(SRC).reduce((sum, p) => sum + pushCallsWithoutKind(fs.readFileSync(p, "utf8")), 0);
    expect(total).toBeLessThanOrEqual(PUSH_WITHOUT_KIND_BASELINE);
  });

  it("счётчик ловит вызов без вида и пропускает с видом (проверка самого сторожа)", () => {
    expect(pushCallsWithoutKind(`sendPushToAgent(id, { title: "a", body: "b" })`)).toBe(1);
    expect(pushCallsWithoutKind(`sendPushToAgent(id, { kind: "task", title: "a", body: "b" })`)).toBe(0);
    expect(pushCallsWithoutKind(`sendPushToAgents(ids, payload)`)).toBe(0);
  });
});
