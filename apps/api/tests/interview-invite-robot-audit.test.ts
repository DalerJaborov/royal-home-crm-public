import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originateLiveVoiceScenarioCall = vi.fn(async (_phone: string, _task: Record<string, unknown>) => ({
  ok: true,
  channelId: `chan-audit-${Math.random()}`,
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

const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const {
  AUDIO_DEAD_REASON,
  countsAsCall,
  dialInterviewInviteCall,
  finishInterviewInviteCall,
  interviewInviteRefusal,
  interviewInviteStatusText,
  invitePhoneKey,
  isOurCallFailure,
  runInterviewInviteCallTick,
} = await import("../src/lib/interviewInviteCall.js");
const { buildInterviewInviteCallPrompt, spokenInterviewTimeRu, spokenInterviewTimeTg } = await import(
  "../src/ai/interviewInviteCallPersona.js"
);
const { normalizeInterviewInviteParse } = await import("../src/ai/interviewInviteCallParse.js");
const { presentInviteCall } = await import("../src/routes/vacancies.js");
const { findSilentInviteCalls, recallSilentInviteCalls, SILENT_WINDOW } = await import("../src/lib/silentInviteCalls.js");

/**
 * ПРОВЕРКА РОБОТА 02.10.2026 — звонок-приглашение кандидату.
 *
 * Робозвонок нашёл: время звучало цифрами (своя роль выкидывала общие правила
 * речи); наш сбой (обрыв модели, выкат, нет звука) записывался «не
 * дозвонились» и сжигал единственный звонок, а итог, потерянный на выкате,
 * сторож считал «не дозвонились»; без оценки уверенности любой ответ
 * становился «непонятно»; после переноса без робота анкета показывала старое
 * «придёт»; исправленный после «не тот человек» номер отвергался, а прежний
 * чужой номер получал звонок снова; после 14:45 HR не получал пуша; «послушайте
 * разговор» — а записи нет. Плюс немые звонки 28.09–03.10: разговора не было,
 * а «один звонок» не пускал позвонить снова.
 */

const tail = String(Date.now()).slice(-6);
const TEXT_AT = new Date("2026-09-29T06:00:00Z"); // вторник, 11:00 по Душанбе
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SHIFT_MS = Math.max(0, Math.ceil((Date.now() + 2 * 24 * 60 * 60 * 1000 - TEXT_AT.getTime()) / WEEK_MS)) * WEEK_MS;
const shifted = (iso: string): Date => new Date(Date.parse(iso) + SHIFT_MS);
const NOW = shifted("2026-09-28T05:00:00Z");
const INTERVIEW_AT = shifted("2026-09-29T06:00:00Z");
const CONV = `inv-audit-${tail}`;
const PHONE = `+99291${tail}4`;
const FIXED_PHONE = `+99291${tail}5`;
let appId = "";
let token = "";
let managerId = "";

async function cleanup(): Promise<void> {
  await prisma.jobApplication.deleteMany({ where: { conversationId: CONV } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "interview-invite-" }, title: { contains: tail } } });
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "interview-invite-" }, title: { contains: tail } } });
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { endsWith: `-${tail}` } } });
}

beforeAll(async () => {
  await cleanup();
  const manager = await prisma.agent.create({
    data: { fullName: `HR проверки ${tail}`, phone: `+99298${tail}9`, role: "MANAGER", passwordHash: "x" },
  });
  managerId = manager.id;
  token = signAccessToken({ sub: manager.id, role: "MANAGER" });
  appId = (
    await prisma.jobApplication.create({
      data: { conversationId: CONV, channel: "WHATSAPP", name: `Сухроб ${tail}`, phone: PHONE, status: "INTERVIEW", interviewAt: INTERVIEW_AT },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.agent.deleteMany({ where: { id: managerId } });
});

beforeEach(async () => {
  originateLiveVoiceScenarioCall.mockClear();
  parseInterviewInviteCall.mockReset();
  await prisma.interviewInviteCall.deleteMany({ where: { jobApplicationId: appId } });
  await prisma.jobApplication.update({ where: { id: appId }, data: { phone: PHONE, status: "INTERVIEW", interviewAt: INTERVIEW_AT } });
});

async function addCall(data: Record<string, unknown> = {}) {
  return prisma.interviewInviteCall.create({
    data: { jobApplicationId: appId, interviewAt: INTERVIEW_AT, scheduledFor: NOW, language: "ru", ...data },
  });
}

/** Набрать строку и вернуть канал, который «выдала станция». */
async function dial(id: string, at: Date = NOW): Promise<string> {
  expect(await dialInterviewInviteCall(id, at)).toBe("started");
  return (await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id } })).channelId!;
}

describe("время для голоса — словами", () => {
  it("по-русски: день, число и час так, как сказал бы человек", () => {
    expect(spokenInterviewTimeRu(TEXT_AT)).toBe("во вторник, двадцать девятого сентября, в одиннадцать часов утра");
    expect(spokenInterviewTimeRu(new Date("2026-10-01T09:30:00Z"))).toBe("в четверг, первого октября, в два тридцать дня");
    expect(spokenInterviewTimeRu(new Date("2026-10-21T08:05:00Z"))).toBe("в среду, двадцать первого октября, в час ноль пять дня");
    expect(spokenInterviewTimeRu(new Date("2026-10-30T12:00:00Z"))).toBe("в пятницу, тридцатого октября, в пять часов вечера");
  });

  it("по-таджикски: числа и порядковые словами", () => {
    expect(spokenInterviewTimeTg(TEXT_AT)).toBe("рӯзи сешанбе, бисту нӯҳуми сентябр, пагоҳӣ соати ёздаҳ");
    expect(spokenInterviewTimeTg(new Date("2026-10-01T09:30:00Z"))).toBe("рӯзи панҷшанбе, якуми октябр, рӯзона соати дую ним");
    expect(spokenInterviewTimeTg(new Date("2026-10-21T04:15:00Z"))).toBe("рӯзи чоршанбе, бисту якуми октябр, пагоҳӣ соати нӯҳу понздаҳ дақиқа");
    expect(spokenInterviewTimeTg(new Date("2026-09-30T04:00:00Z"))).toBe("рӯзи чоршанбе, сиюми сентябр, пагоҳӣ соати нӯҳ");
  });

  it("в промпте время словами и общие правила речи — цифр «11:00» нет", () => {
    for (const language of ["ru", "tg"] as const) {
      const prompt = buildInterviewInviteCallPrompt({ candidateName: "Сухроб", interviewAt: TEXT_AT, address: null, language });
      expect(prompt).not.toContain("11:00");
      expect(prompt).toContain("ЦИФРЫ, ЦЕНЫ И ПЛОЩАДЬ — ВСЕГДА СЛОВАМИ");
    }
    expect(buildInterviewInviteCallPrompt({ candidateName: null, interviewAt: TEXT_AT, address: null, language: "ru" })).toContain(
      "в одиннадцать часов утра"
    );
  });

  it("без вшитого имени и рода: голос в Настройках бывает и мужским", () => {
    for (const language of ["ru", "tg"] as const) {
      const prompt = buildInterviewInviteCallPrompt({ candidateName: "Сухроб", interviewAt: TEXT_AT, address: null, language });
      const role = prompt.slice(0, prompt.indexOf("</system_role>"));
      expect(role).not.toMatch(/Мадина|сотрудница|расслышала|Сама /);
    }
  });
});

describe("наш сбой не сжигает звонок", () => {
  it("какие причины — наши", () => {
    for (const r of ["gemini_error", "gemini_closed", "listener_stopped", "start_failed: boom", "rtp_socket_error", "no_station_audio", "no_caller_speech"]) {
      expect(isOurCallFailure(r)).toBe(true);
    }
    for (const r of ["channel_ended", "model_ended_call: answered", "max_duration", "transferred", ""]) {
      expect(isOurCallFailure(r)).toBe(false);
    }
  });

  it("обрыв модели — строка возвращается ОДИН раз, второй сбой — HR «сбой связи»", async () => {
    const call = await addCall();
    const first = await dial(call.id);
    await finishInterviewInviteCall({ channelId: first, transcript: [], reason: "gemini_error", clientSpoke: false }, NOW);
    const back = await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } });
    expect(back).toMatchObject({ status: "PENDING", attempts: 0, failureRetries: 1, channelId: null });
    expect(back.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `interview-invite-${call.id}` } })).toBe(0);

    const later = new Date(back.scheduledFor.getTime() + 60_000);
    const second = await dial(call.id, later);
    await finishInterviewInviteCall({ channelId: second, transcript: [], reason: "no_station_audio", clientSpoke: false }, later);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({
      status: "GIVEN_UP",
      skipReason: "robot_failed",
    });
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `interview-invite-${call.id}` } });
    expect(alert?.title).toContain("сбой связи");
  });

  it("итог потерян на выкате (моста записи нет) — сторож не пишет «не дозвонились», а возвращает строку", async () => {
    const call = await addCall({
      status: "CALLING",
      channelId: `lost-${tail}`,
      attempts: 1,
      lastAttemptAt: new Date(NOW.getTime() - 25 * 60 * 1000),
    });
    await runInterviewInviteCallTick(NOW);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({
      status: "PENDING",
      failureRetries: 1,
    });
  });

  it("итог потерян, но мост записал разговор — разбирается как обычно, с записью", async () => {
    const call = await addCall({
      status: "CALLING",
      channelId: `talked-${tail}`,
      attempts: 1,
      lastAttemptAt: new Date(NOW.getTime() - 25 * 60 * 1000),
    });
    await prisma.liveVoiceSession.create({
      data: {
        channelId: `talked-${tail}`,
        startedAt: new Date(NOW.getTime() - 25 * 60 * 1000),
        endedAt: new Date(NOW.getTime() - 22 * 60 * 1000),
        endedReason: "model_ended_call: answered",
        transcript: "Бот: Здравствуйте\nКлиент: да, приду",
        recordingUrl: `live-voice/talked-${tail}.wav`,
      },
    });
    parseInterviewInviteCall.mockResolvedValueOnce({ outcome: "CONFIRMED", confidence: 0.95, proposedTime: null, quote: "да, приду", summary: null });
    await runInterviewInviteCallTick(NOW);
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({
      status: "DONE",
      outcome: "CONFIRMED",
      recordingKey: `live-voice/talked-${tail}.wav`,
    });
  });
});

describe("чужой номер и исправленный номер", () => {
  it("после «трубку взял не он» на тот же номер робот не звонит ни про какое время", async () => {
    await addCall({ status: "GIVEN_UP", skipReason: "wrong_person", phone: invitePhoneKey(PHONE), attempts: 1 });
    const moved = new Date(INTERVIEW_AT.getTime() + 24 * 60 * 60 * 1000);
    const refusal = await interviewInviteRefusal({ jobApplicationId: appId, interviewAt: moved, phone: PHONE, now: NOW });
    expect(refusal?.reason).toBe("wrong_number");
    expect(refusal?.note).toContain("ответил не кандидат");
  });

  it("исправленный номер — робот звонит, и про то же время тоже", async () => {
    await addCall({ status: "GIVEN_UP", skipReason: "wrong_person", phone: invitePhoneKey(PHONE), attempts: 1 });
    const refusal = await interviewInviteRefusal({ jobApplicationId: appId, interviewAt: INTERVIEW_AT, phone: FIXED_PHONE, now: NOW });
    // live_voice_off зависит от общего тумблера, который соседние файлы переключают.
    expect(["wrong_number", "already_called"]).not.toContain(refusal?.reason);
  });

  it("звонок ждал очереди, а прежний на этот номер кончился «не тот человек» — набора нет, HR узнаёт", async () => {
    await addCall({ status: "GIVEN_UP", skipReason: "wrong_person", phone: invitePhoneKey(PHONE), attempts: 1, interviewAt: new Date(INTERVIEW_AT.getTime() - 3600_000) });
    const queued = await addCall();
    expect(await dialInterviewInviteCall(queued.id, NOW)).toBe("skipped");
    expect(originateLiveVoiceScenarioCall).not.toHaveBeenCalled();
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({
      status: "SKIPPED",
      skipReason: "wrong_number",
    });
  });

  it("набранный номер запоминается — последние девять цифр", async () => {
    const call = await addCall();
    await dial(call.id);
    expect((await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } })).phone).toBe(invitePhoneKey(PHONE));
    expect(invitePhoneKey("+992 91 123-45-67")).toBe(invitePhoneKey("911234567"));
  });

  it("немой звонок и сбой робота звонком не считаются", () => {
    expect(countsAsCall({ status: "DONE", skipReason: AUDIO_DEAD_REASON, phone: null }, null)).toBe(false);
    expect(countsAsCall({ status: "GIVEN_UP", skipReason: "robot_failed", phone: null }, null)).toBe(false);
    expect(countsAsCall({ status: "GIVEN_UP", skipReason: "no_answer", phone: null }, null)).toBe(true);
    expect(countsAsCall({ status: "DONE", skipReason: null, phone: null }, null)).toBe(true);
  });
});

describe("что видит HR", () => {
  it("«просил перезвонить» — слова человека сохраняются для HR", async () => {
    const call = await addCall();
    const channel = await dial(call.id);
    parseInterviewInviteCall.mockResolvedValueOnce({ outcome: "UNCLEAR", confidence: 0.9, proposedTime: null, quote: "наберите после шести", summary: "Просит позвонить после 18:00" });
    await finishInterviewInviteCall(
      { channelId: channel, transcript: ["Клиент: наберите после шести"], reason: "model_ended_call: call_back_later", clientSpoke: true },
      NOW
    );
    expect(await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({
      status: "GIVEN_UP",
      skipReason: "call_back_later",
      summary: "Просит позвонить после 18:00",
    });
  });

  it("линия занята — строка возвращается без прежнего канала", async () => {
    const call = await addCall({ channelId: `old-${tail}` });
    originateLiveVoiceScenarioCall.mockResolvedValueOnce({ ok: false, busy: true, error: "занята" } as never);
    expect(await dialInterviewInviteCall(call.id, NOW)).toBe("busy");
    expect((await prisma.interviewInviteCall.findUniqueOrThrow({ where: { id: call.id } })).channelId).toBeNull();
  });

  it("перенесли без робота — старое «придёт» не выдаётся за ответ про новое время", () => {
    const moved = new Date(INTERVIEW_AT.getTime() + 24 * 60 * 60 * 1000);
    const call = {
      status: "DONE",
      outcome: "CONFIRMED",
      proposedTime: null,
      summary: "Придёт",
      interviewAt: INTERVIEW_AT,
      talkedAt: NOW,
      skipReason: null,
      recordingKey: null,
    };
    const stale = presentInviteCall(call, { status: "INTERVIEW", interviewAt: moved });
    expect(stale?.text).toContain("прежнее время");
    expect(stale?.outcome).toBeNull();
    const fresh = presentInviteCall(call, { status: "INTERVIEW", interviewAt: INTERVIEW_AT });
    expect(fresh?.text).toBe("Робот позвонил: придёт");
    expect(fresh).not.toHaveProperty("recordingKey");
  });

  it("«послушайте разговор» — только когда запись есть", () => {
    const base = { status: "DONE", outcome: "UNCLEAR", proposedTime: null, skipReason: null };
    expect(interviewInviteStatusText({ ...base, recordingKey: "k" })).toContain("послушайте разговор");
    expect(interviewInviteStatusText({ ...base, recordingKey: null })).toContain("позвоните кандидату");
  });

  it("запись разговора: нет записи — 404", async () => {
    const res = await request(app).get(`/api/v1/vacancies/${appId}/invite-call-recording`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("запись разговора: есть — не 404 (ссылка из хранилища или честное «не ответило»)", async () => {
    await addCall({ status: "DONE", outcome: "UNCLEAR", recordingKey: `live-voice/x-${tail}.wav` });
    const res = await request(app).get(`/api/v1/vacancies/${appId}/invite-call-recording`).set("Authorization", `Bearer ${token}`);
    expect([200, 502]).toContain(res.status);
  });

  it("разбор: без оценки уверенности «придёт» не засчитывается, «отказ» остаётся отказом", () => {
    expect(normalizeInterviewInviteParse({ outcome: "CONFIRMED" }).outcome).toBe("UNCLEAR");
    expect(normalizeInterviewInviteParse({ outcome: "DECLINED" }).outcome).toBe("DECLINED");
    expect(normalizeInterviewInviteParse({ outcome: "CONFIRMED", confidence: 0.9 }).outcome).toBe("CONFIRMED");
  });
});

describe("немые звонки 28.09–03.10", () => {
  const inWindow = new Date(SILENT_WINDOW.from.getTime() + 60 * 60 * 1000);

  it("находит «не дозвонились» из немого периода и ставит новый звонок; второй прогон — пусто", async () => {
    const silent = await addCall({ status: "GIVEN_UP", skipReason: "no_answer", attempts: 1, lastAttemptAt: inWindow });
    const found = await findSilentInviteCalls(NOW);
    const mine = found.filter((c) => c.jobApplicationId === appId);
    expect(mine.map((c) => c.callId)).toEqual([silent.id]);

    expect(await recallSilentInviteCalls(mine, NOW)).toBe(1);
    const rows = await prisma.interviewInviteCall.findMany({ where: { jobApplicationId: appId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.skipReason])).toEqual([
      ["GIVEN_UP", AUDIO_DEAD_REASON],
      ["PENDING", null],
    ]);
    // Правило «один звонок» помеченный немой звонок не считает.
    const refusal = await interviewInviteRefusal({ jobApplicationId: appId, interviewAt: INTERVIEW_AT, phone: PHONE, now: NOW });
    expect(["wrong_number", "already_called"]).not.toContain(refusal?.reason);
    expect((await findSilentInviteCalls(NOW)).filter((c) => c.jobApplicationId === appId)).toEqual([]);
  });

  it("«ответ непонятен» из немого периода тоже, а звонок вне периода и прошедшее собеседование — нет", async () => {
    const unclear = await addCall({ status: "DONE", outcome: "UNCLEAR", attempts: 1, lastAttemptAt: inWindow });
    expect((await findSilentInviteCalls(NOW)).filter((c) => c.jobApplicationId === appId).map((c) => c.was)).toEqual(["unclear"]);
    await prisma.interviewInviteCall.update({ where: { id: unclear.id }, data: { lastAttemptAt: new Date(SILENT_WINDOW.to.getTime() + 3600_000) } });
    expect((await findSilentInviteCalls(NOW)).filter((c) => c.jobApplicationId === appId)).toEqual([]);
    await prisma.interviewInviteCall.update({ where: { id: unclear.id }, data: { lastAttemptAt: inWindow } });
    expect((await findSilentInviteCalls(new Date(INTERVIEW_AT.getTime() - 30 * 60 * 1000))).filter((c) => c.jobApplicationId === appId)).toEqual([]);
  });

  it("немой звонок «придёт» не считается прошлым приглашением при переносе", async () => {
    await addCall({ status: "DONE", outcome: "CONFIRMED", skipReason: AUDIO_DEAD_REASON, attempts: 1, interviewAt: new Date(INTERVIEW_AT.getTime() - 3600_000) });
    const call = await addCall();
    await dial(call.id);
    const prompt = String(originateLiveVoiceScenarioCall.mock.calls[0][1].systemInstruction);
    expect(prompt).not.toContain("ПЕРЕНЕСЛИ");
  });
});
