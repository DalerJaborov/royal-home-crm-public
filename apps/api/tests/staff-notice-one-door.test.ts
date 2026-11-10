import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ «НЕ ПРИСЫЛАТЬ ТАКОЕ» (владелец 10.11.2026).
 *
 * 1. Сообщение сотруднику в Telegram по почину CRM идёт через
 *    telegram/staffNotice.ts::sendStaffNotice — иначе у него нет вида, кнопки
 *    «🔕 Не присылать такое» и проверки личных отключений. Файл, который пишет в
 *    telegramChatId сотрудника сам, должен быть в списке ниже С ПРИЧИНОЙ. Новый
 *    такой файл без записи — красный прогон.
 * 2. Push CRM без вида (`kind`) человек выключить не может вовсе. Таких вызовов
 *    на 10.11.2026 — PUSH_WITHOUT_KIND_BASELINE; число только убывает: новый
 *    вызов без вида — красный прогон. Снизил — уменьши число здесь.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const ALLOWED_DIRECT_TELEGRAM: Record<string, string> = {
  "lib/loginSmsCode.ts": "код входа — безопасность учётки, выключать нельзя",
  "lib/telegramAgentLink.ts": "ответ на привязку чата, который человек сам начал",
  "lib/telegramModeration.ts": "рабочая очередь модератора с кнопками решения — ответ на его действие",
  "lib/montageObservers.ts": "задание монтажёру и копия наблюдателю — рабочий канал монтажа, не рассылка",
  "lib/videoHandoff.ts": "передача исходников монтажёру — рабочий канал монтажа",
  "lib/narrationDelivery.ts": "файлы озвучки монтажёру — рабочий канал монтажа",
  "lib/somonLeads/sendReserved.ts": "заявка с Somon, закреплённая за агентом: выключить — потерять клиента; отдельное решение владельца",
  "messengers/telegramDirectMessages.ts": "переписка с клиентом, не сотрудник",
  "messengers/telegramGroupComments.ts": "комментарии под постами канала, не личка сотрудника",
  "routes/expenseWorkspace.ts": "выгрузка CSV по кнопке самого человека",
  "telegram/assistantPropertyDraft.ts": "мастер объекта — ответы на действия человека",
  "telegram/assistantStaffPropertyCard.ts": "карточка объекта по просьбе человека",
  "telegram/bot.ts": "ответы на сообщения и кнопки человека",
  "lib/agentSharePost.ts": "через дверь; прямой sendMessage — только «📋 Текст поста» по нажатию",
  "lib/paymentReminders.ts": "через дверь; прямой sendHtmlMessage — ответ на «✅ Оплатил»",
  "telegram/assistantPropertyOffers.ts": "предложение коллеге — через дверь; карточка «кому подходит» — ответ автору на создание объекта",
  "telegram/staffNotice.ts": "сама дверь",
};
const SEND = /\b(?:sendMessage|sendHtmlMessage|sendMessageWithButtons|sendPhotoFromDisk|sendDocumentFile|sendDocument|sendMediaGroupFiles|sendVoice|sendPhoto|sendVideo|sendVideoFromDisk|sendTelegramMessage)\(/;
const PUSH_WITHOUT_KIND_BASELINE = 107;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : files(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

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
  it("файлы, пишущие в Telegram сотрудника мимо двери, — только из списка, с причиной", () => {
    const offenders = files(SRC)
      .filter((p) => {
        const s = fs.readFileSync(p, "utf8");
        return s.includes("telegramChatId") && SEND.test(s);
      })
      .map(rel)
      .filter((p) => !ALLOWED_DIRECT_TELEGRAM[p]);
    expect(offenders, "Шлёте сотруднику по своему почину — через telegram/staffNotice.ts::sendStaffNotice").toEqual([]);
  });

  it("сторож видит прямую отправку (проверка самого сторожа)", () => {
    const planted = `const a = agent.telegramChatId; await sendMessage(a, "x");`;
    expect(planted.includes("telegramChatId") && SEND.test(planted)).toBe(true);
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
