import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA-ПРОХОД ПО ПЕРЕПИСКАМ С РЕКЛАМЫ (Dan, 02.10.2026, вечер: «бот узнал что за
 * реклама, но всё равно ответил на спам… проведи разные тесты, что делают обычные
 * люди и тестировщики»). Каждая строка ниже — сценарий: что прислал человек и
 * что должен сделать бот. Решения взяты из тех же функций, что зовёт вебхук.
 */

const { fetchAttachments, describeMedia } = vi.hoisted(() => ({
  fetchAttachments: vi.fn(),
  describeMedia: vi.fn(),
}));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/attachments.js")>()),
  fetchAttachments,
}));
vi.mock("../src/ai/geminiMedia.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiMedia.js")>()),
  describeMedia,
}));

const { parseIncoming } = await import("../src/messengers/meta.js");
const { captionSaysForeign, isOurBrandCaption, looksLikeHousing, silentOnForeignShare } = await import(
  "../src/messengers/sharedMedia.js"
);
const { readCardSource } = await import("../src/messengers/sharedPostCard.js");
const { detectSpam, sharedPostSpamContext } = await import("../src/lib/incomingSpam.js");

const foreignCtx = sharedPostSpamContext({ sharedPost: true, ownMedia: false, adProperty: false, vacancyPost: false });

describe("чужой рилс: молчать или отвечать", () => {
  const card = (listingSeen: boolean) => ({ listingSeen });
  const cases: [string, Parameters<typeof silentOnForeignShare>[0], boolean][] = [
    ["с рекламы, мем с подписью «😂 #fyp», без слов", { foreignShare: true, fromAd: true, text: "", caption: "😂😂 #fyp", card: null }, true],
    ["с рекламы, без подписи, на видео объявления нет", { foreignShare: true, fromAd: true, text: "", caption: undefined, card: card(false) }, true],
    // 03.10.2026: живой случай «ALI» — чужой ролик с рекламы без слов, бот ответил «Чӣ хизмат…».
    // Наш ролик узнаётся раньше (ownMedia, номер публикации, бренд в подписи) и сюда не доходит.
    ["с рекламы, без подписи, прочитать не вышло, без слов — молчим", { foreignShare: true, fromAd: true, text: "", caption: undefined, card: null }, true],
    ["с рекламы, рилс + «🔥» — смайл не слова", { foreignShare: true, fromAd: true, text: "🔥", caption: "dance", card: null }, true],
    // 03.10.2026: одно приветствие к чужому ролику — не дело; напишет вопрос — ответим.
    ["с рекламы, рилс + «Ассалом» — приветствие ещё не дело", { foreignShare: true, fromAd: true, text: "Ассалом", caption: "dance", card: null }, true],
    ["с рекламы, рилс + «Ассалом, сколько стоит?» — дело", { foreignShare: true, fromAd: true, text: "Ассалом, сколько стоит?", caption: "dance", card: null }, false],
    ["продавец игровых аккаунтов: «Ишам капен ку 🔥»", { foreignShare: true, fromAd: false, text: "Ишам капен ку ❤️‍🔥👌", caption: "ff.navaskar ОПИСАНИЕ АККАУНТА", card: null }, true],
    ["продавец игровых аккаунтов: «Успеть к ‼️»", { foreignShare: true, fromAd: true, text: "Успеть к ‼️", caption: undefined, card: null }, true],
    ["чужой ролик + номер телефона — дело", { foreignShare: true, fromAd: true, text: "910001021", caption: undefined, card: null }, false],
    ["чужой ролик + «эта квартира свободна?» — дело", { foreignShare: true, fromAd: false, text: "эта квартира свободна?", caption: undefined, card: null }, false],
    ["не с рекламы, игра без подписи", { foreignShare: true, fromAd: false, text: "", caption: undefined, card: null }, true],
    ["чужое объявление «Продаётся 3х комнатная»", { foreignShare: true, fromAd: false, text: "", caption: "Продаётся 3-комн квартира", card: null }, false],
    ["чужое объявление без подписи, на видео метраж", { foreignShare: true, fromAd: true, text: "", caption: undefined, card: card(true) }, false],
    ["наш пост (не чужой) — решение не про него", { foreignShare: false, fromAd: true, text: "", caption: "", card: null }, false],
  ];
  for (const [name, input, silent] of cases) {
    it(name, () => expect(silentOnForeignShare(input)).toBe(silent));
  }
});

describe("подпись похожа на объявление о жилье", () => {
  const yes = [
    "Фурӯхта мешавад хонаи 3 ҳуҷрагӣ, 85 м²",
    "Продаётся квартира в Сино",
    "3-комн, 65м2",
    "Ҳавлӣ дар Ваҳдат",
    "2 хонагӣ, нархаш 450 000",
    "Сдаётся дом посуточно",
    "участок 6 соток",
  ];
  const no = [
    "Заработок 500$ в день, пиши +",
    "iPhone 15 1200$",
    "бинед лутфан",
    "хонед то охир",
    "сидим дома 😂",
    "когда мама зашла в комнату",
    "Free Fire",
    "ремонт телефонов",
    "Продам машину Opel",
  ];
  for (const t of yes) it(`жильё: ${t}`, () => expect(looksLikeHousing(t)).toBe(true));
  for (const t of no) it(`не жильё: ${t}`, () => expect(looksLikeHousing(t)).toBe(false));
});

describe("наш ролик по подписи", () => {
  it("имя агентства в подписи — наш", () => {
    expect(isOurBrandCaption("Royal Home 🏡 #dushanbe")).toBe(true);
    expect(isOurBrandCaption("royalhome.tj")).toBe(true);
    expect(captionSaysForeign("Royal Home 🏡 #dushanbe")).toBe(false);
  });
  it("подвал «Объект №N» — не чужой, даже без слов про жильё", () => {
    expect(captionSaysForeign("Красивый вид\n\nОбъект №112")).toBe(false);
  });
  it("мем — чужой, ролик Gemini не читаем", () => {
    expect(captionSaysForeign("😂 #fyp #tiktok")).toBe(true);
    expect(captionSaysForeign("")).toBe(false);
  });
});

describe("накрутка: что глушить, а что нет", () => {
  it("«Лайк» / «лайк кунед» после чужого рилса — накрутка", () => {
    expect(detectSpam("Лайк", foreignCtx)).not.toBeNull();
    expect(detectSpam("лайк кунед", foreignCtx)).not.toBeNull();
    expect(detectSpam("подпишись", foreignCtx)).not.toBeNull();
  });
  it("«Можно на просмотр завтра?» после чужого объявления — клиент, не спам", () => {
    expect(detectSpam("Можно на просмотр завтра?", foreignCtx)).toBeNull();
    expect(detectSpam("хочу на просмотр", foreignCtx)).toBeNull();
  });
  it("«Лайкнул ваш пост, сколько стоит?» — клиент", () => {
    expect(detectSpam("Лайкнул ваш пост, сколько стоит?", foreignCtx)).toBeNull();
    expect(detectSpam("лайк, нархаш чанд?", foreignCtx)).toBeNull();
  });
  it("«поставь просмотры и лайк» без вложения — всё равно накрутка", () => {
    expect(detectSpam("поставь просмотры и лайк")).not.toBeNull();
  });
});

describe("«Сообщение недоступно» не теряется вместе с меткой рекламы", () => {
  it("is_unsupported с рекламой — событие с типом unsupported и меткой", () => {
    const [msg] = parseIncoming({
      object: "instagram",
      entry: [
        {
          id: "page-1",
          messaging: [
            {
              sender: { id: "u-unsup" },
              recipient: { id: "ig-1" },
              message: { mid: "m-unsup", is_unsupported: true, referral: { source: "ADS", ad_id: "123456789" } },
            },
          ],
        },
      ],
    });
    expect(msg.attachmentType).toBe("unsupported");
    expect(msg.fromAd).toBe(true);
    expect(msg.adId).toBe("123456789");
  });
});

describe("чтение карточки: цена — ещё не объявление о жилье", () => {
  beforeEach(() => {
    fetchAttachments.mockReset();
    describeMedia.mockReset();
    fetchAttachments.mockResolvedValue({
      images: [{ kind: "image", mediaType: "image/jpeg", data: "eA==" }],
      audios: [],
      medias: [],
      hadUnsupported: false,
    });
  });
  it("«iPhone 15 — 1200$» — объявления о жилье нет", async () => {
    describeMedia.mockResolvedValue("цена: 1200 $\nплощадь: нет\nкомнат: нет");
    expect((await readCardSource({ url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?a=1" }))?.listingSeen).toBe(false);
  });
  it("«Доход 3000$ в месяц» — нет", async () => {
    describeMedia.mockResolvedValue("цена: 3000 $");
    expect((await readCardSource({ url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?a=2" }))?.listingSeen).toBe(false);
  });
  it("цена и метраж — объявление", async () => {
    describeMedia.mockResolvedValue("цена: 450 000 сомони\nплощадь: 65 м²\nкомнат: 2");
    expect((await readCardSource({ url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?a=3" }))?.listingSeen).toBe(true);
  });
  it("Gemini молчит — null (не знаем)", async () => {
    describeMedia.mockResolvedValue(null);
    expect(await readCardSource({ url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?a=4" })).toBeNull();
  });
});
