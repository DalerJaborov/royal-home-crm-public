import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originateLiveVoiceScenarioCall = vi.fn(async (_phone: string, _task: Record<string, unknown>) => ({
  ok: true,
  channelId: `chan-invite-${Math.random()}`,
}));
vi.mock("../src/lib/telephony/liveVoiceBridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  originateLiveVoiceScenarioCall,
}));

const parseInterviewInviteCall = vi.fn(async () => null as unknown);
vi.mock("../src/ai/interviewInviteCallParse.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseInterviewInviteCall,
}));

const { waitFor } = await import("./helpers/waitFor.js");
const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const {
  dialInterviewInviteCall,
  enqueueInterviewInviteCall,
  finishInterviewInviteCall,
  interviewInviteStatusText,
  runInterviewInviteCallTick,
  stationAudioDown,
} = await import("../src/lib/interviewInviteCall.js");
const { NO_STATION_AUDIO_REASON: DEAF } = await import("../src/lib/telephony/liveVoiceAudioPath.js");
const {
  buildInterviewInviteCallPrompt,
  interviewTimeRu,
  interviewTimeTg,
  spokenInterviewTimeRu,
  spokenInterviewTimeTg,
  INTERVIEW_INVITE_CALL_TOOLS,
} = await import(
  "../src/ai/interviewInviteCallPersona.js"
);
const { normalizeInterviewInviteParse } = await import("../src/ai/interviewInviteCallParse.js");

/**
 * РОБОТ ПРИГЛАШАЕТ КАНДИДАТА НА СОБЕСЕДОВАНИЕ (владелец 25.09.2026).
 *
 * Проверяется: кнопка ставит звонок только на настоящее собеседование с
 * номером; язык и голос — из переписки кандидата; переназначенное время гасит
 * старый звонок; ответ «придёт» HR не тревожит, «другое время» и «не
 * дозвонились» — тревожат.
 */

const tail = String(Date.now()).slice(-6);
// 10:00 по Душанбе — рабочие часы звонков. Даты сдвигаются на целые недели
// вперёд от настоящего «сейчас»: сервер честно не зовёт на собеседование в
// прошлом (vacancies.ts сверяет с Date.now()), и со вторника 29.09.2026 06:00 UTC
// жёстко вписанная дата роняла весь файл. Целые недели — тот же день недели и
// час, так что часы звонков и слова робота не меняются.
const TEXT_AT = new Date("2026-09-29T06:00:00Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SHIFT_MS = Math.max(0, Math.ceil((Date.now() + 2 * 24 * 60 * 60 * 1000 - TEXT_AT.getTime()) / WEEK_MS)) * WEEK_MS;
const shifted = (iso: string): Date => new Date(Date.parse(iso) + SHIFT_MS);
const NOW = shifted("2026-09-28T05:00:00Z");
const INTERVIEW_AT = shifted("2026-09-29T06:00:00Z");
const CONV_TG = `inv-call-tg-${tail}`;
const CONV_RU = `inv-call-ru-${tail}`;
const CONV_A = `inv-call-a-${tail}`;
const CONV_B = `inv-call-b-${tail}`;
const PHONE_A = `+99290${tail}2`;
const PHONE_B = `+99290${tail}3`;
let aId = "";
let bId = "";
let managerId = "";
let token = "";
let profileId = "";
let tgAppId = "";
let ruAppId = "";
let previous: {
  liveVoiceEnabled: boolean;
  liveVoiceVoiceName: string | null;
  liveVoiceVoiceNameTajik: string | null;
  interviewInviteAddress: string | null;
} | null = null;

async function cleanup(): Promise<void> {
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: [CONV_TG, CONV_RU, CONV_A, CONV_B] } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "interview-invite-" }, title: { contains: tail } } });
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "interview-invite-" }, title: { contains: tail } } });
  if (profileId) await prisma.contactProfile.deleteMany({ where: { id: profileId } });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { endsWith: `-${tail}` } } });
}

beforeAll(async () => {
  await cleanup();
  previous = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceEnabled: true, liveVoiceVoiceName: true, liveVoiceVoiceNameTajik: true, interviewInviteAddress: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { liveVoiceEnabled: true, liveVoiceVoiceName: "Kore", liveVoiceVoiceNameTajik: "Charon", interviewInviteAddress: "ул. Айни 45" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `HR приглашений ${tail}`, phone: `+99298${tail}8`, role: "MANAGER", passwordHash: "x" },
  });
  managerId = manager.id;
  token = signAccessToken({ sub: manager.id, role: "MANAGER" });
  const profile = await prisma.contactProfile.create({ data: { language: "tg" } });
  profileId = profile.id;
  tgAppId = (
    await prisma.jobApplication.create({
      data: {
        conversationId: CONV_TG,
        channel: "WHATSAPP",
        name: `Фарход ${tail}`,
        phone: `+99290${tail}1`,
        contactProfileId: profileId,
        status: "REVIEWED",
      },
    })
  ).id;
  ruAppId = (
    await prisma.jobApplication.create({
      data: { conversationId: CONV_RU, channel: "INSTAGRAM", name: `Анна ${tail}`, status: "REVIEWED" },
    })
  ).id;
  aId = (
    await prisma.jobApplication.create({
      data: { conversationId: CONV_A, channel: "WHATSAPP", name: `Ахмад ${tail}`, phone: PHONE_A, status: "INTERVIEW", interviewAt: INTERVIEW_AT },
    })
  ).id;
  bId = (
    await prisma.jobApplication.create({
      data: { conversationId: CONV_B, channel: "WHATSAPP", name: `Бахтиёр ${tail}`, phone: PHONE_B, status: "INTERVIEW", interviewAt: INTERVIEW_AT },
    })
  ).id;
  // Звук на линии жив к NOW: проход судит о звуке по журналу сессий, а соседние
  // файлы пишут туда и «нет звука» (в настоящем времени, раньше NOW).
  await prisma.liveVoiceSession.create({
    data: {
      channelId: `audio-ok-${tail}`,
      startedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      endedAt: new Date(NOW.getTime() - 60 * 1000),
      endedReason: "channel_ended",
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.agent.deleteMany({ where: { id: managerId } });
  if (previous) await prisma.settings.update({ where: { id: "singleton" }, data: previous });
});

beforeEach(() => {
  originateLiveVoiceScenarioCall.mockClear();
  parseInterviewInviteCall.mockReset();
});

function patch(id: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/v1/vacancies/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}

describe("слова робота", () => {
  it("называет день, число и час по Душанбе на обоих языках", () => {
    expect(interviewTimeRu(TEXT_AT)).toBe("во вторник, 29 сентября, в 11:00");
    expect(interviewTimeTg(TEXT_AT)).toBe("рӯзи сешанбе, 29 сентябр, соати 11:00");
  });

  it("таджикский разговор снимает замок на русский, русский — нет", () => {
    const tg = buildInterviewInviteCallPrompt({ candidateName: "Фарход", interviewAt: INTERVIEW_AT, address: null, language: "tg" });
    const ru = buildInterviewInviteCallPrompt({ candidateName: "Анна", interviewAt: INTERVIEW_AT, address: "ул. Айни 45", language: "ru" });
    expect(tg).toContain("ГОВОРИ ПО-ТАДЖИКСКИ");
    // Адрес в Настройках пуст — робот называет адрес офиса из общих фактов (28.09.2026).
    expect(tg).toContain("Бухоро 49");
    expect(ru).toContain("ГОВОРИ ПО-РУССКИ");
    expect(ru).toContain("ул. Айни 45");
    // Писал по-русски, ответил по-таджикски — переходит, а не извиняется (28.09).
    expect(ru).toContain("переходи на таджикский");
    // …и замка «только по-русски» в том же промпте нет: иначе две строки спорят,
    // и замок побеждает (02.10.2026).
    expect(ru).not.toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
    expect(tg).not.toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });

  it("не обещает перезвонить сам — второго звонка робота нет (владелец 01.10)", () => {
    const ru = buildInterviewInviteCallPrompt({ candidateName: "Анна", interviewAt: INTERVIEW_AT, address: null, language: "ru" });
    expect(ru).not.toContain("перезвонишь");
    expect(ru).toContain("с ним свяжутся позже");
    expect(ru).toContain("Перезвонить НЕ обещай");
    const endCall = INTERVIEW_INVITE_CALL_TOOLS.find((t) => t.name === "end_call");
    expect(JSON.stringify(endCall)).not.toContain("перезвонить");
    expect(JSON.stringify(endCall)).toContain("wrong_person");
  });

  it("перенос: называет прежнее время недействующим и не рассказывает о работе заново", () => {
    const moved = new Date(INTERVIEW_AT.getTime() + 24 * 60 * 60 * 1000);
    const first = buildInterviewInviteCallPrompt({ candidateName: "Анна", interviewAt: INTERVIEW_AT, address: null, language: "ru" });
    const ours = buildInterviewInviteCallPrompt({
      candidateName: "Анна",
      interviewAt: moved,
      address: null,
      language: "ru",
      previous: { interviewAt: INTERVIEW_AT, askedByCandidate: false },
    });
    const asked = buildInterviewInviteCallPrompt({
      candidateName: "Анна",
      interviewAt: moved,
      address: null,
      language: "ru",
      previous: { interviewAt: INTERVIEW_AT, askedByCandidate: true },
    });
    expect(first).not.toContain("ПЕРЕНЕСЛИ");
    expect(ours).toContain(`раньше мы уже звали его на ${spokenInterviewTimeRu(INTERVIEW_AT)}, это время БОЛЬШЕ НЕ ДЕЙСТВУЕТ`);
    expect(ours).toContain(`собеседование назначено ${spokenInterviewTimeRu(moved)}`);
    expect(ours).toContain("Извинись");
    expect(ours).toContain("О работе заново не рассказывай");
    expect(asked).toContain("по его же просьбе");
    expect(asked).toContain("как он и просил");
    expect(asked).not.toContain("Извинись");
  });

  it("неуверенный ответ не превращается в «придёт»", () => {
    expect(normalizeInterviewInviteParse({ outcome: "CONFIRMED", confidence: 0.4 }).outcome).toBe("UNCLEAR");
    expect(normalizeInterviewInviteParse({ outcome: "RESCHEDULE", confidence: 0.9, proposedTime: "в среду после обеда" })).toMatchObject({
      outcome: "RESCHEDULE",
      proposedTime: "в среду после обеда",
    });
  });
});

describe("сохранение встречи отдельно от подтверждённого приглашения", () => {
  it("старый запрос звонка без предпросмотра не меняет анкету; обычная запись встречи остаётся доступна", async () => {
    const res = await patch(ruAppId, { status: "INTERVIEW", interviewAt: INTERVIEW_AT.toISOString(), inviteCall: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECRUITMENT_PREVIEW_REQUIRED");
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: ruAppId } })).status).toBe("REVIEWED");
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: ruAppId } })).toBe(0);
    expect(await prisma.recruitmentCommunication.count({ where: { jobApplicationId: ruAppId } })).toBe(0);
    // Manual ATS scheduling is still valid and must not initiate either transport.
    await patch(ruAppId, { status: "INTERVIEW", interviewAt: INTERVIEW_AT.toISOString() }).expect(200);
    expect((await prisma.jobApplication.findUnique({ where: { id: ruAppId } }))?.status).toBe("INTERVIEW");
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: ruAppId } })).toBe(0);
  });

  it("историческая библиотека сохраняет язык и историю переноса; PATCH сам не создаёт звонок", async () => {
    await patch(tgAppId, { status: "INTERVIEW", interviewAt: INTERVIEW_AT.toISOString() }).expect(200);
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: tgAppId } })).toBe(0);
    // Synthetic historical fixture, not the retired public scheduling entry point.
    await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    const later = new Date(INTERVIEW_AT.getTime() + 60 * 60 * 1000);
    await patch(tgAppId, { interviewAt: later.toISOString() }).expect(200);
    await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: later, requestedById: managerId, now: NOW });
    const calls = await prisma.interviewInviteCall.findMany({ where: { jobApplicationId: tgAppId }, orderBy: { createdAt: "asc" } });
    expect(calls.map((c) => c.status)).toEqual(["CANCELLED", "PENDING"]);
    expect(calls[1].language).toBe("tg");
    expect(calls[1].interviewAt.toISOString()).toBe(later.toISOString());
    // Для следующих проверок — назад на исходное время.
    await prisma.jobApplication.update({ where: { id: tgAppId }, data: { interviewAt: INTERVIEW_AT } });
    await prisma.interviewInviteCall.deleteMany({ where: { jobApplicationId: tgAppId } });
  });
});

describe("звонок и итог", () => {
  it("звонит таджикским голосом без замка и пишет «придёт» без тревоги", async () => {
    await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    await runInterviewInviteCallTick(NOW);
    const mine = originateLiveVoiceScenarioCall.mock.calls.find((c) => c[0] === `+99290${tail}1`);
    expect(mine).toBeDefined();
    expect(mine![1]).toMatchObject({ voiceName: "Charon", forceRussianOnly: false });

    const call = await prisma.interviewInviteCall.findFirstOrThrow({ where: { jobApplicationId: tgAppId, status: "CALLING" } });
    parseInterviewInviteCall.mockResolvedValueOnce({
      outcome: "CONFIRMED",
      confidence: 0.95,
      proposedTime: null,
      quote: "ҳа, меоям",
      summary: "Придёт.",
    });
    await finishInterviewInviteCall(
      { channelId: call.channelId!, transcript: ["Клиент: ҳа, меоям"], reason: "model_ended_call: answered", clientSpoke: true },
      NOW
    );
    const done = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(done).toMatchObject({ status: "DONE", outcome: "CONFIRMED" });
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `interview-invite-${call.id}` } })).toBe(0);

    const list = await request(app)
      .get(`/api/v1/vacancies?q=${tail}&includeNoPhone=true`)
      .set("Authorization", `Bearer ${token}`);
    const item = (list.body.items as { id: string; inviteCall: { text: string } | null }[]).find((i) => i.id === tgAppId);
    expect(item?.inviteCall?.text).toBe("Робот позвонил: придёт");
  });

  it("«другое время» зовёт HR", async () => {
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    await runInterviewInviteCallTick(NOW);
    const call = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } });
    parseInterviewInviteCall.mockResolvedValueOnce({
      outcome: "RESCHEDULE",
      confidence: 0.9,
      proposedTime: "в среду после обеда",
      quote: null,
      summary: null,
    });
    await finishInterviewInviteCall(
      { channelId: call.channelId!, transcript: ["Клиент: лучше в среду"], reason: "model_ended_call: answered", clientSpoke: true },
      NOW
    );
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `interview-invite-${id}` } });
    expect(alert?.title).toContain("просит другое время");
    expect(alert?.recipientPermission).toBe("vacancies.view");
  });

  it("после разговора «другое время» новый звонок говорит о переносе по его просьбе", async () => {
    const moved = new Date(INTERVIEW_AT.getTime() + 24 * 60 * 60 * 1000);
    await prisma.jobApplication.update({ where: { id: tgAppId }, data: { interviewAt: moved } });
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: moved, requestedById: managerId, now: NOW });
    await runInterviewInviteCallTick(NOW);
    await prisma.jobApplication.update({ where: { id: tgAppId }, data: { interviewAt: INTERVIEW_AT } });
    const mine = originateLiveVoiceScenarioCall.mock.calls.find((c) => c[0] === `+99290${tail}1`);
    const prompt = String(mine![1].systemInstruction);
    expect(prompt).toContain(`раньше мы уже звали его на ${spokenInterviewTimeTg(INTERVIEW_AT)}`);
    expect(prompt).toContain("по его же просьбе");
    await prisma.interviewInviteCall.update({ where: { id }, data: { status: "CANCELLED" } });
  });

  it("то же время заново — не перенос", async () => {
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    await runInterviewInviteCallTick(NOW);
    const mine = originateLiveVoiceScenarioCall.mock.calls.find((c) => c[0] === `+99290${tail}1`);
    expect(String(mine![1].systemInstruction)).not.toContain("ПЕРЕНЕСЛИ");
    await prisma.interviewInviteCall.update({ where: { id }, data: { status: "CANCELLED" } });
  });

  it("ответ после часов алармов — сразу в ленту, без очереди до утра", async () => {
    // 18:50 по Душанбе: робот ещё звонит (до 19:00), окно алармов (до 14:45) закрыто.
    const evening = shifted("2026-09-28T13:50:00Z");
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    await runInterviewInviteCallTick(NOW);
    const call = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } });
    parseInterviewInviteCall.mockResolvedValueOnce({
      outcome: "RESCHEDULE",
      confidence: 0.9,
      proposedTime: "завтра после обеда",
      quote: null,
      summary: null,
    });
    await finishInterviewInviteCall(
      { channelId: call.channelId!, transcript: ["Клиент: давайте завтра после обеда"], reason: "model_ended_call: answered", clientSpoke: true },
      evening
    );
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `interview-invite-${id}` } })).toBe(0);
    // Лента пишется вместе с пушем «в отрыве» (push.ts) — ждём строку, а не читаем сразу.
    const feed = await waitFor(async () => {
      const rows = await prisma.notification.findMany({ where: { tag: `interview-invite-${id}` } });
      return rows.length > 0 ? rows : null;
    });
    expect(feed.length).toBeGreaterThan(0);
    expect(feed[0].title).toContain("просит другое время");
  });

  it("линия занята другим разговором — попытка не тратится, звонок сдвигается", async () => {
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    originateLiveVoiceScenarioCall.mockResolvedValueOnce({ ok: false, busy: true, error: "занята" } as never);
    await runInterviewInviteCallTick(NOW);
    const call = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } });
    expect(call).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(call.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
    await prisma.interviewInviteCall.update({ where: { id }, data: { status: "CANCELLED" } });
  });

  it("звук со станции не дошёл — не «не дозвонились»: попытка цела, звонок повторится, HR не тревожится", async () => {
    const { NO_STATION_AUDIO_REASON } = await import("../src/lib/telephony/liveVoiceAudioPath.js");
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    await runInterviewInviteCallTick(NOW);
    const calling = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } });
    expect(calling).toMatchObject({ status: "CALLING", attempts: 1 });
    await finishInterviewInviteCall(
      { channelId: calling.channelId!, transcript: [], reason: NO_STATION_AUDIO_REASON, clientSpoke: false },
      NOW
    );
    const call = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } });
    expect(call).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(call.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await prisma.pendingDirectorAlert.findFirst({ where: { tag: `interview-invite-${id}` } })).toBeNull();
    await prisma.interviewInviteCall.update({ where: { id }, data: { status: "CANCELLED" } });
  });

  // №172 (ночная проверка 24.09): «звоним» ставилось после набора — рестарт
  // между ними давал кандидату второй звонок. Теперь звонок занят ДО набора.
  it("в момент набора звонок уже занят", async () => {
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    let statusDuringDial: string | null = null;
    originateLiveVoiceScenarioCall.mockImplementationOnce(async () => {
      statusDuringDial = (await prisma.interviewInviteCall.findUnique({ where: { id } }))?.status ?? null;
      return { ok: true, channelId: `chan-invite-claim-${tail}` };
    });
    await runInterviewInviteCallTick(NOW);
    expect(statusDuringDial).toBe("CALLING");
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "CALLING",
      channelId: `chan-invite-claim-${tail}`,
      attempts: 1,
    });
    await prisma.interviewInviteCall.update({ where: { id }, data: { status: "CANCELLED" } });
  });

  it("не дозвонились — второго звонка нет, HR узнаёт сразу (владелец 01.10: «одного раза звонка достаточно»)", async () => {
    const { id } = await enqueueInterviewInviteCall({ jobApplicationId: tgAppId, interviewAt: INTERVIEW_AT, requestedById: managerId, now: NOW });
    await runInterviewInviteCallTick(NOW);
    const call = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } });
    expect(call.status).toBe("CALLING");
    await finishInterviewInviteCall({ channelId: call.channelId!, transcript: [], reason: "channel_ended", clientSpoke: false }, NOW);
    const final = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } });
    expect(final).toMatchObject({ status: "GIVEN_UP", attempts: 1 });
    originateLiveVoiceScenarioCall.mockClear();
    await runInterviewInviteCallTick(new Date(NOW.getTime() + 2 * 60 * 60 * 1000));
    expect(originateLiveVoiceScenarioCall.mock.calls.some((c) => c[0] === `+99290${tail}1`)).toBe(false);
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `interview-invite-${id}` } });
    expect(alert?.title).toContain("не дозвонились");
  });
});

/** Строки звонков для анкет A и B — заводятся прямо в базе. */
async function addCall(jobApplicationId: string, data: Record<string, unknown> = {}) {
  return prisma.interviewInviteCall.create({
    data: { jobApplicationId, interviewAt: INTERVIEW_AT, scheduledFor: NOW, language: "ru", ...data },
  });
}

async function alertTitle(id: string): Promise<string | null> {
  const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `interview-invite-${id}` } });
  return alert?.title ?? null;
}

describe("дыры робота-приглашения (разбор 02.10.2026)", () => {
  beforeEach(async () => {
    await prisma.interviewInviteCall.deleteMany({ where: { jobApplicationId: { in: [aId, bId, tgAppId] } } });
    await prisma.jobApplication.updateMany({
      where: { id: { in: [aId, bId] } },
      data: { status: "INTERVIEW", interviewAt: INTERVIEW_AT },
    });
    await prisma.jobApplication.update({ where: { id: aId }, data: { phone: PHONE_A } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true, interviewInviteAddress: "ул. Айни 45" } });
  });

  it("R1: за проход набирается один кандидат — второй ждёт свободной линии", async () => {
    const a = await addCall(aId);
    const b = await addCall(bId);
    expect(await runInterviewInviteCallTick(NOW)).toBe(1);
    const dialed = originateLiveVoiceScenarioCall.mock.calls.filter((c) => c[0] === PHONE_A || c[0] === PHONE_B);
    expect(dialed).toHaveLength(1);
    const rows = await prisma.interviewInviteCall.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.map((r) => r.status).sort()).toEqual(["CALLING", "PENDING"]);
  });

  it("R1: линия занята — проход останавливается, ни одна попытка не тратится", async () => {
    const a = await addCall(aId);
    const b = await addCall(bId);
    originateLiveVoiceScenarioCall.mockResolvedValueOnce({ ok: false, busy: true, error: "занята" } as never);
    expect(await runInterviewInviteCallTick(NOW)).toBe(0);
    expect(originateLiveVoiceScenarioCall.mock.calls.filter((c) => c[0] === PHONE_A || c[0] === PHONE_B)).toHaveLength(1);
    const rows = await prisma.interviewInviteCall.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((r) => r.status === "PENDING" && r.attempts === 0)).toBe(true);
  });

  it("R3: станция не приняла набор — звонка не было: попытка цела, повтор позже, «не дозвонились» не пишется", async () => {
    const a = await addCall(aId);
    originateLiveVoiceScenarioCall.mockResolvedValueOnce({ ok: false, error: "станция недоступна" } as never);
    await runInterviewInviteCallTick(NOW);
    const after = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ status: "PENDING", attempts: 0, skipReason: "dial_failed" });
    expect(after.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await alertTitle(a.id)).toBeNull();

    // Так и не вышло до часа перед собеседованием — HR узнаёт правду.
    await runInterviewInviteCallTick(new Date(INTERVIEW_AT.getTime() - 30 * 60 * 1000));
    const final = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } });
    expect(final).toMatchObject({ status: "SKIPPED", skipReason: "dial_failed", attempts: 0 });
    const title = await alertTitle(a.id);
    expect(title).toContain("робот не смог позвонить");
    expect(title).not.toContain("не дозвонились");
  });

  it("R4: опоздавший звонок гаснет не молча — HR получает уведомление", async () => {
    const soon = new Date(NOW.getTime() + 30 * 60 * 1000);
    await prisma.jobApplication.update({ where: { id: aId }, data: { interviewAt: soon } });
    const a = await addCall(aId, { interviewAt: soon });
    await runInterviewInviteCallTick(NOW);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "SKIPPED",
      skipReason: "too_late",
    });
    expect(await alertTitle(a.id)).toContain("не успел позвонить");
    expect(originateLiveVoiceScenarioCall.mock.calls.some((c) => c[0] === PHONE_A)).toBe(false);
  });

  it("R4: номер пропал к моменту звонка — HR получает уведомление", async () => {
    await prisma.jobApplication.update({ where: { id: aId }, data: { phone: null } });
    const a = await addCall(aId);
    await runInterviewInviteCallTick(NOW);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "SKIPPED",
      skipReason: "no_phone",
    });
    expect(await alertTitle(a.id)).toContain("нет номера");
  });

  it("R4: зависший звонок разбирается и при выключенном живом голосе", async () => {
    const a = await addCall(aId, {
      status: "CALLING",
      channelId: `stuck-${tail}`,
      attempts: 1,
      lastAttemptAt: new Date(NOW.getTime() - 25 * 60 * 1000),
    });
    // Мост записал конец разговора: трубку не взяли, итог просто не дошёл.
    await prisma.liveVoiceSession.create({
      data: { channelId: `stuck-${tail}`, startedAt: new Date(NOW.getTime() - 25 * 60 * 1000), endedAt: NOW, endedReason: "channel_ended" },
    });
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: false } });
    await runInterviewInviteCallTick(NOW);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "GIVEN_UP",
      skipReason: "no_answer",
    });
    expect(await alertTitle(a.id)).toContain("не дозвонились");
  });

  it("R9: разговор длиннее десяти минут — ещё не «не дозвонились» (потолок моста 15 мин)", async () => {
    const a = await addCall(aId, {
      status: "CALLING",
      channelId: `long-${tail}`,
      attempts: 1,
      lastAttemptAt: new Date(NOW.getTime() - 12 * 60 * 1000),
    });
    await prisma.liveVoiceSession.create({
      data: { channelId: `long-${tail}`, startedAt: new Date(NOW.getTime() - 12 * 60 * 1000), endedAt: NOW, endedReason: "channel_ended" },
    });
    await runInterviewInviteCallTick(NOW);
    expect((await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CALLING");
    await runInterviewInviteCallTick(new Date(NOW.getTime() + 9 * 60 * 1000));
    expect((await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("GIVEN_UP");
  });

  it("R5: у анкеты ещё идёт прежний звонок — второй параллельно не набирается", async () => {
    const earlier = new Date(INTERVIEW_AT.getTime() - 24 * 60 * 60 * 1000);
    await addCall(aId, { interviewAt: earlier, status: "CALLING", channelId: `old-${tail}`, attempts: 1, lastAttemptAt: NOW });
    const a = await addCall(aId);
    await runInterviewInviteCallTick(NOW);
    expect(originateLiveVoiceScenarioCall.mock.calls.some((c) => c[0] === PHONE_A)).toBe(false);
    const after = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(after.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("R6: «придёт», а адреса в настройках нет — HR просят отправить адрес", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { interviewInviteAddress: null } });
    const a = await addCall(aId);
    await runInterviewInviteCallTick(NOW);
    const calling = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } });
    parseInterviewInviteCall.mockResolvedValueOnce({ outcome: "CONFIRMED", confidence: 0.95, proposedTime: null, quote: null, summary: null });
    await finishInterviewInviteCall(
      { channelId: calling.channelId!, transcript: ["Клиент: приду"], reason: "model_ended_call: answered", clientSpoke: true },
      NOW
    );
    expect(await alertTitle(a.id)).toContain("отправьте ему адрес");
  });

  it("R6: «придёт» с адресом в настройках — HR не тревожат", async () => {
    const a = await addCall(aId);
    await runInterviewInviteCallTick(NOW);
    const calling = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } });
    parseInterviewInviteCall.mockResolvedValueOnce({ outcome: "CONFIRMED", confidence: 0.95, proposedTime: null, quote: null, summary: null });
    await finishInterviewInviteCall(
      { channelId: calling.channelId!, transcript: ["Клиент: приду"], reason: "model_ended_call: answered", clientSpoke: true },
      NOW
    );
    expect(await alertTitle(a.id)).toBeNull();
  });

  it("R8: два прохода разом не набирают одного кандидата дважды", async () => {
    const a = await addCall(aId);
    const outcomes = await Promise.all([dialInterviewInviteCall(a.id, NOW), dialInterviewInviteCall(a.id, NOW)]);
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(originateLiveVoiceScenarioCall.mock.calls.filter((c) => c[0] === PHONE_A)).toHaveLength(1);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "CALLING", attempts: 1 });
  });

  it("R10: трубку взял не кандидат / просил перезвонить — HR знает, что робот больше не звонит", async () => {
    const a = await addCall(aId);
    const b = await addCall(bId);
    await dialInterviewInviteCall(a.id, NOW);
    await dialInterviewInviteCall(b.id, NOW);
    const [ca, cb] = await Promise.all([
      prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } }),
      prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: b.id } }),
    ]);
    await finishInterviewInviteCall({ channelId: ca.channelId!, transcript: ["Клиент: его нет"], reason: "model_ended_call: wrong_person", clientSpoke: true }, NOW);
    await finishInterviewInviteCall({ channelId: cb.channelId!, transcript: ["Клиент: я за рулём"], reason: "model_ended_call: call_back_later", clientSpoke: true }, NOW);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "GIVEN_UP", skipReason: "wrong_person" });
    expect(await alertTitle(a.id)).toContain("трубку взял не кандидат — робот больше не звонит");
    expect(await alertTitle(b.id)).toContain("просил перезвонить — робот больше не звонит");
    expect(await alertTitle(a.id)).not.toContain("не дозвонились");
  });

  it("строка в карточке называет каждую причину словами", () => {
    const t = (status: string, skipReason: string | null) => interviewInviteStatusText({ status, outcome: null, proposedTime: null, skipReason });
    expect(t("SKIPPED", "too_late")).toContain("не успел позвонить");
    expect(t("SKIPPED", "no_phone")).toContain("нет номера");
    expect(t("SKIPPED", "not_dialable")).toContain("не похож на таджикский");
    expect(t("SKIPPED", "live_voice_off")).toContain("выключены");
    expect(t("SKIPPED", "dial_failed")).toBe("Робот не смог позвонить — позвоните кандидату сами");
    expect(t("SKIPPED", "status_changed")).toContain("другой этап");
    expect(t("SKIPPED", "time_changed")).toContain("время собеседования поменяли");
    expect(t("GIVEN_UP", "wrong_person")).toContain("Трубку взял не кандидат");
    expect(t("GIVEN_UP", "call_back_later")).toContain("просил перезвонить");
    expect(t("GIVEN_UP", "no_answer")).toContain("не дозвонился");
    expect(t("GIVEN_UP", null)).toContain("не дозвонился");
  });
});

describe("нет звука на линии — кандидатам не звоним (03.10.2026)", () => {
  const at = (sec: number): Date => new Date(NOW.getTime() + sec * 1000);
  const made: string[] = [];
  async function session(name: string, fromSec: number, toSec: number, endedReason: string): Promise<void> {
    const channelId = `${name}-${tail}`;
    made.push(channelId);
    await prisma.liveVoiceSession.create({ data: { channelId, startedAt: at(fromSec), endedAt: at(toSec), endedReason } });
  }

  beforeEach(async () => {
    await prisma.interviewInviteCall.deleteMany({ where: { jobApplicationId: { in: [aId, bId] } } });
    await prisma.jobApplication.update({ where: { id: aId }, data: { status: "INTERVIEW", interviewAt: INTERVIEW_AT, phone: PHONE_A } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true } });
  });

  afterEach(async () => {
    await prisma.liveVoiceSession.deleteMany({ where: { channelId: { in: made.splice(0) } } });
  });

  it("последняя сессия кончилась «нет звука» — звонок ждёт, попытка цела; короткая сессия звук не доказывает, долгая — да", async () => {
    await session("deaf", 60, 66, DEAF);
    const a = await addCall(aId);
    expect(await runInterviewInviteCallTick(at(120))).toBe(0);
    expect(originateLiveVoiceScenarioCall.mock.calls.filter((c) => c[0] === PHONE_A)).toHaveLength(0);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "PENDING", attempts: 0 });

    // Положили трубку через три секунды — сторож звука не успел ничего сказать.
    await session("short", 130, 133, "channel_ended");
    expect(await stationAudioDown(at(140))).toBe(true);
    // Разговор дольше сторожа — звук со станции шёл.
    await session("heard", 150, 180, "channel_ended");
    expect(await stationAudioDown(at(190))).toBe(false);
  });

  it("звук так и не вернулся до собеседования — HR узнаёт настоящую причину, а не «не успел»", async () => {
    await session("deaf2", 60, 66, DEAF);
    const a = await addCall(aId);
    await runInterviewInviteCallTick(new Date(INTERVIEW_AT.getTime() - 30 * 60 * 1000));
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "SKIPPED",
      skipReason: "audio_down",
    });
    expect(await alertTitle(a.id)).toContain("нет звука");
  });
});

describe("PATCH: старый автоматический запуск закрыт; исторические записи сохраняются", () => {
  beforeEach(async () => {
    await prisma.interviewInviteCall.deleteMany({ where: { jobApplicationId: { in: [aId, bId] } } });
    await prisma.jobApplication.updateMany({ where: { id: { in: [aId, bId] } }, data: { status: "REVIEWED", interviewAt: null } });
    await prisma.jobApplication.update({ where: { id: aId }, data: { phone: PHONE_A } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true } });
  });

  it("выключенный голос не позволяет обойти требование предпросмотра", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: false } });
    const res = await patch(aId, { status: "INTERVIEW", interviewAt: INTERVIEW_AT.toISOString(), inviteCall: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECRUITMENT_PREVIEW_REQUIRED");
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: aId } })).toBe(0);
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: aId } })).status).toBe("REVIEWED");
  });

  it("близкое время встречи не позволяет обойти требование предпросмотра", async () => {
    const soon = new Date(Date.now() + 30 * 60 * 1000);
    const res = await patch(aId, { status: "INTERVIEW", interviewAt: soon.toISOString(), inviteCall: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECRUITMENT_PREVIEW_REQUIRED");
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: aId } })).toBe(0);
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: aId } })).interviewAt).toBeNull();
  });

  it("неподдерживаемый номер не превращает старый PATCH в команду отправки", async () => {
    await prisma.jobApplication.update({ where: { id: aId }, data: { phone: "+79991234567" } });
    const res = await patch(aId, { status: "INTERVIEW", interviewAt: INTERVIEW_AT.toISOString(), inviteCall: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECRUITMENT_PREVIEW_REQUIRED");
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: aId } })).toBe(0);
  });

  it("R5: закрытый PATCH не меняет уже состоявшийся исторический звонок", async () => {
    await prisma.jobApplication.update({ where: { id: aId }, data: { status: "INTERVIEW", interviewAt: INTERVIEW_AT } });
    const original = await addCall(aId, { status: "DONE", outcome: "CONFIRMED", attempts: 1 });
    const res = await patch(aId, { status: "INTERVIEW", interviewAt: INTERVIEW_AT.toISOString(), inviteCall: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECRUITMENT_PREVIEW_REQUIRED");
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: aId, status: "PENDING" } })).toBe(0);
  });

  it("R5: закрытый PATCH не меняет текущий исторический звонок", async () => {
    await prisma.jobApplication.update({ where: { id: aId }, data: { status: "INTERVIEW", interviewAt: INTERVIEW_AT } });
    const original = await addCall(aId, { status: "CALLING", channelId: `now-${tail}`, attempts: 1, lastAttemptAt: new Date() });
    const res = await patch(aId, { interviewAt: INTERVIEW_AT.toISOString(), inviteCall: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECRUITMENT_PREVIEW_REQUIRED");
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: aId, status: "PENDING" } })).toBe(0);
  });

  it("R11: отказ кандидату гасит ждущий звонок в той же записи", async () => {
    await prisma.jobApplication.update({ where: { id: aId }, data: { status: "INTERVIEW", interviewAt: INTERVIEW_AT } });
    await addCall(aId);
    await patch(aId, { status: "REJECTED" }).expect(200);
    const calls = await prisma.interviewInviteCall.findMany({ where: { jobApplicationId: aId } });
    expect(calls.map((c) => c.status)).toEqual(["CANCELLED"]);
  });

  it("R11: время сменили без галочки — старый звонок гаснет", async () => {
    await prisma.jobApplication.update({ where: { id: aId }, data: { status: "INTERVIEW", interviewAt: INTERVIEW_AT } });
    await addCall(aId);
    const later = new Date(INTERVIEW_AT.getTime() + 2 * 60 * 60 * 1000);
    const res = await patch(aId, { interviewAt: later.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.inviteCallQueued).toBe(false);
    const calls = await prisma.interviewInviteCall.findMany({ where: { jobApplicationId: aId } });
    expect(calls.map((c) => c.status)).toEqual(["CANCELLED"]);
  });

  it("R11: правка заметки без смены времени звонок не трогает", async () => {
    await prisma.jobApplication.update({ where: { id: aId }, data: { status: "INTERVIEW", interviewAt: INTERVIEW_AT } });
    const original = await addCall(aId);
    await patch(aId, { interviewNote: "взять резюме", interviewAt: INTERVIEW_AT.toISOString() }).expect(200);
    const calls = await prisma.interviewInviteCall.findMany({ where: { jobApplicationId: aId } });
    expect(calls.map((c) => c.status)).toEqual(["PENDING"]);
    expect(calls[0]).toEqual(original);
  });
});
