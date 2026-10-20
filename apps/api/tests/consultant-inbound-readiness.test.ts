import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { consultantInboundReadiness, type FailoverConfig } from "../src/lib/telephony/failoverSync.js";
import { packetCategoryLines } from "../src/lib/telephony/dialplanContext.js";
import {
  CONSULTANT_DIALPLAN_CHECK,
  CONSULTANT_STASIS_FRAGMENT,
  consultantDialplanCheck,
  describeFailoverDiff,
} from "../src/lib/telephony/stationHealth.js";

/**
 * КОНСУЛЬТАНТ НА ВХОДЯЩИХ: ВЫБОР В НАСТРОЙКАХ ≠ РАБОТАЕТ (28.09.2026).
 *
 * Жалоба владельца: выбрал «консультант вместо автоответчика», а трубку берёт
 * автоответчик, и нигде не сказано почему. Причин было две, и обе молчали:
 * сервер без LIVE_VOICE_RTP_HOST кладёт станции пустой режим, а станция со
 * старым `extensions_custom.conf` (аудит 25.09, §1) ветки консультанта не знает.
 */

describe("готовность сервера звать консультанта", () => {
  const on = { enabled: true, mode: "no_answer", rtpHost: "10.0.0.5:40800" };

  it("выбран и есть адрес звука — станции уходит режим", () => {
    expect(consultantInboundReadiness(on)).toEqual({ wanted: true, rtpHostConfigured: true, stationMode: "no_answer" });
  });

  it("выбран, но адреса нет — выбор виден, станции уходит пусто (раньше это было молча)", () => {
    expect(consultantInboundReadiness({ ...on, rtpHost: "  " })).toEqual({
      wanted: true,
      rtpHostConfigured: false,
      stationMode: "",
    });
  });

  it("живой голос выключен — консультант не выбран, как бы ни стоял режим", () => {
    expect(consultantInboundReadiness({ ...on, enabled: false, mode: "always" }).wanted).toBe(false);
    expect(consultantInboundReadiness({ ...on, mode: "off" }).wanted).toBe(false);
  });
});

describe("проверка станции: ветка консультанта в royalhome-inbound", () => {
  it("консультант не выбран — не проверяется и не тревожит", () => {
    const check = consultantDialplanCheck(false, null);
    expect(check.ok).toBeNull();
    expect(check.name).toBe(CONSULTANT_DIALPLAN_CHECK);
  });

  it("станция не ответила — «не знаем», а не поломка", () => {
    expect(consultantDialplanCheck(true, { unknown: true }).ok).toBeNull();
  });

  it("контекст есть, ветки нет (случай станции 25.09) — поломка с текстом починки", () => {
    const check = consultantDialplanCheck(true, { present: true, contains: false });
    expect(check.ok).toBe(false);
    expect(check.cls).toBe("config");
    expect(check.detail).toContain("ops/asterisk/extensions_custom.conf");
    expect(check.detail).toContain("dialplan reload");
  });

  it("контекста нет вовсе — тоже поломка", () => {
    expect(consultantDialplanCheck(true, { present: false }).ok).toBe(false);
  });

  it("ветка на месте — зелёное", () => {
    expect(consultantDialplanCheck(true, { present: true, contains: true }).ok).toBe(true);
  });

  it("строки секции берутся из ответа GetConfig только своей категории", () => {
    const packet = {
      response: "Success",
      "category-000000": "royalhome-agent-route",
      "line-000000-000000": "exten=agent,1,NoOp(x)",
      "category-000001": "royalhome-inbound",
      "line-000001-000000": "exten=s,1,NoOp(Royal Home)",
      "line-000001-000001": "exten=s,n,Stasis(royalhome-live-voice,${RH_AIARG})",
    };
    const lines = packetCategoryLines(packet, "royalhome-inbound");
    expect(lines).toHaveLength(2);
    expect(lines!.some((l) => l.includes(CONSULTANT_STASIS_FRAGMENT))).toBe(true);
    expect(packetCategoryLines(packet, "royalhome-agent-wait")).toBeNull();
  });
});

describe("диалплан в репозитории", () => {
  const file = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../ops/asterisk/extensions_custom.conf"),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const inbound = file.slice(file.indexOf("[royalhome-inbound]"), file.indexOf("[royalhome-agent-route]"));

  it("в royalhome-inbound есть ветка консультанта — то, что ищет проверка станции", () => {
    expect(inbound).toContain(CONSULTANT_STASIS_FRAGMENT);
  });

  it("время в сравнениях часов считается по Душанбе, а не по часам станции", () => {
    const nowLines = file.split("\n").filter((l) => l.includes("Set(RH_NOW="));
    expect(nowLines.length).toBeGreaterThan(0);
    for (const line of nowLines) expect(line).toContain("STRFTIME(${EPOCH},Asia/Dushanbe,%H:%M)");
  });

  // 11.10.2026 владелец: «робот НЕ отвечает клиентам агента — агент сам перезвонит».
  // Прежний тест закреплял обратное (24.09: при консультанте — к нему, Stasis missed).
  it("свой клиент, агент не взял: только голосовая почта, консультант не подключается", () => {
    const route = file.slice(file.indexOf("[royalhome-agent-route]"), file.indexOf("[royalhome-agent-wait]"));
    expect(route).not.toContain("aimissed");
    expect(route).not.toContain("Stasis(royalhome-live-voice,missed)");
    expect(route).toMatch(/n\(voicemail\),NoOp\(/);
  });
});

describe("сверка AstDB называет все разошедшиеся значения", () => {
  const base: FailoverConfig = {
    action: "none",
    seconds: 20,
    phone: "",
    nightAction: "none",
    nightStart: "21:00",
    nightEnd: "09:00",
    target: "",
    aiMode: "no_answer",
    aiSeconds: 30,
    aiDayStart: "09:30",
    aiDayEnd: "18:00",
  };

  it("разошёлся только режим консультанта — так и сказано", () => {
    const text = describeFailoverDiff(base, { ...base, aiMode: "" });
    expect(text).toContain("aiMode");
    expect(text).not.toContain("action:");
  });
});

describe("GET /settings отдаёт готовность консультанта", () => {
  const runId = Date.now();
  let adminId: string;
  let token: string;
  let saved: { liveVoiceEnabled: boolean; liveVoiceInboundMode: string } | null = null;
  const snapshotName = `Телефония: ${CONSULTANT_DIALPLAN_CHECK}`;
  let savedSnapshot: { ok: boolean | null; detail: string | null } | null = null;
  const savedHost = process.env.LIVE_VOICE_RTP_HOST;
  const savedPort = process.env.LIVE_VOICE_RTP_PORT;

  beforeAll(async () => {
    const admin = await prisma.agent.create({
      data: {
        fullName: "Админ консультанта",
        phone: `+992937${runId}`,
        role: "ADMIN",
        passwordHash: await bcrypt.hash("testpass123", 10),
      },
    });
    adminId = admin.id;
    token = (await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password: "testpass123" })).body
      .accessToken;
    const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    saved = { liveVoiceEnabled: current.liveVoiceEnabled, liveVoiceInboundMode: current.liveVoiceInboundMode };
    savedSnapshot = await prisma.integrationHealthSnapshot.findUnique({ where: { name: snapshotName } });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { liveVoiceEnabled: true, liveVoiceInboundMode: "no_answer" },
    });
    await prisma.integrationHealthSnapshot.upsert({
      where: { name: snapshotName },
      create: { name: snapshotName, ok: false, detail: "нет ветки" },
      update: { ok: false, detail: "нет ветки" },
    });
  });

  afterAll(async () => {
    if (savedHost === undefined) delete process.env.LIVE_VOICE_RTP_HOST;
    else process.env.LIVE_VOICE_RTP_HOST = savedHost;
    if (savedPort === undefined) delete process.env.LIVE_VOICE_RTP_PORT;
    else process.env.LIVE_VOICE_RTP_PORT = savedPort;
    if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    if (savedSnapshot) {
      await prisma.integrationHealthSnapshot.update({ where: { name: snapshotName }, data: savedSnapshot });
    } else {
      await prisma.integrationHealthSnapshot.deleteMany({ where: { name: snapshotName } });
    }
    await prisma.agent.delete({ where: { id: adminId } });
  });

  it("нет адреса звука и станция без ветки — оба признака видны экрану", async () => {
    delete process.env.LIVE_VOICE_RTP_HOST;
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.liveVoiceInbound.wanted).toBe(true);
    expect(res.body.liveVoiceInbound.rtpHostConfigured).toBe(false);
    expect(res.body.liveVoiceInbound.stationDialplan.ok).toBe(false);
  });

  it("задан только адрес без порта — сервер НЕ готов (как у моста, liveVoiceRtpConfig)", async () => {
    process.env.LIVE_VOICE_RTP_HOST = "10.0.0.5";
    delete process.env.LIVE_VOICE_RTP_PORT;
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);
    expect(res.body.liveVoiceInbound.rtpHostConfigured).toBe(false);
  });

  it("адрес и порт заданы — сервер готов", async () => {
    process.env.LIVE_VOICE_RTP_HOST = "10.0.0.5";
    process.env.LIVE_VOICE_RTP_PORT = "40800";
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);
    expect(res.body.liveVoiceInbound.rtpHostConfigured).toBe(true);
  });
});
