import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { CLOSING_WORDS, closingReplySql, isClosingReply } from "../src/lib/inboxWaiting.js";
import { STAFF_CONTACT_INTERACTION_WHERE, staffContactAfterSql } from "../src/lib/noContact.js";

/**
 * «Ждут» в «Чатах» — только те, кому реально надо ответить сейчас (21.11.2026):
 * последняя реплика клиента моложе 48 ч, после неё не было контакта другим путём
 * (звонок/встреча/сообщение агента), и реплика не «ок/спасибо» без вопроса.
 * Число на кнопке и список за ней — одна выборка.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99291${String(runId).slice(-7)}`;
const H = 3_600_000;
let directorId = "";
let token = "";
let seq = 0;
const botIds: string[] = [];
const clientIds: string[] = [];

async function makeClient(tag: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  const c = await prisma.client.create({
    data: {
      fullName: `Ждут ${tag} ${runId}`,
      phone: `+99294${String(runId).slice(-4)}${String(seq).padStart(3, "0")}`,
      source: "PHONE_CALL",
      assignedAgentId: directorId,
      acceptedAt: new Date(),
      ...extra,
    } as Prisma.ClientUncheckedCreateInput,
  });
  clientIds.push(c.id);
  return c;
}

async function makeConv(tag: string, text: string, ageMs: number, clientId: string, last: "user" | "assistant" = "user") {
  const messages =
    last === "user"
      ? [{ role: "user", content: text }]
      : [
          { role: "user", content: "вопрос" },
          { role: "assistant", content: text, by: { kind: "agent" } },
        ];
  const conv = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-${tag}-${runId}`,
      name: `W ${tag} ${runId}`,
      messages,
      lastMessageAt: new Date(Date.now() - ageMs),
      clientId,
    },
  });
  botIds.push(conv.id);
  return conv;
}

beforeAll(async () => {
  const d = await prisma.agent.create({
    data: { fullName: "Директор Ждут", phone, passwordHash: await bcrypt.hash(password, 10), role: "DIRECTOR", isActive: true },
  });
  directorId = d.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  // Настоящий вопрос час назад — ждёт.
  await makeConv("fresh", `сколько стоит ${runId}`, H, (await makeClient("fresh")).id);
  // Старше 48 ч — не ждёт (просто «Все»).
  await makeConv("old", `ответьте ${runId}`, 49 * H, (await makeClient("old")).id);
  // Агент ПОЗВОНИЛ после сообщения — не ждёт.
  const called = await makeClient("called");
  await makeConv("called", `перезвоните ${runId}`, 5 * H, called.id);
  await prisma.interaction.create({
    data: { clientId: called.id, agentId: directorId, type: "CALL", callAttempt: "TALKED", notes: "поговорили", actorKind: "AGENT" },
  });
  // Позвонили ДО сообщения — звонок не считается, клиент всё ещё ждёт.
  const calledBefore = await makeClient("calledBefore");
  await prisma.interaction.create({
    data: {
      clientId: calledBefore.id,
      agentId: directorId,
      type: "CALL",
      callAttempt: "TALKED",
      notes: "поговорили",
      actorKind: "AGENT",
      createdAt: new Date(Date.now() - 10 * H),
    },
  });
  await makeConv("calledBefore", `а можно подробнее ${runId}`, 5 * H, calledBefore.id);
  // Пропущенный ВХОДЯЩИЙ — клиент звонил нам, а не мы ему: всё ещё ждёт.
  const incoming = await makeClient("incoming");
  await makeConv("incoming", `жду ответа ${runId}`, 5 * H, incoming.id);
  await prisma.interaction.create({
    data: { clientId: incoming.id, agentId: directorId, type: "CALL", notes: "Входящий звонок, пропущен", actorKind: "AGENT" },
  });
  // Агент написал из CRM после сообщения (lastAgentAttemptAt) — не ждёт.
  const msgd = await makeClient("msgd", { lastAgentAttemptAt: new Date() });
  await makeConv("msgd", `привет ${runId}`, 5 * H, msgd.id);
  // «ок спасибо» — закрывающая.
  await makeConv("thanks", "Ок, спасибо!", H, (await makeClient("thanks")).id);
  // «спасибо, а сколько стоит?» — НЕ закрывающая.
  await makeConv("thq", "спасибо, а сколько стоит?", H, (await makeClient("thq")).id);
  // Агент ответил в чате — последняя реплика не клиента.
  await makeConv("agent", "добрый день", H, (await makeClient("agent")).id, "assistant");
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: botIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.session.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

const list = (q: string) =>
  request(app)
    .get(`/api/v1/conversations?q=${encodeURIComponent(String(runId))}${q}`)
    .set("Authorization", `Bearer ${token}`);

describe("«Ждут» — только реально ждущие", () => {
  it("отдаёт ждущих и отсеивает старое, обзвоненное, написанное и «ок спасибо»", async () => {
    const res = await list("&needsHuman=1");
    expect(res.status).toBe(200);
    // Список подписывает диалог именем клиента: «Ждут <метка> <runId>».
    const tags = (res.body.items as { name: string }[]).map((i) => i.name.replace(/^Ждут (\w+) .*/, "$1")).sort();
    expect(tags).toEqual(["calledBefore", "fresh", "incoming", "thq"]);
  });

  it("число на кнопке = длина списка (плоский и сгруппированный вид)", async () => {
    const flat = await list("&needsHuman=1");
    expect(flat.body.counts.needsHuman).toBe(flat.body.items.length);
    expect(flat.body.total).toBe(flat.body.items.length);
    const grouped = await list("&needsHuman=1&grouped=1");
    expect(grouped.body.counts.needsHuman).toBe(flat.body.items.length);
    expect(grouped.body.items.length).toBe(flat.body.items.length);
  });

  it("плашка «ждёт человека» не показывает уже обзвоненного", async () => {
    const calledConv = await prisma.botConversation.findFirstOrThrow({ where: { name: `W called ${runId}` } });
    await prisma.botConversation.update({
      where: { id: calledConv.id },
      data: { pausedUntil: new Date(Date.now() + H), botPausedAt: new Date(Date.now() - 5 * H) },
    });
    const res = await list("");
    expect(res.body.alerts.longestWaitingHuman?.id).not.toBe(calledConv.id);
  });
});

describe("закрывающие реплики", () => {
  const closing = [
    ...CLOSING_WORDS,
    "Ок",
    "ОК!",
    "ок спасибо",
    "Спасибо большое",
    "спасибо вам большое!",
    "Раҳмат",
    "ташаккур, хуб",
    "хуб, бисёр ташаккур",
    "ҳоп аст",
    "хорошо, спасибо",
    "ладно.",
    "👍",
    "🙏🙏",
    "...",
    "",
    "   ",
    "[вложение: sticker]",
  ];
  const notClosing = [
    "спасибо, а сколько стоит?",
    "ок, а когда?",
    "спасибо, жду звонка",
    "ok 3 комнаты",
    "сколько",
    "хорошо, но дорого",
    "рахмат, нархаш чанд?",
    "89 000",
    "ок?",
    "[вложение: audio]",
    "перезвоните, пожалуйста",
    "окно",
  ];

  it.each(closing)("«%s» — закрывающая", (t) => expect(isClosingReply(t)).toBe(true));
  it.each(notClosing)("«%s» — НЕ закрывающая", (t) => expect(isClosingReply(t)).toBe(false));

  it("SQL-версия даёт тот же ответ, что JS, на всех примерах", async () => {
    for (const t of [...closing, ...notClosing]) {
      const [row] = await prisma.$queryRaw<{ v: boolean }[]>`SELECT ${closingReplySql(Prisma.sql`${t}::text`)} AS v`;
      expect(row.v, t).toBe(isClosingReply(t));
    }
  });
});

describe("правило контакта: SQL = Prisma-условие", () => {
  it("на одних и тех же записях STAFF_CONTACT_INTERACTION_WHERE и SQL-версия согласны", async () => {
    const c = await makeClient("rule");
    const base = { clientId: c.id, notes: "n", actorKind: "AGENT" as const, agentId: directorId };
    const cases = [
      { ...base, type: "CALL", callAttempt: "TALKED" },
      { ...base, type: "CALL", callAttempt: "NO_ANSWER" },
      { ...base, type: "CALL", callAttempt: "AGENT_NO_PICKUP" },
      { ...base, type: "CALL", notes: "Входящий звонок" },
      { ...base, type: "CALL", notes: "вручную" },
      { ...base, type: "CALL", callAttempt: "ANSWERED_BY_BOT", recordingDurationSec: 30 },
      { ...base, type: "MEETING" },
      { ...base, type: "SHOWING", actorKind: "SYSTEM" as const, agentId: null },
      { ...base, type: "MESSAGE" },
    ] as Prisma.InteractionUncheckedCreateInput[];
    const past = new Date(Date.now() - H);
    for (const data of cases) {
      const row = await prisma.interaction.create({ data });
      const viaPrisma = (await prisma.interaction.count({ where: { id: row.id, ...STAFF_CONTACT_INTERACTION_WHERE } })) > 0;
      const [sqlRow] = await prisma.$queryRaw<{ v: boolean }[]>`
        SELECT ${staffContactAfterSql(Prisma.sql`${c.id}::text`, Prisma.sql`${past}::timestamp`, Prisma.sql`NULL::timestamp`)} AS v`;
      await prisma.interaction.delete({ where: { id: row.id } });
      expect(sqlRow.v, JSON.stringify(data)).toBe(viaPrisma);
    }
  });
});
