import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import { NO_CONTACT_TEXT, noContactTileTone } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { INCOMING_CALL_NOTE_PREFIX, noContactWhere } from "../src/lib/noContact.js";
import { inboundCallNotePrefix } from "../src/lib/telephony/callSource.js";

/**
 * «НЕ СВЯЗЫВАЛИСЬ» — ОДНО ПРАВИЛО (17.11.2026, жалоба РОП Нозы: «Пятьдесят без
 * контактов пишет. Хотя я звоню им, этим клиентам, с ними общаюсь»).
 *
 * В счётчике — только клиенты, с которыми сотрудник НИ РАЗУ не связывался. Любая
 * попытка звонка (даже «не ответил»), состоявшийся входящий, сообщение сотрудника,
 * показ — и клиент из счётчика уходит навсегда, сколько бы дней ни прошло. Ответы бота,
 * заметки, пропущенный входящий и «агент сам не снял трубку» связью не считаются.
 */

const DAY = 24 * 60 * 60 * 1000;
const runId = Date.now();
const tail = String(runId).slice(-7);
const now = new Date();
const old = new Date(now.getTime() - 90 * DAY);
const recent = new Date(now.getTime() - 60 * 60 * 1000);
let agentId = "";
const ids: Record<string, string> = {};

describe("подписи и цвет — packages/shared", () => {
  it("красный только когда число больше нуля", () => {
    expect(noContactTileTone(0)).toBe("calm");
    expect(noContactTileTone(1)).toBe("crit");
    expect(NO_CONTACT_TEXT.zero).toBe("со всеми связывались");
    expect(NO_CONTACT_TEXT.tile).toBe("не связывались");
  });
});

describe("сторож: пропущенный входящий узнаётся по началу записи", () => {
  it("каждое примечание входящего звонка в incomingCalls.ts начинается с INCOMING_CALL_NOTE_PREFIX", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/lib/telephony/incomingCalls.ts", import.meta.url)), "utf8");
    const start = src.indexOf("notes: byConsultant");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf("/**", start));
    const literals = [...block.matchAll(/[`"](Входящ[^`"]*|[А-ЯЁ][^`"]{10,}|\$\{[^`"]*)[`"]/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThanOrEqual(5);
    // С 18.11.2026 начало строки собирает callSource.ts::inboundCallNotePrefix («…из WhatsApp»
    // дописывается после): шаблон обязан начинаться с переменной, взятой из этой функции.
    const prefixVars = [...src.matchAll(/const (\w+) = inboundCallNotePrefix\(/g)].map((m) => m[1]);
    for (const text of literals) {
      const viaHelper = prefixVars.some((v) => text.startsWith(`\${${v}}`));
      expect(viaHelper || text.startsWith(INCOMING_CALL_NOTE_PREFIX)).toBe(true);
    }
    for (const source of ["phone", "whatsapp", undefined]) {
      expect(inboundCallNotePrefix(source, true).startsWith(INCOMING_CALL_NOTE_PREFIX)).toBe(true);
      expect(inboundCallNotePrefix(source, false).startsWith(INCOMING_CALL_NOTE_PREFIX)).toBe(true);
    }
  });
});

describe("выборка сервера (lib/noContact.ts)", () => {
  beforeAll(async () => {
    agentId = (
      await prisma.agent.create({
        data: { fullName: `Не связывались ${runId}`, phone: `+992941${tail}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 4) },
      })
    ).id;
    let n = 10;
    const mk = async (key: string, data: Record<string, unknown> = {}) => {
      const c = await prisma.client.create({
        data: {
          fullName: `Не связывались ${key} ${runId}`,
          phone: `+9929${n++}${tail}`,
          source: "PHONE_CALL",
          kind: "BUYER",
          assignedAgentId: agentId,
          acceptedAt: old,
          createdAt: old,
          ...data,
        },
      });
      ids[key] = c.id;
      return c.id;
    };
    const call = (clientId: string, data: Record<string, unknown>) =>
      prisma.interaction.create({ data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM", ...data } });

    await mk("never");
    await mk("brandNew", { createdAt: recent, acceptedAt: null });
    await call(await mk("oneNoAnswer"), { callAttempt: "NO_ANSWER" });
    await call(await mk("cancelled"), { callAttempt: "CANCELLED" });
    await call(await mk("talked60dAgo"), { callAttempt: "TALKED", recordingDurationSec: 90, createdAt: new Date(now.getTime() - 60 * DAY) });
    await call(await mk("agentNoPickup"), { callAttempt: "AGENT_NO_PICKUP" });
    await call(await mk("missedIncoming"), { callAttempt: null, notes: "Входящий звонок клиента: до оператора не дозвонился" });
    await prisma.interaction.create({
      data: { clientId: await mk("answeredIncoming"), actorKind: "SYSTEM", agentId: null, type: "CALL", notes: "Входящий звонок клиента: поговорил с оператором, 1:20", callAttempt: "TALKED", recordingDurationSec: 80 },
    });
    await call(await mk("manualCall"), { callAttempt: null, outsideCrm: true, notes: "Связался со своего телефона, договорились" });
    await prisma.interaction.create({ data: { clientId: await mk("onlyNote", { lastContactAt: recent }), agentId, type: "MESSAGE", notes: "Заметка агента" } });
    await prisma.interaction.create({ data: { clientId: await mk("showing"), agentId, type: "SHOWING", notes: "Показ" } });
    await prisma.interaction.create({
      data: { clientId: await mk("botShowing"), actorKind: "BOT", agentId: null, type: "SHOWING", notes: "Бот записал на показ" },
    });

    const conv = (clientId: string, key: string, messages: unknown[]) =>
      prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `nc-${key}-${runId}`, clientId, messages: messages as object[] } });
    const userMsg = { role: "user", content: "Здравствуйте, есть двушка?", at: recent.toISOString() };
    await conv(await mk("onlyBotReplied", { lastClientMessageAt: recent }), "bot", [
      userMsg,
      { role: "assistant", content: "Здравствуйте! Подберу варианты.", at: recent.toISOString() },
      { role: "assistant", content: "Есть две квартиры.", by: { kind: "bot" }, at: recent.toISOString() },
    ]);
    await conv(await mk("staffMessage", { lastClientMessageAt: recent }), "staff", [
      userMsg,
      { role: "assistant", content: "Это Ноза, сейчас перезвоню.", by: { kind: "agent", agentId, agentName: "Агент" }, at: recent.toISOString() },
    ]);
    await prisma.telegramConversation.create({
      data: {
        chatId: `nc-tg-${runId}`,
        clientId: await mk("telegramManual"),
        messages: [{ role: "assistant", content: "Ответила из Telegram", by: { kind: "manual" } }],
      },
    });
    await mk("attemptMark", { lastAgentAttemptAt: old });
  });

  afterAll(async () => {
    const clientIds = Object.values(ids);
    await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.telegramConversation.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
  });

  it("в счётчике ровно те, с кем ни разу не связывались", async () => {
    const rows = await prisma.client.findMany({ where: { AND: [noContactWhere(), { assignedAgentId: agentId }] }, select: { id: true } });
    const found = new Set(rows.map((r) => r.id));
    const inCounter = (key: string) => found.has(ids[key]);

    // Попадают:
    expect(inCounter("never")).toBe(true); // ни одной попытки
    expect(inCounter("brandNew")).toBe(true); // свежая карточка — сразу, без ожидания суток
    expect(inCounter("onlyBotReplied")).toBe(true); // ответил только бот
    expect(inCounter("agentNoPickup")).toBe(true); // агент сам не снял трубку — до клиента не дошло
    expect(inCounter("missedIncoming")).toBe(true); // клиент звонил, а до нас не дозвонился
    expect(inCounter("onlyNote")).toBe(true); // заметка и свежий lastContactAt — не связь
    expect(inCounter("botShowing")).toBe(true); // показ записал бот, а не сотрудник

    // Не попадают никогда:
    expect(inCounter("oneNoAnswer")).toBe(false); // один неотвеченный звонок — уже связывались
    expect(inCounter("cancelled")).toBe(false); // сбросили, пока у клиента звонило
    expect(inCounter("talked60dAgo")).toBe(false); // звонок 60 дней назад — срока нет
    expect(inCounter("answeredIncoming")).toBe(false); // состоявшийся входящий
    expect(inCounter("manualCall")).toBe(false); // «связался со своего телефона»
    expect(inCounter("showing")).toBe(false); // показ сотрудника
    expect(inCounter("staffMessage")).toBe(false); // ручное сообщение сотрудника из CRM
    expect(inCounter("telegramManual")).toBe(false); // ответ сотрудника прямо в Telegram
    expect(inCounter("attemptMark")).toBe(false); // отметка «агент пытался» (lastAgentAttemptAt)
  });

  it("сводка экрана «Клиенты» отдаёт то же число в поле neverContacted", async () => {
    const count = await prisma.client.count({ where: { AND: [noContactWhere(), { assignedAgentId: agentId }] } });
    expect(count).toBe(7);
  });
});
