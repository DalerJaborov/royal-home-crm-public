import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЗАЩИТА РОБОТА-КОНСУЛЬТАНТА (02.10.2026) — то, чем звонящий мог воспользоваться
 * против агентства или третьих людей:
 *  - СМС со ссылками на любой продиктованный номер, сколько угодно раз (по звонку
 *    на каждое СМС) — теперь не больше двух на номер за сутки по Душанбе и не на
 *    номер, записанный в CRM за другим человеком;
 *  - звонок с подменённого номера переименовывал владельца номера в досье;
 *  - код карточки CRM попадал в промт голоса.
 *
 * Отправка СМС подменена (здесь важно, ДОШЛО ли дело до отправки), прошлые
 * отправки кладутся строками журнала SmsMessage — по нему и считается предел.
 */

const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }));
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sms/index.js")>()),
  sendSms,
}));

const { prisma } = await import("../src/db.js");
const { handlePropertyTool, newPropertyCallMemory, SMS_PER_RECIPIENT_PER_DAY } = await import(
  "../src/lib/telephony/liveVoicePropertyTools.js"
);
const { handleConsultantTool, identifyCaller } = await import("../src/lib/telephony/liveVoiceConsultant.js");
const { attachContactProfile, setContactSelfName, CALL_NAME_FACT_KEY } = await import("../src/lib/contactProfiles.js");
const { contactProfileForPrompt } = await import("../src/lib/contactProfileMemory.js");
const { contactProfileBlock } = await import("../src/ai/contactProfileBlock.js");
const { dushanbeStartOfToday } = await import("../src/lib/dushanbeTime.js");
const { formatClientCode } = await import("@royal-home/shared");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

// Девять цифр после 992 — свои на каждый прогон, одной длины в пределах файла.
const tail = () => String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
const CALLER = tail();
const VICTIM = tail();
const OTHER_CLIENT = tail();
const OWN_EXTRA = tail();
const STAFF = tail();
const SPOOFED = tail();
const CARD_OWNER = tail();
const ALL_PHONES = [CALLER, VICTIM, OTHER_CLIENT, OWN_EXTRA, STAFF, SPOOFED, CARD_OWNER];

const runId = Date.now().toString(36);
const agentIds: string[] = [];
const clientIds: string[] = [];
let property = { id: "", shortId: 0 };
let callerClientId = "";

const call = (name: string, args: Record<string, unknown>) => ({ id: "c", name, args });

/** Звонок, в котором обсуждали наш объект; номер для СМС — продиктованный или номер звонка. */
function memoryFor(opts: { dictated?: string; clientId?: string | null } = {}) {
  const memory = newPropertyCallMemory({ callerPhone: `+992${CALLER}`, clientId: opts.clientId ?? null });
  memory.discussedShortIds.push(property.shortId);
  if (opts.dictated) memory.otherPhone = opts.dictated;
  return memory;
}

async function seedSent(phoneTail: string, count: number, at: Date, status = "SENT") {
  for (let i = 0; i < count; i++) {
    await prisma.smsMessage.create({
      data: { phone: `992${phoneTail}`, purpose: "CALL_PROPERTIES", text: `тест ${runId}`, status, createdAt: at },
    });
  }
}

beforeAll(async () => {
  const agentId = await createTestAgent("Сотрудник Номеров");
  agentIds.push(agentId);
  await prisma.agent.update({ where: { id: agentId }, data: { phone: `+992${STAFF}` } });
  const p = await prisma.property.create({
    data: {
      title: `Защита-${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 500_000,
      currency: "TJS",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
    } as never,
    select: { id: true, shortId: true },
  });
  property = p;
  const other = await prisma.client.create({
    data: { fullName: `Чужой клиент ${runId}`, phone: `+992${OTHER_CLIENT}`, source: "PHONE_CALL" },
    select: { id: true },
  });
  const own = await prisma.client.create({
    data: { fullName: `Звонящий ${runId}`, phone: `+992${CALLER}`, extraPhones: [`+992${OWN_EXTRA}`], source: "PHONE_CALL" },
    select: { id: true },
  });
  callerClientId = own.id;
  clientIds.push(other.id, own.id);
});

afterAll(async () => {
  await prisma.smsMessage.deleteMany({ where: { phone: { in: ALL_PHONES.map((p) => `992${p}`) } } });
  const identities = await prisma.contactIdentity.findMany({
    where: { OR: ALL_PHONES.map((p) => ({ value: { contains: p } })) },
    select: { profileId: true },
  });
  await prisma.contactProfile.deleteMany({ where: { id: { in: identities.map((i) => i.profileId) } } });
  await prisma.property.deleteMany({ where: { id: property.id } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

beforeEach(() => {
  sendSms.mockReset();
  sendSms.mockResolvedValue({ ok: true, id: "sms-1", parts: 1 });
});

describe("СМС со ссылками: предел на номер за сутки", () => {
  it(`на номер, куда сегодня уже ушло ${SMS_PER_RECIPIENT_PER_DAY}, третье не шлётся — модель слышит «агент пришлёт»`, async () => {
    await seedSent(VICTIM, SMS_PER_RECIPIENT_PER_DAY, new Date());
    const reply = await handlePropertyTool(memoryFor({ dictated: `+992 ${VICTIM}` }), call("send_property_sms", {}));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(String(reply?.response.error)).toContain("агент");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("вчерашние и неудачные отправки не в счёт", async () => {
    const yesterday = new Date(dushanbeStartOfToday().getTime() - 60 * 60_000);
    await seedSent(CALLER, SMS_PER_RECIPIENT_PER_DAY, yesterday);
    await seedSent(CALLER, 3, new Date(), "FAILED");
    await seedSent(CALLER, SMS_PER_RECIPIENT_PER_DAY - 1, new Date());
    const reply = await handlePropertyTool(memoryFor(), call("send_property_sms", {}));
    expect(reply?.response).toEqual({ ok: true, sent: 1 });
    expect((sendSms.mock.calls[0][0] as { phone: string }).phone).toBe(`+992${CALLER}`);
  });
});

describe("СМС со ссылками: продиктованный номер другого человека", () => {
  it("номер чужой карточки клиента — отказ, СМС не уходит", async () => {
    const reply = await handlePropertyTool(memoryFor({ dictated: `+992${OTHER_CLIENT}` }), call("send_property_sms", {}));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(String(reply?.response.error)).toContain("другим человеком");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("номер сотрудника — отказ", async () => {
    const reply = await handlePropertyTool(memoryFor({ dictated: `0${STAFF}` }), call("send_property_sms", {}));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("запасной номер СВОЕЙ карточки звонящего — можно", async () => {
    const reply = await handlePropertyTool(
      memoryFor({ dictated: `+992${OWN_EXTRA}`, clientId: callerClientId }),
      call("send_property_sms", {})
    );
    expect(reply?.response).toEqual({ ok: true, sent: 1 });
    expect((sendSms.mock.calls[0][0] as { phone: string }).phone).toBe(`+992${OWN_EXTRA}`);
  });

  it("номер звонка, совпавший с карточкой, — свой, его не проверяем как чужой", async () => {
    // Звонящий продиктовал тот же номер, с которого звонит, — это не «другой человек».
    const reply = await handlePropertyTool(memoryFor({ dictated: `+992${CALLER}` }), call("send_property_sms", {}));
    expect(reply?.response).toMatchObject({ ok: true });
  });
});

describe("подменённый номер не переписывает чужое досье", () => {
  it("имя в досье уже есть — новое не затирает его, а ложится фактом «Прочее»", async () => {
    const profileId = await attachContactProfile({
      existingProfileId: null,
      identities: [{ kind: "PHONE", value: `+992${SPOOFED}`, trust: "TRANSPORT" }],
      link: async () => {},
    });
    expect(profileId).toBeTruthy();
    await setContactSelfName(profileId!, "Меҳрона");

    const who = await identifyCaller({ channelId: `spoof-${runId}`, direction: "test", callerNumber: `+992${SPOOFED}` });
    expect(who.contactProfileId).toBe(profileId);
    const state = {
      channelId: `spoof-${runId}`,
      direction: "test" as const,
      contactProfileId: who.contactProfileId,
      name: null,
      otherPhone: null,
      summary: null,
      incomingCallId: null,
      properties: newPropertyCallMemory({ callerPhone: who.phone, clientId: null }),
    };
    await handleConsultantTool(state, call("save_contact", { name: "Зарина" }));

    const row = await prisma.contactProfile.findUnique({ where: { id: profileId! }, select: { displayName: true, nameSource: true, facts: true } });
    expect(row?.displayName).toBe("Меҳрона");
    expect(row?.nameSource).toBe("self");
    const misc = (row?.facts as { misc?: Record<string, { v: unknown }> }).misc ?? {};
    expect(misc[CALL_NAME_FACT_KEY]?.v).toBe("Зарина");
    // В разговоре робот всё равно зовёт человека так, как он представился.
    expect(state.name).toBe("Зарина");

    // То же имя другим регистром — не расхождение: факт не переписывается.
    await handleConsultantTool(state, call("save_contact", { name: "МЕҲРОНА" }));
    const again = await prisma.contactProfile.findUnique({ where: { id: profileId! }, select: { displayName: true, facts: true } });
    expect(again?.displayName).toBe("Меҳрона");
    expect(((again?.facts as { misc?: Record<string, { v: unknown }> }).misc ?? {})[CALL_NAME_FACT_KEY]?.v).toBe("Зарина");
  });

  it("досье в промте голоса — без кода карточки CRM; чат-бот видит его как раньше", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Владелец ${runId}`, phone: `+992${CARD_OWNER}`, source: "PHONE_CALL" },
      select: { id: true, shortId: true, kind: true },
    });
    clientIds.push(client.id);
    const profileId = await attachContactProfile({
      existingProfileId: null,
      identities: [{ kind: "PHONE", value: `+992${CARD_OWNER}`, trust: "TRANSPORT" }],
      link: async () => {},
    });
    await prisma.contactProfile.update({ where: { id: profileId! }, data: { clientId: client.id } });
    const code = formatClientCode(client.shortId, client.kind);

    const chat = contactProfileBlock(await contactProfileForPrompt(profileId, { stage: "chatting" } as never));
    expect(chat).toContain(code);

    const who = await identifyCaller({ channelId: `card-${runId}`, direction: "test", callerNumber: `+992${CARD_OWNER}` });
    expect(who.contactProfileId).toBe(profileId);
    expect(who.caller.dossier).not.toContain(code);
    expect(who.caller.dossier).not.toContain("Карточка в CRM");
  });
});

describe("contactProfileBlock: строка карточки по выбору", () => {
  const profile = {
    category: "BUYER" as const,
    previousCategories: [],
    selfName: "Фарход",
    language: "ru",
    history: null,
    buyer: [],
    seller: [],
    job: [],
    crm: "ПК-000312, агент Умед",
  };
  it("по умолчанию — как раньше, с карточкой", () => {
    expect(contactProfileBlock(profile)).toContain("Карточка в CRM: ПК-000312");
  });
  it("withCrmCard: false — без неё, остальное на месте", () => {
    const block = contactProfileBlock(profile, { withCrmCard: false });
    expect(block).not.toContain("ПК-000312");
    expect(block).toContain("Фарход");
  });
});
