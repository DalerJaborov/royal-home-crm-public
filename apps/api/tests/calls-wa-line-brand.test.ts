import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * ВТОРОЙ НОМЕР WHATSAPP В ЖУРНАЛЕ ЗВОНКОВ (26.11.2026, «Арван» +992 87 791 4444).
 *
 * Звонок на не основной номер пишется с `waPhoneNumberId` (lib/telephony/callSource.ts),
 * и обе ленты — GET /calls/feed и GET /calls/incoming — отдают `brand`: имя страницы
 * этого номера. Экран рисует «WhatsApp · Арван» (CallSourceMark). Основной номер и
 * линия — `brand: null`, сам phone_number_id наружу не уходит.
 *
 * Строку канала в общей базе тестов не заводим (соседние файлы считают «строк WhatsApp
 * нет»): бренд подменён на уровне двери accounts.ts::whatsappLineBrand.
 */
const LINE_ID = `8${String(Date.now()).padStart(15, "0").slice(-15)}`;
process.env.TEST_WA_LINE_ID_FEED = LINE_ID;
vi.mock("../src/messengers/accounts.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/messengers/accounts.js")>();
  return {
    ...real,
    whatsappLineBrand: vi.fn(async (id: string | null | undefined) => (id && id === process.env.TEST_WA_LINE_ID_FEED ? "Арван" : null)),
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
let adminId = "";
let adminToken = "";
const incomingIds: string[] = [];
// Время в будущем: наши строки идут первыми в обеих лентах.
const T = new Date("2097-03-01T10:00:00.000Z");

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ линии WA ${runId}`, phone: `+99274${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  adminId = admin.id;
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  for (const [i, line] of [LINE_ID, null].entries()) {
    const row = await prisma.incomingCall.create({
      data: {
        channelId: `wa-line-brand-${runId}-${i}`,
        phone: `+9927711${String(i).padStart(4, "0")}`,
        source: "whatsapp",
        waPhoneNumberId: line,
        startedAt: new Date(T.getTime() - i * 1000),
      },
    });
    incomingIds.push(row.id);
  }
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { id: { in: incomingIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("бренд второго номера WhatsApp в журнале звонков", () => {
  it("GET /calls/feed: звонок на второй номер — brand «Арван», на основной — null", async () => {
    const res = await request(app)
      .get("/api/v1/calls/feed")
      .query({ limit: 5, before: "2097-06-01T00:00:00.000Z" })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map((r: { id: string; brand: string | null }) => [r.id, r]));
    expect((byId.get(incomingIds[0]) as { brand: string | null }).brand).toBe("Арван");
    expect((byId.get(incomingIds[1]) as { brand: string | null }).brand).toBeNull();
  });

  it("GET /calls/incoming: то же, и phone_number_id наружу не отдаётся", async () => {
    const res = await request(app).get("/api/v1/calls/incoming").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body.items as Array<{ id: string; brand: string | null; waPhoneNumberId?: unknown }>;
    const line = rows.find((r) => r.id === incomingIds[0]);
    const main = rows.find((r) => r.id === incomingIds[1]);
    expect(line?.brand).toBe("Арван");
    expect(main?.brand).toBeNull();
    expect(line && "waPhoneNumberId" in line).toBe(false);
  });
});
