import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  instagramShortcode,
  crmPropertyIdFromUrl,
  siteListingIdFromUrl,
  sharedMediaHint,
  captionShortId,
  isUnresolvedSharedPost,
} from "../src/messengers/sharedMedia.js";
import { parseIncoming } from "../src/messengers/meta.js";
import { isInstagramLink } from "../src/lib/instagramLink.js";

/**
 * Клиент присылает наш рилс или отвечает на историю.
 *
 * Главное правило, ради которого всё написано: человек, показавший пальцем на
 * конкретную квартиру, — самый горячий из всех, и он НИКОГДА не должен остаться
 * без ответа. Поэтому проверяем не только удачное опознание объекта, но и все
 * случаи, когда опознать не вышло: подсказка обязана появиться всё равно.
 */

const runId = Date.now().toString(36);
const SHORTCODE = `RH${runId}xy`;

let districtId = "";
let propertyId = "";
let propertyShortId = 0;
let siteBornPropertyId = "";
const siteListingId = Number(String(Date.now()).slice(-8));

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-медиа-${runId}` } })).id;

  const property = await prisma.property.create({
    data: {
      title: `Тест-объект-медиа-${runId}`,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 78,
      price: 62000,
      currency: "USD",
      districtId,
      address: "Тестовая, 7",
      condition: "GOOD",
      instagramUrl: `https://www.instagram.com/reel/${SHORTCODE}/`,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;

  const siteBorn = await prisma.property.create({
    data: {
      title: `Тест-объект-с-сайта-${runId}`,
      type: "HOUSE",
      areaSqm: 120,
      price: 900000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 8",
      condition: "GOOD",
      publishedOnSite: true,
      siteListingId,
    },
  });
  siteBornPropertyId = siteBorn.id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, siteBornPropertyId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("разбор ссылок", () => {
  it("короткий код берётся из всех форм адреса публикации", () => {
    expect(instagramShortcode("https://www.instagram.com/reel/ABC123_x/")).toBe("ABC123_x");
    expect(instagramShortcode("https://instagram.com/p/ABC123_x?igsh=long-tail")).toBe("ABC123_x");
    expect(instagramShortcode("https://instagram.com/tv/ABC123_x")).toBe("ABC123_x");
  });

  /**
   * Отдельная от кода поста проверка: она решает, отправлять ли ссылку КЛИЕНТУ
   * в директ Instagram (messengers/propertyShowcase.ts). Поле «Ссылка на публикацию
   * Instagram» схема проверяет только как URL, и телеграм-ссылка в нём законна —
   * видео-обзор часто живёт именно там. Клиенту она бесполезна.
   */
  it("телеграм-ссылка публикацией Instagram не считается", () => {
    expect(isInstagramLink("https://www.instagram.com/p/ABC123/")).toBe(true);
    expect(isInstagramLink("http://instagram.com/reel/ABC123")).toBe(true);
    expect(isInstagramLink("https://t.me/royalhome_tj/1234")).toBe(false);
    expect(isInstagramLink("https://royalhome.tj/listing/by-crm/x")).toBe(false);
    expect(isInstagramLink(null)).toBe(false);
    expect(isInstagramLink("   ")).toBe(false);
  });

  it("похожий домен за Instagram не выдаёт себя", () => {
    // Начинается с тех же букв, но это чужой сайт.
    expect(isInstagramLink("https://instagram.com.example.ru/p/ABC123/")).toBe(false);
  });

  it("не путает чужой сайт с публикацией", () => {
    expect(instagramShortcode("https://somer.tj/reel/ABC123")).toBeNull();
    expect(instagramShortcode(undefined)).toBeNull();
  });

  it("вытаскивает id объекта из ссылки by-crm", () => {
    expect(crmPropertyIdFromUrl("вот эта https://royalhome.tj/listing/by-crm/abc-123 свободна?")).toBe("abc-123");
    expect(crmPropertyIdFromUrl("просто текст")).toBeNull();
  });

  it("вытаскивает номер объявления у объекта, рождённого на сайте", () => {
    expect(siteListingIdFromUrl("https://royalhome.tj/listing/456")).toBe(456);
    // by-crm не должен читаться как числовое объявление
    expect(siteListingIdFromUrl("https://royalhome.tj/listing/by-crm/abc")).toBeNull();
  });
});

describe("parseIncoming — рилс и ответ на историю доходят до бота", () => {
  const event = (message: unknown) => ({
    object: "instagram",
    entry: [{ messaging: [{ sender: { id: "user-1" }, message }] }],
  });

  it("у пересланного рилса сохраняется ссылка, а не только тип", () => {
    const [msg] = parseIncoming(
      event({
        mid: "m1",
        attachments: [{ type: "ig_reel", payload: { url: "https://instagram.com/reel/XYZ/" } }],
      })
    );
    expect(msg.attachmentType).toBe("ig_reel");
    expect(msg.attachmentUrl).toBe("https://instagram.com/reel/XYZ/");
  });

  it("ответ на историю без текста и без вложения больше не отбрасывается", () => {
    // Ровно этот случай раньше терялся: клиент отвечает на историю смайликом,
    // Meta не кладёт ни вложения, ни текста — сообщение молча исчезало.
    const parsed = parseIncoming(
      event({ mid: "m2", reply_to: { story: { url: "https://instagram.com/stories/royal.home.tj/1" } } })
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].replyToStoryUrl).toContain("stories");
  });

  it("пустое сообщение без единого признака по-прежнему отбрасывается", () => {
    expect(parseIncoming(event({ mid: "m3" }))).toHaveLength(0);
  });
});

describe("sharedMediaHint — бот понимает, о какой квартире речь", () => {
  it("узнаёт объект по пересланной публикации", async () => {
    const out = await sharedMediaHint({
      text: "свободна?",
      attachmentType: "ig_reel",
      attachmentUrl: `https://www.instagram.com/reel/${SHORTCODE}/?igsh=hvost`,
    });
    // Текста клиента в подсказке нет и быть не должно: она отдаётся модели отдельным
    // полем, а в историю диалога уходит ровно то, что человек написал сам.
    expect(out).not.toContain("свободна?");
    expect(out).toContain(`объект №${propertyShortId}`);
    expect(out).toContain("3-комн");
  });

  it("узнаёт объект по ссылке на публикацию, вставленной ТЕКСТОМ", async () => {
    // Бот отдаёт объекты приоритетно ссылкой на пост, и человек чаще копирует её
    // текстом, чем пересылает саму публикацию. Раньше это считалось чужой ссылкой.
    const out = await sharedMediaHint({
      text: `а вот эта https://www.instagram.com/reel/${SHORTCODE}/ ещё есть?`,
    });
    expect(out).toContain(`объект №${propertyShortId}`);
    expect(out).not.toContain("не на наш сайт");
  });

  it("узнаёт объект по ссылке by-crm", async () => {
    const out = await sharedMediaHint({ text: `https://royalhome.tj/listing/by-crm/${propertyId}` });
    expect(out).toContain(`объект №${propertyShortId}`);
  });

  it("узнаёт объект, рождённый на сайте, по номеру объявления", async () => {
    const out = await sharedMediaHint({ text: `https://royalhome.tj/listing/${siteListingId}` });
    expect(out).toContain("Отвечай про ЭТОТ объект");
  });

  it("«объект №N» + /listing/N, которой нет в CRM: N — id сайта, чужая карточка №N не подставляется", async () => {
    // Кнопка WhatsApp на сайте (19.10.2026): число в тексте и в ссылке — одно и то же, id объявления сайта.
    expect(siteListingId).not.toBe(propertyShortId);
    const out = await sharedMediaHint({
      text: `Интересует объект №${propertyShortId} https://royalhome.tj/listing/${propertyShortId}`,
    });
    expect(out).not.toContain(`объект №${propertyShortId}`);
  });

  it("объект снят с продажи — бот обязан сказать честно", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { status: "SOLD" } });
    const out = await sharedMediaHint({
      text: "почём?",
      attachmentType: "ig_reel",
      attachmentUrl: `https://www.instagram.com/reel/${SHORTCODE}/`,
    });
    expect(out).toContain("УЖЕ НЕ В ПРОДАЖЕ");
    await prisma.property.update({ where: { id: propertyId }, data: { status: "AVAILABLE" } });
  });

  it("удалённый объект не подставляется", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { deletedAt: new Date() } });
    const out = await sharedMediaHint({
      text: "?",
      attachmentType: "ig_reel",
      attachmentUrl: `https://www.instagram.com/reel/${SHORTCODE}/`,
    });
    expect(out).not.toContain(`объект №${propertyShortId}`);
    // Переспросить бот всё равно обязан — но НЕ про содержимое видео, которого он
    // не видел (16.08.2026: на чужом ролике это дало «сколько комнат на этом видео»).
    expect(out).toContain("не молчи");
    expect(out).toContain("ЗАПРЕЩЕНО спрашивать о содержимом видео");
    await prisma.property.update({ where: { id: propertyId }, data: { deletedAt: null } });
  });
});

describe("sharedMediaHint — без ответа не остаётся никто", () => {
  it("чужая публикация: объект не найден, но бот переспрашивает", async () => {
    const out = await sharedMediaHint({
      text: "",
      attachmentType: "ig_reel",
      attachmentUrl: "https://www.instagram.com/reel/NeNashPost/",
    });
    expect(out).toContain("Ни в коем случае не молчи");
  });

  it("ответ на историю получает пояснение про тёплый интерес", async () => {
    const out = await sharedMediaHint({
      text: "🔥",
      replyToStoryUrl: "https://instagram.com/stories/royal.home.tj/1",
    });
    expect(out).toContain("ответил на НАШУ историю");
  });

  it("геометка и контакт получают свои подсказки", async () => {
    expect(await sharedMediaHint({ text: "", attachmentType: "location" })).toContain("геометку");
    expect(await sharedMediaHint({ text: "", attachmentType: "contact" })).toContain("контакт");
  });

  it("незнакомый тип вложения не оставляет бота без инструкции", async () => {
    const out = await sharedMediaHint({ text: "", attachmentType: "ar_effect" });
    expect(out).toContain("не умеем читать");
  });

  // Подсказка возвращается САМА ПО СЕБЕ, без текста клиента: приклеенная к реплике,
  // она оседала в истории диалога как слова человека и командовала моделью на всех
  // следующих ходах (см. turnHint в messengers/conversation.ts).
  it("фото и голосовое своей подсказки не получают — их пометку ставит вебхук", async () => {
    expect(await sharedMediaHint({ text: "[вложение: image]", attachmentType: "image" })).toBe("");
    expect(await sharedMediaHint({ text: "[вложение: audio]", attachmentType: "audio" })).toBe("");
  });

  it("ссылка на чужое объявление превращается в вопрос, а не в растерянность", async () => {
    const out = await sharedMediaHint({ text: "нашёл вот https://somsite.tj/kvartira/12" });
    expect(out).toContain("не на наш сайт");
  });

  it("обычное сообщение не обрастает подсказками", async () => {
    expect(await sharedMediaHint({ text: "здравствуйте, ищу двушку" })).toBe("");
  });

  /**
   * НАША ЖЕ КАРТОЧКА С КНОПКОЙ — НЕ ВЛОЖЕНИЕ ОТ КЛИЕНТА (20.09.2026).
   *
   * Шаблон с кнопкой умеет отправлять только CRM (см. routes/webhooks.ts,
   * 22.08.2026), поэтому «template» во входящем — наше же эхо. До этой правки тип
   * проваливался в ветку незнакомого вложения, и код САМ велел модели сказать, что
   * прочитать это он не умеет: 21 такой ответ в выгрузке живых переписок за
   * 21.08–20.09, человеку, который всего лишь нажал кнопку под нашим объявлением.
   */
  it("шаблонную карточку бот не принимает за вложение клиента", async () => {
    const out = await sharedMediaHint({ text: "[вложение: template]", attachmentType: "template" });
    expect(out).toContain("НАША ЖЕ карточка");
    expect(out).not.toContain("не умеем читать");
    // Главное — прямой запрет извиняться за то, чего клиент не присылал.
    expect(out).toMatch(/ЗАПРЕЩЕНО говорить, что вложение/);
  });

  /**
   * КАРТОЧКА С ТЕКСТОМ — КАРТОЧКА КЛИЕНТА (25.09.2026): клиент в Instagram прислал
   * свою карточку с номером, а подсказка уверяла модель, что он ничего не присылал.
   * Текст у карточки появляется только у чужой (templateAttachmentText, meta.ts).
   */
  it("карточка с текстом — клиентская: номер в ней читать, а не «наша карточка»", async () => {
    const out = await sharedMediaHint({ text: "📋 Фирӯз +992 93 555 44 33", attachmentType: "template" });
    expect(out).toContain("клиент прислал карточку");
    expect(out).toContain("номер клиента");
    expect(out).not.toContain("НАША ЖЕ карточка");
  });
});

/**
 * ТОЧНЫЙ ПРИЗНАК ДЛЯ СЧЁТЧИКА ПОВТОРА (messengers/conversation.ts,
 * MAX_UNRESOLVED_SHARE_REPLIES) — должен совпадать РОВНО с тем, когда buildNote
 * выше отвечает «видео не открылось», не больше и не меньше. Иначе счётчик
 * либо промолчит на настоящую накрутку, либо замолчит на живом лиде.
 */
describe("isUnresolvedSharedPost — точно тот же случай, что «видео не открылось»", () => {
  it("чужой ролик без опознания — да", async () => {
    expect(
      await isUnresolvedSharedPost({
        text: "",
        attachmentType: "ig_reel",
        attachmentUrl: "https://www.instagram.com/reel/NeNashPost2/",
      })
    ).toBe(true);
  });

  it("объект опознан по ссылке в тексте — нет, это не неопознанный случай", async () => {
    expect(
      await isUnresolvedSharedPost({
        text: `а вот эта https://www.instagram.com/reel/${SHORTCODE}/ ещё есть?`,
      })
    ).toBe(false);
  });

  it("объект опознан по вложению — нет", async () => {
    expect(
      await isUnresolvedSharedPost({
        text: "",
        attachmentType: "ig_reel",
        attachmentUrl: `https://www.instagram.com/reel/${SHORTCODE}/`,
      })
    ).toBe(false);
  });

  it("бот ВИДИТ присланное (mediaSeen) — нет, это другая ветка buildNote", async () => {
    expect(
      await isUnresolvedSharedPost({
        text: "",
        attachmentType: "ig_reel",
        attachmentUrl: "https://www.instagram.com/reel/NeNashPost3/",
        mediaSeen: true,
      })
    ).toBe(false);
  });

  it("не пересланная публикация вовсе — нет", async () => {
    expect(await isUnresolvedSharedPost({ text: "здравствуйте, ищу двушку" })).toBe(false);
    expect(await isUnresolvedSharedPost({ text: "", attachmentType: "location" })).toBe(false);
  });
});

/**
 * САМОИСЦЕЛЕНИЕ: карточка с испорченной ссылкой (t.me вместо адреса Instagram —
 * ровно та беда на проде у 17 объектов) находится по номеру в подписи, если
 * пост подтверждённо наш (permalink пришёл от Graph API нашей ленты, а не из
 * поля карточки). Найденную связь запоминаем — заявка владельца «можешь ли
 * всегда найти публикацию, как на сайте — мы через API брали».
 */
describe("sharedMediaHint — самоисцеление ссылки по номеру в подписи", () => {
  it("номер из своей чужой ссылки: `№(\\d+)`", () => {
    expect(captionShortId("2-комн, Сино, 62 м² — №1042")).toBe(1042);
    expect(captionShortId("№ 88 сдана")).toBe(88);
    expect(captionShortId("без номера")).toBeNull();
    expect(captionShortId(undefined)).toBeNull();
  });

  it("публикация наша (Graph API), карточка привязана t.me — узнаётся по подписи и чинится сама", async () => {
    const brokenShort = `HEAL${runId}`;
    const broken = await prisma.property.create({
      data: {
        title: `Тест-объект-битая-ссылка-${runId}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 55,
        price: 48000,
        currency: "USD",
        districtId,
        address: "Тестовая, 9",
        condition: "GOOD",
        // Ровно баг с прода: в поле лежит не адрес Instagram.
        instagramUrl: "https://t.me/royalhome_tj/999",
      },
    });
    try {
      const out = await sharedMediaHint({
        text: "",
        attachmentType: "ig_reel",
        attachmentUrl: `https://www.instagram.com/reel/${brokenShort}/`,
        ownPermalink: `https://www.instagram.com/reel/${brokenShort}/`,
        ownCaption: `2-комн, ${broken.title} — №${broken.shortId}`,
      });
      expect(out).toContain(`объект №${broken.shortId}`);

      // Самоисцеление — не только в ответе клиенту, но и в базе: следующий раз
      // объект должен находиться быстрым путём, без подписи вовсе.
      const refreshed = await prisma.property.findUniqueOrThrow({ where: { id: broken.id } });
      expect(refreshed.instagramUrl).toBe(`https://www.instagram.com/reel/${brokenShort}/`);
    } finally {
      await prisma.property.delete({ where: { id: broken.id } });
    }
  });

  it("подпись без номера — самоисцеление не гадает, объект остаётся неопознанным", async () => {
    const noNumberShort = `NONUM${runId}`;
    const out = await sharedMediaHint({
      text: "",
      attachmentType: "ig_reel",
      attachmentUrl: `https://www.instagram.com/reel/${noNumberShort}/`,
      ownPermalink: `https://www.instagram.com/reel/${noNumberShort}/`,
      ownCaption: "красивая квартира без номера в подписи",
      mediaSeen: true,
    });
    // Подписи мы держимся ровно потому, что она видна модели — но подставлять
    // ЧУЖУЮ карточку по домыслу нельзя.
    expect(out).not.toMatch(/объект №\d+/);
  });
});

/**
 * ССЫЛКА, ПРИСЛАННАЯ КНОПКОЙ «ПОДЕЛИТЬСЯ» (жалоба владельца 21.09.2026: «бот не
 * видит вообще ссылки, которые нам отправляют в Instagram, он слеп полностью»).
 *
 * Два разрыва, найденные разбором кода:
 *  1. ссылка на НАШ объект искалась только в тексте сообщения, а «поделиться»
 *     присылает адрес ВЛОЖЕНИЕМ, часто вообще без текста — свой же объект не
 *     находился, и человек слышал «видео у меня не открылось»;
 *  2. разбор вложений возвращал эту фразу РАНЬШЕ, чем выполнение доходило до
 *     чтения ссылок, поэтому присланная так ссылка не читалась никогда.
 */
describe("ссылка, присланная вложением", () => {
  it("наш объект узнаётся по ссылке во ВЛОЖЕНИИ, без текста", async () => {
    const note = await sharedMediaHint({
      text: "",
      attachmentType: "share",
      attachmentUrl: `https://royalhome.tj/listing/by-crm/${propertyId}`,
    });
    expect(note).toContain("наш объект");
    // И ни в коем случае не прежнее «видео не открылось».
    expect(note).not.toContain("не открылось");
  });

  it("наш объект узнаётся и по ссылке сайта во вложении (номер объявления)", async () => {
    const note = await sharedMediaHint({
      text: "",
      attachmentType: "share",
      attachmentUrl: `https://royalhome.tj/listing/${siteListingId}`,
    });
    expect(note).toContain("наш объект");
  });

  it("ссылка на нашу страницу без карточки больше не оставляет модель без подсказки", async () => {
    // Страница поиска на нашем сайте: карточки по ней нет, но подсказка обязана
    // быть — раньше её не было ВООБЩЕ, и бот отвечал, будто ничего не присылали.
    const note = await sharedMediaHint({
      text: "смотрите https://royalhome.tj/search?rooms=3",
    });
    expect(note).not.toBe("");
    expect(note).toContain("наш");
  });
});
