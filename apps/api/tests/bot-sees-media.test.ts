import dns from "node:dns/promises";
import { describe, expect, it, vi, afterEach } from "vitest";
import { assertPublicUrl, UnsafeUrlError } from "../src/lib/safeFetch.js";
import { firstForeignLink, parseHtml } from "../src/lib/linkPreview.js";
import { isSharedPost, sharedMediaHint } from "../src/messengers/sharedMedia.js";

/**
 * «Бот видит присланное» — и не ходит туда, куда не надо.
 *
 * Две половины одной задачи владельца от 16.08.2026: бот должен понимать всё, что
 * ему кидают, и при этом не быть дверью внутрь нашей сети. Обе проверяются здесь,
 * потому что ломаются они одинаково незаметно: в первом случае бот вежливо
 * переспрашивает вместо ответа, во втором — исправно работает и молча ходит по
 * внутренним адресам.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Куда боту ходить нельзя", () => {
  it("петля и частные сети закрыты", async () => {
    // Наш же сервер: по такому адресу лежит API без внешней авторизации.
    await expect(assertPublicUrl("http://127.0.0.1:4000/api/v1/clients")).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl("http://localhost/")).rejects.toThrow(UnsafeUrlError);
    // Соседи по docker-сети: база и АТС.
    await expect(assertPublicUrl("http://10.0.0.5/")).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl("http://192.168.1.1/")).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl("http://172.17.0.2:5432/")).rejects.toThrow(UnsafeUrlError);
  });

  it("метаданные облака закрыты — там ключи доступа без пароля", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(UnsafeUrlError);
  });

  it("петля, записанная как IPv6 или завёрнутая в IPv6, — тоже петля", async () => {
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(UnsafeUrlError);
  });

  it("чужие схемы запрещены — ими читают файлы с сервера", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl("ftp://example.com/x")).rejects.toThrow(UnsafeUrlError);
  });

  it("обычный внешний адрес пропускается", async () => {
    // Без живого DNS (08.10.2026): в облачной сессии выход в сеть закрыт, имя не
    // разрешалось, и тест краснел на окружении, а не на коде. Проверяется наше
    // правило «публичный адрес пропускаем», а не доступность Instagram.
    vi.spyOn(dns, "lookup").mockResolvedValueOnce([{ address: "157.240.1.174", family: 4 }] as never);
    const url = await assertPublicUrl("https://scontent.cdninstagram.com/v/story.jpg");
    expect(url.hostname).toBe("scontent.cdninstagram.com");
  });
});

describe("Пересланная публикация узнаётся по типу вложения", () => {
  it("пост и рилс — публикация, остальное нет", () => {
    expect(isSharedPost("share")).toBe(true);
    expect(isSharedPost("ig_reel")).toBe(true);
    expect(isSharedPost("image")).toBe(false);
    expect(isSharedPost(undefined)).toBe(false);
  });
});

describe("Чужая ссылка в сообщении", () => {
  it("берётся первая внешняя, свои адреса пропускаются", () => {
    // Наши адреса читать незачем: объект по ним находится в базе точнее и без
    // единого внешнего запроса.
    expect(firstForeignLink("смотри https://royalhome.tj/listing/12 и https://somon.tj/x")).toBe(
      "https://somon.tj/x"
    );
    expect(firstForeignLink("https://www.instagram.com/reel/ABC/")).toBeNull();
    expect(firstForeignLink("просто текст без ссылок")).toBeNull();
  });

  it("хвостовая пунктуация в адрес не входит", () => {
    expect(firstForeignLink("вот тут https://somon.tj/kvartira-123.")).toBe("https://somon.tj/kvartira-123");
  });

  it("десять ссылок в сообщении дают ОДИН запрос наружу, а не десять", () => {
    // Иначе одним сообщением наш сервер заставляют работать за себя — это и
    // медленно, и классический способ использовать чужой сервер как таран.
    const many = Array.from({ length: 10 }, (_, i) => `https://site${i}.tj/a`).join(" ");
    expect(firstForeignLink(many)).toBe("https://site0.tj/a");
  });

  it("из страницы достаются заголовок и описание", () => {
    const html = `<html><head><title>Не то</title>
      <meta property="og:title" content="2-комнатная, Сино, 62 м²">
      <meta content="Цена 60 000 $, ремонт" property="og:description">
      <meta property="og:site_name" content="Somon.tj"></head><body>...</body></html>`;
    const preview = parseHtml("https://somon.tj/x", html);
    expect(preview?.title).toBe("2-комнатная, Сино, 62 м²");
    // Порядок атрибутов у сайтов разный — content до property тоже должен читаться.
    expect(preview?.description).toBe("Цена 60 000 $, ремонт");
    expect(preview?.siteName).toBe("Somon.tj");
  });

  it("спам-рассылку не читаем: ни подсказки, ни запроса наружу", async () => {
    // Иначе спамер сотней сообщений заставляет НАШ сервер ходить по своим адресам.
    // Текст подобран под настоящие правила детектора (слово из чужого словаря +
    // ссылка): он нарочно труслив, и «подозрительно» ему мало.
    const fetchSpy = vi.fn(() => {
      throw new Error("наружу ходить было нельзя");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const hint = await sharedMediaHint({
      text: "Накрутка подписчиков недорого, пишите https://promo-smm.example/start",
    });
    expect(hint).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("страница без разметки не даёт пустой карточки", () => {
    // Пустая карточка хуже отсутствия: модель получила бы строку из одного адреса
    // и сделала вид, что посмотрела.
    expect(parseHtml("https://x.tj/", "<html><body>только текст</body></html>")).toBeNull();
  });
});

describe("Бот не переспрашивает то, что видит", () => {
  it("история: увидел — отвечает по ней, а не просит пересказать", async () => {
    const hint = await sharedMediaHint({
      text: "свободна?",
      replyToStoryUrl: "https://scontent.cdninstagram.com/v/story.jpg",
      mediaSeen: true,
    });
    expect(hint).toContain("видишь");
    expect(hint).not.toContain("не видно");
    // Главная претензия владельца: человек ответил на историю именно чтобы не
    // объяснять словами, а бот спрашивал район.
    expect(hint).toContain("НЕ спрашивай район");
  });

  it("история: не увидел — честно переспрашивает одним вопросом", async () => {
    const hint = await sharedMediaHint({
      text: "свободна?",
      replyToStoryUrl: "https://scontent.cdninstagram.com/v/story.jpg",
      mediaSeen: false,
    });
    expect(hint).toContain("не видно");
    expect(hint).toContain("ОДИН вопрос");
  });

  it("публикация без карточки, но видимая: отвечает по подписи", async () => {
    // Тот самый случай 20 карточек с телеграм-ссылкой: объект не привязан, но
    // публикация наша, и подпись мы писали сами — это источник правды.
    const hint = await sharedMediaHint({
      text: "нархаш чанд?",
      attachmentType: "ig_reel",
      attachmentUrl: "https://www.instagram.com/reel/ABC123/",
      mediaSeen: true,
      ownCaption: "2-комнатная, Сино, 62 м², 75 000 $",
    });
    expect(hint).toContain("НАШУ публикацию");
    expect(hint).toContain("75 000 $");
    expect(hint).toContain("не выдумывай");
    // Слова-кальки под запретом и здесь: владелец ловил на них бота дважды.
    expect(hint).toContain("«рилс»");
  });

  it("публикация видна, но подписи нет — цену выдумывать запрещено", async () => {
    const hint = await sharedMediaHint({
      text: "",
      attachmentType: "share",
      attachmentUrl: "https://www.instagram.com/p/XYZ789/",
      mediaSeen: true,
    });
    expect(hint).toContain("Подписи под публикацией нет");
    expect(hint).toContain("цену не выдумывай");
  });
});
