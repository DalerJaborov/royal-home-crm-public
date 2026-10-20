import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { prisma } from "../src/db.js";
import { app } from "../src/app.js";
import { loadHeatmapCells, summarizeChannelActivity, type HeatmapCell } from "../src/lib/audienceHeatmap.js";

/**
 * АКТИВНОСТЬ ПО КАНАЛАМ РЯДОМ (24.09.2026, владелец: «аналитикой и статистиками
 * по всем каналам, визуально»). Проверяется то, что ломается молча:
 *  - «прошлый период» — это ровно N дней ПЕРЕД окном, а не всё, что раньше, и
 *    события на границе не считаются дважды (иначе «рост на 40 %» — артефакт);
 *  - полоска по часам и дни недели складываются из тех же клеток, что карта;
 *  - путь отдаёт все каналы сигнала, кроме «все», и закрыт от обычного агента.
 */

const runId = Date.now();
const password = "testpass123";
let analystToken: string;
let agentToken: string;
const callChannelIds: string[] = [];

function cell(dow: number, hour: number, count: number): HeatmapCell {
  return { dow, hour, count };
}

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.agent.create({ data: { fullName: "Директор каналы", phone: `+992931${runId}`, role: "DIRECTOR", passwordHash } });
  await prisma.agent.create({ data: { fullName: "Агент каналы", phone: `+992932${runId}`, role: "AGENT", passwordHash } });
  analystToken = await login(`+992931${runId}`);
  agentToken = await login(`+992932${runId}`);
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { channelId: { in: callChannelIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [`+992931${runId}`, `+992932${runId}`] } } });
});

describe("Сводка канала", () => {
  it("часы и дни недели складываются из клеток, лучший час — на запас раньше пика", () => {
    const a = summarizeChannelActivity("WHATSAPP", [cell(1, 19, 10), cell(3, 19, 6), cell(3, 9, 4)], [cell(2, 10, 5)], 1);
    expect(a.total).toBe(20);
    expect(a.previousTotal).toBe(5);
    expect(a.byHour[19]).toBe(16);
    expect(a.byHour[9]).toBe(4);
    expect(a.byDow[3]).toBe(10);
    expect(a.busiestDow).toBe(1); // понедельник 10 против среды 10 — при равенстве ранний день недели
    expect(a.liveliestHours[0]).toBe(19);
    expect(a.publishHours).toContain(18);
  });

  it("пустой канал — нули, без выдуманного дня и часа", () => {
    const a = summarizeChannelActivity("TELEGRAM", [], [], 1);
    expect(a.total).toBe(0);
    expect(a.busiestDow).toBeNull();
    expect(a.publishHours).toEqual([]);
    expect(a.byHour).toHaveLength(24);
    expect(a.byDow).toHaveLength(7);
  });
});

describe("Окно карты с концом (прошлый период)", () => {
  it("событие попадает ровно в одно окно: до конца — да, после конца — нет", async () => {
    // Двести дней назад — туда не пишет ни один соседний тест.
    const at = new Date(Date.now() - 200 * 86_400_000);
    at.setUTCMinutes(30, 0, 0);
    const channelId = `heat-ch-${runId}`;
    callChannelIds.push(channelId);
    await prisma.incomingCall.create({ data: { channelId, phone: `+99290${String(runId).slice(-7)}`, startedAt: at } });

    const endJustAfter = new Date(at.getTime() + 60_000);
    const inWindow = await loadHeatmapCells({ signal: "all", channel: "PHONE", days: 1, endAt: endJustAfter });
    const before = await loadHeatmapCells({ signal: "all", channel: "PHONE", days: 1, endAt: at });
    const sum = (cells: HeatmapCell[]) => cells.reduce((s, c) => s + c.count, 0);
    // Своё событие в окне есть; окно, кончающееся ровно на нём, его не видит.
    expect(sum(inWindow) - sum(before)).toBeGreaterThanOrEqual(1);
    const ourHour = (at.getUTCHours() + 5) % 24;
    expect(inWindow.some((c) => c.hour === ourHour)).toBe(true);
  });
});

describe("GET /dashboard/heatmap/channels", () => {
  it("все каналы сигнала, кроме «все», у каждого 24 часа и 7 дней", async () => {
    const res = await request(app).get("/api/v1/dashboard/heatmap/channels?signal=chats").set("Authorization", `Bearer ${analystToken}`);
    expect(res.status).toBe(200);
    const channels = (res.body.channels as { channel: string; byHour: number[]; byDow: number[] }[]).map((c) => c.channel);
    expect(channels.sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM", "WEBSITE", "WHATSAPP"]);
    for (const c of res.body.channels) {
      expect(c.byHour).toHaveLength(24);
      expect(c.byDow).toHaveLength(7);
    }
    expect(typeof res.body.days).toBe("number");
  });

  it("неизвестный сигнал — 400; обычный агент — 403", async () => {
    expect(
      (await request(app).get("/api/v1/dashboard/heatmap/channels?signal=likes").set("Authorization", `Bearer ${analystToken}`)).status
    ).toBe(400);
    expect(
      (await request(app).get("/api/v1/dashboard/heatmap/channels?signal=all").set("Authorization", `Bearer ${agentToken}`)).status
    ).toBe(403);
  });
});
