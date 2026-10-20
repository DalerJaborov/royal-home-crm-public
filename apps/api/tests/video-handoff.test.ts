import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { headOfQueueRunAt } from "./helpers/queueHead.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Ручная передача видео монтажёру через Telegram/CRM (lib/videoHandoff.ts,
 * 01.09.2026). Покрывает то, что владелец назвал главным условием: очередь
 * строго один-в-работе, потолок Telegram 20 МБ, публикация без второй
 * модерации и освобождение очереди при получении готового ролика.
 *
 * Telegram (sendMessage/sendDocumentFile), пуш и публикация в соцсети —
 * подменены: тест не ходит ни в Telegram, ни в Instagram/Facebook.
 */

const {
  sendMessage,
  sendDocumentFile,
  sendDocument,
  sendPushToAgent,
  sendPushToAgents,
  publishApprovedPost,
  publishAfterEditingComplete,
  logSystemError,
  makePropertyCover,
  probeMediaInfo,
} = vi.hoisted(() => ({
    sendMessage: vi.fn(async () => {}),
    // document.file_id/file_unique_id — по filename, чтобы досылка по file_id
    // (задание B/C, 24.09.2026) была детерминированной в тестах: разные ролики
    // получают разные "id", один и тот же ролик — один и тот же на повторе.
    sendDocumentFile: vi.fn(async (_chatId: string, _file: unknown, filename: string) => ({
      message_id: 1,
      document: { file_id: `fid-${filename}`, file_unique_id: `fuid-${filename}` },
    })),
    // Досылка по file_id (sendDocument принимает file_id вместо URL) — не
    // мокалась раньше, потому что раньше не звалась в этом пути вовсе.
    sendDocument: vi.fn(async () => ({})),
    sendPushToAgent: vi.fn(async () => {}),
    // Уведомление о результате публикации (notifyVideoHandoffPublishResult,
    // случай №114) шлёт нескольким получателям сразу — подменяем и её, иначе
    // тест бил бы в реальный webpush/Notification без нужды.
    sendPushToAgents: vi.fn(async () => 0),
    publishApprovedPost: vi.fn(async () => []),
    publishAfterEditingComplete: vi.fn(async () => ({ updated: {} })),
    logSystemError: vi.fn(async () => {}),
    // Обложка ChatGPT подменена (25.09.2026): сети в тестах нет. По умолчанию
    // null — «обложка не создана», как у объекта без фото; тесты обложки
    // включают успех одним mockResolvedValueOnce.
    makePropertyCover: vi.fn(async (): Promise<{ squareUrl: string; storyUrl: string; cached: boolean } | null> => null),
    // Ворота приёма (checkEditedClip, 23.09.2026) зовут probeMediaInfo
    // напрямую — без мока настоящий ffprobe (в песочнице его нет, см.
    // tests/property-clip-video-upload.test.ts) вернул бы null на любом фейковом
    // Buffer.from(...) тесте и УСЁ РАВНО пропустил бы приём («не смогли
    // проверить» не значит «плохой», см. checkEditedClip), но тогда тесты этого
    // файла проверяли бы не ворота, а их отсутствие. По умолчанию — нормальный
    // ролик со звуком, чтобы существующие тесты приёма (до этой правки) остались
    // зелёными; каждый тест самих ворот переопределяет одним mockResolvedValueOnce.
    probeMediaInfo: vi.fn(async () => ({
      hasVideo: true,
      hasAudio: true,
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1080,
      height: 1920,
      rotation: 0,
      durationSec: 12,
      sizeBytes: 1024,
    })),
  }));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
  sendDocument,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost,
}));
vi.mock("../src/lib/propertyPipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyPipeline.js")>()),
  publishAfterEditingComplete,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));
vi.mock("../src/lib/video/coverOpenAi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/video/coverOpenAi.js")>()),
  makePropertyCover,
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeMediaInfo,
}));

// Ссылка на скачивание строится от публичного адреса CRM — без него
// видно было бы только «заберите через карточку», а проверяем мы именно ссылку.
process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { videoHandoffDir, videoTmpDir } = await import("../src/upload.js");
const { MIN_GAP_MIN } = await import("../src/lib/publishSchedule.js");
const {
  queueVideoHandoff,
  receiveEditedVideo,
  skipVideoHandoffOnManualPublish,
  cancelVideoHandoffQueueEntry,
  videoHandoffQueuePositions,
  montajerCardText,
  resendSourceVideos,
  montajerFileName,
  releaseVideoHandoffForTrashed,
  queueStatusForMontajer,
  videoHandoffPublishDedupeKey,
  VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
  dispatchToEditor,
  setVideoHandoffQueuePaused,
  videoHandoffQueueState,
  settleBackgroundHandoffDispatches,
} = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { trashProperty } = await import("../src/lib/trashProperty.js");
// Публикация принятого ролика (21.09.2026, случай №114) больше не происходит
// внутри receiveEditedVideo — она ставится фоновым заданием
// (video-handoff-publish) и требует прогона очереди тем же прогонщиком, что и
// в проде: runBackgroundJobsTick() (импорт тянет реальные обработчики через
// jobs/handlers.js, включая наш — регистрация побочным эффектом импорта).
const { runBackgroundJobsTick } = await import("../src/jobs/runner.js");
/**
 * Приём ролика + прогон очереди.
 *
 * СВОЁ ЗАДАНИЕ СТАВИМ В ГОЛОВУ ОЧЕРЕДИ, ЧУЖИЕ СТРОКИ НЕ ТРОГАЕМ.
 * runBackgroundJobsTick() берёт не больше 10 самых старых по runAt заданий, а
 * `video-handoff-publish` — HEAVY_TYPES (jobs/runner.ts), из них тик берёт не
 * больше ОДНОГО. Любая чужая PENDING-строка с более старым runAt съест
 * единственный тяжёлый слот раньше нашей.
 *
 * Здесь стояло `deleteMany({ status: "PENDING", dedupeKey: { not: … } })` —
 * снос ВСЕХ ожидающих строк по всей таблице, включая чужие. Заменено на сдвиг
 * СВОЕГО runAt в прошлое (#871), но ОДНОГО сдвига мало, и на этом файл
 * покраснел в полном прогоне 24.09.2026: брошенная строка РАНЕЕ прошедшего
 * файла могла быть ещё старше нашей и занять единственный тяжёлый слот, а тик
 * был один — наше задание не исполнялось вовсе, и проверка падала на пустом
 * уведомлении. Поэтому тикаем, пока СВОЁ задание не уйдёт из очереди.
 *
 * Сдвиг заодно снимает вопрос расстановки по времени (21.09.2026,
 * lib/publishSchedule.ts): она ставит runAt на ближайший подходящий слот, не
 * обязательно «сейчас», а этот файл проверяет САМУ публикацию, а не
 * расстановку (та проверена отдельно, publish-schedule.test.ts).
 */
async function receiveAndPublish(propertyId: string, buffer: Buffer, filename: string) {
  const result = await receiveEditedVideo(propertyId, buffer, filename);
  await tickUntilOwnJobRan(videoHandoffPublishDedupeKey(propertyId));
  return result;
}

/**
 * Крутить очередь, пока СВОЁ задание не будет исполнено.
 *
 * Своё — в голову партии сдвигом своего `runAt` (чужие строки не трогаем), но
 * этого мало: `video-handoff-publish` из HEAVY_TYPES, а тяжёлое задание тик
 * берёт ровно одно. Брошенная строка прошедшего файла может оказаться ещё
 * старше нашей и занять слот, и один тик тогда исполняет ЕЁ, а не наше.
 * Поэтому тикаем, пока наша строка не уйдёт из PENDING/RUNNING: следующий тик
 * возьмёт её, когда чужая уже отработала.
 */
/**
 * ЗАПАС ПО ЧАСАМ, А НЕ ПО ТИКАМ.
 *
 * Потолок у `tickUntilOwnJobRan` стоит в ТИКАХ (20), а предел vitest — в
 * СЕКУНДАХ (20). Про друг друга они не знают: один тик выполняет партию
 * ЦЕЛИКОМ, до десяти заданий, среди которых бывают тяжёлые чужие
 * (`clip-compress` и прочий ffmpeg, оставленные прошедшими файлами этого же
 * процесса). На засорённой очереди нескольких тиков хватает, чтобы перебрать
 * двадцать секунд, и тест падает «Test timed out in 20000ms» при исправном
 * коде — в одиночку тот же файл проходит за секунды.
 *
 * Тот же приём применён в `stuck-work.test.ts` (#855) и
 * `background-jobs.test.ts`. Гасить проверку нельзя, ускорить чужую партию
 * отсюда невозможно — значит нужен честный запас по времени.
 *
 * Запас даётся ВСЕМУ файлу, а не отдельным тестам: до очереди здесь
 * дотягиваются и те тесты, что зовут её не прямо, а через `receiveAndPublish`
 * и `withAutoPublish`, — перечислять их поимённо значит однажды забыть новый.
 */
const QUEUE_TEST_TIMEOUT_MS = 90_000;
vi.setConfig({ testTimeout: QUEUE_TEST_TIMEOUT_MS });

async function tickUntilOwnJobRan(dedupeKey: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const mine = await prisma.backgroundJob.findFirst({
      where: { dedupeKey },
      select: { status: true },
    });
    // dedupeKey снимается при финальном статусе (runner.ts), поэтому исчезнувшая
    // строка означает «исполнено», а не «потеряно».
    if (!mine || (mine.status !== "PENDING" && mine.status !== "RUNNING")) return;
    await prisma.backgroundJob.updateMany({
      where: { dedupeKey, status: "PENDING" },
      data: { runAt: headOfQueueRunAt() },
    });
    await runBackgroundJobsTick();
  }
  throw new Error(`задание ${dedupeKey} так и не исполнилось за ${attempts} тиков`);
}

const runId = Date.now();
const phone1 = `+99295${runId.toString().slice(-7)}`;

let districtId: string;
let montajerId: string;
const propertyIds: string[] = [];
/** Каталоги сырых роликов, созданные тестом, — убираем за собой. */
const rawVideoDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

async function setHandoffSettings(enabled: boolean, montajerAgentId: string | null) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: enabled, videoMontajerAgentId: montajerAgentId },
    create: { id: "singleton", videoHandoffEnabled: enabled, videoMontajerAgentId: montajerAgentId },
  });
}

async function seedProperty() {
  const property = await prisma.property.create({
    data: {
      title: `Передача видео-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 48,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 11",
      condition: "GOOD",
      // Ведущий агент: его имя уходит монтажёру отдельной строкой (21.09.2026).
      assignedAgentId: montajerId,
    },
  });
  propertyIds.push(property.id);
  return property;
}

/**
 * Сырой ролик, который РЕАЛЬНО лежит на диске: путь берётся из того же
 * localVideoFilePath, которым пользуется отправка, поэтому тест проверяет
 * настоящую ветку с файлом, а не ту, где монтажёру уходит один лишь пуш.
 *
 * Размер задаётся truncate — разрежённым файлом. Шестьдесят мегабайт места не
 * занимают, а stat честно сообщает шестьдесят: ровно то, что нужно проверке
 * «тяжёлый уходит ссылкой», и заодно доказательство, что размер берётся до
 * чтения файла в память.
 */
async function addRawVideoFile(propertyId: string, filename: string, sizeBytes: number) {
  // Ключ хранилища — строго uuid/uuid.расширение (KEY_RE в localVideoStorage.ts);
  // человеческое имя файла живёт отдельным полем и в путь не попадает.
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error(`не разрешился путь хранилища для ${storageKey}`);
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  await handle.truncate(sizeBytes);
  await handle.close();
  rawVideoDirs.add(pathMod.dirname(filePath));
  return prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename, sizeBytes, uploadedById: montajerId },
  });
}

async function handoffState(id: string) {
  return prisma.property.findUniqueOrThrow({
    where: { id },
    select: { videoHandoffStatus: true, videoHandoffFinalPath: true },
  });
}

beforeEach(async () => {
  if (!districtId) {
    const district = await prisma.district.create({ data: { name: `Передача видео-${runId}` } });
    districtId = district.id;
  }
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  sendDocument.mockClear();
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
  publishApprovedPost.mockClear();
  publishAfterEditingComplete.mockClear();
  logSystemError.mockClear();
  // mockClear (не mockReset) — реализация по умолчанию из vi.hoisted выше
  // остаётся на месте, чистятся только счётчики вызовов между тестами.
  probeMediaInfo.mockClear();
  if (!montajerId) {
    // Прибираем хвосты от прежнего прерванного локального прогона этого файла
    // (тот самый HEAVY-слот, который иначе ворует у свежего задания — см.
    // afterAll и докстринг receiveAndPublish). afterAll обычного прогона это
    // уже делает; здесь — на случай, если прошлый прогон не дошёл до него.
    await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
    const agent = await prisma.agent.create({
      data: {
        fullName: "Монтажёр теста",
        phone: phone1,
        role: "AGENT",
        passwordHash: await bcrypt.hash("testpass123", 10),
      },
    });
    montajerId = agent.id;
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
    });
    originalSettings = settings
      ? { videoHandoffEnabled: settings.videoHandoffEnabled, videoMontajerAgentId: settings.videoMontajerAgentId }
      : null;
  }
});

afterEach(async () => {
  // Следующий из очереди уходит монтажёру В ФОНЕ (24.09.2026) — дожидаемся,
  // иначе отправка прошлого теста пишет в журнал и моки уже следующего.
  await settleBackgroundHandoffDispatches();
  // Очередь общая на всю таблицу Property — без сброса статус SENT_TO_EDITOR,
  // оставшийся от одного теста, ломает editorIsBusy() в следующем.
  if (propertyIds.length) {
    await prisma.property.updateMany({
      where: { id: { in: propertyIds } },
      data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null },
    });
  }
});

afterAll(async () => {
  if (originalSettings) {
    await prisma.settings.update({ where: { id: "singleton" }, data: originalSettings });
  } else {
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: false, videoMontajerAgentId: null } });
  }
  // Задания публикации (случай №114) — иначе зависший PENDING от прерванного
  // локального прогона переживает файл и на следующем запуске ворует
  // единственный HEAVY-слот тика у свежего задания другого теста.
  await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const dir of rawVideoDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  rawVideoDirs.clear();
  await prisma.agent.deleteMany({ where: { phone: phone1 } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });

  // receiveEditedVideo реально пишет файл на диск (uploads/handoff) — подчищаем
  // за собой, иначе тестовые ролики копятся там вечно.
  const files = await fs.readdir(videoHandoffDir).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => propertyIds.some((id) => f.startsWith(id)))
      .map((f) => fs.unlink(`${videoHandoffDir}/${f}`).catch(() => {}))
  );
});

describe("Рубильники передачи видео", () => {
  it("выключенный videoHandoffEnabled — молчаливый no-op", async () => {
    const property = await seedProperty();
    await setHandoffSettings(false, montajerId);

    await queueVideoHandoff(property.id);

    const after = await handoffState(property.id);
    expect(after.videoHandoffStatus).toBe("NONE");
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("включён, но монтажёр не назначен — журнал ошибки, объект не трогается", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, null);

    await queueVideoHandoff(property.id);

    const after = await handoffState(property.id);
    expect(after.videoHandoffStatus).toBe("NONE");
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("монтажёр не назначен"));
  });
});

describe("Очередь строго один-в-работе", () => {
  it("монтажёр свободен — объект уходит сразу (SENT_TO_EDITOR), пуш монтажёру (нет привязанного Telegram)", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);

    await queueVideoHandoff(property.id);

    const after = await handoffState(property.id);
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    // Нет сырого видео — dispatchToEditor честно откажется файлом, но статус
    // SENT_TO_EDITOR уже занял очередь (см. lib/videoHandoff.ts::dispatchToEditor).
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("монтажёр уже занят другим объектом — новый становится QUEUED, не забирает очередь", async () => {
    const busy = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(busy.id);
    expect((await handoffState(busy.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const next = await seedProperty();
    await queueVideoHandoff(next.id);

    expect((await handoffState(next.id)).videoHandoffStatus).toBe("QUEUED");
  });

  /**
   * Два объекта, одобренных ОДНОВРЕМЕННО, — ровно тот случай, который дал
   * перепутанные ролики 19.09.2026: агент завела две квартиры одного продавца
   * подряд. Место монтажёра проверялось и занималось двумя отдельными
   * запросами, а зовут постановку в очередь не дожидаясь
   * (`void queueVideoHandoff(...)` в routes/properties/moderation.ts) — оба
   * объекта успевали увидеть место свободным. Дальше возвращённый ролик
   * привязывается к «самому старому SENT_TO_EDITOR» (telegram/bot.ts), то есть
   * готовый ролик одного объекта уезжает в карточку другого.
   */
  it("два объекта одобрены одновременно — место монтажёра занимает РОВНО один", async () => {
    await setHandoffSettings(true, montajerId);
    const first = await seedProperty();
    const second = await seedProperty();

    await Promise.all([queueVideoHandoff(first.id), queueVideoHandoff(second.id)]);

    const statuses = [(await handoffState(first.id)).videoHandoffStatus, (await handoffState(second.id)).videoHandoffStatus];
    expect(statuses.filter((s) => s === "SENT_TO_EDITOR")).toHaveLength(1);
    expect(statuses.filter((s) => s === "QUEUED")).toHaveLength(1);
  });

  /**
   * Удаление объекта из очереди не трогало videoHandoffStatus вовсе (найдено
   * 19.09.2026). Удалённый объект оставался SENT_TO_EDITOR навсегда — сам он
   * RECEIVED уже не станет, — и все следующие объекты вставали в QUEUED
   * замертво. Наружу это выглядит как «монтажёру перестали приходить ролики»,
   * без единой строчки в журнале.
   */
  it("объект удалён из очереди — место освобождается и следующий уезжает монтажёру", async () => {
    await setHandoffSettings(true, montajerId);
    const withEditor = await seedProperty();
    await queueVideoHandoff(withEditor.id);
    const next = await seedProperty();
    await queueVideoHandoff(next.id);
    expect((await handoffState(next.id)).videoHandoffStatus).toBe("QUEUED");

    await trashProperty(withEditor.id, montajerId);

    expect((await handoffState(next.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    // Удалённый объект места больше не держит и в очереди не показывается.
    const positions = await videoHandoffQueuePositions();
    expect(positions.get(withEditor.id)).toBeUndefined();
    expect(positions.get(next.id)).toBe(1);
  });
});

/**
 * ОТЛОЖЕННЫЙ КОНТЕЙНЕР INSTAGRAM — НЕ ОТКАЗ (случай №111, 21.09.2026). Проверяем
 * то, что решает publishHandoffResult, когда publishApprovedPost вернул
 * `pending: true` (см. lib/socialPublish.ts::rememberInstagramContainer): это
 * состояние не должно попасть ни в succeededChannels (пост ещё не висит), ни в
 * failedChannels (канал не сломан) — иначе монтажёру ушла бы ложь либо в одну,
 * либо в другую сторону, а строка соцсетей карточки показала бы Instagram
 * красным. Сама запись PendingInstagramContainer и текст в журнале проверены
 * отдельно, юнит-тестом на rememberInstagramContainer/waitForInstagramContainerReady
 * (social-publish-instagram-pending.test.ts) и на runInstagramPendingContainersTick
 * (instagram-pending-containers-tick.test.ts) — здесь важна только честность
 * сводки, которую видит вызывающий код.
 */
describe("Отложенный контейнер Instagram — честная сводка (не отказ, не успех)", () => {
  beforeEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
  });
  afterEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: false } });
  });

  it("ТОЛЬКО Instagram pending — не succeeded, не failed, объект не уходит в AVAILABLE", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);

    publishApprovedPost.mockResolvedValueOnce([
      { channel: "INSTAGRAM", ok: false, pending: true, error: "Видео не обработалось за отведённое время ожидания" },
    ]);

    // Публикация — фоновое задание (случай №114): result.summary приёма всегда
    // null, честный итог виден только по состоянию карточки и по уведомлению,
    // которое шлёт задание (notifyVideoHandoffPublishResult), см. ниже.
    const result = await receiveAndPublish(property.id, Buffer.from("готовый ролик"), "final.mp4");
    expect(result.ok).toBe(true);
    expect(publishAfterEditingComplete).not.toHaveBeenCalled();

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { instagramUrl: true, publishedChannels: true } });
    expect(after.instagramUrl).toBeNull();
    expect(after.publishedChannels).toEqual([]);
    // Уведомление ушло, честно называет Instagram «ещё обрабатывается», а не отказом.
    const call = sendPushToAgents.mock.calls.at(-1);
    expect(String(call?.[1]?.body ?? "")).toContain("обрабатывается");
    expect(String(call?.[1]?.body ?? "")).not.toContain("Не ушло");
  });

  it("Facebook succeeded + Instagram pending — Facebook дописан в карточку, Instagram ни там, ни в отказах", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);

    publishApprovedPost.mockResolvedValueOnce([
      { channel: "FACEBOOK", ok: true, postId: "fb-post-1" },
      { channel: "INSTAGRAM", ok: false, pending: true, error: "Видео не обработалось за отведённое время ожидания" },
    ]);

    await receiveAndPublish(property.id, Buffer.from("готовый ролик"), "final.mp4");

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { publishedChannels: true, publishedPostIds: true } });
    expect(after.publishedChannels).toEqual(["FACEBOOK"]);
    expect((after.publishedPostIds as Record<string, string> | null)?.FACEBOOK).toBe("fb-post-1");
  });

  /**
   * КАНАЛ ОТМЕЧАЕТСЯ СРАЗУ, А НЕ В КОНЦЕ (22.09.2026, класс «страховка ставится
   * после окна, которое должна страховать»). Пять каналов идут по очереди
   * минутами; до этой правки карточка узнавала об успехах только когда
   * возвращался последний. Рестарт посреди (автовыкат идёт по каждому мержу в
   * main) стирал память об уже вышедших постах, и повтор задания шёл в те же
   * каналы заново — дубль живого поста, который «нельзя развидеть».
   * Здесь падение изображает такой обрыв: Facebook уже опубликован колбэком,
   * дальше публикация умирает — Facebook обязан остаться в карточке.
   */
  it("публикация оборвалась после второго канала — уже вышедшие каналы записаны в карточку, повтор в них не пойдёт", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);

    publishApprovedPost.mockImplementationOnce(async (params: {
      onChannelPublished?: (r: { channel: string; ok: boolean; postId?: string }) => Promise<void>;
    }) => {
      await params.onChannelPublished?.({ channel: "YOUTUBE", ok: true, postId: "yt-1" });
      await params.onChannelPublished?.({ channel: "FACEBOOK", ok: true, postId: "fb-1" });
      throw new Error("процесс умер посреди публикации");
    });

    await receiveAndPublish(property.id, Buffer.from("готовый ролик"), "final.mp4");

    const after = await prisma.property.findUniqueOrThrow({
      where: { id: property.id },
      select: { publishedChannels: true, publishedPostIds: true },
    });
    expect([...after.publishedChannels].sort()).toEqual(["FACEBOOK", "YOUTUBE"]);
    const postIds = after.publishedPostIds as Record<string, string> | null;
    expect(postIds?.YOUTUBE).toBe("yt-1");
    expect(postIds?.FACEBOOK).toBe("fb-1");
  });

  /**
   * ОБОРОТНАЯ СТОРОНА ТОЙ ЖЕ ПРАВКИ. Раз каналы теперь записываются сразу, на
   * повторной попытке после перезапуска они уже все в карточке — публиковать
   * нечего, ни одного НОВОГО успеха в этот заход нет. Выход в продажу при этом
   * никто не сделал: раньше он висел внутри «если хоть что-то опубликовалось»,
   * и объект оставался вне продажи навсегда, с постами во всех сетях.
   */
  it("повтор после обрыва: новых успехов нет, но объект всё равно доводится до продажи", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: "/uploads/p0.webp", thumbUrl: "/uploads/thumbs/p0.webp", order: 0 },
    });
    // Состояние после обрыва: посты уже висят, ссылка на обзор записана, а
    // объект всё ещё на монтаже — в продажу его выводит именно этот повтор
    // (уже продающийся объект повторно не «выходит», 24.09.2026).
    await prisma.property.update({
      where: { id: property.id },
      data: {
        status: "EDITING",
        publishedChannels: ["INSTAGRAM", "FACEBOOK"],
        instagramUrl: "https://www.instagram.com/reel/AbCdEf/",
      },
    });
    // Все каналы пропущены как уже опубликованные — публиковать нечего.
    publishApprovedPost.mockResolvedValueOnce([]);

    await receiveAndPublish(property.id, Buffer.from("готовый ролик"), "final.mp4");

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { status: true } });
    expect(after.status).toBe("AVAILABLE");
    expect(publishAfterEditingComplete).toHaveBeenCalledTimes(1);
  });
});

/**
 * ОБЛОЖКА ТОЛЬКО ОТ CHATGPT (25.09.2026). Сбой ChatGPT (сеть, лимит, цифры) —
 * `makePropertyCover` отдаёт null, и публикация идёт БЕЗ обложки: наш шаблон
 * запасным путём больше не служит. Удалась — в Reels/Telegram уходит вертикаль.
 */
describe("Обложка ChatGPT в публикации ролика", () => {
  beforeEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
  });
  afterEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: false } });
  });

  it("ChatGPT не справился (null) — публикация вызвана без обложки", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);
    makePropertyCover.mockClear();
    publishApprovedPost.mockClear();

    await receiveEditedVideo(property.id, Buffer.from("готовый ролик"), "final.mp4");
    await tickUntilOwnJobRan(videoHandoffPublishDedupeKey(property.id));

    expect(makePropertyCover).toHaveBeenCalledWith(property.id);
    expect(publishApprovedPost).toHaveBeenCalledTimes(1);
    expect(publishApprovedPost.mock.calls[0]?.[0]?.localCoverPath ?? null).toBeNull();
  });

  it("обложка создана — в публикацию уходит вертикаль из /uploads/covers", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);
    makePropertyCover.mockResolvedValueOnce({
      squareUrl: `/uploads/covers/${property.id}-x-square.jpg`,
      storyUrl: `/uploads/covers/${property.id}-x-story.jpg`,
      cached: false,
    });
    publishApprovedPost.mockClear();

    await receiveEditedVideo(property.id, Buffer.from("готовый ролик"), "final.mp4");
    await tickUntilOwnJobRan(videoHandoffPublishDedupeKey(property.id));

    expect(publishApprovedPost).toHaveBeenCalledTimes(1);
    expect(publishApprovedPost.mock.calls[0]?.[0]?.localCoverPath).toBe(`/uploads/covers/${property.id}-x-story.jpg`);
  });
});

describe("Приём готового ролика", () => {
  it("объект не в статусе SENT_TO_EDITOR — файл не публикуется, только журнал", async () => {
    const property = await seedProperty();

    await receiveEditedVideo(property.id, Buffer.from("test"), "ready.mp4");

    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("передача уже не активна"));
    expect(publishAfterEditingComplete).not.toHaveBeenCalled();
  });

  it("готовый ролик получен — статус RECEIVED, путь сохранён, публикация вызвана без второй модерации", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);
    expect((await handoffState(property.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const result = await receiveEditedVideo(property.id, Buffer.from("готовый ролик"), "final.mp4");

    const after = await handoffState(property.id);
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffFinalPath).toMatch(/^\/uploads\/handoff\//);
    // Нет отдельного клика «одобрить» — публикация идёт сразу отсюда.
    expect(publishAfterEditingComplete).not.toHaveBeenCalled(); // блокеры (мало фото/нет ссылки) держат вне AVAILABLE
    // Факты принятого файла для квитанции монтажёру (23.09.2026, объект №127) —
    // media/filename уходят наружу, а не теряются внутри finishReceivingVideo.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).toBe("final.mp4");
      expect(result.media?.hasAudio).toBe(true);
    }
  });

  /**
   * Б8 (25.09.2026, уборка диска): пересылка после сбоя/повторный приём заменяет
   * прежний финал — до этой правки прежний файл убирался, а его старая
   * кадр-обложка (-cover.jpg, кадр-обложка убрана из выпуска в #953, но старые
   * файлы остались на проде) оставалась на диске мусором навсегда.
   */
  it("новый приём убирает прежний финал И его старую кадр-обложку", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);

    const oldFinalName = `${property.id}-${Date.now()}0.mp4`;
    const oldFinalPath = pathMod.join(videoHandoffDir, oldFinalName);
    const oldCoverPath = pathMod.join(videoHandoffDir, `${oldFinalName.replace(/\.mp4$/, "")}-cover.jpg`);
    await fs.writeFile(oldFinalPath, "прежний финал");
    await fs.writeFile(oldCoverPath, "старая кадр-обложка");
    await prisma.property.update({ where: { id: property.id }, data: { videoHandoffFinalPath: `/uploads/handoff/${oldFinalName}` } });

    const result = await receiveEditedVideo(property.id, Buffer.from("новый готовый ролик"), "new-final.mp4");
    expect(result.ok).toBe(true);

    const after = await handoffState(property.id);
    expect(after.videoHandoffFinalPath).toMatch(/^\/uploads\/handoff\//);
    expect(after.videoHandoffFinalPath).not.toBe(`/uploads/handoff/${oldFinalName}`);

    await expect(fs.access(oldFinalPath)).rejects.toThrow();
    await expect(fs.access(oldCoverPath)).rejects.toThrow();
    const newFinalPath = pathMod.join(videoHandoffDir, pathMod.basename(after.videoHandoffFinalPath!));
    await expect(fs.access(newFinalPath)).resolves.toBeUndefined();
  });

  /**
   * ВОРОТА ПРИЁМА (23.09.2026, объект №127 — монтажёр вернул боту НЕ
   * смонтированный ролик, а побайтно тот же исходник агента, без звука, и CRM
   * приняла его без единой проверки).
   */
  describe("Ворота: ролик от монтажёра отклонён", () => {
    it("без аудио — отказ, статус остаётся SENT_TO_EDITOR, файла нет, BackgroundJob не поставлен, место монтажёра не освобождено", async () => {
      const current = await seedProperty();
      await setHandoffSettings(true, montajerId);
      await queueVideoHandoff(current.id);
      const queued = await seedProperty();
      await queueVideoHandoff(queued.id);
      expect((await handoffState(queued.id)).videoHandoffStatus).toBe("QUEUED");

      probeMediaInfo.mockResolvedValueOnce({
        hasVideo: true,
        hasAudio: false,
        videoCodec: "h264",
        audioCodec: null,
        width: 1080,
        height: 1920,
        rotation: 0,
        durationSec: 10,
        sizeBytes: 500,
      });

      // Каталог uploads/handoff ОБЩИЙ на все процессы прогона (в отличие от
      // videoTmpDir, см. tests/setup.ts) — считаем только файлы ЭТОГО объекта:
      // имя ролика начинается с id объекта (lib/videoHandoff.ts). Общий счёт
      // ловил чужой ролик из соседнего процесса (сведение #1030, 02.10.2026).
      const ownFiles = async () =>
        (await fs.readdir(videoHandoffDir).catch(() => [] as string[])).filter((f) => f.startsWith(current.id));
      const before = await ownFiles();
      const result = await receiveEditedVideo(current.id, Buffer.from("без звука"), "silent.mp4");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("нет звуковой дорожки");
      expect((await handoffState(current.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
      expect(await ownFiles()).toEqual(before);
      // Место монтажёра НЕ освобождено — следующий в очереди остаётся ждать.
      expect((await handoffState(queued.id)).videoHandoffStatus).toBe("QUEUED");
      const jobs = await prisma.backgroundJob.findMany({
        where: { dedupeKey: videoHandoffPublishDedupeKey(current.id) },
      });
      expect(jobs.length).toBe(0);
      expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("отклонён"));

      await prisma.propertyVideo.deleteMany({ where: { propertyId: queued.id } });
    });

    it("совпадает с исходником (md5) — отказ с именем исходника, статус не меняется", async () => {
      const property = await seedProperty();
      await setHandoffSettings(true, montajerId);
      await queueVideoHandoff(property.id);

      const sourceSize = 4096;
      await addRawVideoFile(property.id, "исходник-объекта.mp4", sourceSize);

      // Тот же файл побайтно — объект №127: монтажёр вернул исходник агента
      // вместо смонтированного ролика, md5 совпал.
      const result = await receiveEditedVideo(property.id, Buffer.alloc(sourceSize), "final.mp4");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("исходник-объекта.mp4");
      expect((await handoffState(property.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

      await prisma.propertyVideo.deleteMany({ where: { propertyId: property.id } });
    });

    it("короче 3 секунд — отказ", async () => {
      const property = await seedProperty();
      await setHandoffSettings(true, montajerId);
      await queueVideoHandoff(property.id);

      probeMediaInfo.mockResolvedValueOnce({
        hasVideo: true,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
        width: 1080,
        height: 1920,
        rotation: 0,
        durationSec: 1.5,
        sizeBytes: 200,
      });

      const result = await receiveEditedVideo(property.id, Buffer.from("обрезок"), "clip.mp4");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("короче 3 секунд");
    });

    it("нет видеопотока — отказ «файл не читается как видео»", async () => {
      const property = await seedProperty();
      await setHandoffSettings(true, montajerId);
      await queueVideoHandoff(property.id);

      probeMediaInfo.mockResolvedValueOnce({
        hasVideo: false,
        hasAudio: false,
        videoCodec: null,
        audioCodec: null,
        width: null,
        height: null,
        rotation: 0,
        durationSec: 0,
        sizeBytes: 10,
      });

      const result = await receiveEditedVideo(property.id, Buffer.from("не видео"), "notvideo.bin");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("не читается как видео");
    });

    it("ffprobe недоступен (probeMediaInfo вернул null) — ролик принят БЕЗ проверки, журнал предупреждён", async () => {
      const property = await seedProperty();
      await setHandoffSettings(true, montajerId);
      await queueVideoHandoff(property.id);

      probeMediaInfo.mockResolvedValueOnce(null);

      const result = await receiveEditedVideo(property.id, Buffer.from("непроверяемый"), "final.mp4");

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.media).toBeUndefined();
      expect((await handoffState(property.id)).videoHandoffStatus).toBe("RECEIVED");
      expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("проверить ролик не удалось"));
    });
  });

  it("освобождает очередь: следующий QUEUED объект уходит монтажёру СРАЗУ по приёму файла, не дожидаясь публикации", async () => {
    const current = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(current.id);
    const queued = await seedProperty();
    await queueVideoHandoff(queued.id);
    expect((await handoffState(queued.id)).videoHandoffStatus).toBe("QUEUED");
    // dispatchToEditor честно отказывается без сырого видео — заводим одно,
    // иначе следующий в очереди никогда не дойдёт до отправки монтажёру.
    await prisma.propertyVideo.create({
      data: { propertyId: queued.id, storageKey: `${queued.id}/raw.mp4`, filename: "raw.mp4", sizeBytes: 100, uploadedById: montajerId },
    });

    sendPushToAgent.mockClear();
    // РАССТАНОВКА ПО ВРЕМЕНИ (21.09.2026): публикация может ждать своего слота
    // часами (задание фоновое, runAt — не «сейчас»), а держать монтажёра без
    // работы всё это время значило бы свести на нет саму очередь — поэтому
    // место освобождается ЗДЕСЬ, сразу по приёму, ещё ДО того, как задание
    // публикации хоть раз тикнуло.
    await receiveEditedVideo(current.id, Buffer.from("готовый ролик"), "final.mp4");

    const queuedAfter = await handoffState(queued.id);
    expect(queuedAfter.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    // Файлы следующему уходят в фоне (24.09.2026): приём не ждёт их отправку.
    await settleBackgroundHandoffDispatches();
    // Монтажёр без привязанного Telegram — уведомление обычным пушем CRM.
    expect(sendPushToAgent).toHaveBeenCalled();

    await prisma.propertyVideo.deleteMany({ where: { propertyId: queued.id } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: videoHandoffPublishDedupeKey(current.id) } });
  });
});

/**
 * ДВА ОДНОВРЕМЕННЫХ ПРИЁМА НЕ ПОЛУЧАЮТ ОДИН СЛОТ (22.09.2026).
 *
 * Слот считается от последнего уже выданного: «прочитал максимум — записал
 * свой». Без замка два приёма, идущие параллельно, читают один и тот же
 * максимум и садятся на одну минуту — пачка снова уходит залпом, ради чего
 * расстановка и вводилась, причём молча: каждая запись по отдельности верна.
 *
 * Случай достижим не только через очередь монтажёра (там одновременно занят
 * один объект): `openForManualFinalVideo` (lib/publishedVideoFix.ts, правка
 * уже выпущенного ролика) ставит объект в SENT_TO_EDITOR МИМО очереди, и
 * таких объектов может ждать несколько сразу — здесь это и воспроизводится.
 *
 * ПЯТЬ, А НЕ ДВА. С двумя параллельными приёмами гонка не воспроизводилась ни
 * разу: они успевают разойтись на походах к диску и в базу, и проверка была бы
 * зелёной и без замка — то есть бесполезной. С пятью без замка падает каждый
 * раз (проверено снятием замка).
 */
describe("Расстановка по времени под параллельным приёмом", () => {
  it("пять роликов, принятых одновременно, садятся на разные слоты с полным промежутком", async () => {
    const props = [];
    for (let i = 0; i < 5; i += 1) props.push(await seedProperty());
    const [first, second] = props;
    await setHandoffSettings(true, montajerId);
    // Мимо очереди, как это делает правка уже выпущенного ролика: оба объекта
    // ждут готовый файл одновременно.
    await prisma.property.updateMany({
      where: { id: { in: props.map((p) => p.id) } },
      data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() },
    });

    // Слот занимает только ролик, который правда уйдёт сам (24.09.2026).
    const saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
    try {
      await Promise.all(props.map((p, i) => receiveEditedVideo(p.id, Buffer.from(`ролик ${i}`), `r${i}.mp4`)));
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: saved?.autoPublishEnabled ?? false } });
    }

    const slots = await prisma.property.findMany({
      where: { id: { in: props.map((p) => p.id) } },
      select: { scheduledPublishAt: true },
      orderBy: { scheduledPublishAt: "asc" },
    });
    const times = slots.map((s) => s.scheduledPublishAt?.getTime() ?? 0);
    expect(times).toHaveLength(props.length);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(MIN_GAP_MIN * 60_000);
    }

    await prisma.backgroundJob.deleteMany({
      where: { dedupeKey: { in: props.map((p) => videoHandoffPublishDedupeKey(p.id)) } },
    });
  });
});

/**
 * ОЧЕРЕДЬ — ЧИСЛОМ РОЛИКОВ, А НЕ СПИСКОМ НОМЕРОВ ОБЪЕКТОВ (владелец
 * 21.09.2026: «напиши просто, сколько роликов осталось на монтаж, а не какие
 * объекты остались»). Считаем именно РОЛИКИ (PropertyVideo), не объекты — у
 * одного объекта их может быть несколько, монтажёр меряет работу файлами.
 */
describe("Очередь — числом роликов, с верным склонением", () => {
  it("подпись к ролику: пусто, если за ним никого нет — строка не печатается вовсе", async () => {
    await setHandoffSettings(true, montajerId);
    const property = await seedProperty();
    await addRawVideoFile(property.id, "raw.mp4", 1024);

    await queueVideoHandoff(property.id);

    const caption = String(sendDocumentFile.mock.calls[0]?.[3] ?? "");
    expect(caption).not.toContain("Дальше в очереди");

    await prisma.propertyVideo.deleteMany({ where: { propertyId: property.id } });
  });

  it("подпись к ролику: несколько роликов в очереди — единое число с правильным склонением, без номеров объектов", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);
    const current = await seedProperty();
    await addRawVideoFile(current.id, "raw-current.mp4", 1024);
    await queueVideoHandoff(current.id);
    sendDocumentFile.mockClear();
    sendDocument.mockClear();

    // Второй объект в очереди приносит с собой ДВА сырых ролика — так что
    // "объектов в очереди" (1) и "роликов в очереди" (2) — разные числа, и
    // именно роликов ждёт увидеть владелец.
    const queued = await seedProperty();
    await queueVideoHandoff(queued.id);
    await addRawVideoFile(queued.id, "raw-1.mp4", 1024);
    await addRawVideoFile(queued.id, "raw-2.mp4", 1024);

    // Пересылка исходников текущего объекта пересобирает подпись (buildMontajerMessageText)
    // и покажет актуальный статус очереди — ровно то же, что видит монтажёр при обычной передаче.
    // Ролик уже уходил файлом при queueVideoHandoff выше и получил telegramFileId —
    // повтор (задание B, 24.09.2026) идёт по file_id (sendDocument), не заново
    // потоком с диска (sendDocumentFile).
    // Все файлы уже у монтажёра — «файлы» без force ничего не шлёт (25.09.2026),
    // поэтому пересылаем всё явно, как кнопка «📥 Прислать файлами».
    await resendSourceVideos({ force: true });

    expect(sendDocumentFile).not.toHaveBeenCalled();
    const caption = String(sendDocument.mock.calls[0]?.[2] ?? "");
    expect(caption).toContain("Дальше в очереди: 2 ролика.");
    // Ни один номер объекта из очереди не должен утекать в текст.
    expect(caption).not.toContain(`№${queued.shortId}`);

    await prisma.propertyVideo.deleteMany({ where: { propertyId: current.id } });
    await prisma.propertyVideo.deleteMany({ where: { propertyId: queued.id } });
  });

  it("queueStatusForMontajer отвечает числом с верным склонением и гаснет, когда очередь пуста", async () => {
    await setHandoffSettings(true, montajerId);
    const current = await seedProperty();
    await queueVideoHandoff(current.id);

    expect(await queueStatusForMontajer()).not.toContain("Дальше в очереди");

    const onlyOne = await seedProperty();
    await addRawVideoFile(onlyOne.id, "raw.mp4", 1024);
    await queueVideoHandoff(onlyOne.id);
    expect(await queueStatusForMontajer()).toContain("Дальше в очереди: 1 ролик.");

    const five = [] as string[];
    for (let i = 0; i < 4; i++) {
      const p = await seedProperty();
      await addRawVideoFile(p.id, `raw-${i}.mp4`, 1024);
      await queueVideoHandoff(p.id);
      five.push(p.id);
    }
    // 1 (onlyOne) + 4 (five) = 5 роликов ждут своей очереди позади current.
    expect(await queueStatusForMontajer()).toContain("Дальше в очереди: 5 роликов.");

    for (const id of [onlyOne.id, ...five]) await prisma.propertyVideo.deleteMany({ where: { propertyId: id } });
  });
});

/**
 * ПЕРЕМЕШАННЫЕ ОПИСАНИЯ ДВУХ КВАРТИР ОДНОГО ПРОДАВЦА (19.09.2026, объекты
 * №108/111/112).
 *
 * Данные на проде показали: карточки верные, подписи публикаций верные, в
 * журнале ни одной правки объектов. Ошибка родилась в переписке монтажёра —
 * факты объекта уходили ей РОВНО ОДИН РАЗ, подписью к первому файлу, а на
 * вопрос «отправь информацию ролика» бот отвечал только статусом очереди.
 * Прочитать данные было негде, и они были восстановлены по памяти из того, что
 * осталось выше в чате, — по предыдущей квартире.
 *
 * Обе проверки ниже без починки красные.
 */
describe("Данные объекта монтажёру — всегда доступны, а не один раз", () => {
  it("у объекта два ролика: факты карточки уходят с КАЖДЫМ файлом, а не только с первым", async () => {
    const property = await seedProperty();
    await addRawVideoFile(property.id, "IMG_0001.mov", 1024);
    await addRawVideoFile(property.id, "IMG_0002.mov", 2048);
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);

    await queueVideoHandoff(property.id);

    const captions = sendDocumentFile.mock.calls.map((c) => String(c[3] ?? ""));
    expect(captions).toHaveLength(2);
    // Площадь и комнаты — это ровно то, что монтажёр наносит на сам ролик.
    for (const caption of captions) {
      expect(caption).toContain(`Объект №${property.shortId}`);
      expect(caption).toContain("Площадь: 48");
      expect(caption).toContain("Тестовая, 11");
      // Имя агента — владелец 21.09.2026: монтажёру должно быть у кого спросить.
      expect(caption).toContain("Агент: Монтажёр теста");
    }
    // Строку правил передачи убрали из карточки целиком (владелец 21.09.2026:
    // «лишнюю информацию удали из карточки телеграма монтажёру») — карточка
    // несёт только факты объекта и очередь, правила теперь только по «помощь».
    for (const caption of captions) {
      expect(caption).not.toContain("Своя обложка");
      expect(caption).not.toContain("«меню»");
    }

    await prisma.propertyVideo.deleteMany({ where: { propertyId: property.id } });
  });

  it("монтажёр спрашивает данные по номеру — карточка приходит даже после того, как ролик принят", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);
    // Ролик принят: до починки в этот момент бот отвечал «сейчас монтаж ничего
    // не ждёт» — ровно то, что случилось на проде 19.09 в 12:47.
    await receiveEditedVideo(property.id, Buffer.from("готовый ролик"), "final.mp4");

    const card = await montajerCardText(property.shortId);

    expect(card).toContain(`Объект №${property.shortId}`);
    expect(card).toContain("Площадь: 48");
    expect(card).toContain("Тестовая, 11");
  });

  it("чужой номер объекта не отдаёт чужие факты молча — бот честно говорит, что не нашёл", async () => {
    const card = await montajerCardText(99_999_999);
    expect(card).toContain("не найден");
  });

  it("«прислать файлы заново»: всё уже у монтажёра — не шлёт и говорит об этом; force — шлёт по file_id, очередь не двигает", async () => {
    const property = await seedProperty();
    await addRawVideoFile(property.id, "IMG_0003.mov", 1024);
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);
    sendDocumentFile.mockClear();
    sendDocument.mockClear();

    // Ролик уже ушёл файлом при queueVideoHandoff и получил telegramFileId —
    // повтор «файлы» (задание B, 24.09.2026) идёт по file_id, не заново с диска.
    // Слово «файлы» — только недошедшие (25.09.2026): всё дошло — ничего не шлём.
    const nothing = await resendSourceVideos();
    expect(nothing).toEqual({ ok: false, shortId: property.shortId, alreadyAll: 1 });
    expect(sendDocument).not.toHaveBeenCalled();

    const resent = await resendSourceVideos({ force: true });

    expect(resent).toEqual({ ok: true, shortId: property.shortId });
    expect(sendDocumentFile).not.toHaveBeenCalled();
    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect((await handoffState(property.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    await prisma.propertyVideo.deleteMany({ where: { propertyId: property.id } });
  });
});

/**
 * Обложка публикаций — ЕДИНСТВЕННЫЙ источник: кадр из самого ролика
 * (владелец, 21.09.2026: «обложки будем мы с тобой генерировать, сделаем
 * механизм скоро» — приём обложки от монтажёра вручную, заведённый 19.09.2026
 * взамен переиспользования обложки YouTube, снят целиком). Публикация не
 * должна ломаться без него — она просто не получает обложку, если ffmpeg не
 * смог вытянуть кадр (тестовое видео ненастоящее, ffmpeg на нём падает
 * ожидаемо), и никогда не падает сама.
 */
describe("Обложка публикаций — только кадром из ролика (обложка от монтажёра отключена 21.09.2026)", () => {
  async function withAutoPublish<T>(fn: () => Promise<T>): Promise<T> {
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
    try {
      return await fn();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: before?.autoPublishEnabled ?? false } });
    }
  }

  it("видео не настоящее (ffmpeg не вытянет кадр) — публикация идёт без обложки, не падает", async () => {
    await withAutoPublish(async () => {
      const property = await seedProperty();
      await setHandoffSettings(true, montajerId);
      await queueVideoHandoff(property.id);

      const result = await receiveAndPublish(property.id, Buffer.from("не настоящий mp4"), "final.mp4");

      expect(result.ok).toBe(true);
      expect(publishApprovedPost).toHaveBeenCalledTimes(1);
      const call = publishApprovedPost.mock.calls[0][0] as { localCoverPath: string | null };
      expect(call.localCoverPath).toBeNull();
    });
  });

  it("модуль больше не экспортирует приём обложки от монтажёра", async () => {
    const module = await import("../src/lib/videoHandoff.js");
    expect((module as Record<string, unknown>).receiveHandoffCover).toBeUndefined();
  });
});

/**
 * Найдено 19.09.2026 на проде: кнопка «Готово» и автопубликация по вручную
 * вписанной ссылке (routes/properties/crud.ts) уводят объект в AVAILABLE в
 * обход бота монтажёра — если на объекте в этот момент висел незакрытый
 * хендофф, editorIsBusy() держала место монтажёра занятым ИМЕННО ЭТИМ
 * объектом навсегда, и очередь за ним не двигалась вообще (№104/106 ушли в
 * продажу так, №107 позади них сутки не получал видео). Эти тесты бьют по
 * skipVideoHandoffOnManualPublish напрямую — она и есть починка.
 */
describe("Публикация в обход бота закрывает хендофф (иначе очередь мертва)", () => {
  it("объект держал место монтажёра (SENT_TO_EDITOR) — статус закрывается, следующий QUEUED уходит в работу", async () => {
    const current = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(current.id);
    expect((await handoffState(current.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const queued = await seedProperty();
    await queueVideoHandoff(queued.id);
    expect((await handoffState(queued.id)).videoHandoffStatus).toBe("QUEUED");
    // Без сырого видео на позади стоящем объекте dispatchToEditor честно
    // откажется отправкой — заводим его, иначе освобождение очереди не
    // получится увидеть.
    await prisma.propertyVideo.create({
      data: { propertyId: queued.id, storageKey: `${queued.id}/raw.mp4`, filename: "raw.mp4", sizeBytes: 100, uploadedById: montajerId },
    });

    await skipVideoHandoffOnManualPublish(current.id);

    const currentAfter = await handoffState(current.id);
    expect(currentAfter.videoHandoffStatus).toBe("RECEIVED");
    const currentRow = await prisma.property.findUniqueOrThrow({ where: { id: current.id }, select: { videoHandoffSentAt: true } });
    // Пустая дата — иначе findResendCandidate (окно 3 часа) предложит монтажёру
    // «переслать» именно сюда, хотя ролик через бота на этот объект не приходил.
    expect(currentRow.videoHandoffSentAt).toBeNull();

    const queuedAfter = await handoffState(queued.id);
    expect(queuedAfter.videoHandoffStatus).toBe("SENT_TO_EDITOR");

    await prisma.propertyVideo.deleteMany({ where: { propertyId: queued.id } });
  });

  it("объект просто ждал своей очереди (QUEUED) — статус закрывается, но чужую очередь не трогает", async () => {
    const busy = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(busy.id);
    expect((await handoffState(busy.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const skipped = await seedProperty();
    await queueVideoHandoff(skipped.id);
    expect((await handoffState(skipped.id)).videoHandoffStatus).toBe("QUEUED");

    await skipVideoHandoffOnManualPublish(skipped.id);

    expect((await handoffState(skipped.id)).videoHandoffStatus).toBe("RECEIVED");
    // Объект, реально державший место монтажёра, публикацией чужого QUEUED не задет.
    expect((await handoffState(busy.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });

  it("хендоффа не было (NONE) — no-op, ничего не ломает и не отправляет", async () => {
    const property = await seedProperty();

    await skipVideoHandoffOnManualPublish(property.id);

    expect((await handoffState(property.id)).videoHandoffStatus).toBe("NONE");
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});

/**
 * Ручная отмена из очереди (владелец 19.09.2026, тот же день: «чтобы админ и
 * монтажёр и директор видели очередь и могли отменять»). В отличие от
 * skipVideoHandoffOnManualPublish объект НЕ публикуется — только снимается
 * с передачи боту, поэтому если он держал место монтажёра, тот уже получил
 * файл и должен узнать, что доделывать не нужно.
 */
describe("Ручная отмена из очереди (cancelVideoHandoffQueueEntry)", () => {
  it("снимает объект, державший место монтажёра, отпускает очередь, уведомляет монтажёра в Telegram", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    const current = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(current.id);
    expect((await handoffState(current.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const queued = await seedProperty();
    await queueVideoHandoff(queued.id);
    await prisma.propertyVideo.create({
      data: { propertyId: queued.id, storageKey: `${queued.id}/raw.mp4`, filename: "raw.mp4", sizeBytes: 100, uploadedById: montajerId },
    });

    sendMessage.mockClear();
    const result = await cancelVideoHandoffQueueEntry(current.id);

    expect(result).toEqual({ ok: true });
    expect((await handoffState(current.id)).videoHandoffStatus).toBe("RECEIVED");
    expect((await handoffState(queued.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    // Монтажёр уже держал файл в руках — молчания недостаточно.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1] ?? "")).toContain(`№${(await prisma.property.findUniqueOrThrow({ where: { id: current.id }, select: { shortId: true } })).shortId}`);
    expect(String(sendMessage.mock.calls[0][1] ?? "")).toContain("не нужно");

    await prisma.propertyVideo.deleteMany({ where: { propertyId: queued.id } });
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: null } });
  });

  it("снимает объект, просто ждавший очереди (QUEUED) — без уведомления, монтажёр его не видел", async () => {
    await setHandoffSettings(true, montajerId);
    const busy = await seedProperty();
    await queueVideoHandoff(busy.id);
    const skipped = await seedProperty();
    await queueVideoHandoff(skipped.id);
    expect((await handoffState(skipped.id)).videoHandoffStatus).toBe("QUEUED");

    sendMessage.mockClear();
    const result = await cancelVideoHandoffQueueEntry(skipped.id);

    expect(result).toEqual({ ok: true });
    expect((await handoffState(skipped.id)).videoHandoffStatus).toBe("RECEIVED");
    expect(sendMessage).not.toHaveBeenCalled();
    // Объект, реально державший место монтажёра, — не задет чужой отменой.
    expect((await handoffState(busy.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });

  /**
   * №138 (ночная проверка 24.09): снятие с монтажа ставит передаче RECEIVED без
   * готового ролика, а объект остаётся в EDITING. Карточка монтажёра смотрела
   * только на статус объекта и говорила «Ролик уже принят, объект на монтаже» —
   * про ролик, которого никто не присылал.
   */
  it("после снятия с монтажа карточка монтажёра не говорит «ролик уже принят»", async () => {
    await setHandoffSettings(true, montajerId);
    const property = await seedProperty();
    await prisma.property.update({ where: { id: property.id }, data: { status: "EDITING" } });
    await queueVideoHandoff(property.id);
    await settleBackgroundHandoffDispatches();

    expect(await cancelVideoHandoffQueueEntry(property.id)).toEqual({ ok: true });
    await settleBackgroundHandoffDispatches();
    const state = await prisma.property.findUniqueOrThrow({
      where: { id: property.id },
      select: { status: true, videoHandoffStatus: true, videoHandoffFinalPath: true },
    });
    expect(state).toMatchObject({ status: "EDITING", videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: null });

    const card = await montajerCardText(property.shortId);
    expect(card).not.toContain("Ролик уже принят");
    expect(card).toContain("снят");
  });

  it("объект не в очереди — честная ошибка, ничего не меняет", async () => {
    const property = await seedProperty();

    const result = await cancelVideoHandoffQueueEntry(property.id);

    expect(result).toEqual({ ok: false, code: "NOT_IN_QUEUE", error: expect.stringContaining("не в очереди монтажа") });
    expect((await handoffState(property.id)).videoHandoffStatus).toBe("NONE");
  });

  it("несуществующий объект — честная ошибка", async () => {
    const result = await cancelVideoHandoffQueueEntry("00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ ok: false, code: "NOT_FOUND", error: expect.stringContaining("не найден") });
  });
});

/**
 * СНЯТИЕ ДЕРЖАТЕЛЯ: ЯВНЫЙ ВЫБОР И ПАУЗА ОЧЕРЕДИ (24.09.2026). Администратор снял
 * №133, №134, №135 подряд — и каждое снятие молча отдало монтажёру следующий
 * объект. Теперь «Снять и придержать очередь» освобождает место, не выдавая
 * следующего, а «Возобновить» отдаёт место сразу.
 */
describe("Снятие с монтажа: пауза очереди, атомарность, прерванная отправка", () => {
  async function withChat<T>(fn: () => Promise<T>): Promise<T> {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    try {
      return await fn();
    } finally {
      await settleBackgroundHandoffDispatches();
      // Прямой записью, а не setVideoHandoffQueuePaused(false): возобновление
      // выдало бы место чужому объекту из общей очереди.
      await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffQueuePaused: false } });
      await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: null } });
    }
  }

  it("снять держателя с holdQueue — следующий остаётся QUEUED, очередь на паузе, монтажёр предупреждён", async () => {
    await withChat(async () => {
      await setHandoffSettings(true, montajerId);
      const holder = await seedProperty();
      await queueVideoHandoff(holder.id);
      expect((await handoffState(holder.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
      const next = await seedProperty();
      await queueVideoHandoff(next.id);
      expect((await handoffState(next.id)).videoHandoffStatus).toBe("QUEUED");

      sendMessage.mockClear();
      const result = await cancelVideoHandoffQueueEntry(holder.id, { holdQueue: true });

      expect(result).toEqual({ ok: true });
      expect((await handoffState(holder.id)).videoHandoffStatus).toBe("RECEIVED");
      expect((await handoffState(next.id)).videoHandoffStatus).toBe("QUEUED");
      const state = await videoHandoffQueueState();
      expect(state.paused).toBe(true);
      expect(state.holder).toBeNull();
      // Монтажёр узнаёт о снятии, а новых файлов не получает.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(String(sendMessage.mock.calls[0][1] ?? "")).toContain("сняли с монтажа");
      expect(sendDocumentFile).not.toHaveBeenCalled();
      expect(await queueStatusForMontajer()).toContain("на паузе");

      // Одобрение при паузе — в очередь, а не монтажёру, хотя место свободно.
      const approvedDuringPause = await seedProperty();
      await queueVideoHandoff(approvedDuringPause.id);
      expect((await handoffState(approvedDuringPause.id)).videoHandoffStatus).toBe("QUEUED");
    });
  });

  it("возобновить — место сразу уходит следующему, время выдачи — сейчас", async () => {
    await withChat(async () => {
      await setHandoffSettings(true, montajerId);
      await setVideoHandoffQueuePaused(true);
      const next = await seedProperty();
      await queueVideoHandoff(next.id);
      expect((await handoffState(next.id)).videoHandoffStatus).toBe("QUEUED");
      // Своё — в голову очереди (чужие строки не трогаем): постановка «вчера».
      // Порядок очереди — videoHandoffQueueOrder (lib/videoHandoff.ts::orderedQueue).
      await prisma.property.update({
        where: { id: next.id },
        data: { videoHandoffSentAt: new Date(Date.now() - 24 * 60 * 60 * 1000), videoHandoffQueueOrder: -1 },
      });

      const before = Date.now();
      await setVideoHandoffQueuePaused(false);

      const row = await prisma.property.findUniqueOrThrow({
        where: { id: next.id },
        select: { videoHandoffStatus: true, videoHandoffSentAt: true },
      });
      expect(row.videoHandoffStatus).toBe("SENT_TO_EDITOR");
      // Иначе сторож досылки видел бы «выдан сутки назад» и слал дубль.
      expect(row.videoHandoffSentAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect((await videoHandoffQueueState()).paused).toBe(false);
    });
  });

  it("статус изменился между чтением и записью — STATE_CHANGED, чужое состояние не затёрто", async () => {
    await setHandoffSettings(true, montajerId);
    const holder = await seedProperty();
    await queueVideoHandoff(holder.id);
    expect((await handoffState(holder.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    // Приём ролика «в ту же секунду»: держим строку, пока снятие её читает, и
    // меняем статус до того, как снятие дойдёт до записи. Postgres перепроверит
    // условие updateMany на свежей версии строки — и не найдёт её.
    let cancelPromise: Promise<Awaited<ReturnType<typeof cancelVideoHandoffQueueEntry>>> | null = null;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Property" WHERE id = ${holder.id} FOR UPDATE`;
      cancelPromise = cancelVideoHandoffQueueEntry(holder.id);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await tx.property.update({ where: { id: holder.id }, data: { videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: "/uploads/handoff/accepted.mp4" } });
    });
    const result = await cancelPromise!;

    expect(result).toEqual({ ok: false, code: "STATE_CHANGED", error: expect.stringContaining("изменилось") });
    const after = await handoffState(holder.id);
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffFinalPath).toBe("/uploads/handoff/accepted.mp4");
    await prisma.property.update({ where: { id: holder.id }, data: { videoHandoffFinalPath: null } });
  });

  it("сняли во время отправки — остальные файлы не уходят, доставка не отмечена, в журнале «прервана»", async () => {
    await withChat(async () => {
      await setHandoffSettings(true, montajerId);
      await setVideoHandoffQueuePaused(true); // объект встанет в очередь, отправим его сами
      const property = await seedProperty();
      await addRawVideoFile(property.id, "one.mp4", 1024);
      await addRawVideoFile(property.id, "two.mp4", 1024);
      await addRawVideoFile(property.id, "three.mp4", 1024);
      await queueVideoHandoff(property.id);
      await prisma.property.update({ where: { id: property.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });

      // Первый файл «уходит», и в этот момент объект снимают.
      sendDocumentFile.mockImplementationOnce(async () => {
        await prisma.property.update({ where: { id: property.id }, data: { videoHandoffStatus: "RECEIVED" } });
      });
      const delivered = await dispatchToEditor(property.id, montajerId);

      expect(delivered).toBe(false);
      expect(sendDocumentFile).toHaveBeenCalledTimes(1);
      const row = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { videoHandoffDeliveredAt: true } });
      expect(row.videoHandoffDeliveredAt).toBeNull();
      const journal = await waitFor(() =>
        prisma.montajerMessage.findFirst({ where: { propertyId: property.id, text: { contains: "отправка прервана" } } })
      );
      expect(journal?.text).toContain("отправка прервана: объект сняли");
    });
  });
});

/**
 * releaseVideoHandoffForTrashed НАПРЯМУЮ (21.09.2026, аудит «монтажёр ↔ CRM») —
 * до этой правки функция не была покрыта ни одним тестом, хотя именно она
 * 19.09.2026 чинила «немую смерть очереди»: объект удалили, пока монтажёр его
 * держал, и очередь вставала навсегда без единой ошибки в журнале. Тест
 * "объект удалён из очереди" выше бьёт по тому же механизму, но через
 * trashProperty (SENT_TO_EDITOR-случай); здесь — прямой вызов на все три ветки:
 * SENT_TO_EDITOR, QUEUED и объект вне очереди вовсе.
 */
describe("releaseVideoHandoffForTrashed — напрямую", () => {
  it("SENT_TO_EDITOR удалён — место освобождается, следующий уезжает монтажёру, монтажёр уведомлён", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);
    const withEditor = await seedProperty();
    await queueVideoHandoff(withEditor.id);
    expect((await handoffState(withEditor.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const next = await seedProperty();
    await queueVideoHandoff(next.id);
    expect((await handoffState(next.id)).videoHandoffStatus).toBe("QUEUED");
    // dispatchToEditor честно отказывается без сырого видео у следующего.
    await prisma.propertyVideo.create({
      data: { propertyId: next.id, storageKey: `${next.id}/raw.mp4`, filename: "raw.mp4", sizeBytes: 100, uploadedById: montajerId },
    });

    sendMessage.mockClear();
    await releaseVideoHandoffForTrashed([withEditor.id]);

    const withEditorAfter = await handoffState(withEditor.id);
    expect(withEditorAfter.videoHandoffStatus).toBe("RECEIVED");
    const withEditorRow = await prisma.property.findUniqueOrThrow({
      where: { id: withEditor.id },
      select: { videoHandoffSentAt: true },
    });
    // Пустая дата — та же причина, что у skipVideoHandoffOnManualPublish/
    // cancelVideoHandoffQueueEntry: удалённый объект не должен попадать в
    // findResendCandidate.
    expect(withEditorRow.videoHandoffSentAt).toBeNull();
    // Место освободилось — следующий из очереди уехал сразу, а не ждёт
    // следующего одобрения постороннего объекта.
    expect((await handoffState(next.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    // Монтажёр уже держал файл в руках — молчания недостаточно, шлём короткое
    // сообщение с номером удалённого объекта.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = String(sendMessage.mock.calls[0][1] ?? "");
    expect(text).toContain(`№${withEditor.shortId}`);
    expect(text).toContain("не нужно");

    await prisma.propertyVideo.deleteMany({ where: { propertyId: next.id } });
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: null } });
  });

  it("QUEUED удалён — монтажёр его никогда не видел, уведомление НЕ шлём", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);
    const busy = await seedProperty();
    await queueVideoHandoff(busy.id);
    const queued = await seedProperty();
    await queueVideoHandoff(queued.id);
    expect((await handoffState(queued.id)).videoHandoffStatus).toBe("QUEUED");

    sendMessage.mockClear();
    await releaseVideoHandoffForTrashed([queued.id]);

    expect((await handoffState(queued.id)).videoHandoffStatus).toBe("RECEIVED");
    expect(sendMessage).not.toHaveBeenCalled();
    // Объект, реально державший место монтажёра, — не задет удалением чужого QUEUED.
    expect((await handoffState(busy.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: null } });
  });

  it("удалённый объект не связан с очередью хендоффа (NONE) — no-op, чужую очередь не трогает", async () => {
    await setHandoffSettings(true, montajerId);
    const busy = await seedProperty();
    await queueVideoHandoff(busy.id);
    const unrelated = await seedProperty(); // videoHandoffStatus остаётся NONE

    sendMessage.mockClear();
    await releaseVideoHandoffForTrashed([unrelated.id]);

    expect((await handoffState(unrelated.id)).videoHandoffStatus).toBe("NONE");
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await handoffState(busy.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });

  it("пустой список id — no-op, ни одного запроса к базе не роняет", async () => {
    await expect(releaseVideoHandoffForTrashed([])).resolves.toBeUndefined();
  });
});

describe("Позиции в очереди для экрана конвейера (videoHandoffQueuePositions)", () => {
  it("держащий место монтажёра — позиция 1, ждущие за ним — 2, 3... по порядку отправки в очередь", async () => {
    await setHandoffSettings(true, montajerId);
    const first = await seedProperty();
    await queueVideoHandoff(first.id);
    const second = await seedProperty();
    await queueVideoHandoff(second.id);
    const third = await seedProperty();
    await queueVideoHandoff(third.id);

    const positions = await videoHandoffQueuePositions();

    expect(positions.get(first.id)).toBe(1);
    expect(positions.get(second.id)).toBe(2);
    expect(positions.get(third.id)).toBe(3);
  });

  it("объект вне хендоффа — вовсе не в карте", async () => {
    const property = await seedProperty();

    const positions = await videoHandoffQueuePositions();

    expect(positions.has(property.id)).toBe(false);
  });
});

/**
 * К9 (аудит безопасности 11.09.2026): POST /:id/video-handoff/upload теперь
 * принимает файл через multer diskStorage (upload.ts, videoTmpUpload) вместо
 * memoryStorage — сам обработчик читает временный файл в буфер РАЗ и удаляет
 * его в finally. Остальные тесты этого файла бьют мимо HTTP (receiveEditedVideo
 * напрямую с готовым Buffer) и диск-путь не задевают вовсе — этот проверяет
 * именно его: настоящий multipart-запрос, настоящий multer, настоящая уборка.
 */
describe("Наблюдатели монтажа (копии в Telegram)", () => {
  async function withObserver(fn: (observerChat: string) => Promise<void>) {
    const observerChat = `observer-${runId}`;
    const observer = await prisma.agent.create({
      data: {
        fullName: "Наблюдатель теста",
        phone: `+99296${runId.toString().slice(-7)}`,
        role: "ADMIN",
        passwordHash: await bcrypt.hash("testpass123", 10),
        telegramChatId: observerChat,
        montageCopiesTelegram: true,
      },
    });
    try {
      await fn(observerChat);
    } finally {
      await prisma.agent.delete({ where: { id: observer.id } });
    }
  }

  it("наблюдатель получает тот же файл с припиской «Копия. Монтажёр: …», монтажёр — без неё", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);
    const property = await seedProperty();
    await addRawVideoFile(property.id, "raw.mp4", 1024);

    await withObserver(async (observerChat) => {
      await queueVideoHandoff(property.id);

      // Монтажёр — первый получатель этого ролика: файла с таким file_id ещё
      // не было, значит грузим целиком.
      const fileCalls = sendDocumentFile.mock.calls as unknown as [string, Buffer, string, string][];
      const toMontajer = fileCalls.filter((c) => c[0] === `chat-${runId}`);
      expect(toMontajer).toHaveLength(1);
      expect(toMontajer[0][3]).not.toContain("Копия.");

      // Наблюдатель получает file_id того же файла (задание C, 24.09.2026),
      // не повторную загрузку с диска — sendDocumentFile его чат не видит вовсе.
      expect(fileCalls.some((c) => c[0] === observerChat)).toBe(false);
      const sentFilename = String(toMontajer[0][2] ?? "");
      const idCalls = sendDocument.mock.calls as unknown as [string, string, string][];
      const toObserver = idCalls.filter((c) => c[0] === observerChat);
      expect(toObserver).toHaveLength(1);
      expect(toObserver[0][1]).toBe(`fid-${sentFilename}`); // file_id — тот же, что вернул mock sendDocumentFile
      expect(toObserver[0][2]).toContain("Копия. Монтажёр: Монтажёр теста");
    });
  });

  it("отказ Telegram у наблюдателя не мешает монтажёру и попадает в журнал", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);
    const property = await seedProperty();
    await addRawVideoFile(property.id, "raw.mp4", 1024);

    await withObserver(async (observerChat) => {
      // Наблюдатель получает копию по file_id (задание C, 24.09.2026) — прямой
      // путь идёт через sendDocument; при его отказе код сам пробует запасной
      // путь полной загрузкой (сгнивший file_id — обычное дело), поэтому для
      // настоящего «отказа у наблюдателя» должны упасть ОБА: fast-path
      // (единственный вызов sendDocument в этом сценарии — файл монтажёра
      // грузится обычным путём первым) и запасная полная загрузка (второй по
      // счёту вызов sendDocumentFile — первый достаётся самому монтажёру).
      sendDocument.mockImplementationOnce(async () => {
        throw new Error("observer chat blocked the bot");
      });
      sendDocumentFile
        .mockImplementationOnce(async (_chatId: string, _file: unknown, filename: string) => ({
          message_id: 1,
          document: { file_id: `fid-${filename}`, file_unique_id: `fuid-${filename}` },
        }))
        .mockImplementationOnce(async () => {
          throw new Error("observer chat blocked the bot");
        });
      await queueVideoHandoff(property.id);

      const fileCalls = sendDocumentFile.mock.calls as unknown as [string][];
      expect(fileCalls.filter((c) => c[0] === `chat-${runId}`)).toHaveLength(1);
      expect(fileCalls.filter((c) => c[0] === observerChat)).toHaveLength(1); // запасная попытка, тоже упала
      const idCalls = sendDocument.mock.calls as unknown as [string][];
      expect(idCalls.filter((c) => c[0] === observerChat)).toHaveLength(1);
      expect((await handoffState(property.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
      const logged = (logSystemError.mock.calls as unknown as [string, string][]).map((c) => c[1]);
      expect(logged.some((m) => m.includes("наблюдателю монтажа"))).toBe(true);
    });
  });
});

describe("HTTP: POST /:id/video-handoff/upload (diskStorage)", () => {
  it("несколько сырых роликов — монтажёру уходят ВСЕ, пронумерованные «N из M»", async () => {
    // До 12.09.2026 уходил только первый (findFirst), остальные монтажёр мог
    // найти лишь сам. Владелец: «иногда снимают несколько специально, чтобы
    // монтажёр собрал из них один или выбрал нормальный».
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    const property = await seedProperty();
    for (let i = 1; i <= 3; i++) await addRawVideoFile(property.id, `raw-${i}.mp4`, 1024);

    await queueVideoHandoff(property.id);

    expect(sendDocumentFile).toHaveBeenCalledTimes(3);
    const captions = sendDocumentFile.mock.calls.map((c) => String(c[3] ?? ""));
    // С 25.09.2026 номер объекта и место файла — ПЕРВОЙ строкой каждой подписи
    // («чтобы вообще никогда ни описания, ни ролики не путались»).
    expect(captions[0].startsWith(`Объект №${property.shortId} · файл 1 из 3`)).toBe(true);
    expect(captions[1].startsWith(`Объект №${property.shortId} · файл 2 из 3`)).toBe(true);
    expect(captions[2].startsWith(`Объект №${property.shortId} · файл 3 из 3`)).toBe(true);
    // Подпись объекта — только у первого: три простыни одинакового текста подряд
    // читать невозможно. Строка правил передачи убрана из карточки целиком
    // (владелец 21.09.2026) — проверяем, что её нет ни в одной подписи.
    for (const caption of captions) expect(caption).not.toContain("файлом в этот чат");
    // Имена файлов не перепутаны местами и несут номер объекта (21.09.2026,
    // уточнено тем же днём — без префикса «ОБ-» и без исходного имени файла):
    // монтажёр скачивает их себе, а на диске подписи из чата уже нет.
    expect(sendDocumentFile.mock.calls.map((c) => String(c[2]))).toEqual([
      `${property.shortId}_1из3.mp4`,
      `${property.shortId}_2из3.mp4`,
      `${property.shortId}_3из3.mp4`,
    ]);
  });

  it("один ролик — подпись всё равно начинается с номера объекта «файл 1 из 1» (25.09.2026)", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    const property = await seedProperty();
    await addRawVideoFile(property.id, "raw.mp4", 1024);

    await queueVideoHandoff(property.id);

    expect(sendDocumentFile).toHaveBeenCalledTimes(1);
    // До 25.09.2026 у одиночного файла номера в подписи не было; теперь номер
    // объекта обязателен в каждой подписи, при любом числе файлов.
    expect(String(sendDocumentFile.mock.calls[0][3] ?? "").startsWith(`Объект №${property.shortId} · файл 1 из 1`)).toBe(true);
    expect(String(sendDocumentFile.mock.calls[0][2])).toBe(`${property.shortId}.mp4`);
  });

  it("ролик тяжелее предела отправки уходит ССЫЛКОЙ, а файл в память не читается", async () => {
    // Файл разрежённый (truncate), диск под него не занимается: проверяем ровно
    // то, что размер берётся из stat, а не из прочитанного буфера.
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    const property = await seedProperty();
    await addRawVideoFile(property.id, "huge.mp4", 60 * 1024 * 1024);

    await queueVideoHandoff(property.id);

    expect(sendDocumentFile).not.toHaveBeenCalled();
    // Ссылка и контрольное «отправлено 1 из 1» (25.09.2026) — два сообщения.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const text = String(sendMessage.mock.calls[0][1] ?? "");
    expect(text).toContain("60 МБ");
    expect(String(sendMessage.mock.calls[1][1] ?? "")).toContain(`Отправлено 1 из 1 файла объекта №${property.shortId}`);
    // Ссылка ведёт на маршрут скачивания (Content-Disposition: attachment), а не
    // на голый /uploads/video/... — иначе Safari на iPhone откроет файл плеером.
    expect(text).toContain("/download-file?token=");
  });

  it("файл принят, обработан, а временный файл в videoTmpDir не остаётся", async () => {
    const property = await seedProperty();
    await setHandoffSettings(true, montajerId);
    await queueVideoHandoff(property.id);

    const login = await request(app).post("/api/v1/auth/login").send({ phone: phone1, password: "testpass123" });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;

    const before = await fs.readdir(videoTmpDir).catch(() => [] as string[]);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/video-handoff/upload`)
      .set("Authorization", `Bearer ${token}`)
      .attach("video", Buffer.from("готовый ролик по HTTP"), "final.mp4");

    expect(res.status).toBe(200);
    expect(res.body.videoHandoffStatus).toBe("RECEIVED");

    const after = await handoffState(property.id);
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffFinalPath).toMatch(/^\/uploads\/handoff\//);

    // Временный файл убран сразу после обработки — не копится с каждой загрузкой.
    // Считать файлы здесь ЗАКОННО и не «плавает»: каталог свой на процесс
    // (tests/setup.ts), а ответ маршрут отдаёт уже ПОСЛЕ уборки
    // (routes/properties/videos.ts). До 20.09.2026 второе было не так — ответ
    // уходил раньше finally, и эта проверка падала случайно, заворачивая чужие
    // правки. Чинить надо было код, а не ослаблять проверку ожиданием.
    const afterTmp = await fs.readdir(videoTmpDir).catch(() => [] as string[]);
    expect(afterTmp.length).toBe(before.length);
  });
});

/**
 * ИМЯ ФАЙЛА С НОМЕРОМ ОБЪЕКТА (владелец 21.09.2026, после разбора перепутанных
 * роликов №108/№109). Монтажёр скачивает файлы себе, и на диске подписи из чата
 * уже нет — номер должен быть в самом имени.
 */
describe("Имя файла для монтажёра", () => {
  it("несёт только номер объекта и порядок — без префикса, ведущих нулей и исходного имени", () => {
    expect(montajerFileName(109, 0, 2, "IMG_0241.mov")).toBe("109_1из2.mov");
    expect(montajerFileName(109, 1, 2, "IMG_0249.mov")).toBe("109_2из2.mov");
  });

  it("один ролик — без нумерации частей", () => {
    expect(montajerFileName(113, 0, 1, "clip.mp4")).toBe("113.mp4");
  });

  it("файл без расширения не ломает имя", () => {
    expect(montajerFileName(42, 0, 1, "video")).toBe("42");
  });

  it("реальная отправка уходит уже с новым именем", async () => {
    const property = await seedProperty();
    await addRawVideoFile(property.id, "IMG_0241.mov", 1024);
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: `chat-${runId}` } });
    await setHandoffSettings(true, montajerId);

    await queueVideoHandoff(property.id);

    const names = sendDocumentFile.mock.calls.map((c) => String(c[2] ?? ""));
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`${property.shortId}.mov`);

    await prisma.propertyVideo.deleteMany({ where: { propertyId: property.id } });
  });
});
