import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * БОТ УСТУПАЕТ СОТРУДНИКУ В ЧАТЕ САЙТА И В TELEGRAM (владелец 27.11.2026): без автопаузы после ответа человека бот
 * молчит, пока сотрудник писал в пределах срока из Настроек (staffQuietMinutes, по умолчанию 180) — то же правило, что
 * ведёт оператор приёма в WhatsApp/Instagram/Facebook. Рубильник автопаузы подменён в модуле (тесты идут на одной базе).
 */
const { switchState } = vi.hoisted(() => ({ switchState: { on: false } }));
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return {
    ...original,
    automationSwitchOn: async (key: Parameters<typeof original.automationSwitchOn>[0], db?: Parameters<typeof original.automationSwitchOn>[1]) =>
      key === "botPauseOnStaffReplyEnabled" ? switchState.on : original.automationSwitchOn(key, db),
  };
});

const { prisma } = await import("../src/db.js");
const { staffQuietActive } = await import("../src/lib/staffQuiet.js");

const runId = Date.now().toString(36);
const botIds: string[] = [];
const tgIds: string[] = [];
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();

const staffMessage = (minutes: number, kind: "agent" | "manual" = "agent") =>
  ({ role: "assistant", content: "Здравствуйте, это сотрудник", at: ago(minutes), by: kind === "agent" ? { kind, agentId: "a1" } : { kind } });
const botMessage = (minutes: number) => ({ role: "assistant", content: "Ответ бота", at: ago(minutes), by: { kind: "bot" } });
const clientMessage = (minutes: number) => ({ role: "user", content: "Вопрос", at: ago(minutes) });

async function botConv(channel: string, messages: unknown[]) {
  const c = await prisma.botConversation.create({
    data: { channel: channel as never, subscriberId: `staff-quiet-${runId}-${botIds.length}`, messages: messages as never },
  });
  botIds.push(c.id);
  return c;
}
let tgSeq = 0;
async function tgConv(messages: unknown[]) {
  const c = await prisma.telegramConversation.create({
    data: { chatId: `staff-quiet-${runId}-${tgSeq++}`, messages: messages as never },
  });
  tgIds.push(c.id);
  return c;
}

afterEach(() => { switchState.on = false; });
afterAll(async () => {
  if (botIds.length) await prisma.botConversation.deleteMany({ where: { id: { in: botIds } } });
  if (tgIds.length) await prisma.telegramConversation.deleteMany({ where: { id: { in: tgIds } } });
});

describe("чат сайта", () => {
  it("сотрудник писал недавно — бот молчит (и агент из CRM, и ручной ответ)", async () => {
    for (const kind of ["agent", "manual"] as const) {
      const c = await botConv("WEBSITE", [clientMessage(30), staffMessage(10, kind), clientMessage(1)]);
      expect(await staffQuietActive({ kind: "bot", id: c.id, channel: "WEBSITE" })).toBe(true);
    }
  });
  it("сотрудник писал давно (дольше срока) — бот отвечает", async () => {
    const c = await botConv("WEBSITE", [staffMessage(600), clientMessage(1)]);
    expect(await staffQuietActive({ kind: "bot", id: c.id, channel: "WEBSITE" })).toBe(false);
  });
  it("писал только бот — бот отвечает", async () => {
    const c = await botConv("WEBSITE", [botMessage(5), clientMessage(1)]);
    expect(await staffQuietActive({ kind: "bot", id: c.id, channel: "WEBSITE" })).toBe(false);
  });
  it("рубильник автопаузы включён — правило не действует (бота держит пауза)", async () => {
    switchState.on = true;
    const c = await botConv("WEBSITE", [staffMessage(10)]);
    expect(await staffQuietActive({ kind: "bot", id: c.id, channel: "WEBSITE" })).toBe(false);
  });
  it("каналы Meta правило не трогает: там ведёт оператор приёма", async () => {
    const c = await botConv("INSTAGRAM", [staffMessage(10)]);
    expect(await staffQuietActive({ kind: "bot", id: c.id, channel: "INSTAGRAM" })).toBe(false);
  });
});

describe("Telegram", () => {
  it("сотрудник писал недавно — бот молчит", async () => {
    const c = await tgConv([clientMessage(30), staffMessage(10), clientMessage(1)]);
    expect(await staffQuietActive({ kind: "telegram", id: c.id })).toBe(true);
  });
  it("сотрудник писал давно или только бот — бот отвечает", async () => {
    expect(await staffQuietActive({ kind: "telegram", id: (await tgConv([staffMessage(600), clientMessage(1)])).id })).toBe(false);
    expect(await staffQuietActive({ kind: "telegram", id: (await tgConv([botMessage(5), clientMessage(1)])).id })).toBe(false);
  });
  it("рубильник автопаузы включён — правило не действует", async () => {
    switchState.on = true;
    const c = await tgConv([staffMessage(10)]);
    expect(await staffQuietActive({ kind: "telegram", id: c.id })).toBe(false);
  });
});

describe("проверка стоит на входе хода обоих каналов", () => {
  it("чат сайта (messengers/conversation.ts) и Telegram (telegram/bot.ts) зовут одну дверь", () => {
    expect(fs.readFileSync(new URL("../src/messengers/conversation.ts", import.meta.url), "utf8")).toContain('staffQuietActive({ kind: "bot"');
    const tg = fs.readFileSync(new URL("../src/telegram/bot.ts", import.meta.url), "utf8");
    expect(tg.match(/staffQuietActive\(\{ kind: "telegram"/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
