import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import {
  expectedRtpPeer,
  externalMediaPort,
  isLiveVoiceRtpConfigured,
  liveVoiceRtpProblem,
} from "../src/lib/telephony/liveVoiceRtpConfig.js";

/**
 * АДРЕС ЗВУКА РОБОТА НА СЕРВЕРЕ (02.10.2026, аудит Д27).
 *
 * Без LIVE_VOICE_RTP_HOST/PORT станция не может прислать звук в CRM: робот берёт
 * трубку и молчит, а в Настройках стоит «включено». Настройки теперь отдают
 * `liveVoiceRtpProblem`, и вкладка бота показывает предупреждение.
 */

const runId = Date.now();
const password = "testpass123";
let adminId = "";
let adminToken = "";
const before = {
  host: process.env.LIVE_VOICE_RTP_HOST,
  port: process.env.LIVE_VOICE_RTP_PORT,
  peer: process.env.LIVE_VOICE_RTP_PEER,
};

function restore(key: "LIVE_VOICE_RTP_HOST" | "LIVE_VOICE_RTP_PORT" | "LIVE_VOICE_RTP_PEER", value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ адреса звука", phone: `+992937${String(runId).slice(-7)}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
});

afterEach(() => {
  restore("LIVE_VOICE_RTP_HOST", before.host);
  restore("LIVE_VOICE_RTP_PORT", before.port);
  restore("LIVE_VOICE_RTP_PEER", before.peer);
});

afterAll(async () => {
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("liveVoiceRtpProblem", () => {
  it("ничего не задано — называет обе переменные", () => {
    delete process.env.LIVE_VOICE_RTP_HOST;
    delete process.env.LIVE_VOICE_RTP_PORT;
    const problem = liveVoiceRtpProblem();
    expect(problem).toContain("LIVE_VOICE_RTP_HOST");
    expect(problem).toContain("LIVE_VOICE_RTP_PORT");
    expect(isLiveVoiceRtpConfigured()).toBe(false);
  });

  it("задан только хост — просит порт; порт 0 или мусор тоже не годится", () => {
    process.env.LIVE_VOICE_RTP_HOST = "10.9.0.1";
    delete process.env.LIVE_VOICE_RTP_PORT;
    expect(liveVoiceRtpProblem()).toContain("LIVE_VOICE_RTP_PORT");
    expect(liveVoiceRtpProblem()).not.toContain("LIVE_VOICE_RTP_HOST");
    process.env.LIVE_VOICE_RTP_PORT = "abc";
    expect(externalMediaPort()).toBe(0);
    expect(liveVoiceRtpProblem()).toContain("LIVE_VOICE_RTP_PORT");
  });

  it("оба заданы — проблемы нет", () => {
    process.env.LIVE_VOICE_RTP_HOST = "10.9.0.1";
    process.env.LIVE_VOICE_RTP_PORT = "40800";
    expect(liveVoiceRtpProblem()).toBeNull();
    expect(isLiveVoiceRtpConfigured()).toBe(true);
  });
});

describe("expectedRtpPeer (LIVE_VOICE_RTP_PEER)", () => {
  it("не задан — null; адрес без порта и с портом разбираются", () => {
    delete process.env.LIVE_VOICE_RTP_PEER;
    expect(expectedRtpPeer()).toBeNull();
    process.env.LIVE_VOICE_RTP_PEER = " 10.9.0.2 ";
    expect(expectedRtpPeer()).toEqual({ address: "10.9.0.2", port: null });
    process.env.LIVE_VOICE_RTP_PEER = "10.9.0.2:4000";
    expect(expectedRtpPeer()).toEqual({ address: "10.9.0.2", port: 4000 });
    process.env.LIVE_VOICE_RTP_PEER = "10.9.0.2:99999";
    expect(expectedRtpPeer()).toEqual({ address: "10.9.0.2", port: null });
  });
});

describe("GET /settings — liveVoiceRtpProblem (Д27)", () => {
  it("адрес звука не задан — Настройки отдают предупреждение", async () => {
    delete process.env.LIVE_VOICE_RTP_HOST;
    delete process.env.LIVE_VOICE_RTP_PORT;
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.liveVoiceRtpProblem).toContain("LIVE_VOICE_RTP_HOST");
  });

  it("адрес звука задан — поле null, предупреждения нет", async () => {
    process.env.LIVE_VOICE_RTP_HOST = "10.9.0.1";
    process.env.LIVE_VOICE_RTP_PORT = "40800";
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.liveVoiceRtpProblem).toBeNull();
  });
});
