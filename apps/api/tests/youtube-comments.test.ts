import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИИ отвечает на комментарии под YouTube Shorts (17.09.2026) —
 * messengers/youtubeComments.ts, третий канал в общей очереди comments.ts.
 *
 * Мокаем ровно тот набор, что и другие точечные тесты этого файла (см.
 * tests/ari-alarm.test.ts): `vi.mock("../src/db.js", ...)` без `settings.deleteMany`
 * — тогда общий `tests/setup.ts` (beforeAll) видит, что до настоящей базы файл не
 * доходит, и не пытается её сбросить. Без этого приёма файл требовал бы живой
 * Postgres даже там, где ни один prisma-вызов не настоящий (см. отчёт задания —
 * без `.env` в этом дереве не поднимается ни один тест, если явно не подменить
 * db.js).
 *
 * "../src/messengers/comments.js" НЕ импортируется вовсе — youtubeComments.ts
 * специально не зависит от него (см. комментарий в начале самого файла и в
 * commentsQueue.ts, почему: иначе цикл импортов, который ловит `audit:deps`).
 */

const settingsFindUnique = vi.fn();
const instagramCommentFindMany = vi.fn().mockResolvedValue([]);
vi.mock("../src/db.js", () => ({
  prisma: {
    settings: { findUnique: settingsFindUnique },
    instagramComment: { findMany: instagramCommentFindMany },
    // tests/setup.ts::afterAll зовёт $disconnect безусловно, даже когда
    // beforeAll распознал подмену и пропустил сброс настроек (см. ari-alarm.test.ts).
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

const logSystemError = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

vi.mock("../src/crypto.js", () => ({ decryptSecretSafe: (v: string | null) => v }));

const youtubeAccessToken = vi.fn().mockResolvedValue("access-tok");
vi.mock("../src/lib/socialPublish.js", () => ({ youtubeAccessToken }));

// Тонкая обёртка вместо настоящего fetchWithRetry (ретраи/таймаут проверены
// отдельно в meta.ts) — здесь важно только то, что youtubeApiRequest шлёт Bearer
// и разбирает тело, а не устойчивость сети.
vi.mock("../src/messengers/meta.js", () => ({
  fetchWithRetry: (url: string, init?: RequestInit) => fetch(url, init),
}));

const loadBotCapabilities = vi.fn();
vi.mock("../src/messengers/botCapabilities.js", () => ({ loadBotCapabilities }));

const enqueueComments = vi.fn().mockResolvedValue(0);
const noteCommentsOff = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/messengers/commentsQueue.js", () => ({ enqueueComments, noteCommentsOff }));

const { deleteYouTubeComment, parseYouTubeCommentThreads, pollYouTubeComments, postYouTubeCommentReply, setYouTubeCommentHidden } =
  await import("../src/messengers/youtubeComments.js");

const CONFIGURED_SETTINGS = {
  youtubeClientId: "cid",
  youtubeClientSecret: "csecret",
  youtubeRefreshToken: "rtoken",
};

beforeEach(() => {
  settingsFindUnique.mockReset().mockResolvedValue(CONFIGURED_SETTINGS);
  instagramCommentFindMany.mockReset().mockResolvedValue([]);
  loadBotCapabilities.mockReset().mockResolvedValue({ comments: true });
  enqueueComments.mockReset().mockResolvedValue(0);
  noteCommentsOff.mockReset().mockResolvedValue(undefined);
  logSystemError.mockClear();
  youtubeAccessToken.mockClear().mockResolvedValue("access-tok");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

describe("parseYouTubeCommentThreads — разбор ответа commentThreads в строки очереди", () => {
  const OURS = "UC_OURS";
  const NOW = Date.parse("2026-09-17T12:00:00Z");

  it("своя реплика отброшена, ответ в ветке получает parentId (явный и по-умолчанию), старьё старше 3 суток отброшено", () => {
    const fresh = new Date(NOW).toISOString();
    const stale = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 суток назад

    const threads = [
      {
        // Тред A: свежий корневой комментарий + наша же реплика (должна отсеяться).
        snippet: {
          videoId: "vid1",
          topLevelComment: {
            id: "c1",
            snippet: { videoId: "vid1", textOriginal: "Здравствуйте", authorChannelId: { value: "UC_USER1" }, authorDisplayName: "user1", publishedAt: fresh },
          },
        },
        replies: {
          comments: [
            { id: "c1-r1", snippet: { textOriginal: "Спасибо за подписку", authorChannelId: { value: OURS }, publishedAt: fresh, parentId: "c1" } },
          ],
        },
      },
      {
        // Тред B: старый корневой (отсеян по сроку) + свежий ответ без явного
        // parentId в снимке — обязан получить parentId по родителю ветки (top.id).
        snippet: {
          videoId: "vid2",
          topLevelComment: {
            id: "c2",
            snippet: { videoId: "vid2", textOriginal: "Старый вопрос", authorChannelId: { value: "UC_USER2" }, publishedAt: stale },
          },
        },
        replies: {
          comments: [
            { id: "c2-r1", snippet: { textOriginal: "А теперь актуально?", authorChannelId: { value: "UC_USER3" }, publishedAt: fresh } },
          ],
        },
      },
      {
        // Тред C: свежий корневой + свежий ответ С явным parentId в снимке.
        snippet: {
          videoId: "vid3",
          topLevelComment: {
            id: "c3",
            snippet: { videoId: "vid3", textOriginal: "Сколько стоит?", authorChannelId: { value: "UC_USER4" }, publishedAt: fresh },
          },
        },
        replies: {
          comments: [
            { id: "c3-r1", snippet: { textOriginal: "Присоединяюсь к вопросу", authorChannelId: { value: "UC_USER5" }, publishedAt: fresh, parentId: "c3" } },
          ],
        },
      },
    ];

    const rows = parseYouTubeCommentThreads(threads as never, OURS, NOW);

    // Своя реплика c1-r1 не попала в выдачу вовсе.
    expect(rows.find((r) => r.commentId === "c1-r1")).toBeUndefined();
    // Корневой c1 — обычная строка без parentId.
    expect(rows.find((r) => r.commentId === "c1")).toMatchObject({ mediaId: "vid1", authorId: "UC_USER1", parentId: undefined });
    // Старый корневой c2 отброшен по сроку.
    expect(rows.find((r) => r.commentId === "c2")).toBeUndefined();
    // Свежий ответ на старый тред всё равно попадает в очередь, с parentId по
    // родителю ветки (в снимке ответа parentId не было).
    expect(rows.find((r) => r.commentId === "c2-r1")).toMatchObject({ mediaId: "vid2", authorId: "UC_USER3", parentId: "c2" });
    // Явный parentId в снимке ответа используется как есть.
    expect(rows.find((r) => r.commentId === "c3-r1")).toMatchObject({ mediaId: "vid3", authorId: "UC_USER5", parentId: "c3" });
    expect(rows.find((r) => r.commentId === "c3")).toMatchObject({ parentId: undefined });

    expect(rows.every((r) => r.channel === "YOUTUBE")).toBe(true);
  });
});

describe("postYouTubeCommentReply — ответ уходит на верхний комментарий", () => {
  it("тело запроса несёт переданный id как parentId (вызывающий в comments.ts подставляет row.parentId ?? row.commentId)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("https://www.googleapis.com/youtube/v3/comments?part=snippet");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer access-tok" });
      expect(JSON.parse(String(init?.body))).toEqual({ snippet: { parentId: "top-level-id", textOriginal: "Спасибо!" } });
      return jsonResponse(200, { id: "reply-99" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postYouTubeCommentReply("top-level-id", "Спасибо!");

    expect(result).toBe("reply-99");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pollYouTubeComments", () => {
  it("нет ключей — выходит тихо через noteCommentsOff, ни один запрос не уходит", async () => {
    settingsFindUnique.mockResolvedValue({ youtubeClientId: null, youtubeClientSecret: null, youtubeRefreshToken: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await pollYouTubeComments();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(noteCommentsOff).toHaveBeenCalledWith("YOUTUBE", expect.stringContaining("не настроен"));
    expect(enqueueComments).not.toHaveBeenCalled();
  });

  /**
   * ВЫКЛЮЧЕННЫЙ ПОЛЗУНОК БОЛЬШЕ НЕ ОТМЕНЯЕТ ОПРОС (18.09.2026).
   *
   * Раньше здесь проверялось обратное — что запросов не уходит вовсе. Это и была
   * поломка: YouTube отдаёт комментарии только опросом, повторно их никто не
   * пришлёт, а отсечка в 3 суток закрывает дорогу назад — то есть комментарии за
   * время выключенного бота исчезали навсегда, даже из ленты CRM. Теперь опрос
   * идёт, строки складываются с enabled=false (SKIPPED/"bot_off"), как это делают
   * Instagram и Facebook.
   */
  it("общий ползунок выключен — комментарии всё равно сохраняются, но с enabled=false", async () => {
    loadBotCapabilities.mockResolvedValue({ comments: false });
    const fresh = new Date().toISOString();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/channels?")) return jsonResponse(200, { items: [{ id: "UC_OURS" }] });
      if (url.includes("/commentThreads?")) {
        return jsonResponse(200, {
          items: [
            {
              snippet: {
                videoId: "vidOff",
                topLevelComment: {
                  id: "cOff",
                  snippet: { videoId: "vidOff", textOriginal: "Нарх чанд?", authorChannelId: { value: "UC_USER_OFF" }, authorDisplayName: "useroff", publishedAt: fresh },
                },
              },
            },
          ],
        });
      }
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollYouTubeComments();

    expect(noteCommentsOff).toHaveBeenCalledWith("YOUTUBE", expect.stringContaining("ползунок"));
    expect(enqueueComments).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ channel: "YOUTUBE" })]), false);
  });

  it("свежие комментарии уходят в enqueueComments с enabled=true (та же функция, что у Instagram/Facebook)", async () => {
    const fresh = new Date().toISOString();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/channels?")) return jsonResponse(200, { items: [{ id: "UC_OURS" }] });
      if (url.includes("/commentThreads?")) {
        return jsonResponse(200, {
          items: [
            {
              snippet: {
                videoId: "vidX",
                topLevelComment: {
                  id: "cX",
                  snippet: { videoId: "vidX", textOriginal: "Где находится?", authorChannelId: { value: "UC_USERX" }, authorDisplayName: "userx", publishedAt: fresh },
                },
              },
            },
          ],
        });
      }
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollYouTubeComments();

    expect(enqueueComments).toHaveBeenCalledTimes(1);
    const [rows, enabled] = enqueueComments.mock.calls[0];
    expect(enabled).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({ channel: "YOUTUBE", commentId: "cX", mediaId: "vidX", authorId: "UC_USERX" }),
    ]);
  });

  /**
   * СТРАНИЦЫ (18.09.2026). Запрос уходил без pageToken — то есть брал первые 50
   * веток и на этом заканчивался. Всё, что не поместилось между двумя тиками,
   * в очередь не попадало НИКОГДА: следующий опрос видел ту же первую страницу,
   * а через трое суток отсечка по возрасту закрывала дорогу насовсем.
   */
  it("перебирает страницы по nextPageToken, пока ветки не стали старше отсечки", async () => {
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const thread = (id: string, publishedAt: string) => ({
      snippet: {
        videoId: "vidP",
        topLevelComment: {
          id,
          snippet: { videoId: "vidP", textOriginal: `вопрос ${id}`, authorChannelId: { value: `UC_${id}` }, authorDisplayName: id, publishedAt },
        },
      },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/channels?")) return jsonResponse(200, { items: [{ id: "UC_OURS" }] });
      if (url.includes("/commentThreads?")) {
        if (!url.includes("pageToken=")) return jsonResponse(200, { items: [thread("c1", fresh)], nextPageToken: "p2" });
        if (url.includes("pageToken=p2")) return jsonResponse(200, { items: [thread("c2", fresh)], nextPageToken: "p3" });
        // Третья страница целиком старше отсечки — дальше идти незачем.
        if (url.includes("pageToken=p3")) return jsonResponse(200, { items: [thread("c3", old)], nextPageToken: "p4" });
        throw new Error(`лишняя страница: ${url}`);
      }
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollYouTubeComments();

    const pages = fetchMock.mock.calls.filter(([u]) => String(u).includes("/commentThreads?"));
    expect(pages).toHaveLength(3);
    const [rows] = enqueueComments.mock.calls[0];
    // c3 отброшен отсечкой по возрасту, c1 и c2 со второй и первой страниц — в очереди.
    expect(rows.map((r: { commentId: string }) => r.commentId)).toEqual(["c1", "c2"]);
  });

  it("403 insufficientPermissions (refresh token только со scope youtube.upload) — сообщение о scope уходит РОВНО ОДИН РАЗ за два опроса подряд", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/channels?")) return jsonResponse(200, { items: [{ id: "UC_OURS" }] });
      if (url.includes("/commentThreads?")) {
        return jsonResponse(403, { error: { message: "The permissions associated with the request are not sufficient", errors: [{ reason: "insufficientPermissions" }] } });
      }
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollYouTubeComments();
    await pollYouTubeComments();

    const scopeCalls = logSystemError.mock.calls.filter(([, message]) => String(message).includes("youtube.force-ssl"));
    expect(scopeCalls).toHaveLength(1);
    expect(scopeCalls[0][0]).toBe("youtube");
    expect(enqueueComments).not.toHaveBeenCalled();
  });
});

/**
 * Скрыть и ВЕРНУТЬ комментарий. Возврат появился 23.09.2026: до него кнопка
 * «Вернуть подписчикам» в CRM ходила в Instagram при любом канале, и под роликом
 * YouTube не работала вовсе (routes/instagramComments.ts::setHiddenInInstagram).
 * У YouTube это не флажок `hide`, как у Meta, а состояние модерации — перепутать
 * значения местами значит опубликовать то, что прятали.
 */
describe("setYouTubeCommentHidden — отклонение без ложного обещания возврата", () => {
  it("отклонение подтверждено 204, возврат запрещён без второго provider call", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await setYouTubeCommentHidden("yt-comment-1", true);
    await expect(setYouTubeCommentHidden("yt-comment-1", false)).rejects.toThrow("не поддерживается");

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toContain("setModerationStatus");
    expect(urls[0]).toContain("moderationStatus=rejected");
    expect(urls).toHaveLength(1);
    // Идентификатор в адресе — иначе модерация уехала бы на чужой комментарий.
    for (const url of urls) expect(url).toContain("id=yt-comment-1");
  });
});

/**
 * «УДАЛИТЬ» ЧУЖОЙ КОММЕНТАРИЙ НА YOUTUBE = ОТКЛОНИТЬ ЕГО (24.09.2026).
 *
 * `DELETE /comments` YouTube выполняет только для комментариев самого владельца
 * маркера и на чужой отвечает 403. Бот звал его для рекламы чужой квартиры — и
 * реклама оставалась висеть. Владелец канала убирает чужое модерацией `rejected`.
 */
describe("deleteYouTubeComment — чужой комментарий убирается модерацией", () => {
  it("шлёт setModerationStatus=rejected, а не DELETE", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: { method?: string }) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteYouTubeComment("yt-ad-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("setModerationStatus");
    expect(String(url)).toContain("moderationStatus=rejected");
    expect(String(url)).toContain("id=yt-ad-1");
    expect(init?.method).not.toBe("DELETE");
  });
  it("неполный 200 не становится подтверждением отклонения", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {})));
    await expect(deleteYouTubeComment("yt-unknown-outcome")).rejects.toThrow("unconfirmed_response");
  });
});
