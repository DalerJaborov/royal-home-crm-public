import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { submitReplySchema } from "@royal-home/shared";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Бот показывает объект сам: фотографиями в чат, а не одной ссылкой.
 *
 * Владелец про бота: «как будто отправляет сам лично фотографии». Здесь стерегутся
 * ровно те места, где эта затея ломается молча:
 *
 *  1. Число снимков ограничено. Двадцать фотографий подряд — не «как человек», а
 *     рассылка, за которую Meta ограничивает отправку.
 *  2. У объекта нет фотографий — ход диалога всё равно доходит до конца. Клиент
 *     обязан получить текст, даже когда показывать нечего.
 *  3. Meta отказала — текстовый ответ всё равно уходит и ложится в переписку.
 *     Фотография приятна, ответ обязателен.
 *  4. Формат отправки у каналов РАЗНЫЙ (WhatsApp против Instagram/Messenger), и
 *     различие видно только в теле запроса: по коду возврата его не поймать.
 *  5. В Instagram при наличии нашей публикации уходит ссылка на пост, а не картинки.
 *
 * Транспорт подменён: тест не ходит в Meta и не платит за токены. Всё остальное
 * настоящее, включая базу и сборку тела запроса.
 */

const { sendImage, sendMessage, sendLocation, isMetaChannelEnabled, showReadAndTyping, sleep, callAiText } = vi.hoisted(() => ({
  sendImage: vi.fn(async (_c: string, _to: string, _url: string): Promise<string | undefined> => "synthetic-photo-mid"),
  sendMessage: vi.fn(async (_c: string, _to: string, _text: string): Promise<string | undefined> => "synthetic-link-mid"),
  sendLocation: vi.fn(async (_to: string, _lat: number, _lng: number) => "wamid.location-1"),
  isMetaChannelEnabled: vi.fn(async () => true),
  showReadAndTyping: vi.fn(async (_c: string, _to: string, _mid?: string) => {}),
  sleep: vi.fn(async (_ms: number) => {}),
  callAiText: vi.fn(),
}));

// Подменяем ТОЛЬКО отправку: сборка тела запроса (buildImageRequest) и разбор каналов
// остаются настоящими — их и проверяем.
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendImage,
  sendMessage,
  sendLocation,
  isMetaChannelEnabled,
  showReadAndTyping,
}));

// Паузы между фотографиями настоящие — секунды. Ждать их в тесте незачем: проверяется
// ПОРЯДОК действий (пауза с «печатает…» между отправками), а не длина сна. Сама
// длительность — в humanPacing.ts, и стеречь там нечего, кроме верхней границы.
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()),
  sleep,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

// Публичный адрес CRM ставим ДО импорта модулей: по нему Meta забирает картинку, и без
// него отправлять нечего. Читается он лениво, но привычка ставить окружение раньше
// импортов дешевле, чем разбираться, у какого модуля как.
process.env.CRM_PUBLIC_URL = "https://crm-test.royalhome.tj";
process.env.SITE_PUBLIC_URL = "https://royalhome.tj";
// Кэш libvips держит прочитанные файлы открытыми — под Windows это мешает убрать за
// собой временные снимки. На работу самого перекодирования не влияет.
sharp.cache(false);

const { prisma } = await import("../src/db.js");
const { uploadsDir } = await import("../src/upload.js");
const { buildImageRequest, GRAPH_VERSION } = await import("../src/messengers/meta.js");
const { showPropertyToClient: actualShowPropertyToClient } = await import("../src/messengers/propertyShowcase.js");
const { DEFAULT_PHOTOS_PER_OFFER: MAX_PHOTOS_PER_OFFER } = await import("../src/ai/photoOffer.js");
const { messagePhotoPath, removeMessagePhoto } = await import("../src/lib/messagePhoto.js");
const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");
const { ensureScopedBotConversation } = await import("../src/lib/customerConversationScope.js");
const { resetAccountsCache } = await import("../src/messengers/accounts.js");
const { encryptSecret } = await import("../src/crypto.js");
const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");
const { admitCustomerPropertyInput } = await import("../src/lib/customerPropertyAdmission.js");
const { customerPropertyEvidenceFromText } = await import("../src/lib/customerPropertyEvidence.js");
const { resolveCustomerPropertyTurnContext } = await import("../src/lib/customerPropertyTurnContext.js");

/** База общая с другими прогонами — всё своё именуем уникально и убираем за собой. */
const runId = randomUUID();
/** Synthetic Facebook peer; no phone is supplied or inferred for lead intake. */
const SUBSCRIBER = `fb-photos-${runId}`;
/** Все получатели, которым что-то показывают в этом файле: по ним же чистятся отметки
 *  «объект уже показан», иначе второй тест подряд упирался бы в предохранитель. */
const WA_RECIPIENT = `wa-photos-${runId}`;
const IG_RECIPIENT = `igsid-photos-${runId}`;
const nativeIds = new Set<string>(), scopeIds = new Set<string>(), profileIds = new Set<string>();
const accounts = new Map<string, { id: string; externalId: string; token: string }>();
let savedPolicy: { contractVersion: string; rolloutMode: string };
const fetchDenied = vi.fn(async () => { throw new Error("Unexpected external fetch in photo fixture"); });
function modelReply(raw: unknown) {
  // Positive consumer tests must not pass via malformed-output recovery.
  submitReplySchema({ showings: true, askOwner: true, vacancies: true, promptEconomy: true,
    canSendPhotos: true, canSendGuide: true, topicLock: true }).parse(raw);
  callAiText.mockResolvedValue(raw);
}
function expectValidModelTurn(turn: Awaited<ReturnType<typeof actualProcessMessengerTurn>>) {
  expect(callAiText).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "lead-qualify" }));
  // Legacy successful finish omits this optional flag; unavailable explicitly
  // sets true. Keep the actual success shape, model-call and useful-OUT checks.
  expect(turn.aiUnavailable).toBeUndefined();
  expect(turn.shouldReply).not.toBe(false);
}

async function photoThread(channel: string, recipientId: string) {
  const account = accounts.get(channel);
  if (!account) throw new Error("Photo fixture has no account for requested channel");
  const thread = await prisma.$transaction(tx => ensureScopedBotConversation(tx, {
    channel, subscriberId: recipientId, accountId: account.id, accountExternalId: account.externalId,
  }));
  nativeIds.add(thread.id); scopeIds.add(thread.transport.endpointScopeId);
  return { ...thread, account };
}
/** Direct showcase calls still execute the real function, with a captured exact
 * configured namespace and synthetic token. No default-account scope bypass. */
async function showPropertyToClient(...args: Parameters<typeof actualShowPropertyToClient>) {
  if (!accounts.has(args[0]) || !args[2]) return actualShowPropertyToClient(...args);
  const thread = await photoThread(args[0], args[1]);
  args[5] = thread.account.token; args[7] = thread.transport;
  return actualShowPropertyToClient(...args);
}
async function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  const thread = await photoThread(input.channel, input.subscriberId);
  return actualProcessMessengerTurn({ ...input, accountExternalId: thread.account.externalId,
    customerTransport: thread.transport });
}
async function clearOwnThreads() {
  const ids = [...nativeIds];
  if (!ids.length) return;
  const rows = await prisma.botConversation.findMany({ where: { id: { in: ids } }, select: { contactProfileId: true } });
  const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: ids } }, select: { id: true } });
  for (const row of rows) if (row.contactProfileId) profileIds.add(row.contactProfileId);
  await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiries.map(row => row.id) } } });
  nativeIds.clear();
}
/** Ровно та ссылка, что лежит в поле публикации у части прод-объектов. */
const TELEGRAM_LINK = "https://t.me/royalhome_tj/1234";

let districtId: string;
let withPhotosShortId: number;
let noPhotosShortId: number;
let withInstagramShortId: number;
/** Поле «Ссылка на публикацию Instagram» заполнено, но ведёт в Telegram — так на
 *  проде заведена часть объектов: видео-обзор снят и выложен туда. */
let telegramLinkShortId: number;
let soldShortId: number;
const propertyIds: string[] = [];
/** Префикс имён файлов каждого объекта — по индексу в propertyIds. */
const photoPrefixes: string[] = [];

type SettingsSnapshot = {
  botEnabled: boolean;
  botFacebookEnabled: boolean;
  botReplyDelaySec: number;
  botReplyMaxWaitSec: number;
  botCanSendPhotos: boolean;
  botPhotosPerOffer: number;
  botCanSendLinks: boolean;
  botTopicLockEnabled: boolean;
};
const SELECT = {
  botEnabled: true,
  botFacebookEnabled: true,
  botReplyDelaySec: true,
  botReplyMaxWaitSec: true,
  botCanSendPhotos: true,
  botPhotosPerOffer: true,
  botCanSendLinks: true,
  botTopicLockEnabled: true,
} as const;
let savedSettings: SettingsSnapshot;

/** Имена файлов, положенных в общую папку uploads, — убираем за собой в afterAll. */
const createdFiles: string[] = [];

/**
 * Настоящий файл в `uploads`, а не только строка в базе: отправка перекодирует WebP в
 * JPEG прямо с диска (lib/messagePhoto.ts), и подделка из одной строки в базе прошла бы
 * мимо самого хрупкого места.
 */
async function writeUploadedPhoto(name: string): Promise<void> {
  const file = path.join(uploadsDir, name);
  await sharp({ create: { width: 40, height: 30, channels: 3, background: "#8899aa" } })
    .webp({ quality: 70 })
    .toFile(file);
  createdFiles.push(file);
}

async function makeProperty(
  title: string,
  photos: number,
  extra: Partial<{ publishedOnSite: boolean; status: "AVAILABLE" | "SOLD"; instagramUrl: string; lat: number; lng: number }> = {}
): Promise<number> {
  const prefix = `test-${runId}-${propertyIds.length}`;
  for (let i = 0; i < photos; i++) await writeUploadedPhoto(`${prefix}-${i}.webp`);

  const property = await prisma.property.create({
    data: {
      title,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      publishedOnSite: true,
      ...extra,
      photos: {
        create: Array.from({ length: photos }, (_, i) => ({
          url: `/uploads/${prefix}-${i}.webp`,
          thumbUrl: `/uploads/thumbs/${prefix}-${i}.webp`,
          // Порядок — то, по чему выбираются первые снимки: потеряв сортировку,
          // клиент получит случайные фотографии вместо главной.
          order: i,
        })),
      },
    },
  });
  propertyIds.push(property.id);
  photoPrefixes.push(prefix);
  return property.shortId;
}

beforeAll(async () => {
  for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK"] as const) {
    const token = `synthetic-photo-token-${channel}`;
    const account = await prisma.messengerAccount.create({ data: { channel, externalId: `photo-${runId}-${channel}`,
      title: `Photo fixture ${runId}`, token: encryptSecret(token), enabled: true }, select: { id: true, externalId: true } });
    accounts.set(channel, { ...account, token });
  }
  resetAccountsCache();
  savedPolicy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: { contractVersion: true, rolloutMode: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "compat", rolloutMode: "OFF" } });
  districtId = (await prisma.district.create({ data: { name: `Тест-район-фото-${runId}` } })).id;
  withPhotosShortId = await makeProperty(`Объект с фото ${runId}`, 7);
  noPhotosShortId = await makeProperty(`Объект без фото ${runId}`, 0);
  withInstagramShortId = await makeProperty(`Объект с постом ${runId}`, 5, {
    instagramUrl: "https://www.instagram.com/p/royal-home-test/",
  });
  telegramLinkShortId = await makeProperty(`Объект с телеграм-ссылкой ${runId}`, 5, {
    instagramUrl: TELEGRAM_LINK,
  });
  soldShortId = await makeProperty(`Проданный объект ${runId}`, 5, { status: "SOLD" });

  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  // Дебаунс на ноль: ход бота ждёт тишины (по умолчанию 25 секунд) и тест бы не
  // уложился в таймаут. Проверяем показ объекта, а не паузу.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botFacebookEnabled: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 5,
      botCanSendPhotos: true, botPhotosPerOffer: MAX_PHOTOS_PER_OFFER, botCanSendLinks: true, botTopicLockEnabled: true },
  });
});

afterAll(async () => {
  await drainBackgroundTasks(2_000);
  await clearOwnThreads();
  await prisma.shownProperty.deleteMany({ where: { OR: [
    { endpointScopeId: { in: [...scopeIds] } }, { endpointScopeId: null, recipientId: SUBSCRIBER,
      shortId: { in: [withPhotosShortId].filter(value => typeof value === "number") } },
  ] } });
  await prisma.propertyExposure.deleteMany({ where: { endpointScopeId: { in: [...scopeIds] } } });
  // Папка uploads общая — убираем и оригиналы, и JPEG-двойники, созданные отправкой.
  // Под Windows файл, который sharp только что читал, ещё несколько мгновений держится
  // открытым; уборка своих же временных файлов не повод ронять прогон.
  for (const file of createdFiles) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(uploadsDir, "msg", `${path.basename(file, ".webp")}.jpg`), { force: true });
    } catch {
      /* следующий прогон заведёт файлы с другим runId — мусор не накапливается лавиной */
    }
  }
  // Фотографии уходят каскадом вместе с объектом (onDelete: Cascade).
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
  // clearOwnThreads resets nativeIds between cases. These scopes belong to the
  // fixture's UUID accounts and also cover never-bound durable pending input.
  const ownTickets = await prisma.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: { in: [...scopeIds] } }, select: { eventKey: true } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: ownTickets.map(ticket => `customer-inbox-consume:${ticket.eventKey}`) } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: ownTickets.map(ticket => ticket.eventKey) } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...scopeIds] } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: [...profileIds] } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: [...accounts.values()].map(account => account.id) } } });
  resetAccountsCache();
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchDenied); fetchDenied.mockClear();
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  let imageSequence = 0;
  sendImage.mockReset();
  sendImage.mockImplementation(async () => `synthetic-photo-${runId}-${++imageSequence}`);
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(`synthetic-link-${runId}`);
  sendLocation.mockReset();
  sendLocation.mockResolvedValue("wamid.location-1");
  isMetaChannelEnabled.mockReset();
  isMetaChannelEnabled.mockResolvedValue(true);
  showReadAndTyping.mockReset();
  showReadAndTyping.mockResolvedValue(undefined);
  sleep.mockReset();
  sleep.mockResolvedValue(undefined);
  callAiText.mockReset();
  await clearOwnThreads();
  // Предохранитель от повторного показа живёт в базе и переживает тест: без уборки
  // каждый следующий тест получал бы «этот объект уже показан».
  await prisma.shownProperty.deleteMany({ where: { OR: [
    { endpointScopeId: { in: [...scopeIds] } }, { endpointScopeId: null, recipientId: SUBSCRIBER, shortId: withPhotosShortId },
  ] } });
  await prisma.propertyExposure.deleteMany({ where: { endpointScopeId: { in: [...scopeIds] } } });
});
afterEach(async () => { await drainBackgroundTasks(2_000); expect(fetchDenied).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("сколько фотографий уходит клиенту", () => {
  it(`у объекта с семью снимками уходит не больше ${MAX_PHOTOS_PER_OFFER}, по порядку`, async () => {
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    expect(sendImage).toHaveBeenCalledTimes(MAX_PHOTOS_PER_OFFER);
    expect(result.attachments).toHaveLength(MAX_PHOTOS_PER_OFFER);
    // Порядок — тот же, что в карточке объекта: клиент сперва видит главное фото.
    const sentUrls = sendImage.mock.calls.map((call) => call[2]);
    expect(sentUrls).toEqual([
      `https://crm-test.royalhome.tj/uploads/msg/${photoPrefixes[0]}-0.jpg`,
      `https://crm-test.royalhome.tj/uploads/msg/${photoPrefixes[0]}-1.jpg`,
      `https://crm-test.royalhome.tj/uploads/msg/${photoPrefixes[0]}-2.jpg`,
    ]);
    // В переписку CRM ложится ОРИГИНАЛ относительным путём: внутри CRM фотография
    // показывается как обычная картинка объекта, и WebP браузеру не мешает.
    expect(result.attachments[0]).toEqual({
      kind: "image",
      url: `/uploads/${photoPrefixes[0]}-0.webp`,
      mime: "image/webp",
      mid: expect.stringMatching(/^synthetic-photo-/),
    });
  });

  it("наружу уходит JPEG, а не оригинал WebP: сообщение типа image в WhatsApp WebP не принимает", async () => {
    await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    const sentUrls = sendImage.mock.calls.map((call) => String(call[2]));
    expect(sentUrls.every((url) => url.endsWith(".jpg"))).toBe(true);
    // Двойник действительно лежит на диске в публичной папке — иначе Meta нечего
    // будет забрать по этой ссылке.
    expect(fs.existsSync(path.join(uploadsDir, "msg", `${photoPrefixes[0]}-0.jpg`))).toBe(true);
  });

  /**
   * Число живёт в Настройках с 02.08.2026 (решение владельца: ни одна цифра не
   * остаётся в коде). Проверяем именно отправку, а не чтение настройки: раньше
   * тройка была зашита в двух местах сразу — в запросе к базе и в нарезке списка, —
   * и разъехаться им было бы совсем нетрудно.
   */
  it("число из Настроек меняет размер пачки: поставили пять — ушло пять", async () => {
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId, "", 5);

    expect(sendImage).toHaveBeenCalledTimes(5);
    expect(result.attachments).toHaveLength(5);
  });

  it("снимков в карточке меньше, чем разрешено — уходит сколько есть", async () => {
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId, "", 10);

    // У объекта их семь: настройка — это потолок, а не требование дослать недостающее.
    expect(sendImage).toHaveBeenCalledTimes(7);
    expect(result.attachments).toHaveLength(7);
  });

  it("следом за фотографиями уходит одна ссылка на карточку сайта — там подробности", async () => {
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result.link).toContain("royalhome.tj/listing/by-crm/");
  });
});

describe("рубильник ссылок бота выключен (CHANNEL-NEW-32)", () => {
  it("WhatsApp: фотографии уходят, ссылка на карточку сайта нет", async () => {
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId, "", 3, undefined, false);

    expect(sendImage).toHaveBeenCalledTimes(3);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.link).toBeNull();
  });

  it("Instagram с готовым постом: ссылка на пост не уходит, показ идёт фотографиями", async () => {
    const result = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withInstagramShortId, "", 3, undefined, false);

    const sent = sendMessage.mock.calls.map((c) => String(c[2]));
    expect(sent.some((t) => t.includes("instagram.com/p/"))).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.link).toBeNull();
  });
});

describe("фотографии уходят по одной, а не залпом", () => {
  it("между снимками — «печатает…»: пауз столько же, сколько промежутков", async () => {
    await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    // Три снимка и ссылка на карточку: промежутков три, и в каждом сначала
    // «печатает…», потом пауза. Перед ПЕРВЫМ снимком паузы нет — клиент только что
    // попросил фотографии и ждать неизвестно чего не должен.
    expect(showReadAndTyping).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
    // Typing uses the same exact installed account/namespace as the media send.
    expect(showReadAndTyping).toHaveBeenCalledWith("WHATSAPP", WA_RECIPIENT, undefined, true,
      accounts.get("WHATSAPP")!.token, (await photoThread("WHATSAPP", WA_RECIPIENT)).transport);
  });

  it("пауза не превращает показ в минуты ожидания", async () => {
    const { photoGapMs } = await import("../src/messengers/humanPacing.js");

    // Верхняя граница важнее самой длительности: показ идёт ПЕРЕД текстовым ответом,
    // и затянутые паузы отодвигали бы ответ клиенту.
    for (let i = 0; i < 50; i++) {
      const gap = photoGapMs();
      expect(gap).toBeGreaterThanOrEqual(1200);
      expect(gap).toBeLessThanOrEqual(2600);
    }
  });
});

describe("один объект показывается один раз", () => {
  it("повторный показ того же объекта тому же человеку не отправляет ничего", async () => {
    const first = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);
    expect(first.attachments).toHaveLength(MAX_PHOTOS_PER_OFFER);

    sendImage.mockClear();
    sendMessage.mockClear();
    const second = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    // Модель ошибается и называет тот же номер повторно — раньше клиент получал те же
    // три снимка второй раз, и это главный признак робота.
    expect(second).toEqual({ attachments: [], link: null, deliveryStatus: "not_sent" });
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("другой объект тому же человеку показывается как обычно", async () => {
    await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withPhotosShortId);
    sendMessage.mockClear();

    // Предохранитель на объекте, а не на собеседнике: подобрать вторую квартиру —
    // ровно то, ради чего бот и работает.
    const other = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withInstagramShortId);
    expect(other.link).toBe("https://www.instagram.com/p/royal-home-test/");
  });

  it("тот же объект другому человеку показывается как обычно", async () => {
    await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);
    sendImage.mockClear();

    const toAnother = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withPhotosShortId);
    expect(toAnother.attachments).toHaveLength(MAX_PHOTOS_PER_OFFER);
  });

  it("отметка не ставится, если Meta не забрала ни одной картинки", async () => {
    sendImage.mockRejectedValue(new Error("Graph API HTTP 400"));
    await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    // Клиент не увидел ничего — запрещать повтор не за что, иначе один сбой Meta
    // навсегда закрыл бы объект для этого человека.
    sendImage.mockReset();
    sendImage.mockResolvedValue("synthetic-retry-photo-mid");
    const retry = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);
    expect(retry.attachments).toHaveLength(MAX_PHOTOS_PER_OFFER);
  });

  it("ссылка на пост в Instagram — тоже показ, второй раз не уходит", async () => {
    await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withInstagramShortId);
    sendMessage.mockClear();

    const second = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withInstagramShortId);
    expect(second).toEqual({ attachments: [], link: null, deliveryStatus: "not_sent" });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("показывать нечего — ход не падает", () => {
  it("у объекта нет ни одной фотографии: ничего не отправлено, исключения нет", async () => {
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, noPhotosShortId);

    expect(result).toEqual({ attachments: [], link: null, deliveryStatus: "not_sent" });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("модель не назвала объект — в Meta вообще не ходим", async () => {
    expect(await showPropertyToClient("WHATSAPP", WA_RECIPIENT, null)).toEqual({ attachments: [], link: null, deliveryStatus: "not_sent" });
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("проданный объект не показываем, даже если модель назвала его номер", async () => {
    // Номер приходит от модели, а она может назвать что угодно: показать клиенту
    // фотографии уже проданной квартиры хуже, чем не показать ничего.
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, soldShortId);

    expect(result.attachments).toHaveLength(0);
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("канал не наш (Telegram и подобные) — показ просто пропускается", async () => {
    const result = await showPropertyToClient("TELEGRAM", "12345", withPhotosShortId);

    expect(result).toEqual({ attachments: [], link: null, deliveryStatus: "not_sent" });
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("рубильник канала выключен — не отправляем ничего", async () => {
    isMetaChannelEnabled.mockResolvedValue(false);

    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    expect(result).toEqual({ attachments: [], link: null, deliveryStatus: "not_sent" });
    expect(sendImage).not.toHaveBeenCalled();
  });
});

describe("отказ Meta не срывает ответ клиенту", () => {
  it("Meta не забрала картинку — показ пустой, но исключение наружу не летит", async () => {
    sendImage.mockRejectedValue(new Error("Graph API HTTP 400"));

    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);

    expect(result).toEqual({ attachments: [], link: null, deliveryStatus: "not_sent" });
    // Останавливаемся на первом отказе: очередь заведомо неудачных запросов только
    // задержала бы текстовый ответ.
    expect(sendImage).toHaveBeenCalledTimes(1);
  });

  it("ход диалога доходит до конца: клиент получает текст, переписка сохраняется", async () => {
    sendImage.mockRejectedValue(new Error("Graph API HTTP 400"));
    modelReply({
      reply: ["Ана расмҳояш"],
      ready: false,
      confident: true,
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
      showPropertyNumber: withPhotosShortId,
    });

    const turn = await processMessengerTurn({
      channel: "FACEBOOK",
      subscriberId: SUBSCRIBER,
      text: "расмашро фиристед",
    });

    expectValidModelTurn(turn);
    expect(turn.reply).toBe("Расмҳо ҳоло фиристода нашуданд.");
    expect(turn.reply).not.toContain("Ана расмҳояш");
    expect(sendImage).toHaveBeenCalledTimes(1);
    const conversation = await prisma.botConversation.findUnique({
      where: { id: (await photoThread("FACEBOOK", SUBSCRIBER)).id },
      select: { messages: true },
    });
    const messages = (conversation?.messages ?? []) as { role: string; content: string }[];
    // Реплики о показе в переписке нет — показа и не было; ответ бота на месте.
    expect(messages.map((m) => m.content)).toEqual(["расмашро фиристед", "Расмҳо ҳоло фиристода нашуданд."]);
  });
});

describe("отправленное видно в переписке CRM", () => {
  it("фотографии ложатся вложениями отдельной репликой перед ответом бота", async () => {
    modelReply({
      reply: ["Ана расмҳояш, бинед"],
      ready: false,
      confident: true,
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
      showPropertyNumber: withPhotosShortId,
    });

    const turn = await processMessengerTurn({
      channel: "FACEBOOK",
      subscriberId: SUBSCRIBER,
      text: "расмашро фиристед",
    });

    expect(turn.reply).toBe("Ана расмҳояш, бинед");
    expectValidModelTurn(turn);
    const conversation = await prisma.botConversation.findUnique({
      where: { id: (await photoThread("FACEBOOK", SUBSCRIBER)).id },
      select: { messages: true },
    });
    const messages = (conversation?.messages ?? []) as {
      role: string;
      content: string;
      attachments?: { kind: string; url?: string }[];
    }[];
    expect(messages).toHaveLength(3);
    // Порядок как у клиента: сначала показ, потом текст.
    expect(messages[1].attachments).toHaveLength(MAX_PHOTOS_PER_OFFER);
    expect(messages[1].attachments?.[0].url).toBe(`/uploads/${photoPrefixes[0]}-0.webp`);
    expect(messages[2].content).toBe("Ана расмҳояш, бинед");
  });
});

describe("неопределённый старый показ не является receipt фотографии", () => {
  it("валидный model turn с legacy unknown mark сохраняет цену/новый вопрос без media и ложного ACK", async () => {
    const thread = await photoThread("FACEBOOK", SUBSCRIBER);
    const inputText = `Объект №${withPhotosShortId}: расмҳои квартираро фиристед, нархаш чанд?`;
    const eventId = `photo-unknown-${runId}`;
    // The legacy unknown mark proves neither current focus nor a price. Resolve
    // a literal current selector against the real public card independently.
    const admission = await admitCustomerPropertyInput({ channel: "FACEBOOK", peer: SUBSCRIBER,
      accountExternalId: thread.account.externalId, transport: thread.transport, eventKind: "message", eventId,
      evidence: customerPropertyEvidenceFromText(inputText) });
    expect(admission.status).toBe("admitted");
    if (admission.status !== "admitted") throw new Error("Expected owned current-selector admission");
    const resolved = await resolveCustomerPropertyTurnContext(admission, [admission.ticket]);
    expect(resolved?.facts?.propertyId).toBe(propertyIds[0]); expect(resolved?.facts?.price).toBe("400000");
    // Make this target the deterministic top match in the actual legacy catalog;
    // neither a model-selected number nor test-injected text is a price source.
    await prisma.property.update({ where: { id: propertyIds[0] }, data: { rooms: 2 } });
    await prisma.botConversation.update({ where: { id: thread.id }, data: {
      leadDraft: { stage: "chatting", intent: "buy", type: "APARTMENT", rooms: 2, districtName: `Тест-район-фото-${runId}` },
    } });
    await prisma.shownProperty.create({ data: { channel: "FACEBOOK", recipientId: SUBSCRIBER,
      shortId: withPhotosShortId, endpointScopeId: null, sentAt: new Date() } });
    const model = { reply: ["Ана расмҳояш. Нархаш 400 000 сомонӣ. Чӣ донистан мехоҳед?"],
      ready: false, confident: true, topic: "photos", openQuestion: "", clientAnsweredOpenQuestion: false,
      showPropertyNumber: withPhotosShortId };
    modelReply(model);
    const turn = await processMessengerTurn({ channel: "FACEBOOK", subscriberId: SUBSCRIBER,
      messageId: eventId, text: inputText, customerPropertyEventKind: "message", customerPropertyAdmission: admission });
    expect(callAiText).toHaveBeenCalled();
    const qualifier = callAiText.mock.calls.find(([input]) => input?.endpoint === "lead-qualify")?.[0] as { system?: string } | undefined;
    const targetLine = qualifier?.system?.split("\n").find(line => line.startsWith(`- №${withPhotosShortId} `));
    expect(Boolean(targetLine)).toBe(true); expect(/400\s?000/u.test(targetLine ?? "")).toBe(true);
    expectValidModelTurn(turn);
    expect(turn.reply).not.toMatch(/Ана\s+расмҳояш/iu);
    expect(turn.reply).toContain("400 000"); expect(turn.reply).toContain("Чӣ донистан мехоҳед?");
    expect(sendImage).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled(); expect(sendLocation).not.toHaveBeenCalled();
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: thread.id }, select: { messages: true } });
    const history = stored.messages as { role: string; content: string; attachments?: unknown[] }[];
    expect(history.at(-1)?.content).toBe(turn.reply);
    expect(history.some(message => (message.attachments?.length ?? 0) > 0)).toBe(false);
  });
  it("вызов отправки без MID остаётся unknown и не подтверждает фотографии клиенту", async () => {
    sendImage.mockResolvedValue(undefined); sendMessage.mockResolvedValue(undefined);
    modelReply({ reply: ["Ана расмҳояш"], ready: false, confident: true, topic: "other",
      openQuestion: "", clientAnsweredOpenQuestion: false, showPropertyNumber: withPhotosShortId });
    const turn = await processMessengerTurn({ channel: "FACEBOOK", subscriberId: SUBSCRIBER,
      messageId: `photo-no-mid-${runId}`, text: "расмашро фиристед" });
    expectValidModelTurn(turn);
    expect(sendImage).toHaveBeenCalledTimes(MAX_PHOTOS_PER_OFFER);
    expect(turn.reply).toBe("Ҳоло фиристодани расмҳоро тасдиқ карда наметавонам.");
    expect(turn.reply).not.toContain("Ана расмҳояш");
  });
});

/**
 * ЭХО СВОИХ ЖЕ ФОТОГРАФИЙ (17.08.2026, та же дыра, что уже нашлась в leadMagnet.ts:
 * «воронка отправляет каждое сообщение дважды»). Meta присылает эхо каждого нашего
 * исходящего тем же вебхуком, что и входящие (is_echo). handleOutgoingEcho отличает
 * своё от чужого только по mid — если показ объекта его не сохранит, эхо выглядит
 * как «сотрудник ответил вручную из телефона», дописывает в переписку вторую копию
 * показа и ставит бота на паузу.
 *
 * У показа несколько отдельных сообщений Meta сразу (по фото + ссылка на карточку),
 * а в переписке CRM они лежат ОДНОЙ репликой — проверяем, что у каждого фото и у
 * ссылки свой mid, и что эхо ЛЮБОГО из них гасится, не только последнего.
 */
describe("эхо собственных фотографий не дублирует переписку", () => {
  it("mid есть у каждого фото и у ссылки, эхо всех них не ставит бота на паузу", async () => {
    const { handleOutgoingEcho } = await import("../src/routes/webhooks.js");
    let n = 0;
    sendImage.mockImplementation(async () => `photo-mid-${++n}`);
    sendMessage.mockImplementation(async () => "link-mid-1");
    modelReply({
      reply: ["Ана расмҳояш"],
      ready: false,
      confident: true,
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
      showPropertyNumber: withPhotosShortId,
    });

    await processMessengerTurn({ channel: "FACEBOOK", subscriberId: SUBSCRIBER, text: "расмашро фиристед" });

    const before = await prisma.botConversation.findUnique({
      where: { id: (await photoThread("FACEBOOK", SUBSCRIBER)).id },
    });
    const beforeMessages = (before?.messages ?? []) as {
      content: string;
      mid?: string;
      attachments?: { mid?: string }[];
    }[];
    const showcaseMsg = beforeMessages.find((m) => (m.attachments?.length ?? 0) > 0);
    expect(showcaseMsg).toBeTruthy();
    const photoMids = (showcaseMsg!.attachments ?? []).map((a) => a.mid).filter((m): m is string => Boolean(m));
    // Каждое отправленное фото обязано нести свой mid — без него его эхо не отличить от чужого.
    expect(photoMids).toHaveLength(MAX_PHOTOS_PER_OFFER);
    expect(showcaseMsg!.mid).toBe("link-mid-1");

    for (const mid of photoMids) {
      await handleOutgoingEcho({ channel: "FACEBOOK", senderId: SUBSCRIBER, text: "", attachmentType: "image", messageId: mid,
        accountExternalId: accounts.get("FACEBOOK")!.externalId });
    }
    await handleOutgoingEcho({
      channel: "FACEBOOK",
      senderId: SUBSCRIBER,
      text: showcaseMsg!.content,
      messageId: showcaseMsg!.mid,
      accountExternalId: accounts.get("FACEBOOK")!.externalId,
    });

    const after = await prisma.botConversation.findUnique({
      where: { id: (await photoThread("FACEBOOK", SUBSCRIBER)).id },
    });
    const afterMessages = (after?.messages ?? []) as unknown[];
    // Ни одного нового сообщения не появилось — эхо всех отправок опознано как своё.
    expect(afterMessages).toHaveLength(beforeMessages.length);
    // Главное: бот не должен думать, что сотрудник перехватил разговор вручную.
    expect(after?.pausedUntil).toBeNull();
  });
});

describe("JPEG-двойник не переживает саму фотографию", () => {
  /** Абсолютный путь к двойнику в общей публичной папке. */
  const twinOf = (name: string) => path.join(uploadsDir, "msg", `${path.basename(name, path.extname(name))}.jpg`);

  it("удаляется ровно один рассчитанный файл, соседние двойники остаются", async () => {
    const mine = `test-${runId}-twin.webp`;
    const neighbour = `test-${runId}-neighbour.webp`;
    await writeUploadedPhoto(mine);
    await writeUploadedPhoto(neighbour);
    // Двойник заводится ленивой отправкой — сначала он должен появиться на диске,
    // иначе тест «удалилось» проходил бы и на пустом месте.
    expect(await messagePhotoPath(`/uploads/${mine}`)).toBe(`/uploads/msg/${path.basename(mine, ".webp")}.jpg`);
    expect(await messagePhotoPath(`/uploads/${neighbour}`)).toBeTruthy();
    expect(fs.existsSync(twinOf(mine))).toBe(true);

    await removeMessagePhoto(`/uploads/${mine}`);

    expect(fs.existsSync(twinOf(mine))).toBe(false);
    // Папка uploads/msg общая для ВСЕХ объектов: промах удаления стирает чужой снимок,
    // и восстановить его неоткуда.
    expect(fs.existsSync(twinOf(neighbour))).toBe(true);
  });

  it("оригинал в JPEG: отдельного двойника нет, и сам оригинал уборка не трогает", async () => {
    const name = `test-${runId}-original.jpg`;
    const file = path.join(uploadsDir, name);
    await sharp({ create: { width: 20, height: 20, channels: 3, background: "#334455" } }).jpeg().toFile(file);
    createdFiles.push(file);

    // messagePhotoPath отдаёт такой файл как есть — значит, удалять «двойник» здесь
    // означало бы стереть саму фотографию объекта.
    expect(await messagePhotoPath(`/uploads/${name}`)).toBe(`/uploads/${name}`);
    await removeMessagePhoto(`/uploads/${name}`);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("отсутствующий двойник — не ошибка: у большинства фотографий его просто нет", async () => {
    await expect(removeMessagePhoto(`/uploads/test-${runId}-never-sent.webp`)).resolves.toBeUndefined();
  });
});

describe("способ показа зависит от канала", () => {
  it("Instagram со своей публикацией: уходит ссылка на пост, а не картинки", async () => {
    const result = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withInstagramShortId);

    // Пост открывается внутри самого приложения и показывает весь альбом — это
    // сильнее трёх картинок.
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "INSTAGRAM",
      IG_RECIPIENT,
      "https://www.instagram.com/p/royal-home-test/",
      accounts.get("INSTAGRAM")!.token,
      { transport: (await photoThread("INSTAGRAM", IG_RECIPIENT)).transport }
    );
    expect(result.link).toBe("https://www.instagram.com/p/royal-home-test/");
  });

  /**
   * Схема требует от instagramUrl только быть URL, поэтому телеграм-ссылка в поле
   * «Ссылка на публикацию Instagram» проходит все проверки: блокировки продажи её
   * считают заполненной, KPI — тоже. Раньше бот отправлял её клиенту прямо в директ
   * Instagram, и человек получал адрес, который у него не открывается.
   */
  it("Instagram, а в поле публикации телеграм-ссылка: уходят фотографии, а не мёртвый адрес", async () => {
    const result = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, telegramLinkShortId);

    // Проверяем сам факт «телеграм-ссылка не ушла», а не совпадение по числу
    // аргументов: у sendMessage появился маркер аккаунта, и сверка по трём
    // аргументам проходила бы теперь ВСЕГДА, даже если ссылка уйдёт.
    expect(sendMessage.mock.calls.some((c) => c[2] === TELEGRAM_LINK)).toBe(false);
    expect(result.link).not.toBe(TELEGRAM_LINK);
    expect(sendImage).toHaveBeenCalledTimes(MAX_PHOTOS_PER_OFFER);
  });

  it("Instagram без публикации: показываем фотографиями, как везде", async () => {
    const result = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, withPhotosShortId);

    expect(sendImage).toHaveBeenCalledTimes(MAX_PHOTOS_PER_OFFER);
    expect(result.attachments).toHaveLength(MAX_PHOTOS_PER_OFFER);
  });

  it("WhatsApp с публикацией всё равно получает фотографии: ссылка увела бы в другое приложение", async () => {
    await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withInstagramShortId);

    expect(sendImage).toHaveBeenCalledTimes(MAX_PHOTOS_PER_OFFER);
  });
});

describe("геометка объекта (19.08.2026)", () => {
  let geoWhatsAppShortId: number;
  let geoInstagramShortId: number;

  beforeAll(async () => {
    geoWhatsAppShortId = await makeProperty(`С координатами WA ${runId}`, 2, { lat: 38.5598, lng: 68.787 });
    geoInstagramShortId = await makeProperty(`С координатами IG ${runId}`, 2, { lat: 38.5598, lng: 68.787 });
  });

  it("WhatsApp: геокодированный объект — уходит sendLocation с координатами", async () => {
    await showPropertyToClient("WHATSAPP", WA_RECIPIENT, geoWhatsAppShortId);

    expect(sendLocation).toHaveBeenCalledTimes(1);
    const [to, lat, lng] = sendLocation.mock.calls[0];
    expect(to).toBe(WA_RECIPIENT);
    expect(lat).toBeCloseTo(38.5598);
    expect(lng).toBeCloseTo(68.787);
  });

  it("WhatsApp: геометка попадает в переписку CRM отдельной репликой со ссылкой на карту", async () => {
    const result = await showPropertyToClient("WHATSAPP", WA_RECIPIENT, geoWhatsAppShortId);
    expect(result.locationLink).toContain("maps.google.com");
    expect(result.locationLink).toContain("38.5598");
  });

  it("объект без координат: sendLocation не вызывается вовсе", async () => {
    await showPropertyToClient("WHATSAPP", WA_RECIPIENT, withPhotosShortId);
    expect(sendLocation).not.toHaveBeenCalled();
  });

  it("Instagram — sendLocation не вызывается: у Send API нет типа сообщения location", async () => {
    const result = await showPropertyToClient("INSTAGRAM", IG_RECIPIENT, geoInstagramShortId);
    expect(sendLocation).not.toHaveBeenCalled();
    expect(result.locationLink).toBeNull();
  });
});

describe("тело запроса к Meta у каналов разное", () => {
  const credentials = {
    waToken: "wa-token",
    waPhoneId: "phone-1",
    igToken: "ig-token",
    pageToken: "page-token",
    pageId: "page-1",
  };

  it("WhatsApp: сообщение типа image со ссылкой в image.link", () => {
    const req = buildImageRequest(credentials, "WHATSAPP", WA_RECIPIENT, "https://crm/uploads/a.jpg");

    expect(req.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/phone-1/messages`);
    expect(req.body).toEqual({
      messaging_product: "whatsapp",
      to: WA_RECIPIENT,
      type: "image",
      image: { link: "https://crm/uploads/a.jpg" },
    });
  });

  it("Instagram: вложение в message.attachment и адрес через instagramApiUrl", () => {
    const req = buildImageRequest(credentials, "INSTAGRAM", IG_RECIPIENT, "https://crm/uploads/a.jpg");

    // Прямой graph.instagram.com с нашего VPS недоступен — адрес обязан собираться
    // тем же способом, что и остальные вызовы Instagram (с прокси, если он настроен).
    expect(req.url).toContain(`/${GRAPH_VERSION}/me/messages`);
    expect(req.body).toEqual({
      recipient: { id: IG_RECIPIENT },
      message: { attachment: { type: "image", payload: { url: "https://crm/uploads/a.jpg" } } },
    });
  });

  it("Messenger: то же вложение, но с messaging_type RESPONSE — иначе Meta режет вне окна", () => {
    const req = buildImageRequest(credentials, "FACEBOOK", "psid-1", "https://crm/uploads/a.jpg");

    expect(req.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/page-1/messages`);
    expect(req.body).toMatchObject({
      recipient: { id: "psid-1" },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "image", payload: { url: "https://crm/uploads/a.jpg", is_reusable: true } } },
    });
  });
});
