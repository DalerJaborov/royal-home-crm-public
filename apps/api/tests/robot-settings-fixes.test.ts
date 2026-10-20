import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * НАСТРОЙКИ И ПРАВА ЖИВОГО ГОЛОСА — ПРАВКИ ПО АУДИТУ РОБОТОВ (02.10.2026).
 *
 *  №4  «Звонок роботом» по карточке оставляет запись в хронологии клиента;
 *  №5  своя личность живого голоса не может стереть правила инструментов, а
 *      превью голоса слышит ту же личность, что и звонок;
 *  №16 проверочный звонок пишет в журнал номер под маской;
 *  №25 список разговоров: предел выборки, имя без номера, короткая причина;
 *  №29 прослушивание записи разговора остаётся в журнале действий.
 *
 * Станция, Live API и R2 подменены: проверяется, что делает маршрут.
 */

const robot = vi.hoisted(() => ({
  clientResult: { ok: true, channelId: "lv-client" } as { ok: boolean; channelId?: string; error?: string },
  previewInstructions: [] as string[],
  previewTriggers: [] as string[],
}));
vi.mock("../src/lib/telephony/liveVoiceBridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/liveVoiceBridge.js")>()),
  originateLiveVoiceTestCall: async () => ({ ok: true, channelId: "lv-test" }),
  originateLiveVoiceCallToClient: async () => robot.clientResult,
}));
vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/liveVoiceClient.js")>()),
  previewLiveVoiceGreeting: async (input: { systemInstruction: string; greetingTrigger?: string }) => {
    robot.previewInstructions.push(input.systemInstruction);
    robot.previewTriggers.push(input.greetingTrigger ?? "");
    return { transcript: "Салом", audioBase64: "AAAA", sampleRateHz: 24000 };
  },
}));
vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  r2PresignDownloadUrl: async () => "https://r2.example/presigned",
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { DEFAULT_LIVE_VOICE_PROMPT } = await import("../src/ai/liveVoicePersona.js");
const { missingLiveVoiceToolRules, liveVoicePromptToolRulesError } = await import("../src/lib/liveVoicePromptGuard.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const tail = () => String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
const runId = Date.now().toString(36);
const agentIds: string[] = [];
const sessionIds: string[] = [];
const clientIds: string[] = [];
let director = "";
let directorToken = "";
let viewerToken = "";
let blindToken = "";
let ownerClientId = "";
let originalPrompt: string | null = null;

async function makeAgent(label: string, role: "AGENT" | "DIRECTOR", granted: string[] = [], revoked: string[] = []) {
  const a = await prisma.agent.create({
    data: {
      fullName: `Правки-робота ${label} ${runId}`,
      phone: `+992${tail()}`,
      role,
      passwordHash: "x",
      permissions: { granted, revoked },
    },
    select: { id: true },
  });
  agentIds.push(a.id);
  return { id: a.id, token: signAccessToken({ sub: a.id, role }) };
}

beforeAll(async () => {
  const d = await makeAgent("director", "DIRECTOR");
  director = d.id;
  directorToken = d.token;
  // Права на разговоры робота — и текст, и звук; номер клиента видит.
  viewerToken = (await makeAgent("viewer", "AGENT", ["settings.manage", "calls.transcripts", "calls.hearRecording", "clients.viewPhone"])).token;
  // Те же права, но номера клиентов закрыты.
  blindToken = (await makeAgent("blind", "AGENT", ["settings.manage", "calls.transcripts"], ["clients.viewPhone"])).token;
  const c = await prisma.client.create({
    data: { fullName: `Клиент правок ${runId}`, phone: `+992${tail()}`, source: "PHONE_CALL", assignedAgentId: director },
    select: { id: true },
  });
  ownerClientId = c.id;
  clientIds.push(c.id);
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  originalPrompt = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { liveVoicePrompt: true } })).liveVoicePrompt;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoicePrompt: originalPrompt } });
  await prisma.liveVoiceSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agentIds } } });
  await deleteAgentsWithTraces(agentIds);
});

beforeEach(() => {
  robot.clientResult = { ok: true, channelId: "lv-client" };
  robot.previewInstructions.length = 0;
  robot.previewTriggers.length = 0;
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const patchSettings = (body: Record<string, unknown>) => {
  grantElevation(director);
  return request(app).patch("/api/v1/settings").set(bearer(directorToken)).send(body);
};

describe("№4 звонок роботом по карточке — запись в хронологии", () => {
  it("успешный запуск заводит запись SYSTEM от автоматики, а не от менеджера", async () => {
    const res = await request(app).post(`/api/v1/clients/${ownerClientId}/live-voice-call`).set(bearer(directorToken)).send({});
    expect(res.status).toBe(200);
    const row = await prisma.interaction.findFirst({ where: { clientId: ownerClientId, type: "SYSTEM" } });
    expect(row).not.toBeNull();
    expect(row!.actorKind).toBe("SYSTEM");
    expect(row!.agentId).toBeNull();
    expect(row!.notes).toMatch(/Звонок роботом/);
  });

  it("отказ станции — записи нет: звонка не было", async () => {
    const before = await prisma.interaction.count({ where: { clientId: ownerClientId } });
    robot.clientResult = { ok: false, error: "Линия живого голоса занята другим разговором" };
    const res = await request(app).post(`/api/v1/clients/${ownerClientId}/live-voice-call`).set(bearer(directorToken)).send({});
    expect(res.status).toBe(409);
    expect(await prisma.interaction.count({ where: { clientId: ownerClientId } })).toBe(before);
  });

  it("409 «звук станции не настроен» — человеческим текстом, без имён переменных окружения", async () => {
    robot.clientResult = {
      ok: false,
      error: "На сервере не задано LIVE_VOICE_RTP_HOST и LIVE_VOICE_RTP_PORT — станция не сможет прислать звук разговора в CRM, робот возьмёт трубку и промолчит.",
    };
    const res = await request(app).post(`/api/v1/clients/${ownerClientId}/live-voice-call`).set(bearer(directorToken)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Звук станции на сервере не настроен, обратитесь к администратору");
    expect(res.body.error).not.toMatch(/LIVE_VOICE/);
  });
});

describe("№5 личность живого голоса — правила инструментов и превью", () => {
  it("охранник: стандартный текст проходит, обрезок без инструментов — нет", () => {
    expect(missingLiveVoiceToolRules(DEFAULT_LIVE_VOICE_PROMPT)).toEqual([]);
    expect(missingLiveVoiceToolRules("Говори тепло.")).toEqual(["save_contact", "end_call", "escalate_to_human"]);
    // Ошибка идёт на экран: человеческие названия, без имён функций (аудит экрана 02.10.2026).
    const error = liveVoicePromptToolRulesError("Говори тепло. save_contact end_call");
    expect(error).toMatch(/позвать человека/);
    expect(error).not.toMatch(/save_contact|end_call|escalate_to_human/);
  });

  it("PATCH своего текста без правил инструментов — 400 с названием недостающих", async () => {
    const res = await patchSettings({ liveVoicePrompt: "Ты весёлый консультант. Говори тепло." });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/записать контакт/);
    expect(res.body.error).not.toMatch(/save_contact|end_call|escalate_to_human/);
    const stored = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { liveVoicePrompt: true } });
    expect(stored.liveVoicePrompt).toBe(originalPrompt);
  });

  it("со всеми тремя правилами — сохраняется, пустая строка возвращает стандартный", async () => {
    const custom = "Ты весёлый консультант. Имя известно — save_contact молча. Конец — попрощайся и end_call. Просят человека — escalate_to_human.";
    const ok = await patchSettings({ liveVoicePrompt: custom });
    expect(ok.status).toBe(200);
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).liveVoicePrompt).toBe(custom);

    const reset = await patchSettings({ liveVoicePrompt: "" });
    expect(reset.status).toBe(200);
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).liveVoicePrompt).toBeNull();
  });

  it("превью голоса слышит свою личность из Настроек, а без неё — стандартную", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoicePrompt: "СВОЯ-ЛИЧНОСТЬ-ПРЕВЬЮ" } });
    grantElevation(director);
    const custom = await request(app).post("/api/v1/settings/live-voice/preview-voice").set(bearer(directorToken)).send({ voice: "Kore" });
    expect(custom.status).toBe(200);
    expect(robot.previewInstructions.at(-1)).toContain("СВОЯ-ЛИЧНОСТЬ-ПРЕВЬЮ");

    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoicePrompt: null } });
    const stock = await request(app).post("/api/v1/settings/live-voice/preview-voice").set(bearer(directorToken)).send({ voice: "Kore" });
    expect(stock.status).toBe(200);
    expect(robot.previewInstructions.at(-1)).not.toContain("СВОЯ-ЛИЧНОСТЬ-ПРЕВЬЮ");
    expect(robot.previewInstructions.at(-1)).toContain("save_contact");
  });
});

describe("превью голоса слышит правило рода, как настоящий звонок (аудит 02.10.2026)", () => {
  it("мужской голос — «МУЖСКИМ ГОЛОСОМ» в инструкции и «в мужском роде» в первой реплике; женский — зеркально", async () => {
    grantElevation(director);
    const male = await request(app).post("/api/v1/settings/live-voice/preview-voice").set(bearer(directorToken)).send({ voice: "Charon" });
    expect(male.status).toBe(200);
    expect(robot.previewInstructions.at(-1)).toContain("МУЖСКИМ ГОЛОСОМ");
    expect(robot.previewTriggers.at(-1)).toContain("(О себе — в мужском роде.)");

    const female = await request(app).post("/api/v1/settings/live-voice/preview-voice").set(bearer(directorToken)).send({ voice: "Kore" });
    expect(female.status).toBe(200);
    expect(robot.previewInstructions.at(-1)).toContain("ЖЕНСКИМ ГОЛОСОМ");
    expect(robot.previewTriggers.at(-1)).toContain("(О себе — в женском роде.)");
  });
});

describe("№16 проверочный звонок — номер в журнале под маской", () => {
  it("в meta журнала нет полного номера", async () => {
    const phone = `+992${tail()}`;
    grantElevation(director);
    const res = await request(app).post("/api/v1/settings/live-voice-test-call").set(bearer(directorToken)).send({ phone });
    expect(res.status).toBe(200);
    const row = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { action: "LIVE_VOICE_TEST_CALL", agentId: director }, orderBy: { createdAt: "desc" } })
    );
    const logged = (row.meta as { phone: string }).phone;
    expect(logged).not.toBe(phone);
    expect(logged.startsWith(phone.slice(0, 4))).toBe(true);
    expect(logged.endsWith(phone.slice(-2))).toBe(true);
  });
});

describe("№25 и №29 список разговоров и запись", () => {
  let recordingSessionId = "";

  beforeAll(async () => {
    const phoneInName = `+992${tail()}`;
    const named = await prisma.client.create({
      data: { fullName: `Звонил ${phoneInName}`, phone: `+992${tail()}`, source: "PHONE_CALL", assignedAgentId: director },
      select: { id: true },
    });
    clientIds.push(named.id);
    const base = Date.now() + 10 * 60_000; // свежее любых чужих строк — попадут в начало списка
    const rows = [
      { endedReason: "x".repeat(900), clientId: named.id, recordingUrl: "live-voice/test.wav", offset: 3 },
      { endedReason: "hangup", clientId: null, recordingUrl: null, offset: 2 },
      { endedReason: "hangup", clientId: null, recordingUrl: null, offset: 1 },
    ];
    for (const [i, r] of rows.entries()) {
      const created = await prisma.liveVoiceSession.create({
        data: {
          channelId: `robot-fix-${runId}-${i}`,
          startedAt: new Date(base + r.offset * 1000),
          endedReason: r.endedReason,
          clientId: r.clientId,
          recordingUrl: r.recordingUrl,
        },
        select: { id: true },
      });
      sessionIds.push(created.id);
      if (i === 0) recordingSessionId = created.id;
    }
  });

  it("limit ограничивает выборку, а выход за пределы — 400", async () => {
    const two = await request(app).get("/api/v1/settings/live-voice/sessions?limit=2").set(bearer(viewerToken));
    expect(two.status).toBe(200);
    expect(two.body.sessions).toHaveLength(2);
    for (const bad of ["0", "101", "abc"]) {
      const res = await request(app).get(`/api/v1/settings/live-voice/sessions?limit=${bad}`).set(bearer(viewerToken));
      expect(res.status).toBe(400);
    }
  });

  it("причина завершения режется до 200 знаков", async () => {
    const res = await request(app).get("/api/v1/settings/live-voice/sessions?limit=3").set(bearer(viewerToken));
    const long = res.body.sessions.find((s: { id: string }) => s.id === recordingSessionId);
    expect(long.endedReason).toHaveLength(200);
  });

  it("имя клиента с номером внутри: без права на телефон номер закрыт, с правом — как есть", async () => {
    const seen = await request(app).get("/api/v1/settings/live-voice/sessions?limit=3").set(bearer(viewerToken));
    const blind = await request(app).get("/api/v1/settings/live-voice/sessions?limit=3").set(bearer(blindToken));
    const pick = (body: { sessions: { id: string; client: { fullName: string } | null }[] }) =>
      body.sessions.find((s) => s.id === recordingSessionId)!.client!.fullName;
    expect(pick(seen.body)).toMatch(/\+992\d{9}/);
    expect(pick(blind.body)).not.toMatch(/\+992\d{9}/);
  });

  it("прослушивание записи ложится в журнал действий: кто и какой разговор", async () => {
    const res = await request(app)
      .get(`/api/v1/settings/live-voice/sessions/${recordingSessionId}/recording`)
      .set(bearer(viewerToken));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://r2.example/presigned");
    const row = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { action: "LIVE_VOICE_RECORDING_LISTEN", entityId: recordingSessionId } })
    );
    expect(row.entityType).toBe("LiveVoiceSession");
  });
});
