import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * СООБЩЕНИЕ НА АВТООТВЕТЧИКЕ СТАНОВИТСЯ ЛИДОМ (решение владельца 18.08.2026).
 *
 * Дословно: «надо сделать так, чтобы либо был автоответчик, где чётко сказано,
 * чтобы клиент полностью продиктовал своё сообщение, и потом уже из этого всего
 * расшифровывается, и также попадает в очередь по распределению».
 *
 * ЧТО СТЕРЕГУТ ЭТИ ТЕСТЫ — не работу модели (она замокана целиком), а решения
 * вокруг неё, каждое из которых стоит живого клиента:
 *  — сообщение незнакомого человека доходит до раздачи агентам по KPI;
 *  — клиента, которого ведёт агент, автоматика НЕ забирает в общую раздачу, а
 *    ставит его агенту задачу перезвонить;
 *  — нераспознанное сообщение всё равно оставляет карточку, но звонок остаётся
 *    неразобранным и виден человеку в «Только без разбора»;
 *  — повторный проход не заводит вторую карточку и не платит второй раз за ИИ.
 *
 * Станция подменена мокнутым fetch: тест про раздачу лидов не должен зависеть ни
 * от туннеля до АТС, ни от ключа Gemini.
 */

process.env.PBX_RECORDINGS_URL = "http://pbx.test";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const transcribeAudio = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock("../src/ai/transcribe.js", () => ({
  transcribeAudio,
  // callRecordings.ts (импортируется по цепочке) берёт из этого же модуля свою
  // функцию — без неё мок не подгрузится вовсе.
  transcribeAudioResult: vi.fn(async () => ({ text: null, failed: false })),
  isTranscriptionEnabled: vi.fn(async () => true),
  transcribeTimeoutFor: () => 60_000,
  looksLikeModelRefusal: () => false,
}));

const translateTranscript = vi.fn(async (text: string) => `ru:${text}`);
vi.mock("../src/ai/translateTranscript.js", () => ({ translateTranscript, looksTajik: () => false }));

const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", () => ({ extractIncomingCallLead }));

const { prisma } = await import("../src/db.js");
const { ingestVoicemails } = await import("../src/lib/telephony/voicemailIngest.js");
const { AWAITING_REVIEW_WHERE } = await import("../src/lib/telephony/awaitingReview.js");

const runId = Date.now();
const tail = String(runId).slice(-7);

let agentId = "";
let directorId = "";
const createdClientIds: string[] = [];
const createdFiles: string[] = [];

const TRANSCRIPT =
  "Здравствуйте, меня зовут Фируз, я ищу двухкомнатную квартиру в районе Сино, " +
  "бюджет примерно до четырёхсот тысяч сомони, перезвоните пожалуйста.";

const GOOD_EXTRACT = {
  kind: "BUYER" as const,
  confident: true,
  fullName: "Фируз",
  requirementsNotes: "Ищет 2-комнатную в Сино до 400 000 сомони",
  desiredDistrictId: null,
  desiredRooms: 2,
  desiredType: "APARTMENT" as const,
  budgetMin: null,
  budgetMax: 400_000,
};

/** Имя файла в том виде, в каком его пишет станция: время по Душанбе + номер. */
function voicemailName(digits: string, at = new Date()): string {
  const local = new Date(at.getTime() + 5 * 60 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${local.getUTCFullYear()}${p(local.getUTCMonth() + 1)}${p(local.getUTCDate())}` +
    `-${p(local.getUTCHours())}${p(local.getUTCMinutes())}${p(local.getUTCSeconds())}`;
  return `vm-${stamp}-${digits}.wav`;
}

/** Каталог станции с одним сообщением и сам файл — обычным HTTP, как в проде. */
function mockStation(files: string[], bytes = 40_000): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/royalhome-voicemail/")) {
        return {
          ok: true,
          text: async () => files.map((f) => `<a href="${f}">${f}</a>`).join("\n"),
        } as unknown as Response;
      }
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(bytes),
      } as unknown as Response;
    })
  );
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент автоответчика ${runId}`, phone: `+99296${tail}`, role: "AGENT", passwordHash: "x", isActive: true },
  });
  agentId = agent.id;
  // Раньше — технический автор-фолбэк; после П-10 (17.09.2026) такие записи
  // пишутся как SYSTEM без агента вовсе, но сама учётка директора здесь ни на
  // что не влияет — оставлена, чтобы не трогать остальные фикстуры файла.
  const director = await prisma.agent.create({
    data: { fullName: `Директор автоответчика ${runId}`, phone: `+99295${tail}`, role: "DIRECTOR", passwordHash: "x", isActive: true },
  });
  directorId = director.id;
});

beforeEach(() => {
  extractIncomingCallLead.mockReset();
  transcribeAudio.mockReset();
  transcribeAudio.mockResolvedValue(TRANSCRIPT);
  sendPushToAgent.mockClear();
});

afterEach(async () => {
  await prisma.voicemailMessage.deleteMany({ where: { file: { in: createdFiles } } });
  await prisma.incomingCall.deleteMany({ where: { voicemailFile: { in: createdFiles } } });
  createdFiles.length = 0;
  await prisma.interaction.deleteMany({ where: { clientId: { in: createdClientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  createdClientIds.length = 0;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.$disconnect();
});

/** Номер, которого в базе нет, — карточку по нему заводит сам автоответчик. */
async function trackClientByPhone(phone: string): Promise<void> {
  const client = await prisma.client.findFirst({ where: { phone }, select: { id: true } });
  if (client) createdClientIds.push(client.id);
}

describe("Автоответчик: сообщение клиента становится лидом", () => {
  it("незнакомый человек наговорил сообщение — карточка заведена и лид ушёл в раздачу по KPI", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9391${tail.slice(-5)}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    await trackClientByPhone(`+992${digits}`);

    const client = await prisma.client.findFirst({ where: { phone: `+992${digits}` } });
    expect(client).not.toBeNull();
    expect(client?.kind).toBe("BUYER");
    expect(client?.fullName).toBe("Фируз");
    expect(client?.desiredRooms).toBe(2);
    // Та же раздача, что у лида из чатов (pickAgentForLead внутри qualifyIncomingCall).
    expect(client?.assignedAgentId).not.toBeNull();

    const call = await prisma.incomingCall.findFirst({ where: { voicemailFile: file } });
    expect(call?.autoLeadStatus).toBe("qualified");
    expect(call?.qualifiedAt).not.toBeNull();

    // Расшифровка легла в хронологию вместе с задачей перезвонить. orderBy
    // обязателен: findFirst без него отдаёт произвольную строку, и при общей
    // базе полного прогона тест ловил чужую SYSTEM-запись без расшифровки
    // (межфайловая флака, поймана 26.08.2026).
    const interaction = await prisma.interaction.findFirst({
      where: { clientId: client!.id, transcript: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    expect(interaction?.transcript).toBe(TRANSCRIPT);
    expect(interaction?.transcriptRu).toBe(`ru:${TRANSCRIPT}`);
    expect(interaction?.nextAction).toContain("Перезвонить");
  });

  it("у клиента есть свой агент — в общую раздачу не уходит, задача ставится его агенту", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9392${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const client = await prisma.client.create({
      data: {
        fullName: `Давний клиент ${runId}`,
        phone,
        source: "PHONE_CALL",
        kind: "SELLER",
        status: "CONTACTED",
        currency: "TJS",
        assignedAgentId: agentId,
        requirementsNotes: "Продаёт дом в Фирдавси",
      },
    });
    createdClientIds.push(client.id);
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    // Клиент остался за своим агентом, и его запрос не переписан разбором сообщения.
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.fullName).toBe(`Давний клиент ${runId}`);
    expect(after?.requirementsNotes).toBe("Продаёт дом в Фирдавси");

    const call = await prisma.incomingCall.findFirst({ where: { voicemailFile: file } });
    expect(call?.autoLeadStatus).toBe("known_client");
    // Чужого клиента даже не отдаём модели: разбирать нечего, а деньги стоят.
    expect(extractIncomingCallLead).not.toHaveBeenCalled();

    // Задача перезвонить — на записи хронологии; автор SYSTEM (сообщение никто
    // не поднимал, П-10 17.09.2026), держатель виден через subjectAgentId.
    const interaction = await prisma.interaction.findFirst({ where: { clientId: client.id } });
    expect(interaction?.actorKind).toBe("SYSTEM");
    expect(interaction?.agentId).toBeNull();
    expect(interaction?.subjectAgentId).toBe(agentId);
    expect(interaction?.nextAction).toContain("Перезвонить");
    expect(interaction?.transcriptRu).toBe(`ru:${TRANSCRIPT}`);
  });

  it("расшифровать не удалось — карточки НЕТ, звонок остаётся человеку в «Без разбора»", async () => {
    transcribeAudio.mockResolvedValue(null);
    const digits = `9393${tail.slice(-5)}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    await trackClientByPhone(`+992${digits}`);

    const client = await prisma.client.findFirst({ where: { phone: `+992${digits}` } });
    /**
     * КАРТОЧКИ БЫТЬ НЕ ДОЛЖНО (решение владельца 30.08.2026). Раньше она заводилась
     * до расшифровки, и в базе оседали пустышки «Входящий +992…» по сообщениям на
     * 13-26 секунд, в которых не разобрано ни слова: разобрать такую не может ни
     * автоматика (нечего читать), ни человек (он видит один номер). Сам звонок при
     * этом никуда не делся — он ниже, в «Только без разбора», с записью, которую
     * можно послушать.
     */
    expect(client).toBeNull();

    const call = await prisma.incomingCall.findFirst({ where: { voicemailFile: file } });
    expect(call?.autoLeadStatus).toBe("no_data");
    expect(call?.qualifiedAt).toBeNull();
    // Ровно тот запрос, которым «Звонки» показывают «Только без разбора».
    const awaiting = await prisma.incomingCall.count({ where: { id: call!.id, ...AWAITING_REVIEW_WHERE } });
    expect(awaiting).toBe(1);
    // Пустую расшифровку модели не показываем: платить за тишину не за что.
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
  });

  it("повторный проход не заводит вторую карточку и не платит второй раз за расшифровку", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9394${tail.slice(-5)}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    expect(await ingestVoicemails()).toBe(0);
    await trackClientByPhone(`+992${digits}`);

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(extractIncomingCallLead).toHaveBeenCalledTimes(1);
    expect(await prisma.client.count({ where: { phone: `+992${digits}` } })).toBe(1);
    expect(await prisma.voicemailMessage.count({ where: { file } })).toBe(1);
    expect(await prisma.incomingCall.count({ where: { voicemailFile: file } })).toBe(1);
  });

  it("сообщение привязывается к уже записанному пропущенному звонку, а не заводит второй", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9395${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    const missed = await prisma.incomingCall.create({
      data: {
        channelId: `vm-test-${runId}-${digits}`,
        phone,
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(),
        answered: false,
      },
    });
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    await trackClientByPhone(phone);

    // Один звонок в журнале, а не два: иначе непринятый считался бы дважды.
    expect(await prisma.incomingCall.count({ where: { phone } })).toBe(1);
    const call = await prisma.incomingCall.findUnique({ where: { id: missed.id } });
    expect(call?.voicemailFile).toBe(file);
    expect(call?.interactionId).not.toBeNull();
    expect(call?.autoLeadStatus).toBe("qualified");
  });

  it("карточка номера в Корзине — сообщение не теряется, звонок ждёт человека в «Без разбора»", async () => {
    // Пункт 22 разбора раздачи (23.09.2026): создание новой карточки падало на
    // уникальном номере ПОСЛЕ оплаченной расшифровки, и сообщение пропадало.
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9397${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const trashed = await prisma.client.create({
      data: { fullName: `Удалённый ${runId}`, phone, source: "PHONE_CALL", kind: "BUYER", currency: "TJS", deletedAt: new Date() },
    });
    createdClientIds.push(trashed.id);
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);

    expect(await prisma.client.count({ where: { phone } })).toBe(1);
    expect((await prisma.client.findUnique({ where: { id: trashed.id } }))?.deletedAt).not.toBeNull();
    const call = await prisma.incomingCall.findFirst({ where: { voicemailFile: file } });
    expect(call).not.toBeNull();
    expect(call?.autoLeadStatus).toBe("no_data");
    expect(await prisma.incomingCall.count({ where: { id: call!.id, ...AWAITING_REVIEW_WHERE } })).toBe(1);
  });

  it("номер дубля из Корзины живёт запасным у основной карточки — сообщение ложится к ней", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9398${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const trashed = await prisma.client.create({
      data: { fullName: `Дубль ${runId}`, phone, source: "PHONE_CALL", kind: "BUYER", currency: "TJS", deletedAt: new Date() },
    });
    const main = await prisma.client.create({
      data: {
        fullName: `Основная ${runId}`,
        phone: `+992${`9399${tail.slice(-5)}`}`,
        extraPhones: [phone],
        source: "PHONE_CALL",
        kind: "SELLER",
        status: "CONTACTED",
        currency: "TJS",
        assignedAgentId: agentId,
      },
    });
    createdClientIds.push(trashed.id, main.id);
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);

    const vm = await prisma.voicemailMessage.findFirst({ where: { file } });
    expect(vm?.clientId).toBe(main.id);
    const interaction = await prisma.interaction.findFirst({ where: { clientId: main.id, transcript: { not: null } } });
    expect(interaction?.nextAction).toContain("Перезвонить");
  });

  it("запасной номер, продиктованный в сообщении, маскируется в расшифровке, карточке и пуше", async () => {
    // 24.09.2026: голосовая почта маскировала запасные номера хуже, чем обычный
    // звонок (callRecordings.ts) — расшифровка уходила в Interaction.transcript/
    // transcriptRu и в текст пуша открытым текстом. Клиент со своим агентом — чтобы
    // проверить сразу оба пути: и сохранение в БД (else-ветка logTimeline), и push.
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9401${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const client = await prisma.client.create({
      data: {
        fullName: `С доп. номером ${runId}`,
        phone,
        source: "PHONE_CALL",
        kind: "SELLER",
        status: "CONTACTED",
        currency: "TJS",
        assignedAgentId: agentId,
      },
    });
    createdClientIds.push(client.id);
    const EXTRA_PHONE_TEXT = "У меня есть вторая симка, запишите 910 00 10 44, я на связи по ней тоже.";
    transcribeAudio.mockResolvedValue(EXTRA_PHONE_TEXT);
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);

    const interaction = await prisma.interaction.findFirst({ where: { clientId: client.id } });
    expect(interaction?.transcript).not.toContain("910 00 10 44");
    expect(interaction?.transcriptRu).not.toContain("910 00 10 44");
    // Собственный номер клиента (тот, с которого он звонил) НЕ маскируется — он и
    // так открыт через саму карточку.
    expect(interaction?.transcript).not.toBeNull();

    expect(sendPushToAgent).toHaveBeenCalled();
    const pushCall = sendPushToAgent.mock.calls.find((c) => c[0] === agentId);
    const pushBody = (pushCall?.[1] as { body?: string } | undefined)?.body ?? "";
    expect(pushBody).not.toContain("910 00 10 44");
  });

  it("клиент бросил трубку на приветствии — ни карточки, ни расшифровки, ни пуша", async () => {
    const digits = `9396${tail.slice(-5)}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    // Полсекунды телефонного wav — это щелчок отбоя, а не речь.
    mockStation([file], 400);

    expect(await ingestVoicemails()).toBe(1);

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(await prisma.client.count({ where: { phone: `+992${digits}` } })).toBe(0);
    expect(sendPushToAgent).not.toHaveBeenCalled();
    // Файл помечен обработанным: второй проход не станет его качать снова.
    expect(await prisma.voicemailMessage.count({ where: { file } })).toBe(1);
  });
  /**
   * БРОШЕННЫЙ ЗАМОК. Строка `VoicemailMessage` встаёт до расшифровки, чтобы второй
   * проход не оплатил ту же минуту дважды, но отметки о КОНЦЕ работы у неё не было:
   * перезапуск контейнера посреди прохода (а он бывает на каждый мерж в main) терял
   * сообщение навсегда — имя файла в базе есть, значит следующий проход его не
   * тронет, а карточки, задачи «перезвонить» и раздачи так и не случилось.
   */
  it("проход умер посреди работы — следующий доводит сообщение до карточки", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9397${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const file = voicemailName(digits);
    createdFiles.push(file);

    // Ровно то, что осталось бы от умершего прохода: замок занят, работа не
    // доведена, взялись давно.
    await prisma.voicemailMessage.create({
      data: {
        file,
        phone,
        recordedAt: new Date(),
        claimedAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    await trackClientByPhone(phone);

    const client = await prisma.client.findFirst({ where: { phone } });
    expect(client).not.toBeNull();
    const row = await prisma.voicemailMessage.findUnique({ where: { file } });
    expect(row?.processedAt).not.toBeNull();
    expect(row?.attempts).toBe(2);
    // Вторая строка на тот же файл не заводится — замок остался один.
    expect(await prisma.voicemailMessage.count({ where: { file } })).toBe(1);
  });

  it("замок, взятый только что, второй проход не перехватывает", async () => {
    const digits = `9398${tail.slice(-5)}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    await prisma.voicemailMessage.create({
      data: { file, phone: `+992${digits}`, recordedAt: new Date(), claimedAt: new Date() },
    });
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(0);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("повторы не бесконечны: после третьей попытки сообщение ждёт человека", async () => {
    const digits = `9399${tail.slice(-5)}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    await prisma.voicemailMessage.create({
      data: {
        file,
        phone: `+992${digits}`,
        recordedAt: new Date(),
        claimedAt: new Date(Date.now() - 30 * 60_000),
        attempts: 3,
      },
    });
    mockStation([file]);

    // Платная расшифровка не крутится вечно на одном сломанном файле — про него
    // уже записано в журнал, дальше его слушает человек.
    expect(await ingestVoicemails()).toBe(0);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});

describe("Автоответчик: файлы, которые раньше терялись, и повторы (03.10.2026)", () => {
  it("скрытый номер — сообщение не пропадает: звонок без карточки ждёт человека, в раздачу не идёт", async () => {
    // Секунда в имени — своя на прогон, чтобы файл не совпал с соседним прогоном.
    const file = voicemailName("anonymous", new Date(runId - 3_600_000));
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    const call = await prisma.incomingCall.findFirst({ where: { voicemailFile: file } });
    expect(call).not.toBeNull();
    expect(call?.clientId).toBeNull();
    expect(call?.phone).toBe("");
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
    expect((await prisma.voicemailMessage.findUnique({ where: { file } }))?.processedAt).not.toBeNull();
  });

  it("номер в имени с «+992» — файл принимается и ложится к карточке по номеру", async () => {
    const digits = `9402${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const client = await prisma.client.create({
      data: { fullName: `Плюс ${runId}`, phone, source: "PHONE_CALL", kind: "SELLER", status: "CONTACTED", currency: "TJS", assignedAgentId: agentId },
    });
    createdClientIds.push(client.id);
    const file = voicemailName(`+992${digits}`);
    createdFiles.push(file);
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    expect((await prisma.voicemailMessage.findUnique({ where: { file } }))?.clientId).toBe(client.id);
  });

  it("имя не по шаблону — файл не теряется молча: строка в журнале ошибок", async () => {
    const { waitFor } = await import("./helpers/waitFor.js");
    const file = `vm-broken-${runId}.wav`;
    mockStation([file]);
    expect(await ingestVoicemails()).toBe(0);
    await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: file } } }), { label: "журнал о пропущенном файле" });
    await prisma.errorLog.deleteMany({ where: { message: { contains: file } } });
  });

  it("звонок брал робот и отдал автоответчику — сообщение ложится к ЭТОМУ звонку, второго нет", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9403${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const file = voicemailName(digits);
    createdFiles.push(file);
    const client = await prisma.client.create({
      data: { fullName: `Робот ${runId}`, phone, source: "PHONE_CALL", kind: "SELLER", status: "CONTACTED", currency: "TJS", assignedAgentId: agentId },
    });
    createdClientIds.push(client.id);
    const robotTalk = await prisma.interaction.create({
      data: { clientId: client.id, actorKind: "SYSTEM", type: "CALL", notes: "Ответил консультант", transcript: "Консультант: здравствуйте" },
    });
    const robot = await prisma.incomingCall.create({
      data: {
        channelId: `vm-robot-${runId}-${digits}`,
        phone,
        clientId: client.id,
        interactionId: robotTalk.id,
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(),
        answered: true,
        answeredByConsultant: true,
      },
    });
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    expect(await prisma.incomingCall.count({ where: { phone } })).toBe(1);
    expect((await prisma.incomingCall.findUnique({ where: { id: robot.id } }))?.voicemailFile).toBe(file);
    // Разговор консультанта не затёрт сообщением — оно легло рядом своей записью.
    expect((await prisma.interaction.findUnique({ where: { id: robotTalk.id } }))?.transcript).toBe("Консультант: здравствуйте");
    expect(await prisma.interaction.count({ where: { clientId: client.id, recordingUrl: `royalhome-voicemail/${file}` } })).toBe(1);
    await prisma.incomingCall.deleteMany({ where: { id: robot.id } });
  });

  it("перехват замка после смерти прохода — звонок и запись в хронологии не дублируются", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9404${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const client = await prisma.client.create({
      data: { fullName: `Перехват ${runId}`, phone, source: "PHONE_CALL", kind: "SELLER", status: "CONTACTED", currency: "TJS", assignedAgentId: agentId },
    });
    createdClientIds.push(client.id);
    const file = voicemailName(digits);
    createdFiles.push(file);
    // Прошлый проход успел привязать звонок и записать в хронологию, но умер до
    // отметки о конце.
    await prisma.voicemailMessage.create({
      data: { file, phone, recordedAt: new Date(), claimedAt: new Date(Date.now() - 30 * 60_000) },
    });
    await prisma.incomingCall.create({
      data: { channelId: `voicemail:${file}`, phone, startedAt: new Date(), endedAt: new Date(), answered: false, clientId: client.id, voicemailFile: file },
    });
    await prisma.interaction.create({
      data: { clientId: client.id, actorKind: "SYSTEM", type: "CALL", notes: "Сообщение на автоответчике", recordingUrl: `royalhome-voicemail/${file}` },
    });
    mockStation([file]);

    expect(await ingestVoicemails()).toBe(1);
    expect(await prisma.incomingCall.count({ where: { phone } })).toBe(1);
    expect(await prisma.interaction.count({ where: { clientId: client.id, recordingUrl: `royalhome-voicemail/${file}` } })).toBe(1);
  });

  it("CHANNEL-NEW-34: запись в хронологию упала — сообщение не помечено разобранным, повторный проход сохраняет расшифровку", async () => {
    extractIncomingCallLead.mockResolvedValue(GOOD_EXTRACT);
    const digits = `9405${tail.slice(-5)}`;
    const phone = `+992${digits}`;
    const client = await prisma.client.create({
      data: { fullName: `Сбой записи ${runId}`, phone, source: "PHONE_CALL", kind: "SELLER", status: "CONTACTED", currency: "TJS", assignedAgentId: agentId },
    });
    createdClientIds.push(client.id);
    const file = voicemailName(digits);
    createdFiles.push(file);
    mockStation([file]);

    // Единственное падение: поиск уже существующей записи этого сообщения в хронологии.
    const realFind = prisma.interaction.findFirst.bind(prisma.interaction);
    let failed = 0;
    const spy = vi.spyOn(prisma.interaction, "findFirst").mockImplementation(((args: { where?: { recordingUrl?: string } }) => {
      if (failed === 0 && args?.where?.recordingUrl?.includes(file)) {
        failed += 1;
        return Promise.reject(new Error("база временно недоступна"));
      }
      return realFind(args as never);
    }) as never);
    try {
      expect(await ingestVoicemails()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(1);
    const afterFail = await prisma.voicemailMessage.findUnique({ where: { file } });
    expect(afterFail?.processedAt).toBeNull();
    expect(await prisma.interaction.count({ where: { clientId: client.id, transcript: { not: null } } })).toBe(0);

    // Замок стал брошенным (прошло 10 минут) — следующий проход доводит сообщение.
    await prisma.voicemailMessage.update({ where: { file }, data: { claimedAt: new Date(Date.now() - 30 * 60_000) } });
    expect(await ingestVoicemails()).toBe(1);
    expect((await prisma.voicemailMessage.findUnique({ where: { file } }))?.processedAt).not.toBeNull();
    expect(await prisma.interaction.count({ where: { clientId: client.id, transcript: { not: null } } })).toBe(1);
  });
});
