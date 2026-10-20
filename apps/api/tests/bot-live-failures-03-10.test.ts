import { describe, expect, it } from "vitest";

/**
 * ЖИВЫЕ СБОИ БОТА 03.10.2026 (Dan, скриншоты из Instagram и CRM).
 *
 *  1. «Салом можно окончательную цену и когда можно посмотреть?» — бот ответил
 *     по-таджикски (см. client-language.test.ts).
 *  2. Номер дан («910001021 ватсап»), заявка принята, а бот ещё тремя пузырями
 *     пересказал то же «агент позвонит».
 *  3. Повтор прошлой реплики, отличающийся только приветствием.
 *  4. Два почти одинаковых вопроса в одном ответе.
 *  5. Заявка принята с номером «92-000-10-24», а следующий ход дописал
 *     «Рақами телефонатон ва номатонро нависед».
 *  6. «3 мик, 5 этаж» — это Худжанд, бот записал Сино. Номер микрорайона, которого
 *     в Душанбе нет, — бот спрашивает город.
 *  7. Чужой ролик без слов с рекламы и продавец игровых аккаунтов — молчим
 *     (см. instagram-spam-qa-02-10.test.ts).
 */

const { dropNearRepeats, dropKnownPhoneAsks } = await import("../src/ai/replyRepeatGuard.js");
const { filterBotReply, phoneSaidInDialog } = await import("../src/messengers/replyChain.js");
const { microdistrictNumbers, unknownMicrodistrictRule } = await import("../src/ai/geoMentions.js");
const { clientTalksBusiness } = await import("../src/messengers/sharedMedia.js");
const { templateAttachmentText } = await import("../src/messengers/meta.js");

describe("повтор смыслом не уходит", () => {
  const ACCEPTED = "Рахмат! Маълумотро ба агент додам, ба зудӣ занг зада, фурӯхта шудани хонаро аниқ мегӯяд";

  it("после принятой заявки второе «агент позвонит» не уходит, полезная часть остаётся", () => {
    const out = dropNearRepeats(
      [
        "Бале, Муҳаммадсолеҳ, маҳз ҳамин хона дар назар аст. Рақаматон ҳаст, агенти мо ба зудӣ занг зада, фурӯхта шудан ё нашуданашро аниқ мегӯяд",
        "Маълумотро ба агент додам, тавассути WhatsApp ба Шумо хабар медиҳад",
        "Бале, фаҳмидам. Агенти мо ба зудӣ тавассути WhatsApp ё телефон ба Шумо занг мезанад",
      ],
      [ACCEPTED],
      { clientTurnText: "910 00 1021" }
    );
    expect(out).toEqual(["Бале, Муҳаммадсолеҳ, маҳз ҳамин хона дар назар аст."]);
  });

  it("в одном ответе обещание звонка звучит один раз", () => {
    const out = dropNearRepeats(
      ["Ташаккур! Маълумотро ба агент додам.", "Агенти мо имрӯз ба Шумо занг мезанад."],
      []
    );
    expect(out).toEqual(["Ташаккур! Маълумотро ба агент додам."]);
  });

  it("клиент сам спросил, когда позвонят, — ответить про звонок можно", () => {
    const out = dropNearRepeats(["Агент Маъруф позвонит вам сегодня в течение часа."], [ACCEPTED], {
      clientTurnText: "Когда агент позвонит?",
    });
    expect(out).toEqual(["Агент Маъруф позвонит вам сегодня в течение часа."]);
  });

  it("та же реплика с другим приветствием — повтор", () => {
    const before = "Ваалейкум ассалом! Квартира трёхкомнатная, площадь 75 метров, цена 920 000 сомони.";
    expect(dropNearRepeats(["Квартира трёхкомнатная, площадь 75 метров, цена 920 000 сомони."], [before])).toEqual([]);
  });

  it("два почти одинаковых вопроса в одном ответе — остаётся первый", () => {
    const out = dropNearRepeats(["Хона дар кадом ноҳия ҷойгир аст?", "Дар кадом ноҳия хона аст?"], []);
    expect(out).toEqual(["Хона дар кадом ноҳия ҷойгир аст?"]);
  });

  it("новый смысл не трогаем", () => {
    const bubbles = ["Хона чанд ҳуҷра дорад?"];
    expect(dropNearRepeats(bubbles, [ACCEPTED])).toEqual(bubbles);
  });
});

describe("номер, который клиент уже дал, снова не просим", () => {
  it("из пузыря уходит только фраза с просьбой", () => {
    expect(
      dropKnownPhoneAsks([
        "Раҳмат! Шартҳои бартерро низ дар қайд гирифтам. Рақами телефонатон ва номатонро нависед, то агенти мо занг занад.",
      ])
    ).toEqual(["Раҳмат! Шартҳои бартерро низ дар қайд гирифтам."]);
  });

  it("номер в переписке узнаётся", () => {
    expect(phoneSaidInDialog(["Тил 92-000-10-24. Шарифчон."])).toBe(true);
    expect(phoneSaidInDialog(["910001021 ватсап"])).toBe(true);
    expect(phoneSaidInDialog(["600 000 сом. бо арзон мешад"])).toBe(false);
  });

  it("цепочка ответа: номер есть в словах клиента — напоминание о номере не дописывается", () => {
    const result = filterBotReply({
      reply: ["Раҳмат! Шартҳои бартерро низ дар қайд гирифтам."],
      conversationId: "test",
      channelLabel: "WHATSAPP",
      openUrl: "/messages",
      botSpokeBefore: true,
      botSaidBefore: ["Ташаккур, Шарифҷон! Агенти мо Маъруф имрӯз дар давоми як соат ба шумо занг мезанад"],
      clientSaidTrusted: "Салом уминя есть квартира 3 ком хачу прадат. Тил 92-000-10-24. Шарифчон. Хуб. Рахмат.",
      clientTurnText: "Хонаи заминоки бошадам бартер мешад.",
      previousBotText: "Ташаккур, Шарифҷон! Агенти мо Маъруф имрӯз дар давоми як соат ба шумо занг мезанад",
      language: "tg",
      draft: { intent: "sell", stage: "awaiting_phone" },
      jobConversation: false,
      phoneAsksSent: 1,
      phoneKnown: false,
      fallbackLanguageWords: ["Хонаи заминоки бошадам бартер мешад."],
    });
    expect(result.bubbles).toHaveLength(1);
    expect(result.bubbles[0]).toMatch(/^Раҳмат! Шартҳои бартерро низ дар қайд гирифтам/);
    expect(result.bubbles[0]).not.toMatch(/рақам/i);
  });
});

describe("микрорайон, которого нет в Душанбе, — спросить город", () => {
  it("номера микрорайонов читаются в живом написании", () => {
    expect(microdistrictNumbers("3 мик .5 этаж.чан квад метр намедонам.")).toEqual([3]);
    expect(microdistrictNumbers("дар 82 мкр")).toEqual([82]);
    expect(microdistrictNumbers("мкр 18, 4 этаж")).toEqual([18]);
    expect(microdistrictNumbers("3-й микрорайон")).toEqual([3]);
    expect(microdistrictNumbers("5 этаж, 3 комнаты")).toEqual([]);
  });

  it("«3 мик» — бот получает указание спросить город", async () => {
    const rule = await unknownMicrodistrictRule("3 мик .5 этаж.");
    expect(rule).toContain("ГОРОД НЕ ЯСЕН");
    expect(rule).toContain("3 мкр");
  });

  it("известный микрорайон Душанбе или названный город — не спрашиваем", async () => {
    expect(await unknownMicrodistrictRule("дар 82 мкр")).toBe("");
    expect(await unknownMicrodistrictRule("3 мкр, Душанбе")).toBe("");
  });
});

describe("слова клиента по делу к чужому ролику", () => {
  it("дело", () => {
    for (const t of ["сколько стоит?", "Нархаш чанд?", "эта квартира свободна?", "910001021", "можно подробнее"]) {
      expect(clientTalksBusiness(t), t).toBe(true);
    }
  });
  it("не дело", () => {
    for (const t of ["", "Ассалом", "Ишам капен ку ❤️‍🔥👌", "Успеть к ‼️", "😂"]) {
      expect(clientTalksBusiness(t), t).toBe(false);
    }
  });
});

describe("карточка «Номер телефона» — номер из любого поля", () => {
  it("номер под незнакомым ключом попадает в текст", () => {
    const text = templateAttachmentText({
      template_type: "generic",
      elements: [{ title: "Номер телефона", value: "+992 980 00 10 32" }],
    });
    expect(text).toContain("Номер телефона");
    expect(text).toContain("+992 980 00 10 32");
    expect(phoneSaidInDialog([text])).toBe(true);
  });
  it("номер-не-номер под незнакомым ключом не берём", () => {
    expect(templateAttachmentText({ elements: [{ title: "Карточка", id: "12345" }] })).toBe("Карточка");
  });
});
