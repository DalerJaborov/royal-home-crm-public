import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { NO_CONTACT_AFTER_DAYS, isWithoutContact } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { noContactWhere } from "../src/lib/noContact.js";

/**
 * «БЕЗ КОНТАКТА» — ОДНО ПРАВИЛО (владелец 16.11.2026). Тест прибивает правило с
 * обеих сторон: чистая функция в packages/shared и выборка сервера (lib/noContact.ts)
 * обязаны отвечать одинаково.
 *   • сообщение клиента в чате (в том числе боту) — контакт;
 *   • заметка/задача агента — НЕ контакт, даже если сдвинула lastContactAt;
 *   • разговор по телефону — контакт; недозвон — нет;
 *   • новая карточка без контакта считается от создания, lastContactAt не спасает.
 */

const DAY = 24 * 60 * 60 * 1000;
const runId = Date.now();
const now = new Date();
const old = new Date(now.getTime() - (NO_CONTACT_AFTER_DAYS + 2) * DAY);
const recent = new Date(now.getTime() - 60 * 60 * 1000);
let agentId = "";
const ids: Record<string, string> = {};

describe("правило в packages/shared", () => {
  it("сообщение клиента боту — контакт", () => {
    expect(isWithoutContact({ createdAt: old, lastClientMessageAt: recent }, now)).toBe(false);
  });
  it("разговор по телефону — контакт", () => {
    expect(isWithoutContact({ createdAt: old, lastTalkedCallAt: recent }, now)).toBe(false);
  });
  it("заметки агента в правило не входят вовсе: старая карточка без звонка и сообщения — без контакта", () => {
    expect(isWithoutContact({ createdAt: old }, now)).toBe(true);
  });
  it("новая карточка считается от создания: свежая ещё нет, после порога — да", () => {
    expect(isWithoutContact({ createdAt: recent }, now)).toBe(false);
    expect(isWithoutContact({ createdAt: old }, now)).toBe(true);
  });
});

describe("выборка сервера совпадает с правилом", () => {
  beforeAll(async () => {
    agentId = (
      await prisma.agent.create({
        data: { fullName: `Без контакта ${runId}`, phone: `+992941${String(runId).slice(-7)}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 4) },
      })
    ).id;
    const mk = async (key: string, n: number, data: Record<string, unknown> = {}) => {
      const c = await prisma.client.create({
        data: {
          fullName: `Без контакта ${key} ${runId}`,
          phone: `+99294${n}${String(runId).slice(-7)}`,
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
    await mk("silent", 2);
    await mk("botChat", 3, { lastClientMessageAt: recent });
    const noteId = await mk("onlyNote", 4, { lastContactAt: recent });
    await prisma.interaction.create({ data: { clientId: noteId, agentId, type: "MESSAGE", notes: "Заметка агента" } });
    const talkedId = await mk("talked", 5);
    await prisma.interaction.create({ data: { clientId: talkedId, agentId, type: "CALL", notes: "Разговор", callAttempt: "TALKED", recordingDurationSec: 60 } });
    const missedId = await mk("noAnswer", 6);
    await prisma.interaction.create({ data: { clientId: missedId, agentId, type: "CALL", notes: "Не дозвонился", callAttempt: "NO_ANSWER" } });
    await mk("brandNew", 7, { createdAt: recent, acceptedAt: recent });
  });

  afterAll(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: { in: Object.values(ids) } } });
    await prisma.client.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
  });

  it("в выборке ровно те, кого правило считает «без контакта»", async () => {
    const rows = await prisma.client.findMany({
      where: { AND: [noContactWhere(now), { assignedAgentId: agentId }] },
      select: { id: true },
    });
    const found = new Set(rows.map((r) => r.id));
    expect(found.has(ids.silent)).toBe(true);
    expect(found.has(ids.onlyNote)).toBe(true); // заметка и свежий lastContactAt — не контакт
    expect(found.has(ids.noAnswer)).toBe(true); // недозвон — не контакт
    expect(found.has(ids.botChat)).toBe(false); // написал боту — контакт
    expect(found.has(ids.talked)).toBe(false); // поговорили по телефону — контакт
    expect(found.has(ids.brandNew)).toBe(false); // свежая карточка ещё не «без контакта»
  });
});
