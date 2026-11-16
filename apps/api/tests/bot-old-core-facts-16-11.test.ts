import { describe, expect, it } from "vitest";

/**
 * СТАРОЕ ЯДРО КЛИЕНТСКОГО БОТА ВЫДУМЫВАЕТ ФАКТЫ — АУДИТ 16.11.2026 (facts.md, tone.md, comments.md).
 *
 * Каждый блок — класс, а не один случай; тексты — живые реплики из переписок 10–16.11
 * (Instagram Arvan Estate, Royal Home, Facebook, YouTube), без номеров телефонов.
 */

const { guardPrices } = await import("../src/ai/priceGuard.js");
const { guardCommentPrice } = await import("../src/messengers/commentPriceGuard.js");
const { findOffCatalogClaims, stripOffCatalogStreets, extractStreetMentions } = await import("../src/ai/catalogClaimsGuard.js");
const { guardRenovationClaims, catalogConditionNote } = await import("../src/ai/objectFactsGuard.js");
const { mergeDraft, normalizeReplyBubbles } = await import("../src/ai/leadQualifier.js");
const { cleanOutgoingReply, normalizeClientName, isAddresseeName } = await import("../src/ai/replyGuards.js");
const { guardCallbackPromises } = await import("../src/ai/callbackPromiseGuard.js");
const { filterBotReply } = await import("../src/messengers/replyChain.js");

const RATE = 9.224;

describe("валюта: пересчитанная сумма с валютой источника — выдумка (YouTube 15.11)", () => {
  const reply = "Ин хона 135 520 сомонӣ аст, дар ноҳияи Шохмансур (Ховарон) 📍 Агар дигар савол бошад, нависед";
  const card = "объект №172: 3-комн. квартира, Шохмансур, 112 м², 1 250 000 с.";

  it("долларовый эквивалент, названный сомони, вырезается", () => {
    const g = guardPrices({ bubbles: [reply], allowedText: card, usdToTjs: RATE });
    expect(g.invented).toContain(135520);
    // Фраза с ценой — весь ответ: щит отдаёт сигнал, вызывающий ставит заглушку (priceGuardFallbackReply).
    expect(g.keptDespiteViolation).toBe(true);
    const mixed = guardPrices({ bubbles: ["Ин хона 135 520 сомонӣ аст. Дар Шохмансур ҷойгир аст."], allowedText: card, usdToTjs: RATE });
    expect(mixed.bubbles.join(" ")).not.toContain("135 520");
  });

  it("тот же эквивалент в долларах — законный пересчёт", () => {
    const g = guardPrices({ bubbles: ["Нархаш 1 250 000 сомонӣ (тақрибан 135 520 $)."], allowedText: card, usdToTjs: RATE });
    expect(g.invented).toEqual([]);
  });

  it("долларовая карточка: сумма в сомони законна, та же сумма в долларах с умножением — нет", () => {
    const usdCard = "объект №5: 2-комн. квартира, Сино, 60 м², 80 000 $";
    expect(guardPrices({ bubbles: ["Нархаш 737 920 сомонӣ."], allowedText: usdCard, usdToTjs: RATE }).invented).toEqual([]);
    expect(guardPrices({ bubbles: ["Нархаш 737 920 $."], allowedText: usdCard, usdToTjs: RATE }).invented).toContain(737920);
  });

  it("под постом цену называет код из карточки, а не подпись публикации", () => {
    const out = guardCommentPrice({
      text: reply,
      card: { line: card, price: 1_250_000, currency: "TJS", available: true },
      commentText: "Инка.   Зебо.    Чан.   Самон",
      usdToTjs: RATE,
    });
    expect(out.invented).toContain(135520);
    expect(out.text).toMatch(/^Нархи ин хона 1 250 000 сомонӣ аст\./);
    expect(out.text).not.toContain("135 520");
  });

  it("проданный объект — цену не называем, коротко «продан, подберём похожий» (ревью С4)", () => {
    const out = guardCommentPrice({
      text: "Ин хона 135 520 сомонӣ аст.",
      card: { line: card, price: 1_250_000, currency: "TJS", available: false },
      commentText: "Нархаш чанд?",
      usdToTjs: RATE,
    });
    expect(out.text).not.toMatch(/\d{3} \d{3}/);
    expect(out.text).toMatch(/фурӯхта шуд/);
    expect(out.text).toMatch(/паёми шахсӣ/);
    const yt = guardCommentPrice({
      text: "Ин хона 135 520 сомонӣ аст.",
      card: { line: card, price: 1_250_000, currency: "TJS", available: false },
      commentText: "Нархаш чанд?",
      usdToTjs: RATE,
      channel: "YOUTUBE",
    });
    expect(yt.text).toMatch(/фурӯхта шуд/);
    expect(yt.text).not.toMatch(/паёми шахсӣ/);
  });

  it("ссылка карточки в источниках — цифры адреса не считаются ценой", () => {
    const out = guardCommentPrice({
      text: "Нархаш 1 250 000 сомонӣ. https://royalhome.tj/listing/by-crm/9149ac8d-649c-4190-b8a9-0f5cb8be838c",
      card: { line: `${card} https://royalhome.tj/listing/by-crm/9149ac8d-649c-4190-b8a9-0f5cb8be838c`, price: 1_250_000, currency: "TJS", available: true },
      commentText: "Нарх?",
      usdToTjs: RATE,
    });
    expect(out.invented).toEqual([]);
  });
});

describe("адрес: место объекта только из карточки, таджикские формы (Facebook 11.11, 13.11)", () => {
  const props =
    "\n\nЧТО У НАС СЕЙЧАС ЕСТЬ ПОДХОДЯЩЕГО:\n- №192 Дом 5-комн., Сино, Навбахор 2, ориентир: Кольцевая, Военный городок, 1 380 000 с., 183 м²";
  const check = (text: string, client = "Адрес кучодай") =>
    findOffCatalogClaims({ text, allowedText: props, catalogText: props, clientText: client, tajikPlaces: true, placeSources: props });

  it("«дар Зарафшон, наздики бозорча» — выдумка, фраза уходит целиком", () => {
    const text = "Ин ҳавлӣ дар Зарафшон, наздики бозорча ҷойгир аст";
    const claims = check(text);
    expect(claims.streets).toEqual(["Зарафшон"]);
    expect(stripOffCatalogStreets([text], claims.streets)).toEqual([]);
  });

  it("«маҳаллаи Лучоби поён» — выдумка; верная часть ответа остаётся", () => {
    const text = "Ин хона дар ноҳияи Сино, маҳаллаи Лучоби поён ҷойгир аст. Нархаш 1 380 000 сомонӣ.";
    const claims = check(text, "Ассаламу алейкум адрес кучоба");
    expect(claims.streets).toEqual(["Лучоби"]);
    expect(stripOffCatalogStreets([text], claims.streets)).toEqual(["Нархаш 1 380 000 сомонӣ."]);
  });

  it("верный ориентир из карточки проходит («Навбаҳор-2, гардиши Военный городок»)", () => {
    expect(check("Аниқтараш: ин хона дар маҳаллаи Навбаҳор-2, тарафи гардиши Военный городок").streets).toEqual([]);
  });

  it("город и районы зоны не выдумка («дар Душанбе ҷойгир», «ноҳияи Рӯдакӣ»)", () => {
    expect(check("Ин хона дар Душанбе ҷойгир аст, ноҳияи Сино").streets).toEqual([]);
    expect(check("Ин ҳавлӣ дар ноҳияи Рӯдакӣ ҷойгир аст").streets).toEqual([]);
  });

  it("место, названное клиентом, — не выдумка (ҳ/х, ӯ/у одно и то же)", () => {
    expect(check("Дар кӯчаи Ҳисор хона ҳаст", "Хисор").streets).toEqual([]);
  });

  it("голос без флага — прежний шаблон, таджикские слова не берутся", () => {
    expect(extractStreetMentions("маҳаллаи Лучоби поён")).toEqual([]);
    expect(extractStreetMentions("маҳаллаи Лучоби поён", { tajikPlaces: true })).toEqual(["Лучоби"]);
  });
});

describe("состояние объекта: «с ремонтом» только если так в карточке (Instagram Arvan 15.11)", () => {
  const shell = `- №187 2-комн. квартира, Сино, 82 мкр, 870 000 с., 91 м², 5/9 этаж${catalogConditionNote({ type: "APARTMENT", marketType: "NEW_BUILD", stage: "SHELL", condition: "NEW_BUILDING" })}`;
  const renovated = `- №87 2-комн. квартира, Сино, Alfemo, 1 100 000 с., 60 м², 9/18 этаж${catalogConditionNote({ type: "APARTMENT", marketType: "NEW_BUILD", stage: "BUILT", condition: "EXCELLENT" })}`;

  it("строка подборки несёт состояние карточки", () => {
    expect(shell).toContain("состояние: новостройка, коробка");
    expect(renovated).toContain("с ремонтом");
  });

  it("«91 квадрат бо ремонти нав ҳаст» про коробку — вырезано", () => {
    const out = guardRenovationClaims(["Ҳа, 2-хонагаҳо дорем. Масалан, дар 82 мкр 91 квадрат бо ремонти нав ҳаст"], shell);
    expect(out.removed).toBe(1);
    expect(out.bubbles.join(" ")).not.toMatch(/ремонт/);
  });

  it("правда остаётся; вопрос «бо ремонт ё каробка?» и желание клиента не трогаются", () => {
    expect(guardRenovationClaims(["Дар Alfemo 60 квадрат бо ремонти нав ҳаст."], `${shell}\n${renovated}`).removed).toBe(0);
    expect(guardRenovationClaims(["Хона бо ремонти нав бошад ё каробка?"], shell).removed).toBe(0);
    expect(guardRenovationClaims(["Ба Шумо хона бо ремонт лозим аст."], shell).removed).toBe(0);
  });
});

describe("бюджет «то 900–950»: не отказ «аренды нет», а вопрос; «сомони» — тысячи (Instagram Arvan 14.11, ревью В1)", () => {
  const turn = (lead: Record<string, unknown>) => ({ reply: [], ready: false, intent: "buy" as const, lead });

  it("«То 900и 950» без валюты и без «в месяц» — не аренда, сумма ждёт уточнения", () => {
    const d = mergeDraft({ intent: "buy" } as never, turn({ budgetMin: 900, budgetMax: 950 }) as never, "То 900и 950");
    expect(d.intent).not.toBe("rent");
    expect(d.budgetMax).toBeUndefined();
    expect(d.budgetUnrealistic).toBe(950);
  });

  it("следующим ходом «Сомони» (ответ на «доллар ё ҳазор сомонӣ?») → до 950 000, покупка", () => {
    const first = mergeDraft({ intent: "buy" } as never, turn({ budgetMin: 900, budgetMax: 950 }) as never, "То 900и 950");
    const d = mergeDraft(first, { reply: [], ready: false, intent: "buy" } as never, "Сомони");
    expect(d.intent).toBe("buy");
    expect(d.budgetMax).toBe(950_000);
    expect(d.budgetUnrealistic).toBeUndefined();
  });

  it("«то 150» без валюты молча в 150 000 сомони НЕ превращается (это часто 150 тыс. $)", () => {
    const d = mergeDraft({ intent: "buy" } as never, turn({ budgetMax: 150 }) as never, "то 150");
    expect(d.budgetMax).toBeUndefined();
    expect(d.budgetUnrealistic).toBe(150);
  });

  it("«в месяц» / «моҳона» рядом — по-прежнему аренда", () => {
    expect(mergeDraft({} as never, turn({ budgetMax: 950 }) as never, "950 сомони в месяц").intent).toBe("rent");
    expect(mergeDraft({} as never, turn({ budgetMax: 900 }) as never, "моҳона 900").intent).toBe("rent");
  });

  it("решение владельца 03.09 цело: «аз 3000 то 4500» — месячная плата", () => {
    expect(mergeDraft({} as never, turn({ budgetMin: 3000, budgetMax: 4500 }) as never, "2 хуҷрага бо нархи аз 3000 то 4500").intent).toBe("rent");
  });
});

describe("приветствие посреди разговора и чужое имя (tone.md п.15)", () => {
  it("«Бубахшед, нафаҳмидам. Ассалому алейкум! …» — приветствие вырезано", () => {
    const [b] = normalizeReplyBubbles(["Бубахшед, нафаҳмидам. Ассалому алейкум! Ин кадом хона аст ё кадом вариант ба Шумо лозим аст?"], true);
    expect(b).toBe("Бубахшед, нафаҳмидам. Ин кадом хона аст ё кадом вариант ба Шумо лозим аст?");
    const [c] = normalizeReplyBubbles(["Бемалол, пурсед. Ассалому алейкум! Чӣ хизмат карда метавонем?"], true);
    expect(c).not.toMatch(/Ассалому/);
  });

  it("первое приветствие разговора не трогается", () => {
    expect(normalizeReplyBubbles(["Ассалому алейкум! Чӣ хизмат карда метавонем?"], false)[0]).toMatch(/^Ассалому алейкум/);
  });

  it("«… акаи тохир» — имя сотрудника, а не клиентки: в карточку не идёт, обращения нет", () => {
    const client = "Унас ест квартира апачон\nрақамам акаи тохир\nМехоҳам хонаамро фурӯшам";
    expect(normalizeClientName("рақамам акаи тохир")).toBeNull();
    expect(isAddresseeName("Тоҳир", client)).toBe(true);
    expect(cleanOutgoingReply("Тоҳир! Дархости шуморо ба агент додам.", client)).toMatch(/^Дархости шуморо ба агент додам/);
    expect(cleanOutgoingReply("Раҳмат, Тоҳирҷон!", client)).toMatch(/^Раҳмат!?$/);
  });

  it("имя, которым клиент назвался сам, не трогается", () => {
    expect(cleanOutgoingReply("Ташаккур, Хадича!", "Акбарова хадича")).toBe("Ташаккур, Хадича!");
  });
});

describe("«агент позвонит» — только с номером, без «ҳозир» (facts.md Ф4)", () => {
  it("номера нет: «Мунтазири занг бошед» → одна просьба номера", () => {
    const out = guardCallbackPromises({ bubbles: ["Дархост қабул шуд.", "Мунтазири занг бошед"], phoneKnown: false, mayAskPhone: true, language: "tg" });
    expect(out.bubbles.join(" ")).not.toMatch(/Мунтазири занг/);
    expect(out.bubbles.join(" ")).toMatch(/рақам/i);
    expect(out.promised).toBe(false);
  });

  it("номера нет и номер только что просили — обещание просто уходит", () => {
    const out = guardCallbackPromises({ bubbles: ["Ба зудӣ занг мезанад"], phoneKnown: false, mayAskPhone: false, language: "tg" });
    expect(out.bubbles).toEqual([]);
  });

  it("номер есть: обещание остаётся без «ҳозир» и требует сигнала агенту", () => {
    const out = guardCallbackPromises({
      bubbles: ["Дархости шуморо ба агенти мо додам. Вай ҳозир ба шумо занг зада, вақти омаданро аниқ мекунад"],
      phoneKnown: true,
      mayAskPhone: false,
      language: "tg",
    });
    expect(out.bubbles[0]).not.toMatch(/ҳозир/);
    expect(out.bubbles[0]).toMatch(/Вай ба шумо занг зада/);
    expect(out.promised).toBe(true);
  });

  it("просьба номера сразу после такой же просьбы не уходит (Instagram Arvan 13.11, трижды подряд)", () => {
    const ask = "Сабт кардам. Рақами телефонатон ва номатонро нависед, то агенти мо занг занад";
    const result = filterBotReply({
      reply: ["Муайян шуд. Рақами телефонатон ва номатонро нависед, то агенти мо занг занад"],
      conversationId: "test",
      channelLabel: "INSTAGRAM",
      openUrl: "/messages",
      botSpokeBefore: true,
      botSaidBefore: [ask],
      clientSaidTrusted: "Хона. 105. К 1400 с\nПеши. Ватан",
      clientTurnText: "Пеши. Ватан",
      previousBotText: ask,
      language: "tg",
      draft: { intent: "sell", stage: "awaiting_phone" },
      jobConversation: false,
      phoneAsksSent: 1,
      phoneKnown: false,
      fallbackLanguageWords: ["Пеши. Ватан"],
    });
    expect(result.bubbles.join(" ")).not.toMatch(/рақам/i);
  });
});

describe("ревью #207: обещание звонка — кому можно просить номер (В2)", () => {
  const base = {
    conversationId: "test",
    channelLabel: "INSTAGRAM",
    openUrl: "/messages",
    botSpokeBefore: true,
    botSaidBefore: ["Ассалому алейкум! Чӣ хизмат карда метавонем?"],
    clientSaidTrusted: "Салом",
    clientTurnText: "Хона иҷора даркор",
    previousBotText: "Ассалому алейкум! Чӣ хизмат карда метавонем?",
    language: "tg" as const,
    jobConversation: false,
    phoneAsksSent: 0,
    phoneKnown: false,
    fallbackLanguageWords: ["Хона иҷора даркор"],
  };

  it("арендатору — обещание вырезано, номер НЕ просим", () => {
    const r = filterBotReply({
      ...base,
      reply: ["Мутаассифона, мо иҷора надорем. Агар хариду фурӯш лозим шавад, агенти мо тамос мегирад."],
      draft: { intent: "rent", stage: "chatting" },
    });
    const text = r.bubbles.join(" ");
    expect(text).toMatch(/иҷора надорем/);
    expect(text).not.toMatch(/тамос мегирад|рақам/i);
  });

  it("продавцу вне зоны — номер не просим", () => {
    const r = filterBotReply({
      ...base,
      clientTurnText: "Хонаам дар Бохтар",
      reply: ["Ҳоло танҳо дар Душанбе ва ноҳияи Рӯдакӣ кор мекунем. Агент занг мезанад."],
      draft: { intent: "sell", stage: "chatting", locationOutsideDushanbe: true },
    });
    expect(r.bubbles.join(" ")).not.toMatch(/рақам|занг мезанад/i);
  });

  it("телефон и адрес офиса для клиента — не обещание, не вырезаются", () => {
    const office = guardCallbackPromises({
      bubbles: ["Позвоните нам: 900 00 00 00, офис на Бухоро 2.", "Шумо метавонед ба офис занг задан, суроға: Бухоро 2."],
      phoneKnown: false,
      mayAskPhone: true,
      language: "tg",
    });
    expect(office.changed).toBe(0);
    expect(office.bubbles).toHaveLength(2);
  });
});

describe("ревью #207: место и ремонт без ложных срабатываний (С2, С3)", () => {
  const props = "\n- №50 2-комн. квартира, Шохмансур, ориентир: Цирк, 900 000 с., 60 м², состояние: вторичка, требует ремонта";
  const check = (text: string) =>
    findOffCatalogClaims({ text, allowedText: props, catalogText: props, clientText: "Адрес?", tajikPlaces: true, placeSources: props });

  it("«наздики Сирк» при «Цирк» в карточке — перевод, не выдумка", () => {
    expect(check("Ин хона наздики Сирк ҷойгир аст").streets).toEqual([]);
  });

  it("вежливое «Шумо» с заглавной — не место", () => {
    expect(check("Агенти мо наздики Шумо хонаро нишон медиҳад").streets).toEqual([]);
  });

  it("частые формы ремонта ловятся: «бо ремонти нав аст», «с ремонтом, 870 000», «бо таъмири нав ҳаст»", () => {
    for (const text of ["Ин хона бо ремонти нав аст.", "Квартира с ремонтом, 870 000 сомони.", "Бо таъмири нав ҳаст."]) {
      expect(guardRenovationClaims([text], props).removed, text).toBe(1);
    }
  });

  it("подборки нет (разговор про присланный пост) — ремонт не вырезаем: сверять не с чем", () => {
    expect(guardRenovationClaims(["Ин хона бо ремонт ҳаст."], "").removed).toBe(0);
  });

  it("«Салом ба оилаатон» после точки — не приветствие разговора", () => {
    expect(normalizeReplyBubbles(["Раҳмат! Салом ба оилаатон."], true)[0]).toMatch(/Салом ба оилаатон/);
  });
});
