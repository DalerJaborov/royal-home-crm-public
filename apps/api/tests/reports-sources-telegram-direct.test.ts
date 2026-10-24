import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import request from "supertest";
import { CLIENT_SOURCES, type ClientSource } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { waitFor } from "./helpers/waitFor.js";

type SourceRow = { source: string; total: number; closed: number; wrote: number };
type SourcesReport = { sources: SourceRow[]; avgDaysNewToClosed: number | null };
const at = new Date("2044-06-15T07:00:00.000Z");
const botIds: string[] = [], telegramIds: string[] = [], directIds: string[] = [], clientIds: string[] = [];
const noExternalFetch = vi.fn(async () => { throw new Error("No external fetch in source-report regression"); });
vi.stubGlobal("fetch", noExternalFetch);
let actorId: string, token: string;

beforeAll(async () => {
  const id = randomUUID();
  const actor = await prisma.agent.create({ data: { id, fullName: "Synthetic source-report director", phone: `test-source-report-${id}`, passwordHash: "test-unused", role: "DIRECTOR" } });
  actorId = actor.id;
  token = signAccessToken({ sub: actor.id, role: "DIRECTOR" });
});
afterEach(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: botIds } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: telegramIds } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { id: { in: directIds } } });
  await prisma.stageEvent.deleteMany({ where: { entityType: "CLIENT", entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  botIds.length = 0; telegramIds.length = 0; directIds.length = 0; clientIds.length = 0;
  expect(noExternalFetch).not.toHaveBeenCalled();
});
afterAll(async () => { await prisma.agent.delete({ where: { id: actorId } }); vi.unstubAllGlobals(); });

async function read(): Promise<SourcesReport> {
  const response = await request(app).get("/api/v1/reports/sources?from=2044-06-01&to=2044-06-30").set("Authorization", `Bearer ${token}`);
  expect(response.status).toBe(200);
  return response.body;
}
function source(report: SourcesReport, channel: string): SourceRow {
  return report.sources.find(row => row.source === channel) ?? { source: channel, total: 0, closed: 0, wrote: 0 };
}
async function direct(createdAt = at) {
  const row = await prisma.telegramDirectConversation.create({ data: { chatId: `test-source-channel-${randomUUID()}`, topicId: `test-source-topic-${randomUUID()}`, createdAt } });
  directIds.push(row.id); return row;
}
async function regularTelegram() {
  const row = await prisma.telegramConversation.create({ data: { chatId: `test-source-bot-${randomUUID()}`, createdAt: at } });
  telegramIds.push(row.id); return row;
}
async function bot(channel: string) {
  const row = await prisma.botConversation.create({ data: { channel, subscriberId: `test-source-subscriber-${randomUUID()}`, createdAt: at } });
  botIds.push(row.id); return row;
}
async function client(channel: ClientSource, closed = false) {
  const id = randomUUID();
  const row = await prisma.client.create({ data: { id, fullName: "Synthetic source-report client", phone: `test-source-client-${id}`, source: channel, kind: "BUYER", createdAt: at, ...(closed ? { status: "DEAL_CLOSED" } : {}) } });
  clientIds.push(row.id);
  if (closed) await waitFor(() => prisma.stageEvent.count({ where: { entityType: "CLIENT", entityId: row.id } }));
  return row;
}

it("counts a Telegram Direct conversation before any own client exists", async () => {
  const before = await read();
  await direct();
  const after = await read();
  expect(source(after, "TELEGRAM")).toEqual({ ...source(before, "TELEGRAM"), wrote: source(before, "TELEGRAM").wrote + 1 });
  expect(after.avgDaysNewToClosed).toBe(before.avgDaysNewToClosed);
});

it("adds Direct and regular Telegram to existing bot counts without changing Instagram", async () => {
  const before = await read();
  await bot("TELEGRAM"); await regularTelegram(); await direct(); await direct(); await bot("INSTAGRAM");
  const after = await read();
  expect(source(after, "TELEGRAM")).toEqual({ ...source(before, "TELEGRAM"), wrote: source(before, "TELEGRAM").wrote + 4 });
  expect(source(after, "INSTAGRAM")).toEqual({ ...source(before, "INSTAGRAM"), wrote: source(before, "INSTAGRAM").wrote + 1 });
});

it("keeps Direct conversations outside the explicit period out of the report", async () => {
  const before = await read();
  await direct(new Date("2044-05-15T07:00:00.000Z")); await direct(new Date("2044-07-15T07:00:00.000Z"));
  expect(await read()).toEqual(before);
});

it("preserves existing client totals and closed counts for every declared source", async () => {
  const before = await read();
  for (const channel of CLIENT_SOURCES) await client(channel);
  await client("TELEGRAM", true); await direct();
  const after = await read();
  for (const channel of CLIENT_SOURCES) {
    const original = source(before, channel);
    expect(source(after, channel)).toEqual({ ...original,
      total: original.total + (channel === "TELEGRAM" ? 2 : 1),
      closed: original.closed + (channel === "TELEGRAM" ? 1 : 0),
      wrote: original.wrote + (channel === "TELEGRAM" ? 1 : 0),
    });
  }
  expect(after.avgDaysNewToClosed).toBe(before.avgDaysNewToClosed);
});

it("restores the no-own-input response after only the captured conversations are removed", async () => {
  const before = await read();
  const first = await direct(), second = await regularTelegram();
  expect(source(await read(), "TELEGRAM").wrote).toBe(source(before, "TELEGRAM").wrote + 2);
  await prisma.telegramDirectConversation.delete({ where: { id: first.id } });
  await prisma.telegramConversation.delete({ where: { id: second.id } });
  expect(await read()).toEqual(before);
});
