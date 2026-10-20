import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fetchAttachments } from "../src/messengers/attachments.js";

/**
 * Видео и документы: вход в конвейер разбора.
 *
 * До 02.08.2026 всё это падало в «unsupported» ещё на классификации, и бот отвечал
 * продавцу с рум-туром «опишите словами». Тесты стерегут два места, где это ломается
 * молча: распознавание типа (CDN мессенджеров любит отдавать octet-stream) и
 * потолок размера — с общим потолком в 5 МБ разбор видео не дал бы ничего вовсе.
 */

/**
 * Ответ CDN мессенджера: тип, размер и тело.
 *
 * Тело — настоящий поток, а не заглушка: загрузчик читает вложение кусками и
 * обрывает его на потолке (readCapped), и с `body: null` проверка размера
 * молча измеряла бы пустоту.
 *
 * `declaredBytes` — что CDN написал в Content-Length. По умолчанию правду;
 * отдельный аргумент нужен ровно для того случая, ради которого всё и затевалось:
 * заголовка нет или он врёт.
 */
function respond(contentType: string, bytes: number, declaredBytes: number | null = bytes) {
  const headers = new Headers({ "content-type": contentType });
  if (declaredBytes !== null) headers.set("content-length", String(declaredBytes));
  return {
    ok: true,
    headers,
    // Кусками по 64 кБ — так же, как отдаёт настоящий CDN: цельный буфер на
    // мегабайты в тесте ничем не отличался бы от arrayBuffer().
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = 64 * 1024;
        for (let sent = 0; sent < bytes; sent += chunk) {
          controller.enqueue(new Uint8Array(Math.min(chunk, bytes - sent)));
        }
        controller.close();
      },
    }),
  } as unknown as Response;
}

/**
 * Защита от SSRF (lib/safeFetch.ts) резолвит имя в настоящий IP — иначе её нельзя
 * обойти подставным DNS. Хосты в этих тестах выдуманные («cdn.example»), поэтому
 * без подмены вложение отбрасывалось бы ещё до проверки типа и размера.
 *
 * ПОДМЕНЯЕТСЯ ИМЕННО РЕЗОЛВЕР, А НЕ САМА ЗАЩИТА (21.08.2026). Раньше здесь
 * заглушался `assertPublicUrl`, и это работало ровно до тех пор, пока загрузчик
 * звал его сам. Теперь переходы разбирает `safeOpen` внутри того же модуля, а
 * внутренний вызов никакой подменой экспорта не перехватывается: заглушка молча
 * перестала бы что-либо значить. Подмена DNS оставляет НАСТОЯЩУЮ проверку адресов
 * на месте — и тесты про перенаправление внутрь сети ниже проверяют боевой код.
 */
vi.mock("node:dns/promises", () => ({
  default: { lookup: async () => [{ address: "93.184.216.34" }] },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => fetchMock.mockReset());
// Процесс общий на весь прогон (singleFork, см. vitest.config.ts) — не снятый
// стаб глобального fetch доживал до следующих файлов и подменял им настоящую
// сеть (напр. вызов Gemini в property-active-limit.test.ts), ловившую вместо
// ответа `undefined` и падавшую на `res.ok` после серии ретраев по таймауту.
afterAll(() => vi.unstubAllGlobals());

describe("Видео и документы доходят до разбора", () => {
  it("видео по Content-Type попадает в medias, а не в «не открылось»", async () => {
    fetchMock.mockResolvedValue(respond("video/mp4", 8 * 1024 * 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/roomtour" }]);

    expect(fetched.medias).toHaveLength(1);
    expect(fetched.medias[0].media).toBe("video");
    expect(fetched.medias[0].mediaType).toBe("video/mp4");
    expect(fetched.hadUnsupported).toBe(false);
  });

  /** CDN мессенджеров сплошь и рядом отдаёт application/octet-stream — по одному
   *  Content-Type половина видео осталась бы неопознанной. */
  it("видео опознаётся по расширению, когда тип не сказали", async () => {
    fetchMock.mockResolvedValue(respond("application/octet-stream", 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/tour.mov?token=abc" }]);

    expect(fetched.medias[0].mediaType).toBe("video/quicktime");
  });

  it("pdf разбирается как документ", async () => {
    fetchMock.mockResolvedValue(respond("application/pdf", 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/dogovor" }]);

    expect(fetched.medias[0].media).toBe("document");
  });

  /** .docx и .xlsx — zip-архивы: модель увидела бы в них двоичный мусор и охотно
   *  пересказала бы его клиенту как содержание его же документа. */
  it("docx честно остаётся неоткрытым, а не притворяется разобранным", async () => {
    fetchMock.mockResolvedValue(
      respond("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1024)
    );
    const fetched = await fetchAttachments([{ url: "https://cdn.example/akt.docx" }]);

    expect(fetched.medias).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });
});

describe("Потолок размера свой у каждого вида", () => {
  it("видео ровно на 16 МБ берём — это и есть потолок самого WhatsApp", async () => {
    fetchMock.mockResolvedValue(respond("video/mp4", 16 * 1024 * 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/big" }]);

    expect(fetched.medias).toHaveLength(1);
  });

  it("видео тяжелее 16 МБ не качаем вовсе", async () => {
    fetchMock.mockResolvedValue(respond("video/mp4", 40 * 1024 * 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/huge" }]);

    expect(fetched.medias).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });

  it("фотографии остались на прежних пяти мегабайтах", async () => {
    fetchMock.mockResolvedValue(respond("image/jpeg", 6 * 1024 * 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/photo" }]);

    expect(fetched.images).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });

  /** Голосовое отдельно от фото (21.08.2026): 5 МБ opus — это до сорока минут
   *  речи, и они целиком уходили в самую дорогую расшифровку. */
  it("голосовое тяжелее трёх мегабайт не разбираем", async () => {
    fetchMock.mockResolvedValue(respond("audio/ogg", 4 * 1024 * 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/voice" }]);

    expect(fetched.audios).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });
});

/**
 * ПОТОЛОК ПРОВЕРЯЕТСЯ ПО ФАКТИЧЕСКИ СКАЧАННОМУ, А НЕ ПО СЛОВУ CDN (21.08.2026).
 *
 * Content-Length ничем не подтверждён, а у chunked-ответа его нет вовсе. Пока тело
 * читалось через arrayBuffer(), любой такой ответ втягивался в память целиком —
 * часовое видео от клиента укладывало бы весь API, который делит хост с базой.
 */
describe("Соврамший Content-Length не пускает файл в память", () => {
  it("заголовок занижен — чтение обрывается на потолке, файл не открылся", async () => {
    fetchMock.mockResolvedValue(respond("video/mp4", 40 * 1024 * 1024, 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/liar.mp4" }]);

    expect(fetched.medias).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });

  it("заголовка нет вовсе — тот же обрыв, а не бесконечная загрузка", async () => {
    fetchMock.mockResolvedValue(respond("video/mp4", 40 * 1024 * 1024, null));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/chunked.mp4" }]);

    expect(fetched.medias).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });
});

/** Ответ CDN не-2xx: подписанная ссылка истекла/недоступна. */
function notOk(status: number) {
  return { ok: false, status, body: { cancel: async () => {} } } as unknown as Response;
}

/**
 * ГОЛОСОВОЕ В КОНТЕЙНЕРЕ .mp4 (17.08.2026, живой случай — самый дорогой из трёх).
 *
 * Голосовое из Messenger приходит файлом `.mp4` с видео-Content-Type: по
 * расширению и типу оно неотличимо от настоящего видео и уходило в ОПИСАНИЕ
 * ВИДЕО вместо расшифровки речи. То есть речь клиента не читалась вообще
 * никогда, а бот отвечал «файл не открылся». Платформа при этом честно писала
 * type="audio" — этот ответ и надо слушать.
 */
describe("Тип от платформы разрешает двусмысленность .mp4", () => {
  it("голосовое .mp4 идёт в расшифровку речи, а не в описание видео", async () => {
    fetchMock.mockResolvedValue(respond("video/mp4", 1024));
    const fetched = await fetchAttachments([
      { url: "https://cdn.example/voice_clip.mp4", declaredKind: "audio" },
    ]);

    expect(fetched.audios).toHaveLength(1);
    expect(fetched.audios[0].mediaType).toBe("audio/mp4");
    expect(fetched.medias).toHaveLength(0);
  });

  it("настоящее видео .mp4 по-прежнему видео — подсказки нет, ничего не сломалось", async () => {
    fetchMock.mockResolvedValue(respond("video/mp4", 1024));
    const fetched = await fetchAttachments([
      { url: "https://cdn.example/roomtour.mp4", declaredKind: "video" },
    ]);

    expect(fetched.medias).toHaveLength(1);
    expect(fetched.medias[0].media).toBe("video");
    expect(fetched.audios).toHaveLength(0);
  });

  it("голосовое .ogg остаётся ogg, а не подменяется контейнером mp4", async () => {
    fetchMock.mockResolvedValue(respond("application/octet-stream", 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/v.ogg", declaredKind: "audio" }]);

    expect(fetched.audios[0].mediaType).toBe("audio/ogg");
  });
});

describe("Скачивание повторяет попытку (17.08.2026, живой случай)", () => {
  it("первая попытка не-2xx, вторая успешна — вложение всё равно доходит", async () => {
    fetchMock.mockResolvedValueOnce(notOk(503)).mockResolvedValueOnce(respond("image/jpeg", 1024));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/photo" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetched.images).toHaveLength(1);
    expect(fetched.hadUnsupported).toBe(false);
  });

  it("обе попытки не-2xx — честно hadUnsupported, а не тихая пропажа", async () => {
    fetchMock.mockResolvedValueOnce(notOk(502)).mockResolvedValueOnce(notOk(502));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/photo" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetched.images).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });
});

/**
 * ПЕРЕНАПРАВЛЕНИЕ — ЭТО ВТОРОЙ АДРЕС, И ЕГО ТОЖЕ НАЗЫВАЕТ ЧУЖОЙ (дыра, закрытая
 * 21.08.2026).
 *
 * Проверялся только исходный адрес, а качал файл обычный fetch — который идёт по
 * редиректам сам и молча. Значит, вся защита снималась одним заголовком Location:
 * публичная ссылка отвечает «302 → http://169.254.169.254/latest/meta-data/», и CRM
 * своими руками приносит ключи облака тому, кто эту ссылку прислал. Тем же приёмом
 * достаются база и АТС по адресам docker-сети.
 */
function redirect(location: string, status = 302) {
  return {
    ok: false,
    status,
    headers: new Headers({ location }),
    body: null,
  } as unknown as Response;
}

describe("Каждый переход проверяется заново", () => {
  it("«302 → метаданные облака» отвергается, и второго запроса не происходит", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/photo.jpg" }]);

    // Ровно один вызов — на исходный адрес. Внутрь сети мы не пошли, и повторять
    // запрещённый адрес не стали: это постоянный отказ, а не моргнувшая сеть.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetched.images).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });

  it("«302 → сосед по docker-сети» отвергается так же", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://172.17.0.2:5432/"));
    const fetched = await fetchAttachments([{ url: "https://cdn.example/voice.ogg" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetched.audios).toHaveLength(0);
    expect(fetched.hadUnsupported).toBe(true);
  });

  /**
   * Обратная сторона: запретить переходы совсем нельзя. CDN Meta выдаёт ссылку на
   * одном хосте, а файл отдаёт с другого — без перехода мы остались бы вообще без
   * вложений WhatsApp.
   */
  it("переход на обычный внешний адрес работает — вложение доходит", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("https://scontent.example/real.jpg"))
      .mockResolvedValueOnce(respond("image/jpeg", 1024));
    const fetched = await fetchAttachments([{ url: "https://lookaside.example/photo" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetched.images).toHaveLength(1);
    expect(fetched.hadUnsupported).toBe(false);
  });

  /**
   * Маркер Meta на чужой хост не едет. Пока переходами занимался сам fetch, это
   * делал он (так велит спецификация); переложив переходы на себя, мы забрали и
   * ответственность — иначе «302 → чужой сайт» уносил бы наш рабочий маркер тому,
   * кто прислал ссылку.
   */
  it("маркер доступа не уходит на другой хост вместе с переходом", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("https://scontent.example/real.jpg"))
      .mockResolvedValueOnce(respond("image/jpeg", 1024));
    await fetchAttachments([
      { url: "https://lookaside.example/photo", headers: { Authorization: "Bearer secret-meta-token" } },
    ]);

    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer secret-meta-token" });
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
  });
});
