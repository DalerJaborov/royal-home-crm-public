import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * TIKTOK ПОПРОСИЛ ПОДОЖДАТЬ — ЭТО НЕ ОТКАЗ (23.09.2026, объект 22.09 в 19:06
 * получил `spam_risk_too_many_pending_share`).
 *
 * До этой правки такой ответ ложился в `failedChannels` наравне с «токен
 * недействителен»: ролик выходил в четыре сети из пяти, в TikTok не выходил
 * НИКОГДА, и повторить было некому. Здесь проверяется вся цепочка на настоящем
 * протоколе TikTok (fetch подменён, база настоящая): признак `retriable`
 * доезжает из ответа площадки, канал не становится «сломанным», и в очереди
 * появляется отложенное задание, которое доведёт публикацию.
 *
 * Аккаунт в подмене — как у владельца: приложение ревью не прошло, поэтому
 * прямая публикация отвечает `unaudited_client_can_only_post_to_private_accounts`
 * и всё идёт через черновики («Входящие»), где потолок в пять неподтверждённых
 * роликов и упирается первым.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY ?? "7e58774a6ca3f8f094b302efc65290b09ba8d51dacebdb60e8e693452f1ab810";

const { prisma } = await import("../src/db.js");
const { publishApprovedPost, isTikTokRetriableCode } = await import("../src/lib/socialPublish.js");
const { publishHandoffResult } = await import("../src/lib/videoHandoff.js");
const { tiktokPublishRetryJob } = await import("../src/jobs/tiktokPublishRetry.js");
const { TIKTOK_PUBLISH_RETRY_JOB_TYPE, tiktokPublishRetryDedupeKey, tiktokPublishRetryBackoffMs } = await import(
  "../src/jobs/tiktokPublishRetryPolicy.js"
);
const { encryptSecret } = await import("../src/crypto.js");
const { uploadsDir } = await import("../src/upload.js");

const runId = Date.now();
const VIDEO_PUBLIC_PATH = `/uploads/handoff/tiktok-retry-${runId}.mp4`;
const videoDiskPath = path.join(uploadsDir, VIDEO_PUBLIC_PATH.slice("/uploads/".length));

let districtId: string;
let propertyId: string;
let savedSettings: Record<string, unknown>;

/**
 * Подмена TikTok. `inboxError` — код, которым инбокс отвечает на init; без него
 * черновик принимается.
 */
function tiktokFetchMock(inboxError: string | null) {
  return vi.fn(async (url: string) => {
    const json = (body: unknown, ok = true, status = 200) =>
      ({ ok, status, json: async () => body }) as unknown as Response;
    if (url.includes("/oauth/token/")) return json({ access_token: "acc-1", refresh_token: "rtoken-1" });
    if (url.includes("/creator_info/query/")) {
      return json({
        data: {
          creator_username: "royal.home.tjk",
          privacy_level_options: ["SELF_ONLY"],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: 60,
        },
      });
    }
    if (url.includes("/inbox/video/init/")) {
      if (inboxError) return json({ error: { code: inboxError, message: "нельзя сейчас" } }, false, 400);
      return json({ data: { publish_id: "pub-inbox-1", upload_url: "https://upload.tiktok.example/inbox" } });
    }
    // Прямая публикация: аккаунт не приватный, ревью не пройдено — TikTok
    // отказывает, и код уходит в черновики (это поведение уже есть в проде).
    if (url.includes("/video/init/")) {
      return json({ error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "нужен приватный аккаунт" } }, false, 400);
    }
    if (url.startsWith("https://upload.tiktok.example/")) return json({});
    // Черновик доехал до «Входящих» — тот же исход, что у владельца, пока
    // приложение не прошло ревью TikTok.
    if (url.includes("/status/fetch/")) return json({ data: { status: "SEND_TO_USER_INBOX" } });
    throw new Error(`неожиданный URL в тесте: ${url}`);
  });
}

async function retryJobs() {
  return prisma.backgroundJob.findMany({ where: { type: TIKTOK_PUBLISH_RETRY_JOB_TYPE, dedupeKey: tiktokPublishRetryDedupeKey(propertyId) } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-tiktok-retry-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект TikTok повтор ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая повтора, 1",
        condition: "GOOD",
      },
    })
  ).id;
  await fs.mkdir(path.dirname(videoDiskPath), { recursive: true });
  await fs.writeFile(videoDiskPath, "fake mp4 bytes");

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaIgToken: current.metaIgToken,
    metaPageToken: current.metaPageToken,
    metaPageId: current.metaPageId,
    telegramChannelId: current.telegramChannelId,
    youtubeRefreshToken: current.youtubeRefreshToken,
    tiktokRefreshToken: current.tiktokRefreshToken,
    tiktokClientKey: current.tiktokClientKey,
    tiktokClientSecret: current.tiktokClientSecret,
    tiktokPrivacyLevel: current.tiktokPrivacyLevel,
    autoPublishEnabled: current.autoPublishEnabled,
  };
  // Настроен ТОЛЬКО TikTok — остальные каналы молча пропускаются.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaIgToken: null,
      metaPageToken: null,
      metaPageId: null,
      telegramChannelId: null,
      youtubeRefreshToken: null,
      tiktokClientKey: "ckey",
      tiktokClientSecret: encryptSecret("csecret"),
      tiktokRefreshToken: encryptSecret("rtoken-1"),
      tiktokPrivacyLevel: "SELF_ONLY",
      autoPublishEnabled: true,
    },
  });
});

beforeEach(async () => {
  await prisma.property.update({
    where: { id: propertyId },
    data: { publishedChannels: [], publishedPostIds: {}, status: "EDITING", videoHandoffFinalPath: VIDEO_PUBLIC_PATH },
  });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: tiktokPublishRetryDedupeKey(propertyId) } });
  logSystemError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: tiktokPublishRetryDedupeKey(propertyId) } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(videoDiskPath, { force: true });
  await prisma.$disconnect();
});

// №174 (ночная проверка 24.09): общая минута раннера короче одной только
// загрузки ролика в TikTok (5 мин) — удавшаяся публикация засчитывалась
// сорвавшейся попыткой с «не завершилось за 60с» в журнале задания.
describe("Срок попытки повтора TikTok", () => {
  it("попытку ждут дольше, чем идёт загрузка ролика, и меньше срока подбора зависших", async () => {
    const { TIKTOK_UPLOAD_TIMEOUT_MS } = await import("../src/lib/socialPublish.js");
    expect(TIKTOK_UPLOAD_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(tiktokPublishRetryJob.timeoutMs ?? 60_000).toBeGreaterThan(TIKTOK_UPLOAD_TIMEOUT_MS);
    // Подбор RUNNING-заданий «воркер умер» — через 15 минут (jobs/runner.ts).
    expect(tiktokPublishRetryJob.timeoutMs ?? 60_000).toBeLessThan(15 * 60_000);
  });
});

describe("Коды TikTok, которые проходят сами", () => {
  it("«слишком много черновиков», «слишком много постов» и лимит запросов — повторяемые", () => {
    expect(isTikTokRetriableCode("spam_risk_too_many_pending_share")).toBe(true);
    expect(isTikTokRetriableCode("spam_risk_too_many_posts")).toBe(true);
    expect(isTikTokRetriableCode("rate_limit_exceeded")).toBe(true);
  });

  it("бан и сломанный токен повторять нечего — они сами не пройдут", () => {
    expect(isTikTokRetriableCode("spam_risk_user_banned_from_posting")).toBe(false);
    expect(isTikTokRetriableCode("access_token_invalid")).toBe(false);
    expect(isTikTokRetriableCode(undefined)).toBe(false);
  });

  it("лесенка повторов идёт часами, а не минутами — лимиты TikTok живут сутками", () => {
    expect(tiktokPublishRetryBackoffMs(0)).toBe(60 * 60_000);
    expect(tiktokPublishRetryBackoffMs(1)).toBe(2 * 60 * 60_000);
    // Потолок — восемь часов, иначе последняя попытка ушла бы за неделю.
    expect(tiktokPublishRetryBackoffMs(10)).toBe(8 * 60 * 60_000);
  });
});

describe("Публикация в TikTok при переполненных «Входящих»", () => {
  it("площадка просит подождать — это не отказ, а признак «повторить позже»", async () => {
    vi.stubGlobal("fetch", tiktokFetchMock("spam_risk_too_many_pending_share"));

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: "Подпись" });

    const tiktok = results.find((r) => r.channel === "TIKTOK");
    expect(tiktok?.ok).toBe(false);
    expect(tiktok?.retriable).toBe(true);
    // Текст для человека, а не код: владельцу нужно знать, что делать.
    expect(tiktok?.error).toMatch(/Входящих/);
    // И журнал говорит «отложена», а не «не удалась» — иначе владелец решит,
    // что ролик потерян, и пойдёт публиковать руками.
    expect(logSystemError.mock.calls.some((c) => String(c[1]).includes("отложена"))).toBe(true);
  });

  it("настоящий отказ признака не получает — повторять бан бессмысленно", async () => {
    vi.stubGlobal("fetch", tiktokFetchMock("spam_risk_user_banned_from_posting"));

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: "Подпись" });

    const tiktok = results.find((r) => r.channel === "TIKTOK");
    expect(tiktok?.ok).toBe(false);
    expect(tiktok?.retriable).toBeFalsy();
  });
});

describe("Отложенный повтор ставится сам", () => {
  it("публикация принятого ролика ставит задание и не помечает канал сломанным", async () => {
    vi.stubGlobal("fetch", tiktokFetchMock("spam_risk_too_many_pending_share"));

    const summary = await publishHandoffResult(propertyId, VIDEO_PUBLIC_PATH);

    // Не в отказах: канал не сломан, ролик выйдет позже.
    expect(summary.failedChannels.map((f) => f.channel)).not.toContain("TIKTOK");
    expect(summary.pendingChannels.map((p) => p.channel)).toContain("TIKTOK");

    const jobs = await retryJobs();
    expect(jobs).toHaveLength(1);
    // Не «прямо сейчас»: раньше часа TikTok ответит тем же самым.
    expect(jobs[0].runAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("второй такой же отказ не плодит второе задание", async () => {
    vi.stubGlobal("fetch", tiktokFetchMock("spam_risk_too_many_pending_share"));

    await publishHandoffResult(propertyId, VIDEO_PUBLIC_PATH);
    await publishHandoffResult(propertyId, VIDEO_PUBLIC_PATH);

    expect(await retryJobs()).toHaveLength(1);
  });
});

describe("Само задание повтора", () => {
  it("«Входящие» разобрали — ролик выходит, канал дописывается в карточку", async () => {
    vi.stubGlobal("fetch", tiktokFetchMock(null));

    await tiktokPublishRetryJob.run({ propertyId }, { attempt: 1 } as never);

    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.publishedChannels).toContain("TIKTOK");
  });

  it("площадка всё ещё просит подождать — задание падает, чтобы очередь повторила его снова", async () => {
    vi.stubGlobal("fetch", tiktokFetchMock("spam_risk_too_many_pending_share"));

    await expect(tiktokPublishRetryJob.run({ propertyId }, { attempt: 1 } as never)).rejects.toThrow(/подождать/);
  });

  it("TikTok уже получил ролик — повтор молчит и никуда не ходит", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { publishedChannels: ["TIKTOK"] } });
    const fetchMock = tiktokFetchMock(null);
    vi.stubGlobal("fetch", fetchMock);

    await tiktokPublishRetryJob.run({ propertyId }, { attempt: 1 } as never);

    // Ни одного запроса: повтор обязан быть идемпотентным, иначе в ленте
    // окажется второй пост того же объекта.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ПРОДАННЫЙ ОБЪЕКТ НЕ ПУБЛИКУЕМ (25.09.2026, пачка «Перезалив честно», Б1):
   лесенка повтора тянется до полутора суток, объект за это время продают. */
describe("Повтор TikTok для объекта вне продажи", () => {
  it.each(["SOLD", "WITHDRAWN", "RESERVED"] as const)("%s — без публикации, задание завершается, одна запись в журнал", async (status) => {
    await prisma.property.update({ where: { id: propertyId }, data: { status } });
    const fetchMock = tiktokFetchMock(null);
    vi.stubGlobal("fetch", fetchMock);

    // Не бросает: иначе очередь крутила бы лесенку повторов дальше.
    await expect(tiktokPublishRetryJob.run({ propertyId }, { attempt: 1 } as never)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.publishedChannels).not.toContain("TIKTOK");
    const ours = logSystemError.mock.calls.filter((c) => String(c[1]).includes("повтор TikTok отменён"));
    expect(ours).toHaveLength(1);
  });
});
